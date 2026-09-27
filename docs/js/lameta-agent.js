/* lameta-agent.js — a lameta project's Sessions/ folder as a DEVICE, run from inside the Researcher
 * Panel (plans/lameta-device.md). Seth, 2026-09-27: "the sessions folder becomes basically a
 * 'device' into which FLExText Editor texts can be moved in or out."
 *
 * WHY THE AGENT IS AN INSTALL. Every route a device uses already exists, and the panel already
 * holds every instance key — but the REPORT route authenticates an install, so the only way for the
 * panel to appear as a device is to be one: it creates an ordinary instance, mints an invite for it,
 * claims that invite itself with a client-minted install identity, accepts, approves, and from then
 * on polls and reports with install headers (researcher.js apiAsInstall). No worker change, no
 * schema change: `instance.type` keeps its CHECK constraint, and `inventory.type: 'lameta'` is what
 * drives the panel's badge.
 *
 * WHAT IS DELIBERATELY NOT COPIED FROM sync.js. The device module is a set of module singletons
 * around ONE session record, erases the whole device on a wipe, and is precached in every offline
 * shell. The agent keeps its records in files.js's store (one per link, beside the folder handle
 * they belong to), never erases anything, and is reached only by import() from the panel — so
 * nothing here enters a shell. The four small pieces it needs (a token, a uuid, a hash, the
 * seq-filter/ack loop with its backoff) are re-stated here rather than exported from sync.js,
 * which would make the panel import the device module.
 *
 * ⚠ THE ACK RULE DIFFERS FROM A PHONE'S, DELIBERATELY. A phone acks a command it could not carry out
 * and moves on, because nobody is watching it. Here somebody is: a command this version cannot
 * carry out (assign, uploadDelete, triggerUpload, setDone — the milestones after this one) is HELD,
 * not acked; the ack cursor stops before it, the desired lane is re-read each tick so it keeps
 * appearing, and the card says how many are waiting. `changeSettings` is applied and acked;
 * `delete` is refused and acked (a lameta session is never deleted by the suite); a wipe or a 410
 * unlinks — forgets the record — and touches no file. ⚠ Nothing in this module can delete a file:
 * the seam exposes no such call, and test/lameta-agent-isolation.test.mjs pins that.
 *
 * ⚠ ONLY PURE MODULES ARE IMPORTED (lameta.js for the session format and the pickers,
 * seg-exports.js for the manifest builder — both already loaded by the panel, both node-clean).
 * Everything with a platform behind it (researcher.js as `R`, files.js as `F`, the engine version,
 * the clock) is INJECTED by createLametaAgent, which is what lets the whole loop run under node
 * against fakes in test/lameta-agent-dispatch.test.mjs. The panel injects the real ones.
 */
import { parseLametaSession, pickPrimaryRecording, pickFlextext, audioMimeOf, newHistory, historyCustody,
         LAMETA_HISTORY_NAME, LAMETA_SUITE_DIR } from './lameta.js';
import { buildSourceManifest, MANIFEST_NAME } from './seg-exports.js';

export const INDEX_KEY = (acct) => `${acct || 'anon'}:lameta-index`;
export const LINK_KEY = (acct, instanceId) => `${acct || 'anon'}:lameta:${instanceId}`;
export const POLL_FG_MS = 20000;
export const POLL_HIDDEN_MS = 60000;
export const MAX_BACKOFF_STEPS = 5;
export const SHA_MAX_BYTES = 256 * 1024 * 1024;
/* What this version can carry out. Everything else is held (see the header). */
export const HANDLED = ['changeSettings', 'delete'];
export const HELD = ['assign', 'uploadDelete', 'triggerUpload', 'setDone'];

