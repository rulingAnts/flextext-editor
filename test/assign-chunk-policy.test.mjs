/* The panel's assignment upload must chunk like every OTHER upload in this suite.
 *
 * WHY THIS TEST EXISTS (Seth, v337 test drive): the consent-prompt upload "hung at 0% and then
 * suddenly jumped to finished", and the reasonable assumption behind the report was that it worked
 * "the same as all of our other uploads — tries it in large chunks and then retries with smaller
 * chunks on failure". It did not. `assignUploadFile` was modelled on the device's
 * upload.js `_streamChunked` but had flattened its adaptive sizing to a FIXED 8 MiB, which caused
 * two separate problems that happen to share one cause:
 *
 *   1. onProgress fires once per COMPLETED chunk. Any file under 8 MiB — which is every spoken
 *      consent prompt — was a single chunk, so nothing was reported until it was already done.
 *      A progress indicator that reads 0% for the whole operation is worse than none: it is
 *      indistinguishable from a hang, and it is what made researchers press Save mid-upload.
 *   2. A FAILING chunk retried at the same size. On a weak field connection that is the one thing
 *      you must not do — the retry is as likely to fail as the attempt, and each failure costs the
 *      whole slice again. The device path halves on failure precisely because of this.
 *
 * ⚠ THE CONSTRAINT THAT MAKES THIS EASY TO GET WRONG: Google Drive's resumable protocol requires
 * every chunk except the last to be a multiple of 256 KiB. A "make the chunks smaller" fix that
 * ignored that would produce 400s from Drive on the SECOND chunk — so it would pass any test using
 * a single-chunk file, and fail only on the large uploads that matter most. Every size this module
 * can produce is therefore asserted to be a multiple of the unit.
 *
 * The real assignUploadFile is exercised against a fake transport, so this tests the shipped loop.
 *
 * Run: node test/assign-chunk-policy.test.mjs
 */
import { readFileSync } from 'node:fs';
import { assignUploadFile, init as researcherInit } from '../docs/js/researcher.js';

/* researcher.js is a browser module but has no DOM dependency at module scope, so it imports
 * cleanly under node once its two ambient inputs are supplied: a worker base (via its own init)
 * and the session-token storage loadAuth() reads. That lets this test drive the REAL chunk loop
 * rather than a lifted copy of it. */
const memStore = () => { const v = {}; return {
  getItem: (k) => (k in v ? v[k] : null), setItem: (k, x) => { v[k] = String(x); },
  removeItem: (k) => { delete v[k]; }, clear: () => { for (const k of Object.keys(v)) delete v[k]; } }; };
globalThis.sessionStorage = memStore();
globalThis.localStorage = memStore();
sessionStorage.setItem('flextext-researcher-auth', JSON.stringify({ researcher_id: 'r1', secret: 's1' }));
researcherInit({ workerBase: () => 'https://worker.example' });

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const UNIT = 262144;

/* Drive's own accounting, faked: it tracks the byte count IT has, answers a probe with that count,
 * and reports done at the end — the same contract the real endpoint offers. `failAt` makes the
 * Nth data PUT fail so the shrink-on-failure path runs. */
function fakeDrive({ total, failAt = -1 }) {
  const seen = [];               // sizes of every accepted data chunk, in order
  const attempted = [];          // sizes of every ATTEMPTED chunk, failures included
  let received = 0, puts = 0;
  const chunk = async (_i, _d, _id, range, body) => {
    if (body === null) return received >= total ? { done: true, fileId: 'F1' } : { received };
    const size = body.size;
    attempted.push(size);
    puts++;
    if (puts === failAt) return { fail: true };
    seen.push(size);
    received += size;
    return received >= total ? { done: true, fileId: 'F1' } : { received };
  };
  return { chunk, seen, attempted, get received() { return received; } };
}

// Patch the module's transport by handing assignUploadFile a blob whose slice() we control and
// intercepting through the exported chunk fn is not possible — so drive the real function with a
// stubbed global fetch instead, via the module's own assignUploadStart/assignUploadChunk. Those hit
// `fetch`, so a fetch stub IS the seam.
function installFetch(drive) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/assignment/upload/start')) {
      return { ok: true, status: 200, json: async () => ({ uploadId: 'U1' }) };
    }
    if (u.includes('/assignment/upload/chunk')) {
      const range = (opts.headers || {})['x-fx-range'] || '';
      const body = opts.body === undefined || opts.body === null ? null : opts.body;
      const r = await drive.chunk(null, null, null, range, body === null ? null : { size: body.byteLength ?? body.size ?? 0 });
      if (r.fail) return { ok: false, status: 503, json: async () => ({ error: 'transient' }) };
      if (r.done) return { ok: true, status: 200, json: async () => ({ done: true, fileId: r.fileId }) };
      return { ok: true, status: 200, json: async () => ({ done: false, received: r.received }) };
    }
    throw new Error('unexpected fetch ' + u);
  };
}

