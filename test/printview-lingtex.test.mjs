/* LingTeX ROUND TRIP (plans/flex-desktop-segmenter.md §10): when LINGTEX_TOOLS points at a LingTeX-Tools
 * checkout, every printViewTsv output is fed through its FLEx-block parser and reference model; otherwise
 * this test reports SKIPPED — never "pass". Two known parser gaps stay as expected failures until fixed
 * upstream: trailing TABs trimmed on line 0 when a number leads it; sentence-final punctuation that
 * exists only on the Word row dropped.
 *
 * Run: LINGTEX_TOOLS=/path/to/LingTeX-Tools node test/printview-lingtex.test.mjs */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.LINGTEX_TOOLS;
if (!root) { console.log('\nSKIPPED: LINGTEX_TOOLS is not set — the LingTeX round trip was NOT run.\n'); process.exit(0); }
const core = join(root, 'docs', 'core.js'), ref = join(root, 'LingTeX-Word', 'tools', 'reference.js');
if (!existsSync(core) || !existsSync(ref)) { console.log(`\nFAILED: LINGTEX_TOOLS=${root} has no docs/core.js or LingTeX-Word/tools/reference.js\n`); process.exit(1); }
const { printViewTsv } = await import('../docs/js/printview-tsv.js');
const { parseFLExBlocks } = await import('file://' + core);
const { buildModels, modelToTsv } = await import('file://' + ref);
let fail = 0, xfail = 0;
const ok = (c, m, expectedFailure = false) => { if (!c && expectedFailure) { xfail++; console.log(`  xfail ${m}`); return; } console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const WS = { vern: [{ id: 'xx', abbr: 'Xx' }], anal: [{ id: 'en', abbr: 'Eng' }] };
const cases = [
  ['plain', { paraNumber: 1, segNumber: 1, segsInPara: 1, ws: WS, words: [{ form: 'aaa', glosses: { en: 'A' } }, { form: 'bbb', glosses: { en: 'B' } }], free: { en: 'f' }, lit: {}, notes: [] }],
  ['final punct (known gap)', { paraNumber: 1, segNumber: 1, segsInPara: 1, ws: WS, words: [{ form: 'aaa', glosses: { en: 'A' } }, { form: '.', punct: true }], free: { en: 'f' }, lit: {}, notes: [] }],
];
for (const [name, data] of cases) {
  const tsv = printViewTsv(data);
  let blocks;
  try { blocks = parseFLExBlocks(tsv); } catch (e) { ok(false, `${name}: parseFLExBlocks threw ${e.message}`); continue; }
  const models = buildModels(blocks);
  const back = models.map(modelToTsv).join('');
  const gap = /known gap/.test(name);
  ok(back.replace(/\r\n/g, '\n').trimEnd() === tsv.replace(/\r\n/g, '\n').trimEnd(), `${name}: LingTeX reproduces the block`, gap);
}
console.log(fail ? `\nFAILED (${fail})\n` : `\nPASSED (${xfail} expected failures)\n`);
process.exit(fail ? 1 : 0);
