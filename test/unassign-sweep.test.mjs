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

/* ⚠⚠ THE FIRST-RUN CASE — the bug that made this entire feature inert on every real estate.
 *
 * The first version guarded on `estate.unassignedFolderId`, reasoning "do not sweep if there is
 * nowhere to sweep to". That is exactly backwards: driveUnassignedFolder() CREATES the folder on
 * demand, so the destination is made by the very call the guard suppressed. No folder ⇒ no call ⇒
 * no folder, permanently, on every estate that has never had one — which was all of them.
 *
 * It shipped in v399 and did nothing. It was found only because a Drive SNAPSHOT showed zero
 * folders tagged `unassigned` and the text Seth had reported still sitting in its device folder —
 * i.e. by looking at the data, not by reading the code, which had looked fine twice. */
console.log('\nit works on a FIRST RUN, when no Unassigned folder exists yet');
{
  const fn = panel.slice(panel.indexOf('function sweepUnassigned'), panel.indexOf('function assignedDocIds'));
  /* Strip comments before asserting on CODE. The first version of this check matched the very
   * comment warning against the bug — a guard tripped by its own documentation. Assert the specific
   * thing: the identifier must not appear in an executable line. */
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/estate\.unassignedFolderId/.test(code),
     'the sweep does NOT require an existing Unassigned folder — the route creates it');
  ok(/if \(!estate \|\| !Array\.isArray\(estate\.texts\)\) return;/.test(fn),
     '...it guards only on having an estate with texts to consider');
  /* Keep the reasoning next to the code, because the wrong version is the one that reads as
   * careful. A reviewer who has not seen the deadlock will want to add the check back. */
  ok(/DO NOT RE-ADD/.test(fn), 'and the trap is documented where the next reader will be tempted');
}

console.log('\nthe three exclusions — the safety, and the reason a move survives it');
{
  const fn = panel.slice(panel.indexOf('function sweepUnassigned'), panel.indexOf('function assignedDocIds'));
  for (const [needle, why] of [
    ['assigned.has', 'a text a device still reports is never swept'],
    ['pendingMoves.has', 'a text mid-MOVE is never swept — its folder is receiving an upload'],
    ['inFlight.has', 'a text mid-ASSIGNMENT is never swept, for the same reason'],
  ]) ok(fn.includes(needle), why);
  /* ⚠ THE FOURTH EXCLUSION, added after production data showed the sweep emptying a crowd folder.
   * "No device holds it" is permanently true of a crowd submission — it was never on a device — so
   * without this the sweep strips every crowd folder into Unassigned and keeps doing it, undoing
   * v396. Self-correcting by construction: fromCrowd is computed from where the folder actually
   * sits, so a crowd text moved onto a device sweeps normally if that device later drops it. */
  ok(fn.includes('!tx.fromCrowd'),
     'a CROWD-born text is never swept — it is held by its recorder, not unassigned');
  ok(/slice\(0, UNASSIGN_BATCH\)/.test(fn), 'the client batches too, rather than trusting the server to truncate');
  ok(/\.catch\(\(\) =>/.test(fn), 'fire-and-forget: an organisational sweep never delays or breaks a render');
  ok(/try \{[\s\S]*\} catch \{/.test(fn), '...and it is wrapped, like every other observer in this panel');
}

/* ⚠ THE SAME PREDICATE, A SECOND PLACE. The sweep MOVES texts; the Unassigned card LISTS them and
 * offers "Remove from Google Drive". Both were written as "no device reports it", which is
 * permanently true of a crowd submission — so a recorder could fill the researcher's set-aside pile
 * without limit with things they never set aside (plan §16.24/§16.25). Fixing one and not the other
 * is exactly the drift this file exists to prevent. */
console.log('\nthe Unassigned CARD excludes crowd texts too — not just the sweep');
{
  const fn = panel.slice(panel.indexOf('function unassignedTexts'), panel.indexOf('function crowdTexts'));
  ok(/!tx\.fromCrowd/.test(fn), 'unassignedTexts excludes crowd-born texts');
  /* And they must be visible SOMEWHERE, or excluding them just hides them: a recorder is a container
   * of texts exactly as a device is (§16.9). */
  ok(/function crowdTexts\(estate, rec\)/.test(panel), 'a recorder can enumerate its own texts');
  ok(/tx\.deviceFolderId === folder/.test(panel),
     '...linked by oauth_folder_id, which crowdList already returns — no worker change needed');
  ok(/function crowdTextRows\(rec, estate\)/.test(panel), 'and the crowd row renders them');
  /* §16.9: crowd is a SOURCE. A text can be assigned onward or removed, but nothing is ever assigned
   * INTO a recorder — there must be no affordance here that sends a text to one. */
  const rows = panel.slice(panel.indexOf('function crowdTextRows'), panel.indexOf('function renderCrowdCard'));
  const rowCode = rows.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(/data-uact="drop"/.test(rowCode), 'a recording can be removed');
  /* ⚠ NO "Move…". v408 offered one and it could not have worked: /adopt delivers a text by
   * extracting a .flextext from the source zip, and a crowd zip has none — so the move fails
   * `no_flextext_in_zip` after appearing to start. An affordance that cannot work is worse than
   * none. Until crowd uploads individual files (§16.10 B), download-and-re-upload is the honest
   * route, and the note says so where the button would have been. */
  ok(!/data-uact="adopt"/.test(rowCode),
     'and NOT assigned onward — /adopt cannot deliver a crowd zip, so the button must not exist');
  ok(/panel\.crowd\.assignNote/.test(rowCode),
     '...with a note explaining download-and-re-upload instead of a dead button');
  ok(!/assignTo|data-uact="assign"/.test(rowCode), 'and nothing that would assign a text INTO a recorder');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
