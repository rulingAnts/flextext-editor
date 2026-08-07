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
  ok(e.local === true, 'and is flagged local');
}

console.log('\n2. STAGING points at ITSELF — the editor is that origin\'s root');
for (const host of ['https://staging-flextext-editor.68mh29kgsd.workers.dev',
                    'https://deadbeef.flextext-editor.pages.dev']) {
  const e = estateOf(host);
  ok(e.editor === host + '/', `${new URL(host).hostname} -> ${e.editor}`);
  ok(e.researcher === host + '/', '  ...and the panel is the same deployment');
  ok(e.staging === true, '  ...flagged staging');
  /* The satellites publish only from productionWeb, so there is NO staging recorder or crowd.
   * They keep the real current URLs rather than a guess at one that does not exist. */
  ok(e.recorder === 'https://record.flextext.app/', `  ...recorder stays real: ${e.recorder}`);
  ok(e.crowd === 'https://crowd.flextext.app/', '  ...as does crowd');
}

console.log('\n3. the LEGACY estate is recognised BY NAME, never by falling through');
{
  const e = estateOf('https://rulingants.github.io');
  ok(e.editor === 'https://rulingants.github.io/flextext-editor/', `editor -> ${e.editor}`);
  ok(e.recorder === 'https://rulingants.github.io/text-recorder/', 'recorder -> the legacy path');
  ok(!e.staging && !e.local, 'and is neither staging nor local');
}

console.log('\n4. everything else lands on the CURRENT estate, not the legacy one');
for (const host of ['https://some-new-host.example.com', 'https://research.flextext.app',
                    'https://app.flextext.app']) {
  const e = estateOf(host);
  ok(e.editor === 'https://app.flextext.app/', `${new URL(host).hostname} -> ${e.editor}`);
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
