/* ESTIMATES READ BACK, NOT LAUNDERED (v717 — plans/time-gaps-and-estimates.md D5, D6, cases 7, 11, 19, 23).
 *
 * v714 wrote `~` into the "audio" note of an estimated line and never read it back, so a text made of
 * the editor's own even-spread guesses (E78, E19) came back as measured times and went out again as
 * fact. Now segmentsFromOffsets reads, per span: our processing instruction (per edge), else our `~`
 * note, else an equal-length run — each only when it still equals the file's offsets. A doc stored
 * by v714 gets the same tests in memory (readLegacyEstimates), against the CURRENT span too. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture, openXml, fixtureXml, DURATION, ft } from './lib/timing-fixtures.mjs';
import { isEstimate, edgeGuessed, normalizeSegments, syncToLines, boundaryAtPlayhead } from '../docs/js/segments.js';
import { fmtClock } from '../docs/js/seg-exports.js';

const { serializeFlextext, readLegacyEstimates, segmentsFromOffsets, timeEstimatesPi, parseTimeEstimatesPi } = ft;
const SET = { vernLang: 'fau', analLang: 'id' };
const est = (segs) => segs.filter(isEstimate).length;
const noteOf = (b, e, tilde) => `audio ${tilde ? '~' : ''}${fmtClock(b)}–${fmtClock(e)}`;
const phraseXml = ({ txt = 'w w', b, e, note, guid }) => `<paragraph><phrases><phrase${guid ? ` guid="${guid}"` : ''}`
  + `${b != null ? ` begin-time-offset="${b}" end-time-offset="${e}"` : ''}><item type="txt" lang="fau">${txt}</item>`
  + `<words>${txt.split(' ').filter(Boolean).map((w) => `<word><item type="txt" lang="fau">${w}</item></word>`).join('')}</words>`
  + `${note ? `<item type="note" lang="id">${note}</item>` : ''}</phrase></phrases></paragraph>`;
const fileXml = (rows, pi = '') => '<?xml version="1.0" encoding="utf-8"?><document version="2"><interlinear-text>'
  + `<item type="title" lang="id">T</item><paragraphs>${rows.map(phraseXml).join('')}</paragraphs>${pi}`
  + '<languages><language lang="fau" vernacular="true"/><language lang="id"/></languages></interlinear-text></document>';
// Four lines over 8 s; the middle two met at a guessed seam (`~` on both), the outer two real.
const ROWS = [
  { b: 0, e: 2000, guid: 'g0' }, { b: 2000, e: 4500, guid: 'g1', tilde: true },
  { b: 4500, e: 6000, guid: 'g2', tilde: true }, { b: 6000, e: 8000, guid: 'g3' },
].map((r) => ({ ...r, note: noteOf(r.b, r.e, r.tilde) }));

test('E78 and E19 come back as the estimates they are (the `~` note)', () => {
  const e78 = loadFixture('e78').segments;
  assert.equal(e78.length, 78);
  assert.equal(est(e78), 78, 'all 78 lines of the even spread');
  assert.ok(e78.every((s) => !isEstimate(s) || s.estSource === 'note'));
  assert.deepEqual([edgeGuessed(e78[0], 0), edgeGuessed(e78[0], 1), edgeGuessed(e78[77], 0), edgeGuessed(e78[77], 1)],
    [false, true, true, false], 'C0: the first start and the last end are real; the seams between are guesses');
  const e19 = loadFixture('e19').segments;
  assert.equal(est(e19), 19);
  assert.equal(e19[18].end, 45997, 'E19 ends 7 ms after its decoded length…');
  for (const after of [normalizeSegments(e19, { duration: DURATION.e19 }), syncToLines(e19, 19, { duration: DURATION.e19 }),
    boundaryAtPlayhead(e19, 3, e19[3].start + 1000, { duration: DURATION.e19 })]) {
    const last = after[after.length - 1];
    assert.equal(last.end, 45997, '…and keeps that end through every edit (no clamp, case 19)');
    assert.equal(isEstimate(last), true, '…and stays an estimate');
  }
});

test('real files stay real: T53, T151, T18, ELAN40 read back with no estimates', () => {
  for (const name of ['t53', 't151', 't18', 'elan40']) {
    const segs = loadFixture(name).segments;
    assert.equal(est(segs), 0, name);
    assert.ok(segs.every((s) => Array.isArray(s.guess) && s.guess[0] === null && s.guess[1] === null), `${name}: every span is explicitly real`);
  }
  assert.equal(est(loadFixture('l29-13aug').segments), 8, 'L29 (13 Aug) has its 8 nudged-cut lines, and only those');
});

test('a note counts only when it equals the offsets; the edges follow the neighbours', () => {
  const segs = openXml(fileXml(ROWS)).segments;
  assert.deepEqual(segs.map((s) => [edgeGuessed(s, 0), edgeGuessed(s, 1)]), [[false, false], [false, true], [true, false], [false, false]],
    'a `~` pair is guessed at its shared seam only — each outer edge meets a real neighbour');
  const off = ROWS.map((r, k) => (k === 1 ? { ...r, note: noteOf(2000, 4400, true) } : r));
  assert.equal(isEstimate(openXml(fileXml(off)).segments[1]), false, 'a `~` note whose times disagree with the offsets marks nothing');
  const flat = openXml(fileXml(ROWS.map((r) => ({ ...r, note: noteOf(r.b, r.e, false) })))).segments;
  assert.equal(est(flat), 0, 'no `~`, no estimate');
});

test('the processing instruction gives the exact edges, and is ignored when it cannot be trusted', () => {
  const pi = (body) => `<?flextext-editor v="2" time-estimates="${body}"?>`;
  const plain = ROWS.map((r) => ({ ...r, note: noteOf(r.b, r.e, false) }));
  const segs = openXml(fileXml(plain, pi('g1@2000-~4500 g2@~4500-6000'))).segments;
  assert.deepEqual(segs.map((s) => [edgeGuessed(s, 0), edgeGuessed(s, 1)]), [[false, false], [false, true], [true, false], [false, false]]);
  assert.ok(segs.filter(isEstimate).every((s) => s.estSource === 'marker'));
  const only = openXml(fileXml(plain, pi('g1@~2000-4500'))).segments;
  assert.deepEqual([edgeGuessed(only[1], 0), edgeGuessed(only[1], 1)], [true, false], 'per edge, even against the neighbour rule');
  assert.equal(est(openXml(fileXml(plain, pi('g1@2000-~4400'))).segments), 0, 'times that disagree with the offsets: ignored');
  assert.equal(est(openXml(fileXml(plain, pi('g1@2000-~4500 g1@2000-~4500'))).segments), 0, 'an entry listed twice: ignored');
  /* Real files carry one phrase guid on two lines (an older split shared its attrs — L29, T18), and
   * those are exactly the nudged pairs that hold estimates, so an entry is keyed by guid AND times. */
  const twin = plain.map((r, k) => (k === 2 ? { ...r, guid: 'g1' } : r));
  const shared = openXml(fileXml(twin, pi('g1@2000-~4500 g1@~4500-6000'))).segments;
  assert.deepEqual(shared.slice(1, 3).map((s) => [edgeGuessed(s, 0), edgeGuessed(s, 1)]), [[false, true], [true, false]],
    'two phrases sharing a guid each find their own entry by its times');
  const same = [{ b: 0, e: 2000, guid: 'd' }, { b: 0, e: 2000, guid: 'd' }, { b: 2000, e: 5000, guid: 'q' }];
  assert.equal(openXml(fileXml(same, pi('d@0-~2000'))).segments.filter((s) => s.estSource === 'marker').length, 0,
    'an entry that fits two phrases (same guid, same times) is used for neither');
  assert.equal(est(openXml(fileXml(plain, pi('g0@~0-2000'))).segments), 0, 'C0 holds whatever a file says');
  assert.deepEqual(parseTimeEstimatesPi('v="2" time-estimates="a@~1-2 b@3-~4 bad c@5-6"'),
    [{ guid: 'a', start: 1, end: 2, gs: true, ge: false }, { guid: 'b', start: 3, end: 4, gs: false, ge: true }],
    'an entry with no guessed edge, or one that does not parse, is skipped');
  assert.equal(timeEstimatesPi([]), '', 'nothing to say, no instruction');
});

