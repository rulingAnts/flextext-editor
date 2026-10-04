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
 * said before #92, so the fix changes nothing for a device that was never restricted. */
const TODAY = {
  en: {
    split: 'Type the words for each line. <b>Enter</b> inside a box breaks the line at the cursor; <b>Enter</b> with no box selected breaks it at the playhead and keeps the words together — so you can listen and cut without typing.',
    move: 'Type the words for each line. <b>Enter</b> moves on to the next line. To cut a line in two, first tap the <b>✂</b> at its left edge — the scissors then show you every place you can cut. Tap it again to put them away.',
    hasText: 'This line already has words typed for it, so it cannot be cut here. Split it on the Baseline tab instead, where you can choose where the words divide.',
  },
  id: {
    split: 'Ketik kata-kata untuk tiap baris. <b>Enter</b> di dalam kotak memotong baris di posisi kursor; <b>Enter</b> tanpa kotak yang dipilih memotongnya di posisi pemutar dan kata-katanya tetap utuh — jadi Anda bisa mendengarkan sambil memotong tanpa mengetik.',
    move: 'Ketik kata-kata untuk tiap baris. <b>Enter</b> berpindah ke baris berikutnya. Untuk memotong sebuah baris menjadi dua, ketuk dahulu <b>✂</b> di tepi kirinya — gunting lalu menunjukkan setiap tempat yang bisa dipotong. Ketuk lagi untuk menyembunyikannya.',
    hasText: 'Baris ini sudah ada kata-katanya, jadi tidak bisa dipotong di sini. Pisahkan di tab Ketik saja, di mana Anda bisa memilih di mana kata-katanya dibagi.',
  },
};

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
    const { t } = i18n;
    assert.equal(assemble(t, { advance: false, split: true }), TODAY[lang].split, 'a device still on `split`');
    assert.equal(assemble(t, { advance: true, split: true }), TODAY[lang].move, 'a device where Enter moves on');
    assert.equal(t('cut.no.hasText') + ' ' + t('cut.no.hasTextBaseline'), TODAY[lang].hasText, 'the Cut tab refusal, both sentences');
  });

  test(`${lang}: with splitting off, no sentence explains how to split`, () => {
    i18n.setLang(lang, { save: false });
    const { t } = i18n;
    const lead = t('baseline.hintSegLead').trim();
    assert.equal(assemble(t, { advance: false, split: false }), lead, 'on `split`, Enter does nothing with splitting off — so the hint says nothing about it');
    const moved = assemble(t, { advance: true, split: false });
    assert.equal(moved, (t('baseline.hintSegLead') + t('baseline.hintSegEnterMove')).trim(), 'Enter still walks on, and that is all');
    assert.ok(!moved.includes('✂') && !moved.includes(t('baseline.hintSegScissors')), 'no scissors');
    assert.ok(!t('cut.no.hasText').includes(t('cut.no.hasTextBaseline')), 'the refusal\'s first sentence does not already contain the second');
    assert.ok(!t('gloss.emptyNoBaseline').includes('<b>'), 'the no-Baseline note names no tab');
  });
}

