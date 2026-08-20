/* sync.js — FlexText connectivity sync engine (Phase 1 client / RA-install side).
 *
 * A no-login, async remote-management layer. One one-time invite link binds this
 * install to a researcher's "instance"; from then on the install POLLS the Worker's
 * /v1/ desired lane for commands (assign / delete / changeSettings / triggerUpload)
 * and REPORTS its inventory back. Content stays on the client — only the list +
 * commands sync. See docs/connectivity-plan.md for the full design + hardening.
 *
 * INERT BY DEFAULT: with no claimed session this module does nothing, so shipping
 * it changes the app's behavior for current users not one bit (same gating pattern
 * as the v48 relay routing). Everything below is reached only after a claim.
 *
 * Decoupling: this module knows NOTHING about app internals. app.js calls
 * Sync.start(iface) with an injected interface:
 *   iface.workerBase()        -> string   (settings.relayWorker || DEFAULT_WORKER)
 *   iface.appType()           -> 'editor' | 'recorder'  (must match the invite type)
 *   iface.dispatch(command)   -> Promise   (apply ONE command via the app's existing
 *                                           idempotent, never-clobber handlers)
 *   iface.gatherInventory()   -> Promise<object>  (metadata-only list to report)
 *   iface.onStatus(state)     -> void      (optional UI hook: 'pending'|'linked'|…)
 */

import { generateInstallKeypair, exportPublicKeyB64, importPublicKeyB64, publicKeyFingerprint, unwrapKeyFromResearcher, encryptJSON, decryptJSON } from './crypto.js';

const SESSION_KEY = 'flextext-sync-session';
const REQ_TIMEOUT_MS = 20000;     // bad-connection guard on every /v1/ request
const POLL_FG_MS = 20000;         // foreground cadence — snappy so researcher-pushed commands (upload/settings/assign) land within ~20s; worker-load tradeoff at scale (see plan §C.4)
const POLL_IDLE_MS = 60000;       // back off when idle / hidden (was 180s)
const MAX_BACKOFF_STEPS = 5;      // circuit-breaker: exponential backoff cap on repeated failure

/* ---------------- session state (one install ⇄ one instance) ---------------- */

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; }
  catch { return null; }
}
function saveSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }

export function hasSession() { return !!loadSession(); }
// Enrollment facts the app needs for data-scoping (install identity + when this device was
// bound). null when unmanaged. enrolledAt is 0 for sessions claimed before this existed.
export function enrollment() {
  const s = loadSession();
  return s ? { installId: s.installId, instanceId: s.instanceId, status: s.status, enrolledAt: s.enrolledAt || 0 } : null;
}
export function clearSession() { localStorage.removeItem(SESSION_KEY); resetKeys(); }

/* THE PAIRING CODE — six digits the worker minted for THIS pending pairing, shown in large type on
 * this device and in the researcher's panel until both ends have approved.
 *
 * ⚠ IT IS A STORED FACT, NOT A MOMENT. The whole reason this exists is that the old code lived only
 * inside a 12-second toast, so a coworker who blinked had permanently lost the value the panel was
 * demanding they read aloud — with no screen anywhere that would show it again. Anything that can
 * ask "what is the code" must be able to ask it at any time, which means reading it from the
 * session rather than being handed it once.
 *
 * Empty string once the pairing is over (or for a session claimed by an engine from before this
 * existed), which is what the banner reads to take itself down. */
export function pairCode() {
  const s = loadSession();
  return (s && s.pairCode) || '';
}

/* The name THIS device's researcher gave it in the panel ("Wemis Wanimbo's Phone").
 *
 * ⚠ WHY A DEVICE NEEDS TO KNOW ITS OWN NAME (Seth, 2026-08-20): "we also need a way to be 100% sure
 * that the device we're using DOES in fact match the device listed in the tile." Until now it could
 * not: the panel names devices and the device was never told, so identifying the app in front of you
 * meant comparing engine versions and guessing. That ambiguity cost real time during the v439 test
 * drive — an editor showing an empty text list could not be told apart from a DIFFERENT editor,
 * on another origin, that had simply never had those texts.
 *
 * Empty until the first poll answers, and for a device that is not paired at all. */
export function deviceNickname() {
  const s = loadSession();
  return (s && s.nickname) || '';
}

