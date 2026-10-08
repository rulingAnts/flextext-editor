/* DOWNLOAD ALL (ZIP): THE CURRENT .flextext ON TOP, OLDER ONES IN A FOLDER WITH NO SPACE IN ITS NAME (v710; Seth,
 * 2026-10-09: "it's not always easy to tell which one is most recent/currently active … the most
 * recent/authoritative one is in the root while older ones go in a sub-folder" — "Let's not have a space in a
 * folder name. Because it will be incompatible with lameta.") zipEntryName is lifted out of the panel and run. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const PANEL = rd('../docs/js/researcher-panel.js'), I18N = rd('../docs/js/i18n.js');
const src = (name) => { const i = PANEL.indexOf(`function ${name}(`); return PANEL.slice(i, PANEL.indexOf('\n}\n', i) + 2); };
const zipEntryName = new Function(
  "const SOURCE_FT_ROLES = ['source-flextext', 'assigned-flextext'];"
  + "const hasRole = (f, roles) => roles.includes(String((f && f.role) || ''));"
  + "const isFlextextName = (f) => /\\.flextext$/i.test(String((f && f.name) || ''));"
  + src('zipEntryName') + '; return zipEntryName;')();

test('where each folder file lands', () => {
  const cur = { id: 'c', name: 'Snakes 2026-10-08 1412.flextext' };
  assert.equal(zipEntryName(cur, cur, 'Snakes', 'older_versions'), 'Snakes.flextext', 'the current one: the text\'s plain name, in the root');
  assert.equal(zipEntryName({ id: 'o', name: 'Snakes 2026-10-01 0930.flextext' }, cur, 'Snakes', 'older_versions'), 'older_versions/Snakes 2026-10-01 0930.flextext');
  assert.equal(zipEntryName({ id: 'a', name: 'Snakes.xml', role: 'assigned-flextext' }, cur, 'Snakes', 'older_versions'), 'older_versions/Snakes.xml', 'the original assignment is an older version too');
  assert.equal(zipEntryName({ id: 'w', name: 'Snakes.wav', role: 'source-audio' }, cur, 'Snakes', 'older_versions'), 'Snakes.wav', 'everything else stays where it was');
  assert.equal(zipEntryName({ id: 'm', name: 'flextext-manifest.json', role: 'manifest' }, cur, 'Snakes', 'older_versions'), 'flextext-manifest.json');
  assert.equal(zipEntryName({ id: 'o', name: 'x.flextext' }, cur, 'Snakes', 'versi lama'), 'versi_lama/x.flextext', 'a translation with a space is held to the rule');
  assert.equal(zipEntryName({ id: 'o', name: 'x.flextext' }, cur, 'Snakes', ''), 'older_versions/x.flextext');
  assert.equal(zipEntryName(cur, cur, '', 'older_versions'), 'text.flextext');
  assert.equal(zipEntryName({ id: 'x', name: 'only.flextext' }, null, 'B', 'older_versions'), 'older_versions/only.flextext', 'no current named: nothing claims the root');
});

test('downloadAllZip uses it — current = what every conversion in the zip is built from; the strings have no space', () => {
  const dl = src('downloadAllZip');
  assert.match(dl, /const currentFt = pickSourceFiles\(all\)\.flextext;/);
  assert.match(dl, /const ftBase = \(menuWrap && menuWrap\._menuSrc && menuWrap\._menuSrc\.base\) \|\| title \|\| 'text';/, 'the same base the ELAN/SayMore/.fxpa entries carry');
  assert.match(dl, /add\(zipName\(f\), await Researcher\.fetchDriveFile\(f\.id,/);
  assert.match(I18N, /'panel\.dl\.olderFolder': 'older_versions',/); assert.match(I18N, /'panel\.dl\.olderFolder': 'versi_lama',/);
});
