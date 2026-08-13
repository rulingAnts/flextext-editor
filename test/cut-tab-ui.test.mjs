/* THE CUT TAB'S SCREEN: one overview, clickable strips, and a view that stays put.
 *
 * Everything here is a STRUCTURAL check over the sources, in the style of strip-ticker.test.mjs —
 * the Cut tab is DOM and rAF, so there is no pure model to assert against. That limitation is
 * exactly why these particular things are pinned: every one of them shipped broken in v354–v356 and
 * was only found by Seth on a real device, because nothing on this side could see it.
 *
 *   - TWO whole-file waveforms were drawn (the dock player and a second one the tab made itself),
 *     so there were two zoom states and two places to click for the same audio.
 *   - The per-segment strips were wired to NOTHING, so the playhead could only be placed on the
 *     whole-file waveform — far too coarse to cut a phrase by.
 *   - Every cut rebuilt the list, which collapsed the page height and threw the scroll to the top.
 *   - Grey meant nothing: locked (texted) spans looked exactly like cuttable ones.
 *
 * Run: node test/cut-tab-ui.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const strips = read('docs/js/segment-strips.js');
const audio = read('docs/js/audio.js');
const app = read('docs/js/app.js');
const html = read('docs/index.html');
const css = read('docs/css/app.css');
const i18n = read('docs/js/i18n.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const fn = (src, name) => {
  const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  return m ? m[0] : '';
};
// Player's are class METHODS (no `function` keyword), closed by a brace at the class's indent.
const method = (src, name) => {
  const m = src.match(new RegExp(`\\n  ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`));
  return m ? m[0] : '';
};

console.log('\nONE whole-file waveform on the screen, and it is the dock player\'s');
ok(!/id="cut-big"/.test(html), 'the tab\'s own overview element is gone from the markup');
ok(!/drawCutOverview/.test(strips), 'and so is the function that drew it');
ok(!/\.cut-ov-wave\s*\{/.test(css) && !/\.cut-big\s*\{/.test(css), 'and its CSS rules with it');
// The dock player is OUTSIDE the view sections precisely so it can serve every editor tab.
ok(/id="audio-player"/.test(html), 'the shared dock player is still the one player');

console.log('\nthe cuts already made are drawn ON that player, in per cent so zoom cannot desync them');
ok(/setBoundaries\(list\)/.test(audio), 'Player.setBoundaries exists');
const rb = method(audio, 'renderBoundaries');
ok(!!rb, 'Player.renderBoundaries exists');
ok(/getWrapper/.test(rb), 'the marks go inside wavesurfer\'s own wrapper (which scrolls and zooms with the wave)');
ok(/left = \(f \* 100\) \+ '%'/.test(rb), 'positioned in PER CENT, not pixels');
ok(/pointer-events:none/.test(rb), 'and they never intercept a click — the whole wave stays a seek surface');
ok(/border-left:2px dotted/.test(rb) && /rgba\(108,118,133/.test(rb),
   'light grey, dotted, 2px — visible without crowding the waveform (Seth)');
ok(/this\.renderBoundaries\(\);/.test(audio.match(/this\.ws\.on\('ready'[\s\S]*?\}\);/)[0]),
   're-drawn on ready, so marks set before the audio loaded are not lost to the race');
ok(/syncCutBoundaries\(\)/.test(strips) && /p\.setBoundaries\(marks\)/.test(strips),
   'the Cut tab pushes its boundaries to the player');
const stop = fn(strips, 'stopCut');
ok(/setBoundaries\?\.\(\[\]\)/.test(stop), 'and leaving the tab takes them off again — Baseline and Gloss are untouched');

console.log('\nthe per-segment strips are clickable: that is how a cut is placed at all');
ok(/export function wireWaveSeek/.test(strips), 'the click-to-position/drag-to-scrub wiring is one shared helper');
const render = strips.match(/export function renderCut\(anchorIdx\) \{[\s\S]*?\n\}/)[0];
ok(/wireWaveSeek\(wave, seg, cutDeps\.getPlayer/.test(render), 'the Cut tab strips use it');
ok(/wireWaveSeek\(wave, seg, deps\.getPlayer/.test(strips), 'and so do the Baseline strips — one behaviour, not two');
ok(/seekMs\?\.\(seg\.start \+ f \* \(seg\.end - seg\.start\)\)/.test(strips),
   'a click maps to a time INSIDE that segment\'s own span');

console.log('\nplayback runs THROUGH the boundaries — on the Cut tab, and only there');
const pt = method(audio, 'playThrough');
ok(!!pt && /this\.clearSpan\(\)/.test(pt) && !/_spanTick/.test(pt),
   'playThrough plays with no span watcher, so nothing pauses it at a cut');
ok(/p\.playThrough\(from\)/.test(strips), 'a Cut row\'s ▶ plays through');
ok(/export function cutTogglePlay/.test(strips) && /p\.playThrough\(\);/.test(strips), 'and so does Space');
const wsp = strips.match(/export function wireSegPlay[\s\S]*?\n\}/)[0];
ok(/playSpan\(from, seg\.end, seg\.start\)/.test(wsp),
   'the Baseline/Gloss transport still stops at the end of its line (playSpan) — unchanged');
ok(/lastPlayTarget = null;/.test(app.match(/if \(tab === 'cut'\) \{[\s\S]*?prepareCutAudio\(\);/)[0]),
   'and no span target is left behind on the Cut tab, so ⏮ and Space cannot re-introduce one');

console.log('\nSpace plays and pauses wherever focus is (it is almost always on a button here)');
const cutKeys = app.match(/if \(activeTab !== 'cut' \|\| \$\('#view-cut'\)\?\.hidden\) return;[\s\S]*?\}\);/)[0];
ok(/e\.key === ' ' && !e\.repeat.*preventDefault\(\); cutTogglePlay\(\)/.test(cutKeys),
   'the Cut tab handles Space itself, with preventDefault so a focused button cannot also fire');
ok(/if \(activeTab === 'cut' && !\$\('#view-cut'\)\?\.hidden\) return;/.test(app),
   'and the global Space handler stands down there, so the two cannot double-toggle');

console.log('\nEnter cuts, Backspace joins ONLY when the researcher allows the key');
ok(/e\.key === 'Enter'.*cutHere\(\)/.test(cutKeys), 'Enter cuts');
ok(/e\.key === 'Backspace'.*!joinKeysEnabled\(\).*cutJoinPrev\(\)/.test(cutKeys),
   'Backspace joins only when backspaceJoin is on (Seth: "backspace if backspace to join is enabled")');
ok(/j\.addEventListener\('click', \(\) => cutJoinPrev\(i \+ 1\)\)/.test(render),
   'the ⤙⤚ buttons join regardless — the setting removes a shortcut, never the capability');
for (const k of ['cut.hint', 'cut.hintNoJoinKey']) {
  ok((i18n.match(new RegExp(`'${k}':`, 'g')) || []).length === 2, `${k} exists in both languages`);
}
ok(/hint\.dataset\.i18nHtml = joinKeysEnabled\(\) \? 'cut\.hint' : 'cut\.hintNoJoinKey'/.test(app),
   'and the hint names the key only when the key works');

console.log('\ngrey means LOCKED, and nothing else');
ok(/const LOCKED_WAVE = /.test(strips), 'there is one colour for a span that cannot be cut');
ok(/color: text \? LOCKED_WAVE : null/.test(render), 'a strip is grey exactly when it carries text');
ok(/g\.fillStyle = \(opts && opts\.color\) \|\| '#1f4f8f';/.test(strips),
   'and drawStrip honours it, defaulting to the working blue');
ok(/row\.classList\.add\('cut-locked'\)/.test(render) && /\.cut-row\.cut-locked/.test(css),
   'the row recedes to match, so the refusal is legible before it is tried');

console.log('\na cut or a join does not throw the user back to the top of the recording');
ok(/const keepTop = scroller \? scroller\.scrollTop : 0;/.test(render), 'the scroll offset is read BEFORE the rebuild');
ok(render.indexOf('keepTop') < render.indexOf('host.replaceChildren()'),
   'which is the only order that works — emptying the list is what collapses the height');
ok(/scroller\.scrollTop = keepTop;/.test(render), 'and restored after');
ok(/getBoundingClientRect\(\)\.top - anchorTop/.test(render),
   'plus the edited row\'s own pixel, so the view holds even when heights changed above it');
ok(/renderCut\(at\);/.test(strips) && /renderCut\(Math\.max\(0, i - 1\)\)/.test(strips),
   'cut anchors on the row it cut; join anchors on the row that survived');

console.log(fail ? `\nFAILED (${fail})` : '\nPASSED');
process.exit(fail ? 1 : 0);
