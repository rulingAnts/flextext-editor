/* THE v717 REVIEW'S UNDO, SWITCH AND OPENING FINDINGS, each pinned (time-truth v2) — the app.js half
 * of time-truth-review. The functions are lifted from the source and run with their collaborators
 * stubbed (test/lib/lift.mjs), so what is tested is the code that ships. Every test here failed on the
 * first v717 (04538a42). Seth's rule throughout: one user action = one Undo item and one Redo item. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFixture, ft } from './lib/timing-fixtures.mjs';
import { liftAll } from './lib/lift.mjs';
import * as SEG from '../docs/js/segments.js';
import { makeBoundaryDrag, timeStateClass, checkedLines } from '../docs/js/segment-strips.js';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const STRIPS = readFileSync(new URL('../docs/js/segment-strips.js', import.meta.url), 'utf8');
const { isAligned, isEstimate, edgeGuessed } = SEG;
const SET = { vernLang: 'fau', analLang: 'id' };
const state = (doc) => JSON.stringify({ t: ft.getBaselineParagraphs(doc), s: doc.segments, g: doc.paragraphs.map((p) => p.segments.map((s) => s.words.map((w) => w.gls || ''))) });

/* ── the editor's undo, with the plain box and its focus session ──────────────────────────────── */

function editor(rec, { seg }) {
  const ta = { value: ft.getBaselineParagraphs(rec.doc).join('\n'), hidden: false, id: 'baseline-text',
    closest(sel) { return sel.includes('#baseline-text') ? this : null; } };
  const api = new Function('ft', 'SEG', 'rec', 'ta', 'segOn', `
    const { getBaselineParagraphs, reconcileBaseline, reconcileBaselineWithOrigins } = ft;
    const { segmentsFollowLines, syncToLines } = SEG;
    let current = rec, player = null, activeTab = 'baseline';
    const $ = (sel) => (sel === '#baseline-text' ? ta : null);
    const segmentationEnabled = () => segOn;
    const schedulePersist = () => {};
    // switchTab's first step, as the real one does it: leaving baseline applies the box.
    const switchTab = () => { if (activeTab === 'baseline' && !ta.hidden) applyBaseline(); };
    const updateUndoButtons = () => {}, splitCancel = () => false;
    const UNDO_CAP = 100;
    let undoStack = [], redoStack = [], fieldUndo = null;
    ${liftAll(APP, ['UNDO_FIELDS', 'undoFieldFor', 'docCarriesTime', 'applyBaseline', 'docSnap', 'pushSnap', 'commitFieldUndo', 'captureUndo', 'applyUndoState', 'doUndo', 'doRedo'])}
    return {
      // setup()'s focusin handler, whose only gate is undoFieldFor (pinned below)
      focusin(target) { const el = undoFieldFor(target); if (!el) return; commitFieldUndo(); fieldUndo = { el, startValue: el.value, snap: docSnap() }; },
      blur() { applyBaseline(); if (fieldUndo && fieldUndo.el === ta) commitFieldUndo(); },   // blur, then focusout
      captureUndo, doUndo, doRedo, get undo() { return undoStack.length; }, get redo() { return redoStack.length; },
    };
  `)(ft, SEG, rec, ta, seg);
  return { ta, api };
}
function distinctDoc() {
  const doc = ft.makeDoc(SET);
  ft.reconcileBaseline(doc, ['alpha beta gamma', 'delta epsilon', 'zeta eta theta iota', 'kappa lambda', 'mu nu xi'], { flatSegments: true });
  doc.segments = [{ start: 0, end: 2000 }, { start: 2000, end: 3700, guess: [null, 3700], estSource: 'note', timeEstimated: true },
    { start: 3700, end: 6100, guess: [3700, null], estSource: 'note', timeEstimated: true }, { start: 6500, end: 8000 }, { start: 8000, end: 9000 }];
  return doc;
}
const EDITS = {
  join: (L) => [L[0], L[1] + ' ' + L[2], ...L.slice(3)],
  split: (L) => [L[0], L[1], 'zeta eta', 'theta iota', ...L.slice(3)],
  delete: (L) => [L[0], ...L.slice(2)],
  insert: (L) => [L[0], 'a new line', ...L.slice(1)],
  word: (L) => [L[0], 'delta epsilonx', ...L.slice(2)],
};

test('the focusin handler opens a session wherever undoFieldFor says, and nowhere else', () => {
  const from = APP.indexOf('// Focus-session boundaries for text undo');
  assert.ok(from > 0);
  const setup = APP.slice(from, APP.indexOf("document.addEventListener('focusout'", from));
  assert.match(setup, /const el = undoFieldFor\(e\.target\);\s*\n\s*if \(!el\) return;/, 'one gate');
  assert.doesNotMatch(setup, /segmentationEnabled\(\)/, 'no second gate on the setting');
});

