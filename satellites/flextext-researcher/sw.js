/* Service worker for the "Flextext Researcher" PWA. Precaches its own thin shell PLUS
 * the shared engine it loads from the Flextext Editor repo (same origin), so the
 * researcher console works fully offline.
 *
 * VERSION COUPLING — IMPORTANT: this SW caches byte copies of the editor engine
 * (/flextext-editor/js/*.js, css/app.css). Those files have their own lifecycle
 * in the editor repo. Bump VERSION here whenever you deploy — AND specifically
 * whenever the editor engine changes in a way this app should pick up — or
 * installed copies keep serving a stale cached engine offline. Keep the SHELL
 * engine list IDENTICAL to the editor's sw.js (app.js resolves its whole static
 * import graph at load, even though the panel uses only part of it).
 *
 * ⚠ ENGINE below is the editor ENGINE_VERSION this satellite was built against, and
 * test/version-sync.test.mjs FAILS unless it matches the editor exactly. That is the guard
 * for the failure bumping VERSION alone cannot prevent: if this file is not edited at all,
 * the publish workflow finds the mirror unchanged, reports "no change — nothing to
 * publish", exits 0, and installed copies go on serving a STALE engine. The ordering gate
 * cannot see that — it only checks that the editor is live and its paths are 200, which
 * they are. Editing ENGINE is also what makes these bytes change, which is what makes the
 * browser fetch and install this worker at all. */

const VERSION = 'v364';
const ENGINE = 'v430';   // editor ENGINE_VERSION this was built against — must match; see version-sync test
const CACHE = 'flextext-researcher-' + VERSION;

/* ⚠ LEGACY-ORIGIN KILL SWITCH (2026-08-17) — GitHub Pages only.
 *
 * THIS FILE SHIPS TO BOTH ESTATES: apps/researcher/build.sh copies this folder into the Cloudflare
 * deployment, so an unconditional kill switch here would strip https://research.flextext.app/ of
 * its offline support. The hostname test is what lets one file serve both, like index.html's
 * redirect and the STAGING ribbon.
 *
 * On rulingants.github.io this worker stops being an app worker: it unregisters itself, drops its
 * own caches, and navigates any open window to the Cloudflare researcher — so an installed legacy
 * copy hands over on the FIRST launch after this ships rather than the second, which is what makes
 * the move invisible ("Ideally it silently redirects him so that he doesn't even notice").
 *
 * ⚠⚠ THE LINE THAT PROTECTS THE PAIRED EDITOR: the cache filter stays scoped to
 * 'flextext-researcher-*'. Three PWAs share ONE origin and ONE CacheStorage here, so the broad
 * filter used by paragraph-analysis/shell.js (delete everything that is not mine) would delete the
 * EDITOR's and RECORDER's complete caches and brick a field device offline. Same reason this file
 * never touches localStorage or IndexedDB, which are per-ORIGIN and therefore shared. Scope is also
 * why this cannot reach /flextext-editor/ at all: a worker only controls its own path.
 */
const LEGACY_ORIGIN = self.location.hostname === 'rulingants.github.io';
const MOVED_TO = 'https://research.flextext.app/';
const SHELL = [
  './',
  'index.html',
  'researcher.webmanifest',
  'icons/researcher.svg',
  'icons/researcher-192.png',
  'icons/researcher-512.png',
  'icons/researcher-apple-touch.png',
  // Shared engine + styles, served from the editor repo (same origin).
  '/flextext-editor/css/app.css',
  '/flextext-editor/js/app.js',
  '/flextext-editor/js/flextext.js',
  '/flextext-editor/js/db.js',
  '/flextext-editor/js/i18n.js',
  '/flextext-editor/js/audio.js',
  '/flextext-editor/js/convert.js',
  '/flextext-editor/js/zip.js',
  '/flextext-editor/js/upload.js',
  // native-audio.js is a TOP-LEVEL import of app.js (the Android native bridge; inert in a
  // browser). It MUST be precached or this app is dead offline — a missing static import
  // stops the whole module graph from loading.
  '/flextext-editor/js/native-audio.js',
  '/flextext-editor/js/record-pcm.js',
  '/flextext-editor/js/segments.js',
  '/flextext-editor/js/segment-strips.js',
  '/flextext-editor/js/seg-exports.js',
  '/flextext-editor/js/eaf-read.js',
  '/flextext-editor/js/sfm.js',
  '/flextext-editor/js/csv.js',
  '/flextext-editor/js/paragraph-export.js',
  '/flextext-editor/js/paragraph-model.js',
  '/flextext-editor/js/paragraph-ui.js',
  '/flextext-editor/js/history.js',
  '/flextext-editor/js/artifacts.js',
  '/flextext-editor/js/audio-capture-worklet.js',
  '/flextext-editor/js/flac.js',
  // app.js STATICALLY imports the connectivity engine (top-level imports), so the
  // browser resolves these at module-load — precache them or an updated app that
  // goes offline mid-load throws on the missing imports.
  '/flextext-editor/js/crypto.js',
  '/flextext-editor/js/sync.js',
  '/flextext-editor/js/researcher.js',
  '/flextext-editor/js/researcher-panel.js',
  '/flextext-editor/js/vendor/wavesurfer.esm.js',
  '/flextext-editor/js/vendor/lame.min.js',
  '/flextext-editor/js/vendor/libflac.min.wasm.js',
  '/flextext-editor/js/vendor/libflac.min.wasm.wasm',
  '/flextext-editor/help/ws-flex-codes.png',   // FLEx writing-systems help screenshot (panel Utilities) — offline
];

