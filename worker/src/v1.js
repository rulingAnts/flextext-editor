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

// Researcher allowlist (A) + request/approve onboarding: env-listed emails are auto-approved
// OWNERS (they can approve others); anyone else signs in PENDING (inert) until an owner approves
// them. isApproved() gates the privileged endpoints — owners always pass (even if their row
// predates the `approved` column, since it checks the env list too).
function isOwner(email, env) {
  const a = String(env.ALLOWED_RESEARCHERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return a.length > 0 && a.includes(normEmail(email));
}
function isApproved(r, env) { return !!(r && (r.approved || isOwner(r.drive_email, env))); }

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
// Stable dummy salt for unknown emails → /salt never reveals whether an account exists.
async function dummySalt(email, env) { return (await hmacHex(env.SERVER_HMAC_KEY || '', 'salt:' + normEmail(email))).slice(0, 22); }

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

// Recover the data key Kr from its escrow copy (RSA-OAEP) using the Worker escrow private key.
// Returns Kr's raw bytes (b64url) for the reset client to re-wrap. Never logged/stored.
async function escrowRecover(env, escrowKrB64) {
  const priv = await crypto.subtle.importKey('pkcs8', b64urlToBytes(env.ESCROW_PRIVATE_KEY), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, priv, b64urlToBytes(escrowKrB64));
  return bytesToB64url(raw);
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

// Shared reset-path 2FA gate. Verifies the second factor (non-consuming — a backup code is only burned
// by the caller, atomically, at /confirm) and self-locks the token after repeated failed GUESSES, so
// /reset/verify and /reset/confirm share ONE 5-strike budget against the same token row (an attacker
// can't move guessing to whichever endpoint is "unlocked"). A no-code probe that merely discovers
// "TOTP required" is not a guess and does NOT burn an attempt. Returns {ok:true, sf} or {ok:false, error}.
async function gateResetToken(env, tokenHash, row, code) {
  const sf = await verifySecondFactor(row, env, code);
  if (sf.ok) return { ok: true, sf };
  if (code) {   // only real guesses count toward the lock; the discovery probe is free for honest users
    await env.DB.prepare('UPDATE reset SET attempts=attempts+1, used=CASE WHEN attempts+1>=5 THEN 1 ELSE used END WHERE token_hash=?').bind(tokenHash).run();
  }
  return { ok: false, error: code ? 'bad_totp' : 'totp_required' };
}

/* Password-reset email. Routed through the ONE Resend helper in seclog.js so a failed send is
 * LOGGED — it never was here: this function used to own a second copy of the fetch, returned a
 * boolean, and its caller discarded it, so a rejected reset produced no log line at all while the
 * endpoint still answered "if that account exists, we sent a link". */
async function sendResetEmail(env, request, toEmail, link) {
  return sendEmail(env, request, {
    to: toEmail,
    subject: 'Reset your FlexText researcher password',
    html: `<p>We received a request to reset your FlexText researcher password.</p>
<p><a href="${link}">Reset your password</a> — this link expires in 1 hour and can be used once.</p>
<p>If you did not request this, you can safely ignore this email.</p>`,
    event: 'reset_email',
    from: SIGNIN_FROM,   // researcher-facing, like the sign-in notice
  });
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
const SESSION_TTL_TRANSIENT = 24 * 60 * 60 * 1000;  // OFF: the user has told us this is not their machine

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
async function authInstall(req, env, instanceId, installId) {
  const secret = req.headers.get('x-fx-secret') || '';
  if (!secret) return null;
  const row = await env.DB.prepare(
    'SELECT * FROM install WHERE install_id=? AND instance_id=? AND revoked=0'
  ).bind(installId, instanceId).first();
  if (!row || !ctEq(await sha256hex(secret), row.secret_hash)) return null;
  return row;
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
  const unassignedFolder = (files || []).find((f) => isFolder(f) && roleOf(f) === 'unassigned');
  const unassignedId = (unassignedFolder && unassignedFolder.id) || '';
  const devices = (files || []).filter((f) => isFolder(f) && parentOf(f) === masterId
      && !(f.appProperties || {}).flextextDoc && !roleOf(f))
    .map((f) => ({ folderId: f.id, name: f.name || '' }));
  const deviceName = new Map(devices.map((d) => [d.folderId, d.name]));

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
      // Where the folder ACTUALLY sits, so the panel can show the Drive truth and can tell which
      // texts still need sweeping from the ones already filed.
      inUnassigned: !!unassignedId && dev === unassignedId,
      bytes: a.bytes,
      files: a.files,
      done: (f.appProperties || {}).flextextDone === '1',
      modified: f.modifiedTime || '',
    };
  }).sort((x, y) => y.bytes - x.bytes);             // biggest first: what a storage view is for

  return { master: masterId, devices, texts, unassignedFolderId: unassignedId };
}

/* "FlexText Uploads / Unassigned" — where a text's folder LIVES once no device holds it.
 *
 * The panel could already COMPUTE unassigned-ness, but the Drive tree still showed the text under
 * whichever device used to have it, which is simply false to anyone browsing Drive. Same philosophy
 * as originals/ and the "(done)" suffix: the folder tree should describe the truth without our
 * tools. Tagged like every other structural folder so it is found by role, not by name. */
