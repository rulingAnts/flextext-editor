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
ok(/researcher: inst \? \{ name: inst\.display_name/.test(worker),
   '⚠ the researcher profile is still RETURNED — dropping it from the device UI is a client change, and removing it here would break the recorder too');

/* ---------------- the client and panel halves ---------------- */
const app = read('../docs/js/app.js');
const sync = read('../docs/js/sync.js');
const panel = read('../docs/js/researcher-panel.js');
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
ok(/The worker still SENDS r\.researcher/.test(sync),
   'the PROTOCOL is unchanged, so already-deployed editors and recorders keep working');
ok(/invite\.codeMissing/.test(app),
   '...and it SAYS SO when there is no code, rather than rendering an empty box');

console.log('\nthe panel leads with the same number');
ok(/rp-pair-code/.test(panel) && /panel\.inst\.codeHint/.test(panel), 'the code is the headline on a pending install');
ok(/const pc = ins\.pair_code \|\| '';/.test(panel), 'read from the worker payload, not recomputed');
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

console.log(fail ? `\nFAILED (${fail})` : '\nPASSED');
process.exit(fail ? 1 : 0);
