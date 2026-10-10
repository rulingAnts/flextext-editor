/* THE EXPORT WRITES ONLY THE LIVE TIMES (v717 — plans/time-gaps-and-estimates.md D8, D12, case 4, BM3).
 *
 * A single-phrase line whose live span has no time used to fall back to the begin/end-time-offset its
 * phrase still carried from an earlier import — in the .flextext (pass-through attributes) and in
 * the EAF, .fxpa and listening page (phraseRows). So a line the Audio Segmenter left without audio
 * went out with its stale times, and after a re-cut two phrases claimed the same stretch of audio.
 * With times on, the live span is now the only source; with segTimes off nothing changes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture, openXml, fixtureXml, ft } from './lib/timing-fixtures.mjs';
import { placeSeam, withGuesses, isEstimate, isAligned } from '../docs/js/segments.js';
import { serializeEaf, buildFxpa, buildSegPreviewHtml } from '../docs/js/seg-exports.js';

const { serializeFlextext } = ft;
const SET = { vernLang: 'fau', analLang: 'id' };
const phrasesOf = (xml) => [...xml.matchAll(/<phrase\b([^>]*)>([\s\S]*?)<\/phrase>/g)].map((m) => {
  const b = /begin-time-offset="(\d+)"/.exec(m[1]), e = /end-time-offset="(\d+)"/.exec(m[1]);
  return { b: b ? +b[1] : null, e: e ? +e[1] : null, notes: (m[2].match(/>audio [^<]*</g) || []).length };
});
const overlaps = (ph) => ph.filter((p) => p.b != null).some((p, k, all) => k > 0 && p.b < all[k - 1].e);

test('D8: a line whose live span is pending is written with no offsets and no audio note', () => {
  const doc = loadFixture('t18');
  const stale = doc.paragraphs[4].segments[0];
  assert.ok(stale.attrs['begin-time-offset'] && stale.postItemsXML.some((x) => />audio /.test(x)), 'the phrase still carries its imported offsets and note');
  doc.segments[4] = { timePending: true };            // e.g. the Segmenter's Done left this line without audio
  const ph = phrasesOf(serializeFlextext(doc, SET));
  assert.deepEqual([ph[4].b, ph[4].e, ph[4].notes], [null, null, 0], 'no stale times, no stale note');
  assert.ok(ph.every((p, k) => k === 4 || (p.b != null && p.notes === 1)), 'every other line is written with its time');
  assert.equal(stale.attrs['begin-time-offset'] != null, true, 'the doc itself is not touched by exporting it');
  const allPending = loadFixture('t18');
  allPending.segments = allPending.segments.map(() => ({ timePending: true }));
  assert.ok(phrasesOf(serializeFlextext(allPending, SET)).every((p) => p.b == null && !p.notes), 'a doc whose every line is pending writes no times at all');
});

test('BM3: E78 with line 10 re-cut and line 11 left without audio — no two phrases overlap; re-import is identical', () => {
  const doc = loadFixture('e78');
  const live = withGuesses(doc.segments);
  placeSeam(live, 10, live[10].end + 900, 'seam');    // line 10 takes 0.9 s of line 11 …
  live[11] = { timePending: true };                   // … and line 11 is left untimed
  doc.segments = live;
  assert.ok(+doc.paragraphs[11].segments[0].attrs['begin-time-offset'] < live[10].end, 'line 11\'s stale offsets now overlap line 10');
  const xml = serializeFlextext(doc, SET);
  const ph = phrasesOf(xml);
  assert.equal(overlaps(ph), false, 'no overlapping phrases in the export');
  assert.equal(ph[11].b, null);
  const again = openXml(xml).segments;
  assert.deepEqual(again.map((s) => (isAligned(s) ? [s.start, s.end, isEstimate(s)] : 'pending')),
    live.map((s) => (isAligned(s) ? [s.start, s.end, isEstimate(s)] : 'pending')), 're-import gives the same spans and the same estimates');
});

test('case 4: phraseRows — EAF, .fxpa and the listening page never fall back to a pending line\'s offsets', () => {
  const doc = loadFixture('t18');
  doc.segments[4] = { timePending: true };
  const clean = loadFixture('t18');
  clean.segments[4] = { timePending: true };
  delete clean.paragraphs[4].segments[0].attrs['begin-time-offset'];
  delete clean.paragraphs[4].segments[0].attrs['end-time-offset'];
  const eafOf = (d) => serializeEaf(d, { profile: 'flex', vern: 'fau', anal: 'id', mediaName: 'recording.wav', date: '2026-10-10T00:00:00Z' });
  const eaf = eafOf(doc);
  assert.equal(eaf, eafOf(clean), 'EAF: stale offsets on a pending line change nothing — it is as if they were never there');
  assert.equal((eaf.match(/<TIME_SLOT TIME_SLOT_ID="ts\d+"\/>/g) || []).length, 2, 'the pending line is unaligned in ELAN (two value-less slots)');
  const fx = buildFxpa(doc, { title: 'T18' });
  assert.ok(!('start' in fx.lines[4]) && 'start' in fx.lines[3], '.fxpa: no time for the pending line');
  const html = buildSegPreviewHtml(doc, { title: 'T18' });
  assert.equal((html.match(/\d:\d\d\.\d{3}–\d:\d\d\.\d{3}/g) || []).length, 17, 'the listening page shows 17 times, not 18');
  // A multi-phrase paragraph still takes each phrase's own offsets — no live span pairs with a phrase.
  const merged = openXml(fixtureXml('t151'), { open: false });
  merged.segments = ft.segmentsFromOffsets(merged);
  const rows = buildFxpa(merged, {}).lines;
  assert.equal(rows.length, 151);
  assert.ok(rows.every((l) => Number.isFinite(l.start)), 'all 151 phrases keep their own times inside 53 paragraphs');
});

test('the estimate flag in every export comes from isEstimate, per edge', () => {
  const doc = loadFixture('l29-damaged');
  const fx = buildFxpa(doc, {});
  assert.equal(fx.lines.filter((l) => l.timeEstimated).length, 8);
  const html = buildSegPreviewHtml(doc, {});
  assert.equal((html.match(/~\d:\d\d\.\d{3}–/g) || []).length, 8);
  // A seam placed by hand makes both of its sides real; the far edges of the pair stay as they were.
  doc.segments = withGuesses(doc.segments);
  placeSeam(doc.segments, 2, 5900, 'seam');
  assert.equal(buildFxpa(doc, {}).lines.filter((l) => l.timeEstimated).length, 6, 'placing the guessed seam of one nudged pair makes that pair real');
  assert.equal((serializeFlextext(doc, SET).match(/>audio ~/g) || []).length, 6);
});

test('with segTimes off, and for a doc with no live spans, offsets pass through exactly as in v714', () => {
  const doc = loadFixture('e78');
  doc.segments[5] = { timePending: true };
  const orig = phrasesOf(fixtureXml('e78'));
  const off = phrasesOf(serializeFlextext(doc, SET, { segTimes: false }));
  assert.deepEqual(off.map((p) => [p.b, p.e]), orig.map((p) => [p.b, p.e]), 'segTimes:false — every imported offset round-trips verbatim');
  assert.ok(off.every((p) => p.notes === 1), 'and so does every imported note');
  assert.doesNotMatch(serializeFlextext(doc, SET, { segTimes: false }), /time-estimates/, 'no instruction when we write no times');
  const raw = openXml(fixtureXml('e78'), { open: false });
  assert.equal(raw.segments, undefined, 'a parsed doc that was never opened has no live spans');
  assert.deepEqual(phrasesOf(serializeFlextext(raw, SET)).map((p) => [p.b, p.e]), orig.map((p) => [p.b, p.e]), '…and its offsets pass through');
});

/* v718 (D8, D12): a PLACEHOLDER — an untimed line drawn evenly in its gap — is exported exactly as a
 * pending line: no offsets, no audio note, no instruction entry, no EAF time, no .fxpa or listening-page
 * time. Every exporter reads the storable form (spansForExport), so this holds for all of them at once. */
