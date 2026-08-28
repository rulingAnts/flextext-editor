/* THE STAGING RIBBON — one snippet, five shells, and it must stay one snippet.
 *
 * WHY THIS FILE EXISTS. The ribbon is duplicated by necessity: it is INLINE in each shell's
 * index.html on purpose, so it appears even when the engine fails to load — which is exactly when
 * knowing whether you are on the test site matters most. There is no shared module to put it in
 * without losing that property.
 *
 * Duplication that cannot be removed has to be pinned instead, or the copies drift: before v487 they
 * already had, in a small way — three shells wrote a literal `·` and two wrote `·`, the harmless
 * kind of divergence that shows the copies were being edited independently.
 *
 * ⚠ AND THE PLACEMENT IS THE PART THAT LOOKS OPTIONAL AND IS NOT. The ribbon mounts at the top of
 * <body> IMMEDIATELY and only then drops below the header. Someone simplifying this to "just insert
 * it after the header" would break the property the inline-ness exists for: with a JS-rendered header
 * (the researcher panel and the paragraph tool have no static one), waiting for the header means
 * showing NOTHING on a site whose engine has failed. The two-step is the whole design.
 *
 * Run: node test/staging-ribbon.test.mjs
 */
import { readFileSync } from 'node:fs';

const SHELLS = [
  ['editor', '../docs/index.html'],
  ['text-recorder', '../satellites/text-recorder/index.html'],
  ['crowd-recorder', '../satellites/crowd-recorder/index.html'],
  ['flextext-researcher', '../satellites/flextext-researcher/index.html'],
  ['paragraph-analysis', '../paragraph-analysis/index.html'],
];

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const src = SHELLS.map(([name, p]) => [name, read(p)]);

console.log('\nevery shell carries the ribbon, and only on the preview hosts');
for (const [name, s] of src) {
  ok(/if \(\/\\\.\(pages\|workers\)\\\.dev\$\/\.test\(location\.hostname\)\)/.test(s),
     `${name}: gated on the *.pages.dev / *.workers.dev hostname, so production ships this file unchanged`);
  ok(/var fxRibbon = document\.createElement\('div'\);/.test(s), `${name}: builds the ribbon`);
}

console.log('\n...and it is the SAME snippet in all five — drift is the failure mode');
{
  const grab = (s) => {
    const a = s.indexOf('var fxRibbon');
    const b = s.indexOf('}).observe(document.documentElement, { childList: true, subtree: true });');
    return a >= 0 && b > a ? s.slice(a, b) : null;
  };
  const bodies = src.map(([name, s]) => [name, grab(s)]);
  ok(bodies.every(([, b]) => b), 'the snippet is findable in every shell');
  const [, first] = bodies[0];
  for (const [name, b] of bodies.slice(1)) {
    ok(b === first, `${name}: byte-identical to the editor's copy`);
  }
}

console.log('\nthe two-step placement survives — shown at once, THEN moved below the header');
for (const [name, s] of src) {
  ok(/if \(fxRibbon\.parentNode !== b\) b\.insertBefore\(fxRibbon, b\.firstChild\);/.test(s),
     `${name}: ⚠ falls back to the TOP of body, so a failed engine still announces the site`);
  ok(/querySelector\('#topbar, \.rp-head, \.pa-bar, header'\)/.test(s),
     `${name}: ⚠ knows all four header shapes — two of the shells render theirs from JS`);
  /* ⚠⚠ THE OBSERVER MUST NOT DISCONNECT. The first version placed the ribbon once and disconnected,
   * and the ribbon then VANISHED: .rp-head is not a child of <body> — it lives inside
   * #view-researcher, whose innerHTML the panel rewrites on every 12s poll, taking the ribbon with
   * it. A staging site silently looked like production, which is the single failure this element
   * exists to prevent. Caught in the browser, not by this suite, which is why it is pinned now. */
  ok(!/disconnect\(\)/.test(s),
     `${name}: ⚠⚠ the observer NEVER disconnects — a re-render must not be able to erase the ribbon`);
  ok(/if \(!fxRibbon\.isConnected\) \{ fxPlace\(\); return; \}/.test(s),
     `${name}: ...and a detached ribbon is put back`);
  ok(/if \(h && h\.nextSibling !== fxRibbon\) fxPlace\(\);/.test(s),
     `${name}: ...while an already-placed one does nothing, so re-placing cannot loop`);
  ok(/\(pos === 'sticky' \|\| pos === 'fixed'\) \? Math\.round\(h\.getBoundingClientRect\(\)\.height\)/.test(s),
     `${name}: ⚠ the sticky offset is MEASURED from the header, so it stacks under a sticky one (researcher) and sits at top under a static one (editor)`);
}

console.log(fail ? `\nFAILED (${fail}) — the staging ribbon has drifted between shells.\n`
                 : '\nPASS: one ribbon, five shells, shown before it is positioned.\n');
process.exit(fail ? 1 : 0);
