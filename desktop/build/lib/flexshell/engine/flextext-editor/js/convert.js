/* convert.js — client-side audio conversion for task recordings.
 *
 * Researchers' recorders produce big files (often 32-bit stereo WAV); tasks
 * need small ones. This converts any decodable audio to MP3 entirely in the
 * browser (vendored lamejs encoder, LGPL — see js/vendor/lamejs.LICENSE):
 * decode via Web Audio, optional downmix to mono + resample via
 * OfflineAudioContext, then encode at the chosen bitrate. Works offline.
 *
 * convertAudio() extends this to FLAC + lesser-WAV output and explicit mono
 * modes (mix/auto/left/right), DOWNWARD only (never upscale): WAV 32→24→16,
 * WAV→FLAC, WAV/FLAC→MP3. m4a/AAC is deliberately NOT offered — there is no
 * reliable offline in-browser AAC encoder on the supported browsers. Reuses the
 * proven encoders (encodeWav/encodeFlac); both modules are already precached in
 * every app's SW shell, so no new shell files are introduced here.
 */

import { wavWithBext } from './seg-exports.js';
import { encodeWav, reduceChannels } from './record-pcm.js';
import { encodeFlac } from './flac.js';

let lamePromise = null;

function loadLame() {
  if (!lamePromise) {
    lamePromise = new Promise((resolve, reject) => {
      if (window.lamejs) { resolve(window.lamejs); return; }
      const s = document.createElement('script');
      s.src = 'js/vendor/lame.min.js';
      s.onload = () => {
        if (window.lamejs) resolve(window.lamejs);
        else reject(new Error('MP3 encoder did not initialize'));
      };
      s.onerror = () => reject(new Error('Could not load the MP3 encoder'));
      document.head.appendChild(s);
    });
  }
  return lamePromise;
}

function floatTo16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Convert an audio File/Blob to MP3.
 * @param {Blob} file
 * @param {{kbps?:number, mono?:boolean, sampleRate?:number}} opts
 * @param {(fraction:number)=>void} [onProgress]
 * @returns {Promise<{blob: Blob, duration: number, channels: number}>}
 */
export async function convertToMp3(file, opts = {}, onProgress) {
  const kbps = opts.kbps || 64;
  const mono = opts.mono !== false;
  const sampleRate = opts.sampleRate || 22050;

  const lame = await loadLame();
  const raw = await file.arrayBuffer();

  const AC = window.AudioContext || window.webkitAudioContext;
  const probe = new AC();
  let decoded;
  try {
    decoded = await probe.decodeAudioData(raw);
  } finally {
    probe.close().catch?.(() => {});
  }

  const channels = mono ? 1 : Math.min(2, decoded.numberOfChannels);
  const oac = new OfflineAudioContext(
    channels, Math.max(1, Math.ceil(decoded.duration * sampleRate)), sampleRate);

  // For mono output, do the downmix OURSELVES so a live channel is never averaged
  // with a dead/empty one. Web Audio's default mono downmix is (L+R)/2, which
  // costs ~6 dB on a one-sided stereo file (mic on one channel, silence on the
  // other). We average only the channels that actually carry signal.
  let srcBuffer = decoded;
  if (mono && decoded.numberOfChannels > 1) {
    const len = decoded.length;
    const live = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const d = decoded.getChannelData(c);
      let peak = 0;
      for (let i = 0; i < len; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > peak) peak = a; }
      if (peak > 0.001) live.push(d); // > ~-60 dBFS = real signal, not a dead channel
    }
    const use = live.length ? live : [decoded.getChannelData(0)]; // all silent → take ch 0
    const monoData = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let k = 0; k < use.length; k++) s += use[k][i];
      monoData[i] = s / use.length;
    }
    srcBuffer = oac.createBuffer(1, len, decoded.sampleRate);
    srcBuffer.copyToChannel(monoData, 0);
  }
  // The OfflineAudioContext now only RESAMPLES (the source is already mono).
  const src = oac.createBufferSource();
  src.buffer = srcBuffer;
  src.connect(oac.destination);
  src.start();
  const rendered = await oac.startRendering();

  // Optional post-record peak normalize (~-1 dBFS). This EDITS the audio; only
  // used for recordings when the researcher opted in (off by default).
  if (opts.normalize) {
    let peak = 0;
    for (let c = 0; c < channels; c++) {
      const d = rendered.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > peak) peak = a; }
    }
    if (peak > 0) {
      const g = 0.89 / peak;
      for (let c = 0; c < channels; c++) {
        const d = rendered.getChannelData(c);
        for (let i = 0; i < d.length; i++) d[i] *= g;
      }
    }
  }

  const enc = new lame.Mp3Encoder(channels, sampleRate, kbps);
  const left = floatTo16(rendered.getChannelData(0));
  const right = channels === 2 ? floatTo16(rendered.getChannelData(1)) : null;
  const BLOCK = 1152 * 24;
  const parts = [];
  for (let i = 0; i < left.length; i += BLOCK) {
    const data = right
      ? enc.encodeBuffer(left.subarray(i, i + BLOCK), right.subarray(i, i + BLOCK))
      : enc.encodeBuffer(left.subarray(i, i + BLOCK));
    if (data.length) parts.push(new Uint8Array(data));
    if (onProgress) onProgress(Math.min(0.99, i / left.length));
    // Yield so the UI (status text) stays responsive during long encodes.
    await new Promise(r => setTimeout(r, 0));
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  if (onProgress) onProgress(1);

  return {
    blob: new Blob(parts, { type: 'audio/mpeg' }),
    duration: rendered.duration,
    channels,
  };
}

