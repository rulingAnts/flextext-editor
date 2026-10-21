/* Crossing-prevention for time-aligned segments — the riskiest part of the segmentation feature.
 *
 * WHY THIS TEST EXISTS AND WHY IT IS FIRST: a crossing or overlapping segment is not a cosmetic
 * bug. Aligned annotations in an ELAN tier MUST be ordered and non-overlapping, so a crossing
 * segment cannot be exported to EAF at all — the user would only discover it when their export
 * failed, long after the transcription work was done. And the inputs that cause it are ordinary
 * field behaviour: scrubbing backwards, typing several lines without touching the player, inserting
 * a break into already-segmented text.
 *
 * The invariant checker below is applied to the output of EVERY operation, so no individual test
 * has to remember what "valid" means.
 *
 * Run: node test/segments-ordering.test.mjs
 */
import {
  MIN_SEGMENT_MS, normalizeSegments, boundaryAtPlayhead, mergeSegments, splitSegment, syncToLines,
  isAligned,
} from '../docs/js/segments.js';

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

/** The whole contract in one place. Returns a list of violations (empty === valid). */
function violations(segs, { duration = null } = {}) {
  const bad = [];
  let prevEnd = null;
  segs.forEach((s, i) => {
    if (!isAligned(s)) {
      // An unaligned segment is always acceptable — but it must be honestly marked, not half-timed.
      if (!s.timePending) bad.push(`#${i} is not aligned but not marked timePending`);
      return;
    }
    if (s.end - s.start < MIN_SEGMENT_MS) bad.push(`#${i} shorter than MIN_SEGMENT_MS`);
    if (s.start < 0) bad.push(`#${i} starts before zero`);
    if (duration !== null && s.end > duration) bad.push(`#${i} ends past the media duration`);
    if (prevEnd !== null && s.start < prevEnd) bad.push(`#${i} overlaps the previous segment`);
    prevEnd = s.end;
  });
  return bad;
}
const valid = (segs, opts) => violations(segs, opts).length === 0;
const why = (segs, opts) => violations(segs, opts).join('; ') || '(valid)';

const DUR = 10000;
const opts = { duration: DUR };

console.log('\nthe adversarial cases that motivated this module');
{
  // 1. Playhead BEFORE the current segment's start (user scrubbed backwards, then pressed Enter).
  const segs = [{ start: 4000, end: 8000 }];
  const out = boundaryAtPlayhead(segs, 0, 1000, opts);
  ok(valid(out, opts), `backward playhead produces no crossing — ${why(out, opts)}`);
  ok(out.length === 2, 'the line break still happened (text is never sacrificed to timing)');
  ok(out[1].timePending === true, 'the new segment is honestly marked pending, not given a fake time');
  ok(out[0].start === 4000 && out[0].end === 8000, 'the existing alignment was left untouched');
}
{
  // 2. Several lines created without moving the playhead — the classic fast-typist case.
  let segs = [{ start: 0, end: 5000 }];
  for (let i = 0; i < 5; i++) segs = boundaryAtPlayhead(segs, segs.length - 1, 2500, opts);
  ok(valid(segs, opts), `repeated Enter at one fixed playhead stays valid — ${why(segs, opts)}`);
  ok(segs.length === 6, 'every keystroke still produced a line');
}
{
  // 3. Break inserted in the MIDDLE of already-segmented text.
  const segs = [{ start: 0, end: 2000 }, { start: 2000, end: 4000 }, { start: 4000, end: 6000 }];
  const out = boundaryAtPlayhead(segs, 1, 3000, opts);
  ok(valid(out, opts), `mid-text insert stays ordered — ${why(out, opts)}`);
  ok(out.length === 4, 'one more segment than before');
  ok(out[1].end === 3000 && out[2].start === 3000, 'the split used the exact playhead');
  ok(out[0].end === 2000 && out[3].start === 4000, 'neighbouring segments were not disturbed');
}
{
  // 4. Playhead past the end of the media.
  const out = boundaryAtPlayhead([{ start: 0, end: 5000 }], 0, 999999, opts);
  ok(valid(out, opts), `playhead past media end stays valid — ${why(out, opts)}`);
  ok(out[1].timePending === true, 'out-of-range playhead yields a pending segment, not a clamp-fudge');
}
{
  // 5. A boundary with no ROOM (segment barely longer than the minimum).
  const tiny = [{ start: 0, end: MIN_SEGMENT_MS + 10 }];
  const out = boundaryAtPlayhead(tiny, 0, MIN_SEGMENT_MS / 2, opts);
  ok(valid(out, opts), `no-room split stays valid — ${why(out, opts)}`);
  ok(out.length === 2 && out[1].timePending === true, 'refuses to create a sub-minimum segment');
}

