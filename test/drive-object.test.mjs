/* drive_object stamping + resolution — the D1 half of moving Drive authorization into the database.
 *
 * The routes that create Drive objects are Drive-gated (real OAuth), so they cannot run on the local
 * rig. stampDriveObject / resolveDriveObject are the pure D1 functions, tested here directly against
 * real SQLite through a thin D1-shaped shim — the ACTUAL functions the worker calls.
 *
 * Run: node test/drive-object.test.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { stampDriveObject, resolveDriveObject, deriveDriveObjectRows,
         moveDriveObjectText, moveDriveObjectContainer,
         authorizeDocForProject, authorizeObjectForProject } from '../worker/src/drive-object.js';

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
        all() { return { results: st.all(...args) }; },
      };
    },
  };
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE drive_object (
    object_id TEXT PRIMARY KEY, kind TEXT NOT NULL, doc_id TEXT, instance_id TEXT,
    project_id TEXT, created_by TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE instance (instance_id TEXT PRIMARY KEY, researcher_id TEXT, oauth_folder_id TEXT, project_id TEXT, revoked INTEGER DEFAULT 0);
  CREATE TABLE project (project_id TEXT PRIMARY KEY, owner_id TEXT, drive_folder_id TEXT);`);
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

console.log('\nMOVE-SYNC — drive_object.project_id must track every re-parent (issue #13\'s D1 half)');

console.log('\na text move re-homes the WHOLE doc — folder, originals, files — in one act');
{
  const db = freshDb();
  db.exec(`INSERT INTO instance VALUES ('devA','owner1','fldA','P1',0), ('devB','owner1','fldB','P2',0);
           INSERT INTO project VALUES ('P1','owner1','pf1'), ('P2','owner1','pf2');`);
  for (const [oid, kind] of [['tf', 'text'], ['of', 'originals'], ['f1', 'file'], ['f2', 'file']]) {
    await stampDriveObject(d1(db), { objectId: oid, kind, docId: 'doc9', instanceId: 'devA', projectId: 'P1', createdBy: 'owner1', now: 1 });
  }
  // device A (P1) → device B (P2): the cross-project device-to-device move
  await moveDriveObjectText(d1(db), { docId: 'doc9', ownerId: 'owner1', projectId: 'P2', instanceId: 'devB' });
  const rows = db.prepare("SELECT object_id, project_id, instance_id FROM drive_object WHERE doc_id='doc9'").all();
  ok(rows.length === 4 && rows.every((x) => x.project_id === 'P2' && x.instance_id === 'devB'),
     'all four rows now carry project P2 + device B');
}

console.log('\nfiling into Unassigned clears the instance — an unassigned text belongs to no device');
{
  const db = freshDb();
  db.exec(`INSERT INTO instance VALUES ('devA','owner1','fldA','P1',0);
           INSERT INTO project VALUES ('P1','owner1','pf1'), ('P2','owner1','pf2');`);
  await stampDriveObject(d1(db), { objectId: 'tf', kind: 'text', docId: 'doc9', instanceId: 'devA', projectId: 'P1', createdBy: 'owner1', now: 1 });
  await moveDriveObjectText(d1(db), { docId: 'doc9', ownerId: 'owner1', projectId: 'P2', instanceId: null });
  const row = db.prepare("SELECT project_id, instance_id FROM drive_object WHERE object_id='tf'").get();
  ok(row.project_id === 'P2' && row.instance_id === null,
     '⚠ project P2, instance NULL — the #13 shape: a cross-project Unassigned filing the sync must record');
}

console.log('\n⚠ OWNER SCOPING: a same-docId row in ANOTHER account must not move (doc_id is client-minted)');
{
  const db = freshDb();
  db.exec(`INSERT INTO instance VALUES ('devA','owner1','fldA','P1',0), ('devX','owner2','fldX','PX',0);
           INSERT INTO project VALUES ('P1','owner1','pf1'), ('P2','owner1','pf2'), ('PX','owner2','pfx');`);
  // Same doc_id in two estates — three ownership shapes for owner1, one row for owner2.
  await stampDriveObject(d1(db), { objectId: 'mine-inst', kind: 'text', docId: 'dup', instanceId: 'devA', projectId: null, createdBy: 'member9', now: 1 });
  await stampDriveObject(d1(db), { objectId: 'mine-proj', kind: 'file', docId: 'dup', instanceId: null, projectId: 'P1', createdBy: 'member9', now: 1 });
  await stampDriveObject(d1(db), { objectId: 'mine-created', kind: 'file', docId: 'dup', instanceId: null, projectId: null, createdBy: 'owner1', now: 1 });
  await stampDriveObject(d1(db), { objectId: 'theirs', kind: 'text', docId: 'dup', instanceId: 'devX', projectId: 'PX', createdBy: 'owner2', now: 1 });
  await moveDriveObjectText(d1(db), { docId: 'dup', ownerId: 'owner1', projectId: 'P2', instanceId: null });
  const p = (oid) => db.prepare('SELECT project_id FROM drive_object WHERE object_id=?').get(oid).project_id;
  ok(p('mine-inst') === 'P2', 'owner-instance row moved (member-created, matched via the instance clause)');
  ok(p('mine-proj') === 'P2', 'owner-project row moved');
  ok(p('mine-created') === 'P2', 'owner-created row moved');
  ok(p('theirs') === 'PX', '⚠⚠ the OTHER account\'s same-docId row did NOT move — the scoping is the security property');
  ok((await (async () => { await moveDriveObjectText(d1(db), { docId: '', ownerId: 'owner1' }); await moveDriveObjectText(d1(db), { docId: 'dup', ownerId: '' }); return p('theirs'); })()) === 'PX',
     'and a missing docId or owner writes nothing at all');
}

console.log('\na container move re-homes the folder row AND every row of the instance that owns it');
{
  const db = freshDb();
  db.exec(`INSERT INTO instance VALUES ('devA','owner1','fldA','P1',0), ('devB','owner1','fldB','P1',0);
           INSERT INTO project VALUES ('P1','owner1','pf1'), ('P2','owner1','pf2');`);
  await stampDriveObject(d1(db), { objectId: 'fldA', kind: 'device', instanceId: 'devA', projectId: 'P1', createdBy: 'owner1', now: 1 });
  await stampDriveObject(d1(db), { objectId: 'tA', kind: 'text', docId: 'd1', instanceId: 'devA', projectId: 'P1', createdBy: 'owner1', now: 1 });
  await stampDriveObject(d1(db), { objectId: 'fA', kind: 'file', docId: 'd1', instanceId: 'devA', projectId: 'P1', createdBy: 'owner1', now: 1 });
  await stampDriveObject(d1(db), { objectId: 'fldB', kind: 'device', instanceId: 'devB', projectId: 'P1', createdBy: 'owner1', now: 1 });
  await moveDriveObjectContainer(d1(db), { folderId: 'fldA', projectId: 'P2' });
  const p = (oid) => db.prepare('SELECT project_id FROM drive_object WHERE object_id=?').get(oid).project_id;
  ok(p('fldA') === 'P2' && p('tA') === 'P2' && p('fA') === 'P2', 'device folder + its text + its file all moved to P2');
  ok(p('fldB') === 'P1', 'the sibling device did NOT move');
  // unmigrate shape: back to no project
  await moveDriveObjectContainer(d1(db), { folderId: 'fldA', projectId: null });
  ok(p('fldA') === null && p('tA') === null, 'projectId null (unmigrate) re-homes to unassigned — fails closed for members');
}

console.log('\na CROWD container (no instance) moves only its own folder row');
{
  const db = freshDb();
  db.exec(`INSERT INTO project VALUES ('P1','owner1','pf1'), ('P2','owner1','pf2');`);
  await stampDriveObject(d1(db), { objectId: 'crowdF', kind: 'crowd', instanceId: null, projectId: 'P1', createdBy: 'owner1', now: 1 });
  await stampDriveObject(d1(db), { objectId: 'crowdText', kind: 'text', docId: 'cs1', instanceId: null, projectId: 'P1', createdBy: 'owner1', now: 1 });
  await moveDriveObjectContainer(d1(db), { folderId: 'crowdF', projectId: 'P2' });
  const p = (oid) => db.prepare('SELECT project_id FROM drive_object WHERE object_id=?').get(oid).project_id;
  ok(p('crowdF') === 'P2', 'the crowd folder row moved');
  ok(p('crowdText') === 'P1', 'its submission rows stay put (no instance key) — healed by the backfill, honestly not synced here');
}

console.log('\nPHASE 3 GATES — the per-project repair of the nine account-wide findings');

console.log('\nauthorizeDocForProject: a member reaches only their own project\'s docs');
{
  const db = freshDb();
  db.exec(`INSERT INTO instance VALUES ('devA','owner1','fldA','P1',0), ('devR','owner1','fldR','P1',1);
           INSERT INTO project VALUES ('P1','owner1','pf1'), ('P2','owner1','pf2');`);
  await stampDriveObject(d1(db), { objectId: 'tfA', kind: 'text', docId: 'docA', instanceId: 'devA', projectId: 'P1', createdBy: 'owner1', now: 1 });
  await stampDriveObject(d1(db), { objectId: 'tfB', kind: 'text', docId: 'docB', instanceId: null, projectId: 'P2', createdBy: 'owner1', now: 1 });
  await stampDriveObject(d1(db), { objectId: 'tfR', kind: 'text', docId: 'docR', instanceId: 'devR', projectId: 'P1', createdBy: 'owner1', now: 1 });

  let g = await authorizeDocForProject(d1(db), { docId: 'docA', projectId: 'P1', isOwner: false });
  ok(g.allowed && g.folderId === 'tfA', 'their own project\'s doc: allowed, and the folder id comes back scoped (no Drive search)');
  g = await authorizeDocForProject(d1(db), { docId: 'docB', projectId: 'P1', isOwner: false });
  ok(!g.allowed, '⚠⚠ another project\'s doc: DENIED — the exact cross-project reach the nine findings shared');
  g = await authorizeDocForProject(d1(db), { docId: 'nowhere', projectId: 'P1', isOwner: false });
  ok(!g.allowed, 'an unknown doc: denied (fails closed — no row is not "allowed")');
  g = await authorizeDocForProject(d1(db), { docId: 'docR', projectId: 'P1', isOwner: false });
  ok(!g.allowed, '⚠ a REVOKED device\'s doc: denied even in their own project — the backfill stamped revoked estates too, and nothing upstream checks revoked');
  g = await authorizeDocForProject(d1(db), { docId: 'docA', projectId: '', isOwner: false });
  ok(!g.allowed, 'a member with no project (legacy/unassigned ctx): denied');
}

console.log('\nauthorizeDocForProject: mode=create lets a member MAKE a text without letting them squat one');
{
  const db = freshDb();
  db.exec("INSERT INTO project VALUES ('P1','owner1','pf1'), ('P2','owner1','pf2');");
  await stampDriveObject(d1(db), { objectId: 'tfB', kind: 'text', docId: 'docB', instanceId: null, projectId: 'P2', createdBy: 'owner1', now: 1 });
  let g = await authorizeDocForProject(d1(db), { docId: 'brand-new', projectId: 'P1', isOwner: false, mode: 'create' });
  ok(g.allowed && g.folderId === '', 'a doc known NOWHERE is a new text: allowed (creation will stamp it into P1)');
  g = await authorizeDocForProject(d1(db), { docId: 'docB', projectId: 'P1', isOwner: false, mode: 'create' });
  ok(!g.allowed, '⚠ but a doc that EXISTS in another project is not "new" — create mode still denies the squat');
  g = await authorizeDocForProject(d1(db), { docId: 'brand-new', projectId: 'P1', isOwner: false });
  ok(!g.allowed, 'and the default (existing) mode does NOT inherit create\'s leniency');
}

console.log('\nthe OWNER passes on ownership alone — wiring the gates changes nothing for production');
{
  const db = freshDb();
  db.exec("INSERT INTO project VALUES ('P1','owner1','pf1');");
  await stampDriveObject(d1(db), { objectId: 'tfA', kind: 'text', docId: 'docA', instanceId: null, projectId: 'P1', createdBy: 'owner1', now: 1 });
  let g = await authorizeDocForProject(d1(db), { docId: 'docA', projectId: '', isOwner: true });
  ok(g.allowed && g.folderId === 'tfA', 'owner + known doc: allowed, folder returned');
  g = await authorizeDocForProject(d1(db), { docId: 'never-stamped', projectId: '', isOwner: true });
  ok(g.allowed && g.folderId === '', '⚠ owner + UNKNOWN doc: still allowed with no folder — pre-drive_object objects keep working via the Drive fallback');
  const o = await authorizeObjectForProject(d1(db), { objectId: 'never-stamped', isOwner: true });
  ok(o.allowed, 'same for a raw object id');
}

console.log('\nauthorizeObjectForProject: file/folder ids obey the same boundary');
{
  const db = freshDb();
  db.exec(`INSERT INTO instance VALUES ('devR','owner1','fldR','P1',1);
           INSERT INTO project VALUES ('P1','owner1','pf1'), ('P2','owner1','pf2');`);
  await stampDriveObject(d1(db), { objectId: 'file1', kind: 'file', docId: 'd', instanceId: null, projectId: 'P1', createdBy: 'owner1', now: 1 });
  await stampDriveObject(d1(db), { objectId: 'file2', kind: 'file', docId: 'd', instanceId: null, projectId: 'P2', createdBy: 'owner1', now: 1 });
  await stampDriveObject(d1(db), { objectId: 'fileR', kind: 'file', docId: 'd', instanceId: 'devR', projectId: 'P1', createdBy: 'owner1', now: 1 });
  ok((await authorizeObjectForProject(d1(db), { objectId: 'file1', projectId: 'P1' })).allowed, 'member: own-project file allowed');
  ok(!(await authorizeObjectForProject(d1(db), { objectId: 'file2', projectId: 'P1' })).allowed, '⚠ other-project file denied');
  ok(!(await authorizeObjectForProject(d1(db), { objectId: 'fileR', projectId: 'P1' })).allowed, '⚠ revoked-device file denied');
  ok(!(await authorizeObjectForProject(d1(db), { objectId: 'ghost', projectId: 'P1' })).allowed, 'unknown file denied');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nPASS\n');
process.exit(fail ? 1 : 0);
