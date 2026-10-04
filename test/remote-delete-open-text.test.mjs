/* A TEXT DELETED WHILE IT IS OPEN TAKES ITS PLAYER WITH IT (issue #90, Brian Plimley, 2026-10-01).
 *
 * His report: he opened a text in the Editor; while it was open the Researcher Panel removed it from
 * the device. The Editor went to the (empty) texts list — but "a working audio widget for the text
 * that was deleted" stayed on screen.
 *
 * The cause: deleteUploadedDoc (the teardown every remote / auto delete ends in) nulled `current`
 * and showed the texts view, but never ran leaveEditor() — the shared leave-the-text cleanup Back
 * and returnToLibraryAfterSend use. The player dock (#audio-player) is a sibling of the views, so
 * show('texts') never hides it; only leaveEditor() does. In the Audio Segmenter the open text lives
 * in the matcher (MG), and nothing closed that either.
 *
 * ⚠ THE PROPERTY THAT MUST NOT REGRESS ALONG WITH THE FIX: nothing on the way out may write the
 * deleted record back. Back persists before it leaves; this path must NOT — so leaveEditor runs
 * after `current = null`, where persist() returns at once.
 *
 * The review of the fix (2026-10-02) found the same symptom by a second route — the Audio
 * Segmenter's own 🗑, reachable with the matcher still open because its Texts tab does not close it —
 * and the matcher steps that await (Done, clearing a draft, "start over?") carrying on, or throwing,
 * after a delete had closed the matcher under them. Those are pinned here too.
 *
 * Source pins first, then the real functions lifted out of app.js and run against stubs, so the
 * order is the functions' actual behaviour and not a regex's opinion of it.
 * Run: node --test test/remote-delete-open-text.test.mjs
 */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const fn = (src, name) => (src.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)) || [''])[0];
