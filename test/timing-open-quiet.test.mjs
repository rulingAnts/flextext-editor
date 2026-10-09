/* OPENING A TEXT WRITES NOTHING, AND NO TIME IS CUT TO FIT THE RECORDING (v717 —
 * plans/time-gaps-and-estimates.md P1, P8, D7, D9, EX4; cases 18 and 19).
 *
 * segment-strips.js reconcile() runs every time the Cut or Baseline tab draws a text. It used to
 * persist() its seed/heal/cover — which stamps `modified`, so merely opening a text with audio read as
 * editing it and queued a duplicate upload — and it clamped every stored time to the DECODED length
 * through syncToLines, so T53 lost 63 ms from its last line on the first render on that device.
 * Here reconcile is lifted from the source and run against the timing skeletons:
 *   · a timed text opens with every span unchanged and nothing saved at all;
 *   · a seed, a heal or a tail cover is saved QUIETLY (persistQuiet, never persist);
 *   · the coverTail guard reads the line's phrase offsets (it read the span's, which never exist);
 *   · a v714-stored doc's estimates are read back in memory, with nothing saved;
 *   · drawing, playing and the dock's marks clip at the recording's end — the data does not. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFixture, DURATION, ft } from './lib/timing-fixtures.mjs';
import { liftAll } from './lib/lift.mjs';
import * as SEG from '../docs/js/segments.js';
import { playEnd, overviewMarks, timeStateClass, timeTipKey, checkedLines } from '../docs/js/segment-strips.js';

const STRIPS = readFileSync(new URL('../docs/js/segment-strips.js', import.meta.url), 'utf8');
const { isAligned, isEstimate, edgeGuessed } = SEG;

/* reconcile(doc, deps) with a peaks cache that says the recording is `D` ms long. */
function opener(D) {
  return new Function('SEG', 'ft', 'D', `
    const { syncToLines, isAligned, settleSpan } = SEG;
    const { readLegacyEstimates } = ft;
    let peaksCache = { docId: 'doc', peaks: null, durationMs: D };
    ${liftAll(STRIPS, ['docSegments', 'peaksDurationFor', 'COVER_TOL_MS', 'coverTail', 'evenSpread', 'reconcile'])}
    return reconcile;
  `)(SEG, ft, D);
}
function open(doc, D) {
  const writes = { quiet: 0, stamped: 0 };
  const deps = {
    getParagraphs: (d) => ft.getBaselineParagraphs(d), getDocId: () => 'doc',
    persist: () => { writes.stamped++; }, persistQuiet: () => { writes.quiet++; },
  };
  opener(D)(doc, deps);
  return writes;
}
const snap = (segs) => JSON.stringify(segs.map((s) => [s.start, s.end, !!s.timePending, s.guess || null]));

test('P1: a timed text opens with every span as the file had it, and NOTHING is saved', () => {
  for (const name of ['elan40', 't53', 't151', 't18', 'l29-13aug', 'l29-damaged', 'e78', 'e19']) {
    const doc = loadFixture(name);
    const before = snap(doc.segments);
    const w = open(doc, DURATION[name]);
    assert.deepEqual(w, { quiet: 0, stamped: 0 }, `${name}: opening writes nothing`);
    assert.equal(snap(doc.segments), before, `${name}: every time and every guessed edge unchanged`);
  }
});

test('case 18 / D9: T53\'s 87 818 ms end survives the render on a device that decodes 87 755 ms', () => {
  const doc = loadFixture('t53');
  open(doc, DURATION.t53);
  assert.equal(doc.segments[doc.segments.length - 1].end, 87818);
  assert.match(liftAll(STRIPS, ['reconcile']), /doc\.segments = syncToLines\(docSegments\(doc\), paras\.length\);/,
    'reconcile no longer hands the decoded length to syncToLines');
});

test('case 19: E19\'s last line is still an estimate after the render (D = 45 990)', () => {
  const doc = loadFixture('e19');
  open(doc, DURATION.e19);
  assert.equal(doc.segments.filter(isEstimate).length, 19);
});

