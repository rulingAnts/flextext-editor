/* THE v709 RE-SEND — once per text, never again (Seth, 2026-10-10: "devices re-send any text whose
 * last upload was on 9–10 Oct, so Drive stops holding copies without their empty segments").
 *
 * v709 wrote every .flextext/EAF without its silent lines. The device's copy was untouched; its
 * UPLOADS were not, and "already on Drive" keeps that copy the newest until the text changes (#111).
 * v709ResendSweep (app.js) queues one ordinary Lane B upload for each text that needs it, and every
 * path that removes a text treats such a copy as NOT a backup until a complete one has landed
 * (v709CopyMayBeOnDrive).
 *
 * What is measured here, with the REAL functions lifted out of app.js (and DriveUpload.emit out of
 * upload.js) and run against an in-memory IndexedDB:
 *   - which texts are re-sent and which are not (the rules in the app.js header);
 *   - the predicate is v709's own isSilentPhrase (f579e92c), answer for answer;
 *   - idempotence: a second scan, a second boot, and a re-send that has LANDED never queue again;
 *   - a landed re-send never auto-deletes and never toasts — the control (an ordinary upload with
 *     the same settings) does delete, so the test can fail;
 *   - EVERY removal path (uploadDelete, delete, the 🗑, Done + auto-delete, "Done – send", the boot
 *     sweep of pending removals) keeps a text whose Drive copy may be v709's, and its queued re-send,
 *     until a complete copy lands — with a control per path showing it still removes everything else;
 *   - a bundle an older engine queued (no `engine`) that lands removes nothing while it may be v709's
 *     bytes, and the re-send follows on the same page;
 *   - offline; unpaired / researcher panel; the Send menu's Upload button is not the upload gate;
 *   - the doc's content and `modified` are never changed.
 * Run: node --test test/v709-resend.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const upl = readFileSync(new URL('../docs/js/upload.js', import.meta.url), 'utf8');

const fn = (name) => {
  const m = app.match(new RegExp(`\\n(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`${name} not found in app.js`);
  return m[0];
};
const constLine = (name) => {
  const m = app.match(new RegExp(`\\nconst ${name} = [^\\n]*;`));
  if (!m) throw new Error(`const ${name} not found in app.js`);
  return m[0];
};
// One `case` of syncDispatch's switch, lifted verbatim (from its label up to the next one's).
const caseBlock = (from, to) => {
  const a = app.indexOf(from);
  const b = a < 0 ? -1 : app.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`case block ${from.trim()} not found in app.js`);
  return app.slice(a, b);
};
// DriveUpload.emit — the object the completion point receives — lifted as a method.
const emitSrc = (upl.match(/\n {2}emit\(\) \{[\s\S]*?\n {2}\}/) || [''])[0];
const realEmit = new Function(`return ({${emitSrc}}).emit;`)();

/* v709's predicate, as f579e92c shipped it (docs/js/flextext.js, removed again by v714). Quoted so
 * the comparison below does not depend on git history being present in the checkout. */
const V709_NOTE = /type="note"[^>]*>audio ~?\d+:\d\d\.\d{3}/;
function isSilentPhraseV709(seg) {
  if (!seg) return false;
  if ((seg.words || []).length) return false;
  if (String(seg.baseline || '').trim() || String(seg.free || '').trim()) return false;
  if ((seg.preItemsXML || []).length) return false;
  if ((seg.postItemsXML || []).some((x) => !V709_NOTE.test(x))) return false;
  return true;
}

const UPLOAD_DELETE_CASE = caseBlock("    case 'uploadDelete': {", "    case 'triggerUpload': {");
const DELETE_CASE = caseBlock("    case 'delete':\n", "    case 'setDone':");
const PENDING_KEY = 'flextext-pending-upload-delete';

const LIFT = ['V709_DEPLOYED_AT', 'V709_OUR_NOTE', 'PENDING_UPDEL_KEY'].map(constLine).join('\n') + '\n'
  + ['cheapHash', 'uploadContentSig', 'v709DroppedPhrase', 'v709CopyMayBeOnDrive', 'v709ResendWanted',
     'v709ResendSweep', 'v709ResendScan', 'uploadDocById', 'uploadState', 'pumpUploads',
     'deleteUploadedDoc', 'deleteConfirmedDoc', 'pendingUpDel', 'setPendingUpDel', 'sweepPendingUpDel',
     'userDeleteDoc', 'setDocDone', 'doUpload'].map(fn).join('\n');

/* One "page load": module state starts fresh (as it does on a real boot), the stored records, the
 * queue and localStorage persist in `store`, which the caller can carry into the next harness. */
