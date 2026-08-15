/* THE LOOSE-FILE CONVERTER, DRIVEN AS A PERSON DRIVES IT — two file pickers in the Utilities tab,
 * and the files that fall out.
 *
 * Seth, 2026-08-14: "exactly the same thing that our files drop down box already does for texts that
 * are on Google Drive, except that the user can submit their own flextext and matching audio file …
 * a backup way to do it with files they just happen to have lying around that match."
 *
 * ⚠ WHY A BROWSER TEST EXISTS AT ALL when test/loose-conversions.test.mjs already covers the
 * decisions: that suite runs seg-exports under a mini XML DOM in node, so it proves the PLANNER and
 * the BUILDER. It cannot prove the wiring — that the buttons reach the inputs, that parseFlextext
 * runs on a real File, that a row click produces a download with the right name, or that the whole
 * thing is even present on the page. Every one of those is a way to ship a dead feature that every
 * node test still passes.
 *
 * It is NOT part of the node suite (it needs a browser and a server). Run it deliberately:
 *
 *   cd docs && python3 -m http.server 8765 &
 *   node test/browser/loose-exporter.playwright.mjs
 *   FLEXTEXT_TEST_URL=http://localhost:8765/ node test/browser/loose-exporter.playwright.mjs
 */
import { chromium } from 'playwright-core';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.FLEXTEXT_TEST_URL || 'http://localhost:8765/';
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const dir = mkdtempSync(join(tmpdir(), 'fxexp-'));

// A 6-second mono 16-bit WAV — long enough for three timed phrases, small enough to build instantly.
function makeWav(path, secs) {
  const sr = 16000, n = Math.round(sr * secs);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * (i / sr)) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
  return path;
}

/* An ALIGNED flextext, shaped the way the editor's own export writes one: phrase begin/end-time-
 * offset attributes, which is what segmentsFromOffsets reads back. Nothing here is a fixture of our
 * own invention — it is the file a researcher would actually have lying around. */
function makeFlextext(path, phrases) {
  const ph = phrases.map(([txt, a, b], i) => `
      <phrase begin-time-offset="${a}" end-time-offset="${b}">
        <item type="segnum" lang="en">${i + 1}</item>
        <words><word><items><item type="txt" lang="fau">${txt}</item>
          <item type="gls" lang="id">g${i + 1}</item></items></word></words>
        <item type="gls" lang="id">free ${i + 1}</item>
      </phrase>`).join('');
  writeFileSync(path, `<?xml version="1.0" encoding="utf-8"?>
<document version="2"><interlinear-text guid="test-guid">
  <item type="title" lang="fau">Snakes We Eat</item>
  <paragraphs><paragraph><phrases>${ph}</phrases></paragraph></paragraphs>
  <languages><language lang="fau" vernacular="true"/><language lang="id"/></languages>
</interlinear-text></document>`);
  return path;
}

const wav = makeWav(join(dir, 'snakes.wav'), 6);
const ft = makeFlextext(join(dir, 'snakes.flextext'), [['satu', 0, 2000], ['dua', 2000, 4000], ['tiga', 4000, 6000]]);
// The same text with the LAST phrase running past the end of a 6s recording — the mismatch warning.
const ftLong = makeFlextext(join(dir, 'wrong-pair.flextext'), [['satu', 0, 2000], ['dua', 2000, 30000]]);
// And one with no offsets at all: the unaligned case, where only .fxpa and the passthrough survive.
const ftPlain = makeFlextext(join(dir, 'plain.flextext'), []).replace(/x/, 'x');
writeFileSync(join(dir, 'plain.flextext'), readFileSync(ft, 'utf8').replace(/ begin-time-offset="\d+" end-time-offset="\d+"/g, ''));

