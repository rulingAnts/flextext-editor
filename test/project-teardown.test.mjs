/* Un-migration must forget the project in D1, not just move the Drive folders — uncovered sweep #7.
 *
 * The unmigrate route is Drive-gated, so it cannot run on the local rig. teardownUnmigratedProjectRows
 * is the pure D1 half, extracted precisely so it CAN be tested — here, directly, against a real
 * in-memory SQLite through a thin D1-shaped shim. This is the ACTUAL function the worker calls, not a
 * transcription of it: neuter the fix and this test goes red.
 *
 * Run: node test/project-teardown.test.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { teardownUnmigratedProjectRows } from '../worker/src/project-teardown.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

/* The D1 binding shape the worker uses (prepare().bind().run()/.first()), over node:sqlite. run()
 * returns { meta: { changes } } like D1 so the helper's change counts work; first() returns a row or
 * null. Only the surface the helper touches is implemented. */
function d1(db) {
  return {
    prepare(sql) {
      const st = db.prepare(sql);
      let args = [];
      return {
        bind(...a) { args = a; return this; },
        run() { const r = st.run(...args); return { meta: { changes: Number(r.changes) || 0 } }; },
        first() { return st.get(...args) ?? null; },
      };
    },
  };
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  // Only the tables the teardown touches, with the columns it names.
  db.exec(`
    CREATE TABLE instance (instance_id TEXT PRIMARY KEY, researcher_id TEXT, oauth_folder_id TEXT, project_id TEXT);
    CREATE TABLE crowd_recorder (crowd_id TEXT PRIMARY KEY, researcher_id TEXT, oauth_folder_id TEXT, project_id TEXT);
    CREATE TABLE project (project_id TEXT PRIMARY KEY, owner_id TEXT, drive_folder_id TEXT);
    CREATE TABLE project_member (project_id TEXT, researcher_id TEXT, PRIMARY KEY (project_id, researcher_id));
  `);
  return db;
}

const OWNER = 'owner-1', MEMBER = 'member-1', OTHER_OWNER = 'owner-2';
const PID = 'proj-1', FOLDER = 'drive-folder-proj-1';

function seed(db) {
  // Two of the owner's devices live in the project; a crowd recorder too; plus a device of ANOTHER
  // owner that happens to share a folder id (it must never be touched).
  db.prepare('INSERT INTO instance VALUES (?,?,?,?)').run('devA', OWNER, 'folder-A', PID);
  db.prepare('INSERT INTO instance VALUES (?,?,?,?)').run('devB', OWNER, 'folder-B', PID);
  db.prepare('INSERT INTO instance VALUES (?,?,?,?)').run('devElsewhere', OTHER_OWNER, 'folder-A', 'other-proj');
  db.prepare('INSERT INTO crowd_recorder VALUES (?,?,?,?)').run('crowdC', OWNER, 'folder-C', PID);
  db.prepare('INSERT INTO project VALUES (?,?,?)').run(PID, OWNER, FOLDER);
  db.prepare('INSERT INTO project_member VALUES (?,?)').run(PID, MEMBER);
}

console.log('teardownUnmigratedProjectRows — the D1 half of un-migrating a project\n');

console.log('a FULL dismantle: containers unassigned, project + memberships forgotten');
{
  const db = freshDb(); seed(db);
  const res = await teardownUnmigratedProjectRows(d1(db), OWNER, ['folder-A', 'folder-B', 'folder-C'], FOLDER, true);

  ok(db.prepare('SELECT project_id FROM instance WHERE instance_id=?').get('devA').project_id === null,
     'the moved device is unassigned — project_id is NULL, not the dismantled project');
  ok(db.prepare('SELECT project_id FROM instance WHERE instance_id=?').get('devB').project_id === null,
     'the second moved device too');
  ok(db.prepare('SELECT project_id FROM crowd_recorder WHERE crowd_id=?').get('crowdC').project_id === null,
     'and the crowd recorder — crowd folders move under master as well');
  ok(db.prepare('SELECT COUNT(*) c FROM project WHERE project_id=?').get(PID).c === 0,
     '⚠⚠ the PROJECT row is gone — authMember resolves through it, so a stale row is persistent authority');
  ok(db.prepare('SELECT COUNT(*) c FROM project_member WHERE project_id=?').get(PID).c === 0,
     '⚠⚠ and every MEMBERSHIP of it is gone — the whole point: a coworker cannot outlive the project');
  ok(res.forgottenProjectId === PID && res.unassigned === 3,
     `the result reports what it did (forgot ${res.forgottenProjectId}, unassigned ${res.unassigned})`);

  ok(db.prepare('SELECT project_id FROM instance WHERE instance_id=?').get('devElsewhere').project_id === 'other-proj',
     '⚠ another owner\'s device sharing a folder id is UNTOUCHED — scoped to researcher_id');
}

console.log('\na PARTIAL dismantle (some container failed to move): only the moved ones change, project STAYS');
{
  const db = freshDb(); seed(db);
  // Only folder-A moved back; folder-B/C failed; folder not trashed → fullyDismantled=false.
  const res = await teardownUnmigratedProjectRows(d1(db), OWNER, ['folder-A'], FOLDER, false);

  ok(db.prepare('SELECT project_id FROM instance WHERE instance_id=?').get('devA').project_id === null,
     'the one that moved is unassigned');
  ok(db.prepare('SELECT project_id FROM instance WHERE instance_id=?').get('devB').project_id === PID,
     '⚠ the one that did NOT move keeps its project_id — a later pass finishes it');
  ok(db.prepare('SELECT COUNT(*) c FROM project WHERE project_id=?').get(PID).c === 1,
     '⚠⚠ the project row SURVIVES — it still holds a container, so tearing it down would strand devB');
  ok(db.prepare('SELECT COUNT(*) c FROM project_member WHERE project_id=?').get(PID).c === 1,
     'and its membership survives with it');
  ok(res.forgottenProjectId === null && res.unassigned === 1, 'the result says nothing was forgotten');
}

console.log('\nno moved containers is a clean no-op');
{
  const db = freshDb(); seed(db);
  const res = await teardownUnmigratedProjectRows(d1(db), OWNER, [], FOLDER, false);
  ok(res.unassigned === 0 && res.forgottenProjectId === null, 'nothing changed');
  ok(db.prepare('SELECT COUNT(*) c FROM project WHERE project_id=?').get(PID).c === 1, 'the project is intact');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nPASS\n');
process.exit(fail ? 1 : 0);
