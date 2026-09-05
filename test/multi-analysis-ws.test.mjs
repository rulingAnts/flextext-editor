// Seth, 2026-09-05: "we need to be able to select analysis writing system for gloss and for free
// translation if there are multiple choices. Our conversion utility needs to check for that and
// render it. Our ELAN and SayMore exports should export all that are present."
// The editor edits one language and preserves the others verbatim; these pin that the readers
// see every language, the EAF gets a tier per language, and the listening page gets pickers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDoc, reconcileBaseline, wordGlosses, phraseFrees, analysisLangs, glossIn, freeIn } from '../docs/js/flextext.js';
import { serializeEaf, serializeEafPrefs, buildSegPreviewHtml } from '../docs/js/seg-exports.js';

/* Indonesian is the edited language; English rides preserved, exactly as parseFlextext leaves it:
 * a top-level <item type="gls" lang="en"> per word and per phrase. The <morphemes> block also holds
 * gls items — morpheme glosses, which must NOT be mistaken for a third word gloss. */
function twoLangDoc() {
  const doc = makeDoc({ vernLang: 'fau', analLang: 'id' });
  reconcileBaseline(doc, ['ka fo', 'du'], { flatSegments: true });
  const [p1, p2] = doc.paragraphs;
  const s1 = p1.segments[0], s2 = p2.segments[0];
  s1.words[0].gls = 'pergi'; s1.words[0].glsLang = 'id';
  s1.words[0].preservedXML = ['<item type="gls" lang="en">go &amp; run</item>', '<morphemes><morph><item type="gls" lang="en">GO</item></morph></morphemes>', '<item type="pos" lang="en">v</item>'];
  s1.words[1].gls = 'dia'; s1.words[1].glsLang = 'id';      // no English gloss on this word
  s1.free = 'Dia pergi'; s1.freeLang = 'id';
  s1.postItemsXML = ['<item type="gls" lang="en">He goes</item>', '<item type="note" lang="en">a note</item>'];
  s2.words[0].gls = 'batu'; s2.words[0].glsLang = 'id';
  s2.words[0].preservedXML = ['<item type="gls" lang="en">stone</item>'];
  s2.free = 'Batu'; s2.freeLang = 'id';
  doc.segments = [{ start: 0, end: 2000 }, { start: 2000, end: 4000 }];
  return doc;
}
function oneLangDoc() {
  const doc = makeDoc({ vernLang: 'fau', analLang: 'id' });
  reconcileBaseline(doc, ['ka fo'], { flatSegments: true });
  const s = doc.paragraphs[0].segments[0];
  s.words[0].gls = 'pergi'; s.free = 'Dia pergi';
  doc.segments = [{ start: 0, end: 2000 }];
  return doc;
}

test('the readers see the edited language first and every preserved language once, top-level items only', () => {
  const doc = twoLangDoc();
  const w = doc.paragraphs[0].segments[0].words[0];
  assert.deepEqual(wordGlosses(w), [{ lang: 'id', text: 'pergi' }, { lang: 'en', text: 'go & run' }], 'entities unescaped; the morpheme gloss and the pos item ignored');
  assert.deepEqual(phraseFrees(doc.paragraphs[0].segments[0]), [{ lang: 'id', text: 'Dia pergi' }, { lang: 'en', text: 'He goes' }]);
  assert.deepEqual(analysisLangs(doc), { gloss: ['id', 'en'], free: ['id', 'en'] });
  assert.equal(glossIn(w, 'en', 'id'), 'go & run');
  assert.equal(glossIn(doc.paragraphs[0].segments[0].words[1], 'en', 'id'), '', 'a word with no gloss in that language reads empty');
  assert.equal(freeIn(doc.paragraphs[0].segments[0], 'en', 'id'), 'He goes');
  const app = oneLangDoc();
  assert.deepEqual(analysisLangs(app), { gloss: ['id'], free: ['id'] }, 'an app-authored text has one language: its own');
  assert.deepEqual(wordGlosses(app.paragraphs[0].segments[0].words[0]), [{ lang: '', text: 'pergi' }], 'lang is blank when the app typed it; callers map blank to the primary');
});