for (const [name, edit] of Object.entries(EDITS)) {
  test(`segmentation OFF, timed text, the plain box: ${name} is ONE Undo item, undone and redone exactly (undo-gating 1)`, () => {
    const rec = { id: 'x', doc: distinctDoc() };
    const { ta, api } = editor(rec, { seg: false });
    const s0 = state(rec.doc);
    api.focusin(ta);
    ta.value = edit(ta.value.split('\n')).join('\n');
    api.blur();
    const s1 = state(rec.doc);
    assert.notEqual(s1, s0);
    assert.equal(api.undo, 1, 'one Undo item (the first v717 had none with segmentation off)');
    api.doUndo();
    assert.equal(state(rec.doc), s0, 'one Undo restores text and every span field');
    assert.equal(ta.value, ft.getBaselineParagraphs(rec.doc).join('\n'), 'and the box shows it');
    api.doRedo();
    assert.equal(state(rec.doc), s1, 'one Redo re-applies it exactly');
  });
}

test('segmentation OFF: a box edit after another action is its OWN Undo — one Undo never takes back two actions', () => {
  const rec = { id: 'x', doc: distinctDoc() };
  const { ta, api } = editor(rec, { seg: false });
  const s0 = state(rec.doc);
  api.captureUndo(); rec.doc.paragraphs[0].segments[0].words[0].gls = 'X';   // e.g. a chain on the Gloss tab
  const sChain = state(rec.doc);
  api.focusin(ta);
  ta.value = EDITS.join(ta.value.split('\n')).join('\n');
  api.blur();
  const sBoth = state(rec.doc);
  api.doUndo();
  assert.equal(state(rec.doc), sChain, 'the first Undo takes back the join only (the first v717 took back both)');
  api.doUndo();
  assert.equal(state(rec.doc), s0, 'the second, the chain');
  api.doRedo(); api.doRedo();
  assert.equal(state(rec.doc), sBoth, 'and two Redos put both back');
  // The box clean again: Ctrl+Z there is the app's (the keydown hybrid) — an exact restore, not a re-split.
  api.focusin(ta);
  api.doUndo();
  assert.equal(state(rec.doc), sChain, 'restored from the snapshot: the real seam at 3700 is still real');
  assert.equal(rec.doc.segments[1].end, 3700);
});

test('the positional fallback\'s red flag is part of the edit: one Undo takes it back, one Redo restores it (undo-gating 6)', () => {
  const doc = loadFixture('elan40');
  doc.segments = doc.segments.slice(0, 39);   // spans that already disagreed with the lines
  const rec = { id: 's', doc };
  const { ta, api } = editor(rec, { seg: true });
  api.focusin(ta);
  ta.value += '\nanother line';
  api.blur();
  assert.equal(rec.timeSync, true);
  api.doUndo();
  assert.ok(!rec.timeSync, 'the edit undone, nothing was paired by position — the banner is not red');
  api.doRedo();
  assert.equal(rec.timeSync, true);
});

/* ── drags and the Segmenter: no Undo item that undoes nothing ────────────────────────────────── */

function matcher(spans, head = null) {
  const toasts = [];
  const api = new Function('SEG', 'MG0', 'head', 'toasts', `
    const { dragSeam, splitSpanAt, mergeSpanPair, MIN_SEGMENT_MS } = SEG;
    let MG = MG0; const $ = () => null; const t = (k) => k; const toast = (m) => toasts.push(m);
    const player = { playheadMs: () => head, pause() {}, clearSpan() {}, boundaryFocus() {}, boundaryLive() {} };
    function mgDraw() {} function mgLiveBoundary() {}
    ${liftAll(APP, ['MG_UNDO_MAX', 'mgUndoStack', 'mgRedoStack', 'mgSnap', 'mgCapture', 'mgApply', 'mgUndoOnce', 'mgRedoOnce', 'mgMoveBoundary', 'mgDragFrom', 'mgBoundaryDrag', 'mgGrabbedAt', 'mgSplitSpan', 'mgJoinSpan'])}
    return { get MG() { return MG; }, mgSplitSpan, mgJoinSpan, mgBoundaryDrag, undo: mgUndoOnce, get depth() { return mgUndoStack.length; } };
  `)(SEG, { docId: 'm', spans, lines: spans.map((_, i) => ({ id: 'ln' + i, phrases: [] })), selSpan: null, selLine: null }, head, toasts);
  return { api, toasts };
}

