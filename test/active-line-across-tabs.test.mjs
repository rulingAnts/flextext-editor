/* THE ACTIVE LINE TRAVELS BETWEEN THE EDITOR'S TABS (Seth, 2026-10-05, #39) — and the settings dialog keeps
 * its own, different rule (#87). Pure rule measured; wiring pinned; both rules pinned side by side. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickActiveLine } from '../docs/js/segments.js';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), PANEL = rd('../docs/js/researcher-panel.js'), I18N = rd('../docs/js/i18n.js');
const fn = (src, name) => { const i = src.indexOf(`function ${name}(`); return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i)); };

test('the line you touched wins, unless the playhead moved since — then where you are listening wins', () => {
  // typing on line 65 while the playhead sits in line 3 untouched since: 65, and the playhead must be moved there
  assert.deepEqual(pickActiveLine({ touched: { i: 65, playheadMs: 3100 }, playheadIdx: 3, playheadMs: 3100, fallback: 0 }), { i: 65, seek: true });
  // you then dragged the overview to line 9: the playhead moved, so 9 wins and needs no seek
  assert.deepEqual(pickActiveLine({ touched: { i: 65, playheadMs: 3100 }, playheadIdx: 9, playheadMs: 9500, fallback: 0 }), { i: 9, seek: false });
  // you pressed ▶ on line 65 and it played a little: same line both ways, no seek
  assert.deepEqual(pickActiveLine({ touched: { i: 65, playheadMs: 65000 }, playheadIdx: 65, playheadMs: 66200, fallback: 0 }), { i: 65, seek: false });
  // the playhead is outside every line (0 on a fresh text): the touched line wins and gets the playhead
  assert.deepEqual(pickActiveLine({ touched: { i: 12, playheadMs: 0 }, playheadIdx: -1, playheadMs: 0, fallback: 0 }), { i: 12, seek: true });
  // nothing touched: the playhead's line, else the topmost visible one, else nothing
  assert.deepEqual(pickActiveLine({ touched: null, playheadIdx: 4, playheadMs: 4000, fallback: 20 }), { i: 4, seek: false });
  assert.deepEqual(pickActiveLine({ touched: null, playheadIdx: -1, playheadMs: null, fallback: 20 }), { i: 20, seek: false });
  assert.equal(pickActiveLine({ touched: null, playheadIdx: -1, playheadMs: null, fallback: -1 }), null);
  assert.equal(pickActiveLine(), null);
});

test('switchTab measures on the tab being left and lands the new tab on the line', () => {
  const sw = fn(APP, 'switchTab');
  assert.match(sw, /const fromTab = activeTab;[^\n]*\n[^\n]*\n\s+const carry = landing \? null : activeLineOnLeave\(fromTab\);\n\s+activeTab = tab;\n\s+if \(carry\) setTimeout\(\(\) => landOnLine\(tab, carry\), 0\);/, 'measured before activeTab changes and before any render; a landing keeps v360\'s rule');
  const leave = fn(APP, 'activeLineOnLeave');
  assert.match(leave, /pickActiveLine\(\{ touched: touchedLine, playheadIdx: segIndexAt\(docSegments\(doc\), at\), playheadMs: Number\.isFinite\(at\) \? at : null, fallback: topmostVisibleLine\(fromTab\) \}\)/);
  const land = fn(APP, 'landOnLine');
  assert.match(land, /if \(!row \|\| !row\.offsetParent\) \{ if \(tries < 40\) setTimeout\(\(\) => landOnLine\(tab, pick, tries \+ 1\), 100\); return; \}/, 'retries while the tab is still preparing its rows');
  assert.match(land, /activeTab !== tab/, 'a quicker second switch cancels the landing');
  assert.match(land, /if \(pick\.seek && seg && isAligned\(seg\)\) \{\n\s+const at = player\?\.playheadMs\?\.\(\);\n\s+if \(!\(typeof at === 'number' && at >= seg\.start && at < seg\.end\)\) player\?\.seekMs\?\.\(seg\.start\);/, 'the playhead is moved into the line only when the choice came from typing and it is not already there');
  const place = fn(APP, 'placeRowUnderDock');
  assert.match(place, /sc\.scrollTop \+= row\.getBoundingClientRect\(\)\.top - sc\.getBoundingClientRect\(\)\.top - dockHeadroom\(\) - 10;/, 'scrollTop on the one scroller, under the sticky dock');
  assert.match(place, /if \(dock && !dock\.hidden\) sc\.scrollTop \+= row\.getBoundingClientRect\(\)\.top - dock\.getBoundingClientRect\(\)\.bottom - 10;/, 'second pass against the dock\'s REAL stuck edge (measured 2 px under it on the first cut)');
  assert.match(land, /for \(const ms of \[150, 400, 900\]\) \{\n\s+setTimeout\(\(\) => \{\n\s+if \(activeTab !== tab \|\| userScrolledAt > landedAt\) return;/, 'settles the row as the Gloss groups grow (measured 204 px of drift), yielding to a person who scrolls');
  assert.match(APP, /for \(const ev of \['wheel', 'touchmove'\]\) document\.addEventListener\(ev, \(\) => \{ userScrolledAt = Date\.now\(\); \}, \{ passive: true \}\);/);
  assert.doesNotMatch(land + place, /scrollIntoView/, 'never scrollIntoView (it scrolls every ancestor)');
  assert.match(APP, /document\.addEventListener\('focusin', \(e\) => noteTouchedLine\(e\.target\)\);\n\s+document\.addEventListener\('pointerdown', \(e\) => noteTouchedLine\(e\.target\), \{ passive: true, capture: true \}\);/);
  assert.match(fn(APP, 'noteTouchedLine'), /closest\('#segment-strips \.seg-strip, #cut-strips \.cut-row, #gloss-body \.segment'\)/, 'rows of all three tabs');
  assert.match(fn(APP, 'rowForLine'), /tab === 'gloss'\) return \(\$\('#gloss-body'\) \? \$\('#gloss-body'\)\.querySelectorAll\('\.segment'\) : \[\]\)\[i\]/, 'Gloss groups are addressed by order (1:1 with lines)');
});

test('…and the settings dialog keeps its OWN rule: every tab starts at the top (#87) — the two are distinct', () => {
  assert.match(fn(PANEL, 'showSettingsTab'), /scrollTop = 0/, 'the panel\'s settings dialog resets its scroll box on a tab change');
  assert.doesNotMatch(fn(APP, 'switchTab'), /scrollTop = 0/, 'the editor\'s tab switch never resets to the top');
  assert.match(APP, /THIS IS THE EDITOR'S RULE, NOT THE SETTINGS DIALOG'S/, 'said so where the next person will look');
  for (const k of ['panel.rel.fix.activeLineTabs']) assert.equal((I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  assert.match(PANEL, /\{ v: 'v703', date: '2026-10-05', items: \[\n    \{ k: 'panel\.rel\.fix\.activeLineTabs', issue: 39 \},/);
});
