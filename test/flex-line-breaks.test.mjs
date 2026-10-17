/* FLEx'S HARD LINE BREAKS, AFTER THE ROUND-TRIP FIX (2026-10-17). A .flextext's breaks are folded once, on import
 * (flextext-roundtrip.test.mjs). Two places still met them as lines:
 *   · a FLEx text in the desktop shell: the shell gives every U+2028 segment a line of its own (readOnly, no words, an
 *     empty baseline), and the record keeps it so — the Matcher paired it with audio like any row, the engine's own
 *     check refused every save touching its paragraph ("no letters"), and joining it away rolled back;
 *   · a .flextext stored BEFORE the fix: its breaks are still lines, and joining one away gave the next phrase the
 *     break's GUID (bug 1 again).
 * The Matcher now folds a FLEx text's breaks while it is open and puts them back on Done (the stored shape exactly as
 * the shell gave it — so rolling the code back needs nothing done to any record); a join across one is refused there;
 * a merge never lets a break be the survivor. desktop/tests/test_line_breaks.py holds the shell's half. Made-up data.
 *
 * Run: node test/flex-line-breaks.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flextextModel, flextextDiff, phrasesOf } from './lib/flextext-semantic.mjs';
import { FT, exportOf, matcher } from './lib/segmenter-roundtrip.mjs';
const OPS = await import('../docs/js/flex-ops.js');

const FIX = readFileSync(new URL('./fixtures/flex-roundtrip/flex9-shape.flextext', import.meta.url), 'utf8');
const SEGNUM = [/^segnum\|/];
const G = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const L = (n) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A FLEx text as the shell gives it (desktop/flexshell/model.py): one line per segment, a break a readOnly empty line.
const word = (txt, i, sg) => ({ guid: 'an-' + txt + ':' + i, txt, punct: false, phrase: false, gls: '', preservedXML: [], flex: { analysisGuid: 'an-' + txt, analysisKind: 'wordform', index: i, seg: sg } });
const text = (g, words) => ({ attrs: { guid: g }, baseline: words.join(' '), words: words.map((w, i) => word(w, i, g)), free: '', freeLang: null, frees: {}, lits: {}, preItemsXML: [], postItemsXML: [], txtLang: 'qaa', flex: { paraGuid: null, segGuid: g, notes: [] } });
// as LCM has it: ONE analysis, a PunctuationForm whose form is U+2028 (IsHardLineBreak) — a punctuation word here
const brk = (g) => ({ ...text(g, []), readOnly: true, words: [{ guid: 'pf-lb:0', txt: '\u2028', punct: true, phrase: false, gls: '', preservedXML: [], flex: { analysisGuid: 'pf-lb', analysisKind: 'punct', index: 0, seg: g } }] });
const line = (seg, para) => ({ guid: 'ln-' + seg.attrs.guid, paraOf: para, segments: [seg], flex: { paraGuid: para, segGuid: seg.attrs.guid } });
function flexDoc() {
  return { title: 't', vernLang: 'qaa', analLang: 'en', languages: [], appAuthored: false, timeEdges: true, flex: { textGuid: 'T', anals: ['en'] },
    paragraphs: [line(text('A', ['aa', 'bb']), 'P1'), line(brk('B1'), 'P1'), line(text('C', ['cc']), 'P1'), line(brk('B2'), 'P1'), line(text('D', ['dd']), 'P2')],
    segments: [{ start: 0, end: 900 }, { start: 0, end: 0, timePending: true }, { start: 1000, end: 1900 }, { start: 0, end: 0, timePending: true }, { start: 2000, end: 2900 }] };
}
const rows = (doc) => doc.paragraphs.map((p, i) => ({ id: 'ln' + i, phrases: p.segments.slice(), guid: p.guid, paraOf: p.paraOf }));
const spansOf = (doc) => doc.segments.map((s, i) => ({ id: 'sp' + i, ...s }));
const ids = (list) => (list || []).map((b) => b.attrs.guid);

test('which phrases are breaks: the shell\'s (readOnly, empty) and a .flextext\'s (U+2028) — not a label with words, not a blank line', () => {
  assert.ok(FT.isFlexBreakPhrase(brk('B')), 'as the shell reads LCM: one punctuation word, the break itself');
  assert.ok(FT.isFlexBreakPhrase({ ...brk('B'), words: [] }), 'and with none (an older record)');
  assert.ok(!FT.isFlexBreakPhrase({ ...brk('B'), words: [{ txt: '*', punct: true }] }), 'a label of other punctuation is not a break');
  assert.ok(FT.isFlexBreakPhrase(FT.makeSegment('\u2028', [], { attrs: { guid: 'b' } })));
  assert.ok(!FT.isFlexBreakPhrase({ ...text('S', []), readOnly: true, words: [{ txt: '***', punct: true }] }), 'a line of only punctuation is a label with a word: it stays a line');
  assert.ok(!FT.isFlexBreakPhrase(FT.makeSegment('', [])), 'a blank line typed here is a line');
});

test('the Matcher\'s fold: each break rides on its line, in its own paragraph; Done\'s unfold gives back exactly what the shell gave', () => {
  const doc = flexDoc(), before = JSON.stringify(doc);
  const f = FT.foldFlexBreakLines(rows(doc), spansOf(doc));
  assert.deepEqual(f.lines.map((l) => l.phrases[0].attrs.guid), ['A', 'C', 'D'], 'three rows: no row for a break');
  assert.deepEqual([ids(f.lines[1].phrases[0].breaksBefore), ids(f.lines[1].phrases[0].breaksAfter)], [['B1'], ['B2']],
    'the break between A and C on C; the one ending its paragraph on C too');
  assert.deepEqual(f.spans.map((s) => s.id), ['sp0', 'sp2', 'sp4'], 'row i is audio i: the breaks\' empty rows went with them');
  assert.deepEqual(FT.foldFlexBreakLines(f.lines, f.spans), f, 'folding twice is folding once (a resumed draft)');
  const u = FT.unfoldFlexBreakLines(f.lines, f.spans);
  assert.deepEqual(u.lines.map((l) => [l.guid, l.paraOf, l.phrases]), rows(doc).map((l) => [l.guid, l.paraOf, l.phrases]), 'every line back: its guid, paragraph and phrase');
  assert.deepEqual(u.spans, spansOf(doc), 'and every row\'s span');
  assert.equal(JSON.stringify(doc), before, 'nothing passed in was changed');
});

test('a paragraph of nothing but breaks, and a break with a time of its own, stay rows', () => {
  const doc = flexDoc();
  doc.paragraphs.push(line(brk('B3'), 'P3'));
  doc.segments.push({ start: 0, end: 0, timePending: true });
  doc.segments[3] = { start: 1900, end: 2000 };   // somebody gave B2 a time
  const f = FT.foldFlexBreakLines(rows(doc), spansOf(doc));
  assert.deepEqual(f.lines.map((l) => l.phrases[0].attrs.guid), ['A', 'C', 'B2', 'D', 'B3']);
  assert.deepEqual(FT.unfoldFlexBreakLines(f.lines, f.spans).lines.map((l) => l.guid), rows(doc).map((l) => l.guid));
});

test('Done puts a break where it now sits: a ¶ made at the line after it leaves it at the end of the paragraph before', () => {
  const doc = flexDoc();
  doc.paragraphs.splice(4, 0, line(text('E', ['ee']), 'P1'));   // P1 = A ↵ C ↵ E
  doc.segments.splice(4, 0, { start: 1950, end: 1990 });
  const f = FT.foldFlexBreakLines(rows(doc), spansOf(doc));
  // ¶ at C: C and E open a new paragraph N
  f.lines[1].paraOf = 'N'; f.lines[2].paraOf = 'N';
  const u = FT.unfoldFlexBreakLines(f.lines, f.spans);
  assert.deepEqual(u.lines.map((l) => [l.phrases[0].attrs.guid, l.paraOf]),
    [['A', 'P1'], ['B1', 'P1'], ['C', 'N'], ['B2', 'N'], ['E', 'N'], ['D', 'P2']], 'B1 ends P1, where FLEx\'s split keeps it; B2 is inside N');
  // the other way: P2 = ↵ D, joined into P1 — the break goes with its line into P1
  const d2 = flexDoc();
  d2.paragraphs.splice(4, 0, line(brk('B4'), 'P2'));
  d2.segments.splice(4, 0, { start: 0, end: 0, timePending: true });
  const f2 = FT.foldFlexBreakLines(rows(d2), spansOf(d2));
  f2.lines[f2.lines.length - 1].paraOf = 'P1';
  assert.deepEqual(FT.unfoldFlexBreakLines(f2.lines, f2.spans).lines.map((l) => [l.phrases[0].attrs.guid, l.paraOf]).slice(-2), [['B4', 'P1'], ['D', 'P1']]);
});

test('the engine\'s Save checks: a break is FLEx\'s own label, not a phrase with no letters; a join across one is refused by name', () => {
  const base = flexDoc(), cur = structuredClone(base);
  FT.setFreeIn(cur.paragraphs[0].segments[0], 'en', 'a translation', 'en');
  const d = OPS.diffFlexDoc(base, cur);
  assert.deepEqual(d.ops.map((o) => o.op), ['ft.set']);
  assert.deepEqual(OPS.flexBlockers(cur, d.touched).filter((b) => b.blocking), [], 'was: noWordChar on the break, blocking every save in its paragraph');
  const typed = structuredClone(cur);
  typed.paragraphs[1].segments[0] = { ...typed.paragraphs[1].segments[0], words: [{ txt: '*', punct: true }], baseline: '*' };
  assert.ok(OPS.flexBlockers(typed, d.touched).some((b) => b.blocking && b.segGuid === 'B1') === false, 'a label of punctuation alone is still FLEx\'s label');
  // A joined onto… across B1: the diff says why, the shell is never asked
  const joined = structuredClone(base);
  joined.paragraphs.splice(0, 3, { ...joined.paragraphs[0], segments: [{ ...joined.paragraphs[0].segments[0], words: [...joined.paragraphs[0].segments[0].words, ...joined.paragraphs[2].segments[0].words] }] });
  joined.segments.splice(1, 2);
  const dj = OPS.diffFlexDoc(base, joined);
  assert.ok(!dj.ops.some((o) => o.op === 'phrase.join'));
  assert.deepEqual(dj.unsupported.map((x) => x.why), ['lineBreak']);
});

test('the Matcher refuses a join across a FLEx break, before anything moves', () => {
  const doc = flexDoc();
  const m = matcher(doc);
  Object.assign(m.MG, FT.foldFlexBreakLines(m.MG.lines, []));   // as mgLoad folds it
  const before = JSON.stringify(m.MG.lines);
  m.mgJoinLine(m.MG.lines[1].id);                               // C onto A, across B1
  assert.equal(JSON.stringify(m.MG.lines), before, 'nothing joined');
  assert.equal(m.depth(), 0, 'and no undo step left behind');
  m.mgJoinLine(m.MG.lines[2].id);                               // D onto C: C carries B2 at its end
  assert.equal(m.MG.lines.length, 3, 'nor across a break at a paragraph\'s end');
  // a FLEx text with nothing between two lines still joins
  const plain = flexDoc();
  plain.paragraphs.splice(1, 1); plain.paragraphs.splice(2, 1);
  const m2 = matcher(plain);
  m2.mgJoinLine(m2.MG.lines[1].id);
  assert.equal(m2.MG.lines.length, 2);
});

/* A .flextext stored before breaks were folded: each phrase its own line, a break included (the shape it was
 * stored in). Joining a break line away — the only way past one there — must keep every GUID where FLEx has it. */
