/* ADOPT — an existing lameta session becomes a text of the lameta device (plans/lameta-device.md
 * §6): the session file is READ (never rewritten), the primary recording and the .flextext are
 * picked or offered as a choice, the manifest is built with origin 'lameta', and — only once the
 * bytes are on Drive — the session gets its flextext/ subfolder: the manifest copy and the custody
 * record. Root files are never renamed, never removed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLametaSession, pickPrimaryRecording, pickFlextext, newHistory, withHistoryEvent, historyCustody, audioMimeOf,
         lametaSessionXml, LAMETA_HISTORY_NAME, LAMETA_SUITE_DIR } from '../docs/js/lameta.js';
import { createLametaAgent, LINK_KEY, INDEX_KEY } from '../docs/js/lameta-agent.js';
import { MANIFEST_NAME } from '../docs/js/seg-exports.js';

/* ─── the session file, read ─── */
const REAL = `<?xml version="1.0" encoding="utf-8"?>
<Session minimum_lameta_version_to_read="0.0.0">
  <id type="string">narr_air_rifle_accident</id>
  <Title type="string">Air Rifle Accident</Title>
  <Genre type="string">narrative</Genre>
  <Status type="string">In_Progress</Status>
  <Contributions>
    <contributor>
      <name>Suhu, Yohanis</name>
      <role>author</role>
      <date>0001-01-01</date>
    </contributor>
  </Contributions>
</Session>`;

test('parseLametaSession reads a real session file, and one we wrote, and never needs a DOM', () => {
  const r = parseLametaSession(REAL);
  assert.equal(r.id, 'narr_air_rifle_accident'); assert.equal(r.title, 'Air Rifle Accident'); assert.equal(r.genre, 'narrative');
  assert.equal(r.status, 'In_Progress'); assert.equal(r.done, false);
  assert.deepEqual(r.contributors, [{ name: 'Suhu, Yohanis', role: 'author', date: '0001-01-01' }]);
  const ours = parseLametaSession(lametaSessionXml({ title: 'Suu & <the> "raid"', vernLang: 'fau', analLang: 'id', date: '2026-09-27', done: true,
    stages: { Stage_Record: 'done' }, docId: 'd1', flexGuid: 'g1', engine: 'v693', now: 0,
    contributors: [{ name: 'A', role: 'glosser' }, { name: 'B', role: 'speaker' }] }));
  assert.equal(ours.title, 'Suu & <the> "raid"', 'entities unescaped'); assert.equal(ours.languages, 'fau'); assert.equal(ours.workingLanguages, 'id');
  assert.equal(ours.date, '2026-09-27'); assert.equal(ours.done, true, 'Finished reads as done');
  assert.deepEqual(ours.contributors.map((c) => [c.name, c.role]), [['A', ''], ['B', 'speaker']], 'unspecified reads back as no role, as lameta reads it');
  assert.equal(ours.customFields.Stage_Record, 'done'); assert.equal(ours.customFields.Suite_Doc_Id, 'd1'); assert.equal(ours.customFields.Flex_Text_Guid, 'g1');
  assert.deepEqual(parseLametaSession(''), { id: '', title: '', status: '', genre: '', date: '', languages: '', workingLanguages: '', contributors: [], customFields: {}, done: false });
});

