/* #92 (Brian Plimley, 2026-10-02): "In the Baseline tab, even if splitting/joining is disabled, the
 * instructions still explain how to split/join. Ideally, also check whether there are any other
 * instructions that need to change with device settings."
 *
 * The rule this pins: no help text describes a control the device's settings have taken away, and
 * the help is re-worded in place when those settings change (a researcher push lands mid-session).
 * The Baseline hint is ASSEMBLED from per-capability keys, so there is no whole paragraph to fall
 * out of date; the Cut tab's texted-line refusal and the Gloss tab's empty note each pick a sentence
 * by the settings they depend on.
 *
 * Run: node --test test/baseline-help-follows-settings.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const STRIPS = readFileSync(new URL('../docs/js/segment-strips.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

// i18n.js reads localStorage/navigator defensively but setLang touches document.documentElement.
globalThis.document ??= { documentElement: {} };
const i18n = await import('../docs/js/i18n.js');

const enAt = I18N.indexOf('\nen: {'), idAt = I18N.indexOf('\nid: {');
const EN = I18N.slice(enAt, idAt), ID = I18N.slice(idAt);
const defines = (block, key) => new RegExp(`^  '${key.replace(/\./g, '\\.')}':`, 'm').test(block);

const GATED_KEYS = [
  'baseline.hintSegLead', 'baseline.hintSegEnterSplit', 'baseline.hintSegEnterMove', 'baseline.hintSegScissors',
  'cut.no.hasText', 'cut.no.hasTextBaseline',
  'split.no.glossed', 'split.no.glossedGloss',
  'gloss.empty', 'gloss.emptyNoBaseline',
];

test('every gated sentence is its own key, in both languages', () => {
  for (const k of GATED_KEYS) {
    assert.ok(defines(EN, k), `en defines ${k}`);
    assert.ok(defines(ID, k), `id defines ${k}`);
  }
  // The whole-paragraph twins are gone: a paragraph that says "Enter splits" cannot follow a setting.
  for (const k of ['baseline.hintSeg', 'baseline.hintSegMove']) {
    assert.ok(!defines(EN, k) && !defines(ID, k), `${k} is no longer a single paragraph`);
  }
});

/* The texts a device with every capability on reads today — byte for byte what the single paragraphs
 * said before #92, so the fix changes nothing for a device that was never restricted.
 * ⚠ This is a one-time transition pin, not a frozen contract: a DELIBERATE wording change to any of
 * the gated keys (baseline.hintSeg*, cut.no.hasText*, split.no.glossed*) must update TODAY too, in
 * both languages. */
const TODAY = {
  en: {
    split: 'Type the words for each line. <b>Enter</b> inside a box breaks the line at the cursor; <b>Enter</b> with no box selected breaks it at the playhead and keeps the words together — so you can listen and cut without typing.',
    move: 'Type the words for each line. <b>Enter</b> moves on to the next line. To cut a line in two, first tap the <b>✂</b> at its left edge — the scissors then show you every place you can cut. Tap it again to put them away.',
    hasText: 'This line already has words typed for it, so it cannot be cut here. Split it on the Baseline tab instead, where you can choose where the words divide.',
    glossed: 'This line already has glosses or a translation, so it cannot be split or joined here. Do that on the Gloss tab.',
  },
  id: {
    split: 'Ketik kata-kata untuk tiap baris. <b>Enter</b> di dalam kotak memotong baris di posisi kursor; <b>Enter</b> tanpa kotak yang dipilih memotongnya di posisi pemutar dan kata-katanya tetap utuh — jadi Anda bisa mendengarkan sambil memotong tanpa mengetik.',
    move: 'Ketik kata-kata untuk tiap baris. <b>Enter</b> berpindah ke baris berikutnya. Untuk memotong sebuah baris menjadi dua, ketuk dahulu <b>✂</b> di tepi kirinya — gunting lalu menunjukkan setiap tempat yang bisa dipotong. Ketuk lagi untuk menyembunyikannya.',
    hasText: 'Baris ini sudah ada kata-katanya, jadi tidak bisa dipotong di sini. Pisahkan di tab Ketik saja, di mana Anda bisa memilih di mana kata-katanya dibagi.',
    glossed: 'Baris ini sudah punya glos atau terjemahan, jadi tidak bisa dibagi atau digabung di sini. Lakukan itu di tab Terjemahan Balik.',
  },
};

/* t() falls back to the KEY NAME for a missing key, so a test built on missing keys would pass
 * vacuously ('baseline.hintSegLead' contains no ✂ either). Every read below goes through this
 * guard, so each test fails on its own if a key is missing or renamed. */
const real = (t) => (k) => { const v = t(k); assert.notEqual(v, k, `${k} is defined in the current language`); return v; };
// The same assembly rule as baselineHintHtml in app.js, run over the real dictionaries.
const assemble = (t, { advance, split }) => {
  const parts = [t('baseline.hintSegLead')];
  if (advance) { parts.push(t('baseline.hintSegEnterMove')); if (split) parts.push(t('baseline.hintSegScissors')); }
  else if (split) parts.push(t('baseline.hintSegEnterSplit'));
  return parts.join('').trim();
};

