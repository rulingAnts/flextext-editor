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

    /* The editor ghost was registered from `/`, but the old build also exposed the engine under
     * /flextext-editor/. Send those back to the app rather than serving a second copy of the
     * editor from this origin — one origin, one app. */
    if (url.pathname === '/flextext-editor' || url.pathname.startsWith('/flextext-editor/')) {
      return Response.redirect(url.origin + '/', 302);
    }

    return env.ASSETS.fetch(request);
  },
};