test('an equal-length run (notes off) is an estimate at three lines, not at two', () => {
  const run = (k) => Array.from({ length: k }, (_, j) => ({ b: j * 2015, e: (j + 1) * 2015 + (j % 2), guid: 'p' + j }))
    .map((r, j, all) => ({ ...r, b: j ? all[j - 1].e : 0 }));
  const tail = (rows) => rows.concat([{ b: rows[rows.length - 1].e, e: rows[rows.length - 1].e + 5000, guid: 'z' }]);
  const three = openXml(fileXml(tail(run(3)))).segments;
  assert.equal(est(three), 3);
  assert.ok(three.slice(0, 3).every((s) => s.estSource === 'pattern'));
  assert.equal(est(openXml(fileXml(tail(run(2)))).segments), 0, 'two equal lines are a coincidence');
  const gapped = run(3).map((r, j) => ({ ...r, b: r.b + j * 400, e: r.e + j * 400 }));
  assert.equal(est(openXml(fileXml(tail(gapped))).segments), 0, 'equal lengths with pauses between are not a spread');
});

test('a start the import had to move is a guess on that edge (the clamp, other finding 2)', () => {
  const segs = openXml(fileXml([{ b: 0, e: 3000 }, { b: 2000, e: 5000 }, { b: 5000, e: 6000 }])).segments;
  assert.equal(segs[1].start, 3000);
  assert.deepEqual([edgeGuessed(segs[1], 0), edgeGuessed(segs[1], 1), segs[1].estSource], [true, false, 'edit']);
});

