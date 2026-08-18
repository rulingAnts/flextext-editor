/* A SENT ASSIGNMENT MUST NOT VANISH between the command and the device's first report.
 *
 * WHY THIS TEST EXISTS (Seth, from the v336 test drive): an edit-and-upload "just disappears until
 * the remote device loads it and then uploads it again". The upload-queue card covers the bytes
 * going UP to Drive and then deletes its own record the moment the assign command is sent — but the
 * longer half of the wait starts there. A field device may be off for hours. In that window the
 * panel showed nothing at all: no row, no marker, no evidence the assignment had ever been made.
 *
 * ⚠ WHAT MAKES THIS WORTH PINNING is that the bug and the fix look identical from the outside on a
 * fast connection: with a device that polls immediately, the row appears either way and nothing
 * seems wrong. You only see the difference with a device that has NOT checked in — which is exactly
 * the case that matters in the field and exactly the one nobody reproduces by hand. That is the same
 * reasoning as panel-pending-cmds.test.mjs, whose v131 timer bug had the same property.
 *
 * The rules being pinned:
 *   1. The marker is created from the Worker's SEQ, at the moment the command is sent, BEFORE the
 *      queue record is deleted — otherwise there is a window with nothing on screen.
 *   2. It is retired by an INVENTORY FACT (the text appears), never by elapsed time.
 *   3. It renders as a real row through the SAME renderer as every other text, so the pending state
 *      is shown "the way it shows a pending delete" rather than as a parallel widget.
 *   4. It offers cancel only while genuinely withdrawable (seq > ack_seq), and never offers actions
 *      that need a text the device does not have.
 *   5. It is NOT added on the move path, which already shows its own chip — two markers for one
 *      wait is worse than none.
 *
 * Run: node test/pending-assign-visible.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const panel = read('../docs/js/researcher-panel.js');
const i18n = read('../docs/js/i18n.js');
const css = read('../docs/css/app.css');

console.log('\nthe marker is created from the Worker seq, at send time');
{
  ok(/const sent = await Researcher\.assign\(rec\.instanceId, docId, fields\);/.test(panel),
     'the assign call keeps its result — pushCommand returns the seq');
  ok(/pendingCmds\.set\(docId, \{ seq: sent\.seq, kind: 'assign', instanceId: rec\.instanceId/.test(panel),
     "a pendingCmds marker of kind 'assign' is set from that seq");
  ok(/savePending\(Researcher\.currentAccountId\(\)\)/.test(panel.slice(panel.indexOf("kind: 'assign'"))),
     'and PERSISTED, so a panel reload does not lose the wait');

  /* ORDERING IS THE WHOLE POINT: the queue record is what is on screen until the marker exists.
   * Set the marker after deleting it and there is a window — however brief — showing nothing, which
   * on a slow render is the very gap being fixed. */
  const setAt = panel.indexOf("kind: 'assign'");
  const delAt = panel.indexOf('await db.deleteMedia(key).catch', setAt - 4000);
  ok(setAt > 0 && delAt > setAt, 'the marker is set BEFORE the queue record is deleted');
}

console.log('\n...and retired by an inventory FACT, never by a clock');
{
  ok(/p\.kind === 'assign'\s*\n?\s*\? d !== undefined/.test(panel),
     'an assign is done when the text APPEARS in an inventory — the mirror of a delete');
  // The v130 disease this suite already cured once; a reintroduction would look correct in review.
  ok(!/Date\.now\(\)\s*-\s*p\.at/.test(panel), 'nothing computes an age from the marker timestamp');
  ok(!/ASSIGN_WAIT_MS|assignTimeout/.test(panel), 'and no expiring timer was introduced');
}

