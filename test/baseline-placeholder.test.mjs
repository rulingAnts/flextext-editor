/* GHOST TEXT IN AN EMPTY BASELINE LINE (#91, Brian Plimley, 2026-10-02).
 *
 * "The text box where an Editor user types the baseline is invisible until you click on it and type
 * in it. It would be better if the empty text box had ghost text saying 'Type transcription here...'
 * or so. Once the user starts typing in the box, the ghost text disappears."
 *
 * The box is the per-line `textarea.seg-text` the Baseline tab draws in segmentation mode (and the
 * Audio Segmenter's Baseline tab, which is the same renderStrips). It has no border of its own, only
 * a hairline above it, so an empty line read as nothing at all. The classic unsegmented
 * #baseline-text has always had a placeholder; the strips never did.
 *
 * WHAT IS PINNED, AND WHY:
 *   - the placeholder is set from i18n AND tagged data-i18n-ph, so a language switch repaints it
 *     through applyI18n() without re-rendering the strips;
 *   - the wording is SHORT, because `field-sizing: content` sizes an empty box to its placeholder and
 *     a phone strip column is ~260px — a ghost that wraps makes every empty line two lines tall;
 *   - it is styled grey + italic (never the vernacular blue, never --muted, which is a locked line's
 *     REAL text) and goes transparent on a read-only (armed-for-✂) line;
 *   - nothing about typing safety changes: the vernacular policy stays inherited from <body>.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const STRIPS = rd('../docs/js/segment-strips.js');
const CSS = rd('../docs/css/app.css');
const I18N = rd('../docs/js/i18n.js');
const APP = rd('../docs/js/app.js');

const block = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const SEG = block(STRIPS, "input.className = 'seg-text'", "input.addEventListener('keydown'");

/* Each dictionary bounded at the NEXT `xx: {`, as i18n-parity does, so a later language block can
 * never be read as part of `id`. */
const dict = (tag) => {
  const at = I18N.indexOf('\n' + tag + ': {');
  const rest = I18N.slice(at + 1).search(/\n[a-z]{2,3}: \{/);
  return I18N.slice(at, rest < 0 ? I18N.length : at + 1 + rest);
};
const valueOf = (blk, key) => {
  const m = blk.match(new RegExp(`^  '${key.replace(/\./g, '\\.')}': '((?:[^'\\\\]|\\\\.)*)'`, 'm'));
  return m ? m[1] : null;
};

test('every segment line gets the ghost, from i18n, tagged so a language switch repaints it', () => {
  assert.ok(SEG.length > 0, 'the seg-text block is findable');
  assert.match(SEG, /input\.placeholder = deps\.t\('baseline\.linePh'\);/,
    'the placeholder is the translated string, via the t() renderStrips is handed');
  assert.match(SEG, /input\.dataset\.i18nPh = 'baseline\.linePh';/,
    'and carries data-i18n-ph, which applyI18n() repaints on a language switch');
  /* AFTER the value, not wedged between className and rows (prose-boxes-wrap pins that adjacency),
   * and unconditional — every empty line is somewhere a transcriber may land, not only the first. */
  assert.ok(SEG.indexOf('input.value = text;') < SEG.indexOf("input.placeholder = deps.t('baseline.linePh')"),
    'set after the value');
  assert.match(SEG, /input\.className = 'seg-text';\n\s*input\.rows = 1;/, 'className/rows adjacency kept');
  assert.doesNotMatch(SEG.slice(0, SEG.indexOf('input.placeholder')), /if \([^)]*text[^)]*\)\s*input\.placeholder/,
    'not gated on the line being the first or the only empty one');
});

test('applyI18n repaints [data-i18n-ph] document-wide, and the language switch calls it', () => {
  const fn = I18N.slice(I18N.indexOf('export function applyI18n'), I18N.indexOf('\n}', I18N.indexOf('export function applyI18n')));
  assert.match(fn, /querySelectorAll\('\[data-i18n-ph\]'\)\) el\.placeholder = t\(el\.dataset\.i18nPh\);/,
    'the attribute this fix relies on is the one applyI18n reads (data-i18n-ph ↔ dataset.i18nPh)');
  /* The editor's language picker repaints the whole document, so the strips — on screen or on a
   * hidden tab — are covered without being rebuilt. */
  assert.match(APP, /setLang\(langSel\.value\);\n\s*applyI18n\(\);/, 'the language picker repaints the document');
});

