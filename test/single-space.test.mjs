/* "One space between words", and the punctuation rules that grew out of it.
 *
 * Seth, 2026-09-10, in order:
 *   "prevent them from typing multiple spaces in the baseline or free translation. Only allow one
 *    space between words… both on input and on blur"
 *   "enabled by default on paired devices, but disabled by default on unpaired devices"
 *   "for legacy baseline, multiple line breaks is OK (at least two), but not multiple spaces…
 *    limit line breaks to max 2 in a row"
 *   "Periods, commas, etc, should also not double anywhere if this behavior is enabled"
 *   "Two dashes allowed, three periods OK, but not two. Two commas definitely not OK. And in
 *    glosses only one period at a time allowed, no doubles, no tripples."
 *   "give the researcher a setting to decide WHICH word-break character to use between words in
 *    gloss fields (just don't allow space). Default to period, but underscore and hyphen are also
 *    options."
 *   "Word gloss fields can't end with punctuation."
 *   "If I type space three times in the free translation it puts a period before the last word."
 *
 * The audience is why it exists — "to help less tech-savvy/illiterate users" — so every rule has to
 * be invisible when it works and must never eat something meaningful.
 *
 * ⚠ These go through tidyField, the one entry point the app actually calls, rather than the
 * primitives behind it. The primitives are internal on purpose (Seth: "There might be a way to
 * simplify and combine some of these rules"), and testing the real path is what catches a rule
 * wired into the wrong cell of the table.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tidyField, capBlankLines, undoKeyboardPeriod, GLOSS_BREAKS, glossBreakChar } from '../docs/js/typing.js';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), STRIPS = rd('../docs/js/segment-strips.js');
const PANEL = rd('../docs/js/researcher-panel.js'), I18N = rd('../docs/js/i18n.js');
const TYPING = rd('../docs/js/typing.js');
/* ⚠ STRIP COMMENTS BEFORE ANY doesNotMatch — these tests read source as text, so a comment SAYING
 * "why not X" satisfies a search for X and the assertion fails on its own documentation. */
const bare = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/* The THREE kinds of field, at the two moments. vern and free are separate rows on purpose: they
 * are the same kind of box and NOT the same kind of content — the baseline is vernacular, and
 * vernacular is never corrected. Seth, scoping the tighten rule: "In the free translation, I mean." */
const vern = (v, moment = 'input', prev = null) => tidyField(v, { kind: 'vern', moment, prev }).value;
const free = (v, moment = 'input', prev = null) => tidyField(v, { kind: 'free', moment, prev }).value;
const gloss = (v, moment = 'input', sep = '.') => tidyField(v, { kind: 'gloss', moment, sep }).value;

test('runs of spaces collapse, and the caret does not jump to the end', () => {
  assert.equal(free('a  b'), 'a b');
  assert.equal(free('a   b'), 'a b');
  assert.equal(free('a\t\tb'), 'a b', 'tabs are runs too');
  // the caret is why tidyField returns an object: rewriting .value throws the cursor to the end,
  // which mid-sentence is worse than the extra space was
  assert.equal(tidyField('a  b', { kind: 'free', moment: 'input' }, 3).caret, 2);
  assert.equal(tidyField('a  ', { kind: 'free', moment: 'input' }, 3).caret, 2);
  const same = tidyField('a b', { kind: 'free', moment: 'input' }, 2);
  assert.equal(same.changed, false, 'an unchanged value must not trigger a write');
  assert.equal(same.caret, 2);
  assert.equal(tidyField(null, { kind: 'free' }, 0).value, '', 'null-safe');
});

test('⚠ NEWLINES SURVIVE — the legacy baseline carries paragraphs as newlines', () => {
  // a \s-based regex would merge a transcription's paragraphs into one line
  assert.equal(vern('a  b\n\nc  d'), 'a b\n\nc d');
  assert.equal(vern('a  b\n\nc   d', 'blur'), 'a b\n\nc d');
  // the LINE COUNT is preserved exactly, which an aligned doc depends on
  assert.equal(vern('a\n\n\nb', 'blur').split('\n').length, 4);
  assert.equal(vern('\n\n', 'blur').split('\n').length, 3);
});

