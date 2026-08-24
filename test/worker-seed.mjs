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
import { createHash, randomUUID, createCipheriv, randomBytes } from 'node:crypto';
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
  /* A SECOND approved researcher who owns nothing here. Phase C's central claim is that a
   * researcher outside a project cannot reach it, and that claim is untestable with one fixture —
   * every request would be the owner's, so every route would pass and the rig would certify an
   * authorization model it never exercised. Deliberately NOT an operator (absent from
   * ALLOWED_RESEARCHERS), so it is an ordinary account rather than one carrying deployment rights. */
  outsiderId: '00000000-0000-4000-8000-000000000002',
  outsiderSecret: 'local-rig-outsider-secret-not-a-real-credential',
  outsiderEmail: 'outsider@example.invalid',
  /* One project WITH a Drive folder and one WITHOUT — the two sides of the sharing gate. */
  migratedProjectId: '00000000-0000-4000-8000-0000000000b1',
  unmigratedProjectId: '00000000-0000-4000-8000-0000000000b2',
  /* A SECOND migrated project, and a device that lives in it holding a LEGACY-'' grant — the exact
   * state the 2026-08-21 second sweep found unreachable by the member-removal cleanup: a grant
   * minted while the device was unassigned (member_key.project_id='') whose instance has since been
   * stamped into a DIFFERENT project than the one a member is removed from. The rig cannot reach this
   * through the API (assign needs Drive; backfill only adopts into the FIRST project), so it is
   * seeded. Created LAST so GET /v1/projects' `ORDER BY created_at` leaves the probe's existing
   * migrated/unmigrated resolution untouched. */
  movedProjectId: '00000000-0000-4000-8000-0000000000b3',
  movedDeviceId: '00000000-0000-4000-8000-0000000000d1',
};

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

/* ---------------- Kr, encrypted at rest exactly as the worker does it ----------------
 *
 * ⚠ WHY THIS EXISTS. GET /v1/researcher returns `kr` = decAtRest(researcher.kr_server_enc), and the
 * PANEL's bootstrap() throws `no_kr` without it. So while this column was NULL the researcher panel
 * could not be loaded at all against the rig — every browser check of the panel was impossible, which
 * is why the whole researcher UI had only ever been verified by reading source.
 *
 * ⚠ IT IS NOT A BACKDOOR, and the distinction matters. Kr is the researcher's own data key; the
 * worker already stores it (that is what "operator-recoverable escrow" means) and hands it back to an
 * authenticated caller. Seeding one for a synthetic fixture reproduces the NORMAL state of a real
 * account, and it is worthless: it decrypts a local in-memory database holding nothing, under a
 * SERVER_HMAC_KEY that is printed in local-rig.sh.
 *
 * The format is worker/src/v1.js encAtRest(): AES-256-GCM under SHA-256(SERVER_HMAC_KEY), written as
 * b64url(iv) + '.' + b64url(ciphertext || authTag). Node puts the GCM tag in a separate buffer while
 * WebCrypto appends it to the ciphertext, so the tag is concatenated here — get that wrong and
 * decAtRest catches its own error and returns null, i.e. the panel fails with no_kr again and says
 * nothing about why. */
const RIG_HMAC_KEY = process.env.FX_RIG_HMAC_KEY || 'local-rig-not-a-secret';
const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function encAtRest(plaintext) {
  const key = createHash('sha256').update(RIG_HMAC_KEY).digest();   // serverAesKey()
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final(), c.getAuthTag()]);
  return b64url(iv) + '.' + b64url(ct);
}
/* A FIXED Kr, so a panel session survives a re-seed: the browser caches nothing about it, but a
 * stable value keeps a failing run reproducible, which is the same reason every id here is fixed. */
const KR_PLAINTEXT = b64url(Buffer.alloc(32, 7));   // 32-byte AES key, base64 — importKeyB64()'s shape

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
                        created_at, google_sub, drive_email, display_name, approved, drive_mode, kr_server_enc)
VALUES ('${FIXTURE.researcherId}', '${sha256hex(FIXTURE.researcherSecret)}',
        '${sha256hex('fixture-email-key')}', '{}', 0, ${now},
        '${FIXTURE.googleSub}', '${FIXTURE.driveEmail}', 'Local Rig Fixture', 1, 'oauth', '${encAtRest(KR_PLAINTEXT)}');
