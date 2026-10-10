/* THE v718 REVIEW'S AUDIO SEGMENTER, SWITCH AND EXPORT FINDINGS, each pinned (time-untimed v2) — the
 * app.js half of time-untimed-review. The functions are lifted from the source and run with their
 * collaborators stubbed (test/lib/lift.mjs), so what is tested is the code that ships. Every test here
 * failed on the first v718 (10abc3a4).
 *
 *   · a look in the Segmenter (open, listen, Back) leaves no draft — so the next visit is not a resumed
 *     row with no time that nothing can cut, and a later edit in the editor is not "this text has
 *     changed" about matching nobody did; and a draft whose rows came back without times is the whole
 *     recording again;
 *   · "Start from the text" (or Escape) and then Done keeps the draft it set aside;
 *   · the draft's signature does not change when the editor's quiet writes do (a seed made pending,
 *     D7's one-line span, the tail cover), and does when a Keep does;
 *   · a line holding the file's own times keeps them through an untouched Done (P4);
 *   · the Gloss tab's ✂ under the playhead reads the playhead;
 *   · a pushed keepTimes or timingBanner redraws the tab it changes; a new language re-enters it;
 *   · a local full save of a seeded record builds no EAF without times. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as SEG from '../docs/js/segments.js';
import { ft } from './lib/timing-fixtures.mjs';
import { liftAll, liftDecl } from './lib/lift.mjs';
import { storableRecord } from './lib/storable.mjs';
import { prepareDisplaySpans, lineHasOffsets } from '../docs/js/segment-strips.js';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const { isAligned, isPlaced, isPlaceholder } = SEG;
const SET = { vernLang: 'fau', analLang: 'id' };
const times = (segs) => segs.map((s) => (isAligned(s) ? [s.start, s.end] : null));
const clone = (x) => JSON.parse(JSON.stringify(x));
const tick = () => new Promise((r) => setImmediate(r));

/* ── the Audio Segmenter, lifted whole around one record store ─────────────────────────────────── */

// mgDraw is a DOM builder; its two state lines are reproduced verbatim, and checked to be there.
const DRAW = liftDecl(APP, 'mgDraw');
assert.match(DRAW, /MG\.spans = mgSpreadSpans\(MG\.spans, peaksDurationMs\(MG\.docId\)\);/);
assert.match(DRAW, /\n  mgSaveDraft\(\);\n/);

