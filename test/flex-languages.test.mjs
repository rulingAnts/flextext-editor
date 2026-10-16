/* EVERY ANALYSIS WRITING SYSTEM OF A FLEx TEXT, KEPT AND EDITABLE (desktop-flex; Seth, 2026-10-16: "I want our
 * app to cache and be able to edit (if the user wants) ALL writing systems (like they can switch from English
 * to indonesian mid-way and their English changes will be saved)"; "If it edits a GUID object (a word), it
 * should ONLY change what we changed and leave everything else preserved. I don't want it erasing data in
 * other writing systems or languages when I edit ONE of them, or only letting me make changes to one of them
 * at a time.")
 *
 * The engine side: a gloss or a translation is set in ONE language (setGlossIn / setFreeIn), the diff names
 * every language that changed and only those, the post-state the shell compares holds every language, and a
 * merge with FLEx's changes treats each language as its own cell. Made-up fixtures in the shape the shell's
 * to_engine_doc returns.
 *
 * Run: node test/flex-languages.test.mjs */
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { diffFlexDoc, postStateOf, mergeFlexDocs, glossMap, freeMap } = await import('../docs/js/flex-ops.js');
const { setGlossIn, setFreeIn, glossIn, freeIn, wordGlosses, mergePhrases, splitWordAt, analysisRows } = await import('../docs/js/flextext.js');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const clone = (x) => JSON.parse(JSON.stringify(x));
const J = JSON.stringify;
const S = (m) => J(Object.fromEntries(Object.entries(m || {}).sort()));   // a map, its keys in order

// ---- fixtures in to_engine_doc's shape: the primary in the slot, every other language an item
const item = (l, t) => `<item type="gls" lang="${l}">${t}</item>`;
let n = 0;
const W = (txt, g = null, prim = 'en') => {
  const id = 'an' + (++n);
  const w = { guid: id + ':0', txt, punct: false, phrase: false, gls: '', preservedXML: [], flex: { analysisGuid: id, analysisKind: g ? 'gloss' : 'wordform' } };
  if (g) {
    w.gls = g[prim] || ''; w.glsLang = prim; w.glosses = { ...g };
    w.preservedXML = Object.entries(g).filter(([l, t]) => l !== prim && t).map(([l, t]) => item(l, t));
  }
  return w;
};
const P = (txt) => ({ guid: 'pf' + (++n) + ':0', txt, punct: true, flex: { analysisGuid: 'pf' + n, analysisKind: 'punct' } });
const SEC = () => Object.assign(P('§'), { boundaryMarker: true });
const line = (pg, sg, words, ft = {}, prim = 'en') => {
  words.forEach((w, i) => { w.flex = { ...w.flex, index: i, seg: sg }; w.guid = w.flex.analysisGuid + ':' + i; });
  return { guid: 'ln-' + sg, paraOf: pg, flex: { paraGuid: pg, segGuid: sg },
    segments: [{ attrs: { guid: sg }, baseline: words.map((w) => w.txt).join(' '), words, free: ft[prim] || '', freeLang: ft[prim] ? prim : null,
      frees: { ...ft }, lits: {}, preItemsXML: [], postItemsXML: Object.entries(ft).filter(([l, t]) => l !== prim && t).map(([l, t]) => item(l, t)),
      txtLang: 'xx', flex: { paraGuid: pg, segGuid: sg, notes: [] } }] };
};
/* P1: s1 "kkk lll kkk" (kkk glossed en/id/fr? — fr is not shown: the doc carries the current ones only),
 *     s2 "mmm nnn §"; P2: s3 "ooo ppp" */
const base = () => {
  n = 0;
  const d = { title: 'T', vernLang: 'xx', analLang: 'en', flex: { textGuid: 't1', media: [], ws: { vern: 'xx', anal: 'en' }, anals: ['en', 'id'] }, paragraphs: [
    line('P1', 's1', [W('kkk', { en: 'K-en', id: 'K-id' }), W('lll', { en: 'L-en' }), W('kkk', { en: 'K-en', id: 'K-id' })], { en: 'one', id: 'satu' }),
    line('P1', 's2', [W('mmm'), W('nnn', { id: 'N-id' }), SEC()], { en: 'two' }),
    line('P2', 's3', [W('ooo', { en: 'O-en', id: 'O-id' }), W('ppp')], { id: 'tiga' }),
  ] };
  d.segments = d.paragraphs.map(() => ({ start: 0, end: 0, timePending: true }));
  return d;
};
const seg = (doc, i) => doc.paragraphs[i].segments[0];
const kinds = (r) => r.ops.map((o) => o.op).sort().join(',');

