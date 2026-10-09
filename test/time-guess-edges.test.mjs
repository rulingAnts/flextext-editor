/* PER-EDGE GUESSES (v717 — plans/time-gaps-and-estimates.md §2, §6.1).
 *
 * A span's estimate status lives on its EDGES: `guess: [gs, ge]` holds the value each guessed edge
 * had, and an edge is a guess only while it still holds it. `timeEstimated` is a derived copy. These
 * pin what every operation does to the edges, the D11 drag rule on ELAN-shaped spans with pauses
 * between them, the migration of pre-v717 flags, and — over random sequences of every operation —
 * the two invariants nothing may break: `timeEstimated === isEstimate(span)` and C0 (the first
 * line's start and the last line's end are never guesses). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_SEGMENT_MS, isAligned, isEstimate, edgeGuessed, normalizeSegments, boundaryAtPlayhead, splitSegment,
  mergeSegments, moveBoundary, placeSeam, splitSpanAt, mergeSpanPair, applyGuessedSplitsWithin, cutAtPlayhead,
  joinWithPrevious, syncToLines, withGuesses,
} from '../docs/js/segments.js';
import { loadFixture } from './lib/timing-fixtures.mjs';

const edges = (s) => [edgeGuessed(s, 0), edgeGuessed(s, 1)];
const LINE = [{ start: 0, end: 4000 }, { start: 4000, end: 8000 }, { start: 8000, end: 12000 }];

test('the playhead places a REAL edge; a nudge, a word fraction and ✨ place guesses', () => {
  const real = boundaryAtPlayhead(LINE, 1, 6000);
  assert.deepEqual([edges(real[1]), edges(real[2])], [[false, false], [false, false]], 'a cut at the playhead claims nothing');
  assert.ok(!real.some(isEstimate));

  const nudged = boundaryAtPlayhead(LINE, 1, 4010);
  assert.equal(nudged[1].end, 4000 + MIN_SEGMENT_MS);
  assert.deepEqual([edges(nudged[1]), edges(nudged[2])], [[false, true], [true, false]], 'the nudged boundary is a guess on both sides, the outer edges are not');

  const frac = splitSegment(LINE, 1, { fraction: 0.25 });
  assert.equal(frac[1].end, 5000);
  assert.deepEqual([edges(frac[1]), edges(frac[2])], [[false, true], [true, false]], 'a fraction split guesses the new boundary only');

  const atHead = splitSegment(LINE, 1, { playheadMs: 6500, fraction: 0.25 });
  assert.ok(!isEstimate(atHead[1]) && !isEstimate(atHead[2]), 'the real playhead wins and is real');

  const sparkle = applyGuessedSplitsWithin(LINE, ['', '', ''], 1, [5000, 7000]);
  assert.equal(sparkle.ok, true);
  assert.deepEqual(sparkle.segments.slice(1, 4).map(edges), [[false, true], [true, true], [true, false]], '✨ boundaries are guesses; the piece keeps its own outer edges');
  assert.ok(sparkle.segments.slice(1, 4).every((s) => s.timeEstimated === true && s.estSource === 'edit'));

  const cut = cutAtPlayhead(LINE, ['', '', ''], 6000);
  assert.ok(cut.ok && !cut.segments.some(isEstimate), 'the Cut tab cuts at the playhead: real');
});

test('a merge takes its start-side guess from the left and its end-side guess from the right', () => {
  const guessed = boundaryAtPlayhead(LINE, 1, 4010);          // seam 1|2 is a guess
  const merged = mergeSegments(guessed, 1);
  assert.deepEqual([merged[1].start, merged[1].end], [4000, 8000]);
  assert.equal(isEstimate(merged[1]), false, 'the guessed inner boundary disappears with the boundary');
  assert.ok(!('timeEstimated' in merged[1]));

  const outer = mergeSpanPair({ start: 0, end: 1000, guess: [null, 1000] }, { start: 1000, end: 2000, guess: [1000, 2000], estSource: 'note' });
  assert.deepEqual(outer.guess, [null, 2000], 'a guessed far edge survives the join');
  assert.equal(outer.timeEstimated, true);
  assert.equal(outer.estSource, 'note', 'and so does where it came from');
  assert.deepEqual(mergeSpanPair({ start: 0, end: 1000 }, { timePending: true }), { start: 0, end: 1000 }, 'a plain span merged with a pending one is that span, nothing added');

  const joined = joinWithPrevious(guessed, ['a', 'b', 'c', 'd'], 2);
  assert.ok(joined.ok && !isEstimate(joined.segments[1]), 'the Cut tab\'s join is the same merge');
});

test('splitSpanAt and placeSeam: the primitives the Segmenter shares', () => {
  const [a, b] = splitSpanAt({ start: 0, end: 4000, guess: [null, 4000], estSource: 'note', phraseIndex: 3 }, 1500, { real: true });
  assert.deepEqual([a.start, a.end, b.start, b.end], [0, 1500, 1500, 4000]);
  assert.deepEqual([edges(a), edges(b)], [[false, false], [false, true]], 'the outer guesses stay where they were');
  assert.equal(a.phraseIndex, 3, 'non-time fields ride with both pieces');

  const live = [{ start: 0, end: 1000 }, { start: 1000, end: 2000, guess: [1000, 2000] }, { start: 2000, end: 3000, guess: [2000, null] }];
  const objA = live[1];
  placeSeam(live, 0, 1200, 'seam');
  assert.equal(live[1], objA, 'placeSeam moves the LIVE objects (the drag rows hold them by reference)');
  assert.deepEqual([live[0].end, live[1].start], [1200, 1200]);
  assert.deepEqual(edges(live[1]), [false, true], 'the placed edge is real; the far edge, which meets an estimate, stays a guess');
  assert.equal(live[1].timeEstimated, true);
  placeSeam(live, 1, 2100, 'seam');
  assert.deepEqual([edges(live[1]), edges(live[2])], [[false, false], [false, false]], 'placing the other seam makes it real too');
  assert.ok(!('timeEstimated' in live[1]) && !('timeEstimated' in live[2]));
});

test('D11 on ELAN40: a seam with a pause moves only the dragged edge; a contiguous seam moves both', () => {
  const segs = loadFixture('elan40').segments;
  assert.deepEqual([segs[0].start, segs[0].end, segs[1].start, segs[1].end], [2230, 4153, 5346, 6846], 'the fixture is ELAN-shaped: a pause between lines 1 and 2');
  const nudge = moveBoundary(segs, 0, 4163, { edge: 'end' });
  assert.equal(nudge.ok, true);
  assert.equal(nudge.edge, 'end');
  assert.equal(nudge.segments[0].end, 4163);
  assert.equal(nudge.segments[1].start, 5346, 'a 10 ms nudge of the end does not swallow the 1.2 s pause (case 13)');
  assert.equal(moveBoundary(segs, 0, 4163).segments[1].start, 5346, 'and that is the default for a caller that names no edge (a dock mark is the end edge)');
  assert.equal(moveBoundary(segs, 0, 9000, { edge: 'end' }).t, 5346, 'the end may close the pause, never pass the next start');
  const start = moveBoundary(segs, 0, 5000, { edge: 'start' });
  assert.deepEqual([start.segments[0].end, start.segments[1].start, start.edge], [4153, 5000, 'start']);
  assert.equal(moveBoundary(segs, 0, 1000, { edge: 'start' }).t, 4153, 'the start may close the pause from its side, never pass the previous end');
  assert.equal(moveBoundary(segs, 0, 6846, { edge: 'start' }).t, 6846 - MIN_SEGMENT_MS);
  assert.equal(moveBoundary(segs, 0, 4153, { edge: 'end' }).reason, 'same');
  const seam = moveBoundary([{ start: 0, end: 1000 }, { start: 1000, end: 2000 }], 0, 1300, { edge: 'end' });
  assert.deepEqual([seam.segments[0].end, seam.segments[1].start, seam.edge], [1300, 1300, 'seam'], 'where lines meet, both sides move together whatever was asked');
  assert.equal(segs[0].end, 4153, 'the input is not mutated');
});

test('pre-v717 flags are migrated per edge (pass 0)', () => {
  // A v714 seed: an even spread with every span flagged. Its interior edges are guesses; C0 is not.
  const seed = normalizeSegments([0, 1, 2, 3].map((k) => ({ start: k * 2500, end: (k + 1) * 2500, timeEstimated: true })));
  assert.deepEqual(seed.map(edges), [[false, true], [true, true], [true, true], [true, false]]);
  assert.ok(seed.every((s) => s.estSource === 'legacy' && s.timeEstimated === true));
  // A fraction split of a real line, between two real neighbours: the outer edges stay real.
  const frac = normalizeSegments([{ start: 0, end: 1000 }, { start: 1000, end: 1600, timeEstimated: true },
    { start: 1600, end: 2000, timeEstimated: true }, { start: 2000, end: 3000 }]);
  assert.deepEqual(frac.slice(1, 3).map(edges), [[false, true], [true, false]]);
  // A flagged merge (v714: "estimated if either half was") between real neighbours keeps the flag on
  // its non-C0 edges rather than silently becoming real — P4.
  const lone = normalizeSegments([{ start: 0, end: 1000 }, { start: 1000, end: 3000, timeEstimated: true }, { start: 3000, end: 4000 }]);
  assert.deepEqual(edges(lone[1]), [true, true]);
  assert.equal(lone[1].timeEstimated, true);
  // A span whose live guess explains its flag is never re-migrated…
  const live = normalizeSegments([{ start: 0, end: 1000, guess: [null, null] }, { start: 1000, end: 2000, guess: [1000, null], timeEstimated: true }]);
  assert.deepEqual(edges(live[1]), [true, false], 'its own guessed edge, and only that');
  /* …but a flag NO live edge explains was set by an older build (v717 keeps the two equal after every
   * operation): v716 copies a v717 span with {...s} and sets its own flag on a fraction-split piece,
   * which then carries the copied [null, null] beside `timeEstimated: true`. Read as real, that guess
   * went out as a measured time after a rollback and back (v717 review); it is migrated like any flag. */
  const rolled = normalizeSegments([{ start: 0, end: 1000, guess: [null, null] }, { start: 1000, end: 1600, guess: [null, null], timeEstimated: true },
    { start: 1600, end: 2000, guess: [null, null], timeEstimated: true }, { start: 2000, end: 3000, guess: [null, null] }]);
  assert.deepEqual(rolled.slice(1, 3).map(edges), [[false, true], [true, false]], 'the v716 split\'s seam is a guess on both sides');
  assert.ok(rolled[1].timeEstimated && rolled[2].timeEstimated && isEstimate(rolled[1]));
  assert.deepEqual(normalizeSegments(seed), seed, 'normalize is idempotent on migrated spans');
});

