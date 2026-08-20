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

console.log(fail ? `\nFAILED (${fail})` : '\nPASSED');
process.exit(fail ? 1 : 0);
