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

/* ⚠ v3 (2026-08-12): THE PANEL NO LONGER RENDERS resolveArtifacts ROWS AT ALL.
 *
 * The v3 work order deleted the inferred menu outright — Seth: *"the inferred menu has actually
 * never worked correctly and it's not worth our time making it work correctly if it's just a
 * fallback."* The Files menu now has exactly two states, and neither has a place for a
 * device-REPORTED artifact: a text WITH a `flextext-manifest.json` gets the fixed item list built
 * from the manifest + the folder's role tags, and a text WITHOUT one gets a single
 * "Open the Drive folder ↗" link. A folder link cannot be wrong.
 *
 * The assertions below therefore invert: what used to be pinned as PRESENT is now pinned as ABSENT,
 * because re-introducing it is the regression. `artifacts.js` itself is untouched and still tested
 * (above, and in artifacts-resolve.test.mjs) — it is simply no longer imported by the panel. That
 * is deliberate: the module is pure and correct, and deleting it would touch every sw.js SHELL for
 * no gain. Retiring it is a separate decision for Seth. */
console.log('\nthe panel no longer renders device-reported artifact rows');
ok(!/resolveArtifacts/.test(panel), 'researcher-panel.js does not import or call resolveArtifacts');
ok(!/if \(f\.inferred\) continue;/.test(panel),
   'the inferred-artifact filter is gone WITH the rows it was filtering — nothing left to filter');
ok(!/panel\.hist\.uploadLink'\)\}<\/span>/.test(panel),
   'and the history-fileId "last upload" fallback row is gone too');

console.log('\n...but the pure model still behaves, so retiring it stays a free choice');
{
  // Legacy scalar + hasAudio → the bad inference the park was about. The MODEL must still mark it,
  // so that whoever picks artifacts.js up again inherits the warning rather than the bug.
  const legacy = resolveArtifacts({ uploadedFileId: 'LEG123abc_456', hasAudio: true }, null);
  ok(legacy.length === 1 && legacy[0].kind === 'bundle', 'resolveArtifacts still reports it (the model is unchanged)');
  ok(legacy[0].inferred === true, '...still flagged inferred, which is what made the guess visible');
  const explicit = resolveArtifacts({ uploaded: { bundle: 'REAL123abc_789', 'eaf-flex': 'EAF123abc_00' } }, null);
  ok(explicit.length === 2 && explicit.every((f) => f.inferred === false && !!f.id),
     'an explicit per-kind report still resolves, not inferred, each with its Drive id');
}

console.log('\nthe rows that DO survive are the ones backed by Drive itself');
// Folder-listing rows and the manifest-driven items route by file id through the Worker.
ok(/data-drivefile="\$\{esc\(audioF\.id\)\}"/.test(panel), 'the original-audio item routes by Drive id');
ok(/data-drivefile="\$\{esc\(ftF\.id\)\}"/.test(panel), 'and so does the flextext item');
ok(/data-zipall/.test(panel), 'Download-all is untouched — it still fetches everything');
ok(/driveFolderLink\(folderId\)/.test(panel), 'and the no-manifest state is a folder link');

console.log('\nthe handler that receives them is the SAME one the folder rows already use');
ok(/const df = e\.target\.closest && e\.target\.closest\('\[data-drivefile\]'\);/.test(panel),
   'one delegated handler serves both kinds of row');
