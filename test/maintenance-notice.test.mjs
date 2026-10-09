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
  ok(/opsNoticeHtml\(n\.message\)/.test(fn) && /esc\(n\.title/.test(fn) && /esc\(fz\)/.test(fn) && /^function opsNoticeHtml\(text\) \{[\s\S]*?return esc\(text\)/m.test(panel), 'every operator string is escaped like any other server string (opsNoticeHtml escapes FIRST, then links)');
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
    const T = { 'panel.maint.title': 'Maintenance in progress', 'panel.maint.advice': 'Please avoid making changes.', 'panel.maint.more': 'More info', 'panel.freeze.title': 'Locked', 'panel.freeze.advice': 'Read only.' };
    const t = (k) => T[k] || k;
    const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    ${src('opsNotice')}
    ${src('opsNoticeHtml')}
    ${src('opsNoticeMore')}
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
  ok(/<strong>Drive is slow<\/strong>/.test(titled) && /Please avoid making changes\./.test(titled), 'a titled maintenance notice keeps the standard advice when advice is ABSENT');
  /* The workflow's three fields (Seth, 2026-10-10): a key PRESENT but empty is the operator blanking that
   * line; absent is the default. So the v714 apology can go out with a title of its own and NO advice. */
  const blanked = render(JSON.stringify({ kind: 'maintenance', title: 'Sorry', message: 'Some texts need re-cutting.', advice: '' }));
  ok(/<strong>Sorry<\/strong>/.test(blanked) && !/Please avoid making changes|class="note"/.test(blanked), 'advice "" = no last line at all');
  const headless = render(JSON.stringify({ kind: 'maintenance', title: '', message: 'Just the message.', advice: '' }));
  ok(!/<strong>/.test(headless) && !/Maintenance in progress|class="note"/.test(headless) && /Just the message\./.test(headless), 'title "" and advice "" = the message alone');
  /* "More info" (Seth, 2026-10-10): a summary up front, the long version collapsed behind a toggle. */
  const more = render(JSON.stringify({ kind: 'maintenance', title: 'Sorry', message: 'Short version.', advice: '', details: 'Long <version>\nwith two lines.' }));
  ok(/<details class="rp-maint-more"><summary>More info<\/summary>/.test(more), 'details render as a collapsed <details> with the localised "More info" summary');
  ok(/Long &lt;version&gt;<br>with two lines\./.test(more), '…escaped, with newlines as line breaks');
  ok(!/<details/.test(plain) && !/<details/.test(headless), 'no details, no toggle');
  /* Hyperlinks (Seth, 2026-10-10): [label](https://…) and bare https://… become links; nothing else does. */
  const linked = render(JSON.stringify({ kind: 'maintenance', title: 'T', message: 'Open the [Audio Segmenter](https://audio-segmenter.flextext.app/) or https://app.flextext.app/.', advice: '', details: 'See https://github.com/rulingAnts/flextext-editor/issues/111 (details).' }));
  ok(/<a href="https:\/\/audio-segmenter\.flextext\.app\/" target="_blank" rel="noopener">Audio Segmenter<\/a>/.test(linked), '[label](url) becomes a link that opens in a new tab');
  ok(/<a href="https:\/\/app\.flextext\.app\/" target="_blank" rel="noopener">https:\/\/app\.flextext\.app\/<\/a>\./.test(linked), 'a bare URL becomes a link, and its trailing full stop stays outside');
  ok(/issues\/111" target="_blank" rel="noopener">https:\/\/github\.com\/rulingAnts\/flextext-editor\/issues\/111<\/a> \(details\)\./.test(linked), '…in the More-info text too, with the closing bracket outside');
  const unsafe = render(JSON.stringify({ kind: 'maintenance', message: 'x [y](javascript:alert(1)) <a href="https://e.com">z</a> [q](https://e.com/" onclick="x)' }));
  ok(!/javascript:/.test(unsafe.replace(/&quot;/g, '')) || !/<a href="javascript/.test(unsafe), 'a javascript: label-link is NOT a link');
  ok(!/<a href="https:\/\/e\.com">z<\/a>/.test(unsafe) && /&lt;a href=/.test(unsafe), 'raw HTML in the text stays escaped text');
  ok(/href="https:\/\/e\.com\/&quot;" target/.test(unsafe) && !/" onclick="/.test(unsafe), 'a quote inside a URL stays an entity inside the href, so it cannot close the attribute');
  ok(/\{not json/.test(render('{not json')), 'text that only looks like JSON is shown as the plain notice it is');
  const noMsg = render(JSON.stringify({ kind: 'notice' }));
  ok(!/rp-opnotice/.test(noMsg) && /\{&quot;kind&quot;/.test(noMsg),
     'JSON without a message is not a notice — it is shown as plain text, never silently dropped');
  ok(/&lt;b&gt;x&lt;\/b&gt;/.test(render(JSON.stringify({ kind: 'notice', title: '<b>x</b>', message: 'm' }))), 'a notice title is escaped');
  ok(/Locked/.test(render(JSON.stringify({ kind: 'notice', message: 'm' }), 'frozen')), 'the write-lock banner still leads');
  ok(render('') === '', 'no flag: no banner');
}

console.log('\nthe workflow owns all three lines, pre-filled with the panel\'s own defaults');
{
  const yml = rd('.github/workflows/maintenance-notice.yml');
  const i18n = rd('docs/js/i18n.js');
  const def = (k) => (yml.match(new RegExp(`      ${k}:\\n(?:        .*\\n)*?        default: "([^"]*)"`)) || [])[1];
  const en = (k) => (i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '([^']*)'`)) || [])[1];
  ok(def('title') === 'Maintenance in progress' && def('title') === en('panel.maint.title'), `title default is the panel\'s own heading: "${def('title')}"`);
  ok(!!def('advice') && def('advice') === en('panel.maint.advice'), 'advice default is the panel\'s own advice line, word for word');
  ok(!!def('message'), 'the message is pre-filled too');
  ok(/const custom = title !== DEFAULT_TITLE \|\| advice !== DEFAULT_ADVICE \|\| !!details;/.test(yml), 'plain text while heading and advice are the defaults and there is no More-info — older panels keep working');
  ok(/JSON\.stringify\(\{ kind: "maintenance", title, message: msg, advice, \.\.\.\(details \? \{ details \} : \{\}\) \}\)/.test(yml), 'otherwise JSON with all three keys present (empty = that line dropped), plus details when given');
  ok(/^      details:/m.test(yml) && /const custom = title !== DEFAULT_TITLE \|\| advice !== DEFAULT_ADVICE \|\| !!details;/.test(yml), 'a More-info text is a fourth field, and makes the value structured');
  ok(/const none = \(s\) => \(s === "-" \? "" : s\);/.test(yml) && /none\(\(process\.env\.FX_TITLE/.test(yml) && /none\(\(process\.env\.FX_ADVICE/.test(yml),
     '⚠ a lone "-" means no heading / no last line — GitHub refills an EMPTY dispatch field from its default, so blank cannot mean none');
  ok(/Type - for no heading/.test(yml) && /Type - for no last line/.test(yml), '...and both field descriptions say so');
  ok(i18n.split("'panel.maint.more':").length - 1 === 2, 'the "More info" summary label exists in both languages');
  ok(/if: steps\.compose\.outputs\.structured == '1'/.test(yml) && /-lt 715/.test(yml) && /research\.flextext\.app\/sw\.js/.test(yml),
     '⚠ a custom heading or advice is refused while the LIVE panel is older than v715 (it would print the JSON raw)');
  ok(!/^\s*kind:/m.test(yml.split('jobs:')[0]), 'no "kind" input — the three text fields are the whole interface');
  const on = yml.slice(yml.indexOf('\non:'), yml.indexOf('\njobs:'));
  ok(!/^\s*(push|schedule):/m.test(on), 'manual only, no push or schedule trigger');
  ok(/slice\(0, 4000\)/.test(worker) && !/slice\(0, 500\)/.test(worker.slice(worker.indexOf('let maintenance = null'), worker.indexOf('const approved = isApproved'))),
     'the worker passes 4000 characters through (500 cut the bilingual v714 apology mid-sentence, and would cut any JSON)');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
