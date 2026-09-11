/* Issue #73 — "when there's punctuation, split scissors do not show up between word/gloss pairs
 * where the punctuation sits" (Seth, 2026-09-10).
 *
 * ⚠ THE CAUSE WAS ONE GATE ANSWERING TWO QUESTIONS. The ✂ was hung off each chain-link, so
 * canMerge decided where a line could be SPLIT as well as where two words could be CHAINED. That
 * gate is right for chaining — you cannot merge a word with a comma into one lexical item — and
 * wrong for splitting, because a gap beside punctuation is often exactly where a line wants to
 * break. canSplitBefore is now the split rule, and it is a typographic one rather than a
 * lexical one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canSplitBefore, canMerge, tokenize, baselineFromWords, punctLeadsWord, punctSideUnknown } from '../docs/js/flextext.js';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const FT = readFileSync(new URL('../docs/js/flextext.js', import.meta.url), 'utf8');
const bare = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// the reported line, tokenized the way the engine does it
const seg = { words: tokenize('Kaisou fedahu, tudu bisa.') };
const gaps = (s) => s.words.map((_, k) => k).filter((k) => canSplitBefore(s, k));

test('the reported line: a ✂ after the comma, and none that would strand punctuation', () => {
  // 0:Kaisou  1:fedahu  2:,  3:tudu  4:bisa  5:.
  assert.deepEqual(seg.words.map((w) => w.txt), ['Kaisou', 'fedahu', ',', 'tudu', 'bisa', '.']);
  assert.deepEqual(seg.words.map((w) => !!w.punct), [false, false, true, false, false, true]);

  // ⚠ gap 3 is the one Seth found missing — immediately after the comma, the natural clause break
  assert.deepEqual(gaps(seg), [1, 3, 4]);
  assert.ok(canSplitBefore(seg, 3), 'splitting AFTER the comma is offered');
  // and the two that would put punctuation at the head of the new line are withheld
  assert.equal(canSplitBefore(seg, 2), false, 'not before the comma — it would strand ","');
  assert.equal(canSplitBefore(seg, 5), false, 'not before the full stop either');
});

test('⚠ the split rule is NOT the chain rule — that conflation was the bug', () => {
  // canMerge refuses every gap touching punctuation, which is correct for chaining...
  assert.equal(canMerge(seg, 1), false, 'fedahu cannot be chained to ","');
  assert.equal(canMerge(seg, 2), false, '"," cannot be chained to tudu');
  // ...and it is exactly why gap 3 had no ✂: no chain-link existed there to hang one off.
  assert.ok(!canMerge(seg, 2) && canSplitBefore(seg, 3),
    'the gap after the comma is unchainable AND splittable — the two questions genuinely differ');
  // where two words meet, both are true, and the pair shares a column
  assert.ok(canMerge(seg, 3) && canSplitBefore(seg, 4), 'tudu|bisa takes both controls');
});

test('each side of a split keeps a real word', () => {
  // a head of nothing but punctuation would make a wordless line
  assert.equal(canSplitBefore({ words: tokenize(', foo') }, 1), false);
  assert.equal(canSplitBefore({ words: tokenize('" ... foo') }, 2), false);
  // the tail is guaranteed a word by rule 1, since the token at the gap is never punctuation
  assert.equal(canSplitBefore({ words: tokenize('foo .') }, 1), false);
  // and a plain two-word line splits down the middle
  assert.deepEqual(gaps({ words: tokenize('foo bar') }), [1]);
});

test('interior gaps only, and nothing explodes on a malformed segment', () => {
  assert.equal(canSplitBefore(seg, 0), false, 'the edges have their own trim ✂');
  assert.equal(canSplitBefore(seg, seg.words.length), false);
  assert.equal(canSplitBefore(seg, -1), false);
  assert.equal(canSplitBefore(seg, 99), false);
  for (const bad of [null, undefined, {}, { words: [] }, { words: null }])
    assert.equal(canSplitBefore(bad, 1), false, JSON.stringify(bad));
  assert.equal(canSplitBefore({ words: [null, { txt: 'a' }] }, 1), false, 'a hole in the list');
});

test('consecutive punctuation is one token, so a quote after a stop needs no special case', () => {
  // tokenize groups a run of punctuation into a single token
  const q = { words: tokenize('foo." bar') };
  assert.deepEqual(q.words.map((w) => w.txt), ['foo', '."', 'bar']);
  assert.deepEqual(gaps(q), [2], 'split after the whole punctuation group, never inside or before it');
});

/* ⚠ AND THE PLACEMENT IS PER GAP, not per chain-link — which is what actually makes the missing ✂
 * appear. The gap index needs no counting: renderSegment appends one .word-cell per seg.words
 * entry, punctuation included, so the gap before cells[k] IS k. */
