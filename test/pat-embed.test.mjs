// The paragraph tool and the Audio Segmenter on the engine's chunked assembly (2026-09-07), the
// tool's autosave split and the three ways its two records could quietly disagree, the .pfsx
// courtesy, and the segmenter's new listening-page download.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fxpaBlobOf, paragraphPreviewBlob, buildParagraphPreviewHtml } from '../docs/js/paragraph-export.js';
import { serializeFxpa, validateFxpa, newWorkingStamp, workingTextRecord, workingAudioRecord,
         readWorkingCopy, workingWritePlan } from '../docs/js/paragraph-model.js';
import { b64PartsOf } from '../docs/js/seg-exports.js';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const UI = rd('../docs/js/paragraph-ui.js'), APP = rd('../docs/js/app.js'), I18N = rd('../docs/js/i18n.js');
const MODEL = rd('../docs/js/paragraph-model.js');
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
  // both now run inside a busy scrim, so the call moved into a try/finally — see the scrim test below
  assert.match(UI, /blob = await fxpaBlobOf\(state, \{ audio: withAudio \}\);/);
  assert.match(UI, /saveFile\(blob, name, 'application\/json'/);
  assert.match(UI, /html = await paragraphPreviewBlob\(state, \{/);
  assert.match(UI, /async function runExport\(\)/, 'its caller became async with it');
  assert.match(UI, /await w\.write\(text instanceof Blob \? text : new Blob\(\[text\], \{ type: mime \}\)\)/);
  assert.match(UI, /URL\.createObjectURL\(text instanceof Blob \? text : new Blob\(\[text\], \{ type: mime \}\)\)/);
});

/* The autosaved working copy is TWO IndexedDB records — the text on every edit, the recording once
 * — and the four tests below are the three ways the first cut of that split lost a recording, plus
 * the reason the split exists at all. */
const withAudio = () => validateFxpa(JSON.parse(JSON.stringify(data))).data;
const textOnly = () => { const { audio, ...rest } = JSON.parse(JSON.stringify(data)); return validateFxpa(rest).data; };

test('autosave: the text on every edit, the recording once, and no recording in the per-edit write', () => {
  assert.match(UI, /const WORKING_AUDIO_KEY = 'fxpa:working-audio';/);
  assert.match(MODEL, /text: serializeFxpa\(data, \{ audio: false \}\)/, 'no whole-recording stringify per keystroke');
  const rec = workingTextRecord(withAudio(), 'stamp-1');
  assert.equal(rec.text.includes(b64.slice(0, 200)), false, 'the per-edit write carries no recording bytes');
  assert.equal(JSON.parse(rec.text).audio, undefined);
  assert.ok(validateFxpa(JSON.parse(rec.text)).ok, 'and what it does carry is still a valid document');
  assert.match(UI, /const plan = workingWritePlan\(\{ audio: state\.audio, persisted: persistedAudio, busy: audioBusy, gaveUp: audioGaveUp \}\);/);
  assert.match(UI, /if \(plan\.writeText\) writeWorkingText\(\); else textHeld = true;/);
  /* Both stamp guards are load-bearing — with either one taken out, a recording still being
   * written when the analyst opens the NEXT document ends up stamped onto that document. */
  assert.match(UI, /workingTextRecord\(state, state\.audio && state\.audio\.b64 \? workingStamp : ''\)/, 'a text with no recording names no stamp');
  assert.match(UI, /const migrating = audioMigrating, gen = workingGen;/);
  assert.match(UI, /if \(gen !== workingGen\) return;/, 'a write that answers after the document was closed is dropped');
  assert.match(UI, /workingGen\+\+;/, 'and opening a different document is what moves the generation on');
  const close = UI.slice(UI.indexOf('const doClose = () => {'), UI.indexOf('const doClose = () => {') + 400);
  assert.match(close, /db\.deleteMedia\(WORKING_AUDIO_KEY\)/, 'closing forgets the recording too');
  assert.match(UI, /function persistWorking\(\) \{\s+if \(!state\) return;/);
});

test('autosave: a working copy from before the split is migrated before anything strips it', () => {
  // v602 wrote ONE record, recording inline, and no audio record at all. Reading it as if the
  // recording were already on disk is what left it in neither record one keystroke later.
  const pre = { text: serializeFxpa(withAudio()) };
  const back = readWorkingCopy(pre, null);
  assert.equal(back.audio, 'inline', 'flagged for the caller to hoist, not treated as already saved');
  assert.equal(back.raw.audio.b64, b64);
  const aud = back.raw.audio;
  // ...and until that hoist has LANDED, the stripped text may not be written over the old record.
  assert.deepEqual(workingWritePlan({ audio: aud, persisted: null, busy: false, gaveUp: false }), { writeAudio: true, writeText: false });
  assert.deepEqual(workingWritePlan({ audio: aud, persisted: null, busy: true, gaveUp: false }), { writeAudio: false, writeText: false }, 'no second write over one in flight');
  assert.deepEqual(workingWritePlan({ audio: aud, persisted: aud, busy: false, gaveUp: false }), { writeAudio: false, writeText: true });
  // Once we have stopped trying, holding the text back would cost the work as well as the sound.
  assert.deepEqual(workingWritePlan({ audio: aud, persisted: null, busy: false, gaveUp: true }), { writeAudio: false, writeText: true });
  assert.match(UI, /audioMigrating = how === 'inline';/);
  assert.match(UI, /if \(how === 'inline'\) writeWorkingAudio\(state\.audio\);/);
  assert.match(UI, /\.then\(\(\) => \{ if \(gen === workingGen\) \{ persistedAudio = aud; audioMigrating = false; \} \}\)/, 'the write LANDING is what is believed');
});

test('autosave: the recording is joined back only to the text that names it', () => {
  const doc = withAudio(), stamp = newWorkingStamp();
  const rec = workingTextRecord(doc, stamp), aud = workingAudioRecord(doc, stamp);
  const back = readWorkingCopy(rec, aud);
  assert.equal(back.audio, 'joined');
  assert.equal(validateFxpa(back.raw).data.audio.b64, b64);
  // Another document's recording is never adopted — it used to be, timings and all.
  const other = workingAudioRecord(doc, newWorkingStamp());
  assert.equal(readWorkingCopy(rec, other).audio, 'lost');
  assert.equal(readWorkingCopy(rec, other).raw.audio, undefined);
  // A recording cleared by another tab is REPORTED missing, not passed off as "this text has none".
  assert.equal(readWorkingCopy(rec, null).audio, 'lost');
  assert.match(UI, /if \(how === 'lost'\) alert\(t\('para\.audioWorkingLost'\)\);/);
  // ...and a text-only document does not pick up whatever recording happens to be lying there.
  const bare = workingTextRecord(textOnly(), '');
  assert.equal(readWorkingCopy(bare, aud).audio, 'none');
  assert.equal(readWorkingCopy(bare, aud).raw.audio, undefined);
  assert.notEqual(newWorkingStamp(), newWorkingStamp());
});

test('autosave: hiding the Audio tier survives a reload', () => {
  const shown = withAudio(), stamp = newWorkingStamp();
  const hidden = { ...shown, view: { ...shown.view, audio: false } };
  const aud = workingAudioRecord(shown, stamp);
  for (const [doc, want] of [[shown, true], [hidden, false]]) {
    const back = readWorkingCopy(workingTextRecord(doc, stamp), aud);
    assert.equal(validateFxpa(back.raw).data.view.audio, want, `view.audio ${want} round-trips`);
  }
  // The stripped copy itself always says false (serializeFxpa's rule for a file with no sound in
  // it), which is exactly why the analyst's own answer has to ride in the envelope beside it.
  assert.equal(JSON.parse(workingTextRecord(shown, stamp).text).view.audio, false);
  assert.equal(workingTextRecord(hidden, stamp).viewAudio, false);
  assert.equal(workingTextRecord(shown, stamp).viewAudio, true);
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

test('the tool\'s own SFM wizard enforces one marker one role, and can say all three risks', () => {
  /* The converter modal guards the choice (claimMarker); this wizard built its mapping straight
   * from the selects, so naming \mb as both gloss and morpheme line left the clash to key order and
   * the glosses silently vanished. */
  assert.match(UI, /dedupeMapping/, 'the wizard resolves clashes by the documented ranking');
  const fn = UI.slice(UI.indexOf('function currentSfmMapping()'), UI.indexOf('function currentSfmMapping()') + 1200);
  assert.match(fn, /const resolved = dedupeMapping\(m\);/);
  assert.match(fn, /if \(sel && m\[r\] && !resolved\[r\]\) sel\.value = '';/, 'the losing select is reset, so the screen shows what was used');
  assert.match(fn, /return resolved;/, 'and the resolved mapping is what gets parsed');
  // the risk banner can now say the third thing alignmentRisk reports
  assert.match(UI, /P\.risk\.reason === 'shifted' \? 'para\.sfmRiskShifted'/, 'a shifted-column risk no longer shows the lopsided wording');
  for (const k of ['para.sfmRiskShifted'])
    assert.equal((I18N.match(new RegExp(`\\n {2,4},?'${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
});

test('slow work says so within a frame, in both apps (Seth: half a second of nothing reads as jammed)', () => {
  const APPJS = rd('../docs/js/app.js');
  // the editor's share menu
  assert.match(APPJS, /function busyScrim\(label\) \{/);
  assert.match(APPJS, /const doneBusy = busyScrim\(t\('share\.preparing'\)\);/);
  assert.match(APPJS, /try \{ await painted\(\); bundle = await buildBundle\(false\); \} finally \{ doneBusy\(\); \}/,
    'the scrim comes down whatever the outcome');
  assert.match(APPJS, /const painted = \(\) => new Promise\(\(r\) => requestAnimationFrame\(\(\) => requestAnimationFrame\(r\)\)\);/,
    'two frames, because appending an element does not paint it');
  assert.match(APPJS, /p\.textContent = label;/, 'the label is set as text, never as markup');
  // the tool's save and export
  assert.match(UI, /function paBusy\(label\) \{/);
  assert.equal((UI.match(/const doneBusy = paBusy\(t\('para\.building'\)\);/g) || []).length, 2, 'save and export both');
  assert.match(UI, /try \{ await paPainted\(\); blob = await fxpaBlobOf\(state, \{ audio: withAudio \}\); \} finally \{ doneBusy\(\); \}/);
  assert.match(UI, /\}\); \} finally \{ doneBusy\(\); \}/, 'the export is wrapped too');
  for (const k of ['share.preparing', 'para.building'])
    assert.equal((I18N.match(new RegExp(`\\n {2,4},?'${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
});
