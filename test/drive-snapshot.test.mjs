/* THE PRE-MIGRATION SNAPSHOT — the one recovery artefact that cannot be produced afterwards.
 *
 * WHY THIS EXISTS. Google Drive does not version folder parentage. Once a folder has been moved,
 * NOTHING in Drive records where it used to be — not the file resource, not a revision history, not
 * the trash. Every other step in plans/drive-as-truth.md §17 reconstructs the estate from our own
 * tags, which is a good fallback and is not the same as knowing. Taken before a migration, this file
 * is the difference between RESTORING the estate and re-deriving a plausible one.
 *
 * Which makes the failure mode peculiar: nothing breaks if this is wrong, until the day it is the
 * only thing that could have helped. So the properties are pinned here rather than trusted.
 *
 * Run: node test/drive-snapshot.test.mjs
 */
import { readFileSync } from 'node:fs';
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const root = new URL('../', import.meta.url);
const worker = readFileSync(new URL('worker/src/v1.js', root), 'utf8');
const panel = readFileSync(new URL('docs/js/researcher-panel.js', root), 'utf8');
const rjs = readFileSync(new URL('docs/js/researcher.js', root), 'utf8');

const route = worker.slice(worker.indexOf("seg[2] === 'drive-snapshot'"));
const body = route.slice(0, route.indexOf('\n  }\n'));

console.log('\nit records what DRIVE held, not what our grouping made of it');
{
  ok(/driveListAll\(access, false\)/.test(body) && /driveListAll\(access, true\)/.test(body),
     'both the live and the TRASHED listings are captured');
  /* Knowing what was ALREADY in the trash is what stops a recovery from restoring things the
   * researcher deleted on purpose. */
  ok(/trashed: dead/.test(body), '...and the trashed set is kept separate, not merged in');
  /* ⚠ RAW, NOT THE PROJECTION. If buildDriveEstate's grouping is what turns out to be wrong, a
   * snapshot shaped by it preserves the same mistake and cannot be used to detect it. */
  ok(!/buildDriveEstate/.test(body), 'the snapshot does NOT pass the listing through buildDriveEstate');
  ok(/files: live/.test(body), '...it returns the raw file list');
}

console.log('\nit is self-describing — a snapshot that cannot name its estate will not be trusted');
{
  ok(/takenAt: now/.test(body), 'it records when it was taken');
  ok(/masterFolderId/.test(body), '...and WHICH estate it is of');
  ok(/schema: 1/.test(body), '...and its own schema, so a future reader can branch');
  ok(/counts:/.test(body), '...and counts, so a truncated file is obvious at a glance');
}

console.log('\nit is researcher-authed and adds no new Drive surface');
{
  ok(/authResearcher\(request, env\)/.test(body), 'researcher-authed');
  /* driveListAll under drive.file scope can only ever see files THIS APP created, so this cannot
   * report on anything of the researcher's that we did not write. The bound is structural. */
  ok(!/files\?q=|files\.list/.test(body), 'no bespoke Drive query — it reuses driveListAll verbatim');
  ok(/safeErr\(e\)/.test(body), 'errors are redacted like every other Drive path');
}

console.log('\nit is REACHABLE — an endpoint nobody can run does not get run');
{
  ok(/export function driveSnapshot\(\)/.test(rjs), 'a client wrapper exists');
  ok(/data-storesnap/.test(panel), 'and a control in the Drive management view');
  ok(/Researcher\.driveSnapshot\(\)/.test(panel), '...wired to the endpoint');
  ok(/a\.download = `flextext-drive-snapshot-/.test(panel), '...which saves a timestamped file');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
