/* v719 — THE "UNASSIGNED AUDIO" ROWS, AND THE ONE CLICK THAT TURNS ONE INTO A LINE.
 * plans/time-gaps-and-estimates.md §4 v719, §6.1 gap-rows, D1, D2, D15; cases 15 and 16.
 *
 * Seth, 10 Oct: gaps become display rows plus a one-click add; nothing is ever inserted when a text
 * opens. Measured on the timing skeletons of real files, because the 350 ms threshold was chosen on
 * the corpus and only the corpus can say it fires where it should and nowhere else.
 *
 * The app.js verbs are LIFTED FROM THE SOURCE and run with their collaborators stubbed, so what is
 * tested is the code that ships. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFixture, DURATION, fixtureNames, ft } from './lib/timing-fixtures.mjs';
import { liftAll } from './lib/lift.mjs';
import * as SEG from '../docs/js/segments.js';

const { gapRowsFor, gapMarks, gapHasSpeech, GAP_MIN_MS, GAP_SPEECH_MIN_MS, GAP_SPEECH_VOICED_MS,
        isAligned, isPlaced, isPlaceholder, spreadUntimed, syncToLines, seedsToPending, storableSegments } = SEG;
const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const STRIPS = readFileSync(new URL('../docs/js/segment-strips.js', import.meta.url), 'utf8');
const AUDIO = readFileSync(new URL('../docs/js/audio.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../docs/css/app.css', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
const PANEL = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const times = (segs) => segs.map((s) => (isAligned(s) ? [s.start, s.end] : null));

/** A fixture as the editor draws it: estimates read back, seeds made pending, untimed lines spread. */
function drawn(name) {
  const doc = loadFixture(name);
  ft.readLegacyEstimates(doc);
  const D = DURATION[name] || 0;
  doc.segments = spreadUntimed(syncToLines(seedsToPending(doc.segments, () => false), doc.paragraphs.length), D);
  return { doc, D };
}

/* ── where the rows are, on the real files ───────────────────────────────────────────────────── */

test('ELAN40: 39 rows at 350 ms — one lead, 37 interior, one tail (the plan\'s count)', () => {
  const { doc, D } = drawn('elan40');
  const rows = gapRowsFor(doc.segments, D);
  assert.equal(rows.length, 39);
  const n = doc.segments.length;
  assert.equal(rows.filter((g) => g.k === 0).length, 1, 'the lead: the file starts 2.2 s in');
  assert.equal(rows.filter((g) => g.k === n).length, 1, 'the tail: what coverTail used to swallow');
  assert.equal(rows.filter((g) => g.k > 0 && g.k < n).length, 37);
  assert.ok(rows.every((g) => g.ms >= GAP_MIN_MS), 'every row is at least the threshold');
  assert.ok(rows.every((g, i) => i === 0 || g.k > rows[i - 1].k), 'ascending, one per insertion point');
  // the first interior gap is the 1.2 s pause dragSeam's case-13 test measures from the same file
  const first = rows.find((g) => g.k === 1);
  assert.deepEqual([first.start, first.end], [4153, 5346]);
});

test('…and 0 on every healthy contiguous text; 1 on the damaged L29 (its 2.1 s tail)', () => {
  const expect = { elan40: 39, 'l29-damaged': 1, e19: 0, e78: 0, 'l29-13aug': 0, t151: 0, t18: 0, t53: 0, u60: 0 };
  for (const name of fixtureNames()) {
    const { doc, D } = drawn(name);
    assert.equal(gapRowsFor(doc.segments, D).length, expect[name], name);
  }
  // the damaged file's one row IS the tail the red banner is pointing at (case 16)
  const { doc, D } = drawn('l29-damaged');
  const row = gapRowsFor(doc.segments, D)[0];
  assert.equal(row.k, doc.segments.length, 'the tail');
  assert.ok(Math.round(row.ms) === 2076, `2.1 s, the same number timingReport reports (got ${row.ms})`);
});

