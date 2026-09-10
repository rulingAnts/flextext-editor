/* WHICH BOX GETS WHICH RULE — and they are NOT the same rule (Seth, 2026-09-10).
 *
 * Two value-normalisations, done on the `input` event rather than on keystrokes, applied to
 * DIFFERENT fields. Getting them the wrong way round would be quietly destructive: periods inside a
 * free translation, or spaces surviving in a gloss.
 *
 *   space → '.'                    word GLOSS only. "On free translation and baseline, spaces are
 *                                  allowed." A gloss is one morpheme label where `.` joins the parts
 *                                  (1SG.SUBJ); prose boxes are prose.
 *   wrap + grow + no line breaks   the full-line prose boxes: the free translation on the Gloss tab,
 *                                  and the per-segment rows on the Baseline tab in segmentation mode
 *                                  — "for single line audio segments, THAT's what I'm talking about
 *                                  with word-wrap, auto-vertical-expand, and block new lines".
 *   nothing                        the LEGACY giant baseline textarea. "If we're dealing with just
 *                                  one giant text box then no, don't block enter" — a newline there
 *                                  is a PARAGRAPH BREAK (getBaselineParagraphs(doc).join('\n')).
 *
 * ⚠ ALL OF IT ON THE VALUE, NOT THE KEY, because on Android the key event is the one route that
 * cannot be relied on: a soft keyboard commits through the IME. That is what broke the gloss
 * space-to-period fix on a real device.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js');
const STRIPS = rd('../docs/js/segment-strips.js');
const CSS = rd('../docs/css/app.css');

const block = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

test('space becomes a period in the word gloss, on the VALUE not the keystroke', () => {
  const g = block(APP, "g.className = 'gloss-input'", 'g.addEventListener(\'keydown\'');
  assert.match(g, /g\.value\.includes\(' '\)/, 'it watches the value');
  assert.match(g, /g\.value\.replace\(\/ \/g, '\.'\)/, 'and substitutes');
  assert.match(g, /setSelectionRange\(at, at\)/, 'keeping the caret where the typist left it');
  /* ⚠ The keydown branch STAYS: on a physical keyboard it replaces a SELECTION and keeps Shift+Space
   * free for the transport. The value check is the net beneath it, not a replacement. */
  assert.match(APP, /g\.setRangeText\('\.', from, to, 'end'\)/, 'the precise keyboard path remains');
});

