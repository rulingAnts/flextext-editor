/* Assignment delivery: TTL clamp + the begin→start→chunk→finish→textfile flow (assign-by-upload).
 *
 * WHY THIS IS WORTH A TEST: the assignment endpoints are the only path by which field devices
 * receive their working files, and the TTL clamp is the only thing standing between a hand-edited
 * localStorage value and a decade-long access token. The flow half runs handleV1 against a FAKE
 * Drive (fetch shim) + FAKE D1 (drive-cache-integrity / worker-seclog technique) — no cloud
 * resources, no Google credentials — and pins the wire contract the panel and device rely on:
 * folder ensure order, the researcher-bound (`rr`) session token that can never cross onto the
 * device chunk route, 308-resume relay semantics, minted-token expiry honouring the clamp, and
 * Range → 206 streaming on the resulting /v1/textfile URL.
 *
 * Run: node test/assignment-ttl.test.mjs
 */
import { handleV1, clampTtlDays } from '../worker/src/v1.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

console.log('\nclampTtlDays: absent -> 90, clamp [7, 400], garbage -> 90');
ok(clampTtlDays(undefined) === 90, 'absent -> 90');
ok(clampTtlDays(null) === 90, 'null -> 90');
ok(clampTtlDays('') === 90, 'empty string -> 90');
ok(clampTtlDays('banana') === 90, 'garbage -> 90');
ok(clampTtlDays(NaN) === 90, 'NaN -> 90');
ok(clampTtlDays(90) === 90, '90 -> 90');
ok(clampTtlDays('365') === 365, 'numeric string passes through');
ok(clampTtlDays(1) === 7, 'floor: 1 -> 7');
ok(clampTtlDays(0) === 7, 'floor: 0 -> 7');
ok(clampTtlDays(-5) === 7, 'floor: negative -> 7');
ok(clampTtlDays(401) === 400, 'ceiling: 401 -> 400');
ok(clampTtlDays(99999) === 400, 'ceiling: huge -> 400');

/* ---------------- module harness: fake D1 + fake Drive ---------------- */

const HMAC = 'test-hmac-key';
// Replicate the worker's at-rest crypto (AES-GCM under sha256(SERVER_HMAC_KEY)) so the test can
// fabricate the stored refresh-token ciphertext and read minted tokens back.
const b64u = (buf) => { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (s) => { const t = String(s).replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(t + '==='.slice((t.length + 3) % 4)); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); };
async function aesKey() {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(HMAC));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function encAtRest(plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(), new TextEncoder().encode(plain));
  return b64u(iv) + '.' + b64u(ct);
}
async function decAtRest(token) {
  const [iv, ct] = String(token).split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, await aesKey(), unb64u(ct));
  return new TextDecoder().decode(pt);
}
const sha256hex = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

const researcherRow = {
  researcher_id: 'r1', secret_hash: await sha256hex('sec'), approved: 1,
  drive_email: 'res@example.org', drive_refresh_enc: await encAtRest('refresh-token'),
};
const instanceRow = { instance_id: 'i1', nickname: 'Tablet A', oauth_folder_id: 'dev-folder', revoked: 0 };

const db = {
  prepare(sql) {
    return { bind() {
      return {
        async first() {
          if (/FROM researcher/.test(sql)) return researcherRow;
          if (/FROM instance/.test(sql)) return instanceRow;
          return null;
        },
        async run() { return { meta: { changes: 1 } }; },
        async all() { return { results: [] }; },
      };
    } };
  },
  async batch() { return []; },
};

const ENV = { DB: db, SERVER_HMAC_KEY: HMAC, GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 'cs' };

/* The fake Drive: token mint, folder search (always a miss -> create), folder create (id derived
 * from the name), files.get verify, resumable session init, session PUTs (308 until the final
 * slice), and alt=media streaming with Range -> 206. `log` records what the worker asked for. */