/* ─── the pickers ─── */
test('the primary recording: lossless beats lossy, one clear winner is picked, several are a choice', () => {
  const f = (name, size = 1) => ({ name, size });
  assert.equal(pickPrimaryRecording([f('x.wav', 5), f('x.mp3', 1)]).pick.name, 'x.wav');
  assert.equal(pickPrimaryRecording([f('x.mp3', 1)]).pick.name, 'x.mp3', 'lossy alone is fine');
  const two = pickPrimaryRecording([f('a.wav', 5), f('b.wav', 9)]);
  assert.equal(two.pick, null); assert.deepEqual(two.candidates.map((x) => x.name), ['b.wav', 'a.wav'], 'a choice, largest first');
  assert.equal(pickPrimaryRecording([f('x.converted-NOT-ARCHIVAL.wav', 9), f('x.mp3', 1)]).pick.name, 'x.mp3', 'our converted copy never qualifies');
  assert.equal(pickPrimaryRecording([f('consent-response.m4a', 9), f('x.mp3', 1)]).pick.name, 'x.mp3', 'a consent clip never qualifies');
  assert.equal(pickPrimaryRecording([f('x.returned-2026-09-27.wav', 9), f('x.wav', 1)]).pick.name, 'x.wav', 'a returned twin never qualifies');
  assert.deepEqual(pickPrimaryRecording([f('x.eaf'), f('x.flextext'), f('x.session')]), { pick: null, candidates: [] });
  assert.equal(pickFlextext([f('x.flextext'), f('x.wav')]).pick.name, 'x.flextext');
  assert.equal(pickFlextext([f('x.wav')]).pick, null);
  assert.equal(pickFlextext([f('a.flextext'), f('b.flextext')]).pick, null); assert.equal(pickFlextext([f('a.flextext'), f('b.flextext')]).candidates.length, 2);
  assert.equal(audioMimeOf('x.WAV'), 'audio/wav'); assert.equal(audioMimeOf('x.m4a'), 'audio/mp4'); assert.equal(audioMimeOf('x.zzz'), 'application/octet-stream');
});

/* ─── the history file ─── */
test('the history file: born with custody, moved by custody-changing events only', () => {
  const h = newHistory({ docId: 'd1', sessionId: 'Tautua_Do', holder: { kind: 'lameta', id: 'inst-1', name: 'Fayu corpus' }, by: { kind: 'lameta-agent', id: 'ins' }, now: 0 });
  assert.equal(h.schema, 1); assert.equal(h.docId, 'd1'); assert.equal(h.sessionId, 'Tautua_Do');
  assert.deepEqual(h.custody, { holder: { kind: 'lameta', id: 'inst-1', name: 'Fayu corpus' }, since: '1970-01-01T00:00:00.000Z' });
  assert.equal(h.events.length, 1); assert.equal(h.events[0].kind, 'adopted'); assert.equal(h.events[0].by.id, 'ins');
  const out = withHistoryEvent(h, { kind: 'checked_out', from: h.custody.holder, to: { kind: 'device', id: 'phone', name: 'Tablet A' }, now: 1000 });
  assert.equal(historyCustody(out).id, 'phone', 'a checkout moves custody');
  assert.equal(historyCustody(h).id, 'inst-1', '...on a new object; the old one is untouched');
  const renamed = withHistoryEvent(out, { kind: 'renamed', from: { name: 'a' }, to: { name: 'b' }, now: 2000 });
  assert.equal(historyCustody(renamed).id, 'phone', 'a rename is an event, not a custody change');
  assert.equal(renamed.events.length, 3);
  assert.deepEqual(historyCustody(null), { kind: 'unassigned' });
});

