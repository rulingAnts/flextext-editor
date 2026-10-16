/* THE FLEx TEXT LIST, SORTED AND FILTERED (desktop-flex; plans/flex-desktop-segmenter.md §11.1). Seth,
 * 2026-10-16: "sorting options for texts, including open/pending edits, most recently opened/edited (in
 * this app, in FLEx), alphabetical, date created, etc. Also ability to filter (including by genre or
 * checkbox)." Made-up rows.
 *
 * Run: node test/flex-text-list.test.mjs */
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { arrangeTexts, TEXT_SORTS } = await import('../docs/js/flex-ops.js');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const N = { guid: 'gN', name: 'Narrative' }, P = { guid: 'gP', name: 'Procedural' };
const rows = [
  { guid: 'a', title: 'Text 10', flexIndex: 0, created: 300, modified: 900, genres: [N], segs: 10, timedSegs: 10, pending: false, openedAt: 50, recording: true, checked: false },
  { guid: 'b', title: 'Text 9', flexIndex: 1, created: 100, modified: 500, genres: [N, P], segs: 10, timedSegs: 2, pending: true, openedAt: 70, recording: true, checked: true },
  { guid: 'c', title: 'Água', flexIndex: 2, created: 200, modified: null, genres: [], segs: 4, timedSegs: 0, pending: false, openedAt: null, recording: false, checked: false },
  { guid: 'd', title: 'bridge', flexIndex: 3, created: null, modified: 700, genres: [P], segs: 0, timedSegs: 0, pending: true, openedAt: 10, recording: true, checked: true },
];
const ids = (view) => arrangeTexts(rows, view).map((r) => r.guid).join('');
const set = (view) => arrangeTexts(rows, view).map((r) => r.guid).sort().join('');   // which rows, whatever the order

console.log('sorting');
ok(ids({}) === 'cdba', 'title by default (FLEx hands texts over in GUID order, which nobody chose)');
ok(ids({ sort: 'pending' }) === 'bdac', 'work not in FLEx first, the latest opened first within each: ' + ids({ sort: 'pending' }));
ok(ids({ sort: 'pending', reverse: true }) === 'acbd', 'reversed: the rest first');
ok(ids({ sort: 'opened' }) === 'badc', 'opened here, latest first; never opened last: ' + ids({ sort: 'opened' }));
ok(ids({ sort: 'opened', reverse: true }) === 'dabc', '…and reversed, never opened still last: ' + ids({ sort: 'opened', reverse: true }));
ok(ids({ sort: 'changed' }) === 'adbc', 'changed in FLEx, latest first; no date last');
ok(ids({ sort: 'title' }) === 'cdba', 'title A–Z, accents and case ignored, "Text 9" before "Text 10": ' + ids({ sort: 'title' }));
ok(ids({ sort: 'title', reverse: true }) === 'abdc', 'title Z–A');
ok(ids({ sort: 'created' }) === 'acbd', 'created in FLEx, newest first; no date last');
ok(ids({ sort: 'timed' }) === 'cbad', 'least timed first; a text with no phrases last: ' + ids({ sort: 'timed' }));
ok(ids({ sort: 'nonsense' }) === 'cdba', 'an unknown sort (a setting from another build) is by title');
ok(TEXT_SORTS.length === 6 && TEXT_SORTS.every((k) => ids({ sort: k }).length === 4), 'every sort keeps every row');

console.log('filtering');
ok(set({ genre: 'gN' }) === 'ab' && set({ genre: 'gP' }) === 'bd' && set({ genre: 'none' }) === 'c', 'by genre, and texts with none');
ok(set({ q: 'agua' }) === 'c' && set({ q: 'TEXT' }) === 'ab' && set({ q: '  bri ' }) === 'd', 'title search ignores accents, case and spaces around');
ok(set({ only: { pending: true } }) === 'bd', 'only work not in FLEx');
ok(set({ only: { checked: true } }) === 'bd', 'only checked');
ok(set({ only: { opened: true } }) === 'abd', 'only opened here');
ok(set({ only: { recording: true } }) === 'abd', 'only with a recording here');
ok(set({ only: { untimed: true } }) === 'bc', 'only not fully timed (a text with no phrases is not "untimed")');
ok(ids({ genre: 'gP', only: { pending: true }, sort: 'title' }) === 'db', 'filters combine, then sort');
ok(arrangeTexts(rows, { q: 'zzz' }).length === 0 && rows.length === 4, 'nothing matching is an empty list; the rows are untouched');

if (fail) { console.error(`\n${fail} FAILED`); process.exit(1); }
console.log('\nall ok');