function boot(store, env = {}) {
  store.ls = store.ls || new Map();
  const make = new Function('store', 'env', `
    const RESEARCHER_MODE = !!env.researcher, CROWD_MODE = !!env.crowd;
    const RECORD_MODE = false, CONSENT_MODE = false, SEGMENTER_MODE = false, MG = null;
    const ENGINE_VERSION = 'v999';
    const navigator = { onLine: env.online !== false };
    const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
    let current = env.current ? clone(store.docs.get(env.current)) : null;
    let activeTab = 'gloss';
    let returnAfterUploadOf = null;
    let v709ResendSettled = false;
    let v709ResendRunning = false;
    const uploadView = new Map();
    const calls = [];
    const console = { warn() { calls.push('warn'); }, log() {} };
    const localStorage = {
      getItem: (k) => (store.ls.has(k) ? store.ls.get(k) : null),
      setItem: (k, v) => { store.ls.set(k, String(v)); },
      removeItem: (k) => { store.ls.delete(k); },
    };
    const db = {
      listDocs: async () => [...store.docs.values()].map((d) => ({ id: d.id, title: d.title,
        modified: d.modified, uploadedFileId: d.uploadedFileId || null, uploadedModified: d.uploadedModified || 0 })),
      getDoc: async (id) => clone(store.docs.get(id) || null),
      putDoc: async (r) => { calls.push('putDoc:' + r.id); store.docs.set(r.id, clone(r)); },
      getMedia: async (k) => store.media.get(k) || null,
      putMedia: async (k, v) => { calls.push('queue:' + k); store.media.set(k, v); },
      deleteMedia: async (k) => { store.media.delete(k); },
      // As docs/js/db.js: the record AND everything keyed to it — its queued Lane B upload included.
      deleteDoc: async (id) => {
        calls.push('DELETE:' + id);
        for (const k of [id, 'partial:' + id, 'upload:' + id, 'consent:' + id, 'consent-prompt:' + id]) store.media.delete(k);
        store.docs.delete(id);
      },
    };
    const Sync = {
      workerUploadTarget: () => (env.paired === false ? null : { url: 'https://worker.test/upload', headers: {} }),
      reportNow: () => { calls.push('reportNow'); },
      enrollment: () => null,
    };
    function allowedSend() { return new Set(env.sendOptions || ['share', 'upload', 'save']); }
    function getUpload(id) { return (env.inFlight || []).includes(id) ? { id, cancel() { calls.push('cancel:' + id); } } : null; }
    async function buildBundleFor(rec) {
      calls.push('build:' + rec.id);
      return { blob: { size: 42 }, filename: (rec.title || 'text') + '.flextext', mime: 'application/xml' };
    }
    async function queueMediaUpload(id) { calls.push('laneA:' + id); }
    function renderUploadQueue() {}
    function refreshList() {}
    function applyDoneButton() {}
    function applyBaseline() {}
    function splitCancel() {}
    function leaveEditor() {}
    function show() {}
    function mgClose() {}
    const $ = () => null;
    class DriveUpload { constructor(id, rec) { this.id = id; this.rec = rec; } start() { calls.push('start:' + this.id); } }
    function deleteAfterUpload() { return env.autoDelete === true; }
    async function confirmDialog(msg) { calls.push('confirm:' + msg); return env.confirm !== false; }
    // As app.js: bumps modified unconditionally, writes the open text.
    async function persist() { if (!current) return; current.modified = Date.now(); store.docs.set(current.id, clone(current)); }
    function returnToLibraryAfterSend() { calls.push('returnToList'); }
    function toast(msg) { calls.push('toast:' + msg); }
    const t = (k) => k;
    ${LIFT}
    async function runCmd(cmd) {
      switch (cmd && cmd.type) {
${UPLOAD_DELETE_CASE}${DELETE_CASE}      }
    }
    return { v709ResendSweep, v709ResendWanted, v709DroppedPhrase, v709CopyMayBeOnDrive, uploadState,
      uploadView, calls, uploadContentSig, V709_DEPLOYED_AT, runCmd, userDeleteDoc, setDocDone, doUpload,
      sweepPendingUpDel, pendingUpDel, get settled() { return v709ResendSettled; } };
  `);
  return make(store, env);
}

const AT = Date.parse('2026-10-08T22:31:19Z');
const HOUR = 3600e3;
const NOTE = '<item type="note" lang="en">audio 0:01.000–0:02.500</item>';
const spoken = (w) => ({ baseline: w, words: [{ txt: w, gls: 'x' }], free: '', preItemsXML: [], postItemsXML: [] });
const silent = () => ({ baseline: '', words: [], free: '', preItemsXML: [], postItemsXML: [NOTE] });
const para = (seg, guid) => ({ guid, segments: [seg] });

/* A stored record shaped like the device's. `sigOf` is the REAL uploadContentSig, so "unchanged
 * since upload" is decided exactly as the app decides it. */
