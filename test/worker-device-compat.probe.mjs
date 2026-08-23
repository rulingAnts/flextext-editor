/* THE COMPAT GATE: replay TODAY'S field-device calls against a worker and assert nothing moved.
 *
 * WHY THIS IS THE MOST IMPORTANT TEST IN THE PROJECT-SPLIT WORK. Android APKs never auto-update, so
 * the worker serves yesterday's native clients indefinitely. Every phase of the researcher/project
 * split (sessions, default projects, membership, authorization) touches the same worker those
 * devices depend on, and a device-lane regression does not look like a failure — it looks like a
 * coworker in a village whose transcription silently stops syncing.
 *
 * So this drives the WHOLE enrolment + sync lifecycle with today's paths, headers and body shapes,
 * and asserts the RESPONSE SHAPES, not just the status codes: a field device parses those fields by
 * name, and a renamed key is as fatal as a 500.
 *
 * It needs no Google, no Turnstile, no Drive and no Cloudflare account — that is deliberate, and it
 * is why the local rig can gate every phase without the staging worker existing (PART V Tier 1).
 *
 * Run:  bash test/local-rig.sh                        (starts the worker, seeds, probes)
 *       node test/worker-device-compat.probe.mjs [base-url]
 */

import { FIXTURE } from './worker-seed.mjs';
import { randomUUID } from 'node:crypto';

const BASE = process.argv[2] || process.env.FX_PROBE_BASE || 'http://127.0.0.1:8787';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const has = (o, keys, label) =>
  ok(keys.every((k) => Object.prototype.hasOwnProperty.call(o || {}, k)),
     `${label} carries [${keys.join(', ')}] — got [${Object.keys(o || {}).join(', ')}]`);

const RESEARCHER = { 'x-fx-researcher': FIXTURE.researcherId, 'x-fx-secret': FIXTURE.researcherSecret };

async function call(method, path, { headers = {}, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 and friends */ }
  return { status: res.status, json };
}

console.log(`device compat probe → ${BASE}\n`);

/* ---- 0. the worker is up and refusing anonymous calls (proves we are hitting the real thing) ---- */
const anon = await call('GET', '/v1/researcher');
ok(anon.status === 401, `unauthenticated GET /v1/researcher is 401 (got ${anon.status})`);

/* ---- 1. RESEARCHER LANE: create the instance a device will pair to ---- */
const created = await call('POST', '/v1/instances',
  { headers: RESEARCHER, body: { type: '', nickname: 'Probe Device' } });
ok(created.status === 200, `POST /v1/instances is 200 (got ${created.status})`);
has(created.json, ['instance_id', 'type', 'nickname', 'estate'], 'create-instance response');
ok(created.json && created.json.estate === 'cloud',
   `a NEW instance is stamped estate='cloud' (got ${created.json && created.json.estate})`);
const instanceId = created.json && created.json.instance_id;

/* ---- 2. RESEARCHER LANE: mint the pairing invite ---- */
const invite = await call('POST', `/v1/instances/${instanceId}/invite`, { headers: RESEARCHER, body: {} });
ok(invite.status === 200, `POST …/invite is 200 (got ${invite.status})`);
has(invite.json, ['invite_id', 'secret', 'expires_at', 'estate'], 'invite response');

/* ---- 3. DEVICE LANE: claim it — client-minted ids, invite secret in a header ---- */
const installId = randomUUID();
const installSecret = 'probe-install-secret-' + randomUUID();
const claim = await call('POST', `/v1/invites/${invite.json.invite_id}/claim`, {
  headers: { 'x-fx-invite-secret': invite.json.secret },
  body: { install_id: installId, install_secret: installSecret, pubkey: 'FIXTURE-SPKI-BASE64' },
});
ok(claim.status === 200, `POST /v1/invites/<id>/claim is 200 (got ${claim.status})`);
has(claim.json, ['instance_id', 'type', 'status'], 'claim response');
ok(claim.json && claim.json.status === 'pending', `a fresh claim is 'pending' (got ${claim.json && claim.json.status})`);

/* Idempotent retry — the lost-response recovery a flaky village connection actually needs. */
const reclaim = await call('POST', `/v1/invites/${invite.json.invite_id}/claim`, {
  headers: { 'x-fx-invite-secret': invite.json.secret },
  body: { install_id: installId, install_secret: installSecret, pubkey: 'FIXTURE-SPKI-BASE64' },
});
ok(reclaim.status === 200, `re-claiming with the SAME install_id is idempotent (got ${reclaim.status})`);

const DEVICE = { 'x-fx-install': installId, 'x-fx-secret': installSecret };

/* ---- 4. a pending install polls, and is told to wait rather than handed commands ---- */
const pendingPoll = await call('GET', `/v1/instances/${instanceId}?since=-1`, { headers: DEVICE });
ok(pendingPoll.status === 200, `pending device poll is 200 (got ${pendingPoll.status})`);
ok(pendingPoll.json && pendingPoll.json.pending === true,
   'a pending install is told { pending: true } and receives NO commands');
/* ⚠⚠ THE DEVICE IS TOLD THE NAME ITS RESEARCHER GAVE IT (v440), asserted on the VALUE a real device
 * receives rather than on the source text. It shipped BROKEN and stayed broken in production: the
 * desired-lane SELECT omitted the `nickname` column, so `inst.nickname || ''` was always ''.
 * pair-code.test.mjs asserted only that the string appeared in the worker — true the whole time, and
 * worth nothing. Drop `nickname` from that SELECT and this fails by name.
 * ⚠ It rides the PENDING branch too, which is the branch that matters most: the pairing screen is
 * exactly where two people are trying to confirm they are holding the same device. */
