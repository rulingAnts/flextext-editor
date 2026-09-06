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
ok(/border-left:1px dotted/.test(rb) && /rgba\(108,118,133/.test(rb),
   'light grey, dotted, 1px — "subtle, light, skinny" (Seth, 2026-09-06), visible without crowding the waveform');
ok(/this\.renderBoundaries\(\);/.test(audio.match(/this\.ws\.on\('ready'[\s\S]*?\}\);/)[0]),
   're-drawn on ready, so marks set before the audio loaded are not lost to the race');
ok(/syncCutBoundaries\(\)/.test(strips) && /p\.setBoundaries\(cutBoundaryTimes\(\)\)/.test(strips),
   'the Cut tab pushes its boundaries to the player');
const stop = fn(strips, 'stopCut');
ok(!/setBoundaries\?\.\(\[\]\)/.test(stop), 'and leaving the tab LEAVES them: the marks belong to the text on every tab (Seth, 2026-09-06)');

/* ── the marks' LIFETIME. Both halves were found by the v357 preflight review, and the first was
 * the only finding two independent verifiers refused to refute: boundary times mean nothing outside
 * the recording they were measured in, and this Player is a singleton reused for every document. */
ok(/this\._bounds = \[\];/.test(method(audio, 'destroyWs')),
   'a destroyed waveform forgets its marks, so doc A\'s cuts cannot be painted on doc B');
