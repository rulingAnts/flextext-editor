/* THE MATCHER'S TEXT-SIDE ✂ AND EVERY FREE TRANSLATION A LINE HAS (Seth, 2026-10-17).
 *
 * "Sometimes the free translation disappears when I click scissors … it doesn't seem to come back in the
 * display after the cut", and then: "if there are TWO free translation lines … they both display and are
 * both incorporated in the split". The second point of a text-line split was a space in the SLOT's
 * translation only. A translation in another language was not drawn while that point was chosen, and the
 * split dropped it (production: from both halves, with the slot's language tag). These run the shipped
 * functions, lifted from app.js (test/lib/lift.mjs) with the screen stubbed and a small stand-in for the
 * DOM the targets are drawn into. Made-up fixtures.
 *
 * Run: node test/matcher-split-translations.test.mjs */
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
import { liftAll } from './lib/lift.mjs';
installMiniXmlDom();
const FT = await import('../docs/js/flextext.js');
const { diffFlexDoc } = await import('../docs/js/flex-ops.js');
const { makeSegment, makeWord, baselineFromWords, freeIn, serializeFlextext, parseFlextext } = FT;

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const J = (x) => JSON.stringify(x);
const W = (txt) => makeWord(txt);
const ID = (text) => `<item type="gls" lang="id">${text}</item>`;
const NOTE = '<item type="note" lang="en">a note</item>';

// The few DOM calls mgCutTargets makes.
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.className = ''; this.title = ''; this.textContent = ''; }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
}
const document = { createElement: (tag) => new El(tag) };

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
function matcher(lines, { prim = 'en', rowLangs = null, kind = 'clause' } = {}) {
  const log = { toasts: [], drawn: 0, toastEl: { hidden: true, textContent: '' } };
  return new Function('env', `
    const { FT, log, lines, prim, rowLangs, kind, document } = env;
    const { makeSegment, mergePhrases, baselineFromWords, newGuid, normalizeBreakKind, applyNewLineBreak, setFreeIn } = FT;
    const freesOfPhrase = FT.phraseFrees;
    let MG = { docId: 'd', spans: [], lines, selSpan: null, selLine: null, pendingWordCut: null, edited: false, holdDraft: false };
    let mgUndoStack = [], mgRedoStack = [], player = null;
    const settings = { breakKind: kind };
    const $ = (q) => (q === '#toast' ? log.toastEl : null), t = (k, v) => k + (v ? JSON.stringify(v) : '');
    const toast = (m) => { log.toasts.push(m); log.toastEl.textContent = m; log.toastEl.hidden = false; };
    const mgDraw = () => { log.drawn++; }, mgSaveDraft = () => {};
    const mgPrimaryLang = () => prim, mgRowLangs = () => rowLangs;
    ${liftAll(APP, ['MG_UNDO_MAX', 'mgSnap', 'mgCapture', 'mgApply', 'mgUndoOnce', 'mgRedoOnce', 'breakKindSetting',
                    'mgSplitLine', 'mgSplitSource', 'mgCutRows', 'mgArmCut', 'mgPutCutDown', 'mgCutPrompt', 'mgPickFtCut', 'mgCutTargets'])}
    return { get MG() { return MG; }, undo: mgUndoOnce, redo: mgRedoOnce, depth: () => mgUndoStack.length,
             mgSplitLine, mgCutRows, mgArmCut, mgPutCutDown, mgPickFtCut, mgCutTargets, log };
  `)({ FT, log, lines, prim, rowLangs, kind, document });
}
// a line of three words with an English slot, an Indonesian item and a note (the shape a file in two languages opens in)
const twoLangs = (opts = {}) => ({
  id: 'ln0', guid: 'gln0', paraOf: 'P1',
  phrases: [makeSegment('aaa bbb ccc', [W('aaa'), W('bbb'), W('ccc')], {
    attrs: { guid: 'S1', 'begin-time-offset': '0', 'end-time-offset': '900' },
    free: 'one two three', freeLang: 'en', postItemsXML: [NOTE, ID('ka kb kc')], ...opts })],
});
const halves = (m) => m.MG.lines.map((l) => l.phrases[0]);

