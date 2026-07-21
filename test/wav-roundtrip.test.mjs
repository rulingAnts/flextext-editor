/* Regression guard for the SHARED WAV parser.
 *
 * ⚠ WHY THIS EXISTS: convert.js is engine code. It ships to every PWA user, it is what the
 * recorder's own output is read back through, and it was edited while working on the DESKTOP
 * shell — a native-side concern reaching into shared code. That is exactly the crossing that must
 * not silently break the PWA, so the PWA's real writer is round-tripped through the real reader
 * here. Adding EXTENSIBLE support must not disturb the ordinary tags the PWA itself writes.
 *
 * Run: node test/wav-roundtrip.test.mjs
 */
import { encodeWav, reduceChannels } from '../docs/js/record-pcm.js';
import { parseWav, readWavHeader } from '../docs/js/convert.js';

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) fail++; };
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// A signal with exact-representable values, so a decode error shows up as a mismatch not rounding.
const N = 64;
const sig = Float32Array.from({ length: N }, (_, i) => ((i % 8) - 4) / 8);   // -0.5 .. 0.375

console.log('\nPWA writer -> shared reader (the path every field recording takes)');
for (const bits of [16, 24, 32]) {
  // encodeWav hands back a Blob (it feeds download/upload directly)
  const ab = await encodeWav([sig], 48000, bits).arrayBuffer();
  const h = readWavHeader(ab);
  const p = parseWav(ab);
  const got = p[0] || (p.channels && p.channels[0]);
  const tol = bits === 16 ? 1 / 32768 : 1e-6;
  ok(!!h, `${bits}-bit: header parses`);
  ok(h && h.bitsPerSample === bits, `${bits}-bit: depth preserved (got ${h && h.bitsPerSample})`);
  ok(h && h.sampleRate === 48000, `${bits}-bit: rate preserved`);
  ok(h && h.channels === 1, `${bits}-bit: channels preserved`);
  ok(h && h.frames === N, `${bits}-bit: frame count ${h && h.frames} === ${N}`);
  ok(h && !h.extensible, `${bits}-bit: NOT flagged extensible (PWA writes plain tags)`);
  ok(h && h.audioFormat === (bits === 32 ? 3 : 1), `${bits}-bit: format tag untouched (${h && h.audioFormat})`);
  ok(got && got.length === N && [...got].every((v, i) => near(v, sig[i], tol)),
     `${bits}-bit: samples round-trip bit-faithfully`);
}

console.log('\nEXTENSIBLE (what the desktop shell / ffmpeg writes)');
const mkExt = (subFmt, bits, write) => {
  const fmtSz = 40, dataSz = N * (bits / 8);
  const b = new ArrayBuffer(12 + 8 + fmtSz + 8 + dataSz), dv = new DataView(b);
  const s = (o, t) => [...t].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  s(0, 'RIFF'); dv.setUint32(4, b.byteLength - 8, true); s(8, 'WAVE');
  s(12, 'fmt '); dv.setUint32(16, fmtSz, true);
  dv.setUint16(20, 0xFFFE, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 48000, true); dv.setUint32(28, 48000 * (bits / 8), true);
  dv.setUint16(32, bits / 8, true); dv.setUint16(34, bits, true);
  dv.setUint16(36, 22, true); dv.setUint16(38, bits, true); dv.setUint32(40, 4, true);
  dv.setUint16(44, subFmt, true);
  s(12 + 8 + fmtSz, 'data'); dv.setUint32(12 + 8 + fmtSz + 4, dataSz, true);
  for (let i = 0; i < N; i++) write(dv, 12 + 8 + fmtSz + 8 + i * (bits / 8), i);
  return b;
};
const extF = mkExt(3, 32, (dv, o, i) => dv.setFloat32(o, sig[i], true));
const hF = readWavHeader(extF), pF = parseWav(extF);
const gF = pF[0] || (pF.channels && pF.channels[0]);
ok(hF.audioFormat === 3 && hF.extensible, 'float32: subformat resolved to IEEE float');
ok(gF && [...gF].every((v, i) => near(v, sig[i], 1e-6)),
   'float32: decoded as FLOAT (the old code read these bits as integers -> noise)');

const extI = mkExt(1, 24, (dv, o, i) => {
  const v = Math.max(-1, Math.min(1, sig[i])), u = Math.round(v * 0x7FFFFF) & 0xFFFFFF;
  dv.setUint8(o, u & 0xFF); dv.setUint8(o + 1, (u >> 8) & 0xFF); dv.setUint8(o + 2, (u >> 16) & 0xFF);
});
const hI = readWavHeader(extI), pI = parseWav(extI);
const gI = pI[0] || (pI.channels && pI.channels[0]);
ok(hI.audioFormat === 1 && hI.extensible && hI.bitsPerSample === 24, '24-bit: subformat resolved to PCM');
ok(gI && [...gI].every((v, i) => near(v, sig[i], 1e-5)), '24-bit: samples round-trip');

console.log('\npreview encode is non-destructive (the review listen must not touch the master)');
{
  // stopRecording() builds a preview WAV for the <audio> element at a DIFFERENT (cheaper) bit
  // depth than the take will be saved at; saveRecording() then re-encodes the SAME channels to
  // the archival format. If making a preview altered the samples, every saved recording would
  // carry that damage invisibly — the preview itself would still sound perfectly correct.
  const a = Float32Array.from(sig);
  const b = Float32Array.from(sig);
  const pristine24 = new Uint8Array(await encodeWav([b], 48000, 24).arrayBuffer());
  await encodeWav(reduceChannels([a]), 48000, 16).arrayBuffer();   // the preview, as app.js makes it
  const after24 = new Uint8Array(await encodeWav([a], 48000, 24).arrayBuffer());
  ok([...a].every((v, i) => v === sig[i]), 'preview encode leaves the captured samples untouched');
  ok(after24.length === pristine24.length && after24.every((v, i) => v === pristine24[i]),
     'archival encode is byte-identical whether or not a preview was made first');
  // Stereo goes through the same reduce step; it must not rewrite the channels either.
  const s0 = Float32Array.from(sig), s1 = Float32Array.from(sig, (v) => -v);
  await encodeWav(reduceChannels([s0, s1]), 48000, 16).arrayBuffer();
  ok([...s0].every((v, i) => v === sig[i]) && [...s1].every((v, i) => v === -sig[i]),
     'stereo: reduceChannels + preview leave both channels untouched');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASS: shared parser is intact for the PWA and the shell.\n');
process.exit(fail ? 1 : 0);
