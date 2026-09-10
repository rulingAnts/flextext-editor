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
  /* ⚠ THE CHARACTER IS A SETTING NOW (v671), not a hard-coded period — Seth: "give the researcher a
   * setting to decide WHICH word-break character to use between words in gloss fields." So assert
   * that a space is substituted by the CONFIGURED separator, not by a literal '.'. */
  assert.match(g, /g\.value\.split\(' '\)\.join\(glossBreak\(\)\)/, 'and substitutes the configured separator');
  assert.match(g, /setSelectionRange\(at, at\)/, 'keeping the caret where the typist left it');
  /* ⚠ The keydown branch STAYS: on a physical keyboard it replaces a SELECTION and keeps Shift+Space
   * free for the transport. The value check is the net beneath it, not a replacement. */
  assert.match(APP, /g\.setRangeText\('\.', from, to, 'end'\)/, 'the precise keyboard path remains');
});

test('and NOT in the prose boxes, where spaces are ordinary', () => {
  const free = block(APP, "input.className = 'free-input'", 'registerCaretScissors(input, freeRow');
  assert.doesNotMatch(free, /split\(' '\)\.join\(glossBreak/, 'the free translation keeps its spaces');
  const seg = block(STRIPS, "input.className = 'seg-text'", 'input.addEventListener(\'keydown\'');
  assert.doesNotMatch(seg, /split\(' '\)\.join\(glossBreak/, 'and so does a segment row');
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
  /* height:auto BEFORE reading scrollHeight, or the box never shrinks again after a deletion —
   * scrollHeight reports the content height only when the element is not already held taller. */
  const g = STRIPS.slice(STRIPS.indexOf('export function growArea(el)'),
                         STRIPS.indexOf('export function installKeyboardOverlayGuard'));
  assert.ok(g.indexOf("el.style.height = 'auto';") < g.indexOf('el.scrollHeight'),
    'height:auto first, or the box never shrinks after a deletion');
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
  /* ⚠ The guard moved from "is there a space?" to "did anything change?" when the repeated-period
   * rule joined this pass (v670). It had to: a gloss holding "PST..PERF" and no space at all still
   * needs tidying, and that is the likeliest state after Gboard has had its way with the box. The
   * property under test is unchanged — write nothing when there is nothing to fix. */
  assert.match(b, /if \(want === g\.value\) return;/, 'a no-op when there is nothing to fix');
  assert.match(b, /const spaced = g\.value\.split\(' '\)\.join\(glossBreak\(\)\);/, 'the substitution still runs unconditionally, with the configured separator');
  // the doc gets the SAME value the box got — asserted as that identity rather than as a literal,
  // since what is assigned is now the tidied string rather than a re-read of g.value
  assert.match(b, /g\.value = want;\s*\n\s*w\.gls = want;/, 'and the doc is updated, not just the box');
  assert.match(b, /schedulePersist\(\);/, 'and saved');
});

/* ⚠ THE SLIVER BUG, PINNED. Seth, 2026-09-10: "rows=1 is so thin it's not showing any text, even
 * text that was already there. It doesn't grow to fit until the field is focused and edited." Cause:
 * growArea ran while the element was still detached, scrollHeight was 0, and 0px was written as the
 * height. The first edit happened after insertion, which is why editing appeared to fix it.
 *
 * Three independent defences, because this must not be able to recur:
 *   1. never measure a detached node, and never write a zero measurement
 *   2. defer the first call by a microtask, so the row is in the document
 *   3. a CSS min-height floor, so one line is visible even when no measurement is possible */
test('a zero or impossible measurement can never collapse the box', () => {
  const fn = STRIPS.slice(STRIPS.indexOf('export function growArea(el)'),
                          STRIPS.indexOf('export function installKeyboardOverlayGuard'));
  assert.match(fn, /if \(!el\.isConnected\) return;/, 'a detached node is refused outright');
  assert.match(fn, /const prev = el\.style\.height;/, 'the previous height is kept');
  assert.match(fn, /if \(!h\) \{ el\.style\.height = prev; return; \}/,
    'a zero measurement restores rather than collapses — a hidden tab reports 0 too');
  assert.ok(fn.indexOf('const h = el.scrollHeight') < fn.indexOf('if (!h)'),
    'measured once, then judged — not written and then corrected');
  // And it stands down where the browser sizes natively, or an inline height would override it.
  assert.match(fn, /if \(NATIVE_FIELD_SIZING\) return;/);
  assert.match(STRIPS, /CSS\.supports\('field-sizing', 'content'\)/);
});

test('the first sizing is deferred until the row is in the document', () => {
  assert.match(APP, /queueMicrotask\(\(\) => growArea\(input\)\);/, 'the free translation defers');
  assert.match(STRIPS, /queueMicrotask\(\(\) => growArea\(input\)\);/, 'and so does a segment row');
});

/* ⚠ AN EMPTY BOX IS ONE LINE TALL WITHOUT ANY SCRIPT RUNNING. Seth: "we also want empty text fields
 * to be one text line tall, not zero pixels tall until the user starts typing. Or focuses the
 * field." So the floor is CSS, not JS — it cannot depend on a measurement that might not happen. */
test('an empty box is one line tall by CSS alone', () => {
  for (const sel of ['.free-input', '.seg-text']) {
    const rule = CSS.slice(CSS.indexOf(sel + ' {'), CSS.indexOf('}', CSS.indexOf(sel + ' {')));
    assert.match(rule, /min-height: calc\(1\.[45]\d*em \+ \d+px\)/,
      `${sel} floors at one line in CSS, independent of any measurement`);
    assert.doesNotMatch(rule, /min-height: 0/, `${sel} must not floor at zero`);
  }
});

test('focus re-measures as a backstop, but is never required', () => {
  assert.match(APP, /input\.addEventListener\('focus', \(\) => growArea\(input\)\);/);
  assert.match(STRIPS, /input\.addEventListener\('focus', \(\) => growArea\(input\)\);/);
});
