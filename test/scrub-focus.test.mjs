// Seth, 2026-09-07: edge ✂ on the Gloss tab, and the dock's momentary close-up while a strip is scrubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), STRIPS = rd('../docs/js/segment-strips.js'), SEGX = rd('../docs/js/seg-exports.js');
const CSS = rd('../docs/css/app.css'), I18N = rd('../docs/js/i18n.js'), PANEL = rd('../docs/js/researcher-panel.js');

test('Gloss tab: a timed line has a ✂ before its first word and after its last; the translation lands at the same edge', () => {
  assert.match(APP, /if \(firstCell && isAligned\(edgeSeg\) && !wordRow\.querySelector\('\.edge-scissors'\)\) \{/, 'only a timed line, and only once');
  assert.match(APP, /firstCell\.insertAdjacentElement\('beforebegin', mkEdge\(0, 'gloss\.edgeStartTip'\)\);/);
  assert.match(APP, /cells\[cells\.length - 1\]\.insertAdjacentElement\('afterend', mkEdge\(cells\.length, 'gloss\.edgeEndTip'\)\);/);
  const edge = APP.slice(APP.indexOf('function glossPlaceEdge(i, gap)'), APP.indexOf('function glossPlaceAudio()'));
  assert.match(edge, /const r = glossPlace\(i, 'words', gap\);\s*\n\s*if \(r === 'pending'\) glossPlace\(i, 'free', gap >= n \? String\(phrase\.free \|\| ''\)\.length : 0\);/, 'the translation only while the split is still pending');
  assert.match(APP, /glossPlaceEdge\(i, 0\);\s*\/\/ an empty line BEFORE this one/, 'Enter at the start of the translation goes the same way');
  assert.match(APP, /glossPlaceEdge\(i, wordCount\(\)\);\s*\/\/ an empty line AFTER this one/);
  assert.match(APP, /b\.classList\.toggle\('split-placed', has\('words'\) && \+b\.dataset\.gap === p\.pos\.words\);/, 'the placed gap is marked');
  for (const k of ['gloss.edgeStartTip', 'gloss.edgeEndTip']) assert.equal((I18N.match(new RegExp(`\n  '${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  assert.match(CSS, /\.word-row \.edge-scissors \{ align-self: center; margin: 0 4px; border-style: dashed; \}/);
});

test('scrubbing a strip opens the dock\'s close-up on the first move, follows, and closes on release; a click never flashes it', () => {
  const fn = STRIPS.slice(STRIPS.indexOf('export function wireWaveSeek('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /wave\.__focus = \(phase, ms\) => \{ try \{ getPlayer\(\)\?\.boundaryFocus\?\.\(phase, ms\); \} catch \{[^}]*\} \};/, 'the same Player.boundaryFocus the grips use');
  assert.match(body, /const move = \(e2\) => \{ const ms = seekAt\(e2\); wave\.__focus\(dragged \? 'move' : 'start', ms\); dragged = true; \};/);
  assert.match(body, /if \(dragged\) wave\.__focus\('end'\); \};/);
  const touch = body.slice(body.indexOf("ev.pointerType === 'touch'"), body.indexOf('ev.preventDefault();'));
  assert.doesNotMatch(touch, /__focus/, 'a tap never opens it');
  const knob = STRIPS.slice(STRIPS.indexOf('function installKnobDrag()'), STRIPS.indexOf('export function wireWaveSeek('));
  assert.match(knob, /if \(dragged\) wave\.__focus\?\.\('end'\); \};/, 'the finger on the playhead line gets the same close-up');
  assert.equal((I18N.match(/\n    ,'panel\.rel\.new\.scrubFocus': '/g) || []).length, 2);
  assert.equal((I18N.match(/\n    ,'panel\.rel\.new\.edgeScissors': '/g) || []).length, 2);
  assert.match(PANEL, /\{ v: 'v598', date: '2026-09-07', items: \[\s*\n\s*\{ k: 'panel\.rel\.new\.patSplit' \},\s*\n\s*\{ k: 'panel\.rel\.new\.edgeScissors' \},\s*\n\s*\{ k: 'panel\.rel\.new\.scrubFocus' \},/);
});

test('the listening page keeps parity: a row scrub opens the overview\'s close-up, the overview\'s own scrub does not', () => {
  const scrub = SEGX.slice(SEGX.indexOf('function wireScrub(el, s, e)'), SEGX.indexOf('wireScrub(ov, 0, totalMs);'));
  assert.match(scrub, /function drag\(ev\) \{ var ms = seek\(ev\); if \(el !== ov\) ovFocus\(dragged \? 'move' : 'start', ms\); dragged = true; \}/);
  assert.match(scrub, /function release\(\) \{ if \(dragged && el !== ov\) ovFocus\('end'\); dragged = false; \}/);
  assert.match(scrub, /window\.addEventListener\('pointerup', function \(\) \{ if \(down\) release\(\); down = false; \}\);/);
  assert.match(scrub, /var move = function \(e2\) \{ drag\(e2\); \};/, 'the knob too');
  const focus = SEGX.slice(SEGX.indexOf('function ovFocus(phase, ms)'), SEGX.indexOf('(function () {\n    var touches'));
  assert.match(focus, /setOvZoom\(Math\.max\(ovZoom, T \/ 4000\), ms,/, 'about four seconds across, as the editor\'s FOCUS_WINDOW_S');
  assert.match(focus, /ovWrap\.scrollLeft = \(ms \/ T\) \* ov\.clientWidth - ovWrap\.clientWidth \/ 2;/, 'the playhead centred');
  assert.match(focus, /setOvZoom\(p\.z, 0, ovWrap\.getBoundingClientRect\(\)\.left\); ovWrap\.scrollLeft = p\.scroll;/, 'zoom and scroll put back');
});

test('the seam being dragged is a thick dashed blue mark on the dock, distinct from the red playhead; at rest the thin dotted one (Seth, 2026-09-07)', () => {
  const AUDIO = rd('../docs/js/audio.js');
  const style = AUDIO.slice(AUDIO.indexOf('function styleMark(el, live)'), AUDIO.indexOf('function styleMark(el, live)') + 900);
  assert.match(style, /el\.style\.borderLeft = '4px dashed #2f7cf6';/, 'thick, dashed, blue');
  assert.match(style, /el\.style\.marginLeft = '-2px';/, 'centred on the seam');
  assert.match(style, /el\.style\.boxShadow = '0 0 0 1px rgba\(255,255,255,\.85\), 0 0 8px 2px rgba\(47,124,246,\.6\)';/, 'a halo and a glow');
  assert.match(style, /el\.style\.borderLeft = '1px dotted rgba\(108,118,133,\.7\)';/, 'the resting mark is unchanged');
  assert.match(AUDIO, /cursorColor: '#c0392b',\s*\n\s*cursorWidth: 2,/, 'the playhead stays thin, solid and red');
  assert.match(AUDIO, /boundaryLive\(j\) \{\s*\n\s*this\._liveSeam = \(j == null\) \? null : j;/);
  assert.match(AUDIO, /styleMark\(el, this\._liveSeam === j\);\s*\n\s*\}\);\s*\n\s*return;/, 'the reuse path (every move) keeps the live style');
  assert.match(AUDIO, /styleMark\(b, this\._liveSeam === j\);/, 'and a rebuild restores it');
  const drag = STRIPS.slice(STRIPS.indexOf('export function makeBoundaryDrag(o)'), STRIPS.indexOf('export function overviewMarks(segs)'));
  assert.match(drag, /p\?\.boundaryLive\?\.\(bi\);/, 'lit at pick-up');
  assert.match(drag, /p\?\.boundaryFocus\?\.\('end'\); \} catch \{[^}]*\}\s*\n\s*try \{ p\?\.boundaryLive\?\.\(null\);/, 'put back on release');
  assert.equal((I18N.match(/\n    ,'panel\.rel\.new\.liveMark': '/g) || []).length, 2);
  assert.match(PANEL, /\{ v: 'v599', date: '2026-09-07', items: \[\s*\n\s*\{ k: 'panel\.rel\.new\.liveMark' \},/);
});