for (const lang of ['en', 'id']) {
  test(`${lang}: with every capability on, the assembled Baseline hint is word for word what it said before`, () => {
    i18n.setLang(lang, { save: false });
    const t = real(i18n.t);
    assert.equal(assemble(t, { advance: false, split: true }), TODAY[lang].split, 'a device still on `split`');
    assert.equal(assemble(t, { advance: true, split: true }), TODAY[lang].move, 'a device where Enter moves on');
    assert.equal(t('cut.no.hasText') + ' ' + t('cut.no.hasTextBaseline'), TODAY[lang].hasText, 'the Cut tab refusal, both sentences');
    assert.equal(t('split.no.glossed') + ' ' + t('split.no.glossedGloss'), TODAY[lang].glossed, 'the Baseline tab\'s glossed-line refusal, both sentences');
  });

  test(`${lang}: with splitting off, no sentence explains how to split`, () => {
    i18n.setLang(lang, { save: false });
    const t = real(i18n.t);
    const lead = t('baseline.hintSegLead').trim();
    assert.equal(assemble(t, { advance: false, split: false }), lead, 'on `split`, Enter does nothing with splitting off — so the hint says nothing about it');
    const moved = assemble(t, { advance: true, split: false });
    assert.equal(moved, (t('baseline.hintSegLead') + t('baseline.hintSegEnterMove')).trim(), 'Enter still walks on, and that is all');
    assert.ok(!moved.includes('✂') && !moved.includes(t('baseline.hintSegScissors')), 'no scissors');
    assert.ok(!t('cut.no.hasText').includes(t('cut.no.hasTextBaseline')), 'the refusal\'s first sentence does not already contain the second');
    assert.ok(!t('split.no.glossed').includes(t('split.no.glossedGloss')), 'nor does the glossed-line refusal\'s');
    assert.ok(!t('gloss.emptyNoBaseline').includes('<b>'), 'the no-Baseline note names no tab');
  });
}

