/* TEXTS IN THE RESEARCHER VIEW SORT BY STATUS, THEN NAME (issue #15) — AND THE DONE TOGGLE
 * LEAVES A MARKER (the BACKLOG's "toast and then nothing" fix).
 *
 * Two quick wins from the 2026-08-31 evening run, pinned together because both are one-line
 * opt-ins into machinery that already existed and a refactor could quietly drop either:
 *
 *   1. textOrder(): active texts first, finished after, each half numeric-aware alphabetical —
 *      the SAME compare the device's sortAlpha option uses (#11), so both screens agree that
 *      "Text 2" precedes "Text 10". Applied to device rows (ghosts stay on top — incoming
 *      assigns are news) and the Unassigned card. Crowd rows keep chronology: their names ARE
 *      timestamps.
 *   2. setDone joined CMD_KIND, so an outstanding done-toggle decorates the row in EVERY panel
 *      (serverPending) and instantly in the issuing one (pendingCmds), retiring on ack like
 *      every other command marker. The pending chip is a SPAN, not a button — no double-queue.
 *
 * researcher-panel.js cannot be imported under plain node (panel-collapse.test.mjs's note), so
 * textOrder is extracted and evaluated, the rest source-pinned. */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

test('panel text order + done-toggle marker', () => {
  const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');

  console.log('\n#15: status then name, numeric-aware, shared with the device option');
  {
    const src = (panel.match(/function textOrder\(a, b\) \{[\s\S]*?\n\}/) || [''])[0];
    ok(!!src, 'textOrder exists');
    const textOrder = new Function('return ' + src.replace(/^function textOrder/, 'function'))();
    const texts = [
      { title: 'Text 10', done: false },
      { title: 'Zebra', done: true },
      { title: 'Text 2', done: false },
      { title: 'Anteater', done: true },
    ];
    const sorted = texts.slice().sort(textOrder).map((t) => t.title);
    ok(JSON.stringify(sorted) === JSON.stringify(['Text 2', 'Text 10', 'Anteater', 'Zebra']),
       `active first, done after, numeric-aware within each (${sorted.join(' · ')})`);
    ok(/\.slice\(\)\.sort\(textOrder\)/.test(panel.match(/const listed = [^;]+;/)?.[0] || ''),
       'device rows sort through it (ghosts prepended, not sorted away from the top)');
    ok(/texts = texts\.slice\(\)\.sort\(textOrder\);/.test(panel),
       'the Unassigned card sorts through it too');
    const crowdRows = (panel.match(/function crowdTextRows\(rec, estate\) \{[\s\S]*?\n\}/) || [''])[0];
    ok(!/textOrder/.test(crowdRows), 'crowd rows deliberately keep chronology');
  }

  console.log('\nthe done toggle leaves a marker on the same rails as delete/upload');
  {
    ok(/setDone: 'done'/.test(panel), 'setDone is in CMD_KIND — serverPending carries it to every panel');
    ok(/kind: 'done', instanceId: id, at: Date\.now\(\), done: want/.test(panel),
       'the issuing browser records the optimistic local marker with the TARGET state');
    ok(/kind === 'done' \? \{ done: !!c\.done \}/.test(panel),
       "serverPending entries carry the target state too (the payload's done flag)");
    const pendChip = (panel.match(/const donePend = [^;]+;[\s\S]{0,700}/) || [''])[0];
    ok(/rp-tag-taken/.test(pendChip) && /panel\.inst\.pendingTag/.test(pendChip),
       'a pending toggle wears the same waiting tag as every queued command');
    ok(!/<button[^>]*data-iact="toggle-done"/.test((pendChip.match(/donePend\s*\?[\s\S]*?:/) || [''])[0]),
       '...and is NOT a button while pending — a second click cannot queue a second toggle');
  }

  console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
  if (fail) throw new Error(`${fail} check(s) failed`);
});
