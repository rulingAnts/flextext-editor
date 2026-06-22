/* researcher.js — researcher-panel engine (the control side of the connectivity layer).
 *
 * The twin of sync.js: where sync.js is the FIELD install (polls, applies, reports),
 * this is the RESEARCHER (signs up, creates instances, mints invites, approves installs,
 * delivers keys, pushes commands, reads decrypted inventory). Pure engine — NO UI; the
 * panel calls these and renders. Mirrors the E1d harness, which proved every call live.
 *
 * Auth model: EMAIL + PASSWORD (the password never leaves the device). The researcher has a
 * random data key Kr; from password+salt the client derives a KEK (wraps Kr) and an authSecret
 * (the API credential — the server stores only its hash). Kr is ALSO escrow-wrapped to the
 * Worker's public key so a forgotten password can be recovered by email. Each instance has a
 * random Ki wrapped under Kr in the D1 settings_blob; Ki reaches a field install asymmetrically
 * (install sends a public key at claim, researcher wraps Ki to it; the Worker only relays
 * ciphertext). Everything the Worker/D1 hold is ciphertext except routing fields — plus, by
 * design (operator-recoverable, not zero-knowledge), the escrow copy of Kr.
 *
 * localStorage holds {researcher_id, secret(=authSecret), email, salt, wrappedKr}: API access and
 * OFFLINE unlock persist; the PASSWORD is never stored. Optional TOTP adds a second factor.
 */

import {
  deriveKeyFromPassphrase, deriveAuthSecret, generateKey, wrapKey, unwrapKey,
  importKeyB64, encryptJSON, decryptJSON, randomBytesB64,
  importPublicKeyB64, wrapKeyForInstall,
} from './crypto.js';

const AUTH_KEY = 'flextext-researcher-auth';
const REQ_TIMEOUT_MS = 20000;

/* ---------------- module state ---------------- */

let workerBaseFn = () => '';
let Kr = null;                 // the researcher's random DATA key (memory only); wraps every Ki
let settingsCache = null;      // last-known settings_blob: { wrappedKis:{} }
let settingsRev = null;        // its server rev, for optimistic-locked writes (anti silent clobber)
let kiCache = new Map();       // instance_id -> Ki CryptoKey (unwrapped under Kr)
let _resetKr = null;           // Kr recovered during a password reset, held between verify→confirm

export function init({ workerBase } = {}) { if (workerBase) workerBaseFn = workerBase; }

/* ---------------- auth creds (the researcher's API identity, on their own device) ---------------- */

function loadAuth() { try { return JSON.parse(localStorage.getItem(AUTH_KEY)) || null; } catch { return null; } }
function saveAuth(a) { localStorage.setItem(AUTH_KEY, JSON.stringify(a)); }

export function isSignedUp() { return !!loadAuth(); }
export function isUnlocked() { return !!Kr; }
export function lock() { Kr = null; settingsCache = null; settingsRev = null; kiCache = new Map(); }
export function signOut() { lock(); try { localStorage.removeItem(AUTH_KEY); } catch { /* noop */ } }

/* ---------------- low-level request (researcher-authed unless auth:false) ---------------- */

async function api(method, path, { headers = {}, body, auth = true } = {}) {
  const base = (workerBaseFn() || '').replace(/\/+$/, '');
  if (!base) throw new Error('no_worker_base');
  const h = Object.assign(body !== undefined ? { 'content-type': 'application/json' } : {}, headers);
  if (auth) {
    const a = loadAuth();
    if (!a) throw new Error('not_signed_up');
    h['x-fx-researcher'] = a.researcher_id; h['x-fx-secret'] = a.secret;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(base + path, {
      method, headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal, cache: 'no-store',
    });
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) { const e = new Error((data && data.error) || ('http_' + res.status)); e.status = res.status; e.data = data; throw e; }
    return data || {};
  } finally { clearTimeout(timer); }
}

/* ---------------- email + password auth ---------------- */

export function accountEmail() { const a = loadAuth(); return a && a.email; }
export function totpEnabledLocal() { const a = loadAuth(); return !!(a && a.totp_enabled); }

