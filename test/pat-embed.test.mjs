// The paragraph tool and the Audio Segmenter on the engine's chunked assembly (2026-09-07), the
// tool's autosave split, the .pfsx courtesy, and the segmenter's new listening-page download.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fxpaBlobOf, paragraphPreviewBlob, buildParagraphPreviewHtml } from '../docs/js/paragraph-export.js';
import { serializeFxpa, validateFxpa } from '../docs/js/paragraph-model.js';
import { b64PartsOf } from '../docs/js/seg-exports.js';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const UI = rd('../docs/js/paragraph-ui.js'), APP = rd('../docs/js/app.js'), I18N = rd('../docs/js/i18n.js');
const b64 = Buffer.from(Array.from({ length: 9001 }, (_, i) => (i * 7) % 251)).toString('base64');
const data = { format: 'flextext-paragraph-analysis', version: 1, title: 'T', vernLang: 'und', analLang: 'en',
  audio: { b64, mime: 'audio/wav', name: 'a.wav' },
  lines: [{ id: 'L1', baseline: 'aa bb', start: 0, end: 1000, words: [{ txt: 'aa', gls: 'one' }, { txt: 'bb', gls: 'two' }], free: 'x' }],
  tree: [] };
// plain keys are `  'k': '`, release-note keys are `    ,'k': '` — count both forms
const keyCount = (k) => (I18N.match(new RegExp(`\n {2,4},?'${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length;

test('the tool saves a .fxpa byte-for-byte as JSON.stringify would, without stringifying the audio', async () => {
  const now = await (await fxpaBlobOf(data)).text();
  assert.equal(now, serializeFxpa(data));
  assert.ok(validateFxpa(JSON.parse(now)).ok);
  const noAudio = await (await fxpaBlobOf(data, { audio: false })).text();
  assert.equal(noAudio, serializeFxpa(data, { audio: false }), 'the no-audio save is the plain one');
  assert.equal(JSON.parse(noAudio).audio, undefined);
});

test('the tool\'s own listening page carries the audio as chunk literals', async () => {
  const html = await (await paragraphPreviewBlob(data, { title: 'T', audioB64: b64, audioMime: 'audio/wav' })).text();
  const arr = JSON.parse('[' + html.match(/var b64 = \[(.*?)\], parts = \[\], total = 0;/s)[1] + ']');
  assert.equal(arr.join(''), b64);
  assert.match(html, /new Blob\(\[u\], \{ type: "audio\/wav" \}\)/);
  assert.match(html, /var u = new Uint8Array\(total\), off = 0;/, 'the whole recording, for the waveform decoder (v614 regression)');
  assert.match(html, /decodeAudioData\(u\.buffer\.slice\(0\)\)/);
  // a page built the plain way says the same thing with one element
  assert.match(buildParagraphPreviewHtml(data, { audioB64: 'QUJD', audioMime: 'audio/wav' }), /var b64 = \["QUJD"\]/);
  const many = (await b64PartsOf(b64, 300)).length; assert.ok(many > 5, 'the chunker was exercised');
});

test('the tool\'s save and export go through the Blob builders, and the saver takes a Blob', () => {
  assert.match(UI, /async function saveFxpa\(withAudio = true\)/);
  assert.match(UI, /saveFile\(await fxpaBlobOf\(state, \{ audio: withAudio \}\), name, 'application\/json'/);
  assert.match(UI, /const html = await paragraphPreviewBlob\(state, \{/);
  assert.match(UI, /async function runExport\(\)/, 'its caller became async with it');
  assert.match(UI, /await w\.write\(text instanceof Blob \? text : new Blob\(\[text\], \{ type: mime \}\)\)/);
  assert.match(UI, /URL\.createObjectURL\(text instanceof Blob \? text : new Blob\(\[text\], \{ type: mime \}\)\)/);
});

test('autosave: the text on every edit, the recording once, and a reload puts them back together', () => {
  assert.match(UI, /const WORKING_AUDIO_KEY = 'fxpa:working-audio';/);
  assert.match(UI, /db\.putMedia\(WORKING_KEY, \{ text: serializeFxpa\(state, \{ audio: false \}\) \}\)/, 'no whole-recording stringify per keystroke');
  assert.match(UI, /if \(state\.audio !== persistedAudio\) \{/, 'the audio record is written when the recording changes, not on every edit');
  assert.match(UI, /db\.putMedia\(WORKING_AUDIO_KEY, \{ audio: state\.audio \}\)/);
  assert.match(UI, /Promise\.all\(\[db\.getMedia\(WORKING_KEY\), db\.getMedia\(WORKING_AUDIO_KEY\)\.catch\(\(\) => null\)\]\)/);
  assert.match(UI, /if \(aud && aud\.audio && aud\.audio\.b64 && !\(raw\.audio && raw\.audio\.b64\)\) \{/, 'an older inline working copy still restores as it did');
  assert.match(UI, /persistedAudio = state \? state\.audio : null;\s+\/\/ already on disk/);
  const close = UI.slice(UI.indexOf('const doClose = () => {'), UI.indexOf('const doClose = () => {') + 400);
  assert.match(close, /db\.deleteMedia\(WORKING_AUDIO_KEY\)/, 'closing forgets the recording too');
  assert.match(UI, /function persistWorking\(\) \{\s+if \(!state\) return;/);
});

test('dropping ELAN\'s .pfsx sidecar, or any stray XML, is told apart from a spreadsheet', () => {
  assert.match(UI, /const pfsx = files\.find\(\(f\) => \/\\\.pfsx\$\/i\.test\(f\.name\)\);\s+if \(pfsx\) return renderOpen\(\[t\('para\.errPfsx', \{ name: pfsx\.name \}\)\]\);/);
  assert.match(UI, /if \(\/\^\\s\*<\\\?xml\|\^\\s\*<\[A-Za-z\]\/\.test\(txt\)\) return renderOpen\(\[t\('para\.errXml', \{ name: maybeCsv\.name \}\)\]\);/);
  assert.ok(UI.indexOf("const pfsx = files.find") < UI.indexOf("const maybeCsv = files.find"), 'checked before the CSV sniff that mistook it');
  for (const k of ['para.errPfsx', 'para.errXml']) assert.equal(keyCount(k), 2, `${k} in EN and ID`);
});

test('the Audio Segmenter offers the listening page, and tells its two "none" cases apart', () => {
  assert.match(APP, /<button class="secondary-btn" data-x="preview">\$\{esc\(t\('sat\.exportPreview'\)\)\}<\/button>/);
  assert.match(APP, /preview: kind === 'preview', fxpa: kind === 'fxpa' \}/);
  assert.match(APP, /\(bundle\.trimmed \|\| \[\]\)\.includes\('preview'\) \? 'sat\.exportPreviewTooBig' : 'sat\.exportNoPreview'/);
  for (const k of ['sat.exportPreview', 'sat.exportNoPreview', 'sat.exportPreviewTooBig', 'panel.rel.new.embedChunks'])
    assert.equal(keyCount(k), 2, `${k} in EN and ID`);
});