test('a v714-stored doc: its ~ estimates are read back in memory on open, and nothing is saved', () => {
  const doc = loadFixture('e78');
  // As v714 stored it: spans with no per-edge record and no flag (its import ignored the ~).
  doc.segments = doc.segments.map((s) => ({ start: s.start, end: s.end }));
  const w = open(doc, DURATION.e78);
  assert.deepEqual(w, { quiet: 0, stamped: 0 });
  assert.equal(doc.segments.filter(isEstimate).length, 78, 'all 78 dashed again');
  assert.ok(doc.segments.every((s) => s.estSource === 'note'), 'read from the file\'s own ~ notes');
});

test('D7: a fresh one-line recording gets its whole-file span, written QUIETLY', () => {
  const doc = ft.makeDoc({ vernLang: 'fau', analLang: 'id' });
  doc.segments = [];
  const w = open(doc, 12000);
  assert.deepEqual(doc.segments.map((s) => [s.start, s.end, isEstimate(s)]), [[0, 12000, false]]);
  assert.deepEqual(w, { quiet: 1, stamped: 0 }, 'saved, but never stamped modified');
});

test('a pre-transcribed text with no times is seeded as estimates on its INTERIOR edges, quietly', () => {
  const doc = ft.makeDoc({ vernLang: 'fau', analLang: 'id' });
  ft.reconcileBaseline(doc, ['a', 'b', 'c', 'd'], { flatSegments: true });
  doc.segments = [];
  const w = open(doc, 8000);
  assert.deepEqual(doc.segments.map((s) => [s.start, s.end]), [[0, 2000], [2000, 4000], [4000, 6000], [6000, 8000]]);
  assert.deepEqual(doc.segments.map((s) => [edgeGuessed(s, 0), edgeGuessed(s, 1)]),
    [[false, true], [true, true], [true, true], [true, false]], 'C0: 0 and the recording\'s end are not guesses');
  assert.ok(doc.segments.every((s) => s.timeEstimated && s.estSource === 'edit'));
  assert.deepEqual(w, { quiet: 1, stamped: 0 });
  // …and the heal of an all-pending doc is the same, and as quiet
  doc.segments = doc.segments.map(() => ({ timePending: true }));
  assert.deepEqual(open(doc, 8000), { quiet: 1, stamped: 0 });
  assert.equal(doc.segments.filter(isEstimate).length, 4);
});

test('EX4: the tail cover never re-times a line whose phrase carries the file\'s own end offset', () => {
  const doc = loadFixture('elan40');   // ends 125 457 − last end; an ELAN text that stops early on purpose
  const last = doc.segments.length - 1;
  doc.paragraphs[last].segments[0].baseline = '';
  doc.paragraphs[last].segments[0].words = [];
  const end = doc.segments[last].end;
  assert.ok(DURATION.elan40 - end > 1000, 'the fixture leaves more than a second unannotated');
  assert.deepEqual(open(doc, DURATION.elan40), { quiet: 0, stamped: 0 });
  assert.equal(doc.segments[last].end, end, 'the imported alignment is left exactly as it was');
  // Without the file's offset (a line the app made), the cover still reaches the end — quietly.
  delete doc.paragraphs[last].segments[0].attrs['end-time-offset'];
  assert.deepEqual(open(doc, DURATION.elan40), { quiet: 1, stamped: 0 });
  assert.equal(doc.segments[last].end, DURATION.elan40);
});

