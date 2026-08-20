/* THE MEMBER LIFECYCLE, END TO END, AGAINST A REAL WORKER — Phase C 2d.
 *
 * ⚠ THIS TEST WAS IMPOSSIBLE UNTIL TODAY, and that is the finding as much as anything it asserts.
 * There was no route to add a member, none to read another researcher's public key, and none to
 * revoke a grant — so "an owner invites a guest researcher with granular, revocable access", the
 * whole point of Phase C, could not be exercised even once. Every claim about sharing was a claim
 * about code that did not exist.
 *
 * What it pins: a member gets exactly what they were granted and nothing else; the `see` list bounds
 * a capability rather than merely decorating it; removal takes the KEY GRANTS with it, so revocation
 * is an act and not a UI state; and the owner cannot be demoted into a member row.
 *
 * Run: bash test/local-rig.sh   (or: node test/worker-members.probe.mjs http://127.0.0.1:8787)
 */
import { FIXTURE } from './worker-seed.mjs';

const BASE = process.argv[2] || process.env.FX_PROBE_BASE || 'http://127.0.0.1:8787';
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const OWNER = { 'x-fx-researcher': FIXTURE.researcherId, 'x-fx-secret': FIXTURE.researcherSecret };
const GUEST = { 'x-fx-researcher': FIXTURE.outsiderId, 'x-fx-secret': FIXTURE.outsiderSecret };

async function call(method, path, headers, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}

console.log(`member lifecycle → ${BASE}\n`);

const a = await call('POST', '/v1/instances', OWNER, { type: '', nickname: 'Granted Device' });
const b = await call('POST', '/v1/instances', OWNER, { type: '', nickname: 'Hidden Device' });
const idA = a.json && a.json.instance_id, idB = b.json && b.json.instance_id;
ok(!!idA && !!idB, 'created two devices');
await call('POST', '/v1/researcher/admin/backfill-projects', OWNER, {});

console.log('a project id is DISCOVERABLE — the members routes are unreachable otherwise');
const list = await call('GET', '/v1/projects', OWNER);
ok(list.status === 200, `GET /v1/projects is 200 (got ${list.status})`);
const projectId = list.json && list.json.owned && list.json.owned[0] && list.json.owned[0].project_id;
ok(!!projectId, `it returns the owned project's id (${projectId ? 'yes' : 'NO — everything below is unaddressable'})`);

console.log('\nbefore being added, the guest is nobody');
{
  ok((await call('GET', `/v1/projects/${projectId}/members`, GUEST)).status === 404,
     'the guest cannot even read the member list');
  ok((await call('POST', `/v1/instances/${idA}/rename`, GUEST, { nickname: 'x' })).status === 404,
     'and cannot touch a device');
}

console.log('\ncaps are VALIDATED on the way in — an owner must be told, not silently granted nothing');
{
  const bad = [
    [{ see: 'some' }, 'see must be "all" or a list'],
    [{ see: 'all', manageDevices: 'yes' }, 'a truthy STRING is not a boolean grant'],
    [{ see: 'all', drive: 'write' }, 'drive is read|manage, nothing else'],
    [{ see: 'all', wipe: true }, '⚠ wipe cannot be delegated in v1 — accepting and ignoring it would be a lie'],
    [{ see: 'all', madeUpCap: true }, 'an unknown capability name is refused, not stored'],
  ];
  for (const [caps, label] of bad) {
    const res = await call('POST', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.outsiderId, caps });
    ok(res.status === 400 && res.json && res.json.error === 'bad_caps', `${label} (got ${res.status})`);
  }
  const self = await call('POST', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.researcherId, caps: { see: 'all' } });
  ok(self.status === 400, `⚠ the owner cannot be added as a member (got ${self.status}) — ownership is project.owner_id, and a second answer could disagree with it`);
  const ghost = await call('POST', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: 'no-such-researcher', caps: { see: 'all' } });
  ok(ghost.status === 404, `a membership row naming nobody is refused (got ${ghost.status})`);
}

console.log('\nadded with ONE device visible and assignTexts only');
const add = await call('POST', `/v1/projects/${projectId}/members`, OWNER, {
  researcher_id: FIXTURE.outsiderId, caps: { see: [idA], assignTexts: true },
});
ok(add.status === 200, `the guest is added (got ${add.status})`);
ok(add.json && add.json.caps && add.json.caps.manageDevices === undefined,
   'caps come back NORMALISED — absent means false, so unknown keys cannot accumulate');
{
  const seen = await call('GET', '/v1/projects', GUEST);
  ok(seen.status === 200 && seen.json.joined.length === 1, 'the guest now sees the project as joined');
  ok(seen.json.joined[0].owner_id === FIXTURE.researcherId, 'with the owner as an OPAQUE ID');
  ok(!JSON.stringify(seen.json.joined[0]).includes('@'),
     '⚠ and no email anywhere in the joined listing — identity is not advertised');
}

