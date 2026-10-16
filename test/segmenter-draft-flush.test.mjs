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
 *   · a write that fails says so, and the next one still runs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as FT from '../docs/js/flextext.js';
import { docSegments } from '../docs/js/segment-strips.js';
import { liftAll, liftDecl } from './lib/lift.mjs';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setImmediate(r));

// mgDraw is a DOM builder; the line of it that matters here is its autosave, reproduced in the harness
// and checked to be there, so the stub cannot drift from what ships. Back is the exit with the default.
assert.match(liftDecl(APP, 'mgDraw'), /\n  mgSaveDraft\(\);\n/);
assert.match(APP, /\$\('#mg-back'\)\.onclick = \(\) => mgClose\(\);/);

function matcher(store) {
  const log = { toasts: [], renders: [], failPut: false };
  const held = [];   // gets made while db.hold is set, waiting to be answered (each with what it read)
  const api = new Function('env', `
    const { FT, docSegments, store, log, held } = env;
    const { makeSegment, mergePhrases, newGuid } = FT;
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
        store[r.id] = clone(r);
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
    const confirmDialog = async () => true;
    const $ = () => null, show = () => {};
    const healFlatSegments = () => false, mgPrepareAudio = () => {}, mgStopTicker = () => {};
    // what the list would show: each text's draft, by its number of lines
    const sgRenderList = () => log.renders.push(Object.fromEntries(Object.keys(store).map((k) =>
      [k, store[k].matchDraft ? store[k].matchDraft.lines.length : null])));
    const refreshList = () => {}, renderUploadQueue = () => {}, splitCancel = () => {}, leaveEditor = () => {};
    const getUpload = () => null, uploadView = new Map();
    const Sync = { workerUploadTarget: () => false, reportNow() {} };
    async function uploadDocById() {}
    function mgDraw() { if (!MG) return; mgSaveDraft(); }
    ${liftAll(APP, ['docStats', 'mgLoad', 'mgDraftTimer', 'mgSaveDraft', 'mgDraftWrites', 'mgDraftCallOffs',
      'mgWriteDraft', 'mgFlushDraft', 'mgCallOffDraft', 'mgClearDraft', 'MG_UNDO_MAX', 'mgSnap', 'mgCapture',
      'mgInsertLine', 'mgLinePhrase', 'mgEditFree', 'mgCommit', 'mgClose', 'mgStartOver', 'mgOpen',
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
      insertLine: (after) => mgInsertLine(after), editFree: (id, v) => mgEditFree(id, v),
      remoteDelete: (id) => deleteUploadedDoc(id), userDelete: (id) => userDeleteDoc(id, id),
    };
  `)({ FT, docSegments, store, log, held });
  const release = () => { api.db.hold = false; while (held.length) held.shift()(); };
  return { api, log, held, release };
}

function rec(id, lines) {
  const doc = FT.makeDoc({ vernLang: 'fau', analLang: 'id' });
  FT.reconcileBaseline(doc, lines);
  return { id, title: id, created: 1, modified: 1, doc };
}
const drafted = (r) => (r && r.matchDraft ? r.matchDraft.lines.length : null);
// Open a text and let its own autosave land: the user has been on the screen a while.
async function opened(s, id) { await s.api.open(id); s.api.fire(); await s.api.settle(); }

test('an edit and then Back at once: the draft is stored with the edit, and the row says so', async () => {
  const store = { a: rec('a', ['a one', 'a two', 'a three']) };
  const s = matcher(store);
  await opened(s, 'a');
  assert.equal(drafted(store.a), 3);
  s.api.insertLine(0);                               // + a line: mgInsertLine → mgDraw → mgSaveDraft
  assert.equal(s.api.pending(), 1, 'the save is still waiting out its 400 ms');
  const added = s.api.MG.lines[1].id;
  s.api.back();
  assert.equal(s.api.pending(), 0, 'Back made the save; nothing is left to fire later');
  await s.api.settle();
  assert.equal(drafted(store.a), 4, 'the draft holds the line added just before Back (it held 3)');
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
  assert.equal(drafted(store.b), 3, 'b\'s own autosave is b\'s');
  assert.equal(drafted(store.a), 3, 'and does not touch a — it used to fire against the new MG, a\'s edit gone');
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
  assert.equal(drafted(store.a), 2, 'that write did not land');
  await opened(s, 'a');
  s.api.insertLine(0);
  s.api.back();
  await s.api.settle();
  assert.equal(drafted(store.a), 3, 'and the queue was not left stuck behind it');
});