/* ─── the agent, against a fake project ─── */
function fakeFile(name, { text = '', size = null, type = '' } = {}) {
  const t = String(text);
  const file = { name, size: size == null ? t.length : size, lastModified: 1700000000000, type,
    text: async () => t, arrayBuffer: async () => new TextEncoder().encode(t).buffer };
  return { kind: 'file', name, getFile: async () => file, _text: t };
}
function fakeDir(name, entries = {}) {
  const dir = { kind: 'directory', name, _entries: entries,
    async *values() { for (const e of Object.values(entries)) yield e; },
    async getFileHandle(n, { create } = {}) {
      if (entries[n] && entries[n].kind === 'file') return entries[n];
      if (!create) { const e = new Error('nope'); e.name = entries[n] ? 'TypeMismatchError' : 'NotFoundError'; throw e; }
      entries[n] = fakeFile(n); return entries[n];
    },
    async getDirectoryHandle(n, { create } = {}) {
      if (entries[n] && entries[n].kind === 'directory') return entries[n];
      if (!create) { const e = new Error('nope'); e.name = entries[n] ? 'TypeMismatchError' : 'NotFoundError'; throw e; }
      entries[n] = fakeDir(n); return entries[n];
    },
  };
  return dir;
}
const manifestFor = (docId, title) => JSON.stringify({ schema: 3, docId, title, audio: { name: 'x.wav' }, files: [] });
const historyFor = (docId, holder) => JSON.stringify(newHistory({ docId, holder, now: 5000 }));
function project() {
  return fakeDir('Fayu', { 'Fayu.sprj': fakeFile('Fayu.sprj'), Sessions: fakeDir('Sessions', {
    Mine: fakeDir('Mine', { 'Mine.session': fakeFile('Mine.session', { text: lametaSessionXml({ id: 'Mine', title: 'Mine', done: true }) }), 'Mine.wav': fakeFile('Mine.wav', { size: 10 }),
      flextext: fakeDir('flextext', { [MANIFEST_NAME]: fakeFile(MANIFEST_NAME, { text: manifestFor('doc-mine', 'Mine title') }),
                                      [LAMETA_HISTORY_NAME]: fakeFile(LAMETA_HISTORY_NAME, { text: historyFor('doc-mine', { kind: 'lameta', id: 'inst-1', name: 'Fayu corpus' }) }) }) }),
    Elsewhere: fakeDir('Elsewhere', { 'Elsewhere.session': fakeFile('Elsewhere.session', { text: lametaSessionXml({ id: 'Elsewhere', title: 'E' }) }),
      flextext: fakeDir('flextext', { [MANIFEST_NAME]: fakeFile(MANIFEST_NAME, { text: manifestFor('doc-else', 'E') }),
                                      [LAMETA_HISTORY_NAME]: fakeFile(LAMETA_HISTORY_NAME, { text: historyFor('doc-else', { kind: 'device', id: 'phone', name: 'Tablet A' }) }) }) }),
    Tautua_Do: fakeDir('Tautua_Do', {
      'Tautua_Do.session': fakeFile('Tautua_Do.session', { text: lametaSessionXml({ id: 'Tautua_Do', title: 'Tautua Do', vernLang: 'fau', analLang: 'id', contributors: [{ name: 'Suhu, Yohanis', role: 'author' }] }) }),
      'Tautua_Do.wav': fakeFile('Tautua_Do.wav', { text: 'RIFF....', type: 'audio/wav' }),
      'Tautua_Do.mp3': fakeFile('Tautua_Do.mp3', { text: 'ID3', type: 'audio/mpeg' }),
      'Tautua_Do.flextext': fakeFile('Tautua_Do.flextext', { text: '<document><interlinear-text guid="4f2c-guid"><item type="title" lang="en">Tautua Do</item></interlinear-text></document>' }),
      'Tautua_Do.eaf': fakeFile('Tautua_Do.eaf', { text: '<ANNOTATION_DOCUMENT/>' }),
      'Tautua_Do.wav.meta': fakeFile('Tautua_Do.wav.meta', { text: '<Meta/>' }),
    }),
  }) });
}
function fakeFiles() {
  const store = new Map();
  const F = { store, writes: [],
    stashGet: async (k) => (store.has(k) ? store.get(k) : null), stashPut: async (k, v) => { store.set(k, v); return true; }, stashDelete: async (k) => store.delete(k),
    rememberFolder: async (k, handle, meta = {}) => { store.set(k, { handle, name: handle && handle.name, at: 1, ...meta }); return true; },
    recallFolder: async (k) => (store.has(k) ? store.get(k) : null), forgetFolder: async (k) => store.delete(k),
    sameEntry: async (a, b) => a === b, permissionState: async () => 'granted', requestFolderPermission: async () => true,
    listDir: async (dir) => { const out = []; for await (const e of dir.values()) out.push({ name: e.name, kind: e.kind }); return out.sort((a, b) => a.name.localeCompare(b.name)); },
    getDir: async (dir, n) => { try { return await dir.getDirectoryHandle(n); } catch { return null; } },
    ensureDir: async (dir, path) => { let cur = dir; for (const p of path.split('/')) cur = await cur.getDirectoryHandle(p, { create: true }); return cur; },
    statFile: async (dir, n) => { try { const fh = await dir.getFileHandle(n); const f = await fh.getFile(); return { name: n, size: f.size, modified: f.lastModified, type: f.type, available: true }; } catch { return null; } },
    readFile: async (dir, n, { as = 'blob' } = {}) => { let fh; try { fh = await dir.getFileHandle(n); } catch { return null; } const f = await fh.getFile(); return as === 'text' ? f.text() : as === 'arrayBuffer' ? f.arrayBuffer() : f; },
    writeFile: async (dir, n, data) => { F.writes.push(`${dir.name}/${n}`); dir._entries[n] = fakeFile(n, { text: typeof data === 'string' ? data : '[bytes]' }); return true; },
  };
  return F;
}
function fakeResearcher() {
  const R = { calls: [], currentAccountId: () => 'acct',
    createInstance: async (nickname) => ({ instance_id: 'inst-1', nickname }), mintInvite: async () => ({ invite_id: 'inv-1', secret: 's' }),
    approveInstall: async () => ({ ok: true }), revokeInstall: async () => {},
    apiAsInstall: async (method, path, install, opts = {}) => { R.calls.push([method, path, opts]); return {}; },
    encryptForInstance: async (id, obj) => 'enc:' + JSON.stringify(obj), decryptForInstance: async (id, tok) => JSON.parse(String(tok).slice(4)) };
  return R;
}
async function linkedAgent() {
  const F = fakeFiles(), R = fakeResearcher(); const handle = project();
  const a = createLametaAgent({ R, F, engineVersion: 'v693', ua: 'UA', log: { warn() {} }, now: () => 7000 });
  await a.link({ handle, nickname: 'Fayu corpus', projectName: 'Fayu', sprjName: 'Fayu.sprj' });
  const rec = await F.recallFolder(LINK_KEY('acct', 'inst-1')); rec.link.settings = { vernLang: 'fau', analLang: 'id' }; await F.rememberFolder(LINK_KEY('acct', 'inst-1'), rec.handle, { link: rec.link });
  return { a, F, R, handle };
}
const reportedInv = (R) => JSON.parse(R.calls.filter((c) => /\/report$/.test(c[1])).pop()[2].body.reported.slice(4));

