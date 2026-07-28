-- Pre-approved e-mail DOMAINS — a third onboarding tier between "owner" and "approve by hand".
--
-- Today there are two: ALLOWED_RESEARCHERS (env list) makes an address an auto-approved OWNER, and
-- everyone else signs in PENDING until an owner clicks Approve. This table adds the middle case:
-- anyone whose address ends in a listed domain is auto-approved as an ORDINARY researcher (never an
-- owner — owner rights stay in the env list, which no database write can grant).
--
-- The owner is still ALERTED on every new account (worker/src/seclog.js), so auto-approval removes
-- the click, not the visibility.
--
-- ⚠ MATCH THE DOMAIN EXACTLY, never as a substring: '@notmyorg.com' must not match 'myorg.com'.
-- The worker lowercases and takes the part after the LAST '@', then compares for equality. Storing
-- domains lowercase and without a leading '@' or '.' is what makes that comparison correct.
--
-- Run ONCE:  Actions -> "D1 migrate" -> file = migrate-approved-domains.sql
CREATE TABLE IF NOT EXISTS approved_domain (
  domain     TEXT PRIMARY KEY,   -- lowercase, bare: 'sil.org' — NOT '@sil.org', NOT 'mail.sil.org' unless you mean that exact host
  note       TEXT,               -- free text for your own reference ('SIL colleagues')
  created_at INTEGER NOT NULL    -- ms since epoch
);