test('the FLEx-profile EAF carries one gloss tier and one free tier per language, primary first', () => {
  const eaf = serializeEaf(twoLangDoc(), { profile: 'flex', vern: 'fau', anal: 'id', mediaName: 'story.wav' });
  const at = (s) => eaf.indexOf(s);
  for (const tier of ['A_word-gls-id', 'A_word-gls-en', 'A_phrase-gls-id', 'A_phrase-gls-en']) assert.ok(at(`TIER_ID="${tier}"`) > 0, tier);
  assert.ok(at('TIER_ID="A_word-gls-id"') < at('TIER_ID="A_word-gls-en"'), 'the edited language first, so a first-match reader still lands on it');
  assert.ok(at('TIER_ID="A_phrase-gls-id"') < at('TIER_ID="A_phrase-gls-en"'));
  assert.match(eaf, /PARENT_REF="A_word-txt-fau" TIER_ID="A_word-gls-en"/, 'the extra gloss tier hangs off the same word tier');
  assert.match(eaf, /PARENT_REF="A_phrase-txt-fau" TIER_ID="A_phrase-gls-en"/, 'the extra free tier hangs off the same phrase tier');
  const enGloss = eaf.slice(at('TIER_ID="A_word-gls-en"'), at('TIER_ID="A_phrase-gls-id"'));
  assert.match(enGloss, /<ANNOTATION_VALUE>go &amp; run<\/ANNOTATION_VALUE>/, 'escaped on the way out');
  assert.match(enGloss, /<ANNOTATION_VALUE>stone<\/ANNOTATION_VALUE>/);
  assert.doesNotMatch(enGloss, /<ANNOTATION_VALUE>GO<\/ANNOTATION_VALUE>/, 'the morpheme gloss is not a word gloss');
  assert.equal((enGloss.match(/<REF_ANNOTATION /g) || []).length, 2, 'the word with no English gloss gets no annotation, not an empty one');
  const idGloss = eaf.slice(at('TIER_ID="A_word-gls-id"'), at('TIER_ID="A_word-gls-en"'));
  assert.equal((idGloss.match(/<REF_ANNOTATION /g) || []).length, 3, 'the primary tier is unchanged: every glossed word');
  const enFree = eaf.slice(at('TIER_ID="A_phrase-gls-en"'), at('<LINGUISTIC_TYPE '));
  assert.match(enFree, /<ANNOTATION_VALUE>He goes<\/ANNOTATION_VALUE>/);
  assert.equal((enFree.match(/<REF_ANNOTATION /g) || []).length, 1, 'only the phrase that has an English translation');
  assert.equal((eaf.match(/LINGUISTIC_TYPE_ID="wordGloss"/g) || []).length, 1, 'one type declaration serves every gloss tier');
});

test('a one-language text exports exactly as before; SayMore keeps its two documented tiers', () => {
  const one = serializeEaf(oneLangDoc(), { profile: 'flex', vern: 'fau', anal: 'id' });
  assert.equal((one.match(/TIER_ID="A_word-gls-/g) || []).length, 1);
  assert.equal((one.match(/TIER_ID="A_phrase-gls-/g) || []).length, 1);
  const say = serializeEaf(twoLangDoc(), { profile: 'saymore', vern: 'fau', anal: 'id' });
  assert.equal((say.match(/<TIER /g) || []).length, 2, 'Transcription + Free Translation only');
  assert.match(say, /TIER_ID="Free Translation"/);
  assert.match(say, /<ANNOTATION_VALUE>Dia pergi<\/ANNOTATION_VALUE>/, 'the primary language');
  assert.doesNotMatch(say, /He goes/, 'the second language lives in the ELAN .eaf beside it');
});

test('the ELAN sidecar orders every gloss tier before every free tier, both primary first', () => {
  const doc = twoLangDoc();
  const pf = serializeEafPrefs({ profile: 'flex', vern: 'fau', anal: 'id', doc });
  const order = [...pf.matchAll(/<String>([^<]+)<\/String>/g)].map((m) => m[1]);
  assert.deepEqual(order, ['A_phrase-txt-fau', 'A_word-txt-fau', 'A_word-gls-id', 'A_word-gls-en', 'A_phrase-gls-id', 'A_phrase-gls-en', 'A_paragraph', 'A_interlinear-text-title-id']);
  const plain = serializeEafPrefs({ profile: 'flex', vern: 'fau', anal: 'id' });
  assert.deepEqual([...plain.matchAll(/<String>([^<]+)<\/String>/g)].map((m) => m[1]), ['A_phrase-txt-fau', 'A_word-txt-fau', 'A_word-gls-id', 'A_phrase-gls-id', 'A_paragraph', 'A_interlinear-text-title-id'], 'without a doc: the old primary pair');
});

test('the listening page carries every language, shows the primary, and offers a picker per tier', () => {
  const html = buildSegPreviewHtml(twoLangDoc(), { title: 'T' });
  assert.match(html, /<select id="glossws"><option value="id" selected>id<\/option><option value="en">en<\/option><\/select>/);
  assert.match(html, /<select id="freews"><option value="id" selected>id<\/option><option value="en">en<\/option><\/select>/);
  assert.match(html, /<span class="wg" data-l="id">pergi<\/span><span class="wg" data-l="en" hidden>go &amp; run<\/span>/, 'primary visible, the other hidden until picked');
  assert.match(html, /<span class="wg" data-l="id">dia<\/span><span class="wg" data-l="en" hidden> <\/span>/, 'a missing gloss keeps its slot so columns stay aligned');
  assert.match(html, /<div class="free" data-l="id">Dia pergi<\/div><div class="free" data-l="en" hidden>He goes<\/div>/);
  assert.match(html, /getElementById\('glossws'\)/, 'the picker script rides along');
  assert.match(html, /els\[i\]\.hidden = els\[i\]\.getAttribute\('data-l'\) !== lang/);
  const one = buildSegPreviewHtml(oneLangDoc(), { title: 'T' });
  assert.doesNotMatch(one, /id="glossws"|id="freews"|class="ws"/, 'one language: no picker');
  assert.doesNotMatch(one, /getElementById\('glossws'\)/, 'and no picker script');
  assert.match(one, /<span class="wg" data-l="id">pergi<\/span>/);
});
