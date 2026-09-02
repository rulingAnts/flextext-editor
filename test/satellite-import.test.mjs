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
ok(/SEGMENTER_MODE \? 'sat\.openPair' : 'sat\.open'/.test(bar),
   'one bar, two labels — the segmenter asks for the recording too, because it cannot work without one');
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
ok(/if \(!textFiles\.length\)/.test(imp) && /sat\.needText/.test(imp), 'audio with no text at all is refused outright');
ok(/failed\.push/.test(imp) && /toast\(t\('toast\.importFailed'/.test(imp), 'a file that will not parse says so, per file');
// Parsing before pairing is what makes `single` knowable at pairing time.
ok(imp.indexOf('const parsed = []') < claimIdx, 'every file is parsed before anything is paired');

console.log('\nan imported recording is stored the way an attached one is');
ok(/db\.putMedia\(rec\.id/.test(imp), 'the blob goes in the media store under the doc id');
ok(/rec\.audioSource = 'local:'/.test(imp), 'audioSource records where it came from');
ok(/rec\.audioLocked = false/.test(imp), 'and the user may remove it — they brought it themselves');
ok(/ensureMediaRef\(rec, e\.mate\.name/.test(imp), 'the doc references the media, so an export still points at it');
ok(/Object\.assign\(rec, docStats\(doc\)\)/.test(imp), 'segCount/glossed come from docStats, like every other writer');

console.log('\nthe messages are grammatical at EVERY count (t() has no plural machinery)');
for (const k of ['sat.importedOne', 'sat.importedOneAudio', 'sat.importedMany', 'sat.importedManyAudio']) {
  ok(i18n.includes(`'${k}'`), `${k} exists`);
}
ok(/added === 1[\s\S]{0,120}sat\.importedOne/.test(imp), 'the single case gets its own sentence');
ok(!/text\(s\)|\(s\)/.test(i18n.match(/'sat\.imported[^\n]*/g)?.join('\n') || ''), 'no "text(s)" anywhere');
// The tallies had the same defect: "1 of 1 still need permission".
const en = i18n.slice(0, i18n.indexOf("'cc.hint'", i18n.indexOf("'cc.hint'") + 10));
ok(/'cc\.tallyNeed': 'still to ask: \{n\} of \{total\}'/.test(en), 'cc.tallyNeed reads correctly at 1');
ok(/'cc\.tallyDone': 'all have permission \(\{total\}\)'/.test(en), 'and so does cc.tallyDone');
ok(/'mg\.remaining': 'Still to match — audio: \{a\}, text: \{t\}'/.test(en), 'and the matcher status');

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

console.log(fail ? `\n${fail} FAILED\n` : '\nall ok\n');
process.exit(fail ? 1 : 0);
