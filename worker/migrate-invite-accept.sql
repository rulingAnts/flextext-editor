-- Enrollment-security migration (2026-06-23): researcher allowlist (A) is config-only,
-- but invite-consent (B) needs an install "accepted" flag + a researcher profile (name/avatar)
-- the device shows at claim time. All additive + nullable/defaulted → safe re-run-ish (D1 has
-- no IF NOT EXISTS for ADD COLUMN, so run ONCE; a second run errors harmlessly on "duplicate column").
--   wrangler d1 execute flextext-connectivity --remote --file=migrate-invite-accept.sql

-- B: the field user must accept an enrollment before a key can be delivered.
ALTER TABLE install ADD COLUMN accepted INTEGER NOT NULL DEFAULT 0;

-- The researcher's Google profile, shown to the device at claim ("connect to <name>?").
ALTER TABLE researcher ADD COLUMN display_name TEXT;
ALTER TABLE researcher ADD COLUMN avatar_url TEXT;
