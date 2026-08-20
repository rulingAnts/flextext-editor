/* ONE D1 PROJECT PER DRIVE PROJECT FOLDER — the bug Seth's own estate exposed on day one.
 *
 * WHY THIS EXISTS. Phase B's `backfillProjectsFor` mints exactly ONE project per researcher and
 * points it at the DEFAULT Drive folder, because that is all its model had. Seth owns TWO project
 * folders ("Fayu Text Corpus", "Dani Dictionary"), so production ended up with ONE project row and
 * EVERY device adopted into it — including the three whose folders sit inside the other project.
 *
 * ⚠ THAT IS NOT COSMETIC UNDER PHASE C. Authorization reads `instance.project_id`, so a grant
 * naming the one project would authorize a member against devices from BOTH — exactly the isolation
 * the phase exists to provide, absent on the very first real estate it met. The second folder had no
 * D1 row at all, so `/projects/assign` into it resolved to NULL.
 *
 * ⚠ TESTED FOR REAL, NOT GREPPED. `reconcileProjects` is pure D1 given an estate, so it runs here
 * against an actual SQLite database through a D1-shaped adapter, on the REAL schema. Source
 * inspection could not tell the difference between "splits the devices" and "looks like it does" —
 * and that difference is the entire bug.
 *
 * Run: node test/project-reconcile.test.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const { reconcileProjects } = await import('../worker/src/v1.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

/* A D1-shaped adapter over node:sqlite. Only the surface reconcileProjects uses: prepare().bind()
 * .all()/.first()/.run(), and batch(). `batch` is a TRANSACTION in D1, so it is one here too —
 * otherwise a test could pass on a half-applied batch that production would roll back. */
function d1(db) {
  let writes = 0;
  const stmt = (sql) => ({
    sql, args: [],
    bind(...a) { this.args = a; return this; },
    all() { return { results: db.prepare(sql).all(...this.args) }; },
    first() { return db.prepare(sql).all(...this.args)[0] || null; },
    run() { const r = db.prepare(sql).run(...this.args); writes++; return { meta: { changes: Number(r.changes) } }; },
  });
  return {
    DB: {
      prepare: stmt,
      async batch(list) {
        db.exec('BEGIN');
        try { for (const s of list) { db.prepare(s.sql).run(...s.args); writes++; } db.exec('COMMIT'); }
        catch (e) { db.exec('ROLLBACK'); throw e; }
        return list.map(() => ({ success: true }));
      },
    },
    writes: () => writes,
    resetWrites: () => { writes = 0; },
  };
}

/* The REAL DDL for the three tables involved, lifted from schema-current.sql rather than retyped —
 * a hand-written fixture schema is a second answer to "what does production look like", and it
 * drifts silently. */
