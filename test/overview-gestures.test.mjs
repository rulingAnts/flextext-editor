// The big player's own gestures (Seth, 2026-09-06): tap parks, dragging anywhere but the playhead
// scrolls the zoomed waveform, the playhead line scrubs, pinch zooms (a trackpad pinch is a wheel
// with ctrlKey); the dock's boundary marks show on every tab and follow a strip-grip drag while the
// player zooms in on the seam; the exported listening page has the same grammar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const STRIPS = readFileSync(new URL('../docs/js/segment-strips.js', import.meta.url), 'utf8');
const AUDIO = readFileSync(new URL('../docs/js/audio.js', import.meta.url), 'utf8');
const EXPORTS = readFileSync(new URL('../docs/js/seg-exports.js', import.meta.url), 'utf8');

test('the Player takes touch pointers at the capture phase; the mouse keeps wavesurfer\'s own seeking', () => {
  const g = AUDIO.slice(AUDIO.indexOf('attachWaveGestures() {'), AUDIO.indexOf('zoomAround(px, tAnchor, clientX) {'));
  assert.match(g, /if \(ev\.pointerType !== 'touch' \|\| !ready\(\)\) return;/, 'only fingers');
  assert.match(g, /ev\.stopPropagation\(\);\s*\/\/ wavesurfer's drag-to-seek never sees a finger/);
  for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) assert.match(g, new RegExp(`wave\\.addEventListener\\('${ev}', \\w+, true\\);`), `${ev} in capture`);
  assert.match(g, /mode = onCursor\(ev\) \? 'scrub' : 'tap';/, 'the playhead line scrubs; anything else starts as a tap');
  assert.match(g, /if \(mode === 'tap' && Math\.hypot\(dx, dy\) > 10\) mode = 'scroll';/, 'a moved finger scrolls');
  assert.match(g, /this\.ws\.setScroll\(scroll0 - dx\);/, 'by moving the waveform, not the playhead');
  assert.match(g, /mode = 'pinch'; dist0 = /, 'two fingers pinch');
  assert.match(g, /this\.zoomAround\(px0 \* \(dist \/ dist0\), midT, \(a\.x \+ b\.x\) \/ 2\);/, 'zoom around the midpoint');
  assert.match(g, /if \(!ev\.ctrlKey \|\| !ready\(\)\) return;/, 'a trackpad pinch is a wheel with ctrlKey');
  assert.match(g, /if \(t != null\) \{ this\.ws\.setTime\(t\); this\.onSeekInteraction\?\.\(\); \}/, 'a tap parks and reaches the same hook a mouse click does');
  assert.match(AUDIO, /px = Math\.min\(ZOOM_MAX, Math\.max\(this\._fitPx \|\| ZOOM_MIN, px\)\);/, 'never wider than the whole file');
  assert.match(AUDIO, /this\.attachWaveResize\(\);\n    this\.attachWaveGestures\(\);/, 'installed with the resize observer, once per Player');
  const hit = AUDIO.slice(AUDIO.indexOf('renderCursorHit() {'), AUDIO.indexOf('placeCursorHit() {'));
  assert.match(hit, /if \(!coarse\) \{ if \(this\._cursorHit\) \{ this\._cursorHit\.remove\(\); this\._cursorHit = null; \} return; \}/, 'the finger grip exists only on a coarse pointer');
  assert.match(hit, /width:32px;margin-left:-16px;pointer-events:auto;touch-action:none/, 'the strips\' 32px playhead zone, on the overview');
  assert.match(AUDIO, /this\.renderBoundaries\(\);\n      this\.renderCursorHit\(\);/, 'built on ready');
  assert.match(AUDIO, /fmt\(this\.ws\.getDuration\(\)\);\n    this\.placeCursorHit\(\);/, 'follows the playhead');
});