const browser = await chromium.launch({
  executablePath: process.env.FLEXTEXT_CHROME || undefined,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
page.on('pageerror', (e) => { console.log('   [pageerror]', e.message); fail++; });

/* ⚠ THE PANEL'S COPY OF THE WIDGET IS BEHIND A SIGN-IN, so nothing offline can reach it by clicking.
 * Rather than leave the second surface untested — the copy is exactly where a divergence would hide
 * — the module is served with ONE line appended that hands the modal out. The appended line is
 * test-only and never touches the repo; everything it exercises is the shipped code above it. */
await page.route('**/js/researcher-panel.js', async (route) => {
  const res = await route.fetch();
  route.fulfill({
    response: res,
    body: (await res.text()) + '\nwindow.__fxTestExporter = fileExporterModal;\n',
    headers: { ...res.headers(), 'content-type': 'text/javascript' },
  });
});

await page.goto(BASE + '?devreset', { waitUntil: 'load' });
await page.waitForTimeout(600);
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForTimeout(800);

const openUtilities = async () => {
  await page.click('.top-tab[data-view="utilities"]');
  await page.waitForTimeout(300);
};

console.log('\nthe widget is on the Utilities tab at all');
/* ⚠ ON AN UNPAIRED EDITOR, WITH NO REVEAL (Seth, 2026-08-15: "our utility here should be on the
 * utilities modal for both Researcher panel AND for unpaired Editor sessions"). This origin was
 * just ?devreset — no account, no pairing, no 7-taps-on-? — and the Utilities tab is right there.
 * Only the Settings tab is hidden behind the reveal (setResearchHidden), and if anyone ever gates
 * Utilities the same way, this line is what says the tool became unreachable for its main audience:
 * somebody with two files and no researcher. */
ok(await page.isVisible('.top-tab[data-view="utilities"]'), 'the Utilities tab is offered to an unpaired editor with no reveal');
await openUtilities();
ok(await page.isVisible('#ex-pick-ft'), 'the .flextext picker is there');
ok(await page.isVisible('#ex-pick-audio'), 'and the recording picker beside it');
ok(await page.isHidden('#ex-rows'), 'no rows before anything is chosen — an empty list of things you cannot do is noise');
/* ⚠ A missing i18n key renders as the raw key. That is invisible in a node test and glaring on the
 * page, so read the rendered text, not the DOM's existence. */
const heading = await page.textContent('h2[data-i18n="exp.h"]');
ok(heading && !/^exp\./.test(heading.trim()), `the heading is translated, not a raw key ("${heading?.trim()}")`);

console.log('\npicking the .flextext alone offers what a text alone can make');
await page.setInputFiles('#ex-ft', ft);
await page.waitForTimeout(500);
ok(await page.isVisible('#ex-rows'), 'the rows appear');
const rowState = async () => page.$$eval('#ex-rows .rp-dl-item', (els) => els.map((e) => ({
  name: e.querySelector('.rp-dl-name').textContent,
  sub: e.querySelector('.rp-dl-sub').textContent,
  off: e.classList.contains('rp-dl-pending'),
})));
let rows = await rowState();
ok(rows.length === 5, `five rows, the same five the Files ▾ menu offers (${rows.length})`);
ok(!rows.some((r) => /^exp\./.test(r.name) || /^exp\./.test(r.sub)), 'every row name and sub is translated');
ok(!rows[0].off, 'ELAN is offered — an aligned text needs times, not sound');
ok(rows[1].off && rows[2].off, 'SayMore and the listening page are greyed until a recording is chosen');
ok(rows[1].sub.length > 10, `…and say why rather than just going dim ("${rows[1].sub}")`);
ok(!rows[3].off && !rows[4].off, 'the .fxpa and the .flextext passthrough are offered');
const src = await page.textContent('#ex-src');
ok(/snakes\.flextext/.test(src) && /3/.test(src), `the source line names the file and what was found in it ("${src}")`);

console.log('\nadding the recording lights the rest up');
await page.setInputFiles('#ex-audio', wav);
await page.waitForTimeout(500);
rows = await rowState();
ok(rows.every((r) => !r.off), 'all five rows are now live');
ok(await page.isHidden('#ex-warn'), 'and no mismatch warning — the pair fits');

console.log('\nthe files actually come out, named as the menu names them');
const grab = async (i) => {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.$$eval('#ex-rows .rp-dl-item', (els, n) => els[n].click(), i),
  ]);
  return dl.suggestedFilename();
};
ok((await grab(0)) === 'Snakes We Eat ELAN.zip', 'the ELAN package is a zip named for the TEXT, not the file picked');
ok((await grab(1)) === 'Snakes We Eat SayMore.zip', 'the SayMore package too');
/* ⚠ The listening page is the one output that runs the WHOLE embedded-audio path in a real browser —
 * blobToBase64 over the recording, into a self-contained HTML file. node cannot exercise that, and it
 * is where an out-of-memory or a double-encode shows up. */
ok(/\.preview\.html$/.test(await grab(2)), 'and the listening page builds with the audio embedded in it');
ok((await grab(3)) === 'Snakes We Eat.fxpa', 'the .fxpa is a bare file');
/* The passthrough's BYTES are the file as given; its NAME is the text's, like every row beside it.
 * Handing back `snakes.flextext` would land as "snakes (1).flextext" next to the original in the
 * Downloads folder, which is the one name guaranteed to confuse — and it would be the only row here
 * not named for the text. */
