/* CUTTING IS A MODE YOU ENTER, NOT CONTROLS THAT ARE ALWAYS THERE.
 *
 * Seth, 2026-09-08, after three rounds of trying to make the ✂ fit around the text:
 *   1. "the scissors icon underneath the play head covers up the baseline textbox so you can't see
 *      what you're typing" — it was 30px anchored by its top to the wave's bottom edge, covering 26
 *      of a 40px text box (measured at 375x812).
 *   2. Moving it ONTO the wave was tried and REJECTED: "Putting the scissors RIGHT on top of the play
 *      head isn't a solution either, because that makes it easy to accidentally split when you meant
 *      to scrub." ⚠ The wave is the scrub surface. Do not go back.
 *   3. Shrinking it and reserving a lane per line was tried, and then withdrawn: "We can just have
 *      button sizes and spacing like we did before. No need for adaptive sizes for different screens,
 *      extra padding, etc."
 *
 * The answer came from PAT: "all cuts on baseline or gloss tab start with pushing a scissors button
 * in the left edge of a line and then all the scissors buttons show up. Then spacing/covering up
 * doesn't matter." And the reason: "Too many scissors buttons on a small touch screen makes for a
 * lot of accidental pushing the wrong button and then being confused about how to undo cut mode."
 *
 * ⚠ WHY THE EARLIER ATTEMPTS ALL FAILED, which is the thing worth keeping: they were trying to find
 * permanent room for controls that are wanted for a few seconds. Arming one line at a time makes the
 * idle screen free of them, so the sizes can stay what they were, and the armed line may overlap
 * freely — in that moment the user is choosing a cut point, not reading.
 *
 * Run: node --test test/playhead-scissors-placement.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const STRIPS = rd('../docs/js/segment-strips.js'), CSS = rd('../docs/css/app.css');
const APP = rd('../docs/js/app.js'), I18N = rd('../docs/js/i18n.js');

test('the split controls are hidden until their line is armed', () => {
  assert.match(CSS, /\.seg-strip:not\(\.cut-armed\) \.cut-scissors,\s*\n\.seg-strip:not\(\.cut-armed\) \.scissor-btn,\s*\n\.segment:not\(\.cut-armed\) \.cut-scissors,\s*\n\.segment:not\(\.cut-armed\) \.scissor-btn,\s*\n\.segment:not\(\.cut-armed\) \.chain-btn \{ display: none !important; \}/,
    'both tabs, and the chain links with them');
});

test('the sizes are the ORIGINAL ones — the shrinking and the lanes were withdrawn', () => {
  assert.match(CSS, /width: 30px; height: 30px; line-height: 1; font-size: 15px;/, 'the ✂ is 30px again');
  assert.match(CSS, /\.gseg-wavewrap \.gseg-scissors \{ top: 100%; margin-top: 2px; \}/, 'and hangs below the wave as before');
  assert.doesNotMatch(CSS, /--cut-btn|cutlane|cut-scissors\.on-wave/, 'no adaptive size, no reserved lane, no on-the-wave placement');
});

test('one line is armed at a time, and the same button disarms', () => {
  const fn = STRIPS.slice(STRIPS.indexOf('export function armLine(row, on)'), STRIPS.indexOf('export function armedRow()'));
  assert.match(fn, /for \(const el of document\.querySelectorAll\('\.cut-armed'\)\)/, 'arming one disarms the others');
  assert.match(fn, /const want = on === undefined \? !row\.classList\.contains\('cut-armed'\) : !!on;/, 'no argument means toggle');
  assert.match(fn, /if \(!want\) splitCancel\(\);/, 'putting the controls away abandons a half-placed split');
  assert.match(fn, /btn\.setAttribute\('aria-pressed', want \? 'true' : 'false'\)/);
  // the button turns red and gains a ✕ when armed — the answer to "how do I undo cut mode"
  assert.match(CSS, /\.seg-arm\[aria-pressed="true"\]::after \{\s*\n\s*content: '\\00d7';/);
});

test('both tabs offer the arm button, gated by the researcher switch', () => {
  assert.match(STRIPS, /if \(joinSplitOk\(\) && !stripsLocked\(i\)\) \{\s*\n\s*const arm = document\.createElement\('button'\);/, 'Baseline');
  assert.match(APP, /if \(joinSplitAllowed\('gloss'\)\) \{\s*\n\s*const arm = document\.createElement\('button'\);/, 'Gloss');
  assert.match(APP, /armLine\(g\)/, 'and the Gloss tab arms through the same helper, so there is one source of truth');
  assert.equal((I18N.match(/\n {2},?'cut\.arm': '/g) || []).length, 2, 'cut.arm in EN and ID');
});

test('the caret ✂ obeys the same arming, and arming is not a click that cancels', () => {
  assert.match(STRIPS, /const row = input\.closest && input\.closest\('\.seg-strip'\);\s*\n\s*if \(!row \|\| !row\.classList\.contains\('cut-armed'\)\) return false;/);
  assert.match(STRIPS, /\.scissor-btn, \.seg-arm, \.pa-cut/, 'the arm button is exempt from the tap-away cancel');
});
