/* THE MEMBER LIFECYCLE, END TO END, AGAINST A REAL WORKER — Phase C 2d.
 *
 * ⚠ THIS TEST WAS IMPOSSIBLE UNTIL TODAY, and that is the finding as much as anything it asserts.
 * There was no route to add a member, none to read another researcher's public key, and none to
 * revoke a grant — so "an owner invites a guest researcher with granular, revocable access", the
 * whole point of Phase C, could not be exercised even once. Every claim about sharing was a claim
 * about code that did not exist.
 *
 * What it pins: a member gets exactly the capabilities they were granted and nothing else, across
 * the whole project (which IS the access boundary — see project-authz for the cross-project denial);
 * removal takes the KEY GRANTS with it, so revocation is an act and not a UI state; and the owner
 * cannot be demoted into a member row.
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
const owned = (list.json && list.json.owned) || [];
const projectId = (owned.find((p) => p.drive_folder_id) || {}).project_id;
const unmigratedId = (owned.find((p) => !p.drive_folder_id) || {}).project_id;
ok(!!projectId, `it returns the MIGRATED project's id (${projectId ? 'yes' : 'NO — everything below is unaddressable'})`);
ok(!!unmigratedId, 'and the unmigrated one, which the gate below needs');

console.log('\nsharing is REFUSED until the owner has migrated to project folders');
{
  /* ⚠ Seth, 2026-08-20: *"No researcher sharing if the researcher hasn't migrated to the project
   * model and doesn't have project folders."* The reason is structural rather than procedural: a
   * member is confined to a project FOLDER — they must not reach *"the root folder outside of
   * projects shared with them"* — so their file listing has to be ROOTED at that folder. On a flat,
   * unmigrated estate the devices sit directly under master and there is no subtree to root at, so
   * the confinement has nothing to stand on.
   *
   * Refused at the moment a person is present to be told. Added-but-sees-nothing is indistinguishable
   * from a bug, and the owner would have no way to tell which it was. */
  const res = await call('POST', `/v1/projects/${unmigratedId}/members`, OWNER, {
    researcher_id: FIXTURE.outsiderId, caps: {},
  });
  ok(res.status === 409 && res.json && res.json.error === 'not_migrated',
     `⚠ an unmigrated project refuses to be shared (got ${res.status} ${res.json && res.json.error})`);
  ok(res.json && /migrate/i.test(res.json.message || ''),
     'and says what to do about it, not merely that it failed');
  ok((await call('GET', `/v1/projects/${unmigratedId}/members`, OWNER)).json.members.length === 0,
     'and nobody was added — the refusal is before the write, not a rollback after it');
}

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
    [{ manageDevices: 'yes' }, 'a truthy STRING is not a boolean grant'],
    [{ drive: 'write' }, 'drive is read|manage, nothing else'],
    [{ wipe: true }, '⚠ wipe cannot be delegated in v1 — accepting and ignoring it would be a lie'],
    [{ madeUpCap: true }, 'an unknown capability name is refused, not stored'],
    [{ see: 'all' }, '⚠ `see` is refused too — the per-device list was removed, and silently dropping it would let a caller believe they had narrowed access'],
  ];
  for (const [caps, label] of bad) {
    const res = await call('POST', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.outsiderId, caps });
    ok(res.status === 400 && res.json && res.json.error === 'bad_caps', `${label} (got ${res.status})`);
  }
  const self = await call('POST', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.researcherId, caps: {} });
  ok(self.status === 400, `⚠ the owner cannot be added as a member (got ${self.status}) — ownership is project.owner_id, and a second answer could disagree with it`);
  const ghost = await call('POST', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: 'no-such-researcher', caps: {} });
  ok(ghost.status === 404, `a membership row naming nobody is refused (got ${ghost.status})`);
}

