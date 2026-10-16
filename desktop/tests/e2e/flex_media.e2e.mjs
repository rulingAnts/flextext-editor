/* End-to-end, the Audio Segmenter's own workflow on FLEx texts (plans/flex-desktop-segmenter.md §8.4, §11):
 * open a FLEx text → it opens in the Segmenter's MATCHER with a recording of its own (found, chosen or
 * remembered when FLEx's link points nowhere) → cut by pauses → Done → Save to FLEx from the text row →
 * Undo / Redo Save to FLEx. Real Api + mock FLEx + real server + staged engine in headless Chromium.
 * Started by desktop/tests/test_e2e_media.py with the harness info as argv[2]. pywebview's js_api exists
 * only on Windows; here window.pywebview.api forwards to the harness's test-only RPC port through
 * Playwright's exposeFunction (outside the page, so the page's own CSP holds). */
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
const visible = (sel) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && !el.hidden && el.offsetParent !== null; }, sel);
const waitMatcher = () => page.waitForFunction(() => {
  const v = document.querySelector('#view-matcher');
  return !!v && !v.hidden && !!v.querySelector('.mg-bar');
}, null, T(15000));
const waitAudio = () => page.waitForFunction(() => { const n = document.querySelector('#mg-audio-note'); return !!n && n.hidden; }, null, T(20000));
const waitHome = () => page.waitForFunction(() => { const v = document.querySelector('#view-segmenter'); return !!v && !v.hidden; }, null, T(15000));
async function home() {
  await page.goto(info.origin + '/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#flex-home', T(10000));
}
async function openProject(name, mode) {
  await rpc('close_project', []);             // the shell outlives a page reload; start from a clean session
  await page.selectOption('#flex-project', name);
  await page.click(mode === 'write' ? '#flex-open-write' : '#flex-open-read');
  await page.waitForSelector('#flex-texts li', T(10000));
}
const records = () => page.evaluate(async () => {
  const db = await import('/flextext-editor/js/db.js');
  const keys = [...await db.mediaKeys()];
  const out = [];
  for (const d of await db.listDocs()) {
    if (!d.id.startsWith('flex-')) continue;
    const r = await db.getDoc(d.id);
    const m = await db.getMedia(d.id);
    out.push({ id: d.id, title: r.title, project: r.flex.project, recording: r.flex.recording || null, fix: r.flex.mediaFix || null,
      linkOk: r.flex.linkOk, loadedAt: r.flex.loadedAt, modified: r.modified, dirty: !!r.flex.dirty,
      media: keys.includes(d.id), size: m && m.blob ? m.blob.size : 0, mediaName: m && m.name,
      timed: (r.doc.segments || []).filter((s) => s && !s.timePending && Number(s.end) > Number(s.start)).length });
  }
  return out;
});
const flexText = async (title) => (await rpc('list_texts', [])).result.find((t) => t.title === title);

await home();
ok(await page.evaluate(() => document.documentElement.classList.contains('flex-shell')), 'the FLEx section boots in the shell');

// ── 1. read-only: a missing link → the card offers the file found in LinkedFiles → the MATCHER ────────
await openProject('media-proj', 'read');
await shot('01-texts');
ok((await textRow('Missing link text').innerText()).includes('recording missing'), 'the list says the FLEx link points nowhere');
ok((await textRow('No link text').innerText()).includes('no recording linked'), 'and which text has no link at all');
ok((await textRow('Missing link text').locator('.doc-name').innerText()) === 'Missing link text', 'rows use the Segmenter list\'s own structure');
await textRow('Missing link text').locator('.flex-open-text').click();
await page.waitForSelector('[data-flex-media]', T(10000));
await shot('02-card');
const card = page.locator('[data-flex-media]');
ok((await card.innerText()).includes('Session-01.wav'), 'the card names the file FLEx links to');
ok((await card.locator('.flex-media-name').first().innerText()).includes('session-01.WAV'), 'and offers the one found in LinkedFiles');
await card.locator('[data-use="0"]').click();
await page.waitForSelector('[data-flex-media]', { state: 'detached', timeout: 15000 });
await waitMatcher();
await waitAudio();
await shot('03-matcher');
ok(await visible('#view-matcher .mg-bar'), 'the text opens in the Audio Segmenter\'s MATCHER');
ok(!(await visible('#topbar-editor')), 'not in the editor\'s Cut tab');
ok((await page.locator('#flex-mg-strip .flex-badge').innerText()).includes('read-only'), 'the FLEx strip says read-only');
ok(!(await page.locator('#flex-mg-strip #flex-save').count()), 'and offers no Save to FLEx (that is on the text row, after Done)');
ok(await page.evaluate(() => ['aaa', 'ddd', 'hhh'].every((w) => document.querySelector('#view-matcher').innerText.includes(w))), 'the Matcher shows the FLEx text\'s lines');
let recs = await records();
const r1 = recs.find((r) => r.project === 'media-proj' && r.title === 'Missing link text');
ok(r1 && !r1.id.includes(':') && r1.media && r1.size > 1000 && r1.mediaName === 'session-01.WAV', 'the recording is in the app under a colon-free id the media store counts');
ok(r1 && r1.recording && r1.recording.source === 'found' && r1.fix && r1.fix.uriGuid && r1.linkOk === false, 'found by the shell; the FLEx fix is pending, not written');
ok(r1 && r1.modified === r1.loadedAt, 'opening is not an edit');

// Back to the list: the row says the recording is in the app; re-opening asks nothing
await page.click('#mg-back');
await waitHome();
await page.waitForFunction(() => /recording in this app/.test((document.querySelector('#flex-texts') || {}).innerText || ''), null, T(10000));
ok((await textRow('Missing link text').innerText()).includes('recording in this app'), 'after Back, the row says the recording is in the app');
await textRow('Missing link text').locator('.flex-open-text').click();
await waitMatcher();
ok(!(await page.locator('[data-flex-media]').count()), 're-opening asks nothing: the app already has the recording');

// The Segmenter's own list keeps the app's own texts and leaves FLEx texts to the FLEx section
await page.evaluate(async () => {
  const db = await import('/flextext-editor/js/db.js');
  const fx = await import('/flextext-editor/js/flextext.js');
  const now = Date.now();
  await db.putDoc({ id: '0f8e2a52-6c1d-4f3b-9a57-2d6e4b1c9a10', title: 'An own text', created: now, modified: now,
    doc: fx.makeDoc({ vernLang: 'qaa', analLang: 'en' }, 'An own text') });
});
await home();
ok(await page.waitForFunction(() => {
  const txt = (document.querySelector('#sg-list') || {}).innerText || '';
  return /An own text/.test(txt) && !/Missing link text/.test(txt);
}, null, T(10000)).then(() => true, () => false), 'the Segmenter\'s own list shows its own text and not the FLEx ones');

// ── 2. a text with no link: Choose the recording… (the harness answers for the native dialog) ─────────
await home();
await openProject('media-proj', 'read');
await rpc('__pick', [info.elsewhere]);
await textRow('No link text').locator('.flex-open-text').click();
await page.waitForSelector('[data-flex-media]', T(10000));
ok((await page.locator('[data-flex-media]').innerText()).includes('no recording linked in FLEx'), 'the card says the text has no link');
await page.locator('[data-flex-media] [data-choose]').click();
await page.waitForSelector('[data-flex-media]', { state: 'detached', timeout: 15000 });
await waitMatcher();
recs = await records();
const nolink = recs.find((r) => r.title === 'No link text');
ok(nolink && nolink.recording && nolink.recording.source === 'chosen' && nolink.fix && nolink.fix.uriGuid === null, 'chosen through the dialog; the pending fix is an ATTACH');
const calls = (await rpc('__pickCalls', [])).result;
ok(calls.length === 1 && calls[0][1].endsWith('AudioVisual'), 'the dialog opened in the project\'s LinkedFiles\\AudioVisual');

