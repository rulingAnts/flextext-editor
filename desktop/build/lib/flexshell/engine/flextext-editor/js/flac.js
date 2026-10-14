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

/* Write the finished MD5 and frame-size bounds into the STREAMINFO already in the buffer.
 *
 * Layout is fixed by the FLAC spec and never varies: "fLaC" (4 bytes) + a 4-byte metadata block
 * header + the 34-byte STREAMINFO body, so the body starts at offset 8. Within it:
 *   +4..6   min frame size (24-bit)      +7..9   max frame size (24-bit)
 *   +18..33 MD5 of the unencoded audio
 * Everything else (block sizes, rate, channels, depth, total samples) libFLAC already knew when it
 * wrote the placeholder, because we pass the sample count at encoder creation.
 *
 * ⚠ EVERY PRECONDITION IS CHECKED BEFORE A SINGLE BYTE IS WRITTEN. Splicing at the wrong offset
 * would corrupt the header of an archival master — far worse than the missing MD5 this fixes. If
 * anything looks unfamiliar the buffer is left exactly as libFLAC produced it. */
function patchStreamInfo(out, info) {
  if (!info || typeof info.md5sum !== 'string' || !/^[0-9a-f]{32}$/i.test(info.md5sum)) return false;
  if (out.length < 42) return false;
  if (out[0] !== 0x66 || out[1] !== 0x4c || out[2] !== 0x61 || out[3] !== 0x43) return false;  // "fLaC"
  if ((out[4] & 0x7f) !== 0) return false;                                                     // type 0
  if (((out[5] << 16) | (out[6] << 8) | out[7]) !== 34) return false;                          // length 34
  const w24 = (at, v) => { out[at] = (v >>> 16) & 0xff; out[at + 1] = (v >>> 8) & 0xff; out[at + 2] = v & 0xff; };
  if (info.min_framesize > 0) w24(8 + 4, info.min_framesize);
  if (info.max_framesize > 0) w24(8 + 7, info.max_framesize);
  for (let i = 0; i < 16; i++) out[8 + 18 + i] = parseInt(info.md5sum.substr(i * 2, 2), 16);
  return true;
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

  /* ⚠ THE THIRD ARGUMENT IS THE METADATA CALLBACK, AND DISCARDING IT COST US THE MD5.
   *
   * A FLAC file's STREAMINFO carries an MD5 of the UNENCODED audio. It is the format's own
   * tamper-evidence: `flac -t` and ffmpeg decode the file and check the samples against it, so a
   * FLAC that has been altered — or has decayed on disk — is DETECTABLE years later. For an
   * archival deposit that is most of the point of choosing FLAC at all.
   *
   * libFLAC cannot write it during a streaming encode: the STREAMINFO block goes out FIRST, before
   * any audio has been seen, so what lands in the stream is a placeholder with a zeroed MD5 and
   * zeroed sample/frame counts. Normally the encoder SEEKS BACK and patches it — but there is no
   * seek callback here (we are assembling a Blob, not writing a file), so it never could. Every
   * FLAC this app produced carried an all-zero MD5 and could not be verified by anything. Nothing
   * errored; the files simply had no integrity information, which is invisible until the day
   * somebody tries to check one.
   *
   * The fix is libFLAC's own documented route for exactly this case: it hands the FINAL STREAMINFO
   * to the metadata callback on finish(), MD5 and counts filled in, and we splice that over the
   * placeholder. ⚠ Deliberately NOT a hand-rolled MD5 — these are libFLAC's own bytes over
   * libFLAC's own view of the samples, so the value cannot disagree with the encoder that made it.
   */
  let finalInfo = null;
  const metaCb = (info, block) => {
    // ⚠ Read the PARSED object, not block.data: the raw block is an opaque wasm-side object here,
    // with no readable bytes. libFLAC hands the finished values on `info` — md5sum as a hex string.
    if (block && block.type !== 0) return;                      // 0 = STREAMINFO
    if (info && typeof info.md5sum === 'string') finalInfo = info;
  };
  // NOTE: pass ONLY 3 args. A numeric 4th arg (ogg_serial_number) flips libflac
  // to Ogg-FLAC; omitting it keeps the native .flac container (what Praat/ELAN/
  // Audacity/ffmpeg expect for archives).
  const initRes = Flac.init_encoder_stream(enc, writeCb, metaCb);
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
  patchStreamInfo(out, finalInfo);
  return new Blob([out], { type: 'audio/flac' });
}
