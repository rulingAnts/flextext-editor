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
ok(/syncCutBoundaries\(\)/.test(strips) && /p\.setBoundaries\(cutBoundaryTimes\(\)\)/.test(strips),
   'the Cut tab pushes its boundaries to the player');
const stop = fn(strips, 'stopCut');
ok(/setBoundaries\?\.\(\[\]\)/.test(stop), 'and leaving the tab takes them off again — Baseline and Gloss are untouched');

/* ── the marks' LIFETIME. Both halves were found by the v357 preflight review, and the first was
 * the only finding two independent verifiers refused to refute: boundary times mean nothing outside
 * the recording they were measured in, and this Player is a singleton reused for every document. */
ok(/this\._bounds = \[\];/.test(method(audio, 'destroyWs')),
   'a destroyed waveform forgets its marks, so doc A\'s cuts cannot be painted on doc B');
ok(/boundaryCount\(\)/.test(audio) && /p\.boundaryCount\(\) !== want\.length/.test(strips),
   'and the ticker re-pushes them if a player reload took them away — nothing else would');

console.log('\nthe per-segment strips are clickable: that is how a cut is placed at all');
ok(/export function wireWaveSeek/.test(strips), 'the click-to-position/drag-to-scrub wiring is one shared helper');
const render = strips.match(/export function renderCut\(anchorIdx\) \{[\s\S]*?\n\}/)[0];
ok(/wireWaveSeek\(wave, seg, cutDeps\.getPlayer/.test(render), 'the Cut tab strips use it');
ok(/wireWaveSeek\(wave, seg, deps\.getPlayer/.test(strips), 'and so do the Baseline strips — one behaviour, not two');
ok(/seekMs\?\.\(seg\.start \+ f \* \(seg\.end - seg\.start\)\)/.test(strips),
   'a click maps to a time INSIDE that segment\'s own span');
ok(/wireWaveSeek\(wave, \(\) => player|wireWaveSeek\(wave, seg, \(\) => player/.test(app),
   '…and so does the GLOSS tab, which had its own copy until the pause behaviour needed writing twice');

/* ── PLACING THE PLAYHEAD STOPS PLAYBACK (Seth, 2026-08-13), everywhere a playhead can be placed:
 * the strips on all three tabs, and the whole-file player. A click that moved the playhead and then
 * ran on from it slid the spot away before the user could cut at it. */
const seekWire = strips.match(/export function wireWaveSeek[\s\S]*?\n\}/)[0];
ok(/getPlayer\(\)\?\.pause\?\.\(\);/.test(seekWire), 'a click on any strip waveform pauses first');
ok(/onSeekInteraction/.test(audio) && /this\.ws\.on\('interaction'/.test(audio),
   'the dock player reports the USER\'s own seeks through onSeekInteraction');
ok(!/this\.ws\.on\('seeking'/.test(audio),
   '…via \'interaction\', which fires ONLY for a click or drag — \'seeking\' would also catch our own seekMs calls');
ok(/onSeekInteraction: \(\) => \{ player\?\.pause\?\.\(\); requestReveal\(\); \}/.test(app),
   'and the editor answers it by pausing and asking for the line to be revealed');

/* ── "TAKE ME TO THAT LINE" (Seth): a seek on the whole-file player scrolls the row for that instant
 * into the middle, if it is off screen. Each tab's ticker already knows which row that is, so the
 * request is honoured by all three rather than reimplemented a fourth time. */
ok(/export function requestReveal/.test(strips) && /function takeReveal/.test(strips),
   'the reveal is a REQUEST the tickers honour, not a scroll issued from the player');
ok((strips.match(/takeReveal\(/g) || []).length >= 4,
   'and all three tickers honour it — baseline strips, cut rows and gloss groups');
ok(/Date\.now\(\) - revealAt > 1500/.test(strips),
   'it expires, so a seek into a pending span cannot fire a surprise scroll minutes later');
ok(/block: 'center'/.test(strips) && /function offScreen/.test(strips),
   'centred, and only when the row is actually off screen');

/* ── TWO TRANSPORTS, TWO QUESTIONS (Seth, 2026-08-13, refining v357):
 *   a row's ▶  → "is this span right?"     → play the line and STOP at its end (playSpan)
 *   Space / ⏵  → "does this seam sound right?" → run on through the cuts (playThrough)
 * v357 gave the row button play-through as well, which collapsed the two and left no way to hear
 * one span in isolation. */
console.log('\nSpace and the dock ⏵ play THROUGH the boundaries; a row\'s ▶ plays just its line');
const pt = method(audio, 'playThrough');
ok(!!pt && /this\.clearSpan\(\)/.test(pt) && !/_spanTick/.test(pt),
   'playThrough plays with no span watcher, so nothing pauses it at a cut');
ok(/export function cutTogglePlay/.test(strips) && /p\.playThrough\(\);/.test(strips),
   'Space uses it');
ok(/this\.clearSpan\(\); this\.ws\?\.playPause\(\)/.test(audio),
   'and the dock\'s own ⏵ drops any span watcher before playing, so it runs on too');
ok(!/playThrough/.test(render), 'but the ROW button does not — no play-through in renderCut');
ok(/wireSegPlay\(play, seg, cutDeps\.getPlayer/.test(render),
   'it uses the SAME wireSegPlay as Baseline and Gloss, so "play this line" means one thing');
const wsp = strips.match(/export function wireSegPlay[\s\S]*?\n\}/)[0];
ok(/playSpan\(from, seg\.end, seg\.start\)/.test(wsp),
   'which is span-limited (playSpan) and rewinds to the segment when it finishes');
ok(!/function cutPlaySeg/.test(strips), 'and the tab keeps no play-through copy of that wiring');
const cutEntry = app.match(/if \(tab === 'cut'\) \{[\s\S]*?prepareCutAudio\(\);/)[0];
ok(/lastPlayTarget = null;/.test(cutEntry),
   'and no span target is left behind on the Cut tab, so ⏮ and Space cannot re-introduce one');
ok(/player\?\.clearSpan\?\.\(\);/.test(cutEntry),
   'entering the tab also DISARMS a live span watcher — otherwise playback still stops at the '
   + 'boundary of whatever Baseline line was playing when you came over');

console.log('\nSpace plays and pauses wherever focus is (it is almost always on a button here)');
const cutKeys = app.match(/if \(activeTab !== 'cut' \|\| \$\('#view-cut'\)\?\.hidden\) return;[\s\S]*?\}\);/)[0];
ok(/e\.key === ' ' && !e\.repeat.*preventDefault\(\); cutTogglePlay\(\)/.test(cutKeys),
   'the Cut tab handles Space itself, with preventDefault so a focused button cannot also fire');
ok(/if \(activeTab === 'cut' && !\$\('#view-cut'\)\?\.hidden\) return;/.test(app),
   'and the global Space handler stands down there, so the two cannot double-toggle');

/* ── …but NOT everywhere on the page. Claiming three keys at document level takes them from controls
 * that legitimately own them; this is where that reach is bounded. Found by the preflight review:
 * a dialog open over the Cut tab had its buttons deadened, with the recording playing behind it. */
const guard = fn(app, 'cutKeysApply');
ok(!!guard, 'there is one guard deciding where the Cut tab\'s keys apply');
ok(/if \(!cutKeysApply\(e\.target\)\) return;/.test(cutKeys), 'and all three keys go through it');
ok(/document\.querySelector\('\.modal:not\(\[hidden\]\)'\)/.test(guard),
   'an open modal keeps its own keys — Enter must not cut the audio behind a Send dialog');
ok(/CUT_SURFACE/.test(guard) && /'#view-cut, #audio-player'/.test(app),
   'the tab\'s surface is the Cut view AND the dock player (its overview), and nothing else');
ok(/ctl\.id !== 'tab-cut'/.test(guard),
   'plus the Cut tab button itself — where focus lands on the way in, and the reported dead Space');
ok(/input:not\(\[type="range"\]\)/.test(guard),
   'a text box or <select> wins; the dock ZOOM slider does not, since Space means nothing to it');

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
ok(/applyCutHint\(\);/.test(app.match(/function applyLiveSettings\(\)[\s\S]*?\n\}/)[0]),
   'a PUSHED backspaceJoin re-words the hint in place — a researcher push lands mid-session');
ok(/on the Cut tab, where Backspace joins/.test(i18n),
   'and the researcher-facing note says the setting now covers the Cut tab as well');

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
/* …and neither does UNDO, which is the same complaint by another route: applyUndoState re-enters
 * through switchTab('cut') → prepareCutAudio, and hiding #cut-main to show "Loading…" collapses the
 * page height, which clamps the scroll to the top before renderCut can read it. */
const prep = app.match(/async function prepareCutAudio\(\)[\s\S]*?\n\}/)[0];
ok(/const reentry = main && !main\.hidden && cutShownFor === forDoc;/.test(prep),
   're-entering the tab for the SAME doc keeps the strips on screen');
ok(/if \(main && !reentry\) main\.hidden = true;/.test(prep),
   'so the height never collapses and the scroll is never clamped — and the undo flicker goes too');

/* ── WHICH TAB A TEXT OPENS ON (Seth, 2026-08-13): the last tab used in THAT text, else — only when
 * there are no words yet — the Cut tab if it is enabled. The memory has to win, or a text with no
 * words (every text at the start of the job) drags the user back to Cut however many times they
 * have left it for Baseline. */
console.log('\na text opens on the tab it was last used on');
const landing = fn(app, 'landingTab');
ok(/const last = current\.lastTab;/.test(landing) && landing.indexOf('current.lastTab') < landing.indexOf('landOnCutEnabled'),
   'the remembered tab is consulted BEFORE the no-words rule, not after');
ok(/!\(last === 'cut' && !cutTabEnabled\(\)\)/.test(landing),
   'but a remembered tab the researcher has since switched off is not honoured');
ok(/if \(!docHasNoText\(current\.doc\)\) return tab;/.test(landing),
   'the fallback turns on WORDS, not on the segmentation state');
ok(/function docHasNoText/.test(app), 'and "no words yet" is one named predicate');
const remember = fn(app, 'rememberTab');
ok(/current\.lastTab = tab;/.test(remember) && !/current\.doc\.lastTab/.test(app),
   'the memory lives on the RECORD, not on doc — doc is the flextext model and gets serialised');
ok(/isEditorTab\(tab\)/.test(remember), 'and only editor tabs are remembered');
ok(/rememberTab\(tab\);/.test(app.match(/function switchTab\(tab\)[\s\S]{0,600}/)[0]),
   'switchTab records it');

console.log(fail ? `\nFAILED (${fail})` : '\nPASSED');
process.exit(fail ? 1 : 0);