console.log('\nevery translation the line has is offered while the point is chosen, the primary first');
{
  const m = matcher([twoLangs()]);
  ok(J(m.mgCutRows(m.MG.lines[0])) === J([{ lang: 'en', text: 'one two three' }, { lang: 'id', text: 'ka kb kc' }]), 'both languages, as they will be cut');
  // the one this device edits comes first even when it is the item and another language holds the slot
  const m2 = matcher([twoLangs({ free: 'ka kb kc', freeLang: 'id', postItemsXML: [NOTE, '<item type="gls" lang="en">one two three</item>'] })]);
  ok(m2.mgCutRows(m2.MG.lines[0]).map((r) => r.lang).join() === 'en,id', 'primary first whatever holds the slot');
  // a FLEx text: FLEx's own order of its analysis writing systems
  const m3 = matcher([twoLangs({ postItemsXML: [ID('ka'), '<item type="gls" lang="fr">un</item>'] })], { rowLangs: ['en', 'fr', 'id'] });
  ok(m3.mgCutRows(m3.MG.lines[0]).map((r) => r.lang).join() === 'en,fr,id', 'a FLEx text: in FLEx\'s order (' + m3.mgCutRows(m3.MG.lines[0]).map((r) => r.lang).join() + ')');
  // an empty translation has nothing to place
  const m4 = matcher([twoLangs({ postItemsXML: [ID('  ')] })]);
  ok(m4.mgCutRows(m4.MG.lines[0]).map((r) => r.lang).join() === 'en', 'a blank one is not offered');
}

console.log('\ntwo translations: a point in each, then ONE split that cuts both, as one undo item');
{
  const m = matcher([twoLangs()]);
  const before = J(m.MG.lines);
  m.mgArmCut('ln0', 1);
  ok(m.MG.pendingWordCut && m.MG.pendingWordCut.at === 1 && J(m.MG.pendingWordCut.ft) === '{}', 'the ✂ arms the line');
  ok(m.log.toasts.pop() === 'mg.nowPickFts{"n":2}', 'and says there are two translations to place');
  m.mgPickFtCut('ln0', 'en', 3);
  ok(m.MG.lines.length === 1 && m.MG.pendingWordCut.ft.en === 3, 'one point chosen: nothing split yet, the point kept');
  ok(m.log.toasts.pop() === 'mg.nowPickNext{"lang":"id"}', 'and it asks for the other one by its language');
  ok(m.depth() === 0, 'choosing points is not an edit');
  m.mgPickFtCut('ln0', 'id', 2);
  ok(m.MG.pendingWordCut === null && m.MG.lines.length === 2, 'the second point splits the line');
  ok(m.log.toastEl.hidden === true, 'and its prompt goes with it, not two seconds later');
  const [a, b] = halves(m);
  ok(a.words.map((w) => w.txt).join() === 'aaa' && b.words.map((w) => w.txt).join() === 'bbb,ccc', 'the words split at the ✂');
  ok(freeIn(a, 'en', 'en') === 'one' && freeIn(b, 'en', 'en') === 'two three', 'English at its point: "one" | "two three"');
  ok(freeIn(a, 'id', 'en') === 'ka' && freeIn(b, 'id', 'en') === 'kb kc', 'Indonesian at ITS point: "ka" | "kb kc"');
  ok(a.freeLang === 'en' && b.freeLang === 'en', 'both halves keep the slot\'s language tag');
  ok(a.attrs.guid === 'S1' && b.attrs.guid && b.attrs.guid !== 'S1' && !('begin-time-offset' in a.attrs), 'the first half is the phrase (its guid, not its times); the second is new');
  ok(a.postItemsXML.includes(NOTE) && !b.postItemsXML.includes(NOTE), 'the note stays on the first half, as FLEx keeps it');
  ok(m.depth() === 1, 'one undo item');
  m.undo();
  ok(J(m.MG.lines) === before, 'one Undo gives the line back exactly, both translations whole');
  ok(m.MG.pendingWordCut === null, 'and the line is not left armed');
}

console.log('\nthe ends: 0 sends a translation to the second line whole, its length keeps it on the first');
{
  const m = matcher([twoLangs()]);
  m.mgSplitLine('ln0', 1, { en: 0, id: 'ka kb kc'.length });
  const [a, b] = halves(m);
  ok(freeIn(a, 'en', 'en') === '' && freeIn(b, 'en', 'en') === 'one two three', 'English all on the second line');
  ok(freeIn(a, 'id', 'en') === 'ka kb kc' && freeIn(b, 'id', 'en') === '', 'Indonesian all on the first');
  ok(a.postItemsXML.filter((x) => x === ID('ka kb kc')).length === 1, 'a translation kept whole is kept as it was, not rewritten');
}

