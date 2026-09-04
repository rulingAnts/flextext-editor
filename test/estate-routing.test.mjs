/* Which estate's URLs the researcher panel prints — estateOf().
 *
 * WHY THIS IS WORTH PINNING: getting it wrong is INVISIBLE. Every URL it produces resolves and
 * serves a working-looking app, so nothing 404s, nothing throws, and no test that only checks
 * "does the link work" can tell. What differs is WHICH app, and a PWA's identity IS its origin —
 * so a researcher sent to the wrong one gets a different installed app with an empty IndexedDB
 * and no sign anything is amiss. (The editor invite is the worst case: on the wrong origin it
 * returns 200, being the engine asset copy, and would install a THIRD PWA.)
 *
 * ⚠ THE BUG THIS ENCODES: the fallback used to be the LEGACY Pages estate — anything that was not
 * *.flextext.app or localhost landed there. The staging worker (*.workers.dev) is not
 * *.flextext.app, so the STAGING panel linked to PRODUCTION Pages apps and, worse,
 * refreshLiveVersions() fetched production Pages sw.js files, so staging devices were being
 * compared against production versions. Seth saw the versions look "out of sync" and the editor
 * link point at rulingants.github.io. Nothing was broken; the numbers were about another estate.
 *
 * The rules, in order, and each is load-bearing:
 *   1. localhost      → same-origin dev rig      (a developer must never be handed production)
 *   2. *.workers.dev / *.pages.dev → same origin (staging serves ./docs at its own root)
 *   3. rulingants.github.io → the legacy estate, BY NAME (never by falling through)
 *   4. everything else → the CURRENT estate      (an unknown host is not a legacy host)
 *
 * Run: node test/estate-routing.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const panel = read('../docs/js/researcher-panel.js');

// Lift the REAL function and the REAL map out of the real file — a regex over the source would
// pass on a version that no longer parses, which is exactly what this needs to catch.
const estatesSrc = panel.match(/^const ESTATES = (\{[\s\S]*?^\};)$/m);
const fnSrc = panel.match(/^export function estateOf\(origin = location\.origin\) \{\n([\s\S]*?)^\}$/m);
ok(!!estatesSrc, 'ESTATES is findable');
ok(!!fnSrc, 'estateOf is findable and exported');
if (!estatesSrc || !fnSrc) { console.log(`\nFAILED (${fail})\n`); process.exit(1); }
const estateOf = new Function('URL', `var ESTATES = ${estatesSrc[1]}
  return function estateOf(origin) {\n${fnSrc[1]}\n};`)(URL);

console.log('\n1. localhost keeps a developer on the dev rig');
{
  const e = estateOf('http://localhost:8012');
  ok(e.editor === 'http://localhost:8012/flextext-editor/', `editor -> ${e.editor}`);
  ok(e.recorder === 'http://localhost:8012/text-recorder/', 'recorder too');
  ok(e.segmenter === 'http://localhost:8012/audio-segmenter/', 'and the segmenter — the third invite kind is its own sub-path on the rig');
  ok(e.local === true, 'and is flagged local');
}

console.log('\n2. STAGING resolves to the STAGING apps, from an explicit map');
/* ⚠ Each staging app is its OWN Worker on its OWN host, so this must NOT be derived from the
 * current origin. The case that proves it: the panel running as the standalone staging researcher
 * build would otherwise offer ITSELF as "Open FlexText Editor" — a URL that resolves, serves a
 * working-looking app, and is the wrong app. Both entry points are checked for exactly that. */
for (const host of ['https://staging-flextext-editor.68mh29kgsd.workers.dev',
                    'https://staging-flextext-researcher.68mh29kgsd.workers.dev',
                    'https://deadbeef.flextext-editor.pages.dev']) {
  const e = estateOf(host);
  ok(e.editor === 'https://staging-flextext-editor.68mh29kgsd.workers.dev/',
     `${new URL(host).hostname}\n           -> editor ${e.editor}`);
  ok(e.researcher === 'https://staging-flextext-researcher.68mh29kgsd.workers.dev/',
     '  ...and the staging researcher, which is a SEPARATE worker');
  /* On the editor's OWN staging host these coincide, and that is correct. The trap is any OTHER
   * staging origin — chiefly the standalone researcher build — where deriving from the current
   * origin would hand back the wrong app. */
  if (!/staging-flextext-editor/.test(host)) {
    ok(e.editor !== host + '/', '  ⚠ ...and NOT this origin (the standalone-researcher trap)');
  }
  ok(e.staging === true, '  ...flagged staging');
  /* No staging build of either satellite exists — they publish only from a productionWeb push.
   * Naming the real address is honest; inventing a staging URL that 404s would not be. */
  ok(e.recorder === 'https://record.flextext.app/', `  ...recorder is the real one: ${e.recorder}`);
  ok(e.crowd === 'https://crowd.flextext.app/', '  ...as is crowd');
  // The segmenter DOES have a staging Worker, so a staging invite must land on it, not on production.
  ok(e.segmenter === 'https://staging-audio-segmenter.68mh29kgsd.workers.dev/', `  ...segmenter is the STAGING one: ${e.segmenter}`);
}

console.log('\n3. the LEGACY estate is recognised BY NAME, never by falling through');
{
  const e = estateOf('https://rulingants.github.io');
  ok(e.editor === 'https://rulingants.github.io/flextext-editor/', `editor -> ${e.editor}`);
  ok(e.recorder === 'https://rulingants.github.io/text-recorder/', 'recorder -> the legacy path');
  ok(e.segmenter === 'https://audio-segmenter.flextext.app/', 'segmenter -> the cloud app: it has no Pages twin, and naming the real one is honest');
  ok(!e.staging && !e.local, 'and is neither staging nor local');
}

console.log('\n4. everything else lands on the CURRENT estate, not the legacy one');
for (const host of ['https://some-new-host.example.com', 'https://research.flextext.app',
                    'https://app.flextext.app']) {
  const e = estateOf(host);
  ok(e.editor === 'https://app.flextext.app/', `${new URL(host).hostname} -> ${e.editor}`);
  ok(e.segmenter === 'https://audio-segmenter.flextext.app/', '  ...and the segmenter link is the production app');
}
// The regression itself, stated as the property that failed.
{
  const e = estateOf('https://staging-flextext-editor.68mh29kgsd.workers.dev');
  ok(!/rulingants\.github\.io/.test(e.editor),
     '⚠ a staging panel NEVER links to the legacy production estate (the reported bug)');
  ok(!/rulingants\.github\.io/.test(e.researcher),
     '⚠ ...and neither does its live-version check, which reads these same URLs');
}

console.log('\nthe deprecation banner does NOT depend on this fallback');
/* It is matched on the exact legacy hostname precisely because estateOf's old fallback swept the
 * *.workers.dev previews into the pages map — an estate-based test would have nagged every staging
 * build. The fallback is fixed now, but the banner must stay hostname-exact regardless: staging is
 * the dev site, not a deprecated address. */
ok(/location\.hostname === LEGACY_PANEL_HOST/.test(panel),
   'it tests the exact hostname, not HOME === ESTATES.pages');

console.log('\nlive versions are read from whatever estate the panel is on');
ok(/fetchLiveVersion\(HOME\.editor \+ 'sw\.js'\)/.test(panel), 'the editor version comes from HOME.editor');
ok(/const HOME = estateOf\(\);/.test(panel), 'and HOME is estateOf() — so fixing estateOf fixes the banner too');

console.log(fail ? `\nFAILED (${fail})\n` : `\nPASSED\n`);
process.exit(fail ? 1 : 0);
