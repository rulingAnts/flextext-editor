/* PER-BROWSER STATE THAT DESCRIBES THE ACCOUNT — the bug class, pinned.
 *
 * WHY THIS FILE EXISTS. A researcher can be signed in from several browsers at once. State kept in
 * one browser's localStorage is invisible to the others, so any state that describes the ACCOUNT
 * rather than the browser makes a second panel show something false — or, worse, offer an action
 * the first panel's state was supposed to prevent. It has now bitten four times:
 *
 *   v388  pending upload/delete commands were per-browser: the second panel could not see or cancel
 *         them and would issue duplicates.
 *   v389  a cancel performed elsewhere never retired the issuing browser's own marker.
 *   v391  an in-flight MOVE was per-browser, so its second stage could only ever fire in the browser
 *         that started it, and every other panel offered Move on a text already moving.
 *   v391  a text mid-ASSIGNMENT was listed as "unassigned" with a live Remove-from-Drive button.
 *
 * The rule these encode: state is allowed to be browser-local only when it is genuinely local —
 * the bytes of a file this browser is uploading, a secret shown once, or a pure layout preference.
 * Everything else belongs to the account, and the account's home is the settings blob that
 * listView() already refreshes on every poll.
 *
 * These are SOURCE assertions. The decisions live inside renderDashboard/renderInstanceCard, which
 * need a DOM, a signed-in account and a live Worker; what can be checked without any of that is
 * that the state is read from the shared place and that the destructive actions are gated on it.
 *
 * Run: node test/panel-shared-state.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const panel = read('../docs/js/researcher-panel.js');
const researcher = read('../docs/js/researcher.js');

console.log('\nan in-flight move belongs to the account, not to one browser');
{
  ok(/export async function getMoves\(\)/.test(researcher) && /export async function updateMoves\(/.test(researcher),
     'researcher.js owns the account-scoped move store');
  ok(/settingsCache\.moves = await encryptJSON\(Kr, next\)/.test(researcher),
     'it is encrypted under Kr — which text is moving between which devices stays ciphertext in D1');
  ok(/if \(e\.status === 409 && attempt < 4\) continue;/.test(researcher.split('export async function updateMoves')[1] || ''),
     'the read-modify-write is optimistic-locked, so two panels transitioning at once merge');
  ok(/await Researcher\.getMoves\(\)/.test(panel), 'the panel loads moves from the account');
  ok(!/localStorage\.setItem\(MOVES_KEY/.test(panel),
     'and never writes them back to localStorage (the legacy key is migration-only)');
  ok(/localStorage\.removeItem\(legacyKey\)/.test(panel),
     'a move already in flight across the upgrade is migrated up, not stranded');
}

console.log('\n...and any panel can finish it, without racing the others');
{
  ok(/if \(pendingFor\(docId, mv\.from\)\) continue;/.test(panel),
     'stage 2 is skipped when the source is ALREADY being told to remove the text');
  // uploadDelete uploads a fresh copy before deleting, so a duplicate is a wasted field upload.
  ok(/const transitions = \[\];/.test(panel) && /await saveMoves\(\(cur\) => \{/.test(panel),
     'stage transitions are applied to the account copy in one locked write');
  ok(/instanceReported\(mv\.from\) && !findInventoryItem\(mv\.from, docId\)/.test(panel),
     'a move completes only when the source REPORTED and the text is absent — not when it is unreadable');
  ok(/function instanceReported\(instanceId\)/.test(panel),
     'absent-because-revoked is distinguished from absent-because-removed');
}

console.log('\na text on its way to a device is never offered for deletion');
{
  ok(/function inFlightAssignIds\(\)/.test(panel), 'there is one definition of "mid-assignment"');
  ok(/for \(const \[, p\] of serverPending\) if \(p\.kind === 'assign' && p\.docId\) ids\.add\(p\.docId\)/.test(panel),
     'it reads the SHARED pending map, so every panel agrees');
  ok(/const ids = new Set\(aqQueued\);/.test(panel),
     'plus this browser\'s own upload queue — the one thing only it can know');
  ok(/aqQueued = new Set\(out\.map\(\(o\) => o\.docId\)\);/.test(panel),
     'and that mirror is refreshed wherever the queue is read');
  // Both consumers, because the storage modal's Reclaim-space does NOT go through Drive's trash.
  const uses = panel.split('inFlightAssignIds()').length - 1;
  ok(uses >= 3, `inFlightAssignIds is used by both the Unassigned card and the storage modal (${uses - 1} call sites)`);
}

console.log('\nthe account preference is an account preference');
{
  ok(/export async function setPref\(key, value\)/.test(researcher) && /export async function getPrefs\(\)/.test(researcher),
     'researcher.js owns account-level preferences');
  ok(/await Researcher\.setPref\('assignTtlDays', v\)/.test(panel),
     'the delivery TTL is written to the account, not to this browser');
  ok(/try \{ await setAssignTtlDays\(v\); deps\.toast/.test(panel),
     'and the "saved" toast waits for the server, instead of claiming a change that may not have landed');
}

console.log('\na session that has been revoked stops being a working panel');
{
  ok(/if \(e && e\.status === 401\) \{ stopDashPoll\(\); Researcher\.purgeLocal\(\); renderSignIn/.test(panel),
     'the 12s poll treats a 401 as definitive, like renderDashboard already did');
  // Swallowing it left a revoked panel repainting a fully interactive dashboard from lastData.
  ok(!/listView\(\); \} catch \{ return; \}/.test(panel),
     'the bare swallow-everything catch is gone');
}

console.log('\na wiped device is a record, not a control surface');
{
  ok(/const wiped = ins\.wipe_state === 'confirmed';/.test(panel), 'a confirmed wipe is recognised');
  for (const [re, what] of [
    [/const canDelText = engNum >= 94 && !wiped;/, 'Remove-from-device'],
    [/const canSetDone = engNum >= 138 && !wiped;/, 'the Done toggle'],
    [/: \(deleting \|\| wiped\) \? ''/, 'Upload'],
    [/const del = \(!d\.id \|\| d\.__assigning \|\| wiped\) \? ''/, 'the delete control'],
    [/\|\| uploading \|\| wiped\) \? ''/, 'Move'],
  ]) ok(re.test(panel), `${what} is withheld once the device has erased itself`);
  // The Drive copies are real and salvaging them is why the row is still shown at all.
  ok(/Files ▾ downloads deliberately stay live/.test(panel), 'but the downloads deliberately stay');
}

console.log('\nthe stale-device alarm is actually wired to an install');
{
  // listView() emits `install_id`; `ins.id` has never existed, so staleConfirmed returned at its
  // first line on every call and the 6-hour confirmation never once ran.
  ok(/ins\.install_id, ins\.last_seen_at\);/.test(panel),
     'deviceInfo is passed install_id, the field listView actually emits');
  ok(!/\bins\.id\b/.test(panel), 'and nothing reads the field that does not exist');
  ok(/staleConfirmed\(installId, reportedAt, stale, eng, !live\)/.test(panel),
     '"cannot tell" is passed through instead of masquerading as "not behind"');
  ok(/if \(unknown\) \{/.test(panel),
     'and an unknown live version leaves the confirmation clock untouched rather than erasing it');
}

console.log(fail ? `\nFAILED (${fail}) — account state has drifted back into browser storage.\n`
                 : '\nPASS: account-scoped state is shared, and destructive actions are gated on it.\n');
process.exit(fail ? 1 : 0);
