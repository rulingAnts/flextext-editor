/* THE ENGINE'S DIFF → FLEx OPS, KEYED BY GUID (desktop-flex; plans/flex-desktop-segmenter.md §4.2).
 * A diff bug here causes a ROLLBACK on the shell side, never a wrong write — but the ops still have to
 * be right for anything to save at all. Made-up fixtures in the shape open_text returns.
 *
 * Run: node test/flex-ops.test.mjs */
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { diffFlexDoc, postStateOf, flexBlockers, baselineOfGroup } = await import('../docs/js/flex-ops.js');
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
  ok(gl.segGuid === 's1' && gl.index === 1 && gl.value === 'B', 'gloss.set by the analysis index (punctuation counted)');
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
console.log('\na phrase join: the vanished phrase\'s words now end the previous one');
{
  const b = base(), c = clone(b);
  const [l1, l2] = c.paragraphs;
  l1.segments[0].words = [...l1.segments[0].words, ...l2.segments[0].words.filter((w) => !w.boundaryMarker)];
  l1.segments[0].free = 'first. ';
  c.paragraphs.splice(1, 1);
  c.segments = [{ start: 0, end: 2000 }, { start: 0, end: 0, timePending: true }];
  const r = diffFlexDoc(b, c);
  const j = r.ops.find((o) => o.op === 'phrase.join');
  ok(j && j.segGuid === 's1' && j.paraGuid === 'P1' && j.endTime === 2000, 'phrase.join on s1 with the new end time');
  ok(!r.ops.some((o) => o.op === 'baseline.replace'), 'the joined text is not ALSO a baseline edit');
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
  ok(r2.ops.some((o) => o.op === 'phrase.join'), 'a vanished phrase is read as a join with the previous one (the shell verifies the words)');
}
console.log('\nblockers: a phrase with no letters');
{
  const b = base(), c = clone(b);
  c.paragraphs[2].segments[0].words = [P('…')];
  const bl = flexBlockers(c, new Set(['P2']));
  ok(bl.length === 1 && bl[0].code === 'noWordChar' && bl[0].blocking && bl[0].segGuid === 's3', 'an empty phrase blocks the save (D4)');
  ok(flexBlockers(c, new Set(['P1'])).length === 0, 'only touched paragraphs are checked');
}
console.log(fail ? `\nFAILED (${fail})\n` : `\nPASSED\n`);
process.exit(fail ? 1 : 0);
