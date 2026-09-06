// What a split, a join and an in-place word edit PRESERVE from a FLExText (Seth, 2026-09-06: "All
// FLExText data including GUIDs, morpheme analyses (GUIDs??), lex glosses/senses, etc? Preserved?").
// A word whose text survives is carried as the SAME object: its GUID, its <morphemes> block (with
// the morph GUIDs, lex glosses and senses inside), its pos/cf/hn/msa items and other-language lines.
// A word whose text changes is a new word (new GUID, no analysis) — FLEx re-parses a new wordform.
// A split's pieces are distinct phrases: the first keeps the line's GUID, the rest get fresh ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDoc, makeSegment, makeWord, reconcileBaseline, wordGlosses } from '../docs/js/flextext.js';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');

const MORPHS = '<morphemes><morph type="stem" guid="m-1"><item type="txt" lang="fau">satu</item><item type="cf" lang="fau">satu</item><item type="gls" lang="en">one</item><item type="msa" lang="en">num</item></morph></morphemes>';
function textWith(lines) {
  const doc = makeDoc({ vernLang: 'fau', analLang: 'en' }, 'T');
  doc.paragraphs = lines.map((words, i) => {
    const ws = words.map((t, k) => { const w = makeWord(t, { gls: t.toUpperCase() }); w.guid = `w-${i}-${k}`; if (k === 0) w.preservedXML = [MORPHS, '<item type="pos" lang="en">n</item>']; return w; });
    const seg = makeSegment(words.join(' '), ws, { free: `free ${i}`, preItemsXML: [], postItemsXML: [`<item type="note" lang="en">note ${i}</item>`] });
    seg.attrs = { guid: `ph-${i}`, 'begin-time-offset': '0', 'end-time-offset': '3000' };
    return { guid: `p-${i}`, segments: [seg] };
  });
  return doc;
}

test('a split carries every word object, with its GUID and morpheme analysis, into the piece it lands in', () => {
  const doc = textWith([['satu', 'dua', 'tiga', 'empat']]);
  const before = doc.paragraphs[0].segments[0].words.map((w) => w);
  reconcileBaseline(doc, ['satu dua', 'tiga empat'], { flatSegments: true });
  const [L, R] = doc.paragraphs.map((p) => p.segments[0]);
  assert.equal(L.words[0], before[0], 'the same object, not a copy');
  assert.equal(L.words[0].guid, 'w-0-0');
  assert.deepEqual(L.words[0].preservedXML, [MORPHS, '<item type="pos" lang="en">n</item>'], 'morphemes (with their GUIDs, lex glosses, senses) and pos ride with the word');
  assert.equal(R.words[0], before[2]); assert.equal(R.words[1].guid, 'w-0-3');
  assert.deepEqual(R.words.map((w) => w.gls), ['TIGA', 'EMPAT'], 'glosses ride with their words');
  assert.equal(L.attrs.guid, 'ph-0', 'the first piece keeps the line\'s phrase GUID');
  assert.notEqual(R.attrs.guid, 'ph-0', 'the second piece is a new phrase with its own GUID');
  assert.notEqual(L.attrs, R.attrs, 'and its own attrs object');
  assert.equal('begin-time-offset' in L.attrs, false, 'no stale offsets on either piece');
  assert.equal('end-time-offset' in R.attrs, false);
  assert.deepEqual([L.postItemsXML.length, R.postItemsXML.length].sort(), [0, 1], 'the note rides with one piece, not both');
});

test('a join carries every word from both sides and every item from both phrases', () => {
  const doc = textWith([['satu', 'dua'], ['tiga', 'empat']]);
  const w = doc.paragraphs.map((p) => p.segments[0].words);
  reconcileBaseline(doc, ['satu dua tiga empat'], { flatSegments: true });
  const seg = doc.paragraphs[0].segments[0];
  assert.deepEqual(seg.words, [...w[0], ...w[1]], 'the same word objects, in order');
  assert.equal(seg.words[2].preservedXML[0], MORPHS, 'the second line\'s morphemes came along');
  assert.equal(seg.free, 'free 0 free 1');
  assert.equal(seg.attrs.guid, 'ph-0');
});

test('an edited word is a new wordform: the gloss is kept by the Gloss tab, the analysis is not invented', () => {
  const doc = textWith([['satu', 'dua']]);
  reconcileBaseline(doc, ['satuu dua'], { flatSegments: true });
  const seg = doc.paragraphs[0].segments[0];
  assert.notEqual(seg.words[0].guid, 'w-0-0', 'a changed form is a new word');
  assert.deepEqual(seg.words[0].preservedXML, [], 'with no analysis carried from the old form');
  assert.equal(seg.words[1].guid, 'w-0-1', 'the untouched word is the same object');
  assert.equal(seg.words[1].gls, 'DUA');
  assert.match(APP, /if \(near && near\.gls\) w\.gls = near\.gls;/, 'glossEditWord puts the gloss back on the edited word');
  assert.equal(wordGlosses(seg.words[1])[0].text, 'DUA');
});
