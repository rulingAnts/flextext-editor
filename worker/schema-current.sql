-- CANONICAL CURRENT SCHEMA — the one file that recreates production's shape from scratch.
--
-- GENERATED, do not hand-edit: `node test/worker-schema.test.mjs --emit-schema` rewrites it by
-- replaying schema.sql + every migrate-*.sql statement-wise and dumping the result. The test then
-- asserts this file still matches that replay, so it cannot drift silently.
--
-- WHY IT EXISTS (Seth, 2026-08-17: "have a path to make [staging] basically mirror production
-- exactly before we make and test modifications to it"). The historical files CANNOT do that:
-- schema.sql has been folded forward, `d1 execute --file` is atomic so the resulting duplicate
-- aborts the whole file, and migrate-instance-type-unified.sql REBUILDS `instance` from a fixed
-- column list — replaying the files into a fresh database in file order silently loses
-- oauth_folder_id and estate. That is exactly how the staging D1 drifted. This file has none of
-- those hazards: plain CREATEs, no ALTERs, no rebuilds, applies in one atomic shot.
--
-- Verified identical to PRODUCTION's live schema on 2026-08-17 (all 9 tables, every column, all 7
-- indexes) via worker/schema-report.sql.
--
--   wrangler d1 execute <db> --remote --file=schema-current.sql     # fresh database only
--
-- ⚠ It creates; it does not migrate. Against a database that already has these tables the CREATEs
-- are IF NOT EXISTS no-ops and nothing is altered — use a migration for an existing database.
-- ⚠ It carries NO DATA, deliberately. See plans/project-split.md PART VI.4 for why production rows
-- must never be copied into staging: at-rest encryption is keyed by SERVER_HMAC_KEY, so the copy is
-- either undecryptable (different key) or turns staging into a second production holding live Drive
-- refresh tokens behind looser origin rules (same key).

CREATE TABLE IF NOT EXISTS approval_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,   -- ms since epoch
  kind    TEXT    NOT NULL,   -- account_signup | account_approved | account_auto_approved
  subject TEXT,               -- the e-mail address, or the domain
  detail  TEXT,               -- how/why: the label, the matched domain, 'owner allowlist', …
  actor   TEXT                -- e-mail of the owner who acted, or 'system' for automatic decisions
);

CREATE TABLE IF NOT EXISTS approved_domain (
  domain_hash TEXT PRIMARY KEY,   -- HMAC(SERVER_HMAC_KEY, 'domain:' + domain), hex
  note_enc    TEXT,               -- operator's own label, AES-GCM at rest (may name the org)
  created_at  INTEGER NOT NULL    -- ms since epoch
);

CREATE TABLE IF NOT EXISTS crowd_recorder (
  crowd_id        TEXT PRIMARY KEY,
  researcher_id   TEXT NOT NULL,
  estate          TEXT NOT NULL DEFAULT 'pages',  -- 'pages' | 'cloud' — which public URL this recorder's link uses, for its whole life. See migrate-estate.sql.
  label           TEXT NOT NULL DEFAULT '',
  enabled         INTEGER NOT NULL DEFAULT 1,
  config_json     TEXT NOT NULL DEFAULT '{}',  -- plaintext by design: the keyless public page must read it
  drive_folder    TEXT NOT NULL DEFAULT '',    -- relay-leg folder id — NEVER in the public projection
  oauth_folder_id TEXT,
  submit_count    INTEGER NOT NULL DEFAULT 0,
  bytes_total     INTEGER NOT NULL DEFAULT 0,
  day_key         TEXT NOT NULL DEFAULT '',
  day_count       INTEGER NOT NULL DEFAULT 0,
  max_per_day     INTEGER NOT NULL DEFAULT 200,
  max_bytes_total INTEGER NOT NULL DEFAULT 1073741824,
  created_at      INTEGER NOT NULL
, project_id TEXT);

CREATE TABLE IF NOT EXISTS crowd_submission (
  sub_id     TEXT PRIMARY KEY,
  crowd_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  country    TEXT DEFAULT '',
  ip_hmac    TEXT DEFAULT '',
  file_name  TEXT DEFAULT '',
  status     TEXT DEFAULT 'ok'
);

