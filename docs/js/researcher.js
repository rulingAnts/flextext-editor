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
export function lock() { Kr = null; settingsCache = null; settingsRev = null; kiCache = new Map(); approvedSelf = false; ownerSelf = false; movesPlain = null; movesCipher = null; prefsPlain = null; prefsCipher = null; }
/* ⚠ Signing out now REVOKES THE SERVER SESSION as well as clearing local storage. That call used to
 * not exist here at all — the endpoint was unreachable dead code — which meant a "signed out"
 * browser's credential stayed valid until the next sign-in rotated it. It is only safe to wire up
 * because the worker no longer rotates researcher.secret_hash on sign-out (round-2 finding R2-3): on
 * a password account that column is the durable password verifier, and destroying it would have
 * locked the researcher out of their own account for good.
 * Fire-and-forget: the local half must succeed even offline, so a failed call costs the server row
 * (which expires on its own) and never the sign-out the user asked for. */
export function signOut() {
  try { api('POST', '/v1/researcher/signout', { body: {}, retry: false }).catch(() => {}); } catch { /* noop */ }
  lock();
  try { localStorage.removeItem(AUTH_KEY); sessionStorage.removeItem(AUTH_KEY); } catch { /* noop */ }
}

// Full local wipe of the researcher CONSOLE's footprint on this device: the session token, the
// "stay signed in" pref, the account marker, and the in-memory keys (Kr/Ki/inventory via lock()).
// That IS the console's entire persistent footprint — there is no researcher IndexedDB. Used on account
// DELETE and when the server reports the session is gone (401). Deliberately does NOT touch the Editor/
// Recorder apps' docs/audio or any app cache — those are separate; a deleted account's field bindings
// release themselves (the device's next poll gets 410 → it unlinks but keeps its texts).
export function purgeLocal() {
  lock();
  try {
    localStorage.removeItem(AUTH_KEY); sessionStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(STAY_KEY); localStorage.removeItem(LAST_ACCT_KEY);
  } catch { /* noop */ }
}

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
export function googleSignInUrl(returnTo, lang) {
  const base = (workerBaseFn() || '').replace(/\/+$/, '');
  /* Two hints the worker acts on, both absent-safe so an older worker simply ignores them:
   *   stay=0  — the user did NOT tick "stay signed in", i.e. told us this is not their machine, so
   *             the SERVER session gets 24 hours instead of 90 days. Sent only when it is 0; absent
   *             means the long window, which is what an older panel would have got anyway.
   *   lang    — writes the new-sign-in notice email in the panel's language. */
  const q = ['return=' + encodeURIComponent(returnTo || location.href.replace(/[?#].*$/, ''))];
  if (!staySignedIn()) q.push('stay=0');
  /* Language is PASSED IN rather than read here: this module is the auth/crypto layer and imports
   * only crypto.js, and re-reading i18n's storage key from here would duplicate a constant that
   * would then quietly drift the day it changes. The caller already knows the language. */
  if (String(lang || '').startsWith('id')) q.push('lang=id');
  return base + '/v1/oauth/google/start?' + q.join('&');
}

/* The DESIRED lane for one instance, read as the researcher: {type, desired_rev, settings, commands}.
 * This is how a panel learns which commands are still outstanding — server truth, so every signed-in
 * browser sees the same pending work rather than only the one that issued it. `since=-1` because the
 * route short-circuits to 204 when the caller is already up to date, and here we always want the body. */
export async function instanceDesired(instanceId) {
  return api('GET', '/v1/instances/' + encodeURIComponent(instanceId) + '?since=-1');
}

/* The outstanding commands for one instance, DECRYPTED.
 *
 * ⚠ THE WHOLE POINT IS THE DECRYPTION, and it is why this lives here rather than in the panel. A
 * stored command is `{type, enc, seq}`: pushCommand encrypts the payload under Ki, and ONLY `assign`
 * also carries a plaintext `id`, because the worker requires one for its own routing. So a docId for
 * triggerUpload or uploadDelete exists exclusively inside the ciphertext — reading `c.id` for those
 * finds nothing at all, which is precisely why pending uploads and deletes did not propagate between
 * panels while assigns did.
 *
 * The panel is entitled to this: it holds Ki. But Ki must not leave this module, so the decryption
 * happens here and the panel receives plain objects.
 *
 * A command that cannot be decrypted is SKIPPED rather than thrown on — a device re-keyed while a
 * command was outstanding leaves exactly that, and one unreadable entry must not cost the rest. */
export async function readDesiredCommands(instanceId) {
  const d = await instanceDesired(instanceId);
  const list = (d && d.commands) || [];
  if (!list.length) return [];
  const Ki = await getKi(instanceId);
  const out = [];
  for (const c of list) {
    let payload = {};
    if (c && c.enc) {
      try { payload = (await decryptJSON(Ki, c.enc)) || {}; } catch { continue; }
    }
    out.push({ ...payload, type: c && c.type, seq: c && c.seq, id: (c && c.id) || payload.docId || payload.id });
  }
  return out;
}

/* ---- sessions: the browsers signed in to this account (Phase A) ---- */
export async function listSessions() { return api('GET', '/v1/researcher/sessions'); }
export async function revokeSession(id) { return api('DELETE', '/v1/researcher/sessions/' + encodeURIComponent(id)); }
export async function revokeOtherSessions() { return api('POST', '/v1/researcher/sessions/revoke-others', { body: {} }); }

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

/* Pre-approved e-mail domains (OWNER only; the Worker enforces it too — never rely on the UI hiding
 * a control). Rows are stored as keyed hashes, so the domain itself is UNRECOVERABLE: listDomains
 * returns notes + hash prefixes only, and removing one means naming the domain again so the Worker
 * can re-derive its hash. testDomain is the honest check — it reports what WOULD happen and why. */
/* The append-only access-control history (owner only): who appeared, who was approved or declined,
 * which domains were added or removed. Read-only — there is deliberately no write or delete API. */
export async function listApprovals(limit) { return api('GET', '/v1/researcher/approvals' + (limit ? '?limit=' + limit : '')); }

export async function listDomains() { return api('GET', '/v1/researcher/domains'); }
export async function addDomain(domain, note) { return api('POST', '/v1/researcher/domains', { body: { domain, note } }); }
export async function testDomain(domain) { return api('POST', '/v1/researcher/domains/test', { body: { domain } }); }
export async function removeDomain(domain) { return api('POST', '/v1/researcher/domains/remove', { body: { domain } }); }

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
  return { instance_id: r.instance_id, type: r.type, nickname: r.nickname, estate: r.estate };   // estate: same enumerated-rebuild trap as listView()
}

export async function renameInstance(instanceId, nickname) {
  return api('POST', `/v1/instances/${encodeURIComponent(instanceId)}/rename`, { body: { nickname } });
}

export async function mintInvite(instanceId, ttlSeconds) {
  const r = await api('POST', `/v1/instances/${encodeURIComponent(instanceId)}/invite`, { body: ttlSeconds ? { ttlSeconds } : {}, retry: false }); // non-idempotent: avoid minting duplicate invites
  /* ⚠ PASS `estate` THROUGH. This wrapper enumerates fields rather than returning the response, so
   * a field added on the server is invisible to the panel until it is named here — which is
   * exactly what happened: the worker returned the instance's estate, this dropped it, and the
   * panel refused to build a link at all (Seth, 2026-08-05). */
  return { invite_id: r.invite_id, secret: r.secret, expires_at: r.expires_at, estate: r.estate };
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
// Remote WIPE (seized device): flags the device to fully erase itself on its next poll (NOT just unlink).
// totpCode is required + verified server-side only when the researcher has 2FA enabled (step-up auth on
// this destructive, irreversible, remote action). retry:false — non-idempotent intent (re-arming is fine,
// but don't auto-retry a destructive op on a flaky response).
export async function wipeInstall(instanceId, installId, totpCode) {
  return api('POST', `/v1/instances/${encodeURIComponent(instanceId)}/installs/${encodeURIComponent(installId)}/wipe`, { body: totpCode ? { totpCode } : {}, retry: false });
}
// Force-remove a seized device that never confirmed: hides it from the panel but KEEPS the wipe armed —
// if it ever reconnects it still wipes (the row is not deleted server-side).
export async function forceRemoveInstall(instanceId, installId) {
  return api('POST', `/v1/instances/${encodeURIComponent(instanceId)}/installs/${encodeURIComponent(installId)}/force-remove`, { body: {} });
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

/* The text's Drive folder listing — the source of truth for "what artifacts exist for this text".
 * Returns { folderId, files: [{id,name,size,mime,modified}] }, newest first; files:[] is the
 * normal state for a text nothing has been uploaded for, not an error. */
export function listTextFiles(instanceId, docId) {
  return api('GET', `/v1/instances/${encodeURIComponent(instanceId)}/texts/${encodeURIComponent(docId)}/files`);
}

/* Best-effort server-side copy of the assigned audio into the text's Drive folder. Called AFTER a
 * successful assign; a failure costs only the convenience copy, never the assignment. */
export function assignCopy(instanceId, docId, title, src) {
  return api('POST', `/v1/instances/${encodeURIComponent(instanceId)}/assign-copy`, { body: { docId, title, src } });
}

/* Raw bytes of one of the researcher's own app-created Drive files, as a Blob — for the panel's
 * download-all-as-ZIP builder. Not api(): that helper parses JSON, and this is a file body. */
/* `onProgress(receivedBytes)` streams the body instead of awaiting `.blob()`, so the panel can show
 * a transfer moving instead of a frozen screen (Seth, 2026-08-13: panel downloads "don't show up on
 * the browser download menu until they're finished" — the app is the only thing that can report
 * them, because the bytes are not a browser download until the whole Blob is handed over at the end).
 *
 * ⚠ NO TOTAL COMES BACK FROM HERE, deliberately. The worker sets content-length, but `v1Cors` has no
 * `Access-Control-Expose-Headers`, so a cross-origin reader cannot see it — and adding it would be a
 * worker change and a deploy for something the CALLER already knows: every call site has the file's
 * size from the Drive listing or the manifest. So the byte count is reported and the percentage is
 * computed by whoever has the denominator. Without onProgress the fast path is untouched. */
export async function fetchDriveFile(fileId, onProgress) {
  const a = (() => { try { return JSON.parse(sessionStorage.getItem(AUTH_KEY) || localStorage.getItem(AUTH_KEY)) || null; } catch { return null; } })();
  if (!a) throw new Error('not_signed_up');
  const base = (workerBaseFn() || '').replace(/\/+$/, '');
  const r = await fetch(`${base}/v1/researcher/drive-file/${encodeURIComponent(fileId)}`, {
    headers: { 'x-fx-researcher': a.researcher_id, 'x-fx-secret': a.secret },
  });
  if (!r.ok) throw new Error('file_fetch_failed_' + r.status);
  if (typeof onProgress !== 'function' || !r.body || typeof r.body.getReader !== 'function') return r.blob();
  const reader = r.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    // A throwing progress callback must never lose the transfer that is already half done.
    try { onProgress(received); } catch { /* noop */ }
  }
  return new Blob(chunks, { type: r.headers.get('content-type') || 'application/octet-stream' });
}

/* ---------------- assignment uploads (assign-by-upload, 2026-08-11) ----------------
 * The researcher picks the actual files; these stream them THROUGH the worker into
 * "<Device>/<Storyname>/assignment/" in their own Drive, then finish() mints the private
 * /v1/textfile URLs the assign command carries. Nothing is ever link-shared. */

const textsPath = (iid, docId) => `/v1/instances/${encodeURIComponent(iid)}/texts/${encodeURIComponent(docId)}`;

export function assignBegin(instanceId, docId, title, folderId) {
  return api('POST', textsPath(instanceId, docId) + '/assignment/begin', { body: { title, ...(folderId ? { folderId } : {}) } });
}
export function assignUploadStart(instanceId, docId, fields) {
  // retry:false — a lost response would open a second Drive session; the chunk loop's
  // session_gone restart is the recovery path, not a blind re-POST.
  return api('POST', textsPath(instanceId, docId) + '/assignment/upload/start', { body: fields, retry: false });
}
export function assignFinish(instanceId, docId, fields) {
  return api('POST', textsPath(instanceId, docId) + '/assignment/finish', { body: fields });
}

/* One chunk PUT (or a "bytes star/total" probe with a null body) — raw fetch, because api() is
 * JSON-only and this body is bytes (the fetchDriveFile precedent). Returns the same shape the
 * device's upload.js reads off its chunk relay: {done,fileId} | {received} | {gone} | {fail}. */
export async function assignUploadChunk(instanceId, docId, uploadId, range, body) {
  const a = loadAuth();
  if (!a) throw new Error('not_signed_up');
  const base = (workerBaseFn() || '').replace(/\/+$/, '');
  let r = null;
  try {
    r = await fetch(base + textsPath(instanceId, docId) + '/assignment/upload/chunk', {
      method: 'PUT',
      headers: {
        'x-fx-researcher': a.researcher_id, 'x-fx-secret': a.secret,
        'x-fx-upload': uploadId, 'x-fx-range': range,
        ...(body ? { 'content-type': 'application/octet-stream' } : {}),
      },
      body,
    });
  } catch { return { fail: true }; }
  const out = await r.json().catch(() => ({}));
  if (r.ok && out.done && out.fileId) return { done: true, fileId: out.fileId };
  if (r.ok && out.done === false) return { received: out.received || 0 };
  if (out.error === 'session_gone' || out.error === 'bad_upload') return { gone: true };
  return { fail: true };
}

/* The chunk loop — upload.js's _streamChunked, panel-side: 8 MiB slices, probe-first resume (Drive's
 * own byte count is the truth), session_gone → one fresh session, transient failures back off then
 * surface as a TRANSIENT error so the caller's queue re-enters later. part: { blob, name, mime,
 * kind, originalsFolderId?, streamId? }. onSession persists the session token into the caller's
 * queue record (resume across panel restarts); onProgress(sent, total) paints. Returns the fileId. */
/* CHUNK POLICY — the same AIMD the DEVICE's upload.js uses, which this loop was modelled on but
 * had flattened to a fixed 8 MiB. Two consequences of the flat size, both reported from the v337
 * test drive:
 *   1. Progress "hung at 0% and then suddenly jumped to finished". onProgress fires once per
 *      COMPLETED chunk, so any file under 8 MiB — every spoken consent prompt — was a single chunk
 *      and reported nothing until it was already done. Indistinguishable from a hang.
 *   2. A failing chunk retried at the SAME size. On a weak field connection that is the one thing
 *      you must not do: the retry is as likely to fail as the attempt was, and each failure costs
 *      the whole slice again.
 * Sizes are multiples of 256 KiB because Drive's resumable protocol requires it for every chunk but
 * the last. The opening guess is SIZE-AWARE (aim for ~8 slices) so a small file still shows
 * movement; AIMD then doubles it away on a fast link within a couple of chunks. */
const CHUNK_UNIT = 262144;                    // 256 KiB — Drive's required granularity
const CHUNK_MIN = 2 * CHUNK_UNIT;             // 512 KiB
const CHUNK_MAX = 32 * CHUNK_UNIT;            // 8 MiB — the previous fixed size, now the ceiling
const roundUnit = (n) => Math.max(CHUNK_UNIT, Math.floor(n / CHUNK_UNIT) * CHUNK_UNIT);
const shrinkChunk = (n) => Math.max(CHUNK_MIN, Math.floor(n / 2 / CHUNK_UNIT) * CHUNK_UNIT);
const openingChunk = (total) => Math.min(CHUNK_MAX, Math.max(CHUNK_MIN, roundUnit(total / 8)));

export async function assignUploadFile(instanceId, docId, part, { onProgress, onSession } = {}) {
  const total = part.blob.size;
  let chunkBytes = openingChunk(total);
  let streamId = part.streamId || null;
  for (let session = 0; session < 2; session++) {          // at most one session_gone restart per call
    if (!streamId) {
      const s = await assignUploadStart(instanceId, docId, {
        name: part.name, mime: part.mime, size: total,
        originalsFolderId: part.originalsFolderId || '', kind: part.kind,
      });
      streamId = s.uploadId;
      if (onSession) await onSession(streamId);
    }
    let waitMs = 2000, strikes = 0;
    while (strikes < 5) {
      const probe = await assignUploadChunk(instanceId, docId, streamId, `bytes */${total}`, null);
      if (probe.done) return probe.fileId;
      if (probe.gone) { streamId = null; if (onSession) await onSession(null); break; }
      if (probe.fail) { strikes++; await sleep(waitMs); waitMs = Math.min(waitMs * 2, 60000); continue; }
      let offset = probe.received || 0;
      let pushed = true;
      if (onProgress) onProgress(offset, total);      // paint the resumed position, not a stale 0%
      while (offset < total) {
        const size = Math.min(chunkBytes, total - offset);
        const t0 = Date.now();
        const res = await assignUploadChunk(instanceId, docId, streamId,
          `bytes ${offset}-${offset + size - 1}/${total}`, part.blob.slice(offset, offset + size));
        if (res.done) { if (onProgress) onProgress(total, total); return res.fileId; }
        if (res.gone) { streamId = null; if (onSession) await onSession(null); pushed = false; break; }
        if (res.fail) {
          chunkBytes = shrinkChunk(chunkBytes);       // halve, so the retry risks less than the attempt did
          strikes++; pushed = false;
          await sleep(waitMs); waitMs = Math.min(waitMs * 2, 60000);
          break;                                       // re-probe: Drive's own byte count is the truth
        }
        strikes = 0; waitMs = 2000;
        // Adapt to the measured pace, same thresholds as upload.js so the two behave alike.
        const secs = (Date.now() - t0) / 1000;
        if (secs < 15) chunkBytes = Math.min(CHUNK_MAX, chunkBytes * 2);
        else if (secs > 60) chunkBytes = shrinkChunk(chunkBytes);
        offset = res.received != null ? res.received : offset + size;
        if (onProgress) onProgress(offset, total);
      }
      if (!streamId) break;                                // dead session → outer loop opens a fresh one
      if (pushed && offset >= total) strikes++;            // all bytes sent, no done yet — the next probe resolves it
    }
    if (streamId) break;                                   // strikes exhausted on a LIVE session → hand back to the queue
  }
  const e = new Error('assign_upload_stalled');
  e.transient = true;                                      // the persisted session resumes on the next sweep
  throw e;
}

/* Withdraw a queued command the device has not picked up yet.
 * Throws on 409 `already_delivered` — a cancel that quietly failed would be worse than none, since
 * the researcher would walk away believing the request is off when the device is already acting. */
export function cancelCommand(instanceId, seq) {
  return api('POST', `/v1/instances/${encodeURIComponent(instanceId)}/command/cancel`, { body: { seq } });
}

export function assign(instanceId, docId, fields) { return pushCommand(instanceId, 'assign', { id: docId, ...(fields || {}) }); }
export function setDone(instanceId, docId, done)   { return pushCommand(instanceId, 'setDone', { docId, done: !!done }); }

/* Adopt an UNASSIGNED text onto a device: re-parents its folder out of Unassigned and mints the
 * same private streaming URLs the move flow uses. The caller then sends the assign command, exactly
 * as moveTextModal does — this is a real re-assignment, not just a folder tidy. */
export function adoptText(instanceId, docId, fields) {
  return api('POST', `/v1/instances/${encodeURIComponent(instanceId)}/texts/${encodeURIComponent(docId)}/adopt`, { body: fields });
}

/* Move a text's Drive half to another device: re-parents the folder, mints authed streaming URLs
 * for the content. The caller then assigns to the destination (same docId) and fires the
 * upload-first remove at the source once the destination reports the doc. */
export function moveText(instanceId, docId, fields) {
  return api('POST', `/v1/instances/${encodeURIComponent(instanceId)}/texts/${encodeURIComponent(docId)}/move`, { body: fields });
}

/* The Drive STORAGE estate: every text this app created, grouped by device, with per-text bytes,
 * plus the account's quota. One worker call; see buildDriveEstate for why that is enough. */
export function driveEstate() { return api('GET', '/v1/researcher/drive-estate'); }

/* Permanently delete the FlexText files ALREADY IN TRASH — the only thing that actually reclaims
 * quota, since usageInDriveTrash counts inside usage. Scoped to our own files by drive.file; this
 * is NOT "empty the user's Drive trash". retry:false — a lost response must not double-delete. */
export function drivePurge() { return api('POST', '/v1/researcher/drive-purge', { body: {}, retry: false }); }

/* Move the researcher's own app-created files to Drive TRASH (30-day recoverable — never a
 * permanent delete). The panel decides what; the Worker only enforces how. */
export function trashFiles(fileIds, note) {
  return api('POST', '/v1/researcher/trash', { body: { fileIds, note } });
}
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
/* ---------------- account-scoped panel state (shared across the researcher's browsers) ----------------
 *
 * ⚠ localStorage IS THE WRONG HOME FOR ANYTHING THAT DESCRIBES THE ACCOUNT rather than this browser.
 * An in-flight text MOVE was kept per-browser, and a move is two stages: assign to the destination,
 * then — once the destination REPORTS the text — fire the upload-first remove at the source. That
 * second stage ran only in the browser that started it, so closing that browser mid-move left the
 * text on BOTH devices indefinitely, while every other panel showed a live Move button on a text
 * already being moved and could start a second, conflicting move (Seth's audit, 2026-08-18 — the
 * same class as the pending-command bug fixed in v388).
 *
 * This rides `settings_blob`, which `listView()` ALREADY refreshes on every 12s dashboard poll, so
 * sharing the state costs no extra request at all.
 *
 * Encrypted under Kr like `instanceSettings`: the container JSON is server-readable, and which text
 * is moving between which devices is exactly the metadata this suite keeps as ciphertext.
 * Read-modify-write is optimistic-locked, so two panels transitioning at the same moment cannot
 * clobber one another — the loser refetches and re-applies. */
let movesPlain = null, movesCipher = null;

/* Account-level researcher PREFERENCES, same store and same reasoning. The assignment delivery TTL
 * lived in localStorage while its own comment called it "per-account", so a researcher who set 180
 * days in one browser went on minting 90-day assignments from the next — silently, because nothing
 * disagrees on screen until an assignment expires early. Anything a second panel would report
 * differently belongs here rather than in localStorage. */
let prefsPlain = null, prefsCipher = null;

export async function getPrefs() {
  requireUnlocked();
  if (!settingsCache) await fetchSettings();
  const enc = (settingsCache && settingsCache.prefs) || null;
  if (!enc) { prefsCipher = null; prefsPlain = {}; return prefsPlain; }
  if (enc === prefsCipher && prefsPlain) return prefsPlain;
  try { prefsPlain = (await decryptJSON(Kr, enc)) || {}; } catch { prefsPlain = {}; }
  prefsCipher = enc;
  return prefsPlain;
}

export async function setPref(key, value) {
  requireUnlocked();
  for (let attempt = 0; ; attempt++) {
    await fetchSettings();
    let cur = {};
    const enc = settingsCache.prefs;
    if (enc) { try { cur = (await decryptJSON(Kr, enc)) || {}; } catch { cur = {}; } }
    cur[key] = value;
    settingsCache.prefs = await encryptJSON(Kr, cur);
    try { await putSettings(); }
    catch (e) { if (e.status === 409 && attempt < 4) continue; throw e; }
    prefsPlain = cur; prefsCipher = settingsCache.prefs;
    return cur;
  }
}

/* The in-flight moves: { [docId]: { from, to, title, stage } }. Cheap to call on every render —
 * it decrypts only when the stored ciphertext has actually changed. */
export async function getMoves() {
  requireUnlocked();
  if (!settingsCache) await fetchSettings();
  const enc = (settingsCache && settingsCache.moves) || null;
  if (!enc) { movesCipher = null; movesPlain = {}; return movesPlain; }
  if (enc === movesCipher && movesPlain) return movesPlain;
  try { movesPlain = (await decryptJSON(Kr, enc)) || {}; } catch { movesPlain = {}; }
  movesCipher = enc;
  return movesPlain;
}

/* `mutate(current)` edits the map in place (or returns a replacement). The current value is re-read
 * INSIDE the lock, so a concurrent panel's stage transition is merged rather than lost. */
export async function updateMoves(mutate) {
  requireUnlocked();
  for (let attempt = 0; ; attempt++) {
    await fetchSettings();
    let cur = {};
    const enc = settingsCache.moves;
    if (enc) { try { cur = (await decryptJSON(Kr, enc)) || {}; } catch { cur = {}; } }
    const next = mutate(cur) || cur;
    settingsCache.moves = await encryptJSON(Kr, next);
    try { await putSettings(); }
    catch (e) { if (e.status === 409 && attempt < 4) continue; throw e; }
    movesPlain = next; movesCipher = settingsCache.moves;
    return next;
  }
}

export function triggerUpload(instanceId, docId)  { return pushCommand(instanceId, 'triggerUpload', { docId }); }
// Upload-first remote delete: the device uploads a fresh timestamped Drive copy, and only deletes the
// text once that upload is confirmed safe. Engine v94+ only — the panel gates the button on the
// install's reported engineVersion (an older engine would ignore or mis-handle the command).
export function uploadDelete(instanceId, docId)   { return pushCommand(instanceId, 'uploadDelete', { docId }); }

/* ---------------- crowd recorders (public crowd-source recording pages) ----------------
 * Deliberately NOT E2EE: the public recorder page is keyless, so it must be able to read its own
 * config (welcome + consent text) straight from the worker — these fields are server-readable by
 * design. Never put secrets in a crowd config; the panel warns the researcher likewise. */

export function crowdList() { return api('GET', '/v1/crowd'); }
export function crowdCreate(label, driveFolder, config) {
  return api('POST', '/v1/crowd', { body: { label, drive_folder: driveFolder, config }, retry: false });   // non-idempotent: don't risk a duplicate recorder on a lost response
}
export function crowdUpdate(id, patch) { return api('PUT', `/v1/crowd/${encodeURIComponent(id)}`, { body: patch }); }
export function crowdDelete(id) { return api('DELETE', `/v1/crowd/${encodeURIComponent(id)}`, { retry: false }); }   // non-idempotent (a retry after success would 404)
export function crowdSubmissions(id) { return api('GET', `/v1/crowd/${encodeURIComponent(id)}/submissions`); }

/* ---------------- Drive delivery (shared relay vs the researcher's own Drive OAuth) ---------------- */

export function driveStatus() { return api('GET', '/v1/researcher/drive'); }
export function driveTest() { return api('POST', '/v1/researcher/drive/test', { body: {}, retry: false }); }   // deterministic outcome — retrying just makes the button feel hung
// (No driveSetMode: delivery is always own-Drive-first with automatic relay fallback — no mode to switch.)

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
        wipe_state: ins.wipe_state || null, wipe_at: ins.wipe_at || null,   // remote-wipe lifecycle (panel renders pending/confirmed)
        inventory,
      });
    }
    /* ⚠ ENUMERATED REBUILD — a field the server adds is INVISIBLE to the panel until it is named
     * here. `estate` was dropped exactly this way and cost a wasted worker redeploy: the SQL, the
     * response and the panel all looked correct, because the loss happened in between (2026-08-05).
     * This is the SECOND time — mintInvite() below lost the same field the same way. Add new server
     * fields HERE as well as at the call site. */
    instances.push({ instance_id: inst.instance_id, type: inst.type, nickname: inst.nickname,
                     desired_rev: inst.desired_rev, estate: inst.estate, installs });
  }
  return { settings_rev: v.settings_rev, instances, isOwner: ownerSelf, pending: v.pending || [] };
}
