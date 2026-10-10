/* TEXT AND TIMES MOVE TOGETHER IN THE PLAIN TEXT BOX (v717 — plans/time-gaps-and-estimates.md D10,
 * cases 1 and 8; the 2026-08-16 lesson).
 *
 * The classic text box edits TEXT only. After it, syncToLines used to pair the new lines with the old
 * times BY POSITION — insert one line after line 6 and every later line played the line before it,
 * and the next export wrote that as fact. That is the exact shape of the 2026-08-16 corruption (53
 * lines with 23 blanks became 30 lines paired against the first 30 spans). Now the reconcile says
 * where each new line came from (reconcileBaselineWithOrigins) and the times follow those origins
 * (segmentsFollowLines): a line keeps its own time wherever it moves, a new line gets none, and
 * nothing pairs across a line that did not change.
 *
 * This is the engine half; app.js applyBaseline calls exactly these two, in this order. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture, ft } from './lib/timing-fixtures.mjs';
import { segmentsFollowLines, isAligned, isEstimate, edgeGuessed } from '../docs/js/segments.js';

const { reconcileBaseline, reconcileBaselineWithOrigins, getBaselineParagraphs, makeDoc, serializeFlextext } = ft;

/* What applyBaseline does for a doc that carries time: the box's lines in, both arrays out together. */
function applyText(doc, lines, opts = {}) {
  const old = doc.segments;
  const origins = reconcileBaselineWithOrigins(doc, lines, opts);
  doc.segments = segmentsFollowLines(old, origins);
  return origins;
}
// Each line's identity (its phrase guid) with its time, in order.
const timed = (doc) => doc.paragraphs.map((p, i) => [p.segments.map((s) => s.attrs && s.attrs.guid).join('+'), doc.segments[i] && isAligned(doc.segments[i]) ? [doc.segments[i].start, doc.segments[i].end] : null]);

test('case 1: ELAN40, a line inserted after line 6 — all 40 original lines keep their own times', () => {
  const doc = loadFixture('elan40');
  const before = timed(doc);
  const lines = getBaselineParagraphs(doc);
  lines.splice(6, 0, 'a new line typed here');
  const origins = applyText(doc, lines);
  assert.equal(doc.paragraphs.length, 41);
  assert.equal(doc.segments.length, 41, 'one span per line, together');
  assert.deepEqual(origins[6], { kind: 'new' });
  assert.equal(doc.segments[6].timePending, true, 'the new line has no time — never a neighbour\'s');
  const after = timed(doc).filter((_, k) => k !== 6);
  assert.deepEqual(after, before, 'every original line: the same phrase, the same start and end');
});

test('the 2026-08-16 replay: T53 (53 lines, 23 blank) through the text box', () => {
  const fresh = () => loadFixture('t53');
  const t53 = fresh();
  const before = timed(t53);
  assert.equal(getBaselineParagraphs(t53).filter((t) => !t).length, 23, 'the fixture has its 23 blank lines');

  // (a) Unchanged text in, unchanged doc out — every line kept as the same object.
  const same = fresh();
  const o = applyText(same, getBaselineParagraphs(same));
  assert.ok(o.every((x) => x.kind === 'kept'));
  assert.deepEqual(timed(same), before);

  // (b) A line inserted near the top keeps every LATER line's time.
  const ins = fresh();
  const lines = getBaselineParagraphs(ins);
  lines.splice(3, 0, 'one more line');
  applyText(ins, lines);
  assert.equal(ins.segments.length, 54);
  assert.deepEqual(timed(ins).filter((_, k) => k !== 3), before, 'all 53 lines keep their times; the new one is untimed');
  assert.equal(ins.segments[53].end, 87818, 'and the recording still ends where it did');

  // (c) The original failure: the blank lines filtered out of the box. Each worded line keeps ITS time.
  const filt = fresh();
  applyText(filt, getBaselineParagraphs(filt).filter(Boolean));
  assert.equal(filt.paragraphs.length, 30);
  assert.deepEqual(timed(filt), before.filter((_, k) => getBaselineParagraphs(fresh())[k]), 'no line slides onto another line\'s audio');
});

