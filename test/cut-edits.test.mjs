/* THE CUT TAB'S EDITS KEEP SEGMENTS AND PARAGRAPHS IN LOCKSTEP.
 *
 * The Cut tab (plans/cut-tab.md) shows audio and NO TEXT, which makes it the single most likely
 * place for someone to edit `segments` alone and leave the paragraph count behind.
 *
 * ⚠ WHY THAT WOULD BE SEVERE: segmentation's invariant is line == paragraph == phrase == span,
 * 1:1:1:1 — `segments[i]` IS baseline paragraph i. The moment the two lengths disagree, every
 * index-driven edit on the Baseline and Gloss tabs addresses the WRONG line. That is the v322 field
 * bug ("gloss join collapsed ALL segments on the first line") reached by a new route, and it is
 * SILENT: nothing throws, nothing looks wrong, and a transcriber finds their text on someone else's
 * waveform later. Hence Seth's rule — "every cut edit goes through the same setParagraphs +
 * segments.js pair" — and hence these functions take BOTH arrays and return BOTH, so a caller
 * cannot apply half of one.
 *
 * Run: node test/cut-edits.test.mjs
 */
import { cutAtPlayhead, joinWithPrevious, segmentIndexAt, MIN_SEGMENT_MS } from '../docs/js/segments.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const segs = () => [{ start: 0, end: 1000 }, { start: 1000, end: 2000 }, { start: 2000, end: 3000 }];

console.log('\nsegmentIndexAt finds the span holding the playhead');
{
  ok(segmentIndexAt(segs(), 500) === 0, 'inside the first');
  ok(segmentIndexAt(segs(), 1500) === 1, 'inside the second');
  // Ends are exclusive so a playhead ON a boundary belongs to the span it is STARTING, which is
  // what a listener expects — the audio they are about to hear, not the one just finished.
  ok(segmentIndexAt(segs(), 1000) === 1, 'a boundary belongs to the span it starts');
  ok(segmentIndexAt(segs(), 9999) === -1, 'outside every span → -1');
  ok(segmentIndexAt([{ timePending: true }], 500) === -1, 'a timePending span has no time to be inside');
  ok(segmentIndexAt(segs(), null) === -1, 'and a null playhead is not a position');
}

console.log('\nCUT adds one segment AND one paragraph — the assertion that matters');
{
  const paras = ['one', '', 'three'];
  const r = cutAtPlayhead(segs(), paras, 1500);
  ok(r.ok === true, 'the cut is accepted');
  ok(r.segments.length === 4, 'four segments');
  /* ⚠ THE LOCKSTEP. A text-free UI editing only `segments` is the exact failure this guards, and it
   * would pass any test that looked only at segment times. */
  ok(r.paragraphs.length === 4, '...and four paragraphs');
  ok(r.paragraphs[2] === '', 'the new span starts empty');
  ok(r.paragraphs[0] === 'one' && r.paragraphs[3] === 'three',
     'and no other paragraph moved or changed');
  ok(r.segments[1].end === 1500 && r.segments[2].start === 1500, 'the boundary is at the playhead');
}

console.log('\n...and it does not mutate its inputs');
{
  const s = segs(); const p = ['a', 'b', 'c'];
  cutAtPlayhead(s, p, 1500);
  ok(s.length === 3 && p.length === 3, 'caller state is untouched until it assigns the result');
}

console.log('\nCUT refuses rather than degrading');
{
  const paras = ['one', 'two', 'three'];
  /* ⚠ A SPLIT OF A TEXTED SEGMENT IS ALWAYS REFUSED (Seth). There is no cursor on the Cut tab, so
   * there is no defined place to divide the text; any rule invented here would silently put half a
   * sentence in the wrong span. */
  const t = cutAtPlayhead(segs(), paras, 1500);
  ok(t.ok === false && t.reason === 'hasText', 'a segment with text cannot be split here');
  ok(t.paragraphs.length === 3 && t.segments.length === 3, '...and nothing changed');

  ok(cutAtPlayhead(segs(), ['', '', ''], 9999).reason === 'outside', 'a playhead outside every span');
  /* splitSegment would hand back a timePending half here. On this tab the cut IS the time, so a cut
   * with no time is nothing — refusing is the honest answer, and it is why cutAtPlayhead pre-checks
   * instead of delegating the decision. */
  const near = cutAtPlayhead(segs(), ['', '', ''], 1000 + Math.floor(MIN_SEGMENT_MS / 2));
  ok(near.ok === false && near.reason === 'tooShort', 'a cut too near a boundary is refused, not made timePending');
  ok(!near.segments.some((s) => s.timePending), '...and no untimed segment is left behind');
}

console.log('\nJOIN merges both, concatenates the text, and reports the join point');
{
  const r = joinWithPrevious(segs(), ['satu', 'dua', 'tiga'], 1);
  ok(r.ok === true, 'the join is accepted');
  ok(r.segments.length === 2 && r.paragraphs.length === 2, 'both drop by one, together');
  /* ⚠ THE GLUE SPACE. Without it "…akhir" + "Mulai…" mashes into one orthographic word — data
   * corruption from the transcriber's point of view, and invisible in a segment-count test. */
  ok(r.paragraphs[0] === 'satu dua', `the texts join with a space: "${r.paragraphs[0]}"`);
  ok(r.paragraphs[1] === 'tiga', 'and the untouched paragraph follows');
  // Seth: "moves the playhead back to the point where they joined."
  ok(r.playheadMs === 1000, 'the join point is reported so the caller can move the playhead there');
  ok(r.segments[0].start === 0 && r.segments[0].end === 2000, 'the merged span covers both');
}

console.log('\n...and the glue is applied only when it is needed');
{
  const empty = joinWithPrevious(segs(), ['satu', '', 'tiga'], 1);
  ok(empty.paragraphs[0] === 'satu', 'no trailing space when the other side is empty (a silence span)');
  const spaced = joinWithPrevious(segs(), ['satu ', 'dua', 'tiga'], 1);
  ok(spaced.paragraphs[0] === 'satu dua', 'and no double space when a boundary space already exists');
}

console.log('\nJOIN respects the researcher gate, and the first span has nothing before it');
{
  ok(joinWithPrevious(segs(), ['a', 'b', 'c'], 0).reason === 'first', 'joining the first span is a no-op');
  /* cutJoinTexted: joining is SAFE, but a researcher may still forbid it so segmentation cannot be
   * reshaped once transcription has started. Default (absent) ALLOWS it — only an explicit false
   * refuses, so the safe operation stays available unless someone deliberately turns it off. */
  const gated = joinWithPrevious(segs(), ['satu', 'dua', 'tiga'], 1, { allowTexted: false });
  ok(gated.ok === false && gated.reason === 'hasText', 'allowTexted:false refuses a texted join');
  const allowed = joinWithPrevious(segs(), ['satu', 'dua', 'tiga'], 1, {});
  ok(allowed.ok === true, '...and the default allows it');
  const blank = joinWithPrevious(segs(), ['', '', ''], 1, { allowTexted: false });
  ok(blank.ok === true, 'the gate only bites when there IS text — blank spans always join');
}

console.log('\nan unaligned neighbour still joins, but reports no join point');
{
  const s = [{ timePending: true }, { start: 1000, end: 2000 }];
  const r = joinWithPrevious(s, ['', ''], 1);
  ok(r.ok === true, 'the join happens');
  ok(r.playheadMs === null, '...and the playhead is left alone rather than sent to an invented time');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
