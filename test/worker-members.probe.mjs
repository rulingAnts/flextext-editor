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
import { readFileSync } from 'node:fs';

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
   * in validateCaps' unit tests: the audit routes reachable through `drive` stay refused until
   * per-project Drive access is complete. `assignTexts` LEFT this list on 2026-08-27 (Seth: texts
   * and their status must be modifiable by every researcher on the project) — its nine routes are
   * authMember-gated and doc-scoped by the drive_object containment gates, and the capability's
   * live effectiveness is probed below instead of its refusal here. */
  /* ⚠ `cancelOthers` IS IN THIS LIST from 2026-08-24. It is deferred for a DIFFERENT reason from the
   * Drive caps — the cancel route is safe, but the own/other rule needs every command to name its
   * issuer and the pre-`by` backlog cannot. It was grantable and enforced nowhere, i.e. an owner
   * ticking it was told they had delegated something they had not. Refusing is the same discipline
   * the Drive caps get, for the same reason: the write is the only moment anyone is present to hear
   * "no". */
  for (const caps of [{ drive: 'read' }, { drive: 'manage' },
                      { manageDevices: true, drive: 'read' },
                      { cancelOthers: true }, { manageDevices: true, cancelOthers: true }]) {
    const res = await call('POST', `/v1/projects/${projectId}/members`, OWNER, {
      researcher_id: FIXTURE.outsiderId, caps,
    });
    ok(res.status === 400 && res.json && res.json.error === 'bad_caps',
       `⚠ refused: ${JSON.stringify(caps)} (got ${res.status} ${res.json && res.json.error})`);
  }
  ok((await call('GET', `/v1/projects/${projectId}/members`, OWNER)).json.members.length === 0,
     'and none of those attempts left a member row behind');
}

console.log('\n⚠⚠ removal takes a LEGACY-\'\' grant whose device has MOVED to another project (2026-08-23 sweep)');
{
  /* ⚠ THIS RUNS BEFORE ANY OTHER outsider removal ON PURPOSE. The seeded grant it checks
   * (member_key.project_id='' on FIXTURE.movedDeviceId, which sits in FIXTURE.movedProjectId) is
   * consumed by the FIRST removal of the outsider once the fix is in — so any later placement would
   * see it already gone and could not tell the fix from its absence.
   *
   * The gap: a grant minted while the device was unassigned carries the '' sentinel; once that device
   * is stamped into a DIFFERENT project than the one the member is removed from, the removal's snapshot
   * clause ('' != projectId) and its subquery (device now in the other project, neither this one nor
   * NULL) BOTH miss it. Before the third DELETE arm, the grant survived removal and GET keys — which
   * selects by researcher_id alone — kept handing it to the removed member. Neuter that arm in
   * worker/src/v1.js and the final assertion here fails by name. */
  /* ⚠⚠ MEASURED BY grants_removed, NOT BY READING THE KEY BACK, and the reason is a trap this test
   * fell into. Read-time scoping (2026-08-24) means GET /v1/researcher/keys already declines to serve
   * a grant on a device outside the caller's projects — which is exactly this grant. So the old
   * "guest can read it / now they cannot" pair became VACUOUS: it read 0 before the removal and 0
   * after, and passed while asserting nothing about whether the row was deleted at all.
   *
   * grants_removed is the DELETE's own count of rows it destroyed, so it measures the thing this test
   * is about — that revocation is an act rather than a UI state — and it is unaffected by whether the
   * read path would have served the row. Neuter the third ORed arm in worker/src/v1.js and this drops
   * to 0 and fails by name. */
  await call('POST', `/v1/projects/${projectId}/members`, OWNER, {
    researcher_id: FIXTURE.outsiderId, caps: { manageDevices: true },
  });
  const del = await call('DELETE', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.outsiderId });
  ok(del.status === 200, `the guest is removed (got ${del.status})`);
  ok(del.json && del.json.grants_removed >= 1,
     `⚠⚠ and the MOVED-device '' grant was DELETED (${del.json && del.json.grants_removed} row(s)) — the snapshot missed it (''≠id) and the subquery missed it (the device is in another project), so the third arm is what caught it`);
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
/* ⚠ IDENTITY FLOWS ONE WAY, and both directions are pinned. The OWNER sees who a member IS
 * (name/email/avatar joined onto the members list — Seth, 2026-08-27: "I have no info about the
 * coworker except the ID"), because the member handed them that ID deliberately. The MEMBER still
 * sees the owner as an opaque id (the assertion above) — being added to a project must not hand
 * out the owner's address. */
{
  const lst = await call('GET', `/v1/projects/${projectId}/members`, OWNER);
  const me = ((lst.json && lst.json.members) || []).find((x) => x.researcher_id === FIXTURE.outsiderId);
  ok(!!me && me.email === 'outsider@example.invalid',
     `the OWNER's members list carries the member's identity (email: ${me && me.email})`);
  ok(me && 'display_name' in me && 'avatar_url' in me, '...and the display fields ride along (empty-string when unset)');
  /* The grant-sweep's diff inputs (2026-08-27): which live devices this member already holds keys
   * for, and whether they even HAVE a published key to wrap to. Without these the owner could not
   * see the created-after-membership gap at all — GET /keys only ever shows the CALLER's grants. */
  ok(me && Array.isArray(me.granted), `the members list says which live devices each member holds grants for (${me && (me.granted || []).length} here)`);
  ok(me && me.pubkey_set === false,
     'and whether their key is published — honestly FALSE here (the fixture outsider never publishes one), which is exactly the state the sweep must report rather than wrap to');
}

