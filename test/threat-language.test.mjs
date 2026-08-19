/* HOW THE THREAT MODEL IS DESCRIBED — a standing policy, enforced.
 *
 * Seth, 2026-08-19: "In our documentation we should never mention hostile governments or hiding
 * things from them, anywhere in anything posted in the online repository or anywhere else. That is
 * our underlying concern, but it should be described more opaquely as protecting the privacy and
 * ethical research standards of indigenous communities."
 *
 * WHY A TEST AND NOT A NOTE. This repository is PUBLIC. The security requirements are unchanged —
 * the same encryption, the same remote wipe, the same minimisation — only the way they are
 * DESCRIBED changes. That makes it exactly the kind of rule that drifts back: the next person
 * writing a comment about why a column is encrypted will reach for the concrete motivation, because
 * it is the one that makes the code make sense. A grep that fails the build is the only durable
 * form of this rule, and it costs nothing to run.
 *
 * The vocabulary to use instead:
 *   - the privacy and research-ethics obligations this suite carries to the communities it serves
 *   - a device that is lost, or no longer in trusted hands / has left the team's control
 *   - an untrusted holder; a device out of the team's control
 *
 * Scans TRACKED files only (git ls-files), so scratch work and gitignored notes are not policed.
 *
 * Run: node test/threat-language.test.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

/* ⚠ Built from fragments ON PURPOSE — a literal here would make this file fail itself, and the
 * obvious "fix" would be to exclude this file, which would then also stop it catching a real one. */
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
                                    : 'no framing that names a state actor or an adversary of that kind');
}

console.log('\nthe replacement framing is actually present, not just the absence of the old one');
{
  const dev = readFileSync(new URL('../DEVELOPERS.md', import.meta.url), 'utf8');
  ok(/privacy and research ethics/i.test(dev),
     'DEVELOPERS.md states the threat model in terms of privacy and research ethics');
  ok(/indigenous communities/i.test(dev),
     '...and names whose privacy it is protecting');
  // The security REQUIREMENTS must not have been softened along with the language.
  ok(/end-to-end encrypted|E2EE/.test(dev), 'the E2EE claim itself is still made');
  ok(/encrypted\s+at\s+rest/i.test(dev), 'and so is the at-rest claim');
}

console.log(fail ? `\nFAILED (${fail}) — the threat model is being described the way it must not be.\n`
                 : '\nPASS: the concern is stated as privacy and research ethics, and the protections still stand.\n');
process.exit(fail ? 1 : 0);
