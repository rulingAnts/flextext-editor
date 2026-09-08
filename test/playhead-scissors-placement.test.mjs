/* Seth, 2026-09-08, in three steps — the middle one is why this file exists rather than a comment.
 *
 * 1. "the scissors icon underneath the play head covers up the baseline textbox so you can't see what
 *    you're typing." The 30px button was anchored by its TOP to the wave's bottom edge, so it hung
 *    28px down over a ~39px text box. MEASURED at 375x812: it covered 26 of those 40 pixels.
 * 2. Moving it ONTO the wave was tried and REJECTED: "Putting the scissors RIGHT on top of the play
 *    head isn't a solution either, because that makes it easy to accidentally split when you meant to
 *    scrub." ⚠ The wave is the scrub surface. A button on it steals the gesture. Do not go back.
 * 3. "We might just need to adjust the line height and the size of the scissors icon. Scissors
 *    underneath the line looks good and makes sense, we just need to make sure we size and space
 *    things so the scissors button icon doesn't cover text."
 *
 * So: the ✂ stays UNDER the line, the button is smaller, and the line reserves a lane for it — and the
 * lane is only paid for when the tab actually offers splitting.
 *
 * Run: node --test test/playhead-scissors-placement.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const STRIPS = rd('../docs/js/segment-strips.js'), CSS = rd('../docs/css/app.css');
const APP = rd('../docs/js/app.js');

test('the button is small enough to sit in a lane', () => {
  assert.match(CSS, /\.cut-scissors \{ width: 24px; height: 24px; font-size: 12px; \}/);
  assert.doesNotMatch(CSS, /\.cut-scissors\.on-wave/, 'the on-the-wave placement was rejected — see step 2 above');
});

test('each tab reserves a lane under the wave, and only when splitting is offered', () => {
  assert.match(CSS, /\.seg-cutlane \.seg-text \{ padding-top: 28px; \}/, 'Baseline strips');
  assert.match(CSS, /\.gseg-cutlane \.gseg-wavewrap \{ margin-bottom: 30px; \}/, 'the Gloss tab');
  assert.match(STRIPS, /host\.classList\.toggle\('seg-cutlane', joinSplitOk\(\)\);/,
    'no lane, no cost, when the researcher has turned splitting off');
  assert.match(APP, /classList\.toggle\('gseg-cutlane', joinSplitAllowed\('gloss'\)\);/);
});

test('the ✂ hangs under the wave on all three tabs', () => {
  const tops = STRIPS.match(/sc\.style\.top = \((?:wave|w)\.offsetTop \+ (?:wave|w)\.offsetHeight\) \+ 'px';/g) || [];
  assert.equal(tops.length, 2, 'the Baseline strips and the Cut tab');
  assert.match(CSS, /\.gseg-wavewrap \.gseg-scissors \{ top: 100%; margin-top: 1px; \}/, 'and the Gloss tab');
});

test('the reason each shape was chosen is written where someone would undo it', () => {
  assert.match(CSS, /covers up the\s*\n?\s*baseline textbox/, "Seth's own words, so the bug is recognisable");
  assert.match(CSS, /accidentally\s*\n?\s*split when you meant to scrub/, 'and why the obvious alternative is wrong');
});