// Streaming-upload target for THIS enrolled device (null when unmanaged, pending,
// not yet user-accepted, or before Sync.start injected the iface): the worker
// route that lands bundles in the researcher's own Drive ("FlexText Uploads /
// <device>"). The install secret stays inside this module — callers get
// ready-made headers, never the raw session.
export function workerUploadTarget() {
  if (!iface || !iface.workerBase) return null;
  const s = loadSession();
  if (!s || !s.instanceId || !s.accepted || s.status !== 'approved') return null;
  const base = (iface.workerBase() || '').replace(/\/+$/, '');
  if (!base) return null;
  return {
    url: `${base}/v1/instances/${encodeURIComponent(s.instanceId)}/installs/${encodeURIComponent(s.installId)}/upload`,
    headers: { 'x-fx-install': s.installId, 'x-fx-secret': s.installSecret },
  };
}

/* ---------------- crypto helpers (install identity, minted locally) ---------------- */

// ≥128-bit base64url token (plan §F.3). Used for the install secret.
function randTok(n = 24) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function uuid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    ('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    }));
}

// Stable hash of a string → short hex (for titleHash + the report change-gate).
async function sha256hex(str) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- E2EE key persistence (model A) ----------------
 * The install's RSA-OAEP PRIVATE key never leaves the device and is never
 * serialized: it lives as a non-extractable CryptoKey in IndexedDB (structured
 * clone stores CryptoKey objects natively). The per-instance key Ki is unwrapped
 * from the researcher-delivered wrapped_key with that private key and held ONLY in
 * memory (also non-extractable). localStorage holds only public/ciphertext values —
 * never key material. Losing the IndexedDB private key means re-claiming (correct
 * failure mode: a wiped device can't silently keep decrypting). */

const IDB_NAME = 'flextext-sync';
const IDB_STORE = 'keys';
const IDB_PRIV = 'install-private-key';

function idbOpen() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function idbPut(key, val) {
  const db = await idbOpen();
  try {
    await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
  } finally { db.close(); }
}
async function idbGet(key) {
  const db = await idbOpen();
  try {
    return await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const r = tx.objectStore(IDB_STORE).get(key);
      r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
    });
  } finally { db.close(); }
}
async function idbDel(key) {
  try {
    const db = await idbOpen();
    try {
      await new Promise((res) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = res; tx.onerror = res; tx.onabort = res;
      });
    } finally { db.close(); }
  } catch { /* best-effort */ }
}

// Drop all in-memory + persisted key material (logout / re-claim / definitive reject).
function resetKeys() {
  installPrivateKey = null;
  instanceKey = null;
  lastReportHash = null;
  idbDel(IDB_PRIV);
}

// Load the install private key from IndexedDB into memory (idempotent).
async function ensurePrivateKey() {
  if (installPrivateKey) return installPrivateKey;
  installPrivateKey = await idbGet(IDB_PRIV);
  return installPrivateKey;
}

// After approval the researcher delivers Ki wrapped to our pubkey. Unwrap it with the
// private key (held only here) into a non-extractable AES key in memory. Re-runs only
// when the wrapped blob changes (supports researcher key rotation). Returns Ki, or
// null if the key isn't deliverable yet / the private key is gone.
async function obtainInstanceKey(s, wrappedKey) {
  if (!wrappedKey) return instanceKey;                                // researcher hasn't wrapped Ki yet
  if (instanceKey && s.wrappedKey === wrappedKey) return instanceKey; // already current
  const priv = await ensurePrivateKey();
  if (!priv) return null;                                             // private key lost → re-claim required
  instanceKey = await unwrapKeyFromResearcher(priv, wrappedKey);
  s.wrappedKey = wrappedKey; saveSession(s);
  return instanceKey;
}

// On load, rehydrate Ki from the persisted wrapped blob + private key (no network).
async function restoreKeys(s) {
  try { if (s && s.wrappedKey) await obtainInstanceKey(s, s.wrappedKey); }
  catch { /* unwrap failure leaves instanceKey null; poll re-attempts on next body */ }
}

/* ---------------- module state (set by start) ---------------- */

let iface = null;
let started = false;
let pollTimer = null;
let inFlight = false;
let failStreak = 0;
let lastReportHash = null;
let installPrivateKey = null;  // RSA-OAEP private key (non-extractable CryptoKey, from IndexedDB)
let instanceKey = null;        // Ki (AES-GCM non-extractable), unwrapped in memory only

