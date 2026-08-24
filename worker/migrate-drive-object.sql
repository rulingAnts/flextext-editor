-- drive_object (2026-08-24): Drive authorization moves into D1 — VII.1 / R2-1's "DO THIS FIRST".
--
-- ⚠ WHY. Phase C's Drive routes were scoped by folder PARENTAGE, but this codebase deliberately does
-- not treat parentage as identity — folders are found by appProperties TAG, never by where they sit,
-- and finished texts are re-parented into an account-level "Unassigned" that belongs to no device.
-- Authorizing by parentage would deny a member exactly the swept texts and any hand-filed folder. So
-- authorization moves here: one row per Drive object the worker creates, resolved by one indexed
-- lookup on object_id → project_id. Parentage becomes display only.
--
-- object_id   the Drive file OR folder id (PK — a Drive id is globally unique across both).
-- kind        device | text | originals | project | unassigned | crowd | file
-- doc_id      the flextext docId for a text folder and the files inside it; NULL for the rest.
-- instance_id the owning device; NULL for account-level objects (project, unassigned).
-- project_id  ⚠ THE AUTHORIZATION KEY. Tracks where the object IS now (updated on every move, never a
--             creation-time snapshot — the mistake member_key.project_id made). NULL = unassigned,
--             which fails closed for members (owner still reaches it through ownership).
-- created_by  the researcher_id that created it — lets "texts they made themselves" be expressed,
--             which nothing in the current model can.
--
-- ⚠ It starts EMPTY against the existing estate and needs a one-time idempotent backfill (Phase 2)
-- from driveListAll, or every pre-existing object is denied to members on day one. And it holds a
-- doc_id ↔ instance_id map in PLAINTEXT — consistent with the plaintext tier, but a deliberate
-- widening, recorded here and in plans/drive-object-plan.md.
--
-- Additive: the currently-deployed worker never reads this table, so it keeps working against a
-- database carrying it. Nothing authorizes on it until Phase 3 ships. Run ONCE.
--   wrangler d1 execute flextext-connectivity --remote --file=migrate-drive-object.sql

CREATE TABLE IF NOT EXISTS drive_object (
  object_id   TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  doc_id      TEXT,
  instance_id TEXT,
  project_id  TEXT,
  created_by  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS drive_object_project  ON drive_object(project_id);
CREATE INDEX IF NOT EXISTS drive_object_instance ON drive_object(instance_id);
CREATE INDEX IF NOT EXISTS drive_object_doc      ON drive_object(doc_id);
