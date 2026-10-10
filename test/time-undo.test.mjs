/* ONE USER ACTION = ONE UNDO AND ONE REDO, for every edit path v717 touches (Seth's standing rule;
 * plans/time-gaps-and-estimates.md §6.1 time-undo, P5) — and each path keeps text and times together.
 *
 *   · an edge drag on the strips (makeBoundaryDrag → dragSeam): one capture at its first move, one save on
 *     release; across a pause only the grabbed edge moves (D11, case 13);
 *   · the plain text box (app.js applyBaseline, run for real with the focus-session undo around it):
 *     one undo item restores the lines AND their times, one redo puts both back (D10, case 1);
 *   · the Segmenter's verbs (mgMoveBoundary via mgBoundaryDrag, mgSplitSpan, mgJoinSpan, on the
 *     shared primitives): one mgCapture each, undone and redone whole.
 * The app.js functions are lifted from the source and run with their collaborators stubbed, so what is
 * tested is the code that ships, not a copy of it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFixture, ft } from './lib/timing-fixtures.mjs';
import { liftAll } from './lib/lift.mjs';
import * as SEG from '../docs/js/segments.js';
import { makeBoundaryDrag } from '../docs/js/segment-strips.js';

const { dragSeam, edgeGuessed, isEstimate, isAligned, MIN_SEGMENT_MS } = SEG;
const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const times = (segs) => segs.map((s) => (isAligned(s) ? [s.start, s.end] : null));

/* ── dragSeam, the rule every drag surface shares ─────────────────────────────────────────────── */

test('dragSeam: across a pause only the grabbed edge moves, and the mode is fixed at pick-up', () => {
  const segs = loadFixture('elan40').segments;
  assert.deepEqual(times(segs.slice(0, 2)), [[2230, 4153], [5346, 6846]], 'ELAN40 opens with a 1.2 s pause between lines 1 and 2');
  const before = [{ ...segs[0] }, { ...segs[1] }];
  // case 13: a 10 ms nudge of line 1's end
  assert.deepEqual(dragSeam(segs, before, 0, 4163, 'end'), { t: 4163, edge: 'end' });
  assert.deepEqual(times(segs.slice(0, 2)), [[2230, 4163], [5346, 6846]], 'line 2\'s start is unchanged — the pause is not swallowed');
  // pulled all the way against the next line, and then on: it stops there…
  dragSeam(segs, before, 0, 6000, 'end');
  assert.deepEqual(times(segs.slice(0, 2)), [[2230, 5346], [5346, 6846]], 'the end stops at the next start');
  // …and coming back does NOT drag line 2's start along (judged live, the two would now be one seam)
  dragSeam(segs, before, 0, 4500, 'end');
  assert.deepEqual(times(segs.slice(0, 2)), [[2230, 4500], [5346, 6846]], 'line 2 is still where it was');
  dragSeam(segs, before, 0, 4153, 'end');
  assert.equal(segs[0].end, 4153, 'back at the start point the edge is exactly where it was');
  assert.equal(dragSeam(segs, before, 0, 4153, 'end'), null, 'and a move that changes nothing reports nothing');
  // the LEFT grip of line 2 is line 2's start
  const b2 = [{ ...segs[0] }, { ...segs[1] }];
  assert.deepEqual(dragSeam(segs, b2, 0, 5000, 'start'), { t: 5000, edge: 'start' });
  assert.deepEqual(times(segs.slice(0, 2)), [[2230, 4153], [5000, 6846]], 'only line 2\'s start moved');
  dragSeam(segs, b2, 0, 100, 'start');
  assert.equal(segs[1].start, 4153, 'clamped at line 1\'s end — never across it');
  dragSeam(segs, b2, 0, 99999, 'start');
  assert.equal(segs[1].start, 6846 - MIN_SEGMENT_MS, 'and leaves line 2 a real line');
});

test('dragSeam: a seam with no pause moves both sides; the placed edge stops being a guess, the far edges keep theirs', () => {
  const segs = loadFixture('e78').segments;   // 78 estimates, contiguous
  const before = [{ ...segs[4] }, { ...segs[5] }];
  const r = dragSeam(segs, before, 4, segs[4].end + 300, 'start');
  assert.equal(r.edge, 'seam', 'contiguous: the grip side does not matter');
  assert.equal(segs[4].end, segs[5].start);
  assert.deepEqual([edgeGuessed(segs[4], 1), edgeGuessed(segs[5], 0)], [false, false], 'the dragged seam is real on both sides');
  assert.deepEqual([edgeGuessed(segs[4], 0), edgeGuessed(segs[5], 1)], [true, true], 'each line\'s other edge is still a guess…');
  assert.ok(isEstimate(segs[4]) && isEstimate(segs[5]) && segs[4].timeEstimated && segs[5].timeEstimated, '…so both stay dashed, and the flag says so');
});

