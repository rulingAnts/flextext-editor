/* convert.js — client-side audio conversion for task recordings.
 *
 * Researchers' recorders produce big files (often 32-bit stereo WAV); tasks
 * need small ones. This converts any decodable audio to MP3 entirely in the
 * browser (vendored lamejs encoder, LGPL — see js/vendor/lamejs.LICENSE):
 * decode via Web Audio, optional downmix to mono + resample via
 * OfflineAudioContext, then encode at the chosen bitrate. Works offline.
 */

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
