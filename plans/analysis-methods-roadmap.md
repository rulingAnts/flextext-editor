# Roadmap: PAT as a multi-method text-analysis tool (PLAN, not built)

**Status: design.** Seth, 2026-08-08: *"eventually we want this tool to be usable for Semantic
Structure Analysis, Longacre Paragraph Analysis, Dixon's Clause Combining Semantics approach, and
also Arcing/other Bible study/exegetical method text chunking/analysis approaches. I'd like to add a
path to import interlinear Greek and/or Hebrew texts from Logos."*

---

## 1. The load-bearing fact: the model is ALREADY method-agnostic

Verified against the code, not assumed. `paragraph-model.js` stores, on every group:

| field | what it is | hardcoded vocabulary? |
|---|---|---|
| `relation` | the group's own semantic label ("grounds–CONCLUSION", "ADDITION") | **NO — free text** |
| `labels` | `{ childId: role }` — each member's role in the parent's relation | **NO — free text** |
| `slot` | the group's DISCOURSE SLOT ("Stage setting", "Episode 1", "Peak") — positional, deliberately a separate field from the semantic `relation` | **NO — free text** |
| `heads` | asymmetric prominence (one or more heads vs supports) | structural |

Plus: single-parent, adjacency (no crossing brackets), derived levels, `implicit`, `splitLine`.
**Every methodology below is expressible in this model today** — what is missing is not structure
but *vocabulary support, unit granularity, display, and import paths*.

⚠ **The foundation assumption of this whole roadmap is the ONE-TREE model**
(`pat-one-tree-model.md`, decided 2026-08-08, **not yet implemented** as of v320): propositions and
language-data lines stop being distinct categories. A "proposition" is simply a line that happens to
carry only a free translation — timeless, invisible to audio alignment, rendered on what it HAS.
Everywhere this document says *unit*, *line*, or *proposition*, it means that one kind of thing.
Nothing below may reintroduce the distinction the one-tree plan removes.

That shapes the whole roadmap: per the core design principle (modularize app-specific, generalize
shared), the methodologies must NOT become five modes with five models. They are **one tree + one
labelling model**, differing in (a) suggested vocabulary, (b) unit granularity, (c) rendering,
(d) how text gets in.

## 2. The unifying feature: METHOD PRESETS (vocabulary + label schema + chart style, as data)

⚠ **Corrected by Seth (2026-08-08) — the differences between methods are BIGGER than vocabulary:**

> *"The main differences in these methods is chart-styling. Arcing vs. Longacre paragraph trees vs
> SSA. And also slot/filler/etc more than just two labels needed for chart nodes (not just role and
> relation, but also at least one more thing in Longacre/Hwang's model). And also building charts
> that branch left (not available yet) OR right (already done), ability to break and join segments
> (in progress or planned next), and I think in Longacre's trees, the upstream lines are just
> centered, and Head vs non Head is marked other ways."*

So a **method preset** is a named, data-only bundle with THREE parts, not one:

**(a) Label schema** — which label FIELDS exist, per group and per member, and what they are called.
Today the model has exactly: `relation` + `slot` per group, ONE free-text role string per member
(verified: `checkInvariants` coerces member-label values with `String(v)`). SSA fits that.
**Longacre/Hwang needs at least one more per-node field** — slot *and* filler (the constituent slot
a unit fills, and the paragraph/clause type filling it) — so member labels must generalize from
`{ childId: "role" }` to named fields, e.g. `{ childId: { role, filler, … } }`.
⚠ Do this WITHOUT a second migration: it changes the `.fxpa` shape, so it shares the one-tree
`version: 2` bump and repair path (`pat-one-tree-model.md` §6) — one migration, not two.
⚠ Storage stays GENERIC (named fields); the preset only decides which fields the UI offers and
what it calls them. No per-method storage shapes, ever.

**(b) Vocabulary** — datalist-style suggestions per field (relations, role pairs, slots, fillers).
Free text stays free: a preset suggests, never restricts, because the field norm is adapted
terminology.

**(c) Chart style** — the part that actually LOOKS different per method:
- **branch direction**: right-branching exists today; **left-branching does not** and is a real
  layout work item in paragraph-ui;
- **head-marking convention**: SSA marks heads explicitly; in Longacre's trees *"the upstream lines
  are just centered, and Head vs non Head is marked other ways"* (Seth has a sample chart + sample
  labels — get those before building the Longacre preset, not after);
- **renderer family**: bracket tree (exists) / arc (arcing) / sentence-diagram (§4).
⚠ Style must never change MEANING: the same tree + labels renders under any preset, and switching
presets must never destroy or invalidate data — a preset is a lens.

