/* THE RIG GUARD — why `worker-projects` and `worker-sessions` no longer simply fail.
 *
 * Both suites are rig tests: they need `wrangler dev` on :8787 (bash test/local-rig.sh). A plain
 * `node --test "test/*.test.mjs"` boots no worker, so they cannot run at all.
 *
 * ⚠ WHAT THIS EXISTS TO PREVENT (2026-09-08). They used to fail outright, and DEVELOPERS.md told you
 * to count the two `not ok` lines and carry on. That made two very different things print the same
 * result: "there is no worker" and "the seed is broken" were both the expected pair. One of them had
 * really gone wrong — the local D1 was stale by four `instance` columns, so every seed died on
 * `no such column: create_key` before a single request was made, and six releases read that as
 * business as usual. A gate that cannot tell absence from breakage is not a gate.
 *
 * So the rule here is narrow and deliberate: NOTHING LISTENING ⇒ an explicit skip and exit 0.
 * Anything else — a seed that throws, a schema that will not apply, a worker answering wrongly —
 * stays a real failure, which is the whole point.
 *
 * The trade this makes: with no rig, these suites now report green instead of red. That is only
 * honest because the skip line says so on both stdout and stderr, and because the rig is required
 * before a deploy anyway (plans/BACKLOG.md: "Local rig green BEFORE any deploy talk"). Read the
 * skip as "not tested", never as "tested and fine". */

/* Refused, reset, or unreachable all mean the same thing to us: nobody is home. */
const ABSENT = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL']);

function absentCode(err) {
  for (let e = err; e; e = e.cause) if (e && e.code && ABSENT.has(e.code)) return e.code;
  return null;
}

/* Returns when a worker is listening. Otherwise prints the skip and exits 0 without returning.
 *
 * Probes an UNAUTHENTICATED route on purpose: any HTTP answer at all — 200, 401, 404 — settles the
 * only question being asked, which is whether a worker exists. A timeout is NOT absence (something
 * is there and hanging), so it is rethrown as the real failure it is. */
export async function requireRig(base, label) {
  try {
    await fetch(base + '/v1/researcher', { signal: AbortSignal.timeout(5000) });
    return;
  } catch (err) {
    const code = absentCode(err);
    if (!code) throw err;
    const msg = `SKIP ${label}: no worker on ${base} (${code}) — run: bash test/local-rig.sh`;
    console.log(`\n# ${msg}`);
    console.error(msg);
    process.exit(0);
  }
}