test('the decoration walks word gaps and asks canSplitBefore', () => {
  const blk = APP.slice(APP.indexOf('const gapRow = g.querySelector'), APP.indexOf('/* EDGE ✂'));
  assert.match(blk, /for \(let k = 1; k < cells\.length; k\+\+\)/, 'every interior gap, by model index');
  assert.match(blk, /if \(!canSplitBefore\(gapPhrase, k\)\) continue;/, 'and the split rule decides');
  // ⚠⚠ about the PHRASE of line i. v676 asked about docSegments(doc)[i], line i's audio span, which has
  // no words, so every gap was refused and no ✂ appeared between any word/gloss pair (v676–v684).
  assert.match(blk, /const gapPhrase = current\.doc\.paragraphs\[i\] && current\.doc\.paragraphs\[i\]\.segments\[0\];/,
    'the phrase, which carries the words');
  assert.doesNotMatch(bare(blk), /docSegments\(/, 'never the time span');
  assert.match(blk, /sc\.dataset\.gap = String\(k\);/, 'k is the model index — no counting');
  assert.match(blk, /glossPlace\(i, 'words', k\)/);
  // a chain-link already at that gap is ADOPTED, so its own merge handler survives
  assert.match(blk, /link\.replaceWith\(wrapEl\);\s*\n\s*wrapEl\.appendChild\(link\);/, 'adopted, not replaced');
  // and re-running the pass must not stack a second ✂ in the same column
  assert.match(blk, /if \(wrapEl\.querySelector\('\.scissor-btn'\)\) continue;/, 'idempotent');
  // ⚠ the old chain-link walk is gone — that is the fix, not an incidental tidy
  assert.doesNotMatch(bare(APP), /querySelectorAll\('\.chain-btn'\)\.forEach/);

  // the 🔗 is still governed by canMerge, untouched
  assert.match(APP, /if \(canMerge\(seg, i\)\) \{/, 'chaining still asks canMerge');
  // the rule itself lives in the model layer beside canMerge, so it is testable without a DOM
  assert.match(FT, /export function canSplitBefore\(seg, k\) \{/);
  assert.match(FT, /A TRAILING MARK MAY NOT START THE NEW LINE/, 'and says why, where someone would change it');
  assert.match(FT, /A LEADING MARK MAY NOT END THE OLD ONE/, 'including the opening-mark mirror');
});

/* ⚠ OPENING MARKS BELONG TO THE WORD AFTER THEM — the mirror of rule 1 (Seth, 2026-09-10: "What
 * about single and double quotes and parentheses…? Keep opening/first punctuation marks in mind
 * too. I think spaces…"). Right, and the spacing IS the tell: baselineFromWords already puts a
 * space before an opening mark and none after it, which is precisely the statement that it leads
 * the following word. canSplitBefore shares that classifier so the two can never disagree. */
test('an opening mark travels with its word, so no break between them', () => {
  const paren = { words: tokenize('foo (bar) baz') };
  assert.deepEqual(paren.words.map((w) => w.txt), ['foo', '(', 'bar', ')', 'baz']);
  assert.deepEqual(gaps(paren), [1, 4]);
  assert.ok(canSplitBefore(paren, 1), 'before "(" is fine — the whole "(bar)" travels together');
  assert.equal(canSplitBefore(paren, 2), false, 'but not between "(" and its word');
  assert.equal(canSplitBefore(paren, 3), false, 'nor before ")", which trails');
  assert.ok(canSplitBefore(paren, 4), 'after ")" is fine');

  // and the halves rebuild the way the split promised
  assert.equal(baselineFromWords(paren.words.slice(0, 1)), 'foo');
  assert.equal(baselineFromWords(paren.words.slice(1)), '(bar) baz');

  for (const [text, want] of [
    ['foo [PL] baz', [1, 4]],
    ['he said “go now” then left', [1, 2, 4, 6, 7]],
    ['dijo «hola» y salió', [1, 4, 5]],   // before «, after », and between the last two words
  ]) assert.deepEqual(gaps({ words: tokenize(text) }), want, text);

  // the classifier itself, shared with the line rebuilder
  for (const ch of ['(', '[', '{', '«', '“', '‘', '¿', '¡']) assert.ok(punctLeadsWord(ch), ch);
  for (const ch of ['.', ',', ')', ']', '”', '’', '»', ';', '!']) assert.ok(!punctLeadsWord(ch), ch);
  assert.match(FT, /if \(punctLeadsWord\(w\.txt\)\)/, 'baselineFromWords uses the same one');
});

/* ⚠⚠ A MARK WHOSE SIDE CANNOT BE KNOWN GETS NO BREAK EITHER SIDE. The straight quotes open and close
 * with the same character, so no rule reading one token can tell which this is. baselineFromWords
 * must emit something and picks leading; a split has a third option — decline. Refusing both gaps
 * can never strand a mark, where guessing by parity is wrong on any line with an odd number of them,
 * which is exactly the line someone is halfway through typing. */
test('a straight quote blocks a break on both sides rather than guessing', () => {
  assert.ok(punctSideUnknown('"') && punctSideUnknown("'"));
  assert.ok(!punctSideUnknown('“') && !punctSideUnknown('»'), 'typographic quotes are unambiguous');
  assert.ok(!punctSideUnknown('."'), 'a group is judged by its FIRST character — this one trails');

  const q = { words: tokenize('he said "go now" then left') };
  // the gaps away from the quotes still work; the four adjacent to one do not
  assert.deepEqual(gaps(q), [1, 4, 7]);
  for (const k of [2, 3, 5, 6]) assert.equal(canSplitBefore(q, k), false, `gap ${k} is beside a straight quote`);

  // a short quoted line can end up with no ✂ at all, which is correct rather than unfortunate:
  // every interior gap there is adjacent to an ambiguous mark
  assert.deepEqual(gaps({ words: tokenize('foo "bar" baz') }), []);

  // ⚠ and an apostrophe is not punctuation at all in this engine — it writes a glottal stop and is a
  // WORD character, so "foo's" is one token and splits around it behave normally
  const ap = { words: tokenize("foo's bar") };
  assert.deepEqual(ap.words.map((w) => w.txt), ["foo's", 'bar']);
  assert.deepEqual(gaps(ap), [1]);
});

/* ⚠⚠ THE SAME LINES, AS A TIMED TEXT ACTUALLY HOLDS THEM. Every test above hands canSplitBefore a
 * hand-built { words }, and all of them passed through v676–v684 while the Gloss tab showed no ✂
 * between any word/gloss pair (Seth: "Now scissors don't appear between interlinear word/gloss pairs
 * at all!"), because the decoration was asking about line i's AUDIO SPAN. A timed text keeps two
 * parallel lists, the phrases (which carry the words) and doc.segments (which carry only the time),
 * and only one of them can answer this question. */
test('in a timed text the words are on the phrase, and the time span has none to split between', async () => {
  const { makeDoc, reconcileBaseline } = await import('../docs/js/flextext.js');
  const doc = makeDoc({ vernLang: 'fau', analLang: 'id' });
  reconcileBaseline(doc, ['Kaisou fedahu, tudu bisa.', 'foo (bar) baz'], { flatSegments: true });
  doc.segments = [{ start: 0, end: 3000 }, { start: 3000, end: 6000 }];
  const phraseOf = (i) => doc.paragraphs[i] && doc.paragraphs[i].segments[0];
  assert.deepEqual(gaps(phraseOf(0)), [1, 3, 4], 'line 1, asked about its phrase');
  assert.deepEqual(gaps(phraseOf(1)), [1, 4], 'line 2, likewise');
  for (const [i, span] of doc.segments.entries()) {
    const n = phraseOf(i).words.length;
    assert.deepEqual([...Array(n).keys()].filter((k) => canSplitBefore(span, k)), [],
      `line ${i + 1}'s time span refuses every gap, which is why asking it hid every ✂`);
  }
});
