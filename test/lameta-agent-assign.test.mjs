/* M5 — A PHONE'S TEXT MOVED IN BECOMES A lameta SESSION (docs/js/lameta-agent.js, the `assign`
 * handler; plans/lameta-device.md §10), plus the FlexText Metadata OPEN MARKER
 * (plans/flextext-metadata.md §5).
 *
 * Same style as lameta-agent-dispatch.test.mjs: the researcher is a fake that serves a text's
 * Drive folder by role, the folder is a file-backed fake behind the files.js seam, the converter
 * is a fake, and parseFlextext is a fake that hands back a doc in the engine's own shape (the
 * real one needs a DOMParser). What is pinned: the files a NEW session gets and does not get; a
 * RETURN TRIP's rules (replace the annotation set, back the old .flextext up outside the session,
 * never touch the recording, never rewrite the .session, queue the stage facts); the ack rule
 * (only after every write; a failure holds with its error, Retry and Skip); and the marker's
 * three states with the one gate it drives. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLametaAgent, LINK_KEY, HANDLED, HELD, BACKUP_DIR, pickTextFiles, queueLametaUpdate,
         openMarkerState, readOpenMarker, lametaWritePolicy, OPEN_MARKER_NAME, OPEN_MARKER_STALE_MS, HELD_RETRY_MS } from '../docs/js/lameta-agent.js';
import { makeDoc, reconcileBaseline } from '../docs/js/flextext.js';
import { parseLametaSession, newHistory, LAMETA_HISTORY_NAME, LAMETA_SUITE_DIR } from '../docs/js/lameta.js';
import { MANIFEST_NAME } from '../docs/js/seg-exports.js';

/* ─── a file-backed fake folder ─── */
const blobOf = (data) => (data instanceof Blob ? data : new Blob([data]));
function fakeFile(name, data, { hang = false } = {}) {
  const f = { kind: 'file', name, _data: blobOf(data), _hang: hang, writes: 0,
    async getFile() {
      if (f._hang) return new Promise(() => {});                 // a cloud placeholder: never answers
      const b = f._data;
      return { size: b.size, lastModified: 1, type: b.type, text: () => b.text(), arrayBuffer: () => b.arrayBuffer(), slice: b.slice.bind(b) };
    },
    async createWritable() { let buf = []; return { write: async (d) => { buf.push(d); }, close: async () => { f._data = new Blob(buf); f.writes++; }, abort: async () => {} }; },
  };
  return f;
}
function fakeDir(name, entries = {}) {
  return { kind: 'directory', name, _entries: entries,
    async *values() { for (const e of Object.values(entries)) yield e; },
    async getDirectoryHandle(n, { create } = {}) {
      if (entries[n] && entries[n].kind === 'directory') return entries[n];
      if (!create) { const e = new Error('nope'); e.name = 'NotFoundError'; throw e; }
      entries[n] = fakeDir(n); return entries[n];
    },
    async getFileHandle(n, { create } = {}) {
      if (entries[n] && entries[n].kind === 'file') return entries[n];
      if (!create) { const e = new Error('nope'); e.name = 'NotFoundError'; throw e; }
      entries[n] = fakeFile(n, ''); return entries[n];
    },
  };
}
const at = (dir, path) => path.split('/').reduce((d, p) => (d && d._entries ? d._entries[p] : undefined), dir);
const names = (dir) => Object.keys(dir._entries).sort();
const textOf = async (dir, path) => { const f = at(dir, path); return f ? f._data.text() : null; };
const bytesOf = async (dir, path) => new Uint8Array(await at(dir, path)._data.arrayBuffer());

/* The real seam's functions over the fake handles (files.js's own logic is pinned elsewhere; here
 * the point is the AGENT, so the fake answers like the seam and records nothing it did not do). */
function fakeFiles() {
  const store = new Map();
  const timeout = (what, ms) => { const e = new Error(`${what} did not finish in ${ms} ms`); e.code = 'FILES_TIMEOUT'; return e; };
  const race = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(timeout(what, ms)), ms))]);
  const getFileEntry = async (dir, n) => { try { return await dir.getFileHandle(n); } catch { return null; } };
  const F = { store, permission: 'granted',
    stashGet: async (k) => (store.has(k) ? store.get(k) : null), stashPut: async (k, v) => { store.set(k, v); return true; },
    rememberFolder: async (k, handle, meta = {}) => { store.set(k, { handle, name: handle && handle.name, at: 1, ...meta }); return true; },
    recallFolder: async (k) => (store.has(k) ? store.get(k) : null), forgetFolder: async (k) => store.delete(k),
    sameEntry: async (a, b) => a === b,
    permissionState: async () => F.permission, requestFolderPermission: async () => true,
    listDir: async (dir) => { const out = []; for await (const e of dir.values()) out.push({ name: e.name, kind: e.kind }); return out.sort((a, b) => a.name.localeCompare(b.name)); },
    getDir: async (dir, n) => { try { return await dir.getDirectoryHandle(n); } catch { return null; } },
    ensureDir: async (dir, path) => { let cur = dir; for (const p of path.split('/').filter(Boolean)) cur = await cur.getDirectoryHandle(p, { create: true }); return cur; },
    statFile: async (dir, n, { timeoutMs = 50 } = {}) => {
      const fh = await getFileEntry(dir, n); if (!fh) return null;
      try { const f = await race(fh.getFile(), timeoutMs, 'stat'); return { name: n, size: f.size, modified: 1, type: f.type, available: true }; }
      catch (e) { if (e.code === 'FILES_TIMEOUT') return { name: n, size: 0, modified: 0, type: '', available: false }; throw e; }
    },
    readFile: async (dir, n, { as = 'blob', timeoutMs = 50 } = {}) => {
      const fh = await getFileEntry(dir, n); if (!fh) return null;
      const f = await race(fh.getFile(), timeoutMs, 'opening ' + n);
      if (as === 'blob') return fh._data;
      return as === 'text' ? f.text() : f.arrayBuffer();
    },
    writeFile: async (dir, n, data) => { const fh = await dir.getFileHandle(n, { create: true }); const w = await fh.createWritable(); await w.write(data); await w.close(); return true; },
  };
  return F;
}

