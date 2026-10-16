/* CHECK-IN WITH A MERGE (desktop-flex; plans/flex-desktop-segmenter.md §4.5). Seth, 2026-10-16: "a
 * check-out and check-in with the original (before changes) version saved for comparison and diff/merge
 * … change JUST what we change." The merged doc is FLEx's text now with the work done here on it, so the
 * save's ops (diffFlexDoc(theirs, merged)) are exactly the changes made here and nothing of FLEx's is
 * written back over. Every case below checks the OPS, because the ops are what reach FLEx. Made-up
 * fixtures in the shape open_text returns.
 *
 * Run: node test/flex-merge.test.mjs */
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { mergeFlexDocs, diffFlexDoc, postStateOf } = await import('../docs/js/flex-ops.js');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const clone = (x) => JSON.parse(JSON.stringify(x));

let n = 0;
const W = (txt, gls = '') => ({ guid: 'an' + (++n) + ':0', txt, punct: false, gls, glsLang: gls ? 'en' : undefined,
  flex: { analysisGuid: 'an' + n, analysisKind: gls ? 'gloss' : 'wordform', index: 0 } });
const P = (txt) => ({ guid: 'pf' + (++n) + ':0', txt, punct: true, flex: { analysisGuid: 'pf' + n, analysisKind: 'punct' } });
const SEC = () => Object.assign(P('§'), { boundaryMarker: true });
const line = (pg, sg, words, free = '', times = null) => ({
  guid: 'ln-' + sg, paraOf: pg, flex: { paraGuid: pg, segGuid: sg },
  segments: [{ attrs: { guid: sg, ...(times ? { 'begin-time-offset': String(times[0]), 'end-time-offset': String(times[1]) } : {}) },
               baseline: words.map((w) => w.txt).join(' '), words, free, freeLang: free ? 'en' : null, flex: { paraGuid: pg, segGuid: sg } }],
});
/* P1: s1 "aaa bbb ." (glossed A, translated, timed), s2 "ccc ddd §" (timed); P2: s3 "eee fff", s4 "ggg hhh" */
const base = () => {
  n = 0;
  const d = { title: 'T', vernLang: 'xx', analLang: 'en', flex: { textGuid: 't1', media: [{ uriGuid: 'u1', uri: 'a.wav', url: '/media/a' }] }, paragraphs: [
    line('P1', 's1', [W('aaa', 'A'), W('bbb'), P('.')], 'first.', [0, 1000]),
    line('P1', 's2', [W('ccc', 'C'), W('ddd'), SEC()], '', [1000, 2000]),
    line('P2', 's3', [W('eee'), W('fff')], 'third'),
    line('P2', 's4', [W('ggg'), W('hhh', 'H')], ''),
  ] };
  d.segments = [{ start: 0, end: 1000 }, { start: 1000, end: 2000 }, { start: 0, end: 0, timePending: true }, { start: 0, end: 0, timePending: true }];
  return d;
};
const three = () => { const b = base(); return { b, o: clone(b), t: clone(b) }; };
const seg = (doc, i) => doc.paragraphs[i].segments[0];
const lineOf = (doc, sg) => doc.paragraphs.findIndex((ln) => ln.segments[0].attrs.guid === sg);
const opsOf = (r, theirs) => diffFlexDoc(theirs, r.doc, { ws: 'en' });
const kinds = (d) => d.ops.map((o) => o.op).sort().join(',');
// the ops a save would write with FLEx unchanged: a merge onto FLEx's changes must write exactly these
const plain = (b, o) => JSON.stringify(diffFlexDoc(b, o, { ws: 'en' }).ops);
// FLEx re-glosses a word: a different analysis (a new guid), as an occurrence pointed at another WfiGloss
const reGloss = (w, gls) => Object.assign(w, { gls, glsLang: 'en', guid: 'new-' + w.guid, flex: { ...w.flex, analysisGuid: 'new-' + w.flex.analysisGuid, analysisKind: 'gloss' } });
// a split of s3 here, as the Matcher's ✂ makes it: the first half keeps the guid, the second is new
const splitS3 = (o) => {
  const i = lineOf(o, 's3');
  const words = seg(o, i).words;
  const second = { guid: 'ln-new', paraOf: 'P2', flex: { paraGuid: 'P2' }, segments: [{ attrs: { guid: 'eng-new' }, baseline: 'fff', words: words.slice(1), free: 'rd', freeLang: 'en' }] };
  seg(o, i).words = words.slice(0, 1);
  seg(o, i).free = 'thi';
  o.paragraphs.splice(i + 1, 0, second);
  o.segments.splice(i + 1, 0, { start: 0, end: 0, timePending: true });
};

