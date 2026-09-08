/* WHY THE TWO TABS DIFFER ABOUT THE AUDIO TIER — and why making them "consistent" broke things.
 *
 * The audio side of a split is placed with the ✂ under the playhead, and the tickers draw that ✂
 * only while the playhead is inside the line's own segment. Listing an `audio` tier for a line the
 * playhead is nowhere near therefore asks for a click on something not on screen, and the split
 * stays pending for ever. On the GLOSS tab the cure is to drop the tier, because glossSplitAt hands
 * splitSegment a `fraction` and the sound is still divided.
 *
 * ⚠ ON BASELINE THE SAME CURE LOSES AUDIO. splitLineAt has no fraction: a null position goes to
 * boundaryAtPlayhead, which splices in `{ timePending: true }`. v625 did it anyway and Seth hit it
 * within the hour — text split, audio did not, the new line came out untimed. v626 reverted the
 * Baseline half. These tests pin BOTH halves, including the mechanism that makes them differ, so
 * the revert cannot be quietly undone by someone tidying up the asymmetry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { audioTierReachable, splitTiers, splitPlan, boundaryAtPlayhead, splitSegment, isAligned } from '../docs/js/segments.js';

const SEG = { start: 6500, end: 8000 };

test('reachability: inside the segment, outside it, and no audio at all', () => {
  assert.equal(audioTierReachable(SEG, 7000), true);
  assert.equal(audioTierReachable(SEG, 6500), true, 'the exact start counts as inside');
  assert.equal(audioTierReachable(SEG, 8000), true, 'the exact end counts as inside');
  assert.equal(audioTierReachable(SEG, 0), false, 'playhead at 0, line at 6.5s');
  assert.equal(audioTierReachable(SEG, null), false, 'no audio loaded is the strongest unreachable');
  assert.equal(audioTierReachable({ start: 1, end: 2, timePending: true }, 1.5), false, 'untimed');
  assert.equal(audioTierReachable(null, 100), false);
});

test('Gloss: an out-of-reach line completes on the tiers it can place', () => {
  const tiers = splitTiers({ tab: 'gloss', aligned: audioTierReachable(SEG, 0), words: 2, free: '' });
  assert.deepEqual(tiers, ['words'], 'no audio tier, and no free tier for an empty translation');
  assert.equal(splitPlan(tiers, { words: 1 }).complete, true);
});

/* ⚠ THE REASON THAT IS SAFE ON GLOSS: splitSegment still divides the sound from the fraction. */
test('Gloss: a null playhead still splits the audio, by fraction', () => {
  const out = splitSegment([{ start: 0, end: 1000 }], 0, { playheadMs: null, fraction: 0.5 });
  assert.equal(out.length, 2, 'two segments, not one plus a pending');
  assert.ok(out.every((s) => isAligned(s)), 'BOTH halves carry a real time');
  assert.ok(!out.some((s) => s.timePending), 'nothing is left pending');
});

/* ⚠ AND THE REASON IT IS NOT SAFE ON BASELINE: there is no fraction to fall back to. */
test('Baseline: a null playhead leaves the new line untimed — this is the regression', () => {
  const out = boundaryAtPlayhead([{ start: 0, end: 1000 }], 0, null, {});
  assert.equal(out.length, 2);
  assert.ok(out.some((s) => s.timePending),
    'a pending segment is spliced in: the text divides and the SOUND DOES NOT');
});

test('Baseline therefore still requires the audio tier whenever the line has a time', () => {
  const STRIPS = readFileSync(new URL('../docs/js/segment-strips.js', import.meta.url), 'utf8');
  const info = STRIPS.slice(STRIPS.indexOf('function stripsInfo(i)'), STRIPS.indexOf('function stripsInfo(i)') + 900);
  assert.match(info, /aligned: isAligned\(docSegments\(doc\)\[i\]\)/,
    'stripsInfo uses isAligned, NOT audioTierReachable');
  assert.doesNotMatch(STRIPS, /audioTierReachable/,
    'the reachability test must not reach the Baseline tab until splitLineAt can interpolate');
  // and the tier really is required, so the split waits rather than committing without it
  const tiers = splitTiers({ tab: 'baseline', aligned: true, text: 'dea a bujo' });
  assert.deepEqual(tiers, ['audio', 'text']);
  assert.equal(splitPlan(tiers, { text: 4 }).complete, false, 'it waits for the audio position');
});