/* ---- Multi-format converter (FLAC / lesser-WAV / MP3), downward only -------- */

// Sniff the container from the first bytes (the same magic-byte approach as audio.js's AIFF check).
// Accepts an ArrayBuffer or Uint8Array. Returns 'wav'|'flac'|'mp3'|'ogg'|'m4a'|'aiff'|null.
export function detectFormat(buf) {
  const h = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (h.length < 12) return null;
  const s = (i, n) => { let r = ''; for (let j = 0; j < n; j++) r += String.fromCharCode(h[i + j]); return r; };
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') return 'wav';
  if (s(0, 4) === 'fLaC') return 'flac';
  if (s(0, 4) === 'FORM' && (s(8, 4) === 'AIFF' || s(8, 4) === 'AIFC')) return 'aiff';
  if (s(0, 4) === 'OggS') return 'ogg';
  if (s(0, 3) === 'ID3') return 'mp3';
  if (h[0] === 0xff && (h[1] & 0xe0) === 0xe0) return 'mp3';   // MPEG frame sync
  if (s(4, 4) === 'ftyp') return 'm4a';                        // ...as INPUT only
  return null;
}

// Read a fmt chunk, resolving WAVE_FORMAT_EXTENSIBLE to the format it actually contains.
//
// ⚠ Anything writing >16-bit WAV tends to use EXTENSIBLE (0xFFFE) rather than a plain format tag — our
// own desktop shell does, via ffmpeg. The real format then lives in the SubFormat GUID, whose first two
// bytes carry the classic code (1 = PCM, 3 = IEEE float). Reading wFormatTag alone makes a float file
// look like an unknown format, and parseWav would then decode float samples through the integer branch:
// no error, just noise. So resolve it here, once, for every caller.
function readFmt(dv, body) {
  const f = {
    audioFormat: dv.getUint16(body, true),
    channels: dv.getUint16(body + 2, true),
    sampleRate: dv.getUint32(body + 4, true),
    bitsPerSample: dv.getUint16(body + 14, true),
  };
  if (f.audioFormat === 0xFFFE && body + 26 <= dv.byteLength) {
    f.extensible = true;
    f.audioFormat = dv.getUint16(body + 24, true);   // SubFormat GUID, first 2 bytes
  }
  return f;
}

