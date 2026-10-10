/* THE v709 RE-SEND — once per text, never again (Seth, 2026-10-10: "devices re-send any text whose
 * last upload was on 9–10 Oct, so Drive stops holding copies without their empty segments").
 *
 * v709 wrote every .flextext/EAF without its silent lines. The device's copy was untouched; its
 * UPLOADS were not, and "already on Drive" keeps that copy the newest until the text changes (#111).
 * v709ResendSweep (app.js) queues one ordinary Lane B upload for each text that needs it.
 *
 * What is measured here, with the REAL functions lifted out of app.js (and DriveUpload.emit out of
 * upload.js) and run against an in-memory IndexedDB:
 *   - which texts are re-sent and which are not (the six rules in the app.js header);
 *   - the predicate is v709's own isSilentPhrase (f579e92c), answer for answer;
 *   - idempotence: a second scan, a second boot, and a re-send that has LANDED never queue again;
 *   - a landed re-send never deletes and never toasts — the control (an ordinary upload with the
 *     same settings) does delete, so the test can fail;
 *   - offline: the re-send is queued and marked, and nothing starts until the connection is back;
 *   - unpaired / upload not allowed / researcher panel: nothing at all;
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

const LIFT = ['V709_DEPLOYED_AT', 'V709_OUR_NOTE'].map(constLine).join('\n') + '\n'
  + ['cheapHash', 'uploadContentSig', 'v709DroppedPhrase', 'v709ResendWanted', 'v709ResendSweep',
     'v709ResendScan', 'uploadDocById', 'uploadState', 'pumpUploads'].map(fn).join('\n');

/* One "page load": module state starts fresh (as it does on a real boot), the stored records and
 * the queue persist in `store`, which the caller can carry into the next harness. */
