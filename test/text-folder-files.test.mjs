/* The Files menu shows the NEWEST copy of each kind — never the backup-copy pileup.
 *
 * WHY THIS IS WORTH A TEST: auto-backup writes a new timestamped Drive file on every upload, so a
 * text's folder accumulates dozens of near-identical zips. The menu's entire value is that the
 * researcher sees ONE entry per kind of artifact, the current one. Regress the grouping and the
 * menu becomes the pileup it exists to hide.
 *
 * The classifier is duplicated logic by necessity (the Worker names files, the panel classifies
 * them), so the test pins the CONTRACT: which names map to which kinds, and that ordering — the
 * listing arrives newest-first from Drive — is what makes "first seen wins" mean "most recent".
 *
 * The functions live in researcher-panel.js, which cannot be imported under node (it reads
 * `location` at module scope, by design). They are lifted from the real source, same technique as
 * panel-collapse.test.mjs: a rename or rewrite fails here rather than silently testing a copy.
 *
 * Run: node test/text-folder-files.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const panel = read('../docs/js/researcher-panel.js');

// Lift EXT_KIND and latestPerKind out of the real source.
const extSrc = panel.match(/const EXT_KIND = \[([\s\S]*?)\];/);
const fnSrc = panel.match(/function latestPerKind\(files\) \{([\s\S]*?)\n\}/);
ok(!!extSrc && !!fnSrc, 'EXT_KIND and latestPerKind are present in researcher-panel.js');
if (!extSrc || !fnSrc) { console.log(`\nFAILED (${fail})`); process.exit(1); }
const EXT_KIND = new Function('return [' + extSrc[1] + ']')();
const latestPerKind = new Function('EXT_KIND', 'files', fnSrc[1].replace(/^\s*const seen/, 'const seen'))
  .bind(null, EXT_KIND);

const f = (name) => ({ name, id: 'id-' + name });
const kinds = (r) => r.map((x) => x.kind);

console.log('\nclassification: every name the suite produces maps to the right kind');
{
  const r = latestPerKind([
    f('kisah 2026-08-03 1412.zip'), f('kisah.flextext'), f('kisah.eaf'), f('kisah.saymore.eaf'),
    f('kisah.derived-NOT-ARCHIVAL.wav'), f('recording.wav'), f('recording.opus'), f('consent-receipt.json'),
  ]);
  const byKind = Object.fromEntries(r.map((x) => [x.kind === 'other' ? 'other:' + x.name : x.kind, x.name]));
  ok(byKind['bundle'] === 'kisah 2026-08-03 1412.zip', '.zip -> bundle');
  ok(byKind['flextext'] === 'kisah.flextext', '.flextext -> flextext');
  ok(byKind['eaf-flex'] === 'kisah.eaf', '.eaf -> the FLEx profile');
  ok(byKind['eaf-saymore'] === 'kisah.saymore.eaf', '.saymore.eaf -> the SayMore profile (checked FIRST, or .eaf would swallow it)');
  ok(byKind['wav-derived'] === 'kisah.derived-NOT-ARCHIVAL.wav', 'a derived WAV is its own kind, never mistaken for the recording');
  ok(byKind['audio'] === 'recording.wav', 'a plain .wav is the recording');
  ok(byKind['other:consent-receipt.json'] === 'consent-receipt.json', 'unknown kinds pass through by name');
}

console.log('\nthe pileup collapses: newest-first input, first-seen wins');
{
  // Drive returns modifiedTime DESC — the fixture mirrors that.
  const r = latestPerKind([
    f('kisah 2026-08-03.zip'), f('kisah 2026-08-02.zip'), f('kisah 2026-08-01.zip'),
    f('kisah 2026-07-30.zip'), f('take2.wav'), f('take1.wav'),
  ]);
  ok(r.length === 2, 'six files -> two entries (one bundle, one audio)');
  ok(r[0].name === 'kisah 2026-08-03.zip', 'the NEWEST zip survives');
  ok(kinds(r).join() === 'bundle,audio', 'and the newest audio take');
}

console.log('\nunknown kinds are kept per NAME — distinct files never collapse into each other');
{
  const r = latestPerKind([f('notes.txt'), f('metadata.json'), f('notes.txt')]);
  ok(r.length === 2, 'two distinct unknown names -> two entries; a duplicate name collapses');
}

console.log('\nmalformed input degrades, never throws (this feeds a privileged panel)');
{
  ok(Array.isArray(latestPerKind(null)) && latestPerKind(null).length === 0, 'null -> []');
  ok(latestPerKind([{ id: 'x' }]).length === 1, 'a file with no name still lists (as other)');
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
