/* ✨ INSIDE ONE PIECE (Seth, 2026-10-04: "the ability to 'guess' split a single segment … one way to
 * work around the ten-minute limit. So either the whole audio file if it hasn't been segmented, or a
 * selected segment"). The pure half is measured against synthetic peaks with pauses at known times,
 * like test/guess-splits.test.mjs; the Cut-tab wiring is pinned as source. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { guessSplits, guessSplitsWithin, applyGuessedSplitsWithin, GUESS_WINDOW_MS, MIN_SEGMENT_MS, edgeGuessed } from '../docs/js/segments.js';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const MPB = 0.5;   // ms per bucket, as ensurePeaks produces
// Speech is syllabic (an envelope that dips but stays well up); silence is the floor. Deterministic.
function peaksFor(script) {
  const total = script.reduce((a, [, ms]) => a + ms, 0);
  const p = new Float32Array(Math.round(total / MPB));
  let at = 0;
  for (const [kind, ms] of script) {
    const n = Math.round(ms / MPB);
    for (let i = 0; i < n; i++) p[at + i] = kind === 'speech' ? 0.6 * (0.45 + 0.55 * Math.abs(Math.sin((at + i) * MPB / 130))) : 0.01;
    at += n;
  }
  return { peaks: p, total };
}
// Three real pauses, mid-points 3500 / 7000 / 11000; a hand cut at 6000 lands inside speech.
const SCRIPT = [['speech', 3000], ['silence', 1000], ['speech', 2500], ['silence', 1000], ['speech', 3000], ['silence', 1000], ['speech', 1500]];
const { peaks, total } = peaksFor(SCRIPT);
const near = (cuts, ms, tol = 200) => cuts.some((c) => Math.abs(c - ms) <= tol);

test('the whole file through guessSplitsWithin is the whole-file guess, boundary for boundary', () => {
  const whole = guessSplits(peaks, MPB, { durationMs: total });
  assert.equal(whole.length, 3, `three pauses found in the fixture (${whole})`);
  assert.deepEqual(guessSplitsWithin(peaks, MPB, 0, total), whole);
});

test('a piece sees only its own pauses, in file time, strictly inside its edges', () => {
  const first = guessSplitsWithin(peaks, MPB, 0, 6000);
  assert.ok(near(first, 3500) && first.length === 1, `piece 1 (0–6000) has the 3500 pause and nothing else: ${first}`);
  const second = guessSplitsWithin(peaks, MPB, 6000, total);
  assert.ok(near(second, 7000) && near(second, 11000) && second.length === 2, `piece 2 (6000–end) has 7000 and 11000: ${second}`);
  assert.ok(second.every((c) => c > 6000 && c < total), 'nothing on or beyond the piece\'s edges');
  assert.deepEqual(guessSplitsWithin(peaks, MPB, 4100, 4300), [], 'a sliver of a piece has no pauses to offer');
  assert.deepEqual(guessSplitsWithin(peaks, MPB, 6000, 6000), [], 'an empty range is refused, not a crash');
});

test('applyGuessedSplitsWithin replaces ONE piece and carries everything else over untouched', () => {
  const segs = [{ start: 0, end: 6000 }, { start: 6000, end: total, timeEstimated: true }];
  const paras = ['first piece has words', ''];
  const r = applyGuessedSplitsWithin(segs, paras, 1, [11000, 7000, 7000], { duration: total });
  assert.equal(r.ok, true);
  assert.equal(r.added, 2, 'unsorted and duplicate boundaries are handled');
  assert.deepEqual(r.segments[0], { start: 0, end: 6000 }, 'the texted neighbour is byte-for-byte what it was');
  assert.deepEqual(r.segments.slice(1).map((s) => [s.start, s.end]), [[6000, 7000], [7000, 11000], [11000, total]]);
  assert.ok(r.segments.slice(1).every((s) => s.timeEstimated === true), 'the piece\'s own flags travel with its pieces');
  // v717, per edge: the detector's boundaries are guesses; the piece's own end is the last line's (C0).
  assert.deepEqual(r.segments.slice(1).map((s) => [edgeGuessed(s, 0), edgeGuessed(s, 1)]), [[true, true], [true, true], [true, false]]);
  const real = applyGuessedSplitsWithin([{ start: 0, end: 6000 }, { start: 6000, end: total }], ['words', ''], 1, [11000, 7000]);
  assert.deepEqual(real.segments.slice(1).map((s) => [edgeGuessed(s, 0), edgeGuessed(s, 1)]), [[false, true], [true, true], [true, false]],
    'a real piece keeps its real outer edges; only the detected boundaries are guesses');
  assert.deepEqual(r.paragraphs, ['first piece has words', '', '', ''], 'paragraph i becomes k+1 empty lines; the texted line keeps its text');
  assert.deepEqual(segs, [{ start: 0, end: 6000 }, { start: 6000, end: total, timeEstimated: true }], 'inputs are not mutated');
});

test('it refuses a texted piece, an untimed piece, a bad index, and boundaries that would mint slivers', () => {
  const segs = [{ start: 0, end: 6000 }, { start: 6000, end: total }];
  assert.equal(applyGuessedSplitsWithin(segs, ['words', ''], 0, [3500]).reason, 'hasText');
  assert.equal(applyGuessedSplitsWithin([{ timePending: true }, segs[1]], ['', ''], 0, [3500]).reason, 'noAudio');
  assert.equal(applyGuessedSplitsWithin(segs, ['', ''], 2, [3500]).reason, 'outside');
  assert.equal(applyGuessedSplitsWithin(segs, ['', ''], 1, [6000 + MIN_SEGMENT_MS - 1, total - 1, 100]).reason, 'none',
    'a boundary within minMs of either edge, or outside the piece, is dropped — and nothing left means none');
  const r = applyGuessedSplitsWithin(segs, ['', ''], 1, [7000, 7000 + MIN_SEGMENT_MS - 1, 11000]);
  assert.equal(r.added, 2, 'a boundary within minMs of the previous kept one is dropped, the next good one kept');
});

/* ── the Cut tab's wiring ── */
const STRIPS = rd('../docs/js/segment-strips.js'), I18N = rd('../docs/js/i18n.js'), PANEL = rd('../docs/js/researcher-panel.js');
const fn = (src, name) => { const i = src.indexOf(`function ${name}(`); return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i)); };

