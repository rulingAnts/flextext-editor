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
  /* ⚠ Not gated on the line being the first or the only empty one. (The assertion this replaces
   * sliced the block to BEFORE 'input.placeholder' and then searched that slice for
   * 'input.placeholder' — it could never fail.) The write must be a statement of its own, and the
   * statement before it must not be an unbraced `if`/`else` that would govern it. */
  const lines = SEG.split('\n');
  const phAt = lines.findIndex((l) => l.includes("input.placeholder = deps.t('baseline.linePh')"));
  assert.ok(phAt > 0, 'the placeholder write is on a line of its own');
  assert.match(lines[phAt], /^\s*input\.placeholder = /, 'and begins that line — not the tail of an if');
  const prev = lines.slice(0, phAt).map((l) => l.trim())
    .filter((l) => l && !l.startsWith('*') && !l.startsWith('//') && !l.startsWith('/*')).pop();
  assert.doesNotMatch(prev, /^(if|else)\b/, `the statement before it ("${prev}") does not govern it`);
  assert.equal(prev, "input.dataset.i18nPh = 'baseline.linePh';", 'it follows the data attribute, unconditionally');
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
  /* ⚠ THE LENGTH IS THE DESIGN — and this guard is honest about what it knows. field-sizing:
   * content grows an empty box to fit its placeholder; the strip's text column on a 360px phone is
   * about 260px (the ▶ button and the gutters take the rest), and at 18px italic the Latin glyphs
   * these strings use average roughly 9px, so about 28 characters fit on one line. That is an
   * estimate, not a measurement — no test here renders text — so the bound is the estimate, and the
   * Indonesian ghost ("Ketik apa yang Anda dengar…", 27) is the longest it admits. A friendlier,
   * longer sentence would quietly double the height of every empty line in the editor and the
   * segmenter; if one is ever wanted, measure it on a phone first and move this bound with it. */
  for (const [lang, s] of [['en', en], ['id', id]]) {
    const n = [...s].length;
    assert.ok(n <= 28, `${lang} ghost is ${n} chars — keep it ≤ 28 (estimated one phone line at 18px italic)`);
  }
  assert.equal(id, 'Ketik apa yang Anda dengar…', 'the Indonesian ghost says what you hear, in full (#91 review)');
});

/* ⚠ CONTRAST, COMPUTED (#91 review). The ghost sits on white (the editor page) and on --panel (the
 * strips inside a panel); WCAG AA for text is 4.5:1 on each. The first grey, #8b939e, managed 3.10:1
 * and 2.87:1. Computed from the stylesheet with the WCAG relative-luminance formula, so a lighter
 * "nicer" grey cannot come back unnoticed. */
test('the ghost reaches 4.5:1 on white and on --panel', () => {
  const ph = CSS.indexOf('.seg-text::placeholder {');
  const rule = CSS.slice(ph, CSS.indexOf('}', ph));
  const fg = (rule.match(/color: (#[0-9a-f]{6})\b/i) || [])[1];
  assert.ok(fg, 'the ghost colour is a six-digit hex, so the ratio can be computed here');
  const panel = (CSS.match(/--panel: (#[0-9a-f]{6});/i) || [])[1];
  assert.ok(panel, '--panel is a six-digit hex');
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
  const ratio = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  assert.ok(ratio(fg, '#ffffff') >= 4.5, `${fg} on white is ${ratio(fg, '#ffffff').toFixed(2)}:1`);
  assert.ok(ratio(fg, panel) >= 4.5, `${fg} on --panel ${panel} is ${ratio(fg, panel).toFixed(2)}:1`);
  assert.ok(ratio('#8b939e', '#ffffff') < 4.5 && ratio('#8b939e', panel) < 4.5, 'the formula agrees the old grey failed both');
  const muted = (CSS.match(/--muted: (#[0-9a-f]{6});/i) || [])[1];
  assert.ok(L(fg) > L(muted), `lighter than --muted (${muted}), so it still reads as a hint beside a locked line's real text`);
});

test('the comments are exact: a hairline above (not "no border"), and silence lines get the ghost too', () => {
  const note = SEG.slice(0, SEG.indexOf('input.placeholder'));
  assert.match(note, /border of its own beyond the hairline above it \(border-top/,
    '.seg-text has a border-top, so "no border of its own" alone was false');
  assert.doesNotMatch(note, /border of its own \(see/, 'the old, unqualified wording is gone');
  assert.match(note, /kept empty on purpose to mark silence \(\.seg-empty\)[\s\S]*shows the ghost too/,
    'a silence strip shows "Type what you hear…" as well, and the code says so where the ghost is set');
  const main = CSS.slice(CSS.indexOf('.seg-text {'), CSS.indexOf('}', CSS.indexOf('.seg-text {')));
  assert.match(main, /border: none; border-top: 1px solid var\(--border\)/, 'and that is still what the rule does');
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
