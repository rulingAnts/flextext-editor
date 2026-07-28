/* Domain matching for the pre-approved-signup allowlist is an AUTH BOUNDARY.
 *
 * WHY THIS IS WORTH ITS OWN TEST: this function decides whether a stranger who signs in with Google
 * becomes an approved researcher without anyone clicking anything. The classic bug is a substring or
 * suffix test — `email.endsWith('sil.org')` happily approves `attacker@evil-sil.org`, and
 * `email.includes('sil.org')` approves `sil.org@attacker.com`. Both read as obviously correct and
 * both hand out accounts.
 *
 * The failure DIRECTION: refusing a legitimate address costs one manual approval click. Accepting a
 * hostile one grants access to the researcher console, where Kr and the account secret live.
 *
 * Run: node test/worker-email-domain.test.mjs
 */
import { emailDomain, isPublicEmailDomain } from '../worker/src/v1.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

// The worker compares emailDomain(email) for EQUALITY against a row in approved_domain.
const approves = (email, listed) => emailDomain(email) === listed;

console.log('\nthe ordinary case');
{
  ok(emailDomain('seth@sil.org') === 'sil.org', 'plain address -> its domain');
  ok(emailDomain('Seth.Johnston@SIL.ORG') === 'sil.org', 'case is normalized (both sides lowercase)');
  ok(emailDomain('  seth@sil.org  ') === 'sil.org', 'surrounding whitespace is trimmed');
  ok(emailDomain('a@b.co.uk') === 'b.co.uk', 'multi-label domains are kept whole');
}

console.log('\nthe attacks a substring/suffix test would let through');
{
  ok(!approves('attacker@evil-sil.org', 'sil.org'), 'evil-sil.org does NOT match sil.org (suffix bug)');
  ok(!approves('attacker@sil.org.evil.com', 'sil.org'), 'sil.org.evil.com does NOT match sil.org');
  ok(!approves('sil.org@attacker.com', 'sil.org'), 'the domain in the LOCAL PART does not match (substring bug)');
  ok(!approves('attacker@notsil.org', 'sil.org'), 'notsil.org does not match sil.org');
  ok(!approves('attacker@mail.sil.org', 'sil.org'), 'a SUBDOMAIN does not match unless listed explicitly');
  ok(approves('someone@mail.sil.org', 'mail.sil.org'), '...and listing it explicitly does work');
}

console.log('\nthe local part may itself contain @ — split on the LAST one');
{
  ok(emailDomain('"weird@name"@sil.org') === 'sil.org', 'a quoted local part with @ still yields the real domain');
  ok(!approves('user@sil.org@attacker.com', 'sil.org'), 'a trailing second domain wins, so this does NOT approve');
  ok(emailDomain('user@sil.org@attacker.com') === 'attacker.com', '...it resolves to the real (last) domain');
}

console.log('\nmalformed input yields no domain, and no row can match ""');
{
  for (const bad of ['', null, undefined, 'no-at-sign', '@sil.org', 'seth@', 'seth@@', 'seth@localhost',
                     'seth@sil', 'seth@.org', 'seth@sil.o', 'seth@sil org', 'seth@sil.org<script>']) {
    ok(emailDomain(bad) === '', `${JSON.stringify(bad)} -> '' (never matchable)`);
  }
}

console.log('\na PUBLIC provider can never be auto-approved, however it got into the table');
{
  // The catastrophic misconfiguration: one INSERT of 'gmail.com' would auto-approve anyone on
  // earth who can open a free mailbox. It is a TEMPTING mistake — a real researcher on this
  // deployment already signs in with a gmail address — so it is refused in code, not just docs.
  for (const d of ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com',
                   'yahoo.co.id', 'icloud.com', 'proton.me', 'protonmail.com', 'mail.ru', 'qq.com']) {
    ok(isPublicEmailDomain('anyone@' + d), `${d} is refused as a free-mailbox provider`);
  }
  ok(isPublicEmailDomain('ANYONE@GMAIL.COM'), 'the refusal is case-insensitive');
  // ...but real organisational domains must still work, including the ones actually in use here.
  for (const d of ['sil.org', 'canil.ca', 'tsco.org', 'wycliffe.org', 'flextext.app']) {
    ok(!isPublicEmailDomain('someone@' + d), `${d} is NOT blocked (organisational domains still work)`);
  }
  ok(!isPublicEmailDomain('someone@mygmail.com'), 'a lookalike domain is not blocked by accident');
  ok(!isPublicEmailDomain('not-an-email'), 'malformed input is not treated as a public provider');
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