CREATE TABLE IF NOT EXISTS install (
  install_id    TEXT PRIMARY KEY,             -- GUID, CLIENT-minted (idempotent claim)
  instance_id   TEXT NOT NULL,
  secret_hash   TEXT NOT NULL,                -- SHA-256 of the client-minted install secret
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved')),
  reported_blob TEXT,                         -- device info + text/recording LIST (titleHash, not titles) + ack cursor, opaque
  reported_rev  INTEGER NOT NULL DEFAULT 0,
  ack_seq       INTEGER NOT NULL DEFAULT 0,   -- highest command seq the install has applied
  last_seen_at  INTEGER,
  revoked       INTEGER NOT NULL DEFAULT 0,   -- device replacement / lost device; rejects reads AND writes
  created_at    INTEGER NOT NULL,
  pubkey        TEXT,                         -- E2EE model A: install's RSA-OAEP public key (SPKI b64), sent at claim
  wrapped_key   TEXT                          -- E2EE model A: per-instance key Ki wrapped to this install's pubkey by the researcher (Worker NEVER sees Ki)
, accepted INTEGER NOT NULL DEFAULT 0, wipe_state  TEXT, wipe_at     INTEGER, wipe_hidden INTEGER NOT NULL DEFAULT 0, pair_code TEXT);

CREATE TABLE IF NOT EXISTS "instance" (
  instance_id   TEXT PRIMARY KEY,
  researcher_id TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('editor','recorder','')),
  nickname      TEXT NOT NULL,
  desired_blob  TEXT,
  desired_rev   INTEGER NOT NULL DEFAULT 0,
  revoked       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
, oauth_folder_id TEXT, estate TEXT NOT NULL DEFAULT 'pages', project_id TEXT, tokens_valid_from INTEGER, ki_kp TEXT, ki_kp_version INTEGER, create_key TEXT);

