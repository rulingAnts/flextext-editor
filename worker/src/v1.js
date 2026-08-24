/* FlexText connectivity sync layer — /v1/* (Phase 0).
 *
 * ISOLATION (backward-compat mandate, plan Hardening §B): index.js dispatches
 * here BEFORE its global ?t=/origin gates, inside its own try/catch. So:
 *   - /v1/ has its OWN per-endpoint auth and NEVER depends on the public ?t= token.
 *   - any throw here (incl. a missing/failed env.DB binding) is caught by the
 *     caller and returned as a /v1/ error — it can never reach the /drive proxy.
 *   - every response is Cache-Control: no-store (never touches the /drive cache).
 *
 * Two-lane model: researcher writes `desired`, an install writes only its own
 * `reported` row. The Worker enforces ownership (no client can write `desired`
 * or another install's row). Metadata + pointers only — never audio/flextext bytes.
 */

import { secAlert, secLog, sendEmail } from './seclog.js';
import { teardownUnmigratedProjectRows } from './project-teardown.js';
import { stampDriveObject } from './drive-object.js';

/* ---------------- crypto + helpers ---------------- */

function randTok(n = 24) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* A six-digit pairing code — the number the device and the researcher panel both show, in large
 * type, until the pairing is approved on both ends.
 *
 * ⚠ MINTED HERE, NOT DERIVED FROM THE DEVICE'S KEY, and that is the point of the whole change. The
 * cheap version truncates the install's public-key fingerprint, which costs no schema and no deploy
 * ordering — and is weaker than the fingerprint it replaces: six digits is ~20 bits, so a device
 * wanting to be approved in place of the expected one can grind keypairs offline until its own
 * fingerprint starts with the same six digits. A worker-minted code is not something a device can
 * steer, and it belongs to exactly one pending pairing.
 *
 * ⚠ REJECTION SAMPLING, not `% 1000000`. The bias from folding 2^32 onto a million is small, but a
 * biased pairing code is a smaller keyspace than it claims to be, and "small enough not to matter"
 * is not a property anyone re-derives when they next read this. The loop discards the short tail
 * above the last whole multiple of 1e6 and is expected to run ~1.0002 times. */
function mintPairCode() {
  const LIMIT = Math.floor(0x100000000 / 1000000) * 1000000;
  const buf = new Uint32Array(1);
  let n;
  do { crypto.getRandomValues(buf); n = buf[0]; } while (n >= LIMIT);
  return String(n % 1000000).padStart(6, '0');
}

// Constant-time compare of equal-length strings (hashes/tokens).
function ctEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ---------------- auth-crypto helpers (email+password, escrow, TOTP, email) ---------------- */

function b64urlToBytes(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '==='.slice((t.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(buf) {
  let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function normEmail(e) { return String(e || '').trim().toLowerCase(); }

/* Researcher allowlist (A) + request/approve onboarding: env-listed emails are auto-approved
 * OPERATORS (they can approve others); anyone else signs in PENDING (inert) until an operator
 * approves them. isApproved() gates the privileged endpoints — operators always pass (even if their
 * row predates the `approved` column, since it checks the env list too).
 *
 * ⚠ NAMED `isOperator`, NOT `isOwner`, AND THE DISTINCTION IS ABOUT TO MATTER (project-split
 * II.0.9). This asks "is this email in ALLOWED_RESEARCHERS" — a DEPLOYMENT question about who
 * administers this installation. It has nothing to do with `project.owner_id`, which is a DATA
 * question about who owns one project and is the word Phase C is about to use everywhere.
 *
 * The design doc requires the rename BEFORE the word "owner" appears in project code, because the
 * two are easy to conflate and conflating them is a privilege bug in the direction that matters: an
 * operator check where a project-owner check belongs would let the deployment's admin act on a
 * project they do not own, and a project-owner check where an operator check belongs would let any
 * researcher approve accounts. Different questions, different answers, no shared vocabulary.
 *
 * ⚠ The WIRE value stays `not_owner`. It is an API response string, not an internal name, and no
 * client inspects it (grepped) — but changing a response shape for a rename would be a compat risk
 * taken for tidiness, which is the wrong trade. */
function isOperator(email, env) {
  const a = String(env.ALLOWED_RESEARCHERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return a.length > 0 && a.includes(normEmail(email));
}
function isApproved(r, env) { return !!(r && (r.approved || isOperator(r.drive_email, env))); }

// The domain of an address, for the approved_domain allowlist. Split on the LAST '@' (a local part
// may legally contain one) and lowercase. Returns '' for anything not address-shaped, which can
// never match a row because the column is a PRIMARY KEY and '' is not a domain anyone would list.
export function emailDomain(email) {
  const e = normEmail(email);
  const at = e.lastIndexOf('@');
  if (at < 1 || at === e.length - 1) return '';
  const d = e.slice(at + 1);
  // A domain has at least one dot and no whitespace/@; anything else is not a domain we will match.
  return (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) ? d : '';
}

// ⚠ THE ONE CATASTROPHIC MISCONFIGURATION THIS FEATURE ALLOWS. Adding a PUBLIC e-mail provider to
// approved_domain would auto-approve literally anyone on earth who can open a free mailbox — one
// INSERT and the entire approval gate is gone, silently, with no error to notice. It is an easy
// mistake to make: real researchers legitimately use gmail addresses (one already does), so
// 'gmail.com' looks like a reasonable thing to add. It is not.
//
// Refused in CODE, not just documented, because a comment in a .sql file cannot stop a 2am INSERT.
// Refusing costs nothing — the account simply falls back to manual approval, today's behaviour.
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.id', 'ymail.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'mail.com', 'zoho.com', 'yandex.com',
  'qq.com', '163.com', '126.com', 'naver.com', 'web.de', 'mail.ru',
]);

/* Append-only record of WHO was let in, WHEN and HOW (table: approval_log).
 *
 * ⚠ A FAILED AUDIT WRITE MUST NOT BREAK THE ACTION IT RECORDS — an owner must still be able to
 * approve a researcher when D1 is having a bad minute. But a silently-lost audit entry is its own
 * hazard, so the failure is pushed to the security log rather than swallowed outright: the event is
 * lost from the table and visible in Workers Logs, instead of vanishing entirely. */
async function logApproval(env, request, kind, subject, detail, actor) {
  try {
    await env.DB.prepare('INSERT INTO approval_log (at, kind, subject, detail, actor) VALUES (?,?,?,?,?)')
      .bind(Date.now(), kind, subject || null, detail || null, actor || null).run();
  } catch (e) {
    await secLog(env, request, 'approval_log_failed', { kind, message: String((e && e.message) || e).slice(0, 160) });
  }
}

// Exported for the unit test — the blocklist is an auth boundary and must be verifiable.
export function isPublicEmailDomain(email) { return PUBLIC_EMAIL_DOMAINS.has(emailDomain(email)); }

// Third onboarding tier: an ordinary (never owner) researcher whose e-mail domain the operator has
// pre-approved in D1. ⚠ EQUALITY, never a suffix/substring test — a suffix test would let
// 'evil-example.org' match 'example.org'. Subdomains are therefore NOT covered unless listed explicitly,
// which is the safe default for an auth boundary. Fails CLOSED: any DB error → not approved.
// Lookup key for a domain. HMAC (not a bare digest) because the set of real-world domains is small
// and enumerable — sha256('example.org') would fall to a wordlist instantly. Mirrors emailKey().
function domainKey(domain, env) { return hmacHex(env.SERVER_HMAC_KEY || '', 'domain:' + String(domain || '').toLowerCase()); }

async function isDomainApproved(email, env) {
  const d = emailDomain(email);
  if (!d || !env.DB) return false;
  if (PUBLIC_EMAIL_DOMAINS.has(d)) return false;   // never auto-approve a free-mailbox provider
  try {
    return !!(await env.DB.prepare('SELECT domain_hash FROM approved_domain WHERE domain_hash=?')
      .bind(await domainKey(d, env)).first());
  } catch { return false; }   // table not migrated yet, or D1 hiccup → fall back to manual approval
}

async function hmacHex(keyStr, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(keyStr)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(msg)));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
// Email lookup key — HMAC so a D1 dump can't confirm an address without SERVER_HMAC_KEY.
function emailKey(email, env) { return hmacHex(env.SERVER_HMAC_KEY || '', 'email:' + normEmail(email)); }

/* Stamp a drive_object row for a folder/file the worker just created — NEVER letting a stamping
 * failure break the Drive operation that succeeded. A missed stamp is not a hole: the object is
 * denied to members (fail-closed) until the Phase 2 backfill covers it, and the owner reaches it
 * through ownership regardless. So catch, log, and carry on. See worker/src/drive-object.js. */
async function stampFolder(env, fields) {
  try { await stampDriveObject(env.DB, { ...fields, now: fields.now || Date.now() }); }
  catch (e) { try { console.warn('drive_object stamp failed', String(fields && fields.objectId || '').slice(0, 40), String((e && e.message) || e).slice(0, 100)); } catch { /* noop */ } }
}

// AES-GCM key derived from SERVER_HMAC_KEY — encrypts email + TOTP secret AT REST (so a bare
// D1 dump leaks neither).
async function serverAesKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.SERVER_HMAC_KEY || ''));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function encAtRest(env, plaintext) {
  if (plaintext == null) return null;
  const key = await serverAesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(String(plaintext)));
  return bytesToB64url(iv) + '.' + bytesToB64url(ct);
}
async function decAtRest(env, token) {
  if (!token) return null;
  try {
    const [iv, ct] = String(token).split('.');
    const key = await serverAesKey(env);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlToBytes(iv) }, key, b64urlToBytes(ct));
    return new TextDecoder().decode(pt);
  } catch { return null; }
}

// ---- TOTP (RFC 6238 — HMAC-SHA1, 6 digits, 30s step, ±1 window) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, val = 0; const out = [];
  for (const c of clean) { const i = B32.indexOf(c); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { bits -= 8; out.push((val >> bits) & 0xff); } }
  return new Uint8Array(out);
}
function base32Encode(bytes) {
  let bits = 0, val = 0, out = '';
  for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out += B32[(val >> bits) & 31]; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
async function totpAt(secretBytes, counter) {
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const buf = new ArrayBuffer(8); const dv = new DataView(buf);
  dv.setUint32(0, Math.floor(counter / 2 ** 32)); dv.setUint32(4, counter >>> 0);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const off = sig[19] & 0xf;
  const code = ((sig[off] & 0x7f) << 24 | sig[off + 1] << 16 | sig[off + 2] << 8 | sig[off + 3]) % 1000000;
  return String(code).padStart(6, '0');
}
async function totpVerify(secretB32, code) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const secret = base32Decode(secretB32);
  const step = Math.floor(Date.now() / 30000);
  for (let w = -1; w <= 1; w++) if (ctEq(await totpAt(secret, step + w), c)) return true;
  return false;
}

// Verify a TOTP code OR consume a single-use backup code. Returns {ok, backupCodes?}.
async function verifySecondFactor(row, env, code) {
  if (!row.totp_enabled) return { ok: true };
  if (!code) return { ok: false };
  const secret = await decAtRest(env, row.totp_secret_enc);
  if (secret && await totpVerify(secret, code)) return { ok: true };
  // backup code (single-use): compare its hash, drop it on use
  const codes = row.backup_codes ? JSON.parse(row.backup_codes) : [];
  const h = await sha256hex(String(code).replace(/\s|-/g, '').toLowerCase());
  const idx = codes.indexOf(h);
  if (idx >= 0) { codes.splice(idx, 1); return { ok: true, backupCodes: codes }; }
  return { ok: false };
}

/* Origin allow-list matching, shared by the /v1 CORS headers and index.js's /drive gate.
 *
 * Entries are EXACT origins, the bare `*`, or a LEADING-STAR pattern matched by suffix:
 * `*-flextext-researcher.68mh29kgsd.workers.dev` accepts every Cloudflare PREVIEW ALIAS of that
 * app (`assign-by-upload-…`, `some-branch-…`) — because `deploy.sh` publishes any non-production
 * branch to `<branch>-<worker>.workers.dev`, and a feature branch tested on its own preview estate
 * is now the standard workflow for major work (CLAUDE.md).
 *
 * ⚠ The leading `-` in the pattern is load-bearing, and is why this is a suffix match rather than
 * a wildcard subdomain. `https://flextext-researcher.68mh29kgsd.workers.dev` (PRODUCTION) does NOT
 * end in `-flextext-researcher.…` — nothing precedes its name — so production origins still get NO
 * CORS header from the staging worker. That was the point of listing staging origins only: a field
 * device that somehow reaches this backend must fail loudly instead of quietly working. Previews
 * are additive to that property, not a hole in it.
 *
 * Only `[env.staging]` carries star entries. Production's list is exact origins, so its behaviour
 * is byte-identical to before this function existed. */
export function originAllows(list, origin) {
  if (!origin) return false;
  // A real browser origin only: scheme + host (+ port). Anything with a path/query is not an
  // Origin header value, and must never suffix-match its way in.
  if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) return false;
  for (const e of list) {
    if (e === '*' || e === origin) return true;
    // Star entries are HTTPS-only: an exact entry may name a plaintext dev origin
    // (http://localhost:8012 in .dev.vars), but nothing gets in by PATTERN over plaintext.
    if (e.startsWith('*') && e.length > 1 && origin.startsWith('https://') && origin.endsWith(e.slice(1))) return true;
  }
  return false;
}

function v1Cors(origin, env) {
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const h = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    // ⚠ EVERY custom request header the CLIENT sends must be listed here, or the browser's
    // preflight silently kills the request on EVERY origin — production included. v134 added
    // x-fx-doc/x-fx-doctitle to uploads without extending this list, which broke all browser
    // uploads until v142. When adding a header client-side, add it here in the same commit.
    'Access-Control-Allow-Headers': 'content-type, x-fx-researcher, x-fx-install, x-fx-secret, x-fx-invite-secret, x-fx-turnstile, x-fx-name, x-fx-mime, x-fx-doc, x-fx-doctitle, x-fx-folder, x-fx-sub, x-fx-role, x-fx-upload, x-fx-range, content-range',
  };
  // Reflect a known browser origin; curl/scripts send none → no ACAO needed.
  if (originAllows(list, origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function j(obj, status, origin, env) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: v1Cors(origin, env) });
}

async function readJson(req) {
  try { return await req.json(); } catch { return null; }
}

// Cloudflare Turnstile bot gate: verify the client widget's token server-side.
// Returns true only on a confirmed-human token. (TURNSTILE_SECRET is a Wrangler
// secret; the matching public site key lives in the client.)
async function verifyTurnstile(token, ip, env) {
  if (!token) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip || '' }),
    });
    const data = await r.json();
    return !!(data && data.success);
  } catch { return false; }
}

/* ---------------- sessions (Phase A of the researcher/project split) ----------------
 *
 * ONE RESEARCHER, SEVERAL BROWSERS. Until now a Google account's session token WAS
 * `researcher.secret_hash`, so every sign-in evicted the previous browser. Sessions are rows now;
 * the column keeps its OTHER job untouched (a password account's durable verifier).
 *
 * ⚠ THE CLIENT DOES NOT CHANGE. A session token is presented in exactly the header pair the panel
 * already sends — `x-fx-researcher` + `x-fx-secret` — so an old panel authenticates through the
 * legacy fallback below and a new one through a session row, against the same worker, with no
 * flag day. That is what makes this phase shippable on its own.
 */
const SESSION_CAP = 5;                              // browsers signed in at once; oldest is evicted
const SESSION_TTL_STAY = 90 * 24 * 60 * 60 * 1000;  // "stay signed in" ON — 90 days, slid on each use
/* ⚠ OFF IS THE DEFAULT, AND THAT IS THE DECISION, NOT AN OVERSIGHT (Seth, 2026-08-20). The failure
 * modes are asymmetric, which is what settles it: forgetting to TICK it costs a re-login, while
 * forgetting to UNTICK it on a machine that is not yours leaves a 90-day credential behind on it.
 * *"A researcher only needs to forget that once or twice and then they can check it. Better than
 * forgetting the other way when security is important."*
 *
 * ⚠ This line used to read "the user has told us this is not their machine" — which an UNTICKED
 * DEFAULT cannot support. Nobody told us anything; this is the safe assumption standing in until
 * they say otherwise, and the distinction matters to whoever next reasons about what the flag means.
 *
 * The client half is the same decision: `staySignedIn()` returns false when the key is absent, and
 * with it off the credential lives in sessionStorage — so it is gone when the tab closes, before any
 * server-side session is consulted. Two mechanisms, one policy. Do not flip either to make sign-in
 * stickier; a researcher asking for that can tick the box. */
const SESSION_TTL_TRANSIENT = 24 * 60 * 60 * 1000;

/* A coarse, human label — "Chrome on Windows". ⚠ The User-Agent is client-controlled and is being
 * actively reduced by browsers, so this is a HINT for recognising your own session in a list, never
 * evidence of anything. Deliberately crude: a precise parser here would rot and imply false rigour. */
function uaLabel(request) {
  const ua = request.headers.get('user-agent') || '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return (browser && os) ? `${browser} on ${os}` : (browser || os || 'Unknown browser');
}

/* Where the request came from, per Cloudflare's edge — NEVER the browser's geolocation API, so no
 * permission is ever requested (Seth's constraint). The network name is usually the line a person
 * actually recognises ("Telkomsel"), more than the city is. Fields absent on some plans/routes are
 * simply skipped rather than rendered as "undefined". */
function geoParts(request) {
  const cf = request.cf || {};
  return {
    place: [cf.city, cf.region, cf.country].filter(Boolean).join(', '),
    network: cf.asOrganization || '',
  };
}
function geoLabel(request) {
  const g = geoParts(request);
  return [g.place, g.network].filter(Boolean).join(' \u00b7 ');
}

/* Mint a session row and return its bearer token. The token is returned ONCE and never stored — the
 * row keeps only sha256 of it, exactly like an install secret. */
async function createSession(env, request, researcherId, stay) {
  const now = Date.now();
  const secret = randTok(24);
  const ttl = stay ? SESSION_TTL_STAY : SESSION_TTL_TRANSIENT;
  const ip = request.headers.get('CF-Connecting-IP') || '';
  await env.DB.prepare(
    'INSERT INTO session (session_id, researcher_id, secret_hash, created_at, last_seen_at, expires_at, ttl_ms, revoked, label, ip_enc, geo) '
    + 'VALUES (?,?,?,?,?,?,?,0,?,?,?)'
  ).bind(crypto.randomUUID(), researcherId, await sha256hex(secret), now, now, now + ttl, ttl,
         uaLabel(request), ip ? await encAtRest(env, ip) : null, geoLabel(request)).run();

  /* The cap, applied AFTER the insert so the browser signing in now is never the one evicted —
   * being pushed out of your own new sign-in would be indistinguishable from a broken login.
   * LIMIT -1 OFFSET n is SQLite's "everything past the first n". */
  await env.DB.prepare(
    'UPDATE session SET revoked=1 WHERE session_id IN ('
    + '  SELECT session_id FROM session WHERE researcher_id=? AND revoked=0'
    + '  ORDER BY last_seen_at DESC, created_at DESC LIMIT -1 OFFSET ?)'
  ).bind(researcherId, SESSION_CAP).run();
  return secret;
}

/* ---------------- auth (each lane proves its own identity) ---------------- */

async function authResearcher(req, env) {
  const id = req.headers.get('x-fx-researcher') || '';
  const secret = req.headers.get('x-fx-secret') || '';
  if (!id || !secret) return null;
  const row = await env.DB.prepare('SELECT * FROM researcher WHERE researcher_id=?').bind(id).first();
  if (!row) return null;
  const hash = await sha256hex(secret);

  /* SESSION LANE first. ⚠ THE RETURN SHAPE IS LOAD-BEARING (round-2 finding R2-5): ~56 call sites
   * read drive_refresh_enc / settings_blob / drive_email / approved / kr_server_enc straight off
   * this row. Sessions change only HOW the row is FOUND — never what comes back. */
  const now = Date.now();
  /* ⚠ THE TABLE MIGHT NOT BE THERE, and the blast radius decides how this is written. If the worker
   * were deployed before migrate-sessions.sql has run — the runbook forbids it, but a human under
   * pressure can get an order wrong — an uncaught "no such table" here would fail EVERY researcher
   * request: a total lockout. Catching it degrades to "sessions do not work yet, everything else
   * does", and the distinct log event names the missing migration instead of leaving someone to
   * guess. Deliberately NOT silent: silence would let the missing migration go unnoticed until
   * sessions mysteriously failed to persist. */
  let sess = null;
  try {
    sess = await env.DB.prepare(
      'SELECT session_id, secret_hash, expires_at, ttl_ms FROM session WHERE researcher_id=? AND revoked=0'
    ).bind(id).all();
  } catch (e) {
    await secLog(env, req, 'session_table_missing', { error: String((e && e.message) || e).slice(0, 120) });
  }
  for (const sn of (sess && sess.results) || []) {
    if (!ctEq(hash, sn.secret_hash)) continue;
    if (sn.expires_at && sn.expires_at <= now) return null;          // expired: not an auth, and not a fallback either
    /* Slide by the window this session was created with, so an actively used browser never has to
     * sign in again while a forgotten one still ages out. */
    await env.DB.prepare('UPDATE session SET last_seen_at=?, expires_at=? WHERE session_id=?')
      .bind(now, now + (sn.ttl_ms || SESSION_TTL_STAY), sn.session_id).run();
    row.session_id = sn.session_id;                                   // for signout / "this device" marking
    return row;
  }

  /* LEGACY FALLBACK — the pre-session credential. Keeps every already-installed panel working
   * during the window, and IS the password lane's permanent mechanism (its secret_hash is a
   * durable password verifier, not a session token). */
  if (!ctEq(hash, row.secret_hash)) return null;
  return row;
}

// Bind the install secret to the EXACT addressed row (Hardening §E.1): proves
// install A cannot touch install B, and a revoked device is rejected.
/* Who the PAIRING screen names to the field user: the researcher who MINTED the invite, resolved
 * through invite.invited_by — NOT the instance owner. The accept gate exists so the person being
 * linked can recognise WHO is linking them; when a project member enrols a device that is the
 * MEMBER, and instance.researcher_id is always the owner (a maintained denormalisation), so joining
 * on it would vouch for the wrong person. COALESCE falls back to the instance owner when invited_by
 * is NULL — every pre-migration invite, and every owner-minted one — which is the unchanged
 * behaviour. Identity IS returned here on purpose (unlike the pubkey lookup, which hides it): the
 * whole point of the gate is that the field user sees who is enrolling their device. */
async function pairingIdentity(env, inv) {
  const row = await env.DB.prepare(
    'SELECT n.type, r.display_name, r.avatar_url, r.drive_email FROM instance n '
    + 'JOIN researcher r ON r.researcher_id=COALESCE(?, n.researcher_id) WHERE n.instance_id=?'
  ).bind(inv.invited_by || null, inv.instance_id).first();
  return {
    type: row && row.type,
    researcher: row ? { name: row.display_name || '', avatar: row.avatar_url || '', email: row.drive_email || '' } : null,
  };
}

async function authInstall(req, env, instanceId, installId) {
  const secret = req.headers.get('x-fx-secret') || '';
  if (!secret) return null;
  const row = await env.DB.prepare(
    'SELECT * FROM install WHERE install_id=? AND instance_id=? AND revoked=0'
  ).bind(installId, instanceId).first();
  if (!row || !ctEq(await sha256hex(secret), row.secret_hash)) return null;
  return row;
}

/* VALIDATE CAPS BEFORE THEY ARE STORED, never on the way out.
 *
 * ⚠ authMember DENIES on caps it cannot parse, which makes an invalid record fail safe — but failing
 * safe at READ time means an owner can save a permission set that silently grants nothing, see no
 * error, and believe their assistant has access. The write is the only moment anyone is present to
 * be told. Validating in both places is not redundancy; they catch different failures.
 *
 * Returns a NORMALISED object or null. Normalising rather than passing the input through is what
 * stops unknown keys accumulating in the column — a future capability name would otherwise already
 * be present with a meaning nobody chose. */
/* ⚠ ONE LIST, CONSULTED ON BOTH THE WRITE AND THE READ PATH. It began as a local inside
 * validateCaps — a WRITE-time filter — and the completeness critic caught what that left open:
 * authMember never called validateCaps, so a project_member row already containing
 * {"drive":"manage"} or {"assignTexts":true} would still be honoured, reopening all nine same-root
 * findings. Such a row could arrive from a future migration, an operator's D1 console, or simply
 * from a build predating the deferral.
 *
 * The irony is that validateCaps' own comment argues the discipline this violated — "Validating in
 * both places is not redundancy; they catch different failures" — and the deferral was implemented
 * in exactly one of them. A write-path guarantee was being read as a system property.
 *
 * TO RE-ENABLE A CAPABILITY: remove its name here, once. Both paths follow.
 *
 * ⚠⚠ TWO DIFFERENT REASONS LIVE IN THIS ONE LIST, and confusing them would send the next person to
 * the wrong fix:
 *   · `assignTexts` / `drive` — the ROUTE IS NOT SAFE YET. Those routes still run account-wide Drive
 *     searches on a caller-supplied id. They come back when Drive access is resolved per project
 *     (VII.1's drive_object table). The capability is withheld because honouring it would be unsafe.
 *   · `cancelOthers` — the ROUTE IS FINE; the RULE IS NOT EXPRESSIBLE YET. The design wants
 *     cancelling your OWN queued command ungated (that is undo, not authority) and someone ELSE's
 *     gated on this capability. That needs every command to name its issuer, and commands recorded
 *     no author until `by` started being written (see the command-append route). Every command
 *     queued before then has none and cannot acquire one — nobody can reconstruct who issued a
 *     command after the fact — so splitting the rule now would treat the whole existing backlog as
 *     either "mine" or "someone else's", and BOTH answers are wrong.
 *
 * ⚠ WHY IT IS REFUSED RATHER THAN LEFT GRANTABLE-BUT-INERT (Seth, 2026-08-24). Until now the cancel
 * route gated on `manageDevices`, so ticking `cancelOthers` stored a capability that granted exactly
 * nothing. That is the failure this file's own rule names twenty lines below — "an owner who ticks
 * 'can assign texts' and is quietly given nothing believes their assistant has access they do not
 * have, and nothing will tell them otherwise until it matters". It applied to this key too, and the
 * whole point of a REFUSAL is that the owner finds out while someone is still present to be told.
 * Note the direction: it under-delivered authority, so nothing was ever over-granted by it.
 *
 * TO RE-ENABLE `cancelOthers`: remove it here, put it back in the grant loop and the unknown-key
 * list below, and split the cancel route on `cmd.by === ctx.caller.researcher_id` — with a decided
 * answer for authorless commands. By then the backlog predating `by` will have aged out, which is
 * what makes the question answerable rather than merely older. */
export const DEFERRED_CAPS = ['assignTexts', 'drive', 'cancelOthers'];

export function validateCaps(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  /* ⚠ THERE IS NO PER-DEVICE VISIBILITY LIST, and its absence is the decision (Seth, 2026-08-20):
   * *"I'm really not sure how granular we need our access to be at this point beyond project scope.
   * And if an owner researcher needs it to be more specific than that, all he or she has to do is
   * just create a separate project for that scope."*
   *
   * A `see` list was built first and removed on the same night, because it could not be made true.
   * Device routes could honour it, but Google Drive is addressed by FILE ID — a member restricted to
   * one device could still open another's files through any docId-routed Drive route. Keeping the
   * list would have meant a checkbox that SAYS a device is hidden while it is not, which is worse
   * than no checkbox: the owner would rely on it. The honest boundary is the one Drive can actually
   * enforce, and that is the project.
   *
   * So: membership in a project grants access to everything IN that project, and the capabilities
   * below say what may be DONE. Finer separation is a separate project — which is how Seth's own
   * estate is already arranged (Fayu Text Corpus and Dani Dictionary). */

  /* ⚠⚠ `assignTexts` AND `drive` ARE REFUSED IN v1, and this is remediation rather than caution.
   * The 2026-08-21 audit confirmed 17 findings; NINE of them share one root cause and every one of
   * those nine lives behind these two capabilities. Routes authorize the project correctly and then
   * act on a Drive text or file id supplied by the CALLER, resolved by a tag search across the
   * owner's ENTIRE Drive — so a member of one project could list, read, relocate or write into
   * another project's texts using the owner's Drive authority. See
   * plans/AUDIT-FINDINGS-2026-08-21.md.
   *
   * ⚠ The account-wide search is OLD, deliberate and documented (driveEnsureTextFolder: "the tag
   * search is scoped to trashed=false but NOT to the parent"). It was harmless while those routes
   * were owner-only. Converting them to authMember is what made it reachable by a member — the
   * conversion did not introduce the search, it removed the thing that made it safe. So the fix is
   * to stop handing out the capabilities that reach it, NOT to patch nine routes.
   *
   * ⚠⚠ THE DIVIDING LINE THIS ORIGINALLY CLAIMED IS FALSE, AND THE CORRECTION MATTERS MORE THAN THE
   * RULE. It read: "EVERY dangerous route is one where the member names a Drive file or text; EVERY
   * safe route works only from D1." The 2026-08-21 SWEEP disproved it within hours — `changeSettings`
   * names no Drive id at all, yet a member holding only manageDevices could use it to repoint a
   * field device's entire backend (see the guard on that route). The heuristic was seductive because
   * it explained all nine findings of the previous round; it was still wrong, and a rule that
   * explains the last outage is not thereby a rule about the next one.
   *
   * So: deferring assignTexts and drive closes the DRIVE-ID class specifically. It is not a proof
   * that what remains is safe, and nothing here should be read as one. manageDevices reaches the
   * command lane, which reaches the device's own settings, which is a control plane of its own.
   *
   * ⚠ REFUSED, NEVER SILENTLY DROPPED — the same rule as `see` and `wipe` below. An owner who ticks
   * "can assign texts" and is quietly given nothing believes their assistant has access they do not
   * have, and nothing will tell them otherwise until it matters.
   *
   * TO RE-ENABLE: they come back when Drive access is resolved per project rather than per account
   * (VII.1's drive_object table, which needs only project_id now that access is project-scoped).
   * Move the name from DEFERRED_CAPS back into the loop; the route-side gates already exist. */
  for (const k of DEFERRED_CAPS) {
    if (raw[k] !== undefined) return null;
  }

  for (const k of ['manageDevices', 'createInvites']) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== 'boolean') return null;   // a truthy STRING here would read as a grant
    if (raw[k]) out[k] = true;                      // store only what is granted; absent === false
  }
  /* ⚠ NO WIPE OR FORCE-REMOVE CAPABILITY EXISTS, and an attempt to grant one is an ERROR rather than
   * a silent drop. Those stay owner-only in v1 (round-1 finding 6); accepting the key and ignoring it
   * would tell an owner they had delegated something they had not. */
  for (const k of Object.keys(raw)) {
    if (!['manageDevices', 'createInvites'].includes(k)) return null;
  }
  return out;
}

/* ---------------- PROJECT AUTHORIZATION (Phase C) ----------------
 *
 * `authMember` is the ONE place that answers "may this researcher do this to this thing". II.4 calls
 * for one helper and one shape, and the reason is invariant I1: with two places to ask, the second
 * one is where the hole is.
 *
 * ⚠ IT DOES NOT RETURN A RESEARCHER ROW, and that is deliberate against the obvious alternative.
 * Making it drop-in compatible with `authResearcher` — hand back one row and let call sites carry on
 * — requires that row to be BOTH "whose Drive we act in" and "who is acting". For the owner those
 * are the same researcher, which is exactly why the conflation would survive every single-member
 * test and then mis-attribute every member action the day sharing ships. It is the same confusion
 * `isOwner` → `isOperator` was renamed to prevent, one layer down.
 *
 * So the two are named separately and a converted route says which it means:
 *   · `owner`  — the FULL researcher row of the project's owner. Whole-row on purpose: R2-5,
 *                `driveAccessToken(env, row)` and `verifySecondFactor(row, …)` take rows, and ~56
 *                call sites read fields straight off one. A synthesized object breaks them silently.
 *   · `caller` — the FULL researcher row of whoever is actually making the request, for attribution
 *                (`logApproval`, `wrapped_by`, command authorship). NEVER for Drive.
 *
 * ⚠ FAIL CLOSED (I4). Every unresolvable step — no such target, no project, no membership row,
 * unparseable caps, a missing table — DENIES. It never falls back to `researcher_id` scoping, which
 * would widen access at precisely the moment something is already wrong.
 *
 * ⚠ AND DENIAL IS INDISTINGUISHABLE FROM ABSENCE. `{ ok: false }` is returned whether the project
 * does not exist, the caller is not a member, or they lack the capability — so a route can answer
 * `not_found` for all three. A distinct "forbidden" would turn every endpoint into an oracle for
 * which project and instance ids exist.
 *
 * Returns:
 *   null                → not authenticated at all; the route answers 401, exactly as authResearcher
 *   { ok: false }       → authenticated but not authorized; the route answers not_found
 *   { ok: true, caller, owner, project_id, caps, isOwner, see }
 *
 * `target` is TYPED — `{ instance }`, `{ crowd }` or `{ project }` — never a bare id to be guessed
 * at. An auth boundary that infers what it was handed is one id-collision away from resolving the
 * wrong project.
 *
 * `needCap` is null (membership alone suffices — a read), a capability name (`manageDevices`,
 * `assignTexts`, `createInvites`, `cancelOthers`), or `drive:read` / `drive:manage`.
 */
export async function authMember(req, env, target, needCap) {
  const caller = await authResearcher(req, env);
  if (!caller) return null;                       // 401 — no identity at all
  const deny = { ok: false };

  /* Resolve the target's project. Each branch reads the project_id off the row that OWNS the
   * relationship, never off anything the caller sent. */
  let project_id = '';
  let legacyOwner = '';           // instance.researcher_id — see the dual-read branch below
  let addressedRow = false;       // did the target actually resolve to a row at all?
  try {
    if (target && target.instance) {
      /* ⚠ `allowRevoked` EXISTS FOR CLEANUP ROUTES ONLY, and it is opt-in because the default must
       * stay strict: a revoked device is unreachable, so resolving one would otherwise let an
       * authorized caller keep acting on a device that has been withdrawn.
       *
       * But REVOKING A KEY GRANT is an act on a LEDGER ROW, not on a device, and requiring the
       * device to be live made it impossible (2026-08-21 audit): revoke the phone and the owner
       * could no longer withdraw the grants held against it — the one case where you most want to.
       * The same applies to the retention work, which must delete grants for revoked instances.
       *
       * ⚠ EVERY CALL SITE THAT SETS IT MUST ALSO REQUIRE ctx.isOwner, and check-project-scoping.sh
       * enforces that. A capability must never reach a revoked device through this door. */
      const sql = 'SELECT project_id, researcher_id FROM instance WHERE instance_id=?'
        + (target.allowRevoked ? '' : ' AND revoked=0');
      const row = await env.DB.prepare(sql).bind(String(target.instance)).first();
      if (row) { addressedRow = true; project_id = row.project_id || ''; legacyOwner = row.researcher_id || ''; }
    } else if (target && target.crowd) {
      const row = await env.DB.prepare('SELECT project_id, researcher_id FROM crowd_recorder WHERE crowd_id=?')
        .bind(String(target.crowd)).first();
      if (row) { addressedRow = true; project_id = row.project_id || ''; legacyOwner = row.researcher_id || ''; }
    } else if (target && target.project) {
      project_id = String(target.project);
    }
  } catch { return deny; }

  /* ⚠ '' / NULL IS UNASSIGNED, NOT A PROJECT ID. Treating it as one would make every unassigned row
   * a member of a single shared pseudo-project — the same reading member_key's write path has warned
   * about since v435.
   *
   * ⚠⚠ BUT IT CANNOT SIMPLY DENY, AND THAT WOULD HAVE BROKEN PRODUCTION. `instance.project_id` is
   * filled lazily, on the owner's next panel load — 12 production rows were still NULL when this was
   * written, belonging to researchers who had not signed in since the backfill shipped. A route
   * converted to deny on NULL would lock those researchers out of their OWN devices, and the failure
   * would arrive silently, weeks later, for whoever had been away longest. This is the dual-read
   * window the design mandates ("researcher_id STAYS (dual-read window)", II.5 B).
   *
   * ⚠ AND IT DOES NOT WEAKEN I4, because of what it deliberately does NOT do: it consults
   * `project_member` not at all. The ONLY researcher it can ever authorize is the instance's own
   * `researcher_id`, which design-gap 4 pins as "a maintained denormalization: ALWAYS equal to the
   * project's owner_id". So the widest this branch reaches is exactly the pre-Phase-C behaviour for
   * that one row — a member can never arrive through it, which is the fall-through the plan forbids.
   * Fail-closed for everyone else, unchanged.
   *
   * It closes on its own: every lazy mint removes rows from it, and it is unreachable once none are
   * left. `legacy: true` rides the context so a route (or a diagnostic) can SAY it took this path
   * rather than leaving it to be inferred. */
  if (!project_id) {
    if (addressedRow && legacyOwner && legacyOwner === caller.researcher_id) {
      return { ok: true, caller, owner: caller, project_id: '', caps: {}, isOwner: true, legacy: true };
    }
    return deny;
  }

  const project = await env.DB.prepare('SELECT project_id, owner_id FROM project WHERE project_id=?')
    .bind(project_id).first().catch(() => null);
  if (!project || !project.owner_id) return deny;

  /* The owner's row is fetched even when the caller IS the owner, rather than reusing `caller`: it
   * keeps ONE definition of "the row Drive acts through", so a converted route cannot accidentally
   * work for the owner via a path that would be wrong for a member. */
  const owner = project.owner_id === caller.researcher_id
    ? caller
    : await env.DB.prepare('SELECT * FROM researcher WHERE researcher_id=?').bind(project.owner_id).first().catch(() => null);
  if (!owner) return deny;

  const isOwner = project.owner_id === caller.researcher_id;
  if (isOwner) {
    // The owner has no project_member row by construction (ownership is project.owner_id) and passes
    // every capability.
    return { ok: true, caller, owner, project_id, caps: {}, isOwner: true };
  }

  let member = null;
  try {
    member = await env.DB.prepare('SELECT caps FROM project_member WHERE project_id=? AND researcher_id=?')
      .bind(project_id, caller.researcher_id).first();
  } catch (e) {
    /* A missing table denies rather than throwing a 500 — but NOT silently. Same reasoning as the
     * session lane: the degraded behaviour must be survivable and the missing migration must be
     * visible, or it goes unnoticed until sharing mysteriously does not work. */
    try { await secLog(env, req, 'project_member_table_missing', { error: String((e && e.message) || e).slice(0, 120) }); } catch { /* noop */ }
    return deny;
  }
  if (!member) return deny;                       // not a member of this project

  let caps = null;
  try { caps = JSON.parse(member.caps || '{}'); } catch { caps = null; }
  // ⚠ Unparseable caps DENY. "Grant nothing" is the only safe reading of a permission record we
  // cannot read; defaulting to {} would be the same outcome by accident rather than by decision.
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) return deny;

  /* ⚠ NO PER-DEVICE CHECK HERE — see validateCaps. The project IS the boundary, so resolving the
   * target to this project (above) is the whole of the scoping. Anything narrower would have to be
   * enforceable in Drive too, and it is not. */

  /* ⚠ A STORED DEFERRED CAPABILITY DENIES THE WHOLE RECORD, at READ time, whatever the row says.
   * validateCaps refuses to WRITE these; this refuses to HONOUR them, and the two catch different
   * failures — the write path cannot police a row it did not write.
   *
   * Denying the entire context rather than masking the offending key is deliberate: a record that
   * should have been impossible is evidence something else is wrong, and quietly serving the rest of
   * it would hide that. No such row exists today, so nothing legitimate is refused; if one appears,
   * failing loudly is the outcome worth having. */
  for (const k of DEFERRED_CAPS) {
    if (caps[k] !== undefined) {
      try { await secLog(env, req, 'deferred_cap_in_stored_row', { project_id, cap: k }); } catch { /* noop */ }
      return deny;
    }
  }

  if (needCap) {
    const want = String(needCap);
    if (want === 'drive:read') {
      if (caps.drive !== 'read' && caps.drive !== 'manage') return deny;
    } else if (want === 'drive:manage') {
      if (caps.drive !== 'manage') return deny;
    } else if (!caps[want]) {
      return deny;
    }
  }
  return { ok: true, caller, owner, project_id, caps, isOwner: false };
}

/* ---------------- Drive delivery (crowd submissions + researcher OAuth) ----------------
 *
 * ONE delivery path (2026-07-13, the Apps Script relay upload leg is RETIRED):
 * Drive REST streaming with the researcher's OWN stored refresh token
 * (drive_refresh_enc, captured at Google sign-in), into worker-created folders
 * in THEIR Drive. A failure is flagged on the researcher row (drive_error) for
 * the panel; the CLIENT keeps + retries, so nothing is ever lost — it waits.
 */

// Mint a short-lived access token from the stored refresh token. e.code
// 'reconnect_needed' = invalid_grant (revoked / Testing-mode 7-day expiry /
// password change) → the fix is a fresh panel sign-in, not a retry.
async function driveAccessToken(env, row) {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    const e = new Error('oauth unconfigured'); e.code = 'oauth_unconfigured'; throw e;
  }
  const refresh = row && row.drive_refresh_enc ? await decAtRest(env, row.drive_refresh_enc) : null;
  if (!refresh) { const e = new Error('no Google Drive connection'); e.code = 'reconnect_needed'; throw e; }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: refresh, grant_type: 'refresh_token',
    }),
  });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok || !tok.access_token) {
    const e = new Error(tok.error_description || tok.error || ('HTTP ' + r.status));
    e.code = tok.error === 'invalid_grant' ? 'reconnect_needed' : 'token_failed';
    throw e;
  }
  return tok.access_token;
}

// Small JSON call against the Drive REST API. Distinguishes "Drive API not enabled
// on the Google Cloud project" (a one-time console fix) from ordinary errors.
/* Google's Drive and OAuth errors are useful for diagnosis and routinely EMBED IDENTIFIERS —
 * "File not found: 1AbC…", a folder id, sometimes an address. Those messages are returned to the
 * client and land in logs, so the identifier outlives the request in places nothing else does.
 * Keep the diagnostic shape ("File not found", "Rate limit exceeded"), drop the identifier.
 *
 * ⚠ Redacts by SHAPE, not by a list of known id formats: any long unbroken run of id-ish characters
 * goes, so a future Google message format cannot quietly reintroduce the leak. */
function safeErr(e) {
  let m = String((e && e.message) || 'error');
  m = m.replace(/[A-Za-z0-9_-]{24,}/g, '…');                       // ids, tokens, opaque handles
  m = m.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '…');                 // addresses
  return m.slice(0, 200);
}

async function driveJson(access, method, apiUrl, body) {
  const r = await fetch(apiUrl, {
    method,
    headers: { Authorization: 'Bearer ' + access, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const raw = JSON.stringify(data);
    const e = new Error((data.error && data.error.message) || ('HTTP ' + r.status));
    e.code = /accessNotConfigured|SERVICE_DISABLED/i.test(raw) ? 'drive_api_disabled' : 'drive_error';
    throw e;
  }
  return data;
}

// End-to-end proof the OAuth leg works RIGHT NOW: refresh→access token, create a
// tiny file (drive.file scope + Drive API enabled), delete it again (no clutter).
async function driveSelfTest(env, row) {
  const access = await driveAccessToken(env, row);
  const f = await driveJson(access, 'POST', 'https://www.googleapis.com/drive/v3/files?fields=id',
    { name: 'flextext-drive-test-' + Date.now() + '.txt', mimeType: 'text/plain' });
  try { await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(f.id), { method: 'DELETE', headers: { Authorization: 'Bearer ' + access } }); }
  catch { /* leftover marker file is harmless */ }
  return true;
}

// The researcher's single "FlexText Uploads" master folder — every streaming
// delivery lands in a subfolder of it, so nothing ever scatters across My Drive
// root. Found by an app-property tag (rename-proof, move-proof: the researcher
// may rename it or move it anywhere ONCE and all future deliveries follow — with
// drive.file, create-then-move IS the "choose a target folder" mechanism, since
// the scope cannot write into folders the app didn't create).
async function driveMasterFolder(access) {
  const q = encodeURIComponent("appProperties has { key='flextextRole' and value='uploads-master' } and mimeType='application/vnd.google-apps.folder' and trashed=false");
  try {
    const found = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files?spaces=drive&fields=files(id)&q=' + q);
    if (found.files && found.files.length) return found.files[0].id;
  } catch { /* fall through to create */ }
  const f = await driveJson(access, 'POST', 'https://www.googleapis.com/drive/v3/files?fields=id',
    { name: 'FlexText Uploads', mimeType: 'application/vnd.google-apps.folder', appProperties: { flextextRole: 'uploads-master' } });
  return f.id;
}

/* Every file this app created, one page at a time. Under `drive.file` scope that IS the whole
 * FlexText estate and nothing else, which is what makes the storage manager a couple of API calls
 * instead of one per text. Page count is bounded so a pathological account cannot spin the worker. */
async function driveListAll(access, trashed) {
  const out = [];
  let pageToken = '';
  for (let page = 0; page < 20; page++) {           // 20 x 1000 = 20k files, far beyond any real account
    const url = 'https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=1000'
      + '&fields=nextPageToken,files(id,name,size,mimeType,modifiedTime,parents,appProperties)'
      + '&q=' + encodeURIComponent('trashed=' + (trashed ? 'true' : 'false'))
      + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = await driveJson(access, 'GET', url);
    for (const f of res.files || []) out.push(f);
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  return out;
}

/* Group a flat Drive listing into the estate the panel renders. PURE — no network, no env — so
 * test/drive-estate.test.mjs can drive it directly with fixtures.
 *
 * The tree is: master "FlexText Uploads" > <Device> > <Storyname> > (originals|assignment) > files.
 * A text's byte total ROLLS UP its originals/ child, because to a researcher asking "what is this
 * text costing me" the source package is part of the text, not a separate thing. Folders themselves
 * contribute no bytes (Drive reports no size for them).
 *
 * `done` comes from the appProperties tag, never from the folder NAME — the name carries a visible
 * "(done)" suffix for a human browsing Drive, and nothing reads it, exactly as with <Storyname>. */
function buildDriveEstate(files) {
  const byId = new Map();
  for (const f of files || []) byId.set(f.id, f);
  const isFolder = (f) => (f.mimeType || '') === 'application/vnd.google-apps.folder';
  const roleOf = (f) => (f.appProperties && f.appProperties.flextextRole) || '';
  const parentOf = (f) => (Array.isArray(f.parents) && f.parents[0]) || '';

  const master = (files || []).find((f) => isFolder(f) && roleOf(f) === 'uploads-master');
  const masterId = (master && master.id) || '';
  /* ⚠ EXCLUDE STRUCTURAL FOLDERS. "Unassigned" also sits directly under master, so a filter that
   * only skipped text folders would list it as a DEVICE — and every text swept into it would then
   * appear to be held by a device called "Unassigned", which is the precise opposite of what it
   * means. Role-tagged folders are structure, never devices. */
  /* PROJECTS — a folder LAYER between master and the containers (plans/drive-as-truth.md §16.16).
   * Tree: master / <project> / <container> / <text> / originals. Found by role like every other
   * structural folder, so renaming or moving one changes nothing. */
  const projects = (files || []).filter((f) => isFolder(f) && roleOf(f) === 'project')
    .map((f) => ({ folderId: f.id, name: f.name || '' }));
  const projectIds = new Set(projects.map((p) => p.folderId));

  /* ⚠ THE DUAL-SHAPE HINGE, and it MUST include master unconditionally.
   *
   * §16.23 first proposed `projects.length ? projectIds : [masterId]` — swap the parent set once
   * projects exist. Writing the half-migrated fixture showed that is wrong in the one state the
   * migration actually passes through: the moment the FIRST project folder is created, every
   * container still sitting under master stops matching and DISAPPEARS from the estate — devices,
   * their texts, their byte totals, all of it — until the last re-parent completes. An interrupted
   * sweep would leave it that way indefinitely.
   *
   * Keeping master in the set costs nothing (a fully-migrated tree has no containers left directly
   * under it) and removes the branch entirely: one rule serves flat, nested and half-migrated. */
  const containerParents = new Set([masterId, ...projectIds]);

  /* Unassigned is per-PROJECT once projects exist, so this is a SET, not a singleton. The flat tree
   * simply yields a set of one. `unassignedFolderId` is still returned as a single value because a
   * shipped panel reads it (as a truthiness guard) and must keep working. */
  const unassignedIds = new Set((files || []).filter((f) => isFolder(f) && roleOf(f) === 'unassigned').map((f) => f.id));
  const unassignedId = [...unassignedIds][0] || '';
  /* CONTAINERS of texts: device folders and CROWD folders alike. A crowd recorder's folder holds
   * text folders exactly as a device's does (crowd submissions are born as texts — see
   * driveEnsureCrowdTextFolder), so it belongs in the same list rather than in a parallel one the
   * panel would have to merge. `kind` is what tells them apart where it matters, and it is what
   * lets the panel refuse a crowd container as an assignment DESTINATION: texts move OUT of a
   * crowd recorder, never into one.
   * ⚠ Crowd folders were listed here BY ACCIDENT before they carried a role tag (untagged + unroled
   * + under master is this filter's definition of a device). The behaviour is unchanged; what
   * changes is that it is now deliberate and survives anyone tagging the folder. */
  const devices = (files || []).filter((f) => isFolder(f) && containerParents.has(parentOf(f))
      && !(f.appProperties || {}).flextextDoc && (!roleOf(f) || roleOf(f) === 'crowd'))
    .map((f) => ({ folderId: f.id, name: f.name || '', kind: roleOf(f) === 'crowd' ? 'crowd' : 'device',
                   // '' on a flat tree — the field appears, and is empty, until projects exist.
                   projectId: projectIds.has(parentOf(f)) ? parentOf(f) : '' }));
  const deviceName = new Map(devices.map((d) => [d.folderId, d.name]));
  const crowdIds = new Set(devices.filter((d) => d.kind === 'crowd').map((d) => d.folderId));

  // Text folders are identified by their docId TAG, never by where they sit — a folder the
  // researcher moved elsewhere in Drive is still that text's folder.
  const textFolders = (files || []).filter((f) => isFolder(f) && (f.appProperties || {}).flextextDoc);
  const textByFolder = new Map(textFolders.map((f) => [f.id, f]));
  // The originals/ (legacy: assignment/) child maps back to its parent text for the roll-up.
  const rollUp = new Map();
  for (const f of files || []) {
    if (!isFolder(f)) continue;
    if (roleOf(f) !== 'originals' && roleOf(f) !== 'assignment') continue;
    const p = parentOf(f);
    if (textByFolder.has(p)) rollUp.set(f.id, p);
  }

  const acc = new Map();   // text folder id -> { bytes, files }
  for (const f of files || []) {
    if (isFolder(f)) continue;
    const p = parentOf(f);
    const target = textByFolder.has(p) ? p : rollUp.get(p);
    if (!target) continue;                          // a stray file outside any text folder
    const a = acc.get(target) || { bytes: 0, files: 0 };
    a.bytes += parseInt(f.size, 10) || 0;
    a.files += 1;
    acc.set(target, a);
  }

  const texts = textFolders.map((f) => {
    const a = acc.get(f.id) || { bytes: 0, files: 0 };
    const dev = parentOf(f);
    return {
      docId: (f.appProperties || {}).flextextDoc || '',
      folderId: f.id,
      title: String(f.name || '').replace(/\s*\(done\)\s*$/i, ''),   // display name without the marker
      deviceFolderId: deviceName.has(dev) ? dev : '',
      device: deviceName.get(dev) || '',
      // Born on a crowd recorder and still sitting in it. The panel uses this to say where a text
      // came from, and never to offer it a way back — crowd is a source, not a destination.
      fromCrowd: crowdIds.has(dev),
      // Where the folder ACTUALLY sits, so the panel can show the Drive truth and can tell which
      // texts still need sweeping from the ones already filed.
      inUnassigned: unassignedIds.has(dev),
      /* ⚠ WHICH PROJECT THIS TEXT IS IN — and it cannot be derived client-side, which is why its
       * absence made the per-project Unassigned card empty in EVERY tab. A text's container is its
       * parent; the container's parent is the project. For a text under a device or a crowd folder
       * the panel could just about have joined that itself, but for one sitting in a project's
       * `Unassigned` folder it never could: `deviceFolderId` is deliberately '' there (an Unassigned
       * folder is not a device), so there was nothing left to join on.
       *
       * Computed here because this is the only place that holds the whole tree. Additive: a field
       * appearing in a response that previously omitted it. */
      projectId: projectIds.has(parentOf(byId.get(dev) || {})) ? parentOf(byId.get(dev) || {}) : '',
      bytes: a.bytes,
      files: a.files,
      done: (f.appProperties || {}).flextextDone === '1',
      modified: f.modifiedTime || '',
    };
  }).sort((x, y) => y.bytes - x.bytes);             // biggest first: what a storage view is for

  /* ⚠ SHAPE-COMPATIBLE ON PURPOSE. `devices`, `texts` and `unassignedFolderId` keep their exact
   * meanings, so a panel shipped before projects existed renders precisely what it renders today —
   * containers flattened across projects. That is what makes deploying this worker before any folder
   * moves a verifiable no-op rather than a leap. New fields are additive and ignored by old readers. */
  return { master: masterId, devices, texts, unassignedFolderId: unassignedId,
           projects, unassignedFolderIds: [...unassignedIds] };
}

/* "FlexText Uploads / Unassigned" — where a text's folder LIVES once no device holds it.
 *
 * The panel could already COMPUTE unassigned-ness, but the Drive tree still showed the text under
 * whichever device used to have it, which is simply false to anyone browsing Drive. Same philosophy
 * as originals/ and the "(done)" suffix: the folder tree should describe the truth without our
 * tools. Tagged like every other structural folder so it is found by role, not by name. */
async function driveUnassignedFolder(access, projectFolderId) {
  /* ⚠ ONE PER PROJECT, NOT ONE PER ACCOUNT — and this had to change in the SAME commit as the
   * project layer, never after it. The previous version searched globally for role='unassigned' and
   * took the first hit; with a folder per project that is an ARBITRARY project's folder, so the
   * v399 sweep would have quietly moved texts out of their own project and into a sibling's.
   *
   * Parent-scoping is the same pattern driveEnsureChildFolder uses for `originals/`, and for the
   * same reason: this folder has no identity of its own, it belongs to whatever project it sits in.
   * With no project folder (the flat estate) the parent is master and the behaviour is exactly what
   * it was. */
  const parent = projectFolderId || await driveMasterFolder(access);
  const q = encodeURIComponent(`'${parent}' in parents and appProperties has { key='flextextRole' and value='unassigned' } and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  try {
    const found = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files?spaces=drive&orderBy=createdTime&fields=files(id)&q=' + q);
    if (found.files && found.files.length) return found.files[0].id;
  } catch { /* fall through to create */ }
  const f = await driveJson(access, 'POST', 'https://www.googleapis.com/drive/v3/files?fields=id',
    { name: 'Unassigned', mimeType: 'application/vnd.google-apps.folder',
      parents: [parent], appProperties: { flextextRole: 'unassigned' } });
  return f.id;
}

/* Re-parent one file/folder. Extracted from the move endpoint so the move, the unassign sweep and
 * the return-to-device path cannot drift apart. Idempotent: moving something to where it already is
 * is a no-op the caller checks for. */
async function driveReparent(access, fileId, toFolder, oldParents) {
  const rm = (oldParents || []).filter(Boolean).join(',');
  await driveJson(access, 'PATCH', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId)
    + '?addParents=' + encodeURIComponent(toFolder) + (rm ? '&removeParents=' + encodeURIComponent(rm) : '') + '&fields=id');
}

/* Post-upload housekeeping for a text folder: put it back under the uploading DEVICE if it had been
 * swept into Unassigned, and set/clear the done marker. ONE Drive read serves both.
 *
 * ⚠ Always called through ctx.waitUntil — see the call sites. Everything here is cosmetic or
 * organisational; the upload's job is the bytes, and none of this may delay or endanger it. The
 * return trip needs explicit code because driveEnsureTextFolder resolves a folder by id/tag and
 * NEVER by parent, so a text that came back to a device would otherwise live in Unassigned forever.
 * `want` is null for "no change" (old engines send no done-ness at all). */
async function driveTextHousekeeping(access, folderId, { want = null, deviceFolder = '', title = '' } = {}) {
  if (!folderId) return;
  try {
    const cur = await driveJson(access, 'GET',
      'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(folderId) + '?fields=id,name,parents,appProperties');
    const props = cur.appProperties || {};
    // RETURN TRIP: only ever moves it OUT of Unassigned, never re-files a folder the researcher
    // deliberately put somewhere else in their own Drive.
    if (deviceFolder && !(cur.parents || []).includes(deviceFolder)) {
      const unassigned = props.flextextUnassigned === '1';
      if (unassigned) {
        await driveReparent(access, folderId, deviceFolder, cur.parents);
        await driveJson(access, 'PATCH', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(folderId) + '?fields=id',
          { appProperties: { flextextUnassigned: '' } });
      }
    }
    if (want === null) return;
    if ((props.flextextDone === '1') === want) return;   // already right — no needless write
    const base = String(title || cur.name || '').replace(/\s*\(done\)\s*$/i, '').trim()
      || String(cur.name || '').replace(/\s*\(done\)\s*$/i, '').trim();
    await driveJson(access, 'PATCH',
      'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(folderId) + '?fields=id',
      { name: want ? base + ' (done)' : base, appProperties: { flextextDone: want ? '1' : '' } });
  } catch { /* cosmetic: never let housekeeping affect an upload */ }
}

/* PROJECT FOLDERS — the layer between master and the containers (plans/drive-as-truth.md §16.16).
 *
 *   FlexText Uploads / <Project> / <Device|Crowd|Unassigned> / <Text> / originals
 *
 * ⚠ EVERY HELPER HERE IS DUAL-SHAPE. Until a migration runs there are no project folders, and each
 * of these returns exactly what the pre-project code returned — so deploying them changes nothing
 * until folders actually move. That is what makes the deploy separable from the migration, and the
 * migration separately reversible.
 *
 * The DEFAULT project is tagged `flextextDefault:'1'` as well as `flextextRole:'project'`, so it is
 * findable without knowing its name — the researcher may rename it freely (Seth, 2026-08-19), and a
 * rename must not orphan anything. Name is display; the tags are identity. */
async function driveDefaultProjectFolder(access) {
  const q = encodeURIComponent("appProperties has { key='flextextDefault' and value='1' } and mimeType='application/vnd.google-apps.folder' and trashed=false");
  try {
    const found = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files?spaces=drive&orderBy=createdTime&fields=files(id)&q=' + q);
    if (found.files && found.files.length) return found.files[0].id;
  } catch { /* no default project yet — the flat shape */ }
  return '';
}

/* The project folder a given INSTANCE belongs under, or '' when the estate is still flat.
 * One device serves exactly one project (§16.16 B), so this is a single value, never a set. */
async function driveProjectFolderFor(env, access, projectId) {
  if (projectId) {
    const q = encodeURIComponent(`appProperties has { key='flextextProject' and value='${String(projectId).replace(/[^\w-]/g, '')}' } and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    try {
      const found = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files?spaces=drive&orderBy=createdTime&fields=files(id)&q=' + q);
      if (found.files && found.files.length) return found.files[0].id;
    } catch { /* fall through to the default */ }
  }
  return driveDefaultProjectFolder(access);
}

// Create (or find) the default project folder. `name` comes from the CLIENT so it can be localized —
// the worker has no idea what language the researcher reads.
async function driveEnsureDefaultProject(access, name) {
  const existing = await driveDefaultProjectFolder(access);
  if (existing) return existing;
  const f = await driveJson(access, 'POST', 'https://www.googleapis.com/drive/v3/files?fields=id',
    { name: String(name || 'Default Project').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 120) || 'Default Project',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [await driveMasterFolder(access)],
      appProperties: { flextextRole: 'project', flextextDefault: '1' } });
  return f.id;
}

// An enrolled DEVICE's folder in the researcher's Drive: "FlexText Uploads / <nickname>".
// Same semantics as the crowd folders: id-tracked (move/rename-proof), recreated if
// trashed. The panel's device-rename route renames the folder best-effort to match.
async function driveEnsureDeviceFolder(env, access, instanceId, nickname, existingId, projectFolderId) {
  if (existingId) {
    try {
      const f = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(existingId) + '?fields=id,trashed');
      if (f && f.id && !f.trashed) return existingId;
    } catch { /* fall through: recreate */ }
  }
  /* ⚠ THE ID CHECK ABOVE RUNS FIRST AND RETURNS WITHOUT EVER LOOKING AT A PARENT. That is what makes
   * the project migration invisible to every device that already has a folder: re-parenting keeps the
   * id, so this resolves exactly as before. Only a NEW folder needs to know about projects. */
  const name = String(nickname || '').trim() || ('Device — ' + String(instanceId).slice(0, 8));
  // ⚠ Same rule as a crowd folder: a RECREATED device folder goes back where it was, not into the
  // default project. `projectFolderId` (an explicit target, e.g. creating into the open tab) still
  // wins — that is a deliberate choice rather than a resurrection.
  const parent = projectFolderId || (await drivePriorProjectParent(access, existingId))
    || await driveMasterFolder(access);
  const f = await driveJson(access, 'POST', 'https://www.googleapis.com/drive/v3/files?fields=id',
    { name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] });
  await env.DB.prepare('UPDATE instance SET oauth_folder_id=? WHERE instance_id=?').bind(f.id, instanceId).run();
  /* Stamp it: one chokepoint covers every device-folder creation. project_id + owner come off the
   * instance row so the caller need not thread them; NULL project_id is a valid unassigned state. */
  const irow = await env.DB.prepare('SELECT project_id, researcher_id FROM instance WHERE instance_id=?').bind(instanceId).first();
  await stampFolder(env, { objectId: f.id, kind: 'device', instanceId, projectId: (irow && irow.project_id) || null, createdBy: irow && irow.researcher_id });
  return f.id;
}

/* ---------------- READING A ZIP WITHOUT DOWNLOADING IT ----------------
 *
 * Enumerate a remote zip's entries from its CENTRAL DIRECTORY, which lives at the END of the file.
 * Two small ranged reads (the tail, then the directory) give every entry's name, size and offset —
 * so each entry's bytes can then be fetched as its own range and streamed straight back out.
 *
 * ⚠ WHY THIS SHAPE. The alternative — walking local file headers from the front — requires reading
 * past every entry's DATA to reach the next header, i.e. downloading the whole file. A 26 MB
 * recording would have to pass through the worker just to learn what is beside it. Reading the tail
 * costs two requests regardless of how large the zip is.
 *
 * PURE and exported for test/zip-central-directory.test.mjs, which drives it with a zip built by our
 * own docs/js/zip.js — the writer and the reader tested against each other rather than against my
 * understanding of either.
 *
 * Zip64 is deliberately unhandled: zip.js refuses to write past 4 GiB (see its own note), so a file
 * needing Zip64 did not come from us. Such a zip yields no entries rather than wrong ones. */
export function parseZipCentralDirectory(tail, tailStartsAt) {
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  // EOCD is last, and may be followed by a comment — scan backwards for its signature.
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = u16(tail, eocd + 10);
  const cdSize = u32(tail, eocd + 12);
  const cdOffset = u32(tail, eocd + 16);
  // The directory must be inside the slice we hold, or the caller has to fetch more.
  const rel = cdOffset - tailStartsAt;
  if (rel < 0 || rel + cdSize > tail.length) return { need: { offset: cdOffset, length: cdSize } };
  const out = [];
  let p = rel;
  for (let n = 0; n < count && p + 46 <= rel + cdSize; n++) {
    if (u32(tail, p) !== 0x02014b50) break;
    const method = u16(tail, p + 10);
    const csize = u32(tail, p + 20);
    const nlen = u16(tail, p + 28);
    const elen = u16(tail, p + 30);
    const clen = u16(tail, p + 32);
    const localOffset = u32(tail, p + 42);
    const name = new TextDecoder().decode(tail.subarray(p + 46, p + 46 + nlen));
    out.push({ name, method, csize, localOffset });
    p += 46 + nlen + elen + clen;
  }
  return { entries: out };
}

/* Where an entry's DATA begins, given its local file header (30 bytes + name + extra).
 * ⚠ The local header's extra field can differ in length from the central one, so this must be read
 * from the LOCAL header — computing it from the central directory is the classic zip bug. */
export function zipDataStart(localHeader30, localOffset) {
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  if (u32(localHeader30, 0) !== 0x04034b50) return -1;
  return localOffset + 30 + u16(localHeader30, 26) + u16(localHeader30, 28);
}

/* Extract one entry's bytes from a STORE-only zip (method 0 — what our own zip.js writes; entry
 * data is an uncompressed byte slice after the local header). Scans local file headers only;
 * returns null when no entry name matches or any entry uses compression. Never used on foreign
 * zips: the caller only points it at files this suite uploaded. */
function storeZipEntry(buf, nameRe) {
  let i = 0;
  const u16 = (o) => buf[o] | (buf[o + 1] << 8);
  const u32 = (o) => (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0;
  while (i + 30 <= buf.length && u32(i) === 0x04034b50) {
    const method = u16(i + 8), csize = u32(i + 18), nlen = u16(i + 26), xlen = u16(i + 28);
    const name = new TextDecoder().decode(buf.subarray(i + 30, i + 30 + nlen));
    const dataStart = i + 30 + nlen + xlen;
    if (nameRe.test(name)) {
      if (method !== 0) return null;              // compressed entry — not ours, refuse
      return buf.subarray(dataStart, dataStart + csize);
    }
    i = dataStart + csize;
  }
  return null;
}

// A Drive file id out of whatever the panel stored for the assignment — the same three URL shapes
// index.js's driveId() and the client's driveIdFrom() accept, duplicated here because index.js does
// not export (it is the isolation boundary; importing across it would couple the lanes).
function driveIdOf(src) {
  const s = String(src || '').trim();
  let m = s.match(/drive\.google\.com\/file\/d\/([\w-]{10,})/);
  if (m) return m[1];
  m = s.match(/[?&]id=([\w-]{10,})/);
  if (m) return m[1];
  if (/^[\w-]{10,}$/.test(s)) return s;
  return null;
}

// A TEXT's folder inside its device folder: "FlexText Uploads / <nickname> / <title>".
// Found by an appProperties tag carrying the docId — the SAME rename/move-proof mechanism as the
// master folder, and deliberately NOT a D1 table: the docId is the identity, the name is display
// only (the researcher may rename the folder freely; retitling a text just leaves the old folder
// name, which is honest — the files in it were uploaded under that title).
// ⚠ The tag search is scoped to trashed=false but NOT to the parent: if the researcher moves a
// text folder elsewhere, uploads keep following it — mirroring the move-once behaviour of the
// master folder rather than silently forking a second folder.

async function driveEnsureTextFolder(access, deviceFolderId, docId, title, knownId) {
  const id = String(docId || '').replace(/[^\w-]/g, '').slice(0, 64);
  if (!id) return deviceFolderId;                       // no doc identity → old behaviour (device root)
  // A REMEMBERED id beats searching: files.get by id is STRONGLY consistent, while the tag
  // search below runs on Drive's eventually-consistent index — a folder created by the previous
  // upload can be invisible to search for minutes, which is how one text grew a new "Title (n)"
  // folder per upload (Seth's screenshot, 2026-08-04). The client echoes the folderId we returned
  // on its last upload; verify it still exists and is untrashed before trusting it.
  const known = String(knownId || '').replace(/[^\w-]/g, '').slice(0, 128);
  if (known) {
    try {
      const f = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(known) + '?fields=id,trashed');
      if (f && f.id && !f.trashed) return f.id;
    } catch { /* stale/foreign id → fall through to search */ }
  }
  const q = encodeURIComponent(`appProperties has { key='flextextDoc' and value='${id}' } and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  try {
    // createdTime order → among ALREADY-duplicated folders every upload picks the same (oldest)
    // one, so the duplication at least stops compounding even before a client echoes ids.
    const found = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files?spaces=drive&orderBy=createdTime&fields=files(id)&q=' + q);
    if (found.files && found.files.length) return found.files[0].id;
  } catch { /* fall through to create */ }
  const name = String(title || '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 120) || ('Text — ' + id.slice(0, 8));
  const f = await driveJson(access, 'POST', 'https://www.googleapis.com/drive/v3/files?fields=id',
    { name, mimeType: 'application/vnd.google-apps.folder', parents: [deviceFolderId], appProperties: { flextextDoc: id } });
  return f.id;
}

/* A tagged child folder under a KNOWN parent — used for "<Storyname>/originals/" (assign-by-
 * upload). Unlike the docId tag search above, this one IS parent-scoped: the assignment folder has
 * no identity of its own, it belongs to whatever text folder it sits in — so when the researcher
 * (or a move) re-parents the text folder, the child travels with it and the scoped search keeps
 * finding it. Create on miss. */
async function driveEnsureChildFolder(access, parentId, name, role) {
  const q = encodeURIComponent(`'${parentId}' in parents and appProperties has { key='flextextRole' and value='${role}' } and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  try {
    const found = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files?spaces=drive&orderBy=createdTime&fields=files(id)&q=' + q);
    if (found.files && found.files.length) return found.files[0].id;
  } catch { /* fall through to create */ }
  const f = await driveJson(access, 'POST', 'https://www.googleapis.com/drive/v3/files?fields=id',
    { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId], appProperties: { flextextRole: role } });
  return f.id;
}

/* Assignment-delivery TTL in days. The researcher configures it per account; the server clamp is
 * authoritative (a hand-edited localStorage value cannot mint a decade-long token). The TTL bounds
 * only the initial claim/download — files persist in device IndexedDB forever once fetched.
 * Exported for tests (worker-email-domain precedent). */
export function clampTtlDays(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return 90;
  return Math.min(Math.max(n, 7), 400);
}

// Mint a private, time-boxed streaming URL for GET /v1/textfile/<token>. Opaque (AES-GCM under
// SERVER_HMAC_KEY), bound to the researcher whose Drive it streams from; works from a plain
// header-less fetch, which is exactly how devices download assignment content. Same trust model
// as invite links. `extract` = 'flextext' pulls the .flextext entry out of a STORE-only zip.
/* A time-boxed URL that streams ONE Drive file through the worker, with no session and no cookie —
 * how a device fetches an assigned text or its audio.
 *
 * ⚠ SCOPE IT (`scope = { instanceId, docId }`). A v1 token names only the owner and the file, so
 * serving it checks nothing but "decrypts, unexpired, owner still has a Drive token" — which makes
 * it a bearer URL nothing can withdraw for as long as it lives. Passing a scope emits `v: 2`, and
 * the serve path then re-checks that the named instance still exists, is not revoked, and still
 * belongs to that researcher. **Revoking a device therefore kills its outstanding URLs**, which is
 * the property v1 was missing and the reason revoke did not fully mean what it appears to.
 *
 * Additive on purpose: scope is optional, and a v1 token minted before this change still serves
 * exactly as it did. TTL semantics are deliberately UNCHANGED here — shortening them is visible to
 * researchers who set a delivery window, so it is a separate decision, not a side effect of this. */
async function mintTextfileUrl(env, urlOrigin, researcherId, fileId, extract, ttlMs, scope, minterId) {
  if (!fileId) return null;
  /* ⚠ `n` AND `iat` ARE FREE NOW AND CANNOT BE ADDED LATER — not to tokens already in the field,
   * which is the whole point. Without a per-token id the only way to withdraw one URL is to revoke
   * its entire instance; with it, a future deny-list can retire a single leaked link. Both are
   * ignored by every client, which is why they cost nothing to carry from today. */
  const tk = { r: researcherId, f: fileId, x: extract || '', e: Date.now() + (ttlMs || 90 * 86400000),
               n: crypto.randomUUID(), iat: Date.now() };
  if (scope && scope.instanceId) { tk.v = 2; tk.i = scope.instanceId; if (scope.docId) tk.d = scope.docId; }
  /* ⚠ `m` — WHO MINTED THIS, recorded ONLY when that is not the Drive owner (invariant I2).
   * A member with assignTexts mints URLs into the OWNER's Drive and, having minted them, has seen
   * them. The token is otherwise self-standing: its contents are its whole authority, so removing
   * that member leaves them holding 90 days of read access to those files with no grant behind it.
   * Stamping the minter is what lets redemption ask whether the grant still stands.
   * Absent for owner-minted tokens, which is every token in the field today — so they are read
   * exactly as before rather than being invalidated by a deploy. */
  if (minterId && minterId !== researcherId) {
    /* ⚠ A MEMBER MAY NOT MINT AN UNSCOPED TOKEN. Redemption revokes a member-minted URL by resolving
     * the minter's grant, and it can only ask the PRECISE question — "are they still a member of the
     * project this instance belongs to" — when the token names an instance. Without one it could
     * only fall back to "a member of ANY project of this owner", so removing someone from the
     * project the file belongs to would leave the URL alive on the strength of an unrelated
     * membership (2026-08-21 audit).
     *
     * Refusing to mint is better than checking loosely at redemption: it removes the coarse path
     * rather than improving it, and it fails at the moment a person is present rather than silently
     * later. Owner-minted tokens are untouched — they carry no `m` at all. */
    if (!(scope && scope.instanceId)) return null;
    tk.m = minterId;
  }
  return urlOrigin + '/v1/textfile/' + encodeURIComponent(await encAtRest(env, JSON.stringify(tk)));
}

// The recorder's folder in the RESEARCHER'S Drive: "FlexText Uploads / Crowd — <label>".
// drive.file can only write to app-created files, so the worker creates (and
// remembers) the folder itself; a trashed/vanished folder is transparently
// recreated. The researcher may move/rename it — the id is what's tracked.
/* ⚠ WHERE A CONTAINER FOLDER USED TO LIVE — so recreating one does not silently relocate it.
 *
 * Both ensure-folder helpers recreate a trashed or missing folder under
 * `driveProjectFolderFor(rec.project_id)`, and `project_id` is ALWAYS NULL by design: Drive
 * parentage is the single authority for which project a container is in, so nothing writes it.
 * The fallback is therefore the DEFAULT project — meaning a recorder or device living in a second
 * project would be resurrected in the first, quietly, at the moment its folder was restored.
 *
 * Drive keeps a TRASHED file's parents, so the folder itself still knows. Read them from the fetch
 * that was already happening (one extra `fields` entry, no extra call) and reuse that parent when it
 * is still a project folder. Falls back to the old behaviour when the id is unknown or the parent has
 * gone too — never worse than before, and right in the case that actually occurs. */
async function drivePriorProjectParent(access, folderId) {
  if (!folderId) return '';
  try {
    const f = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files/'
      + encodeURIComponent(folderId) + '?fields=id,parents');
    const p = (f.parents || [])[0] || '';
    if (!p) return '';
    const par = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files/'
      + encodeURIComponent(p) + '?fields=id,appProperties,trashed');
    if (!par.trashed && ((par.appProperties || {}).flextextRole || '') === 'project') return par.id;
  } catch { /* unknowable — fall back to the default project, as before */ }
  return '';
}

async function driveEnsureCrowdFolder(env, access, rec) {
  if (rec.oauth_folder_id) {
    try {
      const f = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(rec.oauth_folder_id) + '?fields=id,trashed,appProperties');
      if (f && f.id && !f.trashed) {
        /* BACKFILL the role tag on folders created before crowd folders were tagged. Until this
         * existed, a crowd folder was untagged and unroled directly under master — which is
         * precisely buildDriveEstate's definition of a DEVICE, so every crowd recorder has been
         * listed as one by accident. It happened to look right; it was one stray appProperty away
         * from silently changing. One PATCH, once per folder, and only when it is missing. */
        if (((f.appProperties || {}).flextextRole || '') !== 'crowd') {
          try {
            await driveJson(access, 'PATCH', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(f.id) + '?fields=id',
              { appProperties: { flextextRole: 'crowd' } });
          } catch { /* cosmetic: an untagged folder still works, it just groups as a device */ }
        }
        return rec.oauth_folder_id;
      }
    } catch { /* fall through: recreate */ }
  }
  const name = 'Crowd — ' + (rec.label || String(rec.crowd_id).slice(0, 8));
  // Same rule as a device folder: a NEW crowd folder is born under its project; an existing one
  // resolves by id above and never consults a parent, so migration cannot disturb it.
  // ⚠ RECREATING one keeps it where it WAS (drivePriorProjectParent) rather than dropping it into
  // the default project — see that helper.
  const parent = (await drivePriorProjectParent(access, rec.oauth_folder_id))
    || (await driveProjectFolderFor(env, access, rec.project_id)) || await driveMasterFolder(access);
  const f = await driveJson(access, 'POST', 'https://www.googleapis.com/drive/v3/files?fields=id',
    { name, mimeType: 'application/vnd.google-apps.folder', parents: [parent],
      appProperties: { flextextRole: 'crowd' } });
  await env.DB.prepare('UPDATE crowd_recorder SET oauth_folder_id=? WHERE crowd_id=?').bind(f.id, rec.crowd_id).run();
  await stampFolder(env, { objectId: f.id, kind: 'crowd', instanceId: null, projectId: rec.project_id || null, createdBy: rec.researcher_id });
  return f.id;
}

/* A crowd submission's TEXT FOLDER — the same birth a device text gets, through the same helper.
 *
 * Seth, 2026-08-19: *"whenever a new recording is made and submitted, that should mirror how texts
 * are created in text folders on devices, exact same folder structure, reparenting, etc as much as
 * possible… And where we can use common code for both, that's a good idea. To avoid drift."*
 *
 * So this deliberately adds NO new Drive logic. It calls driveEnsureTextFolder exactly as the
 * device upload path does, with the crowd folder standing in for the device folder — which is what
 * makes every downstream behaviour work for free: the folder carries the `flextextDoc` tag, so the
 * estate view lists it as a text, /move and /adopt find it by tag, driveReparent re-homes it, and a
 * researcher who drags it elsewhere in Drive keeps ownership of it. A crowd twin of any of that is
 * exactly the drift the instruction is aimed at.
 *
 * ⚠ THE SUBMISSION ID IS THE DOC ID. One submission is one text, and sub_id is already the
 * submission's identity in D1 and in the upload ticket — so the correlation costs no column, and
 * there is no second identifier that could disagree with the first. */
function crowdTextTitle(rec, at) {
  /* ⚠ LABELLED UTC, because this name is generated SERVER-SIDE and the device-side names are NOT.
   * A `.flextext` filename is built from the transcriber's LOCAL clock (app.js), which is right for
   * them — they find their work by when they did it. This one is UTC, and at UTC+9 that is enough to
   * put the wrong DAY on anything recorded after 3 pm. Two conventions in one folder is survivable;
   * two conventions with nothing saying which is which is not.
   *
   * Interim fix by agreement (Seth, 2026-08-19) — the real answer is a researcher-set timezone for
   * everything the worker names. See plans/BACKLOG.md. The precedent for the suffix is secLog, which
   * already writes `… + ' UTC'`. */
  const stamp = new Date(at).toISOString().slice(0, 16).replace('T', ' ');
  return (String(rec.label || 'Crowd').trim().slice(0, 80)) + ' — ' + stamp + ' UTC';
}
async function driveEnsureCrowdTextFolder(env, access, rec, subId, at) {
  const crowdFolder = await driveEnsureCrowdFolder(env, access, rec);
  const textFolder = await driveEnsureTextFolder(access, crowdFolder, subId, crowdTextTitle(rec, at), '');
  // …/originals/, the same child a device's source package lands in. The submission zip and its
  // manifest go in there, not in the text folder root, so the two origins produce one shape.
  return { textFolder, originals: await driveEnsureChildFolder(access, textFolder, 'originals', 'originals') };
}

/* Lift the CLIENT-WRITTEN manifest out of a delivered submission zip and place it beside the zip in
 * originals/, so it is a real file in Drive rather than something you must unzip to read.
 *
 * ⚠ THE WORKER DOES NOT BUILD IT. The crowd page is this suite's own engine, so it writes the
 * manifest with the same buildSourceManifest the device and the panel use (seg-exports.js) and
 * ships it inside the zip. A worker-side copy of that contract would be a fourth writer of a
 * document whose whole value is that every writer agrees — the drift this move exists to prevent.
 * All this does is unwrap it. storeZipEntry only reads STORE-only zips, which is exactly what our
 * own zip.js writes, so a foreign or compressed zip simply yields null and nothing is written.
 *
 * Always called through ctx.waitUntil: the submission is already safely in Drive by this point, and
 * a manifest is organisational. It must never delay or endanger the bytes. */
/* UNPACK A DELIVERED CROWD SUBMISSION into individual role-tagged files, then remove the zip.
 *
 * This is plan §16.10 "B": a crowd text's folder ends up structurally identical to a device's, so
 * the Files modal, the manifest's completeness check and (later) assignment to a device all work
 * with no crowd-specific branch anywhere.
 *
 * ⚠ NOTHING IS BUFFERED. Each entry is fetched as its own byte RANGE and the response body is
 * streamed straight into a Drive upload. A 26 MB recording never exists in worker memory. That is
 * the whole reason this is feasible without changing the public submit protocol, which is keyed to
 * one zip per submission (Turnstile, budgets, a declared size Google enforces).
 *
 * ⚠⚠ THE ZIP IS DELETED ONLY WHEN EVERY ENTRY IS CONFIRMED PRESENT. Until then it is the only copy
 * of a stranger's recording, and this runs in ctx.waitUntil where a timeout is normal rather than
 * exceptional. So the order is: extract, VERIFY BY RE-LISTING, then trash — never extract-and-trust.
 * A partial run leaves the zip and some files; the next run skips what is already there and finishes.
 * Idempotent by construction, because "run again later" is the recovery path.
 *
 * Trashed, not deleted: recoverable for 30 days, and drive-purge stays the only thing that empties
 * trash (§17.1). */
async function crowdUnpackSubmission(env, access, originalsFolderId, fileId, zipBytes) {
  try {
    const ranged = async (from, to) => {
      const r = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media',
        { headers: { Authorization: 'Bearer ' + access, Range: `bytes=${from}-${to}` } });
      return (r.ok || r.status === 206) ? r : null;
    };
    // 1. The directory, from the tail. Two small reads at most, whatever the zip's size.
    const TAIL = Math.min(zipBytes, 65536);
    const tailRes = await ranged(zipBytes - TAIL, zipBytes - 1);
    if (!tailRes) return;
    let dir = parseZipCentralDirectory(new Uint8Array(await tailRes.arrayBuffer()), zipBytes - TAIL);
    if (dir && dir.need) {
      const more = await ranged(dir.need.offset, dir.need.offset + dir.need.length + 21);
      if (!more) return;
      dir = parseZipCentralDirectory(new Uint8Array(await more.arrayBuffer()), dir.need.offset);
    }
    if (!dir || !Array.isArray(dir.entries) || !dir.entries.length) return;

    // 2. What is already there — so a re-run costs nothing and cannot duplicate.
    const listed = await driveJson(access, 'GET',
      'https://www.googleapis.com/drive/v3/files?spaces=drive&fields=files(id,name)&q='
      + encodeURIComponent(`'${originalsFolderId}' in parents and trashed=false`));
    const present = new Set((listed.files || []).map((f) => f.name));

    /* Roles are taken from the manifest the CLIENT wrote, never guessed from filenames — a `.zip`
     * name says nothing about what is inside it, which is why this suite tags by role at all. */
    let roleFor = new Map();
    try {
      const mf = (listed.files || []).find((f) => f.name === 'flextext-manifest.json');
      if (mf) {
        const g = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(mf.id) + '?alt=media',
          { headers: { Authorization: 'Bearer ' + access } });
        const doc = g.ok ? await g.json() : null;
        /* From `files` — the manifest's declaration of what belongs in this folder, which after
         * unpacking IS these files. An earlier version read a separate `bundle` key that never
         * arrived: buildSourceManifest rebuilds its result by ENUMERATION, so an unrecognised key is
         * dropped silently. Same trap that ate `estate` twice; see the warning in researcher.js. */
        for (const e of (doc && doc.files) || []) if (e && e.name && e.role) roleFor.set(e.name, e.role);
      }
    } catch { /* no manifest roles — the files still land, just untagged */ }

    let wrote = 0, wanted = 0;
    for (const e of dir.entries) {
      if (e.name === 'flextext-manifest.json') continue;      // already extracted alongside the zip
      if (e.method !== 0) return;                             // not ours; refuse rather than corrupt
      wanted++;
      if (present.has(e.name)) continue;                      // idempotent
      const lh = await ranged(e.localOffset, e.localOffset + 29);
      if (!lh) return;
      const start = zipDataStart(new Uint8Array(await lh.arrayBuffer()), e.localOffset);
      if (start < 0) return;
      const body = await ranged(start, start + e.csize - 1);
      if (!body) return;
      const mime = /\.wav$/i.test(e.name) ? 'audio/wav' : /\.mp3$/i.test(e.name) ? 'audio/mpeg'
        : /\.m4a$/i.test(e.name) ? 'audio/mp4' : /\.json$/i.test(e.name) ? 'application/json'
        : /\.txt$/i.test(e.name) ? 'text/plain' : 'application/octet-stream';
      const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + access, 'content-type': 'application/json',
                   'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(e.csize) },
        body: JSON.stringify({ name: e.name, mimeType: mime, parents: [originalsFolderId],
                               ...(roleFor.get(e.name) ? { appProperties: { flextextRole: roleFor.get(e.name) } } : {}) }),
      });
      const session = init.ok ? init.headers.get('Location') : null;
      if (!session) return;
      // STREAMED: response body straight into the upload, never through a buffer.
      const put = await fetch(session, { method: 'PUT', headers: { 'content-type': mime }, body: body.body });
      if (!put.ok) return;
      wrote++;
    }

    /* 3. VERIFY, then remove. Re-list rather than trusting the loop's own bookkeeping: the check that
     * authorises deleting the only copy must read Drive, not our variables. */
    if (!wanted) return;
    const after = await driveJson(access, 'GET',
      'https://www.googleapis.com/drive/v3/files?spaces=drive&fields=files(name)&q='
      + encodeURIComponent(`'${originalsFolderId}' in parents and trashed=false`));
    const now2 = new Set((after.files || []).map((f) => f.name));
    const missing = dir.entries.filter((e) => e.name !== 'flextext-manifest.json' && !now2.has(e.name));
    if (missing.length) return;                               // keep the zip; a later run finishes
    await driveJson(access, 'PATCH', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?fields=id',
      { trashed: true });
    return wrote;
  } catch { /* organisational: a delivered submission must never be reported as failed */ }
}

const CROWD_MANIFEST_PEEK = 262144;                       // 256 KiB — the manifest is the FIRST entry
async function crowdExtractManifest(env, access, originalsFolderId, bytes, zipName, zipBytes) {
  try {
    const raw = storeZipEntry(bytes, /(^|\/)flextext-manifest\.json$/i);
    if (!raw || !raw.length) return;
    /* ⚠ VALIDATE BEFORE WRITING. On the chunked path `bytes` is a PREFIX of the zip, so a manifest
     * larger than the peek window would come back truncated — and storeZipEntry cannot tell, it
     * returns the slice the header declares. Parsing is the cheap check that the bytes are whole;
     * writing a half a JSON file would be worse than writing none, because a consumer would read
     * it as a corrupt manifest rather than an absent one. */
    const text = new TextDecoder().decode(raw);
    JSON.parse(text);                                   // validity check only — see above
    /* COMPLETE the one field the client could not know. The zip's filename is composed server-side
     * so a public visitor controls nothing about the Drive write, which means the client declares
     * its `crowd-submission` entry by ROLE with an empty name. Filling it here is what makes
     * `files` mean what the contract says it means — "the files that should be in this FOLDER" —
     * so the Files modal's declared-vs-present check works for a crowd text exactly as it does for
     * a device one.
     * ⚠ This COMPLETES a manifest; it does not author one. The worker still builds no manifest of
     * its own, and manifest-provenance.test.mjs still enforces that. */
    /* Written through UNCHANGED. The manifest declares the individual files the unpacker produces
     * (§16.10 B), so there is no server-composed zip name to fill in any more — and nothing else in
     * it is the worker's to touch. It stays the client's document. */
    await driveUpload(access, originalsFolderId, 'flextext-manifest.json',
      new TextEncoder().encode(text), 'application/json', { flextextRole: 'manifest' });
  } catch { /* organisational only — a submission that landed must not be reported as failed */ }
}

// The chunked path never holds the zip, so read back just the head of the delivered file and
// unwrap the manifest from that. One ranged GET, after the response, off the critical path.
async function crowdExtractManifestById(env, access, originalsFolderId, fileId, zipName, zipBytes) {
  try {
    const g = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media', {
      headers: { Authorization: 'Bearer ' + access, Range: 'bytes=0-' + (CROWD_MANIFEST_PEEK - 1) },
    });
    if (!g.ok && g.status !== 206) return;
    await crowdExtractManifest(env, access, originalsFolderId, new Uint8Array(await g.arrayBuffer()), zipName, zipBytes);
  } catch { /* organisational only */ }
}

// Drive resumable upload as one initiate + one PUT (fine for our ≤25 MB bodies).
async function driveUpload(access, folderId, name, buf, mime, appProperties) {
  const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + access, 'content-type': 'application/json',
      'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(buf.byteLength),
    },
    body: JSON.stringify({ name, mimeType: mime, ...(folderId ? { parents: [folderId] } : {}),
                           ...(appProperties ? { appProperties } : {}) }),
  });
  if (!init.ok) { const e = new Error('upload init HTTP ' + init.status); e.code = 'drive_error'; throw e; }
  const session = init.headers.get('Location');
  if (!session) { const e = new Error('Drive returned no upload session'); e.code = 'drive_error'; throw e; }
  const put = await fetch(session, { method: 'PUT', headers: { 'content-type': mime }, body: buf });
  const data = await put.json().catch(() => ({}));
  if (!put.ok || !data.id) { const e = new Error('upload PUT HTTP ' + put.status); e.code = 'drive_error'; throw e; }
  return data.id;
}

/* Relay ONE chunk (or a "bytes star/total" status probe) of a resumable upload to the Drive session in
 * `sess.u`. Shared by the device chunk endpoint and the researcher assignment/consent-prompt
 * endpoints — the WIRE contract is one and the same (x-fx-range in; 308 → {done:false,received},
 * 200 → {done:true,fileId}, dead session → session_gone). ⚠ Session-token OWNERSHIP is checked by
 * each caller BEFORE this runs, against a route-distinct key (`sess.i` = installId on the device
 * route, `sess.rr` = researcher_id on the researcher routes) — a token minted for one route can
 * never drive the other. Returns { status, body } for the caller's j(). */
async function relayDriveChunk(request, sess) {
  const range = request.headers.get('x-fx-range') || request.headers.get('content-range') || '';
  if (!/^bytes (\*|\d+-\d+)\/\d+$/.test(range)) return { status: 400, body: { error: 'bad_range' } };
  const probe = range.startsWith('bytes */');
  const chunk = probe ? null : await request.arrayBuffer();
  if (chunk && chunk.byteLength > 33 * 1024 * 1024) return { status: 413, body: { error: 'chunk_too_large' } };
  let fwd;
  try {
    fwd = await fetch(sess.u, { method: 'PUT', headers: { 'Content-Range': range }, body: chunk });
  } catch { return { status: 502, body: { error: 'drive_unreachable' } }; }
  if (fwd.status === 308) {
    const r = fwd.headers.get('Range');                     // "bytes=0-N" — absent = nothing landed yet
    const received = r ? parseInt(r.split('-')[1], 10) + 1 : 0;
    return { status: 200, body: { done: false, received } };
  }
  if (fwd.ok) {
    const data = await fwd.json().catch(() => ({}));
    if (data.id) return { status: 200, body: { done: true, fileId: data.id } };
    return { status: 502, body: { error: 'drive_error' } };
  }
  if (fwd.status === 404 || fwd.status === 410) return { status: 409, body: { error: 'session_gone' } };   // client restarts fresh
  return { status: 502, body: { error: 'drive_error' } };
}

// Flag a background Drive-delivery problem on the researcher row (the panel's
// Account → Drive delivery section surfaces it loudly; cleared by a passing test).
function noteDriveError(env, researcherId, msg) {
  return env.DB.prepare('UPDATE researcher SET drive_error=? WHERE researcher_id=?')
    .bind(JSON.stringify({ at: Date.now(), msg: String(msg || '').slice(0, 200) }), researcherId).run()
    .catch(() => { /* best effort */ });
}

/* ---------------- crowd recorder config ---------------- */

const CROWD_ASK = ['text', 'audio'];
const CROWD_CONFIRM = ['yesno', 'record', 'signature'];
// Server-side allow-list normalization of a recorder config. Everything in here is
// PUBLIC (the keyless crowd page reads it) — the drive_folder deliberately does NOT
// live in this object (mirror of the enrollment-exfil scoping fix: a public id must
// never unlock an upload target).
function normCrowdConfig(c) {
  const o = c && typeof c === 'object' ? c : {};
  return {
    welcome: String(o.welcome || '').slice(0, 2000),
    consentAsk: Array.isArray(o.consentAsk) ? o.consentAsk.filter((x) => CROWD_ASK.includes(x)) : [],
    consentConfirm: Array.isArray(o.consentConfirm) ? o.consentConfirm.filter((x) => CROWD_CONFIRM.includes(x)) : [],
    consentMsg: String(o.consentMsg || '').slice(0, 4000),
    consentAudioUrl: String(o.consentAudioUrl || '').slice(0, 1000),
    lang: o.lang === 'en' || o.lang === 'id' ? o.lang : 'id',
    // Recording format the public page captures in (engine falls back gracefully
    // on browsers that can't do lossless). Mind the 25 MB submit cap for lossless.
    recordFormat: ['mp3', 'opus', 'webmpcm', 'wav16', 'wav24', 'wav32', 'flac24'].includes(o.recordFormat) ? o.recordFormat : 'wav24',
    maxSeconds: Math.min(Math.max(parseInt(o.maxSeconds, 10) || 600, 10), 3600),
    turnstile: o.turnstile !== false,
  };
}

// Approx capture bytes/sec per format (mono 48 kHz worst-case). The submit cap is
// PEGGED to the recorder's own settings: estimate × 1.5 margin + overhead, clamped
// only by the platform's ~100 MB per-request ceiling (public submits are one POST).
const CROWD_BPS = { mp3: 8000, opus: 6000, webmpcm: 187500, wav16: 96000, wav24: 144000, wav32: 192000, flac24: 110000 };
function crowdMaxBytes(cfg) {
  const est = (CROWD_BPS[cfg.recordFormat] || 8000) * cfg.maxSeconds;
  return Math.min(Math.ceil(est * 1.5) + 512 * 1024, 2 * 1024 * 1024 * 1024);   // sanity ceiling; big takes CHUNK
}

function crowdParse(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

/* ---------------- router ---------------- */

/* The NEW-SIGN-IN notice. Exported and PURE so its wording is testable without a worker, a network
 * or Resend — the parts that can be wrong here are wording and detail, not plumbing.
 *
 * ⚠ THE SUBJECT LINE CARRIES THE WHOLE MESSAGE, deliberately. Seth's reason for wanting this at all:
 * "hopefully the user gets a notification on their smart phone that alerts them to the penetration
 * before the attacker can hide the evidence." A phone lock screen shows the subject and little else,
 * so the browser and the place go IN the subject — not buried in a body nobody unlocks to read.
 *
 * ⚠ And the limit that is stated rather than hidden: this mail goes to the researcher's Google
 * address, often the very account an attacker would have had to compromise to sign in. Seth, having
 * weighed it: "one more guard, not a sufficient replacement for other guards." Google and Apple send
 * these for the same reason — speed of alerting beats the imperfection of the channel. That is why
 * the in-panel banner and the revocable session list stay in the design beside it. */
export function signinNoticeEmail({ email, name, label, place, network, ip, when, lang }) {
  const id = lang === 'id';
  const account = name ? `${name} (${email || ''})`.trim() : (email || '');
  /* ⚠ SUBJECT BUDGET, ENFORCED RATHER THAN HOPED FOR. A phone notification shows the sender and then
   * roughly 50–70 characters of subject; the first version of this ran to 84 and the test caught it.
   * So the subject is built in PRIORITY ORDER and trimmed from the BACK until it fits:
   *   1. that it is a sign-in,   2. WHICH ACCOUNT — Seth's requirement, so it is the one part that
   *      is never dropped,       3. the browser,    4. the place.
   * The APP NAME is deliberately absent: it is the sender display name ("FlexText Researcher"),
   * which a notification shows in bold anyway, and leaving it out buys about twenty characters for
   * facts. The NETWORK never enters the subject — valuable, but it loses to all of the above.
   * The email alone identifies the account here; the friendly name lives in the body, where there
   * is room for both. */
  const LIMIT = 78;
  const head = (id ? 'Masuk baru' : 'New sign-in') + (email ? ': ' + email : '');
  let subject = head;
  for (const extra of [[label, place], [label], []]) {
    const tail = extra.filter(Boolean).join(', ');
    const candidate = head + (tail ? ' \u2014 ' + tail : '');
    if (candidate.length <= LIMIT) { subject = candidate; break; }
    subject = head;   // worst case: the account survives alone, which is the point
  }
  const rows = [
    [id ? 'Akun' : 'Account', account || (id ? 'tidak diketahui' : 'unknown')],
    [id ? 'Peramban' : 'Browser', label || (id ? 'tidak diketahui' : 'unknown')],
    [id ? 'Lokasi' : 'Location', place || (id ? 'tidak diketahui' : 'unknown')],
    [id ? 'Jaringan' : 'Network', network || (id ? 'tidak diketahui' : 'unknown')],
    /* The IP is shown IN FULL on purpose (Seth, 2026-08-17). A hash cannot answer the only question
     * the reader has — "is that me?" — and it is stored encrypted at rest, so showing it here adds
     * no standing record anywhere. */
    ['IP', ip || (id ? 'tidak diketahui' : 'unknown')],
    [id ? 'Waktu' : 'Time', when],
  ];
  const html = '<p>' + (id
    ? 'Seseorang baru saja masuk ke akun peneliti FlexText Anda.'
    : 'Someone just signed in to your FlexText Researcher account.') + '</p>'
    + '<table cellpadding="4" style="border-collapse:collapse;font:14px system-ui">'
    + rows.map(([k, v]) => `<tr><td style="color:#667">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')
    + '</table><p>' + (id
      ? 'Jika ini Anda, tidak perlu melakukan apa pun. <b>Jika bukan Anda</b>, buka panel peneliti \u2192 Akun \u2192 '
        + '"keluar dari sesi lain", lalu ubah kata sandi Google Anda.'
      : 'If this was you, nothing to do. <b>If it was not</b>, open the researcher panel \u2192 Account \u2192 '
        + '"sign out all other sessions", then change your Google password.') + '</p>';
  return { subject, html };
}

/* ⚠ WHY THE NOTICE NAMES AN ACCOUNT AND NOT A PROJECT (Seth asked for "which project/account").
 * A sign-in is to an ACCOUNT — it does not select a project, and under the split one account will
 * hold several. So the project half of that request cannot be answered by this message at all; it
 * belongs to the OTHER notice, "a member opened your project" (plans/project-split.md VI.2c B),
 * which is the one event that has a project to name. Implemented here: the account. */
const SIGNIN_FROM = 'FlexText Researcher <noreply@flextext.app>';

/* Minimal HTML escaping for the notice above — the values are server-derived, but a User-Agent is
 * client-controlled and lands in `label`, so it is never interpolated raw. */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ---------------- projects (Phase B) ----------------
 *
 * Every researcher gets ONE project they own, minted by the backfill below, and every instance is
 * stamped with it. Until the authorization phase converts each route, everything continues to work
 * through `researcher_id` exactly as before — the column is not replaced, it is REDEFINED as a
 * maintained denormalisation of the project's owner (round-1 finding 4), because old APKs resolve
 * the Drive token through `instance JOIN researcher ON researcher_id` and will do so forever.
 */

/* The default project's name. Deliberately derived, never asked for: on the day this ships nobody
 * has decided what their project is called, and a modal demanding one before the panel will load is
 * the worst possible introduction to a feature that is supposed to change nothing yet. */
function defaultProjectName(row) {
  const who = (row.display_name || '').trim() || (row.drive_email || '').split('@')[0] || 'Project';
  return `${who}'s project`.slice(0, 120);
}

/* Mint the owner's project and adopt their instances + crowd recorders into it. IDEMPOTENT by
 * construction — every write is conditional on the row not already being there — so it is safe to
 * re-run after a partial failure, which is the property a backfill actually needs. */
async function backfillProjectsFor(env, row, now) {
  let project = await env.DB.prepare('SELECT project_id, drive_folder_id FROM project WHERE owner_id=? ORDER BY created_at LIMIT 1')
    .bind(row.researcher_id).first();
  let created = false;
  if (!project) {
    const project_id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO project (project_id, owner_id, name, created_at) VALUES (?,?,?,?)')
      .bind(project_id, row.researcher_id, defaultProjectName(row), now).run();
    project = { project_id, drive_folder_id: null };
    created = true;
  }
  /* ⚠ RESOLVE THE DRIVE FOLDER, because without it this project cannot be scoped. Phase C's Drive
   * rules (R2-1) work by FOLDER PARENTAGE — "which folders belong to the project this member may
   * see" — and that question is unanswerable until the D1 row points at a folder.
   *
   * ⚠ FAILURE IS A REAL STATE, NOT AN ERROR. A researcher who has never connected Drive has no
   * folder to point at, and a Drive outage must not fail a backfill whose D1 work already
   * succeeded. Both leave drive_folder_id NULL, which Phase C reads as "no Drive scoping possible
   * here" and which FAILS CLOSED (invariant I4) rather than falling back to the whole estate.
   *
   * Conditional on absence like every other write here, so re-running never re-points a project
   * somebody has since moved. */
  let driveFolder = project.drive_folder_id || null;
  if (!driveFolder && row.drive_refresh_enc) {
    try {
      const access = await driveAccessToken(env, row);
      driveFolder = await driveEnsureDefaultProject(access, defaultProjectName(row));
      if (driveFolder) {
        await env.DB.prepare('UPDATE project SET drive_folder_id=? WHERE project_id=? AND drive_folder_id IS NULL')
          .bind(driveFolder, project.project_id).run();
      }
    } catch { driveFolder = null; }   // no Drive, or Drive unwell — the D1 half still stands
  }
  /* Only rows that have NO project yet are adopted: re-running must never move an instance that has
   * since been placed somewhere deliberately. */
  const inst = await env.DB.prepare('UPDATE instance SET project_id=? WHERE researcher_id=? AND project_id IS NULL')
    .bind(project.project_id, row.researcher_id).run();
  const crowd = await env.DB.prepare('UPDATE crowd_recorder SET project_id=? WHERE researcher_id=? AND project_id IS NULL')
    .bind(project.project_id, row.researcher_id).run();
  return {
    project_id: project.project_id,
    drive_folder_id: driveFolder,
    created,
    instances: (inst.meta && inst.meta.changes) || 0,
    crowd: (crowd.meta && crowd.meta.changes) || 0,
  };
}

/* ---------------- ONE D1 PROJECT PER DRIVE PROJECT FOLDER ----------------
 *
 * ⚠ WHY THIS EXISTS, and it is not a tidiness fix. `backfillProjectsFor` mints exactly ONE project
 * per researcher and points it at the DEFAULT Drive folder, because Phase B's model had no notion
 * of a second one. A researcher who owns TWO project folders (Seth, 2026-08-20 — "Fayu Text Corpus"
 * and "Dani Dictionary") therefore got ONE D1 row, and EVERY container was adopted into it —
 * including the ones whose folders sit inside the other project.
 *
 * Under Phase C that is not a cosmetic mismatch. Authorization reads `instance.project_id`, so a
 * grant naming the one project would authorize a member against devices from BOTH — precisely the
 * isolation the phase exists to provide, absent on the very first estate it met. And the second
 * folder had no D1 row at all, so `/projects/assign` into it resolved to NULL (fail-closed, but
 * unusable).
 *
 * ⚠ DRIVE PARENTAGE IS THE AUTHORITY HERE, so this CORRECTS rather than merely fills. Adoption
 * everywhere else is conditional on `project_id IS NULL` — the rule that re-running a backfill must
 * never move what somebody placed deliberately. This is the one exception, and the reason it is one:
 * a container's Drive parent is not a competing opinion about which project it is in, it is where
 * the bytes physically are. When the two disagree, D1 is wrong by definition, and leaving it wrong
 * means authorizing against a project the container is demonstrably not in (invariant I4's whole
 * concern, arrived at from the other side).
 *
 * ⚠ NO EXTRA DRIVE CALL, AND NO WRITE IN THE STEADY STATE. The estate is already in hand at the
 * call site, and every statement below is emitted only for a row whose value actually DIFFERS. A
 * correct database polled every few seconds therefore issues nothing at all — which is what makes
 * it safe to hang off a route the panel calls constantly.
 *
 * Pure D1 given an estate, so it is testable on the rig without Drive credentials — which the
 * `drive_folder_id` resolution in the backfill above notably is not. */
export async function reconcileProjects(env, researcherId, estate, now) {
  const folders = (estate && estate.projects) || [];
  if (!folders.length) return { projects: 0, writes: 0 };   // flat estate — nothing to mirror yet

  const rows = (await env.DB.prepare(
    'SELECT project_id, name, drive_folder_id FROM project WHERE owner_id=? ORDER BY created_at'
  ).bind(researcherId).all()).results || [];
  const byFolder = new Map(rows.filter((p) => p.drive_folder_id).map((p) => [p.drive_folder_id, p]));

  /* A project row pointing at NO folder can scope nothing (Phase C reads a NULL folder as "no Drive
   * scoping possible" and denies), so the first unmatched folder CLAIMS it rather than leaving an
   * orphan sitting beside a fresh insert. Only when exactly one such row exists: with two, which
   * folder each belongs to is a guess, and a guess here mis-files real devices. */
  const orphans = rows.filter((p) => !p.drive_folder_id);
  let claimable = orphans.length === 1 ? orphans[0] : null;

  const writes = [];
  for (const f of folders) {
    const name = String(f.name || '').slice(0, 120);
    const have = byFolder.get(f.folderId);
    if (have) {
      /* D1's `name` is a DENORMALISATION of the folder's name, exactly as `researcher_id` is a
       * denormalisation of the project's owner. Keeping it in step is what stops Phase D's sharing
       * UI offering a member "Seth Johnston's project" when the panel two tabs away says
       * "Fayu Text Corpus". Display only — the folder ID is identity, here as everywhere. */
      if (name && have.name !== name) {
        writes.push(env.DB.prepare('UPDATE project SET name=? WHERE project_id=?').bind(name, have.project_id));
        have.name = name;
      }
      continue;
    }
    if (claimable) {
      writes.push(env.DB.prepare('UPDATE project SET drive_folder_id=?, name=? WHERE project_id=? AND drive_folder_id IS NULL')
        .bind(f.folderId, name || claimable.name, claimable.project_id));
      byFolder.set(f.folderId, { project_id: claimable.project_id, name: name || claimable.name });
      claimable = null;
      continue;
    }
    const pid = crypto.randomUUID();
    writes.push(env.DB.prepare('INSERT INTO project (project_id, owner_id, name, created_at, drive_folder_id) VALUES (?,?,?,?,?)')
      .bind(pid, researcherId, name || 'Project', now, f.folderId));
    byFolder.set(f.folderId, { project_id: pid, name });
  }

  /* Which D1 project each CONTAINER should be in, read straight off the tree. `d.projectId` is the
   * Drive id of the project folder the container sits in, or '' when it is still directly under
   * master — and '' is left alone, because an unmigrated estate is a valid state, not a drift. */
  const want = new Map();
  for (const d of (estate.devices || [])) {
    if (!d.projectId || !d.folderId) continue;
    const p = byFolder.get(d.projectId);
    if (p) want.set(d.folderId, p.project_id);
  }
  if (want.size) {
    /* Revoked instances are included deliberately: their folders are still in the tree, and a
     * revoked row with a stale project_id is a row that becomes wrong the moment it is un-revoked. */
    for (const [table, col] of [['instance', 'instance'], ['crowd_recorder', 'crowd_recorder']]) {
      const cur = (await env.DB.prepare(
        `SELECT oauth_folder_id, project_id FROM ${table} WHERE researcher_id=? AND oauth_folder_id IS NOT NULL`
      ).bind(researcherId).all()).results || [];
      for (const x of cur) {
        const pid = want.get(x.oauth_folder_id);
        if (pid && x.project_id !== pid) {
          writes.push(env.DB.prepare(`UPDATE ${col} SET project_id=? WHERE oauth_folder_id=? AND researcher_id=?`)
            .bind(pid, x.oauth_folder_id, researcherId));
        }
      }
    }
  }

  if (!writes.length) return { projects: byFolder.size, writes: 0 };
  /* ⚠ BOUNDED, and the remainder is not lost — it lands on the next estate load, which the panel
   * makes constantly. An unbounded batch is the failure mode `drive-purge` already learned twice:
   * a big enough estate turns a correct loop into a request that dies. Projects are pushed before
   * containers, so a truncated batch always leaves the rows a later pass needs. */
  const CAP = 64;
  const batch = writes.slice(0, CAP);
  await env.DB.batch(batch);
  return { projects: byFolder.size, writes: batch.length, remaining: Math.max(0, writes.length - CAP) };
}

export async function handleV1(request, env, ctx, url, path, origin) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: v1Cors(origin, env) });
  if (!env.DB) return j({ error: 'sync_unavailable' }, 503, origin, env); // D1 not bound yet — inert, never breaks /drive
  const seg = path.split('/').filter(Boolean); // ['v1', ...]
  const m = request.method;
  const now = Date.now();

  /* GET /v1/textfile/<token> — stream a researcher-Drive file to an assigned DEVICE.
   * The token is opaque (AES-GCM under SERVER_HMAC_KEY), time-boxed (90 days), and names the
   * researcher + file, so the URL works from a plain fetch with no headers — which is exactly how
   * devices fetch assignment media. Unguessable-URL auth, same trust model as invite links. When
   * the token says x:'flextext', the file is one of OUR OWN STORE-only zips and the .flextext
   * entry is extracted here — that is what lets a move deliver text content for a text whose only
   * uploads are bundles. */
  if (m === 'GET' && seg.length === 3 && seg[1] === 'textfile') {
    let tk = null;
    try { tk = JSON.parse(await decAtRest(env, decodeURIComponent(seg[2]))); } catch { /* invalid */ }
    if (!tk || !tk.f || !tk.r || !(tk.e > now)) return j({ error: 'bad_token' }, 401, origin, env);
    const owner = await env.DB.prepare('SELECT * FROM researcher WHERE researcher_id=?').bind(tk.r).first();
    if (!owner || !owner.drive_refresh_enc) return j({ error: 'gone' }, 410, origin, env);
    /* A SCOPED (v2) token is revocable: the device it was minted for must still be a live instance
     * of that researcher. Revoke the device and its outstanding URLs stop serving — which is what
     * revoke ought to have meant all along. One indexed read, and only for scoped tokens.
     * ⚠ v1 tokens (no `i`) are served exactly as before. They are already in the field, held by
     * deployed devices, and breaking them would strand assignments mid-flight. They age out. */
    if (tk.i) {
      const live = await env.DB.prepare('SELECT instance_id FROM instance WHERE instance_id=? AND researcher_id=? AND revoked=0')
        .bind(tk.i, tk.r).first();
      if (!live) return j({ error: 'gone' }, 410, origin, env);
    }
    /* ⚠ A MEMBER-MINTED TOKEN IS A POINTER, GOOD ONLY WHILE THE GRANT IS (invariant I2).
     *
     * The design calls this required, not optional, before members ship, and the reason is that the
     * token is otherwise SELF-STANDING: everything needed to serve it travels inside it, so it
     * outlives the authority that created it. A member with assignTexts mints URLs into the owner's
     * Drive and has necessarily seen them; remove that member and, without this, they keep reading
     * those files for the rest of the 90 days with no grant behind it. Revocation that leaves a
     * 90-day tail is not revocation.
     *
     * ⚠ OWNER-MINTED TOKENS ARE UNTOUCHED — `m` is absent on every token in the field today, so this
     * costs them not one query. The check runs only for tokens a member created.
     *
     * ⚠ AND YES, THIS CAN CUT OFF A FIELD DEVICE mid-assignment when its minter is removed. That is
     * the intended trade and it is recoverable: the owner re-assigns and a fresh URL is minted. The
     * alternative — leaving the link live because a device is innocent — is exactly the 90-day tail,
     * and it is not fixable after the fact because nobody can tell who still holds the URL. */
    if (tk.m && tk.m !== tk.r) {
      let ok2 = null;
      try {
        ok2 = tk.i
          ? await env.DB.prepare(
              'SELECT 1 AS ok FROM project_member pm JOIN instance i ON i.project_id=pm.project_id '
              + 'WHERE pm.researcher_id=? AND i.instance_id=?').bind(tk.m, tk.i).first()
          /* No scoped instance (a v1-shaped token that still names a minter): fall back to "are they
           * still a member of ANY project this owner owns". Coarser, and deliberately so — the
           * precise question is unanswerable without the instance, and the coarse one still closes
           * on removal, which is what the invariant is about. */
          : await env.DB.prepare(
              'SELECT 1 AS ok FROM project_member pm JOIN project p ON p.project_id=pm.project_id '
              + 'WHERE pm.researcher_id=? AND p.owner_id=?').bind(tk.m, tk.r).first();
      } catch { ok2 = null; }      // unreadable membership DENIES (I4), never serves
      if (!ok2) return j({ error: 'gone' }, 410, origin, env);
    }
    try {
      const access = await driveAccessToken(env, owner);
      const range = request.headers.get('Range');
      const g = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(tk.f) + '?alt=media', {
        headers: { Authorization: 'Bearer ' + access, ...(range && !tk.x ? { Range: range } : {}) },
      });
      if (!g.ok && g.status !== 206) return j({ error: 'not_found', status: g.status }, g.status === 404 ? 404 : 502, origin, env);
      if (tk.x === 'flextext') {
        // Extract the .flextext entry from a STORE-only zip (zip.js writes method 0, so entry data
        // is a plain byte slice). Bounded: refuse zips too big to buffer in worker memory.
        const len = parseInt(g.headers.get('content-length') || '0', 10);
        if (len > 60 * 1024 * 1024) { try { g.body?.cancel?.(); } catch { /* noop */ } return j({ error: 'zip_too_large' }, 502, origin, env); }
        const buf = new Uint8Array(await g.arrayBuffer());
        const xml = storeZipEntry(buf, /\.flextext$/i);
        if (!xml) return j({ error: 'no_flextext_in_zip' }, 404, origin, env);
        const h = new Headers(v1Cors(origin, env));
        h.set('content-type', 'application/xml'); h.set('Cache-Control', 'no-store');
        return new Response(xml, { status: 200, headers: h });
      }
      const h = new Headers(v1Cors(origin, env));
      for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const v = g.headers.get(k); if (v) h.set(k, v);
      }
      h.set('Cache-Control', 'no-store');
      return new Response(g.body, { status: g.status, headers: h });
    } catch (e) { return j({ error: e.code || 'drive_error', message: safeErr(e) }, 502, origin, env); }
  }

  /* ⚠ THE EMAIL + PASSWORD LANE IS RETIRED (Seth, 2026-08-20). GOOGLE IS THE ONLY WAY IN.
   *
   * WHY, and why this is a deletion rather than a deprecation: too much of this suite is Google
   * Drive to support an account that has no Google behind it. Every text, every recording and
   * every project folder lives in the researcher's own Drive; a password account could sign in and
   * then do essentially nothing, and the researcher panel would be broken for it in ways nobody
   * would ever bother to fix.
   *
   * ⚠ NOBODY IS LOCKED OUT BY THIS. Checked against production D1 before removing it: all seven
   * researcher accounts are Google (`google_sub` set, `wrapped_kr` NULL on every row) — the
   * password lane has never been used by a single account. It is dead code that accepts
   * credentials, which is the kind of dead code worth removing rather than leaving to rot.
   *
   * The shipped client stopped offering it long ago: `renderSignIn()` is one "Sign in with Google"
   * button and `authSecret` appears nowhere in docs/js. These routes were reachable only by a
   * direct POST.
   *
   * 410 GONE rather than 404, and rather than silent deletion: an old cached engine or a bookmarked
   * script gets an answer that says the lane is over, not one that looks like a broken deploy.
   *
   * ⚠ What is deliberately NOT removed: `researcher.secret_hash` and its verifier. It is still the
   * fallback credential when session creation throws in the Google callback (see the degrade path
   * there) and every already-installed panel may still be holding one. The COLUMNS (salt,
   * wrapped_kr, escrow_kr, backup_codes) also stay — migrations here are additive-only, and they
   * are NULL on every row anyway. TOTP stays too: it is the step-up factor on remote wipe, which
   * Google-lane researchers use. */
  if (m === 'POST' && seg[1] === 'researcher' && (
        seg.length === 2                                                   // signup
        || (seg.length === 3 && (seg[2] === 'salt' || seg[2] === 'login' || seg[2] === 'password'))
        || (seg.length === 4 && seg[2] === 'reset'))) {                     // reset request/verify/confirm
    return j({ error: 'password_lane_retired', message: 'Researcher accounts sign in with Google.' }, 410, origin, env);
  }

  // GET /v1/escrow-pubkey — retired with the lane above: the escrow copy of Kr existed so a
  // FORGOTTEN PASSWORD could be recovered by email, and there are no passwords now. (The
  // ESCROW_PRIVATE_KEY / ESCROW_PUBLIC_KEY worker secrets are unreferenced after this and can be
  // deleted from the dashboard whenever convenient — this code no longer reads either one.)
  if (m === 'GET' && seg.length === 2 && seg[1] === 'escrow-pubkey') {
    return j({ error: 'password_lane_retired' }, 410, origin, env);
  }

  // ----- Google Sign-In (OIDC) — researcher identity, unified with Drive OAuth -----
  // GET /v1/oauth/google/start — top-level navigation (location=…); 302 → Google consent.
  // Requests openid+email+profile (identity) + drive.file (uploads/reads). Stateless PKCE state.
  if (m === 'GET' && seg.length === 4 && seg[1] === 'oauth' && seg[2] === 'google' && seg[3] === 'start') {
    const cid = env.GOOGLE_OAUTH_CLIENT_ID;
    if (!cid) return j({ error: 'oauth_unconfigured' }, 503, origin, env);
    const allow = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const ret = url.searchParams.get('return') || '';
    // Honor a full return URL (path included) as long as its ORIGIN is allow-listed; else a safe default.
    let returnTo = allow.find(o => o.includes('rulingants.github.io')) || allow[0] || 'https://rulingants.github.io';
    // originAllows, not allow.includes: a feature-branch PREVIEW origin is admitted by the `*-`
    // patterns in [env.staging] and would otherwise fail this exact-match test — sending the
    // researcher, after a successful Google sign-in, to allow[0] (https://localhost on staging)
    // instead of back to the panel they started from.
    try { const u = new URL(ret); if (originAllows(allow, u.origin)) returnTo = ret; } catch { /* not a URL → default */ }
    const b64url = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    /* `?stay=0` = the user did NOT tick "stay signed in", i.e. told us this is not their machine —
     * the session then gets 24h instead of 90 days. ABSENT means an older panel that cannot say, and
     * absent must mean the LONG window, or updating the worker would start signing those panels out
     * daily. The tightening arrives with the client, which is the correct order. */
    const stay = url.searchParams.get('stay') === '0' ? 0 : 1;
    /* `?lang=id` writes the sign-in notice in Indonesian. Absent = English, so an older panel
     * simply keeps today's behaviour rather than failing. */
    const lang = url.searchParams.get('lang') === 'id' ? 'id' : 'en';
    const state = await encAtRest(env, JSON.stringify({ v: verifier, r: returnTo, t: now, s: stay, l: lang }));
    const redirectUri = url.origin + '/v1/oauth/google/callback';
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: cid, redirect_uri: redirectUri, response_type: 'code',
      scope: 'openid email profile https://www.googleapis.com/auth/drive.file',
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
      state, code_challenge: challenge, code_challenge_method: 'S256',
    }).toString();
    return Response.redirect(authUrl, 302);
  }

  // GET /v1/oauth/google/callback — exchange code → identity + tokens; upsert researcher by Google
  // `sub`; ensure Kr (server-wrapped); store Drive refresh token; mint a session; 302 → panel#gauth.
  if (m === 'GET' && seg.length === 4 && seg[1] === 'oauth' && seg[2] === 'google' && seg[3] === 'callback') {
    const code = url.searchParams.get('code'); const stateRaw = url.searchParams.get('state');
    if (!code || !stateRaw) return j({ error: 'bad_oauth' }, 400, origin, env);
    let st; try { st = JSON.parse(await decAtRest(env, stateRaw)); } catch { return j({ error: 'bad_state' }, 400, origin, env); }
    if (!st || !st.v || !st.t || (now - st.t) > 600000) return j({ error: 'state_expired' }, 400, origin, env);
    const redirectUri = url.origin + '/v1/oauth/google/callback';
    let tok;
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET || '',
          redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: st.v,
        }),
      });
      tok = await r.json();
      if (!r.ok || !tok.id_token) return j({ error: 'token_exchange_failed', detail: tok.error || r.status }, 502, origin, env);
    } catch (e) { return j({ error: 'token_exchange_error', message: safeErr(e) }, 502, origin, env); }
    let claims; try { claims = JSON.parse(atob(tok.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return j({ error: 'bad_id_token' }, 502, origin, env); }
    const sub = claims.sub; const email = normEmail(claims.email || '');
    if (!sub) return j({ error: 'no_sub' }, 502, origin, env);
    const back = String(st.r || 'https://rulingants.github.io/flextext-editor/').replace(/[?#].*$/, '');

    /* ⚠ DRIVE ACCESS IS NOT OPTIONAL, AND GOOGLE LETS THE PERSON SAY IT IS.
     *
     * Google's granular-consent screen renders every non-identity scope as its own CHECKBOX, and
     * there is NO Cloud Console setting that marks one required — Google's documented answer is
     * that the app inspects what was actually granted. Untick `drive.file` and the exchange below
     * still SUCCEEDS: identity is granted, and `access_type=offline` still returns a refresh token.
     * So the row we would write looks fully connected — `drive_refresh_enc` set, `drive_email` set,
     * the panel's own "Drive connected" test satisfied — while every Drive call made with that
     * token fails on insufficient scope. That is the worst available shape: a researcher who signs
     * in, sees a dashboard, and cannot create a folder or open a text, with nothing on screen
     * saying why.
     *
     * This suite keeps ALL of its data in the researcher's own Drive. An account without Drive is
     * not a degraded account; it is not an account. So it is refused at the door rather than
     * created broken.
     *
     * `tok.scope` is what Google says was actually granted (incremental auth included), so it is
     * the only honest signal available here without spending a Drive round trip on every sign-in.
     *
     * ⚠ An ABSENT or empty `scope` is treated as UNVERIFIABLE, not as declined. This callback is
     * the one path the local rig cannot exercise and every researcher sign-in goes through it — if
     * Google ever changes the response shape, the failure must be "the guard stopped guarding, and
     * said so in the log", never "nobody can sign in". Degrade, never deny: the same rule the
     * session fallback below follows, for the same reason. */
    const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
    const grantedRaw = String(tok.scope || '');
    const driveGranted = grantedRaw ? grantedRaw.split(/\s+/).includes(DRIVE_SCOPE) : true;
    if (!grantedRaw) {
      await secLog(env, request, 'oauth_scope_unreadable', { who: email || sub });
    }
    // A (allowlist) + request/approve: env-listed emails are auto-approved OWNERS; anyone else may
    // sign in but their account is created PENDING (inert) until an owner approves it in the panel.
    // No hard reject here — the isApproved() gate on the privileged endpoints is what protects them.
    const operator = isOperator(email, env);
    // Pre-approved DOMAIN (D1 `approved_domain`): approved on sight, but as an ordinary researcher.
    // Operator rights come only from the env list, so no database row can ever grant them.
    const domainOk = operator ? false : await isDomainApproved(email, env);
    const name = claims.name || ''; const picture = claims.picture || '';
    let row = await env.DB.prepare(
      'SELECT researcher_id, CASE WHEN drive_refresh_enc IS NOT NULL THEN 1 ELSE 0 END AS has_drive FROM researcher WHERE google_sub=?'
    ).bind(sub).first();
    /* Refuse only when this sign-in would leave the account WITHOUT Drive: a brand-new account, or
     * an existing one that has never stored a refresh token. An established researcher who unticks
     * the box on a re-consent keeps the grant they already gave — see the update branch below,
     * which is where declining would otherwise do its real damage. */
    if (!driveGranted && !(row && row.has_drive)) {
      await secLog(env, request, 'oauth_drive_scope_declined', { who: email || sub, existing: !!row });
      return Response.redirect(back + '#gauth_error=drive_required', 302);
    }
    /* Phase A: the token handed back is a SESSION, not researcher.secret_hash. The fragment shape
     * `<researcher_id>.<token>` is unchanged, so the client needs no edit to keep working. */
    const stay = !(st && st.s === 0);   /* absent => 90 days: an OLD panel must not start expiring daily */
    const legacyKill = await sha256hex(randTok(32));
    if (!row) {
      const researcher_id = crypto.randomUUID();
      const krB64 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
      await env.DB.prepare(
        'INSERT INTO researcher (researcher_id, secret_hash, email_sha256, settings_blob, settings_rev, created_at, google_sub, kr_server_enc, drive_refresh_enc, drive_email, email_enc, display_name, avatar_url, approved) VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?,?)'
      ).bind(researcher_id, legacyKill, await emailKey(email, env), JSON.stringify({}), now, sub,
             await encAtRest(env, krB64), tok.refresh_token ? await encAtRest(env, tok.refresh_token) : null,
             email, await encAtRest(env, email), name, picture, (operator || domainOk) ? 1 : 0).run();
      row = { researcher_id, __created: true };
      // Every account creation is logged, whether it was auto-approved or left pending, so the log
      // answers "when did this person first appear" and not merely "when was someone approved".
      await logApproval(env, request, operator || domainOk ? 'account_auto_approved' : 'account_signup',
                        email || sub,
                        operator ? 'operator allowlist (ALLOWED_RESEARCHERS)'
                              : domainOk ? 'pre-approved domain: ' + emailDomain(email)
                              : 'pending — awaiting manual approval',
                        'system');
      // FIRST sign-in for this Google account — a brand-new researcher row. Alert-worthy because
      // it should essentially never happen unannounced; repeat sign-ins take the else-branch and
      // are silent, so this cannot become routine noise.
      secAlert(env, ctx, request, 'New researcher account (Google sign-in)', [
        'A new researcher account signed in with Google for the first time.',
        'Email: ' + (email || '(none)'),
        'Name: ' + (name || '(none)'),
        operator
          ? 'This address is on ALLOWED_RESEARCHERS, so it was auto-approved as an OWNER.'
          : domainOk
            ? 'Its domain (' + emailDomain(email) + ') is in your pre-approved list, so it was '
              + 'auto-approved as an ordinary researcher. Nothing to do — this is just so you know. '
              + 'If it was NOT expected, revoke it in the researcher panel.'
            : 'This account is PENDING and can do nothing until you approve it in the researcher panel.',
      ]);
    } else {
      /* ⚠ ROUND-1 FINDING 1, the legacy skeleton key. Once sessions exist, a Google account's OLD
       * secret_hash would stay honoured by the fallback FOREVER, and "sign out other sessions" would
       * be a lie while it lived. Rotating it to garbage retires it on the first session-lane sign-in.
       * google_sub accounts ONLY — the password lane's secret_hash is a durable verifier (R2-3). */
      const sets = ['secret_hash=?']; const binds = [legacyKill];
      /* ⚠ `&& driveGranted` is the whole point. A returning researcher who unticks Drive on a
       * re-consent still gets a refresh token — one that cannot touch Drive. Storing it would
       * REPLACE their working grant with a dead one and disconnect an account that was fine a
       * second ago, which is a far worse outcome than the sign-in they were attempting. */
      if (tok.refresh_token && driveGranted) { sets.push('drive_refresh_enc=?'); binds.push(await encAtRest(env, tok.refresh_token)); }
      if (email) { sets.push('drive_email=?'); binds.push(email); }
      sets.push('display_name=?'); binds.push(name);
      sets.push('avatar_url=?'); binds.push(picture);
      if (operator) { sets.push('approved=?'); binds.push(1); }   // env-listed operators are always approved
      binds.push(row.researcher_id);
      await env.DB.prepare('UPDATE researcher SET ' + sets.join(', ') + ' WHERE researcher_id=?').bind(...binds).run();
    }
    const isNewAccount = !!row.__created;
    /* ⚠ THE ONE PATH THE LOCAL RIG CANNOT TEST is this one: a real Google round trip. Sessions are
     * exercised from seeded rows, but the callback that CREATES them only ever runs in production —
     * and it is the path every researcher sign-in goes through, so a throw here means NOBODY CAN
     * SIGN IN, arriving on the first real use of new code.
     * So it falls back to the PREVIOUS mechanism rather than failing: mint a token and store its
     * hash in researcher.secret_hash exactly as the old worker did, letting the legacy lane
     * authenticate it. Sessions are then not working, which the loud log event says — but everyone
     * can still sign in and work. Degrade, never deny. */
    let session;
    try {
      session = await createSession(env, request, row.researcher_id, stay);
    } catch (e) {
      session = randTok(24);
      await env.DB.prepare('UPDATE researcher SET secret_hash=? WHERE researcher_id=?')
        .bind(await sha256hex(session), row.researcher_id).run();
      await secLog(env, request, 'session_create_failed', {
        error: String((e && e.message) || e).slice(0, 160), fallback: 'legacy_secret_hash',
      });
    }

    /* Tell the account holder their account was just signed into. NOT on the account's first ever sign-in:
     * the person is standing right there having just created it, and an alert about your own signup
     * is the noise that teaches people to ignore the ones that matter. `waitUntil`, so a slow or
     * failing mail can never delay the redirect the researcher is waiting on. */
    /* ON by default; `SIGNIN_NOTICE=off` on the Worker disables it. Seth chose to ship it enabled
     * (2026-08-17: "I'd like the signin notice on. No worries on new unexpected e-mails for those
     * users"), so the switch is not a rollout gate — it is a KILL switch, which is a different and
     * more durable thing. If these ever start landing in spam, or one researcher finds them
     * alarming, that is a dashboard variable at 2am rather than a worker deploy. Default-on because
     * a security notice nobody remembered to enable is worth nothing. */
    const noticeEnabled = String(env.SIGNIN_NOTICE || 'on').toLowerCase() !== 'off';
    if (noticeEnabled && !isNewAccount && email) {
      const g = geoParts(request);
      const { subject, html } = signinNoticeEmail({
        /* The account, named even though the mail is going TO that address: a researcher with two
         * accounts otherwise gets two identical-looking alerts and cannot tell which was entered. */
        email, name,
        label: uaLabel(request),
        place: g.place,
        network: g.network,
        ip: request.headers.get('CF-Connecting-IP') || '',
        when: new Date(now).toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
        lang: st && st.l === 'id' ? 'id' : 'en',
      });
      const send = sendEmail(env, request, { to: email, subject, html, event: 'signin_notice', from: SIGNIN_FROM })
        .catch(() => false);
      if (ctx && ctx.waitUntil) ctx.waitUntil(send);
    }
    const dest = back + '?mode=researcher#gauth=' + encodeURIComponent(row.researcher_id) + '.' + encodeURIComponent(session);
    return Response.redirect(dest, 302);
  }

  // POST /v1/researcher/signout — (authed) invalidate this session (rotate the stored hash).
  if (m === 'POST' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'signout') {
    const r = await authResearcher(request, env);
    /* ⚠ ROUND-2 FINDING R2-3. This used to rotate researcher.secret_hash. On a GOOGLE account that
     * was right — the column WAS the session token. On a PASSWORD account the same column is the
     * durable password VERIFIER, so signing out would have silently destroyed the ability to log in,
     * recoverable only by an emailed reset. It was unreachable dead code (the client never called
     * it); wiring the client to it, as this phase does, is exactly what would have armed it.
     * Now it revokes THIS SESSION and nothing else, which is what sign-out means. */
    if (r && r.session_id) {
      await env.DB.prepare('UPDATE session SET revoked=1 WHERE session_id=?').bind(r.session_id).run();
    }
    return j({ ok: true }, 200, origin, env);
  }

  /* POST /v1/researcher/admin/backfill-projects — OPERATOR-ONLY, IDEMPOTENT.
   *
   * Why an endpoint and not a migration file (round-1 finding 7): minting one project per researcher
   * needs GUIDs and derived names, which is past what is reviewable in D1 SQL. Being an endpoint also
   * makes it re-runnable and makes it REPORT what it did, which a `.sql` file cannot.
   *
   * Safe to run before or after the client update, and safe to run twice: it creates a project only
   * where none exists and adopts only rows whose project_id is still NULL, so a second run over a
   * finished estate reports zeros and changes nothing. */
  if (m === 'POST' && seg.length === 4 && seg[1] === 'researcher' && seg[2] === 'admin' && seg[3] === 'backfill-projects') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    if (!isOperator(r.drive_email, env)) return j({ error: 'not_owner' }, 403, origin, env);
    const rows = await env.DB.prepare('SELECT researcher_id, display_name, drive_email FROM researcher').all();
    const report = { researchers: 0, projects_created: 0, instances_adopted: 0, crowd_adopted: 0 };
    for (const who of (rows && rows.results) || []) {
      const out = await backfillProjectsFor(env, who, now);
      report.researchers++;
      if (out.created) report.projects_created++;
      report.instances_adopted += out.instances;
      report.crowd_adopted += out.crowd;
    }
    await logApproval(env, request, 'projects_backfilled',
      report.researchers + ' researcher(s)', report.projects_created + ' project(s) created', r.drive_email);
    return j(report, 200, origin, env);
  }

  /* POST /v1/researcher/pubkey — publish this account's researcher keypair.
   *
   * ⚠ CONDITIONAL WRITE, and this is round-1 finding 3, not caution for its own sake. Multi-session
   * means two browsers of the same account can race this on first sign-in after the update.
   * Last-write-wins on `pubkey` would strand every grant already wrapped to the key that lost —
   * silently, and only discovered when a device could not be opened. So the first writer wins, the
   * loser gets 409, and the loser's correct response is to fetch the winner's pair and unwrap
   * `wrapped_privkey` with Kr. Idempotent by construction. */
  if (m === 'POST' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'pubkey') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    const body = await readJson(request) || {};
    if (!body.pubkey || !body.wrapped_privkey) return j({ error: 'bad_body' }, 400, origin, env);
    const res = await env.DB.prepare(
      'UPDATE researcher SET pubkey=?, wrapped_privkey=? WHERE researcher_id=? AND pubkey IS NULL'
    ).bind(String(body.pubkey), String(body.wrapped_privkey), r.researcher_id).run();
    if (!(res.meta && res.meta.changes)) {
      const cur = await env.DB.prepare('SELECT pubkey, wrapped_privkey FROM researcher WHERE researcher_id=?')
        .bind(r.researcher_id).first();
      return j({ error: 'already_set', pubkey: cur && cur.pubkey, wrapped_privkey: cur && cur.wrapped_privkey }, 409, origin, env);
    }
    return j({ ok: true }, 200, origin, env);
  }

  /* POST /v1/researcher/keys — write a set of Ki grants for ONE instance.
   *
   * ⚠ THE WRAP-TO-OWNER INVARIANT. The set is REJECTED unless it contains a row for the project's
   * owner. That is what makes "the owner can always see and revoke all keys" true by construction
   * rather than by policy: a member with createInvites cannot mint a device key the owner cannot
   * read, because the worker will not store the set at all.
   *
   * ⚠ E2EE honesty, stated where it is enforced: the worker checks that the owner's copy EXISTS. It
   * cannot check the ciphertext is well-formed, because it cannot read it. A malicious member could
   * wrap garbage — detected loudly the first time the owner opens that device, remedied by revoking
   * the member and re-keying. Sabotage-detectable, not silently-subvertible, which is the strongest
   * claim any E2EE sharing scheme can make. */
  if (m === 'POST' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'keys') {
    const body = await readJson(request) || {};
    const instanceId = String(body.instance_id || '');
    const grants = Array.isArray(body.grants) ? body.grants : null;
    if (!instanceId || !grants || !grants.length) return j({ error: 'bad_body' }, 400, origin, env);

    /* ⚠ THIS ROUTE USED TO DECIDE AUTHORIZATION ITSELF, and answered 403 when the caller was not the
     * owner — which made every instance id ENUMERABLE (2026-08-21 audit): a nonexistent id returned
     * not_found and a real one belonging to somebody else returned forbidden, so the two answers
     * told an unauthenticated-for-this-resource caller which ids exist.
     *
     * Both halves are fixed by going through authMember: one authority (I1) instead of a second
     * hand-rolled ownership check, and one refusal shape. `allowRevoked` is NOT set — delivering a
     * NEW key to a revoked device is meaningless, unlike WITHDRAWING one from it.
     *
     * The legacy branch inside authMember covers the dual-read window this code used to handle by
     * hand, and yields the same values: project_id '' and the instance's researcher_id as owner. */
    const ctx = await authMember(request, env, { instance: instanceId }, null);
    if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);
    if (!ctx.ok || !ctx.isOwner) return j({ error: 'not_found' }, 404, origin, env);
    const proj = { project_id: ctx.project_id || null, owner_id: ctx.owner.researcher_id };
    const r = ctx.owner;

    if (!grants.some((g) => g && g.researcher_id === proj.owner_id && g.wrapped_ki)) {
      return j({ error: 'owner_grant_required' }, 400, origin, env);
    }
    const version = Math.max(1, parseInt(body.key_version || 1, 10) || 1);
    const writes = grants
      .filter((g) => g && g.researcher_id && g.wrapped_ki)
      .map((g) => env.DB.prepare(
        'INSERT OR REPLACE INTO member_key (project_id, instance_id, researcher_id, key_version, wrapped_ki, wrapped_by, created_at) '
        + 'VALUES (?,?,?,?,?,?,?)'
      /* ⚠ `|| ''` IS LOAD-BEARING: member_key.project_id is TEXT NOT NULL, and the dual-read branch
       * above deliberately yields project_id = null for an instance the backfill has not reached —
       * which is EVERY instance today, because the D1 project table is still empty while projects
       * live as Drive folders. Binding that null failed the constraint, threw the whole batch, and
       * returned 500. The client swallowed it per instance, so 31 grants failed in silence and the
       * migration looked like it had simply found nothing to do.
       * '' means "no project yet" and is the same sentinel buildDriveEstate already uses for a text
       * with no project. ⚠ Phase C must treat '' as unassigned rather than as a project id. */
      ).bind(String(proj.project_id || ''), instanceId, String(g.researcher_id), version, String(g.wrapped_ki), r.researcher_id, now));
    await env.DB.batch(writes);
    return j({ ok: true, stored: writes.length, key_version: version }, 200, origin, env);
  }

  /* GET /v1/researcher/keys?instance=<id> — the grants THIS researcher holds, for getKi()'s
   * resolution order (memory → member_key → the legacy settings_blob map).
   *
   * ⚠⚠ SCOPED AT READ TIME, AND THAT IS THE WHOLE POINT (2026-08-24). This used to select on
   * `researcher_id=?` alone, which made THE EXISTENCE OF THE ROW the authorization. Every other fix
   * in this area has been to a DELETION path — remove a member, revoke a grant — and that approach
   * is incomplete by construction: it can only be as complete as our list of ways a row goes stale,
   * and the sweeps kept finding another one.
   *
   * The one that has no deletion path at all: MOVING A DEVICE BETWEEN PROJECTS. /projects/assign
   * rewrites `instance.project_id` and never touches member_key, so a member of the project the
   * device LEFT keeps a grant nobody will ever delete — there is no removal event to hang the
   * cleanup on, because nobody was removed from anything.
   *
   * So entitlement is now RE-DERIVED on every read, from the state that is authoritative right now:
   *   · the caller owns the instance — covers the owner, and the dual-read window where
   *     instance.project_id is still NULL (design-gap 4: instance.researcher_id is a maintained
   *     denormalisation of the project's owner);
   *   · or the caller holds a project_member row for the instance's CURRENT project.
   * A former member matches neither, and neither does a member of the project a device has left.
   *
   * ⚠ member_key.project_id IS DELIBERATELY NOT CONSULTED. It is a snapshot written at grant time
   * ('' on anything minted before the project existed), so it answers "where was this minted", never
   * "where is this device now". Asking the instance is what makes the answer current.
   *
   * ⚠ THE DELETION PATHS STAY. This is defence in depth, not a replacement: a withdrawn grant should
   * actually leave the database rather than merely stop being served, both because the ciphertext is
   * one D1 dump away from a former member and because "revocation is an act, not a UI state" is the
   * property the member-removal batch exists to hold.
   *
   * ⚠ FALLS BACK TO OWNERSHIP-ONLY if project_member cannot be read (a database predating that
   * migration). Narrower, never wider: the owner keeps their own keys and members get nothing, which
   * is the safe direction for a degraded read. */
  if (m === 'GET' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'keys') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    const want = url.searchParams.get('instance') || '';
    const OWNED = 'instance_id IN (SELECT instance_id FROM instance WHERE researcher_id=?)';
    const MEMBER_OF_CURRENT_PROJECT =
      'instance_id IN (SELECT i.instance_id FROM instance i'
      + ' JOIN project_member pm ON pm.project_id=i.project_id'
      + ' WHERE pm.researcher_id=? AND i.project_id IS NOT NULL)';
    const cols = 'SELECT instance_id, key_version, wrapped_ki FROM member_key';
    const tail = want ? ' AND instance_id=? ORDER BY key_version DESC'
                      : ' ORDER BY instance_id, key_version DESC';
    let rows = null;
    try {
      const sql = `${cols} WHERE researcher_id=? AND (${OWNED} OR ${MEMBER_OF_CURRENT_PROJECT})${tail}`;
      const binds = want ? [r.researcher_id, r.researcher_id, r.researcher_id, want]
                         : [r.researcher_id, r.researcher_id, r.researcher_id];
      rows = await env.DB.prepare(sql).bind(...binds).all();
    } catch (e) {
      try { await secLog(env, request, 'member_key_scope_degraded', { error: String((e && e.message) || e).slice(0, 120) }); } catch { /* noop */ }
      const sql = `${cols} WHERE researcher_id=? AND ${OWNED}${tail}`;
      const binds = want ? [r.researcher_id, r.researcher_id, want] : [r.researcher_id, r.researcher_id];
      rows = await env.DB.prepare(sql).bind(...binds).all();
    }
    return j({ keys: (rows && rows.results) || [] }, 200, origin, env);
  }

  /* GET /v1/researcher/pubkey/<researcher_id> — read ANOTHER researcher's public key, so a grant can
   * be wrapped to them. Without this, cross-researcher wrapping is simply impossible: every grant
   * must be sealed to the grantee's key, and there was no way to obtain one.
   *
   * ⚠ RETURNS THE KEY AND NOTHING ELSE — no email, no display name, no avatar. Seth's rule for
   * pairing generalised: "we do want the researcher's identity not to be advertised in the pairing
   * process. EXACTLY the same for anything that needs to be paired." An id-to-identity lookup for
   * any authenticated caller is precisely the directory that rule refuses, and the wrapping needs
   * only the key.
   *
   * ⚠ NOT SCOPED TO A SHARED PROJECT, deliberately: at the moment you invite someone you do not yet
   * share one, so a membership check here would make the first invite unbuildable. What bounds it
   * instead is that researcher_ids are random GUIDs — the caller must already have been given the
   * id — and that a public key is public by definition. Nothing here is a secret; the sensitive
   * thing would have been the identity, which is not returned. */
  if (m === 'GET' && seg.length === 4 && seg[1] === 'researcher' && seg[2] === 'pubkey') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    const who = String(seg[3] || '').replace(/[^\w-]/g, '').slice(0, 64);
    if (!who) return j({ error: 'bad_body' }, 400, origin, env);
    const row = await env.DB.prepare('SELECT researcher_id, pubkey FROM researcher WHERE researcher_id=? AND approved=1')
      .bind(who).first();
    /* A researcher who has not generated a keypair yet is not_found rather than a null key: the
     * caller cannot wrap to them either way, and one answer is easier to handle than two. */
    if (!row || !row.pubkey) return j({ error: 'not_found' }, 404, origin, env);
    return j({ researcher_id: row.researcher_id, pubkey: row.pubkey }, 200, origin, env);
  }

  /* DELETE /v1/researcher/keys { instance_id, researcher_id, key_version? } — REVOKE a grant.
   *
   * ⚠ WITHOUT THIS, "revocable" WAS UNIMPLEMENTABLE. Grants could be written and never withdrawn, so
   * every sentence in the design about revoking a member's access described something no code could
   * do. It is the other half of the ledger, not an optimisation.
   *
   * ⚠ OWNER-ONLY, and it REFUSES TO DELETE THE OWNER'S OWN COPY. That is the exact mirror of the
   * wrap-to-owner invariant on the write path: the insert refuses a set without the owner's copy so
   * the owner can always read the key, and this refuses to remove it so they cannot lose that by a
   * slip. Otherwise an owner could revoke themselves out of their own device's key with no way back
   * — the key is wrapped to keys the worker cannot read, so nothing could reconstruct it.
   *
   * ⚠ E2EE HONESTY: deleting the row stops the worker HANDING OVER the wrapped key. It cannot
   * un-know a key the member already fetched and cached. Real revocation is rotation (Phase E, which
   * the key_version column exists for); this is the step that must precede it and the step that
   * stops the ledger being append-only. Say so in the UI rather than implying more. */
  if (m === 'DELETE' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'keys') {
    const body = await readJson(request) || {};
    const instanceId = String(body.instance_id || '');
    const grantee = String(body.researcher_id || '');
    if (!instanceId || !grantee) return j({ error: 'bad_body' }, 400, origin, env);
    /* allowRevoked: withdrawing a grant must work AFTER the device is revoked — see authMember.
     * Owner-only, which is what makes the opt-in safe. */
    const ctx = await authMember(request, env, { instance: instanceId, allowRevoked: true }, null);
    if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);
    if (!ctx.ok || !ctx.isOwner) return j({ error: 'not_found' }, 404, origin, env);
    if (grantee === ctx.owner.researcher_id) {
      return j({ error: 'owner_grant_required' }, 400, origin, env);
    }
    const ver = body.key_version == null ? null : Math.max(1, parseInt(body.key_version, 10) || 1);
    const res = ver == null
      ? await env.DB.prepare('DELETE FROM member_key WHERE instance_id=? AND researcher_id=?')
          .bind(instanceId, grantee).run()
      : await env.DB.prepare('DELETE FROM member_key WHERE instance_id=? AND researcher_id=? AND key_version=?')
          .bind(instanceId, grantee, ver).run();
    await logApproval(env, request, 'grant_revoked', grantee.slice(0, 12) + '…', instanceId.slice(0, 12) + '…', ctx.caller.drive_email);
    return j({ ok: true, removed: (res.meta && res.meta.changes) || 0 }, 200, origin, env);
  }

  /* GET /v1/projects — the projects this researcher owns, and the ones they have been added to.
   *
   * ⚠ WITHOUT THIS THE MEMBERS ROUTES ARE UNREACHABLE. Every one of them is addressed by
   * project_id, and until now no endpoint returned one — the id existed only in D1 and in the
   * backfill's own local variables. This is not a convenience listing; it is the only way a client
   * can name the thing it wants to manage.
   *
   * ⚠ IDENTITY IS NOT ADVERTISED HERE EITHER. A joined project carries its NAME and its owner's
   * opaque id — never the owner's email or display name. Seth's pairing rule generalised: a member
   * needs to know WHICH project they are in, which the name answers; who the human behind it is, is
   * a separate disclosure that belongs to whoever chooses to make it. */
  if (m === 'GET' && seg.length === 2 && seg[1] === 'projects') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    const owned = await env.DB.prepare(
      'SELECT project_id, name, drive_folder_id, created_at FROM project WHERE owner_id=? ORDER BY created_at'
    ).bind(r.researcher_id).all();
    let joined = { results: [] };
    try {
      joined = await env.DB.prepare(
        'SELECT p.project_id, p.name, p.owner_id, m.caps FROM project_member m '
        + 'JOIN project p ON p.project_id=m.project_id WHERE m.researcher_id=? ORDER BY m.added_at'
      ).bind(r.researcher_id).all();
    } catch { /* the table may predate this deploy; an empty joined list is the honest answer */ }
    return j({
      owned: ((owned && owned.results) || []),
      joined: ((joined && joined.results) || []).map((x) => {
        let caps = null; try { caps = JSON.parse(x.caps || '{}'); } catch { caps = null; }
        return { project_id: x.project_id, name: x.name, owner_id: x.owner_id, caps, invalid: caps === null };
      }),
    }, 200, origin, env);
  }

  /* /v1/projects/<project_id>/members — OWNER-ONLY membership management (II.4).
   *
   * ⚠ THE OWNER IS NEVER A ROW HERE. Ownership is `project.owner_id`; a project_member row for the
   * owner would be a second, weaker answer to "who owns this" that could disagree with the first —
   * and the one that disagrees is always the one some code path trusts. Adding oneself is refused.
   *
   * ⚠ REMOVING A MEMBER ALSO DELETES THEIR KEY GRANTS, in the same batch. Without that, "removed"
   * would mean "no longer listed" while they still hold every wrapped Ki the ledger handed them —
   * revocation as a UI state rather than an act (invariant I5). Full rotation is Phase E; this is
   * the part that must not wait for it. */
  if (seg.length === 4 && seg[1] === 'projects' && seg[3] === 'members') {
    const projectId = String(seg[2] || '');
    const ctx = await authMember(request, env, { project: projectId }, null);
    if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);
    if (!ctx.ok || !ctx.isOwner) return j({ error: 'not_found' }, 404, origin, env);

    if (m === 'GET') {
      const rows = await env.DB.prepare(
        'SELECT researcher_id, caps, added_at, added_by FROM project_member WHERE project_id=? ORDER BY added_at'
      ).bind(projectId).all();
      /* Caps are returned PARSED. The panel would otherwise JSON.parse a column written by another
       * browser, which is the kind of thing that throws in the middle of a render. */
      const members = ((rows && rows.results) || []).map((x) => {
        let caps = null; try { caps = JSON.parse(x.caps || '{}'); } catch { caps = null; }
        return { researcher_id: x.researcher_id, caps, added_at: x.added_at, added_by: x.added_by,
                 invalid: caps === null };
      });
      return j({ project_id: projectId, members }, 200, origin, env);
    }

    if (m === 'POST') {
      const body = await readJson(request) || {};
      const who = String(body.researcher_id || '').replace(/[^\w-]/g, '').slice(0, 64);
      if (!who) return j({ error: 'bad_body' }, 400, origin, env);
      if (who === ctx.owner.researcher_id) return j({ error: 'owner_is_not_a_member' }, 400, origin, env);
      const caps = validateCaps(body.caps);
      if (!caps) return j({ error: 'bad_caps' }, 400, origin, env);
      /* ⚠ NO SHARING BEFORE THE OWNER HAS MIGRATED TO PROJECT FOLDERS (Seth, 2026-08-20): *"No
       * researcher sharing if the researcher hasn't migrated to the project model and doesn't have
       * project folders."*
       *
       * The boundary a member is confined to IS a Drive project folder — Seth's rule is that they
       * must not reach *"the root folder outside of projects shared with them"*, so a member's file
       * listing has to be ROOTED at that folder rather than walked from the account master and
       * filtered afterwards. On a FLAT, unmigrated estate the device folders sit directly under
       * master and there is no such subtree to root at, so the confinement has nothing to stand on.
       *
       * `drive_folder_id` is exactly that signal: reconcileProjects stamps it from the researcher's
       * real Drive project folder, and it stays NULL when there is none. Refusing HERE — at the one
       * moment a person is present to be told — is the whole point; discovering it later means a
       * member who was added successfully and can see nothing, with no way to tell that from a bug.
       *
       * ⚠ Fails closed for a Drive outage or a disconnected account too, which is correct: all three
       * are "there is no project folder to confine them to". Self-healing — the reconcile runs on
       * every panel load, so migrating and reopening the panel clears it with nothing to re-run. */
      const home = await env.DB.prepare('SELECT drive_folder_id FROM project WHERE project_id=?')
        .bind(projectId).first();
      if (!home || !home.drive_folder_id) {
        return j({ error: 'not_migrated',
                   message: 'This project has no Drive project folder yet. Migrate the estate to projects before sharing it.' },
                 409, origin, env);
      }
      /* The grantee must EXIST and be approved. A membership row naming nobody is unreachable
       * forever, and the owner would have no way to tell it from a working one. */
      const them = await env.DB.prepare('SELECT researcher_id FROM researcher WHERE researcher_id=? AND approved=1')
        .bind(who).first();
      if (!them) return j({ error: 'no_such_researcher' }, 404, origin, env);
      await env.DB.prepare(
        'INSERT OR REPLACE INTO project_member (project_id, researcher_id, caps, added_at, added_by) VALUES (?,?,?,?,?)'
      ).bind(projectId, who, JSON.stringify(caps), now, ctx.caller.researcher_id).run();
      await logApproval(env, request, 'member_added', who.slice(0, 12) + '…', Object.keys(caps).join(','), ctx.caller.drive_email);
      return j({ ok: true, researcher_id: who, caps }, 200, origin, env);
    }

    if (m === 'DELETE') {
      const body = await readJson(request) || {};
      const who = String(body.researcher_id || '').replace(/[^\w-]/g, '').slice(0, 64);
      if (!who) return j({ error: 'bad_body' }, 400, origin, env);
      /* ⚠⚠ THE OWNER IS NOT REMOVABLE, and this guard is about the member_key DELETE below, not about
       * the project_member row (the owner never has one, so that half is a harmless no-op).
       *
       * Without it, `who` = the owner makes that statement read
       * `DELETE FROM member_key WHERE researcher_id=<owner> AND (…)` — i.e. it destroys the OWNER'S
       * OWN wrap-to-owner copies of the device keys. Those are wrapped to keys the worker cannot
       * read, so nothing can reconstruct them: the owner would permanently lose the ability to
       * decrypt their own devices. That is precisely what DELETE /v1/researcher/keys refuses by name
       * (`owner_grant_required`), and this route could reach the same end by another door.
       *
       * ⚠ It mirrors the POST branch's `owner_is_not_a_member` deliberately: "the owner is never a
       * project_member row" is one rule, and both verbs must say so, or the invariant holds on the
       * way in and not on the way out. Owner-only route, so this is a footgun rather than an
       * escalation — but an unrecoverable one. */
      if (who === ctx.owner.researcher_id) return j({ error: 'owner_is_not_a_member' }, 400, origin, env);
      /* ⚠ ONE BATCH, so a member can never be left listed-but-keyless or keyless-but-listed.
       *
       * ⚠⚠ RESOLVED THROUGH `instance`, NOT through `member_key.project_id` — and the first version
       * of this got it wrong in a way that left revocation cosmetic (2026-08-21 audit). That column
       * is a DENORMALISATION written at grant time, and it is `''` on every grant minted before the
       * project existed: the v435 write path binds `String(proj.project_id || '')` and its own
       * comment warns that Phase C must read `''` as unassigned. Matching on it therefore skipped
       * exactly the oldest grants — the member stayed listed as removed while still holding every
       * wrapped Ki the ledger had handed them.
       *
       * The instance table is the authority for which project a device is in, so ask it. The second
       * clause covers the DUAL-READ WINDOW: a grant minted while `instance.project_id` was still
       * NULL also carries `''`, and its instance is identified only by belonging to this project's
       * owner (design-gap 4 pins instance.researcher_id as always equal to the project's owner_id).
       *
       * ⚠ That clause is deliberately BROADER THAN STRICTLY NEEDED: an owner with two projects and
       * an unassigned device will have that device's grants revoked when the member is removed from
       * EITHER project. Nothing can distinguish them — the device is in no project — and for a
       * REVOCATION the safe direction is to remove too much rather than too little. Re-granting is
       * one call; a key that should have been withdrawn and was not cannot be recalled at all. The
       * window closes on its own as instances acquire projects. */
      const res = await env.DB.batch([
        env.DB.prepare('DELETE FROM project_member WHERE project_id=? AND researcher_id=?').bind(projectId, who),
        /* ⚠ ALSO MATCHES THE STALE member_key.project_id, and that clause is not redundant — the
         * sweep found the gap it fills. `instance.project_id` is MUTABLE: /projects/assign rewrites
         * it when a container moves (and must, or authorization would follow the project the device
         * just left). So a grant minted while the device sat in THIS project is no longer matched by
         * the subquery once the device has moved to another project of the same owner — neither
         * clause fires, nothing else ever removes the row, and the removal cheerfully reports
         * grants_removed: 0 alongside ok: true.
         *
         * THREE clauses, ORed, because each alone leaves a class untouched:
         *  1. project_id=?  — the snapshot: the grant recorded WHERE IT WAS MINTED, a real project id.
         *  2. instance in this project OR still unassigned to this owner — where the device is NOW.
         *  3. project_id='' AND instance owned by this owner — the LEGACY-SENTINEL grants.
         * Clause 3 was the second sweep's finding: a grant minted while the device was unassigned
         * carries the '' sentinel (the v435 write path binds String(proj.project_id || '')), and once
         * that device is assigned into a DIFFERENT project it satisfies neither clause 1 (''≠id) nor
         * clause 2 (project_id is now the other id, not NULL, not this one). Clause 2's own
         * `project_id IS NULL` half only reaches a '' -sentinel grant while the device is STILL
         * unassigned. So the intersection "minted-while-unassigned AND since-moved-elsewhere" fell
         * through both, the grant survived removal, and GET /v1/researcher/keys — which selects by
         * researcher_id alone — kept handing it to the removed member.
         *
         * ⚠ Clause 3 is deliberately BROAD, in the same direction the whole statement already leans:
         * it removes EVERY '' -sentinel grant this member holds on any of the owner's devices, not
         * only the one that moved. For a REVOCATION that is the safe direction — re-granting is one
         * call, a key that should have been withdrawn and was not cannot be recalled — and '' only
         * ever appears on the owner's own devices, so nothing outside the owner's estate is reached. */
        env.DB.prepare(
          'DELETE FROM member_key WHERE researcher_id=? AND (project_id=? OR instance_id IN ('
          + 'SELECT instance_id FROM instance WHERE project_id=? OR (project_id IS NULL AND researcher_id=?))'
          + " OR (project_id='' AND instance_id IN (SELECT instance_id FROM instance WHERE researcher_id=?)))"
        ).bind(who, projectId, projectId, ctx.owner.researcher_id, ctx.owner.researcher_id),
      ]);
      const gone = (res && res[0] && res[0].meta && res[0].meta.changes) || 0;
      const keys = (res && res[1] && res[1].meta && res[1].meta.changes) || 0;
      await logApproval(env, request, 'member_removed', who.slice(0, 12) + '…', keys + ' grant(s)', ctx.caller.drive_email);
      return j({ ok: true, removed: gone, grants_removed: keys }, 200, origin, env);
    }
    return j({ error: 'method_not_allowed' }, 405, origin, env);
  }

  /* GET /v1/researcher/sessions — the list that makes the cap safe rather than merely annoying:
   * every browser signed in, which one you are, and enough detail to recognise a stranger. */
  if (m === 'GET' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'sessions') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    const rows = await env.DB.prepare(
      'SELECT session_id, created_at, last_seen_at, expires_at, label, ip_enc, geo FROM session '
      + 'WHERE researcher_id=? AND revoked=0 ORDER BY last_seen_at DESC'
    ).bind(r.researcher_id).all();
    const sessions = [];
    for (const row of (rows && rows.results) || []) {
      sessions.push({
        session_id: row.session_id,
        created_at: row.created_at,
        last_seen_at: row.last_seen_at,
        expires_at: row.expires_at,
        label: row.label || '',
        geo: row.geo || '',
        /* The IP is shown IN FULL and deliberately (Seth, 2026-08-17): a hash cannot answer "is that
         * my office?", which is the only question this list exists to answer. It is stored encrypted
         * at rest all the same, so a D1 dump is not a location history. */
        ip: row.ip_enc ? (await decAtRest(env, row.ip_enc)) || '' : '',
        current: row.session_id === r.session_id,
      });
    }
    return j({ sessions, cap: SESSION_CAP }, 200, origin, env);
  }

  /* POST /v1/researcher/sessions/revoke-others — the one-click answer to "that wasn't me". */
  if (m === 'POST' && seg.length === 4 && seg[1] === 'researcher' && seg[2] === 'sessions' && seg[3] === 'revoke-others') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    const res = await env.DB.prepare('UPDATE session SET revoked=1 WHERE researcher_id=? AND revoked=0 AND session_id<>?')
      .bind(r.researcher_id, r.session_id || '').run();
    return j({ ok: true, revoked: (res.meta && res.meta.changes) || 0 }, 200, origin, env);
  }

  /* DELETE /v1/researcher/sessions/<id> — revoke one. Scoped to the caller's own rows by the bind,
   * so it fails CLOSED for anyone else's session id. */
  if (m === 'DELETE' && seg.length === 4 && seg[1] === 'researcher' && seg[2] === 'sessions') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    /* ⚠ `AND revoked=0` is what makes the 404 mean anything. Without it the UPDATE still MATCHES an
     * already-revoked row, D1 reports changes=1, and revoking a dead session answers 200 — so the
     * panel would cheerfully report success for a session that was revoked days ago. SQLite counts
     * rows written, not rows whose value actually changed. */
    const res = await env.DB.prepare('UPDATE session SET revoked=1 WHERE session_id=? AND researcher_id=? AND revoked=0')
      .bind(seg[3], r.researcher_id).run();
    if (!(res.meta && res.meta.changes)) return j({ error: 'not_found' }, 404, origin, env);
    return j({ ok: true }, 200, origin, env);
  }

  // POST /v1/researcher/totp/setup — (authed) generate a pending TOTP secret + otpauth URI.
  if (m === 'POST' && seg.length === 4 && seg[1] === 'researcher' && seg[2] === 'totp' && seg[3] === 'setup') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
    const otpauth = `otpauth://totp/${encodeURIComponent('FlexText researcher')}?secret=${secret}&issuer=FlexText`;
    await env.DB.prepare('UPDATE researcher SET totp_secret_enc=? WHERE researcher_id=?').bind(await encAtRest(env, secret), r.researcher_id).run();
    return j({ secret, otpauth }, 200, origin, env);
  }

  // POST /v1/researcher/totp/enable — (authed) verify a code against the pending secret → enable +
  // return one-time backup codes (shown ONCE; stored hashed).
  if (m === 'POST' && seg.length === 4 && seg[1] === 'researcher' && seg[2] === 'totp' && seg[3] === 'enable') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    const body = await readJson(request) || {};
    const secret = await decAtRest(env, r.totp_secret_enc);
    if (!secret || !await totpVerify(secret, body.code)) return j({ error: 'bad_totp' }, 400, origin, env);
    const codes = Array.from({ length: 10 }, () => [...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(16).padStart(2, '0')).join(''));
    const hashes = await Promise.all(codes.map((c) => sha256hex(c)));
    await env.DB.prepare('UPDATE researcher SET totp_enabled=1, backup_codes=? WHERE researcher_id=?').bind(JSON.stringify(hashes), r.researcher_id).run();
    return j({ ok: true, backupCodes: codes }, 200, origin, env);
  }

  // POST /v1/researcher/totp/disable — (authed) verify a current code/backup code, then disable.
  if (m === 'POST' && seg.length === 4 && seg[1] === 'researcher' && seg[2] === 'totp' && seg[3] === 'disable') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    if (!r.totp_enabled) return j({ ok: true }, 200, origin, env);
    if (env.SIGNUP_LIMIT) { const { success } = await env.SIGNUP_LIMIT.limit({ key: `2fa:${r.researcher_id}` }); if (!success) return j({ error: 'rate_limited' }, 429, origin, env); }
    const body = await readJson(request) || {};
    const sf = await verifySecondFactor(r, env, body.code);
    if (!sf.ok) return j({ error: 'bad_totp' }, 400, origin, env);
    await env.DB.prepare('UPDATE researcher SET totp_enabled=0, totp_secret_enc=NULL, backup_codes=NULL WHERE researcher_id=?').bind(r.researcher_id).run();
    return j({ ok: true }, 200, origin, env);
  }

  // GET /v1/researcher — control-panel view: settings + instances + per-install summaries.
  if (m === 'GET' && seg.length === 2 && seg[1] === 'researcher') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    /* ⚠ SELF-HEALING PROJECT CREATION, and it is not an optimisation — without it this design has a
     * hole that opens the day after the backfill runs (Seth, 2026-08-20: "will we have a way for our
     * researchers to move forward without having to paste code in their JS consoles?").
     *
     * NOTHING creates a project at signup. The operator backfill mints one per EXISTING researcher
     * and then it is done; an account created afterwards has none. That is harmless today, but Phase
     * C authorizes from `instance.project_id`, and invariant I4 says an unresolvable grant DENIES —
     * so the new researcher would fail closed and be locked out of their own devices, with the only
     * remedy being an operator re-running a backfill nobody knew was needed.
     *
     * A one-time migration that has to be re-run for every new arrival is not a migration, it is a
     * standing chore. So the same idempotent routine runs lazily here: if the caller has no project,
     * they get one now.
     *
     * ⚠ SELF-LIMITING BY CONSTRUCTION, which is what makes it safe on a route the panel polls every
     * 12 seconds. The cost in the normal case is ONE indexed lookup on `project(owner_id)`. The
     * expensive branch runs only when that returns nothing, and its FIRST act is to write the row
     * that makes it never run again — so even if the Drive half fails, it cannot loop.
     *
     * ⚠ AND IT MUST NEVER FAIL THE DASHBOARD. A researcher whose panel will not load because their
     * project could not be minted is strictly worse off than one with no project row, so this
     * swallows and warns. The operator backfill remains as the deliberate, reportable repair. */
    if (isApproved(r, env)) {
      try {
        const mine = await env.DB.prepare('SELECT project_id FROM project WHERE owner_id=? LIMIT 1')
          .bind(r.researcher_id).first();
        if (!mine) await backfillProjectsFor(env, r, now);
      } catch (e2) { try { console.warn('lazy project mint failed for', r.researcher_id, safeErr(e2)); } catch { /* noop */ } }
    }
    /* MAINTENANCE NOTICE — an operator-set flag, read on the poll the panel already makes.
     *
     * ⚠ RIDES THIS RESPONSE ON PURPOSE. The panel polls it every 12 s, so the notice appears and
     * clears within one tick with no new request, no new route and no client polling loop. One
     * primary-key lookup on a table with at most a handful of rows, through the D1 binding, which
     * costs no Cloudflare subrequest.
     *
     * The value is set and cleared from the Actions tab (see worker/migrate-ops-flag.sql), so
     * raising the notice is never itself a deploy — which matters, because the moment you want it is
     * the moment you least want to be shipping.
     *
     * Best-effort by construction: if this read throws, the panel loses a BANNER. It must never take
     * down the dashboard that the banner is trying to warn people about. */
    let maintenance = null;
    try {
      const flag = await env.DB.prepare('SELECT value FROM ops_flag WHERE key=?').bind('maintenance').first();
      if (flag && flag.value) maintenance = String(flag.value).slice(0, 500);
    } catch { /* table absent (pre-migration) or read failed — no notice, never an error */ }
    const approved = isApproved(r, env);
    const operator = isOperator(r.drive_email, env);
    let insts = [];
    let pending;
    if (approved) {
      insts = (await env.DB.prepare(
        /* ⚠ oauth_folder_id is what lets the panel say WHICH PROJECT a device is in. The estate
         * gives folderId -> projectId; without the instance's own folder id the only join left is
         * the folder NAME, and this codebase's rule is that names are display-only and nothing is
         * ever found by them (a renamed device would silently leave its project). Additive: one
         * more column in a response, ignored by every shipped client. */
        'SELECT instance_id, type, nickname, desired_rev, revoked, estate, oauth_folder_id FROM instance WHERE researcher_id=? AND revoked=0'
      ).bind(r.researcher_id).all()).results || [];
      for (const it of insts) {
        it.installs = (await env.DB.prepare(
          // Show live installs + ones with a wipe in flight (pending/confirmed) so the panel can render
          // the wipe state; hide ordinary-revoked (unlinked) and force-removed (wipe_hidden) rows.
          'SELECT install_id, status, accepted, pair_code, reported_blob, reported_rev, ack_seq, last_seen_at, pubkey, wipe_state, wipe_at, (wrapped_key IS NOT NULL) AS has_key FROM install WHERE instance_id=? AND wipe_hidden=0 AND (revoked=0 OR wipe_state IS NOT NULL)'
        ).bind(it.instance_id).all()).results || [];
      }
      // Operators see pending researcher requests to approve/decline (fellow operators excluded).
      if (operator) {
        const rows = (await env.DB.prepare(
          'SELECT researcher_id, drive_email AS email, display_name, avatar_url, created_at FROM researcher WHERE approved=0 ORDER BY created_at'
        ).all()).results || [];
        pending = rows.filter((p) => !isOperator(p.email, env));
      }
    }
    /* ⚠ `pubkey` / `wrapped_privkey` ride this response so the panel can adopt an EXISTING keypair
     * at unlock without a round trip of its own. Without them the client's only way to discover a
     * published keypair is to generate a throwaway one and POST it to collect the 409 that carries
     * the real pair back — an RSA-2048 generation on every fresh browser session, for ever, to
     * learn something the bootstrap already had in hand.
     *
     * Additive and safe to return: `wrapped_privkey` is ciphertext under Kr, and `kr` is on the very
     * next line. It exposes nothing this response did not already expose; a client without Kr can do
     * nothing with it. The 409-adoption path stays regardless — it is what settles the race when two
     * browsers publish at the same moment, which no response field can prevent. */
    return j({ approved, is_owner: operator, pending,
               settings: r.settings_blob, settings_rev: r.settings_rev, instances: insts,
               maintenance: maintenance || undefined,
               kr: r.kr_server_enc ? await decAtRest(env, r.kr_server_enc) : undefined,
               pubkey: r.pubkey || undefined, wrapped_privkey: r.wrapped_privkey || undefined,
               email: r.drive_email || undefined }, 200, origin, env);
  }

  // POST /v1/researcher/approve {researcher_id} — an OWNER approves a pending researcher.
  if (m === 'POST' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'approve') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    if (!isOperator(r.drive_email, env)) return j({ error: 'not_owner' }, 403, origin, env);
    const body = await readJson(request) || {};
    if (!body.researcher_id) return j({ error: 'bad_body' }, 400, origin, env);
    // Read the subject BEFORE acting — after a decline the row is gone, so both paths capture it
    // the same way for symmetry (and so the log is never missing the one detail that identifies it).
    const target = await env.DB.prepare('SELECT drive_email FROM researcher WHERE researcher_id=?').bind(body.researcher_id).first();
    await env.DB.prepare('UPDATE researcher SET approved=1 WHERE researcher_id=?').bind(body.researcher_id).run();
    await logApproval(env, request, 'account_approved', (target && target.drive_email) || body.researcher_id,
                      'approved by hand', r.drive_email);
    return j({ ok: true }, 200, origin, env);
  }

  // POST /v1/researcher/decline {researcher_id} — an OWNER declines (deletes) a still-pending
  // researcher. The AND approved=0 guard means an owner can never delete an already-active account.
  if (m === 'POST' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'decline') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    if (!isOperator(r.drive_email, env)) return j({ error: 'not_owner' }, 403, origin, env);
    const body = await readJson(request) || {};
    if (!body.researcher_id) return j({ error: 'bad_body' }, 400, origin, env);
    // ⚠ MUST read the e-mail BEFORE the DELETE. This is the case that proved the log was needed:
    // declining wipes the row outright, so afterwards nothing anywhere records who it was.
    const target = await env.DB.prepare('SELECT drive_email FROM researcher WHERE researcher_id=?').bind(body.researcher_id).first();
    const res = await env.DB.prepare('DELETE FROM researcher WHERE researcher_id=? AND approved=0').bind(body.researcher_id).run();
    if ((res.meta && res.meta.changes) || 0) {
      await logApproval(env, request, 'account_declined', (target && target.drive_email) || body.researcher_id,
                        'declined and deleted', r.drive_email);
    }
    return j({ ok: true }, 200, origin, env);
  }

  /* ---- OWNER-ONLY: the pre-approved domain list ---------------------------------------------
   * Rows are keyed hashes (see migrate-approved-domains-hashed.sql), so they CANNOT be written by
   * hand — deriving domain_hash needs SERVER_HMAC_KEY, which lives only here. That is the point:
   * an auto-approval rule should require an authenticated OWNER session, never merely database
   * access. It also means the operator drives this through these endpoints rather than raw SQL.
   *
   * POST   /v1/researcher/domains        {domain, note}  — add
   * POST   /v1/researcher/domains/test   {domain|email}  — does this address auto-approve? + why
   * POST   /v1/researcher/domains/remove {domain}        — remove (name it again to re-derive)
   * GET    /v1/researcher/domains                        — list (notes + hash prefix only)
   */
  if (seg.length >= 3 && seg[1] === 'researcher' && seg[2] === 'domains') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    if (!isOperator(r.drive_email, env)) return j({ error: 'not_owner' }, 403, origin, env);
    const sub = seg[3] || '';

    if (m === 'GET' && !sub) {
      const rows = (await env.DB.prepare('SELECT domain_hash, note_enc, created_at FROM approved_domain ORDER BY created_at').all()).results || [];
      // The domain itself is UNRECOVERABLE by design — the note is what makes a row recognisable,
      // and the hash prefix is enough to match against a /test result.
      const out = [];
      for (const row of rows) {
        out.push({ hash_prefix: String(row.domain_hash).slice(0, 12), note: await decAtRest(env, row.note_enc), created_at: row.created_at });
      }
      return j({ domains: out }, 200, origin, env);
    }

    const body = await readJson(request) || {};
    // Accept a bare domain OR a full address, so pasting a real person's e-mail just works.
    const raw = String(body.domain || body.email || '').trim().toLowerCase().replace(/^@/, '');
    const d = raw.includes('@') ? emailDomain(raw) : emailDomain('x@' + raw);
    if (!d) return j({ error: 'bad_domain' }, 400, origin, env);

    if (m === 'POST' && sub === 'test') {
      // The operator's self-service check: what would actually happen to this address, and why.
      const isPublic = PUBLIC_EMAIL_DOMAINS.has(d);
      const hash = await domainKey(d, env);
      const listed = !isPublic && !!(await env.DB.prepare('SELECT domain_hash FROM approved_domain WHERE domain_hash=?').bind(hash).first());
      return j({
        domain: d, hash, hash_prefix: hash.slice(0, 12), listed,
        public_provider: isPublic,
        auto_approves: listed,
        why: isPublic ? 'refused: free-mailbox provider, never auto-approved'
           : listed ? 'auto-approves as an ordinary researcher (never owner)'
           : 'not listed: this address needs individual approval',
      }, 200, origin, env);
    }

    if (m === 'POST' && sub === 'remove') {
      const res = await env.DB.prepare('DELETE FROM approved_domain WHERE domain_hash=?').bind(await domainKey(d, env)).run();
      const removed = (res.meta && res.meta.changes) || 0;
      if (removed) await logApproval(env, request, 'domain_removed', d, '', r.drive_email);
      return j({ ok: true, domain: d, removed }, 200, origin, env);
    }

    if (m === 'POST' && !sub) {
      // Refuse a public provider AT WRITE TIME too, not only at approval time — a row that silently
      // does nothing is worse than an error, because it looks like it worked.
      if (PUBLIC_EMAIL_DOMAINS.has(d)) return j({ error: 'public_provider', domain: d }, 400, origin, env);
      await env.DB.prepare('INSERT OR REPLACE INTO approved_domain (domain_hash, note_enc, created_at) VALUES (?,?,?)')
        .bind(await domainKey(d, env), await encAtRest(env, String(body.note || '').slice(0, 200)), now).run();
      await logApproval(env, request, 'domain_added', d, String(body.note || ''), r.drive_email);
      secAlert(env, ctx, request, 'Pre-approved domain added', [
        'A domain was added to the auto-approval list: ' + d,
        'Anyone signing in with a Google account on that domain is now approved automatically.',
        'If this was not you, revoke it immediately — your owner session is compromised.',
      ]);
      return j({ ok: true, domain: d, hash_prefix: (await domainKey(d, env)).slice(0, 12) }, 200, origin, env);
    }

    return j({ error: 'not_found' }, 404, origin, env);
  }

  /* POST /v1/researcher/trash {fileIds:[…]} — RESEARCHER: move their own app-created Drive files
   * (or folders) to TRASH. Never files.delete: trash is recoverable for 30 days at
   * drive.google.com/trash, and cleanup rules are exactly the kind of thing that is occasionally
   * wrong — a survivable mistake is the design requirement (Seth). drive.file scope is the guard:
   * a file the app did not create 404s at Google, so this cannot reach anything else. The PANEL
   * decides WHAT to trash (it owns the kind classification); the Worker only enforces HOW. */
  /* ---- Drive STORAGE MANAGER (2026-08-12) — additive, researcher-authed ----
   *
   * ⚠ WHY ONE LIST CALL IS ENOUGH, and why that is also the safety property: `drive.file` scope
   * means we can only ever SEE files this app created. So an unfiltered files.list returns exactly
   * the FlexText estate and nothing else — no per-text round trip (which would be one API call per
   * text, i.e. minutes for a real account), and no way to read, report on, or destroy anything of
   * the researcher's that we did not write. The bound is structural, not careful coding. */
  /* GET /v1/researcher/drive-snapshot — the RAW listing, unprocessed: the "before" picture of the
   * estate (plans/drive-as-truth.md §17.0).
   *
   * ⚠ THIS EXISTS BECAUSE IT CANNOT BE ADDED AFTERWARDS. Drive does not version folder parentage —
   * once a folder has been moved, NOTHING in Drive records where it used to be. Every other recovery
   * step in §17 reconstructs the estate from tags, which is good, but reconstruction is not the same
   * as knowing. Taken before a migration, this file is the difference between restoring the estate
   * and re-deriving a plausible one.
   *
   * Deliberately RAW rather than the buildDriveEstate projection: a snapshot's job is to record what
   * Drive actually held, not what our current grouping logic made of it. If the projection is what
   * turns out to be wrong, a snapshot shaped by it records the same mistake.
   *
   * Reuses driveListAll exactly as drive-estate does — same call, same fields, no new Drive surface.
   * Includes the trashed set too: knowing what was ALREADY in the trash is what stops a recovery
   * from restoring things the researcher deleted on purpose.
   *
   * ⚠ The response contains folder and file NAMES — the plaintext this design is otherwise careful
   * about (§11). It is researcher-authed and covers only that researcher's own Drive, exactly like
   * drive-estate, but a saved snapshot is a map of the estate and should be kept like one. */
  if (m === 'GET' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'drive-snapshot') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    try {
      const access = await driveAccessToken(env, r);
      /* Quota rides along so a snapshot can be compared with a later one and answer "did this cost
       * anything?" — and because Drive charges per FILE OBJECT with no content deduplication, a
       * before/after is the only honest way to see what a reorganisation actually did. */
      const [live, dead, about] = await Promise.all([
        driveListAll(access, false),
        driveListAll(access, true),
        driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/about?fields=storageQuota').catch(() => null),
      ]);
      const master = (live || []).find((f) => (f.mimeType || '') === 'application/vnd.google-apps.folder'
        && ((f.appProperties || {}).flextextRole === 'uploads-master'));
      return j({
        schema: 1,
        takenAt: now,
        engine: 'worker',
        // Self-describing: a snapshot that cannot say which estate it is of is a file you will not
        // dare restore from.
        masterFolderId: (master && master.id) || '',
        counts: { live: (live || []).length, trashed: (dead || []).length },
        // `limit` is ABSENT on unlimited/pooled accounts — pass it through, never default it to 0.
        quota: (about && about.storageQuota) || null,
        files: live || [],
        trashed: dead || [],
      }, 200, origin, env);
    } catch (e) { return j({ error: e.code || 'drive_error', message: safeErr(e) }, 502, origin, env); }
  }

  if (m === 'GET' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'drive-estate') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    try {
      const access = await driveAccessToken(env, r);
      const [live, dead, about] = await Promise.all([
        driveListAll(access, false),
        driveListAll(access, true),
        driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/about?fields=storageQuota').catch(() => null),
      ]);
      const estate = buildDriveEstate(live);
      /* ⚠ THE JOIN BELONGS HERE, NOT IN THE PANEL (Seth, 2026-08-19: "a lot of these consistency
       * checks/drift guards probably need to live in the worker rather than in the client app").
       *
       * Which INSTANCE a device folder belongs to is a fact only D1 knows, and which PROJECT it sits
       * in is a fact only Drive knows. The panel had to hold both and join them, which is a second
       * place for the answer to live and therefore a place for it to be wrong — and it promptly was:
       * devices landed in "Not in a project yet" while their folders sat correctly inside the
       * project. Stamping instanceId here means there is ONE derivation of the relationship, made
       * where both halves are already in hand, and it costs a single indexed D1 read — no extra
       * Drive call at all. */
      try {
        const rows = (await env.DB.prepare(
          'SELECT instance_id, oauth_folder_id FROM instance WHERE researcher_id=? AND revoked=0'
        ).bind(r.researcher_id).all()).results || [];
        const byFolder = new Map(rows.filter((x) => x.oauth_folder_id).map((x) => [x.oauth_folder_id, x.instance_id]));
        for (const d of estate.devices || []) {
          const iid = byFolder.get(d.folderId);
          if (iid) d.instanceId = iid;
        }
      } catch { /* the estate is still correct without it; the panel falls back to its own join */ }
      /* ⚠ AND WHILE THE WHOLE TREE IS IN HAND, MIRROR IT INTO D1 — same reasoning as the join
       * above, one step further. This is the only place that holds both "which Drive project
       * folders exist" and "which container sits in each", so it is the only place that can keep
       * `project` and `instance.project_id` true to them. Costs no Drive call and, once correct,
       * no write. Never allowed to fail the estate: a researcher must be able to look at their
       * Drive when the bookkeeping is unwell. */
      try { await reconcileProjects(env, r.researcher_id, estate, now); }
      catch (e2) { try { console.warn('project reconcile skipped for', r.researcher_id, safeErr(e2)); } catch { /* noop */ } }
      const q = (about && about.storageQuota) || {};
      return j({
        /* `limit` is ABSENT on unlimited / pooled accounts. It is passed through as null and MUST
         * be read as "no limit" — a reader that defaults a missing limit to 0 shows every such
         * researcher as permanently over quota. */
        quota: {
          limit: q.limit != null ? Number(q.limit) : null,
          usage: Number(q.usage || 0),
          usageInDrive: Number(q.usageInDrive || 0),
          // Counted INSIDE usage: trashing reclaims nothing until these bytes are purged.
          usageInDriveTrash: Number(q.usageInDriveTrash || 0),
        },
        /* ⚠ SPREAD, NEVER ENUMERATE — this response listed `master`, `devices` and `texts` by name
         * and therefore SILENTLY DROPPED everything buildDriveEstate added afterwards: `projects`,
         * `unassignedFolderId` and `unassignedFolderIds`. The panel's projects card read
         * `estate.projects`, always got undefined, and rendered "Set up projects…" over an estate
         * that had already been migrated — folders moved in Drive, UI insisting nothing had
         * happened. The unassigned sweep's bootstrap deadlock was the SAME missing field.
         *
         * This is the fourth time an enumerated rebuild has eaten a field in this codebase
         * (`estate` twice, then `bundle`). buildDriveEstate's entire return is the panel's to read,
         * so spreading is both correct and the only version of this that cannot rot: a field added
         * there arrives here without anyone remembering to widen a list. */
        ...estate,
        // OUR trashed files only — what the reclaim action would actually remove.
        trashed: { n: dead.length, bytes: dead.reduce((a, f) => a + (parseInt(f.size, 10) || 0), 0) },
      }, 200, origin, env);
    } catch (e) { return j({ error: e.code || 'drive_error', message: safeErr(e) }, 502, origin, env); }
  }

  /* Move texts no device holds into "FlexText Uploads / Unassigned".
   *
   * ⚠ THE PANEL DECIDES WHICH, AND IT HAS TO: device inventories are E2EE, so the worker cannot
   * know what any device holds. It moves exactly the docIds it is given. That places the burden of
   * correctness on the caller's signal — see the panel, which drives this from diffInventory's
   * present->absent transition (the same one History tombstones use, and which yields NO events
   * when an inventory is missing or undecryptable, so a device that fails to report cannot sweep
   * its own texts away).
   *
   * Safe by construction on the Drive side: driveEnsureTextFolder resolves a text folder by id and
   * tag, NEVER by parent, so moving one changes where a human sees it and nothing else. */
  if (m === 'POST' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'drive-unassign') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    const body = await readJson(request) || {};
    const ids = (Array.isArray(body.docIds) ? body.docIds : [])
      .map((x) => String(x || '').replace(/[^\w-]/g, '').slice(0, 64)).filter(Boolean).slice(0, 200);
    if (!ids.length) return j({ error: 'bad_docids' }, 400, origin, env);
    try {
      const access = await driveAccessToken(env, r);
      /* ⚠ THE SWEEP MUST LAND A TEXT IN ITS OWN PROJECT'S Unassigned, not in some other project's.
       * A text's project is the project folder ABOVE its container, so it is resolved per text —
       * but containers repeat heavily across a batch (a sweep is usually one or two devices), so
       * one cached lookup per distinct CONTAINER is a handful of subrequests, not one per text.
       * With a flat estate every lookup returns '' and the target is the master-level folder,
       * exactly as before. */
      /* ⚠ AN EXPLICIT TARGET PROJECT overrides "each text's own" (Seth, 2026-08-20: the move modal
       * "SHOULD make it possible to move a text to a different project's unassigned box"). Absent —
       * which is every shipped client and the sweep itself — behaviour is exactly as before: each
       * text lands in the Unassigned of ITS OWN container's project. Verified to be a real project
       * folder before it is trusted, like every other id this file accepts. */
      let forceProject = '';
      const wantTarget = String(body.projectFolderId || '').replace(/[^\w-]/g, '').slice(0, 128);
      if (wantTarget) {
        try {
          const dest = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(wantTarget) + '?fields=id,appProperties');
          if (((dest.appProperties || {}).flextextRole || '') === 'project') forceProject = dest.id;
        } catch { /* unverifiable → fall back to per-text resolution rather than guessing */ }
      }
      const projectFolders = new Set();
      try {
        const pq = encodeURIComponent("appProperties has { key='flextextRole' and value='project' } and mimeType='application/vnd.google-apps.folder' and trashed=false");
        const pf = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files?spaces=drive&fields=files(id)&q=' + pq);
        for (const f of (pf.files || [])) projectFolders.add(f.id);
      } catch { /* flat estate — no projects */ }
      const containerProject = new Map();          // container folder id -> project folder id ('' = flat)
      const unassignedFor = new Map();             // project folder id -> its Unassigned folder id
      const targetFor = async (containerId) => {
        if (forceProject) {
          if (!unassignedFor.has(forceProject)) unassignedFor.set(forceProject, await driveUnassignedFolder(access, forceProject));
          return unassignedFor.get(forceProject);
        }
        if (!projectFolders.size) {
          if (!unassignedFor.has('')) unassignedFor.set('', await driveUnassignedFolder(access, ''));
          return unassignedFor.get('');
        }
        if (!containerProject.has(containerId)) {
          let proj = '';
          try {
            const c = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(containerId) + '?fields=id,parents');
            const up = (c.parents || [])[0] || '';
            proj = projectFolders.has(up) ? up : '';
          } catch { proj = ''; }
          containerProject.set(containerId, proj);
        }
        const proj = containerProject.get(containerId);
        if (!unassignedFor.has(proj)) unassignedFor.set(proj, await driveUnassignedFolder(access, proj));
        return unassignedFor.get(proj);
      };
      /* ⚠ BOUNDED BELOW THE SUBREQUEST CAP — this route accepted 200 docIds and spent up to THREE
       * Drive subrequests on each (tag search + re-parent PATCH + tag PATCH). That is ~600 against a
       * ~50 ceiling, so a full batch could never have completed; it would have died mid-sweep with
       * some folders moved, some not, and no way for the caller to know which. It had never bitten
       * only because the route had no callers at all — wiring one up is exactly what would have
       * found it the hard way. Same shape as the trash route: do what fits, report the rest.
       *
       * 12 ids x 3 = 36, + the token fetch + the Unassigned-folder resolve = 38, clear of 50. The
       * caller drains `remainingIds` on its next sweep; the route is idempotent, so re-sending an
       * id that already moved costs one search and does nothing. */
      // 10, down from 12: the per-text work is unchanged at 3 subrequests, but the project/container
      // resolution above costs a few more up front. 10x3 + ~6 = 36, still clear of the ~50 ceiling.
      const CAP = 10, BUDGET_MS = 9000;
      const started = Date.now();
      let moved = 0, i = 0;
      for (; i < ids.length && i < CAP && (Date.now() - started) < BUDGET_MS; i++) {
        const id = ids[i];
        try {
          const q = encodeURIComponent(`appProperties has { key='flextextDoc' and value='${id}' } and mimeType='application/vnd.google-apps.folder' and trashed=false`);
          const found = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files?spaces=drive&orderBy=createdTime&fields=files(id,parents)&q=' + q);
          const f = (found.files || [])[0];
          if (!f) continue;                                  // no folder (legacy text) — nothing to move
          const target = await targetFor((f.parents || [])[0] || '');
          if (!target) continue;
          if ((f.parents || []).includes(target)) continue;   // already there — idempotent
          await driveReparent(access, f.id, target, f.parents);
          // Tagged so the RETURN trip can tell "we swept this" from "the researcher filed it here".
          await driveJson(access, 'PATCH', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(f.id) + '?fields=id',
            { appProperties: { flextextUnassigned: '1' } });
          moved++;
        } catch { /* one text failing must not abort the sweep */ }
      }
      // A COUNT plus the ids, matching drive-purge and the trash route so a caller can loop on
      // `remaining` without learning a third convention.
      const remainingIds = ids.slice(i);
      // `folderId` kept for shipped clients: with several projects there is no single target, so it
      // reports the first one used. Nothing reads it as authoritative.
      return j({ moved, folderId: [...unassignedFor.values()][0] || '',
                 remaining: remainingIds.length, remainingIds }, 200, origin, env);
    } catch (e) { return j({ error: e.code || 'drive_error', message: safeErr(e) }, 502, origin, env); }
  }

  /* PROJECT MIGRATION — insert the project layer, and take it back out again.
   *
   *   before:  FlexText Uploads / <container> / <text>
   *   after:   FlexText Uploads / <Project> / <container> / <text>
   *
   * ⚠ DRY RUN FIRST, AND IT REALLY IS DRY — it creates nothing, not even the project folder. A repair
   * or migration tool that acts before you have read its plan is how a tangle becomes a disaster
   * (§17.3): by the time anyone reaches for one, the estate is already in a state nobody predicted.
   *
   * Re-parenting is METADATA ONLY. No bytes move, folder ids are preserved, and every id held in D1,
   * in a client's memory or in a minted URL stays valid — which is what makes this safe to run on a
   * live estate and safe to reverse afterwards.
   *
   * POST /v1/researcher/projects/migrate { name, dry }
   *   name: the DEFAULT project's folder name, supplied by the client so it can be localized —
   *         the worker has no idea what language the researcher reads.
   */
  if (m === 'POST' && seg.length === 4 && seg[1] === 'researcher' && seg[2] === 'projects'
      && (seg[3] === 'migrate' || seg[3] === 'unmigrate')) {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    const body = await readJson(request) || {};
    const dry = body.dry !== false;                    // ⚠ DEFAULTS TO DRY. Acting must be deliberate.
    const forward = seg[3] === 'migrate';
    try {
      const access = await driveAccessToken(env, r);
      const master = await driveMasterFolder(access);
      const kids = await driveJson(access, 'GET',
        'https://www.googleapis.com/drive/v3/files?spaces=drive&fields=files(id,name,parents,appProperties)&q='
        + encodeURIComponent(`'${master}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`));
      const roleOf = (f) => (f.appProperties || {}).flextextRole || '';
      const projectFolder = ((kids.files || []).find((f) => roleOf(f) === 'project') || {}).id || '';

      if (forward) {
        /* Containers are everything under master that is not the project folder itself and not a
         * text. Device folders (untagged), crowd folders and the account-level Unassigned all move —
         * the last one becoming the default project's Unassigned, which is exactly §16.16's shape. */
        const movers = (kids.files || []).filter((f) => roleOf(f) !== 'project'
          && !(f.appProperties || {}).flextextDoc);
        const plan = movers.map((f) => ({ id: f.id, name: f.name || '', kind: roleOf(f) || 'device' }));
        if (dry) {
          return j({ ok: true, dry: true, direction: 'migrate', projectFolderId: projectFolder,
                     wouldCreateProject: !projectFolder, moves: plan, count: plan.length }, 200, origin, env);
        }
        const target = projectFolder || await driveEnsureDefaultProject(access, body.name);
        /* Bounded like every Drive loop here: one PATCH per container, plus the handful above. A real
         * estate has a few containers, so a single pass finishes — but `remaining` exists so an
         * unusually large one drains over successive calls rather than dying halfway. */
        const CAP = 20;
        let moved = 0, i = 0;
        for (; i < movers.length && i < CAP; i++) {
          try { await driveReparent(access, movers[i].id, target, movers[i].parents); moved++; }
          catch { /* one container failing must not abort the rest */ }
        }
        await logApproval(env, request, 'projects_migrate', 'default', moved + ' container(s)', r.drive_email);
        return j({ ok: true, dry: false, direction: 'migrate', projectFolderId: target, moved,
                   remaining: Math.max(0, movers.length - i) }, 200, origin, env);
      }

      /* UNMIGRATE — §17.2/§17.4 step 2. Puts every container back directly under master, so the tree
       * returns to the shape a pre-project worker reads. The dual-shape estate means the CURRENT
       * worker reads both, so this is safe to run before or after a rollback, in either order. */
      if (!projectFolder) return j({ ok: true, dry, direction: 'unmigrate', moves: [], count: 0, note: 'already_flat' }, 200, origin, env);
      const inside = await driveJson(access, 'GET',
        'https://www.googleapis.com/drive/v3/files?spaces=drive&fields=files(id,name,parents,appProperties)&q='
        + encodeURIComponent(`'${projectFolder}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`));
      const back = (inside.files || []).filter((f) => !(f.appProperties || {}).flextextDoc);
      const plan = back.map((f) => ({ id: f.id, name: f.name || '', kind: roleOf(f) || 'device' }));
      if (dry) {
        return j({ ok: true, dry: true, direction: 'unmigrate', projectFolderId: projectFolder,
                   moves: plan, count: plan.length,
                   wouldTrashProject: plan.length === (inside.files || []).length }, 200, origin, env);
      }
      let moved = 0, i = 0; const movedIds = [];
      for (; i < back.length && i < 20; i++) {
        try { await driveReparent(access, back[i].id, master, back[i].parents); moved++; movedIds.push(back[i].id); }
        catch { /* keep going */ }
      }
      /* Trash the project folder only when it is EMPTY — never with anything still inside. Trash is
       * reversible for 30 days and this folder holds nothing, so it is the one deletion-shaped act
       * in the whole migration, and it is bounded to a container we created and just emptied. */
      let trashedProject = false;
      if (moved === back.length) {
        try {
          const left = await driveJson(access, 'GET',
            'https://www.googleapis.com/drive/v3/files?spaces=drive&fields=files(id)&q='
            + encodeURIComponent(`'${projectFolder}' in parents and trashed=false`));
          if (!(left.files || []).length) {
            await driveJson(access, 'PATCH', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(projectFolder) + '?fields=id', { trashed: true });
            trashedProject = true;
          }
        } catch { /* leaving an empty project folder is harmless — the estate reads both shapes */ }
      }
      /* ⚠ FORGET IT IN D1 TOO. The Drive move above is only half the un-migration; without this the
       * project row, its memberships and every moved device's stale project_id survive, and authMember
       * keeps honouring a coworker's manageDevices over a project the owner just dismantled (uncovered
       * sweep #7). Gated on trashedProject for the project/member deletion so a partial move never tears
       * down a project still holding containers. Best-effort: a D1 hiccup must not fail an unmigration
       * whose Drive half already succeeded — reconcile will not undo the folder move, so a stale row is
       * recoverable, but a failed HTTP response would make the caller retry the Drive work needlessly. */
      let d1teardown = { unassigned: 0, forgottenProjectId: null };
      try { d1teardown = await teardownUnmigratedProjectRows(env.DB, r.researcher_id, movedIds, projectFolder, trashedProject); }
      catch (e) { try { await secLog(env, request, 'unmigrate_d1_teardown_failed', { error: String((e && e.message) || e).slice(0, 120) }); } catch { /* noop */ } }
      await logApproval(env, request, 'projects_unmigrate', 'default', moved + ' container(s)', r.drive_email);
      return j({ ok: true, dry: false, direction: 'unmigrate', moved, trashedProject,
                 forgotten: d1teardown.forgottenProjectId, unassigned: d1teardown.unassigned,
                 remaining: Math.max(0, back.length - i) }, 200, origin, env);
    } catch (e) { return j({ error: e.code || 'drive_error', message: safeErr(e) }, 502, origin, env); }
  }

  /* POST /v1/researcher/projects/create { name } — a SECOND (third, fourth…) project.
   *
   * ⚠ NEVER tagged `flextextDefault`. That tag marks the ONE folder new containers fall back into
   * when nothing else says where they belong (`driveDefaultProjectFolder`), so a second folder
   * carrying it would make that lookup ambiguous — `orderBy=createdTime` would silently pick the
   * older one and every new device would land in whichever project happened to be created first.
   * Exactly one default, minted by the migration, forever. */
  if (m === 'POST' && seg.length === 4 && seg[1] === 'researcher' && seg[2] === 'projects' && seg[3] === 'create') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    const body = await readJson(request) || {};
    const name = String(body.name || '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 120);
    if (!name) return j({ error: 'bad_body' }, 400, origin, env);
    try {
      const access = await driveAccessToken(env, r);
      const f = await driveJson(access, 'POST', 'https://www.googleapis.com/drive/v3/files?fields=id',
        { name, mimeType: 'application/vnd.google-apps.folder',
          parents: [await driveMasterFolder(access)],
          appProperties: { flextextRole: 'project' } });
      /* ⚠ ONE ACT WRITES BOTH, which is what keeps the two namespaces from drifting. The Drive
       * folder holds the bytes; the D1 row is what `project_member`, `member_key` and
       * `instance.project_id` key on. Creating one without the other is how they got out of step in
       * the first place — every Drive project folder in production today has no D1 row at all.
       *
       * ⚠ THE D1 WRITE IS NOT ALLOWED TO FAIL THE REQUEST. The folder already exists at this point;
       * throwing here would leave the user with a project they can see in Drive and an error on
       * screen, and a retry would mint a SECOND folder. A missing row is recoverable by the
       * idempotent backfill; a duplicate folder is not recoverable at all. */
      try {
        await env.DB.prepare('INSERT INTO project (project_id, owner_id, name, created_at, drive_folder_id) VALUES (?,?,?,?,?)')
          .bind(crypto.randomUUID(), r.researcher_id, name, now, f.id).run();
      } catch (e2) { try { console.warn('project row not written for', f.id, safeErr(e2)); } catch { /* noop */ } }
      await logApproval(env, request, 'project_created', name, f.id, r.drive_email);
      return j({ ok: true, folderId: f.id, name }, 200, origin, env);
    } catch (e) { return j({ error: e.code || 'drive_error', message: safeErr(e) }, 502, origin, env); }
  }

  /* POST /v1/researcher/projects/assign { folderId, projectFolderId } — move ONE container (a device
   * folder or a crowd recorder folder) into a project. Its texts ride along as children.
   *
   * ⚠ THIS COMMENT USED TO SAY "DRIVE PARENTAGE IS THE ONLY RECORD", and the reasoning was right at
   * the time: writing a DRIVE folder id into `instance.project_id` — a column holding GUIDs from a
   * `project` table that had been applied to no database — would have put a second,
   * differently-shaped answer to "which project is this in" into a second store.
   *
   * What changed is that the two shapes are now JOINED (`project.drive_folder_id`, 2026-08-20), so
   * the D1 project for a Drive folder is a lookup rather than a guess. That makes the objection
   * answerable, and it makes the update REQUIRED: Phase C authorizes from `instance.project_id`, so
   * a container that moved in Drive while D1 still said otherwise would be authorized against the
   * project it just left.
   *
   * ⚠ SO BOTH ARE WRITTEN IN ONE ACT (invariant I3). They cannot drift because nothing updates one
   * without the other — not because anyone remembers to. Drive still holds the bytes and the panel
   * still reads the estate; D1 answers "who may act on this", and only that.
   *
   * ⚠ NO MATCHING D1 PROJECT ⇒ project_id IS CLEARED, NOT LEFT STALE. A Drive folder with no D1 row
   * is a project Phase C cannot authorize against, and NULL means exactly that — unscoped, failing
   * closed (I4). Leaving the old value would be the one genuinely dangerous outcome: authorization
   * against a project the container is demonstrably no longer in.
   *
   * ⚠ A container keeps its folder ID across the move, so nothing that resolves by id notices —
   * pending uploads, minted URLs and the device's own record all keep working mid-move. */
  if (m === 'POST' && seg.length === 4 && seg[1] === 'researcher' && seg[2] === 'projects' && seg[3] === 'assign') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    const body = await readJson(request) || {};
    const folderId = String(body.folderId || '').replace(/[^\w-]/g, '').slice(0, 128);
    const projectFolderId = String(body.projectFolderId || '').replace(/[^\w-]/g, '').slice(0, 128);
    if (!folderId || !projectFolderId) return j({ error: 'bad_body' }, 400, origin, env);
    try {
      const access = await driveAccessToken(env, r);
      // Both ends verified before anything moves: a project that is really a project, and a container
      // that is really a container (never a TEXT — moving one of those would re-home somebody's work).
      const dest = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(projectFolderId) + '?fields=id,appProperties');
      if (((dest.appProperties || {}).flextextRole || '') !== 'project') return j({ error: 'not_a_project' }, 400, origin, env);
      const src = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(folderId) + '?fields=id,name,parents,appProperties,mimeType');
      const role = (src.appProperties || {}).flextextRole || '';
      if ((src.appProperties || {}).flextextDoc) return j({ error: 'is_a_text' }, 400, origin, env);
      if (role && role !== 'crowd') return j({ error: 'not_a_container' }, 400, origin, env);
      if (src.mimeType !== 'application/vnd.google-apps.folder') return j({ error: 'not_a_container' }, 400, origin, env);
      await driveReparent(access, src.id, projectFolderId, src.parents);
      /* Keep D1 in step with the move — see the note above. Scoped to the caller's own rows, so this
       * can never re-home somebody else's container, and matched on oauth_folder_id because that is
       * how a container is identified in Drive. */
      try {
        const destRow = await env.DB.prepare('SELECT project_id FROM project WHERE drive_folder_id=? AND owner_id=?')
          .bind(projectFolderId, r.researcher_id).first();
        const newPid = destRow ? destRow.project_id : null;
        await env.DB.batch([
          env.DB.prepare('UPDATE instance SET project_id=? WHERE oauth_folder_id=? AND researcher_id=?')
            .bind(newPid, folderId, r.researcher_id),
          env.DB.prepare('UPDATE crowd_recorder SET project_id=? WHERE oauth_folder_id=? AND researcher_id=?')
            .bind(newPid, folderId, r.researcher_id),
        ]);
      } catch (e2) { try { console.warn('project_id not updated for', folderId, safeErr(e2)); } catch { /* noop */ } }
      await logApproval(env, request, 'project_assign', src.name || folderId, projectFolderId, r.drive_email);
      return j({ ok: true, folderId, projectFolderId }, 200, origin, env);
    } catch (e) { return j({ error: e.code || 'drive_error', message: safeErr(e) }, 502, origin, env); }
  }

  /* POST /v1/researcher/projects/rename { folderId, name } — the researcher names their own project
   * (Seth, 2026-08-19). Display only: the folder is found by its `flextextDefault` / `flextextProject`
   * TAG, never by name, so a rename cannot orphan a device folder, a text, or a pending upload. */
  if (m === 'POST' && seg.length === 4 && seg[1] === 'researcher' && seg[2] === 'projects' && seg[3] === 'rename') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    const body = await readJson(request) || {};
    const folderId = String(body.folderId || '').replace(/[^\w-]/g, '').slice(0, 128);
    const name = String(body.name || '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 120);
    if (!folderId || !name) return j({ error: 'bad_body' }, 400, origin, env);
    try {
      const access = await driveAccessToken(env, r);
      // Verify it IS one of ours before renaming — drive.file already bounds us to app-created files,
      // but a role check keeps an accidental id from renaming a text folder.
      const f = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(folderId) + '?fields=id,appProperties');
      if (((f.appProperties || {}).flextextRole || '') !== 'project') return j({ error: 'not_a_project' }, 400, origin, env);
      await driveJson(access, 'PATCH', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(folderId) + '?fields=id', { name });
      /* Keep D1's copy in step in the SAME act (invariant I3). The estate reconcile would catch this
       * on the next panel load anyway, but relying on that would leave a window where the sharing UI
       * names a project something its owner has just renamed away from. Scoped to the caller's own
       * row, and never allowed to fail a rename that already succeeded in Drive. */
      try {
        await env.DB.prepare('UPDATE project SET name=? WHERE drive_folder_id=? AND owner_id=?')
          .bind(name, folderId, r.researcher_id).run();
      } catch (e2) { try { console.warn('project name not updated for', folderId, safeErr(e2)); } catch { /* noop */ } }
      return j({ ok: true, folderId, name }, 200, origin, env);
    } catch (e) { return j({ error: e.code || 'drive_error', message: safeErr(e) }, 502, origin, env); }
  }

  /* Permanently delete the FlexText files that are ALREADY IN TRASH — the only way trashing ever
   * reclaims quota, since usageInDriveTrash counts inside usage.
   *
   * ⚠⚠ DELIBERATELY NOT files.emptyTrash. That empties the user's ENTIRE Drive trash — their
   * unrelated personal files included — and needs a broader scope than drive.file. Deleting our own
   * trashed files one by one is precise, bounded by the scope to things we created, and is what the
   * button in the panel actually claims to do. */
  if (m === 'POST' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'drive-purge') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    try {
      const access = await driveAccessToken(env, r);
      const dead = await driveListAll(access, true);
      /* ⚠ BOUNDED PER REQUEST. Each delete is a SUBREQUEST, and a Worker has a hard per-request
       * subrequest cap (50 on the free plan). The first version looped over every trashed file, so
       * a researcher who had been testing removals for a while blew the cap — and that runtime
       * error is NOT catchable by the try below, it kills the whole request. Reported as "Reclaim
       * space throws an error", with the count of trashed files as the hidden variable, which is
       * why it worked in testing and failed in use.
       * The caller repeats while `remaining` > 0, so a large backlog still clears — just in several
       * requests, each of which is individually safe. */
      /* ⚠ TWO INDEPENDENT LIMITS, and fixing only the first is why this failed twice.
       *   1. SUBREQUESTS: a Worker has a hard per-request cap (50 free), so the batch is bounded.
       *   2. WALL CLOCK: the CLIENT aborts at REQ_TIMEOUT_MS (20 s). 40 SEQUENTIAL Drive deletes at
       *      ~500 ms each is exactly 20 s, which surfaced as "The operation was aborted" — a
       *      different error from the first failure, with the same root cause of an unbounded loop.
       * So: delete in PARALLEL waves (wall time is one round trip per wave, not per file), keep the
       * count under the subrequest cap, AND stop on a time budget so a slow Drive can never walk
       * into the client's timeout however fast each call nominally is. */
      const CAP = 24, WAVE = 8, BUDGET_MS = 9000;
      const started = Date.now();
      let deleted = 0, bytes = 0, seen = 0;
      for (let i = 0; i < dead.length && seen < CAP && (Date.now() - started) < BUDGET_MS; i += WAVE) {
        const wave = dead.slice(i, i + WAVE);
        seen += wave.length;
        const results = await Promise.all(wave.map(async (f) => {
          try {
            await driveJson(access, 'DELETE', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(f.id));
            return parseInt(f.size, 10) || 0;
          } catch {
            /* Expected and ignored: deleting a trashed FOLDER takes its children with it, so a
             * child listed alongside its parent is already gone by the time we reach it. A file
             * that fails for any other reason simply stays trashed and is retried on the next
             * pass — `remaining` counts what we ATTEMPTED, so the caller's loop still terminates. */
            return null;
          }
        }));
        for (const b of results) if (b !== null) { deleted++; bytes += b; }
      }
      const remaining = Math.max(0, dead.length - seen);
      await logApproval(env, request, 'drive_purged', deleted + ' file(s)', Math.round(bytes / 1048576) + ' MB', r.drive_email);
      return j({ deleted, bytes, remaining }, 200, origin, env);
    } catch (e) { return j({ error: e.code || 'drive_error', message: safeErr(e) }, 502, origin, env); }
  }

  if (m === 'POST' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'trash') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    const body = await readJson(request) || {};
    const ids = (Array.isArray(body.fileIds) ? body.fileIds : []).map((x) => String(x || '').replace(/[^\w-]/g, '').slice(0, 90)).filter(Boolean);
    if (!ids.length || ids.length > 100) return j({ error: 'bad_fileids' }, 400, origin, env);
    try {
      const access = await driveAccessToken(env, r);
      /* ⚠ WAVES, A CAP AND A TIME BUDGET — the same treatment drive-purge already carries, and for
       * the same reason it needed it twice. This accepted 100 ids and issued 100 SEQUENTIAL PATCHes
       * against a Worker's hard per-request subrequest cap (50 on the free plan). Past ~49 the
       * request dies with a RUNTIME error the try/catch below cannot see, so the researcher learns
       * nothing and the estate is left half-trashed. It is reachable today from the panel's backup
       * cleanup on a text with ~49+ older backups.
       *
       *   - WAVE: parallel, so wall time is one round trip per wave rather than per file;
       *   - CAP:  well under 50, leaving headroom for the token fetch and the audit write;
       *   - BUDGET_MS: stops early if Drive is slow, so a bad day cannot walk into the wall either.
       *
       * Anything not reached comes back in `remaining` and the caller may simply call again. That is
       * additive: an older panel that ignores the field reports the smaller count, which is TRUE —
       * honest partial progress instead of a crash with an unknown outcome. */
      // CAP 45, not 40: the 41-49 band completes today (sequential PATCHes + one token fetch stay
      // under 50; D1 goes through the binding and costs no subrequest), so a lower cap would make
      // this route newly fall SHORT on runs that currently succeed. 45 + 1 = 46, clear of the cap.
      const CAP = 45, WAVE = 8, BUDGET_MS = 9000;
      const started = Date.now();
      const results = [];
      let i = 0;
      for (; i < ids.length && results.length < CAP && (Date.now() - started) < BUDGET_MS; i += WAVE) {
        const wave = ids.slice(i, Math.min(i + WAVE, i + (CAP - results.length)));
        const settled = await Promise.all(wave.map(async (id) => {
          try {
            await driveJson(access, 'PATCH', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?fields=id', { trashed: true });
            return { id, ok: true };
          } catch (e) { return { id, ok: false, error: safeErr(e).slice(0, 80) }; }
        }));
        results.push(...settled);
      }
      /* ⚠ A COUNT, not an array — `drive-purge` already returns `remaining` as a number and the
       * panel loops on `if (!r.remaining) break;`. An empty array is TRUTHY, so the same name
       * meaning the opposite thing would hand the next person a loop that never terminates. */
      const remainingIds = ids.slice(results.length);
      const remaining = remainingIds.length;
      await logApproval(env, request, 'files_trashed', results.filter((x) => x.ok).length + ' file(s)', (body.note || '').slice(0, 120), r.drive_email);
      return j({ results, trashed: results.filter((x) => x.ok).length, remaining, remainingIds }, 200, origin, env);
    } catch (e) { return j({ error: e.code || 'drive_error', message: safeErr(e) }, 502, origin, env); }
  }

  /* GET /v1/researcher/drive-file/<fileId> — RESEARCHER: stream one of their own app-created Drive
   * files back through the Worker. Exists for the panel's download-all-as-ZIP: the browser cannot
   * fetch drive.usercontent.google.com cross-origin (CORS), so the bytes route through here with
   * the researcher's own token instead. drive.file scope is the guard — a file the app did not
   * create simply 404s at Google, so this cannot become a general Drive reader. Free egress. */
  if (m === 'GET' && seg.length === 4 && seg[1] === 'researcher' && seg[2] === 'drive-file') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    const fileId = String(seg[3] || '').replace(/[^\w-]/g, '').slice(0, 90);
    if (!fileId) return j({ error: 'bad_file' }, 400, origin, env);
    try {
      const access = await driveAccessToken(env, r);
      const g = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media', {
        headers: { Authorization: 'Bearer ' + access },
      });
      if (!g.ok) return j({ error: g.status === 404 ? 'not_found' : 'drive_error', status: g.status }, g.status === 404 ? 404 : 502, origin, env);
      const h = new Headers(v1Cors(origin, env));
      h.set('content-type', g.headers.get('content-type') || 'application/octet-stream');
      const len = g.headers.get('content-length'); if (len) h.set('content-length', len);
      h.set('Cache-Control', 'no-store');
      return new Response(g.body, { status: 200, headers: h });
    } catch (e) { return j({ error: e.code || 'drive_error', message: safeErr(e) }, 502, origin, env); }
  }

  /* GET /v1/researcher/approvals — OWNER only. The append-only access-control history: every
   * account that appeared, was approved, auto-approved or declined, and every domain added or
   * removed. Read-only by design; nothing in the app writes here except logApproval(), and nothing
   * anywhere updates or deletes a row. An audit log you can edit is not an audit log. */
  if (m === 'GET' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'approvals') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    if (!isOperator(r.drive_email, env)) return j({ error: 'not_owner' }, 403, origin, env);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1), 1000);
    let rows = [];
    try {
      rows = (await env.DB.prepare('SELECT at, kind, subject, detail, actor FROM approval_log ORDER BY at DESC, id DESC LIMIT ?')
        .bind(limit).all()).results || [];
    } catch {
      // Table not migrated yet → an empty log, not a 500. The panel then shows "nothing recorded"
      // rather than an error the owner cannot act on.
      return j({ approvals: [], unavailable: true }, 200, origin, env);
    }
    return j({ approvals: rows }, 200, origin, env);
  }

  // PUT /v1/researcher/settings — cloud-backed researcher settings (incl. lock passphrase).
  if (m === 'PUT' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'settings') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    if (!isApproved(r, env)) return j({ error: 'pending_approval' }, 403, origin, env);
    const body = await readJson(request);
    if (!body || typeof body.settings === 'undefined') return j({ error: 'bad_body' }, 400, origin, env);
    // Optimistic concurrency: if the client sends the base rev it read, require it to still match so two
    // unlocked researcher tabs can't silently clobber each other (which would orphan an instance's wrapped
    // Ki forever). On a 409 the client re-GETs, re-applies its change, and retries. Legacy callers that
    // omit settings_rev keep the old last-writer-wins behavior.
    if (typeof body.settings_rev === 'number') {
      const res = await env.DB.prepare('UPDATE researcher SET settings_blob=?, settings_rev=settings_rev+1 WHERE researcher_id=? AND settings_rev=?')
        .bind(JSON.stringify(body.settings), r.researcher_id, body.settings_rev).run();
      if (!res.meta.changes) return j({ error: 'conflict', settings_rev: r.settings_rev }, 409, origin, env);
      return j({ ok: true, settings_rev: body.settings_rev + 1 }, 200, origin, env);
    }
    await env.DB.prepare('UPDATE researcher SET settings_blob=?, settings_rev=settings_rev+1 WHERE researcher_id=?')
      .bind(JSON.stringify(body.settings), r.researcher_id).run();
    return j({ ok: true, settings_rev: r.settings_rev + 1 }, 200, origin, env);
  }

  // POST /v1/instances — create an instance with a required nickname. Type is now UNIFIED: a device
  // is ONE logical install per browser profile that may run BOTH apps (editor + recorder share keys
  // /storage same-origin), so we no longer pin a type at creation. Stored as '' for unified (no
  // migration needed — '' is falsy, so the claim's type check is skipped); legacy 'editor'/'recorder'
  // still accepted for old instances.
  if (m === 'POST' && seg.length === 2 && seg[1] === 'instances') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    if (!isApproved(r, env)) return j({ error: 'pending_approval' }, 403, origin, env);
    const body = await readJson(request);
    const type = (body && body.type) || '';          // '' = unified (claim by either app); legacy may send a type
    const nickname = body && (body.nickname || '').trim();
    if (type !== '' && type !== 'editor' && type !== 'recorder') return j({ error: 'bad_type' }, 400, origin, env);
    if (!nickname) return j({ error: 'nickname_required' }, 400, origin, env);
    const instance_id = crypto.randomUUID();
    /* ⚠ ESTATE IS STAMPED 'cloud' UNCONDITIONALLY (Seth, 2026-08-05). Every NEW instance belongs to
     * the Cloudflare apps — that is a policy decision, not an observation, so it is deliberately
     * NOT inferred from the request Origin. An origin header describes which panel happened to
     * make the call (a researcher may still be using the old one, and it is client-controlled
     * anyway); it is the wrong source of truth for what a new coworker should install.
     * Existing rows keep 'pages' via the column default — see migrate-estate.sql. */
    await env.DB.prepare(
      'INSERT INTO instance (instance_id, researcher_id, type, nickname, desired_blob, desired_rev, revoked, created_at, estate) VALUES (?,?,?,?,?,0,0,?,?)'
    ).bind(instance_id, r.researcher_id, type, nickname, JSON.stringify({ settings: {}, commands: [] }), now, 'cloud').run();
    /* ⚠ CREATE THE DEVICE FOLDER EAGERLY WHEN A PROJECT IS NAMED — the only way a new device can land
     * in the project the researcher is actually looking at.
     *
     * Normally the folder is created lazily, on first upload, and its parent comes from
     * `driveProjectFolderFor` which falls back to the DEFAULT project. That is right when nobody has
     * said otherwise, and wrong the moment there are several projects: every new device would appear
     * in the default one regardless of where it was created.
     *
     * Eager creation also makes Drive PARENTAGE the record from birth, which is the same single
     * authority everything else here uses — no `project_id` written anywhere, nothing to drift.
     * Best-effort: a Drive failure must not lose the instance that was just created, so the device
     * simply falls back to the lazy path and the default project. */
    const wantProject = String((body && body.projectFolderId) || '').replace(/[^\w-]/g, '').slice(0, 128);
    let folderId = '';
    if (wantProject) {
      try {
        const access = await driveAccessToken(env, r);
        const dest = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(wantProject) + '?fields=id,appProperties');
        if (((dest.appProperties || {}).flextextRole || '') === 'project') {
          /* ⚠ STAMP D1 TOO, and only from a folder just VERIFIED to be a project of this researcher.
           *
           * This route deliberately writes no project_id in the INSERT — Drive parentage is the
           * authority, and the note above explains why nothing should drift from it. But leaving it
           * NULL means every NEW device enters the dual-read window, so the window never closes, and
           * a MEMBER cannot manage a device until the owner happens to open the panel and let
           * reconcileProjects catch up. That is a functional gap rather than a hole — the legacy
           * branch only ever admits the instance's own researcher_id — but it is one a member would
           * experience as "the new phone is missing" with nothing to explain it.
           *
           * Not drift: it is the same join `/projects/assign` already performs, keyed on the folder
           * whose role was checked one line above. If the lookup finds nothing the device simply
           * stays unassigned, which is exactly today's behaviour. */
          try {
            const prow = await env.DB.prepare('SELECT project_id FROM project WHERE drive_folder_id=? AND owner_id=?')
              .bind(wantProject, r.researcher_id).first();
            if (prow && prow.project_id) {
              await env.DB.prepare('UPDATE instance SET project_id=? WHERE instance_id=? AND project_id IS NULL')
                .bind(prow.project_id, instance_id).run();
            }
          } catch (e2) { try { console.warn('project_id not stamped for', instance_id, safeErr(e2)); } catch { /* noop */ } }
          folderId = await driveEnsureDeviceFolder(env, access, instance_id, nickname, '', wantProject);
        }
      } catch { /* the instance exists; the folder can still be made lazily */ }
    }
    return j({ instance_id, type, nickname, estate: 'cloud', folderId }, 200, origin, env);
  }

  // Routes under /v1/instances/<id>/...
  if (seg.length >= 3 && seg[1] === 'instances') {
    const instanceId = seg[2];
    const sub = seg[3];

    // POST .../rename — edit the nickname anytime.
    if (m === 'POST' && sub === 'rename' && seg.length === 4) {
      const ctx = await authMember(request, env, { instance: instanceId }, 'manageDevices');
      if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);
      if (!ctx.ok) return j({ error: 'not_found' }, 404, origin, env);
      const r = ctx.owner;   // the PROJECT OWNER's row: Drive acts in their account (R2-5)
      const body = await readJson(request);
      const nickname = body && (body.nickname || '').trim();
      if (!nickname) return j({ error: 'nickname_required' }, 400, origin, env);
      const res = await env.DB.prepare('UPDATE instance SET nickname=? WHERE instance_id=? AND researcher_id=?')
        .bind(nickname, instanceId, r.researcher_id).run();
      if (!res.meta.changes) return j({ error: 'not_found' }, 404, origin, env);
      // Best-effort: rename the device's Drive upload folder to match (the id is
      // what's tracked, so a failure here costs only a stale folder NAME).
      try {
        const inst = await env.DB.prepare('SELECT oauth_folder_id FROM instance WHERE instance_id=?').bind(instanceId).first();
        if (inst && inst.oauth_folder_id && r.drive_refresh_enc) {
          const access = await driveAccessToken(env, r);
          await driveJson(access, 'PATCH', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(inst.oauth_folder_id) + '?fields=id', { name: nickname });
        }
      } catch { /* cosmetic only */ }
      /* ⚠ ATTRIBUTION. Recorded with ctx.caller — WHO ACTED — never ctx.owner, whose Drive the work
       * runs against. They are the same researcher for an owner, which is exactly why conflating them
       * would pass every test today and name the wrong person the day sharing ships. Nobody can
       * reconstruct an actor after the fact, so this has to be written at the moment it happens. */
      await logApproval(env, request, 'device_renamed', instanceId.slice(0, 12) + '…', nickname, ctx.caller.drive_email);
      return j({ ok: true }, 200, origin, env);
    }

    // POST .../invite — mint a one-time invite (returns the secret ONCE).
    if (m === 'POST' && sub === 'invite' && seg.length === 4) {
      const ctx = await authMember(request, env, { instance: instanceId }, 'createInvites');
      if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);
      if (!ctx.ok) return j({ error: 'not_found' }, 404, origin, env);
      const r = ctx.owner;   // the PROJECT OWNER's row: Drive acts in their account (R2-5)
      const owned = await env.DB.prepare('SELECT instance_id FROM instance WHERE instance_id=? AND researcher_id=? AND revoked=0')
        .bind(instanceId, r.researcher_id).first();
      if (!owned) return j({ error: 'not_found' }, 404, origin, env);
      const body = await readJson(request) || {};
      const ttl = Math.min(Math.max(parseInt(body.ttlSeconds || 604800, 10) || 604800, 300), 2592000); // 5min..30d
      const invite_id = crypto.randomUUID();
      const secret = randTok(18);
      const expires_at = now + ttl * 1000;
      /* ⚠ invited_by = ctx.caller, NOT ctx.owner. The pairing accept gate names this researcher to
       * the field user so they can recognise who is enrolling their device; when a member mints the
       * invite it must be the MEMBER, not the project owner. See pairingIdentity(). */
      await env.DB.prepare('INSERT INTO invite (invite_id, instance_id, secret_hash, expires_at, created_at, invited_by) VALUES (?,?,?,?,?,?)')
        .bind(invite_id, instanceId, await sha256hex(secret), expires_at, now, ctx.caller.researcher_id).run();
      /* ⚠ RETURN THE ESTATE WITH THE INVITE. The panel used to look the instance up in its cached
       * dashboard, which a BRAND-NEW device is not in yet — so the lookup missed and the link fell
       * back to 'pages', sending new coworkers to the legacy apps (Seth, 2026-08-05). Server truth
       * at mint time cannot miss. */
      const ie = await env.DB.prepare('SELECT estate FROM instance WHERE instance_id=?').bind(instanceId).first();
      /* ⚠ ATTRIBUTION. Recorded with ctx.caller — WHO ACTED — never ctx.owner, whose Drive the work
       * runs against. They are the same researcher for an owner, which is exactly why conflating them
       * would pass every test today and name the wrong person the day sharing ships. Nobody can
       * reconstruct an actor after the fact, so this has to be written at the moment it happens. */
      await logApproval(env, request, 'device_invited', instanceId.slice(0, 12) + '…', 'invite minted', ctx.caller.drive_email);
      return j({ invite_id, secret, expires_at, estate: (ie && ie.estate) || 'pages' }, 200, origin, env);
    }

    // POST .../command — append a command to `desired` (CAS, §E.2). Enforce id+type (§F.5).
    if (m === 'POST' && sub === 'command' && seg.length === 4) {
      const ctx = await authMember(request, env, { instance: instanceId }, 'manageDevices');
      if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);
      if (!ctx.ok) return j({ error: 'not_found' }, 404, origin, env);
      const r = ctx.owner;   // the PROJECT OWNER's row: Drive acts in their account (R2-5)
      const body = await readJson(request);
      const cmd = body && body.command;
      if (!cmd || typeof cmd.type !== 'string') return j({ error: 'bad_command' }, 400, origin, env);
      if (cmd.type === 'assign' && !cmd.id) return j({ error: 'assign_needs_id' }, 400, origin, env);     // §F.5
      // uploadDelete = upload-then-delete (per-text remote removal; engine ≥ v94 — older
      // clients warn-and-ack it harmlessly, so the panel gates the button on engineVersion).
      if (!['assign', 'delete', 'changeSettings', 'triggerUpload', 'uploadDelete', 'setDone'].includes(cmd.type)) return j({ error: 'unknown_command' }, 400, origin, env);
      /* ⚠ TEXT-SCOPED COMMANDS NEED assignTexts, NOT manageDevices. The route is gated on
       * manageDevices because queueing a command IS device management — but four of the six command
       * types operate on a TEXT, and one of them (`delete`) destroys a field worker's transcription.
       * Gating the whole route on manageDevices therefore hands the entire text lane to anyone who
       * can rename a device. The audit caught `assign` and `uploadDelete`; `delete` and `setDone`
       * are the same shape and are included because leaving them would keep the hole open under a
       * different name.
       *
       * ⚠ This costs the OWNER nothing — isOwner passes every capability — so it changes behaviour
       * only for members, which is the point. With assignTexts refused in v1 it closes the lane
       * entirely; when assignTexts returns it becomes the correct gate rather than needing to be
       * remembered then.
       *
       * not_found rather than a distinct error, for the same reason every other capability denial
       * answers not_found: one refusal shape, so no route becomes an oracle by being the odd one. */
      const TEXT_COMMANDS = ['assign', 'delete', 'uploadDelete', 'setDone'];
      if (TEXT_COMMANDS.includes(cmd.type) && !ctx.isOwner && !ctx.caps.assignTexts) {
        return j({ error: 'not_found' }, 404, origin, env);
      }
      /* ⚠⚠ changeSettings MUST RIDE `enc`, AND A PLAINTEXT `settings` IS REFUSED OUTRIGHT.
       *
       * The 2026-08-21 sweep found the hole this closes, and it defeated the capability deferral
       * without naming a Drive id at all: the worker validated `cmd.type` and nothing else, so a
       * member holding only manageDevices could send
       *   { type: 'changeSettings', settings: { relayWorker: 'https://…' } }
       * The device MERGES researcher-supplied keys (app.js:3845) and `settings.relayWorker` is
       * exactly what `workerBase()` returns — the origin for the poll, the report lane and every
       * upload. One command repointed a field device's entire backend: install credentials on the
       * next poll, every subsequent recording and text uploaded to the attacker instead of the
       * owner's Drive, and a fabricated desired lane answering { wipe: true }, which sync.js honours
       * "before every gate". That last one delegates a WIPE — which check-project-scoping.sh
       * asserts no capability can do, and which this bypassed without ever touching the wipe route.
       *
       * ⚠ THE REAL FIX IS DEVICE-SIDE and lives in app.js, because settings are E2EE and THE WORKER
       * CANNOT READ THEM — it can never allow-list keys it cannot see. This check is the half the
       * worker CAN enforce, and it is worth having: `pushCommand` has always encrypted (researcher.js
       * :569 `enc: await encryptJSON(Ki, payload)`), so a plaintext payload is a shape no legitimate
       * client has ever sent, and refusing it costs nothing and stops anyone who holds no Ki. */
      if (cmd.type === 'changeSettings' && !cmd.enc) {
        return j({ error: 'payload_must_be_encrypted' }, 400, origin, env);
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        const inst = await env.DB.prepare('SELECT desired_blob, desired_rev, type FROM instance WHERE instance_id=? AND researcher_id=? AND revoked=0')
          .bind(instanceId, r.researcher_id).first();
        if (!inst) return j({ error: 'not_found' }, 404, origin, env);
        if (cmd.forType && cmd.forType !== inst.type) return j({ error: 'type_mismatch' }, 400, origin, env); // §F.5
        const blob = inst.desired_blob ? JSON.parse(inst.desired_blob) : { settings: {}, commands: [] };
        /* ⚠ seq is derived from the TAIL of the array, so it is only monotonic while the array
         * keeps its highest-numbered entries. The cancel endpoint below REMOVES entries, which
         * makes that a load-bearing invariant rather than an accident:
         *
         *   cancel refuses any seq <= max(ack_seq)  ⟹  acked commands can never be removed
         *   ⟹ the tail is always >= max(ack_seq)    ⟹  tail+1 is always > max(ack_seq)
         *
         * That matters because the DEVICE runs only commands with `seq > its ack_seq`
         * (docs/js/sync.js). Hand it a reused seq at or below its ack and it silently skips the
         * command forever — no error anywhere, the researcher just watches nothing happen.
         *
         * ⚠ SO: DO NOT PRUNE ACKED COMMANDS FROM THIS BLOB to keep it small, which is otherwise an
         * obvious optimisation. Pruning breaks the chain above and reintroduces seq reuse. If the
         * blob ever needs trimming, store a separate high-water `next_seq` on the instance row
         * instead of inferring it from the array. Covered by test/command-seq-invariant.test.mjs. */
        /* ⚠⚠ A HIGH-WATER MARK, NOT THE ARRAY TAIL — and the comment above prescribed exactly this
         * before the sweep proved it was needed. The chain it describes ("cancel refuses any
         * seq <= max(ack_seq) ⟹ acked commands can never be removed ⟹ the tail is always
         * >= max(ack_seq)") rests on `install.ack_seq` being a true record of what the device has
         * executed. It is not: the device advances its LOCAL cursor the instant dispatch returns
         * (sync.js:447) and only then attempts the report, which is best-effort and silently
         * swallowed on failure (sync.js:486). In the field that gap is hours or days.
         *
         * So the sequence that actually happens: device executes seq 7 and cannot report; the
         * server still reads ack_seq 6; a cancel of 7 passes the guard and removes the entry; the
         * tail falls back to 6; the NEXT command is minted as 7 again — and the device filters
         * `c.seq > s.ackSeq`, so 7 is not greater than its local 7 and it SKIPS THAT COMMAND
         * FOREVER. No error anywhere; the researcher watches nothing happen. That is the failure the
         * comment above warns about, arriving through cancel rather than through pruning.
         *
         * `nextSeq` lives in the BLOB, not in a new column, so there is no migration: an existing
         * blob has none, `Math.max(tail, 0) + 1` is exactly today's arithmetic, and it
         * self-initialises on the first append. Cancel rewrites the blob but never lowers it, which
         * is the whole point — a seq, once issued, is spent. */
        const tailSeq = blob.commands.length ? blob.commands[blob.commands.length - 1].seq : 0;
        const seq = Math.max(tailSeq, blob.nextSeq || 0) + 1;
        blob.nextSeq = seq;
        /* ⚠ `by` IS THE ISSUER, and it is written now so that `cancelOthers` can be enforced later.
         * Commands recorded no author at all, which the design flags as a SCHEMA gap rather than a UI
         * one: without it "may cancel a command someone ELSE queued" is not a rule that can be
         * checked, only one that can be described. Starting to record it now means the capability
         * becomes enforceable for every command queued from today, instead of needing a backfill that
         * cannot be written — nobody can reconstruct who issued a command after the fact.
         * ctx.caller, never ctx.owner: the point is WHO ACTED. Additive inside the command object, so
         * devices and old APKs (which read type/id/seq) ignore it. */
        blob.commands.push({ ...cmd, seq, at: now, by: ctx.caller.researcher_id });
        const newRev = inst.desired_rev + 1;
        const res = await env.DB.prepare('UPDATE instance SET desired_blob=?, desired_rev=? WHERE instance_id=? AND desired_rev=?')
          .bind(JSON.stringify(blob), newRev, instanceId, inst.desired_rev).run();
        if (res.meta.changes === 1) return j({ ok: true, seq, desired_rev: newRev }, 200, origin, env);
      }
      return j({ error: 'conflict_retry' }, 409, origin, env);
    }

    /* POST .../command/cancel {seq} — WITHDRAW a queued command the device has not picked up yet.
     *
     * WHY THIS IS SAFE TO EXPOSE: a command is only ever removed while NO install of this instance
     * has acked a seq that high. `install.ack_seq` is monotonic (Math.max on report), so
     * "max(ack_seq) < seq" is a sound proof that nothing has acted on it. Once any install has
     * acked past it, the answer is a refusal, never a silent no-op — a cancel that quietly fails is
     * worse than no cancel, because the researcher walks away believing the delete is off.
     *
     * ⚠ ANY install, not all: an instance can run the editor and the recorder side by side, and
     * either may be the one holding that text. Requiring every install to be behind the seq is the
     * conservative reading and the only one that cannot race.
     *
     * Uses the same desired_rev compare-and-swap loop as the append path, so a poll landing
     * mid-edit, or two panels acting at once, cannot corrupt the blob.
     */
    if (m === 'POST' && sub === 'command' && seg.length === 5 && seg[4] === 'cancel') {
      /* ⚠ GATED ON manageDevices, NOT ON `cancelOthers`, and the difference is honest rather than an
       * oversight. The design wants cancelling your OWN queued command ungated (that is undo, not
       * authority) and someone ELSE's gated on `cancelOthers`. That distinction needs the command to
       * name its issuer — which it only started doing in the route above, so every command queued
       * BEFORE that has no `by` field and no way to acquire one. Splitting the rule now would
       * therefore treat the entire existing backlog as "someone else's" or as "mine", and both
       * answers are wrong.
       * manageDevices is the strictly-safe interim: never wider than today (this was owner-only), and
       * it becomes the fallback for authorless commands once `cancelOthers` lands.
       *
       * ⚠ AND `cancelOthers` IS NOW UNGRANTABLE (DEFERRED_CAPS, 2026-08-24) rather than merely
       * unenforced here, so the two halves finally agree. While it was grantable, ticking it stored a
       * capability this route never consulted — an owner told they had delegated something they had
       * not, which is exactly what validateCaps refuses to do for every other key. Withholding it is
       * the honest state until the split above can actually be made.
       *
       * ⚠ CONSEQUENCE, STATED so it is a decision and not a discovery: a member with `manageDevices`
       * can cancel a command the OWNER queued. That was already true and is unchanged; what changed
       * is that nobody is now told otherwise by a checkbox. */
      const ctx = await authMember(request, env, { instance: instanceId }, 'manageDevices');
      if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);
      if (!ctx.ok) return j({ error: 'not_found' }, 404, origin, env);
      const r = ctx.owner;
      const body = await readJson(request) || {};
      const seq = parseInt(body.seq, 10);
      if (!Number.isFinite(seq) || seq <= 0) return j({ error: 'bad_seq' }, 400, origin, env);
      for (let attempt = 0; attempt < 5; attempt++) {
        const inst = await env.DB.prepare('SELECT desired_blob, desired_rev FROM instance WHERE instance_id=? AND researcher_id=? AND revoked=0')
          .bind(instanceId, r.researcher_id).first();
        if (!inst) return j({ error: 'not_found' }, 404, origin, env);
        // The highest seq ANY live install has processed.
        const acked = await env.DB.prepare('SELECT MAX(ack_seq) AS a FROM install WHERE instance_id=? AND revoked=0')
          .bind(instanceId).first();
        const maxAck = (acked && acked.a) || 0;
        /* ⚠ THIS GUARD IS NECESSARY BUT NOT SUFFICIENT, and saying so is the honest part. ack_seq is
         * server state that LAGS execution by an unbounded interval, so passing it does not prove
         * the device has not already acted — only that it has not yet SAID so. A destructive command
         * (delete, uploadDelete) may be long finished when this returns ok. The reused-seq
         * consequence is fixed above by nextSeq; the "cancel may be too late" half cannot be fixed
         * here at all, because nothing in the protocol reports execution before it happens.
         * `ack_seq` rides the response so a caller can say what the withdrawal was based on rather
         * than implying certainty. */
        if (seq <= maxAck) return j({ error: 'already_delivered', ack_seq: maxAck }, 409, origin, env);
        const blob = inst.desired_blob ? JSON.parse(inst.desired_blob) : { settings: {}, commands: [] };
        const before = (blob.commands || []).length;
        blob.commands = (blob.commands || []).filter((c) => c.seq !== seq);
        if (blob.commands.length === before) return j({ error: 'not_queued', ack_seq: maxAck }, 404, origin, env);
        const newRev = inst.desired_rev + 1;
        const res = await env.DB.prepare('UPDATE instance SET desired_blob=?, desired_rev=? WHERE instance_id=? AND desired_rev=?')
          .bind(JSON.stringify(blob), newRev, instanceId, inst.desired_rev).run();
        if (res.meta.changes === 1) return j({ ok: true, cancelled: seq, desired_rev: newRev, ack_seq: maxAck }, 200, origin, env);
      }
      return j({ error: 'conflict_retry' }, 409, origin, env);
    }

    /* GET .../texts/<docId>/files — RESEARCHER: list the text's Drive folder, newest first.
     * This is what feeds the Files dropdown and the download-all ZIP: the folder IS the source of
     * truth for "what artifacts exist", so the panel never has to reconstruct it from reports.
     * Returns [] (not an error) when the folder does not exist yet — a text with no uploads is a
     * normal state, not a failure. */
    if (m === 'GET' && sub === 'texts' && seg.length === 6 && seg[5] === 'files') {
      const ctx = await authMember(request, env, { instance: instanceId }, 'drive:read');
      if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);
      if (!ctx.ok) return j({ error: 'not_found' }, 404, origin, env);
      const r = ctx.owner;   // the PROJECT OWNER's row: Drive acts in their account (R2-5)
      const owned = await env.DB.prepare('SELECT instance_id FROM instance WHERE instance_id=? AND researcher_id=?')
        .bind(instanceId, r.researcher_id).first();
      if (!owned) return j({ error: 'not_found' }, 404, origin, env);
      const docId = String(seg[4] || '').replace(/[^\w-]/g, '').slice(0, 64);
      if (!docId) return j({ error: 'bad_doc' }, 400, origin, env);
      /* ⚠ MODIFIES AN EXISTING ENDPOINT → STAGING-WORKER-TESTED FIRST (spec rule 9): the folder
       * filter + assignment merge below change what shipped panels receive. All new JSON fields
       * are additive (old panels ignore originalsFolderId; they never classified folder rows as
       * downloadable files on purpose, they just never used to receive any). */
      try {
        const access = await driveAccessToken(env, r);
        const fq = encodeURIComponent(`appProperties has { key='flextextDoc' and value='${docId}' } and mimeType='application/vnd.google-apps.folder' and trashed=false`);
        const found = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files?spaces=drive&orderBy=createdTime&fields=files(id)&q=' + fq);
        if (!found.files || !found.files.length) return j({ files: [], folderId: null, originalsFolderId: null }, 200, origin, env);
        const folderId = found.files[0].id;
        const listChildren = async (parent) => {
          const lq = encodeURIComponent(`'${parent}' in parents and trashed=false`);
          const list = await driveJson(access, 'GET',
            'https://www.googleapis.com/drive/v3/files?spaces=drive&orderBy=modifiedTime desc&pageSize=200&fields=files(id,name,size,mimeType,modifiedTime,appProperties)&q=' + lq);
          return list.files || [];
        };
        const rows = await listChildren(folderId);
        const isFolder = (f) => (f.mimeType || '') === 'application/vnd.google-apps.folder';
        /* The originals/ child holds the text's SOURCE materials — the assigned audio/flextext, or
         * the device's own recording and consent files. Its contents are the text's files as much
         * as the parent folder's own, so they merge into ONE list. Folder rows themselves are not
         * files and were never meant to be listed.
         *
         * ⚠ 'assignment' is the LEGACY tag: the child was called that before the folder was
         * renamed to serve recorded texts as well as assigned ones. Texts assigned in that window
         * still carry it, and dropping it here would silently orphan their source files from every
         * listing — the move picker and cleanup included. Match both, forever; it costs one `||`. */
        const SOURCE_ROLES = ['originals', 'assignment'];
        const assignFolder = rows.find((f) => isFolder(f) && f.appProperties && SOURCE_ROLES.includes(f.appProperties.flextextRole));
        const assignRows = assignFolder ? await listChildren(assignFolder.id) : [];
        const files = rows.concat(assignRows).filter((f) => !isFolder(f)).map((f) => ({
          id: f.id, name: f.name, size: parseInt(f.size, 10) || 0, mime: f.mimeType || '', modified: f.modifiedTime || '',
          // The role tag distinguishes the ORIGINAL-assigned-audio copy from a recording the
          // device uploaded — the panel needs that to honour "show the cached link if and only
          // if no copy exists in the folder".
          role: (f.appProperties && f.appProperties.flextextRole) || '',
        })).sort((a, b) => String(b.modified).localeCompare(String(a.modified)));   // newest-first ACROSS the merge
        return j({ folderId, originalsFolderId: (assignFolder && assignFolder.id) || null, files }, 200, origin, env);
      } catch (e) { return j({ error: e.code || 'drive_error', message: safeErr(e) }, 502, origin, env); }
    }

    /* ---- Assignment upload (assign-by-upload, 2026-08-11) — ADDITIVE endpoints ----
     * The researcher PICKS the actual files; the panel streams them here in chunks; the worker
     * lands them in "<Device>/<Storyname>/assignment/" in the researcher's own Drive and mints
     * private streaming tokens for the assign command. Nothing is ever link-shared. The chunk
     * wire contract is the device one (relayDriveChunk); the session token carries `rr` (the
     * researcher id) so device/researcher tokens can never cross routes. */

    // POST .../texts/<docId>/assignment/begin {title, folderId?} → the text folder + its
    // assignment/ child, created as needed. folderId is a panel-remembered echo (files.get
    // verification beats the eventually-consistent tag search — the v167 dedupe mechanism).
    if (m === 'POST' && sub === 'texts' && seg.length === 7 && seg[5] === 'assignment' && seg[6] === 'begin') {
      const ctx = await authMember(request, env, { instance: instanceId }, 'assignTexts');
      if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);
      if (!ctx.ok) return j({ error: 'not_found' }, 404, origin, env);
      const r = ctx.owner;   // the PROJECT OWNER's row: Drive acts in their account (R2-5)
      const inst = await env.DB.prepare('SELECT instance_id, nickname, oauth_folder_id FROM instance WHERE instance_id=? AND researcher_id=? AND revoked=0')
        .bind(instanceId, r.researcher_id).first();
      if (!inst) return j({ error: 'not_found' }, 404, origin, env);
      const docId = String(seg[4] || '').replace(/[^\w-]/g, '').slice(0, 64);
      if (!docId) return j({ error: 'bad_doc' }, 400, origin, env);
      const body = await readJson(request) || {};
      try {
        const access = await driveAccessToken(env, r);
        const deviceFolder = await driveEnsureDeviceFolder(env, access, instanceId, inst.nickname, inst.oauth_folder_id);
        const folder = await driveEnsureTextFolder(access, deviceFolder, docId, body.title, body.folderId);
        const originalsFolderId = await driveEnsureChildFolder(access, folder, 'originals', 'originals');
        // Stamp the text + its originals with the authorizing project (device folder self-stamps).
        await stampFolder(env, { objectId: folder, kind: 'text', docId, instanceId, projectId: ctx.project_id || null, createdBy: ctx.caller.researcher_id });
        await stampFolder(env, { objectId: originalsFolderId, kind: 'originals', docId, instanceId, projectId: ctx.project_id || null, createdBy: ctx.caller.researcher_id });
        return j({ ok: true, folderId: folder, originalsFolderId }, 200, origin, env);
      } catch (e) { return j({ error: e.code || 'drive_error', message: safeErr(e) }, 502, origin, env); }
    }

    // POST .../texts/<docId>/assignment/upload/start {name, mime, size, originalsFolderId, kind}
    // → a Drive resumable session as an opaque uploadId (encrypted at rest, bound to THIS
    // researcher via `rr`). kind names the role tag; 'consent-prompt' targets the DEVICE folder
    // (a prompt is per-device, not per-text — the docId segment is ignored for it).
    if (m === 'POST' && sub === 'texts' && seg.length === 8 && seg[5] === 'assignment' && seg[6] === 'upload' && seg[7] === 'start') {
      const ctx = await authMember(request, env, { instance: instanceId }, 'assignTexts');
      if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);
      if (!ctx.ok) return j({ error: 'not_found' }, 404, origin, env);
      const r = ctx.owner;   // the PROJECT OWNER's row: Drive acts in their account (R2-5)
      const inst = await env.DB.prepare('SELECT instance_id, nickname, oauth_folder_id FROM instance WHERE instance_id=? AND researcher_id=? AND revoked=0')
        .bind(instanceId, r.researcher_id).first();
      if (!inst) return j({ error: 'not_found' }, 404, origin, env);
      const body = await readJson(request) || {};
      const size = parseInt(body.size, 10) || 0;
      if (size < 1 || size > 2 * 1024 * 1024 * 1024) return j({ error: 'bad_size' }, 400, origin, env);
      const name = String(body.name || '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 180) || ('assigned-' + now + '.bin');
      const mime = String(body.mime || 'application/octet-stream').slice(0, 100);
      // 'assigned-audio' reuses assign-copy's exact tag so existing classification keeps working.
      const role = { audio: 'source-audio', flextext: 'source-flextext', 'consent-prompt': 'consent-prompt', manifest: 'manifest' }[body.kind];
      if (!role) return j({ error: 'bad_kind' }, 400, origin, env);
      try {
        const access = await driveAccessToken(env, r);
        let parent = String(body.originalsFolderId || '');
        if (body.kind === 'consent-prompt') {
          parent = await driveEnsureDeviceFolder(env, access, instanceId, inst.nickname, inst.oauth_folder_id);
        }
        if (!parent) return j({ error: 'bad_folder' }, 400, origin, env);
        const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + access, 'content-type': 'application/json',
            'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(size),
          },
          body: JSON.stringify({ name, mimeType: mime, parents: [parent], appProperties: { flextextRole: role } }),
        });
        const session = init.ok ? init.headers.get('Location') : null;
        if (!session) { const e = new Error('no upload session (HTTP ' + init.status + ')'); e.code = 'drive_error'; throw e; }
        const uploadId = await encAtRest(env, JSON.stringify({ u: session, rr: r.researcher_id, s: size }));
        return j({ ok: true, uploadId }, 200, origin, env);
      } catch (e) {
        await noteDriveError(env, r.researcher_id, 'assignment upload start failed: ' + safeErr(e));
        return j({ error: e.code || 'drive_error' }, 502, origin, env);
      }
    }

    // PUT .../texts/<docId>/assignment/upload/chunk — same wire contract as the device chunk
    // relay; ownership key is `rr` (researcher), never `i` (install).
    if (m === 'PUT' && sub === 'texts' && seg.length === 8 && seg[5] === 'assignment' && seg[6] === 'upload' && seg[7] === 'chunk') {
      const ctx = await authMember(request, env, { instance: instanceId }, 'assignTexts');
      if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);
      if (!ctx.ok) return j({ error: 'not_found' }, 404, origin, env);
      const r = ctx.owner;   // the PROJECT OWNER's row: Drive acts in their account (R2-5)
      let sess = null;
      try { sess = JSON.parse(await decAtRest(env, request.headers.get('x-fx-upload') || '')); } catch { sess = null; }
      if (!sess || !sess.u || sess.rr !== r.researcher_id) return j({ error: 'bad_upload' }, 403, origin, env);
      const out = await relayDriveChunk(request, sess);
      return j(out.body, out.status, origin, env);
    }

    // POST .../texts/<docId>/assignment/finish {audioFileId?, flextextFileId?, promptFileId?,
    // ttlDays} → private streaming URLs for the E2EE assign command (and the settings push's
    // prompt-URL field). TTL researcher-configurable; the server clamp is authoritative.
    if (m === 'POST' && sub === 'texts' && seg.length === 7 && seg[5] === 'assignment' && seg[6] === 'finish') {
      const ctx = await authMember(request, env, { instance: instanceId }, 'assignTexts');
      if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);
      if (!ctx.ok) return j({ error: 'not_found' }, 404, origin, env);
      const r = ctx.owner;   // the PROJECT OWNER's row: Drive acts in their account (R2-5)
      const inst = await env.DB.prepare('SELECT instance_id, nickname FROM instance WHERE instance_id=? AND researcher_id=? AND revoked=0')
        .bind(instanceId, r.researcher_id).first();
      if (!inst) return j({ error: 'not_found' }, 404, origin, env);
      const docId = String(seg[4] || '').replace(/[^\w-]/g, '').slice(0, 64);
      const body = await readJson(request) || {};
      if (!body.audioFileId && !body.flextextFileId && !body.promptFileId) return j({ error: 'nothing_to_mint' }, 400, origin, env);
      const ttlDays = clampTtlDays(body.ttlDays);
      const ttlMs = ttlDays * 86400000;
      try {
        /* ⚠ THE AUDIO AND THE FLEXTEXT ARE A DELIVERY TO ONE DEVICE — scope them, so revoking that
         * device withdraws them. THE CONSENT PROMPT IS NOT: it is configuration the researcher
         * REUSES, pasted by hand into other devices' settings (the free-text `consentAudioUrl`
         * field) and into a crowd recorder's config, which has no instance at all. Scoping it would
         * 410 the moment the minting device were revoked, and would never work for a crowd page.
         * Deliberately unscoped; do not "fix" the inconsistency by scoping it. */
        const scope = { instanceId, docId };
        const audioUrl = await mintTextfileUrl(env, url.origin, r.researcher_id, body.audioFileId, '', ttlMs, scope, ctx.caller.researcher_id);
        const flextextUrl = await mintTextfileUrl(env, url.origin, r.researcher_id, body.flextextFileId, '', ttlMs, scope, ctx.caller.researcher_id);
        const promptUrl = await mintTextfileUrl(env, url.origin, r.researcher_id, body.promptFileId, '', ttlMs, null, ctx.caller.researcher_id);
        if (docId && (audioUrl || flextextUrl)) {
          await logApproval(env, request, 'assigned_upload', docId.slice(0, 12) + '…', '→ ' + (inst.nickname || '?'), ctx.caller.drive_email);
        }
        return j({ ok: true, ttlDays, audioUrl, flextextUrl, promptUrl }, 200, origin, env);
      } catch (e) { return j({ error: e.code || 'drive_error', message: safeErr(e) }, 502, origin, env); }
    }

    /* POST .../texts/<docId>/move {to, flextextFileId?, audioFileId?, extractFromZipId?} —
     * RESEARCHER: re-home a text onto another of their devices.
     * The Worker does the Drive half: ensure the DESTINATION device folder, re-parent the text's
     * folder under it (one PATCH — the docId tag travels with the folder, so the destination's
     * uploads keep landing in it), and mint AUTHED STREAMING tokens for the content files so the
     * destination can fetch them privately — nothing is ever link-shared (Seth's decision; field
     * data stays private). The PANEL does the command half: assign to B with these URLs (same
     * docId — v137 identity), then fire the upload-first remove at A once B reports the doc. */
    /* ADOPT an unassigned text onto a device — the move flow with NO SOURCE DEVICE.
     *
     * Separate from /move rather than a relaxation of it: /move requires `toId !== instanceId` by
     * design (a move between two real devices), and loosening that guard to serve a different flow
     * would make one endpoint mean two things. This is purely additive, so it cannot affect the
     * move path field devices already depend on.
     *
     * The re-parent half completes the round trip driveTextHousekeeping already handles in the
     * other direction: the folder comes OUT of Unassigned and under the adopting device, and the
     * `flextextUnassigned` tag is cleared so the return-trip logic will not fight it later. */
    if (m === 'POST' && sub === 'texts' && seg.length === 6 && seg[5] === 'adopt') {
      const ctx = await authMember(request, env, { instance: instanceId }, 'assignTexts');
      if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);
      if (!ctx.ok) return j({ error: 'not_found' }, 404, origin, env);
      const r = ctx.owner;   // the PROJECT OWNER's row: Drive acts in their account (R2-5)
      const body = await readJson(request) || {};
      const docId = String(seg[4] || '').replace(/[^\w-]/g, '').slice(0, 64);
      if (!docId) return j({ error: 'bad_doc' }, 400, origin, env);
      const to = await env.DB.prepare('SELECT instance_id, nickname, oauth_folder_id FROM instance WHERE instance_id=? AND researcher_id=? AND revoked=0')
        .bind(instanceId, r.researcher_id).first();
      if (!to) return j({ error: 'not_found' }, 404, origin, env);
      try {
        const access = await driveAccessToken(env, r);
        const toFolder = await driveEnsureDeviceFolder(env, access, instanceId, to.nickname, to.oauth_folder_id);
        const fq = encodeURIComponent(`appProperties has { key='flextextDoc' and value='${docId}' } and mimeType='application/vnd.google-apps.folder' and trashed=false`);
        const found = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files?spaces=drive&orderBy=createdTime&fields=files(id,parents)&q=' + fq);
        const f = (found.files || [])[0];
        let folderId = '';
        if (f) {
          folderId = f.id;
          if (!(f.parents || []).includes(toFolder)) await driveReparent(access, f.id, toFolder, f.parents);
          await driveJson(access, 'PATCH', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(f.id) + '?fields=id',
            { appProperties: { flextextUnassigned: '' } });
        }
        // Same private, time-boxed streaming tokens the move flow mints — the device downloads
        // through /v1/textfile exactly as it would for any assignment.
        // Scoped to the DESTINATION device — it is the one that will fetch these.
        const mint = (fileId, extract) => mintTextfileUrl(env, url.origin, r.researcher_id, fileId, extract, 0, { instanceId: to.instance_id, docId }, ctx.caller.researcher_id);
        const flextextUrl = await mint(body.flextextFileId) || await mint(body.extractFromZipId, 'flextext');
        const audioUrl = await mint(body.audioFileId);
        await logApproval(env, request, 'text_adopted', docId, to.nickname || '', ctx.caller.drive_email);
        return j({ ok: true, folderId, flextextUrl, audioUrl }, 200, origin, env);
      } catch (e) { return j({ error: e.code || 'drive_error', message: safeErr(e) }, 502, origin, env); }
    }

    if (m === 'POST' && sub === 'texts' && seg.length === 6 && seg[5] === 'move') {
      const ctx = await authMember(request, env, { instance: instanceId }, 'assignTexts');
      if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);
      if (!ctx.ok) return j({ error: 'not_found' }, 404, origin, env);
      const r = ctx.owner;   // the PROJECT OWNER's row: Drive acts in their account (R2-5)
      const body = await readJson(request) || {};
      const toId = String(body.to || '');
      const docId = String(seg[4] || '').replace(/[^\w-]/g, '').slice(0, 64);
      if (!docId || !toId || toId === instanceId) return j({ error: 'bad_move' }, 400, origin, env);
      const from = await env.DB.prepare('SELECT instance_id, nickname, oauth_folder_id FROM instance WHERE instance_id=? AND researcher_id=? AND revoked=0')
        .bind(instanceId, r.researcher_id).first();
      const to = await env.DB.prepare('SELECT instance_id, nickname, oauth_folder_id FROM instance WHERE instance_id=? AND researcher_id=? AND revoked=0')
        .bind(toId, r.researcher_id).first();
      if (!from || !to) return j({ error: 'not_found' }, 404, origin, env);
      try {
        const access = await driveAccessToken(env, r);
        const toFolder = await driveEnsureDeviceFolder(env, access, toId, to.nickname, to.oauth_folder_id);
        // Re-parent the text folder if one exists (legacy texts may have none — the move still works,
        // it just has no folder to carry).
        let movedFolder = false;
        const fq = encodeURIComponent(`appProperties has { key='flextextDoc' and value='${docId}' } and mimeType='application/vnd.google-apps.folder' and trashed=false`);
        const found = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files?spaces=drive&orderBy=createdTime&fields=files(id,parents)&q=' + fq);
        if (found.files && found.files.length) {
          const f = found.files[0];
          const oldParents = (f.parents || []).join(',');
          await driveJson(access, 'PATCH', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(f.id)
            + '?addParents=' + encodeURIComponent(toFolder) + (oldParents ? '&removeParents=' + encodeURIComponent(oldParents) : '') + '&fields=id');
          movedFolder = true;
        }
        // Streaming tokens (default 90-day TTL) for whatever content the panel identified. Opaque
        // + time-boxed, bound to this researcher; the /v1/textfile endpoint validates and streams.
        // Scoped to the DESTINATION device — it is the one that will fetch these.
        const mint = (fileId, extract) => mintTextfileUrl(env, url.origin, r.researcher_id, fileId, extract, 0, { instanceId: to.instance_id, docId }, ctx.caller.researcher_id);
        const flextextUrl = await mint(body.flextextFileId) || await mint(body.extractFromZipId, 'flextext');
        const audioUrl = await mint(body.audioFileId);
        await logApproval(env, request, 'text_moved', docId.slice(0, 12) + '…', (from.nickname || '?') + ' → ' + (to.nickname || '?'), ctx.caller.drive_email);
        return j({ ok: true, movedFolder, flextextUrl, audioUrl }, 200, origin, env);
      } catch (e) { return j({ error: e.code || 'drive_error', message: safeErr(e) }, 502, origin, env); }
    }

    /* ⚠ THE assign-copy ROUTE WAS REMOVED (2026-08-19). It streamed an arbitrary PUBLIC Drive file,
     * named by a caller-supplied id, into the researcher's own Drive — a caller-controlled outbound
     * fetch that existed only to serve the pasted-URL assignment flow. That flow is gone: the panel
     * comment for assignModal records it ("pasted URLs are retired entirely, and with them the
     * probe/soft-CORS confirm ladder and the assign-copy call — the upload IS the copy"), and both
     * productionWeb and main carry zero call sites. Assignment now works by the researcher uploading
     * the actual files, which the worker writes into the target text's folder.
     * Do not reintroduce a route that fetches a URL the caller chose. */


    // POST .../revoke — revoke the whole instance.
    if (m === 'POST' && sub === 'revoke' && seg.length === 4) {
      const ctx = await authMember(request, env, { instance: instanceId }, 'manageDevices');
      if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);
      if (!ctx.ok) return j({ error: 'not_found' }, 404, origin, env);
      const r = ctx.owner;   // the PROJECT OWNER's row: Drive acts in their account (R2-5)
      /* ⚠ OWNERSHIP IS ESTABLISHED FIRST, NOT CARRIED BY ONE STATEMENT OF THE BATCH.
       * This used to be a two-statement batch where only the FIRST carried `AND researcher_id=?`;
       * the second was a bare `UPDATE install SET revoked=1 WHERE instance_id=?`. A D1 batch is
       * sequential, not conditional — statement 2 lands whether or not statement 1 matched — so
       * knowing an instance GUID was enough to flag every install of ANOTHER researcher's instance
       * revoked. The device's next poll takes a 410 and auto-releases: clearSession, sync link
       * dropped, Drive config scrubbed, mid-assignment. The reply was still ok:true.
       *
       * Today the only barrier is that instance ids are unguessable. Under the projects/researchers
       * split every member legitimately SEES those ids, so a see-only member with no capability at
       * all would gain a device-unlinking primitive on day one. It also falsified the invariant the
       * plan's staged endpoint conversion rests on (R2-4: every instance/install/crowd ownership
       * check is a fail-closed filter that returns not_found) — this was a second, unnamed
       * exception, and it failed OPEN.
       *
       * Fixed by doing what the sibling `installs/<iid>/revoke` route immediately below already
       * does: resolve ownership, 404 on a miss, and only then write. Re-revoking still returns 200,
       * so no deployed panel changes behaviour. */
      const ownedInst = await env.DB.prepare('SELECT instance_id, nickname FROM instance WHERE instance_id=? AND researcher_id=?')
        .bind(instanceId, r.researcher_id).first();
      if (!ownedInst) return j({ error: 'not_found' }, 404, origin, env);
      await env.DB.batch([
        env.DB.prepare('UPDATE instance SET revoked=1 WHERE instance_id=? AND researcher_id=?').bind(instanceId, r.researcher_id),
        env.DB.prepare('UPDATE install SET revoked=1 WHERE instance_id=?').bind(instanceId),
      ]);
      /* ⚠ ATTRIBUTION — ctx.caller (WHO ACTED), never ctx.owner (whose Drive the work runs in).
       * Identical for an owner, which is exactly why conflating them would pass every test today and
       * name the wrong person the day sharing ships. Nobody can reconstruct an actor afterwards. */
      await logApproval(env, request, 'device_revoked', instanceId.slice(0, 12) + '…', ownedInst.nickname || '', ctx.caller.drive_email);
      return j({ ok: true }, 200, origin, env);
    }

    // Routes under /v1/instances/<id>/installs/<iid>/...
    if (sub === 'installs' && seg.length >= 5) {
      const installId = seg[4];
      const isub = seg[5];

      // POST .../approve — researcher approves a pending install (anti-leaked-link, §D.3).
      if (m === 'POST' && isub === 'approve' && seg.length === 6) {
        const ctx = await authMember(request, env, { instance: instanceId }, 'manageDevices');
        if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);
        if (!ctx.ok) return j({ error: 'not_found' }, 404, origin, env);
        const r = ctx.owner;   // the PROJECT OWNER's row: Drive acts in their account (R2-5)
        const owned = await env.DB.prepare(
          'SELECT i.install_id FROM install i JOIN instance n ON n.instance_id=i.instance_id WHERE i.install_id=? AND i.instance_id=? AND n.researcher_id=?'
        ).bind(installId, instanceId, r.researcher_id).first();
        if (!owned) return j({ error: 'not_found' }, 404, origin, env);
        /* ⚠ AND THE CODE GOES. It exists to be compared while a pairing is in progress; once the
         * researcher has approved, both ends are done with it, and keeping it would ship a
         * live-looking pairing code in every dashboard payload for the life of the device. NULL is
         * also the signal the DEVICE reads to stop showing its pairing screen. */
        await env.DB.prepare("UPDATE install SET status='approved', pair_code=NULL WHERE install_id=?").bind(installId).run();
      /* ⚠ ATTRIBUTION. Recorded with ctx.caller — WHO ACTED — never ctx.owner, whose Drive the work
       * runs against. They are the same researcher for an owner, which is exactly why conflating them
       * would pass every test today and name the wrong person the day sharing ships. Nobody can
       * reconstruct an actor after the fact, so this has to be written at the moment it happens. */
        await logApproval(env, request, 'install_approved', installId.slice(0, 12) + '…', instanceId.slice(0, 12) + '…', ctx.caller.drive_email);
        return j({ ok: true }, 200, origin, env);
      }

      // POST .../accept — the DEVICE confirms the enrolling researcher (whose name+avatar it was
      // shown) is expected. Required before key delivery (B): a phished/hijacked invite can't pull
      // data unless the field user actively accepts. Authed by the install secret (the device itself).
      if (m === 'POST' && isub === 'accept' && seg.length === 6) {
        const install = await authInstall(request, env, instanceId, installId);
        if (!install) return j({ error: 'unauthorized' }, 401, origin, env);
        await env.DB.prepare('UPDATE install SET accepted=1 WHERE install_id=?').bind(installId).run();
        return j({ ok: true }, 200, origin, env);
      }

      // POST .../key — researcher delivers Ki WRAPPED to this install's pubkey (E2EE model A).
      // The Worker stores opaque ciphertext only; it never sees Ki.
      if (m === 'POST' && isub === 'key' && seg.length === 6) {
        /* ⚠⚠ OWNER-ONLY. Gated on manageDevices until the completeness critic pointed out what that
         * meant: `body.wrapped_key` is OPAQUE CIPHERTEXT the worker cannot inspect, and this route
         * bumps desired_rev in the same batch precisely so the device ADOPTS it. So a member holding
         * the one capability v1 ships could install a Ki THEY chose — after which the owner's stored
         * Ki no longer decrypts the device's reports, and the owner's own encrypted commands stop
         * being readable by it. E2EE sabotage, from device management.
         *
         * The worker cannot validate its way out of this: it cannot read the key, so "is this the
         * right key" is not a question it can ask. The only available control is WHO may ask, and
         * the design already says: key sovereignty is the owner's. `POST /v1/researcher/keys` is
         * owner-only for the same reason, and the wrap-to-owner invariant exists so that "the owner
         * can always read and revoke every key" is true by construction.
         *
         * ⚠ CONSEQUENCE, STATED: a member with createInvites can enrol a coworker's device but
         * cannot key it — the device waits for the owner. That is a real gap in member-run
         * enrolment, and it is the correct side to err on while the alternative is a member being
         * able to lock the owner out of their own device. Revisit with rotation (Phase E). */
        const ctx = await authMember(request, env, { instance: instanceId }, null);
        if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);
        if (!ctx.ok || !ctx.isOwner) return j({ error: 'not_found' }, 404, origin, env);
        const r = ctx.owner;   // the PROJECT OWNER's row: Drive acts in their account (R2-5)
        const owned = await env.DB.prepare(
          'SELECT i.install_id, i.accepted FROM install i JOIN instance n ON n.instance_id=i.instance_id WHERE i.install_id=? AND i.instance_id=? AND n.researcher_id=?'
        ).bind(installId, instanceId, r.researcher_id).first();
        if (!owned) return j({ error: 'not_found' }, 404, origin, env);
        // B: the field user must have accepted this enrollment before any key can be delivered.
        if (!owned.accepted) return j({ error: 'not_accepted' }, 409, origin, env);
        const body = await readJson(request);
        if (!body || !body.wrapped_key) return j({ error: 'bad_body' }, 400, origin, env);
        /* ⚠ BUMP desired_rev IN THE SAME BATCH — round-2 finding R2-2, and it is what makes REVOKE
         * mean anything. A device re-unwraps its Ki only when the poll body's `wrapped_key` CHANGES,
         * but the poll short-circuits to 204 while `desired_rev <= since` — so a re-keyed device with
         * nothing else pending would NEVER be handed the new key. It would go on encrypting under the
         * old Ki indefinitely, which is precisely the key a removed member still holds. Rotation is
         * the remedy after removing someone whose trust is in doubt; without this line it is a remedy
         * that silently does nothing. */
        await env.DB.batch([
          env.DB.prepare('UPDATE install SET wrapped_key=? WHERE install_id=?').bind(body.wrapped_key, installId),
          env.DB.prepare('UPDATE instance SET desired_rev=desired_rev+1 WHERE instance_id=?').bind(instanceId),
        ]);
        /* ⚠ ATTRIBUTION — ctx.caller (WHO ACTED), never ctx.owner. Key delivery is owner-only today,
         * so these agree; recording the caller is what keeps that true if it ever widens. */
        await logApproval(env, request, 'device_key_delivered', installId.slice(0, 12) + '…', instanceId.slice(0, 12) + '…', ctx.caller.drive_email);
        return j({ ok: true }, 200, origin, env);
      }

      // POST .../revoke — researcher revokes one install (lost device). UNLINK only: the device gets 410
      // on its next poll → auto-releases but KEEPS its local texts (the researcher can't retrieve them after).
      if (m === 'POST' && isub === 'revoke' && seg.length === 6) {
        const ctx = await authMember(request, env, { instance: instanceId }, 'manageDevices');
        if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);
        if (!ctx.ok) return j({ error: 'not_found' }, 404, origin, env);
        const r = ctx.owner;   // the PROJECT OWNER's row: Drive acts in their account (R2-5)
        const owned = await env.DB.prepare(
          'SELECT i.install_id FROM install i JOIN instance n ON n.instance_id=i.instance_id WHERE i.install_id=? AND i.instance_id=? AND n.researcher_id=?'
        ).bind(installId, instanceId, r.researcher_id).first();
        if (!owned) return j({ error: 'not_found' }, 404, origin, env);
        await env.DB.prepare('UPDATE install SET revoked=1 WHERE install_id=?').bind(installId).run();
        return j({ ok: true }, 200, origin, env);
      }

      // POST .../wipe — researcher requests a REMOTE WIPE (device out of trusted hands). Sets a sticky flag but
      // does NOT revoke: the device must stay authenticable so it can poll + RECEIVE the wipe directive
      // (delivered plaintext in the desired lane below, so it lands in ANY device state — even one never
      // keyed). Step-up TOTP when the researcher has 2FA, since this is destructive + remote + irreversible.
      if (m === 'POST' && isub === 'wipe' && seg.length === 6) {
        /* OWNER-ONLY in v1 (round-1 finding 6): remote wipe and force-remove destroy a field
         * device's work, and no capability delegates that yet. `isOwner` covers the legacy
         * dual-read path too, so an unmigrated instance behaves exactly as it does today. */
        const ctx = await authMember(request, env, { instance: instanceId }, null);
        if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);
        if (!ctx.ok || !ctx.isOwner) return j({ error: 'not_found' }, 404, origin, env);
        const r = ctx.owner;
        const owned = await env.DB.prepare(
          'SELECT i.install_id FROM install i JOIN instance n ON n.instance_id=i.instance_id WHERE i.install_id=? AND i.instance_id=? AND n.researcher_id=?'
        ).bind(installId, instanceId, r.researcher_id).first();
        if (!owned) return j({ error: 'not_found' }, 404, origin, env);
        if (r.totp_enabled) {
          const body = await readJson(request) || {};
          const sf = await verifySecondFactor(r, env, body.totpCode);
          // verifySecondFactor ALWAYS returns an object ({ok:true|false}) — must check .ok, not truthiness,
          // or the 2FA step-up is a no-op (matches login at :308 / totp-disable at :532).
          if (!sf.ok) return j({ error: body.totpCode ? 'bad_totp' : 'totp_required' }, 401, origin, env);
          // Persist a consumed backup code (spliced inside verifySecondFactor) so single-use is enforced.
          if (sf.backupCodes) await env.DB.prepare('UPDATE researcher SET backup_codes=? WHERE researcher_id=?').bind(JSON.stringify(sf.backupCodes), r.researcher_id).run();
        }
        await env.DB.prepare("UPDATE install SET wipe_state='requested', wipe_at=? WHERE install_id=?").bind(now, installId).run();
        return j({ ok: true }, 200, origin, env);
      }

      // POST .../wipe-ack — the DEVICE confirms it received the wipe directive and is about to erase. Auth
      // is the install itself (it acks BEFORE eraseAllData destroys its credentials — the only ack possible
      // in a no-login model). Marks confirmed + revoked so any surviving-creds re-poll just 410s (release).
      if (m === 'POST' && isub === 'wipe-ack' && seg.length === 6) {
        const install = await authInstall(request, env, instanceId, installId);
        if (!install) return j({ error: 'unauthorized' }, 401, origin, env);
        await env.DB.prepare("UPDATE install SET wipe_state='confirmed', revoked=1, last_seen_at=? WHERE install_id=?").bind(now, installId).run();
        return j({ ok: true }, 200, origin, env);
      }

      // POST .../force-remove — researcher gives up waiting on a device that never confirmed. KEEP-
      // ARMED: hide it from the panel but DO NOT delete the row + DO NOT clear wipe_state, so if that device
      // ever reconnects (weeks/months later) it still receives the wipe. (A normal unlink would lose it.)
      if (m === 'POST' && isub === 'force-remove' && seg.length === 6) {
        /* OWNER-ONLY in v1 (round-1 finding 6): remote wipe and force-remove destroy a field
         * device's work, and no capability delegates that yet. `isOwner` covers the legacy
         * dual-read path too, so an unmigrated instance behaves exactly as it does today. */
        const ctx = await authMember(request, env, { instance: instanceId }, null);
        if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);
        if (!ctx.ok || !ctx.isOwner) return j({ error: 'not_found' }, 404, origin, env);
        const r = ctx.owner;
        const owned = await env.DB.prepare(
          'SELECT i.install_id FROM install i JOIN instance n ON n.instance_id=i.instance_id WHERE i.install_id=? AND i.instance_id=? AND n.researcher_id=?'
        ).bind(installId, instanceId, r.researcher_id).first();
        if (!owned) return j({ error: 'not_found' }, 404, origin, env);
        await env.DB.prepare('UPDATE install SET wipe_hidden=1 WHERE install_id=?').bind(installId).run();
        return j({ ok: true }, 200, origin, env);
      }

      // POST .../upload/start — begin a CHUNKED resumable upload (big files: WAV/
      // FLAC of any practical size). The worker opens a Drive resumable session in
      // the researcher's own Drive and returns it as an OPAQUE token (encrypted at
      // rest, bound to this install) — the worker stays stateless; the session
      // itself lives ~a week at Google, so the device can resume across reloads,
      // crashes, and long offline gaps.
      if (m === 'POST' && isub === 'upload' && seg.length === 7 && seg[6] === 'start') {
        const install = await authInstall(request, env, instanceId, installId);
        if (!install) return j({ error: 'unauthorized' }, 401, origin, env);
        if (install.status !== 'approved') return j({ error: 'not_approved' }, 403, origin, env);
        const inst = await env.DB.prepare(
          'SELECT i.nickname AS inst_nickname, i.oauth_folder_id AS inst_folder, i.revoked AS inst_revoked, r.* FROM instance i JOIN researcher r ON r.researcher_id=i.researcher_id WHERE i.instance_id=?'
        ).bind(instanceId).first();
        if (!inst || inst.inst_revoked) return j({ error: 'revoked' }, 410, origin, env);
        if (!inst.drive_refresh_enc) return j({ error: 'no_drive' }, 409, origin, env);
        const body = await readJson(request) || {};
        const size = parseInt(body.size, 10) || 0;
        if (size < 1 || size > 2 * 1024 * 1024 * 1024) return j({ error: 'bad_size' }, 400, origin, env);
        const name = String(body.name || '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 180) || ('upload-' + now + '.bin');
        const mime = String(body.mime || 'application/octet-stream').slice(0, 100);
        try {
          const access = await driveAccessToken(env, inst);
          const deviceFolder = await driveEnsureDeviceFolder(env, access, instanceId, inst.inst_nickname, inst.inst_folder);
          // Per-text sub-folder when the device declares which text this belongs to (new engines
          // send docId/docTitle; old engines omit them and land in the device folder as before).
          const textFolder = body.docId
            ? await driveEnsureTextFolder(access, deviceFolder, body.docId, body.docTitle, body.folderId)
            : deviceFolder;
          /* ⚠ NEVER AWAITED — the done marker must not sit in the upload's critical path.
           * It is cosmetic (a tag + a folder-name suffix), while this path is the single most
           * important one in the system: a field device on a bad connection pushing a text it may
           * have spent hours on. Awaiting a Drive round trip here would add latency to every
           * upload, and a Drive call that hangs would stall the upload itself, to decorate a
           * folder. ctx.waitUntil lets it finish AFTER the response, so a failure or a slow Drive
           * costs the upload nothing. Absent => null => no change (old engines send nothing). */
          if (body.docId && body.sub !== 'originals') {
            ctx.waitUntil(driveTextHousekeeping(access, textFolder, {
              want: body.done === '1' ? true : body.done === '0' ? false : null,
              deviceFolder, title: body.docTitle }));
          }
          // Same v2 source-package routing as the single-POST path: `sub` picks the originals/
          // child, `role` becomes the tag consumers match on instead of the filename.
          const folder = (body.sub === 'originals' && body.docId)
            ? await driveEnsureChildFolder(access, textFolder, 'originals', 'originals')
            : textFolder;
          const role = String(body.role || '').trim().slice(0, 40);
          const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + access, 'content-type': 'application/json',
              'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(size),
            },
            body: JSON.stringify({ name, mimeType: mime, parents: [folder], ...(role ? { appProperties: { flextextRole: role } } : {}) }),
          });
          const session = init.ok ? init.headers.get('Location') : null;
          if (!session) { const e = new Error('no upload session (HTTP ' + init.status + ')'); e.code = 'drive_error'; throw e; }
          const uploadId = await encAtRest(env, JSON.stringify({ u: session, i: installId, s: size }));
          // ⚠ Echo the TEXT folder, never `folder` — with sub='originals' those differ, and the
          // device stamps this as rec.driveFolderId and sends it back as the knownId on its NEXT
          // upload. Echoing the originals/ child would make files.get verify it, and every later
          // bare .flextext would land INSIDE originals/ instead of the text folder.
          return j({ ok: true, uploadId, folderId: textFolder !== deviceFolder ? textFolder : undefined }, 200, origin, env);
        } catch (e) {
          await noteDriveError(env, inst.researcher_id, 'chunked upload start failed: ' + safeErr(e));
          return j({ error: e.code || 'drive_error' }, 502, origin, env);
        }
      }

      // PUT .../upload/chunk — relay ONE slice (or a "bytes */<total>" status probe)
      // to the Drive session named by x-fx-upload. Drive itself is the source of
      // truth for how many bytes landed (the 308 Range header), which is what makes
      // resume exact after any kind of interruption. Chunks are buffered (≤32 MiB,
      // well inside worker memory) so Drive gets a proper Content-Length.
      if (m === 'PUT' && isub === 'upload' && seg.length === 7 && seg[6] === 'chunk') {
        const install = await authInstall(request, env, instanceId, installId);
        if (!install) return j({ error: 'unauthorized' }, 401, origin, env);
        let sess = null;
        try { sess = JSON.parse(await decAtRest(env, request.headers.get('x-fx-upload') || '')); } catch { sess = null; }
        // `sess.i` is the DEVICE-route ownership key; researcher-route tokens carry `sess.rr`
        // instead and can never pass here (see relayDriveChunk).
        if (!sess || !sess.u || sess.i !== installId) return j({ error: 'bad_upload' }, 403, origin, env);
        const out = await relayDriveChunk(request, sess);
        return j(out.body, out.status, origin, env);
      }

      // POST .../upload — DEVICE STREAMING UPLOAD: the enrolled device sends its
      // bundle bytes; the worker streams them into the researcher's OWN Drive at
      // "FlexText Uploads / <device nickname>". No base64, no 15 MB/no-WAV relay
      // limits (lossless takes finally upload). Auth = the install itself; the
      // client falls back to the relay on ANY non-ok answer, so a token problem
      // never strands a field upload — it just lands the old way.
      if (m === 'POST' && isub === 'upload' && seg.length === 6) {
        const install = await authInstall(request, env, instanceId, installId);
        if (!install) return j({ error: 'unauthorized' }, 401, origin, env);
        if (install.status !== 'approved') return j({ error: 'not_approved' }, 403, origin, env);
        const inst = await env.DB.prepare(
          'SELECT i.nickname AS inst_nickname, i.oauth_folder_id AS inst_folder, i.revoked AS inst_revoked, r.* FROM instance i JOIN researcher r ON r.researcher_id=i.researcher_id WHERE i.instance_id=?'
        ).bind(instanceId).first();
        if (!inst || inst.inst_revoked) return j({ error: 'revoked' }, 410, origin, env);
        if (!inst.drive_refresh_enc) return j({ error: 'no_drive' }, 409, origin, env);   // → relay fallback
        const cap = 95 * 1024 * 1024;   // Cloudflare free-plan body ceiling is 100 MB — stay under it
        const clen = parseInt(request.headers.get('content-length') || '0', 10);
        if (clen > cap) return j({ error: 'too_large', limit: cap }, 413, origin, env);
        let name = '';
        try { name = decodeURIComponent(request.headers.get('x-fx-name') || ''); } catch { /* keep '' */ }
        name = name.replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 180) || ('upload-' + now + '.bin');
        const mime = String(request.headers.get('x-fx-mime') || 'application/octet-stream').slice(0, 100);
        // Per-text folder identity: headers, because the body is the raw file bytes. Old engines
        // simply do not send them and their uploads land in the device folder exactly as before.
        const docId = String(request.headers.get('x-fx-doc') || '').trim();
        let docTitle = '';
        try { docTitle = decodeURIComponent(request.headers.get('x-fx-doctitle') || ''); } catch { /* keep '' */ }
        const knownFolder = String(request.headers.get('x-fx-folder') || '').trim();   // the id we returned last time
        // v2 source package: 'assignment' files the upload in the text's assignment/ child, and the
        // role tag is what every consumer matches on (never the filename — a story rename must not
        // break detection). Absent on old engines → the text folder, exactly as before.
        const sub = String(request.headers.get('x-fx-sub') || '').trim();
        const role = String(request.headers.get('x-fx-role') || '').trim().slice(0, 40);
        const buf = await request.arrayBuffer();
        if (buf.byteLength > cap) return j({ error: 'too_large', limit: cap }, 413, origin, env);
        if (!buf.byteLength) return j({ error: 'empty' }, 400, origin, env);
        try {
          const access = await driveAccessToken(env, inst);
          const deviceFolder = await driveEnsureDeviceFolder(env, access, instanceId, inst.inst_nickname, inst.inst_folder);
          const textFolder = docId ? await driveEnsureTextFolder(access, deviceFolder, docId, docTitle, knownFolder) : deviceFolder;
          if (docId && sub !== 'originals') {
            // Query param, NOT a header: a custom header needs a CORS allow-list entry, and until
            // this worker is deployed the browser refuses the whole upload at preflight. See the
            // note in upload.js — this is what makes a new client safe against an old worker.
            // waitUntil, not await: see the chunked path — cosmetic work never blocks an upload.
            const hd = url.searchParams.get('done');
            ctx.waitUntil(driveTextHousekeeping(access, textFolder, {
              want: hd === '1' ? true : hd === '0' ? false : null, deviceFolder, title: docTitle }));
          }
          const folder = (sub === 'originals' && docId)
            ? await driveEnsureChildFolder(access, textFolder, 'originals', 'originals')
            : textFolder;
          const fileId = await driveUpload(access, folder, name, buf, mime, role ? { flextextRole: role } : null);
          // folderId rides back so the device REMEMBERS it (strong-consistency dedupe above).
          // ⚠ The TEXT folder, never `folder`: see the chunked path — echoing the originals/ child
          // would redirect every later bare .flextext into it.
          return j({ ok: true, fileId, folderId: textFolder !== deviceFolder ? textFolder : undefined }, 200, origin, env);
        } catch (e) {
          await noteDriveError(env, inst.researcher_id, 'device upload fell back to the relay: ' + safeErr(e));
          return j({ error: e.code || 'drive_error' }, 502, origin, env);   // → relay fallback
        }
      }

      // POST .../report — the install writes ONLY its own reported row (§E.1).
      if (m === 'POST' && isub === 'report' && seg.length === 6) {
        const install = await authInstall(request, env, instanceId, installId);
        if (!install) return j({ error: 'unauthorized' }, 401, origin, env);
        const body = await readJson(request);
        if (!body || typeof body.reported === 'undefined') return j({ error: 'bad_body' }, 400, origin, env);
        const newBlob = JSON.stringify(body.reported);
        const ackSeq = Math.max(install.ack_seq, parseInt(body.ack_seq || 0, 10) || 0);
        // Server-side idempotency (§C/§F): unchanged inventory → only touch last_seen, no rev bump.
        if (newBlob === install.reported_blob && ackSeq === install.ack_seq) {
          await env.DB.prepare('UPDATE install SET last_seen_at=? WHERE install_id=?').bind(now, installId).run();
          return j({ ok: true, unchanged: true }, 200, origin, env);
        }
        /* ⚠ MAX() IN SQL, NOT IN JAVASCRIPT. `install` was read by authInstall() at request entry —
         * BEFORE `await readJson(request)` streamed an encrypted inventory over a field uplink, which
         * can take seconds. A JS `Math.max` against that stale row means two overlapping reports from
         * one install last-writer-wins, and `ack_seq` can move BACKWARDS: every comment in this file
         * and test/command-seq-invariant.test.mjs assume it only rises, and the cancel endpoint's
         * safety proof ("nothing has acted on a seq above max(ack_seq)") rests on it. reportNow() is
         * deliberately not gated by sync.js's inFlight, so the overlap is reachable, not theoretical.
         * Doing the comparison in the UPDATE makes it atomic with the write. */
        await env.DB.prepare('UPDATE install SET reported_blob=?, reported_rev=reported_rev+1, ack_seq=MAX(ack_seq, ?), last_seen_at=? WHERE install_id=? AND instance_id=? AND revoked=0')
          .bind(newBlob, ackSeq, now, installId, instanceId).run();
        return j({ ok: true }, 200, origin, env);
      }
    }

    // GET /v1/instances/<id>?since=<rev> — desired lane. Install (approved, not
    // revoked) OR researcher. rev short-circuit keeps idle polls cheap (§C.2).
    if (m === 'GET' && seg.length === 3) {
      const since = parseInt(url.searchParams.get('since') || '-1', 10);
      const installId = request.headers.get('x-fx-install') || '';
      let asResearcher = null;
      let install = null;
      if (installId) install = await authInstall(request, env, instanceId, installId);
      else asResearcher = await authResearcher(request, env);
      // Distinguish a REVOKED install from a bad secret, so a revoked device auto-releases (un-orphans)
      // instead of polling forever. A genuinely bad/absent secret still gets a plain 401.
      if (installId && !install) {
        // The install didn't authenticate. Distinguish a binding that is GONE — row flagged revoked=1, OR
        // the row no longer exists at all (the researcher self-deleted their account, which DELETEs the
        // install/instance rows) — from a transient bad secret on a still-LIVE row. If the row is absent
        // or revoked, return 410 so the field device AUTO-RELEASES (clearSession + onRevoked: drops the
        // sync link, scrubs Drive config, keeps its local texts) instead of 401-looping forever and
        // stranding the coworker. A wrong secret on a live (revoked=0) row still gets a plain 401.
        const row = await env.DB.prepare('SELECT revoked, wipe_state FROM install WHERE install_id=? AND instance_id=?').bind(installId, instanceId).first();
        // Re-arm on BOTH 'requested' AND 'confirmed': a 'confirmed' row that re-polls with surviving creds
        // means the wipe did NOT finish (a finished wipe has no creds and never polls again) → re-issue it.
        // Self-healing + idempotent, and it OUTRANKS revoke (a revoked-then-wipe device still wipes).
        if (row && (row.wipe_state === 'requested' || row.wipe_state === 'confirmed')) return j({ wipe: true }, 200, origin, env);
        if (!row || row.revoked) return j({ error: 'revoked' }, 410, origin, env);
      }
      if (!install && !asResearcher) return j({ error: 'unauthorized' }, 401, origin, env);
      // REMOTE-WIPE directive (plaintext, top priority): a flagged device wipes itself on THIS poll,
      // regardless of cursor / pending / key state. Checked before the since/pending/desired gates below so
      // it lands in any device state (even one lost mid-enrollment that never received its key).
      if (install && install.wipe_state === 'requested') return j({ wipe: true }, 200, origin, env);

      /* ⚠ `nickname` IS IN THIS COLUMN LIST, and it was missing for the whole life of the feature.
       * Both branches below send `nickname: inst.nickname || ''`, so an absent column made that
       * `undefined || ''` — every device was told its name was the empty string, on the pending
       * screen and after approval, which is the one moment two people are trying to agree which
       * device they are holding. Shipped broken in v440 and live on productionWeb until 2026-08-23.
       *
       * ⚠ It went unnoticed because test/pair-code.test.mjs asserted the SOURCE STRING
       * `nickname: inst.nickname` appeared twice — which it did, while always evaluating to ''.
       * A test that pins source text can vouch for a feature that does nothing; the real check now
       * lives in test/worker-device-compat.probe.mjs and asserts the VALUE a real device receives.
       * Add a column to this SELECT and you must also send it. */
      const inst = await env.DB.prepare('SELECT desired_blob, desired_rev, type, revoked, researcher_id, nickname FROM instance WHERE instance_id=?')
        .bind(instanceId).first();
      if (!inst) return j({ error: 'not_found' }, 404, origin, env);
      /* ⚠ THE OWNERSHIP CHECK COMES FIRST, AND ANSWERS not_found — both halves matter, and both were
       * wrong (2026-08-21 sweep). It used to answer 403 AFTER the revoked check, which gave ONE
       * authenticated caller three distinguishable answers for an id they do not own: 404 for an id
       * that does not exist, 410 for a real instance since revoked, 403 for a real live one. That is
       * an oracle for both the existence and the revocation state of every device id anybody has
       * ever seen — in an old invite link, a support screenshot, a project they were removed from.
       *
       * Reordered so a caller who is not entitled to the instance learns nothing about it, and the
       * refusal is the same not_found every other denial answers.
       *
       * ⚠ THE INSTALL LANE IS UNTOUCHED: `asResearcher` is null when an install authenticated, so a
       * revoked DEVICE still gets its 410 and still auto-releases. That behaviour is load-bearing —
       * without it a revoked phone 401-loops forever and strands the coworker — and it is exactly
       * what the device-compat probe pins. */
      if (asResearcher && inst.researcher_id !== asResearcher.researcher_id) return j({ error: 'not_found' }, 404, origin, env);
      if (inst.revoked) return j({ error: 'revoked' }, 410, origin, env);   // whole-instance revoke → client auto-releases
      // Provisional installs (§D.3) receive NO commands until approved.
      if (install && install.status !== 'approved') {
        return j({ pending: true, type: inst.type, nickname: inst.nickname || '', desired_rev: inst.desired_rev }, 200, origin, env);
      }
      if (inst.desired_rev <= since) return new Response(null, { status: 204, headers: v1Cors(origin, env) });
      const blob = inst.desired_blob ? JSON.parse(inst.desired_blob) : { settings: {}, commands: [] };
      /* ⚠ `nickname` RIDES BOTH BRANCHES (Seth, 2026-08-20): "we also need a way to be 100% sure
       * that the device we're using DOES in fact match the device listed in the tile." A device has
       * never been told the name its researcher gave it, so the only way to identify the app in front
       * of you was to compare engine versions and guess — which is exactly how an hour went into
       * asking whether a text list was empty or simply the wrong window.
       *
       * It rides the PENDING branch too, so the name is on screen while the pairing code is, which is
       * the moment two people are trying to agree on which device they are talking about.
       *
       * Additive: an older client ignores the field. Not secret — it is the device owner's own name
       * for their own device, shown only on that device. */
      return j({ type: inst.type, nickname: inst.nickname || '', desired_rev: inst.desired_rev, settings: blob.settings || {}, commands: blob.commands || [], wrapped_key: install ? (install.wrapped_key || null) : undefined }, 200, origin, env);
    }
  }

  // POST /v1/invites/<id>/claim — client-minted, idempotent, provisional, atomic (§D).
  if (m === 'POST' && seg.length === 4 && seg[1] === 'invites' && seg[3] === 'claim') {
    const inviteId = seg[2];
    const inviteSecret = request.headers.get('x-fx-invite-secret') || '';
    const body = await readJson(request);
    const installId = body && body.install_id;
    const installSecret = body && body.install_secret;
    const pubkey = (body && body.pubkey) || null;   // E2EE model A: install's RSA-OAEP public key (SPKI b64)
    if (!inviteSecret || !installId || !installSecret) return j({ error: 'bad_body' }, 400, origin, env);

    const inv = await env.DB.prepare('SELECT * FROM invite WHERE invite_id=?').bind(inviteId).first();
    if (!inv || !ctEq(await sha256hex(inviteSecret), inv.secret_hash)) return j({ error: 'unauthorized' }, 401, origin, env);
    if (inv.expires_at && inv.expires_at <= now) return j({ error: 'expired' }, 410, origin, env);

    // Idempotent retry: this same install already won (lost-response recovery, §D.1).
    if (inv.claimed_at && inv.claimed_install === installId) {
      const ok = await env.DB.prepare('SELECT install_id, pair_code FROM install WHERE install_id=? AND instance_id=?').bind(installId, inv.instance_id).first();
      if (ok) {
        const who = await pairingIdentity(env, inv);
        /* ⚠ THE SAME CODE, NOT A FRESH ONE. This is the lost-response retry path: the device is
         * asking again because it never saw the first answer, and it may already be showing the code
         * to a researcher who is reading it aloud. Re-minting here would change the number on one
         * screen only — the exact "they don't match" dead end this feature exists to remove. */
        return j({ instance_id: inv.instance_id, type: who.type, status: 'pending', pair_code: ok.pair_code || '', researcher: who.researcher }, 200, origin, env);
      }
    }
    if (inv.claimed_at) return j({ error: 'already_claimed' }, 409, origin, env);

    // Fresh claim — one atomic batch (§D.2): create the install, claim the invite
    // (guarded on still-unclaimed + not-expired), and revoke prior installs of the
    // instance (single-live-device, §D.4) only if THIS install wins the claim.
    const secretHash = await sha256hex(installSecret);
    const pairCode = mintPairCode();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT OR IGNORE INTO install (install_id, instance_id, secret_hash, status, reported_rev, ack_seq, revoked, created_at, pubkey, pair_code) ' +
        "SELECT ?, instance_id, ?, 'pending', 0, 0, 0, ?, ?, ? FROM invite WHERE invite_id=? AND claimed_at IS NULL AND (expires_at IS NULL OR expires_at>?)"
      ).bind(installId, secretHash, now, pubkey, pairCode, inviteId, now),
      env.DB.prepare(
        'UPDATE invite SET claimed_at=?, claimed_install=? WHERE invite_id=? AND claimed_at IS NULL AND (expires_at IS NULL OR expires_at>?)'
      ).bind(now, installId, inviteId, now),
      env.DB.prepare(
        'UPDATE install SET revoked=1 WHERE instance_id=? AND install_id<>? AND revoked=0 AND EXISTS (SELECT 1 FROM invite WHERE invite_id=? AND claimed_install=?)'
      ).bind(inv.instance_id, installId, inviteId, installId),
    ]);

    // Confirm we won the race (D1 serializes batches; a loser sees claimed_install != us).
    const after = await env.DB.prepare('SELECT claimed_install FROM invite WHERE invite_id=?').bind(inviteId).first();
    if (!after || after.claimed_install !== installId) return j({ error: 'already_claimed' }, 409, origin, env);
    const who = await pairingIdentity(env, inv);
    /* ⚠ READ BACK rather than returning `pairCode`. The INSERT is OR IGNORE, so on the path where a
     * row already existed the STORED code is the one both screens must show — trusting the local
     * variable would hand this device a number the panel will never display. */
    const mine = await env.DB.prepare('SELECT pair_code FROM install WHERE install_id=?').bind(installId).first();
    return j({ instance_id: inv.instance_id, type: who.type, status: 'pending', pair_code: (mine && mine.pair_code) || '', researcher: who.researcher }, 200, origin, env);
  }

  /* ---------------- Drive delivery mode (researcher-authed) ---------------- */

  // GET /v1/researcher/drive — Google Drive connection state for the panel. There is
  // NO delivery mode: streaming-to-own-Drive is always tried first when connected,
  // with the relay as the automatic fallback (see the crowd submit route).
  if (m === 'GET' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'drive') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    let err = null; try { err = r.drive_error ? JSON.parse(r.drive_error) : null; } catch { err = null; }
    return j({ connected: !!r.drive_refresh_enc, email: r.drive_email || '', error: err }, 200, origin, env);
  }

  // POST /v1/researcher/drive/test — live end-to-end test of the researcher's own
  // Drive connection (token mint + file create/delete). Clears drive_error on success.
  if (m === 'POST' && seg.length === 4 && seg[1] === 'researcher' && seg[2] === 'drive' && seg[3] === 'test') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    try {
      await driveSelfTest(env, r);
      await env.DB.prepare('UPDATE researcher SET drive_error=NULL WHERE researcher_id=?').bind(r.researcher_id).run();
      return j({ ok: true, note: 'created + deleted a test file in your Drive' }, 200, origin, env);
    } catch (e) {
      // 409, not 5xx: these are deterministic configuration states — a 5xx would make
      // the panel's api() retry-with-backoff for ~20s before showing the (fixed)
      // guidance, which reads as a hang to the researcher.
      return j({ error: e.code || 'drive_error', detail: e.message }, 409, origin, env);
    }
  }

  // (There is deliberately no drive/mode endpoint: delivery is always own-Drive-
  // first-with-relay-fallback. The researcher.drive_mode column is unused/ignored.)

  // POST /v1/researcher/drive/testfile — (authed) proof-of-life for the OAuth Drive
  // STREAMING leg, needing NO Google Cloud Console: refresh the researcher's own
  // stored token, ensure an app-created "FlexText — OAuth test" folder, and write a
  // real file into it via the SAME resumable streaming path the crowd recorder uses
  // (driveUpload) — then KEEP it so the researcher can open it in their Drive.
  // Isolated + additive: touches no existing route and no field path.
  if (m === 'POST' && seg.length === 4 && seg[1] === 'researcher' && seg[2] === 'drive' && seg[3] === 'testfile') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    try {
      const access = await driveAccessToken(env, r);
      // Test files land in the SAME "FlexText Uploads" master folder real
      // deliveries use — the test doubles as proof of where things will arrive.
      const folderId = await driveMasterFolder(access);
      const stamp = new Date(now).toISOString();
      const text = 'FlexText OAuth streaming-proxy test.\n\nThis file was written by the Cloudflare Worker using YOUR Google Drive\nconnection (drive.file scope), through the same resumable streaming upload the\ncrowd recorder uses.\n\nTime: ' + stamp + '\n\nIf you can read this in your Drive, the direct-to-your-Drive upload path works\nend to end — no relay account involved.\n';
      const buf = new TextEncoder().encode(text);
      const fileId = await driveUpload(access, folderId, 'flextext-oauth-test-' + stamp.replace(/[:.]/g, '-') + '.txt', buf, 'text/plain');
      await env.DB.prepare('UPDATE researcher SET drive_error=NULL WHERE researcher_id=?').bind(r.researcher_id).run();
      return j({ ok: true, folderId, fileId,
                 fileLink: 'https://drive.google.com/file/d/' + fileId + '/view',
                 folderLink: 'https://drive.google.com/drive/folders/' + folderId,
                 email: r.drive_email || '' }, 200, origin, env);
    } catch (e) {
      return j({ error: e.code || 'drive_error', detail: e.message }, 409, origin, env);
    }
  }

  /* ---------------- crowd recorders (public crowd-source recording pages) ---------------- */

  if (seg[1] === 'crowd') {
    // GET /v1/crowd — the researcher's recorders (authed list; config parsed for the panel).
    if (m === 'GET' && seg.length === 2) {
      const r = await authResearcher(request, env);
      if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
      if (!isApproved(r, env)) return j({ error: 'pending_approval' }, 403, origin, env);
      const rows = (await env.DB.prepare(
        'SELECT crowd_id, label, enabled, created_at, config_json, drive_folder, oauth_folder_id, submit_count, bytes_total, day_key, day_count, max_per_day, max_bytes_total, estate FROM crowd_recorder WHERE researcher_id=? ORDER BY created_at'
      ).bind(r.researcher_id).all()).results || [];
      const today = new Date(now).toISOString().slice(0, 10);
      for (const row of rows) {
        row.config = normCrowdConfig(crowdParse(row.config_json));
        delete row.config_json;
        if (row.day_key !== today) row.day_count = 0;   // panel shows TODAY's count, not a stale day's
      }
      return j({ recorders: rows }, 200, origin, env);
    }

    // POST /v1/crowd — create a recorder.
    if (m === 'POST' && seg.length === 2) {
      const r = await authResearcher(request, env);
      if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
      if (!isApproved(r, env)) return j({ error: 'pending_approval' }, 403, origin, env);
      const body = await readJson(request) || {};
      const label = String(body.label || '').trim().slice(0, 80);
      if (!label) return j({ error: 'label_required' }, 400, origin, env);
      const crowd_id = crypto.randomUUID();
      // Same rule as a new instance: a recorder created now is a Cloudflare recorder, and its
      // public link must keep saying so for the rest of its life even if the panel moves.
      await env.DB.prepare(
        'INSERT INTO crowd_recorder (crowd_id, researcher_id, label, enabled, config_json, drive_folder, created_at, estate) VALUES (?,?,?,?,?,?,?,?)'
      ).bind(crowd_id, r.researcher_id, label, 1, JSON.stringify(normCrowdConfig(body.config)), '', now, 'cloud').run();
      /* ⚠ BORN INTO THE PROJECT ON SCREEN — the same gap v426 closed for devices, one function over,
       * and missed then. driveEnsureCrowdFolder resolves its parent from `rec.project_id`, which is
       * always NULL, so it falls back to the DEFAULT project: a recorder created while looking at a
       * second project would silently appear in the first. Eager creation makes Drive parentage the
       * record from birth, exactly as for a device. Best-effort: a Drive failure must not lose the
       * recorder that was just created — it falls back to the lazy path. */
      const wantProject = String(body.projectFolderId || '').replace(/[^\w-]/g, '').slice(0, 128);
      let folderId = '';
      if (wantProject) {
        try {
          const access = await driveAccessToken(env, r);
          const dest = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(wantProject) + '?fields=id,appProperties');
          if (((dest.appProperties || {}).flextextRole || '') === 'project') {
            const name = 'Crowd — ' + label;
            const f = await driveJson(access, 'POST', 'https://www.googleapis.com/drive/v3/files?fields=id',
              { name, mimeType: 'application/vnd.google-apps.folder', parents: [wantProject],
                appProperties: { flextextRole: 'crowd' } });
            folderId = f.id;
            await env.DB.prepare('UPDATE crowd_recorder SET oauth_folder_id=? WHERE crowd_id=?').bind(f.id, crowd_id).run();
          }
        } catch { /* the recorder exists; its folder can still be made lazily */ }
      }
      return j({ crowd_id, estate: 'cloud', folderId }, 200, origin, env);
    }

    // Everything below addresses one recorder.
    if (seg.length >= 3) {
      const crowdId = seg[2];

      // PUBLIC — GET /v1/crowd/<id>: the config PROJECTION the crowd page renders.
      // No auth and deliberately NO per-IP limit: a village WhatsApp group behind one
      // carrier CGNAT IP must all be able to open the page (it's one cheap D1 read;
      // the Workers free-plan 100k req/day throttle is the flood backstop). NEVER
      // returns drive_folder / researcher ids — a public link must not become an
      // exfil or upload-target oracle.
      if (m === 'GET' && seg.length === 3) {
        const rec = await env.DB.prepare(
          'SELECT c.*, (r.drive_refresh_enc IS NOT NULL) AS drive_connected FROM crowd_recorder c JOIN researcher r ON r.researcher_id=c.researcher_id WHERE c.crowd_id=?'
        ).bind(crowdId).first();
        if (!rec) return j({ error: 'not_found' }, 404, origin, env);
        const today = new Date(now).toISOString().slice(0, 10);
        const dayCount = rec.day_key === today ? rec.day_count : 0;
        const overBudget = dayCount >= rec.max_per_day || rec.bytes_total >= rec.max_bytes_total;
        // No Google connection = nowhere to deliver: paused until the researcher
        // signs back in (sign-in IS the connection, so this is a rare stale state).
        if (!rec.enabled || overBudget || !rec.drive_connected) {
          return j({ enabled: false, reason: !rec.enabled || !rec.drive_connected ? 'paused' : 'budget' }, 200, origin, env);
        }
        const cfg = normCrowdConfig(crowdParse(rec.config_json));
        return j({
          enabled: true,
          welcome: cfg.welcome, consentAsk: cfg.consentAsk, consentConfirm: cfg.consentConfirm,
          consentMsg: cfg.consentMsg, consentAudio: cfg.consentAudioUrl,
          lang: cfg.lang, maxSeconds: cfg.maxSeconds, turnstile: cfg.turnstile,
          recordFormat: cfg.recordFormat,
          maxBytes: crowdMaxBytes(cfg),
        }, 200, origin, env);
      }

      // PUBLIC — POST /v1/crowd/<id>/submit/start: begin a CHUNKED submission (big
      // lossless takes; a single request is platform-capped at ~100 MB, chunks are
      // not). Turnstile gates the START (one bot-check per submission); the Drive
      // session is opened with the RESEARCHER's token and returned as an OPAQUE
      // encrypted ticket bound to this recorder + a declared size that GOOGLE
      // enforces (the session refuses bytes beyond it). Budgets checked here
      // against the declared size; counters bump once at completion (idempotent).
      if (m === 'POST' && seg.length === 5 && seg[3] === 'submit' && seg[4] === 'start') {
        const ip = request.headers.get('CF-Connecting-IP') || 'anon';
        if (env.SIGNUP_LIMIT) { const { success } = await env.SIGNUP_LIMIT.limit({ key: `crowdsub:${ip}:${crowdId}` }); if (!success) return j({ error: 'rate_limited' }, 429, origin, env); }
        const rec = await env.DB.prepare(
          'SELECT c.*, (r.drive_refresh_enc IS NOT NULL) AS drive_connected FROM crowd_recorder c JOIN researcher r ON r.researcher_id=c.researcher_id WHERE c.crowd_id=?'
        ).bind(crowdId).first();
        if (!rec) return j({ error: 'not_found' }, 404, origin, env);
        if (!rec.enabled || !rec.drive_connected) return j({ error: 'paused' }, 403, origin, env);
        const today = new Date(now).toISOString().slice(0, 10);
        const dayCount = rec.day_key === today ? rec.day_count : 0;
        const cfg = normCrowdConfig(crowdParse(rec.config_json));
        const body = await readJson(request) || {};
        const size = parseInt(body.size, 10) || 0;
        if (size < 4096 || size > crowdMaxBytes(cfg)) return j({ error: 'too_large', limit: crowdMaxBytes(cfg) }, 413, origin, env);
        if (dayCount >= rec.max_per_day || rec.bytes_total + size > rec.max_bytes_total) return j({ error: 'budget' }, 429, origin, env);
        if (cfg.turnstile) {
          if (!env.TURNSTILE_SECRET) return j({ error: 'unavailable' }, 503, origin, env);
          if (!await verifyTurnstile(request.headers.get('x-fx-turnstile'), ip, env)) return j({ error: 'turnstile_failed' }, 403, origin, env);
        }
        const subId = crypto.randomUUID();
        const slug = String(rec.label || 'crowd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'crowd';
        // ...Z: ISO 8601's own UTC marker. The colons are already dashes for filename safety, which
        // loses the usual visual cue, so the Z is what keeps it unambiguous.
        const name = 'crowd_' + slug + '_' + new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z_' + subId.slice(0, 8) + '.zip';
        try {
          const rrow = await env.DB.prepare('SELECT * FROM researcher WHERE researcher_id=?').bind(rec.researcher_id).first();
          const access = await driveAccessToken(env, rrow);
          // Its own text folder + originals/, through the same helpers the device upload path uses.
          const { originals } = await driveEnsureCrowdTextFolder(env, access, rec, subId, now);
          const folder = originals;
          const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + access, 'content-type': 'application/json',
                       'X-Upload-Content-Type': 'application/zip', 'X-Upload-Content-Length': String(size) },
            // ⚠ NOT 'source-audio'. The panel resolves a text's audio BY ROLE, and this is a zip
            // (recording + consent receipt) — claiming the audio role would make the download menu
            // offer the bundle as if it were the bare audio file. Its own role, honestly named.
            body: JSON.stringify({ name, mimeType: 'application/zip', parents: [folder],
                                   appProperties: { flextextRole: 'crowd-submission' } }),
          });
          const session = init.ok ? init.headers.get('Location') : null;
          if (!session) { const e = new Error('no session (HTTP ' + init.status + ')'); e.code = 'drive_error'; throw e; }
          // `o` rides along so the completion handler can place the manifest beside the zip without
          // re-resolving the folder (and without a second Drive round trip on the public path).
          const uploadId = await encAtRest(env, JSON.stringify({ u: session, c: crowdId, s: size, d: subId, n: name, t: now, o: originals }));
          return j({ ok: true, uploadId }, 200, origin, env);
        } catch (e) {
          await noteDriveError(env, rec.researcher_id, 'crowd chunked start failed: ' + safeErr(e));
          return j({ error: 'delivery_failed' }, 502, origin, env);
        }
      }

      // PUBLIC — PUT /v1/crowd/<id>/submit/chunk: relay one slice (or a bytes */N
      // probe) to the session in the x-fx-upload ticket. Completion logs the
      // submission + bumps counters idempotently (sub_id is the ticket's own id,
      // INSERT OR IGNORE — a replayed final chunk cannot double-count).
      if (m === 'PUT' && seg.length === 5 && seg[3] === 'submit' && seg[4] === 'chunk') {
        let sess = null;
        try { sess = JSON.parse(await decAtRest(env, request.headers.get('x-fx-upload') || '')); } catch { sess = null; }
        if (!sess || !sess.u || sess.c !== crowdId) return j({ error: 'bad_upload' }, 403, origin, env);
        if (now - (sess.t || 0) > 7 * 86400000) return j({ error: 'session_gone' }, 409, origin, env);   // Drive sessions live ~a week
        const range = request.headers.get('x-fx-range') || request.headers.get('content-range') || '';
        if (!/^bytes (\*|\d+-\d+)\/\d+$/.test(range)) return j({ error: 'bad_range' }, 400, origin, env);
        const probe = range.startsWith('bytes */');
        const chunk = probe ? null : await request.arrayBuffer();
        if (chunk && chunk.byteLength > 33 * 1024 * 1024) return j({ error: 'chunk_too_large' }, 413, origin, env);
        let fwd;
        try { fwd = await fetch(sess.u, { method: 'PUT', headers: { 'Content-Range': range }, body: chunk }); }
        catch { return j({ error: 'drive_unreachable' }, 502, origin, env); }
        if (fwd.status === 308) {
          const r = fwd.headers.get('Range');
          return j({ done: false, received: r ? parseInt(r.split('-')[1], 10) + 1 : 0 }, 200, origin, env);
        }
        if (fwd.ok) {
          const data = await fwd.json().catch(() => ({}));
          if (!data.id) return j({ error: 'drive_error' }, 502, origin, env);
          const ip = request.headers.get('CF-Connecting-IP') || 'anon';
          const country = (request.cf && request.cf.country) || '';
          const ipH = env.SERVER_HMAC_KEY ? (await hmacHex(env.SERVER_HMAC_KEY, 'crowdip:' + ip)).slice(0, 32) : '';
          const today = new Date(now).toISOString().slice(0, 10);
          const ins = await env.DB.prepare('INSERT OR IGNORE INTO crowd_submission (sub_id, crowd_id, created_at, bytes, country, ip_hmac, file_name, status) VALUES (?,?,?,?,?,?,?,?)')
            .bind(sess.d, crowdId, now, sess.s, country, ipH, sess.n, 'ok').run();
          // Gated on `changes` with the INSERT: a replayed final chunk must not re-write the
          // manifest any more than it may double-count the submission.
          if (ins.meta.changes && sess.o) {
            ctx.waitUntil((async () => {
              const rrow = await env.DB.prepare('SELECT * FROM researcher WHERE researcher_id=(SELECT researcher_id FROM crowd_recorder WHERE crowd_id=?)').bind(crowdId).first();
              if (!rrow) return;
              const acc2 = await driveAccessToken(env, rrow);
              await crowdExtractManifestById(env, acc2, sess.o, data.id, sess.n, sess.s);
              await crowdUnpackSubmission(env, acc2, sess.o, data.id, sess.s);
            })());
          }
          if (ins.meta.changes) {
            await env.DB.batch([
              env.DB.prepare('UPDATE crowd_recorder SET submit_count=submit_count+1, bytes_total=bytes_total+?, day_count=CASE WHEN day_key=? THEN day_count+1 ELSE 1 END, day_key=? WHERE crowd_id=?')
                .bind(sess.s, today, today, crowdId),
              env.DB.prepare('DELETE FROM crowd_submission WHERE crowd_id=? AND created_at<?').bind(crowdId, now - 30 * 86400000),
            ]);
          }
          return j({ done: true, id: sess.d }, 200, origin, env);
        }
        if (fwd.status === 404 || fwd.status === 410) return j({ error: 'session_gone' }, 409, origin, env);
        return j({ error: 'drive_error' }, 502, origin, env);
      }

      // PUBLIC — POST /v1/crowd/<id>/submit: body = the finished zip (audio + consent
      // receipt). Turnstile fail-closed (when the recorder wants it), size floor+cap,
      // budgets, per-IP rate limit. Delivery: researcher's chosen leg, with automatic
      // relay fallback so a token problem never eats a stranger's recording. Only a
      // CONFIRMED Drive landing returns ok — the page keeps + retries anything else.
      if (m === 'POST' && seg.length === 4 && seg[3] === 'submit') {
        const ip = request.headers.get('CF-Connecting-IP') || 'anon';
        // Keyed per ip+recorder: a workshop behind one CGNAT IP throttles only itself,
        // and the client keeps + auto-retries a 429'd recording (never lost).
        if (env.SIGNUP_LIMIT) { const { success } = await env.SIGNUP_LIMIT.limit({ key: `crowdsub:${ip}:${crowdId}` }); if (!success) return j({ error: 'rate_limited' }, 429, origin, env); }
        const rec = await env.DB.prepare(
          'SELECT c.*, (r.drive_refresh_enc IS NOT NULL) AS drive_connected FROM crowd_recorder c JOIN researcher r ON r.researcher_id=c.researcher_id WHERE c.crowd_id=?'
        ).bind(crowdId).first();
        if (!rec) return j({ error: 'not_found' }, 404, origin, env);
        if (!rec.enabled) return j({ error: 'paused' }, 403, origin, env);
        if (!rec.drive_connected) return j({ error: 'paused' }, 403, origin, env);   // no connection = nowhere to deliver (see GET)
        const today = new Date(now).toISOString().slice(0, 10);
        const dayCount = rec.day_key === today ? rec.day_count : 0;
        if (dayCount >= rec.max_per_day || rec.bytes_total >= rec.max_bytes_total) {
          return j({ error: 'budget' }, 429, origin, env);
        }
        const cfg = normCrowdConfig(crowdParse(rec.config_json));
        if (cfg.turnstile) {
          if (!env.TURNSTILE_SECRET) return j({ error: 'unavailable' }, 503, origin, env);   // fail closed
          if (!await verifyTurnstile(request.headers.get('x-fx-turnstile'), ip, env)) {
            return j({ error: 'turnstile_failed' }, 403, origin, env);
          }
        }
        const cap = crowdMaxBytes(cfg);
        const clen = parseInt(request.headers.get('content-length') || '0', 10);
        if (clen > cap) return j({ error: 'too_large', limit: cap }, 413, origin, env);
        const buf = await request.arrayBuffer();
        if (buf.byteLength > cap) return j({ error: 'too_large', limit: cap }, 413, origin, env);
        if (buf.byteLength < 4096) return j({ error: 'too_small' }, 400, origin, env);   // junk floor

        // Server-composed filename — the visitor controls NOTHING about the Drive write.
        const slug = String(rec.label || 'crowd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'crowd';
        const subId = crypto.randomUUID();
        const name = 'crowd_' + slug + '_' + new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z_' + subId.slice(0, 8) + '.zip';

        // Delivery: the researcher's own Drive (streaming) — the ONLY path. On any
        // failure the visitor's client keeps the zip and retries; the researcher
        // sees drive_error in the panel. Nothing is ever lost — it waits.
        let fileId = null;
        const status = 'ok';
        try {
          const rrow = await env.DB.prepare('SELECT * FROM researcher WHERE researcher_id=?').bind(rec.researcher_id).first();
          const access = await driveAccessToken(env, rrow);
          // Its own text folder + originals/, through the same helpers the device upload path uses.
          const { originals } = await driveEnsureCrowdTextFolder(env, access, rec, subId, now);
          fileId = await driveUpload(access, originals, name, buf, 'application/zip', { flextextRole: 'crowd-submission' });
          // The bytes are already in Drive; unwrapping the manifest is organisational, so it runs
          // after the response and can never turn a delivered submission into a reported failure.
          ctx.waitUntil((async () => {
            await crowdExtractManifest(env, access, originals, new Uint8Array(buf), name, buf.byteLength);
            // Then unpack the rest, so the folder ends up shaped like a device text's (§16.10 B).
            await crowdUnpackSubmission(env, access, originals, fileId, buf.byteLength);
          })());
        } catch (e) {
          await noteDriveError(env, rec.researcher_id, 'crowd delivery failed: ' + safeErr(e));
          return j({ error: 'delivery_failed' }, 502, origin, env);   // client keeps + retries
        }
        const country = (request.cf && request.cf.country) || '';
        const ipH = env.SERVER_HMAC_KEY ? (await hmacHex(env.SERVER_HMAC_KEY, 'crowdip:' + ip)).slice(0, 32) : '';
        await env.DB.batch([
          env.DB.prepare('INSERT INTO crowd_submission (sub_id, crowd_id, created_at, bytes, country, ip_hmac, file_name, status) VALUES (?,?,?,?,?,?,?,?)')
            .bind(subId, rec.crowd_id, now, buf.byteLength, country, ipH, name, status),
          // Relative update (NOT the read value + 1): two concurrent submits must both
          // count. day_count resets in the same statement when the UTC day rolled.
          env.DB.prepare('UPDATE crowd_recorder SET submit_count=submit_count+1, bytes_total=bytes_total+?, day_count=CASE WHEN day_key=? THEN day_count+1 ELSE 1 END, day_key=? WHERE crowd_id=?')
            .bind(buf.byteLength, today, today, rec.crowd_id),
          // Opportunistic prune: the log is a visibility/forensics aid, not an archive.
          env.DB.prepare('DELETE FROM crowd_submission WHERE crowd_id=? AND created_at<?').bind(rec.crowd_id, now - 30 * 86400000),
        ]);
        return j({ ok: true, id: subId }, 200, origin, env);
      }

      // Researcher-authed per-recorder routes. Ownership is enforced in the WHERE
      // clause of every statement (same pattern as the instance routes).
      const r = await authResearcher(request, env);
      if (!r) return j({ error: 'unauthorized' }, 401, origin, env);

      /* CONSENT PROMPT UPLOAD — the crowd twin of the device's assignment/upload trio.
       *
       * A crowd recorder has no instance, so it cannot borrow .../instances/<id>/texts/<docId>/
       * assignment/... — hence its own routes rather than a relaxed guard on those (same reasoning
       * as /adopt vs /move: one endpoint, one meaning). The file lands in the recorder's OWN Drive
       * folder root, exactly as a device prompt lands in the device folder root, tagged
       * flextextRole=consent-prompt so the estate view classifies it identically.
       *
       * ⚠ The session ticket's ownership key is `pr` (+ `rr`), NOT `c`. The PUBLIC submit-chunk
       * relay authorises on `sess.c === crowdId` with no auth at all — a ticket carrying `c` would
       * therefore drive that endpoint too, letting a leaked researcher prompt session be spent by
       * an anonymous visitor. Route-distinct keys are what keep the two relays apart. */

      // POST /v1/crowd/<id>/prompt/upload/start {name, mime, size} → opaque resumable session.
      if (m === 'POST' && seg.length === 6 && seg[3] === 'prompt' && seg[4] === 'upload' && seg[5] === 'start') {
        const rec = await env.DB.prepare('SELECT crowd_id, label, oauth_folder_id FROM crowd_recorder WHERE crowd_id=? AND researcher_id=?')
          .bind(crowdId, r.researcher_id).first();
        if (!rec) return j({ error: 'not_found' }, 404, origin, env);
        const body = await readJson(request) || {};
        const size = parseInt(body.size, 10) || 0;
        if (size < 1 || size > 2 * 1024 * 1024 * 1024) return j({ error: 'bad_size' }, 400, origin, env);
        const name = String(body.name || '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 180) || ('consent-prompt-' + now + '.bin');
        const mime = String(body.mime || 'application/octet-stream').slice(0, 100);
        try {
          const access = await driveAccessToken(env, r);
          const parent = await driveEnsureCrowdFolder(env, access, rec);
          const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + access, 'content-type': 'application/json',
              'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(size),
            },
            body: JSON.stringify({ name, mimeType: mime, parents: [parent], appProperties: { flextextRole: 'consent-prompt' } }),
          });
          const session = init.ok ? init.headers.get('Location') : null;
          if (!session) { const e = new Error('no upload session (HTTP ' + init.status + ')'); e.code = 'drive_error'; throw e; }
          const uploadId = await encAtRest(env, JSON.stringify({ u: session, rr: r.researcher_id, pr: crowdId, s: size }));
          return j({ ok: true, uploadId }, 200, origin, env);
        } catch (e) {
          await noteDriveError(env, r.researcher_id, 'crowd prompt upload start failed: ' + safeErr(e));
          return j({ error: e.code || 'drive_error' }, 502, origin, env);
        }
      }

      // PUT /v1/crowd/<id>/prompt/upload/chunk — same wire contract as every other chunk relay.
      if (m === 'PUT' && seg.length === 6 && seg[3] === 'prompt' && seg[4] === 'upload' && seg[5] === 'chunk') {
        let sess = null;
        try { sess = JSON.parse(await decAtRest(env, request.headers.get('x-fx-upload') || '')); } catch { sess = null; }
        if (!sess || !sess.u || sess.rr !== r.researcher_id || sess.pr !== crowdId) return j({ error: 'bad_upload' }, 403, origin, env);
        const out = await relayDriveChunk(request, sess);
        return j(out.body, out.status, origin, env);
      }

      /* POST /v1/crowd/<id>/prompt/finish {promptFileId, ttlDays} → the private streaming URL the
       * crowd page plays. UNSCOPED for the same reason the device prompt URL is: a prompt is
       * configuration, and a crowd recorder has no instance to scope to in the first place. */
      if (m === 'POST' && seg.length === 5 && seg[3] === 'prompt' && seg[4] === 'finish') {
        const rec = await env.DB.prepare('SELECT crowd_id FROM crowd_recorder WHERE crowd_id=? AND researcher_id=?')
          .bind(crowdId, r.researcher_id).first();
        if (!rec) return j({ error: 'not_found' }, 404, origin, env);
        const body = await readJson(request) || {};
        if (!body.promptFileId) return j({ error: 'nothing_to_mint' }, 400, origin, env);
        const ttlDays = clampTtlDays(body.ttlDays);
        try {
          const promptUrl = await mintTextfileUrl(env, url.origin, r.researcher_id, body.promptFileId, '', ttlDays * 86400000);
          return j({ ok: true, ttlDays, promptUrl }, 200, origin, env);
        } catch (e) { return j({ error: e.code || 'drive_error', message: safeErr(e) }, 502, origin, env); }
      }

      // GET /v1/crowd/<id>/submissions — last 50 for the panel's log modal.
      if (m === 'GET' && seg.length === 4 && seg[3] === 'submissions') {
        const owned = await env.DB.prepare('SELECT crowd_id FROM crowd_recorder WHERE crowd_id=? AND researcher_id=?').bind(crowdId, r.researcher_id).first();
        if (!owned) return j({ error: 'not_found' }, 404, origin, env);
        const rows = (await env.DB.prepare(
          'SELECT sub_id, created_at, bytes, country, file_name, status FROM crowd_submission WHERE crowd_id=? ORDER BY created_at DESC LIMIT 50'
        ).bind(crowdId).all()).results || [];
        return j({ submissions: rows }, 200, origin, env);
      }

      // PUT /v1/crowd/<id> — patch label / folder / config / enabled / budgets.
      if (m === 'PUT' && seg.length === 3) {
        const body = await readJson(request) || {};
        const sets = []; const binds = [];
        if (typeof body.label === 'string' && body.label.trim()) { sets.push('label=?'); binds.push(body.label.trim().slice(0, 80)); }
        if (typeof body.config !== 'undefined') { sets.push('config_json=?'); binds.push(JSON.stringify(normCrowdConfig(body.config))); }
        if (typeof body.enabled !== 'undefined') { sets.push('enabled=?'); binds.push(body.enabled ? 1 : 0); }
        if (typeof body.max_per_day !== 'undefined') { sets.push('max_per_day=?'); binds.push(Math.min(Math.max(parseInt(body.max_per_day, 10) || 200, 1), 100000)); }
        if (typeof body.max_bytes_total !== 'undefined') { sets.push('max_bytes_total=?'); binds.push(Math.min(Math.max(parseInt(body.max_bytes_total, 10) || 1073741824, 1048576), 50 * 1073741824)); }
        if (!sets.length) return j({ error: 'bad_body' }, 400, origin, env);
        binds.push(crowdId, r.researcher_id);
        const res = await env.DB.prepare('UPDATE crowd_recorder SET ' + sets.join(', ') + ' WHERE crowd_id=? AND researcher_id=?').bind(...binds).run();
        return res.meta.changes ? j({ ok: true }, 200, origin, env) : j({ error: 'not_found' }, 404, origin, env);
      }

      // DELETE /v1/crowd/<id> — the public link dies immediately; Drive files stay.
      if (m === 'DELETE' && seg.length === 3) {
        const owned = await env.DB.prepare('SELECT crowd_id FROM crowd_recorder WHERE crowd_id=? AND researcher_id=?').bind(crowdId, r.researcher_id).first();
        if (!owned) return j({ error: 'not_found' }, 404, origin, env);
        await env.DB.batch([
          env.DB.prepare('DELETE FROM crowd_submission WHERE crowd_id=?').bind(crowdId),
          env.DB.prepare('DELETE FROM crowd_recorder  WHERE crowd_id=? AND researcher_id=?').bind(crowdId, r.researcher_id),
        ]);
        return j({ ok: true }, 200, origin, env);
      }
    }
  }

  // POST /v1/researcher/delete — (authed) SELF-DELETE: permanently remove THIS researcher and ALL their
  // data (instances, those instances' installs + invites, and any password-reset tokens). Auth is the
  // caller's OWN session token (authResearcher), so a user can only ever delete THEMSELVES — there is no
  // body/target, nothing to spoof. Field devices already holding a wrapped Ki keep their LOCAL data; they
  // un-orphan once their instance/install rows vanish: the device's next desired-lane poll returns 410
  // (the absent-row branch above), so the client auto-releases (clearSession + onRevoked → drops the sync
  // link + scrubs Drive config) and reverts to a standalone app, KEEPING all its local texts/audio.
  if (m === 'POST' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'delete') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    const rid = r.researcher_id;
    // One atomic batch (D1 serializes batch statements in array order → implicit transaction): all-or-
    // nothing, so there is never a half-deleted account. Child→parent: invite + install resolve their
    // subquery against the still-present instance rows, so DELETE FROM instance MUST come AFTER them.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM invite  WHERE instance_id IN (SELECT instance_id FROM instance WHERE researcher_id=?)').bind(rid),
      env.DB.prepare('DELETE FROM install WHERE instance_id IN (SELECT instance_id FROM instance WHERE researcher_id=?)').bind(rid),
      // Crowd rows too (child before parent — the subquery needs the recorder rows present).
      // Their PUBLIC links die with them; already-delivered Drive files are not touched.
      env.DB.prepare('DELETE FROM crowd_submission WHERE crowd_id IN (SELECT crowd_id FROM crowd_recorder WHERE researcher_id=?)').bind(rid),
      env.DB.prepare('DELETE FROM crowd_recorder   WHERE researcher_id=?').bind(rid),
      env.DB.prepare('DELETE FROM instance   WHERE researcher_id=?').bind(rid),
      env.DB.prepare('DELETE FROM reset      WHERE researcher_id=?').bind(rid),
      env.DB.prepare('DELETE FROM researcher WHERE researcher_id=?').bind(rid),
    ]);
    return j({ ok: true }, 200, origin, env);
  }

  return j({ error: 'not_found', path }, 404, origin, env);
}