console.log('\nnormalizeSegments repairs hostile input without reordering');
{
  const overlapping = [{ start: 0, end: 5000 }, { start: 1000, end: 6000 }, { start: 2000, end: 7000 }];
  const out = normalizeSegments(overlapping, opts);
  ok(valid(out, opts), `overlaps resolved — ${why(out, opts)}`);
  ok(out.length === 3, 'no segment was dropped');
  ok(out[0].start === 0, 'the first segment kept its start (order is text-owned, never sorted)');
}
{
  const backwards = [{ start: 8000, end: 9000 }, { start: 1000, end: 2000 }];
  const out = normalizeSegments(backwards, opts);
  ok(valid(out, opts), `a segment timed BEFORE its predecessor is resolved — ${why(out, opts)}`);
  ok(out.length === 2, 'still two rows — the text order was NOT rearranged to fix the times');
  ok(!isAligned(out[1]) || out[1].start >= out[0].end, 'the later row is either pending or pushed after');
}
{
  const out = normalizeSegments([{ start: -500, end: 3000 }, { start: 8000, end: 99999 }], opts);
  ok(valid(out, opts), `out-of-range ends are clamped — ${why(out, opts)}`);
  ok(out[0].start === 0, 'negative start pinned to zero');
  ok(out[1].end === DUR, 'end past the media pinned to the duration');
}
{
  const out = normalizeSegments([{ start: 100, end: 150 }], opts);
  ok(out[0].timePending === true, 'a sub-minimum span is demoted to pending rather than kept');
}
{
  // Garbage in must not throw — this runs after every edit, so it must be total.
  const out = normalizeSegments([null, undefined, {}, { start: 'x', end: 5 }, { start: 0, end: 900 }], opts);
  ok(valid(out, opts), `garbage input yields a valid array — ${why(out, opts)}`);
  ok(out.length === 5, 'length preserved (segments stay bound to their lines)');
}

console.log('\nmerge — one operation, used by both the baseline and gloss tabs');
{
  const segs = [{ start: 0, end: 2000 }, { start: 2000, end: 5000 }, { start: 5000, end: 6000 }];
  const out = mergeSegments(segs, 0, opts);
  ok(valid(out, opts), `merge stays valid — ${why(out, opts)}`);
  ok(out.length === 2, 'two segments became one');
  ok(out[0].start === 0 && out[0].end === 5000, 'the merged span runs prev.start → next.end');
}
{
  const out = mergeSegments([{ start: 0, end: 2000 }, { timePending: true }], 0, opts);
  ok(isAligned(out[0]) && out[0].end === 2000, 'merging with a pending neighbour KEEPS the known time');
}
{
  const out = mergeSegments([{ timePending: true }, { timePending: true }], 0, opts);
  ok(out.length === 1 && out[0].timePending === true, 'two pending segments merge to one pending');
}
{
  const out = mergeSegments([{ start: 0, end: 2000, timeEstimated: true }, { start: 2000, end: 4000 }], 0, opts);
  ok(out[0].timeEstimated === true, 'an estimated half taints the merge (no false confidence)');
}
{
  const segs = [{ start: 0, end: 2000 }];
  ok(mergeSegments(segs, 0, opts).length === 1, 'merging the last segment is a no-op, not a crash');
  ok(mergeSegments(segs, -1, opts).length === 1, 'a negative index is a no-op, not a crash');
}