console.log('\nit renders as a real row, through the same renderer as every other text');
{
  /* v388 split this in two: serverPending is keyed per instance, so the device filter now happens
   * while the two maps are merged, and the ghost filter keeps only the "text is absent" half.
   * BOTH halves are still required — assert them separately rather than loosening the check. */
  ok(/for \(const \[, pc\] of serverPending\) if \(pc\.instanceId === it\.instance_id\)/.test(panel)
     && /for \(const \[docId, pc\] of pendingCmds\) if \(pc\.instanceId === it\.instance_id\)/.test(panel),
     'both pending maps are filtered to THIS device before a ghost can be built from them');
  ok(/pc\.kind === 'assign' && !invIds\.has\(docId\)/.test(panel),
     'a ghost row is synthesized only while the text is absent from the inventory');
  ok(/const listed = \[\.\.\.ghosts, \.\.\.\(inv \|\| \[\]\)\]/.test(panel),
     'ghosts are prepended to the real inventory and share its renderer');
  ok(/const rows = listed\.length \? listed\.map/.test(panel),
     'the renderer iterates the merged list, not the raw inventory');
  /* A device with an EMPTY inventory must still show the ghost. The old code short-circuited on
   * `inv && inv.length`, so a brand-new device's first assignment — the single most likely moment
   * for this whole feature to matter — would have rendered "no texts yet". */
  ok(!/const rows = inv && inv\.length \? inv\.map/.test(panel),
     'the empty-inventory short-circuit is gone, so a first assignment to a fresh device still shows');
}

