/* Phase A: the session lane — and the two regressions round 2 found before it was built.
 *
 * WHAT MUST STAY TRUE, and why each matters more than it looks:
 *
 *  1. THE LEGACY CREDENTIAL KEEPS WORKING. Every already-installed researcher panel authenticates
 *     with researcher.secret_hash. If the session lane replaced it rather than preceding it, the
 *     worker deploy would sign out every panel in the field the moment it landed — with no client
 *     update available to fix it. The fallback IS the compatibility story for this phase.
 *
 *  2. SIGN-OUT MUST NOT TOUCH researcher.secret_hash (round-2 finding R2-3). The old endpoint
 *     rotated it, which is correct for a Google account (the column WAS the session token) and
 *     catastrophic for a password account (the same column is the durable password verifier — sign
 *     out and you can never log in again without an emailed reset). It was unreachable dead code;
 *     wiring the client to sign-out, which this phase does, is exactly what would have armed it.
 *     So: sign out, then prove the legacy credential STILL authenticates.
 *
 *  3. Expiry is ENFORCED, not merely recorded — an expired row must not fall through to the legacy
 *     comparison and quietly authenticate anyway.
 *
 * Runs against the local rig (no Google, no Cloudflare account): bash test/local-rig.sh --sessions
 */

import { FIXTURE } from './worker-seed.mjs';

const BASE = process.argv[2] || process.env.FX_PROBE_BASE || 'http://127.0.0.1:8787';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const hdr = (secret) => ({ 'x-fx-researcher': FIXTURE.researcherId, 'x-fx-secret': secret });