/* ---------------- low-level request (own /v1/ auth, never the public ?t=) ---------------- */

async function v1(method, path, { headers = {}, body, secretless = false } = {}) {
  const base = (iface.workerBase() || '').replace(/\/+$/, '');
  if (!base) throw new Error('no_worker_base');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(base + path, {
      method,
      headers: Object.assign(
        body !== undefined ? { 'content-type': 'application/json' } : {},
        headers
      ),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
      // /v1/ is never the public ?t= front door; no credentials/cookies.
    });
    if (res.status === 204) return { _status: 204 };
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const e = new Error((data && data.error) || ('http_' + res.status));
      e.status = res.status; e.data = data;
      throw e;
    }
    return data || {};
  } finally {
    clearTimeout(timer);
  }
}

function installHeaders(s) { return { 'x-fx-install': s.installId, 'x-fx-secret': s.installSecret }; }

/* ---------------- claim (one-time invite → install binding) ---------------- */

// Mint install identity LOCALLY and persist BEFORE the first POST (plan §D.1), so a
// dropped response loses nothing and retry is a safe no-op. The claim is provisional
// (status 'pending') until the researcher approves it (anti-leaked-link, §D.3).
// Returns { ok, type, status } or { ok:false, error }.
export async function claim(inviteId, inviteSecret) {
  if (!inviteId || !inviteSecret) return { ok: false, error: 'bad_invite' };
  let s = loadSession();
  // Already bound to an instance? One browser profile = ONE install = ONE instance (editor + recorder
  // share it same-origin), so never clobber an existing binding:
  if (s && s.instanceId) {
    // Same invite re-opened — e.g. the OTHER app's link for this same device → REUSE: no re-claim,
    // no re-consent, no re-approval. The other app just works off the shared session.
    if (s.inviteId === inviteId) return { ok: true, type: s.type, status: s.status, accepted: !!s.accepted, pairCode: s.pairCode || '', reused: true };
    // A DIFFERENT invite while still linked → REFUSE (claim guard); never silently move a live device
    // to another instance. If the old binding was revoked, poll() auto-releases first, so a legitimate
    // re-link still works after a revoke.
    return { ok: false, error: 'already_linked' };
  }
  // Reuse a previously-minted-but-unconfirmed identity for THIS invite (idempotent retry).
  if (!s || s.inviteId !== inviteId) {
    // enrolledAt: when this device was bound to (this) researcher. Data-scoping uses it so a
    // freshly-claimed researcher only sees/uploads docs created AFTER binding (or ones the user
    // explicitly shared) — a phished/hijacked enrollment can't grab the pre-existing corpus.
    s = { inviteId, installId: uuid(), installSecret: randTok(24), instanceId: null,
          type: null, status: 'claiming', desiredRev: -1, ackSeq: 0, pubkey: null, wrappedKey: null,
          enrolledAt: Date.now(), accepted: false, pairCode: '' };
    // E2EE model A: mint an RSA-OAEP keypair ONCE per identity. The private key is
    // stored non-extractable in IndexedDB and never leaves; only the public key is
    // sent (and re-sent identically on idempotent retry, so the worker's first-write
    // pubkey always matches the private key we hold).
    try {
      const kp = await generateInstallKeypair();
      await idbPut(IDB_PRIV, kp.privateKey);
      installPrivateKey = kp.privateKey;
      instanceKey = null;
      s.pubkey = await exportPublicKeyB64(kp.publicKey);
    } catch { /* WebCrypto unavailable → claim sends no pubkey; E2EE just won't engage */ }
    saveSession(s);
  }
  try {
    const r = await v1('POST', `/v1/invites/${encodeURIComponent(inviteId)}/claim`, {
      headers: { 'x-fx-invite-secret': inviteSecret },
      body: { install_id: s.installId, install_secret: s.installSecret, pubkey: s.pubkey || undefined },
    });
    // Type must match the running app (editor invite in the editor, recorder in the
    // recorder) — keeps the two apps' lists disjoint (plan §1).
    if (r.type && iface && iface.appType && iface.appType() !== r.type) {
      clearSession();
      return { ok: false, error: 'type_mismatch', wanted: iface.appType(), got: r.type };
    }
    s.instanceId = r.instance_id;
    s.type = r.type;
    s.status = r.status || 'pending';
    /* ⚠ THE ENROLLING RESEARCHER'S NAME, EMAIL AND AVATAR ARE DELIBERATELY NOT STORED (Seth,
     * 2026-08-20: "we do want the researcher's identity not to be advertised in the pairing
     * process… EXACTLY the same for anything that needs to be paired").
     *
     * Taking them off the consent SCREEN was only half of it. This line used to persist them into
     * localStorage on every paired device, where they would sit for the life of the install — so a
     * device that later left the team's control still carried a named individual's contact details.
     * Minimising what a device holds about the people in a project is part of the privacy and
     * research-ethics obligations this suite owes the communities it serves, and the surest way not
     * to hold something is never to write it down.
     *
     * ⚠ The worker still SENDS r.researcher, and that is fine — it is a protocol we share with
     * already-deployed clients, and changing it would blank the consent screen of every editor and
     * recorder still on the old build. We simply drop it on the floor. */
    /* ⚠ NEVER OVERWRITE A CODE WE HOLD WITH AN EMPTY ONE. An older worker — or one mid-deploy —
     * answers a claim without pair_code at all, and this same line runs on the idempotent retry
     * path. Blanking here would take the number off this screen while the panel still shows it,
     * which is precisely the "they don't match" dead end the code exists to end. */
    if (r.pair_code) s.pairCode = String(r.pair_code);
    // KEEP s.inviteId: re-opening this invite (the other app's link for the same device) is then
    // recognized as already-claimed → reused, instead of minting a new identity that clobbers this one.
    saveSession(s);
    if (iface && iface.onStatus) iface.onStatus(s.status);
    return { ok: true, type: s.type, status: s.status, accepted: !!s.accepted };
  } catch (e) {
    // Network failure on claim is recoverable — the local identity persisted, so a
    // later retry of the same invite reuses it. A definitive rejection clears it.
    if (e.status === 401 || e.status === 410 || e.status === 409) { clearSession(); return { ok: false, error: e.message }; }
    return { ok: false, error: 'offline', retryable: true };
  }
}

