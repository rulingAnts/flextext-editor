/* THE VISITOR'S ONLY "IN PROGRESS" AND "DONE" SIGNALS ARE OURS — NEVER TURNSTILE'S.
 *
 * WHY THIS TEST EXISTS (Seth, 2026-08-31, watching the staging test): after Kirim, the screen's
 * only animation was Turnstile's own widget — "Verifying…" then a big green "Success!" check. To
 * the non-technical visitor this page exists for, that green check reads as "your recording has
 * been sent", and the natural next move is closing the browser — interrupting the upload that had
 * not started. Three defences, each pinned here:
 *
 *   1. The 'sending' view shows OUR spinner + progress bar from its FIRST FRAME — before the bot
 *      check, before the session opens — sweeping (indeterminate) until a real byte lands.
 *   2. Turnstile renders with appearance: 'interaction-only', so a silent pass paints NOTHING and
 *      a green checkmark that isn't ours never appears. A real challenge still shows.
 *   3. An unconfirmed take expires from IndexedDB after 24 hours (CROWD_PENDING_TTL_MS): shared
 *      and borrowed phones must not hold a stranger's voice indefinitely; the resume window is a
 *      courtesy, not an archive.
 *
 * Source-pin style, like crowd-chunk-policy.test.mjs's wiring checks: these are app-glue facts a
 * unit test cannot execute without a DOM, and a regex that fails loudly beats a behaviour nobody
 * re-tests. Keep the pins narrow — they name the load-bearing tokens only.
 */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

test('crowd sending UI owns the progress signals', () => {
  const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../docs/css/app.css', import.meta.url), 'utf8');

  console.log('\nthe sending view paints our progress before any network happens');
  {
    const m = app.match(/state === 'sending'[^`]*`([\s\S]*?)`;/);
    ok(!!m, "the 'sending' body template exists");
    const body = m ? m[1] : '';
    ok(/crowd-spin/.test(body), 'a spinner is in the first frame');
    ok(/crowd-prog indet/.test(body), 'the bar starts in indeterminate (sweeping) mode');
    // \bhidden> — the old markup was `aria-valuenow="0" hidden>`; the spinner's aria-hidden="true"
    // must not satisfy this pin.
    ok(!/\bhidden>/.test(body), 'the bar is NOT hidden waiting for the first chunk');
  }

  console.log('\nthe sweep ends only when a real byte has moved');
  {
    ok(/if \(sent > 0\) wrap\.classList\.remove\('indet'\)/.test(app),
       'crowdSetProgress drops indet only for sent > 0 — a 0% determinate bar reads as a hang');
    ok(/crowd-status-txt/.test(app),
       'progress text updates its own span, not the node holding the spinner');
    ok(/\.crowd-prog\.indet > span/.test(css) && /crowd-sweep/.test(css),
       'the indeterminate sweep animation exists in CSS');
  }

  console.log('\nTurnstile is tucked, disclosed, and can NEVER strand an invisible challenge');
  {
    // Final design (Seth, 2026-08-31): widget invisible by default (its Success flash is not our
    // completion signal), a "Protected by Cloudflare" note disclosing it on hover/tap, and a real
    // interactive challenge force-revealing itself.
    ok(/#crowd-turnstile\.tucked \{ opacity: 0; pointer-events: none; \}/.test(css),
       'the tucked host is opacity 0 — never display:none, the widget must keep executing');
    ok(/'before-interactive-callback': \(\) => crowdTurnstileReveal\(true\)/.test(app),
       'an interactive challenge force-reveals itself — the visitor can never be stuck on an invisible one');
    ok(/if \(host\.dataset\.forced\) return/.test(app),
       'a forced (interactive) reveal refuses to tuck until the token settles');
    const m = app.match(/state === 'sending'[^`]*`([\s\S]*?)`;/);
    ok(!!m && /crowd-cf-note/.test(m[1]) && /crowd\.protectedBy/.test(m[1]),
       'the sending view carries the "Protected by Cloudflare" disclosure note');
  }

  console.log('\nan unconfirmed take expires after 24 hours');
  {
    ok(/CROWD_PENDING_TTL_MS = 24 \* 60 \* 60 \* 1000/.test(app), 'the TTL is 24 hours');
    ok(/CROWD_PENDING_TTL_MS\) await crowdDelPending\(item\.id\)/.test(app),
       'crowdFlush deletes expired takes instead of retrying them forever');
  }

  console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
  if (fail) throw new Error(`${fail} check(s) failed`);
});
