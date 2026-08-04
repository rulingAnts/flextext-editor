/* Exports from a .fxpa analysis — pure node, no DOM.
 *
 * The assertion that matters most here is structural: every renderer walks LEAF UNITS, not lines,
 * so the authored propositions we have agreed to build later drop in as data. `leavesOfLine` is
 * the single seam, and it is tested with props present even though nothing produces them yet.
 *
 * Run: node test/paragraph-export.test.mjs
 */
import { validateFxpa } from '../docs/js/paragraph-model.js';
import { buildParagraphPreviewHtml, leavesOfLine, topUnitsOf, leafLineIds, summaryText } from '../docs/js/paragraph-export.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `\n        got:  ${JSON.stringify(a)}\n        want: ${JSON.stringify(b)}`}`);

const doc = validateFxpa({
  format: 'flextext-paragraph-analysis', version: 1, title: 'Tosokai', vernLang: 'fau', analLang: 'en',
  speakers: ['Barnabas', 'Tim'],
  lines: [
    { id: 'L1', start: 0, end: 1000, baseline: 'ana bete', free: 'He went out.', speaker: 'Barnabas',
      words: [{ txt: 'ana', gls: '3SG' }, { txt: 'bete', gls: 'go' }] },
    { id: 'L2', start: 1000, end: 2000, baseline: '', free: '', words: [] },              // silence
    { id: 'L3', start: 2000, end: 3000, baseline: 'u sa doba', free: 'I went to the village.', speaker: 'Tim',
      words: [{ txt: 'u', gls: '1SG' }, { txt: 'sa', gls: 'go' }, { txt: 'doba', gls: 'village' }] },
    { id: 'L4', start: 3000, end: 4000, baseline: 'toto ari', free: 'The child laughed.',
      words: [{ txt: 'toto', gls: 'child' }, { txt: 'ari', gls: 'laugh' }] },
  ],
  tree: [
    { id: 'G1', level: 1, children: ['L1', 'L2', 'L3'], joinType: 'asym', head: 'L3',
      relation: 'grounds–CONCLUSION', labels: { L1: 'grounds', L3: 'CONCLUSION' } },
  ],
  view: { layer: 'interlinear', free: true, audio: true, waves: 'compact', collapsed: [], hideBlank: true },
}).data;

console.log('\nthe unit walk');
{
  eq(topUnitsOf(doc), ['G1', 'L4'], 'top units in text order');
  eq(leafLineIds(doc, 'G1'), ['L1', 'L2', 'L3'], 'leaf lines under a group');
  ok(/CONCLUSION|village/.test(summaryText(doc, 'G1')), 'an asym group summarizes by its HEAD');
}

/* THE SEAM. Nothing produces `props` yet, but the renderers must already walk them, or adding
 * authored propositions later means rewriting every renderer instead of adding data. */
console.log('\nleaf units — the seam propositions will arrive through');
{
  const plainLine = doc.lines[0];
  eq(leavesOfLine(plainLine).map((x) => [x.id, x.isProp]), [['L1', false]],
     'a line with no propositions IS one leaf — today\'s behaviour, unchanged');
  const withProps = { ...plainLine, props: [
    { id: 'L1p1', text: 'the enemy destroyed the city' },
    { id: 'L1p2', text: 'they were afraid', implicit: true },
  ] };
  eq(leavesOfLine(withProps).map((x) => [x.id, x.isProp, !!x.implicit]),
     [['L1p1', true, false], ['L1p2', true, true]],
     'a line WITH propositions yields one leaf each, carrying the implicit flag');
  // And the renderer draws them without any change to itself.
  const html = buildParagraphPreviewHtml({ ...doc, lines: [withProps, ...doc.lines.slice(1)] }, { title: 'T' });
  ok(html.includes('the enemy destroyed the city'), 'the preview renders an authored proposition');
  ok(/class="prop implicit"/.test(html), 'and marks an implicit one for the SSA bracketing convention');
  // Seth: the brackets are a SETTING, default on.
  ok(/<body class="[^"]*brackets/.test(html), 'brackets are on by default');
  const noBr = buildParagraphPreviewHtml({ ...doc, lines: [withProps, ...doc.lines.slice(1)] }, { title: 'T', brackets: false });
  ok(!/<body class="[^"]*brackets/.test(noBr), 'and can be turned off');
  ok(/class="prop implicit"/.test(noBr), 'the proposition is still marked implicit either way');
}

