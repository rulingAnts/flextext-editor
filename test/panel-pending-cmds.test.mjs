/* The "Remove from device" strikethrough must be derived from `install.ack_seq`, NEVER from a clock.
 *
 * WHY THIS TEST EXISTS: before v131 the marker faded on a 10-minute TIMER, so a request the device
 * simply had not polled for yet became indistinguishable from one that was never made — the row
 * un-struck itself while the command was still queued server-side and the text was still on the
 * device. v131 replaced the timer with state derived from ack_seq. The bug is INVISIBLE in normal
 * testing (you need a device that has not checked in yet) and the symptom on the way back is
 * exactly the symptom on the way in, so a reviewer cannot tell a regression from the original bug
 * by looking at the UI. That is what makes it worth pinning in a test.
 *
 * These are SOURCE assertions, not behavioural ones: the decision lives inside renderDashboard and
 * renderInstanceCard, which need a DOM, a signed-in researcher account and a live Worker. What can
 * be checked without any of that is the chain the mechanism depends on — the Worker returning the
 * seq, the client keeping it, the marker being PERSISTED before the next render reads it back, and
 * the retirement condition demanding a real outcome rather than elapsed time. Break any link and
 * the strikethrough silently reverts to the pre-v131 behaviour.
 *
 * Run: node test/panel-pending-cmds.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const panel = read('../docs/js/researcher-panel.js');
const researcher = read('../docs/js/researcher.js');
const worker = read('../worker/src/v1.js');

console.log('\nno clock survives anywhere in the mechanism');
{
  // The v130 names. Their absence is the whole point of v131 — a reintroduction under any of these
  // names is the regression, and it would look correct in review.
  for (const dead of ['requestedUploads', 'requestedDeletes', 'UPLOAD_WAIT_MS', 'DELETE_WAIT_MS']) {
    ok(!panel.includes(dead), `researcher-panel.js has no ${dead} (the expiring-timer design)`);
  }
  // `at:` is still stored on a marker for diagnostics; it must not be what DECIDES the state.
  ok(!/Date\.now\(\)\s*-\s*p\.at/.test(panel), 'nothing computes an age from the marker timestamp');
}

console.log('\nthe Worker hands back the seq it assigned');
{
  ok(/return j\(\{ ok: true, seq, desired_rev: newRev \}/.test(worker),
     'POST .../command responds with { ok, seq, desired_rev }');
  ok(/const seq = \(blob\.commands\.length \? blob\.commands\[blob\.commands\.length - 1\]\.seq : 0\) \+ 1;/.test(worker),
     'the seq is monotonic per instance (last command + 1)');
  ok(/if \(seq <= maxAck\) return j\(\{ error: 'already_delivered'/.test(worker),
     'cancel is refused once any install has acked past the seq — never a silent no-op');
}

console.log('\nthe client keeps that seq');
{
  ok(/return \{ ok: true, seq: r\.seq, desired_rev: r\.desired_rev \};/.test(researcher),
     'pushCommand() returns the Worker seq to its caller');
  ok(/ack_seq: ins\.ack_seq/.test(researcher),
     'listView() surfaces each install\'s ack_seq under that exact name');
  ok(/parseInt\(ins\.ack_seq, 10\) \|\| 0/.test(panel),
     'ackOf() parses ack_seq, so a stringified value cannot poison the >= comparison');
  ok(/max = Math\.max\(max, parseInt\(ins\.ack_seq, 10\) \|\| 0\)/.test(panel),
     'ackOf() takes the MAX across installs (either app on a device may hold the text)');
}

console.log('\nEVERY marker write is persisted before the next render can read it back');
{
  // renderDashboard() calls loadPending() on every render, which OVERWRITES the in-memory map from
  // localStorage. So a set() without a matching savePending() is lost on the next 12s poll — which
  // presents as the strikethrough "bouncing back" with no error anywhere.
  const setLines = panel.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /pendingCmds\.set\(|pendingCmds\.delete\(/.test(l));
  ok(setLines.length > 0, `found ${setLines.length} pendingCmds mutation(s) to check`);
  for (const [n, line] of setLines) {
    // The save may be on the same line or within the next few (the delete-on-outcome sweep batches
    // its writes behind a `changed` flag).
    const after = panel.split('\n').slice(n - 1, n + 5).join('\n');
    ok(/savePending\(/.test(after), `the mutation at line ${n} is followed by savePending()`);
  }
  ok(/loadPending\(Researcher\.currentAccountId\(\)\)/.test(panel) && /savePending\(Researcher\.currentAccountId\(\)\)/.test(panel),
     'load and save use the same per-account key');
}

console.log('\nthe marker is retired on an OUTCOME, never on elapsed time');
{
  ok(/p\.kind === 'delete'\s*\n?\s*\? \(d === undefined && ackOf\(insts, p\.instanceId\) >= p\.seq\)/.test(panel),
     'a delete retires only when the text is gone from EVERY inventory AND the device acked it');
  ok(/: !!\(d && d\.uploadedFileId && d\.uploadedFileId !== p\.prevFileId\)/.test(panel),
     'an upload retires only when the device reports a NEW file id');
}

console.log('\nqueued vs taken is a comparison against ack_seq, and only queued offers a cancel');
{
  ok(/const queued = !!p && p\.seq > maxAck;/.test(panel), 'queued  = seq >  maxAck (device has not seen it)');
  ok(/const taken\s+= !!p && p\.seq <= maxAck;/.test(panel), 'taken   = seq <= maxAck (device has it)');
  ok(/\(queued \? cancelBtn\('Delete'\) : takenTag\)/.test(panel),
     'a taken delete shows an inert tag, never a cancel the Worker would refuse');
  // The strikethrough itself must NOT depend on queued/taken — a delete in progress is still a
  // delete, and un-striking it the moment the device picks it up is the reported symptom.
  ok(/const deleting = !!d\.pendingDelete \|\| !!\(p && p\.kind === 'delete'\);/.test(panel),
     'the row strikes through for ANY outstanding delete marker, queued or taken');
  ok(/\.rp-pending-del \{[^}]*line-through/.test(read('../docs/css/app.css')),
     'and .rp-pending-del actually renders as a strikethrough');
}

console.log(fail ? `\nFAILED (${fail}) — the ack_seq-derived request state has drifted.\n`
                 : '\nPASS: request state is derived from ack_seq and persisted on every write.\n');
process.exit(fail ? 1 : 0);
