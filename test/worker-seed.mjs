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
  driveEmail: 'fixture@example.invalid',
  googleSub: 'local-rig-fixture-sub',
};

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

if (process.argv.includes('--print')) {
  console.log(JSON.stringify(FIXTURE, null, 2));
  process.exit(0);
}

const now = Date.now();
const sql = `
-- Synthetic fixtures for the local rig. Applied AFTER schema-current.sql.
DELETE FROM install;
DELETE FROM invite;
DELETE FROM instance;
DELETE FROM researcher;
INSERT INTO researcher (researcher_id, secret_hash, email_sha256, settings_blob, settings_rev,
                        created_at, google_sub, drive_email, display_name, approved, drive_mode)
VALUES ('${FIXTURE.researcherId}', '${sha256hex(FIXTURE.researcherSecret)}',
        '${sha256hex('fixture-email-key')}', '{}', 0, ${now},
        '${FIXTURE.googleSub}', '${FIXTURE.driveEmail}', 'Local Rig Fixture', 1, 'oauth');
`;

const tmp = join(WORKER, '.seed-local.sql');
writeFileSync(tmp, sql);

const d1 = (args) => execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--env', 'staging', ...args],
  { cwd: WORKER, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

console.log('applying schema-current.sql to the LOCAL D1…');
d1(['--file=schema-current.sql']);
console.log('applying synthetic fixtures…');
d1([`--file=${tmp}`]);
console.log(`seeded: researcher ${FIXTURE.researcherId} (approved, drive_mode=oauth)`);
