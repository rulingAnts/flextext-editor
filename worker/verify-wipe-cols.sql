-- Read-only verification (safe to re-run) that migrate-remote-wipe.sql landed: errors if any of the
-- three columns is missing, and prints the current counts (should be 0 wipe rows on a fresh migration).
SELECT COUNT(*) AS installs,
       SUM(CASE WHEN wipe_state IS NOT NULL THEN 1 ELSE 0 END) AS wipe_rows,
       SUM(wipe_hidden) AS hidden_rows
FROM install;
