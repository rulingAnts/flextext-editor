/* THE RECOVERY TOOL, AGAINST THE APP ITSELF — same texts, same Chromium files, same output.
 *
 * The real app runs on localhost in a real Chromium profile. Texts go in through the app's own
 * import paths (a glossed text, a text + recording pair with alignment, a text long enough to be
 * stored compressed and out of line, and two texts that share a title). Each is saved with the
 * app's own Save. The browser is closed, and the BUILT recovery page (recovery/dist, opened from
 * file:// as it would be from a thumb drive) is pointed at that profile folder and saves the same
 * texts. Every file must match byte for byte, apart from the `exportSource` provenance string,
 * which deliberately names the tool.
 *
 * Then the removal path: the page's cleanup link, opened in the app, must remove exactly the text
 * it names and nothing else, and the page must refuse to offer it for two texts that share a title.
 *
 * Not part of the node suite (it needs a browser). Run it deliberately:
 *   node recovery/build.mjs && node test/browser/recovery-e2e.playwright.mjs
 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdtempSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('playwright')); }

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = join(ROOT, 'recovery/dist/flextext-recovery.html');
const PORT = Number(process.env.RECOVERY_TEST_PORT || 8791);
const BASE = `http://localhost:${PORT}/`;
const CHROME = process.env.FLEXTEXT_CHROME || undefined;

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const work = mkdtempSync(join(tmpdir(), 'fxrecover-'));
const profile = join(work, 'profile');
const fixtures = join(work, 'in');
mkdirSync(fixtures);

/* ---------- fixtures ---------- */
const word = (w, g) => `<word><item type="txt" lang="fau">${w}</item>${g ? `<item type="gls" lang="id">${g}</item>` : ''}</word>`;
const phrase = (words, free, t) => `<paragraph><phrases><phrase${t ? ` begin-time-offset="${t[0]}" end-time-offset="${t[1]}"` : ''}>
  <words>${words.map(([w, g]) => word(w, g)).join('')}</words>${free ? `<item type="gls" lang="id">${free}</item>` : ''}</phrase></phrases></paragraph>`;
const doc = (guid, title, paras) => `<?xml version="1.0" encoding="utf-8"?>
<document version="2"><interlinear-text guid="${guid}"><item type="title" lang="fau">${title}</item>
<paragraphs>${paras.join('')}</paragraphs>
<languages><language lang="fau" vernacular="true"/><language lang="id"/></languages></interlinear-text></document>`;

writeFileSync(join(fixtures, 'plain.flextext'), doc('11111111-1111-4111-8111-111111111111', 'Plain Glossed', [
  phrase([['ame', 'saya'], ['bo', 'pergi']], 'saya pergi'),
  phrase([['ne', 'dia'], ['da', 'datang']], 'dia datang'),
  phrase([['afu', 'ikan']], ''),
]));
writeFileSync(join(fixtures, 'aligned.flextext'), doc('22222222-2222-4222-8222-222222222222', 'Aligned Story', [
  phrase([['satu', 'one'], ['dua', 'two']], 'one two', [0, 2000]),
  phrase([['tiga', 'three']], 'three', [2000, 4000]),
  phrase([['empat', 'four']], '', [4000, 6000]),
]));
{
  const sr = 16000, n = sr * 6, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * (i / sr)) * 9000), i * 2);
  const hd = Buffer.alloc(44);
  hd.write('RIFF', 0); hd.writeUInt32LE(36 + data.length, 4); hd.write('WAVE', 8);
  hd.write('fmt ', 12); hd.writeUInt32LE(16, 16); hd.writeUInt16LE(1, 20); hd.writeUInt16LE(1, 22);
  hd.writeUInt32LE(sr, 24); hd.writeUInt32LE(sr * 2, 28); hd.writeUInt16LE(2, 32); hd.writeUInt16LE(16, 34);
  hd.write('data', 36); hd.writeUInt32LE(data.length, 40);
  writeFileSync(join(fixtures, 'aligned.wav'), Buffer.concat([hd, data]));
}
// Long enough that Chromium stores the record Snappy-compressed and in a blob file of its own.
writeFileSync(join(fixtures, 'long.flextext'), doc('33333333-3333-4333-8333-333333333333', 'Long Text',
  Array.from({ length: 1500 }, (_, i) => phrase([[`kata${i}`, `word${i}`], ['lagi', 'again'], [`ujung${i % 37}`, `end${i % 37}`]], `line ${i} translated`))));
