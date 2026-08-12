/* The panel's "download everything in this text's Drive folder" button.
 *
 * WHY THIS TEST EXISTS (Seth, 2026-08-07): "my panel app is getting a zip file as a result of its
 * download request and is packaging it up inside an unnecessary outer zip." It was. A device
 * uploads its text as a single BUNDLE .zip, so a text uploaded once has exactly ONE file in its
 * Drive folder — and this function wrapped it, producing a zip whose only member was another zip.
 * On a Mac that errors outright. Where it does not, it is worse, because it quietly works: the
 * flextext ends up inside the inner archive, and the people this suite is for are exactly the ones
 * who will not distinguish a folder from an archive and will report that the app cannot find their
 * text.
 *
 * ⚠ THE ZIP CANNOT SIMPLY BE DROPPED. Drive has no folder-as-zip endpoint for an API client — the
 * web UI's folder download is an internal, cookie-authenticated route — and every byte here goes
 * through the Worker on the researcher's token. So bundling stays; it just has to stop firing for
 * a single file. Both halves are asserted, because "fixing" this by never zipping would break the
 * backups case silently.
 *
 * The real function is LIFTED out of researcher-panel.js and run against a fake Drive, so this
 * tests the shipped code rather than a description of it.
 *
 * Run: node test/drive-download.test.mjs
 */
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const m = src.match(/async function downloadAllZip\(btn\) \{[\s\S]*?\n\}/);
if (!m) { console.log('FAIL: downloadAllZip not findable'); process.exit(1); }