console.log('\nTHE MEMBER-SIDE VIEW — the poll and the desired lane finally answer a member');
{
  /* GET /v1/researcher gains memberProjects (additive): each joined project with its LIVE devices
   * in the same shape `instances` uses. And the dual-lane desired route's researcher branch now
   * consults membership instead of raw owner-equality — a member polling a granted device got
   * not_found the first time a real member tried (2026-08-27, live). */
  const home = await call('GET', '/v1/researcher', GUEST);
  const mp = (home.json && home.json.memberProjects) || [];
  ok(home.status === 200 && mp.length === 1, `the member's own poll carries their joined project (${mp.length})`);
  ok(mp[0] && mp[0].project_id && mp[0].caps && Array.isArray(mp[0].instances),
     '...with caps and the project\'s live devices');
  ok((mp[0].instances || []).some((i) => i.instance_id === idA),
     '...including the device the capability tests act on');
  ok((mp[0].instances || []).every((i) => !i.revoked), 'revoked devices are excluded — the same line the keys route holds');
  const ownHome = await call('GET', '/v1/researcher', OWNER);
  ok(ownHome.json.memberProjects === undefined,
     '⚠ a researcher who is a member of nothing sees NO field at all — the poll is byte-identical for every current account');
  const dp = await call('GET', `/v1/instances/${idA}?since=-1`, GUEST);
  ok(dp.status === 200 || dp.status === 204,
     `⚠ the desired lane now answers a MEMBER (got ${dp.status}) — it was not_found for every member until today`);
  const outsiderPoll = await call('GET', `/v1/instances/${FIXTURE.movedDeviceId}?since=-1`, GUEST);
  ok(outsiderPoll.status === 404,
     `...while a device OUTSIDE their projects stays absence-shaped (got ${outsiderPoll.status})`);
}

console.log('\nEDITING permissions is EFFECTIVE — reduced caps refuse on the very next request');
{
  /* Seth, live-testing the new Change-permissions UI (2026-08-27): "I don't have an easy way to
   * test whether those permission settings are actually effective." This is that test, as the
   * round-trip the UI performs: the edit is the same INSERT OR REPLACE the add uses, and the caps
   * it stores must be the caps the very next request is judged by — no session, no cache, no lag. */
  // Widen first (the edit-as-INCREASE case), so both capabilities are demonstrably live…
  const widen = await call('POST', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.outsiderId, caps: { manageDevices: true, createInvites: true } });
  ok(widen.status === 200, `the owner widens the caps (got ${widen.status})`);
  ok((await call('POST', `/v1/instances/${idA}/rename`, GUEST, { nickname: 'Caps Loop 1' })).status === 200,
     'with manageDevices: rename succeeds');
  ok((await call('POST', `/v1/instances/${idA}/invite`, GUEST, {})).status === 200,
     'with createInvites: minting succeeds');
  // …then strip to nothing: both must refuse on the VERY NEXT request…
  const down = await call('POST', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.outsiderId, caps: {} });
  ok(down.status === 200, `the owner edits the caps DOWN to none (got ${down.status})`);
  ok((await call('POST', `/v1/instances/${idA}/rename`, GUEST, { nickname: 'Caps Loop 2' })).status === 404,
     '⚠⚠ the SAME rename now 404s — a reduced capability refuses immediately');
  ok((await call('POST', `/v1/instances/${idA}/invite`, GUEST, {})).status === 404,
     '⚠⚠ and so does minting — createInvites is gone the moment it was unticked');
  // …then restore the section's original grant, and the ability is back just as immediately.
  const up = await call('POST', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.outsiderId, caps: { manageDevices: true } });
  ok(up.status === 200, `the owner edits them back (got ${up.status})`);
  ok((await call('POST', `/v1/instances/${idA}/rename`, GUEST, { nickname: 'Caps Loop 3' })).status === 200,
     '...and the ability returns just as immediately — stoppable, restorable, never sticky');
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
  /* ⚠ `enc`, not a plaintext `settings` — the worker now refuses an unencrypted payload, and
   * pushCommand has always encrypted, so this is the shape a real client sends. */
  const deviceCmd = await call('POST', `/v1/instances/${idA}/command`, GUEST,
    { command: { type: 'changeSettings', enc: 'opaque-ciphertext' } });
  ok(deviceCmd.status === 200, `✅ a DEVICE command (changeSettings) is accepted (got ${deviceCmd.status})`);
  for (const type of ['assign', 'delete', 'uploadDelete', 'setDone']) {
    const res = await call('POST', `/v1/instances/${idA}/command`, GUEST,
      { command: { type, id: 'probedoc' } });
    ok(res.status === 404 && res.status !== deviceCmd.status,
       `⚠ a TEXT command (${type}) is refused through that same route (got ${res.status} vs ${deviceCmd.status})`);
  }

  ok((await call('POST', `/v1/instances/${idA}/installs/nope/wipe`, GUEST, {})).status === 404,
     'wipe stays owner-only whatever the member holds');

  /* ⚠ THE CAPABILITY IS LIVE, NOT JUST GRANTABLE (assignTexts un-deferred 2026-08-27). The same
   * text commands refused above must succeed the moment the cap is granted, through the same
   * route, same credentials — and go back to 404 when it is stripped. Grantable-but-dead was the
   * cancelOthers failure mode; this pins the opposite direction. */
  await call('POST', `/v1/projects/${projectId}/members`, OWNER, {
    researcher_id: FIXTURE.outsiderId, caps: { manageDevices: true, assignTexts: true },
  });
  for (const type of ['assign', 'delete', 'uploadDelete', 'setDone']) {
    const res = await call('POST', `/v1/instances/${idA}/command`, GUEST,
      { command: { type, id: 'probedoc' } });
    ok(res.status === 200, `⚠⚠ with assignTexts granted, ${type} is ACCEPTED (got ${res.status})`);
  }
  await call('POST', `/v1/projects/${projectId}/members`, OWNER, {
    researcher_id: FIXTURE.outsiderId, caps: { manageDevices: true },
  });
  const strippedCmd = await call('POST', `/v1/instances/${idA}/command`, GUEST,
    { command: { type: 'setDone', id: 'probedoc' } });
  ok(strippedCmd.status === 404, `and stripping the cap closes it again (got ${strippedCmd.status})`);
}

