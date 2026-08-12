/* The Files ▾ menu is built on `flextext-manifest.json` — and has exactly TWO states.
 *
 * WHY THIS TEST EXISTS: the menu's previous incarnation inferred what a text's files were by
 * sniffing extensions, guessed wrong often enough that Seth parked the whole drop-down
 * ("the download files function is kind of all out of whack"), and its most memorable failure was
 * offering "Bundle (.zip, includes audio)" and delivering raw flextext XML. The v3 work order
 * deletes that machinery rather than repairing it — *"the inferred menu has actually never worked
 * correctly and it's not worth our time making it work correctly if it's just a fallback"* — and
 * replaces it with two states that cannot be wrong:
 *
 *   manifest present → the fixed item list, named from the manifest and the folder's role tags;
 *   manifest absent  → ONE item, "Open the Drive folder ↗". A folder link cannot be wrong.
 *
 * THE FAILURE MODE THIS GUARDS is that both halves look fine in isolation. A menu that silently
 * falls back to reconstructing rows is indistinguishable from a working one until a researcher
 * clicks a row that lies — which is exactly how the last version survived review and reached the
 * field. So the no-manifest case is asserted as ONE item, by count, not merely as "has a link".
 *
 * The real populateFilesMenu is LIFTED out of researcher-panel.js and run against a fake Drive
 * (drive-download.test.mjs's technique), so this exercises the shipped code rather than a
 * description of it.
 *
 * Run: node test/files-menu-manifest.test.mjs
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
let fail = 0;
const ok = (c, msg) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${msg}`); if (!c) fail++; };

const grab = (re, what) => { const m = src.match(re); if (!m) { console.log(`FAIL: ${what} not findable`); process.exit(1); } return m[0]; };
const menuSrc = grab(/async function populateFilesMenu\(wrap\) \{[\s\S]*?\n\}\n/, 'populateFilesMenu');
const rolesSrc = grab(/const SOURCE_AUDIO_ROLES = [\s\S]*?const isFlextextName = [^;]*;/, 'the role sets');
const pickSrc = grab(/function pickSourceFiles\(files\) \{[\s\S]*?\n\}/, 'pickSourceFiles');
const cleanSrc = grab(/function cleanupCandidates\(allFiles\) \{[\s\S]*?\n\}/, 'cleanupCandidates');

const MANIFEST_NAME = 'flextext-manifest.json';

/* Run the real menu builder over a fake folder. `manifest` is the JSON body the manifest file
 * returns, or null to serve no manifest file at all. Returns the rendered HTML plus the row count. */
