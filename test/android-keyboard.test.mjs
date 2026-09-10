// Issue #43, revisited. Seth, 2026-09-07: "when the auto-complete choices come up, it bumps the
// whole app view window (including the preview player and top level UI controls) up … I think what
// we want is for Android keyboard and auto-complete to just cover up over the top of the bottom,
// rather than shifting everything up" — and "is interactive-widget=resizes-content doing anything
// we need it to do?" It was: two things, and both are kept here without the shifting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';

import { visibleBandBottom, revealScrollBy } from '../docs/js/segment-strips.js';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
/* ⚠ STRIP COMMENTS BEFORE ANY doesNotMatch. These tests read source as text, so a comment SAYING
 * "why not scrollIntoView" satisfies a search for scrollIntoView and the assertion fails on its own
 * documentation. Only the code is evidence of what the code does. */
const bare = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
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
  assert.match(fn, /const visibleBottom = \(\) => visibleBandBottom\(\{/,
    'the visible band comes from the pure function the mode tests below exercise');
  assert.match(fn, /kbHeight: kbPx\(\),/, 'fed the keyboard height the viewport cannot see');
  assert.match(fn, /if \(by <= 0\) continue;/, 'and never scrolls when the box is already clear');
  // 2. the bottom-fixed furniture is lifted by however much is covered
  assert.match(fn, /document\.documentElement\.style\.setProperty\('--kb-inset', coveredPx\(\) \+ 'px'\);/);
  assert.match(fn, /vv\.addEventListener\('scroll', setInset\);/, 'the visual viewport pans as well as resizes');
  assert.match(fn, /document\.addEventListener\('focusout', \(\) => setTimeout\(setInset, 350\)\);/, 'and it comes back down when the keyboard closes');
  assert.match(fn, /window\.__fxKbGuard/, 'installed once');
  // 3. the history is written down where someone would flip it back
  assert.match(STRIPS, /v579 set\n \* `resizes-content` ON PURPOSE/, 'the previous setting was deliberate, and says so');
});

/* ⚠ #43, THIRD TIME. v609 measured a viewport that overlays-content does not shrink; v615 fixed that
 * in coveredPx and left visibleBottom holding the same false assumption, so the INSET worked and the
 * REVEAL did not — bottom furniture rode above the keyboard while the focused box stayed buried.
 * Seth, on v664 hardware: "Keyboard still buries what I click on to type."
 *
 * These pin the two properties that make a reveal safe, which is the other half of why the previous
 * attempt was unwelcome: Seth, "we just have to make sure that scrolling to the focused field
 * doesn't push our preview/big player and top UI elements off the page. It had been doing that
 * before." Hence: scroll the box's own scrollport, never the document, and by the minimum. */