console.log('\n⚠⚠ a member device action is ATTRIBUTED to the MEMBER, not the owner');
{
  /* ⚠ THE WHOLE POINT OF ctx.caller vs ctx.owner, made observable. The member renamed idA above; the
   * owner reads the append-only log and must find that rename recorded against the MEMBER's email.
   * Log with ctx.owner instead — the drop-in-compatible mistake that passes every single-member test
   * — and the actor here is the owner's address, and this fails. Before 2026-08-24 these five actions
   * (rename, invite, revoke, approve, key) recorded NOTHING at all, so there was no actor to be
   * wrong; the assertion below would find no entry. */
  const log = await call('GET', '/v1/researcher/approvals?limit=50', OWNER);
  ok(log.status === 200, `the owner can read the access log (got ${log.status})`);
  const renames = (log.json.approvals || []).filter((e) => e.kind === 'device_renamed');
  ok(renames.length >= 1, `the member's rename was recorded at all (${renames.length}) — five member actions used to log nothing`);
  /* ⚠ TARGET THE MEMBER'S OWN RENAME BY ITS NEW NAME, not "any rename". The OWNER renames devices
   * elsewhere in this flow and those are CORRECTLY owner-attributed, so "no rename is owner-attributed"
   * would be wrong. The detail field of a device_renamed entry is the new nickname; the member set
   * 'Renamed By Member' above. */
  const mine = renames.find((e) => e.detail === 'Renamed By Member');
  ok(!!mine, `the member's specific rename ('Renamed By Member') is in the log`);
  ok(mine && mine.actor === FIXTURE.outsiderEmail,
     `⚠⚠ and it is attributed to the MEMBER (${mine && mine.actor}), not the owner — ctx.caller, not ctx.owner`);
  ok(mine && mine.actor !== FIXTURE.driveEmail,
     `⚠ conflating caller with owner would have named ${FIXTURE.driveEmail} here`);
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
  /* ⚠ THE READ PATH NO LONGER SERVES THIS GRANT EITHER, and that is correct rather than a
   * regression: the device is UNASSIGNED (project_id NULL), so it belongs to no project and no
   * membership can reach it — the project IS the boundary, and fail-closed is the reading invariant
   * I4 requires. It also means "guest can read it / now cannot" would assert nothing here, so this
   * measures the DELETE's own row count, like the moved-device case above. */
  const del = await call('DELETE', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.outsiderId });
  ok(del.status === 200, `the guest is removed (got ${del.status})`);
  ok(del.json && del.json.grants_removed >= 1,
     `⚠⚠ and the SENTINEL grant was DELETED (${del.json && del.json.grants_removed} row(s)) — resolved through \`instance\`, not through the denormalised column`);
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

  /* ⚠⚠ ...AND NOT THROUGH THE OTHER DOOR EITHER. Removing "the owner" as a member runs the member_key
   * DELETE with researcher_id = the owner, which would destroy the very copies the refusal above
   * protects — the same unrecoverable end, reached by a route that merely was not thinking about it.
   * The POST branch has always refused owner_is_not_a_member; DELETE did not, until the third ORed
   * arm (added 2026-08-23) widened what that statement reaches to the owner's own legacy-'' grants on
   * devices that have since been assigned. Both halves are asserted: the refusal AND the survival of
   * the key, because a refusal that still deleted something would pass a status-only check. */
  /* ⚠ The owner's copy here is the SEEDED '' -sentinel row, not one minted through the API. A grant
   * written via POST /v1/researcher/keys against this device is stamped with the device's REAL
   * project_id, which the third arm (project_id='') can never match — so an API-seeded version of
   * this assertion passes even with the guard removed. It did, until the mutation test caught it. */
  ok((await call('GET', `/v1/researcher/keys?instance=${FIXTURE.movedDeviceId}`, OWNER)).json.keys.length >= 1,
     'the owner holds a legacy-\'\' copy on the moved device — the state the third arm reaches');
  const selfRemove = await call('DELETE', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.researcherId });
  ok(selfRemove.status === 400 && selfRemove.json.error === 'owner_is_not_a_member',
     `⚠⚠ removing the OWNER as a member is refused (got ${selfRemove.status} ${selfRemove.json && selfRemove.json.error}) — DELETE now mirrors POST`);
  ok((await call('GET', `/v1/researcher/keys?instance=${FIXTURE.movedDeviceId}`, OWNER)).json.keys.length >= 1,
     '⚠⚠ and the owner STILL holds their key — wrap-to-owner survives the member-removal path, not just the revoke route');
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

