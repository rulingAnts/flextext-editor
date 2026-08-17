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
ok(wouldLose.join(' ') === 'estate oauth_folder_id',
  `re-running the instance rebuild would destroy exactly [${wouldLose.join(', ')}] — update this ` +
  'assertion (and the migration) when the split adds project_id');

console.log(fail ? `\nFAILED (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
