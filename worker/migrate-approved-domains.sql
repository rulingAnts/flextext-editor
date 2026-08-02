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
-- ⚠⚠ NEVER LIST A PUBLIC E-MAIL PROVIDER (gmail.com, outlook.com, yahoo.com, icloud.com, …).
-- One such row would auto-approve anyone on earth who can open a free mailbox — the whole approval
-- gate, gone silently, with no error to notice. It is a TEMPTING mistake, because real researchers
-- do use gmail addresses. The worker REFUSES these in code (PUBLIC_EMAIL_DOMAINS in src/v1.js), so
-- such a row is inert rather than catastrophic — but do not add one and assume it works.
-- List only domains an ORGANISATION controls: example.org, example.ac.uk, example.net, …
--
-- ⚠ MATCH THE DOMAIN EXACTLY, never as a substring: '@notmyorg.com' must not match 'myorg.com'.
-- The worker lowercases and takes the part after the LAST '@', then compares for equality. Storing
-- domains lowercase and without a leading '@' or '.' is what makes that comparison correct.
--
-- Run ONCE:  Actions -> "D1 migrate" -> file = migrate-approved-domains.sql
CREATE TABLE IF NOT EXISTS approved_domain (
  domain     TEXT PRIMARY KEY,   -- lowercase, bare: 'example.org' — NOT '@example.org', NOT 'mail.example.org' unless you mean that exact host
  note       TEXT,               -- free text for your own reference ('Partner org A')
  created_at INTEGER NOT NULL    -- ms since epoch
);
