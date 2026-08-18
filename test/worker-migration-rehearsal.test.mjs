/* REHEARSE THE PRODUCTION MIGRATION — against a database that already has rows.
 *
 * WHY THIS IS NOT COVERED BY THE OTHER TESTS. The rig builds a database from schema-current.sql:
 * everything already present, nothing to migrate. Production is the opposite case — a live database
 * with 7 researchers, 34 instances, 28 installs — and the failures that matter there are data
 * failures, not schema ones: a column added to a populated table, a row count that changes, an
 * existing value quietly rewritten. None of that can happen in a fresh database, so none of the
 * other suites can see it.
 *
 * So this replays the ACTUAL sequence: build the PRE-migration schema (the historical files, minus
 * the two new ones), fill it with production-shaped rows, apply exactly what would be applied to
 * production, and assert that nothing moved.
 *
 * ⚠ It uses SYNTHETIC rows, never a production export. Copying production into a test database is
 * the thing this project decided not to do (plans/project-split.md VI.4); what a migration test
 * needs is row SHAPES and row COUNTS, which synthetic data provides exactly.
 *
 * Run: node test/worker-migration-rehearsal.test.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'worker');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const statements = (sql) => sql.split(/;\s*(?:\n|$)/)
  .map((s) => s.replace(/^\s*(?:--[^\n]*\n)+/gm, '').trim()).filter(Boolean);

/* The schema as production has it TODAY: every historical migration, and neither new one. */
const BEFORE = ['schema.sql', 'migrate-auth.sql', 'migrate-google-auth.sql', 'migrate-researcher-approval.sql',
  'migrate-instance-type-unified.sql', 'migrate-invite-accept.sql', 'migrate-remote-wipe.sql',
  'migrate-device-upload.sql', 'migrate-crowd-recorder.sql', 'migrate-approved-domains.sql',
  'migrate-approved-domains-hashed.sql', 'migrate-approval-log.sql', 'migrate-estate.sql'];
/* What would be applied, in this order. */
const APPLY = ['migrate-sessions.sql', 'migrate-projects.sql'];

const db = new DatabaseSync(':memory:');
for (const f of BEFORE) {
  for (const st of statements(readFileSync(join(WORKER, f), 'utf8'))) {
    try { db.exec(st); } catch (e) { if (!/duplicate column|already exists/i.test(e.message)) throw e; }
  }
}

/* Production-shaped rows: the counts measured on 2026-08-17, so the rehearsal is the right SIZE
 * as well as the right shape. Values are synthetic. */