test('on the way out the edges are tidied too, per line', () => {
  assert.equal(free('  a  b  ', 'blur'), 'a b', 'a leading space is not "between words" either');
  assert.equal(vern('  a  \n  b  ', 'blur'), 'a\nb', 'per line, not just the whole value');
  // a whitespace-only line becomes blank — applyBaseline already did that when reconciling, so this
  // only makes what the typist SEES match what was always going to be stored
  assert.equal(vern('a\n   \nb', 'blur'), 'a\n\nb');
});

test('blank runs cap at one blank line between text lines', () => {
  assert.equal(capBlankLines('a\n\n\n\nb'), 'a\n\nb');
  assert.equal(capBlankLines('a\n\n\n\n\n\n\nb'), 'a\n\nb');
  assert.equal(capBlankLines('a\n\nb'), 'a\n\nb', 'two newlines — one blank line — is what Seth asked to keep');
  assert.equal(capBlankLines('a\nb'), 'a\nb');
});

/* ⚠⚠ THE ONE THAT MATTERS MOST. On a doc carrying recording times every blank baseline line is a
 * timed span of SILENCE, 1:1 with doc.segments. Capping them there is data loss, and a corruption
 * already suffered once (2026-08-16): 53 lines with 23 blanks became 30, the spans then paired
 * positionally against the first 30 — silences included — and the recording "ended" half a minute
 * early. Reproduced from Seth's own field file before it was fixed. */
