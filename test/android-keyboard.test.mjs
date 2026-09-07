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
  assert.match(fn, /const visibleBottom = \(vv \? vv\.offsetTop \+ vv\.height : window\.innerHeight\) - \(vv \? 0 : covered\);/,
    'measured against whatever the reader can still see, from whichever API can see it');
  assert.match(fn, /if \(r\.bottom <= visibleBottom - 8\) return;/, 'and never scrolls when it is already visible');
  assert.match(fn, /el\.scrollIntoView\(\{ block: 'center', behavior: 'smooth' \}\)/);
  // 2. the bottom-fixed furniture is lifted by however much is covered
  assert.match(fn, /document\.documentElement\.style\.setProperty\('--kb-inset', coveredPx\(\) \+ 'px'\);/);
  assert.match(fn, /vv\.addEventListener\('scroll', setInset\);/, 'the visual viewport pans as well as resizes');
  assert.match(fn, /document\.addEventListener\('focusout', \(\) => setTimeout\(setInset, 350\)\);/, 'and it comes back down when the keyboard closes');
  assert.match(fn, /window\.__fxKbGuard/, 'installed once');
  // 3. the history is written down where someone would flip it back
  assert.match(STRIPS, /v579 set\n \* `resizes-content` ON PURPOSE/, 'the previous setting was deliberate, and says so');
});

test('the bottom-fixed pieces all use the inset, so none of them hide behind the keyboard', () => {
  for (const [sel, re] of [
    ['#toast', /#toast \{[\s\S]{0,160}bottom: calc\(20px \+ env\(safe-area-inset-bottom\) \+ KB\);/],
    ['#upload-bar', /#upload-bar \{[\s\S]{0,80}bottom: KB;/],
    ['.app-version', /bottom: calc\(4px \+ env\(safe-area-inset-bottom\) \+ var\(--upload-bar-h, 0px\) \+ KB\);/],
    ['.update-ready-banner', /position: fixed; left: 0; right: 0; bottom: KB; width: 100%;/],
    ['.rp-jobs', /position: fixed; z-index: 120; left: 12px; bottom: calc\(12px \+ KB\);/],
  ]) assert.match(CSS, new RegExp(re.source.replace(/KB/g, 'max\\(var\\(--kb-inset, 0px\\), env\\(keyboard-inset-height, 0px\\)\\)')), sel);
});

test('both apps that take typing install it', () => {
  assert.match(APP, /installKeyboardOverlayGuard\(\);/);
  assert.match(UI, /installKeyboardOverlayGuard\(\);/);
});

/* ⚠ v615 FOUND THE v609 GUARD INERT UNDER ITS OWN META. `interactive-widget=overlays-content` is
 * defined as resizing NEITHER viewport, so visualViewport.height does not shrink when the Android
 * keyboard opens — the one signal v609 measured. --kb-inset stayed 0, a focused box under the
 * keyboard was never revealed, and every bottom-fixed control sat behind the keyboard: worse than
 * the `resizes-content` it replaced. These pin the Virtual Keyboard API as the primary signal. */
test('the guard reads the keyboard\'s own geometry, not just the visual viewport', () => {
  assert.match(STRIPS, /const vk = \(typeof navigator !== 'undefined' && navigator\.virtualKeyboard\) \|\| null;/);
  assert.match(STRIPS, /if \(!vv && !vk\) return;/, 'a browser with neither API is left alone, not half-installed');
  assert.match(STRIPS, /vk\.overlaysContent = true;/, 'opting in is what makes the keyboard report geometry at all');
  assert.match(STRIPS, /vk\.addEventListener\('geometrychange', onChange\)/);
  // whichever API sees more coverage wins, so neither can mask the other
  const fn = STRIPS.slice(STRIPS.indexOf('const coveredPx = ()'), STRIPS.indexOf('const coveredPx = ()') + 420);
  assert.match(fn, /const r = vk && vk\.boundingRect;/);
  assert.match(fn, /c = Math\.max\(c, Math\.round\(r\.height\)\)/);
  assert.match(fn, /c = Math\.max\(c, Math\.round\(window\.innerHeight - \(vv\.height \+ vv\.offsetTop\)\)\)/,
    'visualViewport stays as the fallback for iOS Safari and any browser that does shrink it');
  assert.match(STRIPS, /interactive-widget=overlays-content` is DEFINED as resizing neither/,
    'and the reason is written down, so nobody re-measures the wrong thing');
});

test('every bottom-fixed rule reads both inset sources', () => {
  const rules = CSS.match(/max\(var\(--kb-inset, 0px\), env\(keyboard-inset-height, 0px\)\)/g) || [];
  assert.equal(rules.length, 5, 'toast, upload bar, version badge, update banner and the jobs tray');
  assert.doesNotMatch(CSS, /[^,] var\(--kb-inset, 0px\)\)?;/, 'no rule left reading --kb-inset alone');
});
