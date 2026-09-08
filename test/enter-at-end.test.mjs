/* Seth, 2026-09-08: "on the baseline tab, enter/return at the end of a line not break a line, but
 * rather the scissors break a line. What should happen instead is if the user presses enter at the
 * end of the line it just advances to the next line. I think maybe something similar on the gloss
 * tab." Then: "we can have that be a researcher configured behavior", and "Let's make this new
 * behavior default though for new devices and projects (not existing ones). Especially for mobile
 * devices/android."
 *
 * Finishing a line and pressing Enter is the most natural gesture there is, and it was starting a
 * split at the very end of the text — a break that yields an empty line, which is almost never what
 * the typist meant. Splitting stays where it is deliberate: mid-text, and the ✂ on the waveform.
 *
 * ⚠ The grandfathering is the point of most of these assertions. An existing device must not change
 * behaviour under a coworker mid-project.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), STRIPS = rd('../docs/js/segment-strips.js');
const PANEL = rd('../docs/js/researcher-panel.js'), I18N = rd('../docs/js/i18n.js');

test('absent means the OLD behaviour, so an existing device is untouched', () => {
  assert.match(APP, /function enterAtEndAdvances\(s\) \{\s*\n\s*s = s \|\| settings;\s*\n\s*return s\.enterAtEnd === 'advance';\s*\n\}/,
    'only an explicit "advance" advances — absent, unset or anything else keeps splitting');
});

test('a device that has never saved settings is seeded with the new behaviour, once', () => {
  const seed = APP.slice(APP.indexOf('function seedNewDeviceDefaults()'), APP.indexOf('let settings = loadSettings();'));
  assert.match(seed, /if \(localStorage\.getItem\(SETTINGS_KEY\) !== null\) return;/,
    'the test for "new device" is that NOTHING has ever been stored');
  assert.match(seed, /JSON\.stringify\(\{ enterAtEnd: 'advance' \}\)/);
  assert.match(seed, /catch \{/, 'private mode must not throw at boot');
});

test('Baseline: at the end it advances, and it does so even when splitting is switched off', () => {
  const fn = STRIPS.slice(STRIPS.indexOf('function onKey(e, i, input)'), STRIPS.indexOf("} else if (e.key === 'Backspace'"));
  const advanceAt = fn.indexOf('deps.enterAdvances');
  const gateAt = fn.indexOf('if (!joinSplitOk()) return;');
  assert.ok(advanceAt > -1 && gateAt > -1, 'both branches present');
  assert.ok(advanceAt < gateAt,
    'the advance is decided BEFORE the split gate — a researcher who turned splitting off still wants Enter to walk');
  assert.match(fn, /const atEnd = caret === \(input\.selectionEnd \?\? 0\) && !input\.value\.slice\(caret\)\.trim\(\);/,
    'end means a collapsed caret with nothing but whitespace after it — a trailing space must not start a split');
  assert.doesNotMatch(fn, /=== input\.value\.length/, 'the strict end-of-string test is gone: it failed on one trailing space');
  assert.match(fn, /focusStripAfter\(i\);/);
  // mid-text Enter is untouched: it still places the text tier of the split
  assert.match(fn, /stripsPlace\(i, 'text', input\.selectionStart \?\? input\.value\.length\);/);
});

test('the walk stops at the last line rather than blurring', () => {
  const fn = STRIPS.slice(STRIPS.indexOf('function focusStripAfter(i)'), STRIPS.indexOf('function onKey(e, i, input)'));
  assert.match(fn, /if \(!next\) return;/, 'nothing to focus on the last line');
  assert.doesNotMatch(fn, /\.blur\(\)/, 'a keyboard that closes itself at the end reads as the app quitting');
  assert.match(fn, /setSelectionRange\(next\.value\.length, next\.value\.length\)/, 'caret lands at the end, ready to type');
});

test('Gloss uses the same whitespace-tolerant end', () => {
  assert.match(APP, /const atEnd = fi\.selectionStart === fi\.selectionEnd && !fi\.value\.slice\(fi\.selectionStart \?\? 0\)\.trim\(\);/);
});

test('Gloss: the same rule, and it takes precedence over trimming an edge line', () => {
  const i = APP.indexOf("} else if (e.key === 'Enter' && atEnd && enterAtEndAdvances()) {");
  const j = APP.indexOf("} else if (e.key === 'Enter' && atEnd && joinSplitAllowed('gloss')) {");
  assert.ok(i > -1 && j > -1, 'both branches present');
  assert.ok(i < j, 'the advance branch is first, so it wins when the setting is on');
  assert.match(APP.slice(i, j), /const next = all\[all\.indexOf\(fi\) \+ 1\];/, 'it walks to the next translation');
  // the start-of-line trim is deliberately untouched
  assert.match(APP, /e\.key === 'Enter' && atStart && joinSplitAllowed\('gloss'\)/);
});

test('the researcher can set it, and a NEW project defaults to advance', () => {
  assert.match(PANEL, /\{ k: 'enterAtEnd', type: 'select', opts: \['advance', 'split'\], optPrefix: 'panel\.opt\.enterAtEnd\.', note: 'panel\.f\.enterAtEndNote' \}/);
  assert.match(PANEL, /\(Object\.keys\(s\)\.length \? 'split' : 'advance'\)/,
    'an existing project keeps split; a project with no settings at all is new and gets advance');
  for (const k of ['panel.f.enterAtEnd', 'panel.f.enterAtEndNote', 'panel.opt.enterAtEnd.advance', 'panel.opt.enterAtEnd.split'])
    assert.equal((I18N.match(new RegExp(`\\n {2,4},?'${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
});

test('the strips are given the setting the same way the other gates are', () => {
  assert.match(APP, /enterAdvances: \(\) => enterAtEndAdvances\(\),/);
  assert.match(STRIPS, /deps\.enterAdvances && deps\.enterAdvances\(\)/,
    'guarded, so an older host that never passes it behaves exactly as before');
});

/* ⚠ ORDER IS THE WHOLE FIX (Seth, 2026-09-08). A BLANK translation box satisfies `atStart` and
 * `atEnd` at the same time — caret at 0, nothing after it. While the atStart branch came first it
 * swallowed every Enter on an empty translation and started an edge split, which on an unarmed line
 * showed as "orange border and cancel button show, but not scissors buttons" and could not be
 * finished. With "move to next" on, the walk must be reached first. A box with text after the caret
 * is not atEnd, so a deliberate split-before-this-line still lands. */
test('on the Gloss tab "move to next" is tested before the edge split', () => {
  const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
  const handler = APP.slice(APP.indexOf("fi.addEventListener('keydown'"));
  const advance = handler.indexOf("e.key === 'Enter' && atEnd && enterAtEndAdvances()");
  const edgeBefore = handler.indexOf("e.key === 'Enter' && atStart && joinSplitAllowed('gloss')");
  assert.ok(advance > -1, 'the advance branch exists');
  assert.ok(edgeBefore > -1, 'the edge-split branch exists');
  assert.ok(advance < edgeBefore,
    'the walk must be reached before the atStart edge split, or a blank box can never advance');
});