async function runMenu(files, manifest, { folderId = 'FOLDER_abc123def' } = {}) {
  let html = '';
  const menuEl = { set innerHTML(v) { html = v; }, get innerHTML() { return html; } };
  const wrap = { dataset: { i: 'i1', id: 'doc1', title: 'Kisah Rusa' }, querySelector: () => menuEl };
  const env = {
    /* i18n mimicking the REAL t(): a known key translates, an unknown key returns itself
     * (i18n.js: `S[cur][key] ?? S.en[key] ?? key`). That fallback is precisely what the origin
     * label tests for, so a fake that echoed every key would defeat the assertion it exists for. */
    t: (k, vars) => {
      const known = {
        'panel.dl.origin.assigned': 'assigned',
        'panel.dl.origin.recorded': 'recorded on the device',
        'panel.dl.origin.imported': 'imported',
      };
      const s = known[k] || k;
      return vars ? `${s}(${JSON.stringify(vars)})` : s;
    },
    esc: (s) => String(s == null ? '' : s),
    fmtSize: (b) => `${b}B`,
    sanitizeBase: (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 120),
    MANIFEST_NAME,
    bridgedIds: () => ({ ids: ['doc1'], audioUrl: '', latestEventFileId: '' }),
    driveFolderLink: (id) => (/^[\w-]{10,}$/.test(String(id)) ? `https://drive.google.com/drive/folders/${id}` : ''),
    Researcher: { listTextFiles: async () => ({ files, folderId }) },
    // menuFetch returns the manifest bytes for the manifest file id.
    menuFetch: async () => ({ text: async () => (manifest === null ? 'not json' : JSON.stringify(manifest)) }),
    console: { warn() {} },
  };
  const fn = new Function(...Object.keys(env), `
    ${rolesSrc}
    ${pickSrc}
    ${cleanSrc}
    return (${menuSrc.replace('async function populateFilesMenu', 'async function')});
  `)(...Object.values(env));
  await fn(wrap);
  // Rows are <a>/<button>/<span class="rp-dl-item"> elements; the head is not a row.
  const rows = (html.match(/class="rp-dl-item/g) || []).length;
  return { html, rows, wrap };
}

const file = (name, role = '', modified = '2026-08-10T00:00:00Z', size = 100, id = null) =>
  ({ id: id || 'id-' + name, name, role, modified, size, mime: '' });

const MANIFEST = {
  schema: 1, docId: 'doc1', title: 'Kisah Rusa', origin: 'recorded',
  writingSystems: { vern: 'fau', anal: 'id' },
  audio: { name: 'Kisah Rusa.mp3', mime: 'audio/mpeg', bytes: 5000000, derived: false },
  files: [
    { name: MANIFEST_NAME, role: 'manifest', mime: 'application/json', bytes: 0 },
    { name: 'Kisah Rusa.mp3', role: 'source-audio', mime: 'audio/mpeg', bytes: 5000000 },
  ],
  consent: { mode: 'text', prompt: false, response: true, receipt: true },
};
// ⚠ The audio's Drive size is the REAL 5 MB: when a file has arrived, Drive is the truth and the
// manifest's declared byte count is only the fallback for one that has not.
const FULL_FOLDER = [
  file('Kisah Rusa 2026-08-10.flextext'),
  file('Kisah Rusa.mp3', 'source-audio', '2026-08-10T00:00:00Z', 5000000),
  file(MANIFEST_NAME, 'manifest'),
  file('consent-response.mp3', 'consent-clip'),
];

console.log('\nNO MANIFEST → exactly TWO items: download everything, or open the folder');
{
  /* A pre-v2 text: real files in the folder, no manifest anywhere. The old code reconstructed a
   * whole menu from these by sniffing extensions; v3 stopped trying.
   *
   * ⚠ THE INVARIANT IS "NO ROW MAKES A CLAIM", not "only one row". Seth added Download-all here on
   * 2026-08-12, and it does not reopen the heuristic: what was deleted were rows that asserted a
   * file's KIND ("Bundle (.zip, includes audio)" on what turned out to be raw XML). Neither of
   * these two does — one opens the folder, the other hands over every byte under each file's own
   * name. So the assertions below pin the ABSENCE of claim-making rows, and the count, rather than
   * a bare count that would have to be edited every time a safe row is added. */
  const { html, rows } = await runMenu([
    file('Kisah Rusa 2026-08-01.flextext'), file('Kisah Rusa.mp3'), file('bundle.zip'),
  ], undefined);
  ok(rows === 2, `exactly two rows, whatever else is in the folder (got ${rows})`);
  ok(html.includes('data-zipall'), 'Download-all is offered — it needs no manifest to be correct');
  ok(html.includes('panel.dl.allSubRaw'),
     '...labelled as the RAW folder: nothing is generated here, so nothing may be promised');
  ok(html.includes('panel.dl.openFolder'), 'and the folder link');
  ok(html.includes('https://drive.google.com/drive/folders/FOLDER_abc123def'), 'pointing at the real folder id');
  // The regression to guard: any row that claims to know what a file IS.
  ok(!html.includes('data-conv='), 'no conversion rows are offered without a manifest');
  ok(!html.includes('data-drivefile='), 'and no per-file rows are reconstructed');
  ok(!html.includes('data-cleanup'), 'and cleanup is not offered on a folder we have no manifest for');
}

console.log('\n...and an EMPTY folder still offers only the link, never a zip of nothing');
{
  const { html, rows } = await runMenu([], undefined);
  ok(rows === 1 && html.includes('panel.dl.openFolder'), 'no files -> just the folder link');
  ok(!html.includes('data-zipall'), 'Download-all is not offered when there is nothing to download');
}

console.log('\n...and an UNREADABLE manifest is treated as none, never as a broken menu');
{
  // An unreadable manifest must land in the SAME safe state as no manifest at all — never in a
  // half-built menu whose rows were derived from a body we could not actually parse.
  const files = [file(MANIFEST_NAME, 'manifest'), file('Kisah Rusa.mp3', 'source-audio')];
  const { html } = await runMenu(files, null);   // body is not JSON
  ok(html.includes('panel.dl.openFolder') && !html.includes('data-conv='),
     'garbage JSON falls back to the no-manifest state');
  const wrongShape = await runMenu(files, { schema: 1, files: 'not an array' });
  ok(wrongShape.html.includes('panel.dl.openFolder') && !wrongShape.html.includes('data-conv='),
     'and so does a manifest whose files[] is not a list — a wrong shape is not a manifest');
  ok(!wrongShape.html.includes('data-drivefile='), '...with no per-file rows either');
}

console.log('\n...and with no manifest AND no folder id, it says so rather than showing an empty menu');
{
  const { html } = await runMenu([], undefined, { folderId: '' });
  ok(html.includes('panel.dl.noneYet'), 'the honest empty state');
  ok(!html.includes('href="https://drive.google.com/drive/folders/"'), 'and never a link to nowhere');
}

console.log('\nMANIFEST PRESENT → the fixed item list, named from the manifest');
{
  const { html } = await runMenu(FULL_FOLDER, MANIFEST);
  ok(html.includes('panel.dl.audio'), '1. original audio');
  ok(html.includes('data-drivefile="id-Kisah Rusa.mp3"'), '...routed through the Worker by Drive id');
  ok(html.includes('panel.dl.flextext'), '2. most recent flextext');
  for (const [n, k] of [[3, 'elan'], [4, 'saymore'], [5, 'preview'], [6, 'fxpa']]) {
    ok(html.includes(`data-conv="${k}"`), `${n}. the ${k} conversion`);
  }
  ok(html.includes('data-zipall'), 'plus Download-all');
  ok(html.includes('panel.dl.openFolder'), 'and the folder link stays available alongside');
}

console.log('\nthe ORIGIN label tells the researcher how the text came to exist');
{
  const rec = await runMenu(FULL_FOLDER, MANIFEST);
  ok(rec.html.includes('recorded on the device'), 'a recorded text says so');
  const asg = await runMenu(FULL_FOLDER, { ...MANIFEST, origin: 'assigned' });
  ok(asg.html.includes('assigned'), 'an assigned text says so');
  /* Additive by design: "a new origin value must never break an old reader". t() returns the KEY
   * when a string is missing, which the menu detects and degrades to the raw value. */
  const future = await runMenu(FULL_FOLDER, { ...MANIFEST, origin: 'some-future-origin' });
  ok(future.html.includes('some-future-origin'), 'an origin this build has never heard of degrades to its raw value');
  ok(!future.html.includes('panel.dl.origin.some-future-origin'), '...and never shows a raw i18n key');
}

console.log('\na DECLARED file that has not arrived is NAMED, not silently omitted');
{
  /* The manifest is written FIRST precisely so the incomplete window is legible: a consumer compares
   * the declared list against the folder and can say WHICH piece is missing. Completeness is
   * DERIVED here, never read from a stored flag — a flag would go stale on the first failed write
   * and then assert the opposite of the truth. */
  const noAudioYet = [file('Kisah Rusa 2026-08-10.flextext'), file(MANIFEST_NAME, 'manifest')];
  const { html } = await runMenu(noAudioYet, MANIFEST);
  ok(html.includes('panel.dl.notArrived'), 'the audio row reports "not uploaded yet"');
  ok(html.includes('Kisah Rusa.mp3'), '...naming the specific file that is missing');
  ok(html.includes('rp-dl-pending'), 'and it is inert, not a link to nothing');
  ok(html.includes('panel.dl.missing'), 'a summary line names everything still to arrive');
  ok(!html.includes('data-conv="elan"'), 'conversions needing audio are not offered while it is absent');
  ok(html.includes('data-conv="fxpa"'), '...but the text-only .fxpa still is');
}

console.log('\nconversion rows carry a SIZE ESTIMATE before the click');
{
  // §8: "sizes the conversions before a click — the big-file guard gets a real number instead of a
  // download-then-discover". A lossy source decodes to PCM at roughly 10x its compressed size.
  const { html } = await runMenu(FULL_FOLDER, MANIFEST);
  ok(html.includes('panel.dl.approx'), 'the estimate is rendered');
  ok(html.includes('50000000B'), 'a 5 MB lossy source estimates ~50 MB decoded');
  const wavM = { ...MANIFEST, audio: { name: 'Kisah Rusa.wav', mime: 'audio/wav', bytes: 5000000 } };
  const wavFolder = [file('a.flextext'), file('Kisah Rusa.wav', 'source-audio', '2026-08-10T00:00:00Z', 5000000),
                     file(MANIFEST_NAME, 'manifest')];
  const w = await runMenu(wavFolder, wavM);
  ok(w.html.includes('5000000B') && !w.html.includes('50000000B'), 'a WAV source is not multiplied — it is already PCM');
}

console.log('\nthe recording package is offered only when consent is DECLARED');
{
  const withConsent = await runMenu(FULL_FOLDER, MANIFEST);
  ok(withConsent.html.includes('data-conv="package"'), 'declared consent artifacts → the package row appears');
  const none = { ...MANIFEST, consent: { mode: 'off', prompt: false, response: false, receipt: false } };
  const bare = [file('a.flextext'), file('Kisah Rusa.mp3', 'source-audio'), file(MANIFEST_NAME, 'manifest')];
  const noConsent = await runMenu(bare, none);
  ok(!noConsent.html.includes('data-conv="package"'),
     'nothing declared and nothing present → no package row (an IRB package missing its consent record is worse than no button)');
}

console.log('\ncleanup is offered only when there is actually something to clean');
{
  const one = await runMenu(FULL_FOLDER, MANIFEST);
  ok(!one.html.includes('data-cleanup'), 'a single flextext copy offers no cleanup');
  const pileup = [...FULL_FOLDER,
    file('Kisah Rusa 2026-08-05.flextext', '', '2026-08-05T00:00:00Z'),
    file('Kisah Rusa 2026-08-01.flextext', '', '2026-08-01T00:00:00Z')];
  const many = await runMenu(pileup, MANIFEST);
  ok(many.html.includes('data-cleanup'), 'a backup pileup does');
  ok(many.wrap._cleanupIds && many.wrap._cleanupIds.length === 2, 'and it stages exactly the older copies');
}

console.log('\nthe menu hands the conversion runner what it needs');
{
  const { wrap } = await runMenu(FULL_FOLDER, MANIFEST);
  ok(wrap._menuSrc && wrap._menuSrc.manifest, 'the manifest is kept for the conversions');
  ok(wrap._menuSrc.base === 'Kisah Rusa', 'the filename base comes from the manifest title (the v3 naming rule)');
  ok(wrap._allFiles && wrap._allFiles.length === FULL_FOLDER.length, 'the whole folder is kept for Download-all');
  ok(wrap._cache instanceof Map, 'and a per-open byte cache exists so one fetch serves several rows');
}

console.log('\nthe menu can actually DISPLAY what it builds');
{
  /* Reported 2026-08-12 with a screenshot: sub-lines ran off the right edge and were clipped.
   * The menu is a flex COLUMN, and a flex item's default `min-width: auto` refuses to shrink below
   * its content's intrinsic width — so the long sub-lines v3 introduced (origin label + real
   * filename + size estimate) made rows wider than the menu's own max-width. Because the menu sets
   * overflow-y:auto, overflow-x computes to auto and the excess was CLIPPED rather than visibly
   * scrolling, so it simply looked like missing text.
   *
   * Worth pinning because the CONTENT tests above all pass either way — every assertion in this
   * file is about the HTML, and the HTML was correct. Only a human looking at the rendered menu
   * could see it. */
  const css = readFileSync(new URL('../docs/css/app.css', import.meta.url), 'utf8');
  ok(/\.rp-dl-menu > \* \{[^}]*min-width: 0/.test(css),
     'menu children may shrink below their intrinsic width, so long rows wrap instead of overflowing');
  ok(/\.rp-dl-name, \.rp-dl-sub \{[^}]*overflow-wrap: anywhere/.test(css),
     'and a single long filename token wraps rather than forcing the row wide by another route');
  ok(/\.rp-dl-sub \{[^}]*display: block/.test(css) && !/\.rp-dl-sub \{[^}]*white-space: nowrap/.test(css),
     'the sub-line is never nowrap — that would defeat both of the above');
  // The rows v3 added need styling too, or "not arrived yet" reads as a clickable download.
  ok(/\.rp-dl-pending \{/.test(css), 'the not-yet-arrived row is styled as inert');
  ok(/\.rp-dl-missing \{/.test(css), 'and the still-to-arrive summary line is styled');
}

console.log('\nthe writing systems come from the MANIFEST, not a second round trip');
{
  ok(/const ws = \(manifest && manifest\.writingSystems\) \|\| \{\};/.test(src),
     'runMenuConversion reads writingSystems off the manifest');
  ok(/if \(!vern \|\| !anal\) \{[\s\S]{0,200}getInstanceSettings/.test(src),
     '...and only falls back to getInstanceSettings when the manifest does not say');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
