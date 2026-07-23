-- Device streaming uploads (2026-07-13): each enrolled device delivers into its
-- own subfolder of the researcher's "FlexText Uploads" master folder, tracked by
-- Drive file id (rename/move-proof). Additive only — run ONCE via the d1-migrate
-- Action. RE-RUN NOTE: "duplicate column name: oauth_folder_id" on a re-run means
-- this migration already landed; the database is fine.
ALTER TABLE instance ADD COLUMN oauth_folder_id TEXT;