/* ── the strips' drag consumer: one capture, one save ─────────────────────────────────────────── */

test('an edge drag is ONE undo and ONE save; one undo restores it, one redo re-applies it', () => {
  const doc = loadFixture('elan40');
  const original = structuredClone(doc.segments);
  const undo = [], redo = [];
  let captures = 0, saves = 0;
  const drag = makeBoundaryDrag({
    getSegs: () => doc.segments, getPlayer: () => null,
    capture: () => { captures++; undo.push(structuredClone(doc.segments)); redo.length = 0; },
    persist: () => { saves++; },
  });
  // R3: drag line 1's right edge by 10 ms, through several moves, as a finger does
  drag(0, null, 'start', 'end');
  for (const ms of [4155, 4158, 4161, 4163]) drag(0, ms, 'move', 'end');
  drag(0, null, 'end', 'end');
  assert.equal(captures, 1, 'one undo step for the whole drag, taken at its first move');
  assert.equal(saves, 1, 'one save, on release');
  assert.deepEqual(times(doc.segments.slice(0, 2)), [[2230, 4163], [5346, 6846]], 'line 2\'s start is unchanged');
  const after = structuredClone(doc.segments);
  // the editor's undo: the snapshot taken at capture comes back whole; redo re-applies the state undone
  redo.push(structuredClone(doc.segments)); doc.segments = undo.pop();
  assert.deepEqual(doc.segments, original, 'one undo restores every span exactly');
  undo.push(structuredClone(doc.segments)); doc.segments = redo.pop();
  assert.deepEqual(doc.segments, after, 'one redo re-applies it exactly');
  assert.equal(undo.length, 1);
});

/* ── the plain text box: applyBaseline, run for real ──────────────────────────────────────────── */

function textBox(rec) {
  const ta = { value: ft.getBaselineParagraphs(rec.doc).join('\n'), hidden: false };
  let saves = 0;
  const api = new Function('ft', 'SEG', 'rec', 'ta', 'onSave', `
    const { getBaselineParagraphs, reconcileBaseline, reconcileBaselineWithOrigins } = ft;
    const { segmentsFollowLines, syncToLines } = SEG;
    let current = rec, player = null, activeTab = 'baseline';
    const $ = (sel) => (sel === '#baseline-text' ? ta : null);
    const schedulePersist = () => onSave();
    // switchTab's FIRST step, as the real one does it (pinned below): leaving baseline applies the box.
    const switchTab = () => { if (activeTab === 'baseline' && !ta.hidden) applyBaseline(); };
    const updateUndoButtons = () => {}, splitCancel = () => false;
    const UNDO_CAP = 100;
    let undoStack = [], redoStack = [], fieldUndo = null;
    ${liftAll(APP, ['docCarriesTime', 'applyBaseline', 'docSnap', 'pushSnap', 'commitFieldUndo', 'applyUndoState', 'doUndo', 'doRedo'])}
    return {
      focus() { fieldUndo = { el: ta, startValue: ta.value, snap: docSnap() }; },   // the focusin handler
      blur() { applyBaseline(); commitFieldUndo(); },                              // blur, then focusout
      undo: doUndo, redo: doRedo, get undoDepth() { return undoStack.length; },
    };
  `)(ft, SEG, rec, ta, () => { saves++; });
  return { ta, api, saves: () => saves };
}
const lineTimes = (doc) => doc.paragraphs.map((p, i) => [p.segments[0].attrs.guid, isAligned(doc.segments[i]) ? [doc.segments[i].start, doc.segments[i].end] : null]);

test('the text box: a line inserted keeps every line\'s time (case 1), as ONE undo and ONE redo', () => {
  const rec = { id: 'x', doc: loadFixture('elan40') };
  const before = lineTimes(rec.doc);
  const beforeText = ft.getBaselineParagraphs(rec.doc);
  const box = textBox(rec);
  box.api.focus();
  const lines = box.ta.value.split('\n');
  lines.splice(6, 0, 'a line typed into the box');
  box.ta.value = lines.join('\n');
  box.api.blur();
  assert.equal(rec.doc.paragraphs.length, 41);
  assert.equal(rec.doc.segments.length, 41, 'text and times changed together');
  assert.equal(rec.doc.segments[6].timePending, true, 'the new line has no time — never a neighbour\'s');
  assert.deepEqual(lineTimes(rec.doc).filter((_, k) => k !== 6), before, 'all 40 original lines: the same phrase, the same time');
  assert.ok(!rec.timeSync, 'nothing was paired by position');
  assert.equal(box.saves(), 1, 'one save');
  assert.equal(box.api.undoDepth, 1, 'one undo step');
  const after = lineTimes(rec.doc);
  box.api.undo();
  assert.deepEqual(lineTimes(rec.doc), before, 'one undo restores the lines and their times');
  assert.deepEqual(ft.getBaselineParagraphs(rec.doc), beforeText);
  box.api.redo();
  assert.deepEqual(lineTimes(rec.doc).map((x) => x[1]), after.map((x) => x[1]), 'one redo puts both back');
  assert.equal(rec.doc.paragraphs.length, 41);
});

