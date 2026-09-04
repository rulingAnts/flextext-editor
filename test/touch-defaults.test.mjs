// Tablet / Android defaults (Seth, 2026-09-04: issues #42–#45).
//   #43  the bottom UI and the soft keyboard buried the player → viewport meta resizes content
//   #45  a finger on a strip scrubbed it and the page could not scroll → touch arbitration + pan-y
//   #42  Space typed a space AND toggled playback on a tablet → spacePlays setting + Shift+Space;
//        Enter in a translation box walks to the next line instead of doing nothing
//   #44  text size for the whole app → uiScale device setting, pushable from the panel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const STRIPS = readFileSync(new URL('../docs/js/segment-strips.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../docs/css/app.css', import.meta.url), 'utf8');
const PANEL = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');

const SHELLS = [
  '../docs/index.html', '../paragraph-analysis/index.html',
  ...readdirSync(new URL('../satellites/', import.meta.url), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `../satellites/${d.name}/index.html`),
];

test('#43 every app shell asks the browser to resize the layout around the soft keyboard', () => {
  assert.ok(SHELLS.length >= 7, 'seven shells: editor, paragraph analysis, five satellites');
  for (const rel of SHELLS) {
    const html = readFileSync(new URL(rel, import.meta.url), 'utf8');
    const metas = html.match(/<meta name="viewport"[^>]*>/g) || [];
    assert.equal(metas.length, 1, `${rel}: one viewport meta`);
    assert.match(metas[0], /interactive-widget=resizes-content/, `${rel}: resizes-content`);
  }
});

test('#45 strip canvases let a finger scroll the page (pan-y), grips still capture the touch', () => {
  for (const sel of ['.seg-wave', '.gseg-wave', '.pa-wave', '.pa-ovwrap canvas']) {
    const rule = CSS.split('\n').find((l) => l.startsWith(sel + ' {'));
    assert.ok(rule, `rule for ${sel}`);
    assert.match(rule, /touch-action: pan-y/, `${sel} pans vertically`);
  }
  assert.doesNotMatch(CSS, /\.seg-wave \{[^}]*touch-action: none/);
  const grip = CSS.split('\n').find((l) => l.startsWith('.mg-edge {'));
  if (grip) assert.match(grip, /touch-action: none/, 'the drag grips keep the whole gesture');
});

