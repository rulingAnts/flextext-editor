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
