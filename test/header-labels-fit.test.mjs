/* WORDS OR ICONS IS DECIDED BY MEASUREMENT, NOT BY A WIDTH (Seth, 2026-09-08: "The 'icons only for
 * screens less than 1000px' is not good for Indonesian labels (they're longer words)").
 *
 * 1000px was calibrated against the ENGLISH words, so the very tablet that fits "Baseline / Gloss /
 * Save / Done — send…" overflows on "Dasar / Glos / Simpan / Selesai — kirim…". Any fixed number is
 * a guess about one language, wrong for the next translation and wrong again at a larger uiScale. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), CSS = rd('../docs/css/app.css');
const HTML_EDITOR = rd('../docs/index.html'), HTML_SEG = rd('../satellites/audio-segmenter/index.html');
const fits = APP.slice(APP.indexOf('function headerRowFits'), APP.indexOf('function scheduleHeaderLabels'));

test('auto asks whether the row fits, rather than how wide the screen is', () => {
  assert.match(APP, /function headerRowFits\(\)/, 'there is a measurement');
  assert.match(APP, /const fits = headerRowFits\(\);[\s\S]*?\} else mode = fits \? 'both' : 'icons';/,
    'and it is what decides');
  assert.match(APP, /ICONS_BELOW_PX = 1000;\s*\/\/ cold-start fallback ONLY/,
    'the old width survives only as the answer of last resort');
});

/* ⚠ The title is held to a COMFORTABLE width in the sum, not its actual one: the question is
 * "do the words fit without crushing the title", not "does anything fit at all". */
test('the title is measured at its comfortable width, not its real one', () => {
  assert.match(APP, /TITLE_COMFORT_PX = 120;/);
  assert.match(fits, /el\.classList\.contains\('doc-title'\) \? TITLE_COMFORT_PX : el\.getBoundingClientRect\(\)\.width/);
});

test('a portrait tablet is narrow by decree, fit or no fit', () => {
  assert.match(APP, /portraitMql = matchMedia\('\(orientation: portrait\) and \(pointer: coarse\)'\);/,
    'gated on a coarse pointer, so a tall desktop window keeps its words');
  assert.match(APP, /if \(portraitMql && portraitMql\.matches\) mode = 'icons';/);
});

/* ⚠ The row is hidden on the texts list, so a boot-time call cannot measure anything. Returning a
 * wrong answer there and never revisiting it would strand the header in icons on a wide screen. */
test('an unmeasurable row keeps the last answer and re-measures when shown', () => {
  assert.match(fits, /if \(!row \|\| row\.hidden\) return null;/, 'hidden ⇒ cannot tell');
  assert.match(fits, /if \(!w\) return null;/, 'nor can a row with no width');
  assert.match(APP, /mode = lastAutoLabels \|\| \(\(headerLabelsMql && headerLabelsMql\.matches\) \? 'icons' : 'both'\);/,
    'last answer first, the width guess only on a cold start');
  assert.match(APP, /if \(editor && !editor\.hidden\) scheduleHeaderLabels\(\);/,
    'and entering the editor re-measures');
  assert.match(APP, /window\.addEventListener\('resize', scheduleHeaderLabels/, 'as does a resize');
});

/* THREE STAGES, IN ORDER (Seth, 2026-09-08): the title gives up its slack, then the words become
 * icons, then — only then — the row wraps. The row used to wrap first and wherever it liked, which
 * moved the CONTROLS while the title kept its width, exactly backwards. */
test('the title gives first: every control holds its size', () => {
  assert.match(CSS, /#topbar-editor > \*:not\(\.doc-title\) \{ flex: none; \}/,
    'only the title flexes, so it is the slack that goes');
  assert.match(CSS, /\.doc-title \{\s*\n\s*flex: 1 1 140px;\s*\n\s*min-width: 120px;/,
    '⚠ and it keeps a COMFORTABLE floor — wrapping is a better escape valve than an unusable title');
});

/* ⚠ AND WHEN IT MUST WRAP, IT WRAPS IN ONE PLACE. Seth: "IF wrapping happens (which it may have
 * to), wrapping should happen between the question mark and the tabs so that the tabs end up on the
 * bottom row of the upper UI area with the save and send buttons." A flex row otherwise breaks
 * wherever it runs out of room; one grouped child makes that one predictable place. */
test('wrapping is allowed, and breaks between the ? and the tabs', () => {
  assert.match(CSS, /#topbar-editor \{ flex-wrap: wrap; \}/, 'wrapping is possible again');
  assert.match(CSS, /\.topbar-tail \{ display: flex;[^}]*\}/, 'the tail is its own flex row');
  for (const [name, html] of [['editor', HTML_EDITOR], ['segmenter', HTML_SEG]]) {
    const tail = html.slice(html.indexOf('<div class="topbar-tail">'), html.indexOf('</div>', html.indexOf('<div class="topbar-tail">')));
    assert.ok(tail.includes('class="top-tabs"'), `${name}: the tabs are in the tail`);
    assert.ok(tail.includes('id="btn-save"'), `${name}: Save with them`);
    assert.ok(tail.includes('id="btn-share"'), `${name}: and Done`);
    // the help ? must stay OUTSIDE, since the break belongs between it and the tabs
    assert.ok(!tail.includes('help-btn'), `${name}: the ? stays on the first row`);
  }
});
