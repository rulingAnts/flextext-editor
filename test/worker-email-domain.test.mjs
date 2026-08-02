/* Domain matching for the pre-approved-signup allowlist is an AUTH BOUNDARY.
 *
 * WHY THIS IS WORTH ITS OWN TEST: this function decides whether a stranger who signs in with Google
 * becomes an approved researcher without anyone clicking anything. The classic bug is a substring or
 * suffix test — `email.endsWith('example.org')` happily approves `attacker@evil-example.org`, and
 * `email.includes('example.org')` approves `example.org@attacker.com`. Both read as obviously correct and
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
  ok(emailDomain('someone@example.org') === 'example.org', 'plain address -> its domain');
  ok(emailDomain('Someone@EXAMPLE.ORG') === 'example.org', 'case is normalized (both sides lowercase)');
  ok(emailDomain('  someone@example.org  ') === 'example.org', 'surrounding whitespace is trimmed');
  ok(emailDomain('a@b.co.uk') === 'b.co.uk', 'multi-label domains are kept whole');
}

console.log('\nthe attacks a substring/suffix test would let through');
{
  ok(!approves('attacker@evil-example.org', 'example.org'), 'evil-example.org does NOT match example.org (suffix bug)');
  ok(!approves('attacker@example.org.evil.com', 'example.org'), 'example.org.evil.com does NOT match example.org');
  ok(!approves('example.org@attacker.com', 'example.org'), 'the domain in the LOCAL PART does not match (substring bug)');
  ok(!approves('attacker@notexample.org', 'example.org'), 'notexample.org does not match example.org');
  ok(!approves('attacker@mail.example.org', 'example.org'), 'a SUBDOMAIN does not match unless listed explicitly');
  ok(approves('someone@mail.example.org', 'mail.example.org'), '...and listing it explicitly does work');
}

console.log('\nthe local part may itself contain @ — split on the LAST one');
{
  ok(emailDomain('"weird@name"@example.org') === 'example.org', 'a quoted local part with @ still yields the real domain');
  ok(!approves('user@example.org@attacker.com', 'example.org'), 'a trailing second domain wins, so this does NOT approve');
  ok(emailDomain('user@example.org@attacker.com') === 'attacker.com', '...it resolves to the real (last) domain');
}

console.log('\nmalformed input yields no domain, and no row can match ""');
{
  for (const bad of ['', null, undefined, 'no-at-sign', '@example.org', 'someone@', 'someone@@', 'someone@localhost',
                     'someone@example', 'someone@.org', 'someone@example.o', 'someone@example org', 'someone@example.org<script>']) {
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
  for (const d of ['example.org', 'example.ac.uk', 'example.net', 'example.edu', 'flextext.app']) {
    ok(!isPublicEmailDomain('someone@' + d), `${d} is NOT blocked (organisational domains still work)`);
  }
  ok(!isPublicEmailDomain('someone@mygmail.com'), 'a lookalike domain is not blocked by accident');
  ok(!isPublicEmailDomain('not-an-email'), 'malformed input is not treated as a public provider');
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
