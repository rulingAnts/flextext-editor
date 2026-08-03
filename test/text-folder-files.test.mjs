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

console.log('\nthe assigned-audio COPY is its own kind — the role tag beats the extension');
{
  // ⚠ The if-and-only-if rule depends on this: the panel hides the cached original-audio link
  // exactly when the folder holds the copy. If a device-recorded take (same extensions!) could
  // classify as the original, the cached link would vanish for texts whose copy never existed.
  const r = latestPerKind([
    { name: 'take2.wav', id: 't2' },                                          // device recording
    { name: 'assigned-audio.mp3', id: 'o1', role: 'assigned-audio' },         // the Worker's copy
    { name: 'take1.wav', id: 't1' },
  ]);
  ok(kinds(r).sort().join() === 'audio,audio-original', 'copy and recording are DISTINCT kinds');
  ok(r.find((x) => x.kind === 'audio-original').id === 'o1', 'the role tag picked the copy');
  ok(r.find((x) => x.kind === 'audio').name === 'take2.wav', 'newest device take survives beside it');
  const noCopy = latestPerKind([{ name: 'take2.wav', id: 't2' }]);
  ok(!noCopy.some((x) => x.kind === 'audio-original'),
     'a recording WITHOUT the role tag is never mistaken for the original copy');
}

console.log('\ncleanup may take ONLY older backups — never the newest of a kind, never the original');
{
  // Lift the real cleanupCandidates (it closes over latestPerKind, lifted above).
  const ccSrc = panel.match(/function cleanupCandidates\(allFiles\) \{([\s\S]*?)\n\}/);
  ok(!!ccSrc, 'cleanupCandidates is present in researcher-panel.js');
  const cleanupCandidates = new Function('latestPerKind', 'allFiles', ccSrc[1]).bind(null, latestPerKind);
  const all = [
    { id: 'z3', name: 'k 08-03.zip', modified: '3' },
    { id: 'z2', name: 'k 08-02.zip', modified: '2' },
    { id: 'z1', name: 'k 08-01.zip', modified: '1' },
    { id: 'o1', name: 'old-original.mp3', modified: '0', role: 'assigned-audio' },
    { id: 'f1', name: 'k.flextext', modified: '2' },
  ];
  const dead = cleanupCandidates(all).map((f) => f.id).sort();
  ok(dead.join() === 'z1,z2', 'only the two OLDER zips are candidates');
  ok(!dead.includes('z3'), 'the newest bundle survives');
  ok(!dead.includes('f1'), 'the only flextext survives');
  ok(!dead.includes('o1'), 'the ORIGINAL assigned audio is never a cleanup candidate, however old');
  ok(cleanupCandidates([]).length === 0 && cleanupCandidates(null).length === 0, 'empty/null are safe');
}

console.log('\nmalformed input degrades, never throws (this feeds a privileged panel)');
{
  ok(Array.isArray(latestPerKind(null)) && latestPerKind(null).length === 0, 'null -> []');
  ok(latestPerKind([{ id: 'x' }]).length === 1, 'a file with no name still lists (as other)');
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
