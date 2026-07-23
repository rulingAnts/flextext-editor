import { handleV1 } from './v1.js';

/* flextext-r2-worker — a free-egress relay for the Flextext Editor.
 *
 * Replaces the Google Apps Script relay's DOWNLOAD role (the piece capped at
 * ~150 MB/day) and adds R2 uploads, with NONE of the cost exposure:
 *   - Cloudflare Worker egress is FREE and uncapped → no daily download limit.
 *   - Binds to the DEPLOYER'S OWN R2 bucket by name (no S3 keys here). Nobody can
 *     reach the bucket without this deployment's RELAY_SECRET token.
 *   - Workers FREE plan is a hard 100k-req/day cap that THROTTLES (never bills),
 *     so other people's traffic can't run up your card.
 *   - R2 storage is the only chargeable thing: every upload checks the bucket
 *     total and refuses BEFORE the free 10 GB is gone; /stats reports usage.
 *
 * R2 DOWNLOADS don't need this Worker — serve them directly from your public R2
 * custom domain (cdn.flextext-editor.timfayu.org/<key>). The Worker handles the
 * two things that DO need server help: Drive proxying, and R2 uploads (writes).
 *
 * Endpoints (all require ?t=<RELAY_SECRET>):
 *   GET /drive?src=<driveId|driveLink>  → proxy+cache a public Drive file
 *   GET /probe?src=<driveId|driveLink>  → {name,size,mime,tooLarge} (+warms cache)
 *   GET /r2/<key>                       → serve an R2 object (CORS + Range)
 *   PUT /r2/<key>                       → upload to R2 (size + storage capped)
 *   GET /stats                          → {bytesUsed, limit, pct, files}
 */

const DRIVE_ID_RE = /^[\w-]{10,}$/;

function driveId(src) {
  const s = String(src || '').trim();
  let m = s.match(/drive\.google\.com\/file\/d\/([\w-]{10,})/);
  if (m) return m[1];
  m = s.match(/[?&]id=([\w-]{10,})/);
  if (m) return m[1];
  if (DRIVE_ID_RE.test(s)) return s;
  return null;
}

function allowedOrigin(origin, env) {
  const list = (env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
  if (!origin) return list[0] || '*';
  if (list.includes('*') || list.includes(origin)) return origin;
  return null;
}

function corsHeaders(origin, env) {
  const allow = allowedOrigin(origin, env);
  const h = {
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type, ETag, Accept-Ranges',
    'Access-Control-Max-Age': '3600',
  };
  if (allow) h['Access-Control-Allow-Origin'] = allow;
  return h;
}

function json(obj, status, origin, env) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', ...corsHeaders(origin, env) },
  });
}

function constEq(a, b) {
  if (!b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
// Read access: Drive proxy + R2 read. The token that travels in coworker links.
function authed(url, env) {
  return constEq(url.searchParams.get('t') || '', env.RELAY_SECRET || '');
}
// WRITE access (R2 uploads): a SEPARATE, owner-only token (?w=). It is never put
// in coworker links, so nobody but the deployer can upload to this bucket. If
// RELAY_WRITE_SECRET is unset, uploads are DISABLED entirely (403).
function authedWrite(url, env) {
  return constEq(url.searchParams.get('w') || '', env.RELAY_WRITE_SECRET || '');
}

async function fetchDrive(id) {
  const base = `https://drive.usercontent.google.com/download?id=${id}&export=download`;
  let r = await fetch(base + '&confirm=t');
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) {
    const html = await r.text();
    const m = html.match(/name="uuid"\s+value="([^"]+)"/) || html.match(/confirm=([\w-]+)/);
    if (!m) { const e = new Error('drive interstitial'); e.code = 'drive_unavailable'; throw e; }
    r = await fetch(base + '&confirm=t&uuid=' + encodeURIComponent(m[1]));
  }
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.code = r.status === 404 ? 'not_found' : 'drive_unavailable'; throw e; }
  return r;
}

