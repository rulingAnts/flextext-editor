/* NOTHING LETS A DEVICE DELETE ITS TEXT ON THE STRENGTH OF A BAD COPY IN DRIVE (plans/move-upload-guards.md §12).
 *
 * WHY THIS TEST EXISTS: a device that reports "uploaded ✓" believes its last upload IS its current
 * state, so a removal (`uploadDelete`) takes the fast branch on the device: delete, no new upload. The
 * review found three ways to send that removal while the copy in Drive was damaged or missing — the
 * finding-5 estate, where such copies already exist:
 *   1. the move modal's "Move the copy already in Drive instead…" on a DAMAGED or MISSING device copy
 *      (its warning even promised the device would send its changes first);
 *   2. Move → Unassigned, which never looked at any copy;
 *   3. the row's "Remove", which never looked either.
 * Each now checks the device's own copy first. A move that takes the way out HOLDS its release until
 * the device has sent its own copy again; a removal REFUSES, names why, and offers to ask the device
 * to send. On the device, a removal no longer takes the fast branch while an upload of that text is
 * queued — the queued copy would have been deleted with the text.
 *
 * Also here: a copy check that FAILS no longer leaves Go saying "still checking" for ever, and a
 * failed folder listing says so instead of "Download failed".
 *
 * Run: node --test test/move-release-held.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { flextextStats, serializeFlextext, makeDoc, reconcileBaseline } = await import('../docs/js/flextext.js');

const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
const grab = (src, re, what) => { const m = src.match(re); assert.ok(m, `${what} is findable`); return m[0]; };
const P = (re, what) => grab(panel, re, what);
const helpers = P(/const STAT_ALL = [\s\S]*?\nfunction statsHaveContent\(s\) \{[\s\S]*?\n\}/, 'the stat helpers');
const copyStatsSrc = P(/const copyStatsCache = new Map\(\);[\s\S]*?\nasync function copyStats\(files, opts = \{\}\) \{[\s\S]*?\n\}/, 'copyStats');
const devItemsSrc = P(/function deviceItems\(instanceId, docId\) \{[\s\S]*?\n\}/, 'deviceItems');
const verdictSrc = P(/function deviceCopyVerdict\(d, file, entry\) \{[\s\S]*?\n\}/, 'deviceCopyVerdict');
const checkSrc = P(/async function deviceBackupCheck\(instanceId, docId, opts = \{\}\) \{[\s\S]*?\n\}/, 'deviceBackupCheck');
const heldSrc = P(/function releaseHeld\(docId, mv\) \{[\s\S]*?\n\}/, 'releaseHeld');
const startSrc = P(/function startCopyCheck\(box, \{ resolve, paint \}\) \{[\s\S]*?\n\}/, 'startCopyCheck');

const SET = { vernLang: 'qaa', analLang: 'id' };
const xml = (n) => { const d = makeDoc(SET, 'Cerita'); reconcileBaseline(d, Array.from({ length: n }, (_, i) => `kata ${i + 1}`)); return serializeFlextext(d, SET); };
const lastDataOf = (item) => ({ instances: [{ instance_id: 'src', installs: [{ last_seen_at: 5, inventory: { items: item ? [{ id: 'doc1', ...item }] : [] } }] }] });

const liftCheck = ({ item, files = [], bodies = {}, listFails = false }) => {
  const fetched = [];
  const Researcher = {
    listTextFiles: async () => { if (listFails) throw new Error('net'); return { files }; },
    fetchDriveFile: async (id) => {
      fetched.push(id);
      if (bodies[id] === 404) throw new Error('file_fetch_failed_404');
      if (bodies[id] === 502) throw new Error('file_fetch_failed_502');
      return { text: async () => bodies[id] };
    },
  };
  const f = new Function('Researcher', 'flextextStats', 'lastData',
    `${helpers}\n${copyStatsSrc}\n${devItemsSrc}\n${verdictSrc}\n${checkSrc}\nreturn deviceBackupCheck;`)(Researcher, flextextStats, lastDataOf(item));
  return { check: f, fetched };
};

test('THE DEVICE COPY IS CHECKED BEFORE A REMOVAL: damaged, missing and unopenable are each refused', async () => {
  const good = xml(5);
  const ok = liftCheck({ item: { uploadState: 'uploaded', uploadedFileId: 'F1' }, files: [{ id: 'F1', name: 'a.flextext', size: good.length }], bodies: { F1: good } });
  assert.deepEqual(await ok.check('src', 'doc1'), { ok: true }, 'a whole copy: the removal may go ahead');
  const nul = liftCheck({ item: { uploadState: 'uploaded', uploadedFileId: 'F1' }, files: [{ id: 'F1', name: 'a.flextext', size: 489 }], bodies: { F1: '\u0000'.repeat(489) } });
  assert.equal((await nul.check('src', 'doc1')).why, 'damaged', 'the 489-byte NUL file — the device\'s ONLY good copy is the one on the device');
  const gone = liftCheck({ item: { uploadState: 'uploaded', uploadedFileId: 'F9' }, files: [], bodies: { F9: 404 } });
  assert.equal((await gone.check('src', 'doc1')).why, 'missing', 'not listed, and the lookup by id says 404');
  const hash = liftCheck({ item: { uploadState: 'uploaded', uploadedFileId: 'F1', uploadedSha256: 'sent' },
    files: [{ id: 'F1', name: 'a.flextext', size: good.length, sha256: 'drive' }], bodies: { F1: good } });
  assert.equal((await hash.check('src', 'doc1')).why, 'damaged', 'Drive holds different bytes from the ones the device sent');
  const vt = liftCheck({ item: { uploadState: 'uploaded', uploadedFileId: 'F1' }, files: [{ id: 'F1', name: 'a.flextext', size: 1 }],
    bodies: { F1: good.replace('kata 2', 'kata\u000B2') } });
  assert.equal((await vt.check('src', 'doc1')).why, 'unopenable', 'whole, but no device (and no FLEx) can open it');
  const flaky = liftCheck({ item: { uploadState: 'uploaded', uploadedFileId: 'F1' }, files: [{ id: 'F1', name: 'a.flextext', size: 1 }], bodies: { F1: 502 } });
  assert.equal((await flaky.check('src', 'doc1')).why, 'unchecked', 'a failed fetch is not a pass: "try again", never a silent go-ahead');
  const r = await nul.check('src', 'doc1');
  assert.equal(r.ok, false);
  assert.equal(r.item.uploadedFileId, 'F1', 'the refusal carries the report, for "Ask the device to send"');
});

test('...and is NOT checked where the device uploads first anyway, or the copy is a legacy zip', async () => {
  for (const uploadState of ['changed', 'local']) {
    const c = liftCheck({ item: { uploadState, uploadedFileId: 'F1' }, files: [], bodies: {} });
    assert.deepEqual(await c.check('src', 'doc1'), { ok: true }, `${uploadState}: uploadDelete uploads before it deletes`);
    assert.equal(c.fetched.length, 0, 'and costs nothing on the wire');
  }
  const none = liftCheck({ item: null });
  assert.deepEqual(await none.check('src', 'doc1'), { ok: true }, 'the device does not report it: nothing it could delete');
  const zip = liftCheck({ item: { uploadState: 'uploaded', uploadedFileId: 'Z' }, files: [{ id: 'Z', name: 'old.zip', size: 9 }], bodies: {} });
  assert.deepEqual(await zip.check('src', 'doc1'), { ok: true }, 'an old engine\'s zip bundle: as before');
  const sending = liftCheck({ item: { uploadState: 'uploading', uploadedFileId: 'F1' }, files: [{ id: 'F1', name: 'a.flextext', size: 489 }], bodies: { F1: '\u0000'.repeat(489) } });
  assert.equal((await sending.check('src', 'doc1')).why, 'damaged', 'a device re-sending unchanged content is checked too (its fast branch would apply)');
});

test('THE RELEASE IS HELD until the source reports a NEW upload (or no longer holds the text)', () => {
  const held = (item, mv) => new Function('lastData', `${devItemsSrc}\n${heldSrc}\nreturn releaseHeld;`)(lastDataOf(item))('doc1', mv);
  const mv = { from: 'src', to: 'dst', stage: 'assigned', holdFor: 'F1' };
  assert.equal(held({ uploadState: 'uploaded', uploadedFileId: 'F1' }, mv), true, 'same upload as when the way out was taken: wait');
  assert.equal(held({ uploadState: 'uploading', uploadedFileId: 'F1' }, mv), true, 'sending: wait');
  assert.equal(held({ uploadState: 'uploaded', uploadedFileId: 'F2' }, mv), false, 'a new copy landed: release');
  assert.equal(held(null, mv), false, 'the source no longer reports it: nothing to wait for');
  assert.equal(held({ uploadedFileId: '' }, { ...mv, holdFor: '' }), true, 'never uploaded: wait for a first upload');
  assert.equal(held({ uploadState: 'uploaded', uploadedFileId: 'F1' }, { from: 'src', stage: 'assigned' }), false, 'an ordinary move is never held');
});

test('the wiring: the sweep holds, the commit asks the device to send first, and the row says why', () => {
  const sweep = panel.slice(panel.indexOf("if (mv.stage === 'assigned') {"));
  const assigned = sweep.slice(0, sweep.indexOf("mv.stage === 'removing'"));
  assert.ok(assigned.indexOf('if (releaseHeld(docId, mv)) continue;') > 0
    && assigned.indexOf('if (releaseHeld(docId, mv)) continue;') < assigned.indexOf('Researcher.uploadDelete(mv.from, docId)'),
    'held before the release is issued');
  const mvAt = panel.indexOf('async function moveTextModal');
  const mvSrc = panel.slice(mvAt, panel.indexOf('\n}\n', panel.indexOf('  });', mvAt)) + 3);
  const trig = mvSrc.indexOf('Researcher.triggerUpload(fromId, docId)');
  assert.ok(trig > 0 && trig < mvSrc.indexOf('Researcher.moveText('), 'the device is asked to send BEFORE anything moves');
  assert.ok(mvSrc.indexOf("stage('panel.move.stepResend'") > 0 && mvSrc.indexOf("stage('panel.move.stepResend'") < trig, 'and the step names itself first');
  assert.match(mvSrc, /copyPick\.hold === 'resend'/);
  assert.match(mvSrc, /\.\.\.\(copyPick\.hold \? \{ holdFor \} : \{\}\)/, 'the move record carries the hold, so EVERY panel honours it');
  assert.match(panel, /releaseHeld\(d\.id, mv\) \? 'panel\.move\.waitingResend'/, 'the source row says it is waiting for the device to send');
});

test('the removals check first: Move → Unassigned and the row\'s Remove', () => {
  const mvAt = panel.indexOf('async function moveTextModal');
  const mvSrc = panel.slice(mvAt, panel.indexOf('\n}\n', panel.indexOf('  });', mvAt)) + 3);
  const una = mvSrc.slice(mvSrc.indexOf("if (to.startsWith('__unassigned')) {"));
  const chk = una.indexOf('deviceBackupCheck(fromId, docId');
  assert.ok(chk > 0 && chk < una.indexOf('Researcher.uploadDelete(fromId, docId)'), 'Unassigned checks before it releases');
  assert.ok(una.indexOf("stage('panel.move.stepCheck'") >= 0 && una.indexOf("stage('panel.move.stepCheck'") < chk);
  const del = panel.slice(panel.indexOf("} else if (act === 'del-text') {"), panel.indexOf("} else if (act === 'cancel-removal') {"));
  assert.ok(del.indexOf('deviceBackupCheck(id, el.dataset.id)') > 0
    && del.indexOf('deviceBackupCheck(id, el.dataset.id)') < del.indexOf('Researcher.uploadDelete('), 'Remove checks before it releases');
  assert.match(del, /refuseRemoval\(/, 'and a refusal says why, with a way forward');
  const refuse = P(/function refuseRemoval\(instanceId, docId, title, chk\) \{[\s\S]*?\n\}/, 'refuseRemoval');
  assert.match(refuse, /askDeviceToSend\(instanceId, docId, chk\.item, m, 'panel\.inst\.askSentRemove'\)/,
    '"Ask {device} to send its copy" is offered, and its toast says "remove it again", not "choose Move again"');
});

test('THE DEVICE: a removal never takes the fast branch while an upload of the text is queued', async () => {
  const fn = grab(app, /async function releaseAfterUpload\(docId\) \{[\s\S]*?\n\}/, 'releaseAfterUpload');
  const run = async ({ doc, queued = false, held = false }) => {
    const calls = [];
    let intents = [];
    const view = new Map(queued ? [['doc1', { status: held ? 'error' : 'waiting', held }]] : []);
    const env = { db: { getDoc: async () => doc }, deleteConfirmedDoc: async () => { calls.push('delete'); return true; },
      pendingUpDel: () => intents, setPendingUpDel: (ids) => { intents = ids; }, uploadView: view, getUpload: () => null,
      current: null, doUpload: async () => { calls.push('upload'); }, uploadDocById: async () => { calls.push('upload'); return true; } };
    await new Function(...Object.keys(env), `${fn}\nreturn releaseAfterUpload;`)(...Object.values(env))('doc1');
    return { calls, intents };
  };
  const backed = { id: 'doc1', uploadedFileId: 'F1', uploadedModified: 5, modified: 5 };
  assert.deepEqual((await run({ doc: backed })).calls, ['delete'], 'backed up, nothing queued: the fast branch, as before');
  const q = await run({ doc: backed, queued: true });
  assert.deepEqual(q.calls, [], '⚠ queued: NOT deleted — the delete would take the queued copy with it');
  assert.deepEqual(q.intents, ['doc1'], 'the intent waits for the upload-done hook instead');
  assert.deepEqual((await run({ doc: backed, queued: true, held: true })).calls, ['upload'], 'a copy held as damaged is rebuilt now, not in six hours');
  assert.deepEqual((await run({ doc: { ...backed, modified: 9 } })).calls, ['upload'], 'changed since: upload first, as before');
  assert.deepEqual((await run({ doc: null })).calls, [], 'already gone');
  const cases = grab(app, /case 'uploadDelete': \{[\s\S]*?case 'triggerUpload': \{/, 'the uploadDelete case');
  assert.match(cases, /await releaseAfterUpload\(docId\);/);
});

test('A FAILED CHECK CAN BE RETRIED — Go never says "still checking" for ever', async () => {
  const mk = (resolve) => {
    let html = '';
    const nodes = {};
    const box = { set innerHTML(v) { html = v; }, get innerHTML() { return html; },
      querySelector: (sel) => (sel === '[data-copy="retry"]' && /data-copy="retry"/.test(html) ? (nodes.retry ||= {}) : null) };
    const start = new Function('t', 'esc', `${startSrc}\nreturn startCopyCheck;`)((k) => k, (s) => String(s));
    return { ui: start(box, { resolve, paint: () => ({ pickFile: () => ({ ok: true, file: 'F' }) }) }), box, nodes };
  };
  let n = 0;
  const flaky = mk(() => (++n === 1 ? Promise.reject(new Error('net')) : Promise.resolve({ decision: 'send' })));
  await new Promise((r) => setTimeout(r, 0));
  assert.match(flaky.box.innerHTML, /panel\.move\.checkFailed/);
  assert.deepEqual(flaky.ui.current.pickFile(), { ok: false, why: 'panel.move.checkFailed' }, 'Go says the check failed — not "still checking"');
  flaky.nodes.retry.onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(flaky.ui.current.pickFile(), { ok: true, file: 'F' }, 'and "Try again" runs it again');
  const cancelled = mk(() => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(cancelled.ui.current, null, 'a cancelled check (the modal closed) paints nothing');
  for (const fn of ['async function moveTextModal', 'async function adoptTextModal']) {
    const at = panel.indexOf(fn);
    const body = panel.slice(at, at + 9000);
    assert.match(body, /startCopyCheck\(/, `${fn} runs its check through it`);
    assert.match(body, /'panel\.move\.listFailed'/, `${fn}: a failed folder listing says so, not "Download failed"`);
  }
});

test('every new string is in English AND Indonesian', () => {
  for (const k of ['panel.move.waitingResend', 'panel.move.stepResend', 'panel.move.stepCheck', 'panel.move.checkFailed',
    'panel.move.checkRetry', 'panel.move.listFailed', 'panel.inst.removeUnsafeTitle', 'panel.inst.removeUnsafe.damaged',
    'panel.inst.removeUnsafe.missing', 'panel.inst.removeUnsafe.unopenable', 'panel.inst.removeCheckFailed']) {
    assert.equal((i18n.match(new RegExp(`^  '${k.replace(/\./g, '\\.')}':`, 'gm')) || []).length, 2, `${k} in both languages`);
  }
});
