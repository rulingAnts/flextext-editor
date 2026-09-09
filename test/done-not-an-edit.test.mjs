/* MARKING A TEXT DONE IS NOT AN EDIT (#33, the half v580 did not reach).
 *
 * Seth, 2026-09-04: "it seems like it's pretty consistently registering changes made since marked
 * done. Is that because Yohanis marks it done first and then does some editing, or more likely
 * because something is out of order in status updates/uploads (to where maybe it sends it first and
 * THEN marks it done, which registers as a change?)"
 *
 * v580 fixed the ORDER (done is decided before the already-on-Drive short-cut). This is the other
 * half, found by running the real state expression over the real sequences:
 *
 *   auto-backup uploaded → Done          → "uploaded"   ✓ the stored uploadedSig rescues it
 *   Done → upload                        → "uploaded"   ✓
 *   Done on a closed text                → "uploaded"   ✓
 *   a real edit after Done               → "changed"    ✓ correct, it really did change
 *   LEGACY doc with NO uploadedSig, Done → "changed"    ✗ AND STUCK FOREVER
 *
 * ⚠ THE LAST ONE IS THE BUG, and it is the population Seth's devices are full of. A doc uploaded
 * before uploadedSig existed has no proof of sync, so it falls back to `uploadedModified ===
 * modified` — which persist()'s unconditional bump has just broken. Nothing ever re-uploads content
 * that has not changed, so the text reads "changed" for the rest of its life. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const doneFn = APP.slice(APP.indexOf('async function setDocDone'), APP.indexOf('// Kept though the in-editor button is gone'));

test('the in-sync verdict is read BEFORE persist(), which is what destroys the evidence', () => {
  const preIdx = doneFn.indexOf('const wasInSync');
  const persistIdx = doneFn.indexOf('await persist()');
  assert.ok(preIdx > 0 && persistIdx > 0, 'both are present');
  assert.ok(preIdx < persistIdx,
    'persist() bumps `modified` unconditionally — after it runs, "was this already backed up?" is unanswerable');
  assert.match(doneFn, /pre\.uploadedSig === preSig\) \|\| pre\.uploadedModified === pre\.modified/,
    'in sync means EITHER a matching signature (modern) or matching timestamps (legacy)');
});

test('a text that was already backed up does not start reading "changed" merely for being finished', () => {
  assert.match(doneFn, /if \(wantDone && wasInSync && uploadContentSig\(rec\) === preSig\) \{/);
  assert.match(doneFn, /rec\.uploadedModified = rec\.modified;/, 'the backup marker is realigned');
});

/* ⚠ THE GATE IS THE SIGNATURE, NOT THE FLAG. If the coworker typed something and then tapped Done,
 * persist() wrote it, the signature moves, and the text must keep reading "changed" so it uploads.
 * Getting this wrong would be far worse than the bug: it would tell a researcher that unsent work
 * is safely on Drive. */
test('but a real edit before tapping Done still reads changed', () => {
  assert.match(doneFn, /uploadContentSig\(rec\) === preSig/,
    'realign only when the content signature did not move across persist()');
});

/* A legacy doc gets a signature stamped as it is rescued, so it can never need rescuing twice. */
test('and a legacy doc is given the signature it never had', () => {
  assert.match(doneFn, /if \(!rec\.uploadedSig\) rec\.uploadedSig = preSig;/);
});

/* done / doneAt are workflow state, not content — asserted because the whole fix rests on it. */
test('the content signature ignores done and doneAt', () => {
  const sig = APP.slice(APP.indexOf('function uploadContentSig'), APP.indexOf('async function doUpload'));
  assert.match(sig, /JSON\.stringify\(rec\.doc\) \+ '\|' \+ \(rec\.audioId \|\| rec\.audioSource \|\| ''\) \+ '\|' \+ \(rec\.title \|\| ''\)/);
  assert.doesNotMatch(sig, /\bdone\b/, 'marking done cannot move the signature');
});

/* The v580 half, still standing. */
test('#33 v580: done is decided before the already-on-Drive short-cut', () => {
  const up = APP.slice(APP.indexOf('async function doUpload'), APP.indexOf('async function doUpload') + 3000);
  const doneIdx = up.indexOf('current.done = true');
  const shortcut = up.search(/already on Drive|uploadedSig === uploadContentSig/);
  assert.ok(doneIdx > 0 && shortcut > 0 && doneIdx < shortcut,
    'done is the coworker\'s statement, not a by-product of bytes moving');
});
