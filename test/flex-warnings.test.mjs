/* WHAT FLEx'S SEGMENT BREAKER WOULD DO TO A PHRASE (seg-word-split; plans/flex-desktop-segmenter.md
 * §4.3 item 3, §6.1). Computed everywhere, shown for FLEx-bound docs, blocking only in the shell.
 * The EOS rules are FLEx's [source: SegmentBreaker]. Made-up fixtures.
 *
 * Run: node test/flex-warnings.test.mjs */
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { flexPhraseWarnings, flexDocWarnings, makeSegment, makeWord } = await import('../docs/js/flextext.js');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const warn = (text, opts) => flexPhraseWarnings(makeSegment(text, []), opts).map((w) => w.code + (w.char ? ':' + w.char : ''));

console.log('\nno word-forming character');
ok(warn('').join() === 'noWordChar', 'an empty phrase (the Segmenter\'s untranscribed line)');
ok(warn('… — ,').join() === 'noWordChar', 'punctuation only');
ok(warn('§').join() === 'noWordChar', 'a lone §');
ok(warn('aaa').length === 0, 'one letter is enough');
ok(warn('7').length === 0, 'digits are word-forming in the default rule');
ok(warn('~').join() === 'noWordChar' && warn('~', { wordChars: '~' }).length === 0, 'a WS\'s extra word-forming character counts when injected');

console.log('\ninternal end-of-sentence followed by a letter');
ok(warn('aaa bbb. ccc').join() === 'internalEos:.', 'a full stop then a word');
ok(warn('aaa? bbb').join() === 'internalEos:?' && warn('aaa! bbb').join() === 'internalEos:!', '? and !');
ok(warn('aaa § bbb').join() === 'internalEos:§', 'a § inside a phrase: FLEx breaks there too');
ok(warn('aaa." bbb').join() === 'internalEos:.', 'closing quotes stay with the first half; the break still comes');
ok(warn('aaa.) bbb').join() === 'internalEos:.', 'closing bracket likewise');
ok(warn('aaa bbb.').length === 0, 'a final full stop is not internal');
ok(warn('aaa bbb. §').length === 0 && warn('aaa bbb §').length === 0, 'a trailing marker after the stop is not a second break');
ok(warn('3.5 bbb').length === 0, 'a period between digits does not break');
ok(warn('aaa... bbb').length === 0, 'an exact three-dot ellipsis does not break');
ok(warn('aaa.. bbb').length === 0, 'a period after a period does not break');
ok(warn('aaa.... bbb').join() === 'internalEos:.', 'four periods do');
ok(warn('. aaa').length === 0, 'a break needs a word-forming character BEFORE it');
ok(warn('aaa. bbb. ccc').join() === 'internalEos:.,internalEos:.', 'every internal break is reported');
ok(warn('aaa.bbb').length === 0, 'a period glued to the next word (no space) is not a FLEx break for "."');
ok(warn('aaa?bbb').join() === 'internalEos:?', 'but ? and ! break even without a space');
ok(warn('aaa。 bbb').join() === 'internalEos:。' && warn('aaa। bbb').join() === 'internalEos:।', 'script variants: CJK stop, danda');

console.log('\nper document, with positions');
{
  const doc = { paragraphs: [
    { guid: 'p1', segments: [makeSegment('aaa bbb', [makeWord('aaa'), makeWord('bbb')], { attrs: { guid: 'g1' } })] },
    { guid: 'p2', segments: [makeSegment('', [], { attrs: { guid: 'g2' } }), makeSegment('ccc. ddd', [], { attrs: { guid: 'g3' } })] },
  ] };
  const w = flexDocWarnings(doc);
  ok(w.length === 2, 'two warnings');
  ok(w[0].para === 1 && w[0].phrase === 0 && w[0].guid === 'g2' && w[0].code === 'noWordChar', 'the empty phrase, by position and guid');
  ok(w[1].para === 1 && w[1].phrase === 1 && w[1].guid === 'g3' && w[1].code === 'internalEos' && w[1].at === 3, 'the internal stop, with its offset');
}
console.log(fail ? `\nFAILED (${fail})\n` : `\nPASSED\n`);
process.exit(fail ? 1 : 0);