function segmenter(store, extra = {}) {
  const log = { toasts: [], confirms: [] };
  const state = { dur: extra.dur || 0, head: null };
  const api = new Function('env', `
    const { SEG, ft, store, log, storableRecord, lineHasOffsets, extra, state } = env;
    const { withGuesses, seedsToPending, storableSegments, isAligned, isPlaced, isPlaceholder, spreadUntimed, splitSpanAt, mergeSpanPair, dragSeam, edgeGuessed } = SEG;
    const { makeSegment, mergePhrases, readLegacyEstimates } = ft;
    const MIN_SEGMENT_MS = SEG.MIN_SEGMENT_MS;
    let MG = null, current = null, mgUndoStack = [], mgRedoStack = [], mgDraftTimer = 0;
    const clone = (x) => JSON.parse(JSON.stringify(x));
    const timers = [];
    const db = {
      getDoc: async (id) => (store[id] ? clone(store[id]) : null),
      putDoc: async (r) => { store[r.id] = clone(storableRecord(r)); },
      getMedia: async () => ({ blob: {} }),
      broadcastLive() {},
    };
    const player = { playheadMs: () => state.head, clearSpan() {}, pause() {}, setBoundaries() {}, onBoundaryDrag() {}, root: {}, el: {},
      loadedFor: null, ws: {}, load: async () => {}, decodedBuffer: () => null, hide() {} };
    const getPlayer = () => player;
    let playerDocId = null, playerReadyFor = null, lastPlayTarget = null;
    const segPrep = () => () => {}, segWorkingMedia = async (id, m) => m, ensurePeaks = async () => {};
    const peaksDurationMs = () => state.dur, segProgress = () => {};
    const newGuid = () => 'g' + Math.random().toString(16).slice(2);
    const docStats = () => ({});
    const docSegments = (d) => { if (!Array.isArray(d.segments)) d.segments = []; return d.segments; };
    const readBackOnOpen = (r) => readLegacyEstimates(r.doc);
    const Sync = { workerUploadTarget: () => false, reportNow() {} };
    const t = (k) => k, toast = (m) => log.toasts.push(m);
    const confirmDialog = async (msg, opts) => { log.confirms.push([msg, opts]); return !!extra.resume; };
    const healFlatSegments = () => false;
    const $ = () => null, show = () => {};
    function mgDraw() { if (!MG) return; MG.spans = mgSpreadSpans(MG.spans, peaksDurationMs(MG.docId)); mgSaveDraft(); }
    const setTimeout = (fn) => { timers.push(fn); return timers.length; }, clearTimeout = (h) => { if (h) timers[h - 1] = null; };
    async function flush() { while (timers.some(Boolean)) { const i = timers.findIndex(Boolean); const f = timers[i]; timers[i] = null; await f(); } }
    async function uploadDocById() {}
    function sgRenderList() {}
    function mgClose() { MG = null; current = null; }
    function mgGuess() {}
    ${liftAll(APP, ['cheapHash', 'mgLoad', 'mgBaseSig', 'mgSeedSpans', 'mgSpreadSpans', 'mgCommit', 'mgOpen', 'mgSaveDraft', 'mgClearDraft',
      'mgCapture', 'mgSnap', 'MG_UNDO_MAX', 'mgPrepareAudio', 'mgSplitSpan', 'mgSplitAtPlayhead', 'mgJoinSpan', 'mgComplete', 'mgApply',
      'mgUndoOnce', 'mgRedoOnce', 'mgBoundaryTimes'])}
    return {
      get MG() { return MG; },
      open: async (id) => { await mgOpen(id); for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); },
      flush, commit: () => mgCommit(), back: () => mgClose(),
      split: (id) => mgSplitSpan(id), splitHere: () => mgSplitAtPlayhead(), complete: () => mgComplete(),
      sig: (doc) => mgBaseSig(doc),
    };
  `)({ SEG, ft, store, log, storableRecord, lineHasOffsets, extra, state });
  return { api, log, state };
}
function untimedRec(id, lines) {
  const doc = ft.makeDoc(SET);
  ft.reconcileBaseline(doc, lines, { flatSegments: true });
  return storableRecord({ id, title: 'Skeleton', modified: 1, doc });
}

test('a look in the Segmenter leaves no draft — and the next visit is the whole recording, cuttable', async () => {
  const store = { w: untimedRec('w', ['w a', 'w b', 'w c']) };
  // Visit 1: open, the recording decodes (9 s), the user listens, presses Back. No edit at all.
  let s = segmenter(store, { dur: 9000 });
  await s.api.open('w');
  assert.deepEqual(times(s.api.MG.spans), [[0, 9000]], 'one whole-file row');
  await s.api.flush();
  assert.equal(store.w.matchDraft, undefined, 'nothing saved: a look is not work (it used to store the row with no time)');
  s.api.back();
  // Visit 2: not a resumed draft, so the row is the whole recording again — and the ✂ at the playhead cuts it.
  s = segmenter(store, { dur: 9000 });
  await s.api.open('w');
  assert.ok(!s.api.MG.resumed);
  assert.deepEqual(times(s.api.MG.spans), [[0, 9000]]);
  assert.ok(isPlaceholder(s.api.MG.spans[0]));
  s.state.head = 4000;
  s.api.splitHere();
  assert.deepEqual(times(s.api.MG.spans), [[0, 4000], [4000, 9000]], 'cut at the playhead');
  assert.ok(s.api.MG.spans.every(isPlaced), 'two real pieces');
  assert.deepEqual(s.log.toasts, []);
  await s.api.flush();
  assert.ok(store.w.matchDraft, 'and THAT is work: the draft is kept');
  assert.equal(s.log.confirms.length, 0, 'no question asked on any visit');
});