test('never next to a pending line or a placeholder — that room belongs to the untimed run (D3)', () => {
  const segs = [{ start: 0, end: 1000 }, { timePending: true }, { start: 5000, end: 6000 }];
  assert.deepEqual(gapRowsFor(segs, 9000).map((g) => g.k), [3], 'only the tail; the 4 s hole is the pending line\'s room');
  const spread = spreadUntimed(segs.map((s) => ({ ...s })), 9000);
  assert.ok(isPlaceholder(spread[1]), 'the middle line is a placeholder once drawn');
  assert.deepEqual(gapRowsFor(spread, 9000).map((g) => g.k), [3], 'and a placeholder suppresses them the same way');
  // the lead and the tail need their own neighbour placed
  assert.deepEqual(gapRowsFor([{ timePending: true }, { start: 5000, end: 6000 }], 9000).map((g) => g.k), [2]);
  assert.deepEqual(gapRowsFor([{ start: 500, end: 1000 }, { timePending: true }], 9000).map((g) => g.k), [0]);
  assert.deepEqual(gapRowsFor([], 9000), [], 'no lines, no rows');
  assert.deepEqual(gapRowsFor([{ start: 500, end: 1000 }], 0), [{ k: 0, start: 0, end: 500, ms: 500 }], 'no duration: no tail row, lead unaffected');
});

test('the 350 ms threshold is a floor, not a rounding (D2)', () => {
  const at = (hole) => gapRowsFor([{ start: 0, end: 1000 }, { start: 1000 + hole, end: 5000 }], 0).length;
  assert.equal(at(349), 0);
  assert.equal(at(350), 1, 'exactly the threshold counts');
  assert.equal(at(351), 1);
  assert.equal(gapRowsFor([{ start: 0, end: 1000 }, { start: 1200, end: 5000 }], 0, { minMs: 100 }).length, 1, 'and it is a parameter');
});

/* ── speech in a gap (D2: ≥ 1000 ms with ≥ 400 ms voiced) ────────────────────────────────────── */

test('gapHasSpeech: a loud stretch inside a long pause is flagged; room tone is not', () => {
  // 20 s of peaks at 1 ms per bucket: a quiet floor, with speech from 10 s to 11 s
  const peaks = new Float32Array(20000).fill(0.02);
  for (let i = 0; i < 20000; i++) if (i % 97 === 0) peaks[i] = 0.9;   // the whole file's "speech level"
  for (let i = 10000; i < 11000; i++) peaks[i] = 0.8;
  assert.equal(gapHasSpeech(peaks, 1, 9500, 12000), true, 'a 2.5 s gap holding a 1 s utterance');
  assert.equal(gapHasSpeech(peaks, 1, 2000, 5000), false, 'a 3 s gap of room tone');
  assert.equal(gapHasSpeech(peaks, 1, 10200, 10900), false, `shorter than ${GAP_SPEECH_MIN_MS} ms is never tested`);
  assert.equal(gapHasSpeech(peaks, 1, 10000, 10350), false, 'a short gap, even wholly voiced');
  assert.equal(gapHasSpeech(null, 1, 0, 5000), false, 'no peaks: no claim');
  assert.equal(gapHasSpeech(peaks, 0, 0, 5000), false, 'no ms-per-bucket: no claim (never a duration proportion)');
  assert.equal(gapHasSpeech(new Float32Array(20000).fill(0.5), 1, 0, 5000), false, 'a flat file has no speech level to clear');
  assert.ok(GAP_SPEECH_VOICED_MS === 400 && GAP_SPEECH_MIN_MS === 1000, 'the plan\'s thresholds');
});

/* ── insertLineAt / addGapLine / addAllGapLines, lifted from app.js ──────────────────────────── */

