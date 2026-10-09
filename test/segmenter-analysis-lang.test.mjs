/* THE SEGMENTER'S TEXT COLUMN CAN SHOW ANOTHER ANALYSIS LANGUAGE, OR ALL OF THEM (Seth, 2026-10-05) — display
 * only: this device edits its own; the others are shown as they are. The pure rule measured; the wiring pinned. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analysisRows, wordGlosses, phraseFrees } from '../docs/js/flextext.js';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), CSS = rd('../docs/css/app.css'), I18N = rd('../docs/js/i18n.js'), PANEL = rd('../docs/js/researcher-panel.js');
const fn = (src, name) => { const i = src.indexOf(`function ${name}(`); return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i)); };

const W = { txt: 'kama', gls: 'water', glsLang: '', preservedXML: ['<item type="gls" lang="id">air</item>', '<item type="pos" lang="en">n</item>'] };
const SEG = { free: 'The water is cold.', freeLang: 'en', preItemsXML: [], postItemsXML: ['<item type="gls" lang="id">Airnya dingin.</item>'] };

test('analysisRows: one row for the primary or a code, every language for all, the primary first and editable', () => {
  const g = wordGlosses(W);
  assert.deepEqual(analysisRows(g, 'primary', 'en'), [{ lang: 'en', text: 'water', primary: true }]);
  assert.deepEqual(analysisRows(g, 'en', 'en'), [{ lang: 'en', text: 'water', primary: true }], 'the primary\'s own code is the primary');
  assert.deepEqual(analysisRows(g, 'id', 'en'), [{ lang: 'id', text: 'air', primary: false }]);
  assert.deepEqual(analysisRows(g, 'fr', 'en'), [{ lang: 'fr', text: '', primary: false }], 'a language the word lacks: an empty read-only row, never a crash');
  assert.deepEqual(analysisRows(g, 'all', 'en'), [{ lang: 'en', text: 'water', primary: true }, { lang: 'id', text: 'air', primary: false }]);
  const f = phraseFrees(SEG);
  assert.deepEqual(analysisRows(f, 'all', 'en'), [{ lang: 'en', text: 'The water is cold.', primary: true }, { lang: 'id', text: 'Airnya dingin.', primary: false }]);
  assert.deepEqual(analysisRows([], 'all', 'en'), [{ lang: 'en', text: '', primary: true }], 'nothing at all: still the one editable primary row');
  assert.deepEqual(analysisRows(undefined, undefined, undefined), [{ lang: 'en', text: '', primary: true }]);
});

test('the picker appears only when the text carries more than the primary; the choice is the device\'s, remembered', () => {
  assert.match(fn(APP, 'mgLangPickerHtml'), /if \(langs\.length < 2\) return '';/);
  assert.match(fn(APP, 'mgLangPickerHtml'), /opt\('primary', prim\) \+ langs\.slice\(1\)\.map\(\(l\) => opt\(l, l\)\)\.join\(''\) \+ opt\('all', t\('mg\.langAll'\)\)/, 'primary, each other code, All');
  assert.match(APP, /const MG_LANG_KEY = 'flextext-mg-lang';/);
  assert.match(APP, /langSel\.onchange = \(\) => \{ mgLangPref = langSel\.value; try \{ localStorage\.setItem\(MG_LANG_KEY, mgLangPref\); \}[^\n]*mgDraw\(\); \};/);
  assert.match(fn(APP, 'mgLangMode'), /if \(mgLangPref === 'all'\) return langs\.length > 1 \? 'all' : 'primary';/, 'All on a one-language text is just the primary');
  assert.match(APP, /const langPick = mgLangPickerHtml\(\);/);
  assert.match(APP, /<div class="mg-rowhead-text"><h3 data-i18n="mg\.text">Text<\/h3>\$\{langPick\}<\/div>/, 'beside "Text", outside the h3 applyI18n rewrites');
  // v712 (Seth: "I seem to have lost my language picker"): below 820px the heading row was hidden, picker and all.
  assert.match(APP, /<div class="mg-rowhead\$\{langPick \? ' mg-has-lang' : ''\}">/, 'the row says when it carries the picker');
  assert.match(CSS, /@media \(max-width:820px\)\{\s*\.mg-rowhead\{display:none\}[\s\S]{0,200}?\.mg-rowhead\.mg-has-lang\{display:flex;[^}]*\}\s*\.mg-rowhead\.mg-has-lang h3\{display:none\}/,
    'so on a narrow screen the headings go and the picker stays');
});

test('the primary row stays editable; every other language is read-only and tagged with its code', () => {
  const stack = fn(APP, 'mgWordStack');
  assert.match(stack, /const rows = analysisRows\(w\.src \? glossesOfWord\(w\.src\) : \[\{ lang: '', text: w\.gls \}\], mgLangMode\(\), mgPrimaryLang\(\)\);/);
  assert.match(stack, /if \(editable\) \{ mgWireEditable\(we, ln, wi, 'txt'\); if \(rows\[0\]\.primary\) mgWireEditable\(ge, ln, wi, 'gls'\); \}/, 'the vernacular word is always editable; the gloss only when it is the primary');
  assert.match(stack, /for \(const r of rows\.slice\(1\)\) stack\.appendChild\(mgAltRow\('span', 'mg-g mg-g-alt', r\)\);/);
  assert.match(APP, /const frows = analysisRows\(mgLineFrees\(ln\), mgLangMode\(\), mgPrimaryLang\(\)\);/);
  assert.match(APP, /if \(editable && frows\[0\]\.primary\) mgWireEditable\(ftbox, ln, -1, 'free'\);/);
  assert.doesNotMatch(fn(APP, 'mgAltRow'), /mgWireEditable|contentEditable/, 'an alt row is never wired for editing');
  assert.match(fn(APP, 'mgLineText'), /src: w/, 'the doc\'s own word rides along so its other languages can be read');
  assert.match(CSS, /\.mg-g-alt::before,\.mg-ft-alt::before\{content:attr\(data-lang\)/);
  for (const k of ['mg.langPick', 'mg.langAll', 'mg.langAlt', 'panel.rel.new.mgLangPick']) {
    assert.equal((I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  }
  assert.match(PANEL, /\{ v: 'v704', date: '2026-10-05', items: \[\n    \{ k: 'panel\.rel\.new\.mgLangPick' \},/);
});
