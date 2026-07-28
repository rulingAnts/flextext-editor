-- Approval log — an append-only record of WHO was let in, WHEN, and HOW.
--
-- WHY: the researcher table shows the CURRENT state (approved 0/1) and nothing else. Decline
-- deletes the row outright, so a declined account leaves no trace at all — which Seth demonstrated
-- by accident: he declined a test signup and afterwards nothing anywhere recorded who it had been.
-- Access-control decisions are exactly the history you need months later, when the question is
-- "when did this person get in, and who let them?"
--
-- Append-only ON PURPOSE. Nothing in the app ever updates or deletes a row here. An audit log you
-- can edit is not an audit log, and the interesting case is precisely the one someone would want to
-- tidy away.
--
-- ⚠ `subject` (an e-mail address or a domain) IS STORED IN CLEAR TEXT, deliberately, for now.
-- Seth's sequencing (2026-07-28): build the log, then suspend/remove/block, and only then decide
-- how to obscure it. That is a reasonable order here because it adds NO new exposure — the same
-- addresses already sit in clear text in `researcher.drive_email` (added by migrate-google-auth.sql
-- as "connected Google account (display)"). Fixing both together later is the coherent move; doing
-- this column alone would be security theatre while drive_email sits beside it.
--
-- Run ONCE:  Actions -> "D1 migrate" -> file = migrate-approval-log.sql
CREATE TABLE IF NOT EXISTS approval_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,   -- ms since epoch
  kind    TEXT    NOT NULL,   -- account_signup | account_approved | account_auto_approved
                              -- | account_declined | domain_added | domain_removed
  subject TEXT,               -- the e-mail address, or the domain
  detail  TEXT,               -- how/why: the label, the matched domain, 'owner allowlist', …
  actor   TEXT                -- e-mail of the owner who acted, or 'system' for automatic decisions
);

-- Reads are always "most recent first", and the table only grows.
CREATE INDEX IF NOT EXISTS idx_approval_log_at ON approval_log(at DESC);
