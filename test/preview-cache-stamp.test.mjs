/* A STAGING DEPLOY MUST NOT SERVE YESTERDAY'S CODE.
 *
 * Each shell's cache is keyed by VERSION alone (`const CACHE = '<app>-' + VERSION`) and the fetch
 * handler is cache-first. A service worker is reinstalled only when sw.js CHANGES BYTES — so a
 * deploy that does not touch VERSION leaves every browser that has already opened the app serving
 * the OLD files, silently and for ever.
 *
 * For a RELEASE that is correct: bump-version.sh changes VERSION every time, which is what each
 * sw.js header instructs, and stamping there would make every field device re-download an engine it
 * already has over a village connection. For STAGING it is a trap, because staging is deployed many
 * times a day under one version — and on 2026-09-03 it twice served me the previous day's engine
 * while I was verifying that morning's fix. A test rig that silently tests stale code is worse than
 * none: it produces confident wrong answers.
 *
 * Run: node test/preview-cache-stamp.test.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const sh = read('stamp-preview-cache.sh');

console.log('\nthe stamper exists and is exempt from production');
ok(existsSync(new URL('stamp-preview-cache.sh', root)), 'stamp-preview-cache.sh is present');
ok(/BRANCH="\$\{WORKERS_CI_BRANCH:-productionWeb\}"/.test(sh),
   'it defaults to productionWeb, so a local build is treated as production and left alone');
ok(/\[ "\$BRANCH" = "productionWeb" \] && exit 0/.test(sh), 'and productionWeb exits immediately');

console.log('\nit changes the cache KEY only — never VERSION or ENGINE');
ok(/const CACHE = \[\^;\]\*/.test(sh) || /const CACHE = \[\^;\]\*\)/.test(sh) || sh.includes("const CACHE = [^;]*"),
   'the substitution matches up to the first ; — not to end of line, which ate the newline');
ok(!/const VERSION/.test(sh.replace(/#[^\n]*/g, '')), 'VERSION is never rewritten (version-sync pins it across five files)');
ok(!/const ENGINE/.test(sh.replace(/#[^\n]*/g, '')), 'ENGINE is never rewritten (it is the install-time sentinel)');

console.log('\nit fails safe on the shells that have no cache');
ok(/\[ -f "\$SW" \] \|\| exit 0/.test(sh), 'a missing sw.js is a no-op (the crowd embed ships none)');
ok(/grep -q '\^const CACHE = ' "\$SW" \|\| exit 0/.test(sh),
   'and a sw.js with no CACHE line is a no-op (the researcher shell is deliberately not cached)');

console.log('\nthe stamp is stable per commit, and safe as an identifier');
ok(/WORKERS_CI_COMMIT_SHA/.test(sh) && /git rev-parse/.test(sh),
   'it uses the commit, so redeploying the same code does not churn every device\'s cache');
ok(/tr -cd 'a-zA-Z0-9'/.test(sh),
   'tr -cd (delete), not -c (replace) — replacing turned the trailing newline into a dash');

console.log('\nevery app that builds a shell calls it');
const dirs = readdirSync(new URL('apps/', root)).map((d) => `apps/${d}`).concat(['paragraph-analysis']);
for (const d of dirs) {
  const p = `${d}/build.sh`;
  if (!existsSync(new URL(p, root))) continue;
  const s = read(p);
  ok(/stamp-preview-cache\.sh/.test(s), `${d} calls the stamper`);
  ok(/for R in \.\.\/\.\. \.\./.test(s),
     `${d} finds the repo root rather than assuming a depth`);
}
