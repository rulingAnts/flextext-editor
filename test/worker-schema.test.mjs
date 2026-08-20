/* The D1 schema the repo CLAIMS to produce — replayed for real, asserted against a snapshot.
 *
 * WHY THIS NEEDS A TEST (all four facts verified by running them, 2026-08-17):
 *
 *  1. There is NO applied-migrations ledger. The runbook's rule is "run each migrate-*.sql exactly
 *     once", enforced by memory. Nothing anywhere can answer "what does that database actually
 *     have?" — which is why worker/schema-report.sql exists (read-only, ask the database).
 *
 *  2. `schema.sql` has been folded FORWARD. It already declares researcher.salt … backup_codes
 *     (migrate-auth.sql), instance.estate and crowd_recorder.estate (migrate-estate.sql). So a
 *     database created from schema.sql is NOT the pre-migration database, and replaying the
 *     migration files over it hits duplicate-column errors that never happened in production.
 *
 *  3. `wrangler d1 execute --file` is ATOMIC. One failing statement rolls back the WHOLE FILE —
 *     verified with a three-statement file whose middle statement duplicated a column: neither
 *     surrounding CREATE survived. So a half-applied database can NOT be repaired by re-running
 *     the migration file: the duplicate aborts it and the missing columns stay missing. That is
 *     why this test replays STATEMENT-WISE, skipping only duplicates, the way a human repairing a
 *     drifted database has to.
 *
 *  4. `migrate-instance-type-unified.sql` REBUILDS `instance` (SQLite cannot ALTER a CHECK, so it
 *     creates instance_new with a FIXED column list, copies, drops, renames). Every column added
 *     to `instance` AFTER that file was written — oauth_folder_id, estate, and project_id when the
 *     researcher/project split lands — is silently DESTROYED if that file is ever run again, along
 *     with its data. It ran first in production (2026-07-23, before both), so production is fine;
 *     the hazard is re-running it, or replaying files into a fresh database in file order.
 *
 * What this test guards: that the repo's own files still replay to the schema the worker expects.
 * It does NOT prove any live database matches — only schema-report.sql can, and comparing the two
 * is the point. Regenerate the snapshot deliberately (never to make a red test green):
 *
 *   node test/worker-schema.test.mjs --regen
 *
 * Run: node test/worker-schema.test.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = join(ROOT, 'worker');
const SNAPSHOT = join(WORKER, 'schema-expected.json');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

/* Historical order: schema.sql, then the migrations in the order they were applied to the live
 * database (git add-dates; the 2026-07-23 block landed together in the repo fold, but ran in this
 * order against production — the rebuild BEFORE the columns it would otherwise destroy). */
const FILES = [
  'schema.sql',
  'migrate-auth.sql',
  'migrate-google-auth.sql',
  'migrate-researcher-approval.sql',
  'migrate-instance-type-unified.sql',
  'migrate-invite-accept.sql',
  'migrate-remote-wipe.sql',
  'migrate-device-upload.sql',
  'migrate-crowd-recorder.sql',
  'migrate-approved-domains.sql',
  'migrate-approved-domains-hashed.sql',
  'migrate-approval-log.sql',
  'migrate-estate.sql',
  'migrate-sessions.sql',
  'migrate-projects.sql',
  'migrate-ops-flag.sql',
  'migrate-pair-code.sql',
  'migrate-project-drive-link.sql',
];

/* Split on `;` at end of line — the house SQL style, one statement per line-group, no triggers or
 * BEGIN…END blocks anywhere in worker/*.sql (checked below, so this stays true). */
const statements = (sql) => sql
  .split(/;\s*(?:\n|$)/)
  .map((s) => s.replace(/^\s*(?:--[^\n]*\n)+/gm, '').trim())
  .filter(Boolean);