console.log('\nthe desired lane does not leak whether an instance EXISTS or is REVOKED');
{
  /* ⚠ ONE authenticated caller used to get THREE distinguishable answers for an id they do not own:
   * 404 for a nonexistent id, 410 for a real instance since revoked, 403 for a real live one. That
   * is an oracle for the existence AND the revocation state of every device id anyone has ever seen
   * — an old invite link, a support screenshot, a project they were removed from. The assertion is
   * that all three cases now answer IDENTICALLY, which is why all three are asked. */
  const live = await call('GET', `/v1/instances/${idA}`, GUEST);
  const missing = await call('GET', '/v1/instances/00000000-0000-4000-8000-00000000dead', GUEST);
  const dev = await call('POST', '/v1/instances', OWNER, { type: '', nickname: 'Revoked Probe' });
  await call('POST', `/v1/instances/${dev.json.instance_id}/revoke`, OWNER, {});
  const revoked = await call('GET', `/v1/instances/${dev.json.instance_id}`, GUEST);

  ok(live.status === 404, `a REAL live instance the caller does not own answers 404 (got ${live.status})`);
  ok(missing.status === live.status && revoked.status === live.status,
     `⚠⚠ and a nonexistent id and a REVOKED one answer identically (${missing.status}/${live.status}/${revoked.status}) — otherwise existence and revocation state are readable`);
  ok(live.json && live.json.error === 'not_found', 'never `forbidden`, and never `revoked`, which is what leaked it');
}

console.log('\n⚠⚠ a member cannot repoint a device\'s BACKEND through changeSettings');
{
  /* THE SWEEP FINDING THAT DISPROVED THE CAPABILITY-DEFERRAL HEURISTIC. The rule written into
   * validateCaps was "every dangerous route is one where the member names a Drive file or text".
   * changeSettings names no Drive id at all: the worker validated cmd.type and nothing else, so
   *   { type:'changeSettings', settings:{ relayWorker:'https://…' } }
   * from a member holding only manageDevices repointed the device's whole backend — install
   * credentials on its next poll, every upload thereafter, and a fabricated desired lane answering
   * { wipe:true }, which sync.js honours before every gate. A WIPE, delegated by a capability, which
   * check-project-scoping.sh asserts cannot happen — bypassed without touching the wipe route.
   *
   * The worker CANNOT read settings (they are E2EE), so it cannot allow-list keys. What it CAN
   * enforce is the shape: pushCommand has always encrypted, so a plaintext payload is a shape no
   * legitimate client has ever sent. The device-side refusal of relayWorker is the other half. */
  await call('POST', `/v1/projects/${projectId}/members`, OWNER, {
    researcher_id: FIXTURE.outsiderId, caps: { manageDevices: true },
  });
  const attack = await call('POST', `/v1/instances/${idA}/command`, GUEST,
    { command: { type: 'changeSettings', settings: { relayWorker: 'https://evil.example' } } });
  ok(attack.status === 400 && attack.json && attack.json.error === 'payload_must_be_encrypted',
     `⚠⚠ a PLAINTEXT settings payload is refused (got ${attack.status} ${attack.json && attack.json.error})`);

  /* ⚠ And the refusal must be about the SHAPE, not about the key name — an attacker choosing a
   * different setting must hit the same wall, or the fix is a blocklist of one string. */
  const anyPlain = await call('POST', `/v1/instances/${idA}/command`, GUEST,
    { command: { type: 'changeSettings', settings: { vern: 'fau' } } });
  ok(anyPlain.status === 400 && anyPlain.json.error === 'payload_must_be_encrypted',
     'any plaintext settings payload is refused, not just the dangerous key — the check is on the shape');

  /* An ENCRYPTED command still goes through, so this did not simply break settings pushes. The rig
   * cannot produce real ciphertext, but `enc` is opaque to the worker by design — its presence is
   * the whole of what the worker checks. */
  const enc = await call('POST', `/v1/instances/${idA}/command`, GUEST,
    { command: { type: 'changeSettings', enc: 'opaque-ciphertext-the-worker-never-reads' } });
  ok(enc.status === 200, `✅ an ENCRYPTED changeSettings is still accepted (got ${enc.status}) — device management is not broken`);
  await call('DELETE', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.outsiderId });
}