test('a demoted span carries no times and no estimate — only the times it held, for the export', () => {
  const out = normalizeSegments([{ start: 100, end: 150, timeEstimated: true, guess: [100, 150], estSource: 'note', phraseIndex: 1 }]);
  assert.deepEqual(out[0], { phraseIndex: 1, timePending: true, fileTimes: [100, 150] },
    'too short to be a line: pending, but its phrase\'s own times are written back while they still equal these');
  // Pushed out of existence by its neighbour (an edit's doing, not the file's): nothing is held.
  const pushed = normalizeSegments([{ start: 0, end: 1000 }, { start: 900, end: 1050, fileTimes: [1, 2] }]);
  assert.deepEqual(pushed[1], { timePending: true });
  // Already pending and held: normalize keeps the hold.
  assert.deepEqual(normalizeSegments([{ timePending: true, fileTimes: [5, 9] }])[0], { timePending: true, fileTimes: [5, 9] });
});

/* The property: over random sequences of every operation, after EVERY step —
 *   · timeEstimated is exactly isEstimate (present only when true);
 *   · no operation MAKES a guess of the first line's start or the last line's end (C0): an outer edge
 *     is a guess afterwards only if that very value was a guessed edge before (a deletion can bring an
 *     interior guess to the outside, and it stays the guess it was);
 *   · aligned spans are ordered and non-overlapping, and nothing is longer or shorter than the text. */
