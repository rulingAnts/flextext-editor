/* Pre-roll ring buffer — drives the REAL PCMRecorder methods, not a copy of their logic.
 *
 * WHY THIS MATTERS: the record screen holds an open microphone. The ring buffer is what makes that
 * worth doing (it catches a speaker who starts before tapping record) and it is also what bounds
 * the cost — an unbounded buffer would grow for as long as the screen sits open and eventually
 * exhaust a cheap phone. Both properties are asserted here.
 *
 * Run: node test/preroll-ring.test.mjs
 */
import { PCMRecorder } from '../docs/js/record-pcm.js';

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

// A recorder positioned exactly as warm() leaves it, without needing an AudioWorklet.
const warmRec = (preRollSec = 2, sampleRate = 48000) => {
  const r = new PCMRecorder();
  r.sampleRate = sampleRate; r._preRollSec = preRollSec; r._armed = false;
  r._preChunks = null; r._preTotal = 0;
  return r;
};
const block = (start, n = 128) => Float32Array.from({ length: n }, (_, k) => start + k);

console.log('\nbounding (the record screen can sit open indefinitely)');
{
  const r = warmRec();
  const CH = 128, N = Math.floor(60 * 48000 / CH);        // 60s of audio
  for (let i = 0; i < N; i++) r._bufferPreRoll([block(i * CH, CH)]);
  const secs = r._preTotal / r.sampleRate;
  ok(secs >= 2 && secs < 2.02, `bounded at ~2s after 60s warm (got ${secs.toFixed(3)}s)`);
  ok(r._preTotal >= 96000, 'never holds LESS than requested — short means a lost first word');
  const last = r._preChunks[0][r._preChunks[0].length - 1];
  ok(last[last.length - 1] === N * CH - 1, 'retains the MOST RECENT audio, not the oldest');
}

console.log('\nhandover to the take');
{
  const r = warmRec();
  for (let i = 0; i < 2000; i++) r._bufferPreRoll([block(i * 128)]);
  const held = r._preTotal;
  const armed = r.arm();
  ok(Math.abs(armed.preRollSec - held / 48000) < 1e-9, 'arm() reports the pre-roll it handed over');
  ok(r.total === held, 'take total matches what the buffer held');
  ok(r.chanChunks[0].reduce((a, c) => a + c.length, 0) === r.total,
     'chunk lengths agree with total (encodeWav allocates from total)');
  ok(r.arm().preRollSec === 0, 'arm() is idempotent — a double tap cannot duplicate audio');
  ok(r._preChunks === null, 'ring buffer released to the take, not held twice');
}

console.log('\nsafety');
{
  const r = warmRec();
  for (let i = 0; i < 500; i++) r._bufferPreRoll([block(i * 128)]);
  r.cancel();
  ok(r._preChunks === null && r._preTotal === 0,
     'cancel() drops warm audio — it was captured before anyone chose to record');
  ok(r._armed === true, 'cancel() re-arms, so a later plain start() behaves normally');

  ok(new PCMRecorder()._armed === true,
     'a fresh recorder is ARMED by default (plain start() must not route into the ring buffer)');

  const st = warmRec();
  st._bufferPreRoll([block(0), block(1000)]);            // stereo
  ok(st._preChunks.length === 2, 'stereo keeps both channels');
  st._bufferPreRoll([block(2000)]);                      // channel count changes mid-warm
  ok(st._preChunks.length === 1 && st._preTotal === 128,
     'a channel-count change resets cleanly instead of misaligning channels');

  const z = warmRec(0);
  for (let i = 0; i < 50; i++) z._bufferPreRoll([block(i * 128)]);
  ok(z._preTotal === 128, 'preRollSec 0 keeps only the current block (pre-roll effectively off)');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASS: pre-roll is bounded, recent, and safe.\n');
process.exit(fail ? 1 : 0);
