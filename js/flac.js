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
function floatToInt(pcm, bps) {
  const out = new Int32Array(pcm.length);
  const peak = (1 << (bps - 1)) - 1; // 0x7FFFFF for 24-bit
  const min = -(1 << (bps - 1));
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i];
    let v = Math.round(s < 0 ? s * (peak + 1) : s * peak);
    if (v > peak) v = peak; else if (v < min) v = min;
    out[i] = v;
  }
  return out;
}

/**
 * Encode mono Float32 PCM to a FLAC blob.
 * @param {Float32Array} pcm
 * @param {number} sampleRate
 * @param {number} [bps=24] bits per sample (FLAC is integer)
 * @param {(fraction:number)=>void} [onProgress]
 * @returns {Promise<Blob>}
 */
export async function encodeFlac(pcm, sampleRate, bps = 24, onProgress) {
  const Flac = await loadFlac();
  const channels = 1;
  const compression = 5;
  const enc = Flac.create_libflac_encoder(sampleRate, channels, bps, compression, pcm.length, false);
  if (!enc) throw new Error('FLAC encoder could not be created');

  const parts = [];
  let length = 0;
  const writeCb = (chunk /*Uint8Array*/) => { parts.push(chunk.slice()); length += chunk.length; };
  // NOTE: pass ONLY 3 args. A numeric 4th arg (ogg_serial_number) flips libflac
  // to Ogg-FLAC; omitting it keeps the native .flac container (what Praat/ELAN/
  // Audacity/ffmpeg expect for archives).
  const initRes = Flac.init_encoder_stream(enc, writeCb, () => {});
  if (initRes !== 0) { Flac.FLAC__stream_encoder_delete(enc); throw new Error('FLAC init failed (' + initRes + ')'); }

  // Encode in blocks so a long take reports progress and never blocks the UI.
  const i32 = floatToInt(pcm, bps);
  const BLOCK = 1 << 16; // ~1.3s @ 48kHz
  for (let off = 0; off < i32.length; off += BLOCK) {
    const slice = i32.subarray(off, Math.min(off + BLOCK, i32.length));
    const ok = Flac.FLAC__stream_encoder_process_interleaved(enc, slice, slice.length / channels);
    if (!ok) { Flac.FLAC__stream_encoder_delete(enc); throw new Error('FLAC encoding failed mid-stream'); }
    if (onProgress) onProgress(Math.min(0.99, off / i32.length));
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
