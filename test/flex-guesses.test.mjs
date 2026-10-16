// FLEx's guesses in the Matcher (2026-10-16). A word a FLEx text has not analysed shows, in FLEx, its best
// guess from elsewhere — blue, every writing system of it. In the app those words showed blank; Seth typed
// glosses in one language for words FLEx was showing in another. The page now shows the guess, typing
// into a guessed word adopts it (its other languages come along), and the save's op names the guess so the
// shell builds on FLEx's own analysis (desktop/tests/test_guesses.py). Made-up fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { wordGlosses, setGlossIn } = await import('../docs/js/flextext.js');
const { diffFlexDoc, postStateOf, graftFlexGuesses, adoptFlexGuesses } = await import('../docs/js/flex-ops.js');

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), CSS = rd('../docs/css/app.css'), I18N = rd('../docs/js/i18n.js');
const fn = (src, name) => { const i = src.indexOf(`function ${name}(`); return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i) + 2); };
const clone = (x) => JSON.parse(JSON.stringify(x));

// the two functions, lifted from app.js and run against the real flextext.js helpers
const lifted = new Function('glossesOfWord', 'setGlossIn', 'mgPrimaryLang',
  fn(APP, 'mgGuessOf') + '\n' + fn(APP, 'mgAdoptGuess') + '\nreturn { mgGuessOf, mgAdoptGuess };');
const { mgGuessOf, mgAdoptGuess } = lifted(wordGlosses, setGlossIn, () => 'id');

const GUESS = { analysisGuid: 'an-k', glossGuid: 'gl-k', gloss: { en: 'L-en' }, form: 'lll' };
const guessed = () => ({ guid: 'wf-1:1', txt: 'lll', punct: false, gls: '', preservedXML: [],
  flex: { analysisGuid: 'wf-1', analysisKind: 'wordform', index: 1, seg: 's1', guess: clone(GUESS) } });

test('a word FLEx is guessing for shows the guess until it has a gloss of its own', () => {
  const w = guessed();
  assert.deepEqual(mgGuessOf(w), GUESS);
  assert.equal(mgGuessOf({ ...w, txt: 'llll' }), null, 'respelled: no longer the word FLEx was guessing for');
  const glossed = guessed(); setGlossIn(glossed, 'id', 'L-id', 'id');
  assert.equal(mgGuessOf(glossed), null, 'a gloss of its own in any language: the guess is not shown');
  assert.equal(mgGuessOf({ ...w, flex: { ...w.flex, analysisKind: 'gloss' } }), null, 'an analysed word is never guessed for');
  assert.equal(mgGuessOf({ txt: 'x' }), null);
});

test('typing Indonesian into a word FLEx guesses English for keeps the English (made-up words, the shape of Seth\'s case)', () => {
  const w = guessed();
  assert.deepEqual(mgAdoptGuess(w, 'id'), { en: 'L-en' }, 'says what it adopted');
  setGlossIn(w, 'id', 'L-id', 'id');
  const by = Object.fromEntries(wordGlosses(w).map((e) => [e.lang || 'id', e.text]));
  assert.deepEqual(by, { en: 'L-en', id: 'L-id' });
  // typed in the guess's own language: the typed text wins, nothing else is invented
  const v = guessed();
  mgAdoptGuess(v, 'en');
  setGlossIn(v, 'en', 'talking', 'id');
  assert.deepEqual(wordGlosses(v).filter((e) => e.text).map((e) => [e.lang, e.text]), [['en', 'talking']]);
  // a word with a gloss of its own adopts nothing
  const g = guessed(); setGlossIn(g, 'id', 'L-own', 'id');
  assert.equal(mgAdoptGuess(g, 'id'), null);
  assert.ok(!wordGlosses(g).some((e) => e.lang === 'en' && e.text), 'its own glosses are not mixed with a guess');
});