// Read ONLY a WAV's fmt header (cheap — no sample decode). Returns null if not a parseable WAV.
export function readWavHeader(buf) {
  const dv = new DataView(buf);
  const str = (o, n) => { let r = ''; for (let i = 0; i < n; i++) r += String.fromCharCode(dv.getUint8(o + i)); return r; };
  if (dv.byteLength < 12 || str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') return null;
  let p = 12, fmt = null, dataLen = 0;
  while (p + 8 <= dv.byteLength) {
    const id = str(p, 4); const sz = dv.getUint32(p + 4, true); const body = p + 8;
    if (id === 'fmt ' && body + 16 <= dv.byteLength) {
      fmt = readFmt(dv, body);
    } else if (id === 'data') { dataLen = sz; }
    p = body + sz + (sz & 1);   // chunks are word-aligned
  }
  if (!fmt) return null;
  const bytesPer = Math.max(1, fmt.bitsPerSample >> 3);
  fmt.frames = Math.floor(dataLen / (bytesPer * Math.max(1, fmt.channels)));
  return fmt;
}

// Parse a WAV to per-channel Float32 — bit-faithful (does NOT round-trip through decodeAudioData, which
// would discard the source bit depth + may resample). Supports 8/16/24/32-int + 32/64-float PCM.
export function parseWav(buf) {
  const dv = new DataView(buf);
  const str = (o, n) => { let r = ''; for (let i = 0; i < n; i++) r += String.fromCharCode(dv.getUint8(o + i)); return r; };
  if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') throw new Error('Not a WAV file');
  let p = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (p + 8 <= dv.byteLength) {
    const id = str(p, 4); const sz = dv.getUint32(p + 4, true); const body = p + 8;
    if (id === 'fmt ') fmt = readFmt(dv, body);
    else if (id === 'data') { dataOff = body; dataLen = Math.min(sz, dv.byteLength - body); }
    p = body + sz + (sz & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('Malformed WAV (missing fmt or data chunk)');
  const { audioFormat, channels, sampleRate, bitsPerSample } = fmt;
  const bytesPer = bitsPerSample >> 3;
  if (!channels || !bytesPer) throw new Error('Unsupported WAV header');
  const frames = Math.floor(dataLen / (bytesPer * channels));
  const out = []; for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    const off = dataOff + (i * channels + c) * bytesPer;
    let v;
    if (audioFormat === 3 && bitsPerSample === 64) v = dv.getFloat64(off, true);
    else if (audioFormat === 3) v = dv.getFloat32(off, true);
    else if (bitsPerSample === 16) v = dv.getInt16(off, true) / 0x8000;
    else if (bitsPerSample === 24) { let u = dv.getUint8(off) | (dv.getUint8(off + 1) << 8) | (dv.getUint8(off + 2) << 16); if (u & 0x800000) u -= 0x1000000; v = u / 0x800000; }
    else if (bitsPerSample === 32) v = dv.getInt32(off, true) / 0x80000000;
    else if (bitsPerSample === 8) v = (dv.getUint8(off) - 128) / 128;
    else throw new Error('Unsupported WAV bit depth: ' + bitsPerSample);
    out[c][i] = v;
  }
  return { channels: out, sampleRate, bitDepth: bitsPerSample, format: audioFormat };
}

// Reduce stereo→mono by an explicit mode. 'auto' = the recorder's smart downmix (drop dead/dual-mono),
// 'mix' = (L+R)/2, 'left'/'right' = that channel only, 'keep' = unchanged.
export function pickMono(chans, mode) {
  if (!chans || chans.length <= 1 || mode === 'keep' || !mode) return chans;
  if (mode === 'auto') return reduceChannels(chans);
  if (mode === 'left') return [chans[0]];
  if (mode === 'right') return [chans[1] || chans[0]];
  const n = chans[0].length, out = new Float32Array(n);   // 'mix'
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < chans.length; c++) s += chans[c][i]; out[i] = s / chans.length; }
  return [out];
}

