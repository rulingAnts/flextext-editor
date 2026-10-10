/* "KEEP THESE TIMES", AND THE UNTIMED TEXT END TO END IN THE EDITOR (v718 — plans/time-gaps-and-estimates.md
 * §4 keepLineTimes, D15, case 7; §6.1 time-undo; §6.4 R6, R7 — the node half).
 *
 *   · Keep makes a guessed line's times (an estimate, or an untimed line shown in its gap) its real ones:
 *     ONE captureUndo before the change and ONE save; one Undo restores it all, one Redo re-applies it;
 *   · it takes our own `~` note and the line's estimate-instruction entry with it (case 7), and the
 *     Undo brings both back;
 *   · it is a researcher's switch (D15: `!Sync.hasSession() || settings.keepTimes === true`), only where
 *     boundaries may be dragged, shown on the active row only, on the Baseline, Cut and Gloss tabs;
 *   · after an Undo or a Redo the tab's own preparation (prepareDisplaySpans) writes nothing;
 *   · R6: U60, the all-untimed FLEx skeleton: 60 rows drawn evenly, one info banner and no amber, an
 *     export with no times, a drag of seam 5|6 that times lines 5–6 only, and one Undo.
 * app.js is lifted from the source and run with its collaborators stubbed (test/lib/lift.mjs). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as SEG from '../docs/js/segments.js';
import { loadFixture, DURATION, ft } from './lib/timing-fixtures.mjs';
import { liftAll } from './lib/lift.mjs';
import { storableRecord } from './lib/storable.mjs';
import { prepareDisplaySpans, makeBoundaryDrag } from '../docs/js/segment-strips.js';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), STRIPS = rd('../docs/js/segment-strips.js'), PANEL = rd('../docs/js/researcher-panel.js');
const I18N = rd('../docs/js/i18n.js'), CSS = rd('../docs/css/app.css');
const { isPlaceholder, isPlaced, isAligned, isEstimate, edgeGuessed, timingReport } = SEG;
const SET = { vernLang: 'fau', analLang: 'id' };
const times = (segs) => segs.map((s) => (isAligned(s) ? [s.start, s.end] : null));

/* The editor around one open record: keepLineTimes and the real undo ring; switchTab re-renders the
 * way every tab does — prepareDisplaySpans — counting any write it asks for. */
function editor(rec, { D, session = false, settings = {}, seg = true } = {}) {
  const log = { captures: 0, saves: 0, prepWrites: 0 };
  const api = new Function('env', `
    const { SEG, ft, rec, log, prepare, D } = env;
    const { isAligned, isEstimate } = SEG;
    const { getBaselineParagraphs } = ft;
    let current = rec, player = null, activeTab = 'baseline';
    const settings = env.settings, Sync = { hasSession: () => env.session };
    const segmentationEnabled = () => env.seg;
    const docSegments = (d) => d.segments;
    const $ = () => null;
    const schedulePersist = () => { log.saves++; };
    const updateUndoButtons = () => {}, splitCancel = () => false;
    const draw = () => prepare(current.doc, { getParagraphs: getBaselineParagraphs, getDocId: () => 'doc', durationMs: D,
      persist: () => log.prepWrites++, persistQuiet: () => log.prepWrites++ });
    const switchTab = () => draw();
    const UNDO_CAP = 100;
    let undoStack = [], redoStack = [], fieldUndo = null;
    ${liftAll(APP, ['adjustBoundariesAllowed', 'keepTimesOn', 'keepAllowed', 'OUR_AUDIO_NOTE', 'keepLineTimes',
      'docSnap', 'pushSnap', 'commitFieldUndo', 'captureUndo', 'applyUndoState', 'doUndo', 'doRedo'])}
    const realCapture = captureUndo;
    return {
      keep: (i) => { const before = undoStack.length; const r = keepLineTimes(i); log.captures += undoStack.length - before; return r; },
      undo: doUndo, redo: doRedo, draw, allowed: keepAllowed,
      get depth() { return undoStack.length; }, get redoDepth() { return redoStack.length; },
    };
  `)({ SEG, ft, rec, log, prepare: prepareDisplaySpans, D, session, settings, seg });
  return { api, log };
}

function partly() {
  const doc = ft.makeDoc(SET);
  ft.reconcileBaseline(doc, ['satu', 'dua', 'tiga'], { flatSegments: true });
  doc.segments = [{ start: 0, end: 2000, guess: [null, null] }, { timePending: true }, { start: 5000, end: 7000, guess: [null, null] }];
  return { id: 'p', modified: 1, doc };
}

