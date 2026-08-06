/* Exports from a .fxpa analysis — pure node, no DOM.
 *
 * The assertion that matters most here is structural: every renderer walks LEAF UNITS, not lines,
 * so the authored propositions we have agreed to build later drop in as data. `leavesOfLine` is
 * the single seam, and it is tested with props present even though nothing produces them yet.
 *
 * Run: node test/paragraph-export.test.mjs
 */
import { validateFxpa, groupUnits, editGroup, addProp, spanOf, topUnits, summaryLineOf, summaryOf } from '../docs/js/paragraph-model.js';
import { buildParagraphPreviewHtml, buildSsaSvg, buildSsaDiagramHtml, ssaLayout, leavesOfLine, topUnitsOf, leafLineIds, summaryText } from '../docs/js/paragraph-export.js';

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

/* Seth, 2026-08-05: "this app is going to be used by a number of older eyes. Our current rendering
 * of stacked brackets in the left margin is a bit busy and hard to keep track of." Every level was
 * the same colour, so a deep analysis was N identical parallel bars. */
console.log('\nstacked brackets are tellable apart');
{
  let deep = validateFxpa({ format: 'flextext-paragraph-analysis', version: 1,
    lines: [{ id: 'L1', free: 'a' }, { id: 'L2', free: 'b' }, { id: 'L3', free: 'c' }, { id: 'L4', free: 'd' }],
    tree: [] }).data;
  deep = groupUnits(deep, ['L1', 'L2'], { joinType: 'sym' });
  deep = groupUnits(deep, ['G1', 'L3'], { joinType: 'sym' });
  deep = groupUnits(deep, ['G2', 'L4'], { joinType: 'sym' });
  const html = buildParagraphPreviewHtml(deep, { title: 'T' });
  const depths = [...html.matchAll(/class="grp[^"]*" data-depth="(\d)"/g)].map((m) => m[1]);
  eq(depths, ['0', '1', '2'], 'each nesting level is tagged with its depth');
  ok(/\.grp\[data-depth="0"\] \{ border-left-color:#1f4f8f/.test(html)
     && /\.grp\[data-depth="2"\] \{ border-left-color:#8a5a00/.test(html),
     'and the CSS gives each depth its own colour');
  ok(/\.grp:has\(> \.badge:hover\)/.test(html), 'pointing at a heading traces its own bracket');
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

/* The SSA propositional display: one row per PROPOSITION, indented by depth, roles in a left
 * column, nested brackets spanning each grouping. The layout is computed in one pass so the SVG,
 * the scrollable page and (later) the PNG all share exactly the same geometry. */
console.log('\nSSA layout');
{
  const L = ssaLayout(doc, { width: 800 });
  eq(L.rows.map((r) => r.depth), [1, 1, 0], 'rows are indented by embedding depth');
  eq(L.rows.map((r) => r.label), ['grounds', 'CONCLUSION', ''], 'each member carries its ROLE in the left column');
  eq(L.rows.map((r) => r.head), [false, true, false], 'the prominent member is marked');
  eq(L.rows.map((r) => r.text), ['He went out.', 'I went to the village.', 'The child laughed.'],
     'SSA states propositions in the analysis language — the free translation, not the vernacular');
  eq(L.roots.length, 2, 'two top-level nodes: the grouping and the loose line');
  eq(L.roots[0].kind + ':' + L.roots[0].relation, 'group:grounds–CONCLUSION', 'the group node carries its relation');
  // PROMINENCE IS THE TRUNK: an asym group anchors on its HEAD child, so the line up to the parent
  // leaves from the prominent element rather than from the middle of the span.
  eq(L.roots[0].anchorY, L.rows[1].midY, 'the asym group anchors on its HEAD child, not the midpoint');
  ok(L.height > 0 && L.width === 800, 'the layout has real dimensions');
  ok(!L.rows.some((r) => r.text === ''), 'the hidden blank line contributes no row');

  const bl = ssaLayout(doc, { textSource: 'baseline' });
  eq(bl.rows[0].text, 'ana bete', 'the vernacular can be shown instead');

  // Wrapping uses an INJECTED measurement, so the app can pass real canvas metrics.
  const wide = ssaLayout(doc, { textWidth: 2000, measure: () => 10 });
  const narrow = ssaLayout(doc, { textWidth: 60, measure: (t) => t.length * 30 });
  ok(narrow.rows[0].blocks.items.length > wide.rows[0].blocks.items.length, 'narrower layout wraps into more lines');
  ok(narrow.height > wide.height, 'and is therefore taller');

  /* ⚠ THE TEXT COLUMN MUST NEVER BE PUSHED OFF THE CANVAS (Seth, 2026-08-05: "language data isn't
   * showing up in the diagram at all — at least if the diagram is at all thorough"). The text used
   * to get whatever width was LEFT OVER after the tree, so a deep analysis drew every line beyond
   * the right-hand edge, invisible. The canvas now grows instead. */
  let deep = doc;
  for (let i = 0; i < 5; i++) deep = { ...deep, tree: deep.tree };   // shape kept; depth exercised below
  const shallow = ssaLayout(doc, { textWidth: 400 });
  ok(shallow.textX + shallow.textWidth <= shallow.width, 'text fits inside the canvas');
  const indented = ssaLayout(doc, { textWidth: 400, levelWidth: 400 });
  ok(indented.textX + indented.textWidth <= indented.width,
     'and still fits when a wide indent pushes the tree out — the canvas grows, the text is not squeezed');
  ok(indented.width > shallow.width, 'a wider tree makes a wider diagram, not an invisible one');
  ok(indented.textWidth === shallow.textWidth, 'the requested text width is honoured either way');

  /* INTERLINEAR IN THE DIAGRAM (Seth, 2026-08-05): "one of the things that's unique about the tool
   * we're building is the ability to include, work with, and render interlinear text. Make sure
   * that's preserved, matching whatever view settings the user had before they exported." */
  {
    const il = ssaLayout(doc, { layer: 'interlinear', free: true });
    const cells = il.rows[0].blocks.items.filter((i) => i.type === 'words').flatMap((i) => i.cells);
    ok(cells.length > 0, 'interlinear rows carry word cells');
    ok(cells.some((c) => c.txt === 'ana' && c.gls === '3SG'), 'each cell pairs a word with ITS gloss');
    ok(il.rows[0].blocks.items.some((i) => i.type === 'free'), 'and the free translation rides along when the viewer showed it');
    ok(!ssaLayout(doc, { layer: 'interlinear', free: false }).rows[0].blocks.items.some((i) => i.type === 'free'),
       'free translation off in the viewer means off in the diagram');

    const svg = buildSsaSvg(doc, { layer: 'interlinear', free: true });
    ok(svg.includes('>ana<') && svg.includes('>3SG<'), 'the vernacular word AND its gloss reach the SVG');

    // The default is unchanged: SSA states propositions in the analysis language.
    ok(!buildSsaSvg(doc, {}).includes('>ana<'), 'default export is still the free translation, not the vernacular');
  }

  /* ROLE vs RELATION (Seth, 2026-08-05): "the relationship label wins and the daughter label
   * doesn't appear at all... daughter groups can have a relationship label as well as a
   * daughter/item label at the same time". A group's own role used to be dropped entirely. */
  {
    let n = validateFxpa({ format: 'flextext-paragraph-analysis', version: 1,
      lines: [{ id: 'L1', free: 'one' }, { id: 'L2', free: 'two' }, { id: 'L3', free: 'three' }], tree: [] }).data;
    n = groupUnits(n, ['L1', 'L2'], { joinType: 'asym', head: 'L2', relation: 'grounds–CONCLUSION' });
    n = groupUnits(n, ['G1', 'L3'], { joinType: 'asym', head: 'G1', relation: 'CONTENT–result',
                                      labels: { G1: 'CONTENT', L3: 'result' } });
    const svg = buildSsaSvg(n, {});
    ok(svg.includes('grounds–CONCLUSION'), "the inner group's relation is drawn");
    ok(svg.includes('CONTENT–result'), "the outer group's relation is drawn");
    ok(svg.includes('>CONTENT<'), "AND the inner group's ROLE in its parent is drawn — it used to vanish");
    ok(svg.includes('>result<'), 'the sibling leaf keeps its role too');

    // Either label can be suppressed, as published SSA displays often do.
    ok(!buildSsaSvg(n, { labels: 'relations' }).includes('>CONTENT<'), 'labels:relations hides the roles');
    ok(buildSsaSvg(n, { labels: 'relations' }).includes('grounds–CONCLUSION'), 'labels:relations keeps the relations');
    ok(!buildSsaSvg(n, { labels: 'roles' }).includes('grounds–CONCLUSION'), 'labels:roles hides the relations');
    ok(buildSsaSvg(n, { labels: 'roles' }).includes('>CONTENT<'), 'labels:roles keeps the roles');
  }

  /* ⚠ THE DEFAULT COLLAPSED RENDERING IS 'bracket' (changed 2026-08-07): every line still shows,
   * inside one bracket. 'leaf' — one summary row, the rest hidden — is the bigger claim to make on
   * the user's behalf, so it is opt-in. These assertions were written against the old default. */
  const col = ssaLayout(doc, { collapsed: ['G1'] });
  ok(col.rows.length > 2, 'by DEFAULT a collapsed group keeps its lines, inside one bracket');
  ok(col.roots.some((n) => n.kind === 'group' && n.collapsed), 'and is marked collapsed');
  const colLeaf = ssaLayout(doc, { collapsed: ['G1'], collapsedStyle: 'leaf' });
  eq(colLeaf.rows.length, 2, "'leaf' still reduces it to ONE row");
  ok(colLeaf.rows[0].collapsed && /village/.test(colLeaf.rows[0].text), 'showing its summary');
}

console.log('\nSSA SVG + the scrollable page');
{
  const svg = buildSsaSvg(doc, { width: 800 });
  ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), 'a real standalone SVG');
  ok(/viewBox="0 0 800 \d+"/.test(svg), 'with a viewBox so it scales');
  ok(svg.includes('grounds–CONCLUSION'), 'the relation is drawn');
  ok(!/rotate\(-90/.test(svg), 'relations are HORIZONTAL now — rotated labels collided on short groups');
  ok(/<path d="M [\d.]+ [\d.]+ V [\d.]+"/.test(svg), 'a vertical joiner across each grouping');
  ok(/<path d="M [\d.]+ [\d.]+ H [\d.]+"/.test(svg), 'and horizontal connectors — a tree, not just brackets');
  ok(svg.includes('>grounds<') && svg.includes('>CONCLUSION<'), 'the member roles are drawn');
  ok(/stroke-width="2.4"/.test(svg), 'the prominent line is drawn thicker — the trunk of the tree');
  ok(/fill="#2a6e2a"/.test(svg), 'and the prominent role label is marked');
  ok(!/<image|href="http/.test(svg), 'nothing external — the file stands alone');

  // A relation label must never run past its own bracket: two short brackets at the same depth
  // printed their labels over each other until this was clamped (found in a screenshot).
  const longRel = buildSsaSvg({ ...doc, tree: [{ ...doc.tree[0],
    relation: 'an extremely long relation label that would run into the next level of the tree' }] },
    { width: 900, levelWidth: 120 });
  ok(/…</.test(longRel), 'an over-long relation is truncated to its level, never printed across the next one');

  const nasty = buildSsaSvg({ ...doc, tree: [{ ...doc.tree[0], relation: '<script>x</script>' }] }, {});
  ok(!nasty.includes('<script>x</script>'), 'SVG text is escaped');

  const page = buildSsaDiagramHtml(doc, { title: 'Tosokai' });
  ok(page.startsWith('<!DOCTYPE html>') && page.includes('<svg'), 'the diagram page inlines the SVG');
  ok(/class="scroll"[^>]*>|\.scroll \{ overflow:auto/.test(page), 'and it scrolls rather than squashing a wide diagram');
  ok(/background:#fff/.test(page) && /color-scheme:light/.test(page), 'and is readable in dark mode');
}

/* PROPOSITION GROUPS ARE DRAWN AS TREE NODES (Seth, 2026-08-05: propositions "need to function as
 * leaves on the tree for the diagram, but not as independent audio segments"). */
console.log('\nthe diagram draws a line\'s proposition tree');
{
  let d = validateFxpa({ format: 'flextext-paragraph-analysis', version: 1,
    lines: [{ id: 'L1', start: 0, end: 2000, baseline: 'ana bete', free: 'He went out' },
            { id: 'L2', start: 2000, end: 3000, baseline: 'u sa', free: 'and I went home' }],
    tree: [] }).data;
  d = addProp(d, 'L1', 'the man went outside');
  d = addProp(d, 'L1', 'the child had laughed');
  d = addProp(d, 'L1', 'he was ashamed', { implicit: true });
  const [p1, p2, p3] = d.lines[0].props.map((x) => x.id);
  /* ⚠ head is p3, the EFFECT. The fixture used to declare head: p2 while labelling p2 'cause' and
   * p3 'EFFECT' — contradicting its own relation name. Harmless while labels were stored verbatim;
   * once case is normalised at storage (head UPPER, support lower) the contradiction became visible
   * as CAUSE/effect. Fixed the DATA, not the expectation. */
  d = groupUnits(d, [p2, p3], { joinType: 'asym', head: p3, relation: 'cause–EFFECT',
                                labels: { [p2]: 'cause', [p3]: 'EFFECT' } });
  const inner = d.tree[0].id;
  d = groupUnits(d, [p1, inner], { joinType: 'asym', head: p1, relation: 'EVENT–reason',
                                   labels: { [p1]: 'EVENT', [inner]: 'reason' } });

  const L = ssaLayout(d, { layer: 'free' });
  /* ⚠ ROW 0 IS THE LINE ITSELF, as unconnected context (changed 2026-08-06). It used to VANISH once
   * it had propositions — these expectations were written against that. The propositions are the
   * analyst's restatement of the sentence, so the sentence has to be visible to check them against. */
  eq(L.rows.map((r) => r.text),
     ['He went out', 'the man went outside', 'the child had laughed', 'he was ashamed', 'and I went home'],
     'the line appears first as context, then every proposition is its own row');
  ok(L.rows[0].context && !L.rows.slice(1).some((r) => r.context), 'only row 0 is context');
  eq(L.rows.map((r) => r.label), ['', 'EVENT', 'cause', 'EFFECT', ''],
     'each member carries its own role; the context row carries none');
  ok(L.rows[2].depth > L.rows[1].depth, 'the nested pair sits deeper than its sibling');
  ok(L.rows[3].implicit, 'the implied proposition is still marked implied');

  // The same document, propositions only — the old picture, now on request.
  eq(ssaLayout(d, { layer: 'free', lineContext: false }).rows.map((r) => r.text),
     ['the man went outside', 'the child had laughed', 'he was ashamed', 'and I went home'],
     'propositions-only reproduces the previous output exactly');

  const svg = buildSsaSvg(d, { layer: 'free' });
  ok(svg.includes('EVENT–reason') && svg.includes('cause–EFFECT'), 'both relations reach the SVG');
  ok(/\(he was ashamed\)/.test(svg.replace(/<[^>]+>/g, '')), 'and the implied one is bracketed');

  // ⚠ NOT INDEPENDENT AUDIO: the whole proposition tree still spans exactly its line.
  eq(spanOf(d, 'L1'), { start: 0, end: 2000 }, 'the line\'s span is unchanged by grouping inside it');
}

/* ⚠ ANTI-DRIFT GUARD (Seth, 2026-08-05: "I'm very afraid of multiple duplicate copies of code that
 * are out of sync"). paragraph-export.js RESTATES the flat-surface rule — which units are on the
 * surface, and in what order — because a format module may import only other format modules and so
 * cannot import paragraph-model.js. Two statements of one rule is exactly what drifts, so this
 * test asserts they agree on documents shaped to exercise every branch of it. */
console.log('\nthe model and the export must agree on what the surface IS');
{
  const shapes = [];

  // plain lines only
  let a = validateFxpa({ format: 'flextext-paragraph-analysis', version: 1,
    lines: [{ id: 'L1', free: 'a' }, { id: 'L2', free: 'b' }, { id: 'L3', free: 'c' }], tree: [] }).data;
  shapes.push(['plain lines', a]);
  shapes.push(['with a group', groupUnits(a, ['L1', 'L2'], { joinType: 'sym' })]);

  // propositions replace their line on the surface
  let b = addProp(addProp(a, 'L1', 'one'), 'L1', 'two');
  shapes.push(['a line with propositions', b]);

  // a BLANK proposition does not count — the line stays the unit
  shapes.push(['a blank proposition only', addProp(a, 'L2', '   ')]);

  // a cross-line group
  const p2 = b.lines[0].props[1].id;
  shapes.push(['a cross-line group', groupUnits(b, [p2, 'L2'], { joinType: 'sym' })]);

  // a blank LINE among them
  let c = validateFxpa({ format: 'flextext-paragraph-analysis', version: 1,
    lines: [{ id: 'L1', free: 'a' }, { id: 'L2', baseline: '' }, { id: 'L3', free: 'c' }], tree: [] }).data;
  shapes.push(['a blank line', addProp(c, 'L1', 'p')]);

  for (const [name, d] of shapes) {
    eq(topUnitsOf(d), topUnits(d), `export and model agree on the surface: ${name}`);
  }
}

/* ── The mother line enters at the MEAN y of the prominent members (Seth, 2026-08-06) ────────────
 * "treat the HEADS in a multi-head group as a range and center the mother-line to that group on
 * AVERAGE relative to the HEADS."
 * One expression, three cases: 1 head → its own y (unchanged); 2+ → midway; 0 → the span midpoint
 * (also unchanged). These pin all three so the single-head case can never silently drift. */
console.log('SSA anchor: mean of the prominent members');
{
  const doc = (heads) => ({
    format: 'flextext-paragraph-analysis', version: 1, title: 'T', vernLang: 'f', analLang: 'e',
    lines: [1, 2, 3].map((n) => ({ id: 'L' + n, baseline: 'b' + n, free: 'free ' + n, words: [] })),
    tree: [{ id: 'G1', children: ['L1', 'L2', 'L3'], heads, relation: 'r' }], view: {},
  });
  // the horizontal paths are the member stubs and then the mother line; the 4th is the anchor
  const anchor = (heads) => [...buildSsaSvg(doc(heads)).matchAll(/<path d="M [\d.]+ ([\d.]+) H/g)].map((m) => +m[1])[3];

  eq(anchor(['L1']), 31, 'ONE head at the top: the line enters at the head, not the middle');
  eq(anchor(['L2']), 61, 'one head in the middle');
  eq(anchor(['L3']), 91, 'one head at the bottom');
  eq(anchor(['L1', 'L2']), 46, 'two adjacent heads: midway between them');
  eq(anchor(['L1', 'L3']), 61, 'two NON-adjacent heads: the mean, which lands on the support between');
  eq(anchor([]), 61, 'no heads: the midpoint of the whole span, as before');
}

console.log('A line with propositions still appears — as context, unconnected');
{
  /* The bug this fixes: the line VANISHED once it had propositions, so a reader had the analyst's
   * restatement and no sentence to check it against. It now appears in place with no branch. */
  const base = {
    format: 'flextext-paragraph-analysis', version: 1, title: 'T', vernLang: 'f', analLang: 'e',
    lines: [
      { id: 'L1', baseline: 'ana bete', free: 'He went out.', words: [],
        props: [{ id: 'L1p1', text: 'He left the house' }, { id: 'L1p2', text: 'He walked away' }] },
      { id: 'L2', baseline: 'u sa', free: 'I went.', words: [] },
    ],
    tree: [{ id: 'G1', children: ['L1p1', 'L1p2'], heads: ['L1p1'], relation: 'sequence' }], view: {},
  };
  const L = ssaLayout(base, {});
  const texts = L.rows.map((r) => r.text);
  eq(texts, ['He went out.', 'He left the house', 'He walked away', 'I went.'],
     'the line sits IN SITU — immediately above the propositions that restate it');
  ok(L.rows[0].context === true, 'and it is marked as context, not as a node');
  ok(!L.rows[1].context && !L.rows[3].context, 'the propositions and a plain line are NOT context');

  // Unconnected: every row index the tree references, vs the context row's index.
  const referenced = new Set();
  const walk = (n) => { if (n.kind === 'leaf') referenced.add(n.row); else n.kids.forEach(walk); };
  L.roots.forEach(walk);
  ok(!referenced.has(0), 'NO branch is drawn to it — nothing in the tree references its row');
  ok(referenced.has(1) && referenced.has(2), 'the propositions ARE connected');

  // The context row lands INSIDE the group's vertical span (Seth: "inside the top level of that
  // group"), which falls out of the ordering rather than needing a rule.
  ok(L.rows[0].y < L.rows[1].y, 'it precedes its first proposition');

  // "Propositions only" — the old behaviour, now an explicit option.
  const P = ssaLayout(base, { lineContext: false });
  eq(P.rows.map((r) => r.text), ['He left the house', 'He walked away', 'I went.'],
     'lineContext:false omits the line where it has propositions...');
  ok(P.rows.every((r) => !r.context), '...and emits no context rows at all');

  // A line with NO propositions is untouched either way — it stands in for itself.
  ok(texts.includes('I went.') && P.rows.map((r) => r.text).includes('I went.'),
     'a line with no propositions contributes its own text in both modes');

  // One context row per line, however many propositions it has.
  const many = { ...base, lines: [{ ...base.lines[0],
    props: [{ id: 'L1p1', text: 'a' }, { id: 'L1p2', text: 'b' }, { id: 'L1p3', text: 'c' }] }, base.lines[1]],
    tree: [{ id: 'G1', children: ['L1p1', 'L1p2', 'L1p3'], heads: ['L1p1'], relation: 'r' }] };
  eq(ssaLayout(many, {}).rows.filter((r) => r.context).length, 1,
     'exactly ONE context row per line, not one per proposition');

  // A blank proposition never stands in for the line, so no context row is emitted for a line
  // that is rendering itself already.
  const blankProps = { ...base, lines: [{ ...base.lines[0], props: [{ id: 'L1p1', text: '   ' }] }, base.lines[1]], tree: [] };
  const B = ssaLayout(blankProps, {});
  eq(B.rows.map((r) => r.text), ['He went out.', 'I went.'],
     'all-blank propositions: the line renders as ITSELF, and is not also duplicated as context');
  ok(B.rows.every((r) => !r.context), 'and no context row is emitted');

  // It reaches the SVG.
  const svg = buildSsaSvg(base, {});
  ok(svg.includes('He went out.'), 'the context line reaches the SVG');
  ok(!buildSsaSvg(base, { lineContext: false }).includes('He went out.'),
     'and is absent from a propositions-only SVG');
}

console.log('collapsed groups: every head, and two renderings');
{
  const d = {
    format: 'flextext-paragraph-analysis', version: 1, title: 'T', vernLang: 'f', analLang: 'e',
    lines: [
      { id: 'L1', baseline: 'b1', free: 'He arrived', words: [] },
      { id: 'L2', baseline: 'b2', free: 'He sat down', words: [] },
      { id: 'L3', baseline: 'b3', free: 'The others waited', words: [] },
      { id: 'L4', baseline: 'b4', free: 'and I went home', words: [] },
    ],
    tree: [{ id: 'G1', children: ['L1', 'L2', 'L3'], heads: ['L1', 'L2'], relation: 'r',
             labels: { L1: 'FIRST', L2: 'SECOND', L3: 'setting' } }],
    view: { collapsed: ['G1'] },
  };

  /* ⚠ The regression this pins: summaries resolved an asym group through heads[0], so the SECOND
   * head of a multi-head group was silently dropped — in the very view meant to give the big
   * picture. */
  eq(summaryText(d, 'G1'), 'He arrived  ·  He sat down',
     'a collapsed multi-head group summarises by EVERY head, not just the first');
  eq(summaryLineOf(d, 'G1'), 'He arrived  ·  He sat down', 'and the model agrees (anti-drift)');
  eq(summaryOf(d, 'G1'), ['He arrived', 'He sat down'], 'summaryOf gives one entry per head');

  // A single head is unchanged — the join of one string is that string.
  const one = { ...d, tree: [{ ...d.tree[0], heads: ['L1'] }] };
  eq(summaryText(one, 'G1'), 'He arrived', 'a single-head group is unaffected');
  eq(summaryOf(one, 'G1'), ['He arrived'], 'and so is its summaryOf');

  // Rendering 1 — one summary line (the default).
  const leaf = ssaLayout(d, { collapsedStyle: 'leaf' });
  eq(leaf.rows.map((r) => r.text), ['He arrived  ·  He sat down', 'and I went home'],
     "'leaf': the collapsed group is ONE row");
  ok(leaf.rows[0].collapsed, 'and it is marked collapsed');
  ok(leaf.rows[0].blocks.items.filter((i) => i.type === 'line').length === 1,
     "'leaf' draws it as a single text line");

  /* Rendering 2 — 'bracket': EVERY line still shows, inside ONE bracket, with no internal
   * structure. Seth's analogy is the syntax-tree triangle: same job (mark the larger constituent,
   * suppress the detail below it), drawn as a bracket so the text stays readable. */
  const br = ssaLayout(d, { collapsedStyle: 'bracket' });
  eq(br.rows.map((r) => r.text), ['He arrived', 'He sat down', 'The others waited', 'and I went home'],
     "'bracket' keeps EVERY line, including the non-head members 'leaf' hides");
  eq(br.roots.length, 2, 'the group is still ONE node beside the ungrouped line');
  const grp = br.roots.find((n) => n.kind === 'group');
  eq(grp.kids.length, 3, 'one bracket spans all three of its lines');
  ok(grp.kids.every((k) => k.kind === 'leaf'), 'and every child is a LEAF — no internal sub-brackets');
  ok(grp.kids.every((k) => !k.label && !k.head),
     'member roles and heads are suppressed: that is the lower-level detail being ignored');
  eq(grp.relation, 'r', "but the group's OWN relation survives — it must still say how it relates");
  ok(grp.collapsed, 'and it is marked collapsed');

  // The two renderings are genuinely different pictures, which the old pair was not.
  ok(br.rows.length > leaf.rows.length, "'bracket' shows more than 'leaf', not the same thing re-laid out");

  /* ⚠ THE BRACKET ENCLOSES THE WHOLE RANGE — it used to run midpoint-to-midpoint, so it ended
   * INSIDE the first and last rows instead of around them (Seth's screenshot). Anchors stay
   * midpoints; only the drawn extent changed, and only for this rendering. */
  const rowsOf = (L) => L.rows;
  const first = br.rows[0], last = br.rows[br.rows.length - 2];   // -2: the ungrouped line is last
  ok(grp.spanTop <= first.y + 0.01, 'the bracket starts at or above the TOP of its first row');
  ok(grp.spanBottom >= last.y + last.height - 0.01, 'and ends at or below the BOTTOM of its last row');
  ok(grp.spanTop < grp.top && grp.spanBottom > grp.bottom,
     'so it is strictly taller than the anchor-to-anchor span it used to draw');

  /* ⚠ EVERY OTHER GROUP IS UNCHANGED. Seth: "The rest of the diagram formatting should remain
   * unchanged for all other things." */
  {
    const plain = ssaLayout({ ...d, view: {} }, {});
    const pg = plain.roots.find((n) => n.kind === 'group');
    const svgPlain = buildSsaSvg({ ...d, view: {} }, {});
    ok(!pg.collapsed, 'the same document uncollapsed has no collapsed group');
    ok(svgPlain.includes(`M ${pg.top} V`) || new RegExp(`V ${pg.bottom}\\b`).test(svgPlain)
       || svgPlain.includes(`${pg.top}`), 'an ordinary group still draws between its ANCHORS');
    // and gets no end arms
    const armRe = /M [\d.]+ [\d.]+ H [\d.]+ M [\d.]+ [\d.]+ H [\d.]+/;
    ok(!armRe.test(svgPlain), 'and no enclosing end arms');
    ok(armRe.test(buildSsaSvg(d, { collapsedStyle: 'bracket' })), 'which the collapsed bracket DOES get');
  }

  /* ⚠ ONE STEM IN, ONE BRACKET, NO PER-LINE STEMS (Seth, approved from a mockup): "the upstream
   * stem to go all the way to the items, and then don't have individual stems for each daughter,
   * just the encompassing bracket right up against them." */
  {
    const B = ssaLayout(d, { collapsedStyle: 'bracket' });
    const g2 = B.roots.find((n) => n.kind === 'group');
    const svgB = buildSsaSvg(d, { collapsedStyle: 'bracket', textWidth: 300 });
    const horiz = [...svgB.matchAll(/<path d="M ([\d.]+) ([\d.]+) H ([\d.]+)"/g)]
      .map((m) => ({ x1: +m[1], y: +m[2], x2: +m[3] }));
    // The collapsed run has 3 lines; if each still had a stem there would be 3 long horizontals
    // sharing this group's x. There must be exactly ONE — the stem into the bracket.
    const stems = horiz.filter((h) => Math.abs(h.y - g2.anchorY) < 0.5 && h.x2 - h.x1 > 100);
    eq(stems.length, 1, 'exactly ONE stem runs into the collapsed group — not one per daughter');
    ok(stems[0].x2 > B.textX - 20,
       'and it runs ALL THE WAY to the items, not stopping an indent short');
    // the bracket is hard against the text, not out at its own indent level
    const vert = [...svgB.matchAll(/<path d="M ([\d.]+) ([\d.]+) V ([\d.]+)"/g)].map((m) => +m[1]);
    ok(vert.some((vx) => vx > B.textX - 20), 'the bracket sits right up against the text');
    // no leaf stems inside the run: the only other horizontals are the ungrouped line + the arms
    const inside = horiz.filter((h) => h.y > g2.spanTop + 1 && h.y < g2.spanBottom - 1
                                       && Math.abs(h.y - g2.anchorY) > 0.5 && h.x2 - h.x1 > 40);
    eq(inside.length, 0, 'no individual daughter stems are drawn inside the bracket');
    // ⚠ the collapsed run must not widen the whole diagram with an unused indent level
    eq(B.maxDepth, ssaLayout(d, { collapsedStyle: 'leaf' }).maxDepth,
       'and the run adds no extra indent level, since its leaves have no stems to indent');
  }

  /* ⚠ THE GAP IS OUTSIDE THE BRACKET. A boundary drawn hard against the next line reads as
   * ambiguous — the row below looks like it might be inside it. */
  {
    const G = ssaLayout(d, { collapsedStyle: 'bracket' });
    const gg = G.roots.find((n) => n.kind === 'group');
    const after = G.rows[G.rows.length - 1];         // the ungrouped line below the run
    ok(after.y - gg.spanBottom >= 11,
       'there is real whitespace between the bracket and the next line');
    ok(gg.spanBottom <= G.rows[G.rows.length - 2].y + G.rows[G.rows.length - 2].height + 0.01,
       'and the bracket still hugs its OWN last row — the gap is outside it, not inside');
    // it costs height only where a collapsed run exists
    ok(G.height > ssaLayout(d, { collapsedStyle: 'bracket', runGap: 0 }).height,
       'runGap is what creates it, and is tunable');
    eq(ssaLayout({ ...d, view: {} }, {}).rows.some((r) => r.runStart || r.runEnd), false,
       'an uncollapsed document gets no run gaps at all');
  }

  const svg = buildSsaSvg(d, { collapsedStyle: 'bracket' });
  ok(svg.includes('The others waited'), "'bracket' shows a non-head member that 'leaf' summarises away");
  ok(!buildSsaSvg(d, { collapsedStyle: 'leaf' }).includes('The others waited'),
     "...and 'leaf' still hides it");

  /* ⚠ A run of ONE is not a bracket — a bracket around a single line says "constituent" about
   * nothing, so the line is promoted in place and keeps the group's role. */
  const single = { ...d, tree: [{ id: 'G1', children: ['L1', 'L2'], heads: ['L1'], relation: 'r',
                                  labels: { L1: 'ONLY' } }],
                   lines: [d.lines[0], { id: 'L2', baseline: '', free: '', words: [] }, d.lines[3]],
                   view: { collapsed: ['G1'] } };
  const solo = ssaLayout(single, { collapsedStyle: 'bracket', hideBlank: true });
  ok(solo.roots.every((n) => n.kind === 'leaf'), 'a collapsed group with one visible line draws no bracket');

  // A newline is a HARD break now — the mechanism the summary rendering rides on.
  const two = ssaLayout({ ...d, view: {},
    lines: [{ id: 'L1', baseline: '', free: 'one\ntwo', words: [] }], tree: [] }, { layer: 'free' });
  eq(two.rows[0].blocks.items.filter((i) => i.type === 'line').map((i) => i.text), ['one', 'two'],
     'a newline in ordinary text is honoured as a line break, not eaten as whitespace');
}

console.log('discourse slots are a THIRD, independent label');
{
  let d = validateFxpa({
    format: 'flextext-paragraph-analysis', version: 1, title: 'T', vernLang: 'f', analLang: 'e',
    lines: [1, 2, 3].map((n) => ({ id: 'L' + n, baseline: 'b' + n, free: 'free ' + n, words: [] })),
    tree: [], view: {},
  }).data;
  d = groupUnits(d, ['L1', 'L2'], { heads: ['L1'], relation: 'orienter–CONTENT',
                                    slot: 'Stage setting', labels: { L1: 'CONTENT', L2: 'orienter' } });
  const g = d.tree[0];

  /* ⚠ THE POINT OF THE FEATURE: a group carries a SEMANTIC relation and a POSITIONAL slot at the
   * same time. Merging them into one field would force the analyst to choose between an SSA
   * relation and Longacre-style plot structure. */
  eq(g.relation, 'orienter–CONTENT', 'the relation is untouched by the slot');
  eq(g.slot, 'Stage setting', 'and the slot is stored beside it');
  eq(g.labels, { L1: 'CONTENT', L2: 'orienter' }, 'member roles are untouched too');

  // Absent, not empty, when unset — most groups never have one.
  const bare = groupUnits(d, ['L3', g.id], { heads: [g.id], relation: 'r' });
  ok(!('slot' in bare.tree.find((x) => x.id !== g.id)), 'a group with no slot has NO slot key');

  // Editing one never disturbs the other.
  let e = editGroup(d, g.id, { relation: 'grounds–CONCLUSION' });
  eq(e.tree[0].slot, 'Stage setting', 'editing the relation leaves the slot alone');
  e = editGroup(d, g.id, { slot: 'Episode 1' });
  eq(e.tree[0].relation, 'orienter–CONTENT', 'editing the slot leaves the relation alone');
  eq(e.tree[0].labels, { L1: 'CONTENT', L2: 'orienter' }, 'and leaves the roles alone');

  // Clearing removes the key rather than storing ''.
  ok(!('slot' in editGroup(d, g.id, { slot: '   ' }).tree[0]), 'clearing the slot REMOVES the key');

  // Survives a save/open round trip.
  eq(validateFxpa(JSON.parse(JSON.stringify(d))).data.tree[0].slot, 'Stage setting',
     'the slot survives serialize → validate');

  // Reaches the diagram, both ways, and can be turned off.
  const stacked = buildSsaSvg(d, { slotStyle: 'stacked' });
  ok(stacked.includes('Stage setting') && stacked.includes('orienter–CONTENT'),
     'stacked: BOTH the slot and the relation are drawn — neither overprints the other');
  ok(!/rotate\(/.test(stacked), 'stacked draws no rotation');
  const rotated = buildSsaSvg(d, { slotStyle: 'rotated' });
  ok(rotated.includes('Stage setting') && /rotate\(-90/.test(rotated), 'rotated sets it vertically');
  /* ⚠ The relation is still DRAWN, but rotation reserves a column so a long name may be ellipsised
   * at the default indent — that is the deliberate trade (see the `room` note in the export). It
   * must never be dropped, and must never be printed through the rotated label. */
  ok(/orienter/.test(rotated), 'and still draws the relation, though rotation may shorten it');
  ok(buildSsaSvg(d, { slotStyle: 'rotated', levelWidth: 200 }).includes('orienter–CONTENT'),
     'a wider indent buys the full relation name back');
  ok(!buildSsaSvg(d, { slots: false }).includes('Stage setting'), 'slots:false hides them');

  /* ⚠ Slots are NOT governed by `labels` — a plot-structure chart may want slots and no semantic
   * labels at all. */
  const noSemantic = buildSsaSvg(d, { labels: 'roles' });
  ok(noSemantic.includes('Stage setting'), 'hiding relations does not hide slots');
}

console.log('an authored summary overrides the derived one');
{
  let d = validateFxpa({
    format: 'flextext-paragraph-analysis', version: 1, title: 'T', vernLang: 'f', analLang: 'e',
    lines: [1, 2].map((n) => ({ id: 'L' + n, baseline: 'b' + n, free: 'free ' + n, words: [] })),
    tree: [], view: {},
  }).data;
  d = groupUnits(d, ['L1', 'L2'], { heads: ['L1'], relation: 'r' });
  const gid = d.tree[0].id;

  eq(summaryLineOf(d, gid), 'free 1', 'with no authored summary it derives from the head');
  const withSum = editGroup(d, gid, { summary: 'The whole episode in one line' });
  eq(summaryLineOf(withSum, gid), 'The whole episode in one line',
     'an authored summary wins in the model');
  eq(summaryOf(withSum, gid), ['The whole episode in one line'], 'and in summaryOf');
  eq(summaryText(withSum, gid), 'The whole episode in one line',
     'and in the export — the anti-drift pair agree');

  // It reaches the 'leaf' rendering, which is what the option is for.
  const L = ssaLayout({ ...withSum, view: { collapsed: [gid] } }, { collapsedStyle: 'leaf' });
  eq(L.rows.map((r) => r.text), ['The whole episode in one line'],
     "the collapsed 'leaf' row shows the authored text, not the head's");

  // Absent unless set; clearing removes the key rather than storing ''.
  ok(!('summary' in d.tree[0]), 'a group with no summary has NO summary key');
  ok(!('summary' in editGroup(withSum, gid, { summary: '  ' }).tree[0]), 'clearing REMOVES the key');
  // and it survives a round trip
  eq(validateFxpa(JSON.parse(JSON.stringify(withSum))).data.tree[0].summary,
     'The whole episode in one line', 'it survives serialize → validate');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASS: the paragraph exports hold.\n');
process.exit(fail ? 1 : 0);
