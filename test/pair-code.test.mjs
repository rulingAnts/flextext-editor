/* THE PAIRING CODE — the number both screens must show, and the four ways it stops being one.
 *
 * Seth, 2026-08-20: "Our pairing process is confusing and inconsistent. It shows a very long key on
 * the editor very briefly and then disappears. And then the researcher is supposed to visually
 * verify that it matches what they have on their end. […] What we want is for the pairing process
 * to look more like pairing a smart TV or logging on with Apple — show a large type, 6 digit random
 * code that is persistent and visible on both devices until both ends have approved the pairing."
 *
 * The failure that prompted it: the device's code lived ONLY inside a 12-second toast, so a
 * coworker who missed it had no screen anywhere that would show it again — while the panel went on
 * insisting he read it aloud before it would approve. He refused, correctly, and was stuck.
 *
 * ⚠ WHY THE CODE IS MINTED BY THE WORKER. Truncating the install's public-key fingerprint to six
 * digits needs no schema and no deploy ordering, and is weaker than the fingerprint it replaces:
 * ~20 bits, so a device seeking approval in place of the expected one can grind keypairs offline
 * until its own fingerprint starts with the same six digits. A minted code cannot be steered by the
 * device and belongs to one pending pairing.
 *
 * Run: node test/pair-code.test.mjs
 */
import { readFileSync } from 'node:fs';
const read = (r) => readFileSync(new URL(r, import.meta.url), 'utf8');
const worker = read('../worker/src/v1.js');
const mig = read('../worker/migrate-pair-code.sql');
const schema = read('../worker/schema-current.sql');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

console.log('\nthe migration is additive, which is what lets it ship before any client');
ok(/ALTER TABLE install ADD COLUMN pair_code TEXT;/.test(mig),
   'one nullable column — the DEPLOYED worker keeps working against a database carrying it');
ok(!/NOT NULL/.test(mig.split('ALTER TABLE')[1] || ''),
   '⚠ and NOT NULL is absent: a NOT NULL column with a null bind is exactly what 500\'d the key grants');
ok(!/DROP|CREATE TABLE|UPDATE |DELETE /.test(mig.replace(/--.*$/gm, '')),
   'nothing is rebuilt, rewritten or deleted');
ok(/pair_code TEXT/.test(schema), 'and schema-current.sql records it, so the next reader sees the real shape');

console.log('\nthe code is minted, not derived, and not biased');
const mint = worker.match(/function mintPairCode\(\)[\s\S]*?\n\}/);
ok(!!mint, 'there is one function that mints it');
const m = mint ? mint[0] : '';
ok(/crypto\.getRandomValues/.test(m), 'from the CSPRNG, not Math.random');
ok(/while \(n >= LIMIT\)/.test(m),
   '⚠ rejection sampling — a biased code is a smaller keyspace than it claims to be');
ok(/padStart\(6, '0'\)/.test(m), 'always six digits, so a leading zero cannot silently make it five');
ok(!/fingerprint|pubkey/.test(m),
   '⚠ NOT derived from the device key — a truncated fingerprint can be ground for offline');

console.log('\nboth screens are served the SAME code');
ok(/pair_code: \(mine && mine\.pair_code\) \|\| ''/.test(worker),
   '⚠ the fresh claim READS BACK the stored code — the INSERT is OR IGNORE, so the local variable can be the wrong one');
ok(/pair_code: ok\.pair_code \|\| ''/.test(worker),
   '⚠ and the lost-response retry returns the SAME code, never a fresh mint — the device may already be reading it aloud');
ok(/SELECT install_id, pair_code FROM install WHERE install_id=\? AND instance_id=\?/.test(worker),
   '...which means the retry path actually selects it');
ok(/SELECT install_id, status, accepted, pair_code, /.test(worker),
   'the panel dashboard is served it too, or only one end could ever show it');

console.log('\nit lives exactly as long as the pairing does');
ok(/UPDATE install SET status='approved', pair_code=NULL WHERE install_id=\?/.test(worker),
   '⚠ approving CLEARS it — otherwise every dashboard payload ships a live-looking code for ever');
ok(/pair_code\) ' \+/.test(worker) && /'pending', 0, 0, 0, \?, \?, \? FROM invite/.test(worker),
   'and it is written at claim, in the same atomic batch that creates the install');
ok((worker.match(/mintPairCode\(\)/g) || []).length === 2,
   'minted in exactly ONE place (its definition plus its single call site)');