test('R7: Keep on a "needs timing" line makes it solid — one Undo item, one save; one Undo, one Redo', () => {
  const rec = partly();
  const { api, log } = editor(rec, { D: 7000 });
  api.draw();
  assert.ok(isPlaceholder(rec.doc.segments[1]), '"dua" drawn in its gap, 2000–5000');
  assert.equal(log.prepWrites, 0, 'drawn, not written');
  assert.equal(api.keep(1), true);
  assert.deepEqual([log.captures, log.saves], [1, 1], 'ONE undo item, captured before the change, and ONE save');
  const k = rec.doc.segments[1];
  assert.deepEqual([k.start, k.end, isPlaced(k), isEstimate(k), k.guess], [2000, 5000, true, false, [null, null]],
    'its times now — real, explicitly (guess [null, null]), no longer a placeholder');
  assert.deepEqual(times(storableRecord(rec).doc.segments), [[0, 2000], [2000, 5000], [5000, 7000]], 'and stored as a time');
  api.draw();
  assert.ok(isPlaced(rec.doc.segments[1]), 'the next draw does not re-spread it');
  api.undo();
  assert.equal(api.depth, 0);
  assert.ok(isPlaceholder(rec.doc.segments[1]), 'one Undo: back in its gap, untimed');
  assert.deepEqual(times(storableRecord(rec).doc.segments), [[0, 2000], null, [5000, 7000]]);
  api.redo();
  assert.ok(isPlaced(rec.doc.segments[1]) && !isEstimate(rec.doc.segments[1]), 'one Redo: kept again');
  assert.equal(log.prepWrites, 0, 'and neither the Undo nor the Redo made the tab\'s draw write anything');
  assert.equal(log.saves, 3, 'the Keep, the Undo and the Redo — one save each, nothing else');
});

test('case 7: Keep on an estimate from the file drops our ~ note and its instruction entry; Undo brings both back', () => {
  const doc = loadFixture('e78');
  const ph = doc.paragraphs[5].segments[0];
  ph.attrs.guid = ph.attrs.guid || 'g5';
  doc.timeEstimatesPi = [{ guid: ph.attrs.guid, start: doc.segments[5].start, end: doc.segments[5].end, gs: true, ge: true },
                         { guid: 'other', start: 1, end: 2, gs: true, ge: false }];
  const notes = () => (ph.postItemsXML || []).filter((x) => />audio ~/.test(x)).length;
  const live = () => doc.paragraphs[5].segments[0];
  assert.equal(notes(), 1, 'the line carries the file\'s own "audio ~…" note');
  const rec = { id: 'e', doc };
  const { api, log } = editor(rec, { D: DURATION.e78 });
  assert.ok(isEstimate(doc.segments[5]));
  api.keep(5);
  assert.deepEqual([log.captures, log.saves], [1, 1]);
  assert.ok(!isEstimate(doc.segments[5]) && Array.isArray(doc.segments[5].guess), 'real, and said explicitly');
  assert.equal((live().postItemsXML || []).filter((x) => />audio ~/.test(x)).length, 0, 'our note is gone from the phrase');
  assert.deepEqual(doc.timeEstimatesPi.map((x) => x.guid), ['other'], 'and its instruction entry, only its own');
  /* Exported by this device (segmentation on — the only place Keep exists), notes on or off, and opened
   * again: still kept. The file's own instruction lists the 77 lines that are still estimates and not
   * this one, and an instruction-carrying file is never read for equal-length runs (v717 review). */
  for (const timeNotes of [true, false]) {
    const xml = ft.serializeFlextext(doc, SET, { segTimes: true, timeNotes });
    const back = ft.parseFlextext(xml, SET).texts[0];
    const spans = ft.segmentsFromOffsets(back);
    assert.equal(isEstimate(spans[5]), false, `case 7: re-imported (notes ${timeNotes ? 'on' : 'off'}), it is still kept`);
    assert.equal(spans.filter(isEstimate).length, 77, 'and the other 77 are still estimates');
  }
  api.undo();
  assert.ok(isEstimate(doc.segments[5]), 'one Undo: an estimate again');
  assert.equal((live().postItemsXML || []).filter((x) => />audio ~/.test(x)).length, 1, 'with its note');
  assert.deepEqual(doc.timeEstimatesPi.map((x) => x.guid), [ph.attrs.guid, 'other'], 'and its instruction entry');
  api.redo();
  assert.ok(!isEstimate(doc.segments[5]));
  assert.deepEqual(doc.timeEstimatesPi.map((x) => x.guid), ['other']);
});

