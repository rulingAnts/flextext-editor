/* "OPEN TEXT + RECORDING TOGETHER" IS A DIALOG WITH TWO PICKERS (Seth, 2026-10-07) — not one picker needing a
 * ctrl+click of both files. Source pins: the dialog, both entry points, the old picker gone, the words. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), HTML = rd('../docs/index.html'), CSS = rd('../docs/css/app.css'), I18N = rd('../docs/js/i18n.js'), PANEL = rd('../docs/js/researcher-panel.js');
const fn = (src, name) => { const i = src.indexOf(`function ${name}(`); return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i)); };

test('the dialog: two pickers in the panel\'s field style, Open live only once both are chosen', () => {
  const d = fn(APP, 'openPairDialog');
  assert.match(d, /<label class="rp-field"><span>\$\{esc\(t\('openPair\.textFile'\)\)\}<\/span><input type="file" id="pair-ft" accept="\$\{PAIR_TEXT_ACCEPT\}"><\/label>/);
  assert.match(d, /<label class="rp-field"><span>\$\{esc\(t\('openPair\.audioFile'\)\)\}<\/span><input type="file" id="pair-audio" accept="\$\{PAIR_AUDIO_ACCEPT\}"><\/label>/);
  assert.match(d, /<button class="primary-btn" data-pd="open" disabled>/, 'Open starts disabled');
  assert.match(d, /const ready = \(\) => \{ go\.disabled = !\(ft\.files\[0\] && au\.files\[0\]\); \};/, '…and wakes only with BOTH files');
  assert.match(d, /if \(document\.querySelector\('\[data-pair-dialog\]'\)\) return;/, 'never stacks');
  assert.match(d, /if \(e\.key === 'Escape'\)/); assert.match(d, /if \(e\.target === wrap\) finish\(\);/, 'Escape and the backdrop close it');
  assert.match(d, /Promise\.resolve\(onPair\(files\)\)\.catch\(\(err\) => toast\(t\('toast\.importFailed', \{ msg: err\.message \}\), 6000\)\);/, 'the pair goes to the caller; a failure is said, not swallowed');
  assert.match(CSS, /\.pair-card \{ width: min\(92vw, 420px\); \}/);
});

test('both surfaces open it and keep their own pairing; the editor\'s one-picker input is gone', () => {
  assert.match(APP, /\$\('#btn-new-pair'\)\?\.addEventListener\('click', \(\) => openPairDialog\(\(fs\) => newDocFromPair\(fs\)\)\);/, 'editor');
  assert.match(fn(APP, 'satImportBar'), /if \(SEGMENTER_MODE\) openPairDialog\(\(fs\) => satImportFiles\(fs\)\);\n\s+else input\.click\(\);/, 'segmenter; the other satellites keep their one picker');
  assert.doesNotMatch(HTML, /id="new-pair-file"/, 'the hidden multi-file picker is gone from the editor shell');
  assert.doesNotMatch(APP, /#new-pair-file/, '…and nothing reaches for it');
  assert.match(fn(APP, 'newDocFromPair'), /if \(!textFile \|\| !audioFile\) \{ toast\(t\('toast\.pairNeedsBoth'\), 7000\); return; \}/, 'the pairing itself is unchanged');
});

test('the words, EN and ID, and the release note', () => {
  for (const k of ['openPair.title', 'openPair.intro', 'openPair.textFile', 'openPair.audioFile', 'openPair.open', 'panel.rel.fix.pairDialog']) {
    assert.equal((I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  }
  assert.match(PANEL, /\{ v: 'v705', date: '2026-10-07', items: \[\n    \{ k: 'panel\.rel\.fix\.pairDialog' \},/);
});
