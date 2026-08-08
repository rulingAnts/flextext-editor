/* GUID identity across baseline edits.
 *
 * ⚠ WHY THIS SUITE EXISTS. FLEx HONOURS an incoming guid (Seth, 2026-08-08), so the guid the editor
 * writes on a <phrase> is not decoration — on re-import FLEx UPDATES the object that guid names.
 * Hand a new line a dead line's guid and FLEx silently re-attaches its glossing and analysis to
 * different text. That is a data-loss bug that surfaces long after the cause, so every rule below is
 * pinned here rather than left to the reader of reconcileBaseline.
 *
 * Pure module test — flextext.js must run under plain node. */
import { makeDoc, reconcileBaseline, sameLineText, serializeFlextext } from '../docs/js/flextext.js';

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok    ' : '  FAIL  ') + msg); if (!cond) failures++; };

// One line = one paragraph = one phrase (flat mode), so a line's identity IS its phrase guid.
const lines = (doc) => doc.paragraphs.map((p) => ({
  text: p.segments[0].baseline, guid: p.segments[0].attrs.guid, seg: p.segments[0],
}));
const build = (texts) => {
  const d = makeDoc({ vernLang: 'fau', analLang: 'en' });
  reconcileBaseline(d, texts, { flatSegments: true });
  return d;
};
const edit = (d, texts) => { reconcileBaseline(d, texts, { flatSegments: true }); return lines(d); };
const guidOf = (rows, text) => (rows.find((r) => r.text === text) || {}).guid;

console.log('THE BUG: a deleted line\'s guid must not be adopted by an added one');
{
  const d = build(['one', 'two', 'three']);
  const before = lines(d);
  const after = edit(d, ['two', 'three', 'four']);
  ok(guidOf(after, 'two') === guidOf(before, 'two'), 'an untouched line keeps its guid (exact LCS match)');
  ok(guidOf(after, 'three') === guidOf(before, 'three'), '...and so does the one after it');
  // ⚠ THE REGRESSION. Before the gate, "four" inherited "one"'s guid via pass 2's ordered pairing.
  ok(guidOf(after, 'four') !== guidOf(before, 'one'),
     'a BRAND-NEW line does NOT inherit the DELETED line\'s guid');
  ok(!before.some((b) => b.guid === guidOf(after, 'four')), '...nor any other pre-existing line\'s');
  ok(new Set(after.map((r) => r.guid)).size === 3, 'and all three guids are still distinct');
}

console.log('\n...but an EDIT IN PLACE must KEEP its guid — the case that makes a blanket mint wrong');
{
  // Fix a typo in line 5 of 20: LCS matches the other 19, so line 5 lands in the SAME pass-2 path as
  // the bug above. Minting unconditionally would give every typo fix a new FLEx object.
  const texts = Array.from({ length: 20 }, (_, i) => 'line number ' + (i + 1));
  const d = build(texts);
  const before = lines(d);
  const fixed = [...texts]; fixed[4] = 'line numbre 5';
  const after = edit(d, fixed);
  ok(guidOf(after, 'line numbre 5') === before[4].guid, 'a typo fix keeps the line\'s guid');
  ok(after.length === 20 && new Set(after.map((r) => r.guid)).size === 20, 'nothing else disturbed');
}

console.log('\nSPLIT and JOIN keep working exactly as they did (they were already correct)');
{
  const d = build(['alpha beta', 'gamma']);
  const before = lines(d);
  const after = edit(d, ['alpha', 'beta', 'gamma']);
  ok(guidOf(after, 'alpha') === guidOf(before, 'alpha beta'), 'split: the FIRST half keeps the guid');
  ok(guidOf(after, 'beta') !== guidOf(before, 'alpha beta'), 'split: the second half gets a fresh one');
  ok(guidOf(after, 'gamma') === guidOf(before, 'gamma'), 'split: the neighbour is untouched');

  const e = build(['alpha', 'beta', 'gamma']);
  const b2 = lines(e);
  const a2 = edit(e, ['alpha beta', 'gamma']);
  ok(guidOf(a2, 'alpha beta') === guidOf(b2, 'alpha'), 'join: the joined line carries the FIRST guid');
  ok(guidOf(a2, 'gamma') === guidOf(b2, 'gamma'), 'join: the neighbour is untouched');
}

