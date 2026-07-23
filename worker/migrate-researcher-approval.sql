-- Request/approve researcher onboarding (2026-06-23): a new Google sign-in creates a researcher
-- account in PENDING state (approved=0, inert) until an OWNER (an ALLOWED_RESEARCHERS email)
-- approves it in the panel. Existing rows default to 0, but env-listed owners always pass the
-- gate (isApproved() also checks the env list) and get approved=1 on their next sign-in — so no
-- one is locked out and no grandfather UPDATE is needed.
--   wrangler d1 execute flextext-connectivity --remote --file=migrate-researcher-approval.sql
ALTER TABLE researcher ADD COLUMN approved INTEGER NOT NULL DEFAULT 0;