function rng(seed) { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
test('property: timeEstimated === isEstimate, and no operation makes an outer edge a guess (C0)', () => {
  let seen = 0, gapped = 0;
  for (let run = 0; run < 60; run++) {
    const r = rng(run + 1);
    // Half the runs start from one whole-file span, half from ELAN-shaped lines with pauses between.
    let segs = run % 2 ? [{ start: 0, end: 60000 }]
      : Array.from({ length: 8 }, (_, k) => ({ start: 2230 + k * 7000, end: 2230 + k * 7000 + 5000 }));
    let paras = segs.map(() => '');
    for (let step = 0; step < 40; step++) {
      const guessedBefore = new Set(segs.flatMap((x) => [edgeGuessed(x, 0) ? x.start : null, edgeGuessed(x, 1) ? x.end : null]).filter((v) => v != null));
      const n = segs.length, i = Math.floor(r() * n);
      const s = segs[i];
      const t = isAligned(s) ? Math.round(s.start + r() * (s.end - s.start)) : Math.round(r() * 60000);
      switch (Math.floor(r() * 9)) {
        case 0: segs = boundaryAtPlayhead(segs, i, t); paras.splice(i + 1, 0, ''); break;
        case 1: segs = boundaryAtPlayhead(segs, i, isAligned(s) ? s.start + 5 : t); paras.splice(i + 1, 0, ''); break;
        case 2: segs = splitSegment(segs, i, { fraction: r() }); paras.splice(i + 1, 0, ''); break;
        case 3: if (n > 1 && i + 1 < n) { segs = mergeSegments(segs, i); paras.splice(i, 2, ''); } break;
        case 4: { const m = moveBoundary(segs, i, t + Math.round((r() - 0.5) * 3000), { edge: r() < 0.5 ? 'end' : 'start' }); if (m.ok) segs = m.segments; break; }
        case 5: { const g = applyGuessedSplitsWithin(segs, paras, i, [t - 900, t, t + 900]); if (g.ok) { segs = g.segments; paras = g.paragraphs; } break; }
        case 6: { const live = withGuesses(segs); const m = moveBoundary(live, i, t); if (m.ok) { placeSeam(live, i, m.t, m.edge); segs = live; } break; }
        case 7: segs = syncToLines(segs, Math.max(1, n + (r() < 0.5 ? -1 : 1))); paras.length = segs.length; paras.fill('', 0); break;
        default: segs = normalizeSegments(segs.map((x) => (isAligned(x) && r() < 0.2 ? { ...x, timeEstimated: true, guess: undefined } : x)).map((x) => { if (x.guess === undefined) delete x.guess; return x; }));
      }
      assert.equal(paras.length, segs.length, `run ${run} step ${step}: one span per line`);
      let prevEnd = -Infinity;
      segs.forEach((x, k) => {
        assert.equal(!!x.timeEstimated, isEstimate(x), `run ${run} step ${step} span ${k}: the flag is the derived copy`);
        if (x.timeEstimated) assert.equal(x.timeEstimated, true);
        if (!isAligned(x)) return;
        assert.ok(x.start >= prevEnd, `run ${run} step ${step} span ${k}: ordered, no overlap`);
        prevEnd = x.end;
      });
      seen += segs.filter(isEstimate).length;
      gapped += segs.filter((x, k) => k > 0 && isAligned(x) && isAligned(segs[k - 1]) && x.start - segs[k - 1].end > 1).length;
      const first = segs[0], last = segs[segs.length - 1];
      assert.ok(!edgeGuessed(first, 0) || guessedBefore.has(first.start), `run ${run} step ${step}: no operation makes the first line's start a guess`);
      assert.ok(!edgeGuessed(last, 1) || guessedBefore.has(last.end), `run ${run} step ${step}: no operation makes the last line's end a guess`);
    }
  }
  assert.ok(seen > 500 && gapped > 50, `the sequences really exercised estimates (${seen}) and gapped seams (${gapped})`);
});
