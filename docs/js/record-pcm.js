/* record-pcm.js — lossless recording via the Web Audio graph.
 *
 * Captures raw 32-bit-float PCM with an AudioWorklet (the only reliable way to
 * get raw samples in a browser — MediaRecorder has no lossless output), then
 * encodes to uncompressed WAV (32-bit float / 24-bit / 16-bit). FLAC encoding
 * lives in flac.js (lazy-loaded) and consumes the same PCM. Works offline.
 *
 * Channels: we capture the device's NATIVE channels (we do NOT force mono — that
 * lets the browser down-mix and can quietly average a dead channel, costing ~6 dB,
 * differently in Chrome vs Firefox). reduceChannels() then decides from content:
 * drops a dead/empty channel (→ mono, full level), collapses an identical
 * dual-mono pair (→ mono), and keeps genuinely-different channels as real stereo.
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
    this.analyser = null; this._meterBuf = null;
    this.chanChunks = null; this.nch = 1; this.total = 0; this.sampleRate = 0;
    this._flushResolve = null;
    // Armed by DEFAULT so a plain start() behaves exactly as it always has — only warm() disarms.
    // Getting this backwards would silently route every existing recording into the ring buffer.
    this._armed = true; this._preChunks = null; this._preTotal = 0; this._preRollSec = 0;
  }

  /* Open the mic and run the capture graph WITHOUT keeping a take yet, holding the most recent
   * `preRollSec` of audio in a ring buffer.
   *
   * ⚠ WHY: getUserMedia + AudioWorklet takes real time — on a cheap phone, comfortably a second.
   * Doing that on the record TAP means the interface is still opening while the speaker is already
   * talking, and their first word is simply not in the file. It looks fine afterwards, which is the
   * worst kind of loss. Warming when the record SCREEN opens moves that wait to a moment when
   * nobody is speaking, and the ring buffer then covers the remaining gap — including a speaker who
   * starts before the tap, which in practice they do.
   *
   * The mic IS live while warm. That is disclosed by the level meter, which is the only "it is
   * listening" signal a non-reading user can trust. Callers must warm only AFTER consent and must
   * release on leaving the screen — see releaseWarmMic() in app.js. */
  async warm(opts = {}) {
    this._preRollSec = opts.preRollSec == null ? 2 : opts.preRollSec;
    this._armed = false;
    this._preChunks = null;
    this._preTotal = 0;
    await this.start(opts);
  }

  /* Ring-buffer one block while warm, keeping only the most recent preRollSec.
   *
   * Split out as its own method so the test suite can drive THIS code rather than a re-implementation
   * of it — a test that copies the logic it is checking passes even when the real path is broken.
   * (That is not hypothetical: a copied test is exactly what hid a missing IPC handler in the desktop
   * shell.) It needs no AudioWorklet, so it stays testable headlessly. */
  _bufferPreRoll(chans) {
    if (!this._preChunks || this._preChunks.length !== chans.length) {
      this._preChunks = Array.from({ length: chans.length }, () => []);
      this._preTotal = 0;
    }
    for (let c = 0; c < chans.length; c++) this._preChunks[c].push(chans[c]);
    this._preTotal += chans[0].length;
    // Drop whole chunks off the front — whole chunks only, so a sample is never split. The buffer
    // therefore holds slightly MORE than asked for, never less, which is the right way to round
    // when the cost of being short is a missing first word.
    const max = Math.max(0, Math.floor(this._preRollSec * (this.sampleRate || 48000)));
    while (this._preChunks[0].length > 1 && this._preTotal - this._preChunks[0][0].length >= max) {
      const n = this._preChunks[0][0].length;
      for (let c = 0; c < this._preChunks.length; c++) this._preChunks[c].shift();
      this._preTotal -= n;
    }
  }

  /** Begin keeping the take, prepending whatever the ring buffer already holds. */
  arm() {
    if (this._armed) return { preRollSec: 0 };
    this._armed = true;
    const pre = this._preChunks;
    const preTotal = this._preTotal;
    this._preChunks = null; this._preTotal = 0;
    if (!pre || !preTotal) return { preRollSec: 0 };
    this.chanChunks = pre;
    this.nch = pre.length;
    this.total = preTotal;
    return { preRollSec: this.sampleRate ? preTotal / this.sampleRate : 0 };
  }

  async start(opts = {}) {
    const AC = window.AudioContext || window.webkitAudioContext;
    // Raw signal by DEFAULT: AGC/echo/noise off (they color the audio). We do NOT
    // force channelCount:1 — we capture the device's NATIVE channels and decide
    // mono-vs-stereo from content (reduceChannels). Forcing mono lets the browser
    // do its own down-mix, which can quietly average a dead channel and cost ~6 dB
    // (and Chrome/Firefox differ in how they do it). opts.audio carries the
    // researcher's optional processing + the faithfulness flags from app.js.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: Object.assign(
        { echoCancellation: false, autoGainControl: false, noiseSuppression: false },
        opts.audio || {}),
    });
    this.ctx = new AC();
    this.sampleRate = this.ctx.sampleRate;
    // Resolve against THIS module's URL (engine path), not the document — so it
    // is correct in the cross-path recorder app too. Goes through the SW cache.
    await this.ctx.audioWorklet.addModule(new URL('audio-capture-worklet.js', import.meta.url).href);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    // Default node config (channelCountMode 'max') so the worklet sees however
    // many channels actually arrive — 1 if the mono request was honored, 2 if it
    // was ignored — letting us decide mono-vs-stereo from content (not up-mixing).
    this.node = new AudioWorkletNode(this.ctx, 'pcm-capture');
    this.node.port.onmessage = (e) => {
      const d = e.data;
      if (d.bufs && d.bufs.length) {
        const first = new Float32Array(d.bufs[0]);
        if (!this._armed) {
          const chans = [first];
          for (let c = 1; c < d.nch; c++) chans.push(new Float32Array(d.bufs[c]));
          this._bufferPreRoll(chans);
          return;
        }
        if (!this.chanChunks || this.nch !== d.nch) {
          this.nch = d.nch;
          this.chanChunks = Array.from({ length: d.nch }, () => []);
        }
        for (let c = 0; c < d.nch; c++) this.chanChunks[c].push(c === 0 ? first : new Float32Array(d.bufs[c]));
        this.total += first.length;
      }
      if (d.final && this._flushResolve) {
        const r = this._flushResolve; this._flushResolve = null; r();
      }
    };
    // Capture graph: source → analyser → worklet → destination. The analyser is a
    // TRANSPARENT tap that feeds the live level meter (Web Audio passes its input
    // through unchanged) — there is NO gain node anywhere, so capture is literally
    // bit-faithful; the app never applies software gain to a recording.
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this._meterBuf = new Float32Array(this.analyser.fftSize);
    this.source.connect(this.analyser);
    this.analyser.connect(this.node);
    // The worklet only runs while it has a path to the destination; it writes
    // silence to its output (nothing is heard) — routing the mic to the speakers
    // would feed back.
    this.node.connect(this.ctx.destination);
  }

  // Current peak amplitude (0..1) of what's being captured, for the level meter.
  // (The analyser down-mixes a multi-channel input for its read; that only
  // affects the meter display, never the stored recording.)
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

  // Stop, flush the buffered tail deterministically, and return the take as an
  // array of per-channel Float32Array (1 channel if mono was honored, else 2).
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
    const nch = this.chanChunks ? this.chanChunks.length : 1;
    const channels = [];
    for (let c = 0; c < nch; c++) {
      // Hand each channel's chunk list to concatFloat32 and drop OUR reference to it first, so the
      // chunks can be collected as they are copied instead of the whole take existing twice. On a
      // long take that doubling is a big enough allocation to be the thing that kills the tab.
      const chunks = this.chanChunks ? this.chanChunks[c] : [];
      if (this.chanChunks) this.chanChunks[c] = null;
      channels.push(concatFloat32(chunks, this.total));
    }
    this.chanChunks = null;
    return { channels, sampleRate: this.sampleRate, duration: this.sampleRate ? this.total / this.sampleRate : 0 };
  }

  /* Bytes of Float32 PCM this recorder is currently holding in memory (take + any warm ring
   * buffer). This is the REAL number, not an estimate from elapsed time: it already accounts for
   * however many channels the device actually delivered, which is the whole difficulty — a stereo
   * device fills memory twice as fast as a mono one at the same clock time. */
  bytesHeld() {
    return ((this.total || 0) + (this._preTotal || 0)) * (this.nch || 1) * 4;
  }

  /* Rate that number grows at. Used to turn "budget remaining" into "seconds remaining", which is
   * the only form of it a field user can act on. */
  bytesPerSecond() {
    return (this.sampleRate || 0) * (this.nch || 1) * 4;
  }

  // Releasing the mic must also drop the ring buffer: warm audio was captured before anyone chose
  // to record, so it must never outlive the screen that disclosed the mic was open.
  cancel() {
    this._teardown();
    this.chanChunks = null; this.total = 0;
    this._preChunks = null; this._preTotal = 0; this._armed = true;
  }

  _teardown() {
    try { this.source && this.source.disconnect(); } catch { /* noop */ }
    try { this.analyser && this.analyser.disconnect(); } catch { /* noop */ }
    try { this.node && this.node.disconnect(); } catch { /* noop */ }
    try { this.stream && this.stream.getTracks().forEach((tr) => tr.stop()); } catch { /* noop */ }
    try { this.ctx && this.ctx.close(); } catch { /* noop */ }
    this.source = this.node = this.stream = this.ctx = this.analyser = null;
  }
}

