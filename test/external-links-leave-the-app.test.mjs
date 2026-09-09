/* OFFSITE LINKS MUST LEAVE THE APP, OR NOT OPEN AT ALL.
 *
 * Seth, 2026-09-09: "my user just brought up an in-app browser (I think by clicking on the GitHub
 * link or something). That's not supposed to be possible. Can you make sure that our app has all
 * offsite hyperlinks open in such a way that Android OS will direct them to the default browser in
 * a new app window and fail if that's blocked?"
 *
 * ⚠ THIS IS A SAFETY PROPERTY, NOT A UX ONE. These are managed devices, and the filtering that
 * governs them applies to the DEFAULT BROWSER. A Chrome Custom Tab opened by an installed PWA is a
 * browser that never passes through it, so a link the app renders becomes a way around the
 * accountability the device is under. Hence: hand it to the OS, and if the OS refuses, let it fail.
 * There is deliberately NO fallback — a fallback would be the bug. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const EXT = rd('../docs/js/external-link.js');
const APP = rd('../docs/js/app.js');

test('the Android hand-off is an intent with NO fallback', () => {
  assert.match(EXT, /action=android\.intent\.action\.VIEW/, 'an ordinary VIEW intent — the default browser');
  // ⚠ Comments stripped: the module EXPLAINS the absence of a fallback in prose, naming the
  // parameter, so a bare match would hit the explanation rather than any code.
  const code = EXT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /browser_fallback_url/,
    'NO S.browser_fallback_url: a blocked device must do nothing rather than open an in-app view');
  assert.match(EXT, /location\.href = intentUrl\(url\)/, 'top-level assignment is what Chrome intercepts');
});

test('same-origin and non-http links are left completely alone', () => {
  const off = EXT.slice(EXT.indexOf('export function isOffsite'), EXT.indexOf('function intentUrl'));
  assert.match(off, /if \(!\/\^https\?:\$\/\.test\(u\.protocol\)\) return false;/,
    'mailto:, tel:, blob:, data: are not ours to route');
  assert.match(off, /return u\.origin !== location\.origin;/, 'only genuinely offsite URLs are intercepted');
});

/* ⚠ THE INTERCEPT IS DELEGATED, ON CAPTURE, AT document — because the links are not all in the
 * shells. Twenty offsite anchors exist across eleven hosts, many of them rendered from i18n HTML
 * strings inside views that re-render themselves. A rule applied per call site gets missed. */
test('every offsite anchor is intercepted, wherever it was rendered', () => {
  assert.match(EXT, /root\.addEventListener\('click', \(e\) => \{[\s\S]*?closest\('a\[href\]'\)/);
  // preventDefault happens for offsite links in BOTH cases — the app itself never navigates offsite.
  assert.match(EXT, /e\.preventDefault\(\);\s*\/\/ in BOTH cases/);
  assert.match(EXT, /if \(!allowOffsite\(\)\) \{ if \(opts\.onBlocked\) opts\.onBlocked\(a\.href\); return; \}/);
  assert.match(EXT, /openExternal\(a\.href\);/);
  assert.match(EXT, /\}, true\);/, 'capture phase, so a nearer handler cannot swallow it first');
});

/* ⚠ THE SAME TRAP THE REFRESH BUTTON FELL INTO. setup() returns early for crowd, paragraph,
 * researcher, record and consent mode — an offsite link escaping to an in-app browser in ONE of
 * those apps is the entire bug, so the wiring must not live inside setup(). */
test('it is wired at module scope, above setup() and all its mode returns', () => {
  const wire = APP.indexOf('wireExternalLinks(document, {');
  const setupFn = APP.indexOf('\nfunction setup() {');
  assert.ok(wire > 0 && setupFn > 0);
  assert.ok(wire < setupFn, 'wired before setup() is even defined — no mode branch can skip it');
});

