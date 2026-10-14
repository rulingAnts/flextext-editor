/* § IS A BOUNDARY MARKER, NOT TEXT (seg-word-split; plans/flex-desktop-segmenter.md §4.3 item 2, §6.1).
 *
 * FLEx's importer writes U+00A7 after every phrase that has no end-of-sentence punctuation; a text
 * read out of a FLEx project carries it in its baselines. The engine hides a phrase-final § in every
 * word-level view, never offers it for editing, and round-trips it unchanged. Made-up fixtures.
 *
 * Run: node test/boundary-marker.test.mjs */
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { parseFlextext, serializeFlextext, isBoundaryMarker, markBoundaryMarkers, visibleWords, displayBaseline,
        getDisplayParagraphs, getBaselineParagraphs, restoreBoundaryMarkers, reconcileBaseline, makeSegment, makeWord } = await import('../docs/js/flextext.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const XML = `<?xml version="1.0" encoding="utf-8"?>
<document version="2"><interlinear-text guid="t1"><item type="title" lang="en">T</item><paragraphs>
<paragraph guid="p1"><phrases>
<phrase guid="s1" begin-time-offset="0" end-time-offset="1000" media-file="m1"><item type="txt" lang="xx">aaa bbb §</item><words>
<word guid="w1"><item type="txt" lang="xx">aaa</item><item type="gls" lang="en">A</item></word>
<word guid="w2"><item type="txt" lang="xx">bbb</item><item type="gls" lang="en">B</item></word>
<word guid="w3"><item type="punct" lang="xx">§</item></word>
</words><item type="gls" lang="en">first</item></phrase>
<phrase guid="s2"><item type="txt" lang="xx">ccc ddd.</item><words>
<word guid="w4"><item type="txt" lang="xx">ccc</item></word><word guid="w5"><item type="txt" lang="xx">ddd</item></word><word guid="w6"><item type="punct" lang="xx">.</item></word>
</words></phrase>
</phrases></paragraph>
<paragraph guid="p2"><phrases>
<phrase guid="s3"><item type="txt" lang="xx">§ eee §</item><words>
<word guid="w7"><item type="punct" lang="xx">§</item></word><word guid="w8"><item type="txt" lang="xx">eee</item></word><word guid="w9"><item type="punct" lang="xx">§</item></word>
</words></phrase>
</phrases></paragraph>
</paragraphs></interlinear-text></document>`;

console.log('\nparse: a phrase-final § is flagged; a § with a word after it is not');
const doc = parseFlextext(XML, { vernLang: 'xx', analLang: 'en' }).texts[0];
const [s1, s2] = doc.paragraphs[0].segments, [s3] = doc.paragraphs[1].segments;
ok(isBoundaryMarker(s1.words[2]) && s1.words[2].boundaryMarker === true, 'phrase 1 ends in § → flagged');
ok(!s2.words.some((w) => w.boundaryMarker), 'a full stop is punctuation, not a marker');
ok(s3.words[2].boundaryMarker === true && !s3.words[0].boundaryMarker, 'in "§ eee §" only the final one is phrase-final (the first is text FLEx would have broken at)');

console.log('\nhidden in word-level views, kept in the model');
ok(visibleWords(s1).map((w) => w.txt).join('|') === 'aaa|bbb', 'visibleWords drops the final §');
ok(s1.words.length === 3, 'the word is still in the model');
ok(visibleWords(s2).length === 3, 'ordinary punctuation stays visible');
ok(displayBaseline(s1.baseline) === 'aaa bbb' && displayBaseline('x §') === 'x' && displayBaseline('x.') === 'x.', 'displayBaseline strips only a trailing §');
ok(getDisplayParagraphs(doc)[0] === 'aaa bbb ccc ddd.' && getBaselineParagraphs(doc)[0] === 'aaa bbb § ccc ddd.', 'the text box shows lines without the marker; the model keeps it');

console.log('\nround trip: serialized unchanged');
const out = serializeFlextext(doc, { vernLang: 'xx', analLang: 'en' });
ok(out.includes('<item type="txt" lang="xx">aaa bbb §</item>'), 'the baseline keeps its §');
ok((out.match(/<item type="punct" lang="xx">§<\/item>/g) || []).length === 3, 'all three § punct items are written back');
ok(!/boundaryMarker/.test(out), 'the flag is in-memory only');
const again = parseFlextext(out, { vernLang: 'xx', analLang: 'en' }).texts[0];
ok(serializeFlextext(again, { vernLang: 'xx', analLang: 'en' }) === out, 'a second round trip is byte-identical');

console.log('\nthe classic text box: an unchanged line gets its § back before the reconcile');
{
  const d = parseFlextext(XML, { vernLang: 'xx', analLang: 'en' }).texts[0];
  // the editor flattens multi-phrase paragraphs on open; here each phrase is already its own line
  d.paragraphs = d.paragraphs.flatMap((p) => p.segments.map((s, k) => ({ guid: k ? 'n' + k : p.guid, segments: [s] })));
  const shown = getDisplayParagraphs(d);
  ok(shown.join('|') === 'aaa bbb|ccc ddd.|§ eee', 'three lines, final markers hidden');
  const typed = [shown[0], 'ccc ddd fff.', shown[2]];          // the user edited line 2 only
  const restored = restoreBoundaryMarkers(d, typed);
  ok(restored[0] === 'aaa bbb §' && restored[2] === '§ eee §', 'untouched lines come back with their marker');
  ok(restored[1] === 'ccc ddd fff.', 'the edited line is the user\'s text');
  const before = d.paragraphs[0];
  reconcileBaseline(d, restored, { flatSegments: true });
  ok(d.paragraphs[0] === before, 'line 1 reconciles as KEPT (same object) — its § and its words survive');
  ok(d.paragraphs[0].segments[0].words.length === 3 && d.paragraphs[0].segments[0].words[0].gls === 'A', 'with the gloss');
  ok(d.paragraphs[1].segments[0].words.map((w) => w.txt).join('|') === 'ccc|ddd|fff|.', 'line 2 is re-tokenised');
}
console.log('\nmarkBoundaryMarkers is idempotent and re-judges a moved marker');
{
  const s = makeSegment('§ x', [Object.assign(makeWord('§'), { punct: true, boundaryMarker: true }), makeWord('x')]);
  markBoundaryMarkers(s);
  ok(!s.words[0].boundaryMarker, 'a § that is no longer phrase-final loses the flag');
  markBoundaryMarkers(s); markBoundaryMarkers(s);
  ok(!s.words[0].boundaryMarker && s.words.length === 2, 'and nothing else changes on repeat');
}
console.log('\nwhere the engine hides it, pinned in the source');
{
  const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
  ok(/words\.filter\(\(w\) => !w\.punct\)\.map/.test(APP), 'the Matcher never drew punctuation, so § is hidden there by construction');
  ok(/if \(w\.boundaryMarker\) return;/.test(APP) && /markBoundaryMarkers\(seg\);\n  seg\.words\.forEach/.test(APP), 'the Gloss tab skips a flagged § after re-judging the phrase');
  /* ⚠ DECIDED, NOT FORGOTTEN: the classic text box shows the raw baseline, § included. It is the file's
   * own text, and four suites (time-undo, time-truth-review-app, strip-ticker, prose-boxes-wrap) pin
   * that it is filled and compared raw. The display/restore helpers above exist and are tested for
   * the day it hides the marker too; until then this line says the box is raw ON PURPOSE. */
  ok(/const before = JSON\.stringify\(getBaselineParagraphs\(current\.doc\)\)/.test(APP), 'applyBaseline compares the raw form (decided; see comment)');
}

console.log(fail ? `\nFAILED (${fail})\n` : `\nPASSED\n`);
process.exit(fail ? 1 : 0);