console.log('\nthe similarity gate itself — every measured row from the design note');
{
  ok(sameLineText('the dog run', 'the dog runs') === true, '0.92 typo -> same line');
  ok(sameLineText('cat', 'cot') === true, '0.67 short typo -> same line (token overlap alone would fail this)');
  ok(sameLineText('alpha beta', 'alpha') === true, '0.50 SPLIT -> same line');
  ok(sameLineText('dia pergi', 'dia makan') === false, '0.44 different line -> NOT the same');
  ok(sameLineText('one', 'four') === false, '0.25 different line -> NOT the same');
  // ⚠ The prefix rule must carry split/join on its own, so the threshold can be retuned later.
  ok(wordPrefixSurvivesThreshold(), 'split is recognised by the WHOLE-WORD PREFIX rule, not by the threshold');
  ok(sameLineText('a', 'abc') === false, 'prefix rule needs a WORD boundary — "a" is not a prefix of "abc"');
  ok(sameLineText('', '') === true, 'blank -> blank is the same line (a silence marker survives)');
  ok(sameLineText('', 'text') === false, 'blank -> text is a different line');
  ok(sameLineText('  the   dog  ', 'the dog') === true, 'whitespace-insensitive');
}
// A long prefix pair whose length ratio alone is far below SAME_LINE_MIN: only the prefix rule can
// keep it. If someone raises the threshold, this still passes; if they delete the rule, it fails.
function wordPrefixSurvivesThreshold() {
  const long = 'satu dua tiga empat lima enam tujuh delapan sembilan sepuluh';
  return sameLineText(long, 'satu') === true;
}

console.log('\nIDENTITY is gated, but the transcriber\'s WORK still carries — the two were conflated');
{
  const d = build(['one', 'two']);
  d.paragraphs[0].segments[0].free = 'the free translation';
  d.paragraphs[0].segments[0].words.forEach((w) => { w.gls = 'GLOSS'; });
  const before = lines(d);
  const after = edit(d, ['four', 'two']);          // "one" -> "four": NOT the same line
  const four = after.find((r) => r.text === 'four');
  ok(four.guid !== before[0].guid, 'the dissimilar line got a fresh guid');
  ok(four.seg.free === 'the free translation', '...yet the free translation still carried over');
}

console.log('\nimported TIME OFFSETS ride the same gate — a stale offset is a FALSE alignment');
{
  const d = build(['satu dua', 'tiga']);
  d.paragraphs[0].segments[0].attrs['begin-time-offset'] = '1000';
  d.paragraphs[0].segments[0].attrs['end-time-offset'] = '2000';
  const after = edit(d, ['empat lima', 'tiga']);   // wholly different text in that slot
  const row = after.find((r) => r.text === 'empat lima');
  ok(!row.seg.attrs['begin-time-offset'] && !row.seg.attrs['end-time-offset'],
     'a line that is NOT the same line does not inherit the old line\'s offsets');

  // ...and an edit in place DOES keep them: same line, same stretch of audio, retyped.
  const e = build(['the dog run']);
  e.paragraphs[0].segments[0].attrs['begin-time-offset'] = '1000';
  const kept = edit(e, ['the dog runs']);
  ok(kept[0].seg.attrs['begin-time-offset'] === '1000', 'an edit in place keeps its alignment');
}

console.log('\nthe EXACT-match path is untouched — the round-trip guarantee still holds');
{
  const d = build(['satu dua', 'tiga']);
  d.paragraphs[0].segments[0].attrs['begin-time-offset'] = '1000';
  d.paragraphs[0].segments[0].attrs['end-time-offset'] = '2000';
  const before = lines(d);
  const after = edit(d, ['satu dua', 'tiga']);     // no change at all
  ok(guidOf(after, 'satu dua') === guidOf(before, 'satu dua'), 'unchanged lines keep their guids');
  ok(after[0].seg.attrs['begin-time-offset'] === '1000', 'and imported offsets round-trip verbatim');
  const xml = serializeFlextext(d, { vernLang: 'fau', analLang: 'en' });
  ok(xml.includes('begin-time-offset="1000"'), '...all the way out to the XML');
}

console.log('\nevery phrase still HAS a guid — the gate must never leave one undefined');
{
  const d = build(['one', 'two', 'three']);
  edit(d, ['two', 'three', 'four', '', 'six']);
  const rows = lines(d);
  ok(rows.every((r) => typeof r.guid === 'string' && r.guid.length > 10),
     'including brand-new lines and blank ones');
  ok(new Set(rows.map((r) => r.guid)).size === rows.length, 'and they are all distinct');
}

console.log(failures ? `\nFAILED (${failures})\n` : '\nPASSED\n');
process.exit(failures ? 1 : 0);