test('no programmatic opener bypasses the chokepoint', () => {
  for (const f of ['app.js', 'paragraph-ui.js', 'researcher-panel.js']) {
    const src = rd('../docs/js/' + f);
    for (const m of src.matchAll(/window\.open\((['"])(https?:\/\/[^'"]+)\1/g)) {
      assert.fail(`${f} opens ${m[2]} directly — route it through openExternal()`);
    }
  }
});

/* The Google sign-in redirect is a full-page navigation the panel performs on purpose. It is not an
 * anchor, so the interceptor never sees it — asserted so nobody "tidies" it into a link later. */
test('the OAuth redirect is untouched', () => {
  assert.match(rd('../docs/js/researcher-panel.js'),
    /location\.href = Researcher\.googleSignInUrl\(/,
    'sign-in navigates in place, and the anchor interceptor cannot affect it');
});

/* The Android APK bundles a snapshot of docs/js. It is copied wholesale, so a new engine module is
 * included automatically — but only when the bundle is rebuilt. */
test('the Android bundler copies the whole js directory, so the module ships with it', () => {
  assert.match(rd('../android/scripts/bundle-engine.sh'), /cp -R "\$ENGINE_SRC\/js"\s+"\$WWW\/js"/);
});

test('and no in-app browser plugin is installed in either Android app', () => {
  for (const app of ['editor', 'recorder']) {
    const pkg = JSON.parse(rd(`../android/apps/${app}/package.json`));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    assert.ok(!deps['@capacitor/browser'],
      `${app} must not depend on @capacitor/browser — that plugin IS an in-app browser`);
  }
});

test('every offsite anchor in the shipped HTML still declares target and rel', () => {
  const shells = ['../docs/index.html', ...readdirSync(new URL('../satellites/', import.meta.url))
    .filter((d) => !d.startsWith('.')).map((d) => `../satellites/${d}/index.html`)];
  for (const p of shells) {
    let html; try { html = rd(p); } catch { continue; }
    for (const m of html.matchAll(/<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>/g)) {
      if (m[1].includes('flextext.app')) continue;
      assert.match(m[0], /target="_blank"/, `${p}: ${m[1]} needs target=_blank`);
      assert.match(m[0], /rel="[^"]*noopener/, `${p}: ${m[1]} needs rel=noopener`);
    }
  }
});

/* ⚠ INVITE LINKS MUST NEVER LEAVE THROUGH THIS PATH. Their fragment (`#k=…`) carries E2EE key
 * material. They are same-origin, so isOffsite() rejects them before openExternal sees them — but
 * that is a property worth asserting rather than assuming, because the consequence is handing a
 * device's key to whatever app answered the intent. */
test('an invite link is not offsite, so it can never be handed to another app', () => {
  const off = EXT.slice(EXT.indexOf('export function isOffsite'), EXT.indexOf('function intentUrl'));
  assert.match(off, /u\.origin !== location\.origin/,
    'same-origin URLs — which is what every invite is — are excluded by construction');
  assert.match(EXT, /invite must never be handed to another app/,
    'and the reason is written down where the next reader will meet it');
});

/* ── a paired device has NO clickable way off the site ────────────────────────────────────────
 * Seth, 2026-09-09: "paired devices should have NO clickable hyperlinks that lead off the site…
 * Embedded/linked content, CDN, scripts, cloudflare, worker back end, Google Drive, whatever else
 * going on in the background is fine. But nothing the user can click on and get an in app browser
 * to another site as a result." */

test('offsite links are switched off entirely once a device is paired', () => {
  assert.match(APP, /allowOffsite: \(\) => !Sync\.hasSession\(\)/,
    'unpaired keeps its links — that is somebody\'s own phone; paired has none');
  assert.match(EXT, /const allowOffsite = opts\.allowOffsite \|\| \(\(\) => true\)/,
    'and the default stays permissive, so a surface that does not pass one is unaffected');
});

/* ⚠ A PREDICATE, NOT A CAPTURED VALUE. Wiring happens at startup, long before the device knows
 * whether it is paired, and pairing can change while the page is open. */
test('the gate is evaluated per click, not captured at wiring time', () => {
  const wire = EXT.slice(EXT.indexOf('export function wireExternalLinks'));
  assert.match(wire, /if \(!allowOffsite\(\)\)/, 'called at click time');
  assert.doesNotMatch(wire, /const allowed = allowOffsite\(\)/, 'not resolved once up front');
});

test('and they stop looking like links, so nobody presses a refusal', () => {
  assert.match(APP, /document\.body\.classList\.toggle\('no-offsite', Sync\.hasSession\(\)\)/);
  const css = rd('../docs/css/app.css');
  assert.match(css, /body\.no-offsite a\[href\^="http"\]:not\(\[href\*="flextext\.app"\]\)/);
  assert.match(css, /pointer-events: none;/);
});

test('the refusal explains itself, in both languages', () => {
  assert.match(APP, /toast\(t\('link\.offsiteBlocked'\)/);
  assert.equal((rd('../docs/js/i18n.js').match(/'link\.offsiteBlocked':/g) || []).length, 2);
});

/* ⚠ SCOPE. This must never touch background traffic — the engine from the CDN, the worker, Drive.
 * It only ever inspects anchor clicks, so there is nothing to exclude; asserted so a future
 * "improvement" that reaches into fetch() has to break this test first. */
test('it governs clicks only, never background requests', () => {
  for (const bad of [/fetch\s*=/, /XMLHttpRequest/, /serviceWorker/, /importScripts/]) {
    assert.doesNotMatch(EXT, bad, 'external-link.js has no business near background traffic');
  }
  assert.match(EXT, /closest\('a\[href\]'\)/, 'anchors, and only anchors');
});
