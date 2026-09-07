/* BRINGING TEXTS INTO A SATELLITE — the thing without which neither new app can be used at all.
 *
 * ⚠ THE BUG THIS EXISTS TO PREVENT IS A DEVELOPMENT ILLUSION, not a coding mistake. On localhost
 * every app in this suite is served from one port, so they share one IndexedDB and the recorder's
 * texts simply appear in the Consent Collector — which is exactly what you see while building it,
 * and it is not true of the shipped apps. consent.flextext.app and audio-segmenter.flextext.app are
 * separate ORIGINS from the editor and the recorder; they share nothing. The engine's only
 * cross-origin path is the researcher assignment channel, and that needs a pair code.
 *
 * So an unpaired colleague who installs either app sees an empty list and has no way to fill it,
 * for ever — while the developer's machine shows a full one. These checks pin the import that
 * closes that gap, and the empty-state wording that used to promise the illusion.
 *
 * Run: node test/satellite-import.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const app = read('docs/js/app.js');
const i18n = read('docs/js/i18n.js');
const css = read('docs/css/app.css');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const asyncFn = (src, name) => {
  const m = src.match(new RegExp(`\\nasync function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  return m ? m[0] : '';
};
const fn = (src, name) => {
  const m = src.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  return m ? m[0] : '';
};
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

console.log('\nboth satellites have the control, and it is the SAME importer');
const imp = asyncFn(app, 'satImportFiles');
ok(!!imp, 'satImportFiles exists');
const bar = fn(app, 'satImportBar');
ok(!!bar, 'satImportBar exists');
ok(/satImportBar\(view\)/.test(fn(app, 'renderSegmenterView')), 'the segmenter renders it');
ok(/satImportBar\(view\)/.test(fn(app, 'renderConsentView')), 'the collector renders it');
ok(/SEGMENTER_MODE \? 'sat\.openPair' : CONSENT_MODE \? 'sat\.openAny' : 'sat\.open'/.test(bar),
   'one bar, three labels — the segmenter asks for the recording too (it cannot work without one); the collector takes either or both');
ok(/input\.multiple = true/.test(bar), 'multiple files at once: a corpus folder is many pairs, not one');
// The editor's importFile ends in openDoc() + renderDocList(), neither of which exists in a satellite.
ok(!/openDoc\(|renderDocList\(/.test(code(imp)),
   'it does NOT reuse importFile\'s tail — openDoc enters an editor these apps do not have');
ok(/refreshList\(\)/.test(imp), 'and it refreshes whichever list is showing');

console.log('\na matching filename HELPS but is not required (Seth) — and namesakes are claimed first');
// "we can trust the user to be intelligent enough to notice it's not matching". Requiring it meant
// a recorder writing REC0042.wav beside StoryOfTheFlood.flextext produced a text with no audio.
ok(/satBase\(a\.name\) === satBase\(e\.file\.name\)/.test(imp), 'a namesake recording is still preferred');
ok(/const spare = audioFiles\.filter/.test(imp) && /spare\.shift\(\)/.test(imp),
   'and whatever is left over is paired in the order it was picked, rather than refused');
/* ⚠ THE TWO PASSES ARE THE POINT. One greedy pass over [A.flextext, B.flextext, B.wav] hands B.wav
 * to A and leaves B silent — the two files whose names DO agree ending up apart, which is exactly
 * what naming was supposed to prevent. */
const claimIdx = imp.indexOf('const claimed');
ok(claimIdx > 0 && imp.indexOf('const spare =') > claimIdx,
   'namesakes are claimed BEFORE leftovers are handed out, so an unnamed text cannot eat a named one\'s audio');
ok(/const single = \(e\) => e\.texts\.length === 1/.test(imp),
   'a .flextext holding SEVERAL texts still gets no audio: no naming rule can say which one it belongs to');
ok(/ambiguous/.test(imp) && /sat\.audioAmbiguous/.test(imp), 'and that refusal is reported, with the remedy');
ok(/orphans/.test(imp) && /sat\.audioUnmatched/.test(imp),
   'a recording with no text left to go with is named in the message, not silently dropped');
ok(!/same name as its text/.test(i18n), 'and the message no longer tells the user to rename their files');
ok(/if \(!textFiles\.length && !audioAlone\)/.test(imp) && /sat\.needText/.test(imp),
   'audio with no text is refused in the SEGMENTER, which has nothing to match it against');
