/* WORD-BY-WORD GLOSSING IS THE RESEARCHER'S TO GRANT (Seth, 2026-09-08: "the ability to disable
 * word-by-word glossing. If this setting is disabled, then the gloss tab just shows the baseline
 * text words with the free translation box and no interlinear gloss boxes visible or editable").
 * A coworker whose job is the translation rather than the analysis has no use for them.
 *
 * And the companion rule: the researcher must not be able to switch off all three editor tabs.
 * app.js already brings Baseline back if the settings would leave nothing, but Seth: "Your fallback
 * is OK as a fallback, but let's also not let the researcher disable all three tabs" — a fallback
 * quietly disagreeing with what was ticked is a poor way to find out. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), PANEL = rd('../docs/js/researcher-panel.js'), I18N = rd('../docs/js/i18n.js');

test('absent means on, so no existing device changes', () => {
  assert.match(APP, /function wordGlossOn\(\) \{ return settings\.wordGloss !== false; \}/);
});

/* ⚠ NOT BUILT, not hidden. A hidden input is still memory and still a tab stop, and this suite runs
 * on devices where that matters (#19). Safe because every consumer of .gloss-input already copes
 * with a cell that has none — a punctuation cell never had one. */
test('the boxes are not built at all when it is off', () => {
  const cell = APP.slice(APP.indexOf('function renderWordCell'), APP.indexOf('function sizeInput'));
  assert.match(cell, /if \(wordGlossOn\(\)\) \{\s*\n\s*const g = document\.createElement\('input'\);/,
    'construction is inside the gate');
  assert.match(cell, /g\.className = 'gloss-input';/);
  assert.ok(cell.indexOf('cell.appendChild(g);') > cell.indexOf('if (wordGlossOn()) {'),
    'and so is the append');
  assert.doesNotMatch(cell, /gloss-input[^\n]*display:\s*none|hidden = !wordGlossOn/,
    'not hidden-but-present');
});

test('the row label goes with the boxes', () => {
  assert.match(APP, /if \(wordGlossOn\(\)\) labels\.append\(lw, lg\); else labels\.append\(lw\);/,
    'naming a row that is not there reads as something missing');
});

test('the researcher can reach it, in both languages', () => {
  for (const [name, src] of [['app', APP], ['panel', PANEL]]) {
    assert.match(src, /\{ k: 'wordGloss', type: 'checkbox', note: 'panel\.f\.wordGlossNote' \}/, name);
    assert.match(src, /else if \(f\.k === 'wordGloss'\) v\.wordGloss = s\.wordGloss !== false;/, `${name}: unset shows ticked`);
  }
  assert.match(APP, /'glossTab', 'wordGloss', 'glossLanding', 'landOnCut'/, 'travels with a setup link');
  for (const k of ['panel.f.wordGloss', 'panel.f.wordGlossNote']) {
    assert.equal((I18N.match(new RegExp("'" + k.replace(/\./g, '\\.') + "':", 'g')) || []).length, 2, `${k}: EN + ID`);
  }
});

/* ── the at-least-one-tab rule ─────────────────────────────────────────────────────────────── */

// re-implemented from the source's own shape so the table exercises the RULE
const blocked = (raw) => {
  const tabOn = (k) => raw[k] !== false;
  return !tabOn('baselineTab') && !tabOn('glossTab') && !(tabOn('segmentation') && tabOn('cutTab'));
};

test('the save is refused only when nothing would be left', () => {
  assert.equal(blocked({}), false, 'all defaults');
  assert.equal(blocked({ glossTab: false }), false);
  assert.equal(blocked({ baselineTab: false, glossTab: false }), false, 'Cut still there');
  assert.equal(blocked({ baselineTab: false, glossTab: false, cutTab: false }), true, '⚠ nothing left');
});

/* ⚠ Cut only COUNTS while segmentation is on — with segmentation off it is not on screen, so
 * ticking it must not satisfy the rule with an empty editor. */
test('a ticked Cut tab does not count when segmentation is off', () => {
  assert.equal(blocked({ baselineTab: false, glossTab: false, cutTab: true, segmentation: false }), true);
  assert.equal(blocked({ baselineTab: false, glossTab: false, cutTab: true, segmentation: true }), false);
  assert.match(PANEL, /!\(tabOn\('segmentation'\) && tabOn\('cutTab'\)\)/, 'and that is what the source says');
});

test('the rule reaches stored snapshots too, not just the live form', () => {
  assert.match(PANEL, /segmentation: s\.segmentation, cutTab: s\.cutTab, baselineTab: s\.baselineTab, glossTab: s\.glossTab,/,
    'settingsToRaw carries them, so a merged push is held to the same rule');
  // The section is 'tasks' since the v641 reorganisation — the id was renamed with the label.
  assert.match(PANEL, /out\.push\(\{ group: 'tasks', field: 'baselineTab', msg: t\('panel\.val\.tabsNone'\) \}\)/);
  assert.match(APP, /out\.push\(\{ group: 'tasks', field: 'baselineTab', msg: t\('panel\.val\.tabsNone'\) \}\)/,
    'and the unpaired form warns on the same rule');
  assert.equal((I18N.match(/'panel\.val\.tabsNone':/g) || []).length, 2, 'EN + ID');
});

/* ── where the caret lands on the Gloss tab, which is now the researcher's call ─────────────── */

/* Seth, 2026-09-08: "Gloss default landing box as free translation is where I want to go now. But
 * let's have that be a device setting in the researcher and unpaired device settings… let's start
 * with free translation as the default for now."
 *
 * ⚠ This only decides where a user lands when the remembered caret is STALE — part-way through a
 * box on the same line, they simply carry on (see restoreTypingFocus). The two answers suit
 * different jobs, which is what makes it a setting rather than a rule: the free line for somebody
 * translating, the next unfilled gloss for somebody glossing. Issue #58 asked the question first. */
test('the Gloss landing box is a setting, defaulting to the free translation', () => {
  const target = APP.slice(APP.indexOf('function typingTargetForLastPlayed'), APP.indexOf('function spaceToggles'));
  assert.match(target, /if \(settings\.glossLanding === 'gloss'\) \{/, "only 'gloss' opts out");
  assert.match(target, /return g\.querySelector\('\.free-input'\) \|\| glosses\[glosses\.length - 1\] \|\| null;/,
    'absent ⇒ the free translation, so the default needs no seeding');
  // ⚠ each option falls back to the OTHER kind of box: a line may have no translation field, and
  // with word glossing off it has no gloss boxes at all.
  assert.match(target, /glosses\.find\(\(el\) => !el\.value\.trim\(\)\) \|\| glosses\[glosses\.length - 1\] \|\| g\.querySelector\('\.free-input'\)/,
    "'gloss' still lands somewhere on a line with no gloss boxes");
});

test('both settings surfaces carry it, in both languages', () => {
  const field = /\{ k: 'glossLanding', type: 'select', opts: \['free', 'gloss'\], optPrefix: 'panel\.opt\.glossLanding\.', note: 'panel\.f\.glossLandingNote' \}/;
  assert.match(PANEL, field, 'the researcher panel');
  assert.match(APP, field, 'and the unpaired device Settings tab');
  assert.match(APP, /else if \(f\.k === 'glossLanding'\) v\.glossLanding = s\.glossLanding === 'gloss' \? 'gloss' : 'free';/,
    'an unset value shows as the free translation, matching the engine default');
  assert.match(APP, /'wordGloss', 'glossLanding', 'landOnCut'/, 'and it travels with a setup link');
  for (const k of ['panel.f.glossLanding', 'panel.f.glossLandingNote',
                   'panel.opt.glossLanding.free', 'panel.opt.glossLanding.gloss']) {
    assert.equal((I18N.match(new RegExp("'" + k.replace(/\./g, '\\.') + "':", 'g')) || []).length, 2, `${k}: EN + ID`);
  }
});