const enc = (s) => encodeURIComponent(String(s));
const cryptoOf = () => (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
export function randTok(n = 24) {
  const b = new Uint8Array(n); cryptoOf().getRandomValues(b);
  let s = ''; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function uuid() {
  const c = cryptoOf();
  return (c && c.randomUUID && c.randomUUID()) || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = c.getRandomValues(new Uint8Array(1))[0] % 16; return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function sha256hex(str) {
  return hex(await cryptoOf().subtle.digest('SHA-256', new TextEncoder().encode(String(str))));
}
/* Full SHA-256 of a blob for the manifest (schema 3), '' above SHA_MAX_BYTES: a sampled hash is not
 * integrity, and Drive lists its own checksum for anything larger once it is there. On a computer,
 * off any button — Adopt runs in the upload queue. */
export async function sha256OfBlob(blob) {
  if (!blob || typeof blob.arrayBuffer !== 'function' || blob.size > SHA_MAX_BYTES) return '';
  try { return hex(await cryptoOf().subtle.digest('SHA-256', await blob.arrayBuffer())); } catch { return ''; }
}

/* The inventory a lameta device reports — syncGatherInventory's shape (docs/js/app.js), so every
 * panel that renders a device renders this one. `type: 'lameta'` is the badge; `platform: 'lameta'`
 * the device-info line; `engineVersion` the current engine, which makes the device a legal move
 * destination. `items` are the texts in custody HERE: sessions whose history names this instance as
 * the holder — a session with a manifest but another holder is a text that lives elsewhere. Pure. */
export function buildInventory(link, scan = {}, { engineVersion = '', ua = '' } = {}) {
  const mine = (scan.sessions || []).filter((e) => e && e.docId && e.custody && e.custody.kind === 'lameta' && e.custody.id === (link && link.instanceId));
  return {
    type: 'lameta', platform: 'lameta', engineVersion, ua,
    items: mine.map((e) => ({
      id: e.docId, title: e.title || e.name, hasAudio: !!(e.manifest && e.manifest.audio), modified: e.modified || 0,
      done: !!e.done, pendingDelete: false, uploadState: 'uploaded', uploadedFileId: e.manifestFileId || null,
      lameta: { sessionId: e.name },
    })),
    settings: (link && link.settings) || {},
    lameta: {
      projectName: (link && link.projectName) || '',
      folder: (link && link.folderName) || '',
      sessions: Array.isArray(scan.sessions) ? scan.sessions.length : (typeof scan.sessionCount === 'number' ? scan.sessionCount : null),
      available: scan.available !== false,
    },
  };
}

/* What a folder has to be to count as a lameta project: a `.sprj` at its root and a `Sessions/`
 * directory. Names only — nothing is read. */
export async function inspectProject(F, handle, { timeoutMs } = {}) {
  const root = await F.listDir(handle, { timeoutMs });
  const sprj = root.find((e) => e.kind === 'file' && /\.sprj$/i.test(e.name));
  const sessionsDir = await F.getDir(handle, 'Sessions');
  if (!sprj || !sessionsDir) return { ok: false, reason: 'not-project', projectName: '', sprjName: '', sessions: [] };
  const sessions = (await F.listDir(sessionsDir, { timeoutMs })).filter((e) => e.kind === 'directory').map((e) => e.name);
  return { ok: true, projectName: sprj.name.replace(/\.sprj$/i, ''), sprjName: sprj.name, sessions };
}

export function createLametaAgent({ R, F, engineVersion = '', ua = '', onChange = () => {}, log = console,
                                    now = () => Date.now(), timers = globalThis, visible = () => true } = {}) {
  if (!R || !F) throw new Error('lameta agent needs R (researcher.js) and F (files.js)');
  const acct = () => R.currentAccountId() || 'anon';
  /* Per-instance live state: what the card shows, never persisted. `cache` is the sessions read so
   * far, by folder name; `sessions` the current listing resolved through it. */
  const live = new Map();
  const st = (id) => {
    if (!live.has(id)) live.set(id, { inFlight: false, failStreak: 0, lastTickAt: 0, lastError: '', waiting: [], permission: 'unknown',
                                      scan: {}, sessions: null, cache: new Map(), linked: true, folderName: '', projectName: '' });
    return live.get(id);
  };
  let timer = null, started = false;

  /* ─── records ─── */
  async function loadIndex() { const ix = await F.stashGet(INDEX_KEY(acct())); return (ix && Array.isArray(ix.ids)) ? ix.ids.slice() : []; }
  async function saveIndex(ids) { return F.stashPut(INDEX_KEY(acct()), { ids: [...new Set(ids)] }); }
  async function load(instanceId) { return F.recallFolder(LINK_KEY(acct(), instanceId)); }
  async function save(rec) { return F.rememberFolder(LINK_KEY(acct(), rec.link.instanceId), rec.handle, { link: rec.link }); }
  async function forget(instanceId) {
    await F.forgetFolder(LINK_KEY(acct(), instanceId));
    await saveIndex((await loadIndex()).filter((x) => x !== instanceId));
    const s = st(instanceId); s.linked = false; s.waiting = []; s.sessions = null;
    onChange(instanceId);
  }
  async function links() {
    const out = [];
    for (const id of await loadIndex()) { const rec = await load(id); if (rec && rec.link) out.push(rec.link); }
    return out;
  }
  /* Is THIS folder already linked (by handle identity)? The answer that stops a second device
   * being made for one project from the same browser. */
  async function linkedFor(handle) {
    for (const id of await loadIndex()) {
      const rec = await load(id);
      if (rec && rec.handle && await F.sameEntry(rec.handle, handle)) return rec.link;
    }
    return null;
  }
  async function sessionDir(rec, name) {
    const sessions = await F.getDir(rec.handle, 'Sessions');
    return sessions ? F.getDir(sessions, name) : null;
  }

  /* ─── link: create → invite → claim (as the install) → accept → approve ─── */
  async function link({ handle, nickname, projectName = '', sprjName = '', projectFolderId = '' }) {
    if (!handle || !nickname) throw new Error('link needs a folder and a name');
    const already = await linkedFor(handle);
    if (already) { const e = new Error('already_linked'); e.link = already; throw e; }
    const inst = await R.createInstance(nickname, projectFolderId || undefined);
    const invite = await R.mintInvite(inst.instance_id);
    const L = { instanceId: inst.instance_id, installId: uuid(), installSecret: randTok(24), nickname,
                projectName, sprjName, folderName: handle.name || '', ackSeq: 0, desiredRev: -1, settings: {},
                linkedAt: now(), status: 'claiming', lastReportHash: '' };
    // Persisted BEFORE the first POST (the device's rule, sync.js): a lost response loses nothing.
    await save({ handle, link: L });
    await saveIndex([...(await loadIndex()), L.instanceId]);
    await R.apiAsInstall('POST', `/v1/invites/${enc(invite.invite_id)}/claim`, L,
      { headers: { 'x-fx-invite-secret': invite.secret }, body: { install_id: L.installId, install_secret: L.installSecret } });
    await R.apiAsInstall('POST', `/v1/instances/${enc(L.instanceId)}/installs/${enc(L.installId)}/accept`, L, { body: {} });
    // No pubkey: approve-only. Ki stays in researcher.js; the agent seals and opens through it.
    await R.approveInstall(L.instanceId, L.installId, null);
    L.status = 'linked';
    await save({ handle, link: L });
    st(L.instanceId).linked = true;
    onChange(L.instanceId);
    if (started) tick(L.instanceId).catch(() => {});
    return { instanceId: L.instanceId, installId: L.installId };
  }

  /* Unlink: revoke the install on the worker (the panel's own Unlink route), forget the record.
   * The instance row stays — Delete device removes it, exactly as for a phone. No file is touched. */
  async function unlink(instanceId, { revoke = true } = {}) {
    const rec = await load(instanceId);
    if (rec && revoke) { try { await R.revokeInstall(instanceId, rec.link.installId); } catch (e) { log.warn('[lameta] revoke on unlink failed:', e); } }
    await forget(instanceId);
  }

  /* ─── the folder, each tick: permission first, then the sessions ───
   * Names each tick; a session's files (the manifest copy, the history, the .session's Status) are
   * read ONCE and cached by name, re-read only when the name is new — 200 sessions must not mean
   * 600 reads every twenty seconds. Adopt refreshes its own entry. */
  async function readSession(rec, name) {
    const entry = { name, docId: '', title: '', custody: null, manifest: null, history: null, done: false, modified: 0, manifestFileId: '', available: true };
    try {
      const dir = await sessionDir(rec, name);
      const suite = dir && await F.getDir(dir, LAMETA_SUITE_DIR);
      if (suite) {
        const mtext = await F.readFile(suite, MANIFEST_NAME, { as: 'text', timeoutMs: 8000 });
        if (mtext) { try { entry.manifest = JSON.parse(mtext); entry.docId = String(entry.manifest.docId || ''); entry.title = String(entry.manifest.title || ''); } catch { /* not ours */ } }
        const htext = await F.readFile(suite, LAMETA_HISTORY_NAME, { as: 'text', timeoutMs: 8000 });
        if (htext) {
          try { entry.history = JSON.parse(htext); entry.custody = historyCustody(entry.history); entry.modified = Date.parse(entry.history.custody && entry.history.custody.since) || 0; entry.manifestFileId = String(entry.history.manifestFileId || ''); }
          catch { /* not ours */ }
        }
      }
      if (dir && entry.docId) {
        const xml = await F.readFile(dir, `${name}.session`, { as: 'text', timeoutMs: 8000 }).catch(() => '');
        if (xml) entry.done = parseLametaSession(xml).done;
      }
    } catch (e) { entry.available = false; entry.timeout = !!(e && e.code === 'FILES_TIMEOUT'); }
    return entry;
  }
  async function scanSessions(rec, s) {
    const sessions = await F.getDir(rec.handle, 'Sessions');
    if (!sessions) { s.sessions = []; return; }
    const names = (await F.listDir(sessions, { timeoutMs: 8000 })).filter((e) => e.kind === 'directory').map((e) => e.name);
    for (const n of [...s.cache.keys()]) if (!names.includes(n)) s.cache.delete(n);
    for (const name of names) if (!s.cache.has(name)) s.cache.set(name, await readSession(rec, name));
    s.sessions = names.map((n) => s.cache.get(n));
  }
  async function scan(rec, s) {
    s.folderName = rec.name || rec.link.folderName || ''; s.projectName = rec.link.projectName || '';
    s.permission = await F.permissionState(rec.handle);
    if (s.permission !== 'granted') { s.scan = { available: false }; return s.scan; }
    try {
      await scanSessions(rec, s);
      s.scan = { sessions: s.sessions, available: true };
    } catch (e) { s.scan = { available: false, timeout: e && e.code === 'FILES_TIMEOUT', sessions: s.sessions }; }
    return s.scan;
  }
  async function requestPermission(instanceId) {
    const rec = await load(instanceId);
    if (!rec) return false;
    const ok = await F.requestFolderPermission(rec.handle);
    st(instanceId).permission = ok ? 'granted' : 'denied';
    onChange(instanceId);
    if (ok) tick(instanceId).catch(() => {});
    return ok;
  }

  /* ─── Adopt (plans/lameta-device.md §6): an existing session becomes a text of this device ───
   * prepareAdopt reads what is there and what has to be chosen; beginAdopt mints the docId, reads
   * the bytes and builds the manifest — the panel then uploads through its own assign-upload queue
   * (resumable, pausable) and calls finishAdopt when the bytes are on Drive, which is when the
   * session gets its flextext/ subfolder. Written LAST, so a cancelled adopt leaves no half-claimed
   * session. Root files are read, never renamed, never rewritten. */
  async function prepareAdopt(instanceId, sessionName) {
    const rec = await load(instanceId);
    if (!rec) throw new Error('not_linked');
    const dir = await sessionDir(rec, sessionName);
    if (!dir) throw new Error('no_session');
    const s = st(instanceId);
    const known = s.cache.get(sessionName) || await readSession(rec, sessionName);
    if (known.docId) { const e = new Error('already_adopted'); e.docId = known.docId; throw e; }
    const files = [];
    for (const e of (await F.listDir(dir, { timeoutMs: 8000 })).filter((x) => x.kind === 'file' && !/\.meta$/i.test(x.name))) {
      const stt = await F.statFile(dir, e.name, { timeoutMs: 8000 });
      files.push({ name: e.name, size: stt ? stt.size : 0, available: !!(stt && stt.available) });
    }
    const xml = await F.readFile(dir, `${sessionName}.session`, { as: 'text', timeoutMs: 8000 }).catch(() => '');
    const meta = parseLametaSession(xml || '');
    const eaf = files.find((f) => /\.eaf$/i.test(f.name));
    return { sessionName, title: meta.title || sessionName, done: meta.done, contributors: meta.contributors, files,
             recording: pickPrimaryRecording(files), flextext: pickFlextext(files), eaf: eaf ? eaf.name : '',
             unavailable: files.filter((f) => !f.available).map((f) => f.name) };
  }
  async function beginAdopt(instanceId, sessionName, { title = '', recording = null, flextext = null, done = false } = {}) {
    const rec = await load(instanceId);
    if (!rec) throw new Error('not_linked');
    const dir = await sessionDir(rec, sessionName);
    if (!dir) throw new Error('no_session');
    const L = rec.link;
    const docId = uuid();
    const audioBlob = recording ? await F.readFile(dir, recording, { as: 'blob', timeoutMs: 30000 }) : null;
    const ftText = flextext ? await F.readFile(dir, flextext, { as: 'text', timeoutMs: 30000 }) : '';
    if (recording && !audioBlob) throw new Error('recording_unreadable');
    if (flextext && !ftText) throw new Error('flextext_unreadable');
    // The guid as the FILE carries it — never one minted by a parser.
    const flexGuid = ftText ? ((/<interlinear-text\b[^>]*?\bguid="([^"]+)"/.exec(ftText) || [])[1] || '') : '';
    const ftBlob = ftText ? new Blob([ftText], { type: 'application/xml' }) : null;
    const audioSha = audioBlob ? await sha256OfBlob(audioBlob) : '';
    const ftSha = ftBlob ? await sha256OfBlob(ftBlob) : '';
    const withSha = (row, sha) => (sha ? { ...row, sha256: sha } : row);
    const audioMime = audioBlob ? (audioBlob.type || audioMimeOf(recording)) : '';
    const audio = audioBlob ? { name: recording, mime: audioMime, size: audioBlob.size } : null;
    const manifest = buildSourceManifest({
      docId, title: title || sessionName, origin: 'lameta', originatedAt: now(),
      engine: engineVersion, buildTag: '',
      vern: (L.settings && L.settings.vernLang) || '', anal: (L.settings && L.settings.analLang) || '',
      audio: audio ? withSha({ name: audio.name, mime: audio.mime, bytes: audio.size, derived: false }, audioSha) : null,
      files: [
        ...(audio ? [withSha({ name: audio.name, role: 'source-audio', mime: audio.mime, bytes: audio.size }, audioSha)] : []),
        ...(ftBlob ? [withSha({ name: flextext, role: 'source-flextext', mime: 'application/xml', bytes: ftBlob.size }, ftSha)] : []),
      ],
      source: { kind: 'lameta', id: L.instanceId, name: L.projectName || '' },
      flex: flexGuid ? { textGuid: flexGuid } : null,
      lameta: { sessionId: sessionName, projectName: L.projectName || '', projectGuid: '' },
      now: now(),
    });
    return {
      docId, title: title || sessionName, manifest, flexGuid, done: !!done,
      audio: audioBlob ? { blob: audioBlob, name: recording, mime: audioMime, size: audioBlob.size } : null,
      flextext: ftBlob ? { blob: ftBlob, name: flextext, mime: 'application/xml', size: ftBlob.size } : null,
    };
  }
  async function finishAdopt(instanceId, { docId, sessionName, manifest, manifestFileId = '', done = false } = {}) {
    const rec = await load(instanceId);
    if (!rec) throw new Error('not_linked');
    const dir = await sessionDir(rec, sessionName);
    if (!dir) throw new Error('no_session');
    const L = rec.link, s = st(instanceId);
    const suite = await F.ensureDir(dir, LAMETA_SUITE_DIR);
    await F.writeFile(suite, MANIFEST_NAME, JSON.stringify(manifest, null, 2));
    const history = { ...newHistory({ docId, sessionId: sessionName, holder: { kind: 'lameta', id: L.instanceId, name: L.nickname || '' },
                                      by: { kind: 'lameta-agent', id: L.installId }, kind: 'adopted', now: now() }),
                      ...(manifestFileId ? { manifestFileId } : {}) };
    await F.writeFile(suite, LAMETA_HISTORY_NAME, JSON.stringify(history, null, 2));
    s.cache.set(sessionName, { name: sessionName, docId, title: (manifest && manifest.title) || sessionName, custody: history.custody.holder,
                               manifest, history, done: !!done, modified: Date.parse(history.custody.since) || now(), manifestFileId, available: true });
    if (Array.isArray(s.sessions)) s.sessions = s.sessions.map((e) => (e && e.name === sessionName ? s.cache.get(sessionName) : e));
    s.scan = { sessions: s.sessions, available: true };
    onChange(instanceId);
    try { await report(rec, s, true); } catch (e) { log.warn('[lameta] report after adopt failed:', e); }
    return history;
  }

  /* ─── commands ─── */
  async function dispatch(rec, s, cmd) {
    const L = rec.link;
    switch (cmd.type) {
      case 'changeSettings':
        L.settings = { ...(L.settings || {}), ...((cmd.settings && typeof cmd.settings === 'object') ? cmd.settings : {}) };
        return 'ack';
      case 'delete':
        // A lameta session is never deleted by the suite; the person sees the refusal on the card.
        s.lastError = 'delete_refused';
        return 'ack';
      default:
        return HELD.includes(cmd.type) ? 'hold' : 'ack';
    }
  }

  /* ─── one tick: poll → apply → report ─── */
  async function tick(instanceId) {
    const s = st(instanceId);
    if (s.inFlight) return;
    const rec = await load(instanceId);
    if (!rec || !rec.link) { s.linked = false; return; }
    const L = rec.link;
    s.inFlight = true;
    try {
      const r = await R.apiAsInstall('GET', `/v1/instances/${enc(L.instanceId)}?since=${L.desiredRev}`, L, { retry: false });
      s.failStreak = 0; s.lastError = '';
      if (r && r.wipe) {
        // A remote wipe of a lameta device means "forget the link" — the folder is the researcher's own.
        try { await R.apiAsInstall('POST', `/v1/instances/${enc(L.instanceId)}/installs/${enc(L.installId)}/wipe-ack`, L, { body: {}, retry: false }); } catch { /* best effort */ }
        await forget(instanceId);
        return;
      }
      await scan(rec, s);
      if (!r || r.desired_rev === undefined) { await report(rec, s, false); return; }   // 204: nothing new
      if (r.pending) { s.pending = true; await report(rec, s, false); return; }
      s.pending = false;
      const cmds = (r.commands || []).filter((c) => (c.seq || 0) > L.ackSeq).sort((a, b) => a.seq - b.seq);
      let ack = L.ackSeq; const waiting = []; let held = false;
      for (const c of cmds) {
        let cmd = c;
        if (c.enc) {
          try { cmd = Object.assign({ type: c.type, seq: c.seq, id: c.id }, await R.decryptForInstance(L.instanceId, c.enc)); }
          catch (e) { log.warn('[lameta] command decrypt failed', c.seq, e); if (!held) ack = Math.max(ack, c.seq || 0); continue; }
        }
        if (held) { waiting.push({ seq: c.seq, type: c.type }); continue; }   // behind a held one: not ours to ack yet
        const verdict = await dispatch(rec, s, cmd);
        if (verdict === 'hold') { held = true; waiting.push({ seq: c.seq, type: c.type }); continue; }
        ack = Math.max(ack, c.seq || 0);
      }
      L.ackSeq = ack;
      // With something held the lane is re-read every tick (the cursor stays), so it keeps appearing.
      if (!held) L.desiredRev = r.desired_rev;
      s.waiting = waiting;
      await save(rec);
      await report(rec, s, true);
    } catch (e) {
      if (e && e.status === 410) { s.lastError = 'revoked'; await forget(instanceId); return; }
      s.failStreak = Math.min(s.failStreak + 1, MAX_BACKOFF_STEPS);
      s.lastError = (e && e.message) || String(e);
    } finally {
      s.inFlight = false; s.lastTickAt = now();
      onChange(instanceId);
    }
  }

  async function report(rec, s, force) {
    const L = rec.link;
    const inv = buildInventory({ ...L, folderName: rec.name || L.folderName }, s.scan, { engineVersion, ua });
    const hash = await sha256hex(JSON.stringify(inv) + '|' + L.ackSeq);
    if (!force && hash === L.lastReportHash) return;
    let reported;
    try { reported = await R.encryptForInstance(L.instanceId, inv); } catch (e) { s.lastError = 'no_key'; return; }
    await R.apiAsInstall('POST', `/v1/instances/${enc(L.instanceId)}/installs/${enc(L.installId)}/report`, L,
      { body: { reported, ack_seq: L.ackSeq }, retry: false });
    L.lastReportHash = hash;
    await save(rec);
  }

  /* ─── scheduling: every link of this account, adaptive, backing off on failure ─── */
  async function tickAll() {
    for (const id of await loadIndex()) { try { await tick(id); } catch (e) { log.warn('[lameta] tick failed', id, e); } }
  }
  function delay() {
    const base = visible() ? POLL_FG_MS : POLL_HIDDEN_MS;
    const worst = Math.max(0, ...[...live.values()].map((s) => s.failStreak));
    return Math.min(base * Math.pow(2, worst), 5 * 60 * 1000);
  }
  function schedule() { if (timer) timers.clearTimeout(timer); if (!started) return; timer = timers.setTimeout(() => { tickAll().finally(schedule); }, delay()); }
  function start() { if (started) return; started = true; tickAll().finally(schedule); }
  function stop() { started = false; if (timer) timers.clearTimeout(timer); timer = null; }
  function status(instanceId) {
    const s = live.get(instanceId);
    if (!s) return null;
    const { cache, ...rest } = s;
    return { ...rest, waiting: s.waiting.slice(), sessions: Array.isArray(s.sessions) ? s.sessions.slice() : null };
  }

  return { link, unlink, links, linkedFor, tick, tickAll, start, stop, status, requestPermission,
           prepareAdopt, beginAdopt, finishAdopt,
           inspect: (handle, opts) => inspectProject(F, handle, opts), running: () => started };
}
