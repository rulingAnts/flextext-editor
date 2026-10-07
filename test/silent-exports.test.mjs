/* SILENT SEGMENTS LEAVE THE EXPORTS (Seth, 2026-10-08: "Silent segments exported (or saved) as flextext
 * and especially eaf should not be included in the export. That's all. Good enough. So not as empty
 * lines in FLEx or empty annotations in ELAN/SayMore.")
 *
 * The EDITOR is untouched: a blank line is still a real timed span, 1:1 with doc.segments, with its
 * placeholder on the Gloss tab and its strip on the Baseline tab (test/browser/roundtrip-blanks keeps
 * guarding the IMPORT side: a file that carries empty phrases still opens with all of them). Only what
 * is WRITTEN for FLEx and ELAN changes, and this measures exactly that — plus the one rule that keeps
 * it from ever dropping somebody's data: a phrase with words, text, a translation, or anything
 * preserved from an import (a note, a literal translation) is written whatever its timing.
 *
 * Run: node --test test/silent-exports.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { parseFlextext, serializeFlextext, reconcileBaseline, makeDoc, segmentsFromOffsets, isSilentPhrase } = await import('../docs/js/flextext.js');
const { serializeEaf, buildSegPreviewHtml, buildFxpa } = await import('../docs/js/seg-exports.js');

const SETTINGS = { vernLang: 'fau', analLang: 'id' };
/* Five pieces: line, SILENT, line, SILENT, line — the shape the Cut tab produces when a transcriber
 * cuts at every pause and types only where there are words. */
function doc5() {
  const doc = makeDoc(SETTINGS);
  reconcileBaseline(doc, ['satu dua', '', 'tiga empat', '', 'lima'], { flatSegments: true });
  doc.paragraphs[0].segments[0].free = 'one two';
  doc.paragraphs[2].segments[0].free = 'three four';
  doc.segments = [
    { start: 0, end: 2000 }, { start: 2000, end: 3000 }, { start: 3000, end: 5000 }, { start: 5000, end: 5500 }, { start: 5500, end: 7000 },
  ];
  return doc;
}
const phrases = (xml) => (xml.match(/<phrase\b/g) || []).length;
const paragraphs = (xml) => (xml.match(/<paragraph\b/g) || []).length;

test('isSilentPhrase: nothing in it — and anything in it keeps it', () => {
  const d = doc5();
  assert.deepEqual(d.paragraphs.map((p) => isSilentPhrase(p.segments[0])), [false, true, false, true, false]);
  const blank = () => doc5().paragraphs[1].segments[0];
  let s = blank(); s.free = 'a translation with no words'; assert.equal(isSilentPhrase(s), false, 'a free translation keeps it');
  s = blank(); s.postItemsXML = ['<item type="note" lang="id">speaker coughs</item>']; assert.equal(isSilentPhrase(s), false, 'an imported note keeps it');
  s = blank(); s.postItemsXML = ['<item type="note" lang="id">audio 0:02.000–0:03.000</item>']; assert.equal(isSilentPhrase(s), true, 'our own audio note does not');
  s = blank(); s.preItemsXML = ['<item type="segnum" lang="id">2</item>']; assert.equal(isSilentPhrase(s), false, 'anything preserved before the words keeps it');
  assert.equal(isSilentPhrase(null), false);
});