test('case 8: an insertion and a typo fix in one edit — "c x" keeps c d\'s guid, translation and time', () => {
  const doc = makeDoc({ vernLang: 'fau', analLang: 'id' });
  reconcileBaseline(doc, ['a b', 'c d', 'e f'], { flatSegments: true });
  doc.paragraphs[1].segments[0].free = 'translation of c d';
  doc.paragraphs[1].segments[0].attrs['begin-time-offset'] = '2000';
  doc.paragraphs[1].segments[0].attrs['end-time-offset'] = '4000';
  doc.segments = [{ start: 0, end: 2000 }, { start: 2000, end: 4000 }, { start: 4000, end: 6000 }];
  const guidCD = doc.paragraphs[1].segments[0].attrs.guid;
  const origins = applyText(doc, ['a b', 'NEW LINE', 'c x', 'e f']);
  assert.deepEqual(origins.map((x) => x.kind), ['kept', 'new', 'edit', 'kept']);
  const [, fresh, cx] = doc.paragraphs.map((p) => p.segments[0]);
  assert.equal(cx.attrs.guid, guidCD);
  assert.equal(cx.free, 'translation of c d');
  assert.deepEqual([doc.segments[2].start, doc.segments[2].end], [2000, 4000]);
  assert.notEqual(fresh.attrs.guid, guidCD);
  assert.equal(fresh.free, '');
  assert.ok(!('begin-time-offset' in fresh.attrs), 'NEW LINE inherits no offsets');
  assert.equal(doc.segments[1].timePending, true);
});

test('delete line 2 and add a line at line 30: nothing crosses the document', () => {
  const doc = loadFixture('elan40');
  doc.paragraphs[1].segments[0].free = 'line two\'s translation';
  const gone = doc.paragraphs[1].segments[0].attrs.guid;
  const before = timed(doc);
  const lines = getBaselineParagraphs(doc);
  lines.splice(1, 1);
  lines.splice(29, 0, 'typed in later');
  const origins = applyText(doc, lines);
  assert.deepEqual(origins[29], { kind: 'new' });
  const added = doc.paragraphs[29].segments[0];
  assert.notEqual(added.attrs.guid, gone);
  assert.equal(added.free, '');
  assert.ok(!('begin-time-offset' in added.attrs));
  assert.equal(doc.segments[29].timePending, true);
  assert.deepEqual(timed(doc).filter((_, k) => k !== 29), before.filter((_, k) => k !== 1), 'every other line keeps its own time');
  assert.ok(!serializeFlextext(doc, { vernLang: 'fau', analLang: 'id' }).includes('line two\'s translation'), 'and the deleted line\'s translation is gone, not moved');
});

test('joins and splits are recognised, and the times follow them', () => {
  const base = () => {
    const doc = makeDoc({ vernLang: 'fau', analLang: 'id' });
    reconcileBaseline(doc, ['a b', 'c d e f', 'g h'], { flatSegments: true });
    doc.segments = [{ start: 0, end: 2000 }, { start: 2000, end: 6000 }, { start: 6000, end: 8000 }];
    return doc;
  };
  const j = base();
  const oj = applyText(j, ['a b c d e f', 'g h'], { flatSegments: true });
  assert.deepEqual(oj[0], { kind: 'join', from: [0, 1] });
  assert.deepEqual([j.segments[0].start, j.segments[0].end, isEstimate(j.segments[0])], [0, 6000, false], 'a join spans both lines; its inner seam is gone');

  const s = base();
  const os = applyText(s, ['a b', 'c', 'd e f', 'g h'], { flatSegments: true });
  assert.deepEqual(os.slice(1, 3), [{ kind: 'split', from: 1, frac: [0, 0.25] }, { kind: 'split', from: 1, frac: [0.25, 1] }]);
  assert.deepEqual(s.segments.slice(1, 3).map((x) => [x.start, x.end]), [[2000, 3000], [3000, 6000]], 'split by word fraction');
  assert.deepEqual(s.segments.slice(1, 3).map((x) => [edgeGuessed(x, 0), edgeGuessed(x, 1)]), [[false, true], [true, false]],
    'the interpolated seam is a guess; the line\'s own edges are not');
  assert.deepEqual([s.segments[0].end, s.segments[3].start], [2000, 6000], 'the neighbours are untouched');

  // The Gloss tab rebuilds each half from its words joined by spaces: "c, d" + "e." is still a split.
  const p = makeDoc({ vernLang: 'fau', analLang: 'id' });
  reconcileBaseline(p, ['a b', 'c, d e.'], { flatSegments: true });
  const guid = p.paragraphs[1].segments[0].attrs.guid;
  p.segments = [{ start: 0, end: 2000 }, { start: 2000, end: 6000 }];
  const op = applyText(p, ['a b', 'c , d', 'e .'], { flatSegments: true });
  assert.deepEqual(op.slice(1).map((x) => x.kind), ['split', 'split']);
  assert.equal(p.paragraphs[1].segments[0].attrs.guid, guid, 'the first piece is the line, shortened: it keeps the guid');
});