console.log('\nthe DEFERRED capabilities cannot be granted at all (audit remediation)');
{
  /* ⚠ THIS IS THE SECURITY PROPERTY THE v1 FIX RESTS ON, so it is tested at the API rather than only
   * in validateCaps' unit tests: nine of the audit's seventeen findings share one root cause, and
   * every one of those nine is reachable only through `assignTexts` or `drive`. If either can be
   * written, the whole remediation is undone silently. */
  for (const caps of [{ assignTexts: true }, { drive: 'read' }, { drive: 'manage' },
                      { manageDevices: true, assignTexts: true }]) {
    const res = await call('POST', `/v1/projects/${projectId}/members`, OWNER, {
      researcher_id: FIXTURE.outsiderId, caps,
    });
    ok(res.status === 400 && res.json && res.json.error === 'bad_caps',
       `⚠ refused: ${JSON.stringify(caps)} (got ${res.status} ${res.json && res.json.error})`);
  }
  ok((await call('GET', `/v1/projects/${projectId}/members`, OWNER)).json.members.length === 0,
     'and none of those attempts left a member row behind');
}

console.log('\nadded with manageDevices — device management is what v1 members get');
const add = await call('POST', `/v1/projects/${projectId}/members`, OWNER, {
  researcher_id: FIXTURE.outsiderId, caps: { manageDevices: true },
});
ok(add.status === 200, `the guest is added (got ${add.status})`);
ok(add.json && add.json.caps && add.json.caps.assignTexts === undefined,
   'caps come back NORMALISED — absent means false, so unknown keys cannot accumulate');
{
  const seen = await call('GET', '/v1/projects', GUEST);
  ok(seen.status === 200 && seen.json.joined.length === 1, 'the guest now sees the project as joined');
  ok(seen.json.joined[0].owner_id === FIXTURE.researcherId, 'with the owner as an OPAQUE ID');
  ok(!JSON.stringify(seen.json.joined[0]).includes('@'),
     '⚠ and no email anywhere in the joined listing — identity is not advertised');
}

console.log('\nwhat that member CAN do, and what they still cannot');
{
  ok((await call('POST', `/v1/instances/${idA}/rename`, GUEST, { nickname: 'Renamed By Member' })).status === 200,
     '✅ rename works — this is the useful half, and it never takes a caller-supplied Drive id');
  ok((await call('POST', `/v1/instances/${idB}/rename`, GUEST, { nickname: 'Also Renamed' })).status === 200,
     'on every device in the project, because the project IS the boundary');

  /* ⚠ THE TEXT LANE IS CLOSED, and closed by the capability being ungrantable rather than by each
   * route being patched. These are the nine same-root findings, tested as unreachable. */
  for (const [method, path, label] of [
    ['GET', `/v1/instances/${idA}/texts/probedoc/files`, 'list a text\'s files (was drive:read)'],
    ['POST', `/v1/instances/${idA}/texts/probedoc/adopt`, 'adopt a text (was assignTexts)'],
    ['POST', `/v1/instances/${idA}/texts/probedoc/move`, 'move a text (was assignTexts)'],
    ['POST', `/v1/instances/${idA}/texts/probedoc/assignment/begin`, 'begin an assignment'],
  ]) {
    const res = await call(method, path, GUEST, method === 'GET' ? null : {});
    ok(res.status === 404, `⚠ ${label}: refused (got ${res.status})`);
  }

  /* ⚠ THE COMMAND GATE, and the pair is what makes it meaningful. The route is gated on
   * manageDevices — which this member HAS — so a single "commands are refused" assertion would pass
   * for the wrong reason. Text-scoped command types must be refused while device-scoped ones
   * succeed, through the same route, with the same credentials, in the same breath. */
  const deviceCmd = await call('POST', `/v1/instances/${idA}/command`, GUEST,
    { command: { type: 'changeSettings', settings: { vern: 'fau' } } });
  ok(deviceCmd.status === 200, `✅ a DEVICE command (changeSettings) is accepted (got ${deviceCmd.status})`);
  for (const type of ['assign', 'delete', 'uploadDelete', 'setDone']) {
    const res = await call('POST', `/v1/instances/${idA}/command`, GUEST,
      { command: { type, id: 'probedoc' } });
    ok(res.status === 404 && res.status !== deviceCmd.status,
       `⚠ a TEXT command (${type}) is refused through that same route (got ${res.status} vs ${deviceCmd.status})`);
  }

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

console.log('\n⚠ a grant carrying the LEGACY \'\' project sentinel is revoked too');
{
  /* ⚠ THE BUG THIS PINS MADE REVOCATION COSMETIC (2026-08-21 audit). member_key.project_id is a
   * DENORMALISATION written at grant time, and it is `''` on every grant minted before the project
   * existed — the v435 write path binds `String(proj.project_id || '')`. The first removal sweep
   * matched on that column, so it skipped exactly the OLDEST grants: the member was listed as
   * removed while still holding every wrapped Ki the ledger had handed them.
   *
   * The rig cannot mint a `''` grant through the API any more (instances have projects by now), so
   * the sentinel is reproduced the only way left — a grant written while the row still looks
   * unassigned — which is precisely the state the production rows are in. */
  const dev = await call('POST', '/v1/instances', OWNER, { type: '', nickname: 'Sentinel Device' });
  const sid = dev.json && dev.json.instance_id;
  ok(!!sid, 'created a device before it has been adopted into a project');

  /* Grant BEFORE the backfill adopts it: instance.project_id is NULL, so the worker stores '' . */
  const g = await call('POST', '/v1/researcher/keys', OWNER, {
    instance_id: sid, key_version: 1,
    grants: [{ researcher_id: FIXTURE.researcherId, wrapped_ki: 'OWNER-COPY' },
             { researcher_id: FIXTURE.outsiderId, wrapped_ki: 'GUEST-LEGACY-COPY' }],
  });
  ok(g.status === 200, `a grant is stored while the instance is unassigned (got ${g.status})`);

  await call('POST', `/v1/projects/${projectId}/members`, OWNER, {
    researcher_id: FIXTURE.outsiderId, caps: { manageDevices: true },
  });
  ok((await call('GET', `/v1/researcher/keys?instance=${sid}`, GUEST)).json.keys.length === 1,
     'the guest holds the legacy-sentinel key');

  const del = await call('DELETE', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.outsiderId });
  ok(del.status === 200, `the guest is removed (got ${del.status})`);
  ok((await call('GET', `/v1/researcher/keys?instance=${sid}`, GUEST)).json.keys.length === 0,
     '⚠⚠ and the SENTINEL grant went with them — resolved through `instance`, not through the denormalised column');
}

