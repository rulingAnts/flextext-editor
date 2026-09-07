// Seth, 2026-09-07: "when it expands, the currently focused segment waveform jumps down and then
// dragging right or left is ineffective until the user drags their finger (or mouse cursor) back
// down to the segment. We should fix that (both in PAT and in the preview HTML)" — and "make sure
// preview HTML has all the same touch grammar as the editor (at least scrolling/scrubbing/zooming
// touch grammar, not editing grammar)".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const UI = rd('../docs/js/paragraph-ui.js'), SEGX = rd('../docs/js/seg-exports.js');
const CSS = rd('../docs/css/app.css'), STRIPS = rd('../docs/js/segment-strips.js'), I18N = rd('../docs/js/i18n.js');

test('the drag survives the player growing: both surfaces capture the pointer, as the editor always has', () => {
  assert.match(STRIPS, /wave\.setPointerCapture\(ev\.pointerId\)/, 'the editor (unchanged)');
  const pat = UI.slice(UI.indexOf('function wireScrub(el, s, e)'), UI.indexOf('function playSpan(s, e)'));
  assert.match(pat, /try \{ el\.setPointerCapture\(ev\.pointerId\); \} catch \{[^}]*\}/, 'the tool');
  assert.match(pat, /el\.addEventListener\('pointercancel', end\);/, 'and a cancelled gesture closes the close-up');
  const sx = SEGX.slice(SEGX.indexOf('function wireScrub(el, s, e)'), SEGX.indexOf('wireScrub(ov, 0, totalMs);'));
  assert.match(sx, /try \{ el\.setPointerCapture\(ev\.pointerId\); \} catch \(e2\) \{\}/, 'the listening page');
  assert.match(sx, /el\.addEventListener\('pointercancel', function \(\) \{ if \(down\) release\(\); down = false; \}\);/);
});

test('the lines stay exactly where they were: the player grows and takes the same off its bottom margin', () => {
  const focus = UI.slice(UI.indexOf('function ovFocus(phase, ms)'), UI.indexOf('function ovSeams()'));
  assert.match(focus, /const base = parseFloat\(getComputedStyle\(player\)\.marginBottom\) \|\| 0;\s*\n\s*player\.style\.marginBottom = \(base - \(player\.getBoundingClientRect\(\)\.height - h0\)\) \+ 'px';/, 'the tool: exactly what it grew by');
  assert.match(focus, /if \(p\.player\) p\.player\.style\.marginBottom = p\.playerMargin;/, 'and put back');
  assert.doesNotMatch(UI, /scrollTop \+= delta|ovShiftRows|window\.scrollBy/, 'not scrolling, which does nothing when the list is too short to scroll');
  assert.match(CSS, /\.pa-player\.pa-ovfocus \{ box-shadow: 0 6px 12px rgba\(0,0,0,\.12\); \}/, 'the grown player reads as a panel over the rows');
  assert.doesNotMatch(CSS.slice(CSS.indexOf('.pa-ovwrap {'), CSS.indexOf('.pa-ovwrap {') + 200), /transition: height/, 'instant: a growth the eye can follow is one the finger has to chase');
  const sx = SEGX.slice(SEGX.indexOf('function ovFocus(phase, ms)'), SEGX.indexOf('function ovMs(clientX)'));
  assert.match(sx, /var base = parseFloat\(getComputedStyle\(player\)\.marginBottom\) \|\| 0;\s*\n\s*player\.style\.marginBottom = \(base - \(player\.getBoundingClientRect\(\)\.height - h0\)\) \+ 'px';/, 'the listening page does the same');
  assert.match(sx, /if \(player\) \{ player\.style\.marginBottom = p\.playerMargin; player\.style\.boxShadow = p\.shadow; \}/, 'everything put back on release');
  assert.doesNotMatch(SEGX, /window\.scrollBy/);
  assert.doesNotMatch(SEGX, /#ov \{[^}]*transition: height/);
  assert.equal((I18N.match(/\n    ,'panel\.rel\.new\.scrubJump': '/g) || []).length, 2);
});

test('a waveform with no width yet cannot throw a non-finite seek', () => {
  const sx = SEGX.slice(SEGX.indexOf('function wireScrub(el, s, e)'), SEGX.indexOf('wireScrub(ov, 0, totalMs);'));
  assert.match(sx, /if \(span > 0 && isFinite\(ms\)\) audio\.currentTime = ms \/ 1000;/);
  assert.match(sx, /return isFinite\(ms\) \? ms : null;/);
  assert.match(sx, /var ms = seek\(ev\); if \(ms == null\) return;/, 'and no close-up is opened on a NaN');
  const pat = UI.slice(UI.indexOf('function wireScrub(el, s, e)'), UI.indexOf('function playSpan(s, e)'));
  assert.match(pat, /if \(!isFinite\(ms\)\) return null;/, 'the tool guards the same way');
});

test('the listening page\'s touch grammar is the editor\'s, scrolling/scrubbing/zooming only — never editing', () => {
  const sx = SEGX.slice(SEGX.indexOf('function wireScrub(el, s, e)'), SEGX.indexOf('wireScrub(ov, 0, totalMs);'));
  // A finger: a tap parks, a drag anywhere else scrolls, the playhead line scrubs.
  assert.match(sx, /if \(ev\.pointerType === 'touch'\) \{/);
  assert.match(sx, /Math\.abs\(e2\.clientX - x0\) < 10 && Math\.abs\(e2\.clientY - y0\) < 10\) \{ audio\.pause\(\); seek\(e2\); \}/, 'a tap parks and pauses');
  assert.match(sx, /if \(down && ev\.pointerType !== 'touch'\) drag\(ev\);/, 'no touch scrubbing on the canvas');
  assert.match(sx, /knob\.addEventListener\('pointerdown'/, 'the playhead line is the scrubber');
  assert.match(SEGX, /\.rw \{[^}]*touch-action: pan-y; \}/);
  assert.match(SEGX, /\.cur \{ width: 32px; margin-left: -15px; background: transparent; pointer-events: auto; touch-action: none;/);
  // Placing the playhead pauses, on a mouse as well (the editor's rule since 2026-08-13).
  assert.match(sx, /audio\.pause\(\);\s*\n\s*seek\(ev\);/, 'a mouse click pauses too (v604)');
  // The overview: tap places, drag scrolls when zoomed, pinch zooms, trackpad pinch zooms.
  const ov = SEGX.slice(SEGX.indexOf('var touches = {}, count = 0'), SEGX.indexOf('/* ── SPACE = PLAY/PAUSE'));
  assert.match(ov, /if \(mode === 'tap' && ev\.type === 'pointerup'\) \{ audio\.pause\(\); audio\.currentTime = ovMs\(ev\.clientX\) \/ 1000; \}/);
  assert.match(ov, /if \(mode === 'scroll'\) \{ ovWrap\.scrollLeft = scroll0 - dx; ev\.preventDefault\(\); \}/);
  assert.match(ov, /mode = 'pinch'; dist0 = dist\(p\); z0 = ovZoom;/);
  assert.match(ov, /if \(!ev\.ctrlKey\) return; ev\.preventDefault\(\); setOvZoom\(ovZoom \* Math\.exp\(-ev\.deltaY \* 0\.005\)/);
  // Editing grammar is deliberately absent (Seth, 2026-09-07).
  assert.doesNotMatch(SEGX, /seg-edge|attachEdgeHandles|makeBoundaryDrag|boundaryLive/, 'nothing on the page adjusts a boundary');
});
