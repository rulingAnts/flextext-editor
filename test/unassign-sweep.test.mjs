/* THE UNASSIGNED SWEEP — the wiring that makes Drive stop contradicting the panel.
 *
 * WHY THIS TEST EXISTS. The worker route was complete, idempotent and CALLED BY NOTHING for months
 * (plans/drive-as-truth.md §7). Two things about that are worth pinning so they cannot regress:
 *
 *   1. The route accepted 200 docIds and spent up to THREE Drive subrequests on each — ~600 against
 *      a ~50 ceiling. A full batch could never have completed; it would have died mid-sweep with
 *      some folders moved and some not, and no way for the caller to know which. It had never bitten
 *      only because nothing called it. WIRING A CALLER UP IS EXACTLY WHAT WOULD HAVE FOUND IT, in
 *      production, on a researcher's real estate.
 *   2. The sweep must be driven from the ESTATE, not from diffInventory's present→absent event. That
 *      event fires once, so anything skipped in that instant is skipped for ever — and a text
 *      dropped by device A during an in-flight move to B is skipped correctly, then never revisited
 *      if the move fails.
 *
 * Run: node test/unassign-sweep.test.mjs
 */
import { readFileSync } from 'node:fs';
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const worker = readFileSync(new URL('../worker/src/v1.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const rjs = readFileSync(new URL('../docs/js/researcher.js', import.meta.url), 'utf8');

console.log('\nthe route is bounded below the Drive subrequest cap');
{
  const route = worker.slice(worker.indexOf("seg[2] === 'drive-unassign'"));
  const body = route.slice(0, route.indexOf('\n  }\n'));
  const cap = /const CAP = (\d+), BUDGET_MS/.exec(body);
  ok(!!cap, 'the sweep declares a CAP');
  /* THREE subrequests per id (tag search + re-parent PATCH + tag PATCH), plus the access token and
   * the Unassigned-folder resolve. The arithmetic is the assertion — a future edit that raises CAP
   * without redoing it is the bug this catches. */
  if (cap) {
    const n = parseInt(cap[1], 10);
    ok(n * 3 + 2 < 50, `CAP=${n} → ${n * 3 + 2} subrequests, clear of the ~50 ceiling`);
    ok(n < 200, '...and far below the 200 the route used to accept');
  }
  ok(/remainingIds/.test(body) && /remaining:/.test(body),
     'it reports what it did NOT do, so a caller can drain the rest');
  /* `remaining` is a COUNT, matching drive-purge and the trash route. An empty ARRAY is truthy, so a
   * caller looping on `if (!r.remaining) break;` would spin for ever if this became a list. */
  ok(/remaining: remainingIds\.length/.test(body), '...as a COUNT, not an array — an empty array is truthy');
  ok(/includes\(target\)\) continue/.test(body), 'and it stays idempotent, so re-sending an id is free');
}

console.log('\nthe sweep is driven from the ESTATE, and is therefore self-healing');
{
  ok(/export function driveUnassign\(/.test(rjs), 'the client wrapper exists at last');
  ok(/function sweepUnassigned\(estate\)/.test(panel), 'the panel derives the work from the estate');
  ok(/sweepUnassigned\(estateCache\)/.test(panel), '...and runs it where the estate is loaded');
  /* THE ANTI-PATTERN THIS REPLACES: sweeping from the one-shot present→absent event. If the sweep
   * ever moves into observeView's result, a skip becomes permanent. */
  ok(!/observeView\([^)]*\)[\s\S]{0,200}driveUnassign/.test(panel),
     'it is NOT hung off the one-shot present→absent event, where a skip would be permanent');
  ok(/!tx\.inUnassigned/.test(panel), 'it asks Drive where the folder actually is, not where we assume');
}

console.log('\nthe three exclusions — the safety, and the reason a move survives it');
{
  const fn = panel.slice(panel.indexOf('function sweepUnassigned'), panel.indexOf('function assignedDocIds'));
  for (const [needle, why] of [
    ['assigned.has', 'a text a device still reports is never swept'],
    ['pendingMoves.has', 'a text mid-MOVE is never swept — its folder is receiving an upload'],
    ['inFlight.has', 'a text mid-ASSIGNMENT is never swept, for the same reason'],
  ]) ok(fn.includes(needle), why);
  ok(/slice\(0, UNASSIGN_BATCH\)/.test(fn), 'the client batches too, rather than trusting the server to truncate');
  ok(/\.catch\(\(\) =>/.test(fn), 'fire-and-forget: an organisational sweep never delays or breaks a render');
  ok(/try \{[\s\S]*\} catch \{/.test(fn), '...and it is wrapped, like every other observer in this panel');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
