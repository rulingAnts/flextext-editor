/* A PRODUCTION RELEASE CARRIES ITS OWN RELEASE-NOTES SECTION. THE BUILD FAILS OTHERWISE.
 *
 * WHY THIS EXISTS (Seth, 2026-08-31, after v538 shipped): "Did you update the release notes modal
 * for this release? You should make that a part of the production push ritual." The v538 section
 * did exist — but it had been written for v533's design and never revised when that design was
 * replaced three versions later, so production told researchers about a "▶ Play" button that
 * "stops the moment you close it" while the shipped feature was an inline Preview transport with
 * nothing to close. The notes' own comment already warned about exactly this ("a stale what's-new
 * claims credit for something that is not there") and the warning did not save it, because a
 * ritual you have to remember is a ritual you eventually skip.
 *
 * ⚠ THE CHECK IS SCOPED TO PRODUCTION BUILDS, and that scoping is what makes it usable. During
 * development BUILD_TAG names the feature and the version churns several times a day — demanding
 * a notes section per bump would be noise, and noise gets muted. BUILD_TAG === '' is precisely the
 * state `bump-version.sh` warns about and a release commit creates, so the requirement lands on the
 * one build where the notes are about to be read by someone who did not write them.
 *
 * What it CANNOT check is whether the words are TRUE — that stays a human duty, which is why the
 * ritual is also written into CLAUDE.md's release section rather than living only here.
 */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

test('release notes name this release', () => {
  const i18n = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');

  const version = (i18n.match(/export const ENGINE_VERSION = '(v\d+)';/) || [])[1] || '';
  const buildTag = (i18n.match(/export const BUILD_TAG = '([^']*)';/) || [])[1];
  ok(!!version, `ENGINE_VERSION is readable (${version})`);

  const block = (panel.match(/const RELEASES = \[([\s\S]*?)\n\];/) || [])[1] || '';
  const top = block.match(/\{ v: '(v\d+)', date: '(\d{4}-\d{2}-\d{2})'/);
  ok(!!top, 'RELEASES has a newest entry');

  if (buildTag === '') {
    console.log(`\nthis is a PRODUCTION build (BUILD_TAG cleared) — the notes must name ${version}`);
    ok(!!top && top[1] === version,
       `the newest release-notes section is ${version} (found ${top && top[1]}) — write this release's notes, `
       + 'or renumber the section you already wrote, BEFORE clearing BUILD_TAG');
    const items = (block.split(/\{ v: 'v\d+'/)[1] || '').match(/k: '([^']+)'/g) || [];
    ok(items.length > 0, '...and it lists at least one change');
    for (const raw of items) {
      const k = raw.slice(4, -1);
      ok(i18n.split(`'${k}':`).length - 1 >= 2, `${k} exists in BOTH languages`);
    }
  } else {
    console.log(`\nfeature build (BUILD_TAG "${buildTag}") — notes are not required to match yet`);
    ok(true, 'skipped: the requirement lands when BUILD_TAG is cleared for production');
  }

  /* The newest entry must be FIRST — the modal renders the array in order and badges entry 0 as
   * "latest", so an out-of-order array would tell a researcher the wrong thing about what they are
   * running, which is the one question this modal exists to answer. */
  const versions = [...block.matchAll(/\{ v: 'v(\d+)'/g)].map((m) => +m[1]);
  ok(versions.length > 1 && versions.every((v, i) => i === 0 || versions[i - 1] > v),
     `sections run newest-first (${versions.slice(0, 4).join(' > ')}…)`);

  console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
  if (fail) throw new Error(`${fail} check(s) failed`);
});