test('a refused split, a grip pressed and released in place: no Undo item (undo-gating 7)', () => {
  const short = matcher([{ id: 'sp0', start: 0, end: 150 }, { id: 'sp1', start: 150, end: 4000 }]);
  short.api.mgSplitSpan('sp0');
  assert.equal(short.toasts.length, 1, 'refused, with a toast');
  assert.equal(short.api.depth, 0, 'and nothing to undo');
  const still = matcher([{ id: 'sp0', start: 0, end: 2000 }, { id: 'sp1', start: 2500, end: 4000 }]);
  still.api.mgBoundaryDrag(0, null, 'start', 'row', 'end');
  still.api.mgBoundaryDrag(0, 2000, 'move', 'row', 'end');   // a jitter that lands where it was
  still.api.mgBoundaryDrag(0, null, 'end', 'row', 'end');
  assert.equal(still.api.depth, 0, 'Segmenter: a still grip leaves no step');
  still.api.mgBoundaryDrag(0, null, 'start', 'row', 'end');
  for (const ms of [2100, 2200]) still.api.mgBoundaryDrag(0, ms, 'move', 'row', 'end');
  still.api.mgBoundaryDrag(0, null, 'end', 'row', 'end');
  assert.equal(still.api.depth, 1, 'a real drag is still one step');
  still.api.undo();
  assert.equal(still.api.MG.spans[0].end, 2000, 'and its one Undo restores it');

  let captures = 0, saves = 0;
  const segs = [{ start: 0, end: 2000 }, { start: 2500, end: 4000 }];
  const drag = makeBoundaryDrag({ getSegs: () => segs, getPlayer: () => null, capture: () => captures++, persist: () => saves++ });
  drag(0, null, 'start', 'end'); drag(0, 2000, 'move', 'end'); drag(0, null, 'end', 'end');
  assert.deepEqual([captures, saves], [0, 0], 'editor: no step and no stamped save for a grip that did not move');
  drag(0, null, 'start', 'end'); drag(0, 2100, 'move', 'end'); drag(0, 2150, 'move', 'end'); drag(0, null, 'end', 'end');
  assert.deepEqual([captures, saves, segs[0].end], [1, 1, 2150], 'one step and one save for a real drag');
});