writeFileSync(join(fixtures, 'dup1.flextext'), doc('44444444-4444-4444-8444-444444444444', 'Same Title', [phrase([['satu', 'one']], 'first copy')]));
writeFileSync(join(fixtures, 'dup2.flextext'), doc('55555555-5555-4555-8555-555555555555', 'Same Title', [phrase([['dua', 'two']], 'second copy')]));

const TITLES = ['Plain Glossed', 'Aligned Story', 'Long Text'];

/* ---------- helpers ---------- */
const listAll = (d, pre = '') => readdirSync(d).flatMap((n) => statSync(join(d, n)).isDirectory() ? listAll(join(d, n), pre + n + '/') : [pre + n]);
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', join(ROOT, 'docs')], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const launchApp = () => chromium.launchPersistentContext(profile, {
  executablePath: CHROME, args: ['--no-sandbox'], acceptDownloads: true, viewport: { width: 1100, height: 850 },
});
async function appPage(ctx) {
  const page = ctx.pages()[0] || await ctx.newPage();
  // No save picker: the app falls back to a plain download, which the test can capture.
  await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
  page.on('pageerror', (e) => console.log('   [app pageerror]', e.message));
  return page;
}
async function saveDownload(page, click, dir, label) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), click()]);
  const path = join(dir, dl.suggestedFilename());
  await dl.saveAs(path);
  return { name: dl.suggestedFilename(), path, label };
}
async function appTitles(page) {
  return page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('flextext-editor'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const rows = await new Promise((res) => { const t = db.transaction('docs').objectStore('docs').getAll(); t.onsuccess = () => res(t.result); });
    db.close();
    return rows.map((r) => r.title).sort();
  });
}