test('#45 wireWaveSeek arbitrates a touch: tap parks, horizontal drag scrubs, vertical drag scrolls', () => {
  const fn = STRIPS.slice(STRIPS.indexOf('function wireWaveSeek('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /ev\.pointerType === 'touch'/, 'touch takes its own branch');
  const touch = body.slice(body.indexOf("ev.pointerType === 'touch'"), body.indexOf('ev.preventDefault();'));
  assert.match(touch, /Math\.abs\(dx\) > Math\.abs\(dy\) \? 'scrub' : 'scroll'/, 'direction decides');
  assert.match(touch, /Math\.abs\(dx\) < 8 && Math\.abs\(dy\) < 8/, 'an 8px dead zone before deciding');
  assert.match(touch, /if \(mode === 'undecided'\) \{ onTarget\?\.\(seg\); getPlayer\(\)\?\.pause\?\.\(\); seekAt\(e2\); \}/, 'a tap parks the playhead');
  assert.match(touch, /else if \(mode === 'scroll'\) done\(\)/, 'a vertical drag is released to the browser');
  assert.match(touch, /pointercancel/, 'the browser taking the gesture over cleans up');
  assert.doesNotMatch(touch, /ev\.preventDefault\(\)/, 'no preventDefault on touch pointerdown: pan-y stays possible');
  const mouse = body.slice(body.indexOf('ev.preventDefault();'));
  assert.match(mouse, /setPointerCapture\(ev\.pointerId\)/, 'mouse and pen keep park-and-drag');
});

test('#42 Space is a setting: auto (off on coarse pointers), on, off; Shift+Space always toggles', () => {
  const fn = APP.slice(APP.indexOf('function spaceToggles()'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /settings\.spacePlays \|\| 'auto'/);
  assert.match(body, /if \(m === 'on'\) return true;/);
  assert.match(body, /if \(m === 'off'\) return false;/);
  assert.match(body, /matchMedia\('\(pointer: coarse\)'\)\.matches/, 'auto follows the pointer type');
  const keys = APP.slice(APP.indexOf('function wirePlaybackKeys('), APP.indexOf('function spaceToggles()'));
  const space = keys.slice(keys.indexOf("if (e.key !== ' ' || e.repeat) return;"));
  assert.match(space, /if \(e\.shiftKey\) \{ e\.preventDefault\(\); togglePlayFromKey\(\); return; \}/, 'Shift+Space first');
  const shiftAt = space.indexOf('e.shiftKey'), gateAt = space.indexOf('transportKeysApply(e.target');
  assert.ok(shiftAt < gateAt, 'Shift+Space is decided before the text-box gate, so it works inside a field');
  assert.match(space, /if \(!spaceToggles\(\)\) return;/, 'plain Space honours the setting');
  assert.ok(space.indexOf('spaceToggles()') < gateAt, 'the setting gate sits before the field gate');
  assert.ok(APP.includes('function togglePlayFromKey()'), 'one toggle body shared by both paths');
  assert.match(APP, /player\.playSpan\(inside \? at : lastPlayTarget\.start, lastPlayTarget\.end, lastPlayTarget\.start\)/);
});

test('#42 Enter in a free-translation box walks to the next line when no split applies', () => {
  const i = APP.indexOf("else if (e.key === 'Enter' && !e.shiftKey) {");
  assert.ok(i > 0, 'the walk branch exists');
  const branch = APP.slice(i, i + 700);
  assert.match(branch, /document\.querySelectorAll\('\.free-input'\)/);
  assert.match(branch, /all\[all\.indexOf\(fi\) \+ 1\]/, 'the next translation box in document order');
  assert.match(branch, /next\.focus\(\)/);
  const before = APP.slice(i - 400, i);
  assert.match(before, /joinSplitAllowed\('gloss'\)/, 'the split branches are tried first; the walk is the fallback');
});

test('#44 uiScale applies as a root zoom at boot and on every live-settings push', () => {
  const fn = APP.slice(APP.indexOf('function applyUiScale()'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /Number\(settings\.uiScale\) \|\| 1/);
  assert.match(body, /document\.documentElement\.style\.zoom = \(z === 1\) \? '' : String\(z\)/, 'normal size clears the zoom');
  const boot = APP.indexOf('  settings = loadSettings();\n  applyUiScale();\n  applyI18n();');
  assert.ok(boot > 0, 'boot applies it before the first paint');
  const live = APP.indexOf('  settings = loadSettings();\n  applyUiScale();   // a pushed text size lands live');
  assert.ok(live > 0, 'applyLiveSettings applies it too');
});

test('#42/#44 both settings forms carry the two selects, with defaults that show the current state', () => {
  for (const [name, src] of [['app', APP], ['panel', PANEL]]) {
    assert.match(src, /\{ k: 'uiScale', type: 'select', opts: \['0\.85', '1', '1\.15', '1\.3', '1\.5'\], optPrefix: 'panel\.opt\.scale\.' \}/, `${name}: uiScale select`);
    assert.match(src, /\{ k: 'spacePlays', type: 'select', opts: \['auto', 'on', 'off'\], optPrefix: 'panel\.opt\.space\.', note: 'panel\.f\.spacePlaysNote' \}/, `${name}: spacePlays select`);
    assert.match(src, /else if \(f\.k === 'uiScale'\) v\.uiScale = String\(s\.uiScale \|\| '1'\);/, `${name}: unset scale shows Normal`);
    assert.match(src, /else if \(f\.k === 'spacePlays'\) v\.spacePlays = s\.spacePlays \|\| 'auto';/, `${name}: unset shows Automatic`);
  }
  const keys = APP.slice(APP.indexOf('const SEGMENTER_SETUP_KEYS'), APP.indexOf('const SEGMENTER_SETUP_KEYS') + 300);
  assert.match(keys, /'uiScale'/, 'the segmenter Settings tab gets text size');
  assert.doesNotMatch(keys, /'spacePlays'/, 'the segmenter has no Space transport to configure');
});

test('#42/#44 strings exist in both languages', () => {
  const need = ['panel.f.uiScale', 'panel.opt.scale.0.85', 'panel.opt.scale.1', 'panel.opt.scale.1.15', 'panel.opt.scale.1.3',
    'panel.opt.scale.1.5', 'panel.f.spacePlays', 'panel.f.spacePlaysNote', 'panel.opt.space.auto', 'panel.opt.space.on', 'panel.opt.space.off'];
  for (const k of need) {
    const n = (I18N.match(new RegExp(`^  '${k.replace(/\./g, '\\.')}':`, 'mg')) || []).length;
    assert.equal(n, 2, `${k} in EN and ID`);
  }
});
