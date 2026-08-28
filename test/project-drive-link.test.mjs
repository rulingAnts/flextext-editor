/* THE PROJECT ⇄ DRIVE LINK, and the operator/owner rename that had to precede it.
 *
 * WHY THIS EXISTS. Phase C authorizes every route by the caller's PROJECT grants, and those grants
 * live in D1 (`project_member`, `member_key`, `instance.project_id`). But the Drive routes — the
 * half II.5c calls dangerous, because they walk the owner's entire estate — can only be scoped by
 * FOLDER PARENTAGE (R2-1). Until the D1 project row points at a Drive folder, "which folders belong
 * to the project this member may see" is a question the worker cannot ask, so the most important
 * scoping rule in the design is inexpressible.
 *
 * ⚠ AND THE RENAME IS NOT COSMETIC. `isOwner()` asked "is this email in ALLOWED_RESEARCHERS" — a
 * DEPLOYMENT question. `project.owner_id` is a DATA question about one project. Conflating them is
 * a privilege bug in both directions, and II.0.9 requires the rename BEFORE the word "owner"
 * appears in project code.
 *
 * Run: node test/project-drive-link.test.mjs
 */
import { readFileSync } from 'node:fs';
const read = (r) => readFileSync(new URL(r, import.meta.url), 'utf8');
const worker = read('../worker/src/v1.js');
const mig = read('../worker/migrate-project-drive-link.sql');
const schema = read('../worker/schema-current.sql');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

console.log('\nthe operator/owner rename is complete and did not change the wire');
ok(/function isOperator\(email, env\)/.test(worker), 'isOperator exists');
ok(!/\bisOwner\s*\(/.test(worker), '⚠ and isOwner is GONE — a surviving call site is the confusion this prevents');
ok(/is_owner: operator/.test(worker),
   '⚠ the RESPONSE KEY is still is_owner — researcher.js reads v.is_owner in two places');
ok(/error: 'not_owner'/.test(worker),
   '⚠ and the wire error value is unchanged — renaming a response string for tidiness is a compat risk for nothing');
ok(/isApproved\(r, env\)[\s\S]{0,120}?isOperator\(/.test(worker), 'isApproved delegates to the renamed helper');

console.log('\nthe migration is additive and nullable, which is what lets it ship first');
ok(/ALTER TABLE project ADD COLUMN drive_folder_id TEXT;/.test(mig), 'one nullable column');
ok(!/NOT NULL/.test(mig.split('ALTER TABLE')[1] || ''),
   '⚠ NOT NULL is absent — a project with no resolved Drive folder is a REAL state, not an error');
ok(!/DROP|CREATE TABLE|DELETE /.test(mig.replace(/--.*$/gm, '')),
   'no rebuild — R2-6 forbids table rebuilds outright');
ok(/drive_folder_id TEXT/.test(schema), 'schema-current records it');

console.log('\nthe backfill resolves the folder, and survives not being able to');
{
  const fn = worker.match(/async function backfillProjectsFor[\s\S]*?\n\}/)[0];
  // defaultProjectName() lost its `row` argument when the default project stopped being named after
  // the owner ("<display_name>'s project" → "Default Project") — a name carrying the owner's identity
  // is PII on a seized device. The assertion is about WHICH function resolves the folder, not its args.
  ok(/driveEnsureDefaultProject\(access, defaultProjectName\(\)\)/.test(fn),
     'it resolves the researcher\'s existing default project folder rather than minting a new one');
  ok(/if \(!driveFolder && row\.drive_refresh_enc\)/.test(fn),
     '⚠ it does not even try when the researcher has no Drive connection');
  ok(/catch \{ driveFolder = null; \}/.test(fn),
     '⚠ and a Drive failure leaves NULL rather than failing a backfill whose D1 work already succeeded');
  ok(/WHERE project_id=\? AND drive_folder_id IS NULL/.test(fn),
     '⚠ conditional on absence, like every other write here — re-running never re-points a moved project');
}

console.log('\nboth namespaces are written in ONE act, so they cannot drift');
{
  const create = worker.slice(worker.indexOf("seg[3] === 'create'"), worker.indexOf("seg[3] === 'assign'"));
  ok(/INSERT INTO project \(project_id, owner_id, name, created_at, drive_folder_id\)/.test(create),
     'creating a Drive project folder writes the D1 row beside it');
  ok(/catch \(e2\) \{[\s\S]{0,160}?console\.warn\('project row not written/.test(create),
     '⚠ and the D1 write cannot fail the request — the folder already exists, so a retry would mint a SECOND one');

  const assign = worker.slice(worker.indexOf("seg[3] === 'assign'"), worker.indexOf("seg[3] === 'rename'"));
  ok(/SELECT project_id FROM project WHERE drive_folder_id=\? AND owner_id=\?/.test(assign),
     'moving a container looks up the D1 project for the destination folder');
  ok(/UPDATE instance SET project_id=\?[\s\S]{0,80}?AND researcher_id=\?/.test(assign),
     '...and updates instance.project_id in the same act (invariant I3)');
  ok(/const newPid = destRow \? destRow\.project_id : null;/.test(assign),
     '⚠ no matching D1 project CLEARS project_id rather than leaving it stale — a stale value would authorize against the project the container just LEFT');
  ok(/UPDATE crowd_recorder SET project_id=\?/.test(assign), 'crowd recorders move too');
}

/* ── A ONE-TIME MIGRATION THAT MUST BE RE-RUN IS A STANDING CHORE ──────────────────────────────
 * Seth, 2026-08-20: "will we have a way for our researchers to move forward without having to paste
 * code in their JS consoles?"
 *
 * ⚠ THE HOLE THAT QUESTION FOUND. Nothing creates a project at signup — the operator backfill mints
 * one per EXISTING researcher and is then finished. An account created the next day has none, and
 * Phase C authorizes from instance.project_id with I4 saying an unresolvable grant DENIES. So the
 * new researcher fails closed, locked out of their own devices, and the only remedy is an operator
 * re-running a backfill nobody knew was needed. */
console.log('\na researcher who signs up tomorrow gets a project without anyone being asked');
{
  const at = worker.indexOf("// GET /v1/researcher — control-panel view");
  const route = worker.slice(at, at + 2600);
  ok(/SELECT project_id FROM project WHERE owner_id=\? LIMIT 1/.test(route),
     'the dashboard checks whether the caller has a project');
  ok(/if \(!mine\) await backfillProjectsFor\(env, r, now\);/.test(route),
     '...and mints one with the SAME idempotent routine, rather than a second implementation');
  ok(/if \(isApproved\(r, env\)\) \{/.test(route),
     'only for an approved account — a pending one has nothing to own yet');
  ok(/catch \(e2\)[\s\S]{0,120}?lazy project mint failed/.test(route),
     '⚠ and it can never fail the dashboard — a panel that will not load is worse than a missing row');
  /* ⚠ The self-limiting property is what makes this safe on a route polled every 12s: the expensive
   * branch runs only when the lookup returns nothing, and backfillProjectsFor's FIRST act is to
   * write the row that stops it running again. */
  const bf = worker.match(/async function backfillProjectsFor[\s\S]*?\n\}/)[0];
  ok(bf.indexOf('INSERT INTO project') < bf.indexOf('driveEnsureDefaultProject'),
     '⚠ the D1 row is written BEFORE the Drive call, so a Drive failure cannot make this loop');
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASSED');
process.exit(fail ? 1 : 0);
