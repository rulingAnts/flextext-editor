-- Auth-redesign migration for the PRODUCTION D1 (flextext-connectivity).
-- Additive / nullable only — safe on the live DB: the OLD worker code ignores these
-- columns, and the NEW worker code requires them. Run this BEFORE deploying the new
-- worker, on the VM where wrangler is authed:
--
--   cd ~/flextext-r2-worker
--   # sanity (optional): see current researcher columns + that reset is absent
--   wrangler d1 execute flextext-connectivity --remote --command "PRAGMA table_info(researcher)"
--   # OPTIONAL dedupe guard before the unique index — must return NO rows:
--   wrangler d1 execute flextext-connectivity --remote --command \
--     "SELECT email_sha256, COUNT(*) c FROM researcher WHERE email_sha256 IS NOT NULL GROUP BY email_sha256 HAVING c>1"
--   # apply:
--   wrangler d1 execute flextext-connectivity --remote --file=migrate-auth.sql
--
-- The seven ALTERs error if a column already exists — harmless; if so, skip the ones
-- already present (check PRAGMA table_info first). The CREATEs are IF NOT EXISTS.

ALTER TABLE researcher ADD COLUMN salt TEXT;
ALTER TABLE researcher ADD COLUMN wrapped_kr TEXT;
ALTER TABLE researcher ADD COLUMN escrow_kr TEXT;
ALTER TABLE researcher ADD COLUMN email_enc TEXT;
ALTER TABLE researcher ADD COLUMN totp_secret_enc TEXT;
ALTER TABLE researcher ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE researcher ADD COLUMN backup_codes TEXT;

-- Enumeration-safe email uniqueness (NULLs are distinct in SQLite, so legacy rows
-- with no email won't collide). Dedupe non-NULL duplicates first if the guard above hit.
CREATE UNIQUE INDEX IF NOT EXISTS idx_researcher_email ON researcher(email_sha256);

-- One-time password-reset tokens (incl. the 2FA strike-lock counter `attempts`).
CREATE TABLE IF NOT EXISTS reset (
  token_hash    TEXT PRIMARY KEY,
  researcher_id TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  used          INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