INSERT INTO researcher (researcher_id, secret_hash, email_sha256, settings_blob, settings_rev,
                        created_at, google_sub, drive_email, display_name, approved, drive_mode, kr_server_enc)
VALUES ('${FIXTURE.outsiderId}', '${sha256hex(FIXTURE.outsiderSecret)}',
        '${sha256hex('outsider-email-key')}', '{}', 0, ${now},
        'local-rig-outsider-sub', '${FIXTURE.outsiderEmail}', 'Local Rig Outsider', 1, 'oauth', '${encAtRest(KR_PLAINTEXT)}');

/* ⚠ TWO PROJECTS, ONE MIGRATED AND ONE NOT — because sharing is gated on the owner having a real
 * Drive project folder (Seth, 2026-08-20: "No researcher sharing if the researcher hasn't migrated
 * to the project model"). The rig has no Google, so reconcileProjects can never resolve a folder
 * here and EVERY project would otherwise be unmigrated — leaving the gate either untestable or
 * permanently on. Seeding both states is what makes the refusal AND the success path reachable
 * without a test-only backdoor in the worker, which is the thing this codebase must not grow.
 *
 * The migrated one is created FIRST so backfillProjectsFor adopts the instances into it
 * (ORDER BY created_at LIMIT 1) and finds drive_folder_id already set, skipping the Drive call. */
DELETE FROM project;
INSERT INTO project (project_id, owner_id, name, created_at, drive_folder_id)
VALUES ('${FIXTURE.migratedProjectId}', '${FIXTURE.researcherId}', 'Rig Migrated Project', ${now}, 'rig-drive-folder-migrated');
INSERT INTO project (project_id, owner_id, name, created_at, drive_folder_id)
VALUES ('${FIXTURE.unmigratedProjectId}', '${FIXTURE.researcherId}', 'Rig Unmigrated Project', ${now + 1000}, NULL);
/* A SECOND migrated project (created LAST so the probe's owned-projects lookup still resolves to the
 * FIRST migrated one), plus a device that lives in it carrying a LEGACY-'' member_key grant to the
 * outsider. This is the ONE state the member-removal cleanup could not reach through the API — a
 * grant minted while the device was unassigned ('' sentinel) whose device has since moved to a
 * project OTHER than the one the member is removed from. worker-members.probe.mjs asserts the removal
 * now takes it; neutering the third DELETE arm in v1.js makes that assertion fail.
 * (No backticks in this comment: it lives inside a template literal, and a stray one ends the string.) */
INSERT INTO project (project_id, owner_id, name, created_at, drive_folder_id)
VALUES ('${FIXTURE.movedProjectId}', '${FIXTURE.researcherId}', 'Rig Moved-Into Project', ${now + 2000}, 'rig-drive-folder-moved');
INSERT INTO instance (instance_id, researcher_id, type, nickname, desired_blob, desired_rev, revoked, created_at, estate, project_id)
VALUES ('${FIXTURE.movedDeviceId}', '${FIXTURE.researcherId}', '', 'Moved Device', '{"settings":{},"commands":[]}', 0, 0, ${now}, 'cloud', '${FIXTURE.movedProjectId}');
INSERT INTO member_key (project_id, instance_id, researcher_id, key_version, wrapped_ki, wrapped_by, created_at)
VALUES ('', '${FIXTURE.movedDeviceId}', '${FIXTURE.outsiderId}', 1, 'GUEST-MOVED-SENTINEL-COPY', '${FIXTURE.researcherId}', ${now});
/* The OWNER's wrap-to-owner copy of the same device key, ALSO carrying the '' sentinel. This is the
 * state that makes the owner-removal hazard reproducible: the third DELETE arm matches
 * (project_id='' AND instance owned by the owner), so removing "the owner" as a member would destroy
 * the owner's own unrecoverable copy. It must be SEEDED — a grant written through the API against
 * this device is stamped with the device's real project_id and would never match that arm, which is
 * how the first version of the assertion passed with the guard removed. */
INSERT INTO member_key (project_id, instance_id, researcher_id, key_version, wrapped_ki, wrapped_by, created_at)
VALUES ('', '${FIXTURE.movedDeviceId}', '${FIXTURE.researcherId}', 1, 'OWNER-MOVED-SENTINEL-COPY', '${FIXTURE.researcherId}', ${now});

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
