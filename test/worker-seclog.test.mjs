/* The security logger must never be able to break the worker it watches.
 *
 * WHY THIS IS WORTH A TEST: seclog.js sits in the request path of EVERY /v1/ call and every
 * relay refusal. It is pure instrumentation — it produces no value the user can see — so any
 * bug in it is pure downside: a logger that throws takes down researcher sign-in, device sync,
 * and audio delivery in the field, in exchange for nothing. The failure DIRECTION is the whole
 * point. A lost log line costs a log line; a thrown log line costs the app.
 *
 * The four properties asserted here are the ones that hold that line:
 *   1. it returns the response IDENTICALLY (same object, untouched status/body),
 *   2. it swallows its own failures (a broken console must not surface as a 500),
 *   3. it never buffers a streamed body to read a field off it (memory, on a free-tier worker),
 *   4. alerting is INERT until ALERT_EMAIL is set, so deploying it changes nothing by itself.
 *
 * Run: node test/worker-seclog.test.mjs
 */
import { secLog, logAuthFailures, secAlert } from '../worker/src/seclog.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const env = { SERVER_HMAC_KEY: 'test-key' };
const req = (p = '/v1/researcher') => new Request('https://connect.example' + p, {
  method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.7' },
});
const jsonResp = (obj, status) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json' },
});

/* Capture console.log so we can assert on what was emitted, and restore after. */
function capture(fn) {
  const real = console.log;
  const lines = [];
  console.log = (s) => lines.push(s);
  return Promise.resolve(fn()).then(
    (v) => { console.log = real; return { lines, value: v }; },
    (e) => { console.log = real; throw e; },
  );
}
const events = (lines) => lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } });

console.log('\nthe response passes through untouched (property 1)');
{
  const r = jsonResp({ error: 'unauthorized' }, 401);
  const { value } = await capture(() => logAuthFailures(env, req(), r));
  ok(value === r, 'returns the very same Response object, not a copy');
  ok(value.status === 401, 'status is unchanged');
  ok(await value.json().then((b) => b.error) === 'unauthorized',
     'the body is still readable by the client (the clone did not consume it)');
}

console.log('\nlogs auth-shaped refusals, and only those');
for (const [status, expected] of [[401, true], [403, true], [429, true], [200, false], [404, false], [500, false]]) {
  const { lines } = await capture(() => logAuthFailures(env, req(), jsonResp({ error: 'x' }, status)));
  const got = events(lines).some((e) => e.event === 'auth_refused');
  ok(got === expected, `${status} -> ${expected ? 'logged' : 'not logged'}`);
}

console.log('\nthe event carries what an investigation actually needs');
{
  const { lines } = await capture(() => logAuthFailures(env, req('/v1/instances/abc'), jsonResp({ error: 'bad_secret' }, 403)));
  const e = events(lines).find((x) => x.event === 'auth_refused');
  ok(e && e.sec === 1, 'tagged sec:1 so the dashboard can filter on it');
  ok(e && e.status === 403 && e.error === 'bad_secret', 'status + error code recorded');
  ok(e && e.path === '/v1/instances/abc', 'path recorded');
  ok(e && typeof e.iph === 'string' && e.iph.length === 12, 'a short keyed IP hash is present');
  ok(!JSON.stringify(e).includes('203.0.113.7'), 'the RAW IP appears nowhere in the event');
}

console.log('\nthe IP hash is keyed, not a bare digest (privacy: an IPv4 sha256 is enumerable)');
{
  const one = await capture(() => secLog(env, req(), 'probe'));
  const two = await capture(() => secLog(env, req(), 'probe'));
  const other = await capture(() => secLog({ SERVER_HMAC_KEY: 'DIFFERENT' }, req(), 'probe'));
  const h = (c) => events(c.lines)[0].iph;
  ok(h(one) === h(two), 'same IP + same key -> same hash (so sources can be counted)');
  ok(h(one) !== h(other), 'same IP + different key -> different hash (proves it is keyed)');
}

console.log('\na streamed body is NEVER cloned to read a field off it (property 3)');
{
  let cloned = false;
  const streamed = new Response(new ReadableStream({ start() { /* never resolves */ } }),
    { status: 403, headers: { 'content-type': 'audio/wav' } });
  streamed.clone = () => { cloned = true; throw new Error('should not be reached'); };
  const { lines } = await capture(() => logAuthFailures(env, req('/r2/big.wav'), streamed));
  ok(cloned === false, 'clone() was not called on a non-JSON body');
  ok(events(lines).some((e) => e.event === 'auth_refused'), 'the refusal is still logged, from the status alone');
}

