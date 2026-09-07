// Seth, 2026-09-07: "incorporate segment adjustment handles, scrubbing, and closeup for each in PAT as
// well (and when adjusting or scrubbing, the big preview player gets taller as well)".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const UI = rd('../docs/js/paragraph-ui.js'), CSS = rd('../docs/css/app.css'), I18N = rd('../docs/js/i18n.js'), PANEL = rd('../docs/js/researcher-panel.js');

test('the grips are the editor\'s, with the Join/split switch on; the drag is the editor\'s consumer on a working copy, committed once', () => {
  assert.match(UI, /import \{ splitPlace, splitCancel, splitPending, installSplitCancel, registerCaretScissors, syncCaretScissors, attachEdgeHandles, makeBoundaryDrag \} from '\.\/segment-strips\.js';/);
  assert.match(UI, /if \(wave && joinSplitOn\) \{\s*\n\s*const k = state\.lines\.findIndex\(\(x\) => x\.id === id\);\s*\n\s*attachEdgeHandles\(row\.querySelector\('\.pa-wavewrap'\), wave, k, \{/, 'grips only with the switch on');
  assert.match(UI, /allowed: \(\) => joinSplitOn, count: \(\) => state\.lines\.length, segAt: \(j\) => state\.lines\[j\], t,/);
  assert.match(UI, /capture: \(\) => \{ dragBase = state; dragMoved = false; state = \{ \.\.\.state, lines: state\.lines\.map\(\(l\) => \(\{ \.\.\.l \}\)\) \}; \},/, 'the drag works on a copy');
  assert.match(UI, /if \(dragMoved\) commit\(next\); else renderWork\(\);/, 'one history entry on release, none when nothing moved');
  assert.match(UI, /getPlayer: \(\) => ovPlayer,/, 'the overview stands in for the editor\'s player');
  assert.match(UI, /boundaryLive\(j\) \{ ovLiveSeam = \(j == null\) \? null : j; renderOvMarks\(\); \},/);
  assert.match(UI, /if \(e\.target\.closest && e\.target\.closest\('\.seg-edge'\)\) return;\s*\/\/ a grip drag is not a selection/);
});

test('the overview close-up: about four seconds across, taller, centred; back on release; marks with the dragged seam blue', () => {
  assert.match(UI, /const OV_FOCUS_S = 4;/);
  assert.match(UI, /const OV_FOCUS_PAGES = 3;/, 'three screens drawn, the middle one visible (v608)');
  assert.match(UI, /const OV_FOCUS_H = 96;/);
  const focus = UI.slice(UI.indexOf('function ovFocus(phase, ms)'), UI.indexOf('function ovSeams()'));
  assert.match(focus, /e\.wrap\.style\.height = OV_FOCUS_H \+ 'px';/, 'taller while adjusting or scrubbing');
  assert.match(focus, /ovWin = ovWindowAt\(ms\);\s*\n\s*e\.ov\.style\.width = \(OV_FOCUS_PAGES \* 100\) \+ '%';/, 'zoomed by drawing a bounded window, never a canvas sized by the recording (v608)');
  assert.match(focus, /ovDrawWave\(\); renderOvMarks\(\); ovCenter\(ms\);/, 'the visible middle follows the playhead');
  assert.match(focus, /e\.wrap\.style\.height = p\.height; e\.ov\.style\.width = p\.width;/, 'put back');
  assert.match(focus, /ovWin = null;/, 'and the window is dropped, so the whole recording is drawn again');
  assert.match(UI, /m\.classList\.toggle\('live', ovLiveSeam === s\.j\);/, 'the dragged seam');
  assert.match(UI, /if \(ov\) \{ ovDrawWave\(\); renderOvMarks\(\); \}/, 'marks drawn with the overview, through the window (v608)');
  assert.match(CSS, /\.pa-ovwrap \{ position: relative; height: 34px; flex: 1 1 auto; min-width: 0; overflow-x: auto; overflow-y: hidden;/, 'scrollable, so the close-up\'s extra context can be reached (v608); still no height transition');
  assert.match(CSS, /\.pa-ovmark \{ position: absolute; top: 0; bottom: 0; width: 0; border-left: 1px dotted rgba\(108,118,133,\.7\); \}/);
  assert.match(CSS, /\.pa-ovmark\.live \{ border-left: 2px dashed #2f7cf6; margin-left: -1px; z-index: 1; \}/);
});

test('scrubbing a line\'s waveform opens the close-up on the first move and closes it on release; a click never does', () => {
  const scrub = UI.slice(UI.indexOf('function wireScrub(el, s, e)'), UI.indexOf('function playSpan(s, e)'));
  assert.match(scrub, /ovFocus\(dragged \? 'move' : 'start', ms\);\s*\n\s*dragged = true;/);
  assert.match(scrub, /if \(dragged\) ovFocus\('end'\);/, 'closed by the shared end(), which pointercancel shares (v604)');
  assert.match(scrub, /ev\.preventDefault\(\);\s*\n\s*down = true; dragged = false;/, 'a click alone never opens the close-up: dragged starts false and only a move sets it');
  assert.equal((I18N.match(/\n    ,'panel\.rel\.new\.patAdjust': '/g) || []).length, 2, 'release note in EN and ID');
  assert.match(PANEL, /\{ v: 'v602', date: '2026-09-07', items: \[\s*\n\s*\{ k: 'panel\.rel\.new\.patAdjust' \},/);
});
