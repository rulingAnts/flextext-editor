/* THE APP'S COPY OF A FLEx TEXT, AS A .flextext FLEx CAN READ (2026-10-17). Seth worked for hours in a read-only
 * session, and "Export bundle…" wrote FLEx's copy, without any of it — the app's own download lived on the
 * Segmenter's list, which leaves FLEx texts to the FLEx section. And the app's writer, given the shell's record,
 * wrote a file FLEx could not import: each word's id was the shell's occurrence key (`<guid>:<index>`, and FLEx's
 * importer calls `new Guid()` on it), the times named no recording FLEx has, one analysis language of two was
 * declared, and a hard line break was an empty phrase with a word in it. flextext.js flexExportDoc makes the record
 * the file FLEx's own exporter would write, with the work in it; what a word's id may claim is postStateOf's rule.
 * The e2e test (desktop/tests/e2e) downloads one from a FLEx text's row. Made-up data.
 *
 * Run: node test/flex-export.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FT, importAs } from './lib/segmenter-roundtrip.mjs';

const id = (k, n) => `${k.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AN = (n) => id('a', n), SG = (n) => id('b', n), PA = (n) => id('c', n);
const TEXT = id('d', 1), LINK = id('e', 1);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCATION = 'C:\\Example\\Recordings\\story.wav';
const glsXml = (lang, t) => `<item type="gls" lang="${lang}">${t}</item>`;

// A FLEx text as the shell gives it (desktop/flexshell/model.py to_engine_doc): one line per segment; each word with
// the occurrence it was read as; glosses in the primary analysis language in the editable slot, the others as items.
const word = (txt, an, i, sg, g = {}) => ({ guid: an + ':' + i, txt, punct: false, phrase: false,
  gls: g.en || '', ...(g.en ? { glsLang: 'en', glosses: g } : {}), preservedXML: Object.entries(g).filter(([l]) => l !== 'en').map(([l, t]) => glsXml(l, t)),
  flex: { analysisGuid: an, analysisKind: Object.keys(g).length ? 'gloss' : 'wordform', index: i, seg: sg } });
const punct = (txt, i, sg) => ({ guid: id('f', 9) + ':' + i, txt, punct: true, phrase: false, gls: '', preservedXML: [], flex: { analysisGuid: id('f', 9), analysisKind: 'punct', index: i, seg: sg } });
const seg = (sg, baseline, words, { ft = {}, lt = {}, times = null } = {}) => ({
  attrs: { guid: sg, ...(times ? { 'begin-time-offset': String(times[0]), 'end-time-offset': String(times[1]), 'media-file': LINK } : {}) },
  baseline, words, free: ft.en || '', freeLang: ft.en ? 'en' : null, frees: { ...ft }, lits: { ...lt },
  preItemsXML: [], postItemsXML: Object.entries(ft).filter(([l]) => l !== 'en').map(([l, t]) => glsXml(l, t)), txtLang: 'qaa',
  flex: { paraGuid: null, segGuid: sg, notes: [] } });
const brk = (sg) => ({ ...seg(sg, '', [punct('\u2028', 0, sg)]), readOnly: true });
const line = (s, para) => ({ guid: 'ln-' + s.attrs.guid, paraOf: para, segments: [s], flex: { paraGuid: para, segGuid: s.attrs.guid } });
function flexDoc() {
  const s1 = SG(1), s3 = SG(3), s4 = SG(4);
  return {
    title: 'A story', vernLang: 'qaa', analLang: 'en', languages: [], appAuthored: false, timeEdges: true,
    flex: { textGuid: TEXT, ws: { vern: 'qaa', anal: 'en' }, anals: ['en', 'id'], media: [{ uriGuid: LINK, uri: LOCATION, url: null }] },
    paragraphs: [
      line(seg(s1, 'aa bb.', [word('aa', AN(1), 0, s1, { en: 'A', id: 'A-id' }), word('bb', AN(2), 1, s1, { en: 'B' }), punct('.', 2, s1)],
        { ft: { en: 'one', id: 'satu' }, lt: { en: 'lit one' }, times: [0, 900] }), PA(1)),
      line(brk(SG(2)), PA(1)),
      line(seg(s3, 'cc dd', [word('cc', AN(3), 0, s3), word('dd', AN(4), 1, s3)], { ft: { id: 'dua' } }), PA(1)),
      line(seg(s4, 'ee', [word('ee', AN(5), 0, s4)]), PA(2)),
    ],
    // line 3 is timed HERE (FLEx has no time for it); the break and line 4 have none
    segments: [{ start: 0, end: 900 }, { start: 0, end: 0, timePending: true }, { start: 1000, end: 1900 }, { start: 0, end: 0, timePending: true }],
  };
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const stateOf = (base) => ({ base, recording: { source: 'flex', name: 'story.wav', uriGuid: LINK } });
const write = (doc, state = stateOf(clone(doc))) => FT.serializeFlextext(FT.flexExportDoc(doc, state), { analLang: doc.analLang }, { segTimes: true, producedBy: 'test', mediaName: 'A story.wav' });
const attrsOf = (xml, el) => [...xml.matchAll(new RegExp(`<${el}(?=[\\s/>])([^>]*)>`, 'g'))].map((m) => Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])));
const phrases = (xml) => [...xml.matchAll(/<phrase\b[^>]*>[\s\S]*?<\/phrase>/g)].map((m) => m[0]);
const wordGuids = (ph) => [...ph.matchAll(/<word\b([^>]*)>\s*<item type="(txt|punct)"[^>]*>([^<]*)</g)].map((m) => [m[3], (m[1].match(/guid="([^"]*)"/) || [])[1] || null]);

test('every id in the file is one FLEx\'s importer reads: the text\'s, FLEx\'s phrase guids, each word\'s analysis — never the shell\'s occurrence key', () => {
  const xml = write(flexDoc());
  assert.ok(!/guid="[^"]*:/.test(xml), 'no `<guid>:<index>`: FLEx\'s importer calls new Guid() on a word\'s id');
  for (const el of ['interlinear-text', 'paragraph', 'phrase', 'word', 'media']) {
    for (const a of attrsOf(xml, el)) if ('guid' in a) assert.match(a.guid, GUID, `${el} guid ${a.guid}`);
  }
  assert.equal(attrsOf(xml, 'interlinear-text')[0].guid, TEXT, 'the text\'s own guid: FLEx\'s import offers to merge into it');
  assert.deepEqual(attrsOf(xml, 'phrase').map((a) => a.guid), [SG(1), SG(2), SG(3), SG(4)]);
  assert.deepEqual(wordGuids(phrases(xml)[0]), [['aa', AN(1)], ['bb', AN(2)], ['.', null]], 'a word: its analysis; punctuation: none, as FLEx writes it');
});

test('times name FLEx\'s own recording link, its location as FLEx has it — a line timed here too', () => {
  const xml = write(flexDoc());
  const media = attrsOf(xml, 'media');
  assert.deepEqual(media, [{ guid: LINK, location: LOCATION.replace(/\\/g, '\\') }], 'FLEx\'s link, nothing minted: a merging import writes the location back');
  const timed = attrsOf(xml, 'phrase').filter((a) => a['begin-time-offset'] != null);
  assert.deepEqual(timed.map((a) => [a.guid, a['begin-time-offset'], a['end-time-offset'], a['media-file']]),
    [[SG(1), '0', '900', LINK], [SG(3), '1000', '1900', LINK]]);
  assert.match(xml, /<media-files offset-type="milliseconds">/);
});

test('every writing system is declared; a hard line break is written as FLEx writes one; literal translations stay', () => {
  const xml = write(flexDoc());
  const declared = attrsOf(xml, 'language');
  assert.deepEqual(declared.map((l) => [l.lang, l.vernacular || '']), [['qaa', 'true'], ['en', ''], ['id', '']]);
  const used = new Set([...xml.matchAll(/<item [^>]*lang="([^"]+)"/g)].map((m) => m[1]));
  for (const l of used) assert.ok(declared.some((d) => d.lang === l), `${l} is used and declared`);
  const lb = phrases(xml)[1];
  assert.ok(lb.includes('<item type="txt" lang="qaa">\u2028</item>') && !lb.includes('<words>'), 'its own phrase: the break as its txt, no words');
  assert.ok(phrases(xml)[0].includes('<item type="lit" lang="en">lit one</item>'));
  assert.ok(phrases(xml)[2].includes('<item type="gls" lang="id">dua</item>'), 'a translation in the second analysis language only');
});

test('a word changed here claims no FLEx id: a new gloss, a split word — the others keep theirs', () => {
  const doc = flexDoc(), base = clone(doc);
  FT.setGlossIn(doc.paragraphs[0].segments[0].words[1], 'en', 'B new', 'en');
  const s3 = doc.paragraphs[2].segments[0];
  s3.words.splice(0, 1, { guid: id('9', 1), txt: 'c', punct: false, phrase: false, gls: '', preservedXML: [] }, { guid: id('9', 2), txt: 'c', punct: false, phrase: false, gls: '', preservedXML: [] });
  s3.baseline = 'c c dd';
  const xml = write(doc, stateOf(base));
  assert.deepEqual(wordGuids(phrases(xml)[0]), [['aa', AN(1)], ['bb', null], ['.', null]],
    'bb has a gloss FLEx does not: its id would invite an edit of the gloss FLEx has, which other words may share');
  assert.deepEqual(wordGuids(phrases(xml)[2]), [['c', null], ['c', null], ['dd', AN(4)]], 'a split word\'s pieces are new words');
  assert.ok(phrases(xml)[0].includes('<item type="gls" lang="en">B new</item>') && phrases(xml)[0].includes('<item type="gls" lang="id">A-id</item>'));
});

test('a phrase split here: FLEx\'s phrase keeps its guid, the new one has its own, and every word keeps its analysis', () => {
  const doc = flexDoc(), base = clone(doc);
  const s1 = doc.paragraphs[0].segments[0];
  const tail = { ...clone(s1), attrs: { guid: id('7', 1) }, baseline: 'bb.', words: s1.words.slice(1), free: 'two', freeLang: 'en', frees: { en: 'two' }, lits: {}, postItemsXML: [] };
  doc.paragraphs.splice(1, 0, { ...line(tail, PA(1)), guid: 'ln-new' });
  s1.words = s1.words.slice(0, 1); s1.baseline = 'aa';
  doc.segments.splice(1, 0, { start: 450, end: 900 });
  doc.segments[0] = { start: 0, end: 450 };
  const xml = write(doc, stateOf(base));
  assert.deepEqual(attrsOf(xml, 'phrase').slice(0, 2).map((a) => [a.guid, a['begin-time-offset'], a['media-file']]), [[SG(1), '0', LINK], [id('7', 1), '450', LINK]]);
  assert.deepEqual([...wordGuids(phrases(xml)[0]), ...wordGuids(phrases(xml)[1])], [['aa', AN(1)], ['bb', AN(2)], ['.', null]], 'words moved to the new phrase are still FLEx\'s');
});

test('read back by the app\'s own import, nothing of the work is lost', () => {
  const doc = flexDoc();
  const back = importAs(write(doc), 'en');   // the app's import: parse, then one phrase per line
  const ph = back.paragraphs.flatMap((p) => [...(p.segments[0].breaksBefore || []), ...p.segments, ...(p.segments[0].breaksAfter || [])]);
  assert.deepEqual(ph.map((s) => s.attrs.guid), [SG(1), SG(2), SG(3), SG(4)]);
  assert.ok(FT.isLineBreakPhrase(ph[1]), 'the break reads back as FLEx\'s');
  const mine = doc.paragraphs.map((p) => p.segments[0]).filter((s) => !FT.isFlexBreakPhrase(s));
  const theirs = ph.filter((s) => !FT.isLineBreakPhrase(s));
  assert.deepEqual(theirs.map((s) => s.words.map((w) => [w.txt, FT.wordGlosses(w).map((g) => g.lang + ':' + g.text).sort()])),
    mine.map((s) => s.words.map((w) => [w.txt, FT.wordGlosses(w).map((g) => (g.lang || 'en') + ':' + g.text).sort()])), 'every word and every gloss, in every language');
  assert.deepEqual(theirs.map((s) => FT.phraseFrees(s).map((f) => f.lang + ':' + f.text).sort()),
    mine.map((s) => FT.phraseFrees(s).map((f) => (f.lang || 'en') + ':' + f.text).sort()), 'every free translation, in every language');
  assert.deepEqual(FT.segmentsFromOffsets(back).filter((s) => !s.timePending).map((s) => [s.start, s.end]), [[0, 900], [1000, 1900]], 'the times');
});

test('the record is not touched', () => {
  const doc = flexDoc(), state = stateOf(clone(doc));
  const before = JSON.stringify([doc, state]);
  write(doc, state);
  assert.equal(JSON.stringify([doc, state]), before);
});

test('a text FLEx has no recording link for: the recording chosen here, at its path', () => {
  const doc = flexDoc();
  doc.flex.media = [];
  for (const ln of doc.paragraphs) delete ln.segments[0].attrs['media-file'];
  const state = { base: clone(doc), recording: { source: 'chosen', name: 'story.wav', path: LOCATION, uriGuid: null } };
  const xml = write(doc, state);
  const media = attrsOf(xml, 'media');
  assert.equal(media.length, 1);
  assert.match(media[0].guid, GUID);
  assert.equal(media[0].location, LOCATION);
  assert.ok(attrsOf(xml, 'phrase').filter((a) => a['begin-time-offset'] != null).every((a) => a['media-file'] === media[0].guid));
});

test('the writer: a word with no guid is written with none (not guid="")', () => {
  const doc = FT.parseFlextext('<document version="2"><interlinear-text><paragraphs><paragraph guid="p"><phrases><phrase guid="s"><item type="txt" lang="qaa">aa</item><words><word guid="w1"><item type="txt" lang="qaa">aa</item></word></words></phrase></phrases></paragraph></paragraphs><languages><language lang="qaa" vernacular="true"/></languages></interlinear-text></document>', {}).texts[0];
  assert.match(FT.serializeFlextext(doc, {}, {}), /<word guid="w1">/, 'a word with a guid: as before');
  doc.paragraphs[0].segments[0].words[0].guid = '';
  assert.match(FT.serializeFlextext(doc, {}, {}), /<word>\s*<item type="txt"/);
});

/* NO TAB LEAVES IN A .flextext — FROM A FLEx TEXT TOO (the merge of tabfix-utility into desktop-flex, 2026-10-21).
 * tabfix-utility routed the OLD writer through xesc / frag; desktop-flex had rewritten that writer for FLEx (line
 * breaks, media links, guids, item order), so the merge kept desktop-flex's and routed IT through them. This pins
 * the result on the FLEx shell's own path (flexExportDoc → serializeFlextext): a tab in a baseline, a word, a word
 * gloss, another language's gloss item, a free translation, a literal one, the title — none reaches the file. */