async function resampleChannels(chans, srcRate, dstRate) {
  if (dstRate === srcRate) return chans;
  const n = chans[0].length;
  const oac = new OfflineAudioContext(chans.length, Math.max(1, Math.ceil(n * dstRate / srcRate)), dstRate);
  const buf = oac.createBuffer(chans.length, n, srcRate);
  for (let c = 0; c < chans.length; c++) buf.copyToChannel(chans[c], c);
  const src = oac.createBufferSource(); src.buffer = buf; src.connect(oac.destination); src.start();
  const rendered = await oac.startRendering();
  const out = []; for (let c = 0; c < rendered.numberOfChannels; c++) out.push(rendered.getChannelData(c).slice());
  return out;
}

async function encodeMp3FromChannels(chans, sampleRate, kbps, onProgress) {
  const lame = await loadLame();
  const nch = Math.min(2, chans.length);
  const enc = new lame.Mp3Encoder(nch, sampleRate, kbps);
  const left = floatTo16(chans[0]);
  const right = nch === 2 ? floatTo16(chans[1]) : null;
  const BLOCK = 1152 * 24; const parts = [];
  for (let i = 0; i < left.length; i += BLOCK) {
    const data = right ? enc.encodeBuffer(left.subarray(i, i + BLOCK), right.subarray(i, i + BLOCK)) : enc.encodeBuffer(left.subarray(i, i + BLOCK));
    if (data.length) parts.push(new Uint8Array(data));
    if (onProgress) onProgress(Math.min(0.99, i / left.length));
    await new Promise((r) => setTimeout(r, 0));
  }
  const tail = enc.flush(); if (tail.length) parts.push(new Uint8Array(tail));
  if (onProgress) onProgress(1);
  return new Blob(parts, { type: 'audio/mpeg' });
}

/**
 * Convert an audio File/Blob/ArrayBuffer to MP3, FLAC, or a lesser WAV.
 * @param {Blob|ArrayBuffer} input
 * @param {{format:'mp3'|'flac'|'wav', mono?:string, kbps?:number, sampleRate?:number, wavBits?:number, flacBits?:number}} opts
 * @param {(fraction:number)=>void} [onProgress]
 * @returns {Promise<{blob:Blob, ext:string, mime:string}>}
 */
/* What was DONE to the audio, as an EBU CodingHistory (Tech 3285) plus a plain-language
 * Description. Written into the WAV itself, because a filename is the first thing to be lost:
 * files get renamed, re-downloaded, and handed on, and the next person has only the bytes.
 *
 * ⚠ IT MUST NOT OVERSTATE OR UNDERSTATE. A 32-bit-float source written to 24-bit integer is a
 * FAITHFUL reduction (float32 carries a 24-bit mantissa) and standards accept it — calling that
 * "not archival" would be a lie in the cautious direction, and a researcher who sees a false
 * warning learns to ignore the true ones. Dropping to 16-bit IS genuine quantisation, and picking
 * or mixing channels IS an edit; those say so. Bit depth is also container, not resolution: a
 * phone ADC gives ~16 real bits whatever the file says, so the history states the CHAIN, never a
 * quality claim. See notes/audiotoolsandsettingsplan §0/§0b. */
function conversionHistory({ srcBits, srcChans, srcRate, outBits, outChans, mono }) {
  const lines = [];
  const src = srcBits ? `W=${srcBits}` : 'W=?';
  lines.push(`A=PCM,F=${srcRate || '?'},${src},M=${srcChans >= 2 ? 'stereo' : 'mono'},T=source as opened`);
  const acts = [];
  if (srcBits && outBits && outBits < srcBits) {
    acts.push(outBits >= 24 && srcBits === 32
      ? 'float-to-24-bit reduction (faithful)'
      : `requantised ${srcBits}-bit to ${outBits}-bit (irreversible)`);
  }
  /* ⚠ Only when the channel count ACTUALLY changed. 'auto' leaves a genuinely stereo file alone, and
   * claiming an edit that did not happen is the same failure as hiding one that did — it teaches the
   * reader that this line cannot be trusted either way. */
  if (mono && mono !== 'keep' && outChans < srcChans) acts.push(`channels: ${mono} (an edit, not a transfer)`);
  if (!acts.length) acts.push('re-wrapped, samples unchanged');
  lines.push(`A=PCM,F=${srcRate || '?'},W=${outBits},M=${outChans >= 2 ? 'stereo' : 'mono'},`
           + `T=DERIVED by FlexText Editor - ${acts.join('; ')}`);
  return lines.join('\n');
}

