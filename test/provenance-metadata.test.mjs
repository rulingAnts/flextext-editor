/* "CREATED BY …" IN EVERY EXPORT THAT CAN CARRY IT.
 *
 * Seth, 2026-09-03: "Our apps should leave metadata 'created by...' in exported files whenever the
 * schema or file format allows that." And the order of preference, which is the whole design here:
 * a DOCUMENTED optional field first, an XML COMMENT second, and NEVER a semantic field borrowed for
 * something it does not mean — "What we don't want to do is repurpose a field like AUTHOR".
 *
 * ⚠ WHY THIS EXISTS AT ALL. Asked what FLEx's segnum numbering looks like, I measured 95 .flextext
 * files from the corpus and reported that we already matched it. 68 of them had been written by our
 * own serializer — identifiable only by its indentation — so the finding was circular and the
 * provenance had to be reverse-engineered from whitespace. A file that says what wrote it answers
 * that in one line, years later, to somebody who has never seen this repo.
 *
 * Run: node test/provenance-metadata.test.mjs
 */
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { serializeFlextext, makeDoc, makeSegment } = await import('../docs/js/flextext.js');
const { serializeEaf, captureBext } = await import('../docs/js/seg-exports.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const seg = readFileSync(new URL('../docs/js/seg-exports.js', import.meta.url), 'utf8');
/* ⚠ STRIP COMMENTS BEFORE ANY "this name appears nowhere" CHECK. Both assertions at the bottom
 * failed on their first run against correct code — one matched `t()` inside the sentence "in
 * English, not t()", the other matched ENGINE_VERSION inside seg-exports' note explaining that it
 * deliberately does NOT read app state. A test that reads prose asserts about the explanation, and
 * gets weakened every time the explanation improves. (Third time this trap has bitten today.) */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

const WHO = 'Flextext Audio Segmenter v566';
const doc = makeDoc({ vernLang: 'und', analLang: 'en' }, 'T');
doc.paragraphs = [{ guid: 'p1', segments: [makeSegment('a b', [])] }];

console.log('\n.flextext — the DOCUMENTED attribute, from FLEx\'s own XSD');
{
  // Technical Notes on FLEx Text Interlinear (Ken Zook, 2026-05-04):
  //   <xs:attribute name="exportSource" type="xs:string" use="optional"/>  on <document>
  const xml = serializeFlextext(doc, { vernLang: 'und', analLang: 'en' }, { producedBy: WHO });
  ok(xml.includes(`exportSource="${WHO}"`), 'exportSource carries the app and version');
  ok(/<document version="[^"]*" exportSource=/.test(xml), 'on the <document> element, where the schema puts it');
  ok(!xml.includes('<!-- created by'), 'and NOT as a comment — a documented field beats a tolerated one');
  const bare = serializeFlextext(doc, { vernLang: 'und', analLang: 'en' }, {});
  ok(!bare.includes('exportSource'), 'omitted entirely when the caller supplies nothing, rather than guessed');
}

console.log('\n.eaf — the DOCUMENTED extension point, from EAFv3.0.xsd');
{
  // <xsd:element name="PROPERTY" type="propType" .../> inside HEADER, NAME attribute optional.
  const eaf = serializeEaf(doc, { vern: 'und', anal: 'en', producedBy: WHO });
  ok(eaf.includes(`<PROPERTY NAME="generator">${WHO}</PROPERTY>`), 'a HEADER PROPERTY carries the app');
  const hOpen = eaf.indexOf('<HEADER'), hClose = eaf.indexOf('</HEADER>');
  const at = eaf.indexOf('<PROPERTY');
  ok(hOpen >= 0 && at > hOpen && at < hClose, 'inside the HEADER');
  // XSD sequence is MEDIA_DESCRIPTOR*, LINKED_FILE_DESCRIPTOR*, PROPERTY* — order is not cosmetic.
  const withMedia = serializeEaf(doc, { vern: 'und', anal: 'en', producedBy: WHO, mediaName: 'a.wav', mediaMime: 'audio/x-wav' });
  ok(withMedia.indexOf('<MEDIA_DESCRIPTOR') < withMedia.indexOf('<PROPERTY'),
     'AFTER any MEDIA_DESCRIPTOR, because the XSD sequence says so');

  console.log('\n  …and AUTHOR is left for the person it is meant for');
  ok(!eaf.includes('AUTHOR="FlexText Editor"'), 'the tool name is NOT in AUTHOR any more');
  ok(/AUTHOR=""/.test(eaf), 'empty by default — what ELAN writes when it does not know');
  ok(serializeEaf(doc, { vern: 'und', anal: 'en', author: 'Bofuae, Dutu' }).includes('AUTHOR="Bofuae, Dutu"'),
     'and a caller who knows the annotator can supply one');
  // AUTHOR is use="required" in EAFv3.0.xsd, so it must be present even when empty.
  ok(serializeEaf(doc, { vern: 'und', anal: 'en' }).includes('AUTHOR='), 'still emitted — the XSD makes it required');
}

console.log('\n.wav — BWF already carried it (bext Originator), and still does');
{
  const b = captureBext({ app: WHO, mode: 'browser', sampleRate: 48000, channels: 1 });
  ok(b.originator === WHO, 'bext Originator names the app');
  ok(/CodingHistory|A=PCM/.test(b.codingHistory), 'alongside the EBU CodingHistory');
}

console.log('\nsegnum is neither required nor emitted');
{
  const xml = serializeFlextext(doc, { vernLang: 'und', analLang: 'en' }, { producedBy: WHO });
  ok(!xml.includes('type="segnum"'), 'we mint no segnum — FLEx recalculates it and ours was the wrong shape');
  const fx = readFileSync(new URL('../docs/js/flextext.js', import.meta.url), 'utf8');
  ok(/type === 'segnum'[^\n]*deliberately discarded/.test(fx), 'and the parser discards an incoming one');
  /* The engine must not DEPEND on it either — Seth: "we can't count on it existing in flextext
   * files". 35 of 95 corpus texts have none. Proven by parsing a doc without one. */
  const bare = `<?xml version="1.0" encoding="utf-8"?><document version="2"><interlinear-text>`
    + `<item type="title" lang="en">T</item><paragraphs><paragraph guid="p"><phrases>`
    + `<phrase><item type="txt" lang="und">a b</item></phrase>`
    + `</phrases></paragraph></paragraphs></interlinear-text></document>`;
  const { parseFlextext } = await import('../docs/js/flextext.js');
  const r = parseFlextext(bare, { vernLang: 'und', analLang: 'en' });
  ok(!r.error && r.texts.length === 1, 'a file with no segnum parses');
  ok(r.texts[0].paragraphs[0].segments.length === 1, '…with its phrase intact');
}

console.log('\nthe app names ITSELF, not the suite');
{
  const fn = app.match(/\nfunction producedBy\(\)[\s\S]*?\n\}/)[0];
  for (const a of ['Flextext Researcher', 'Flextext Recorder', 'Flextext Consent Collector',
                   'Flextext Audio Segmenter', 'Flextext Editor', 'Flextext Paragraph Analysis Tool']) {
    ok(fn.includes(a), `${a} identifies itself`);
  }
  ok(/ENGINE_VERSION/.test(fn), 'with the engine version');
  // Provenance is for whoever opens the file later, who need not share the writer's UI language.
  ok(!/\bt\(/.test(code(fn)), 'in English, not t() — this is an archive record, not UI text');
}

console.log('\nand it is a PARAMETER, never module state');
{
  ok(/producedBy = ''/.test(seg), 'seg-exports takes it as an option with an inert default');
  ok(!/ENGINE_VERSION/.test(code(seg)), 'and still imports no app state — a second writer must be able to call it');
}

console.log('\nand every EAF / bundle writer actually PASSES it — v567\'s note claimed a property no file carried');
{
  /* seg-exports took `producedBy` as an option with an inert default, and the serializer emitted
   * the PROPERTY when given one — and not one caller gave one. Every .eaf shipped with
   * AUTHOR="" and no generator: strictly less provenance than before, under a release note
   * saying the opposite. The writers are tested above; this pins the callers. */
  const rp = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
  const calls = (src, name) =>
    [...code(src).matchAll(new RegExp(`\\b${name}\\(\\{[\\s\\S]*?\\n\\s*\\}\\);`, 'g'))].map((m) => m[0]);
  const appCalls = [...calls(app, 'assembleSegEntries'), ...calls(app, 'buildLooseConversion')];
  const rpCalls = [...calls(rp, 'assembleSegEntries'), ...calls(rp, 'buildLooseConversion')];
  ok(appCalls.length >= 2 && appCalls.every((c) => /producedBy: producedBy\(\)/.test(c)),
     `the editor passes producedBy() at all ${appCalls.length} of its bundle / loose-conversion call sites`);
  ok(rpCalls.length >= 2 && rpCalls.every((c) => /producedBy: deps\.producedBy/.test(c)),
     `the panel passes it (via deps) at all ${rpCalls.length} of its call sites`);
  ok((code(app).match(/producedBy: \(\) => producedBy\(\)/g) || []).length === 2,
     'and the editor hands the panel that function in BOTH initResearcherPanel deps objects');
  const loose = code(seg).match(/export async function buildLooseConversion[\s\S]*?\n\}/)[0];
  ok(/assembleSegEntries\(\{[\s\S]*?\bproducedBy\b[\s\S]*?\}\)/.test(loose),
     'buildLooseConversion forwards it to the assembler');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nall ok\n');
process.exit(fail ? 1 : 0);
