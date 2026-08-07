/* Service worker for the "Flextext Paragraph Analysis Tool" PWA. Precaches its own thin shell PLUS
 * the shared engine it loads from /flextext-editor/ — which, on THIS origin, is a copy of the
 * editor's docs/ assembled by build.sh into the SAME atomic Cloudflare deployment. That kills
 * the deploy-order hazard the GitHub Pages satellites live with: a precached engine path here
 * can never 404, because shell and engine always ship together.
 *
 * VERSION COUPLING still applies: ENGINE below is the editor ENGINE_VERSION this satellite was
 * built against, and test/version-sync.test.mjs FAILS unless it matches the editor exactly.
 * Keeping that test green requires editing this file, which changes its bytes, which is what
 * makes an installed browser fetch and install the new worker at all. Keep the SHELL engine
 * list IDENTICAL to the editor's sw.js (app.js resolves its whole static import graph at load,
 * even though paragraph mode uses only part of it). */

const VERSION = 'v113';
const ENGINE = 'v281';   // editor ENGINE_VERSION this was built against — must match; see version-sync test
const CACHE = 'flextext-paragraph-' + VERSION;

/* ⚠ THE GHOST (2026-08-04). This site's first deployment served the EDITOR at the origin root, so
 * browsers that visited then hold the editor's service worker at scope `/` — the same scope and
 * the same script URL this app now uses. Its leftover caches are named `flextext-v<n>`, which is
 * how we recognise that we are TAKING OVER from a foreign worker rather than upgrading ourselves.
 * In that case (and only then) we activate immediately instead of waiting behind it, drop its
 * caches, and send the open tab — which is still displaying ITS cached editor page — to the real
 * app. A normal update keeps the safe semantics: no skipWaiting, no surprise reloads mid-work. */
const isGhostCache = (k) => /^flextext-v\d+$/.test(k);
let takingOverFromGhost = false;
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/paragraph.svg',
  'icons/paragraph-192.png',
  'icons/paragraph-512.png',
  'icons/paragraph-apple-touch.png',
  // Shared engine + styles, served from the editor copy (same origin, same deployment).
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
];

// Per-file fetch with retries (resilient on flaky networks), then cache.put — STILL atomic: any file
// ultimately failing throws, so install never completes and the old version keeps serving. Retried on
// the next update check. (Matches the editor SW.)
async function precacheAll(cache, urls) {
  for (const url of urls) {
    let cached = false, lastErr;
    for (let attempt = 0; attempt < 3 && !cached; attempt++) {
      try {
        const resp = await fetch(url, { cache: 'reload' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + url);
        await cache.put(url, resp);
        cached = true;
      } catch (err) { lastErr = err; if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1))); }
    }
    if (!cached) throw lastErr || new Error('precache failed: ' + url);
  }
}
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await precacheAll(cache, SHELL);
    // See THE GHOST above: only a takeover from the stranded editor worker skips the wait.
    takingOverFromGhost = (await caches.keys()).some(isGhostCache);
    if (takingOverFromGhost) await self.skipWaiting();
  })());
});

function cleanupOldCaches() {
  // Scope to THIS app's OWN caches ('flextext-paragraph-*') plus the ghost editor caches this
  // origin was left with. On the shared dev-rig origin an unscoped `k !== CACHE` would delete the
  // editor's and recorder's complete caches and brick them offline — but a `flextext-v<n>` cache
  // on THIS origin can only be the stranded copy, and the dev rig never registers a worker at all
  // (the engine skips service workers on dev hosts), so it is never reached from there.
  return caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== CACHE && (k.startsWith('flextext-paragraph-') || isGhostCache(k)))
      .map(k => caches.delete(k))));
}

self.addEventListener('message', (e) => {
  if (!e.data) return;
  if (e.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data.type === 'CLEANUP') e.waitUntil(cleanupOldCaches());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    await cleanupOldCaches();
    await self.clients.claim();
    // The ghost's tab is still showing ITS cached editor page; claiming does not repaint it, so
    // send it to the real app. Only on a ghost takeover — never on a routine update.
    if (takingOverFromGhost) {
      const windows = await self.clients.matchAll({ type: 'window' }).catch(() => []);
      for (const c of windows) { try { c.navigate(c.url); } catch (err) { /* noop */ } }
    }
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Match ONLY this app's OWN cache (NOT the global caches.match), so a sibling app's stale
  // cached copy of the shared engine can never be served here (the researcher app hit exactly
  // that bug on the Pages origin — see its sw.js).
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
