/* THE MATCHER'S LEFT PANE IS THE CUT TAB'S STRIP, NOT A LIST OF TIMESTAMPS.
 *
 * Structural checks over the sources, in the style of cut-tab-ui.test.mjs and for the same reason:
 * this screen is DOM plus a requestAnimationFrame loop, so there is no pure model to assert against,
 * and every defect it can have is one a person only sees on a real device.
 *
 * The matcher shipped first as four lines of text reading "0:04 – 0:09". That is unusable for the
 * job it exists for — matching a piece of audio to a line of text means knowing WHICH piece, and a
 * piece is identified by what it sounds like. So it now carries the same waveform, the same
 * click-to-park playhead and the same follow-scroll as the Cut tab. What this file pins is that it
 * carries the SHARED ones: this is the suite's THIRD list of waveforms, and the Cut tab's own
 * history (v354–v356, where strips were drawn that no pointer could reach) is what a fourth
 * hand-rolled copy would repeat.
 *
 * Run: node test/matcher-audio.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const app = read('docs/js/app.js');
const strips = read('docs/js/segment-strips.js');
const css = read('docs/css/app.css');
const shell = read('satellites/audio-segmenter/index.html');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const fn = (src, name) => {
  const m = src.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  return m ? m[0] : '';
};
const asyncFn = (src, name) => {
  const m = src.match(new RegExp(`\\nasync function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  return m ? m[0] : '';
};
/* ⚠ COMMENTS STRIPPED BEFORE ANY "this name appears nowhere" ASSERTION. Three of the checks below
 * failed on their first run against correct code, because the fix's own comments NAME the wrong
 * field they warn you off — "doc.segments, NOT rec.segments". A test that reads prose is asserting
 * about the explanation rather than the behaviour, and would have to be weakened every time the
 * explanation got better. Crude but sufficient: this source has no regex literals or strings
 * containing `//`, and the assertions using it only ask whether an identifier is absent. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

console.log('\nthe audio row is built from the SHARED helpers, not a fourth copy of them');
const draw = fn(app, 'mgDraw');
ok(!!draw, 'mgDraw exists');
ok(/wireSegPlay\(play, sp, \(\) => player/.test(draw), 'the ▶ is wired by the shared wireSegPlay (plays this span only, pauses in place)');
ok(/wireWaveSeek\(wave, sp, \(\) => player/.test(draw), 'the waveform is wired by the shared wireWaveSeek (click parks the playhead, drag scrubs)');
ok(/attachSpanWave\(wave, sp\)/.test(draw), 'the peaks are painted by the shared attachSpanWave');
ok(/attachSpanWave|healSpanWave/.test(strips) && /export function attachSpanWave/.test(strips),
   'attachSpanWave is exported from segment-strips, so there is one implementation of it');
// A private drawing path here is the regression this whole file guards against.
ok(!/function mgDrawWave|new OfflineAudioContext|decodeAudioData/.test(code(app.slice(app.indexOf('THE MATCHER')))),
   'the matcher decodes and draws nothing of its own');

/* ⚠ THE TWO DEFECTS BELOW MADE THIS APP UNUSABLE ON REAL DATA, and both survived a full manual
 * test drive because the fixture had been hand-written to match the CODE's assumption rather than
 * the suite's. They are pinned first because they are the ones that cost a field day. */
console.log('\nspans live in doc.segments — the field the rest of the suite reads and writes');
const stripsW = read('docs/js/segment-strips.js');
ok(/doc\.segments = /.test(stripsW), 'segment-strips writes doc.segments on every cut, join and guess');
ok(/Array\.isArray\(doc\.segments\)/.test(read('docs/js/flextext.js')), 'the flextext exporter reads doc.segments');
ok(/Array\.isArray\(doc\.segments\)/.test(read('docs/js/seg-exports.js')), 'and so do the EAF/bundle builders');
const load0 = fn(app, 'mgLoad');
ok(/docSegments\(rec\.doc\)/.test(load0),
   'mgLoad reads doc.segments (a top-level rec.segments found NOTHING on any text the Cut tab made — an empty left pane on every real document)');
const commit0 = asyncFn(app, 'mgCommit');
ok(/rec\.doc\.segments = MG\.lines\.map/.test(commit0),
   'mgCommit writes doc.segments (writing rec.segments meant the toast said "saved" and the alignment did not change)');
