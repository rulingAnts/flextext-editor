/* GAPS — "no line here" (#97; Seth, 2026-10-07: "the ability to uncheck audio segments in the cut tab
 * and then have them not included in the other two tabs as things the user can edit … they don't get
 * included in FLExText or ELAN exports … Joins with unchecked segments between would of course include
 * the silent audio").
 *
 * The pure half, MEASURED: the model (merge, split, join-through, fill-holes), every exporter, and the
 * round trip — a .flextext written with a gap comes back as lines plus the gap. The tab wiring is
 * pinned as source in the second half.
 *
 * Run: node --test test/gap-lines.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { parseFlextext, serializeFlextext, reconcileBaseline, makeDoc, segmentsFromOffsets } = await import('../docs/js/flextext.js');
const { mergeSegments, splitSegment, cutAtPlayhead, fillHoles, joinRun, isGap, nextLineIndex, prevLineIndex, MIN_SEGMENT_MS } = await import('../docs/js/segments.js');
const { serializeEaf, buildSegPreviewHtml, buildFxpa } = await import('../docs/js/seg-exports.js');
const { validateFxpa, serializeFxpa } = await import('../docs/js/paragraph-model.js');

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const SETTINGS = { vernLang: 'fau', analLang: 'id' };

/* Four pieces: a line, a GAP, a blank line somebody still means to fill, a line. */
function gapDoc() {
  const doc = makeDoc(SETTINGS);
  reconcileBaseline(doc, ['satu dua', '', '', 'tiga empat'], { flatSegments: true });
  doc.paragraphs[0].segments[0].free = 'one two';
  doc.paragraphs[3].segments[0].free = 'three four';
  doc.segments = [
    { start: 0, end: 2000 },
    { start: 2000, end: 3500, gap: true },
    { start: 3500, end: 4000 },
    { start: 4000, end: 6000 },
  ];
  return doc;
}

test('the model: a gap survives a split, dissolves into a line on a join, stays a gap with another gap', () => {
  const segs = gapDoc().segments;
  assert.deepEqual(segs.map(isGap), [false, true, false, false]);
  // split a gap at its middle: two gaps
  const split = splitSegment(segs, 1, { playheadMs: 2700 });
  assert.equal(split.length, 5);
  assert.ok(isGap(split[1]) && isGap(split[2]), 'both halves of a cut gap are gaps');
  // the Cut tab's cut goes the same way (an empty paragraph is inserted beside the new piece)
  const cut = cutAtPlayhead(segs, ['satu dua', '', '', 'tiga empat'], 2700);
  assert.ok(cut.ok && isGap(cut.segments[1]) && isGap(cut.segments[2]) && cut.paragraphs.length === 5);
  // line + gap → a line covering the silence
  const m = mergeSegments(segs, 0);
  assert.deepEqual({ start: m[0].start, end: m[0].end, gap: isGap(m[0]) }, { start: 0, end: 3500, gap: false });
  // gap + gap → still a gap
  const two = mergeSegments([{ start: 0, end: 1000, gap: true }, { start: 1000, end: 2000, gap: true }], 0);
  assert.ok(isGap(two[0]) && two[0].end === 2000);
  // neighbours skip gaps
  assert.equal(nextLineIndex(segs, 0), 2);
  assert.equal(prevLineIndex(segs, 2), 0);
  assert.equal(nextLineIndex(segs, 3), -1);
  assert.equal(prevLineIndex(segs, 0), -1);
});

test('joinRun: a line joins the NEXT LINE through the gaps between, text in order, silence included', () => {
  const doc = gapDoc();
  const paras = ['satu dua', '', '', 'tiga empat'];
  // make piece 2 a gap too, so 0 and 3 are the two lines with two gaps between
  doc.segments[2].gap = true;
  const r = joinRun(doc.segments, paras, 0, 3);
  assert.ok(r.ok);
  assert.deepEqual(r.paragraphs, ['satu dua tiga empat']);
  assert.deepEqual(r.segments.map((s) => [s.start, s.end, isGap(s)]), [[0, 6000, false]]);
  assert.equal(r.joinPos, 'satu dua '.length, 'the caret lands at the seam before the right-hand text');
  assert.equal(r.playheadMs, 2000, 'the playhead goes to the first seam');
  // a join of two gaps only is still a gap; a bad range refuses as one result
  const g = joinRun([{ start: 0, end: 1000, gap: true }, { start: 1000, end: 2000, gap: true }], ['', ''], 0, 1);
  assert.ok(g.ok && isGap(g.segments[0]) && g.paragraphs.length === 1);
  assert.equal(joinRun(doc.segments, paras, 2, 1).ok, false);
});