console.log('\nit swallows its own failures (property 2 — the one that protects the app)');
{
  // A console that throws is the stand-in for every way logging can fail at runtime.
  const real = console.log;
  console.log = () => { throw new Error('logging exploded'); };
  let threw = false, out = null;
  try { out = await logAuthFailures(env, req(), jsonResp({ error: 'x' }, 401)); } catch { threw = true; }
  console.log = real;
  ok(threw === false, 'a throwing logger does not propagate out of logAuthFailures');
  ok(out !== null && out.status === 401, 'and the response is still returned to the client');
}
{
  const real = console.log;
  console.log = () => { throw new Error('logging exploded'); };
  let threw = false;
  try { await secLog(env, req(), 'x'); } catch { threw = true; }
  console.log = real;
  ok(threw === false, 'secLog itself never throws');
}
{
  let threw = false;
  try { await logAuthFailures(env, req(), null); } catch { threw = true; }
  ok(threw === false, 'a null response does not crash the wrapper');
}
{
  // The two swallows are INDEPENDENT and must be proved separately. The throwing-console case
  // above is caught by secLog's own catch, so it never reaches logAuthFailures' — this case
  // throws from logAuthFailures' own body (reading .status / .headers off a hostile response),
  // which is the only thing its outer catch exists for. Without this the outer catch could be
  // deleted and every other assertion here would still pass.
  const hostile = { get status() { throw new Error('status exploded'); } };
  let threw = false, out;
  try { out = await logAuthFailures(env, req(), hostile); } catch { threw = true; }
  ok(threw === false, 'a response whose own getters throw does not crash logAuthFailures');
  ok(out === hostile, 'and it is still handed back to the caller');
}

console.log('\nalerting is inert until ALERT_EMAIL is set (property 4 — it deploys silent)');
{
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}'); };
  const scheduled = [];
  const ctx = { waitUntil: (p) => scheduled.push(p) };

  secAlert(env, ctx, req(), 'test', ['line']);
  ok(calls === 0 && scheduled.length === 0, 'no ALERT_EMAIL -> nothing scheduled, nothing sent');

  secAlert({ ...env, ALERT_EMAIL: 'a@b.c' }, ctx, req(), 'test', ['line']);
  ok(scheduled.length === 0, 'ALERT_EMAIL without RESEND_API_KEY -> still inert');

  const full = { ...env, ALERT_EMAIL: 'a@b.c', RESEND_API_KEY: 'k' };
  await capture(async () => { secAlert(full, ctx, req(), 'test', ['line']); await Promise.all(scheduled); });
  ok(calls === 1, 'both vars set -> exactly one send');
  ok(scheduled.length === 1, 'sent via waitUntil, so it never blocks the response');

  // An alert that cannot send must cost the alert, never the request.
  globalThis.fetch = async () => { throw new Error('resend down'); };
  const s2 = [];
  let threw = false;
  try {
    await capture(async () => { secAlert(full, { waitUntil: (p) => s2.push(p) }, req(), 't', ['l']); await Promise.all(s2); });
  } catch { threw = true; }
  ok(threw === false, 'a failing mail provider does not reject the waitUntil promise');

  // A missing ctx is the shape of a call from a code path that has no execution context.
  globalThis.fetch = async () => { calls++; return new Response('{}'); };
  try { secAlert(full, null, req(), 't', ['l']); } catch { threw = true; }
  ok(threw === false, 'a missing ctx does not throw');

  globalThis.fetch = realFetch;
}

console.log('\nHTML in an alert is escaped (the subject/lines carry attacker-supplied email addresses)');
{
  const realFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (_u, o) => { body = JSON.parse(o.body); return new Response('{}'); };
  const s = [];
  const full = { ...env, ALERT_EMAIL: 'a@b.c', RESEND_API_KEY: 'k' };
  await capture(async () => {
    secAlert(full, { waitUntil: (p) => s.push(p) }, req(), 'new account', ['Email: <script>x</script>@e.com']);
    await Promise.all(s);
  });
  globalThis.fetch = realFetch;
  ok(body && !body.html.includes('<script>'), 'a <script> in a signup email does not reach the owner as markup');
  ok(body && body.html.includes('&lt;script&gt;'), 'it is escaped, not silently dropped');
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
