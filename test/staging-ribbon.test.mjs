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
    // The whole snippet is ONE line again (the multi-line variants were reverted), so the line IS
    // the unit of comparison — which is also what makes drift between shells a one-glance diff.
    const a = s.indexOf("document.write('<div id=\"fx-staging\"");
    const b = s.indexOf('\n', a);
    return a >= 0 && b > a ? s.slice(a, b) : null;
  };
  const bodies = src.map(([name, s]) => [name, grab(s)]);
  ok(bodies.every(([, b]) => b), 'the snippet is findable in every shell');
  const [, first] = bodies[0];
  for (const [name, b] of bodies.slice(1)) ok(b === first, `${name}: byte-identical to the editor's copy`);
}

console.log('\nthe sticky researcher header works WITH and WITHOUT the ribbon');
{
  /* ⚠ NO OFFSET, AND THAT IS THE WHOLE POINT. The scroll container is <main> (flex:1; overflow-y:auto),
   * not the viewport, and the ribbon is a child of <body> OUTSIDE main — so "the top of my scrollport"
   * already means "below the ribbon" on staging and "the top of the window" on production. One rule,
   * both estates, and the shells need to know nothing about the header.
   *
   * ⚠⚠ AN OFFSET WAS TRIED (--fx-ribbon-h) AND IT PUT A 40px GAP ABOVE THE HEADER. Sticky clamps in
   * BOTH directions: a non-zero `top` pushes the element DOWN to satisfy the constraint even when
   * nothing has scrolled. Measured at the time: .rp-head sat at y=68 inside a container whose top was
   * y=28. That is what these assertions exist to stop coming back. */
  const css = read('../docs/css/app.css');
  ok(/position: sticky; top: 0; z-index: 40;/.test(css),
     '⚠ .rp-head sticks to its CONTAINER at top:0 — correct with the ribbon and without it');
  ok(!/--fx-ribbon-h/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')),
     '⚠⚠ no ribbon-height offset in any live rule — an offset is what created the gap');
  const head = (css.match(/\.rp-head \{[\s\S]*?\n\}/) || [''])[0];
  ok(/z-index: 40;/.test(head) && !/z-index: 9999/.test(head),
     '...and stays BELOW the ribbon, so the staging warning is never covered by the header');

  for (const [name, s2] of src) {
    ok(!/--fx-ribbon-h/.test(s2),
       `${name}: the shell publishes no header offset — it does not need to know the header exists`);
  }

  /* ⚠ AND NO BARE STRIP ABOVE THE HEADER, with the ribbon or without it (Seth). main pads its
   * content by 12px, which showed as page background above the panel's full-bleed bar. Removed at the
   * SOURCE — main's padding, scoped to the standalone panel — rather than clawed back with a negative
   * margin, which is what was there before and did not work: the margin collapsed through
   * #view-researcher and moved the CONTAINER instead of the header. The editor never had this because
   * its #topbar is a body-level flex item OUTSIDE main. */
  ok(/body\.rp-standalone main \{ padding-top: 0; \}/.test(css),
     '⚠ main does not pad above the panel header — scoped to the standalone app, so the editor keeps its 12px');
  ok(/document\.body\.classList\.add\('rp-standalone'\)/.test(read('../docs/js/app.js')),
     '...and the class that scopes it is actually set when researcher mode starts');
  ok(/margin: 0 calc\(-1 \* clamp\(10px, 3vw, 28px\)\) 16px;/.test(head),
     '⚠ the header keeps its horizontal full-bleed negatives but NO negative top margin');
}

console.log(fail ? `\nFAILED (${fail}) — the staging ribbon or its header handshake has drifted.\n`
                 : '\nPASS: ribbon on top, five identical copies, header sticks clear of it.\n');
process.exit(fail ? 1 : 0);
