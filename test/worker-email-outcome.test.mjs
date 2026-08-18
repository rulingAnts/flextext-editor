/* Every email the worker sends must LOG WHETHER IT ARRIVED — and there must be exactly one place
 * that sends.
 *
 * WHY THIS TEST EXISTS. `secAlert` carries a comment earned the hard way: it used to log
 * 'alert_sent' BEFORE the fetch and swallow failures, so a rejected send left a log line claiming
 * the operator had been told when they had not — "a monitoring system that lies about its own
 * delivery is worse than none". That fix was applied to ONE of the two copies of the Resend call.
 * The other, `sendResetEmail`, kept returning a boolean its caller discarded, so a rejected
 * password-reset email produced no log line at all while the endpoint still answered "if that
 * account exists, we sent a link".
 *
 * The failure this guards is not hypothetical for THIS project: a Resend domain that is not verified
 * for third-party recipients rejects with a 4xx, which is exactly how the planned sign-in notice
 * would fail — silently, if the outcome were not logged, and silence from a security notice reads as
 * safety. So: assert the outcome is logged, in both directions, with Resend's own status.
 *
 * Run: node test/worker-email-outcome.test.mjs
 */

import { sendEmail, secAlert } from '../worker/src/seclog.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const REQ = {
  url: 'https://worker.test/v1/researcher',
  method: 'POST',
  headers: { get: () => null },
  cf: { country: 'ID' },
};
const ENV = { RESEND_API_KEY: 'test-key', SERVER_HMAC_KEY: 'test-hmac', RESET_FROM: 'FlexText <noreply@flextext.app>' };

/* secLog writes structured JSON to stdout; capture it so the assertions read real log events. */
function capture(fn) {
  const lines = [];
  const real = console.log;
  console.log = (s) => { lines.push(String(s)); };
  return Promise.resolve(fn()).finally(() => { console.log = real; }).then((r) => ({ result: r, lines }));
}
const events = (lines) => lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean).filter((e) => e.sec === 1);

const withFetch = (impl, fn) => { const real = globalThis.fetch; globalThis.fetch = impl; 
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = real; }); };

console.log('one sender, and it always logs the outcome\n');

/* ---- 1. no API key: inert, and NOT reported as sent ---- */
{
  let called = 0;
  const { result, lines } = await withFetch(async () => { called++; return { ok: true, status: 200 }; },
    () => capture(() => sendEmail({}, REQ, { to: 'a@b.test', subject: 's', html: 'h', event: 'signin_notice' })));
  ok(result === false, 'with no RESEND_API_KEY it returns false');
  ok(called === 0, 'with no RESEND_API_KEY nothing is sent');
  ok(events(lines).length === 0, 'and nothing is logged as sent');
}

/* ---- 2. accepted: true, and a *_sent event carrying the status ---- */
{
  const { result, lines } = await withFetch(async () => ({ ok: true, status: 200 }),
    () => capture(() => sendEmail(ENV, REQ, { to: 'a@b.test', subject: 's', html: 'h', event: 'signin_notice' })));
  const ev = events(lines);
  ok(result === true, 'a 2xx returns true');
  ok(ev.length === 1 && ev[0].event === 'signin_notice_sent', `logs signin_notice_sent (got ${ev[0] && ev[0].event})`);
  ok(ev[0] && ev[0].status === 200, 'the sent event carries the status');
}

/* ---- 3. REJECTED — the case that actually matters here: an unverified sending domain ---- */
{
  const body = '{"statusCode":403,"message":"The flextext.app domain is not verified"}';
  const { result, lines } = await withFetch(
    async () => ({ ok: false, status: 403, text: async () => body }),
    () => capture(() => sendEmail(ENV, REQ, { to: 'stranger@example.test', subject: 's', html: 'h', event: 'signin_notice' })));
  const ev = events(lines);
  ok(result === false, 'a 4xx returns false rather than a cheerful true');
  ok(ev.length === 1 && ev[0].event === 'signin_notice_failed', `logs signin_notice_failed (got ${ev[0] && ev[0].event})`);
  ok(ev[0] && ev[0].status === 403, 'the failure carries Resend\'s status');
  ok(ev[0] && /not verified/.test(ev[0].detail || ''),
     'the failure carries Resend\'s own message, so the CAUSE is in the log — not just "mail failed"');
}

/* ---- 4. network throw: still logged, still no exception escaping ---- */
{
  const { result, lines } = await withFetch(async () => { throw new Error('connect ECONNREFUSED'); },
    () => capture(() => sendEmail(ENV, REQ, { to: 'a@b.test', subject: 's', html: 'h', event: 'reset_email' })));
  const ev = events(lines);
  ok(result === false, 'a thrown fetch returns false instead of propagating');
  ok(ev.length === 1 && ev[0].event === 'reset_email_failed', `logs reset_email_failed (got ${ev[0] && ev[0].event})`);
  ok(ev[0] && /ECONNREFUSED/.test(ev[0].error || ''), 'the thrown message is in the log');
}

/* ---- 5. secAlert still behaves exactly as the operator alert did ---- */
{
  let sentTo = null, sentSubject = null;
  const waited = [];
  await withFetch(async (_u, init) => {
    const b = JSON.parse(init.body); sentTo = b.to[0]; sentSubject = b.subject; return { ok: true, status: 200 };
  }, () => capture(async () => {
    secAlert({ ...ENV, ALERT_EMAIL: 'owner@example.test' }, { waitUntil: (p) => waited.push(p) }, REQ,
             'New researcher account', ['line one', 'line two']);
    await Promise.all(waited);
  }));
  ok(waited.length === 1, 'secAlert hands its send to waitUntil, so it never blocks the response');
  ok(sentTo === 'owner@example.test', `secAlert still sends to ALERT_EMAIL (got ${sentTo})`);
  ok(/^\[FlexText security\] /.test(sentSubject || ''), `subject keeps its [FlexText security] prefix (got ${sentSubject})`);
}

/* ---- 6. secAlert is inert without ALERT_EMAIL, and cannot throw ---- */
{
  let called = 0;
  await withFetch(async () => { called++; return { ok: true, status: 200 }; }, () => capture(async () => {
    secAlert(ENV, null, REQ, 'no recipient configured', ['x']);
  }));
  ok(called === 0, 'secAlert is inert until ALERT_EMAIL is set');

  const waited = [];
  await withFetch(async () => { throw new Error('boom'); }, () => capture(async () => {
    secAlert({ ...ENV, ALERT_EMAIL: 'owner@example.test' }, { waitUntil: (p) => waited.push(p) }, REQ, 's', ['x']);
    await Promise.all(waited);
  }));
  ok(true, 'a failing send inside secAlert does not throw — the alert is lost, never the request');
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
