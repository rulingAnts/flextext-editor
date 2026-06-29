/* researcher.js — researcher-panel engine (the control side of the connectivity layer).
 *
 * The twin of sync.js: where sync.js is the FIELD install (polls, applies, reports),
 * this is the RESEARCHER (signs in, creates instances, mints invites, approves installs,
 * delivers keys, pushes commands, reads decrypted inventory). Pure engine — NO UI; the
 * panel calls these and renders.
 *
 * Auth model: GOOGLE SIGN-IN (OIDC), unified with the drive.file Drive OAuth — one Google
 * consent grants identity + Drive. The worker upserts the researcher by Google `sub`, mints a
 * session token, and holds the random data key Kr server-wrapped (operator-recoverable). The
 * client never sees a password: consumeGauth() reads the #gauth=<id>.<token> return fragment,
 * then bootstrap() fetches Kr (memory only). Each instance has a random Ki wrapped under Kr in
 * the D1 settings_blob; Ki reaches a field install asymmetrically (install sends a public key
 * at claim, researcher wraps Ki to it; the Worker only relays ciphertext). Everything the
 * Worker/D1 hold is ciphertext except routing fields, plus the server-held Kr (by design).
 *
 * The session token persists per the "stay signed in" preference: localStorage (survives app
 * close) when opted in, else sessionStorage (cleared on app exit = lock-on-exit, the default).
 * Kr is NEVER persisted (memory only); a closed/forensic device yields no data key.
 */

import {
  generateKey, wrapKey, unwrapKey,
  importKeyB64, encryptJSON, decryptJSON,
  importPublicKeyB64, wrapKeyForInstall,
} from './crypto.js';

const AUTH_KEY = 'flextext-researcher-auth';
const STAY_KEY = 'flextext-researcher-stay';   // "1" = persist the session across app exit
const LAST_ACCT_KEY = 'flextext-researcher-acct';   // sticky: the last account whose data lives in this browser.
                                                    // SURVIVES signOut (only AUTH_KEY is cleared) so a DIFFERENT account
                                                    // signing in on the same profile is detectable; cleared only by a full wipe.
const REQ_TIMEOUT_MS = 20000;

/* ---------------- module state ---------------- */

let workerBaseFn = () => '';
let Kr = null;                 // the researcher's random DATA key (memory only); wraps every Ki
let settingsCache = null;      // last-known settings_blob: { wrappedKis:{} }
let settingsRev = null;        // its server rev, for optimistic-locked writes (anti silent clobber)
let kiCache = new Map();       // instance_id -> Ki CryptoKey (unwrapped under Kr)
let approvedSelf = false;      // is THIS researcher approved (active)? false = pending (request/approve)
let ownerSelf = false;         // is THIS researcher an owner (can approve others)?

export function init({ workerBase } = {}) { if (workerBase) workerBaseFn = workerBase; }

/* ---------------- auth creds (the researcher's session token, on their own device) ----------------
 * Stored in sessionStorage by default (cleared when the app/PWA window closes → "lock on exit"),
 * or in localStorage when the user opts into "stay signed in". loadAuth() prefers whichever holds
 * it. Kr is never stored — only this revocable session token is. */

export function staySignedIn() { try { return localStorage.getItem(STAY_KEY) === '1'; } catch { return false; } }
export function setStaySignedIn(on) {
  try {
    localStorage.setItem(STAY_KEY, on ? '1' : '0');
    const a = loadAuth();                                    // move the live session to the chosen store
    if (a) { localStorage.removeItem(AUTH_KEY); sessionStorage.removeItem(AUTH_KEY); (on ? localStorage : sessionStorage).setItem(AUTH_KEY, JSON.stringify(a)); }
  } catch { /* noop */ }
}

function loadAuth() { try { return JSON.parse(sessionStorage.getItem(AUTH_KEY) || localStorage.getItem(AUTH_KEY)) || null; } catch { return null; } }
function saveAuth(a) { try { (staySignedIn() ? localStorage : sessionStorage).setItem(AUTH_KEY, JSON.stringify(a)); } catch { /* noop */ } }