/* ─── the text on Drive, by role ─── */
function segDoc() {
  const doc = makeDoc({ vernLang: 'fau', analLang: 'id' });
  reconcileBaseline(doc, ['satu dua', 'tiga empat'], { flatSegments: true });
  doc.paragraphs[0].segments[0].free = 'one two';
  doc.paragraphs[0].segments[0].attrs = { 'begin-time-offset': '0', 'end-time-offset': '2000' };
  doc.paragraphs[1].segments[0].attrs = { 'begin-time-offset': '2000', 'end-time-offset': '4000' };
  return doc;
}
const FT_XML = `<?xml version="1.0" encoding="utf-8"?>\n<document version="2"><interlinear-text guid="4f2c0c2e-0000-4000-8000-000000000001"><item type="title" lang="en">Air Rifle Accident</item><paragraphs/><media-files><media guid="m1" location="C:\\x\\story.m4a"/></media-files></interlinear-text></document>`;
const AUDIO = new Blob([new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4])], { type: 'audio/mp4' });
const manifestFor = (docId, { audio = true } = {}) => ({ schema: 3, docId, title: 'Air Rifle Accident', origin: 'device', writtenAt: 1, engine: 'v709',
  writingSystems: { vern: 'fau', anal: 'id' }, audio: audio ? { name: 'story.m4a', mime: 'audio/mp4', bytes: 12, derived: false } : null,
  consent: { response: 'yes' },
  files: [{ name: MANIFEST_NAME, role: 'manifest', mime: 'application/json', bytes: 0 },
          ...(audio ? [{ name: 'story.m4a', role: 'source-audio', mime: 'audio/mp4', bytes: 12 }] : []),
          { name: 'Air Rifle Accident.flextext', role: 'source-flextext', mime: 'application/xml', bytes: 300 }] });
function driveText(docId, { audio = true, wav = false, flextext = true, manifest = true, xml = FT_XML, audioBlob = AUDIO } = {}) {
  const files = [], bytes = new Map();
  if (manifest) { files.push({ id: 'f-man', name: MANIFEST_NAME, role: 'manifest', size: 10, mime: 'application/json' }); bytes.set('f-man', new Blob([JSON.stringify(manifestFor(docId, { audio }))])); }
  if (audio) { const n = wav ? 'story.wav' : 'story.m4a'; files.push({ id: 'f-aud', name: n, role: 'source-audio', size: audioBlob.size, mime: wav ? 'audio/wav' : 'audio/mp4' }); bytes.set('f-aud', audioBlob); }
  if (flextext) { files.push({ id: 'f-ft', name: 'Air Rifle Accident.flextext', role: 'source-flextext', size: xml.length, mime: 'application/xml' }); bytes.set('f-ft', new Blob([xml], { type: 'application/xml' })); }
  files.push({ id: 'f-rcpt', name: 'consent-receipt.json', role: 'consent-receipt', size: 30, mime: 'application/json' }); bytes.set('f-rcpt', new Blob([JSON.stringify({ signatureName: 'Suhu, Yohanis' })]));
  return { folderId: 'fld-t', files, bytes };
}
function fakeResearcher({ poll = () => ({}), texts = {} } = {}) {
  const R = { calls: [], poll, texts, fetched: [],
    currentAccountId: () => 'acct',
    createInstance: async (nickname) => ({ instance_id: 'inst-1', nickname, type: '' }),
    mintInvite: async () => ({ invite_id: 'inv-1', secret: 'sekrit', expires_at: 0 }),
    approveInstall: async () => ({ ok: true }), revokeInstall: async () => {},
    apiAsInstall: async (method, path, install, opts = {}) => {
      R.calls.push([method, path, install.installId, install.installSecret, opts]);
      if (method === 'GET') { const r = R.poll(); if (r && r.status) { const e = new Error(r.error || 'http'); e.status = r.status; throw e; } return r; }
      return {};
    },
    listTextFiles: async (instanceId, docId) => { R.calls.push(['listTextFiles', instanceId, docId]); const t = texts[docId]; if (!t) throw new Error('no_such_text'); return { folderId: t.folderId, files: t.files }; },
    fetchDriveFile: async (fileId, onProgress) => {
      R.fetched.push(fileId);
      for (const t of Object.values(texts)) if (t.bytes.has(fileId)) { if (onProgress) onProgress(1); return t.bytes.get(fileId); }
      throw new Error('file_fetch_failed_404');
    },
    encryptForInstance: async (id, obj) => 'enc:' + JSON.stringify(obj),
    decryptForInstance: async (id, tok) => JSON.parse(String(tok).slice(4)),
  };
  return R;
}
const cmd = (seq, type, body) => ({ seq, type, enc: 'enc:' + JSON.stringify(body) });
const project = (sessions = {}) => fakeDir('Fayu', { 'Fayu.sprj': fakeFile('Fayu.sprj', '<Project/>'), Sessions: fakeDir('Sessions', sessions) });
const WAV_BYTES = () => { const b = new ArrayBuffer(44), v = new DataView(b); const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }; w(0, 'RIFF'); v.setUint32(4, 36, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, 0, true); return b; };
const mk = (over = {}) => {
  const F = fakeFiles(), R = fakeResearcher(over.researcher || {});
  const converted = [];
  const changes = [];
  const parsed = [];
  const a = createLametaAgent({ R, F, engineVersion: 'v710', ua: 'TestBrowser', onChange: (id) => changes.push(id), log: { warn() {} },
    now: over.now || (() => Date.UTC(2026, 9, 10, 12, 0, 0)), visible: () => true,
    convertWav: over.convertWav === null ? null : async (blob) => { converted.push(blob); return new Blob([WAV_BYTES()], { type: 'audio/wav' }); },
    parseFlextext: over.parseFlextext === null ? null : (xml) => { parsed.push(xml); return { texts: [segDoc()] }; },
    producedBy: () => 'FlexText test', ...(over.agent || {}) });
  return { a, F, R, changes, converted, parsed };
};
const linkIt = async (a, handle) => a.link({ handle, nickname: 'Fayu corpus', projectName: 'Fayu', sprjName: 'Fayu.sprj' });
const rec = (F) => F.recallFolder(LINK_KEY('acct', 'inst-1'));