test('.flextext: no <phrase> for a silent segment, no paragraph when nothing is left in it', () => {
  const xml = serializeFlextext(doc5(), SETTINGS, {});
  assert.equal(phrases(xml), 3, 'three phrases for five pieces');
  assert.equal(paragraphs(xml), 3, 'and three paragraphs — the silent ones are not written as empty paragraphs either');
  assert.match(xml, /begin-time-offset="0" end-time-offset="2000"/);
  assert.match(xml, /begin-time-offset="3000" end-time-offset="5000"/);
  assert.match(xml, /begin-time-offset="5500" end-time-offset="7000"/);
  assert.doesNotMatch(xml, /begin-time-offset="2000"|begin-time-offset="5000"/, 'nothing starts where the silences did');
  assert.doesNotMatch(xml, /<item type="txt" lang="fau"><\/item>/, 'no empty baseline item anywhere');
  // the file opens as three lines with holes between their offsets — what an ELAN file with pauses already looks like
  const back = parseFlextext(xml, SETTINGS).texts[0];
  assert.equal(back.paragraphs.length, 3);
  assert.deepEqual(segmentsFromOffsets(back).map((s) => [s.start, s.end]), [[0, 2000], [3000, 5000], [5500, 7000]]);
  // a silent segment with a translation, or with an imported note, is still written
  const kept = doc5(); kept.paragraphs[1].segments[0].free = 'untranslatable aside';
  assert.equal(phrases(serializeFlextext(kept, SETTINGS, {})), 4);
  const noted = doc5(); noted.paragraphs[3].segments[0].postItemsXML = ['<item type="note" lang="id">dog barks</item>'];
  assert.equal(phrases(serializeFlextext(noted, SETTINGS, {})), 4);
  // a text with NO timing: blank paragraphs are not written either (they never were data there)
  const plain = makeDoc(SETTINGS); reconcileBaseline(plain, ['satu', '', 'dua'], { flatSegments: true }); plain.segments = [];
  assert.equal(phrases(serializeFlextext(plain, SETTINGS, {})), 2);
});

test('EAF, both profiles: no annotation over a silent segment on any tier; the slots either side do not meet', () => {
  for (const profile of ['flex', 'saymore']) {
    const eaf = serializeEaf(doc5(), { profile, vern: 'fau', anal: 'id', mediaName: 'x.wav' });
    const aligned = (eaf.match(/<ALIGNABLE_ANNOTATION /g) || []).length;
    const perTier = profile === 'flex' ? 3 /* interlinear-text 1 + paragraph 3 + phrase 3 = 7 */ : 3;
    assert.equal(aligned, profile === 'flex' ? 7 : 3, `${profile}: three phrase annotations for five pieces (${aligned} aligned annotations in all)`);
    assert.doesNotMatch(eaf, /<ANNOTATION_VALUE><\/ANNOTATION_VALUE>(?![\s\S]*TIER_ID="A_phrase-txt)/.source === '' ? /x/ : /TIER_ID="A_phrase-txt-fau"[\s\S]*?<ANNOTATION_VALUE><\/ANNOTATION_VALUE>[\s\S]*?TIER_ID="A_phrase-gls-id"/, `${profile}: no empty value on the phrase tier`);
    const slots = Object.fromEntries([...eaf.matchAll(/TIME_SLOT_ID="(ts\d+)" TIME_VALUE="(\d+)"/g)].map((m) => [m[1], +m[2]]));
    const tier = profile === 'flex' ? 'A_phrase-txt-fau' : 'Transcription';
    const body = eaf.slice(eaf.indexOf(`TIER_ID="${tier}"`));
    const refs = [...body.matchAll(/TIME_SLOT_REF1="(ts\d+)" TIME_SLOT_REF2="(ts\d+)"/g)].slice(0, 3).map((m) => [slots[m[1]], slots[m[2]]]);
    assert.deepEqual(refs, [[0, 2000], [3000, 5000], [5500, 7000]], `${profile}: the phrase annotations skip the silences`);
    assert.equal(Object.values(slots).filter((v) => v === 2000).length, 1, `${profile}: one slot at 2000 — a line ends there and nothing starts there`);
  }
});

test('the listening page and the .fxpa are NOT in scope: they keep every piece, blank ones included', () => {
  const d = doc5();
  const html = buildSegPreviewHtml(d, { vern: 'fau', anal: 'id' });
  assert.equal((html.match(/<div class="seg( blank)?"/g) || []).length, 5, 'five rows on the listening page');
  assert.equal(buildFxpa(d, { title: 'T', vernLang: 'fau', analLang: 'id' }).lines.length, 5, 'five lines in the Paragraph Analysis file');
});
