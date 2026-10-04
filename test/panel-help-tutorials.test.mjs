/* The tutorial videos in the Researcher panel's Help (Seth, 2026-10-04), and NOT in the Editor:
 * "it's a loophole for managed devices", and the videos are English, for the researcher. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const panel = rd('../docs/js/researcher-panel.js');
const i18n = rd('../docs/js/i18n.js');
const fn = (sig) => { const i = panel.indexOf(sig); assert.ok(i >= 0, sig); return panel.slice(i, panel.indexOf('\n}\n', i) + 3); };

test('three videos on Cloudflare Stream, played in Help, subtitles following the panel language', () => {
  const list = (panel.match(/const TUTORIALS = \[([\s\S]*?)\];/) || [])[1] || '';
  const uids = [...list.matchAll(/uid: '([0-9a-f]{32})'/g)].map((m) => m[1]);
  assert.equal(uids.length, 3);
  assert.equal(new Set(uids).size, 3);
  const src = fn('function tutorialIframeSrc(v, lang) {');
  assert.match(src, /TUTORIAL_STREAM}\/\$\{v\.uid}\/iframe\?/);
  assert.match(src, /if \(lang === 'id'\) q\.set\('defaultTextTrack', 'id'\)/);
  const help = fn('function showPanelHelp() {');
  assert.match(help, /tutorialIframeSrc\(v, getLang\(\)\)/, 'the panel language decides the subtitles');
  assert.match(help, /mount\(0\);/, 'the first video is ready when Help opens');
  assert.match(help, /rp-tut-credit/, 'the credit line is part of the agreement');
  assert.match(help, /\[data-more\]'\)\.addEventListener\('click', \(\) => \{ m\.close\(\); showPanelGuide\(\); \}\)/, '"More help…" hands over to the written guide');
});

test('every tutorial string exists in both languages, and the credit names the author', () => {
  for (const k of ['panel.help.more', 'panel.tut.title', 'panel.tut.n', 'panel.tut.1.name', 'panel.tut.2.name', 'panel.tut.3.name', 'panel.tut.credit']) {
    assert.equal(i18n.split(`'${k}':`).length - 1, 2, `${k} in EN and ID`);
  }
  assert.equal((i18n.match(/Brian Plimley\. (Used by permission|Digunakan dengan izin)\./g) || []).length, 2);
});

test('the Editor and the coworker apps carry none of it — no off-site video, no off-site link', () => {
  const app = rd('../docs/js/app.js');
  assert.doesNotMatch(app, /cloudflarestream\.com|flextext\.app\/#tutorial/);
  assert.doesNotMatch(rd('../docs/index.html'), /cloudflarestream\.com|#tutorial/);
  const helpHtml = (i18n.match(/'help\.html': `([\s\S]*?)`,/g) || []).join('');
  assert.doesNotMatch(helpHtml, /tutorial|cloudflarestream|flextext\.app\//i, 'the Editor help text names no video and no site');
});
