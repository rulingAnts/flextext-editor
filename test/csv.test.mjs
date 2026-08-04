/* CSV / TSV import — pure node.
 *
 * The design principle under test (Seth, 2026-08-05): "require certain conventions and document
 * those, rather than making our script smart enough to handle any possible CSV/TSV." So a file
 * that follows the documented convention must map itself with NO decisions, and anything else must
 * fall back to the user answering — never to a guess about content.
 *
 * Run: node test/csv.test.mjs
 */
import { parseDelimited, sniffDelimiter, looksLikeHeader, columnsOf, detectMapping, parseTime, csvToLines, templateCsv } from '../docs/js/csv.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `\n        got:  ${JSON.stringify(a)}\n        want: ${JSON.stringify(b)}`}`);

console.log('\nthe grid — quoting is where naive splitters break');
{
  eq(parseDelimited('a,b\n1,2\n').rows, [['a', 'b'], ['1', '2']], 'plain rows');
  eq(parseDelimited('a,"b,c",d').rows, [['a', 'b,c', 'd']], 'a quoted field may contain the delimiter');
  eq(parseDelimited('a,"line1\nline2",c').rows, [['a', 'line1\nline2', 'c']], 'and a newline');
  eq(parseDelimited('a,"say ""hi""",c').rows, [['a', 'say "hi"', 'c']], 'and doubled quotes');
  eq(parseDelimited('a\tb\tc').rows, [['a', 'b', 'c']], 'tabs work as well as commas');
  eq(parseDelimited('a,b\r\nc,d').rows, [['a', 'b'], ['c', 'd']], 'CRLF is normalized');
  eq(parseDelimited('a,b\n\n\n').rows, [['a', 'b']], 'trailing blank rows are dropped');
  eq(parseDelimited('').rows, [], 'empty input');
}

console.log('\ndelimiter sniffing prefers CONSISTENCY, not frequency');
{
  eq(sniffDelimiter('a\tb\tc\n1\t2\t3'), '\t', 'tabs');
  eq(sniffDelimiter('a,b,c\n1,2,3'), ',', 'commas');
  eq(sniffDelimiter('a;b;c\n1;2;3'), ';', 'semicolons (a European export)');
  // Prose commas inside tab-separated fields must not win: the tab count is CONSISTENT, the
  // comma count is not, which is the whole reason to score consistency rather than totals.
  eq(sniffDelimiter('text\ttranslation\nana bete\tHe went out, quickly, and quietly'), '\t',
     'a tab file whose text contains commas is still read as tabs');
}

console.log('\nheader detection');
{
  ok(looksLikeHeader([['Text', 'Free'], ['ana bete', 'He went']]), 'words above data');
  ok(!looksLikeHeader([['0.0', '1.5'], ['1.5', '3.0']]), 'numbers are data, not a header');
  ok(!looksLikeHeader([['a', 'b']]), 'a single row cannot be a header');
}

console.log('\nTHE DOCUMENTED CONVENTION maps itself, with no decisions asked');
{
  const { rows } = parseDelimited(templateCsv().split('\n').filter((l) => !l.startsWith('#')).join('\n'));
  ok(looksLikeHeader(rows), 'the template has a header row');
  const cols = columnsOf(rows, true);
  eq(cols.map((c) => c.name), ['Speaker', 'Start', 'End', 'Text', 'Glosses', 'Free translation'],
     'columns are named from the header');
  const m = detectMapping(cols);
  eq([m.speaker, m.start, m.end, m.baseline, m.gloss, m.free], [0, 1, 2, 3, 4, 5],
     'every role is recognised from the documented column names');
  const { lines } = csvToLines(rows, m, { hasHeader: true, timeUnits: 'seconds' });
  eq(lines.length, 3, 'three lines');
  eq(lines[0].baseline, 'ana bete kabo', 'text');
  eq(lines[0].words, [{ txt: 'ana', gls: '3SG' }, { txt: 'bete', gls: 'go' }, { txt: 'kabo', gls: 'out' }],
     'glosses pair with words IN ORDER — a spreadsheet cell has no column geometry to align by');
  eq(lines[0].free, 'He went out.', 'free translation');
  eq(lines[0].speaker, 'Barnabas', 'speaker');
  eq([lines[0].start, lines[0].end], [0, 1500], 'times');
  ok(lines[2].speaker === undefined, 'an empty speaker cell adds nothing');
}

console.log('\nan UNKNOWN shape falls back to asking, never to guessing about content');
{
  const { rows } = parseDelimited('ana bete,He went out.\nu sa doba,I went to the village.');
  ok(!looksLikeHeader(rows), 'no header here');
  const cols = columnsOf(rows, false);
  eq(cols.map((c) => c.name), ['Column 1', 'Column 2'], 'columns are just numbered');
  const m = detectMapping(cols);
  eq([m.baseline, m.free], [0, 1], 'the commonest shape is offered as a STARTING POINT (text, translation)');
  ok(m.gloss === undefined && m.speaker === undefined, 'and nothing else is invented');
  // The user overrides freely — that is the fallback, not cleverness.
  const { lines } = csvToLines(rows, { baseline: 1, free: 0 }, { hasHeader: false });
  eq(lines[0].baseline, 'He went out.', 'a remapped column is honoured');
}

console.log('\ntimes are ASKED about, because a bare number is ambiguous');
{
  eq(parseTime('1.5', 'seconds'), 1500, 'seconds');
  eq(parseTime('1500', 'ms'), 1500, 'milliseconds');
  eq(parseTime('1500', 'seconds'), 1500000, 'the SAME cell means something else in the other unit');
  eq(parseTime('0:01.500'), 1500, 'a clock is unambiguous whatever the setting');
  eq(parseTime('', 'ms'), null, 'empty → null, never 0');
  eq(parseTime('later', 'ms'), null, 'unparseable → null');
  const { rows } = parseDelimited('text,start,end\nana,0,1\nu sa,notatime,2');
  const { lines } = csvToLines(rows, { baseline: 0, start: 1, end: 2 }, { hasHeader: true, timeUnits: 'seconds' });
  eq([lines[0].start, lines[0].end], [0, 1000], 'a good row is timed');
  ok(lines[1].start === undefined, 'a row with an unreadable time is imported UNTIMED rather than dropped');
}

console.log('\nragged and hostile input degrades');
{
  const { rows } = parseDelimited('a,b,c\n1\n2,3');
  eq(columnsOf(rows, false).length, 3, 'the widest row sets the column count');
  const { lines } = csvToLines(rows, { baseline: 0, free: 2 }, { hasHeader: false });
  eq(lines.length, 3, 'short rows still import');
  eq(csvToLines([['', ''], ['x', '']], { baseline: 0 }, {}).lines.length, 1, 'wholly empty rows are skipped');
  eq(csvToLines([], { baseline: 0 }, {}).lines, [], 'no rows → no lines');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASS: the CSV/TSV import holds.\n');
process.exit(fail ? 1 : 0);