async function escrowPubkey() {
  const r = await api('GET', '/v1/escrow-pubkey', { auth: false });
  if (!r.pubkey) throw new Error('no_escrow_pubkey');
  return importPublicKeyB64(r.pubkey);
}
// From password+salt + a chosen Kr: the bits the server stores (wrappedKr, authSecret).
async function deriveAccount(password, salt, dataKey) {
  return {
    wrappedKr: await wrapKey(await deriveKeyFromPassphrase(password, salt), dataKey),
    authSecret: await deriveAuthSecret(password, salt),
  };
}

// Sign up: email + password (+ Turnstile). Generates Kr, wraps it under the password and the
// escrow key, registers, persists creds, leaves the account UNLOCKED.
export async function signup(email, password, turnstileToken) {
  const salt = randomBytesB64(16);
  const newKr = await generateKey();
  const { wrappedKr, authSecret } = await deriveAccount(password, salt, newKr);
  const escrowKr = await wrapKeyForInstall(await escrowPubkey(), newKr);
  const r = await api('POST', '/v1/researcher', { auth: false, body: { email, salt, authSecret, wrappedKr, escrowKr, turnstileToken } });
  saveAuth({ researcher_id: r.researcher_id, secret: authSecret, email, salt, wrappedKr });
  Kr = newKr; kiCache = new Map(); settingsCache = { wrappedKis: {} }; settingsRev = 0;
  return { ok: true };
}

// Log in (this or a new device): email + password (+ TOTP if enabled). Proves the password to the
// server, unwraps Kr locally, persists creds for offline unlock. Returns {ok:false, need:'totp'}
// when a code is required.
export async function login(email, password, totpCode) {
  const { salt } = await api('POST', '/v1/researcher/salt', { auth: false, body: { email } });
  const KEK = await deriveKeyFromPassphrase(password, salt);
  const authSecret = await deriveAuthSecret(password, salt);
  let r;
  try { r = await api('POST', '/v1/researcher/login', { auth: false, body: { email, authSecret, totpCode } }); }
  catch (e) {
    const code = e.data && e.data.error;
    if (e.status === 401 && code === 'totp_required') return { ok: false, need: 'totp' };
    if (e.status === 401 && code === 'bad_totp') return { ok: false, error: 'bad_totp' };
    if (e.status === 401) return { ok: false, error: 'bad_login' };
    throw e;
  }
  let newKr;
  try { newKr = await unwrapKey(KEK, r.wrapped_kr); } catch { return { ok: false, error: 'bad_login' }; }
  saveAuth({ researcher_id: r.researcher_id, secret: authSecret, email, salt, wrappedKr: r.wrapped_kr, totp_enabled: !!r.totp_enabled });
  Kr = newKr; kiCache = new Map(); settingsCache = null; settingsRev = null;
  return { ok: true };
}

// Offline unlock on a signed-in device: password → KEK(stored salt) → unwrap stored wrappedKr.
// No network; the AES-GCM tag proves the password.
export async function unlock(password) {
  const a = loadAuth();
  if (!a || !a.salt || !a.wrappedKr) return { ok: false, error: 'not_signed_in' };
  const KEK = await deriveKeyFromPassphrase(password, a.salt);
  let newKr;
  try { newKr = await unwrapKey(KEK, a.wrappedKr); } catch { return { ok: false, error: 'bad_password' }; }
  Kr = newKr; kiCache = new Map(); settingsCache = null; settingsRev = null;
  return { ok: true };
}

/* ---- password recovery (escrow) + TOTP ---- */