test('the real switchTab applies the box first — which is why an undo must refill the box before it', () => {
  const sw = liftAll(APP, ['switchTab']);
  assert.match(sw, /if \(activeTab === 'baseline' && !\$\('#view-baseline'\)\.hidden\) \{\s*\n\s*applyBaseline\(\);/, 'switchTab reconciles from the box on the way out');
  const undo = liftAll(APP, ['applyUndoState']);
  const refill = undo.indexOf("box.value = getBaselineParagraphs(current.doc).join('\\n')");
  assert.ok(refill > 0 && refill < undo.indexOf('switchTab(activeTab)'), 'the box is refilled before switchTab runs');
});

test('the text box: the 2026-08-16 replay — T53\'s 23 blank lines are kept, and every line keeps its time', () => {
  const rec = { id: 't', doc: loadFixture('t53') };
  const before = lineTimes(rec.doc);
  const box = textBox(rec);
  box.api.focus();
  const lines = box.ta.value.split('\n');
  lines[10] = lines[10] + ' w';   // a word added to one line
  box.ta.value = lines.join('\n');
  box.api.blur();
  assert.equal(rec.doc.paragraphs.length, 53, 'no blank line was filtered: they are timed silences');
  assert.deepEqual(lineTimes(rec.doc).map((x) => x[1]), before.map((x) => x[1]), 'every line keeps its own time, the edited one too');
  assert.equal(rec.doc.segments[52].end, 87818);
});

test('the text box: spans that did not match the lines even before the edit fall back to position — and SAY so', () => {
  const rec = { id: 's', doc: loadFixture('elan40') };
  rec.doc.segments = rec.doc.segments.slice(0, 39);   // a v714-era doc whose spans had drifted from its lines
  const box = textBox(rec);
  box.api.focus();
  box.ta.value += '\nanother line';
  box.api.blur();
  assert.equal(rec.doc.segments.length, rec.doc.paragraphs.length, 'counts agree again');
  assert.equal(rec.timeSync, true, 'the record says its times were paired by position — the banner turns red');
});

test('a doc with no times keeps the classic box\'s behaviour (blank lines dropped, no spans written)', () => {
  const doc = ft.makeDoc({ vernLang: 'fau', analLang: 'id' });
  ft.reconcileBaseline(doc, ['a b', 'c d']);
  const rec = { id: 'c', doc };
  const box = textBox(rec);
  box.api.focus();
  box.ta.value = 'a b\n\n\nc d\ne f';
  box.api.blur();
  assert.deepEqual(ft.getBaselineParagraphs(doc), ['a b', 'c d', 'e f']);
  assert.ok(!doc.segments || !doc.segments.length, 'no time list invented');
});

/* ── the Segmenter's verbs ───────────────────────────────────────────────────────────────────── */

function matcher(spans, playhead = null) {
  const calls = { draws: 0, toasts: [] };
  const api = new Function('SEG', 'MG0', 'calls', 'head', `
    const { dragSeam, splitSpanAt, mergeSpanPair, MIN_SEGMENT_MS } = SEG;
    let MG = MG0;
    const $ = () => null;
    const t = (k) => k;
    const toast = (m) => calls.toasts.push(m);
    const player = { playheadMs: () => head, pause() {}, clearSpan() {}, boundaryFocus() {}, boundaryLive() {} };
    function mgDraw() { calls.draws++; }
    function mgLiveBoundary() {}
    ${liftAll(APP, ['MG_UNDO_MAX', 'mgUndoStack', 'mgRedoStack', 'mgSnap', 'mgCapture', 'mgApply', 'mgUndoOnce', 'mgRedoOnce',
      'mgMoveBoundary', 'mgDragFrom', 'mgBoundaryDrag', 'mgGrabbedAt', 'mgSplitSpan', 'mgJoinSpan'])}
    return { get MG() { return MG; }, mgBoundaryDrag, mgSplitSpan, mgJoinSpan, undo: mgUndoOnce, redo: mgRedoOnce,
             get depth() { return mgUndoStack.length; } };
  `)(SEG, { docId: 'm', spans, lines: spans.map((_, i) => ({ id: 'ln' + i, phrases: [] })), selSpan: null, selLine: null }, calls, playhead);
  return { api, calls };
}
const mgTimes = (MG) => MG.spans.map((s) => (s.timePending ? null : [s.start, s.end]));

test('Segmenter: a row-edge drag across a pause moves only that edge — one undo, one redo', () => {
  const { api } = matcher([{ id: 'sp0', start: 2230, end: 4153 }, { id: 'sp1', start: 5346, end: 6846 }, { id: 'sp2', start: 7963, end: 10223 }]);
  const before = mgTimes(api.MG);
  api.mgBoundaryDrag(0, null, 'start', 'row', 'end');
  for (const ms of [4160, 6000, 4163]) api.mgBoundaryDrag(0, ms, 'move', 'row', 'end');
  api.mgBoundaryDrag(0, null, 'end', 'row', 'end');
  assert.deepEqual(mgTimes(api.MG).slice(0, 2), [[2230, 4163], [5346, 6846]], 'the next piece\'s start never moved, even after the end touched it');
  assert.equal(api.depth, 1, 'one undo step for the whole drag');
  const after = mgTimes(api.MG);
  api.undo(); assert.deepEqual(mgTimes(api.MG), before, 'one undo restores it');
  api.redo(); assert.deepEqual(mgTimes(api.MG), after, 'one redo re-applies it');
  // the dock's own mark (no source, no edge) is the END of the piece before it
  api.mgBoundaryDrag(1, null, 'start');
  api.mgBoundaryDrag(1, 7000, 'move');
  api.mgBoundaryDrag(1, null, 'end');
  assert.deepEqual(mgTimes(api.MG).slice(1, 3), [[5346, 7000], [7963, 10223]], 'a dock mark moves the end edge only');
});

test('Segmenter: ✂ at the playhead is real; ✂ at the midpoint is a GUESS (v714 saved it as measured) — each one undo', () => {
  const { api } = matcher([{ id: 'sp0', start: 0, end: 4000 }, { id: 'sp1', start: 4000, end: 8000 }], 1500);
  api.mgSplitSpan('sp0');
  assert.deepEqual(mgTimes(api.MG).slice(0, 2), [[0, 1500], [1500, 4000]]);
  assert.ok(!isEstimate(api.MG.spans[0]) && !isEstimate(api.MG.spans[1]), 'the playhead is the user\'s chosen time');
  assert.equal(api.depth, 1);
  api.undo();
  assert.deepEqual(mgTimes(api.MG), [[0, 4000], [4000, 8000]], 'one undo restores the piece');
  api.redo();
  assert.deepEqual(mgTimes(api.MG).slice(0, 2), [[0, 1500], [1500, 4000]], 'one redo cuts it again');

  const mid = matcher([{ id: 'sp0', start: 0, end: 4000 }, { id: 'sp1', start: 4000, end: 8000 }], null).api;
  mid.mgSplitSpan('sp1');
  const [a, b] = mid.MG.spans.slice(1);
  assert.deepEqual([a.end, b.start], [6000, 6000]);
  assert.deepEqual([edgeGuessed(a, 1), edgeGuessed(b, 0)], [true, true], 'the midpoint is our guess, on both sides of it');
  assert.deepEqual([edgeGuessed(a, 0), edgeGuessed(b, 1)], [false, false], 'the piece\'s own edges stay real');
});

test('Segmenter: a join drops the guessed inner seam and keeps real audio next to a "no audio" row — one undo, one redo', () => {
  const { api } = matcher([
    { id: 'sp0', start: 0, end: 3000 },
    { id: 'sp1', start: 3000, end: 5000, guess: [3000, 5000], estSource: 'edit' },
    { id: 'sp2', start: 5000, end: 9000, guess: [5000, null], estSource: 'edit' },
    { id: 'sp3', start: 0, end: 0, timePending: true },
  ]);
  api.mgJoinSpan('sp2');   // sp1 + sp2: the guessed 5000 seam disappears; sp1's guessed start stays
  const m = api.MG.spans[1];
  assert.deepEqual([m.start, m.end], [3000, 9000]);
  assert.deepEqual([edgeGuessed(m, 0), edgeGuessed(m, 1)], [true, false]);
  assert.equal(m.timeEstimated, true, 'still dashed: its start is still a guess');
  assert.equal(api.depth, 1);
  api.mgJoinSpan('sp3');   // the "no audio" row joined away: the real audio keeps its time (v714 made it pending)
  assert.deepEqual(mgTimes(api.MG), [[0, 3000], [3000, 9000]]);
  assert.equal(api.depth, 2, 'one step per join');
  api.undo();
  assert.deepEqual(mgTimes(api.MG), [[0, 3000], [3000, 9000], null], 'one undo per join');
  api.undo();
  assert.deepEqual(mgTimes(api.MG), [[0, 3000], [3000, 5000], [5000, 9000], null]);
  api.redo(); api.redo();
  assert.deepEqual(mgTimes(api.MG), [[0, 3000], [3000, 9000]], 'and one redo each');
});
