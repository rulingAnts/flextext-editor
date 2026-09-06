// Dragging a boundary (Seth, 2026-09-06): grips at each end of a strip's waveform on the Cut,
// Baseline and Gloss tabs, and movable cut marks on the Cut tab's top player, all under one setting
// (adjustBoundaries) that is independent of "cut or join lines that already have text".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { moveBoundary, MIN_SEGMENT_MS } from '../docs/js/segments.js';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const STRIPS = readFileSync(new URL('../docs/js/segment-strips.js', import.meta.url), 'utf8');
const AUDIO = readFileSync(new URL('../docs/js/audio.js', import.meta.url), 'utf8');
const PANEL = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../docs/css/app.css', import.meta.url), 'utf8');

const segs = () => [{ start: 0, end: 1000 }, { start: 1000, end: 2000 }, { start: 2000, end: 3000 }];

test('moveBoundary: the seam moves, both sides together, never past a neighbour, the text untouched', () => {
  const r = moveBoundary(segs(), 0, 1400);
  assert.equal(r.ok, true); assert.equal(r.t, 1400);
  assert.deepEqual(r.segments.map((s) => [s.start, s.end]), [[0, 1400], [1400, 2000], [2000, 3000]]);
  assert.equal(moveBoundary(segs(), 0, 5000).t, 2000 - MIN_SEGMENT_MS, 'clamped to the next line\'s end minus the floor');
  assert.equal(moveBoundary(segs(), 0, -5000).t, 0 + MIN_SEGMENT_MS, 'clamped to its own start plus the floor');
  assert.equal(moveBoundary(segs(), 1, 2000).ok, false, 'no movement is reported as such, so a drag at the stop does not churn');
  const a = segs(); const r2 = moveBoundary(a, 0, 1400);
  assert.equal(a[0].end, 1000, 'the input is not mutated; the caller applies the result');
  assert.equal(r2.segments[0].end, 1400);
});

test('moveBoundary refuses what it cannot know', () => {
  assert.equal(moveBoundary([{ start: 0, end: 1000 }, { timePending: true }], 0, 500).reason, 'pending', 'a seam next to a line without a time');
  assert.equal(moveBoundary(segs(), 2, 2500).reason, 'pending', 'the last line has no seam after it');
  assert.equal(moveBoundary(segs(), 0, NaN).reason, 'time');
  assert.equal(moveBoundary([{ start: 0, end: 120 }, { start: 120, end: 240 }], 0, 130).reason, 'room', 'no room to move: each side is already exactly the floor');
  const est = [{ start: 0, end: 1000 }, { start: 1000, end: 2000, timeEstimated: true }];
  assert.equal('timeEstimated' in moveBoundary(est, 0, 1200).segments[1], false, 'a seam placed by hand is no longer a guess');
});

