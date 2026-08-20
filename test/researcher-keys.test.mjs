/* PHASE B, CLIENT HALF: the researcher keypair, the self-grant, and the order getKi() resolves in.
 *
 * WHAT THIS IS FOR. Until now a Ki lived in one place — wrapped under Kr in the owner's own
 * settings_blob — which works exactly as long as one researcher owns everything, and is why a second
 * researcher cannot be given a device: there is no way to hand someone a Ki without handing them Kr.
 * Each researcher now has an RSA keypair, and a Ki reaches a person wrapped to THEIR public key.
 *
 * The four properties that make this safe to ship to a live estate, each of which is easy to undo
 * while "simplifying":
 *
 *  1. THE LEGACY PATH IS LAST AND PERMANENT. Migration is client-driven (II.D1), so it completes
 *     whenever each researcher next signs in — and never, for one who does not. That is only
 *     acceptable because the Kr-wrapped store keeps working forever. Deleting it is a separate
 *     decision requiring evidence every account migrated, not a tidy-up.
 *  2. NOTHING HERE BLOCKS OR BREAKS SIGN-IN. Key setup is best-effort and un-awaited: offline, a
 *     500, a browser missing primitives — the researcher still signs in and still opens every device
 *     they own, exactly as yesterday.
 *  3. THE 409 LOSER ADOPTS THE WINNER'S KEYPAIR. Two browsers of one account can publish at the same
 *     moment; the worker's write is conditional so one wins. A loser that kept its own keypair could
 *     not read its own grants — silently, discovered only when a device would not open.
 *  4. THE RESEARCHER'S PRIVATE KEY IS EXTRACTABLE AND AN INSTALL'S IS NOT. That asymmetry is
 *     deliberate: a researcher signs in from several browsers and the only thing that travels is Kr,
 *     so the private key is wrapped under Kr and stored. An install lives on one device and its key
 *     has nowhere legitimate to go. Making them match in either direction breaks something.
 *
 * Run: node test/researcher-keys.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const crypto_ = read('../docs/js/crypto.js');
const res = read('../docs/js/researcher.js');
const worker = read('../worker/src/v1.js');
const fn = (name, src) => {
  const at = src.indexOf(name);
  if (at < 0) return '';
  const nxt = src.indexOf('\n}\n', at);
  return nxt < 0 ? src.slice(at) : src.slice(at, nxt + 3);
};

console.log('\nthe researcher keypair is extractable; an install\'s is not');
{
  const r = fn('export async function generateResearcherKeypair', crypto_);
  const i = fn('export async function generateInstallKeypair', crypto_);
  ok(/\n\s*true, \['encrypt', 'decrypt'\]/.test(r),
     'the RESEARCHER keypair is extractable — its private half is wrapped under Kr and stored');
  ok(/\n\s*false, \['encrypt', 'decrypt'\]/.test(i),
     '⚠ an INSTALL keypair is still non-extractable — it lives on one device and never leaves');
  ok(/pkcs8/.test(fn('export async function exportPrivateKeyB64', crypto_)), 'the private half exports as pkcs8');
  ok(/\['decrypt'\]/.test(fn('export async function importPrivateKeyB64', crypto_)),
     'and imports for DECRYPT only — it unwraps grants, it never wraps them');
}

console.log('\ngetKi resolves memory → my grant → the legacy store, and legacy is LAST');
{
  const g = fn('async function getKi(', res);
  ok(!!g, 'getKi exists');
  const iMem = g.indexOf('kiCache.has');
  /* ⚠ unwrapGrantForResearcher, NOT unwrapKeyFromResearcher. The grant path used the INSTALL's
   * helper, which imports Ki NON-EXTRACTABLE — so a researcher who resolved Ki from a grant could
   * not re-wrap it for a new device, and "Approve & send key" died with "key is not extractable".
   * Dormant since v434 and armed the moment the self-grant started writing rows. */
  const iGrant = g.indexOf('unwrapGrantForResearcher');
  const iLegacy = g.indexOf('settingsCache.wrappedKis');
  ok(iMem >= 0 && iGrant > iMem, 'the grant lookup comes after the memory cache');
  /* ⚠ POSITION IS NOT REACHABILITY. The assertion above passed happily when the grant branch was
   * neutered to `if (false)` — the text was still in the right place, and the migration would have
   * silently never happened while every test stayed green. Pin the condition, not the ordering. */
  ok(/if \(myPriv\) \{[\s\S]{0,400}?loadGrants\(\)/.test(g),
     '⚠ the grant branch is actually REACHABLE — gated on holding the private key, and it loads grants');
  ok(iLegacy > iGrant, '⚠ the LEGACY Kr-wrapped store is the last resort, not the first');
  ok(/no_key_for_instance/.test(g), 'and only then does it give up');
  ok(/catch \{[\s\S]{0,600}?\}\s*\n\s*\}\s*\n\s*\}/.test(g) || /Fall through/.test(g),
     '⚠ a grant that will not unwrap FALLS THROUGH to legacy rather than locking the owner out');
}

