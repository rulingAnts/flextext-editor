/* PROJECT DESCRIPTION ACCURACY — enforced, because this repository is public.
 *
 * This suite holds the language, voices and consent records of indigenous communities. Its security
 * design exists to honour the privacy and research-ethics obligations that come with that, and that
 * is the whole and accurate description of it.
 *
 * Describing the work in adversarial-intelligence terms MISREPRESENTS it, and a misrepresentation of
 * this project is not harmless: it makes ordinary community language work look like something it is
 * not, which can create risk for the people in it rather than reduce any. Accuracy is itself a
 * protective measure. See CLAUDE.md.
 *
 * ⚠ The requirements never soften with the language. This file asserts BOTH halves — that the
 * framing is right, AND that the encryption and at-rest claims are still made — so a future edit
 * cannot quietly drop a protection along with a phrase.
 *
 * Why a test: whoever next comments a piece of security code will reach for a motivating story,
 * because a story is what makes the code make sense. This makes that a build failure rather than a
 * publication.
 *
 * Deliberately terse below. Do not add explanatory prose to the match list, and do not exclude this
 * file from its own scan — the fragment construction exists so it can scan itself.
 *
 * Scans TRACKED files only (git ls-files); gitignored scratch is not policed.
 *
 * Run: node test/threat-language.test.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

/* Fragments, so this file passes its own scan. */
const H = 'host' + 'ile';
const BANNED = [
  H + '-government', H + ' government', H + '-gov', H + ' gov', H + '-actor', H + '-held',
  'government scrutiny', 'persecut', 'crackdown', 'secret police',
];

const files = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n').map((f) => f.trim()).filter(Boolean)
  .filter((f) => /\.(md|js|mjs|sql|html|css|json|sh|yml|yaml|webmanifest)$/i.test(f))
  .filter((f) => f !== 'test/threat-language.test.mjs');

console.log(`\nscanning ${files.length} tracked text files`);
{
  const hits = [];
  for (const f of files) {
    let body;
    try { body = readFileSync(f, 'utf8').toLowerCase(); } catch { continue; }
    for (const term of BANNED) if (body.includes(term)) hits.push(`${f} → "${term}"`);
  }
  ok(hits.length === 0, hits.length ? `found ${hits.length}:\n        ${hits.join('\n        ')}`
                                    : 'no framing that misdescribes what this project is');
}

console.log('\nthe accurate framing is present, not merely the absence of the other');
{
  const dev = readFileSync(new URL('../DEVELOPERS.md', import.meta.url), 'utf8');
  ok(/privacy and research ethics/i.test(dev),
     'DEVELOPERS.md describes the security work by what it protects');
  ok(/indigenous communities/i.test(dev),
     '...and names whose privacy it is protecting');
  // The security REQUIREMENTS must not have been softened along with the language.
  ok(/end-to-end encrypted|E2EE/.test(dev), 'the E2EE claim itself is still made');
  ok(/encrypted\s+at\s+rest/i.test(dev), 'and so is the at-rest claim');
}

console.log(fail ? `\nFAILED (${fail}) — see CLAUDE.md on how this work is described.\n`
                 : '\nPASS: described by what it protects, and the protections still stand.\n');
process.exit(fail ? 1 : 0);
