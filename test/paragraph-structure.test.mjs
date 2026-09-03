/* PARAGRAPH vs PHRASE: what we render, and what we write back.
 *
 * THE RENDER IS ALWAYS ONE LINE PER PHRASE (Seth: "our editor and our segmenter need to split
 * phrase-level so that every phrase (whether daughters of the same or different paragraph) is its
 * own line … in the UI/render"). That is not in question here and never varies.
 *
 * THE EXPORT is where the question lives, and the default is deliberately FLAT — one <paragraph>
 * per phrase — because a maximally-split file means an ELAN annotator only ever MERGES, which ELAN
 * can do, and never splits at a higher level, which it cannot. See plans/preserve-paragraph-
 * structure.md; that rationale is the reason a "fix" for the flat export was drafted and abandoned.
 *
 * What IS preserved is a distinction the author actually made. Seth: "if the FLExText file is 1
 * paragraph with many phrases OR many paragraphs 1 phrase each, then use our default export. If
 * there is a mixture … we want to remember and preserve that … fall back to flat paragraph-breaking
 * if it fails to produce a valid flextext or is uncertain enough."
 *
 * Run: node test/paragraph-structure.test.mjs
 */
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { parseFlextext, serializeFlextext, newGuid } = await import('../docs/js/flextext.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');

const phrase = (v) => `<phrase><item type="txt" lang="und">${v}</item>`
  + `<words><word><item type="txt" lang="und">${v}</item>`
  + `<item type="gls" lang="en">g</item></word></words>`
  + `<item type="gls" lang="en">free ${v}</item></phrase>`;
const para = (guid, ...vs) => `<paragraph guid="${guid}"><phrases>${vs.map(phrase).join('')}</phrases></paragraph>`;
const docXml = (...paras) => `<?xml version="1.0" encoding="utf-8"?><document version="2">`
  + `<interlinear-text><item type="title" lang="en">T</item><paragraphs>${paras.join('')}</paragraphs>`
  + `</interlinear-text></document>`;
const parse = (xml) => parseFlextext(xml, { vernLang: 'und', analLang: 'en' }).texts[0];

/* normalizePhraseLines' rule, replicated. Kept honest by the source assertions at the bottom: if
 * app.js's version changes shape, those fail and this replication must be revisited. */
function normalize(doc) {
  const multi = doc.paragraphs.filter((p) => (p.segments || []).length > 1).length;
  const structured = doc.paragraphs.length > 1 && multi > 0;
  if (multi > 0) {
    doc.paragraphs = doc.paragraphs.flatMap((p) => ((p.segments || []).length > 1
      ? p.segments.map((s, k) => ({ guid: k === 0 ? p.guid : newGuid(), segments: [s],
                                    ...(structured ? { paraOf: p.guid } : {}) }))
      : [structured ? { ...p, paraOf: p.guid } : p]));
    doc.segments = [];
  }
  return { doc, structured };
}
const out = (doc) => serializeFlextext(doc, { vernLang: 'und', analLang: 'en' }, {});
const paraCount = (xml) => (xml.match(/<paragraph\b/g) || []).length;
const paraGuids = (xml) => [...xml.matchAll(/<paragraph guid="([^"]+)"/g)].map((m) => m[1]);
const phraseCount = (xml) => (xml.match(/<phrase\b/g) || []).length;

console.log('\nthe render is one line per phrase — in every shape, without exception');
for (const [name, xml] of [
  ['1 paragraph of 3 phrases', docXml(para('pA', 'a', 'b', 'c'))],
  ['3 paragraphs of 1 phrase', docXml(para('pA', 'a'), para('pB', 'b'), para('pC', 'c'))],
  ['mixed: 2 + 1', docXml(para('pA', 'a', 'b'), para('pB', 'c'))],
]) {
  const { doc } = normalize(parse(xml));
  ok(doc.paragraphs.length === 3 && doc.paragraphs.every((p) => p.segments.length === 1),
     `${name} → 3 lines, one phrase each`);
}

console.log('\nUNIFORM shapes take the default flat export, and are never tagged');
{
  const a = normalize(parse(docXml(para('pA', 'a', 'b', 'c'))));
  ok(!a.structured, '1 paragraph of many phrases is not a deliberate distinction');
  ok(a.doc.paragraphs.every((p) => p.paraOf === undefined), '…so no line carries paraOf');
  ok(paraCount(out(a.doc)) === 3, '…and it exports flat: 3 <paragraph>, one per phrase (the ELAN property)');

  const b = normalize(parse(docXml(para('pA', 'a'), para('pB', 'b'), para('pC', 'c'))));
  ok(!b.structured, 'many paragraphs of one phrase each is already 1:1 — nothing to remember');
  ok(paraCount(out(b.doc)) === 3, '…and exports as the 3 paragraphs it always was');
}

console.log('\nA MIXTURE is a decision, and is preserved');
{
  const { doc, structured } = normalize(parse(docXml(para('pA', 'a', 'b'), para('pB', 'c'))));
  ok(structured, '2 paragraphs, one holding 2 phrases → the author distinguished the two');
  ok(doc.paragraphs.length === 3, 'still 3 lines in memory (the render never changes)');
  const xml = out(doc);
  ok(paraCount(xml) === 2, 'but it exports as 2 <paragraph>, not 3');
  ok(phraseCount(xml) === 3, 'with all 3 phrases still present');
  const gs = paraGuids(xml);
  ok(gs.length === new Set(gs).size, 'no duplicate paragraph guids');
  ok(gs[0] === 'pA' && gs[1] === 'pB', 'and the ORIGINAL guids, not minted ones — FLEx honours guids');
}

console.log('\nit gives up rather than guess: non-consecutive lines fall back to flat');
{
  // Hand-built: paragraph pA's lines are no longer adjacent. Emitting pA twice would put one guid
  // on two <paragraph> elements — invalid, and FLEx would read it as two paragraphs anyway.
  const { doc } = normalize(parse(docXml(para('pA', 'a', 'b'), para('pB', 'c'))));
  const [l0, l1, l2] = doc.paragraphs;
  doc.paragraphs = [l0, l2, l1];              // pA, pB, pA
  const xml = out(doc);
  const gs = paraGuids(xml);
  ok(gs.length === new Set(gs).size, 'no guid is emitted twice');
  ok(paraCount(xml) === 3, 'the whole document falls back to flat — one paragraph per line');
  ok(phraseCount(xml) === 3, 'and no phrase is lost in the fallback');
}

console.log('\nedits carry the memory (matcher split/join), and a join cannot orphan a paragraph');
{
  ok(/paraOf: line\.paraOf/.test(app), 'a split leaves both halves in the paragraph they came from');
  ok(/paraOf: prev\.paraOf/.test(app), 'a join takes the FIRST line\'s paragraph — the break between them is what was removed');
  ok(/\.\.\.\(l\.paraOf == null \? \{\} : \{ paraOf: l\.paraOf \}\)/.test(app), 'and mgCommit writes it back');
  ok(/paraOf: p\.paraOf/.test(app), 'mgLoad carries it in');
}

console.log('\nthe source rule matches the one replicated here');
{
  ok(/const multi = doc\.paragraphs\.filter\(\(p\) => \(p\.segments \|\| \[\]\)\.length > 1\)\.length;/.test(app),
     'app.js counts multi-phrase paragraphs the same way');
  ok(/const structured = doc\.paragraphs\.length > 1 && multi > 0;/.test(app),
     'and defines "structured" as >1 paragraph AND at least one holding several phrases');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nall ok\n');
process.exit(fail ? 1 : 0);
