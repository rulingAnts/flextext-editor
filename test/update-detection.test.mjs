/* HOW AN APP NOTICES A NEW VERSION, AND WHY IT NEVER BREAKS ITSELF DOING SO.
 *
 * Seth, 2026-09-09: "All our apps should be auto-detecting and attempting to load new versions
 * whenever there ARE new versions… we should not have service workers that aren't checking for and
 * loading new versions." And: "if the connection fails or a partial download, our service worker is
 * and should be very careful not to discard or overwrite existing cached code until the new version
 * is fully downloaded." And: "don't break anything else in the design that's important to us in
 * order to fix the auto-refresh speed."
 *
 * This file pins the mechanism, not the speed. The observed delay (5–15 min) is the 5-minute poll
 * plus a full shell download plus waiting for a safe moment — all deliberate, all cheap to keep. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js');
const SW = rd('../docs/sw.js');

/* ⚠ THE SAME TRAP THE REFRESH BUTTON FELL INTO. setup() returns early for six modes; a registration
 * stranded behind one of those returns is an app that can never update and never says so. */
test('every mode that ships a service worker actually registers one', () => {
  const setupFn = APP.indexOf('\nfunction setup() {');
  const calls = [...APP.matchAll(/setupServiceWorker\(\);/g)].map((m) => m.index).filter((i) => i > setupFn);
  assert.ok(calls.length >= 3, `registration is reached from several branches (found ${calls.length})`);
  // The editor/recorder/consent/segmenter share one call that must sit ABOVE their forks.
  const shared = calls[calls.length - 1];
  for (const mode of ['RECORD_MODE', 'CONSENT_MODE', 'SEGMENTER_MODE']) {
    const fork = APP.indexOf(`if (${mode}) {`, shared);
    assert.ok(fork > shared, `${mode} forks AFTER the shared registration, so it gets a worker`);
  }
  // Paragraph and researcher each register their own before returning.
  for (const mode of ['PARAGRAPH_MODE', 'RESEARCHER_MODE']) {
    const branch = APP.indexOf(`if (${mode}) {`, setupFn);
    const ret = APP.indexOf('return;', branch);
    assert.ok(APP.slice(branch, ret).includes('setupServiceWorker();'),
      `${mode} registers before it returns`);
  }
});

/* The crowd recorder deliberately has none — Seth: "The crowd recorder is OK with no service worker
 * at all. It just needs to cache recordings that are recorded but not uploaded." That caching is
 * IndexedDB, which owes nothing to a service worker. */
test('the crowd recorder registers none, and still cannot lose a recording', () => {
  const setupFn = APP.indexOf('\nfunction setup() {');
  const crowd = APP.indexOf('if (CROWD_MODE) { setupCrowdMode(); return; }', setupFn);
  const shared = APP.lastIndexOf('setupServiceWorker();');
  assert.ok(crowd > 0 && crowd < shared, 'it returns before the registration — no worker, by design');
  // The take is written to durable storage BEFORE the first upload attempt, and flushed after.
  const q = APP.slice(APP.indexOf('async function crowdQueueAndSubmit'), APP.indexOf('async function crowdQueueAndSubmit') + 1200);
  assert.ok(q.indexOf('crowdPutPending') < q.indexOf('crowdFlush'),
    'queued durably first, sent second — a failed send leaves the recording on the device');
});

/* ⚠ updateViaCache: 'none'. The default ('imports') leaves sw.js itself subject to the HTTP cache,
 * so an update check can be answered with the old worker. Our Cloudflare origins already send
 * no-store (wrangler.toml, added because "the workers.dev CDN cache pinned a stale /sw.js for an
 * hour-plus after deploys"), but the GitHub Pages mirror sends max-age=600 and we cannot change it. */
test('the worker script is never read from cache when checking for a new version', () => {
  assert.match(APP, /navigator\.serviceWorker\.register\('sw\.js', \{ updateViaCache: 'none' \}\)/);
  assert.match(rd('../wrangler.toml'), /no-store/, 'and the origin says so too, belt and braces');
});

