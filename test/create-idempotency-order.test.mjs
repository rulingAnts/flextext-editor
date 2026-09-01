/* THE CLIENT MUST NOT GET AHEAD OF THE WORKER ON DEVICE CREATION (issue #6, deploy order).
 *
 * `createKey` is safe to send anywhere — an old worker ignores an unknown body field. RETRYING is
 * not: it is safe only once the worker REPLAYS that key. Against a worker that does not, a retry
 * over a lost response creates the second device the whole change exists to prevent, so shipping
 * the client with retry ON would make issue #6 WORSE for exactly as long as the deploy took. That
 * is this repo's backend-first rule with a concrete cost attached.
 *
 * ⚠ WHY A TEST AND NOT A NOTE. The flag is one word in a file nobody re-reads, and the moment that
 * makes it correct — the worker deploy — happens somewhere else entirely, possibly days later and
 * possibly by someone who never saw this code. A comment cannot notice that pairing; this can.
 *
 * WHEN THE WORKER IS LIVE: set CREATE_RETRY_SAFE = true, and update the expectation below in the
 * same commit. Deliberately NOT automatic — flipping it is a claim about production that only a
 * human who watched the deploy can make.
 */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

test('device-creation retry is gated on the worker', () => {
  const res = readFileSync(new URL('../docs/js/researcher.js', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../worker/src/v1.js', import.meta.url), 'utf8');

  console.log('\nthe key travels; the retry waits for the worker');
  {
    ok(/const CREATE_RETRY_SAFE = (true|false);/.test(res), 'the flag exists and is a single literal');
    /* ⚠ FLIPPED 2026-09-01, in the same commit as the flag, which is what this file asked for.
     * The worker that replays create_key on BOTH create routes — including the member route's
     * converging replay — is live as version 21374218-3910-4fa2-b30b-f4d78c5aac83. Retrying is
     * therefore safe: a lost response now finds the row that exists instead of minting a second
     * device, which is the whole of issue #6.
     * ⚠ IF THE WORKER IS EVER ROLLED BACK BEHIND THAT VERSION, this flag goes back to false FIRST.
     * A client that retries against a worker which does not replay is worse than one that never
     * retried — it manufactures exactly the duplicate the feature exists to prevent. */
    const on = /const CREATE_RETRY_SAFE = true;/.test(res);
    ok(on, on
      ? 'retry is ON — the create_key worker is deployed, so a lost response replays instead of duplicating'
      : '⚠ retry is OFF while the worker DOES replay — issue #6 is silently unfixed for every researcher');
    // Both create paths must use the flag; one of them retrying is the same bug on a different route.
    const uses = (res.match(/retry: CREATE_RETRY_SAFE/g) || []).length;
    ok(uses === 2, `both create paths (owner + member) are gated by it (${uses}/2)`);
    ok(!/body: \{ nickname, createKey \}, retry: true/.test(res),
       'neither hard-codes retry:true behind the flag');
  }

  console.log('\nthe key itself is sent regardless — it is inert to an old worker');
  {
    ok((res.match(/createKey/g) || []).length >= 4, 'createKey is minted and sent on both paths');
    ok(/crypto\.randomUUID/.test(res), 'and it is a real unique id, not a derived guess');
  }

  console.log('\nthe worker half is present and additive, so the flip is the ONLY thing waiting');
  {
    ok(/async function instanceByCreateKey/.test(worker), 'the worker can look a key up');
    ok(/return \{ usable: true, row: row \|\| null \};/.test(worker), '...reporting whether the column exists');
    ok(/catch \{ return \{ usable: false, row: null \}; \}/.test(worker),
       '...and failing SOFT on a pre-migration database, never refusing to create a device');
    ok(/create_key TEXT/.test(readFileSync(new URL('../worker/migrate-instance-create-key.sql', import.meta.url), 'utf8')),
       'the migration adds the column');
  }

  /* ⚠ THE HALF THAT ACTUALLY FIXES ISSUE #6, and the half that was wrong for a while.
   *
   * A replay must CONVERGE — skip the INSERT, then run the same placement leg — not return the
   * stored row early. The row a replay finds is most often the one whose Drive folder was never
   * made (the response is lost precisely BECAUSE placement is slow), so an early return freezes
   * that device showing under its project AND under "not in a project yet", permanently. That is
   * Brian's reported symptom reached by the code meant to prevent it.
   *
   * The owner route had this right; the member route did not, and shipped an early return. Both are
   * asserted here because "one of the two converges" is exactly the state that looked correct. */
  console.log('\nboth create routes CONVERGE on a replay — no early return, no frozen device');
  {
    const fallThrough = (worker.match(/if \(seen\.row\) \{ \/\* the row exists — fall through to the placement leg \*\/ \}/g) || []).length;
    ok(fallThrough === 2, `both routes fall through on a found row (${fallThrough}/2)`);

    /* The mechanism of the bug was a SECOND return built for the replay case. Its helper is gone;
     * if it comes back, so has the divergence. */
    ok(!/createdInstanceReply\s*\(/.test(worker),
       'no separate replay-reply builder — one return per route, so shapes cannot drift');

    /* Convergence is only healing if the placement is seeded with what is already there; passing an
     * empty existingId would make a replay CREATE A SECOND FOLDER instead of resolving the first. */
    const seeded = (worker.match(/replayed \? \(replayed\.oauth_folder_id \|\| ''\) : ''/g) || []).length;
    ok(seeded >= 1, `a replay seeds the folder lookup from the stored row (${seeded})`);
    ok(/driveEnsureDeviceFolder\(env, access, instance_id, placeName, folderId, project\.drive_folder_id\)/.test(worker),
       '...and passes it as existingId, so an existing folder is resolved rather than duplicated');

    /* A retry's body must not rename an existing device as a side effect. */
    const stored = (worker.match(/const placeName = replayed \? replayed\.nickname : nickname;/g) || []).length;
    ok(stored === 2, `both routes keep the STORED nickname on a replay (${stored}/2)`);
  }

  console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
  if (fail) throw new Error(`${fail} check(s) failed`);
});