console.log('\nsetGlossIn / setFreeIn: one language, the others exactly as they were');
{
  const w = { gls: 'dog', glsLang: 'en', preservedXML: [item('id', 'anjing'), '<morphemes><morph><item type="gls" lang="en">X</item></morph></morphemes>'], glosses: { en: 'dog', id: 'anjing' } };
  ok(setGlossIn(w, 'id', 'anjing besar', 'en') && J(wordGlosses(w)) === J([{ lang: 'en', text: 'dog' }, { lang: 'id', text: 'anjing besar' }]), 'another language: its item, changed where it stands');
  ok(w.preservedXML[1].startsWith('<morphemes>') && w.glosses.id === 'anjing besar', 'a morpheme block is not a word gloss, and the ride-along map follows');
  ok(setGlossIn(w, 'en', 'hound', 'en') && w.gls === 'hound' && glossIn(w, 'id', 'en') === 'anjing besar', 'the slot\'s language: the slot');
  ok(!setGlossIn(w, 'en', 'hound', 'en'), 'the same text again changes nothing');
  ok(setGlossIn(w, 'fr', 'chien', 'en') && glossIn(w, 'fr', 'en') === 'chien' && glossIn(w, 'en', 'en') === 'hound', 'a language the word had none in: a new item, the others kept');
  ok(setGlossIn(w, 'id', '', 'en') && !w.preservedXML.some((x) => x.includes('lang="id"')) && !('id' in w.glosses), 'emptied: the item goes');
  const bare = { gls: '', preservedXML: [] };
  setGlossIn(bare, 'id', 'satu', 'en');
  ok(bare.gls === '' && glossIn(bare, 'id', 'en') === 'satu', 'an unglossed word typed in another language keeps the slot for its own');
  const s = { free: '', freeLang: null, preItemsXML: [], postItemsXML: ['<item type="note" lang="en">n</item>'] };
  setFreeIn(s, 'id', 'a & <b>', 'en');
  ok(freeIn(s, 'id', 'en') === 'a & <b>' && s.postItemsXML[0].includes('note') && s.postItemsXML[1] === '<item type="gls" lang="id">a &amp; &lt;b&gt;</item>', 'a free translation the same way, escaped, after the note');
}

console.log('\nanalysisRows with the text\'s languages: every one shown, an empty row where there is none');
{
  const rows = analysisRows([{ lang: 'en', text: 'x' }], 'all', 'en', ['en', 'id', 'fr']);
  ok(J(rows) === J([{ lang: 'en', text: 'x', primary: true }, { lang: 'id', text: '', primary: false }, { lang: 'fr', text: '', primary: false }]), 'All with FLEx\'s list: ' + J(rows));
  ok(J(analysisRows([{ lang: 'en', text: 'x' }], 'all', 'en')) === J([{ lang: 'en', text: 'x', primary: true }]), 'without a list: as before');
}

