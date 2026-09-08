/* EACH EDITOR TAB IS THE RESEARCHER'S TO GRANT (Seth, 2026-09-08: "all three tabs in the editor
 * should be enableable/disablable for a paired device. This enables the researcher to delegate
 * different steps to different users. Or at least to do that while they're learning to use the
 * app"). One coworker cuts the audio, another transcribes, a third glosses; or a beginner is given
 * one tab and grows into the rest.
 *
 * ⚠ THE GUARD IS THE POINT. A device with no editor tab at all is a coworker who cannot work and
 * cannot put it right themselves — in a village that is days from help. The gate is written so that
 * cannot happen however the three switches are set. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), PANEL = rd('../docs/js/researcher-panel.js'), I18N = rd('../docs/js/i18n.js');

/* The gate re-implemented from the source's own shape, so the table below exercises the RULE.
 * (tabWanted/editorTabEnabled read `settings`, which does not exist outside the app.) */
const enabledFor = (settings) => {
  const segOn = () => settings.segmentation !== false;
  const wanted = (t) => t === 'cut' ? (segOn() && settings.cutTab !== false)
    : t === 'gloss' ? settings.glossTab !== false : settings.baselineTab !== false;
  const on = (t) => wanted(t) || (t === 'baseline' && !wanted('cut') && !wanted('gloss'));
  return ['cut', 'baseline', 'gloss'].filter(on);
};

test('absent means on, so an existing device is unchanged', () => {
  assert.deepEqual(enabledFor({}), ['cut', 'baseline', 'gloss']);
  assert.match(APP, /settings\.glossTab !== false/, 'unset ⇒ shown');
  assert.match(APP, /settings\.baselineTab !== false/);
});

test('the researcher can hand out one step at a time', () => {
  assert.deepEqual(enabledFor({ glossTab: false }), ['cut', 'baseline'], 'a transcriber');
  assert.deepEqual(enabledFor({ cutTab: false, glossTab: false }), ['baseline'], 'a beginner');
  assert.deepEqual(enabledFor({ baselineTab: false, glossTab: false }), ['cut'], 'somebody who only cuts');
  assert.deepEqual(enabledFor({ cutTab: false, baselineTab: false }), ['gloss'], 'somebody who only glosses');
});

test('⚠ all three off still leaves a way to work', () => {
  assert.deepEqual(enabledFor({ cutTab: false, baselineTab: false, glossTab: false }), ['baseline'],
    'Baseline comes back — the one tab needing neither audio nor prior analysis');
  assert.match(APP, /return tab === 'baseline' && !tabWanted\('cut'\) && !tabWanted\('gloss'\);/,
    'and that is what the source says, not a coincidence of this table');
});

test('every way in goes through one gate', () => {
  /* ⚠ AFTER splitCancel(), not before it: leaving a tab drops a half-placed split whether or not
   * the switch is then redirected, and split-tiers pins that cancel as the first statement. */
  assert.match(APP, /function switchTab\(tab, landing\) \{\s*\n\s*splitCancel\(\);[\s\S]{0,400}?if \(!editorTabEnabled\(tab\)\) tab = firstEnabledTab\(\);/,
    'landing, a remembered tab, a push and a click all arrive at switchTab');
  assert.match(APP, /if \(activeTab && !editorTabEnabled\(activeTab\)[^\n]*switchTab\(firstEnabledTab\(\), true\);/,
    'and a live push that removes the tab being looked at moves off it');
});

test('all three buttons follow the settings', () => {
  const fn = APP.slice(APP.indexOf('function applyCutTabVisibility'), APP.indexOf('function applyCutTabVisibility') + 700);
  assert.match(fn, /set\('#tab-cut', cutTabEnabled\(\)\)/);
  assert.match(fn, /data-tab="baseline"\]', baselineTabEnabled\(\)\)/);
  assert.match(fn, /data-tab="gloss"\]', glossTabEnabled\(\)\)/);
});

test('the researcher can reach them, in both languages', () => {
  for (const [name, src] of [['app', APP], ['panel', PANEL]]) {
    assert.match(src, /\{ k: 'baselineTab', type: 'checkbox', note: 'panel\.f\.editorTabsNote' \}/, `${name}: baseline`);
    assert.match(src, /\{ k: 'glossTab', type: 'checkbox' \}/, `${name}: gloss`);
    assert.match(src, /else if \(f\.k === 'glossTab'\) v\.glossTab = s\.glossTab !== false;/, `${name}: unset shows ticked`);
  }
  assert.match(APP, /'cutTab', 'baselineTab', 'glossTab', 'wordGloss', 'glossLanding', 'landOnCut'/, 'and they travel with a setup link');
  for (const k of ['panel.f.baselineTab', 'panel.f.glossTab', 'panel.f.editorTabsNote']) {
    assert.equal((I18N.match(new RegExp("'" + k.replace(/\./g, '\\.') + "':", 'g')) || []).length, 2, `${k}: EN + ID`);
  }
});
