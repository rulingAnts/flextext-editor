/* The paragraph-analysis shell Worker's routing — pure node, no network.
 *
 * ⚠ WHY THIS SUITE EXISTS: this site's first (wizard-made) deployment served the EDITOR at the
 * origin root, so browsers that visited registered the editor's service worker at scope `/`. It
 * then answered every navigation from its own cache and showed the editor forever — invisible to
 * curl, and permanent in Firefox, which keeps a registration whose script 404s. The kill-switch
 * route is what evicts it, so these assertions guard the routes that fix production. Deleting the
 * kill switch would silently re-strand every browser that has not come back yet.
 *
 * Run: node test/paragraph-shell.test.mjs
 */
import shell from '../paragraph-analysis/shell.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

// Stand-in for the static-asset binding: echoes back which path was asked for.
const env = {
  ASSETS: {
    fetch: (req) => new Response('ASSET:' + new URL(req.url).pathname, {
      headers: { 'content-type': 'text/plain', 'cache-control': 'public, max-age=0, must-revalidate' },
    }),
  },
};
const get = (path, origin = 'https://pat.flextext.app') =>
  shell.fetch(new Request(origin + path), env);

console.log('\nkill switch at the STALE scopes (never at /sw.js — that is the real worker now)');
for (const p of ['/paragraph-analysis/sw.js', '/flextext-editor/sw.js']) {
  const res = await get(p);
  const body = await res.text();
  ok(res.status === 200, `${p} → 200 (NOT 404: Firefox keeps a registration whose script 404s)`);
  ok(/javascript/.test(res.headers.get('content-type') || ''), `${p} → served as JavaScript`);
  ok(res.headers.get('cache-control') === 'no-store', `${p} → no-store, so the update check always sees it`);
  ok(/registration\.unregister\(\)/.test(body), `${p} → unregisters the stale worker`);
  ok(/caches\.delete/.test(body), `${p} → clears the stale caches`);
  ok(/c\.navigate\(c\.url\)/.test(body), `${p} → reloads open tabs onto the real app`);
  ok(/!k\.startsWith\('flextext-paragraph-'\)/.test(body),
     `${p} → SPARES this app's own caches (deleting them would break it offline)`);
}

console.log('\nTHE APP IS THE ROOT — / is the app itself, not a redirect (Seth, 2026-08-04)');
{
  const res = await get('/');
  ok(res.status === 200, '/ → 200, served directly');
  ok((await res.text()) === 'ASSET:/', '/ → the app shell from the assets, NOT a redirect');
}

console.log('\nthe old sub-path and the engine copy send you to the app');
for (const p of ['/paragraph-analysis', '/paragraph-analysis/', '/paragraph-analysis/index.html',
                 '/flextext-editor', '/flextext-editor/', '/flextext-editor/index.html']) {
  const res = await get(p);
  ok(res.status === 302, `${p} → 302`);
  ok(res.headers.get('location') === 'https://pat.flextext.app/', `${p} → the root`);
}

console.log('\nthe redirect follows the origin it was asked on (custom domain AND workers.dev)');
{
  const res = await get('/paragraph-analysis/', 'https://paragraph-analysis-tool.68mh29kgsd.workers.dev');
  ok(res.headers.get('location') === 'https://paragraph-analysis-tool.68mh29kgsd.workers.dev/',
     'workers.dev old sub-path → its own root');
}

console.log("\nthe app's own service worker is served fresh, never from the CDN cache");
{
  const res = await get('/sw.js');
  ok((await res.text()) === 'ASSET:/sw.js', 'the REAL worker comes from the assets — this is what replaces the ghost');
  ok(res.headers.get('cache-control') === 'no-store', 'rewritten to no-store');
}

console.log('\neverything else passes through untouched');
for (const p of ['/index.html', '/manifest.webmanifest', '/flextext-editor/js/app.js',
                 '/flextext-editor/css/app.css', '/icons/paragraph.svg']) {
  const res = await get(p);
  const body = await res.text();
  ok(body === 'ASSET:' + p && res.headers.get('cache-control') !== 'no-store', `${p} → served as-is`);
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASS: the shell Worker routes correctly.\n');
process.exit(fail ? 1 : 0);
