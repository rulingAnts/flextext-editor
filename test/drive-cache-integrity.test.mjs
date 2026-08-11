/* The Drive proxy must never store a body it did not receive whole.
 *
 * WHY THIS TEST EXISTS (Seth, 2026-08-11): "It is happening with a file being used a SECOND time. A
 * Google Drive file." — the researcher panel's pre-send check failed on any Drive audio that had
 * already been assigned once, and earlier the same file produced "⚠ Cannot use this audio:
 * NetworkError when attempting to fetch resource" on the device. One cause, two faces.
 *
 * The Worker used to tee ONE Drive stream into two consumers:
 *     ctx.waitUntil(caches.default.put(cacheKey, resp.clone()));
 *     return withCors(resp, origin, env);
 * and probeAudioUrl reads the first chunk of the audio, then ABORTS — it only needs the magic
 * bytes. The abort cut the tee while the cache branch was still filling, so the stored entry was
 * SHORTER than its own Content-Length. The first use looked fine. The second use hit that entry and
 * the browser saw a connection that ended early: a bare TypeError, indistinguishable from an
 * unreachable host, for 24 hours (max-age=86400).
 *
 * So the test drives the real Worker with a Drive that truncates, and a cache that behaves like
 * Cloudflare's (rejects set-cookie, stores what it is given). The assertion is not "the code looks
 * right" — it is that NOTHING INCOMPLETE IS EVER STORED, and that a second request therefore cannot
 * be served a short body.
 *
 * Run: node test/drive-cache-integrity.test.mjs
 */
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const ID = 'abcdefghij1234567890';
const ENV = { RELAY_SECRET: 'tok', ALLOWED_ORIGINS: 'https://panel.test' };
const ORIGIN = { Origin: 'https://panel.test' };

/* A stand-in for caches.default with Cloudflare's two behaviours that matter here: a response
 * carrying set-cookie is REFUSED, and whatever body it is handed is what a later match serves. */
function fakeCache() {
  const store = new Map();
  return {
    store,
    async put(req, resp) {
      if (resp.headers.get('set-cookie')) throw new TypeError('Cannot cache response with Set-Cookie');
      store.set(req.url, { body: new Uint8Array(await resp.arrayBuffer()), headers: new Headers(resp.headers) });
    },
    async match(req) {
      const e = store.get(req.url);
      return e ? new Response(e.body, { status: 200, headers: e.headers }) : undefined;
    },
  };
}

/* A Drive that can lie: `served` bytes come back under a Content-Length of `declared`. */
function fakeDrive({ declared, served, setCookie = true }) {
  return async () => new Response(new Uint8Array(served), {
    status: 200,
    headers: {
      'content-type': 'audio/mpeg',
      'content-length': String(declared),
      'content-disposition': 'attachment; filename="talk.mp3"',
      ...(setCookie ? { 'set-cookie': 'NID=abc; Path=/' } : {}),
    },
  });
}

const mkCtx = () => { const p = []; return { waitUntil: (x) => p.push(x), settle: () => Promise.allSettled(p) }; };
const req = (path) => new Request(`https://w.test${path}`, { headers: ORIGIN });

globalThis.caches = { default: fakeCache() };
const worker = (await import('../worker/src/index.js')).default;

async function run(path, drive) {
  globalThis.caches.default = globalThis.caches.default;   // keep the store across calls in a case
  globalThis.fetch = drive;
  const ctx = mkCtx();
  const resp = await worker.fetch(req(path), ENV, ctx);
  await ctx.settle();
  return resp;
}

