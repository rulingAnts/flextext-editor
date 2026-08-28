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

// The paragraph-analysis satellite lives at the repo root (its own Cloudflare Worker deploy,
// not a satellites/ Pages mirror) but follows the exact same versioning discipline.
const SATELLITE_SW = [
  ['text-recorder', '../satellites/text-recorder/sw.js'],
  ['flextext-researcher', '../satellites/flextext-researcher/sw.js'],
  ['paragraph-analysis', '../paragraph-analysis/sw.js'],
];

/* ⚠ ONE NUMBER ACROSS ALL FIVE SITES (Seth, 2026-08-28) — this assertion was DELIBERATELY WEAKENED
 * before, and strengthening it is the point of the change.
 *
 * It used to say only "parseable", because each satellite's VERSION rode its own cadence: bump-version.sh
 * incremented it by one per bump, so the recorder sat at v419 while the engine was v477. Two number
 * lines. That cost a real false alarm — the researcher panel's live banner printed
 * "editor v477 · recorder v386 · researcher v410" beside device cards reporting `engine v477`,
 * inviting a comparison between quantities that were never the same thing (fixed in v478).
 *
 * The weak form also could not catch the failure the script's own header describes: on 2026-08-04 a
 * sed keyed on the previous version silently no-opped and two releases shipped labelled v167/v168
 * while every file still said v166 — "version-sync could not catch it (it checks that the sites
 * AGREE, not what they say)". Equality across all five is the check that WOULD have caught it.
 *
 * The satellites' own counters were free to diverge because nothing compares them: VERSION is used
 * only to name the cache (`'text-recorder-' + VERSION`) and to bust it, both of which need the value
 * to CHANGE, never to be comparable. So collapsing them onto the engine number costs nothing and
 * makes "is this app current?" one expected value for every app in the estate.
 *
 * ⚠ SAFE ONLY BECAUSE IT RAISES EVERY COUNTER. At unification the satellites stood at v420/v411/v306,
 * all below the engine — no service worker saw its version go backwards. If a satellite's counter
 * were ever ABOVE the engine, unifying would lower it, and a browser holding the higher-numbered
 * cache would be reasoning about a version that had already existed with different contents. Check
 * that before ever re-basing these numbers again. */
console.log('\nall five version sites carry the SAME number');
for (const [name, path] of SATELLITE_SW) {
  const src = read(path);
  const v = (src.match(/const VERSION = '([^']+)'/) || [])[1];
  ok(/^v\d+$/.test(v || ''), `${name} declares a parseable VERSION (${v})`);
  ok(v === engineVer,
     `${name} VERSION (${v}) === editor ENGINE_VERSION (${engineVer})`
     + (v === engineVer ? '' : ' — run ./bump-version.sh, which sets every site explicitly'));
}

/* ⚠ THE GUARD FOR THE FAILURE THE ORDERING GATE CANNOT SEE.
 *
 * The publish workflow already refuses to ship a satellite BEFORE the editor is live and all its
 * precached paths return 200 (the 2026-07-20 outage). But it is blind to the opposite failure:
 * bumping the engine and never touching the satellites at all. Then the workflow still runs, still
 * waits for the editor, still verifies every path — and finds the mirror unchanged, prints
 * "no change — nothing to publish", exits 0. A completely green release in which installed
 * satellites go on serving a STALE engine. That happened at v130.
 *
 * So each satellite declares the engine version it was built against, and it must match exactly.
 * The point is not the constant; it is that keeping this test green REQUIRES editing the satellite
 * file — and editing it is what changes its bytes, which is what makes a browser fetch and install
 * the new worker. The reminder becomes structural.
 */
console.log('\neach satellite declares the ENGINE it was built against, and it must match');
for (const [name, path] of SATELLITE_SW) {
  const src = read(path);
  const e = (src.match(/const ENGINE = '([^']+)'/) || [])[1];
  ok(!!e, `${name} declares ENGINE (${e || 'NOT FOUND'})`);
  ok(e === engineVer,
     `${name} ENGINE (${e}) === editor ENGINE_VERSION (${engineVer})`
     + (e === engineVer ? '' : ' — bump this satellite, or its users keep a stale engine'));
}

/* The paragraph-analysis deploy safety contract (Seth, 2026-08-04: "guarded in our workflows,
 * not just AI memory"). The Cloudflare site paragraph-analysis-tool builds THIS repo on every
 * branch; production (pat.flextext.app) must only ever be written by productionWeb builds.
 * That routing lives in paragraph-analysis/deploy.sh + the build.sh guard — these assertions
 * make removing or renaming any piece of it fail the release, not fade from memory. */
/* EVERY Cloudflare deploy folder, not just PAT's (Seth spotted this in a crowd.flextext.app build
 * log: "It mentions 'paragraph-analysis-tool contract' which doesn't sound right"). He was right —
 * the shared test only ever checked PAT, so a wrong Worker name or a missing guard in any of the
 * four new apps would have deployed happily. Each folder must name ITS OWN Worker and keep both
 * guards, or a misconfiguration reaches production silently. */
console.log('\nevery Cloudflare deploy folder keeps its contract');
{
  const APPS = [
    ['../paragraph-analysis', 'paragraph-analysis-tool'],
    ['../apps/editor',        'flextext-editor'],
    ['../apps/recorder',      'flextext-recorder'],
    ['../apps/researcher',    'flextext-researcher'],
    ['../apps/crowd',         'flextext-crowd'],
  ];
  for (const [dir, worker] of APPS) {
    const toml = read(dir + '/wrangler.toml');
    ok(new RegExp('^name = "' + worker + '"$', 'm').test(toml),
       `${dir}: wrangler.toml names its OWN Worker (${worker})`);
    ok(/command = "bash build\.sh"/.test(toml),
       `${dir}: keeps the [build] hook, so assembly + guard can never be skipped`);
    const dep = read(dir + '/deploy.sh');
    ok(/versions upload --preview-alias/.test(dep) && /wrangler deploy/.test(dep)
       && /WORKERS_CI_BRANCH/.test(dep) && /productionWeb/.test(dep),
       `${dir}: deploy.sh routes productionWeb → deploy, other branches → preview alias`);
    ok(/FX_CI_ROUTED/.test(dep) && /FX_CI_ROUTED/.test(read(dir + '/build.sh')),
       `${dir}: build.sh refuses unrouted non-production builds`);
  }
  // ⚠ No two folders may claim the same Worker — that is how one app overwrites another.
  const names = APPS.map(([, w]) => w);
  ok(new Set(names).size === names.length, 'no two deploy folders target the same Worker name');
}

console.log(fail ? `\nFAILED (${fail}) — a version has drifted.\n`
                 : '\nPASS: the service worker and the engine report the same version.\n');
process.exit(fail ? 1 : 0);