ok(!/\brec\.segments\b/.test(code(commit0)) && !/\brec\.segments\b/.test(code(load0)),
   'and neither touches a top-level rec.segments at all');
ok(/Object\.assign\(rec, docStats\(rec\.doc\)\)/.test(commit0),
   'segCount comes from docStats like every other writer — it counts PHRASES, not spans');

console.log('\n"has a recording" is the media store, not a field nobody writes');
const dbjs = read('docs/js/db.js');
ok(/export async function mediaKeys/.test(dbjs), 'db.mediaKeys() asks the media store directly, in one transaction');
ok(!/mediaName/.test(code(dbjs)), 'listDocs no longer projects mediaName — NOTHING in the suite ever writes it');
ok(!/\.mediaName\b/.test(code(app.slice(app.indexOf('AUDIO SEGMENTER')))), 'and the segmenter no longer reads it');
const state = fn(app, 'sgStateOf');
ok(/have\.has\(d\.id\)/.test(state),
   'sgStateOf asks the media keys (gating Open on mediaName disabled every text on a real device)');
ok(/spanCount/.test(code(state)) && !/segCount/.test(code(state)),
   'and counts spanCount, not segCount (a 30-line transcript with no cuts reported itself fully segmented)');
ok(/const spanCount = segs\.filter/.test(dbjs) && /!s\.timePending/.test(dbjs),
   'spanCount is computed in the projection from doc.segments, aligned spans only');
ok(/d\.pendingAudio \? 'coming'/.test(state),
   'a recording still downloading reads as arriving, not as "no recording" — that would send a user to attach a file already on its way');

console.log('\nthe pending flag is named what isAligned reads, or every span is silently "aligned"');
ok(/export function isAligned[\s\S]*?seg\.timePending/.test(strips.length ? read('docs/js/segments.js') : ''),
   'isAligned gates on seg.timePending');
const load = fn(app, 'mgLoad');
ok(/timePending: !!s\.timePending/.test(load), 'mgLoad carries timePending through under that exact name');
ok(/timeEstimated: !!s\.timeEstimated/.test(load), 'and timeEstimated separately — an estimate is a timeline, so it stays playable');

