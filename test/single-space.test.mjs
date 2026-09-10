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
import { collapseSpaces, tidySpaces, capBlankLines, tidyOnInput, tidyOnBlur, collapseRepeatedPunct, GLOSS_BREAKS, glossBreakChar } from '../docs/js/typing.js';

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

test('each box gets the rules its own content can take', () => {
  // baseline rows in segmentation mode, through the deps seam the strips already use for policy
  const seg = STRIPS.slice(STRIPS.indexOf("input.addEventListener('input'"), STRIPS.indexOf("input.addEventListener('keydown'"));
  assert.match(seg, /deps\.singleSpace && deps\.singleSpace\(\)/, '.seg-text tidies on input');
  assert.match(seg, /tidyOnInput\(input\.value, input\.selectionStart\)/);
  assert.match(STRIPS, /const tidy = tidyOnBlur\(input\.value\);/, 'and on blur');
  assert.match(APP, /singleSpace: \(\) => singleSpaceEnabled\(\),/, 'passed as a predicate, read fresh each time');

  // the free translation, both moments
  assert.match(APP, /const r = tidyOnInput\(input\.value, input\.selectionStart\);/, '.free-input on input');
  assert.match(APP, /const tidy = tidyOnBlur\(input\.value\);/, 'and on blur');

  // the legacy box, blur only — it has no per-keystroke handler at all
  assert.match(APP, /let v = tidyOnBlur\(ta\.value\);/);

  /* ⚠ A GLOSS TAKES THE PERIOD RULE BUT NEVER THE SPACE RULE. Seth drew the line himself — "One
   * should apply to individual word glosses only and the other should apply to free translation and
   * baseline full-line fields" — and then asked for periods too: "in glosses only one period at a
   * time allowed, no doubles, no tripples." So the gloss passes { gloss: true }, which skips the
   * space collapse entirely (a space there has already become a period) and takes no ellipsis
   * exemption (a period separates parts of one label). */
  assert.match(APP, /tidyOnInput\(g\.value, g\.selectionStart, \{ gloss: true, sep: glossBreak\(\) \}\)/, 'gloss on input');
  assert.match(APP, /tidyOnBlur\(spaced, \{ gloss: true, sep: glossBreak\(\) \}\)/, 'gloss on blur');

  // ⚠ AND WITH THE SETTING OFF, A GLOSS IS ONLY SPACE-TO-PERIOD — no tidying at all. Getting this
  // wrong meant periods collapsed with the setting disabled, under full-line rules at that.
  assert.match(APP, /const want = singleSpaceEnabled\(\) \? tidyOnBlur\(spaced, \{ gloss: true, sep: glossBreak\(\) \}\) : spaced;/,
    'the off path rewrites nothing beyond what it always did');
});

test('punctuation: two dashes allowed, three periods OK, two not, two commas never', () => {
  const line = (v) => tidyOnBlur(v);
  // ⚠ Seth's four rules, verbatim: "Two dashes allowed, three periods OK, but not two. Two commas
  // definitely not OK. And in glosses only one period at a time allowed, no doubles, no tripples."
  assert.equal(line('ka--i'), 'ka--i', 'two dashes allowed');
  assert.equal(line('a... b'), 'a... b', 'three periods OK');
  assert.equal(line('a.. b'), 'a. b', 'but not two');
  assert.equal(line('a,, b'), 'a, b', 'two commas never');
  assert.equal(tidyOnBlur('PST..PERF', { gloss: true }), 'PST.PERF');
  assert.equal(tidyOnBlur('PST...PERF', { gloss: true }), 'PST.PERF', 'no triples in a gloss either');

  /* ⚠⚠ AN ELLIPSIS MUST STAY TYPEABLE. A 2-to-1 rule firing on every keystroke eats the second
   * period, so the third makes two again, eaten again — the typist can never get past one dot.
   * Hence periods are left alone while typing in a full-line box and settled on blur. */
  let v = 'Yes';
  for (let i = 0; i < 3; i++) v = tidyOnInput(v + '.', null).value;
  assert.equal(v, 'Yes...', 'three keystrokes actually produce three periods');
  assert.equal(tidyOnBlur(v), 'Yes...', 'and blur keeps them');
  assert.equal(tidyOnBlur(tidyOnInput('Yes..', null).value), 'Yes.', 'while a real double is still fixed');
  // commas need no such wait — they are never legitimately repeated
  assert.equal(tidyOnInput('a,, b', null).value, 'a, b', 'so they collapse immediately');

  /* ⚠⚠⚠ AND NOT THE CHARACTERS AN ORTHOGRAPHY IS BUILT FROM. flextext.js counts the apostrophe
   * family, ʔ, and - _ = as WORD characters: glottal stops and morpheme/clitic boundaries. A
   * doubled one may be exactly what a language wants, and we do not know every orthography —
   * rewriting them would be the silent vernacular edit this whole area exists to refuse. */
  for (const [v2, why] of [["fa''u", 'apostrophe'], ['faʔʔu', 'glottal stop'], ['ka--i', 'hyphen'],
                           ['be==na', 'equals'], ['a__b', 'underscore']])
    assert.equal(line(v2), v2, `${why} untouched`);
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
  // ⚠ slice to the NEXT KEY, not a fixed character count — the note grows as rules are added, and a
  // magic window silently stops covering the end of it.
  const noteStart = I18N.indexOf("'panel.f.singleSpaceNote':");
  const note = I18N.slice(noteStart, I18N.indexOf("\n  '", noteStart));
  assert.ok(note.length > 400 && note.length < 4000, 'the slice really is just this one note');
  assert.match(note, /never to word glosses/, 'that glosses are excluded');
  assert.match(note, /timed silence/, 'and that an aligned text is never touched');
});