console.log('\n⚠ a grant survives the device MOVING between projects, and removal still catches it');
{
  /* ⚠ THE SWEEP FOUND THIS INSIDE THE PREVIOUS FIX. instance.project_id is MUTABLE — /projects/assign
   * rewrites it when a container moves — so resolving grants through the CURRENT project misses one
   * minted while the device sat in the project the member is being removed from. Neither clause
   * fires, nothing else removes the row, and the response says grants_removed: 0 next to ok: true.
   * The rig has no Drive, so the move is simulated by asking whether BOTH match paths are present. */
  const src = readFileSync(new URL('../worker/src/v1.js', import.meta.url), 'utf8');
  ok(/DELETE FROM member_key WHERE researcher_id=\? AND \(project_id=\? OR instance_id IN \(/.test(src),
     '⚠ removal matches the stale project_id snapshot AND the live instance subquery — neither alone is sufficient');
}

console.log('\nkey delivery no longer makes instance ids ENUMERABLE');
{
  /* ⚠ THE ORACLE THIS CLOSES: the route decided ownership itself and answered 403 when the caller
   * was not the owner, while a nonexistent id answered not_found. Two different answers told a
   * caller which instance ids are REAL — and instance ids are the addressing for every device
   * route. The two cases must be indistinguishable.
   *
   * Asserting only "a stranger is refused" would pass with the 403 still in place, so the shape is
   * what is pinned, and both cases are asked in the same breath. */
  /* ⚠ THE GUEST MUST BE A MEMBER HERE, and the first version of this test forgot it — so
   * authMember returned { ok:false } and answered 404 before the ownership branch was ever reached.
   * The test passed, and passed with the 403 still in place: a mutation restoring the oracle changed
   * nothing. The leak lives in the gap between "member of this project" and "owner of it", so the
   * caller has to be standing IN that gap for the assertion to mean anything. */
  await call('POST', `/v1/projects/${projectId}/members`, OWNER, {
    researcher_id: FIXTURE.outsiderId, caps: { manageDevices: true },
  });
  const real = await call('POST', '/v1/researcher/keys', GUEST, {
    instance_id: idA, key_version: 1,
    grants: [{ researcher_id: FIXTURE.researcherId, wrapped_ki: 'X' }],
  });
  const fake = await call('POST', '/v1/researcher/keys', GUEST, {
    instance_id: 'no-such-instance-at-all', key_version: 1,
    grants: [{ researcher_id: FIXTURE.researcherId, wrapped_ki: 'X' }],
  });
  ok(real.status === 404, `a REAL instance owned by someone else answers 404 (got ${real.status})`);
  ok(real.status === fake.status && (real.json || {}).error === (fake.json || {}).error,
     `⚠⚠ and answers IDENTICALLY to an id that does not exist (${real.status}/${(real.json||{}).error} vs ${fake.status}/${(fake.json||{}).error}) — otherwise the API enumerates devices`);
  ok((real.json || {}).error !== 'forbidden', 'never `forbidden`, which is what leaked it');
  await call('DELETE', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.outsiderId });
}

console.log('\na member cannot mint an UNSCOPED textfile URL');
{
  /* ⚠ Redemption can only ask the precise revocation question — "still a member of the project this
   * INSTANCE belongs to" — when the token names an instance. An unscoped member-minted token could
   * only be checked against "a member of ANY project of this owner", so removing them from the
   * project the file belongs to would leave the URL alive on an unrelated membership. Minting is
   * refused rather than the check loosened.
   *
   * ⚠ Not directly reachable today — assignTexts is refused in v1, so no member can reach a mint
   * site at all. Pinned now because it becomes reachable the moment that capability returns, and
   * that is exactly when nobody will remember this. */
  const src = readFileSync(new URL('../worker/src/v1.js', import.meta.url), 'utf8');
  ok(/if \(!\(scope && scope\.instanceId\)\) return null;/.test(src),
     'mintTextfileUrl refuses to mint when a minter is recorded and no instance scope is given');
  ok(/if \(minterId && minterId !== researcherId\) \{/.test(src),
     'and the minter is still recorded only when it is NOT the Drive owner — owner tokens are untouched');
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

console.log('\n⚠⚠ a grant STOPS BEING SERVED when the device leaves the project — no removal event exists');
{
  /* ⚠ THE HOLE THIS CLOSES HAS NO DELETION PATH, which is why read-time scoping was the fix rather
   * than another cleanup. /projects/assign rewrites instance.project_id and never touches member_key,
   * so when a device MOVES to another project, a member of the project it LEFT keeps a grant that
   * nothing will ever delete — nobody was removed from anything, so there is no event to hang a
   * cleanup on. GET /v1/researcher/keys used to select on researcher_id alone, making the row's
   * existence the authorization; it now re-derives entitlement from where the device is NOW.
   *
   * FIXTURE.movedDeviceId is seeded into movedProjectId, and the guest is a member of `projectId`
   * only — so the guest is exactly "a member of some other project" with a live grant on it. */
  await call('POST', `/v1/projects/${projectId}/members`, OWNER, {
    researcher_id: FIXTURE.outsiderId, caps: { manageDevices: true },
  });
  /* ⚠⚠ THE GRANT IS MINTED HERE RATHER THAN RELIED ON FROM THE FIXTURE, and that is not tidiness.
   * The seeded one is consumed by the member-removal test above, so this section originally read 0
   * whether or not the scoping existed — it PASSED WITH THE SCOPING REMOVED, i.e. asserted nothing.
   * The mutation test is the only reason that was noticed, and it is the second time in this file an
   * order dependency made a real assertion vacuous. Minting a fresh grant makes the check independent
   * of what ran before it. */
  const regrant = await call('POST', '/v1/researcher/keys', OWNER, {
    instance_id: FIXTURE.movedDeviceId, key_version: 2,
    grants: [{ researcher_id: FIXTURE.researcherId, wrapped_ki: 'OWNER-COPY-V2' },
             { researcher_id: FIXTURE.outsiderId, wrapped_ki: 'GUEST-COPY-V2' }],
  });
  ok(regrant.status === 200, `a live grant exists on the moved device (got ${regrant.status})`);
  const seen = await call('GET', `/v1/researcher/keys?instance=${FIXTURE.movedDeviceId}`, GUEST);
  ok(seen.status === 200,
     `the grant row EXISTS and the request succeeds (got ${seen.status})`);
  ok((seen.json.keys || []).length === 0,
     '⚠⚠ but it is NOT SERVED — the device is in a project this member does not belong to, and no removal ever happened');
}

console.log('\n⚠⚠ a REVOKED device\'s grant stops being served to the MEMBER — the owner keeps theirs');
{
  /* Found LIVE (2026-08-27): Seth revoked the shared test device mid-session, and the member seat
   * kept receiving its wrapped key on every poll. Same read-time-scoping reasoning as the moved
   * device above — revocation deletes no member_key rows, so the SELECT must re-derive entitlement
   * and a dead device must stop qualifying FOR MEMBERS. The OWNER's own copies must keep serving:
   * owner sovereignty says they can always see every key, and withdrawing grants from a revoked
   * device (allowRevoked on the DELETE route) presumes they can still enumerate them. */
  const d = await call('POST', '/v1/instances', OWNER, { type: '', nickname: 'Revoked Grant Device' });
  const rid = d.json && d.json.instance_id;
  ok(!!rid, 'a fresh device exists');
  await call('POST', '/v1/researcher/admin/backfill-projects', OWNER, {});   // adopt it into the member's project
  const g = await call('POST', '/v1/researcher/keys', OWNER, {
    instance_id: rid,
    grants: [{ researcher_id: FIXTURE.researcherId, wrapped_ki: 'OWNER-RV' },
             { researcher_id: FIXTURE.outsiderId, wrapped_ki: 'GUEST-RV' }],
  });
  ok(g.status === 200, `granted while the device lives (got ${g.status})`);
  const before = await call('GET', `/v1/researcher/keys?instance=${rid}`, GUEST);
  ok((before.json.keys || []).length === 1, 'served to the member while the device lives');
  const rv = await call('POST', `/v1/instances/${rid}/revoke`, OWNER, {});
  ok(rv.status === 200, `the owner revokes the device (got ${rv.status})`);
  const after = await call('GET', `/v1/researcher/keys?instance=${rid}`, GUEST);
  ok((after.json.keys || []).length === 0,
     '⚠⚠ the MEMBER is no longer served the revoked device\'s key');
  const own = await call('GET', `/v1/researcher/keys?instance=${rid}`, OWNER);
  ok((own.json.keys || []).length >= 1,
     '⚠ while the OWNER still is — wrap-to-owner copies survive revocation (owner sovereignty)');

  /* The other half, or the assertion above would pass just as well if the route returned nothing to
   * anyone: the OWNER still gets their own copy of the very same device's key. */
  const mine = await call('GET', `/v1/researcher/keys?instance=${FIXTURE.movedDeviceId}`, OWNER);
  ok((mine.json.keys || []).length >= 1,
     '⚠ while the OWNER still receives it — scoping must not cost the owner access to their own device');
  await call('DELETE', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.outsiderId });
}

console.log('\n⚠⚠ a claim hands the device NO researcher identity — the pair code is the recognition mechanism');
{
  /* Reversed deliberately (Seth, 2026-08-27): a paired field device can end up in untrusted hands,
   * and it must not carry — or ever have been handed — the identity of the people running the
   * project. The claim response therefore carries no name, email or avatar, whoever minted the
   * invite; the PAIR CODE on both screens is what vouches for the link. A member with createInvites
   * may mint (idA is in their project), which this block also keeps pinned. */
  await call('POST', `/v1/projects/${projectId}/members`, OWNER, {
    researcher_id: FIXTURE.outsiderId, caps: { manageDevices: true, createInvites: true },
  });
  const inv = await call('POST', `/v1/instances/${idA}/invite`, GUEST, {});
  ok(inv.status === 200 && inv.json && inv.json.invite_id,
     `the member mints an invite for a device in their project (got ${inv.status})`);
  const memberInstallId = '00000000-0000-4000-8000-00000000c1c1';
  const claim = await call('POST', `/v1/invites/${inv.json.invite_id}/claim`,
    { 'x-fx-invite-secret': inv.json.secret },
    { install_id: memberInstallId, install_secret: 'member-invite-probe-secret', pubkey: 'SPKI-PROBE' });
  ok(claim.status === 200, `the device claims it (got ${claim.status})`);
  ok(claim.json && claim.json.pair_code && String(claim.json.pair_code).length > 0,
     'the claim carries the pair code — the one thing the two screens match');
  const leaked = JSON.stringify(claim.json || {});
  ok(!('researcher' in (claim.json || {})),
     '⚠⚠ and NO researcher object — a device out of the team’s control must not hold who runs the project');
  ok(!leaked.includes(FIXTURE.outsiderEmail) && !leaked.includes(FIXTURE.driveEmail),
     '⚠⚠ no email of ANY researcher appears anywhere in the claim response');
  // the idempotent-retry path answers from a different branch — it must be identity-free too
  const retry = await call('POST', `/v1/invites/${inv.json.invite_id}/claim`,
    { 'x-fx-invite-secret': inv.json.secret },
    { install_id: memberInstallId, install_secret: 'member-invite-probe-secret', pubkey: 'SPKI-PROBE' });
  ok(retry.status === 200 && !('researcher' in (retry.json || {}))
     && !JSON.stringify(retry.json || {}).includes(FIXTURE.driveEmail),
     `the lost-response retry is identity-free the same way (got ${retry.status})`);
}

console.log('\n⚠⚠ a member with manageDevices CREATES a device inside the shared project — and bootstraps its keys ONCE');
{
  /* The device is born the OWNER's (researcher_id = owner), in the project, and the member delivers
   * the initial key set through the bootstrap door: allowed only while the instance has ZERO key
   * rows, and only with the owner's wrap in the set. Every arm here is a probe of a distinct rule —
   * weaken one and its line names it. */
  await call('POST', `/v1/projects/${projectId}/members`, OWNER, {
    researcher_id: FIXTURE.outsiderId, caps: { manageDevices: true, createInvites: true },
  });
  const made = await call('POST', `/v1/projects/${projectId}/instances`, GUEST, { nickname: 'Member Made' });
  ok(made.status === 200 && made.json && made.json.instance_id,
     `member creates a device in the shared project (got ${made.status})`);
  ok(made.json && made.json.owner_id === FIXTURE.researcherId,
     'the response names the project OWNER — the wrap-to-owner target');
  const mid = made.json && made.json.instance_id;
  const ownHome = await call('GET', '/v1/researcher', OWNER);
  ok(((ownHome.json && ownHome.json.instances) || []).some((x) => x.instance_id === mid),
     "the device is the OWNER's: it rides the owner's own poll like any other");
  const noOwner = await call('POST', '/v1/researcher/keys', GUEST,
    { instance_id: mid, grants: [{ researcher_id: FIXTURE.outsiderId, wrapped_ki: 'W-SELF' }] });
  ok(noOwner.status === 400 && noOwner.json && noOwner.json.error === 'owner_grant_required',
     `bootstrap WITHOUT the owner wrap is refused (got ${noOwner.status} ${noOwner.json && noOwner.json.error})`);
  const boot = await call('POST', '/v1/researcher/keys', GUEST, {
    instance_id: mid, grants: [
      { researcher_id: FIXTURE.researcherId, wrapped_ki: 'W-OWNER' },
      { researcher_id: FIXTURE.outsiderId, wrapped_ki: 'W-SELF' },
    ],
  });
  ok(boot.status === 200 && boot.json && boot.json.stored === 2,
     `bootstrap WITH the owner wrap lands both rows (got ${boot.status}, stored ${boot.json && boot.json.stored})`);
  const again = await call('POST', '/v1/researcher/keys', GUEST, {
    instance_id: mid, grants: [
      { researcher_id: FIXTURE.researcherId, wrapped_ki: 'W-OWNER-EVIL' },
      { researcher_id: FIXTURE.outsiderId, wrapped_ki: 'W-SELF-EVIL' },
    ],
  });
  ok(again.status === 404,
     `⚠⚠ the door is ONE-SHOT: a second member write is refused once any key row exists (got ${again.status})`);
  const ownerRewrite = await call('POST', '/v1/researcher/keys', OWNER, {
    instance_id: mid, grants: [{ researcher_id: FIXTURE.researcherId, wrapped_ki: 'W-OWNER-2' }],
  });
  ok(ownerRewrite.status === 200, `the OWNER may still rewrite grants at any time (got ${ownerRewrite.status})`);
  // strip the cap: creation and bootstrap both close
  await call('POST', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.outsiderId, caps: { createInvites: true } });
  const noCap = await call('POST', `/v1/projects/${projectId}/instances`, GUEST, { nickname: 'No Cap' });
  ok(noCap.status === 404, `without manageDevices, creation is the uniform 404 (got ${noCap.status})`);
  await call('DELETE', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.outsiderId });
  const gone = await call('POST', `/v1/projects/${projectId}/instances`, GUEST, { nickname: 'Not A Member' });
  ok(gone.status === 404, `a non-member gets the same 404 (got ${gone.status})`);
  // leave no husk behind: the fixture DB is reused across probe runs
  await call('POST', `/v1/instances/${mid}/revoke`, OWNER, {});
}

