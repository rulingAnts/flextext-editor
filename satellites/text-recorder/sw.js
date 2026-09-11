/* Service worker for the "Flextext Recorder" PWA. Precaches its own thin shell PLUS
 * the shared engine it loads from the Flextext Editor repo (same origin), so the
 * recorder works fully offline.
 *
 * VERSION COUPLING — IMPORTANT: this SW caches byte copies of the editor engine
 * (/flextext-editor/js/*.js, css/app.css). Those files have their own lifecycle
 * in the editor repo. Bump VERSION here whenever you deploy — AND specifically
 * whenever the editor engine changes in a way the recorder should pick up — or
 * installed recorders keep serving a stale cached engine offline.
 *
 * ⚠ ENGINE below is the editor ENGINE_VERSION this satellite was built against, and
 * test/version-sync.test.mjs FAILS unless it matches the editor exactly. That is the guard
 * for the failure bumping VERSION alone cannot prevent: if this file is not edited at all,
 * the publish workflow finds the mirror unchanged, reports "no change — nothing to
 * publish", exits 0, and installed copies go on serving a STALE engine. The ordering gate
 * cannot see that — it only checks that the editor is live and its paths are 200, which
 * they are. Editing ENGINE is also what makes these bytes change, which is what makes the
 * browser fetch and install this worker at all. */

const VERSION = 'v678';
const ENGINE = 'v678';   // editor ENGINE_VERSION this was built against — must match; see version-sync test
const CACHE = 'text-recorder-' + VERSION;
const SHELL = [
  './',
  'index.html',
  'recorder.webmanifest',
  'icons/recorder.svg',
  'icons/recorder-192.png',
  'icons/recorder-512.png',
  'icons/recorder-apple-touch.png',
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
  '/flextext-editor/js/sfm-convert.js',
  '/flextext-editor/js/csv.js',
  '/flextext-editor/js/paragraph-export.js',
  '/flextext-editor/js/paragraph-model.js',
  '/flextext-editor/js/paragraph-ui.js',
  '/flextext-editor/js/history.js',
  // STATIC imports of app.js that were missing here until v679: typing.js and external-link.js (v653),
  // lameta.js (v665). An app that updated online and next opened offline got a 504 for them and never
  // started. test/shells-precache-startup-modules.test.mjs walks the real import graph so it cannot recur.
  '/flextext-editor/js/typing.js',
  '/flextext-editor/js/external-link.js',
  '/flextext-editor/js/lameta.js',
  '/flextext-editor/js/artifacts.js',
  '/flextext-editor/js/audio-capture-worklet.js',
  '/flextext-editor/js/flac.js',
  // app.js now STATICALLY imports the connectivity engine (top-level imports), so the
  // browser resolves these at module-load even in record mode — precache them or a
  // recorder that updates then goes offline mid-load throws on the missing imports.
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
/* v322 CONSISTENCY GUARD — see the editor's sw.js for the full story. sw.js is no-store while
 * engine files ride the CDN edge, so a fresh worker could atomically install a STALE mixed-version
 * shell. ?swv= keys every fetch past the edge to the (atomic) origin; the SENTINEL check on the
 * editor's i18n.js aborts install on any skew, so the OLD version keeps serving and the update
 * retries later. */
const SENTINEL = 'js/i18n.js';
const SENTINEL_RE = new RegExp("ENGINE_VERSION = '" + ENGINE + "'");
/* ⚠ PATIENCE MUST OUTLAST A REAL OUTAGE (Seth, 2026-09-09): "My apartment connection, even though
 * it is starlink (but shared among probably 30+ users) often drops a connection for 2 minutes or
 * more before coming back." Three tries at 500ms and 1s gave up in ONE AND A HALF SECONDS, so a
 * download that met a two-minute drop failed the whole install — and the app stayed on the old
 * version until some later check happened to land in a good window.
 *
 * Seven tries tapering to 3 minutes ride the drop out: 0.5s, 1s, 2s, 4s, 8s, 3min.
 *
 * ⚠ THIS CHANGES NOTHING ABOUT ATOMICITY. A file that still cannot be fetched throws, the install
 * throws with it, the worker never reaches installed, and the OLD version keeps serving from its
 * own untouched cache. More patience only means fewer installs abandoned over a link that was
 * coming back anyway. */
const PRECACHE_TRIES = 7;
const PRECACHE_WAIT_MAX_MS = 180000;
const backoffMs = (attempt) => Math.min(PRECACHE_WAIT_MAX_MS, 500 * 2 ** attempt);

async function precacheAll(cache, urls) {
  for (const url of urls) {
    let cached = false, lastErr;
    for (let attempt = 0; attempt < PRECACHE_TRIES && !cached; attempt++) {
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
      } catch (err) {
        lastErr = err;
        // Offline is not flakiness. Grinding every remaining file through the full taper buys
        // nothing and burns the link; bail now and let the next update check start over.
        if (self.navigator && self.navigator.onLine === false) throw err;
        if (attempt < PRECACHE_TRIES - 1) await new Promise(r => setTimeout(r, backoffMs(attempt)));
      }
    }
    if (!cached) throw lastErr || new Error('precache failed: ' + url);
  }
}
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => precacheAll(c, SHELL)));
});

function cleanupOldCaches() {
  // Scope to THIS app's OWN caches only ('text-recorder-*'). Three PWAs share one origin/CacheStorage, so
  // an unscoped `k !== CACHE` would delete the editor's + researcher's complete caches and brick them offline.
  return caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== CACHE && k.startsWith('text-recorder-')).map(k => caches.delete(k))));
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
  // precache the editor engine by path, so a global match can serve a SIBLING app's STALE copy of a shared
  // file (the "Utilities vanished in Firefox until hard reload" bug). Own-cache match keeps this recorder
  // on its own precached, version-consistent engine.
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