console.log('\nsplit — real playhead preferred, interpolation labelled');
{
  const out = splitSegment([{ start: 0, end: 4000 }], 0, { ...opts, playheadMs: 2500, fraction: 0.5 });
  ok(valid(out, opts), `split at the playhead stays valid — ${why(out, opts)}`);
  ok(out[0].end === 2500 && out[1].start === 2500, 'the REAL playhead wins over the interpolation');
  ok(!out[0].timeEstimated && !out[1].timeEstimated, 'a user-chosen boundary is not marked estimated');
}
{
  const out = splitSegment([{ start: 0, end: 4000 }], 0, { ...opts, fraction: 0.25 });
  ok(valid(out, opts), `interpolated split stays valid — ${why(out, opts)}`);
  ok(out[0].end === 1000, 'interpolated at the requested fraction');
  ok(out[0].timeEstimated === true && out[1].timeEstimated === true, 'BOTH halves marked estimated');
}
{
  // Playhead outside the segment must fall back to interpolation, not be used blindly.
  const out = splitSegment([{ start: 5000, end: 9000 }], 0, { ...opts, playheadMs: 100, fraction: 0.5 });
  ok(valid(out, opts), `outside playhead falls back safely — ${why(out, opts)}`);
  ok(out[0].end === 7000 && out[0].timeEstimated === true, 'interpolated instead of using a bad playhead');
}
{
  const out = splitSegment([{ start: 0, end: 4000 }], 0, { ...opts, fraction: 0 });
  ok(valid(out, opts), `fraction 0 cannot create a zero-length half — ${why(out, opts)}`);
  const out1 = splitSegment([{ start: 0, end: 4000 }], 0, { ...opts, fraction: 1 });
  ok(valid(out1, opts), `fraction 1 cannot create a zero-length half — ${why(out1, opts)}`);
}
{
  const out = splitSegment([{ timePending: true }], 0, { ...opts, fraction: 0.5 });
  ok(out.length === 2 && out.every((s) => s.timePending), 'splitting a pending segment yields pending halves');
}

console.log('\nsyncToLines — the text is authoritative');
{
  const out = syncToLines([{ start: 0, end: 2000 }], 4, opts);
  ok(out.length === 4, 'grew to match the line count');
  ok(out.slice(1).every((s) => s.timePending), 'new rows are pending, never given invented times');
  ok(isAligned(out[0]), 'the existing alignment survived');
}
{
  const segs = [{ start: 0, end: 1000 }, { start: 1000, end: 2000 }, { start: 2000, end: 3000 }];
  const out = syncToLines(segs, 1, opts);
  ok(out.length === 1 && out[0].end === 1000, 'shrank from the END (trailing lines were removed)');
}
{
  ok(syncToLines([], 0, opts).length === 0, 'empty stays empty');
  ok(syncToLines(null, 3, opts).length === 3, 'null input is tolerated');
}

console.log('\nEMPTY SEGMENTS — a timed span with no text is a first-class citizen');
{
  // Seth's workflow: Enter, let the playhead run, Enter again. The middle segment has real time and
  // no text. Nothing in this module should care that the text is empty — proving the model supports
  // it before the UI work depends on it.
  let segs = [{ start: 0, end: 2000 }];
  segs = boundaryAtPlayhead(segs, 0, 1000, opts);   // split → two segments
  segs = syncToLines(segs, 3, opts);                 // a third (empty) line appears
  ok(valid(segs, opts), `empty-segment flow stays valid — ${why(segs, opts)}`);
  ok(segs.length === 3, 'three lines, three segments');
  ok(isAligned(segs[0]) && isAligned(segs[1]), 'the timed segments kept their alignment');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASS: segments cannot cross, and time is never invented.\n');
process.exit(fail ? 1 : 0);
