/* A FLEX TEXT THROUGH THE AUDIO SEGMENTER AND BACK (Seth's FLEx round-trip report, 2026-10-17).
 *
 * A FLEx 9 export went through the Segmenter (v716) and came back with: its 13 hard line breaks (U+2028
 * phrases) gone and 11 text phrases wearing their GUIDs; every split piece with a new GUID; an English
 * word gloss and two free translations saved as Indonesian; times FLEx could not import (no media-file);
 * a note on every phrase; a GUID on a punctuation word. These are Seth's five acceptance tests, plus one
 * per root cause, on a made-up fixture in FLEx 9's own shape (test/fixtures/flex-roundtrip): the real
 * text is a community's language and stays off this public repo — `node tools/flextext-roundtrip.mjs
 * <file>` runs the same checks on any real file, locally. The Segmenter's own functions are lifted from
 * app.js (test/lib/lift.mjs), so what is tested is what ships.
 *
 * Run: node test/flextext-roundtrip.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flextextModel, flextextDiff, phrasesOf, itemValue } from './lib/flextext-semantic.mjs';
import { FT, APP, normalizePhraseLines, ensureMediaRef, importAs, exportOf, matcher } from './lib/segmenter-roundtrip.mjs';

const FIX = readFileSync(new URL('./fixtures/flex-roundtrip/flex9-shape.flextext', import.meta.url), 'utf8');
const V = 'qaa-fonipa-x-tst';
const LB = '\u2028';
const G = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const L = (n) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SEGNUM = [/^segnum\|/];   // FLEx computes it; this suite neither reads nor writes it (serializeFlextext)
const lb = (q) => itemValue(q.items, 'txt', V) === LB;
const lineOf = (m, guid) => m.lineOf(guid);

test('acceptance 1: a FLEx export opened and exported at once says the same thing — on a device in either language', () => {
  for (const analLang of ['en', 'id']) {
    const doc = importAs(FIX, analLang);
    const out = exportOf(doc);
    assert.deepEqual(flextextDiff(flextextModel(FIX), flextextModel(out), { ignore: SEGNUM }), [],
      `${analLang}: every paragraph, phrase, word and morph guid, every item by type, lang and value`);
    const ph = phrasesOf(flextextModel(out));
    assert.deepEqual(ph.filter(lb).map((q) => q.guid), [L(1), L(2), L(3), L(4)], `${analLang}: all four line breaks, with their own guids, in place`);
    assert.ok(ph.filter(lb).every((q) => !q.hasWords && q.items.length === 1), `${analLang}: each still only its txt — no <words>, no segnum`);
    assert.doesNotMatch(out, /type="note"/, `${analLang}: no notes added`);
    assert.doesNotMatch(out, /<word guid="[^"]*">\s*<item type="punct"/, `${analLang}: punctuation has no guid, as FLEx writes it`);
  }
});

test('a hard line break is not a line: it rides on the phrase beside it, in its own paragraph', () => {
  const doc = importAs(FIX, 'en');
  assert.equal(doc.paragraphs.length, 7, 'seven lines — the seven text phrases; no line for a break');
  const by = (g) => doc.paragraphs.find((p) => p.segments[0].attrs.guid === g).segments[0];
  assert.deepEqual(by(G(3)).breaksBefore.map((s) => s.attrs.guid), [L(1)], 'a break between two phrases rides on the one after it');
  assert.deepEqual(by(G(4)).breaksBefore.map((s) => s.attrs.guid), [L(2)]);
  assert.deepEqual(by(G(5)).breaksAfter.map((s) => s.attrs.guid), [L(3)], 'at a paragraph\'s end, on the one before it');
  assert.deepEqual(by(G(6)).breaksBefore.map((s) => s.attrs.guid), [L(4)], 'at a paragraph\'s start, on the one after it');
  assert.ok(doc.paragraphs.every((p) => !FT.isLineBreakPhrase(p.segments[0])), 'no line is a break');
  // a paragraph of nothing but breaks has no phrase to carry them: they stay its lines
  const only = FT.parseFlextext(FIX.replace(/<paragraph guid="cccccccc-0000-4000-8000-000000000005">[\s\S]*?<\/paragraph>/,
    `<paragraph guid="cccccccc-0000-4000-8000-000000000005"><phrases><phrase guid="${L(9)}"><item type="txt" lang="${V}">${LB}</item></phrase></phrases></paragraph>`), { analLang: 'en' }).texts[0];
  normalizePhraseLines(only);
  assert.ok(only.paragraphs.some((p) => p.segments[0].attrs.guid === L(9)), 'kept as a line');
  assert.match(exportOf(only), new RegExp(`<phrase guid="${L(9)}">\\s*<item type="txt" lang="${V}">${LB}</item>\\s*</phrase>`), 'and written back as it came');
});

test('acceptance 2: split a phrase and edit both free translations in English — the first piece keeps the guid; only en changes', () => {
  const doc = importAs(FIX, 'id');   // the device on Indonesian, the text's primary English: the case that went wrong
  const m = matcher(doc);
  const id = lineOf(m, G(1));
  m.mgSplitLine(id, 2, { en: 'one two '.length });     // "kaa tii:" | "moo", "one two" | "three four"
  const [a, b] = [id + 'a', id + 'b'].map((x) => m.MG.lines.find((l) => l.id === x));   // mgSplitLine's two pieces
  m.mgEditFree(a.id, 'one, two');
  m.mgEditFree(b.id, 'three; four');
  m.commitTo(doc);
  const out = flextextModel(exportOf(doc));
  const ph = phrasesOf(out);
  const k = ph.findIndex((q) => q.guid === G(1));
  const [first, second] = [ph[k], ph[k + 1]];
  assert.equal(first.guid, G(1), 'the first piece keeps the original guid');
  assert.ok(second.guid && second.guid !== G(1), 'the second piece is a new phrase');
  assert.equal(first.para, second.para, 'in the same FLEx paragraph');
  assert.deepEqual([itemValue(first.items, 'gls', 'en'), itemValue(second.items, 'gls', 'en')], ['one, two', 'three; four'], 'the edits are English');
  assert.equal(itemValue(first.items, 'gls', 'id'), 'satu dua tiga empat', 'the Indonesian free translation is untouched');
  assert.equal(itemValue(second.items, 'gls', 'id') || '', '', 'and nothing of it is copied to the new piece (at most an empty item, as FLEx writes one per writing system)');
  assert.deepEqual(first.words.concat(second.words).map((w) => itemValue(w.items, 'gls', 'id')),
    phrasesOf(flextextModel(FIX))[0].words.map((w) => itemValue(w.items, 'gls', 'id')), 'every word\'s Indonesian gloss as it was');
});

test('acceptance 3: merge two phrases across a line break — the survivor keeps the first guid, the free translation is all English', () => {
  const doc = importAs(FIX, 'id');
  const m = matcher(doc);
  m.mgJoinLine(lineOf(m, G(3)));                         // "tau" joins "rua sen", across the first break
  m.commitTo(doc);
  const out = flextextModel(exportOf(doc));
  const para2 = out.paras[1].phrases;
  assert.deepEqual(para2.map((q) => q.guid), [G(2), L(2), G(4)], 'the survivor is the first phrase; the break between them is gone, the next one kept');
  assert.equal(itemValue(para2[0].items, 'gls', 'en'), 'five six seven', 'both free translations, in English');
  assert.equal(itemValue(para2[0].items, 'gls', 'id'), '', 'nothing of them in Indonesian (its own empty item kept)');
  assert.equal(para2[0].words.map((w) => itemValue(w.items, 'txt', V)).join(' '), 'rua sen tau');
});

test('acceptance 4: edit one word\'s gloss in English — only that word\'s gls en changes', () => {
  const doc = importAs(FIX, 'id');
  const m = matcher(doc);
  m.mgEditWord(lineOf(m, G(1)), 0, 'gls', 'K-en, edited');
  m.commitTo(doc);
  assert.deepEqual(flextextDiff(flextextModel(FIX), flextextModel(exportOf(doc)), { ignore: SEGNUM }),
    ['¶1.1 word 0 items −["gls|en|K-en"] +["gls|en|K-en, edited"]']);
});

test('looking is not an edit: a click in and out of a box shown in English changes nothing (report bugs 3b, 3c)', () => {
  const doc = importAs(FIX, 'id');
  const m = matcher(doc);
  m.mgEditWord(lineOf(m, G(2)), 0, 'gls', 'R-en');       // the box shows the English gloss; the slot holds the Indonesian
  m.mgEditFree(lineOf(m, G(5)), 'ten');                 // the English free translation, as shown
  assert.equal(m.depth(), 0, 'no undo step');
  m.commitTo(doc);
  assert.deepEqual(flextextDiff(flextextModel(FIX), flextextModel(exportOf(doc)), { ignore: SEGNUM }), [], 'and the file says exactly what it did');
});

test('a merge joins each language\'s free translation in that language, whatever the slots held (report bug 3d)', () => {
  // the first phrase's English in its slot (no tag: the doc's language); the second's English in an item beside an empty Indonesian slot
  const a = FT.makeSegment('aa', [FT.makeWord('aa')], { attrs: { guid: 'A' }, free: 'the first,' });
  const b = FT.makeSegment('bb', [FT.makeWord('bb')], { attrs: { guid: 'B' }, free: '', freeLang: 'id', postItemsXML: ['<item type="gls" lang="en">the second.</item>'] });
  const m = FT.mergePhrases([a, b], { prim: 'en' });
  assert.equal(m.attrs.guid, 'A');
  assert.equal(FT.freeIn(m, 'en', 'en'), 'the first, the second.', 'English: both, in order');
  assert.equal(FT.freeIn(m, 'id', 'en'), '', 'Indonesian: nothing of the English');
  assert.equal(m.postItemsXML.filter((x) => x.includes('type="gls"')).length, 1, 'one item per language besides the slot');
});

test('the text box\'s join and split (reconcile) treat line breaks and languages the same way', () => {
  const doc = importAs(FIX, 'id');
  const texts = FT.getBaselineParagraphs(doc);
  const i = doc.paragraphs.findIndex((p) => p.segments[0].attrs.guid === G(3));
  // join "tau" onto "rua sen" (across the first break), and split "vio nam"
  const next = [...texts.slice(0, i - 1), texts[i - 1] + ' ' + texts[i], 'vio', 'nam', ...texts.slice(i + 2)];
  FT.reconcileBaseline(doc, next, { flatSegments: true });
  const segs = doc.paragraphs.map((p) => p.segments[0]);
  const joined = segs.find((s) => s.attrs.guid === G(2));
  assert.ok(!joined.breaksBefore && !joined.breaksAfter, 'the break between the joined lines is gone');
  assert.equal(FT.freeIn(joined, 'en', 'en'), 'five six seven', 'their English joined in English');
  const vio = segs.find((s) => s.attrs.guid === G(4)), nam = segs[segs.indexOf(vio) + 1];
  assert.deepEqual(vio.breaksBefore.map((s) => s.attrs.guid), [L(2)], 'a split\'s first piece keeps the break before the line');
  assert.ok(!nam.breaksBefore, 'and only it');
  const out = phrasesOf(flextextModel(exportOf(doc)));
  assert.deepEqual(out.filter(lb).map((q) => q.guid), [L(2), L(3), L(4)], 'the file has the three breaks that remain, each where it was');
});

test('the Matcher\'s ✂ keeps a line\'s breaks where they were: before it on the first piece, after it on the last', () => {
  const s = FT.makeSegment('aa bb', [FT.makeWord('aa'), FT.makeWord('bb')], { attrs: { guid: 'S' }, free: 'x y' });
  const before = FT.makeSegment(LB, [], { attrs: { guid: 'LB1' } }), after = FT.makeSegment(LB, [], { attrs: { guid: 'LB2' } });
  s.breaksBefore = [before]; s.breaksAfter = [after];
  const doc = { analLang: 'en', paragraphs: [{ guid: 'P', segments: [s] }], segments: [] };
  const m = matcher(doc);
  m.mgSplitLine('ln0', 1, { en: 2 });
  const [a, b] = m.MG.lines.map((l) => l.phrases[0]);
  assert.deepEqual([a.breaksBefore && a.breaksBefore[0].attrs.guid, a.breaksAfter, b.breaksBefore, b.breaksAfter && b.breaksAfter[0].attrs.guid],
    ['LB1', undefined, undefined, 'LB2']);
});

test('acceptance 5: times — every timed phrase names a <media> the file has', () => {
  const linked = (xml) => {
    const mo = flextextModel(xml), media = new Set(mo.media.map((x) => x.guid));
    const timed = phrasesOf(mo).filter((q) => q.attrs['begin-time-offset'] != null);
    return { timed, media: mo.media, ok: timed.length > 0 && timed.every((q) => media.has(q.attrs['media-file'])) };
  };
  const timedDoc = (analLang) => {
    const doc = importAs(FIX, analLang);
    doc.segments = doc.paragraphs.map((_, i) => ({ start: i * 1000, end: i * 1000 + 900 }));
    return doc;
  };
  // the app's own block (written when audio is attached) — the case the reported text went out in
  const doc = timedDoc('id');
  ensureMediaRef({ doc, mediaGuid: null }, 'story.m4a', '');
  const a = linked(exportOf(doc));
  assert.ok(a.ok && a.timed.length === 7, `all ${a.timed.length} timed phrases link to the app's <media>`);
  assert.deepEqual(a.media.map((x) => [x.location, x.offsetType]), [['story.m4a', 'milliseconds']]);
  assert.ok(phrasesOf(flextextModel(exportOf(doc))).filter(lb).every((q) => q.attrs['begin-time-offset'] == null), 'a line break gets no time');
  // no block yet, a name to give it: one is minted, in milliseconds
  const b = linked(exportOf(timedDoc('en'), { mediaName: 'story.wav' }));
  assert.ok(b.ok && b.media.length === 1 && b.media[0].offsetType === 'milliseconds', 'minted, and every phrase links to it');
});

test('a <media-files> block from FLEx stays as it came, and the times go out linked to its media', () => {
  const M = '99999999-0000-4000-8000-000000000001', where = 'D:\\Recordings\\made-up story.wav';
  const xml = FIX.replace('    <languages>', `    <media-files offset-type="milliseconds">\r\n      <media guid="${M}" location="${where}" />\r\n    </media-files>\r\n    <languages>`)
    .replace(`<phrase guid="${G(1)}">`, `<phrase guid="${G(1)}" begin-time-offset="0" end-time-offset="900" media-file="${M}">`);
  const doc = importAs(xml, 'en');
  const rec = { doc, mediaGuid: null };
  ensureMediaRef(rec, 'story.m4a', '');   // the user attaches the recording in the app
  assert.equal(doc.mediaXML.length, 1, 'the block is FLEx\'s still');
  doc.segments = doc.paragraphs.map((_, i) => ({ start: i * 1000, end: i * 1000 + 900 }));
  const out = flextextModel(exportOf(doc));
  assert.deepEqual(out.media, [{ guid: M, location: where, offsetType: 'milliseconds' }], 'its media guid and full path exactly');
  assert.ok(phrasesOf(out).filter((q) => q.attrs['begin-time-offset'] != null).every((q) => q.attrs['media-file'] === M), 'every timed phrase points at it');
});

test('the audio notes are written only when asked for', () => {
  const doc = importAs(FIX, 'en');
  doc.segments = doc.paragraphs.map((_, i) => ({ start: i * 1000, end: i * 1000 + 900 }));
  assert.doesNotMatch(exportOf(doc, { mediaName: 'a.wav' }), /type="note"/, 'off by default');
  assert.equal((exportOf(doc, { mediaName: 'a.wav', timeNotes: true }).match(/type="note"[^>]*>audio /g) || []).length, 7, 'on when the device setting asks');
  assert.match(APP, /timeNotes: settings\.segTimeNotes === true/, 'and the app asks only when segTimeNotes is set');
});

test('each item goes back where it stood: a word\'s gloss among its items, a phrase\'s free translation among its own', () => {
  for (const analLang of ['en', 'id']) {
    const out = exportOf(importAs(FIX, analLang));
    const word = out.slice(out.indexOf('<word guid="bbbbbbbb-0000-4000-8000-000000000002">'));
    const order = [...word.slice(0, word.indexOf('</word>')).matchAll(/<item type="(\w+)" lang="([^"]+)"/g)].map((x) => x[1] + ':' + x[2]);
    assert.deepEqual(order, [`txt:${V}`, 'gls:id', 'gls:en', 'pos:en'], `${analLang}: a word as FLEx wrote it`);
    const phrase = out.slice(out.indexOf(`<phrase guid="${G(5)}">`));
    const pOrder = [...phrase.slice(0, phrase.indexOf('</phrase>')).replace(/<words>[\s\S]*<\/words>/, '').matchAll(/<item type="(\w+)" lang="([^"]+)"/g)].map((x) => x[1] + ':' + x[2]);
    assert.deepEqual(pOrder, [`txt:${V}`, 'gls:en', 'gls:id'], `${analLang}: a phrase as FLEx wrote it (segnum aside)`);
  }
  // a phrase's own items from before <words> go back before it, not inside it
  const before = FIX.replace(`<phrase guid="${G(7)}">\r\n            <item type="txt" lang="${V}">kaa zoe </item>`,
    `<phrase guid="${G(7)}">\r\n            <item type="txt" lang="${V}">kaa zoe </item>\r\n            <item type="txt" lang="qaa">kaa zoe </item>`);
  assert.notEqual(before, FIX);
  const out = exportOf(importAs(before, 'en'));
  const p7 = out.slice(out.indexOf(`<phrase guid="${G(7)}">`), out.indexOf('</phrase>', out.indexOf(`<phrase guid="${G(7)}">`)));
  assert.ok(p7.indexOf('<item type="txt" lang="qaa">') < p7.indexOf('<words>'), 'another vernacular\'s txt stays before <words>');
});