test('a draft whose rows came back with no time resumes as the whole recording, or its even share', async () => {
  for (const [rows, want] of [[1, [[0, 9000]]], [2, [[0, 4500], [4500, 9000]]]]) {
    // what storage holds of placeholder rows: no time (db.js storableRecord), as an earlier v718 left them
    const rec = untimedRec('d', ['w a', 'w b', 'w c']);
    rec.matchDraft = { at: 5, lines: [0, 1, 2].map((i) => ({ id: 'ln' + i, phrases: rec.doc.paragraphs[i].segments, guid: rec.doc.paragraphs[i].guid })),
      spans: Array.from({ length: rows }, (_, i) => ({ id: 'sp' + i, start: 0, end: 0, timePending: true })) };
    const store = { d: rec };
    const s = segmenter(store, { dur: 9000 });
    await s.api.open('d');
    assert.ok(s.api.MG.resumed, 'the draft is resumed');
    assert.deepEqual(times(s.api.MG.spans), want, `${rows} row(s): drawn over the recording, not "No audio for this line"`);
    assert.ok(s.api.MG.spans.every(isPlaceholder), 'still nobody\'s time');
    assert.ok(s.api.complete(), 'Done is not disabled');
    s.state.head = 3000;
    s.api.splitHere();
    assert.equal(s.api.MG.spans.length, rows + 1, 'and the ✂ at the playhead cuts (it said "The playhead is not inside a piece of audio")');
  }
});

test('"Start from the text" (or Escape), then Done with no edit: the set-aside draft survives', async () => {
  const rec = untimedRec('e', ['w a', 'w b', 'w c']);
  rec.doc.segments = [{ start: 0, end: 3000 }, { start: 3000, end: 6000 }, { start: 6000, end: 9000 }];
  const draftSpans = [{ id: 'x0', start: 0, end: 2000 }, { id: 'x1', start: 2000, end: 5000 }, { id: 'x2', start: 5000, end: 9000 }];
  rec.matchDraft = { at: 5, baseSig: 'an-older-text', spans: draftSpans,
    lines: [0, 1, 2].map((i) => ({ id: 'ln' + i, phrases: rec.doc.paragraphs[i].segments, guid: rec.doc.paragraphs[i].guid })) };
  const store = { e: rec };
  const s = segmenter(store, { dur: 9000, resume: false });
  await s.api.open('e');
  assert.equal(s.log.confirms.length, 1, 'the text changed since: the user is asked');
  assert.equal(s.log.confirms[0][1].cancelFirst, true, '…with "Start from the text" the default (Resume discards later edits)');
  assert.ok(s.api.MG.holdDraft, 'the draft is set aside');
  await s.api.commit();
  assert.deepEqual(times(store.e.doc.segments), [[0, 3000], [3000, 6000], [6000, 9000]], 'Done stores the text as it was');
  assert.ok(store.e.matchDraft, 'and the three cuts of the draft are still there (Done used to delete them)');
  assert.deepEqual(times(store.e.matchDraft.spans), times(draftSpans));
});

