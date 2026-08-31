/* THE PREVIEW DECIMATOR: synthetic WAVs in, telephone-quality heads out, byte-exactly as planned.
 *
 * The serve path cannot run on the hermetic rig (it needs real Drive), which is why the transform
 * lives in worker/src/preview.js as pure functions — and why THIS file is the whole safety story
 * for it. The properties that matter:
 *
 *   1. The plan's outBytes is a PROMISE: a content-length goes on the wire before any body byte,
 *      so push()+flush() must emit exactly outBytes for any chunking of the source — including a
 *      source that arrives short (padded with midpoint silence, never garbage).
 *   2. A constant input decodes to a constant output at the right level (24-bit −6 dBFS sine-less
 *      sanity: DC in, DC out) — the bit-depth conversions are where sign bugs live.
 *   3. Non-PCM, float, and absurd headers are refused (null), because the caller's fallback is
 *      "serve the raw head", and wrong bytes are worse than heavy ones.
 */
import { test } from 'node:test';
import { parseWavHeader, previewPlan, wavPreviewHeader, makeDecimator } from '../worker/src/preview.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

// Build a synthetic PCM WAV: `frames` frames of a constant 24-bit sample value, N channels.
function wav24(frames, channels, sampleRate, sampleValue) {
  const blockAlign = 3 * channels;
  const dataLen = frames * blockAlign;
  const b = new Uint8Array(44 + dataLen);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  const u32 = (o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; };
  const u16 = (o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; };
  w(0, 'RIFF'); u32(4, 36 + dataLen); w(8, 'WAVE');
  w(12, 'fmt '); u32(16, 16); u16(20, 1); u16(22, channels);
  u32(24, sampleRate); u32(28, sampleRate * blockAlign); u16(32, blockAlign); u16(34, 24);
  w(36, 'data'); u32(40, dataLen);
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) {
    const o = 44 + f * blockAlign + c * 3;
    b[o] = sampleValue & 255; b[o + 1] = (sampleValue >>> 8) & 255; b[o + 2] = (sampleValue >>> 16) & 255;
  }
  return b;
}

test('preview decimator', () => {
  console.log('\nparse + plan on a real-shaped 48kHz stereo 24-bit WAV');
  const src = wav24(48000, 2, 48000, 0x200000);   // 1 s, constant +25% FS
  const hdr = parseWavHeader(src.slice(0, 512));
  ok(!!hdr && hdr.sampleRate === 48000 && hdr.channels === 2 && hdr.bitsPerSample === 24,
     'header parses (48k / stereo / 24-bit)');
  const plan = previewPlan(hdr, 30, 8000);
  ok(!!plan && plan.decim === 6 && plan.outSampleRate === 8000,
     `decimation 6:1 to 8 kHz (got ${plan && plan.decim}:1 @ ${plan && plan.outSampleRate})`);
  ok(plan.srcBytes === 48000 * 6 && plan.outBytes === 8000,
     'one second in = 8000 preview bytes out');

  console.log('\nthe emitted byte count equals the promised content-length, chunked arbitrarily');
  {
    const d = makeDecimator(hdr, plan);
    const body = src.slice(plan.srcStart, plan.srcStart + plan.srcBytes);
    let total = 0;
    for (let o = 0; o < body.length; o += 733) total += d.push(body.slice(o, o + 733)).length;   // deliberately unaligned chunks
    total += d.flush().length;
    ok(total === plan.outBytes, `exactly outBytes emitted (${total}/${plan.outBytes})`);
  }

  console.log('\nlevels survive the bit-depth walk (DC in → DC out)');
  {
    const d = makeDecimator(hdr, plan);
    const body = src.slice(plan.srcStart, plan.srcStart + plan.srcBytes);
    const out = [];
    for (let o = 0; o < body.length; o += 4096) out.push(...d.push(body.slice(o, o + 4096)));
    out.push(...d.flush());
    // +25% FS 24-bit → ~ +32 above the 8-bit midpoint of 128.
    const mid = out[Math.floor(out.length / 2)];
    ok(mid >= 156 && mid <= 164, `constant +25% FS lands near 160 (got ${mid})`);
  }

  console.log('\na short source pads with midpoint silence, never garbage');
  {
    const d = makeDecimator(hdr, plan);
    d.push(src.slice(plan.srcStart, plan.srcStart + 6000));   // far less than promised
    const tail = d.flush();
    ok(d.emitted === plan.outBytes, 'flush honours the promised length');
    ok(tail[tail.length - 1] === 128, 'the padding is midpoint (silence)');
  }

  /* ⚠ THE REGRESSION THIS FILE EXISTS FOR (staging, 2026-08-31). Our own crowd recordings are BWF:
   * a `bext` provenance chunk sits between `fmt ` and `data`, and in the first real file tested it
   * was 874 bytes, putting `data` at offset 918. The worker read a 512-byte head, found no data
   * chunk, and fell back to the heavy raw-head path for exactly the files the preview is FOR —
   * silently, because falling back is a legitimate outcome. The head is 4 KB now; this pins that a
   * bext-bearing WAV parses and plans. */
  console.log('\na BWF (bext chunk before data) — our own crowd format — parses within a 4 KB head');
  {
    const bextSize = 874;
    const plain = wav24(48000, 1, 48000, 0x100000);
    const withBext = new Uint8Array(plain.length + 8 + bextSize);
    withBext.set(plain.slice(0, 36), 0);                                 // RIFF + fmt
    'bext'.split('').forEach((c, i) => { withBext[36 + i] = c.charCodeAt(0); });
    new DataView(withBext.buffer).setUint32(40, bextSize, true);
    withBext.set(plain.slice(36), 36 + 8 + bextSize);                    // data chunk + samples
    const h = parseWavHeader(withBext.slice(0, 4096));
    ok(!!h, 'a 4 KB head finds data past an 874-byte bext');
    ok(!!h && h.dataOffset === 36 + 8 + bextSize + 8,
       `data offset is past the bext (${h && h.dataOffset}, expected ${36 + 8 + bextSize + 8})`);
    ok(!!previewPlan(h, 30, 8000), '...and it plans');
    ok(parseWavHeader(withBext.slice(0, 512)) === null,
       '...while the OLD 512-byte head could not — the bug, pinned');
  }

  console.log('\nrefusals fail closed');
  {
    ok(parseWavHeader(new Uint8Array(10)) === null, 'a too-short head is null');
    const floatWav = wav24(100, 1, 8000, 0); floatWav[20] = 3;   // format 3 = IEEE float
    ok(previewPlan(parseWavHeader(floatWav)) === null, 'float WAVs are refused (fallback serves raw head)');
    ok(parseWavHeader(Uint8Array.from({ length: 64 }, () => 77)) === null, 'non-RIFF bytes are null');
  }

  console.log('\nthe 44-byte header the client will actually decode');
  {
    const h = wavPreviewHeader(plan);
    const hh = parseWavHeader(new Uint8Array([...h, ...new Uint8Array(4)]));
    ok(!!hh && hh.sampleRate === plan.outSampleRate && hh.channels === 1 && hh.bitsPerSample === 8,
       'our own parser accepts our own header (8-bit mono at the planned rate)');
    ok(hh.dataLength === plan.outBytes, 'and its data length equals the plan');
  }

  console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
  if (fail) throw new Error(`${fail} check(s) failed`);
});