// The field user accepted the enrolling researcher (B): tell the worker (this gates key delivery
// server-side) and unlock local engagement. {ok} on success; clears the session on a hard reject.
export async function accept() {
  const s = loadSession();
  if (!s || !s.instanceId) return { ok: false, error: 'no_session' };
  try {
    await v1('POST', `/v1/instances/${encodeURIComponent(s.instanceId)}/installs/${encodeURIComponent(s.installId)}/accept`,
      { headers: installHeaders(s) });
    s.accepted = true; saveSession(s);
    if (started) poll();                                   // engage now that we're accepted
    return { ok: true };
  } catch (e) {
    if (e.status === 401 || e.status === 410) { clearSession(); return { ok: false, error: e.message }; }
    return { ok: false, error: 'offline', retryable: true };
  }
}

// A claimed-but-not-yet-accepted enrollment (B): the app shows the consent dialog (who's
// connecting) on claim AND on reload until the user accepts or declines. null otherwise.
export function pendingConsent() {
  const s = loadSession();
  return (s && s.instanceId && !s.accepted) ? { instanceId: s.instanceId, installId: s.installId } : null;
}

// This install's public-key fingerprint (formatted), for OUT-OF-BAND verification at
// approval: the coworker reads it to the researcher, who confirms it matches what the
// panel shows — defeating a tampered worker that swapped the pubkey before delivering Ki.
export async function deviceFingerprint() {
  const s = loadSession();
  if (!s || !s.pubkey) return null;
  try {
    const fp = await publicKeyFingerprint(await importPublicKeyB64(s.pubkey));
    return fp.replace(/(.{4})/g, '$1 ').trim();
  } catch { return null; }
}

/* ---------------- remote wipe (seized device) ---------------- */

