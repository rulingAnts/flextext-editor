/* The service worker's VERSION and the engine's ENGINE_VERSION must be the same string.
 *
 * ⚠ THIS DRIFTED FOR TWELVE RELEASES BEFORE ANYONE NOTICED (sw.js v121 vs ENGINE_VERSION v109),
 * because releasing means bumping sw.js and nothing forced the other to follow. It is invisible in
 * normal use, which is exactly why it needs a test rather than a habit.
 *
 * What breaks when they diverge:
 *   1. The researcher panel's stale-device badge compares a device's REPORTED engineVersion against
 *      the LIVE sw.js version. If those can never be equal, EVERY device is permanently "behind" and
 *      the badge fires on all of them — the precise cry-wolf failure its 6h threshold exists to
 *      prevent, defeated from underneath.
 *   2. The in-app version badge and the "already up to date" toast both show ENGINE_VERSION, so
 *      users and researchers are told a version the app is not running.
 *
 * They are two separate files by necessity — sw.js is a classic service worker script and i18n.js is
 * an ES module, so neither can import the other without adding a file to the precached SHELL of the
 * editor AND both satellites. A test is the cheap way to bind them.
 *
 * Run: node test/version-sync.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const swSrc = read('../docs/sw.js');
const i18nSrc = read('../docs/js/i18n.js');

const swVer = (swSrc.match(/const VERSION = '([^']+)'/) || [])[1];
const engineVer = (i18nSrc.match(/export const ENGINE_VERSION = '([^']+)'/) || [])[1];

console.log('\nboth versions are declared and findable');
ok(!!swVer, `docs/sw.js declares VERSION (${swVer || 'NOT FOUND'})`);
ok(!!engineVer, `docs/js/i18n.js declares ENGINE_VERSION (${engineVer || 'NOT FOUND'})`);
// The researcher panel parses the live sw.js with this exact pattern to learn the current version.
// If sw.js's declaration changes shape, that parse silently returns nothing and staleness detection
// stops working with no error anywhere.
ok(/const VERSION = '[^']+'/.test(swSrc),
   "sw.js keeps the literal shape researcher-panel.js greps for (/const VERSION = '...'/)");

console.log('\nthey agree');
ok(swVer === engineVer,
   `sw.js VERSION (${swVer}) === ENGINE_VERSION (${engineVer})`);

console.log('\nthe format the rest of the system assumes');
ok(/^v\d+$/.test(swVer || ''), `version looks like v<number> (${swVer})`);

console.log('\nsatellites are versioned independently, and must stay parseable');
for (const name of ['text-recorder', 'flextext-researcher']) {
  const src = read(`../satellites/${name}/sw.js`);
  const v = (src.match(/const VERSION = '([^']+)'/) || [])[1];
  // Satellites ship on their own cadence, so they are NOT expected to equal the editor's version —
  // only to be readable, since the release-integrity check compares each against what is live.
  ok(/^v\d+$/.test(v || ''), `${name} declares a parseable VERSION (${v})`);
}

console.log(fail ? `\nFAILED (${fail}) — a version has drifted.\n`
                 : '\nPASS: the service worker and the engine report the same version.\n');
process.exit(fail ? 1 : 0);