test('and NOT in the prose boxes, where spaces are ordinary', () => {
  const free = block(APP, "input.className = 'free-input'", 'registerCaretScissors(input, freeRow');
  assert.doesNotMatch(free, /replace\(\/ \/g/, 'the free translation keeps its spaces');
  const seg = block(STRIPS, "input.className = 'seg-text'", 'input.addEventListener(\'keydown\'');
  assert.doesNotMatch(seg, /replace\(\/ \/g/, 'and so does a segment row');
});

test('the free translation and the segment rows are textareas that wrap', () => {
  assert.match(APP, /const input = document\.createElement\('textarea'\);\n  input\.className = 'free-input';/,
    'the free translation is no longer an <input>, which could not wrap at all');
  assert.match(STRIPS, /const input = document\.createElement\('textarea'\);\n    input\.className = 'seg-text';/,
    'nor is a segment row');
  for (const [src, what] of [[APP, 'free-input'], [STRIPS, 'seg-text']]) {
    assert.match(src, new RegExp(`input\\.className = '${what}';\\n\\s*input\\.rows = 1;`),
      `${what} starts one line tall`);
  }
});

test('they grow to fit instead of scrolling inside themselves', () => {
  assert.match(STRIPS, /export function growArea\(el\)/, 'one shared helper');
  assert.match(STRIPS, /el\.style\.height = 'auto';\n\s*el\.style\.height = el\.scrollHeight \+ 'px';/,
    "height:auto first, or the box never shrinks after a deletion");
  assert.match(APP, /growArea, initCut/, 'app.js imports it rather than keeping a second copy');
  // Grown on first paint AND on every edit, or the box jumps on the first keystroke.
  for (const [src, what] of [[APP, 'free-input'], [STRIPS, 'seg-text']]) {
    const b = block(src, `input.className = '${what}'`, "addEventListener('keydown'");
    assert.match(b, /growArea\(input\);/, `${what} is grown up front`);
    assert.ok((b.match(/growArea\(input\)/g) || []).length >= 2, `${what} is grown again on input`);
  }
  for (const sel of ['.free-input', '.seg-text']) {
    const rule = CSS.slice(CSS.indexOf(sel + ' {'), CSS.indexOf('}', CSS.indexOf(sel + ' {')));
    assert.match(rule, /resize: none/, `${sel} has no drag handle — growArea owns the height`);
    assert.match(rule, /overflow: hidden/, `${sel} never shows a scrollbar; that would mean growing failed`);
    assert.match(rule, /font-family: inherit/, `${sel} must not fall back to a textarea's monospace`);
  }
});

test('line breaks are stripped from the value, and Enter is prevented too', () => {
  for (const [src, what] of [[APP, 'free-input'], [STRIPS, 'seg-text']]) {
    const b = block(src, `input.className = '${what}'`, "registerCaretScissors");
    assert.match(b, /\/\[\\r\\n\]\/\.test\(input\.value\)/, `${what} checks the value for breaks`);
    assert.match(b, /replace\(\/\[\\r\\n\]\+\/g, ' '\)/, `${what} replaces them with a space`);
    assert.match(b, /setSelectionRange\(before, before\)/, `${what} restores the caret`);
  }
  /* ⚠ Scoped to the ENTER handler, not the whole box: the Tab handler beside it legitimately stops
   * propagation, and asserting over both made this fail for a reason unrelated to what it tests. */
  assert.match(APP, /input\.addEventListener\('keydown', \(e\) => \{ if \(e\.key === 'Enter'\) e\.preventDefault\(\); \}\);/,
    'Enter is prevented — and preventDefault ONLY, so anything else acting on Enter still sees it');
});

/* ⚠ THE LEGACY BASELINE IS DELIBERATELY UNTOUCHED. Its newlines ARE its paragraphs, and blocking
 * them would remove the only way to type a second one. This test exists because the request said
 * "baseline", and the safe reading was the segmentation-mode rows, not this box. */
test('the giant baseline textarea keeps its Enter and its newlines', () => {
  const b = APP.slice(APP.indexOf("$('#baseline-text').addEventListener('blur'") - 200);
  assert.doesNotMatch(b.slice(0, 900), /growArea\(\$\('#baseline-text'\)\)/,
    'not converted or grown — the ordering around it is load-bearing (see strip-ticker)');
  assert.match(APP, /getBaselineParagraphs\(current\.doc\)\.join\('\\n'\)/,
    'its value still is paragraphs joined by newlines');
});

/* ⚠ THE BLUR PASS IS THE ONE THAT CANNOT BE FOUGHT. Seth, 2026-09-10: "our period auto-replace and
 * Android auto-correct might be fighting each other. So could also be good to change it after lost
 * focus. Gboard wouldn't be able to fight that." While the box has focus the IME owns a composition
 * over it and can undo or reorder a mid-word substitution; once focus leaves, nothing else is
 * writing. The input-time pass is feedback; this one is correctness. */
test('the gloss normalises again on blur, after the keyboard has finished with it', () => {
  const b = block(APP, "g.addEventListener('blur'", 'cell.appendChild(g)');
  assert.match(b, /if \(!g\.value\.includes\(' '\)\) return;/, 'a no-op when there is nothing to fix');
  assert.match(b, /g\.value\.replace\(\/ \/g, '\.'\)/, 'the same substitution');
  assert.match(b, /w\.gls = g\.value;/, 'and the doc is updated, not just the box');
  assert.match(b, /schedulePersist\(\);/, 'and saved');
});
