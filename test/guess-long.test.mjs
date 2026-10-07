/* ✨ AT ANY LENGTH (#93) — measured, the way the detector itself is measured in guess-splits.test.mjs:
 * synthetic peaks with pauses at KNOWN times, a long recording whose conditions DRIFT, and the same
 * asymmetric rule — zero spurious cuts, lenient recall — because a spurious boundary costs a join
 * plus a half-utterance line, and a missed one costs a keypress.
 *
 * What is being proved:
 *   1. up to one window the windowed call IS guessSplitsWithin, boundary for boundary — nothing
 *      changes for the recordings the detector always handled;
 *   2. past one window the recording is divided at REAL pauses near the ideal dividing points, and
 *      every window's boundaries are stitched into one ascending list with no sliver anywhere;
 *   3. on a recording whose noise floor rises half way through (a generator starts), the windowed
 *      guess finds the pauses the one-set-of-levels whole-file guess loses — the reason windows are
 *      worth their code rather than merely lifting the cap;
 *   4. a span with no pauses at all still answers [] honestly.
 *
 * Run: node --test test/guess-long.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { guessSplits, guessSplitsWithin, guessSplitsWindowed, GUESS_WINDOW_MS, GUESS_MIN_LINE_MS } from '../docs/js/segments.js';

const MPB = 0.5;                                         // ms per bucket, as ensurePeaks produces
const B = (ms) => Math.round(ms / MPB);
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/* A long recording from a script of [kind, ms, noise?] runs: 'speech' | 'silence'. `noise` is the
 * background level as a fraction of speech level and may change run by run — that is the drift. */
function makePeaks(script, { seed = 7, speechLevel = 0.6 } = {}) {
  const rand = rng(seed);
  const total = script.reduce((a, [, ms]) => a + ms, 0);
  const p = new Float32Array(B(total));
  let at = 0;
  for (const [kind, ms, noise = 0] of script) {
    const n = B(ms);
    for (let i = 0; i < n; i++) {
      const bg = noise * speechLevel * (0.5 + rand());
      if (kind === 'speech') {
        const syl = 0.45 + 0.55 * Math.abs(Math.sin((at + i) * MPB / 130));
        p[at + i] = Math.min(1, speechLevel * syl * (0.6 + 0.8 * rand()) + bg);
      } else p[at + i] = Math.min(1, bg);
    }
    at += n;
  }
  return { peaks: p, total };
}
/* The real boundaries: the middle of every INTERNAL silence. */
function truthOf(script) {
  const out = []; let at = 0;
  script.forEach(([kind, ms], i) => { if (kind === 'silence' && i > 0 && i < script.length - 1) out.push(at + ms / 2); at += ms; });
  return out;
}
/* Recall / precision against the truth, with a tolerance in ms. */
function score(cuts, truth, tol = 250) {
  const found = truth.filter((t) => cuts.some((c) => Math.abs(c - t) <= tol)).length;
  const spurious = cuts.filter((c) => !truth.some((t) => Math.abs(c - t) <= tol)).length;
  return { found, spurious, of: truth.length };
}
/* N utterances of `say` ms separated by `pause` ms, at a given noise level. */
function utterances(n, say, pause, noise) {
  const s = [];
  for (let i = 0; i < n; i++) { if (i) s.push(['silence', pause, noise]); s.push(['speech', say, noise]); }
  return s;
}

test('up to one window, the windowed call is guessSplitsWithin, boundary for boundary', () => {
  const script = utterances(40, 3000, 900, 0.05);                 // ~2.6 minutes
  const { peaks, total } = makePeaks(script);
  const whole = guessSplitsWithin(peaks, MPB, 0, total);
  assert.ok(whole.length > 30, `the fixture has findable pauses (${whole.length})`);
  assert.deepEqual(guessSplitsWindowed(peaks, MPB, 0, total), whole);
  // and the same inside a piece
  assert.deepEqual(guessSplitsWindowed(peaks, MPB, 20000, 90000), guessSplitsWithin(peaks, MPB, 20000, 90000));
  // the window is a parameter, so the stitch can be exercised on a short fixture
  assert.ok(total > 60000);
  const stitched = guessSplitsWindowed(peaks, MPB, 0, total, { windowMs: 60000 });
  assert.ok(stitched.length >= whole.length - 2 && stitched.length <= whole.length + 2, `windowed ≈ whole on a steady recording (${stitched.length} vs ${whole.length})`);
});