console.log('\nnothing changed anywhere');
{
  const { b, o, t } = three();
  const r = mergeFlexDocs(b, o, t);
  ok(r.conflicts.length === 0 && opsOf(r, t).ops.length === 0 && r.theirs === 0, 'no conflicts, nothing to write, nothing of FLEx\'s changed');
}

console.log('\ntimes here, a gloss in FLEx: both kept, and only ours is written');
{
  const { b, o, t } = three();
  o.segments[lineOf(o, 's3')] = { start: 2000, end: 3000 };
  reGloss(seg(t, 0).words[1], 'B');
  const r = mergeFlexDocs(b, o, t);
  const d = opsOf(r, t);
  ok(r.conflicts.length === 0, 'no conflicts');
  ok(kinds(d) === 'times.set' && d.ops[0].segGuid === 's3' && d.ops[0].begin === 2000, 'the save writes our times only: ' + kinds(d));
  ok(seg(r.doc, 0).words[1].gls === 'B', 'FLEx\'s new gloss is in the merged text (never written back over)');
  ok(r.theirs === 1, 'FLEx changed one phrase');
  const post = postStateOf(r.doc, d.touched, t);
  ok(post.P2 && post.P2[0].begin === '2000' && !post.P1, 'the intended post-state covers only the paragraph written');
}

console.log('\nthe same free translation changed on both sides');
{
  const { b, o, t } = three();
  seg(o, 0).free = 'first, here.';
  seg(t, 0).free = 'first, in FLEx.';
  let r = mergeFlexDocs(b, o, t);
  ok(r.conflicts.length === 1 && r.conflicts[0].kind === 'free' && r.conflicts[0].forceable && r.conflicts[0].line === 1, 'a conflict on line 1, which can be forced');
  ok(opsOf(r, t).ops.length === 0 && seg(r.doc, 0).free === 'first, in FLEx.', 'unforced, FLEx\'s stays and nothing is written');
  r = mergeFlexDocs(b, o, t, { prefer: 'mine' });
  const d = opsOf(r, t);
  ok(kinds(d) === 'ft.set' && d.ops[0].value === 'first, here.', '"use mine": ours is written over it');
  seg(t, 0).free = 'first, here.';
  r = mergeFlexDocs(b, o, t);
  ok(r.conflicts.length === 0 && opsOf(r, t).ops.length === 0, 'changed to the same value on both sides: no conflict, nothing to write');
}

console.log('\nFLEx reworded a phrase: its times and translation still apply, its glosses do not');
{
  const { b, o, t } = three();
  o.segments[1] = { start: 1100, end: 2100 };
  seg(o, 1).free = 'second';
  seg(t, 1).words[1].txt = 'dde';                       // a typo fixed in FLEx's baseline; the segment stays
  let r = mergeFlexDocs(b, o, t);
  let d = opsOf(r, t);
  ok(r.conflicts.length === 0 && kinds(d) === 'ft.set,times.set', 'times and translation go onto FLEx\'s segment: ' + kinds(d));
  ok(seg(r.doc, 1).words[1].txt === 'dde', 'FLEx\'s wording stays');
  const x = three();
  seg(x.o, 0).words[0].gls = 'A2';
  seg(x.t, 0).words[0].txt = 'aab';
  r = mergeFlexDocs(x.b, x.o, x.t);
  ok(r.conflicts.length === 1 && r.conflicts[0].kind === 'gloss' && !r.conflicts[0].forceable && r.conflicts[0].word === 1, 'a gloss on a phrase FLEx reworded: a conflict nobody can force');
  r = mergeFlexDocs(x.b, x.o, x.t, { prefer: 'mine' });
  ok(opsOf(r, x.t).ops.length === 0, '…not even with "use mine": there is no sure word to put it on');
}

