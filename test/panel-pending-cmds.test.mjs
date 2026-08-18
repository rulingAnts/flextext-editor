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

/* ---------------------------------------------------------------------------------------------
 * THE SHARED (server-derived) HALF — v388.
 *
 * WHY THIS SECTION EXISTS: v386/v387 added `serverPending` so a queued command shows in EVERY
 * researcher browser, not only the one that issued it. On first contact it produced four distinct
 * wrong behaviours (Seth, 2026-08-18), and all four are invisible in a quick test because a fresh
 * account has no command history to be confused by:
 *
 *   1. the gate compared `desired_rev` to `ack_seq`. They are different counters — desired_rev is a
 *      blob revision bumped by appends, cancels AND re-keys, while ack_seq tracks command seq,
 *      which DROPS when a cancel removes the tail. The gate was therefore always true.
 *   2. no `seq > maxAck` filter. The Worker never prunes acked commands (seq monotonicity), so the
 *      blob is HISTORY: a long-finished delete struck a text through forever, and a long-finished
 *      upload replaced that text's Upload button with an inert "in progress" tag — so the button
 *      that would have sent a new upload was not there to click.
 *   3. cancel read `pendingCmds` directly, so it was a silent no-op in the browser that learned of
 *      the command from the server, and sent a STALE seq in the browser that had one — withdrawing
 *      a different command and reporting success while the real delete stayed queued.
 *   4. neither renderDashboard() nor viewSig() looked at the map, so the state it derived only
 *      reached the screen when some unrelated server fact happened to change.
 * ------------------------------------------------------------------------------------------- */

console.log('\nthe shared map holds PENDING commands, not command history');
{
  ok(/if \(!\(c\.seq > maxAck\)\) continue;/.test(panel),
     'refreshServerPending drops any command the device has already acked');
  ok(!/desired_rev, 10\) > ackOf\(/.test(panel),
     'nothing compares desired_rev against ack_seq (different counters, never comparable)');
  ok(/hit\.rev !== rev/.test(panel),
     'the decrypted blob is cached by desired_rev, so a steady state costs no requests');
  ok(/const maxAck = ackOf\(instances, it\.instance_id\);/.test(panel),
     'the ack filter is re-applied per instance on every refresh, against the CURRENT ack_seq');
  // Per-instance keying: seq counters are per instance, so a docId alone cannot identify a command.
  ok(/const spKey = \(instanceId, docId\) =>/.test(panel),
     'serverPending is keyed by (instance, doc), never by doc alone');
  ok(/function pendingFor\(docId, instanceId\)/.test(panel),
     'pendingFor takes the instance, so one device’s marker cannot decorate another’s row');
  ok(/const p = pendingFor\(d\.id, it\.instance_id\);/.test(panel),
     'the row renderer passes the instance it is drawing');
}

console.log('\ncancel withdraws the command the ROW is showing');
{
  ok(/const p = pendingFor\(docId, id\);/.test(panel),
     'the cancel handler resolves the command through pendingFor, not pendingCmds');
  ok(/Researcher\.cancelCommand\(p\.instanceId \|\| id, p\.seq\)/.test(panel),
     'it cancels that command’s seq on that command’s instance');
  ok(/serverPending\.delete\(spKey\(id, docId\)\)/.test(panel) && /invalidateBlob\(id\)/.test(panel),
     'a successful cancel clears BOTH maps and invalidates the cached blob');
  ok(/not_queued\|404/.test(panel),
     'not_queued is reported as cancelled — the Worker checks ack_seq first, so it proves it never ran');
}

console.log('\na cancel in ANOTHER browser retires the local marker (v389)');
{
  /* The half v388 missed. The three retirement outcomes above are all things the DEVICE does; a
   * withdrawal performed in a second panel is not one of them, so the issuing browser kept a
   * strikethrough and a Cancel button for a command the server no longer held. */
  ok(/let serverSeqs = new Map\(\);/.test(panel),
     'every seq still in each instance blob is recorded, so a vanished seq is detectable');
  ok(/seqs\.set\(it\.instance_id, new Set\(\(hit\.cmds \|\| \[\]\)\.map\(\(c\) => c && c\.seq\)\)\);/.test(panel),
     'recorded BEFORE the ack filter — an acked command still exists on the server');
  ok(/const withdrawn = !!known && p\.seq > ackOf\(insts, p\.instanceId\) && !known\.has\(p\.seq\);/.test(panel),
     'a still-QUEUED marker whose seq is gone from the blob was withdrawn elsewhere');
  ok(/if \(done \|\| withdrawn\) \{ pendingCmds\.delete\(docId\); changed = true; \}/.test(panel),
     'and it is retired through the same sweep, so the write is still batched and persisted');
  // The dangerous misreading: a failed fetch must not look like an empty queue.
  ok(/!!known &&/.test(panel),
     'an instance absent from serverSeqs means "could not read", never "nothing queued"');
}

console.log('\nthe derived state actually reaches the screen');
{
  ok(/await refreshServerPending\(insts\);/.test(panel),
     'renderDashboard re-derives the shared state, so an action-driven redraw is not a tick behind');
  ok(/\[\.\.\.serverPending\]\.sort\(/.test(panel),
     'viewSig includes serverPending, so a command issued in another browser triggers a redraw');
}

console.log(fail ? `\nFAILED (${fail}) — the ack_seq-derived request state has drifted.\n`
                 : '\nPASS: request state is derived from ack_seq and persisted on every write.\n');
process.exit(fail ? 1 : 0);
