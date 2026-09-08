/* A CUT NEAR A LINE'S EDGE DIVIDES THE SOUND, IT DOES NOT ABANDON IT (Seth, 2026-09-08).
 *
 * boundaryAtPlayhead refuses any position that would leave less than MIN_SEGMENT_MS on one side.
 * For a position the user placed INSIDE the line, within 120ms of one of its ends, that refusal was
 * silent and expensive: the original segment stayed WHOLE, so that line kept all of its sound
 * including the part belonging to the new line, and the new line got none. Nothing on screen said
 * so beyond a dashed row. Seth: "on a long text, that'll really add up."
 *
 * Such a position is now clamped into range and both halves marked timeEstimated. What is NOT
 * clamped — and these are the assertions that keep the fix honest — is a position outside the
 * segment altogether, or a segment too short to hold two viable halves. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundaryAtPlayhead, normalizeSegments, isAligned, MIN_SEGMENT_MS } from '../docs/js/segments.js';

const OPTS = { duration: 10000 };
const LINE = [{ start: 0, end: 5000 }];
const contiguous = (out) => out.every((s, k) => k === 0 || s.start === out[k - 1].end);

test('a cut just after the start divides the sound instead of stranding it', () => {
  const out = boundaryAtPlayhead(LINE, 0, 50, OPTS);
  assert.equal(out.length, 2);
  assert.ok(out.every(isAligned), 'BOTH halves have a real time — this is the whole point');
  assert.ok(!out.some((s) => s.timePending), 'nothing is left pending');
  assert.equal(out[0].end, MIN_SEGMENT_MS, 'nudged to the nearest legal boundary, not to where clicked');
  assert.equal(out[1].start, MIN_SEGMENT_MS);
  assert.ok(contiguous(out), 'and the two halves still meet: no sound is in both, none in neither');
});

test('a cut just before the end likewise', () => {
  const out = boundaryAtPlayhead(LINE, 0, 4950, OPTS);
  assert.equal(out.length, 2);
  assert.ok(out.every(isAligned));
  assert.equal(out[0].end, 5000 - MIN_SEGMENT_MS);
  assert.ok(contiguous(out));
});

test('a nudged boundary says it was nudged, on both sides', () => {
  const out = boundaryAtPlayhead(LINE, 0, 50, OPTS);
  assert.equal(out[0].timeEstimated, true);
  assert.equal(out[1].timeEstimated, true, '⚠ set AFTER the delete that clears the inherited flag');
});

test('an ordinary cut is untouched and claims nothing', () => {
  const out = boundaryAtPlayhead(LINE, 0, 2500, OPTS);
  assert.equal(out[0].end, 2500, 'the exact position, not a nudged one');
  assert.equal(out[1].start, 2500);
  assert.ok(!out[0].timeEstimated && !out[1].timeEstimated, 'nothing was moved, so nothing is flagged');
});

/* ⚠ THE TWO REFUSALS THAT MUST SURVIVE — also asserted in segments-ordering. */
test('a position outside the segment is still refused, never clamped', () => {
  const out = boundaryAtPlayhead(LINE, 0, 999999, OPTS);
  assert.equal(out[1].timePending, true, 'past the media end: clamping that would invent a boundary');
  assert.equal(out[0].end, 5000, 'and the original line is left exactly as it was');
});

test('a segment too short to divide is still refused', () => {
  const tiny = [{ start: 0, end: MIN_SEGMENT_MS + 10 }];
  const out = boundaryAtPlayhead(tiny, 0, MIN_SEGMENT_MS / 2, OPTS);
  assert.equal(out.length, 2);
  assert.equal(out[1].timePending, true, 'below 2 * minMs there is no legal boundary to clamp to');
});

/* The accumulation Seth was worried about: many near-edge cuts down one text must not leave a
 * pile of untimed lines, and must not produce anything normalizeSegments has to repair. */
test('repeated near-edge cuts stay valid and keep every line timed', () => {
  let segs = [{ start: 0, end: 5000 }];
  for (let n = 0; n < 6; n++) segs = boundaryAtPlayhead(segs, segs.length - 1, segs[segs.length - 1].start + 5, OPTS);
  assert.equal(segs.length, 7);
  assert.ok(segs.every(isAligned), 'every line still carries its own time');
  assert.ok(contiguous(segs), 'and they still tile the audio without gap or overlap');
  assert.deepEqual(normalizeSegments(segs, OPTS), segs, 'normalize finds nothing to repair');
});
