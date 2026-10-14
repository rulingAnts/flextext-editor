/* THE WORD-FORMING SET CAN BE WIDENED, NEVER NARROWED (seg-word-split; plans/flex-desktop-segmenter.md
 * §4.3 item 5). FLEx decides word-forming per writing system; the shell injects each WS's extra
 * characters. With nothing injected, tokenize() is exactly what it always was.
 *
 * Run: node test/tokenize-wordforming.test.mjs */
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { tokenize, isWordForming, setExtraWordForming } = await import('../docs/js/flextext.js');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const toks = (t, o) => tokenize(t, o).map((x) => (x.punct ? '[' + x.txt + ']' : x.txt)).join(' ');

console.log('\nthe default is unchanged');
ok(toks('aaa bbb, ccc.') === 'aaa bbb [,] ccc [.]', 'letters are words, marks group');
ok(toks("a'b ʔa") === "a'b ʔa", "the apostrophe and ʔ were always word-forming");
ok(toks('a7b ꜝa') === 'a7b ꜝa', 'a digit is word-forming, and so is a modifier letter (\\p{L} covers Lm)');
ok(toks('a~b a|b') === 'a [~] b a [|] b', 'tilde and bar are punctuation by default');

console.log('\nper-call injection');
ok(toks('a~b a|b', { wordChars: '~' }) === 'a~b a [|] b', 'a string of characters widens this call');
ok(toks('a~b a|b', { wordChars: new Set(['~', '|']) }) === 'a~b a|b', 'so does a Set');
ok(toks('a~b') === 'a [~] b', 'and the next call is back to the default');
ok(isWordForming('~', '~') && !isWordForming('~') && isWordForming('a'), 'isWordForming mirrors it');

console.log('\nmodule default, set once per open project by the shell');
ok(setExtraWordForming('~|') === 2, 'two characters registered');
ok(toks('a~b a|b') === 'a~b a|b', 'every call now sees them');
ok(toks('a~b', { wordChars: '' }) === 'a~b', 'a per-call set adds to the default, never replaces it');
ok(setExtraWordForming(' \t') === 0, 'whitespace is never word-forming, whatever is injected');
ok(toks('a~b') === 'a [~] b', 'and the default is restored when cleared');
ok(setExtraWordForming(null) === 0 && setExtraWordForming(undefined) === 0, 'null/undefined clear it');

console.log(fail ? `\nFAILED (${fail})\n` : `\nPASSED\n`);
process.exit(fail ? 1 : 0);
