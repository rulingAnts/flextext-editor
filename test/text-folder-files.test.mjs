/* What a file IS comes from its Drive ROLE TAG — and cleanup may only ever trash backup copies.
 *
 * WHY THIS TEST EXISTS, v1: auto-backup writes a new timestamped Drive file on every upload, so a
 * text's folder accumulates dozens of near-identical copies. The menu's value is that the researcher
 * sees the CURRENT artifact, not the pileup, and cleanup's value is reclaiming the rest.
 *
 * WHY IT WAS REWRITTEN, v3 (2026-08-12): the original classifier sniffed file EXTENSIONS
 * (`EXT_KIND` + `latestPerKind`) and the guess was wrong often enough to get the whole menu parked —
 * most memorably promising "Bundle (.zip, includes audio)" and delivering raw XML, because a `.zip`
 * name says nothing about what is inside it. Seth: *"the inferred menu has actually never worked
 * correctly and it's not worth our time making it work correctly if it's just a fallback."* Files
 * this suite writes now carry an `appProperties.flextextRole` tag, and the manifest declares the
 * intended set. A tag is a fact; an extension was a guess.
 *
 * ⚠ THE DANGEROUS HALF IS `cleanupCandidates`, WHICH IS WHY THE BULK OF THIS FILE IS ABOUT IT.
 * It proposes files to move to Drive trash. Its old form derived "what to keep" by SUBTRACTING the
 * extension table's picks — so deleting that table could have silently WIDENED what cleanup
 * proposed, which is the worst possible way for a refactor to go wrong and would have looked
 * perfectly fine in review. The rewrite inverts it: it lists what MAY GO (older bare `.flextext`
 * backup copies) instead of subtracting what must stay, so a role this function has never heard of
 * is kept by default. These tests pin that inversion — a future edit that reverts to subtraction
 * has to fail here.
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

console.log('\nthe deleted heuristic stays deleted');
{
  // Their reappearance under these exact names IS the regression this file guards.
  for (const dead of ['EXT_KIND', 'latestPerKind', 'unzipStoreEntry']) {
    const re = new RegExp(`(const|function)\\s+${dead}\\b`);
    ok(!re.test(panel), `researcher-panel.js defines no ${dead}`);
  }
  ok(!/unzipStoreEntry/.test(read('../docs/js/zip.js')),
     'zip.js dropped unzipStoreEntry too — it was added for the legacy read path and had no other caller');
}

// Lift the real role sets + the two pure functions out of the source.
const lift = (re, label) => { const m = panel.match(re); ok(!!m, label); return m; };
// The whole declaration block, verbatim: the role sets plus the two predicates they close over.
const roleSrc = lift(/(const SOURCE_AUDIO_ROLES = [\s\S]*?const isFlextextName = [^;]*;)/, 'the role sets are present');
const pickSrc = lift(/(function pickSourceFiles\(files\) \{[\s\S]*?\n\})/, 'pickSourceFiles is present');
const ccSrc = lift(/(function cleanupCandidates\(allFiles\) \{[\s\S]*?\n\})/, 'cleanupCandidates is present');
if (!roleSrc || !pickSrc || !ccSrc) { console.log(`\nFAILED (${fail})`); process.exit(1); }

const env = new Function('MANIFEST_NAME', `
  ${roleSrc[1]}
  ${pickSrc[1]}
  ${ccSrc[1]}
  return { pickSourceFiles, cleanupCandidates, PROTECTED_ROLES };
`)('flextext-manifest.json');
const { pickSourceFiles, cleanupCandidates, PROTECTED_ROLES } = env;

// Drive listings arrive newest-first; `modified` is what actually decides age.
let seq = 0;
const f = (name, role = '', modified = '') => ({ name, role, id: 'id-' + name + '-' + (++seq), modified });

console.log('\npickSourceFiles reads the ROLE TAG, not the filename');
{
  const rows = [
    f('Kisah Rusa.flextext', '', '2026-08-10T00:00:00Z'),
    f('Kisah Rusa.mp3', 'source-audio', '2026-08-09T00:00:00Z'),
    f('flextext-manifest.json', 'manifest', '2026-08-09T00:00:00Z'),
    f('consent-response.mp3', 'consent-clip', '2026-08-09T00:00:00Z'),
  ];
  const p = pickSourceFiles(rows);
  ok(p.audio && p.audio.role === 'source-audio', 'the recorded original is found by role');
  ok(p.manifest && p.manifest.name === 'flextext-manifest.json', 'the manifest is found');
  ok(p.consent.length === 1, 'consent artifacts are collected');
  /* THE POINT OF ROLE TAGS (locked decision 4): a story rename leaves a cosmetically stale filename
   * and nothing breaks. Here the audio is named for a DIFFERENT story than the folder holds. */
  const renamed = pickSourceFiles([f('an-old-title.mp3', 'source-audio')]);
  ok(renamed.audio && renamed.audio.name === 'an-old-title.mp3',
     'a stale filename still resolves — detection never reads the name');
  // The legacy assign-era tags must keep resolving, or texts assigned in that window go dark.
  ok(pickSourceFiles([f('x.wav', 'assigned-audio')]).audio, 'the legacy assigned-audio tag still resolves');
  ok(pickSourceFiles([f('x.flextext', 'assigned-flextext')]).flextext, 'and legacy assigned-flextext');
}