**Storage (Seth's design):** the user's preset LIBRARY — customizable, addable — lives in
**localStorage**; the **currently selected preset is saved WITH the `.fxpa` file** (by value, not
just by name, so a file opened on another device renders identically — the same self-describing
principle as `.fxed`). "No preset" = today's behaviour exactly. A D1-pushed house preset is a later
option on the localization-overlay pattern; do not build preset authoring UI first — ship the four
built-in presets, add authoring when a second real need appears.

## 3. Per-method gap analysis

Seth's distance-from-current ranking (2026-08-08), which is the build order inside this section:
**SSA = what the diagrams are built for today · Longacre = "different but only a little" ·
Dixon = "probably only subtly different" · Arcing / traditional sentence diagramming = "VERY
different".**

### 3.1 Semantic Structure Analysis (SSA) — the current chart IS this
The labels design **is already the SSA convention** (the code comments say so explicitly). Gaps:
- an SSA preset (relation inventory + role pairs as suggestions) — vocabulary only, no schema or
  style work;
- proposition-level units — **that is exactly what the one-tree plan delivers**: an FT-only line IS
  a proposition, added like any other line. SSA is the first consumer of that plan.
- `implicit` already exists for implicit information. ✅

### 3.2 Longacre Paragraph Analysis — different, but only a little
- `slot` was BUILT for Longacre-style macrostructure ("Peak" is the code's own example). ✅
- **Needs the label-schema extension (§2a)**: slot + filler per NODE, beyond one role string.
- **Needs the style knobs (§2c)**: upstream lines centered; head marked by convention, not by the
  SSA head styling. ⚠ **Blocked on inputs Seth already has**: *"I have a sample chart and sample
  labels"* — collect those FIRST; the preset is transcribed from them, not invented.
- Paragraph TYPES (narrative, expository, hortatory…; thesis–antithesis, point–amplification…) ride
  the vocabulary part.

### 3.3 Dixon, clause-linking semantics — probably only subtly different
- The relation typology (temporal succession, cause/result/purpose, possible consequence, addition,
  disjunction, manner…) is a **preset vocabulary**, little more.
- Dixon's focal-vs-supporting clause asymmetry maps exactly onto `heads`. ✅
- Unit granularity is the CLAUSE, below today's line: needs easy clause break/join — **in progress /
  planned next** (the split/join plan + one-tree). Audio-aligned texts: a split clause shares its
  line's span (0 ms rule) — already decided.

### 3.4 Arcing / traditional sentence diagramming (Biblearc-family) — VERY different
- The tree + labels still fit the model; the arcing relation set (Ground, Inference,
  Action–Purpose, Idea–Explanation, Concessive…) is a preset vocabulary.
- **Nearly all of the distance is the renderer**: arcs/brackets along the text — and likely
  LEFT-branching layout — rather than the current bracket chart. Significant UI work, zero model
  work. Schedule it last among the four, after presets prove out on the near ones.
- These texts have no audio and no vernacular/gloss pair in the usual sense — the one-tree
  "render on what a line HAS" rule already covers FT-only display.

### 3.5 What NOT to do
- ❌ No per-method data models, no per-method file formats. One tree, one `.fxpa`/save — presets
  differ in schema-fields-offered, vocabulary, and style, never in storage shape.
- ❌ No enforced vocabularies — the field norm is adapted terminology; suggestions only.
- ❌ No method picker gating features — a preset is a lens, and switching presets must never
  destroy or invalidate existing labels (including labels in fields the new preset does not show:
  hidden, not deleted).

## 4. Display modes (each a renderer over the SAME tree)

1. **Bracket chart, right-branching** — exists today (the SSA look).
2. **Left-branching layout** — does not exist; a preset style knob (§2c) and its own layout work in
   paragraph-ui. Needed before any method whose convention grows leftward.
3. **Longacre tree styling** — centered upstream lines, convention-marked heads; transcribed from
   Seth's sample chart.
4. **Arc / sentence-diagram view** — arcing convention; new renderer, the biggest single UI item
   here.
5. Print/share: the self-contained preview-page pattern (like the segmentation preview) applied to
   a finished analysis — a portable HTML chart. High field value, low risk, reuses a proven pattern.

## 5. Greek/Hebrew interlinear import

Two paths, and they are not competitors — one is Seth-driven, one is licence-clean by construction.

### 5.1 The Logos path (needs a SAMPLE before any code)
⚠ **First step is not code: Seth exports a real interlinear from Logos and we look at it.** Logos
export formats for interlinear panes vary by resource and version (copy/RTF/print exports; some
resources allow CSV/Excel of the interlinear columns). Designing an importer against a guessed
format is how importers fail. Deliverable for step 1: one Greek and one Hebrew sample export, then a
one-page mapping note (which column → which layer).
⚠ **Licensing**: text copied out of Logos carries the underlying resource's licence (NA28/UBS5 and
most study interlinears are restrictive). An import path is personal-use tooling; nothing imported
this way may ride a public sample or a test fixture in this repo.

### 5.2 The open-data path (works without Logos, redistributable)
Machine-readable, permissively licensed original-language interlinears exist and are ideal .fxpa
sources:
- **MACULA Greek / MACULA Hebrew** (Clear Bible; CC-BY-4.0) — word-level lemma, morphology, English
  glosses, syntax trees; TSV/XML.
- **SBLGNT** (free licence) for Greek text; **WLC** (public domain) for Hebrew.
A small converter (node script or import module) maps: verse → line, word → word with `txt` +
`gls` (+lemma/morph, §5.3), reference → line metadata. Text-only `.fxpa` is already first-class.

### 5.3 Engine work the import exposes (shared, not import-specific)
- **RTL rendering** for Hebrew: `dir` per writing system, cursor/selection behaviour in line
  editing, mixed-direction lines (Hebrew text + LTR glosses). The engine has no RTL support today;
  this is the deepest single item in this section and is worth its own plan when reached.
- **Fonts**: ship-with or link SBL-style fonts per writing system (font fields were removed from
  settings 2026-07-13 — Greek/Hebrew is the use case that may justify a constrained return, as a
  writing-system property rather than a device cosmetic).
- **Extra word layers** (lemma, parsing): flextext `<item>` types beyond txt/gls are already
  PRESERVED verbatim by the round-trip policy; the gap is DISPLAY (read-only extra interlinear
  rows) — not storage. Editing them stays out of scope.
- **Reference model**: book/chapter/verse as line metadata (where audio texts have time). Keep it
  metadata, not structure — verses are lines, pericopes are groups.

## 6. Suggested sequence (dependencies, not dates)

| step | what | depends on |
|---|---|---|
| 0 | **Collect Seth's Longacre sample chart + sample labels** — inputs, not code | nothing |
| 1 | **One-tree model** (`pat-one-tree-model.md` §7: migration → timeless lines → rendering) — break/join of segments rides here | decided; nothing |
| 2 | **Label-schema generalization** (named member-label fields, §2a) — ⚠ SAME `version: 2` migration as step 1, never a second one | 1 (same bump) |
| 3 | **Preset machinery** (library in localStorage; selected preset saved by value in the `.fxpa`; datalist suggestions) + the **SSA preset** (= today's behaviour, named) | 2 |
| 4 | **Dixon preset** (vocabulary; break/join already in from step 1) → **Longacre preset** (slot/filler fields + centered-upstream styling, from the sample) | 3; Longacre also 0 |
| 5 | **Left-branching layout** | 3 (a preset style knob) |
| 6 | **Open-data Greek import** (MACULA/SBLGNT → .fxpa, LTR first) | 1; independent of 2–5 |
| 7 | **Logos sample → mapping note → importer** | a sample from Seth |
| 8 | **Arc / sentence-diagram renderer**; printable chart | 3, 5 |
| 9 | **Hebrew (RTL)** — own plan first | 6 |

Rationale for the order: it follows Seth's distance ranking (SSA → Longacre/Dixon → arcing), makes
the tool methodologically useful on texts it already opens before adding import paths, folds both
schema changes into ONE file-format migration, brings original-language text in with zero licensing
risk before touching Logos, and keeps the two widest-blast-radius items (the arc renderer and RTL)
last, where the preset machinery and layout work they depend on already exist.

## 7. Standing backlog it joins (for one prioritisation view)

- `paired-audio-delete-gate` — built + tested, parked for Seth's go-ahead.
- Files ▾ menu redesign (hidden in v318; per-kind ids since v319 make the data trustworthy).
- `driveFolderId` in the inventory report (enables a direct "open folder in Drive" link).
- Localization overlay (D1) + suite-wide localization; parked translations.
- `.fxed` transfer format (zip reader + $blob pair are steps 1–2, pure and testable).
- PAT durability/sync story.
- Editor→FLEx guid semantics: similarity gate shipped v320; FLEx-side re-import behaviour now
  documented (FLEx honours guids).
