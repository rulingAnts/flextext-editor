/* WHAT THE ONE TIMING BANNER SAYS (v717 — plans/time-gaps-and-estimates.md §4 timingReport, §9, P6).
 *
 * Measured on the timing skeletons of real files, because the thresholds were chosen on the corpus
 * and only the corpus can say they fire where they should and nowhere else: red on the damaged L29
 * exports (line 3 holds five words in 0.12 s, and the recording runs 2.1 s past the last line), quiet
 * on every healthy timed text, and one plain line — not a mark on every row — for a text with no
 * times at all. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture, DURATION, ft } from './lib/timing-fixtures.mjs';
import { timingReport, TIMING_TAIL_SHORT_MS } from '../docs/js/segments.js';

const report = (name, mutate) => {
  const doc = loadFixture(name);
  if (mutate) mutate(doc);
  return timingReport(doc.segments, ft.getBaselineParagraphs(doc), { durationMs: DURATION[name] });
};
const kinds = (r) => r.items.map((it) => it.kind);

test('the damaged L29 export is red: a dense line 3 and a 2 s tail', () => {
  const r = report('l29-damaged');
  assert.equal(r.level, 'red');
  const dense = r.items.find((it) => it.kind === 'dense');
  assert.deepEqual(dense.lines, [2], 'line 3 (index 2), and only it');
  assert.equal(dense.first.ms, 120);
  assert.ok(dense.first.words >= 4);
  assert.equal(r.items.find((it) => it.kind === 'tailShort').ms, 2076);
  assert.deepEqual(kinds(r), ['dense', 'tailShort', 'estimated'], 'most severe first; its 8 estimates are still reported');
});

test('L29 as exported on 13 Aug — before the damage — raises no check', () => {
  const r = report('l29-13aug');
  assert.ok(!r.items.some((it) => it.level === 'red' || it.level === 'amber'));
  assert.deepEqual(kinds(r), ['estimated'], 'only its 8 nudged-cut estimates, as the file says');
});

test('healthy timed texts say nothing at all', () => {
  for (const name of ['t53', 't151', 't18', 'elan40']) {
    const r = report(name);
    assert.deepEqual(r.items, [], name);
    assert.equal(r.level, '', name);
  }
});

test('E78: its estimates, by source', () => {
  const r = report('e78');
  assert.equal(r.level, 'estimate');
  const it = r.items[0];
  assert.deepEqual([it.kind, it.n, it.total, it.bySource], ['estimated', 78, 78, { note: 78 }]);
});

test('a text with no times: one info item, and no per-line marks', () => {
  const r = report('t53', (doc) => { doc.segments = doc.segments.map(() => ({ timePending: true })); });
  assert.deepEqual(r.items, [{ kind: 'noTimes', level: 'info', n: 53, spread: false }]);
  assert.equal(timingReport([], ['a', 'b'], {}).items[0].kind, 'noTimes', 'no spans at all is the same');
  assert.deepEqual(timingReport([], [], {}).items, [], 'and an empty text says nothing');
});

test('a partly timed text: amber, with a count', () => {
  const r = report('t18', (doc) => { doc.segments[4] = { timePending: true }; doc.segments[9] = { timePending: true }; });
  const it = r.items.find((x) => x.kind === 'partly');
  assert.equal(r.level, 'amber');
  assert.deepEqual([it.n, it.lines], [2, [4, 9]]);
});

test('case 17: dense ignores a span whose edges are both guesses, and lines of one word', () => {
  const texts = ['w w w w w', 'w w w w w', 'w', 'w w'];
  const spread = [{ start: 0, end: 300 }, { start: 300, end: 600, guess: [300, 600] }, { start: 600, end: 650 }, { start: 650, end: 5000 }];
  assert.deepEqual(timingReport(spread, texts, {}).items.find((it) => it.kind === 'dense').lines, [0],
    'line 1 is real and dense; line 2 is a pure guess; line 3 has one word');
  assert.equal(timingReport(spread.map((s, k) => (k === 0 ? { ...s, guess: [null, 300] } : s)), texts, {}).items.find((it) => it.kind === 'dense').lines[0], 0,
    'one real edge is enough to measure by');
});

test('tailShort needs an editor-made text (timed throughout, contiguous from 0) and a full second', () => {
  const D = DURATION['l29-damaged'];
  const base = loadFixture('l29-damaged');
  const texts = ft.getBaselineParagraphs(base).map(() => 'w');
  const tail = (segs, d = D) => timingReport(segs, texts, { durationMs: d }).items.find((it) => it.kind === 'tailShort');
  assert.ok(tail(base.segments));
  assert.ok(!tail(base.segments, base.segments[27].end + TIMING_TAIL_SHORT_MS - 1), 'just under a second: not raised');
  const pending = base.segments.map((s, k) => (k === 27 ? { timePending: true } : s));
  assert.ok(!tail(pending), 'a trailing untimed line owns the tail');
  const gapped = base.segments.map((s, k) => (k === 5 ? { ...s, start: s.start + 200 } : s));
  assert.ok(!tail(gapped), 'a text with pauses between lines (ELAN-made) is not judged by its tail');
  assert.ok(!tail(base.segments, null), 'no recording length, no judgement');
});

test('timeSync is red, and the signature changes when what the banner says changes', () => {
  const doc = loadFixture('t18');
  const texts = ft.getBaselineParagraphs(doc);
  const quiet = timingReport(doc.segments, texts, { durationMs: DURATION.t18 });
  const sync = timingReport(doc.segments, texts, { durationMs: DURATION.t18, timeSync: true });
  assert.deepEqual([sync.level, sync.items[0].kind], ['red', 'timeSync']);
  assert.notEqual(quiet.sig, sync.sig);
  const one = timingReport(doc.segments.map((s, k) => (k === 4 ? { timePending: true } : s)), texts, { durationMs: DURATION.t18 });
  const two = timingReport(doc.segments.map((s, k) => (k === 4 || k === 5 ? { timePending: true } : s)), texts, { durationMs: DURATION.t18 });
  assert.notEqual(one.sig, two.sig, 'one more untimed line is a different banner');
  assert.equal(one.sig, timingReport(doc.segments.map((s, k) => (k === 4 ? { timePending: true } : s)), texts, { durationMs: DURATION.t18 }).sig, 'and the same state the same signature');
});
