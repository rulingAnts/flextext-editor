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
// switch to English right here: nothing done here, so FLEx's text is read again in it, in place
await lines().nth(1).locator('.mg-pick').click();
await page.selectOption('#flex-ws-anal', 'en');
await page.waitForFunction(() => document.querySelector('#flex-ws-anal') && document.querySelector('#flex-ws-anal').value === 'en'
  && /K-en/.test(document.querySelector('#view-matcher').innerText), null, T(10000));
ok(!/satu/.test(await mtxt()), 'switched in place: English glosses, and no English translation (FLEx has none)');
ok(/now shows Example → English/.test(await toasts()), 'the toast says what it shows now');
ok(await page.evaluate(() => [...document.querySelectorAll('#view-matcher .mg-line')].findIndex((l) => l.classList.contains('mg-sel'))) === 1,
   'the selected line is still selected');
ok(await page.evaluate(() => !!document.querySelector('#view-matcher .mg-line .mg-g.mg-edit')), 'English glosses are the editable ones now');
// All languages: a view, nothing read
await page.selectOption('#flex-ws-anal', 'all');
await page.waitForFunction(() => /L-id/.test(document.querySelector('#view-matcher').innerText), null, T(5000));
ok(await page.evaluate(() => document.querySelectorAll('#view-matcher .mg-g-alt').length >= 5), 'All stacks Indonesian under English, read-only');
// with work here, nothing is re-read: Indonesian is SHOWN read-only, and the words wait
await page.selectOption('#flex-ws-anal', 'en');
await caretIn(0, 1, 1);
await page.keyboard.press(' ');
await page.waitForFunction(() => document.querySelectorAll('#view-matcher .mg-line')[0].querySelectorAll('.mg-wstack .mg-w').length === 4, null, T(5000));
await page.selectOption('#flex-ws-anal', 'id');
await page.waitForFunction(() => !!document.querySelector('#flex-mg-strip .flex-ws-ro'), null, T(5000));
ok(/satu/.test(await mtxt()) && await page.evaluate(() => !!document.querySelector('#view-matcher .mg-ft-alt')), 'with work here, Indonesian is shown read-only');
ok(/shown read-only/.test(await toasts()), 'and says why: the work is not in FLEx yet');
ok(await page.evaluate(() => document.querySelectorAll('#view-matcher .mg-line')[0].querySelectorAll('.mg-wstack .mg-w').length === 4), 'the work is untouched');
await page.selectOption('#flex-ws-vern', 'xx-x-ipa');
await page.waitForFunction(() => /Press Done, then Save to FLEx/.test([...document.querySelectorAll('.toast, #toast')].map((x) => x.innerText).join(' ')), null, T(5000));
ok(await page.locator('#flex-ws-vern').inputValue() === 'xx', 'the words wait for a save: the vernacular stays');
const gws = await page.evaluate(async (id) => (await (await import('/flextext-editor/js/db.js')).getDoc(id)).flex.ws,
  recs.find((r) => r.title === 'Glossed text').id);
ok(JSON.stringify(gws) === '{"vern":"xx","anal":"en"}', 'and the text\'s writing systems are unchanged');
await shot('15-read-only-view');

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

ok(problems.length === 0, 'no page errors: ' + JSON.stringify(problems));
await browser.close();
if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log('\nall ok');
