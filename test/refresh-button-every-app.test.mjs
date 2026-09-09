/* EVERY APP CAN BE TOLD TO GO AND GET THE NEW VERSION (Seth, 2026-09-09: "Make sure all of our apps
 * have the refresh button (including audio segmenter, consent-collector, and paragraph analysis tool
 * and recorder)").
 *
 * The apps DO update themselves — bgUpdateCheck polls, applyUpdateIfSafe installs. This is the
 * escape hatch for when that has not happened, which is not hypothetical: on 2026-09-09 a browser
 * profile was found serving v610 against a v645 site, and only the editor had a control to fix it.
 *
 * ⚠ THE RESEARCHER PANEL IS DELIBERATELY EXCLUDED (Seth, same day: "the panel is different because
 * it doesn't have an offline cached version (an offline cached version wouldn't help at all with an
 * app whose functions entirely depend on an internet connection)"). Its sw.js only redirects legacy
 * installs and precaches no shell, so there is no stale copy to escape from. Its own ↻ is a
 * DASHBOARD refresh and means something else — two identical glyphs meaning different things in one
 * header is worse than the gap. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js');

const SHELLS = {
  editor: '../docs/index.html',
  'audio-segmenter': '../satellites/audio-segmenter/index.html',
  'consent-collector': '../satellites/consent-collector/index.html',
  'text-recorder': '../satellites/text-recorder/index.html',
  'crowd-recorder': '../satellites/crowd-recorder/index.html',
};

test('every app ships the button, exactly once', () => {
  for (const [name, path] of Object.entries(SHELLS)) {
    const html = rd(path);
    const n = (html.match(/id="btn-refresh"/g) || []).length;
    assert.equal(n, 1, `${name} has exactly one #btn-refresh (found ${n})`);
    // The label is what a screen reader and a long-press get; the glyph alone says nothing.
    const tag = html.match(/<button id="btn-refresh"[^>]*>/)[0];
    assert.match(tag, /data-i18n-title="btn\.refresh"/, `${name} labels it`);
    assert.match(tag, /data-i18n-aria="btn\.refresh"/, `${name} names it for a screen reader`);
  }
});

test('the researcher panel does NOT have it, and that is the decision', () => {
  assert.doesNotMatch(rd('../satellites/flextext-researcher/index.html'), /id="btn-refresh"/);
  // Its worker is redirect-only — it answers navigations and precaches nothing.
  const sw = rd('../satellites/flextext-researcher/sw.js');
  assert.match(sw, /e\.request\.mode !== 'navigate'\) return;/,
    'the panel worker handles navigations only, so it holds no stale shell');
});

/* ⚠ THE BUG THIS TEST EXISTS TO PREVENT. The handler first went in inside setup(), where the old
 * editor-only binding lived — but setup() returns early for CROWD, PARAGRAPH, RESEARCHER, RECORD and
 * CONSENT mode, every one of them BEFORE that point. Four of the five new buttons would have
 * rendered perfectly and done nothing at all. It lives at module scope now. */
test('the handler is at module scope, above setup() and all its mode returns', () => {
  const handler = APP.indexOf("closest('#btn-refresh')");
  const setupFn = APP.indexOf('\nfunction setup() {');
  assert.ok(handler > 0 && setupFn > 0, 'both are findable');
  assert.ok(handler < setupFn,
    'the listener registers before setup() is even defined — no mode branch can skip it');
  for (const mode of ['CROWD_MODE', 'PARAGRAPH_MODE', 'RECORD_MODE', 'CONSENT_MODE', 'RESEARCHER_MODE']) {
    const ret = APP.indexOf(`if (${mode})`, setupFn);
    if (ret > 0) assert.ok(handler < ret, `${mode}'s early return cannot strand the button`);
  }
});

/* Delegation, not a direct bind: the Paragraph Analysis Tool re-renders its whole UI on every edit,
 * so a listener attached to the element would be discarded with the first render. */
test('it is delegated, so a re-rendered button still works', () => {
  assert.match(APP, /document\.addEventListener\('click', async \(e\) => \{\s*\n\s*const b = e\.target\.closest && e\.target\.closest\('#btn-refresh'\);/);
  assert.doesNotMatch(APP, /\$\('#btn-refresh'\)\?\.addEventListener/, 'the old direct bind is gone');
});

test('it saves before it reloads, and reloads even when a step fails', () => {
  const h = APP.slice(APP.indexOf("closest('#btn-refresh')"), APP.indexOf('/* ---------------- Wire-up'));
  assert.match(h, /document\.activeElement\.blur/, 'blur first — that is what fires change handlers');
  assert.match(h, /clearTimeout\(saveTimer\); await persist\(\)/, 'then flush the debounced save');
  assert.match(h, /getRegistration\(\)[\s\S]{0,40}update\(\)/, 'then ask the worker for a new version');
  assert.match(h, /finally \{ location\.reload\(\); \}/, 'and reload whatever happened above');
});

/* PAT IS THE ONE THAT IS NOT A SHELL. Its button lives in its own toolbar markup, between the ? and
 * Save — Seth, 2026-09-09: "UI vertical space is at a premium. Put it between the help button and
 * the save button." It first shipped as a strip of its own above the tool, which bought placement
 * safety with a whole band of a header that is already several rows tall. */
test('the Paragraph Analysis Tool carries it between the ? and Save', () => {
  const ui = rd('../docs/js/paragraph-ui.js');
  const help = ui.indexOf('id="pa-tip-btn"');
  const mine = ui.indexOf('id="btn-refresh"');
  const save = ui.indexOf('id="pa-save-icon"');
  assert.ok(help > 0 && mine > 0 && save > 0, 'all three buttons are in the bar');
  assert.ok(help < mine && mine < save, 'and in that order: ? → refresh → Save');
  /* ⚠ RESOLVED AT RENDER, not data-i18n: this bar is rebuilt on every edit and applyI18n() does not
   * run again afterwards, so a data-i18n-title would leave an empty tooltip. */
  assert.match(ui.slice(mine - 200, mine + 200), /title="\$\{esc\(t\('btn\.refresh'\)\)\}/);
  assert.match(ui.slice(mine - 200, mine + 260), /aria-label="\$\{esc\(t\('btn\.refresh'\)\)\}/);
  // The shell no longer carries one, and neither does the stylesheet.
  assert.doesNotMatch(rd('../paragraph-analysis/index.html'), /btn-refresh|pa-appbar/);
  assert.doesNotMatch(rd('../docs/css/app.css'), /pa-appbar/);
});

/* ⚠ WHY DELEGATION IS LOAD-BEARING HERE SPECIFICALLY: PAT re-renders this whole bar on every edit,
 * so the button the user clicks is never the one that existed when the app booted. */
test('PAT re-renders the bar the button sits on', () => {
  const ui = rd('../docs/js/paragraph-ui.js');
  assert.match(ui, /root\.innerHTML = `/, 'the tool writes its screens wholesale');
});

test('the label exists in both languages', () => {
  assert.equal((rd('../docs/js/i18n.js').match(/'btn\.refresh':/g) || []).length, 2);
});
