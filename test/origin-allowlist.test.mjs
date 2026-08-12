/* The origin allow-list, including the feature-branch PREVIEW ALIAS patterns.
 *
 * WHY (2026-08-11): deploy.sh publishes every non-production branch to
 * `<branch>-<worker>.workers.dev`, and testing a major feature on its own preview estate is now the
 * standard workflow. Those origins must reach the STAGING worker without a config edit per branch —
 * but production origins must still be refused there, because "a field device reached the staging
 * backend" has to fail loudly rather than quietly work.
 *
 * The load-bearing detail is the leading `-` in `*-flextext-editor.…`: production is
 * `https://flextext-editor.…` with nothing before its name, so it cannot match. If someone ever
 * "simplifies" these patterns to `*.68mh29kgsd.workers.dev`, this test fails — that form would
 * silently admit every production app.
 *
 * Run: node test/origin-allowlist.test.mjs
 */
import { originAllows } from '../worker/src/v1.js';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const STAGING = readFileSync(new URL('../worker/wrangler.toml', import.meta.url), 'utf8')
  .split('[env.staging.vars]')[1].match(/ALLOWED_ORIGINS\s*=\s*"([^"]+)"/)[1]
  .split(',').map((s) => s.trim()).filter(Boolean);
const PROD = readFileSync(new URL('../worker/wrangler.toml', import.meta.url), 'utf8')
  .split('[env.staging]')[0].match(/^ALLOWED_ORIGINS\s*=\s*"([^"]+)"/m)[1]
  .split(',').map((s) => s.trim()).filter(Boolean);

console.log('\nthe staging list admits every feature-branch preview alias');
for (const o of [
  'https://assign-by-upload-flextext-researcher.68mh29kgsd.workers.dev',
  'https://assign-by-upload-flextext-editor.68mh29kgsd.workers.dev',
  'https://some-other-branch-flextext-recorder.68mh29kgsd.workers.dev',
  'https://x-paragraph-analysis-tool.68mh29kgsd.workers.dev',
]) ok(originAllows(STAGING, o), o);
ok(originAllows(STAGING, 'https://staging-flextext-editor.68mh29kgsd.workers.dev'), 'and the staging apps themselves');
ok(originAllows(STAGING, 'https://localhost'), 'and the local dev rig');

console.log('\n…but PRODUCTION origins are still refused by the staging worker (the loud-failure property)');
for (const o of [
  'https://flextext-editor.68mh29kgsd.workers.dev',
  'https://flextext-researcher.68mh29kgsd.workers.dev',
  'https://paragraph-analysis-tool.68mh29kgsd.workers.dev',
  'https://rulingants.github.io',
  'https://app.flextext.app',
]) ok(!originAllows(STAGING, o), o);

console.log('\nand nothing else gets in by suffix trickery');
for (const o of [
  'https://evil.com',
  'https://evil-68mh29kgsd.workers.dev',                                  // no dot/dash boundary
  'https://flextext-editor.68mh29kgsd.workers.dev.evil.com',              // suffix is not at the end
  'http://assign-by-upload-flextext-editor.68mh29kgsd.workers.dev',       // http, not https
  'https://a-flextext-editor.68mh29kgsd.workers.dev/path',                // not an Origin value
  'null',
  '',
]) ok(!originAllows(STAGING, o), JSON.stringify(o));

console.log('\nPRODUCTION\'s own list carries NO star entries and behaves exactly as an exact match');
ok(!PROD.some((e) => e.includes('*')), 'no wildcard entries in the production list');
ok(originAllows(PROD, 'https://rulingants.github.io'), 'an exact production origin matches');
ok(!originAllows(PROD, 'https://assign-by-upload-flextext-editor.68mh29kgsd.workers.dev'),
   'a preview alias does NOT reach the production worker');
ok(originAllows(['*'], 'https://anything.example'), 'the bare * still means everything');

console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
