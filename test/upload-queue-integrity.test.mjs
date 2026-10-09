/* A QUEUED COPY IS CHECKED BEFORE IT LEAVES (plans/move-upload-guards.md G5).
 *
 * WHY THIS TEST EXISTS: Lane B keeps the built .flextext in IndexedDB until it can be sent, and sent
 * it without looking. One sat six days in the queue and reached Drive as 489 bytes of NUL — and,
 * being the newest file, became the copy a move or a cleanup would pick.
 *
 * What is pinned:
 *   - the check is STRUCTURAL (a device never refuses its only backup over a pasted control
 *     character) plus the SHA-256 taken when the copy was queued;
 *   - the bytes that pass are the bytes SENT (an in-memory copy of the checked buffer), so a second
 *     read of the stored blob cannot put different bytes on the wire;
 *   - a failed copy is REBUILT from the text when the text exists, at most twice, and otherwise HELD
 *     — never deleted;
 *   - the hash of what was sent is reported, so the panel can compare it with Drive's own.
 *
 * The real functions are LIFTED out of app.js (which cannot be imported under node) and run with the
 * real checkFlextextBytes, node's Blob and WebCrypto.
 *
 * Run: node --test test/upload-queue-integrity.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { checkFlextextBytes, serializeFlextext, makeDoc, reconcileBaseline } = await import('../docs/js/flextext.js');

const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const up = readFileSync(new URL('../docs/js/upload.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
const grab = (re, what) => { const m = app.match(re); assert.ok(m, `${what} is findable`); return m[0]; };
const g5 = grab(/async function bytesSha256\(buf\) \{[\s\S]*?\nasync function rebuildOrHoldQueued\(key, rec, reason\) \{[\s\S]*?\n\}/, 'the G5 helpers');

const lift = (env = {}) => {
  const e = { checkFlextextBytes, db: {}, uploadView: new Map(), uploadDocById: async () => false, t: (k) => k,
    renderUploadQueue: () => {}, pumpUploads: () => {}, console: { warn() {} }, ...env };
  return new Function(...Object.keys(e), `${g5}\nreturn { bytesSha256, isQueuedText, verifyQueuedText, rebuildOrHoldQueued, QUEUE_REBUILD_MAX };`)(...Object.values(e));
};
const { bytesSha256, isQueuedText, verifyQueuedText, QUEUE_REBUILD_MAX } = lift();

const text = () => {
  const d = makeDoc({ vernLang: 'qaa', analLang: 'id' }, 'Cerita');
  reconcileBaseline(d, ['satu dua tiga', 'empat\u000Blima']);   // a pasted vertical tab, written raw
  return serializeFlextext(d, { vernLang: 'qaa', analLang: 'id' });
};
const recordOf = async (body, extra = {}) => {
  const buf = new TextEncoder().encode(body);
  return { name: 'Cerita 2026-10-01.flextext', mime: 'application/xml', blob: new Blob([buf]), total: buf.byteLength,
    sha256: await bytesSha256(buf.buffer), docId: 'doc1', ...extra };
};

test('a whole copy passes — control character and all — and the checked bytes are what gets sent', async () => {
  const body = text();
  assert.ok(body.includes('\u000B'));
  const rec = await recordOf(body);
  const v = await verifyQueuedText(rec);
  assert.equal(v.ok, true, 'the device never refuses its only backup over an awkward character');
  assert.ok(v.blob && v.blob !== rec.blob, 'a NEW in-memory blob of the checked bytes');
  assert.equal(await v.blob.text(), body, 'byte for byte');
});

test('the shapes that occurred are each caught', async () => {
  const nul = new Uint8Array(489);
  const nulRec = { name: 'x.flextext', blob: new Blob([nul]), total: 489, sha256: '' };
  assert.equal((await verifyQueuedText(nulRec)).reason, 'nul', 'the 489-byte all-NUL copy');
  const good = await recordOf(text());
  assert.equal((await verifyQueuedText({ ...good, total: good.total + 5 })).reason, 'size', 'not the size that was queued');
  const tampered = await recordOf(text().replace('satu', 'SATU'), { sha256: good.sha256 });
  assert.equal((await verifyQueuedText(tampered)).reason, 'hash', 'whole-looking, but not the bytes that were queued');
  const cut = text().slice(0, 300);
  assert.equal((await verifyQueuedText(await recordOf(cut))).reason, 'truncated');
  assert.equal((await verifyQueuedText(await recordOf('<html></html>'))).reason, 'root');
  const unreadable = { name: 'x.flextext', total: 10, blob: { size: 10, arrayBuffer: async () => { throw new Error('gone'); } } };
  assert.equal((await verifyQueuedText(unreadable)).reason, 'unreadable');
});

test('a record from an older engine (no hash) still gets the structural check', async () => {
  const rec = await recordOf(text(), { sha256: '' });
  assert.equal((await verifyQueuedText(rec)).ok, true);
  assert.equal((await verifyQueuedText({ ...rec, blob: new Blob([new Uint8Array(40)]), total: 40 })).ok, false);
});

test('above 64 MB only the head is read — no whole-file buffer of a huge text on a phone', async () => {
  let sliced = 0;
  const big = { name: 'x.flextext', total: 70 * 1024 * 1024, blob: { size: 70 * 1024 * 1024,
    arrayBuffer: async () => { throw new Error('must not read the whole file'); },
    slice: (a, b) => { sliced = b - a; return new Blob([new TextEncoder().encode('<?xml version="1.0"?>\n<document>')]); } } };
  const v = await verifyQueuedText(big);
  assert.equal(v.ok, true);
  assert.equal(v.blob, null, 'the stored blob is sent as before');
  assert.equal(sliced, 65536);
});

test('only Lane B texts are checked; recordings and legacy zips are not hashed', () => {
  assert.equal(isQueuedText('doc1', { name: 'Cerita 2026.flextext' }), true);
  assert.equal(isQueuedText('media:doc1:audio', { name: 'Cerita.flextext' }), false, 'a media key never');
  assert.equal(isQueuedText('doc1', { name: 'x.flextext', lane: 'media' }), false);
  assert.equal(isQueuedText('doc1', { name: 'Cerita 2026.zip' }), false);
});

test('a damaged copy is REBUILT from the text, at most twice, then HELD — and never deleted', async () => {
  const calls = { rebuild: [], put: [], del: 0 };
  const mk = (docExists) => {
    const uploadView = new Map([['doc1', { status: 'uploading' }]]);
    const db = { getDoc: async () => (docExists ? { id: 'doc1' } : null),
      putMedia: async (k, v) => { calls.put.push([k, v]); }, deleteMedia: async () => { calls.del++; } };
    const env = lift({ db, uploadView, uploadDocById: async (id, o) => { calls.rebuild.push([id, o]); return true; } });
    return { env, uploadView };
  };
  const rec = { name: 'Cerita.flextext', docId: 'doc1', blob: new Blob(['x']) };
  let { env } = mk(true);
  await env.rebuildOrHoldQueued('doc1', { ...rec, rebuilds: 0 }, 'nul');
  assert.deepEqual(calls.rebuild[0], ['doc1', { auto: true, rebuilds: 1 }], 'the text exists → rebuilt from what it holds now, silently');
  assert.equal(calls.put.length, 0, 'and nothing is held');
  ({ env } = mk(true));
  const m2 = mk(true);
  await m2.env.rebuildOrHoldQueued('doc1', { ...rec, rebuilds: QUEUE_REBUILD_MAX }, 'hash');
  assert.equal(calls.rebuild.length, 1, 'past the cap: no more rebuilds (storage that keeps damaging must not loop on battery)');
  assert.equal(calls.put[0][1].damaged, 'hash');
  assert.equal(calls.put[0][1].damagedOrphan, false);
  assert.equal(m2.uploadView.get('doc1').status, 'error', 'held where the coworker can see it, with the reason');
  const m3 = mk(false);
  await m3.env.rebuildOrHoldQueued('doc1', { ...rec, rebuilds: 0 }, 'nul');
  assert.equal(calls.put[1][1].damagedOrphan, true, 'text gone → kept as an orphan');
  assert.equal(m3.uploadView.has('doc1'), false, '...and not shown as a failure nobody can act on');
  assert.equal(calls.del, 0, '⚠ NEVER deleteMedia');
});

test('the wiring: checked at queue time and at send time, hash carried through to the report', () => {
  const q = grab(/async function uploadDocById\(docId, opts = \{\}\) \{[\s\S]*?\n\}/, 'uploadDocById');
  assert.ok(q.indexOf('checkFlextextBytes(') > 0 && q.indexOf('checkFlextextBytes(') < q.indexOf("db.putMedia('upload:' + docId"),
    'a fresh build is checked before it is queued');
  assert.match(q, /sha256,\s+\/\/ G5/, 'and its hash is stored in the record');
  assert.match(q, /if \(!opts\.auto\) toast\(t\('upload\.buildFailed'\)/, 'an explicit send says so; the sweep stays silent');
  assert.match(app, /await uploadDocById\(d\.id, \{ auto: true \}\);/, 'the automatic sweep passes auto');
  const pump = grab(/function pumpUploads\(\) \{[\s\S]*?\n\}/, 'pumpUploads');
  assert.ok(pump.indexOf('verifyQueuedText(rec)') > 0 && pump.indexOf('verifyQueuedText(rec)') < pump.indexOf('new DriveUpload('),
    'checked before the upload starts');
  assert.match(pump, /if \(v\.blob\) rec\.blob = v\.blob;/, 'and the checked bytes become the body');
  const retry = grab(/async function retryPendingUploads\(\) \{[\s\S]*?\n\}/, 'retryPendingUploads');
  assert.match(retry, /if \(rec\.damaged\) \{/, 'a held copy is not reset to waiting like a dropped connection');
  assert.match(retry, /if \(rec\.damagedOrphan\) \{ uploadView\.delete\(docId\); continue; \}/);
  assert.match(retry, /DAMAGED_RETRY_MS/, 'it is re-read only after a back-off');
  assert.match(app, /d\.uploadedSha256 = st\.sha256 \|\| '';/, 'the completion stamps the hash WITH the file id');
  assert.match(app, /uploadedSha256: d\.uploadedSha256 \|\| null,/, 'and the inventory reports it');
  assert.match(app, /if \(it && it\.rec && it\.rec\.damaged\) continue;/, 'a held copy does not pin the text at "uploading"');
  assert.match(up, /sha256: this\.rec\.sha256 \|\| '',/, 'DriveUpload hands the hash to the completion hook');
  for (const k of ['upload.buildFailed', 'upload.damagedHeld']) {
    assert.equal((i18n.match(new RegExp(`^  '${k.replace(/\./g, '\\.')}':`, 'gm')) || []).length, 2, `${k} in both languages`);
  }
});