test('the Baseline hint is assembled from the live settings, not picked by one key', () => {
  const fn = APP.slice(APP.indexOf('function baselineHintHtml()'), APP.indexOf('function applyGlossEmptyHint()'));
  assert.match(fn, /if \(!segmentationEnabled\(\)\) return t\('baseline\.hint'\);/, 'classic mode keeps its one sentence');
  assert.match(fn, /const split = joinSplitAllowed\('baseline'\);/, 'consults the joinSplitBaseline gate…');
  assert.match(fn, /if \(enterAtEndAdvances\(\)\) \{\s*\n\s*parts\.push\(t\('baseline\.hintSegEnterMove'\)\);\s*\n\s*if \(split\) parts\.push\(t\('baseline\.hintSegScissors'\)\);/, '…the scissors only when splitting is allowed');
  assert.match(fn, /\} else if \(split\) \{\s*\n\s*parts\.push\(t\('baseline\.hintSegEnterSplit'\)\);/, 'and the Enter-splits sentence only when it is true');
  assert.match(fn, /const hint = document\.getElementById\('baseline-hint'\);/, 'repaints the span by id');
  assert.match(fn, /if \(segmentationEnabled\(\)\) delete hint\.dataset\.i18nHtml; else hint\.dataset\.i18nHtml = 'baseline\.hint';/, 'and keeps applyI18n from overwriting the assembled text with a single key');
  assert.match(HTML, /<span id="baseline-hint" data-i18n-html="baseline\.hint"><\/span>/, 'the span exists in the markup');
  assert.doesNotMatch(APP, /baseline\.hintSegMove|'baseline\.hintSeg'/, 'nothing still reaches for the retired paragraphs');
});

test('the help is re-worded when settings change without a reload, and when the language changes', () => {
  const live = APP.slice(APP.indexOf('function applyLiveSettings()'), APP.indexOf('function deleteAllAllowed()'));
  assert.match(live, /applyCutHint\(\);/, 'the Cut hint (already live before #92)');
  assert.match(live, /applyBaselineHint\(\);/, 'the Baseline hint follows a pushed joinSplitBaseline / enterAtEnd');
  assert.match(live, /applyGlossEmptyHint\(\);/, 'the Gloss empty note follows a pushed baselineTab');
  // A pushed changeSettings reaches applyLiveSettings — that is the path the panel's push lands on.
  const cmd = APP.slice(APP.indexOf("case 'changeSettings': {"), APP.indexOf("case 'changeSettings': {") + 3000);
  assert.match(cmd, /applyLiveSettings\(\);/, 'changeSettings → applyLiveSettings');
  // The local language toggle repaints static keys with applyI18n, which cannot repaint an assembled hint.
  assert.match(APP, /setLang\(langSel\.value\);\s*\n\s*applyI18n\(\);\s*\n\s*applyBaselineHint\(\);/, 'the language toggle re-assembles the Baseline hint after applyI18n');
});

test('the Cut tab refusal points at the Baseline tab only when this device can split there', () => {
  assert.match(STRIPS, /function cutRefusal\(reason\) \{\s*\n\s*let msg = cutDeps\.t\('cut\.no\.' \+ reason\);\s*\n\s*if \(reason === 'hasText' && !\(cutDeps\.splitOnBaseline && !cutDeps\.splitOnBaseline\(\)\)\) msg \+= ' ' \+ cutDeps\.t\('cut\.no\.hasTextBaseline'\);/, 'the second sentence is conditional — and absent dep (an older host) keeps it');
  assert.equal((STRIPS.match(/cutSay\(cutRefusal\(r\.reason\)\)/g) || []).length, 2, 'both the cut and the join refusals go through it');
  assert.doesNotMatch(STRIPS, /cutSay\(cutDeps\.t\('cut\.no\.' \+ r\.reason\)\)/, 'none bypasses it');
  assert.match(APP, /splitOnBaseline: \(\) => baselineTabEnabled\(\) && joinSplitAllowed\('baseline'\),/, 'the host answers from the tab gate AND the split gate, read live through a function');
});

test('the Gloss tab\'s empty note names the Baseline tab only when the device has one', () => {
  const fn = APP.slice(APP.indexOf('function applyGlossEmptyHint()'), APP.indexOf('function applyCutHint()'));
  assert.match(fn, /el\.dataset\.i18nHtml = baselineTabEnabled\(\) \? 'gloss\.empty' : 'gloss\.emptyNoBaseline';/, 'one key or the other, so applyI18n still repaints it on a language change');
  assert.match(fn, /el\.innerHTML = t\(el\.dataset\.i18nHtml\);/);
  assert.match(APP, /applyGlossEmptyHint\(\);[^\n]*\n\s*\$\('#gloss-empty'\)\.hidden = any;/, 'renderGloss applies it before deciding whether to show it');
});