const asyncFn = (src, name) => (src.match(new RegExp(`\\nasync function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)) || [''])[0];

function checker() {
  let fail = 0;
  const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
  const done = () => {
    console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
    if (fail) throw new Error(`${fail} check(s) failed`);
  };
  return { ok, done };
}

test('#90: deleteUploadedDoc leaves the open text the whole way (source)', () => {
  const { ok, done } = checker();
  const body = fn(app, 'deleteUploadedDoc');
  ok(body.length > 80, 'deleteUploadedDoc exists');

  console.log('\nthe editor: the shared leave, in the only safe order');
  const iNull = body.indexOf('current = null;');
  const iLeave = body.indexOf('leaveEditor();');
  const iShow = body.indexOf("if (!RECORD_MODE && !CONSENT_MODE && !SEGMENTER_MODE) show('texts');");
  ok(iLeave > 0, 'it calls leaveEditor() — the cleanup that hides the dock show() cannot reach');
  ok(iNull > 0 && iLeave > iNull,
     'AFTER `current = null`, so nothing leaveEditor sets off can persist the deleted record');
  ok(iShow > iLeave, 'and BEFORE the satellites-safe show(\'texts\') line (kept as it was)');
  ok(!/persist\(/.test(body),
     'no persist() here, unlike Back: a write racing db.deleteDoc could put the deleted text back');

  console.log('\nthe segmenter: its own exit closes the matcher');
  const iMg = body.indexOf('if (SEGMENTER_MODE && MG && MG.docId === docId) mgClose();');
  ok(iMg > 0, 'an open matcher on the deleted text is closed through mgClose(), keyed on MG.docId');
  ok(iMg < body.indexOf('if (current && current.id === docId)'),
     'before the editor branch — mgClose releases `current` itself, so the teardown runs once');
  ok(/MG = null;/.test(fn(app, 'mgClose')) && /current = null;/.test(fn(app, 'mgClose')) && /player\?\.hide\?\.\(\)/.test(fn(app, 'mgClose')),
     '(mgClose drops MG and `current` and hides the shared dock — what this relies on)');
  ok(/docId: rec\.id,/.test(fn(app, 'mgLoad')), '(and MG.docId is the field mgLoad actually sets)');

  console.log('\nwhat makes it safe to call from every shell that reaches it');
  const leave = fn(app, 'leaveEditor');
  ok(/if \(player\) \{ player\.hide\(\); player\.loadedFor = null; \}/.test(leave),
     'leaveEditor guards the player — the recorder and consent collector have no dock');
  ok(/const el = \$\(sel\);\s*if \(el\) el\.innerHTML = '';/.test(leave), 'and every container lookup');
  ok(!/persist\(|putDoc/.test(leave), 'and writes nothing itself');
  ok(/async function persist\(\) \{\n  if \(!current\) return;/.test(asyncFn(app, 'persist')),
     'persist() still returns at once on a null `current` — the reason the order above is safe');
  ok(/await deleteUploadedDoc\(docId\);/.test(asyncFn(app, 'deleteConfirmedDoc')),
     'the researcher\'s remote deletes (delete / uploadDelete) still end in this teardown');

  console.log('\nthe share menu goes with the text it belongs to (review of #90)');
  const iShare = body.indexOf("const shareMenu = $('#share-menu');");
  ok(iShare > iLeave && iShare < iShow, 'the open-text branch hides #share-menu, which also sits outside the views');
  ok(/if \(shareMenu\) shareMenu\.hidden = true;/.test(body),
     'through a guarded lookup — the recorder page and two satellites have no share menu at all');
  ok(!/closeShareMenu\(/.test(body), 'not closeShareMenu(), whose $(\'#share-menu\').hidden would throw there');
  done();
});

test('#90 review: the Segmenter\'s own 🗑 and the matcher\'s async steps (source)', () => {
  const { ok, done } = checker();

  console.log('\nuserDeleteDoc: the segmenter can delete the text its matcher has open');
  const ud = asyncFn(app, 'userDeleteDoc');
  const iConfirm = ud.indexOf('if (!await confirmDialog(msg)) return;');
  const iGuard = ud.indexOf('if (SEGMENTER_MODE && MG && MG.docId === docId) mgClose();');
  ok(iGuard > 0, 'an open matcher on the text being deleted is closed through mgClose()');
  ok(iConfirm > 0 && iGuard > iConfirm, 'only once the user has said yes — Cancel leaves the matcher as it was');
  ok(iGuard < ud.indexOf('if (!d || !uploads || backedUp) {'),
     'and before BOTH branches, so the upload-first one goes through uploadDocById, not the editor\'s doUpload');
  /* Why the list can be on screen with the matcher open: show() hides the home tabs only for the
   * editor's own views, and the segmenter's Texts tab shows its list without closing the matcher. */
  ok(/const inEditor = view === 'cut' \|\| view === 'baseline' \|\| view === 'gloss'/.test(fn(app, 'show')),
     '(show(\'matcher\') is not an editor view, so the home tabs stay up over the matcher)');
  ok(/else \{ sgRenderList\(\); show\('segmenter'\); \}/.test(fn(app, 'setupSegmenterMode')),
     '(and the Texts tab shows the list without closing it — the route the review reproduced)');

  console.log('\nmgCommit stops if the matcher closed while it was waiting');
  const mc = asyncFn(app, 'mgCommit');
  const G = 'if (!MG || MG.docId !== id) return;';
  ok(/const id = MG\.docId;\s*\n\s*const rec = await db\.getDoc\(id\);\s*\n\s*if \(!MG \|\| MG\.docId !== id\) return;/.test(mc),
     'after reading the record, before anything reads MG');
  ok(/await db\.putDoc\(rec\);\s*\n\s*if \(!MG \|\| MG\.docId !== id\) return;[^\n]*\n[\s\S]*?current = rec;/.test(mc),
     'after the commit write, before `current` is pointed at the record again');
  const iLastGuard = mc.lastIndexOf(G);
  const iClear = mc.indexOf('await mgClearDraft(MG.docId);');
  ok(iClear > 0 && iLastGuard > 0 && iLastGuard < iClear && iLastGuard > mc.indexOf('uploadDocById(rec.id)'),
     'and after the paired send, before mgClearDraft(MG.docId) — which threw when MG had gone');
  ok(/if \(!rec \|\| !rec\.matchDraft\) return;\s*\n(\s*\/\/[^\n]*\n)*\s*if \(!MG \|\| MG\.docId !== id\) return;\s*\n\s*delete rec\.matchDraft;/.test(asyncFn(app, 'mgClearDraft')),
     'mgClearDraft re-checks between its read and its write, or clearing could put a deleted text back');
  ok(/if \(!await confirmDialog\(t\('mg\.startOverConfirm'\)\)\) return;\s*\n\s*if \(!MG\) return;/.test(asyncFn(app, 'mgStartOver')),
     'mgStartOver checks MG after its dialog, as mgGuess already did');
  done();
});

/* Lift the real function out and run it in a scope that stands in for app.js's module scope. The
 * stubs record what happened and in what order; mgClose behaves as the real one does to the two
 * variables this function reads after it (MG and `current`). */
function harness(env) {
  const src = fn(app, 'deleteUploadedDoc');
  if (!src) throw new Error('deleteUploadedDoc not found');
  const make = new Function('env', `
    const { RECORD_MODE, CONSENT_MODE, SEGMENTER_MODE } = env;
    let current = env.current;
    let MG = env.MG;
    const calls = [];
    function splitCancel() { calls.push('splitCancel'); }
    function leaveEditor() { calls.push('leaveEditor(current=' + (current ? current.id : null) + ')'); }
    function show(v) { calls.push('show:' + v); }
    function mgClose() { calls.push('mgClose'); MG = null; current = null; }
    function refreshList() { calls.push('refreshList'); }
    const shareEl = env.shareMenu ? { hidden: false } : null;   // some shells have no share menu
    const $ = (sel) => (sel === '#share-menu' ? shareEl : null);
    const db = { deleteDoc: (id) => { calls.push('deleteDoc:' + id); return Promise.resolve(); } };
    ${src}
    return { run: (id) => deleteUploadedDoc(id), state: () => ({ calls, current, MG, shareEl }) };
  `);
  return make(env);
}
const editor = { RECORD_MODE: false, CONSENT_MODE: false, SEGMENTER_MODE: false, MG: null };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

test('#90: deleteUploadedDoc, run for real against stubs', async () => {
  const { ok, done } = checker();

  console.log('\nthe editor, the deleted text open (Brian\'s case)');
  {
    const h = harness({ ...editor, current: { id: 'A' }, shareMenu: true });
    await h.run('A');
    const s = h.state();
    ok(same(s.calls, ['splitCancel', 'leaveEditor(current=null)', 'show:texts', 'deleteDoc:A', 'refreshList']),
       `released, left, list shown, then deleted (${s.calls.join(' → ')})`);
    ok(s.current === null, 'nothing is open afterwards');
    ok(s.shareEl.hidden === true, 'and its share menu, if it was open, is closed with it');
  }

  console.log('\nthe editor, a DIFFERENT text open, its share menu up');
  {
    const h = harness({ ...editor, current: { id: 'B' }, shareMenu: true });
    await h.run('A');
    ok(h.state().shareEl.hidden === false, 'the menu belongs to the text the user IS working on — left alone');
  }

  console.log('\nthe editor, a DIFFERENT text open');
  {
    const h = harness({ ...editor, current: { id: 'B' } });
    await h.run('A');
    const s = h.state();
    ok(same(s.calls, ['deleteDoc:A', 'refreshList']), `only the delete and the repaint (${s.calls.join(' → ')})`);
    ok(s.current && s.current.id === 'B', 'the text the user IS working on stays open, its player untouched');
  }

  console.log('\nthe editor, nothing open');
  {
    const h = harness({ ...editor, current: null });
    await h.run('A');
    ok(same(h.state().calls, ['deleteDoc:A', 'refreshList']), 'no teardown for a text nobody has open');
  }

  console.log('\nthe recorder and the consent collector: the leave, but no texts view');
  for (const mode of ['RECORD_MODE', 'CONSENT_MODE']) {
    for (const shareMenu of [true, false]) {
      const h = harness({ ...editor, [mode]: true, current: { id: 'A' }, shareMenu });
      await h.run('A');
      const s = h.state();
      ok(same(s.calls, ['splitCancel', 'leaveEditor(current=null)', 'deleteDoc:A', 'refreshList']),
         `${mode}, ${shareMenu ? 'with' : 'NO'} share menu: released and left, never show('texts') — the shell has no such view (${s.calls.join(' → ')})`);
    }
  }

  console.log('\nthe segmenter, the deleted text open in the matcher');
  {
    const h = harness({ ...editor, SEGMENTER_MODE: true, current: { id: 'A' }, MG: { docId: 'A' } });
    await h.run('A');
    const s = h.state();
    ok(s.calls[0] === 'mgClose', 'the matcher\'s own exit runs first');
    ok(s.calls.indexOf('mgClose') < s.calls.indexOf('deleteDoc:A'), 'before the record is deleted');
    ok(!s.calls.includes('show:texts'), 'and no texts view is shown — mgClose takes the user to the segmenter list');
    ok(s.MG === null && s.current === null, 'nothing is open afterwards');
  }

  console.log('\nthe segmenter, a DIFFERENT text in the matcher');
  {
    const h = harness({ ...editor, SEGMENTER_MODE: true, current: { id: 'B' }, MG: { docId: 'B' } });
    await h.run('A');
    const s = h.state();
    ok(same(s.calls, ['deleteDoc:A', 'refreshList']), `the matcher is left alone (${s.calls.join(' → ')})`);
    ok(s.MG && s.MG.docId === 'B' && s.current && s.current.id === 'B', 'still matching the text the user opened');
  }

  console.log('\nthe segmenter, `current` set but no matcher (an open that failed part-way)');
  {
    const h = harness({ ...editor, SEGMENTER_MODE: true, current: { id: 'A' }, MG: null });
    await h.run('A');
    const s = h.state();
    ok(same(s.calls, ['splitCancel', 'leaveEditor(current=null)', 'deleteDoc:A', 'refreshList']),
       `the editor branch still releases it and hides the dock (${s.calls.join(' → ')})`);
  }
  done();
});

/* The review's findings, run for real. A "remote delete" below is what deleteUploadedDoc does to the
 * matcher before it touches storage: mgClose() — MG and `current` dropped — in the middle of
 * whatever await the stubbed storage call stands for. */
function lift(names, body, env) {
  const srcs = names.map((n) => fn(app, n) || asyncFn(app, n));
  srcs.forEach((s, i) => { if (!s) throw new Error(names[i] + ' not found'); });
  return new Function('env', `
    let MG = env.MG;
    let current = env.current;
    let mgDraftTimer = 0;
    const SEGMENTER_MODE = env.SEGMENTER_MODE !== false;
    const calls = [];
    function mgClose() { calls.push('mgClose'); MG = null; current = null; }
    const remoteDelete = () => { calls.push('remoteDelete'); mgClose(); };
    const t = (k) => k;
    function toast(m) { calls.push('toast:' + m); }
    ${body}
    ${srcs.join('\n')}
    return { calls, get MG() { return MG; }, get current() { return current; } };
  `)(env);
}
const count = (calls, name) => calls.filter((c) => c === name).length;

test('#90 review: the Segmenter\'s own 🗑, run for real', async () => {
  const { ok, done } = checker();
  const run = async (env) => {
    const h = lift(['userDeleteDoc'], `
      const db = {
        getDoc: async (id) => (env.rec || { id }),
        deleteDoc: async (id) => { calls.push('deleteDoc:' + id); },
      };
      const Sync = { workerUploadTarget: () => env.uploads, reportNow() {} };
      const confirmDialog = async () => { calls.push('confirm'); return env.answer !== false; };
      const getUpload = () => null;
      const uploadView = { delete() {}, has: () => false };
      function renderUploadQueue() {}
      function refreshList() { calls.push('refreshList'); }
      let pend = [];
      const pendingUpDel = () => pend.slice();
      const setPendingUpDel = (ids) => { pend = ids; };
      async function doUpload() { calls.push('doUpload'); }
      async function uploadDocById(id) { calls.push('uploadDocById:' + id); }
      globalThis.__ud = (id, title) => userDeleteDoc(id, title);
    `, env);
    await globalThis.__ud(env.del, 'T');
    return h;
  };

  console.log('\nOpen → Texts tab → 🗑 → OK, no upload target (the review\'s reproduction)');
  {
    const h = await run({ MG: { docId: 'A' }, current: { id: 'A' }, uploads: false, del: 'A' });
    ok(h.calls.indexOf('mgClose') > h.calls.indexOf('confirm') && h.calls.indexOf('mgClose') < h.calls.indexOf('deleteDoc:A'),
       `the matcher is closed after the yes and before the delete (${h.calls.join(' → ')})`);
    ok(h.MG === null && h.current === null, 'nothing is left open over the empty list — so no dock, no player');
  }

  console.log('\nthe same, with an upload target and changes not yet on Drive (upload first, delete later)');
  {
    const h = await run({ MG: { docId: 'A' }, current: { id: 'A' }, uploads: true, rec: { id: 'A' }, del: 'A' });
    ok(h.calls.includes('mgClose') && h.calls.includes('uploadDocById:A') && !h.calls.includes('doUpload'),
       `closed, then sent by uploadDocById as the matcher's own Done sends — not the editor's doUpload (${h.calls.join(' → ')})`);
  }

  console.log('\nCancel, or a DIFFERENT text in the matcher, or the editor');
  {
    const h = await run({ MG: { docId: 'A' }, current: { id: 'A' }, uploads: false, del: 'A', answer: false });
    ok(!h.calls.includes('mgClose') && h.MG && h.MG.docId === 'A', 'Cancel leaves the matcher exactly as it was');
  }
  {
    const h = await run({ MG: { docId: 'B' }, current: { id: 'B' }, uploads: false, del: 'A' });
    ok(!h.calls.includes('mgClose') && h.MG.docId === 'B' && h.current.id === 'B', 'another text\'s matcher is left alone');
  }
  {
    const h = await run({ SEGMENTER_MODE: false, MG: null, current: null, uploads: false, del: 'A' });
    ok(same(h.calls, ['confirm', 'deleteDoc:A', 'refreshList']), `the editor's delete is unchanged (${h.calls.join(' → ')})`);
  }
  delete globalThis.__ud;
  done();
});

