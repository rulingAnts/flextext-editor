/* THE BETA TIER — seven <worker>-beta Cloudflare Workers that a release soaks on before productionWeb.
 *
 * WHY (Seth, 2026-10-10): "Before pushing to main production, push to beta and leave it there for
 * awhile (and have hopefully some users on the beta, including myself and my team)." Staging cannot
 * be that: it is redeployed many times a day, carries half-finished branches, and its cache name is
 * stamped per commit so it never behaves like an installed app. Beta is production's twin one step
 * earlier — same bytes, same bump, same backend — on origins real people install.
 *
 * What must stay true, and why each line is here:
 *   1. deploy.sh routes `beta` to a REAL deploy of a SEPARATE Worker, in every app, before the
 *      preview-alias fallback. A preview alias is a version OF the production Worker; a beta that
 *      people live on for weeks must not sit in the list `rollback` chooses from.
 *   2. The Worker name is derived from wrangler.toml, so the deploy and the panel's estate map (which
 *      names those hosts) cannot drift from each other without this test noticing.
 *   3. isBetaHost is the ONE reader of "am I on beta" (i18n.js), because beta ships BUILD_TAG '' —
 *      nothing in the build says beta; only the origin does.
 *   4. ?devreset is REFUSED on beta hosts although they are *.workers.dev. Real installs, real work.
 *   5. The editor's ?mode=researcher hand-off and the panel's link override both know the tier.
 *
 * Run: node test/beta-tier.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { isBetaHost } from '../docs/js/i18n.js';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const APPS = ['apps/editor', 'apps/researcher', 'apps/recorder', 'apps/crowd', 'apps/consent', 'apps/segmenter', 'paragraph-analysis'];
const workerName = (app) => (read(`${app}/wrangler.toml`).match(/^name = "([^"]+)"/m) || [])[1];

test('every app routes the beta branch to a real deploy of <worker>-beta, ahead of the preview fallback', () => {
  for (const app of APPS) {
    const sh = read(`${app}/deploy.sh`);
    const prod = sh.indexOf('if [ "$BRANCH" = "productionWeb" ]; then');
    const beta = sh.indexOf('elif [ "$BRANCH" = "beta" ]; then');
    const prev = sh.indexOf('versions upload --preview-alias');
    assert.ok(prod > 0 && beta > prod && prev > beta, `${app}: productionWeb → beta → preview, in that order`);
    const branch = sh.slice(beta, prev);
    assert.match(branch, /NAME=\$\(grep -m1 -E '\^name = "' wrangler\.toml/, `${app}: the name is read from wrangler.toml, never typed`);
    assert.match(branch, /npx wrangler deploy --name "\$NAME-beta"/, `${app}: a real deploy to the -beta Worker`);
    assert.doesNotMatch(branch, /versions upload/, `${app}: beta is not a preview alias`);
    assert.ok(workerName(app), `${app}: wrangler.toml names its Worker`);
  }
});

test('the panel\'s beta estate names exactly the hosts those deploys produce', () => {
  const panel = read('docs/js/researcher-panel.js');
  const map = (panel.match(/\n  beta: \{([\s\S]*?)\n  \},/) || [])[1] || '';
  assert.ok(map, 'ESTATES.beta exists');
  const hosts = [...map.matchAll(/https:\/\/([a-z0-9-]+)\.68mh29kgsd\.workers\.dev\//g)].map((m) => m[1]);
  const expected = APPS.map((a) => workerName(a) + '-beta').filter((n) => n !== 'paragraph-analysis-tool-beta');
  assert.deepEqual(hosts.sort(), expected.sort(), 'one entry per app the panel links (PAT is not linked by the panel, as on every estate)');
  for (const h of hosts) assert.ok(isBetaHost(h + '.68mh29kgsd.workers.dev'), `${h} is recognised as beta`);
  assert.match(map, /beta: true/, 'flagged beta');
  assert.doesNotMatch(map, /staging: true/, 'and not staging');
  // The worker's production allow-list carries every one of them, PAT included (its deploy exists even
  // though the panel does not link it) — a beta app that could not reach the backend would be a beta
  // of nothing.
  const prod = read('worker/wrangler.toml').split('[env.staging]')[0].match(/^ALLOWED_ORIGINS\s*=\s*"([^"]+)"/m)[1];
  for (const a of APPS) assert.ok(prod.includes(`https://${workerName(a)}-beta.68mh29kgsd.workers.dev`), `${a} beta origin allowed on the production worker`);
});

test('isBetaHost reads the origin convention and nothing else', () => {
  assert.equal(isBetaHost('flextext-editor-beta.68mh29kgsd.workers.dev'), true);
  assert.equal(isBetaHost('audio-segmenter-beta.68mh29kgsd.workers.dev'), true);
  assert.equal(isBetaHost('flextext-editor.68mh29kgsd.workers.dev'), false, 'production workers.dev host');
  assert.equal(isBetaHost('staging-flextext-editor.68mh29kgsd.workers.dev'), false, 'staging');
  assert.equal(isBetaHost('beta-flextext-editor.68mh29kgsd.workers.dev'), false, '⚠ a preview alias of a branch named beta is NOT the beta tier');
  assert.equal(isBetaHost('app.flextext.app'), false);
  assert.equal(isBetaHost('flextext-editor-beta.68mh29kgsd.workers.dev.evil.com'), false, 'suffix must be at the end');
  assert.equal(isBetaHost(undefined), false, 'tolerates a missing hostname (called during boot)');
});

test('the editor refuses ?devreset on beta, hands ?mode=researcher to the beta panel, and badges the tier', () => {
  const app = read('docs/js/app.js');
  const fn = app.slice(app.indexOf('function devResetAllowed(h)'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /if \(isBetaHost\(host\)\) return false;/, 'beta is refused');
  assert.ok(body.indexOf('isBetaHost(host)') < body.indexOf('/\\.workers\\.dev$/'), '...and checked BEFORE the broad workers.dev rule that would admit it');
  // Lift the real predicate with isDevHost stubbed false, and prove the property rather than the text.
  const call = (h) => new Function('isBetaHost', 'isDevHost', 'h', body.slice(body.indexOf('{') + 1))(isBetaHost, () => false, h);
  assert.equal(call('staging-flextext-editor.68mh29kgsd.workers.dev'), true, 'staging still honours ?devreset');
  assert.equal(call('flextext-editor-beta.68mh29kgsd.workers.dev'), false, '⚠ beta does not');
  assert.equal(call('app.flextext.app'), false, 'production never did');

  assert.match(app, /isBetaHost\(location\.hostname\) \? 'https:\/\/flextext-researcher-beta\.68mh29kgsd\.workers\.dev\/'/, 'the researcher hand-off stays on the tier');
  assert.match(app, /if \(isBetaHost\(location\.hostname\)\) ver \+= ' \\u00b7 beta';/, 'the version badge says beta (BUILD_TAG is empty on beta by design)');
});

test('the panel offers beta as a link OVERRIDE, never as the default, in both languages', () => {
  const panel = read('docs/js/researcher-panel.js');
  assert.match(panel, /const LINK_MODES = \['auto', 'cloud', 'pages', 'origin', 'beta'\];/);
  assert.match(panel, /if \(m === 'beta'\) return ESTATES\.beta;/);
  assert.match(panel, /opt\('beta', t\('panel\.adv\.links\.beta'\)\)/);
  const basesFor = panel.slice(panel.indexOf('function basesFor(estate)'), panel.indexOf('function basesFor(estate)') + 300);
  assert.doesNotMatch(basesFor, /beta/, 'basesFor does not route to beta on its own — a beta panel prints production links for real coworkers unless overridden');
  const i18n = read('docs/js/i18n.js');
  for (const k of ['panel.adv.links.beta', 'panel.rel.new.betaChannel']) {
    assert.equal(i18n.split(`'${k}':`).length - 1, 2, `${k} exists in both languages`);
  }
});

test('the beta workflow exists and the hold-back guard covers beta', () => {
  assert.ok(existsSync(new URL('.github/workflows/deploy-beta.yml', root)));
  assert.match(read('apps/consent/deploy.sh'), /\[ "\$\{WORKERS_CI_BRANCH:-\}" = "beta" \]; \} && \[ -f HOLD-BACK \]/);
  assert.match(read('stamp-preview-cache.sh'), /\[ "\$BRANCH" = "beta" \] && exit 0/);
});
