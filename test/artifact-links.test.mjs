/* The panel's per-text Files drop-down: every row that CAN go through the Worker must.
 *
 * WHY (Seth, 2026-08-07): "the 'FlexText Editor' option on our Files drop-down doesn't work."
 * That menu had two kinds of row and only one was authenticated:
 *   - folder-listing rows carry data-drivefile and are intercepted by the click handler, which
 *     calls Researcher.fetchDriveFile(id) — through the WORKER, on the researcher's stored token;
 *   - resolveArtifacts rows were plain <a href="${driveLink(id)}"> — a DIRECT browser request to
 *     drive.usercontent.google.com, authenticated by whatever Google session the browser holds.
 * Signed out, signed into another account, or a file placed under the Worker's own credentials, and
 * the second kind is simply dead while the first kind two lines above it keeps working. The panel's
 * own comment already said as much of the working path: "a plain drive URL would work for the
 * owner, but this behaves identically signed in or not."
 *
 * ⚠ THE href FALLBACK MUST SURVIVE. An assigned-audio artifact can be a researcher-pasted link to
 * some other host, which the Worker cannot fetch and must not be asked to. So the rule is "by id
 * WHEN THERE IS AN ID", not "never by href" — and both branches are asserted, because deleting the
 * fallback would break external audio silently.
 *
 * Run: node test/artifact-links.test.mjs
 */
import { readFileSync } from 'node:fs';
import { resolveArtifacts } from '../docs/js/artifacts.js';
const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

console.log('\nresolveArtifacts exposes the Drive id, not only a URL');
const FID = 'abc123XYZ_def456';
const r = resolveArtifacts({ uploaded: { bundle: FID, 'eaf-flex': 'ZZZ999zzz_888' } }, null);
ok(r.length === 2, `two artifacts resolved (${r.map((x) => x.kind).join(', ')})`);
const bundle = r.find((x) => x.kind === 'bundle');
ok(!!bundle, 'the bundle — the row labelled "FlexText Editor" — is among them');
ok(bundle.id === FID, `and it carries the raw file id: ${bundle.id}`);
ok(/^https:\/\/drive\.usercontent\.google\.com\/download\?id=/.test(bundle.url),
   'the url is still built, as the fallback');

console.log('\n...and an artifact that is NOT a Drive file gets no id, so it keeps its href');
const ext = resolveArtifacts(null, { audioUrl: 'https://example.org/recordings/kasuari.wav' });
ok(ext.length === 1 && ext[0].kind === 'audio', 'an external assigned audio resolves');
ok(ext[0].id === '', 'with NO id — the Worker cannot fetch someone else\'s host');
ok(ext[0].url === 'https://example.org/recordings/kasuari.wav', 'and the original URL untouched');
// A Drive share link the researcher pasted DOES yield an id, and should route through the Worker.
const drv = resolveArtifacts(null, { audioUrl: 'https://drive.google.com/file/d/QQQ111qqq_222/view' });
ok(drv[0] && drv[0].id === 'QQQ111qqq_222', `a pasted Drive share link yields its id: ${drv[0] && drv[0].id}`);

console.log('\nthe panel routes by id when it has one, and by href when it does not');
ok(/fileRows\.push\(f\.id\s*\n?\s*\?\s*`<a class="rp-dl-item" role="menuitem" data-drivefile="\$\{esc\(f\.id\)\}"/.test(panel),
   'an artifact WITH an id becomes a data-drivefile row (Worker-routed)');
ok(/:\s*`<a class="rp-dl-item" role="menuitem" href="\$\{esc\(f\.url\)\}" target="_blank"/.test(panel),
   'and one WITHOUT an id keeps its plain href — external hosts still work');
ok(/data-fname="\$\{esc\(fname\)\}"/.test(panel), 'the row names the download (the handler needs it)');
// Substring, not a regex: the pattern being checked is itself full of escapes.
ok(panel.includes(`const fname = \`\${title || 'text'} - \${t(f.labelKey)}\``)
   && panel.includes(`.replace(/[\\\\/:*?"<>|]+/g, '_')`),
   'and that name is built from the text title and stripped of characters no filesystem accepts');

console.log('\nthe handler that receives them is the SAME one the folder rows already use');
ok(/const df = e\.target\.closest && e\.target\.closest\('\[data-drivefile\]'\);/.test(panel),
   'one delegated handler serves both kinds of row');
ok(/Researcher\.fetchDriveFile\(df\.dataset\.drivefile\)/.test(panel), 'and it fetches through the Worker');

/* ---------------------------------------------------------------------------------------------
 * The invite-link override warning (Seth, 2026-07-28 backlog; built 2026-08-07).
 *
 * Claiming an invite makes a device MANAGED: its Settings tab disappears and everything on it comes
 * from the panel, so whatever the coworker set up themselves is superseded the moment they tap the
 * link. The researcher can weigh that and is the one issuing the link, so they are told here.
 *
 * ⚠ THE DEVICE USER IS DELIBERATELY NOT WARNED, and that asymmetry is the design, not an omission:
 * "the logic of this suite is that that user should not be expected to be tech savvy enough to
 * understand what that means and make an informed decision" (Seth).
 * --------------------------------------------------------------------------------------------- */
const i18n = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../docs/css/app.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');

console.log('\nthe invite modal warns the RESEARCHER before the link is sent');
ok(/rp-invite-warn">\$\{esc\(t\('panel\.invite\.overrideWarn'\)\)\}/.test(panel),
   'the warning is rendered in the invite modal');
ok(/panel\.invite\.overrideWarn[\s\S]{0,80}\$\{row\(t\('panel\.invite\.editorLink'\)/.test(panel),
   'and ABOVE the links — after them it would be read too late, if at all');
ok((i18n.match(/'panel\.invite\.overrideWarn':/g) || []).length === 2, 'translated in BOTH languages');
const en = (i18n.match(/'panel\.invite\.overrideWarn': '([^']*)'/) || [])[1] || '';
ok(/takes over the device/i.test(en), 'it says the device is taken over');
ok(/Settings tab is hidden/i.test(en), 'and that the device loses its own Settings tab');
ok(/writing systems|recording format|consent/i.test(en), 'and names what specifically is replaced');
ok(/\.rp-invite-warn \{/.test(css), 'and it is styled to be noticed');

console.log('\n...and the DEVICE is not warned — that asymmetry is deliberate');
ok(!/overrideWarn/.test(app),
   'app.js never renders it: the coworker is not asked to weigh a decision this suite assumes they cannot');

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASSED\n');
process.exit(fail ? 1 : 0);