CREATE TABLE IF NOT EXISTS invite (
  invite_id       TEXT PRIMARY KEY,           -- GUID in the link
  instance_id     TEXT NOT NULL,
  secret_hash     TEXT NOT NULL,              -- SHA-256 of the invite secret (the #k= fragment)
  expires_at      INTEGER,                    -- enforced at claim time
  claimed_at      INTEGER,                    -- atomic single-use marker
  claimed_install TEXT,                       -- which client-minted install_id won the claim
  created_at      INTEGER NOT NULL
, invited_by TEXT);                           -- the researcher who minted it, shown at pairing so the field user sees who is linking them; NULL falls back to the instance owner (migrate-invite-inviter.sql)

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

CREATE TABLE IF NOT EXISTS project (
  project_id   TEXT PRIMARY KEY,             -- GUID
  owner_id     TEXT NOT NULL,                -- researcher_id of the ONE owner
  name         TEXT NOT NULL,                -- plaintext, like instance.nickname
  created_at   INTEGER NOT NULL
, drive_folder_id TEXT);                     -- the Drive folder this project's bytes live in; NULL = not resolved

CREATE TABLE IF NOT EXISTS project_key (
  project_id  TEXT PRIMARY KEY,             -- one Kp per project (Phase 1, migrate-project-key.sql)
  kp_enc      TEXT NOT NULL,                -- encAtRest(b64(Kp)) — worker-held, never client-held
  key_version INTEGER NOT NULL DEFAULT 1,   -- rotation-ready from day one (the member_key lesson)
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_member (
  project_id    TEXT NOT NULL,
  researcher_id TEXT NOT NULL,               -- the member (the OWNER has no row here; ownership is project.owner_id)
  caps          TEXT NOT NULL DEFAULT '{}',  -- {"see":"all"|[instanceId…],"manageDevices":…,"assignTexts":…,
  added_at      INTEGER NOT NULL,
  added_by      TEXT NOT NULL,
  PRIMARY KEY (project_id, researcher_id)
);

CREATE TABLE IF NOT EXISTS researcher (
  researcher_id TEXT PRIMARY KEY,             -- GUID
  secret_hash   TEXT NOT NULL,                -- sha256(authSecret): the password-derived API credential (login + per-call auth)
  email_sha256  TEXT,                         -- HMAC(SERVER_HMAC_KEY, email): login lookup + uniqueness + enumeration-safe
  settings_blob TEXT,                         -- cloud-backed researcher settings (incl. wrapped Ki map), opaque
  settings_rev  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  salt          TEXT,                         -- per-account PBKDF2 salt (b64); client derives KEK + authSecret from it
  wrapped_kr    TEXT,                         -- data key Kr wrapped under the password-KEK (returned only AFTER login)
  escrow_kr     TEXT,                         -- Kr wrapped to the Worker escrow pubkey (RSA-OAEP) — enables email recovery
  email_enc     TEXT,                         -- email encrypted under SERVER_HMAC_KEY (for sending resets; keeps D1 dumps clean)
  totp_secret_enc TEXT,                       -- optional TOTP secret, encrypted under SERVER_HMAC_KEY
  totp_enabled  INTEGER NOT NULL DEFAULT 0,
  backup_codes  TEXT                          -- JSON array of sha256(backup code), single-use
, google_sub TEXT, kr_server_enc TEXT, drive_refresh_enc TEXT, drive_folder_id TEXT, drive_email TEXT, approved INTEGER NOT NULL DEFAULT 0, display_name TEXT, avatar_url TEXT, drive_mode TEXT NOT NULL DEFAULT 'relay', drive_error TEXT, pubkey TEXT, wrapped_privkey TEXT);

CREATE TABLE IF NOT EXISTS reset (
  token_hash    TEXT PRIMARY KEY,             -- sha256 of the one-time reset token
  researcher_id TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  used          INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,   -- failed 2FA attempts on this token; locks (used=1) past a small threshold
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  session_id    TEXT PRIMARY KEY,             -- GUID; the public half of the bearer token
  researcher_id TEXT NOT NULL,
  secret_hash   TEXT NOT NULL,                -- sha256 of the bearer token (never the token itself)
  created_at    INTEGER NOT NULL,             -- ms since epoch
  last_seen_at  INTEGER,                      -- touched on each authenticated call; drives the sliding expiry
  expires_at    INTEGER,                      -- 24h when "stay signed in" is OFF, 90d sliding when ON
  ttl_ms        INTEGER NOT NULL DEFAULT 7776000000,  -- the window to slide BY on each use (90d default)
  revoked       INTEGER NOT NULL DEFAULT 0,   -- sign-out / revoke-one / revoke-others / cap eviction
  label         TEXT,                         -- coarse User-Agent label, e.g. "Chrome on Windows"
  ip_enc        TEXT,                         -- AES-GCM under SERVER_HMAC_KEY — see the note below
  geo           TEXT                          -- "Jayapura, ID · Telkomsel" — Cloudflare edge geo, no browser permission
);

CREATE INDEX IF NOT EXISTS idx_approval_log_at ON approval_log(at DESC);

CREATE INDEX IF NOT EXISTS idx_crowd_researcher ON crowd_recorder(researcher_id);

CREATE INDEX IF NOT EXISTS idx_crowd_sub ON crowd_submission(crowd_id, created_at);

CREATE INDEX IF NOT EXISTS idx_install_instance ON install(instance_id);

CREATE INDEX IF NOT EXISTS idx_instance_project ON instance(project_id);

CREATE INDEX IF NOT EXISTS idx_instance_researcher ON instance(researcher_id);
-- Idempotent device creation (issue #6): a client-minted key, unique per owner. NULLs are distinct
-- in SQLite, so every keyless row (all existing rows, and anything an old client writes) coexists.
CREATE UNIQUE INDEX IF NOT EXISTS idx_instance_create_key ON instance(researcher_id, create_key);

CREATE INDEX IF NOT EXISTS idx_member_key_project ON member_key(project_id);

CREATE INDEX IF NOT EXISTS idx_project_owner ON project(owner_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_researcher_email ON researcher(email_sha256);

CREATE UNIQUE INDEX IF NOT EXISTS idx_researcher_sub ON researcher(google_sub);

CREATE INDEX IF NOT EXISTS idx_session_researcher ON session(researcher_id);

CREATE TABLE IF NOT EXISTS ops_flag (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

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
