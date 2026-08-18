-- migrate-projects.sql — Phase B of the researcher/project split: projects become real.
--
-- ADDITIVE ONLY, and deliberately boring: three new tables, two nullable columns on `researcher`,
-- one nullable column each on `instance` and `crowd_recorder`. No table is rebuilt and no existing
-- column changes meaning, per the rules PART III round 2 (R2-6) set after `migrate-instance-type-
-- unified.sql` was found to destroy every column added after it.
--
-- ⚠ THIS FILE CREATES NO ROWS. Minting a default project per researcher needs GUIDs and derived
-- names — beyond what is reviewable in D1 SQL (round-1 finding 7) — so the backfill runs as an
-- operator-gated, idempotent worker endpoint (POST /v1/researcher/admin/backfill-projects) that can
-- be re-run safely and reports what it did. Schema first, data second, each verifiable on its own.
--
-- ⚠ `instance.researcher_id` IS NOT REPLACED and must never be dropped (round-1 finding 4). Device
-- uploads and crowd submissions resolve the Drive refresh token through
-- `instance JOIN researcher ON researcher_id`, a join old APKs will exercise forever. It is
-- REDEFINED as a maintained denormalisation: always equal to the project's owner_id, updated in the
-- same transaction as any ownership transfer. Old clients' joins then stay correct permanently.
--
--   wrangler d1 execute <db> --remote --file=migrate-projects.sql

CREATE TABLE IF NOT EXISTS project (
  project_id   TEXT PRIMARY KEY,             -- GUID
  owner_id     TEXT NOT NULL,                -- researcher_id of the ONE owner
  name         TEXT NOT NULL,                -- plaintext, like instance.nickname
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_owner ON project(owner_id);

CREATE TABLE IF NOT EXISTS project_member (
  project_id    TEXT NOT NULL,
  researcher_id TEXT NOT NULL,               -- the member (the OWNER has no row here; ownership is project.owner_id)
  caps          TEXT NOT NULL DEFAULT '{}',  -- {"see":"all"|[instanceId…],"manageDevices":…,"assignTexts":…,
                                             --  "createInvites":bool,"drive":"read"|"manage"} — owner-written JSON
  added_at      INTEGER NOT NULL,
  added_by      TEXT NOT NULL,
  PRIMARY KEY (project_id, researcher_id)
);

-- The Ki grant ledger — what makes owner key sovereignty checkable rather than asserted.
-- ⚠ THE OWNER HAS A ROW HERE TOO. That is the invariant the worker enforces on every key write: no
-- grant set may exist without a wrap to the project's owner, so a member with `createInvites` can
-- never mint a device key the owner cannot read. The worker can only check that the owner's copy
-- EXISTS, not that its ciphertext is well-formed — it cannot read it — which makes sabotage
-- DETECTABLE (loudly, the first time the owner opens that device) rather than silently possible.
CREATE TABLE IF NOT EXISTS member_key (
  project_id    TEXT NOT NULL,
  instance_id   TEXT NOT NULL,
  researcher_id TEXT NOT NULL,               -- grantee
  key_version   INTEGER NOT NULL DEFAULT 1,  -- rotation-ready from day one, so rotation is an addition, not a migration
  wrapped_ki    TEXT NOT NULL,               -- RSA-OAEP to the grantee's researcher pubkey; opaque to the worker
  wrapped_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (instance_id, researcher_id, key_version)
);
CREATE INDEX IF NOT EXISTS idx_member_key_project ON member_key(project_id);

-- The researcher keypair. Nothing wraps researcher-to-researcher today because there is nothing to
-- wrap TO — this is the entire crypto delta of the split. The private key is wrapped under Kr so it
-- FOLLOWS THE ACCOUNT to a second browser, which is what multi-session requires.
ALTER TABLE researcher ADD COLUMN pubkey TEXT;           -- SPKI b64, like install.pubkey
ALTER TABLE researcher ADD COLUMN wrapped_privkey TEXT;  -- PKCS8 wrapped under Kr, client-side

-- The project pointer. Nullable, and dual-read with researcher_id until every route is converted.
ALTER TABLE instance       ADD COLUMN project_id TEXT;
ALTER TABLE crowd_recorder ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_instance_project ON instance(project_id);
