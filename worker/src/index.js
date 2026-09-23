import { handleV1, originAllows } from './v1.js';
import { logAuthFailures, secLog } from './seclog.js';

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

/* THE DRIVE CACHE, and what 2026-08-11 actually established.
 *
 * This block was first written on the theory that an aborted panel probe (probeAudioUrl reads the
 * first chunk, then aborts) cut a tee'd stream and left a TRUNCATED body in `caches.default` —
 * poisoning the file's next use for 24 h. A live A/B on the staging worker REFUTED that theory:
 * three abort profiles against the pre-fix code each left either a COMPLETE entry (the cache
 * branch of a tee keeps pulling from Drive after the client bails) or NOTHING. Cloudflare's cache
 * discards a stored body shorter than its Content-Length; poisoning was never possible. Seth's
 * field failures had other causes (see memory `drive-second-use-bug-status`).
 *
 * What WAS really broken in the old code, and stays fixed here:
 *   - Drive's set-cookie header made every cache.put REJECT silently, leaving the cache
 *     permanently cold for those files (cacheHeaders strips it now).
 *   - A stored CORS header would replay one app's origin to another (stripped too).
 *
 * THE RULES, as amended by that evidence:
 *   1. Small files (≤ the buffer ceiling) are buffered whole, length-verified, then stored and
 *      served as two independent copies — atomic by construction, and the client is served from
 *      RAM even if Drive dawdles.
 *   2. Bigger files with a KNOWN length are tee'd: the client reads one branch, the cache is fed
 *      its OWN branch. A client abort cannot cut the cache branch (verified live, 2026-08-11), and
 *      a short delivery is discarded by the cache's own Content-Length check — complete or
 *      nothing, without holding the body in a 128 MB isolate. (v333 shipped briefly with these
 *      files not cached at all; that made every big-file fetch a fresh Drive download per device —
 *      the repeated-download pattern Drive throttles — and was reverted the same day.)
 *   3. Only a body with NO declared length streams through uncached: without Content-Length the
 *      cache cannot verify completeness, so a truncated store would be undetectable.
 *
 * CACHE_GEN is in the cache key, so bumping it ABANDONS every entry stored under the old scheme.
 * Bump it whenever the stored shape changes or entries must be dropped. */
const CACHE_GEN = 2;
/* Buffer ceiling for rule 1 (rule 2 covers everything above it, so this is a memory knob, not a
 * caching cutoff). Two copies of the body can exist transiently against a 128 MB isolate — keep
 * this well under a third of that. Override via DRIVE_CACHE_MAX_BYTES with that arithmetic in
 * mind: an OOM here is a hard failure for the device. */
const CACHE_MAX_DEFAULT = 25165824;   // 24 MB
const driveCacheKey = (originUrl, id) =>
  new Request(`${originUrl}/drive?src=${id}&cv=${CACHE_GEN}`, { method: 'GET' });

/* Headers for the STORED copy.
 * - set-cookie makes cache.put REJECT outright (Drive sets one on the download host), which silently
 *   left the cache permanently cold for those files.
 * - No CORS header is stored: withCors stamps the CURRENT origin's on the way out, and a stored one
 *   would be a stale answer waiting to be served to a different app. */
function cacheHeaders(src, len) {
  const h = new Headers(src);
  h.delete('set-cookie');
  h.delete('access-control-allow-origin');
  h.set('Cache-Control', 'public, max-age=86400');
  h.set('Accept-Ranges', 'bytes');
  if (len != null) h.set('content-length', String(len));
  return h;
}

/* Store a COMPLETE body under `key`, or store nothing. Returns the buffer so the caller can serve
 * its own copy. The length check is the belt to the buffering's braces: if Drive's Content-Length
 * and the bytes we actually received disagree, the truncation happened upstream and caching it
 * would make one bad download permanent. */
async function cachePut(ctx, key, buf, headers, expected) {
  if (expected != null && buf.byteLength !== expected) return false;
  const stored = new Response(buf, { status: 200, headers: cacheHeaders(headers, buf.byteLength) });
  ctx.waitUntil(caches.default.put(key, stored).catch(() => { /* caching is an optimisation */ }));
  return true;
}

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
  // originAllows (v1.js) also understands the `*-<worker>.workers.dev` preview-alias patterns that
  // [env.staging] carries; production's list is exact origins, so nothing changes there.
  return originAllows(list, origin) ? origin : null;
}