export function isSignedUp() { return !!loadAuth(); }
export function isUnlocked() { return !!Kr; }
export function lock() { Kr = null; settingsCache = null; settingsRev = null; kiCache = new Map(); approvedSelf = false; ownerSelf = false; }
export function signOut() { lock(); try { localStorage.removeItem(AUTH_KEY); sessionStorage.removeItem(AUTH_KEY); } catch { /* noop */ } }

/* ---------------- low-level request (researcher-authed unless auth:false) ---------------- */

const RETRY_MAX = 4;                                   // bounded inner retries; outer loops (poll, route) add more
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Exponential backoff + jitter: ~1.4s, 2.8s, 5.6s, 11s — absorbs the brief network drops that are
// the norm in the field, then surfaces so the caller's own retry loop (poll interval / reconnect)
// takes over for longer outages.
function backoffMs(attempt) { return Math.min(700 * Math.pow(2, attempt), 15000) + Math.floor(Math.random() * 400); }

// Network-resilient request. Retries TRANSIENT failures (the connection failed, the request timed
// out, or the server returned 5xx/429) with backoff; a 4xx (401/403/404/409) is DEFINITIVE and
// never retried. Non-idempotent callers (createInstance, mintInvite) pass retry:false so a lost
// response can't silently create a duplicate.
async function api(method, path, { headers = {}, body, auth = true, retry = true, retries = RETRY_MAX } = {}) {
  const base = (workerBaseFn() || '').replace(/\/+$/, '');
  if (!base) throw new Error('no_worker_base');
  const h = Object.assign(body !== undefined ? { 'content-type': 'application/json' } : {}, headers);
  if (auth) {
    const a = loadAuth();
    if (!a) throw new Error('not_signed_up');
    h['x-fx-researcher'] = a.researcher_id; h['x-fx-secret'] = a.secret;
  }
  let attempt = 0;
  for (;;) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
    let res = null, netErr = null;
    try {
      res = await fetch(base + path, {
        method, headers: h,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal, cache: 'no-store',
      });
    } catch (e) { netErr = e; }                        // network failure or timeout-abort
    finally { clearTimeout(timer); }
    const transient = !!netErr || (res && (res.status >= 500 || res.status === 429));
    if (transient && retry && attempt < retries) { attempt++; await sleep(backoffMs(attempt)); continue; }
    if (netErr) throw netErr;                           // retries exhausted → surface to the caller's loop
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) { const e = new Error((data && data.error) || ('http_' + res.status)); e.status = res.status; e.data = data; throw e; }
    return data || {};
  }
}

/* ---------------- Google Sign-In (OIDC) — the current auth model ---------------- */

