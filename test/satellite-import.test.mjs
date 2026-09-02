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
ok(/if \(CONSENT_MODE\) ccRenderList\(\); else sgRenderList\(\)/.test(imp), 'and it refreshes whichever list is showing');

console.log('\na recording is paired with its text BY NAME, and never by guesswork');
ok(/satBase/.test(imp) && /byBase\.get\(satBase\(f\.name\)\)/.test(imp),
   'bird.wav pairs with bird.flextext — the shape the corpus on disk already has');
ok(/const canPair = !!mate && texts\.length === 1/.test(imp),
   'a .flextext holding SEVERAL texts gets no audio: there is no way to know which one it belongs to');
ok(/skippedAudio/.test(imp) && /sat\.audioAmbiguous/.test(imp), 'and that refusal is reported, with the remedy');
ok(/orphans/.test(imp) && /sat\.audioUnmatched/.test(imp),
   'a recording that matched no text is named in the message, not silently dropped');
ok(/if \(!textFiles\.length\)/.test(imp) && /sat\.needText/.test(imp), 'audio with no text at all is refused outright');
ok(/failed\.push/.test(imp) && /toast\(t\('toast\.importFailed'/.test(imp), 'a file that will not parse says so, per file');

console.log('\nan imported recording is stored the way an attached one is');
ok(/db\.putMedia\(rec\.id/.test(imp), 'the blob goes in the media store under the doc id');
ok(/rec\.audioSource = 'local:'/.test(imp), 'audioSource records where it came from');
ok(/rec\.audioLocked = false/.test(imp), 'and the user may remove it — they brought it themselves');
ok(/ensureMediaRef\(rec, mate\.name/.test(imp), 'the doc references the media, so an export still points at it');
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

console.log('\nthe empty state no longer promises the localhost illusion');
const emptyEn = (i18n.match(/'(cc|sg)\.empty': '([^']*)'/g) || []).join(' | ');
ok(!/from the Recorder or the Editor/.test(emptyEn),
   'it does not say texts can be brought in from the Recorder or the Editor — a different origin, so they cannot');
ok(/button above/.test(emptyEn), 'it points at the button that is actually on the screen');
ok(/\.sat-tools\{/.test(css), 'and the bar has a rule, above the list where an empty screen puts it first');

console.log(fail ? `\n${fail} FAILED\n` : '\nall ok\n');
process.exit(fail ? 1 : 0);