/* ---- RAM safety net for the lossless path ---------------------------------
 * The AudioWorklet take lives as Float32 in memory until it is encoded, so a long take on a cheap
 * phone can exhaust the renderer. Running out there is NOT a catchable error — the browser kills
 * the tab, and the recording is gone with no message and no way to recover it. That is the worst
 * failure this app has, so a take is stopped (to REVIEW, fully intact) before reaching that point,
 * with a warning first.
 *
 * These two functions are pure and exported so the test suite drives the REAL logic rather than a
 * re-implementation of it — the same reason _bufferPreRoll is its own method.
 */

/* How much Float32 PCM we allow in memory, from navigator.deviceMemory (GiB; undefined on Firefox
 * and Safari). Peak usage is ~2.5x this figure during the final encode, so the fraction sits well
 * below what the device actually has. The unknown-device default assumes a desktop: the phones
 * this guard exists for (Chromium on Android) all report deviceMemory, and capping an unknown
 * browser aggressively would penalise exactly the machines used to record masters (Firefox on a
 * laptop), which have no shortage of RAM. */
export function pcmRamBudgetBytes(deviceMemoryGiB) {
  const MB = 1024 * 1024;
  if (!deviceMemoryGiB || !(deviceMemoryGiB > 0)) return 640 * MB;
  // ⚠ THE FLOOR MUST STAY BELOW WHAT THE FORMULA GIVES THE WEAKEST DEVICE.
  // A 192 MB floor (the first version of this) INVERTED the whole point: a 0.5 GiB phone's formula
  // says 92 MB, but the floor raised it to 192 MB — a ~480 MB peak on a half-gigabyte device, i.e.
  // the most fragile hardware got the largest risk, which is the opposite of a safety net. A floor
  // exists so the budget is never absurdly small; it must never hand a device MORE than its own
  // memory justifies.
  //
  // 0.10 rather than 0.18 because the asymmetry is severe: hitting the cap is SAFE (the take stops
  // to review, fully intact), while guessing high means the browser kills the tab and the recording
  // is gone with no error to catch. Against Seth's actual distribution — 1-10 min typical, 2-3 min
  // average, 45 min rare — 0.10 still allows ~9 min mono on a 1 GiB phone and ~36 min on a 4 GiB
  // one, so the cap only bites on the rare long take, and bites safely.
  //
  // ⚠ STILL UNMEASURED on real low-end hardware. This is reasoned, not observed. Retune here once a
  // cheap Android phone has been tested; pcmCapStatus and this function are pure and covered by
  // test/record-memory.test.mjs, so changing the numbers is a one-line edit.
  return Math.max(48 * MB, Math.min(1024 * MB, deviceMemoryGiB * 1024 * 0.10 * MB));
}