test('fillHoles: a hole between phrases, before the first, or after the last line becomes a gap', () => {
  const segs = [{ start: 500, end: 2000 }, { start: 3000, end: 4000 }, { start: 4000, end: 5000 }];
  const paras = ['a', 'b', 'c'];
  const r = fillHoles(segs, paras, { duration: 8000 });
  assert.equal(r.added, 3);
  assert.deepEqual(r.segments.map((s) => [s.start, s.end, isGap(s)]),
    [[0, 500, true], [500, 2000, false], [2000, 3000, true], [3000, 4000, false], [4000, 5000, false], [5000, 8000, true]]);
  assert.deepEqual(r.paragraphs, ['', 'a', '', 'b', 'c', '']);
  // idempotent — a gap is an aligned segment, so the second pass finds nothing
  const again = fillHoles(r.segments, r.paragraphs, { duration: 8000 });
  assert.equal(again.added, 0);
  assert.deepEqual(again.segments, r.segments);
  // a sliver is rounding, not a gap; a trailing stretch under the tolerance is left to coverTail
  assert.equal(fillHoles([{ start: 0, end: 2000 }, { start: 2000 + MIN_SEGMENT_MS - 1, end: 4000 }], ['a', 'b']).added, 0);
  assert.equal(fillHoles([{ start: 0, end: 4000 }], ['a'], { duration: 4800 }).added, 0);
  // a trailing EMPTY last line is coverTail's to extend, not a gap to add
  assert.equal(fillHoles([{ start: 0, end: 4000 }], [''], { duration: 8000 }).added, 0);
  // across a pending span nobody knows where the hole is: nothing is invented
  assert.equal(fillHoles([{ start: 0, end: 1000 }, { timePending: true }, { start: 5000, end: 6000 }], ['a', 'b', 'c']).added, 0);
});

test('.flextext: a gap writes no <phrase>, and the file round-trips to lines plus the gap', () => {
  const doc = gapDoc();
  const xml = serializeFlextext(doc, SETTINGS, {});
  assert.equal((xml.match(/<phrase\b/g) || []).length, 3, 'three phrases for four pieces — the gap wrote none');
  assert.equal((xml.match(/<paragraph\b/g) || []).length, 3, '…and its paragraph was not written either');
  assert.match(xml, /begin-time-offset="0" end-time-offset="2000"/);
  assert.match(xml, /begin-time-offset="3500" end-time-offset="4000"/, 'the BLANK line (not a gap) is still a timed empty phrase');
  assert.doesNotMatch(xml, /begin-time-offset="2000"/, 'nothing starts where the gap did');
  // back in: the hole becomes the gap again
  const back = parseFlextext(xml, SETTINGS).texts[0];
  const spans = segmentsFromOffsets(back);
  assert.deepEqual(spans.map((s) => [s.start, s.end]), [[0, 2000], [3500, 4000], [4000, 6000]], 'the reader sees three spans with a hole');
  const filled = fillHoles(spans, back.paragraphs.map((p) => p.segments.map((s) => s.baseline).join(' ')), { duration: 6000 });
  assert.deepEqual(filled.segments.map((s) => [s.start, s.end, isGap(s)]),
    [[0, 2000, false], [2000, 3500, true], [3500, 4000, false], [4000, 6000, false]], 'lines plus the gap, in their slots');
  assert.deepEqual(filled.paragraphs, ['satu dua', '', '', 'tiga empat']);
  // the flag never drops words: a texted piece marked gap by mistake is still written
  const safe = gapDoc(); safe.segments[0].gap = true;
  assert.equal((serializeFlextext(safe, SETTINGS, {}).match(/<phrase\b/g) || []).length, 3);
});

test('EAF: no annotation over the gap on any tier, and the slots around it do not meet', () => {
  const doc = gapDoc();
  const eaf = serializeEaf(doc, { profile: 'flex', vern: 'fau', anal: 'id', mediaName: 'x.wav' });
  const phraseTier = eaf.slice(eaf.indexOf('TIER_ID="A_phrase-txt-fau"'), eaf.indexOf('TIER_ID="A_phrase-gls-id"'));
  assert.equal((phraseTier.match(/<ALIGNABLE_ANNOTATION /g) || []).length, 3, 'three phrase annotations for four pieces');
  const slots = Object.fromEntries([...eaf.matchAll(/TIME_SLOT_ID="(ts\d+)" TIME_VALUE="(\d+)"/g)].map((m) => [m[1], +m[2]]));
  const refs = [...phraseTier.matchAll(/TIME_SLOT_REF1="(ts\d+)" TIME_SLOT_REF2="(ts\d+)"/g)].map((m) => [slots[m[1]], slots[m[2]]]);
  assert.deepEqual(refs, [[0, 2000], [3500, 4000], [4000, 6000]], 'the second annotation starts at 3500 — the gap is simply unannotated, as ELAN does it');
  assert.doesNotMatch(eaf, /TIME_VALUE="2000"[^]*TIME_VALUE="2000"/, 'no second slot at 2000: the line before the gap ends there and nothing starts there');
  // the SayMore profile reads the same rows
  const sm = serializeEaf(doc, { profile: 'saymore', vern: 'fau', anal: 'id', mediaName: 'x.wav' });
  assert.equal((sm.match(/<ALIGNABLE_ANNOTATION /g) || []).length, 3);
});