function replay() {
  const db = new DatabaseSync(':memory:');
  const dup = [];
  for (const f of FILES) {
    const sql = readFileSync(join(WORKER, f), 'utf8');
    ok(!/\bBEGIN\b/i.test(sql), `${f}: no BEGIN…END block (the naive splitter stays valid)`);
    for (const s of statements(sql)) {
      try { db.exec(s); }
      catch (e) {
        if (/duplicate column|already exists/i.test(e.message)) { dup.push(`${f}: ${e.message}`); continue; }
        ok(false, `${f}: ${e.message} — in: ${s.slice(0, 70)}`);
      }
    }
  }
  return { db, dup };
}

function shape(db) {
  const out = { tables: {}, indexes: [] };
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf%' ESCAPE '\\' ORDER BY name").all();
  for (const { name } of names) {
    out.tables[name] = db.prepare('SELECT name FROM pragma_table_info(?)').all(name).map((r) => r.name).sort();
  }
  out.indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  return out;
}

console.log('worker D1 schema — replay of schema.sql + every migration\n');

const { db, dup } = replay();
const got = shape(db);

if (process.argv.includes('--emit-schema')) {
  /* Dump the replayed database as a CREATE-only, IF NOT EXISTS, one-shot file. This is what makes
   * "mirror production exactly" possible for a FRESH database; the historical files cannot (see the
   * header of schema-current.sql). The prose header is preserved from the existing file so the
   * reasoning is not lost on every regeneration. */
  const canonPath = join(WORKER, 'schema-current.sql');
  let header = '';
  try {
    const prev = readFileSync(canonPath, 'utf8');
    header = prev.slice(0, prev.search(/^CREATE /m));
  } catch { header = '-- CANONICAL CURRENT SCHEMA — generated by: node test/worker-schema.test.mjs --emit-schema\n\n'; }
  const rows = db.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY (type='index'), name"
  ).all();
  const body = rows.map((r) => {
    let sql = r.sql.trim();
    if (/^CREATE TABLE/i.test(sql)) sql = sql.replace(/^CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS ');
    else sql = sql.replace(/^CREATE (UNIQUE )?INDEX\s+/i, (m, u) => `CREATE ${u || ''}INDEX IF NOT EXISTS `);
    return sql + ';';
  }).join('\n\n');
  writeFileSync(canonPath, header + body + '\n');
  console.log(`wrote ${canonPath} (${rows.length} objects)`);
  process.exit(0);
}

if (process.argv.includes('--regen')) {
  writeFileSync(SNAPSHOT, JSON.stringify(got, null, 2) + '\n');
  console.log(`\nwrote ${SNAPSHOT}`);
  process.exit(0);
}

/* The duplicates are EXPECTED and are themselves the fact worth pinning: they are exactly the
 * statements schema.sql was folded forward over. If this set changes, either schema.sql drifted
 * again or a migration was edited — both need a human. */
ok(dup.length === 8, `8 already-satisfied statements (schema.sql folded them in), saw ${dup.length}`);
ok(dup.every((d) => /migrate-auth|migrate-estate/.test(d)),
  'the folded-forward statements are only migrate-auth + migrate-estate');

