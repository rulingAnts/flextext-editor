/* THE GLOSS TAB'S 🔗 JOIN ROW HONOURS THE JOIN/SPLIT SWITCH (#100, Seth 2026-10-07: "if cutting is
 * disabled on gloss tab, but join buttons still show up").
 *
 * There is ONE switch for the tab — `joinSplitGloss`, read through joinSplitAllowed('gloss') — and
 * every join/split control on it read that switch except the 🔗 row between two line groups, which
 * decorateGlossSegments created unconditionally. So with the switch off the ✂ went and the chain
 * links stayed: a control that looked live and joined two lines on a tab where the researcher had
 * said no joining. The suite's standing rule is that no control looks live and does nothing (or,
 * worse, does something it was switched off from doing); this pins the three halves of the fix as
 * source, in the style of the rest of the cut-tab suite.
 *
 * Run: node --test test/gloss-join-gate.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const fn = (src, name) => {
  const m = src.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  return m ? m[0] : '';
};

test('the join row is created only where joining is allowed, like the ✂ in the gutter', () => {
  const dec = fn(APP, 'decorateGlossSegments');
  assert.ok(dec, 'decorateGlossSegments exists');
  assert.match(dec, /if \(joinSplitAllowed\('gloss'\)\) \{\s*\n\s*const arm = document\.createElement\('button'\);/, 'the gutter ✂ is gated (the existing half)');
  assert.match(dec, /const joinAllowed = joinSplitAllowed\('gloss'\);/, 'the same gate is read for the join row…');
  assert.match(dec, /if \(joinAllowed && i < groups\.length - 1 && [^\n]*\) \{\s*\n\s*const joinRow = document\.createElement\('div'\);/,
               '…and the row is built only when it says yes');
  // The row's creation must sit AFTER the gate is read, and nothing else may build a gseg-joinrow.
  assert.equal((dec.match(/className = 'gseg-joinrow'/g) || []).length, 1, 'exactly one place mints a join row');
  assert.ok(dec.indexOf('const joinAllowed') < dec.indexOf("className = 'gseg-joinrow'"), 'gate before build');
});

test('a row left over from before the switch flipped is removed, not merely not re-created', () => {
  const dec = fn(APP, 'decorateGlossSegments');
  assert.match(dec, /if \(!joinAllowed && g\.nextElementSibling && g\.nextElementSibling\.classList\.contains\('gseg-joinrow'\)\) g\.nextElementSibling\.remove\(\);/);
});

test('glossJoinLines refuses as a backstop, whatever control asked', () => {
  const join = fn(APP, 'glossJoinLines');
  assert.match(join, /^\nfunction glossJoinLines\(i\) \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(!current \|\| !joinSplitAllowed\('gloss'\)\) return;\n\s*captureUndo\(\);/,
               'the gate is the first statement, ahead of captureUndo — a refused join leaves no undo step');
});

test('a pushed flip of the switch re-enters the visible tab so its controls are rebuilt', () => {
  const live = fn(APP, 'applyLiveSettings');
  assert.match(live, /const joinBefore = \{ baseline: joinSplitAllowed\('baseline'\), gloss: joinSplitAllowed\('gloss'\) \};\n\s*settings = loadSettings\(\);/,
               'the gates are read BEFORE the settings reload');
  assert.match(live, /const joinFlipped = \(v === 'baseline' \|\| v === 'gloss'\) && joinSplitAllowed\(v\) !== joinBefore\[v\];/);
  assert.match(live, /\(\(settings\.segmentation === true\) !== segBefore \|\| joinFlipped\)\) \{\s*\n\s*switchTab\(v\);/,
               'the existing live re-enter fires on a join/split flip too — and still only when something actually changed');
});