ok(/boundaryCount\(\)/.test(audio) && /p\.boundaryCount\(\) !== want\.filter\(Number\.isFinite\)\.length/.test(strips),
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
const guard = fn(app, 'transportKeysApply');
ok(!!guard, 'there is ONE guard deciding where the transport keys apply, on every editor tab');
ok(/if \(!transportKeysApply\(e\.target, e\.key\)\) return;/.test(cutKeys), 'and all three Cut-tab keys go through it');
ok((app.match(/transportKeysApply\(e\.target, e\.key\)/g) || []).length === 3,
   'so does the global Space handler (what unjammed Baseline and Gloss) and the Baseline Enter — '
   + 'every document-level key on this surface is bounded by the one rule');
/* ⚠ THE TAB BUTTON IS THE WHOLE POINT. You arrive on a tab by clicking its button, so the button
 * keeps focus — and Space was being spent re-activating it: the list re-rendered and nothing played
 * (Seth, on Baseline and Gloss). Re-opening the tab you are already on is worth nothing. */
ok(/ctl\.classList\.contains\('top-tab'\)/.test(guard),
   'a focused TAB BUTTON does not keep Space — it is where focus lands on the way in');
ok(/'#view-cut, #view-baseline, #view-gloss, #audio-player'/.test(app),
   'and the surface is all three editor views plus the shared dock player');
ok(!/t2\.closest\('input, textarea, select, button, \[contenteditable\]'\)/.test(app),
   'the old blanket "any button" exemption is gone — it was the jam');
ok(/document\.querySelector\('\.modal:not\(\[hidden\]\)'\)/.test(guard),
   'an open modal keeps its own keys — Enter must not cut the audio behind a Send dialog');
ok(/EDITOR_SURFACE/.test(guard), 'the surface is named once and shared');
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
ok(/hint\.dataset\.i18nHtml = \(joinKeysEnabled\(\) \? 'cut\.hint' : 'cut\.hintNoJoinKey'\) \+ \(adjustBoundariesAllowed\(\) \? 'Drag' : ''\)/.test(app),
   'and the hint names the key only when the key works (and the drag only when the grips exist)');
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

/* ── GUESS THE LINES: its guards, which matter because one press replaces every line in the text. */
console.log('\n"Guess the lines" refuses rather than destroys');
const guessFn = fn(strips, 'cutGuessSplits');
ok(/docHasWork\(doc\)/.test(guessFn) && /function docHasWork/.test(strips),
   'a text with words, GLOSSES or free translations is refused — not just one with baseline text');
ok(/w\.gls/.test(fn(strips, 'docHasWork')) && /s\.free/.test(fn(strips, 'docHasWork')),
   '…and that test really does look at glosses and free translations');
ok(/dur > GUESS_MAX_MS/.test(guessFn) && /GUESS_MAX_MS = 10 \* 60 \* 1000/.test(read('docs/js/segments.js')),
   'a recording longer than ten minutes is refused up front (Seth\'s cap)');
ok(/cut\.no\.guessLong/.test(guessFn) && /\{mins\} minutes long/.test(i18n),
   '…with the limit AND the recording\'s actual length, so it is a decision rather than a mystery');
const blocked = fn(strips, 'guessBlockedBecause');
ok(/guess\.disabled = !!why;/.test(render) && /guessBlockedBecause\(paras, doc\)/.test(render),
   'and the button is disabled in every refusing case, rather than looking live and refusing on click');
ok(/cut\.no\.guessText/.test(blocked) && /cut\.no\.guessLong/.test(blocked) && /cut\.no\.guessAudio/.test(blocked),
   '…with the SAME sentence on the tooltip that the click would have said');
/* Seth, 2026-08-14, on a recording made in a crowded workshop: "If the background noise is too high
 * to make easy splits, then graying out the guess button is fine." */
ok(/cut\.no\.guessNone/.test(blocked) && /guessCuts\(dur\)\.length/.test(blocked),
   'a recording with no findable pauses greys the button too — the detector is asked BEFORE the press');
ok(/guessProbe\.gen !== peaksGen/.test(blocked),
   '…and that answer is cached per peaks generation, since renderCut runs on every cut and join');
ok(/guessCuts\(dur\)/.test(guessFn) && /function guessCuts/.test(strips),
   'the probe and the press call the detector through ONE function, so they cannot disagree');
ok(/const dur = peaksDurationFor\(cutDeps\)/.test(guessFn),
   'and both ask whether the peaks are THIS recording\'s before trusting a duration');
/* ── ✨ EXISTS ONLY WHILE THERE IS NOTHING TO LOSE (Seth, 2026-08-14: a confirm dialog is not
 * protection for a non-tech-savvy speaker — the button must be GONE over manual work). */
const allowedFn = fn(strips, 'guessAllowedHere');
ok(!!allowedFn, 'one function owns the visibility rule');
ok(/segs\.length <= 1/.test(allowedFn) && /doc\.guessSig/.test(allowedFn) && /sg\.end === sig\[i\]/.test(allowedFn),
   'visible in exactly two states: the untouched seed, or segments matching the guess signature end for end');
ok(/docHasWork\(doc\)/.test(allowedFn), 'typed text or glosses hide it too — Seth named "text entry" explicitly');
ok(/guess\.hidden = !allowed;/.test(render) && /guessAllowedHere\(segs, paras, doc\)/.test(render),
   'renderCut hides — not greys — through that rule');
ok(/doc\.guessSig = r\.segments\.map\(\(sg\) => sg\.end\);/.test(guessFn),
   'the guess stamps its boundary ends on the doc as the signature');
ok(guessFn.indexOf('cutDeps.capture()') < guessFn.indexOf('doc.guessSig ='),
   '…after capture, so the pre-guess snapshot stays signature-free');
ok(/cut\.no\.guessManual/.test(guessFn) && /guessAllowedHere\(cutSegs\(\), paras, doc\)/.test(guessFn),
   'and the function refuses on its own — the backstop for keyboards, scripts and older docs');
ok(/'cut\.no\.guessManual'/.test(i18n), 'with its sentence in the string table (parity test covers id)');
ok(/clearSpan\?\.\(\)/.test(guessFn),
   'it drops a live span watcher too — the spans it described are about to stop existing');
ok(/cutDeps\.capture\(\)/.test(guessFn), 'and the whole guess is ONE undo step');

/* ── THE PEAKS MUST BE THE RECORDING'S. Seth, 2026-08-14, on Snakes_We_Eat.m4a: a text imported from
 * a real .m4a showed "a short (truncated) single line", ✨ did nothing, and playback ran past the
 * span's end. The root cause was one object pretending to be another. */
console.log('\nthe peaks are the recording\'s own audio, or they are not used');
const ensure = strips.match(/export async function ensurePeaks[\s\S]*?\n\}/)[0];
ok(/const realAudio = /.test(strips) && /sampleRate >= 8000/.test(strips),
   'a "decoded buffer" under 8 kHz is display peaks wearing an AudioBuffer\'s shape, and is refused');
ok(/const fromPlayer = realAudio\(playerBuf\)/.test(ensure) && !/fromPlayer: !!playerBuf/.test(ensure),
   '…and the cache records where the peaks REALLY came from, so a rejected buffer is re-decoded');
ok(/this\._peaksOnly = !!\(media\.peaks && media\.duration\)/.test(audio),
   'the player remembers when it handed wavesurfer peaks instead of letting it decode');