console.log('\n...and falls back to .flextext by NAME, which is not the same as sniffing');
{
  /* Lane B uploads a bare timestamped .flextext per auto-backup. Those postdate the manifest, so it
   * cannot declare them — the extension is the only handle, and unlike `.zip` it IS the format, on
   * files we ourselves wrote. It cannot mis-promise the way the deleted guesses could. */
  const p = pickSourceFiles([
    f('Kisah Rusa 2026-08-10.flextext', '', '2026-08-10T00:00:00Z'),
    f('Kisah Rusa 2026-08-01.flextext', '', '2026-08-01T00:00:00Z'),
  ]);
  ok(p.flextext && /2026-08-10/.test(p.flextext.name), 'newest-first input means the newest wins');
  ok(pickSourceFiles([f('notes.txt'), f('cover.png')]).flextext === null,
     'a folder with no flextext resolves to null, not to some other file');
  // A tagged source copy beats an untagged bare upload of the same extension.
  const tagged = pickSourceFiles([f('a.flextext', 'source-flextext'), f('b.flextext')]);
  ok(tagged.flextext.name === 'a.flextext', 'the tagged source copy wins over an untagged one');
}

console.log('\npickSourceFiles is total — no input shape can throw');
{
  ok(pickSourceFiles(null).audio === null && pickSourceFiles(undefined).flextext === null, 'null/undefined');
  ok(pickSourceFiles([]).consent.length === 0, 'empty list');
  ok(pickSourceFiles([{ id: 'x' }]).flextext === null, 'a row with no name or role');
}

console.log('\ncleanupCandidates: ONLY older .flextext backup copies, ever');
{
  const rows = [
    f('Kisah 2026-08-10.flextext', '', '2026-08-10T00:00:00Z'),   // newest — KEPT
    f('Kisah 2026-08-05.flextext', '', '2026-08-05T00:00:00Z'),   // older  — candidate
    f('Kisah 2026-08-01.flextext', '', '2026-08-01T00:00:00Z'),   // older  — candidate
  ];
  const dead = cleanupCandidates(rows).map((x) => x.name);
  ok(dead.length === 2 && !dead.includes('Kisah 2026-08-10.flextext'),
     `the newest copy is always kept (proposed: ${dead.join(', ')})`);
}

console.log('\n...and NOTHING else, however old it is');
{
  /* Each of these is irreplaceable: the source materials are what the researcher delivered or the
   * speaker recorded, the consent artifacts are the IRB record, and the manifest is the contract the
   * package is checked against. Age is not evidence that any of them is a backup copy. */
  const protectedRows = [
    f('Kisah.mp3', 'source-audio', '2020-01-01T00:00:00Z'),
    f('Kisah.flextext', 'source-flextext', '2020-01-01T00:00:00Z'),
    f('old.wav', 'assigned-audio', '2020-01-01T00:00:00Z'),
    f('old.flextext', 'assigned-flextext', '2020-01-01T00:00:00Z'),
    f('consent-response.mp3', 'consent-clip', '2020-01-01T00:00:00Z'),
    f('consent-prompt.mp3', 'consent-prompt', '2020-01-01T00:00:00Z'),
    f('consent-receipt.json', 'consent-receipt', '2020-01-01T00:00:00Z'),
    f('flextext-manifest.json', 'manifest', '2020-01-01T00:00:00Z'),
  ];
  // Every protected role is actually listed as protected — a typo here is a silent data-loss bug.
  for (const r of protectedRows) {
    ok(PROTECTED_ROLES.includes(r.role), `${r.role} is in PROTECTED_ROLES`);
  }
  const withNewer = [f('Kisah 2026-08-10.flextext', '', '2026-08-10T00:00:00Z'), ...protectedRows];
  const dead = cleanupCandidates(withNewer);
  ok(dead.length === 0, `nothing protected is ever proposed (proposed: ${dead.map((x) => x.name).join(', ') || 'none'})`);

  /* ⚠ THE ONE THAT WOULD HURT MOST: a source-flextext is BOTH .flextext-named and protected. The
   * candidate rule must exclude it by ROLE, not merely be outranked by a newer file — otherwise a
   * text whose researcher-supplied original is older than a device backup loses the original. */
  const sourceIsOlder = [
    f('Kisah 2026-08-10.flextext', '', '2026-08-10T00:00:00Z'),
    f('delivered.flextext', 'source-flextext', '2020-01-01T00:00:00Z'),
  ];
  ok(cleanupCandidates(sourceIsOlder).length === 0,
     'an OLD source-flextext beside a NEW device backup is still never a candidate');
}

console.log('\ncleanup never proposes something it cannot act on, and never throws');
{
  ok(cleanupCandidates([]).length === 0 && cleanupCandidates(null).length === 0, 'empty/null are safe');
  ok(cleanupCandidates([{ name: 'a.flextext' }, { name: 'b.flextext' }]).length === 0,
     'rows with no Drive id are dropped — trashFiles would have nothing to send');
  ok(cleanupCandidates([f('only.flextext', '', '2026-01-01T00:00:00Z')]).length === 0,
     'a single copy is never a backup of itself');
  // Ordering is re-derived internally: a caller handing them oldest-first must not invert the keep.
  const oldestFirst = [
    f('Kisah 2026-08-01.flextext', '', '2026-08-01T00:00:00Z'),
    f('Kisah 2026-08-10.flextext', '', '2026-08-10T00:00:00Z'),
  ];
  const dead = cleanupCandidates(oldestFirst).map((x) => x.name);
  ok(dead.length === 1 && dead[0] === 'Kisah 2026-08-01.flextext',
     'the NEWEST survives regardless of the order the caller passed');
}

console.log('\nfolder rows are filtered by the Worker, so they never reach any of this');
{
  const worker = read('../worker/src/v1.js');
  ok(/\.filter\(\(f\) => !isFolder\(f\)\)/.test(worker),
     'the files listing drops folder rows — a folder is not a downloadable file');
  ok(/const SOURCE_ROLES = \['originals', 'assignment'\]/.test(worker),
     'and it merges the originals/ child under BOTH its current and legacy tag');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