console.log('\nthe state is distinguishable, and never reads as "being deleted"');
{
  ok(/if \(d\.__assigning\) disp = queued \? 'assigning' : 'assignTaken';/.test(panel),
     'queued vs taken are different states, derived from ack_seq like every other row');
  // SECURITY: disp lands in a class attribute in this privileged panel.
  const allow = (panel.match(/const DISP = \[([^\]]*)\]/) || [])[1] || '';
  ok(/'assigning'/.test(allow) && /'assignTaken'/.test(allow),
     'both are in the fixed allow-list, so neither renders as the "local" fallback');
  ok(/rp-pending-assign/.test(panel) && /\.rp-pending-assign \{[^}]*opacity/.test(css),
     'the row is styled as provisional');
  ok(!/rp-pending-assign[^{]*\{[^}]*line-through/.test(css),
     'and NOT struck through — that is what rp-pending-del means, and it would read as removal');
  ok(/\.rp-tag-assigning \{/.test(css) && /\.rp-tag-assignTaken \{/.test(css), 'both chips are styled');
}

console.log('\nit offers only actions that can actually be honoured');
{
  ok(/const up = d\.__assigning\s*\n?\s*\? \(queued \? cancelBtn\('Assign'\) : takenTag\)/.test(panel),
     'cancel while queued; once taken it says so instead of offering a cancel that would be refused');
  ok(/const moveBtn = \(!d\.id \|\| mv \|\| d\.__assigning/.test(panel),
     'no Move — the device does not have the text yet');
  ok(/const del = \(!d\.id \|\| d\.__assigning\) \? ''/.test(panel),
     'and no Remove-from-device, for the same reason');
  // cancel-cmd is kind-agnostic and re-checks with the Worker, so it already serves 'assign'.
  ok(/await busy\(el, \(\) => Researcher\.cancelCommand\(p\.instanceId \|\| id, p\.seq\)\)/.test(panel),
     'cancel reuses the existing seq-checked withdrawal — the Worker still refuses if too late');
}

console.log('\nthe move path deliberately does NOT double up');
{
  /* ⚠ Scope to moveTextModal's OWN body. This used to slice everything after it, which swept in
   * whatever function happened to be defined next — and once adoptTextModal existed (Unassigned →
   * device, which legitimately DOES set an assign marker, since it has no pendingMoves entry) the
   * assertion failed on correct code. A test whose scope depends on file ordering is a trap. */
  const moveStart = panel.indexOf('function moveTextModal');
  const moveBlock = panel.slice(moveStart, panel.indexOf('\nfunction ', moveStart + 10));
  ok(/pendingMoves\.set\(docId, \{ from: fromId, to, title, at: Date\.now\(\), stage: 'assigned' \}\)/.test(moveBlock),
     'a move still records its own marker');
  ok(!/kind: 'assign'/.test(moveBlock),
     'and does NOT also set a pendingCmds assign — one wait, one marker');
  ok(moveBlock.length > 200 && moveBlock.length < panel.length / 2,
     `...and the slice really is just that function (${moveBlock.length} chars)`);
}

/* ---------------------------------------------------------------------------------------------
 * v339: THE ROW ALSO HAS TO GET DRAWN.
 *
 * Everything above pins that the marker is created, retired and rendered CORRECTLY. It was, and it
 * still did not reliably appear — Seth: assigned texts and their status refresh "a little slow and
 * not always automatic". The cause was one level up: `viewSig` decides whether the 12s poll
 * re-renders at all, and it was built from SERVER data alone. A marker set while the device was
 * offline changes nothing server-side, so the signature was identical, the poll concluded "nothing
 * to redraw", and the row never appeared.
 *
 * ⚠ This is the same shape of bug as the one this file already guards, one layer out: it is
 * INVISIBLE against a device that polls promptly (the inventory changes, the signature changes, the
 * render happens, everything looks right) and shows only against an offline device — which is
 * precisely the case the pending row exists for. A correct renderer that is never called is
 * indistinguishable from a broken renderer.
 * ------------------------------------------------------------------------------------------- */
console.log('\nthe poll actually re-renders when only CLIENT-side pending state changed');
{
  const sig = (panel.match(/function viewSig\(data\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(/pendingCmds/.test(sig), 'viewSig includes pendingCmds — without it an offline assign draws nothing');
  ok(/pendingMoves/.test(sig), 'and pendingMoves, which had the same latency');
  ok(/p\.kind, p\.seq/.test(sig),
     'the marker KIND and SEQ are in the signature, so queued->taken redraws too');
  // Map iteration order must not make an unchanged state look changed, or the dashboard would
  // redraw every 12s forever — a fix that trades one annoyance for a worse one.
  ok(/\.sort\(/.test(sig), 'entries are sorted, so a stable state yields a stable signature');
  ok(/viewSig\(data\) !== lastSig\) renderDashboard\(data\)/.test(panel),
     'and the poll still renders only on a real change');
}

console.log('\n...and the researcher sees their own action immediately, not on the next tick');
{
  const after = panel.slice(panel.indexOf("kind: 'assign'"));
  ok(/renderDashboard\(lastData \|\| undefined\)/.test(after.slice(0, 700)),
     'setting the marker redraws at once');
  ok(/no refetch/.test(after.slice(0, 700)) || /lastData \|\| undefined/.test(after.slice(0, 700)),
     '...from cached data — the marker is client-side, so a server round trip would buy nothing');
}

console.log('\nevery new string is in BOTH languages');
{
  const block = (lang) => {
    const at = i18n.indexOf(`\n${lang}: {`);
    const rest = i18n.slice(at + 1);
    const nxt = rest.search(/\n[a-z]{2,3}: \{/);
    return nxt < 0 ? i18n.slice(at) : i18n.slice(at, at + 1 + nxt);
  };
  for (const k of ['panel.up.assigning', 'panel.up.assigningWhy', 'panel.up.assignTaken',
                   'panel.up.assignTakenWhy', 'panel.inst.cancelAssign']) {
    const re = new RegExp(`^  '${k.replace(/\./g, '\\.')}':`, 'm');
    ok(re.test(block('en')) && re.test(block('id')), `${k} is in en AND id`);
  }
  // The chip is a label; the "why" line is what actually answers the researcher's question.
  const why = (i18n.match(/'panel\.up\.assigningWhy': '([^']*)'/) || [])[1] || '';
  ok(/device/i.test(why) && /(online|pick)/i.test(why),
     'the queued explanation says the wait is on the DEVICE, not on the panel');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