test('the Player numbers marks by SEAM, so a line without a time mid-text cannot shift the drag onto the wrong seam', () => {
  assert.match(AUDIO, /this\._bounds = Array\.isArray\(list\) \? list\.map\(\(n\) => \(Number\.isFinite\(n\) \? n : NaN\)\) : \[\];/, 'setBoundaries keeps positions');
  assert.match(AUDIO, /this\._bounds\.map\(\(ms, j\) => \(\{ ms, j \}\)\)\.filter\(\(\{ ms \}\) => \{\s*\n\s*if \(!Number\.isFinite\(ms\)\) return false;/, 'undrawable seams are skipped but keep their number');
  assert.match(AUDIO, /drag\(j, null, 'start'\);/); assert.match(AUDIO, /drag\(j, t - grab, 'move'\)/); assert.match(AUDIO, /drag\(j, null, 'end'\);/);
  assert.match(AUDIO, /el\.dataset\.bi = String\(j\);/, 'the reuse path too');
  assert.match(STRIPS, /marks\.push\(isAligned\(s\) \? s\.end : NaN\);/, 'the Cut tab pushes one entry per seam');
  assert.match(APP, /out\.push\(sp\.timePending \? NaN : sp\.end\);/, 'and so does the matcher');
  assert.match(STRIPS, /p\.boundaryCount\(\) !== want\.filter\(Number\.isFinite\)\.length/, 'the Cut ticker compares drawn marks with drawable seams');
  assert.match(APP, /p\.boundaryCount\(\) !== want\.filter\(Number\.isFinite\)\.length/, 'the matcher ticker too');
  assert.doesNotMatch(AUDIO, /createElement\('b'\)/, 'no pill on a mark (Seth, 2026-09-06: "draggable pills on the overview player are no good")');
  assert.match(AUDIO, /matchMedia\('\(pointer: coarse\)'\)\.matches\) \{ hit\.style\.left = '-16px'; hit\.style\.width = '32px'; \}/, '32px on a touch screen');
});

test('one gesture, one consumer, three tabs and the top player, one switch', () => {
  const attach = STRIPS.slice(STRIPS.indexOf('export function attachEdgeHandles(row, wave, i, ctx)'), STRIPS.indexOf('export function makeBoundaryDrag(o)'));
  assert.match(attach, /if \(!row \|\| !wave \|\| !ctx \|\| !\(ctx\.allowed && ctx\.allowed\(\)\)\) return;/, 'no grip unless the setting allows');
  assert.match(attach, /if \(bi < 0 \|\| bi >= n - 1\) continue;/, 'the recording\'s own ends are not seams');
  assert.match(attach, /if \(!isAligned\(ctx\.segAt\(bi\)\) \|\| !isAligned\(ctx\.segAt\(bi \+ 1\)\)\) continue;/, 'no grip on a seam without times');
  assert.match(attach, /ev\.preventDefault\(\); ev\.stopPropagation\(\);/, 'not a seek, not a row select');
  assert.match(attach, /const perPx = Math\.max\(1, seg\.end - seg\.start\) \/ \(wave\.clientWidth \|\| 1\);/, 'scale frozen at pick-up');
  const drag = STRIPS.slice(STRIPS.indexOf('export function makeBoundaryDrag(o)'), STRIPS.indexOf('let stripsDragFn = null;'));
  assert.match(drag, /if \(o\.capture\) o\.capture\(\);\s*\n\s*seam = bi;/, 'one undo per drag, at pick-up');
  assert.match(drag, /const r = moveBoundary\(segs, bi, ms\);\s*\n\s*if \(!r\.ok\) return;\s*\n\s*segs\[bi\]\.end = r\.t;\s*\n\s*segs\[bi \+ 1\]\.start = r\.t;/, 'the live objects move in place');
  assert.match(drag, /if \(o\.persist\) o\.persist\(\);\s*\n\s*if \(o\.onEnd\) o\.onEnd\(bi\);/, 'one persist on release');
  assert.match(STRIPS, /attachEdgeHandles\(row, wave, i, cutEdgeCtx\(segs\)\);/, 'Cut rows');
  assert.match(STRIPS, /attachEdgeHandles\(row, wave, i, stripsEdgeCtx\(segs\)\);/, 'Baseline rows');
  assert.match(APP, /attachEdgeHandles\(waveWrap, wave, i, \{ allowed: adjustBoundariesAllowed,/, 'Gloss rows');
  assert.doesNotMatch(STRIPS, /onBoundaryDrag\(/, 'the editor never makes the top player\'s marks draggable (Seth, 2026-09-06: grips on the strips only)');
  assert.doesNotMatch(APP.slice(0, APP.indexOf('function mgPrepareAudio')), /onBoundaryDrag\(/, 'nor does any editor tab; only the segmenter\'s matcher arms it');
  assert.match(APP, /function adjustBoundariesAllowed\(\) \{ return segmentationEnabled\(\) && settings\.adjustBoundaries !== false; \}/, 'default on, gated on segmentation');
  assert.doesNotMatch(APP.slice(APP.indexOf('function adjustBoundariesAllowed()'), APP.indexOf('function adjustBoundariesAllowed()') + 200), /cutJoinTexted/, 'independent of the texted-lines switch');
  assert.match(APP, /allowAdjust: \(\) => adjustBoundariesAllowed\(\),\n/, 'handed to the strips as a function, so a push lands mid-session');
  assert.match(APP, /\+ \(adjustBoundariesAllowed\(\) \? 'Drag' : ''\)/, 'the Cut hint says so only when it is true');
});

test('the setting, its words and its release note', () => {
  const FIELD = "{ k: 'adjustBoundaries', type: 'checkbox', note: 'panel.f.adjustBoundariesNote' },";
  const DEF = "else if (f.k === 'adjustBoundaries') v.adjustBoundaries = s.adjustBoundaries !== false;";
  for (const [name, src] of [['app.js', APP], ['researcher-panel.js', PANEL]]) {
    assert.ok(src.includes(FIELD), `${name}: field`); assert.ok(src.includes(DEF), `${name}: default on`);
  }
  assert.match(APP, /'cutJoinTexted', 'adjustBoundaries', 'exportEaf'/, 'reported to the panel');
  for (const k of ['panel.f.adjustBoundaries', 'panel.f.adjustBoundariesNote', 'seg.dragEdge', 'cut.hintDrag', 'cut.hintNoJoinKeyDrag']) {
    assert.equal((I18N.match(new RegExp(`\n  '${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  }
  assert.equal((I18N.match(/\n    ,'panel\.rel\.new\.adjustBoundaries': '/g) || []).length, 2, 'release note in EN and ID');
  assert.match(PANEL, /\{ v: 'v591', date: '2026-09-06', items: \[\n    \{ k: 'panel\.rel\.new\.adjustBoundaries' \},\n  \] \},/);
  assert.match(CSS, /\.seg-edge \{ position: absolute; width: 14px; cursor: col-resize; touch-action: none;/);
  assert.match(CSS, /\.seg-edge::before \{ content: ''; /, 'a grip you can see');
  assert.match(CSS, /@media \(pointer:coarse\) \{\n  \.seg-edge \{ width: 32px; \}/, 'a thumb-sized zone on a touch screen');
});
