-- FlexText connectivity (Phase 0) — Cloudflare D1 schema.
-- Two-lane no-login sync: researcher writes `desired`, install writes `reported`,
-- the Worker enforces ownership. Metadata + pointers ONLY (never audio/flextext
-- bytes). All *_blob columns are opaque JSON today so end-to-end encryption can
-- wrap them later without a schema change. Apply with:
--   wrangler d1 execute flextext-connectivity --file=./schema.sql
-- Migrations MUST stay additive / nullable (old cached PWA engines never break).

CREATE TABLE IF NOT EXISTS researcher (
  researcher_id TEXT PRIMARY KEY,             -- GUID
  secret_hash   TEXT NOT NULL,                -- sha256(authSecret): the password-derived API credential (login + per-call auth)
  email_sha256  TEXT,                         -- HMAC(SERVER_HMAC_KEY, email): login lookup + uniqueness + enumeration-safe
  settings_blob TEXT,                         -- cloud-backed researcher settings (incl. wrapped Ki map), opaque
  settings_rev  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  -- Email+password auth (the password never reaches the server):
  salt          TEXT,                         -- per-account PBKDF2 salt (b64); client derives KEK + authSecret from it
  wrapped_kr    TEXT,                         -- data key Kr wrapped under the password-KEK (returned only AFTER login)
  escrow_kr     TEXT,                         -- Kr wrapped to the Worker escrow pubkey (RSA-OAEP) — enables email recovery
  email_enc     TEXT,                         -- email encrypted under SERVER_HMAC_KEY (for sending resets; keeps D1 dumps clean)
  totp_secret_enc TEXT,                       -- optional TOTP secret, encrypted under SERVER_HMAC_KEY
  totp_enabled  INTEGER NOT NULL DEFAULT 0,
  backup_codes  TEXT                          -- JSON array of sha256(backup code), single-use
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_researcher_email ON researcher(email_sha256);

-- Email password-reset tokens (one-time, short-lived). The token is emailed; only its hash is stored.
CREATE TABLE IF NOT EXISTS reset (
  token_hash    TEXT PRIMARY KEY,             -- sha256 of the one-time reset token
  researcher_id TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  used          INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,   -- failed 2FA attempts on this token; locks (used=1) past a small threshold
  created_at    INTEGER NOT NULL
);

-- Migration (auth redesign) — additive/nullable, run once on existing DBs:
--   ALTER TABLE researcher ADD COLUMN salt TEXT;
--   ALTER TABLE researcher ADD COLUMN wrapped_kr TEXT;
--   ALTER TABLE researcher ADD COLUMN escrow_kr TEXT;
--   ALTER TABLE researcher ADD COLUMN email_enc TEXT;
--   ALTER TABLE researcher ADD COLUMN totp_secret_enc TEXT;
--   ALTER TABLE researcher ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE researcher ADD COLUMN backup_codes TEXT;
--   CREATE UNIQUE INDEX IF NOT EXISTS idx_researcher_email ON researcher(email_sha256);
--   (+ CREATE TABLE reset … as above)
--   ALTER TABLE reset ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;   -- token 2FA attempt-lock

CREATE TABLE IF NOT EXISTS instance (
  instance_id   TEXT PRIMARY KEY,             -- GUID
  researcher_id TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('editor','recorder','')),  -- '' = unified device (runs either/both apps); see migrate-instance-type-unified.sql
  nickname      TEXT NOT NULL,                -- required device label, e.g. "Barnabas' Android Phone"
  desired_blob  TEXT,                         -- {settings:{}, commands:[{seq,...}]} opaque
  desired_rev   INTEGER NOT NULL DEFAULT 0,   -- bumped on every command/settings push
  revoked       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_instance_researcher ON instance(researcher_id);

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
);
CREATE INDEX IF NOT EXISTS idx_install_instance ON install(instance_id);

-- Migration (E1b, E2EE model A) — additive/nullable, run once on existing DBs:
--   ALTER TABLE install ADD COLUMN pubkey TEXT;
--   ALTER TABLE install ADD COLUMN wrapped_key TEXT;

CREATE TABLE IF NOT EXISTS invite (
  invite_id       TEXT PRIMARY KEY,           -- GUID in the link
  instance_id     TEXT NOT NULL,
  secret_hash     TEXT NOT NULL,              -- SHA-256 of the invite secret (the #k= fragment)
  expires_at      INTEGER,                    -- enforced at claim time
  claimed_at      INTEGER,                    -- atomic single-use marker
  claimed_install TEXT,                       -- which client-minted install_id won the claim
  created_at      INTEGER NOT NULL
);

-- Crowd recorders (public crowd-source recording pages) + Drive delivery mode —
-- see migrate-crowd-recorder.sql (2026-07-12) for the full commentary.
CREATE TABLE IF NOT EXISTS crowd_recorder (
  crowd_id        TEXT PRIMARY KEY,
  researcher_id   TEXT NOT NULL,
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
);
CREATE INDEX IF NOT EXISTS idx_crowd_researcher ON crowd_recorder(researcher_id);

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
CREATE INDEX IF NOT EXISTS idx_crowd_sub ON crowd_submission(crowd_id, created_at);

-- Migration (crowd recorders) — additive, run once on existing DBs:
--   ALTER TABLE researcher ADD COLUMN drive_mode TEXT NOT NULL DEFAULT 'relay';
--   ALTER TABLE researcher ADD COLUMN drive_error TEXT;

-- Migration (device streaming uploads, 2026-07-13) — additive, run once:
--   ALTER TABLE instance ADD COLUMN oauth_folder_id TEXT;   -- "FlexText Uploads / <nickname>" folder id
