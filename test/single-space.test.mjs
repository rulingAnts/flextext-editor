/* "One space between words" — Seth, 2026-09-10: "prevent them from typing multiple spaces in the
 * baseline or free translation. Only allow one space between words… both on input and on blur (on
 * blur, remove duplicated spaces if this behavior is enabled, which it should be by default)."
 * Then: "enabled by default on paired devices, but disabled by default on unpaired devices." And:
 * "for legacy baseline, multiple line breaks is OK (at least two), but not multiple spaces…
 * limit line breaks to max 2 in a row."
 *
 * The audience is the reason it exists — "to help less tech-savvy/illiterate users" — so the rule
 * must be invisible when it works and must never eat something meaningful.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collapseSpaces, tidySpaces, capBlankLines } from '../docs/js/typing.js';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), STRIPS = rd('../docs/js/segment-strips.js');
const PANEL = rd('../docs/js/researcher-panel.js'), I18N = rd('../docs/js/i18n.js');
const bare = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('runs of spaces collapse, and the caret does not jump to the end', () => {
  assert.equal(collapseSpaces('a  b').value, 'a b');
  assert.equal(collapseSpaces('a   b').value, 'a b');
  assert.equal(collapseSpaces('a\t\tb').value, 'a b', 'tabs are runs too');
  // ⚠ the caret is the whole reason this returns an object: rewriting .value throws the cursor to
  // the end, which mid-sentence is worse than the extra space was.
  assert.equal(collapseSpaces('a  b', 3).caret, 2, 'lands just after the surviving space');
  assert.equal(collapseSpaces('a  ', 3).caret, 2, 'a trailing run leaves the caret at the end');
  // and an unchanged value must not move the caret or trigger a write
  const same = collapseSpaces('a b', 2);
  assert.equal(same.changed, false);
  assert.equal(same.caret, 2);
  assert.equal(collapseSpaces(null, 0).value, '', 'null-safe');
});

test('⚠ NEWLINES SURVIVE — the legacy baseline carries paragraphs as newlines', () => {
  // A \s-based regex here would merge a transcription's paragraphs into one line.
  assert.equal(collapseSpaces('a  b\n\nc  d').value, 'a b\n\nc d');
  assert.equal(tidySpaces('a  b\n\nc   d'), 'a b\n\nc d');
  // the LINE COUNT is preserved exactly, which an aligned doc depends on
  assert.equal(tidySpaces('a\n\n\nb').split('\n').length, 4);
  assert.equal(tidySpaces('\n\n').split('\n').length, 3);
});

test('on the way out the edges are tidied too, per line', () => {
  // a leading space is not "between words", so the same rule applies at the edges
  assert.equal(tidySpaces('  a  b  '), 'a b');
  assert.equal(tidySpaces('  a  \n  b  '), 'a\nb', 'per line, not just the whole value');
  // a whitespace-only line becomes blank — which applyBaseline already did when reconciling,
  // so this only makes what the typist SEES match what was always going to be stored
  assert.equal(tidySpaces('a\n   \nb'), 'a\n\nb');
});

test('blank runs cap at one blank line between text lines', () => {
  assert.equal(capBlankLines('a\n\n\n\nb'), 'a\n\nb');
  assert.equal(capBlankLines('a\n\n\n\n\n\n\nb'), 'a\n\nb');
  assert.equal(capBlankLines('a\n\nb'), 'a\n\nb', 'two newlines — one blank line — is what Seth asked to keep');
  assert.equal(capBlankLines('a\nb'), 'a\nb');
});

/* ⚠⚠ THE ONE THAT MATTERS MOST. On a doc carrying recording times every blank baseline line is a
 * timed span of SILENCE, 1:1 with doc.segments. Capping them there is data loss, and it is a
 * corruption already suffered once (2026-08-16): 53 lines with 23 blanks became 30, the spans then
 * paired positionally against the first 30 — silences included — and the recording "ended" half a
 * minute early. Reproduced from Seth's own field file before it was fixed. */
