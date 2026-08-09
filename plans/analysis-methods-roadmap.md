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

## 2. The unifying feature: METHOD PROFILES (vocabulary as data)

One new concept serves all five methods: a **method profile** — a named, data-only bundle of:

- a suggested **relation vocabulary** (datalist-style suggestions; free text stays free — a profile
  suggests, never restricts);
- suggested **role pairs** per relation (choose "grounds–CONCLUSION" and the member-role datalist
  offers "grounds"/"CONCLUSION");
- suggested **slot vocabulary** (Longacre: Aperture, Stage, Episode, Peak, Dénouement, Closure…);
- display hints (§4).

Stored **in the PAT save/`.fxpa` by name + inline copy**, so a file opened elsewhere still knows its
vocabulary (same self-describing principle as `.fxed`). Researcher-selectable; "no profile" =
today's behaviour exactly.

⚠ Profiles are DATA, not code — a JSON structure, node-testable, eventually editable via the same
D1-overlay pattern planned for localization (a researcher could author a house vocabulary). Do NOT
build the editor first; ship 3–4 built-in profiles, add authoring on the second real request.

## 3. Per-method gap analysis

### 3.1 Semantic Structure Analysis (SSA)
The labels design **is already the SSA convention** (the code comments say so explicitly). Gaps:
- an SSA relation/role profile (the standard relation inventory as suggestions);
- proposition-level units — **that is exactly what the one-tree plan delivers**: an FT-only line IS
  a proposition, added like any other line. SSA is the first consumer of that plan.
- `implicit` already exists for implicit information. ✅

### 3.2 Longacre Paragraph Analysis
- `slot` was BUILT for Longacre-style macrostructure ("Peak" is the code's own example). ✅
- Paragraph TYPES (narrative, expository, hortatory…; thesis–antithesis, point–amplification…):
  expressible today as `relation` on a paragraph-level group; a Longacre profile makes the
  vocabulary one keystroke instead of remembered.
- Later, optional: a columnar "Longacre chart" renderer (§4). Not needed to DO the analysis.

### 3.3 Dixon, clause-linking semantics
- The relation typology (temporal succession, cause/result/purpose, possible consequence, addition,
  disjunction, manner…) is a **profile**, nothing more.
- Dixon's focal-vs-supporting clause asymmetry maps exactly onto `heads`. ✅
- Unit granularity is the CLAUSE, below today's line: needs easy clause-splitting. `splitLine`
  exists; the one-tree model makes the result first-class. Audio-aligned texts: a split clause
  shares its line's span (0 ms rule) — already decided.

### 3.4 Arcing / bracketing / exegetical chunking (Biblearc-family)
- Chunk-to-propositions + labelled nested relations = exactly the tree. The arcing relation set
  (Ground, Inference, Action–Purpose, Idea–Explanation, Concessive…) = a profile.
- The genuinely new work is **display**: arcs/brackets along the text rather than the current
  chart. A renderer over the same tree (§4) — significant UI work, zero model work.
- These texts have no audio and no vernacular/gloss pair in the usual sense — the one-tree
  "render on what a line HAS" rule already covers FT-only display.

### 3.5 What NOT to do
- ❌ No per-method data models, no per-method file formats. One tree, one `.fxpa`/save.
- ❌ No enforced vocabularies — the field norm is adapted terminology; suggestions only.
- ❌ No method picker gating features — a profile is a lens, and switching profiles must never
  destroy or invalidate existing labels.

## 4. Display modes (each a renderer over the SAME tree)

1. **Bracket chart** — exists today.
2. **Arc view** — arcing convention; new renderer, likely the biggest single UI item here.
3. **Outline/columnar view** — Longacre chart-style. Cheap once the tree walk is factored for reuse.
4. Print/share: the self-contained preview-page pattern (like the segmentation preview) applied to
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
| 1 | **One-tree model** (`pat-one-tree-model.md` §7: migration → timeless lines → rendering) | decided; nothing |
| 2 | **Method profiles** (data + datalist suggestions + stored-in-save) | 1 (proposition units make profiles meaningful) |
| 3 | **SSA + Dixon + Longacre profiles** shipped built-in | 2 |
| 4 | **Open-data Greek import** (MACULA/SBLGNT → .fxpa, LTR first) | 1; independent of 2–3 |
| 5 | **Logos sample → mapping note → importer** | a sample from Seth |
| 6 | **Arc renderer**; outline renderer; printable chart | 1–2 |
| 7 | **Hebrew (RTL)** — own plan first | 4 |

Rationale for the order: 1–3 make the tool methodologically useful to a researcher TODAY on texts it
already opens; 4 brings original-language text in with zero licensing risk; RTL is deliberately last
because it is the widest-blast-radius engine change in the list (every app renders lines).

## 7. Standing backlog it joins (for one prioritisation view)

- `paired-audio-delete-gate` — built + tested, parked for Seth's go-ahead.
- Files ▾ menu redesign (hidden in v318; per-kind ids since v319 make the data trustworthy).
- `driveFolderId` in the inventory report (enables a direct "open folder in Drive" link).
- Localization overlay (D1) + suite-wide localization; parked translations.
- `.fxed` transfer format (zip reader + $blob pair are steps 1–2, pure and testable).
- PAT durability/sync story.
- Editor→FLEx guid semantics: similarity gate shipped v320; FLEx-side re-import behaviour now
  documented (FLEx honours guids).
