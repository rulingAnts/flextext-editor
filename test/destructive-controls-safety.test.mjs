/* THE DESTRUCTIVE DEVICE CONTROLS MUST CONFIRM, AND MUST NOT SIT NEXT TO THE ORDINARY ONES.
 *
 * WHY (Seth, 2026-09-01): "especially for low tech-savvy users on small screens, we don't want the
 * nuclear option buttons and normal function buttons TOO close together vertically… make sure each
 * of the destructive one at least has a confirm modal to make sure you can't accidentally unlink,
 * delete, or reset a device while you're trying to change settings or assign a text."
 *
 * Two independent protections, so this pins both. The confirmations already existed; the spacing did
 * not — the group sat 4px under the everyday buttons, which on a touch screen is inside the slop of
 * one tap.
 *
 * ⚠ `confirm()` IS NOT A CONFIRMATION HERE. The suite replaced native dialogs with in-app modals
 * (v540) because the browser's box is unstyled, untranslated, and easy to dismiss by reflex. A
 * regression to window.confirm on one of these would still "confirm" and would still be wrong.
 *
 * Run: node test/destructive-controls-safety.test.mjs
 */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const panelRaw = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
/* ⚠ STRIP COMMENTS BEFORE SCANNING FOR NATIVE DIALOGS. The first version of this test failed on the
 * comment that DOCUMENTS the move away from window.confirm — a check that cries wolf at its own
 * changelog is the kind this repo mutes and then loses. Handler lookups use the raw text; only the
 * native-dialog sweep uses the stripped copy. */
const panel = panelRaw;
const code = panelRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const css = readFileSync(new URL('../docs/css/app.css', import.meta.url), 'utf8');

test('every destructive device control confirms, and is separated from the safe ones', () => {
  console.log('\nevery destructive action goes through a confirmation');
  /* Each handler must await a confirm before it calls the API. Matched per-action so that adding a
   * fourth destructive control without a gate fails here rather than in the field. */
  for (const [act, gate] of [['revoke', 'confirmModal'],
                             ['revoke-install', 'confirmModal'],
                             ['wipe-install', 'wipeConfirmModal'],
                             ['force-remove', 'confirmModal']]) {
    const at = panel.indexOf(`act === '${act}'`);
    const body = at < 0 ? '' : panel.slice(at, at + 420);
    ok(at > 0 && body.includes(gate), `${act} → ${gate}`);
  }

  console.log('\n...and none of them is a NATIVE browser dialog');
  for (const bad of [/if \(!confirm\(/, /window\.confirm\(/, /[^.\w]confirm\(/]) {
    ok(!bad.test(code), `no ${bad.source} in panel CODE`);
  }

  console.log('\nthe destructive group is physically separated from the everyday buttons');
  const grp = (() => {
    const at = css.indexOf('.rp-danger-group {');
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  })();
  ok(/flex-basis: 100%/.test(grp), 'it takes its own line');
  const mt = Number((grp.match(/margin-top:\s*(\d+)px/) || [])[1] || 0);
  const pt = Number((grp.match(/padding-top:\s*(\d+)px/) || [])[1] || 0);
  ok(mt + pt >= 28,
     mt + pt >= 28 ? `and is ${mt + pt}px clear of the row above (margin ${mt} + padding ${pt})`
                   : `⚠ only ${mt + pt}px below the everyday buttons — inside a thumb's slop`);
  ok(/border-top:/.test(grp), 'with a visible boundary, not just whitespace');

  console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
  if (fail) throw new Error(`${fail} check(s) failed`);
});
