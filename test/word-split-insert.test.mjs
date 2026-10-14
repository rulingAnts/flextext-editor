/* WORD SPLIT AND WORD INSERT IN THE SEGMENTER — one user action, one undo item (seg-word-split;
 * plans/flex-desktop-segmenter.md §4.3 item 1, §6.5).
 *
 * The pure half (flextext.js splitWordAt / insertWordAt) and the Matcher's own functions, lifted from
 * app.js and run with their collaborators stubbed (test/lib/lift.mjs), so what is tested is the code
 * that ships. Fixtures are made up (`aaa bbb ccc`).
 *
 * Run: node test/word-split-insert.test.mjs */
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
import { liftAll } from './lib/lift.mjs';
installMiniXmlDom();
const FT = await import('../docs/js/flextext.js');
const { makeSegment, makeWord, splitWordAt, insertWordAt, baselineFromWords } = FT;

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const W = (txt, gls = '') => Object.assign(makeWord(txt), { gls });
const seg = () => makeSegment('aaa bbbccc, ddd.', [W('aaa', 'A'), W('bbbccc', 'BC'), W(',', '', ), W('ddd', 'D'), W('.', '')].map((w, i) => (i === 2 || i === 4 ? Object.assign(w, { punct: true }) : w)),
  { attrs: { guid: 'g-1', 'begin-time-offset': '100', 'end-time-offset': '900' }, free: 'the line' });

console.log('\nsplitWordAt: a word becomes two, nothing else moves');
{
  const s = seg();
  const r = splitWordAt(s, 1, 3);
  ok(r.ok, 'the split is accepted');
  ok(s.words.map((w) => w.txt).join('|') === 'aaa|bbb|ccc|,|ddd|.', 'the word is cut at the offset, in place');
  ok(s.baseline === 'aaa bbb ccc, ddd.', 'the baseline is rebuilt from the words (one space inserted, as FLEx would)');
  ok(s.words[1].gls === '' && s.words[2].gls === '', 'both halves are unglossed — FLEx leaves two unanalysed wordforms');
  ok(r.removedGloss === 'BC', 'and the lost gloss is reported so the UI can say so');
  ok(s.words[0].gls === 'A' && s.words[4].gls === 'D', 'the other words keep their glosses');
  ok(s.attrs.guid === 'g-1' && s.attrs['begin-time-offset'] === '100' && s.free === 'the line', 'attrs, times and the free translation are untouched');
  ok(s.words[1].guid !== s.words[2].guid, 'two new word guids');
}
console.log('\nsplitWordAt refuses what FLEx could not hold');
{
  ok(!splitWordAt(seg(), 1, 0).ok && !splitWordAt(seg(), 1, 6).ok, 'an offset at either end is not a split');
  ok(!splitWordAt(seg(), 2, 1).ok, 'punctuation is not a word');
  ok(splitWordAt(seg(), 1, 7).ok === false, 'an offset past the end');
  // a word whose text came from a file can hold non-word characters; a half made only of them is refused
  const s = makeSegment('a~~', [W('a~~')]);
  ok(!splitWordAt(s, 0, 1).ok && splitWordAt(s, 0, 1).reason === 'noWordChar', 'a half with no word-forming character ("~~") is refused: FLEx needs one in each');
  ok(splitWordAt(makeSegment('ab-c', [W('ab-c')]), 0, 3).ok, 'a hyphen is word-forming in this engine, so "ab-" is a word');
  const chained = makeSegment('aa bb', [Object.assign(W('aa bb'), { phrase: true })]);
  ok(!splitWordAt(chained, 0, 1).ok, 'a chained phrase-word is not split this way (unchain it first)');
  const u = makeSegment('ạ̃bc', [W('ạ̃bc')]);   // combining marks: offsets count code points
  const r = splitWordAt(u, 0, 2);   // U+1EA1 + U+0303 are two code points
  ok(r.ok && u.words[0].txt === 'ạ̃' && u.words[1].txt === 'bc', 'offsets are in code points, so a mark stays with its base');
}
console.log('\ninsertWordAt');
{
  const s = seg();
  const r = insertWordAt(s, 1, 'xxx');
  ok(r.ok && s.words.map((w) => w.txt).join('|') === 'aaa|xxx|bbbccc|,|ddd|.', 'inserted before word 1');
  ok(s.baseline === 'aaa xxx bbbccc, ddd.', 'baseline rebuilt');
  insertWordAt(s, 99, 'end');
  ok(s.words[s.words.length - 1].txt === 'end' && s.baseline.endsWith('. end'), 'an index past the end appends');
  insertWordAt(s, -5, '');
  ok(s.words[0].txt === '' && s.baseline === baselineFromWords(s.words), 'a negative index prepends (an empty pair to type into)');
}

