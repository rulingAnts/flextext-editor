/* THE lameta DEVICE AGENT, RUN AGAINST FAKES (docs/js/lameta-agent.js, plans/lameta-device.md).
 *
 * The agent takes researcher.js and files.js by injection, which is what makes the whole loop
 * runnable here: a worker that answers what the test tells it to, a folder made of plain objects.
 * What is pinned is the CONTRACT a phone would recognise — the link sequence with its record saved
 * before the first POST, the seq-filter/ack loop — and where the agent deliberately differs from a
 * phone: a command this version cannot carry out is HELD, not acked; a wipe or a revoke forgets the
 * link and touches no file; a delete is refused. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLametaAgent, buildInventory, inspectProject, INDEX_KEY, LINK_KEY, HELD } from '../docs/js/lameta-agent.js';

/* ─── fakes ─── */
function fakeDir(name, entries = {}) {
  return { kind: 'directory', name, _entries: entries,
    async *values() { for (const e of Object.values(entries)) yield e; },
    async getDirectoryHandle(n, { create } = {}) {
      if (entries[n] && entries[n].kind === 'directory') return entries[n];
      if (!create) { const e = new Error('nope'); e.name = 'NotFoundError'; throw e; }
      entries[n] = fakeDir(n); return entries[n];
    },
    async getFileHandle(n) { if (entries[n] && entries[n].kind === 'file') return entries[n]; const e = new Error('nope'); e.name = 'NotFoundError'; throw e; },
  };
}
const file = (name) => ({ kind: 'file', name });
function project() {
  return fakeDir('Fayu', { 'Fayu.sprj': file('Fayu.sprj'), Sessions: fakeDir('Sessions', { Tautua_Do: fakeDir('Tautua_Do'), narr_x: fakeDir('narr_x'), 'stray.txt': file('stray.txt') }) });
}
function fakeFiles({ permission = 'granted' } = {}) {
  const store = new Map();
  const F = { store, writes: [], permission,
    stashGet: async (k) => (store.has(k) ? store.get(k) : null), stashPut: async (k, v) => { store.set(k, v); return true; }, stashDelete: async (k) => store.delete(k),
    rememberFolder: async (k, handle, meta = {}) => { store.set(k, { handle, name: handle && handle.name, at: 1, ...meta }); return true; },
    recallFolder: async (k) => (store.has(k) ? store.get(k) : null), forgetFolder: async (k) => store.delete(k),
    sameEntry: async (a, b) => a === b,
    permissionState: async () => F.permission, requestFolderPermission: async () => { F.permission = 'granted'; return true; },
    listDir: async (dir) => { const out = []; for await (const e of dir.values()) out.push({ name: e.name, kind: e.kind }); return out.sort((a, b) => a.name.localeCompare(b.name)); },
    getDir: async (dir, n) => { try { return await dir.getDirectoryHandle(n); } catch { return null; } },
    writeFile: async (...a) => { F.writes.push(a); },
  };
  return F;
}
function fakeResearcher({ poll = () => ({}) } = {}) {
  const R = { calls: [], poll,
    currentAccountId: () => 'acct',
    createInstance: async (nickname, projectFolderId) => { R.calls.push(['createInstance', nickname, projectFolderId]); return { instance_id: 'inst-1', nickname, type: '' }; },
    mintInvite: async (id) => { R.calls.push(['mintInvite', id]); return { invite_id: 'inv-1', secret: 'sekrit', expires_at: 0 }; },
    approveInstall: async (id, installId, pub) => { R.calls.push(['approveInstall', id, installId, pub]); return { ok: true }; },
    revokeInstall: async (id, installId) => { R.calls.push(['revokeInstall', id, installId]); },
    apiAsInstall: async (method, path, install, opts = {}) => {
      R.calls.push([method, path, install.installId, install.installSecret, opts]);
      if (method === 'GET') { const r = R.poll(); if (r && r.status) { const e = new Error(r.error || 'http'); e.status = r.status; throw e; } return r; }
      return {};
    },
    encryptForInstance: async (id, obj) => 'enc:' + JSON.stringify(obj),
    decryptForInstance: async (id, tok) => JSON.parse(String(tok).slice(4)),
  };
  return R;
}
const mk = (over = {}) => {
  const F = fakeFiles(over.files || {}), R = fakeResearcher(over.researcher || {});
  const changes = [];
  const a = createLametaAgent({ R, F, engineVersion: 'v692', ua: 'TestBrowser', onChange: (id) => changes.push(id), log: { warn() {} }, now: () => 1234, visible: () => true, ...(over.agent || {}) });
  return { a, F, R, changes };
};
const linkIt = async (a, handle = project()) => ({ handle, made: await a.link({ handle, nickname: 'Fayu corpus', projectName: 'Fayu', sprjName: 'Fayu.sprj', projectFolderId: 'fld-p' }) });

