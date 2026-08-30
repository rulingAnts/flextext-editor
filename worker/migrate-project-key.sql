-- PROJECT KEY (Kp) — Phase 1 of the project-key rework (plans/BACKLOG.md "DECIDED DIRECTION",
-- approved by Seth 2026-08-28). This migration is deliberately INERT: it creates storage that
-- nothing reads until the operator runs the backfill, and no client or route changes behaviour.
--
-- WHAT Kp IS. One symmetric key per project, held by the WORKER (encrypted at rest under
-- serverAesKey, exactly like drive_refresh_enc and kr_server_enc), never sent to any client.
-- Device Ki gets wrapped under Kp once (instance.ki_kp), so that Phase 2 can collapse the
-- O(devices x members) member_key fan-out to one wrap per member and one per device, and can
-- delegate device approval by having the WORKER mint install wraps itself.
--
-- ⚠ THIS DOES NOT CHANGE WHO CAN READ WHAT. The worker can ALREADY derive every Ki through the
-- escrow chain (kr_server_enc -> Kr -> settings_blob.wrappedKis / wrapped_privkey -> member_key).
-- Kp formalises that reach per-project instead of leaving it implicit account-wide. The property
-- that survives, unchanged: a D1 dump alone, without the worker secret, yields nothing.
--
-- ⚠ member_key IS NOT TOUCHED and stays materialised FOREVER (Phase 4 of the old plan is
-- abandoned): it is the recovery path, the integrity cross-check, and what keeps old panels
-- working. See plans/BACKLOG.md, "the reconciliation".
--
-- ⚠ ADDITIVE AND NULLABLE, so the currently deployed worker keeps working against a migrated
-- database — it never selects these. That is the backend-first order this repo requires.
CREATE TABLE IF NOT EXISTS project_key (
  project_id  TEXT PRIMARY KEY,             -- one Kp per project
  kp_enc      TEXT NOT NULL,                -- encAtRest(b64(Kp)) — worker-held, never client-held
  key_version INTEGER NOT NULL DEFAULT 1,   -- rotation-ready from day one (the member_key lesson)
  created_at  INTEGER NOT NULL
);
ALTER TABLE instance ADD COLUMN ki_kp TEXT;              -- AES-GCM(Kp, {k: b64(Ki)}) as "iv.ct"
ALTER TABLE instance ADD COLUMN ki_kp_version INTEGER;   -- which Kp key_version wrapped it
