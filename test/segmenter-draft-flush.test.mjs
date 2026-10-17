/* THE MATCHER KEEPS ITS LAST EDITS WHEN IT CLOSES (found by the desktop-flex e2e, 2026-10-16). The
 * Audio Segmenter's Matcher autosaves a draft 400 ms after an edit (mgSaveDraft), and the write read MG
 * when its timer fired. Back (mgClose) sets MG to null, so an edit and then Back inside those 400 ms was
 * never written: every edit since the last write that landed was lost, on the exit that promises to keep
 * them. The same loss came two more ways — a write already reading storage when Back came dropped itself,
 * and a text opened over an open one (the Texts tab) replaced MG under the save still waiting.
 *
 * The functions are lifted from the source and run with their collaborators stubbed (test/lib/lift.mjs),
 * so what is tested is the code that ships, against a record store ordered as IndexedDB orders it: a get
 * reads the record as it stands when the get is made, and a put or a delete lands when it is made.
 *
 *   · an edit, then Back at once — a structural one (+ a line) and one typed in place (a free
 *     translation): the draft holds it, `modified` is untouched, and the list is redrawn once it lands;
 *   · a write already reading storage when Back comes still lands;
 *   · a text opened over an open one keeps the first text's last edit;
 *   · reopened at once after Back, the text resumes what Back kept;
 *   · the exits that must NOT keep it: Start over, Done, and a delete (the remote one and the 🗑) —
 *     a delete arriving while a draft Back handed over is still on its way included, which must not put
 *     the deleted text back (#90);
 *   · a write that fails says so, and the next one still runs;
 *   · and the v718 rules hold for the write Back makes: a look leaves no draft, a draft set aside by
 *     "Start from the text" is not overwritten, and the draft carries the session's baseSig. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as SEG from '../docs/js/segments.js';
import { ft as FT } from './lib/timing-fixtures.mjs';
import { liftAll, liftDecl } from './lib/lift.mjs';
import { storableRecord } from './lib/storable.mjs';
import { lineHasOffsets } from '../docs/js/segment-strips.js';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setImmediate(r));

// mgDraw is a DOM builder; the line of it that matters here is its autosave, reproduced in the harness
// and checked to be there, so the stub cannot drift from what ships. Back is the exit with the default.
assert.match(liftDecl(APP, 'mgDraw'), /\n  mgSaveDraft\(\);\n/);
assert.match(APP, /\$\('#mg-back'\)\.onclick = \(\) => mgClose\(\);/);

function matcher(store) {
  const log = { toasts: [], renders: [], failPut: false, confirms: [], fromText: false };
  const held = [];   // gets made while db.hold is set, waiting to be answered (each with what it read)
  const api = new Function('env', `
    const { FT, SEG, store, log, held, storableRecord, lineHasOffsets } = env;
    const { makeSegment, mergePhrases, readLegacyEstimates, applyNewLineBreak, freeIn, setFreeIn, isFlexBreakPhrase, foldFlexBreakLines, unfoldFlexBreakLines } = FT;
    const mgPrimaryLang = () => 'en';   // the text's analysis language: a free translation is set in it (mgEditFree)
    const breakKindSetting = () => 'sentence';   // the device's line-break kind for a line added at a paragraph's edge
    const { withGuesses, seedsToPending, storableSegments, isAligned, isPlaced, isPlaceholder, spreadUntimed, edgeGuessed } = SEG;
    const newGuid = () => 'g' + Math.random().toString(16).slice(2);
    const docSegments = (d) => { if (!Array.isArray(d.segments)) d.segments = []; return d.segments; };
    const readBackOnOpen = (r) => readLegacyEstimates(r.doc);
    const peaksDurationMs = () => 0;
    let mgLangClaim = null, mgLangOwn = null;   // the FLEx shell's per-text language (app.js mgLangClaim)
    const SEGMENTER_MODE = true, RECORD_MODE = false, CONSENT_MODE = false;
    let MG = null, current = null, mgUndoStack = [], mgRedoStack = [];
    let playerReadyFor = null, lastPlayTarget = null;
    const clone = (x) => JSON.parse(JSON.stringify(x));
    const db = {
      hold: false,
      getDoc(id) {
        const read = store[id] ? clone(store[id]) : null;
        return new Promise((r) => (db.hold ? held.push(() => r(read)) : r(read)));
      },
      async putDoc(r) {
        if (log.failPut) { log.failPut = false; throw Object.assign(new Error('disk full'), { name: 'QuotaExceededError' }); }
        store[r.id] = clone(storableRecord(r));   // db.js putDoc's one chokepoint
      },
      // as db.js does: the recording and its kin go first, so the record itself goes a few turns later
      async deleteDoc(id) { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); delete store[id]; },
      broadcastLive() {},
    };
    const timers = [];
    const setTimeout = (fn) => { timers.push(fn); return timers.length; };
    const clearTimeout = (h) => { if (h) timers[h - 1] = null; };
    const player = { pause() {}, clearSpan() {}, onBoundaryDrag() {}, el: {}, hide() {}, loadedFor: null };
    const t = (k) => k, toast = (m) => log.toasts.push(m);
    const confirmDialog = async (msg, opts) => { log.confirms.push(msg); return !(log.fromText && msg === 'mg.draftStale'); };
    const $ = () => null, show = () => {};
    const healFlatSegments = () => false, mgPrepareAudio = () => {}, mgStopTicker = () => {};
    // what the list would show: each text's draft, by its number of lines
    const sgRenderList = () => log.renders.push(Object.fromEntries(Object.keys(store).map((k) =>
      [k, store[k].matchDraft ? store[k].matchDraft.lines.length : null])));
    const refreshList = () => {}, renderUploadQueue = () => {}, splitCancel = () => {}, leaveEditor = () => {};
    const getUpload = () => null, uploadView = new Map();
    const Sync = { workerUploadTarget: () => false, reportNow() {} };
    async function uploadDocById() {}
    function mgDraw() { if (!MG) return; MG.spans = mgSpreadSpans(MG.spans, peaksDurationMs(MG.docId)); mgSaveDraft(); }
    ${liftAll(APP, ['docStats', 'cheapHash', 'mgLoad', 'mgBaseSig', 'mgSeedSpans', 'mgSpreadSpans', 'mgDraftTimer', 'mgSaveDraft', 'mgDraftWrites', 'mgDraftCallOffs',
      'mgWriteDraft', 'mgFlushDraft', 'mgCallOffDraft', 'mgClearDraft', 'MG_UNDO_MAX', 'mgSnap', 'mgCapture',
      'mgInsertLine', 'mgLinePhrase', 'mgEditFree', 'mgSame', 'mgCommit', 'mgClose', 'mgStartOver', 'mgOpen',
      'mgJoinLine', 'mgBreakBetween', 'mgIsFlexText',
      'deleteUploadedDoc', 'userDeleteDoc'])}
    async function settle() {   // every draft write asked for has landed, and what follows each has run
      for (let p = null; p !== mgDraftWrites;) { p = mgDraftWrites; await p; }
      for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    }
    return {
      get MG() { return MG; }, db, settle,
      pending: () => timers.filter(Boolean).length,
      fire() { timers.forEach((f, i) => { if (f) { timers[i] = null; f(); } }); },
      open: (id) => mgOpen(id), back: () => mgClose(), startOver: () => mgStartOver(), commit: () => mgCommit(),
      insertLine: (after) => mgInsertLine(after), editFree: (id, v) => mgEditFree(id, v), join: (id) => mgJoinLine(id),
      remoteDelete: (id) => deleteUploadedDoc(id), userDelete: (id) => userDeleteDoc(id, id),
      sig: (doc) => mgBaseSig(doc),
    };
  `)({ FT, SEG, store, log, held, storableRecord, lineHasOffsets });
  const release = () => { api.db.hold = false; while (held.length) held.shift()(); };
  return { api, log, held, release };
}

function rec(id, lines) {
  const doc = FT.makeDoc({ vernLang: 'fau', analLang: 'id' });
  FT.reconcileBaseline(doc, lines, { flatSegments: true });
  return storableRecord({ id, title: id, created: 1, modified: 1, doc });
}
const drafted = (r) => (r && r.matchDraft ? r.matchDraft.lines.length : null);
// Open a text and let anything it set off land: the user has been on the screen a while. (A look writes
// no draft on this line — v718: none until there is work.)
async function opened(s, id) { await s.api.open(id); s.api.fire(); await s.api.settle(); }

test('an edit and then Back at once: the draft is stored with the edit, and the row says so', async () => {
  const store = { a: rec('a', ['a one', 'a two', 'a three']) };
  const s = matcher(store);
  await opened(s, 'a');
  assert.equal(store.a.matchDraft, undefined, 'a look wrote nothing (v718)');
  s.api.insertLine(0);                               // + a line: mgInsertLine → mgDraw → mgSaveDraft
  assert.equal(s.api.pending(), 1, 'the save is still waiting out its 400 ms');
  const added = s.api.MG.lines[1].id;
  s.api.back();
  assert.equal(s.api.pending(), 0, 'Back made the save; nothing is left to fire later');
  await s.api.settle();
  assert.equal(drafted(store.a), 4, 'the draft holds the line added just before Back (there was none)');
  assert.ok(store.a.matchDraft.lines.some((l) => l.id === added));
  assert.equal(store.a.modified, 1, 'a draft is not an edit to the document: `modified` untouched');
  assert.deepEqual(s.log.renders.at(-1), { a: 4 }, 'the list is drawn again once the draft has landed');
  assert.deepEqual(s.log.toasts, []);
});

test('a free translation typed in place and then Back at once is kept too', async () => {
  const store = { a: rec('a', ['a one', 'a two']) };
  const s = matcher(store);
  await opened(s, 'a');
  s.api.editFree(s.api.MG.lines[0].id, 'the first line, translated');   // mgCapture + mgSaveDraft, no redraw
  s.api.back();
  await s.api.settle();
  assert.equal(store.a.matchDraft.lines[0].phrases[0].free, 'the first line, translated');
});

test('a write already reading storage when Back comes still lands', async () => {
  const store = { a: rec('a', ['a one', 'a two', 'a three']) };
  const s = matcher(store);
  await opened(s, 'a');
  s.api.insertLine(2);
  s.api.db.hold = true;
  s.api.fire();                                      // the 400 ms are up: the write starts…
  await tick();
  assert.equal(s.held.length, 1, '…and is reading the record');
  s.api.back();                                      // Back, while it reads
  s.release();
  await s.api.settle();
  assert.equal(drafted(store.a), 4, 'it used to see MG gone and drop itself ("left while we read")');
});

test('a text opened over an open one (the Texts tab) keeps the first text\'s last edit', async () => {
  const store = { a: rec('a', ['a one', 'a two']), b: rec('b', ['b one', 'b two', 'b three']) };
  const s = matcher(store);
  await opened(s, 'a');
  s.api.insertLine(0);
  await s.api.open('b');                             // no Back: the matcher is replaced, not closed
  await s.api.settle();
  assert.equal(s.api.MG.docId, 'b');
  assert.equal(drafted(store.a), 3, 'a\'s last edit was written as the session ended (it held 2)');
  s.api.fire();
  await s.api.settle();
  assert.equal(store.b.matchDraft, undefined, 'b, only looked at, has none (v718)');
  assert.equal(drafted(store.a), 3, 'and a is untouched — the old timer used to fire against the new MG, a\'s edit gone');
});

test('reopened at once after Back, the text resumes what Back kept', async () => {
  const store = { a: rec('a', ['a one', 'a two', 'a three']) };
  const s = matcher(store);
  await opened(s, 'a');
  s.api.insertLine(0);
  s.api.db.hold = true;
  s.api.back();                                      // Back's write is reading the record…
  await tick();
  assert.equal(s.held.length, 1);
  const reopening = s.api.open('a');                 // …when the text is opened again
  await tick();
  s.release();
  await reopening;
  await s.api.settle();
  assert.ok(s.api.MG.resumed, 'the draft is resumed');
  assert.equal(s.api.MG.lines.length, 4, 'with the edit Back kept — mgOpen waited for it before reading');
});

test('Start over keeps nothing of the work it throws away — not even an edit made while it cleared', async () => {
  const store = { a: rec('a', ['a one', 'a two', 'a three']) };
  const s = matcher(store);
  await opened(s, 'a');
  s.api.insertLine(0);
  s.api.back();
  await s.api.settle();
  await opened(s, 'a');                              // resumed: the notice offers Start over
  assert.ok(s.api.MG.resumed);
  s.api.insertLine(0);                               // 5 lines, the save waiting
  s.api.db.hold = true;
  const over = s.api.startOver();
  await tick();
  assert.equal(s.held.length, 1, 'the clear is reading the record');
  s.api.insertLine(0);                               // an edit lands while it reads — a save is waiting again
  s.release();
  await over;
  await s.api.settle();
  assert.equal(s.api.MG.lines.length, 3, 'begun again from the committed text');
  assert.ok(!s.api.MG.resumed);
  assert.equal(store.a.matchDraft, undefined, 'and no save of the thrown-away work landed after the clear');
});

test('…nor an autosave already reading when Start over cleared — answered after the clear, it stays out', async () => {
  const store = { a: rec('a', ['a one', 'a two', 'a three']) };
  const s = matcher(store);
  await opened(s, 'a');
  s.api.insertLine(0);
  s.api.back();
  await s.api.settle();
  await opened(s, 'a');                              // resumed, 4 lines
  s.api.insertLine(0);                               // 5
  s.api.db.hold = true;
  s.api.fire();                                      // the autosave starts reading…
  await tick();
  const over = s.api.startOver();                    // …and Start over clears while it does
  await tick();
  assert.equal(s.held.length, 2, 'two reads in flight: the autosave\'s, then the clear\'s');
  // Two reads may be answered in either order: the clear's first, the autosave's right behind it —
  // landing between the clear's put and Start over's close, which calls off too but comes too late.
  s.held.splice(1, 1)[0]();
  s.release();
  await over;
  await s.api.settle();
  assert.equal(s.api.MG.lines.length, 3, 'begun again from the committed text, not the thrown-away 5 lines');
  assert.ok(!s.api.MG.resumed);
  assert.equal(store.a.matchDraft, undefined, 'the clear called the autosave off');
});

test('Done leaves no draft — not even of an edit made while its own writes landed', async () => {
  const store = { a: rec('a', ['a one', 'a two', 'a three']) };
  const s = matcher(store);
  await opened(s, 'a');
  s.api.insertLine(0);                               // 4 lines: this is what Done commits
  s.api.db.hold = true;
  const done = s.api.commit();
  await tick();
  assert.equal(s.held.length, 1);
  s.held.shift()();                                  // mgCommit's read answered; it writes, then clears…
  await tick();
  assert.equal(s.held.length, 1, '…and the clear is reading');
  s.api.insertLine(0);
  s.release();
  await done;
  await s.api.settle();
  assert.equal(s.api.MG, null);
  assert.equal(store.a.doc.paragraphs.length, 4, 'committed');
  assert.equal(store.a.matchDraft, undefined, 'Done commits and clears: its close is not Back\'s');
});

test('a remote delete of the open text writes nothing back — a save waiting, or a write reading', async () => {
  for (const reading of [false, true]) {
    const store = { a: rec('a', ['a one', 'a two']) };
    const s = matcher(store);
    await opened(s, 'a');
    s.api.insertLine(0);
    if (reading) { s.api.db.hold = true; s.api.fire(); await tick(); assert.equal(s.held.length, 1); }
    await s.api.remoteDelete('a');
    s.release();
    s.api.fire();
    await s.api.settle();
    assert.equal(s.api.MG, null, 'the matcher is closed (#90)');
    assert.equal(store.a, undefined, `the text stays deleted (${reading ? 'a write was reading' : 'a save was waiting'})`);
  }
});

test('Back, then a remote delete while Back\'s draft is still on its way: the text stays deleted', async () => {
  const store = { a: rec('a', ['a one', 'a two']) };
  const s = matcher(store);
  await opened(s, 'a');
  s.api.insertLine(0);
  s.api.db.hold = true;
  s.api.back();                                      // Back hands the draft to storage; it is reading…
  await tick();
  assert.equal(s.held.length, 1);
  await s.api.remoteDelete('a');                     // …when the delete arrives, with no matcher open to close
  assert.equal(store.a, undefined);
  s.release();
  await s.api.settle();
  assert.equal(store.a, undefined, 'the draft write was called off: a put after the delete would put the text back');
});

test('the 🗑 on the open text\'s row (the Texts tab) deletes it with nothing written back', async () => {
  const store = { a: rec('a', ['a one', 'a two']) };
  const s = matcher(store);
  await opened(s, 'a');
  s.api.insertLine(0);                               // a save waiting as the 🗑 is answered
  s.api.db.hold = true;
  const del = s.api.userDelete('a');
  await tick();
  assert.equal(s.held.length, 1, 'the 🗑 reads the record it is about to delete');
  s.held.shift()();                                  // answered: it confirms, closes the matcher, deletes…
  await del;
  s.release();                                       // …and a draft write set off by that close would land now
  s.api.fire();
  await s.api.settle();
  assert.equal(s.api.MG, null);
  assert.equal(store.a, undefined, 'closed as a delete closes, not as Back: no draft write to put it back');
});

test('a draft write that fails says so, and the next one still runs', async () => {
  const store = { a: rec('a', ['a one', 'a two']) };
  const s = matcher(store);
  await opened(s, 'a');
  s.api.insertLine(0);
  s.log.failPut = true;
  s.api.back();
  await s.api.settle();
  assert.deepEqual(s.log.toasts, ['toast.storageFull'], 'the user is told');
  assert.equal(store.a.matchDraft, undefined, 'that write did not land');
  await opened(s, 'a');
  s.api.insertLine(0);
  s.api.back();
  await s.api.settle();
  assert.equal(drafted(store.a), 3, 'and the queue was not left stuck behind it');
});

test('v718: a look and then Back at once writes nothing — Back makes only a save mgSaveDraft scheduled', async () => {
  const store = { a: rec('a', ['a one', 'a two']) };
  const s = matcher(store);
  await s.api.open('a');
  assert.equal(s.api.pending(), 0, 'nothing scheduled: there is no work in it');
  s.api.back();
  await s.api.settle();
  assert.equal(store.a.matchDraft, undefined);
});

test('v718: a draft set aside by "Start from the text" survives Back — until an edit here, nothing overwrites it', async () => {
  const store = { a: rec('a', ['a one', 'a two', 'a three']) };
  const s = matcher(store);
  await opened(s, 'a');
  s.api.insertLine(0);
  s.api.back();
  await s.api.settle();
  const kept = JSON.stringify(store.a.matchDraft);
  store.a.doc.paragraphs[2].segments[0].baseline = 'a three, corrected in the editor';   // the text changes since
  s.log.fromText = true;
  await opened(s, 'a');                              // "this text has changed": Start from the text
  assert.ok(s.log.confirms.includes('mg.draftStale') && s.api.MG.holdDraft && !s.api.MG.resumed);
  s.api.back();
  await s.api.settle();
  assert.equal(JSON.stringify(store.a.matchDraft), kept, 'set aside, not overwritten: no draft while holdDraft');
  await opened(s, 'a');
  s.api.insertLine(0);                               // the first edit here: the user works from the text now
  s.api.back();
  await s.api.settle();
  assert.equal(drafted(store.a), 4, 'and from the first edit, the new work is the draft (3 lines + 1)');
});

test('v718: the draft Back writes carries the session\'s baseSig', async () => {
  const store = { a: rec('a', ['a one', 'a two']) };
  const s = matcher(store);
  await opened(s, 'a');
  const sig = s.api.MG.baseSig;
  assert.ok(sig && sig === s.api.sig(store.a.doc));
  s.api.insertLine(0);
  s.api.back();
  await s.api.settle();
  assert.equal(store.a.matchDraft.baseSig, sig, 'or a later visit could not tell the text had changed under it (case 22)');
});

/* A FLEx TEXT'S HARD LINE BREAKS (2026-10-17). The desktop shell gives each U+2028 segment a line of its own (readOnly,
 * no words, an empty baseline), and the record keeps it so. Here, through the Matcher's own open and Done: folded while
 * it is open, rows again on Done, the record exactly as the shell gave it — which is also what lets the code be rolled
 * back with nothing to do to any record. (flex-line-breaks.test.mjs has the pure halves; test_line_breaks.py the shell's.) */
