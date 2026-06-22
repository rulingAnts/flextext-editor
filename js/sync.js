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
const POLL_FG_MS = 60000;         // foreground cadence (≈50 devices @ shared cap; see plan §C.4)
const POLL_IDLE_MS = 180000;      // back off when idle / hidden
const MAX_BACKOFF_STEPS = 5;      // circuit-breaker: exponential backoff cap on repeated failure

/* ---------------- session state (one install ⇄ one instance) ---------------- */

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; }
  catch { return null; }
}
function saveSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }

export function hasSession() { return !!loadSession(); }
export function clearSession() { localStorage.removeItem(SESSION_KEY); resetKeys(); }

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
  // Reuse a previously-minted-but-unconfirmed identity for THIS invite (idempotent retry).
  if (!s || s.inviteId !== inviteId) {
    s = { inviteId, installId: uuid(), installSecret: randTok(24), instanceId: null,
          type: null, status: 'claiming', desiredRev: -1, ackSeq: 0, pubkey: null, wrappedKey: null };
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
    delete s.inviteId; // burned; the binding is now the install identity
    saveSession(s);
    if (iface && iface.onStatus) iface.onStatus(s.status);
    return { ok: true, type: s.type, status: s.status };
  } catch (e) {
    // Network failure on claim is recoverable — the local identity persisted, so a
    // later retry of the same invite reuses it. A definitive rejection clears it.
    if (e.status === 401 || e.status === 410 || e.status === 409) { clearSession(); return { ok: false, error: e.message }; }
    return { ok: false, error: 'offline', retryable: true };
  }
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
    if (r._status === 204) { await maybeReport(s); return; }   // nothing new
    if (r.pending) {                                           // awaiting researcher approval (§D.3)
      if (s.status !== 'pending' && iface.onStatus) iface.onStatus('pending');
      s.status = 'pending'; saveSession(s);
      await maybeReport(s);
      return;
    }
    if (s.status !== 'approved') { s.status = 'approved'; saveSession(s); if (iface.onStatus) iface.onStatus('linked'); }
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
  return Math.min(base * Math.pow(2, failStreak), 30 * 60 * 1000); // exp backoff, cap 30m
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
  if (hasSession()) {
    // Rehydrate Ki from IndexedDB (private key) + the persisted wrapped blob, THEN
    // poll — so the first tick can already decrypt/encrypt without a round-trip.
    restoreKeys(loadSession()).finally(() => poll());
  }
}
