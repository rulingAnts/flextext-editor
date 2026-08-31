/* CROWD ROWS IN THE PANEL: named by LOCAL time, and locked-not-live while a move is in flight.
 *
 * Two quick wins from 2026-08-31, pinned so a refactor cannot quietly undo either:
 *
 *   1. The row's visible name is the LOCAL recording time (Seth: "the filename is kind of
 *      pointless"). The Drive folder keeps its server-generated '<label> — YYYY-MM-DD HH:MM UTC'
 *      name for correlation; the panel derives the researcher's own clock from it. At UTC+9 the
 *      raw stamp puts the wrong DAY on anything recorded after 3 pm.
 *   2. Issue #14's crowd half: a crowd row mid-move wears the same in-flight tag every other
 *      source wears and withholds Move/Delete — offering to trash Drive's only copy while a
 *      device is still fetching it was the one affordance the row must never show.
 *
 * Source pins (researcher-panel.js is browser-bound), plus a real check of the UTC-stamp regex —
 * the one piece of logic here that can rot independently of the worker's crowdTextTitle format.
 */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

test('crowd panel rows: local time + in-flight lock', () => {
  const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../worker/src/v1.js', import.meta.url), 'utf8');

  console.log('\nthe visible name is the local recording time, the raw title the tooltip');
  {
    ok(/function crowdRowWhen\(/.test(panel), 'crowdRowWhen exists');
    ok(/crowdRowWhen\(tx\.title\)/.test(panel), '...and crowdTextRows uses it');
    ok(/histWhen\(d\.getTime\(\)\)/.test(panel),
       'local rendering goes through histWhen — one date format across the panel');
    ok(/title="\$\{esc\(tx\.title \|\| ''\)\}"/.test(panel),
       'the raw Drive name survives as the tooltip');
  }

  console.log('\nthe parse matches the worker\'s actual naming, not a remembered one');
  {
    // The two ends of one contract: worker crowdTextTitle writes `… + ' UTC'` from an ISO slice;
    // the panel regex must accept exactly that shape.
    ok(/toISOString\(\)\.slice\(0, 16\)\.replace\('T', ' '\)/.test(worker)
       && /\+ ' UTC';/.test(worker),
       "worker still names crowd texts '<label> — YYYY-MM-DD HH:MM UTC'");
    const m = /crowdRowWhen\(title\) \{[\s\S]*?\/(.+?)\/\.exec/.exec(panel);
    ok(!!m, 'the panel parse regex is findable');
    if (m) {
      const re = new RegExp(m[1]);
      const sample = 'Village stories — ' + new Date(Date.UTC(2026, 7, 31, 6, 50)).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
      const hit = re.exec(sample);
      ok(!!hit && hit[1] === '2026' && hit[5] === '50',
         `it parses a title built the worker's way (${sample})`);
      ok(!re.exec('My own renamed folder'), 'a hand-renamed title falls through to render as-is');
    }
  }

  console.log('\nissue #14, crowd half: in flight means shown-and-locked');
  {
    const rows = (panel.match(/function crowdTextRows\(rec, estate\) \{[\s\S]*?\n\}/) || [''])[0];
    ok(/pendingMoves\.has\(tx\.docId\) \|\| inFlight\.has\(tx\.docId\)/.test(rows),
       'the busy predicate is the SAME one the Unassigned card uses');
    ok(/rp-tag-moving/.test(rows) && /panel\.store\.inFlight/.test(rows),
       '...wearing the same tag, same vocabulary');
    ok(/busy \? /.test(rows) && /data-uact="drop"/.test(rows),
       'Move/Delete are withheld while busy, not hidden rows (shown-and-locked)');
  }

  console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
  if (fail) throw new Error(`${fail} check(s) failed`);
});