test('the Segmenter reads an older build\'s estimates per edge before its verbs touch them (exports 7)', () => {
  // v716's nudged ✂ at 3010 inside [3000, 6000]: both halves flagged, no guess.
  const doc = ft.makeDoc(SET);
  ft.reconcileBaseline(doc, ['a', 'b', 'c', 'd', 'e'], { flatSegments: true });
  doc.segments = [{ start: 0, end: 1000 }, { start: 1000, end: 3000 }, { start: 3000, end: 3120, timeEstimated: true },
    { start: 3120, end: 6000, timeEstimated: true }, { start: 6000, end: 7000 }];
  delete doc.timeEdges;
  const rec = { id: 'm', doc };
  const load = new Function('SEG', 'ft', 'rec', `
    const { withGuesses } = SEG; const { readLegacyEstimates } = ft;
    let MG = null;
    const docSegments = (d) => (d && Array.isArray(d.segments) ? d.segments : []);
    const readBackOnOpen = (r) => readLegacyEstimates(r.doc);
    ${liftAll(APP, ['mgLoad'])}
    mgLoad(rec);
    return MG;
  `)(SEG, ft, rec);
  assert.match(liftAll(APP, ['mgLoad']), /^function mgLoad\(rec\) \{\s*\n\s*readBackOnOpen\(rec\);/, 'mgLoad reads back first');
  const { api } = matcher(load.spans);
  api.mgJoinSpan(load.spans[3].id);
  const j = api.MG.spans[2];
  assert.deepEqual([j.start, j.end, edgeGuessed(j, 0), edgeGuessed(j, 1), isEstimate(j)], [3000, 6000, false, false, false],
    'the two halves joined are the original line, real at both ends (the first v717: guessed at both)');
});

/* ── opening a text: read back before anything draws, and still "on Drive" afterwards ─────────── */

function opening(rec) {
  return new Function('ft', 'rec', `
    const { readLegacyEstimates } = ft;
    ${liftAll(APP, ['cheapHash', 'uploadContentSig', 'inSyncSinceOpen', 'readBackOnOpen', 'keepInSync'])}
    return { readBackOnOpen, keepInSync, uploadContentSig, edit: (r) => inSyncSinceOpen.delete(r) };
  `)(ft, rec);
}
function storedByV716(name) {
  const doc = loadFixture(name);
  doc.segments = doc.segments.map((s) => (isAligned(s) ? { start: s.start, end: s.end } : { timePending: true }));
  delete doc.timeEdges;
  return doc;
}

test('a text is read back BEFORE any tab draws it: Gloss first, or the Segmenter, shows the estimates dashed (undo-gating 3)', () => {
  const enter = liftAll(APP, ['enterEditor']);
  assert.match(enter, /^function enterEditor\(tab\) \{\s*\n\s*readBackOnOpen\(current\);/, 'the first thing an open does');
  assert.ok(enter.indexOf('readBackOnOpen(current)') < enter.indexOf('switchTab('), 'before the landing tab renders');
  const rec = { id: 'e', doc: storedByV716('e78'), audioSource: 'local:recording.wav' };
  assert.equal(rec.doc.segments.filter(isEstimate).length, 0, 'stored by v716: its import ignored the `~`');
  opening(rec).readBackOnOpen(rec);
  const bars = rec.doc.segments.map((s) => timeStateClass(s, false));
  assert.equal(bars.filter((c) => c.includes('seg-est')).length, 78, 'all 78 Gloss bars dashed on first entry, whatever the banner switch says');
});

test('opening a text already on Drive leaves it "already on Drive": Done does not upload a duplicate (undo-gating 4)', () => {
  for (const name of ['e78', 'e19', 'l29-13aug', 'l29-damaged', 't53', 't151', 'elan40', 't18']) {
    const rec = { id: name, title: name.toUpperCase(), audioId: 'a', doc: storedByV716(name) };
    const o = opening(rec);
    rec.uploadedSig = o.uploadContentSig(rec);           // uploaded by v716
    const stored = JSON.stringify(rec.doc);
    o.readBackOnOpen(rec);
    assert.notEqual(JSON.stringify(rec.doc), stored, `${name}: opening does change the doc (every span gains its guess)…`);
    assert.equal(rec.uploadedSig, o.uploadContentSig(rec), `${name}: …but not what counts as on Drive`);
    // a seed or a tail cover laid down while drawing, saved quietly
    rec.doc.segments.push({ timePending: true }); o.keepInSync(rec);
    assert.equal(rec.uploadedSig, o.uploadContentSig(rec), `${name}: a quiet write keeps it too`);
    o.edit(rec);                                          // schedulePersist / persist
    rec.doc.segments.pop(); o.keepInSync(rec);
    assert.notEqual(rec.uploadedSig, o.uploadContentSig(rec), `${name}: after a real edit the hash decides again`);
  }
  // A text that was NOT in sync stays not in sync — a read-back never marks unsent work as sent.
  const rec = { id: 'x', doc: storedByV716('e78'), uploadedSig: 'something older' };
  const o = opening(rec);
  o.readBackOnOpen(rec); o.keepInSync(rec);
  assert.equal(rec.uploadedSig, 'something older');
  const sp = liftAll(APP, ['schedulePersist']), ps = liftAll(APP, ['persist']), sq = liftAll(APP, ['saveQuiet']);
  assert.match(sp, /inSyncSinceOpen\.delete\(current\)/, 'every edit ends the carry');
  assert.match(ps, /inSyncSinceOpen\.delete\(current\)/);
  assert.match(sq, /keepInSync\(rec\);\s*\n\s*return db\.putDoc\(rec\)/, 'every quiet write carries it');
});

/* ── the researcher's switch covers the red marks too ─────────────────────────────────────────── */

test('the red check bar, its "!" and tooltip follow the timingBanner switch (undo-gating 5)', () => {
  const doc = loadFixture('l29-damaged');
  const texts = ft.getBaselineParagraphs(doc);
  assert.deepEqual([...checkedLines(doc.segments, texts)], [2], 'line 3 is flagged when the switch is on');
  assert.equal(checkedLines(doc.segments, texts, false).size, 0, 'and nothing is, off — a kiosk stays plain');
  assert.match(APP, /const checks = checkedLines\(segs, getBaselineParagraphs\(current\.doc\), timingBannerOn\(\)\);/, 'the Gloss bars');
  assert.match(APP, /const checks = checkedLines\(MG\.spans, [^\n]*, timingBannerOn\(\)\);/, 'the Segmenter');
  assert.equal((APP.match(/timingMarks: \(\) => timingBannerOn\(\),/g) || []).length, 2, 'the Baseline strips and the Cut rows are handed the switch');
  assert.match(STRIPS, /const checks = checkedLines\(segs, paras, !deps\.timingMarks \|\| deps\.timingMarks\(\)\);/);
  assert.match(STRIPS, /const checks = checkedLines\(segs, paras, !cutDeps\.timingMarks \|\| cutDeps\.timingMarks\(\)\);/);
});