let expected = null;
try { expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8')); }
catch { ok(false, `no snapshot at ${SNAPSHOT} — create it with --regen`); }

if (expected) {
  const tGot = Object.keys(got.tables), tExp = Object.keys(expected.tables);
  ok(tGot.join() === tExp.join(), `tables match the snapshot (${tGot.length}): ${tGot.join(', ')}`);
  for (const t of tExp) {
    const g = (got.tables[t] || []).join(' '), e = expected.tables[t].join(' ');
    const missing = expected.tables[t].filter((c) => !(got.tables[t] || []).includes(c));
    const extra = (got.tables[t] || []).filter((c) => !expected.tables[t].includes(c));
    ok(g === e, `${t}: columns match${g === e ? '' : ` — missing [${missing.join(', ')}] extra [${extra.join(', ')}]`}`);
  }
  ok(got.indexes.join() === expected.indexes.join(), `indexes match (${got.indexes.length})`);
}

/* Fact 4, kept loud: every migration that rebuilds a table must say so in its own header, because
 * the next person to write one has to know the rule (a rebuild drops columns added after it). */
for (const f of FILES) {
  const sql = readFileSync(join(WORKER, f), 'utf8');
  if (!/DROP TABLE/i.test(sql)) continue;
  ok(/only run once|run once|exactly once/i.test(sql),
    `${f} rebuilds a table and its header says to run it only once`);
}

/* The column the rebuild would destroy today — named, so the loss is concrete rather than a
 * warning nobody can size. Re-running migrate-instance-type-unified.sql drops these. */
const rebuilt = statements(readFileSync(join(WORKER, 'migrate-instance-type-unified.sql'), 'utf8'))
  .find((s) => /CREATE TABLE instance_new/i.test(s)) || '';
const rebuiltCols = [...rebuilt.matchAll(/^\s{2}(\w+)\s/gm)].map((m) => m[1]);
const wouldLose = (got.tables.instance || []).filter((c) => !rebuiltCols.includes(c));
ok(wouldLose.join(' ') === 'estate oauth_folder_id project_id',
  `re-running the instance rebuild would destroy exactly [${wouldLose.join(', ')}] and their DATA. ` +
  'The list grows every time the schema does, which is the point of asserting it: a rebuild-style ' +
  'migration is a landmine that gets bigger with age. Fresh databases must use schema-current.sql, ' +
  'never a replay of the historical files.');

/* The canonical one-shot schema (worker/schema-current.sql) must stay identical to the replay.
 * It is what makes "mirror production exactly" possible for a FRESH database — the historical files
 * cannot do it (schema.sql is folded forward, --file is atomic, and the instance rebuild drops later
 * columns), which is precisely how the staging D1 drifted. Regenerate deliberately:
 *   node test/worker-schema.test.mjs --emit-schema
 */
const CANON = join(WORKER, 'schema-current.sql');
let canonSrc = null;
try { canonSrc = readFileSync(CANON, 'utf8'); }
catch { ok(false, `no ${CANON} — create it with --emit-schema`); }

if (canonSrc) {
  const fresh = new DatabaseSync(':memory:');
  let applied = 0;
  for (const st of statements(canonSrc)) {
    try { fresh.exec(st); applied++; }
    catch (e) { ok(false, `schema-current.sql: ${e.message} — in: ${st.slice(0, 70)}`); }
  }
  ok(applied > 0, `schema-current.sql applies to an empty database (${applied} statements)`);

  const canonShape = shape(fresh);
  const tSame = Object.keys(canonShape.tables).join() === Object.keys(got.tables).join();
  ok(tSame, 'schema-current.sql creates the same TABLES as the migration replay');
  let colDiffs = [];
  for (const t of Object.keys(got.tables)) {
    if ((canonShape.tables[t] || []).join(' ') !== got.tables[t].join(' ')) colDiffs.push(t);
  }
  ok(colDiffs.length === 0,
     `schema-current.sql creates the same COLUMNS everywhere${colDiffs.length ? ` — differs on [${colDiffs.join(', ')}]` : ''}`);
  ok(canonShape.indexes.join() === got.indexes.join(), 'schema-current.sql creates the same INDEXES');

  /* It must be re-runnable and non-destructive: no ALTER, no DROP, no table rebuild. A reset script
   * someone points at the wrong database should be a no-op, not a data loss. */
  ok(!/\bALTER\s+TABLE\b/i.test(canonSrc), 'schema-current.sql contains no ALTER TABLE');
  ok(!/\bDROP\s+TABLE\b/i.test(canonSrc), 'schema-current.sql contains no DROP TABLE');
  ok(!/CREATE TABLE(?! IF NOT EXISTS)/i.test(canonSrc), 'every CREATE TABLE is IF NOT EXISTS');
  ok(!/CREATE (UNIQUE )?INDEX(?! IF NOT EXISTS)/i.test(canonSrc), 'every CREATE INDEX is IF NOT EXISTS');
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