console.log('\nnothing existing changed shape — old clients must keep working');
ok(/status: 'pending', pair_code:/.test(worker),
   'pair_code is ADDED to the claim response beside the existing fields, not instead of any');
/* ⚠ THIS ASSERTION ONCE REQUIRED THE OPPOSITE, and it was right to, until the decision changed.
 * It was written to stop the researcher profile being dropped from the claim response, on the
 * reasoning that removing a field old clients might read would break them. Seth then decided the
 * field should not exist (2026-08-27): "I don't think we need either researcher named to the field
 * user. In fact we don't. Because we don't want that evidence available on a siezed device. The
 * pairing code should be good enough either way."
 *
 * ⚠ AND THE COMPATIBILITY WORRY WAS UNFOUNDED, which is worth recording rather than asserting away:
 * no shipped client ever RENDERED it. At the merge-base the only occurrence of `r.researcher` in
 * docs/js is a prose comment in sync.js; app.js's single `.researcher` match is an unrelated
 * cache-name regex. So the removal costs an old device nothing — it drops a field none of them read.
 * `pair_code` is unaffected and still rides the same response, which the assertion above pins. */
ok(/return \{ type: row && row\.type \};/.test(worker) && !/name: row\.display_name/.test(worker),
   '⚠ pairingIdentity carries the device TYPE and no researcher identity at all — nothing names a person to a device');