test('inspectProject: a .sprj and a Sessions/ make a project; sessions are its directories', async () => {
  const F = fakeFiles();
  const p = await inspectProject(F, project());
  assert.deepEqual(p, { ok: true, projectName: 'Fayu', sprjName: 'Fayu.sprj', sessions: ['narr_x', 'Tautua_Do'] },
    'stray.txt under Sessions/ is not a session; names sort as a person reads them (locale order)');
  assert.equal((await inspectProject(F, fakeDir('x', { Sessions: fakeDir('Sessions') }))).ok, false, 'no .sprj');
  assert.equal((await inspectProject(F, fakeDir('x', { 'a.sprj': file('a.sprj') }))).ok, false, 'no Sessions/');
});

test('the inventory is a device inventory: type lameta, platform lameta, the engine version, no texts yet', () => {
  const inv = buildInventory({ projectName: 'Fayu', folderName: 'Fayu', settings: { vernLang: 'fau' } }, { sessions: 2 }, { engineVersion: 'v692', ua: 'UA' });
  assert.equal(inv.type, 'lameta'); assert.equal(inv.platform, 'lameta'); assert.equal(inv.engineVersion, 'v692');
  assert.deepEqual(inv.items, []); assert.deepEqual(inv.settings, { vernLang: 'fau' });
  assert.deepEqual(inv.lameta, { projectName: 'Fayu', folder: 'Fayu', sessions: 2, available: true });
  assert.equal(buildInventory({}, { available: false }).lameta.sessions, null, 'a folder that did not answer reports no count, not zero');
});

test('link: create, invite, record saved BEFORE the claim, claim as the install, accept, approve without a pubkey', async () => {
  const { a, F, R } = mk();
  let recordAtClaim = null;
  const orig = R.apiAsInstall;
  R.apiAsInstall = async (m, p, inst, o) => { if (/\/claim$/.test(p)) recordAtClaim = await F.recallFolder(LINK_KEY('acct', 'inst-1')); return orig(m, p, inst, o); };
  const { made } = await linkIt(a);
  assert.equal(made.instanceId, 'inst-1'); assert.ok(made.installId);
  const names = R.calls.map((c) => (c[0] === 'POST' || c[0] === 'GET') ? `${c[0]} ${c[1]}` : c[0]);
  assert.deepEqual(names, ['createInstance', 'mintInvite', 'POST /v1/invites/inv-1/claim', `POST /v1/instances/inst-1/installs/${made.installId}/accept`, 'approveInstall'], 'the device sequence, in order');
  assert.equal(R.calls[0][2], 'fld-p', 'born into the project on screen');
  assert.ok(recordAtClaim && recordAtClaim.link.installSecret, 'the identity was on disk before the first POST — a lost response loses nothing');
  const claim = R.calls[2][4];
  assert.equal(claim.headers['x-fx-invite-secret'], 'sekrit'); assert.equal(claim.body.install_id, made.installId); assert.ok(claim.body.install_secret.length >= 32);
  assert.ok(!('pubkey' in claim.body), 'no RSA keypair: Ki stays in researcher.js');
  assert.deepEqual(R.calls[4].slice(1), ['inst-1', made.installId, null], 'approve-only');
  const rec = await F.recallFolder(LINK_KEY('acct', 'inst-1'));
  assert.equal(rec.link.status, 'linked'); assert.equal(rec.name, 'Fayu');
  assert.deepEqual((await F.stashGet(INDEX_KEY('acct'))).ids, ['inst-1']);
  assert.equal((await a.links()).length, 1);
});