test('a 25-minute recording: zero spurious cuts, nearly every pause, no sliver, strictly ascending', () => {
  const script = utterances(380, 3000, 950, 0.08);                 // 380 × ~3.95s ≈ 25 minutes
  const { peaks, total } = makePeaks(script, { seed: 11 });
  assert.ok(total > 2 * GUESS_WINDOW_MS, `longer than two windows (${Math.round(total / 60000)} min)`);
  const cuts = guessSplitsWindowed(peaks, MPB, 0, total);
  const truth = truthOf(script);
  const { found, spurious, of } = score(cuts, truth);
  assert.equal(spurious, 0, `no boundary lands outside a real pause (${spurious} spurious)`);
  assert.ok(found >= of * 0.95, `nearly every pause found (${found}/${of})`);
  for (let i = 1; i < cuts.length; i++) assert.ok(cuts[i] - cuts[i - 1] >= GUESS_MIN_LINE_MS, `no sliver across the stitch at ${cuts[i]}`);
  assert.ok(cuts[0] >= GUESS_MIN_LINE_MS && total - cuts[cuts.length - 1] >= GUESS_MIN_LINE_MS, 'nor at either end');
  assert.ok(cuts.every((c, i) => i === 0 || c > cuts[i - 1]), 'ascending, unique');
  assert.ok(cuts.every((c) => c > 0 && c < total), 'strictly inside the recording');
});

test('the windows meet at real pauses near the ideal dividing points, never mid-word', () => {
  const script = utterances(380, 3000, 950, 0.08);
  const { peaks, total } = makePeaks(script, { seed: 11 });
  const k = Math.ceil(total / GUESS_WINDOW_MS);
  const truth = truthOf(script);
  const cuts = guessSplitsWindowed(peaks, MPB, 0, total);
  for (let j = 1; j < k; j++) {
    const ideal = (total * j) / k;
    // some boundary sits within one utterance of the ideal point, and it IS a real pause
    const near = cuts.filter((c) => Math.abs(c - ideal) <= 4000);
    assert.ok(near.length, `a window edge near ${Math.round(ideal / 1000)}s`);
    assert.ok(near.every((c) => truth.some((t) => Math.abs(c - t) <= 250)), 'and it is a pause, not speech');
  }
});

test('drift: when the noise floor rises half way through, windows find what one set of levels loses', () => {
  // 12 minutes quiet, then a generator starts: the floor climbs to 45% of speech level for 12 minutes.
  const quiet = utterances(180, 3000, 950, 0.05), loud = utterances(180, 3000, 950, 0.45);
  const script = [...quiet, ['silence', 950, 0.45], ...loud];
  const { peaks, total } = makePeaks(script, { seed: 5 });
  const truth = truthOf(script);
  const whole = score(guessSplits(peaks, MPB, { durationMs: total }), truth);
  const windowed = score(guessSplitsWindowed(peaks, MPB, 0, total), truth);
  assert.equal(windowed.spurious, 0, `windowed: no spurious cuts (${windowed.spurious})`);
  assert.ok(windowed.found >= truth.length * 0.9, `windowed: nearly every pause (${windowed.found}/${truth.length})`);
  assert.ok(windowed.found >= whole.found, `and at least as many as one set of levels found (${windowed.found} ≥ ${whole.found})`);
});

test('no pauses at all: [] — the honest answer, at any length', () => {
  const { peaks, total } = makePeaks([['speech', 2 * GUESS_WINDOW_MS + 60000, 0.05]]);
  assert.deepEqual(guessSplitsWindowed(peaks, MPB, 0, total), []);
  assert.deepEqual(guessSplitsWindowed(peaks, MPB, 0, 0), []);
  assert.deepEqual(guessSplitsWindowed(null, MPB, 0, 1000), []);
});

test('the three callers all go through it, and nothing refuses on length any more', () => {
  const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const strips = rd('../docs/js/segment-strips.js'), app = rd('../docs/js/app.js'), i18n = rd('../docs/js/i18n.js');
  assert.match(strips, /function guessCuts\(dur\) \{\n\s*return guessSplitsWindowed\([^\n]*, 0, dur\);/, 'the whole-file guess (Cut tab, and the matcher via guessedBoundaries)');
  assert.match(strips, /const cuts = guessSplitsWindowed\([^\n]*, seg\.start, seg\.end\);/, 'the piece guess');
  assert.doesNotMatch(strips, /GUESS_MAX_MS/, 'the cap is gone from the strips');
  assert.doesNotMatch(app, /GUESS_MAX_MS|cut\.no\.guessLong/, 'and from the matcher');
  assert.doesNotMatch(i18n, /'cut\.no\.guessLong'|'cut\.no\.guessPieceLong'/, 'and its sentences from both dictionaries');
});