test('v718: a line drawn in its gap is exported untimed by every exporter — and a stale offset never comes back', async () => {
  const SEGS = await import('../docs/js/segments.js');
  const doc = loadFixture('t18');
  doc.segments[4] = { timePending: true };            // its phrase still carries the imported offsets and note
  doc.segments = SEGS.spreadUntimed(doc.segments, 25867);
  assert.ok(SEGS.isPlaceholder(doc.segments[4]), 'drawn in the gap the Segmenter left');
  const ph = phrasesOf(serializeFlextext(doc, SET, { segTimes: true, timeNotes: true }));
  assert.deepEqual([ph[4].b, ph[4].e, ph[4].notes], [null, null, 0], '.flextext: no times, no note — neither the spread\'s nor the stale ones');
  assert.ok(!overlaps(ph));
  const eaf = serializeEaf(doc, { title: 'T18', mediaName: 'recording.wav', durationMs: 25867 });
  const fx = buildFxpa(doc, SET);
  assert.equal('start' in fx.lines[4], false, '.fxpa: no time');
  assert.equal(fx.lines.filter((l) => 'start' in l).length, 17);
  const html = buildSegPreviewHtml(doc, { title: 'T18' });
  const html0 = buildSegPreviewHtml({ ...doc, segments: SEGS.storableSegments(doc.segments) }, { title: 'T18' });
  assert.equal(html, html0, 'the listening page: the stored doc\'s, exactly');
  const eaf0 = serializeEaf({ ...doc, segments: SEGS.storableSegments(doc.segments) }, { title: 'T18', mediaName: 'recording.wav', durationMs: 25867 });
  assert.equal(eaf.replace(/DATE="[^"]*"/, ''), eaf0.replace(/DATE="[^"]*"/, ''), 'the EAF: the stored doc\'s');
});

test('v718 / case 12: a record v714 stored with its even seed exports NO times, opened again or not', async () => {
  const SEGS = await import('../docs/js/segments.js');
  const doc = ft.makeDoc(SET);
  ft.reconcileBaseline(doc, ['a b', 'c d', 'e f', 'g h', 'i j'], { flatSegments: true });
  // As v714 left it in IndexedDB: an even division of a 50 s recording, each span flagged, no guess.
  doc.segments = [0, 1, 2, 3, 4].map((k) => ({ start: k * 10000, end: (k + 1) * 10000, timeEstimated: true }));
  delete doc.timeEdges;
  const xml = serializeFlextext(doc, SET, { segTimes: true, timeNotes: true });   // from the list: never drawn
  assert.doesNotMatch(xml, /begin-time-offset|>audio |time-estimates/, 'the seed is not sent out as times');
  assert.equal(buildFxpa(doc, SET).lines.filter((l) => 'start' in l).length, 0, 'nor into a .fxpa');
  assert.equal(doc.segments.filter(SEGS.isEstimate).length, 5, 'and exporting changed nothing on the record');
  // A FILE's even spread (E78: offsets on every phrase) is that file's own estimate, and still exported as one.
  const e78 = loadFixture('e78');
  assert.equal((serializeFlextext(e78, SET, { segTimes: true, timeNotes: true }).match(/>audio ~/g) || []).length, 78);
});
