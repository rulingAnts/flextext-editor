/* A SPLIT MUST NEVER WAIT ON A TIER WITH NO CONTROL ON SCREEN (Seth, 2026-09-08).
 *
 * The audio tier is placed with the ✂ under the playhead, and the tickers draw that ✂ only while
 * the playhead is inside the line's own segment. Listing an `audio` tier for a line the playhead is
 * nowhere near therefore asked the user to click something that did not exist: the split stayed
 * pending for ever. Seth met it twice — as a line that would not cut, and as "orange border and
 * cancel button show, but not scissors buttons" on the Gloss tab.
 *
 * What is asserted here is the RULE, not the pixels: reachability gates the tier, and a line whose
 * audio is out of reach completes on the tiers it can actually place. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioTierReachable, splitTiers, splitPlan } from '../docs/js/segments.js';

const SEG = { start: 6500, end: 8000 };

test('the playhead inside the segment makes the audio tier reachable', () => {
  assert.equal(audioTierReachable(SEG, 7000), true);
  assert.equal(audioTierReachable(SEG, 6500), true, 'the exact start counts as inside');
  assert.equal(audioTierReachable(SEG, 8000), true, 'the exact end counts as inside');
});

test('a playhead outside the segment leaves it unreachable', () => {
  assert.equal(audioTierReachable(SEG, 0), false, 'this is the case Seth hit: playhead at 0, line at 6.5s');
  assert.equal(audioTierReachable(SEG, 6499), false);
  assert.equal(audioTierReachable(SEG, 8001), false);
});

test('no audio loaded at all is the strongest case of unreachable', () => {
  assert.equal(audioTierReachable(SEG, null), false);
  assert.equal(audioTierReachable(SEG, undefined), false);
  assert.equal(audioTierReachable(SEG, NaN), false);
});

test('an untimed segment is unreachable however the playhead sits', () => {
  assert.equal(audioTierReachable({ start: 0, end: 0 }, 0), false);
  assert.equal(audioTierReachable({ start: 1, end: 2, timePending: true }, 1.5), false);
  assert.equal(audioTierReachable(null, 100), false);
});

/* THE REGRESSION ITSELF. A gloss line with no translation yet, whose audio is out of reach, must
 * complete on its words alone — that is what makes "split a line you have not translated yet"
 * possible, and what stops the pending split from stranding. */
test('an out-of-reach line completes on the tiers it can place', () => {
  const info = { tab: 'gloss', aligned: audioTierReachable(SEG, 0), words: 2, free: '', text: 'satu dua' };
  const tiers = splitTiers(info);
  assert.deepEqual(tiers, ['words'], 'no audio tier, and no free tier for an empty translation');
  assert.equal(splitPlan(tiers, { words: 1 }).complete, true, 'placing the words tier finishes it');
});

test('the same line with the playhead inside still asks for the audio position', () => {
  const info = { tab: 'gloss', aligned: audioTierReachable(SEG, 7000), words: 2, free: '', text: 'satu dua' };
  assert.deepEqual(splitTiers(info), ['audio', 'words']);
  assert.equal(splitPlan(['audio', 'words'], { words: 1 }).complete, false, 'still pending — the ✂ IS on screen');
  assert.equal(splitPlan(['audio', 'words'], { words: 1, audio: 7000 }).complete, true);
});

test('a translation that exists is still its own tier', () => {
  const info = { tab: 'gloss', aligned: audioTierReachable(SEG, 0), words: 2, free: 'dulu saya', text: 'satu dua' };
  assert.deepEqual(splitTiers(info), ['words', 'free']);
});
