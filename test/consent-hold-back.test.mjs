// The consent collector is held back from production (Seth, 2026-09-05: "hold consent-collector
// back from that release"). Two halves, both pinned here so releasing it is one deliberate commit:
// the deploy guard (apps/consent/HOLD-BACK + deploy.sh) and the hidden Utilities link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const PANEL = readFileSync(new URL('docs/js/researcher-panel.js', root), 'utf8');
const APP = readFileSync(new URL('docs/js/app.js', root), 'utf8');
const DEPLOY = readFileSync(new URL('apps/consent/deploy.sh', root), 'utf8');

test('apps/consent/deploy.sh exits 0 without deploying on productionWeb while HOLD-BACK exists', () => {
  const guard = DEPLOY.indexOf('[ "${WORKERS_CI_BRANCH:-productionWeb}" = "productionWeb" ] && [ -f HOLD-BACK ]');
  assert.ok(guard > 0, 'the guard exists');
  assert.ok(guard < DEPLOY.indexOf('bash build.sh'), 'it runs before the build');
  assert.ok(guard < DEPLOY.indexOf('\n  npx wrangler deploy'), 'and before the wrangler command (a comment above mentions it too)');
  const block = DEPLOY.slice(guard, guard + 400);
  assert.match(block, /exit 0/, 'held is not failed: the other apps\' jobs stay green');
  assert.match(block, /HELD BACK/, 'the log line says why');
  assert.ok(existsSync(new URL('apps/consent/HOLD-BACK', root)), 'HOLD-BACK is present — delete it to release');
  // Second line of defence: a dashboard command reset to raw `wrangler deploy` skips deploy.sh and runs
  // the [build] hook directly, so build.sh must FAIL (non-zero) on productionWeb while held.
  const BUILD = readFileSync(new URL('apps/consent/build.sh', root), 'utf8');
  const b = BUILD.indexOf('[ "$BRANCH" = "productionWeb" ] && [ -f HOLD-BACK ]');
  assert.ok(b > 0, 'build.sh has the guard');
  assert.ok(b < BUILD.indexOf('rm -rf public'), 'before anything is assembled');
  assert.match(BUILD.slice(b, b + 400), /exit 1/, 'a failed build publishes nothing');
  // The other apps carry no such guard: only consent is held.
  for (const a of ['segmenter', 'editor', 'researcher', 'recorder', 'crowd']) {
    const d = readFileSync(new URL(`apps/${a}/deploy.sh`, root), 'utf8');
    assert.doesNotMatch(d, /HOLD-BACK/, `${a} deploys normally`);
    assert.doesNotMatch(readFileSync(new URL(`apps/${a}/build.sh`, root), 'utf8'), /HOLD-BACK/, `${a} builds normally`);
    assert.ok(!existsSync(new URL(`apps/${a}/HOLD-BACK`, root)), `${a} has no marker`);
  }
});

test('companionApps hides a held-back app on production and the legacy estate, not on staging or the dev rig', () => {
  assert.match(PANEL, /const HELD_BACK = new Set\(\['consent'\]\);/);
  const fn = PANEL.slice(PANEL.indexOf('export function companionApps(estate = HOME)'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /const testing = estate === ESTATES\.staging \|\| !!estate\.local;/);
  assert.match(body, /\.filter\(\(a\) => testing \|\| !HELD_BACK\.has\(a\.key\)\)/);
  // Run the same logic the module runs, on the three estate shapes estateOf() produces.
  const HELD = new Set(['consent']), STAGING = {};
  const run = (estate) => [{ key: 'segmenter' }, { key: 'consent' }].filter((a) => (estate === STAGING || !!estate.local) || !HELD.has(a.key)).map((a) => a.key);
  assert.deepEqual(run({}), ['segmenter'], 'cloud: consent hidden');
  assert.deepEqual(run({ pages: true }), ['segmenter'], 'legacy pages: consent hidden');
  assert.deepEqual(run(STAGING), ['segmenter', 'consent'], 'staging: both');
  assert.deepEqual(run({ local: true }), ['segmenter', 'consent'], 'dev rig: both');
});

test('the editor hides the shell anchor of an app companionApps does not return', () => {
  const fn = APP.slice(APP.indexOf('function wireCompanionLinks()'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /document\.querySelectorAll\('#companion-apps \[data-app\]'\)/, 'walks every anchor, not just the returned ones');
  assert.match(body, /el\.hidden = !a;/, 'an unreturned app is hidden');
  assert.match(body, /if \(a && a\.url\) el\.href = a\.url;/);
});
