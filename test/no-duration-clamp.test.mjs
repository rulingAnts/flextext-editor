/* A STORED TIME IS NEVER CUT TO FIT THE DECODED LENGTH (v717 — plans/time-gaps-and-estimates.md D9,
 * P8, cases 18 and 19).
 *
 * Decoders disagree: T53's m4a decodes to 87 755 ms on a device, 63 ms shorter than the 87 818 ms its
 * last line ends at in the file. normalizeSegments clamped every end to the decoded length, and every
 * operation runs normalizeSegments — so the first edit anywhere in the text shortened its last line
 * for good, on that device only, and the next export wrote the shortened time as fact. Drawing and
 * playback clip at use instead (segment-strips); the timing banner speaks up only past 350 ms. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture, DURATION, ft } from './lib/timing-fixtures.mjs';
import {
  normalizeSegments, boundaryAtPlayhead, splitSegment, mergeSegments, syncToLines, moveBoundary, applyGuessedSplitsWithin,
  segmentsFollowLines, timingReport, TIMING_PAST_END_MS, isAligned,
} from '../docs/js/segments.js';

const D = DURATION.t53;

test('case 18: T53\'s 87 818 ms end survives a split, a join, a drag and a resync anywhere', () => {
  const segs = loadFixture('t53').segments;
  const last = (s) => s[s.length - 1].end;
  assert.equal(last(segs), 87818);
  assert.ok(last(segs) > D, 'the recording decodes shorter than the text says');
  const opts = { duration: D };
  for (let i = 0; i < segs.length; i += 7) {
    if (!isAligned(segs[i])) continue;
    const mid = Math.round((segs[i].start + segs[i].end) / 2);
    assert.equal(last(boundaryAtPlayhead(segs, i, mid, opts)), 87818, `split of line ${i} at the playhead`);
    assert.equal(last(splitSegment(segs, i, { ...opts, fraction: 0.5 })), 87818, `split of line ${i} by fraction`);
    if (i + 1 < segs.length) assert.equal(last(mergeSegments(segs, i, opts)), 87818, `join of lines ${i} and ${i + 1}`);
  }
  assert.equal(last(normalizeSegments(segs, opts)), 87818);
  assert.equal(last(syncToLines(segs, segs.length, opts)), 87818);
  assert.equal(last(moveBoundary(segs, 10, segs[10].end + 50).segments), 87818);
  assert.equal(last(segmentsFollowLines(segs, segs.map((_, k) => ({ kind: 'kept', from: k })), opts)), 87818);
  assert.equal(last(mergeSegments(segs, segs.length - 2, opts)), 87818, 'joining INTO the last line keeps its end too');
  const blankLast = applyGuessedSplitsWithin(segs, segs.map(() => ''), segs.length - 1, [segs[segs.length - 1].start + 400], opts);
  if (blankLast.ok) assert.equal(last(blankLast.segments), 87818);
});

test('the export writes the stored end, not the decoded one', () => {
  const doc = loadFixture('t53');
  doc.segments = boundaryAtPlayhead(doc.segments, 0, 1000, { duration: D });
  doc.paragraphs.splice(1, 0, { guid: 'x', segments: [ft.makeSegment('', [])] });
  const xml = ft.serializeFlextext(doc, { vernLang: 'fau', analLang: 'id' });
  assert.match(xml, /end-time-offset="87818"/);
});

test('pastEnd is raised only beyond 350 ms past the recording', () => {
  const t53 = loadFixture('t53');
  const texts = ft.getBaselineParagraphs(t53);
  assert.ok(!timingReport(t53.segments, texts, { durationMs: D }).items.some((it) => it.kind === 'pastEnd'), 'T53: 63 ms over is decoder spread, not a wrong recording');
  const over = t53.segments.map((s) => ({ ...s }));
  over[over.length - 1].end = D + TIMING_PAST_END_MS + 1;
  const r = timingReport(over, texts, { durationMs: D });
  const item = r.items.find((it) => it.kind === 'pastEnd');
  assert.ok(item && item.ms === TIMING_PAST_END_MS + 1 && r.level === 'red', '351 ms over: "is this the right recording?"');
  over[over.length - 1].end = D + TIMING_PAST_END_MS;
  assert.ok(!timingReport(over, texts, { durationMs: D }).items.some((it) => it.kind === 'pastEnd'), 'exactly 350 ms over: not yet');
});