function rec(id, { lines, uploadedAt, uploaded = true, engine, changed = false, resent, done = false } = {}, sigOf) {
  const r = {
    id, title: 'Text ' + id, created: AT - 50 * HOUR, modified: AT - 40 * HOUR, done,
    doc: { title: 'Text ' + id, paragraphs: lines.map((s, i) => para(s, `${id}-p${i}`)), segments: lines.map((_, i) => ({ start: i * 1000, end: i * 1000 + 900 })) },
  };
  if (uploaded) {
    r.uploadedFileId = 'drive-' + id;
    r.uploadedAt = uploadedAt;
    r.uploadedModified = r.modified;
    r.uploadedSig = sigOf(r);
  }
  if (engine !== undefined) r.uploadedEngine = engine;
  if (resent) r.resentV709At = resent;
  if (changed) { r.modified += HOUR; r.doc.paragraphs[0].segments[0].baseline += ' edited'; r.doc.paragraphs[0].segments[0].words.push({ txt: 'edited', gls: 'y' }); }
  return r;
}
const SIG = boot({ docs: new Map(), media: new Map() }).uploadContentSig;

function corpus() {
  const docs = new Map();
  const add = (id, o) => docs.set(id, rec(id, o, SIG));
  // AFFECTED — uploaded inside v709's window or after it, unchanged, holding a silent line.
  add('A1', { lines: [spoken('ba'), silent(), spoken('do')], uploadedAt: AT + 2 * HOUR });
  add('A2', { lines: [silent(), spoken('ka')], uploadedAt: AT, done: true });            // AT exactly; a Done text
  add('A3', { lines: [spoken('ma'), silent()], uploadedAt: AT + 30 * 24 * HOUR });      // a late v709 bundle, a month on
  // NOT affected — one rule each.
  add('N1', { lines: [spoken('ba'), silent()], uploadedAt: AT - 1 });                   // last upload before v709
  add('N2', { lines: [spoken('ba'), silent()], uploaded: false });                      // never uploaded
  add('N3', { lines: [spoken('ba'), spoken('di')], uploadedAt: AT + HOUR });             // no silent line
  add('N4', { lines: [spoken('ba'), silent()], uploadedAt: AT + HOUR, changed: true });  // edited since the upload
  add('N5', { lines: [spoken('ba'), silent()], uploadedAt: AT + HOUR, engine: 'v720' }); // built by an engine with this pass
  add('N6', { lines: [spoken('ba'), silent()], uploadedAt: AT + HOUR, resent: AT + 40 * HOUR }); // already re-sent
  // A "blank" line that carries an imported note is somebody's data: v709 wrote it, so nothing was lost.
  add('N7', { lines: [spoken('ba'), { ...silent(), postItemsXML: ['<item type="note" lang="en">pause, then laughter</item>'] }], uploadedAt: AT + HOUR });
  return docs;
}
// One text whose Drive copy may be v709's: a silent line, last upload inside the window, unchanged.
const suspect = (id, o = {}) => rec(id, { lines: [spoken('ba'), silent(), spoken('do')], uploadedAt: AT + 2 * HOUR, ...o }, SIG);
const storeOf = (...recs) => ({ docs: new Map(recs.map((r) => [r.id, r])), media: new Map(), ls: new Map() });
const upDel = (store) => JSON.parse(store.ls.get(PENDING_KEY) || '[]');
const settle = () => new Promise((r) => setTimeout(r, 20));
const queuedIds = (store) => [...store.media.keys()].filter((k) => k.startsWith('upload:')).map((k) => k.slice(7)).sort();
/* An upload lands: upload.js deletes the queued record, then emits; the REAL emit builds what the
 * REAL completion point receives. */
function land(h, store, id, fileId) {
  const queued = store.media.get('upload:' + id);
  assert.ok(queued, `a queued record for ${id} to land`);
  store.media.delete('upload:' + id);
  let st;
  realEmit.call({ rec: queued, status: 'done', indeterminate: false, errorMessage: null, uploadedFileId: fileId, uploadedFolderId: 'folder-' + id, onState: (s) => { st = s; } });
  h.uploadState(id)(st);
}

