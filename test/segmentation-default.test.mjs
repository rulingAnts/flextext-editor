/* Audio Segmentation is ON unless a researcher explicitly turned it OFF.
 *
 * WHY (Seth, 2026-08-12, staging test drive): a brand-new device opened its first assigned text in
 * the BASIC editor; going to the panel and toggling "Enable Audio Segmentation" fixed it. Two
 * defaults were wrong in the same direction: the device read `settings.segmentation === true`
 * (unset → off) and the panel rendered the checkbox from `!!s.segmentation`, so a new instance
 * showed it unchecked and then PUSHED `false`.
 *
 * The rule both sides now share: unset → ON; only an explicit `false` is off. `false` and
 * `undefined` must never be collapsed into one truthiness check, or a researcher who deliberately
 * turned segmentation off would have it come back on — the opposite bug.
 *
 * Run: node test/segmentation-default.test.mjs
 */
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');

console.log('\nthe DEVICE treats unset as on');
{
  const fn = app.match(/function segmentationEnabled\(\)[\s\S]*?\n}/)[0];
  ok(/settings\.segmentation !== false/.test(fn), 'segmentationEnabled() returns `settings.segmentation !== false`');
  ok(!/settings\.segmentation === true/.test(fn), 'and no longer requires an explicit true');
  // Behavioural check against the real expression, for all three states.
  const enabled = (v) => v !== false;
  ok(enabled(undefined) === true, 'unset  -> ON  (a fresh install gets the segmentation workflow)');
  ok(enabled(true) === true, 'true   -> ON');
  ok(enabled(false) === false, 'false  -> OFF (an explicit researcher choice is honoured)');
}

console.log('\nthe PANEL shows a new instance the same default, so it cannot push a spurious false');
{
  ok(/f\.k === 'segmentation'\)\s*v\.segmentation = s\.segmentation !== false/.test(panel),
     "the form value is `s.segmentation !== false`, not `!!s.segmentation`");
  const generic = panel.match(/else if \(f\.type === 'checkbox'\) v\[f\.k\] = !!s\[f\.k\];/);
  ok(!!generic, 'other checkboxes still default off (only segmentation is special)');
  const segIdx = panel.indexOf("f.k === 'segmentation') v.segmentation");
  ok(segIdx > 0 && segIdx < panel.indexOf("else if (f.type === 'checkbox')"),
     'and the segmentation branch is evaluated BEFORE the generic checkbox branch');
}

console.log("\nthe UNPAIRED device's own Settings tab uses the same default (one rule, three surfaces)");
{
  ok(/f\.k === 'segmentation'\) v\.segmentation = s\.segmentation !== false/.test(app),
     "app.js's setup form renders it from `s.segmentation !== false` too");
  const segIdx = app.indexOf("f.k === 'segmentation') v.segmentation");
  const genIdx = app.indexOf("else if (f.type === 'checkbox') v[f.k] = !!s[f.k];");
  ok(segIdx > 0 && genIdx > 0 && segIdx < genIdx,
     'and is evaluated BEFORE the generic checkbox branch, or the generic one would win');
}

console.log('\nthe export toggles follow the same effective default');
{
  ok(/v\[f\.k\] = s\[f\.k\] \?\? \(s\.segmentation !== false\)/.test(panel),
     'unset export toggles follow segmentation, using the same unset-means-on rule');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
