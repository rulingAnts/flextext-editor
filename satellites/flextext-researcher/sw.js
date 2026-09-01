/* Service worker for the "Flextext Researcher" PWA — DELIBERATELY NOT OFFLINE-CACHED (2026-08-31).
 *
 * Seth: "Our researcher panel really kind of doesn't need to be aggressively cached offline the
 * way the fieldworker apps do. In fact, that's almost counter productive. Pretty much everything
 * you can do with the researcher panel depends on an internet connection."
 *
 * He is right, and this file used to be the cost with no purchaser: auth is Google OIDC, every
 * read is a worker poll, every act is a worker call, and the panel deliberately persists no
 * decrypted state — so offline, a precached shell rendered a sign-in it could not complete.
 * Meanwhile the precache made this satellite one of the deploy-order outage surfaces (the
 * editor-engine SHELL), re-downloaded the entire engine on every version bump, and kept stale
 * panels running against a newer worker — the exact opposite of what an online console wants.
 * The freshest possible panel is the safest possible panel.
 *
 * WHAT THIS WORKER NOW DOES:
 *   · intercepts NAVIGATIONS ONLY — network first, and if the network is unreachable it serves
 *     the branded offline page INLINED below (versioned with this file; no cache store at all);
 *   · does not touch any other request — scripts, styles and API calls go to the network natively,
 *     with the estate's normal HTTP caching (do not "help" by adding no-store headers);
 *   · on activate, DELETES every flextext-researcher-* cache and claims clients, so panels
 *     installed under the old precaching worker actually let go of it (the service-worker-ghost
 *     lesson: without the takeover, this change would only ever reach new installs).
 *
 * ⚠ The FIELDWORKER apps (editor, recorder, crowd, PAT) keep their offline-first workers — offline
 * is their reason to exist. This file is the researcher console only.
 *
 * ⚠ VERSION/ENGINE below are kept as inert constants ON PURPOSE: bump-version.sh syncs them and
 * test/version-sync.test.mjs asserts the five sites agree, and a bump is still what makes this
 * file byte-different so installed copies fetch the new worker. Nothing here caches by them. */

const VERSION = 'v559';
const ENGINE = 'v559';   // editor ENGINE_VERSION this was built against — must match; see version-sync test

/* ⚠ LEGACY-ORIGIN KILL SWITCH (2026-08-17) — GitHub Pages only.
 *
 * THIS FILE SHIPS TO BOTH ESTATES: apps/researcher/build.sh copies this folder into the Cloudflare
 * deployment, so an unconditional kill switch here would break https://research.flextext.app/.
 * The hostname test is what lets one file serve both, like index.html's redirect.
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

/* The offline page, INLINED so it ships inside the worker the browser already stores: no cache
 * store, no install-time fetch, versioned with this file, cannot go stale independently.
 * Bilingual like the staging ribbon; single-theme on purpose (it commits to the panel's own look),
 * so background and every color are painted explicitly. */
const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flextext Researcher — offline</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column;
         background: #f4f7f6; color: #23312e;
         font-family: system-ui, "Segoe UI", Roboto, sans-serif; }
  header { background: #0f766e; color: #fff; padding: .9rem 1.2rem;
           font-size: 1.05rem; font-weight: 600; letter-spacing: .01em; }
  main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
  .card { max-width: 26rem; background: #fff; border: 1px solid #d8e2df; border-radius: 8px;
          padding: 1.6rem 1.8rem; text-align: center; }
  .mark { font-size: 2.2rem; line-height: 1; margin-bottom: .6rem; }
  h1 { font-size: 1.15rem; margin: 0 0 .5rem; }
  p { margin: .35rem 0; line-height: 1.45; }
  .id { color: #5c6f6a; font-size: .95rem; }
  button { margin-top: 1.1rem; background: #0f766e; color: #fff; border: 0; border-radius: 6px;
           padding: .6rem 1.6rem; font-size: 1rem; font-weight: 600; cursor: pointer; }
  button:hover { background: #0d685f; }
  button:focus-visible { outline: 3px solid #7cc4bc; outline-offset: 2px; }
</style>
</head>
<body>
<header>Flextext Researcher</header>
<main>
  <div class="card">
    <div class="mark" aria-hidden="true">&#9729;</div>
    <h1>You&rsquo;re offline</h1>
    <p>The researcher panel needs an internet connection. Please check your connection and try again.</p>
    <p class="id" lang="id">Panel peneliti memerlukan koneksi internet. Silakan periksa koneksi Anda dan coba lagi.</p>
    <button onclick="location.reload()">Try again &middot; Coba lagi</button>
  </div>
</main>
</body>
</html>`;

self.addEventListener('install', () => {
  // Nothing to precache on either estate. skipWaiting is the takeover: panels installed under the
  // old precaching worker must move to this one on their next update check, not their next-next.
  self.skipWaiting();
});

function dropOwnCaches() {
  // Scope to THIS app's OWN caches only ('flextext-researcher-*'). Three PWAs share one
  // origin/CacheStorage on the Pages estate, so an unscoped delete would wipe the editor's and
  // recorder's complete caches and brick a field device offline. ALL own versions go — this worker
  // keeps no cache of its own.
  return caches.keys().then(keys => Promise.all(
    keys.filter(k => k.startsWith('flextext-researcher-')).map(k => caches.delete(k))));
}

self.addEventListener('message', (e) => {
  // Kept for compatibility with the engine's update flow, which may message a waiting worker.
  if (!e.data) return;
  if (e.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data.type === 'CLEANUP') e.waitUntil(dropOwnCaches());
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
  e.waitUntil(dropOwnCaches().then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (LEGACY_ORIGIN) return;               // retiring: everything goes to the network untouched
  if (e.request.mode !== 'navigate') return;   // scripts/styles/API: browser-native, no SW overhead
  /* Navigations: network first, always — the panel must be the freshest the site serves. Only when
   * the network itself is unreachable does the inlined page answer, and it says exactly what to do. */
  e.respondWith(fetch(e.request).catch(() =>
    new Response(OFFLINE_HTML, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } })));
});