console.log('\nthe strips heal on a MACROTASK, because neither rAF nor ResizeObserver runs in a background tab');
ok(/setTimeout\(\(\) => \{[\s\S]*?healSpanWave/.test(draw),
   'mgDraw schedules a heal on setTimeout, not only from the ticker');
ok(/export function healSpanWave/.test(strips), 'healSpanWave is exported for surfaces outside segment-strips');

console.log('\nthe ticker does the four things the Cut tab\'s does');
const ticker = fn(app, 'mgStartTicker');
ok(!!ticker, 'mgStartTicker exists');
ok(/requestAnimationFrame/.test(ticker), 'it is a frame loop');
ok(/seg-cursor/.test(ticker), 'it draws the playhead cursor on the span it is inside');
ok(/followLine\(row, rolling, mgFollowRow, p\)/.test(ticker), 'it follows playback with the SHARED followLine (4s stand-off after a user scroll)');
ok(/takeReveal\(row\)/.test(ticker), 'it honours "take me to that line" after a seek on the big player');
ok(/healSpanWave\(wave\)/.test(ticker), 'and it repairs a strip drawn before its peaks landed');
ok(/last && now <= sp\.end/.test(ticker), 'the LAST span includes its own end, so the cursor does not vanish at the end of the recording');

console.log('\nthe pairing colour is SPACED, not hashed — adjacent lines must not share a shade');
ok(/137\.508/.test(draw), 'hues step by the golden angle');
ok(!/charCodeAt/.test(code(draw)), 'no string hash over the ids (which gave 326°, 327°, 328° on a three-line text)');
ok(/lineOrder|hueForLine/.test(draw), 'the hue comes from the LINE, so a span and its line are the same colour in both panes');
// Colour is never the only channel: the pick button carries the number.
ok(/pick\.textContent = String\(i \+ 1\)/.test(draw), 'and every row still carries its number, so colour is redundant encoding');

console.log('\nsplitting cuts where the playhead is — the same verb the Cut tab has meant since v158');
const split = fn(app, 'mgSplitSpan');
ok(/player\?\.playheadMs\?\.\(\)/.test(split), 'mgSplitSpan reads the playhead');
ok(/inside \? head :/.test(split), 'and cuts there when it is inside the span, falling back to the midpoint when it is not');
ok(/MIN_SEGMENT_MS/.test(split), 'and still refuses a cut that would make a piece too short to be one');
ok(/player\?\.clearSpan\?\.\(\)/.test(split), 'the span watcher is cleared: the halves are new spans, and the old stop time is gone');

console.log('\ncommitting collapses to the index-locked model the rest of the suite reads');
const commit = asyncFn(app, 'mgCommit');
ok(!!commit, 'mgCommit exists');
ok(/Math\.min\(cur\.start, sp\.start\)[\s\S]*?Math\.max\(cur\.end, sp\.end\)/.test(commit),
   'several spans on one line become the UNION of their extent — a line said in three bursts keeps all three');
ok(/if \(sp\.timePending\) continue/.test(commit), 'an unaligned span contributes no timeline to that union');
ok(/timeEstimated: true/.test(commit), 'an estimated boundary is written back as estimated, not promoted to a measurement');
ok(/rec\.doc\.paragraphs = MG\.lines\.map/.test(commit) && /rec\.doc\.segments = MG\.lines\.map/.test(commit),
   'segments and paragraphs come out the same length and in the same order — segments[i] IS paragraph i');

console.log('\nleaving releases everything at once');
const close = fn(app, 'mgClose');
ok(/mgStopTicker\(\)/.test(close), 'the frame loop stops (it would otherwise outlive its screen)');
ok(/player\?\.hide\?\.\(\)/.test(close), 'the dock is hidden — it is a sibling of the views, so show() does not touch it');
ok(/MG = null/.test(close), 'and the open mapping is dropped');
ok(/mgClose\(\)/.test(commit), 'Done goes through the same exit as Back');

console.log('\nthe dock sits ABOVE the matcher in the shell, or sticky glues it to the wrong edge');
const dockAt = shell.indexOf('id="audio-player"');
const matcherAt = shell.indexOf('id="view-matcher"');
ok(dockAt > 0 && matcherAt > 0, 'both elements are in the segmenter shell');
ok(dockAt < matcherAt, 'the player element precedes #view-matcher');

console.log('\nthe row\'s CSS is what the shared cursor and waveform need');
ok(/\.mg-span\{position:relative;display:grid/.test(css),
   '.mg-span is position:relative — the absolutely-positioned .seg-cursor resolves against it');
ok(/\.mg-span \.seg-wave\{grid-column:3/.test(css), 'the waveform is moved to its own column (the shared rule puts it in column 2)');
ok(/\.mg-list\{[^}]*overflow:auto/.test(css), 'each pane scrolls on its own — the span and its line are rarely the same distance down');
ok(!/\.mg-bar\{position:sticky/.test(css), 'the bar is NOT sticky: the dock already claims top:0 and would cover it');

console.log('\non a phone the waveform gets the whole row, and the pick badge is a real tap target');
// Measured at 375px before this: a 141px waveform in a 333px row, and a 21px-wide pick button —
// under half the 44px the rest of the suite holds itself to, on the control that IS the gesture.
const phone = css.slice(css.indexOf('@media (max-width:560px){', css.indexOf('.mg-span{')));
ok(/\.mg-span \.seg-wave\{grid-column:1 \/ -1/.test(phone), 'the waveform spans the full row width below the controls');
ok(/\.mg-span \.mg-pick\{grid-row:1;min-width:44px;min-height:44px\}/.test(phone), 'the pick badge is 44x44');
ok(/\.mg-span \.seg-play\{grid-row:1;min-width:44px;height:44px\}/.test(phone), 'and so is the play button');
// `flex:0 0 2rem` is inert inside a grid, which is how the badge came to measure 21px at all.
ok(/\.mg-span \.mg-pick\{min-width:2rem\}/.test(css), 'and the badge carries an explicit width at every size, not an inert flex basis');

console.log(fail ? `\n${fail} FAILED\n` : '\nall ok\n');
process.exit(fail ? 1 : 0);