async function bucketBytes(env) {
  let total = 0, files = 0, cursor;
  do {
    const list = await env.BUCKET.list({ cursor, limit: 1000 });
    for (const o of list.objects) { if (!o.key.startsWith('_')) { total += o.size; files++; } }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return { total, files };
}

function withCors(resp, origin, env) {
  const h = new Headers(resp.headers);
  const c = corsHeaders(origin, env);
  for (const k in c) h.set(k, c[k]);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Connectivity sync layer (/v1/*): FULLY ISOLATED — its own per-endpoint auth,
    // its own CORS + OPTIONS handling (handleV1's v1Cors allows the x-fx-* headers
    // that the global /drive CORS does NOT), and its own try/catch, dispatched ABOVE
    // EVERY global gate — including the OPTIONS handler below — so a /v1/ preflight is
    // never answered with the limited /drive headers (which would block the browser
    // client), and a bug here (incl. a missing D1 binding) can never reach the /drive
    // proxy. Backward-compat mandate, plan §B. (Non-/v1/ OPTIONS still falls through.)
    if (path === '/v1' || path.startsWith('/v1/')) {
      try {
        return await handleV1(request, env, ctx, url, path, origin);
      } catch (e) {
        return json({ error: 'v1_error', message: e.message || String(e) }, 500, origin, env);
      }
    }

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin, env) });

    if (!authed(url, env)) return json({ error: 'unauthorized' }, 401, origin, env);
    if (origin && allowedOrigin(origin, env) === null) return json({ error: 'origin_not_allowed' }, 403, origin, env);

    const MAX_FILE = parseInt(env.MAX_FILE_BYTES || '536870912', 10);
    const MAX_TOTAL = parseInt(env.MAX_TOTAL_BYTES || '9500000000', 10);

    try {
      if (path === '/drive' && (request.method === 'GET' || request.method === 'HEAD')) {
        const id = driveId(url.searchParams.get('src'));
        if (!id) return json({ error: 'bad_src' }, 400, origin, env);
        const cacheKey = new Request(`${url.origin}/drive?src=${id}`, { method: 'GET' });
        const range = request.headers.get('Range');
        const hit = await caches.default.match(new Request(cacheKey.url, { headers: range ? { Range: range } : {} }));
        if (hit) return withCors(hit, origin, env);
        const dr = await fetchDrive(id);
        const len = parseInt(dr.headers.get('content-length') || '0', 10);
        if (len && len > MAX_FILE) return json({ error: 'too_large', size: len, limit: MAX_FILE }, 413, origin, env);
        const headers = new Headers(dr.headers);
        headers.set('Cache-Control', 'public, max-age=86400');
        headers.set('Accept-Ranges', 'bytes');
        const resp = new Response(dr.body, { status: 200, headers });
        ctx.waitUntil(caches.default.put(cacheKey, resp.clone()));
        return withCors(resp, origin, env);
      }

      if (path === '/probe' && request.method === 'GET') {
        const id = driveId(url.searchParams.get('src'));
        if (!id) return json({ error: 'bad_src' }, 400, origin, env);
        const dr = await fetchDrive(id);
        const size = parseInt(dr.headers.get('content-length') || '0', 10);
        const mime = dr.headers.get('content-type') || '';
        const name = (dr.headers.get('content-disposition') || '').match(/filename="?([^"]+)"?/)?.[1] || '';
        if (size && size <= MAX_FILE) {
          const cacheKey = new Request(`${url.origin}/drive?src=${id}`, { method: 'GET' });
          ctx.waitUntil(caches.default.put(cacheKey, new Response(dr.body, { status: 200, headers: dr.headers })));
        } else { ctx.waitUntil(dr.body?.cancel?.()); }
        return json({ name, size, mime, tooLarge: !!(size && size > MAX_FILE), limit: MAX_FILE }, 200, origin, env);
      }

      if (path.startsWith('/r2/') && (request.method === 'GET' || request.method === 'HEAD')) {
        const key = decodeURIComponent(path.slice(4));
        if (!key || key.startsWith('_')) return json({ error: 'bad_key' }, 400, origin, env);
        const range = request.headers.get('Range');
        const opts = {};
        if (range) { const m = range.match(/bytes=(\d*)-(\d*)/); if (m) opts.range = { offset: m[1] ? +m[1] : undefined, length: (m[1] && m[2]) ? (+m[2] - +m[1] + 1) : undefined }; }
        const obj = await env.BUCKET.get(key, opts);
        if (!obj) return json({ error: 'not_found' }, 404, origin, env);
        const h = new Headers(corsHeaders(origin, env));
        obj.writeHttpMetadata(h); h.set('etag', obj.httpEtag); h.set('Accept-Ranges', 'bytes');
        if (obj.range) {
          const start = obj.range.offset || 0;
          const end = start + (obj.range.length || (obj.size - start)) - 1;
          h.set('Content-Range', `bytes ${start}-${end}/${obj.size}`);
          return new Response(obj.body, { status: 206, headers: h });
        }
        return new Response(obj.body, { status: 200, headers: h });
      }

      if (path.startsWith('/r2/') && request.method === 'PUT') {
        // Owner-only: requires the separate write token. Coworker links don't
        // carry it, so nobody else can upload to this bucket.
        if (!authedWrite(url, env)) return json({ error: 'upload_forbidden' }, 403, origin, env);
        const key = decodeURIComponent(path.slice(4));
        if (!key || key.startsWith('_')) return json({ error: 'bad_key' }, 400, origin, env);
        const len = parseInt(request.headers.get('content-length') || '0', 10);
        if (len && len > MAX_FILE) return json({ error: 'too_large', size: len, limit: MAX_FILE }, 413, origin, env);
        const { total } = await bucketBytes(env);
        if (len && total + len > MAX_TOTAL) return json({ error: 'storage_full', used: total, limit: MAX_TOTAL }, 507, origin, env);
        const obj = await env.BUCKET.put(key, request.body, { httpMetadata: { contentType: request.headers.get('content-type') || 'application/octet-stream' } });
        return json({ ok: true, key, size: obj.size, etag: obj.httpEtag }, 200, origin, env);
      }

      if (path === '/stats' && request.method === 'GET') {
        // Owner-only: bucket usage is private metadata. Requires the write token,
        // not the public read token that ships in the app.
        if (!authedWrite(url, env)) return json({ error: 'stats_forbidden' }, 403, origin, env);
        const { total, files } = await bucketBytes(env);
        return json({ bytesUsed: total, files, limit: MAX_TOTAL, pct: Math.round((total / MAX_TOTAL) * 100) }, 200, origin, env);
      }

      return json({ error: 'not_found', path }, 404, origin, env);
    } catch (e) {
      const status = e.code === 'not_found' ? 404 : e.code === 'too_large' ? 413 : 502;
      return json({ error: e.code || 'relay_error', message: e.message || String(e) }, status, origin, env);
    }
  },
};
