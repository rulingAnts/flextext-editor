/* THE OPERATOR'S MAINTENANCE NOTICE — and the two ways a feature like this goes wrong.
 *
 * Seth asked for a way to tell researchers that the backend is being worked on and that they should
 * hold off making changes. The obvious implementation is the dangerous one, and both hazards are
 * pinned here:
 *
 *  1. ⚠ SHIPPING IT AS A BUILD. The editor and the researcher panel share an origin and a service
 *     worker, so a "temporary outage" page released to productionWeb would reach FIELD TRANSLATORS at
 *     /flextext-editor/ and stop them editing offline — worse than any outage it was warning about.
 *     The notice must live only in the panel, and must come from data rather than from a release.
 *  2. ⚠ NEEDING A DEPLOY TO RAISE IT. A wrangler [vars] entry would require a commit and a deploy to
 *     change, so raising the notice would itself be a release — at exactly the moment you least want
 *     to be shipping. A D1 row is flipped from the Actions tab in seconds.
 *
 * Run: node test/maintenance-notice.test.mjs
 */
import { readFileSync } from 'node:fs';
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const root = new URL('../', import.meta.url);
const rd = (p) => readFileSync(new URL(p, root), 'utf8');
const worker = rd('worker/src/v1.js');
const panel = rd('docs/js/researcher-panel.js');
const rjs = rd('docs/js/researcher.js');
const app = rd('docs/js/app.js');

console.log('\nit is DATA, not a build — raising it is never a release');
{
  ok(/CREATE TABLE IF NOT EXISTS ops_flag/.test(rd('worker/migrate-ops-flag.sql')), 'a flag table exists');
  ok(/SELECT value FROM ops_flag WHERE key=\?/.test(worker), 'the worker reads it');
  ok(/maintenance: maintenance \|\| undefined/.test(worker), '...and returns it on the poll the panel already makes');
  /* No new route and no new client polling loop: it rides GET /v1/researcher, which the dashboard
   * hits every 12s, so the notice appears and clears within one tick. */
  const route = worker.slice(worker.indexOf("seg[1] === 'researcher') {"), worker.indexOf("POST /v1/researcher/approve"));
  ok(/ops_flag/.test(route), 'it rides the existing researcher poll rather than adding a route');
}

console.log('\na failed flag read costs a BANNER, never the dashboard');
{
  const blk = worker.slice(worker.indexOf('let maintenance = null;'), worker.indexOf('const approved = isApproved'));
  ok(/try \{[\s\S]*\} catch \{/.test(blk), 'the read is wrapped');
  ok(/table absent \(pre-migration\)/.test(blk),
     '...including the pre-migration case, so deploying the worker before the migration is safe');
  ok(!/return j\(\{ error/.test(blk), 'and it never turns a missing banner into a failed request');
}

console.log('\n⚠ RESEARCHER PANEL ONLY — it must not be able to reach a field device');
{
  ok(/function maintenanceBanner\(\)/.test(panel), 'the banner is rendered in researcher-panel.js');
  /* THE ASSERTION THAT MATTERS. app.js is the EDITOR (and the recorder, and the crowd page). If the
   * notice ever renders from there, a maintenance flag stops a translator working offline. */
  ok(!/maintenanceBanner|Researcher\.maintenance\(/.test(app),
     'app.js — the editor/recorder/crowd engine — never renders it');
  ok(/Researcher\.maintenance\(\)/.test(panel), 'the panel reads it from the account session');
  ok(/export function maintenance\(\)/.test(rjs), '...which is where listView() refreshes it');
  /* The enumerated-rebuild trap: a server field is invisible unless listView names it. `estate` was
   * lost this way twice, which is why the comment above it exists. */
  ok(/v\.maintenance/.test(rjs), 'listView ENUMERATES the field — the trap that lost `estate` twice');
}

console.log('\nit cannot be dismissed, and it is escaped');
{
  const fn = panel.slice(panel.indexOf('function maintenanceBanner'), panel.indexOf('function assignedDocIds'));
  ok(!/dismiss|data-close|localStorage/.test(fn),
     'no dismiss control — a banner you can hide is one you hide before making changes anyway');
  ok(/esc\(msg\)/.test(fn), 'the operator message is escaped like any other server string');
  ok(/if \(!msg\) return '';/.test(fn), 'and it renders NOTHING when no notice is set');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
