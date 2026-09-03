/* mergePhrases — the matcher's text-side join yields ONE phrase.
 *
 * Why a pure function with its own test: the join first concatenated two phrase arrays into one
 * line, which committed as a paragraph holding two segments. That is the one shape
 * normalizePhraseLines exists to undo — on the next open it promoted each phrase back to its own
 * paragraph and cleared doc.segments to re-derive them, wiping the alignment just committed. So the
 * merge is now a rule the serializer's own module owns, and this pins what it keeps.
 *
 * Run: node test/merge-phrases.test.mjs
 */
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { makeSegment, mergePhrases, makeWord } = await import('../docs/js/flextext.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const W = (txt, gls, punct = false) => Object.assign(makeWord(txt, { punct }), gls ? { gls } : {});

console.log('\ntwo phrases become one, and nothing is lost');
{
  const a = makeSegment('Bofuae doi,', [W('Bofuae', 'name'), W('doi', 'go'), W(',', '', true)],
    { attrs: { guid: 'g-a', 'begin-time-offset': '1000', 'end-time-offset': '2500' }, free: 'Bofuae went,',
      freeLang: 'id', postItemsXML: ['<item type="note" lang="en">first</item>'] });
  const b = makeSegment('kadi bai.', [W('kadi', 'house'), W('bai', 'to'), W('.', '', true)],
    { attrs: { guid: 'g-b', 'begin-time-offset': '2500', 'end-time-offset': '4100' }, free: 'to the house.',
      postItemsXML: ['<item type="note" lang="en">second</item>'] });
  a.txtLang = 'fau';
  const m = mergePhrases([a, b]);
  ok(m.words.length === 6, 'every word survives, punctuation included');
  ok(m.words.map((w) => w.txt).join(' ') === 'Bofuae doi , kadi bai .', 'in order');
  ok(m.words[1].gls === 'go' && m.words[4].gls === 'to', 'with their glosses');
  ok(m.baseline === 'Bofuae doi, kadi bai.', 'the baselines are joined with one space');
  ok(m.free === 'Bofuae went, to the house.', 'so are the free translations');
  ok(m.freeLang === 'id', 'the first free-translation language wins');
  ok(m.txtLang === 'fau', 'and the first baseline language');
  ok(m.attrs.guid === 'g-a', 'the merged phrase IS the first one, extended — it keeps its guid');
  ok(m.attrs['begin-time-offset'] === '1000' && m.attrs['end-time-offset'] === '4100',
     'time offsets become the union');
  ok(m.postItemsXML.length === 2 && m.postItemsXML[1].includes('second'),
     'unknown items from BOTH phrases ride along — a note is not the matcher\'s to drop');
}

console.log('\nhalf an extent is not an extent');
{
  const a = makeSegment('a', [W('a')], { attrs: { guid: 'x', 'begin-time-offset': '0', 'end-time-offset': '900' } });
  const b = makeSegment('b', [W('b')], { attrs: { guid: 'y' } });
  const m = mergePhrases([a, b]);
  ok(!('begin-time-offset' in m.attrs) && !('end-time-offset' in m.attrs),
     'when only one phrase carries offsets, the merged one carries none');
  ok(m.free === '', 'no free translations → an empty one, not "undefined undefined"');
}

console.log('\ndegenerate inputs');
{
  const only = makeSegment('one', [W('one')], { attrs: { guid: 'solo' } });
  ok(mergePhrases([only]) === only, 'a single phrase is returned as itself');
  ok(mergePhrases([]).words.length === 0 && mergePhrases([]).baseline === '', 'nothing in → an empty phrase, not a throw');
  ok(mergePhrases([null, only, undefined]) === only, 'holes are ignored');
  const noBase = mergePhrases([makeSegment('', [W('p')]), makeSegment('', [W('q')])]);
  ok(noBase.baseline === 'p q', 'no baselines at all → rebuilt from the words');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nall ok\n');
process.exit(fail ? 1 : 0);