console.log('\nnothing is dropped: a language with no point stays whole on the first half (older callers pass a number)');
{
  const m = matcher([twoLangs()]);
  m.mgSplitLine('ln0', 1, 3);
  const [a, b] = halves(m);
  ok(freeIn(a, 'en', 'en') === 'one' && freeIn(b, 'en', 'en') === 'two three', 'the number is the slot language\'s point');
  ok(freeIn(a, 'id', 'en') === 'ka kb kc' && freeIn(b, 'id', 'en') === '', 'the other language whole on the first half');
}

console.log('\nthe case that vanished: the only translation is not in the slot');
{
  // slot empty, the translation in another language — production drew the slot (nothing) and offered no point
  const line = { id: 'ln0', guid: 'g', phrases: [makeSegment('aaa bbb', [W('aaa'), W('bbb')], { attrs: { guid: 'S2' }, postItemsXML: [ID('ka kb')] })] };
  const m = matcher([line]);
  ok(J(m.mgCutRows(m.MG.lines[0])) === J([{ lang: 'id', text: 'ka kb' }]), 'it is offered, under its language');
  m.mgArmCut('ln0', 1);
  ok(m.log.toasts.pop() === 'mg.nowPickFt' && m.MG.pendingWordCut, 'one translation: the usual prompt');
  m.mgPickFtCut('ln0', 'id', 2);
  const [a, b] = halves(m);
  ok(m.MG.lines.length === 2 && freeIn(a, 'id', 'en') === 'ka' && freeIn(b, 'id', 'en') === 'kb', 'and split where it was chosen: "ka" | "kb"');
}

console.log('\na line with no translation: the ✂ is the whole split; ✂ again puts an armed one down');
{
  const bare = () => ({ id: 'ln0', guid: 'g', phrases: [makeSegment('aaa bbb', [W('aaa'), W('bbb')])] });
  let m = matcher([bare()]);
  m.mgArmCut('ln0', 1);
  ok(m.MG.lines.length === 2 && m.MG.pendingWordCut === null && m.depth() === 1, 'split at once, one undo item (it used to stay armed with nothing to click)');
  m = matcher([twoLangs()]);
  m.mgArmCut('ln0', 1);
  m.mgArmCut('ln0', 1);
  ok(m.MG.pendingWordCut === null && m.MG.lines.length === 1 && m.depth() === 0, 'pressed again: cancelled, nothing changed, nothing to undo');
  ok(m.log.toastEl.hidden === true, 'the prompt goes too');
  m.mgArmCut('ln0', 1);
  m.log.toastEl.textContent = 'something else said since';
  m.mgPutCutDown();
  ok(m.MG.pendingWordCut === null && m.log.toastEl.hidden === false, 'Escape (mgPutCutDown) puts it down, and leaves a message that is not its prompt');
  m.mgArmCut('ln0', 1);
  m.mgPickFtCut('ln0', 'en', 3);
  m.mgArmCut('ln0', 2);
  ok(m.MG.pendingWordCut.at === 2 && m.MG.pendingWordCut.ft.en === 3, 'another ✂ on the same line moves the first point and keeps the chosen ones');
  m.mgPickFtCut('ln0', 'id', 5);
  const [a, b] = halves(m);
  ok(a.words.map((w) => w.txt).join() === 'aaa,bbb' && freeIn(a, 'en', 'en') === 'one' && freeIn(b, 'id', 'en') === 'kc', 'and the split uses all of them');
  m = matcher([twoLangs(), { id: 'ln1', guid: 'g1', phrases: [makeSegment('ddd eee', [W('ddd'), W('eee')], { free: 'four five' })] }]);
  m.mgArmCut('ln0', 1);
  m.mgPickFtCut('ln0', 'en', 3);
  m.mgArmCut('ln1', 1);
  ok(m.MG.pendingWordCut.line === 'ln1' && J(m.MG.pendingWordCut.ft) === '{}', 'a ✂ on another line starts afresh there');
  m.mgPickFtCut('ln0', 'id', 2);
  ok(m.MG.lines.length === 2, 'and a point clicked on the line no longer armed does nothing');
  // words edited under an armed ✂ (they stay editable): the split is refused, and the line is drawn put down
  m = matcher([twoLangs()]);
  m.mgArmCut('ln0', 2);
  m.mgPickFtCut('ln0', 'en', 3);
  m.MG.lines[0].phrases[0].words.splice(1, 2);
  const drawn = m.log.drawn;
  m.mgPickFtCut('ln0', 'id', 2);
  ok(m.MG.lines.length === 1 && m.MG.pendingWordCut === null && m.log.toasts.pop() === 'mg.badSplit' && m.log.drawn > drawn && m.depth() === 0,
     'a ✂ left past the end: refused, nothing changed, and drawn unarmed');
}