test('Keep on a line that is already real, or has no time, does nothing — and leaves no Undo item', () => {
  const rec = partly();
  const { api, log } = editor(rec, { D: 0 });   // no recording yet: nothing drawn, line 2 pending
  api.draw();
  assert.equal(api.keep(0), false, 'a real line');
  assert.equal(api.keep(1), false, 'a line with no time');
  assert.deepEqual([log.captures, log.saves], [0, 0]);
});

test('D15: a researcher\'s switch — on for a lone worker, off on a managed device until switched on', () => {
  assert.match(APP, /function keepTimesOn\(\) \{ return !Sync\.hasSession\(\) \|\| settings\.keepTimes === true; \}/, 'the allowBlankLines shape');
  assert.match(APP, /function keepAllowed\(\) \{ return adjustBoundariesAllowed\(\) && keepTimesOn\(\); \}/, 'and only where boundaries may be dragged');
  for (const [opts, want] of [[{}, true], [{ session: true }, false], [{ session: true, settings: { keepTimes: true } }, true],
    [{ settings: { adjustBoundaries: false } }, false], [{ seg: false }, false]]) {
    const rec = partly();
    const { api, log } = editor(rec, { D: 7000, ...opts });
    api.draw();
    assert.equal(api.allowed(), want, JSON.stringify(opts));
    assert.equal(api.keep(1), want);
    assert.equal(log.captures, want ? 1 : 0, 'refused: no Undo item and no save');
  }
  // its field on both settings surfaces, after timingBanner, and every string in EN and ID
  assert.ok(PANEL.includes("{ k: 'keepTimes', type: 'checkbox', note: 'panel.f.keepTimesNote' },"), 'researcher panel');
  assert.ok(APP.includes("{ k: 'keepTimes', type: 'checkbox', note: 'panel.f.keepTimesNote', off: 'setup.off.keepTimes' },"), 'unpaired Settings, greyed with its reason');
  for (const src of [PANEL, APP]) assert.ok(src.indexOf("k: 'keepTimes'") > src.indexOf("k: 'timingBanner'"));
  assert.match(APP, /'glossIcon', 'timingBanner', 'keepTimes',/, 'reported to the panel, so it reads back what the device has');
  for (const k of ['panel.f.keepTimes', 'panel.f.keepTimesNote', 'setup.off.keepTimes', 'keep.btn', 'keep.tip']) {
    assert.equal((I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || []).length, 2, `${k} in EN and ID`);
  }
});