console.log('\nkey setup can never take sign-in down with it');
{
  const e = fn('export async function ensureResearcherKeys', res);
  ok(/try \{/.test(e) && /catch \(e\)/.test(e), 'ensureResearcherKeys catches everything it does');
  ok(/console\.warn/.test(e), '...and warns rather than vanishing');
  ok(!/throw/.test(e), 'it never rethrows');
  const b = fn('export async function bootstrap', res);
  ok(/ensureResearcherKeys\(v\)\.catch\(/.test(b),
     '⚠ bootstrap does NOT await it — a 31-device self-grant must not hold the dashboard');
}

console.log('\nthe 409 loser adopts the winner\'s keypair rather than keeping its own');
{
  const k = fn('async function ensureKeypair', res);
  ok(/e\.status !== 409/.test(k), 'it recognises the conditional-write conflict');
  ok(/importPrivateKeyB64\([\s\S]{0,200}?\)/.test(k) && /e\.data\.pubkey/.test(k),
     '⚠ and adopts the pair the winner published, or its own grants would be unreadable');
  ok(/UPDATE researcher SET pubkey=\?, wrapped_privkey=\? WHERE researcher_id=\? AND pubkey IS NULL/.test(worker),
     'the worker write really is conditional, which is what makes exactly one browser win');
}

console.log('\nthe self-grant writes only what is MISSING, and satisfies the wrap-to-owner invariant');
{
  const g = fn('async function selfGrantMissing', res);
  ok(/if \(have\[instanceId\]\) continue;/.test(g),
     '⚠ instances that already have a grant are skipped — not re-granted on every sign-in');
  ok(/researcher_id: me/.test(g), 'the grant names this researcher, who is the owner of their own store');
  ok(/catch \(e\)/.test(g) && /console\.warn/.test(g),
     '⚠ a failed grant is LOGGED, not swallowed — 31 silent failures once looked like "nothing to do"');
  ok(/failed\+\+/.test(g), 'and counted, so the summary says how many');
  ok(/Array\.isArray\(live\)/.test(g),
     'revoked instances are skipped — the legacy store keeps every device ever created');
  ok(/owner_grant_required/.test(worker), 'and the worker still rejects a set without the owner\'s copy');
}

/* ⚠ THE BUG THIS SECTION EXISTS FOR. member_key.project_id is TEXT NOT NULL, and the worker's
 * dual-read branch deliberately produces project_id = null for an instance the backfill has not
 * reached — which was EVERY instance, since projects live as Drive folders and the D1 project table
 * is empty. Binding that null violated the constraint, threw the D1 batch, and 500'd. All 31 grants
 * failed, the client swallowed each one, and the migration looked like it had found nothing to do.
 * The tell was in the database, not the UI: with_keypair 1, member_keys 0. */
console.log('\nthe grant write can survive an instance with no project id');
{
  const at = worker.indexOf("seg[2] === 'keys'");
  const route = worker.slice(at, at + 3000);
  ok(/String\(proj\.project_id \|\| ''\)/.test(route),
     '⚠ project_id is coerced — NULL into a NOT NULL column threw the whole batch');
  ok(/TEXT NOT NULL/.test(read('../worker/migrate-projects.sql').split('member_key')[1] || ''),
     '...and the column really is NOT NULL, which is why the coercion is required rather than tidy');
}

console.log('\nthe legacy store is never deleted by any of this');
{
  ok(!/delete settingsCache\.wrappedKis/.test(res) && !/wrappedKis = \{\}\s*;?\s*\/\/ *clear/.test(res),
     '⚠ nothing removes wrappedKis — it is the fallback the whole migration strategy rests on');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nall good\n');
process.exit(fail ? 1 : 0);