test('the Baseline hint is assembled from the live settings, not picked by one key', () => {
  const fn = APP.slice(APP.indexOf('function baselineHintHtml(classic)'), APP.indexOf('function applyGlossEmptyHint()'));
  assert.match(fn, /function baselineHintHtml\(classic\) \{\s*\n\s*if \(classic\) return t\('baseline\.hint'\);/, 'classic mode keeps its one sentence');
  assert.match(fn, /const split = splitLinesAllowed\('baseline'\);/, 'consults the splitBaseline gate…');
  assert.match(fn, /if \(enterAtEndAdvances\(\)\) \{\s*\n\s*parts\.push\(t\('baseline\.hintSegEnterMove'\)\);\s*\n\s*if \(split\) parts\.push\(t\('baseline\.hintSegScissors'\)\);/, '…the scissors only when splitting is allowed');
  assert.match(fn, /\} else if \(split\) \{\s*\n\s*parts\.push\(t\('baseline\.hintSegEnterSplit'\)\);/, 'and the Enter-splits sentence only when it is true');
  assert.match(fn, /function applyBaselineHint\(\{ classic = !segmentationEnabled\(\) \} = \{\}\) \{\s*\n\s*const hint = \$\('#baseline-hint'\);/, 'repaints the span by id; classic defaults to the segmentation setting');
  assert.match(fn, /if \(classic\) hint\.dataset\.i18nHtml = 'baseline\.hint'; else delete hint\.dataset\.i18nHtml;/, 'and keeps applyI18n from overwriting the assembled text with a single key');
  assert.match(fn, /function baselineShowsTextarea\(\) \{\s*\n\s*const ta = \$\('#baseline-text'\);\s*\n\s*return !segmentationEnabled\(\) \|\| !!\(ta && !ta\.hidden\);/, 'DOM truth for the repaint paths — tolerant of the satellites that have no textarea');
  assert.match(HTML, /<span id="baseline-hint" data-i18n-html="baseline\.hint"><\/span>/, 'the span exists in the markup');
  assert.doesNotMatch(APP, /baseline\.hintSegMove|'baseline\.hintSeg'/, 'nothing still reaches for the retired paragraphs');
});

test('the help is re-worded when settings change without a reload, and when the language changes', () => {
  const live = APP.slice(APP.indexOf('function applyLiveSettings()'), APP.indexOf('function deleteAllAllowed()'));
  assert.match(live, /applyCutHint\(\);/, 'the Cut hint (already live before #92)');
  assert.match(live, /applyBaselineHint\(\{ classic: baselineShowsTextarea\(\) \}\);/, 'the Baseline hint follows a pushed joinSplitBaseline / enterAtEnd, over whichever editor is showing');
  assert.match(live, /applyGlossEmptyHint\(\);/, 'the Gloss empty note follows a pushed baselineTab');
  // A pushed changeSettings reaches applyLiveSettings — that is the path the panel's push lands on.
  const cmd = APP.slice(APP.indexOf("case 'changeSettings': {"), APP.indexOf("case 'changeSettings': {") + 3000);
  assert.match(cmd, /applyLiveSettings\(\);/, 'changeSettings → applyLiveSettings');
  // The local language toggle repaints static keys with applyI18n, which cannot repaint an assembled hint.
  assert.match(APP, /setLang\(langSel\.value\);\s*\n\s*applyI18n\(\);\s*\n\s*applyBaselineHint\(\{ classic: baselineShowsTextarea\(\) \}\);/, 'the language toggle re-assembles the Baseline hint after applyI18n');
});

test('strip mode with no recording falls back to the textarea — and to the classic hint with it', () => {
  // The Baseline entry paints the strip hint first (it decides from the settings alone); the no-audio
  // branch then reveals the textarea, where Enter inserts a paragraph break and there is no ✂.
  const entry = APP.slice(APP.indexOf("if (tab === 'baseline') {"), APP.indexOf("await ensurePeaks(stripsFor"));
  assert.match(entry, /stopGlossCursor\(\);\s*\n\s*applyBaselineHint\(\);/, 'entry: from the settings');
  assert.match(entry, /\$\('#baseline-text'\)\.hidden = false;[^\n]*\n[^\n]*\n\s*applyBaselineHint\(\{ classic: true \}\);[^\n]*\n\s*return;/, 'no audio and none coming: the textarea is revealed, then the hint is re-painted as classic');
  // While the audio is merely still coming the textarea stays hidden, so the strip hint stays too.
  const coming = entry.slice(entry.indexOf('if (coming) {'), entry.indexOf("$('#seg-loading').hidden = true;"));
  assert.doesNotMatch(coming, /applyBaselineHint/, 'still-loading keeps the strip hint');
});

test('the Baseline tab\'s glossed-line refusal points at the Gloss tab only when this device can split there', () => {
  assert.match(STRIPS, /function stripsRefuse\(\) \{\s*\n\s*if \(!deps\.say\) return;\s*\n\s*let msg = deps\.t\('split\.no\.glossed'\);\s*\n\s*if \(!\(deps\.splitOnGloss && !deps\.splitOnGloss\(\)\)\) msg \+= ' ' \+ deps\.t\('split\.no\.glossedGloss'\);\s*\n\s*deps\.say\(msg\);/, 'the second sentence is conditional — and absent dep (an older host) keeps it');
  assert.equal((STRIPS.match(/stripsRefuse\(\)/g) || []).length, 3, 'defined once; both the split and the join refusals go through it');
  assert.doesNotMatch(STRIPS, /deps\.t\('split\.no\.glossed'\)\)/, 'none says the first sentence alone outside stripsRefuse');
  assert.match(APP, /splitOnGloss: \(\) => glossTabEnabled\(\) && splitLinesAllowed\('gloss'\),/, 'the host answers from the tab gate AND the split gate, read live through a function');
});

test('the Cut tab refusal points at the Baseline tab only when this device can split there', () => {
  assert.match(STRIPS, /function cutRefusal\(reason\) \{\s*\n\s*let msg = cutDeps\.t\('cut\.no\.' \+ reason\);\s*\n\s*if \(reason === 'hasText' && !\(cutDeps\.splitOnBaseline && !cutDeps\.splitOnBaseline\(\)\)\) msg \+= ' ' \+ cutDeps\.t\('cut\.no\.hasTextBaseline'\);/, 'the second sentence is conditional — and absent dep (an older host) keeps it');
  assert.equal((STRIPS.match(/cutSay\(cutRefusal\(r\.reason\)\)/g) || []).length, 2, 'both the cut and the join refusals go through it');
  assert.doesNotMatch(STRIPS, /cutSay\(cutDeps\.t\('cut\.no\.' \+ r\.reason\)\)/, 'none bypasses it');
  assert.match(APP, /splitOnBaseline: \(\) => baselineTabEnabled\(\) && splitLinesAllowed\('baseline'\),/, 'the host answers from the tab gate AND the split gate, read live through a function');
});

test('the Gloss tab\'s empty note names the Baseline tab only when the device has one', () => {
  const fn = APP.slice(APP.indexOf('function applyGlossEmptyHint()'), APP.indexOf('function applyCutHint()'));
  assert.match(fn, /el\.dataset\.i18nHtml = baselineTabEnabled\(\) \? 'gloss\.empty' : 'gloss\.emptyNoBaseline';/, 'one key or the other, so applyI18n still repaints it on a language change');
  assert.match(fn, /el\.innerHTML = t\(el\.dataset\.i18nHtml\);/);
  assert.match(APP, /applyGlossEmptyHint\(\);[^\n]*\n\s*\$\('#gloss-empty'\)\.hidden = any;/, 'renderGloss applies it before deciding whether to show it');
});