test('the same folder cannot be linked twice from one browser', async () => {
  const { a } = mk();
  const { handle } = await linkIt(a);
  await assert.rejects(a.link({ handle, nickname: 'again' }), (e) => e.message === 'already_linked' && e.link.instanceId === 'inst-1');
  assert.equal((await a.linkedFor(handle)).nickname, 'Fayu corpus');
});

test('a quiet tick: 204 → a scan and a first report; unchanged → no second report', async () => {
  const { a, R } = mk();
  const { made } = await linkIt(a);
  R.calls.length = 0;
  await a.tick('inst-1');
  const reports = R.calls.filter((c) => /\/report$/.test(c[1]));
  assert.equal(reports.length, 1, 'one report');
  const body = reports[0][4].body;
  assert.equal(body.ack_seq, 0);
  const inv = JSON.parse(body.reported.slice(4));
  assert.equal(inv.type, 'lameta'); assert.equal(inv.lameta.sessions, 2); assert.equal(inv.engineVersion, 'v692');
  assert.equal(R.calls[0][1], '/v1/instances/inst-1?since=-1', 'the desired lane, from the start');
  assert.equal(R.calls[0][2], made.installId, 'as the install');
  const s = a.status('inst-1');
  assert.equal(s.permission, 'granted'); assert.equal(s.lastTickAt, 1234); assert.equal(s.linked, true);
  R.calls.length = 0;
  await a.tick('inst-1');
  assert.equal(R.calls.filter((c) => /\/report$/.test(c[1])).length, 0, 'nothing changed: no write');
});

test('commands: changeSettings applied and acked; delete refused and acked; a held command stops the cursor', async () => {
  const cmds = [
    { seq: 1, type: 'changeSettings', enc: 'enc:' + JSON.stringify({ settings: { vernLang: 'fau', analLang: 'id' } }) },
    { seq: 2, type: 'delete', enc: 'enc:' + JSON.stringify({ id: 'doc-1' }) },
    { seq: 3, type: 'assign', enc: 'enc:' + JSON.stringify({ id: 'doc-2', title: 'T' }) },
    { seq: 4, type: 'changeSettings', enc: 'enc:' + JSON.stringify({ settings: { doneEnabled: true } }) },
  ];
  const { a, R, F } = mk({ researcher: { poll: () => ({ desired_rev: 7, settings: {}, commands: cmds }) } });
  await linkIt(a);
  R.calls.length = 0;
  await a.tick('inst-1');
  const rec = await F.recallFolder(LINK_KEY('acct', 'inst-1'));
  assert.deepEqual(rec.link.settings, { vernLang: 'fau', analLang: 'id' }, 'seq 1 applied; seq 4 NOT (it is behind the held one)');
  assert.equal(rec.link.ackSeq, 2, 'acked through the refused delete, stopped before the held assign');
  assert.equal(rec.link.desiredRev, -1, 'the lane is re-read next tick, so the held command keeps appearing');
  const s = a.status('inst-1');
  assert.deepEqual(s.waiting, [{ seq: 3, type: 'assign' }, { seq: 4, type: 'changeSettings' }]);
  assert.equal(s.lastError, 'delete_refused');
  const report = R.calls.find((c) => /\/report$/.test(c[1]));
  assert.equal(report[4].body.ack_seq, 2, 'the report carries the cursor');
  assert.deepEqual(HELD, ['assign', 'uploadDelete', 'triggerUpload', 'setDone']);
  assert.equal(F.writes.length, 0, 'nothing was written to the folder');
});

