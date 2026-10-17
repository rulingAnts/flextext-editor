/* THE ENGINE'S DIFF → FLEx OPS, KEYED BY GUID (desktop-flex; plans/flex-desktop-segmenter.md §4.2).
 * A diff bug here causes a ROLLBACK on the shell side, never a wrong write — but the ops still have to
 * be right for anything to save at all. Made-up fixtures in the shape open_text returns.
 *
 * Run: node test/flex-ops.test.mjs */
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { diffFlexDoc, postStateOf, flexBlockers, baselineOfGroup, stripFlexPadding, hasLocalWork } = await import('../docs/js/flex-ops.js');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const clone = (x) => JSON.parse(JSON.stringify(x));

let n = 0;
const W = (txt, gls = '', kind = gls ? 'gloss' : 'wordform') => ({ guid: 'w' + (++n), txt, punct: false, gls, flex: { analysisGuid: 'an' + n, analysisKind: kind, index: 0 } });
const P = (txt) => ({ guid: 'w' + (++n), txt, punct: true, flex: { analysisGuid: 'pf' + n, analysisKind: 'punct' } });
const SEC = () => Object.assign(P('§'), { boundaryMarker: true });
const line = (pg, sg, words, free = '', times = null) => ({
  guid: 'ln-' + sg, paraOf: pg, flex: { paraGuid: pg, segGuid: sg },
  segments: [{ attrs: { guid: sg, ...(times ? { 'begin-time-offset': String(times[0]), 'end-time-offset': String(times[1]) } : {}) },
               baseline: words.map((w) => w.txt).join(' '), words, free, freeLang: free ? 'en' : null, flex: { paraGuid: pg, segGuid: sg } }],
});
const base = () => {
  n = 0;
  const d = { title: 'T', vernLang: 'xx', analLang: 'en', flex: { textGuid: 't1', media: [] }, paragraphs: [
    line('P1', 's1', [W('aaa', 'A'), W('bbb'), P('.')], 'first.', [0, 1000]),
    line('P1', 's2', [W('ccc', 'C'), W('ddd'), SEC()], '', [1000, 2000]),
    line('P2', 's3', [W('eee'), W('fff'), W('ggg')], 'third'),
  ] };
  d.segments = [{ start: 0, end: 1000 }, { start: 1000, end: 2000 }, { start: 0, end: 0, timePending: true }];
  return d;
};
const kinds = (r) => r.ops.map((o) => o.op).sort().join(',');

console.log('\nno change → no ops');
{ const b = base(); const r = diffFlexDoc(b, clone(b)); ok(r.ops.length === 0 && r.touched.size === 0 && r.unsupported.length === 0, 'identical docs diff to nothing'); }

