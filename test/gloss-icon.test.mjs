// The Gloss tab icon setting (Seth, 2026-09-06): the researcher picks one of seven pictures, on the
// panel AND on the device's Settings tab, from a picker that SHOWS the pictures; the default
// (interlinear rows) is a template a device writes into its own settings at first boot; each editor
// device reports its choice and the dashboard tallies them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const PANEL = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../docs/css/app.css', import.meta.url), 'utf8');
const SEG = readFileSync(new URL('../satellites/audio-segmenter/index.html', import.meta.url), 'utf8');

const OPTS = ['stack', 'globe', 'translate', 'equals', 'bubble', 'book', 'pencil'];
const FIELD = "{ k: 'glossIcon', type: 'select', opts: ['stack', 'globe', 'translate', 'equals', 'bubble', 'book', 'pencil'], optPrefix: 'panel.opt.glossIcon.', icons: true, note: 'panel.f.glossIconNote' },";

test('seven pictures, interlinear rows by default, and the shell paints the default first', () => {
  assert.match(PANEL, /export const GLOSS_ICON_DEFAULT = 'stack';/);
  const map = PANEL.slice(PANEL.indexOf('export const GLOSS_ICONS = {'), PANEL.indexOf('export function glossIconSvg('));
  for (const k of OPTS) assert.match(map, new RegExp(`\\n  ${k}: '<`), `${k} is drawn`);
  const stack = map.match(/\n  stack: '([^']+)'/)[1];
  const tab = HTML.match(/<button class="top-tab"[^>]*data-tab="gloss"[^>]*>[\s\S]*?<\/button>/)[0];
  assert.ok(tab.includes(`<svg class="tab-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${stack}</svg>`), 'the static Gloss tab carries the default picture, so the first paint matches a fresh device');
  assert.doesNotMatch(SEG, /data-tab="gloss"/, 'the segmenter has no Gloss tab; applyGlossIcon returns there');
});

test('the default is a template: seeded into the device\'s own settings at first boot, presence-tested', () => {
  const seed = APP.slice(APP.indexOf('function seedSettingDefaults()'), APP.indexOf('function seedSettingDefaults()') + 400);
  assert.match(seed, /if \(s\.glossIcon === undefined\) \{ s\.glossIcon = GLOSS_ICON_DEFAULT; changed = true; \}/, 'absent → written; a stored choice is never touched');
  assert.match(seed, /if \(changed\) saveSettings\(s\);/);
  assert.match(APP, /migrateSettings\(\);\n  seedSettingDefaults\(\);\n  const \{ settingsChanged, task \} = applyUrlSettings\(\);/, 'seeded before the boot reads settings');
});

test('the tab picture follows the setting at boot and on a live push; shells without the tab are safe', () => {
  const fn = APP.slice(APP.indexOf('function applyGlossIcon()'), APP.indexOf('const ICONS_BELOW_PX = 1000;'));
  assert.match(fn, /\$\('#topbar-editor \.top-tab\[data-tab="gloss"\] \.tab-ico'\)/);
  assert.match(fn, /if \(!svg\) return;/);
  assert.match(fn, /GLOSS_ICONS\[settings\.glossIcon\] \? settings\.glossIcon : GLOSS_ICON_DEFAULT/, 'an unknown value shows the default rather than a blank tab');
  assert.match(fn, /svg\.innerHTML = GLOSS_ICONS\[want\];/, 'only the children change; the wrapper the CSS sizes stays');
  assert.match(APP, /applyHeaderLabels\(\);\n  applyI18n\(\);\n  applyGlossIcon\(\);/, 'boot');
  assert.match(APP, /applyHeaderLabels\(\);\n  applyGlossIcon\(\);\n  if \(RECORD_MODE\)/, 'live push');
  assert.match(APP, /import \{ initResearcherPanel, companionApps, GLOSS_ICONS, GLOSS_ICON_DEFAULT, iconTilesHtml, syncIconPicks, wireIconPicks \} from '\.\/researcher-panel\.js';/, 'one home for the pictures; no new precache entry');
});