function gapApp(doc, D, opts = {}) {
  const env = { captures: 0, persists: 0, confirmed: opts.confirm !== false, redraws: 0 };
  const run = new Function('env', 'ft', 'SEG', 'doc', 'D', 'opts', `
    const { newGuid, makeSegment } = ft;
    const { gapRowsFor } = SEG;
    const docSegments = (d) => d.segments || [];
    const settings = opts.settings || {};
    const Sync = { hasSession: () => !!opts.managed };
    const segmentationEnabled = () => true;
    const current = { id: 'x', doc };
    const peaksDurationMs = () => D;
    const getBaselineParagraphs = ft.getBaselineParagraphs;
    const timingBannerOn = () => true;
    const timingReport = () => opts.report || { level: '', items: [], sig: '' };
    const captureUndo = () => { env.captures++; };
    const schedulePersist = () => { env.persists++; };
    ${liftAll(APP, ['gapLinesOn', 'gapLinesAllowed', 'showGapsOn', 'checkAlignmentPending',
                    'gapRowsNow', 'insertLineAt', 'addGapLine', 'addAllGapLines'])}
    return { insertLineAt, addGapLine, addAllGapLines, gapRowsNow, checkAlignmentPending, gapLinesAllowed, showGapsOn };
  `);
  return { env, api: run(env, ft, SEG, doc, D, opts) };
}

test('insertLineAt splices BOTH arrays at the same index, never through reconcileBaseline (P2)', () => {
  const doc = ft.makeDoc({ vernLang: 'fau', analLang: 'id' });
  ft.reconcileBaseline(doc, ['w a', 'w b', 'w c'], { flatSegments: true });
  doc.segments = [{ start: 0, end: 1000 }, { start: 2000, end: 3000 }, { start: 4000, end: 5000 }];
  const guids = doc.paragraphs.map((p) => p.guid);
  const { api } = gapApp(doc, 9000);
  api.insertLineAt(doc, 1, { start: 1000, end: 2000 });
  assert.equal(doc.paragraphs.length, 4);
  assert.deepEqual(times(doc.segments), [[0, 1000], [1000, 2000], [2000, 3000], [4000, 5000]]);
  assert.deepEqual(ft.getBaselineParagraphs(doc), ['w a', '', 'w b', 'w c'], 'the new line is empty and in place');
  assert.deepEqual([doc.paragraphs[0].guid, doc.paragraphs[2].guid, doc.paragraphs[3].guid], guids,
    'every existing line keeps its own guid — nothing was re-paired');
  assert.ok(doc.paragraphs[1].guid && !guids.includes(doc.paragraphs[1].guid), 'and the new one is new');
  assert.equal(doc.paragraphs[1].segments.length, 1, 'one phrase, as segmentation mode requires');
  // the ends
  api.insertLineAt(doc, 0, { start: 0, end: 10 });
  assert.equal(ft.getBaselineParagraphs(doc)[0], '', 'at the front');
  api.insertLineAt(doc, doc.paragraphs.length, { start: 8000, end: 9000 });
  assert.equal(ft.getBaselineParagraphs(doc).at(-1), '', 'and at the end');
});

test('paraOf is inherited only when BOTH neighbours share it', () => {
  const mk = (a, b) => {
    const doc = ft.makeDoc({ vernLang: 'fau', analLang: 'id' });
    ft.reconcileBaseline(doc, ['w a', 'w b'], { flatSegments: true });
    doc.segments = [{ start: 0, end: 1000 }, { start: 2000, end: 3000 }];
    if (a != null) doc.paragraphs[0].paraOf = a;
    if (b != null) doc.paragraphs[1].paraOf = b;
    return doc;
  };
  const ins = (doc, k) => { gapApp(doc, 9000).api.insertLineAt(doc, k, { start: 1000, end: 2000 }); return doc; };
  assert.equal(ins(mk('P1', 'P1'), 1).paragraphs[1].paraOf, 'P1', 'inside one sentence: the new line belongs to it');
  assert.equal(ins(mk('P1', 'P2'), 1).paragraphs[1].paraOf, undefined, 'at a sentence boundary: it starts nothing');
  assert.equal(ins(mk(null, null), 1).paragraphs[1].paraOf, undefined, 'an unstructured text never gains one');
  assert.equal(ins(mk('P1', 'P1'), 0).paragraphs[0].paraOf, undefined, 'before the first line there is no pair to share');
  const doc = mk('P1', 'P1');
  assert.equal(ins(doc, 2).paragraphs[2].paraOf, undefined, 'and after the last');
});