test('a FLEx text with tabs in it: none reaches the file, and nothing else changes', () => {
  const clean = flexDoc();
  const tabbed = flexDoc();
  const s = tabbed.paragraphs[0].segments[0];
  tabbed.title = 'A\tstory';
  s.baseline = 'aa\tbb.';
  s.words[0].gls = '\tA';
  s.words[0].glosses = { ...s.words[0].glosses, en: '\tA' };
  s.words[1].txt = 'bb';
  s.words[0].preservedXML = [glsXml('id', 'A-id\t')];
  s.free = 'one\t';
  s.frees = { ...s.frees, en: 'one\t' };
  s.lits = { en: 'lit\tone' };
  s.postItemsXML = [glsXml('id', 'sa\ttu')];
  const xml = write(tabbed, stateOf(clone(clean)));
  assert.ok(!xml.includes('\t'), 'no raw tab anywhere in the file');
  assert.ok(!/&#(?:9|x0*9);/i.test(xml), 'and none written as a character reference');
  const ph = phrases(xml)[0];
  assert.match(ph, /<item type="txt" lang="qaa">aa bb\.<\/item>/, 'a tab between words is one space');
  assert.match(ph, /<item type="gls" lang="en">A<\/item>/, 'a tab at a gloss edge is nothing');
  assert.match(ph, /<item type="gls" lang="id">A-id<\/item>/, 'a kept item from another language too');
  assert.match(ph, /<item type="gls" lang="id">sa tu<\/item>/, 'and the other language\'s free translation');
  assert.match(xml, /<item type="title" lang="[^"]*">A story<\/item>/, 'the title');
  assert.deepEqual(attrsOf(xml, 'phrase').map((a) => a.guid), attrsOf(write(clean), 'phrase').map((a) => a.guid), 'every phrase keeps its FLEx guid');
  // `aa`'s stored gloss differs from FLEx's (it holds a tab), so by postStateOf's rule it claims no id — FLEx's importer
  // then finds the analysis by its glosses, which come out identical; the untouched words keep theirs
  assert.deepEqual(wordGuids(ph), [['aa', null], ['bb', AN(2)], ['.', null]]);
  assert.equal(write(clean).includes('\t'), false);
});