test('the marks show on every tab, follow a grip drag, and the player zooms in on the seam meanwhile', () => {
  assert.match(STRIPS, /export function overviewMarks\(segs\)/);
  assert.match(STRIPS, /function cutBoundaryTimes\(\) \{ return overviewMarks\(cutSegs\(\)\); \}/, 'the Cut tab');
  assert.match(STRIPS, /syncOverviewMarks\(deps\.getPlayer, segs\);\s*\/\/ the dock's marks, on this tab too/, 'the Baseline tab');
  assert.match(APP, /syncOverviewMarks\(\(\) => player, segs\);\s*\/\/ the dock's marks, on this tab too/, 'the Gloss tab');
  assert.match(STRIPS, /const want = overviewMarks\(docSegments\(doc\)\);\s*\n\s*if \(p\.boundaryCount\(\) !== want\.filter\(Number\.isFinite\)\.length\) p\.setBoundaries\(want\);/, 'Baseline ticker backstop');
  assert.match(APP, /const want = overviewMarks\(docSegments\(current\.doc\)\);\s*\n\s*if \(player\.boundaryCount\(\) !== want\.filter\(Number\.isFinite\)\.length\) player\.setBoundaries\(want\);/, 'Gloss ticker backstop');
  const drag = STRIPS.slice(STRIPS.indexOf('export function makeBoundaryDrag(o)'), STRIPS.indexOf('let stripsDragFn = null;'));
  assert.match(drag, /p\?\.boundaryFocus\?\.\('start', s\.end\)/, 'zoom in when the grip is picked up');
  assert.match(drag, /p\?\.boundaryFocus\?\.\('move', r\.t\)/, 'keep the seam centred while it moves');
  assert.match(drag, /p\?\.boundaryFocus\?\.\('end'\)/, 'and put the zoom back on release');
  assert.match(STRIPS, /syncMarks: \(\) => syncOverviewMarks\(deps\.getPlayer, docSegments\(deps\.getDoc\(\)\)\),/, 'Baseline drags move the marks');
  assert.match(APP, /syncMarks: \(\) => syncOverviewMarks\(\(\) => player, docSegments\(current\.doc\)\),/, 'Gloss drags move the marks');
  const focus = AUDIO.slice(AUDIO.indexOf('boundaryFocus(phase, ms) {'), AUDIO.indexOf('renderCursorHit() {'));
  assert.match(focus, /this\._focusPrev = \{ px: this\.ws\.options\.minPxPerSec, scroll: this\.ws\.getScroll\(\)/, 'remembers where it was');
  assert.match(focus, /this\.ws\.zoom\(prev\.px\); this\.ws\.setScroll\(prev\.scroll\);/, 'and goes back there');
  assert.match(AUDIO, /const FOCUS_WINDOW_S = 4;/);
  assert.match(focus, /this\.ws\.getWidth\(\) \/ FOCUS_WINDOW_S/, 'the close-up is a window of seconds, the same on a phone and a laptop');
});

test('the exported listening page has the same overview grammar', () => {
  assert.match(EXPORTS, /\.player \.wwrap \{ height: 72px; overflow-x: auto; overflow-y: hidden;/, 'the overview scrolls once zoomed (the wrapper owns the height since v608)');
  assert.match(EXPORTS, /if \(el === ov\) return;\s*\/\/ the overview has its own touch grammar/, 'wireScrub steps aside for fingers on the overview');
  const ov = EXPORTS.slice(EXPORTS.indexOf("var ovWrap = ov.parentNode, ovZoom = 1, focusPrev = null;"), EXPORTS.indexOf('/* ── SPACE = PLAY/PAUSE'));
  assert.match(ov, /function setOvZoom\(z, anchorMs, clientX\)/);
  assert.match(ov, /var zMax = Math\.max\(1, Math\.min\(40, 32000 \/ \(wrapW \* dpr\)\)\);\s*\n\s*z = Math\.max\(1, Math\.min\(z, zMax\)\);/, 'never narrower than the whole file, and never wider than a canvas can be drawn (v608)');
  assert.match(ov, /ov\.style\.width = \(z \* 100\) \+ '%';\s*\n\s*ovDraw\(\);/, 'redrawn at the new width');
  assert.match(ov, /if \(mode === 'tap' && Math\.sqrt\(dx \* dx \+ dy \* dy\) > 10\) mode = 'scroll';/);
  assert.match(ov, /if \(mode === 'scroll'\) \{ ovWrap\.scrollLeft = scroll0 - dx; ev\.preventDefault\(\); \}/);
  assert.match(ov, /if \(mode === 'tap' && ev\.type === 'pointerup'\) \{ audio\.pause\(\); audio\.currentTime = ovMs\(ev\.clientX\) \/ 1000; \}/, 'a tap parks');
  assert.match(ov, /if \(!ev\.ctrlKey\) return; ev\.preventDefault\(\); setOvZoom\(ovZoom \* Math\.exp\(-ev\.deltaY \* 0\.005\)/, 'trackpad pinch');
  assert.match(EXPORTS, /var knob = el\.parentNode && el\.parentNode\.querySelector\('\.cur'\);/, 'the playhead knob still scrubs');
});