test("'baseline.linePh' exists in both en and id, short enough to stay on one phone line", () => {
  const en = valueOf(dict('en'), 'baseline.linePh');
  const id = valueOf(dict('id'), 'baseline.linePh');
  assert.ok(en, 'en has it');
  assert.ok(id, 'id has it');
  assert.notEqual(en, id, 'and id is a translation, not a copy');
  /* ⚠ THE LENGTH IS THE DESIGN. field-sizing: content grows an empty box to fit its placeholder; at
   * 18px italic a ~260px phone column holds about 26 characters. A friendlier, longer sentence here
   * would quietly double the height of every empty line in the editor and the segmenter. */
  for (const [lang, s] of [['en', en], ['id', id]]) {
    assert.ok(s.length <= 26, `${lang} ghost is ${s.length} chars — keep it ≤ 26 so it fits one line on a phone`);
  }
});

test('the ghost is styled as a hint, and hidden on a line armed for ✂', () => {
  const ph = CSS.indexOf('.seg-text::placeholder {');
  assert.ok(ph >= 0, '.seg-text::placeholder exists');
  const rule = CSS.slice(ph, CSS.indexOf('}', ph));
  assert.match(rule, /font-style: italic/, 'italic, so it never reads as typed vernacular');
  assert.match(rule, /opacity: 1/, 'opacity 1 — Firefox dims placeholders on its own');
  assert.doesNotMatch(rule, /var\(--vern\)|var\(--muted\)/,
    'not the vernacular blue, and not --muted (a locked line\'s REAL text uses that)');
  const ro = CSS.indexOf('.seg-text:read-only::placeholder {');
  assert.ok(ro >= 0, '.seg-text:read-only::placeholder exists');
  assert.match(CSS.slice(ro, CSS.indexOf('}', ro)), /color: transparent/,
    'a read-only (armed) line does not invite typing');
  assert.ok(ph > CSS.indexOf('.seg-text {') && ro > CSS.indexOf('.seg-text {'),
    'both come after the main rule, which other tests read as the FIRST .seg-text rule');
});

test('the main .seg-text rule is untouched in what other tests pin', () => {
  const at = CSS.indexOf('.seg-text {');
  const rule = CSS.slice(at, CSS.indexOf('}', at));
  assert.match(rule, /resize: none/);
  assert.match(rule, /overflow: hidden/);
  assert.match(rule, /font-family: inherit/);
  assert.match(rule, /min-height: calc\(1\.5em \+ 12px\)/);
  assert.match(rule, /field-sizing: content/);
  assert.match(rule, /color: var\(--vern\)/, 'typed text stays the vernacular blue');
});

test('the classic baseline box keeps its own placeholder', () => {
  for (const p of ['../docs/index.html', '../satellites/audio-segmenter/index.html']) {
    const html = rd(p);
    const tag = html.match(/<textarea id="baseline-text"[^>]*>/);
    assert.ok(tag, `${p} still has #baseline-text`);
    assert.match(tag[0], /data-i18n-ph="baseline\.placeholder"/, `${p} #baseline-text keeps its ghost`);
  }
});

/* ⚠ THE GHOST IS NOT A TYPING-POLICY CHANGE. The vernacular box inherits spellcheck/autocorrect off
 * from <body> (no-autocorrect-vernacular.test.mjs); a write here would be a per-render cost and a
 * second source of truth. Comments are stripped so the explanation above the code cannot trip it. */
test('the seg-text block still sets no spellcheck/autocorrect/autocomplete/typing attribute', () => {
  const code = noComments(SEG);
  assert.doesNotMatch(code, /\.(spellcheck|autocorrect|autocomplete|autocapitalize)\s*=/, 'no property writes');
  assert.doesNotMatch(code, /setAttribute\(\s*'(spellcheck|autocorrect|autocomplete|autocapitalize|writingsuggestions|data-typing)'/,
    'no attribute writes');
  assert.doesNotMatch(code, /dataset\.typing\s*=/, 'no data-typing');
});