test('without a held command the cursor and the lane advance', async () => {
  const { a, F } = mk({ researcher: { poll: () => ({ desired_rev: 3, settings: {}, commands: [{ seq: 5, type: 'changeSettings', enc: 'enc:{"settings":{"x":1}}' }] }) } });
  await linkIt(a);
  await a.tick('inst-1');
  const rec = await F.recallFolder(LINK_KEY('acct', 'inst-1'));
  assert.equal(rec.link.ackSeq, 5); assert.equal(rec.link.desiredRev, 3);
  assert.deepEqual(a.status('inst-1').waiting, []);
});

test('a 410 unlinks: the record is forgotten, no revoke is sent, no file is touched', async () => {
  const { a, R, F, changes } = mk({ researcher: { poll: () => ({ status: 410, error: 'revoked' }) } });
  await linkIt(a);
  await a.tick('inst-1');
  assert.equal(await F.recallFolder(LINK_KEY('acct', 'inst-1')), null, 'forgotten');
  assert.deepEqual((await F.stashGet(INDEX_KEY('acct'))).ids, []);
  assert.equal(a.status('inst-1').linked, false); assert.equal(a.status('inst-1').lastError, 'revoked');
  assert.ok(!R.calls.some((c) => c[0] === 'revokeInstall'), 'the worker already revoked it');
  assert.equal(F.writes.length, 0); assert.ok(changes.includes('inst-1'), 'the card is told');
});

test('a wipe is acked and unlinks; the folder is not touched', async () => {
  const { a, R, F } = mk({ researcher: { poll: () => ({ wipe: true }) } });
  await linkIt(a);
  R.calls.length = 0;
  await a.tick('inst-1');
  assert.ok(R.calls.some((c) => /\/wipe-ack$/.test(c[1])), 'wipe-ack, so the panel sees it confirmed');
  assert.equal(await F.recallFolder(LINK_KEY('acct', 'inst-1')), null);
  assert.equal(F.writes.length, 0);
});

test('unlink from the panel revokes the install and forgets the record', async () => {
  const { a, R, F } = mk();
  const { made } = await linkIt(a);
  await a.unlink('inst-1');
  assert.deepEqual(R.calls.find((c) => c[0] === 'revokeInstall'), ['revokeInstall', 'inst-1', made.installId]);
  assert.equal(await F.recallFolder(LINK_KEY('acct', 'inst-1')), null);
  assert.equal((await a.links()).length, 0);
});

test('a folder whose permission lapsed is reported as unavailable, and a granted request resumes', async () => {
  const { a, R, F } = mk({ files: { permission: 'prompt' } });
  await linkIt(a);
  R.calls.length = 0;
  await a.tick('inst-1');
  const inv = JSON.parse(R.calls.find((c) => /\/report$/.test(c[1]))[4].body.reported.slice(4));
  assert.equal(inv.lameta.available, false); assert.equal(inv.lameta.sessions, null);
  assert.equal(a.status('inst-1').permission, 'prompt');
  assert.equal(await a.requestPermission('inst-1'), true);
  assert.equal(F.permission, 'granted');
});

test('failures back off and are shown; the loop never throws', async () => {
  let n = 0;
  const { a } = mk({ researcher: { poll: () => { n++; return { status: 503, error: 'down' }; } } });
  await linkIt(a);
  await a.tick('inst-1'); await a.tick('inst-1');
  const s = a.status('inst-1');
  assert.equal(s.failStreak, 2); assert.equal(s.lastError, 'down'); assert.equal(s.linked, true, 'a transient failure is not a revoke');
});

test('start/stop drive tickAll on a timer that widens with failure', async () => {
  const scheduled = [];
  const timers = { setTimeout: (fn, ms) => { scheduled.push(ms); return 1; }, clearTimeout: () => {} };
  const { a } = mk({ agent: { timers } });
  await linkIt(a);
  a.start();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(a.running(), true); assert.deepEqual(scheduled, [20000], 'foreground cadence');
  a.stop(); assert.equal(a.running(), false);
});
