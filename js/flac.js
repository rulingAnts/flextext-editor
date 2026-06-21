/* flac.js — lazy FLAC encoder (mmig/libflac.js, WebAssembly) for archival
 * recordings. Lazy-loaded only when the researcher picks the FLAC format, the
 * same way convert.js loads the MP3 encoder. Works offline once cached.
 *
 * The .wasm is pinned via FLAC_SCRIPT_LOCATION, and both the glue and the .wasm
 * are resolved against THIS module's URL (the engine path) so they are correct
 * in the cross-path recorder app and served by the service worker.
 *
 * FLAC is an integer codec, so we encode 24-bit — the right target for phone-mic
 * audio (the ADC is 16/24-bit; 32-bit-float headroom is empty), bit-faithful at
 * roughly half the size of WAV. Output decodes bit-identical (verified).
 */

let flacPromise = null;

function loadFlac() {
  if (flacPromise) return flacPromise;
  flacPromise = new Promise((resolve, reject) => {
    const whenReady = () => {
      const Flac = window.Flac;
      if (!Flac) { reject(new Error('FLAC encoder did not initialize')); return; }
      if (Flac.isReady()) { resolve(Flac); return; }
      // `on('ready')` replays a persisted event, so it fires even if readiness
      // landed between the isReady() check and here.
      if (typeof Flac.on === 'function') Flac.on('ready', () => resolve(Flac));
      else Flac.onready = () => resolve(Flac);
    };
    if (window.Flac) { whenReady(); return; }
    // Tell the Emscripten glue where the .wasm lives (module-relative URL).
    const wasmUrl = new URL('vendor/libflac.min.wasm.wasm', import.meta.url).href;
    window.FLAC_SCRIPT_LOCATION = Object.assign(window.FLAC_SCRIPT_LOCATION || {},
      { 'libflac.min.wasm.wasm': wasmUrl });
    const s = document.createElement('script');
    s.src = new URL('vendor/libflac.min.wasm.js', import.meta.url).href;
    s.onload = whenReady;
    s.onerror = () => reject(new Error('Could not load the FLAC encoder'));
    document.head.appendChild(s);
  });
  return flacPromise;
}

// Float32 [-1,1] mono → Int32 samples scaled to `bps` (libFLAC takes Int32).
// Interleave mono/stereo Float32 channels into one Int32Array at `bps` (what
// libFLAC's process_interleaved expects).
function interleaveToInt32(chans, bps) {
  const nch = chans.length;
  const n = chans[0].length;
  const out = new Int32Array(n * nch);
  const peak = (1 << (bps - 1)) - 1; // 0x7FFFFF for 24-bit
  const min = -(1 << (bps - 1));
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const s = chans[c][i];
      let v = Math.round(s < 0 ? s * (peak + 1) : s * peak);
      if (v > peak) v = peak; else if (v < min) v = min;
      out[i * nch + c] = v;
    }
  }
  return out;
}

/**
 * Encode mono OR stereo Float32 PCM to a FLAC blob.
 * @param {Float32Array|Float32Array[]} channels  one array (mono) or per-channel arrays
 * @param {number} sampleRate
 * @param {number} [bps=24] bits per sample (FLAC is integer)
 * @param {(fraction:number)=>void} [onProgress]
 * @returns {Promise<Blob>}
 */
export async function encodeFlac(channels, sampleRate, bps = 24, onProgress) {
  const chans = (channels instanceof Float32Array) ? [channels] : channels;
  const nch = chans.length;
  const n = chans[0].length;
  const Flac = await loadFlac();
  const compression = 5;
  const enc = Flac.create_libflac_encoder(sampleRate, nch, bps, compression, n, false);
  if (!enc) throw new Error('FLAC encoder could not be created');

  const parts = [];
  let length = 0;
  const writeCb = (chunk /*Uint8Array*/) => { parts.push(chunk.slice()); length += chunk.length; };
  // NOTE: pass ONLY 3 args. A numeric 4th arg (ogg_serial_number) flips libflac
  // to Ogg-FLAC; omitting it keeps the native .flac container (what Praat/ELAN/
  // Audacity/ffmpeg expect for archives).
  const initRes = Flac.init_encoder_stream(enc, writeCb, () => {});
  if (initRes !== 0) { Flac.FLAC__stream_encoder_delete(enc); throw new Error('FLAC init failed (' + initRes + ')'); }

  // Encode in blocks (samples-per-channel) so a long take reports progress and
  // never blocks the UI. libFLAC takes interleaved Int32 samples.
  const i32 = interleaveToInt32(chans, bps);
  const BLOCK = 1 << 16; // samples per channel per block
  for (let off = 0; off < n; off += BLOCK) {
    const cnt = Math.min(BLOCK, n - off);
    const slice = i32.subarray(off * nch, (off + cnt) * nch);
    const ok = Flac.FLAC__stream_encoder_process_interleaved(enc, slice, cnt);
    if (!ok) { Flac.FLAC__stream_encoder_delete(enc); throw new Error('FLAC encoding failed mid-stream'); }
    if (onProgress) onProgress(Math.min(0.99, off / n));
    await new Promise((r) => setTimeout(r, 0));
  }
  Flac.FLAC__stream_encoder_finish(enc);
  Flac.FLAC__stream_encoder_delete(enc);
  if (onProgress) onProgress(1);

  const out = new Uint8Array(length);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return new Blob([out], { type: 'audio/flac' });
}
