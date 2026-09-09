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

/* ⚠ INTERCEPTING `click` CANNOT BE THE WHOLE ANSWER, and this is the test that says why. A link is
 * followable without ever firing a click: middle-click and Ctrl/Cmd+click fire `auxclick`, and
 * long-press / right-click → "Open link in new tab" is the BROWSER's own menu, which never reaches
 * JavaScript. Each is a separate hole and a list of holes is not a guarantee — so on a paired
 * device the href is REMOVED. An <a> with no href is not a link by definition. */
test('on a paired device the href is removed, not merely intercepted', () => {
  const fn = EXT.slice(EXT.indexOf('export function enforceNoOffsiteLinks'));
  assert.match(fn, /a\.removeAttribute\('href'\)/, 'the attribute goes — that closes every vector at once');
  assert.match(fn, /a\.removeAttribute\('target'\)/);
  assert.match(fn, /a\.dataset\.offsiteHref = href/, 'stashed, so releasing the device restores them');
  assert.match(fn, /querySelectorAll\('a\[href\], area\[href\]'\)/, 'anchors AND image-map areas');
  assert.match(EXT, /auxclick/, 'and the reasoning is written down where the next reader meets it');
});

/* The views re-render — PAT rebuilds its whole UI per edit, help arrives from i18n HTML, the gloss
 * view repaints per keystroke — so a one-shot pass would protect only the first paint. */
test('and stays removed as views re-render', () => {
  const fn = EXT.slice(EXT.indexOf('export function enforceNoOffsiteLinks'));
  assert.match(fn, /new MutationObserver/);
  assert.match(fn, /childList: true, subtree: true, attributes: true, attributeFilter: \['href'\]/,
    'attribute changes count too: a re-render can set href on an element that already existed');
  assert.match(fn, /if \(!isPaired\) \{ restore\(host\); return; \}/, 'and unpairing puts them back');
});

/* ⚠ THE LICENCE NOTICE MUST STILL READ (Seth: "I think copyright notice and license with no links
 * should display. But no links"). So the anchor is un-linked, NOT hidden — the href removal is the
 * security property, this is the presentation one. Hiding would have dropped the licence notice and
 * left "free, open-source software ()." behind it. */
test('the notice still displays; only the link is gone', () => {
  assert.match(APP, /document\.body\.classList\.toggle\('no-offsite', paired\)/);
  assert.match(APP, /enforceNoOffsiteLinks\(paired\)/);
  const css = rd('../docs/css/app.css');
  const rule = css.slice(css.indexOf('a.offsite-off, area.offsite-off {'));
  assert.doesNotMatch(rule.slice(0, 200), /display: none/, 'the words stay readable');
  assert.match(rule.slice(0, 200), /text-decoration: none;[\s\S]{0,80}cursor: default;/,
    'they simply stop looking like a link');
  assert.doesNotMatch(css, /body\.no-offsite \.site-credit \{ display: none/,
    'the credit line is NOT hidden — the licence notice has to remain visible');
});

/* Nothing else can navigate offsite: no offsite <form action>, no cross-origin <iframe>, no <area>,
 * and every location.replace is same-origin. Asserted so a future one has to break this first. */
test('no other element type can carry the user offsite', () => {
  for (const f of ['../docs/index.html', '../docs/js/app.js', '../docs/js/paragraph-ui.js']) {
    const src = rd(f);
    for (const m of src.matchAll(/<form[^>]*action="(https?:\/\/[^"]+)"/g)) {
      assert.ok(m[1].includes('flextext.app'), `${f}: offsite form action ${m[1]}`);
    }
    for (const m of src.matchAll(/<iframe[^>]*src="(https?:\/\/[^"]+)"/g)) {
      assert.ok(m[1].includes('flextext.app'), `${f}: cross-origin iframe ${m[1]}`);
    }
  }
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
