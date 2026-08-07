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

const run = async (files) => {
  const captured = {};
  const fakeBlob = (name) => ({ __blob: name, size: 10, type: 'application/zip' });
  const env = {
    t: () => 'building',
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
                querySelector: () => ({ textContent: '' }) };
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

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASSED\n');
process.exit(fail ? 1 : 0);
