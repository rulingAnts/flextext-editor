/* THE AUDIO SEGMENTER AGREES WITH THE EDITOR ABOUT UNTIMED LINES (v718 — plans/time-gaps-and-estimates.md
 * D13, cases 3 and 22; §6.1 segmenter-placeholders; R8).
 *
 *   · case 3: a partly timed text (Seth dragged the first three seams of an untimed 8-line FLEx text in
 *     the editor) opened in the Segmenter: its untimed rows are shown in their gap, NO tail span is
 *     appended after them, and Done adds no line and stores no time for rows 5–8 — v717 appended the
 *     uncut remainder as a ninth row and Done gave it a blank line;
 *   · a recording nobody cut opens as ONE whole-file PLACEHOLDER, and an untouched Done stores nothing
 *     (v714 stored "line 1 = the whole recording");
 *   · split and join go through the shared helpers, so the placeholder rules are the editor's;
 *   · case 22: a draft of a text that changed since is not resumed silently.
 * The app.js functions are lifted from the source and run with their collaborators stubbed, so what is
 * tested is the code that ships (test/lib/lift.mjs). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as SEG from '../docs/js/segments.js';
import { ft } from './lib/timing-fixtures.mjs';
import { liftAll } from './lib/lift.mjs';
import { storableRecord } from './lib/storable.mjs';
import { prepareDisplaySpans, lineHasOffsets } from '../docs/js/segment-strips.js';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const { isPlaceholder, isPlaced, isAligned, moveBoundary } = SEG;
const SET = { vernLang: 'fau', analLang: 'id' };
const times = (segs) => segs.map((s) => (isAligned(s) ? [s.start, s.end] : null));
const D = 16000;

// The editor's draw (every tab runs it), with the recording 16 s long.
const draw = (doc) => prepareDisplaySpans(doc, { getParagraphs: ft.getBaselineParagraphs, getDocId: () => 'doc', durationMs: D, persistQuiet() {}, persist() {} });

/* The Segmenter's own functions, lifted, around one record store. `store` holds what IndexedDB holds:
 * every write goes through db.js's storableRecord, as putDoc does. */
function segmenter(store, extra = {}) {
  const log = { puts: 0, toasts: [], confirms: [], drawn: 0 };
  const env = { SEG, ft, store, log, storableRecord, lineHasOffsets, extra };
  const api = new Function('env', `
    const { SEG, ft, store, log, storableRecord, lineHasOffsets, extra } = env;
    const { withGuesses, seedsToPending, storableSegments, isAligned, isPlaced, spreadUntimed, splitSpanAt, mergeSpanPair } = SEG;
    const { makeSegment, mergePhrases, readLegacyEstimates } = ft;
    let MG = null, current = null, mgUndoStack = [], mgRedoStack = [], player = null, mgDraftTimer = 0;
    const clone = (x) => JSON.parse(JSON.stringify(x));
    const db = {
      getDoc: async (id) => (store[id] ? clone(store[id]) : null),
      putDoc: async (r) => { log.puts++; store[r.id] = clone(storableRecord(r)); },
      broadcastLive() {},
    };
    const newGuid = () => 'g' + Math.random().toString(16).slice(2);
    const docStats = () => ({});
    const docSegments = (d) => { if (!Array.isArray(d.segments)) d.segments = []; return d.segments; };
    const readBackOnOpen = (r) => readLegacyEstimates(r.doc);
    const Sync = { workerUploadTarget: () => false, reportNow() {} };
    const t = (k) => k, toast = (m) => log.toasts.push(m);
    const confirmDialog = async (msg, opts) => { log.confirms.push([msg, opts]); return !!extra.resume; };
    const healFlatSegments = () => false;
    const $ = () => null, show = () => {}, mgDraw = () => { log.drawn++; }, mgPrepareAudio = () => {};
    const setTimeout = (fn) => { fn(); return 0; }, clearTimeout = () => {};
    async function uploadDocById() {}
    async function mgClearDraft(id) { const r = store[id]; if (r) delete r.matchDraft; }
    function mgClose() { MG = null; }
    function sgRenderList() {}
    ${liftAll(APP, ['cheapHash', 'mgLoad', 'mgBaseSig', 'mgSeedSpans', 'mgSpreadSpans', 'mgCommit', 'mgOpen', 'mgSaveDraft', 'mgCapture', 'mgSnap', 'MG_UNDO_MAX'])}
    return {
      get MG() { return MG; }, set MG(v) { MG = v; },
      load(id) { current = clone(store[id]); mgLoad(current); return MG; },
      prepare(dur) { MG.spans = mgSpreadSpans(mgSeedSpans(MG.spans, dur, MG.resumed), dur); return MG.spans; },
      commit: () => mgCommit(),
      open: (id) => mgOpen(id),
      saveDraft: () => mgSaveDraft(),
      capture: () => mgCapture(),
    };
  `)(env);
  return { api, log, store };
}

