/* THE v718 REVIEW'S ENGINE AND STRIP FINDINGS, each pinned (time-untimed v2) — the segments.js and
 * segment-strips.js half; the app.js half is time-untimed-review-app. Every test here failed on the
 * first v718 (10abc3a4).
 *
 *   · v714's seed is recognised after the corrections v714 itself offered — a seam drag, a ✂ at the
 *     playhead, a nudged cut, a split by words, a join, a shorter decode's clamp — modelled on v714's own
 *     code below, not on this model's per-edge versions of them (the first tests drove the drag the v717
 *     way, which is why they missed it); and a real line divided into equal halves is still not a seed;
 *   · a line this build stored with the spread's guess on one edge does not carry this build's own
 *     source word to an older build ('spread' → 'edit');
 *   · a Keep on a line a drag has made real is taken off; a split that holds no position is not left
 *     pending to eat the next Undo; ✨ over lines nobody timed asks nothing;
 *   · a join on the Baseline is ONE Undo item and clears the Redo (Seth's rule: one action, one Undo,
 *     one Redo). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as SEG from '../docs/js/segments.js';
import { ft } from './lib/timing-fixtures.mjs';
import { liftAll } from './lib/lift.mjs';
import { prepareDisplaySpans, restyleRows, retimeRow, splitPlace, splitPending, splitCancel, docSegments } from '../docs/js/segment-strips.js';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const STRIPS = readFileSync(new URL('../docs/js/segment-strips.js', import.meta.url), 'utf8');
const { isAligned, isEstimate, isPlaceholder, isPlaced, edgeGuessed, storableSegments, spreadUntimed, moveBoundary } = SEG;
const SET = { vernLang: 'fau', analLang: 'id' };
const times = (segs) => segs.map((s) => (isAligned(s) ? [s.start, s.end] : null));

/* v714's seed and v714's own edits of it, as v714 wrote them (segment-strips.js:934 and segments.js
 * moveBoundary / boundaryAtPlayhead / splitSegment / mergeSegments / normalizeSegments @ 4388ef0b): a
 * bare `timeEstimated` flag, deleted from the line AFTER a placed seam, kept on everything else. */
const v714 = {
  seed: (N, D) => Array.from({ length: N }, (_, k) => ({ start: Math.round((k * D) / N), end: Math.round(((k + 1) * D) / N), timeEstimated: true })),
  copy: (segs) => segs.map((s) => ({ ...s })),
  drag(segs, i, t) { const o = v714.copy(segs); o[i].end = t; o[i + 1].start = t; delete o[i + 1].timeEstimated; return o; },
  cut(segs, i, at) {                                       // Enter / ✂ at the playhead, inside the line
    const o = v714.copy(segs), cur = o[i];
    const first = { ...cur, end: at }, second = { ...cur, start: at };
    delete second.timeEstimated;
    o.splice(i, 1, first, second);
    return o;
  },
  nudged(segs, i, at) {                                    // the same, the playhead too near an edge
    const o = v714.copy(segs), cur = o[i];
    o.splice(i, 1, { ...cur, end: at, timeEstimated: true }, { ...cur, start: at, timeEstimated: true });
    return o;
  },
  words(segs, i, f) {                                      // split by word fraction, no playhead
    const o = v714.copy(segs), cur = o[i], at = Math.round(cur.start + f * (cur.end - cur.start));
    o.splice(i, 1, { ...cur, end: at, timeEstimated: true }, { ...cur, start: at, timeEstimated: true });
    return o;
  },
  join(segs, i) {
    const o = v714.copy(segs), a = o[i], b = o[i + 1];
    const m = { start: a.start, end: b.end };
    if (a.timeEstimated || b.timeEstimated) m.timeEstimated = true;
    o.splice(i, 2, m);
    return o;
  },
  clamp(segs, D) { const o = v714.copy(segs); o[o.length - 1].end = Math.min(o[o.length - 1].end, D); return o; },
};
// A text v714 stored: its lines (no offsets — a seed was never in a file), its spans, no v717 mark.
function stored714(segs, words = (k) => 'w w ' + k) {
  const doc = ft.makeDoc(SET);
  ft.reconcileBaseline(doc, segs.map((_, k) => words(k)), { flatSegments: true });
  doc.segments = JSON.parse(JSON.stringify(segs));
  delete doc.timeEdges;
  return doc;
}
// Opened on a device that decodes D (every tab draws through prepareDisplaySpans), and exported unopened.
function drawn(doc, D) {
  const w = { stamped: 0 };
  prepareDisplaySpans(doc, { getParagraphs: ft.getBaselineParagraphs, getDocId: () => 'd', durationMs: D,
    persist() { w.stamped++; }, persistQuiet() {}, keepInSync() {} });
  return { segs: doc.segments, stamped: w.stamped };
}
const exportedTimes = (doc) => ft.spansForExport(JSON.parse(JSON.stringify(doc))).filter(isAligned).length;
const kinds = (segs) => segs.map((s) => (isPlaceholder(s) ? 'ph' : isPlaced(s) ? (isEstimate(s) ? 'est' : 'real') : 'none'));

