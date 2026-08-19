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
  ok(/t\('panel\.dl\.fetchingN', \{ i, n: wanted\.length/.test(panel),
     'Download-all reports which file of how many — a count beats a spinner');
  ok(/paint = \(msg\) => \{ if \(sub\) sub\.textContent = msg; dlStatus\(wrap, msg\); jobSet\(job, msg\); \}/.test(panel),
     'and a conversion paints its row, the status line AND the activity tray');
  /* The long silent stretch for a WAV: no decode means no percentage, so the fetch itself has to
   * announce. Without this an ELAN export of a 217 MB recording sits on "working…" and looks hung. */
  ok(/paint\(t\('panel\.dl\.fetching', \{ name: af\.name \|\| 'audio' \}\)\);/.test(panel),
     'the pre-conversion audio fetch announces itself');
  ok(/dlStatus\(wrap, ''\);/.test(panel), 'and the status clears rather than freezing mid-word');
}

console.log('\nthe activity tray reports work the browser cannot show');
{
  /* Seth: "they don't show up on the browser download menu, looks like, until they're finished."
   * That is exactly right and it is the whole design constraint: fetchDriveFile streams into a Blob
   * and only the COMPLETED Blob is handed to the browser, so for the entire slow part the browser's
   * download list is empty and the app is the only thing that can say the work exists. */
  ok(/function jobStart\(label, msg\)/.test(panel) && /function jobEnd\(id, finalMsg\)/.test(panel),
     'there is a job registry');
  ok(/document\.body\.appendChild\(el\)/.test((panel.match(/function jobsEl\(\)[\s\S]*?\n\}/) || [''])[0]),
     'the tray is BODY-level — it must survive closing the modal AND a dashboard re-render');
  ok(/\.rp-jobs \{[\s\S]{0,200}?position: fixed/.test(css), 'and is pinned to the viewport');

  // All three slow paths register, or the tray would be honest only sometimes.
  ok(/const job = jobStart\(fname, t\('panel\.dl\.starting'\)\)/.test(panel), 'a single-file download registers');
  ok(/const job = jobStart\(`\$\{wrap\.dataset\.title \|\| 'text'\} — \$\{kindLabel\}`/.test(panel),
     'a conversion registers, named for the text and the output');
  ok(/const job = jobStart\(`\$\{btn\.dataset\.title \|\| title\} — \$\{t\('panel\.dl\.all'\)\}`/.test(panel),
     'and so does Download-all');
  ok((panel.match(/jobEnd\(/g) || []).length >= 4, 'every one of them ends its job');

  /* ⚠ A job that vanished the instant it completed would leave the researcher unsure whether it
   * finished or was lost — the same doubt the tray exists to remove. */
  ok(/setTimeout\(\(\) => \{ jobs\.delete\(id\); paintJobs\(\); \}, finalMsg \? 5000 : 1200\)/.test(panel),
     'a finished job lingers briefly, then clears itself');
}

console.log('\n...and the progress is real bytes, with the denominator we already hold');
{
  const rp = read('../docs/js/researcher.js');
  ok(/export async function fetchDriveFile\(fileId, onProgress\)/.test(rp), 'the fetch can report progress');
  ok(/r\.body\.getReader\(\)/.test(rp), 'by streaming the body rather than awaiting .blob()');
  ok(/if \(typeof onProgress !== 'function' \|\| !r\.body/.test(rp),
     'and callers that do not want progress keep the old fast path untouched');
  /* ⚠ NO TOTAL comes back from the worker: v1Cors sets no Access-Control-Expose-Headers, so a
   * cross-origin reader cannot see content-length. Adding it would be a worker change and a deploy
   * for a number every call site ALREADY has from the Drive listing. Pin that the denominator comes
   * from the listing, so nobody "fixes" this by reading a header that is not readable. */
  ok(/const known = \(\(wrap\._allFiles \|\| \[\]\)\.find/.test(panel),
     'the percentage denominator comes from the folder listing, not from a response header');
  // Match a header READ, not the word — the comment explaining why it is unreadable says it too.
  ok(!/headers\.get\(['"]content-length/i.test(panel),
     'the panel never tries to read content-length cross-origin');
  ok(/pct == null \? t\('panel\.dl\.fetchingBytes'/.test(panel),
     'and an unknown size reports BYTES rather than inventing a percentage');
}

console.log('\n...and the tray label is built by CONCATENATION, so every key must exist');
{
  /* ⚠ The failure mode CLAUDE.md names explicitly: "a key built by concatenation renders its own
   * raw name when it is missing" — nothing throws, and it shows up in the SECOND language first,
   * because that is the side nobody reads while developing. The tray labels a job
   * `t('panel.dl.' + map[kind])`, so a kind added to that map without a matching string would put
   * "panel.dl.somekind" on screen. Expand the map here, exactly as test/device-setup does. */
  const map = (panel.match(/const kindLabel = t\('panel\.dl\.' \+ \(\{([\s\S]*?)\}\[kind\]/) || [])[1] || '';
  const keys = [...map.matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1]);
  ok(keys.length >= 6, `the map yields keys to check (${keys.join(', ')})`);
  for (const k of keys.concat('title')) {
    const re = new RegExp(`^  'panel\\.dl\\.${k}':`, 'gm');
    ok((i18n.match(re) || []).length === 2, `panel.dl.${k} exists in en AND id`);
  }
}

console.log('\na move refuses without a manifest — BEFORE offering a destination');
{
  ok(/async function moveSources\(fromId, docId, title\)/.test(panel), 'the eligibility check exists');
  const fn = (panel.match(/async function moveSources\([\s\S]*?\n\}/) || [''])[0];
  ok(/Array\.isArray\(body\.files\)/.test(fn),
     'an unreadable or wrong-shaped body is NOT a manifest — same rule the Files list uses');
  ok(/ok: !!\(manifest && audio && \(picks\.flextext \|\| !declaresFlextext\)\)/.test(fn),
     'eligibility needs the manifest AND an original recording — and a flextext only if one is declared');

  /* ⚠ ORDER IS THE FIX. The old code listed the folder only after the researcher had chosen a
   * device and pressed Move, then failed with nothingToMove — a refusal AFTER the commitment, which
   * reads as the app breaking rather than as the text being ineligible. */
  /* ⚠ BOUND THE SLICE TO THE FUNCTION. This read to END OF FILE, so every assertion below could be
   * satisfied by adoptTextModal further down — and after the Unassigned-target rewrite one of them
   * WAS: it asserted a `deps.toast` branch moveTextModal no longer has, and passed on adopt's copy.
   * A test that cannot fail is worse than no test, so the slice stops at the function's own close. */
  const mvAt = panel.indexOf('async function moveTextModal');
  const mv = panel.slice(mvAt, panel.indexOf('\n}\n', panel.indexOf('  });', mvAt)) + 3);
  ok(!/async function adoptTextModal/.test(mv), 'the slice really is moveTextModal alone');
  const gateAt = mv.indexOf('await moveSources(');
  const pickerAt = mv.indexOf('const m = modal(');
  ok(gateAt > 0 && pickerAt > gateAt, 'the check runs BEFORE the device picker is built');
  ok(/why = src\.manifest \? 'panel\.move\.manifestIncomplete' : 'panel\.move\.noManifest'/.test(mv),
     'and the two causes are named separately — a missing manifest is not an incomplete one');

  // The commit path must not re-derive what the gate already resolved.
  ok(/idOf\(src\.picks\.flextext\)/.test(mv) && /idOf\(src\.audio\)/.test(mv),
     'the assignment reuses the resolved sources rather than listing the folder a second time');

  /* ⚠ THE GATE MUST NOT REACH UNASSIGNED. A device destination is an ASSIGNMENT and needs source
   * material; Unassigned assigns nothing — from a crowd recorder it is a Drive re-parent, from a
   * device it is the upload-first removal. The old code returned early when the gate failed, so a
   * crowd recording (no `.flextext`, by definition) could reach no destination at all. */
  ok(!/return;\s*\n\s*\}\s*\n\s*const m = modal\(/.test(mv),
     'a failed device gate no longer returns before the picker is built');
  const unOpt = (mv.match(/opt\('__unassigned'[\s\S]{0,320}?\)\}/) || [''])[0];
  ok(unOpt && !/disabled/.test(unOpt.split('\n').slice(0, 3).join('\n')),
     'Unassigned is offered whatever the device gate decided');
  ok(/opt\('__unassigned'[\s\S]{0,300}?false, !deviceOk\)/.test(mv),
     '...and is pre-selected exactly when no device can receive the text');
  ok(/const deviceOk = !why;/.test(mv) && /!deviceOk \|\| !x\._canReceive/.test(mv),
     'the gate disables DEVICE options instead of closing the modal');
}

console.log('\nUnassigned is a real destination on a DEVICE move — and nothing is re-parented early');
{
  const mvAt = panel.indexOf('async function moveTextModal');
  const mv = panel.slice(mvAt, panel.indexOf('\n}\n', panel.indexOf('  });', mvAt)) + 3);

  ok(/Researcher\.uploadDelete\(fromId, docId\)/.test(mv),
     'it is the upload-first removal — a fresh Drive copy lands before the device drops its own');
  /* ⚠ The folder must NOT be filed here. The text is still on the device until the delete confirms,
   * and filing it early would put it in the assign queue while a device still holds it — the exact
   * state the sweep exists to resolve. */
  ok(!/driveUnassign/.test(mv), 'and the folder is left where it is — the sweep files it afterwards');
  ok(/opt\('__unassigned'[\s\S]{0,200}?false, !deviceOk\)/.test(mv),
     'Unassigned is never disabled, and is pre-selected exactly when no device can receive the text');
}

console.log('\n...and a text NO DEVICE HOLDS goes through the source-less flow, not /move');
{
  const adAt = panel.indexOf('async function adoptTextModal');
  const ad = panel.slice(adAt, panel.indexOf('\n}\n', panel.indexOf('  }));', adAt)) + 3);
  ok(!/async function moveTextModal/.test(ad), 'the slice really is adoptTextModal alone');

  /* ⚠ WHY NOT /move, and why this predates the crowd work: /move requires toId !== instanceId
   * because it is a transfer BETWEEN devices. Relaxing that to carry a source-less flow would make
   * one endpoint mean two things on a path field devices use — so /adopt exists instead, taking the
   * destination in the path and no source at all. A crowd recording needs exactly that shape. */
  // (drive-estate pins the worker half of this — that /move still refuses toId === instanceId.)
  ok(/Researcher\.adoptText\(to, docId/.test(ad), 'a device destination goes through /adopt');
  ok(/kind: 'assign'/.test(ad),
     '...with an ordinary assign marker — there is no source half, so a move record would be a removal waiting to fire at a device that never had the text');

  ok(/opts\.unassign \?/.test(ad) && /value="__unassigned"/.test(ad),
     'Unassigned is offered as a destination when the caller asks for it');
  ok(/Researcher\.driveUnassign\(\[docId\]\)/.test(ad),
     '...and filing is a re-parent of one id — drive-unassign already takes explicit ids, so the sweep is just a batched caller');

  /* ⚠ The gate governs DEVICE destinations only: filing assigns nothing. Returning early on a
   * failed gate — which this did — leaves a text that cannot be delivered with nowhere to go. */
  ok(/if \(why && !opts\.unassign\) \{ deps\.toast/.test(ad),
     'a failed gate still closes the modal when filing is not on offer');
  ok(/const deviceOk = !why;/.test(ad) && /\$\{!deviceOk \? ' disabled' : ''\}/.test(ad),
     '...but otherwise it only disables the device options');
  ok(/panel\.move\.noManifest/.test(ad), 'and the two causes are still named separately');

  ok(/data-uact="cmove"/.test(panel), 'the crowd row has a Move… button');
  ok(/adoptTextModal\(el\.dataset\.id, el\.dataset\.title \|\| '', \{ unassign: true \}\)/.test(panel),
     'wired to the same source-less flow, with Unassigned offered');
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
                   'panel.dl.fetching', 'panel.dl.fetchingN', 'panel.dl.saved', 'panel.jobs.title',
                   'panel.dl.starting', 'panel.dl.pct', 'panel.dl.fetchingPct',
                   'panel.dl.fetchingBytes', 'panel.dl.savedShort', 'panel.dl.failedShort']) {
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