/* Where a take stands against that budget. 'warn' leaves time to reach a natural stopping point;
 * 'stop' means stop now, keeping the take. */
export function pcmCapStatus({ bytesHeld, bytesPerSecond, budgetBytes, warnFrac = 0.8 }) {
  if (!(budgetBytes > 0)) return { frac: 0, secsLeft: Infinity, level: 'ok' };
  const frac = bytesHeld / budgetBytes;
  const secsLeft = bytesPerSecond > 0
    ? Math.max(0, (budgetBytes - bytesHeld) / bytesPerSecond)
    : Infinity;
  return { frac, secsLeft, level: frac >= 1 ? 'stop' : frac >= warnFrac ? 'warn' : 'ok' };
}

/* ⚠ CONSUMES `chunks`: each entry is released as it is copied, so the take does not briefly exist
 * twice. Callers must not reuse the array afterwards (stop() drops its reference first). */
function concatFloat32(chunks, total) {
  const out = new Float32Array(total);
  let o = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    out.set(c, o); o += c.length;
    chunks[i] = null;
  }
  return out;
}

// Accept either a single Float32Array (mono) or an array of per-channel arrays.
function asChannels(x) { return (x instanceof Float32Array) ? [x] : x; }

/* Decide mono-vs-stereo from captured channels WITHOUT averaging a live channel
 * with a dead one. Drops (near-)silent channels; if the survivors are
 * effectively identical (dual-mono), keeps one; only genuinely different
 * channels stay as stereo. Returns an array of 1 or 2 Float32Array. */
