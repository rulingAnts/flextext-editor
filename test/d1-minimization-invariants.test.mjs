/* WHAT D1 IS NOT ALLOWED TO HOLD — the §10.4 minimization rules, enforced.
 *
 * WHY A TEST AND NOT A COMMENT. Both rules below are the kind that survive being written down and
 * then die to a perfectly reasonable pull request months later, because breaking them always looks
 * like an improvement at the moment you do it:
 *
 *   - `title` in D1 makes a list view fast without a Drive round trip.
 *   - `project_id` on the text row turns a join into a column read.
 *
 * Neither is a bad instinct. They are refused because this database holds the corpus index for the
 * language, voices and consent records of indigenous communities, and §10 is one long argument about
 * making a database dump worth as little as possible. The title is the single most revealing field
 * there is; the project grouping tells an attacker which texts belong to which community's work,
 * without their having to break anything else. A rule that only lives in a plan is a rule that gets
 * reversed by whoever is optimising a list view and has not read the plan.
 *
 * ⚠ THESE ASSERTIONS ARE DELIBERATELY LIVE BEFORE THE TABLE EXISTS. The `text` table is Phase C and
 * is not built yet, so the project_id half is a NO-OP today — by design. The whole point is that it
 * starts biting the moment the table is written, rather than being remembered and added afterwards,
 * which is the sequence in which it would not get added at all.
 *
 * Run: node test/d1-minimization-invariants.test.mjs
 */
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const root = new URL('../', import.meta.url);
const sqlFiles = readdirSync(new URL('worker/', root)).filter((f) => f.endsWith('.sql'));
const sql = sqlFiles.map((f) => ({ f, body: readFileSync(new URL('worker/' + f, root), 'utf8') }));

/* Column declarations only. Comments mention both words constantly and legitimately (`titleHash,
 * not titles` is a comment RECORDING this very rule), so a naive substring search would fail on the
 * documentation of the thing it is checking. */
const stripComments = (s) => s.replace(/--[^\n]*/g, '');
const tableBody = (body, name) => {
  const re = new RegExp('CREATE TABLE (?:IF NOT EXISTS )?' + name + '\\s*\\(([\\s\\S]*?)\\n\\);', 'i');
  const m = re.exec(stripComments(body));
  return m ? m[1] : null;
};
const columns = (body) => (body || '').split('\n')
  .map((l) => (l.trim().match(/^([a-z_][a-z0-9_]*)\s+/i) || [])[1])
  .filter(Boolean).map((c) => c.toLowerCase());

console.log('\n§10.4(3) — a plaintext title never enters D1');
{
  for (const { f, body } of sql) {
    const bare = stripComments(body);
    /* A COLUMN literally called title/name-of-text, in any table. `titleHash` is fine and is the
     * sanctioned alternative — it is a one-way digest, which is the whole point. */
    const bad = [...bare.matchAll(/^\s*(title|text_title|doc_title)\s+\w/gim)].map((m) => m[1]);
    ok(!bad.length, `${f}: no plaintext title column${bad.length ? ' — found ' + bad.join(', ') : ''}`);
  }
}

