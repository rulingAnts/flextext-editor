-- ESTATE PINNING — which set of app URLs an instance / crowd recorder belongs to.
--
-- Seth, 2026-08-05: "Existing instances should remain unmodified and working as is with legacy
-- GitHub Pages URL. Any new instances created should use the new Cloudflare-hosted URLs." And,
-- decisively: "Don't let the researcher manually choose which site/url to use for new instances."
--
-- So the estate is a property of the RECORD, never a question put to the researcher and never
-- derived from whichever panel happens to be looking at it.
--
-- ⚠ ON `instance`, NOT `install`. An invite carries instance_id and is minted BEFORE any install
-- exists (INSERT INTO invite … instance_id), so an estate stored per-install could not be read at
-- the moment a link is generated. It also matches the field reality: the instance is the unit a
-- coworker experiences, and their second device must land where their first did.
--
-- ⚠ DEFAULT 'pages' IS THE WHOLE POINT. Every row that exists today was created on GitHub Pages,
-- so the default makes all of them correct with NO backfill and no date cutoff to get wrong.
--
-- Set-once by convention, not by constraint: nothing in the UI changes it, but it stays a plain
-- column, so deliberately moving one coworker to Cloudflare later is a single UPDATE from the
-- hidden advanced panel with no schema change.
--
-- Safe to re-run? No — D1 has no ADD COLUMN IF NOT EXISTS. Run once; a second run errors with
-- "duplicate column name", which is harmless but means it already applied.

ALTER TABLE instance       ADD COLUMN estate TEXT NOT NULL DEFAULT 'pages';
ALTER TABLE crowd_recorder ADD COLUMN estate TEXT NOT NULL DEFAULT 'pages';
