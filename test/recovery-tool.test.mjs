/* The recovery tool (recovery/) — pure node.
 *
 * recovery/src/bundle.js is a PORT of app.js buildBundleFor's local-save branch, so that a text
 * recovered from a browser's files comes out exactly as the app's own Save would have written it.
 * A port drifts silently: the app's save logic changes, the tool keeps writing the old shape, and
 * nobody notices until a recovered file differs from a saved one. This pins the port to app.js's
 * SOURCE, line for line where the logic is shared, so the drift is a failing test instead.
 *
 * The end-to-end proof — the real app and the built tool, same Chromium profile, byte-identical
 * files — is test/browser/recovery-e2e.playwright.mjs, which needs a browser and is run by hand.
 *
 * Also here: the removal rules. The tool removes nothing itself; it hands the app its own
 * `?cleanup=` link, which matches by TITLE. These checks keep it from offering a link that could
 * remove a text nobody has saved.
 *
 * Run: node test/recovery-tool.test.mjs
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { consentReceiptText } from '../recovery/src/bundle.js';
import { deleteBlocker, cleanupLink, guessAppUrl } from '../recovery/src/ui.js';
import { originFromIdentifier } from '../recovery/src/recover.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const port = readFileSync(new URL('../recovery/src/bundle.js', import.meta.url), 'utf8');
const squash = (s) => s.replace(/\/\/.*$/gm, '').replace(/\s+/g, ' ').trim();

function fnBody(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return null;
  let depth = 0;
  for (let j = src.indexOf('{', i + header.length - 1); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(src.indexOf('{', i + header.length - 1), j + 1);
  }
  return null;
}

console.log('\nthe port still says what app.js says');
{
  const a = fnBody(app, 'function consentReceiptText(r) {');
  const b = fnBody(port, 'export function consentReceiptText(r) {');
  ok(a && b && squash(a) === squash(b), 'consentReceiptText is app.js\'s, verbatim');

  const save = fnBody(app, 'async function buildBundleFor(rec, withTimestamp, opts = {}) {');
  ok(!!save, 'app.js still has buildBundleFor');
  /* Each line the tool shares with the app, as the app writes it. When one of these fails, the
   * app's save changed: mirror the change in recovery/src/bundle.js, then update the line here. */
  const shared = [
    "const name = docFilename(rec);",
    "const base = name.replace(/\\.flextext$/, '');",
    "const spans = (Array.isArray(rec.doc && rec.doc.segments) && rec.doc.segments.length) ? rec.doc.segments : ((rec.doc && segmentsFromOffsets(rec.doc)) || []);",
    "const hasAligned = spans.some((s) => typeof s.start === 'number' && typeof s.end === 'number' && !s.timePending);",
    "const wantEaf = w.eaf ?? settings.exportEaf ?? expDefault;",
    "const wantSaymore = w.saymore ?? settings.exportSaymore ?? expDefault;",
    "const wantPreview = (w.preview ?? settings.exportPreview ?? expDefault) && caps.preview;",
    "const wantJson = w.fxpa ?? settings.exportJson ?? expDefault;",
    "segMedia = (working && working.blob && working.srcName === media.name) ? working : media;",
    "segMediaName = segMedia.derived ? derivedWavName(base) : mediaNameFor(base, segMedia);",
    "if (userAudio || consent || promptAudio || receipt || segEntries.length) {",
    "const entries = [{ name, data: xmlBlob }, ...segEntries];",
    "if (userAudio) entries.push({ name: mediaNameFor(base, media), data: media.blob });",
    "if (consent?.blob) entries.push({ name: consent.name || rec.consentClip, data: consent.blob });",
    "if (promptAudio?.blob) entries.push({ name: promptAudio.name || rec.consentPromptClip, data: promptAudio.blob });",
    "entries.push({ name: 'consent-receipt.json', data: new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' }) });",
    "entries.push({ name: 'consent-receipt.txt', data: new Blob([consentReceiptText(full)], { type: 'text/plain' }) });",
  ];
  for (const line of shared) ok(!!save && squash(save).includes(squash(line)), `app.js: ${line.slice(0, 90)}`);

  ok(squash(fnBody(app, 'function docFilename(rec) {') || '').includes("(sanitizeBase(rec.title) || 'text') + '.flextext'"), 'docFilename is still sanitizeBase(title) + .flextext');
  ok(squash(fnBody(app, 'function serializeDocBlob(rec, mediaName) {') || '')
    .includes("serializeFlextext(doc, settings, { mediaName, segTimes: segmentationEnabled(), timeNotes: settings.segTimeNotes !== false, producedBy: producedBy() })"),
  'serializeDocBlob still passes { mediaName, segTimes, timeNotes, producedBy }');
  ok(squash(fnBody(app, 'function segmentationEnabled() {') || '').includes('return settings.segmentation !== false;'), 'segmentationEnabled still defaults on');
  ok(/const SETTINGS_KEY = 'flextext-ws-settings';/.test(app), 'the device settings key is unchanged');
  ok(/const DB_NAME = 'flextext-editor'/.test(readFileSync(new URL('../docs/js/db.js', import.meta.url), 'utf8')), 'the database name is unchanged');
}