ok(/if \(this\._peaksOnly\) return null;/.test(method(audio, 'decodedBuffer')),
   '…and decodedBuffer() then reports NOTHING rather than the 12000-sample picture it could return');
ok(/this\._peaksOnly = false;/.test(fn(audio, 'destroyWs') || method(audio, 'destroyWs')),
   'and that flag dies with the load it describes, not with the next one');

/* ── ENTER ON THE BASELINE TAB, OUTSIDE A TEXT BOX (Seth, 2026-08-14): "if the segment audio is
 * active, pressing enter splits at the playhead and splits the text at the end of the baseline
 * (rather than wherever the cursor was last). If the text box is focused, pressing enter splits
 * wherever the playhead is (on the current segment) as it does now." */
console.log('\nBaseline Enter: one split, two ways of dividing the words');
const splitAt = fn(strips, 'splitLineAt');
const atPlayhead = fn(strips, 'stripSplitAtPlayhead');
ok(!!splitAt && /splitLineAt\(i, input\.selectionStart/.test(fn(strips, 'onKey')) && /splitLineAt\(i, null, false\)/.test(atPlayhead),
   'both Enters go through ONE function, so the time can never break differently for the two');
ok(/caret == null \? text\.length/.test(splitAt),
   '…and "no caret" means the END of the line — the words all stay put, the new line starts empty');
ok(/const input = deps\.container\.querySelectorAll\('\.seg-text'\)\[i\]/.test(splitAt),
   'the words come from the BOX, not the model, so keystrokes not yet committed are not dropped');
ok(/segmentIndexAt\(docSegments\(doc\), deps\.getPlayer\(\)\?\.playheadMs/.test(atPlayhead) && /if \(i < 0\) return false/.test(atPlayhead),
   'it acts on the line the PLAYHEAD is in, and refuses when the playhead is in none of them');
ok(/if \(deps\.capture\) deps\.capture\(\);/.test(atPlayhead),
   '…and is its own undo step — a chopping run types nothing, so nothing else would create one');
ok(/if \(focusNext\) focusStrip\(i \+ 1, 0\)/.test(splitAt),
   'the text-box Enter moves the cursor on; the playhead one leaves focus alone');
ok(/activeTab !== 'baseline'/.test(app) && /stripSplitAtPlayhead\(\)/.test(app)
   && /if \(!transportKeysApply\(e\.target, e\.key\)\) return;   \/\/ a focused text box keeps Enter/.test(app),
   'the key is claimed only on the Baseline tab, and only outside a text field');
ok(/baseline\.hintSeg/.test(app) && /baseline\.hintSeg/.test(i18n),
   'and the tab says so — the classic "Enter for a new paragraph" hint is wrong in strip mode');

console.log('\nthe segments account for ALL of the recording');
const cover = fn(strips, 'coverTail');
ok(!!cover, 'there is a step that extends an unfinished tail to the end of the recording');
ok(/String\(paras\[i\] \?\? ''\)\.trim\(\)/.test(cover) && /last\.attrs/.test(cover),
   '…which never touches a line that has text, nor one whose times were imported');
ok(/COVER_TOL_MS/.test(cover) && /COVER_TOL_MS = 1000/.test(strips),
   '…and leaves rounding and encoder priming alone (a second of tolerance)');
ok(/if \(coverTail\(doc\.segments, paras, known\)\) repaired = true;/.test(fn(strips, 'reconcile')),
   'reconcile runs it, and a repair it makes is persisted like any other');
const durFor = fn(strips, 'peaksDurationFor');
ok(/id !== peaksCache\.docId/.test(durFor) && /return 0/.test(durFor),
   'a peaks cache belonging to ANOTHER text can never seed this one\'s spans');
ok(/getDocId: \(\) => current && current\.id/.test(app) && (app.match(/getDocId:/g) || []).length === 2,
   '…and both the Baseline strips and the Cut tab tell it which text they are showing');

console.log('\na cut or a join does not throw the user back to the top of the recording');
ok(/const keepTop = scroller \? scroller\.scrollTop : 0;/.test(render), 'the scroll offset is read BEFORE the rebuild');
/* ── AND THE BASELINE STRIPS HOLD IT TOO (v369). renderStrips never got the v357 rule, and the
 * playhead-Enter exposed it: unlike the in-box Enter there is no focusStrip afterwards to pull the
 * view back, so every chop landed at the top (measured 8021→0 in the v368 audit). */
const rStrips = fn(strips, 'renderStrips');
ok(/const scroller = scrollerFor\(host\)/.test(rStrips) && /const keepTop = scroller \? scroller\.scrollTop : 0;/.test(rStrips),
   'renderStrips reads the offset before ITS rebuild too — the chop gesture rebuilds with no focus to recover it');
ok(rStrips.indexOf('keepTop') < rStrips.indexOf("host.innerHTML = ''"),
   '…and before the empty, the only order that works');
ok(/scroller\.scrollTop = keepTop/.test(rStrips), 'and restores it after');
ok(/function scrollerFor/.test(strips) && /return scrollerFor\(document\.getElementById\('cut-strips'\)\)/.test(strips),
   'both tabs find the scroller through ONE function, so they cannot drift in how they hold the view');

console.log('\nleaving the text stops the machinery the editor was running');
/* v368 audit: only switchTab stopped the tab tickers, so leaving from Gloss or Cut left a 60fps rAF
 * loop doing ~3,600 DOM queries a second against hidden nodes on the texts list, plus ~25MB of
 * canvas backing store idling behind it. */
const leave = fn(app, 'leaveEditor');
ok(!!leave, 'there is ONE leave-the-text cleanup, not per-exit copies');
ok(/stopStrips\(\)/.test(leave) && /stopCut\(\)/.test(leave) && /stopGlossCursor\(\)/.test(leave),
   'it stops all three tab tickers — switchTab only ever stopped them between tabs, not on the way out');
ok(/cutShownFor = null/.test(leave),
   'and forgets the Cut tab\'s "already on screen" claim, so the next open rebuilds honestly');
ok(/#segment-strips.*#cut-strips.*#gloss-body/.test(leave) && /innerHTML = ''/.test(leave),
   'and drops the strip canvases instead of leaving ~25MB idling behind the texts list');
ok(/leaveEditor\(\)/.test(fn(app, 'returnToLibraryAfterSend')),
   'the return-after-send exit goes through it (it had the same leak as Back)');
ok((app.match(/leaveEditor\(\);/g) || []).length >= 2, 'and so does the Back button');
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
ok(/last === 'cut' && \(!cutTabEnabled\(\)/.test(landing),
   'but a remembered tab the researcher has since switched off is not honoured');
ok(/if \(!docHasNoText\(current\.doc\)\) return tab;/.test(landing),
   'the fallback turns on WORDS, not on the segmentation state');
ok(/function docHasNoText/.test(app), 'and "no words yet" is one named predicate');
const remember = fn(app, 'rememberTab');
ok(/current\.lastTab = tab;/.test(remember) && !/current\.doc\.lastTab/.test(app),
   'the memory lives on the RECORD, not on doc — doc is the flextext model and gets serialised');
ok(/isEditorTab\(tab\)/.test(remember), 'and only editor tabs are remembered');
const switchHead = (app.match(/function switchTab\(tab, landing\)[\s\S]{0,900}/) || [''])[0];
ok(/if \(!landing\) rememberTab\(tab\);/.test(switchHead),
   'switchTab records it — but NOT the landing switch itself');
/* ⚠ Remembering the tab the APP chose would make rule (2) self-fulfilling: the first auto-land on
 * Cut becomes "the user's choice" forever, and a researcher later turning landOnCut off would have
 * no effect on any text that had ever been opened. Seth's rule (1) is "the last tab the USER had
 * open". Found by review. */
ok(/switchTab\(landingTab\(tab\), \/\* landing \*\/ true\);/.test(app),
   'enterEditor marks its own switch as the landing, so only a user choice is remembered');
// …as a STATEMENT: the function's comment names schedulePersist to explain why it is not used.
ok(!/\n\s*schedulePersist\(\);/.test(fn(app, 'rememberTab')),
   'and remembering never goes through persist() — looking at a tab must not stamp the text modified');
ok(/db\.putDoc\(rec\)/.test(fn(app, 'rememberTab')),
   'it writes the record quietly instead (a modified stamp would re-upload a text already on Drive)');
ok(/!docSegments\(current\.doc\)\.some\(isAligned\)/.test(landing),
   'a remembered Cut tab still needs the text to HAVE audio — otherwise it is the dead "nothing to cut" screen');

console.log(fail ? `\nFAILED (${fail})` : '\nPASSED');
process.exit(fail ? 1 : 0);
