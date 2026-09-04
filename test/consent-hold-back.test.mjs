// The hold-back mechanism, pinned in its INERT state (Seth, 2026-09-05: the consent collector was
// held at v566 for the v583 release and shipped in v584 the same day). Both halves stay available:
// a HOLD-BACK marker makes an app's deploy.sh a no-op on productionWeb, and HELD_BACK hides its
// Utilities link on the cloud and legacy estates. Neither is engaged now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const PANEL = readFileSync(new URL('docs/js/researcher-panel.js', root), 'utf8');
const APP = readFileSync(new URL('docs/js/app.js', root), 'utf8');
const APPS = ['consent', 'segmenter', 'editor', 'researcher', 'recorder', 'crowd'];

test('no app carries a HOLD-BACK marker: every app deploys on productionWeb', () => {
  for (const a of APPS) assert.ok(!existsSync(new URL(`apps/${a}/HOLD-BACK`, root)), `${a} has no marker`);
});

test('the consent app keeps the (inert) guard in both scripts, ahead of any build or deploy', () => {
  const DEPLOY = readFileSync(new URL('apps/consent/deploy.sh', root), 'utf8');
  const g = DEPLOY.indexOf('[ "${WORKERS_CI_BRANCH:-productionWeb}" = "productionWeb" ] && [ -f HOLD-BACK ]');
  assert.ok(g > 0 && g < DEPLOY.indexOf('bash build.sh') && g < DEPLOY.indexOf('\n  npx wrangler deploy'));
  assert.match(DEPLOY.slice(g, g + 400), /exit 0/, 'a held app is not a failed one');
  const BUILD = readFileSync(new URL('apps/consent/build.sh', root), 'utf8');
  const b = BUILD.indexOf('[ "$BRANCH" = "productionWeb" ] && [ -f HOLD-BACK ]');
  assert.ok(b > 0 && b < BUILD.indexOf('rm -rf public'));
  assert.match(BUILD.slice(b, b + 400), /exit 1/, 'a raw wrangler deploy is refused while held');
});

test('HELD_BACK is empty, so companionApps returns every app on every estate', () => {
  assert.match(PANEL, /const HELD_BACK = new Set\(\[\]\);/);
  const fn = PANEL.slice(PANEL.indexOf('export function companionApps(estate = HOME)'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /const testing = estate === ESTATES\.staging \|\| !!estate\.local;/);
  assert.match(body, /\.filter\(\(a\) => testing \|\| !HELD_BACK\.has\(a\.key\)\)/);
  const HELD = new Set([]), STAGING = {};
  const run = (estate) => [{ key: 'segmenter' }, { key: 'consent' }].filter((a) => (estate === STAGING || !!estate.local) || !HELD.has(a.key)).map((a) => a.key);
  for (const estate of [{}, { pages: true }, STAGING, { local: true }]) assert.deepEqual(run(estate), ['segmenter', 'consent']);
});

test('the editor still hides an anchor for any app companionApps would not return', () => {
  const fn = APP.slice(APP.indexOf('function wireCompanionLinks()'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /document\.querySelectorAll\('#companion-apps \[data-app\]'\)/);
  assert.match(body, /el\.hidden = !a;/);
});