// ── 3. a copy of the project with the same link: the earlier choice, no card, its own record ──────────
await home();
await openProject('media-copy', 'read');
await textRow('Missing link text').locator('.flex-open-text').click();
await waitMatcher();
ok(!(await page.locator('[data-flex-media]').count()), 'the copy\'s text took the remembered recording without a card');
recs = await records();
const copyRec = recs.find((r) => r.project === 'media-copy');
ok(copyRec && copyRec.recording && copyRec.recording.source === 'remembered', 'recorded as remembered');
ok(recs.filter((r) => r.title === 'Missing link text').length === 2, 'the copy has its own record (same text guid, another project)');

// ── 4. LATER, open for writing (a marked disposable copy) ─────────────────────────────────────────────
await home();
await openProject('media-write', 'write');
await textRow('Missing link text').locator('.flex-open-text').click();
await waitMatcher();
await waitAudio();
ok((await page.locator('#flex-mg-strip .flex-badge').innerText()).trim() === 'FLEx text', 'the strip says it is a FLEx text, writable');
await page.click('#mg-back');
await waitHome();
await page.waitForFunction(() => !!document.querySelector('#flex-texts li .flex-fix-link'), null, T(10000));
ok((await textRow('Missing link text').innerText()).includes('changes not in FLEx'), 'a pending link fix is work FLEx does not have yet');
// 4a. Fix FLEx's recording link… alone
await textRow('Missing link text').locator('.flex-fix-link').click();
await page.waitForSelector('.flex-preview', T(10000));
ok(/session-01\.WAV/.test(await page.locator('.flex-preview').innerText()), 'the preview names the file the link will point at');
await shot('04-relink-preview');
await page.click('.flex-preview [data-ok]');
await page.waitForFunction(() => !document.querySelector('#flex-texts li .flex-fix-link'), null, T(20000));
ok((await flexText('Missing link text')).media[0].exists === true, 'FLEx\'s link now resolves on this machine');
recs = await records();
let wr = recs.find((r) => r.project === 'media-write' && r.title === 'Missing link text');
ok(wr && wr.fix === null && wr.linkOk === true, 'the pending fix is cleared once FLEx has it');
ok(!(await textRow('Missing link text').innerText()).includes('changes not in FLEx'), 'and the row no longer says there is work FLEx lacks');

// 4b. the Segmenter's own job: cut by pauses in the Matcher, Done, then Save to FLEx from the row
await textRow('Missing link text').locator('.flex-open-text').click();
await waitMatcher();
await waitAudio();
await page.click('#mg-guess');
await page.waitForFunction(() => document.querySelectorAll('#view-matcher .mg-wave').length === 3, null, T(10000));
ok(await page.evaluate(() => /3/.test(document.querySelector('#mg-status').textContent) && !/more/.test(document.querySelector('#mg-status').textContent)), 'cut by pauses: three pieces of audio for three lines');
await shot('05-matched');
await page.click('#mg-done');
await waitHome();
await page.waitForFunction(() => !!document.querySelector('#flex-texts li .flex-save-text'), null, T(10000));
recs = await records();
wr = recs.find((r) => r.project === 'media-write' && r.title === 'Missing link text');
ok(wr && wr.timed === 3 && wr.modified > wr.loadedAt, 'Done wrote three timed lines here (a stamped edit)');
ok((await textRow('Missing link text').innerText()).includes('changes not in FLEx'), 'the row says the work is not in FLEx yet');
await textRow('Missing link text').locator('.flex-save-text').click();
await page.waitForSelector('.flex-preview', T(10000));
const pv = await page.locator('.flex-preview').innerText();
ok((pv.match(/Times:/g) || []).length === 3, 'the preview lists three times to write');
await shot('06-save-preview');
await page.click('.flex-preview [data-ok]');
await page.waitForFunction(() => !document.querySelector('#flex-texts li .flex-save-text'), null, T(20000));
ok((await flexText('Missing link text')).timedSegs === 3, 'FLEx now has the three times');
recs = await records();
wr = recs.find((r) => r.project === 'media-write' && r.title === 'Missing link text');
ok(wr && wr.modified === wr.loadedAt && !wr.dirty, 'the local record is FLEx\'s text again (nothing pending)');

// 4c. Undo / Redo, from the project row: one action here is one Undo in FLEx — the save, then the relink
const rowHas = (sel) => page.waitForFunction((q) => !!document.querySelector('#flex-texts li ' + q), sel, T(20000));
const rowLacks = (sel) => page.waitForFunction((q) => !document.querySelector('#flex-texts li ' + q), sel, T(20000));
ok(!(await page.locator('#flex-undo').isDisabled()), 'Undo Save to FLEx is available');
await page.click('#flex-undo');
await rowHas('.flex-save-text');
ok((await flexText('Missing link text')).timedSegs === 0, 'Undo: FLEx is back to before the save');
ok((await textRow('Missing link text').innerText()).includes('changes not in FLEx'), 'the row says the work is here and not in FLEx');
recs = await records();
wr = recs.find((r) => r.project === 'media-write' && r.title === 'Missing link text');
ok(wr && wr.dirty && wr.timed === 3, 'the work stays here, marked as not in FLEx');
await page.click('#flex-undo');
await rowHas('.flex-fix-link');
ok((await flexText('Missing link text')).media[0].exists === false, 'a second Undo takes the relink back: FLEx\'s link points nowhere again');
ok(await page.locator('#flex-undo').isDisabled(), 'and nothing is left to undo');
await page.click('#flex-redo');
await rowLacks('.flex-fix-link');
ok((await flexText('Missing link text')).media[0].exists === true, 'Redo: the link resolves again');
await page.click('#flex-redo');
await rowLacks('.flex-save-text');
ok((await flexText('Missing link text')).timedSegs === 3, 'Redo: the times are in FLEx again');
recs = await records();
wr = recs.find((r) => r.project === 'media-write' && r.title === 'Missing link text');
ok(wr && !wr.dirty && wr.fix === null && wr.linkOk === true, 'nothing pending after both redos');
await shot('07-after-redo');

