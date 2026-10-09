/* THE PAUSES BETWEEN TIMED LINES COME BACK AS BLANK LINES (v710; Seth, 2026-10-09, on v709: "On re-import,
 * gaps in duration between paragraphs, phrases, etc, should re-generate empty lines/audio segments in
 * flextext editor so that they can be changed. Right now it plays correctly, but the empty segments in
 * between don't draw in the editor.") The planners measured; the round trip through v709's export run
 * end to end; the paraOf rule shown to matter; the wiring pinned. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { gapLinesBetween, tailGapLine, fillGapLines, GAP_LINE_MIN_MS, GUESS_MIN_GAP_MS, TAIL_LINE_MIN_MS } = await import('../docs/js/segments.js');
const { parseFlextext, serializeFlextext, reconcileBaseline, makeDoc, makeSegment, segmentsFromOffsets, isSilentPhrase } = await import('../docs/js/flextext.js');

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), STRIPS = rd('../docs/js/segment-strips.js'), PANEL = rd('../docs/js/researcher-panel.js'), I18N = rd('../docs/js/i18n.js');
const fn = (src, name) => { const i = src.indexOf(`function ${name}(`); return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i)); };
const spans = (a) => a.map((s) => [s.start, s.end]);
const SETTINGS = { vernLang: 'fau', analLang: 'id' };
// The same blank line app.js builds (blankGapLine) — its rule is pinned against the source below.
let g = 0;
const blankLine = (prev, next) => {
  const paraOf = prev && next && prev.paraOf != null && prev.paraOf === next.paraOf ? prev.paraOf : null;
  return { guid: 'blank-' + (++g), segments: [makeSegment('', [])], ...(paraOf != null ? { paraOf } : {}) };
};

test('gapLinesBetween: a pause of a breath or more between two timed lines, and before the first', () => {
  assert.equal(GAP_LINE_MIN_MS, GUESS_MIN_GAP_MS); assert.equal(GAP_LINE_MIN_MS, 350);
  assert.deepEqual(gapLinesBetween([{ start: 0, end: 1000 }, { start: 1000, end: 2000 }]), [], 'contiguous lines: nothing to fill');
  assert.deepEqual(gapLinesBetween([{ start: 0, end: 1000 }, { start: 1400, end: 2000 }]), [{ before: 1, start: 1000, end: 1400 }]);
  assert.deepEqual(gapLinesBetween([{ start: 0, end: 1000 }, { start: 1349, end: 2000 }]), [], 'shorter than a breath stays a hole');
  assert.deepEqual(gapLinesBetween([{ start: 500, end: 1000 }]), [{ before: 0, start: 0, end: 500 }], 'before the first line');
  assert.deepEqual(gapLinesBetween([{ start: 0, end: 1000 }, { timePending: true }, { start: 5000, end: 6000 }]), [],
    'never around a line whose time is unknown — the hole may be its');
  assert.deepEqual(gapLinesBetween([]), []); assert.deepEqual(gapLinesBetween(null), []);
});

test('tailGapLine: the rest of the recording, once its length is known, from the gap rule\'s 350 ms (v712)', () => {
  const segs = [{ start: 0, end: 5000 }];
  assert.equal(TAIL_LINE_MIN_MS, GAP_LINE_MIN_MS, 'one threshold at both ends — the v711 tail used a full second');
  assert.equal(tailGapLine(segs, 0), null, 'length unknown: nothing');
  assert.equal(tailGapLine(segs, 5000 + TAIL_LINE_MIN_MS - 1), null, 'under 350 ms: encoder padding and rounding, not a line');
  assert.deepEqual(tailGapLine(segs, 5000 + TAIL_LINE_MIN_MS), { start: 5000, end: 5000 + TAIL_LINE_MIN_MS }, 'from 350 ms it is a line');
  assert.deepEqual(tailGapLine(segs, 5700), { start: 5000, end: 5700 }, 'Seth\'s case: a final blank line under a second comes back');
  assert.deepEqual(tailGapLine(segs, 9000), { start: 5000, end: 9000 });
  assert.equal(tailGapLine(segs, 5900, { tolMs: 1000 }), null, 'a caller may still ask for a wider tolerance');
  assert.equal(tailGapLine([{ timePending: true }], 9000), null);
});

test('fillGapLines: paragraphs and segments grow together, 1:1; new arrays; idempotent; refuses when not 1:1', () => {
  const P = ['A', 'B', 'C'].map((t) => ({ guid: t, segments: [] }));
  const S = [{ start: 400, end: 1000 }, { start: 2000, end: 3000 }, { start: 3000, end: 4000 }];
  const r = fillGapLines(P, S, blankLine);
  assert.equal(r.changed, true); assert.equal(r.added, 2);
  assert.deepEqual(spans(r.segments), [[0, 400], [400, 1000], [1000, 2000], [2000, 3000], [3000, 4000]]);
  assert.deepEqual(r.paragraphs.map((p) => p.guid.startsWith('blank') ? '·' : p.guid), ['·', 'A', '·', 'B', 'C']);
  assert.equal(P.length, 3, 'inputs are not mutated'); assert.equal(S.length, 3);
  const again = fillGapLines(r.paragraphs, r.segments, blankLine);
  assert.equal(again.changed, false, 'a filled document has no hole left'); assert.equal(again.paragraphs, r.paragraphs);
  const off = fillGapLines(P.slice(0, 2), S, blankLine);
  assert.equal(off.changed, false, 'not 1:1 — an index names nothing'); assert.equal(off.segments, S);
});

test('the round trip: v709 leaves the silent lines out; on re-import they come back where they were', () => {
  const doc = makeDoc(SETTINGS);
  reconcileBaseline(doc, ['satu dua', '', 'tiga empat', '', 'lima'], { flatSegments: true });
  doc.paragraphs[0].segments[0].free = 'one two';
  doc.paragraphs[2].segments[0].free = 'three four';
  doc.segments = [{ start: 0, end: 2000 }, { start: 2000, end: 3000 }, { start: 3000, end: 5000 }, { start: 5000, end: 5500 }, { start: 5500, end: 7000 }];
  const xml = serializeFlextext(doc, SETTINGS, {});
  const back = parseFlextext(xml, SETTINGS).texts[0];
  back.segments = segmentsFromOffsets(back);
  assert.deepEqual(spans(back.segments), [[0, 2000], [3000, 5000], [5500, 7000]], 'what arrives: three lines with holes');
  const r = fillGapLines(back.paragraphs, back.segments, blankLine);
  assert.deepEqual(spans(r.segments), spans(doc.segments), 'every silent line is back, with its own times');
  assert.deepEqual(r.paragraphs.map((p) => isSilentPhrase(p.segments[0])), [false, true, false, true, false]);
  back.paragraphs = r.paragraphs; back.segments = r.segments;
  const xml2 = serializeFlextext(back, SETTINGS, {});
  const offsets = (x) => [...x.matchAll(/begin-time-offset="(\d+)" end-time-offset="(\d+)"/g)].map((m) => [+m[1], +m[2]]);
  assert.deepEqual(offsets(xml2), offsets(xml), 'and exporting again writes exactly the same lines — the blank ones still stay out');
});

test('paraOf: a blank line inside one original paragraph inherits it, or the whole text loses its paragraphs', () => {
  const build = (inherit) => {
    const d = makeDoc(SETTINGS);
    reconcileBaseline(d, ['a b', 'c d', 'e f'], { flatSegments: true });
    d.paragraphs[0].paraOf = 'X'; d.paragraphs[1].paraOf = 'X'; d.paragraphs[2].paraOf = 'Y';
    d.segments = [{ start: 0, end: 1000 }, { start: 1500, end: 2500 }, { start: 2500, end: 3000 }];
    const r = fillGapLines(d.paragraphs, d.segments, inherit ? blankLine : (p, n) => ({ guid: 'z', segments: [makeSegment('', [])] }));
    d.paragraphs = r.paragraphs; d.segments = r.segments;
    return (serializeFlextext(d, SETTINGS, {}).match(/<paragraph\b/g) || []).length;
  };
  assert.equal(build(true), 2, 'inherited: X stays one <paragraph> (two phrases), Y another');
  assert.equal(build(false), 3, 'not inherited: X splits into two runs, so the serializer falls back to flat');
  assert.match(fn(APP, 'blankGapLine'), /const paraOf = prev && next && prev\.paraOf != null && prev\.paraOf === next\.paraOf \? prev\.paraOf : null;\n\s+return \{ guid: newGuid\(\), segments: \[makeSegment\('', \[\]\)\], \.\.\.\(paraOf != null \? \{ paraOf \} : \{\}\) \};/,
    'app.js builds the blank line by exactly this rule');
});

test('the wiring: every tab heals on entry; the tail is filled once the length is known', () => {
  const heal = fn(APP, 'healFlatSegments');
  assert.match(heal, /if \(!segmentationEnabled\(\)\) return;/, 'never in the classic editor');
  assert.match(heal, /const flattened = normalizePhraseLines\(doc\);[\s\S]*const filled = healGapLines\(doc\);\n\s+if \(flattened \|\| filled\) schedulePersist\(\);/, 'after the flattening, persisted when changed');
  assert.equal((APP.match(/healFlatSegments\(current && current\.doc\);/g) || []).length, 3, 'Cut, Baseline and Gloss call it on entry');
  assert.match(APP, /healFlatSegments\(rec\.doc\);\n\s+mgLoad\(rec\);/, '…and the Audio Segmenter on opening a text');
  // v713 (#111): the recorded blank lines (doc.blankLines) go in exactly; without them, the 350 ms rule — test/blank-lines-pi.test.mjs
  assert.match(fn(APP, 'healGapLines'), /const r = fillGapLines\(paras, segs, blankGapLine, pieces \? \{ pieces \} : \{\}\);/);
  assert.equal((APP.match(/appendBlankLine: \(doc\) => appendBlankLine\(doc\),/g) || []).length, 2, 'both the Cut and the Baseline deps carry the tail hook');
  assert.match(fn(STRIPS, 'reconcile'), /if \(settleTail\(doc, known, d\)\) repaired = true;/, 'reconcile settles the tail through the one rule');
  const settle = fn(STRIPS, 'settleTail');
  assert.match(settle, /if \(!segs\.length \|\| segs\.length !== paras\.length\) return false;/, 'never on a doc that is not 1:1');
  assert.match(settle, /if \(coverTail\(segs, paras, durationMs\)\) return true;\n\s+if \(!d\.appendBlankLine\) return false;\n\s+const tail = tailGapLine\(segs, durationMs, \{ tolMs: TAIL_LINE_MIN_MS \}\);\n\s+if \(!tail \|\| !d\.appendBlankLine\(doc\)\) return false;\n\s+segs\.push\(\{ start: tail\.start, end: tail\.end \}\);/,
    'stretch an empty last line, else a blank line of its own — both from the same 350 ms');
  // v712: the Gloss tab and the Audio Segmenter settle the tail too (only Cut and Baseline did).
  assert.match(fn(APP, 'settleTailOf'), /const changed = settleTail\(rec\.doc, peaksDurationOf\(rec\.id\), TAIL_DEPS\);/, 'the text\'s OWN recording length, never another text\'s peaks');
  assert.match(APP, /if \(current && current\.id === glossFor && activeTab === 'gloss' && settleTailOf\(current\)\n\s+&& !inTextField\(document\.activeElement\)\) renderGloss\(\);/, 'the Gloss tab, once its peaks land — re-rendered only while nobody is typing');
  for (const k of ['panel.rel.fix.gapLines', 'panel.rel.fix.zipLatest']) assert.equal((I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  assert.match(PANEL, /\{ v: 'v713', date: '2026-10-10', items: \[\n    \{ k: 'panel\.rel\.fix\.blankLinesKept', issue: 111 \},\n    \{ k: 'panel\.rel\.fix\.gapLines' \},\n    \{ k: 'panel\.rel\.fix\.zipLatest', issue: 102 \},\n    \{ k: 'panel\.rel\.fix\.passthroughSilent', issue: 97 \},/);
});