let fail = 0;
const ok = (c, msg) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${msg}`); if (!c) fail++; };

/* `wrap` opts in to the v3.1 conversion-injection path: downloadAllZip reaches its menu through
 * btn.closest('.rp-dl'), so a btn without one (the original cases below) skips conversions
 * entirely — which is exactly the degradation a legacy/no-manifest text gets. */
const run = async (files, wrap = null, convo = {}) => {
  const captured = {};
  const fakeBlob = (name) => ({ __blob: name, size: 10, type: 'application/zip' });
  const env = {
    t: (k) => (k === 'panel.dl.zipConverting' ? 'converting' : 'building'),
    deps: { toast: (m) => { captured.toast = m; } },
    console: { warn: () => {} },
    prepareConversionSources: async () => {
      captured.prepared = true;
      if (convo.throws) throw new Error('boom');
      return convo.src || { doc: {}, aligned: true, vern: 'fau', anal: 'id',
                            media: {}, segMedia: { name: 'T.wav' }, tooBig: false };
    },
    buildSegEntriesFor: async () => (convo.entries || [
      { name: 'My Text.eaf', data: fakeBlob('eaf') },
      { name: 'My Text.pfsx', data: fakeBlob('pfsx') },
      { name: 'My Text.preview.html', data: fakeBlob('prev') },
      { name: 'My Text.fxpa', data: fakeBlob('fxpa') },
    ]),
    bridgedIds: () => ({ ids: ['doc1'] }),
    Researcher: {
      listTextFiles: async () => ({ files }),
      fetchDriveFile: async (id) => fakeBlob(id),
    },
    makeZip: async (entries) => { captured.zipped = entries.map((e) => e.name); return { __blob: 'ZIP', size: 99 }; },
    URL: { createObjectURL: (b) => { captured.blob = b; return 'blob:x'; }, revokeObjectURL: () => {} },
    document: { createElement: () => ({ set download(v) { captured.download = v; }, get download() { return captured.download; },
                                        click() {}, remove() {}, set href(v) {}, }),
                body: { appendChild() {} } },
    setTimeout: () => {},
  };
  const btn = { dataset: { i: 'i1', id: 'doc1', title: 'My Text' }, disabled: false,
                querySelector: () => ({ textContent: '' }),
                ...(wrap ? { closest: () => wrap } : {}) };
  const fn = new Function(...Object.keys(env), `return (${m[0].replace('async function downloadAllZip', 'async function')})`)(...Object.values(env));
  await fn(btn);
  return captured;
};

console.log('\nONE file in the folder — the reported bug');
{
  const c = await run([{ id: 'bundle1', name: 'My Text 2026-08-07 1820.zip', modified: '2026-08-07' }]);
  ok(c.zipped === undefined, 'makeZip was NOT called — nothing re-wraps a lone file');
  ok(c.blob && c.blob.__blob === 'bundle1', 'the Drive file itself is what gets handed over');
  ok(c.download === 'My Text 2026-08-07 1820.zip',
     `and it keeps its own name, timestamp and all: ${JSON.stringify(c.download)}`);
}

console.log('\nSEVERAL files — the zip still earns its place');
{
  const c = await run([
    { id: 'b1', name: 'My Text 2026-08-07 1820.zip', modified: '2026-08-07' },
    { id: 'b2', name: 'My Text 2026-08-06 0910.zip', modified: '2026-08-06' },
  ]);
  ok(Array.isArray(c.zipped) && c.zipped.length === 2, 'makeZip bundles both');
  ok(c.download === 'My Text.zip', `named for the text: ${JSON.stringify(c.download)}`);
  ok(c.blob && c.blob.__blob === 'ZIP', 'and the zip is what downloads');
}

console.log('\nduplicate names across backups still get disambiguated');
{
  const c = await run([
    { id: 'b1', name: 'bundle.zip', modified: '2026-08-07' },
    { id: 'b2', name: 'bundle.zip', modified: '2026-08-06' },
  ]);
  ok(c.zipped && new Set(c.zipped).size === 2, `unique entry names: ${JSON.stringify(c.zipped)}`);
}

/* ---------------------------------------------------------------------------------------------
 * v3.1: Download-all also BUILDS the exports and injects them (Seth, 2026-08-12: "can our Download
 * All zip also generate and inject ELAN and Saymore as well as Listening HTML and fxpa into that
 * zip?").
 *
 * ⚠ THE RULE THAT MATTERS MOST IS THE DEGRADATION. The raw bytes are what the researcher actually
 * asked for; the generated files are a bonus. A bonus that can take the request down with it is a
 * regression, and it would only show up on the texts where conversion is hardest — big audio, no
 * alignment, a parse failure — i.e. exactly the ones a researcher most needs the originals from.
 * So every failure mode below asserts that the FOLDER still downloads.
 * ------------------------------------------------------------------------------------------- */
const menuWrap = { _menuSrc: { manifest: { schema: 1, writingSystems: { vern: 'fau', anal: 'id' } }, base: 'My Text' } };

console.log('\ngenerated exports are injected beside the folder files');
{
  const c = await run([{ id: 'ft', name: 'My Text.flextext', modified: '2026-08-10' },
                       { id: 'au', name: 'My Text.mp3', modified: '2026-08-10' }], menuWrap);
  ok(c.prepared, 'the shared conversion sources are prepared (same ones the menu rows use)');
  ok(c.zipped && c.zipped.includes('My Text.flextext') && c.zipped.includes('My Text.mp3'),
     'the folder files are all still there');
  for (const n of ['My Text.eaf', 'My Text.pfsx', 'My Text.preview.html', 'My Text.fxpa']) {
    ok(c.zipped.includes(n), `...and ${n} was built and injected`);
  }
  ok(new Set(c.zipped).size === c.zipped.length, 'entry names stay unique across both sources');
}

console.log('\n...and a name clash with a real folder file is disambiguated, not overwritten');
{
  // The folder already holds a hand-uploaded My Text.eaf. Losing either copy silently would be bad:
  // one is the researcher's own file, the other is freshly built from the current flextext.
  const c = await run([{ id: 'e1', name: 'My Text.eaf', modified: '2026-08-10' }], menuWrap);
  ok(c.zipped.filter((n) => /^My Text( \(\d\))?\.eaf$/.test(n)).length === 2,
     `both survive under distinct names: ${JSON.stringify(c.zipped.filter((n) => n.includes('.eaf')))}`);
}

console.log('\nEVERY conversion failure still delivers the folder');
{
  const thrown = await run([{ id: 'ft', name: 'My Text.flextext', modified: '2026-08-10' }], menuWrap, { throws: true });
  ok(thrown.zipped ? thrown.zipped.includes('My Text.flextext') : thrown.blob.__blob === 'ft',
     'a conversion that THROWS does not take the download with it');
  ok(!!thrown.toast, '...and the researcher is told the exports were skipped');

  const tooBig = await run([{ id: 'ft', name: 'My Text.flextext', modified: '2026-08-10' },
                            { id: 'au', name: 'big.wav', modified: '2026-08-10' }], menuWrap,
                           { src: { doc: {}, aligned: true, tooBig: true } });
  ok(tooBig.zipped && tooBig.zipped.includes('big.wav'),
     'audio too large to decode in a tab: the ORIGINAL still downloads, which is the point');
  ok(!!tooBig.toast, '...with an explanation rather than silence');

  const bad = await run([{ id: 'ft', name: 'My Text.flextext', modified: '2026-08-10' }], menuWrap,
                        { src: { error: 'unparseable' } });
  ok(bad.blob || bad.zipped, 'an unparseable flextext still yields the folder');
}

console.log('\nno manifest means no conversion attempt at all');
{
  // A pre-v2 text has no Download-all row in the menu, but the guard is asserted here too: the
  // conversions need a manifest for its writing systems and title base.
  const c = await run([{ id: 'a', name: 'a.flextext', modified: '2026-08-10' },
                       { id: 'b', name: 'b.mp3', modified: '2026-08-09' }], { _menuSrc: { manifest: null } });
  ok(!c.prepared, 'prepareConversionSources is never called');
  ok(c.zipped && c.zipped.length === 2, 'and the folder downloads exactly as before');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASSED\n');
process.exit(fail ? 1 : 0);
