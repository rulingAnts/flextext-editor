/* The Drive proxy must never store a body it did not receive whole — and must CACHE what it can.
 *
 * HISTORY (2026-08-11): this test was first written on the theory that an aborted panel probe
 * truncated a tee'd cache entry. A live A/B on the staging worker REFUTED that: Cloudflare's cache
 * keeps pulling a tee'd branch after the client aborts, and discards any stored body shorter than
 * its Content-Length — complete or nothing, always. What WAS broken in the old code was Drive's
 * set-cookie making every put silently reject (a permanently cold cache), and the same day v333's
 * over-correction briefly shipped big files UNCACHED entirely — turning every big-file download
 * into a fresh Drive fetch per device, the repeated-download pattern Drive throttles.
 *
 * So the fake cache here models Cloudflare's two verified behaviours: a set-cookie response is
 * REFUSED, and a body that does not match its own Content-Length is DISCARDED. The assertions:
 * nothing incomplete is ever stored, small files are buffered atomically, big KNOWN-LENGTH files
 * are tee-cached whole, and a second request is served the full body from cache.
 *
 * Run: node test/drive-cache-integrity.test.mjs
 */
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const ID = 'abcdefghij1234567890';
const ENV = { RELAY_SECRET: 'tok', ALLOWED_ORIGINS: 'https://panel.test' };
const ORIGIN = { Origin: 'https://panel.test' };

/* A stand-in for caches.default with Cloudflare's verified behaviours: a response carrying
 * set-cookie is REFUSED, and a body that ends short of its own Content-Length is DISCARDED
 * (complete-or-nothing — confirmed against the real edge, 2026-08-11). */
function fakeCache() {
  const store = new Map();
  return {
    store,
    async put(req, resp) {
      if (resp.headers.get('set-cookie')) throw new TypeError('Cannot cache response with Set-Cookie');
      const body = new Uint8Array(await resp.arrayBuffer());
      const declared = parseInt(resp.headers.get('content-length') || '', 10);
      if (Number.isFinite(declared) && body.length !== declared) return;   // CF discards short bodies
      store.set(req.url, { body, headers: new Headers(resp.headers) });
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

async function run(path, drive, env = ENV) {
  globalThis.caches.default = globalThis.caches.default;   // keep the store across calls in a case
  globalThis.fetch = drive;
  const ctx = mkCtx();
  const resp = await worker.fetch(req(path), env, ctx);
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

console.log('\na file too big to buffer is TEE-cached whole (v333 briefly did not cache these at all)');
{
  // DRIVE_CACHE_MAX_BYTES=1000 makes 5000 bytes "big", so the tee path runs with test-sized bodies.
  const ENV_SMALL = { ...ENV, DRIVE_CACHE_MAX_BYTES: '1000' };
  globalThis.caches.default = fakeCache();
  const N = 5000;
  const first = await run(`/drive?src=${ID}&t=tok`, fakeDrive({ declared: N, served: N }), ENV_SMALL);
  ok(first.status === 200, 'first request succeeds');
  ok((await first.arrayBuffer()).byteLength === N, 'and the client branch delivers the whole body');
  const entries = [...globalThis.caches.default.store.values()];
  ok(entries.length === 1 && entries[0].body.length === N, 'the cache branch stored the WHOLE body');
  ok(!entries[0]?.headers.get('set-cookie'), 'with set-cookie stripped (the put would have been refused)');
  const second = await run(`/drive?src=${ID}&t=tok`, async () => { throw new Error('Drive must not be hit again'); }, ENV_SMALL);
  ok(second.status === 200 && (await second.arrayBuffer()).byteLength === N,
     'and the second request is a full-body cache hit — no per-device Drive re-download');
}

console.log('\na big upstream truncation is served through but never stored');
{
  const ENV_SMALL = { ...ENV, DRIVE_CACHE_MAX_BYTES: '1000' };
  globalThis.caches.default = fakeCache();
  const resp = await run(`/drive?src=${ID}&t=tok`, fakeDrive({ declared: 5000, served: 1200 }), ENV_SMALL);
  ok(resp.status === 200, 'the short body still reaches the caller (their retry logic owns it)');
  ok(globalThis.caches.default.store.size === 0,
     "but the cache's Content-Length check discarded it — one bad download cannot poison later use");
}

console.log('\na body with NO declared length streams through uncached');
{
  globalThis.caches.default = fakeCache();
  const resp = await run(`/drive?src=${ID}&t=tok`,
    async () => new Response(new Uint8Array(16), { status: 200, headers: { 'content-type': 'audio/wav' } }));
  ok(resp.status === 200, 'served');
  ok(globalThis.caches.default.store.size === 0, 'and not cached (completeness would be unverifiable)');
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

  // Big file (over the buffer ceiling): the probe body has no other consumer, so it streams
  // straight into the cache — the researcher's pre-send check warms what the device downloads.
  const ENV_SMALL = { ...ENV, DRIVE_CACHE_MAX_BYTES: '1000' };
  globalThis.caches.default = fakeCache();
  const B = 5000;
  const bigProbe = await run(`/probe?src=${ID}&t=tok`, fakeDrive({ declared: B, served: B }), ENV_SMALL);
  ok((await bigProbe.json()).size === B, 'probe still reports the big file');
  const warmed = [...globalThis.caches.default.store.values()][0];
  ok(!!warmed && warmed.body.length === B, 'and warmed the cache with the complete body');
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