test('the save names the guess: the shell builds on FLEx\'s analysis, never a duplicate of it', () => {
  const base = { title: 'T', vernLang: 'fx', analLang: 'id', flex: { textGuid: 't1', media: [] }, paragraphs: [{
    guid: 'ln-s1', paraOf: 'P1', flex: { paraGuid: 'P1', segGuid: 's1' },
    segments: [{ attrs: { guid: 's1' }, baseline: 'kkk lll', free: '', flex: { paraGuid: 'P1', segGuid: 's1' },
      words: [{ guid: 'wf-0:0', txt: 'kkk', punct: false, gls: '', preservedXML: [], flex: { analysisGuid: 'wf-0', analysisKind: 'wordform', index: 0, seg: 's1' } },
              guessed()] }] }], segments: [{ start: 0, end: 1000 }] };
  const cur = clone(base);
  const w = cur.paragraphs[0].segments[0].words[1];
  mgAdoptGuess(w, 'id');
  setGlossIn(w, 'id', 'L-id', 'id');
  const r = diffFlexDoc(base, cur);
  assert.equal(r.ops.length, 1);
  assert.deepEqual(r.ops[0], { op: 'gloss.set', paraGuid: 'P1', segGuid: 's1', index: 1, forms: { en: 'L-en', id: 'L-id' },
                               guess: { analysisGuid: 'an-k', glossGuid: 'gl-k' } });
  const post = postStateOf(cur, r.touched, base).P1[0].words[1];
  assert.deepEqual(post.glosses, { en: 'L-en', id: 'L-id' }, 'the post-state promises the guess\'s English beside the Indonesian');
  assert.equal(post.analysisGuid, null, 'LCM\'s to assign');
  // a word with no guess: no `guess` on its op (the shell plans it as before)
  const c2 = clone(base);
  setGlossIn(c2.paragraphs[0].segments[0].words[0], 'id', 'K-id', 'id');
  assert.equal(diffFlexDoc(base, c2).ops[0].guess, undefined);
  // an untouched guessed word: nothing to save
  assert.equal(diffFlexDoc(base, clone(base)).ops.length, 0, 'a guess shown is not a change');
});

test('wiring: the guess is drawn in FLEx\'s blue in the empty rows, and typing adopts it', () => {
  const stack = fn(APP, 'mgWordStack');
  assert.match(stack, /const guess = mgGuessOf\(w\.src\);/);
  assert.match(stack, /el\.dataset\.ph = g;\n\s*el\.classList\.add\('mg-guess'\);\n\s*el\.title = t\('mg\.flexGuess', \{ g \}\);/, 'shown as the placeholder, never as the word\'s text');
  assert.match(stack, /if \(g && !el\.textContent && el\.classList\.contains\('mg-edit'\)\)/, 'only in an empty row that can be typed into');
  assert.match(fn(APP, 'mgEditWord'), /const adopted = field === 'gls' && value \? mgAdoptGuess\(ph\.words\[k\], inLang \? lang : mgPrimaryLang\(\)\) : null;\n\s*if \(inLang\) setGlossIn/,
    'adopted before the typed gloss is set, inside the same captured (undoable) edit');
  assert.match(fn(APP, 'mgCommitEdit'), /const adopted = mgEditWord\(ln\.id, wi, field, value, lang\);\n\s*if \(adopted\) mgShowAdopted\(el, adopted\);/,
    'and the word\'s rows show it as its own at once — no row left looking like a guess');
  assert.match(CSS, /\.mg-edit\.mg-guess:empty::before\{[^}]*background:/);
  for (const k of ['mg.flexGuess', 'flex.sum.gloss.guessReuse', 'flex.sum.gloss.guessNew']) {
    assert.equal(I18N.split(`'${k}':`).length - 1, 2, k + ' in both languages');
  }
});