function storedBeforeTheFix() {
  const doc = FT.parseFlextext(FIX, { analLang: 'en' }).texts[0];
  doc.paragraphs = doc.paragraphs.flatMap((p) => p.segments.map((s, k) => ({ guid: k ? FT.newGuid() : p.guid, segments: [s], paraOf: p.guid })));
  return doc;
}
for (const [what, pick] of [['the line after it joined onto the break', (m) => m.lineOf(G(3))], ['the break joined onto the line before it', (m) => m.lineOf(L(1))]]) {
  test(`a stored text: ${what} — every GUID stays, and so does the break`, () => {
    const doc = storedBeforeTheFix();
    const m = matcher(doc);
    m.mgJoinLine(pick(m));
    m.commitTo(doc);
    const out = flextextModel(exportOf(doc));
    assert.deepEqual(flextextDiff(flextextModel(FIX), out, { ignore: SEGNUM }), [], 'the file says exactly what FLEx\'s did: the break folded, not merged');
    assert.ok(phrasesOf(out).some((q) => q.guid === G(3)), 'the text phrase kept its own GUID (was: the break\'s)');
  });
}

test('a merge never makes a break the survivor: before, after, between, and breaks alone', () => {
  const b = (g) => FT.makeSegment('\u2028', [], { attrs: { guid: g } });
  const t = (g, w) => FT.makeSegment(w, [FT.makeWord(w)], { attrs: { guid: g }, free: w.toUpperCase() });
  let r = FT.mergePhrases([b('L1'), t('T', 'x')], { prim: 'en' });
  assert.deepEqual([r.attrs.guid, ids(r.breaksBefore), r.free], ['T', ['L1'], 'X']);
  r = FT.mergePhrases([t('T', 'x'), b('L1')], { prim: 'en' });
  assert.deepEqual([r.attrs.guid, ids(r.breaksAfter)], ['T', ['L1']]);
  r = FT.mergePhrases([t('T', 'x'), b('L1'), t('U', 'y')], { prim: 'en' });
  assert.deepEqual([r.attrs.guid, r.breaksBefore, r.breaksAfter, r.free], ['T', undefined, undefined, 'X Y'], 'between two text parts it goes, as in FLEx');
  r = FT.mergePhrases([b('L1'), b('L2')], { prim: 'en' });
  assert.deepEqual([r.attrs.guid, ids(r.breaksAfter), FT.isLineBreakPhrase(r)], ['L1', ['L2'], true]);
  const one = t('T', 'x');
  r = FT.mergePhrases([b('L1'), one], { prim: 'en' });
  r.words.push(FT.makeWord('z')); r.postItemsXML.push('<item type="note" lang="en">n</item>');
  assert.deepEqual([one.words.length, one.postItemsXML.length], [1, 0], 'the part it came from is not changed through it');
});

test('a stored break is written as FLEx writes one: its txt, no <words>', () => {
  const doc = { analLang: 'en', paragraphs: [{ guid: 'P', segments: [FT.makeSegment('\u2028', [], { attrs: { guid: 'L' } })] }], segments: [] };
  const out = FT.serializeFlextext(doc, { analLang: 'en', vernLang: 'qaa' }, {});
  assert.match(out, /<phrase guid="L">\s*<item type="txt" lang="qaa">\u2028<\/item>\s*<\/phrase>/);
});
