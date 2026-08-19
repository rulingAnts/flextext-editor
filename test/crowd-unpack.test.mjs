/* UNPACKING A CROWD SUBMISSION — the safety properties, since this deletes a stranger's only copy.
 *
 * The extraction turns one zip into individual role-tagged files so a crowd text's folder is
 * structurally identical to a device text's (plan §16.10 "B"). Three things make it safe to run
 * against a live estate, and each is asserted rather than trusted:
 *
 *   1. NOTHING IS BUFFERED. Each entry is a ranged GET whose body streams straight into a Drive
 *      upload. A 26 MB recording never exists in worker memory — which is what makes this possible
 *      without touching the public submit protocol.
 *   2. THE ZIP IS DELETED ONLY AFTER RE-LISTING confirms every entry landed. This runs inside
 *      ctx.waitUntil where a timeout is normal, so extract-and-trust would eventually destroy a
 *      recording that was never extracted.
 *   3. IT IS IDEMPOTENT. A partial run leaves the zip and some files; the next run skips what exists
 *      and finishes. "Run it again" is the recovery path, so it must be free to run again.
 *
 * Run: node test/crowd-unpack.test.mjs
 */
import { readFileSync } from 'node:fs';
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const worker = readFileSync(new URL('../worker/src/v1.js', import.meta.url), 'utf8');
const fn = worker.slice(worker.indexOf('async function crowdUnpackSubmission'), worker.indexOf('const CROWD_MANIFEST_PEEK'));
const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\nnothing is buffered — entries stream through');
{
  ok(/body: body\.body/.test(code), "the upload body is the ranged response's STREAM, not an ArrayBuffer");
  /* arrayBuffer() is fine on the tiny reads (the tail, a 30-byte local header) but must never appear
   * on an entry's data — that is the line between 30 KB and 26 MB in worker memory. */
  const dataPart = code.slice(code.indexOf('const body = await ranged(start'));
  ok(!/arrayBuffer\(\)/.test(dataPart.slice(0, dataPart.indexOf('wrote++'))),
     '...and an entry\'s data is never read into an ArrayBuffer');
}

console.log('\nthe zip is removed only when Drive CONFIRMS every entry');
{
  const tail = code.slice(code.indexOf('const after = await driveJson'));
  ok(/files\?spaces=drive&fields=files\(name\)/.test(tail) || /const after = await driveJson/.test(tail),
     'it RE-LISTS the folder before deleting');
  ok(/if \(missing\.length\) return;/.test(tail),
     '...and keeps the zip if anything is missing — a later run finishes the job');
  ok(/trashed: true/.test(tail) && !/method: 'DELETE'/.test(code),
     '...and TRASHES rather than deletes, so the 30-day net still applies');
  /* The check that authorises destroying the only copy must read DRIVE, not the loop's own
   * bookkeeping — a variable can be right while the upload silently was not. */
  ok(tail.indexOf('missing') > tail.indexOf('await driveJson'),
     'the decision reads Drive, not the local counters');
}

console.log('\nit is idempotent, because re-running is the recovery path');
{
  ok(/if \(present\.has\(e\.name\)\) continue;/.test(code), 'entries already in the folder are skipped');
  ok(/const present = new Set/.test(code), '...from a listing taken before the loop');
  ok(/if \(e\.name === 'flextext-manifest\.json'\) continue;/.test(code),
     'the manifest is skipped — it is extracted separately alongside the zip');
}

console.log('\nit refuses rather than corrupts');
{
  ok(/if \(e\.method !== 0\) return;/.test(code),
     'a COMPRESSED entry aborts — this reads STORE-only zips, which is all our writer makes');
  ok(/if \(start < 0\) return;/.test(code), 'an unrecognised local header aborts');
  ok(/try \{[\s\S]*\} catch \{/.test(fn), 'and the whole thing is wrapped: a delivered submission is never reported failed');
}

console.log('\nroles come from the manifest, never from filenames');
{
  ok(/doc\.bundle && doc\.bundle\.entries/.test(code), 'the roles are read from the manifest\'s bundle list');
  ok(/roleFor\.get\(e\.name\)/.test(code), '...and applied as appProperties on each extracted file');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
