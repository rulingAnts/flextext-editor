-- Operational flags the OPERATOR can flip WITHOUT A DEPLOY (2026-08-19).
--
-- Purpose: tell researchers, in the panel, that the backend is undergoing maintenance and that they
-- should hold off making changes until the notice clears. Built as a general capability rather than
-- for one migration, because "we are about to change something risky" recurs.
--
-- ⚠ WHY A TABLE AND NOT A WORKER VAR. A [vars] entry in wrangler.toml needs a commit and a deploy to
-- change, so raising the notice would itself be a release — the exact thing you do not want to be
-- doing while something is already going wrong. A D1 row is toggled from the Actions tab in seconds:
--
--   RAISE:  wrangler (one-off command) → args:
--     d1 execute flextext-connectivity --remote --command "INSERT OR REPLACE INTO ops_flag (key,value,updated_at) VALUES ('maintenance','Backend maintenance in progress — please avoid making changes in the researcher panel until this notice clears.',strftime('%s','now')*1000)"
--
--   CLEAR:  wrangler (one-off command) → args:
--     d1 execute flextext-connectivity --remote --command "DELETE FROM ops_flag WHERE key='maintenance'"
--
-- Additive and read-only to every existing path: an old worker never reads it, and a client that
-- does not know the field simply ignores it.
CREATE TABLE IF NOT EXISTS ops_flag (
  key        TEXT PRIMARY KEY,     -- 'maintenance' is the only key today
  value      TEXT NOT NULL,        -- the message shown to researchers; empty/absent = no notice
  updated_at INTEGER NOT NULL
);