ok((await grab(4)) === 'Snakes We Eat.flextext', 'and the passthrough is named for the text, like every other row');
const done = await page.textContent('#ex-status');
ok(/Snakes We Eat/.test(done) && !/^exp\./.test(done.trim()), `the status line reports the save ("${done}")`);

console.log('\na text that runs past the end of the recording is FLAGGED, never blocked');
/* Seth: "check to make sure the duration matches … If not, don't worry about it." So it is a
 * warning: the researcher may know something we do not, and refusing would strand them with two
 * files and no way to convert. */
await page.setInputFiles('#ex-ft', ftLong);
await page.waitForTimeout(500);
await page.setInputFiles('#ex-audio', wav);
await page.waitForTimeout(500);
ok(await page.isVisible('#ex-warn'), 'the mismatch warning shows');
const warn = await page.textContent('#ex-warn');
ok(/0:30/.test(warn) && /0:06/.test(warn), `naming both durations in mm:ss ("${warn}")`);
ok((await rowState()).every((r) => !r.off), '…and every row is STILL offered — a warning, not a refusal');

console.log('\nan UNALIGNED text can still make the two things that do not need times');
await page.setInputFiles('#ex-ft', join(dir, 'plain.flextext'));
await page.waitForTimeout(500);
rows = await rowState();
ok(rows[0].off && rows[1].off, 'no EAF from a text with no audio times');
ok(!rows[3].off, 'but the .fxpa rides — grouping is what that file is for');
ok(!rows[4].off, 'and the .flextext passthrough is never blocked by anything');

console.log('\na file that is not a flextext says so instead of failing silently');
const junk = join(dir, 'notes.flextext');
writeFileSync(junk, 'this is not xml at all');
await page.setInputFiles('#ex-ft', junk);
await page.waitForTimeout(400);
const err = await page.textContent('#ex-status');
ok(await page.isVisible('#ex-status') && err.length > 10 && !/^exp\./.test(err.trim()),
   `a plain-language failure ("${err}")`);

console.log('\nAND THE PANEL\'S COPY OF THE SAME WIDGET behaves identically');
{
  /* The panel module only loads when the panel is entered; ?mode=researcher does that without an
   * account (it lands on the sign-in screen, which is enough — the module is now in memory). */
  await page.goto(BASE + '?mode=researcher', { waitUntil: 'load' });
  await page.waitForTimeout(2000);
  const has = await page.evaluate(() => typeof window.__fxTestExporter === 'function');
  ok(has, 'the panel module loaded (if this fails, everything below is vacuous)');
  if (has) {
    await page.evaluate(() => window.__fxTestExporter());
    await page.waitForTimeout(300);
    ok(await page.isVisible('#xc-ft', { strict: false }) === false && !!(await page.$('#xc-ft')),
       'its two pickers exist, hidden behind their buttons exactly as the editor\'s are');
    await page.setInputFiles('#xc-ft', ft);
    await page.setInputFiles('#xc-audio', wav);
    await page.waitForTimeout(600);
    const prows = await page.$$eval('#xc-rows .rp-dl-item', (els) => els.map((e) => ({
      name: e.querySelector('.rp-dl-name').textContent,
      off: e.classList.contains('rp-dl-pending'),
    })));
    ok(prows.length === 5 && prows.every((r) => !r.off), `the same five rows, all live (${prows.length})`);
    ok(!prows.some((r) => /^exp\./.test(r.name)), 'and translated here too — the panel has its own render path');
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.$$eval('#xc-rows .rp-dl-item', (els) => els[0].click()),
    ]);
    /* ⚠ THE POINT OF THIS WHOLE SECTION: the same two files must produce the same named package on
     * both surfaces. Two widgets that quietly disagree is the failure this test exists to prevent. */
    ok(dl.suggestedFilename() === 'Snakes We Eat ELAN.zip', 'and the SAME package name the editor produced');
    // The pair check is per-surface code; the ArrayBuffer bug it caught in the editor lived here too.
    await page.setInputFiles('#xc-ft', ftLong);
    await page.setInputFiles('#xc-audio', wav);
    await page.waitForTimeout(600);
    ok(await page.isVisible('#xc-warn'), 'the mismatch warning works on this surface as well');
  }
}

await browser.close();
console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
