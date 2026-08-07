/* Who is allowed to DELETE a recording.
 *
 * Seth, 2026-08-07: "the other thing we don't want is the 'delete audio' button on paired devices.
 * On unpaired devices it SHOULD be there."
 *
 * On a managed device the recording belongs to the project, not the handset. It may be the only
 * copy of a session that cannot be re-recorded, and the coworker holding the phone is not the
 * person who gets to decide it is expendable. An unpaired device keeps the button — it is the
 * user's own app and their own file.
 *
 * ⚠ WHY THIS IS A SEPARATE PREDICATE, AND WHY THAT MATTERS MORE THAN IT LOOKS. The obvious
 * implementation is to add `Sync.hasSession()` to isAudioLocked(). That function also decides
 * `userAudio` in buildBundleFor — whether the recording rides the upload/save bundle at all. So the
 * obvious version would stop PAIRED DEVICES UPLOADING THEIR OWN AUDIO, silently, which is the
 * entire purpose of pairing. The bug would present as "the researcher's Drive has the text but
 * never the recording", far from the button that caused it.
 *
 * Run: node test/audio-remove-gate.test.mjs
 */
import { readFileSync } from 'node:fs';
const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

console.log('\nthe gate exists and reads the pairing state');
const fn = app.match(/function canRemoveAudio\(rec\) \{[\s\S]*?\n\}/);
ok(!!fn, 'canRemoveAudio is defined');
const body = fn ? fn[0] : '';
ok(/!Sync\.hasSession\(\)/.test(body), 'a PAIRED device may not remove the audio');
ok(/!isAudioLocked\(rec\)/.test(body), 'and the existing lock (researcher-assigned URL audio) still applies');
ok(/!!rec &&/.test(body), 'and a missing record is not removable rather than a crash');

console.log('\nBOTH the button and the action are gated — hiding alone is not a gate');
ok(/p\.el\.remove\.hidden = !canRemoveAudio\(current\);/.test(app), 'the button is hidden when it may not act');
ok(/if \(!canRemoveAudio\(current\)\) return;/.test(app), 'and onRemove refuses independently');
ok(!/if \(!current \|\| isAudioLocked\(current\)\) return;/.test(app), 'the old lock-only guard is gone');

console.log('\n⚠ AND THE BUNDLE IS UNTOUCHED — a paired device must still UPLOAD its recording');
ok(/const userAudio = !!\(media && !isAudioLocked\(rec\)\);/.test(app),
   'buildBundleFor still asks isAudioLocked, NOT canRemoveAudio');
const locked = app.match(/function isAudioLocked\(rec\) \{[\s\S]*?\n\}/);
ok(!!locked && !/hasSession/.test(locked[0]),
   'and isAudioLocked knows nothing about pairing — folding it in would stop paired uploads carrying audio');

console.log('\nit matches how the other destructive controls are already gated');
ok(/function allowDeleteOn\(\) \{ return !Sync\.hasSession\(\)/.test(app), 'allowDeleteOn short-circuits on hasSession');
ok(/deleteAllAllowed/.test(app), 'and deleteAllAllowed exists on the same principle');

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASSED\n');
process.exit(fail ? 1 : 0);