console.log('\nthe diff names every language that changed — and only those');
{
  const b = base(), c = clone(b);
  setGlossIn(seg(c, 0).words[0], 'en', 'K-en2', 'en');
  setGlossIn(seg(c, 0).words[0], 'id', 'K-id2', 'en');      // the SAME word, both languages
  setFreeIn(seg(c, 1), 'id', 'dua', 'en');                  // a translation in a language the line had none in
  setGlossIn(seg(c, 1).words[0], 'id', 'M-id', 'en');       // a word FLEx has no gloss for
  const r = diffFlexDoc(b, c);
  const gl = r.ops.filter((o) => o.op === 'gloss.set');
  ok(kinds(r) === 'ft.set,gloss.set,gloss.set' && !r.unsupported.length, 'two gloss.set, one ft.set: ' + kinds(r));
  ok(J(gl[0]) === J({ op: 'gloss.set', paraGuid: 'P1', segGuid: 's1', index: 0, forms: { en: 'K-en2', id: 'K-id2' } }), 'ONE op for the word, naming both languages: ' + J(gl[0]));
  ok(J(gl[1].forms) === J({ id: 'M-id' }) && gl[1].index === 0 && gl[1].segGuid === 's2', 'the unglossed word: Indonesian only');
  const ft = r.ops.find((o) => o.op === 'ft.set');
  ok(ft.ws === 'id' && ft.value === 'dua' && ft.segGuid === 's2', 'the translation by its language');
  const post = postStateOf(c, r.touched, b);
  const w0 = post.P1[0].words[0];
  ok(J(w0.glosses) === J({ en: 'K-en2', id: 'K-id2' }) && w0.analysisGuid === null, 'the post-state: the word in both languages, its occurrence LCM\'s to choose');
  ok(post.P1[0].words[2].analysisGuid === 'an3' && J(post.P1[0].words[2].glosses) === J({ en: 'K-en', id: 'K-id' }), 'the other "kkk": as FLEx has it, its occurrence promised');
  ok(J(post.P1[1].ft) === J({ en: 'two', id: 'dua' }), 'translations: every language');
  const c2 = clone(b);
  setGlossIn(seg(c2, 0).words[1], 'id', 'L-id', 'en');      // add a language, the English one untouched
  const g2 = diffFlexDoc(b, c2).ops[0];
  ok(J(g2.forms) === J({ id: 'L-id' }), 'adding Indonesian to a word glossed in English names Indonesian only: ' + J(g2.forms));
  const c3 = clone(b);
  setGlossIn(seg(c3, 2).words[0], 'en', '', 'en');           // clear English, keep Indonesian
  ok(J(diffFlexDoc(b, c3).ops[0].forms) === J({ en: '' }), 'clearing one language names that one, emptied');
}

console.log('\na word a split moved, glossed in the same save: set where FLEx holds it now');
{
  const b = base(), c = clone(b);
  const words = seg(c, 0).words;
  seg(c, 0).words = words.slice(0, 1);
  c.paragraphs.splice(1, 0, { guid: 'ln-n', paraOf: 'P1', segments: [{ attrs: { guid: 'eng-n' }, baseline: 'lll kkk', words: words.slice(1), free: '', freeLang: null, preItemsXML: [], postItemsXML: [] }] });
  c.segments.splice(1, 0, { start: 0, end: 0, timePending: true });
  setGlossIn(words[1], 'id', 'L-id', 'en');                  // lll, now in the new half
  const r = diffFlexDoc(b, c);
  const g = r.ops.find((o) => o.op === 'gloss.set');
  ok(!r.unsupported.length && r.ops.some((o) => o.op === 'phrase.split') && g && g.segGuid === 's1' && g.index === 1 && !g.newWord,
     'phrase.split + a gloss.set at the word\'s place in the checked-out text: ' + J(g));
}

console.log('\nwords made here: glossed after the save makes them, at their place, with their form');
{
  const b = base(), c = clone(b);
  const s = seg(c, 2);
  ok(splitWordAt(s, 1, 1).ok, 'ppp → p pp');
  setGlossIn(s.words[2], 'id', 'PP-id', 'en');
  setGlossIn(s.words[2], 'en', 'PP-en', 'en');
  const r = diffFlexDoc(b, c);
  const g = r.ops.find((o) => o.op === 'gloss.set');
  ok(r.ops.some((o) => o.op === 'word.split') && g && g.newWord === true && g.form === 'pp' && g.index === 2 && g.segGuid === 's3' && J(g.forms) === J({ en: 'PP-en', id: 'PP-id' }),
     'a split half typed in two languages: one newWord gloss.set with both: ' + J(g));
  ok(!r.ops.some((o) => o.op === 'gloss.set' && !o.newWord), 'and nothing for "ooo", whose gloss is as it was (its place moved nothing)');
  const c2 = clone(b);
  seg(c2, 2).words[0].txt = 'oo';                             // respelled: its glosses come along
  seg(c2, 2).baseline = 'oo ppp';
  const r2 = diffFlexDoc(b, c2);
  const g2 = r2.ops.find((o) => o.op === 'gloss.set');
  ok(r2.ops.some((o) => o.op === 'baseline.replace') && g2 && g2.newWord && g2.form === 'oo' && J(g2.forms) === J({ en: 'O-en', id: 'O-id' }),
     'a respelled word is a new wordform in FLEx: its glosses, every language, are set on it: ' + J(g2));
  const post2 = postStateOf(c2, r2.touched, b);
  ok(post2.P2[0].words[0].analysisGuid === null && J(post2.P2[0].words[0].glosses) === J({ en: 'O-en', id: 'O-id' }), 'and the post-state expects them there');
}