// ── 5. the Matcher's own ✂ and ⤴ on a FLEx text reach FLEx as FLEx itself splits and joins ─────────
await home();
await openProject('struct-write', 'write');
await textRow('Struct text').locator('.flex-open-text').click();
await waitMatcher();
await waitAudio();
ok(!(await page.locator('[data-flex-media]').count()), 'FLEx\'s own link resolves: no card');
const lines = () => page.locator('#view-matcher .mg-line');
const spans = () => page.locator('#view-matcher .mg-span');
// Copy line as FLEx Print view: the selected line, through the shell's clipboard
await lines().first().locator('.mg-pick').click();
await page.click('#flex-copy');
await page.waitForFunction(async () => true, null, T(1000));
const clip = await (async () => { for (let k = 0; k < 20; k++) { const c = (await rpc('__clipboard', [])).result; if (c) return c; await new Promise((r) => setTimeout(r, 100)); } return null; })();
ok(clip && /aaa/.test(clip) && /\t/.test(clip), 'Copy line puts the selected line\'s Print view (tab-separated) on the clipboard');
await page.click('#mg-guess');
await page.waitForFunction(() => document.querySelectorAll('#view-matcher .mg-wave').length === 3, null, T(10000));
// ✂ text line 1 between aaa and bbb, its translation after "the free"; ✂ the first piece of audio too
await lines().first().locator('.mg-scissors').first().click();
await page.waitForSelector('#view-matcher .mg-ftgap', T(5000));
await lines().first().locator('.mg-ftgap').nth(1).click();
await page.waitForFunction(() => document.querySelectorAll('#view-matcher .mg-line').length === 4, null, T(5000));
await spans().first().locator('.mg-split').click();
await page.waitForFunction(() => document.querySelectorAll('#view-matcher .mg-wave').length === 4, null, T(5000));
await shot('08-split');
await page.click('#mg-done');
await waitHome();
await rowHas('.flex-save-text');
await textRow('Struct text').locator('.flex-save-text').click();
await page.waitForSelector('.flex-preview', T(10000));
const pv5 = await page.locator('.flex-preview').innerText();
ok(/Splits a phrase/.test(pv5) && /new paragraph/.test(pv5), 'the preview names the split and the new paragraph (the device\'s break kind is Sentence)');
await shot('09-split-preview');
await page.click('.flex-preview [data-ok]');
await rowLacks('.flex-save-text');
let st = await flexText('Struct text');
ok(st.paras === 4 && st.segs === 4 && st.timedSegs === 4, 'FLEx: four paragraphs, four phrases, all timed: ' + JSON.stringify({ p: st.paras, s: st.segs, t: st.timedSegs }));
let od = (await rpc('open_text', [st.guid])).result.doc;
ok(od.paragraphs[0].segments[0].free === 'the free' && od.paragraphs[1].segments[0].free === 'translation of line 1', 'each half has its part of the free translation');
// ⤴ text line 4 into line 3 (two FLEx paragraphs, no stop between them), and ⤴ their audio
await textRow('Struct text').locator('.flex-open-text').click();
await waitMatcher();
await waitAudio();
await lines().nth(3).locator('.mg-join').click();
await page.waitForFunction(() => document.querySelectorAll('#view-matcher .mg-line').length === 3, null, T(5000));
await spans().nth(3).locator('.mg-join').click();
await page.waitForFunction(() => document.querySelectorAll('#view-matcher .mg-wave').length === 3, null, T(5000));
await page.click('#mg-done');
await waitHome();
await rowHas('.flex-save-text');
await textRow('Struct text').locator('.flex-save-text').click();
await page.waitForSelector('.flex-preview', T(10000));
ok(/Joins two phrases/.test(await page.locator('.flex-preview').innerText()), 'the preview names the join');
await page.click('.flex-preview [data-ok]');
await rowLacks('.flex-save-text');
st = await flexText('Struct text');
ok(st.paras === 3 && st.segs === 3 && st.timedSegs === 3, 'FLEx: lines 3 and 4 are one phrase in one paragraph: ' + JSON.stringify({ p: st.paras, s: st.segs, t: st.timedSegs }));
od = (await rpc('open_text', [st.guid])).result.doc;
ok(od.paragraphs[2].segments[0].words.filter((w) => !w.punct).map((w) => w.txt).join(' ') === 'ddd eee fff ggg hhh', 'the joined phrase holds both lines\' words');
// one Undo per save takes each back
await page.click('#flex-undo');
await rowHas('.flex-save-text');
await page.click('#flex-undo');
await page.waitForFunction(() => document.querySelector('#flex-undo').disabled, null, T(20000));
st = await flexText('Struct text');
ok(st.paras === 3 && st.segs === 3 && st.timedSegs === 0, 'two Undos: FLEx is the text it was before either save');
await shot('10-after-undos');