test('the source: one predicate, one cutoff, wired into every sweep, the stamp at the completion point', () => {
  assert.equal(new Function(`${constLine('V709_DEPLOYED_AT')}; return V709_DEPLOYED_AT;`)(), Date.parse('2026-10-08T22:31:19Z'),
    'the cutoff is v709\'s production deploy, 2026-10-08T22:31:19Z');
  const sweeps = app.match(/autoBackupSweep\(\)\.then\(sweepPendingUpDel\)\.catch\(\(\) => \{\}\)\.then\(v709ResendSweep\)\.catch\(\(\) => \{\}\);/g) || [];
  assert.equal(sweeps.length, 3, 'boot, the online edge and the 90 s timer all run it');
  assert.equal((app.match(/autoBackupSweep\(\)\.then\(sweepPendingUpDel\)\.catch\(\(\) => \{\}\);/g) || []).length, 0, 'no sweep site was left without it');

  const q = fn('uploadDocById');
  assert.match(q, /engine: ENGINE_VERSION,/, 'every Lane B record names the engine that BUILT its bytes');
  assert.match(q, /\.\.\.\(opts\.resend \? \{ resend: String\(opts\.resend\) \} : \{\}\)/, 'and only the re-send carries `resend`');
  assert.match(q, /docDone: !!rec\.done,/, 'docDone stays the doc\'s real state, so the Drive "done" marker is untouched');

  assert.match(emitSrc, /engine: this\.rec\.engine,/, 'DriveUpload.emit hands `engine` to the completion point');
  assert.match(emitSrc, /resend: this\.rec\.resend,/, '…and `resend`');

  const st = fn('uploadState');
  assert.match(st, /d\.uploadedEngine = st\.engine \|\| '';/, 'the landing stamps uploadedEngine — \'\' for a record that predates the field');

  const sw = fn('v709ResendScan');
  assert.match(sw, /if \(!Sync\.workerUploadTarget\(\)\) return;/, 'paired and approved — or nothing');
  assert.doesNotMatch(sw, /allowedSend\(\)/, 'the Send menu\'s Upload button is not the upload gate: Done, auto-backup and the researcher\'s commands upload without it');
  assert.ok(sw.indexOf("uploadDocById(d.id, { resend: 'v709' })") < sw.indexOf('fresh.resentV709At = Date.now()'),
    'the mark goes on AFTER the bytes are queued');
  const code = (sw + fn('v709ResendWanted') + fn('v709ResendSweep') + fn('v709CopyMayBeOnDrive')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /\.modified\s*=[^=]|\.doc\s*=[^=]|persist\(/, 'it never assigns modified or doc, and never persists the open text');
  assert.match(code, /fresh\.resentV709At = Date\.now\(\); await db\.putDoc\(fresh\)/, '(its one write is the mark, on a fresh read)');

  // Every removal path asks the one predicate — the behaviour is measured below, path by path.
  for (const f of ['deleteConfirmedDoc', 'sweepPendingUpDel', 'userDeleteDoc', 'setDocDone', 'doUpload', 'uploadState']) {
    assert.match(fn(f), /v709CopyMayBeOnDrive\(/, `${f} asks v709CopyMayBeOnDrive`);
  }
  assert.match(UPLOAD_DELETE_CASE, /v709CopyMayBeOnDrive\(/, 'and so does the uploadDelete command');
});

test('the predicate is v709\'s own isSilentPhrase, answer for answer', () => {
  const h = boot({ docs: new Map(), media: new Map() });
  const cases = [
    null, undefined, {}, silent(), spoken('ba'),
    { baseline: '  ', words: [], free: '' },
    { baseline: '', words: [], free: 'a translation' },
    { baseline: '', words: [], free: '   ' },
    { baseline: '', words: [{ txt: '' }], free: '' },
    { baseline: '', words: [], free: '', preItemsXML: ['<item type="segnum">3</item>'] },
    { baseline: '', words: [], free: '', postItemsXML: [NOTE] },
    { baseline: '', words: [], free: '', postItemsXML: ['<item type="note" lang="en">audio ~0:01.000–0:02.500</item>'] },
    { baseline: '', words: [], free: '', postItemsXML: [NOTE, '<item type="lit" lang="en">literal</item>'] },
    { baseline: '', words: [], free: '', postItemsXML: ['<item type="note" lang="en">a real note</item>'] },
  ];
  for (const c of cases) assert.equal(h.v709DroppedPhrase(c), isSilentPhraseV709(c), JSON.stringify(c));
  assert.equal(h.v709DroppedPhrase(silent()), true, '(and a blank line with only our own timing note IS silent)');
});

test('affected texts are queued once, through the ordinary Lane B queue; nothing else is', async () => {
  const store = { docs: corpus(), media: new Map() };
  const before = JSON.parse(JSON.stringify([...store.docs.values()]));
  const h = boot(store);
  await h.v709ResendSweep();
  await settle();
  assert.deepEqual(queuedIds(store), ['A1', 'A2', 'A3'], 'exactly the three affected texts');
  for (const id of ['A1', 'A2', 'A3']) {
    const q = store.media.get('upload:' + id);
    assert.equal(q.resend, 'v709', `${id}: flagged as the re-send`);
    assert.equal(q.engine, 'v999', `${id}: names the engine that built it`);
    assert.equal(q.docId, id, `${id}: same wire identity as any Lane B upload`);
    assert.equal(q.docFolderId, '', `${id}: (no remembered folder in this fixture)`);
    assert.ok(Number(store.docs.get(id).resentV709At) > 0, `${id}: marked as re-sent`);
  }
  assert.equal(store.media.get('upload:A2').docDone, true, 'a Done text stays Done on Drive — docDone is its real state');
  assert.ok(!h.calls.some((c) => c.startsWith('laneA:')), 'no recording rides along: these texts were uploaded before');
  assert.ok(!h.calls.some((c) => /^(toast|DELETE)/.test(c)), 'queueing showed nothing and deleted nothing');
  for (const b of before) {
    const a = store.docs.get(b.id);
    assert.deepEqual(a.doc, b.doc, `${b.id}: content untouched`);
    assert.equal(a.modified, b.modified, `${b.id}: modified untouched`);
    const { resentV709At, ...rest } = a;
    const { resentV709At: was, ...restB } = b;
    assert.deepEqual(rest, restB, `${b.id}: nothing but the mark changed on the record`);
    if (!['A1', 'A2', 'A3'].includes(b.id)) assert.equal(resentV709At, was, `${b.id}: not marked`);
  }
  assert.equal(h.settled, true, 'a scan with nothing left to revisit settles for this page load');
  assert.ok(h.calls.some((c) => c.startsWith('start:')), 'online and paired: the pump starts the first one');
  // Which texts may hold a v709 copy is wider than which are re-sent: an edited text still has
  // one on Drive (its next send fixes it), and one already re-sent is suspect until that lands.
  const may = [...store.docs.values()].filter((d) => h.v709CopyMayBeOnDrive(d)).map((d) => d.id).sort();
  assert.deepEqual(may, ['A1', 'A2', 'A3', 'N4', 'N6'], 'v709CopyMayBeOnDrive: inside the window, unstamped, a silent line — changed or not, re-sent or not');
});

test('idempotent: a second scan, a second boot, and a re-send that has landed queue nothing', async () => {
  const store = { docs: corpus(), media: new Map() };
  const h1 = boot(store);
  await h1.v709ResendSweep();
  const first = queuedIds(store);
  await h1.v709ResendSweep();                                    // same page, settled
  assert.deepEqual(queuedIds(store), first);

  // Next boot with the three re-sends still queued: the queue records and the marks both hold them.
  const h2 = boot(store);
  await h2.v709ResendSweep();
  assert.equal(h2.calls.filter((c) => c.startsWith('queue:')).length, 0, 'nothing re-queued over a pending re-send');

  // They land: run the REAL completion point on what the REAL DriveUpload.emit would hand it.
  const h3 = boot(store, { autoDelete: true });
  for (const id of first) land(h3, store, id, 'drive2-' + id);
  await settle();
  for (const id of first) {
    assert.equal(store.docs.get(id).uploadedEngine, 'v999', `${id}: the landing stamped the engine that built it`);
    assert.equal(store.docs.get(id).uploadedFileId, 'drive2-' + id, `${id}: proof-of-backup stamped as for any upload`);
    assert.equal(h3.v709CopyMayBeOnDrive(store.docs.get(id)), false, `${id}: no longer suspect — removals work as before`);
  }
  // Even with the mark gone (say a persist() wrote an older copy back), uploadedEngine rules it out.
  for (const id of first) { const d = store.docs.get(id); delete d.resentV709At; }
  const h4 = boot(store);
  await h4.v709ResendSweep();
  assert.equal(h4.calls.filter((c) => c.startsWith('queue:')).length, 0, 'a text whose re-send landed is never re-sent');
  assert.equal(h4.settled, true);
});

test('a landed re-send never auto-deletes and never toasts — an ordinary upload with the same settings does both', async () => {
  for (const resend of [true, false]) {
    const store = { docs: corpus(), media: new Map() };
    const h = boot(store, { autoDelete: true });                 // the researcher's auto-delete is ON
    const d = store.docs.get('A2');                              // and the text is Done
    store.media.set('upload:A2', { name: 'Text A2.flextext', docId: 'A2', docModified: d.modified, docSig: h.uploadContentSig(d),
      docDone: true, engine: 'v999', ...(resend ? { resend: 'v709' } : {}) });
    land(h, store, 'A2', 'drive2');
    await settle();
    const deleted = h.calls.includes('DELETE:A2');
    const toasted = h.calls.some((c) => c.startsWith('toast:'));
    if (resend) {
      assert.equal(deleted, false, 're-send: no auto-delete, though deleteAfterUpload() is on and the text is Done');
      assert.equal(toasted, false, 're-send: no toast on the coworker\'s screen');
      assert.equal(store.docs.get('A2').uploadedFileId, 'drive2', 're-send: the proof-of-backup is still stamped');
    } else {
      assert.equal(deleted, true, 'control: the same settings DO auto-delete an ordinary upload (so this test can fail)');
      assert.equal(toasted, true, 'control: and an ordinary upload toasts');
    }
  }
});

test('offline: queued and marked, nothing starts; the queue carries it when the connection returns', async () => {
  const store = { docs: corpus(), media: new Map() };
  const h = boot(store, { online: false });
  await h.v709ResendSweep();
  assert.deepEqual(queuedIds(store), ['A1', 'A2', 'A3'], 'queued while offline — the ordinary queue holds it');
  assert.ok(!h.calls.some((c) => c.startsWith('start:')), 'and no upload was started');
  assert.ok(store.docs.get('A1').resentV709At, 'marked: the queued record is now the re-send, retried forever like any upload');
  const h2 = boot(store, { online: true });                      // a later boot, online
  await h2.v709ResendSweep();
  assert.equal(h2.calls.filter((c) => c.startsWith('queue:')).length, 0, 'not queued a second time');
});

test('nothing at all when the device is not paired, or is the researcher panel / crowd app', async () => {
  for (const env of [{ paired: false }, { researcher: true }, { crowd: true }]) {
    const store = { docs: corpus(), media: new Map() };
    const h = boot(store, env);
    await h.v709ResendSweep();
    assert.deepEqual(queuedIds(store), [], JSON.stringify(env) + ': nothing queued');
    assert.ok(![...store.docs.values()].some((d) => d.resentV709At && !['N6'].includes(d.id)), JSON.stringify(env) + ': nothing marked');
    assert.equal(h.settled, false, JSON.stringify(env) + ': not settled — it runs again once that changes');
  }
  // Paired later (same page): the next sweep does the work.
  const store = { docs: corpus(), media: new Map() };
  const env = { paired: false };
  const h = boot(store, env);
  await h.v709ResendSweep();
  env.paired = true;
  await h.v709ResendSweep();
  assert.deepEqual(queuedIds(store), ['A1', 'A2', 'A3'], 'once paired, the sweep re-sends');
});

test('a paired device whose Send menu has no Upload button still re-sends — Done, auto-backup and the researcher\'s commands upload from it too', async () => {
  const store = { docs: corpus(), media: new Map() };
  const h = boot(store, { sendOptions: ['share', 'save'] });
  await h.v709ResendSweep();
  assert.deepEqual(queuedIds(store), ['A1', 'A2', 'A3'], 'sendOptions only shapes the Send menu; uploadedFileId already proves this device uploads');
});

test('an open text, or one already queued or in flight, waits — unmarked — for a later sweep', async () => {
  const store = { docs: corpus(), media: new Map() };
  store.media.set('upload:A3', { blob: { size: 1 }, name: 'Text A3.flextext', docId: 'A3' });   // a bundle queued by an older engine
  const h = boot(store, { current: 'A1', inFlight: ['A2'] });
  await h.v709ResendSweep();
  assert.equal(h.calls.filter((c) => c.startsWith('queue:')).length, 0, 'none of the three is queued now');
  for (const id of ['A1', 'A2', 'A3']) assert.equal(store.docs.get(id).resentV709At, undefined, `${id}: not marked`);
  assert.equal(store.media.get('upload:A3').resend, undefined, 'the older queued record is left as it was');
  assert.equal(h.settled, false, 'not settled: the 90 s sweep looks again');

  // The older bundle lands UNSTAMPED (it predates `engine`) — so it may be one v709 built: re-send it.
  const d3 = store.docs.get('A3');
  store.media.set('upload:A3', { ...store.media.get('upload:A3'), docModified: d3.modified, docSig: h.uploadContentSig(d3), docDone: false });
  land(h, store, 'A3', 'drive-late');
  await settle();
  assert.equal(store.docs.get('A3').uploadedEngine, '', 'a record that predates the field lands with uploadedEngine \'\'');
  const h2 = boot(store);
  await h2.v709ResendSweep();
  assert.deepEqual(queuedIds(store), ['A1', 'A2', 'A3'], 'next boot: all three re-sent, the late bundle included');
});

/* ---- REMOVALS: a copy that may be v709's is not a backup until a complete one has landed ---- */

test("removal waits (a): the researcher's Remove / Move (uploadDelete) while the re-send waits in the queue", async () => {
  const store = storeOf(suspect('A'));
  const h = boot(store, { online: false });
  await h.v709ResendSweep();
  assert.equal(store.media.get('upload:A')?.resend, 'v709', '(a) re-send queued');
  await h.runCmd({ type: 'uploadDelete', docId: 'A' });
  await settle();
  assert.ok(store.docs.has('A'), '(a) the text is kept: the copy on Drive may be the one without its silent lines');
  assert.equal(store.media.get('upload:A')?.resend, 'v709', '(a) and so is its queued re-send');
  assert.deepEqual(upDel(store), ['A'], '(a) the request waits for the re-send');
  land(h, store, 'A', 'drive-full-A');
  await settle();
  assert.equal(store.docs.has('A'), false, '(a) the re-send landed, so the request completes');
  assert.ok(h.calls.lastIndexOf('putDoc:A') < h.calls.indexOf('DELETE:A'), '(a) …after the complete copy was stamped as the backup');
  assert.deepEqual(upDel(store), []);
});

test('removal waits (b): the same request handled before the sweep — a fresh copy first, then the removal', async () => {
  const store = storeOf(suspect('A'));
  const h = boot(store);
  await h.runCmd({ type: 'uploadDelete', docId: 'A' });
  assert.ok(store.docs.has('A'), '(b) kept');
  const q = store.media.get('upload:A');
  assert.ok(q && q.engine === 'v999' && !q.resend, '(b) a fresh copy is queued, built by this engine');
  await h.v709ResendSweep();
  assert.equal(h.calls.filter((x) => x === 'queue:upload:A').length, 1, '(b) the sweep does not queue a second one');
  land(h, store, 'A', 'drive-full-A');
  await settle();
  assert.equal(store.docs.has('A'), false, '(b) removed once that copy landed');
});

test("removal waits (c): the coworker's own 🗑 while the re-send waits — upload-first, nothing cancelled", async () => {
  const store = storeOf(suspect('A'));
  const h = boot(store, { online: false });
  await h.v709ResendSweep();
  await h.userDeleteDoc('A', 'Text A');
  assert.ok(h.calls.includes('confirm:texts.confirmDeleteUpload'), '(c) the coworker is asked the upload-first question');
  assert.ok(store.docs.has('A'), '(c) kept');
  assert.equal(store.media.get('upload:A')?.resend, 'v709', '(c) the queued re-send is not cancelled');
  assert.ok(!h.calls.some((x) => x.startsWith('cancel:')), '(c) nothing cancelled');
  assert.deepEqual(upDel(store), ['A'], '(c) removed once it lands');
});

test('removal waits (d): Done with auto-delete on, while the re-send waits — a fresh copy, removed when it lands', async () => {
  const store = storeOf(suspect('A'));
  const h = boot(store, { online: false, autoDelete: true });
  await h.v709ResendSweep();
  await h.setDocDone('A', true);
  assert.ok(store.docs.has('A'), '(d) not removed at once');
  const q = store.media.get('upload:A');
  assert.ok(q && q.engine === 'v999' && q.docDone === true && !q.resend, '(d) Done sends a fresh copy, as for any text not on Drive');
  land(h, store, 'A', 'drive-full-A');
  await settle();
  assert.equal(store.docs.has('A'), false, '(d) and the auto-delete runs when THAT copy lands');
});

test('removal waits (e): the boot sweep of pending removals keeps the request', async () => {
  const store = storeOf(suspect('A'));
  store.ls.set(PENDING_KEY, JSON.stringify(['A']));
  const h = boot(store);
  await h.sweepPendingUpDel();
  assert.ok(store.docs.has('A'), '(e) kept');
  assert.deepEqual(upDel(store), ['A'], '(e) and the request is kept for the re-send to complete');
});

test('removal waits (f): the plain remote delete is refused', async () => {
  const store = storeOf(suspect('A'));
  const h = boot(store);
  await h.runCmd({ type: 'delete', docId: 'A' });
  assert.ok(store.docs.has('A'), '(f) refused');
});

test('removal waits (g): "Done – send" on the open text is not "already saved"', async () => {
  const store = storeOf(suspect('A'));
  const h = boot(store, { current: 'A', autoDelete: true });
  await h.doUpload();
  assert.ok(store.docs.has('A'), '(g) kept');
  assert.ok(!h.calls.includes('toast:upload.alreadyDone'), '(g) not "already saved"');
  assert.equal(store.media.get('upload:A')?.engine, 'v999', '(g) a fresh copy is queued');
});

test('control: the same removal paths still act at once on a text whose Drive copy is not in question', async () => {
  const kinds = {
    'uploaded before v709': (id) => rec(id, { lines: [spoken('ba'), silent()], uploadedAt: AT - HOUR }, SIG),
    'built by this engine': (id) => rec(id, { lines: [spoken('ba'), silent()], uploadedAt: AT + HOUR, engine: 'v999' }, SIG),
    'no silent line': (id) => rec(id, { lines: [spoken('ba'), spoken('do')], uploadedAt: AT + HOUR }, SIG),
  };
  for (const [kind, make] of Object.entries(kinds)) {
    {
      const store = storeOf(make('A')); const h = boot(store);
      await h.runCmd({ type: 'uploadDelete', docId: 'A' }); await settle();
      assert.equal(store.docs.has('A'), false, `${kind}: uploadDelete removes at once`);
    }
    {
      const store = storeOf(make('A')); const h = boot(store);
      await h.userDeleteDoc('A', 'Text A');
      assert.ok(h.calls.includes('confirm:texts.confirmDelete'), `${kind}: 🗑 asks the plain question`);
      assert.equal(store.docs.has('A'), false, `${kind}: 🗑 removes at once`);
    }
    {
      const store = storeOf(make('A')); const h = boot(store, { autoDelete: true });
      await h.setDocDone('A', true); await settle();
      assert.equal(store.docs.has('A'), false, `${kind}: Done + auto-delete removes at once`);
    }
    {
      const store = storeOf(make('A')); store.ls.set(PENDING_KEY, '["A"]'); const h = boot(store);
      await h.sweepPendingUpDel();
      assert.equal(store.docs.has('A'), false, `${kind}: the boot sweep completes the request`);
    }
    {
      const store = storeOf(make('A')); const h = boot(store);
      await h.runCmd({ type: 'delete', docId: 'A' });
      assert.equal(store.docs.has('A'), false, `${kind}: the plain remote delete removes`);
    }
    {
      const store = storeOf(make('A')); const h = boot(store, { current: 'A' });
      await h.doUpload();
      assert.ok(h.calls.includes('toast:upload.alreadyDone'), `${kind}: "Done – send" says already saved`);
      assert.equal(store.media.has('upload:A'), false, `${kind}: and sends nothing`);
    }
  }
});

test('older-engine bundle (a): a Done text with auto-delete on is kept when that bundle lands, and re-sent on the same page', async () => {
  const c = rec('C', { lines: [spoken('ba'), silent()], uploaded: false, done: true }, SIG);
  const store = storeOf(c);
  store.media.set('upload:C', { blob: { size: 1 }, name: 'Text C.flextext', docId: 'C', docModified: c.modified, docSig: SIG(c), docDone: true });
  const h = boot(store, { autoDelete: true });
  await h.v709ResendSweep();
  assert.equal(h.calls.filter((x) => x.startsWith('queue:')).length, 0, '(a) never uploaded yet: nothing to re-send');
  assert.equal(h.settled, true);
  land(h, store, 'C', 'drive-v709-C');
  await settle();
  assert.ok(store.docs.has('C'), '(a) not auto-deleted: the copy that landed may lack its silent lines');
  assert.equal(store.docs.get('C').uploadedEngine, '', '(a) stamped as built by an engine before the field');
  assert.ok(!h.calls.includes('toast:record.sentRemoved'), '(a) no "removed" toast');
  assert.equal(h.settled, false, '(a) the sweep looks again without waiting for the next boot');
  await h.v709ResendSweep();
  assert.equal(store.media.get('upload:C')?.resend, 'v709', '(a) and re-sends it');
  land(h, store, 'C', 'drive-full-C');
  await settle();
  assert.ok(store.docs.has('C'), '(a) the re-send itself never auto-deletes: the text stays, complete on Drive');
  assert.equal(store.docs.get('C').uploadedEngine, 'v999');
});

test('older-engine bundle (b): a removal riding that bundle waits for the re-send, which completes it', async () => {
  const d = rec('D', { lines: [spoken('ba'), silent()], uploadedAt: AT - 10 * HOUR }, SIG);
  d.doc.paragraphs[0].segments[0].baseline += ' x'; d.modified += 1000;   // edited, then sent under v709
  const store = storeOf(d);
  store.media.set('upload:D', { blob: { size: 1 }, name: 'Text D.flextext', docId: 'D', docModified: d.modified, docSig: SIG(d), docDone: false });
  const h = boot(store);
  h.uploadView.set('D', { name: 'Text D.flextext', status: 'waiting' });
  await h.runCmd({ type: 'uploadDelete', docId: 'D' });
  assert.equal(store.media.get('upload:D').engine, undefined, '(b) the request rides the queued v709 bytes');
  land(h, store, 'D', 'drive-v709-D');
  await settle();
  assert.ok(store.docs.has('D'), '(b) not removed when those bytes landed');
  assert.deepEqual(upDel(store), ['D'], '(b) the request is kept');
  await h.v709ResendSweep();
  assert.equal(store.media.get('upload:D')?.resend, 'v709', '(b) the re-send follows');
  land(h, store, 'D', 'drive-full-D');
  await settle();
  assert.equal(store.docs.has('D'), false, '(b) and its landing completes the removal');
  assert.ok(h.calls.includes('toast:sync.removedAfterUpload'));
});

test('older-engine bundle (c), control: with no silent line, such a bundle still auto-deletes as it lands', async () => {
  const e = rec('E', { lines: [spoken('ba'), spoken('do')], uploaded: false, done: true }, SIG);
  const store = storeOf(e);
  store.media.set('upload:E', { blob: { size: 1 }, name: 'Text E.flextext', docId: 'E', docModified: e.modified, docSig: SIG(e), docDone: true });
  const h = boot(store, { autoDelete: true });
  land(h, store, 'E', 'drive-E');
  await settle();
  assert.equal(store.docs.has('E'), false, '(c) nothing v709 could drop: the auto-delete runs as before');
  assert.ok(h.calls.includes('toast:record.sentRemoved'), '(c) with its own toast');
});

test('a removal request already pending when a re-send lands is completed by it — the request is somebody\'s; the auto-delete never is', async () => {
  // A researcher's Remove whose upload the coworker cancelled from the tray: the request stays, as
  // it always has, until a backup lands. The re-send is that backup — complete this time.
  const b = suspect('B'); b.modified += 5000;                     // an open-and-close moved `modified`, not the content
  const store = storeOf(b);
  const h = boot(store);
  await h.runCmd({ type: 'uploadDelete', docId: 'B' });
  assert.deepEqual(upDel(store), ['B']);
  store.media.delete('upload:B'); h.uploadView.delete('B');      // cancelled from the tray
  const h2 = boot(store);
  await h2.sweepPendingUpDel();
  assert.ok(store.docs.has('B'), 'the boot sweep keeps it: the copy on Drive may be v709\'s');
  await h2.v709ResendSweep();
  assert.equal(store.media.get('upload:B')?.resend, 'v709');
  land(h2, store, 'B', 'drive-full-B');
  await settle();
  assert.equal(store.docs.has('B'), false, 'removed once the complete copy is on Drive');
  assert.ok(h2.calls.includes('toast:sync.removedAfterUpload'), 'with the request\'s own toast');
  assert.ok(!h2.calls.includes('toast:upload.done'), 'and never the upload toast');
});
