/* THE UNASSIGNED SWEEP DECIDES ON THE CLIENT, AND THAT IS NOT A DESIGN SMELL TO CLEAN UP.
 *
 * Seth, 2026-08-20, on the client-vs-server audit: "I agree with you on the unassigned-sweep
 * predicate/E2EE point. Don't break that."
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. Every audit of this codebase that sweeps for "guards
 * enforced on the client" will find this one, because it looks exactly like the thing such an audit
 * is meant to catch: the panel computes which texts are unassigned, and the worker simply moves the
 * ids it is handed. Moving it server-side reads like an obvious hardening.
 *
 * ⚠ IT IS NOT POSSIBLE, and the reason is structural rather than a matter of effort. A device's
 * inventory is END-TO-END ENCRYPTED: `install.reported_blob` is ciphertext the worker has no key
 * for. "Which texts does this device hold?" is a question the worker CANNOT answer. To move the
 * predicate server-side you would first have to make inventories readable by the worker — that is,
 * abandon the E2EE property that protects the language data of the communities this suite serves,
 * in exchange for tidier code. That trade must never be made silently, and a passing grep is exactly
 * how it would be.
 *
 * So this file pins the three facts that keep the arrangement honest:
 *   1. the worker moves the ids it is GIVEN, and never derives them;
 *   2. the worker never interprets a device inventory — reported_blob is stored, compared and
 *      returned, never parsed;
 *   3. the client is still where the predicate lives.
 *
 * If a future change needs to break one of these, that is a decision about E2EE, and it should
 * arrive as a deliberate argument rather than as a red test someone deletes.
 *
 * Run: node test/sweep-stays-client-side.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const worker = read('../worker/src/v1.js');
const panel = read('../docs/js/researcher-panel.js');
// This file's own reasoning names the shapes it forbids, and so do the worker's comments.
const code = worker.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

console.log('\nthe worker moves the ids it is GIVEN — it never works out which texts are unassigned');
{
  const at = code.indexOf("seg[2] === 'drive-unassign'");
  ok(at > 0, 'the drive-unassign route exists');
  const route = code.slice(at, at + 4000);
  ok(/Array\.isArray\(body\.docIds\)/.test(route),
     'the list comes from the request body, supplied by the panel');
  ok(/bad_docids/.test(route),
     '...and an empty list is refused rather than treated as "sweep everything"');
  ok(!/reported_blob/.test(route),
     '⚠ the route never consults a device inventory — that is what deriving the list would require');
}

console.log('\nthe worker never interprets a device inventory: reported_blob stays opaque');
{
  /* It may be SELECTed, compared for equality and handed back to the researcher — all of which are
   * operations on ciphertext. What must never appear is an attempt to read INSIDE it. */
  ok(!/JSON\.parse\([^)]*reported_blob/.test(code),
     '⚠ reported_blob is never JSON.parse()d');
  ok(!/decryptJSON|unwrapKey|importKeyB64/.test(code),
     'the worker holds no client-side crypto primitives to unwrap one with');
  const uses = (code.match(/reported_blob/g) || []).length;
  ok(uses > 0 && uses <= 6,
     `reported_blob appears ${uses}× — store, compare, return. A jump here means someone started reading it`);
}

console.log('\nthe predicate still lives in the panel, where the decrypted inventories are');
{
  ok(/function unassignedTexts\(/.test(panel), 'unassignedTexts() is still the client-side predicate');
  ok(/function sweepUnassigned\(/.test(panel), 'sweepUnassigned() still drives the sweep from the panel');
  ok(/instanceReported\(/.test(panel),
     '...and still reasons over what devices actually REPORTED, which only the client can read');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nall good\n');
process.exit(fail ? 1 : 0);
