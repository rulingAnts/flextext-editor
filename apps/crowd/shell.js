/* Shell Worker for the crowd recorder site (https://crowd.flextext.app/).
 *
 * ⚠ THIS ORIGIN ONCE SERVED THE EDITOR, AND A SERVICE WORKER OUTLIVED IT (Seth, 2026-08-05:
 * "always loads the editor, but then when I push Cmd+Shift+R it loads the correct page... even in
 * a private window"). Before the Root directory was set, the Worker built from the repo root and
 * served docs/ — so every browser that opened this origin registered the EDITOR's service worker
 * at scope `/`. That worker answers navigations from its own precached shell, so it keeps painting
 * the editor whatever this Worker sends; a hard reload bypasses it, which is exactly the tell.
 *
 * ⚠ AND THE CROWD APP HAS NO SERVICE WORKER OF ITS OWN, so unlike the other apps it cannot heal by
 * shipping a newer sw.js at the same URL — there is nothing to replace the ghost with. A 404 is not
 * enough either: Chrome drops a registration whose script 404s, but Firefox keeps it. So /sw.js
 * must serve a real, permanent KILL SWITCH — a script whose only job is to unregister itself and
 * drop the caches the ghost is serving from.
 *
 * ⚠ IT CLEARS CACHE STORAGE ONLY — never IndexedDB. An unsent crowd take lives in IndexedDB, and
 * wiping that to fix a display bug would destroy somebody's recording.
 */
const KILL = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  // Drop the ghost's precached shell — Cache Storage ONLY. IndexedDB holds unsent takes.
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
})()));
`;

const HEADERS = { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // The kill switch, permanently: this app has no service worker, so any registration here is a
    // ghost. Serving it as a real script is what lets Firefox drop it too.
    if (url.pathname === '/sw.js') return new Response(KILL, { headers: HEADERS });

    /* The editor ghost was registered from `/`, but the old build also exposed a whole EDITOR under
     * /flextext-editor/. Send a browser that NAVIGATES there back to the app — one origin, one app.
     *
     * ⚠ NAVIGATIONS ONLY, and this is not a nicety. The crowd shell loads the engine cross-path
     * (`/flextext-editor/css/app.css`, `/flextext-editor/js/app.js`) and build.sh copies docs/ to
     * exactly that prefix, so those files DO exist here. Redirecting the whole prefix answered every
     * stylesheet and module request with the HTML page, and the site rendered as two unstyled
     * elements (Seth, 2026-08-05). Sec-Fetch-Dest separates "the user typed this URL" from "the page
     * is fetching its own engine"; when it is absent, only bare/HTML-ish paths are treated as
     * navigations, so an asset is never swallowed. */
    if (url.pathname === '/flextext-editor' || url.pathname.startsWith('/flextext-editor/')) {
      const dest = request.headers.get('sec-fetch-dest');
      const navigating = dest ? dest === 'document' : !/\.[a-z0-9]+$/i.test(url.pathname);
      if (navigating) return Response.redirect(url.origin + '/', 302);
    }

    return env.ASSETS.fetch(request);
  },
};
