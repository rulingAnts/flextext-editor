/* EVERY OWNERSHIP WRITE IN THE WORKER MUST BE SCOPED, INCLUDING INSIDE A BATCH.
 *
 * WHY THIS EXISTS. `POST /v1/instances/<id>/revoke` was a two-statement D1 batch in which only the
 * FIRST statement carried `AND researcher_id=?`:
 *
 *     UPDATE instance SET revoked=1 WHERE instance_id=? AND researcher_id=?     <- scoped
 *     UPDATE install  SET revoked=1 WHERE instance_id=?                          <- NOT scoped
 *
 * A D1 batch is sequential, not conditional: statement 2 lands whether or not statement 1 matched.
 * So knowing an instance GUID was enough to flag every install of ANOTHER researcher's instance
 * revoked, and the route answered ok:true. The device's next poll takes a 410 and auto-releases —
 * clearSession, sync link dropped, Drive config scrubbed — mid-assignment.
 *
 * It reads as safe because the sibling route ten lines below (installs/<iid>/revoke) does the
 * ownership SELECT properly, and because the enclosing route "is" the researcher's own. That is the
 * trap: the scoping lives in a different statement from the write, so review sees a bound
 * researcher_id and stops looking.
 *
 * ⚠ IT MATTERS MUCH MORE UNDER THE PROJECTS/RESEARCHERS SPLIT. Instance ids are unguessable today,
 * which is the only thing that made this theoretical. Once a project's members legitimately see
 * those ids, a see-only member with no capability gains a device-unlinking primitive. It also
 * falsified plans/project-split.md R2-4, whose staged endpoint-conversion argument rests on every
 * instance/install/crowd ownership check being a fail-CLOSED filter.
 *
 * Run: node test/worker-ownership-scoping.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const worker = read('../worker/src/v1.js');
// Comments explain the very shapes this file forbids, so they must not satisfy the greps.
const code = worker.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

console.log('\nthe instance-revoke route establishes ownership before it writes anything');
{
  ok(/SELECT instance_id FROM instance WHERE instance_id=\? AND researcher_id=\?/.test(code),
     'it resolves the instance against the caller first');
  ok(/if \(!ownedInst\) return j\(\{ error: 'not_found' \}/.test(code),
     "and 404s on a miss — fail-closed, like every sibling route");
  // The batch itself is unchanged; what changed is that it is now unreachable without ownership.
  const idx = code.indexOf("sub === 'revoke' && seg.length === 4");
  const body = idx > 0 ? code.slice(idx, idx + 1400) : '';
  ok(body.indexOf('ownedInst') > 0 && body.indexOf('ownedInst') < body.indexOf('env.DB.batch'),
     'the check precedes the batch, not the other way round');
}

console.log('\nno unscoped revoke-by-instance survives anywhere');
{
  /* The exact shape that was wrong. An `UPDATE install ... WHERE instance_id=?` is only ever safe
   * when ownership was proven on a preceding line; this asserts the bare form does not reappear
   * outside the one place that now guards it. */
  /* BARE means the predicate ENDS at instance_id — the SQL string closes right after it. A longer
   * WHERE that goes on to constrain the rows further is a different statement and is judged on its
   * own merits; the invite-claim path is the live example, and it is sound. */
  const bare = (code.match(/UPDATE install SET revoked=1 WHERE instance_id=\?'/g) || []).length;
  ok(bare === 1, `exactly one bare revoke-by-instance write exists, the guarded one (found ${bare})`);
  ok(/UPDATE install SET revoked=1 WHERE instance_id=\? AND install_id<>\? AND revoked=0 AND EXISTS \(SELECT 1 FROM invite WHERE invite_id=\? AND claimed_install=\?\)/.test(code),
     'the invite-claim path revokes prior installs only if THIS install won the claim');
}

console.log('\nthe sibling routes it now matches are still doing it properly');
{
  ok(/FROM install i JOIN instance n ON n\.instance_id=i\.instance_id WHERE i\.install_id=\? AND i\.instance_id=\? AND n\.researcher_id=\?/.test(code),
     'installs/<iid>/* resolves ownership through a JOIN on instance.researcher_id');
  ok(/if \(!owned\) return j\(\{ error: 'not_found' \}/.test(code),
     'and 404s rather than 403 — an id the caller does not own must not be confirmed to exist');
}

console.log('\nminted /v1/textfile URLs are scoped, and therefore revocable');
{
  /* A v1 token named only the owner and the file, so serving it checked nothing but "decrypts,
   * unexpired, owner still has a Drive token" — a bearer URL nothing could withdraw for as long as
   * it lived, and clampTtlDays permits up to 400 days. Revoking a device did not stop it. */
  ok(/tk\.v = 2; tk\.i = scope\.instanceId;/.test(code),
     'a scoped mint emits v2 carrying the instance it was minted for');
  ok(/SELECT instance_id FROM instance WHERE instance_id=\? AND researcher_id=\? AND revoked=0/.test(code)
     && /if \(tk\.i\) \{/.test(code),
     'and the serve path re-checks that instance is live and still the owner\'s');
  // Revocability is the whole point: prove the check can actually fail closed.
  ok(/if \(!live\) return j\(\{ error: 'gone' \}, 410/.test(code),
     'a revoked or vanished instance makes its outstanding URLs 410');
  // Old tokens are held by deployed devices right now; breaking them strands assignments in flight.
  ok(/if \(scope && scope\.instanceId\)/.test(code),
     'scope is OPTIONAL at mint, so v1 tokens still mint and still serve unchanged');
  /* ⚠ THE CONSENT PROMPT IS DELIBERATELY UNSCOPED, and this asserts it stays that way. It is
   * configuration the researcher REUSES — pasted by hand into other devices' `consentAudioUrl`
   * field and into a crowd recorder's config, which has no instance at all — so scoping it would
   * 410 it the moment the minting device were revoked. Audio and flextext are a delivery to ONE
   * device and are scoped; the prompt is not. The inconsistency is the correct behaviour. */
  ok(/body\.promptFileId, '', ttlMs\);/.test(code),
     'the consent prompt is minted WITHOUT a scope');
  ok(/body\.audioFileId, '', ttlMs, scope\)/.test(code) && /body\.flextextFileId, '', ttlMs, scope\)/.test(code),
     '...while the assignment audio and flextext are scoped');
  // A per-token id cannot be added to tokens already in the field, so it must be carried from day one.
  ok(/n: crypto\.randomUUID\(\), iat: Date\.now\(\)/.test(code),
     'every token carries a per-token id, so a single leaked URL can be retired later');
  // Every mint site should be passing a scope now — an unscoped one is a hole left open.
  const mints = (code.match(/mintTextfileUrl\(env, url\.origin/g) || []).length;
  const scoped = (code.match(/mintTextfileUrl\(env, url\.origin[^;]*?scope|instanceId: to\.instance_id/g) || []).length;
  ok(mints > 0 && scoped >= 3, `the delivery mint sites pass a scope (${scoped} of ${mints}; the prompt is the deliberate exception)`);
  /* ⚠ TTL is deliberately UNTOUCHED by this change — shortening it is visible to researchers who
   * set a delivery window, so it is a separate decision, not a side effect. Asserted so a later
   * edit cannot quietly fold a behaviour change into this one. */
  ok(/ttlMs \|\| 90 \* 86400000/.test(code), 'the default TTL is unchanged (90 days)');
}

console.log('\nthe worker never fetches a URL the caller chose');
{
  /* The assign-copy route streamed an arbitrary PUBLIC Drive file, named by a caller-supplied id,
   * into the researcher's own Drive. It existed only for the pasted-URL assignment flow, which is
   * gone — assignment is now by upload, and "the upload IS the copy". Removed 2026-08-19 after
   * confirming zero call sites on productionWeb and main. A caller-controlled outbound fetch that
   * serves no live flow is pure attack surface. */
  ok(!/sub === 'assign-copy'/.test(code), 'the assign-copy route is gone');
  /* And nothing PERSISTS a raw Drive message either: noteDriveError writes into researcher.drive_error
   * in D1, which is the one path where an identifier outlives the request. */
  ok(!/' \+ e\.message\)/.test(code), 'no handler stores or returns a raw Drive e.message');
  ok(!/drive\.usercontent\.google\.com/.test(code),
     'and with it the only fetch of a caller-named Drive download URL');
  const client = read('../docs/js/researcher.js');
  ok(!/assignCopy/.test(client), 'the orphaned client wrapper is gone too');
}

/* ⚠⚠ THE BRICK GUARD (plans/drive-as-truth.md §16.19).
 *
 * The desired lane returns 410 when an install row is absent or revoked, and the CLIENT treats 410
 * as "the researcher revoked me": clearSession() + onRevoked(), which drops the sync link and scrubs
 * the Drive config. Local texts survive, so this is not data loss — but the PAIRING is gone, and a
 * pairing can only be restored by a fresh invite link, which means a researcher physically present
 * with every phone. In a village that is not a blip, it is the trip.
 *
 * Adding `AND project_id = ?` to these lookups is the one-line change that would do it to the whole
 * estate at once: during backfill project_id is NULL, the row stops matching, the handler reads that
 * as "absent", and every field device unlinks simultaneously. This asserts that predicate is not
 * there. */
{
  console.log('\nthe desired lane cannot be scoped into bricking the estate');
  const lane = worker.slice(worker.indexOf("Distinguish a REVOKED install from a bad secret"));
  const body = lane.slice(0, 3000);
  const installSel = /SELECT revoked, wipe_state FROM install WHERE([^']*)'/.exec(body);
  ok(!!installSel, 'the install revoked-vs-bad-secret lookup is findable');
  ok(installSel && !/project/i.test(installSel[1]),
     'it does NOT filter by project — a NULL project_id mid-backfill would read as "absent" ⇒ 410 ⇒ every device unlinks');
  const instSel = /SELECT desired_blob, desired_rev, type, revoked, researcher_id FROM instance WHERE([^']*)'/.exec(body);
  ok(!!instSel, 'the instance lookup is findable');
  ok(instSel && !/project/i.test(instSel[1]), '...and it does not filter by project either');
  /* And the asymmetry that makes this survivable: a MISSING instance is 404, which the client does
   * NOT auto-release on. Losing that distinction would make the safe failure mode the dangerous one. */
  ok(/if \(!inst\) return j\(\{ error: 'not_found' \}, 404/.test(body),
     'a missing instance stays 404 — only a REVOKED one is 410, and only 410 auto-releases');
}

console.log(fail ? `\nFAILED (${fail}) — an ownership write has slipped its scope.\n`
                 : '\nPASS: ownership is proven before the write, including inside batches.\n');
process.exit(fail ? 1 : 0);
