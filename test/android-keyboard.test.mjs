// Issue #43, revisited. Seth, 2026-09-07: "when the auto-complete choices come up, it bumps the
// whole app view window (including the preview player and top level UI controls) up … I think what
// we want is for Android keyboard and auto-complete to just cover up over the top of the bottom,
// rather than shifting everything up" — and "is interactive-widget=resizes-content doing anything
// we need it to do?" It was: two things, and both are kept here without the shifting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const STRIPS = rd('../docs/js/segment-strips.js'), CSS = rd('../docs/css/app.css');
const APP = rd('../docs/js/app.js'), UI = rd('../docs/js/paragraph-ui.js');

test('every shell asks the keyboard to OVERLAY the page, not resize it', () => {
  const shells = ['../docs/index.html', '../paragraph-analysis/index.html',
    ...readdirSync(new URL('../satellites/', import.meta.url)).map((d) => `../satellites/${d}/index.html`)];
  let n = 0;
  for (const p of shells) {
    let html; try { html = rd(p); } catch { continue; }
    assert.match(html, /interactive-widget=overlays-content/, `${p} overlays`);
    assert.doesNotMatch(html, /interactive-widget=resizes-content/, `${p} does not resize`);
    n++;
  }
  assert.equal(n, 7, 'all seven shells');
});

test('what resizes-content was buying is kept: the focused box stays visible, and the bottom furniture rides above the keyboard', () => {
  const fn = STRIPS.slice(STRIPS.indexOf('export function installKeyboardOverlayGuard()'), STRIPS.indexOf('export function caretX('));
  // 1. a focused box is never left under the keyboard
  assert.match(fn, /const visibleBottom = vv\.offsetTop \+ vv\.height;/, 'measured against the visual viewport, which is the only thing that knows');
  assert.match(fn, /if \(r\.bottom <= visibleBottom - 8\) return;/, 'and never scrolls when it is already visible');
  assert.match(fn, /el\.scrollIntoView\(\{ block: 'center', behavior: 'smooth' \}\)/);
  // 2. the bottom-fixed furniture is lifted by however much is covered
  assert.match(fn, /const covered = Math\.max\(0, Math\.round\(window\.innerHeight - \(vv\.height \+ vv\.offsetTop\)\)\);/);
  assert.match(fn, /document\.documentElement\.style\.setProperty\('--kb-inset', covered \+ 'px'\);/);
  assert.match(fn, /vv\.addEventListener\('scroll', setInset\);/, 'the visual viewport pans as well as resizes');
  assert.match(fn, /document\.addEventListener\('focusout', \(\) => setTimeout\(setInset, 350\)\);/, 'and it comes back down when the keyboard closes');
  assert.match(fn, /window\.__fxKbGuard/, 'installed once');
  // 3. the history is written down where someone would flip it back
  assert.match(STRIPS, /v579 set\n \* `resizes-content` ON PURPOSE/, 'the previous setting was deliberate, and says so');
});

test('the bottom-fixed pieces all use the inset, so none of them hide behind the keyboard', () => {
  for (const [sel, re] of [
    ['#toast', /#toast \{[\s\S]{0,120}bottom: calc\(20px \+ env\(safe-area-inset-bottom\) \+ var\(--kb-inset, 0px\)\);/],
    ['#upload-bar', /#upload-bar \{[\s\S]{0,60}bottom: var\(--kb-inset, 0px\);/],
    ['.app-version', /bottom: calc\(4px \+ env\(safe-area-inset-bottom\) \+ var\(--upload-bar-h, 0px\) \+ var\(--kb-inset, 0px\)\);/],
    ['.update-ready-banner', /position: fixed; left: 0; right: 0; bottom: var\(--kb-inset, 0px\); width: 100%;/],
    ['.rp-jobs', /position: fixed; z-index: 120; left: 12px; bottom: calc\(12px \+ var\(--kb-inset, 0px\)\);/],
  ]) assert.match(CSS, re, sel);
});

test('both apps that take typing install it', () => {
  assert.match(APP, /installKeyboardOverlayGuard\(\);/);
  assert.match(UI, /installKeyboardOverlayGuard\(\);/);
});