test('the listening page draws no row for a gap; the .fxpa keeps the piece with gap: true', () => {
  const doc = gapDoc();
  const html = buildSegPreviewHtml(doc, { vern: 'fau', anal: 'id' });
  assert.equal((html.match(/<div class="seg( blank)?"/g) || []).length, 3, 'three rows for four pieces');
  const fx = buildFxpa(doc, { title: 'T', vernLang: 'fau', analLang: 'id' });
  assert.equal(fx.lines.length, 4, 'the Paragraph Analysis file keeps every piece…');
  assert.deepEqual(fx.lines.map((l) => !!l.gap), [false, true, false, false], '…and marks the gap');
  const v = validateFxpa(JSON.parse(serializeFxpa(fx)));
  assert.ok(v.ok, v.errors && v.errors.join('; '));
  assert.equal(v.data.lines[1].gap, true, 'and the flag survives the tool\'s own serializer');
});

test('the tabs: Cut shows the tick, Baseline and Gloss show a placeholder, joins go through gaps', () => {
  const STRIPS = rd('../docs/js/segment-strips.js'), APP = rd('../docs/js/app.js'), CSS = rd('../docs/css/app.css'), I18N = rd('../docs/js/i18n.js');
  const fn = (src, name) => { const m = src.match(new RegExp(`\\n(?:export )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)); return m ? m[0] : ''; };
  // Cut tab
  const cut = fn(STRIPS, 'renderCut');
  assert.match(cut, /chk\.type = 'checkbox'/, 'a checkbox per piece');
  assert.match(cut, /chk\.checked = !isGap\(seg\)/, 'ticked means "this is a line"');
  assert.match(cut, /chk\.disabled = !!text/, 'a piece with words is always a line');
  assert.match(cut, /row\.classList\.add\('cut-gap'\)/);
  assert.match(fn(STRIPS, 'cutSetGap'), /if \(cutDeps\.capture\) cutDeps\.capture\(\);[\s\S]*if \(gap\) next\[i\] = \{ \.\.\.segs\[i\], gap: true \};/, 'one undo step, the flag on the segment');
  // Baseline
  const strips = fn(STRIPS, 'renderStrips');
  assert.match(strips, /if \(isGap\(seg\) && !text\.trim\(\)\) \{[\s\S]*?seg-gap[\s\S]*?return;/, 'a gap row is a placeholder: built and returned before the ▶, the ✂, the box and the grips');
  assert.match(strips, /const next = nextLineIndex\(segs, i\);/, 'the 🔗 after a line looks past the gaps…');
  assert.match(strips, /mergeRange\(i, next\)/, '…and joins through them');
  assert.match(fn(STRIPS, 'mergeRange'), /joinRun\(docSegments\(doc\), paras, a, b,/, 'the strips\' join is the model\'s joinRun');
  assert.match(fn(STRIPS, 'onKey'), /mergeRange\(prevLineIndex\(segs, i\), i\)/, 'Backspace at the start of a line joins with the previous LINE');
  // Gloss
  assert.match(fn(APP, 'renderGloss'), /isGap\(segs\[pi\]\)[\s\S]*?renderGapSegment\(/, 'a gap group is a placeholder, in its slot');
  assert.match(fn(APP, 'decorateGlossSegments'), /if \(!seg \|\| isGap\(seg\) \|\| g\.querySelector\('\.gseg-bar'\)\) return;/, 'no bar, no wave, no ▶ on a gap');
  assert.match(fn(APP, 'glossJoinLines'), /const k = nextLineIndex\(/, 'the Gloss join goes through gaps too');
  assert.match(APP, /glossJoinWithPrevious\(i\)/, 'and Backspace joins with the previous line');
  for (const k of ['cut.lineChk', 'cut.lineChkTip', 'cut.lineChkLocked', 'seg.gap', 'panel.rel.new.gapLines']) {
    assert.equal((I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  }
  assert.match(CSS, /\.seg-strip\.seg-gap/); assert.match(CSS, /\.segment\.seg-gap/); assert.match(CSS, /\.cut-row\.cut-gap/);
});
