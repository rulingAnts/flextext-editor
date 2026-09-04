// Issue #31 (Seth, 2026-09-04): "Cutting a large file (10-15 minutes) stops loading waveform previews
// after a certain limit." No code capped the strips; the browser's canvas-memory budget did, because
// every row owned a live bitmap. Strips are now parked (width 0, no backing store) while they are far
// from the viewport and redrawn from the cached peaks when they scroll near.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const S = readFileSync(new URL('../docs/js/segment-strips.js', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const fn = (header) => { const i = S.indexOf(header); assert.ok(i > 0, header); const r = S.slice(i); return r.slice(0, r.indexOf('\n}\n') + 3); };

test('observeWave parks far-away strips through one IntersectionObserver and gates every redraw', () => {
  const body = fn('function observeWave(canvas, redraw)');
  assert.match(body, /canvas\.__redrawWave = \(\) => \{ if \(canvas\.__onScreen === false\) return; redraw\(\); \};/, 'gated redraw');
  assert.match(body, /if \(observedWaves\.has\(canvas\)\) return;/, 'flags are initialised once, on first observation');
  assert.match(body, /const waveIO = waveIOFor\(scrollRootOf\(canvas\)\);/, 'one observer per scroll container, so rootMargin reaches ahead inside <main> and .mg-rows');
  const io = fn('function waveIOFor(root)');
  assert.match(io, /new IntersectionObserver\(/);
  assert.match(io, /\{ root, rootMargin: '150% 0px' \}/, 'the container is the root; a screen and a half of margin');
  assert.match(io, /el\.__onScreen = false;\s*\n\s*el\.width = 0;/, 'leaving releases the bitmap');
  assert.match(io, /if \(el\.__onScreen !== true\) \{ el\.__onScreen = true; if \(el\.__redrawWave\) el\.__redrawWave\(\); \}/, 'entering redraws once');
  const root = fn('function scrollRootOf(el)');
  assert.match(root, /getComputedStyle\(p\)\.overflowY/);
  assert.match(root, /o === 'auto' \|\| o === 'scroll'/);
  assert.match(body, /canvas\.__onScreen = waveIO \? false : undefined;/, 'born parked; eager without IntersectionObserver');
  assert.match(body, /if \(!el\.isConnected\) \{ forgetWave\(el\); continue; \}/, 'detached canvases are dropped from both observers');
  assert.match(fn('function forgetWave(el)'), /el\.__waveIO\.unobserve\(el\)/, 'and from the right IntersectionObserver');
});

test('the tickers skip parked strips; drawStrip rounds its bitmap and survives a refused context', () => {
  const fix = fn('function fixStaleWave(canvas)');
  assert.match(fix, /if \(canvas\.__onScreen === false\) return;/);
  const draw = fn('function drawStrip(canvas, seg, durationMs, opts)');
  assert.match(draw, /canvas\.width = Math\.round\(w \* dpr\);/, 'agrees with the Math.round checks, so fractional DPRs stop redrawing every frame');
  assert.match(draw, /canvas\.height = Math\.round\(cssH \* dpr\);/);
  assert.match(draw, /const g = canvas\.getContext\('2d'\);\s*\n\s*if \(!g\) return;/, 'one refused canvas cannot abort the rest of the render');
  assert.doesNotMatch(draw, /canvas\.width = w \* dpr;/);
});

test('every strip surface registers lazily instead of drawing eagerly', () => {
  assert.match(S, /observeWave\(wave, \(\) => drawStrip\(wave, seg, dur\)\);/, 'Baseline tab');
  assert.doesNotMatch(S, /\n    drawStrip\(wave, seg, dur\);/, 'Baseline tab: no eager draw');
  const cut = S.slice(S.indexOf('function renderCut('));
  assert.match(cut, /observeWave\(wave, \(\) => drawStrip\(wave, seg, peaksCache\.durationMs, paint\)\);/);
  assert.doesNotMatch(cut.slice(0, cut.indexOf('\n}\n')), /\n    drawStrip\(wave, seg, peaksCache\.durationMs, paint\);/, 'Cut tab: no eager draw');
  const attach = fn('export function attachSpanWave(canvas, seg)');
  assert.doesNotMatch(attach, /\n  drawSpanWave\(canvas, seg\);/, 'matcher / gloss helper: observe only');
  assert.match(APP, /attachSpanWave\(wave, seg\);   \/\/ lazy: the gloss tab/, 'Gloss tab uses the lazy helper');
  assert.match(APP, /if \(wave && wave\.__onScreen !== false\) drawSpanWave\(wave, sp\);/, 'the matcher refresh leaves parked strips parked');
});
