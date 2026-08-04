/* Shell Worker for the paragraph-analysis-tool site (the Paragraph Analysis satellite,
 * production https://pat.flextext.app/ + paragraph-analysis-tool.68mh29kgsd.workers.dev).
 *
 * Four jobs:
 *
 *  1. Redirect `/` to `/paragraph-analysis/` — the app lives at its PWA scope path, and the
 *     origin root is otherwise empty.
 *
 *  2. Serve this app's service worker with `no-store`: the workers.dev CDN pinned a stale
 *     /sw.js for an hour-plus after deploys on the staging site (2026-08-04), so clients never
 *     saw updates. Same fix as staging-shell.js.
 *
 *  3. ⚠ EVICT THE GHOST EDITOR SERVICE WORKER (Seth, 2026-08-04 — this bit production).
 *     Before the deploy contract landed, this site's FIRST deployment (made by the dashboard
 *     setup wizard, before build.sh ever ran) served the EDITOR at the origin ROOT. Every
 *     browser that opened the site in that window registered the EDITOR's service worker at
 *     scope `/`. That worker precaches the editor shell and answers EVERY navigation in its
 *     scope from its own cache — including `/paragraph-analysis/` — so those browsers keep
 *     showing the editor no matter what this Worker sends. curl saw the correct app the whole
 *     time; a real browser did not. Deleting the file is NOT enough: a 404 on the script makes
 *     Chrome drop the registration but FIREFOX KEEPS IT, so the ghost is permanent there.
 *     So we SERVE a kill-switch worker at the old script URL. On its next update check the
 *     browser fetches it, installs it, and it unregisters itself, drops the stale caches
 *     (never this app's own `flextext-paragraph-*`), and reloads the open tab onto the real app.
 *     Keep this route FOREVER — removing it re-strands anyone who has not come back yet.
 *
 *  4. Keep the copied engine from booting as a second app. `/flextext-editor/` exists on this
 *     origin only as asset storage for this app (build.sh copies ../docs there so the shell and
 *     its engine ship atomically). Serving the editor's HTML from it would let a stray visit
 *     register yet another service worker and re-create the ghost, so its HTML entry points
 *     redirect to the app and its sw.js is a kill-switch too. The engine's js/ and css/ — the
 *     files this app actually loads — pass through untouched.
 */

// Unregisters itself, clears everything EXCEPT this app's own caches, reloads open tabs.
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

const KILL_SWITCH_PATHS = new Set(['/sw.js', '/flextext-editor/sw.js']);
const APP_REDIRECTS = new Set(['/', '/index.html', '/flextext-editor/', '/flextext-editor/index.html']);
const NO_STORE = new Set(['/paragraph-analysis/sw.js']);

const APP = '/paragraph-analysis/';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (KILL_SWITCH_PATHS.has(path)) {
      return new Response(KILL_SWITCH, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          // A service worker script may only control its own directory and below; the header
          // keeps that explicit for the root registration it is evicting.
          'service-worker-allowed': '/',
        },
      });
    }

    if (APP_REDIRECTS.has(path)) return Response.redirect(url.origin + APP, 302);

    const res = await env.ASSETS.fetch(request);
    if (!NO_STORE.has(path)) return res;
    const h = new Headers(res.headers);
    h.set('cache-control', 'no-store');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  },
};