test('two modes, one button: whole-file in the two safe states, the piece under the playhead otherwise', () => {
  assert.match(STRIPS, /function guessMode\(segs, paras, doc\) \{ return guessAllowedHere\(segs, paras, doc\) \? 'all' : 'piece'; \}/);
  const render = fn(STRIPS, 'renderCut');
  assert.match(render, /const mode = guessMode\(segs, paras, doc\);\n\s+guess\.hidden = false;/, 'renderCut never hides ✨ any more; it picks the mode');
  assert.match(render, /guess\.dataset\.mode = mode;/, 'and tells the ticker which mode it is in');
  assert.match(render, /\} else \{\n\s+syncGuessPiece\(true\);/, 'piece mode: the button describes the piece under the playhead');
  assert.match(STRIPS, /syncGuessPiece\(false\);\s+\/\/ ✨ is about the piece under the playhead/, 'the ticker re-asks as the playhead moves');
  const sync = fn(STRIPS, 'syncGuessPiece');
  assert.match(sync, /if \(!force && i === guessPieceIdx\) return;/, '…but only does work when the piece changes');
  assert.match(fn(STRIPS, 'cutGuessSplits'), /if \(guessMode\(cutSegs\(\), paras, doc\) === 'piece'\) return cutGuessPiece\(\);/, 'a press routes on the model');
});

