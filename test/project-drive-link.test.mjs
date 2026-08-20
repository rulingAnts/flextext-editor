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
  ok(/driveEnsureDefaultProject\(access, defaultProjectName\(row\)\)/.test(fn),
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

console.log(fail ? `\nFAILED (${fail})` : '\nPASSED');
process.exit(fail ? 1 : 0);
