#!/usr/bin/env node
/* What each language still owes, and a safe way to write the answers back.
 *
 * Built for INCREMENTAL translation (Seth, 2026-08-07): a language stays out of the picker until it
 * is finished, so translating one is a long job done in slices — by a person, or by /loop across
 * many sessions. Either way the two things that must not be done by hand are (a) working out what is
 * still missing and (b) splicing strings into a 2800-line file without disturbing the rest.
 *
 *   node tools/i18n-todo.mjs                    coverage for every language
 *   node tools/i18n-todo.mjs fr --n 40          the next 40 untranslated keys for French, as JSON
 *   node tools/i18n-todo.mjs fr --apply f.json  write {key: value} back into the fr block
 *
 * ⚠ --apply REFUSES to overwrite an existing translation, to add a key English does not have, or to
 * write an empty string. A pass that silently clobbered earlier work would be very hard to notice
 * and impossible to undo cleanly — and this is meant to be run unattended.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../docs/js/i18n.js', import.meta.url);
const src = readFileSync(FILE, 'utf8');

/* Where one language's object literal starts and ends. The blocks are flat and each begins at
 * column 0 as `xx: {`, so the next such line (or the close of S) is the end. */
function blockAt(s, lang) {
  const at = s.indexOf(`\n${lang}: {`);
  if (at < 0) return null;
  const after = at + 1;
  const rest = s.slice(after + 1);
  const nxt = rest.search(/\n[a-z]{2,3}: \{/);
  return { start: after, end: nxt < 0 ? s.indexOf('\n};', after) + 1 : after + 1 + nxt };
}

/* ⚠ ONE SIMPLE PER-LINE REGEX, deliberately. The obvious `'((?:[^'\\]|\\.)*)'` for a
 * backslash-escaped string literal backtracks catastrophically on the lines it does NOT match, and
 * this file has 2800 of them. Greedy `.*` anchored to the line end is linear and good enough: every
 * entry here is written on exactly one line. */
function keysIn(text) {
  const m = new Map();
  for (const line of text.split('\n')) {
    // Trailing comments exist on some entries; without allowing them the tool under-counts and
    // would then "translate" a key that is already there, duplicating it.
    const x = /^ {2}'([A-Za-z0-9_.-]+)': '(.*?)',?(?:\s*\/\/.*)?$/.exec(line);
    if (x) m.set(x[1], x[2]);
  }
  return m;
}

const escape = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');

const enB = blockAt(src, 'en');
const EN = keysIn(src.slice(enB.start, enB.end));
const LANGS = [...src.matchAll(/^([a-z]{2,3}): \{$/gm)].map((m) => m[1]);

const [lang, ...rest] = process.argv.slice(2);
const flag = (name, dflt) => { const i = rest.indexOf('--' + name); return i < 0 ? dflt : rest[i + 1]; };

if (!lang) {
  console.log(`\n${EN.size} keys in en\n`);
  for (const l of LANGS) {
    const b = blockAt(src, l);
    const K = keysIn(src.slice(b.start, b.end));
    const done = [...EN.keys()].filter((k) => K.has(k) && K.get(k) !== '').length;
    const pct = ((done / EN.size) * 100).toFixed(1).padStart(5);
    console.log(`  ${l}  ${String(done).padStart(4)}/${EN.size}  ${pct}%  `
      + (done === EN.size ? 'COMPLETE — offered in the picker' : 'in progress — not offered'));
  }
  console.log('');
  process.exit(0);
}

const b = blockAt(src, lang);
if (!b) { console.error(`no '${lang}' block in i18n.js`); process.exit(1); }
const HAVE = keysIn(src.slice(b.start, b.end));
const missing = [...EN.keys()].filter((k) => !HAVE.has(k) || HAVE.get(k) === '');

const applyPath = flag('apply', null);
if (!applyPath) {
  const n = parseInt(flag('n', '40'), 10);
  const slice = missing.slice(0, n);
  // English source only: a translator needs the meaning, not the key's neighbours.
  console.log(JSON.stringify(Object.fromEntries(slice.map((k) => [k, EN.get(k)])), null, 2));
  console.error(`\n${lang}: ${missing.length} missing of ${EN.size}; showing ${slice.length}\n`);
  process.exit(0);
}

const incoming = JSON.parse(readFileSync(applyPath, 'utf8'));
const added = [], refused = [];
for (const [k, v] of Object.entries(incoming)) {
  if (!EN.has(k)) { refused.push(`${k} (not an English key)`); continue; }
  if (HAVE.has(k) && HAVE.get(k) !== '') { refused.push(`${k} (already translated)`); continue; }
  if (typeof v !== 'string' || !v.trim()) { refused.push(`${k} (empty)`); continue; }
  added.push([k, v]);
}
if (added.length) {
  const lines = added.map(([k, v]) => `  '${k}': '${escape(v)}',`).join('\n') + '\n';
  // Insert just before the block's closing "},\n" — never at the file level.
  const closeAt = src.lastIndexOf('},', b.end);
  writeFileSync(FILE, src.slice(0, closeAt) + lines + src.slice(closeAt));
}
console.log(`${lang}: added ${added.length}, refused ${refused.length}`);
for (const r of refused.slice(0, 10)) console.log('  refused: ' + r);
console.log(`${missing.length - added.length} still missing`);
