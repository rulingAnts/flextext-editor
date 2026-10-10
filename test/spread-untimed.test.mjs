/* SETH'S B2: UNTIMED LINES IN THEIR GAP (v718 — plans/time-gaps-and-estimates.md D3, D4, §6.1).
 *
 * Seth, 2026-10-10: "For lines with no time slot, make sure the lines that DO have timing information
 * follow that timing information and only the ones with NO time information are evenly spaced in the
 * gap in between clear lines." segments.js spreadUntimed is that rule, pure:
 *   · a run of untimed lines shares its ROOM — the previous placed end (or 0) to the next placed start
 *     (or D) — evenly; each becomes a placeholder, guessed on every edge but a C0 one;
 *   · a room shorter than 400 ms a line leaves the run pending, marked "no room";
 *   · an all-untimed text is one room, [0, D]: exactly v714's round(kD/N), drawn and never written;
 *   · placed lines are never changed; a one-line text is left to D7; D unknown spreads nothing;
 *   · deterministic, so every draw of every tab is the same. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as SEG from '../docs/js/segments.js';
import { loadFixture, DURATION } from './lib/timing-fixtures.mjs';

const { spreadUntimed, isPlaceholder, isPlaced, isAligned, edgeGuessed, SPREAD_MIN_MS, storableSegments } = SEG;
const P = { timePending: true };
const times = (segs) => segs.map((s) => (isAligned(s) ? [s.start, s.end] : null));
const real = (start, end) => ({ start, end, guess: [null, null] });

test('EX1: "dua" gets 2000–5000; two lines in that room get 2000–3500 and 3500–5000', () => {
  const one = spreadUntimed([real(0, 2000), P, real(5000, 7000)], 7000);
  assert.deepEqual(times(one), [[0, 2000], [2000, 5000], [5000, 7000]]);
  assert.ok(isPlaceholder(one[1]) && !isPlaced(one[1]), 'the untimed line is a placeholder: drawn, nobody\'s time');
  assert.deepEqual([edgeGuessed(one[1], 0), edgeGuessed(one[1], 1)], [true, true], 'both its edges are the spread\'s guess');
  assert.equal(one[1].estSource, 'spread');
  const two = spreadUntimed([real(0, 2000), P, P, real(5000, 7000)], 7000);
  assert.deepEqual(times(two), [[0, 2000], [2000, 3500], [3500, 5000], [5000, 7000]]);
  assert.ok(isPlaceholder(two[1]) && isPlaceholder(two[2]));
});

test('a leading run gets [0, first start]; a trailing run gets [last end, D] — C0 edges stay real', () => {
  const lead = spreadUntimed([P, P, real(3000, 5000)], 9000);
  assert.deepEqual(times(lead), [[0, 1500], [1500, 3000], [3000, 5000]]);
  assert.equal(edgeGuessed(lead[0], 0), false, 'line 1 starts at 0, which is a fact');
  assert.equal(edgeGuessed(lead[1], 1), true, 'its end meets the timed line: the spread\'s guess');
  const trail = spreadUntimed([real(0, 3000), P, P], 9000);
  assert.deepEqual(times(trail), [[0, 3000], [3000, 6000], [6000, 9000]]);
  assert.equal(edgeGuessed(trail[2], 1), false, 'the last line ends at D, which is a fact');
  assert.equal(edgeGuessed(trail[1], 0), true);
});

test('a room under k × 400 ms stays pending, marked "no room" — nothing is squeezed in', () => {
  assert.equal(SPREAD_MIN_MS, 400, 'the shortest real text line in the corpus is 399 ms (D2)');
  const tight = spreadUntimed([real(0, 2000), P, P, real(2700, 5000)], 5000);
  assert.ok(tight[1].timePending && tight[1].noRoom && tight[2].timePending && tight[2].noRoom, '700 ms for two lines: no room');
  assert.deepEqual(times(tight), [[0, 2000], null, null, [2700, 5000]]);
  const fits = spreadUntimed([real(0, 2000), P, P, real(2800, 5000)], 5000);
  assert.ok(isPlaceholder(fits[1]) && isPlaceholder(fits[2]), '800 ms for two lines: exactly enough');
  // a last line past the decoded end (T53-like) leaves the trailing run no room at all
  const past = spreadUntimed([real(0, 87818), P], 87755);
  assert.ok(past[1].noRoom, 'a room that ends before it starts is no room');
  // and the mark is display-only: storage never sees it
  assert.deepEqual(storableSegments(tight)[1], { timePending: true });
});

test('D4: an all-untimed text is one room, [0, D] — exactly v714\'s round(kD/N)', () => {
  for (const [N, D] of [[4, 8000], [7, 60001], [60, DURATION.u60], [13, 12345]]) {
    const out = spreadUntimed(Array.from({ length: N }, () => ({ timePending: true })), D);
    const want = Array.from({ length: N }, (_, k) => [Math.round((k * D) / N), Math.round(((k + 1) * D) / N)]);
    assert.deepEqual(times(out), want, `N=${N}, D=${D}`);
    assert.ok(out.every(isPlaceholder), 'every line a placeholder');
    assert.deepEqual(out.map((s, k) => [edgeGuessed(s, 0), edgeGuessed(s, 1)]),
      out.map((_, k) => [k > 0, k < N - 1]), 'interior edges guessed, 0 and D not (C0)');
  }
  // N = 1 is D7's: a real whole-file span, laid down by the caller — spreadUntimed leaves it alone
  assert.deepEqual(spreadUntimed([{ timePending: true }], 9000), [{ timePending: true }]);
  // the skeleton: 60 lines in one FLEx paragraph, no times at all
  const u60 = loadFixture('u60');
  const out = spreadUntimed(Array.from({ length: u60.paragraphs.length }, () => ({ timePending: true })), DURATION.u60);
  assert.equal(out.length, 60);
  assert.ok(out.every(isPlaceholder));
  assert.equal(out[59].end, DURATION.u60);
});

test('placed spans are never changed (property), and the result is deterministic', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let trial = 0; trial < 300; trial++) {
    const n = 2 + Math.floor(rnd() * 12);
    const D = 2000 + Math.floor(rnd() * 60000);
    const segs = [];
    let t = 0;
    for (let k = 0; k < n; k++) {
      const len = 50 + Math.floor(rnd() * 3000);
      if (rnd() < 0.45) segs.push({ timePending: true });
      else segs.push(rnd() < 0.3 ? { start: t, end: t + len, guess: [rnd() < 0.5 ? t : null, null], estSource: 'edit' } : real(t, t + len));
      t += len + (rnd() < 0.5 ? Math.floor(rnd() * 900) : 0);
    }
    const a = spreadUntimed(segs, D), b = spreadUntimed(segs, D);
    assert.equal(JSON.stringify(a), JSON.stringify(b), 'deterministic');
    assert.equal(JSON.stringify(spreadUntimed(a, D)), JSON.stringify(a), 'idempotent: a second draw changes nothing');
    segs.forEach((s, k) => {
      if (isAligned(s)) {
        assert.deepEqual([a[k].start, a[k].end], [s.start, s.end], `trial ${trial}: placed line ${k} unchanged`);
        assert.ok(!isPlaceholder(a[k]));
      } else {
        assert.ok(isPlaceholder(a[k]) || (a[k].timePending && a[k].noRoom), `trial ${trial}: line ${k} is drawn or has no room`);
        if (k === 0 && isAligned(a[k])) assert.equal(edgeGuessed(a[k], 0), false, 'C0');
        if (k === n - 1 && isAligned(a[k])) assert.equal(edgeGuessed(a[k], 1), false, 'C0');
      }
    });
    // the input is not touched
    assert.ok(segs.every((s) => !('phAt' in s) && !('noRoom' in s)), 'the input array is never mutated');
  }
});

test('D unknown spreads nothing; a line holding the file\'s own times is not untimed (P4)', () => {
  assert.deepEqual(times(spreadUntimed([real(0, 2000), P, real(5000, 7000)], 0)), [[0, 2000], null, [5000, 7000]]);
  assert.deepEqual(times(spreadUntimed([P, P], undefined)), [null, null]);
  const held = { timePending: true, fileTimes: [2100, 2150] };   // an ELAN sliver the model cannot place
  const out = spreadUntimed([real(0, 2000), held, P, real(5000, 7000)], 7000);
  assert.deepEqual(out[1], held, 'it keeps its hold and its pending state');
  assert.deepEqual(times(out), [[0, 2000], null, [2000, 5000], [5000, 7000]], 'and takes no share of the room');
});

test('every pending span, whatever an older writer left on it, spreads to the same placeholder', () => {
  // The Segmenter stores a line without audio as { start: 0, end: 0, timePending: true }.
  const out = spreadUntimed([real(0, 1000), { start: 0, end: 0, timePending: true, timeEstimated: false }, real(3000, 4000)], 4000);
  assert.deepEqual(times(out), [[0, 1000], [1000, 3000], [3000, 4000]]);
  assert.ok(isPlaceholder(out[1]));
  assert.equal(out[1].timePending, undefined);
});