// The worker signalled a remote wipe. ACK first (best-effort, retry:false) so the panel can show
// "confirmed" — this MUST run before the wipe, because eraseAllData destroys the very credentials the ack
// needs (after it, there is nothing to ack with). The await orders the ack before the (page-reloading,
// never-returning) wipe; if the ack fails (offline), the wipe still proceeds. Then erase everything.
async function wipeThisDevice(s) {
  // Best-effort ack so the panel can show the device received it — but NEVER let a slow/offline ack delay
  // the actual wipe (the device may be mid-seizure): race it against a short timeout, then erase regardless.
  try {
    const ack = v1('POST', `/v1/instances/${encodeURIComponent(s.instanceId)}/installs/${encodeURIComponent(s.installId)}/wipe-ack`,
      { headers: installHeaders(s) }).catch(() => {});
    await Promise.race([ack, new Promise((r) => setTimeout(r, 4000))]);
  } catch { /* best-effort */ }
  if (iface && iface.eraseAllData) await iface.eraseAllData();   // clears IDB + storage + caches + SWs, then reloads (never returns)
}

/* ---------------- poll (desired lane → apply commands → report) ---------------- */

export async function poll() {
  if (!started || inFlight) return;
  const s = loadSession();
  if (!s || !s.instanceId || !navigator.onLine) return;
  inFlight = true;
  try {
    const r = await v1('GET', `/v1/instances/${encodeURIComponent(s.instanceId)}?since=${s.desiredRev}`,
      { headers: installHeaders(s) });
    failStreak = 0;
    if (r.wipe) { await wipeThisDevice(s); return; }           // REMOTE WIPE — top priority, any state, before every gate
    if (r._status === 204) { await maybeReport(s); return; }   // nothing new
    if (r.pending) {                                           // awaiting researcher approval (§D.3)
      if (s.status !== 'pending' && iface.onStatus) iface.onStatus('pending');
      s.status = 'pending';
      if (r.nickname && r.nickname !== s.nickname) { s.nickname = r.nickname; if (iface.onStatus) iface.onStatus('named'); }
      saveSession(s);
      await maybeReport(s);
      return;
    }
    // B (consent): do not engage — no key, no commands, no report — until the field user has
    // accepted this enrollment. Defense-in-depth; the worker also refuses key delivery unaccepted.
    if (!s.accepted) { if (iface.onStatus) iface.onStatus('needs-accept'); return; }
    /* ⚠ AND THE PAIRING CODE DIES HERE, with the pairing it describes. This is the one place the
     * device learns it was approved, so it is the one place that can honestly retire the number —
     * the worker has already cleared its copy, and a code left on screen after the panel stopped
     * showing one is a coworker reading out something nobody can match. */
    /* ⚠ EVERY POLL, not just the first. A researcher renaming a device in the panel must reach the
     * device — a name that silently means "whatever it was called when you paired" is the same
     * ambiguity this exists to remove, just slower to notice. */
    if (r.nickname && r.nickname !== s.nickname) { s.nickname = r.nickname; saveSession(s); if (iface.onStatus) iface.onStatus('named'); }
    if (s.status !== 'approved') { s.status = 'approved'; s.pairCode = ''; saveSession(s); if (iface.onStatus) iface.onStatus('linked'); }
    // E2EE gate (model A): we can neither decrypt commands nor encrypt a report
    // without Ki. While approved, every GET (since stays -1) carries wrapped_key once
    // the researcher has delivered it; until then HOLD — never advance the rev cursor,
    // so we keep re-fetching the body until the key arrives.
    await obtainInstanceKey(s, r.wrapped_key);
    if (!instanceKey) { if (iface.onStatus) iface.onStatus('awaiting-key'); return; }
    // Apply only commands newer than our ack cursor; idempotency (not the ack) is what
    // guarantees correctness, so a crash mid-apply is safe to re-run (§3). Each
    // command's sensitive payload rides an encrypted `enc` field — type/seq/id stay
    // plaintext for the worker's routing/validation; decrypt before dispatch.
    const cmds = (r.commands || []).filter((c) => (c.seq || 0) > s.ackSeq).sort((a, b) => a.seq - b.seq);
    for (const c of cmds) {
      let cmd = c;
      if (c.enc) {
        try { cmd = Object.assign({ type: c.type, seq: c.seq, id: c.id }, await decryptJSON(instanceKey, c.enc)); }
        catch (err) { console.warn('sync: command decrypt failed', c.seq, err); s.ackSeq = Math.max(s.ackSeq, c.seq || 0); continue; }
      }
      try { await iface.dispatch(cmd); }
      catch (err) { /* a bad command must not stall the rest or the rev cursor */ console.warn('sync: command failed', c.type, err); }
      s.ackSeq = Math.max(s.ackSeq, c.seq || 0);
    }
    s.desiredRev = r.desired_rev;
    saveSession(s);
    await maybeReport(s, /*force*/ true); // report (with the advanced ack) right after applying
  } catch (e) {
    // 410 = the worker says this install/instance was REVOKED → auto-release so the device is never
    // orphaned-and-stuck: drop the binding + keys, tell the app to scrub the researcher's Drive links,
    // and stop polling (clearSession makes the finally's schedule() a no-op).
    if (e && e.status === 410) {
      clearSession();
      if (iface && iface.onRevoked) iface.onRevoked();
      if (iface && iface.onStatus) iface.onStatus('revoked');
      return;
    }
    failStreak = Math.min(failStreak + 1, MAX_BACKOFF_STEPS); // circuit-breaker backoff
  } finally {
    inFlight = false;
    schedule();
  }
}

