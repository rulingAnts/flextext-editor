/* D1 side of un-migrating a project — the half worker/src/v1.js's unmigrate route USED TO SKIP.
 *
 * ⚠ WHY THIS IS A DEFECT AND NOT A TIDY-UP (2026-08-24 uncovered sweep, finding #7, HIGH). The
 * unmigrate route reparents Drive containers back under master and trashes the emptied project
 * folder, but it never touched D1 — so `instance.project_id` still named a project that no longer
 * existed, the `project` row survived, and its `project_member` rows survived with it. authMember
 * resolves an instance's authorization THROUGH `instance.project_id` → `project` → `project_member`,
 * so a coworker kept `manageDevices` over devices the owner believed they had un-shared. reconcile
 * cannot heal it: it only fills a NULL project_id, never clears a stale one. Authorization outlived
 * the project the owner dismantled.
 *
 * ⚠ EXTRACTED INTO ITS OWN MODULE ON PURPOSE. The route is Drive-gated (needs a real OAuth token), so
 * it cannot run on the hermetic local rig; this pure function takes only the D1 binding and is
 * exercised directly by test/project-teardown.test.mjs against a real SQLite. Keeping it here rather
 * than inline is what makes the fix testable at all.
 *
 * `db` is a D1-shaped binding: db.prepare(sql).bind(...args).run() / .first(). Nothing
 * Cloudflare-specific lives here, which is what lets the test import it under a thin shim.
 */

/* Forget, in D1, the containers that have just moved back under master, and — only when the project
 * was FULLY emptied and trashed in Drive — the project itself and every membership of it.
 *
 * @param movedFolderIds  oauth_folder_id of each container actually reparented back to master. Those
 *                        devices/crowd recorders are unassigned now, so their project_id → NULL.
 * @param projectDriveFolderId  the Drive id of the project folder (project.drive_folder_id).
 * @param fullyDismantled  true only when the folder was emptied AND trashed. Deleting the project +
 *                         its members is gated on this so a PARTIAL unmigrate (some container failed
 *                         to move, folder still holds things) never tears down a project still in use.
 * @returns { unassigned, forgottenProjectId } for the caller to log / return.
 */
export async function teardownUnmigratedProjectRows(db, ownerId, movedFolderIds, projectDriveFolderId, fullyDismantled) {
  let unassigned = 0;
  if (Array.isArray(movedFolderIds) && movedFolderIds.length) {
    const ph = movedFolderIds.map(() => '?').join(',');
    /* Scoped to the owner's OWN rows AND to the exact folders that moved — never a blanket
     * "everything in this project", so a container that FAILED to move keeps its project_id and a
     * later pass can finish it. A device folder is an instance; a crowd folder is a crowd_recorder;
     * both are keyed by oauth_folder_id, so both are cleared. */
    const inst = await db.prepare(
      `UPDATE instance SET project_id=NULL WHERE researcher_id=? AND oauth_folder_id IN (${ph})`
    ).bind(ownerId, ...movedFolderIds).run();
    const crowd = await db.prepare(
      `UPDATE crowd_recorder SET project_id=NULL WHERE researcher_id=? AND oauth_folder_id IN (${ph})`
    ).bind(ownerId, ...movedFolderIds).run();
    unassigned = ((inst && inst.meta && inst.meta.changes) || 0) + ((crowd && crowd.meta && crowd.meta.changes) || 0);
  }

  let forgottenProjectId = null;
  if (fullyDismantled && projectDriveFolderId) {
    const proj = await db.prepare('SELECT project_id FROM project WHERE drive_folder_id=? AND owner_id=?')
      .bind(projectDriveFolderId, ownerId).first();
    if (proj && proj.project_id) {
      /* Members FIRST, then the project — the reverse would briefly leave membership rows pointing at
       * a project that is gone. Neither order is unsafe (both are just DELETEs), but this reads as
       * "dissolve the memberships, then remove the thing they were memberships of".
       *
       * ⚠ member_key rows that snapshot this project_id are intentionally NOT touched here. Grant
       * authorization is re-derived at READ time from the instance's CURRENT project (see
       * GET /v1/researcher/keys), and those instances are now NULL project_id = owner-only, so an
       * orphaned snapshot grants nothing. The member-removal path already collects '' -sentinel and
       * instance-resolved grants; leaving the rows here avoids a second, divergent deletion rule. */
      await db.prepare('DELETE FROM project_member WHERE project_id=?').bind(proj.project_id).run();
      await db.prepare('DELETE FROM project WHERE project_id=? AND owner_id=?').bind(proj.project_id, ownerId).run();
      forgottenProjectId = proj.project_id;
    }
  }
  return { unassigned, forgottenProjectId };
}
