/* preview.js — the audio-preview head: a WAV decimator the worker can afford.
 *
 * WHY THIS EXISTS (Seth, 2026-08-31): the panel's preview player should start "almost instantly"
 * on field bandwidth, and the crowd default format is 24-bit WAV — ~8 MB per minute. A real
 * OPUS/MP3 encode is off the table in a Worker (no codecs, and the CPU budget dies on
 * multi-minute audio), but PCM asks almost nothing: drop to mono, 8-bit, ~8 kHz with a box
 * average, and a 30-second head is ~240 KB of "telephone quality" — exactly right for answering
 * "what is this recording?", and never touching the archival original.
 *
 * ⚠ PURE AND NODE-TESTABLE, like drive-object.js and for the same reason: the serve path needs
 * real Drive and cannot run on the hermetic rig, so the transform lives here as plain functions
 * over Uint8Arrays and test/preview-decimator.test.mjs exercises them against synthetic WAVs.
 * Nothing Cloudflare-specific in this file.
 *
 * ⚠ PCM ONLY (format 1, 8/16/24/32-bit int). Float WAVs and anything else return null from the
 * parser or plan, and the caller falls back to serving the file's raw head — a preview must
 * degrade to "heavier", never to "wrong bytes". */

const le16 = (b, o) => b[o] | (b[o + 1] << 8);
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/* Scan the RIFF chunks in `head` (the file's first bytes; 512 is plenty for real recorders, which
 * put fmt+data straight after the RIFF header — but a LIST/bext chunk larger than the head makes
 * the data chunk unfindable, and that is a null, not a guess). */
export function parseWavHeader(head) {
  const b = head instanceof Uint8Array ? head : new Uint8Array(head || 0);
  if (b.length < 44) return null;
  const tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let off = 12;
  let fmt = null;
  while (off + 8 <= b.length) {
    const id = tag(off);
    const size = le32(b, off + 4);
    if (id === 'fmt ') {
      if (off + 8 + 16 > b.length) return null;
      fmt = {
        format: le16(b, off + 8),
        channels: le16(b, off + 10),
        sampleRate: le32(b, off + 12),
        bitsPerSample: le16(b, off + 22),
      };
    } else if (id === 'data') {
      if (!fmt) return null;
      return { ...fmt, dataOffset: off + 8, dataLength: size >>> 0 };
    }
    // Chunks are word-aligned; a zero/absurd size would spin forever — bail instead.
    if (!Number.isFinite(size) || size < 0) return null;
    off += 8 + size + (size % 2);
  }
  return null;   // data chunk not within the head — fall back rather than range-guess
}

/* The whole preview, decided up front: how many SOURCE bytes to pull from Drive, and exactly what
 * comes out — so the response can carry a true content-length before a single body byte exists. */
export function previewPlan(hdr, maxSeconds = 30, targetRate = 8000) {
  if (!hdr || hdr.format !== 1) return null;
  const { channels, sampleRate, bitsPerSample, dataOffset, dataLength } = hdr;
  if (!(channels >= 1 && channels <= 8)) return null;
  if (!(sampleRate >= 4000 && sampleRate <= 384000)) return null;
  if (![8, 16, 24, 32].includes(bitsPerSample)) return null;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = bytesPerSample * channels;
  const totalFrames = Math.floor(dataLength / blockAlign);
  const frames = Math.min(totalFrames, Math.floor(maxSeconds * sampleRate));
  if (frames <= 0) return null;
  const decim = Math.max(1, Math.round(sampleRate / targetRate));
  const outFrames = Math.floor(frames / decim);
  if (outFrames <= 0) return null;
  return {
    blockAlign, bytesPerSample, decim,
    srcStart: dataOffset,
    srcBytes: frames * blockAlign,
    outSampleRate: Math.round(sampleRate / decim),
    outFrames,
    outBytes: outFrames,             // 8-bit mono: one byte per output frame
  };
}

