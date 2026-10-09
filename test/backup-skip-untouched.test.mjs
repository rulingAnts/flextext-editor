/* NO AUTOMATIC BACKUP OF A DELIVERY NOBODY HAS TOUCHED (plans/move-upload-guards.md G4).
 *
 * WHY THIS TEST EXISTS: auto-backup uploaded assigned texts the coworker had never opened, and
 * placeholders still waiting for their transcription. Each became the NEWEST copy in the text's
 * folder — exactly what a move and a cleanup then picked, over the real work. An untranscribed
 * delivery holds nothing worth uploading.
 *
 * ⚠ THE OTHER HALF IS WHAT MUST STILL BACK UP: anything a person typed, cut by hand or translated;
 * a recorded (not assigned) text; a delivery from before this existed that holds work. And only the
 * AUTOMATIC sweep consults this — Send, Done, a researcher's request and every delete path are
 * explicit and unchanged.
 *
 * The real functions are LIFTED out of app.js and run over docs built by the real flextext.js.
 *
 * Run: node --test test/backup-skip-untouched.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { makeDoc, reconcileBaseline, getBaselineParagraphs, makeSegment } = await import('../docs/js/flextext.js');

const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const grab = (re, what) => { const m = app.match(re); assert.ok(m, `${what} is findable`); return m[0]; };
const src = [
  grab(/function docIsUncut\(doc\) \{[\s\S]*?\n\}/, 'docIsUncut'),
  grab(/function docHasNoText\(doc\) \{[\s\S]*?\n\}/, 'docHasNoText'),
  grab(/function docHasFree\(doc\) \{[\s\S]*?\n\}/, 'docHasFree'),
  grab(/function deliveredContentSig\(rec\) \{[\s\S]*?\n\}/, 'deliveredContentSig'),
  grab(/function backupSkipReason\(rec\) \{[\s\S]*?\n\}/, 'backupSkipReason'),
  grab(/function isAudioLocked\(rec\) \{[\s\S]*?\n\}/, 'isAudioLocked'),
  grab(/function cheapHash\(str\) \{[\s\S]*?\n\}/, 'cheapHash'),
].join('\n');
const { backupSkipReason, deliveredContentSig } = new Function('getBaselineParagraphs',
  `${src}\nreturn { backupSkipReason, deliveredContentSig };`)(getBaselineParagraphs);

const delivery = (lines, extra = {}) => {
  const doc = makeDoc({ vernLang: 'qaa', analLang: 'id' }, 'Cerita');
  if (lines) reconcileBaseline(doc, lines);
  const rec = { id: 'doc1', title: 'Cerita', doc, assigned: true, audioId: 'aud', audioLocked: true,
    audioSource: 'https://example.invalid/a', ...extra };
  rec.deliveredSig = deliveredContentSig(rec);        // what openUrlTask / tryDownloadFlextext stamp
  return rec;
};

test('an untouched placeholder waiting for its transcription is skipped — and says why', () => {
  const r = delivery(null, { pendingFlextext: 'https://example.invalid/t' });
  assert.equal(backupSkipReason(r), 'awaitingTranscript');
});

test('...but a placeholder someone TYPED into, or CUT by hand, backs up as today', () => {
  const typed = delivery(null, { pendingFlextext: 'u' });
  reconcileBaseline(typed.doc, ['saya mengetik']);
  assert.equal(backupSkipReason(typed), '', '⚠ not "waiting": work exists (finding 7 territory)');
  const cut = delivery(null, { pendingFlextext: 'u' });
  cut.doc.segments = [{ start: 0, end: 900 }, { start: 900, end: 2100 }];
  assert.equal(backupSkipReason(cut), '', 'two cuts made by a person are work');
});

test('a delivered transcription nobody changed is skipped; the first edit backs up', () => {
  const r = delivery(['satu dua', 'tiga empat']);
  assert.equal(backupSkipReason(r), 'asDelivered');
  r.doc.paragraphs[0].segments[0].words[0].gls = 'one';
  assert.equal(backupSkipReason(r), '', 'one gloss is a change');
  const f = delivery(['satu dua']);
  f.doc.paragraphs[0].segments[0].free = 'one two';
  assert.equal(backupSkipReason(f), '', 'a free translation is a change');
});

test('opening it in Audio Segmentation Mode is NOT a change: seed spans and a minted media guid', () => {
  const r = delivery(['satu', 'dua', 'tiga']);
  r.doc.segments = [{ start: 0, end: 1000, timeEstimated: true }, { start: 1000, end: 2000, timeEstimated: true },
                    { start: 2000, end: 3000, timeEstimated: true }];
  r.doc.mediaGuid = 'minted-on-serialize';
  assert.equal(backupSkipReason(r), 'asDelivered', 'estimated spans are seeds, not anybody\'s work');
  const one = delivery(['satu']);
  one.doc.segments = [{ start: 0, end: 5000 }];
  assert.equal(backupSkipReason(one), 'asDelivered', 'the whole-file seed of a single line');
});

test('what is NOT a delivery, or not untouched, backs up exactly as before', () => {
  const recorded = delivery([''], { assigned: false });
  assert.equal(backupSkipReason(recorded), '', 'a recorded (not assigned) empty text');
  const sent = delivery(['satu'], { uploadedFileId: 'F1' });
  assert.equal(backupSkipReason(sent), '', 'already uploaded from here: the ordinary signature rules apply');
  const ownAudio = delivery([''], { audioLocked: false, audioSource: 'local-blob' });
  assert.equal(backupSkipReason(ownAudio), '', 'a recording of its own still to send');
  const legacyWork = delivery(['satu dua']);
  delete legacyWork.deliveredSig;
  assert.equal(backupSkipReason(legacyWork), '', 'delivered before the stamp existed, holding text → backs up');
  const legacyEmpty = delivery(['']);
  delete legacyEmpty.deliveredSig;
  assert.equal(backupSkipReason(legacyEmpty), 'noWork', '...but holding nothing → the grandfathered placeholder gets its chip too');
});

test('the wiring: stamped at delivery, consulted ONLY by the automatic sweep, reported to the panel', () => {
  const open = grab(/async function openUrlTask\(task, mode = 'interactive'\) \{[\s\S]*?\n\}/, 'openUrlTask');
  const at = open.indexOf('if (rec.assigned) rec.deliveredSig = deliveredContentSig(rec);');
  assert.ok(at > open.indexOf('Object.assign(rec, docStats(rec.doc));') && at < open.indexOf('await db.putDoc(rec);', at - 200),
    'the new-record branch stamps after docStats and before the doc is stored');
  const pop = grab(/async function tryDownloadFlextext\(rec\) \{[\s\S]*?\n\}/, 'tryDownloadFlextext');
  assert.match(pop, /Object\.assign\(rec, docStats\(rec\.doc\)\);\s*\n\s*\/\/ G4[^\n]*\n\s*if \(rec\.assigned\) rec\.deliveredSig = deliveredContentSig\(rec\);\s*\n\s*await db\.putDoc\(rec\);/,
    'and the arrived transcription is re-stamped as the delivery');
  const sweep = grab(/async function autoBackupSweep\(\) \{[\s\S]*?\n\}/, 'autoBackupSweep');
  assert.ok(sweep.indexOf('backupSkipReason(d)') > 0 && sweep.indexOf('backupSkipReason(d)') < sweep.indexOf('uploadDocById('),
    'the automatic sweep consults it before queuing');
  for (const [name, re] of [
    ['doUpload', /async function doUpload\(researcher = false\) \{[\s\S]*?\n\}/],
    ['setDocDone', /async function setDocDone\([^)]*\) \{[\s\S]*?\n\}/],
    ['userDeleteDoc', /async function userDeleteDoc\(docId, title\) \{[\s\S]*?\n\}/],
  ]) assert.ok(!/backupSkipReason/.test(grab(re, name)), `${name} is explicit and does not consult it`);
  const disp = grab(/case 'uploadDelete': \{[\s\S]*?case 'triggerUpload': \{[\s\S]*?break;\n    \}/, 'the uploadDelete/triggerUpload cases');
  assert.ok(!/backupSkipReason/.test(disp), 'nor do the researcher\'s commands — upload-first deletion included');
  const inv = grab(/async function syncGatherInventory\(\) \{[\s\S]*?\n\}/, 'syncGatherInventory');
  assert.match(inv, /why === 'awaitingTranscript' \? \{ awaitingTranscript: true \}/);
  assert.match(inv, /\(why === 'asDelivered' \|\| why === 'noWork'\) \? \{ asDelivered: true \}/);
});