console.log('\nfree translation, gloss and times, keyed by segment guid');
{
  const b = base(), c = clone(b);
  c.paragraphs[0].segments[0].free = 'first, edited.';
  c.paragraphs[0].segments[0].words[1].gls = 'B';
  c.segments[2] = { start: 2000, end: 3000 };
  const r = diffFlexDoc(b, c, { media: '/x/rec.wav' });
  ok(kinds(r) === 'ft.set,gloss.set,media.attach,times.set', 'ft.set + gloss.set + times.set, and media.attach because the text has no link (D9)');
  const ft = r.ops.find((o) => o.op === 'ft.set');
  ok(ft.segGuid === 's1' && ft.paraGuid === 'P1' && ft.ws === 'en' && ft.value === 'first, edited.', 'ft.set carries seg, para, ws, value');
  const gl = r.ops.find((o) => o.op === 'gloss.set');
  ok(gl.segGuid === 's1' && gl.index === 1 && JSON.stringify(gl.forms) === '{"en":"B"}', 'gloss.set by the analysis index (punctuation counted), naming the writing system it changes');
  const tm = r.ops.find((o) => o.op === 'times.set');
  ok(tm.segGuid === 's3' && tm.begin === 2000 && tm.end === 3000, 'times.set from the live span');
  ok([...r.touched].sort().join() === 'P1,P2', 'both FLEx paragraphs touched');
  const r2 = diffFlexDoc(b, c);
  ok(r2.unsupported.some((u) => u.why === 'timesNeedMedia') && !r2.ops.some((o) => o.op === 'media.attach'), 'without a recording to attach, times are reported unsupported rather than silently dropped');
}
console.log('\na phrase split: the new phrase has an engine guid; the op names it');
{
  const b = base(), c = clone(b);
  const l3 = c.paragraphs[2];
  const words = l3.segments[0].words;
  const second = { guid: 'ln-new', paraOf: 'P2', flex: { paraGuid: 'P2' }, segments: [{ attrs: { guid: 'eng-new-1' }, baseline: 'fff ggg', words: words.slice(1), free: '' }] };
  l3.segments[0].words = words.slice(0, 1); l3.segments[0].baseline = 'eee';
  c.paragraphs.splice(3, 0, second);
  c.segments = [{ start: 0, end: 1000 }, { start: 1000, end: 2000 }, { start: 2000, end: 2500 }, { start: 2500, end: 3000 }];
  const r = diffFlexDoc(b, c, { media: '/x/rec.wav' });
  const sp = r.ops.find((o) => o.op === 'phrase.split');
  ok(sp && sp.segGuid === 's3' && sp.paraGuid === 'P2' && sp.afterWordIndex === 0 && sp.newPhrase === 'eng-new-1', 'phrase.split after word 0 of s3, naming the new phrase');
  ok(JSON.stringify(sp.times) === '[[2000,2500],[2500,3000]]', 'with both halves\' times');
  ok(!r.ops.some((o) => o.op === 'times.set' && o.segGuid === 's3'), 'no separate times.set for the split segment (the split carries them)');
  const post = postStateOf(c, r.touched, b);
  ok(post.P2.length === 2 && post.P2[1].segGuid === 'eng-new-1' && post.P2[0].words[0].analysisGuid === 'an7', 'post-state: two phrases, kept words keep their analysis guid');
  ok(post.P2[1].words.map((w) => w.analysisGuid).join() === 'an8,an9', 'moved words keep theirs too (the shell checks they survive)');
}
console.log('\na phrase join: the vanished phrase\'s words now end the previous one — across FLEx\'s §, never a real stop');
{
  // s2 ends with FLEx's § and s3 opens P2 alone: the Matcher's ⤴ on line 3. FLEx joins the paragraphs, then the phrases.
  const b = base(), c = clone(b);
  const [, l2, l3] = c.paragraphs;
  l2.segments[0].words = [...l2.segments[0].words.filter((w) => !w.boundaryMarker), ...l3.segments[0].words];
  l2.segments[0].free = 'third';
  c.paragraphs.splice(2, 1);
  c.segments = [{ start: 0, end: 1000 }, { start: 1000, end: 3000 }];
  const r = diffFlexDoc(b, c, { media: '/x/rec.wav' });
  ok(r.unsupported.length === 0, 'nothing refused: ' + JSON.stringify(r.unsupported));
  const structOps = r.ops.filter((o) => o.op === 'para.toPhrase' || o.op === 'phrase.join').map((o) => o.op + ':' + (o.segGuid || o.paraGuid)).join(',');
  ok(structOps === 'para.toPhrase:P1,phrase.join:s2', 'para.toPhrase on P1 (P2 comes in), then phrase.join on s2 — once each: ' + structOps);
  ok(!r.ops.some((o) => o.op === 'baseline.replace'), 'the joined text is not ALSO a baseline edit');
  const tm = r.ops.find((o) => o.op === 'times.set' && o.segGuid === 's2');
  ok(tm && tm.begin === 1000 && tm.end === 3000, 'the survivor\'s times are set outright, from the live span');
  ok(r.touched.has('P1') && r.touched.has('P2'), 'both paragraphs are in the post-state');
  // the same ⤴ across s1's full stop: FLEx keeps two sentences apart; refused before the shell would
  const c2 = clone(b);
  const [m1, m2] = c2.paragraphs;
  m1.segments[0].words = [...m1.segments[0].words, ...m2.segments[0].words.filter((w) => !w.boundaryMarker)];
  c2.paragraphs.splice(1, 1);
  c2.segments = [{ start: 0, end: 2000 }, { start: 0, end: 0, timePending: true }];
  const r2 = diffFlexDoc(b, c2);
  ok(r2.unsupported.some((u) => u.why === 'joinAtStop') && !r2.ops.some((o) => o.op === 'phrase.join'), 'a join across a real stop is refused (joinAtStop), no op');
}
console.log('\nthe Matcher\'s split: first half keeps the guid, the new one gets its translation; a Sentence break moves it');
{
  const b = base(), c = clone(b);
  const l3 = c.paragraphs[2];
  const words = l3.segments[0].words;
  l3.segments[0].words = words.slice(0, 1); l3.segments[0].free = 'thi';
  const n1 = { guid: 'ln-n1', paraOf: 'P2-new', segments: [{ attrs: { guid: 'eng-n1' }, baseline: 'fff', words: words.slice(1, 2), free: 'r', freeLang: 'en' }] };
  const n2 = { guid: 'ln-n2', paraOf: 'P2-new', segments: [{ attrs: { guid: 'eng-n2' }, baseline: 'ggg', words: words.slice(2), free: 'd', freeLang: 'en' }] };
  c.paragraphs.push(n1, n2);
  c.segments = [{ start: 0, end: 1000 }, { start: 1000, end: 2000 }, { start: 2000, end: 2400 }, { start: 2400, end: 2700 }, { start: 2700, end: 3000 }];
  const r = diffFlexDoc(b, c, { media: '/x/rec.wav' });
  ok(r.unsupported.length === 0, 'nothing refused: ' + JSON.stringify(r.unsupported));
  const seq = r.ops.filter((o) => /^phrase\./.test(o.op)).map((o) => o.op + ':' + o.segGuid + (o.newPhrase ? '>' + o.newPhrase : '') + (o.newPara ? '>' + o.newPara : '')).join(',');
  ok(seq === 'phrase.split:s3>eng-n1,phrase.split:eng-n1>eng-n2,phrase.toPara:s3>P2-new', 'two splits in the base paragraph, then the new paragraph after s3: ' + seq);
  const splits = r.ops.filter((o) => o.op === 'phrase.split');
  ok(splits.every((o) => o.paraGuid === 'P2') && splits[0].afterWordIndex === 0 && splits[1].afterWordIndex === 0, 'each split is in P2, after the first word of the segment it splits');
  ok(JSON.stringify(splits.map((o) => o.times)) === '[[[2000,2400],[2400,2700]],[[2400,2700],[2700,3000]]]', 'all three pieces timed: the splits carry the times');
  const tp = r.ops.find((o) => o.op === 'phrase.toPara');
  ok(tp.afterSplit === true && tp.paraGuid === 'P2', 'the paragraph move is marked to run after the splits');
  const fts = r.ops.filter((o) => o.op === 'ft.set').map((o) => o.segGuid + '=' + o.value).sort().join(',');
  ok(fts === 'eng-n1=r,eng-n2=d,s3=thi', 'free translations: the first half\'s changes, each new phrase gets its own: ' + fts);
  ok(r.touched.has('P2') && r.touched.has('P2-new'), 'the new paragraph is in the post-state');
  // a piece without audio: the splits carry no times, each piece's times are set (or cleared) outright
  const c2 = clone(c);
  c2.segments[4] = { start: 0, end: 0, timePending: true };
  const r2 = diffFlexDoc(b, c2, { media: '/x/rec.wav' });
  ok(r2.ops.filter((o) => o.op === 'phrase.split').every((o) => o.times === null), 'one piece untimed: no times on the splits');
  const ts = r2.ops.filter((o) => o.op === 'times.set').map((o) => o.segGuid + '=' + o.begin + '-' + o.end).join(',');
  ok(ts === 's3=2000-2400,eng-n1=2400-2700,eng-n2=null-null', 'every piece\'s times set outright: ' + ts);
}
console.log('\nadded lines, reshaping with gloss edits, split and join together: refused with their own reasons');
{
  const b = base();
  const blank = (id, pg) => ({ guid: 'ln-' + id, paraOf: pg, segments: [{ attrs: { guid: id }, baseline: '', words: [], free: '' }] });
  const c = clone(b);
  c.paragraphs.splice(3, 0, blank('eng-b1', 'P2'));   // Done padded leftover audio with a blank line after s3
  let r = diffFlexDoc(b, c);
  ok(r.unsupported.map((u) => u.why).join() === 'addedLine', 'a blank line after a phrase is an added line: ' + JSON.stringify(r.unsupported));
  const c2 = clone(b);
  c2.paragraphs.unshift(blank('eng-top', 'P0'));
  c2.segments.unshift({ start: 0, end: 0, timePending: true });
  r = diffFlexDoc(b, c2);
  ok(r.unsupported.map((u) => u.why).join() === 'addedLine', 'so is one added at the very top: ' + JSON.stringify(r.unsupported));
  const c3 = clone(b);
  const l3 = c3.paragraphs[2], words = l3.segments[0].words;
  l3.segments[0].words = words.slice(0, 1);
  c3.paragraphs.push({ guid: 'ln-n', paraOf: 'P2', segments: [{ attrs: { guid: 'eng-n' }, baseline: 'fff ggg', words: words.slice(1).map((w, i) => (i ? w : { ...w, gls: 'F' })), free: '' }] });
  r = diffFlexDoc(b, c3);
  // a gloss edited on a word a split moved into a new phrase: set where FLEx holds the word NOW — the shell
  // sets glosses first, on the text as checked out, and the split keeps the word's analysis
  const g3 = r.ops.find((o) => o.op === 'gloss.set');
  ok(!r.unsupported.length && g3 && g3.segGuid === 's3' && g3.index === 1 && JSON.stringify(g3.forms) === '{"en":"F"}' && !g3.newWord,
     'a gloss edited on a split phrase is saved with the split, at the word\'s place in the checked-out text: ' + JSON.stringify(g3));
  // P2 = [s3]; P3 = [s4, s5]: joining s4 into s3 while s5 stays in P3 cannot be one FLEx paragraph join
  const b4 = base();
  b4.paragraphs.push(line('P3', 's4', [W('hhh')]), line('P3', 's5', [W('iii')]));
  b4.segments.push({ start: 0, end: 0, timePending: true }, { start: 0, end: 0, timePending: true });
  const c4 = clone(b4);
  c4.paragraphs[2].segments[0].words = [...c4.paragraphs[2].segments[0].words, ...c4.paragraphs[3].segments[0].words];
  c4.paragraphs.splice(3, 1);
  c4.segments.splice(3, 1);
  r = diffFlexDoc(b4, c4);
  ok(r.unsupported.some((u) => u.why === 'joinAcrossParagraphs') && !r.ops.some((o) => o.op === 'para.toPhrase'), 'joining into another paragraph whose other lines stay put is refused (join the paragraphs first)');
  // s2+s3 joined and the result split elsewhere: one change at a time
  const c5 = clone(b);
  const [, k2, k3] = c5.paragraphs;
  const all = [...k2.segments[0].words.filter((w) => !w.boundaryMarker), ...k3.segments[0].words];
  k2.segments[0].words = all.slice(0, 3);
  c5.paragraphs.splice(2, 1, { guid: 'ln-x', paraOf: 'P1', segments: [{ attrs: { guid: 'eng-x' }, baseline: '', words: all.slice(3), free: '' }] });
  r = diffFlexDoc(b, c5);
  ok(r.unsupported.length > 0 && !r.ops.some((o) => o.op === 'phrase.split'), 'a join and a split of the same phrases is refused, not half-applied: ' + JSON.stringify(r.unsupported.map((u) => u.why)));
}
console.log('\nparagraph boundaries');
{
  const b = base(), c = clone(b);
  c.paragraphs[2].paraOf = 'P1';   // the P2 line joined P1
  let r = diffFlexDoc(b, c);
  ok(kinds(r) === 'para.toPhrase' && r.ops[0].paraGuid === 'P1', 'paragraph boundary → phrase boundary: para.toPhrase on P1');
  const c2 = clone(b);
  c2.paragraphs[1].paraOf = 'P1b';   // s2 starts a new paragraph
  r = diffFlexDoc(b, c2);
  ok(kinds(r) === 'phrase.toPara' && r.ops[0].segGuid === 's1' && r.ops[0].newPara === 'P1b', 'phrase boundary → paragraph boundary: phrase.toPara after s1, naming the new group');
}
console.log('\nword split, word insert, general baseline edit');
{
  const b = base(), c = clone(b);
  const w = c.paragraphs[2].segments[0].words;
  w.splice(1, 1, { guid: 'x1', txt: 'ff', punct: false, gls: '' }, { guid: 'x2', txt: 'f', punct: false, gls: '' });
  let r = diffFlexDoc(b, c);
  ok(kinds(r) === 'word.split' && r.ops[0].index === 1 && r.ops[0].offset === 2 && r.ops[0].segGuid === 's3', 'fff → ff|f is word.split at index 1, offset 2');
  const c2 = clone(b);
  c2.paragraphs[2].segments[0].words.splice(1, 0, { guid: 'x3', txt: 'new', punct: false, gls: '' });
  r = diffFlexDoc(b, c2);
  ok(kinds(r) === 'word.insert' && r.ops[0].at === 1 && r.ops[0].text === 'new', 'a new word before fff is word.insert at 1');
  const c3 = clone(b);
  c3.paragraphs[2].segments[0].words.push({ guid: 'x4', txt: 'end', punct: false, gls: '' });
  r = diffFlexDoc(b, c3);
  ok(kinds(r) === 'word.insert' && r.ops[0].at === 3, 'appended: at = the analyses count');
  const c4 = clone(b);
  c4.paragraphs[2].segments[0].words[0].txt = 'eeee';
  r = diffFlexDoc(b, c4);
  ok(kinds(r) === 'baseline.replace' && r.ops[0].paraGuid === 'P2' && r.ops[0].text === 'eeee fff ggg', 'a changed word is a baseline.replace with the whole paragraph text');
  const c5 = clone(b);
  c5.paragraphs[0].segments[0].words[1].txt = 'bbbb';
  r = diffFlexDoc(b, c5);
  ok(r.ops[0].text === 'aaa bbbb . ccc ddd §', 'a multi-phrase paragraph: phrases joined, the existing § kept, no § after real punctuation');
  ok(baselineOfGroup({ paragraphs: [line('Q', 'q1', [W('aa')]), line('Q', 'q2', [W('bb')])] }, 'Q') === 'aa § bb', 'a group without markers gets § between its phrases, as FLEx\'s importer writes');
}
console.log('\nword join: two neighbours become their concatenation (Backspace / Delete in the Matcher)');
{
  const b = base(), c = clone(b);
  const ws = c.paragraphs[2].segments[0].words;   // eee fff ggg
  c.paragraphs[2].segments[0].words = [{ guid: 'w-new', txt: 'eeefff', punct: false, gls: '' }, ws[2]];
  const r = diffFlexDoc(b, c);
  ok(kinds(r) === 'word.join' && r.ops[0].segGuid === 's3' && r.ops[0].paraGuid === 'P2' && r.ops[0].index === 0, 'eee fff → eeefff is word.join at analysis index 0');
  const c2 = clone(b);
  c2.paragraphs[0].segments[0].words = [{ guid: 'w-x', txt: 'aaabbb', punct: false, gls: '' }, c2.paragraphs[0].segments[0].words[2]];
  const r2 = diffFlexDoc(b, c2);
  ok(kinds(r2) === 'word.join' && r2.ops[0].index === 0, 'before a stop: aaa bbb . → aaabbb . is word.join too');
  const c3 = clone(b);
  c3.paragraphs[2].segments[0].words = [{ guid: 'w-y', txt: 'eeexfff', punct: false, gls: '' }, ws[2]];
  ok(diffFlexDoc(b, c3).ops[0].op === 'baseline.replace', 'a join that also changed letters is not a word.join');
}
console.log('\nunsupported shapes are reported, never guessed');
{
  const b = base(), c = clone(b);
  c.paragraphs[2].segments[0].words = [W('zzz')];
  const extra = { guid: 'ln-n', paraOf: 'P2', segments: [{ attrs: { guid: 'eng-2' }, baseline: 'yyy', words: [W('yyy')], free: '' }] };
  c.paragraphs.push(extra);
  const r = diffFlexDoc(b, c);
  ok(r.unsupported.some((u) => u.why === 'splitWithTextChange'), 'a split whose halves do not re-form the old words is refused');
  const c2 = clone(b);
  c2.paragraphs.splice(1, 1);   // s2 simply gone, its words nowhere
  const r2 = diffFlexDoc(b, c2);
  ok(r2.unsupported.some((u) => u.why === 'phraseRemoved' && u.segGuid === 's2') && !r2.ops.some((o) => o.op === 'phrase.join'), 'a phrase whose words are nowhere is refused as removed, not sent as a join for the shell to roll back');
}
console.log('\nblockers: a phrase with no letters');
{
  const b = base(), c = clone(b);
  c.paragraphs[2].segments[0].words = [P('…')];
  const bl = flexBlockers(c, new Set(['P2']));
  ok(bl.length === 1 && bl[0].code === 'noWordChar' && bl[0].blocking && bl[0].segGuid === 's3', 'an empty phrase blocks the save (D4)');
  ok(flexBlockers(c, new Set(['P1'])).length === 0, 'only touched paragraphs are checked');
}
console.log('\nDone\'s blank line after a FLEx text\'s last line is padding, never a line to save (2026-10-16)');
{
  // glosses typed on line 1, and Done padded a blank line for the audio after the last line: Save to FLEx
  // said "a line added here is not in FLEx" though nobody added one
  const b = base(), c = clone(b);
  c.paragraphs[0].segments[0].words[1].gls = 'B';
  c.paragraphs.push({ guid: 'ln+end3', paraOf: 'P2', segments: [{ attrs: { guid: 'eng-pad' }, baseline: '', words: [], free: '' }] });
  c.segments.push({ start: 3000, end: 4000 });
  ok(diffFlexDoc(b, c).unsupported.some((u) => u.why === 'addedLine'), 'as it was: the padding blocked the save');
  const s = stripFlexPadding(b, c);
  ok(s.paragraphs.length === 3 && s.segments.length === 3, 'the trailing blank line and its span are dropped');
  const r = diffFlexDoc(b, s);
  ok(r.unsupported.length === 0 && kinds(r) === 'gloss.set', 'only the gloss is left to save');
  ok(c.paragraphs.length === 4, 'the record itself is not changed');
  ok(stripFlexPadding(b, b) === b, 'nothing to strip: the same object back');
  // never a line with something in it, never one FLEx has, never one in the middle
  const typed = clone(c); typed.paragraphs[3].segments[0].free = 'typed here';
  ok(stripFlexPadding(b, typed).paragraphs.length === 4, 'a blank line with a translation typed into it is work: kept (and still refused)');
  const mid = clone(b); mid.paragraphs.splice(1, 0, { guid: 'ln+mid', paraOf: 'P1', segments: [{ attrs: { guid: 'eng-mid' }, baseline: '', words: [], free: '' }] });
  mid.segments.splice(1, 0, { start: 0, end: 0, timePending: true });
  ok(stripFlexPadding(b, mid).paragraphs.length === 4, 'a blank line in the middle (a + someone pressed) is not padding');
  // …but a save leaves every blank line out, wherever it is (the + is back on FLEx texts, 2026-10-17)
  const ev = stripFlexPadding(b, mid, { everywhere: true });
  ok(ev.paragraphs.length === 3 && ev.segments.length === 3 && ev.paragraphs.every((p) => p.guid !== 'ln+mid'), 'everywhere: the blank line and its span go, in step');
  ok(diffFlexDoc(b, ev).unsupported.length === 0, 'so it never blocks a save');
  ok(stripFlexPadding(b, typed, { everywhere: true }).paragraphs.length === 4, 'one typed into is still work, and still refused');
  ok(stripFlexPadding(b, b, { everywhere: true }) === b, 'nothing blank: the same object back');
  const all = clone(b); all.paragraphs.push(clone(c.paragraphs[3]), { guid: 'ln+end4', segments: [] }); all.segments.push({ start: 0, end: 0 }, { start: 0, end: 0 });
  ok(stripFlexPadding(b, all).paragraphs.length === 3, 'several at the end, a line with no phrase at all among them: all padding');
  // a record whose only difference is the padding has no work of its own: re-opening reads FLEx again
  const padOnly = clone(b); padOnly.paragraphs.push(clone(c.paragraphs[3])); padOnly.segments.push({ start: 3000, end: 4000 });
  ok(hasLocalWork({ flex: { base: b }, doc: padOnly }) === false, 'padding alone is not local work');
}

console.log(fail ? `\nFAILED (${fail})\n` : `\nPASSED\n`);
process.exit(fail ? 1 : 0);
