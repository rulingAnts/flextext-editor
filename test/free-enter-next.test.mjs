/* #78: where Enter goes from the END of a free translation on the Gloss tab.
 *
 * Seth, 2026-09-11: "let's do next line's first gloss by default (but also if glosses aren't
 * editable, then it should go on to the free translation), and give the researcher the choice."
 *
 * These read code with comments stripped, because a comment naming a function satisfies a search for
 * it. A block comment is only recognized where one can start (see ws-language-name.test.mjs). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const bare = (s) => s.replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const APP = bare(rd('../docs/js/app.js')), PANEL = bare(rd('../docs/js/researcher-panel.js'));
const I18N = rd('../docs/js/i18n.js');
const from = (src, sig, len = 700) => { const at = src.indexOf(sig); assert.ok(at > -1, `${sig} exists`); return src.slice(at, at + len); };

test("the default is the next line's first gloss, and a line without gloss boxes gets its free translation", () => {
  assert.match(from(APP, 'function freeEnterGoesToGloss(s)', 120), /\(s \|\| settings\)\.freeEnterNext !== 'free'/, 'unset means gloss');
  const pick = from(APP, 'function nextBoxAfterFree(lineEl)', 520);
  assert.match(pick, /document\.querySelectorAll\('#gloss-body \.segment'\)/, 'the next LINE, in Gloss-tab order');
  assert.match(pick, /const gloss = next\.querySelector\('\.gloss-input'\);/, "that line's FIRST gloss box");
  assert.match(pick, /return freeEnterGoesToGloss\(\) \? \(gloss \|\| free\) : \(free \|\| gloss\);/,
    'each choice falls back to the other kind of box, so a line with no gloss boxes still gets somewhere');
});

test('both Enter branches in a free translation walk on the same way; the free-only walk is gone', () => {
  const start = APP.indexOf("fi.addEventListener('keydown'");
  const handler = APP.slice(start, APP.indexOf('syncOverviewMarks(() => player, segs);', start));
  assert.ok(start > -1 && handler.length > 500, 'found the free translation key handler');
  assert.equal((handler.match(/walkOnFromFree\(g\);/g) || []).length, 2, 'the move-to-next branch, and the walk when there is nothing to split');
  assert.doesNotMatch(handler, /all\.indexOf\(fi\) \+ 1/, 'no walk that only knows about free translations');
  const walk = from(APP, 'function walkOnFromFree(lineEl)', 420);
  assert.match(walk, /if \(!next\) return;/, 'the last line keeps the caret');
  assert.match(walk, /setSelectionRange\(next\.value\.length, next\.value\.length\)/, 'the caret lands at the end of the box it reaches');
});

test('the phone keyboard lands where the Enter key does', () => {
  assert.match(from(APP, 'function freeEnterShowsNext()', 120), /return enterAtEndAdvances\(\) && freeEnterGoesToGloss\(\);/,
    "the Next key only where the phone's own page order reaches the same box: the gloss default");
  assert.match(APP, /applyEnterKeyHint\(input, freeEnterShowsNext\(\)\);\n {2}input\.addEventListener\('focus', \(\) => \{ growArea\(input\); applyEnterKeyHint\(input, freeEnterShowsNext\(\)\); \}\);/,
    'the translation box asks for that key before its first focus and on every one');
  const phone = APP.indexOf("if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') return;");
  const strip = APP.indexOf("input.addEventListener('input', () => {\n    if (/[\\r\\n]/.test(input.value)) {");
  assert.ok(phone > -1, 'a typed line break, never a paste');
  assert.ok(strip > -1 && phone < strip, 'registered BEFORE the handler that turns line breaks into spaces');
  assert.match(APP, /if \(!enterAtEndAdvances\(\) \|\| input\.value\.slice\(input\.selectionStart \?\? 0\)\.trim\(\)\) return;/,
    'only at the end of the box, and only where Enter is set to move to the next line');
  assert.match(APP, /if \(!line \|\| !line\.querySelector\('\.gseg-bar'\) \|\| line\.classList\.contains\('cut-armed'\)\) return;/,
    'only on a line whose Enter key walks: one decorateGlossSegments has wired (its ▶ bar), not armed for a cut');
  assert.match(APP, /setTimeout\(\(\) => walkOnFromFree\(line\), 0\);/, 'the same walk, once the text has been stored');
});

test('the researcher chooses on both forms, and the choice travels with a setup link', () => {
  const field = "{ k: 'freeEnterNext', type: 'select', opts: ['gloss', 'free'], optPrefix: 'panel.opt.freeEnterNext.', note: 'panel.f.freeEnterNextNote' }";
  const norm = "else if (f.k === 'freeEnterNext') v.freeEnterNext = s.freeEnterNext === 'free' ? 'free' : 'gloss';";
  for (const [name, src] of [['app.js', APP], ['researcher-panel.js', PANEL]]) {
    assert.ok(src.includes(field), `${name}: the field`);
    assert.ok(src.indexOf(field) > src.indexOf("{ k: 'enterAtEnd', type: 'select'"), `${name}: next to what Enter does at the end of a line`);
    assert.ok(src.includes(norm), `${name}: an unset device shows the gloss default`);
  }
  assert.match(APP, /'enterAtEnd', 'freeEnterNext',/, 'travels with a setup link');
  for (const k of ['panel.f.freeEnterNext', 'panel.f.freeEnterNextNote', 'panel.opt.freeEnterNext.gloss', 'panel.opt.freeEnterNext.free']) {
    assert.equal((I18N.match(new RegExp(`\\n {2,4},?'${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  }
});