test('assign is handled now; the held kinds are the M6/M7 ones; a text\'s Drive files are picked by role', () => {
  assert.deepEqual(HANDLED, ['changeSettings', 'delete', 'assign']);
  assert.deepEqual(HELD, ['uploadDelete', 'triggerUpload', 'setDone']);
  const p = pickTextFiles(driveText('d').files);
  assert.equal(p.audio.id, 'f-aud'); assert.equal(p.flextext.id, 'f-ft'); assert.equal(p.manifest.id, 'f-man'); assert.equal(p.receipt.id, 'f-rcpt');
  assert.equal(pickTextFiles([{ id: 'x', name: 'old.flextext' }]).flextext.id, 'x', 'a bare .flextext without a role still counts');
});

test('a new text: fetched as the researcher, converted, written as ONE session folder with everything lameta needs and nothing of ours listed', async () => {
  const handle = project();
  const { a, F, R, converted, parsed } = mk({ researcher: { texts: { 'doc-1': driveText('doc-1') },
    poll: () => ({ desired_rev: 4, settings: {}, commands: [cmd(1, 'assign', { id: 'doc-1', title: 'Air Rifle Accident', folderId: 'fld-t' })] }) } });
  await linkIt(a, handle);
  await a.tick('inst-1');
  assert.deepEqual(R.calls.find((c) => c[0] === 'listTextFiles'), ['listTextFiles', 'inst-1', 'doc-1'], 'listed under the lameta device, which the move re-parented the folder to');
  assert.deepEqual(R.fetched.sort(), ['f-aud', 'f-ft', 'f-man', 'f-rcpt'], 'manifest, recording, .flextext and the receipt — not the command\'s streaming URLs');
  assert.equal(converted.length, 1, 'an m4a is converted to the WAV working copy'); assert.equal(parsed[0], FT_XML);
  const sessions = at(handle, 'Sessions');
  assert.deepEqual(names(sessions), ['Air_Rifle_Accident'], 'one folder, lameta\'s own id rule, nothing else under Sessions/');
  const dir = at(sessions, 'Air_Rifle_Accident');
  assert.deepEqual(names(dir), [
    'Air_Rifle_Accident.converted-NOT-ARCHIVAL.wav', 'Air_Rifle_Accident.converted-NOT-ARCHIVAL.wav.meta',
    'Air_Rifle_Accident.eaf', 'Air_Rifle_Accident.eaf.meta', 'Air_Rifle_Accident.flextext', 'Air_Rifle_Accident.flextext.meta',
    'Air_Rifle_Accident.m4a', 'Air_Rifle_Accident.m4a.meta', 'Air_Rifle_Accident.pfsx', 'Air_Rifle_Accident.pfsx.meta',
    'Air_Rifle_Accident.session', 'flextext'], 'no HOW-TO-OPEN.txt, a .meta beside every file we made');
  assert.deepEqual(names(at(dir, 'flextext')), [LAMETA_HISTORY_NAME, MANIFEST_NAME]);
  // The .session: title, status from the stages, the languages, the speaker, the identity fields.
  const sx = await textOf(dir, 'Air_Rifle_Accident.session');
  const sess = parseLametaSession(sx);
  assert.equal(sess.id, 'Air_Rifle_Accident'); assert.equal(sess.title, 'Air Rifle Accident');
  assert.equal(sess.languages, 'fau'); assert.equal(sess.workingLanguages, 'id');
  assert.deepEqual(sess.contributors, [{ name: 'Suhu, Yohanis', role: 'speaker', date: '0001-01-01' }]);
  assert.equal(sess.customFields.Suite_Doc_Id, 'doc-1'); assert.equal(sess.customFields.Flex_Text_Guid, '4f2c0c2e-0000-4000-8000-000000000001');
  assert.equal(sess.customFields.Stage_Record, 'done'); assert.equal(sess.customFields.Stage_Consent, 'done'); assert.equal(sess.customFields.Stage_Transcribe, 'done');
  assert.match(sess.customFields.Suite_Stamp, /;v710;status=In_Progress$/);
  // The .flextext is the fetched XML with ONLY its media reference repointed, at the derived WAV.
  const ft = await textOf(dir, 'Air_Rifle_Accident.flextext');
  assert.match(ft, /<media guid="m1" location="Air_Rifle_Accident\.converted-NOT-ARCHIVAL\.wav"\/>/);
  assert.equal(ft.replace(/location="[^"]*"/, 'L'), FT_XML.replace(/location="[^"]*"/, 'L'), 'byte for byte otherwise');
  const eaf = await textOf(dir, 'Air_Rifle_Accident.eaf');
  assert.match(eaf, /MEDIA_URL="[^"]*Air_Rifle_Accident\.converted-NOT-ARCHIVAL\.wav"/, 'the EAF points at the WAV that ships beside it');
  assert.equal(await textOf(dir, 'Air_Rifle_Accident.m4a.meta'), await textOf(dir, 'Air_Rifle_Accident.eaf.meta'));
  assert.deepEqual([...await bytesOf(dir, 'Air_Rifle_Accident.m4a')], [...new Uint8Array(await AUDIO.arrayBuffer())], 'the original, untouched');
  // The suite files: the manifest's Drive bytes, and a history that says this device holds the text.
  assert.equal(JSON.parse(await textOf(dir, `flextext/${MANIFEST_NAME}`)).docId, 'doc-1');
  const h = JSON.parse(await textOf(dir, `flextext/${LAMETA_HISTORY_NAME}`));
  assert.equal(h.docId, 'doc-1'); assert.equal(h.sessionId, 'Air_Rifle_Accident');
  assert.deepEqual(h.custody.holder, { kind: 'lameta', id: 'inst-1', name: 'Fayu corpus' });
  assert.equal(h.events.length, 1); assert.equal(h.events[0].kind, 'assigned'); assert.equal(h.events[0].by.kind, 'lameta-agent');
  // Acked — only now — and the lane advanced; the inventory lists the text at once.
  const L = (await rec(F)).link;
  assert.equal(L.ackSeq, 1); assert.equal(L.desiredRev, 4);
  const inv = JSON.parse(R.calls.filter((c) => /\/report$/.test(c[1])).pop()[4].body.reported.slice(4));
  assert.deepEqual(inv.items.map((i) => [i.id, i.title, i.hasAudio, i.lameta.sessionId]), [['doc-1', 'Air Rifle Accident', true, 'Air_Rifle_Accident']]);
  const s = a.status('inst-1');
  assert.deepEqual(s.waiting, []); assert.equal(s.heldFail, null); assert.equal(s.work, null);
  assert.equal(s.lastAssign.sessionId, 'Air_Rifle_Accident'); assert.equal(s.lastAssign.returning, false);
  assert.deepEqual(s.pendingLameta, [], 'a new folder queues nothing: its .session was written in full');
});