test('v714 seeds a user had begun correcting IN v714 are recognised — only the corrected lines keep a time', () => {
  for (const N of [8, 20, 60]) {
    const D = 3500 * N;
    const seed = v714.seed(N, D);
    for (const dec of [D - 70, D, D + 70]) {
      // ONE SEAM DRAGGED (v714 kept the flag on line 3 and deleted it from line 4)
      const t = seed[3].end + 500;
      const dragged = stored714(v714.drag(seed, 3, t));
      const unopened = exportedTimes(dragged);
      const k = kinds(drawn(dragged, dec).segs);
      assert.deepEqual(k.slice(0, 3), ['ph', 'ph', 'ph'], `N=${N} D=${dec}: the seed before the drag is untimed again`);
      assert.equal(k[3], 'est', 'the line before the seam keeps an estimate…');
      assert.ok(edgeGuessed(dragged.segments[3], 0) && !edgeGuessed(dragged.segments[3], 1) && dragged.segments[3].end === t,
        '…guessed at its start, real at the dragged seam — as a drag on a placeholder leaves it today');
      assert.equal(k[4], 'real', 'the line after the seam: v714 made it the user\'s, and it stays theirs');
      assert.ok(k.slice(5).every((x) => x === 'ph'), `N=${N} D=${dec}: every seed line after it is untimed again: ${k.slice(5).join(',')}`);
      assert.equal(exportedTimes(dragged), 2, 'two lines exported with times — not the whole seed');
      assert.equal(unopened, 2, '…and the same from a record nobody reopened (sent from the list, auto-backup)');
    }
  }
});

test('…after a ✂ at the playhead, a nudged cut, a split by words, a join and a shorter decode\'s clamp', () => {
  const N = 20, D = 70000, seed = v714.seed(N, D);
  const cut = stored714(v714.cut(seed, 7, seed[7].start + 1300));
  const kc = kinds(drawn(cut, D).segs);
  assert.equal(kc.length, N + 1);
  assert.deepEqual([kc[7], kc[8]], ['est', 'real'], 'the cut line: its first piece guessed at its start, its second the user\'s');
  assert.equal(kc.filter((x) => x === 'ph').length, N - 1, 'every other line untimed again');

  for (const [label, segs] of [['a nudged cut', v714.nudged(seed, 5, seed[5].start + 60)], ['a split by words', v714.words(seed, 5, 0.4)],
    ['a join', v714.join(seed, 10)], ['a clamp to a decode 70 ms short', v714.clamp(seed, D - 70)]]) {
    const doc = stored714(segs);
    const k = kinds(drawn(doc, D - 70).segs);
    assert.ok(k.every((x) => x === 'ph'), `${label}: nothing anybody placed, so every line is untimed: ${k.join(',')}`);
    assert.equal(exportedTimes(stored714(segs)), 0, `${label}: and none of it exported as a time`);
  }

  // all of it at once, on a long text
  let all = v714.seed(60, 210000);
  all = v714.drag(all, 12, all[12].end - 900);
  all = v714.cut(all, 30, all[30].start + 2000);
  all = v714.join(all, 44);
  all = v714.words(all, 50, 0.5);
  all = v714.clamp(all, 210000 - 70);
  const doc = stored714(all);
  const k = kinds(drawn(doc, 210000 + 70).segs);
  assert.deepEqual(k.map((x, i) => (x === 'ph' ? null : [i, x])).filter(Boolean), [[12, 'est'], [13, 'real'], [30, 'est'], [31, 'real']],
    'only the drag\'s and the cut\'s lines keep times');
  assert.equal(exportedTimes(stored714(all)), 4);
});

