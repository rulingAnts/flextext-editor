/* Shell Worker for the flextext-paragraph site (the Paragraph Analysis satellite).
 *
 * Two jobs only:
 *  1. Redirect / to /paragraph-analysis/ (the app lives at its PWA scope path; the root of
 *     this origin is otherwise empty).
 *  2. Serve this app's service worker with `no-store` — the workers.dev CDN cache pinned a
 *     stale /sw.js for an hour-plus after deploys on the staging site (2026-08-04), which
 *     means clients never see updates. Same fix as staging-shell.js. Everything else passes
 *     through to the static assets untouched.
 */
const NO_STORE = new Set(['/paragraph-analysis/sw.js']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return Response.redirect(url.origin + '/paragraph-analysis/', 302);
    }
    const res = await env.ASSETS.fetch(request);
    if (!NO_STORE.has(url.pathname)) return res;
    const h = new Headers(res.headers);
    h.set('cache-control', 'no-store');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  },
};
