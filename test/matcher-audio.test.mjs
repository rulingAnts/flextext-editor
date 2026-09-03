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
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';

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

/* ⚠ THE TEXT ARRIVES ALREADY SEGMENTED, AND THAT SEGMENTATION IS THE LINGUIST'S WORK.
 *
 * Seth, on seeing his own "Rumah Jatuh di Muara Suhu" open as a single line: "the text is segmented
 * (phrases), the audio is not, segment the audio and match it to text segments (phrases), but also
 * have a way to adjust those phrase cuts/joins IF WE NEED TO, but not re-doing the phrase
 * segmentation from scratch."
 *
 * A .flextext can hold every phrase inside ONE paragraph — that file is 1 paragraph containing 60
 * phrases, and "Crocodile Woman" is 1 holding 77. (Provenance: Seth's older Excel-template FlexText
 * editor exports this way, and it is also a shape FLEx itself produces — so it is *a* normal export,
 * not an exotic one.) mgLoad reads PARAGRAPHS, so such a text became one wall of words with a
 * scissors in every gap, asking the user to redo by hand what FLEx already knew.
 *
 * The engine has had the answer since v322 — healFlatSegments promotes each phrase to its own
 * paragraph, keeping words, glosses, free translation and any imported offsets. The matcher simply
 * never called it. */
console.log('\nphrases are lines: the file\'s own segmentation survives into the matcher');
{
  installMiniXmlDom();
  const { parseFlextext } = await import('../docs/js/flextext.js');
  const phrase = (v, g, ft) => `<phrase><item type="txt" lang="und">${v.join(' ')}</item>`
    + `<words>${v.map((w, i) => `<word><item type="txt" lang="und">${w}</item>`
    + `<item type="gls" lang="en">${g[i]}</item></word>`).join('')}</words>`
    + `<item type="gls" lang="en">${ft}</item></phrase>`;
  // ONE paragraph, THREE phrases — the shape that was being flattened.
  const xml = `<?xml version="1.0" encoding="utf-8"?><document version="2"><interlinear-text>`
    + `<item type="title" lang="en">Rumah</item><paragraphs><paragraph><phrases>`
    + phrase(['a', 'bo'], ['saya', 'cerita'], 'I tell this.')
    + phrase(['Suhu', 'te'], ['suhu', 'di'], 'We slept at Suhu.')
    + phrase(['pak', 'zeth'], ['pak', 'zeth'], 'With Pak Zeth.')
    + `</phrases></paragraph></paragraphs></interlinear-text></document>`;
  const { texts, error } = parseFlextext(xml, { vernLang: 'und', analLang: 'en' });
  ok(!error, 'the fixture parses');
  const doc = texts[0];
  ok(doc.paragraphs.length === 1, 'it arrives as ONE paragraph, as such files do');
  ok(doc.paragraphs[0].segments.length === 3, '…holding all three phrases');
  // healFlatSegments' rule, applied here exactly as app.js applies it.
  const healed = doc.paragraphs.some((x) => (x.segments || []).length > 1)
    ? doc.paragraphs.flatMap((x) => (x.segments || []).length > 1
        ? x.segments.map((seg) => ({ segments: [seg] })) : [x])
    : doc.paragraphs;
  ok(healed.length === 3, 'and becomes THREE matcher lines, not one');
  ok(healed.every((x) => x.segments.length === 1), 'one phrase per line');
  const frees = healed.map((x) => x.segments[0].free);
  ok(frees[0] === 'I tell this.' && frees[2] === 'With Pak Zeth.',
     'each line keeps its OWN free translation rather than a concatenation of all of them');
  ok(healed[1].segments[0].words.map((w) => w.txt).join(' ') === 'Suhu te',
     'and its own words, in order');
}
// The matcher must actually run that, and BEFORE it reads the paragraphs.
{
  const open = app.match(/\nasync function mgOpen\([^)]*\) \{[\s\S]*?\n\}/)[0];
  ok(/healFlatSegments\(rec\.doc\)/.test(open), 'mgOpen heals the doc');
  ok(open.indexOf('healFlatSegments') < open.indexOf('mgLoad(rec)'),
     '…BEFORE mgLoad reads paragraphs, or the flattening it prevents has already happened');
  ok(/if \(SEGMENTER_MODE\) return true;/.test(fn(app, 'segmentationEnabled')),
     'and the segmenter forces segmentation on — healFlatSegments is gated on it, and this app IS segmentation');
}
/* ⚠ AND IT IS AN ENGINE-WIDE ENTRY CONDITION, NOT A MATCHER TRICK (Seth: "that particular issue is
 * probably an engine-wide issue … how to interpret imported flextext files with phrase/paragraph
 * breaks"). The repair was reachable only from three switchTab paths in the editor, so a doc sat in
 * its imported shape from the moment it entered the library until somebody opened it on a tab that
 * happened to heal it — and everything reading it in between saw N phrases in one paragraph while
 * doc.segments indexed paragraphs. It now runs where a foreign .flextext BECOMES a stored doc. */
