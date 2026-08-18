/* Phase B: every researcher gets one project, every instance is adopted into it, and the key-grant
 * ledger refuses to exist without the owner.
 *
 * THE THREE PROPERTIES WORTH TESTING, and why each is a real hazard rather than a formality:
 *
 *  1. THE BACKFILL IS IDEMPOTENT. It runs against a live estate, possibly twice, possibly after a
 *     partial failure. A second run must report zeros and move nothing — an instance that has since
 *     been placed deliberately must never be dragged back.
 *
 *  2. THE KEYPAIR WRITE IS CONDITIONAL (round-1 finding 3). Multi-session means two browsers of one
 *     account can race this on first sign-in. Last-write-wins would strand every grant already
 *     wrapped to the losing key — silently, discovered only when a device could not be opened.
 *
 *  3. NO KEY GRANT EXISTS WITHOUT THE OWNER'S COPY. This is what makes "the owner can always see and
 *     revoke all keys" true by construction rather than by policy, so it is enforced server-side and
 *     asserted here: a set lacking the owner is rejected outright, not stored-and-warned-about.
 *
 * Runs on the local rig: bash test/local-rig.sh
 */

import { FIXTURE } from './worker-seed.mjs';

const BASE = process.argv[2] || process.env.FX_PROBE_BASE || 'http://127.0.0.1:8787';
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      'x-fx-researcher': FIXTURE.researcherId, 'x-fx-secret': FIXTURE.researcherSecret,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}

console.log(`projects + key grants → ${BASE}\n`);

/* An instance to adopt, created BEFORE the backfill — the state every existing researcher is in. */
const inst = await call('POST', '/v1/instances', { type: '', nickname: 'Pre-Backfill Device' });
ok(inst.status === 200, `created an instance to adopt (got ${inst.status})`);
const instanceId = inst.json && inst.json.instance_id;

/* ---- 1. the backfill mints a project and adopts what exists ---- */
const first = await call('POST', '/v1/researcher/admin/backfill-projects', {});
ok(first.status === 200, `the backfill runs for an operator (got ${first.status})`);
ok(first.json && first.json.projects_created >= 1, `it minted a default project (${first.json && first.json.projects_created})`);
ok(first.json && first.json.instances_adopted >= 1, `it adopted the existing instance(s) (${first.json && first.json.instances_adopted})`);

/* ---- 2. running it AGAIN must be a no-op, not a second project ---- */
const second = await call('POST', '/v1/researcher/admin/backfill-projects', {});
ok(second.status === 200, `it runs a second time without error (got ${second.status})`);
ok(second.json && second.json.projects_created === 0,
   `the second run mints NOTHING — re-running a backfill must be safe (${second.json && second.json.projects_created})`);
ok(second.json && second.json.instances_adopted === 0,
   'and adopts nothing: an instance placed deliberately since must never be dragged back');

/* ---- 3. the keypair: first writer wins, the racer is told so ---- */
const key1 = await call('POST', '/v1/researcher/pubkey', { pubkey: 'SPKI-ONE', wrapped_privkey: 'PKCS8-ONE' });
ok(key1.status === 200, `the first keypair write succeeds (got ${key1.status})`);

const key2 = await call('POST', '/v1/researcher/pubkey', { pubkey: 'SPKI-TWO', wrapped_privkey: 'PKCS8-TWO' });
ok(key2.status === 409,
   `a SECOND browser racing the same account gets 409, not silent last-write-wins — otherwise every `
   + `grant already wrapped to the first key is stranded (got ${key2.status})`);
ok(key2.json && key2.json.pubkey === 'SPKI-ONE',
   'and the 409 hands back the WINNER\'s pair, so the loser can adopt it instead of guessing');

/* ---- 4. the wrap-to-owner invariant ---- */
const noOwner = await call('POST', '/v1/researcher/keys', {
  instance_id: instanceId,
  grants: [{ researcher_id: '00000000-0000-4000-8000-00000000beef', wrapped_ki: 'CIPHERTEXT-FOR-A-MEMBER' }],
});
ok(noOwner.status === 400 && noOwner.json && noOwner.json.error === 'owner_grant_required',
   `a grant set WITHOUT the owner is refused outright (got ${noOwner.status} ${noOwner.json && noOwner.json.error})`);

const withOwner = await call('POST', '/v1/researcher/keys', {
  instance_id: instanceId,
  grants: [
    { researcher_id: FIXTURE.researcherId, wrapped_ki: 'CIPHERTEXT-FOR-OWNER' },
    { researcher_id: '00000000-0000-4000-8000-00000000beef', wrapped_ki: 'CIPHERTEXT-FOR-A-MEMBER' },
  ],
});
ok(withOwner.status === 200, `the same set WITH the owner's copy is stored (got ${withOwner.status})`);
ok(withOwner.json && withOwner.json.stored === 2, `both grants land (${withOwner.json && withOwner.json.stored})`);

/* ---- 5. a researcher reads back only their OWN grants ---- */
const mine = await call('GET', `/v1/researcher/keys?instance=${instanceId}`);
ok(mine.status === 200, `GET /v1/researcher/keys is 200 (got ${mine.status})`);
const keys = (mine.json && mine.json.keys) || [];
ok(keys.length === 1 && keys[0].wrapped_ki === 'CIPHERTEXT-FOR-OWNER',
   "it returns the caller's own wrapped key and not the other grantee's");

/* ---- 6. re-granting the same version REPLACES rather than duplicating ---- */
const again = await call('POST', '/v1/researcher/keys', {
  instance_id: instanceId,
  grants: [{ researcher_id: FIXTURE.researcherId, wrapped_ki: 'CIPHERTEXT-FOR-OWNER-V2' }],
});
ok(again.status === 200, `re-granting is accepted (got ${again.status})`);
const after = await call('GET', `/v1/researcher/keys?instance=${instanceId}`);
const rows = (after.json && after.json.keys) || [];
ok(rows.length === 1 && rows[0].wrapped_ki === 'CIPHERTEXT-FOR-OWNER-V2',
   're-granting the same key_version replaces the row rather than accumulating duplicates');

console.log(fail ? `\nFAILED (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