async function call(method, path, secret, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...hdr(secret) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

console.log(`session lane → ${BASE}\n`);

/* ---- 1. both credentials authenticate: the new lane AND the one every field panel still uses ---- */
const viaSession = await call('GET', '/v1/researcher', FIXTURE.sessionSecret);
ok(viaSession.status === 200, `a SESSION token authenticates (got ${viaSession.status})`);

const viaLegacy = await call('GET', '/v1/researcher', FIXTURE.researcherSecret);
ok(viaLegacy.status === 200,
   `the LEGACY researcher secret still authenticates — every installed panel depends on this (got ${viaLegacy.status})`);

const viaGarbage = await call('GET', '/v1/researcher', 'not-a-real-token');
ok(viaGarbage.status === 401, `an unknown token is refused (got ${viaGarbage.status})`);

/* ---- 2. an expired session is refused, and does NOT fall through to the legacy compare ---- */
const viaExpired = await call('GET', '/v1/researcher', FIXTURE.expiredSessionSecret);
ok(viaExpired.status === 401, `an EXPIRED session is refused rather than slid forward (got ${viaExpired.status})`);

/* ---- 3. the session list: enough to recognise yourself, and to spot someone else ---- */
const list = await call('GET', '/v1/researcher/sessions', FIXTURE.sessionSecret);
ok(list.status === 200, `GET /v1/researcher/sessions is 200 (got ${list.status})`);
const rows = (list.json && list.json.sessions) || [];
ok(rows.length >= 1, `the list returns the live sessions (${rows.length})`);
const mine = rows.find((x) => x.session_id === FIXTURE.sessionId);
ok(!!mine, 'the calling session appears in its own list');
ok(mine && mine.current === true, 'the calling session is marked current, so you know which not to revoke');
ok(mine && typeof mine.label === 'string' && typeof mine.geo === 'string' && typeof mine.ip === 'string',
   'each row carries label, geo and ip — the fields that answer "is that my office?"');
ok(list.json && list.json.cap === 5, `the cap is reported to the UI (got ${list.json && list.json.cap})`);

/* ---- 4. revoke ONE (the expired row is a convenient target: revoking is independent of expiry) ---- */
const del = await call('DELETE', `/v1/researcher/sessions/${FIXTURE.expiredSessionId}`, FIXTURE.sessionSecret);
ok(del.status === 200, `DELETE …/sessions/<id> revokes one (got ${del.status})`);
const delAgain = await call('DELETE', `/v1/researcher/sessions/${FIXTURE.expiredSessionId}`, FIXTURE.sessionSecret);
ok(delAgain.status === 404, `revoking it twice is 404, not a silent success (got ${delAgain.status})`);
const bogus = await call('DELETE', '/v1/researcher/sessions/00000000-0000-4000-8000-00000000ffff', FIXTURE.sessionSecret);
ok(bogus.status === 404, `revoking someone else's session id is 404 — the bind fails closed (got ${bogus.status})`);

/* ---- 5. revoke-others leaves the caller signed in ---- */
const others = await call('POST', '/v1/researcher/sessions/revoke-others', FIXTURE.sessionSecret, {});
ok(others.status === 200, `POST …/sessions/revoke-others is 200 (got ${others.status})`);
const stillMe = await call('GET', '/v1/researcher', FIXTURE.sessionSecret);
ok(stillMe.status === 200, 'revoke-others does NOT sign out the browser that asked');

/* ---- 6. THE R2-3 REGRESSION: sign out, then prove the password verifier survived ---- */
const signout = await call('POST', '/v1/researcher/signout', FIXTURE.sessionSecret, {});
ok(signout.status === 200, `POST /v1/researcher/signout is 200 (got ${signout.status})`);

const afterSignout = await call('GET', '/v1/researcher', FIXTURE.sessionSecret);
ok(afterSignout.status === 401, `the signed-out session no longer authenticates (got ${afterSignout.status})`);

const legacyAfterSignout = await call('GET', '/v1/researcher', FIXTURE.researcherSecret);
ok(legacyAfterSignout.status === 200,
   'R2-3: sign-out did NOT rotate researcher.secret_hash — on a password account that column is the '
   + `password verifier, and destroying it would lock the researcher out for good (got ${legacyAfterSignout.status})`);

/* ---- 7. A REVOKED RESEARCHER SESSION MUST NOT DISTURB A FIELD DEVICE ----
 *
 * Devices authenticate with their own install secret and have nothing to do with browser sessions.
 * That is obvious from the code today and would be easy to break tomorrow — "revoke everything for
 * this account" is a natural-sounding feature, and cascading it to installs would silently unlink a
 * coworker's phone in a village, which looks like nothing at all from the panel. So it is pinned. */
{
  const inst = await call('POST', '/v1/instances', FIXTURE.researcherSecret, { type: '', nickname: 'Session-Independence Probe' });
  const instanceId = inst.json && inst.json.instance_id;
  const inv = await call('POST', `/v1/instances/${instanceId}/invite`, FIXTURE.researcherSecret, {});
  const installId = crypto.randomUUID();
  const installSecret = 'probe-install-' + crypto.randomUUID();
  await fetch(`${BASE}/v1/invites/${inv.json.invite_id}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fx-invite-secret': inv.json.secret },
    body: JSON.stringify({ install_id: installId, install_secret: installSecret, pubkey: 'FIXTURE' }),
  });
  await call('POST', `/v1/instances/${instanceId}/installs/${installId}/approve`, FIXTURE.researcherSecret, {});

  const devicePoll = async () => (await fetch(`${BASE}/v1/instances/${instanceId}?since=-1`,
    { headers: { 'x-fx-install': installId, 'x-fx-secret': installSecret } })).status;

  ok(await devicePoll() === 200, 'the paired device polls normally to begin with');

  await call('POST', '/v1/researcher/sessions/revoke-others', FIXTURE.researcherSecret, {});
  await call('POST', '/v1/researcher/signout', FIXTURE.researcherSecret, {});

  ok(await devicePoll() === 200,
     'after revoke-others AND sign-out, the device STILL polls — browser sessions and install '
     + 'credentials are separate lanes, and cascading one to the other would unlink a field phone');
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
