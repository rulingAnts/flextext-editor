/* THE SOURCE-PACKAGE MANIFEST — one builder, three origins, and the provenance schema 1 lacked.
 *
 * WHY THIS TEST EXISTS. The manifest is written FIRST, before a single source byte, and DECLARES
 * the intended file set. Every consumer derives completeness by comparing that declaration against
 * what is actually in the folder — so the manifest is not a description of the package, it IS the
 * contract the package is judged against. That makes two things dangerous in a way they would not
 * be for ordinary metadata:
 *
 *   1. TWO WRITERS. app.js had `buildSourceManifest`; researcher-panel.js carried a hand-copied
 *      literal of the same shape. Nothing was wrong on the day it was copied — but the first
 *      divergence would not have looked like a divergence. It would have surfaced as "the panel
 *      says this package is incomplete" about a text that was fine, and the obvious place to look
 *      would have been the upload path rather than the document describing it. MANIFEST_NAME was
 *      moved into the shared format module for exactly this reason; the builder was left behind.
 *   2. MUTATION. Appending anything to a written manifest means rewriting it, and a rewrite that
 *      races an in-flight upload can regress the declared set — turning the one document that
 *      answers "what is missing" into a document that can be wrong about it. Custody history is
 *      therefore deliberately NOT in here (plans/drive-as-truth.md 16.12).
 *
 * Run: node test/manifest-provenance.test.mjs
 */
import { readFileSync } from 'node:fs';
import { buildSourceManifest, MANIFEST_NAME } from '../docs/js/seg-exports.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../worker/src/v1.js', import.meta.url), 'utf8');

console.log('\nONE builder — no writer keeps a copy of the contract');
{
  ok(/export function buildSourceManifest\(/.test(readFileSync(new URL('../docs/js/seg-exports.js', import.meta.url), 'utf8')),
     'the builder lives in the shared format module, beside MANIFEST_NAME');
  for (const [name, src] of [['app.js', app], ['researcher-panel.js', panel]]) {
    ok(/import \{[^}]*buildSourceManifest/s.test(src), `${name} imports it`);
    ok(!/function buildSourceManifest\s*\(/.test(src), `...and does not define its own`);
  }
  /* The precise shape of the old copy: a literal that declares the schema itself. Whichever number
   * it names, a writer that hard-codes `schema:` is a writer that has stopped calling the builder. */
  ok(!/schema:\s*\d/.test(panel), 'the panel no longer hand-writes a schema-stamped literal');
  ok(!/schema:\s*\d/.test(app), '...nor does app.js');
  /* ⚠ And the worker must never grow one either. The crowd page IS this engine, so the third origin
   * writes its manifest with the same builder and the worker only UNWRAPS it from the zip. A
   * worker-side builder would be a fourth writer of a contract whose value is that all writers
   * agree — and it is the one that could not import the shared module to stay honest. */
  ok(!/schema:\s*\d/.test(worker), 'the worker builds no manifest of its own');
  ok(/storeZipEntry\(bytes, \/\(\^\|\\\/\)flextext-manifest/.test(worker)
     || /crowdExtractManifest/.test(worker), '...it extracts the client-written one instead');
}

console.log('\nprovenance: all three origins are distinguishable from Drive alone');
{
  const mk = (o, source) => buildSourceManifest({ docId: 'd1', title: 'T', origin: o, source, now: 1000 });
  const dev = mk('recorded', { kind: 'device', id: 'inst-9' });
  const crowd = mk('crowd', { kind: 'crowd', id: 'crowd-3' });
  const res = mk('assigned', { kind: 'researcher', id: 'acct-7' });
  ok(dev.source.kind === 'device' && dev.source.id === 'inst-9', 'a recorded text names WHICH device');
  ok(crowd.source.kind === 'crowd' && crowd.source.id === 'crowd-3', 'a crowd submission names WHICH recorder');
  ok(res.source.kind === 'researcher' && res.source.id === 'acct-7', 'an assigned text names the researcher account');
  ok(new Set([dev.source.kind, crowd.source.kind, res.source.kind]).size === 3,
     'and the three are distinct — the question "where did this text come from" is answerable');

  /* An absent `source` must be ABSENT, not an empty object. A reader cannot tell "we do not know"
   * from "it came from nowhere" if the key is always present, and every manifest written before
   * schema 2 has no source at all — so the shape of "unknown" has to match what those files
   * already look like. */
  const bare = buildSourceManifest({ docId: 'd2', origin: 'recorded', now: 1000 });
  ok(!('source' in bare), 'no source given ⇒ the key is omitted, matching every schema-1 manifest');
  const half = buildSourceManifest({ docId: 'd3', origin: 'recorded', source: { id: 'x' }, now: 1000 });
  ok(!('source' in half), '...and a source with no kind is omitted rather than half-filled');
}

console.log('\nthe declaration rules that make completeness derivable');
{
  const m = buildSourceManifest({
    docId: 'd1', origin: 'recorded', now: 1000,
    files: [{ name: 'a.wav', role: 'source-audio', mime: 'audio/wav', bytes: 10 }],
  });
  ok(m.files[0].name === MANIFEST_NAME && m.files[0].role === 'manifest',
     'the manifest declares ITSELF first — a consumer listing the folder sees a complete set');
  ok(m.files.length === 2 && m.files[1].name === 'a.wav', '...followed by the declared sources');
  ok(!('complete' in m), 'there is no `complete` flag to go stale — completeness is DERIVED');
  ok(m.schema === 2, 'schema is stamped by the builder, never by a caller');
  /* Additive-only is what lets a schema-1 reader handle a schema-2 file. Pin the keys schema 1
   * shipped: dropping or renaming one silently breaks readers already in the field. */
  for (const k of ['schema', 'docId', 'title', 'origin', 'originatedAt', 'writtenAt', 'engine',
                   'buildTag', 'writingSystems', 'audio', 'files', 'consent']) {
    ok(k in m, `schema-1 key \`${k}\` survives`);
  }
}

console.log('\ncustody history is NOT in the manifest');
{
  const m = buildSourceManifest({ docId: 'd1', origin: 'recorded', now: 1000 });
  ok(!('custody' in m) && !('history' in m) && !('assignments' in m),
     'nothing append-only lives in a document whose value is that it was written once');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
