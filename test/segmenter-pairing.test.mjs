/* THE AUDIO SEGMENTER IS A THIRD KIND OF INVITE — AND IT COSTS THE BACKEND NOTHING.
 *
 * Seth, 2026-09-04: "Can we actually turn 'audio segmenter' app into a third kind of invite link
 * for devices and integrate it into our device/project/assignment system?"
 *
 * What the map of the system showed: the only persisted kind is instance.type, CHECK-constrained
 * to ('editor','recorder','') — and every device the panel creates is ''. The invite row carries
 * no kind; the link's "kind" is nothing but the base URL the panel pastes the secret onto. The
 * device-side kind check (sync.js) fires only against a LEGACY typed instance. And the segmenter
 * already pairs, polls, receives `assign` and uploads, because all of that boots before the mode
 * fork. So a third kind is: a third base URL in the panel, an app that reports itself honestly,
 * the recorder's paste box, and Done queuing the upload. No worker route, shape, schema or origin
 * changes, and no worker deploy.
 *
 * Static checks over the sources (the pairing itself needs the worker; see plans/RELEASE-SMOKE-TEST.md).
 * Run: node test/segmenter-pairing.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const app = read('docs/js/app.js');
const panel = read('docs/js/researcher-panel.js');
const i18n = read('docs/js/i18n.js');
const dbjs = read('docs/js/db.js');
const worker = read('worker/src/v1.js');
const schema = read('worker/schema-current.sql');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const fn = (src, name) => (src.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)) || [''])[0];
const asyncFn = (src, name) => (src.match(new RegExp(`\\nasync function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)) || [''])[0];
const both = (k) => (i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}': `, 'g')) || []).length === 2;

console.log('\nthe worker is UNTOUCHED — the kind lives nowhere it would have to');
ok(/type\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*type\s+IN\s*\(\s*'editor'\s*,\s*'recorder'\s*,\s*''\s*\)\s*\)/.test(schema),
   'instance.type is still the CHECK-constrained column with the empty default…');
ok(!/segmenter/.test(worker), '…and the worker source does not know the word "segmenter" at all');
ok(/audio-segmenter\.flextext\.app/.test(read('worker/wrangler.toml')), 'its origin was already allowed (d04a234)');

console.log('\nthe engine reports itself honestly');
ok(/appType: \(\) => RECORD_MODE \? 'recorder' : CONSENT_MODE \? 'consent' : SEGMENTER_MODE \? 'segmenter' : 'editor'/.test(app),
   'Sync.appType says segmenter in the segmenter');
ok(/return \{ type: RECORD_MODE \? 'recorder' : CONSENT_MODE \? 'consent' : SEGMENTER_MODE \? 'segmenter' : 'editor', items, settings: snap,/.test(app),
   'and so does the inventory, which is what the panel\'s badge shows');
ok(/'editor' \| 'recorder' \| 'segmenter' \| 'consent'/.test(read('docs/js/sync.js')), 'the Sync contract names all four');
ok(both('toast.linkMismatch') && /'toast\.linkMismatch': 'That invite is for a different app\.'/.test(i18n),
   'the mismatch toast no longer says "the other app" — there are more than two');

console.log('\na second door for the link: the recorder\'s paste box, in the segmenter too');
{
  const view = fn(app, 'renderSegmenterView');
  ok(/\$\{!Sync\.hasSession\(\) \? '<button id="btn-paste-invite"/.test(view), 'renderSegmenterView paints #btn-paste-invite while unpaired');
  ok(/pi\.addEventListener\('click', showInvitePasteModal\)/.test(view), 'wired to the shared paste modal');
  ok(/if \(SEGMENTER_MODE\) renderSegmenterView\(\);/.test(app), 'and a successful paste repaints the list without the button');
  ok(/satImportBar\(view\)/.test(view), '(the unpaired import stays — two doors to the same app)');
}

console.log('\nDone on a paired device SENDS, like the recorder\'s Send');
{
  const commit = asyncFn(app, 'mgCommit');
  ok(/if \(Sync\.workerUploadTarget && Sync\.workerUploadTarget\(\)\) \{/.test(commit), 'only when a researcher\'s upload target exists');
  ok(/rec\.done = true; rec\.doneAt = Date\.now\(\);/.test(commit), 'it marks the text done (the panel\'s Done, auto-delete eligibility)');
  ok(/await uploadDocById\(rec\.id\); if \(Sync\.reportNow\) Sync\.reportNow\(\);/.test(commit), 'queues the bare .flextext and reports at once');
  ok(/if \(isAudioLocked\(rec\)\) return false;/.test(asyncFn(app, 'queueMediaUpload') || app), 'the researcher\'s own audio never goes back up');
  ok(/current = null;/.test(fn(app, 'mgClose')), 'and mgClose drops `current`, so an update flush cannot re-queue an unchanged text');
}

console.log('\nthe satellite-safe branches — three places the editor\'s DOM was assumed');
ok(/else if \(CONSENT_MODE \|\| SEGMENTER_MODE\) \{ applyResearchVisibility\(\); fillDeviceSetup\(\); refreshList\(\); \}/.test(fn(app, 'applyLiveSettings')),
   'a pushed setting repaints the satellite list (and its Settings tab) instead of throwing on #doc-list');
ok(/if \(!RECORD_MODE && !CONSENT_MODE && !SEGMENTER_MODE\) show\('texts'\);/.test(fn(app, 'deleteUploadedDoc')),
   'a researcher-side delete of the open text does not show a view the shell lacks');
ok(/refreshList\(\);   \/\/ whichever list this app has/.test(app), 'setDocDone repaints whichever list this app has');

console.log('\nthe list says where a text stands with the researcher');
ok(/assigned, audioLocked, uploadedFileId, uploadedModified, audioError \} = cur\.value;/.test(dbjs), 'the projection carries the five fields it needs (audioError joined for the arrival row)');
ok(/const sent = d\.uploadedFileId && d\.uploadedModified === d\.modified;/.test(asyncFn(app, 'sgRenderList')),
   '"sent" by the inventory\'s own rule: nothing changed since the upload that landed');
ok(both('sg.sent') && both('sg.fromResearcher'), 'in both languages');

console.log('\nthe panel prints the third link');
ok(/segmenter: Researcher\.inviteUrl\(B\.segmenter, invite\)/.test(panel), 'urls.segmenter');
ok(/\$\{row\(t\('panel\.invite\.recorderLink'\), 'recorder'\)\}\s*\n\s*\$\{row\(t\('panel\.invite\.segmenterLink'\), 'segmenter'\)\}/.test(panel),
   'a third row, after the recorder\'s (artifact-links pins the warning\'s distance from the FIRST row)');
ok(/segmenter: o \+ '\/audio-segmenter\/', consent: o \+ '\/consent-collector\/'/.test(fn(panel, 'sameOriginBases')),
   'the same-origin override knows the two new apps, so ⌃⌥E cannot print undefined');
for (const k of ['panel.invite.segmenterLink', 'panel.invite.introUnified', 'panel.new.unifiedNote']) ok(both(k), `${k} in both languages`);
ok(/segmenter link pairs the phone as a device of its own/.test(i18n), 'and the intro says the segmenter is its OWN device');

console.log(fail ? `\n${fail} FAILED\n` : '\nall ok\n');
process.exit(fail ? 1 : 0);