// URL to start "Sign in with Google" (a top-level navigation). `returnTo` is where the worker
// callback sends the browser back — its ORIGIN must be allow-listed on the worker; the full path
// (e.g. .../flextext-editor/) is preserved.
export function googleSignInUrl(returnTo) {
  const base = (workerBaseFn() || '').replace(/\/+$/, '');
  return base + '/v1/oauth/google/start?return=' + encodeURIComponent(returnTo || location.href.replace(/[?#].*$/, ''));
}

// Consume the #gauth=<researcher_id>.<session-token> fragment the worker redirected back with.
// Persists API creds (does NOT set Kr — call bootstrap() next). Returns true if consumed.
export function consumeGauth(hash) {
  const m = /[#&]gauth=([^.&]+)\.([^&]+)/.exec(hash || location.hash || '');
  if (!m) return false;
  saveAuth({ researcher_id: decodeURIComponent(m[1]), secret: decodeURIComponent(m[2]), google: true });
  return true;
}

// Bring a signed-in session up: GET /v1/researcher returns the server-held data key Kr (+ email +
// key store). Sets Kr (unlocks) and seeds the cache. Throws on an invalid session (401) → the panel
// should re-show "Sign in with Google".
export async function bootstrap() {
  const v = await api('GET', '/v1/researcher');
  if (!v.kr) throw new Error('no_kr');
  Kr = await importKeyB64(v.kr);
  settingsCache = safeParse(v.settings) || {};
  if (!settingsCache.wrappedKis) settingsCache.wrappedKis = {};
  if (!settingsCache.instanceSettings) settingsCache.instanceSettings = {};
  if (typeof v.settings_rev === 'number') settingsRev = v.settings_rev;
  kiCache = new Map();
  if (v.email) { const a = loadAuth(); if (a && a.email !== v.email) { a.email = v.email; saveAuth(a); } }
  approvedSelf = !!v.approved; ownerSelf = !!v.is_owner;
  setAccountMarker(currentAccountId());   // remember which account owns this browser's offline data (switch-guard)
  return { ok: true, email: v.email, approved: approvedSelf, isOwner: ownerSelf };
}

// Account-switch guard support: the current signed-in account id (from the session token) vs the sticky
// marker of the account that last owned this browser's offline data. The panel blocks a sign-in whose id
// differs from the marker (until the old data is erased), since offline data is origin- not account-scoped.
export function currentAccountId() { const a = loadAuth(); return (a && a.researcher_id) || null; }
export function lastAccountId() { try { return localStorage.getItem(LAST_ACCT_KEY) || null; } catch { return null; } }
function setAccountMarker(id) { try { if (id) localStorage.setItem(LAST_ACCT_KEY, id); } catch { /* noop */ } }

// Account status for the panel: approved = active (can manage devices); otherwise pending. owner =
// may approve other researchers. Set by bootstrap()/listView().
export function isApprovedSelf() { return approvedSelf; }
export function isOwnerSelf() { return ownerSelf; }

// Owner-only: approve / decline a pending researcher (request/approve onboarding).
export async function approveResearcher(researcherId) { return api('POST', '/v1/researcher/approve', { body: { researcher_id: researcherId } }); }
export async function declineResearcher(researcherId) { return api('POST', '/v1/researcher/decline', { body: { researcher_id: researcherId } }); }

// Self-delete THIS account + all its server data (instances/installs/invites/reset). Auth is the caller's
// own session token, so it can only ever delete the caller. The local offline wipe must run AFTER this
// succeeds (the wipe destroys the session token this call needs). retry:false — non-idempotent (a retried
// delete just 401s once the row is gone, which the caller treats as already-done).
export async function deleteAccount() { return api('POST', '/v1/researcher/delete', { body: {}, retry: false }); }

/* ---------------- account ---------------- */

export function accountEmail() { const a = loadAuth(); return a && a.email; }

/* ---------------- settings_blob (the researcher's encrypted key store) ---------------- */

function safeParse(s) { try { return typeof s === 'string' ? JSON.parse(s) : (s || null); } catch { return null; } }

async function fetchSettings() {
  const v = await api('GET', '/v1/researcher');
  settingsCache = safeParse(v.settings) || {};
  if (!settingsCache.wrappedKis) settingsCache.wrappedKis = {};
  if (!settingsCache.instanceSettings) settingsCache.instanceSettings = {};
  if (typeof v.settings_rev === 'number') settingsRev = v.settings_rev;
  return settingsCache;
}
// Optimistic-locked write: send the rev we last read so the server rejects (409) if another tab wrote
// in between, instead of silently clobbering its key store. Callers refetch + retry on 409.
async function putSettings() {
  const r = await api('PUT', '/v1/researcher/settings', { body: { settings: settingsCache, settings_rev: settingsRev } });
  if (typeof r.settings_rev === 'number') settingsRev = r.settings_rev;
  return r;
}

function requireUnlocked() { if (!Kr) throw new Error('locked'); }

// Unwrap an instance's Ki under Kr (cached). Loads the key store if needed. Throws
// 'no_key_for_instance' if absent.
async function getKi(instanceId) {
  requireUnlocked();
  if (kiCache.has(instanceId)) return kiCache.get(instanceId);
  if (!settingsCache) await fetchSettings();
  const wrapped = settingsCache && settingsCache.wrappedKis && settingsCache.wrappedKis[instanceId];
  if (!wrapped) throw new Error('no_key_for_instance');
  const ki = await unwrapKey(Kr, wrapped);
  kiCache.set(instanceId, ki);
  return ki;
}

/* ---------------- instances + invites ---------------- */

// Create a typed instance and mint its Ki, wrapped under Kr into the key store. The read-modify-write
// of the key store is optimistic-locked: on a 409 (a concurrent tab wrote first) we refetch the
// freshest blob and re-apply, so an instance's wrapped Ki can never be silently lost.
export async function createInstance(nickname) {
  requireUnlocked();
  const r = await api('POST', '/v1/instances', { body: { nickname }, retry: false }); // unified (no type); non-idempotent → don't risk a duplicate instance on a lost response
  const Ki = await generateKey();
  const wrapped = await wrapKey(Kr, Ki);
  try {
    for (let attempt = 0; ; attempt++) {
      await fetchSettings();                              // refresh blob + rev
      settingsCache.wrappedKis[r.instance_id] = wrapped;
      try { await putSettings(); break; }
      catch (e) { if (e.status === 409 && attempt < 4) continue; throw e; }
    }
  } catch (e) {
    // The instance row exists server-side but we couldn't persist its key (CAS exhaustion or a
    // transient PUT failure). Don't strand a keyless instance — best-effort revoke, then surface.
    try { await revokeInstance(r.instance_id); } catch { /* leave for manual cleanup */ }
    throw e;
  }
  kiCache.set(r.instance_id, Ki);
  return { instance_id: r.instance_id, type: r.type, nickname: r.nickname };
}

export async function renameInstance(instanceId, nickname) {
  return api('POST', `/v1/instances/${encodeURIComponent(instanceId)}/rename`, { body: { nickname } });
}

export async function mintInvite(instanceId, ttlSeconds) {
  const r = await api('POST', `/v1/instances/${encodeURIComponent(instanceId)}/invite`, { body: ttlSeconds ? { ttlSeconds } : {}, retry: false }); // non-idempotent: avoid minting duplicate invites
  return { invite_id: r.invite_id, secret: r.secret, expires_at: r.expires_at };
}

// Build the one-time field link. The secret rides the URL FRAGMENT (never sent to a
// server / not in request logs); the field client strips it on load.
export function inviteUrl(appBaseUrl, invite) {
  const base = String(appBaseUrl || '').replace(/[?#].*$/, '');
  return `${base}?invite=${encodeURIComponent(invite.invite_id)}#k=${encodeURIComponent(invite.secret)}`;
}

export async function revokeInstance(instanceId) {
  return api('POST', `/v1/instances/${encodeURIComponent(instanceId)}/revoke`, { body: {} });
}
export async function revokeInstall(instanceId, installId) {
  return api('POST', `/v1/instances/${encodeURIComponent(instanceId)}/installs/${encodeURIComponent(installId)}/revoke`, { body: {} });
}

/* ---------------- approve + deliver key (model A) ---------------- */

// Approve a pending install AND deliver Ki wrapped to its public key in one step (the
// common case). Pass the install's pubkey (from listView). Without a pubkey it approves
// only — deliverKey() can run later once the pubkey is known.
export async function approveInstall(instanceId, installId, installPubkeyB64) {
  await api('POST', `/v1/instances/${encodeURIComponent(instanceId)}/installs/${encodeURIComponent(installId)}/approve`, { body: {} });
  if (installPubkeyB64) await deliverKey(instanceId, installId, installPubkeyB64);
  return { ok: true };
}

export async function deliverKey(instanceId, installId, installPubkeyB64) {
  requireUnlocked();
  const Ki = await getKi(instanceId);
  const pub = await importPublicKeyB64(installPubkeyB64);
  const wrapped_key = await wrapKeyForInstall(pub, Ki);
  await api('POST', `/v1/instances/${encodeURIComponent(instanceId)}/installs/${encodeURIComponent(installId)}/key`, { body: { wrapped_key } });
  return { ok: true };
}

/* ---------------- commands (encrypted payloads) ---------------- */

// type (and id, when present) stay plaintext for the Worker's routing/validation; the
// whole sensitive payload is encrypted into `enc`. The field client decrypts before dispatch.
export async function pushCommand(instanceId, type, opts = {}) {
  requireUnlocked();
  const { id, ...payload } = opts;
  const Ki = await getKi(instanceId);
  const command = { type, enc: await encryptJSON(Ki, payload) };
  if (id) command.id = id;                                 // assign REQUIRES a plaintext id (worker §F.5)
  const r = await api('POST', `/v1/instances/${encodeURIComponent(instanceId)}/command`, { body: { command } });
  return { ok: true, seq: r.seq, desired_rev: r.desired_rev };
}

export function assign(instanceId, docId, fields) { return pushCommand(instanceId, 'assign', { id: docId, ...(fields || {}) }); }
export function deleteDoc(instanceId, docId)       { return pushCommand(instanceId, 'delete', { docId }); }
export async function changeSettings(instanceId, settings) {
  // Push the encrypted settings command to the device…
  const r = await pushCommand(instanceId, 'changeSettings', { settings });
  // …and persist a researcher-side ENCRYPTED snapshot (under Kr) so the panel can prefill the form
  // and gate invite-link creation on valid settings even before any device has reported back. The
  // Worker/D1 only ever see ciphertext. Optimistic-locked like createInstance, and best-effort: the
  // command already shipped, so a snapshot write failure must not surface as an error to the caller.
  try {
    const enc = await encryptJSON(Kr, settings);
    for (let attempt = 0; ; attempt++) {
      await fetchSettings();
      settingsCache.instanceSettings[instanceId] = enc;
      try { await putSettings(); break; }
      catch (e) { if (e.status === 409 && attempt < 4) continue; throw e; }
    }
  } catch { /* snapshot is best-effort */ }
  return r;
}

// The researcher-side decrypted settings snapshot for an instance (what was last pushed), or null if
// none has been pushed yet. Used to prefill the settings form and to validate before minting an
// invite. Decrypted in memory under Kr.
export async function getInstanceSettings(instanceId) {
  requireUnlocked();
  if (!settingsCache) await fetchSettings();
  const enc = settingsCache && settingsCache.instanceSettings && settingsCache.instanceSettings[instanceId];
  if (!enc) return null;
  try { return await decryptJSON(Kr, enc); } catch { return null; }
}
export function triggerUpload(instanceId, docId)  { return pushCommand(instanceId, 'triggerUpload', { docId }); }

/* ---------------- decrypted control-panel view ---------------- */

// One call that the panel renders: every instance with its installs, each install's
// inventory DECRYPTED with the instance's Ki. Routing fields stay as-is.
export async function listView() {
  requireUnlocked();
  const v = await api('GET', '/v1/researcher');
  approvedSelf = !!v.approved; ownerSelf = !!v.is_owner;          // keep status fresh for the panel
  if (v.settings) { settingsCache = safeParse(v.settings) || settingsCache; if (settingsCache && !settingsCache.wrappedKis) settingsCache.wrappedKis = {}; if (settingsCache && !settingsCache.instanceSettings) settingsCache.instanceSettings = {}; }
  if (typeof v.settings_rev === 'number') settingsRev = v.settings_rev;
  const instances = [];
  for (const inst of (v.instances || [])) {
    let Ki = null;
    try { Ki = await getKi(inst.instance_id); } catch { /* no Ki for this instance yet */ }
    const installs = [];
    for (const ins of (inst.installs || [])) {
      let inventory = null;
      if (Ki && ins.reported_blob) {
        // Worker JSON-stringifies whatever the install sent → the report is double-encoded:
        // parse to the ciphertext string, then decrypt.
        try { inventory = await decryptJSON(Ki, safeParse(ins.reported_blob)); }
        catch { inventory = { error: 'undecryptable' }; }
      }
      installs.push({
        install_id: ins.install_id, status: ins.status,
        accepted: Number(ins.accepted) === 1,                      // B: field user accepted this enrollment
        has_key: Number(ins.has_key) === 1, pubkey: ins.pubkey || null,
        ack_seq: ins.ack_seq, reported_rev: ins.reported_rev, last_seen_at: ins.last_seen_at,
        inventory,
      });
    }
    instances.push({ instance_id: inst.instance_id, type: inst.type, nickname: inst.nickname, desired_rev: inst.desired_rev, installs });
  }
  return { settings_rev: v.settings_rev, instances, isOwner: ownerSelf, pending: v.pending || [] };
}
