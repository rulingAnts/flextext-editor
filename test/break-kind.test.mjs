/* SENTENCE OR CLAUSE: WHAT KIND OF BREAK A CUT MAKES, AND WHAT § SECTION MARKS BECOME (seg-word-split;
 * Seth, 2026-10-14). On the flat line model a Sentence break is a new paragraph (a different `paraOf`)
 * and a Clause break is a new phrase inside the same paragraph (the same `paraOf`). The `breakKind`
 * setting says which a new cut makes, default 'sentence' — every cut as it always was. A text's § marks
 * are replaced, once, by the kind the user chooses. Made-up fixtures.
 *
 * Run: node test/break-kind.test.mjs */
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
import { liftAll } from './lib/lift.mjs';
installMiniXmlDom();
const FT = await import('../docs/js/flextext.js');
const { makeSegment, makeWord, baselineFromWords, setBoundaryKind, applyNewLineBreak, applyBreakKindToOrigins,
        reconcileBaselineWithOrigins, countSectionBreaks, replaceSectionBreaks, sectionBreakSites, resolveSectionBreak, normalizeBreakKind, serializeFlextext } = FT;
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const W = (t) => makeWord(t);
const P = (t) => Object.assign(makeWord(t), { punct: true });
const L = (guid, words, paraOf) => ({ guid, segments: [makeSegment(baselineFromWords(words), words)], ...(paraOf ? { paraOf } : {}) });
const groups = (lines) => lines.map((l) => l.paraOf == null ? '-' : l.paraOf).join(',');

console.log('\nnormalizeBreakKind');
ok(normalizeBreakKind('clause') === 'clause' && normalizeBreakKind('sentence') === 'sentence' && normalizeBreakKind(undefined) === 'sentence' && normalizeBreakKind('x') === 'sentence', 'anything but clause is sentence, the default');