console.log('\nevery foreign .flextext is normalised where it ENTERS the library');
{
  ok(/function normalizePhraseLines\(doc\)/.test(app),
     'the repair is a pure function — no `current`, no persist, no settings gate');
  ok(/if \(normalizePhraseLines\(doc\)\) schedulePersist\(\);/.test(fn(app, 'healFlatSegments')),
     'healFlatSegments keeps its behaviour by calling it — only IT knows the doc it healed is the open one');
  for (const [where, name] of [['importFile', 'the editor opening a .flextext'],
                               ['buildDocFromFlextextUrl', 'a researcher-assigned text'],
                               ['satImportFiles', 'the satellites\' importer']]) {
    const src = asyncFn(app, where);
    ok(!!src && /normalizePhraseLines\(doc\)/.test(src), `${name} normalises before storing`);
  }
  // The export surfaces need no such call: phraseRows already refuses the paragraph-indexed span
  // when a paragraph holds several phrases, falling back to each phrase's own offsets.
  ok(/para\.segments\.length === 1 \? \(segs\[i\] \|\| null\) : null/.test(read('docs/js/seg-exports.js')),
     'and the export path was already phrase-aware, so it is deliberately left alone');
}

/* The ✂ and ⤴ on the text side are now the ADJUSTMENT, not the only way to get any boundaries —
 * "a way to adjust those phrase cuts/joins IF WE NEED TO". They stay exactly as they were. */