console.log('\n⚠ a changeSettings pushed by ONE researcher rides the desired lane to EVERY keyed researcher');
{
  /* The per-researcher prefill snapshot is Kr-encrypted and invisible across seats BY DESIGN; the
   * cross-seat truth is the device's own desired lane, whose changeSettings payloads are encrypted
   * under Ki — the very key project sharing grants. The client reads it as a fallback
   * (getInstanceSettings, v457); this pins the server half: the command a member needs is actually
   * IN the member-authorized read. Ciphertext is opaque to the worker, so a placeholder enc object
   * stands in for a real one — the crypto half is exercised by the client end to end. */
  await call('POST', `/v1/projects/${projectId}/members`, OWNER, {
    researcher_id: FIXTURE.outsiderId, caps: { manageDevices: true },
  });
  const push = await call('POST', `/v1/instances/${idA}/command`, OWNER,
    { command: { type: 'changeSettings', enc: { v: 1, iv: 'UFJPQkUtSVY', ct: 'UFJPQkUtQ1Q' } } });
  ok(push.status === 200, `the owner pushes a changeSettings command (got ${push.status})`);
  const lane = await call('GET', `/v1/instances/${idA}?since=-1`, GUEST);
  const cmds = (lane.json && lane.json.commands) || [];
  const cs = cmds.filter((c) => c && c.type === 'changeSettings');
  ok(lane.status === 200 && cs.length > 0 && !!cs[cs.length - 1].enc,
     `the MEMBER's desired-lane read carries it, enc intact (got ${lane.status}, ${cs.length} changeSettings)`);
  await call('DELETE', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.outsiderId });
}

