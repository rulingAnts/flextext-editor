/* Service worker: precache the app shell so it works fully offline. */

// Bump VERSION on every deploy: clients check for a changed sw.js whenever
// they load / regain focus / come online, and offer the user an update.
const VERSION = 'v196';
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
  'js/native-audio.js',
  'js/record-pcm.js',
  'js/segments.js',
  'js/segment-strips.js',
  'js/seg-exports.js',
  'js/eaf-read.js',
  'js/sfm.js',
  'js/csv.js',
  'js/paragraph-export.js',
  'js/paragraph-model.js',
  'js/paragraph-ui.js',
  'js/history.js',
  'js/artifacts.js',
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
  'help/ws-flex-codes.png',   // FLEx writing-systems help screenshot (panel Utilities) — precache for offline
];

// Fetch each shell file fresh with retries, then cache.put — far more resilient on a flaky field
// network than addAll (which is one try, all-or-nothing). STILL atomic: if any file ultimately fails
// we throw, so install never completes, this version never activates, and the OLD cached version keeps
// serving. The app retries the whole install on its next update check (load / focus / online / hourly),
// so a dropped connection mid-download can never leave a half-installed version.
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
  // No skipWaiting here: the page activates the new version at a SAFE moment (auto-update, see app.js)
  // — never mid-recording or with a text open.
  e.waitUntil(caches.open(CACHE).then(c => precacheAll(c, SHELL)));
});

function cleanupOldCaches() {
  // Scope to THIS app's OWN version caches only. The editor, recorder, and researcher are three PWAs on
  // ONE origin sharing one CacheStorage, so an unscoped `k !== CACHE` would delete the SIBLING apps'
  // complete caches and brick them offline. Editor caches are 'flextext-v*'; exclude
  // 'flextext-researcher-*' AND 'flextext-paragraph-*' (the paragraph app shares the origin on the
  // dev rig; on its own Cloudflare origin the exclusion is simply inert).
  return caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== CACHE && k.startsWith('flextext-') && !k.startsWith('flextext-researcher-') && !k.startsWith('flextext-paragraph-'))
      .map(k => caches.delete(k))));
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
    // Dev: always try the network so edits appear on reload; fall back to THIS app's own cache offline.
    e.respondWith(
      fetch(e.request).catch(() =>
        caches.open(CACHE).then(c => c.match(e.request).then(hit => hit || c.match('index.html'))))
    );
    return;
  }
  // Match ONLY this app's OWN cache (NOT the global caches.match). Three PWAs share one origin and ALL
  // precache the editor engine by path, so a global match can serve a SIBLING app's STALE copy of a
  // shared file — that's the "Utilities link vanished in Firefox until a hard reload" bug: the researcher
  // app was being handed an old editor/recorder cached engine. Own-cache match keeps each app on its own
  // precached, version-consistent engine; a hard reload (which bypasses the SW) was the only escape before.
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
