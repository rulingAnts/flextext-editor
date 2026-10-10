/* PLACEHOLDERS ARE DEFINED BY THEIR VALUES (v718 — plans/time-gaps-and-estimates.md §2, cases 2, 6,
 * 10, 12; §6.1 time-placeholders).
 *
 * A placeholder is an untimed line drawn in its gap: `phAt` holds the values spreadUntimed gave it, and
 * it is one only while its values still equal those. So:
 *   · joining two placeholders, or dividing one at a point nobody placed (a word fraction, a nudge),
 *     keeps the status — a guess inside a guess is still nobody's time (case 2);
 *   · a cut at the playhead, a drag, ✨ — anything placed — makes real lines, or estimates where an edge
 *     is still the spread's guess, and those are stored and exported, marked (case 10: a copied flag
 *     cannot make a placed piece re-spread);
 *   · a real line divided three ways by fraction is three ESTIMATES, never placeholders (case 6);
 *   · v714's stored even spread is recognised from the spans themselves, whatever this device decodes
 *     (case 12, BM6). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as SEG from '../docs/js/segments.js';
import { loadFixture, DURATION, ft } from './lib/timing-fixtures.mjs';
import { timeStateClass, timeTipKey, needsMarks } from '../docs/js/segment-strips.js';

const { spreadUntimed, isPlaceholder, isPlaced, isAligned, isEstimate, edgeGuessed, mergeSegments, splitSegment,
        boundaryAtPlayhead, moveBoundary, applyGuessedSplitsWithin, mergeSpanPair, segmentsFollowLines, isV714Seed,
        seedsToPending, storableSegments, timingReport } = SEG;
const P = { timePending: true };
const times = (segs) => segs.map((s) => (isAligned(s) ? [s.start, s.end] : null));
const real = (start, end) => ({ start, end, guess: [null, null] });
// An all-untimed four-line text over 8 s, as every tab draws it: [0,2000] [2000,4000] [4000,6000] [6000,8000].
const drawn4 = () => spreadUntimed([P, P, P, P], 8000);

test('joining two placeholders gives a placeholder; dividing one by word fraction gives two (case 2)', () => {
  const j = mergeSegments(drawn4(), 1);
  assert.deepEqual(times(j), [[0, 2000], [2000, 6000], [6000, 8000]]);
  assert.ok(j.every(isPlaceholder), 'the joined line is still nobody\'s time');
  assert.equal(storableSegments(j).filter(isAligned).length, 0, '…so nothing of it is stored');
  const s = splitSegment(drawn4(), 1, { fraction: 0.25 });
  assert.deepEqual(times(s).slice(1, 3), [[2000, 2500], [2500, 4000]]);
  assert.ok(isPlaceholder(s[1]) && isPlaceholder(s[2]), 'a split nobody placed keeps them placeholders');
  // …and they re-spread like any untimed line: five lines now share [0, 8000]
  assert.deepEqual(times(spreadUntimed(s, 8000)), [[0, 1600], [1600, 3200], [3200, 4800], [4800, 6400], [6400, 8000]]);
  // a cut nudged inward (the playhead too near an edge) is not a placed point either
  const n = boundaryAtPlayhead(drawn4(), 1, 2050);
  assert.ok(isPlaceholder(n[1]) && isPlaceholder(n[2]), 'a nudged cut keeps them placeholders');
  // a placeholder joined to a line with no room is still untimed
  assert.ok(isPlaceholder(mergeSpanPair(drawn4()[1], { timePending: true, noRoom: true })));
});

test('case 10: a ✂ at 5000 inside a placeholder stays at 5000 after the re-spread', () => {
  const cut = boundaryAtPlayhead(drawn4(), 2, 5000);                       // the playhead: a placed point
  assert.deepEqual(times(cut).slice(2, 4), [[4000, 5000], [5000, 6000]]);
  assert.ok(isPlaced(cut[2]) && isPlaced(cut[3]), 'the two pieces are lines somebody timed');
  assert.ok(isEstimate(cut[2]) && edgeGuessed(cut[2], 0) && !edgeGuessed(cut[2], 1), 'the cut edge is real, the outer one still the spread\'s guess');
  const again = spreadUntimed(cut, 8000);
  assert.equal(again[2].end, 5000, 'the cut survives the next draw');
  assert.equal(again[3].start, 5000);
  // and the copy of the old phAt the pieces carry (a `{...s}` copy) cannot make them placeholders again
  assert.ok(Array.isArray(cut[2].phAt) && !isPlaceholder(cut[2]), 'status is the values, not the field');
  assert.equal(storableSegments(again).filter(isAligned).length, 2, 'only the two placed pieces are stored');
});

test('✨ at 4000 / 7000 inside a placeholder stays at 4000 / 7000: its pieces are estimates', () => {
  const segs = spreadUntimed([real(0, 2000), P, real(9000, 10000)], 10000);   // the placeholder is [2000, 9000]
  const r = applyGuessedSplitsWithin(segs, ['a', '', 'c'], 1, [4000, 7000]);
  assert.ok(r.ok);
  const out = spreadUntimed(r.segments, 10000);
  assert.deepEqual(times(out), [[0, 2000], [2000, 4000], [4000, 7000], [7000, 9000], [9000, 10000]]);
  assert.ok(out.slice(1, 4).every((s) => isPlaced(s) && isEstimate(s)), 'placed, dashed, stored and exported marked');
});

test('a drag makes only the two lines it touches placed (R6); every other line is untouched', () => {
  const segs = drawn4();
  const r = moveBoundary(segs, 1, 4300);
  assert.ok(r.ok && r.edge === 'seam');
  const out = spreadUntimed(r.segments, 8000);
  assert.deepEqual(times(out), [[0, 2000], [2000, 4300], [4300, 6000], [6000, 8000]]);
  assert.deepEqual(out.map(isPlaced), [false, true, true, false]);
  assert.ok(isEstimate(out[1]) && edgeGuessed(out[1], 0) && !edgeGuessed(out[1], 1), 'the dragged edge is real, the far one a guess');
  assert.deepEqual(storableSegments(out).map((s) => (isAligned(s) ? [s.start, s.end] : null)), [null, [2000, 4300], [4300, 6000], null],
    'storage: two lines with times (dashed), two without');
});

test('case 6: three equal fraction splits of a REAL line are estimates, never placeholders, and are exported', () => {
  let segs = [real(0, 9000)];
  segs = splitSegment(segs, 0, { fraction: 1 / 3 });
  segs = splitSegment(segs, 1, { fraction: 1 / 2 });
  assert.deepEqual(times(segs), [[0, 3000], [3000, 6000], [6000, 9000]]);
  assert.ok(segs.every((s) => isPlaced(s) && isEstimate(s)), 'estimates');
  assert.ok(segs.every((s) => !('phAt' in s)));
  const doc = ft.makeDoc({ vernLang: 'fau', analLang: 'id' });
  ft.reconcileBaseline(doc, ['a', 'b', 'c'], { flatSegments: true });
  doc.segments = segs;
  const xml = ft.serializeFlextext(doc, { vernLang: 'fau', analLang: 'id' }, { segTimes: true });
  assert.equal((xml.match(/begin-time-offset=/g) || []).length, 3, 'all three go out with their times');
});

test('the text box: a placeholder line divided by words stays two placeholders; joined lines stay one', () => {
  const doc = ft.makeDoc({ vernLang: 'fau', analLang: 'id' });
  ft.reconcileBaseline(doc, ['a b', 'c', 'd', 'e'], { flatSegments: true });
  doc.segments = drawn4();
  const origins = ft.reconcileBaselineWithOrigins(doc, ['a', 'b', 'c d', 'e'], { flatSegments: true });
  const out = segmentsFollowLines(drawn4(), origins);
  assert.equal(out.length, 4);
  assert.ok(out.every(isPlaceholder), `every line still untimed: ${JSON.stringify(times(out))}`);
});

test('case 12 / BM6: v714\'s stored seed is recognised from its own spans, whatever this device decodes', () => {
  // v714 seeded 6 lines over a recording ITS device decoded as 60 000 ms, flagged each span an estimate.
  const N = 6, D714 = 60000;
  const stored = Array.from({ length: N }, (_, k) => ({ start: Math.round((k * D714) / N), end: Math.round(((k + 1) * D714) / N), timeEstimated: true }));
  const step = D714 / N;
  assert.ok(stored.every((s, k) => isV714Seed(s, k, step)));
  assert.ok(!isV714Seed({ start: 0, end: 10000 }, 0, step), 'a real span is never a seed (no guess, no flag)');
  assert.ok(!isV714Seed({ ...stored[1], end: stored[1].end + 40, timeEstimated: true }, 1, step), 'a line somebody re-cut is not');
  for (const D of [D714 - 70, D714, D714 + 70]) {
    const back = spreadUntimed(seedsToPending(SEG.withGuesses(stored)), D);
    assert.ok(back.every(isPlaceholder), `D=${D}: all six drawn untimed again`);
    assert.equal(storableSegments(back).filter(isAligned).length, 0, `D=${D}: and none of it stored`);
  }
  // A line with offsets of its own is a FILE's estimate (E78), never a seed: it stays an estimate.
  const e78 = loadFixture('e78');
  const kept = seedsToPending(e78.segments, (k) => !!e78.paragraphs[k].segments[0].attrs['begin-time-offset']);
  assert.equal(kept.filter((s) => isPlaced(s) && isEstimate(s)).length, 78, 'E78 keeps its 78 estimates');
  // A drag between two seed lines leaves the rest recognisable: the mean length does not move.
  const dragged = SEG.withGuesses(stored);
  dragged[2].end = dragged[3].start = 23000; dragged[2].guess = [dragged[2].guess[0], null]; dragged[3].guess = [null, dragged[3].guess[1]];
  const after = seedsToPending(dragged);
  assert.deepEqual(after.map((s) => !!s.timePending), [true, true, false, false, true, true], 'the dragged pair is kept; the four untouched seeds go back to untimed');
  // and a single estimate is never a seed on its own
  assert.ok(isPlaced(seedsToPending([{ start: 0, end: 5000, guess: [null, 5000] }, real(5000, 9000)])[0]));
});

test('the timing report: a placeholder is a line with no time — never an estimate, never dense', () => {
  const texts = ['w w w', 'w w w w w w w w w', 'w w', 'w'];
  const all = timingReport(drawn4(), texts, { durationMs: 8000 });
  assert.deepEqual(all.items, [{ kind: 'noTimes', level: 'info', n: 4, spread: true }], 'an untimed text: one quiet item');
  const partly = spreadUntimed([real(0, 2000), P, P, real(2800, 5000)], 5000);
  const r = timingReport(partly, texts, { durationMs: 5000 });
  assert.equal(r.level, 'amber');
  assert.deepEqual(r.items.map((i) => [i.kind, i.n]), [['partly', 2]], 'two lines need timing; no estimate count, no dense line');
  const cramped = spreadUntimed([real(0, 2000), P, P, real(2700, 5000)], 5000);
  assert.deepEqual(timingReport(cramped, texts, { durationMs: 5000 }).items.map((i) => [i.kind, i.n, i.lines]),
    [['partly', 2, [1, 2]], ['noRoom', 2, [1, 2]]]);
});

test('the looks: spread (all untimed), needs timing (partly timed), no room — and their tooltips', () => {
  const ph = drawn4()[1];
  assert.equal(timeStateClass(ph, false, false), ' seg-spread', 'an untimed text: dashed, nothing more');
  assert.equal(timeStateClass(ph, false, true), ' seg-needs', 'a partly timed text: the exception, marked');
  assert.equal(timeStateClass({ timePending: true, noRoom: true }, false, true), ' seg-pending seg-noroom');
  assert.equal(timeStateClass({ timePending: true, noRoom: true }, false, false), ' seg-pending', 'marks off: plain ⋯');
  assert.equal(timeTipKey(ph, false, true), 'seg.needsTip');
  assert.equal(timeTipKey(ph, false, false), 'seg.spreadTip');
  assert.equal(timeTipKey({ timePending: true, noRoom: true }, false, true), 'seg.noRoomTip');
  assert.equal(needsMarks(drawn4(), true), false, 'no line placed: no per-line marks (P6)');
  assert.equal(needsMarks([real(0, 1000), ph], true), true);
  assert.equal(needsMarks([real(0, 1000), ph], false), false, 'the researcher\'s switch turns them off');
  const mostly = spreadUntimed([real(0, 1000), P, P, P], 9000);
  assert.equal(needsMarks(mostly, true), false, 'three of four untimed: a text being cut, not an exception — no marks');
  assert.deepEqual(timingReport(mostly, ['a', 'b', 'c', 'd'], { durationMs: 9000 }).items.map((i) => [i.kind, i.level, !!i.most]), [['partly', 'info', true]],
    '…and the banner is info, not amber');
  assert.equal(needsMarks(spreadUntimed([real(0, 1000), real(1000, 2000), P, P], 9000)), true, 'half: marked');
  // a dragged ex-placeholder is an estimate, with the spread's own tooltip
  const r = moveBoundary(drawn4(), 1, 4300).segments;
  assert.equal(timeStateClass(r[1], false, true), ' seg-est');
  assert.equal(timeTipKey(r[1], false, true), 'seg.estTip.spread');
});

test('U60: the all-untimed FLEx skeleton draws 60 even placeholders and stores none of them', () => {
  const doc = loadFixture('u60');
  assert.equal(doc.paragraphs.length, 60, 'one FLEx paragraph of 60 phrases, one line each');
  const out = spreadUntimed(Array.from({ length: 60 }, () => ({ timePending: true })), DURATION.u60);
  assert.ok(out.every(isPlaceholder));
  assert.deepEqual(storableSegments(out), Array.from({ length: 60 }, () => ({ timePending: true })));
});