console.log('\n⚠⚠ PHASE-4 BLOCKER #1 — a member cannot mint a streaming URL for a file it does not own');
{
  /* THE HOLE THIS CLOSES: the routes authorize the DOC, then took audioFileId / flextextFileId /
   * extractFromZipId from the body verbatim. A member with assignTexts could name ANY app-created
   * file in the owner's Drive — another project, the Unassigned pile, a crowd submission — and get
   * back a 90-day URL minted under the owner's authority.
   *
   * ⚠ THIS IS A SERVER-SIDE PROOF ON PURPOSE. It speaks raw HTTP with the member's own credentials
   * and no browser, so nothing here can be explained by a client-side gate, a hidden button or a
   * CORS rule — none of which is a security boundary (any client may send any Origin).
   *
   * ⚠ WHAT THE HERMETIC RIG CAN AND CANNOT SHOW: with no Google behind it, the parent-walk cannot
   * succeed, so this proves the DENIAL half (fail-closed) and that the OWNER path is untouched. The
   * positive case — a legitimate file under the doc's folder still mints — needs live Drive and is
   * verified on staging. Stated rather than papered over: a test that cannot see one half should
   * say which half. */
  await call('POST', `/v1/projects/${projectId}/members`, OWNER, {
    researcher_id: FIXTURE.outsiderId, caps: { manageDevices: true, assignTexts: true },
  });
  const capsBack = await call('GET', `/v1/projects/${projectId}/members`, OWNER);
  const mrow = ((capsBack.json && capsBack.json.members) || []).find((x) => x.researcher_id === FIXTURE.outsiderId);
  ok(mrow && mrow.caps && mrow.caps.assignTexts === true,
     'assignTexts is grantable since v456 (this whole block is why that is now safe)');

  const FOREIGN = '1ForeignFileIdFromAnotherProject_AAAA';
  const finishAsMember = await call('POST', `/v1/instances/${idA}/texts/probe-doc-b1/assignment/finish`, GUEST,
    { audioFileId: FOREIGN, ttlDays: 1 });
  ok(finishAsMember.status === 404,
     `⚠⚠ member finish with an unverifiable file id is refused (got ${finishAsMember.status}) — and 404, so it leaks nothing about whether the file exists`);
  ok(!(finishAsMember.json && finishAsMember.json.audioUrl),
     'and no URL comes back with the refusal');

  const finishAsOwner = await call('POST', `/v1/instances/${idA}/texts/probe-doc-b1/assignment/finish`, OWNER,
    { audioFileId: FOREIGN, ttlDays: 1 });
  ok(finishAsOwner.status === 200 && finishAsOwner.json && finishAsOwner.json.audioUrl,
     `⚠ the OWNER path is byte-identical — their own files in their own Drive, no new round trip (got ${finishAsOwner.status})`);

  /* ⚠ HONEST ABOUT WHICH GATE FIRES. `finish` uses doc-gate mode 'create', so an unknown docId
   * passes it and the request really does reach the file-id check above — that arm tests the fix.
   * `adopt` and `move` use the STRICT doc mode, so a member is refused at the DOC gate first and
   * never reaches their file-id check on this rig. Asserting "404, therefore the file-id gate
   * works" would be a test passing for the wrong reason — the exact species of false pass this
   * repo has been bitten by twice (the nickname source-string pin, the PEM rule). So: assert what
   * is actually being proven, and let the build guard
   * (check-project-scoping.sh: "every member-reachable mint verifies its caller-supplied file
   * ids (3 site(s))") hold the line for those two routes, with staging proving them live. */
  for (const [route, body] of [
    [`/v1/instances/${idA}/texts/probe-doc-b1/adopt`, { audioFileId: FOREIGN }],
    [`/v1/instances/${idA}/texts/probe-doc-b1/move`, { to: idB, flextextFileId: FOREIGN }],
  ]) {
    const res = await call('POST', route, GUEST, body);
    ok(res.status === 404 && !(res.json && (res.json.audioUrl || res.json.flextextUrl)),
       `${route.split('/').pop()}: a member gets 404 with no URL — at the DOC gate here, not the file-id gate (got ${res.status})`);
  }
  await call('DELETE', `/v1/projects/${projectId}/members`, OWNER, { researcher_id: FIXTURE.outsiderId });
}

