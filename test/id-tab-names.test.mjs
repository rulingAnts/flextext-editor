/* IN INDONESIAN, A TAB IS CALLED WHAT ITS BUTTON SAYS — EVERYWHERE (Seth, 2026-10-03).
 *
 * The editor's tabs read 'Ketik' and 'Terjemahan Balik' (tabs.baseline, tabs.gloss), but the
 * Researcher Panel's device settings said 'Tampilkan tab Dasar', 'Tampilkan tab Glos' and '…di tab
 * Gloss' — three names for two tabs, none of them on the screen. "A researcher reading the panel in
 * Indonesian cannot match those settings to the tabs their coworker sees." The switches are how a
 * researcher hands one coworker the typing and another the glossing; a label naming a tab that does
 * not exist turns that into guesswork, done from a distance.
 *
 * ⚠ THE NAMES ARE READ FROM tabs.* RATHER THAN WRITTEN HERE. The labels drifted because they were
 * typed separately from the tab they describe; a test with its own copy of 'Ketik' would drift the
 * same way the next time the tabs are renamed. Reading the tab's own string means a rename has to
 * carry the panel with it, or this fails.
 *
 * ⚠ The retired names are checked across the WHOLE id block, release notes and help HTML included —
 * the release-notes modal is read by the same researcher, beside the same settings. Only TAB names
 * are policed: 'glos' / 'gloss' / 'teks dasar' as the linguistic thing stay as they are. English is
 * out of scope — there the tabs really are Baseline and Gloss.
 *
 * Run: node test/id-tab-names.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');

/* Bounded like i18n-parity: the id block runs to the next `xx: {`, or to the dictionary's close. */
const idAt = SRC.indexOf('\nid: {') + 1;
const rest = SRC.slice(idAt);
const ends = [rest.slice(1).search(/\n[a-z]{2,3}: \{/), rest.indexOf('\n};')].filter((n) => n >= 0);
const ID_SRC = idAt > 0 ? rest.slice(0, Math.min(...ends) + 1) : '';
const FIRST_LINE = SRC.slice(0, idAt).split('\n').length;
const ID = new Map([...ID_SRC.matchAll(/^\s*,?'([a-zA-Z0-9_.\-]+)': '((?:[^'\\]|\\.)*)'/gm)].map((m) => [m[1], m[2]]));

const BASELINE = ID.get('tabs.baseline'), GLOSS = ID.get('tabs.gloss'), CUT = ID.get('tabs.cut');

test('the id block and its tab names are readable', () => {
  assert.ok(idAt > 0 && ID.size > 1000, `id block found (${ID.size} strings)`);
  for (const [k, v] of [['tabs.baseline', BASELINE], ['tabs.gloss', GLOSS], ['tabs.cut', CUT]]) {
    assert.ok(v && /^[\p{L} ]+$/u.test(v), `${k} is a plain name ('${v}')`);
  }
});

test('the panel switches name the tabs the coworker sees', () => {
  const tabIn = (k, name) => {
    assert.ok(ID.has(k), `id has ${k}`);
    assert.ok(new RegExp(`\\btab (?:\\\\u201c)?${name}\\b`).test(ID.get(k)),
      `${k} should name the tab '${name}' — it says: '${ID.get(k)}'`);
  };
  tabIn('panel.f.baselineTab', BASELINE);
  tabIn('panel.f.glossTab', GLOSS);
  tabIn('panel.f.cutTab', CUT);
  tabIn('panel.f.joinSplitBaseline', BASELINE);
  tabIn('panel.f.joinSplitGloss', GLOSS);
  tabIn('panel.f.joinSplitGlossNote', GLOSS);
});

/* ⚠ FLEx's OWN Interlinear tabs really are called Baseline and Gloss, in every language. A string
 * that sends someone to THAT tab is right to say so — give its key and a reason here, so the list
 * stays a set of decisions rather than a place to bury a drifted label. Empty is the normal state. */
const FLEX_TAB_ON_PURPOSE = {};

test('no Indonesian string calls an editor tab by a retired name', () => {
  const RETIRED = 'Dasar|Glos|Gloss|Glosa|Baseline';
  const ANY_TAB = `${RETIRED}|${BASELINE}|${GLOSS}|${CUT}`;
  const AND = '(?:,\\s*(?:dan |atau )?|\\s+(?:dan|atau|maupun)\\s+)';
  const PATTERNS = [
    // "tab Glos", "Tab Dasar", "tab <b>Gloss</b>", "tab “Dasar”"
    new RegExp(`\\b[Tt]abs? (?:<[a-z]+>|\\\\u201c|“)?(?:${RETIRED})\\b`),
    // a run of tab names with a retired one in it: "Dasar, Glos, atau Potong", "Ketik dan Gloss"
    new RegExp(`\\b(?:${RETIRED})${AND}(?:${ANY_TAB})\\b`),
    new RegExp(`\\b(?:${ANY_TAB})${AND}(?:${RETIRED})\\b`),
  ];
  /* Line by line rather than value by value, so multi-line template strings are read too; a line
   * that opens no key belongs to the last key that was opened. */
  const bad = [];
  let key = '';
  ID_SRC.split('\n').forEach((line, i) => {
    key = (line.match(/^\s*,?'([a-zA-Z0-9_.\-]+)':/) || [])[1] || key;
    if (key in FLEX_TAB_ON_PURPOSE) return;
    const m = PATTERNS.map((re) => line.match(re)).find(Boolean);
    if (m) bad.push(`i18n.js:${FIRST_LINE + i} ${key}: …${m[0]}…`);
  });
  assert.deepEqual(bad, [], `call the tabs '${BASELINE}' and '${GLOSS}', as their buttons do`);
});