console.log('\nFLEx re-segmented around a phrase: its times no longer have a place');
{
  const { b, o, t } = three();
  o.segments[lineOf(o, 's3')] = { start: 2000, end: 3000 };
  const ext = { ...clone(t.paragraphs[2]), guid: 'ln-sX' };
  ext.segments[0].attrs.guid = 'sX';
  t.paragraphs.splice(3, 0, ext);                      // FLEx split s3: a new segment right after it
  t.segments.splice(3, 0, { start: 0, end: 0, timePending: true });
  const r = mergeFlexDocs(b, o, t);
  ok(r.conflicts.some((c) => c.kind === 'times' && c.segGuid === 's3' && !c.forceable), 'a conflict on s3\'s times');
  ok(!opsOf(r, t).ops.some((op) => op.op === 'times.set'), 'and its times are not written');
}

console.log('\na split here, a gloss in FLEx in the same phrase');
{
  const { b, o, t } = three();
  splitS3(o);
  reGloss(seg(t, 2).words[1], 'F');                  // fff, which went to the new half here
  const r = mergeFlexDocs(b, o, t);
  const d = opsOf(r, t);
  ok(r.conflicts.length === 0, 'no conflicts');
  ok(JSON.stringify(d.ops) === plain(b, o) && d.ops.some((op) => op.op === 'phrase.split'),
     'exactly the ops the split writes with FLEx unchanged — no gloss.set: ' + kinds(d));
  ok(!d.unsupported.length, 'and nothing reads as a gloss changed under the split');
  const half = r.doc.paragraphs.find((ln) => ln.segments[0].attrs.guid === 'eng-new').segments[0];
  ok(half.words[0].gls === 'F' && half.words[0].flex.analysisGuid === 'new-an8', 'FLEx\'s gloss travels with its word into the new half');
  const post = postStateOf(r.doc, d.touched, t);
  ok(post.P2[1].words[0].gls === 'F', 'and the post-state expects it there');
}

console.log('\na split here of a phrase FLEx reworded, or retranslated');
{
  let x = three();
  splitS3(x.o);
  seg(x.t, 2).words[0].txt = 'eeh';
  let r = mergeFlexDocs(x.b, x.o, x.t);
  ok(r.conflicts.length === 1 && r.conflicts[0].kind === 'structure' && !r.conflicts[0].forceable, 'reworded in FLEx: the split is a conflict');
  ok(opsOf(r, x.t).ops.length === 0 && r.doc.paragraphs.length === 4, 'the paragraph stays as FLEx has it; nothing written');
  ok(r.conflicts[0].lines.join() === '3,4,5', 'the conflict names every line of the paragraph here: ' + r.conflicts[0].lines.join());
  x = three();
  splitS3(x.o);
  seg(x.t, 2).free = 'third, in FLEx';
  r = mergeFlexDocs(x.b, x.o, x.t);
  ok(r.conflicts.length === 1 && r.conflicts[0].kind === 'structure', 'retranslated in FLEx: its halves share what was one translation, so a conflict too');
  x = three();
  splitS3(x.o);
  seg(x.t, 3).free = 'fourth, in FLEx';               // s4: in the reshaped paragraph, not reshaped itself
  r = mergeFlexDocs(x.b, x.o, x.t);
  const d = opsOf(r, x.t);
  ok(r.conflicts.length === 0 && JSON.stringify(d.ops) === plain(x.b, x.o) && !d.ops.some((op) => op.segGuid === 's4'),
     'a phrase of that paragraph not reshaped here takes FLEx\'s translation, and nothing writes it back: ' + kinds(d));
  ok(seg(r.doc, lineOf(r.doc, 's4')).free === 'fourth, in FLEx', 'it is FLEx\'s in the merged text');
}