function boot(store, env = {}) {
  const make = new Function('store', 'env', `
    const RESEARCHER_MODE = !!env.researcher, CROWD_MODE = !!env.crowd;
    const ENGINE_VERSION = 'v999';
    const navigator = { onLine: env.online !== false };
    let current = env.current ? store.docs.get(env.current) : null;
    let returnAfterUploadOf = null;
    let v709ResendSettled = false;
    let v709ResendRunning = false;
    const uploadView = new Map();
    const calls = [];
    const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
    const db = {
      listDocs: async () => [...store.docs.values()].map((d) => ({ id: d.id, title: d.title,
        modified: d.modified, uploadedFileId: d.uploadedFileId || null, uploadedModified: d.uploadedModified || 0 })),
      getDoc: async (id) => clone(store.docs.get(id) || null),
      putDoc: async (r) => { calls.push('putDoc:' + r.id); store.docs.set(r.id, clone(r)); },
      getMedia: async (k) => store.media.get(k) || null,
      putMedia: async (k, v) => { calls.push('queue:' + k); store.media.set(k, v); },
      deleteMedia: async (k) => { store.media.delete(k); },
    };
    const Sync = {
      workerUploadTarget: () => (env.paired === false ? null : { url: 'https://worker.test/upload', headers: {} }),
      reportNow: () => { calls.push('reportNow'); },
    };
    function allowedSend() { return new Set(env.sendOptions || ['share', 'upload', 'save']); }
    function getUpload(id) { return (env.inFlight || []).includes(id) ? { id } : null; }
    async function buildBundleFor(rec) {
      calls.push('build:' + rec.id);
      return { blob: { size: 42 }, filename: (rec.title || 'text') + '.flextext', mime: 'application/xml' };
    }
    async function queueMediaUpload(id) { calls.push('laneA:' + id); }
    function renderUploadQueue() {}
    class DriveUpload { constructor(id, rec) { this.id = id; this.rec = rec; } start() { calls.push('start:' + this.id); } }
    function deleteAfterUpload() { return env.autoDelete === true; }
    let upDel = [];
    function pendingUpDel() { return upDel; }
    function setPendingUpDel(ids) { upDel = ids; }
    async function deleteUploadedDoc(id) { calls.push('DELETE:' + id); }
    async function deleteConfirmedDoc(id) { calls.push('DELETE:' + id); return true; }
    function returnToLibraryAfterSend() { calls.push('returnToList'); }
    function toast(msg) { calls.push('toast:' + msg); }
    const t = (k) => k;
    ${LIFT}
    return { v709ResendSweep, v709ResendWanted, v709DroppedPhrase, uploadState, uploadView, calls,
      uploadContentSig, V709_DEPLOYED_AT, get settled() { return v709ResendSettled; } };
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

function corpus() {
  const sigOf = boot({ docs: new Map(), media: new Map() }).uploadContentSig;
  const docs = new Map();
  const add = (id, o) => docs.set(id, rec(id, o, sigOf));
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
const settle = () => new Promise((r) => setTimeout(r, 20));
const queuedIds = (store) => [...store.media.keys()].filter((k) => k.startsWith('upload:')).map((k) => k.slice(7)).sort();

test('the source: one predicate, one cutoff, wired into every sweep, the stamp at the completion point', () => {
  assert.equal(new Function(`${constLine('V709_DEPLOYED_AT')}; return V709_DEPLOYED_AT;`)(), Date.parse('2026-10-08T22:31:19Z'),
    'the cutoff is v709\'s production deploy, 2026-10-08T22:31:19Z');
  const sweeps = app.match(/autoBackupSweep\(\)\.then\(sweepPendingUpDel\)\.catch\(\(\) => \{\}\)\.then\(v709ResendSweep\)\.catch\(\(\) => \{\}\);/g) || [];
  assert.equal(sweeps.length, 3, 'boot, the online edge and the 90 s timer all run it — after sweepPendingUpDel, so a text on its way out is not re-sent');
  assert.equal((app.match(/autoBackupSweep\(\)\.then\(sweepPendingUpDel\)\.catch\(\(\) => \{\}\);/g) || []).length, 0, 'no sweep site was left without it');

  const q = fn('uploadDocById');
  assert.match(q, /engine: ENGINE_VERSION,/, 'every Lane B record names the engine that BUILT its bytes');
  assert.match(q, /\.\.\.\(opts\.resend \? \{ resend: String\(opts\.resend\) \} : \{\}\)/, 'and only the re-send carries `resend`');
  assert.match(q, /docDone: !!rec\.done,/, 'docDone stays the doc\'s real state, so the Drive "done" marker is untouched');

  assert.match(emitSrc, /engine: this\.rec\.engine,/, 'DriveUpload.emit hands `engine` to the completion point');
  assert.match(emitSrc, /resend: this\.rec\.resend,/, '…and `resend`');

  const st = fn('uploadState');
  assert.match(st, /const resend = !!st\.resend;\s*\n\s*if \(!resend && deleteAfterUpload\(\) && st\.docDone !== false\)/, 'a re-send never takes the auto-delete branch');
  assert.match(st, /if \(!resend\) toast\(t\('upload\.done'/, 'and never toasts');
  assert.match(st, /d\.uploadedEngine = st\.engine \|\| '';/, 'the landing stamps uploadedEngine — \'\' for a record that predates the field');

  const sw = fn('v709ResendScan');
  assert.match(sw, /if \(!Sync\.workerUploadTarget\(\) \|\| !allowedSend\(\)\.has\('upload'\)\) return;/, 'paired, approved and allowed to upload — or nothing');
  assert.ok(sw.indexOf("uploadDocById(d.id, { resend: 'v709' })") < sw.indexOf('fresh.resentV709At = Date.now()'),
    'the mark goes on AFTER the bytes are queued');
  const code = (sw + fn('v709ResendWanted') + fn('v709ResendSweep')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /\.modified\s*=[^=]|\.doc\s*=[^=]|persist\(/, 'it never assigns modified or doc, and never persists the open text');
  assert.match(code, /fresh\.resentV709At = Date\.now\(\); await db\.putDoc\(fresh\)/, '(its one write is the mark, on a fresh read)');
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
  for (const id of first) {
    const queued = store.media.get('upload:' + id);
    store.media.delete('upload:' + id);                          // upload.js deletes the record, then emits
    let st;
    realEmit.call({ rec: queued, status: 'done', indeterminate: false, errorMessage: null, uploadedFileId: 'drive2-' + id, uploadedFolderId: 'folder-' + id, onState: (s) => { st = s; } });
    h3.uploadState(id)(st);
  }
  await settle();
  for (const id of first) {
    assert.equal(store.docs.get(id).uploadedEngine, 'v999', `${id}: the landing stamped the engine that built it`);
    assert.equal(store.docs.get(id).uploadedFileId, 'drive2-' + id, `${id}: proof-of-backup stamped as for any upload`);
  }
  // Even with the mark gone (say a persist() wrote an older copy back), uploadedEngine rules it out.
  for (const id of first) { const d = store.docs.get(id); delete d.resentV709At; }
  const h4 = boot(store);
  await h4.v709ResendSweep();
  assert.equal(h4.calls.filter((c) => c.startsWith('queue:')).length, 0, 'a text whose re-send landed is never re-sent');
  assert.equal(h4.settled, true);
});

test('a landed re-send never deletes and never toasts — an ordinary upload with the same settings does both', async () => {
  for (const resend of [true, false]) {
    const store = { docs: corpus(), media: new Map() };
    const h = boot(store, { autoDelete: true });                 // the researcher's auto-delete is ON
    const d = store.docs.get('A2');                              // and the text is Done
    const queued = { name: 'Text A2.flextext', docId: 'A2', docModified: d.modified, docSig: h.uploadContentSig(d),
      docDone: true, engine: 'v999', ...(resend ? { resend: 'v709' } : {}) };
    let st;
    realEmit.call({ rec: queued, status: 'done', indeterminate: false, errorMessage: null, uploadedFileId: 'drive2', uploadedFolderId: 'f', onState: (s) => { st = s; } });
    h.uploadState('A2')(st);
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

test('nothing at all when the device is not paired, may not upload, or is the researcher panel', async () => {
  for (const env of [{ paired: false }, { sendOptions: ['share', 'save'] }, { researcher: true }, { crowd: true }]) {
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
  const queued = store.media.get('upload:A3');
  store.media.delete('upload:A3');
  const d3 = store.docs.get('A3');
  let st;
  realEmit.call({ rec: { ...queued, docModified: d3.modified, docSig: h.uploadContentSig(d3), docDone: false }, status: 'done', indeterminate: false, errorMessage: null, uploadedFileId: 'drive-late', onState: (s) => { st = s; } });
  h.uploadState('A3')(st);
  await settle();
  assert.equal(store.docs.get('A3').uploadedEngine, '', 'a record that predates the field lands with uploadedEngine \'\'');
  const h2 = boot(store);
  await h2.v709ResendSweep();
  assert.deepEqual(queuedIds(store), ['A1', 'A2', 'A3'], 'next boot: all three re-sent, the late bundle included');
});