/* ─── The Matcher, lifted ─────────────────────────────────────────────────────────────── */
console.log('\nthe Matcher: one keystroke = one undo item, one Redo redoes all of it');
const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
function matcher(lines) {
  const log = { toasts: [], drawn: 0, saved: 0 };
  const env = { FT, log, lines };
  return new Function('env', `
    const { FT, log, lines } = env;
    const { makeSegment, makeWord, mergePhrases, baselineFromWords, splitWordAt, insertWordAt,
            hasParagraphStructure, paragraphBreakBefore, breakParagraphBefore, joinParagraphBefore } = FT;
    let MG = { docId: 'd', spans: [], lines, selSpan: null, selLine: null, pendingWordCut: null, edited: false, holdDraft: false };
    let mgUndoStack = [], mgRedoStack = [], player = null;
    const $ = () => null, t = (k, v) => k + (v ? JSON.stringify(v) : ''), toast = (m) => log.toasts.push(m);
    const mgDraw = () => { log.drawn++; }, mgSaveDraft = () => { log.saved++; }, mgFocusWord = () => {};
    ${liftAll(APP, ['MG_UNDO_MAX', 'mgSnap', 'mgCapture', 'mgApply', 'mgUndoOnce', 'mgRedoOnce', 'mgLinePhrase', 'mgRealIndex',
                    'mgEditWord', 'mgInsertWord', 'mgDeleteWord', 'mgSplitWord', 'mgToggleParaBreak'])}
    return { get MG() { return MG; }, undo: mgUndoOnce, redo: mgRedoOnce, depth: () => mgUndoStack.length, redoDepth: () => mgRedoStack.length,
             mgSplitWord, mgInsertWord, mgEditWord, mgDeleteWord, mgToggleParaBreak, log };
  `)(env);
}
const line = (id, words, extra = {}) => ({ id, guid: 'g' + id, phrases: [makeSegment(baselineFromWords(words), words, { free: 'ft ' + id })], ...extra });
{
  const m = matcher([line('ln0', [W('aaa', 'A'), W('bbbccc', 'BC'), Object.assign(W(','), { punct: true }), W('ddd', 'D')])]);
  const before = JSON.stringify(m.MG.lines);
  m.mgSplitWord('ln0', 1, 'bbbccc', 3);
  const ph = m.MG.lines[0].phrases[0];
  ok(ph.words.map((w) => w.txt).join('|') === 'aaa|bbb|ccc|,|ddd', 'Space inside word 1 (visible index) splits it');
  ok(ph.baseline === 'aaa bbb ccc, ddd', 'and the baseline follows');
  ok(m.depth() === 1 && m.redoDepth() === 0, 'ONE undo item for the whole action');
  ok(m.log.toasts.some((x) => x.startsWith('mg.splitWordGloss')), 'the lost gloss is announced');
  ok(m.log.saved === 1 && m.log.drawn === 1, 'one draft save, one redraw');
  m.undo();
  ok(JSON.stringify(m.MG.lines) === before, 'one Undo restores the word, its gloss and the baseline');
  ok(m.depth() === 0 && m.redoDepth() === 1, 'and leaves one Redo');
  m.redo();
  ok(m.MG.lines[0].phrases[0].words.map((w) => w.txt).join('|') === 'aaa|bbb|ccc|,|ddd', 'one Redo redoes the split');
}
console.log('\nthe Matcher: a split that edited the word first is still one item');
{
  const m = matcher([line('ln0', [W('aaa', 'A'), W('bbbccc', 'BC')])]);
  m.mgSplitWord('ln0', 1, 'bbbxccc', 4);   // the box holds an edited word at the keystroke
  ok(m.MG.lines[0].phrases[0].words.map((w) => w.txt).join('|') === 'aaa|bbbx|ccc', 'the edited text is what gets split');
  ok(m.depth() === 1, 'edit + split = one undo item');
  m.undo();
  ok(m.MG.lines[0].phrases[0].words[1].txt === 'bbbccc' && m.MG.lines[0].phrases[0].words[1].gls === 'BC', 'Undo returns the pre-edit word');
}
console.log('\nthe Matcher: a refused split leaves no history behind');
{
  const m = matcher([line('ln0', [W('aaa'), W('b-c')])]);
  m.mgSplitWord('ln0', 1, 'b-c', 2);   // "b-" and "c": each half has a letter → accepted
  const d1 = m.depth();
  ok(d1 === 1, 'the accepted split made one item');
  m.mgSplitWord('ln0', 0, 'a~~', 1);   // "a" and "~~": the second half has no word-forming character
  ok(m.depth() === d1 && m.log.toasts.includes('mg.splitWordRefused'), 'nothing to split → refused, no undo item');
}
console.log('\nthe Matcher: insert and delete are one item each (unchanged behaviour, pinned)');
{
  const m = matcher([line('ln0', [W('aaa', 'A'), W('bbb', 'B')])]);
  m.mgInsertWord('ln0', 0, 'after');
  ok(m.MG.lines[0].phrases[0].words.length === 3 && m.MG.lines[0].phrases[0].words[1].txt === '' && m.depth() === 1, 'insert after word 0: one empty pair, one item');
  m.mgDeleteWord('ln0', 1);
  ok(m.MG.lines[0].phrases[0].words.length === 2 && m.depth() === 2, 'Backspace in the empty pair removes it: one more item');
  m.undo(); m.undo();
  ok(m.MG.lines[0].phrases[0].words.map((w) => w.txt).join('|') === 'aaa|bbb' && m.depth() === 0, 'two Undos, back to the start');
}
console.log('\nthe Matcher: ¶ toggles a paragraph break — one item, text untouched');
{
  const m = matcher([line('ln0', [W('aaa')], { paraOf: 'P1' }), line('ln1', [W('bbb')], { paraOf: 'P1' }), line('ln2', [W('ccc')], { paraOf: 'P2' })]);
  m.mgToggleParaBreak('ln1');
  ok(m.MG.lines[1].paraOf !== 'P1' && m.MG.lines[1].paraOf === m.MG.lines[1].paraOf && m.MG.lines[0].paraOf === 'P1', 'break before line 1: it leaves P1 for a fresh group');
  ok(m.MG.lines[2].paraOf === 'P2', 'a later paragraph is untouched');
  ok(m.depth() === 1, 'one undo item');
  m.mgToggleParaBreak('ln2');
  ok(m.MG.lines[2].paraOf === m.MG.lines[1].paraOf, 'join before line 2: it takes the group above');
  ok(m.depth() === 2, 'one more');
  m.undo(); m.undo();
  ok(m.MG.lines.map((l) => l.paraOf).join(',') === 'P1,P1,P2', 'two Undos restore the structure');
  ok(m.MG.lines.every((l) => l.phrases[0].words.length === 1), 'words never changed');
  const flat = matcher([line('ln0', [W('aaa')]), line('ln1', [W('bbb')])]);
  flat.mgToggleParaBreak('ln1');
  ok(flat.depth() === 0 && flat.MG.lines.every((l) => l.paraOf == null), 'a flat text has no paragraphs to break: refused, no history');
}

console.log(fail ? `\nFAILED (${fail})\n` : `\nPASSED\n`);
process.exit(fail ? 1 : 0);