test('in-order pairing where the counts match; word-share pairing where they do not', () => {
  const doc = makeDoc({ vernLang: 'fau', analLang: 'id' });
  reconcileBaseline(doc, ['one two three', 'four five six', 'seven eight'], { flatSegments: true });
  doc.segments = [{ start: 0, end: 1000 }, { start: 1000, end: 2000 }, { start: 2000, end: 3000 }];
  const typo = applyText(doc, ['one two three', 'fuor five sx', 'seven eight']);
  assert.deepEqual(typo[1], { kind: 'edit', from: 1 }, 'a typo fix keeps its line (and its time) even with few words in common');
  assert.deepEqual([doc.segments[1].start, doc.segments[1].end], [1000, 2000]);
  // Two lines retyped where there was one: the one sharing the old line's words takes it.
  const d2 = makeDoc({ vernLang: 'fau', analLang: 'id' });
  reconcileBaseline(d2, ['one two three', 'four five six', 'seven eight'], { flatSegments: true });
  d2.segments = [{ start: 0, end: 1000 }, { start: 1000, end: 2000 }, { start: 2000, end: 3000 }];
  const o2 = applyText(d2, ['one two three', 'something else entirely', 'four five six!', 'seven eight']);
  assert.deepEqual(o2.map((x) => x.kind), ['kept', 'new', 'edit', 'kept']);
  assert.deepEqual([d2.segments[2].start, d2.segments[2].end], [1000, 2000]);
  // Fewer than half the old line's words in common: not the same line.
  const d3 = makeDoc({ vernLang: 'fau', analLang: 'id' });
  reconcileBaseline(d3, ['one two three', 'four five six', 'seven eight'], { flatSegments: true });
  d3.segments = [{ start: 0, end: 1000 }, { start: 1000, end: 2000 }, { start: 2000, end: 3000 }];
  const o3 = applyText(d3, ['one two three', 'x four y', 'z w', 'seven eight']);
  assert.ok(o3.slice(1, 3).every((x) => x.kind === 'new'), 'one shared word of three is not enough');
});

test('reconcileBaseline still returns the doc; the origins always cover every line', () => {
  const doc = makeDoc({ vernLang: 'fau', analLang: 'id' });
  assert.equal(reconcileBaseline(doc, ['a', 'b'], { flatSegments: true }), doc);
  const o = reconcileBaselineWithOrigins(doc, []);
  assert.equal(doc.paragraphs.length, 1);
  assert.deepEqual(o, [{ kind: 'new' }], 'an emptied text still gets one line, and one origin for it');
  for (const name of ['t53', 'elan40', 'e78']) {
    const d = loadFixture(name);
    const lines = getBaselineParagraphs(d).reverse();
    const origins = reconcileBaselineWithOrigins(d, lines);
    assert.equal(origins.length, d.paragraphs.length, `${name}: one origin per line, whatever the edit`);
  }
});
