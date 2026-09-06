// The Paragraph Analysis Tool's share of the one splitting rule (Seth, 2026-09-06; plans/split-tiers.md):
// a split by tiers, and a join that absorbs any blank audio line between two text lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitLineTiers, joinLines, validateFxpa } from '../docs/js/paragraph-model.js';
import { splitTiers } from '../docs/js/segments.js';

const UI = readFileSync(new URL('../docs/js/paragraph-ui.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../docs/css/app.css', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');

const doc = () => ({
  format: 'flextext-paragraph-analysis', version: 1, title: 'T', vernLang: 'fau', analLang: 'en',
  lines: [
    { id: 'L1', baseline: 'satu dua tiga', words: [{ txt: 'satu', gls: 'one' }, { txt: 'dua', gls: 'two' }, { txt: 'tiga', gls: 'three' }], free: 'one two three', start: 0, end: 3000, speaker: 'A' },
    { id: 'L2', baseline: '', words: [], start: 3000, end: 4000 },                       // silence
    { id: 'L3', baseline: 'empat', words: [{ txt: 'empat', gls: 'four' }], free: 'four', start: 4000, end: 5000 },
  ],
  tree: [{ id: 'G1', children: ['L1', 'L3'] }],
  view: { layer: 'interlinear', free: true, audio: true, waves: 'compact', collapsed: [] },
});

test('the tool\'s tiers: words (or text), translation, audio', () => {
  assert.deepEqual(splitTiers({ tab: 'interlinear', aligned: true, words: 3, text: 'satu dua tiga', free: 'x' }), ['audio', 'words', 'free']);
  assert.deepEqual(splitTiers({ tab: 'interlinear', aligned: false, words: 0, text: 'a proposition', free: '' }), ['text'], 'an authored line');
});

test('a split by tiers: words and glosses ride, the translation divides at its caret, the sound at the playhead', () => {
  const d = splitLineTiers(doc(), 'L1', { words: 2, free: 8, audio: 2100 });
  const [a, b] = d.lines;
  assert.deepEqual(a.words.map((w) => w.txt + '/' + w.gls), ['satu/one', 'dua/two']);
  assert.deepEqual(b.words.map((w) => w.txt + '/' + w.gls), ['tiga/three']);
  assert.equal(a.baseline, 'satu dua'); assert.equal(b.baseline, 'tiga');
  assert.equal(a.free, 'one two'); assert.equal(b.free, 'three');
  assert.deepEqual([a.start, a.end, b.start, b.end], [0, 2100, 2100, 3000]);
  assert.equal(b.speaker, 'A', 'the speaker rides both pieces');
  assert.deepEqual(d.tree[0].children, ['L1', d._added, 'L3'], 'the new line joins its sibling\'s group, right after it');
  assert.equal(validateFxpa(JSON.parse(JSON.stringify(d))).ok, true, 'still a valid document');
});

test('an authored line splits at the caret, text only', () => {
  const d = { ...doc(), authored: true, lines: [{ id: 'L1', baseline: 'one thing and another', words: [] }], tree: [] };
  const r = splitLineTiers(d, 'L1', { text: 9 });
  assert.deepEqual(r.lines.map((l) => l.baseline), ['one thing', 'and another']);
});

test('an EDGE split (Seth, 2026-09-07): the silence at either end becomes a line of its own, the translation whole with the words', () => {
  const d = splitLineTiers(doc(), 'L1', { words: 0, free: 0, audio: 400 });
  const [a, b] = d.lines;
  assert.deepEqual(a.words, []); assert.equal(a.baseline, ''); assert.equal(a.free, undefined);
  assert.deepEqual([a.start, a.end], [0, 400], 'the trimmed silence, timed');
  assert.deepEqual(b.words.map((w) => w.txt), ['satu', 'dua', 'tiga']); assert.equal(b.free, 'one two three');
  assert.equal(b.id, 'L1', 'the words keep the line\'s id (and its propositions); the silence is the new line');
  assert.equal(a.id, d._added);
  assert.deepEqual(d.tree[0].children, [d._added, 'L1', 'L3'], 'the new empty line sits before it in the group');
  const dp = doc(); dp.lines[0].props = [{ id: 'L1p1', text: 'a claim' }];
  const sp = splitLineTiers(dp, 'L1', { words: 0, free: 0, audio: 400 });
  assert.equal(sp.lines[1].props.length, 1, 'propositions ride with the words'); assert.equal(sp.lines[0].props, undefined);
  const e = splitLineTiers(doc(), 'L1', { words: 3, free: 13, audio: 2700 });
  assert.equal(e.lines[0].free, 'one two three'); assert.deepEqual(e.lines[1].words, []); assert.deepEqual([e.lines[1].start, e.lines[1].end], [2700, 3000]);
  assert.match(UI, /cutBtn\(0, 'gloss\.edgeStartTip', ' pa-cut-edge'\)/, 'a ✂ before the first word of a timed line');
  assert.match(UI, /cutBtn\(n, 'gloss\.edgeEndTip', ' pa-cut-edge'\)/, 'and after the last');
  assert.match(UI, /if \(r === 'pending' && \(gap <= 0 \|\| gap >= n\)\) paPlace\(id, 'free', gap <= 0 \? 0 : String\(l\.free \|\| ''\)\.length\);/, 'the translation lands at the same edge');
});

test('a join takes the next text line AND every blank audio line between, so the sound is whole', () => {
  const d = joinLines(doc(), 'L1');
  assert.equal(d.lines.length, 1, 'L1, the silence and L3 became one line');
  const m = d.lines[0];
  assert.deepEqual(m.words.map((w) => w.txt), ['satu', 'dua', 'tiga', 'empat']);
  assert.equal(m.baseline, 'satu dua tiga empat');
  assert.equal(m.free, 'one two three four', 'translations join with a space');
  assert.deepEqual([m.start, m.end], [0, 5000], 'the union: the whole recording area, silence included');
  assert.equal(m.speaker, 'A');
  assert.deepEqual(d.tree, [], 'a group left with one child dissolves');
  assert.equal(validateFxpa(JSON.parse(JSON.stringify(d))).ok, true);
});

test('a join refuses when a later line has propositions, and the last line cannot join', () => {
  const d = doc(); d.lines[2].props = [{ id: 'L3p1', text: 'a claim' }];
  assert.throws(() => joinLines(d, 'L1'), /propositions/);
  assert.throws(() => joinLines(doc(), 'L3'), /last line/);
});

test('the tool wires the engine: ✂ between words, under the caret, under the playhead; 🔗 to join; cancel and undo', () => {
  assert.match(UI, /import \{ splitPlace, splitCancel, splitPending, installSplitCancel, registerCaretScissors, syncCaretScissors \} from '\.\/segment-strips\.js';/);
  assert.match(UI, /installSplitCancel\(\);\s*\/\/ Escape and a tap away cancel a pending split/);
  assert.match(UI, /function doUndo\(\) \{\s*\n\s*if \(splitCancel\(\)\) return;/, 'Undo cancels first');
  assert.match(UI, /\$\('#pa-undo'\)\.addEventListener\('click', \(\) => \{ if \(splitCancel\(\)\) return;/, 'the Undo button too, even with nothing else to undo');
  assert.match(UI, /\(i \? cutBtn\(i, 'para\.cutTip', ''\) : ''\)/, 'a ✂ between two words');
  assert.match(UI, /paPlaceWords\(id, \+b\.dataset\.gap\);/);
  assert.match(UI, /registerCaretScissors\(input, holder, \(\) => document\.activeElement === input && \(input\.selectionStart \?\? 0\) < input\.value\.trimEnd\(\)\.length,/, 'the caret ✂ on an authored line');
  assert.match(UI, /registerCaretScissors\(input, holder, \(\) => document\.activeElement === input && !!input\.value\.trim\(\),/, 'the caret ✂ in the translation');
  assert.match(UI, /if \(inside\(\)\) \{ if \(input\.value !== original\) state = setLineFree\(state, lineId, input\.value\); paPlace\(lineId, 'free', input\.selectionStart\); return; \}/, 'mid-text Enter places the translation tier');
  assert.match(UI, /sc\.className = 'cut-scissors pa-rowcut';/, 'a ✂ under the row\'s playhead');
  assert.match(UI, /paPlace\(l\.id, 'audio', tNow\);/, 'Enter outside the boxes places the audio tier');
  assert.match(UI, /class="pa-join" data-line="\$\{esc\(id\)\}"/, 'a 🔗 on every line but the last');
  assert.match(UI, /joinBtn\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); paJoin\(id\); \}\);/);
  assert.match(UI, /if \(p && p\.tab === 'paragraph'\) paRenderPending\(p\);/, 'markers survive a re-render');
  assert.match(UI, /commit: \(pos\) => \{\s*\n\s*try \{\s*\n\s*const next = splitLineTiers\(state, id, pos\);/, 'one commit when every tier is placed');
  for (const k of ['para.cutTip', 'para.joinTip']) assert.equal((I18N.match(new RegExp(`\n  '${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  assert.equal((I18N.match(/\n    ,'panel\.rel\.new\.patSplit': '/g) || []).length, 2);
  assert.match(CSS, /\.pa-words \.pa-cut \{ align-self: center;/);
  assert.match(CSS, /\.pa-authored, \.pa-free \{ position: relative; \}/, 'the caret ✂ positions against the row');
});
