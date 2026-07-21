/* Memory ceiling on the lossless path — drives the REAL PCMRecorder + the REAL cap functions.
 *
 * ⚠ WHY THIS EXISTS: the AudioWorklet take is held as Float32 in RAM until it is encoded. On a
 * cheap field phone a long take exhausts the renderer, and that failure is NOT catchable — the
 * browser kills the tab and the recording is gone with no message. There is no error path to test
 * after the fact, so the guard that prevents ever reaching that point is the thing under test.
 *
 * Two properties are asserted:
 *   1. stop() still returns the take BIT-EXACTLY now that concatFloat32 releases chunks while
 *      copying. Freeing memory mid-copy is exactly the kind of optimisation that silently drops or
 *      misorders a tail, and a corrupted archival master is worse than a large one.
 *   2. The cap accounts for CHANNEL COUNT, not elapsed time. A stereo device fills memory twice as
 *      fast at the same clock reading, and the recorder deliberately captures native channels, so
 *      a time-based cap would protect mono and let stereo die.
 *
 * Run: node test/record-memory.test.mjs
 */
import { PCMRecorder, pcmRamBudgetBytes, pcmCapStatus } from '../docs/js/record-pcm.js';

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) fail++; };
const MB = 1024 * 1024;

// A recorder positioned as start() leaves it, without needing an AudioWorklet.
const armedRec = (nch = 1, sampleRate = 48000) => {
  const r = new PCMRecorder();
  r.sampleRate = sampleRate; r._armed = true;
  r.nch = nch;
  r.chanChunks = Array.from({ length: nch }, () => []);
  r.total = 0;
  return r;
};
// Distinct, exactly-representable values so a dropped or reordered chunk cannot hide.
const block = (start, n = 128) => Float32Array.from({ length: n }, (_, k) => (start + k) / 65536);
const feed = (r, nblocks, n = 128) => {
  for (let i = 0; i < nblocks; i++) {
    for (let c = 0; c < r.nch; c++) r.chanChunks[c].push(block(i * n + c * 1e6, n));
    r.total += n;
  }
};

console.log('\nstop() is still bit-exact with chunk-freeing concat');
{
  const r = armedRec(2);
  const NB = 500, N = 128;
  feed(r, NB, N);
  const { channels } = await r.stop();
  ok(channels.length === 2, `both channels returned (got ${channels.length})`);
  ok(channels[0].length === NB * N, `length preserved (${channels[0].length} === ${NB * N})`);
  let bad = -1;
  for (let c = 0; c < 2 && bad < 0; c++) {
    for (let i = 0; i < NB * N; i++) {
      const want = (Math.floor(i / N) * N + (i % N) + c * 1e6) / 65536;
      if (channels[c][i] !== want) { bad = i; break; }
    }
  }
  ok(bad < 0, bad < 0 ? 'every sample of every channel is exact, in order'
                      : `sample ${bad} differs — concat dropped/reordered data`);
  ok(r.chanChunks === null, 'chunk lists released after stop()');
}

console.log('\nbytesHeld() reflects real channels, not elapsed time');
{
  const mono = armedRec(1), stereo = armedRec(2);
  feed(mono, 100); feed(stereo, 100);   // same DURATION on both
  ok(mono.bytesHeld() === 100 * 128 * 4, `mono: ${mono.bytesHeld()} bytes`);
  ok(stereo.bytesHeld() === mono.bytesHeld() * 2, 'stereo holds twice as much at equal duration');
  ok(stereo.bytesPerSecond() === 48000 * 2 * 4, 'stereo fills twice as fast per second');
  // The pre-roll ring is real memory too and must count toward the ceiling.
  const warm = armedRec(1); warm._preTotal = 48000 * 4;
  ok(warm.bytesHeld() === 48000 * 4 * 4, 'warm ring buffer counts toward the ceiling');
}