console.log('\nsetBoundaryKind on an unstructured text');
{
  const ls = [L('a', [W('aaa')]), L('b', [W('bbb')]), L('c', [W('ccc')])];
  ok(setBoundaryKind(ls, 1, 'sentence') === false && groups(ls) === '-,-,-', 'a sentence break is already what every boundary is: nothing to do');
  ok(setBoundaryKind(ls, 1, 'clause') === true && groups(ls) === 'a,a,-', 'a clause break joins line 1 to line 0, naming the paragraph after the first line');
  ok(setBoundaryKind(ls, 2, 'clause') === true && groups(ls) === 'a,a,a', 'and the next one joins too');
  ok(setBoundaryKind(ls, 1, 'clause') === false, 'already a clause break: nothing to do');
  ok(setBoundaryKind(ls, 2, 'sentence') === true && groups(ls).startsWith('a,a,') && ls[2].paraOf !== 'a', 'a sentence break before line 2 gives it a fresh paragraph');
  ok(setBoundaryKind(ls, 0, 'clause') === false && setBoundaryKind(ls, 5, 'clause') === false, 'the edges are not boundaries');
}
console.log('\nsetBoundaryKind inside a structured text');
{
  const ls = [L('a', [W('aaa')], 'P1'), L('b', [W('bbb')], 'P1'), L('c', [W('ccc')], 'P1'), L('d', [W('ddd')], 'P2')];
  ok(setBoundaryKind(ls, 1, 'sentence') === true, 'sentence break inside P1');
  ok(ls[0].paraOf === 'P1' && ls[1].paraOf === ls[2].paraOf && ls[1].paraOf !== 'P1' && ls[3].paraOf === 'P2', 'lines 1–2 move to a fresh paragraph together; P2 untouched');
  ok(setBoundaryKind(ls, 3, 'clause') === true && ls[3].paraOf === ls[2].paraOf, 'a clause break pulls P2 into the paragraph above');
}
console.log('\napplyNewLineBreak: a line that was just inserted');
{
  const ls = [L('a', [W('aaa')]), L('n', [W('nnn')]), L('b', [W('bbb')])];   // n inserted after a
  applyNewLineBreak(ls, 1, 'sentence');
  ok(groups(ls) === '-,-,-', 'sentence on a flat text: the new line is its own paragraph (as every line always was)');
  applyNewLineBreak(ls, 1, 'clause');
  ok(groups(ls) === 'a,a,-', 'clause: it joins the line above');
  const st = [L('a', [W('aaa')], 'P1'), L('n', [W('nnn')]), L('b', [W('bbb')], 'P1'), L('c', [W('ccc')], 'P1')];
  applyNewLineBreak(st, 1, 'clause');
  ok(groups(st) === 'P1,P1,P1,P1', 'clause inside a paragraph: the new line is part of it');
  const st2 = [L('a', [W('aaa')], 'P1'), L('n', [W('nnn')]), L('b', [W('bbb')], 'P1'), L('c', [W('ccc')], 'P1')];
  applyNewLineBreak(st2, 1, 'sentence');
  ok(st2[0].paraOf === 'P1' && st2[1].paraOf !== 'P1' && st2[1].paraOf === st2[2].paraOf && st2[2].paraOf === st2[3].paraOf, 'sentence inside a paragraph: the new line starts a paragraph and the rest of the old one follows it');
}
console.log('\nthe Cut tab: a split line\'s pieces take the kind (through the reconcile\'s origins)');
{
  const mk = () => ({ paragraphs: [L('a', [W('aaa'), W('bbb'), W('ccc')], 'P1'), L('b', [W('ddd')], 'P1')], segments: [{ start: 0, end: 1000 }, { start: 1000, end: 2000 }] });
  let d = mk();
  let pb = d.paragraphs.map((p) => p.paraOf);
  let o = reconcileBaselineWithOrigins(d, ['aaa', 'bbb ccc', 'ddd'], { flatSegments: true });
  ok(o.map((x) => x.kind).join() === 'split,split,exact' || o.map((x) => x.kind).join() === 'split,split,kept', 'the reconcile reports two pieces of line 0');
  ok(d.paragraphs[0].paraOf == null, 'the reconcile itself drops the pieces\' paragraph (pre-existing)');
  applyBreakKindToOrigins(d, o, 'clause', pb);
  ok(groups(d.paragraphs) === 'P1,P1,P1', 'clause: both pieces are back in the paragraph');
  d = mk();
  pb = d.paragraphs.map((p) => p.paraOf);
  o = reconcileBaselineWithOrigins(d, ['aaa', 'bbb ccc', 'ddd'], { flatSegments: true });
  applyBreakKindToOrigins(d, o, 'sentence', pb);
  ok(d.paragraphs[0].paraOf === 'P1' && d.paragraphs[1].paraOf !== 'P1' && d.paragraphs[1].paraOf === d.paragraphs[2].paraOf, 'sentence: the second piece starts a paragraph and ddd follows it — the group stays consecutive, so the export can still write it');
  const flat = { paragraphs: [L('a', [W('aaa'), W('bbb')]), L('b', [W('ccc')])], segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }] };
  o = reconcileBaselineWithOrigins(flat, ['aaa', 'bbb', 'ccc'], { flatSegments: true });
  applyBreakKindToOrigins(flat, o, 'sentence');
  ok(groups(flat.paragraphs) === '-,-,-', 'the default on a flat text changes nothing: a cut is a new paragraph as before');
  o = reconcileBaselineWithOrigins(flat, ['aaa', 'bbb ccc'], { flatSegments: true });
  const n = applyBreakKindToOrigins(flat, o, 'clause');
  ok(n === 0, 'a JOIN is not a split: no boundary kind to apply');
}
console.log('\n§ section marks: listed as sites, decided one at a time, or all at once');
{
  const doc = () => ({ title: 'T', paragraphs: [
    L('a', [W('aaa'), W('bbb'), P('§')]), L('b', [W('ccc'), P('§')]), L('c', [W('ddd'), P('§'), W('eee'), W('fff'), P('.')]), L('d', [W('ggg')]),
  ], segments: [{ start: 0, end: 1000 }, { start: 1000, end: 2000 }, { start: 2000, end: 3000 }, { start: 3000, end: 4000 }] });
  const sites = sectionBreakSites(doc());
  ok(sites.length === 3 && countSectionBreaks(doc()) === 3, 'three marks listed');
  ok(JSON.stringify(sites[0]) === '{"line":0,"word":2,"final":true,"visibleBefore":2}', 'a phrase-final mark: final, after both words');
  ok(JSON.stringify(sites[2]) === '{"line":2,"word":1,"final":false,"visibleBefore":1}', 'a mark inside line c: not final, before the second lexical word');
  // one at a time
  let d = doc();
  let r = resolveSectionBreak(d, 0, 2, 'clause');
  ok(r.ok && !r.split && groups(d.paragraphs) === 'a,a,-,-' && d.paragraphs[0].segments[0].baseline === 'aaa bbb', 'line 0\'s mark → clause: the mark goes, line 1 joins line 0\'s paragraph');
  r = resolveSectionBreak(d, 1, 1, 'sentence');
  ok(r.ok && groups(d.paragraphs) === 'a,a,-,-' && sectionBreakSites(d).length === 1, 'line 1\'s mark → sentence: the mark goes, line 2 stays its own paragraph');
  r = resolveSectionBreak(d, 2, 1, 'sentence');
  ok(r.ok && r.split && d.paragraphs.length === 5 && d.paragraphs.map((l) => l.segments[0].baseline).join('|') === 'aaa bbb|ccc|ddd|eee fff.|ggg', 'the mark inside line c → sentence: the line splits there');
  ok(d.segments.length === 5 && d.segments[3].timePending === true && d.segments[2].start === 2000, 'the new half is untimed; the first half keeps its time');
  ok(d.paragraphs[2].guid === 'c' && d.paragraphs[3].guid !== 'c', 'the first half keeps the line\'s guid');
  ok(sectionBreakSites(d).length === 0 && !resolveSectionBreak(d, 0, 0, 'clause').ok, 'nothing left; resolving where there is no mark is refused');
  // the caller's own line shape
  d = doc();
  r = resolveSectionBreak(d, 2, 1, 'clause', { newLine: (seg, line) => ({ guid: 'mine', tag: line.guid, segments: [seg] }) });
  ok(r.ok && d.paragraphs[3].guid === 'mine' && d.paragraphs[3].tag === 'c' && d.paragraphs[3].paraOf === d.paragraphs[2].paraOf, 'newLine makes the inserted line; clause puts it in the paragraph with its first half');
  // all at once
  d = doc();
  r = replaceSectionBreaks(d, 'clause');
  ok(r.removed === 3 && r.split === 1 && groups(d.paragraphs) === 'a,a,a,a,-', 'All → Clause: three marks gone, one split, one paragraph of four lines; the unmarked line d stays its own');
  ok(d.paragraphs.every((l) => !l.segments[0].words.some(FT.isBoundaryMarker)), 'no marker words remain');
  d = doc();
  r = replaceSectionBreaks(d, 'sentence');
  ok(r.removed === 3 && groups(d.paragraphs) === '-,-,-,-,-', 'All → Sentence on a flat text: every line its own paragraph');
  const xml = serializeFlextext(d, { vernLang: 'xx', analLang: 'en' });
  ok(!xml.includes('§') && (xml.match(/<paragraph /g) || []).length === 5, 'the export carries no § and five paragraphs');
  const sd = { paragraphs: [L('a', [W('aaa'), P('§')], 'P1'), L('b', [W('bbb'), P('§')], 'P1'), L('c', [W('ccc')], 'P1')], segments: [] };
  replaceSectionBreaks(sd, 'sentence');
  ok(sd.paragraphs[0].paraOf === 'P1' && sd.paragraphs[1].paraOf !== 'P1' && sd.paragraphs[2].paraOf !== sd.paragraphs[1].paraOf, 'sentence inside a FLEx paragraph: each marked boundary starts a new paragraph');
  ok(countSectionBreaks(sd) === 0 && replaceSectionBreaks(sd, 'clause').removed === 0, 'a second pass finds nothing');
  // the Matcher's line shape (phrases, not segments) reads the same way
  const ml = { paragraphs: [{ id: 'ln0', guid: 'g0', phrases: [makeSegment('aaa §', [W('aaa'), P('§')])] }, { id: 'ln1', guid: 'g1', phrases: [makeSegment('bbb', [W('bbb')])] }] };
  ok(sectionBreakSites(ml).length === 1 && resolveSectionBreak(ml, 0, 1, 'clause').ok && ml.paragraphs[1].paraOf === 'g0', 'lines holding `phrases` work the same');
}
console.log('\nthe Matcher, lifted: split, insert and the padding at Done honour the setting');
{
  const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
  const matcher = (lines, kind) => new Function('env', `
    const { FT, lines, kind } = env;
    const { makeSegment, makeWord, mergePhrases, baselineFromWords, newGuid, normalizeBreakKind, applyNewLineBreak } = FT;
    let MG = { docId: 'd', spans: [], lines, selSpan: null, selLine: null, pendingWordCut: null };
    let mgUndoStack = [], mgRedoStack = [], player = null;
    const settings = { breakKind: kind };
    const $ = () => null, t = (k) => k, toast = () => {};
    const mgDraw = () => {}, mgSaveDraft = () => {};
    const mgLineText = (line) => ({ words: line.phrases.flatMap((p) => p.words).filter((w) => !w.punct).map((w) => ({ txt: w.txt })), free: '' });
    const { sectionBreakSites, resolveSectionBreak, replaceSectionBreaks } = FT;
    const mgLinePhrase = (line) => line.phrases[0];
    ${liftAll(APP, ['MG_UNDO_MAX', 'mgSnap', 'mgCapture', 'mgUndoOnce', 'mgApply', 'breakKindSetting', 'mgSplitLine', 'mgInsertLine',
                    'mgSectionSites', 'mgNewSectionLine', 'mgResolveSection', 'mgResolveAllSections'])}
    return { get MG() { return MG; }, mgSplitLine, mgInsertLine, mgResolveSection, mgResolveAllSections, mgSectionSites, undo: mgUndoOnce, depth: () => mgUndoStack.length };
  `)({ FT, lines, kind });
  const line = (id, words, paraOf) => ({ id, guid: 'g' + id, phrases: [makeSegment(baselineFromWords(words), words)], ...(paraOf ? { paraOf } : {}) });
  let m = matcher([line('ln0', [W('aaa'), W('bbb'), W('ccc')]), line('ln1', [W('ddd')])], 'clause');
  m.mgSplitLine('ln0', 1, 0);
  ok(m.MG.lines.length === 3 && m.MG.lines[0].paraOf === m.MG.lines[1].paraOf && m.MG.lines[0].paraOf != null && m.MG.lines[2].paraOf == null, 'clause: the two halves share a paragraph; ddd is untouched');
  m = matcher([line('ln0', [W('aaa'), W('bbb'), W('ccc')]), line('ln1', [W('ddd')])], 'sentence');
  m.mgSplitLine('ln0', 1, 0);
  ok(m.MG.lines.length === 3 && m.MG.lines.every((l) => l.paraOf == null), 'sentence (the default): a split on a flat text makes paragraphs, as before');
  m = matcher([line('ln0', [W('aaa')], 'P1'), line('ln1', [W('bbb')], 'P1')], 'clause');
  m.mgInsertLine(0);
  ok(groups(m.MG.lines) === 'P1,P1,P1', 'a blank line inserted as a clause joins the paragraph');
  m = matcher([line('ln0', [W('aaa')], 'P1'), line('ln1', [W('bbb')], 'P1')], 'sentence');
  m.mgInsertLine(0);
  ok(groups(m.MG.lines) === 'P1,P1,P1', 'inside a paragraph a blank line BELONGS to it whatever the setting (Seth\'s earlier rule; the ¶ control changes it afterwards)');
  m = matcher([line('ln0', [W('aaa')]), line('ln1', [W('bbb')])], 'clause');
  m.mgInsertLine(0);
  ok(m.MG.lines[0].paraOf != null && m.MG.lines[0].paraOf === m.MG.lines[1].paraOf && m.MG.lines[2].paraOf == null, 'where the text has no paragraph yet, a clause insert makes one with the line above');
  m = matcher([line('ln0', [W('aaa')]), line('ln1', [W('bbb')])], 'sentence');
  m.mgInsertLine(-1);
  ok(m.MG.lines.length === 3 && m.MG.lines[0].paraOf == null, 'a line inserted at the very top starts its own paragraph');

  console.log('\nthe Matcher, lifted: a § chip\'s choice is one undo item; All is one undo item');
  const mk = () => [line('ln0', [W('aaa'), P('§')]), line('ln1', [W('bbb'), P('§'), W('ccc')]), line('ln2', [W('ddd')])];
  m = matcher(mk(), 'sentence');
  ok(m.mgSectionSites().length === 2, 'two marks to decide');
  m.mgResolveSection('ln0', 1, 'clause');
  ok(m.MG.lines[0].paraOf === m.MG.lines[1].paraOf && m.MG.lines[0].paraOf != null && m.depth() === 1, 'one chip → clause: lines 0 and 1 share a paragraph, one undo item');
  m.mgResolveSection('ln1', 1, 'sentence');
  ok(m.MG.lines.length === 4 && m.MG.lines[2].id === 'ln1§1' && m.MG.lines[2].phrases[0].words[0].txt === 'ccc' && m.depth() === 2, 'the mark inside ln1 → sentence: the line splits, the new line has an id of its own, one more item');
  ok(m.MG.lines[2].paraOf !== m.MG.lines[1].paraOf, 'and the new line starts a paragraph');
  ok(m.mgSectionSites().length === 0, 'nothing left');
  m.undo(); m.undo();
  ok(m.MG.lines.length === 3 && m.mgSectionSites().length === 2 && m.depth() === 0, 'two Undos put both marks back');
  m.mgResolveSection('ln0', 5, 'clause');
  ok(m.depth() === 0, 'a click where no mark is leaves no history behind');
  m = matcher(mk(), 'sentence');
  m.mgResolveAllSections('clause');
  ok(m.mgSectionSites().length === 0 && m.MG.lines.length === 4 && new Set(m.MG.lines.slice(0, 3).map((l) => l.paraOf)).size === 1 && m.depth() === 1, 'All → Clause: both marks resolved, one paragraph of the three marked lines, ONE undo item');
  m.undo();
  ok(m.mgSectionSites().length === 2 && m.depth() === 0, 'one Undo brings both marks back');
}
console.log('\nthe setting is on both surfaces, Segmenter-only on the device, in both languages');
{
  const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
  const PANEL = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
  const I18N = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
  ok(/k: 'breakKind', type: 'select', opts: \['sentence', 'clause'\], optPrefix: 'panel\.opt\.breakKind\.'.*only: 'segmenter'/.test(APP), 'the unpaired form: a select, Segmenter only');
  ok(/k: 'breakKind', type: 'select', opts: \['sentence', 'clause'\]/.test(PANEL), 'the researcher panel: the same select');
  ok(/'breakKind', 'uiScale'/.test(APP), 'the Segmenter\'s Settings tab lists it');
  for (const k of ['panel.f.breakKind', 'panel.f.breakKindNote', 'panel.opt.breakKind.sentence', 'panel.opt.breakKind.clause', 'mg.sectionLeft', 'mg.sectionAllClause', 'mg.sectionAllSentence', 'mg.sectionClause', 'mg.sectionSentence', 'mg.sectionToClause', 'mg.sectionToSentence', 'mg.sectionChip']) {
    ok((I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || []).length === 2, `${k} in en and id`);
  }
  ok(/function breakKindSetting\(\) \{ return normalizeBreakKind\(settings\.breakKind\); \}/.test(APP), 'read through a function so a push lands mid-session');
  ok(/applyBreakKindToOrigins\(doc, o, breakKindSetting\(\), pb\)/.test(APP), 'the Cut/Baseline strips apply it on every split, with the memberships from before the edit');
  const ed = { paragraphs: [L('a', [W('aaa'), W('bbb')], 'P1'), L('b', [W('ccc')], 'P1')], segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }] };
  const pb2 = ed.paragraphs.map((p) => p.paraOf);
  const o2 = reconcileBaselineWithOrigins(ed, ['aaa bbbb', 'ccc'], { flatSegments: true });
  applyBreakKindToOrigins(ed, o2, 'sentence', pb2);
  ok(groups(ed.paragraphs) === 'P1,P1', 'a typo fix inside a paragraph no longer drops the line out of it');
  ok(!/mgAskSectionBreaks/.test(APP), 'no up-front all-or-nothing dialog: marks are decided case by case');
  ok(/mg-section-banner/.test(APP) && /mgSectionChip\(ln, x\)/.test(APP), 'the banner counts what is left; every mark is drawn as a chip in its line');
}
console.log(fail ? `\nFAILED (${fail})\n` : `\nPASSED\n`);
process.exit(fail ? 1 : 0);