console.log('\n§8.1 — assigned and unassigned rows must not DRIFT APART');
{
  /* SETTLED 2026-08-19: derive project_id from the instance that holds the text; store it only on
   * rows with no instance to derive from.
   *
   * ⚠ THE FIRST VERSION OF THIS CHECK WAS WRONG, and wrong in the expensive direction — it asserted
   * `text` must have NO project_id column at all, which would have failed the CORRECT Phase C
   * implementation. The rule is not "no column"; it is "the column is NULL whenever an instance can
   * be derived from". A guard that fires on the right answer is worse than no guard, because it
   * trains people to delete guards.
   *
   * Seth's actual concern (2026-08-19) is not that the decision gets reversed — it is that ASSIGNED
   * and UNASSIGNED texts drift apart because they are answered by two code paths. So these two
   * assertions target the drift itself rather than the column:
   *
   *   1. A CHECK CONSTRAINT makes the invariant the DATABASE's, not a convention: a row can never
   *      hold both an instance and a stored project. Nothing can violate it, including a migration.
   *   2. A VIEW gives readers ONE thing to query, so no caller ever branches on which kind of row it
   *      has. The branch existing exactly once, in schema, is what stops it existing in twelve
   *      places in JavaScript. */
  let textTableSeen = false;
  for (const { f, body } of sql) {
    const t = tableBody(body, 'text');
    if (!t) continue;
    textTableSeen = true;
    const bare = stripComments(body);
    if (columns(t).includes('project_id')) {
      ok(/CHECK\s*\(\s*instance_id IS NULL OR project_id IS NULL\s*\)/i.test(t),
         `${f}: a stored project_id is CHECK-constrained to rows with no instance (§8.1)`);
    } else {
      ok(true, `${f}: text carries no project_id at all — also satisfies §8.1`);
    }
    ok(/CREATE VIEW (?:IF NOT EXISTS )?text_scoped/i.test(bare),
       `${f}: a text_scoped VIEW exists, so readers never branch on assigned vs unassigned`);
    ok(/COALESCE\s*\(\s*i\.project_id\s*,\s*t\.project_id\s*\)/i.test(bare),
       `${f}: ...and the view is where the derive-or-stored choice is made, exactly once`);
  }
  if (!textTableSeen) {
    console.log('  ok    (no `text` table yet — Phase C; these assertions arm themselves when it lands)');
  }
}

console.log('\nthe rules still say what the test enforces');
{
  /* Pinned BOTH ways, like threat-language.test.mjs: a future edit must not be able to relax the
   * plan and the test independently and have them silently agree again. */
  const plan = readFileSync(new URL('plans/drive-as-truth.md', root), 'utf8');
  ok(/SETTLED[\s\S]{0,40}DERIVE it from the instance/.test(plan), '§8.1 still records the derive decision');
  ok(/Never store `title` in D1/.test(plan), '§10.4(3) still records the title rule');
  ok(/two code paths for one question/i.test(plan),
     '...and the accepted cost is still recorded, so it is not rediscovered as a surprise');
}

/* ⚠ AN ASSERTION THAT CANNOT FAIL IS WORSE THAN NO ASSERTION, because it reads as coverage. The
 * project_id check is a no-op until Phase C writes the table, so prove HERE that the detector
 * actually fires — otherwise the day the table lands is the day we find out it never worked. */
console.log('\nthe detectors are not vacuous');
{
  const synthetic = `CREATE TABLE text (\n  doc_id TEXT PRIMARY KEY,\n  project_id TEXT,\n  title TEXT\n);`;
  const t = tableBody(synthetic, 'text');
  ok(!!t, 'a synthetic text table is parsed');
  ok(columns(t).includes('project_id'), '...and project_id in it IS detected');
  ok(!/CHECK\s*\(\s*instance_id IS NULL OR project_id IS NULL\s*\)/i.test(t),
     '...and an UNCONSTRAINED project_id fails the check (so the real assertion can fire)');
  const good = `CREATE TABLE text (\n  doc_id TEXT PRIMARY KEY,\n  instance_id TEXT,\n  project_id TEXT,\n  CHECK (instance_id IS NULL OR project_id IS NULL)\n);`;
  ok(/CHECK\s*\(\s*instance_id IS NULL OR project_id IS NULL\s*\)/i.test(tableBody(good, 'text')),
     '...while the CORRECT shape passes it — a guard that fails the right answer is worse than none');
  ok(/^\s*(title|text_title|doc_title)\s+\w/gim.test(stripComments(synthetic)),
     '...and a plaintext title column IS detected');
  /* And the comment case must NOT trip it — `-- titleHash, not titles` is a real line in schema.sql
   * and is the documentation OF this rule. A checker that fails on its own rationale is unusable. */
  ok(!/^\s*(title|text_title|doc_title)\s+\w/gim.test(stripComments('  reported_blob TEXT, -- title stuff\n')),
     '...while a comment mentioning titles does not trip it');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