test('Add here: one capture, one save, and no other line moves', () => {
  const { doc, D } = drawn('elan40');
  const before = times(doc.segments);
  const { env, api } = gapApp(doc, D);
  const row = api.gapRowsNow().find((g) => g.k === 1);
  assert.ok(api.addGapLine(1));
  assert.deepEqual([env.captures, env.persists], [1, 1], 'exactly one Undo item and one save (P5)');
  assert.equal(doc.segments.length, 41);
  assert.deepEqual(times(doc.segments).filter((_, i) => i !== 1), before, 'every original time is untouched');
  assert.deepEqual(times(doc.segments)[1], [row.start, row.end], 'the new line holds the gap exactly');
  assert.ok(!doc.segments[1].guess && !doc.segments[1].timeEstimated,
    'and its time is REAL — both edges came from placed lines, so it draws solid and exports');
  assert.equal(api.addGapLine(1), false, 'the row is gone now; a stale click adds nothing');
  assert.deepEqual([env.captures, env.persists], [1, 1], '…and takes no undo item for doing nothing');
});

test('Add all: 39 rows → 79 lines, ONE Undo item, every original time unchanged', () => {
  const { doc, D } = drawn('elan40');
  const before = times(doc.segments);
  const texts = ft.getBaselineParagraphs(doc);
  const { env, api } = gapApp(doc, D);
  assert.equal(api.addAllGapLines(), 39);
  assert.deepEqual([env.captures, env.persists], [1, 1], 'ONE capture and ONE save for the whole sweep (P5) — "Undo removes them all"');
  assert.equal(doc.paragraphs.length, 79, 'the plan\'s number');
  assert.equal(doc.segments.length, 79, 'and the two arrays stay the same length');
  const after = times(doc.segments);
  const kept = ft.getBaselineParagraphs(doc).map((t, i) => [t, after[i]]).filter(([t]) => t !== '');
  assert.deepEqual(kept.map(([, t]) => t), before.filter((_, i) => texts[i] !== ''),
    'every original line still has its own time, in order');
  assert.ok(after.every((t, i) => i === 0 || t[0] >= after[i - 1][1]), 'and the whole list is still monotonic');
  assert.equal(gapRowsFor(doc.segments, D).length, 0, 'no gap is left over');
});

test('Add is refused while a red check-alignment banner is unacknowledged (case 16)', () => {
  const { doc, D } = drawn('l29-damaged');
  const red = { level: 'red', items: [{ kind: 'dense', level: 'red' }], sig: 'dense:' };
  const { env, api } = gapApp(doc, D, { report: red });
  assert.equal(api.checkAlignmentPending(), true);
  assert.equal(api.addGapLine(doc.segments.length), false, 'the tail row offers nothing to press');
  assert.equal(api.addAllGapLines(), 0);
  assert.deepEqual([env.captures, env.persists], [0, 0], 'and nothing is captured or saved');
  // …and it is the ACKNOWLEDGEMENT that lifts it, not the level changing
  const acked = gapApp(doc, D, { report: red });
  acked.api.checkAlignmentPending();
  const doc2 = drawn('l29-damaged');
  const ok = gapApp(doc2.doc, doc2.D, { report: { ...red, sig: 'seen' } });
  assert.equal(ok.api.addGapLine(doc2.doc.segments.length), false, 'still red, still refused');
});

