/* AFTER A SUCCESSFUL SEND, THE EDITOR RETURNS TO THE TEXTS LIST.
 *
 * Seth, 2026-08-13: "when the user clicks 'Done - and send' after it's done sending, navigation
 * returns them back to the main page (with the texts listed)."
 *
 * The workflow it completes: a transcriber finishes a text, sends it, and is ready for the next one.
 * Left on the text they just finished, the commonest way people "leave" it is to start editing it
 * again by accident.
 *
 * ⚠ TWO RULES CARRY REAL RISK, and both are asserted here rather than trusted to review:
 *
 * 1. THE ORDER. `persist()` deliberately SKIPS the full doc write while `#view-texts` is visible, so
 *    navigating before persisting silently DISCARDS the last edit. That is the same trap the Back
 *    button documents, and it is why this is one shared helper instead of three copies of the
 *    sequence — three copies is three chances to get the order wrong once.
 *
 * 2. ONLY ON SUCCESS. Navigating away from a send that did not happen hides the failure behind a
 *    screen change, and the user reads "I'm back at the list" as "it sent". An AbortError (the user
 *    dismissed the share sheet or the save picker) is not a send.
 *
 * ⚠ UPLOAD WAITS FOR THE BYTES TO LAND (Seth: "after finished uploading"), so it records a per-doc
 * INTENT and the single upload-completion point acts on it. The per-doc part is the safety property:
 * an upload can take minutes on a village connection, and in that time the transcriber may open
 * another text. Navigating THEN would yank them out of whatever they had started typing, triggered
 * by a network event they cannot see coming. So the completion point returns only if they are still
 * on the text they sent; otherwise the intent is dropped and the upload finishes quietly.
 *
 * Run: node test/return-after-send.test.mjs
 */
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

console.log('\nthe helper persists BEFORE it navigates');
{
  const fn = (app.match(/async function returnToLibraryAfterSend\(\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(fn.length > 80, 'returnToLibraryAfterSend exists');
  const iBase = fn.indexOf('applyBaseline');
  const iPersist = fn.indexOf('persist()');
  const iShow = fn.indexOf("show('texts')");
  ok(iBase > 0 && iPersist > iBase, 'the baseline textarea is committed first');
  /* ⚠ THE WHOLE SAFETY PROPERTY. persist() early-returns while the texts view is visible, so this
   * ordering is what makes the last edit survive. Reversing these two lines would look like tidying
   * and would silently lose work — exactly the failure the Back button's comment warns about. */
  ok(iPersist > 0 && iShow > iPersist, 'and persist() runs BEFORE show(\'texts\') — reversed, the last edit is lost');
  ok(/current = null;/.test(fn), 'the open doc is released');
  /* v369: the player stop moved into leaveEditor(), the cleanup shared with the Back button — which
   * also stops the three tab tickers this exit used to leak (60fps against the hidden editor). The
   * property asserted is unchanged: leaving stops the audio. */
  ok(/leaveEditor\(\);/.test(fn) && /player\.hide\(\)/.test((app.match(/function leaveEditor\(\) \{[\s\S]*?\n\}/) || [''])[0]),
     'and audio stops rather than playing on over the list (via the shared leaveEditor cleanup)');
  ok(/renderDocList\(\);/.test(fn), 'the list is rebuilt so the just-sent text shows its new state');
}

console.log('\n...and the guard that makes the ordering matter is still in persist()');
{
  /* If this early return were ever removed, the ordering above would stop being load-bearing and
   * someone would "simplify" it. Pin the reason, not just the effect. */
  const p = (app.match(/async function persist\(\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(/const textsView = \$\('#view-texts'\);\s*\n\s*if \(textsView && !textsView\.hidden\) return;/.test(p),
     'persist() still skips the doc write while the texts view is visible');
}

console.log('\nevery successful send route returns');
{
  const share = app.slice(app.indexOf("$('#share-share').onclick"), app.indexOf("$('#share-upload').onclick"));
  ok(/await navigator\.share\([\s\S]{0,120}?closeShareMenu\(\);\s*\n\s*await returnToLibraryAfterSend\(\);/.test(share),
     'the share sheet returns once navigator.share RESOLVES');
  /* AbortError = the user dismissed the sheet. That is not a send, and returning would tell them it
   * was. The return sits inside the try, after the await, so a throw skips it by construction. */
  ok(/catch \(e\) \{\s*\n\s*if \(e\.name !== 'AbortError'\)/.test(share),
     '...and a dismissal or failure lands in catch, which does NOT return');

  /* Upload records an INTENT rather than navigating; the completion point honours it. */
  ok(/returnAfterUploadOf = current \? current\.id : null; doUpload\(\);/.test(app),
     'upload records which doc should return when its bytes land');
  ok(/if \(returnAfterUploadOf === docId\) \{\s*\n\s*returnAfterUploadOf = null;\s*\n\s*if \(current && current\.id === docId\) returnToLibraryAfterSend\(\);/.test(app),
     '...and the completion point returns ONLY if the user is still on that text');
  /* ⚠ Both halves matter. Clearing the intent unconditionally stops it firing later against a
   * different text; the `current.id === docId` guard is what stops a slow upload yanking someone
   * who has moved on. Dropping either one turns a helpful return into an ambush. */
  ok(/returnAfterUploadOf = null;/.test(app), 'the intent is cleared whether or not it is honoured');
  ok(/let returnAfterUploadOf = null;/.test(app), 'and it starts empty — never a standing subscription');

  const saveBlock = app.slice(app.indexOf('const blindDownload'), app.indexOf("$('#share-cancel')"));
  ok(/toast\(t\('toast\.saved'\)\);\s*\n\s*await returnToLibraryAfterSend\(\);/.test(saveBlock),
     'save-as returns after the file is actually written');
  /* The blind download IS the save on Firefox/Safari, which have no showSaveFilePicker — treating it
   * as a lesser path would mean the feature silently did not exist for a large share of users. */
  ok(/a\.click\(\);[\s\S]{0,160}?closeShareMenu\(\);\s*\n\s*returnToLibraryAfterSend\(\);/.test(saveBlock),
     'and so does the blind-download fallback, which is the save path on Firefox/Safari');
  ok(/if \(e\.name === 'AbortError'\) return;/.test(saveBlock),
     'a cancelled save picker returns early and never navigates');
}

console.log('\n...and Cancel does not');
{
  ok(/\$\('#share-cancel'\)\.onclick = closeShareMenu;/.test(app),
     'Cancel just closes the menu — no send happened, so no navigation');
}

console.log('\nthe completion-not-handoff choice is documented where it lives');
{
  const at = app.indexOf('UPLOAD RETURNS WHEN THE UPLOAD ACTUALLY FINISHES');
  ok(at > 0, 'the reason is written down at the decision');
  const why = app.slice(at, at + 800);
  ok(/minutes/.test(why), '...naming the slow-connection case the guard exists for');
  ok(/moved on/.test(why), '...and what happens when the user has moved on');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