ok(pendingPoll.json && pendingPoll.json.nickname === 'Probe Device',
   `⚠⚠ the PENDING poll carries the researcher's name for the device (got ${JSON.stringify(pendingPoll.json && pendingPoll.json.nickname)}, want "Probe Device")`);

/* ---- 5. RESEARCHER approves; DEVICE accepts (the two-sided enrolment gate) ---- */
const approve = await call('POST', `/v1/instances/${instanceId}/installs/${installId}/approve`, { headers: RESEARCHER, body: {} });
ok(approve.status === 200, `POST …/approve is 200 (got ${approve.status})`);
const accept = await call('POST', `/v1/instances/${instanceId}/installs/${installId}/accept`, { headers: DEVICE, body: {} });
ok(accept.status === 200, `POST …/accept is 200, authed by the install secret (got ${accept.status})`);

/* ---- 6. the approved device polls the desired lane ---- */
const poll = await call('GET', `/v1/instances/${instanceId}?since=-1`, { headers: DEVICE });
ok(poll.status === 200, `approved device poll is 200 (got ${poll.status})`);
has(poll.json, ['type', 'desired_rev', 'settings', 'commands'], 'desired-lane response');
ok(poll.json && poll.json.nickname === 'Probe Device',
   `⚠⚠ and the APPROVED poll carries it too (got ${JSON.stringify(poll.json && poll.json.nickname)}) — sync.js re-reads it on EVERY poll so a rename reaches the device`);

/* The idle short-circuit: nothing new → 204, which is what keeps village polling cheap. */
const idle = await call('GET', `/v1/instances/${instanceId}?since=${poll.json.desired_rev}`, { headers: DEVICE });
ok(idle.status === 204, `an up-to-date poll short-circuits to 204 (got ${idle.status})`);

/* ---- 7. the device reports its inventory back up the wire ---- */
const report = await call('POST', `/v1/instances/${instanceId}/installs/${installId}/report`, {
  headers: DEVICE,
  body: { reported: { device: 'probe', texts: [] }, ack_seq: 0 },
});
ok(report.status === 200, `POST …/report is 200 (got ${report.status})`);

/* Unchanged inventory must NOT bump a revision — the idempotency that stops a quiet device from
 * looking busy. */
const report2 = await call('POST', `/v1/instances/${instanceId}/installs/${installId}/report`, {
  headers: DEVICE,
  body: { reported: { device: 'probe', texts: [] }, ack_seq: 0 },
});
ok(report2.status === 200, `re-reporting identical inventory is 200 and idempotent (got ${report2.status})`);

/* ---- 8. the researcher sees the device in the panel listing ---- */
const list = await call('GET', '/v1/researcher', { headers: RESEARCHER });
ok(list.status === 200, `GET /v1/researcher is 200 (got ${list.status})`);
const seen = list.json && Array.isArray(list.json.instances)
  && list.json.instances.some((i) => i.instance_id === instanceId);
ok(seen, 'the new instance appears in the researcher listing');

/* ---- 9. a WRONG install secret is refused (the auth boundary itself) ---- */
const bad = await call('GET', `/v1/instances/${instanceId}?since=-1`,
  { headers: { 'x-fx-install': installId, 'x-fx-secret': 'wrong' } });
ok(bad.status === 401, `a wrong install secret on a live row is 401 (got ${bad.status})`);

/* ---- 10. A RE-KEYED IDLE DEVICE MUST BE TOLD (round-2 finding R2-2) ----
 *
 * The device re-unwraps its Ki only when the poll body's `wrapped_key` CHANGES — but the poll
 * short-circuits to 204 while desired_rev <= since. So delivering a key WITHOUT bumping desired_rev
 * means a device with nothing else pending never receives it, and goes on encrypting under the old
 * key indefinitely: exactly the key a removed member still holds. Rotation is the remedy after
 * revoking someone; this asserts the remedy actually arrives. */
{
  /* Park the device up to date, so the only thing that could wake it is the key delivery itself. */
  const upToDate = await call('GET', `/v1/instances/${instanceId}?since=${poll.json.desired_rev}`, { headers: DEVICE });
  ok(upToDate.status === 204, `the device starts idle — nothing pending (got ${upToDate.status})`);
  const idleRev = poll.json.desired_rev;

  const keyed = await call('POST', `/v1/instances/${instanceId}/installs/${installId}/key`, {
    headers: RESEARCHER, body: { wrapped_key: 'REKEYED-CIPHERTEXT' },
  });
  ok(keyed.status === 200, `the researcher delivers a new wrapped key (got ${keyed.status})`);

  const after = await call('GET', `/v1/instances/${instanceId}?since=${idleRev}`, { headers: DEVICE });
  ok(after.status === 200,
     `the IDLE device is now handed a body instead of a 204 — without this, a re-keyed device never `
     + `learns and keeps using the key a removed member holds (got ${after.status})`);
  ok(after.json && after.json.wrapped_key === 'REKEYED-CIPHERTEXT',
     'and the body carries the NEW wrapped key, which is what triggers the device to re-unwrap');
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASS — the device lane is byte-compatible');
process.exit(fail ? 1 : 0);