test('the scan: custody here is a text; a manifest held elsewhere is not; a plain session is adoptable', async () => {
  const { a, R } = await linkedAgent();
  await a.tick('inst-1');
  const inv = reportedInv(R);
  assert.deepEqual(inv.items.map((i) => [i.id, i.title, i.hasAudio, i.done, i.uploadState, i.lameta.sessionId]), [['doc-mine', 'Mine title', true, true, 'uploaded', 'Mine']],
    'Mine: custody names this instance, title from the manifest, Done from the .session');
  assert.equal(inv.lameta.sessions, 3);
  const s = a.status('inst-1');
  assert.deepEqual(s.sessions.map((e) => [e.name, e.docId, e.custody && e.custody.kind]), [['Elsewhere', 'doc-else', 'device'], ['Mine', 'doc-mine', 'lameta'], ['Tautua_Do', '', null]]);
  assert.ok(!('cache' in s), 'the cache is the agent\'s, not the card\'s');
  R.calls.length = 0;
  await a.tick('inst-1');
  assert.equal(R.calls.filter((c) => /\/report$/.test(c[1])).length, 0, 'a second scan reads nothing new and reports nothing');
});

test('prepareAdopt reads the session and offers the choices; beginAdopt builds the text; finishAdopt writes only flextext/', async () => {
  const { a, F, R, handle } = await linkedAgent();
  await a.tick('inst-1');
  const prep = await a.prepareAdopt('inst-1', 'Tautua_Do');
  assert.equal(prep.title, 'Tautua Do', 'the title from the .session'); assert.equal(prep.done, false);
  assert.deepEqual(prep.contributors, [{ name: 'Suhu, Yohanis', role: 'author', date: '0001-01-01' }]);
  assert.equal(prep.recording.pick.name, 'Tautua_Do.wav', 'lossless wins over the mp3');
  assert.equal(prep.flextext.pick.name, 'Tautua_Do.flextext'); assert.equal(prep.eaf, 'Tautua_Do.eaf');
  assert.ok(!prep.files.some((f) => /\.meta$/.test(f.name)), 'sidecars are not candidates');
  await assert.rejects(a.prepareAdopt('inst-1', 'Mine'), (e) => e.message === 'already_adopted' && e.docId === 'doc-mine');
  await assert.rejects(a.prepareAdopt('inst-1', 'Nope'), /no_session/);

  const plan = await a.beginAdopt('inst-1', 'Tautua_Do', { title: 'Tautua Do', recording: 'Tautua_Do.wav', flextext: 'Tautua_Do.flextext', done: false });
  assert.ok(plan.docId && plan.docId.length >= 32); assert.equal(plan.flexGuid, '4f2c-guid', 'the guid the FILE carries');
  const m = plan.manifest;
  assert.equal(m.schema, 3); assert.equal(m.origin, 'lameta'); assert.deepEqual(m.source, { kind: 'lameta', id: 'inst-1', name: 'Fayu' });
  assert.deepEqual(m.lameta, { sessionId: 'Tautua_Do', projectName: 'Fayu', projectGuid: '' }); assert.deepEqual(m.flex, { textGuid: '4f2c-guid' });
  assert.deepEqual(m.writingSystems, { vern: 'fau', anal: 'id' }, 'the codes the device settings carry');
  assert.equal(m.audio.name, 'Tautua_Do.wav'); assert.equal(m.audio.mime, 'audio/wav'); assert.equal(m.audio.sha256.length, 64, 'hashed on the computer');
  assert.deepEqual(m.files.map((f) => [f.name, f.role]), [[MANIFEST_NAME, 'manifest'], ['Tautua_Do.wav', 'source-audio'], ['Tautua_Do.flextext', 'source-flextext']]);
  assert.equal(plan.audio.blob.size, 8); assert.equal(plan.flextext.mime, 'application/xml');
  assert.equal(F.writes.length, 0, 'beginAdopt writes NOTHING — the bytes go to Drive first');

  R.calls.length = 0;
  const h = await a.finishAdopt('inst-1', { docId: plan.docId, sessionName: 'Tautua_Do', manifest: m, manifestFileId: 'mf-1', done: false });
  assert.deepEqual(F.writes, [`${LAMETA_SUITE_DIR}/${MANIFEST_NAME}`, `${LAMETA_SUITE_DIR}/${LAMETA_HISTORY_NAME}`], 'two files, both under flextext/');
  assert.equal(historyCustody(h).id, 'inst-1'); assert.equal(h.events[0].kind, 'adopted'); assert.equal(h.manifestFileId, 'mf-1');
  const sessionDir = handle._entries.Sessions._entries.Tautua_Do;
  assert.deepEqual(Object.keys(sessionDir._entries).sort(), ['Tautua_Do.eaf', 'Tautua_Do.flextext', 'Tautua_Do.mp3', 'Tautua_Do.session', 'Tautua_Do.wav', 'Tautua_Do.wav.meta', 'flextext'].sort(), 'root files untouched');
  assert.equal(sessionDir._entries['Tautua_Do.session']._text.includes('<Status type="string">In_Progress</Status>'), true, 'the .session was not rewritten');
  const inv = reportedInv(R);
  assert.ok(inv.items.some((i) => i.id === plan.docId && i.lameta.sessionId === 'Tautua_Do' && i.hasAudio && i.uploadedFileId === 'mf-1'), 'reported at once');
  assert.deepEqual(a.status('inst-1').sessions.find((e) => e.name === 'Tautua_Do').docId, plan.docId);
  await assert.rejects(a.prepareAdopt('inst-1', 'Tautua_Do'), /already_adopted/);
});

test('an audio-only or text-only adopt is allowed, and an unreadable pick is refused', async () => {
  const { a } = await linkedAgent();
  const noAudio = await a.beginAdopt('inst-1', 'Tautua_Do', { title: 'T', recording: null, flextext: 'Tautua_Do.flextext' });
  assert.equal(noAudio.audio, null); assert.equal(noAudio.manifest.audio, null); assert.equal(noAudio.manifest.files.length, 2);
  const noText = await a.beginAdopt('inst-1', 'Tautua_Do', { title: 'T', recording: 'Tautua_Do.mp3', flextext: null });
  assert.equal(noText.flextext, null); assert.equal(noText.flexGuid, ''); assert.ok(!('flex' in noText.manifest)); assert.equal(noText.audio.mime, 'audio/mpeg');
  await assert.rejects(a.beginAdopt('inst-1', 'Tautua_Do', { recording: 'missing.wav' }), /recording_unreadable/);
});