test('a record an older build kept: FLEx\'s guesses are attached while FLEx is unchanged, and adopted at the save', () => {
  const fresh = { analLang: 'id', paragraphs: [{ segments: [{ attrs: { guid: 's1' }, words: [
    { guid: 'wf-0:0', txt: 'kkk', flex: { analysisGuid: 'wf-0', analysisKind: 'wordform', index: 0, seg: 's1', guess: { analysisGuid: 'an-0', glossGuid: 'g-0', gloss: { en: 'K-en' }, form: 'kkk' } } },
    guessed(),
    { guid: 'gl-2:2', txt: 'mmm', gls: 'M', glsLang: 'id', flex: { analysisGuid: 'gl-2', analysisKind: 'gloss', index: 2, seg: 's1' } }] }] }] };
  const old = clone(fresh);
  old.paragraphs[0].segments[0].words.forEach((w) => { delete w.flex.guess; });
  // grafted: metadata only, analysed words untouched, nothing to graft → the same object
  const base = graftFlexGuesses(old, fresh);
  assert.notEqual(base, old);
  assert.equal(base.paragraphs[0].segments[0].words[1].flex.guess.gloss.en, 'L-en');
  assert.equal(base.paragraphs[0].segments[0].words[2].flex.guess, undefined);
  assert.equal(old.paragraphs[0].segments[0].words[1].flex.guess, undefined, 'the record itself is not changed');
  assert.equal(graftFlexGuesses(base, fresh), base, 'already there: the same object back');
  // the work: Indonesian typed into both guessed words by an older build — never adopted there
  const work = clone(old);
  const [k, l] = work.paragraphs[0].segments[0].words;
  setGlossIn(k, 'id', 'K-id', 'id');
  setGlossIn(l, 'id', 'L-id', 'id');
  const done = adoptFlexGuesses(base, work);
  const glosses = (w) => Object.fromEntries(wordGlosses(w).filter((e) => e.text).map((e) => [e.lang || 'id', e.text]));
  assert.deepEqual(glosses(done.paragraphs[0].segments[0].words[0]), { en: 'K-en', id: 'K-id' });
  assert.deepEqual(glosses(done.paragraphs[0].segments[0].words[1]), { en: 'L-en', id: 'L-id' });
  const r = diffFlexDoc(base, done);
  assert.deepEqual(r.ops.map((o) => [o.index, o.forms, o.guess && o.guess.analysisGuid]), [[0, { en: 'K-en', id: 'K-id' }, 'an-0'], [1, { en: 'L-en', id: 'L-id' }, 'an-k']]);
  // adopted in the Matcher already, then a language taken out on purpose: left as it is
  const kept = clone(work);
  kept.paragraphs[0].segments[0].words[1].flex.adopted = true;
  assert.deepEqual(glosses(adoptFlexGuesses(base, kept).paragraphs[0].segments[0].words[1]), { id: 'L-id' });
  // a word not glossed here, or respelled: its guess stays a guess
  const none = clone(old);
  assert.equal(adoptFlexGuesses(base, none), none);
  const resp = clone(work); resp.paragraphs[0].segments[0].words[1].txt = 'llll';
  assert.deepEqual(glosses(adoptFlexGuesses(base, resp).paragraphs[0].segments[0].words[1]), { id: 'L-id' });
});

test('wiring: Save to FLEx attaches and adopts; re-opening a kept record shows the guesses', () => {
  const PANEL = rd('../docs/js/flex-panel.js');
  const steps = fn(PANEL, 'saveSteps');
  assert.match(steps, /\} else \{\n\s*base = graftFlexGuesses\(base, opened\.doc\);/, 'only while FLEx is unchanged (no merge)');
  assert.match(steps, /work = adoptFlexGuesses\(base, work\);\n[\s\S]*const diff = diffFlexDoc\(base, work/, 'before the diff');
  assert.match(PANEL, /if \(how === 'keep'\) \{\n[^\n]*\n\s*rec\.flex\.base = graftFlexGuesses\(rec\.flex\.base, opened\.doc\);\n\s*rec\.doc = graftFlexGuesses\(rec\.doc, opened\.doc\);/);
  assert.match(fn(APP, 'mgAdoptGuess'), /word\.flex\.adopted = true;/, 'the Matcher marks what it adopted, so the save never adopts it twice');
});

test('only FLEx\'s current analysis writing systems are adopted: a save may name no other, and the shell carries the rest', () => {
  // a guess with French, which is no longer one of the project's analysis writing systems
  const g = { ...clone(GUESS), gloss: { en: 'L-en', fr: 'L-fr' } };
  const w = { ...guessed(), flex: { ...guessed().flex, guess: g } };
  const shown = new Function('glossesOfWord', 'setGlossIn', 'mgPrimaryLang', 'current',
    fn(APP, 'mgGuessOf') + '\n' + fn(APP, 'mgAdoptGuess') + '\nreturn mgAdoptGuess;')(wordGlosses, setGlossIn, () => 'id', { doc: { flex: { anals: ['en', 'id'] } } });
  assert.deepEqual(shown(w, 'id'), { en: 'L-en' }, 'French is not adopted in the Matcher');
  const base = { analLang: 'id', flex: { anals: ['en', 'id'] }, paragraphs: [{ segments: [{ attrs: { guid: 's1' }, words: [{ ...guessed(), flex: { ...guessed().flex, guess: g } }] }] }] };
  const work = clone(base);
  delete work.paragraphs[0].segments[0].words[0].flex.guess;
  setGlossIn(work.paragraphs[0].segments[0].words[0], 'id', 'L-id', 'id');
  const done = adoptFlexGuesses(base, work);
  assert.deepEqual(Object.fromEntries(wordGlosses(done.paragraphs[0].segments[0].words[0]).filter((e) => e.text).map((e) => [e.lang || 'id', e.text])),
    { en: 'L-en', id: 'L-id' }, 'nor at the save');
});
