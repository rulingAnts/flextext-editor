/* GOOGLE IS THE ONLY WAY IN, AND DRIVE IS NOT OPTIONAL.
 *
 * Two rules, both about the researcher sign-in path, both easy to un-write by accident.
 *
 * 1. THE EMAIL + PASSWORD LANE IS RETIRED (Seth, 2026-08-20). The whole suite keeps its data in the
 *    researcher's own Google Drive, so an account with no Google behind it could sign in and then do
 *    essentially nothing. Verified against production D1 before removal: all seven researcher
 *    accounts are Google (`wrapped_kr` NULL on every row) — the lane had never been used. What is
 *    dangerous about leaving such a thing standing is that it still ACCEPTS CREDENTIALS: it is
 *    reachable by a direct POST whether or not any client offers it a form.
 *
 * 2. DRIVE ACCESS IS ENFORCED AT THE CALLBACK, because Google will not enforce it for us. Granular
 *    consent renders `drive.file` as a CHECKBOX and there is no console setting that makes a scope
 *    required. Untick it and the token exchange still succeeds — and with `access_type=offline` a
 *    refresh token still comes back, so the row we would write looks connected while every Drive
 *    call fails. The two halves that must both hold:
 *      a. a sign-in that would leave an account WITHOUT Drive is refused, not stored;
 *      b. a returning researcher who unticks the box does NOT have their working refresh token
 *         overwritten with the scope-less one — that would disconnect an account that was fine.
 *    (b) is the half a well-meaning simplification removes, because `if (tok.refresh_token)` reads
 *    like a completeness check rather than a hazard.
 *
 * ⚠ And the fallback direction matters: an ABSENT `scope` field must NOT be read as declined. This
 * callback is the one path the local rig cannot exercise and every sign-in goes through it.
 *
 * Run: node test/google-only-auth.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const worker = read('../worker/src/v1.js');
// Comments here describe the very shapes this file forbids, so they must not satisfy the greps.
const code = worker.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

console.log('\nthe password lane is gone, not merely unadvertised');
{
  ok(!/researcher\.wrapped_kr|SET salt=\?/.test(code) && !/wrapped_kr: row\.wrapped_kr/.test(code),
     'no route hands back or rewrites the password-derived key material');
  ok(!/'salt'|"salt"/.test(code.replace(/salt=\?/g, '')) || !/seg\[2\] === 'salt'/.test(code.replace(/seg\.length === 3 && \(seg\[2\] === 'salt'/, '')),
     'the /salt pre-auth lookup is no longer a route of its own');
  for (const dead of ['dummySalt', 'escrowRecover', 'gateResetToken', 'sendResetEmail']) {
    ok(!worker.includes(dead), `${dead} is removed, not left as unreachable crypto`);
  }
  ok(/password_lane_retired/.test(code) && /410/.test(code),
     'the retired paths answer 410 GONE — an old cached engine gets a verdict, not a mystery');
  ok(!/INSERT INTO researcher \(researcher_id, secret_hash, email_sha256, settings_blob, settings_rev, created_at, salt,/.test(code),
     'nothing can still CREATE a password account');
}

console.log('\nsecret_hash and TOTP survive — they are not the password lane');
{
  ok(/ctEq\(hash, row\.secret_hash\)/.test(code),
     'the legacy secret_hash verifier stays: it is the degrade path when session creation throws');
  ok(/async function verifySecondFactor/.test(worker) && /verifySecondFactor\(/.test(code),
     'TOTP stays: it is the step-up factor on remote wipe, which Google researchers use');
}

console.log('\nthe Google callback enforces the Drive scope');
{
  const cb = code.slice(code.indexOf("seg[3] === 'callback'"));
  ok(/tok\.scope/.test(cb), 'it reads what Google says was actually GRANTED, not what we asked for');
  ok(/drive\.file/.test(cb.slice(0, cb.indexOf('driveGranted') + 4000)),
     'and compares against the drive.file scope specifically');
  ok(/gauth_error=drive_required/.test(cb),
     'a sign-in that would leave the account without Drive is bounced back with a reason');
  ok(/if \(tok\.refresh_token && driveGranted\)/.test(cb),
     '⚠ a re-consent that DECLINES Drive must not overwrite a working refresh token');
  ok(/has_drive/.test(cb),
     'the refusal spares an established account: it checks whether Drive is already connected');
}

console.log('\nan unreadable scope degrades, it does not deny');
{
  const cb = code.slice(code.indexOf("seg[3] === 'callback'"));
  ok(/grantedRaw \? grantedRaw\.split\(\/\\s\+\/\)\.includes\(DRIVE_SCOPE\) : true/.test(cb),
     'absent/empty scope is treated as UNVERIFIABLE (allowed), never as declined');
  ok(/oauth_scope_unreadable/.test(cb),
     'and it is logged, so a guard that stopped guarding is visible rather than silent');
}

console.log('\nthe client explains a declined Drive rather than looking broken');
{
  const panel = read('../docs/js/researcher-panel.js');
  const app = read('../docs/js/app.js');
  const i18n = read('../docs/js/i18n.js');
  ok(/gauth_error=\(\[\^&\]\+\)/.test(panel), 'the panel reads the error fragment');
  ok(/panel\.signin\.driveRequired/.test(panel), 'and shows a message about Drive, not "session expired"');
  ok(/gauth\(_error\)\?=/.test(app),
     '⚠ app.js preserves the error fragment through boot — the old /gauth=/ regex silently ate it');
  ok((i18n.match(/'panel\.signin\.driveRequired'/g) || []).length === 2,
     'the string exists in both languages');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nall good\n');
process.exit(fail ? 1 : 0);