test('the piece guess: scoped, capped per piece, one undo step, no confirm, nothing with words', () => {
  const blocked = fn(STRIPS, 'pieceBlockedBecause');
  assert.match(blocked, /if \(!seg \|\| !isAligned\(seg\)\) return T\('cut\.no\.guessPiecePick'\);/);
  assert.match(blocked, /paraHasWork\(doc, i\)\) return T\('cut\.no\.guessPieceText'\);/, 'the PIECE must be empty — other lines may have words');
  assert.doesNotMatch(blocked, /GUESS_MAX_MS|GUESS_WINDOW_MS|guessPieceLong/, 'no length refusal for the piece (#93, v706): a long piece is guessed in windows');
  assert.match(fn(STRIPS, 'pieceCuts'), /guessSplitsWindowed\(peaksCache\.peaks, [^\n]*, seg\.start, seg\.end\)/, '…by the same windowed detector the whole-file guess uses');
  const piece = fn(STRIPS, 'cutGuessPiece');
  assert.ok(piece, 'cutGuessPiece exists');
  assert.match(piece, /applyGuessedSplitsWithin\(segs, paras, i, pieceCuts\(segs\[i\], i\)/, 'the probe and the press share one detector call');
  assert.doesNotMatch(piece, /confirmReplace/, 'no confirm: nothing anyone made is replaced');
  assert.ok(piece.indexOf('cutDeps.capture()') < piece.indexOf('doc.segments = r.segments'), 'one undo step, captured before the write');
  assert.match(piece, /clearSpan\?\.\(\)/, 'a live span watcher is dropped, as cutHere does');
  assert.match(piece, /renderCut\(i\);/, 'the piece\'s first row holds still');
  assert.match(fn(STRIPS, 'pieceCuts'), /pieceProbe\.gen !== peaksGen/, 'the per-piece probe is cached per peaks generation');
  assert.ok(GUESS_WINDOW_MS === 10 * 60 * 1000);
});

test('the words: EN and ID, and the long-recording refusals are gone with the cap', () => {
  for (const k of ['cut.guessPiece', 'cut.guessPieceTip', 'cut.guessPieceDone', 'cut.no.guessPiecePick', 'cut.no.guessPieceText',
                   'cut.no.guessPieceNone', 'player.loop', 'panel.rel.new.guessPiece']) {
    assert.equal((I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  }
  assert.doesNotMatch(I18N, /'cut\.no\.guessManual'/, 'the sentence for the hidden button went with the rule');
  assert.doesNotMatch(I18N, /'cut\.no\.guessLong'|'cut\.no\.guessPieceLong'/, 'the two refusal sentences went with the cap (#93, v706)');
  const hints = I18N.match(/'cut\.hint(?:NoJoinKey)?(?:Drag)?': '[^\n]*/g);
  assert.equal(hints.length, 8, 'four hint variants × two languages');
  assert.ok(hints.every((h) => /piece under the playhead|bagian tempat posisi putar/.test(h)), 'every hint describes the piece guess');
  assert.match(PANEL, /\{ v: 'v701', date: '2026-10-04', items: \[\n    \{ k: 'panel\.rel\.new\.guessPiece', issue: 93 \},/);
});

test('✨ sits on the dock, far right, and is the Cut tab\'s: shown by renderCut, hidden by stopCut (v701)', () => {
  for (const shell of ['../docs/index.html', '../satellites/audio-segmenter/index.html']) {
    const html = rd(shell);
    /* ⚠ THE CLAIM IS "LAST", NOT "WITHIN N CHARACTERS OF ✕". The window was 1200 until v719 put the
       two gap controls (and their comment) between them, which is exactly where they belong — ✨
       keeps the far-right corner because `.player-guess { margin-left: auto }` and because it is the
       final element before </div>. Both halves are still asserted; only the slack grew. */
    assert.match(html, /class="player-remove icon-btn2"[\s\S]{0,2000}?<button id="btn-guess-splits" class="player-guess icon-btn2" data-i18n-title="cut\.guess"\n\s+data-i18n-aria="cut\.guess" aria-label="Guess the lines" hidden>✨<\/button>\n\s+<\/div>/, `${shell}: last control on the dock, hidden until the Cut tab shows it`);
    assert.doesNotMatch(html, /id="cut-tools-label"/, `${shell}: the "Guess" word beside it is gone with the row`);
  }
  assert.match(fn(STRIPS, 'stopCut'), /guess\.hidden = true;/, 'leaving the Cut tab hides it');
  assert.match(fn(STRIPS, 'renderCut'), /guess\.hidden = false;/, 'rendering the Cut tab shows it');
  assert.doesNotMatch(rd('../docs/js/audio.js'), /btn-guess-splits|player-guess/, 'the Player never touches it');
  const css = rd('../docs/css/app.css');
  assert.match(css, /\.player-guess \{ margin-left: auto; \}/);
  assert.match(css, /\.player-guess:disabled \{ opacity: \.5;/);
  assert.doesNotMatch(I18N, /'cut\.guessShort'/);
});