test('the researcher switch gates the WRITES, not the rows (D15)', () => {
  const { doc, D } = drawn('elan40');
  const off = gapApp(doc, D, { managed: true, settings: {} });
  assert.equal(off.api.gapLinesAllowed(), false, 'a managed device without the switch');
  assert.equal(off.api.gapRowsNow().length, 39, '…still sees every row');
  assert.equal(off.api.addGapLine(1), false, '…but cannot add');
  assert.equal(off.api.addAllGapLines(), 0);
  const on = gapApp(doc, D, { managed: true, settings: { gapLines: true } });
  assert.equal(on.api.gapLinesAllowed(), true, 'the researcher switches it on');
  const alone = gapApp(doc, D, { managed: false, settings: {} });
  assert.equal(alone.api.gapLinesAllowed(), true, 'and a lone worker always has it (!Sync.hasSession())');
  // showGaps is the DEVICE's own, default on
  assert.equal(gapApp(doc, D, { settings: {} }).api.showGapsOn(), true);
  assert.equal(gapApp(doc, D, { settings: { showGaps: false } }).api.showGapsOn(), false);
  assert.equal(gapApp(doc, D, { settings: { showGaps: false } }).api.gapRowsNow().length, 0, 'off: no rows to draw');
});

test('the gate\'s shape is exactly v717\'s and v718\'s, and it is reported to the panel', () => {
  assert.match(APP, /function gapLinesOn\(\) \{ return !Sync\.hasSession\(\) \|\| settings\.gapLines === true; \}/);
  assert.match(APP, /'glossIcon', 'timingBanner', 'keepTimes', 'gapLines', 'showGaps',/, 'both travel to the panel');
  assert.ok(PANEL.includes("{ k: 'gapLines', type: 'checkbox', note: 'panel.f.gapLinesNote' },"), 'the researcher panel');
  assert.ok(APP.includes("{ k: 'gapLines', type: 'checkbox', note: 'panel.f.gapLinesNote', off: 'setup.off.gapLines' },"),
    'and the unpaired Settings tab, greyed with its reason');
  for (const k of ['panel.f.gapLines', 'panel.f.gapLinesNote', 'setup.off.gapLines']) {
    assert.equal((I18N.match(new RegExp(`\n  '${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  }
  for (const k of ['gap.rowLabel', 'gap.playTip', 'gap.addHere', 'gap.checkFirst', 'gap.show', 'gap.hide', 'gap.addAll', 'gap.addAll.confirm']) {
    assert.equal((I18N.match(new RegExp(`\n  '${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  }
  assert.match(I18N, /'gap\.addAll\.confirm': 'Adds \{n\} empty lines\. They become part of the text and go into FLEx exports like any line\. Undo removes them all\.'/,
    'the confirmation says exactly what the plan promises');
});

/* ── case 15: nothing that counts lines may see a gap row ────────────────────────────────────── */

test('a gap row wears none of the line classes, and the seam marks are a separate layer', () => {
  const el = STRIPS.slice(STRIPS.indexOf('function gapRowEl('), STRIPS.indexOf('function gapRangeText('));
  assert.match(el, /row\.className = 'gap-row'/);
  assert.match(el, /row\.dataset\.gap = String\(gap\.k\);/, 'addressed by the index it would insert at');
  for (const bad of ['seg-strip', 'cut-row', 'seg-text', 'dataset.i']) {
    assert.ok(!el.includes(bad), `a gap row must not carry ${bad} — focusStripAfter, the tickers and linesOf all count by it`);
  }
  // the three readers that walk rows by position still see only lines
  assert.match(STRIPS, /host\.querySelectorAll\('\.cut-row'\)\.forEach/, 'the Cut ticker walks .cut-row');
  assert.match(APP, /'#cut-strips \.cut-row' : '#segment-strips \.seg-strip'/, 'and linesOf walks the line classes');
  // the player's own layers
  assert.match(AUDIO, /setGapMarks\(list\) \{/, 'Player.setGapMarks exists');
  const sb = AUDIO.slice(AUDIO.indexOf('setBoundaries(list) {'), AUDIO.indexOf('/* ═══ v719'));
  assert.ok(!/gap/i.test(sb), 'and setBoundaries never learns about gaps — one entry per SEAM, keeping its number');
  assert.match(AUDIO, /this\._gapLayer/, 'the bands live in their own layer');
  assert.match(AUDIO, /z-index:3;/, '…under the boundary layer, so a seam mark is never hidden');
});

test('setBoundaries still gets exactly one entry per seam, with a gap in the text', () => {
  const segs = [{ start: 0, end: 1000 }, { start: 5000, end: 6000 }, { start: 6000, end: 7000 }];
  assert.equal(SEG.gapRowsFor(segs, 9000).length, 2, 'a lead-less text with an interior gap and a tail');
  // overviewMarks is the seam list; it is unchanged by v719 and must stay length n-1
  const marks = STRIPS.slice(STRIPS.indexOf('export function overviewMarks('), STRIPS.indexOf('export function syncOverviewMarks('));
  assert.match(marks, /for \(let i = 0; i < \(segs \|\| \[\]\)\.length - 1; i\+\+\)/, 'one per seam, still');
  assert.deepEqual(gapMarks(segs, 9000), [{ start: 1000, end: 5000 }, { start: 7000, end: 9000 }],
    'and the gaps are ranges, carried separately');
});

test('coverTail is gone, and the tail is drawn instead', () => {
  assert.ok(!/function coverTail/.test(STRIPS), 'the function');
  assert.ok(!/COVER_TOL_MS/.test(STRIPS), 'its tolerance');
  assert.ok(!/coverTail\(doc, paras/.test(STRIPS), 'and its call');
  assert.match(STRIPS, /addGap\(paras\.length\);/, 'the Baseline strips draw the tail row');
  assert.match(STRIPS, /addGap\(segs\.length\);/, 'and so does the Cut tab');
});

test('opening a text still writes nothing and changes no time (P1) — with gaps on screen', () => {
  for (const name of fixtureNames()) {
    const a = drawn(name), b = drawn(name);
    assert.deepEqual(times(a.doc.segments), times(b.doc.segments), `${name}: deterministic`);
    assert.equal(JSON.stringify(storableSegments(a.doc.segments)), JSON.stringify(storableSegments(b.doc.segments)), name);
    const rows = gapRowsFor(a.doc.segments, a.D);
    assert.equal(a.doc.segments.length, a.doc.paragraphs.length, `${name}: no line was added`);
    assert.ok(rows.every((g) => g.start < g.end), `${name}: every row is a real stretch`);
  }
});

/* ── the CSS and the dock ─────────────────────────────────────────────────────────────────────── */

test('the rows are styled in light AND dark, and never force a sideways scroll on a phone', () => {
  assert.match(CSS, /\.gap-row \{/);
  assert.match(CSS, /\.gap-row\.gap-speech \{/, 'speech in a gap is tinted');
  assert.equal((CSS.match(/--gap-ink:/g) || []).length, 2, 'the tokens are defined once for each scheme');
  assert.match(CSS, /@media \(max-width: 560px\) \{\s*\n\s*\.gap-row \{ grid-template-columns: auto 1fr;/, 'R12: it reflows instead of scrolling');
});

test('the dock carries the two controls, before ✨, and they are hidden until there is a gap', () => {
  for (const shell of ['../docs/index.html', '../satellites/audio-segmenter/index.html']) {
    const html = readFileSync(new URL(shell, import.meta.url), 'utf8');
    assert.ok(html.indexOf('id="btn-gap-show"') < html.indexOf('id="btn-guess-splits"'), `${shell}: ✨ keeps the far-right corner`);
    assert.match(html, /<button id="btn-gap-show" class="player-gap link-btn" hidden><\/button>/, shell);
    assert.match(html, /<button id="btn-gap-addall" class="player-gap link-btn" hidden><\/button>/, shell);
  }
  const sync = liftAll(APP, ['syncGapTools']);
  assert.match(sync, /gapRowsFor\(docSegments\(current\.doc\), peaksDurationMs\(current\.id\)\)\.length/,
    'the count ignores the showGaps preference — "Show gaps (39)" is the control that turns them back on');
  assert.match(sync, /all\.hidden = !\(showGapsOn\(\) && gapLinesAllowed\(\) && !checkAlignmentPending\(\)\);/,
    'Add all follows the switch and the red banner');
});