export function reduceChannels(channels) {
  const chans = asChannels(channels);
  if (chans.length <= 1) return chans;
  const peakOf = (ch) => { let p = 0; for (let i = 0; i < ch.length; i++) { const a = ch[i] < 0 ? -ch[i] : ch[i]; if (a > p) p = a; } return p; };
  const live = chans.filter((ch) => peakOf(ch) > 0.001); // > ~-60 dBFS = real signal
  if (live.length <= 1) return [live[0] || chans[0]]; // one (or zero) live → mono, full level
  // 2+ live channels: keep stereo only if the first two actually differ.
  const a = live[0], b = live[1];
  const n = Math.min(a.length, b.length);
  const step = Math.max(1, Math.floor(n / 30000)); // sample for speed on long takes
  let maxDiff = 0;
  for (let i = 0; i < n; i += step) { const d = a[i] - b[i]; const ad = d < 0 ? -d : d; if (ad > maxDiff) maxDiff = ad; }
  if (maxDiff < 0.0008) return [a]; // effectively identical (dual-mono) → mono
  return [a, b];                    // genuine stereo → keep two channels
}

/* ---- WAV encoding ---------------------------------------------------------
 * Mono or stereo WAV. 32-bit is IEEE float (format 3) — the natural zero-loss
 * Web Audio output; 24/16-bit are integer PCM (format 1). Channels interleaved,
 * little-endian (every supported browser runs on little-endian hardware). A
 * 'fact' chunk is included for the float format, as the spec asks for non-PCM
 * data — keeps Praat/ELAN happy.
 */