function flexRec(id) {
  const w = (txt, i, sg) => ({ guid: 'an-' + txt + ':' + i, txt, punct: false, phrase: false, gls: '', preservedXML: [], flex: { analysisGuid: 'an-' + txt, index: i, seg: sg } });
  const seg = (g, words, extra = {}) => ({ attrs: { guid: g }, baseline: words.join(' '), words: words.map((x, i) => w(x, i, g)), free: '', freeLang: null,
    preItemsXML: [], postItemsXML: [], txtLang: 'qaa', flex: { segGuid: g, notes: [] }, ...extra });
  const line = (sg, para) => ({ guid: 'ln-' + sg.attrs.guid, paraOf: para, segments: [sg] });
  const doc = { title: id, vernLang: 'qaa', analLang: 'en', languages: [], timeEdges: true, flex: { textGuid: 'T', anals: ['en'] },
    paragraphs: [line(seg('A', ['aa']), 'P1'),
      // as LCM has a break: readOnly, an empty baseline, ONE analysis — a PunctuationForm whose form is U+2028
      line(seg('B1', [], { readOnly: true, words: [{ guid: 'pf:0', txt: '\u2028', punct: true, phrase: false, gls: '', preservedXML: [], flex: { analysisGuid: 'pf', index: 0, seg: 'B1' } }] }), 'P1'),
      line(seg('C', ['cc']), 'P1'), line(seg('D', ['dd']), 'P2')],
    segments: [{ start: 0, end: 900 }, { start: 0, end: 0, timePending: true }, { start: 1000, end: 1900 }, { start: 2000, end: 2900 }] };
  return storableRecord({ id, title: id, created: 1, modified: 1, doc });
}