test('the draft\'s signature ignores the editor\'s quiet writes, and notices a Keep', () => {
  const { api } = segmenter({});
  const sigNow = (doc) => { const d = clone(doc); ft.readLegacyEstimates(d); return api.sig(d); };
  const editorOpen = (doc, D) => {   // the editor draws the text, then its first save stores it
    const d = clone(doc);
    prepareDisplaySpans(d, { getParagraphs: ft.getBaselineParagraphs, getDocId: () => 'x', durationMs: D, persist() {}, persistQuiet() {}, keepInSync() {} });
    return clone(storableRecord({ id: 'x', doc: d }).doc);
  };
  // a v714 seed (a bare flag on an even spread): the editor's first save stores it as untimed lines
  const seeded = ft.makeDoc(SET);
  ft.reconcileBaseline(seeded, ['w a', 'w b', 'w c', 'w d'], { flatSegments: true });
  seeded.segments = [0, 1, 2, 3].map((k) => ({ start: k * 2500, end: (k + 1) * 2500, timeEstimated: true }));
  delete seeded.timeEdges;
  const afterSeed = editorOpen(seeded, 10000);
  assert.ok(afterSeed.segments.every((s) => s.timePending), 'stored untimed, as v718 means it');
  assert.equal(sigNow(afterSeed), sigNow(seeded), 'a seed made pending is not a change');
  // a one-line text: D7 writes its whole-file span on open
  const one = ft.makeDoc(SET);
  ft.reconcileBaseline(one, ['w w w'], { flatSegments: true });
  assert.equal(sigNow(editorOpen(one, 8000)), sigNow(one), 'D7 is not a change');
  // the tail cover: an empty last line's end moved to the recording's end
  const tail = ft.makeDoc(SET);
  ft.reconcileBaseline(tail, ['w a', 'w b', ''], { flatSegments: true });
  tail.segments = [{ start: 0, end: 3000, guess: [null, null] }, { start: 3000, end: 6000, guess: [null, null] }, { start: 6000, end: 7000, guess: [null, null] }];
  const covered = editorOpen(tail, 12000);
  assert.equal(covered.segments[2].end, 12000, 'covered');
  assert.equal(sigNow(covered), sigNow(tail), 'the tail cover is not a change');
  // …but a Keep in the editor IS: only the guessed edges change, and resuming over it put the guess back
  const est = clone(tail);
  est.segments[1] = { start: 3000, end: 6000, guess: [3000, 6000], estSource: 'edit', timeEstimated: true };
  const kept = clone(est);
  kept.segments[1] = { start: 3000, end: 6000, guess: [null, null] };
  assert.notEqual(sigNow(kept), sigNow(est), 'a Keep changes the text');
  // and an edit to a line's words still does
  const typo = clone(tail);
  typo.paragraphs[1].segments[0].baseline = 'w B';
  assert.notEqual(sigNow(typo), sigNow(tail));
});

test('a line holding the file\'s own times keeps them through an untouched Done (P4)', async () => {
  // an ELAN-made skeleton: line 2 is nested inside line 1's audio (two speakers at once)
  const xml = `<?xml version="1.0" encoding="utf-8"?><document version="2"><interlinear-text><item type="title" lang="id">Skeleton</item><paragraphs>
<paragraph guid="p1"><phrases><phrase guid="a1" begin-time-offset="0" end-time-offset="4000"><item type="txt" lang="fau">w w</item><words><word><item type="txt" lang="fau">w</item></word><word><item type="txt" lang="fau">w</item></word></words></phrase></phrases></paragraph>
<paragraph guid="p2"><phrases><phrase guid="a2" begin-time-offset="1000" end-time-offset="2000"><item type="txt" lang="fau">w</item><words><word><item type="txt" lang="fau">w</item></word></words></phrase></phrases></paragraph>
<paragraph guid="p3"><phrases><phrase guid="a3" begin-time-offset="4000" end-time-offset="8000"><item type="txt" lang="fau">w w</item><words><word><item type="txt" lang="fau">w</item></word><word><item type="txt" lang="fau">w</item></word></words></phrase></phrases></paragraph>
</paragraphs></interlinear-text></document>`;
  const doc = ft.parseFlextext(xml, SET).texts[0];
  doc.segments = ft.segmentsFromOffsets(doc);
  assert.deepEqual(doc.segments[1].fileTimes, [1000, 2000], 'the model holds line 2 pending with the file\'s times');
  const offsetsOf = (d) => [...ft.serializeFlextext(d, SET, { segTimes: true }).matchAll(/begin-time-offset="(\d+)" end-time-offset="(\d+)"/g)].map((m) => [+m[1], +m[2]]);
  assert.deepEqual(offsetsOf(doc), [[0, 4000], [1000, 2000], [4000, 8000]], 'the editor exports all three');
  const store = { n: storableRecord({ id: 'n', title: 'Skeleton', modified: 1, doc }) };
  const s = segmenter(store, { dur: 8000 });
  await s.api.open('n');
  assert.ok(s.api.MG.spans[1].timePending && !isPlaceholder(s.api.MG.spans[1]), 'line 2 is not drawn as an untimed line in a gap');
  await s.api.commit();
  assert.deepEqual(store.n.doc.segments[1].fileTimes, [1000, 2000], 'Done keeps the hold');
  assert.deepEqual(offsetsOf(store.n.doc), [[0, 4000], [1000, 2000], [4000, 8000]], 'and the export still carries line 2\'s own times');
});

