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
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/sw.js') {
      const res = await env.ASSETS.fetch(request);
      const out = new Response(res.body, res);
      out.headers.set('Cache-Control', 'no-store');
      return out;
    }
    return env.ASSETS.fetch(request);
  },
};