console.log('\na join here, a gloss in FLEx on a word that moved into the survivor');
{
  const { b, o, t } = three();
  const i = lineOf(o, 's3');
  seg(o, i).words = seg(o, i).words.concat(seg(o, i + 1).words);
  seg(o, i).free = 'third';
  o.paragraphs.splice(i + 1, 1);
  o.segments.splice(i + 1, 1);
  reGloss(seg(t, 3).words[0], 'G');
  const r = mergeFlexDocs(b, o, t);
  const d = opsOf(r, t);
  ok(r.conflicts.length === 0 && d.ops.some((op) => op.op === 'phrase.join') && !d.ops.some((op) => op.op === 'gloss.set'), 'the join is written, the gloss is not: ' + kinds(d));
  ok(seg(r.doc, lineOf(r.doc, 's3')).words[2].gls === 'G', 'the survivor carries FLEx\'s gloss for ggg');
}

console.log('\nwhat FLEx added, and what it took away');
{
  let x = three();
  x.o.segments[1] = { start: 1000, end: 2500 };
  const p3 = { ...clone(x.t.paragraphs[3]), guid: 'ln-s9', paraOf: 'P3' };
  p3.segments[0].attrs.guid = 's9';
  x.t.paragraphs.push(p3);
  x.t.segments.push({ start: 0, end: 0, timePending: true });
  let r = mergeFlexDocs(x.b, x.o, x.t);
  ok(r.conflicts.length === 0 && r.doc.paragraphs.length === 5 && kinds(opsOf(r, x.t)) === 'times.set', 'a paragraph FLEx added is kept; only our times are written');
  x = three();
  x.o.segments[2] = { start: 2000, end: 2500 };
  x.t.paragraphs.splice(2, 2);
  x.t.segments.splice(2, 2);
  r = mergeFlexDocs(x.b, x.o, x.t);
  ok(r.conflicts.length === 1 && r.conflicts[0].kind === 'gone' && r.conflicts[0].line === 3, 'work on a phrase FLEx no longer has: a conflict ("gone")');
  ok(opsOf(r, x.t).ops.length === 0, 'and nothing is written');
}

console.log('\na join across paragraphs here, with a paragraph FLEx put between them');
{
  const { b, o, t } = three();
  // s2 (P1, ends in §) takes s3 (P2) into it — and P2's s4 moves into P1 with it
  const i = lineOf(o, 's2');
  seg(o, i).words = seg(o, i).words.concat(seg(o, i + 1).words);
  o.paragraphs.splice(i + 1, 1);
  o.segments.splice(i + 1, 1);
  o.paragraphs[i + 1].paraOf = 'P1';
  const mid = { ...clone(t.paragraphs[3]), guid: 'ln-sM', paraOf: 'PM' };
  mid.segments[0].attrs.guid = 'sM';
  t.paragraphs.splice(2, 0, mid);
  t.segments.splice(2, 0, { start: 0, end: 0, timePending: true });
  const r = mergeFlexDocs(b, o, t);
  ok(r.conflicts.length === 1 && r.conflicts[0].kind === 'structure', 'the two paragraphs are no longer side by side in FLEx: a conflict');
  ok(!opsOf(r, t).ops.some((op) => /join|toPhrase/.test(op.op)), 'and no join is written');
}