/* A doc stored by v714: its spans carry no `guess`, its import ignored every `~`. */
const asV714 = (doc) => { doc.segments = doc.segments.map(({ guess, estSource, timeEstimated, ...rest }) => rest); return doc; };

test('readLegacyEstimates: a stored pre-v717 doc gets the same read-back, against the CURRENT span', () => {
  const e78 = asV714(loadFixture('e78'));
  assert.equal(est(e78.segments), 0, 'as v714 stored it');
  assert.equal(readLegacyEstimates(e78), true);
  assert.equal(est(e78.segments), 78, 'all 78 estimates recovered in memory');
  assert.equal(readLegacyEstimates(e78), false, 'and a second pass has nothing left to decide');

  const dragged = asV714(openXml(fileXml(ROWS)));
  dragged.segments[1].end = 3000; dragged.segments[2].start = 3000;   // a seam v714 moved by hand
  readLegacyEstimates(dragged);
  assert.equal(est(dragged.segments), 0, 'case 11: the note no longer equals the span, so the moved seam is not re-flagged');

  const kept = openXml(fileXml(ROWS));
  kept.segments[1] = { start: 2000, end: 4500, guess: [null, null] };   // "these times are right" (v718's Keep)
  kept.segments[2] = { start: 4500, end: 6000, guess: [null, null] };
  assert.equal(readLegacyEstimates(kept), false, 'case 7: a span that has `guess` is never re-decided');
  assert.equal(est(kept.segments), 0);

  const seed = { paragraphs: [0, 1, 2].map(() => ({ segments: [{ attrs: {}, baseline: 'w', words: [] }] })),
    segments: [0, 1, 2].map((k) => ({ start: k * 1000, end: (k + 1) * 1000, timeEstimated: true })) };
  readLegacyEstimates(seed);
  assert.deepEqual(seed.segments.map((s) => [edgeGuessed(s, 0), edgeGuessed(s, 1), s.estSource]),
    [[false, true, 'legacy'], [true, true, 'legacy'], [true, false, 'legacy']], 'a v714 seed: guessed on its interior edges');
});

test('round trip: export → import → export keeps every `~`, and the instruction carries the edges', () => {
  for (const name of ['e78', 'l29-damaged', 'e19']) {
    const doc = loadFixture(name);
    const before = doc.segments.map((s) => [s.start, s.end, edgeGuessed(s, 0), edgeGuessed(s, 1)]);
    const x1 = serializeFlextext(doc, SET);
    const tildes = (x) => (x.match(/>audio ~/g) || []).length;
    assert.equal(tildes(x1), est(doc.segments), `${name}: one \`~\` per estimate`);
    assert.match(x1, /\n {4}<\?flextext-editor v="2" time-estimates="[^"]+"\?>\n {4}<languages>/, `${name}: the instruction sits inside <interlinear-text>`);
    const again = openXml(x1);
    assert.deepEqual(again.segments.map((s) => [s.start, s.end, edgeGuessed(s, 0), edgeGuessed(s, 1)]), before, `${name}: re-import is identical, edge for edge`);
    assert.equal(serializeFlextext(again, SET), x1, `${name}: and the second export is byte-identical to the first`);
  }
  // With the notes switched off (the device setting segTimeNotes), the instruction alone carries it.
  const doc = loadFixture('l29-damaged');
  const before = doc.segments.map((s) => [s.start, s.end, edgeGuessed(s, 0), edgeGuessed(s, 1)]);
  const quiet = serializeFlextext(doc, SET, { timeNotes: false });
  assert.doesNotMatch(quiet, />audio /, 'no notes');
  assert.equal((quiet.match(/@~?\d+-~?\d+/g) || []).length, 8, 'the 8 estimated phrases are listed');
  assert.deepEqual(openXml(quiet).segments.map((s) => [s.start, s.end, edgeGuessed(s, 0), edgeGuessed(s, 1)]), before,
    're-import without notes is identical, edge for edge (case 23)');
  assert.doesNotMatch(serializeFlextext(loadFixture('t53'), SET), /time-estimates/, 'a text with no estimates writes no instruction');
});

test('the original fixture bytes are what the read-back saw (no hidden PI in a skeleton)', () => {
  for (const name of Object.keys(DURATION)) assert.doesNotMatch(fixtureXml(name), /<\?flextext-editor/, name);
  assert.equal(segmentsFromOffsets({ paragraphs: [] }), null);
});
