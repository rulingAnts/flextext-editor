// Seth, 2026-09-06: header buttons and tabs are exempt from the text-size zoom, and the header's
// Save and Done — send buttons are icons (disk; green check + send), with their words kept for
// screen readers and hover through the i18n attribute hooks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../docs/css/app.css', import.meta.url), 'utf8');
const SHELLS = ['../docs/index.html', '../satellites/audio-segmenter/index.html'];

test('the top row and the panel header keep their size at every text size', () => {
  const fn = APP.slice(APP.indexOf('function applyUiScale()'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /querySelectorAll\('\.player, #topbar, \.rp-head'\)\) el\.style\.zoom = \(z === 1\) \? '' : String\(1 \/ z\)/);
});

test('Save is a disk and Done — send is a green check plus a send icon, each beside its label, words also in aria-label and title', () => {
  for (const rel of SHELLS) {
    const html = readFileSync(new URL(rel, import.meta.url), 'utf8');
    const save = html.match(/<button id="btn-save"[\s\S]*?<\/button>/)[0];
    const done = html.match(/<button id="btn-share"[\s\S]*?<\/button>/)[0];
    for (const [name, b, key] of [['save', save, 'btn.save'], ['done', done, 'btn.done']]) {
      assert.match(b, /<svg class="ico/, `${rel} ${name}: an icon`);
      assert.match(b, new RegExp(`data-i18n-aria="${key.replace('.', '\\.')}"`), `${rel} ${name}: aria-label from i18n`);
      assert.match(b, new RegExp(`data-i18n-title="${key.replace('.', '\\.')}"`), `${rel} ${name}: title from i18n`);
      assert.match(b, new RegExp(`<span data-i18n="${key.replace('.', '\\.')}">`), `${rel} ${name}: the label is a span beside the icon, filled by i18n`);
      assert.doesNotMatch(b.slice(0, b.indexOf('>')), /data-i18n="/, `${rel} ${name}: no text binding on the button itself`);
      assert.match(b, /class="(primary|secondary)-btn btn-icon"/, `${rel} ${name}: icon-button styling`);
    }
    assert.match(done, /<circle cx="12" cy="12" r="10" fill="#2e7d32"\/>/, `${rel}: green check`);
    assert.equal((done.match(/<svg /g) || []).length, 2, `${rel}: check + send`);
    assert.match(save, /<rect x="8" y="13"/, `${rel}: the disk's label plate`);
  }
  assert.match(CSS, /\.btn-icon \{ display: inline-flex; align-items: center; gap: 6px;/);
  assert.match(CSS, /#doc-title \{ flex: 1 1 120px; min-width: 90px; max-width: 260px; \}/, 'the title box gives up width so the row stays on one line');
});

test('the Cut, Baseline and Gloss tabs carry an icon beside a label the i18n binding still fills', () => {
  for (const rel of SHELLS) {
    const html = readFileSync(new URL(rel, import.meta.url), 'utf8');
    for (const tab of ['cut', 'baseline', 'gloss']) {
      const m = html.match(new RegExp(`<button class="top-tab"[^>]*data-tab="${tab}"[^>]*>[\\s\\S]*?</button>`));
      if (!m) continue;   // a shell without that tab
      assert.match(m[0], /<svg class="tab-ico"/, `${rel} ${tab}: icon`);
      assert.match(m[0], new RegExp(`<span data-i18n="tabs\\.${tab}">`), `${rel} ${tab}: the label is the span, so applyI18n never overwrites the icon`);
      assert.doesNotMatch(m[0].slice(0, m[0].indexOf('>')), /data-i18n=/, `${rel} ${tab}: no text binding on the button itself`);
    }
  }
  assert.match(CSS, /\.top-tab \{ display: inline-flex; align-items: center; gap: 6px; \}/);
});


test('the researcher chooses words, icons, both, or auto; auto is icons only below 1000 px wide', () => {
  const PANEL = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
  for (const [name, src] of [['app', APP], ['panel', PANEL]]) {
    assert.match(src, /\{ k: 'headerLabels', type: 'select', opts: \['auto', 'both', 'icons', 'text'\], optPrefix: 'panel\.opt\.labels\.', note: 'panel\.f\.headerLabelsNote' \}/, `${name}: the select`);
    assert.match(src, /else if \(f\.k === 'headerLabels'\) v\.headerLabels = s\.headerLabels \|\| 'auto';/, `${name}: unset shows Automatic`);
  }
  const fn = APP.slice(APP.indexOf('function applyHeaderLabels()'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(APP, /const ICONS_BELOW_PX = 1000;/, 'Seth: less than 1000 px wide = icons only');
  assert.doesNotMatch(APP.slice(APP.indexOf('function applyHeaderLabels()'), APP.indexOf('function applyUiScale()')), /userAgent|maxTouchPoints|pointer: coarse/, 'width only, never the user agent');
  assert.match(body, /matchMedia\(`\(max-width: \$\{ICONS_BELOW_PX - 1\}px\)`\)/, 'auto follows the viewport width: 999 px and below');
  assert.match(body, /headerLabelsMql\.addEventListener\('change', \(\) => applyHeaderLabels\(\)\)/, 'and re-decides live');
  assert.match(body, /mode = headerLabelsMql && headerLabelsMql\.matches \? 'icons' : 'both';/);
  assert.match(body, /document\.documentElement\.dataset\.labels = mode;/);
  assert.match(APP, /applyUiScale\(\);\n  applyHeaderLabels\(\);\n  applyI18n\(\);/, 'applied at boot');
  assert.match(APP, /applyUiScale\(\);   \/\/ a pushed text size lands live, in every app\n  applyHeaderLabels\(\);/, 'and on every settings push');
  assert.match(APP.slice(APP.indexOf('const SEGMENTER_SETUP_KEYS'), APP.indexOf('const SEGMENTER_SETUP_KEYS') + 320), /'headerLabels'/, 'the segmenter has the header too');
  assert.match(CSS, /html\[data-labels="icons"\] #topbar-editor \.btn-icon span, html\[data-labels="icons"\] #topbar-editor \.top-tab span \{ display: none; \}/);
  assert.match(CSS, /html\[data-labels="text"\] #topbar-editor \.btn-icon \.ico, html\[data-labels="text"\] #topbar-editor \.top-tab \.tab-ico \{ display: none; \}/);
  assert.doesNotMatch(CSS, /html\[data-labels="icons"\] #topbar-home/, 'home tabs keep their words in every mode');
});
