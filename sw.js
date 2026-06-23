/* Service worker: precache the app shell so it works fully offline. */

// Bump VERSION on every deploy: clients check for a changed sw.js whenever
// they load / regain focus / come online, and offer the user an update.
const VERSION = 'v72';
// On localhost the SW serves NETWORK-FIRST so code edits show up immediately during dev
// (cache-first would keep serving a stale build until every file's VERSION is bumped). The
// SW stays registered (PWA + localStorage behave normally); production stays offline-first.
const DEV = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const CACHE = 'flextext-' + VERSION;
const SHELL = [
  './',
  'index.html',
  'record.html',
  'relay.html',
  'css/app.css',
  'js/app.js',
  'js/flextext.js',
  'js/db.js',
  'js/i18n.js',
  'js/audio.js',
  'js/convert.js',
  'js/zip.js',
  'js/upload.js',
  'js/sync.js',
  'js/crypto.js',
  'js/researcher.js',
  'js/researcher-panel.js',
  'js/record-pcm.js',
  'js/audio-capture-worklet.js',
  'js/flac.js',
  'js/vendor/wavesurfer.esm.js',
  'js/vendor/lame.min.js',
  'js/vendor/libflac.min.wasm.js',
  'js/vendor/libflac.min.wasm.wasm',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // No skipWaiting here: the page shows an "Update" button and tells us when
  // to take over (so we never swap versions under the user mid-edit).
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
});

function cleanupOldCaches() {
  return caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))));
}

self.addEventListener('message', (e) => {
  if (!e.data) return;
  if (e.data.type === 'SKIP_WAITING') self.skipWaiting();
  // Sent by the page on every startup; catches cleanups that raced a reload.
  if (e.data.type === 'CLEANUP') e.waitUntil(cleanupOldCaches());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(cleanupOldCaches().then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (DEV) {
    // Dev: always try the network so edits appear on reload; fall back to cache offline.
    e.respondWith(
      fetch(e.request).catch(() =>
        caches.match(e.request).then(hit => hit || caches.match('index.html')))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate' }).then(hit => {
      if (hit) return hit;
      if (e.request.mode === 'navigate') {
        return caches.match('index.html').then(shell =>
          shell || fetch(e.request));
      }
      return fetch(e.request).then(resp => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return resp;
      });
    })
  );
});
