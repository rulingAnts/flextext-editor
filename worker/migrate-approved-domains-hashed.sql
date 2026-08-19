-- Pre-approved e-mail domains, stored as KEYED HASHES rather than plaintext.
--
-- WHY THE REWRITE (Seth, 2026-07-28): the first cut stored 'example.org' in the clear. But the LIST
-- ITSELF is sensitive — it names the mission, NGO and academic organisations this operator works
-- with. Under this project's privacy obligations to partner organisations and the communities they
-- serve, "who are his partners" is exactly what a D1 dump should not hand over, independently of any
-- user's data. Same reasoning
-- that made `email_sha256` an HMAC and `email_enc` encrypted at rest.
--
-- domain_hash = HMAC-SHA256(SERVER_HMAC_KEY, 'domain:' + <lowercased bare domain>), hex.
-- Keyed, not a bare digest: the set of real-world domains is small and enumerable, so a plain
-- sha256('example.org') would be reversed by anyone with a wordlist in seconds. The key is what makes
-- the hash meaningful, and the key never leaves the Worker's secrets.
--
-- ⚠ CONSEQUENCE, BY DESIGN: nobody — not even the operator, not even Claude — can read the list
-- back out of the database. `note_enc` (encrypted at rest, same as email_enc) is what makes an
-- entry recognisable in the panel. Removing an entry means naming the domain again so the Worker
-- can re-derive its hash.
--
-- ⚠ ROWS CANNOT BE WRITTEN BY HAND. Computing domain_hash requires SERVER_HMAC_KEY, which lives
-- only in the Worker. Use the owner-only endpoints (POST /v1/researcher/domains, .../test,
-- .../remove) — that is deliberate: an auto-approval rule should only ever be creatable by someone
-- holding an authenticated owner session, never by anyone who merely reached the database.
--
-- Run ONCE:  Actions -> "D1 migrate" -> file = migrate-approved-domains-hashed.sql
-- Safe to run over the previous version: that table was created empty and never populated.
DROP TABLE IF EXISTS approved_domain;

CREATE TABLE approved_domain (
  domain_hash TEXT PRIMARY KEY,   -- HMAC(SERVER_HMAC_KEY, 'domain:' + domain), hex
  note_enc    TEXT,               -- operator's own label, AES-GCM at rest (may name the org)
  created_at  INTEGER NOT NULL    -- ms since epoch
);
