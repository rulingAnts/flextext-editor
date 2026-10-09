/* THE TITLE BRIDGE IS FOR DISPLAY ONLY (plans/move-upload-guards.md G3).
 *
 * `bridgedIds` joins docIds whose HISTORY TITLES match. It was built for pre-v137 texts split across
 * two folders — and titles repeat (one recording assigned twice, numbered recording names), so it
 * also joins genuinely different texts. Fed into a move it delivered ANOTHER text's content (seen
 * once on a real estate); fed into cleanup and "Remove folder" it offered another text's copies to
 * the trash.
 *
 * And a second hazard found while designing the fix: "Remove folder" sits on every 'deleted' history
 * row, and every MOVE writes a 'deleted' row for the device it left. The folder lookup is by docId,
 * which the destination shares — so the button trashed the text's LIVE folder: backups, audio,
 * consent clip, consent receipt, manifest.
 *
 * The real functions are LIFTED out of researcher-panel.js (text-folder-files' technique) so a
 * rewrite fails here rather than a copy passing.
 *
 * Run: node --test test/bridge-display-only.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { conversionCaps } from '../docs/js/seg-exports.js';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const panel = rd('../docs/js/researcher-panel.js');
const i18n = rd('../docs/js/i18n.js');
const grab = (re, what) => { const m = panel.match(re); assert.ok(m, `${what} is findable`); return m[0]; };

const rolesSrc = grab(/const SOURCE_AUDIO_ROLES = [\s\S]*?const isFlextextName = [^;]*;/, 'the role sets');
const pickSrc = grab(/function pickSourceFiles\(files\) \{[\s\S]*?\n\}/, 'pickSourceFiles');
const cleanSrc = grab(/function cleanupCandidates\(allFiles\) \{[\s\S]*?\n\}/, 'cleanupCandidates');
const movSrc = grab(/async function moveSources\(fromId, docId, title\) \{[\s\S]*?\n\}/, 'moveSources');
const menuSrc = grab(/async function populateFilesMenu\(wrap\) \{[\s\S]*?\n\}\n/, 'populateFilesMenu');
const MANIFEST_NAME = 'flextext-manifest.json';

const file = (name, role = '', modified = '2026-09-10T00:00:00Z', id = null) =>
  ({ id: id || 'id-' + name + '-' + modified, name, role, modified, size: 100, mime: '' });
const MANIFEST = { schema: 3, docId: 'doc1', title: 'Cerita', origin: 'assigned', audio: null,
  files: [{ name: 'Cerita.flextext', role: 'source-flextext' }] };

// Two DIFFERENT texts that happen to share a title: doc1 (the one being acted on) and doc2.
const FOLDERS = {
  doc1: [file('Cerita.flextext', 'source-flextext', '2026-09-01T00:00:00Z'), file(MANIFEST_NAME, 'manifest', '2026-09-01T00:00:00Z'),
         file('Cerita 2026-09-05.flextext', '', '2026-09-05T00:00:00Z'), file('Cerita 2026-09-03.flextext', '', '2026-09-03T00:00:00Z')],
  doc2: [file('Cerita 2026-09-20.flextext', '', '2026-09-20T00:00:00Z'), file('Cerita 2026-09-19.flextext', '', '2026-09-19T00:00:00Z')],
};

test('moveSources asks for THIS docId\'s folder and never a same-title sibling\'s', async () => {
  const asked = [];
  const env = {
    MANIFEST_NAME,
    // A bridge that WOULD name doc2 — if moveSources still consulted it, the sibling would be listed.
    bridgedIds: () => ({ ids: ['doc1', 'doc2'], audioUrl: '', latestEventFileId: '' }),
    Researcher: {
      listTextFiles: async (_i, id) => { asked.push(id); return { files: FOLDERS[id] || [] }; },
      fetchDriveFile: async () => ({ text: async () => JSON.stringify(MANIFEST) }),
    },
  };
  const moveSources = new Function(...Object.keys(env), `${rolesSrc}\n${pickSrc}\nreturn (${movSrc.replace('async function moveSources', 'async function')});`)(...Object.values(env));
  const r = await moveSources('inst1', 'doc1', 'Cerita');
  assert.deepEqual(asked, ['doc1'], 'only the own folder is listed');
  assert.ok(r.all.every((f) => FOLDERS.doc1.includes(f)), 'and every candidate file is the own folder\'s');
  assert.ok(!/bridgedIds\(/.test(movSrc), 'the bridge is not consulted at all');
});

test('a failed listing throws, so the modal says the listing failed — not "no manifest"', async () => {
  const env = { MANIFEST_NAME, Researcher: { listTextFiles: async () => { throw new Error('offline'); }, fetchDriveFile: async () => null } };
  const moveSources = new Function(...Object.keys(env), `${rolesSrc}\n${pickSrc}\nreturn (${movSrc.replace('async function moveSources', 'async function')});`)(...Object.values(env));
  await assert.rejects(moveSources('inst1', 'doc1', 'Cerita'));
});

test('the Files menu picks, manifests and cleans from its OWN folder; only Download all is merged', async () => {
  let html = '';
  const menuEl = { set innerHTML(v) { html = v; }, get innerHTML() { return html; } };
  const wrap = { dataset: { i: 'i1', id: 'doc1', title: 'Cerita' }, querySelector: () => menuEl };
  const env = {
    t: (k, v) => (v ? `${k}(${JSON.stringify(v)})` : k), esc: (s) => String(s == null ? '' : s), fmtSize: (b) => `${b}B`,
    sanitizeBase: (s) => String(s || ''), MANIFEST_NAME, conversionCaps,
    bridgedIds: () => ({ ids: ['doc1', 'doc2'], audioUrl: '', latestEventFileId: '' }),
    driveFolderLink: () => '', Researcher: { listTextFiles: async (_i, id) => ({ files: FOLDERS[id], folderId: 'F_' + id + '_0123456789' }) },
    menuFetch: async () => ({ text: async () => JSON.stringify(MANIFEST) }), console: { warn() {} }, cleanupBlocked: () => false,
  };
  const fn = new Function(...Object.keys(env), `${rolesSrc}\n${pickSrc}\n${cleanSrc}\nreturn (${menuSrc.replace('async function populateFilesMenu', 'async function')});`)(...Object.values(env));
  await fn(wrap);
  assert.equal(wrap._allFiles.length, FOLDERS.doc1.length + FOLDERS.doc2.length, 'Download all still sees both folders');
  assert.deepEqual(wrap._ownFiles.map((f) => f.id).sort(), FOLDERS.doc1.map((f) => f.id).sort(), 'everything else sees doc1\'s alone');
  assert.ok(!/Cerita 2026-09-20/.test(html), 'the ".flextext" row is NOT the sibling\'s newer copy');
  assert.ok(/Cerita\.flextext|Cerita 2026-09-05/.test(html), '...it is one of this text\'s own');
  assert.ok(/pickSourceFiles\(ownFiles\)/.test(menuSrc) && /cleanupCandidates\(ownFiles\)/.test(menuSrc),
    'the picks and the cleanup list are computed over own-folder rows');
  assert.ok(/new Set\(ownFiles\.map\(\(f\) => f\.name\)\)/.test(menuSrc), 'declared-vs-present reads the own folder too');
});

test('Download all files a same-title text\'s copies under their own sub-folder', () => {
  const dl = grab(/async function downloadAllZip\(btn\) \{[\s\S]*?\n\}\n/, 'downloadAllZip');
  assert.match(dl, /const dir = id === docId \? '' : sanitizeBase\(t\('panel\.dl\.otherTextDir', \{ id: String\(id\)\.slice\(0, 8\) \}\)\) \+ '\/';/);
  assert.match(dl, /add\(f\.zipName \|\| f\.name,/, 'and the entry is added under that name');
});

test('"Remove folder" refuses while anything holds the text, and touches only its own folder', () => {
  const at = panel.indexOf("const hc = e.target.closest && e.target.closest('[data-histclean]');");
  const h = panel.slice(at, panel.indexOf("const cv = e.target.closest && e.target.closest('[data-conv]');", at));
  assert.ok(h.length > 200, 'the handler is findable');
  assert.ok(!/bridgedIds\(/.test(h), 'the bridge is gone from the trash path');
  assert.match(h, /if \(assignedDocIds\(\)\.has\(docId\) \|\| pendingMoves\.has\(docId\) \|\| inFlightAssignIds\(\)\.has\(docId\)\) \{/,
    'a device reporting it, a move or an assignment in flight — any of them refuses');
  assert.match(h, /if \(!tx \|\| !tx\.inUnassigned\) \{ deps\.toast\(t\('panel\.hist\.removeFolderNotFiled'\)/,
    'and unless the estate shows it filed under Unassigned, it refuses (unknown counts as no)');
  const guardAt = h.indexOf('assignedDocIds().has(docId)');
  const trashAt = h.indexOf('Researcher.trashFiles(');
  assert.ok(guardAt > 0 && trashAt > guardAt, 'the refusals come before anything is trashed');
  assert.match(h, /Researcher\.listTextFiles\(hc\.dataset\.i, docId\)/, 'one listing: this docId');
  assert.match(h, /t\('panel\.hist\.removeFolderOwnOnly'\)/, 'and the confirm says other texts are not touched');
});

test('every new G3 string is in English AND Indonesian', () => {
  for (const k of ['panel.hist.removeFolderLive', 'panel.hist.removeFolderNotFiled', 'panel.hist.removeFolderOwnOnly', 'panel.dl.otherTextDir']) {
    const n = (i18n.match(new RegExp(`^  '${k.replace(/\./g, '\\.')}':`, 'gm')) || []).length;
    assert.equal(n, 2, `${k} appears once per language`);
  }
});
