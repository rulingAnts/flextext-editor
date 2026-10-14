/* PARAGRAPH STRUCTURE ON FLAT LINES (seg-word-split; plans/flex-desktop-segmenter.md §4.3 item 4, §6.4).
 *
 * The engine holds one phrase per line and remembers paragraphs as `paraOf`. Splitting a paragraph,
 * joining two, turning a phrase boundary into a paragraph boundary and back are all edits to which
 * group a run of lines belongs to; the serializer then regroups them. Made-up fixtures.
 *
 * Run: node test/paragraph-ops.test.mjs */
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { hasParagraphStructure, paragraphBreakBefore, breakParagraphBefore, joinParagraphBefore, serializeFlextext, makeSegment, makeWord } = await import('../docs/js/flextext.js');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const L = (txt, paraOf, guid) => ({ guid, segments: [makeSegment(txt, [makeWord(txt)], { attrs: { guid: 's-' + guid }, free: 'f-' + guid })], ...(paraOf ? { paraOf } : {}) });
const mk = () => ({ title: 'T', paragraphs: [L('aaa', 'P1', 'l0'), L('bbb', 'P1', 'l1'), L('ccc', 'P1', 'l2'), L('ddd', 'P2', 'l3'), L('eee', 'P2', 'l4')], segments: [] });
const groups = (d) => d.paragraphs.map((p) => p.paraOf).join(',');

console.log('\nwhere the structure is');
ok(hasParagraphStructure(mk()), 'a tagged doc has structure');
ok(!hasParagraphStructure({ paragraphs: [L('a'), L('b')] }), 'a flat doc has none');
ok(paragraphBreakBefore(mk(), 3) === true && paragraphBreakBefore(mk(), 2) === false, 'the boundary before line 3 is a paragraph break; before line 2 a phrase break');
ok(paragraphBreakBefore(mk(), 0) === null && paragraphBreakBefore(mk(), 5) === null && paragraphBreakBefore({ paragraphs: [L('a'), L('b')] }, 1) === null, 'the edges and a flat doc answer null');

console.log('\nphrase boundary → paragraph boundary (a paragraph split)');
{
  const d = mk();
  ok(breakParagraphBefore(d, 1) === true, 'break before line 1');
  const g = d.paragraphs.map((p) => p.paraOf);
  ok(g[0] === 'P1' && g[1] !== 'P1' && g[1] === g[2] && g[3] === 'P2', 'lines 1–2 move to one fresh group; P2 untouched');
  ok(d.paragraphs[1].guid === 'l1' && d.paragraphs[1].segments[0].free === 'f-l1', 'line guids, phrases and translations untouched');
  ok(breakParagraphBefore(d, 1) === false, 'already a break: refused');
  ok(breakParagraphBefore(d, 3) === false, 'between P1\'s tail and P2 is already a break: refused');
}
console.log('\nparagraph boundary → phrase boundary (a paragraph join)');
{
  const d = mk();
  ok(joinParagraphBefore(d, 3) === true, 'join before line 3');
  ok(groups(d) === 'P1,P1,P1,P1,P1', 'all of P2 takes P1\'s group');
  ok(joinParagraphBefore(d, 3) === false, 'already joined: refused');
  const e = mk();
  ok(joinParagraphBefore(e, 2) === false && groups(e) === 'P1,P1,P1,P2,P2', 'joining inside a paragraph changes nothing');
}
console.log('\nsplit then join is a round trip; join then split is one too (fresh guid aside)');
{
  const d = mk();
  breakParagraphBefore(d, 1); joinParagraphBefore(d, 1);
  ok(groups(d) === 'P1,P1,P1,P2,P2', 'split + join restores the grouping');
  const e = mk();
  joinParagraphBefore(e, 3); breakParagraphBefore(e, 3);
  const g = e.paragraphs.map((p) => p.paraOf);
  ok(g[0] === 'P1' && g[2] === 'P1' && g[3] !== 'P1' && g[3] === g[4], 'join + split regroups the same lines (the second paragraph is new containment, as FLEx\'s is)');
}
console.log('\nan untagged line among tagged ones is its own paragraph');
{
  const d = { paragraphs: [L('aaa', 'P1', 'l0'), L('bbb', null, 'l1'), L('ccc', 'P2', 'l2')] };
  ok(paragraphBreakBefore(d, 1) === true && paragraphBreakBefore(d, 2) === true, 'both its boundaries are breaks');
  ok(joinParagraphBefore(d, 1) === true && d.paragraphs[1].paraOf === 'P1' && d.paragraphs[2].paraOf === 'P2', 'joining takes just that line into P1');
  const e = { paragraphs: [L('aaa', null, 'l0'), L('bbb', 'P2', 'l1')] };
  ok(joinParagraphBefore(e, 1) === true && e.paragraphs[0].paraOf === 'l0' && e.paragraphs[1].paraOf === 'l0', 'joining onto an untagged line names its group after that line');
}
console.log('\nthe serializer regroups the result');
{
  const d = mk();
  breakParagraphBefore(d, 1);
  const xml = serializeFlextext(d, { vernLang: 'xx', analLang: 'en' });
  const paras = [...xml.matchAll(/<paragraph guid="([^"]+)">/g)].map((m) => m[1]);
  ok(paras.length === 3, 'three <paragraph>s: P1 (line 0), the new one (lines 1–2), P2');
  ok(paras[0] === 'P1' && paras[2] === 'P2' && paras[1] === d.paragraphs[1].paraOf, 'under their group guids');
  ok((xml.match(/<phrase /g) || []).length === 5, 'all five phrases, each once');
}
console.log(fail ? `\nFAILED (${fail})\n` : `\nPASSED\n`);
process.exit(fail ? 1 : 0);