console.log('\n⚠ a grant can still be withdrawn AFTER the device is revoked');
{
  /* ⚠ authMember resolves instances with revoked=0, so requiring a live device made this
   * impossible — revoke the phone and the owner could no longer withdraw the grants held against
   * it, which is the one moment they most want to. `allowRevoked` is the narrow opt-in, and
   * check-project-scoping.sh enforces that every use of it is owner-only. */
  const dev = await call('POST', '/v1/instances', OWNER, { type: '', nickname: 'Doomed Device' });
  const did = dev.json && dev.json.instance_id;
  await call('POST', '/v1/researcher/keys', OWNER, {
    instance_id: did, key_version: 1,
    grants: [{ researcher_id: FIXTURE.researcherId, wrapped_ki: 'OWNER-COPY' },
             { researcher_id: FIXTURE.outsiderId, wrapped_ki: 'GUEST-COPY' }],
  });
  ok((await call('POST', `/v1/instances/${did}/revoke`, OWNER, {})).status === 200, 'the device is revoked');
  const del = await call('DELETE', '/v1/researcher/keys', OWNER,
    { instance_id: did, researcher_id: FIXTURE.outsiderId });
  ok(del.status === 200 && del.json.removed >= 1,
     `⚠ the grant is still withdrawable (got ${del.status}, removed ${del.json && del.json.removed}) — a revoked device is exactly when you want this`);
  const stranger = await call('DELETE', '/v1/researcher/keys', GUEST,
    { instance_id: did, researcher_id: FIXTURE.researcherId });
  ok(stranger.status === 404,
     '⚠ and allowRevoked did NOT open the door to anyone else — it is owner-only, enforced by the containment script');
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
    researcher_id: FIXTURE.outsiderId, caps: { manageDevices: true },
  });
  for (const [method, path, label] of [
    ['GET', '/v1/researcher/drive-estate', 'drive-estate'],
    ['POST', '/v1/researcher/drive-purge', 'drive-purge'],
    ['GET', '/v1/researcher/drive-file/any-file-id', 'drive-file'],
  ]) {
    const res = await call(method, path, GUEST, method === 'POST' ? {} : null);
    ok(res.status !== 200,
       `⚠ ${label}: a member gets ${res.status}, NOT the owner's estate — the route acts on the caller's own Drive`);
  }
  await call('DELETE', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.outsiderId });
}

console.log(fail ? `\n${fail} FAILED\n` : '\nPASS\n');
process.exit(fail ? 1 : 0);