/* ---------- 1. the app: import, then Save each text ---------- */
console.log('\nthe app saves each text');
const appOut = join(work, 'app-out');
mkdirSync(appOut);
const appFiles = {};
{
  const ctx = await launchApp();
  const page = await appPage(ctx);
  await page.goto(BASE + '?vern=fau&anal=id&vernName=Fayu', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  for (const f of ['plain', 'long', 'dup1', 'dup2']) {
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForTimeout(700);
    await page.setInputFiles('#import-file', join(fixtures, `${f}.flextext`));
    await page.waitForTimeout(1500);
  }
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(700);
  await page.click('#btn-new-pair');
  await page.setInputFiles('#pair-ft', join(fixtures, 'aligned.flextext'));
  await page.setInputFiles('#pair-audio', join(fixtures, 'aligned.wav'));
  await page.click('[data-pd="open"]');
  await page.waitForTimeout(5000);

  /* Push the database past LevelDB's write buffer so Chromium flushes it to a sorted table (.ldb).
   * A device used for months keeps nearly everything in tables, not in the log, so both readers
   * must be exercised. "asset:" media keys are shared prompt audio, which the tool skips. */
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('flextext-editor'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const pad = 'x'.repeat(3000);
    for (let b = 0; b < 30; b++) {
      await new Promise((res, rej) => {
        const t = db.transaction('media', 'readwrite');
        for (let i = 0; i < 100; i++) t.objectStore('media').put({ name: `filler ${b}-${i}`, note: pad + b + i }, `asset:filler-${b}-${i}`);
        t.oncomplete = res; t.onerror = () => rej(t.error);
      });
    }
    db.close();
  });
  await page.waitForTimeout(2000);

  for (const title of TITLES) {
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForTimeout(900);
    const row = page.locator('li', { has: page.locator('.doc-name', { hasText: title }) }).first();
    await row.locator('.doc-open').click();
    await page.waitForTimeout(2500);
    await page.click('#btn-share');
    await page.waitForSelector('#share-menu:not([hidden])', { timeout: 15000 });
    await page.waitForTimeout(300);
    appFiles[title] = await saveDownload(page, () => page.click('#share-saveas'), appOut, title);
    await page.waitForTimeout(1500);
  }
  ok(JSON.stringify(await appTitles(page)) === JSON.stringify(['Aligned Story', 'Long Text', 'Plain Glossed', 'Same Title', 'Same Title']),
     'the app holds all five texts');
  await ctx.close();
}
for (const t of TITLES) ok(!!appFiles[t], `app saved "${t}" as ${appFiles[t] && appFiles[t].name}`);
{
  const idb = join(profile, 'Default/IndexedDB');
  const files = listAll(idb);
  ok(files.some((f) => /indexeddb\.leveldb\/\d+\.ldb$/.test(f)), 'the database has been flushed to at least one .ldb table');
  ok(files.filter((f) => /indexeddb\.blob\//.test(f)).length >= 2, 'and holds blob files (the recording, and the long text stored out of line)');
}

/* ---------- 2. the tool, from file://, on the closed profile ---------- */
console.log('\nthe recovery page saves the same texts from the browser\'s files');
const toolOut = join(work, 'tool-out');
mkdirSync(toolOut);
const toolFiles = {};
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const toolCtx = await browser.newContext({ acceptDownloads: true });
const tool = await toolCtx.newPage();
tool.on('pageerror', (e) => { console.log('   [tool pageerror]', e.message); fail++; });
await tool.goto(pathToFileURL(TOOL).href);
async function scanProfile() {
  await tool.setInputFiles('#folder', join(profile, 'Default'));
  await tool.waitForSelector('section.area', { timeout: 60000 });
}
await scanProfile();
const statusText = await tool.textContent('#status');
ok(/Found 5 texts/.test(statusText), `the page finds every text (${statusText.trim()})`);
const meta = await tool.textContent('section.area .meta');
ok(/device settings from/.test(meta), `the device settings were read from Local Storage (${meta.trim()})`);

const toolRow = (title) => tool.locator('ul.texts > li', { has: tool.locator('.title', { hasText: title }) });
for (const title of TITLES) {
  toolFiles[title] = await saveDownload(tool, () => toolRow(title).first().locator('button', { hasText: 'Save' }).click(), toolOut, title);
  await tool.waitForTimeout(500);
}

/* ---------- 3. compare ---------- */
console.log('\nbyte for byte, apart from the provenance string');
const listFiles = (d, pre = '') => readdirSync(d).flatMap((n) => statSync(join(d, n)).isDirectory() ? listFiles(join(d, n), pre + n + '/') : [pre + n]).sort();
const textual = /\.(flextext|eaf|pfsx|html|fxpa|json|txt)$/i;
function filesOf(f, tag) {
  if (!/\.zip$/i.test(f.name)) return { [f.name]: readFileSync(f.path) };
  const d = join(work, tag, f.label.replace(/\W+/g, '_'));
  mkdirSync(d, { recursive: true });
  execFileSync('unzip', ['-q', '-o', f.path, '-d', d]);
  return Object.fromEntries(listFiles(d).map((n) => [n, readFileSync(join(d, n))]));
}
for (const title of TITLES) {
  const a = appFiles[title], b = toolFiles[title];
  if (!a || !b) continue;
  ok(a.name === b.name, `"${title}": same file name (${a.name} / ${b.name})`);
  const fa = filesOf(a, 'ua'), fb = filesOf(b, 'ub');
  ok(JSON.stringify(Object.keys(fa)) === JSON.stringify(Object.keys(fb)), `"${title}": same files inside (${Object.keys(fa).join(', ')})`);
  const appSource = /exportSource="([^"]*)"/.exec(Object.entries(fa).find(([n]) => /\.flextext$/.test(n))[1].toString('utf8'));
  const toolSource = /exportSource="([^"]*)"/.exec(Object.entries(fb).find(([n]) => /\.flextext$/.test(n))[1].toString('utf8'));
  ok(toolSource && /^Flextext Recovery v\d+$/.test(toolSource[1]), `"${title}": the tool names itself as the exporter (${toolSource && toolSource[1]})`);
  for (const [n, bytes] of Object.entries(fa)) {
    if (!fb[n]) continue;
    let same;
    if (textual.test(n) && appSource && toolSource) {
      // An EAF stamps the moment it was written (ANNOTATION_DOCUMENT DATE); two saves differ there.
      const when = (s) => s.replace(/(<ANNOTATION_DOCUMENT\b[^>]*\bDATE=")[^"]*"/, '$1"');
      same = when(bytes.toString('utf8').split(appSource[1]).join(toolSource[1])) === when(fb[n].toString('utf8'));
    } else same = Buffer.compare(bytes, fb[n]) === 0;
    ok(same, `"${title}": ${n} identical (${bytes.length} bytes)`);
  }
}