console.log('\nthe grant is exactly what was given');
{
  /* ⚠ THE GRANTED AND UNGRANTED DEVICES MUST DIFFER, and this pair is the only thing that keeps the
   * see-list assertion below from being vacuous. The first version asserted `status !== 404 || true`
   * — a tautology, which would have passed even if BOTH devices were refused, certifying a bounded
   * capability while testing nothing. Verified by hand against the rig: the granted device reaches
   * Drive and dies there (502 oauth_unconfigured, the rig having no Google), while the ungranted one
   * never gets that far. So "past authorization" is exactly "not not_found". */
  const reach = await call('POST', `/v1/instances/${idA}/texts/probedoc/adopt`, GUEST, {});
  ok(reach.status !== 404,
     `assignTexts on the VISIBLE device gets PAST authorization (got ${reach.status} — 502 oauth_unconfigured on the rig, never 404)`);
  ok((await call('POST', `/v1/instances/${idA}/rename`, GUEST, { nickname: 'x' })).status === 404,
     '⚠ manageDevices was NOT granted, so rename is refused even on the visible device');
  const blocked = await call('POST', `/v1/instances/${idB}/texts/probedoc/adopt`, GUEST, {});
  ok(blocked.status === 404 && blocked.status !== reach.status,
     `⚠⚠ THE see LIST BOUNDS THE CAPABILITY: the same grant that reached device A is refused on device B (${reach.status} vs ${blocked.status})`);
  ok((await call('POST', `/v1/instances/${idA}/installs/nope/wipe`, GUEST, {})).status === 404,
     'wipe stays owner-only whatever the member holds');
}

console.log('\nremoval takes the KEY GRANTS with it — revocation is an act, not a UI state');
{
  await call('POST', '/v1/researcher/keys', OWNER, {
    instance_id: idA, key_version: 1,
    grants: [{ researcher_id: FIXTURE.researcherId, wrapped_ki: 'OWNER-COPY' },
             { researcher_id: FIXTURE.outsiderId, wrapped_ki: 'GUEST-COPY' }],
  });
  const held = await call('GET', `/v1/researcher/keys?instance=${idA}`, GUEST);
  ok(held.status === 200 && (held.json.keys || []).length === 1, 'the guest holds a wrapped key');

  const del = await call('DELETE', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.outsiderId });
  ok(del.status === 200, `the guest is removed (got ${del.status})`);
  ok(del.json && del.json.grants_removed >= 1,
     `⚠ and their key grants went with it (${del.json && del.json.grants_removed}) — otherwise "removed" means still holding every Ki`);
  ok((await call('GET', `/v1/researcher/keys?instance=${idA}`, GUEST)).json.keys.length === 0,
     'the worker no longer hands them the key');
  ok((await call('POST', `/v1/instances/${idA}/texts/probedoc/adopt`, GUEST, {})).status === 404,
     'and the capability is gone with the membership');
}

console.log('\nthe owner can never revoke their OWN copy of a device key');
{
  const res = await call('DELETE', '/v1/researcher/keys', OWNER, { instance_id: idA, researcher_id: FIXTURE.researcherId });
  ok(res.status === 400 && res.json.error === 'owner_grant_required',
     `⚠ refused (got ${res.status}) — the mirror of the wrap-to-owner invariant; the key is wrapped to keys the worker cannot read, so nothing could reconstruct it`);
}

console.log('\npubkey lookup returns the KEY and no identity');
{
  await call('POST', '/v1/researcher/pubkey', GUEST, { pubkey: 'SPKI-GUEST', wrapped_privkey: 'PKCS8-GUEST' });
  const got = await call('GET', `/v1/researcher/pubkey/${FIXTURE.outsiderId}`, OWNER);
  ok(got.status === 200 && got.json.pubkey === 'SPKI-GUEST', `the owner can read the guest's public key (got ${got.status})`);
  ok(!JSON.stringify(got.json).includes('@') && got.json.display_name === undefined,
     '⚠ and gets no email and no display name — the wrapping needs the key, not the person');
  ok((await call('GET', '/v1/researcher/pubkey/nobody-at-all', OWNER)).status === 404, 'an unknown id is not_found');
}

console.log('\nUNCONVERTED Drive routes are INERT for a member, not leaky — the R2-4 property');
{
  /* ⚠ THIS IS THE ASSERTION THAT MAKES "CONVERT ONE ROUTE AT A TIME" SURVIVABLE, so it is worth
   * pinning rather than assuming. The account-wide Drive routes still resolve through
   * authResearcher, which hands back THE CALLER'S OWN researcher row. So a member calling them acts
   * on their own (empty) Drive, never the owner's — an unconverted route means "members cannot do
   * that yet", which is the whole reason a partial conversion is safe.
   *
   * The guest fixture has no drive_refresh_enc, so reaching Drive with THEIR row fails at OAuth.
   * That failure is the evidence: it proves the route used the guest's row and not the owner's,
   * which would have succeeded. If this ever returns 200, a member is reading the owner's estate
   * through a route nobody converted. */
  await call('POST', `/v1/projects/${projectId}/members`, OWNER, {
    researcher_id: FIXTURE.outsiderId, caps: { see: 'all', drive: 'manage' },
  });
  for (const [method, path, label] of [
    ['GET', '/v1/researcher/drive-estate', 'drive-estate'],
    ['POST', '/v1/researcher/drive-purge', 'drive-purge'],
    ['GET', '/v1/researcher/drive-file/any-file-id', 'drive-file'],
  ]) {
    const res = await call(method, path, GUEST, method === 'POST' ? {} : null);
    ok(res.status !== 200,
       `⚠ ${label}: a member with drive:manage gets ${res.status}, NOT the owner's estate — the route acts on the caller's own Drive`);
  }
  await call('DELETE', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.outsiderId });
}

console.log(fail ? `\n${fail} FAILED\n` : '\nPASS\n');
process.exit(fail ? 1 : 0);
