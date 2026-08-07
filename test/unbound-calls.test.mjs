/* The ReferenceError that shipped, and the guard against the next one.
 *
 * ⚠ WHAT HAPPENED: v292 added recordingProvenance(), which called `agcOn()`. The real function is
 * `effectiveAgc()`. Every file parsed, all suites passed, the app loaded normally — and RECORDING
 * WAS COMPLETELY BROKEN in every format. The take was captured and then lost behind "Conversion
 * failed: agcOn is not defined". It reached staging.
 *
 * ⚠ WHY NOTHING HERE CAUGHT IT, AND WHY THIS FILE IS NOT THE REAL FIX. `node --check` cannot see an
 * unbound identifier — the code is syntactically perfect. No pure-node test could reach it either:
 * the call sits inside a save path that needs a DOM and a microphone. A regex over the source cannot
 * do it honestly either; distinguishing a call from a method definition, a hoisted inner function or
 * a callback parameter is scope analysis, and a check that reports forty false positives gets muted
 * and then ignored, which is worse than no check.
 *
 * The REAL guard is `npx eslint docs/js` (eslint.config.mjs, no-undef), which found this bug and
 * reports zero. It is a dev/release step because this repo deliberately has no npm dependencies.
 * What is pinned HERE is the config's existence and the specific regression by name — so the
 * config cannot be quietly deleted, and this exact mistake cannot come back unnoticed.
 *
 * Run: node test/unbound-calls.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const app = read('../docs/js/app.js');
const cfg = read('../eslint.config.mjs');

console.log('\nthe no-undef guard is present and still does its one job');
ok(/'no-undef':\s*'error'/.test(cfg), "eslint.config.mjs enables no-undef as an ERROR");
ok(/sourceType:\s*'module'/.test(cfg), 'and parses the engine as ES modules, which is what it is');
ok(/npx eslint docs\/js/.test(cfg), 'and records the command to run before a release');

console.log('\nthe v292 regression, by name');
ok(!/\bagcOn\s*\(/.test(app), 'nothing calls agcOn() — the AGC decision function is effectiveAgc()');
ok(/function effectiveAgc\(\)/.test(app), 'effectiveAgc() is the one that exists');
ok(/agc: !nat \? effectiveAgc\(\) : undefined,/.test(app), 'recordingProvenance calls it by its real name');

console.log('\nthe near-miss that preceded it, also by name');
/* Swapping convertToMp3 out of the import for convertAudio would have broken the consent-recording
 * and saveRecording paths the same way. Both are imported; both still have callers. */
ok(/import \{[^}]*\bconvertToMp3\b[^}]*\} from '\.\/convert\.js'/.test(app), 'convertToMp3 is still imported');
ok((app.match(/\bconvertToMp3\(/g) || []).length >= 2, 'and still has more than one caller');

console.log(fail ? `\nFAILED (${fail})\n` : `\nPASSED\n`);
process.exit(fail ? 1 : 0);