// Per-file fetch with retries (resilient on flaky networks), then cache.put — STILL atomic: any file
// ultimately failing throws, so install never completes and the old version keeps serving. Retried on
// the next update check. (Matches the editor SW.)
/* v322 CONSISTENCY GUARD — see the editor's sw.js for the full story. sw.js is no-store while
 * engine files ride the CDN edge, so a fresh worker could atomically install a STALE mixed-version
 * shell. ?swv= keys every fetch past the edge to the (atomic) origin; the SENTINEL check on the
 * editor's i18n.js aborts install on any skew, so the OLD version keeps serving and the update
 * retries later. */
const SENTINEL = 'js/i18n.js';
const SENTINEL_RE = new RegExp("ENGINE_VERSION = '" + ENGINE + "'");
async function precacheAll(cache, urls) {
  for (const url of urls) {
    let cached = false, lastErr;
    for (let attempt = 0; attempt < 3 && !cached; attempt++) {
      try {
        const bust = url + (url.includes('?') ? '&' : '?') + 'swv=' + VERSION + '-' + ENGINE;
        const resp = await fetch(bust, { cache: 'reload' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + url);
        if (url.endsWith(SENTINEL)) {
          const body = await resp.clone().text();
          if (!SENTINEL_RE.test(body)) throw new Error('version skew: ' + url + ' is not ' + ENGINE);
        }
        await cache.put(url, resp);
        cached = true;
      } catch (err) { lastErr = err; if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1))); }
    }
    if (!cached) throw lastErr || new Error('precache failed: ' + url);
  }
}
self.addEventListener('install', (e) => {
  // Legacy origin: nothing to precache — this worker exists only to hand over and retire.
  if (LEGACY_ORIGIN) { self.skipWaiting(); return; }
  e.waitUntil(caches.open(CACHE).then(c => precacheAll(c, SHELL)));
});

function cleanupOldCaches() {
  // Scope to THIS app's OWN caches only ('flextext-researcher-*'). Three PWAs share one origin/CacheStorage,
  // so an unscoped `k !== CACHE` would delete the editor's + recorder's complete caches and brick them offline.
  return caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== CACHE && k.startsWith('flextext-researcher-')).map(k => caches.delete(k))));
}

self.addEventListener('message', (e) => {
  if (!e.data) return;
  if (e.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data.type === 'CLEANUP') e.waitUntil(cleanupOldCaches());
});

self.addEventListener('activate', (e) => {
  if (LEGACY_ORIGIN) {
    e.waitUntil((async () => {
      /* Own caches ONLY — see the kill-switch note above; a broad filter bricks the editor. */
      try {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k.startsWith('flextext-researcher-')).map(k => caches.delete(k)));
      } catch (err) { /* keep going: handing over matters more than tidying */ }
      try { await self.clients.claim(); } catch (err) { /* noop */ }
      try { await self.registration.unregister(); } catch (err) { /* noop */ }
      /* Move windows that are open RIGHT NOW, so the handover happens on this launch rather than
       * the next one. Query string and fragment ride along: an OAuth return or a settings link
       * must survive the move. */
      try {
        const windows = await self.clients.matchAll({ type: 'window' });
        for (const c of windows) {
          try { const u = new URL(c.url); await c.navigate(MOVED_TO + u.search + u.hash); }
          catch (err) { /* noop */ }
        }
      } catch (err) { /* noop */ }
    })());
    return;
  }
  e.waitUntil(cleanupOldCaches().then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (LEGACY_ORIGIN) return;   // retiring: everything goes to the network, nothing is served cached
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Match ONLY this app's OWN cache (NOT the global caches.match). Three PWAs share one origin and ALL
  // precache the editor engine by path, so a global match can serve a SIBLING app's STALE copy of the
  // shared engine — that's the "Utilities link vanished in Firefox until a hard reload" bug (this app was
  // handed an old editor/recorder cached researcher-panel.js). Own-cache match keeps the researcher app on
  // its own precached, version-consistent engine.
  e.respondWith(
    caches.open(CACHE).then(c => c.match(e.request, { ignoreSearch: e.request.mode === 'navigate' }).then(hit => {
      if (hit) return hit;
      /* Help pages are real pages, not app routes — see docs/sw.js for the full note. The shell
       * fallback below never touches the network, so without this test every navigation to
       * help/*.html returned the APP SHELL with a 200. */
      if (e.request.mode === 'navigate' && !/\/help\//.test(url.pathname)) {
        return c.match('index.html').then(shell => shell || fetch(e.request));
      }
      return fetch(e.request).then(resp => {
        if (resp.ok) { const copy = resp.clone(); c.put(e.request, copy); }
        return resp;
      });
    }))
      /* ⚠ NEVER let respondWith REJECT — it makes the browser blame sw.js for what is really an
       * offline/DNS/abort failure. See docs/sw.js. */
      .catch(() => new Response('', { status: 504, statusText: 'offline or unreachable' }))
  );
});