test('a WAV recording is the timeline itself: no conversion, no derived copy, the EAF and the .flextext name the WAV', async () => {
  const handle = project();
  const { a, converted } = mk({ researcher: { texts: { 'doc-1': driveText('doc-1', { wav: true, audioBlob: new Blob([WAV_BYTES()], { type: 'audio/wav' }) }) },
    poll: () => ({ desired_rev: 1, settings: {}, commands: [cmd(1, 'assign', { id: 'doc-1', title: 'Air Rifle Accident' })] }) } });
  await linkIt(a, handle); await a.tick('inst-1');
  assert.equal(converted.length, 0);
  const dir = at(handle, 'Sessions/Air_Rifle_Accident');
  assert.ok(!names(dir).some((n) => /converted/.test(n)), names(dir).join(','));
  assert.match(await textOf(dir, 'Air_Rifle_Accident.flextext'), /location="Air_Rifle_Accident\.wav"/);
  assert.match(await textOf(dir, 'Air_Rifle_Accident.eaf'), /Air_Rifle_Accident\.wav"/);
});

test('a text without a recording gets its .flextext and .session, no EAF (nothing to align to), and reports hasAudio false', async () => {
  const handle = project();
  const { a, R } = mk({ researcher: { texts: { 'doc-2': driveText('doc-2', { audio: false }) },
    poll: () => ({ desired_rev: 1, settings: {}, commands: [cmd(1, 'assign', { id: 'doc-2', title: 'Text only' })] }) } });
  await linkIt(a, handle); await a.tick('inst-1');
  const dir = at(handle, 'Sessions/Text_only');
  assert.deepEqual(names(dir), ['Text_only.flextext', 'Text_only.flextext.meta', 'Text_only.session', 'flextext']);
  assert.match(await textOf(dir, 'Text_only.flextext'), /location="C:\\x\\story\.m4a"/, 'no recording here: the reference is left as it came');
  const inv = JSON.parse(R.calls.filter((c) => /\/report$/.test(c[1])).pop()[4].body.reported.slice(4));
  assert.equal(inv.items[0].hasAudio, false);
});

test('the id steps aside from a folder that holds a DIFFERENT text (or no text); case does not matter', async () => {
  const handle = project({ air_rifle_accident: fakeDir('air_rifle_accident', { 'air_rifle_accident.session': fakeFile('air_rifle_accident.session', '<Session/>') }) });
  const { a } = mk({ researcher: { texts: { 'doc-1': driveText('doc-1') },
    poll: () => ({ desired_rev: 1, settings: {}, commands: [cmd(1, 'assign', { id: 'doc-1', title: 'Air Rifle Accident' })] }) } });
  await linkIt(a, handle); await a.tick('inst-1');
  assert.deepEqual(names(at(handle, 'Sessions')), ['Air_Rifle_Accident_2', 'air_rifle_accident']);
  assert.deepEqual(names(at(handle, 'Sessions/air_rifle_accident')), ['air_rifle_accident.session'], 'the stranger\'s folder is untouched');
});

/* A session this agent made earlier, then checked out (M6): its manifest names doc-1, its history says
 * a phone holds it. The agent has the folder under a NON-title name, to prove the id is never re-derived. */
function returnedProject({ recordingBytes = AUDIO } = {}) {
  const history = newHistory({ docId: 'doc-1', sessionId: 'narr_x', holder: { kind: 'device', id: 'phone-1', name: 'Phone' }, kind: 'checked_out', now: 1 });
  const mf = manifestFor('doc-1');
  const sessionXml = '<?xml version="1.0" encoding="utf-8"?>\n<Session minimum_lameta_version_to_read="0.0.0">\n  <id type="string">narr_x</id>\n  <Title type="string">Air Rifle Accident</Title>\n  <Genre type="string">narrative</Genre>\n  <Status type="string">In_Progress</Status>\n  <Contributions></Contributions>\n</Session>\n';
  return project({ narr_x: fakeDir('narr_x', {
    'narr_x.session': fakeFile('narr_x.session', sessionXml),
    'narr_x.flextext': fakeFile('narr_x.flextext', '<old-flextext/>'), 'narr_x.flextext.meta': fakeFile('narr_x.flextext.meta', '<Meta>lameta wrote this</Meta>'),
    'narr_x.eaf': fakeFile('narr_x.eaf', '<old-eaf/>'), 'narr_x.pfsx': fakeFile('narr_x.pfsx', '<old-pfsx/>'),
    'narr_x.m4a': fakeFile('narr_x.m4a', recordingBytes), 'narr_x.m4a.meta': fakeFile('narr_x.m4a.meta', '<Meta/>'),
    'narr_x.converted-NOT-ARCHIVAL.wav': fakeFile('narr_x.converted-NOT-ARCHIVAL.wav', 'old wav'),
    flextext: fakeDir('flextext', { [MANIFEST_NAME]: fakeFile(MANIFEST_NAME, JSON.stringify(mf)), [LAMETA_HISTORY_NAME]: fakeFile(LAMETA_HISTORY_NAME, JSON.stringify(history)) }),
  }) });
}

test('a return trip refreshes the session in place: annotation set replaced, old .flextext backed up outside, recording and .session and .meta untouched, stages queued', async () => {
  const handle = returnedProject();
  const { a, F, R } = mk({ researcher: { texts: { 'doc-1': driveText('doc-1') },
    poll: () => ({ desired_rev: 2, settings: {}, commands: [cmd(1, 'assign', { id: 'doc-1', title: 'Air Rifle Accident (retitled)' })] }) } });
  await linkIt(a, handle); await a.tick('inst-1');
  assert.deepEqual(names(at(handle, 'Sessions')), ['narr_x'], 'the existing folder, never renamed, no second folder for the new title');
  const dir = at(handle, 'Sessions/narr_x');
  assert.deepEqual(names(dir), ['flextext', 'narr_x.converted-NOT-ARCHIVAL.wav', 'narr_x.eaf', 'narr_x.flextext', 'narr_x.flextext.meta', 'narr_x.m4a', 'narr_x.m4a.meta', 'narr_x.pfsx', 'narr_x.session'],
    'no new files: the eaf/pfsx keep the name the folder id gives them, and no sidecar is added beside a file that already existed');
  assert.match(await textOf(dir, 'narr_x.flextext'), /location="narr_x\.converted-NOT-ARCHIVAL\.wav"/, 'replaced');
  assert.match(await textOf(dir, 'narr_x.eaf'), /<ANNOTATION_DOCUMENT/, 'replaced'); assert.doesNotMatch(await textOf(dir, 'narr_x.pfsx'), /old-pfsx/, 'replaced');
  assert.notEqual(await textOf(dir, 'narr_x.converted-NOT-ARCHIVAL.wav'), 'old wav', 'our derived copy is ours to replace');
  assert.equal(at(dir, 'narr_x.session').writes, 0, 'the .session is never rewritten live');
  assert.equal(await textOf(dir, 'narr_x.flextext.meta'), '<Meta>lameta wrote this</Meta>', 'an existing sidecar is lameta\'s');
  assert.equal(at(dir, 'narr_x.m4a').writes, 0, 'same bytes: the recording is not touched');
  assert.equal(at(dir, 'narr_x.m4a.meta').writes, 0);
  // The previous .flextext is in the dated backup folder at the PROJECT root, not inside the session.
  assert.deepEqual(names(handle), ['Fayu.sprj', 'Sessions', BACKUP_DIR]);
  assert.equal(await textOf(handle, `${BACKUP_DIR}/2026-10-10/narr_x.flextext`), '<old-flextext/>');
  // The history grew a `returned` event and custody came back here; the manifest copy is immutable.
  const h = JSON.parse(await textOf(dir, `flextext/${LAMETA_HISTORY_NAME}`));
  assert.equal(h.events.length, 2); assert.equal(h.events[1].kind, 'returned');
  assert.deepEqual(h.events[1].from, { kind: 'device', id: 'phone-1', name: 'Phone' }); assert.equal(h.custody.holder.kind, 'lameta');
  assert.match(h.events[1].notes[0], /^backup:lameta-agent-backups\/2026-10-10\/narr_x\.flextext$/);
  assert.equal(at(dir, `flextext/${MANIFEST_NAME}`).writes, 0);
  // The stage facts the return brought wait in the queue; the ack went out.
  const L = (await rec(F)).link;
  assert.equal(L.ackSeq, 1);
  assert.equal(L.pendingLameta.length, 1);
  assert.equal(L.pendingLameta[0].kind, 'stages'); assert.equal(L.pendingLameta[0].sessionId, 'narr_x'); assert.equal(L.pendingLameta[0].stages.Stage_Transcribe, 'done');
  assert.deepEqual(a.status('inst-1').pendingLameta, [{ sessionId: 'narr_x', kind: 'stages', at: Date.UTC(2026, 9, 10, 12, 0, 0) }]);
  assert.equal(a.status('inst-1').lastAssign.returning, true);
  const inv = JSON.parse(R.calls.filter((c) => /\/report$/.test(c[1])).pop()[4].body.reported.slice(4));
  assert.deepEqual(inv.items.map((i) => i.id), ['doc-1'], 'the text is listed here again');
});

test('a returned recording with DIFFERENT bytes is written beside the original as a dated twin; the original is never overwritten', async () => {
  const handle = returnedProject({ recordingBytes: new Blob([new Uint8Array([9, 9, 9])]) });
  const { a } = mk({ researcher: { texts: { 'doc-1': driveText('doc-1') },
    poll: () => ({ desired_rev: 2, settings: {}, commands: [cmd(1, 'assign', { id: 'doc-1', title: 'Air Rifle Accident' })] }) } });
  await linkIt(a, handle); await a.tick('inst-1');
  const dir = at(handle, 'Sessions/narr_x');
  assert.deepEqual([...await bytesOf(dir, 'narr_x.m4a')], [9, 9, 9], 'untouched');
  assert.ok(names(dir).includes('narr_x.returned-2026-10-10.m4a') && names(dir).includes('narr_x.returned-2026-10-10.m4a.meta'));
  assert.deepEqual([...await bytesOf(dir, 'narr_x.returned-2026-10-10.m4a')], [...new Uint8Array(await AUDIO.arrayBuffer())]);
  const h = JSON.parse(await textOf(dir, `flextext/${LAMETA_HISTORY_NAME}`));
  assert.ok(h.events[1].notes.includes('recording_differs:narr_x.returned-2026-10-10.m4a'), 'reported');
});

test('a second return trip in a day keeps the first backup (a time-stamped name) and replaces the queued stages, never lowering them', async () => {
  const handle = returnedProject();
  let ticks = 0;
  const { a, F } = mk({ researcher: { texts: { 'doc-1': driveText('doc-1') },
    poll: () => ({ desired_rev: ++ticks, settings: {}, commands: [cmd(ticks, 'assign', { id: 'doc-1', title: 'Air Rifle Accident' })] }) } });
  await linkIt(a, handle); await a.tick('inst-1'); await a.tick('inst-1');
  const backups = names(at(handle, `${BACKUP_DIR}/2026-10-10`));
  assert.equal(backups.length, 2, backups.join(',')); assert.ok(backups.includes('narr_x.flextext'));
  assert.equal((await rec(F)).link.pendingLameta.length, 1, 'one queued update per session and kind');
  assert.deepEqual(queueLametaUpdate([{ kind: 'stages', sessionId: 'x', stages: { Stage_Segment: 'done' }, done: true }],
                                     { kind: 'stages', sessionId: 'x', stages: { Stage_Segment: 'in_progress', Stage_Transcribe: 'done' }, done: false }),
    [{ kind: 'stages', sessionId: 'x', stages: { Stage_Segment: 'done', Stage_Transcribe: 'done' }, done: true }], 'monotonic');
});

test('a failed assign is NOT acked: held with its error on the card, nothing half-written; Retry runs it again, Skip acks it untouched', async () => {
  const handle = project();
  const texts = {};
  let polls = 0;
  const { a, F, R } = mk({ researcher: { texts, poll: () => { polls++; return { desired_rev: 9, settings: {}, commands: [
    cmd(1, 'assign', { id: 'doc-1', title: 'Air Rifle Accident' }), cmd(2, 'changeSettings', { settings: { x: 1 } })] }; } } });
  await linkIt(a, handle);
  await a.tick('inst-1');                                                   // the text's folder does not list yet
  let L = (await rec(F)).link;
  assert.equal(L.ackSeq, 0); assert.equal(L.desiredRev, -1, 'nothing acked, the lane re-read next tick');
  let s = a.status('inst-1');
  assert.deepEqual(s.heldFail, { seq: 1, type: 'assign', error: 'no_such_text', at: Date.UTC(2026, 9, 10, 12, 0, 0) });
  assert.deepEqual(s.waiting, [{ seq: 1, type: 'assign', error: 'no_such_text' }, { seq: 2, type: 'changeSettings' }]);
  assert.deepEqual(names(at(handle, 'Sessions')), [], 'no folder was made');
  assert.equal(L.settings.x, undefined, 'the command behind it waits too');
  // The next tick does not hammer the worker with the same download: the failure is fresh.
  const lists = () => R.calls.filter((c) => c[0] === 'listTextFiles').length;
  const before = lists(); await a.tick('inst-1'); assert.equal(lists(), before, 'not retried within HELD_RETRY_MS');
  assert.ok(HELD_RETRY_MS >= 60000);
  // Retry, from the card — still failing: the error stays. Then the text appears and Retry succeeds.
  assert.equal(a.retryHeld('inst-1', 1), true); await new Promise((r) => setTimeout(r, 10));
  assert.equal(lists(), before + 1); assert.equal(a.status('inst-1').heldFail.seq, 1);
  texts['doc-1'] = driveText('doc-1');
  a.retryHeld('inst-1'); await new Promise((r) => setTimeout(r, 20));
  L = (await rec(F)).link; s = a.status('inst-1');
  assert.equal(L.ackSeq, 2, 'acked through the settings behind it'); assert.equal(L.desiredRev, 9); assert.equal(L.settings.x, 1);
  assert.equal(s.heldFail, null); assert.deepEqual(s.waiting, []);
  assert.deepEqual(names(at(handle, 'Sessions')), ['Air_Rifle_Accident']);
  assert.equal(a.retryHeld('inst-1'), false, 'nothing held');
});

test('Skip acks a failed command without touching the folder', async () => {
  const handle = project();
  const { a, F } = mk({ researcher: { texts: {}, poll: () => ({ desired_rev: 3, settings: {}, commands: [cmd(1, 'assign', { id: 'doc-9', title: 'Gone' })] }) } });
  await linkIt(a, handle); await a.tick('inst-1');
  assert.equal(a.status('inst-1').heldFail.seq, 1);
  assert.equal(a.skipHeld('inst-1', 1), true); await new Promise((r) => setTimeout(r, 10));
  const L = (await rec(F)).link;
  assert.equal(L.ackSeq, 1); assert.equal(L.desiredRev, 3); assert.equal(a.status('inst-1').heldFail, null);
  assert.deepEqual(names(at(handle, 'Sessions')), []);
});

test('without the folder (permission lapsed) or without the injected parser / converter, assign holds rather than guessing', async () => {
  const handle = project();
  const t = { texts: { 'doc-1': driveText('doc-1') }, poll: () => ({ desired_rev: 1, settings: {}, commands: [cmd(1, 'assign', { id: 'doc-1', title: 'A' })] }) };
  const perm = mk({ researcher: t }); perm.F.permission = 'prompt';
  await linkIt(perm.a, handle); await perm.a.tick('inst-1');
  assert.equal(perm.a.status('inst-1').heldFail.error, 'folder_unavailable');
  const noParse = mk({ researcher: t, parseFlextext: null });
  await linkIt(noParse.a, project()); await noParse.a.tick('inst-1');
  assert.equal(noParse.a.status('inst-1').heldFail.error, 'no_parser');
  const noConv = mk({ researcher: t, convertWav: null });
  await linkIt(noConv.a, project()); await noConv.a.tick('inst-1');
  assert.equal(noConv.a.status('inst-1').heldFail.error, 'no_converter');
  assert.deepEqual(names(at(handle, 'Sessions')), []);
});

/* ─── the open marker ─── */
test('openMarkerState: fresh within two minutes of the heartbeat, stale after, absent without one or when unparseable', () => {
  const now = Date.UTC(2026, 9, 9, 20, 5, 30);
  const hb = (ms) => ({ app: 'FlexText Metadata', version: '1', pid: 1, since: '2026-10-09T20:00:00Z', heartbeat: new Date(now - ms).toISOString() });
  assert.equal(openMarkerState(hb(0), now), 'fresh');
  assert.equal(openMarkerState(hb(30 * 1000), now), 'fresh');
  assert.equal(openMarkerState(hb(OPEN_MARKER_STALE_MS), now), 'fresh', 'exactly two minutes is still fresh');
  assert.equal(openMarkerState(hb(OPEN_MARKER_STALE_MS + 1), now), 'stale');
  assert.equal(openMarkerState(hb(3 * 60 * 60 * 1000), now), 'stale', 'a crash\'s leftover');
  assert.equal(openMarkerState(null, now), 'absent'); assert.equal(openMarkerState({ app: 'x' }, now), 'absent');
  assert.equal(openMarkerState({ heartbeat: 'yesterday' }, now), 'absent');
  assert.equal(openMarkerState('{"heartbeat":"x"}', now), 'absent', 'a string is not a marker');
  assert.equal(OPEN_MARKER_NAME, '.flextext-open.json'); assert.equal(OPEN_MARKER_STALE_MS, 120000);
});

test('readOpenMarker goes through the seam with a timeout: a placeholder that never answers is absent, not a hang', async () => {
  const F = fakeFiles();
  const now = Date.UTC(2026, 9, 9, 20, 5, 30);
  const fresh = fakeDir('P', { [OPEN_MARKER_NAME]: fakeFile(OPEN_MARKER_NAME, JSON.stringify({ app: 'FlexText Metadata', heartbeat: new Date(now - 1000).toISOString() })) });
  assert.deepEqual(await readOpenMarker(F, fresh, { now }), { state: 'fresh', marker: { app: 'FlexText Metadata', heartbeat: new Date(now - 1000).toISOString() },
    app: 'FlexText Metadata', heartbeat: new Date(now - 1000).toISOString(), timeout: false, at: now });
  assert.equal((await readOpenMarker(F, fakeDir('P', {}), { now })).state, 'absent');
  assert.equal((await readOpenMarker(F, fakeDir('P', { [OPEN_MARKER_NAME]: fakeFile(OPEN_MARKER_NAME, 'not json') }), { now })).state, 'absent');
  const jammed = fakeDir('P', { [OPEN_MARKER_NAME]: fakeFile(OPEN_MARKER_NAME, '{}', { hang: true }) });
  const t0 = Date.now();
  const r = await readOpenMarker(F, jammed, { now, timeoutMs: 40 });
  assert.ok(Date.now() - t0 < 1000, 'bounded');
  assert.equal(r.state, 'absent'); assert.equal(r.timeout, true);
});

test('the policy: a new session is written at once in every state; a rewrite is queued in every state; the queue may be applied only while the fork is not open', () => {
  for (const st of ['absent', 'stale']) assert.deepEqual(lametaWritePolicy(st), { live: false, createNow: true, rewriteNow: false, applyPending: true }, st);
  assert.deepEqual(lametaWritePolicy('fresh'), { live: true, createNow: true, rewriteNow: false, applyPending: false });
});

test('wired: the agent reads the marker each tick, assign still writes a new folder while the fork is open, and the pending gate closes', async () => {
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);
  const handle = returnedProject();
  handle._entries[OPEN_MARKER_NAME] = fakeFile(OPEN_MARKER_NAME, JSON.stringify({ app: 'FlexText Metadata', heartbeat: new Date(now - 5000).toISOString() }));
  let ticks = 0;
  const texts = { 'doc-1': driveText('doc-1'), 'doc-2': driveText('doc-2') };
  const { a, F } = mk({ now: () => now, researcher: { texts, poll: () => ({ desired_rev: ++ticks, settings: {}, commands: [
    cmd(1, 'assign', { id: 'doc-2', title: 'New one' }), cmd(2, 'assign', { id: 'doc-1', title: 'Air Rifle Accident' })] }) } });
  await linkIt(a, handle); await a.tick('inst-1');
  const s = a.status('inst-1');
  assert.equal(s.openMarker.state, 'fresh'); assert.equal(s.openMarker.app, 'FlexText Metadata');
  assert.deepEqual(names(at(handle, 'Sessions')), ['New_one', 'narr_x'], 'the new folder was written at once: the fork\'s watcher loads it live');
  assert.equal(s.lastAssign.live, true);
  assert.equal(at(handle, 'Sessions/narr_x/narr_x.session').writes, 0, 'the rewrite stayed queued');
  assert.deepEqual(a.pendingGate('inst-1'), { allowed: false, state: 'fresh', app: 'FlexText Metadata', n: 1, live: true }, 'Apply cannot be confirmed about an app that is open');
  assert.equal((await rec(F)).link.ackSeq, 2);
  // The fork closes (marker gone) — or crashes (marker stale): the gate opens, today's behaviour.
  delete handle._entries[OPEN_MARKER_NAME];
  await a.tick('inst-1');
  assert.deepEqual(a.pendingGate('inst-1'), { allowed: true, state: 'absent', app: '', n: 1, live: false });
  handle._entries[OPEN_MARKER_NAME] = fakeFile(OPEN_MARKER_NAME, JSON.stringify({ app: 'FlexText Metadata', heartbeat: new Date(now - 10 * 60 * 1000).toISOString() }));
  await a.tick('inst-1');
  assert.equal(a.pendingGate('inst-1').state, 'stale'); assert.equal(a.pendingGate('inst-1').allowed, true);
});

test('a marker that cannot be read in time never stalls the tick', async () => {
  const handle = project();
  handle._entries[OPEN_MARKER_NAME] = fakeFile(OPEN_MARKER_NAME, '{}', { hang: true });
  const { a } = mk({ researcher: { texts: {}, poll: () => ({}) } });
  await linkIt(a, handle);
  const t0 = Date.now(); await a.tick('inst-1');
  assert.ok(Date.now() - t0 < 10000, 'bounded by the marker timeout, not forever');
  assert.equal(a.status('inst-1').openMarker.state, 'absent'); assert.equal(a.status('inst-1').openMarker.timeout, true);
});