/* ---------------- report (metadata-only inventory, change-gated) ---------------- */

async function maybeReport(s, force = false) {
  if (!instanceKey) return;   // E2EE: nothing leaves the device unencrypted; no Ki → no report yet
  let inv;
  try { inv = await iface.gatherInventory(); } catch { return; }
  // Gate on a hash of the PLAINTEXT stable fields (never timestamps/progress) so an
  // unchanged list never burns a write. (The ciphertext can't gate — random IV makes
  // it differ every time; the client gate is what prevents redundant writes.)
  const hash = await sha256hex(JSON.stringify(inv) + '|' + s.ackSeq);
  if (!force && hash === lastReportHash) return;
  let reported;
  try { reported = await encryptJSON(instanceKey, inv); } catch { return; }
  try {
    await v1('POST', `/v1/instances/${encodeURIComponent(s.instanceId)}/installs/${encodeURIComponent(s.installId)}/report`,
      { headers: installHeaders(s), body: { reported, ack_seq: s.ackSeq } });
    lastReportHash = hash;
  } catch { /* report is best-effort; next tick retries */ }
}

// Public: nudge a report after an inventory-changing local event (doc add/delete/
// upload-state change). Cheap + change-gated, so calling it liberally is fine.
export async function reportNow() {
  if (!started) return;
  const s = loadSession();
  if (s && s.instanceId && s.status === 'approved' && navigator.onLine) await maybeReport(s);
}

/* ---------------- scheduling (adaptive cadence + reconnect jitter) ---------------- */

function nextDelay() {
  const base = (document.visibilityState === 'visible') ? POLL_FG_MS : POLL_IDLE_MS;
  if (failStreak === 0) return base;
  return Math.min(base * Math.pow(2, failStreak), 5 * 60 * 1000); // exp backoff, cap 5m (field: reconnect fast; the `online` event also forces an immediate poll)
}
function schedule() {
  if (pollTimer) clearTimeout(pollTimer);
  if (!hasSession()) return;
  pollTimer = setTimeout(poll, nextDelay());
}

/* ---------------- lifecycle ---------------- */

export function start(injected) {
  if (started) return;
  iface = injected;
  started = true;
  // Trigger off the SAME signals the upload retry sweep uses: startup, regained
  // connectivity, and a timer. Jitter the reconnect poll so co-located village
  // devices don't thundering-herd the shared Worker cap (plan §C.5).
  window.addEventListener('online', () => {
    const jitter = (crypto.getRandomValues(new Uint8Array(1))[0] / 255) * 30000;
    setTimeout(() => poll(), jitter);
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(); });
  /* ⚠ AND SCRUB WHAT IS ALREADY WRITTEN DOWN. Not storing it from now on does nothing for the
   * devices that paired BEFORE this build — they are carrying a researcher's name, email and avatar
   * in localStorage right now, and those are exactly the installs the change is for. One cheap pass
   * at startup, then the field is gone for good. Deliberately unconditional and silent: there is
   * nothing for a user to decide here, and it removes data rather than changing behaviour. */
  {
    const s0 = loadSession();
    if (s0 && s0.researcher) { delete s0.researcher; saveSession(s0); }
  }
  if (hasSession()) {
    // Rehydrate Ki from IndexedDB (private key) + the persisted wrapped blob, THEN
    // poll — so the first tick can already decrypt/encrypt without a round-trip.
    restoreKeys(loadSession()).finally(() => poll());
  }
}