/* ── the Gloss tab's ✂ under the playhead ──────────────────────────────────────────────────────── */

test('the Gloss tab reads the playhead, so a line under it splits at it (audio tier required while the ✂ is drawn)', () => {
  const doc = ft.makeDoc(SET);
  ft.reconcileBaseline(doc, ['w a', 'w b w c', 'w d'], { flatSegments: true });
  doc.segments = SEG.spreadUntimed([{ start: 0, end: 3000, guess: [null, null] }, { timePending: true }, { start: 7000, end: 9000, guess: [null, null] }], 9000);
  const player = { playheadMs: () => 5000 };   // the suite's own Player: no currentTime
  const info = new Function('SEG', 'ft', 'current', 'player', `
    const { audioTierReachable } = SEG;
    const { getBaselineParagraphs, wordGlosses: glossesOfWord, phraseFrees: freesOfPhrase } = ft;
    const docSegments = (d) => d.segments;
    ${liftAll(APP, ['lineHasAnalysis', 'playheadMs', 'glossInfo'])}
    return { glossInfo, playheadMs };
  `)(SEG, ft, { doc }, player);
  assert.equal(info.playheadMs(), 5000);
  assert.ok(isPlaceholder(doc.segments[1]), 'line 2 needs timing');
  assert.equal(info.glossInfo(1).aligned, true, 'the playhead is in line 2: its ✂ is on screen, and the split takes its position');
  assert.ok(SEG.splitTiers(info.glossInfo(1)).includes('audio'));
  assert.equal(info.glossInfo(0).aligned, false, 'line 1 is not under the playhead');
  player.playheadMs = () => 7000;   // parked exactly on line 3's start: its ✂ is drawn on line 3, not line 2
  assert.equal(info.glossInfo(1).aligned, false);
  assert.equal(info.glossInfo(2).aligned, true);
});

/* ── a researcher's push, and a new language ───────────────────────────────────────────────────── */

function liveSettings(start) {
  const env = { settings: { ...start }, next: null, switched: [], drawn: 0 };
  const run = new Function('env', `
    let settings = env.settings, current = { id: 'x' }, MG = null;
    const RESEARCHER_MODE = false, RECORD_MODE = false, CONSENT_MODE = false, SEGMENTER_MODE = false;
    const Sync = { hasSession: () => true };   // a managed device: the switches are the researcher's
    const loadSettings = () => env.next;
    const noop = () => {};
    const applyUiScale = noop, applyHeaderLabels = noop, applyGlossIcon = noop, applyResearchVisibility = noop, applyAllowedButtons = noop,
      fillDeviceSetup = noop, renderDocList = noop, applyDeleteAllButton = noop, applyInviteButton = noop, applyDoneButton = noop,
      applyCutTabVisibility = noop, applyCutHint = noop, applyBaselineHint = noop, applyGlossEmptyHint = noop, renderTimingBanner = noop,
      baselineShowsTextarea = () => false, refreshList = noop, renderRecordView = noop, renderRecordList = noop;
    const joinLinesAllowed = () => true, splitLinesAllowed = () => true, segmentationEnabled = () => settings.segmentation === true;
    const currentView = () => 'baseline', switchTab = (v) => env.switched.push(v), mgDraw = () => { env.drawn++; };
    ${liftAll(APP, ['adjustBoundariesAllowed', 'keepTimesOn', 'keepAllowed', 'timingBannerOn', 'applyLiveSettings'])}
    return (next) => { env.next = next; applyLiveSettings(); };
  `)(env);
  return { env, push: (next) => run(next) };
}

