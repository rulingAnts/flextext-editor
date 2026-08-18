-- migrate-instance-type-unified.sql (Item A) — allow '' (unified) for instance.type.
-- The old CHECK (type IN ('editor','recorder')) rejects the new unified type '', so createInstance
-- fails. SQLite can't ALTER a CHECK in place, so rebuild the table preserving ALL existing rows.
-- No foreign key references `instance`, so this is self-contained. Idempotent-ish: only run once.
--
-- 🚩🚩 DO NOT RE-RUN THIS FILE, AND DO NOT COPY ITS SHAPE. It rebuilds `instance` from the FIXED
-- column list below, so every column added to that table AFTER this file was written is silently
-- DESTROYED, along with its data. As of 2026-08-17 that is `oauth_folder_id`, `estate` and
-- `project_id` — and the list grows every time the schema does, which is what makes a rebuild-style
-- migration a landmine that gets more dangerous with age rather than less.
--
-- It is harmless in production only because it ran BEFORE any of those columns existed. A fresh
-- database must be created from `schema-current.sql`, never by replaying the historical files in
-- file order — replaying them is exactly how the STAGING database lost two columns (see
-- worker/topup-staging.sql). `test/worker-schema.test.mjs` asserts the loss list above, so adding a
-- column to `instance` will fail that test and bring whoever does it here to read this.
CREATE TABLE instance_new (
  instance_id   TEXT PRIMARY KEY,
  researcher_id TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('editor','recorder','')),
  nickname      TEXT NOT NULL,
  desired_blob  TEXT,
  desired_rev   INTEGER NOT NULL DEFAULT 0,
  revoked       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
INSERT INTO instance_new (instance_id, researcher_id, type, nickname, desired_blob, desired_rev, revoked, created_at)
  SELECT instance_id, researcher_id, type, nickname, desired_blob, desired_rev, revoked, created_at FROM instance;
DROP TABLE instance;
ALTER TABLE instance_new RENAME TO instance;
CREATE INDEX IF NOT EXISTS idx_instance_researcher ON instance(researcher_id);