test('the blank-line cap is gated on DOC TRUTH, never on the setting', () => {
  const blur = APP.slice(APP.indexOf("$('#baseline-text').addEventListener('blur'"),
    APP.indexOf("$('#baseline-text').addEventListener('blur'") + 900);
  assert.match(bare(blur), /if \(!docCarriesTime\(current && current\.doc\)\) v = capBlankLines\(v, 2\);/,
    'an aligned doc never has its blank lines capped');
  // and there is ONE definition of aligned, shared with applyBaseline's own blank-line rule —
  // two notions drifting apart is how the corruption comes back
  assert.match(APP, /function docCarriesTime\(doc\) \{/);
  assert.match(APP, /const aligned = docCarriesTime\(current\.doc\);/, 'applyBaseline uses the same one');
  assert.equal((APP.match(/begin-time-offset'\] != null/g) || []).length, 1,
    'only one place still knows how alignment is detected');
});

test('it applies to the full-line boxes and NOT to word glosses', () => {
  // baseline rows in segmentation mode, through the deps seam the strips already use for policy
  const seg = STRIPS.slice(STRIPS.indexOf("input.addEventListener('input'"), STRIPS.indexOf("input.addEventListener('keydown'"));
  assert.match(seg, /deps\.singleSpace && deps\.singleSpace\(\)/, '.seg-text collapses on input');
  assert.match(STRIPS, /const tidy = tidySpaces\(input\.value\);/, 'and tidies on blur');
  assert.match(APP, /singleSpace: \(\) => singleSpaceEnabled\(\),/, 'passed as a predicate, read fresh each time');

  // the free translation, both on input and on blur
  const free = APP.slice(APP.indexOf("  input.addEventListener('input', () => {"), APP.indexOf("input.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });"));
  assert.match(free, /if \(singleSpaceEnabled\(\)\) \{/, '.free-input collapses on input');
  assert.match(free, /input\.addEventListener\('blur'/, 'and tidies on blur');

  // ⚠ a word gloss has its OWN rule — a space becomes a PERIOD there (1SG.SUBJ) — and must not
  // also be space-collapsed. Seth drew this line himself: "One should apply to individual word
  // glosses only and the other should apply to free translation and baseline full-line fields".
  const gloss = APP.slice(APP.indexOf("    g.addEventListener('input', () => {"), APP.indexOf("    g.addEventListener('input', () => {") + 1200);
  assert.doesNotMatch(bare(gloss), /collapseSpaces|singleSpaceEnabled/, 'the gloss box keeps space-to-period only');
});

/* ⚠ ONE KEY, TWO OPPOSITE DEFAULTS, and the surfaces must not disagree with the engine. A form
 * showing `on` where the engine treats unset as off misreports the device and then SAVES that
 * value on the first push — which is exactly how the typing dials shipped wrong in v663. */
test('default is ON for a paired device and OFF for an unpaired one', () => {
  assert.match(APP, /function singleSpaceEnabled\(\) \{[\s\S]{0,240}return Sync\.hasSession\(\);/,
    'unset resolves by pairing at runtime');
  assert.match(APP, /if \(settings\.singleSpace === true\) return true;/, 'an explicit value always wins');
  assert.match(APP, /if \(settings\.singleSpace === false\) return false;/);
  // the unpaired device's own Settings tab shows off when unset
  assert.match(APP, /else if \(f\.k === 'singleSpace'\) v\.singleSpace = s\.singleSpace === true;/);
  // the panel configures a PAIRED device, so it shows on when unset
  assert.match(PANEL, /else if \(f\.k === 'singleSpace'\) v\.singleSpace = s\.singleSpace !== false;/);
  // and it is a field on both surfaces
  for (const [src, name] of [[APP, 'app.js'], [PANEL, 'researcher-panel.js']])
    assert.match(src, /\{ k: 'singleSpace', type: 'checkbox', note: 'panel\.f\.singleSpaceNote' \},/, name);
});

/* The panel could push the typing settings but never read back what a device actually HAD — they
 * were missing from the snapshot, so its form fell through to defaults and could show a researcher
 * a value the device did not hold. */
test('every typing setting is in the snapshot the panel prefills from', () => {
  const snap = APP.slice(APP.indexOf('const snap = {};'), APP.indexOf('if (settings[k] !== undefined) snap[k] = settings[k];'));
  for (const k of ['analSpellcheck', 'analAutocomplete', 'analAutocorrect', 'singleSpace'])
    assert.match(snap, new RegExp(`'${k}'`), k);
});

test('the setting is explained in both languages', () => {
  for (const k of ['panel.f.singleSpace', 'panel.f.singleSpaceNote'])
    assert.equal((I18N.match(new RegExp(`'${k}':`, 'g')) || []).length, 2, `${k} in en and id`);
  // the note has to say the two things a researcher would otherwise get wrong
  const note = I18N.slice(I18N.indexOf("'panel.f.singleSpaceNote':"), I18N.indexOf("'panel.f.singleSpaceNote':") + 900);
  assert.match(note, /never to word glosses/, 'that glosses are excluded');
  assert.match(note, /timed silence/, 'and that an aligned text is never touched');
});