export async function convertAudio(input, opts = {}, onProgress) {
  const raw = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
  const srcFmt = detectFormat(raw);
  let chans, sampleRate;
  if (srcFmt === 'wav') {
    const w = parseWav(raw); chans = w.channels; sampleRate = w.sampleRate;
  } else {
    const AC = window.AudioContext || window.webkitAudioContext;
    const probe = new AC();
    let decoded;
    try { decoded = await probe.decodeAudioData(raw.slice(0)); } finally { probe.close().catch?.(() => {}); }
    sampleRate = decoded.sampleRate; chans = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) chans.push(decoded.getChannelData(c).slice());
  }
  // Source facts, captured BEFORE pickMono rewrites `chans` — the history describes what came in.
  const srcChans = chans.length;
  const srcBits = srcFmt === 'wav' ? ((readWavHeader(raw) || {}).bitsPerSample || null) : null;
  if (opts.mono && opts.mono !== 'keep') chans = pickMono(chans, opts.mono);

  const fmt = opts.format || 'mp3';
  if (fmt === 'wav') {
    /* ⚠ A CONVERTED WAV IS STAMPED AND RENAMED, BOTH (Seth, 2026-08-07). WAV is the one output that
     * can be mistaken for the master it came from — same extension, same look, and (before this)
     * the same filename, so a 24-bit reduction could sit in a folder beside its 32-bit source and
     * be indistinguishable. `derived` tells the caller to mark the name; the bext chunk is what
     * survives a rename, which is why both are needed rather than either. */
    const outBits = opts.wavBits || 16;
    const wav = encodeWav(chans, sampleRate, outBits);
    let out = wav;
    try {
      const stamped = wavWithBext(await wav.arrayBuffer(), {
        description: `DERIVED audio produced by the FlexText Editor converter - not the original file`,
        codingHistory: conversionHistory({ srcBits, srcChans, srcRate: sampleRate, outBits,
                                           outChans: chans.length, mono: opts.mono }),
      });
      out = new Blob([stamped], { type: 'audio/wav' });
    } catch { /* stamping is honesty, not correctness: never fail the conversion over it */ }
    return { blob: out, ext: 'wav', mime: 'audio/wav', derived: true };
  }
  if (fmt === 'flac') return { blob: await encodeFlac(chans, sampleRate, opts.flacBits || 24, onProgress), ext: 'flac', mime: 'audio/flac', derived: true };
  const dstRate = opts.sampleRate || 22050;
  chans = await resampleChannels(chans, sampleRate, dstRate);
  return { blob: await encodeMp3FromChannels(chans, dstRate, opts.kbps || 64, onProgress), ext: 'mp3', mime: 'audio/mpeg', derived: true };
}

// The valid DOWNWARD output options for a given source (never upscale). Returns an array of
// { value, format, wavBits|flacBits } the UI maps to labels; mono/rate/kbps are layered on in the modal.
export function validOutputs(srcFmt, srcBits) {
  if (srcFmt === 'wav') {
    const b = srcBits || 32, outs = [];
    for (const d of [24, 16]) if (d < b) outs.push({ value: 'wav' + d, format: 'wav', wavBits: d });
    if (b >= 24) outs.push({ value: 'flac24', format: 'flac', flacBits: 24 });
    outs.push({ value: 'flac16', format: 'flac', flacBits: 16 });
    outs.push({ value: 'mp3', format: 'mp3' });
    return outs;
  }
  // FLAC / MP3 / OGG / AIFF / unknown → lossy MP3 only (never offer WAV/FLAC from a non-WAV/lossy source —
  // that would be "fake lossless"). Re-encoding a lossy source to a smaller MP3 is the one valid downward move.
  return [{ value: 'mp3', format: 'mp3' }];
}
