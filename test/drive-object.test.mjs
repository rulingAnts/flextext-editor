/* drive_object stamping + resolution — the D1 half of moving Drive authorization into the database.
 *
 * The routes that create Drive objects are Drive-gated (real OAuth), so they cannot run on the local
 * rig. stampDriveObject / resolveDriveObject are the pure D1 functions, tested here directly against
 * real SQLite through a thin D1-shaped shim — the ACTUAL functions the worker calls.
 *
 * Run: node test/drive-object.test.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { stampDriveObject, resolveDriveObject } from '../worker/src/drive-object.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

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
  db.exec(`CREATE TABLE drive_object (
    object_id TEXT PRIMARY KEY, kind TEXT NOT NULL, doc_id TEXT, instance_id TEXT,
    project_id TEXT, created_by TEXT, created_at INTEGER NOT NULL);`);
  return db;
}

console.log('drive_object — stamp on creation, resolve for authorization\n');

console.log('a stamp is resolvable by object id, and carries the project that authorizes it');
{
  const db = freshDb();
  await stampDriveObject(d1(db), { objectId: 'folder-A', kind: 'text', docId: 'doc1', instanceId: 'devA', projectId: 'projX', createdBy: 'rsr1', now: 1000 });
  const row = await resolveDriveObject(d1(db), 'folder-A');
  ok(row && row.project_id === 'projX', 'resolves to the authorizing project');
  ok(row && row.kind === 'text' && row.doc_id === 'doc1' && row.instance_id === 'devA', 'and carries kind/doc/instance for display + scoping');
  ok(row && row.created_by === 'rsr1', 'and who created it');
}

console.log('\nan unknown object resolves to null — NOT to "allowed" (fails closed for a member)');
{
  const db = freshDb();
  ok((await resolveDriveObject(d1(db), 'never-stamped')) === null, 'a never-stamped id is null');
  ok((await resolveDriveObject(d1(db), '')) === null, 'and an empty id is null, not a query');
}

console.log('\nre-stamping UPDATES the location but PRESERVES the creation facts');
{
  const db = freshDb();
  await stampDriveObject(d1(db), { objectId: 'folder-B', kind: 'text', docId: 'doc2', instanceId: 'devA', projectId: 'projX', createdBy: 'rsr1', now: 1000 });
  // the device (and its text folder) MOVES to another project — re-stamp with the new project_id and a later clock
  await stampDriveObject(d1(db), { objectId: 'folder-B', kind: 'text', docId: 'doc2', instanceId: 'devA', projectId: 'projY', createdBy: 'rsr-other', now: 2000 });
  const row = await resolveDriveObject(d1(db), 'folder-B');
  ok(row.project_id === 'projY', '⚠ project_id tracks where the object is NOW — the move is reflected');
  ok(row.created_by === 'rsr1', '⚠ but created_by is unchanged — a creation fact, not overwritten by the mover');
  ok(db.prepare('SELECT created_at FROM drive_object WHERE object_id=?').get('folder-B').created_at === 1000,
     '⚠ and created_at is unchanged — the object was made once');
  ok(db.prepare('SELECT COUNT(*) c FROM drive_object WHERE object_id=?').get('folder-B').c === 1,
     'still exactly one row — upsert, not a duplicate');
}

console.log('\na malformed stamp writes nothing (never a row that cannot be resolved)');
{
  const db = freshDb();
  await stampDriveObject(d1(db), { objectId: '', kind: 'text', now: 1 });
  await stampDriveObject(d1(db), { objectId: 'x', kind: '', now: 1 });
  ok(db.prepare('SELECT COUNT(*) c FROM drive_object').get().c === 0, 'no object id or no kind → no row');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nPASS\n');
process.exit(fail ? 1 : 0);