test('a real text is not taken for a seed: a first line split into equal halves by words in v714 stays two estimates', () => {
  // cut by hand at the playhead: [0,4000] [4000,9000] [9000,15000] [15000,20000]; line 1 then split by words, half and half
  const doc = stored714(v714.words([[0, 4000], [4000, 9000], [9000, 15000], [15000, 20000]].map(([start, end]) => ({ start, end })), 0, 0.5));
  const segs = drawn(doc, 20000).segs;
  assert.deepEqual(kinds(segs), ['est', 'est', 'real', 'real', 'real']);
  assert.deepEqual(times(segs).slice(0, 2), [[0, 2000], [2000, 4000]], 'the halves keep their times (the first v718 dropped them)');
  assert.equal(exportedTimes(stored714(v714.words([[0, 4000], [4000, 9000], [9000, 15000], [15000, 20000]].map(([start, end]) => ({ start, end })), 0, 0.5))), 5);
  // and a middle line split three ways, equal, by words: estimates, as case 6 says
  let mid = [[0, 3000], [3000, 12000], [12000, 15000]].map(([start, end]) => ({ start, end }));
  mid = v714.words(mid, 1, 1 / 3); mid = v714.words(mid, 2, 1 / 2);
  assert.deepEqual(kinds(drawn(stored714(mid), 15000).segs), ['real', 'est', 'est', 'est', 'real']);
});

test('a line this build stores with the spread\'s guess on one edge carries a source older builds know', () => {
  const ph = spreadUntimed([{ timePending: true }, { timePending: true }, { timePending: true }, { timePending: true }], 8000);
  const dragged = moveBoundary(ph, 1, 4300).segments;
  assert.equal(dragged[1].estSource, 'spread', 'in memory: the spread\'s own tooltip');
  const stored = storableSegments(dragged);
  assert.deepEqual(stored.map((s) => s.estSource || null), [null, 'edit', 'edit', null],
    'stored: \'edit\' — v717 has no "seg.estTip.spread" and showed the raw key');
  assert.ok(isEstimate(stored[1]) && edgeGuessed(stored[1], 0) && !edgeGuessed(stored[1], 1), 'still the same estimate, edge for edge');
  assert.equal(dragged[1].estSource, 'spread', 'and the line on screen is not touched');
});

/* A row as the strips build it, enough of one for the restyle: a class list and its children. */
function fakeRow(classes, children = []) {
  const set = new Set(classes);
  const row = {
    children,
    classList: {
      contains: (c) => set.has(c), add: (...c) => c.forEach((x) => set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)),
      toggle: (c, on) => { if (on === undefined ? !set.has(c) : on) set.add(c); else set.delete(c); },
    },
    get classes() { return [...set]; },
  };
  children.forEach((ch) => { ch.remove = () => { row.children = row.children.filter((x) => x !== ch); }; });
  return row;
}
const keepBtn = () => ({ classList: { contains: (c) => c === 'seg-keep' } });

test('a Keep on a line a drag has made real is taken off (restyle and live retime alike)', () => {
  // line 1 of an all-untimed text, its right grip dragged: real from 0 (C0) to the dragged edge
  const segs = spreadUntimed([{ timePending: true }, { timePending: true }, { timePending: true }], 9000);
  const r = moveBoundary(segs, 0, 3400, { edge: 'end' });
  assert.ok(r.ok && isPlaced(r.segments[0]) && !isEstimate(r.segments[0]), 'line 1 is now somebody\'s time at both ends');
  const row = fakeRow(['seg-strip', 'seg-spread', 'has-keep'], [keepBtn()]);
  retimeRow(row, null, r.segments[0]);
  assert.equal(row.children.length, 0, 'the drag\'s live retime takes the dead Keep off');
  assert.ok(!row.classList.contains('has-keep'));
  const rows = [fakeRow(['seg-strip', 'has-keep'], [keepBtn()]), fakeRow(['seg-strip', 'seg-spread', 'has-keep'], [keepBtn()])];
  restyleRows(rows, r.segments, false);
  assert.equal(rows[0].children.length, 0, 'and so does the restyle on release');
  assert.equal(rows[1].children.length, 1, 'a line whose time is still a guess keeps its Keep');
});

test('a split that holds no position is not left pending, so the next Undo is not spent on it', () => {
  splitCancel();
  const r = splitPlace({ tab: 'gloss', i: 2 }, 'audio', 5000, { tiers: ['words', 'free'], commit() { throw new Error('nothing to commit'); }, render() {} });
  assert.equal(r, 'ignored', 'the audio tier this line does not carry is ignored…');
  assert.equal(splitPending(), null, '…and nothing is left behind for doUndo to cancel');
  assert.equal(splitCancel(), false);
});