/* ---------------- the client and panel halves ---------------- */
const app = read('../docs/js/app.js');
const sync = read('../docs/js/sync.js');
const panel = read('../docs/js/researcher-panel.js');
const researcher = read('../docs/js/researcher.js');
const cryptojs = read('../docs/js/crypto.js');
const css = read('../docs/css/app.css');
const i18n = read('../docs/js/i18n.js');
const i18nBlock = (code) => {
  const at = i18n.indexOf(`\n${code}: {`);
  if (at < 0) return '';
  const rest = i18n.slice(at + 1);
  const nxt = rest.search(/\n[a-z]{2,3}: \{/);
  return nxt < 0 ? i18n.slice(at) : i18n.slice(at, at + 1 + nxt);
};
const inEnAndId = (k) => {
  const re = new RegExp(`^  '${k.replace(/\./g, '\\.')}':`, 'm');
  return (re.test(i18nBlock('en')) ? 1 : 0) + (re.test(i18nBlock('id')) ? 1 : 0);
};

console.log('\nthe device keeps the code as a FACT, not as a moment');
ok(/export function pairCode\(\)/.test(sync), 'anything can ask for the code at any time');
ok(/if \(r\.pair_code\) s\.pairCode = String\(r\.pair_code\);/.test(sync),
   '⚠ a claim WITHOUT a code never blanks one we hold — an older or mid-deploy worker would otherwise take the number off this screen while the panel still shows it');
ok(/s\.status = 'approved'; s\.pairCode = '';/.test(sync),
   '⚠ and it dies exactly when the pairing does — the poll seeing approval is the one honest moment to retire it');

console.log('\nthe code is on screen for as long as the pairing is unfinished');
ok(/function refreshPairBanner\(\)/.test(app), 'there is a standing banner, not a toast');
ok(!/toast\.linkedFp/.test(app),
   '⚠ THE TOAST THAT CARRIED THE ONLY COPY OF THE CODE IS GONE — this is the bug, in one line');
ok(/position: fixed/.test(css.slice(css.indexOf('.pair-banner {'))),
   'it is fixed, so wandering to another view does not lose it');
ok((app.match(/refreshPairBanner\(\)/g) || []).length >= 4,
   'painted on accept, on every sync status, and on load — a reload mid-pairing still shows it');
ok(/onStatus: \(kind\) => \{[\s\S]{0,400}?refreshPairBanner\(\);/.test(app),
   '...and EVERY status repaints it, so no unforeseen path can leave it stranded');
ok(/if \(kind === 'linked'\) toast\(t\('toast\.linked'\)/.test(app),
   '⚠ and the SUCCESSFUL end of a pairing still says so — dropping the accept-time toast left the banner just vanishing, which reads as failure');

console.log('\nthe device no longer shows who the researcher is');
ok(!/invite-avatar/.test(app) && !/invite\.unknownName/.test(app),
   '⚠ no face and no name on the consent screen — a device that leaves the team should not carry them');
ok(!/r\.email \? `<div class="note">/.test(app), '...nor the email address');
ok(/const code = Sync\.pairCode\(\);/.test(app), 'the code is what the consent screen shows instead');
ok(/function showInviteConsent\(\) \{/.test(app),
   '...and the function no longer even TAKES a researcher — nothing can drift back into showing one');
/* ⚠ TAKING IT OFF THE SCREEN WAS HALF THE JOB (Seth, 2026-08-20: "we do want the researcher's
 * identity not to be advertised in the pairing process… EXACTLY the same for anything that needs to
 * be paired"). The device also used to WRITE it to localStorage, where it sat for the life of the
 * install — on precisely the devices that might later leave the team's control. */
ok(!/s\.researcher = r\.researcher/.test(sync),
   '⚠ the device does not STORE the researcher identity at all');
ok(!/researcher: s\.researcher/.test(sync),
   '...and does not hand it back out to callers either');
ok(/if \(s0 && s0\.researcher\) \{ delete s0\.researcher; saveSession\(s0\); \}/.test(sync),
   '⚠ and a device paired BEFORE this build is scrubbed at startup — not storing it from now on does nothing for those');
/* The sentinel moved with the decision: the device half is no longer "the worker still sends it, we
 * ignore it" but "the worker stopped sending it, and we ignore it regardless". Both halves matter —
 * the scrub is what covers a worker that predates the change or is mid-deploy, which is the only
 * window in which the field can still arrive. */
ok(/the worker no longer sends r\.researcher at all/.test(sync) && /delete s0\.researcher/.test(sync),
   'the client drops it on the floor ANYWAY — an older worker, or one mid-deploy, still sends it');
ok(/invite\.codeMissing/.test(app),
   '...and it SAYS SO when there is no code, rather than rendering an empty box');

console.log('\nthe panel leads with the same number');
ok(/rp-pair-code/.test(panel) && /panel\.inst\.codeHint/.test(panel), 'the code is the headline on a pending install');
ok(/const pc = ins\.pair_code \|\| '';/.test(panel), 'read from the worker payload, not recomputed');
/* ⚠ THE ENUMERATED-REBUILD TRAP, WHICH CAUGHT THIS CHANGE TOO. researcher.js rebuilds each install
 * field by field, so a field the worker adds is INVISIBLE to the panel until it is named there. Its
 * own comment records `estate` being lost this way, then mintInvite losing the same field again —
 * and pair_code made three. Every pending install rendered "linked by an older app version and
 * shows no pairing code" however new it was, which would have blocked the whole test drive. */
ok(/pair_code: ins\.pair_code \|\| ''/.test(researcher),
   '⚠ pair_code is COPIED THROUGH the enumerated install rebuild — the worker sending it is not enough');
ok(/panel\.inst\.codeLegacy/.test(panel),
   '⚠ an install claimed before this shipped has NO code, and the card says so rather than showing a blank');
ok(/panel\.inst\.fingerprint/.test(panel),
   '⚠ the fingerprint is DEMOTED, not deleted — six digits is ~20 bits and the full compare must stay available');
ok(/split\(''\)\.join\(' '\)/.test(panel) && /split\(''\)\.join\(' '\)/.test(app),
   'both ends space the digits for the screen reader — "420349" is read as a number nobody can compare');
ok(/tabular-nums/.test(css) && /letter-spacing/.test(css.slice(css.indexOf('.pair-code'))),
   'and both render identically, so a mismatch is obvious rather than a squint');

console.log('\nevery new string is translated');
for (const k of ['invite.codeIntro', 'invite.codeMissing', 'invite.codeAria', 'pair.title', 'pair.note',
                 'panel.inst.codeAria', 'panel.inst.codeHint', 'panel.inst.codeLegacy'])
  ok(inEnAndId(k) === 2, `${k} in BOTH languages`);

/* ── THE RESEARCHER'S Ki MUST BE EXTRACTABLE, THE INSTALL'S MUST NOT ────────────────────────────
 * Found in the field, 2026-08-20: "Approve & send key" died with "Failed to execute 'exportKey' on
 * 'SubtleCrypto': key is not extractable". getKi's grant path called the INSTALL's unwrap helper,
 * which imports Ki non-extractable — correct for a device that only ever encrypts its own reports,
 * fatal for a researcher whose job includes re-wrapping Ki to each new install's public key.
 *
 * ⚠ IT WAS DORMANT FROM v434 AND ARMED BY A FIX. While member_key was empty, getKi always fell
 * through to the legacy Kr-wrapped copy, which importKeyB64 makes extractable. Making the self-grant
 * finally write its rows is what routed every lookup down the broken path. A latent bug whose
 * trigger is another bug being fixed is worth a test of its own. */
console.log('\nthe researcher can still re-wrap Ki after resolving it from a grant');
ok(/export async function unwrapGrantForResearcher/.test(cryptojs),
   'the researcher has its OWN unwrap, separate from the install\'s');
{
  const fn = cryptojs.match(/export async function unwrapGrantForResearcher[\s\S]*?\n\}/)[0];
  ok(/\{ name: 'AES-GCM' \}, true,/.test(fn), '⚠ ...and it imports Ki EXTRACTABLE, or approval cannot wrap it');
}
{
  const fn = cryptojs.match(/export async function unwrapKeyFromResearcher[\s\S]*?\n\}/)[0];
  ok(/\{ name: 'AES-GCM' \}, false,/.test(fn),
     '⚠ while the INSTALL\'s stays non-extractable — the device key must never become exportable');
}
ok(/unwrapGrantForResearcher\(myPriv, wrapped\)/.test(researcher),
   'getKi\'s grant path uses the researcher\'s helper');
ok(!/unwrapKeyFromResearcher/.test(researcher),
   '...and no longer reaches for the install\'s at all');
ok(/unwrapKeyFromResearcher/.test(read('../docs/js/sync.js')),
   'the install still uses its own, so this fix did not weaken the device side');

/* ── A DEVICE MUST KNOW ITS OWN NAME (Seth, 2026-08-20) ─────────────────────────────────────────
 * > "we also need a way to be 100% sure that the device we're using DOES in fact match the device
 * >  listed in the tile."
 *
 * ⚠ THE COST OF NOT HAVING IT, recorded because it was nearly a false emergency. An editor showing
 * an empty text list was taken for a device whose texts had been destroyed by unpairing; it was a
 * different browser profile that had never held them. IndexedDB is per-origin and the doc store is
 * not session-scoped, so the two are indistinguishable from the outside — and the panel names
 * devices while the device was never told its name. */
console.log('\nthe device is told the name its researcher gave it');
/* ⚠⚠ THESE USED TO PIN THE SOURCE TEXT `nickname: inst.nickname`, and they PASSED FOR THE ENTIRE
 * TIME THE FEATURE WAS BROKEN — the string was on both branches while the desired-lane SELECT omitted
 * the `nickname` column, so the value sent was always ''. A source-text assertion cannot tell "the
 * code says it" from "the code does it". The REAL check is in test/worker-device-compat.probe.mjs,
 * against a real worker. What is left here is the half a static read can honestly establish: that the
 * column is SELECTED and that it is SENT on each branch — the exact pairing that was broken.
 * ⚠ Matched on the two RESPONSE SHAPES, not on a COUNT of the string anywhere in the file: a count
 * breaks when a comment mentions the field, and an assertion a prose edit can fail is one people
 * learn to "fix" without reading. */
ok(/SELECT desired_blob, desired_rev, type, revoked, researcher_id, nickname FROM instance/.test(worker),
   '⚠ the desired-lane SELECT includes the nickname COLUMN — omitting it is what made the value always empty');
ok(/\{ pending: true, type: inst\.type, nickname: inst\.nickname/.test(worker),
   '⚠ ...sent on the PENDING branch — the name is on screen while the pairing code is');
ok(/return j\(\{ type: inst\.type, nickname: inst\.nickname/.test(worker),
   '⚠ ...and on the APPROVED branch, so a later rename reaches the device too');
ok(/export function deviceNickname/.test(sync), 'the device stores and exposes it');
ok(/r\.nickname !== s\.nickname/.test(sync),
   '⚠ and updates on EVERY poll, so a rename in the panel actually reaches the device');
ok(/function refreshDeviceName/.test(app) && /class = 'app-device'/.test(app.replace(/className/g, 'class')),
   'it is rendered beside the app title');
ok(/host\.appendChild\(el\)/.test(app) && !/\.app-title'\)\.textContent/.test(app),
   '⚠ APPENDED, never textContent on .app-title — the editor\'s title holds the logo <img>');
ok(inEnAndId('device.nameAria') === 2, 'and its screen-reader label is in BOTH languages');

console.log(fail ? `\nFAILED (${fail})` : '\nPASSED');
process.exit(fail ? 1 : 0);
