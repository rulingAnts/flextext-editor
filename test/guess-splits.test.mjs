/* GUESS SPLITS — measured against recordings whose pauses we know, because opinions about a
 * threshold are worth nothing.
 *
 * The brief (plans/cut-tab.md) says the algorithm is easy and the THRESHOLD is the actual work: a
 * fixed amplitude cutoff tuned in a quiet room finds no pauses at all in a village recording with a
 * high noise floor. So this test synthesises peaks arrays — the same shape segment-strips' cache
 * holds, one max-abs value per ~0.5ms bucket — with pauses at KNOWN times, and measures what the
 * detector does with them:
 *
 *   found      how many real pauses got a boundary (recall)
 *   spurious   boundaries that are not near any real pause (precision) — the expensive kind
 *   worst      the worst distance, in ms, between a boundary and the middle of its pause
 *
 * ⚠ THE COST IS ASYMMETRIC and the assertions reflect it. A missed boundary costs one keypress; a
 * spurious one costs a join plus a line that is half an utterance. Every case below demands ZERO
 * spurious cuts, and is lenient about recall.
 *
 * Run: node test/guess-splits.test.mjs
 */
import { guessSplits, applyGuessedSplits, GUESS_MIN_GAP_MS, GUESS_MIN_LINE_MS } from '../docs/js/segments.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const MPB = 0.5;                       // ms per bucket, as ensurePeaks produces (2000 buckets/sec)
const B = (ms) => Math.round(ms / MPB);

/* A deterministic pseudo-random so the synthetic audio is stable run to run (Math.random would make
 * a failure unreproducible, which is worse than useless in a threshold test). */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/* Build a peaks array from a script of [kind, ms] pairs: 'speech' | 'silence' | 'gap' (a short
 * within-utterance closure). `noise` is the background level as a fraction of speech level. */
function makePeaks(script, { noise = 0.0, seed = 7, speechLevel = 0.6 } = {}) {
  const rand = rng(seed);
  const total = script.reduce((a, [, ms]) => a + ms, 0);
  const p = new Float32Array(B(total));
  let at = 0;
  for (const [kind, ms] of script) {
    const n = B(ms);
    for (let i = 0; i < n; i++) {
      const bg = noise * speechLevel * (0.5 + rand());
      if (kind === 'speech') {
        // Speech is spiky and syllabic: an envelope that dips between syllables but stays well up.
        const syl = 0.45 + 0.55 * Math.abs(Math.sin((at + i) * MPB / 130));
        p[at + i] = Math.min(1, speechLevel * syl * (0.6 + 0.8 * rand()) + bg);
      } else {
        p[at + i] = Math.min(1, bg);
      }
    }
    at += n;
  }
  return { peaks: p, durationMs: total };
}

/* Where the script says the real boundaries are: the middle of every INTERNAL silence block long
 * enough to be a line break.
 *
 * ⚠ The length test is not a convenience — it is the definition. A 90ms silence inside an utterance
 * is a consonant closure, and counting it as a boundary the detector "missed" would score the
 * detector for doing exactly the right thing (case (d) below exists to prove it does). Leading and
 * trailing silence are not boundaries either: the recording's own ends already bound the spans. */
function truthOf(script, minGap = GUESS_MIN_GAP_MS) {
  const out = [];
  let at = 0;
  script.forEach(([kind, ms], i) => {
    if (kind === 'silence' && ms >= minGap && i > 0 && i < script.length - 1) out.push(at + ms / 2);
    at += ms;
  });
  return out;
}

function score(script, opts) {
  const { peaks, durationMs } = makePeaks(script, opts);
  const truth = truthOf(script);
  const got = guessSplits(peaks, MPB, { durationMs });
  const used = new Set();
  let worst = 0, found = 0;
  for (const t of truth) {
    let best = -1, bestD = Infinity;
    got.forEach((g, i) => { const d = Math.abs(g - t); if (d < bestD && !used.has(i)) { bestD = d; best = i; } });
    if (best >= 0 && bestD <= 400) { used.add(best); found++; worst = Math.max(worst, bestD); }
  }
  return { got, truth, found, spurious: got.length - used.size, worst: Math.round(worst) };
}

const utterances = (n, { utt = 2200, gap = 700 } = {}) => {
  const s = [['silence', 400]];
  for (let i = 0; i < n; i++) { s.push(['speech', utt]); if (i < n - 1) s.push(['silence', gap]); }
  s.push(['silence', 400]);
  return s;
};

console.log('\n(a) a clean recording: 8 utterances separated by 700ms of near-silence');
{
  const r = score(utterances(8));
  console.log(`      found ${r.found}/${r.truth.length}, spurious ${r.spurious}, worst ${r.worst}ms`);
  ok(r.found === r.truth.length, 'every real pause found');
  ok(r.spurious === 0, 'and nothing invented');
  ok(r.worst <= 120, `boundaries land within 120ms of the middle of the pause (${r.worst}ms)`);
}

console.log('\n(b) THE VILLAGE CASE: the same, with a noise floor at 8% of speech level');
{
  const r = score(utterances(8), { noise: 0.08, seed: 11 });
  console.log(`      found ${r.found}/${r.truth.length}, spurious ${r.spurious}, worst ${r.worst}ms`);
  ok(r.found === r.truth.length, 'a relative threshold still finds every pause');
  ok(r.spurious === 0, 'and still invents nothing');
}