async function driveUnassignedFolder(access) {
  const q = encodeURIComponent("appProperties has { key='flextextRole' and value='unassigned' } and mimeType='application/vnd.google-apps.folder' and trashed=false");
  try {
    const found = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files?spaces=drive&fields=files(id)&q=' + q);
    if (found.files && found.files.length) return found.files[0].id;
  } catch { /* fall through to create */ }
  const f = await driveJson(access, 'POST', 'https://www.googleapis.com/drive/v3/files?fields=id',
    { name: 'Unassigned', mimeType: 'application/vnd.google-apps.folder',
      parents: [await driveMasterFolder(access)], appProperties: { flextextRole: 'unassigned' } });
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

// An enrolled DEVICE's folder in the researcher's Drive: "FlexText Uploads / <nickname>".
// Same semantics as the crowd folders: id-tracked (move/rename-proof), recreated if
// trashed. The panel's device-rename route renames the folder best-effort to match.
async function driveEnsureDeviceFolder(env, access, instanceId, nickname, existingId) {
  if (existingId) {
    try {
      const f = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(existingId) + '?fields=id,trashed');
      if (f && f.id && !f.trashed) return existingId;
    } catch { /* fall through: recreate */ }
  }
  const name = String(nickname || '').trim() || ('Device — ' + String(instanceId).slice(0, 8));
  const f = await driveJson(access, 'POST', 'https://www.googleapis.com/drive/v3/files?fields=id',
    { name, mimeType: 'application/vnd.google-apps.folder', parents: [await driveMasterFolder(access)] });
  await env.DB.prepare('UPDATE instance SET oauth_folder_id=? WHERE instance_id=?').bind(f.id, instanceId).run();
  return f.id;
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
async function mintTextfileUrl(env, urlOrigin, researcherId, fileId, extract, ttlMs) {
  if (!fileId) return null;
  return urlOrigin + '/v1/textfile/' + encodeURIComponent(await encAtRest(env, JSON.stringify(
    { r: researcherId, f: fileId, x: extract || '', e: Date.now() + (ttlMs || 90 * 86400000) })));
}

// The recorder's folder in the RESEARCHER'S Drive: "FlexText Uploads / Crowd — <label>".
// drive.file can only write to app-created files, so the worker creates (and
// remembers) the folder itself; a trashed/vanished folder is transparently
// recreated. The researcher may move/rename it — the id is what's tracked.
async function driveEnsureCrowdFolder(env, access, rec) {
  if (rec.oauth_folder_id) {
    try {
      const f = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(rec.oauth_folder_id) + '?fields=id,trashed');
      if (f && f.id && !f.trashed) return rec.oauth_folder_id;
    } catch { /* fall through: recreate */ }
  }
  const name = 'Crowd — ' + (rec.label || String(rec.crowd_id).slice(0, 8));
  const f = await driveJson(access, 'POST', 'https://www.googleapis.com/drive/v3/files?fields=id',
    { name, mimeType: 'application/vnd.google-apps.folder', parents: [await driveMasterFolder(access)] });
  await env.DB.prepare('UPDATE crowd_recorder SET oauth_folder_id=? WHERE crowd_id=?').bind(f.id, rec.crowd_id).run();
  return f.id;
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
  let project = await env.DB.prepare('SELECT project_id FROM project WHERE owner_id=? ORDER BY created_at LIMIT 1')
    .bind(row.researcher_id).first();
  let created = false;
  if (!project) {
    const project_id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO project (project_id, owner_id, name, created_at) VALUES (?,?,?,?)')
      .bind(project_id, row.researcher_id, defaultProjectName(row), now).run();
    project = { project_id };
    created = true;
  }
  /* Only rows that have NO project yet are adopted: re-running must never move an instance that has
   * since been placed somewhere deliberately. */
  const inst = await env.DB.prepare('UPDATE instance SET project_id=? WHERE researcher_id=? AND project_id IS NULL')
    .bind(project.project_id, row.researcher_id).run();
  const crowd = await env.DB.prepare('UPDATE crowd_recorder SET project_id=? WHERE researcher_id=? AND project_id IS NULL')
    .bind(project.project_id, row.researcher_id).run();
  return {
    project_id: project.project_id,
    created,
    instances: (inst.meta && inst.meta.changes) || 0,
    crowd: (crowd.meta && crowd.meta.changes) || 0,
  };
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
    } catch (e) { return j({ error: e.code || 'drive_error', message: e.message }, 502, origin, env); }
  }

  // POST /v1/researcher — signup with EMAIL + PASSWORD-derived material (the password never reaches
  // the server). Turnstile-gated, fail-closed. Unique email. Stores the escrow copy of Kr (for email
  // recovery) + the email encrypted at rest. Body: { email, salt, authSecret, wrappedKr, escrowKr,
  // turnstileToken } — salt/authSecret/wrappedKr/escrowKr were all derived/built on the client.
  if (m === 'POST' && seg.length === 2 && seg[1] === 'researcher') {
    if (!env.TURNSTILE_SECRET) return j({ error: 'signup_unavailable' }, 503, origin, env);
    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    if (env.SIGNUP_LIMIT) {
      const { success } = await env.SIGNUP_LIMIT.limit({ key: `signup:${ip}` });
      if (!success) return j({ error: 'rate_limited' }, 429, origin, env);
    }
    const body = await readJson(request) || {};
    if (!await verifyTurnstile(body.turnstileToken, ip, env)) return j({ error: 'turnstile_failed' }, 403, origin, env);
    const email = normEmail(body.email);
    if (!email || !email.includes('@')) return j({ error: 'bad_email' }, 400, origin, env);
    if (!body.salt || !body.authSecret || !body.wrappedKr || !body.escrowKr) return j({ error: 'bad_body' }, 400, origin, env);
    const ekey = await emailKey(email, env);
    if (await env.DB.prepare('SELECT researcher_id FROM researcher WHERE email_sha256=?').bind(ekey).first()) {
      return j({ error: 'email_taken' }, 409, origin, env);
    }
    const researcher_id = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO researcher (researcher_id, secret_hash, email_sha256, settings_blob, settings_rev, created_at, salt, wrapped_kr, escrow_kr, email_enc, totp_enabled) VALUES (?,?,?,?,0,?,?,?,?,?,0)'
    ).bind(researcher_id, await sha256hex(body.authSecret), ekey, JSON.stringify({}), now,
           String(body.salt), String(body.wrappedKr), String(body.escrowKr), await encAtRest(env, email)).run();
    secAlert(env, ctx, request, 'New researcher account (password signup)', [
      'A new researcher account was created with email + password.',
      'Email: ' + email,
      'This account is PENDING and can do nothing until you approve it in the researcher panel.',
    ]);
    return j({ researcher_id }, 200, origin, env);
  }

  // POST /v1/researcher/salt — pre-auth: returns ONLY the salt (the client needs it to derive
  // authSecret). NEVER returns wrapped_kr here (that would allow offline password cracking). Unknown
  // emails get a stable dummy salt → no account-existence enumeration.
  if (m === 'POST' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'salt') {
    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    if (env.SIGNUP_LIMIT) { const { success } = await env.SIGNUP_LIMIT.limit({ key: `salt:${ip}` }); if (!success) return j({ error: 'rate_limited' }, 429, origin, env); }
    const body = await readJson(request) || {};
    const email = normEmail(body.email);
    if (!email) return j({ error: 'bad_email' }, 400, origin, env);
    const row = await env.DB.prepare('SELECT salt FROM researcher WHERE email_sha256=?').bind(await emailKey(email, env)).first();
    return j({ salt: (row && row.salt) || await dummySalt(email, env) }, 200, origin, env);
  }

  // POST /v1/researcher/login — verify authSecret (+ TOTP if enabled) → researcher_id + wrapped_kr.
  // The client uses researcher_id + authSecret as the per-call API credential thereafter.
  if (m === 'POST' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'login') {
    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    if (env.SIGNUP_LIMIT) { const { success } = await env.SIGNUP_LIMIT.limit({ key: `login:${ip}` }); if (!success) return j({ error: 'rate_limited' }, 429, origin, env); }
    const body = await readJson(request) || {};
    const email = normEmail(body.email);
    if (!email || !body.authSecret) return j({ error: 'bad_body' }, 400, origin, env);
    const row = await env.DB.prepare('SELECT * FROM researcher WHERE email_sha256=?').bind(await emailKey(email, env)).first();
    if (!row || !ctEq(await sha256hex(body.authSecret), row.secret_hash)) return j({ error: 'bad_login' }, 401, origin, env);
    if (row.totp_enabled) {
      if (env.SIGNUP_LIMIT) { const { success } = await env.SIGNUP_LIMIT.limit({ key: `2fa:${row.researcher_id}` }); if (!success) return j({ error: 'rate_limited' }, 429, origin, env); }
      const sf = await verifySecondFactor(row, env, body.totpCode);
      if (!sf.ok) return j({ error: body.totpCode ? 'bad_totp' : 'totp_required' }, 401, origin, env);
      if (sf.backupCodes) await env.DB.prepare('UPDATE researcher SET backup_codes=? WHERE researcher_id=?').bind(JSON.stringify(sf.backupCodes), row.researcher_id).run();
    }
    return j({ researcher_id: row.researcher_id, wrapped_kr: row.wrapped_kr, totp_enabled: !!row.totp_enabled }, 200, origin, env);
  }

  // GET /v1/escrow-pubkey — the Worker escrow public key (clients wrap Kr to it at signup).
  if (m === 'GET' && seg.length === 2 && seg[1] === 'escrow-pubkey') {
    return j({ pubkey: env.ESCROW_PUBLIC_KEY || null }, 200, origin, env);
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
    } catch (e) { return j({ error: 'token_exchange_error', message: e.message }, 502, origin, env); }
    let claims; try { claims = JSON.parse(atob(tok.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return j({ error: 'bad_id_token' }, 502, origin, env); }
    const sub = claims.sub; const email = normEmail(claims.email || '');
    if (!sub) return j({ error: 'no_sub' }, 502, origin, env);
    // A (allowlist) + request/approve: env-listed emails are auto-approved OWNERS; anyone else may
    // sign in but their account is created PENDING (inert) until an owner approves it in the panel.
    // No hard reject here — the isApproved() gate on the privileged endpoints is what protects them.
    const owner = isOwner(email, env);
    // Pre-approved DOMAIN (D1 `approved_domain`): approved on sight, but as an ordinary researcher.
    // Owner rights come only from the env list, so no database row can ever grant them.
    const domainOk = owner ? false : await isDomainApproved(email, env);
    const name = claims.name || ''; const picture = claims.picture || '';
    let row = await env.DB.prepare('SELECT researcher_id FROM researcher WHERE google_sub=?').bind(sub).first();
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
             email, await encAtRest(env, email), name, picture, (owner || domainOk) ? 1 : 0).run();
      row = { researcher_id, __created: true };
      // Every account creation is logged, whether it was auto-approved or left pending, so the log
      // answers "when did this person first appear" and not merely "when was someone approved".
      await logApproval(env, request, owner || domainOk ? 'account_auto_approved' : 'account_signup',
                        email || sub,
                        owner ? 'owner allowlist (ALLOWED_RESEARCHERS)'
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
        owner
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
      if (tok.refresh_token) { sets.push('drive_refresh_enc=?'); binds.push(await encAtRest(env, tok.refresh_token)); }
      if (email) { sets.push('drive_email=?'); binds.push(email); }
      sets.push('display_name=?'); binds.push(name);
      sets.push('avatar_url=?'); binds.push(picture);
      if (owner) { sets.push('approved=?'); binds.push(1); }   // env-listed owners are always approved
      binds.push(row.researcher_id);
      await env.DB.prepare('UPDATE researcher SET ' + sets.join(', ') + ' WHERE researcher_id=?').bind(...binds).run();
    }
    const back = String(st.r || 'https://rulingants.github.io/flextext-editor/').replace(/[?#].*$/, '');
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

    /* Tell the owner their account was just signed into. NOT on the account's first ever sign-in:
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
    if (!isOwner(r.drive_email, env)) return j({ error: 'not_owner' }, 403, origin, env);
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
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    const body = await readJson(request) || {};
    const instanceId = String(body.instance_id || '');
    const grants = Array.isArray(body.grants) ? body.grants : null;
    if (!instanceId || !grants || !grants.length) return j({ error: 'bad_body' }, 400, origin, env);

    const inst = await env.DB.prepare('SELECT instance_id, project_id, researcher_id FROM instance WHERE instance_id=?')
      .bind(instanceId).first();
    if (!inst) return j({ error: 'not_found' }, 404, origin, env);
    /* Dual-read window: project_id may still be NULL on an instance the backfill has not reached,
     * in which case the owner is researcher_id — which the backfill will make equal anyway. */
    const proj = inst.project_id
      ? await env.DB.prepare('SELECT project_id, owner_id FROM project WHERE project_id=?').bind(inst.project_id).first()
      : { project_id: null, owner_id: inst.researcher_id };
    if (!proj) return j({ error: 'not_found' }, 404, origin, env);
    if (r.researcher_id !== proj.owner_id) return j({ error: 'forbidden' }, 403, origin, env);

    if (!grants.some((g) => g && g.researcher_id === proj.owner_id && g.wrapped_ki)) {
      return j({ error: 'owner_grant_required' }, 400, origin, env);
    }
    const version = Math.max(1, parseInt(body.key_version || 1, 10) || 1);
    const writes = grants
      .filter((g) => g && g.researcher_id && g.wrapped_ki)
      .map((g) => env.DB.prepare(
        'INSERT OR REPLACE INTO member_key (project_id, instance_id, researcher_id, key_version, wrapped_ki, wrapped_by, created_at) '
        + 'VALUES (?,?,?,?,?,?,?)'
      ).bind(proj.project_id, instanceId, String(g.researcher_id), version, String(g.wrapped_ki), r.researcher_id, now));
    await env.DB.batch(writes);
    return j({ ok: true, stored: writes.length, key_version: version }, 200, origin, env);
  }

  /* GET /v1/researcher/keys?instance=<id> — the grants THIS researcher holds, for getKi()'s
   * resolution order (memory → member_key → the legacy settings_blob map). */
  if (m === 'GET' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'keys') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    const want = url.searchParams.get('instance') || '';
    const q = want
      ? env.DB.prepare('SELECT instance_id, key_version, wrapped_ki FROM member_key WHERE researcher_id=? AND instance_id=? ORDER BY key_version DESC')
          .bind(r.researcher_id, want)
      : env.DB.prepare('SELECT instance_id, key_version, wrapped_ki FROM member_key WHERE researcher_id=? ORDER BY instance_id, key_version DESC')
          .bind(r.researcher_id);
    const rows = await q.all();
    return j({ keys: (rows && rows.results) || [] }, 200, origin, env);
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

  // POST /v1/researcher/reset/request — always 200 ("if it exists, we sent a link"). Emails a
  // one-time token via Resend if the account exists. Rate-limited (anti email-bomb / enumeration).
  if (m === 'POST' && seg.length === 4 && seg[1] === 'researcher' && seg[2] === 'reset' && seg[3] === 'request') {
    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    if (env.SIGNUP_LIMIT) { const { success } = await env.SIGNUP_LIMIT.limit({ key: `reset:${ip}` }); if (!success) return j({ error: 'rate_limited' }, 429, origin, env); }
    const body = await readJson(request) || {};
    const email = normEmail(body.email);
    let devToken = null;
    if (email) {
      const row = await env.DB.prepare('SELECT researcher_id, email_enc, escrow_kr FROM researcher WHERE email_sha256=?').bind(await emailKey(email, env)).first();
      if (row && row.escrow_kr) {
        const token = randTok(24);
        await env.DB.prepare('INSERT INTO reset (token_hash, researcher_id, expires_at, used, created_at) VALUES (?,?,?,0,?)')
          .bind(await sha256hex(token), row.researcher_id, now + 3600 * 1000, now).run();
        const base = String(body.appBase || 'https://rulingants.github.io/flextext-editor/').replace(/[?#].*$/, '');
        const to = await decAtRest(env, row.email_enc) || email;
        await sendResetEmail(env, request, to, `${base}?reset=${encodeURIComponent(token)}`);
        // dev-only test hook; gated to localhost origins so even a leaked flag can't echo a token to a real client
        if (env.DEV_ECHO_RESET && /^https?:\/\/localhost(:\d+)?$/.test(origin || '')) devToken = token;
      }
    }
    return j(devToken ? { ok: true, devToken } : { ok: true }, 200, origin, env);
  }

  // POST /v1/researcher/reset/verify — token (+ TOTP if enabled) → recover Kr from escrow. Does NOT
  // consume the token OR the 2FA factor (both happen at /confirm). Returns Kr (raw, b64) so the client
  // can re-wrap it. Hardened against reset-token replay / TOTP-oracle abuse: per-IP + per-account rate
  // limits, and the token self-locks after a few failed 2FA attempts (so an attacker who intercepts the
  // emailed token still can't brute the second factor regardless of IP rotation).
  if (m === 'POST' && seg.length === 4 && seg[1] === 'researcher' && seg[2] === 'reset' && seg[3] === 'verify') {
    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    if (env.SIGNUP_LIMIT) { const { success } = await env.SIGNUP_LIMIT.limit({ key: `resetverify:${ip}` }); if (!success) return j({ error: 'rate_limited' }, 429, origin, env); }
    const body = await readJson(request) || {};
    if (!body.token) return j({ error: 'bad_body' }, 400, origin, env);
    const th = await sha256hex(body.token);
    const rt = await env.DB.prepare('SELECT * FROM reset WHERE token_hash=?').bind(th).first();
    if (!rt || rt.used || rt.expires_at <= now) return j({ error: 'bad_token' }, 401, origin, env);
    const row = await env.DB.prepare('SELECT * FROM researcher WHERE researcher_id=?').bind(rt.researcher_id).first();
    if (!row || !row.escrow_kr) return j({ error: 'bad_token' }, 401, origin, env);
    if (row.totp_enabled) {
      if (env.SIGNUP_LIMIT) { const { success } = await env.SIGNUP_LIMIT.limit({ key: `2fa:${row.researcher_id}` }); if (!success) return j({ error: 'rate_limited' }, 429, origin, env); }
      const g = await gateResetToken(env, th, row, body.totpCode);    // shared 5-strike lock with /confirm
      if (!g.ok) return j({ error: g.error }, 401, origin, env);
    }
    let kr;
    try { kr = await escrowRecover(env, row.escrow_kr); } catch { return j({ error: 'escrow_failed' }, 500, origin, env); }
    // The data key just left the escrow. If this was not the account holder, someone has both the
    // emailed reset token and (if enabled) the second factor — the single most serious event this
    // worker can observe, so it alerts even though the request itself succeeded.
    secAlert(env, ctx, request, 'Escrow key recovery completed', [
      'A password reset successfully recovered a researcher data key from escrow.',
      'Researcher id: ' + rt.researcher_id,
      'If this was not you or a researcher you were expecting to help, treat it as a compromise: '
        + 'the reset token was emailed to that account address.',
    ]);
    return j({ kr }, 200, origin, env);
  }

  // POST /v1/researcher/reset/confirm — set new password material; consume the token. Kr is unchanged
  // (the client re-wrapped the recovered Kr under the new password), so all existing data survives.
  // TOTP-gated too (mirrors /login + /verify): an intercepted reset token alone cannot take over a 2FA
  // account — /confirm rotates the API credential, so it MUST re-prove the second factor, not just hold
  // the token. A used backup code is burned atomically (same batch) with the token + password rotation.
  if (m === 'POST' && seg.length === 4 && seg[1] === 'researcher' && seg[2] === 'reset' && seg[3] === 'confirm') {
    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    if (env.SIGNUP_LIMIT) { const { success } = await env.SIGNUP_LIMIT.limit({ key: `resetconfirm:${ip}` }); if (!success) return j({ error: 'rate_limited' }, 429, origin, env); }
    const body = await readJson(request) || {};
    if (!body.token || !body.salt || !body.authSecret || !body.wrappedKr) return j({ error: 'bad_body' }, 400, origin, env);
    const th = await sha256hex(body.token);
    const rt = await env.DB.prepare('SELECT * FROM reset WHERE token_hash=?').bind(th).first();
    if (!rt || rt.used || rt.expires_at <= now) return j({ error: 'bad_token' }, 401, origin, env);
    const row = await env.DB.prepare('SELECT * FROM researcher WHERE researcher_id=?').bind(rt.researcher_id).first();
    if (!row) return j({ error: 'bad_token' }, 401, origin, env);
    let g = null;
    if (row.totp_enabled) {
      if (env.SIGNUP_LIMIT) { const { success } = await env.SIGNUP_LIMIT.limit({ key: `2fa:${row.researcher_id}` }); if (!success) return j({ error: 'rate_limited' }, 429, origin, env); }
      g = await gateResetToken(env, th, row, body.totpCode);          // same shared 5-strike lock as /verify — can't brute here either
      if (!g.ok) return j({ error: g.error }, 401, origin, env);
    }
    // Consume the token FIRST (atomic guard): only the winner of a concurrent double-confirm rotates the
    // credential, so a losing concurrent request can't clobber the new password (TOCTOU on the rotate).
    const consumed = await env.DB.prepare('UPDATE reset SET used=1 WHERE token_hash=? AND used=0').bind(th).run();
    if (!consumed.meta.changes) return j({ error: 'bad_token' }, 401, origin, env);
    const writes = [
      env.DB.prepare('UPDATE researcher SET salt=?, secret_hash=?, wrapped_kr=? WHERE researcher_id=?')
        .bind(String(body.salt), await sha256hex(body.authSecret), String(body.wrappedKr), rt.researcher_id),
    ];
    if (g && g.sf.backupCodes) writes.push(env.DB.prepare('UPDATE researcher SET backup_codes=? WHERE researcher_id=?').bind(JSON.stringify(g.sf.backupCodes), row.researcher_id));
    await env.DB.batch(writes);
    return j({ ok: true }, 200, origin, env);
  }

  // POST /v1/researcher/password — (authed) change password while signed in. New salt + authSecret
  // hash + wrappedKr; escrow_kr stays (Kr unchanged → all data + escrow recovery survive).
  if (m === 'POST' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'password') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    const body = await readJson(request);
    if (!body || !body.salt || !body.authSecret || !body.wrappedKr) return j({ error: 'bad_body' }, 400, origin, env);
    await env.DB.prepare('UPDATE researcher SET salt=?, secret_hash=?, wrapped_kr=? WHERE researcher_id=?')
      .bind(String(body.salt), await sha256hex(body.authSecret), String(body.wrappedKr), r.researcher_id).run();
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
    const approved = isApproved(r, env);
    const owner = isOwner(r.drive_email, env);
    let insts = [];
    let pending;
    if (approved) {
      insts = (await env.DB.prepare(
        'SELECT instance_id, type, nickname, desired_rev, revoked, estate FROM instance WHERE researcher_id=? AND revoked=0'
      ).bind(r.researcher_id).all()).results || [];
      for (const it of insts) {
        it.installs = (await env.DB.prepare(
          // Show live installs + ones with a wipe in flight (pending/confirmed) so the panel can render
          // the wipe state; hide ordinary-revoked (unlinked) and force-removed (wipe_hidden) rows.
          'SELECT install_id, status, accepted, reported_blob, reported_rev, ack_seq, last_seen_at, pubkey, wipe_state, wipe_at, (wrapped_key IS NOT NULL) AS has_key FROM install WHERE instance_id=? AND wipe_hidden=0 AND (revoked=0 OR wipe_state IS NOT NULL)'
        ).bind(it.instance_id).all()).results || [];
      }
      // Owners see pending researcher requests to approve/decline (fellow owners excluded).
      if (owner) {
        const rows = (await env.DB.prepare(
          'SELECT researcher_id, drive_email AS email, display_name, avatar_url, created_at FROM researcher WHERE approved=0 ORDER BY created_at'
        ).all()).results || [];
        pending = rows.filter((p) => !isOwner(p.email, env));
      }
    }
    return j({ approved, is_owner: owner, pending,
               settings: r.settings_blob, settings_rev: r.settings_rev, instances: insts,
               kr: r.kr_server_enc ? await decAtRest(env, r.kr_server_enc) : undefined,
               email: r.drive_email || undefined }, 200, origin, env);
  }

  // POST /v1/researcher/approve {researcher_id} — an OWNER approves a pending researcher.
  if (m === 'POST' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'approve') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    if (!isOwner(r.drive_email, env)) return j({ error: 'not_owner' }, 403, origin, env);
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
    if (!isOwner(r.drive_email, env)) return j({ error: 'not_owner' }, 403, origin, env);
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
    if (!isOwner(r.drive_email, env)) return j({ error: 'not_owner' }, 403, origin, env);
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
        master: estate.master,
        devices: estate.devices,
        texts: estate.texts,
        // OUR trashed files only — what the reclaim action would actually remove.
        trashed: { n: dead.length, bytes: dead.reduce((a, f) => a + (parseInt(f.size, 10) || 0), 0) },
      }, 200, origin, env);
    } catch (e) { return j({ error: e.code || 'drive_error', message: e.message }, 502, origin, env); }
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
      const target = await driveUnassignedFolder(access);
      let moved = 0;
      for (const id of ids) {
        try {
          const q = encodeURIComponent(`appProperties has { key='flextextDoc' and value='${id}' } and mimeType='application/vnd.google-apps.folder' and trashed=false`);
          const found = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files?spaces=drive&orderBy=createdTime&fields=files(id,parents)&q=' + q);
          const f = (found.files || [])[0];
          if (!f) continue;                                  // no folder (legacy text) — nothing to move
          if ((f.parents || []).includes(target)) continue;   // already there — idempotent
          await driveReparent(access, f.id, target, f.parents);
          // Tagged so the RETURN trip can tell "we swept this" from "the researcher filed it here".
          await driveJson(access, 'PATCH', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(f.id) + '?fields=id',
            { appProperties: { flextextUnassigned: '1' } });
          moved++;
        } catch { /* one text failing must not abort the sweep */ }
      }
      return j({ moved, folderId: target }, 200, origin, env);
    } catch (e) { return j({ error: e.code || 'drive_error', message: e.message }, 502, origin, env); }
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
    } catch (e) { return j({ error: e.code || 'drive_error', message: e.message }, 502, origin, env); }
  }

  if (m === 'POST' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'trash') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    const body = await readJson(request) || {};
    const ids = (Array.isArray(body.fileIds) ? body.fileIds : []).map((x) => String(x || '').replace(/[^\w-]/g, '').slice(0, 90)).filter(Boolean);
    if (!ids.length || ids.length > 100) return j({ error: 'bad_fileids' }, 400, origin, env);
    try {
      const access = await driveAccessToken(env, r);
      const results = [];
      for (const id of ids) {
        try {
          await driveJson(access, 'PATCH', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?fields=id', { trashed: true });
          results.push({ id, ok: true });
        } catch (e) { results.push({ id, ok: false, error: String(e.message || e).slice(0, 80) }); }
      }
      await logApproval(env, request, 'files_trashed', ids.length + ' file(s)', (body.note || '').slice(0, 120), r.drive_email);
      return j({ results, trashed: results.filter((x) => x.ok).length }, 200, origin, env);
    } catch (e) { return j({ error: e.code || 'drive_error', message: e.message }, 502, origin, env); }
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
    } catch (e) { return j({ error: e.code || 'drive_error', message: e.message }, 502, origin, env); }
  }

  /* GET /v1/researcher/approvals — OWNER only. The append-only access-control history: every
   * account that appeared, was approved, auto-approved or declined, and every domain added or
   * removed. Read-only by design; nothing in the app writes here except logApproval(), and nothing
   * anywhere updates or deletes a row. An audit log you can edit is not an audit log. */
  if (m === 'GET' && seg.length === 3 && seg[1] === 'researcher' && seg[2] === 'approvals') {
    const r = await authResearcher(request, env);
    if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
    if (!isOwner(r.drive_email, env)) return j({ error: 'not_owner' }, 403, origin, env);
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
    return j({ instance_id, type, nickname, estate: 'cloud' }, 200, origin, env);
  }

  // Routes under /v1/instances/<id>/...
  if (seg.length >= 3 && seg[1] === 'instances') {
    const instanceId = seg[2];
    const sub = seg[3];

    // POST .../rename — edit the nickname anytime.
    if (m === 'POST' && sub === 'rename' && seg.length === 4) {
      const r = await authResearcher(request, env);
      if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
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
      return j({ ok: true }, 200, origin, env);
    }

    // POST .../invite — mint a one-time invite (returns the secret ONCE).
    if (m === 'POST' && sub === 'invite' && seg.length === 4) {
      const r = await authResearcher(request, env);
      if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
      const owned = await env.DB.prepare('SELECT instance_id FROM instance WHERE instance_id=? AND researcher_id=? AND revoked=0')
        .bind(instanceId, r.researcher_id).first();
      if (!owned) return j({ error: 'not_found' }, 404, origin, env);
      const body = await readJson(request) || {};
      const ttl = Math.min(Math.max(parseInt(body.ttlSeconds || 604800, 10) || 604800, 300), 2592000); // 5min..30d
      const invite_id = crypto.randomUUID();
      const secret = randTok(18);
      const expires_at = now + ttl * 1000;
      await env.DB.prepare('INSERT INTO invite (invite_id, instance_id, secret_hash, expires_at, created_at) VALUES (?,?,?,?,?)')
        .bind(invite_id, instanceId, await sha256hex(secret), expires_at, now).run();
      /* ⚠ RETURN THE ESTATE WITH THE INVITE. The panel used to look the instance up in its cached
       * dashboard, which a BRAND-NEW device is not in yet — so the lookup missed and the link fell
       * back to 'pages', sending new coworkers to the legacy apps (Seth, 2026-08-05). Server truth
       * at mint time cannot miss. */
      const ie = await env.DB.prepare('SELECT estate FROM instance WHERE instance_id=?').bind(instanceId).first();
      return j({ invite_id, secret, expires_at, estate: (ie && ie.estate) || 'pages' }, 200, origin, env);
    }

    // POST .../command — append a command to `desired` (CAS, §E.2). Enforce id+type (§F.5).
    if (m === 'POST' && sub === 'command' && seg.length === 4) {
      const r = await authResearcher(request, env);
      if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
      const body = await readJson(request);
      const cmd = body && body.command;
      if (!cmd || typeof cmd.type !== 'string') return j({ error: 'bad_command' }, 400, origin, env);
      if (cmd.type === 'assign' && !cmd.id) return j({ error: 'assign_needs_id' }, 400, origin, env);     // §F.5
      // uploadDelete = upload-then-delete (per-text remote removal; engine ≥ v94 — older
      // clients warn-and-ack it harmlessly, so the panel gates the button on engineVersion).
      if (!['assign', 'delete', 'changeSettings', 'triggerUpload', 'uploadDelete', 'setDone'].includes(cmd.type)) return j({ error: 'unknown_command' }, 400, origin, env);
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
        const seq = (blob.commands.length ? blob.commands[blob.commands.length - 1].seq : 0) + 1;
        blob.commands.push({ ...cmd, seq, at: now });
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
      const r = await authResearcher(request, env);
      if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
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
        if (seq <= maxAck) return j({ error: 'already_delivered', ack_seq: maxAck }, 409, origin, env);
        const blob = inst.desired_blob ? JSON.parse(inst.desired_blob) : { settings: {}, commands: [] };
        const before = (blob.commands || []).length;
        blob.commands = (blob.commands || []).filter((c) => c.seq !== seq);
        if (blob.commands.length === before) return j({ error: 'not_queued', ack_seq: maxAck }, 404, origin, env);
        const newRev = inst.desired_rev + 1;
        const res = await env.DB.prepare('UPDATE instance SET desired_blob=?, desired_rev=? WHERE instance_id=? AND desired_rev=?')
          .bind(JSON.stringify(blob), newRev, instanceId, inst.desired_rev).run();
        if (res.meta.changes === 1) return j({ ok: true, cancelled: seq, desired_rev: newRev }, 200, origin, env);
      }
      return j({ error: 'conflict_retry' }, 409, origin, env);
    }

    /* GET .../texts/<docId>/files — RESEARCHER: list the text's Drive folder, newest first.
     * This is what feeds the Files dropdown and the download-all ZIP: the folder IS the source of
     * truth for "what artifacts exist", so the panel never has to reconstruct it from reports.
     * Returns [] (not an error) when the folder does not exist yet — a text with no uploads is a
     * normal state, not a failure. */
    if (m === 'GET' && sub === 'texts' && seg.length === 6 && seg[5] === 'files') {
      const r = await authResearcher(request, env);
      if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
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
      } catch (e) { return j({ error: e.code || 'drive_error', message: e.message }, 502, origin, env); }
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
      const r = await authResearcher(request, env);
      if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
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
        return j({ ok: true, folderId: folder, originalsFolderId }, 200, origin, env);
      } catch (e) { return j({ error: e.code || 'drive_error', message: e.message }, 502, origin, env); }
    }

    // POST .../texts/<docId>/assignment/upload/start {name, mime, size, originalsFolderId, kind}
    // → a Drive resumable session as an opaque uploadId (encrypted at rest, bound to THIS
    // researcher via `rr`). kind names the role tag; 'consent-prompt' targets the DEVICE folder
    // (a prompt is per-device, not per-text — the docId segment is ignored for it).
    if (m === 'POST' && sub === 'texts' && seg.length === 8 && seg[5] === 'assignment' && seg[6] === 'upload' && seg[7] === 'start') {
      const r = await authResearcher(request, env);
      if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
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
        await noteDriveError(env, r.researcher_id, 'assignment upload start failed: ' + e.message);
        return j({ error: e.code || 'drive_error' }, 502, origin, env);
      }
    }

    // PUT .../texts/<docId>/assignment/upload/chunk — same wire contract as the device chunk
    // relay; ownership key is `rr` (researcher), never `i` (install).
    if (m === 'PUT' && sub === 'texts' && seg.length === 8 && seg[5] === 'assignment' && seg[6] === 'upload' && seg[7] === 'chunk') {
      const r = await authResearcher(request, env);
      if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
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
      const r = await authResearcher(request, env);
      if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
      const inst = await env.DB.prepare('SELECT instance_id, nickname FROM instance WHERE instance_id=? AND researcher_id=? AND revoked=0')
        .bind(instanceId, r.researcher_id).first();
      if (!inst) return j({ error: 'not_found' }, 404, origin, env);
      const docId = String(seg[4] || '').replace(/[^\w-]/g, '').slice(0, 64);
      const body = await readJson(request) || {};
      if (!body.audioFileId && !body.flextextFileId && !body.promptFileId) return j({ error: 'nothing_to_mint' }, 400, origin, env);
      const ttlDays = clampTtlDays(body.ttlDays);
      const ttlMs = ttlDays * 86400000;
      try {
        const audioUrl = await mintTextfileUrl(env, url.origin, r.researcher_id, body.audioFileId, '', ttlMs);
        const flextextUrl = await mintTextfileUrl(env, url.origin, r.researcher_id, body.flextextFileId, '', ttlMs);
        const promptUrl = await mintTextfileUrl(env, url.origin, r.researcher_id, body.promptFileId, '', ttlMs);
        if (docId && (audioUrl || flextextUrl)) {
          await logApproval(env, request, 'assigned_upload', docId.slice(0, 12) + '…', '→ ' + (inst.nickname || '?'), r.drive_email);
        }
        return j({ ok: true, ttlDays, audioUrl, flextextUrl, promptUrl }, 200, origin, env);
      } catch (e) { return j({ error: e.code || 'drive_error', message: e.message }, 502, origin, env); }
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
      const r = await authResearcher(request, env);
      if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
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
        const mint = (fileId, extract) => mintTextfileUrl(env, url.origin, r.researcher_id, fileId, extract);
        const flextextUrl = await mint(body.flextextFileId) || await mint(body.extractFromZipId, 'flextext');
        const audioUrl = await mint(body.audioFileId);
        await logApproval(env, request, 'text_adopted', docId, to.nickname || '', r.drive_email);
        return j({ ok: true, folderId, flextextUrl, audioUrl }, 200, origin, env);
      } catch (e) { return j({ error: e.code || 'drive_error', message: e.message }, 502, origin, env); }
    }

    if (m === 'POST' && sub === 'texts' && seg.length === 6 && seg[5] === 'move') {
      const r = await authResearcher(request, env);
      if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
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
        const mint = (fileId, extract) => mintTextfileUrl(env, url.origin, r.researcher_id, fileId, extract);
        const flextextUrl = await mint(body.flextextFileId) || await mint(body.extractFromZipId, 'flextext');
        const audioUrl = await mint(body.audioFileId);
        await logApproval(env, request, 'text_moved', docId.slice(0, 12) + '…', (from.nickname || '?') + ' → ' + (to.nickname || '?'), r.drive_email);
        return j({ ok: true, movedFolder, flextextUrl, audioUrl }, 200, origin, env);
      } catch (e) { return j({ error: e.code || 'drive_error', message: e.message }, 502, origin, env); }
    }

    /* POST .../assign-copy {docId, title, src} — RESEARCHER: place a copy of the assigned audio in
     * the text's folder, at assign time, server-side.
     * WHY HERE AND NOT ON THE DEVICE: drive.file cannot copy a file the app did not create, and the
     * device re-uploading what it just downloaded would spend the coworker's bandwidth — the one
     * resource this suite is built to protect. The Worker streams the PUBLIC file (the assignment
     * link is already public — the device fetches it through /drive with the read token) into a
     * file the app DOES create, with the researcher's own token, on Cloudflare's free egress.
     * Best-effort by contract: the assignment itself has already succeeded when this is called, and
     * a failed copy costs only the convenience copy. */
    if (m === 'POST' && sub === 'assign-copy' && seg.length === 4) {
      const r = await authResearcher(request, env);
      if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
      const inst = await env.DB.prepare('SELECT instance_id, nickname, oauth_folder_id FROM instance WHERE instance_id=? AND researcher_id=? AND revoked=0')
        .bind(instanceId, r.researcher_id).first();
      if (!inst) return j({ error: 'not_found' }, 404, origin, env);
      const body = await readJson(request) || {};
      const srcId = driveIdOf(String(body.src || ""));
      if (!srcId) return j({ error: 'bad_src' }, 400, origin, env);
      if (!body.docId) return j({ error: 'bad_doc' }, 400, origin, env);
      try {
        const access = await driveAccessToken(env, r);
        const deviceFolder = await driveEnsureDeviceFolder(env, access, instanceId, inst.nickname, inst.oauth_folder_id);
        const folder = await driveEnsureTextFolder(access, deviceFolder, body.docId, body.title);
        // Fetch the public file exactly as the /drive proxy does, then STREAM it into Drive —
        // never buffered, so a long recording cannot exhaust worker memory.
        const srcResp = await fetch(`https://drive.usercontent.google.com/download?id=${srcId}&export=download&confirm=t`);
        if (!srcResp.ok || (srcResp.headers.get('content-type') || '').includes('text/html')) {
          return j({ error: 'src_unavailable' }, 502, origin, env);
        }
        const len = parseInt(srcResp.headers.get('content-length') || '0', 10);
        if (!len) { try { srcResp.body?.cancel?.(); } catch { /* noop */ } return j({ error: 'no_length' }, 502, origin, env); }
        const mime = srcResp.headers.get('content-type') || 'application/octet-stream';
        let name = (srcResp.headers.get('content-disposition') || '').match(/filename="?([^";]+)"?/)?.[1] || '';
        name = (name || ('assigned-audio-' + srcId.slice(0, 8))).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 180);
        const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + access, 'content-type': 'application/json',
                     'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(len) },
          body: JSON.stringify({ name, mimeType: mime, parents: [folder], appProperties: { flextextRole: 'assigned-audio' } }),
        });
        const session = init.ok ? init.headers.get('Location') : null;
        if (!session) { try { srcResp.body?.cancel?.(); } catch { /* noop */ } return j({ error: 'drive_error' }, 502, origin, env); }
        const put = await fetch(session, {
          method: 'PUT',
          headers: { 'content-length': String(len), 'content-type': mime },
          body: srcResp.body,
        });
        const done = put.ok ? await put.json().catch(() => ({})) : {};
        if (!put.ok || !done.id) return j({ error: 'copy_failed', status: put.status }, 502, origin, env);
        return j({ ok: true, fileId: done.id, name, size: len }, 200, origin, env);
      } catch (e) { return j({ error: e.code || 'drive_error', message: e.message }, 502, origin, env); }
    }

    // POST .../revoke — revoke the whole instance.
    if (m === 'POST' && sub === 'revoke' && seg.length === 4) {
      const r = await authResearcher(request, env);
      if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
      await env.DB.batch([
        env.DB.prepare('UPDATE instance SET revoked=1 WHERE instance_id=? AND researcher_id=?').bind(instanceId, r.researcher_id),
        env.DB.prepare('UPDATE install SET revoked=1 WHERE instance_id=?').bind(instanceId),
      ]);
      return j({ ok: true }, 200, origin, env);
    }

    // Routes under /v1/instances/<id>/installs/<iid>/...
    if (sub === 'installs' && seg.length >= 5) {
      const installId = seg[4];
      const isub = seg[5];

      // POST .../approve — researcher approves a pending install (anti-leaked-link, §D.3).
      if (m === 'POST' && isub === 'approve' && seg.length === 6) {
        const r = await authResearcher(request, env);
        if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
        const owned = await env.DB.prepare(
          'SELECT i.install_id FROM install i JOIN instance n ON n.instance_id=i.instance_id WHERE i.install_id=? AND i.instance_id=? AND n.researcher_id=?'
        ).bind(installId, instanceId, r.researcher_id).first();
        if (!owned) return j({ error: 'not_found' }, 404, origin, env);
        await env.DB.prepare("UPDATE install SET status='approved' WHERE install_id=?").bind(installId).run();
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
        const r = await authResearcher(request, env);
        if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
        const owned = await env.DB.prepare(
          'SELECT i.install_id, i.accepted FROM install i JOIN instance n ON n.instance_id=i.instance_id WHERE i.install_id=? AND i.instance_id=? AND n.researcher_id=?'
        ).bind(installId, instanceId, r.researcher_id).first();
        if (!owned) return j({ error: 'not_found' }, 404, origin, env);
        // B: the field user must have accepted this enrollment before any key can be delivered.
        if (!owned.accepted) return j({ error: 'not_accepted' }, 409, origin, env);
        const body = await readJson(request);
        if (!body || !body.wrapped_key) return j({ error: 'bad_body' }, 400, origin, env);
        await env.DB.prepare('UPDATE install SET wrapped_key=? WHERE install_id=?').bind(body.wrapped_key, installId).run();
        return j({ ok: true }, 200, origin, env);
      }

      // POST .../revoke — researcher revokes one install (lost device). UNLINK only: the device gets 410
      // on its next poll → auto-releases but KEEPS its local texts (the researcher can't retrieve them after).
      if (m === 'POST' && isub === 'revoke' && seg.length === 6) {
        const r = await authResearcher(request, env);
        if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
        const owned = await env.DB.prepare(
          'SELECT i.install_id FROM install i JOIN instance n ON n.instance_id=i.instance_id WHERE i.install_id=? AND i.instance_id=? AND n.researcher_id=?'
        ).bind(installId, instanceId, r.researcher_id).first();
        if (!owned) return j({ error: 'not_found' }, 404, origin, env);
        await env.DB.prepare('UPDATE install SET revoked=1 WHERE install_id=?').bind(installId).run();
        return j({ ok: true }, 200, origin, env);
      }

      // POST .../wipe — researcher requests a REMOTE WIPE (seized/hostile-actor). Sets a sticky flag but
      // does NOT revoke: the device must stay authenticable so it can poll + RECEIVE the wipe directive
      // (delivered plaintext in the desired lane below, so it lands in ANY device state — even one never
      // keyed). Step-up TOTP when the researcher has 2FA, since this is destructive + remote + irreversible.
      if (m === 'POST' && isub === 'wipe' && seg.length === 6) {
        const r = await authResearcher(request, env);
        if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
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

      // POST .../force-remove — researcher gives up waiting on a seized device that never confirmed. KEEP-
      // ARMED: hide it from the panel but DO NOT delete the row + DO NOT clear wipe_state, so if that device
      // ever reconnects (weeks/months later) it still receives the wipe. (A normal unlink would lose it.)
      if (m === 'POST' && isub === 'force-remove' && seg.length === 6) {
        const r = await authResearcher(request, env);
        if (!r) return j({ error: 'unauthorized' }, 401, origin, env);
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
          await noteDriveError(env, inst.researcher_id, 'chunked upload start failed: ' + e.message);
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
          await noteDriveError(env, inst.researcher_id, 'device upload fell back to the relay: ' + e.message);
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
        await env.DB.prepare('UPDATE install SET reported_blob=?, reported_rev=reported_rev+1, ack_seq=?, last_seen_at=? WHERE install_id=? AND instance_id=? AND revoked=0')
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
      // it lands in any device state (even one seized mid-enrollment that never received its key).
      if (install && install.wipe_state === 'requested') return j({ wipe: true }, 200, origin, env);

      const inst = await env.DB.prepare('SELECT desired_blob, desired_rev, type, revoked, researcher_id FROM instance WHERE instance_id=?')
        .bind(instanceId).first();
      if (!inst) return j({ error: 'not_found' }, 404, origin, env);
      if (inst.revoked) return j({ error: 'revoked' }, 410, origin, env);   // whole-instance revoke → client auto-releases
      if (asResearcher && inst.researcher_id !== asResearcher.researcher_id) return j({ error: 'forbidden' }, 403, origin, env);
      // Provisional installs (§D.3) receive NO commands until approved.
      if (install && install.status !== 'approved') {
        return j({ pending: true, type: inst.type, desired_rev: inst.desired_rev }, 200, origin, env);
      }
      if (inst.desired_rev <= since) return new Response(null, { status: 204, headers: v1Cors(origin, env) });
      const blob = inst.desired_blob ? JSON.parse(inst.desired_blob) : { settings: {}, commands: [] };
      return j({ type: inst.type, desired_rev: inst.desired_rev, settings: blob.settings || {}, commands: blob.commands || [], wrapped_key: install ? (install.wrapped_key || null) : undefined }, 200, origin, env);
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
      const ok = await env.DB.prepare('SELECT install_id FROM install WHERE install_id=? AND instance_id=?').bind(installId, inv.instance_id).first();
      if (ok) {
        const inst = await env.DB.prepare('SELECT n.type, r.display_name, r.avatar_url, r.drive_email FROM instance n JOIN researcher r ON r.researcher_id=n.researcher_id WHERE n.instance_id=?').bind(inv.instance_id).first();
        return j({ instance_id: inv.instance_id, type: inst && inst.type, status: 'pending', researcher: inst ? { name: inst.display_name || '', avatar: inst.avatar_url || '', email: inst.drive_email || '' } : null }, 200, origin, env);
      }
    }
    if (inv.claimed_at) return j({ error: 'already_claimed' }, 409, origin, env);

    // Fresh claim — one atomic batch (§D.2): create the install, claim the invite
    // (guarded on still-unclaimed + not-expired), and revoke prior installs of the
    // instance (single-live-device, §D.4) only if THIS install wins the claim.
    const secretHash = await sha256hex(installSecret);
    await env.DB.batch([
      env.DB.prepare(
        'INSERT OR IGNORE INTO install (install_id, instance_id, secret_hash, status, reported_rev, ack_seq, revoked, created_at, pubkey) ' +
        "SELECT ?, instance_id, ?, 'pending', 0, 0, 0, ?, ? FROM invite WHERE invite_id=? AND claimed_at IS NULL AND (expires_at IS NULL OR expires_at>?)"
      ).bind(installId, secretHash, now, pubkey, inviteId, now),
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
    const inst = await env.DB.prepare('SELECT n.type, r.display_name, r.avatar_url, r.drive_email FROM instance n JOIN researcher r ON r.researcher_id=n.researcher_id WHERE n.instance_id=?').bind(inv.instance_id).first();
    return j({ instance_id: inv.instance_id, type: inst && inst.type, status: 'pending', researcher: inst ? { name: inst.display_name || '', avatar: inst.avatar_url || '', email: inst.drive_email || '' } : null }, 200, origin, env);
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
      return j({ crowd_id, estate: 'cloud' }, 200, origin, env);
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
        const name = 'crowd_' + slug + '_' + new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19) + '_' + subId.slice(0, 8) + '.zip';
        try {
          const rrow = await env.DB.prepare('SELECT * FROM researcher WHERE researcher_id=?').bind(rec.researcher_id).first();
          const access = await driveAccessToken(env, rrow);
          const folder = await driveEnsureCrowdFolder(env, access, rec);
          const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + access, 'content-type': 'application/json',
                       'X-Upload-Content-Type': 'application/zip', 'X-Upload-Content-Length': String(size) },
            body: JSON.stringify({ name, mimeType: 'application/zip', parents: [folder] }),
          });
          const session = init.ok ? init.headers.get('Location') : null;
          if (!session) { const e = new Error('no session (HTTP ' + init.status + ')'); e.code = 'drive_error'; throw e; }
          const uploadId = await encAtRest(env, JSON.stringify({ u: session, c: crowdId, s: size, d: subId, n: name, t: now }));
          return j({ ok: true, uploadId }, 200, origin, env);
        } catch (e) {
          await noteDriveError(env, rec.researcher_id, 'crowd chunked start failed: ' + e.message);
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
        const name = 'crowd_' + slug + '_' + new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19) + '_' + subId.slice(0, 8) + '.zip';

        // Delivery: the researcher's own Drive (streaming) — the ONLY path. On any
        // failure the visitor's client keeps the zip and retries; the researcher
        // sees drive_error in the panel. Nothing is ever lost — it waits.
        let fileId = null;
        const status = 'ok';
        try {
          const rrow = await env.DB.prepare('SELECT * FROM researcher WHERE researcher_id=?').bind(rec.researcher_id).first();
          const access = await driveAccessToken(env, rrow);
          const folder = await driveEnsureCrowdFolder(env, access, rec);
          fileId = await driveUpload(access, folder, name, buf, 'application/zip');
        } catch (e) {
          await noteDriveError(env, rec.researcher_id, 'crowd delivery failed: ' + e.message);
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
