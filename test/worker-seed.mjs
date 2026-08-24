/* Seed a LOCAL D1 with synthetic fixtures shaped like production — never production's rows.
 *
 * WHY SYNTHETIC (Seth agreed 2026-08-17: "our staging D1 database should not expose production
 * data, especially if doing so INCREASES the potential attack surface"): at-rest encryption is
 * keyed by SERVER_HMAC_KEY, so a copy of production is either undecryptable (different key) or
 * turns the test database into a second production holding live Drive refresh tokens (same key).
 * Row SHAPES are what tests need; real values are what they must not have. See
 * plans/project-split.md PART VI.4.
 *
 * The researcher row is inserted DIRECTLY rather than through /signup because signup needs
 * Turnstile and sign-in needs Google OAuth — neither of which a hermetic rig has, and neither of
 * which the device-compat contract depends on. That is the whole point of the local rig: the
 * device lane is testable with no third party involved.
 *
 * Run:  node test/worker-seed.mjs            (applies schema + fixtures to the local D1)
 *       node test/worker-seed.mjs --print    (just print the fixture ids, e.g. for the probe)
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = join(ROOT, 'worker');

/* Fixed, obviously-fake, and committed on purpose: a fixture whose values are stable makes a
 * failing probe reproducible. These are worthless — they authenticate against a local in-memory
 * database that holds nothing. */
export const FIXTURE = {
  researcherId: '00000000-0000-4000-8000-000000000001',
  researcherSecret: 'local-rig-fixture-secret-not-a-real-credential',
  driveEmail: 'fixture@example.invalid',   // also set as ALLOWED_RESEARCHERS in the rig, so this fixture is an operator
  googleSub: 'local-rig-fixture-sub',
  /* A pre-minted SESSION, so the session lane is testable without Google. Sessions are normally
   * created only by the OAuth callback; seeding one is how a hermetic rig reaches the code that
   * matters (auth, sliding expiry, listing, revocation) with no third party involved. */
  sessionId: '00000000-0000-4000-8000-0000000000a1',
  sessionSecret: 'local-rig-fixture-session-token-not-a-real-credential',
  /* An already-expired one, to prove expiry is enforced rather than merely recorded. */
  expiredSessionId: '00000000-0000-4000-8000-0000000000a2',
  expiredSessionSecret: 'local-rig-fixture-expired-session-token',
};

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

if (process.argv.includes('--print')) {
  console.log(JSON.stringify(FIXTURE, null, 2));
  process.exit(0);
}

const now = Date.now();
const sql = `
-- Synthetic fixtures for the local rig. Applied AFTER schema-current.sql.
/* ⚠ EVERY table the suites touch, or the rig is not repeatable — which is worse than useless,
 * because it passes the first time and fails the second for reasons that look like product bugs.
 * That is exactly what happened when project and member_key were missing here: the projects
 * suite passed on a clean database and then reported 0 projects minted on the next run, because
 * the previous run's project was still there, owned by the same fixture id.
 * (No BACKTICKS in this comment on purpose: it lives inside a template literal, and a stray
 * backtick terminates the string — a trap this repo has hit before.) */
DELETE FROM member_key;
DELETE FROM project_member;
DELETE FROM project;
DELETE FROM install;
DELETE FROM invite;
DELETE FROM instance;
DELETE FROM researcher;
INSERT INTO researcher (researcher_id, secret_hash, email_sha256, settings_blob, settings_rev,
                        created_at, google_sub, drive_email, display_name, approved, drive_mode)
VALUES ('${FIXTURE.researcherId}', '${sha256hex(FIXTURE.researcherSecret)}',
        '${sha256hex('fixture-email-key')}', '{}', 0, ${now},
        '${FIXTURE.googleSub}', '${FIXTURE.driveEmail}', 'Local Rig Fixture', 1, 'oauth');

DELETE FROM session;
INSERT INTO session (session_id, researcher_id, secret_hash, created_at, last_seen_at, expires_at,
                     ttl_ms, revoked, label, ip_enc, geo)
VALUES ('${FIXTURE.sessionId}', '${FIXTURE.researcherId}', '${sha256hex(FIXTURE.sessionSecret)}',
        ${now}, ${now}, ${now + 90 * 24 * 3600 * 1000}, ${90 * 24 * 3600 * 1000}, 0,
        'Chrome on macOS', NULL, 'Jayapura, PA, ID · Fixture Telecom');
INSERT INTO session (session_id, researcher_id, secret_hash, created_at, last_seen_at, expires_at,
                     ttl_ms, revoked, label, ip_enc, geo)
VALUES ('${FIXTURE.expiredSessionId}', '${FIXTURE.researcherId}', '${sha256hex(FIXTURE.expiredSessionSecret)}',
        ${now - 200 * 24 * 3600 * 1000}, ${now - 100 * 24 * 3600 * 1000}, ${now - 24 * 3600 * 1000},
        ${90 * 24 * 3600 * 1000}, 0, 'Firefox on Windows', NULL, 'Somewhere Else');
`;

const tmp = join(WORKER, '.seed-local.sql');
writeFileSync(tmp, sql);

/* ⚠ PINNED to the same wrangler the rig and the deploy use — see local-rig.sh. Bare `npx wrangler`
 * follows whatever is newest, so the seed could apply the schema with a different toolchain from the
 * one under test, and a fresh version's first run is slow enough to look like a hang. */
const WRANGLER = 'wrangler@' + (process.env.WRANGLER_VERSION || '4.118.0');
const d1 = (args) => execFileSync('npx', ['--yes', WRANGLER, 'd1', 'execute', 'DB', '--local', '--env', 'staging', ...args],
  { cwd: WORKER, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

console.log('applying schema-current.sql to the LOCAL D1…');
d1(['--file=schema-current.sql']);
console.log('applying synthetic fixtures…');
d1([`--file=${tmp}`]);
console.log(`seeded: researcher ${FIXTURE.researcherId} (approved, drive_mode=oauth)`);
