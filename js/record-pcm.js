/* record-pcm.js — lossless recording via the Web Audio graph.
 *
 * Captures mono 32-bit-float PCM with an AudioWorklet (the only reliable way to
 * get raw samples in a browser — MediaRecorder has no lossless output), then
 * encodes to uncompressed WAV (32-bit float / 24-bit / 16-bit). FLAC encoding
 * lives in flac.js (lazy-loaded) and consumes the same PCM. Works offline.
 *
 * Supported on Chromium + Firefox. Where AudioWorklet/getUserMedia is missing
 * or fails, the caller (app.js) falls back to MediaRecorder→MP3 and warns the
 * user the take is compressed, not archival. Safari/WebKit is unsupported and
 * will simply hit that fallback.
 */

// Cheap synchronous capability check, used to pick the capture path up front.
// The real proof is start() succeeding; callers still try/catch that and fall
// back on any failure.
export function losslessSupported() {
  return typeof AudioWorkletNode !== 'undefined'
    && !!(window.AudioContext || window.webkitAudioContext)
    && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

export class PCMRecorder {
  constructor() {
    this.ctx = null; this.stream = null; this.node = null; this.source = null;
    this.gainNode = null; this.analyser = null; this._meterBuf = null;
    this.chunks = []; this.total = 0; this.sampleRate = 0;
    this._flushResolve = null;
  }

  async start(opts = {}) {
    const AC = window.AudioContext || window.webkitAudioContext;
    // Mono + raw signal by DEFAULT: AGC/echo/noise off (they color the audio, and
    // AGC makes a loud take fade over its length). opts.audio carries the
    // researcher's OPTIONAL processing choices, which override these defaults only
    // when they deliberately turn them on in Settings.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: Object.assign(
        { channelCount: 1, echoCancellation: false, autoGainControl: false, noiseSuppression: false },
        opts.audio || {}),
    });
    this.ctx = new AC();
    this.sampleRate = this.ctx.sampleRate;
    // Resolve against THIS module's URL (engine path), not the document — so it
    // is correct in the cross-path recorder app too. Goes through the SW cache.
    await this.ctx.audioWorklet.addModule(new URL('audio-capture-worklet.js', import.meta.url).href);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-capture');
    this.node.port.onmessage = (e) => {
      const arr = new Float32Array(e.data.buf);
      if (arr.length) { this.chunks.push(arr); this.total += arr.length; }
      if (e.data.final && this._flushResolve) {
        const r = this._flushResolve; this._flushResolve = null; r();
      }
    };
    // Capture graph: source → [gain] → analyser → worklet → destination.
    // The analyser is a TRANSPARENT tap that feeds the live level meter (Web
    // Audio passes its input through unchanged). The gain node is inserted ONLY
    // when manual gain is enabled (opts.gain given) — so the default path has no
    // gain node at all and stays literally bit-faithful. A unity GainNode would
    // be transparent too, but omitting it keeps that guarantee unambiguous.
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this._meterBuf = new Float32Array(this.analyser.fftSize);
    let head = this.source;
    if (opts.gain != null) {
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = opts.gain;
      head.connect(this.gainNode);
      head = this.gainNode;
    }
    head.connect(this.analyser);
    this.analyser.connect(this.node);
    // The worklet only runs while it has a path to the destination; it writes
    // silence to its output (nothing is heard) — routing the mic to the speakers
    // would feed back.
    this.node.connect(this.ctx.destination);
  }

  // Live manual gain (only has effect when the gain node was created at start).
  setGain(linear) { if (this.gainNode) { try { this.gainNode.gain.value = linear; } catch { /* noop */ } } }

  // Current peak amplitude (0..1) of what's being captured, for the level meter.
  peak() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this._meterBuf);
    let p = 0;
    for (let i = 0; i < this._meterBuf.length; i++) {
      const a = this._meterBuf[i] < 0 ? -this._meterBuf[i] : this._meterBuf[i];
      if (a > p) p = a;
    }
    return p;
  }

  // Stop, flush the buffered tail deterministically, and return the take.
  async stop() {
    if (this.node) {
      await new Promise((resolve) => {
        this._flushResolve = resolve;
        try { this.node.port.postMessage('flush'); } catch { resolve(); return; }
        // Safety net in case the worklet is already gone (resolve once).
        setTimeout(() => { if (this._flushResolve) { this._flushResolve = null; resolve(); } }, 500);
      });
    }
    this._teardown();
    const pcm = concatFloat32(this.chunks, this.total);
    this.chunks = [];
    return { pcm, sampleRate: this.sampleRate, duration: this.sampleRate ? pcm.length / this.sampleRate : 0 };
  }

  cancel() { this._teardown(); this.chunks = []; this.total = 0; }

  _teardown() {
    try { this.source && this.source.disconnect(); } catch { /* noop */ }
    try { this.gainNode && this.gainNode.disconnect(); } catch { /* noop */ }
    try { this.analyser && this.analyser.disconnect(); } catch { /* noop */ }
    try { this.node && this.node.disconnect(); } catch { /* noop */ }
    try { this.stream && this.stream.getTracks().forEach((tr) => tr.stop()); } catch { /* noop */ }
    try { this.ctx && this.ctx.close(); } catch { /* noop */ }
    this.source = this.node = this.stream = this.ctx = this.gainNode = this.analyser = null;
  }
}

