/* Stamp a drive_object row when the worker creates (or re-resolves) a Drive folder or file.
 *
 * ⚠ THE INVARIANT THIS EXISTS TO HOLD: creation ⟹ stamped. A Drive object the worker makes without a
 * drive_object row is a hole in the per-project authorization that Phase 3 will resolve here — the
 * object would be denied to members with no way to reach it. So every driveEnsure* / upload path
 * calls this, and it is kept in one place rather than inlined so it cannot be forgotten at one site.
 *
 * ⚠ EXTRACTED INTO ITS OWN MODULE like project-teardown.js, and for the same reason: the routes that
 * create Drive objects are Drive-gated and cannot run on the hermetic rig, so the D1 half is a pure
 * function exercised directly by test/drive-object.test.mjs against real SQLite through a thin shim.
 *
 * `db` is a D1-shaped binding: db.prepare(sql).bind(...args).run(). Nothing Cloudflare-specific here.
 *
 * See plans/drive-object-plan.md (build phases) and worker/migrate-drive-object.sql (the table).
 */

/* @param objectId   the Drive file OR folder id (the primary key).
 * @param kind       device | text | originals | project | unassigned | crowd | file
 * @param docId      flextext docId — for a text folder and the files inside it; NULL for the rest.
 * @param instanceId the owning device; NULL for account-level objects (project, unassigned).
 * @param projectId  ⚠ THE AUTHORIZATION KEY, where the object is NOW. NULL = unassigned (fails closed
 *                   for members; the owner still reaches it through ownership).
 * @param createdBy  researcher_id that created it (a CREATION fact — preserved across re-stamps).
 * @param now        ms timestamp.
 */
export async function stampDriveObject(db, { objectId, kind, docId = null, instanceId = null, projectId = null, createdBy = null, now }) {
  if (!objectId || !kind) return;   // nothing to key on — never write a row that cannot be resolved
  /* ⚠ UPSERT that splits IMMUTABLE creation facts from the MUTABLE location. On a re-stamp (the same
   * folder re-encountered, or re-resolved by tag), created_at and created_by are LEFT ALONE — they
   * record who made it and when, which do not change — while kind/doc_id/instance_id/project_id are
   * refreshed to the current truth. project_id in particular MUST track where the object is now, not
   * a creation-time snapshot; that snapshot mistake is exactly what made member_key removal miss
   * moved grants (see the read-time key-scoping fix). Moves keep it current by re-stamping. */
  await db.prepare(
    'INSERT INTO drive_object (object_id, kind, doc_id, instance_id, project_id, created_by, created_at) '
    + 'VALUES (?,?,?,?,?,?,?) '
    + 'ON CONFLICT(object_id) DO UPDATE SET kind=excluded.kind, doc_id=excluded.doc_id, '
    + 'instance_id=excluded.instance_id, project_id=excluded.project_id'
  ).bind(objectId, kind, docId, instanceId, projectId, createdBy, now).run();
}

/* Resolve a Drive object to the project that authorizes it — the single indexed lookup Phase 3's
 * routes use in place of an account-wide tag search. Returns the row (object_id, kind, doc_id,
 * instance_id, project_id, created_by) or null when the object is unknown to us.
 *
 * ⚠ A null return is NOT "allowed" — it is "we did not create this / have not backfilled it", which
 * fails closed for a member. The owner reaches their own objects through ownership regardless. */
export async function resolveDriveObject(db, objectId) {
  if (!objectId) return null;
  return (await db.prepare(
    'SELECT object_id, kind, doc_id, instance_id, project_id, created_by FROM drive_object WHERE object_id=?'
  ).bind(objectId).first()) || null;
}

/* THE BACKFILL BRAIN (Phase 2). Given the whole Drive file list (driveListAll) plus two D1 maps,
 * derive one drive_object row per object by walking parentage — the pure, testable half of the
 * operator-gated backfill route, which only fetches the inputs and batch-inserts the output.
 *
 * @param files          [{ id, parents:[id], appProperties:{flextextRole?,flextextDoc?}, mimeType }]
 * @param deviceByFolder Map|obj  device folder id → { instanceId, projectId }  (instance.oauth_folder_id)
 * @param projByFolder   Map|obj  project folder id → projectId                 (project.drive_folder_id)
 * @param ownerId        the researcher whose estate this is (created_by)
 * @returns [{ objectId, kind, docId, instanceId, projectId, createdBy, now }]
 *
 * ⚠ project_id is WHERE THE OBJECT PHYSICALLY SITS NOW: a project-folder ANCESTOR wins over the
 * device's own instance.project_id, because parentage is the current truth and instance.project_id
 * can lag. Falls back to the device's project when there is no project-folder ancestor (a device
 * still directly under master). Fails to NULL (unassigned, member-denied) when nothing resolves.
 */
export function deriveDriveObjectRows(files, deviceByFolder, projByFolder, ownerId, now) {
  const byId = new Map();
  for (const f of (files || [])) byId.set(f.id, f);
  const get = (m, id) => m && (typeof m.get === 'function' ? m.get(id) : m[id]);
  const isFolder = (f) => f.mimeType === 'application/vnd.google-apps.folder';
  const rows = [];
  for (const f of (files || [])) {
    const ap = f.appProperties || {};
    const role = ap.flextextRole || '';
    if (role === 'uploads-master') continue;                 // the master is not a project object
    let kind;
    if (role === 'project') kind = 'project';
    else if (role === 'crowd') kind = 'crowd';
    else if (role === 'unassigned') kind = 'unassigned';
    else if (role === 'originals') kind = 'originals';
    else if (ap.flextextDoc) kind = 'text';
    else if (isFolder(f)) kind = get(deviceByFolder, f.id) ? 'device' : 'folder';
    else kind = 'file';

    let instanceId = null, projectId = null, docId = ap.flextextDoc || null;
    let cur = f, guard = 0;
    while (cur && guard++ < 64) {
      const d = get(deviceByFolder, cur.id);
      if (d) { if (instanceId == null) instanceId = d.instanceId || null; if (projectId == null) projectId = d.projectId || null; }
      const p = get(projByFolder, cur.id);
      if (p) projectId = p;                                   // a project-folder ancestor is authoritative
      const fdoc = (cur.appProperties || {}).flextextDoc;
      if (fdoc && docId == null) docId = fdoc;
      const parentId = (cur.parents && cur.parents[0]) || null;
      cur = parentId ? byId.get(parentId) : null;
    }
    if (kind === 'project') { instanceId = null; const p = get(projByFolder, f.id); if (p) projectId = p; }
    rows.push({ objectId: f.id, kind, docId: docId || null, instanceId: instanceId || null, projectId: projectId || null, createdBy: ownerId || null, now });
  }
  return rows;
}