test('a pushed keepTimes or timingBanner redraws the open tab — Keep and the marks follow the switch', () => {
  const base = { segmentation: true, keepTimes: true, timingBanner: true };
  for (const change of [{ keepTimes: false }, { timingBanner: false }]) {
    const { env, push } = liveSettings(base);
    push({ ...base, ...change });
    assert.deepEqual(env.switched, ['baseline'], `${Object.keys(change)[0]} off: re-entered once (a Keep that did nothing stayed on screen)`);
  }
  const { env, push } = liveSettings({ segmentation: true });
  push({ segmentation: true, keepTimes: true });
  assert.deepEqual(env.switched, ['baseline'], 'switched on: re-entered, so Keep appears');
  const same = liveSettings(base);
  same.push({ ...base, exportEaf: true });
  assert.deepEqual(same.env.switched, [], 'a push that changes nothing here never yanks the caret');
});

test('a new language re-enters the open editor tab (its rows are built with t(), and the Gloss bars after the words)', () => {
  const setup = liftDecl(APP, 'setup');
  const m = /langSel\.addEventListener\('change', \(\) => \{([\s\S]*?)\n    \}\);/.exec(setup);
  assert.ok(m, 'the language handler');
  const h = m[1];
  assert.match(h, /const v = currentView\(\);\s*\n\s*if \(current && \(v === 'cut' \|\| v === 'baseline' \|\| v === 'gloss'\)\) switchTab\(v\);/,
    'Baseline, Cut and Gloss re-entered — switchTab draws the Gloss bars too (renderGloss alone took them all off)');
  assert.doesNotMatch(h, /renderGloss\(\)/, 'not the words alone');
  assert.match(h, /if \(SEGMENTER_MODE\) \{ sgRenderList\(\); if \(MG\) mgDraw\(\); return; \}/, 'and the matcher\'s rows');
});

/* ── a local full save of a record v714 seeded and nobody reopened ─────────────────────────────── */

test('a seeded record nobody reopened: its full save builds no EAF (every exporter writes it untimed)', async () => {
  const seen = [];
  const build = new Function('ft', 'SEG', 'seen', `
    const { spansForExport, segmentsFromOffsets } = ft;
    const { isPlaced } = SEG;
    const db = { getMedia: async (id) => (String(id).startsWith('segwav:') ? null : { blob: { size: 10 }, name: 'recording.wav', mimeType: 'audio/wav' }) };
    const settings = {}, segmentationEnabled = () => true, isAudioLocked = () => false;
    const docFilename = () => 'Skeleton.flextext', conversionCaps = () => ({ preview: true, fxpa: true, fxpaAudio: true });
    const mediaNameFor = (b) => b + '.wav', derivedWavName = (b) => b + '.wav', producedBy = () => '';
    async function assembleSegEntries(o) { seen.push(o.segMedia); throw new Error('stop'); }
    ${liftAll(APP, ['buildBundleFor'])}
    return buildBundleFor;
  `)(ft, SEG, seen);
  const doc = ft.makeDoc(SET);
  ft.reconcileBaseline(doc, ['w a', 'w b', 'w c', 'w d'], { flatSegments: true });
  doc.segments = [0, 1, 2, 3].map((k) => ({ start: k * 2500, end: (k + 1) * 2500, timeEstimated: true }));   // v714's seed, stored
  delete doc.timeEdges;
  await assert.rejects(build({ id: 's', title: 'Skeleton', doc }, false, { full: true }), /stop/);
  assert.equal(seen[0], null, 'no working media named for alignment, so no EAF of twelve empty time slots');
  const cut = clone(doc);
  cut.segments = [0, 1, 2, 3].map((k) => ({ start: k * 2500, end: (k + 1) * 2500 + (k === 3 ? 0 : 7) }));
  cut.segments.forEach((s, k) => { if (k) s.start = cut.segments[k - 1].end; });
  await assert.rejects(build({ id: 'c', title: 'Skeleton', doc: cut }, false, { full: true }), /stop/);
  assert.ok(seen[1], 'a text with real cuts still gets its EAF');
});