function freshDb() {
  const schema = readFileSync(new URL('../worker/schema-current.sql', import.meta.url), 'utf8');
  const db = new DatabaseSync(':memory:');
  for (const t of ['project', '"instance"', 'crowd_recorder']) {
    const m = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(([\\s\\S]*?)\\n\\);`));
    if (!m) throw new Error('DDL not found for ' + t);
    db.exec(`CREATE TABLE IF NOT EXISTS ${t} (${m[1]}\n);`);
  }
  return db;
}

const ME = 'res-seth';
const FAYU = 'folder-fayu', DANI = 'folder-dani';
const NOW = 1787200000000;

// An estate shaped exactly like buildDriveEstate's output for a two-project tree.
const estate = {
  projects: [{ folderId: FAYU, name: 'Fayu Text Corpus' }, { folderId: DANI, name: 'Dani Dictionary' }],
  devices: [
    { folderId: 'dev-a', name: 'Seth PWA', kind: 'device', projectId: FAYU },
    { folderId: 'dev-b', name: 'Yohanis Suhu', kind: 'device', projectId: FAYU },
    { folderId: 'dev-c', name: 'Android 2026', kind: 'device', projectId: DANI },
    { folderId: 'dev-d', name: "Wemis Wanimbo's Phone", kind: 'device', projectId: DANI },
    { folderId: 'dev-e', name: 'Old flat device', kind: 'device', projectId: '' },
    { folderId: 'rec-a', name: 'Test Crowd Recorder', kind: 'crowd', projectId: FAYU },
  ],
};

const inst = (db, id, folder, pid) => db.prepare(
  'INSERT INTO "instance" (instance_id, researcher_id, type, nickname, desired_rev, revoked, created_at, oauth_folder_id, project_id) VALUES (?,?,?,?,0,0,?,?,?)'
).run(id, ME, '', id, NOW, folder, pid);

/* ---------------------------------------------------------------- */
console.log('\nproduction\'s actual state: ONE project row, every device adopted into it');
{
  const db = freshDb(); const env = d1(db);
  // Exactly what the lazy mint left behind, name and all.
  db.prepare('INSERT INTO project (project_id, owner_id, name, created_at, drive_folder_id) VALUES (?,?,?,?,?)')
    .run('p-legacy', ME, "Seth Johnston's project", NOW, FAYU);
  for (const [id, f] of [['i-a', 'dev-a'], ['i-b', 'dev-b'], ['i-c', 'dev-c'], ['i-d', 'dev-d'], ['i-e', 'dev-e']]) inst(db, id, f, 'p-legacy');
  db.prepare('INSERT INTO crowd_recorder (crowd_id, researcher_id, created_at, oauth_folder_id, project_id) VALUES (?,?,?,?,?)')
    .run('c-a', ME, NOW, 'rec-a', 'p-legacy');

  await reconcileProjects(env, ME, estate, NOW);

  const projects = db.prepare('SELECT project_id, name, drive_folder_id FROM project ORDER BY drive_folder_id').all();
  ok(projects.length === 2, `two project rows, one per Drive folder (got ${projects.length})`);
  const dani = projects.find((p) => p.drive_folder_id === DANI);
  const fayu = projects.find((p) => p.drive_folder_id === FAYU);
  ok(!!dani, '⚠ the second project folder gets a row — without one, /projects/assign into it resolves to NULL');
  ok(fayu && fayu.project_id === 'p-legacy',
     '⚠ and the EXISTING row is kept, not replaced — member_key and project_member already key on its id');
  ok(fayu && fayu.name === 'Fayu Text Corpus',
     '⚠ its name follows the Drive folder — otherwise Phase D offers a member a project name its owner never chose');
  ok(dani && dani.name === 'Dani Dictionary', 'the new row is named after its folder too');

  const pid = (i) => db.prepare('SELECT project_id FROM "instance" WHERE instance_id=?').all(i)[0].project_id;
  ok(pid('i-c') === dani.project_id && pid('i-d') === dani.project_id,
     '⚠⚠ THE ISOLATION BUG: devices inside Dani Dictionary now carry ITS project, not Fayu\'s');
  ok(pid('i-a') === 'p-legacy' && pid('i-b') === 'p-legacy', 'devices inside Fayu are left where they were');
  ok(pid('i-e') === 'p-legacy',
     '⚠ a container still directly under master is NOT touched — a half-migrated estate is a valid state, not drift');
  ok(db.prepare('SELECT project_id FROM crowd_recorder WHERE crowd_id=?').all('c-a')[0].project_id === 'p-legacy',
     'a crowd recorder is re-homed by the same rule (this one was already right)');

  console.log('\nand it is IDEMPOTENT — it hangs off a route the panel polls constantly');
  env.resetWrites();
  await reconcileProjects(env, ME, estate, NOW);
  ok(env.writes() === 0,
     `⚠ a second pass writes NOTHING (got ${env.writes()}) — a reconcile that writes every poll is a write amplifier on every dashboard`);
}

console.log('\na project row that points at no folder CLAIMS one rather than being orphaned beside a fresh insert');
{
  const db = freshDb(); const env = d1(db);
  db.prepare('INSERT INTO project (project_id, owner_id, name, created_at, drive_folder_id) VALUES (?,?,?,?,NULL)')
    .run('p-null', ME, 'Unresolved', NOW);
  await reconcileProjects(env, ME, estate, NOW);
  const rows = db.prepare('SELECT project_id, drive_folder_id FROM project').all();
  ok(rows.length === 2, `still two rows, not three (got ${rows.length})`);
  ok(rows.find((p) => p.project_id === 'p-null').drive_folder_id === FAYU,
     '⚠ the unresolved row took the first folder — a row with no folder can scope nothing at all');
}

console.log('\nbut TWO unresolved rows are ambiguous, and a guess here mis-files real devices');
{
  const db = freshDb(); const env = d1(db);
  for (const id of ['p-n1', 'p-n2']) {
    db.prepare('INSERT INTO project (project_id, owner_id, name, created_at, drive_folder_id) VALUES (?,?,?,?,NULL)').run(id, ME, id, NOW);
  }
  await reconcileProjects(env, ME, estate, NOW);
  const nulls = db.prepare('SELECT project_id FROM project WHERE drive_folder_id IS NULL').all();
  ok(nulls.length === 2, '⚠ neither is claimed — with two candidates, which folder each belongs to is a guess');
  ok(db.prepare('SELECT COUNT(*) c FROM project WHERE drive_folder_id IS NOT NULL').all()[0].c === 2,
     'both folders still get rows of their own');
}

console.log('\nit never reaches another researcher\'s rows');
{
  const db = freshDb(); const env = d1(db);
  db.prepare('INSERT INTO project (project_id, owner_id, name, created_at, drive_folder_id) VALUES (?,?,?,?,?)')
    .run('p-them', 'res-other', 'Theirs', NOW, DANI);
  db.prepare('INSERT INTO "instance" (instance_id, researcher_id, type, nickname, desired_rev, revoked, created_at, oauth_folder_id, project_id) VALUES (?,?,?,?,0,0,?,?,?)')
    .run('i-them', 'res-other', '', 'theirs', NOW, 'dev-c', 'p-them');
  await reconcileProjects(env, ME, estate, NOW);
  ok(db.prepare('SELECT project_id FROM "instance" WHERE instance_id=?').all('i-them')[0].project_id === 'p-them',
     '⚠ another account\'s instance is untouched even though its folder id appears in this estate');
  ok(db.prepare('SELECT COUNT(*) c FROM project WHERE owner_id=?').all(ME)[0].c === 2,
     '⚠ and their project row is not adopted — owner_id scopes every read, not just every write');
}

console.log('\na flat estate is a valid state and costs nothing');
{
  const db = freshDb(); const env = d1(db);
  await reconcileProjects(env, ME, { projects: [], devices: [{ folderId: 'dev-e', projectId: '' }] }, NOW);
  ok(env.writes() === 0, 'no projects in Drive ⇒ no rows invented');
}

console.log('\nrevoked instances are reconciled too');
{
  const db = freshDb(); const env = d1(db);
  db.prepare('INSERT INTO project (project_id, owner_id, name, created_at, drive_folder_id) VALUES (?,?,?,?,?)')
    .run('p-legacy', ME, 'Fayu Text Corpus', NOW, FAYU);
  db.prepare('INSERT INTO "instance" (instance_id, researcher_id, type, nickname, desired_rev, revoked, created_at, oauth_folder_id, project_id) VALUES (?,?,?,?,0,1,?,?,?)')
    .run('i-dead', ME, '', 'dead', NOW, 'dev-c', 'p-legacy');
  await reconcileProjects(env, ME, estate, NOW);
  const dani = db.prepare('SELECT project_id FROM project WHERE drive_folder_id=?').all(DANI)[0];
  ok(db.prepare('SELECT project_id FROM "instance" WHERE instance_id=?').all('i-dead')[0].project_id === dani.project_id,
     '⚠ a revoked row with a stale project becomes wrong the moment it is un-revoked');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
