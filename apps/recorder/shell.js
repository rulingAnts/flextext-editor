/* Shell Worker for the flextext-recorder site (https://record.flextext.app/).
 *
 * THE APP IS THE SITE ROOT. That is possible here and not on github.io: there the editor and its
 * satellites share ONE origin, so each app needs a disjoint sub-path or the browser treats them as
 * one PWA. This origin belongs to this app alone. The /flextext-editor/ copy on it is asset
 * storage (build.sh copies docs/ there), not a second site.
 *
 * Its one job: serve the service worker with `no-store`. The workers.dev CDN pinned a stale
 * sw.js for over an hour after deploys on the staging site (2026-08-04), so clients never saw
 * updates. Everything else is served straight from the asset binding.
 *
 * ⚠ No kill-switch routes here, unlike paragraph-analysis/shell.js. Those exist because that
 * origin once served a DIFFERENT app at `/` and stranded service workers at stale scopes. This
 * origin is new, so there is nothing to evict — do not copy them in without a reason.
 *
 * The one route below is NOT a kill switch: nothing here is being evicted. It enforces the
 * "asset storage, not a second site" line above, which until 2026-08-05 was only a comment —
 * /flextext-editor/ served a complete, navigable editor (200, <title>Flextext Editor) at a
 * sub-path of this app's own origin. That is the shape the service-worker ghost came in: a
 * reachable editor entry point can register a SW at /flextext-editor/ scope on THIS origin.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/sw.js') {
      const res = await env.ASSETS.fetch(request);
      const out = new Response(res.body, res);
      out.headers.set('Cache-Control', 'no-store');
      /* ⚠ CORS on sw.js is REQUIRED now that each app owns its origin. The researcher panel reads
       * every app's sw.js to show which version is live. On GitHub Pages all four apps share one
       * origin, so that read was same-origin and needed nothing; on Cloudflare it is cross-origin
       * and the browser blocked it outright (Seth, 2026-08-05: research.flextext.app could not read
       * app.flextext.app/sw.js). The estate split turned a same-origin read into a cross-origin one
       * — nothing about the panel changed.
       *
       * `*` is correct here rather than lax: sw.js is a world-readable static file containing a
       * version string, the request carries no credentials, and the alternative is enumerating every
       * origin that may ever host the panel (both estates, every preview alias, localhost). */
      out.headers.set('Access-Control-Allow-Origin', '*');
      return out;
    }
    /* ASSETS pass, DOCUMENTS bounce. build.sh copies docs/ to /flextext-editor/ so this app's shell
     * can load the engine cross-path exactly as it does on github.io — those fetches must go
     * through untouched. Only a browser NAVIGATING there gets sent to the app that owns this origin.
     *
     * ⚠ Gate on Sec-Fetch-Dest, never on the path alone. Redirecting the whole prefix is what broke
     * crowd.flextext.app in v212: every stylesheet and module request was answered with the HTML
     * page, and the site rendered as two unstyled elements. When the header is absent (curl, old
     * clients) fall back to "no file extension", so an asset is never swallowed. */
    if (url.pathname === '/flextext-editor' || url.pathname.startsWith('/flextext-editor/')) {
      const dest = request.headers.get('sec-fetch-dest');
      const navigating = dest ? dest === 'document' : !/\.[a-z0-9]+$/i.test(url.pathname);
      if (navigating) return Response.redirect(url.origin + '/', 302);
    }

    return env.ASSETS.fetch(request);
  },
};