test('✨ over a text whose lines nobody has timed replaces nothing anybody made, and asks nothing', async () => {
  const run = async (segs) => {
    const asked = [];
    const doc = { segments: segs, paragraphs: segs.map(() => ({})) };
    const f = new Function('SEG', 'env', `
      const { isPlaced, isAligned } = SEG;
      let cutDeps = { getDoc: () => env.doc, getParagraphs: () => env.doc.segments.map(() => ''), getPlayer: () => null,
        confirmReplace: async () => { env.asked.push('confirm'); return false; }, capture() {}, setParagraphs() {}, persist() {}, t: (k) => k };
      const peaksCache = { peaks: [1] };
      const guessMode = () => 'all', docHasWork = () => false, peaksDurationFor = () => 9000, cutSay = () => {}, renderCut = () => {};
      const cutSegs = () => env.doc.segments, cutGuessPiece = () => {}, guessCuts = () => [3000, 6000];
      const applyGuessedSplits = () => ({ ok: false, reason: 'none' });
      ${liftAll(STRIPS, ['cutGuessSplits'])}
      return cutGuessSplits;
    `)(SEG, { doc, asked });
    await f();
    return asked;
  };
  assert.deepEqual(await run(spreadUntimed([{ timePending: true }, { timePending: true }, { timePending: true }], 9000)), [],
    'three blank lines drawn in their gap: no "replace all of those cuts?"');
  assert.deepEqual(await run([{ start: 0, end: 4000 }, { start: 4000, end: 9000 }]), ['confirm'], 'real cuts are still asked about');
});

/* ── the Baseline join, through the editor's own Undo ──────────────────────────────────────────── */

test('a Baseline join (🔗, Backspace, Delete) is ONE Undo item and clears the Redo — one Undo, one Redo', () => {
  const doc = ft.makeDoc(SET);
  ft.reconcileBaseline(doc, ['w w a', 'w w b', 'w w c', 'w w d'], { flatSegments: true });
  doc.segments = [{ start: 0, end: 2000 }, { start: 2000, end: 4000 }, { start: 4000, end: 6000 }, { start: 6000, end: 8000 }];
  const rec = { id: 'j', doc };
  const api = new Function('ft', 'SEG', 'rec', 'docSegments', `
    const { getBaselineParagraphs, reconcileBaseline, reconcileBaselineWithOrigins } = ft;
    const { segmentsFollowLines, syncToLines, mergeSegments } = SEG;
    let current = rec, player = null, activeTab = 'baseline';
    const $ = () => null;
    const segmentationEnabled = () => true;
    const schedulePersist = () => {}, switchTab = () => {}, updateUndoButtons = () => {};
    const UNDO_CAP = 100;
    let undoStack = [], redoStack = [], fieldUndo = null;
    ${liftAll(APP, ['docCarriesTime', 'applyBaseline', 'docSnap', 'pushSnap', 'commitFieldUndo', 'captureUndo', 'applyUndoState'])}
    const splitCancel = () => false;
    function doUndo() { if (splitCancel()) return; commitFieldUndo(); const st = undoStack.pop(); if (st) applyUndoState(st, redoStack); }
    function doRedo() { const st = redoStack.pop(); if (st) applyUndoState(st, undoStack); }
    // segment-strips' join, lifted, with the strips' deps wired as the editor wires them (app.js initStrips)
    const deps = { getDoc: () => current.doc, getParagraphs: (d) => getBaselineParagraphs(d),
      setParagraphs: (d, p) => reconcileBaseline(d, p.length ? p : [''], { flatSegments: true }), persist() {}, capture: () => captureUndo() };
    const stripsLocked = () => false, stripsRefuse = () => {}, renderStrips = () => {}, focusStrip = () => {};
    const peaksCache = { durationMs: 0 };
    ${liftAll(STRIPS, ['mergeAt'])}
    return { mergeAt, captureUndo, doUndo, doRedo, get undo() { return undoStack.length; }, get redo() { return redoStack.length; } };
  `)(ft, SEG, rec, docSegments);
  const state = () => JSON.stringify([ft.getBaselineParagraphs(rec.doc), times(rec.doc.segments)]);
  // An edit, undone: its Redo is waiting.
  const s0 = state();
  api.captureUndo(); rec.doc.segments = [{ start: 0, end: 2300 }, { start: 2300, end: 4000 }, ...rec.doc.segments.slice(2)];
  api.doUndo();
  assert.equal(state(), s0);
  assert.deepEqual([api.undo, api.redo], [0, 1]);
  // The join.
  api.mergeAt(0, 1);
  const joined = state();
  assert.equal(ft.getBaselineParagraphs(rec.doc).length, 3);
  assert.deepEqual([api.undo, api.redo], [1, 0], 'one Undo item, and the stale Redo is gone (it used to UN-join the lines)');
  api.doUndo();
  assert.equal(state(), s0, 'one Undo: the four lines and their times, exactly');
  assert.deepEqual([api.undo, api.redo], [0, 1]);
  api.doRedo();
  assert.equal(state(), joined, 'one Redo: joined again');
  assert.deepEqual([api.undo, api.redo], [1, 0]);
});
