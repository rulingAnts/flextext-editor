-- READ-ONLY inventory: COUNTS ONLY, deliberately no rows, no emails, no ids.
--
-- Two jobs. First, it sizes the researcher/project backfill before it is written: how many default
-- projects get minted, how many instances re-parent, how many installs would need a key re-wrap.
-- Second, it is the data-shape rehearsal that a schema test cannot do — a duplicate email_sha256
-- would block the unique index, a NULL where a NOT NULL default is added would abort a migration,
-- and a row count is what turns a per-row loop into a subrequest-cap failure.
--
-- Run (Actions -> "wrangler (one-off command)", with the branch set to one that HAS this file):
--   d1 execute flextext-connectivity --remote --file=inventory-report.sql
--
-- ⚠ WHY COUNTS AND NOTHING ELSE. This repo is PUBLIC, so every workflow log is public. The example
-- in worker-wrangler.yml's own header — `SELECT researcher_id, drive_email, approved FROM
-- researcher` — was written when the repo was private and would now publish real researchers'
-- email addresses to anyone who opens the run. When actual rows are needed, read them in the
-- Cloudflare dashboard's D1 console, never through Actions.
SELECT 'researcher'                    AS metric, COUNT(*) AS n FROM researcher
UNION ALL SELECT 'researcher_google_lane',        COUNT(*) FROM researcher WHERE google_sub IS NOT NULL
UNION ALL SELECT 'researcher_password_lane',      COUNT(*) FROM researcher WHERE google_sub IS NULL
UNION ALL SELECT 'researcher_approved',           COUNT(*) FROM researcher WHERE approved = 1
UNION ALL SELECT 'researcher_with_drive_token',   COUNT(*) FROM researcher WHERE drive_refresh_enc IS NOT NULL
UNION ALL SELECT 'researcher_null_email_key',     COUNT(*) FROM researcher WHERE email_sha256 IS NULL
UNION ALL SELECT 'researcher_dup_email_key',      COUNT(*) FROM (SELECT email_sha256 FROM researcher WHERE email_sha256 IS NOT NULL GROUP BY email_sha256 HAVING COUNT(*) > 1)
UNION ALL SELECT 'instance',                      COUNT(*) FROM instance
UNION ALL SELECT 'instance_live',                 COUNT(*) FROM instance WHERE revoked = 0
UNION ALL SELECT 'instance_estate_pages',         COUNT(*) FROM instance WHERE estate = 'pages'
UNION ALL SELECT 'instance_estate_cloud',         COUNT(*) FROM instance WHERE estate = 'cloud'
UNION ALL SELECT 'instance_with_drive_folder',    COUNT(*) FROM instance WHERE oauth_folder_id IS NOT NULL
UNION ALL SELECT 'instance_orphan_researcher',    COUNT(*) FROM instance WHERE researcher_id NOT IN (SELECT researcher_id FROM researcher)
UNION ALL SELECT 'install',                       COUNT(*) FROM install
UNION ALL SELECT 'install_live',                  COUNT(*) FROM install WHERE revoked = 0
UNION ALL SELECT 'install_approved',              COUNT(*) FROM install WHERE status = 'approved'
UNION ALL SELECT 'install_accepted',              COUNT(*) FROM install WHERE accepted = 1
UNION ALL SELECT 'install_holding_key',           COUNT(*) FROM install WHERE wrapped_key IS NOT NULL
UNION ALL SELECT 'install_seen_last_30d',         COUNT(*) FROM install WHERE last_seen_at IS NOT NULL AND last_seen_at > (strftime('%s','now') - 2592000) * 1000
UNION ALL SELECT 'invite_unclaimed',              COUNT(*) FROM invite WHERE claimed_at IS NULL
UNION ALL SELECT 'crowd_recorder',                COUNT(*) FROM crowd_recorder
UNION ALL SELECT 'approved_domain',               COUNT(*) FROM approved_domain
UNION ALL SELECT 'approval_log',                  COUNT(*) FROM approval_log;