console.log('\na normal file: cached whole, and the second request is served whole');
{
  globalThis.caches.default = fakeCache();
  const N = 5000;
  const first = await run(`/drive?src=${ID}&t=tok`, fakeDrive({ declared: N, served: N }));
  ok(first.status === 200, 'first request succeeds');
  ok((await first.arrayBuffer()).byteLength === N, 'and returns the whole body');
  const entries = [...globalThis.caches.default.store.values()];
  ok(entries.length === 1, 'exactly one cache entry was stored');
  ok(entries[0]?.body.length === N, 'the STORED body is complete — not a truncated tee');
  ok(!entries[0]?.headers.get('set-cookie'), "Drive's set-cookie was stripped, so the put was not refused");
  ok(!entries[0]?.headers.get('access-control-allow-origin'), 'no CORS header is stored (it is stamped per request)');

  const second = await run(`/drive?src=${ID}&t=tok`, async () => { throw new Error('Drive must not be hit again'); });
  ok(second.status === 200, 'the second request is served from cache');
  ok((await second.arrayBuffer()).byteLength === N, 'and gets the FULL body — the bug was a short one here');
  ok(second.headers.get('access-control-allow-origin') === 'https://panel.test', 'with CORS for the asking origin');
}

console.log('\nan UPSTREAM truncation is never made permanent');
{
  globalThis.caches.default = fakeCache();
  const resp = await run(`/drive?src=${ID}&t=tok`, fakeDrive({ declared: 5000, served: 1200 }));
  ok(resp.status === 200, 'the short body is still passed through to the caller');
  ok(globalThis.caches.default.store.size === 0,
     'but NOTHING is cached, so one bad download cannot poison every later use');
}

console.log('\na file too big to hold whole is streamed, never half-stored');
{
  globalThis.caches.default = fakeCache();
  const big = 40 * 1024 * 1024;
  const resp = await run(`/drive?src=${ID}&t=tok`,
    async () => new Response(new Uint8Array(16), { status: 200, headers: { 'content-length': String(big), 'content-type': 'audio/wav' } }));
  ok(resp.status === 200, 'served');
  ok(globalThis.caches.default.store.size === 0, 'and not cached at all (a streamed put is the interruptible one)');
}

console.log('\nthe cache key is generational, so poisoned entries are abandoned on deploy');
{
  globalThis.caches.default = fakeCache();
  await run(`/drive?src=${ID}&t=tok`, fakeDrive({ declared: 100, served: 100 }));
  const key = [...globalThis.caches.default.store.keys()][0] || '';
  ok(/[?&]cv=\d+/.test(key), 'the key carries a generation: ' + key);
  ok(key.includes(`src=${ID}`), 'and is still keyed by the Drive id alone (token/origin never in it)');
}

console.log('\n/probe warms the cache with a complete body or not at all');
{
  globalThis.caches.default = fakeCache();
  const N = 900;
  const resp = await run(`/probe?src=${ID}&t=tok`, fakeDrive({ declared: N, served: N }));
  const body = await resp.json();
  ok(body.size === N && body.mime === 'audio/mpeg', 'probe reports size and type');
  ok(body.name === 'talk.mp3', 'and the filename');
  const e = [...globalThis.caches.default.store.values()][0];
  ok(!!e && e.body.length === N, 'the warmed entry is complete');

  globalThis.caches.default = fakeCache();
  await run(`/probe?src=${ID}&t=tok`, fakeDrive({ declared: 5000, served: 40 }));
  ok(globalThis.caches.default.store.size === 0, 'a truncated probe warms nothing');
}

console.log('\nthe gates still hold');
{
  globalThis.caches.default = fakeCache();
  globalThis.fetch = fakeDrive({ declared: 10, served: 10 });
  const bad = await worker.fetch(new Request(`https://w.test/drive?src=${ID}&t=nope`, { headers: ORIGIN }), ENV, mkCtx());
  ok(bad.status === 401, 'a wrong relay token is still 401');
  const foreign = await worker.fetch(new Request(`https://w.test/drive?src=${ID}&t=tok`, { headers: { Origin: 'https://evil.test' } }), ENV, mkCtx());
  ok(foreign.status === 403, 'an origin that is not allow-listed is still 403');
  const nosrc = await worker.fetch(new Request('https://w.test/drive?src=&t=tok', { headers: ORIGIN }), ENV, mkCtx());
  ok(nosrc.status === 400, 'a missing src is still 400');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
