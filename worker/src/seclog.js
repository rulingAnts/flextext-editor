/* Security-event logging + rare-event alerting.
 *
 * WHY: the worker REFUSES attacks well (rate limits, Turnstile, constant-time compares) but until
 * now recorded nothing — a week of brute-forcing would leave no trace beyond the attacker's own
 * failure. These helpers make hostile traffic visible in Workers Logs and email the owner for the
 * handful of events that should essentially never happen.
 *
 * ⚠ PRIVACY: field-worker IPs are never logged raw. `ipHash` keys the IP with SERVER_HMAC_KEY, so
 * distinct sources can be counted ("one attacker hammering" vs "my researchers working") without
 * recording anyone's location. Without the key an IPv4 sha256 is enumerable offline, so the keyed
 * form is the point, not a nicety. Country (request.cf) is kept — same coarseness the crowd
 * recorder already stores.
 *
 * ⚠ A LOGGER MUST NEVER BREAK THE APP IT WATCHES. Every function here swallows its own failures;
 * an alert that cannot send or a log that cannot serialize costs the event, never the request.
 *
 * Alerting is GATED ON THE `ALERT_EMAIL` VAR (plus RESEND_API_KEY, already set for password
 * resets). Unset = silent, so this deploys inert and activates the moment the owner sets one var
 * in the dashboard. Only should-never-happen events alert (new researcher account, completed
 * escrow recovery) — threshold-y noise like failed logins goes to logs only, because an alarm
 * that cries wolf gets ignored, which is worse than no alarm.
 */

async function ipHash(env, ip) {
  try {
    const data = new TextEncoder().encode((env.SERVER_HMAC_KEY || '') + '|ip|' + (ip || 'anon'));
    const h = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  } catch { return 'err'; }
}

/** Structured security event -> Workers Logs. Filter the dashboard on `"sec":1`. */
export async function secLog(env, request, event, extra) {
  try {
    const url = new URL(request.url);
    console.log(JSON.stringify({
      sec: 1,
      event,
      method: request.method,
      path: url.pathname,
      iph: await ipHash(env, request.headers.get('CF-Connecting-IP')),
      country: (request.cf && request.cf.country) || '',
      ...(extra || {}),
    }));
  } catch { /* never break the request to log it */ }
}

/* Pass a response through, logging it when it is an auth-shaped refusal. ONE chokepoint instead of
 * a call scattered beside every `return j(...)` in v1.js — the same containment logic as
 * native-audio.js: scattered instrumentation is instrumentation that rots. */
export async function logAuthFailures(env, request, resp) {
  try {
    if (resp && (resp.status === 401 || resp.status === 403 || resp.status === 429)) {
      let error = '';
      // ⚠ ONLY clone a small JSON body. Cloning buffers, so cloning a streamed R2/Drive body to
      // read a field off it would hold the whole object in worker memory — the logger must stay
      // cheaper than the thing it watches. The content-type test is the real guard (every auth
      // refusal in this worker is a tiny j()/json() payload; streamed media is audio/octet-stream).
      // content-length is often ABSENT on a Response built from a string, so 0 means "unknown" and
      // is allowed through — the size test only catches a hypothetical large declared JSON.
      const ct = resp.headers.get('content-type') || '';
      const len = parseInt(resp.headers.get('content-length') || '0', 10);
      if (ct.includes('json') && len <= 4096) {
        try { error = (await resp.clone().json()).error || ''; } catch { /* malformed → status alone */ }
      }
      await secLog(env, request, 'auth_refused', { status: resp.status, error });
    }
  } catch { /* logging must not eat the response */ }
  return resp;
}

/** Email the owner. Inert until ALERT_EMAIL is set. Sent via waitUntil — never blocks a response. */
export function secAlert(env, ctx, request, subject, lines) {
  try {
    if (!env.ALERT_EMAIL || !env.RESEND_API_KEY) return;
    const send = (async () => {
      // ⚠ LOG THE OUTCOME, NOT THE ATTEMPT. This used to log 'alert_sent' BEFORE the fetch and
      // swallow every failure, so a rejected send (unverified `from` domain, bad key, Resend down)
      // left a log line claiming the owner had been told when they had not. A monitoring system
      // that lies about its own delivery is worse than none — you would stop watching the inbox
      // AND believe silence meant safety. So: success and failure are now distinct events, and
      // 'alert_failed' carries Resend's own status + body so the cause is in the log.
      let r;
      try {
        r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({
            from: env.RESET_FROM || 'FlexText <noreply@flextext.app>',
            to: [env.ALERT_EMAIL],
            subject: '[FlexText security] ' + subject,
            html: '<p>' + (lines || []).map(esc).join('</p><p>')
                + '</p><p style="color:#667">Automated alert from the FlexText worker. '
                + 'If this was you, no action is needed.</p>',
          }),
        });
      } catch (e) {
        await secLog(env, request, 'alert_failed', { subject, error: String((e && e.message) || e).slice(0, 120) });
        return;
      }
      if (r.ok) { await secLog(env, request, 'alert_sent', { subject, status: r.status }); return; }
      let detail = '';
      try { detail = (await r.text()).slice(0, 200); } catch { /* body unreadable */ }
      await secLog(env, request, 'alert_failed', { subject, status: r.status, detail });
    })().catch(() => { /* an alert that cannot send costs the alert, not the request */ });
    if (ctx && ctx.waitUntil) ctx.waitUntil(send);
  } catch { /* noop */ }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
