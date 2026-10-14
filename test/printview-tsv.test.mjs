/* FLEx PRINT-VIEW TSV, REBUILT FROM DATA (desktop-flex; plans/flex-desktop-segmenter.md §10). Made-up data
 * only; the golden byte-compare against a real FLEx copy stays in scratch (V-13).
 *
 * Run: node test/printview-tsv.test.mjs */
const { printViewTsv, standardLines, MISSING } = await import('../docs/js/printview-tsv.js');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const WS = { vern: [{ id: 'xx', abbr: 'Xx' }], anal: [{ id: 'en', abbr: 'Eng' }] };
const seg = (over = {}) => ({ paraNumber: 2, segNumber: 1, segsInPara: 1, ws: WS,
  words: [{ form: 'aaa', glosses: { en: 'A' }, cat: 'n', morphs: [{ form: 'aaa', lexEntry: 'aaa', lexGloss: 'A', lexGram: 'n' }] },
          { form: 'bbb', glosses: {}, morphs: null }, { form: '.', punct: true }],
  free: { en: 'the line.' }, lit: {}, notes: [], ...over });

console.log('\nthe default line set, CRLF, trailing CRLF, NFC');
{
  const out = printViewTsv(seg());
  const rows = out.split('\r\n');
  ok(out.endsWith('\r\n') && rows[rows.length - 1] === '', 'CRLF line ends with a trailing CRLF');
  ok(rows[0] === '2\tWord\taaa\tbbb\t.', 'line 0: ref TAB label TAB cells; one-segment paragraph → bare paragraph number');
  ok(rows[1] === '\tMorphemes\taaa\t***\t', 'later lines start with an empty number cell; missing data is ***; punctuation is a 1-line pile (empty below)');
  ok(rows[5] === '\tWord Gloss\tA\t***\t', 'word gloss: *** where none');
  ok(rows[6] === '\tWord Cat.\tn\t***\t', 'word category');
  ok(rows[7] === '\t‎Free ‎‎the line.', 'Free line: M_v Free␠ M_v M_a text, with U+200E marks');
  ok(rows.length === 9, '7 interlinear lines + Free + trailing');
  ok(printViewTsv(seg()) === printViewTsv(seg({ free: { en: 'the line.'.normalize('NFD') } })), 'output is NFC');
}
console.log('\nmulti-segment paragraphs and label segments in numbering');
{
  const out = printViewTsv(seg({ paraNumber: 3, segNumber: 2, segsInPara: 4 }));
  ok(out.startsWith('3.2\tWord'), 'ref = para.segment when the paragraph has more than one segment');
}
console.log('\nrepeated line types get the WS abbreviation; RTL and Graphite');
{
  const lines = [...standardLines('xx', 'en'), { flid: -61, ws: 'id' }];
  const ws = { vern: WS.vern, anal: [{ id: 'en', abbr: 'Eng' }, { id: 'id', abbr: 'Ind', rtl: true }] };
  const out = printViewTsv(seg({ ws, free: { en: 'E', id: 'I' } }), { lines });
  const rows = out.split('\r\n');
  ok(rows[7] === '\t‎Free Eng ‎‎E', 'the first Free line names its WS when Free repeats');
  ok(rows[8] === '\t‏Free Ind ‏‎I', 'an RTL analysis WS uses U+200F for its own marks, U+200E for the vernacular mark');
  const g = { vern: [{ id: 'xx', abbr: 'Xx', graphite: true }], anal: [{ id: 'en', abbr: 'Eng', graphite: true }] };
  const out2 = printViewTsv(seg({ ws: g }));
  ok(out2.split('\r\n')[7] === '\tFree the line.', 'a Graphite-enabled WS gets no direction marks');
}
console.log('\nvariants with an inflection type spread Lex. Gloss over 3 and Lex. Entries over 2 columns');
{
  const d = seg({ words: [{ form: 'kuru', glosses: { en: 'ran' }, morphs: [
    { form: 'kur', lexEntry: 'kur', lexGloss: 'run', lexGram: 'v' },
    { form: '-u', lexEntry: '-u', lexGloss: 'PST', lexGram: 'v:Any', inflType: { entry: 'pst-var', prepend: '', append: '.PST' } }] }, { form: '.', punct: true }] });
  const rows = printViewTsv(d).split('\r\n');
  ok(rows[0] === '2\tWord\tkuru\t\t\t\t.', 'the word pile is padded to its morph width (1 + 3)');
  ok(rows[1] === '\tMorphemes\tkur\t-u\t\t\t', 'morphemes: the variant takes 3 columns');
  ok(rows[2] === '\tLex. Entries\tkur\t-u\tpst-var\t\t', 'Lex. Entries: entry + variant entry over 2');
  ok(rows[3] === '\tLex. Gloss\trun\t\tPST\t.PST\t', 'Lex. Gloss: prepend / gloss / append');
}
console.log('\nguesses: *** by default, shown only as a labelled option (D10)');
{
  const d = seg({ words: [{ form: 'aaa', glosses: {}, guess: { en: 'guessed' } }] });
  ok(printViewTsv(d).split('\r\n')[5] === '\tWord Gloss\t***', 'default: ***');
  ok(printViewTsv(d, { showGuesses: true }).split('\r\n')[5] === '\tWord Gloss\tguessed', 'opt-in: the guess');
}
console.log('\nnotes: one labelled block each; a saved line configuration is honoured');
{
  const lines = [{ flid: 5062001, ws: 'xx' }, { flid: 5060001, ws: 'en' }, { flid: -61, ws: 'en' }, { flid: -63, ws: 'en' }, { flid: -65, ws: 'en', enabled: false }];
  const rows = printViewTsv(seg({ notes: [{ text: 'n1', ws: 'en' }, { text: 'n2', ws: 'en' }] }), { lines }).split('\r\n');
  ok(rows.length === 6 && rows[0].startsWith('2\tWord') && rows[1].startsWith('\tWord Gloss'), 'only the configured interlinear lines, in order; a disabled line is skipped');
  ok(rows[3] === '\t‎Note ‎‎n1' && rows[4] === '\t‎Note ‎‎n2', 'each note its own block');
}
console.log('\n§ is a punctuation pile like any other');
{
  const rows = printViewTsv(seg({ words: [{ form: 'aaa', glosses: { en: 'A' } }, { form: '§', punct: true }] })).split('\r\n');
  ok(rows[0] === '2\tWord\taaa\t§' && rows[5] === '\tWord Gloss\tA\t', '§ on the Word line, empty below');
}
console.log(fail ? `\nFAILED (${fail})\n` : `\nPASSED\n`);
process.exit(fail ? 1 : 0);
