/* The .fxpa contract, tested ACROSS its two halves.
 *
 * ⚠ WHY THIS SUITE EXISTS (v321 audit): the editor's exporter (seg-exports.js buildFxpa) and PAT's
 * importer (paragraph-model.js validateFxpa) were tested SEPARATELY — each against its own idea of
 * the format — so the two could drift apart without any test noticing. This suite feeds the real
 * exporter's output into the real importer, so a change to either side that breaks the other fails
 * HERE, at commit time, instead of at a researcher's desk.
 *
 * Pure-module test: both files must run under plain node (the format-module rule). */
import { buildFxpa } from '../docs/js/seg-exports.js';
import { validateFxpa, serializeFxpa } from '../docs/js/paragraph-model.js';
import { makeDoc, reconcileBaseline } from '../docs/js/flextext.js';

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok    ' : '  FAIL  ') + msg); if (!cond) failures++; };

function segDoc() {
  const doc = makeDoc({ vernLang: 'fau', analLang: 'id' });
  reconcileBaseline(doc, ['satu dua', '', 'tiga empat'], { flatSegments: true });
  doc.paragraphs[0].segments[0].words.forEach((w, i) => { if (!w.punct) w.gls = 'G' + i; });
  doc.paragraphs[0].segments[0].free = 'one two';
  doc.segments = [{ start: 0, end: 2000 }, { start: 2000, end: 4000 }, { start: 4000, end: 6000 }];
  return doc;
}

console.log('a FULLY-LOADED editor export passes PAT\'s real import path');
{
  const fx = buildFxpa(segDoc(), {
    title: 'Kisah <A&B>', vernLang: 'fau', analLang: 'id',
    audio: { b64: 'QUJD', mime: 'audio/wav', name: 's.converted-NOT-ARCHIVAL.wav', derived: true, srcName: 's.m4a' },
    speakers: ['Barnabas'], sourceModified: 1786000000000, engine: 'v321',
  });
  // Simulate the file crossing between apps: what PAT receives is parsed JSON, not the live object.
  const v = validateFxpa(JSON.parse(JSON.stringify(fx)));
  ok(v.ok === true, `validateFxpa accepts it (${v.ok ? 'ok' : (v.errors || []).join(' | ')})`);
  ok(v.data.lines.length === 3, 'all lines arrive');
  ok(!!v.data.audio && v.data.audio.derived === true && v.data.audio.srcName === 's.m4a',
     'derived-audio provenance survives import');
  ok(Array.isArray(v.data.speakers) && v.data.speakers[0] === 'Barnabas', 'speakers survive');
  // The v319 source stamp — the importer's only stale-analysis discriminator. PAT does not READ it
  // yet (backlogged), but it must never be rejected or mangled on the way through.
  ok(!!v.data.source && v.data.source.lineCount === 3 && v.data.source.engine === 'v321',
     'the source stamp passes validation intact');
  // ...and PAT's own save path must carry it, or the discriminator dies on first save.
  const saved = JSON.parse(serializeFxpa(v.data));
  ok(!!saved.source && saved.source.lineCount === 3 && saved.source.modified === 1786000000000,
     'PAT\'s save (serializeFxpa) preserves the stamp');
}

console.log('\nthe MINIMAL export (text-only, no audio, no stamp inputs) also passes');
{
  const d = segDoc();
  d.segments = [];
  const v = validateFxpa(JSON.parse(JSON.stringify(buildFxpa(d, { title: 'T', vernLang: 'fau', analLang: 'id' }))));
  ok(v.ok === true, 'text-only export is a first-class PAT document');
  ok(v.data.lines.every((l) => !('start' in l)), 'no spans on any line');
}

console.log('\nthe version gate both sides rely on');
{
  const fx = buildFxpa(segDoc(), { title: 'T', vernLang: 'fau', analLang: 'id' });
  ok(fx.version === 1, 'the exporter writes version 1');
  const future = validateFxpa({ ...JSON.parse(JSON.stringify(fx)), version: 2 });
  // ⚠ Pinned ON PURPOSE for the one-tree migration (plans/pat-one-tree-model.md §6): an OLD PAT
  // must refuse a version-2 file cleanly rather than half-read it. If this assertion ever blocks
  // you, you are shipping the migration — bump FXPA_VERSION and write the repair path first.
  ok(future.ok === false, 'a version above the reader\'s is REFUSED, not half-read');
  ok((future.errors || []).some((e) => /version/i.test(e)), 'with an error that names the version');
}

console.log(failures ? `\nFAILED (${failures})\n` : '\nPASSED\n');
process.exit(failures ? 1 : 0);