export function encodeWav(channels, sampleRate, bitDepth) {
  const chans = asChannels(channels);
  const nch = chans.length;
  const n = chans[0].length;
  const float = bitDepth === 32;
  const bytesPerSample = bitDepth >> 3;
  const blockAlign = nch * bytesPerSample;
  const dataLen = n * blockAlign;
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
  u16(nch);                           // channels
  u32(sampleRate);
  u32(sampleRate * blockAlign);       // byte rate
  u16(blockAlign);                    // block align
  u16(bitDepth);
  if (float) u16(0);                  // cbSize
  if (float) { str('fact'); u32(4); u32(n); } // sample frames per channel
  str('data'); u32(dataLen);

  if (float && nch === 1) {
    // Mono float: the Float32Array is already little-endian — copy bytes directly.
    new Uint8Array(buf, p).set(new Uint8Array(chans[0].buffer, chans[0].byteOffset, chans[0].byteLength));
  } else if (float) {
    for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) { dv.setFloat32(p, chans[c][i], true); p += 4; }
  } else if (bitDepth === 16) {
    for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      dv.setInt16(p, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true); p += 2;
    }
  } else { // 24-bit integer, packed 3 bytes little-endian
    for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      let v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
      if (v < -0x800000) v = -0x800000;
      if (v > 0x7fffff) v = 0x7fffff;
      dv.setUint8(p++, v & 0xff); dv.setUint8(p++, (v >> 8) & 0xff); dv.setUint8(p++, (v >> 16) & 0xff);
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// Peak-normalize (mono or stereo) Float32 PCM in place to ~-1 dBFS, by a SINGLE
// global gain (preserves the channel balance). This EDITS the signal (post-
// record), so it's an opt-in, off-by-default, archive-discouraged option.
export function normalizePeak(channels, target = 0.89) {
  const chans = asChannels(channels);
  let peak = 0;
  for (const ch of chans) for (let i = 0; i < ch.length; i++) { const a = ch[i] < 0 ? -ch[i] : ch[i]; if (a > peak) peak = a; }
  if (peak > 0) { const g = target / peak; for (const ch of chans) for (let i = 0; i < ch.length; i++) ch[i] *= g; }
  return channels;
}

/* ---- Format catalogue + dispatch ------------------------------------------
 * Shared by the settings UI and the save path. `mp3` is the compressed
 * distribution/fallback format and is NOT produced here (app.js routes it
 * through MediaRecorder + convert.js); it lives in the table so the selector
 * and link params can name it.
 */
export const REC_FORMATS = {
  // capture:'pcm'   → Web Audio AudioWorklet path, encoded by encodeRecording (WAV/FLAC).
  // capture:'media' → MediaRecorder path. save:'direct' keeps the captured blob as-is
  //   (.webm); save:'mp3' transcodes via convert.js. mediaMime = the codec requested.
  wav32:   { ext: 'wav',  mime: 'audio/wav',  lossless: true,  capture: 'pcm',   wavBits: 32 },
  wav24:   { ext: 'wav',  mime: 'audio/wav',  lossless: true,  capture: 'pcm',   wavBits: 24 },
  wav16:   { ext: 'wav',  mime: 'audio/wav',  lossless: true,  capture: 'pcm',   wavBits: 16 },
  flac24:  { ext: 'flac', mime: 'audio/flac', lossless: true,  capture: 'pcm',   flacBits: 24 },
  webmpcm: { ext: 'webm', mime: 'audio/webm', lossless: true,  capture: 'media', mediaMime: 'audio/webm;codecs=pcm',  save: 'direct' },
  opus:    { ext: 'webm', mime: 'audio/webm', lossless: false, capture: 'media', mediaMime: 'audio/webm;codecs=opus', save: 'direct' },
  mp3:     { ext: 'mp3',  mime: 'audio/mpeg', lossless: false, capture: 'media', save: 'mp3' },
};
export const DEFAULT_REC_FORMAT = 'wav24'; // 24-bit integer PCM: the archival sweet spot accepted everywhere
export function normRecFormat(v) { return REC_FORMATS[v] ? v : DEFAULT_REC_FORMAT; }

// Whether THIS browser can actually capture the given format: PCM formats need the
// Web Audio worklet; media formats need MediaRecorder to support their codec (e.g.
// webm;codecs=pcm is Chromium-only). Callers fall back when this is false.
export function recFormatSupported(format) {
  const f = REC_FORMATS[normRecFormat(format)];
  if (f.capture === 'pcm') return losslessSupported();
  if (typeof MediaRecorder === 'undefined') return false;
  return f.mediaMime ? MediaRecorder.isTypeSupported(f.mediaMime) : true;
}

// Encode captured channels (mono or stereo) to one of the LOSSLESS formats (WAV
// inline; FLAC via the lazy-loaded encoder). Returns { blob, ext, mime }.
// Callers handle mp3 separately.
export async function encodeRecording(channels, sampleRate, format, onProgress) {
  const key = normRecFormat(format);
  const f = REC_FORMATS[key];
  if (f.wavBits) {
    if (onProgress) onProgress(1);
    return { blob: encodeWav(channels, sampleRate, f.wavBits), ext: f.ext, mime: f.mime };
  }
  if (f.flacBits) {
    const { encodeFlac } = await import('./flac.js');
    return { blob: await encodeFlac(channels, sampleRate, f.flacBits, onProgress), ext: f.ext, mime: f.mime };
  }
  throw new Error('Not a lossless recording format: ' + format);
}