console.log('\nthe app\'s cleanup link, which the tool relies on to remove texts');
{
  ok(/cleanup: p\.get\('cleanup'\) \|\| ''/.test(app), 'app.js still reads ?cleanup=');
  const run = squash(fnBody(app, 'async function runTaskCleanup(spec) {') || '');
  ok(run.includes("spec.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)"), 'it still splits titles on commas, trimmed and lower-cased');
  ok(run.includes("titles.includes((d.title || '').toLowerCase())"), 'and matches a text by its whole title');
  ok(run.includes("if (!await confirmDialog(t('task.cleanupConfirm', { n: targets.length }))) return;"), 'and asks on the device, with the count, before deleting');

  const link = cleanupLink('https://example.org/flextext-editor/?x=1#h', ['Story of the river', 'Ünïcode — title']);
  const p = new URL(link).searchParams;
  ok(new URL(link).pathname === '/flextext-editor/' && [...p.keys()].join() === 'cleanup', `the link carries only cleanup (${link})`);
  ok(JSON.stringify(p.get('cleanup').split(',').map((s) => s.trim().toLowerCase())) === JSON.stringify(['story of the river', 'ünïcode — title']),
    'and the app reads back exactly the titles given');
}

console.log('\nwhich saved texts may be removed');
{
  const T = (title, modified = 5) => ({ title, modified });
  const a = T('River'), b = T('Mountain'), c = T('mountain'), d = T('Has, comma'), e = T(''), f = T(' Spaced');
  const all = [a, b, c, d, e, f];
  const claim = (t) => ({ modified: t.modified });
  ok(deleteBlocker(a, claim(a), all) === '', 'a saved, unchanged text with a unique title may be removed');
  ok(/not saved/.test(deleteBlocker(a, null, all)), 'a text never saved here may not');
  ok(/changed since/.test(deleteBlocker(a, { modified: 4 }, all)), 'nor one edited after it was saved');
  ok(/same title/.test(deleteBlocker(b, claim(b), all)), 'nor one whose title another text shares, ignoring case');
  ok(/comma/.test(deleteBlocker(d, claim(d), all)), 'nor one with a comma in its title');
  ok(/no title/.test(deleteBlocker(e, claim(e), all)), 'nor an untitled one');
  ok(/space/.test(deleteBlocker(f, claim(f), all)), 'nor one whose title the app could not match exactly');
}

console.log('\nwhere the app lives');
{
  ok(originFromIdentifier('https_rulingants.github.io_0') === 'https://rulingants.github.io', 'a Chromium folder name becomes its origin');
  ok(originFromIdentifier('http_localhost_8012') === 'http://localhost:8012', 'with its port when it has one');
  ok(guessAppUrl('https://rulingants.github.io') === 'https://rulingants.github.io/flextext-editor/', 'GitHub Pages: the editor\'s path');
  ok(guessAppUrl('https://flextext.app') === 'https://flextext.app/', 'elsewhere: the origin root');
}

console.log('\nthe page builds into one file');
{
  const out = execFileSync(process.execPath, [new URL('../recovery/build.mjs', import.meta.url).pathname], { encoding: 'utf8' });
  ok(/wrote recovery\/dist\/flextext-recovery\.html/.test(out), out.trim());
  const html = readFileSync(new URL('../recovery/dist/flextext-recovery.html', import.meta.url), 'utf8');
  ok(!/<script[^>]+src=|<link[^>]+href=["']https?:|\bimport\s*\(|^\s*import\s/m.test(html), 'it fetches nothing — it must open from a thumb drive with no network');
  ok((html.match(/<\/script>/g) || []).length === 1, 'and no string inside it closes its <script> early');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
