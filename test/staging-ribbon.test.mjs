/* THE STAGING RIBBON — one snippet, five shells, at the TOP; and its handshake with the sticky header.
 *
 * WHY THIS FILE EXISTS. The ribbon is duplicated by necessity: it is INLINE in each shell's
 * index.html on purpose, so it appears even when the engine fails to load — which is exactly when
 * knowing whether you are on the test site matters most. There is no shared module to put it in
 * without losing that property, so the copies are pinned here instead. They had already drifted in a
 * small way before this test existed: three shells wrote a literal `·` and two an escape.
 *
 * ⚠ IT BELONGS AT THE TOP, ABOVE THE HEADER. v487/v488 moved it below and it was reverted (Seth:
 * "Having the staging bar at the top where it was before was better"). Worth recording because the
 * attempt failed twice on the way: placed beside the header it landed inside #view-researcher, whose
 * innerHTML the panel rewrites every 12s — so the ribbon silently DISAPPEARED, leaving a staging site
 * looking like production — and once that was fixed it rendered inset to the content column while the
 * header broke out full width. Both problems come from the same root: the header is not a child of
 * <body>, so anything positioned relative to it inherits a container nobody chose.
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

console.log('\nevery shell writes the ribbon, at the top, only on the preview hosts');
for (const [name, s] of src) {
  ok(/if \(\/\\\.\(pages\|workers\)\\\.dev\$\/\.test\(location\.hostname\)\)/.test(s),
     `${name}: gated on the *.pages.dev / *.workers.dev hostname, so production ships this file unchanged`);
  ok(/document\.write\('<div id="fx-staging"/.test(s),
     `${name}: ⚠ WRITTEN, not mounted later — it must appear even when the engine fails to load`);
  ok(/position:sticky;top:0;z-index:9999;/.test(s),
     `${name}: sticky at the very top, above everything`);
}

console.log('\n...the same snippet in all five — drift is the failure mode');
{
  const grab = (s) => {
    const a = s.indexOf("document.write('<div id=\"fx-staging\"");
    const b = s.indexOf("addEventListener('resize', fxSync);");
    return a >= 0 && b > a ? s.slice(a, b) : null;
  };
  const bodies = src.map(([name, s]) => [name, grab(s)]);
  ok(bodies.every(([, b]) => b), 'the snippet is findable in every shell');
  const [, first] = bodies[0];
  for (const [name, b] of bodies.slice(1)) ok(b === first, `${name}: byte-identical to the editor's copy`);
}

console.log('\nthe sticky researcher header works WITH and WITHOUT the ribbon');
{
  /* ⚠ THE WHOLE POINT OF THE VARIABLE. The ribbon is above .rp-head and carries z-index 9999, so a
   * header stuck at a plain top:0 slides underneath it and vanishes on scroll — on the test site
   * only, which is where nobody would think to look for it. Production never runs the ribbon script,
   * so the CSS fallback is what makes the same rule correct on both estates. */
  const css = read('../docs/css/app.css');
  ok(/position: sticky; top: var\(--fx-ribbon-h, 0px\); z-index: 40;/.test(css),
     '⚠ .rp-head sticks at the ribbon height, defaulting to 0 — one rule, both estates, no branch');
  const head = (css.match(/\.rp-head \{[\s\S]*?\n\}/) || [''])[0];
  ok(/z-index: 40;/.test(head) && !/z-index: (9999|1000\d)/.test(head),
     '...and stays BELOW the ribbon, so the staging warning is never covered by the header');

  for (const [name, s] of src) {
    ok(/document\.documentElement\.style\.setProperty\('--fx-ribbon-h', el\.offsetHeight \+ 'px'\)/.test(s),
       `${name}: sets --fx-ribbon-h from the ribbon's real height, not a guessed constant`);
    ok(/addEventListener\('load', fxSync\)/.test(s) && /addEventListener\('resize', fxSync\)/.test(s),
       `${name}: ...and re-measures on load and resize, so wrapping at a narrow width does not misalign it`);
  }
  ok(!/--fx-ribbon-h/.test(read('../docs/js/researcher-panel.js')),
     '⚠ the variable is set ONLY by the shells\' staging script — the panel must never set it, or production would inherit an offset');
}

console.log(fail ? `\nFAILED (${fail}) — the staging ribbon or its header handshake has drifted.\n`
                 : '\nPASS: ribbon on top, five identical copies, header sticks clear of it.\n');
process.exit(fail ? 1 : 0);