test('the blank-line cap is gated on DOC TRUTH, never on the setting', () => {
  const blur = APP.slice(APP.indexOf("$('#baseline-text').addEventListener('blur'"),
    APP.indexOf("$('#baseline-text').addEventListener('blur'") + 1100);
  assert.match(bare(blur), /if \(!docCarriesTime\(current && current\.doc\)\) v = capBlankLines\(v, 2\);/,
    'an aligned doc never has its blank lines capped');
  // ONE definition of aligned, shared with applyBaseline's own blank-line rule — two notions
  // drifting apart is how the corruption comes back
  assert.match(APP, /function docCarriesTime\(doc\) \{/);
  assert.match(APP, /const aligned = docCarriesTime\(current\.doc\);/, 'applyBaseline uses the same one');
  assert.equal((APP.match(/begin-time-offset'\] != null/g) || []).length, 1,
    'only one place still knows how alignment is detected');
  // and it is deliberately NOT a cell in the rule table, so nobody can wire it in by picking one
  assert.doesNotMatch(bare(TYPING).slice(bare(TYPING).indexOf('const TIDY = {'), bare(TYPING).indexOf('export const GLOSS_BREAKS')),
    /capBlankLines/, 'the table cannot reach it');
});

test('punctuation: two dashes allowed, three periods OK, two not, two commas never', () => {
  assert.equal(free('ka--i', 'blur'), 'ka--i', 'two dashes allowed');
  assert.equal(free('a... b', 'blur'), 'a... b', 'three periods OK');
  assert.equal(free('a.. b', 'blur'), 'a. b', 'but not two');
  assert.equal(free('a,, b', 'blur'), 'a, b', 'two commas never');
  assert.equal(gloss('PST..PERF', 'blur'), 'PST.PERF');
  assert.equal(gloss('PST...PERF', 'blur'), 'PST.PERF', 'no triples in a gloss either');
  for (const ch of [',', ';', ':', '!', '?'])
    assert.equal(free(`a${ch}${ch} b`, 'blur'), `a${ch} b`, ch);

  /* ⚠⚠ AN ELLIPSIS MUST STAY TYPEABLE. A 2-to-1 rule firing on every keystroke eats the second
   * period, so the third makes two again, eaten again — the typist never gets past one dot. Hence
   * periods are left alone while typing in a full-line box and settled on blur. */
  let v = 'Yes';
  for (let i = 0; i < 3; i++) v = free(v + '.');
  assert.equal(v, 'Yes...', 'three keystrokes actually produce three periods');
  assert.equal(free(v, 'blur'), 'Yes...', 'and blur keeps them');
  assert.equal(free(free('Yes..'), 'blur'), 'Yes.', 'while a real double is still fixed');
  assert.equal(free('a,, b'), 'a, b', 'commas need no such wait — they collapse immediately');

  /* ⚠⚠⚠ AND NOT THE CHARACTERS AN ORTHOGRAPHY IS BUILT FROM. flextext.js counts the apostrophe
   * family, ʔ, and - _ = as WORD characters: glottal stops and morpheme/clitic boundaries. A
   * doubled one may be exactly what a language wants, and we do not know every orthography. */
  for (const [v2, why] of [["fa''u", 'apostrophe'], ['faʔʔu', 'glottal stop'], ['ka--i', 'hyphen'],
                           ['be==na', 'equals'], ['a__b', 'underscore']])
    assert.equal(free(v2, 'blur'), v2, `${why} untouched`);
});

/* "Word gloss fields can't end with punctuation." */
test('a gloss does not end in punctuation', () => {
  assert.equal(gloss('PST.', 'blur'), 'PST');
  assert.equal(gloss('PST..', 'blur'), 'PST', 'collapse runs FIRST, then strip — the other order leaves one behind');
  assert.equal(gloss('PST.SUBJ.', 'blur'), 'PST.SUBJ', 'only the end, never a separator doing its job');
  for (const ch of [',', ';', ':', '!', '?']) assert.equal(gloss('PST' + ch, 'blur'), 'PST', ch);
  assert.equal(gloss('PST_', 'blur', '_'), 'PST', 'a trailing underscore goes too');
  assert.equal(gloss('.', 'blur'), '', 'a box holding only a separator clears');
  assert.equal(gloss('1SG.SUBJ', 'blur'), '1SG.SUBJ', 'and nothing happens when there is nothing to do');

  /* ⚠⚠ LEIPZIG CONVENTIONS ARE NOT PUNCTUATION. Affixes and clitics are marked POSITIONALLY with a
   * hyphen and an equals sign: "PST-" is a prefix gloss, "-PST" a suffix, "CLT=" a proclitic,
   * "=CLT" an enclitic. A trailing hyphen is the morpheme's category, not a slip, and stripping it
   * would delete real analysis one invisible character at a time. */
  assert.equal(gloss('PST-', 'blur', '-'), 'PST-', 'a prefix gloss keeps its hyphen — even when - IS the separator');
  assert.equal(gloss('-PST', 'blur', '-'), '-PST', 'and a suffix gloss keeps its leading one');
  assert.equal(gloss('CLT=', 'blur'), 'CLT=', 'proclitic');
  assert.equal(gloss('=CLT', 'blur'), '=CLT', 'enclitic');
  assert.equal(gloss("ka'", 'blur'), "ka'", 'glottal stop');
  assert.equal(gloss('kaʔ', 'blur'), 'kaʔ');

  // ⚠ AND BLUR ONLY, or a separator is untypeable: the moment a space became "PST." the period
  // would be stripped as trailing, so "PST.SUBJ" could never be assembled.
  assert.equal(gloss('PST.'), 'PST.', 'input leaves the trailing separator alone');
  assert.equal(gloss('PST.' + 'SUBJ'), 'PST.SUBJ', 'so the second part can be typed');
  // a full-line box of course still ends in a period
  assert.equal(free('He went down.', 'blur'), 'He went down.');
  assert.equal(free('Really?', 'blur'), 'Really?');
});

/* ⚠⚠ THE KEYBOARD'S "DOUBLE SPACE MAKES A PERIOD", UNDONE. Seth: "If I type space three times in
 * the free translation it puts a period before the last word. That looks like a failure of order of
 * operations in your punctuation/space guards..." The order was fine — our rules alone insert
 * nothing. The period is Gboard's (and iOS's, and macOS's): pressing space when the field already
 * ends in a space replaces that space with ". ". Our space collapse then tidied away the leftover
 * gap, which made the stray period look deliberate. */
test('a period the keyboard inserted for a double space is put back as a space', () => {
  // the exact transition: prev ended in a space, and the new value is that text with the final
  // space replaced by ". "
  assert.equal(free('the man. ', 'input', 'the man '), 'the man ');
  assert.equal(free('the man.', 'input', 'the man '), 'the man ', 'some IMEs commit the "." first');

  // ⚠ A REAL TYPED PERIOD IS KEPT. Typing "." leaves the previous value ending in a letter, not a
  // space, so the signature cannot match — which is what makes the undo safe.
  assert.equal(free('the man. ', 'input', 'the man.'), 'the man. ');
  assert.equal(free('the man. went', 'input', 'the man. '), 'the man. went');
  // ⚠ and with no previous value it never guesses
  assert.equal(free('the man. ', 'input', null), 'the man. ');
  assert.equal(undoKeyboardPeriod('the man. ', undefined), 'the man. ');

  // end to end: three spaces then a word, with a keyboard doing the substitution on the second
  let v = free('the man ', 'input', 'the man');
  v = free('the man. ', 'input', v);          // keyboard fires
  v = free(v + ' ', 'input', v);              // third space
  v = free(v + 'went', 'input', v);
  assert.equal(v, 'the man went', 'no period before the last word');

  // ⚠ NEVER IN A GLOSS, where a period may BE the separator — restricted by kind, not left
  // unreachable by accident
  // ⚠ a space in a gloss is itself outside the approved set now, so it becomes the separator and
  // then dedupes — "PST. " is "PST.". The undo is still what is being tested: it did not fire.
  assert.equal(gloss('PST. ', 'input'), 'PST.', 'no period was reverted to a space');
  assert.match(TYPING, /kind !== 'gloss' && moment === 'input' \? undoKeyboardPeriod/,
    'excluded by kind, so it holds for vern and free and can never reach a gloss');
  // and it really does fire in the vernacular row as well as the prose one
  assert.equal(vern('the man. ', 'input', 'the man '), 'the man ');

  // the previous value is remembered per field, unconditionally and after the tidy
  for (const [src, name] of [[APP, 'app.js'], [STRIPS, 'segment-strips.js']])
    assert.match(src, /input\.__prevVal = input\.value;/, `${name} remembers it`);
  assert.match(APP, /prev: input\.__prevVal/, 'and feeds it back');
});

test('each box gets the rules its own content can take', () => {
  // baseline rows in segmentation mode, through the deps seam the strips already use for policy
  const seg = STRIPS.slice(STRIPS.indexOf("input.addEventListener('input'"), STRIPS.indexOf("input.addEventListener('keydown'"));
  assert.match(seg, /deps\.singleSpace && deps\.singleSpace\(\)/, '.seg-text tidies on input');
  assert.match(seg, /tidyField\(input\.value, \{ kind: 'vern', moment: 'input', prev: input\.__prevVal \}/,
    'a baseline strip is vernacular');
  assert.match(STRIPS, /tidyField\(input\.value, \{ kind: 'vern', moment: 'blur' \}\)\.value/, 'and on blur');
  assert.match(APP, /singleSpace: \(\) => singleSpaceEnabled\(\),/, 'passed as a predicate, read fresh each time');

  // the free translation, both moments; the legacy box, blur only (it has no keystroke handler)
  assert.match(APP, /tidyField\(input\.value, \{ kind: 'free', moment: 'input', prev: input\.__prevVal \}/,
    'the free translation is prose');
  assert.match(APP, /tidyField\(ta\.value, \{ kind: 'vern', moment: 'blur' \}\)\.value/, 'the legacy box is vernacular');

  /* ⚠ A GLOSS TAKES THE PERIOD RULES BUT NEVER THE SPACE RULE. Seth drew the line himself — "One
   * should apply to individual word glosses only and the other should apply to free translation and
   * baseline full-line fields" — so kind 'gloss' collapses no spaces (a space there has already
   * become the separator) and takes no ellipsis exemption. */
  assert.match(APP, /tidyField\(g\.value, \{ kind: 'gloss', moment: 'input', sep: glossBreak\(\) \}, g\.selectionStart\)/);
  assert.match(APP, /tidyField\(spaced, \{ kind: 'gloss', moment: 'blur', sep: glossBreak\(\) \}\)\.value/);
  /* ⚠ A gloss does not run the SPACE COLLAPSE — it does something stronger. app.js turns a space
   * into the separator before tidyField sees it, and the Leipzig allow-list converts any that get
   * through (from a paste or dictation) the same way. So "a  b" is "a.b", not "a b": two spaces are
   * one break, not two, which is the same intent by a different route. */
  assert.equal(gloss('a  b'), 'a.b', 'spaces become one separator, never a collapsed space');

  // ⚠ with the setting OFF a gloss is only space-to-separator — no tidying at all. Getting this
  // wrong meant periods collapsed with the setting disabled, under full-line rules at that.
  assert.match(APP, /const want = singleSpaceEnabled\(\) \? tidyField\(spaced, \{ kind: 'gloss', moment: 'blur', sep: glossBreak\(\) \}\)\.value : spaced;/,
    'the off path rewrites nothing beyond what it always did');
});

/* ⚠ ONE KEY, TWO OPPOSITE DEFAULTS, and neither surface may disagree with the engine. A form
 * showing `on` where the engine treats unset as off misreports the device and then SAVES that value
 * on the first push — which is exactly how the typing dials shipped wrong in v663. */
test('default is ON for a paired device and OFF for an unpaired one', () => {
  assert.match(APP, /function singleSpaceEnabled\(\) \{[\s\S]{0,240}return Sync\.hasSession\(\);/,
    'unset resolves by pairing at runtime');
  assert.match(APP, /if \(settings\.singleSpace === true\) return true;/, 'an explicit value always wins');
  assert.match(APP, /if \(settings\.singleSpace === false\) return false;/);
  assert.match(APP, /else if \(f\.k === 'singleSpace'\) v\.singleSpace = s\.singleSpace === true;/,
    "the unpaired device's own Settings tab shows off when unset");
  assert.match(PANEL, /else if \(f\.k === 'singleSpace'\) v\.singleSpace = s\.singleSpace !== false;/,
    'the panel configures a PAIRED device, so it shows on');
  for (const [src, name] of [[APP, 'app.js'], [PANEL, 'researcher-panel.js']])
    assert.match(src, /\{ k: 'singleSpace', type: 'checkbox', note: 'panel\.f\.singleSpaceNote' \},/, name);
});

test('the gloss word-break character is a setting, and a space is never one of the options', () => {
  assert.deepEqual(GLOSS_BREAKS, { period: '.', underscore: '_', hyphen: '-' });
  assert.equal(glossBreakChar('underscore'), '_');
  assert.equal(glossBreakChar('hyphen'), '-');
  assert.equal(glossBreakChar(undefined), '.', 'default is the period');
  assert.equal(glossBreakChar('space'), '.', 'and an unknown value falls back, never to a space');
  for (const v of Object.values(GLOSS_BREAKS)) assert.notEqual(v, ' ');

  for (const [src, name] of [[APP, 'app.js'], [PANEL, 'researcher-panel.js']]) {
    assert.match(src, /\{ k: 'glossBreak', type: 'select', opts: \['period', 'underscore', 'hyphen'\]/, name);
    assert.match(src, /v\.glossBreak = GLOSS_BREAKS\[s\.glossBreak\] \? s\.glossBreak : 'period';/, `${name} default`);
  }
  for (const k of ['panel.f.glossBreak', 'panel.f.glossBreakNote', 'panel.opt.glossBreak.period',
                   'panel.opt.glossBreak.underscore', 'panel.opt.glossBreak.hyphen'])
    assert.equal((I18N.match(new RegExp(`'${k}':`, 'g')) || []).length, 2, `${k} in en and id`);
});

/* ⚠⚠ A HYPHEN OR UNDERSCORE IS ONLY EVER COLLAPSED WHEN THE RESEARCHER DECLARED IT THE SEPARATOR.
 * Both are WORD characters in flextext.js — a hyphen marks an affix boundary in a morpheme gloss
 * (go-PST) and may be doubled legitimately. What makes collapsing safe is the declaration, not the
 * character. */
test('only the chosen separator collapses; the other word characters are left alone', () => {
  assert.equal(gloss('PST..PERF', 'blur', '.'), 'PST.PERF');
  assert.equal(gloss('PST__PERF', 'blur', '_'), 'PST_PERF');
  assert.equal(gloss('PST--PERF', 'blur', '-'), 'PST-PERF');
  assert.equal(gloss('go--PST', 'blur', '_'), 'go--PST', 'a hyphen that is not the separator survives');
  // ⚠ an underscore is NOT spared: unlike - and =, it marks no Leipzig convention, so a doubled one
  // is an accident. This assertion used to claim otherwise and was simply over-conservative.
  assert.equal(gloss('go__PST', 'blur', '.'), 'go_PST', 'a doubled underscore reduces');
  assert.equal(free('ka--i be__na', 'blur'), 'ka--i be__na', 'a full-line box never collapses either');
  assert.equal(gloss('PST..PERF', 'blur', '_'), 'PST.PERF',
    'periods still collapse in a gloss even when the separator is something else');
});

test('every typing setting is in the snapshot the panel prefills from', () => {
  const snap = APP.slice(APP.indexOf('const snap = {};'), APP.indexOf('if (settings[k] !== undefined) snap[k] = settings[k];'));
  for (const k of ['analSpellcheck', 'analAutocomplete', 'analAutocorrect', 'singleSpace', 'glossBreak'])
    assert.match(snap, new RegExp(`'${k}'`), k);
});

test('the setting is explained in both languages', () => {
  for (const k of ['panel.f.singleSpace', 'panel.f.singleSpaceNote'])
    assert.equal((I18N.match(new RegExp(`'${k}':`, 'g')) || []).length, 2, `${k} in en and id`);
  // ⚠ slice to the NEXT KEY, not a fixed character count — the note grows as rules are added, and a
  // magic window silently stops covering the end of it
  const noteStart = I18N.indexOf("'panel.f.singleSpaceNote':");
  const note = I18N.slice(noteStart, I18N.indexOf("\n  '", noteStart));
  assert.ok(note.length > 400 && note.length < 4000, 'the slice really is just this one note');
  assert.match(note, /never to word glosses/, 'that glosses are excluded from the space rule');
  assert.match(note, /timed silence/, 'and that an aligned text is never touched');
});

/* ⚠⚠ THIS RULE MUST NEVER DEPEND ON A KEY EVENT. Seth: "Remember our issue with soft keyboard vs
 * physical keyboard with event triggers we use for this..." An Android soft keyboard commits
 * through the IME: keydown arrives as keyCode 229 with no usable `key`, or not at all. Watching the
 * VALUE on `input` catches every route in — typing, the suggestion strip, dictation, paste,
 * autofill — and `blur` is the pass no IME can be mid-flight against. */
test('the rule fires on the VALUE, never on a key press', () => {
  for (const [src, name] of [[APP, 'app.js'], [STRIPS, 'segment-strips.js']]) {
    const kd = bare(src).split(/addEventListener\('keydown'/).slice(1).map((c) => c.slice(0, 1200));
    assert.ok(kd.length > 0, `${name}: there are keydown handlers to check`);
    for (const chunk of kd)
      assert.doesNotMatch(chunk, /tidyField|singleSpaceEnabled\(\)/,
        `${name}: a keydown handler must not carry this rule`);
  }
  // and it IS wired to input/blur — asserted positively so the check above cannot pass vacuously
  assert.match(APP, /addEventListener\('input'[\s\S]{0,600}?tidyField/);
  assert.match(APP, /addEventListener\('blur'[\s\S]{0,600}?tidyField/);
});

/* Seth: "There might be a way to simplify and combine some of these rules..." */
test('the rules live in one table, keyed by field kind and moment', () => {
  assert.match(TYPING, /const TIDY = \{[\s\S]{0,900}?vern: \{/, 'one table');
  assert.match(TYPING, /gloss: \{/);
  for (const m of ['input', 'blur']) assert.match(TYPING, new RegExp(`${m}: \\[`), `${m} column`);
  // one entry point, and the callers use only it
  assert.match(TYPING, /export function tidyField\(/);
  for (const [src, name] of [[APP, 'app.js'], [STRIPS, 'segment-strips.js']]) {
    assert.doesNotMatch(bare(src), /tidyOnInput|tidyOnBlur|collapseSpaces|collapseRepeatedPunct|stripTrailingPunct/,
      `${name} goes through tidyField, not the primitives`);
  }
  // an unknown kind falls back to line rules rather than doing nothing at all
  assert.equal(tidyField('a  b', { kind: 'nonsense', moment: 'input' }).value, 'a b',
    'an unknown kind falls back to vern — the row that rewrites the LEAST');
  assert.equal(tidyField('a  b', { kind: 'free', moment: 'nonsense' }).value, 'a  b', 'an unknown moment is a no-op');
});

/* ⚠ A GLOSS ADMITS ONLY LEIPZIG-APPROVED PUNCTUATION. Seth, 2026-09-10, with a screenshot of a
 * gloss reading "mau,.bilang" — "Oops. you didn't prevent this… two different punctuation marks in
 * a row" — and then the general rule: "when , and . go together . (or word-breaking character the
 * researcher put) should win. I think in glosses, we only want leipzig-approved punctuation allowed
 * in gloss boxes."
 *
 * Which is a better rule than "no two in a row": a comma has no job in a gloss at all, so the
 * question is not what to do when it sits beside a separator but what it is doing there. Anything
 * outside the approved set BECOMES the separator — not deleted, since "mau,bilang" wanted a break
 * and deleting would fuse it into "maubilang". The reported pair then falls out for free. */
test('a gloss admits only Leipzig-approved punctuation; anything else becomes the separator', () => {
  assert.equal(gloss('mau,.bilang', 'blur'), 'mau.bilang', "Seth's screenshot");
  assert.equal(gloss('mau,.bilang', 'input'), 'mau.bilang', 'and immediately, not only on blur');
  assert.equal(gloss('mau.,bilang', 'blur'), 'mau.bilang', 'either order — the separator is what survives');
  // a LONE disallowed mark becomes the separator too: the typist wanted a break
  for (const ch of [',', ';', '!', '?', '"', '(', '/'])
    assert.equal(gloss(`mau${ch}bilang`, 'blur'), 'mau.bilang', ch);
  assert.equal(gloss('mau,bilang', 'blur', '_'), 'mau_bilang', 'whichever separator is configured');
  assert.equal(gloss('mau,.', 'blur'), 'mau', 'reduced first, then the trailing strip sees it');

  /* ⚠⚠ A PAIR OF TWO APPROVED CHARACTERS IS NEVER REDUCED — two marks doing two jobs, not a slip.
   * Each of these comes from a numbered Leipzig rule. */
  assert.equal(gloss('PST-.SUBJ', 'blur'), 'PST-.SUBJ', 'Rule 2 hyphen against a Rule 4A period');
  assert.equal(gloss('PST-SUBJ', 'blur'), 'PST-SUBJ', 'Rule 2 affix boundary');
  assert.equal(gloss('CLT=', 'blur'), 'CLT=', 'Rule 2 clitic boundary, trailing');
  assert.equal(gloss('go:PST', 'blur'), 'go:PST', 'Rule 4B non-segmentable boundary');
  assert.equal(gloss('PL\\hand', 'blur'), 'PL\\hand', 'Rule 4C morphophonological change');
  assert.equal(gloss('1>3', 'blur'), '1>3', 'Rule 4D person hierarchy');
  assert.equal(gloss('go~go', 'blur'), 'go~go', 'Rule 10 reduplication');
  assert.equal(gloss('[PL]', 'blur'), '[PL]', 'covert category');
  assert.equal(gloss('N+N', 'blur'), 'N+N', 'compound');
  // letters, digits, marks, and the glottal-stop family are always fine
  for (const v of ["ka'i", 'kaʔ', 'mémé', '1SG.SUBJ', '3PL'])
    assert.equal(gloss(v, 'blur'), v, v);

  // runs of the SAME character still reduce...
  assert.equal(gloss('PST..PERF', 'blur'), 'PST.PERF');
  assert.equal(gloss('a::b', 'blur'), 'a:b');
  assert.equal(gloss('a__b', 'blur'), 'a_b');
  // ...but not a hyphen, unless the researcher declared it the separator
  assert.equal(gloss('go--PST', 'blur'), 'go--PST', 'a doubled hyphen may be what a convention wants');
  assert.equal(gloss('go--PST', 'blur', '-'), 'go-PST', 'once declared, two in a row is an accident');

  /* ⚠⚠⚠ AND NONE OF IT IN A FULL-LINE BOX, where the text is ordinary prose in the analysis
   * language. "etc.," is a period against a comma and is CORRECT English; "?!" is deliberate.
   * Commas there are not accidents, and tidying them would be correcting the writer. */
  assert.equal(free('apples, oranges, etc., and pears', 'blur'), 'apples, oranges, etc., and pears');
  assert.equal(free('What?!', 'blur'), 'What?!');
  assert.equal(free('Yes...', 'blur'), 'Yes...', 'and the ellipsis still survives');
  assert.equal(free('a,, b', 'blur'), 'a, b', 'while a same-character slip is still fixed');
  // the allow-list is genuinely gloss-only in the source, not just in these cases
  assert.match(TYPING, /const glossPunct = kind === 'gloss' \? \[glossAllowedOnly\(sep\), glossRuns\(sep\)\] : \[\];/);
});

test('the approved set is written down with the rule each character comes from', () => {
  // ⚠ so nobody widens or narrows it by guess — this is Seth's field, and the note names Rules 2,
  // 4A, 4B, 4C, 4D, 9 and 10 beside the characters they license.
  const note = TYPING.slice(TYPING.indexOf('A GLOSS ADMITS ONLY LEIPZIG-APPROVED'), TYPING.indexOf('const GLOSS_ALLOWED'));
  for (const r of ['Rule 2', 'Rule 4A', 'Rule 4B', 'Rule 4C', 'Rule 4D', 'Rule 9', 'Rule 10'])
    assert.match(note, new RegExp(r), r);
  assert.match(note, /glottal stop/i, 'and why the apostrophe family is exempt');
});

/* "We also don't want a space between a word and a period or comma" (Seth, 2026-09-10). */
test('a full-line box keeps punctuation tight against the word', () => {
  assert.equal(free('the man .', 'blur'), 'the man.');
  assert.equal(free('the man ,', 'blur'), 'the man,');
  for (const ch of ['.', ',', ';', ':', '!', '?'])
    assert.equal(free(`word ${ch} next`, 'blur'), `word${ch} next`, ch);
  assert.equal(free('the man  .', 'blur'), 'the man.', 'however many spaces');
  assert.equal(free('the man\t.', 'blur'), 'the man.', 'tabs too');
  assert.equal(free('the man .', 'input'), 'the man.', 'while typing, not only on blur');
  assert.equal(free('Yes ...', 'blur'), 'Yes...', 'and an ellipsis closes up but stays an ellipsis');

  // ⚠ the space AFTER the punctuation is untouched — that one belongs there
  assert.equal(free('one. two', 'blur'), 'one. two');
  assert.equal(free('a, b, c', 'blur'), 'a, b, c');
  // ⚠ and nothing here touches the Leipzig characters, which are not prose punctuation
  assert.equal(free('ka -i', 'blur'), 'ka -i');
  assert.equal(free('be =na', 'blur'), 'be =na');

  /* ⚠ FRENCH IS THE KNOWN EXCEPTION, recorded at the rule rather than discovered later: French
   * sets a thin space before ; : ! ?. Not a concern for English or Indonesian, but the rule names
   * its characters so it can be made conditional if an analysis language ever needs it. */
  assert.match(TYPING, /FRENCH IS THE KNOWN EXCEPTION/);
  assert.match(TYPING, /const tightenPunct = /);

  // ⚠ and the keyboard-period undo still wins, because it runs BEFORE this
  assert.equal(free('the man. ', 'input', 'the man '), 'the man ');
});

/* ⚠⚠ THE BASELINE IS VERNACULAR AND IS NOT TYPOGRAPHICALLY CORRECTED. Seth scoped the tighten rule
 * himself — "In the free translation, I mean." — and it matches the standing rule this whole area
 * exists for: autocorrect never touches vernacular. "word ." may be how an orthography sets
 * punctuation, and we do not know every orthography. */
test('the baseline gets space and doubling rules but never typographic correction', () => {
  // NOT tightened
  assert.equal(vern('kaisou fedahu .', 'blur'), 'kaisou fedahu .');
  assert.equal(vern('kaisou , tudu', 'blur'), 'kaisou , tudu');
  assert.equal(vern('kaisou fedahu .', 'input'), 'kaisou fedahu .');
  // but everything Seth asked for "anywhere" still applies there
  assert.equal(vern('kaisou    fedahu', 'blur'), 'kaisou fedahu', 'one space between words');
  assert.equal(vern('kaisou,, fedahu', 'blur'), 'kaisou, fedahu', 'no doubled comma');
  assert.equal(vern('kaisou.. fedahu', 'blur'), 'kaisou. fedahu', 'no doubled period');
  assert.equal(vern('kaisou... fedahu', 'blur'), 'kaisou... fedahu', 'and the ellipsis survives');
  assert.equal(vern('the man. ', 'input', 'the man '), 'the man ', "and the keyboard's period is undone");

  // the rows are genuinely distinct in the table, and the reason is recorded there
  const tbl = TYPING.slice(TYPING.indexOf('const TIDY = {'), TYPING.indexOf('export const GLOSS_BREAKS'));
  const vernCell = bare(tbl.slice(tbl.indexOf('vern: {'), tbl.indexOf('free: {')));
  assert.doesNotMatch(vernCell, /tightenPunct/, 'the vernacular row has no tighten step');
  assert.match(bare(tbl.slice(tbl.indexOf('free: {'), tbl.indexOf('gloss: {'))), /tightenPunct/, 'the free row does');
  assert.match(TYPING, /THE BASELINE IS VERNACULAR, AND VERNACULAR IS NOT CORRECTED/);

  // and the callers are wired to the right rows
  assert.match(STRIPS, /kind: 'vern'/, 'the baseline strips are vernacular');
  assert.match(APP, /tidyField\(ta\.value, \{ kind: 'vern', moment: 'blur' \}\)/, 'and so is the legacy box');
  assert.match(APP, /kind: 'free'/, 'the free translation is prose');
  assert.doesNotMatch(bare(STRIPS), /kind: 'free'/, 'no baseline box is treated as prose');
});