console.log('\nthe preview page itself');
{
  const html = buildParagraphPreviewHtml(doc, { title: 'Tosokai', audioB64: 'QUJD', audioMime: 'audio/wav' });
  ok(html.startsWith('<!DOCTYPE html>'), 'a complete document');
  ok(html.includes('<title>Tosokai</title>'), 'titled');
  ok(html.includes('grounds–CONCLUSION'), 'the group label rides along');
  ok(html.includes('>grounds<') && html.includes('>CONCLUSION<'), 'and so do the member labels');
  ok(/class="grp[^"]*"/.test(html), 'groups render as brackets');
  ok(html.includes('class="head '), 'the HEAD member is marked');
  ok(html.includes('Barnabas') && html.includes('Tim'), 'speakers are shown');
  ok(html.includes('atob("QUJD")'), 'the audio is embedded, so the file stands alone');
  ok(html.includes('data-s="0" data-e="1000"'), 'rows carry their spans for playback');
  ok(!/<script[^>]*src=/.test(html) && !/<link[^>]*href="http/.test(html), 'nothing is fetched from the network');
  // A screenshot caught this where every DOM assertion passed: text colour without a background
  // means dark text on the browser's dark default for anyone in dark mode.
  ok(/body \{[^}]*background:#fff/.test(html) && /color-scheme:light/.test(html),
     'the page sets its own background, so dark-mode readers can actually read it');
  // READ-ONLY: none of the editing affordances may leak into an export.
  ok(!/id="pa-group"|Ungroup|Save \(\.fxpa\)/.test(html), 'no grouping or saving controls');
  ok(html.includes('button class="caret"') || html.includes('class="caret"'), 'but collapse still works');
}

console.log('\nblank lines, collapsed state and selection are honoured');
{
  const html = buildParagraphPreviewHtml(doc, { title: 'T' });
  ok(!/class="row"[^>]*data-s="1000"/.test(html), 'a hidden blank line is not exported');
  const shown = buildParagraphPreviewHtml(doc, { title: 'T', hideBlank: false });
  ok(/data-s="1000"/.test(shown), 'and is exported when blanks are shown');

  // Seth: collapsed groups export COLLAPSED (what you see is what you get).
  const col = buildParagraphPreviewHtml(doc, { title: 'T', collapsed: ['G1'] });
  ok(/class="grp collapsed"/.test(col), 'a collapsed group exports collapsed');
  ok(/class="summary"/.test(col), 'with its summary line');
  // The summary is always in the markup (CSS reveals it) so collapsing INSIDE the exported page
  // shows one too — a collapsed bracket with nothing under it reads as broken.
  ok(/class="summary"/.test(html), 'and the summary ships even for groups that are expanded at export');
  ok(/\.collapsed > \.summary \{ display:block/.test(html), 'CSS reveals it on collapse');

  // Seth: export a SELECTION.
  const part = buildParagraphPreviewHtml(doc, { title: 'T', only: ['L4'] });
  ok(part.includes('toto') && !part.includes('grounds–CONCLUSION'), 'only the selected unit is exported');
}

console.log('\ndisplay modes carry over');
{
  const bl = buildParagraphPreviewHtml(doc, { title: 'T', layer: 'baseline' });
  ok(/class="bl"/.test(bl) && !/class="wds"/.test(bl), 'baseline-only view');
  const noFree = buildParagraphPreviewHtml(doc, { title: 'T', free: false });
  ok(!/class="ft"/.test(noFree), 'free translations can be left out');
}

console.log('\nescaping — an export is a place where injection would be silent');
{
  const nasty = validateFxpa({
    format: 'flextext-paragraph-analysis', version: 1, title: '</title><script>bad()</script>',
    lines: [{ id: 'L1', baseline: '<img src=x onerror=bad()>', free: '"quoted" & <tagged>', words: [{ txt: '<b>', gls: '&' }] }],
    tree: [],
  }).data;
  // NB: the default layer renders WORDS, not the baseline — so exercise both layers, or the
  // "no <img> in the output" assertion passes for the wrong reason (the field is never rendered).
  const html = buildParagraphPreviewHtml(nasty, { title: nasty.title, layer: 'baseline' });
  ok(!html.includes('<script>bad()</script>'), 'a hostile title cannot break out');
  ok(!html.includes('<img src=x'), 'nor can hostile baseline text');
  ok(html.includes('&lt;img src=x'), 'it is escaped instead');
  const wordy = buildParagraphPreviewHtml(nasty, { title: 'T', layer: 'interlinear' });
  ok(wordy.includes('&lt;b&gt;') && !wordy.includes('<b>'), 'hostile WORD text is escaped too');
  ok(html.includes('&quot;quoted&quot; &amp; &lt;tagged&gt;'), 'and the free translation');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASS: the paragraph exports hold.\n');
process.exit(fail ? 1 : 0);
