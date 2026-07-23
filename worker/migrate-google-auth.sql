-- Google Sign-In auth migration for the PRODUCTION D1 (flextext-connectivity).
-- Additive / nullable only — safe to run before the new worker code ships; old code
-- ignores these columns. Run on the VM:
--   cd ~/flextext-r2-worker
--   wrangler d1 execute flextext-connectivity --remote --file=migrate-google-auth.sql
--
-- After this, researcher identity = Google `sub`; Kr is stored server-wrapped (no
-- password). The email+password/escrow/TOTP columns (salt, wrapped_kr, escrow_kr,
-- totp_secret_enc, totp_enabled, backup_codes) and the `reset` table become unused —
-- left in place (harmless) and droppable later. `secret_hash` is reused for the
-- session-token hash (authResearcher is unchanged). `email_sha256`/`email_enc` now
-- hold the Google email.

ALTER TABLE researcher ADD COLUMN google_sub TEXT;        -- stable Google user id (identity)
ALTER TABLE researcher ADD COLUMN kr_server_enc TEXT;     -- Kr wrapped under the server key (operator-recoverable)
ALTER TABLE researcher ADD COLUMN drive_refresh_enc TEXT; -- Google refresh token, encrypted (Drive uploads/reads)
ALTER TABLE researcher ADD COLUMN drive_folder_id TEXT;   -- app-created uploads folder in the researcher's Drive
ALTER TABLE researcher ADD COLUMN drive_email TEXT;       -- connected Google account (display)

CREATE UNIQUE INDEX IF NOT EXISTS idx_researcher_sub ON researcher(google_sub);
