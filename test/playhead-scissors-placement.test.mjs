/* Seth, 2026-09-08, on an Android screen: "the scissors icon underneath the play head covers up the
 * baseline textbox so you can't see what you're typing."
 *
 * The ✂ that rides the playhead is 30px and was anchored by its TOP to the waveform's bottom edge, so
 * it hung 28px BELOW the wave — directly over `.seg-text`, the box being typed into.
 *
 * MEASURED in the pane at the mobile preset (375×812), strip 1 of a four-line text:
 *     wave      358 → 402   (44px)
 *     text box  404 → 444   (40px)
 *     OLD ✂     400 → 430   → 26px of a 40px text box covered — about two thirds of it
 *     NEW ✂     370 → 400   → 0px over the text box, fully inside the wave
 *
 * The fix anchors the BOTTOM of the button to the wave's lower edge instead, which is what the
 * Paragraph Analysis Tool has always done (`.pa-wavewrap .pa-rowcut` is centred on its wave). The
 * strips were the odd ones out, in both tickers.
 *
 * Run: node --test test/playhead-scissors-placement.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const STRIPS = rd('../docs/js/segment-strips.js'), CSS = rd('../docs/css/app.css');

test('the playhead ✂ is anchored by its bottom, so it sits inside the wave', () => {
  assert.match(CSS, /\.cut-scissors\.on-wave \{ transform: translate\(-50%, -100%\); \}/,
    'the modifier exists and flips the anchor from top to bottom');
  // and the base rule is untouched, so the Cut tab's own uses are unaffected unless they opt in
  assert.match(CSS, /\.cut-scissors \{\s*\n\s*position: absolute; transform: translate\(-50%, -2px\);/,
    'the base placement is left alone — only the opted-in instances move');
});

test('both tickers opt in, and both place it 2px inside the wave', () => {
  const uses = STRIPS.match(/sc\.className = 'cut-scissors on-wave'/g) || [];
  assert.equal(uses.length, 2, 'the Baseline strips and the Cut tab — the two places that build one');
  const tops = STRIPS.match(/sc\.style\.top = \((?:wave|w)\.offsetTop \+ (?:wave|w)\.offsetHeight - 2\) \+ 'px';/g) || [];
  assert.equal(tops.length, 2, 'both anchor to the wave bottom less a 2px inset');
  // the old geometry must not survive anywhere: it is what covered the text
  assert.doesNotMatch(STRIPS, /style\.top = \((?:wave|w)\.offsetTop \+ (?:wave|w)\.offsetHeight\) \+ 'px'/,
    'no placement still hangs the button below the wave');
});

test('the reason and the measurement are written where someone would undo it', () => {
  assert.match(CSS, /covers up the baseline textbox/, "Seth's own words, so the bug is recognisable");
  assert.match(CSS, /pa-rowcut/, 'and the tool is cited as the precedent that was already right');
});