console.log('\na join: one translation per language, FLEx\'s § gone from the words, every language set outright');
{
  const b = base(), c = clone(b);
  const m = mergePhrases([seg(c, 0), seg(c, 1)]);
  ok(J(freeMap(m, 'en')) === J({ en: 'one two', id: 'satu' }) && m.postItemsXML.filter((x) => x.includes('lang="id"')).length === 1, 'merged: ' + J(freeMap(m, 'en')));
  c.paragraphs.splice(0, 2, { guid: 'ln-s1', paraOf: 'P1', segments: [m] });
  c.segments.splice(0, 2, { start: 0, end: 0, timePending: true });
  const r = diffFlexDoc(b, c);
  const fts = r.ops.filter((o) => o.op === 'ft.set').map((o) => o.ws + '=' + o.value).sort().join(',');
  ok(r.ops.some((o) => o.op === 'phrase.join') && fts === 'en=one two,id=satu', 'the survivor\'s translations set in every language: ' + fts);
  const post = postStateOf(c, r.touched, b);
  ok(!post.P1[0].words.some((w) => w.txt === '§') && post.P1[0].words.length === 5, 'the § between them is not in the post-state (FLEx\'s join removes it)');
  ok(!r.ops.some((o) => o.op === 'gloss.set'), 'no gloss written: every word kept its gloss');
}

console.log('\nafter an Undo of a save: the copy holds FLEx\'s text as it was after the save — read by its shape');
{
  // FLEx after a save that split s1: s1 "kkk", new phrase N "lll kkk" — read afresh, so its words carry N's places
  const b = base();
  const after = clone(b);
  const ws = seg(after, 0).words;
  seg(after, 0).words = ws.slice(0, 1);
  const moved = ws.slice(1).map((w, i) => ({ ...w, guid: w.flex.analysisGuid + ':' + i, flex: { ...w.flex, seg: 'N', index: i } }));
  after.paragraphs.splice(1, 0, { guid: 'ln-N', paraOf: 'P1', flex: { paraGuid: 'P1', segGuid: 'N' }, segments: [{ attrs: { guid: 'N' }, baseline: 'lll kkk', words: moved, free: '', freeLang: null, preItemsXML: [], postItemsXML: [] }] });
  after.segments.splice(1, 0, { start: 0, end: 0, timePending: true });
  // Undo: FLEx is the checked-out text again (b); the copy is `after`
  const r = diffFlexDoc(b, after);
  ok(kinds(r) === 'phrase.split,times.set,times.set' && !r.unsupported.length, 'the work again is exactly the split (an untimed one sets its pieces\' times outright): ' + kinds(r));
  const edited = clone(after);
  setGlossIn(seg(edited, 1).words[0], 'id', 'L-id', 'en');
  const r2 = diffFlexDoc(b, edited);
  const g = r2.ops.find((o) => o.op === 'gloss.set');
  ok(g && !g.newWord && g.segGuid === 's1' && g.index === 1 && J(g.forms) === J({ id: 'L-id' }), 'a gloss edited since: at the word\'s place in FLEx\'s text, not as a new word: ' + J(g));
  const post = postStateOf(after, r.touched, b);
  ok(post.P1[1].words[1].analysisGuid === 'an3', 'and the post-state still promises the moved words\' occurrences');
}