console.log('\n(c) a LOUD room: noise at 25% of speech level (generator, rain on tin)');
{
  const r = score(utterances(6, { gap: 800 }), { noise: 0.25, seed: 3 });
  console.log(`      found ${r.found}/${r.truth.length}, spurious ${r.spurious}, worst ${r.worst}ms`);
  ok(r.found >= r.truth.length - 1, 'nearly all pauses survive a heavy noise floor');
  ok(r.spurious === 0, 'and it still invents nothing — the expensive error stays at zero');
}

console.log('\n(d) stop closures INSIDE utterances must not be cut');
{
  // 80-150ms gaps are ordinary consonant closures. Only the 700ms breaks are line ends.
  const s = [['silence', 400]];
  for (let i = 0; i < 5; i++) {
    s.push(['speech', 900], ['silence', 90], ['speech', 800], ['silence', 140], ['speech', 900]);
    if (i < 4) s.push(['silence', 700]);
  }
  s.push(['silence', 400]);
  const r = score(s, { noise: 0.05, seed: 5 });
  console.log(`      found ${r.found}/${r.truth.length}, spurious ${r.spurious}, worst ${r.worst}ms`);
  ok(r.found === r.truth.length, 'the real line breaks are found');
  ok(r.spurious === 0, `and the 90/140ms closures are NOT cut (min gap ${GUESS_MIN_GAP_MS}ms)`);
}

console.log('\n(e) one unbroken 30s utterance — there is nothing to guess');
{
  const { peaks, durationMs } = makePeaks([['speech', 30000]], { noise: 0.05 });
  const got = guessSplits(peaks, MPB, { durationMs });
  ok(got.length === 0, `no boundaries invented in continuous speech (${got.length})`);
}

console.log('\n(f) 30s of near-silence — and a wall of noise');
{
  const quiet = makePeaks([['silence', 30000]], { noise: 0.02 });
  ok(guessSplits(quiet.peaks, MPB, { durationMs: quiet.durationMs }).length === 0,
     'silence yields no boundaries rather than one every 350ms');
  const wall = makePeaks([['speech', 30000]], { noise: 0.95, seed: 9 });
  ok(guessSplits(wall.peaks, MPB, { durationMs: wall.durationMs }).length === 0,
     'and neither does a recording with no dynamic range to speak of');
}

console.log('\n(g) short lines are never minted, however long the pauses around them');
{
  // 400ms utterances between 800ms pauses: every gap is real, but the LINES would be too short.
  const s = [['silence', 400]];
  for (let i = 0; i < 6; i++) { s.push(['speech', 400]); if (i < 5) s.push(['silence', 800]); }
  s.push(['silence', 400]);
  const { peaks, durationMs } = makePeaks(s, { noise: 0.05 });
  const got = guessSplits(peaks, MPB, { durationMs });
  let minLine = Infinity, prev = 0;
  for (const c of [...got, durationMs]) { minLine = Math.min(minLine, c - prev); prev = c; }
  ok(got.length === 0 || minLine >= GUESS_MIN_LINE_MS,
     `no line shorter than ${GUESS_MIN_LINE_MS}ms (shortest ${Math.round(minLine)}ms, ${got.length} cuts)`);
}

console.log('\n(h) degenerate inputs are answered, not thrown at');
{
  ok(guessSplits(null, MPB).length === 0, 'null peaks');
  ok(guessSplits(new Float32Array(0), MPB).length === 0, 'empty peaks');
  ok(guessSplits(new Float32Array(3), MPB).length === 0, 'three buckets');
  ok(guessSplits(new Float32Array(1000), 0).length === 0, 'no msPerBucket');
}

console.log('\napplyGuessedSplits refuses to re-cut a text that has words in it');
{
  const r = applyGuessedSplits(['sudah ada kata'], [1000, 2000], { duration: 3000 });
  ok(r.ok === false && r.reason === 'hasText', 'a transcribed text is refused, wholesale');
  ok(r.segments === null, 'and nothing is returned to apply by halves');
}

console.log('\n…and otherwise builds N spans and N EMPTY paragraphs, 1:1');
{
  const r = applyGuessedSplits([''], [1000, 2500], { duration: 4000 });
  ok(r.ok === true, 'accepted');
  ok(r.segments.length === 3 && r.paragraphs.length === 3, 'three spans, three paragraphs');
  ok(r.paragraphs.every((p) => p === ''), 'every paragraph empty — the words come later');
  ok(r.segments[0].start === 0 && r.segments[2].end === 4000, 'the spans cover the whole recording');
  ok(r.segments.every((s, i, a) => i === 0 || s.start === a[i - 1].end), 'and they abut exactly, no gaps');
  const bad = applyGuessedSplits([''], [], { duration: 4000 });
  ok(bad.ok === false && bad.reason === 'none', 'no boundaries ⇒ refused rather than a pointless no-op');
  ok(applyGuessedSplits([''], [1000], { duration: 0 }).reason === 'noAudio', 'and no duration ⇒ noAudio');
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASSED');
process.exit(fail ? 1 : 0);