function concatFloat32(chunks, total) {
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/* ---- WAV encoding ---------------------------------------------------------
 * Mono WAV. 32-bit is IEEE float (format 3) — the natural zero-loss Web Audio
 * output; 24/16-bit are integer PCM (format 1). Little-endian (every supported
 * browser runs on little-endian hardware). A 'fact' chunk is included for the
 * float format, as the spec asks for non-PCM data — keeps Praat/ELAN happy.
 */
export function encodeWav(pcm, sampleRate, bitDepth) {
  const float = bitDepth === 32;
  const bytesPerSample = bitDepth >> 3;
  const dataLen = pcm.length * bytesPerSample;
  const fmtLen = float ? 18 : 16;   // float fmt carries a (zero) cbSize field
  const factLen = float ? 12 : 0;   // 'fact' + size(4) + sampleCount(4)
  const headerLen = 12 + (8 + fmtLen) + factLen + 8;
  const buf = new ArrayBuffer(headerLen + dataLen);
  const dv = new DataView(buf);
  let p = 0;
  const u32 = (v) => { dv.setUint32(p, v, true); p += 4; };
  const u16 = (v) => { dv.setUint16(p, v, true); p += 2; };
  const str = (s) => { for (let i = 0; i < s.length; i++) dv.setUint8(p++, s.charCodeAt(i)); };

  str('RIFF'); u32(headerLen - 8 + dataLen); str('WAVE');
  str('fmt '); u32(fmtLen);
  u16(float ? 3 : 1);                 // format: 3 = IEEE float, 1 = integer PCM
  u16(1);                             // channels = mono
  u32(sampleRate);
  u32(sampleRate * bytesPerSample);   // byte rate
  u16(bytesPerSample);                // block align
  u16(bitDepth);
  if (float) u16(0);                  // cbSize
  if (float) { str('fact'); u32(4); u32(pcm.length); }
  str('data'); u32(dataLen);

  if (float) {
    // Float32Array is already little-endian Float32 — copy the bytes directly.
    new Uint8Array(buf, p).set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  } else if (bitDepth === 16) {
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      dv.setInt16(p, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true); p += 2;
    }
  } else { // 24-bit integer, packed 3 bytes little-endian
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      let v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
      if (v < -0x800000) v = -0x800000;
      if (v > 0x7fffff) v = 0x7fffff;
      dv.setUint8(p++, v & 0xff); dv.setUint8(p++, (v >> 8) & 0xff); dv.setUint8(p++, (v >> 16) & 0xff);
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// Peak-normalize mono Float32 PCM in place to ~-1 dBFS. This EDITS the signal
// (post-record), so it's an opt-in, off-by-default, archive-discouraged option.
export function normalizePeak(pcm, target = 0.89) {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) { const a = pcm[i] < 0 ? -pcm[i] : pcm[i]; if (a > peak) peak = a; }
  if (peak > 0) { const g = target / peak; for (let i = 0; i < pcm.length; i++) pcm[i] *= g; }
  return pcm;
}

/* ---- Format catalogue + dispatch ------------------------------------------
 * Shared by the settings UI and the save path. `mp3` is the compressed
 * distribution/fallback format and is NOT produced here (app.js routes it
 * through MediaRecorder + convert.js); it lives in the table so the selector
 * and link params can name it.
 */
export const REC_FORMATS = {
  wav32:  { ext: 'wav',  mime: 'audio/wav',  lossless: true,  wavBits: 32 },
  wav24:  { ext: 'wav',  mime: 'audio/wav',  lossless: true,  wavBits: 24 },
  wav16:  { ext: 'wav',  mime: 'audio/wav',  lossless: true,  wavBits: 16 },
  flac24: { ext: 'flac', mime: 'audio/flac', lossless: true,  flacBits: 24 },
  mp3:    { ext: 'mp3',  mime: 'audio/mpeg', lossless: false },
};
export const DEFAULT_REC_FORMAT = 'wav24'; // 24-bit integer PCM: the archival sweet spot accepted everywhere
export function normRecFormat(v) { return REC_FORMATS[v] ? v : DEFAULT_REC_FORMAT; }

// Encode captured PCM to one of the LOSSLESS formats (WAV inline; FLAC via the
// lazy-loaded encoder). Returns { blob, ext }. Callers handle mp3 separately.
export async function encodeRecording(pcm, sampleRate, format, onProgress) {
  const key = normRecFormat(format);
  const f = REC_FORMATS[key];
  if (f.wavBits) {
    if (onProgress) onProgress(1);
    return { blob: encodeWav(pcm, sampleRate, f.wavBits), ext: f.ext, mime: f.mime };
  }
  if (f.flacBits) {
    const { encodeFlac } = await import('./flac.js');
    return { blob: await encodeFlac(pcm, sampleRate, f.flacBits, onProgress), ext: f.ext, mime: f.mime };
  }
  throw new Error('Not a lossless recording format: ' + format);
}
