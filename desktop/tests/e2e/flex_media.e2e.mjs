/* End-to-end: a FLEx text whose recording link points nowhere gets a recording of its own in the app
 * (plans/flex-desktop-segmenter.md §8.4) — real Api + mock FLEx + real server + staged engine in
 * headless Chromium. Started by desktop/tests/test_e2e_media.py with the harness info as argv[2].
 * pywebview's js_api exists only on Windows; here window.pywebview.api forwards to the harness's
 * test-only RPC port through Playwright's exposeFunction (outside the page, so the page's CSP holds). */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let pw;
for (const m of [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'].filter(Boolean)) {
  try { pw = require(m); break; } catch { /* next */ }
}
if (!pw) { console.log('SKIP: no playwright module'); process.exit(77); }
const info = JSON.parse(process.argv[2]);
const shots = process.env.FLEX_E2E_SHOTS || '';
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const exe = ['/opt/pw-browsers/chromium', process.env.FLEX_E2E_CHROMIUM].find((p) => p && existsSync(p));
const browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const problems = [];
page.on('pageerror', (e) => problems.push('PAGEERROR ' + String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') problems.push('console.error ' + m.text().slice(0, 300)); });

const rpc = async (method, args) => {
  const r = await fetch(info.rpc, { method: 'POST', body: JSON.stringify({ method, args }) });
  return r.json();
};
await page.exposeFunction('__flexRpc', rpc);
await page.addInitScript(() => {
  const api = new Proxy({}, { get: (_t, name) => (typeof name === 'string' ? (...args) => window.__flexRpc(name, args) : undefined) });
  window.pywebview = { api };
});
const shot = async (n) => { if (shots) await page.screenshot({ path: join(shots, n + '.png') }); };
const T = (ms) => ({ timeout: ms });
const textRow = (title) => page.locator('#flex-texts li', { hasText: title });

await page.goto(info.origin + '/', { waitUntil: 'networkidle' });
await page.waitForSelector('#flex-home', T(10000));
ok(await page.evaluate(() => document.documentElement.classList.contains('flex-shell')), 'the FLEx section boots in the shell');

// open the project READ-ONLY: everything below must work without any write to FLEx
await page.selectOption('#flex-project', 'media-proj');
await page.click('#flex-open-read');
await page.waitForSelector('#flex-texts li', T(10000));
await shot('01-texts');
ok((await textRow('Missing link text').innerText()).includes('recording missing'), 'the list says the FLEx link points nowhere');
ok((await textRow('Missing link text').locator('.doc-name').innerText()) === 'Missing link text', 'rows use the Segmenter list\'s own structure (title apart from its details)');
ok((await textRow('No link text').innerText()).includes('no recording linked'), 'and which text has no link at all');

// 1. a missing link: the card offers the file of that name the shell found in LinkedFiles
await textRow('Missing link text').locator('.flex-open-text').click();
await page.waitForSelector('[data-flex-media]', T(10000));
await shot('02-card');
const card = page.locator('[data-flex-media]');
ok((await card.innerText()).includes('Session-01.wav'), 'the card names the file FLEx links to');
ok((await card.locator('.flex-media-name').first().innerText()).includes('session-01.WAV'), 'and offers the one found in LinkedFiles');
await card.locator('[data-use="0"]').click();
await page.waitForSelector('[data-flex-media]', { state: 'detached', timeout: 15000 });
await page.waitForFunction(() => !!document.querySelector('#topbar-editor') && !document.querySelector('#topbar-editor').hidden, null, T(15000));
await page.waitForTimeout(1500);
await shot('03-editor');
const st1 = await page.evaluate(async () => {
  const db = await import('/flextext-editor/js/db.js');
  const keys = [...await db.mediaKeys()];
  const docs = await db.listDocs();
  const id = docs.map((d) => d.id).find((x) => x.startsWith('flex-'));
  const rec = await db.getDoc(id);
  const media = await db.getMedia(id);
  return { keys, id, size: media && media.blob ? media.blob.size : 0, name: media && media.name, flex: rec && rec.flex ? { recording: rec.flex.recording, mediaFix: rec.flex.mediaFix, linkOk: rec.flex.linkOk, loadedAt: rec.flex.loadedAt } : null, modified: rec && rec.modified };
});
ok(st1.id && !st1.id.includes(':'), 'the local record id has no colon: ' + st1.id);
ok(st1.keys.includes(st1.id), 'the media store counts the recording for that text (db.mediaKeys)');
ok(st1.size > 1000 && st1.name === 'session-01.WAV', 'the recording bytes are in the app: ' + st1.size + ' bytes');
ok(st1.flex && st1.flex.recording && st1.flex.recording.source === 'found', 'recorded as found by the shell');
ok(st1.flex && st1.flex.mediaFix && st1.flex.mediaFix.path.endsWith('session-01.WAV') && !!st1.flex.mediaFix.uriGuid, 'the FLEx fix is pending, not written');
ok(st1.flex && st1.flex.linkOk === false, 'FLEx\'s own link is still the broken one');
ok(st1.modified === st1.flex.loadedAt, 'opening is not an edit (modified == loadedAt)');
ok(await page.evaluate(() => { const b = document.querySelector('#flex-save'); return !!b && b.hidden; }), 'a read-only text shows no Save to FLEx button');

// back home: the list now says the recording is in the app
await page.goto(info.origin + '/', { waitUntil: 'networkidle' });
await page.waitForSelector('#flex-home', T(10000));
await page.selectOption('#flex-project', 'media-proj');
// the project is still open in the shell from before the reload: close it first through the bridge
await rpc('close_project', []);
await page.click('#flex-open-read');
await page.waitForSelector('#flex-texts li', T(10000));
ok((await textRow('Missing link text').innerText()).includes('recording in this app'), 'after a reload the list says the recording is in the app');

// 2. re-opening: no card, the cached recording, the same record
await textRow('Missing link text').locator('.flex-open-text').click();
await page.waitForFunction(() => !!document.querySelector('#topbar-editor') && !document.querySelector('#topbar-editor').hidden, null, T(15000));
ok(!(await page.locator('[data-flex-media]').count()), 're-opening asks nothing: the app already has the recording');

// 3. a text with no link: Choose the recording… (the harness answers for the dialog)
await page.goto(info.origin + '/', { waitUntil: 'networkidle' });
await page.waitForSelector('#flex-home', T(10000));
await rpc('close_project', []);
await page.selectOption('#flex-project', 'media-proj');
await page.click('#flex-open-read');
await page.waitForSelector('#flex-texts li', T(10000));
await rpc('__pick', [info.elsewhere]);
await textRow('No link text').locator('.flex-open-text').click();
await page.waitForSelector('[data-flex-media]', T(10000));
ok((await page.locator('[data-flex-media]').innerText()).includes('no recording linked in FLEx'), 'the card says the text has no link');
await shot('04-nolink-card');
await page.locator('[data-flex-media] [data-choose]').click();
await page.waitForSelector('[data-flex-media]', { state: 'detached', timeout: 15000 });
const st3 = await page.evaluate(async () => {
  const db = await import('/flextext-editor/js/db.js');
  const docs = await db.listDocs();
  const out = [];
  for (const d of docs.filter((x) => x.id.startsWith('flex-'))) {
    const rec = await db.getDoc(d.id);
    out.push({ title: rec.title, source: rec.flex.recording && rec.flex.recording.source, fix: rec.flex.mediaFix });
  }
  return out;
});
const nolink = st3.find((r) => r.title === 'No link text');
ok(nolink && nolink.source === 'chosen' && nolink.fix && nolink.fix.uriGuid === null, 'chosen through the dialog; the pending fix is an ATTACH (no link to relink)');
const calls = (await rpc('__pickCalls', [])).result;
ok(calls.length === 1 && calls[0][1].endsWith('AudioVisual'), 'the dialog opened in the project\'s LinkedFiles\\AudioVisual: ' + JSON.stringify(calls));

// 4. a disposable copy with the same link: the earlier choice is used without asking
await page.goto(info.origin + '/', { waitUntil: 'networkidle' });
await page.waitForSelector('#flex-home', T(10000));
await rpc('close_project', []);
await page.selectOption('#flex-project', 'media-copy');
await page.click('#flex-open-read');
await page.waitForSelector('#flex-texts li', T(10000));
await textRow('Missing link text').locator('.flex-open-text').click();
await page.waitForFunction(() => !!document.querySelector('#topbar-editor') && !document.querySelector('#topbar-editor').hidden, null, T(15000));
ok(!(await page.locator('[data-flex-media]').count()), 'the copy\'s text took the remembered recording without a card');
const st4 = await page.evaluate(async () => {
  const db = await import('/flextext-editor/js/db.js');
  const docs = await db.listDocs();
  return Promise.all(docs.filter((d) => d.id.startsWith('flex-')).map(async (d) => {
    const r = await db.getDoc(d.id); return { id: d.id, title: r.title, project: r.flex.project, source: r.flex.recording && r.flex.recording.source };
  }));
});
const copyRec = st4.find((r) => r.project === 'media-copy');
ok(copyRec && copyRec.source === 'remembered', 'recorded as remembered: ' + JSON.stringify(copyRec));
ok(new Set(st4.map((r) => r.id)).size === st4.length && st4.filter((r) => r.title === 'Missing link text').length === 2, 'the copy has its own record (same text guid, another project)');
await shot('05-copy');

// 5. LATER, with the project open for writing (a marked disposable copy): FLEx's link is fixed with
//    the recording the app already uses — through the preview, the backup, one UOW and the read-back
await page.goto(info.origin + '/', { waitUntil: 'networkidle' });
await page.waitForSelector('#flex-home', T(10000));
await rpc('close_project', []);
await page.selectOption('#flex-project', 'media-write');
await page.click('#flex-open-write');
await page.waitForSelector('#flex-texts li', T(10000));
await textRow('Missing link text').locator('.flex-open-text').click();
await page.waitForFunction(() => !!document.querySelector('#topbar-editor') && !document.querySelector('#topbar-editor').hidden, null, T(15000));
ok(!(await page.locator('[data-flex-media]').count()), 'the remembered recording again, no card');
ok(await page.evaluate(() => { const b = document.querySelector('#flex-relink'); return !!b && !b.hidden; }), 'a writable text whose FLEx link points nowhere offers "Fix FLEx\'s recording link…"');
ok(await page.evaluate(() => { const b = document.querySelector('#flex-save'); return !!b && !b.hidden; }), 'and Save to FLEx');
await page.click('#flex-relink');
await page.waitForSelector('.flex-preview', T(10000));
const pv = await page.locator('.flex-preview').innerText();
ok(/session-01\.WAV/.test(pv), 'the preview names the file the link will point at');
await shot('06-relink-preview');
await page.click('.flex-preview [data-ok]');
await page.waitForFunction(() => { const b = document.querySelector('#flex-relink'); return !b || b.hidden; }, null, T(20000));
const after = (await rpc('list_texts', [])).result.find((t) => t.title === 'Missing link text');
ok(after && after.media[0].exists === true, 'FLEx\'s link now resolves on this machine');
const st5 = await page.evaluate(async () => {
  const db = await import('/flextext-editor/js/db.js');
  const docs = await db.listDocs();
  for (const d of docs) { const r = await db.getDoc(d.id); if (r.flex && r.flex.project === 'media-write') return { fix: r.flex.mediaFix, linkOk: r.flex.linkOk }; }
  return null;
});
ok(st5 && st5.fix === null && st5.linkOk === true, 'the pending fix is cleared once FLEx has it');
await shot('07-after-relink');

ok(problems.length === 0, 'no page errors: ' + JSON.stringify(problems));
await browser.close();
if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log('\nall ok');
