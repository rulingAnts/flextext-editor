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
  // Two flags since 2026-08-26: `maintenance` (banner) + `freeze` (banner AND the write lock at the
  // top of handleV1) — one declaration, one wrapped read block, same fail-soft contract for both.
  const blk = worker.slice(worker.indexOf('let maintenance = null, freeze = null;'), worker.indexOf('const approved = isApproved'));
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

/* ⚠⚠ IT MUST BE IN THE RENDER SIGNATURE, or it does not appear until a manual refresh.
 *
 * This is the bug Seth actually hit: "the maintenance flag works — except that it doesn't auto
 * refresh within 12s as claimed. Actually so far it doesn't auto refresh at all."
 *
 * viewSig() decides whether the 12s poll redraws. Anything the dashboard renders that is not part
 * of the server `data` object is invisible to it, so the poll concludes "nothing changed" and the
 * new state waits for a manual refresh. The panel's own comments record this happening TWICE before
 * — local pending markers (v339) and shared pending state — which makes the banner the third. A
 * pattern, not bad luck, so it gets an assertion rather than another comment. */
console.log('\nthe 12s poll can actually SEE it');
{
  const sig = panel.slice(panel.indexOf('function viewSig(data)'), panel.indexOf('async function pollDashboard'));
  ok(/Researcher\.maintenance\(\)/.test(sig),
     'viewSig includes the notice, so a change to it triggers a redraw on the poll');
  /* Proof the assertion is not vacuous: viewSig must be findable and non-trivial, or the check
   * above would pass on an empty string. */
  ok(sig.length > 500 && /JSON\.stringify\(\[/.test(sig), '...and viewSig was actually located');
}

console.log('\nit cannot be dismissed, and it is escaped');
{
  const fn = panel.slice(panel.indexOf('function maintenanceBanner'), panel.indexOf('function assignedDocIds'));
  ok(!/dismiss|data-close|localStorage/.test(fn),
     'no dismiss control — a banner you can hide is one you hide before making changes anyway');
  ok(/esc\(n\.message\)/.test(fn) && /esc\(n\.title/.test(fn) && /esc\(fz\)/.test(fn), 'every operator string is escaped like any other server string');
  /* Two banners since the freeze flag (2026-08-26), so "renders nothing when unset" is now
   * structural: an empty accumulator, every banner chunk behind its own if, nothing appended
   * unconditionally. */
  ok(/let out = '';[\s\S]*if \(fz\) \{[\s\S]*if \(msg\) \{[\s\S]*return out;/.test(fn),
     'and it renders NOTHING when no notice is set — both banners are conditional');
}

/* v715 (Seth, 2026-10-10: "edit the maintenance message code so that it gives us more flexibility … so that we
 * can post a non-contradictory message"). The v714 apology had to go out under "Maintenance in progress" and
 * "… Your devices and their texts are unaffected". The real banner code runs here, over the shapes the flag can
 * hold. */
console.log('\na NOTICE is only the operator\'s words; plain text is the maintenance banner it always was');
{
  // A top-level function ends at the first "\n}\n" — brace counting would trip over opsNotice's own '{' literal.
  const src = (name) => { const i = panel.indexOf(`\nfunction ${name}(`); if (i < 0) throw new Error(name + ' not found');
    return panel.slice(i + 1, panel.indexOf('\n}\n', i) + 2); };
  const render = (value, freeze = '') => new Function('value', 'freeze', `
    const Researcher = { maintenance: () => value, freeze: () => freeze };
    const T = { 'panel.maint.title': 'Maintenance in progress', 'panel.maint.advice': 'Please avoid making changes.', 'panel.freeze.title': 'Locked', 'panel.freeze.advice': 'Read only.' };
    const t = (k) => T[k] || k;
    const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    ${src('opsNotice')}
    ${src('maintenanceBanner')}
    return maintenanceBanner();`)(value, freeze);
  const plain = render('Backend work tonight.');
  ok(/Maintenance in progress/.test(plain) && /Backend work tonight\./.test(plain) && /Please avoid making changes\./.test(plain),
     'plain text: the maintenance heading, the message, the advice — as before v715');
  const notice = render(JSON.stringify({ kind: 'notice', title: 'Sorry', message: 'Some texts need re-cutting.' }));
  ok(/rp-opnotice/.test(notice) && /<strong>Sorry<\/strong>/.test(notice) && /Some texts need re-cutting\./.test(notice),
     'a notice: its own title and message, in the notice style');
  ok(!/Maintenance in progress|Please avoid making changes/.test(notice), '…and NOTHING about maintenance — no contradiction');
  const bare = render(JSON.stringify({ kind: 'notice', message: 'Just this.' }));
  ok(!/<strong>/.test(bare) && /Just this\./.test(bare) && !/class="note"/.test(bare), 'a notice with no title or advice is just the message');
  const titled = render(JSON.stringify({ kind: 'maintenance', title: 'Drive is slow', message: 'Uploads may lag.' }));
  ok(/<strong>Drive is slow<\/strong>/.test(titled) && /Please avoid making changes\./.test(titled), 'a titled maintenance notice keeps the standard advice');
  ok(/\{not json/.test(render('{not json')), 'text that only looks like JSON is shown as the plain notice it is');
  const noMsg = render(JSON.stringify({ kind: 'notice' }));
  ok(!/rp-opnotice/.test(noMsg) && /\{&quot;kind&quot;/.test(noMsg),
     'JSON without a message is not a notice — it is shown as plain text, never silently dropped');
  ok(/&lt;b&gt;x&lt;\/b&gt;/.test(render(JSON.stringify({ kind: 'notice', title: '<b>x</b>', message: 'm' }))), 'a notice title is escaped');
  ok(render('') === '', 'no flag: no banner');
  ok(/Locked/.test(render(JSON.stringify({ kind: 'notice', message: 'm' }), 'frozen')), 'the write-lock banner still leads');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
