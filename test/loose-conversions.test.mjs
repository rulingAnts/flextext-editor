/* THE LOOSE-FILE CONVERTER'S DECISIONS — a user-supplied .flextext + audio, into the same formats
 * the Files ▾ menu already makes from Drive.
 *
 * Seth, 2026-08-14, and this is the whole specification: "exactly the same thing that our files drop
 * down box already does for texts that are on Google Drive, except that the user can submit their
 * own flextext and matching audio file … a backup way to do it with files they just happen to have
 * lying around that match. That's the goal of this utility, period."
 *
 * So most of what is asserted here is PARITY with researcher-panel.js's menu — the want/full table,
 * the fxpa audio-drop, the already-WAV push — because the moment those diverge the two surfaces
 * produce different files from the same inputs, and nobody finds out until a linguist opens one.
 *
 * The rest is the part the menu does NOT need and this tool does: the menu gets its pair from a
 * manifest, so it can trust that the audio belongs to the text. Two file pickers cannot.
 *
 * Run: node test/loose-conversions.test.mjs
 */
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';

installMiniXmlDom();
const { loosePlan, alignmentIsOrdered, durationVerdict, buildLooseConversion } =
  await import('../docs/js/seg-exports.js');
const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const seg = readFileSync(new URL('../docs/js/seg-exports.js', import.meta.url), 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

// A doc shaped the way parseFlextext produces one: paragraphs → segments (phrases) → words.
const phrase = (txt, start, end) => ({
  baseline: txt, free: '', words: [{ txt, gls: '' }],
  attrs: start == null ? {} : { 'begin-time-offset': String(start), 'end-time-offset': String(end) },
});
const docOf = (phrases) => ({ title: 'T', paragraphs: phrases.map((p) => ({ segments: [p] })), segments: [] });
const timed = docOf([phrase('satu', 0, 1000), phrase('dua', 1000, 2500), phrase('tiga', 2500, 4000)]);
const untimed = docOf([phrase('satu'), phrase('dua')]);
const empty = { title: 'T', paragraphs: [], segments: [] };
const blob = (n) => ({ size: n, async arrayBuffer() { return new ArrayBuffer(n); } });

console.log('\nwhich rows a pair can produce — the Files ▾ logic, on loose files');
{
  const withAudio = loosePlan({ doc: timed, hasAudio: true, audioBytes: 2_000_000, isWav: true });
  ok(withAudio.elan.ok && withAudio.saymore.ok && withAudio.preview.ok && withAudio.fxpa.ok,
     'a timed text + a recording offers every row');
  ok(withAudio.alignedRows === 3 && withAudio.spanEnd === 4000, 'and reports what it found (3 rows, ends 4000ms)');

  const noAudio = loosePlan({ doc: timed, hasAudio: false });
  ok(noAudio.elan.ok, 'NO audio still offers the ELAN package — serializeEaf needs times, not sound');
  ok(!noAudio.saymore.ok && noAudio.saymore.reason === 'noAudio',
     '…but not SayMore, whose whole convention is the audio filename');
  ok(!noAudio.preview.ok && noAudio.preview.reason === 'noAudio', '…nor a listening page with nothing to listen to');
  ok(noAudio.fxpa.ok && !noAudio.fxpaAudio, '…and the .fxpa rides text-only');

  const noTimes = loosePlan({ doc: untimed, hasAudio: true, audioBytes: 1000, isWav: true });
  ok(!noTimes.elan.ok && noTimes.elan.reason === 'noAlign', 'an UNALIGNED text cannot make an EAF');
  ok(noTimes.fxpa.ok, '…but still makes a .fxpa — grouping is what that file is for');

  const none = loosePlan({ doc: empty, hasAudio: true, audioBytes: 1000, isWav: true });
  ok(!none.fxpa.ok && none.fxpa.reason === 'noText' && !none.flextext.ok,
     'a text with NO phrase rows offers nothing at all — an empty .fxpa the other app refuses is worse than a refusal');
}

console.log('\nthe alignment a foreign file can carry, and an EAF cannot');
{
  ok(alignmentIsOrdered([{ span: { start: 0, end: 10 } }, { span: { start: 10, end: 20 } }]), 'in order is fine');
  ok(alignmentIsOrdered([{ span: { start: 0, end: 10 } }, { span: null }, { span: { start: 10, end: 20 } }]),
     'a gap for an untimed phrase is fine');
  ok(!alignmentIsOrdered([{ span: { start: 0, end: 100 } }, { span: { start: 50, end: 200 } }]),
     'OVERLAPPING phrases are not — that is an EAF ELAN will not open');
  ok(!alignmentIsOrdered([{ span: { start: 100, end: 200 } }, { span: { start: 0, end: 50 } }]),
     'and neither is backwards');
  const bad = docOf([phrase('a', 0, 5000), phrase('b', 2000, 6000)]);
  ok(loosePlan({ doc: bad, hasAudio: true, audioBytes: 1000, isWav: true }).elan.reason === 'badAlign',
     'so the row is greyed with its own reason BEFORE the build, not after');
}

console.log('\ndo the two files even belong together? (the menu never has to ask; this tool does)');
{
  ok(durationVerdict({ spanEndMs: 4000, durationMs: 5000 }) === 'ok', 'text ends before the recording does — fine');
  ok(durationVerdict({ spanEndMs: 4000, durationMs: 60_000 }) === 'ok',
     'a much LONGER recording is fine too — trailing silence is normal and must never be flagged');
  ok(durationVerdict({ spanEndMs: 60_000, durationMs: 4000 }) === 'short',
     'but a text that runs past the end of the audio is the wrong pair');
  ok(durationVerdict({ spanEndMs: 4000, durationMs: 3999 }) === 'ok', 'and a hair over is rounding, not a mismatch');
  ok(durationVerdict({ spanEndMs: 4000, durationMs: 0 }) === 'unknown', 'an undecodable duration says so');
}

console.log('\nPARITY with the Files ▾ menu — the same wants, the same full, the same names');
{
  const menu = panel.match(/const wants = \{ elan:[^\n]*\n/)[0];
  ok(/elan: \{ eaf: true \}/.test(menu) && /saymore: \{ saymore: true \}/.test(menu)
     && /preview: \{ preview: true \}/.test(menu) && /fxpa: \{ fxpa: true \}/.test(menu),
     'the menu maps kind → wants as expected (if this fails, the menu changed and so must we)');
  const mine = seg.match(/const wants = \{ elan: \{ eaf: true \}[\s\S]*?\}\[kind\];/)[0];
  ok(/elan: \{ eaf: true \}/.test(mine) && /saymore: \{ saymore: true \}/.test(mine)
     && /preview: \{ preview: true \}/.test(mine) && /fxpa: \{ fxpa: true \}/.test(mine),
     'and the converter maps them identically');
  ok(/const full = kind === 'preview' \|\| kind === 'fxpa';/.test(seg),
     'preview and fxpa are the embedded-audio outputs, exactly as the menu decides it');
  ok(/full: kind === 'preview' \|\| kind === 'fxpa'/.test(panel), '…which is what the menu says too');
}

console.log('\nwhat actually comes out');
{
  const wav = { blob: blob(1000), name: 'story.wav', mimeType: 'audio/wav' };
  const plan = loosePlan({ doc: timed, hasAudio: true, audioBytes: 1000, isWav: true });

  const elan = await buildLooseConversion({ kind: 'elan', doc: timed, base: 'Story', title: 'Story', audio: wav, plan });
  const names = elan.entries.map((e) => e.name);
  ok(elan.zip && elan.saveName === 'Story ELAN.zip', `ELAN comes out as a zip named for the story ("${elan.saveName}")`);
  ok(names.includes('Story.eaf') && names.includes('Story.pfsx'),
     `with the .eaf AND its .pfsx sidecar (${names.join(', ')})`);
  ok(names.includes('Story.wav'),
     'and the recording itself, because the EAF references it by name — an already-WAV source is not pushed by the assembler');
  ok(names.includes('HOW-TO-OPEN.txt'), 'plus the instructions that travel with every bundle');

  const sm = await buildLooseConversion({ kind: 'saymore', doc: timed, base: 'Story', audio: wav, plan });
  ok(sm.entries.some((e) => /\.annotations\.eaf$/.test(e.name)),
     'SayMore uses its own <mediafile>.annotations.eaf convention');

  const fx = await buildLooseConversion({ kind: 'fxpa', doc: timed, base: 'Story', audio: wav, plan });
  ok(!fx.zip && fx.saveName === 'Story.fxpa' && fx.entries.length === 1,
     'the .fxpa is a single bare file, not a zip');

  const noAudio = await buildLooseConversion({ kind: 'elan', doc: timed, base: 'Story' });
  const nn = noAudio.entries.map((e) => e.name);
  ok(noAudio.zip && nn.includes('Story.eaf') && nn.includes('Story.pfsx') && nn.length === 2,
     `a TEXT-ONLY ELAN package is exactly the two files (${nn.join(', ')})`);
  ok(noAudio.notes.includes('eafNoMedia'), '…and says so, rather than looking like a normal one');
  ok(!/MEDIA_DESCRIPTOR/.test(await noAudio.entries[0].data.text()),
     'the EAF omits the media descriptor entirely — a legal ELAN file, not a broken reference');

  const ft = await buildLooseConversion({ kind: 'flextext', base: 'Story', flextextBlob: blob(5) });
  ok(!ft.zip && ft.saveName === 'Story.flextext' && ft.entries[0].data.size === 5,
     'and the .flextext passes through byte-for-byte — never re-serialized');
}

/* Seth, 2026-08-15: "If there's more than one file, build a ZIP just like our built in converter for
 * Google Drive files already does." So the packaging decision is a COUNT, not a per-kind table —
 * which is also the download-all path's own rule, and the reason it can never hand someone a zip
 * they have to open to find one file inside. */
console.log('\nmore than one file ⇒ a zip; exactly one ⇒ the file itself');
{
  const wav = { blob: blob(1000), name: 'story.wav', mimeType: 'audio/wav' };
  const plan = loosePlan({ doc: timed, hasAudio: true, audioBytes: 1000, isWav: true });
  for (const kind of ['elan', 'saymore']) {
    const r = await buildLooseConversion({ kind, doc: timed, base: 'Story', title: 'Story', audio: wav, plan });
    ok(r.entries.length > 1 && r.zip && /\.zip$/.test(r.saveName),
       `${kind} carries ${r.entries.length} files, so it is a zip (${r.saveName})`);
  }
  for (const kind of ['preview', 'fxpa', 'flextext']) {
    const r = await buildLooseConversion({ kind, doc: timed, base: 'Story', title: 'Story', audio: wav, plan,
      flextextBlob: blob(5) });
    ok(r.entries.length === 1 && !r.zip && r.saveName === r.entries[0].name,
       `${kind} is one file, so it is handed over as itself (${r.saveName})`);
  }
  /* ⚠ THE RULE IS READ OFF THE ENTRY COUNT, not off `kind`. Pinning the mechanism matters because a
   * per-kind table is the tempting "simplification", and it is the one that reintroduces one-item
   * zips the first time a build produces fewer files than it does today. */
  ok(/list\.length > 1/.test(seg), 'and the decision is made from the number of entries, not from the kind');
}

console.log('\nan undecodable recording degrades instead of killing the build');
{
  const lossy = { blob: blob(2000), name: 'story.m4a', mimeType: 'audio/x-m4a' };
  const plan = loosePlan({ doc: timed, hasAudio: true, audioBytes: 2000, isWav: false });
  const boom = await buildLooseConversion({ kind: 'elan', doc: timed, base: 'S', audio: lossy, plan,
    convertWav: async () => { throw new Error('EncodingError'); } });
  ok(boom.entries.some((e) => e.name === 'S.eaf'), 'the ELAN package is still produced');
  ok(boom.notes.includes('lossyTiming'), '…with a note that the original rode unconverted');
  const none = await buildLooseConversion({ kind: 'elan', doc: timed, base: 'S', audio: lossy, plan,
    convertWav: async () => null });
  ok(none.notes.includes('lossyTiming'), 'and a converter that simply declines is the same story');
}

/* ⚠ THE WIDGET EXISTS TWICE — once in the editor's Utilities tab, once as a panel modal — because
 * there is no shared UI layer between a static section and a built modal. That duplication is only
 * safe while the DECISIONS stay in seg-exports; the moment either copy starts deciding for itself,
 * the two surfaces make different files from the same two files and nobody finds out. */
console.log('\nboth surfaces defer to the shared planner rather than re-deciding');
{
  const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
  for (const [name, src] of [['editor', app], ['panel', panel]]) {
    ok(/loosePlan\(\{ doc:/.test(src) && /buildLooseConversion\(\{/.test(src),
       `the ${name} asks loosePlan which rows are possible and buildLooseConversion for the bytes`);
    ok(/durationVerdict\(\{ spanEndMs:/.test(src), `…and durationVerdict whether the pair matches (${name})`);
    /* No local wants/full table: that is the one thing that must never be re-typed, because a copy
     * of it looks right in review and silently drops a file from a package. */
    ok(!/const wants = \{ (eaf|elan):/.test(src.slice(src.indexOf(name === 'editor' ? 'wireFileExporter' : 'fileExporterModal'))),
       `…and the ${name}'s exporter carries no wants table of its own`);
    ok(/\['elan', 'saymore', 'preview', 'fxpa', 'flextext'\]/.test(src), `the same five rows, in the same order (${name})`);
  }
}

console.log('\nevery string both surfaces reach for exists in BOTH languages');
{
  const i18n = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
  // The literal keys, plus the two that are built by suffix (t('exp.row.' + kind)).
  const keys = new Set([...(app + panel + html).matchAll(/'(exp\.[a-z][a-zA-Z.]*)'/g)].map((m) => m[1]));
  for (const kind of ['elan', 'saymore', 'preview', 'fxpa', 'flextext']) { keys.add('exp.row.' + kind); keys.add('exp.sub.' + kind); }
  /* ⚠ DERIVE THE PHASE CODES FROM THE SOURCE, never from a list typed here. The first version of
   * this test matched `say('code')` and so missed `say(cond ? 'embedding' : 'annotations')` —
   * 'embedding' was emitted with no string behind it, and the status line would have shown the raw
   * key `exp.phase.embedding` to anyone building a listening page. A hand-kept list of what the
   * builder emits is a list that goes stale the first time somebody adds a branch. */
  const phases = [...seg.matchAll(/\bsay\(([^)]*)\)/g)]
    .flatMap((m) => [...m[1].matchAll(/'([a-zA-Z]+)'/g)].map((x) => x[1]));
  ok(phases.length >= 3, `the builder emits ${phases.length} phase codes (${[...new Set(phases)].join(', ')})`);
  for (const ph of phases) keys.add('exp.phase.' + ph);
  keys.delete('exp.row.'); keys.delete('exp.sub.'); keys.delete('exp.phase.');
  /* ⚠ TWO, not one. A key present only in `en` renders as the raw key on an Indonesian device —
   * which is what the field devices are set to, so a miss here is invisible to us and glaring to
   * the person using it. */
  const missing = [...keys].filter((k) => (i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || []).length !== 2);
  ok(!missing.length, `all ${keys.size} exp.* strings are defined in en AND id${missing.length ? ' — missing: ' + missing.join(', ') : ''}`);
  // The reason codes loosePlan can return must each have a sentence on both surfaces.
  for (const code of ['noText', 'noAudio', 'noAlign', 'badAlign', 'tooBig']) {
    ok(new RegExp(`${code}:`).test(app) && new RegExp(`${code}:`).test(panel), `the '${code}' refusal is explained on both surfaces`);
  }
  // …and so must every note buildLooseConversion can attach.
  const notes = [...seg.matchAll(/notes\.push\('([a-zA-Z]+)'\)/g)].map((m) => m[1]);
  ok(notes.length > 0, `the builder attaches notes (${notes.join(', ')})`);
  for (const n of new Set(notes)) {
    ok(new RegExp(`${n}:`).test(app) && new RegExp(`${n}:`).test(panel), `the '${n}' note is translated on both surfaces`);
  }
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
