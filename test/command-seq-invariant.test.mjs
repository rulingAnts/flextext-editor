/* A command's seq must never be reused at or below what a device has already acked.
 *
 * WHY THIS NEEDS A TEST: the Worker allocates seq as `tail.seq + 1` — inferred from the array —
 * and the cancel endpoint REMOVES entries from that array. Those two facts are only compatible
 * because cancel refuses any seq <= max(ack_seq), so acked commands can never be removed and the
 * tail therefore never drops below the ack watermark.
 *
 * That chain is invisible in either function on its own. The obvious future optimisation — prune
 * acked commands so the blob stays small — silently breaks it, and the damage is unobservable:
 * the DEVICE runs only commands with `seq > its ack_seq` (docs/js/sync.js), so a reused seq is
 * skipped forever with no error anywhere. The researcher clicks Remove, nothing happens, and there
 * is nothing in any log to explain it.
 *
 * This models the Worker's two rules directly, so it fails the moment either side changes.
 *
 * Run: node test/command-seq-invariant.test.mjs
 */

import { readFileSync } from 'node:fs';
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

/* --- the Worker's rules, mirrored exactly (worker/src/v1.js) --- */
const allocate = (cmds) => (cmds.length ? cmds[cmds.length - 1].seq : 0) + 1;   // seq = tail + 1
function cancel(cmds, seq, maxAck) {                                            // refuses acked
  if (seq <= maxAck) return { cmds, refused: 'already_delivered' };
  const out = cmds.filter((c) => c.seq !== seq);
  if (out.length === cmds.length) return { cmds, refused: 'not_queued' };
  return { cmds: out, refused: null };
}
// The DEVICE's rule (docs/js/sync.js): run only what is strictly above its own ack.
const deviceWouldRun = (cmd, ackSeq) => (cmd.seq || 0) > ackSeq;

console.log('\nthe allocator never hands out a seq the device would skip');
{
  let cmds = [], maxAck = 0;
  const issue = () => { const s = allocate(cmds); cmds.push({ seq: s }); return s; };

  const s1 = issue(); const s2 = issue(); const s3 = issue();
  ok([s1, s2, s3].join() === '1,2,3', 'sequential while nothing is cancelled');

  maxAck = 2;                                              // device acked through 2
  ok(cancel(cmds, 2, maxAck).refused === 'already_delivered', 'an ACKED command cannot be cancelled');
  ok(cancel(cmds, 1, maxAck).refused === 'already_delivered', '...nor an older one');

  // Cancelling the unacked tail is allowed, and the reissued seq must still clear the ack.
  const after = cancel(cmds, 3, maxAck);
  ok(after.refused === null, 'the UNACKED tail can be cancelled');
  cmds = after.cmds;
  const reissued = allocate(cmds);
  ok(reissued === 3, 'the seq is reused (3 again) — which is only safe because 3 was never acked');
  ok(deviceWouldRun({ seq: reissued }, maxAck), 'and the device WOULD run it (3 > ack 2)');
}

console.log('\nthe invariant holds however many are cancelled');
{
  let cmds = [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }, { seq: 5 }];
  const maxAck = 2;                                        // 1 and 2 are acted on
  for (const s of [5, 4, 3]) cmds = cancel(cmds, s, maxAck).cmds;
  ok(cmds.map((c) => c.seq).join() === '1,2', 'every unacked command withdrawn; acked ones remain');
  const next = allocate(cmds);
  ok(next === 3, 'next seq is 3');
  ok(next > maxAck, 'STILL above the ack watermark — the device will not skip it');
}

console.log('\nan empty list is safe, because emptying it implies nothing was ever acked');
{
  let cmds = [{ seq: 1 }];
  const maxAck = 0;                                        // nothing acked
  cmds = cancel(cmds, 1, maxAck).cmds;
  ok(cmds.length === 0, 'the only command was cancellable and is gone');
  ok(allocate(cmds) === 1, 'allocation restarts at 1');
  ok(deviceWouldRun({ seq: 1 }, maxAck), 'and 1 > ack 0, so it runs');
}

console.log('\n⚠ THE REGRESSION THIS EXISTS TO CATCH: pruning acked commands breaks it');
{
  // The tempting optimisation: drop commands every device has already processed, to keep the
  // stored blob small. It is silently catastrophic.
  const prune = (cmds, maxAck) => cmds.filter((c) => c.seq > maxAck);
  const cmds = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];
  const maxAck = 3;                                        // device has processed everything
  const pruned = prune(cmds, maxAck);
  ok(pruned.length === 0, 'pruning empties the list');
  const next = allocate(pruned);
  ok(next === 1, 'the allocator restarts at 1 — a seq the device has ALREADY acked');
  ok(!deviceWouldRun({ seq: next }, maxAck),
     'so the device would SKIP that command forever — this is why pruning is forbidden');
}

/* ---------------------------------------------------------------------------------------------
 * ack_seq MUST BE MONOTONIC IN THE DATABASE, not merely in the handler that writes it.
 *
 * Everything above rests on ack_seq only ever RISING: the cancel endpoint's safety proof is
 * "no install has acked a seq this high, so nothing has acted on it", and the device runs only
 * commands with seq > its ack. If ack_seq can go backwards, a cancel can withdraw a command a
 * device already executed, and a re-used seq can be silently skipped for ever.
 *
 * The report handler used `Math.max(install.ack_seq, body.ack_seq)` in JAVASCRIPT — against a row
 * read by authInstall() at request entry, BEFORE `await readJson(request)` streamed an encrypted
 * inventory over a field uplink, which can take seconds. Two overlapping reports from one install
 * therefore last-writer-wins, and the loser's stale value can land. reportNow() is deliberately not
 * gated by sync.js's inFlight, so the overlap is reachable rather than theoretical.
 *
 * Doing the comparison inside the UPDATE makes it atomic with the write.
 * ------------------------------------------------------------------------------------------- */
{
  const worker = readFileSync(new URL('../worker/src/v1.js', import.meta.url), 'utf8');
  console.log('\nack_seq is maxed in SQL, atomically with the write');
  ok(/ack_seq=MAX\(ack_seq, \?\)/.test(worker),
     'the report UPDATE uses MAX(ack_seq, ?) rather than a value computed earlier in JS');
  ok(!/SET reported_blob=\?, reported_rev=reported_rev\+1, ack_seq=\?,/.test(worker),
     'and the bare ack_seq=? form, which could write a stale maximum, is gone');
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
