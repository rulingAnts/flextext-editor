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
  /* ⚠ THE STAND-IN FOR "a capability they hold" MUST BE ONE THAT IS STILL GRANTABLE, and the set has
   * shrunk twice. assignTexts and drive are refused at READ time as well as write time, so a row
   * carrying either grants nothing; `cancelOthers` joined them on 2026-08-24 (it was grantable but
   * enforced nowhere, which told an owner they had delegated something they had not). Using any
   * deferred name here would assert the opposite of the deferral — the row would be DENIED WHOLE and
   * this test would fail for a reason that has nothing to do with what it is checking.
   * That leaves manageDevices and createInvites, so: holds createInvites, lacks manageDevices. */
  const db = freshDb(); await seed(db, '{"createInvites":true}');
  ok((await call(db, MEMBER, { instance: INST }, 'createInvites')).ok, 'a capability they hold passes');
  ok((await call(db, MEMBER, { instance: INST }, 'manageDevices')).ok === false,
     '⚠ a capability they do NOT hold denies — membership is not authority');
  ok((await call(db, MEMBER, { instance: INST }, null)).ok, 'and membership alone suffices for a read');
}

console.log('\ndrive is grantable as READ ONLY — and a stored value that is not is refused');
{
  /* ⚠ THIS BLOCK ONCE ASSERTED THE OPPOSITE OF THE SHIPPED DESIGN, and that is the lesson worth
   * recording. It was written while `assignTexts` and `drive` were BOTH deferred, and it pinned that
   * deferral behaviourally. Both were deliberately un-deferred (assignTexts v456, drive v468) and
   * this file was not revisited, so the branch's HEADLINE capability feature had its dedicated
   * authorization test asserting that the feature does not work — six red assertions that a reader
   * would reasonably have read as "sharing is broken" rather than "this test is stale".
   *
   * A capability test that disagrees with the code is worse than no test: it is a standing claim, in
   * the suite, that the shipped behaviour is a bug. */
  const src = readFileSync(new URL('../worker/src/v1.js', import.meta.url), 'utf8');
  ok(/if \(raw\.drive !== 'read'\) return null;/.test(src),
     'validateCaps WRITES drive:read and nothing else — manage is refused, not downgraded');
  ok(/caps\.drive !== undefined && caps\.drive !== 'read'/.test(src),
     '⚠ and authMember REFUSES TO HONOUR a stored value it would not have written (v480)');

  /* The behavioural half, seeded straight into D1 — the only way to ask "what if the row is already
   * there?", which is the question a write-time filter cannot answer about itself. */
  {
    const db = freshDb(); await seed(db, '{"drive":"read"}');
    ok((await call(db, MEMBER, { project: PROJ }, 'drive:read')).ok === true,
       'a stored drive:read GRANTS drive:read — the un-deferred capability actually works');
  }
  {
    const db = freshDb(); await seed(db, '{"drive":"manage"}');
    ok((await call(db, MEMBER, { project: PROJ }, 'drive:read')).ok === false,
       '⚠ but a stored drive:manage grants NOTHING — refused at read time, not silently downgraded');
  }
  {
    const db = freshDb(); await seed(db, '{"manageDevices":true,"drive":"manage"}');
    ok((await call(db, MEMBER, { project: PROJ }, 'manageDevices')).ok === false,
       '⚠⚠ and the legitimate manageDevices in that row is refused too — poisoned, not filtered');
  }
  {
    const db = freshDb(); await seed(db, '{"drive":"read"}');
    ok((await call(db, MEMBER, { project: PROJ }, 'drive:manage')).ok === false,
       'drive:manage is never delegable to a member, whatever the row says');
  }
}

console.log('\nthe UN-deferred capabilities are honoured; only a DEFERRED one poisons the record');
{
  /* The read-time refusal is still the point of this section — the hole it closed was real: deferral
   * was implemented ONLY in validateCaps, a WRITE-time filter authMember never calls, so a row that
   * already contained the key would have been honoured. What changed is WHICH key is deferred:
   * DEFERRED_CAPS is now ['cancelOthers'] alone. */
  for (const caps of ['{"assignTexts":true}', '{"manageDevices":true}',
                      '{"manageDevices":true,"assignTexts":true}', '{"createInvites":true}']) {
    const db = freshDb(); await seed(db, caps);
    const r = await call(db, MEMBER, { instance: INST }, null);
    ok(r.ok === true, `a stored ${caps} is HONOURED (ok=${r.ok})`);
  }
  {
    const db = freshDb(); await seed(db, '{"assignTexts":true}');
    ok((await call(db, MEMBER, { instance: INST }, 'assignTexts')).ok === true,
       '⚠ assignTexts satisfies an assignTexts requirement — the v456 un-deferral, tested behaviourally');
    ok((await call(db, MEMBER, { instance: INST }, 'manageDevices')).ok === false,
       '...and does NOT satisfy manageDevices — the two grants stay distinct');
  }
  {
    const db = freshDb(); await seed(db, '{"manageDevices":true,"cancelOthers":true}');
    ok((await call(db, MEMBER, { instance: INST }, 'manageDevices')).ok === false,
       '⚠⚠ a stored DEFERRED cancelOthers still poisons the whole record, at READ time');
  }

  // The clean row still works, so this did not simply deny every member.
  const good = freshDb(); await seed(good, '{"manageDevices":true}');
  ok((await call(good, MEMBER, { instance: INST }, 'manageDevices')).ok,
     'a clean row is unaffected — device management still works');
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
