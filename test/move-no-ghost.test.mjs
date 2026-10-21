/* A MOVE MUST NOT HOLD THE SOURCE HOSTAGE TO THE TARGET (#70).
 *
 * Seth, 2026-09-10: "It doesn't delete it on the source device until it verifies it's gone to the
 * target device. That's unnecessary and undesirable behavior. As soon as it verifies the successful
 * upload from the source device it should move it to the target device as a pending assignment and
 * not leave a ghost behind on the source device."
 *
 * A move is two independent transfers with Drive in the middle. Gating the first on the second meant
 * a target device that was off — for a week, on the connections this suite is built for — kept the
 * text sitting on the source, where the coworker could reasonably think the move had failed and keep
 * editing it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const panel = rd('../docs/js/researcher-panel.js');
const app = rd('../docs/js/app.js');

test('the source is told to remove without waiting for the destination to report', () => {
  const sweep = panel.slice(panel.indexOf('const transitions = [];'));
  const assigned = sweep.slice(0, sweep.indexOf("mv.stage === 'removing'"));
  assert.match(assigned, /if \(mv\.stage === 'assigned'\) \{/, 'the assigned stage fires immediately');
  assert.doesNotMatch(assigned, /findInventoryItem\(mv\.to, docId\)/,
    'and never gates on the TARGET reporting the doc — that was the ghost');
  assert.match(assigned, /Researcher\.uploadDelete\(mv\.from, docId\)/, 'it issues the upload-first remove');
});

/* ⚠ THE SAFETY CONDITION LIVES ON THE DEVICE, WHICH IS WHY REMOVING THE PANEL'S GATE IS SAFE.
 * If this ever stops being true, #70's fix becomes a data-loss bug — so it is pinned here, in the
 * test for the change that depends on it, not only where the code lives. */
test('and the device still refuses to delete until its upload is confirmed', () => {
  const handler = app.slice(app.indexOf("case 'uploadDelete': {"));
  const body = handler.slice(0, handler.indexOf("case 'triggerUpload'"));
  assert.match(body, /deleteConfirmedDoc\(docId\)/, 'deletion goes through the proof-of-backup check');
  assert.match(body, /setPendingUpDel/, 'and the intent is persisted, so a reload cannot orphan it');
  // The proof-of-backup helper must actually verify, not just be called.
  const proof = app.slice(app.indexOf('async function deleteConfirmedDoc'));
  assert.match(proof.slice(0, 900), /uploadedFileId/,
    'deleteConfirmedDoc checks the text really is backed up');
});

/* Retries are what make the immediate issue safe on a bad connection: a transient failure leaves the
 * move in 'assigned' and the next poll tries again, rather than losing the command. */
test('a transient failure to issue the command is retried, not dropped', () => {
  const sweep = panel.slice(panel.indexOf("if (mv.stage === 'assigned') {"));
  assert.match(sweep.slice(0, 900), /catch \{ \/\* transient — retried next poll \*\/ \}/,
    'the issue path retries on the next poll');
  /* ⚠ And two panels polling in the same second must not both queue a delete — uploadDelete uploads
   * a fresh copy first, so a duplicate is a wasted upload on a field connection. */
  assert.match(sweep.slice(0, 900), /if \(pendingFor\(docId, mv\.from\)\) continue;/,
    'and it will not queue a second delete while one is outstanding');
});

/* The completion signal is unchanged and still guards against "absent because unreadable". */
test('the move only completes when the source has actually reported the text gone', () => {
  const sweep = panel.slice(panel.indexOf('const transitions = [];'));
  assert.match(sweep, /mv\.stage === 'removing' && instanceReported\(mv\.from\) && !findInventoryItem\(mv\.from, docId\)/,
    'a revoked or undecryptable source must not be read as a completed move');
});

/* A destination too old to receive a move is excluded at SELECTION time, so the source can never be
 * cleared for a text the target's engine could not accept. */
test('a pre-v138 device still cannot be chosen as a destination', () => {
  const modal = panel.slice(panel.indexOf('async function moveTextModal('));
  assert.match(modal.slice(0, 1200), /_canReceive = engOf\(x\) >= 138/,
    'the engine gate is at selection, which is what makes the immediate removal safe');
});

/* ⚠ CANCELLING THE ASSIGNMENT DOES NOT STOP THE SOURCE RELEASING THE TEXT, AND THAT IS DELIBERATE.
 * Seth, 2026-09-10: "'Cancel assignment' would move it to the Google Drive (Unassigned) folder. In
 * an ideal world there'd be some kind of 'undo move' option, but we don't need that kind of
 * complexity/entropy right now. Cancel assignment kicking it to Google Drive Unassigned is
 * acceptable." — "As a consistent behavior."
 *
 * A version that withdrew the source's queued removal was written and removed again: it made the
 * outcome depend on how fast the researcher clicked — sometimes the text stayed on the source,
 * sometimes it went to Unassigned. One outcome beats a race. */
test('cancelling the assignment does not chase the removal — Unassigned is the one outcome', () => {
  const at = panel.indexOf("} else if (act === 'cancel-cmd') {");
  const block = panel.slice(at, panel.indexOf("} else if (act === 'move-text')", at));
  assert.doesNotMatch(block, /cancelCommand\(mvRec\.from/,
    'no attempt to withdraw the source-side removal');
  assert.match(block, /if \(pendingMoves\.has\(docId\)\) saveMoves/,
    'the move record is still released, so nothing wedges at stage assigned');
  /* And the superseded invariant is marked as such, so it is not "restored" by someone reading the
   * old reasoning without the decision that replaced it. */
  assert.match(panel, /⚠ SUPERSEDED BY #70 — READ THIS BEFORE "RESTORING" THE OLD BEHAVIOUR/,
    'the old comment is explicitly superseded rather than deleted');
});
