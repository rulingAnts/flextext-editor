/* en and id must stay key-for-key identical, permanently.
 *
 * WHY THIS EXISTS AS ITS OWN TEST: the failure mode is silent and it always shows up in the SECOND
 * language first — the one nobody reads while developing. A key present in `en` and missing from
 * `id` renders as its own raw name ("panel.opt.abm.30") to an Indonesian user, and nothing throws.
 * It has bitten twice this session alone: a string added to the wrong block (so English UI rendered
 * Indonesian), and four pre-existing duplicates in `id` where the later one silently won.
 *
 * ⚠ COUNTING t('...') CALLS WOULD NOT CATCH IT. Many labels are built by CONCATENATION —
 * t('panel.opt.' + group + '.' + value), t('setup.off.' + key) — so the key that renders never
 * appears as a literal anywhere. That is why this compares the two DICTIONARIES against each other
 * rather than the code against a dictionary; the per-surface tests expand the concatenated families
 * separately (device-setup, audio-converter).
 *
 * Run: node test/i18n-parity.test.mjs
 */
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const enAt = src.indexOf('\nen: {'), idAt = src.indexOf('\nid: {');
console.log('\nboth dictionaries are findable');
ok(enAt >= 0, 'the en block');
ok(idAt > enAt, 'and the id block after it');
if (enAt < 0 || idAt < 0) { console.log(`\nFAILED (${fail})\n`); process.exit(1); }

const read = (text) => {
  const found = [...text.matchAll(/^  '([a-zA-Z0-9_.\-]+)':/gm)].map((m) => m[1]);
  const set = new Set(), dup = [];
  for (const k of found) { if (set.has(k)) dup.push(k); set.add(k); }
  return { set, dup, n: found.length };
};
const EN = read(src.slice(enAt, idAt));
const ID = read(src.slice(idAt));

console.log('\nno key is defined twice in either language');
/* A duplicate is not a style problem: the LATER definition silently wins, so the string a reader
 * sees is not the one a maintainer finds when they grep for it. */
ok(EN.dup.length === 0, `en has no duplicate keys${EN.dup.length ? ': ' + EN.dup.join(', ') : ''}`);
ok(ID.dup.length === 0, `id has no duplicate keys${ID.dup.length ? ': ' + ID.dup.join(', ') : ''}`);

console.log('\nand the two are key-for-key identical');
const missId = [...EN.set].filter((k) => !ID.set.has(k));
const missEn = [...ID.set].filter((k) => !EN.set.has(k));
ok(missId.length === 0, `every en key exists in id${missId.length ? ' — MISSING: ' + missId.join(', ') : ` (${EN.set.size} keys)`}`);
ok(missEn.length === 0, `every id key exists in en${missEn.length ? ' — MISSING: ' + missEn.join(', ') : ''}`);
ok(EN.set.size === ID.set.size, `same count both ways (${EN.set.size} / ${ID.set.size})`);

console.log('\nnothing is left as an untranslated copy of the English');
/* Not every identical value is a bug — 'FLEx', 'ELAN', 'MP3', '1×' are the same in any language —
 * so this flags only multi-WORD values, where sameness means the translation was never done. */
const pairs = [];
for (const m of src.slice(enAt, idAt).matchAll(/^  '([a-zA-Z0-9_.\-]+)': '((?:[^'\\]|\\.)*)'/gm)) pairs.push([m[1], m[2]]);
const idMap = new Map();
for (const m of src.slice(idAt).matchAll(/^  '([a-zA-Z0-9_.\-]+)': '((?:[^'\\]|\\.)*)'/gm)) idMap.set(m[1], m[2]);
/* ⚠ SOME STRINGS ARE *SUPPOSED* TO BE IDENTICAL, and one of them is load-bearing. Each entry here
 * needs a reason, so the list stays a set of decisions rather than a place to bury new gaps. */
const SAME_ON_PURPOSE = {
  // ⚠⚠ NOT PROSE — these are the LITERAL column headings csv.js auto-detects, and its patterns are
  // English-only (/^(speaker|participant|who|voice)$/i and friends). Translating this sentence
  // would instruct an Indonesian user to type headings that will NOT be recognised, quietly losing
  // the auto-detection it promises and dropping them into manual column mapping with no
  // explanation. If it is ever translated, csv.js must learn the Indonesian words FIRST.
  'para.csvHowRow1': 'literal parser tokens, not words',
  // Format names and "lossless" are already loanwords in the id block
  // (e.g. 'FLAC — 24-bit (lossless, ~setengah ukuran)'), so these carry no untranslated English.
  'convert.fmt.wav24': 'format label; lossless is a loanword in id',
  'convert.fmt.wav16': 'format label; lossless is a loanword in id',
  'panel.opt.fmt.wav32': 'format label',
  'panel.opt.fmt.wav16': 'format label',
  'panel.opt.fmt.webmpcm': 'format label',
  'task.checkOk': '"Audio OK" reads the same in both',
};
const same = pairs.filter(([k, v]) => idMap.get(k) === v
  && v.trim().split(/\s+/).length >= 3
  && !SAME_ON_PURPOSE[k]);
ok(same.length === 0,
   same.length ? `${same.length} multi-word strings are byte-identical in both languages: ${same.slice(0, 6).map(([k]) => k).join(', ')}`
               : `no multi-word English string is sitting untranslated in the id block `
                 + `(${Object.keys(SAME_ON_PURPOSE).length} identical on purpose, each with a reason)`);
// The allowlist must not outlive its entries — a stale name here would hide a real gap later.
const stale = Object.keys(SAME_ON_PURPOSE).filter((k) => !EN.set.has(k));
ok(stale.length === 0, `every allowlisted key still exists${stale.length ? ': ' + stale.join(', ') : ''}`);

console.log(fail ? `\nFAILED (${fail})\n` : `\nPASSED\n`);
process.exit(fail ? 1 : 0);