test('P8: playing, seeking and the dock\'s marks clip at the recording\'s end; the stored time stays', () => {
  const p = { durationMs: () => 87755 };
  assert.equal(playEnd(p, { start: 85000, end: 87818 }), 87755, 'a line past the end stops at the end');
  assert.equal(playEnd(p, { start: 1000, end: 2000 }), 2000, 'every other line is untouched');
  assert.equal(playEnd({ durationMs: () => null }, { start: 85000, end: 87818 }), 87818, 'no length known yet: nothing to clip to');
  assert.equal(playEnd(p, { start: 87760, end: 87818 }), 87760, 'a line wholly past the end plays nothing, rather than backwards');
  assert.deepEqual(overviewMarks([{ start: 0, end: 87800 }, { start: 87800, end: 87818 }], 87755), [87755]);
  assert.deepEqual(overviewMarks([{ start: 0, end: 1000 }, { timePending: true }, { start: 2000, end: 3000 }]), [1000, NaN], 'one entry per seam, NaN kept');
  const draw = STRIPS.slice(STRIPS.indexOf('function drawStrip('), STRIPS.indexOf('/* ---------------- edits: Enter splits'));
  assert.match(draw, /const b1 = Math\.max\(b0 \+ 1, Math\.ceil\(seg\.end \/ mpb\)\);/, 'the strip spans the line\'s own range; buckets past the end draw flat');
  assert.doesNotMatch(draw, /const b1 = Math\.min\(B,/, 'not squeezed into the audio that exists');
});

test('the three states, one set of classes: pending, estimate, check', () => {
  assert.equal(timeStateClass({ timePending: true }), ' seg-pending');
  assert.equal(timeStateClass({ start: 0, end: 1000, guess: [null, 1000] }), ' seg-est');
  assert.equal(timeStateClass({ start: 0, end: 1000, guess: [null, null] }), '', 'explicitly real');
  // A flag no live edge explains was set by an older build (a rollback to v716 and back): an estimate.
  assert.equal(timeStateClass({ start: 0, end: 1000, timeEstimated: true, guess: [null, null] }), ' seg-est', 'an older build\'s flag is still dashed');
  assert.equal(timeStateClass({ start: 0, end: 1000 }, true), ' seg-check');
  assert.equal(timeTipKey({ start: 0, end: 1000, guess: [null, 1000], estSource: 'note' }), 'seg.estTip.note');
  assert.equal(timeTipKey({ start: 0, end: 1000, guess: [null, 1000] }), 'seg.estTip.edit');
  assert.equal(timeTipKey({ start: 0, end: 1000, timeEstimated: true }), 'seg.estTip.legacy');
  assert.equal(timeTipKey({ start: 0, end: 1000 }), null, 'an ordinary line has no tooltip');
  assert.equal(timeTipKey({ start: 0, end: 1000 }, true), 'seg.checkTip');
  const l29 = loadFixture('l29-damaged');
  assert.deepEqual([...checkedLines(l29.segments, ft.getBaselineParagraphs(l29))], [2], 'the damaged L29: line 3 is the one marked');
  for (const name of ['t53', 'elan40', 'l29-13aug', 'e78']) {
    const d = loadFixture(name);
    assert.equal(checkedLines(d.segments, ft.getBaselineParagraphs(d)).size, 0, `${name}: no line marked`);
  }
});

test('every strip surface wears the classes and the tooltips', () => {
  const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
  assert.match(STRIPS, /row\.className = 'seg-strip' \+ timeStateClass\(seg, checks\.has\(i\)\)/, 'Baseline strips');
  assert.match(STRIPS, /row\.className = 'seg-strip cut-row' \+ timeStateClass\(seg, checks\.has\(i\)\)/, 'Cut rows (v714 had none)');
  assert.match(APP, /bar\.className = 'gseg-bar' \+ timeStateClass\(seg, checks\.has\(i\)\);/, 'Gloss bars');
  assert.match(APP, /\+ timeStateClass\(sp, checks\.has\(i\)\)/, 'Segmenter spans');
  assert.doesNotMatch(STRIPS + APP, /seg\.timeEstimated \? ' seg-est'|sp\.timeEstimated \? ' seg-est'/, 'no surface reads the bare flag for its look');
  assert.match(STRIPS, /applyTimeTip\(wave, seg, checks\.has\(i\), deps\.t\);/);
  assert.match(STRIPS, /applyTimeTip\(wave, seg, checks\.has\(i\), cutDeps\.t\);/);
  const CSS = readFileSync(new URL('../docs/css/app.css', import.meta.url), 'utf8');
  assert.match(CSS, /\.seg-strip\.seg-pending \{ border-style: dotted;/, 'pending is dotted');
  assert.match(CSS, /\.seg-strip\.seg-est \{ border-style: dashed;/, 'an estimate is dashed');
  assert.match(CSS, /\.seg-strip\.seg-check \{ box-shadow: inset 4px 0 0 var\(--seg-check\); \}/, 'check is a red bar');
  assert.match(CSS, /@media \(prefers-color-scheme: dark\) \{\n  :root \{ --seg-pend: [^}]*--seg-check:/, 'with dark-mode tokens');
  for (const sel of ['.gseg-bar.seg-pending', '.gseg-bar.seg-est', '.gseg-bar.seg-check', '.mg-span.seg-est', '.mg-span.seg-check']) {
    assert.ok(CSS.includes(sel), sel);
  }
});
