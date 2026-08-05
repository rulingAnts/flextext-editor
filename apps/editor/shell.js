/* Shell Worker for the flextext-editor site (https://app.flextext.app/).
 *
 * THE APP IS THE SITE ROOT. That is possible here and not on github.io: there the editor and its
 * satellites share ONE origin, so each app needs a disjoint sub-path or the browser treats them as
 * one PWA. This origin belongs to this app alone.
 *
 * Its one job: serve the service worker with `no-store`. The workers.dev CDN pinned a stale
 * sw.js for over an hour after deploys on the staging site (2026-08-04), so clients never saw
 * updates. Everything else is served straight from the asset binding.
 *
 * ⚠ No kill-switch routes here, unlike paragraph-analysis/shell.js. Those exist because that
 * origin once served a DIFFERENT app at `/` and stranded service workers at stale scopes. This
 * origin is new, so there is nothing to evict — do not copy them in without a reason.
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
    return env.ASSETS.fetch(request);
  },
};