ok(/failed\.push/.test(imp) && /toast\(t\('toast\.importFailed'/.test(imp), 'a file that will not parse says so, per file');
// Parsing before pairing is what makes `single` knowable at pairing time.
ok(imp.indexOf('const parsed = []') < claimIdx, 'every file is parsed before anything is paired');

console.log('\nan imported recording is stored the way an attached one is');
ok(/db\.putMedia\(rec\.id/.test(imp), 'the blob goes in the media store under the doc id');
ok(/rec\.audioSource = 'local:'/.test(imp), 'audioSource records where it came from');
ok(/rec\.audioLocked = false/.test(imp), 'and the user may remove it — they brought it themselves');
ok(/ensureMediaRef\(rec, e\.mate\.name/.test(imp), 'the doc references the media, so an export still points at it');
ok(/Object\.assign\(rec, docStats\(doc\)\)/.test(imp), 'segCount/glossed come from docStats, like every other writer');

console.log('\nthe collector takes a recording on its own — permission attaches to audio too (Seth, 2026-09-03)');
{
  ok(/const audioAlone = CONSENT_MODE;/.test(imp), 'audio alone is a consent-collector rule, not a satellite-wide one');
  ok(/if \(claimed\.has\(a\)\) continue;[\s\S]*?makeDoc\(settings, a\.name\.replace\(\/\\\.\[\^\.\]\+\$\/, ''\)\)/.test(imp),
     'each recording nothing claimed becomes its own text, titled from the filename');
  ok(/ensureMediaRef\(rec, a\.name, ''\)/.test(imp) && /rec\.audioLocked = false;[\s\S]*?claimed\.add\(a\);/.test(imp),
     'stored the way a paired recording is (media ref, unlocked), and then counted as claimed');
  ok(/recordings === 1 \? 'sat\.importedOneRecording' : 'sat\.importedManyRecordings'/.test(imp),
     'and said, at one and at many');
  ok(/if \(ambiguous && !audioAlone\)/.test(imp), '"left off" is not said where the recording stands on its own anyway');
  for (const k of ['sat.openAny', 'sat.importedOneRecording', 'sat.importedManyRecordings', 'panel.rel.new.consentAudio']) {
    ok((i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}': `, 'g')) || []).length === 2, `${k} in both languages`);
  }
  ok(/'cc\.empty': 'No texts on this device yet\. Open a \.flextext file, a recording, or both/.test(i18n),
     'and the empty state no longer says .flextext only');
}

console.log('\nthe messages are grammatical at EVERY count (t() has no plural machinery)');
for (const k of ['sat.importedOne', 'sat.importedOneAudio', 'sat.importedMany', 'sat.importedManyAudio',
                 'sat.importedOneRecording', 'sat.importedManyRecordings']) {
  ok(i18n.includes(`'${k}'`), `${k} exists`);
}
ok(/added === 1[\s\S]{0,120}sat\.importedOne/.test(imp), 'the single case gets its own sentence');
ok(!/text\(s\)|\(s\)/.test(i18n.match(/'sat\.imported[^\n]*/g)?.join('\n') || ''), 'no "text(s)" anywhere');
// The tallies had the same defect: "1 of 1 still need permission".
const en = i18n.slice(0, i18n.indexOf("'cc.hint'", i18n.indexOf("'cc.hint'") + 10));
ok(/'cc\.tallyNeed': 'still to ask: \{n\} of \{total\}'/.test(en), 'cc.tallyNeed reads correctly at 1');
ok(/'cc\.tallyDone': 'all have permission \(\{total\}\)'/.test(en), 'and so does cc.tallyDone');
ok(/'mg\.moreAudio': 'Audio: \{a\} \\u00b7 Text: \{t\}/.test(en) && /'mg\.moreText': 'Audio: \{a\} \\u00b7 Text: \{t\}/.test(en),
   'and the matcher status, which now names both counts');

console.log('\nrow controls: delete a text, swap its recording — on by default when unpaired');
const swap = asyncFn(app, 'satReplaceAudio');
const rowc = fn(app, 'satRowControls');
ok(/function allowAudioSwapOn\(\) \{ return !Sync\.hasSession\(\) \|\| settings\.allowAudioSwap === true; \}/.test(app),
   'allowAudioSwap mirrors allowDeleteOn exactly — researcher-settable, ON with no researcher session');
ok(/allowDeleteOn\(\)/.test(rowc) && /allowAudioSwapOn\(\)/.test(rowc), 'each control is behind its own permission');
ok(/userDeleteDoc\(d\.id, d\.title\)/.test(rowc),
   'delete goes through the EXISTING userDeleteDoc — its confirm, its upload-first case, its queued-upload cancel');
ok(/isAudioLocked\(rec\)/.test(swap) && /sat\.audioLocked/.test(swap),
   'swapping refuses a recording that came from a researcher task link');
/* ⚠ Replacing the audio MUST clear the alignment: every span is a pair of times into the OLD
 * recording, and against a different file they are not approximately right, they are meaningless. */
ok(/fresh\.doc\.segments = \[\]/.test(swap), 'and it clears the cuts, which are times into the old recording');
ok(/sat\.replaceLosesCuts/.test(swap) && /confirmDialog/.test(swap), 'saying so BEFORE doing it, with the count');
ok(/deleteMedia\('segwav:' \+ id\)/.test(swap),
   'the derived WAV working copy goes too — it is a conversion of the OLD file and would keep being preferred');
ok(/player\.loadedFor === id/.test(swap), 'and the player drops the recording it was holding');

console.log('\none list refresh that knows every mode');
const rl = fn(app, 'refreshList');
for (const m of ['CONSENT_MODE', 'SEGMENTER_MODE', 'RECORD_MODE']) ok(rl.includes(m), `refreshList knows ${m}`);
ok(!/if \(RECORD_MODE\) renderRecordList\(\); else renderDocList\(\);/.test(app),
   'and the eight hand-written copies are gone — each was a crash waiting in the satellites, where #doc-list does not exist');

console.log('\nthe empty state no longer promises the localhost illusion');
const emptyEn = (i18n.match(/'(cc|sg)\.empty': '([^']*)'/g) || []).join(' | ');
ok(!/from the Recorder or the Editor/.test(emptyEn),
   'it does not say texts can be brought in from the Recorder or the Editor — a different origin, so they cannot');
ok(/button above/.test(emptyEn), 'it points at the button that is actually on the screen');
ok(/\.sat-tools\{/.test(css), 'and the bar has a rule, above the list where an empty screen puts it first');

console.log('\nan unpaired device can get a text OUT — the first real text had no way');
{
  /* Seth, 2026-09-03, 149 cuts in on the feature preview: "I'm ready to export, but it's not
   * giving me the option. I don't have either unpaired settings, a download/save option, or an
   * upload to Google Drive option." The only exit was the upload pump, which needs a pairing. */
  const ctl = fn(app, 'satRowControls');
  ok(/sat-export/.test(ctl) && /satExport\(d\.id\)/.test(ctl), 'the row carries a download control');
  ok(/if \(SEGMENTER_MODE \|\| CONSENT_MODE\)/.test(ctl), 'in both satellites');
  const ex = asyncFn(app, 'satExport');
  ok(/const wants = \{ eaf: kind === 'all' \|\| kind === 'eaf', saymore: false, preview: false, fxpa: kind === 'fxpa' \};/.test(ex)
     && /buildBundleFor\(rec, true, \{ full: true, wants \}\)/.test(ex),
     'built by the SAME bundle a paired device uploads, and only the outputs actually chosen (v609 added .fxpa)');
  /* "allocation size overflow" (Firefox, a six-minute WAV): the listening page and the .fxpa each
   * hold the recording as base64, several copies of a ~100 MB string alive at once. */
  ok(/const caps = media \? conversionCaps\(/.test(asyncFn(app, 'buildBundleFor')) && /trimmed\.push\('preview'\)/.test(asyncFn(app, 'buildBundleFor')),
     'and buildBundleFor itself gates those outputs on conversionCaps, so the editor\'s Share cannot overflow either');
  ok(/share\.trimmedBig/.test(asyncFn(app, 'openShareMenu')), 'which the editor SAYS when it happens');
  // Seth: "we do want direct ELAN export from the audio segmenter."
  ok(/const kind = await satExportChoice\(\)/.test(ex), 'the user chooses what to keep of it');
  ok(/kind === 'flextext'/.test(ex) && /kind === 'eaf'/.test(ex) && /\\\.eaf\$/.test(ex),
     'everything, the .eaf alone, or the .flextext alone');
  ok(/sat\.exportNoEaf/.test(ex), 'and an unmatched text says why there is no .eaf rather than downloading nothing');
  for (const k of ['sat.exportTitle', 'sat.exportAll', 'sat.exportEaf', 'sat.exportFlextext', 'sat.exportNoEaf', 'share.trimmedBig']) {
    ok((i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}': `, 'g')) || []).length === 2, `${k} in both languages`);
  }
  ok(/if \(rec\.matchDraft\) toast\(t\('sat\.exportDraft'\)/.test(ex), 'and it says when unfinished matching is not in it');
  ok(/if \(!bundle\.zipped\) toast\(t\('sat\.exportNoAudio'\)/.test(ex), 'and when there was no recording to include');
  for (const k of ['sat.export', 'sat.exporting', 'sat.exportDraft', 'sat.exportNoAudio', 'sat.exportFailed']) {
    ok((i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}': `, 'g')) || []).length === 2, `${k} in both languages`);
  }
}

console.log('\nan arriving recording says how far, how long, and whether it is stuck (Seth, 2026-09-04)');
{
  /* "Downloading assignments say 'Loading the recording… the lines appear once it is ready.' but
   * not status/progress bar. I have no way of knowing how long until it's done. Or if it's
   * hung/stuck." The editor's list had a bar; the segmenter's row had a sentence. Now both share
   * one painter, and it answers all three. */
  const list = asyncFn(app, 'sgRenderList');
  ok(/if \(st === 'coming'\) \{[\s\S]*?li\.dataset\.arriving = d\.id;[\s\S]*?doc-dl-fill/.test(list),
     'a "coming" row is marked data-arriving and carries the editor\'s own bar');
  ok(/\$\$\('li\[data-arriving\]'\)/.test(fn(app, 'syncArrivalTicker')), 'the ticker scans every list, not only #doc-list');
  // The estimator is arithmetic; run it.
  const src = app.match(/\nfunction arrivalEstimate\([\s\S]*?\n\}/)[0];
  const est = new Function('ARRIVAL_WINDOW_MS', 'STALL_AFTER_MS', src + '; return arrivalEstimate;')(12000, 20000);
  const moving = [{ t: 0, received: 0 }, { t: 5000, received: 5e6 }, { t: 10000, received: 10e6 }];
  const m = est(moving, 10000, 10e6, 40e6, 'downloading');
  ok(Math.round(m.rate) === 1e6 && m.etaSec === 30 && m.stalledSec === 0, `10 MB in 10 s at 40 MB → 1 MB/s, 30 s left, not stalled (got ${JSON.stringify(m)})`);
  const stuck = [{ t: 0, received: 3e6 }, { t: 10000, received: 3e6 }, { t: 25000, received: 3e6 }];
  const s = est(stuck, 25000, 3e6, 40e6, 'downloading');
  ok(s.stalledSec >= 25 && s.etaSec === null, `no byte for 25 s while "downloading" → stalled, no ETA (got ${JSON.stringify(s)})`);
  const paused = est(stuck, 25000, 3e6, 40e6, 'paused');
  ok(paused.stalledSec === 0, 'a PAUSED download is not "stalled" — the user stopped it');
  const painter = fn(app, 'paintArrivalRow');
  for (const k of ['dl.paused', 'dl.failed', 'dl.waiting', 'dl.stalled', 'dl.progress', 'dl.progressBytes']) ok(painter.includes(`t('${k}'`), `the row says ${k}`);
  const ctl = fn(app, 'arrivalControls');
  ok(/if \(want === 'pause' && d\) d\.pause\(\);/.test(ctl) && /else if \(want === 'retry' && d\) \{ d\.pause\(\); d\.resume\(\); \}/.test(ctl),
     'Pause pauses; Retry on a stall is pause-then-resume, so the bytes already saved are kept (Range-resume)');
  ok(/tryDownloadAudio\(rec\)/.test(ctl), 'and with no download object at all, Retry starts one');
  for (const k of ['dl.progress', 'dl.etaS', 'dl.etaM', 'dl.etaH', 'dl.stalled', 'dl.paused', 'dl.waiting', 'dl.failed', 'dl.pause', 'dl.resume', 'dl.retry']) {
    ok((i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}': `, 'g')) || []).length === 2, `${k} in both languages`);
  }
}

console.log('\na withdrawn link is said, not retried (the 410 that looked like "keeps failing to load")');
{
  /* The worker answered 410 {"error":"gone"} for an assignment's text-file token; the downloader
   * treated it like a dropped connection and retried with backoff — 26 identical failures — and
   * the row said "Could not download — Retry", which could never work. */
  const audio = read('docs/js/audio.js');
  ok(/if \(\[401, 403, 404, 410\]\.includes\(resp\.status\)\) \{\s*\n\s*e\.fatal = true;/.test(audio), 'a refusal is fatal at once — no retries');
  ok(/if \(b && b\.error\) e\.message = String\(b\.error\);/.test(audio), 'carrying the worker\'s own word ("gone")');
  ok(/if \(e === 'gone'\) return t\('player\.gone'\);/.test(fn(app, 'audioErrorText')), 'which the app turns into a sentence naming who can fix it');
  ok(/audioError: audioError \|\| ''/.test(read('docs/js/db.js')), 'the list projection carries the remembered verdict');
  ok(/if \(d\.audioError\) li\.dataset\.audioError = d\.audioError;/.test(asyncFn(app, 'sgRenderList')), 'so after a reload the row still knows');
  const painter = fn(app, 'paintArrivalRow');
  ok(/const status = dl \? dl\.status : \(remembered \? 'error' : 'waiting'\);/.test(painter), 'and shows it instead of "waiting for a connection"');
  ok(/errorMessage === 'gone' \? t\('player\.gone'\) : t\('dl\.failed'\)/.test(painter), 'gone reads as gone');
  ok(/\(status === 'error' && errorMessage === 'gone'\) \? 'none'/.test(fn(app, 'arrivalControls')), 'with no Retry — only the researcher can mint a new link');
  ok((i18n.match(/'player\.gone': /g) || []).length === 2, 'player.gone in both languages');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nall ok\n');
process.exit(fail ? 1 : 0);
