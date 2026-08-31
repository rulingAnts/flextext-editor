/* A CHUNK'S BYTES ARE READ BEFORE THE REQUEST STARTS — NEVER STREAMED LAZILY FROM A BLOB.
 *
 * WHY THIS TEST EXISTS. The crowd recorder's first submission failed EVERY time in Firefox
 * (2026-08-31, Brian's HAR): each data-bearing chunk PUT went out announcing its full
 * Content-Length and then transmitted ZERO body bytes. Cloudflare's edge rejects that as
 * malformed — a raw 400 the DevTools mislabels "CORS Missing Allow Origin" — the loop struck out
 * five times, the visitor saw the "failed" page, and their manual retry always worked. The blob
 * had been read back from IndexedDB moments after being written; fetch() reads a Blob body lazily
 * DURING transmission, and that read failing is invisible to script. (Firefox has a history of
 * exactly this with IPC/file-backed IDB blobs — bugzilla 1253777, 1461426.)
 *
 * The fix is readChunk() in upload.js: materialize the slice to an ArrayBuffer and VERIFY its
 * length before fetch begins, and when it comes up empty, let the caller re-read its source
 * (io.refresh) instead of putting an announced-but-empty body on the wire. This file pins:
 *   1. data PUTs carry materialized bytes, never the lazy Blob;
 *   2. an unreadable blob + refresh → the SAME attempt completes (no "failed" page);
 *   3. an unreadable blob without refresh → the loop stalls WITHOUT ever sending a body-bearing
 *      request (the wire never sees the empty-body 400).
 */
import { test } from 'node:test';
import { runChunkedUpload, readChunk } from '../docs/js/upload.js';

const UNIT = 262144;
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const parseRange = (range) => {
  const probe = /^bytes \*\/(\d+)$/.exec(range);
  if (probe) return { probe: true, total: +probe[1] };
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
  return m ? { from: +m[1], to: +m[2], total: +m[3] } : null;
};

function fakeDrive() {
  const calls = [];
  let received = 0;
  return {
    calls,
    put: async (id, range, body) => {
      const r = parseRange(range);
      calls.push({ ...r, body });
      if (r.probe) return received >= r.total ? { done: true, fileId: 'F' } : { received };
      received = r.to + 1;
      return received >= r.total ? { done: true, fileId: 'F' } : { received };
    },
  };
}

/* A Blob whose backing store has gone away — arrayBuffer() rejects, exactly like the Firefox
 * IndexedDB case (the size is still known; only the READ fails). */
const poisonedBlob = (size) => ({
  size,
  slice(a, b) { return poisonedBlob(Math.min(b, size) - a); },
  arrayBuffer() { return Promise.reject(new Error('backing store unavailable')); },
});

test('chunk reads are materialized and verified before the wire', async () => {
  console.log('\ndata PUTs carry materialized bytes, never the lazy Blob');
  {
    const blob = new Blob([new Uint8Array(4 * UNIT).fill(7)]);
    const drive = fakeDrive();
    const r = await runChunkedUpload({
      total: blob.size,
      slice: (a, b) => blob.slice(a, b),
      openSession: async () => 'S1',
      put: drive.put,
    });
    ok(r.done === true, 'a healthy upload completes');
    const sends = drive.calls.filter((c) => !c.probe);
    ok(sends.length > 0 && sends.every((c) => c.body instanceof ArrayBuffer),
       'every data PUT body is an ArrayBuffer — bytes in hand before fetch begins');
    ok(sends.every((c) => c.body.byteLength === c.to - c.from + 1),
       '...and each one is exactly the announced length');
  }

  console.log('\nan unreadable blob + refresh heals in the SAME attempt (no "failed" page)');
  {
    const good = new Blob([new Uint8Array(4 * UNIT).fill(9)]);
    let source = poisonedBlob(good.size);
    let refreshed = 0;
    const drive = fakeDrive();
    const r = await runChunkedUpload({
      total: good.size,
      slice: (a, b) => source.slice(a, b),
      refresh: async () => { refreshed++; source = good; },
      openSession: async () => 'S1',
      put: drive.put,
    });
    ok(r.done === true, 'the submission completes on the first attempt');
    ok(refreshed === 1, 'the source was re-read exactly once');
    const sends = drive.calls.filter((c) => !c.probe);
    ok(sends.every((c) => c.body instanceof ArrayBuffer && c.body.byteLength > 0),
       'no announced-but-empty body ever reached the wire');
  }

  console.log('\nan unreadable blob with no refresh stalls WITHOUT sending a body');
  {
    /* The strikes back off 2s→32s; collapse the waits so the test runs in milliseconds. */
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
    try {
      const drive = fakeDrive();
      const r = await runChunkedUpload({
        total: 4 * UNIT,
        slice: (a, b) => poisonedBlob(4 * UNIT).slice(a, b),
        openSession: async () => 'S1',
        put: drive.put,
      });
      ok(r.stalled === true, 'the loop hands back to the queue as stalled');
      ok(drive.calls.every((c) => c.probe),
         'only probes reached the transport — the empty-body 400 can no longer happen');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  }

  console.log('\nreadChunk passes non-Blob slices through untouched (test transports)');
  {
    const fake = { size: 5 };
    ok(await readChunk(fake) === fake, 'an object with no arrayBuffer() is returned as-is');
    ok(await readChunk(null) === null, 'null stays null');
  }

  console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
  /* ⚠ EXPLICIT EXIT — same reason as crowd-chunk-policy.test.mjs: importing upload.js keeps
   * node's event loop alive (db.js's module-level BroadcastChannel), so the runner would hang
   * after the last assertion. */
  process.exit(fail ? 1 : 0);
});
