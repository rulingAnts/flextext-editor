/* READING A ZIP WITHOUT DOWNLOADING IT — the writer and the reader, tested against each other.
 *
 * WHY THIS MATTERS. Extracting a crowd submission's entries into their own Drive files needs to
 * enumerate a REMOTE zip. Walking local file headers from the front means reading past every
 * entry's data to reach the next header — i.e. downloading a 26 MB recording just to learn what is
 * beside it. Reading the CENTRAL DIRECTORY from the tail costs two small ranged requests no matter
 * how large the file is.
 *
 * ⚠ The test builds a zip with our OWN docs/js/zip.js and reads it with the worker's parser, so it
 * checks the two against each other rather than against my understanding of either. A parser that
 * agrees with my reading of the spec but not with our writer would pass a hand-written fixture and
 * fail in production.
 *
 * Run: node test/zip-central-directory.test.mjs
 */
import { makeZip } from '../docs/js/zip.js';
import { parseZipCentralDirectory, zipDataStart } from '../worker/src/v1.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const blobOf = (s) => new Blob([s], { type: 'text/plain' });
const entries = [
  { name: 'flextext-manifest.json', data: new Blob(['{"schema":2}'], { type: 'application/json' }) },
  { name: 'recording.wav', data: blobOf('A'.repeat(5000)) },
  { name: 'consent-receipt.txt', data: blobOf('signed') },
];
const zip = new Uint8Array(await (await makeZip(entries)).arrayBuffer());

console.log('\nthe directory is readable from the TAIL alone');
{
  /* The realistic call: fetch the last N bytes and parse. N is chosen to cover the directory of any
   * plausible submission — a handful of entries with short names. */
  const N = Math.min(zip.length, 4096);
  const tail = zip.subarray(zip.length - N);
  const res = parseZipCentralDirectory(tail, zip.length - N);
  ok(!!res && Array.isArray(res.entries), 'a tail slice yields the entry list');
  ok(res.entries.length === 3, `all 3 entries found (got ${res.entries && res.entries.length})`);
  ok(res.entries.map((e) => e.name).join(',') === 'flextext-manifest.json,recording.wav,consent-receipt.txt',
     'names and order match what was written');
  ok(res.entries.every((e) => e.method === 0), 'all STORE — our writer never compresses');
  ok(res.entries[1].csize === 5000, 'sizes come through (5000-byte recording)');
}

console.log('\nan entry\'s DATA range is computable, and only from the LOCAL header');
{
  const { entries: es } = parseZipCentralDirectory(zip.subarray(zip.length - 4096), zip.length - 4096);
  const rec = es.find((e) => e.name === 'recording.wav');
  /* ⚠ The local header's extra field may differ in length from the central directory's. Deriving
   * dataStart from the central entry is the classic zip bug — it reads N bytes off. This asserts the
   * data really is where the LOCAL header says. */
  const start = zipDataStart(zip.subarray(rec.localOffset, rec.localOffset + 30), rec.localOffset);
  ok(start > 0, 'the local header is recognised');
  const data = zip.subarray(start, start + rec.csize);
  ok(data.length === 5000 && data[0] === 65 && data[4999] === 65,
     'the byte range is exactly the entry content');
}

console.log('\nit fails safe rather than plausibly');
{
  ok(parseZipCentralDirectory(new Uint8Array(100), 0) === null, 'no EOCD → null, not a guess');
  ok(zipDataStart(new Uint8Array(30), 0) === -1, 'no local signature → -1, never an offset');
  /* If the caller's tail slice missed the directory, say what to fetch instead of returning a
   * partial list — a truncated entry list would delete a zip whose contents were never extracted. */
  const short = parseZipCentralDirectory(zip.subarray(zip.length - 30), zip.length - 30);
  ok(short && short.need && short.need.length > 0,
     'a tail too short to hold the directory reports what to fetch, never a partial list');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