test('Keep is on the active row only, on every editor tab that draws strips', () => {
  assert.match(STRIPS, /export function attachKeep\(host, i, seg, ctx\)/);
  assert.match(STRIPS, /if \(!host \|\| !ctx \|\| !ctx\.allowed \|\| !ctx\.allowed\(\) \|\| !isAligned\(seg\) \|\| !isEstimate\(seg\)\) return null;/,
    'only for a guessed line, only where allowed');
  assert.match(STRIPS, /attachKeep\(row, i, seg, stripsKeepCtx\(\)\);/, 'Baseline strips');
  assert.match(STRIPS, /attachKeep\(row, i, seg, cutKeepCtx\(i\)\);/, 'Cut rows');
  assert.match(APP, /attachKeep\(bar, i, seg, \{ allowed: \(\) => keepAllowed\(\), keep: \(k\) => \{ if \(keepLineTimes\(k\)\)/, 'Gloss bars');
  assert.match(APP, /allowKeep: \(\) => keepAllowed\(\),[^\n]*\n\s*keep: \(i\) => keepLineTimes\(i\),/, 'handed to the strips and the Cut tab');
  assert.match(CSS, /\.seg-keep \{ display: none;/, 'hidden by default…');
  assert.match(CSS, /\.seg-strip\.seg-on > \.seg-keep, \.seg-strip:focus-within > \.seg-keep,\n\.segment\.gseg-on > \.gseg-bar > \.seg-keep, \.segment:focus-within > \.gseg-bar > \.seg-keep \{ display: inline-block; \}/,
    '…shown on the line being played or typed');
});

test('R6: U60 — 60 rows drawn evenly, one info banner, no amber, no times exported; seam 5|6 times lines 5–6 only; one Undo', () => {
  const doc = loadFixture('u60');
  const rec = { id: 'u', modified: 1, doc };
  const { api, log } = editor(rec, { D: DURATION.u60 });
  api.draw();
  assert.equal(doc.segments.length, 60);
  assert.ok(doc.segments.every(isPlaceholder), 'every row dashed: the familiar even spread');
  assert.equal(log.prepWrites, 0, 'opening saved nothing');
  const rep = timingReport(doc.segments, ft.getBaselineParagraphs(doc), { durationMs: DURATION.u60 });
  assert.deepEqual(rep.items, [{ kind: 'noTimes', level: 'info', n: 60, spread: true }], 'one info banner, no amber');
  const xml = ft.serializeFlextext(doc, SET, { segTimes: true, timeNotes: true, mediaName: 'recording.wav' });
  assert.doesNotMatch(xml, /begin-time-offset|>audio |time-estimates|media-files/, 'the export carries no time at all');
  const before = times(doc.segments);
  // drag seam 5|6 — a strip's grip, through the shared drag consumer, as a finger does it
  const undo = [], redo = [];
  const drag = makeBoundaryDrag({ getSegs: () => doc.segments, getPlayer: () => null,
    capture: () => { undo.push(structuredClone(doc.segments)); redo.length = 0; }, persist: () => {} });
  drag(4, null, 'start', 'end');
  for (const ms of [before[4][1] + 200, before[4][1] + 900]) drag(4, ms, 'move', 'end');
  drag(4, null, 'end', 'end');
  api.draw();
  assert.deepEqual(doc.segments.map(isPlaced).map((p, k) => (p ? k : -1)).filter((k) => k >= 0), [4, 5], 'lines 5–6 are timed now, no other');
  assert.ok(isEstimate(doc.segments[4]) && isEstimate(doc.segments[5]), 'dashed: each keeps the spread\'s guess on its far edge');
  const moved = times(doc.segments);
  moved.forEach((t, k) => { if (k !== 4 && k !== 5) assert.ok(Math.abs(t[0] - before[k][0]) <= 1 && Math.abs(t[1] - before[k][1]) <= 1, `line ${k + 1} stays where it was drawn`); });
  assert.deepEqual(times(storableRecord(rec).doc.segments).filter(Boolean), [moved[4], moved[5]], 'storage holds the two placed lines only');
  assert.equal(undo.length, 1, 'one Undo item for the drag');
  doc.segments = undo.pop();
  api.draw();
  assert.deepEqual(times(doc.segments), before, 'one Undo restores the even spread exactly');
  assert.ok(doc.segments.every(isPlaceholder));
});

test('case 17: an even run of REAL lines, read back as a guess — Keep clears it, through our own export and import', () => {
  // Three equal real lines from a file with no instruction (FLEx, ELAN): the equal-length rule reads them as estimates.
  const made = ft.makeDoc(SET);
  ft.reconcileBaseline(made, ['w w', 'w w', 'w w', 'w w w'], { flatSegments: true });
  made.segments = [[0, 1000], [1000, 2000], [2000, 3000], [3000, 4500]].map(([s, e]) => ({ start: s, end: e, guess: [null, null] }));
  const fromElsewhere = ft.serializeFlextext(made, SET, { segTimes: true, timeNotes: false }).replace(/\n\s*<\?flextext-editor[^\n]*\?>/, '');
  const open = (xml) => { const d = ft.parseFlextext(xml, SET).texts[0]; d.segments = ft.segmentsFromOffsets(d); return d; };
  const doc = open(fromElsewhere);
  assert.deepEqual(doc.segments.map(isEstimate), [true, true, true, false], 'a false positive: real speech is never this even, but this is');
  const rec = { id: 'k', doc };
  const { api, log } = editor(rec, { D: 4500 });
  for (const i of [0, 1, 2]) api.keep(i);
  assert.equal(log.captures, 3, 'one Undo item per Keep');
  assert.ok(doc.segments.every((s) => !isEstimate(s)));
  // our export now says "no estimates here", so the rule does not misfire on the way back
  for (const timeNotes of [true, false]) {
    const xml = ft.serializeFlextext(doc, SET, { segTimes: true, timeNotes });
    assert.match(xml, /<\?flextext-editor v="2" time-estimates=""\?>/, 'an instruction that lists none');
    const back = open(xml);
    assert.deepEqual(back.segments.map(isEstimate), [false, false, false, false], `still kept after export and import (notes ${timeNotes ? 'on' : 'off'})`);
    // …and a device with segmentation off passes the claim on with the times
    const classic = ft.serializeFlextext(back, SET, { segTimes: false });
    assert.match(classic, /time-estimates=""/);
    assert.deepEqual(open(classic).segments.map(isEstimate), [false, false, false, false]);
  }
  // A text with no even run never carries the empty instruction: every timed corpus file exports as before.
  const t53 = loadFixture('t53');
  assert.doesNotMatch(ft.serializeFlextext(t53, SET, { segTimes: true, timeNotes: true }), /time-estimates/);
});
