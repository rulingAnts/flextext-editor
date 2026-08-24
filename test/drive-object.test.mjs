/* drive_object stamping + resolution — the D1 half of moving Drive authorization into the database.
 *
 * The routes that create Drive objects are Drive-gated (real OAuth), so they cannot run on the local
 * rig. stampDriveObject / resolveDriveObject are the pure D1 functions, tested here directly against
 * real SQLite through a thin D1-shaped shim — the ACTUAL functions the worker calls.
 *
 * Run: node test/drive-object.test.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { stampDriveObject, resolveDriveObject, deriveDriveObjectRows } from '../worker/src/drive-object.js';

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

console.log('\nthe backfill brain derives project/instance/doc by walking parentage');
{
  const FOLDER = 'application/vnd.google-apps.folder';
  // master > projectFolderP (project P) > deviceFolderD (device D, instance.projectId=P) > textT (doc1) > originalsO > file1
  // master > deviceFolderE (device E, instance.projectId=NULL — dual-read) directly (unassigned)
  // master > crowdFolderC (crowd, project P)
  const files = [
    { id: 'master', parents: [], appProperties: { flextextRole: 'uploads-master' }, mimeType: FOLDER },
    { id: 'projP',  parents: ['master'], appProperties: { flextextRole: 'project' }, mimeType: FOLDER },
    { id: 'devD',   parents: ['projP'], appProperties: {}, mimeType: FOLDER },
    { id: 'textT',  parents: ['devD'], appProperties: { flextextDoc: 'doc1' }, mimeType: FOLDER },
    { id: 'origO',  parents: ['textT'], appProperties: { flextextRole: 'originals' }, mimeType: FOLDER },
    { id: 'file1',  parents: ['origO'], appProperties: {}, mimeType: 'application/octet-stream' },
    { id: 'devE',   parents: ['master'], appProperties: {}, mimeType: FOLDER },
    { id: 'crowdC', parents: ['master'], appProperties: { flextextRole: 'crowd' }, mimeType: FOLDER },
  ];
  const deviceByFolder = new Map([['devD', { instanceId: 'D', projectId: 'P' }], ['devE', { instanceId: 'E', projectId: null }], ['crowdC', { instanceId: null, projectId: 'P' }]]);
  const projByFolder = new Map([['projP', 'P']]);
  const rows = deriveDriveObjectRows(files, deviceByFolder, projByFolder, 'owner1', 5);
  const byId = Object.fromEntries(rows.map((r) => [r.objectId, r]));

  ok(!byId['master'], 'the master folder is skipped — it is not a project object');
  ok(byId['projP'] && byId['projP'].kind === 'project' && byId['projP'].projectId === 'P' && byId['projP'].instanceId === null,
     'the project folder → kind=project, its own project, no instance');
  ok(byId['devD'] && byId['devD'].kind === 'device' && byId['devD'].projectId === 'P' && byId['devD'].instanceId === 'D',
     'the device folder → device, project P, instance D');
  ok(byId['textT'] && byId['textT'].kind === 'text' && byId['textT'].docId === 'doc1' && byId['textT'].projectId === 'P' && byId['textT'].instanceId === 'D',
     'the text folder → text, doc1, inherits project P + instance D by walking up');
  ok(byId['origO'] && byId['origO'].kind === 'originals' && byId['origO'].docId === 'doc1' && byId['origO'].projectId === 'P',
     'the originals child → originals, doc1 from its text-folder ancestor, project P');
  ok(byId['file1'] && byId['file1'].kind === 'file' && byId['file1'].docId === 'doc1' && byId['file1'].projectId === 'P' && byId['file1'].instanceId === 'D',
     '⚠ the FILE deep under originals still resolves doc1 + project P + instance D — the whole point of the walk');
  ok(byId['devE'] && byId['devE'].kind === 'device' && byId['devE'].projectId === null,
     'a device still directly under master → project NULL (unassigned, fails closed for a member)');
  ok(byId['crowdC'] && byId['crowdC'].kind === 'crowd' && byId['crowdC'].projectId === 'P',
     'a crowd folder → crowd, its project');
  ok(rows.every((r) => r.createdBy === 'owner1' && r.now === 5), 'every row carries the owner + timestamp');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nPASS\n');
process.exit(fail ? 1 : 0);
