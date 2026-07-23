-- migrate-instance-type-unified.sql (Item A) — allow '' (unified) for instance.type.
-- The old CHECK (type IN ('editor','recorder')) rejects the new unified type '', so createInstance
-- fails. SQLite can't ALTER a CHECK in place, so rebuild the table preserving ALL existing rows.
-- No foreign key references `instance`, so this is self-contained. Idempotent-ish: only run once.
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