test('both forms carry the field as a picture picker, with the same default line', () => {
  for (const [name, src] of [['app.js', APP], ['researcher-panel.js', PANEL]]) {
    assert.ok(src.includes(FIELD), `${name}: the field literal (inline opts, icons: true)`);
    assert.ok(src.includes("else if (f.k === 'glossIcon') v.glossIcon = GLOSS_ICONS[s.glossIcon] ? s.glossIcon : GLOSS_ICON_DEFAULT;"), `${name}: the form default is the template default`);
    assert.match(src, /if \(f\.icons\) return `<div class="rp-field"><span>\$\{label\}<\/span><select data-s?f="\$\{f\.k\}"[^`]*hidden>\$\{opts\}<\/select>\$\{iconTilesHtml\(f\)\}<\/div>/, `${name}: hidden select + tiles`);
  }
  const tiles = PANEL.slice(PANEL.indexOf('export function iconTilesHtml(f)'), PANEL.indexOf('function iconPickSelect('));
  assert.match(tiles, /class="rp-icontile" data-pick-for="\$\{esc\(f\.k\)\}" data-v="\$\{esc\(o\)\}" aria-pressed="false"/);
  assert.match(tiles, /glossIconSvg\(o, 'rp-icontile-ico'\)/, 'each tile shows the picture itself, not only its name');
  const wire = PANEL.slice(PANEL.indexOf('export function wireIconPicks(root)'), PANEL.indexOf('const GROUPS = ['));
  assert.match(wire, /sel\.value = b\.dataset\.v;/);
  assert.match(wire, /sel\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\);/, 'a tap goes through the form\'s own change → save path');
  assert.match(APP, /\n  syncIconPicks\(box\);\n  updateSetupConditionals\(box\);/, 'device form: tiles follow every fill');
  assert.match(APP, /box\.replaceChildren\(form\);\n  wireIconPicks\(form\);/, 'device form: wired on the fresh form element');
  assert.match(PANEL, /\n  syncIconPicks\(box\);\n  paintPromptState\(box\);/, 'panel form: tiles follow every fill');
  assert.match(PANEL, /fillForm\(box, toFormValues\(source\)\);\n  wireIconPicks\(box\);/, 'panel form: wired once per modal');
  const segKeys = APP.slice(APP.indexOf('const SEGMENTER_SETUP_KEYS = new Set(['), APP.indexOf('const SEGMENTER_SETUP_KEYS = new Set([') + 320);
  assert.doesNotMatch(segKeys, /glossIcon/, 'the segmenter (no Gloss tab) does not offer it');
});

test('each editor device reports its picture; the dashboard tallies one vote per device', () => {
  assert.match(APP, /'exportPreview', 'exportJson', 'glossIcon'\]\) \{/, 'in the settings snapshot the panel prefills from');
  assert.match(APP, /platform: nativePlatform\(\), nativeEngine: nativeEngineInfo\(\),\n[\s\S]{0,400}glossIcon: \(!RECORD_MODE && !CONSENT_MODE && !SEGMENTER_MODE && !CROWD_MODE\)/, 'top-level, editor shell only');
  assert.match(PANEL, /const iconUse = \{\};/);
  assert.match(PANEL, /if \(newest\) \{ const k = newest\.inventory\.glossIcon; iconUse\[k\] = \(iconUse\[k\] \|\| 0\) \+ 1; \}/, 'one vote per device, from its newest install');
  assert.match(PANEL, /\$\{glossIconTally\(iconUse\)\}/, 'rendered on the dashboard');
  assert.match(PANEL, /ins\.inventory && ins\.inventory\.glossIcon,/, 'in viewSig, so a changed choice repaints');
  const tally = PANEL.slice(PANEL.indexOf('function glossIconTally(use)'), PANEL.indexOf('function deviceInfo('));
  assert.match(tally, /sort\(\(a, b\) => use\[b\] - use\[a\]\)/, 'most used first');
  assert.match(tally, /if \(!keys\.length\) return '';/, 'absent until a device has said');
});

test('labels, notes, the dashboard line and the release notes exist in both languages', () => {
  const keys = ['panel.f.glossIcon', 'panel.f.glossIconNote', 'panel.dash.glossIcons', ...OPTS.map((o) => 'panel.opt.glossIcon.' + o)];
  for (const k of keys) assert.equal((I18N.match(new RegExp(`\n  '${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  for (const k of ['panel.rel.new.glossIcon', 'panel.rel.new.cutShiftSpace', 'panel.rel.new.spaceMobile']) {
    assert.equal((I18N.match(new RegExp(`\n    ,'${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} release note in EN and ID`);
  }
  assert.match(PANEL, /\{ v: 'v590', date: '2026-09-06', items: \[\n    \{ k: 'panel\.rel\.new\.glossIcon' \},\n    \{ k: 'panel\.rel\.new\.cutShiftSpace' \},\n    \{ k: 'panel\.rel\.new\.spaceMobile' \},\n  \] \},/);
  assert.match(CSS, /\.rp-icontile\[aria-pressed="true"\] \{ border-color: #1f4f8f;/, 'the chosen tile is visibly chosen');
  assert.match(CSS, /\.rp-icontile \.rp-icontile-ico \{ width: 22px; height: 22px; \}/);
});
