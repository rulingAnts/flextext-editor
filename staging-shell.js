/* Staging-site shell Worker (dev site ONLY — the flextext-staging Worker built from the
 * `staging` branch; production stays on GitHub Pages).
 *
 * WHY THIS EXISTS: workers.dev sits behind Cloudflare's CDN cache, whose zone we cannot purge,
 * and it cached /sw.js with query strings stripped from the cache key — so after a deploy the
 * site served the NEW engine files with the OLD service worker for an hour-plus (2026-08-04:
 * three fresh deployments, sw.js pinned at v166, cf-cache-status: HIT on every probe). Clients
 * therefore never saw the update. Routing requests through this worker first and serving the
 * service-worker scripts with `no-store` takes the CDN out of the loop for exactly the files
 * whose freshness drives updates; everything else passes through untouched.
 */
const NO_STORE = new Set(['/sw.js', '/text-recorder/sw.js', '/flextext-researcher/sw.js']);

export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    const path = new URL(request.url).pathname;
    if (!NO_STORE.has(path)) return res;
    const h = new Headers(res.headers);
    h.set('cache-control', 'no-store');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  },
};