// v348: the call gained a progress callback (panel downloads are invisible to the browser's
// download list until they finish), so match the call rather than its exact old argument list.
ok(/Researcher\.fetchDriveFile\(df\.dataset\.drivefile,/.test(panel), 'and it fetches through the Worker');

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
/* ⚠ Count inside the en/id BLOCKS, not across the file: a third language (tpi) translating this key
 * would push a file-wide count to 3 and fail a test that has found nothing wrong. */
const i18nBlock = (lang) => {
  const at = i18n.indexOf(`\n${lang}: {`);
  const rest = i18n.slice(at + 1);
  const nxt = rest.search(/\n[a-z]{2,3}: \{/);
  return nxt < 0 ? i18n.slice(at) : i18n.slice(at, at + 1 + nxt);
};
const inEnAndId = (k) => {
  const re = new RegExp(`^  '${k.replace(/\./g, '\\.')}':`, 'm');
  return (re.test(i18nBlock('en')) ? 1 : 0) + (re.test(i18nBlock('id')) ? 1 : 0);
};

const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');

console.log('\nthe invite modal warns the RESEARCHER before the link is sent');
ok(/rp-invite-warn">\$\{esc\(t\('panel\.invite\.overrideWarn'\)\)\}/.test(panel),
   'the warning is rendered in the invite modal');
ok(/panel\.invite\.overrideWarn[\s\S]{0,80}\$\{row\(t\('panel\.invite\.editorLink'\)/.test(panel),
   'and ABOVE the links — after them it would be read too late, if at all');
ok(inEnAndId('panel.invite.overrideWarn') === 2, 'translated in BOTH languages');
const en = (i18n.match(/'panel\.invite\.overrideWarn': '([^']*)'/) || [])[1] || '';
ok(/takes over the device/i.test(en), 'it says the device is taken over');
ok(/Settings tab is hidden/i.test(en), 'and that the device loses its own Settings tab');
ok(/writing systems|recording format|consent/i.test(en), 'and names what specifically is replaced');
ok(/\.rp-invite-warn \{/.test(css), 'and it is styled to be noticed');

console.log('\n...and the DEVICE is not warned — that asymmetry is deliberate');
ok(!/overrideWarn/.test(app),
   'app.js never renders it: the coworker is not asked to weigh a decision this suite assumes they cannot');

/* The menu was HIDDEN from v316 (Seth, 2026-08-08: "all out of whack... let researchers go to
 * Google Drive directly until I have time to really develop that feature") and RESTORED by
 * assign-by-upload (2026-08-11) as the fixed six-item Downloads list. The one-flag/one-predicate
 * structure that made the park safe is still load-bearing — it is HOW the menu could come back as
 * one flip, and how it could be parked again if the field disagrees — so those chokepoints stay
 * pinned; only the flag's VALUE changed. */
console.log('\nthe Files ▾ menu is gated behind ONE flag, currently ON');
ok(/const FILES_MENU_ENABLED = true;/.test(panel), 'the flag exists and is ON (assign-by-upload restored the menu)');
ok(/function filesMenuHtml\([^)]*\) \{\s*\n\s*if \(!FILES_MENU_ENABLED\) return '';/.test(panel),
   'filesMenuHtml still short-circuits on the flag — one chokepoint, so BOTH call sites obey it');
ok(/function histHasMenu\(e\) \{ return FILES_MENU_ENABLED && !!\(e\.instanceId && e\.docId\); \}/.test(panel),
   'a single predicate answers "does this row get a menu", for menu and fallback alike');

console.log('\n...and the plain History links stay coupled to the SAME predicate');
/* The trap the predicate closed: those links were once gated on `!(e.instanceId && e.docId)` —
 * i.e. "the menu is showing instead". Re-parking the menu without the predicate would leave a
 * History row with no menu AND no link. */
ok(/\$\{audio && !histHasMenu\(e\) \?/.test(panel), 'the audio link is gated on the PREDICATE, not on the old raw condition');
ok(/\$\{up && !histHasMenu\(e\) \?/.test(panel), 'and so is the last-upload link');
ok(!/&& !\(e\.instanceId && e\.docId\) \?/.test(panel),
   'the old condition is GONE — leaving one behind is how a row ends up with nothing at all');

console.log('\nthe menu machinery is all present');
ok(/async function populateFilesMenu\(/.test(panel), 'the menu builder');
ok(/data-zipall/.test(panel) && /data-cleanup/.test(panel), 'Download-all and backup cleanup');
ok(/data-conv="elan"|'elan'/.test(panel) && /runMenuConversion/.test(panel), 'and the on-click conversion rows');

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASSED\n');
process.exit(fail ? 1 : 0);