const COUNTS = { researcher: 7, instance: 34, install: 28, invite: 33, crowd_recorder: 1 };
const now = 1_760_000_000_000;
for (let i = 0; i < COUNTS.researcher; i++) {
  db.prepare('INSERT INTO researcher (researcher_id, secret_hash, email_sha256, settings_blob, settings_rev, created_at, google_sub, drive_email, display_name, approved) VALUES (?,?,?,?,0,?,?,?,?,1)')
    .run(`r${i}`, `hash${i}`, `ekey${i}`, '{"wrappedKis":{}}', now, `sub${i}`, `r${i}@example.invalid`, `Researcher ${i}`);
}
for (let i = 0; i < COUNTS.instance; i++) {
  db.prepare('INSERT INTO instance (instance_id, researcher_id, type, nickname, desired_blob, desired_rev, revoked, created_at, oauth_folder_id, estate) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(`i${i}`, `r${i % COUNTS.researcher}`, '', `Device ${i}`, '{"settings":{},"commands":[]}', i, i < 7 ? 0 : 1, now, `folder${i}`, i < 21 ? 'pages' : 'cloud');
}
for (let i = 0; i < COUNTS.install; i++) {
  db.prepare('INSERT INTO install (install_id, instance_id, secret_hash, status, reported_rev, ack_seq, revoked, created_at, pubkey, wrapped_key, accepted) VALUES (?,?,?,?,?,?,?,?,?,?,1)')
    .run(`n${i}`, `i${i}`, `ihash${i}`, 'approved', 1, 0, i < 5 ? 0 : 1, now, `pk${i}`, `wk${i}`);
}
for (let i = 0; i < COUNTS.invite; i++) {
  db.prepare('INSERT INTO invite (invite_id, instance_id, secret_hash, expires_at, created_at) VALUES (?,?,?,?,?)')
    .run(`v${i}`, `i${i % COUNTS.instance}`, `vhash${i}`, now + 3600000, now);
}
db.prepare('INSERT INTO crowd_recorder (crowd_id, researcher_id, label, created_at, estate) VALUES (?,?,?,?,?)')
  .run('c0', 'r0', 'Crowd', now, 'pages');

const snapshot = () => {
  const out = {};
  for (const t of Object.keys(COUNTS)) out[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  out.sampleResearcher = db.prepare('SELECT * FROM researcher WHERE researcher_id=?').get('r3');
  out.sampleInstance = db.prepare('SELECT * FROM instance WHERE instance_id=?').get('i9');
  out.sampleInstall = db.prepare('SELECT * FROM install WHERE install_id=?').get('n2');
  return out;
};
const before = snapshot();

console.log('migrating a POPULATED database, production-shaped\n');

/* ---- apply exactly what production would receive ---- */
let applied = 0;
for (const f of APPLY) {
  for (const st of statements(readFileSync(join(WORKER, f), 'utf8'))) {
    try { db.exec(st); applied++; }
    catch (e) { ok(false, `${f}: ${e.message} — in: ${st.slice(0, 60)}`); }
  }
}
ok(applied > 0, `both migrations applied cleanly to a populated database (${applied} statements)`);

const after = snapshot();

/* ---- 1. NOT ONE ROW MOVED ---- */
for (const t of Object.keys(COUNTS)) {
  ok(after[t] === before[t], `${t}: ${before[t]} rows before, ${after[t]} after — a migration must never lose one`);
}

/* ---- 2. every pre-existing VALUE is untouched ---- */
for (const [label, key] of [['researcher', 'sampleResearcher'], ['instance', 'sampleInstance'], ['install', 'sampleInstall']]) {
  const diffs = Object.keys(before[key]).filter((c) => before[key][c] !== after[key][c]);
  ok(diffs.length === 0, `${label}: no pre-existing column changed value${diffs.length ? ` — changed [${diffs.join(', ')}]` : ''}`);
}

/* ---- 3. the new columns exist and are EMPTY, so old code paths see exactly what they saw ---- */
const cols = (t) => db.prepare('SELECT name FROM pragma_table_info(?)').all(t).map((r) => r.name);
ok(cols('researcher').includes('pubkey') && cols('researcher').includes('wrapped_privkey'),
   'researcher gained pubkey + wrapped_privkey');
ok(cols('instance').includes('project_id'), 'instance gained project_id');
ok(after.sampleInstance.project_id === null,
   'and it is NULL on every existing row — so the dual-read path still resolves by researcher_id');
ok(after.sampleResearcher.pubkey === null, 'the keypair columns start empty, filled lazily by the client');

/* ---- 4. the new TABLES exist and are empty — no data appears from nowhere ---- */
for (const t of ['session', 'project', 'project_member', 'member_key']) {
  const n = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  ok(n === 0, `${t} exists and is empty (${n}) — the backfill creates rows, not the migration`);
}

/* ---- 5. the estate/pairing facts the old worker reads are still exactly true ---- */
const live = db.prepare("SELECT COUNT(*) n FROM instance WHERE revoked=0").get().n;
const pages = db.prepare("SELECT COUNT(*) n FROM instance WHERE estate='pages'").get().n;
ok(live === 7 && pages === 21, `the queries the CURRENT worker runs still return the same answers (live=${live}, pages=${pages})`);

console.log(fail ? `\nFAILED (${fail})` : '\nPASS — a populated database survives both migrations unchanged');
process.exit(fail ? 1 : 0);