const log = { created: [], sessions: [] };
const jr = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
globalThis.fetch = async (input, init = {}) => {
  const u = typeof input === 'string' ? input : input.url;
  const method = (init.method || 'GET').toUpperCase();
  const h = init.headers || {};
  if (u.startsWith('https://oauth2.googleapis.com/token')) return jr({ access_token: 'AT' });
  if (u.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable')) {
    const meta = JSON.parse(init.body);
    log.created.push(meta);
    log.sessions.push({ meta, received: 0 });
    return new Response(null, { status: 200, headers: { Location: 'https://session.test/' + log.sessions.length } });
  }
  if (u.startsWith('https://session.test/')) {
    const sess = log.sessions[parseInt(u.split('/').pop(), 10) - 1];
    const range = h['Content-Range'] || '';
    const m = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (m && parseInt(m[2], 10) + 1 < parseInt(m[3], 10)) {
      sess.received = parseInt(m[2], 10) + 1;
      return new Response(null, { status: 308, headers: { Range: 'bytes=0-' + m[2] } });
    }
    return jr({ id: 'file-' + log.sessions.indexOf(sess) });
  }
  if (/\/drive\/v3\/files\/[^/?]+\?alt=media/.test(u)) {
    const body = new Uint8Array(100).map((_, i) => i);
    const range = h.Range || h.range || '';
    const rm = /bytes=(\d+)-(\d+)/.exec(range);
    if (rm) {
      const s = +rm[1], e = +rm[2];
      return new Response(body.slice(s, e + 1), { status: 206, headers: {
        'content-type': 'audio/mpeg', 'content-length': String(e - s + 1),
        'content-range': `bytes ${s}-${e}/100`, 'accept-ranges': 'bytes' } });
    }
    return new Response(body, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': '100' } });
  }
  if (/\/drive\/v3\/files\/[^/?]+\?fields=id,trashed/.test(u)) {
    return jr({ id: decodeURIComponent(u.split('/drive/v3/files/')[1].split('?')[0]), trashed: false });
  }
  if (method === 'POST' && u.includes('/drive/v3/files?fields=id')) {
    const meta = JSON.parse(init.body);
    log.created.push(meta);
    return jr({ id: 'folder-' + meta.name });
  }
  if (method === 'GET' && u.includes('/drive/v3/files?')) {
    // The listing fixture: docId 'doc-list' owns a text folder holding an originals/ child, a
    // bundle and a bare flextext; the child holds the delivered audio + flextext. Every other
    // search misses (the begin/start flows above create fresh folders).
    const q = decodeURIComponent(u.split('q=')[1] || '');
    if (q.includes("value='doc-list'")) return jr({ files: [{ id: 'tf-list' }] });
    if (q.includes("'tf-list' in parents")) return jr({ files: [
      { id: 'sub1', name: 'originals', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-08-01T00:00:00Z', appProperties: { flextextRole: 'originals' } },
      { id: 'f1', name: 'kisah 2026-08-10.zip', mimeType: 'application/zip', size: '10', modifiedTime: '2026-08-10T00:00:00Z' },
      { id: 'f2', name: 'kisah.flextext', mimeType: 'application/xml', size: '5', modifiedTime: '2026-08-08T00:00:00Z' },
    ] });
    if (q.includes("'sub1' in parents")) return jr({ files: [
      { id: 'a1', name: 'story.mp3', mimeType: 'audio/mpeg', size: '99', modifiedTime: '2026-08-09T00:00:00Z', appProperties: { flextextRole: 'source-audio' } },
      { id: 'x1', name: 'kisah.flextext', mimeType: 'application/xml', size: '7', modifiedTime: '2026-08-11T00:00:00Z', appProperties: { flextextRole: 'assigned-flextext' } },
    ] });
    return jr({ files: [] });
  }
  throw new Error('unexpected fetch: ' + method + ' ' + u);
};

const AUTH = { 'x-fx-researcher': 'r1', 'x-fx-secret': 'sec' };
async function call(path, { method = 'GET', headers = {}, body = null } = {}) {
  const req = new Request('https://w.test' + path, {
    method, headers, body: body && typeof body === 'object' && !(body instanceof Uint8Array) ? JSON.stringify(body) : body,
  });
  const url = new URL(req.url);
  return handleV1(req, ENV, { waitUntil() {} }, url, url.pathname, '');
}

console.log('\nbegin: device folder verified, text folder + originals/ child ensured');
{
  const r = await call('/v1/instances/i1/texts/doc-42/assignment/begin', { method: 'POST', headers: AUTH, body: { title: 'Kisah' } });
  const b = await r.json();
  ok(r.status === 200 && b.ok, 'begin succeeds');
  ok(b.folderId === 'folder-Kisah', 'text folder created under the device folder, named by title');
  ok(b.originalsFolderId === 'folder-originals', 'originals/ child created');
  const tf = log.created.find((c) => c.name === 'Kisah');
  ok(tf && tf.parents[0] === 'dev-folder' && tf.appProperties.flextextDoc === 'doc-42', 'text folder is docId-tagged, parented in the device folder');
  const af = log.created.find((c) => c.name === 'originals');
  ok(af && af.parents[0] === 'folder-Kisah' && af.appProperties.flextextRole === 'originals', 'originals/ is role-tagged, parented in the TEXT folder');
  const unauth = await call('/v1/instances/i1/texts/doc-42/assignment/begin', { method: 'POST', body: { title: 'x' } });
  ok(unauth.status === 401, 'no researcher auth -> 401');
}

console.log('\nupload start/chunk: researcher-bound session, device wire contract');
let uploadId = null, audioFileId = null;
{
  const r = await call('/v1/instances/i1/texts/doc-42/assignment/upload/start', { method: 'POST', headers: AUTH,
    body: { name: 'story.mp3', mime: 'audio/mpeg', size: 10, originalsFolderId: 'folder-originals', kind: 'audio' } });
  const b = await r.json();
  ok(r.status === 200 && b.uploadId, 'start returns an opaque uploadId');
  uploadId = b.uploadId;
  const sess = JSON.parse(await decAtRest(uploadId));
  ok(sess.rr === 'r1' && !sess.i, "session token is bound via 'rr' (researcher), NOT the device 'i' key");
  const meta = log.created.find((c) => c.name === 'story.mp3');
  ok(meta && meta.parents[0] === 'folder-originals' && meta.appProperties.flextextRole === 'source-audio',
     "audio lands in originals/ with assign-copy's exact 'source-audio' tag");

  const bad = await call('/v1/instances/i1/texts/doc-42/assignment/upload/start', { method: 'POST', headers: AUTH,
    body: { name: 'x', mime: 'audio/mpeg', size: 10, originalsFolderId: 'folder-originals', kind: 'evil' } });
  ok(bad.status === 400 && (await bad.json()).error === 'bad_kind', 'unknown kind is refused');

  const c1 = await call('/v1/instances/i1/texts/doc-42/assignment/upload/chunk', { method: 'PUT',
    headers: { ...AUTH, 'x-fx-upload': uploadId, 'x-fx-range': 'bytes 0-4/10' }, body: new Uint8Array(5) });
  const b1 = await c1.json();
  ok(c1.status === 200 && b1.done === false && b1.received === 5, 'mid chunk -> {done:false, received} from the 308 Range');
  const c2 = await call('/v1/instances/i1/texts/doc-42/assignment/upload/chunk', { method: 'PUT',
    headers: { ...AUTH, 'x-fx-upload': uploadId, 'x-fx-range': 'bytes 5-9/10' }, body: new Uint8Array(5) });
  const b2 = await c2.json();
  ok(c2.status === 200 && b2.done === true && !!b2.fileId, 'final chunk -> {done:true, fileId}');
  audioFileId = b2.fileId;

  // A DEVICE-shaped token (key 'i') must never drive the researcher route.
  const deviceTok = await encAtRest(JSON.stringify({ u: 'https://session.test/1', i: 'install-9', s: 10 }));
  const cross = await call('/v1/instances/i1/texts/doc-42/assignment/upload/chunk', { method: 'PUT',
    headers: { ...AUTH, 'x-fx-upload': deviceTok, 'x-fx-range': 'bytes */10' } });
  ok(cross.status === 403, "a device-route session token is refused on the researcher route (403)");
  const badRange = await call('/v1/instances/i1/texts/doc-42/assignment/upload/chunk', { method: 'PUT',
    headers: { ...AUTH, 'x-fx-upload': uploadId, 'x-fx-range': 'bytes whatever' } });
  ok(badRange.status === 400, 'malformed range is refused before touching Drive');
}

console.log('\nconsent-prompt start targets the DEVICE folder');
{
  const r = await call('/v1/instances/i1/texts/consent/assignment/upload/start', { method: 'POST', headers: AUTH,
    body: { name: 'prompt.mp3', mime: 'audio/mpeg', size: 10, kind: 'consent-prompt' } });
  ok(r.status === 200, 'start succeeds with no originalsFolderId');
  const meta = log.created.find((c) => c.name === 'prompt.mp3');
  ok(meta && meta.parents[0] === 'dev-folder' && meta.appProperties.flextextRole === 'consent-prompt',
     'prompt lands in the device folder with the consent-prompt role');
}

console.log('\nfinish: clamped TTL is IN the minted token; textfile streams it back with Range -> 206');
{
  const before = Date.now();
  const r = await call('/v1/instances/i1/texts/doc-42/assignment/finish', { method: 'POST', headers: AUTH,
    body: { audioFileId, ttlDays: 1 } });   // 1 clamps to the 7-day floor
  const b = await r.json();
  ok(r.status === 200 && b.ok, 'finish succeeds');
  ok(b.ttlDays === 7, 'response reports the CLAMPED ttl (1 -> 7)');
  ok(!b.flextextUrl && !b.promptUrl, 'only the requested URL is minted');
  ok(String(b.audioUrl).includes('/v1/textfile/'), 'audio URL is a private /v1/textfile token URL');
  const tok = JSON.parse(await decAtRest(decodeURIComponent(b.audioUrl.split('/v1/textfile/')[1])));
  ok(tok.r === 'r1' && tok.f === audioFileId, 'token binds researcher + file id');
  const days = (tok.e - before) / 86400000;
  ok(days > 6.9 && days < 7.1, `token expiry honours the clamp (~7 days, got ${days.toFixed(2)})`);

  const empty = await call('/v1/instances/i1/texts/doc-42/assignment/finish', { method: 'POST', headers: AUTH, body: {} });
  ok(empty.status === 400, 'finish with nothing to mint is refused');

  const path = new URL(b.audioUrl).pathname;
  const got = await call(path, { headers: { Range: 'bytes=0-9' } });
  ok(got.status === 206, 'device-style plain fetch with Range gets 206');
  ok(got.headers.get('content-range') === 'bytes 0-9/100', 'Content-Range forwarded');
  ok((await got.arrayBuffer()).byteLength === 10, 'partial body length matches');
  ok(got.headers.get('cache-control') === 'no-store', 'private delivery is never cached');

  // An EXPIRED token must be a clean 401 — the device classifies it permanent, remedy is re-assign.
  const stale = await encAtRest(JSON.stringify({ r: 'r1', f: audioFileId, x: '', e: Date.now() - 1000 }));
  const dead = await call('/v1/textfile/' + encodeURIComponent(stale));
  ok(dead.status === 401 && (await dead.json()).error === 'bad_token', 'expired token -> 401 bad_token');
}

console.log('\nfiles listing (STAGING-FIRST change): folders filtered, assignment/ merged, newest-first');
{
  const r = await call('/v1/instances/i1/texts/doc-list/files', { headers: AUTH });
  const b = await r.json();
  ok(r.status === 200, 'listing succeeds');
  ok(b.folderId === 'tf-list' && b.originalsFolderId === 'sub1', 'text folder + assignment child both reported');
  ok(!b.files.some((f) => (f.mime || '').includes('folder')), 'folder rows are NEVER listed as files');
  ok(b.files.map((f) => f.id).join() === 'x1,f1,a1,f2', `newest-first ACROSS the merge (got ${b.files.map((f) => f.id).join()})`);
  ok(b.files.find((f) => f.id === 'x1').role === 'assigned-flextext'
     && b.files.find((f) => f.id === 'a1').role === 'source-audio', 'each merged file keeps its role tag');
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
