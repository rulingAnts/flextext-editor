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
    const on = /const CREATE_RETRY_SAFE = true;/.test(res);
    ok(!on, on
      ? '⚠ retry is ON — only correct if the create_key worker is DEPLOYED. If it is, update this test in the same commit.'
      : 'retry is OFF while the create_key worker is undeployed — a lost response cannot duplicate');
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

  console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
  if (fail) throw new Error(`${fail} check(s) failed`);
});