export async function requestReset(email, appBase) {
  await api('POST', '/v1/researcher/reset/request', { auth: false, body: { email, appBase } });
  return { ok: true };
}
// Step 1: token (+ TOTP) → recover Kr from escrow (held for the confirm step).
export async function verifyReset(token, totpCode) {
  try {
    const r = await api('POST', '/v1/researcher/reset/verify', { auth: false, body: { token, totpCode } });
    _resetKr = await importKeyB64(r.kr);
    return { ok: true };
  } catch (e) {
    const code = e.data && e.data.error;
    if (e.status === 401 && code === 'totp_required') return { ok: false, need: 'totp' };
    if (e.status === 401 && code === 'bad_totp') return { ok: false, error: 'bad_totp' };
    if (e.status === 401) return { ok: false, error: 'bad_token' };
    throw e;
  }
}
// Step 2: set a new password — re-wrap the recovered Kr (Kr unchanged → all data survives). The
// caller then logs in with the new password to establish full creds. The second factor is re-proven
// here too (the server re-gates /confirm on TOTP): pass the SAME code used at verify — verify→confirm
// is immediate, so a live TOTP is still in window and a backup code is still unused.
export async function confirmReset(token, newPassword, totpCode) {
  if (!_resetKr) return { ok: false, error: 'verify_first' };
  const salt = randomBytesB64(16);
  const { wrappedKr, authSecret } = await deriveAccount(newPassword, salt, _resetKr);
  try { await api('POST', '/v1/researcher/reset/confirm', { auth: false, body: { token, salt, authSecret, wrappedKr, totpCode } }); }
  catch (e) {
    const code = e.data && e.data.error;
    if (e.status === 401 && (code === 'totp_required' || code === 'bad_totp')) return { ok: false, error: 'bad_totp' };
    if (e.status === 401) return { ok: false, error: 'bad_token' };
    throw e;
  }
  _resetKr = null;
  return { ok: true };
}

export async function totpSetup() { return api('POST', '/v1/researcher/totp/setup', { body: {} }); }
export async function totpEnable(code) {
  const r = await api('POST', '/v1/researcher/totp/enable', { body: { code } });
  const a = loadAuth(); if (a) { a.totp_enabled = true; saveAuth(a); }
  return r;
}
export async function totpDisable(code) {
  const r = await api('POST', '/v1/researcher/totp/disable', { body: { code } });
  const a = loadAuth(); if (a) { a.totp_enabled = false; saveAuth(a); }
  return r;
}

// Change password while signed in + unlocked: re-wrap the SAME Kr under the new password (so all
// data survives + the escrow copy stays valid), push, and update local creds.
export async function changePassword(newPassword) {
  requireUnlocked();
  const salt = randomBytesB64(16);
  const { wrappedKr, authSecret } = await deriveAccount(newPassword, salt, Kr);
  await api('POST', '/v1/researcher/password', { body: { salt, authSecret, wrappedKr } });
  const a = loadAuth(); if (a) { a.salt = salt; a.secret = authSecret; a.wrappedKr = wrappedKr; saveAuth(a); }
  return { ok: true };
}

/* ---------------- settings_blob (the researcher's encrypted key store) ---------------- */

function safeParse(s) { try { return typeof s === 'string' ? JSON.parse(s) : (s || null); } catch { return null; } }

async function fetchSettings() {
  const v = await api('GET', '/v1/researcher');
  settingsCache = safeParse(v.settings) || {};
  if (!settingsCache.wrappedKis) settingsCache.wrappedKis = {};
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
export async function createInstance(type, nickname) {
  requireUnlocked();
  const r = await api('POST', '/v1/instances', { body: { type, nickname } });
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
  const r = await api('POST', `/v1/instances/${encodeURIComponent(instanceId)}/invite`, { body: ttlSeconds ? { ttlSeconds } : {} });
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
export function changeSettings(instanceId, settings) { return pushCommand(instanceId, 'changeSettings', { settings }); }
export function triggerUpload(instanceId, docId)  { return pushCommand(instanceId, 'triggerUpload', { docId }); }

/* ---------------- decrypted control-panel view ---------------- */

// One call that the panel renders: every instance with its installs, each install's
// inventory DECRYPTED with the instance's Ki. Routing fields stay as-is.
export async function listView() {
  requireUnlocked();
  const v = await api('GET', '/v1/researcher');
  if (v.settings) { settingsCache = safeParse(v.settings) || settingsCache; if (settingsCache && !settingsCache.wrappedKis) settingsCache.wrappedKis = {}; }
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
        has_key: Number(ins.has_key) === 1, pubkey: ins.pubkey || null,
        ack_seq: ins.ack_seq, reported_rev: ins.reported_rev, last_seen_at: ins.last_seen_at,
        inventory,
      });
    }
    instances.push({ instance_id: inst.instance_id, type: inst.type, nickname: inst.nickname, desired_rev: inst.desired_rev, installs });
  }
  return { settings_rev: v.settings_rev, instances };
}
