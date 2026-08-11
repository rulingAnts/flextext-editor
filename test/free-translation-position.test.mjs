/* Free translations import from EITHER side of <words> (v332, Seth's field file).
 *
 * The parser used to require the phrase-level gls AFTER <words>. Real FLEx exports also write it
 * BEFORE — and such a file imported with every free translation silently EMPTY (the item fell
 * through to preserved XML, so nothing even looked lost until a human read the screen). This test
 * pins the v332 fix in flextext.js parsePhrase: before-words gls is read; after-words still WINS
 * when both exist (that is where this app writes its own, so re-imports keep reading their own
 * line); a word-level gls is never mistaken for a free translation.
 *
 * Runs under plain node via the minimal DOM in test/lib/mini-xml-dom.mjs (no npm deps — CI has no
 * install step).
 *
 * Run: node test/free-translation-position.test.mjs
 */
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { parseFlextext } = await import('../docs/js/flextext.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const PREFS = { vernLang: 'fau', analLang: 'id' };
const wrap = (phraseInner) => `<?xml version="1.0" encoding="utf-8"?>
<document version="2">
  <interlinear-text guid="t1">
    <item type="title" lang="en">Test</item>
    <paragraphs>
      <paragraph guid="p1">
        <phrases>
          <phrase guid="ph1">
${phraseInner}
          </phrase>
        </phrases>
      </paragraph>
    </paragraphs>
  </interlinear-text>
</document>`;

const seg = (xml) => {
  const { texts, error } = parseFlextext(wrap(xml), PREFS);
  if (error) throw new Error('fixture failed to parse: ' + error);
  return texts[0].paragraphs[0].segments[0];
};

console.log("\nSeth's field layout: phrase gls BEFORE <words> (this used to import empty)");
{
  const s = seg(`<item type="txt" lang="fau">Foo bar</item>
<item type="gls" lang="id">Terjemahan bebas</item>
<words>
  <word guid="w1"><item type="txt" lang="fau">Foo</item><item type="gls" lang="id">kata</item></word>
</words>`);
  ok(s.free === 'Terjemahan bebas', `free translation imported: "${s.free}"`);
  ok(s.freeLang === 'id', 'with its language');
  ok(s.words.some((w) => w.gls === 'kata'), 'and the WORD gloss stayed a word gloss');
}

console.log('\nboth sides present: AFTER <words> wins (that is where this app writes its own)');
{
  const s = seg(`<item type="gls" lang="id">sebelum</item>
<words>
  <word guid="w1"><item type="txt" lang="fau">Foo</item></word>
</words>
<item type="gls" lang="id">sesudah</item>`);
  ok(s.free === 'sesudah', `after-words line selected: "${s.free}" — a re-import of our own export reads its own line`);
}

console.log('\nmulti-WS before-words: the analysis-language line is selected');
{
  const s = seg(`<item type="gls" lang="en">English free</item>
<item type="gls" lang="id">Terjemahan</item>
<words>
  <word guid="w1"><item type="txt" lang="fau">Foo</item></word>
</words>`);
  ok(s.free === 'Terjemahan', 'the id line is picked when the device is set to id');
}

console.log('\nonly a foreign-language gls: falls back rather than importing empty (accepted behavior)');
{
  const s = seg(`<item type="gls" lang="en">English only</item>
<words>
  <word guid="w1"><item type="txt" lang="fau">Foo</item></word>
</words>`);
  ok(s.free === 'English only', 'the en line imports (round-trip fidelity; assign-time warning is the guard)');
  ok(s.freeLang === 'en', 'carrying its own code, which export preserves');
}

console.log('\na phrase with NO free translation stays empty — nothing is invented');
{
  const s = seg(`<words>
  <word guid="w1"><item type="txt" lang="fau">Foo</item><item type="gls" lang="id">kata</item></word>
</words>`);
  ok(!s.free, 'no phrase-level gls -> no free translation');
  ok(s.words.some((w) => w.gls === 'kata'), 'and the word gloss was NOT promoted to one');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
