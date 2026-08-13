/* THE FILES CONTROL IS A MODAL, AND A MOVE REQUIRES A MANIFEST.
 *
 * Two rules from Seth's v347 test drive, both of which look like polish and are not.
 *
 * 1. THE DROP-DOWN LOST ITS THIRD POSITIONING ARGUMENT AND WAS RETIRED.
 *    "Sometimes the Files menu is too long and goes off screen, and then if I scroll (which scrolls
 *     the texts list by default), it disappears and it won't come back again until I refresh the
 *     page."
 *    ⚠ The history matters, because "just make it a dropdown again, it's simpler" is a plausible
 *    future suggestion: absolute → clipped by the height-capped text lists; `fixed` → escapes the
 *    clipping but cannot follow its button, so it must close on scroll; close-on-scroll → the bug
 *    above. Eight rows of options cannot be anchored to a row in a scrolling list. A modal has no
 *    anchor to lose, and it has somewhere to put PROGRESS — which a drop-down never did.
 *
 * 2. A MOVE IS BUILT FROM THE MANIFEST, SO NO MANIFEST MEANS NO MOVE.
 *    "there needs to be a manifest and it needs to make clear which file is the most recent
 *     flextext file … and which is the original audio … Folders that do not have a manifest or
 *     whose manifest does not contain this info should not present a 'Move...' option."
 *    ⚠ The failure being prevented is NOT an error message — it is an assignment built from a
 *    guess. Without a manifest the panel would fall back to "newest file that looks like a
 *    flextext", which is exactly the inference the whole v3 manifest design replaced.
 *
 * Run: node test/files-modal-and-move-gate.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const panel = read('../docs/js/researcher-panel.js');
const css = read('../docs/css/app.css');
const i18n = read('../docs/js/i18n.js');

console.log('\nthe Files control opens a modal, and the drop-down machinery is gone');
{
  ok(/function openFilesModal\(rowWrap\)/.test(panel), 'openFilesModal exists');
  ok(/openFilesModal\(wrap\);/.test(panel), 'and the row button calls it');
  for (const gone of ['function placeDlMenu', 'function openDlMenu', 'function closeDlMenu']) {
    ok(!panel.includes(gone), `${gone} is gone`);
  }
  ok(!/openDl\b/.test(panel), 'and so is the open-menu singleton');
  /* The scroll/resize listeners existed ONLY to stop a fixed menu stranding mid-air. Leaving them
   * behind would be dead code that reads as load-bearing. */
  ok(!/addEventListener\('scroll'/.test(panel), 'the close-on-scroll listener is gone');
  ok(!/addEventListener\('mouseenter'/.test(panel),
     'and hover-to-open is gone — a modal that opened on hover would seize the screen mid-pointer-move');
}

console.log('\n...and the modal carries its own [data-fmenu], so every handler still resolves');
{
  const fn = (panel.match(/function openFilesModal\(rowWrap\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(/data-fmenu/.test(fn), 'the modal contains a [data-fmenu] wrapper');
  for (const d of ['data-i=', 'data-id=', 'data-title=', 'data-audio=', 'data-fileid=']) {
    ok(fn.includes(d), `...seeded with ${d} from the row`);
  }
  /* THE POINT: the delegated handlers find their context with closest('[data-fmenu]'). Because the
   * modal has its own wrapper carrying the same identity, data-conv / data-drivefile / data-zipall /
   * data-cleanup needed NO change. A modal without it would have broken all four silently. */
  ok(/populateFilesMenu\(wrap\)/.test(fn), 'and the list is populated into that wrapper');
  ok(/closest\('\[data-fmenu\]'\)/.test(panel), 'handlers still resolve context by [data-fmenu]');
}

console.log('\nthe modal has a status line, and the slow paths write to it');
{
  ok(/function dlStatus\(wrap, msg\)/.test(panel), 'there is a status writer');
  ok(/wrap\._status = m\.el\.querySelector\('\.rp-dlm-status'\)/.test(panel),
     'reached through the WRAP, not a module global that could outlive a close');
  ok(/\.rp-dlm-status/.test(css) && /\.rp-dlm-status\.is-on/.test(css),
     'and it is styled, taking space only once it says something');

  /* Seth: "it looks like it's trying to download (and taking a long time with no status update)
   * before the UI gets any response at all". Every path that streams bytes through the Worker before
   * handing the browser anything must speak first. */
  ok(/dlStatus\(wrap2, t\('panel\.dl\.fetching'/.test(panel), 'a single-file download says so immediately');
  ok(/deps\.toast\(t\('panel\.dl\.started'\), 4000\)/.test(panel), '...and toasts, for when the modal is not open');
  ok(/dlStatus\(wrapForStatus, t\('panel\.dl\.fetchingN'/.test(panel),
     'Download-all reports which file of how many — a count beats a spinner');
  ok(/paint = \(msg\) => \{ if \(sub\) sub\.textContent = msg; dlStatus\(wrap, msg\); \}/.test(panel),
     'and a conversion paints BOTH its row and the status line');
  /* The long silent stretch for a WAV: no decode means no percentage, so the fetch itself has to
   * announce. Without this an ELAN export of a 217 MB recording sits on "working…" and looks hung. */
  ok(/paint\(t\('panel\.dl\.fetching', \{ name: af\.name \|\| 'audio' \}\)\);/.test(panel),
     'the pre-conversion audio fetch announces itself');
  ok(/dlStatus\(wrap, ''\);/.test(panel), 'and the status clears rather than freezing mid-word');
}

console.log('\na move refuses without a manifest — BEFORE offering a destination');
{
  ok(/async function moveSources\(fromId, docId, title\)/.test(panel), 'the eligibility check exists');
  const fn = (panel.match(/async function moveSources\([\s\S]*?\n\}/) || [''])[0];
  ok(/Array\.isArray\(body\.files\)/.test(fn),
     'an unreadable or wrong-shaped body is NOT a manifest — same rule the Files list uses');
  ok(/ok: !!\(manifest && picks\.flextext && audio\)/.test(fn),
     'eligibility needs the manifest AND a current flextext AND an original recording');

  /* ⚠ ORDER IS THE FIX. The old code listed the folder only after the researcher had chosen a
   * device and pressed Move, then failed with nothingToMove — a refusal AFTER the commitment, which
   * reads as the app breaking rather than as the text being ineligible. */
  const mv = panel.slice(panel.indexOf('async function moveTextModal'));
  const gateAt = mv.indexOf('await moveSources(');
  const pickerAt = mv.indexOf('const m = modal(');
  ok(gateAt > 0 && pickerAt > gateAt, 'the check runs BEFORE the device picker is built');
  ok(/if \(!src\.ok\) \{[\s\S]{0,200}?deps\.toast\(t\(src\.manifest \? 'panel\.move\.manifestIncomplete' : 'panel\.move\.noManifest'\)/.test(mv),
     'and the two causes are named separately — a missing manifest is not an incomplete one');

  // The commit path must not re-derive what the gate already resolved.
  ok(/idOf\(src\.picks\.flextext\)/.test(mv) && /idOf\(src\.audio\)/.test(mv),
     'the assignment reuses the resolved sources rather than listing the folder a second time');
}

console.log('\n...and the Unassigned → device path is gated identically');
{
  const ad = panel.slice(panel.indexOf('async function adoptTextModal'));
  ok(/await moveSources\(insts\[0\]\.instance_id, docId, title\)/.test(ad.slice(0, 1400)),
     'adopt runs the same check');
  /* An unassigned text is the MOST likely to predate the manifest — it has been sitting in Drive
   * precisely because no device claimed it — so a gate on the device path alone would leave the gap
   * exactly where it is widest. */
  ok(/panel\.move\.noManifest/.test(ad.slice(0, 1400)), 'and refuses with the same explanation');
}

console.log('\nboth buttons show they are working while the folder is listed');
{
  ok(/await busy\(el, \(\) => moveTextModal\(id, el\.dataset\.id, el\.dataset\.title \|\| ''\)\)/.test(panel),
     'Move… goes through busy()');
  ok(/busy\(el, \(\) => adoptTextModal\(el\.dataset\.id, el\.dataset\.title \|\| ''\)\)/.test(panel),
     'and so does the Unassigned Move…');
}

console.log('\nevery new string is in BOTH languages');
{
  const block = (lang) => {
    const at = i18n.indexOf(`\n${lang}: {`);
    const rest = i18n.slice(at + 1);
    const nxt = rest.search(/\n[a-z]{2,3}: \{/);
    return nxt < 0 ? i18n.slice(at) : i18n.slice(at, at + 1 + nxt);
  };
  for (const k of ['panel.move.noManifest', 'panel.move.manifestIncomplete', 'panel.dl.started',
                   'panel.dl.fetching', 'panel.dl.fetchingN', 'panel.dl.saved']) {
    const re = new RegExp(`^  '${k.replace(/\./g, '\\.')}':`, 'm');
    ok(re.test(block('en')) && re.test(block('id')), `${k} is in en AND id`);
  }
  /* "Cannot" with no next step reads as a broken app. Seth's own instruction was that the
   * researcher "will have to download and re-upload those" — so the message must say that. */
  for (const k of ['panel.move.noManifest', 'panel.move.manifestIncomplete']) {
    const s = (i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '([^']*)'`)) || [])[1] || '';
    ok(/download/i.test(s) && /re-upload/i.test(s), `${k} names the remedy, not just the refusal`);
  }
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