// Standard 44-byte PCM header for the 8-bit mono head the decimator emits.
export function wavPreviewHeader(plan) {
  const h = new Uint8Array(44);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) h[o + i] = s.charCodeAt(i); };
  const u32 = (o, v) => { h[o] = v & 255; h[o + 1] = (v >>> 8) & 255; h[o + 2] = (v >>> 16) & 255; h[o + 3] = (v >>> 24) & 255; };
  const u16 = (o, v) => { h[o] = v & 255; h[o + 1] = (v >>> 8) & 255; };
  w(0, 'RIFF'); u32(4, 36 + plan.outBytes); w(8, 'WAVE');
  w(12, 'fmt '); u32(16, 16); u16(20, 1); u16(22, 1);
  u32(24, plan.outSampleRate); u32(28, plan.outSampleRate /* byteRate: rate ×1ch ×1byte */);
  u16(32, 1 /* blockAlign */); u16(34, 8);
  w(36, 'data'); u32(40, plan.outBytes);
  return h;
}

/* Stateful streaming decimator: feed arbitrary chunk boundaries, get 8-bit unsigned mono out.
 * Box-averages every `decim` frames across all channels — a crude low-pass that keeps speech
 * intelligible without per-sample multiplies beyond the running sum. Emits at most plan.outBytes
 * in total, then swallows the rest (a ranged fetch may overshoot by a partial frame). */
export function makeDecimator(hdr, plan) {
  const { bytesPerSample } = plan;
  const { channels, bitsPerSample } = hdr;
  let carry = new Uint8Array(0);          // partial frame bytes between chunks
  let sum = 0, nFrames = 0;               // the box in progress
  let emitted = 0;

  // One frame at offset o of buf → signed mixdown in [-1, 1)-ish integer space (max-scaled).
  const frameValue = (buf, o) => {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const so = o + c * bytesPerSample;
      let v = 0;
      if (bitsPerSample === 8) v = (buf[so] - 128) << 8;                       // 8-bit is unsigned
      else if (bitsPerSample === 16) v = (buf[so] | (buf[so + 1] << 8)) << 16 >> 16;
      else if (bitsPerSample === 24) v = ((buf[so] | (buf[so + 1] << 8) | (buf[so + 2] << 16)) << 8 >> 8) >> 8;
      else v = ((buf[so] | (buf[so + 1] << 8) | (buf[so + 2] << 16) | (buf[so + 3] << 24)) >> 16);
      acc += v;                            // all forms scaled to ~16-bit signed range
    }
    return acc / channels;
  };

  const push = (buf) => {
    const out = [];
    let data = buf;
    if (carry.length) {
      data = new Uint8Array(carry.length + buf.length);
      data.set(carry, 0); data.set(buf, carry.length);
    }
    const whole = Math.floor(data.length / plan.blockAlign) * plan.blockAlign;
    for (let o = 0; o < whole; o += plan.blockAlign) {
      sum += frameValue(data, o);
      if (++nFrames === plan.decim) {
        if (emitted < plan.outBytes) {
          const avg = sum / plan.decim;                                  // ~16-bit signed
          out.push(Math.max(0, Math.min(255, Math.round(avg / 256) + 128)));
          emitted++;
        }
        sum = 0; nFrames = 0;
      }
    }
    carry = data.slice(whole);
    return new Uint8Array(out);
  };

  /* The tail: if the ranged fetch ends mid-box, round the last box out with what it holds — the
   * plan promised outBytes and a content-length already went on the wire, so pad if the source
   * came up short (silence at the midpoint, never garbage). */
  const flush = () => {
    const out = [];
    if (nFrames > 0 && emitted < plan.outBytes) {
      out.push(Math.max(0, Math.min(255, Math.round(sum / nFrames / 256) + 128)));
      emitted++;
      sum = 0; nFrames = 0;
    }
    while (emitted < plan.outBytes) { out.push(128); emitted++; }
    return new Uint8Array(out);
  };

  return { push, flush, get emitted() { return emitted; } };
}