ok(/function mgSplitLine/.test(app) && /function mgJoinLine/.test(app),
   'splitting and joining a line remain available for the corrections that are still needed');

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
ok(/rec\.doc\.segments = lines\.map\(\(l, i\) =>/.test(commit0),
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
ok(/const hueAt = \(i\) => Math\.round\(i \* 137\.508\) % 360/.test(draw),
   'the hue comes from the ROW NUMBER, so row i is the same colour in both cells');
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
ok(/const sp = MG\.spans\[i\];/.test(commit) && /return sp\.timeEstimated \? \{ start: sp\.start, end: sp\.end, timeEstimated: true \}/.test(commit),
   'row i\'s line takes row i\'s span, exactly — one piece of audio per line, by position');
ok(/if \(!sp \|\| sp\.timePending\) return \{ start: 0, end: 0, timePending: true \}/.test(commit),
   'a row with no real audio is written timePending');
ok(/timeEstimated: true/.test(commit), 'an estimated boundary is written back as estimated, not promoted to a measurement');
ok(/rec\.doc\.paragraphs = lines\.map/.test(commit) && /rec\.doc\.segments = lines\.map/.test(commit),
   'segments and paragraphs come out of the SAME padded list, same length and order — segments[i] IS paragraph i');

console.log('\ndragging a boundary — and it can never pass its neighbours');
{
  /* Seth: "we have to make sure you can't drag them BEYOND other boundaries they run into. Like
   * they have to stay in sequence." */
  const mv = fn(app, 'mgMoveBoundary');
  ok(!!mv, 'mgMoveBoundary exists');
  ok(/const lo = a\.start \+ MIN_SEGMENT_MS;/.test(mv) && /const hi = b\.end - MIN_SEGMENT_MS;/.test(mv),
     'clamped against the NEIGHBOURING SPANS — the ordering constraint in the form that cannot be got wrong');
  ok(/Math\.min\(hi, Math\.max\(lo, ms\)\)/.test(mv), 'so a drag stops at the neighbour instead of passing it');
  ok(/if \(hi <= lo\) return false;/.test(mv), 'and refuses outright when there is no room between them');
  ok(/if \(t === a\.end\) return false;/.test(mv), 'a drag that does not move it does not churn the display');
  ok(/a\.end = t;\s*\n\s*b\.start = t;/.test(mv), 'both sides of the join move together — no gap, no overlap');

  const drag = fn(app, 'mgBoundaryDrag');
  ok(/phase === 'start'[\s\S]{0,80}mgCapture\(\)/.test(drag), 'ONE undo per drag, captured at pick-up');
  ok(/phase === 'end'[\s\S]{0,40}mgDraw\(\)/.test(drag), 'and one full redraw on release');
  ok(/mgLiveBoundary\(i\)/.test(drag), 'with a cheap live repaint in between');
  const live = fn(app, 'mgLiveBoundary');
  ok(/for \(const k of \[i, i \+ 1\]\)/.test(live),
     'which touches only the two rows the boundary joins — a full redraw is 58ms and would lag the finger');
  ok(/setBoundaries/.test(live), 'and keeps the overview marks in step');

  // Both surfaces, one rule.
  ok(/onBoundaryDrag/.test(read('docs/js/audio.js')), 'the Player exposes draggable marks');
  ok(/this\._onBoundaryDrag/.test(read('docs/js/audio.js')),
     'opt-in — the Cut tab draws the same marks and must not silently gain a destructive gesture');
  /* ⚠ THE TWO BUGS THAT MADE IT "ONLY MOVE LEFT" (Seth). They compounded: one killed the drag after
   * a single move, the other made that one move jump the wrong way. */
  const aud = read('docs/js/audio.js');
  ok(/if \(layer\.children\.length === want\.length\) \{/.test(aud),
     'renderBoundaries REUSES nodes when the count is unchanged — replaceChildren destroyed the very element holding the pointer capture');
  ok(/b\.style\.pointerEvents = 'none';/.test(aud) && /const hit = document\.createElement\('i'\);/.test(aud),
     'and the grab area is a CHILD, so the drawn line stays exactly on the boundary rather than 7px off it');
  ok(/const grab = \(t0 == null\) \? 0 : t0 - ms;/.test(aud),
     'with a grab offset, so the boundary does not snap to the finger on the first move');
  ok(/this\._boundLayer\?\.replaceChildren\(\);\s*\n\s*this\.renderBoundaries\(\);/.test(aud),
     '⚠ enabling dragging FORCES a rebuild — the reuse path only rewrites `left`, so marks built before the handler existed stayed grip-less and inert');
  ok(/p\.onBoundaryDrag\?\.\(\(i, t, phase\) => mgBoundaryDrag/.test(asyncFn(app, 'mgPrepareAudio')),
     'the matcher opts in');
  ok(/player\?\.onBoundaryDrag\?\.\(null\)/.test(fn(app, 'mgClose')),
     'and opts out on the way, since the dock is shared with the editor');
  const draw = fn(app, 'mgDraw');
  ok(/if \(bi < 0 \|\| bi >= MG\.spans\.length - 1\) continue;/.test(draw),
     'the first and last edges of the recording are not boundaries and get no handle');
  ok(/const perPx = Math\.max\(1, sp\.end - sp\.start\) \/ w;/.test(draw),
     'the edge scale is frozen at pick-up, or the boundary would accelerate away from the finger');
}

console.log('\nPAIRING IS THE ROW NUMBER — nothing is picked, nothing is linked');
{
  /* Seth, 2026-09-03, after a first real text: "the mapping feels like an unnecessary extra step
   * given the way our data model works. In fact unmapped empty audio gets dropped and things break.
   * We shouldn't have the color coded matching, just make sure line numbers on left and right match
   * and then match automatically from that (and add empty text lines for extra audio at the end
   * that is unmatched)". The index-locked model already says segment i belongs to line i; the
   * matcher now says nothing more. */
  ok(!/MG\.map\b/.test(code(app)), 'there is no map at all — the pairing cannot disagree with the row order');
  const cmp = app.match(/const mgComplete = \(\) => [^;]*;/)[0];
  ok(/MG\.spans\.some\(\(sp\) => !sp\.timePending\)/.test(cmp), 'Done needs only one piece of real audio to write');
  const commit = asyncFn(app, 'mgCommit');
  ok(/for \(let i = lines\.length; i < padTo; i\+\+\)/.test(commit) && /makeSegment\(''/.test(commit),
     'audio past the last line gets a blank line each at the end — no piece is dropped for want of words');
  ok(/const padTo = MG\.spans\.reduce\(\(m, s, i\) => \(s\.timePending \? m : i \+ 1\), 0\)/.test(commit),
     'up to the last piece of REAL audio — a trailing "no audio" placeholder earns no blank line');
  ok(/const sp = MG\.spans\[i\];\s*\n\s*if \(!sp \|\| sp\.timePending\) return \{ start: 0, end: 0, timePending: true \}/.test(commit),
     'a line past the last piece of audio is written timePending — the engine\'s own word for it');
  ok(/blankAdded/.test(commit) && /mg\.committedLeftover/.test(commit),
     'both are REPORTED after the save — padded is fine, padded silently is not');
  const draw = fn(app, 'mgDraw');
  ok(/mg\.countsMatch/.test(draw) && /mg\.moreAudio/.test(draw) && /mg\.moreText/.test(draw),
     'the status line says the two counts, and what Done will do about a difference, up front');
  ok(!/mgCapture/.test(fn(app, 'mgPick')), 'the number badge only highlights the pair — there is nothing to undo');
}

console.log('\nplaceholders KEEP THEIR ROW, and the uncut remainder is never lost');
{
  /* Under pairing-by-row a line committed without audio must hold its place, or every line after
   * it slides up one number and pairs with the wrong sound. So the "no audio" rows are back — as
   * placeholders that say so — except when NO row has audio, where there is nothing to hold. */
  const load = fn(app, 'mgLoad');
  ok(!/\.filter\(\(sp\) => !sp\.timePending/.test(load), 'timePending entries are no longer filtered out');
  ok(/timePending: !!s\.timePending \|\| !\(Number\(s\.end\) > Number\(s\.start\)\)/.test(load),
     'an empty extent counts as no audio, whatever it was labelled');
  ok(/if \(!MG\.spans\.some\(\(sp\) => !sp\.timePending\)\) MG\.spans = \[\];/.test(load),
     'and a text with no audio anywhere starts empty, so the whole recording is seeded as one span');
  const prep = asyncFn(app, 'mgPrepareAudio');
  ok(/MG\.spans\.push\(\{ id: 'tail', start: lastEnd/.test(prep),
     'whatever follows the last piece of AUDIO is appended, so the pane accounts for the whole recording');
  ok(/const lastEnd = Math\.max\(0, \.\.\.MG\.spans\.filter\(\(s\) => !s\.timePending\)\.map\(\(s\) => s\.end\)\)/.test(prep)
     && /dur - lastEnd > 1000/.test(prep),
     'measured from the last REAL span (a trailing placeholder ends at 0), with coverTail\'s 1s tolerance');
}

console.log('\none list, row i left beside row i right');
{
  /* Seth: "we don't even completely need our two panes to scroll independently. Because they
   * should be matching one to one. And when they don't, the solution is to split, join, or add
   * empty lines (adding new lines on the text side only)." */
  const draw = fn(app, 'mgDraw');
  ok(/<ul class="mg-rows" id="mg-rows"><\/ul>/.test(draw) && !/mg-list/.test(draw), 'one list, not two panes');
  ok(/const spanEls = \[\]/.test(draw) && /const lineEls = \[\]/.test(draw) && /row\.append\(left, right\)/.test(draw),
     'the cells are built per side and zipped into rows by index');
  ok(/t\('mg\.noAudioCell'\)/.test(draw) && /t\('mg\.noLineCell'\)/.test(draw),
     'a side that runs out shows an empty cell saying what Done will do about it');
  ok(/cell\.appendChild\(mgInsertRow\(i\)\)/.test(draw) && !/left\.appendChild\(mgInsertRow/.test(draw),
     'the + rows live on the TEXT side only');
  ok(/right\.appendChild\(mgInsertRow\(MG\.lines\.length - 1\)\)/.test(draw),
     'including inside an empty text cell, where a blank line is exactly what is missing');
  ok(/\.mg-row\{display:grid;grid-template-columns:1fr 1fr/.test(css) && !/\.mg-panes\{/.test(css),
     'styled as rows, and the pane rules are gone');
  ok(/@media \(max-width:820px\)\{\s*\.mg-rowhead\{display:none\}\s*\.mg-row\{grid-template-columns:1fr/.test(css),
     'on a phone the two cells stack inside the row — still one scroll, still one pair');
}

console.log('\nboth ⤴ buttons are wired — the text one was not');
{
  const draw = fn(app, 'mgDraw');
  ok(/\.mg-join'\)\.onclick = \(\) => mgJoinSpan/.test(draw), 'the audio row joins spans');
  ok(/\.mg-join'\)\.onclick = \(\) => mgJoinLine/.test(draw),
     'and the text row joins lines (it rendered, enabled correctly, and did nothing)');
}

console.log('\nundo/redo over the MATCHER\'s state, not the document\'s');
{
  const snap = app.match(/const mgSnap = \(\) => \(\{[\s\S]*?\}\);/);
  ok(!!snap && /function mgCapture/.test(app), 'there is a snapshot ring');
  ok(!!snap && /selSpan: MG\.selSpan, selLine: MG\.selLine/.test(snap[0]),
     'selection is part of the SNAPSHOT itself — else undoing a pairing leaves the first click still armed');
  ok(!!snap && /phrases: structuredClone/.test(snap[0]),
     'and the phrases are deep-copied, or an undo would hand back the same objects it just edited');
  ok(/player\?\.clearSpan\?\.\(\)/.test(fn(app, 'mgApply')),
     'applying a snapshot clears the span watcher, as applyUndoState does in the editor');
  for (const f of ['mgSplitSpan', 'mgJoinSpan', 'mgSplitLine', 'mgJoinLine']) {
    ok(/mgCapture\(\);/.test(fn(app, f)), `${f} captures before changing anything`);
  }
  ok(/mgCapture\(\);\s*\/\/ replacing every span/.test(app), 'and so does ✨ Guess');
  ok(!/mgCapture/.test(fn(app, 'mgPick')), 'selecting is not an edit, so it captures nothing');
  ok(/mgUndoStack = \[\]; mgRedoStack = \[\]/.test(asyncFn(app, 'mgOpen')), 'history is per text, not per app');
  // The Enter handler now sits between the gate and the undo chord, hence the wider window.
  ok(/if \(!MG\) return;[\s\S]{0,900}metaKey \|\| e\.ctrlKey/.test(fn(app, 'setupSegmenterMode')),
     'the keyboard shortcuts are gated on the matcher being open, so they cannot shadow the browser elsewhere');
}

console.log('\nblank lines, for audio that deserves a line but has no words yet');
{
  ok(/function allowBlankLinesOn\(\) \{ return !Sync\.hasSession\(\) \|\| settings\.allowBlankLines === true; \}/.test(app),
     'researcher-settable, on by default with no researcher session — same shape as allowDeleteOn');
  const ins = fn(app, 'mgInsertLine');
  ok(/makeSegment\(''/.test(ins), 'it inserts the engine\'s own empty phrase');
  ok(/above\.paraOf/.test(ins), 'inheriting paraOf, so inserting inside a sentence does not start a new one');
  ok(/mgCapture\(\);/.test(ins), 'and it is undoable');
  ok(/if \(allowBlankLinesOn\(\)\)/.test(fn(app, 'mgDraw')), 'the + rows appear only when allowed');
}

console.log('\na matched pair scrolls and highlights together');
{
  const link = fn(app, 'mgLinkPair');
  ok(!!link, 'mgLinkPair exists');
  ok(/followLine\(line, true, mgFollowLine, player\)/.test(link),
     'using the SHARED followLine, so the 4s stand-off after a user scroll applies here too');
  ok(/#mg-rows \.mg-line\[data-ln=/.test(link), 'and it finds the line in the one shared list');
  const ticker = fn(app, 'mgStartTicker');
  ok(/if \(rolling\) mgLinkPair\(row\.dataset\.ln \|\| null\)/.test(ticker),
     'and it follows PLAYBACK, not only clicks — the partner is the row\'s own data-ln, set by index');
}

console.log('\nwork in progress is autosaved — losing it was the one unacceptable failure');
{
  /* Seth lost a session: "I was partway through my work and I lost it all… we don't want that to
   * happen with real work later… It should be auto-saving just like the rest of our app does." */
  const save = fn(app, 'mgSaveDraft');
  ok(!!save, 'there is a draft autosave');
  ok(/}, 400\);/.test(save), 'on the same 400ms debounce as schedulePersist — "like the rest of our app"');
  ok(/mgSaveDraft\(\);/.test(fn(app, 'mgDraw')),
     'hung off mgDraw, the one chokepoint every change passes through, so no verb can forget it');
  ok(!/rec\.modified/.test(code(save)),
     '⚠ it does NOT bump modified — that drives upload staleness, and a draft is not a content change');
  ok(/hasDraft: !!\(matchDraft/.test(read('docs/js/db.js')),
     'the list projects a FLAG, never the draft (which holds every line of the text)');
  const open = asyncFn(app, 'mgOpen');
  ok(/const draft = rec\.matchDraft;/.test(open) && /MG\.resumed/.test(open),
     'reopening resumes it rather than asking — the draft is newer than the doc by construction');
  const prep = asyncFn(app, 'mgPrepareAudio');
  ok(/dur > 0 && !MG\.resumed/.test(prep),
     'and a resumed draft is not re-seeded or given a tail, which would invent spans the user did not make');
  ok(/await mgClearDraft\(MG\.docId\)/.test(asyncFn(app, 'mgCommit')), 'Done clears it');
  /* ⚠ TWO WRITERS, ONE RECORD. mgSaveDraft re-reads the record from storage; persist() writes the
   * `current` object captured when the text was opened, and `current` never learns about a draft
   * written after that moment — so the next persist() puts the record back with the draft it
   * remembers, which is the STARTING state. Seth: "It said my work was saved, but what was saved
   * was the starting state." Ordering cannot fix a last-write-wins race; the writers have to agree
   * on the value, so the draft is written to both. */
  ok(/if \(current && current\.id === id\) current\.matchDraft = rec\.matchDraft;/.test(save),
     'the draft is written to `current` as well as to storage, or persist() silently reverts it');
  ok(/if \(current && current\.id === id\) delete current\.matchDraft;/.test(asyncFn(app, 'mgClearDraft')),
     'and clearing follows the same rule, or a cleared draft comes back');
  const close = fn(app, 'mgClose');
  ok(!/mgClearDraft/.test(close),
     '⚠ and BACK DOES NOT — a control that throws away an hour of work on one tap has no business being the way out');
  const over = asyncFn(app, 'mgStartOver');
  ok(/confirmDialog/.test(over) && /mgClearDraft/.test(over),
     'the only deliberate discard asks first, because destroying the draft is its whole job');
}

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
ok(/\.mg-span \.mg-wavewrap\{grid-column:3;grid-row:1;position:relative/.test(css),
   'the wave WRAPPER holds the grid cell and is the positioned ancestor (the cursor and the edge handles sit in it)');
ok(/\.mg-span \.seg-wave\{width:100%/.test(css), 'and the canvas fills it');
ok(/\.mg-rows\{[^}]*overflow:auto/.test(css), 'the one list scrolls — the pair is the row, so there is nothing to scroll apart');
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

console.log('\ntext ⤴ joins PHRASES into one — two phrases in a paragraph is what the next open re-splits');
{
  /* Found by the release audit (2026-09-03): the join committed a paragraph holding two segments;
   * mgOpen's healFlatSegments then promoted each back to its own paragraph and cleared doc.segments
   * to re-derive them — with no per-phrase time attributes to derive from. The join AND the whole
   * alignment were gone, and persist() wrote the wipe. */
  const join = fn(app, 'mgJoinLine');
  ok(/phrases: \[mergePhrases\(\[\.\.\.prev\.phrases, \.\.\.cur\.phrases\]\)\]/.test(join),
     'the merged line holds ONE phrase, built by mergePhrases (segments.js\'s mergeSegments joins AUDIO spans)');
  ok(!/phrases: \[\.\.\.prev\.phrases, \.\.\.cur\.phrases\]/.test(join),
     '⚠ and never the two side by side');
  /* A draft autosaved by v567 still holds the lines IT joined as two phrases (Seth's first real
   * text carried nine). The join fix cannot reach a draft that already exists; Done can. */
  ok(/segments: l\.phrases\.length > 1 \? \[mergePhrases\(l\.phrases\)\] : l\.phrases/.test(asyncFn(app, 'mgCommit')),
     'and Done merges a two-phrase line that an older draft may still carry');
  const split = fn(app, 'mgSplitLine');
  ok(/if \(flat\[k\]\.punct\) continue;/.test(split),
     'a split maps the VISIBLE word index onto the unfiltered word list (the pane hides punctuation)');
  ok(/mk\(flat\.slice\(0, at\), left, 'a'\), mk\(flat\.slice\(at\), right, 'b'\)/.test(split),
     'and the halves get distinct ids by construction, not by comparing free translations');
  ok(split.indexOf('mgCapture()') > split.indexOf("toast(t('mg.badSplit'))"),
     'a refused split leaves no undo step behind');
}

console.log('\nDone points `current` at the committed record — or the next update flush reverts it');
{
  /* persist() writes `current`; mgOpen set it to the PRE-session record and mgCommit wrote a fresh
   * copy. persist()'s "skip on the list" guard reads #view-texts, which this shell does not have,
   * so applyUpdateIfSafe() → persist() put the old record back over the commit — after the draft
   * was already cleared — and stamped it modified, queueing the reverted text for upload. */
  const commit = asyncFn(app, 'mgCommit');
  ok(/await db\.putDoc\(rec\);\s*(\/\*[\s\S]*?\*\/\s*)?current = rec;/.test(commit),
     'mgCommit assigns current = rec right after the write');
  ok(!/#view-texts|view-texts/.test(shell), '(the shell really has no #view-texts, so the guard cannot be relied on)');
}

console.log('\nan older draft still resumes — its spans and lines, with any map it carried ignored');
{
  const open = asyncFn(app, 'mgOpen');
  ok(/MG\.spans = draft\.spans;\s*\n\s*MG\.lines = draft\.lines;/.test(open) && !/draft\.map/.test(open),
     'a v567–v570 draft (149 cuts, nine joins, a map of picks) comes back as rows; the picks are simply not a thing any more');
}

console.log('\n✂ on the big player cuts the piece under the playhead (Seth, 2026-09-04)');
{
  const cut = fn(app, 'mgSplitAtPlayhead');
  ok(/player\?\.playheadMs\?\.\(\)/.test(cut), 'it reads the dock\'s playhead');
  ok(/!s\.timePending && head > s\.start && head < s\.end/.test(cut), 'and finds the REAL piece the playhead is inside');
  ok(/mgSplitSpan\(sp\.id\)/.test(cut), 'then cuts it with the row\'s own verb — one implementation of a cut');
  ok(/toast\(t\('mg\.cutNoSpan'\)/.test(cut), 'and says so when the playhead is between pieces or at 0');
  const prep = asyncFn(app, 'mgPrepareAudio');
  ok(/p\.el\.cut\.hidden = false; p\.el\.cut\.onclick = \(\) => mgSplitAtPlayhead\(\)/.test(prep), 'the matcher shows and wires the button');
  ok(/player\.el\.cut\.hidden = true/.test(fn(app, 'mgClose')), 'and hides it again on the way out — the dock is shared');
  ok(/cut: root\.querySelector\('\.player-cut'\)/.test(read('docs/js/audio.js')), 'the Player only looks it up; it never cuts');
  ok(/class="player-cut icon-btn2" data-i18n-title="player\.cut" hidden/.test(shell), 'the segmenter shell carries it, hidden by default');
  ok(!/player-cut/.test(read('docs/index.html')), 'the editor\'s dock does not — the Cut tab has its own Enter');
  ok(/e\.key === 'Enter'[^\n]*mgSplitAtPlayhead\(\)/.test(fn(app, 'setupSegmenterMode')), 'Enter does the same, as on the Cut tab');
  for (const k of ['player.cut', 'mg.cutNoSpan']) {
    ok((read('docs/js/i18n.js').match(new RegExp(`'${k.replace(/\./g, '\\.')}': `, 'g')) || []).length === 2, `${k} in both languages`);
  }
}

console.log(fail ? `\n${fail} FAILED\n` : '\nall ok\n');
process.exit(fail ? 1 : 0);
