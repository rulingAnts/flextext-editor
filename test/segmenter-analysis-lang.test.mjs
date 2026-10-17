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
  assert.match(fn(APP, 'mgLangMode'), /const pref = mgLangOwn \|\| mgLangPref;\n\s*if \(pref === 'all'\) return langs\.length > 1 \? 'all' : 'primary';/, 'All on a one-language text is just the primary');
  assert.match(APP, /<div class="mg-rowhead-text"><h3 data-i18n="mg\.text">Text<\/h3>\$\{mgLangPickerHtml\(\)\}<\/div>/, 'beside "Text", outside the h3 applyI18n rewrites');
});

test('a text whose writing systems are chosen elsewhere (the FLEx shell) is shown in them, never in the device\'s pick', () => {
  // Seth, 2026-10-15: a device left on English by one text showed FLEx texts' glosses in English, read-only
  assert.match(fn(APP, 'mgOpen'), /current = rec;\n\s*const claimed = mgLangClaim && mgLangClaim\(rec\);[^\n]*\n\s*mgLangOwn = claimed \? \(typeof claimed === 'string' \? claimed : 'primary'\) : null;/,
    'decided at every open, from the record — in the view the owner keeps for it (a code, \'all\' or the primary)');
  assert.match(fn(APP, 'mgClose'), /mgLangOwn = null;/, 'and forgotten at close');
  assert.match(fn(APP, 'mgLangMode'), /if \(mgLangOwn\) return pref;/, 'its choice holds even where the text has nothing in that language');
  assert.match(fn(APP, 'mgLangPickerHtml'), /^[^\n]*\n\s*if \(mgLangOwn\) return '';/, 'and the column\'s own picker steps aside for the owner\'s');
  assert.doesNotMatch(fn(APP, 'mgLangMode'), /localStorage/, 'an owner\'s choice is never remembered for the device');
});

test('the primary row stays editable; every other language is read-only and tagged with its code — on a FLEx text each is editable in its own', () => {
  const stack = fn(APP, 'mgWordStack');
  assert.match(stack, /const rows = analysisRows\(w\.src \? glossesOfWord\(w\.src\) : \[\{ lang: '', text: w\.gls \}\], mgLangMode\(\), mgPrimaryLang\(\), mgRowLangs\(\)\);/);
  assert.match(stack, /mgWireEditable\(we, ln, wi, 'txt'\);\n\s*if \(rows\[0\]\.primary \|\| every\) mgWireEditable\(ge, ln, wi, 'gls', rows\[0\]\.lang\);/,
    'the vernacular word is always editable; the gloss when it is the primary — or, on a FLEx text, in whichever language it shows — and always IN the language it shows, never into "the slot" (the FLEx round-trip report, 2026-10-17)');
  assert.match(stack, /if \(every\) alts\.forEach\(\(el, k\) => mgWireEditable\(el, ln, wi, 'gls', rows\[k \+ 1\]\.lang\)\);/, 'every other language\'s row too, on a FLEx text');
  assert.match(stack, /const el = mgAltRow\('span', 'mg-g mg-g-alt', r\); stack\.appendChild\(el\);/);
  assert.match(APP, /function mgEveryLangEditable\(\) \{ return !!mgLangOwn; \}/, 'every language editable exactly where the shell owns the view (a FLEx text)');
  assert.match(APP, /const frows = analysisRows\(mgLineFrees\(ln\), mgLangMode\(\), mgPrimaryLang\(\), mgRowLangs\(\)\);/);
  assert.match(APP, /if \(editable && !breakRow && \(frows\[0\]\.primary \|\| every\)\) mgWireEditable\(ftbox, ln, -1, 'free', frows\[0\]\.lang\);/);
  assert.match(APP, /if \(editable && every && !breakRow\) mgWireEditable\(el, ln, -1, 'free', r\.lang\);/, 'and not on a row that is a line break');
  assert.doesNotMatch(fn(APP, 'mgAltRow'), /mgWireEditable|contentEditable/, 'an alt row is never wired for editing by itself — only where its language is editable');
  assert.match(fn(APP, 'mgEditWord'), /const gl = field === 'gls' \? \(lang \|\| mgPrimaryLang\(\)\) : null;[\s\S]*if \(gl\) setGlossIn\(ph\.words\[k\], gl, value, mgPrimaryLang\(\)\);/,
    'a gloss typed in one language is set in that language only — the primary when none is named, never "the slot"');
  assert.match(fn(APP, 'mgEditFree'), /const fl = lang \|\| mgPrimaryLang\(\);[\s\S]*setFreeIn\(ph, fl, value, mgPrimaryLang\(\)\);/, 'and a free translation');
  assert.doesNotMatch(fn(APP, 'mgEditWord') + fn(APP, 'mgEditFree'), /ph\.free = value|ph\.words\[k\]\.gls = /, 'nothing writes the slot directly');
  assert.match(fn(APP, 'mgLineText'), /src: w/, 'the doc\'s own word rides along so its other languages can be read');
  assert.match(CSS, /\.mg-g-alt::before,\.mg-ft-alt::before\{content:attr\(data-lang\)/);
  for (const k of ['mg.langPick', 'mg.langAll', 'mg.langAlt', 'panel.rel.new.mgLangPick']) {
    assert.equal((I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  }
  assert.match(PANEL, /\{ v: 'v704', date: '2026-10-05', items: \[\n    \{ k: 'panel\.rel\.new\.mgLangPick' \},/);
});
