/* ONE DOOR TO STORAGE, AND PLACEHOLDERS DO NOT PASS IT (v718 — plans/time-gaps-and-estimates.md §2,
 * case 5, BM1; §6.1 storage-chokepoint).
 *
 * Untimed lines are drawn as placeholders in the open record's own doc.segments, so every tab and
 * ticker sees one array. They must never be stored — a stored placeholder is indistinguishable from a
 * time somebody set, and the next export would write it as one. db.js putDoc runs every record through
 * storableRecord, on a COPY (the record is usually `current`, the text on screen); every export reads
 * the same storable form (flextext.js spansForExport); and the "already on Drive" signature is of the
 * stored form too, so a mere look at an untimed text never reads as an edit. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as SEG from '../docs/js/segments.js';
import { ft, loadFixture, DURATION } from './lib/timing-fixtures.mjs';
import { storableRecord, DB_SRC } from './lib/storable.mjs';
import { liftAll } from './lib/lift.mjs';
import { serializeEaf, buildFxpa } from '../docs/js/seg-exports.js';

const { spreadUntimed, isPlaceholder, isAligned, storableSegments } = SEG;
const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), STRIPS = rd('../docs/js/segment-strips.js');
const SET = { vernLang: 'fau', analLang: 'id' };
const real = (start, end) => ({ start, end, guess: [null, null] });

function partlyDoc() {
  const doc = ft.makeDoc(SET);
  ft.reconcileBaseline(doc, ['satu', 'dua', 'tiga', 'empat'], { flatSegments: true });
  doc.segments = spreadUntimed([real(0, 2000), { timePending: true }, { timePending: true, noRoom: true }, real(5000, 7000)], 7000);
  return doc;
}

test('storableRecord: placeholders stored as pending, display marks dropped, the input untouched', () => {
  const doc = partlyDoc();
  assert.ok(isPlaceholder(doc.segments[1]) && isPlaceholder(doc.segments[2]), 'two untimed lines drawn in their gap');
  const rec = { id: 'r', title: 'T', modified: 5, doc, matchDraft: { at: 1, lines: [], spans: [
    { id: 'sp0', start: 0, end: 2000, timePending: false, guess: [null, null] },
    { id: 'sp1', start: 2000, end: 3500, timePending: false, guess: [2000, 3500], estSource: 'spread', phAt: [2000, 3500], timeEstimated: true },
    { id: 'sp2', start: 0, end: 0, timePending: true, noRoom: true },
  ] } };
  const before = JSON.stringify(rec);
  const out = storableRecord(rec);
  assert.equal(JSON.stringify(rec), before, 'the record on screen is not touched — its placeholders stay drawn');
  assert.notEqual(out, rec, 'a copy');
  assert.equal(out.doc.paragraphs, rec.doc.paragraphs, 'shallow: only the span arrays are rebuilt');
  assert.deepEqual(out.doc.segments.map((s) => (isAligned(s) ? [s.start, s.end] : 'pending')), [[0, 2000], 'pending', 'pending', [5000, 7000]]);
  assert.ok(out.doc.segments.every((s) => !('phAt' in s) && !('noRoom' in s)), 'no display mark reaches storage');
  assert.deepEqual(out.doc.segments[1], { timePending: true }, 'exactly what a line with no time is');
  assert.deepEqual(out.matchDraft.spans[1], { id: 'sp1', start: 0, end: 0, timePending: true }, 'a Segmenter row keeps its id and its "no audio" shape');
  assert.deepEqual(out.matchDraft.spans[2], { id: 'sp2', start: 0, end: 0, timePending: true });
  assert.equal(out.matchDraft.spans[0], rec.matchDraft.spans[0], 'an untouched span is passed through as it is');
  // a record with no spans at all is the same object back
  const plain = { id: 'p', doc: { paragraphs: [] } };
  assert.equal(storableRecord(plain), plain);
});

test('BM1 / case 5: putDoc is the one door, and nothing else writes the docs store', () => {
  const put = liftAll(DB_SRC, ['putDoc']);
  assert.match(put, /const stored = storableRecord\(record\);/, 'putDoc strips first…');
  assert.match(put, /tx\(db, 'readwrite'\)\.put\(stored\)/, '…and stores the stripped copy, never the record it was given');
  assert.equal((DB_SRC.match(/\.put\(/g) || []).length, 2, 'db.js has two puts: the docs store (putDoc) and the media store (putMedia)');
  assert.match(liftAll(DB_SRC, ['putMedia']), /mediaTx\(db, 'readwrite'\)\.put\(record, docId\)/);
  // No other module opens this database — every other IndexedDB put is to a database of its own.
  const dir = new URL('../docs/js/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js') && x !== 'db.js')) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(src, /indexedDB\.open\(\s*['"]flextext-editor['"]/, `${f} does not open the editor's database`);
    for (const m of src.matchAll(/indexedDB\.open\(\s*([A-Z_]+|['"][\w-]+['"])/g)) {
      const name = /^['"]/.test(m[1]) ? m[1].slice(1, -1) : (src.match(new RegExp(`const ${m[1]} = ['"]([\\w-]+)['"]`)) || [])[1];
      assert.ok(name && name !== 'flextext-editor', `${f} opens its own database (${name})`);
    }
  }
  assert.match(DB_SRC, /const DB_NAME = 'flextext-editor';/);
});

test('the draw never saves an edit: no stamped write from any tab\'s preparation (case 5)', () => {
  const prep = liftAll(STRIPS, ['prepareDisplaySpans']);
  assert.doesNotMatch(prep, /schedulePersist|d\.persist\(\)/, 'nothing but the quiet write');
  assert.match(prep, /if \(wrote\) \(d\.persistQuiet \|\| d\.persist\)\?\.\(\);/, 'and that only for D7 and the tail cover');
  // every host that draws hands it the QUIET save
  assert.equal((APP.match(/persistQuiet: \(\) => saveQuiet\(\),/g) || []).length, 3, 'Baseline, Cut and Gloss');
  assert.match(liftAll(APP, ['glossPrepDeps']), /persistQuiet: \(\) => saveQuiet\(\)/);
});

test('every export reads the storable form: a placeholder goes out with no time, from each exporter', () => {
  const doc = partlyDoc();
  const stored = { ...doc, segments: storableSegments(doc.segments) };
  const xml = ft.serializeFlextext(doc, SET, { segTimes: true, timeNotes: true });
  assert.equal(xml, ft.serializeFlextext(stored, SET, { segTimes: true, timeNotes: true }), '.flextext: byte for byte the stored doc\'s');
  assert.equal((xml.match(/begin-time-offset=/g) || []).length, 2, 'two timed lines, two lines with no time');
  assert.doesNotMatch(xml, /time-estimates=/, 'and no estimate instruction for a placeholder');
  const undated = (x) => x.replace(/DATE="[^"]*"/, '');   // the EAF header stamps the moment it was written
  const eaf = undated(serializeEaf(doc, { title: 'T', mediaName: 'recording.wav', durationMs: 7000 }));
  assert.equal(eaf, undated(serializeEaf(stored, { title: 'T', mediaName: 'recording.wav', durationMs: 7000 })), '.eaf the same');
  assert.equal((eaf.match(/<ALIGNABLE_ANNOTATION/g) || []).length, (undated(serializeEaf(stored, { title: 'T', mediaName: 'recording.wav', durationMs: 7000 })).match(/<ALIGNABLE_ANNOTATION/g) || []).length);
  const fx = buildFxpa(doc, SET);
  assert.deepEqual(fx.lines.map((l) => ('start' in l ? [l.start, l.end] : null)), [[0, 2000], null, null, [5000, 7000]], '.fxpa the same');
});

test('the "already on Drive" signature is of the stored form: drawing placeholders is not an edit', () => {
  const sig = new Function('db', `${liftAll(APP, ['cheapHash', 'uploadContentSig'])}; return uploadContentSig;`)({ storableRecord });
  const u60 = loadFixture('u60');
  const rec = { id: 'u', title: 'U60', audioId: 'a', doc: u60 };
  u60.segments = Array.from({ length: 60 }, () => ({ timePending: true }));   // as v718 stores it
  const sent = sig(rec);
  rec.doc.segments = spreadUntimed(rec.doc.segments, DURATION.u60);          // drawn on the Baseline tab
  assert.ok(rec.doc.segments.every(isPlaceholder));
  assert.equal(sig(rec), sent, 'sixty placeholders on screen, and still "already on Drive"');
  rec.doc.segments = SEG.moveBoundary(rec.doc.segments, 4, 19000).segments;   // a real drag
  assert.notEqual(sig(rec), sent, 'a placed time is content');
});

test('a bundle offers EAFs only for PLACED times: a text of nothing but drawn lines has no alignment to give', () => {
  assert.match(APP, /const hasAligned = spans\.some\(isPlaced\);/, 'the save/share bundle asks isPlaced, not "has a start and an end"');
});
