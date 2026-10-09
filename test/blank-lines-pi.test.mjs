/* #111 — A TEXT MOVED BETWEEN DEVICES COMES BACK WITH EVERY CUT WHERE IT WAS (v713).
 *
 * Brian: "Missing audio segments with empty baseline after moving out and back in to device." The
 * .flextext a device uploads is how a text moves, and since v709 it leaves out every line with nothing
 * in it (FLEx and ELAN must not get empty lines). v712 put the audio back as one blank line per hole —
 * so a run of untranscribed pieces came back as ONE. Seth, 2026-10-10: "Keep the upload clean and record
 * the blank pieces' times inside the file, as a hidden XML instruction that FLEx and ELAN ignore."
 *
 * Real modules throughout; the app's own healGapLines is lifted out of app.js and run on the result.
 * Run: node --test test/blank-lines-pi.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const ft = await import('../docs/js/flextext.js');
const sg = await import('../docs/js/segments.js');
const { docSegments } = await import('../docs/js/segment-strips.js');
const { serializeEaf } = await import('../docs/js/seg-exports.js');

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
function src(name) {
  const i = APP.indexOf(`\nfunction ${name}(`);
  if (i < 0) throw new Error(name + ' not found');
  let depth = 0, k = APP.indexOf('{', APP.indexOf(')', i));
  for (; k < APP.length; k++) { if (APP[k] === '{') depth++; else if (APP[k] === '}' && --depth === 0) break; }
  return APP.slice(i + 1, k + 1);
}
// The app's heal, exactly as it ships, over the real engine pieces.
const heal = new Function('fillGapLines', 'docSegments', 'isAligned', 'isSilentPhrase', 'makeSegment', `
  let g = 0; const newGuid = () => 'blank-' + (++g);
  ${src('blankGapLine')}
  ${src('healGapLines')}
  return healGapLines;`)(sg.fillGapLines, docSegments, sg.isAligned, ft.isSilentPhrase, ft.makeSegment);

const S = { vernLang: 'fau', analLang: 'en' };
const OPTS = { mediaName: 'rec.wav', segTimes: true, timeNotes: true, producedBy: 'test' };   // what Lane B uploads with
function cutText(texts, cuts) {
  const doc = ft.makeDoc(S);
  ft.reconcileBaseline(doc, texts, { flatSegments: true });
  doc.segments = texts.map((_, i) => ({ start: cuts[i], end: cuts[i + 1] }));
  return doc;
}
// What a device does with an uploaded .flextext when a text is moved to it (buildDocFromFlextextUrl + normalizePhraseLines).
function moveBack(xml) {
  const doc = ft.parseFlextext(xml, S).texts[0];
  for (const p of doc.paragraphs) if (!p.segments.length) p.segments.push(ft.makeSegment('', []));
  if (!doc.segments || !doc.segments.length) doc.segments = ft.segmentsFromOffsets(doc) || [];
  return doc;
}
const lines = (doc) => doc.paragraphs.map((p, i) => [docSegments(doc)[i].start, docSegments(doc)[i].end, p.segments.map((s) => s.baseline).join(' ')]);
const BRIAN = () => cutText(['', 'ati boro', '', '', 'dagu ke', '', '', ''], [0, 4000, 9000, 12000, 16000, 21000, 26000, 33000, 40000]);

test('the instruction: written and read back, estimates marked, junk ignored', () => {
  assert.equal(ft.BLANK_LINES_PI, 'flextext-editor');
  assert.equal(ft.blankLinesPi([{ start: 0, end: 4000 }, { start: 9000.4, end: 12000, est: true }]),
    '<?flextext-editor v="1" blank-lines="0-4000 ~9000-12000"?>');
  assert.equal(ft.blankLinesPi([]), '', 'nothing left out: no instruction');
  assert.deepEqual(ft.parseBlankLinesPi('v="1" blank-lines="0-4000 ~9000-12000"'), [{ start: 0, end: 4000 }, { start: 9000, end: 12000, est: true }]);
  assert.deepEqual(ft.parseBlankLinesPi('v="1" blank-lines="5-3 x 1-2-3 7-9"'), [{ start: 7, end: 9 }], 'reversed, garbled and three-part spans are dropped');
  assert.deepEqual(ft.parseBlankLinesPi('v="2" other="1"'), []);
});

test('the uploaded .flextext: still no empty line (v709), and the blank lines\' times in one instruction', () => {
  const xml = ft.serializeFlextext(BRIAN(), S, OPTS);
  assert.equal((xml.match(/<phrase\b/g) || []).length, 2, 'two phrases for eight pieces — FLEx and ELAN see only the lines with words');
  assert.equal((xml.match(/<\?flextext-editor /g) || []).length, 1);
  assert.match(xml, /    <\/paragraphs>\n    <\?flextext-editor v="1" blank-lines="0-4000 9000-12000 12000-16000 21000-26000 26000-33000 33000-40000"\?>\n/,
    'inside <interlinear-text>, right after the paragraphs it describes');
  const est = BRIAN(); est.segments[2].timeEstimated = true;
  assert.match(ft.serializeFlextext(est, S, OPTS), /blank-lines="0-4000 ~9000-12000 /, 'an estimated span stays an estimate');
  const full = cutText(['satu', 'dua'], [0, 1000, 2000]);
  assert.doesNotMatch(ft.serializeFlextext(full, S, OPTS), /<\?flextext-editor/, 'no blank line, no instruction — the file is as before');
  assert.doesNotMatch(ft.serializeFlextext(BRIAN(), S, { ...OPTS, segTimes: false }), /<\?flextext-editor/, 'no times written (classic editor), no instruction');
  for (const profile of ['flex', 'saymore']) {
    assert.doesNotMatch(serializeEaf(BRIAN(), { profile, vern: 'fau', anal: 'en', mediaName: 'rec.wav' }), /flextext-editor/, `the ${profile} EAF is untouched`);
  }
});

test('#111, Brian\'s steps: cut into eight, two typed, uploaded, moved off and back — eight pieces, every cut where it was', () => {
  const first = BRIAN();
  const back = moveBack(ft.serializeFlextext(first, S, OPTS));
  assert.deepEqual(back.blankLines, [[0, 4000], [9000, 12000], [12000, 16000], [21000, 26000], [26000, 33000], [33000, 40000]].map(([start, end]) => ({ start, end })),
    'the device reads the instruction');
  assert.equal(back.paragraphs.length, 2, 'what v709 showed (#111)');
  assert.equal(heal(back), true);
  assert.deepEqual(lines(back), lines(first), 'every piece, every cut, the words where they were');
  assert.equal('blankLines' in back, false, 'used once — from here on the text\'s own blank lines say it');
  assert.equal(heal(back), false, 'and healing again changes nothing');
  // and the next upload records them again, from the lines themselves
  assert.match(ft.serializeFlextext(back, S, OPTS), /blank-lines="0-4000 9000-12000 12000-16000 21000-26000 26000-33000 33000-40000"/);
});

test('a text cut and not yet typed has no line in the file at all — it still comes back as its pieces', () => {
  const first = cutText(['', '', '', ''], [0, 3000, 7000, 8000, 15000]);
  const xml = ft.serializeFlextext(first, S, OPTS);
  assert.equal((xml.match(/<phrase\b/g) || []).length, 0);
  const back = moveBack(xml);
  assert.equal(back.paragraphs.length, 1, 'the parser\'s placeholder line');
  assert.equal(heal(back), true);
  assert.deepEqual(lines(back), lines(first), 'the placeholder made way for the four recorded pieces');
});

test('a text moved here and uploaded again before anyone opened it keeps the recorded times', () => {
  const back = moveBack(ft.serializeFlextext(BRIAN(), S, OPTS));   // not healed: nobody opened it
  const again = ft.serializeFlextext(back, S, OPTS);
  assert.match(again, /blank-lines="0-4000 9000-12000 12000-16000 21000-26000 26000-33000 33000-40000"/, 'carried through');
  const third = moveBack(again); heal(third);
  assert.deepEqual(lines(third), lines(BRIAN()));
  // …but not over a line that has words there now
  const typed = moveBack(ft.serializeFlextext(BRIAN(), S, OPTS));
  typed.paragraphs.push({ guid: 'x', segments: [ft.makeSegment('baru', [ft.makeWord('baru', {})])] });
  typed.segments.push({ start: 26000, end: 33000 });
  assert.match(ft.serializeFlextext(typed, S, OPTS), /blank-lines="0-4000 9000-12000 12000-16000 21000-26000 33000-40000"/);
});

test('a file that has been through FLEx or ELAN (no instruction) falls back to v712: the audio back, the runs merged', () => {
  const xml = ft.serializeFlextext(BRIAN(), S, OPTS).replace(/\n {4}<\?flextext-editor[^\n]*\?>/, '');
  const back = moveBack(xml);
  assert.equal(back.blankLines, undefined);
  heal(back);
  assert.deepEqual(lines(back).map(([a, b]) => [a, b]), [[0, 4000], [4000, 9000], [9000, 16000], [16000, 21000]],
    'one blank line per hole; the tail is settleTail\'s once the recording\'s length is known');
});

test('fillGapLines with recorded pieces: exact where they fit, the 350 ms rule where they do not', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: i }));
  const line = () => ({ blank: true });
  const spans = (r) => r.segments.map((s) => [s.start, s.end]);
  // a stretch the pieces leave uncovered still becomes a line, from 350 ms; under it stays a hole
  let r = sg.fillGapLines(mk(2), [{ start: 1000, end: 2000 }, { start: 9000, end: 10000 }], line, { pieces: [{ start: 3000, end: 5000 }, { start: 5000, end: 8800 }] });
  assert.deepEqual(spans(r), [[0, 1000], [1000, 2000], [2000, 3000], [3000, 5000], [5000, 8800], [9000, 10000]], '0–1000 leading, 2000–3000 by the rule, 8800–9000 too short');
  // a piece that no longer fits a hole (a line was re-timed over it) is dropped; one in an open tail goes in
  r = sg.fillGapLines(mk(2), [{ start: 0, end: 2500 }, { start: 3000, end: 4000 }], line, { pieces: [{ start: 2000, end: 3000 }, { start: 4000, end: 5000 }, { start: 6000, end: 7000, est: true }] });
  assert.deepEqual(spans(r), [[0, 2500], [2500, 3000], [3000, 4000], [4000, 5000], [5000, 6000], [6000, 7000]],
    'the dropped piece\'s 500 ms that no line covers now follows the rule, like any stretch');
  assert.equal(r.segments[5].timeEstimated, true, 'an estimate comes back as one');
  // never around a line whose time is unknown
  r = sg.fillGapLines(mk(3), [{ start: 0, end: 1000 }, { timePending: true }, { start: 5000, end: 6000 }], line, { pieces: [{ start: 1000, end: 5000 }] });
  assert.equal(r.changed, false);
  // not 1:1: refused, and says so
  r = sg.fillGapLines(mk(2), [{ start: 0, end: 1000 }], line, { pieces: [{ start: 1000, end: 2000 }] });
  assert.equal(r.refused, true);
  assert.deepEqual(sg.cleanPieces([{ start: 5, end: 9 }, { start: 0, end: 6 }, { start: 3, end: 2 }, null]), [{ start: 0, end: 6 }], 'sorted, valid, no overlaps');
});

test('the pass-through downloads (v711) keep the instruction; the wiring', () => {
  const xml = ft.serializeFlextext(BRIAN(), S, OPTS);
  assert.equal(ft.stripSilentPhrasesXml(xml), xml, 'nothing silent to strip — the same string, instruction and all');
  assert.match(src('healGapLines'), /const r = fillGapLines\(paras, segs, blankGapLine, pieces \? \{ pieces \} : \{\}\);/);
  assert.match(src('healGapLines'), /if \(r\.refused\) return false;\n\s+if \('blankLines' in doc\) delete doc\.blankLines;/);
});