console.log('\nbudget scales with the device, and never below a usable floor');
{
  ok(pcmRamBudgetBytes(undefined) === 640 * MB, 'unknown device (Firefox/Safari) -> desktop assumption');
  // ⚠ THE FLOOR MUST NEVER RAISE A WEAK DEVICE'S BUDGET. The first version floored at 192 MB, which
  // gave a 0.5 GiB phone MORE than its own formula allowed (92 MB) — a ~480 MB peak on half a
  // gigabyte, handing the most fragile hardware the largest risk. A floor may only stop the budget
  // being absurdly small; it may never exceed what the device's own memory justifies.
  ok(pcmRamBudgetBytes(0.5) < 0.5 * 1024 * 0.15 * MB,
     'a 0.5 GiB phone is NOT floored up above what its own memory justifies');
  ok(pcmRamBudgetBytes(0.5) >= 48 * MB, 'but still gets a usable floor, not something absurd');
  ok(pcmRamBudgetBytes(2) > pcmRamBudgetBytes(1), 'more RAM -> more budget');
  ok(pcmRamBudgetBytes(64) === 1024 * MB, 'clamped at 1 GB however large the device claims to be');
  // The floor must still buy a usable take, or the guard becomes the problem it was meant to fix.
  const minsMono = pcmRamBudgetBytes(0.5) / (48000 * 1 * 4) / 60;
  // Against Seth's real distribution (1-10 min typical, 2-3 min average, 45 min rare) the cap must
  // not bite a normal take even on a weak phone. It is deliberately NOT generous: hitting the cap is
  // safe (the take stops to review intact) while guessing high kills the tab and loses the recording
  // outright, so this asserts "comfortably clears a typical take", not "as long as possible".
  ok(minsMono > 4, `a 0.5 GiB phone still clears a typical take (${minsMono.toFixed(1)} min mono @48k)`);
  const minsMono1G = pcmRamBudgetBytes(1) / (48000 * 4) / 60;
  ok(minsMono1G > 8, `a 1 GiB phone clears a long-ish take (${minsMono1G.toFixed(1)} min mono @48k)`);
}

console.log('\ncap status: warn before stop, and stop before the tab dies');
{
  const budgetBytes = 100, bytesPerSecond = 10;
  const at = (b) => pcmCapStatus({ bytesHeld: b, bytesPerSecond, budgetBytes });
  ok(at(0).level === 'ok' && at(50).level === 'ok', 'quiet well below the ceiling');
  ok(at(79).level === 'ok' && at(80).level === 'warn', 'warns at 80% — not at 79%');
  ok(at(99).level === 'warn', 'still only warning just below the ceiling');
  ok(at(100).level === 'stop' && at(200).level === 'stop', 'stops at and beyond the ceiling');
  ok(at(80).secsLeft === 2, `warn leaves usable notice (${at(80).secsLeft}s at 10 B/s)`);
  ok(at(150).secsLeft === 0, 'never reports negative time remaining');
  // A recorder that has not seen audio yet must not read as "full" and auto-stop instantly.
  ok(pcmCapStatus({ bytesHeld: 0, bytesPerSecond: 0, budgetBytes: 0 }).level === 'ok',
     'degenerate/unstarted input is inert, never an instant stop');
}

console.log('\nend to end: a stereo take on a low-end phone stops before it can OOM');
{
  const r = armedRec(2);
  const budgetBytes = pcmRamBudgetBytes(1);
  let stopped = 0;
  // 60 blocks of 128 frames ~= 0.16s of audio per step; run well past the ceiling.
  for (let step = 0; step < 4000; step++) {
    feed(r, 60);
    const s = pcmCapStatus({ bytesHeld: r.bytesHeld(), bytesPerSecond: r.bytesPerSecond(), budgetBytes });
    if (s.level === 'stop') { stopped = r.bytesHeld(); break; }
  }
  ok(stopped > 0, 'the ceiling was actually reached and reported');
  ok(stopped <= budgetBytes * 1.02, `stopped at ${(stopped / MB).toFixed(0)} MB, budget ${(budgetBytes / MB).toFixed(0)} MB`);
  const mins = stopped / r.bytesPerSecond() / 60;
  // Stereo halves the time for the same bytes — the reason this budgets on BYTES HELD rather than
  // elapsed seconds. A phone mic is normally mono; stereo here is the pessimistic case.
  ok(mins > 2, `low-end stereo still gets a real take (${mins.toFixed(1)} min)`);
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASS: the RAM ceiling holds and the take survives it.\n');
process.exit(fail ? 1 : 0);