console.log('\nthe targets drawn while the point is chosen');
{
  const m = matcher([twoLangs()]);
  m.mgArmCut('ln0', 1);
  const el = new El('div');
  m.mgCutTargets(el, m.MG.lines[0], { lang: 'en', text: 'one two three' }, m.MG.pendingWordCut);
  const btns = el.children.filter((c) => c.tag === 'button');
  ok(btns.map((b) => b.dataset.at).join() === '0,3,7,13', 'a target at the start, in each space, and at the end: ' + btns.map((b) => b.dataset.at).join());
  ok(btns[0].title === 'mg.ftAllSecond' && btns[1].title === 'mg.splitHere' && btns[3].title === 'mg.ftAllFirst', 'each says what it does');
  ok(el.children.filter((c) => c.tag === 'span').map((s) => s.textContent).join('|') === 'one|two|three', 'the words between them');
  btns[1].onclick();
  ok(m.MG.pendingWordCut.ft.en === 3 && m.MG.lines.length === 1, 'clicking one chooses that point');
  const el2 = new El('div');
  m.mgCutTargets(el2, m.MG.lines[0], { lang: 'en', text: 'one two three' }, m.MG.pendingWordCut);
  ok(el2.children.filter((c) => c.tag === 'button').map((b) => /mg-chosen/.test(b.className)).join() === 'false,true,false,false', 'and it is drawn chosen until the other has its point');
  const el3 = new El('div');
  m.mgCutTargets(el3, m.MG.lines[0], { lang: 'xx', text: ' aa bb ' }, m.MG.pendingWordCut);
  ok(el3.children.filter((c) => c.tag === 'button').map((b) => b.dataset.at).join() === '0,3,7', 'a space at either end is that end, not a second target there');
  const m2 = matcher([twoLangs({ free: ' one two ' })]);
  m2.mgSplitLine('ln0', 1, { en: 4 });
  ok(freeIn(halves(m2)[0], 'en', 'en') === 'one' && freeIn(halves(m2)[1], 'en', 'en') === 'two', 'and the split trims each half');
}

console.log('\nthe line it split is left as it was (the undo step holds it, the record may share it)');
{
  const line = twoLangs();
  const ph = line.phrases[0], was = J(ph), items = ph.postItemsXML;
  const m = matcher([line]);
  m.mgSplitLine('ln0', 1, { en: 0, id: 0 });
  ok(J(ph) === was && ph.postItemsXML === items && items.length === 2, 'the old phrase and its item list are untouched');
}

console.log('\na translation on both sides of <words> in one language: the hidden copy is not dropped');
{
  // parsePhrase puts the after-words one in the slot and keeps the other; nothing on screen shows it
  const OLD = '<item type="gls" lang="en">an older one</item>';
  const m = matcher([twoLangs({ preItemsXML: [OLD] })]);
  ok(m.mgCutRows(m.MG.lines[0]).filter((r) => r.lang === 'en').length === 1, 'one English row: the one the slot holds');
  m.mgSplitLine('ln0', 1, { en: 3, id: 2 });
  const [a, b] = halves(m);
  ok(a.free === 'one' && b.free === 'two three' && a.preItemsXML.includes(OLD), 'split in the slot; the other copy rides on the first half as before');
}

console.log('\na line an older draft left holding two phrases is split as their join');
{
  const line = { id: 'ln0', guid: 'g', phrases: [
    makeSegment('aaa', [W('aaa')], { attrs: { guid: 'S1' }, free: 'one', freeLang: 'en', postItemsXML: [ID('ka')] }),
    makeSegment('bbb ccc', [W('bbb'), W('ccc')], { attrs: { guid: 'S9' }, free: 'two three', freeLang: 'en', postItemsXML: [ID('kb kc')] })] };
  const m = matcher([line]);
  ok(J(m.mgCutRows(m.MG.lines[0])) === J([{ lang: 'en', text: 'one two three' }, { lang: 'id', text: 'ka kb kc' }]), 'each language joined, as Done would join them');
  m.mgSplitLine('ln0', 2, { en: 7, id: 5 });
  const [a, b] = halves(m);
  ok(a.attrs.guid === 'S1' && freeIn(a, 'en', 'en') === 'one two' && freeIn(b, 'id', 'en') === 'kc', 'and split at the points chosen in the joined text');
}

