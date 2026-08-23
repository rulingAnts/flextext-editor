/* authMember — the ONE place that answers "may this researcher do this to this thing" (II.4).
 *
 * WHY IT IS TESTED THIS WAY. This is an auth boundary, and an auth boundary that is only
 * source-inspected is one whose HOLES are invisible: "denies a non-member" and "looks like it denies
 * a non-member" read identically in a grep. So it runs here against a real SQLite database through a
 * D1-shaped adapter, on the REAL DDL, with real request headers and real secret hashes.
 *
 * ⚠ Every assertion below is mutation-tested — the guard it names is neutered and the test must fail
 * BY THAT NAME. A permission test that passes when the permission is removed is worse than none: it
 * certifies the hole.
 *
 * Run: node test/project-authz.test.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const { authMember, validateCaps } = await import('../worker/src/v1.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

/* ⚠ EVERY METHOD IS ASYNC, matching real D1 — `.all()`, `.first()`, `.run()` and `.batch()` all
 * return Promises there. A synchronous stub would pass a missing `await` and would have rejected
 * this helper's legitimate `.first().catch(…)`. It did, until the stub was fixed rather than the
 * code. Do not "simplify" these back. */
function d1(db) {
  const stmt = (sql) => ({
    sql, args: [],
    bind(...a) { this.args = a; return this; },
    async all() { return { results: db.prepare(sql).all(...this.args) }; },
    async first() { return db.prepare(sql).all(...this.args)[0] || null; },
    async run() { const r = db.prepare(sql).run(...this.args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { DB: { prepare: stmt, async batch(l) { for (const s of l) db.prepare(s.sql).run(...s.args); return l.map(() => ({ success: true })); } } };
}

const TABLES = ['researcher', 'session', '"instance"', 'crowd_recorder', 'project', 'project_member'];
function freshDb(skip = []) {
  const schema = readFileSync(new URL('../worker/schema-current.sql', import.meta.url), 'utf8');
  const db = new DatabaseSync(':memory:');
  for (const t of TABLES) {
    if (skip.includes(t.replace(/"/g, ''))) continue;   // for the missing-table case
    const m = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(([\\s\\S]*?)\\n\\);`));
    if (!m) throw new Error('DDL not found for ' + t);
    db.exec(`CREATE TABLE IF NOT EXISTS ${t} (${m[1]}\n);`);
  }
  return db;
}

const hex = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))
  .map((b) => b.toString(16).padStart(2, '0')).join('');
const req = (id, secret) => ({ headers: { get: (k) => ({ 'x-fx-researcher': id, 'x-fx-secret': secret }[k] || null) } });

const OWNER = 'r-owner', MEMBER = 'r-member', STRANGER = 'r-stranger';
const PROJ = 'p-1', INST = 'i-1', OTHER_INST = 'i-2';
const NOW = 1787200000000;

async function seed(db, caps) {
  for (const id of [OWNER, MEMBER, STRANGER]) {
    db.prepare('INSERT INTO researcher (researcher_id, secret_hash, created_at) VALUES (?,?,?)')
      .run(id, await hex('sec-' + id), NOW);
  }
  db.prepare('INSERT INTO project (project_id, owner_id, name, created_at, drive_folder_id) VALUES (?,?,?,?,?)')
    .run(PROJ, OWNER, 'Fayu Text Corpus', NOW, 'folder-fayu');
  for (const i of [INST, OTHER_INST]) {
    db.prepare('INSERT INTO "instance" (instance_id, researcher_id, type, nickname, desired_rev, revoked, created_at, project_id) VALUES (?,?,?,?,0,0,?,?)')
      .run(i, OWNER, '', i, NOW, PROJ);
  }
  if (caps !== undefined) {
    db.prepare('INSERT INTO project_member (project_id, researcher_id, caps, added_at, added_by) VALUES (?,?,?,?,?)')
      .run(PROJ, MEMBER, caps, NOW, OWNER);
  }
}
const call = async (db, who, target, cap) => authMember(req(who, 'sec-' + who), d1(db), target, cap);

/* ---------------------------------------------------------------- */
console.log('\nidentity first: no credential is 401, a wrong one is not an authorization question at all');
{
  const db = freshDb(); await seed(db, '{}');
  ok(await authMember({ headers: { get: () => null } }, d1(db), { instance: INST }, null) === null,
     'no headers → null, so the route answers 401 exactly as authResearcher does');
  ok(await authMember(req(OWNER, 'wrong-secret'), d1(db), { instance: INST }, null) === null,
     '⚠ a bad secret is null, NOT { ok:false } — it must never reach the membership lookup');
}

console.log('\nthe owner passes everything');
{
  const db = freshDb(); await seed(db, '{}');
  const c = await call(db, OWNER, { instance: INST }, 'manageDevices');
  ok(c && c.ok && c.isOwner, 'owner is authorized');
  ok(c.see === undefined, '⚠ and carries NO visibility list — the project is the boundary, so there is nothing narrower to report');
  ok(c.owner.researcher_id === OWNER && c.caller.researcher_id === OWNER, 'owner and caller coincide');
  ok((await call(db, OWNER, { instance: INST }, 'cancelOthers')).ok, 'and a capability they have no row for');
}

console.log('\ncaller and owner are SEPARATE — the conflation this helper exists to prevent');
{
  const db = freshDb(); await seed(db, '{"manageDevices":true}');
  const c = await call(db, MEMBER, { instance: INST }, 'manageDevices');
  ok(c && c.ok && !c.isOwner, 'the member is authorized');
  ok(c.owner.researcher_id === OWNER,
     '⚠ owner is the PROJECT OWNER\'s full row — driveAccessToken(env, row) must act in their Drive, not the member\'s');
  ok(c.caller.researcher_id === MEMBER,
     '⚠ caller is the MEMBER — attribution (logApproval, wrapped_by, command authorship) must name who acted');
  ok(c.owner.secret_hash !== undefined,
     '⚠ and it is the WHOLE row (R2-5) — ~56 call sites read fields off it; a synthesized object breaks them silently');
}

console.log('\na non-member is denied, and denial is indistinguishable from absence');
{
  const db = freshDb(); await seed(db, '{}');
  const c = await call(db, STRANGER, { instance: INST }, null);
  ok(c && c.ok === false, 'a stranger is denied');
  const gone = await call(db, STRANGER, { project: 'p-does-not-exist' }, null);
  ok(gone && gone.ok === false && JSON.stringify(gone) === JSON.stringify(c),
     '⚠ a project that does not exist denies IDENTICALLY — otherwise the API is an oracle for which ids are real');
}

console.log('\ncapabilities are required, not assumed');
{
  const db = freshDb(); await seed(db, '{"assignTexts":true}');
  ok((await call(db, MEMBER, { instance: INST }, 'assignTexts')).ok, 'a capability they hold passes');
  ok((await call(db, MEMBER, { instance: INST }, 'manageDevices')).ok === false,
     '⚠ a capability they do NOT hold denies — membership is not authority');
  ok((await call(db, MEMBER, { instance: INST }, null)).ok, 'and membership alone suffices for a read');
}

console.log('\ndrive is a LEVEL, not a flag — manage implies read, read does not imply manage');
{
  /* ⚠ THESE CAPS CANNOT CURRENTLY BE WRITTEN — validateCaps refuses `drive` outright in v1 (the
   * audit's nine same-root findings all live behind it). The rows here are seeded straight into D1,
   * which is deliberate: authMember's LEVEL handling is kept and kept tested so that re-enabling the
   * capability is a one-line change to validateCaps rather than a re-derivation of what read and
   * manage mean. Defence in depth, and a smaller diff on the way back. */
  const db = freshDb(); await seed(db, '{"drive":"read"}');
  ok((await call(db, MEMBER, { project: PROJ }, 'drive:read')).ok, 'read grants drive:read');
  ok((await call(db, MEMBER, { project: PROJ }, 'drive:manage')).ok === false,
     '⚠ read does NOT grant drive:manage — trash and purge are the destructive half');
  const db2 = freshDb(); await seed(db2, '{"drive":"manage"}');
  ok((await call(db2, MEMBER, { project: PROJ }, 'drive:read')).ok, '⚠ manage implies read, or every list route needs two checks');
}

console.log('\nvalidateCaps: an owner must be TOLD, not silently granted nothing');
{
  /* ⚠ EXPORTED SO IT CAN BE TESTED HERE. It was reachable only through the rig, and a mutation that
   * accepted every unknown capability name survived the entire unit suite — the exact silent
   * widening this function exists to prevent, invisible to the fastest feedback loop anyone runs.
   *
   * authMember also DENIES on caps it cannot parse, so a bad record already fails safe at read time.
   * That is not a reason to skip validation: failing safe at READ time means the owner saved a
   * permission set that grants nothing, saw no error, and believes their assistant has access. The
   * write is the only moment a person is present to be told. */
  ok(validateCaps({}) !== null, 'an empty set is valid — a member with no capabilities is a real state');
  ok(validateCaps({ manageDevices: true, createInvites: true, cancelOthers: true }) !== null,
     'the three capabilities that survive v1 all pass together — device management is still a real grant');
  ok(validateCaps({ manageDevices: true }).manageDevices === true, 'a granted boolean survives');
  ok(validateCaps({ manageDevices: false }).manageDevices === undefined,
     'an ungranted one is ABSENT, not false — so unknown keys cannot accumulate meaning');
  ok(validateCaps({ createInvites: true }).createInvites === true, 'createInvites survives');

  for (const [bad, why] of [
    [null, 'null'],
    ['all', 'a string instead of an object'],
    [[], 'an array'],
    [{ manageDevices: 'yes' }, '⚠ a truthy STRING — the value that reads as a grant while never having been one'],
    [{ manageDevices: 1 }, 'a truthy NUMBER, same reason'],
    [{ drive: 'read' }, '⚠ drive READ — deferred in v1, and refused rather than dropped so an owner is never told they granted it'],
    [{ drive: 'manage' }, '⚠ drive MANAGE, likewise'],
    [{ drive: 'write' }, 'a drive level that never existed'],
    [{ assignTexts: true }, '⚠⚠ assignTexts — every one of the audit\'s nine same-root findings lives behind this and drive'],
    [{ assignTexts: false }, 'assignTexts even when FALSE — the name itself is refused, so a UI cannot round-trip it back'],
    [{ manageDevices: true, assignTexts: true }, 'a valid capability does not smuggle a deferred one in beside it'],
    [{ wipe: true }, '⚠ wipe — owner-only in v1, so accepting and ignoring it would tell an owner they had delegated it'],
    [{ forceRemove: true }, 'force-remove, same'],
    [{ madeUpCap: true }, '⚠ an unknown capability NAME — the mutation that survived the whole suite'],
    [{ see: 'all' }, '⚠ `see` — the per-device list was REMOVED, and silently dropping it would let a caller believe they had narrowed access'],
    [{ see: ['i-1'] }, 'a see LIST, likewise'],
  ]) {
    ok(validateCaps(bad) === null, `refused: ${why}`);
  }
}

console.log('\nthe PROJECT is the boundary — a capability reaches everything in it, and nothing outside');
{
  /* ⚠ THIS REPLACED A PER-DEVICE `see` LIST, removed the same night it was written (Seth,
   * 2026-08-20): *"let's not get device and text specific for access"* — because a narrower rule
   * could not be made TRUE. Device routes could honour it; Google Drive is addressed by FILE ID and
   * could not, so the list would have claimed to hide a device that stayed reachable through any
   * docId-routed Drive route. A checkbox the owner relies on and that does not hold is worse than no
   * checkbox.
   *
   * What is asserted now is the boundary Drive CAN enforce, and it still has two sides: a member
   * reaches every device in their project, and none outside it. Checking only the second half would
   * pass even if members could reach nothing at all. */
  const db = freshDb(); await seed(db, '{"manageDevices":true}');
  ok((await call(db, MEMBER, { instance: INST }, 'manageDevices')).ok, 'a member reaches a device in their project');
  ok((await call(db, MEMBER, { instance: OTHER_INST }, 'manageDevices')).ok,
     'and EVERY device in it — membership is not narrowed per device any more');

  // A second project, owned by someone else, holding its own device.
  db.prepare('INSERT INTO project (project_id, owner_id, name, created_at) VALUES (?,?,?,?)')
    .run('p-2', STRANGER, 'Dani Dictionary', NOW);
  db.prepare('INSERT INTO "instance" (instance_id, researcher_id, type, nickname, desired_rev, revoked, created_at, project_id) VALUES (?,?,?,?,0,0,?,?)')
    .run('i-other', STRANGER, '', 'Other Device', NOW, 'p-2');
  ok((await call(db, MEMBER, { instance: 'i-other' }, 'manageDevices')).ok === false,
     '⚠⚠ and is denied a device in ANOTHER project while holding the very same capability');
  ok((await call(db, OWNER, { instance: 'i-other' }, 'manageDevices')).ok === false,
     '⚠ so is their project OWNER — owning one project confers nothing in another');
}

console.log('\nthe DUAL-READ window: a NULL project is owner-only legacy access, never a member door');
{
  /* ⚠ THIS IS THE BRANCH THAT WOULD HAVE BROKEN PRODUCTION IF IT DENIED. 12 live rows had a NULL
   * project_id when this was written — researchers who had not signed in since the backfill. The
   * assertions come in pairs: the legacy owner keeps working, and NOBODY ELSE arrives through it. */
  const db = freshDb(); await seed(db, '{"manageDevices":true}');
  db.prepare('UPDATE "instance" SET project_id=NULL WHERE instance_id=?').run(INST);

  const legacy = await call(db, OWNER, { instance: INST }, 'manageDevices');
  ok(legacy && legacy.ok && legacy.isOwner,
     '⚠ the instance\'s own researcher_id still manages it — design-gap 4 pins that column as always equal to the owner');
  ok(legacy.legacy === true, 'and the context SAYS it took the legacy path rather than leaving it to be inferred');
  ok(legacy.project_id === '', 'with no project id invented for it');

  ok((await call(db, MEMBER, { instance: INST }, 'manageDevices')).ok === false,
     '⚠⚠ A MEMBER OF THE PROJECT IS STILL DENIED — the branch never consults project_member, so it cannot be a fall-through to wider access (I4)');
  ok((await call(db, STRANGER, { instance: INST }, null)).ok === false, 'and a stranger is denied');

  /* The capability argument must be ignored on this path rather than checked against {} — the legacy
   * owner had every power before Phase C and must not silently lose one. */
  for (const cap of ['assignTexts', 'createInvites', 'drive:manage', 'cancelOthers']) {
    ok((await call(db, OWNER, { instance: INST }, cap)).ok, `legacy owner keeps ${cap}, exactly as before Phase C`);
  }
}

console.log('\nfail closed on every unresolvable step (I4)');
{
  const db = freshDb(); await seed(db, '{}');
  db.prepare('UPDATE "instance" SET project_id=NULL WHERE instance_id=?').run(INST);
  ok((await call(db, MEMBER, { instance: INST }, null)).ok === false,
     'an instance with no project denies A MEMBER (the legacy branch above admits only its own researcher_id)');
  /* ⚠ A project row IS created with project_id='' here, on purpose. Without it the empty string
   * denies merely because the lookup finds nothing, and the explicit guard could be deleted with
   * every test still green — which is what the mutation run showed. With it, only the guard stands
   * between an unassigned row and a real membership. */
  db.prepare('UPDATE "instance" SET project_id=? WHERE instance_id=?').run('', INST);
  db.prepare('INSERT INTO project (project_id, owner_id, name, created_at) VALUES (?,?,?,?)').run('', OWNER, 'pseudo', NOW);
  db.prepare('INSERT INTO project_member (project_id, researcher_id, caps, added_at, added_by) VALUES (?,?,?,?,?)')
    .run('', MEMBER, '{}', NOW, OWNER);
  ok((await call(db, MEMBER, { instance: INST }, null)).ok === false,
     "⚠⚠ project_id='' is UNASSIGNED, not a project id — the member_key sentinel since v435. Reading it as an id would make every unassigned row a member of one shared pseudo-project");
  ok((await call(db, MEMBER, {}, null)).ok === false, 'an untyped target resolves nothing and denies');
  ok((await call(db, MEMBER, { instance: 'no-such-instance' }, null)).ok === false, 'an unknown instance denies');
}

console.log('\nunreadable caps DENY rather than defaulting to an empty grant');
{
  /* ⚠ TARGETED AT A PROJECT, NOT AN INSTANCE, AND WITH NO needCap — deliberately the ONLY path on
   * which caps validity is the sole possible reason to deny. The first version of this asked about
   * an instance, and a caps value that parses to {} grants no capability:
   * every assertion passed, and kept passing when the validity check was neutered. It certified a
   * guard it was not exercising. Found by mutation, which is the whole point of running them. */
  for (const bad of ['not json at all', '[]', 'null', '"all"', '42']) {
    const db = freshDb(); await seed(db, bad);
    const c = await call(db, MEMBER, { project: PROJ }, null);
    ok(c.ok === false, `caps ${JSON.stringify(bad)} denies — "grant nothing" must be a decision, not an accident`);
  }
  // The control: valid caps on that same path DO authorize, so the check above is not passing
  // simply because this path denies everything.
  const good = freshDb(); await seed(good, '{}');
  ok((await call(good, MEMBER, { project: PROJ }, null)).ok, 'and valid caps on the same path authorize');
}

console.log('\na revoked device is not a target');
{
  const db = freshDb(); await seed(db, '{"manageDevices":true}');
  db.prepare('UPDATE "instance" SET revoked=1 WHERE instance_id=?').run(INST);
  ok((await call(db, MEMBER, { instance: INST }, 'manageDevices')).ok === false, 'a revoked instance resolves no project and denies');
}

console.log('\na missing project_member table denies instead of 500ing');
{
  const db = freshDb(['project_member']); await seed(db, undefined);
  const c = await call(db, MEMBER, { instance: INST }, null);
  ok(c && c.ok === false, '⚠ degrades to "sharing does not work yet", never to a lockout or an open door');
  ok((await call(db, OWNER, { instance: INST }, 'manageDevices')).ok,
     '⚠ and the OWNER still works — the owner branch never touches that table');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