test('#90 review: matcher steps that await, with the delete landing in the middle', async () => {
  const { ok, done } = checker();

  const commitRun = async (env) => {
    const h = lift(['mgCommit'], `
      let puts = 0;
      const db = {
        getDoc: async (id) => { calls.push('getDoc:' + id); if (env.during === 'getDoc') remoteDelete(); return { id, doc: {} }; },
        putDoc: async (r) => { puts++; calls.push('putDoc#' + puts); if (env.during === 'putDoc#' + puts) remoteDelete(); },
        broadcastLive() {},
      };
      const newGuid = () => 'g';
      const makeSegment = () => ({ words: [] });
      const mergePhrases = (p) => p[0];
      const docStats = () => ({});
      const Sync = { workerUploadTarget: () => true, reportNow() {} };
      async function uploadDocById(id) { calls.push('uploadDocById:' + id); if (env.during === 'upload') remoteDelete(); }
      async function mgClearDraft(id) { calls.push('mgClearDraft:' + id); }
      function sgRenderList() { calls.push('sgRenderList'); }
      globalThis.__mc = () => mgCommit();
      globalThis.__cur = () => current;
    `, env);
    let threw = null;
    try { await globalThis.__mc(); } catch (e) { threw = e; }
    return { h, threw };
  };
  const open = () => ({ MG: { docId: 'A', spans: [{ start: 0, end: 1000 }], lines: [{ id: 'l1', guid: 'g1', phrases: [{ words: [] }] }] },
                        current: { id: 'A', stale: true } });

  console.log('\nDone with nothing in the way (paired) — unchanged');
  {
    const { h, threw } = await commitRun(open());
    ok(!threw, 'no error');
    ok(h.calls.includes('putDoc#1') && h.calls.includes('putDoc#2') && h.calls.includes('uploadDocById:A')
       && h.calls.includes('mgClearDraft:A') && count(h.calls, 'mgClose') === 1 && h.calls.includes('sgRenderList'),
       `commit, done flag, send, clear the draft, close (${h.calls.join(' → ')})`);
  }

  for (const during of ['getDoc', 'putDoc#1', 'putDoc#2', 'upload']) {
    console.log(`\nthe delete lands during ${during}`);
    const { h, threw } = await commitRun({ ...open(), during });
    ok(!threw, `no error (before: a TypeError on the null MG, at MG.lines or mgClearDraft(MG.docId)) ${threw ? '— ' + threw.message : ''}`);
    ok(globalThis.__cur() === null, '`current` is left null — never pointed back at the deleted record');
    ok(count(h.calls, 'mgClose') === 1, 'the exit ran once — the delete\'s; Done does not close it a second time');
    ok(!h.calls.includes('mgClearDraft:A') && !h.calls.some((c) => c.startsWith('toast:mg.committed')),
       `no draft clear, no "committed" toast for a text that is gone (${h.calls.join(' → ')})`);
    const putsAfter = h.calls.slice(h.calls.indexOf('remoteDelete')).filter((c) => c.startsWith('putDoc'));
    ok(putsAfter.length === 0, 'and no write issued after the delete began — nothing can put it back');
  }
  delete globalThis.__mc; delete globalThis.__cur;

  console.log('\nmgClearDraft: the delete lands between its read and its write');
  for (const during of [null, 'getDoc']) {
    const h = lift(['mgClearDraft'], `
      const db = {
        getDoc: async (id) => { calls.push('getDoc:' + id); if (env.during === 'getDoc') remoteDelete(); return { id, matchDraft: { at: 1 } }; },
        putDoc: async (r) => { calls.push('putDoc:' + ('matchDraft' in r ? 'withDraft' : 'cleared')); },
        broadcastLive() {},
      };
      globalThis.__cd = (id) => mgClearDraft(id);
    `, { MG: { docId: 'A' }, current: null, during });
    await globalThis.__cd('A');
    ok(during ? !h.calls.some((c) => c.startsWith('putDoc')) : h.calls.includes('putDoc:cleared'),
       during ? `no write after the matcher closed (${h.calls.join(' → ')})` : 'with the matcher open it still clears the draft');
  }
  delete globalThis.__cd;

  console.log('\nmgStartOver: the delete lands while "start over?" is on screen');
  {
    const h = lift(['mgStartOver'], `
      const confirmDialog = async () => { remoteDelete(); return true; };
      async function mgClearDraft(id) { calls.push('mgClearDraft:' + id); }
      function mgOpen(id) { calls.push('mgOpen:' + id); }
      globalThis.__so = () => mgStartOver();
    `, { MG: { docId: 'A' }, current: { id: 'A' } });
    let threw = null;
    try { await globalThis.__so(); } catch (e) { threw = e; }
    ok(!threw, `OK after the delete does not throw (it read MG.docId of null) ${threw ? '— ' + threw.message : ''}`);
    ok(!h.calls.includes('mgOpen:A') && !h.calls.some((c) => c.startsWith('mgClearDraft')), 'and does not try to reopen the deleted text');
    delete globalThis.__so;
  }
  done();
});