test('a FLEx text: its line break is no row while the Matcher is open, and a row again on Done — the record as the shell gave it', async () => {
  const store = { f: flexRec('f') };
  const before = JSON.parse(JSON.stringify(store.f.doc));
  const s = matcher(store);
  await opened(s, 'f');
  assert.deepEqual(s.api.MG.lines.map((l) => l.phrases[0].attrs.guid), ['A', 'C', 'D'], 'three rows for three lines of text');
  assert.deepEqual(s.api.MG.lines[1].phrases[0].breaksBefore.map((b) => b.attrs.guid), ['B1'], 'the break rides on C, drawn as ↵');
  assert.equal(s.api.MG.spans.length, 3, 'and its empty audio row went with it: row i is audio i');
  await s.api.commit();
  await s.api.settle();
  assert.deepEqual(store.f.doc.paragraphs.map((p) => [p.guid, p.paraOf, p.segments]), before.paragraphs.map((p) => [p.guid, p.paraOf, p.segments]),
    'every line back, the break its own again, with its own guid and paragraph — nothing hung on C');
  assert.deepEqual(store.f.doc.segments.map((x) => (x.timePending ? null : [x.start, x.end])), [[0, 900], null, [1000, 1900], [2000, 2900]]);
});

test('a FLEx text: a join across its line break is refused, and a free translation beside it saves with the break in place', async () => {
  const store = { f: flexRec('f') };
  const s = matcher(store);
  await opened(s, 'f');
  s.api.join(s.api.MG.lines[1].id);                  // C onto A, across B1
  assert.equal(s.api.MG.lines.length, 3, 'refused');
  assert.ok(s.log.toasts.includes('mg.joinLineBreak'), 'and said why');
  s.api.editFree(s.api.MG.lines[1].id, 'the third line');
  await s.api.commit();
  await s.api.settle();
  const segs = store.f.doc.paragraphs.map((p) => p.segments[0]);
  assert.deepEqual(segs.map((x) => x.attrs.guid), ['A', 'B1', 'C', 'D']);
  assert.equal(FT.freeIn(segs[2], 'en', 'en'), 'the third line');
  assert.ok(!segs.some((x) => x.breaksBefore || x.breaksAfter || x.flexLine), 'no fold left in the record');
});

test('a FLEx text: a draft an older build saved holds the break as a row — resumed, it is folded the same way', async () => {
  const store = { f: flexRec('f') };
  const s0 = matcher(store);
  const sig = s0.api.sig(store.f.doc);
  const d = store.f.doc;
  store.f.matchDraft = { at: 5, baseSig: sig,
    lines: d.paragraphs.map((p, i) => ({ id: 'ln' + i, phrases: p.segments, guid: p.guid, paraOf: p.paraOf })),
    spans: d.segments.map((x, i) => ({ id: 'sp' + i, ...x })) };
  const s = matcher(store);
  await opened(s, 'f');
  assert.equal(s.api.MG.resumed, 5, 'the draft was resumed');
  assert.deepEqual(s.api.MG.lines.map((l) => l.phrases[0].attrs.guid), ['A', 'C', 'D'], 'its break row folded as mgLoad folds one');
  assert.equal(s.api.MG.spans.length, 3);
});