test('it checks on load, on foreground, on reconnect, and on a timer', () => {
  const reg = APP.slice(APP.indexOf("register('sw.js'"), APP.indexOf('// ---- Auto-update'));
  assert.match(reg, /const check = \(\) => reg\.update\(\)/);
  assert.match(reg, /visibilitychange[\s\S]{0,80}check\(\)/, 'returning to the app checks');
  assert.match(reg, /'online'[\s\S]{0,60}check\(\)/, 'regaining the network checks');
  assert.match(reg, /setInterval\(\(\) => \{ check\(\); applyUpdateIfSafe\(\); \}, 5 \* 60 \* 1000\)/,
    'and every 5 minutes while open — the binding constraint on how fast an update is noticed');
});

/* ── Seth's invariant: a partial or failed download must never cost the working copy ──────────── */

test('a new version installs into its OWN cache, so the old one is never overwritten', () => {
  assert.match(SW, /const CACHE = /, 'the cache name is version-scoped');
  assert.match(SW, /caches\.open\(CACHE\)\.then\(c => precacheAll\(c, SHELL\)\)/,
    'install fills the NEW cache; nothing touches the old one');
});

test('if any single file fails after retries, the whole install fails and the old version keeps serving', () => {
  const pre = SW.slice(SW.indexOf('async function precacheAll'), SW.indexOf("self.addEventListener('install'"));
  assert.match(pre, /attempt < 3/, 'each file is retried');
  assert.match(pre, /setTimeout\(r, 500 \* \(attempt \+ 1\)\)/, 'with backoff');
  assert.match(pre, /if \(!cached\) throw lastErr/,
    'and one unrecoverable file throws — so the worker never reaches "installed", and cannot activate');
  // A CDN mid-deploy can serve new and old files together; the sentinel refuses that mixture.
  assert.match(pre, /version skew/, 'a file whose contents are not this VERSION fails the install');
  assert.match(pre, /cache: 'reload'/, 'and every precache fetch bypasses the HTTP cache');
});

test('old caches are pruned only AFTER the new version activates', () => {
  assert.match(SW, /self\.addEventListener\('activate'[\s\S]{0,120}cleanupOldCaches\(\)/,
    'cleanup runs at activate, when the new cache is already complete');
  assert.doesNotMatch(SW.slice(SW.indexOf("addEventListener('install'"), SW.indexOf('function cleanupOldCaches')),
    /cleanupOldCaches|caches\.delete/, 'install deletes nothing');
  // The page's startup CLEANUP message is guarded for the same reason.
  assert.match(APP, /if \(!reg\.waiting && !reg\.installing\) reg\.active\?\.postMessage\(\{ type: 'CLEANUP' \}\)/,
    'and the page refuses to ask for a cleanup while a new version is installing or waiting');
});

test('cleanup is scoped, so one app cannot brick its siblings on the shared origin', () => {
  assert.match(SW, /k\.startsWith\('flextext-'\) && !k\.startsWith\('flextext-researcher-'\) && !k\.startsWith\('flextext-paragraph-'\)/);
});

test('the new version waits for a safe moment rather than yanking work', () => {
  // ⚠ Comments stripped: the install block EXPLAINS this rule in prose ("No skipWaiting here"),
  // so a bare /skipWaiting/ would match the explanation instead of any code.
  const installCode = SW.slice(SW.indexOf("addEventListener('install'"), SW.indexOf('function cleanupOldCaches'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(installCode, /skipWaiting/, 'install does not skipWaiting — the page decides when');
  const safe = APP.slice(APP.indexOf('function updateSafeNow'), APP.indexOf('function doUpdateReload'));
  assert.match(safe, /savingRecording/, 'never mid-recording-save');
  assert.match(safe, /\.modal:not\(\[hidden\]\)/, 'never with a dialog open');
  assert.match(safe, /view-baseline[\s\S]{0,120}return false/, 'never with a text open for editing');
});