/* ⚠⚠ THIS RULE MUST NEVER DEPEND ON A KEY EVENT. Seth, 2026-09-10: "Remember our issue with soft
 * keyboard vs physical keyboard with event triggers we use for this..." — the lesson the gloss
 * space-to-period fix was rewritten for. An Android soft keyboard commits through the IME: keydown
 * arrives as keyCode 229 with no usable `key`, or does not arrive at all. Watching the VALUE on
 * `input` catches every route into the box — typing, the suggestion strip, dictation, paste,
 * autofill — and `blur` is the pass no IME can be mid-flight against.
 *
 * So: every place this feature fires is asserted to be an input or blur listener, and no keydown
 * handler is allowed to reach for it. */
test('the rule fires on the VALUE, never on a key press', () => {
  for (const [src, name] of [[APP, 'app.js'], [STRIPS, 'segment-strips.js']]) {
    // walk every listener block and check which ones mention the feature
    const re = /addEventListener\('(\w+)'[\s\S]{0,1400}?\n(?=\s{0,6}(?:input|g|ta|\$\('#baseline-text'\))?\.?addEventListener|\s{0,4}\}\);)/g;
    let m, seen = [];
    while ((m = re.exec(src)) !== null) {
      if (/tidyOnInput|tidyOnBlur/.test(m[0])) seen.push(m[1]);
    }
    assert.ok(seen.length > 0, `${name}: found the listeners`);
    for (const ev of seen)
      assert.ok(ev === 'input' || ev === 'blur', `${name}: fires on '${ev}' — must be input or blur only`);
  }
  // and belt-and-braces: no keydown handler anywhere calls into it
  for (const [src, name] of [[APP, 'app.js'], [STRIPS, 'segment-strips.js']]) {
    const kd = bare(src).split(/addEventListener\('keydown'/).slice(1)
      .map((chunk) => chunk.slice(0, 1200));
    for (const chunk of kd)
      assert.doesNotMatch(chunk, /tidyOnInput|tidyOnBlur|singleSpaceEnabled\(\)/,
        `${name}: a keydown handler must not carry this rule`);
  }
});

/* The gloss word-break character (v671). Seth: "give the researcher a setting to decide WHICH
 * word-break character to use between words in gloss fields (just don't allow space). Default to
 * period, but underscore and hyphen are also options." */
test('the gloss word-break character is a setting, and a space is never one of the options', () => {
  assert.deepEqual(GLOSS_BREAKS, { period: '.', underscore: '_', hyphen: '-' });
  assert.equal(glossBreakChar('underscore'), '_');
  assert.equal(glossBreakChar('hyphen'), '-');
  assert.equal(glossBreakChar('period'), '.');
  assert.equal(glossBreakChar(undefined), '.', 'default is the period');
  assert.equal(glossBreakChar('space'), '.', 'and an unknown value falls back, never to a space');
  for (const v of Object.values(GLOSS_BREAKS)) assert.notEqual(v, ' ');

  // the field exists on both surfaces, with the same default (this one does NOT depend on pairing)
  for (const [src, name] of [[APP, 'app.js'], [PANEL, 'researcher-panel.js']]) {
    assert.match(src, /\{ k: 'glossBreak', type: 'select', opts: \['period', 'underscore', 'hyphen'\]/, name);
    assert.match(src, /v\.glossBreak = GLOSS_BREAKS\[s\.glossBreak\] \? s\.glossBreak : 'period';/, `${name} default`);
  }
  // and the panel can read back what a device actually has
  const snap = APP.slice(APP.indexOf('const snap = {};'), APP.indexOf('if (settings[k] !== undefined) snap[k] = settings[k];'));
  assert.match(snap, /'glossBreak'/);
  // labelled in both languages, options included
  for (const k of ['panel.f.glossBreak', 'panel.f.glossBreakNote', 'panel.opt.glossBreak.period',
                   'panel.opt.glossBreak.underscore', 'panel.opt.glossBreak.hyphen'])
    assert.equal((I18N.match(new RegExp(`'${k}':`, 'g')) || []).length, 2, `${k} in en and id`);
});

/* ⚠⚠ AND A HYPHEN OR UNDERSCORE IS ONLY EVER COLLAPSED WHEN THE RESEARCHER DECLARED IT THE
 * SEPARATOR. Both are WORD characters in flextext.js — a hyphen marks an affix boundary in a
 * morpheme gloss (go-PST) and may be doubled legitimately. What makes collapsing safe is the
 * declaration, not the character. */
test('only the chosen separator collapses; the other word characters are left alone', () => {
  const gl = (v, sep) => tidyOnBlur(v, { gloss: true, sep });
  assert.equal(gl('PST..PERF', '.'), 'PST.PERF');
  assert.equal(gl('PST__PERF', '_'), 'PST_PERF');
  assert.equal(gl('PST--PERF', '-'), 'PST-PERF');
  // not chosen -> untouched
  assert.equal(gl('go--PST', '_'), 'go--PST', 'a hyphen that is not the separator survives');
  assert.equal(gl('go__PST', '.'), 'go__PST', 'and so does an underscore');
  // ⚠ a full-line box never collapses either of them, whatever the gloss separator is
  assert.equal(tidyOnBlur('ka--i be__na'), 'ka--i be__na');
  // periods still collapse in a gloss even when the separator is something else — a gloss label
  // has no ellipsis, so a doubled period there is an accident either way
  assert.equal(gl('PST..PERF', '_'), 'PST.PERF');
});
