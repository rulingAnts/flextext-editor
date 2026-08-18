-- migrate-sessions.sql — Phase A of the researcher/project split: browser sessions become ROWS.
--
-- WHY: today a researcher's `secret_hash` is TWO different things depending on the lane. For a
-- Google account it is a rotating SESSION TOKEN, so each sign-in evicts the previous browser —
-- which is exactly the "one researcher, several browsers" limitation this phase removes. For a
-- password account it is a DURABLE PASSWORD VERIFIER, which is already multi-browser and must not
-- be touched. Splitting the session out of that column is what makes both lanes correct at once.
--
-- ADDITIVE AND CREATE-ONLY, per the rules PART III round 2 (R2-6) set for this project: no ALTER on
-- an existing table, no table rebuild, one concern per file. Old workers ignore this table entirely,
-- and old panels keep authenticating through the legacy `secret_hash` fallback, so this file is safe
-- to apply BEFORE the worker that uses it — which is the runbook order (D1 → worker → smoke).
--
--   wrangler d1 execute <db> --remote --file=migrate-sessions.sql
CREATE TABLE IF NOT EXISTS session (
  session_id    TEXT PRIMARY KEY,             -- GUID; the public half of the bearer token
  researcher_id TEXT NOT NULL,
  secret_hash   TEXT NOT NULL,                -- sha256 of the bearer token (never the token itself)
  created_at    INTEGER NOT NULL,             -- ms since epoch
  last_seen_at  INTEGER,                      -- touched on each authenticated call; drives the sliding expiry
  expires_at    INTEGER,                      -- 24h when "stay signed in" is OFF, 90d sliding when ON
  revoked       INTEGER NOT NULL DEFAULT 0,   -- sign-out / revoke-one / revoke-others / cap eviction
  label         TEXT,                         -- coarse User-Agent label, e.g. "Chrome on Windows"
  ip_enc        TEXT,                         -- AES-GCM under SERVER_HMAC_KEY — see the note below
  geo           TEXT                          -- "Jayapura, ID · Telkomsel" — Cloudflare edge geo, no browser permission
);
CREATE INDEX IF NOT EXISTS idx_session_researcher ON session(researcher_id);

-- ⚠ WHY ip_enc AND NOT A PLAIN COLUMN OR A HASH.
-- Seth, 2026-08-17: "I think it's fine for the IP address not to be hashed." Right — a hash is
-- useless in a session list, which exists so the owner can recognise "that is my office" or "that is
-- nowhere I have been". So the address is shown in full, in the list and in the new-sign-in email.
-- It is nevertheless stored ENCRYPTED AT REST, exactly as `email_enc` and `totp_secret_enc` already
-- are and for the same stated reason ("keeps D1 dumps clean"): several of these researchers work in
-- hostile contexts, and a plaintext column would turn D1 into a standing location history for them.
-- Encrypted at rest costs one existing function call (encAtRest) and changes nothing the user sees.
-- The long-lived security log keeps its existing IP HASH — different lifetime, different rule.
