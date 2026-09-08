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
  // and that is deliberately larger than the CSS floor, which is only the last-resort squeeze
  assert.match(CSS, /#topbar-editor \.doc-title \{ min-width: 56px; \}/);
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

/* Seth: "we want our title textbox to auto resize to make sure all the UI controls stay on one
 * line." The row used to wrap, so the CONTROLS moved and the title kept its width — backwards. */
test('the row never wraps and only the title gives', () => {
  assert.match(CSS, /#topbar-editor \{ flex-wrap: nowrap; \}/);
  assert.match(CSS, /#topbar-editor > \*:not\(\.doc-title\) \{ flex: none; \}/,
    'every control holds its size; the title absorbs what is left');
});