/* ---------- 4. removal ---------- */
console.log('\nremoving saved texts through the app\'s own link');
for (const t of ['Same Title']) {
  for (let i = 0; i < 2; i++) {
    await saveDownload(tool, () => toolRow(t).nth(i).locator('button', { hasText: 'Save' }).click(), toolOut, `${t} ${i}`);
    await tool.waitForTimeout(300);
  }
}
await tool.click('section.area details.delete > summary');
const blocked = await tool.locator('details.delete li.blocked').allTextContents();
ok(blocked.length === 2 && blocked.every((s) => /same title/.test(s)), `both "Same Title" texts are refused: ${blocked.map((s) => s.trim()).join(' | ')}`);
for (const title of ['Aligned Story', 'Long Text']) {
  await tool.locator('details.delete li', { hasText: title }).locator('input[type=checkbox]').uncheck();
}
await tool.fill('details.delete input[type=url]', BASE);
ok(await tool.locator('details.delete .link a').count() === 0, 'no link until the saved files are confirmed checked');
await tool.locator('details.delete label', { hasText: 'I have opened the saved files' }).locator('input').check();
const link = await tool.locator('details.delete .link a').getAttribute('href');
ok(link === `${BASE}?cleanup=${encodeURIComponent('Plain Glossed')}`, `the link names one text: ${link}`);
{
  const ctx = await launchApp();
  const page = await appPage(ctx);
  await page.goto(link, { waitUntil: 'load' });
  const dlg = page.locator('[data-confirm-dialog]');
  await dlg.waitFor({ timeout: 15000 });
  ok(/delete 1 text/.test(await dlg.textContent()), `the app asks first, for exactly one text: "${(await dlg.locator('p').textContent()).trim()}"`);
  await dlg.locator('[data-cf="ok"]').click();
  await page.waitForTimeout(1500);
  const left = await appTitles(page);
  ok(JSON.stringify(left) === JSON.stringify(['Aligned Story', 'Long Text', 'Same Title', 'Same Title']), `only "Plain Glossed" was removed (left: ${left.join(', ')})`);
  await ctx.close();
}
await scanProfile();
ok(await toolRow('Plain Glossed').count() === 0, 'a fresh scan no longer finds the removed text');
ok(/Found 4 texts/.test(await tool.textContent('#status')), 'and finds the other four');

await browser.close();
server.kill();
console.log(fail ? `\nFAILED (${fail})  — work files in ${work}\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