console.log('\ncells FLEx changed that were left alone here');
{
  const { b, o, t } = three();
  t.segments[0] = { start: 0, end: 900 };
  seg(t, 0).attrs['end-time-offset'] = '900';
  seg(t, 2).free = 'third, in FLEx';
  const r = mergeFlexDocs(b, o, t);
  ok(r.conflicts.length === 0 && opsOf(r, t).ops.length === 0, 'FLEx\'s times and translation stay, and nothing is written back over them');
  ok(r.theirs === 2, 'two phrases FLEx changed');
}

console.log('\nthe merged text is a text: FLEx\'s order, every line with its span');
{
  const { b, o, t } = three();
  splitS3(o);
  o.segments[0] = { start: 0, end: 950, guess: [null, 950], timeEstimated: true };
  const r = mergeFlexDocs(b, o, t);
  ok(r.doc.paragraphs.length === r.doc.segments.length && r.doc.paragraphs.length === 5, 'lines and spans side by side');
  ok(r.doc.paragraphs.map((ln) => ln.segments[0].attrs.guid).join() === 's1,s2,s3,eng-new,s4', 'in order: ' + r.doc.paragraphs.map((ln) => ln.segments[0].attrs.guid).join());
  ok(r.doc.segments[0].end === 950 && r.doc.flex.textGuid === 't1', 'our times, and FLEx\'s text-level facts');
  ok(b.paragraphs.length === 4 && o.paragraphs.length === 5 && t.paragraphs.length === 4, 'the three inputs are untouched');
}

console.log('\na gloss and times changed differently on both sides');
{
  const { b, o, t } = three();
  seg(o, 0).words[0].gls = 'A2';
  reGloss(seg(t, 0).words[0], 'A3');
  o.segments[1] = { start: 1000, end: 2200 };
  t.segments[1] = { start: 1000, end: 1800 };
  seg(t, 1).attrs['end-time-offset'] = '1800';
  let r = mergeFlexDocs(b, o, t);
  ok(r.conflicts.map((c) => c.kind).sort().join() === 'gloss,times' && r.conflicts.every((c) => c.forceable), 'two conflicts, both forceable');
  ok(opsOf(r, t).ops.length === 0, 'unforced: FLEx keeps both, nothing written');
  r = mergeFlexDocs(b, o, t, { prefer: 'mine' });
  const d = opsOf(r, t);
  ok(kinds(d) === 'gloss.set,times.set' && d.ops.find((op) => op.op === 'gloss.set').value === 'A2' && d.ops.find((op) => op.op === 'times.set').end === 2200,
     '"use mine": both of ours are written: ' + kinds(d));
}

console.log('\nthe two edges: FLEx unchanged, and nothing done here');
{
  const cases = {
    times: (o) => { o.segments[2] = { start: 2000, end: 3000 }; },
    gloss: (o) => { seg(o, 1).words[1].gls = 'D'; },
    free: (o) => { seg(o, 3).free = 'fourth'; },
    split: (o) => splitS3(o),
    wordSplit: (o) => { const w = seg(o, 2).words; seg(o, 2).words = [w[0], { ...w[1], txt: 'f', guid: undefined, flex: undefined }, { txt: 'ff', punct: false, gls: '' }]; },
  };
  for (const [name, change] of Object.entries(cases)) {
    const { b, o, t } = three();
    change(o);
    const r = mergeFlexDocs(b, o, t);   // t is still the check-out
    ok(r.conflicts.length === 0 && JSON.stringify(opsOf(r, t).ops) === plain(b, o), `${name}: with FLEx unchanged the merge writes exactly what a plain save writes`);
    const r2 = mergeFlexDocs(b, clone(b), o);   // nothing here; FLEx made this change
    ok(r2.conflicts.length === 0 && opsOf(r2, o).ops.length === 0, `${name}: done in FLEx with nothing here, nothing is written`);
  }
}

if (fail) { console.error(`\n${fail} FAILED`); process.exit(1); }
console.log('\nall ok');