console.log('\nthrough the file: both halves carry both languages');
{
  const m = matcher([twoLangs()]);
  m.mgSplitLine('ln0', 1, { en: 3, id: 2 });
  const doc = { title: 'T', vernLang: 'xx', analLang: 'en', languages: [], segments: [],
                paragraphs: m.MG.lines.map((l) => ({ guid: l.guid, segments: l.phrases, ...(l.paraOf ? { paraOf: l.paraOf } : {}) })) };
  const back = parseFlextext(serializeFlextext(doc, { vernLang: 'xx', analLang: 'en' }), { analLang: 'en' }).texts[0];
  const segs = back.paragraphs.flatMap((p) => p.segments);
  ok(segs.length === 2, 'two phrases');
  ok(J(segs.map((s) => [freeIn(s, 'en', 'en'), freeIn(s, 'id', 'en')])) === J([['one', 'ka'], ['two three', 'kb kc']]), 'each with its part of each translation: ' + J(segs.map((s) => [freeIn(s, 'en', 'en'), freeIn(s, 'id', 'en')])));
}

console.log('\na FLEx text: each half reaches FLEx with its part of every writing system');
{
  // the shape the shell's open_text gives a phrase (desktop/flexshell/model.py)
  const fw = (txt, i) => ({ ...W(txt), guid: 'an' + i + ':' + i, flex: { analysisGuid: 'an' + i, analysisKind: 'wordform', index: i, seg: 'S1' } });
  const seg = () => ({ attrs: { guid: 'S1' }, baseline: 'aaa bbb ccc', words: ['aaa', 'bbb', 'ccc'].map(fw), free: 'one two three', freeLang: 'en',
    frees: { en: 'one two three', id: 'ka kb kc' }, lits: { en: 'a literal one' }, preItemsXML: [], postItemsXML: [ID('ka kb kc')], txtLang: 'xx',
    flex: { paraGuid: 'P1', segGuid: 'S1', notes: [] } });
  const base = { title: 'T', vernLang: 'xx', analLang: 'en', flex: { textGuid: 't1', media: [], anals: ['en', 'id'] },
    paragraphs: [{ guid: 'ln-S1', paraOf: 'P1', segments: [seg()], flex: { paraGuid: 'P1', segGuid: 'S1' } }], segments: [{ start: 0, end: 0, timePending: true }] };
  const m = matcher([{ id: 'ln0', guid: 'ln-S1', paraOf: 'P1', phrases: [seg()] }], { rowLangs: ['en', 'id'] });
  m.mgArmCut('ln0', 1);
  m.mgPickFtCut('ln0', 'id', 2);
  m.mgPickFtCut('ln0', 'en', 3);
  const [a, b] = halves(m);
  ok(J(a.frees) === J({ en: 'one', id: 'ka' }) && J(b.frees) === J({ en: 'two three', id: 'kb kc' }), 'the ride-along maps follow: ' + J([a.frees, b.frees]));
  ok(J(a.lits) === J({ en: 'a literal one' }) && J(b.lits) === '{}', 'a literal translation is FLEx\'s and stays with the phrase');
  ok(a.flex && a.flex.segGuid === 'S1' && !b.flex && a.txtLang === 'xx' && b.txtLang === 'xx', 'the first half is FLEx\'s segment; the second is new');
  const cur = { ...base, paragraphs: m.MG.lines.map((l) => ({ guid: l.guid, paraOf: l.paraOf, segments: l.phrases })),
                segments: [{ start: 0, end: 0, timePending: true }, { start: 0, end: 0, timePending: true }] };
  const r = diffFlexDoc(base, cur);
  ok(r.unsupported.length === 0, 'nothing refused: ' + J(r.unsupported));
  ok(r.ops.some((o) => o.op === 'phrase.split' && o.segGuid === 'S1' && o.newPhrase === b.attrs.guid), 'a phrase.split of S1, naming the new phrase');
  const fts = r.ops.filter((o) => o.op === 'ft.set').map((o) => (o.segGuid === 'S1' ? 'S1' : 'new') + '.' + o.ws + '=' + o.value).sort().join(', ');
  ok(fts === 'S1.en=one, S1.id=ka, new.en=two three, new.id=kb kc', 'ft.set for both writing systems on both halves: ' + fts);
}

console.log(fail ? `\n${fail} FAILED` : '\nall ok');
process.exit(fail ? 1 : 0);