function corsHeaders(origin, env) {
  const allow = allowedOrigin(origin, env);
  const h = {
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type, ETag, Accept-Ranges',
    'Access-Control-Max-Age': '3600',
    // The header can only ever name ONE origin (or `*`), so the allow-list is matched server-side
    // and the caller's own origin is reflected — which makes this response origin-dependent, and
    // any shared cache must be told so. /drive is `max-age=86400`, so without this a cache could
    // hand one app's ACAO to another app.
    Vary: 'Origin',
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

/* ---------------- the page a person sees when something breaks ----------------
   Until 2026-09-23 every failure in /v1/ answered with raw JSON on a blank white page — which is what a
   researcher actually saw the day D1's account-wide free quota ran out mid-session: `{"error":"v1_error",
   "message":"D1_ERROR: Your account has exceeded..."}`. Alarming, unexplained, and with nothing to do about it.

   An API client still gets JSON; nothing about the apps' own error handling changes. What changes is the case
   where the thing on the other end is a PERSON with a browser — a top-level navigation such as the OAuth
   callback — and those now get a branded page that says what happened in a sentence, shows the reference and
   the time so support has something to work with, and offers a Report button that opens a pre-filled GitHub
   issue. The repository is public, so that link works for any user with a GitHub account.

   Deliberately self-contained: no stylesheet, no image, no script, no font. It has to render when the rest of
   the estate is broken, and this Worker's host serves no assets of its own. (Seth, 2026-09-23.) */
const REPO = 'rulingAnts/flextext-editor';
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A browser asking for a page, rather than the apps' own fetch() asking for data. */
function wantsHtml(request) {
  const a = (request.headers.get('accept') || '').toLowerCase();
  if (!a.includes('text/html')) return false;
  // a same-origin fetch() sends Sec-Fetch-Mode: cors; a real navigation sends 'navigate'
  const mode = (request.headers.get('sec-fetch-mode') || '').toLowerCase();
  return mode ? mode === 'navigate' : true;
}

function errorPage({ message, path, when, status = 500 }) {
  const title = 'Flextext — something went wrong';
  const issue = `https://github.com/${REPO}/issues/new?labels=bug&title=` +
    encodeURIComponent(`App error: ${String(message || 'unknown').slice(0, 80)}`) +
    '&body=' + encodeURIComponent(
      `**What I was doing:**\n(please describe, if you can)\n\n` +
      `**Where:** \`${path || ''}\`\n` +
      `**When:** ${when}\n` +
      `**Error:** \`${String(message || '').slice(0, 500)}\`\n`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title>
<style>
 :root{--ink:#1c1917;--muted:#57534e;--brand:#b45309;--brand-2:#92400e;--paper:#fffbf5;--line:#e7e0d5}
 *{box-sizing:border-box} html,body{height:100%}
 body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;
   display:flex;align-items:center;justify-content:center;padding:24px}
 .card{max-width:34rem;width:100%;background:#fff;border:1px solid var(--line);border-radius:12px;
   box-shadow:0 10px 30px rgba(60,40,10,.08);overflow:hidden}
 .bar{height:6px;background:repeating-linear-gradient(45deg,var(--brand),var(--brand) 12px,var(--brand-2) 12px,var(--brand-2) 24px)}
 .in{padding:1.6rem 1.7rem 1.5rem}
 .word{font-weight:800;letter-spacing:.02em;color:var(--brand-2);font-size:1.05rem;margin:0 0 1rem}
 .word span{color:var(--ink)}
 h1{font-size:1.25rem;margin:0 0 .6rem;line-height:1.3}
 p{margin:0 0 .9rem;color:var(--muted)}
 .meta{background:#faf7f2;border:1px solid var(--line);border-radius:8px;padding:.7rem .8rem;margin:1rem 0;
   font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#44403c;word-break:break-word}
 .meta b{color:var(--ink);font-weight:600}
 .row{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1.2rem}
 .btn{display:inline-block;padding:.6rem 1.15rem;border-radius:8px;text-decoration:none;font-weight:600;font-size:.94rem}
 .go{background:var(--brand);color:#fff} .go:hover{background:var(--brand-2)}
 .ghost{border:1px solid var(--line);color:var(--ink)} .ghost:hover{border-color:var(--brand)}
 @media (prefers-color-scheme:dark){
  :root{--ink:#f5f1ea;--muted:#c3bcb1;--paper:#1a1713;--line:#3a332a}
  body{background:var(--paper)} .card{background:#221e19} .meta{background:#1c1915}
  .word span{color:var(--ink)} .ghost{color:var(--ink)} }
</style></head><body>
<div class="card"><div class="bar"></div><div class="in">
  <p class="word">FLEx<span>Text</span></p>
  <h1>The app ran into a problem.</h1>
  <p>Please try again in a little while. Nothing you had saved has been lost — this happened on our side, not yours.</p>
  <div class="meta"><b>When:</b> ${escHtml(when)}<br><b>Where:</b> ${escHtml(path || '/')}<br><b>Details:</b> ${escHtml(String(message || '').slice(0, 300))}</div>
  <div class="row">
    <a class="btn go" href="/">Try again</a>
    <a class="btn ghost" href="${escHtml(issue)}" target="_blank" rel="noopener">Report this</a>
  </div>
</div></div></body></html>`;
}

/** JSON for the apps, a page for a person. Same status either way. */
function failure(request, url, message, status, origin, env) {
  const when = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  if (!wantsHtml(request)) return json({ error: 'v1_error', message }, status, origin, env);
  return new Response(errorPage({ message, path: url?.pathname, when, status }), {
    status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders(origin, env) },
  });
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
        // logAuthFailures is the ONE chokepoint for every 401/403/429 in v1.js's ~40 refusal
        // points — same containment reasoning as native-audio.js: instrumentation scattered
        // beside every `return j(...)` is instrumentation that rots. It swallows its own errors
        // and returns the response untouched, so it cannot change what the client receives.
        return await logAuthFailures(env, request, await handleV1(request, env, ctx, url, path, origin));
      } catch (e) {
        // A thrown /v1/ error is itself worth seeing — it is the shape a probe for an unhandled
        // input takes. Logged, then handled exactly as before.
        await secLog(env, request, 'v1_threw', { message: String(e && e.message || e).slice(0, 200) });
        // a person in a browser gets a branded page; the apps' own fetch() still gets the same JSON
        return failure(request, url, e.message || String(e), 500, origin, env);
      }
    }

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin, env) });

    // The relay-token + origin gates. Failures here are the signal for someone guessing the
    // ?t= token or calling the relay from an origin that is not ours — logged, never alerted
    // (scanners trip these constantly; an alarm that cries wolf gets ignored).
    if (!authed(url, env)) {
      return await logAuthFailures(env, request, json({ error: 'unauthorized' }, 401, origin, env));
    }
    if (origin && allowedOrigin(origin, env) === null) {
      return await logAuthFailures(env, request, json({ error: 'origin_not_allowed' }, 403, origin, env));
    }

    const MAX_FILE = parseInt(env.MAX_FILE_BYTES || '536870912', 10);
    const MAX_TOTAL = parseInt(env.MAX_TOTAL_BYTES || '9500000000', 10);

    try {
      if (path === '/drive' && (request.method === 'GET' || request.method === 'HEAD')) {
        const id = driveId(url.searchParams.get('src'));
        if (!id) return json({ error: 'bad_src' }, 400, origin, env);
        const cacheKey = driveCacheKey(url.origin, id);
        const range = request.headers.get('Range');
        const hit = await caches.default.match(new Request(cacheKey.url, { headers: range ? { Range: range } : {} }));
        if (hit) return withCors(hit, origin, env);
        const dr = await fetchDrive(id);
        const len = parseInt(dr.headers.get('content-length') || '0', 10);
        if (len && len > MAX_FILE) return json({ error: 'too_large', size: len, limit: MAX_FILE }, 413, origin, env);
        const cacheMax = parseInt(env.DRIVE_CACHE_MAX_BYTES || String(CACHE_MAX_DEFAULT), 10);
        // Rule 1 (see CACHE_GEN above): small enough to hold — buffer once, length-verify, store
        // one copy, serve another. HEAD never buffers — there is no body to serve, so downloading
        // the file to answer it would be pure waste.
        if (request.method === 'GET' && len && len <= cacheMax) {
          const buf = await dr.arrayBuffer();
          await cachePut(ctx, cacheKey, buf, dr.headers, len);
          return withCors(new Response(buf, { status: 200, headers: cacheHeaders(dr.headers, buf.byteLength) }), origin, env);
        }
        // Rule 2: bigger, but the length is KNOWN (and ≤ MAX_FILE — the 413 above) — tee. The
        // cache gets its OWN branch, which a client abort cannot cut (verified live 2026-08-11),
        // and the cache's Content-Length check discards any short delivery. Without this branch,
        // every device download of a big file was a fresh Drive fetch — the repeated-download
        // pattern Drive throttles.
        if (request.method === 'GET' && len && dr.body) {
          const [toClient, toCache] = dr.body.tee();
          ctx.waitUntil(caches.default
            .put(cacheKey, new Response(toCache, { status: 200, headers: cacheHeaders(dr.headers, len) }))
            .catch(() => { /* caching is an optimisation */ }));
          return withCors(new Response(toClient, { status: 200, headers: cacheHeaders(dr.headers, len) }), origin, env);
        }
        // Rule 3: no declared length (or a HEAD) — stream through UNCACHED. Without Content-Length
        // the cache cannot verify completeness, so a truncated store would be undetectable.
        return withCors(new Response(dr.body, { status: 200, headers: cacheHeaders(dr.headers, len || null) }), origin, env);
      }

      if (path === '/probe' && request.method === 'GET') {
        const id = driveId(url.searchParams.get('src'));
        if (!id) return json({ error: 'bad_src' }, 400, origin, env);
        const dr = await fetchDrive(id);
        const size = parseInt(dr.headers.get('content-length') || '0', 10);
        const mime = dr.headers.get('content-type') || '';
        const name = (dr.headers.get('content-disposition') || '').match(/filename="?([^"]+)"?/)?.[1] || '';
        // Warm the cache with the same rules as /drive. Small: buffer + length-verify (rule 1).
        // Big with a known size: hand the stream straight to cache.put — the probe's JSON reply
        // comes from headers, so the body has NO other consumer and the cache's Content-Length
        // check still guarantees complete-or-nothing (rule 2). This is what makes the researcher's
        // pre-send check WARM the cache the device then downloads from. Unknown size: drop it.
        const probeMax = Math.min(MAX_FILE, parseInt(env.DRIVE_CACHE_MAX_BYTES || String(CACHE_MAX_DEFAULT), 10));
        if (size && size <= probeMax) {
          const key = driveCacheKey(url.origin, id);
          ctx.waitUntil(dr.arrayBuffer()
            .then((buf) => cachePut(ctx, key, buf, dr.headers, size))
            .catch(() => { /* the cache stays cold; the next /drive refetches */ }));
        } else if (size && size <= MAX_FILE && dr.body) {
          const key = driveCacheKey(url.origin, id);
          ctx.waitUntil(caches.default
            .put(key, new Response(dr.body, { status: 200, headers: cacheHeaders(dr.headers, size) }))
            .catch(() => { /* the cache stays cold; the next /drive refetches */ }));
        } else { ctx.waitUntil(Promise.resolve(dr.body?.cancel?.()).catch(() => {})); }
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
        // Owner-only write token. Failing this while HOLDING a valid read token is a notable
        // event — it means someone with a coworker link is probing for upload access.
        if (!authedWrite(url, env)) {
          return await logAuthFailures(env, request, json({ error: 'upload_forbidden' }, 403, origin, env));
        }
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
        if (!authedWrite(url, env)) {
          return await logAuthFailures(env, request, json({ error: 'stats_forbidden' }, 403, origin, env));
        }
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