// A blob stand-in: slice() returns something with a byteLength the fetch stub can read.
const fakeBlob = (size) => ({
  size,
  slice(a, b) { return { byteLength: b - a, size: b - a }; },
});

async function run({ total, failAt = -1 }) {
  const drive = fakeDrive({ total, failAt });
  installFetch(drive);
  const progress = [];
  const fileId = await assignUploadFile('i1', 'doc1',
    { blob: fakeBlob(total), name: 'prompt.mp3', mime: 'audio/mpeg', kind: 'consent-prompt' },
    { onProgress: (sent, tot) => progress.push([sent, tot]) });
  return { fileId, progress, drive };
}

console.log('\nTHE REPORTED SYMPTOM: a small file no longer goes 0% -> done');
{
  // 3 MB — a typical spoken consent prompt, and comfortably under the old fixed 8 MiB chunk.
  const { fileId, progress, drive } = await run({ total: 3 * 1024 * 1024 });
  ok(fileId === 'F1', 'the upload completes');
  ok(drive.seen.length > 1, `it is sent as several chunks, not one (${drive.seen.length})`);
  const mid = progress.filter(([s, t]) => s > 0 && s < t);
  ok(mid.length > 0, `progress is reported BEFORE completion (${mid.length} intermediate updates)`);
  ok(progress.some(([s, t]) => s === t), 'and a final 100% is reported');
}

console.log('\n...while every chunk stays a legal Drive size');
{
  /* Drive requires multiples of 256 KiB for every chunk but the last. Break this and the SECOND
   * chunk 400s — so it passes any single-chunk test and fails only on big uploads. */
  for (const total of [3 * 1024 * 1024, 700 * 1024, 50 * 1024 * 1024, 9_999_999]) {
    const { drive } = await run({ total });
    const nonFinal = drive.seen.slice(0, -1);
    ok(nonFinal.every((n) => n % UNIT === 0),
       `${total} bytes: every non-final chunk is a multiple of 256 KiB (${[...new Set(nonFinal)].join(', ') || 'n/a'})`);
    ok(drive.received === total, '...and every byte arrives exactly once');
  }
}

console.log('\na big file still uses big chunks — small slices must not become the new default');
{
  const { drive } = await run({ total: 50 * 1024 * 1024 });
  const biggest = Math.max(...drive.seen);
  ok(biggest >= 4 * 1024 * 1024, `AIMD grows back to large chunks on a fast link (max ${biggest} bytes)`);
  ok(biggest <= 8 * 1024 * 1024, 'and never exceeds the 8 MiB ceiling Drive was already being sent');
}

console.log('\nA FAILING CHUNK RETRIES SMALLER — the second half of the report');
{
  // 8 MB with the 3rd PUT failing: the retry after it must be SMALLER than the attempt that failed.
  const { fileId, drive } = await run({ total: 8 * 1024 * 1024, failAt: 3 });
  ok(fileId === 'F1', 'the upload still completes through the failure');
  const failedSize = drive.attempted[2];
  const after = drive.attempted.slice(3);
  ok(after.length > 0 && after[0] < failedSize,
     `the next attempt is smaller than the one that failed (${failedSize} -> ${after[0]})`);
  ok(after[0] % UNIT === 0, '...and is still a legal Drive size');
  ok(drive.received === 8 * 1024 * 1024, 'and no byte is lost or duplicated across the retry');
}

console.log('\nthe policy matches the device path it was modelled on');
{
  const researcher = readFileSync(new URL('../docs/js/researcher.js', import.meta.url), 'utf8');
  const upload = readFileSync(new URL('../docs/js/upload.js', import.meta.url), 'utf8');
  ok(!/const CHUNK = 8 \* 1024 \* 1024;/.test(researcher), 'the fixed 8 MiB constant is gone');
  ok(/const CHUNK_UNIT = 262144;/.test(researcher) && /const CHUNK_UNIT = 262144;/.test(upload),
     'both modules use the same 256 KiB granularity');
  ok(/shrinkChunk/.test(researcher) && /shrinkChunk/.test(upload), 'both halve on failure');
  // The same measured-pace thresholds, so the two paths do not diverge in behaviour under load.
  ok(/secs < 15/.test(researcher) && /secs < 15/.test(upload), 'both grow when a chunk lands under 15s');
  ok(/secs > 60/.test(researcher) && /secs > 60/.test(upload), 'both shrink when one takes over 60s');
  // Resume must repaint the real position: a resumed upload reporting 0% is the original bug again.
  ok(/if \(onProgress\) onProgress\(offset, total\);\s*\/\/ paint the resumed position/.test(researcher),
     'a resumed upload paints its true offset rather than starting the display at zero');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
