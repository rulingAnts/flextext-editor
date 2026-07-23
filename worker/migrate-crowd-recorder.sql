-- Crowd recorders (public crowd-source recording pages) + per-researcher Drive
-- delivery mode. Additive only — run ONCE via the d1-migrate Action
-- (Actions tab → "D1 migrate" → file: migrate-crowd-recorder.sql).
-- RE-RUN NOTE: the CREATEs are IF NOT EXISTS, but the ALTER TABLE lines are not —
-- a re-run fails with "duplicate column name: drive_mode". That error MEANS the
-- migration already landed; the database is fine. Do not "fix" anything.
--
-- crowd_recorder: one row per public recorder a researcher created. config_json
-- is DELIBERATELY plaintext (unlike device settings, which are E2EE): the public
-- page has no key, so its welcome/consent text must be server-readable. The
-- Drive folder id lives ONLY here — the public config projection never returns it.
CREATE TABLE IF NOT EXISTS crowd_recorder (
  crowd_id        TEXT PRIMARY KEY,            -- GUID in the public URL (?c=…)
  researcher_id   TEXT NOT NULL,
  label           TEXT NOT NULL DEFAULT '',    -- researcher-facing name; also seeds the Drive filename slug
  enabled         INTEGER NOT NULL DEFAULT 1,  -- kill switch (panel Pause/Resume)
  config_json     TEXT NOT NULL DEFAULT '{}',  -- {welcome, consentAsk, consentConfirm, consentMsg, consentAudioUrl, lang, maxSeconds, turnstile}
  drive_folder    TEXT NOT NULL DEFAULT '',    -- relay-leg target ("anyone with link can edit" folder id) — NEVER in the public projection
  oauth_folder_id TEXT,                        -- OAuth-leg target: worker-created folder in the researcher's own Drive
  submit_count    INTEGER NOT NULL DEFAULT 0,
  bytes_total     INTEGER NOT NULL DEFAULT 0,  -- lifetime bytes accepted (budget: auto-pause at max_bytes_total)
  day_key         TEXT NOT NULL DEFAULT '',    -- UTC YYYY-MM-DD the day_count belongs to
  day_count       INTEGER NOT NULL DEFAULT 0,
  max_per_day     INTEGER NOT NULL DEFAULT 200,
  max_bytes_total INTEGER NOT NULL DEFAULT 1073741824,   -- 1 GB
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crowd_researcher ON crowd_recorder(researcher_id);

-- Per-submission log (panel visibility + abuse forensics). Privacy: country only +
-- HMAC'd IP — never the raw IP of an anonymous stranger. Pruned per recorder.
CREATE TABLE IF NOT EXISTS crowd_submission (
  sub_id     TEXT PRIMARY KEY,
  crowd_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  country    TEXT DEFAULT '',                  -- coarse request.cf.country
  ip_hmac    TEXT DEFAULT '',                  -- HMAC(SERVER_HMAC_KEY, ip) — abuse correlation without storing PII
  file_name  TEXT DEFAULT '',                  -- server-composed Drive filename
  status     TEXT DEFAULT 'ok'                 -- ok | relay_fallback | failed
);
CREATE INDEX IF NOT EXISTS idx_crowd_sub ON crowd_submission(crowd_id, created_at);

-- Drive delivery mode per researcher: 'relay' (Apps Script relay into anyone-with-
-- link folders — the original path, stays the default) or 'oauth' (Worker→Drive
-- with the researcher's own stored refresh token). drive_error holds the last
-- delivery problem ({at,msg} JSON) so the panel can warn loudly.
ALTER TABLE researcher ADD COLUMN drive_mode TEXT NOT NULL DEFAULT 'relay';
ALTER TABLE researcher ADD COLUMN drive_error TEXT;
