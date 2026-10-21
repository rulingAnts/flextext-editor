// A WORD GLOSS'S EDGES (Seth, 2026-10-21): "automatically trim leading or trailing periods left over
// after the user leaves a gloss cell … or whatever morpheme break character the researcher defined."
// typing.js glossSpaces / trimGlossEdges, and how app.js's gloss box uses them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { glossSpaces, trimGlossEdges } from '../docs/js/typing.js';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');

test('glossSpaces: spaces become the separator — except at the very start, where a space breaks nothing', () => {
  assert.deepEqual(glossSpaces('PST ', '.'), { value: 'PST.', caret: null, tail: 1 }, 'a trailing space: feedback while typing, counted as a possible leftover');
  assert.deepEqual(glossSpaces(' PST', '.', 1), { value: 'PST', caret: 0, tail: 0 }, 'a leading space is DROPPED, and the caret moves back with it');
  assert.deepEqual(glossSpaces('go out', '_', 3), { value: 'go_out', caret: 3, tail: 0 }, 'inner: the researcher\'s separator, one for one');
  assert.equal(glossSpaces('go out', '-').value, 'go-out');
  assert.equal(glossSpaces('a\tb', '.').value, 'a.b', 'a tab is a space here (typing.js untab)');
  assert.equal(glossSpaces('   ', '.').value, '', 'only spaces: nothing');
  assert.deepEqual(glossSpaces('PST', '.', 2), { value: 'PST', caret: 2, tail: 0 }, 'no space: untouched');
  assert.equal(glossSpaces('x  ', '.').tail, 2);
});

test('trimGlossEdges: a period or underscore at either edge goes, typed or left over', () => {
  for (const s of ['.', '_']) {
    assert.equal(trimGlossEdges(`PST${s}`, s), 'PST');
    assert.equal(trimGlossEdges(`${s}PST`, s), 'PST');
    assert.equal(trimGlossEdges(`${s}${s}1SG${s}SUBJ${s}${s}`, s), `1SG${s}SUBJ`, 'runs at the edges go; the inner one stays');
  }
  assert.equal(trimGlossEdges('PST.', '_'), 'PST.', 'only the RESEARCHER\'S separator — a period under the underscore setting is another character');
  assert.equal(trimGlossEdges('.', '.'), '');
});

test('⚠ trimGlossEdges: a TYPED hyphen stays — PST- and -PST are Leipzig affix glosses', () => {
  assert.equal(trimGlossEdges('PST-', '-'), 'PST-', 'a prefix gloss');
  assert.equal(trimGlossEdges('-PST', '-'), '-PST', 'a suffix gloss');
  // ...but the hyphen the app just made from a trailing space is a leftover, and goes
  assert.equal(trimGlossEdges('PST-', '-', { value: 'PST-', n: 1 }), 'PST');
  assert.equal(trimGlossEdges('PST-', '-', { value: 'PST--', n: 1 }), 'PST-', 'only while the box is unchanged since it was made');
  assert.equal(trimGlossEdges('PST-', '-', { value: 'PST-', n: 3 }), 'PST', 'never more than the run that is there');
  assert.equal(trimGlossEdges('A-B', '-', { value: 'A-B', n: 1 }), 'A-B', 'and never a character that is not the separator');
});

test('the gloss box: drop/convert on input, remember a trailing space\'s separator, trim on leaving — ungated', () => {
  const gi = APP.slice(APP.indexOf("    g.addEventListener('input', () => {"), APP.indexOf("    g.addEventListener('blur', () => {"));
  assert.match(gi, /const sp = glossSpaces\(g\.value, glossBreak\(\), g\.selectionStart\);/);
  assert.match(gi, /g\.__autoTail = sp\.tail \? \{ value: g\.value, n: Math\.min\(sp\.tail, runNow\) \}\s*\n\s*: \(g\.__autoTail && g\.__autoTail\.value === g\.value \? g\.__autoTail : null\);/,
    'a leftover is remembered with the value it belongs to; any change to the box forgets it');
  assert.ok(gi.indexOf('g.__autoTail =') > gi.indexOf("tidyField(g.value, { kind: 'gloss', moment: 'input'"), 'remembered AFTER the input tidy, so the count matches the box');
  const gb = APP.slice(APP.indexOf("    g.addEventListener('blur', () => {"), APP.indexOf("    g.addEventListener('keydown', (e) => {"));
  const iEdge = gb.indexOf('const edged = trimGlossEdges(sp.value, sep, { value: sp.value, n: sp.tail + prior });');
  assert.ok(iEdge > 0, 'blur trims the edges, counting both kinds of leftover');
  assert.ok(iEdge < gb.indexOf('const want = singleSpaceEnabled()'), '⚠ UNGATED: before the single-space setting is consulted');
  assert.match(gb, /const prior = g\.__autoTail && g\.__autoTail\.value === g\.value \? g\.__autoTail\.n : 0;\s*\n\s*g\.__autoTail = null;/);
  // the physical-keyboard Space types a SPACE, so it reaches the same path (and the researcher's separator)
  assert.match(APP, /g\.setRangeText\(' ', from, to, 'end'\);\s*\n\s*g\.dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\);/);
  assert.doesNotMatch(APP, /g\.setRangeText\('\.', from, to, 'end'\)/, 'never a hard-coded period again');
});
