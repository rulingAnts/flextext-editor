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
 * carry out (uploadDelete, triggerUpload, setDone — the milestones after this one) is HELD, not
 * acked; the ack cursor stops before it, the desired lane is re-read each tick so it keeps
 * appearing, and the card says how many are waiting. A command this version CAN carry out but
 * which FAILED (an `assign` whose fetch or write threw) is held the same way, with its error on the
 * card and a Retry / Skip; it is not retried on its own more often than HELD_RETRY_MS, because a
 * failing download of a 200 MB recording every twenty seconds is not a retry policy.
 * `changeSettings` is applied and acked; `delete` is refused and acked (a lameta session is never
 * deleted by the suite); a wipe or a 410 unlinks — forgets the record — and touches no file.
 * ⚠ Nothing in this module can delete a file: the seam exposes no such call, and
 * test/lameta-agent-isolation.test.mjs pins that.
 *
 * ⚠ ONLY PURE MODULES ARE IMPORTED (lameta.js for the session format, the pickers and the
 * progress fields; seg-exports.js for the manifest builder and the EAF assembler; flextext.js for
 * segmentsFromOffsets — all three already loaded by the panel, all three node-clean to LOAD).
 * Everything with a platform behind it (researcher.js as `R`, files.js as `F`, the engine version,
 * the clock, the Web Audio converter as `convertWav`, and `parseFlextext`, which needs a DOMParser
 * at call time) is INJECTED by createLametaAgent, which is what lets the whole loop run under node
 * against fakes in test/lameta-agent-dispatch.test.mjs and test/lameta-agent-assign.test.mjs. The
 * panel injects the real ones.
 *
 * THE OPEN MARKER (plans/flextext-metadata.md §5). FlexText Metadata — Seth's lameta fork — writes
 * `<project>/.flextext-open.json` while it has the project open and rewrites its heartbeat every
 * 30 s; stock lameta writes nothing. readOpenMarker reads it through the seam with a short timeout
 * (a cloud placeholder must never jam the loop) and answers fresh / stale / absent; a heartbeat
 * older than OPEN_MARKER_STALE_MS is a crash's leftover and counts as absent. lametaWritePolicy
 * turns that into what may be written now: a NEW session folder is written at once in every state
 * (the fork's watcher loads it live; stock lameta lists it on reopen); a REWRITE of an existing
 * .session is queued in every state (record.pendingLameta, plans/lameta-device.md §7); and the
 * queue may be APPLIED only while the marker is not fresh — "Apply — lameta is closed" cannot be
 * confirmed about an app that is demonstrably open.
 */
import { parseLametaSession, pickPrimaryRecording, pickFlextext, audioMimeOf, newHistory, withHistoryEvent, historyCustody,
         lametaSessionIdFor, lametaFlextextMedia, lametaSessionEntries, lametaFileName, deriveStages, mergeStages,
         LAMETA_HISTORY_NAME, LAMETA_SUITE_DIR, LAMETA_ROOT_FILES } from './lameta.js';
import { buildSourceManifest, assembleSegEntries, conversionCaps, mediaNameFor, derivedWavName, MANIFEST_NAME } from './seg-exports.js';
import { segmentsFromOffsets } from './flextext.js';

export const INDEX_KEY = (acct) => `${acct || 'anon'}:lameta-index`;
export const LINK_KEY = (acct, instanceId) => `${acct || 'anon'}:lameta:${instanceId}`;
export const POLL_FG_MS = 20000;
export const POLL_HIDDEN_MS = 60000;
export const MAX_BACKOFF_STEPS = 5;
export const SHA_MAX_BYTES = 256 * 1024 * 1024;
/* What this version can carry out. Everything else is held (see the header). */
export const HANDLED = ['changeSettings', 'delete', 'assign'];
export const HELD = ['uploadDelete', 'triggerUpload', 'setDone'];
/* A command that FAILED is held with its error and retried on its own no sooner than this; Retry on
 * the card runs it at once, Skip acks it untouched. */
export const HELD_RETRY_MS = 5 * 60 * 1000;
/* The backups of a .flextext replaced on a return trip: outside Sessions/ (every directory there is
 * a session to lameta), dated, never pruned. */
export const BACKUP_DIR = 'lameta-agent-backups';

/* ─── the open marker (plans/flextext-metadata.md §5) ─── */
export const OPEN_MARKER_NAME = '.flextext-open.json';
export const OPEN_MARKER_STALE_MS = 2 * 60 * 1000;
export const OPEN_MARKER_TIMEOUT_MS = 3000;
/** Pure: a parsed marker (or null) → 'fresh' | 'stale' | 'absent'. Unparseable or heartbeat-less is absent. */
export function openMarkerState(marker, now = Date.now()) {
  if (!marker || typeof marker !== 'object') return 'absent';
  const hb = Date.parse(marker.heartbeat || marker.since || '');
  if (!Number.isFinite(hb)) return 'absent';
  return (now - hb) > OPEN_MARKER_STALE_MS ? 'stale' : 'fresh';
}
/* Through the seam, bounded: a marker that cannot be read in time (a cloud placeholder, a locked
 * file) is reported as absent with `timeout: true` — the loop never waits on it. */
export async function readOpenMarker(F, handle, { now = Date.now(), timeoutMs = OPEN_MARKER_TIMEOUT_MS } = {}) {
  let text = '', timeout = false;
  try { text = (await F.readFile(handle, OPEN_MARKER_NAME, { as: 'text', timeoutMs })) || ''; }
  catch (e) { timeout = !!(e && e.code === 'FILES_TIMEOUT'); text = ''; }
  let marker = null;
  if (text) { try { marker = JSON.parse(text); } catch { marker = null; } }
  const state = openMarkerState(marker, now);
  return { state, marker: state === 'absent' ? null : marker, app: (marker && String(marker.app || '')) || '',
           heartbeat: (marker && marker.heartbeat) || '', timeout, at: now };
}
/** What may be written NOW, by marker state. Identical for new folders in every state; the
 *  difference is whether the pending queue may be applied (never while the fork is open) and
 *  whether a new session appears live (the fork watches Sessions/; stock lameta reads on reopen). */
export function lametaWritePolicy(state) {
  const live = state === 'fresh';
  return { live, createNow: true, rewriteNow: false, applyPending: !live };
}

/* The text's Drive files by ROLE (the tags Drive carries), the panel's own pickSourceFiles rule:
 * the recording, the .flextext, the manifest, the consent receipt. Pure. */
const SOURCE_AUDIO_ROLES = ['source-audio', 'assigned-audio'];
const SOURCE_FT_ROLES = ['source-flextext', 'assigned-flextext'];
const roleOf = (f) => String((f && f.role) || '');
export function pickTextFiles(files = []) {
  const rows = (files || []).filter(Boolean);
  return {
    audio: rows.find((f) => SOURCE_AUDIO_ROLES.includes(roleOf(f))) || null,
    flextext: rows.find((f) => SOURCE_FT_ROLES.includes(roleOf(f)) || /\.flextext$/i.test(String(f.name || ''))) || null,
    manifest: rows.find((f) => roleOf(f) === 'manifest' || f.name === MANIFEST_NAME) || null,
    receipt: rows.find((f) => roleOf(f) === 'consent-receipt' && /\.json$/i.test(String(f.name || ''))) || null,
  };
}
/* The queue of lameta updates (plans/lameta-device.md §7), one entry per session and kind: a later
 * entry for the same session replaces the earlier, stages merged monotonically so nothing a
 * previous return brought is lowered. Pure; the record is saved by the caller. */
export function queueLametaUpdate(list, upd) {
  const out = (list || []).filter((u) => !(u && u.sessionId === upd.sessionId && u.kind === upd.kind));
  const prev = (list || []).find((u) => u && u.sessionId === upd.sessionId && u.kind === upd.kind);
  const merged = upd.kind === 'stages' && prev ? { ...upd, stages: mergeStages(prev.stages || {}, upd.stages || {}), done: !!(prev.done || upd.done) } : upd;
  return [...out, merged];
}

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
                                    now = () => Date.now(), timers = globalThis, visible = () => true,
                                    convertWav = null, parseFlextext = null, producedBy = () => '' } = {}) {
  if (!R || !F) throw new Error('lameta agent needs R (researcher.js) and F (files.js)');
  const acct = () => R.currentAccountId() || 'anon';
  /* Per-instance live state: what the card shows, never persisted. `cache` is the sessions read so
   * far, by folder name; `sessions` the current listing resolved through it. */
  const live = new Map();
  const st = (id) => {
    if (!live.has(id)) live.set(id, { inFlight: false, failStreak: 0, lastTickAt: 0, lastError: '', waiting: [], permission: 'unknown',
                                      scan: {}, sessions: null, cache: new Map(), linked: true, folderName: '', projectName: '',
                                      openMarker: { state: 'absent' }, heldFail: null, retrySeq: 0, skipSeq: 0, work: null, pendingLameta: [] });
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
    // The fork's open marker, each tick: one small file at the project root, bounded by its own timeout.
    try { s.openMarker = await readOpenMarker(F, rec.handle, { now: now() }); } catch { s.openMarker = { state: 'absent', at: now() }; }
    s.pendingLameta = (rec.link.pendingLameta || []).map((u) => ({ sessionId: u.sessionId, kind: u.kind, at: u.at }));
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

  /* ─── assign (plans/lameta-device.md §10, M5): a text moved in becomes a lameta session ───
   * The panel's Move… re-parents the text's Drive folder to this device and issues `assign`. The
   * command's streaming URLs are a phone's lane; the agent IS the researcher, so it lists the
   * text's folder by role and fetches the manifest, the recording and the .flextext directly.
   * Then exactly what the panel's lameta download builds, written into Sessions/<id>/:
   *   <id>.session (NEW folder only) · <id>.eaf + <id>.pfsx (assembleSegEntries, wants.eaf) ·
   *   the recording under its title name · the derived WAV when the recording is not WAV ·
   *   <id>.flextext with its media reference repointed · a .meta beside each file WE created ·
   *   flextext/flextext-manifest.json (the Drive bytes, immutable) + flextext-history.json.
   * HOW-TO-OPEN.txt never enters a project (LAMETA_ROOT_FILES); nothing is written directly
   * under Sessions/.
   *
   * A RETURN TRIP — a session whose manifest already carries this docId — is refreshed, never
   * renamed: .flextext/.eaf/.pfsx replaced in place, the previous .flextext saved to
   * <project>/lameta-agent-backups/<date>/ first; the recording is never overwritten (a returned
   * recording with a different hash is written beside it as <name>.returned-<date>.<ext>); the
   * .session and existing .meta files are untouched, and the stage facts the return brings are
   * QUEUED (pendingLameta, the §7 rule) for the apply that waits until lameta is closed.
   *
   * ⚠ ACK ONLY AFTER EVERY FILE IS WRITTEN: a throw anywhere leaves the command held with its
   * error on the card. Writes are ordered so a failure part-way leaves a folder that is at worst
   * incomplete, never a session claiming a text it does not hold: the history file — what makes
   * the session a text of this device — is written LAST. */
  const dateStamp = (ms) => new Date(ms).toISOString().slice(0, 10);
  const stemExt = (name) => { const m = /^(.*?)(\.[A-Za-z0-9]+)?$/.exec(String(name || '')); return { stem: m[1] || String(name || ''), ext: m[2] || '' }; };
  const fetchAs = async (f, as, label, s, instanceId) => {
    if (!f || !f.id) return null;
    s.work = { ...(s.work || {}), step: 'fetch', name: f.name || label, pct: null };
    onChange(instanceId);
    const blob = await R.fetchDriveFile(f.id, f.size ? (got) => { s.work = { ...(s.work || {}), pct: Math.min(99, Math.round((got / f.size) * 100)) }; onChange(instanceId); } : undefined);
    if (!blob) throw new Error(`${label}_unreadable`);
    return as === 'text' ? blob.text() : blob;
  };
  async function assignMaterialize(rec, s, cmd) {
    const L = rec.link;
    const docId = String(cmd.id || cmd.docId || '');
    if (!docId) throw new Error('assign_no_id');
    if (typeof parseFlextext !== 'function') throw new Error('no_parser');
    if (s.permission !== 'granted' || !Array.isArray(s.sessions)) throw new Error('folder_unavailable');
    const sessionsDir = await F.getDir(rec.handle, 'Sessions');
    if (!sessionsDir) throw new Error('folder_unavailable');
    s.work = { seq: cmd.seq, type: 'assign', docId, title: cmd.title || '', step: 'list', pct: null };
    onChange(L.instanceId);

    // 1. What the text's Drive folder holds, by role — as the researcher, under this device.
    const listing = (await R.listTextFiles(L.instanceId, docId)) || {};
    const picks = pickTextFiles(listing.files || []);
    if (!picks.flextext && !picks.audio) throw new Error('nothing_to_materialize');
    const manifestText = await fetchAs(picks.manifest, 'text', 'manifest', s, L.instanceId);
    let manifest = null;
    if (manifestText) { try { manifest = JSON.parse(manifestText); } catch { manifest = null; } }
    if (manifest && (typeof manifest !== 'object' || !Array.isArray(manifest.files))) manifest = null;
    const title = String(cmd.title || (manifest && manifest.title) || docId);
    const xml = picks.flextext ? await fetchAs(picks.flextext, 'text', 'flextext', s, L.instanceId) : '';
    const audioBlob = picks.audio ? await fetchAs(picks.audio, 'blob', 'audio', s, L.instanceId) : null;

    // 2. The session: its own folder when this docId is already here (a return trip), else the title's id.
    const existing = s.sessions.filter((e) => e && e.name).map((e) => ({ id: e.name, docId: e.docId || '' }));
    const id = lametaSessionIdFor(title, docId, existing);
    const returning = existing.some((r) => r.docId === docId && r.id === id);
    let dir = await F.getDir(sessionsDir, id);
    const isNew = !dir;
    if (!isNew && !returning) {
      // The id is free by the scan but a folder of that name exists (made since the scan, or a
      // session without our manifest): never write into a folder that is not ours.
      throw new Error('session_folder_taken');
    }
    const existsIn = async (d, name) => !!(await F.statFile(d, name, { timeoutMs: 8000 }));
    /* On a return trip the files are matched by ROLE, not by name (§4): an ADOPTED session keeps
     * the names it had before it was a text, so the .flextext to replace and the recording to
     * leave alone are the ones the session's own manifest names, when they are still there. */
    const known = s.cache.get(id) || null;
    const mf = (returning && known && known.manifest) || null;
    let ftName = `${id}.flextext`, recName = '';
    if (mf) {
      const prevFt = (mf.files || []).find((f) => f && f.name && String(f.role || '') === 'source-flextext');
      if (prevFt && lametaFileName(prevFt.name) === prevFt.name && await existsIn(dir, prevFt.name)) ftName = prevFt.name;
      const prevAu = mf.audio && mf.audio.name;
      if (prevAu && lametaFileName(prevAu) === prevAu && await existsIn(dir, prevAu)) recName = prevAu;
    }

    // 3. The document and the timeline, exactly as the panel's lameta download derives them.
    let doc = null, aligned = false;
    if (xml) {
      const parsed = parseFlextext(xml);
      if (!parsed || parsed.error || !parsed.texts || !parsed.texts.length) throw new Error('flextext_unparseable');
      doc = parsed.texts[0];
      doc.segments = segmentsFromOffsets(doc) || [];
      aligned = doc.segments.some((g) => typeof g.start === 'number' && !g.timePending);
    }
    const ws = (manifest && manifest.writingSystems) || {};
    const vern = ws.vern || (doc && doc.vernLang) || (L.settings && L.settings.vernLang) || 'und';
    const anal = ws.anal || (doc && doc.analLang) || (L.settings && L.settings.analLang) || 'en';
    let media = null, segMedia = null;
    if (audioBlob) {
      const af = picks.audio;
      const mime = af.mime || audioBlob.type || audioMimeOf(af.name);
      // ⚠ Named lameta-safe BEFORE the EAF is built: it references the recording by this name.
      media = { name: recName || lametaFileName(mediaNameFor(id, { name: af.name, mimeType: mime })), mimeType: mime, blob: audioBlob, srcName: af.name || '' };
      const isWav = /\.wav$/i.test(af.name || '') || /\bwav\b/i.test(mime);
      const caps = conversionCaps({ bytes: audioBlob.size || 0, isWav });
      if (isWav || !caps.convert || !aligned) segMedia = media;
      else {
        if (typeof convertWav !== 'function') throw new Error('no_converter');
        s.work = { ...s.work, step: 'convert', name: af.name || '', pct: null }; onChange(L.instanceId);
        const wav = await convertWav(audioBlob, (f) => { s.work = { ...s.work, pct: Math.round((f || 0) * 100) }; onChange(L.instanceId); });
        if (!wav) throw new Error('convert_failed');
        segMedia = { name: lametaFileName(derivedWavName(id)), mimeType: 'audio/wav', blob: wav, derived: true, srcName: af.name || '' };
      }
    }

    // 4. The files, built by the same code as the panel's download.
    s.work = { ...s.work, step: 'build', pct: null }; onChange(L.instanceId);
    const entries = (doc && media && segMedia && aligned)
      ? await assembleSegEntries({ doc, title, base: id, media, segMedia, wants: { eaf: true }, vern, anal, full: false, producedBy: producedBy() })
      : [];
    if (segMedia && !entries.some((x) => x.name === segMedia.name)) entries.push({ name: segMedia.name, data: segMedia.blob });
    if (media && !entries.some((x) => x.name === media.name)) entries.push({ name: media.name, data: media.blob });
    if (xml) entries.push({ name: ftName, data: new Blob([lametaFlextextMedia(xml, segMedia ? segMedia.name : '')], { type: 'application/xml' }) });
    const stages = deriveStages({ doc, manifest, files: listing.files || [], analLang: anal });
    const contributors = [];
    if (picks.receipt) {
      try {
        const receipt = JSON.parse(await fetchAs(picks.receipt, 'text', 'receipt', s, L.instanceId));
        const who = String((receipt && receipt.signatureName) || '').trim();
        if (who) contributors.push({ name: who, role: 'speaker' });
      } catch (e) { log.warn('[lameta] consent receipt not readable for the session:', e); }
    }
    const flexGuid = xml ? ((/<interlinear-text\b[^>]*?\bguid="([^"]+)"/.exec(xml) || [])[1] || '') : '';
    const done = !!cmd.done;
    const suiteFiles = manifestText ? [{ name: MANIFEST_NAME, data: manifestText }] : [];
    const session = { id, title, done, vernLang: vern, analLang: anal, stages, contributors, docId, flexGuid, engine: engineVersion, now: now() };
    const prefix = `Sessions/${id}/`;
    const all = lametaSessionEntries(session, entries, suiteFiles)
      .filter((e) => e.name.startsWith(prefix) && !LAMETA_ROOT_FILES.includes(e.name.slice(prefix.length)))
      .map((e) => ({ name: e.name.slice(prefix.length), data: e.data }));

    // 5. Write. Order: a new folder, the annotation set, the recording, the sidecars, the suite files, the history LAST.
    s.work = { ...s.work, step: 'write', pct: null }; onChange(L.instanceId);
    if (isNew) dir = await F.ensureDir(sessionsDir, id);
    const written = [], kept = [], notes = [], twins = [], created = [];
    const put = async (name, data) => { if (!(await existsIn(dir, name))) created.push(name); await F.writeFile(dir, name, data); written.push(name); };
    const suiteDir = await F.ensureDir(dir, LAMETA_SUITE_DIR);
    const today = dateStamp(now());
    const annotation = (n) => n === ftName || n === `${id}.eaf` || n === `${id}.pfsx`;
    const isRecording = (n) => !!media && n === media.name;
    const isDerived = (n) => !!segMedia && segMedia.derived && n === segMedia.name;
    for (const e of all) {
      const n = e.name;
      if (n.startsWith(`${LAMETA_SUITE_DIR}/`)) continue;             // below, after the files they describe
      if (n === `${id}.session`) {
        if (isNew) await put(n, e.data);
        else kept.push(n);                                            // a rewrite is queued, never done live
        continue;
      }
      if (/\.meta$/i.test(n)) {
        // A sidecar only beside a file this pass CREATED (§3: for files we created, once). A file
        // that was already there — replaced or kept — is lameta's to describe; an existing sidecar
        // is never rewritten.
        if (!created.includes(n.replace(/\.meta$/i, '')) || await existsIn(dir, n)) { kept.push(n); continue; }
        await F.writeFile(dir, n, e.data); written.push(n);
        continue;
      }
      if (isRecording(n) && !isNew && await existsIn(dir, n)) {
        // The recording is never overwritten. Same bytes: nothing to do. Different: written beside it.
        const prev = await F.readFile(dir, n, { as: 'blob', timeoutMs: 30000 }).catch(() => null);
        const same = prev && (prev.size === e.data.size) && (await sha256OfBlob(prev)) === (await sha256OfBlob(e.data));
        if (same) { kept.push(n); continue; }
        const { stem, ext } = stemExt(n);
        const twin = `${stem}.returned-${today}${ext}`;
        await put(twin, e.data); twins.push(twin); notes.push(`recording_differs:${twin}`);
        continue;
      }
      if (annotation(n) && !isNew && n === ftName && await existsIn(dir, n)) {
        // Back the previous .flextext up OUTSIDE the session before it is replaced.
        const prev = await F.readFile(dir, n, { as: 'blob', timeoutMs: 30000 });
        if (prev) {
          const bdir = await F.ensureDir(rec.handle, `${BACKUP_DIR}/${today}`);
          let bname = n;
          if (await existsIn(bdir, bname)) bname = `${id}.${new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')}.flextext`;
          await F.writeFile(bdir, bname, prev); notes.push(`backup:${BACKUP_DIR}/${today}/${bname}`);
        }
      }
      // The annotation set (replaced in place), the derived WAV (ours, replaced), a new recording.
      if (annotation(n) || isDerived(n) || isRecording(n) || isNew) { await put(n, e.data); continue; }
      if (await existsIn(dir, n)) { kept.push(n); continue; }
      await put(n, e.data);
    }
    // A sidecar for a returned twin, which lametaSessionEntries did not know about.
    const metaData = (all.find((e) => /\.meta$/i.test(e.name)) || {}).data;
    for (const n of twins) if (metaData && !(await existsIn(dir, `${n}.meta`))) await put(`${n}.meta`, metaData);
    // The suite files: the manifest copy is immutable (written once), the history is the record.
    if (manifestText && !(await existsIn(suiteDir, MANIFEST_NAME))) { await F.writeFile(suiteDir, MANIFEST_NAME, manifestText); written.push(`${LAMETA_SUITE_DIR}/${MANIFEST_NAME}`); }
    const holder = { kind: 'lameta', id: L.instanceId, name: L.nickname || '' };
    const by = { kind: 'lameta-agent', id: L.installId };
    let history;
    if (returning && known && known.history) {
      history = withHistoryEvent(known.history, { kind: 'returned', from: historyCustody(known.history), to: holder, by, now: now() });
      if (notes.length) history.events[history.events.length - 1].notes = notes;
      // The stage facts this return brought: queued, never written into a .session lameta may hold.
      L.pendingLameta = queueLametaUpdate(L.pendingLameta || [], { kind: 'stages', sessionId: id, docId, stages, done, at: now() });
    } else {
      history = newHistory({ docId, sessionId: id, holder, by, kind: 'assigned', now: now() });
    }
    history.sessionId = id;
    await F.writeFile(suiteDir, LAMETA_HISTORY_NAME, JSON.stringify(history, null, 2));
    written.push(`${LAMETA_SUITE_DIR}/${LAMETA_HISTORY_NAME}`);

    // 6. The scan sees the session as a text here from now on; the card hears about it.
    const entry = { name: id, docId, title, custody: holder, manifest: manifest || (known && known.manifest) || null, history,
                    done, modified: Date.parse(history.custody.since) || now(), manifestFileId: (picks.manifest && picks.manifest.id) || '', available: true };
    s.cache.set(id, entry);
    s.sessions = isNew ? [...s.sessions.filter((e) => e && e.name !== id), entry] : s.sessions.map((e) => (e && e.name === id ? entry : e));
    s.scan = { sessions: s.sessions, available: true };
    s.pendingLameta = (L.pendingLameta || []).map((u) => ({ sessionId: u.sessionId, kind: u.kind, at: u.at }));
    s.lastAssign = { docId, sessionId: id, returning, written, kept, notes, live: lametaWritePolicy(s.openMarker.state).live, at: now() };
    s.work = null;
    return 'ack';
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
      case 'assign':
        return assignMaterialize(rec, s, cmd);
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
        if (s.skipSeq && s.skipSeq === c.seq) {
          // Skip, from the card: acked untouched, exactly as a phone would have. The person decided.
          s.skipSeq = 0; if (s.heldFail && s.heldFail.seq === c.seq) s.heldFail = null;
          ack = Math.max(ack, c.seq || 0); continue;
        }
        if (s.heldFail && s.heldFail.seq === c.seq && s.retrySeq !== c.seq && (now() - s.heldFail.at) < HELD_RETRY_MS) {
          held = true; waiting.push({ seq: c.seq, type: c.type, error: s.heldFail.error }); continue;   // failed recently: wait for Retry or the backoff
        }
        let verdict;
        try { verdict = await dispatch(rec, s, cmd); }
        catch (e) {
          // A handler that threw: held with its error, so the card shows it and nothing is acked.
          const msg = (e && e.message) || String(e);
          s.heldFail = { seq: c.seq, type: c.type, error: msg, at: now() }; s.work = null;
          log.warn('[lameta] command failed', c.type, c.seq, e);
          held = true; waiting.push({ seq: c.seq, type: c.type, error: msg }); continue;
        }
        if (s.retrySeq === c.seq) s.retrySeq = 0;
        if (verdict === 'hold') { held = true; waiting.push({ seq: c.seq, type: c.type }); continue; }
        if (s.heldFail && s.heldFail.seq === c.seq) s.heldFail = null;
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
    return { ...rest, waiting: s.waiting.slice(), sessions: Array.isArray(s.sessions) ? s.sessions.slice() : null,
             pendingLameta: (s.pendingLameta || []).slice(), openMarker: { ...(s.openMarker || { state: 'absent' }) } };
  }
  /* Retry / Skip for a held command that failed (the card's two buttons). Retry runs it on the next
   * tick regardless of the backoff; Skip acks it untouched on the next tick. Both tick at once. */
  function retryHeld(instanceId, seq) {
    const s = st(instanceId); const f = s.heldFail;
    if (!f || (seq && f.seq !== seq)) return false;
    s.retrySeq = f.seq; onChange(instanceId); tick(instanceId).catch(() => {}); return true;
  }
  function skipHeld(instanceId, seq) {
    const s = st(instanceId); const f = s.heldFail;
    if (!f || (seq && f.seq !== seq)) return false;
    s.skipSeq = f.seq; onChange(instanceId); tick(instanceId).catch(() => {}); return true;
  }
  /* THE GATE on the pending lameta updates (plans/lameta-device.md §7, plans/flextext-metadata.md
   * §5): they may be applied only while the open marker is not fresh. M7's apply calls this first;
   * the card reads it to say why Apply waits. */
  function pendingGate(instanceId) {
    const s = st(instanceId);
    const state = (s.openMarker && s.openMarker.state) || 'absent';
    const policy = lametaWritePolicy(state);
    return { allowed: policy.applyPending, state, app: (s.openMarker && s.openMarker.app) || '', n: (s.pendingLameta || []).length, live: policy.live };
  }

  return { link, unlink, links, linkedFor, tick, tickAll, start, stop, status, requestPermission,
           prepareAdopt, beginAdopt, finishAdopt, retryHeld, skipHeld, pendingGate,
           inspect: (handle, opts) => inspectProject(F, handle, opts), running: () => started };
}
