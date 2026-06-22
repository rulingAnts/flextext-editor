/* researcher.js — researcher-panel engine (the control side of the connectivity layer).
 *
 * The twin of sync.js: where sync.js is the FIELD install (polls, applies, reports),
 * this is the RESEARCHER (signs up, creates instances, mints invites, approves installs,
 * delivers keys, pushes commands, reads decrypted inventory). Pure engine — NO UI; the
 * panel calls these and renders. Mirrors the E1d harness, which proved every call live.
 *
 * E2EE (model A): a passphrase derives the master key Kr (PBKDF2). Each instance has a
 * random Ki, wrapped under Kr and stored in the researcher's D1 settings_blob (so the
 * researcher's OTHER devices unwrap it; the Worker never can). Ki reaches a field install
 * asymmetrically: the install sends a public key at claim, the researcher wraps Ki to it
 * (deliverKey), the Worker only relays ciphertext. Everything the Worker/D1 hold is
 * ciphertext except routing/auth fields (ids, secret hashes, *_rev, type).
 *
 * Threat note: the researcher's API auth secret IS persisted (localStorage) — like staying
 * logged in on their own device. Kr is NOT persisted (re-entered each session). So a stolen
 * researcher device grants API access but NOT plaintext: without the passphrase there's no
 * Kr → no Ki → reports stay opaque and no valid encrypted command can be forged.
 */

import {
  deriveKeyFromPassphrase, generateKey, wrapKey, unwrapKey,
  encryptJSON, decryptJSON, randomBytesB64,
  importPublicKeyB64, wrapKeyForInstall,
} from './crypto.js';

const AUTH_KEY = 'flextext-researcher-auth';
const VERIFIER = 'flextext-e2ee-verifier-v1';   // marker proving a passphrase derived the right Kr
const REQ_TIMEOUT_MS = 20000;

/* ---------------- module state ---------------- */

let workerBaseFn = () => '';
let Kr = null;                 // researcher master key (memory only; derived from passphrase)
let settingsCache = null;      // last-known settings_blob: { v, salt, verifier, wrappedKis:{} }
let kiCache = new Map();       // instance_id -> Ki CryptoKey (unwrapped under Kr)

export function init({ workerBase } = {}) { if (workerBase) workerBaseFn = workerBase; }

/* ---------------- auth creds (the researcher's API identity, on their own device) ---------------- */

function loadAuth() { try { return JSON.parse(localStorage.getItem(AUTH_KEY)) || null; } catch { return null; } }
function saveAuth(a) { localStorage.setItem(AUTH_KEY, JSON.stringify(a)); }

export function isSignedUp() { return !!loadAuth(); }
export function isUnlocked() { return !!Kr; }
export function lock() { Kr = null; settingsCache = null; kiCache = new Map(); }
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

/* ---------------- signup ---------------- */

// Self-serve, Turnstile-gated (fail-closed 503 if the Worker has no TURNSTILE_SECRET).
// Persists the returned auth creds; the caller still needs setupPassphrase()/unlock().
export async function signup(turnstileToken) {
  const r = await api('POST', '/v1/researcher', { auth: false, body: { turnstileToken } });
  saveAuth({ researcher_id: r.researcher_id, secret: r.secret });
  return { ok: true, researcher_id: r.researcher_id };
}

/* ---------------- settings_blob (the researcher's encrypted key store) ---------------- */

function safeParse(s) { try { return typeof s === 'string' ? JSON.parse(s) : (s || null); } catch { return null; } }

async function fetchSettings() {
  const v = await api('GET', '/v1/researcher');
  settingsCache = safeParse(v.settings) || {};
  if (!settingsCache.wrappedKis) settingsCache.wrappedKis = {};
  return settingsCache;
}
async function putSettings() { return api('PUT', '/v1/researcher/settings', { body: { settings: settingsCache } }); }

/* ---------------- passphrase → Kr ---------------- */

// First run on this account: create the salt + verifier under a fresh Kr. If the account
// is ALREADY initialized (e.g. set up on another device), this transparently unlocks instead.
export async function setupPassphrase(passphrase) {
  await fetchSettings();
  if (settingsCache.salt && settingsCache.verifier) return unlock(passphrase);
  const salt = randomBytesB64(16);
  const k = await deriveKeyFromPassphrase(passphrase, salt);
  settingsCache.v = 1;
  settingsCache.salt = salt;
  settingsCache.verifier = await encryptJSON(k, { v: VERIFIER });
  settingsCache.wrappedKis = settingsCache.wrappedKis || {};
  await putSettings();
  Kr = k; kiCache = new Map();
  return { ok: true };
}

// Re-derive Kr from the passphrase + stored salt, proving correctness via the verifier.
export async function unlock(passphrase) {
  if (!settingsCache) await fetchSettings();
  if (!settingsCache.salt || !settingsCache.verifier) return { ok: false, error: 'not_initialized' };
  const k = await deriveKeyFromPassphrase(passphrase, settingsCache.salt);
  try {
    const v = await decryptJSON(k, settingsCache.verifier);
    if (!v || v.v !== VERIFIER) return { ok: false, error: 'bad_passphrase' };
  } catch { return { ok: false, error: 'bad_passphrase' }; }
  Kr = k; kiCache = new Map();
  return { ok: true };
}

function requireUnlocked() { if (!Kr) throw new Error('locked'); }

// Unwrap an instance's Ki under Kr (cached). Throws 'no_key_for_instance' if absent.
async function getKi(instanceId) {
  requireUnlocked();
  if (kiCache.has(instanceId)) return kiCache.get(instanceId);
  const wrapped = settingsCache && settingsCache.wrappedKis && settingsCache.wrappedKis[instanceId];
  if (!wrapped) throw new Error('no_key_for_instance');
  const ki = await unwrapKey(Kr, wrapped);
  kiCache.set(instanceId, ki);
  return ki;
}

/* ---------------- instances + invites ---------------- */

// Create a typed instance and mint its Ki, wrapped under Kr into the key store.
export async function createInstance(type, nickname) {
  requireUnlocked();
  const r = await api('POST', '/v1/instances', { body: { type, nickname } });
  const Ki = await generateKey();
  await fetchSettings();                                  // merge into the freshest blob (single-researcher LWW)
  settingsCache.wrappedKis[r.instance_id] = await wrapKey(Kr, Ki);
  await putSettings();
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
