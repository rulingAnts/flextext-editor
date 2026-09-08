/* CUT MODE LOCKS THE TEXT THAT IS NOT PART OF THE CUT (Seth, 2026-09-08).
 *
 * "When cut mode is active on a line, editing of text fields shouldn't be (except the free
 * translation or baseline, because the user needs to place the cursor to mark the split position)."
 *
 * Arming fills the line with scissors deliberately, and on a small touch screen a stray tap landing
 * in a gloss box at that moment is a silent data change — the same class of accident arming exists
 * to prevent. The exemptions are not arbitrary: the Baseline text box and the free translation are
 * exempt because their CARET is how their tier is placed (`text` and `free` in splitTiers). A field
 * that places nothing has no reason to accept typing mid-cut. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const STRIPS = readFileSync(new URL('../docs/js/segment-strips.js', import.meta.url), 'utf8');
const fn = STRIPS.slice(STRIPS.indexOf('function lockFieldsForCut'), STRIPS.indexOf('export function armLine'));

test('every text box on the line goes read-only', () => {
  assert.match(fn, /row\.querySelectorAll\('\.gloss-input, \.free-input, \.seg-text'\)\) el\.readOnly = on;/,
    'glosses, the free translation and the Baseline box alike');
  assert.match(fn, /row\.querySelectorAll\('\.word-txt'\)/,
    'and word-level baseline editing, which has no readOnly of its own');
});

/* ⚠ readOnly, NOT disabled — the distinction is the whole design (Seth: "we don't need free to
 * ACCEPT typing, we just need it to accept positioning a cursor… if we can have the one
 * (positioning) without the other (actually typing), that's better"). A read-only input still
 * focuses, still places a caret and still reports selectionStart, which is all the `text` and
 * `free` tiers ever read from it. A disabled one does none of that and would break both. */
test('the boxes are made read-only, never disabled', () => {
  assert.doesNotMatch(fn, /\.disabled\s*=/, 'disabling would kill the caret the tiers depend on');
  assert.doesNotMatch(fn, /pointer-events|tabIndex\s*=/, 'nor is the box put out of reach some other way');
});

test('arming locks, and disarming — including disarming another line — unlocks', () => {
  const arm = STRIPS.slice(STRIPS.indexOf('export function armLine'), STRIPS.indexOf('export function armedRow'));
  assert.match(arm, /el\.classList\.remove\('cut-armed'\); lockFieldsForCut\(el, false\);/,
    'the line being disarmed by arming another gets its fields back');
  assert.match(arm, /row\.classList\.toggle\('cut-armed', want\);\s*\n\s*lockFieldsForCut\(row, want\);/,
    'and the toggled line follows its own state, so disarming unlocks too');
});

/* ⚠ The restore must put back what was THERE. .word-txt is 'plaintext-only' where the browser
 * accepts it and 'true' where it does not, so a hardcoded restore would silently change paste
 * behaviour on whichever browser got the other value. */
test('contentEditable is stashed and restored, not assumed', () => {
  assert.match(fn, /el\.dataset\.cutWas = el\.contentEditable;/, 'stashed on the way in');
  assert.match(fn, /el\.contentEditable = el\.dataset\.cutWas;/, 'and put back on the way out');
  assert.doesNotMatch(fn, /contentEditable = 'plaintext-only'/, 'never restored from a hardcoded value');
});

test('a field holding focus as the line arms gives it up — except the tier boxes', () => {
  assert.match(fn, /if \(el === document\.activeElement\) el\.blur\(\);/,
    'the word being edited commits through its own blur handler before it locks');
  assert.match(fn, /classList\.contains\('gloss-input'\) && row\.contains\(a\)\) a\.blur\(\)/,
    'a focused gloss box gives up a caret it can no longer use');
  assert.doesNotMatch(fn, /contains\('free-input'\)[^\n]*blur|contains\('seg-text'\)[^\n]*blur/,
    '⚠ but the tier boxes KEEP focus — that caret is the reason they stay reachable');
});
