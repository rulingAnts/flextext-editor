/* THE v717 REVIEW'S DATA-SAFETY AND EXPORT FINDINGS, each pinned (time-truth v2). Three reviewers ran
 * v717 against v716 and found the places where a time still went to the wrong line, a guess still
 * went out as a measurement, or a file's own time was dropped. Every test here failed on the first
 * v717 (04538a42) and passes now; what each one guards is said at the test.
 *
 * Engine only — the app.js halves (Undo, the switch, opening a text) are time-truth-review-app. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture, openXml, fixtureXml, DURATION, ft } from './lib/timing-fixtures.mjs';
import * as SEG from '../docs/js/segments.js';
import { serializeEaf, buildFxpa } from '../docs/js/seg-exports.js';

const { serializeFlextext, reconcileBaselineWithOrigins, readLegacyEstimates, getBaselineParagraphs, makeDoc, reconcileBaseline } = ft;
const { isAligned, isEstimate, edgeGuessed, segmentsFollowLines, syncToLines } = SEG;
const SET = { vernLang: 'fau', analLang: 'id' };
const times = (segs) => segs.map((s) => (isAligned(s) ? [s.start, s.end] : null));
const edges = (s) => (isAligned(s) ? `${s.start}${edgeGuessed(s, 0) ? '~' : ''}-${s.end}${edgeGuessed(s, 1) ? '~' : ''}` : '-');
const phrasesOf = (xml) => [...xml.matchAll(/<phrase\b([^>]*)>([\s\S]*?)<\/phrase>/g)].map((m) => {
  const b = /begin-time-offset="(\d+)"/.exec(m[1]), e = /end-time-offset="(\d+)"/.exec(m[1]);
  return { b: b ? +b[1] : null, e: e ? +e[1] : null, tilde: />audio ~/.test(m[2]) };
});
const roundTrip = (doc, opts) => openXml(serializeFlextext(doc, SET, opts));

/* applyBaseline's timed path, exactly: the reconcile says where each line came from, the times follow. */
function boxEdit(doc, lines) {
  const old = doc.segments, count = doc.paragraphs.length;
  const origins = reconcileBaselineWithOrigins(doc, lines, { flatSegments: true });
  doc.segments = old.length === count ? segmentsFollowLines(old, origins) : syncToLines(old, doc.paragraphs.length);
  return origins;
}
// A timed text from words: line i is `texts[i]`, at `cuts[i]`–`cuts[i+1]`, its free translation "FT-<text>".
function timedXml(texts, cuts) {
  const ph = texts.map((t, i) => `<paragraph guid="p${i}"><phrases><phrase guid="ph${i}" begin-time-offset="${cuts[i]}" end-time-offset="${cuts[i + 1]}">`
    + `<item type="txt" lang="fau">${t}</item><words>${t.split(' ').filter(Boolean).map((w) => `<word><item type="txt" lang="fau">${w}</item></word>`).join('')}</words>`
    + `<item type="gls" lang="id">FT-${t}</item></phrase></phrases></paragraph>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?><document version="2"><interlinear-text guid="t"><item type="title" lang="id">T</item><paragraphs>${ph}</paragraphs>`
    + '<languages><language lang="fau" vernacular="true"/><language lang="id"/></languages></interlinear-text></document>';
}
const lineTimes = (doc) => Object.fromEntries(getBaselineParagraphs(doc).map((t, i) => [t || `(blank ${i})`, isAligned(doc.segments[i]) ? [doc.segments[i].start, doc.segments[i].end] : null]));

/* ── 1. a moved line ──────────────────────────────────────────────────────────────────────────── */

test('the text box: a line MOVED keeps its words, not its time — every line it passes keeps its own (data-safety 1)', () => {
  const T = ['aa bb', 'cc dd', 'ee ff', 'gg hh', 'ii jj', 'kk ll'];
  const CUTS = [0, 1300, 2700, 4200, 5100, 6900, 8000];
  const doc = openXml(timedXml(T, CUTS));
  const origins = boxEdit(doc, ['aa bb', 'ii jj', 'cc dd', 'ee ff', 'gg hh', 'kk ll']);   // "ii jj" cut and pasted two lines up
  assert.equal(origins[1].moved, true, 'the reconcile says which line moved');
  assert.deepEqual(lineTimes(doc), { 'aa bb': [0, 1300], 'ii jj': null, 'cc dd': [1300, 2700], 'ee ff': [2700, 4200], 'gg hh': [4200, 5100], 'kk ll': [6900, 8000] },
    'v717 first gave ii jj its 5100–6900 and took the times of the three lines it passed');
  assert.equal(doc.paragraphs[1].segments[0].free, 'FT-ii jj', 'the moved line is still that line: its translation went with it');
  const back = roundTrip(doc);
  assert.deepEqual(lineTimes(back), lineTimes(doc), 'and an export and re-import keep every one of those times');
  const cuts = new Set(back.segments.filter(isAligned).flatMap((s) => [s.start, s.end]));
  assert.ok(CUTS.every((c) => cuts.has(c)), 'no cut in the file is lost');
});

test('the text box: a BLANK line moved yields to the worded lines it passes (data-safety 1, second shape)', () => {
  const doc = makeDoc(SET);
  reconcileBaseline(doc, ['', '', 'aa', 'bb cc dd', '', 'ee ff'], { flatSegments: true });
  doc.segments = [0, 1, 2, 3, 4, 5].map((i) => ({ start: i * 1000, end: i * 1000 + 1000 }));
  boxEdit(doc, ['', '', '', 'aa', 'bb cc dd', 'ee ff']);   // Enter before "aa", Backspace on the later blank
  assert.deepEqual(times(doc.segments), [[0, 1000], [1000, 2000], null, [2000, 3000], [3000, 4000], [5000, 6000]],
    'aa and "bb cc dd" keep their times; the blank that changed places has none');
  const swap = makeDoc(SET);
  reconcileBaseline(swap, ['aa bb', 'cc', '', 'dd ee ff'], { flatSegments: true });
  swap.segments = [0, 1, 2, 3].map((i) => ({ start: i * 1000, end: i * 1000 + 1000 }));
  boxEdit(swap, ['aa bb', '', 'cc', 'dd ee ff']);
  assert.deepEqual(times(swap.segments), [[0, 1000], null, [1000, 2000], [3000, 4000]], 'a worded line outweighs a blank one');
});

function rng(seed) { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
test('property: one line moved anywhere — every other line keeps exactly its own time', () => {
  let moves = 0;
  for (let run = 0; run < 400; run++) {
    const r = rng(run + 7);
    const n = 4 + Math.floor(r() * 9);
    let w = 0;
    const T = Array.from({ length: n }, () => (r() < 0.2 ? '' : Array.from({ length: 1 + Math.floor(r() * 4) }, () => 'w' + (++w)).join(' ')));
    const doc = makeDoc(SET);
    reconcileBaseline(doc, T, { flatSegments: true });
    doc.segments = T.map((_, i) => ({ start: i * 1000, end: i * 1000 + 1000 }));
    const before = getBaselineParagraphs(doc).map((t, i) => [t, i]);
    const k = Math.floor(r() * n), to = Math.floor(r() * n);
    if (k === to) continue;
    const L = T.slice(); const [x] = L.splice(k, 1); L.splice(to, 0, x);
    boxEdit(doc, L);
    moves++;
    const kept = doc.segments.map((s, j) => (isAligned(s) ? s.start / 1000 : null));
    // Every line keeps its own time or has none; never another line's.
    getBaselineParagraphs(doc).forEach((t, j) => {
      if (kept[j] == null) return;
      assert.equal(T[kept[j]], t, `run ${run}: line ${j} plays the line it is`);
    });
    // And at most ONE line lost its time — unless the move was a blank line among blanks (then the
    // reconcile cannot tell which blank moved, and a different, equally blank one may yield).
    const lost = kept.filter((v) => v == null).length;
    if (x) assert.ok(lost <= 1, `run ${run}: one line moved, ${lost} lost their time`);
  }
  assert.ok(moves > 300);
});

/* ── 2. two edits that cancel out in line count ───────────────────────────────────────────────── */

function four(lines) {
  const doc = makeDoc(SET);
  reconcileBaseline(doc, lines, { flatSegments: true });
  doc.segments = lines.map((_, i) => ({ start: i * 1000, end: i * 1000 + 900 }));
  doc.paragraphs.forEach((p, i) => { p.segments[0].free = 'FT-' + lines[i]; });
  return doc;
}
const view = (doc) => getBaselineParagraphs(doc).map((t, i) => [t, isAligned(doc.segments[i]) ? doc.segments[i].start : null, doc.paragraphs[i].segments[0].free || '']);

test('two edits that cancel out in line count pair by the WORDS, not by position (data-safety 2)', () => {
  const a = four(['aa a1', 'bb b1', 'cc c1', 'dd d1']);
  boxEdit(a, ['aa a1', 'cc c1x', 'new n1', 'dd d1']);   // delete b, fix a typo in c, add a line
  assert.deepEqual(view(a), [['aa a1', 0, 'FT-aa a1'], ['cc c1x', 2000, 'FT-cc c1'], ['new n1', null, ''], ['dd d1', 3000, 'FT-dd d1']],
    'v717 first gave "cc c1x" bb\'s time and translation, and "new n1" cc\'s');
  const b = four(['aa a1', 'bb b1', 'cc c1', 'dd d1', 'ee e1']);
  boxEdit(b, ['aa a1', 'cc c1 x', 'bb b1 y', 'ee e1']);   // two lines swapped and edited, one deleted
  assert.deepEqual(view(b).map((r) => r.slice(0, 2)), [['aa a1', 0], ['cc c1 x', 2000], ['bb b1 y', null], ['ee e1', 4000]],
    '"bb b1 y" is bb, moved — never a rewrite of dd in dd\'s slot');
  const c = four(['aa a1', 'x', 'y', 'dd d1']);
  boxEdit(c, ['aa a1', 'xx', 'yy', 'dd d1']);   // two one-word lines with typos: nothing to go on but the order
  assert.deepEqual(view(c).map((r) => r.slice(0, 3)), [['aa a1', 0, 'FT-aa a1'], ['xx', 1000, 'FT-x'], ['yy', 2000, 'FT-y'], ['dd d1', 3000, 'FT-dd d1']],
    'a typo fix keeps its line, even with no word in common, where nothing points elsewhere');
});

test('property: one to three random text-box edits — a line only ever holds the time of a line it has words of, or of the line it REPLACED in place', () => {
  let runs = 0, replaced = 0;
  for (let run = 0; run < 2000; run++) {
    const r = rng(run + 101);
    const n = 4 + Math.floor(r() * 8);
    let w = 0;
    const word = () => 'w' + (++w);
    const sentence = () => Array.from({ length: 2 + Math.floor(r() * 4) }, word).join(' ');
    const lines = Array.from({ length: n }, sentence);
    const owner = new Map(); lines.forEach((t, i) => t.split(' ').forEach((x) => owner.set(x, i)));
    const doc = makeDoc(SET);
    reconcileBaseline(doc, lines, { flatSegments: true });
    doc.segments = lines.map((_, i) => ({ start: i * 1000, end: i * 1000 + 1000 }));
    let cur = lines.slice();
    for (let o = 0, ops = 1 + Math.floor(r() * 3); o < ops; o++) {
      const p = r();
      if (p < 0.2 && cur.length > 1) { const k = Math.floor(r() * cur.length); const [x] = cur.splice(k, 1); cur.splice(Math.floor(r() * (cur.length + 1)), 0, x); }
      else if (p < 0.4 && cur.length > 1) { const k = Math.floor(r() * (cur.length - 1)); cur.splice(k, 2, cur[k] + ' ' + cur[k + 1]); }
      else if (p < 0.6) { const k = Math.floor(r() * cur.length); const ws = cur[k].split(' '); if (ws.length > 1) { const c = 1 + Math.floor(r() * (ws.length - 1)); cur.splice(k, 1, ws.slice(0, c).join(' '), ws.slice(c).join(' ')); } }
      else if (p < 0.75 && cur.length > 1) cur.splice(Math.floor(r() * cur.length), 1);
      else if (p < 0.9) cur.splice(Math.floor(r() * (cur.length + 1)), 0, sentence());
      else { const k = Math.floor(r() * cur.length); const ws = cur[k].split(' '); const j = Math.floor(r() * ws.length); ws[j] += 'x'; cur[k] = ws.join(' '); }
    }
    if (JSON.stringify(cur) === JSON.stringify(lines)) continue;
    boxEdit(doc, cur);
    runs++;
    const surviving = new Set(cur.flatMap((t) => t.split(' ').map((x) => owner.get(x.replace(/x$/, ''))).filter((v) => v != null)));
    cur.forEach((t, j) => {
      const s = doc.segments[j];
      if (!isAligned(s)) return;
      const mine = new Set(t.split(' ').map((x) => owner.get(x.replace(/x$/, ''))).filter((v) => v != null));
      const covered = []; for (let i = 0; i < n; i++) if (s.start < i * 1000 + 1000 && s.end > i * 1000) covered.push(i);
      if (covered.some((i) => mine.has(i))) return;
      // Foreign time: allowed only for a brand-new line standing in the slot of a line that is GONE.
      assert.equal(mine.size, 0, `run ${run}: "${t}" holds line ${covered}'s time but has words of another line`);
      assert.ok(covered.every((i) => !surviving.has(i)), `run ${run}: "${t}" took the time of a line that still exists`);
      replaced++;
    });
  }
  assert.ok(runs > 1800 && replaced > 0, `exercised (${runs} runs; ${replaced} lines replaced in place)`);
});

/* ── 3. the file's own times on lines the model holds untimed ─────────────────────────────────── */

function rowsXml(rows) {
  const ph = rows.map(([b, e], i) => `<paragraph guid="p${i}"><phrases><phrase guid="ph${i}" begin-time-offset="${b}" end-time-offset="${e}">`
    + `<item type="txt" lang="fau">w w</item><words><word><item type="txt" lang="fau">w</item></word><word><item type="txt" lang="fau">w</item></word></words></phrase></phrases></paragraph>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?><document version="2"><interlinear-text guid="t"><item type="title" lang="id">T</item><paragraphs>${ph}</paragraphs>`
    + '<languages><language lang="fau" vernacular="true"/><language lang="id"/></languages></interlinear-text></document>';
}
test('an untouched export writes the FILE\'s times for lines the model cannot place — nested speakers, a 90 ms sliver (data-safety 3)', () => {
  const nested = openXml(rowsXml([[1000, 5000], [2000, 3000], [5200, 7000]]));
  assert.equal(isAligned(nested.segments[1]), false, 'the model never holds a crossing span');
  assert.deepEqual(phrasesOf(serializeFlextext(nested, SET)).map((p) => [p.b, p.e]), [[1000, 5000], [2000, 3000], [5200, 7000]],
    'the .flextext goes out as it came in (P4) — v716 did, the first v717 dropped 2000–3000');
  const eaf = serializeEaf(nested, { profile: 'flex', vern: 'fau', anal: 'id', mediaName: 'x.wav' });
  assert.ok(!/TIME_VALUE="2000"/.test(eaf) && /TIME_VALUE="5200"/.test(eaf), 'an EAF tier must stay ordered, so the nested line is unaligned there');

  const sliver = openXml(rowsXml([[0, 2000], [2000, 2090], [2090, 5000]]));
  sliver.segments = SEG.normalizeSegments(sliver.segments);   // what the strips do on the first draw
  assert.equal(isAligned(sliver.segments[1]), false, 'too short to be a line');
  assert.deepEqual(phrasesOf(serializeFlextext(sliver, SET)).map((p) => [p.b, p.e]), [[0, 2000], [2000, 2090], [2090, 5000]], 'the sliver keeps its times in the file');
  assert.match(serializeEaf(sliver, { profile: 'flex', vern: 'fau', anal: 'id', mediaName: 'x.wav' }), /TIME_VALUE="2090"/, 'and in the EAF, where it is in order');

  // A line an EDIT left untimed is still written untimed (D8): the Segmenter's Done, a moved line.
  const left = openXml(rowsXml([[0, 2000], [2000, 4000], [4000, 6000]]));
  left.segments[1] = { timePending: true };
  assert.deepEqual(phrasesOf(serializeFlextext(left, SET)).map((p) => p.b), [0, null, 4000], 'no stale times');
});

test('a doc an older build stored with its tail CLAMPED to a short decode exports the file\'s times again (exports 2)', () => {
  const D = 60000;
  const doc = loadFixture('t53');
  // v716's reconcile: every span cut to the decoded length, past it → pending — and saved like that.
  doc.segments = doc.segments.map((s) => (s.start >= D - SEG.MIN_SEGMENT_MS ? { timePending: true } : { start: s.start, end: Math.min(s.end, D) }));
  delete doc.timeEdges;
  const pending = doc.segments.filter((s) => !isAligned(s)).length;
  assert.equal(pending, 16, 'sixteen lines past the end');
  const file = phrasesOf(fixtureXml('t53').replace(/<\?flextext-editor[^>]*\?>/, '').replace(/^[\s\S]*?<paragraphs>/, '<paragraphs>'));
  const out = phrasesOf(serializeFlextext(doc, SET));
  assert.equal(out.filter((p) => p.b != null).length, 53, 'all 53 lines carry times, as v716 wrote them (the first v717: 37)');
  assert.deepEqual(out.slice(-16).map((p) => [p.b, p.e]), file.slice(-16).map((p) => [p.b, p.e]), 'the clamped lines go out with the file\'s own offsets');
  const slots = (serializeEaf(doc, { profile: 'flex', vern: 'fau', anal: 'id', mediaName: 'x.wav' }).match(/TIME_VALUE="/g) || []).length;
  assert.ok(slots >= 54, `the EAF keeps them too (${slots} valued slots)`);
  // A doc v717 has read: its pending lines are v717's own verdicts and keep D8.
  const mine = loadFixture('t53');
  mine.segments[30] = { timePending: true };
  assert.equal(phrasesOf(serializeFlextext(mine, SET))[30].b, null, 'a line v717 left untimed stays untimed');
});

/* ── 4. outer edges that were guesses stay guesses ────────────────────────────────────────────── */

test('deleting the first and last lines leaves the new outer edges the GUESSES they were (data-safety 4 / exports 6)', () => {
  const doc = loadFixture('e78');
  const L = getBaselineParagraphs(doc);
  boxEdit(doc, L.slice(1, -1));
  const first = doc.segments[0], last = doc.segments[doc.segments.length - 1];
  assert.deepEqual([edges(first), edges(last)], ['2015~-4030~', '153149~-155164~'], 'interpolated, so still estimates (the first v717 made them "real")');
  const back = roundTrip(doc, { timeNotes: false });
  assert.deepEqual([edges(back.segments[0]), edges(back.segments[back.segments.length - 1])], ['2015~-4030~', '153149~-155164~'], 'and so after a round trip, notes off');
  const l29 = loadFixture('l29-13aug');
  const k = l29.segments.findIndex((s) => edgeGuessed(s, 0));
  boxEdit(l29, getBaselineParagraphs(l29).slice(k));
  assert.equal(edgeGuessed(l29.segments[0], 0), true, 'L29: a nudged start that becomes the first is still a guess');
});

/* ── 5. the equal-length rule never overrides our own instruction ─────────────────────────────── */

test('a file carrying our processing instruction is not second-guessed by the equal-length rule (data-safety 5)', () => {
  const doc = makeDoc(SET);
  reconcileBaseline(doc, ['aa bb', 'cc', 'dd ee'], { flatSegments: true });
  doc.segments = [{ start: 0, end: 3000 }, { start: 3000, end: 4500 }, { start: 4500, end: 9000 }];
  boxEdit(doc, ['aa', 'bb', 'cc', 'dd ee']);   // "aa bb" split by word fraction: two 1500 ms halves, then the real 1500 ms "cc"
  assert.deepEqual(doc.segments.map(edges), ['0-1500~', '1500~-3000', '3000-4500', '4500-9000']);
  for (const timeNotes of [true, false]) {
    const back = roundTrip(doc, { timeNotes });
    assert.deepEqual(back.segments.map(edges), doc.segments.map(edges), `notes ${timeNotes ? 'on' : 'off'}: "cc" stays real`);
  }
});

/* ── exports: stored pre-v717 records, segmentation off, a rollback ───────────────────────────── */

// A record as v714–v716 stored it: the file's times, its `~` ignored, no guess, no v717 mark.
function storedByV716(name) {
  const doc = loadFixture(name);
  doc.segments = doc.segments.map((s) => (isAligned(s) ? { start: s.start, end: s.end } : { timePending: true }));
  delete doc.timeEdges;
  return doc;
}
test('a record stored by v714–v716 exports its `~` and the instruction, whatever opened it (exports 1 / undo-gating 2)', () => {
  for (const [name, n] of [['e78', 78], ['e19', 19], ['l29-13aug', 8]]) {
    const doc = storedByV716(name);
    const before = JSON.stringify(doc.segments);
    const xml = serializeFlextext(doc, SET);
    assert.equal(phrasesOf(xml).filter((p) => p.tilde).length, n, `${name}: ${n} lines go out marked — never opened, never read back on a tab`);
    assert.match(xml, /<\?flextext-editor v="2" time-estimates=/);
    assert.equal(JSON.stringify(doc.segments), before, 'exporting reads back on a copy; the record is untouched');
    assert.equal(buildFxpa(doc, { title: 'x' }).lines.filter((l) => l.timeEstimated).length, n, `${name}: the .fxpa marks them too`);
  }
});

test('a device with segmentation OFF passes the file\'s instruction through with its offsets (exports 4)', () => {
  const a = loadFixture('l29-13aug');
  const fromA = serializeFlextext(a, SET, { timeNotes: false });
  const b = openXml(fromA);
  const off = serializeFlextext(b, SET, { segTimes: false });
  assert.match(off, /<\?flextext-editor v="2" time-estimates=/, 'the instruction survives the classic export');
  const c = openXml(off);
  assert.equal(c.segments.filter(isEstimate).length, 8, 'and the 8 estimates read back from it');
  assert.deepEqual(times(c.segments), times(a.segments), 'with every offset as it was');
});

test('after a rollback to v716 and back, v716\'s guesses are still guesses (exports 5)', () => {
  const doc = loadFixture('t53');   // stored by v717: every span carries guess [null, null]
  const [p1, p2] = [{ ...doc.segments[10], end: 21140 }, { ...doc.segments[10], start: 21140 }];
  p1.timeEstimated = true; p2.timeEstimated = true;   // v716's fraction split: {...s} copies v717's guess along
  doc.segments.splice(10, 1, p1, p2);
  doc.paragraphs.splice(11, 0, structuredClone(doc.paragraphs[10]));
  doc.paragraphs[11].segments[0].attrs = { guid: 'piece' };
  assert.ok(isEstimate(doc.segments[10]) && isEstimate(doc.segments[11]), 'read as estimates (the first v717 read them as real)');
  const xml = serializeFlextext(doc, SET);
  assert.ok(phrasesOf(xml)[11].tilde, 'exported with `~`');
  assert.match(xml, /piece@~21140-/, 'and the seam between the pieces is listed as a guess');
});

test('an older build\'s pushed start is read as THAT edge, never laundered (exports 8)', () => {
  // v714–v716's normalize pushed line 2's start (file: 900) to line 1's end and flagged the span.
  const doc = openXml(rowsXml([[0, 1000], [900, 2000], [2500, 3000]]));
  doc.segments = [{ start: 0, end: 1000 }, { start: 1000, end: 2000, timeEstimated: true }, { start: 2500, end: 3000 }];
  delete doc.timeEdges;
  readLegacyEstimates(doc);
  assert.equal(edges(doc.segments[1]), '1000~-2000', 'the edge that differs from the file\'s own offset is the guess');
  // With no offsets to compare against, a LONE estimate is guessed at every edge it can be — over-marked, never laundered.
  assert.equal(edges(SEG.withGuesses([{ start: 0, end: 1000 }, { start: 1000, end: 2000, timeEstimated: true }, { start: 2500, end: 3000 }])[1]), '1000~-2000~');
});