function caseThree() {
  const doc = ft.makeDoc(SET);
  ft.reconcileBaseline(doc, ['l1 a', 'l2 b', 'l3 c', 'l4 d', 'l5 e', 'l6 f', 'l7 g', 'l8 h'], { flatSegments: true });
  draw(doc);
  assert.ok(doc.segments.every(isPlaceholder), 'an untimed FLEx text: eight lines drawn evenly');
  // Seth drags the first three seams on the Baseline tab — each drag a real edit, then the next draw.
  for (const [i, ms] of [[0, 2300], [1, 4100], [2, 5900]]) { doc.segments = moveBoundary(doc.segments, i, ms).segments; draw(doc); }
  return { id: 'c3', title: 'C3', modified: 1, doc };
}

test('case 3 / R8: the partly timed text\'s untimed rows sit in their gap — no tail span, and Done adds no line', async () => {
  const rec = caseThree();
  assert.deepEqual(rec.doc.segments.map(isPlaced), [true, true, true, true, false, false, false, false], 'lines 1–4 timed by the drags, 5–8 not');
  const store = { c3: storableRecord(rec) };                    // what the editor saved
  assert.deepEqual(times(store.c3.doc.segments).slice(4), [null, null, null, null], 'storage holds lines 5–8 untimed');
  const { api } = segmenter(store);
  api.load('c3');
  const spans = api.prepare(D);
  assert.equal(spans.length, 8, 'eight rows: NO tail span appended after the untimed ones (v717 made a ninth)');
  assert.ok(spans.slice(4).every(isPlaceholder), 'rows 5–8 shown in the gap after line 4');
  assert.deepEqual(times(spans).slice(4), [[8000, 10000], [10000, 12000], [12000, 14000], [14000, 16000]]);
  assert.deepEqual(spans.map((s) => s.id), ['sp0', 'sp1', 'sp2', 'sp3', 'sp4', 'sp5', 'sp6', 'sp7'], 'the rows keep their ids');
  await api.commit();
  const done = store.c3.doc;
  assert.equal(done.paragraphs.length, 8, 'Done adds no line');
  assert.deepEqual(times(done.segments), [[0, 2300], [2300, 4100], [4100, 5900], [5900, 8000], null, null, null, null],
    'and stores no time for rows 5–8');
  assert.deepEqual(ft.getBaselineParagraphs(done), ['l1 a', 'l2 b', 'l3 c', 'l4 d', 'l5 e', 'l6 f', 'l7 g', 'l8 h']);
});

test('the uncut remainder still follows a last row that HAS a time', () => {
  const { api } = segmenter({});
  api.MG = { docId: 'x', spans: [{ id: 'sp0', start: 0, end: 3000, timePending: false, guess: [null, null] }], lines: [{ id: 'ln0' }, { id: 'ln1' }] };
  const spans = api.prepare(64000);
  assert.deepEqual(times(spans), [[0, 3000], [3000, 64000]], 'Seth\'s 3-second span and the 61 seconds after it');
  assert.ok(isPlaced(spans[1]) && spans[1].id === 'tail', 'a real span of audio nobody has cut yet — not a placeholder');
  api.MG = { docId: 'x', spans: [{ id: 'sp0', start: 0, end: 3000, timePending: false, guess: [null, null] }], lines: [], resumed: 5 };
  assert.equal(api.prepare(64000).length, 1, 'a resumed draft is the user\'s own cutting: nothing appended');
});

test('a recording nobody cut is ONE whole-file placeholder, and an untouched Done stores nothing', async () => {
  const doc = ft.makeDoc(SET);
  ft.reconcileBaseline(doc, ['a', 'b', 'c'], { flatSegments: true });
  const store = { w: storableRecord({ id: 'w', title: 'W', modified: 1, doc }) };
  const { api } = segmenter(store);
  api.load('w');
  const spans = api.prepare(9000);
  assert.equal(spans.length, 1);
  assert.deepEqual([spans[0].start, spans[0].end, isPlaceholder(spans[0]), SEG.isEstimate(spans[0])], [0, 9000, true, false],
    'the whole recording, drawn — not "line 1 = the whole recording"');
  await api.commit();
  assert.equal(store.w.doc.paragraphs.length, 3, 'no line added');
  assert.deepEqual(times(store.w.doc.segments), [null, null, null], 'Done with nothing cut stores nothing');
  // …while a first cut at the playhead makes two real pieces, exactly as v717 did
  const [a, b] = SEG.splitSpanAt(spans[0], 4000, { real: true, keepPlaceholder: true });
  assert.ok(isPlaced(a) && isPlaced(b) && !SEG.isEstimate(a) && !SEG.isEstimate(b));
  // and a midpoint split (no playhead in the row) keeps both untimed
  const [c, d] = SEG.splitSpanAt(spans[0], 4500, { real: false, keepPlaceholder: true });
  assert.ok(isPlaceholder(c) && isPlaceholder(d));
});

