/* The help page's recording-limit figures must match the code that enforces them.
 *
 * WHY: docs/help/recording-limits.html tells researchers how many minutes a device can record, and
 * they configure real fieldwork from those numbers. The limit itself is one constant in
 * record-pcm.js that is EXPECTED to be retuned once a cheap Android phone has been measured. The
 * moment it moves, every figure on that page becomes a confident lie — and a wrong number in
 * documentation is worse than no number, because it gets trusted and planned around.
 *
 * So the page is checked against the real function rather than maintained by memory.
 *
 * Run: node test/help-doc-accuracy.test.mjs
 */
import { readFileSync } from 'node:fs';
import { pcmRamBudgetBytes } from '../docs/js/record-pcm.js';

const html = readFileSync(new URL('../docs/help/recording-limits.html', import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

// Float32 @48k mono is what the page's figures assume.
const minsMono = (gib) => pcmRamBudgetBytes(gib) / (48000 * 4) / 60;

console.log('\nstated ceilings match the enforced ones');
// The page rounds to friendly figures, so allow a margin — but not enough to hide a retune.
const claims = [
  [0.5, /0[.,]5 GB[^<]*<\/td>\s*<td>\s*(?:about|sekitar)\s*([\d]+)(?:[–-]([\d]+))?\s*(?:minutes|menit)/i],
  [1,   /<td>1 GB<\/td>\s*<td>\s*(?:about|sekitar)\s*([\d]+)\s*(?:minutes|menit)/i],
  [2,   /<td>2 GB<\/td>\s*<td>\s*(?:about|sekitar)\s*([\d]+)\s*(?:minutes|menit)/i],
  [4,   /<td>4 GB<\/td>\s*<td>\s*(?:about|sekitar)\s*([\d]+)\s*(?:minutes|menit)/i],
];
for (const [gib, re] of claims) {
  const m = html.match(re);
  if (!m) { ok(false, `${gib} GiB row not found in the page (did the table change shape?)`); continue; }
  const stated = m[2] ? (Number(m[1]) + Number(m[2])) / 2 : Number(m[1]);
  const real = minsMono(gib);
  const within = Math.abs(stated - real) <= Math.max(1.5, real * 0.2);
  ok(within, `${gib} GiB: page says ~${stated} min, code gives ${real.toFixed(1)} min`);
}

console.log('\nthe claims that must not silently become false');
ok(/no memory limit|tanpa batas/i.test(html),
   'still states that compressed formats have no memory limit');
ok(pcmRamBudgetBytes(0.5) < pcmRamBudgetBytes(1) && pcmRamBudgetBytes(1) < pcmRamBudgetBytes(4),
   'the page presents ceilings as rising with device memory, and they do');
ok(pcmRamBudgetBytes(0.5) < 0.5 * 1024 * 0.15 * 1024 * 1024,
   'no floor inversion — a weak device is never handed more than its memory justifies');
ok(/stereo halves|Stereo memotong/i.test(html),
   'still tells researchers stereo halves every figure (the app budgets on bytes, not seconds)');
ok(/16-bit WAV/.test(html) && /(usually the best first change|perubahan pertama yang terbaik)/i.test(html),
   'still recommends 16-bit WAV as the first change on a limited device');

console.log(fail ? `\nFAILED (${fail}) — the help page and the code disagree.\n`
                 : '\nPASS: the help page tells researchers the truth.\n');
process.exit(fail ? 1 : 0);
