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
 * import graph at load, even though the panel uses only part of it). */

const VERSION = 'v62';
const CACHE = 'flextext-researcher-' + VERSION;
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
  e.waitUntil(cleanupOldCaches().then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
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
      if (e.request.mode === 'navigate') {
        return c.match('index.html').then(shell => shell || fetch(e.request));
      }
      return fetch(e.request).then(resp => {
        if (resp.ok) { const copy = resp.clone(); c.put(e.request, copy); }
        return resp;
      });
    }))
  );
});