test('revealing a buried box scrolls its own scrollport by the minimum, never the document', () => {
  const fn = STRIPS.slice(STRIPS.indexOf('export function installKeyboardOverlayGuard()'), STRIPS.indexOf('export function caretX('));

  // the two sources are kept apart precisely so visibleBottom can subtract the right one
  assert.match(fn, /const shrunkPx = \(\) =>/, 'how much the viewport has already given up');
  assert.match(fn, /const kbPx = \(\) =>/, 'what the keyboard itself reports');
  assert.match(fn, /const coveredPx = \(\) => Math\.max\(0, shrunkPx\(\), kbPx\(\)\);/,
    'the inset still wants the larger of the two, so the furniture does not regress');

  // NEVER THE DOCUMENT: the walk stops before body/documentElement, and scrollIntoView is gone
  // because it scrolls every ancestor including the page and takes an alignment, not an amount.
  assert.match(fn, /p !== document\.body && p !== document\.documentElement/,
    'the scrollport walk stops before the document');
  assert.doesNotMatch(bare(fn), /scrollIntoView/,
    'no scrollIntoView: it moves every scrollable ancestor, the document included');

  // BY THE MINIMUM: an explicit amount, capped by the room above the box
  assert.match(fn, /const by = revealScrollBy\(\{ elTop: r\.top, elBottom: r\.bottom, bandBottom: bottom, stickyBottom: stickyBottom\(sc\), gap: GAP \}\);/,
    'the amount is the pure function the behaviour tests below exercise');
  assert.match(STRIPS, /export function revealScrollBy\(/, 'exported so the arithmetic is testable without a DOM');
  assert.match(STRIPS, /export function visibleBandBottom\(/);
  assert.match(STRIPS, /const need = Math\.ceil\(elBottom - \(bandBottom - gap\)\);/, 'just enough to clear the keyboard');
  assert.match(STRIPS, /return Math\.min\(need, headroom\);/, 'and no further than the room above it');
  assert.doesNotMatch(bare(fn), /block: 'center'/, 'centring overshoots by design');

  // a sticky header parked at the top of the scrollport is what headroom protects
  assert.match(fn, /getComputedStyle\(k\)\.position !== 'sticky'/, 'measures the sticky player rather than assuming its height');

  // ⚠ and prove the stripper above did not simply gut the text, which would make every
  // doesNotMatch in this test vacuous.
  assert.match(bare(fn), /sc\.scrollTop = before \+ by;/, 'bare() keeps code, drops only comments');
  assert.doesNotMatch(bare(fn), /WHY NOT scrollIntoView/, 'and it really did drop the comments');

  // and it declines to guess
  assert.match(fn, /if \(!coveredPx\(\)\) return;/, 'no keyboard visible to either API: do nothing');
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
  const fn = STRIPS.slice(STRIPS.indexOf('const shrunkPx = ()'), STRIPS.indexOf('const shrunkPx = ()') + 520);
  assert.match(fn, /const r = vk && vk\.boundingRect;/);
  assert.match(fn, /r && r\.height \? Math\.round\(r\.height\) : 0/, 'the keyboard\'s own height is the primary signal');
  assert.match(fn, /Math\.max\(0, Math\.round\(window\.innerHeight - \(vv\.height \+ vv\.offsetTop\)\)\)/,
    'visualViewport stays as the fallback for iOS Safari and any browser that does shrink it');
  assert.match(STRIPS, /interactive-widget=overlays-content` is DEFINED as resizing neither/,
    'and the reason is written down, so nobody re-measures the wrong thing');
});

test('every bottom-fixed rule reads both inset sources', () => {
  const rules = CSS.match(/max\(var\(--kb-inset, 0px\), env\(keyboard-inset-height, 0px\)\)/g) || [];
  assert.equal(rules.length, 5, 'toast, upload bar, version badge, update banner and the jobs tray');
  assert.doesNotMatch(CSS, /[^,] var\(--kb-inset, 0px\)\)?;/, 'no rule left reading --kb-inset alone');
});

/* ⚠ THESE ARE THE ONLY TESTS THAT WOULD HAVE CAUGHT #43 — TWICE. Every other test in this file
 * reads source as text, so both previous versions of the bug passed the suite: the code plainly
 * said it measured the keyboard, and it did, and the answer was still wrong. The arithmetic is
 * exported precisely so the modes can be enumerated. */
test('the visible band ends above the keyboard in every viewport mode', () => {
  const H = 800, KB = 300;
  // overlays-content — what all seven shells declare, and the mode that was broken. Neither
  // viewport shrinks, so the whole keyboard must come off a full-height viewport.
  assert.equal(visibleBandBottom({ innerHeight: H, vvHeight: H, vvOffsetTop: 0, kbHeight: KB }), 500,
    'overlays-content: the keyboard is invisible to the viewport, so subtract all of it');
  // the exact regression: before the fix this evaluated to 800, so a box at y=640 tested as
  // "already visible" and the guard returned without scrolling.
  assert.notEqual(visibleBandBottom({ innerHeight: H, vvHeight: H, vvOffsetTop: 0, kbHeight: KB }), H,
    'and NOT the full window height, which is what left the box buried');
  // resizes-visual (the browser default) — vv.height already excludes the keyboard: do not
  // subtract twice, or a box well clear of the keyboard gets scrolled for nothing.
  assert.equal(visibleBandBottom({ innerHeight: H, vvHeight: 500, vvOffsetTop: 0, kbHeight: KB }), 500,
    'resizes-visual: the viewport already gave it up');
  // Firefox Android: no keyboard API at all, but the viewport does shrink.
  assert.equal(visibleBandBottom({ innerHeight: H, vvHeight: 500, vvOffsetTop: 0, kbHeight: 0 }), 500,
    'no keyboard API: the shrinking viewport carries it');
  // no visualViewport at all
  assert.equal(visibleBandBottom({ innerHeight: H, kbHeight: KB }), 500);
  // a panned visual viewport moves the band down with it, in client coordinates
  assert.equal(visibleBandBottom({ innerHeight: H, vvHeight: H, vvOffsetTop: 40, kbHeight: KB }), 540);
  // and with no keyboard, the band is the whole viewport
  assert.equal(visibleBandBottom({ innerHeight: H, vvHeight: H, vvOffsetTop: 0, kbHeight: 0 }), H);
});

test('a buried box is scrolled by the minimum, and never past the sticky player', () => {
  // buried by 140px below the band, with plenty of room above it: move just enough plus the gap
  assert.equal(revealScrollBy({ elTop: 600, elBottom: 640, bandBottom: 500, stickyBottom: 0 }), 148);
  // already clear: never scroll for nothing (this is what keeps the page still while typing)
  assert.equal(revealScrollBy({ elTop: 100, elBottom: 140, bandBottom: 500, stickyBottom: 0 }), 0);
  // ⚠ Seth's constraint: "scrolling to the focused field doesn't push our preview/big player and
  // top UI elements off the page." A tall box cannot be fully revealed, so it is revealed as far as
  // the room above it allows and no further — 300 - 250 - 8 = 42, not the 148 it "needs".
  assert.equal(revealScrollBy({ elTop: 300, elBottom: 640, bandBottom: 500, stickyBottom: 250 }), 42);
  // and when there is no room at all, nothing moves rather than something going under the player
  assert.equal(revealScrollBy({ elTop: 100, elBottom: 640, bandBottom: 500, stickyBottom: 200 }), 0);
  // a box exactly at the gap boundary is left alone
  assert.equal(revealScrollBy({ elTop: 400, elBottom: 492, bandBottom: 500, stickyBottom: 0 }), 0);
});