test('split and join in the Segmenter go through the shared helpers, placeholders and all', () => {
  const split = liftAll(APP, ['mgSplitSpan']);
  assert.match(split, /splitSpanAt\(sp, at, \{ real: inside, keepPlaceholder: true \}\)/, 'the midpoint keeps a placeholder one (case 2)');
  const join = liftAll(APP, ['mgJoinSpan']);
  assert.match(join, /const merged = mergeSpanPair\(prev, cur\);/);
  assert.match(join, /phAt, noRoom, \.\.\.rest/, 'the display marks are not carried onto the joined row by the spread');
  const draw = liftAll(APP, ['mgDraw']);
  assert.match(draw, /MG\.spans = mgSpreadSpans\(MG\.spans, peaksDurationMs\(MG\.docId\)\);/, 'every redraw re-spreads, like every editor render');
  assert.match(draw, /t\('mg\.needsTiming', \{ from: mgFmt\(sp\.start\), to: mgFmt\(sp\.end\) \}\)/, '"Needs timing" replaces "No audio for this line" for a row in its gap');
  const commit = liftAll(APP, ['mgCommit']);
  assert.match(commit, /if \(Array\.isArray\(sp\.phAt\)\) out\.phAt = sp\.phAt\.slice\(0, 2\);/, 'Done carries the placeholder; storage writes it untimed');
});

test('case 22: a draft of a text that changed since is not resumed silently', async () => {
  const doc = ft.makeDoc(SET);
  ft.reconcileBaseline(doc, ['a', 'b'], { flatSegments: true });
  doc.segments = [{ start: 0, end: 4000, guess: [null, null] }, { start: 4000, end: 9000, guess: [null, null] }];
  const base = { id: 'd', title: 'D', modified: 1, doc };
  // The draft, saved by the Segmenter against the text as it was.
  const s0 = segmenter({ d: storableRecord(base) });
  s0.api.load('d');
  s0.api.MG.spans = [{ id: 'x', start: 0, end: 9000, timePending: false }];
  s0.api.saveDraft();
  await new Promise((r) => setImmediate(r));
  const drafted = s0.store.d.matchDraft;
  assert.ok(drafted && drafted.baseSig, 'the draft says what it was made from');

  // Unchanged text: resumed, no question asked (the old behaviour).
  const same = segmenter({ d: JSON.parse(JSON.stringify(s0.store.d)) });
  await same.api.open('d');
  assert.equal(same.log.confirms.length, 0);
  assert.ok(same.api.MG.resumed, 'resumed');
  assert.deepEqual(times(same.api.MG.spans), [[0, 9000]]);

  // The text was edited in the editor since (a line's words changed): asked first.
  const changed = JSON.parse(JSON.stringify(s0.store.d));
  changed.doc.paragraphs[1].segments[0].baseline = 'b corrected';
  const no = segmenter({ d: changed }, { resume: false });
  await no.api.open('d');
  assert.equal(no.log.confirms.length, 1, 'the user decides');
  assert.deepEqual(no.log.confirms[0][1], { ok: 'mg.draftResume', cancel: 'mg.draftFromText' }, 'with the two choices named');
  assert.ok(!no.api.MG.resumed, '"Start from the text": the matcher starts from the text as it is now');
  assert.deepEqual(times(no.api.MG.spans), [[0, 4000], [4000, 9000]]);
  assert.ok(no.api.MG.holdDraft, 'and the old draft is set aside, not overwritten…');
  no.api.saveDraft();
  assert.deepEqual(no.store.d.matchDraft, changed.matchDraft, '…autosave leaves it alone until an edit');
  no.api.capture();
  assert.equal(no.api.MG.holdDraft, false, 'the first edit is the choice made, and autosave resumes');

  const yes = segmenter({ d: JSON.parse(JSON.stringify(changed)) }, { resume: true });
  await yes.api.open('d');
  assert.ok(yes.api.MG.resumed, '"Resume matching (discards later edits)": the draft');
  assert.deepEqual(times(yes.api.MG.spans), [[0, 9000]]);

  // A draft an older build saved has no baseSig and cannot tell: it resumes, as it always did.
  const old = JSON.parse(JSON.stringify(changed));
  delete old.matchDraft.baseSig;
  const legacy = segmenter({ d: old });
  await legacy.api.open('d');
  assert.equal(legacy.log.confirms.length, 0);
  assert.ok(legacy.api.MG.resumed);
});