console.log('\n⚠⚠ THE TOKEN EPOCH — a remote wipe withdraws streaming URLs, and an untouched device is unaffected');
{
  /* The gap this closes was verified against PRODUCTION on 2026-08-28: after a remote wipe, and
   * after an install revoke, a token minted for that device still authorised. Redemption's only
   * device check was `instance.revoked=0`, which exactly one route ever sets.
   *
   * ⚠ THE SECOND ASSERTION MATTERS AS MUCH AS THE FIRST. The primary user base is offline for long
   * stretches — Seth: "I don't want someone out in the bush for six months coming back to town and
   * finding out their device is unpaired". So an instance nobody has touched must keep serving its
   * tokens exactly as before. The epoch is stamped ONLY by an explicit researcher action, never by
   * time or silence, and this pins that. */
  const mk = async (nick) => {
    const d = await call('POST', '/v1/instances', OWNER, { type: '', nickname: nick });
    const iid = d.json.instance_id;
    const inv = await call('POST', `/v1/instances/${iid}/invite`, OWNER, {});
    const install = '00000000-0000-4000-8000-' + String(Date.now()).slice(-12);
    await call('POST', `/v1/invites/${inv.json.invite_id}/claim`, { 'x-fx-invite-secret': inv.json.secret },
      { install_id: install, install_secret: 'epoch-probe', pubkey: 'SPKI-PROBE' });
    await call('POST', `/v1/instances/${iid}/installs/${install}/approve`, OWNER, { pubkey: 'SPKI-PROBE' });
    const fin = await call('POST', `/v1/instances/${iid}/texts/epoch-doc/assignment/finish`, OWNER,
      { audioFileId: '1EpochProbeFile', ttlDays: 1 });
    return { iid, install, url: fin.json && fin.json.audioUrl };
  };
  const redeem = async (url) => (await fetch(url)).status;

  const victim = await mk('EpochVictim');
  const bystander = await mk('EpochBystander');
  ok(!!victim.url && !!bystander.url, 'both probe devices minted a scoped streaming URL');

  const before = await redeem(victim.url);
  /* The rig has no Google behind it, so a token that AUTHORISES fails at the Drive fetch (404/5xx)
   * while a REFUSED one is 401/410. If the fixture owner has no Drive credentials at all the two
   * collapse and this arm cannot speak — say so rather than asserting something it did not test. */
  if (before === 401 || before === 410) {
    ok(true, `⚠ SKIPPED on this rig: the fixture owner has no Drive credential, so authorised and refused both answer ${before}. The production run on 2026-08-28 covered this.`);
  } else {
    ok(true, `baseline: an untouched device's token authorises (got ${before})`);
    await call('POST', `/v1/instances/${victim.iid}/installs/${victim.install}/wipe`, OWNER, {});
    const afterWipe = await redeem(victim.url);
    ok(afterWipe === 410, `⚠⚠ after a REMOTE WIPE the same URL is refused (got ${afterWipe}, want 410)`);
    const bystanderAfter = await redeem(bystander.url);
    ok(bystanderAfter === before,
       `⚠ and the device nobody touched is UNAFFECTED (got ${bystanderAfter}, want ${before}) — silence is not a signal`);
  }
  for (const v of [victim, bystander]) await call('POST', `/v1/instances/${v.iid}/revoke`, OWNER, {});
}

console.log(fail ? `\n${fail} FAILED\n` : '\nPASS\n');
process.exit(fail ? 1 : 0);