// ── 6. writing systems per text, from FLEx's own lists; words merged with Backspace, split with Space ─
await home();
await openProject('ws-write', 'write');
const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast, #toast')].map((x) => x.innerText).join(' | '));
await textRow('Two languages').locator('.flex-ws-text').click();
await page.waitForSelector('[data-flex-ws]', T(10000));
const vOpts = await page.locator('[data-flex-ws] [data-ws="vern"] option').allInnerTexts();
const aOpts = await page.locator('[data-flex-ws] [data-ws="anal"] option').allInnerTexts();
ok(vOpts.length === 2 && /Example \(xx\).*2 paragraphs.*this text's own/.test(vOpts[0]) && /Example IPA/.test(vOpts[1]), 'the vernacular list is FLEx\'s, with what this text uses: ' + JSON.stringify(vOpts));
ok(aOpts.length === 2 && /English \(en\) — 1 translation, 1 gloss$/.test(aOpts[0]) && /Indonesian \(id\) — 2 translations, 1 gloss, this text's own$/.test(aOpts[1]), 'and the analysis list: ' + JSON.stringify(aOpts));
ok(await page.locator('[data-flex-ws] [data-ws="anal"]').inputValue() === 'id', 'the text opens in the analysis writing system it uses most');
ok(/5 words have no approved gloss in FLEx/.test(await page.locator('[data-flex-ws]').innerText()), 'and says how many words FLEx has no approved gloss for (its guesses are not glosses)');
await shot('11-ws-dialog');
await page.selectOption('[data-flex-ws] [data-ws="anal"]', 'en');
await page.click('[data-flex-ws] [data-ok]');
await page.waitForFunction(() => /Example → English/.test((document.querySelector('#flex-texts') || {}).innerText || ''), null, T(10000));
ok(true, 'the row says the text now shows Example → English');
await textRow('Two languages').locator('.flex-open-text').click();
await waitMatcher();
await waitAudio();
ok(await page.evaluate(() => document.querySelector('#view-matcher').innerText.includes('first in English')), 'the Matcher shows the English free translation');
ok(await page.locator('#flex-ws-vern').inputValue() === 'xx' && await page.locator('#flex-ws-anal').inputValue() === 'en',
   'the strip shows the text\'s writing systems, switchable in place');
const stripOpts = await page.locator('#flex-ws-anal option').allInnerTexts();
ok(JSON.stringify(stripOpts) === '["English","Indonesian","All languages"]', 'FLEx\'s analysis writing systems by name, and All: ' + JSON.stringify(stripOpts));
ok(!(await page.locator('#mg-lang').count()), 'the Matcher\'s own picker steps aside for a FLEx text (one control, not two)');
// Backspace at the start of "bbb" joins it to "aaa"; Space inside "fff" splits it
const caretIn = (lineIdx, wordIdx, offset) => page.evaluate(([li, wi, off]) => {
  const el = document.querySelectorAll('#view-matcher .mg-line')[li].querySelectorAll('.mg-wstack .mg-w')[wi];
  el.focus();
  const r = document.createRange(); r.setStart(el.firstChild, off); r.collapse(true);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
}, [lineIdx, wordIdx, offset]);
const wordsOf = (li) => page.evaluate((i) => [...document.querySelectorAll('#view-matcher .mg-line')[i].querySelectorAll('.mg-wstack .mg-w')].map((e) => e.textContent), li);
await caretIn(0, 1, 0);
await page.keyboard.press('Backspace');
await page.waitForFunction(() => document.querySelectorAll('#view-matcher .mg-line')[0].querySelectorAll('.mg-wstack .mg-w').length === 2, null, T(5000));
const w0 = JSON.stringify(await wordsOf(0));
ok(w0 === '["aaabbb","ccc"]', 'Backspace at the start of a word joins it to the word before: ' + w0);
ok(/A-en/.test(await toasts()), 'the lost gloss is said out loud');
await caretIn(1, 2, 1);
await page.keyboard.press(' ');
await page.waitForFunction(() => document.querySelectorAll('#view-matcher .mg-line')[1].querySelectorAll('.mg-wstack .mg-w').length === 4, null, T(5000));
const w1 = JSON.stringify(await wordsOf(1));
ok(w1 === '["ddd","eee","f","ff"]', 'Space inside a word splits it: ' + w1);
await shot('12-words');
await page.click('#mg-done');
await waitHome();
await rowHas('.flex-save-text');
await textRow('Two languages').locator('.flex-save-text').click();
await page.waitForSelector('.flex-preview', T(10000));
const pv6 = await page.locator('.flex-preview').innerText();
ok(/Words joined: “aaa” “bbb” → “aaabbb”/.test(pv6) && /Word split: “fff” → “f” “ff”/.test(pv6), 'the preview names the join and the split: ' + pv6.replace(/\n+/g, ' | ').slice(0, 300));
await page.click('.flex-preview [data-ok]');
await rowLacks('.flex-save-text');
const two = await flexText('Two languages');
let wd = (await rpc('open_text', [two.guid, { vern: 'xx', anal: 'id' }])).result.doc;
const lex = (k) => wd.paragraphs[k].segments[0].words.filter((w) => !w.punct).map((w) => w.txt).join(' ');
ok(lex(0) === 'aaabbb ccc' && lex(1) === 'ddd eee f ff', 'FLEx has the joined and the split words: ' + lex(0) + ' | ' + lex(1));
ok(wd.paragraphs[0].segments[0].free === 'pertama' && wd.paragraphs[0].segments[0].postItemsXML.join('').includes('first in English'),
   'both translations kept: the English one shown here, the Indonesian one never touched');
// words shown in the IPA alternative: a word edit is refused before the preview
await textRow('Two languages').locator('.flex-ws-text').click();
await page.waitForSelector('[data-flex-ws]', T(10000));
await page.selectOption('[data-flex-ws] [data-ws="vern"]', 'xx-x-ipa');
await page.click('[data-flex-ws] [data-ok]');
await page.waitForFunction(() => /Example IPA → English/.test((document.querySelector('#flex-texts') || {}).innerText || ''), null, T(10000));
await textRow('Two languages').locator('.flex-open-text').click();
await waitMatcher();
await waitAudio();
ok(JSON.stringify(await wordsOf(1)) === '["ddd","ɛɛɛ","f","ff"]', 'words show in the IPA alternative where the wordform has one');
await caretIn(1, 1, 1);
await page.keyboard.press(' ');
await page.waitForFunction(() => document.querySelectorAll('#view-matcher .mg-line')[1].querySelectorAll('.mg-wstack .mg-w').length === 5, null, T(5000));
await page.click('#mg-done');
await waitHome();
await rowHas('.flex-save-text');
await textRow('Two languages').locator('.flex-save-text').click();
await page.waitForFunction(() => /written in xx\b/.test([...document.querySelectorAll('.toast, #toast')].map((x) => x.innerText).join(' ')), null, T(10000));
ok(!(await page.locator('.flex-preview').count()), 'a word edit made in the IPA view is refused, naming both writing systems: ' + (await toasts()).slice(0, 160));
await textRow('Two languages').locator('.flex-ws-text').click();
await page.waitForSelector('[data-flex-ws]', T(10000));
await page.selectOption('[data-flex-ws] [data-ws="vern"]', 'xx');
await page.click('[data-flex-ws] [data-ok]');
await page.waitForFunction(() => /Save this text to FLEx first/.test([...document.querySelectorAll('.toast, #toast')].map((x) => x.innerText).join(' ')), null, T(10000));
ok(/Example IPA → English/.test(await textRow('Two languages').innerText()), 'and the writing systems do not change under work that is not in FLEx');
await shot('13-ws-refused');

// ── 7. a record an older build made; switching writing systems inside the text ─────────────────────────
// An older build read FLEx's FIRST analysis writing system only (English here) and kept no choice: its
// record of "Glossed text" holds no glosses and no translations, and re-opening kept it because FLEx had
// not changed (Seth, 2026-10-15). Built here the way that build stored it.
const gt = await flexText('Glossed text');
await page.evaluate(async ([guid, fetched]) => {
  const db = await import('/flextext-editor/js/db.js');
  const ops = await import('/flextext-editor/js/flex-ops.js');
  const doc = fetched.doc;
  for (const ln of doc.paragraphs) for (const seg of ln.segments) {
    seg.postItemsXML = [];
    for (const w of seg.words) w.preservedXML = [];
  }
  delete doc.flex.ws;
  const now = Date.now() - 60000;
  await db.putDoc({ id: ops.flexDocId('ws-write', guid), title: doc.title, created: now, modified: now, doc,
    flex: { textGuid: guid, baseRev: fetched.baseRev, base: JSON.parse(JSON.stringify(doc)), project: 'ws-write', loadedAt: now, writable: true, linkOk: true } });
  localStorage.setItem('flextext-mg-lang', 'en');   // this device last showed some other text in English
}, [gt.guid, (await rpc('open_text', [gt.guid, { vern: 'xx', anal: 'en' }])).result]);
await home();
await openProject('ws-write', 'write');
ok(/Example → English/.test(await textRow('Glossed text').innerText()), 'the older record says what it is in: Example → English');
await textRow('Glossed text').locator('.flex-open-text').click();
await waitMatcher();
await waitAudio();
const mtxt = () => page.evaluate(() => document.querySelector('#view-matcher').innerText);
ok(/satu/.test(await mtxt()) && /K-id/.test(await mtxt()) && /M-id/.test(await mtxt()),
   'nothing was done here, so it is FLEx\'s text again, in the writing system it is glossed and translated in');
ok(await page.locator('#flex-ws-anal').inputValue() === 'id', 'the strip says Indonesian');
ok(!/K-en/.test(await mtxt()), 'the device\'s remembered English does not override the text\'s own');
recs = await records();
const gRec = await page.evaluate(async (id) => (await (await import('/flextext-editor/js/db.js')).getDoc(id)).flex.ws,
  recs.find((r) => r.title === 'Glossed text').id);
ok(JSON.stringify(gRec) === '{"vern":"xx","anal":"id"}', 'and the record now holds that choice');
await shot('14-older-record');
// switch to English right here: every analysis writing system is in the record, so it is a view — nothing read
await lines().nth(1).locator('.mg-pick').click();
await page.selectOption('#flex-ws-anal', 'en');
await page.waitForFunction(() => document.querySelector('#flex-ws-anal') && document.querySelector('#flex-ws-anal').value === 'en'
  && /K-en/.test(document.querySelector('#view-matcher').innerText), null, T(10000));
ok(!/satu/.test(await mtxt()), 'switched in place: English glosses, and no English translation (FLEx has none)');
ok(await page.evaluate(() => [...document.querySelectorAll('#view-matcher .mg-line')].findIndex((l) => l.classList.contains('mg-sel'))) === 1,
   'the selected line is still selected');
ok(await page.evaluate(() => !!document.querySelector('#view-matcher .mg-line .mg-g.mg-edit[data-edit-lang="en"]')), 'English glosses are editable');
// All languages: a view, nothing read — and every language's row is editable in its own language
await page.selectOption('#flex-ws-anal', 'all');
await page.waitForFunction(() => /L-id/.test(document.querySelector('#view-matcher').innerText) && /K-en/.test(document.querySelector('#view-matcher').innerText), null, T(5000));
ok(await page.evaluate(() => document.querySelectorAll('#view-matcher .mg-g-alt.mg-edit[data-edit-lang]').length >= 5), 'All stacks the other language under the first, each row editable');
// with work here, nothing is re-read, and Indonesian is still editable: the work and every language are in the record
await page.selectOption('#flex-ws-anal', 'en');
await caretIn(0, 1, 1);
await page.keyboard.press(' ');
await page.waitForFunction(() => document.querySelectorAll('#view-matcher .mg-line')[0].querySelectorAll('.mg-wstack .mg-w').length === 4, null, T(5000));
await page.selectOption('#flex-ws-anal', 'id');
await page.waitForFunction(() => /satu/.test(document.querySelector('#view-matcher').innerText), null, T(5000));
ok(await page.evaluate(() => !!document.querySelector('#view-matcher .mg-ft.mg-edit[data-edit-lang="id"]') && !!document.querySelector('#view-matcher .mg-g.mg-edit[data-edit-lang="id"]')),
   'with work here, Indonesian is shown — and editable');
ok(!/read-only/.test(await toasts()), 'nothing says read-only');
ok(await page.evaluate(() => document.querySelectorAll('#view-matcher .mg-line')[0].querySelectorAll('.mg-wstack .mg-w').length === 4), 'the work is untouched');
await page.selectOption('#flex-ws-vern', 'xx-x-ipa');
await page.waitForFunction(() => /Press Done, then Save to FLEx/.test([...document.querySelectorAll('.toast, #toast')].map((x) => x.innerText).join(' ')), null, T(5000));
ok(await page.locator('#flex-ws-vern').inputValue() === 'xx', 'the words wait for a save: the vernacular stays (its words are spelled in one)');
const gws = await page.evaluate(async (id) => (await (await import('/flextext-editor/js/db.js')).getDoc(id)).flex.ws,
  recs.find((r) => r.title === 'Glossed text').id);
ok(JSON.stringify(gws) === '{"vern":"xx","anal":"id"}', 'the vernacular is unchanged; the analysis writing system shown is remembered');
await shot('15-every-language-view');

// ── 8. Reset: this app's copy of a FLEx text, or of every text of the project (Seth, 2026-10-15: "I need
// a way to clear my cached or stale version of a text from FLEx (or reset all)") ────────────────────────
const recordOf = (project, title) => page.evaluate(async ([pj, ti]) => {
  const db = await import('/flextext-editor/js/db.js');
  const keys = [...await db.mediaKeys()];
  for (const d of await db.listDocs()) {
    if (!d.id.startsWith('flex-')) continue;
    const r = await db.getDoc(d.id);
    if (r.flex.project === pj && r.title === ti) return { id: r.id, draft: !!r.matchDraft, ws: r.flex.ws, recording: r.flex.recording || null, media: keys.includes(r.id) };
  }
  return null;
}, [project, title]);
await new Promise((r) => setTimeout(r, 700));   // the Matcher's draft autosave waits 400 ms after an edit (mgSaveDraft)
await page.click('#mg-back');
await waitHome();
await page.waitForFunction(() => /matching in progress/.test((document.querySelector('#flex-texts') || {}).innerText || ''), null, T(10000));
await textRow('Glossed text').locator('.flex-reset-text').click();
await page.waitForSelector('[data-flex-reset]', T(5000));
const rd = await page.locator('[data-flex-reset]').innerText();
ok(/unfinished matching/.test(rd) && /FLEx itself is not changed/.test(rd), 'the dialog says what is lost, and that FLEx is not changed: ' + rd.replace(/\n+/g, ' | ').slice(0, 220));
ok(await page.evaluate(() => !!document.activeElement && document.activeElement.hasAttribute('data-cancel')), 'Cancel is the default');
await shot('16-reset-dialog');
await page.keyboard.press('Escape');
await page.waitForSelector('[data-flex-reset]', { state: 'detached', timeout: 5000 });
ok((await recordOf('ws-write', 'Glossed text')).draft, 'Escape changes nothing');
await textRow('Glossed text').locator('.flex-reset-text').click();
await page.waitForSelector('[data-flex-reset]', T(5000));
await page.click('[data-flex-reset] [data-ok]');
await page.waitForFunction(() => !/matching in progress/.test((document.querySelector('#flex-texts') || {}).innerText || ''), null, T(10000));
let g8 = await recordOf('ws-write', 'Glossed text');
ok(g8 && !g8.draft && JSON.stringify(g8.ws) === '{"vern":"xx","anal":"id"}', 'reset: no draft, back in the text\'s own writing systems');
ok(g8 && g8.media && g8.recording && g8.recording.source === 'flex', 'the recording stays (it was not asked to go)');
ok(/this app's copy is FLEx's text again/.test(await toasts()), 'the toast says so');
await textRow('Glossed text').locator('.flex-open-text').click();
await waitMatcher();
await waitAudio();
ok(!(await page.locator('[data-flex-media]').count()), 'opening it asks nothing: the recording was kept');
ok(JSON.stringify(await wordsOf(0)) === '["kkk","lll","mmm"]', 'and it is FLEx\'s text: the unsaved word split is gone');
await page.click('#mg-back');
await waitHome();
// Reset all, forgetting the recordings too: "Two languages" carries a word split FLEx refused (section 6)
await page.click('#flex-reset-all');
await page.waitForSelector('[data-flex-reset]', T(5000));
const ra = await page.locator('[data-flex-reset]').innerText();
ok(/copies of 2 texts/.test(ra) && /1 of them has work done here that is not in FLEx/.test(ra), 'Reset all counts the copies, and the ones with work: ' + ra.replace(/\n+/g, ' | ').slice(0, 200));
await page.check('[data-flex-reset] [data-media]');
await page.click('[data-flex-reset] [data-ok]');
await page.waitForFunction(() => /2 texts reset from FLEx/.test([...document.querySelectorAll('.toast, #toast')].map((x) => x.innerText).join(' ')), null, T(15000));
recs = await records();
ok(!recs.some((r) => r.project === 'ws-write') && !(await recordOf('ws-write', 'Two languages')), 'every copy of this project\'s texts is gone, recordings too');
ok(recs.some((r) => r.project === 'media-copy') && recs.some((r) => r.project === 'struct-write'), 'other projects\' copies are untouched');
ok(!(await textRow('Two languages').locator('.flex-reset-text').count()), 'the rows have nothing to reset now');
await textRow('Two languages').locator('.flex-open-text').click();
await waitMatcher();
await waitAudio();
ok(JSON.stringify(await wordsOf(1)) === '["ddd","eee","f","ff"]' && await page.locator('#flex-ws-vern').inputValue() === 'xx',
   'opened afresh: FLEx\'s words (the saved split, not the refused one), in the text\'s own vernacular');
let t8 = await recordOf('ws-write', 'Two languages');
ok(t8 && t8.media && t8.recording && t8.recording.source === 'flex', 'FLEx\'s own link resolves, so the recording is copied again without a question');
await page.click('#mg-back');
await waitHome();
// A recording the user found for a link that points nowhere: forgetting it makes the shell forget its choice
await home();
await openProject('media-proj', 'read');
ok(!(await page.locator('#flex-project-actions').isVisible()) && await page.locator('#flex-reset-all').isVisible(), 'Reset all works read-only (it changes nothing in FLEx)');
await textRow('Missing link text').locator('.flex-reset-text').click();
await page.waitForSelector('[data-flex-reset]', T(5000));
await page.check('[data-flex-reset] [data-media]');
await page.click('[data-flex-reset] [data-ok]');
await page.waitForFunction(() => /gets its recording again/.test([...document.querySelectorAll('.toast, #toast')].map((x) => x.innerText).join(' ')), null, T(10000));
ok(!(await recordOf('media-proj', 'Missing link text')), 'the copy and its recording are gone');
await textRow('Missing link text').locator('.flex-open-text').click();
await page.waitForSelector('[data-flex-media]', T(10000));
ok((await page.locator('[data-flex-media] .flex-media-name').first().innerText()).includes('session-01.WAV'), 'the card asks again: the file chosen before is offered, not used unasked');
await page.click('[data-flex-media] [data-cancel]');
await page.waitForSelector('[data-flex-media]', { state: 'detached', timeout: 5000 });
await shot('17-after-reset');

// ── 9. a slow FLEx: the app says it is working (Seth, 2026-10-16: "We do need a loading spinner instead of
// just an app that looks like it's frozen after 'open' is clicked") ─────────────────────────────────────
const scrim = () => page.evaluate(() => { const el = document.querySelector('.rp-loading'); return el ? el.innerText : null; });
await home();
await rpc('close_project', []);
await rpc('__slow', ['open_project', 1500]);
await page.selectOption('#flex-project', 'media-copy');
await page.click('#flex-open-read');
const projScrim = await page.waitForSelector('.rp-loading', T(400)).then(() => scrim(), () => null);
ok(projScrim && /Opening media-copy/.test(projScrim) && await page.evaluate(() => !!document.querySelector('.rp-loading .rp-spinner')),
   'opening a project: a spinner and what is happening, at once: ' + JSON.stringify(projScrim));
await shot('18-opening-project');
await page.waitForSelector('#flex-texts li', T(10000));
ok(await scrim() === null, 'and gone once the texts are listed');
await rpc('__slow', ['open_project', 0]);
await rpc('__slow', ['open_text', 1500]);
await textRow('Missing link text').locator('.flex-open-text').click();
const textScrim = await page.waitForSelector('.rp-loading', T(400)).then(() => scrim(), () => null);
ok(textScrim && /Opening “Missing link text”/.test(textScrim), 'opening a text: the same, naming the text: ' + JSON.stringify(textScrim));
await waitMatcher();
ok(await scrim() === null, 'and gone once the Matcher is up');
await rpc('__slow', ['open_text', 0]);
await page.click('#mg-back');
await waitHome();

// ── 10. check-out / check-in with a merge (Seth, 2026-10-16: "a check-out and check-in with the original
// (before changes) version saved for comparison and diff/merge … change JUST what we change") ─────────────
// work done here, as the Matcher's Done leaves it: a line's free translation changed in the record
const editHere = (project, title, line, free) => page.evaluate(async ([pj, ti, li, fr]) => {
  const db = await import('/flextext-editor/js/db.js');
  for (const d of await db.listDocs()) {
    if (!d.id.startsWith('flex-')) continue;
    const r = await db.getDoc(d.id);
    if (r.flex.project !== pj || r.title !== ti) continue;
    const seg = r.doc.paragraphs[li].segments[0];
    seg.free = fr;
    seg.freeLang = 'en';
    r.modified = Date.now();
    await db.putDoc(r);
    return true;
  }
  return false;
}, [project, title, line, free]);
const flexDoc = async (title) => (await rpc('open_text', [(await flexText(title)).guid])).result.doc;
const reopenProject = async (edits) => {
  await page.click('#flex-close');
  await page.waitForFunction(() => document.querySelector('#flex-texts').hidden, null, T(10000));
  await rpc('__flexEdit', ['merge-write', 'Merge text', edits]);
  await openProject('merge-write', 'write');
};
await home();
await openProject('merge-write', 'write');
await textRow('Merge text').locator('.flex-open-text').click();
await waitMatcher();
await waitAudio();
await page.click('#mg-guess');
await page.waitForFunction(() => document.querySelectorAll('#view-matcher .mg-wave').length === 3, null, T(10000));
await page.click('#mg-done');
await waitHome();
await rowHas('.flex-save-text');
// FLEx changes the text meanwhile: a translation and a gloss, while the shell has let go of it
await reopenProject([{ kind: 'ft', line: 2, ws: 'en', value: 'line three, as FLEx has it' }, { kind: 'gloss', line: 0, word: 1, ws: 'en', value: 'G-FLEx' }]);
await textRow('Merge text').locator('.flex-save-text').click();
await page.waitForSelector('.flex-preview', T(10000));
const pv10 = await page.locator('.flex-preview').innerText();
ok(/FLEx changed 2 lines of this text since it was opened here; those changes stay/.test(pv10), 'the preview says FLEx\'s own changes stay: ' + pv10.replace(/\n+/g, ' | ').slice(0, 260));
ok((pv10.match(/Times:/g) || []).length === 3 && !/translation|Gloss/i.test(pv10.split('FLEx changed')[0]), 'and writes only the times done here');
await shot('19-merge-preview');
await page.click('.flex-preview [data-ok]');
await rowLacks('.flex-save-text');
let md = await flexDoc('Merge text');
ok(md.paragraphs[2].segments[0].free === 'line three, as FLEx has it' && md.paragraphs[0].segments[0].words[1].gls === 'G-FLEx', 'FLEx keeps its translation and its gloss');
ok((await flexText('Merge text')).timedSegs === 3, 'and has the three times done here');
recs = await records();
const m10 = recs.find((r) => r.project === 'merge-write');
ok(m10 && !m10.dirty && m10.timed === 3, 'this app\'s copy is FLEx\'s text again, times and all');
// the same translation changed on both sides → asked; "use mine"
await editHere('merge-write', 'Merge text', 0, 'line one, here');
await reopenProject([{ kind: 'ft', line: 0, ws: 'en', value: 'line one, in FLEx' }]);
await textRow('Merge text').locator('.flex-save-text').click();
await page.waitForSelector('[data-flex-merge]', T(10000));
const mdl = await page.locator('[data-flex-merge]').innerText();
ok(/Line 1: its free translation/.test(mdl) && await page.locator('[data-flex-merge] [data-mine]').count() === 1, 'both changed line 1\'s translation: the dialog names it and offers mine: ' + mdl.replace(/\n+/g, ' | ').slice(0, 200));
ok(await page.evaluate(() => document.activeElement && document.activeElement.hasAttribute('data-cancel')), 'Cancel is the default');
await shot('20-merge-conflict');
await page.click('[data-flex-merge] [data-mine]');
await page.waitForSelector('.flex-preview', T(10000));
await page.click('.flex-preview [data-ok]');
await rowLacks('.flex-save-text');
md = await flexDoc('Merge text');
ok(md.paragraphs[0].segments[0].free === 'line one, here', '"use mine": the translation done here is in FLEx');
// both changed the same translation again → "keep FLEx's": nothing of ours left, the copy is FLEx's again
await editHere('merge-write', 'Merge text', 1, 'line two, here');
await reopenProject([{ kind: 'ft', line: 1, ws: 'en', value: 'line two, in FLEx' }]);
await textRow('Merge text').locator('.flex-save-text').click();
await page.waitForSelector('[data-flex-merge]', T(10000));
await page.click('[data-flex-merge] [data-flex]');
await page.waitForFunction(() => /Nothing of yours was left to write/.test([...document.querySelectorAll('.toast, #toast')].map((x) => x.innerText).join(' ')), null, T(10000));
md = await flexDoc('Merge text');
ok(md.paragraphs[1].segments[0].free === 'line two, in FLEx', '"keep FLEx\'s": FLEx\'s translation stays');
ok(!(await textRow('Merge text').locator('.flex-save-text').count()), 'and nothing is left to save');
// work here, FLEx changed elsewhere: re-opening brings FLEx's change in under the work, asking nothing
await editHere('merge-write', 'Merge text', 2, 'line three, here');
await reopenProject([{ kind: 'gloss', line: 1, word: 0, ws: 'en', value: 'D-FLEx' }]);
await textRow('Merge text').locator('.flex-open-text').click();
await waitMatcher();
ok(!(await page.locator('.modal [data-ok]').count()), 'no question on opening');
await page.waitForFunction(() => /FLEx changed 1 line of this text since it was opened here\. That change is in, with your work/.test([...document.querySelectorAll('.toast, #toast')].map((x) => x.innerText).join(' ')), null, T(10000));
const mtx = await page.evaluate(() => document.querySelector('#view-matcher').innerText);
ok(/D-FLEx/.test(mtx) && /line three, here/.test(mtx), 'the Matcher shows FLEx\'s new gloss and the translation done here');
await page.click('#mg-back');
await waitHome();
await textRow('Merge text').locator('.flex-save-text').click();
await page.waitForSelector('.flex-preview', T(10000));
const pv10b = await page.locator('.flex-preview').innerText();
ok(!/FLEx changed/.test(pv10b) && /line three, here/.test(pv10b), 'the save after it writes the translation only (FLEx\'s change came in at the open)');
await page.click('.flex-preview [data-ok]');
await rowLacks('.flex-save-text');
md = await flexDoc('Merge text');
ok(md.paragraphs[2].segments[0].free === 'line three, here' && md.paragraphs[1].segments[0].words[0].gls === 'D-FLEx', 'FLEx has both');

// ── 11. this build writes only to a marked copy: one click makes one (Seth, 2026-10-16: "So far audio
// segmenter can't write at all yet. Now's the time to start changing that.") ─────────────────────────────
await home();
await rpc('close_project', []);
await page.selectOption('#flex-project', 'media-proj');
ok(await page.locator('#flex-open-write').isDisabled() && await page.locator('#flex-make-copy').isVisible(),
   'a project this build may not write: Open for writing is off, and the way to a copy is right beside the reason');
await page.click('#flex-make-copy');
await page.waitForSelector('[data-confirm-dialog]', T(10000));
const cdl = await page.locator('[data-confirm-dialog]').innerText();
ok(/media-proj - copy for writing/.test(cdl) && /without its Send\/Receive repository/.test(cdl) && /Close FLEx first/.test(cdl),
   'the confirmation names the copy, says Send/Receive stays behind, and asks for FLEx closed: ' + cdl.replace(/\n+/g, ' | ').slice(0, 200));
await shot('21-make-copy');
await page.click('[data-confirm-dialog] [data-cf="ok"]');
await page.waitForFunction(() => /Made “media-proj - copy for writing”/.test([...document.querySelectorAll('.toast, #toast')].map((x) => x.innerText).join(' ')), null, T(15000));
ok(await page.locator('#flex-project').inputValue() === 'media-proj - copy for writing' && !(await page.locator('#flex-open-write').isDisabled()),
   'the copy is chosen, and opens for writing');
ok(!(await page.locator('#flex-make-copy').isVisible()), 'it needs no copy of its own');
await page.click('#flex-open-write');
await page.waitForSelector('#flex-texts li', T(10000));
ok((await textRow('Missing link text').innerText()).length > 0 && await page.locator('#flex-project-actions').isVisible(), 'open for writing: the texts, and Undo/Redo/Import');

// ── 12. the text list: sort and filter (Seth, 2026-10-16: "sorting options for texts, including open/pending
// edits, most recently opened/edited (in this app, in FLEx), alphabetical, date created, etc. Also ability to
// filter (including by genre or checkbox)") ────────────────────────────────────────────────────────────────
const titles = () => page.evaluate(() => [...document.querySelectorAll('#flex-texts li .doc-name')].map((e) => e.textContent).join(' | '));
const count = () => page.evaluate(() => (document.querySelector('#flex-count') || {}).textContent || '');
await home();
await openProject('list-proj', 'read');
ok(await titles() === 'Água | bridge | Text 9 | Text 10', 'by title at first, accents and case ignored, numbers as numbers: ' + await titles());
ok(await count() === '4 texts', 'and how many: ' + await count());
const genreOpts = await page.locator('#flex-genre option').allInnerTexts();
ok(JSON.stringify(genreOpts) === '["All genres","Narrative (2)","Procedural (2)","No genre (1)"]', 'FLEx\'s genres, with how many texts each: ' + JSON.stringify(genreOpts));
await page.selectOption('#flex-genre', { label: 'Narrative (2)' });
ok(await titles() === 'Text 9 | Text 10' && await count() === '2 of 4 texts', 'one genre: ' + await titles());
await page.selectOption('#flex-genre', { label: 'No genre (1)' });
ok(await titles() === 'Água', 'texts with no genre');
await page.selectOption('#flex-genre', '');
await page.selectOption('#flex-sort', 'created');
ok(await titles() === 'Text 10 | Água | Text 9 | bridge', 'created in FLEx, newest first: ' + await titles());
await page.click('#flex-sort-rev');
ok(await titles() === 'bridge | Text 9 | Água | Text 10', 'reversed: oldest first');
await page.click('#flex-sort-rev');
await page.fill('#flex-q', 'agua');
ok(await titles() === 'Água', 'the search ignores accents and case');
await page.fill('#flex-q', 'zzz');
ok(/No text matches/.test(await page.locator('#flex-texts').innerText()), 'nothing matching says so');
await page.click('#flex-texts .flex-empty button');
ok(await titles() === 'Text 10 | Água | Text 9 | bridge' && await page.inputValue('#flex-q') === '', '…and Show all clears the filters (the sort stays)');
// a working set: checked texts, kept on this device for this project
await textRow('Text 9').locator('.flex-check').check();
await textRow('bridge').locator('.flex-check').check();
await page.check('#flex-list-tools [data-only="checked"]');
ok(await titles() === 'Text 9 | bridge', 'show only the checked ones: ' + await titles());
await shot('22-list-checked');
await home();
await openProject('list-proj', 'read');
ok(await titles() === 'Text 9 | bridge' && await page.isChecked('#flex-list-tools [data-only="checked"]') && await page.inputValue('#flex-sort') === 'created',
   'after a reload: the same checks, the same filter, the same sort');
await page.uncheck('#flex-list-tools [data-only="checked"]');
// opened here, latest first: open one, come back
await textRow('Água').locator('.flex-open-text').click();
await waitMatcher();
await page.click('#mg-back');
await waitHome();
await page.selectOption('#flex-sort', 'opened');
await page.waitForFunction(() => /^Água/.test([...document.querySelectorAll('#flex-texts li .doc-name')].map((e) => e.textContent).join(' | ')), null, T(5000));
ok((await titles()).startsWith('Água'), 'opened here, latest first: ' + await titles());
await page.check('#flex-list-tools [data-only="opened"]');
ok(await titles() === 'Água', 'show only the texts opened here');
await page.uncheck('#flex-list-tools [data-only="opened"]');
await page.selectOption('#flex-sort', 'title');
ok(/Narrative/.test(await textRow('Text 10').innerText()), 'each row names its genres');

// ── 13. a project's state is read again whenever it matters (Seth, 2026-10-16: "I still can't open for
// writing..." — the list was read once at start-up, so FLEx closed afterwards changed nothing here) ────────
await home();
await rpc('close_project', []);
await rpc('__lock', ['merge-write', true]);                      // FLEx opens the project
await page.selectOption('#flex-project', 'merge-write');         // choosing it reads its state again
await page.waitForFunction(() => /FieldWorks has this project open/.test((document.querySelector('#flex-reasons') || {}).innerText || ''), null, T(5000));
ok(await page.locator('#flex-open-write').isDisabled() && await page.locator('#flex-reasons .flex-recheck').isVisible(),
   'FLEx holding it: Open for writing is off, the reason says so, with Check again beside it');
ok(/FieldWorks has this project open/.test(await page.getAttribute('#flex-open-write', 'title')), 'the button says why too');
await shot('23-flex-holds');
await rpc('__lock', ['merge-write', false]);                     // FLEx closed…
await page.click('#flex-reasons .flex-recheck');                 // …Check again
await page.waitForFunction(() => !document.querySelector('#flex-open-write').disabled, null, T(5000));
ok(await page.locator('#flex-reasons').isHidden(), 'Check again: nothing stops it any more, and it is on');
await rpc('__lock', ['merge-write', true]);
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
await page.waitForFunction(() => document.querySelector('#flex-open-write').disabled, null, T(5000));
ok(true, 'coming back to this window reads it again (FLEx opened it meanwhile)');
await rpc('__lock', ['merge-write', false]);
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
await page.waitForFunction(() => !document.querySelector('#flex-open-write').disabled, null, T(5000));
ok(true, '…and again when FLEx has let go');

// ── 14. every analysis writing system kept and editable (Seth, 2026-10-16: "I want our app to cache and be able
// to edit (if the user wants) ALL writing systems (like they can switch from English to indonesian mid-way and
// their English changes will be saved)"; "If it edits a GUID object (a word), it should ONLY change what we
// changed and leave everything else preserved") ────────────────────────────────────────────────────────────
await home();
await openProject('ws-all', 'write');
const before14 = (await rpc('__flexRead', ['ws-all', 'Every language'])).result;
await textRow('Every language').locator('.flex-open-text').click();
await waitMatcher();
await waitAudio();
ok(await page.locator('#flex-ws-anal').inputValue() === 'en', 'opens in English, the analysis writing system it uses most');
const gloss14 = (li, wi, lang) => page.locator('#view-matcher .mg-line').nth(li).locator('.mg-wstack').nth(wi).locator(`.mg-g.mg-edit[data-edit-lang="${lang}"]`);
const free14 = (li, lang) => page.locator('#view-matcher .mg-line').nth(li).locator(`.mg-ft.mg-edit[data-edit-lang="${lang}"]`);
const type14 = async (loc, text) => { await loc.click(); await loc.fill(text); await loc.press('Enter'); };
// English: the first "kkk" (its gloss shared with the second) and line 1's translation
await type14(gloss14(0, 0, 'en'), 'K-en2');
await type14(free14(0, 'en'), 'one!');
// …then Indonesian, mid-way: a view, nothing read, and the English typed stays
await page.selectOption('#flex-ws-anal', 'id');
await page.waitForFunction(() => /K-id/.test(document.querySelector('#view-matcher').innerText), null, T(5000));
ok(!/read-only|Save this text to FLEx first|Press Done/.test(await toasts()), 'switching with work pending asks for nothing and says nothing is read-only');
await type14(gloss14(0, 0, 'id'), 'K-id2');                // the SAME word, in Indonesian
await type14(free14(1, 'id'), 'dua');                      // a line with no Indonesian yet
await type14(gloss14(1, 0, 'id'), 'N-id');                 // a word FLEx has no gloss for
await page.selectOption('#flex-ws-anal', 'all');
await page.waitForFunction(() => /K-en2/.test(document.querySelector('#view-matcher').innerText) && /K-id2/.test(document.querySelector('#view-matcher').innerText), null, T(5000));
ok(/one!/.test(await mtxt()) && /dua/.test(await mtxt()) && /N-id/.test(await mtxt()), 'All shows the English typed before the switch and the Indonesian typed after');
ok(await page.evaluate(() => document.querySelectorAll('#view-matcher .mg-g.mg-edit[data-edit-lang="id"]').length) === 5, 'every word has an editable Indonesian row, typed into or not');
await shot('24-every-language');
await page.click('#mg-done');
await waitHome();
await rowHas('.flex-save-text');
await textRow('Every language').locator('.flex-save-text').click();
await page.waitForSelector('.flex-preview', T(10000));
const pv14 = await page.locator('.flex-preview').innerText();
ok(/new gloss; the other 1 use\(s\) keep the old one — in English, Indonesian/.test(pv14), 'the preview: ONE new gloss for the shared word, naming both languages: ' + pv14.replace(/\n+/g, ' | ').slice(0, 400));
ok(/Free translation in English: “one” → “one!”/.test(pv14) && /Free translation in Indonesian: “—” → “dua”/.test(pv14), 'each translation by its language');
await page.click('.flex-preview [data-ok]');
await rowLacks('.flex-save-text');
const after14 = (await rpc('__flexRead', ['ws-all', 'Every language'])).result;
const C = (m) => JSON.stringify(Object.fromEntries(Object.entries(m || {}).sort()));   // a map, its keys in order
const gl = (L, w) => C(after14[L].words[w].gloss);
ok(gl(0, 0) === C({ en: 'K-en2', id: 'K-id2', fr: 'K-fr' }), 'the word: English and Indonesian as typed, French (never shown here) kept: ' + gl(0, 0));
ok(gl(0, 2) === C({ en: 'K-en', id: 'K-id', fr: 'K-fr' }), 'the other "kkk" keeps the gloss it shared, every language: ' + gl(0, 2));
ok(gl(0, 1) === C(before14[0].words[1].gloss), 'a word nobody touched is exactly as it was: ' + gl(0, 1));
ok(gl(1, 0) === C({ id: 'N-id' }) && after14[1].words[0].kind === 'gloss', 'the unglossed word gets an Indonesian gloss only');
ok(C(after14[0].ft) === C({ en: 'one!', id: 'satu', fr: 'un' }), 'line 1\'s translations: English as typed, Indonesian and French kept: ' + C(after14[0].ft));
ok(C(after14[1].ft) === C({ en: 'two', id: 'dua' }), 'line 2: Indonesian added, English kept: ' + C(after14[1].ft));
// one Save to FLEx is one FLEx history item: Undo takes every language back at once
await page.click('#flex-undo');
await rowHas('.flex-save-text');
ok(JSON.stringify((await rpc('__flexRead', ['ws-all', 'Every language'])).result) === JSON.stringify(before14), 'one Undo: FLEx holds exactly what it held before, in every language');
await page.click('#flex-redo');
await rowLacks('.flex-save-text');
ok(C((await rpc('__flexRead', ['ws-all', 'Every language'])).result[0].words[0].gloss) === C({ en: 'K-en2', id: 'K-id2', fr: 'K-fr' }), 'and one Redo puts it all back');
await textRow('Every language').locator('.flex-open-text').click();
await waitMatcher();
await waitAudio();
ok(await page.locator('#flex-ws-anal').inputValue() === 'all', 'the text re-opens in the view it was left in');
await page.click('#mg-back');
await waitHome();

// ── 15. FLEx's guesses, and audio past a FLEx text's last line (Seth, 2026-10-16: glosses typed into words FLEx
// shows in blue, then Done, then Save to FLEx — refused for "a line added here" nobody had added) ──────────────
await home();
await openProject('guess-write', 'write');
await textRow('Guessed here').locator('.flex-open-text').click();
await waitMatcher();
await waitAudio();
await page.selectOption('#flex-ws-anal', 'all');
await page.waitForFunction(() => !!document.querySelector('#view-matcher .mg-g.mg-guess'), null, T(5000));
const guess15 = gloss14(0, 0, 'en');
ok(await guess15.getAttribute('data-ph') === 'K-en' && /mg-guess/.test(await guess15.getAttribute('class')) && (await guess15.innerText()) === '',
   'FLEx\'s guess for kkk is shown in English — as a guess, not as a gloss the word has');
ok(await page.locator('#view-matcher .mg-line').nth(0).locator('.mg-wstack').nth(1).locator('.mg-guess').count() === 0, 'mmm: FLEx has nothing to guess');
const status15 = await page.locator('#mg-status').innerText();
ok(/1 more audio than lines\. FLEx makes its lines from its own text, so Done leaves the extra audio without a line/.test(status15),
   'the recording runs past the last line: said, and no blank line promised: ' + status15);
ok(await page.locator('#view-matcher .mg-insert').count() === 0, 'no + rows on a FLEx text');
await type14(gloss14(0, 0, 'id'), 'K-id');              // Indonesian typed into the word FLEx guesses English for
ok(await gloss14(0, 0, 'en').innerText() === 'K-en', 'typing adopted the guess: the English is the word\'s own now');
await shot('25-guess');
await page.click('#mg-done');
await waitHome();
await rowHas('.flex-save-text');
await textRow('Guessed here').locator('.flex-save-text').click();
await page.waitForSelector('.flex-preview', T(10000));
const pv15 = await page.locator('.flex-preview').innerText();
ok(/FLEx’s guess with your change, as a new gloss of the same analysis/.test(pv15), 'the preview: built on FLEx\'s guess: ' + pv15.replace(/\n+/g, ' | ').slice(0, 300));
ok(!/a line added here/.test(await toasts()), 'no "line added" refusal');
await page.click('.flex-preview [data-ok]');
await rowLacks('.flex-save-text');
const after15 = (await rpc('__flexRead', ['guess-write', 'Guessed here'])).result;
ok(after15.length === 2, 'FLEx has its two lines, as before: Done padded nothing');
ok(after15[0].words[0].kind === 'gloss' && C(after15[0].words[0].gloss) === C({ en: 'K-en', id: 'K-id' }),
   'kkk: FLEx\'s English kept beside the Indonesian typed: ' + C(after15[0].words[0].gloss));
ok(after15[0].words[1].kind === 'wordform', 'mmm, untouched, is as FLEx had it');
ok(C((await rpc('__flexRead', ['guess-write', 'Glossed elsewhere'])).result[0].words[0].gloss) === C({ en: 'K-en' }), 'the word elsewhere keeps its gloss as it was');

// ── 16. a record an older build kept (Seth's own): a gloss typed there into a word FLEx was guessing for, the
// guesses never read. Rebuilt in storage as that build left it, then saved: FLEx's English comes along. ────────
await page.evaluate(async () => {
  const db = await import('/flextext-editor/js/db.js');
  const { setGlossIn } = await import('/flextext-editor/js/flextext.js');
  const d = (await db.listDocs()).find((x) => x.title === 'Guessed here');
  const r = await db.getDoc(d.id);
  const strip = (doc) => doc.paragraphs.forEach((ln) => ln.segments.forEach((sg) => (sg.words || []).forEach((w) => { if (w.flex) { delete w.flex.guess; delete w.flex.adopted; } })));
  strip(r.doc); strip(r.flex.base);
  setGlossIn(r.doc.paragraphs[1].segments[0].words[0], 'id', 'N-id', r.doc.analLang || 'en');   // nnn: Indonesian alone
  await db.putDoc(r);
});
await home();
await openProject('guess-write', 'write');
await rowHas('.flex-save-text');
await textRow('Guessed here').locator('.flex-save-text').click();
await page.waitForSelector('.flex-preview', T(10000));
const pv16 = await page.locator('.flex-preview').innerText();
ok(/FLEx’s guess with your change/.test(pv16), 'the preview: built on FLEx\'s guess, read now: ' + pv16.replace(/\n+/g, ' | ').slice(0, 300));
await page.click('.flex-preview [data-ok]');
await rowLacks('.flex-save-text');
const after16 = (await rpc('__flexRead', ['guess-write', 'Guessed here'])).result;
ok(after16[1].words[0].kind === 'gloss' && C(after16[1].words[0].gloss) === C({ en: 'N-en', id: 'N-id' }),
   'nnn: the Indonesian typed in the older build, FLEx\'s English beside it: ' + C(after16[1].words[0].gloss));
ok(C(after16[0].words[0].gloss) === C({ en: 'K-en', id: 'K-id' }), 'line 1 as the save before left it');

ok(problems.length === 0, 'no page errors: ' + JSON.stringify(problems));
await browser.close();
if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log('\nall ok');
