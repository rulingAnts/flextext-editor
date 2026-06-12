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
  // OfflineAudioContext both resamples and (for channels=1) downmixes.
  const oac = new OfflineAudioContext(
    channels, Math.max(1, Math.ceil(decoded.duration * sampleRate)), sampleRate);
  const src = oac.createBufferSource();
  src.buffer = decoded;
  src.connect(oac.destination);
  src.start();
  const rendered = await oac.startRendering();

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
