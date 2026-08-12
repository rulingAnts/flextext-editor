/* Moving a line boundary must NEVER throw away typed work.
 *
 * WHY (Seth, 2026-08-12, staging test drive): "joining on the gloss tab loses all existing glosses
 * and free translations in the second line joined." reconcileBaseline paired the joined line with
 * the LEFT old segment and dropped the right one, so every gloss the team had typed on that line
 * vanished — from an edit that only meant to move a boundary. The same 1:1 pairing lost data on a
 * split.
 *
 * The rules pinned here:
 *   JOIN  — words (with their glosses) from BOTH lines survive, in order; the two free
 *           translations concatenate with a space.
 *   SPLIT — each piece keeps the words that fall in it; the free translation follows the LONGEST
 *           piece and the others start blank (a guess, but the honest one — the transcriber checks
 *           it afterwards).
 *
 * Run: node test/join-split-preserves-work.test.mjs
 */
import { makeDoc, reconcileBaseline } from '../docs/js/flextext.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

// Build a two-line doc and gloss every word, plus a free translation per line.
function glossedDoc() {
  const doc = makeDoc({ vernLang: "fau", analLang: "en" });
  reconcileBaseline(doc, ['ana bofu', 'sira kama'], { flatSegments: true });
  const segs = doc.paragraphs.map((p) => p.segments[0]);
  segs[0].words[0].gls = 'dog';   segs[0].words[1].gls = 'runs';
  segs[1].words[0].gls = 'man';   segs[1].words[1].gls = 'sees';
  segs[0].free = 'The dog runs.'; segs[0].freeLang = 'en';
  segs[1].free = 'The man sees.'; segs[1].freeLang = 'en';
  return doc;
}
const glossOf = (doc) => doc.paragraphs.flatMap((p) => p.segments.flatMap((s) => s.words.map((w) => w.txt + '=' + (w.gls || '∅'))));
const frees = (doc) => doc.paragraphs.flatMap((p) => p.segments.map((s) => s.free || ''));

console.log('\nJOIN — the second line keeps its glosses (this is the bug that was reported)');
{
  const doc = glossedDoc();
  reconcileBaseline(doc, ['ana bofu sira kama'], { flatSegments: true });
  ok(doc.paragraphs.length === 1, 'one line now');
  ok(glossOf(doc).join(' ') === 'ana=dog bofu=runs sira=man kama=sees',
     'every gloss survived: ' + glossOf(doc).join(' '));
  ok(frees(doc)[0] === 'The dog runs. The man sees.',
     'free translations concatenated with a space: "' + frees(doc)[0] + '"');
}

console.log('\nSPLIT — each piece keeps its own words; the free translation follows the longest');
{
  const doc = glossedDoc();
  reconcileBaseline(doc, ['ana bofu sira kama'], { flatSegments: true });   // join first
  reconcileBaseline(doc, ['ana bofu', 'sira kama'], { flatSegments: true });  // then split back
  ok(doc.paragraphs.length === 2, 'two lines again');
  ok(glossOf(doc).join(' ') === 'ana=dog bofu=runs sira=man kama=sees',
     'glosses stayed with their own words across the round trip: ' + glossOf(doc).join(' '));
}

console.log('\nSPLIT of a single glossed line: words divide, free goes to the longer piece');
{
  const doc = makeDoc({ vernLang: "fau", analLang: "en" });
  reconcileBaseline(doc, ['ana bofu sira kama duo'], { flatSegments: true });
  const s = doc.paragraphs[0].segments[0];
  s.words.forEach((w, i) => { w.gls = 'g' + i; });
  s.free = 'One long sentence.'; s.freeLang = 'en';

  reconcileBaseline(doc, ['ana', 'bofu sira kama duo'], { flatSegments: true });
  ok(glossOf(doc).join(' ') === 'ana=g0 bofu=g1 sira=g2 kama=g3 duo=g4',
     'every word kept its own gloss: ' + glossOf(doc).join(' '));
  ok(frees(doc)[0] === '' && frees(doc)[1] === 'One long sentence.',
     'the free translation went to the LONGER piece, the short one is blank: ' + JSON.stringify(frees(doc)));
}

console.log('\nunrelated edits still behave (no over-eager merging)');
{
  const doc = glossedDoc();
  reconcileBaseline(doc, ['ana bofu', 'sira kama', 'wholly new line'], { flatSegments: true });
  ok(doc.paragraphs.length === 3, 'an inserted line does not consume its neighbours');
  ok(frees(doc)[0] === 'The dog runs.' && frees(doc)[1] === 'The man sees.',
     'existing free translations untouched');
  ok(frees(doc)[2] === '', 'the new line starts blank');
}

console.log('\nediting a word in place still carries the rest of the line');
{
  const doc = glossedDoc();
  reconcileBaseline(doc, ['ana bofuX', 'sira kama'], { flatSegments: true });
  const g = glossOf(doc);
  ok(g[0] === 'ana=dog', 'the untouched word kept its gloss (' + g[0] + ')');
  ok(frees(doc)[0] === 'The dog runs.', 'and the line kept its free translation');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
