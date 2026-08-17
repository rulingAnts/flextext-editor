-- READ-ONLY inventory: COUNTS ONLY, deliberately no rows, no emails, no ids.
--
-- Two jobs. First, it sizes the researcher/project backfill before it is written: how many default
-- projects get minted, how many instances re-parent, how many installs would need a key re-wrap.
-- Second, it is the data-shape rehearsal that a schema test cannot do — a duplicate email_sha256
-- would block the unique index, a NULL where a NOT NULL default is added would abort a migration,
-- and a row count is what turns a per-row loop into a subrequest-cap failure.
--
-- ⚠ WHY COUNTS AND NOTHING ELSE. This repo is PUBLIC, so every workflow log is public. The example
-- in worker-wrangler.yml's own header — `SELECT researcher_id, drive_email, approved FROM
-- researcher` — was written while it was private and would now publish real researchers' email
-- addresses to anyone who opens the run. Rows belong in the Cloudflare dashboard's D1 console,
-- never in Actions.
--
-- ⚠ WHY SCALAR SUBQUERIES AND NOT `UNION ALL`. The first version of this report was 20 UNION ALL
-- terms and D1 rejected it outright: "too many terms in compound SELECT: SQLITE_ERROR [code: 7500]"
-- (verified against production, 2026-08-17). D1's compound-SELECT ceiling is far below stock
-- SQLite's, so report and migration SQL for this project must avoid long compounds. One row of
-- scalar subqueries has no such limit and reads better as JSON anyway.
--
-- ⚠ Reading from a REMOTE database needs --command, not --file: wrangler runs a remote --file as a
-- bulk IMPORT and prints only a summary, never the rows (see schema-report.sql's header). So this
-- file is the reviewable source; to run it against production, flatten it to ONE line and pass it
-- as --command in the "wrangler (one-off command)" workflow. Locally it runs as-is:
--   wrangler d1 execute DB --local --file=inventory-report.sql
SELECT
  (SELECT COUNT(*) FROM researcher)                                              AS researcher,
  (SELECT COUNT(*) FROM researcher WHERE google_sub IS NOT NULL)                 AS researcher_google_lane,
  (SELECT COUNT(*) FROM researcher WHERE google_sub IS NULL)                     AS researcher_password_lane,
  (SELECT COUNT(*) FROM researcher WHERE approved = 1)                           AS researcher_approved,
  (SELECT COUNT(*) FROM researcher WHERE drive_refresh_enc IS NOT NULL)          AS researcher_with_drive_token,
  (SELECT COUNT(*) FROM (SELECT email_sha256 FROM researcher WHERE email_sha256 IS NOT NULL GROUP BY email_sha256 HAVING COUNT(*) > 1)) AS researcher_dup_email_key,
  (SELECT COUNT(*) FROM instance)                                                AS instance,
  (SELECT COUNT(*) FROM instance WHERE revoked = 0)                              AS instance_live,
  (SELECT COUNT(*) FROM instance WHERE estate = 'pages')                         AS instance_estate_pages,
  (SELECT COUNT(*) FROM instance WHERE estate = 'cloud')                         AS instance_estate_cloud,
  (SELECT COUNT(*) FROM instance WHERE oauth_folder_id IS NOT NULL)              AS instance_with_drive_folder,
  (SELECT COUNT(*) FROM instance WHERE researcher_id NOT IN (SELECT researcher_id FROM researcher)) AS instance_orphaned,
  (SELECT COUNT(*) FROM install)                                                 AS install,
  (SELECT COUNT(*) FROM install WHERE revoked = 0)                               AS install_live,
  (SELECT COUNT(*) FROM install WHERE status = 'approved')                       AS install_approved,
  (SELECT COUNT(*) FROM install WHERE wrapped_key IS NOT NULL)                   AS install_holding_key,
  (SELECT COUNT(*) FROM install WHERE last_seen_at > (strftime('%s','now') - 2592000) * 1000) AS install_seen_30d,
  (SELECT COUNT(*) FROM invite WHERE claimed_at IS NULL)                         AS invite_unclaimed,
  (SELECT COUNT(*) FROM crowd_recorder)                                          AS crowd_recorder,
  (SELECT COUNT(*) FROM approved_domain)                                         AS approved_domain,
  (SELECT COUNT(*) FROM approval_log)                                            AS approval_log;
