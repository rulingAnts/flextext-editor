/* Shell Worker for the paragraph-analysis-tool site (the Paragraph Analysis satellite,
 * production https://pat.flextext.app/ + paragraph-analysis-tool.68mh29kgsd.workers.dev).
 *
 * THE APP IS THE SITE ROOT (Seth, 2026-08-04: "ideally the root of pat.flextext.app would be our
 * paragraph analysis tool — at the root, not redirecting to the sub-folder"). That is possible
 * here and nowhere else in the suite: on github.io the editor and satellites share ONE origin, so
 * each app needs a disjoint sub-path or the browser treats them as one PWA. This origin belongs to
 * this app alone; /flextext-editor/ on it is asset storage (build.sh copies ../docs there so the
 * shell and its engine ship atomically), not a second site.
 *
 * Three jobs:
 *
 *  1. Serve the app's service worker with `no-store`: the workers.dev CDN pinned a stale sw.js
 *     for an hour-plus after deploys on the staging site (2026-08-04), so clients never saw
 *     updates. Same fix as staging-shell.js.
 *
 *  2. ⚠ EVICT STALE REGISTRATIONS (this bit production, 2026-08-04). This site's FIRST
 *     deployment — the dashboard setup wizard's, before build.sh ever ran — served the EDITOR at
 *     the origin root, so every browser that opened it registered the EDITOR's service worker at
 *     scope `/`. That worker answers every navigation in its scope from its own precached shell,
 *     so those browsers kept painting the editor whatever this Worker sent; curl, having no
 *     service worker, saw the right app throughout, which is why release verification passed and
 *     Seth's browser still showed the editor ("works fine in a private window").
 *       - The GHOST AT `/sw.js` now fixes itself: that URL is the real app's service worker, so
 *         the browser's next update check REPLACES the ghost with us (sw.js takes it from there —
 *         it detects the ghost's cache, activates immediately instead of waiting behind it, and
 *         reloads the tab).
 *       - The other stale scopes get a KILL SWITCH: `/paragraph-analysis/sw.js` (this app's own
 *         first release, before it moved to the root) and `/flextext-editor/sw.js` (never a real
 *         app here). A 404 is NOT enough — Chrome drops a registration whose script 404s but
 *         FIREFOX KEEPS IT, which is why the ghost was permanent for Seth. Keep these routes
 *         FOREVER: removing one re-strands every browser that has not come back yet.
 *
 *  3. Send the old sub-path and the engine copy's HTML to the app, so no second app can register
 *     on this origin and re-create the mess. The engine's js/ and css/ pass through untouched.
 */

// Unregisters itself, clears everything EXCEPT the app's own caches, reloads open tabs.
// No fetch handler on purpose: while it is active, requests go straight to the network.
const KILL_SWITCH = `/* Stale-registration kill switch — see paragraph-analysis/shell.js */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys
        .filter((k) => !k.startsWith('flextext-paragraph-'))
        .map((k) => caches.delete(k)));
    } catch (e) { /* keep going: unregistering matters more than tidying */ }
    try { await self.clients.claim(); } catch (e) { /* noop */ }
    try { await self.registration.unregister(); } catch (e) { /* noop */ }
    try {
      const windows = await self.clients.matchAll({ type: 'window' });
      for (const c of windows) { try { c.navigate(c.url); } catch (e) { /* noop */ } }
    } catch (e) { /* noop */ }
  })());
});
`;

const KILL_SWITCH_PATHS = new Set(['/paragraph-analysis/sw.js', '/flextext-editor/sw.js']);
const TO_APP = new Set(['/paragraph-analysis', '/paragraph-analysis/', '/paragraph-analysis/index.html',
                        '/flextext-editor', '/flextext-editor/', '/flextext-editor/index.html']);
const NO_STORE = new Set(['/sw.js']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (KILL_SWITCH_PATHS.has(path)) {
      return new Response(KILL_SWITCH, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'service-worker-allowed': '/',
        },
      });
    }

    if (TO_APP.has(path)) return Response.redirect(url.origin + '/', 302);

    const res = await env.ASSETS.fetch(request);
    if (!NO_STORE.has(path)) return res;
    const h = new Headers(res.headers);
    h.set('cache-control', 'no-store');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  },
};