console.log('\nthe merge: each language its own cell');
{
  const b = base(), o = clone(b), t = clone(b);
  setGlossIn(seg(o, 0).words[1], 'en', 'L-en2', 'en');       // here: lll in English
  setGlossIn(seg(t, 0).words[1], 'id', 'L-id', 'en');         // FLEx: lll in Indonesian
  seg(t, 0).words[1].flex.analysisGuid = 'new-gloss';         // (a different gloss object in FLEx now)
  setFreeIn(seg(o, 2), 'en', 'three', 'en');                  // here: English translation of s3
  setFreeIn(seg(t, 2), 'id', 'tiga!', 'en');                  // FLEx: its Indonesian one
  let r = mergeFlexDocs(b, o, t);
  ok(r.conflicts.length === 0, 'different languages of the same word and line: no conflict');
  ok(S(glossMap(seg(r.doc, 0).words[1], 'en')) === S({ en: 'L-en2', id: 'L-id' }) && S(freeMap(seg(r.doc, 2), 'en')) === S({ id: 'tiga!', en: 'three' }),
     'the merged text has both: ' + J(glossMap(seg(r.doc, 0).words[1], 'en')) + ' ' + J(freeMap(seg(r.doc, 2), 'en')));
  const d = diffFlexDoc(t, r.doc);
  ok(J(d.ops.map((x) => [x.op, x.forms || x.ws + '=' + x.value])) === J([['ft.set', 'en=three'], ['gloss.set', { en: 'L-en2' }]]),
     'and the save writes ours only, in our language: ' + J(d.ops.map((x) => x.op)));
  // the same language changed differently on both sides: a conflict naming the language, the other language FLEx's
  const o2 = clone(b), t2 = clone(b);
  setGlossIn(seg(o2, 2).words[0], 'en', 'O-mine', 'en');
  setGlossIn(seg(t2, 2).words[0], 'en', 'O-theirs', 'en');
  setGlossIn(seg(t2, 2).words[0], 'id', 'O-id2', 'en');
  r = mergeFlexDocs(b, o2, t2);
  ok(r.conflicts.length === 1 && r.conflicts[0].kind === 'gloss' && r.conflicts[0].ws === 'en' && r.conflicts[0].forceable, 'one conflict, in English: ' + J(r.conflicts));
  ok(J(glossMap(seg(r.doc, 2).words[0], 'en')) === J({ en: 'O-theirs', id: 'O-id2' }), 'unforced: FLEx\'s English, and its Indonesian');
  r = mergeFlexDocs(b, o2, t2, { prefer: 'mine' });
  ok(J(glossMap(seg(r.doc, 2).words[0], 'en')) === J({ en: 'O-mine', id: 'O-id2' }), '"use mine": my English, FLEx\'s Indonesian still');
  ok(J(diffFlexDoc(t2, r.doc).ops.map((x) => x.forms)) === J([{ en: 'O-mine' }]), 'and only English is written');
}

console.log('\na split here, Indonesian changed in FLEx on a moved word: both kept, FLEx\'s never written back');
{
  const b = base(), o = clone(b), t = clone(b);
  const words = seg(o, 0).words;
  seg(o, 0).words = words.slice(0, 1);
  o.paragraphs.splice(1, 0, { guid: 'ln-n', paraOf: 'P1', segments: [{ attrs: { guid: 'eng-n' }, baseline: 'lll kkk', words: words.slice(1), free: '', freeLang: null, preItemsXML: [], postItemsXML: [] }] });
  o.segments.splice(1, 0, { start: 0, end: 0, timePending: true });
  setGlossIn(words[2], 'en', 'K-mine', 'en');                 // the second kkk, in English
  setGlossIn(seg(t, 0).words[2], 'id', 'K-theirs', 'en');      // FLEx: its Indonesian
  const r = mergeFlexDocs(b, o, t);
  const half = r.doc.paragraphs.find((ln) => ln.segments[0].attrs.guid === 'eng-n').segments[0];
  ok(r.conflicts.length === 0 && J(glossMap(half.words[1], 'en')) === J({ en: 'K-mine', id: 'K-theirs' }), 'merged: ' + J(glossMap(half.words[1], 'en')));
  const d = diffFlexDoc(t, r.doc);
  const g = d.ops.find((x) => x.op === 'gloss.set');
  ok(g && J(g.forms) === J({ en: 'K-mine' }) && g.segGuid === 's1' && g.index === 2, 'the save: the split, and English only on that word: ' + J(g));
}

console.log(fail ? `\n${fail} FAILED\n` : '\nall ok\n');
process.exit(fail ? 1 : 0);
