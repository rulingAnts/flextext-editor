# FlexText Corpus Manager — Architecture & Roadmap Plan

> Status: **planning / brainstorm only.** No build for days–weeks. This document
> captures research findings, a recommended architecture, and a phased roadmap.
> Recommendations marked **(my call — revisit)** are decisions still open to steer.
> This folder currently holds only this plan — **no app code yet.**

## Context

The goal is a fourth app in the FlexText suite: a **Windows-only desktop app** to
**manage a linguistics text corpus that lives inside an existing FLEx** (FieldWorks
Language Explorer) project — doing the cataloging/filtering/sorting/grouping and
project-management that FLEx itself doesn't provide, wrapped *around* the corpus
rather than duplicating FLEx. Four co-equal pillars:

1. **Corpus cataloging & organization** — browse/filter/sort/group texts by
   attributes FLEx can't (recursive genre/text-type tags read from FLEx's own genre
   list with inheritance, custom tags, metadata).
2. **Workflow / progress tracking (executive-function support)** — per-text,
   user-defined **stages and sub-stages** (record → transcribe → gloss → analyze →
   tag …), each optional/mandatory with prerequisites, **sortable and filterable** so
   you can see at a glance what's done and what's next across the whole corpus.
3. **Notes + custom tags linked to FLEx objects** — free-form observations that link
   to specific FLEx objects (texts, segments, words) by GUID, with their own
   recursive tag tree, made filterable/sortable/searchable so examples are easy to
   find and reuse later.
4. **Attachment / file management** — track each text's files: **original
   (archive-grade) recordings**, **cleaned-up listening copies**, **consent
   prompts/responses/receipts**, and any other attached files — cataloged,
   link-or-copy, with provenance and QC.

**A corpus record can exist *before* any FLEx text** — recorded and documented but not
yet transcribed or imported. Collecting texts **far ahead of transcription capacity**
(or handing recordings to a native speaker to pre-transcribe before FLEx import) is a
normal part of fieldwork, so the app treats the **pre-transcription backlog as a
first-class state**, not just texts already in FLEx.

Beyond the four pillars, two cross-cutting capabilities matter a lot for real research
use and are specced below (§6): **granular consent / academic-use permissions that gate
export**, and a **listening/playlist export** for easy review.

Later phases add **writing-system relabel** tools (fix misassigned WS codes, *not*
baseline rewriting), machine translation, and export/interop — secondary to the four
pillars above.

Two guardrails:
- It is a **new, additive app** — it must not disturb the existing satellites
  (recorder/researcher/crowd) or the Android/Electron shells. Its code lives in a
  **new top-level repo folder**; it consumes the **shared engine** as the single
  source of truth rather than forking it.
- It should **err toward read-only** against FLEx: don't duplicate FLEx data;
  read/link to it and deep-link users back into FLEx to edit. The narrow, guarded
  exceptions where we *do* write are: WS relabel (fix misassigned codes), the Media
  field, and **creating interlinear texts** in FLEx — either by auto-importing a
  FlexText Editor `.flextext`, or by creating a **blank text for a new in-app
  recording** — all with validation + `.fwdata` backup. We do **not** rewrite original
  transcription content (no baseline-WS swap). (**Clone-and-prune** export, §6, writes
  only to a *copy* of the project, never the original.)

Three background research passes (existing-engine reuse map, FLEx/flexlibs2/tech
stack, archive/interop landscape) inform everything below.

---

## 1. Positioning — a FLEx-corpus extension, not a lameta-style tool

This app is **not** a metadata/archiving manager and **not** a lameta competitor. On
review, lameta looks like SayMore-minus-annotation and doesn't do what we want. The
thesis is narrower and FLEx-anchored: **take the text corpus that already lives in a
FLEx project and add the cataloging, filtering, sorting, grouping, progress-tracking,
note/observation-linking, and attachment-file management that FLEx lacks** — wrapped
around the corpus, read-mostly against FLEx, deep-linking back via `silfw://`.

How the neighbors relate to us:

| Tool | What we take from it |
|---|---|
| **FLEx** | The corpus itself + genre list + objects. We read/link, don't duplicate; deep-link back to edit. |
| **lameta** ([lameta.org](https://www.lameta.org)) | **Only a reference for the metadata field set** — what should be *optionally* collectable per text (session / person / recording / consent / rights fields, IMDI/OLAC-derived). We do **not** adopt its scope, its UI, or hand archiving to it. |
| **ELAN / RAMP / OLAC / IMDI** | **Future interop doors only** (`.eaf`, OLAC/METS export) — left open, not a near-term goal. |

**Audio QC** (clipping/level/format-compliance detection) rides on the attachment
pillar as a bonus differentiator, not the point of the app.

---

## 2. Recommended tech stack — **pywebview** *(my call — revisit)*

The decision is driven by one hard fact: **`flexlibs` loads FLEx's .NET LCM
in-process via `pythonnet`.** So the app fundamentally *is* a Python process that
also needs an HTML/JS UI. pywebview makes Python the app and the webview the UI —
no IPC bridge to serialize FLEx objects across.

**Hard constraints that apply no matter which stack (locked facts, not preferences):**
- **64-bit Python** to match modern FLEx 9.x (must match FLEx's bitness).
- **FLEx must be installed** on the machine — `flexlibs` loads FLEx's
  `SIL.LCModel.*` DLLs at runtime (found via `FIELDWORKSDIR`/`ICU_DATA`/PATH set by
  the FLEx installer). We do **not** ship LCM ourselves (licensing/versioning
  minefield). So: *no FLEx install → the FLEx-linked features are unavailable*, and
  the app must say so gracefully.
- **"Share project contents with programs on this computer"** (FLEx → Project
  Properties → Sharing) must be **on** for our process to open a project FLEx also
  has open. We detect the `FP_FileLockedError` and show clear fix instructions +
  screenshots. Distinct from Send/Receive.
- **Write safety — emulate the FlexTools guard.** The **FlexTools app** provides a
  write-safe / "modify-enabled" run model (explicit opt-in to modify, preview/report
  before commit) that we should **duplicate as our confirm/preview/guard UX** — that
  is the pattern to copy. On top of it, belt-and-suspenders of our own: **copy
  `.fwdata` before any write**, prefer **read-only while FLEx is open**, write-enabled
  only when we hold the project alone. *(Whether flexlibs2's write path is undoable via
  FLEx's own stack or non-undoable — earlier research suggested the low-level lib uses
  a non-undoable unit of work — is a Phase-0 item to confirm against flexlibs2 +
  FlexTools directly.)*

**Why pywebview over the others:**

| | pywebview *(rec.)* | Tauri v2 | Electron |
|---|---|---|---|
| Windows renderer | System WebView2 | System WebView2 | Bundled Chromium |
| How Python runs | **In-process — Python *is* the app** | Frozen-exe **sidecar** over IPC | **Subprocess** over IPC |
| flexlibs integration | Direct, same process | Cross-process | Cross-process |
| User installs Python? | No (we PyInstaller-freeze it) | No | No |
| App size (excl. Python) | Small (relies on WebView2) | Smallest | ~200 MB on disk |
| Archival WAV capture | In-process Python (`sounddevice`/`soundfile`) | Python sidecar | Python subprocess |
| Complexity for THIS app | **Lowest** | High (Rust + IPC) | Medium-high (Node + IPC) |

- **Library = `flexlibs2`** (the [`MattGyverLee/Flexlibs`](https://github.com/MattGyverLee/Flexlibs)
  line), bundled into our frozen 64-bit interpreter (pip/GitHub). It builds on
  `pythonnet` (3.x) doing an in-process CLR load of FLEx's LCM. The separate
  **FlexTools app** is a GUI/Python-module runner with a **write-safe "modify" guard
  system** — we don't ship FlexTools, but we **emulate its guard model** (see §3).
  *(Exact `flexlibs2` vs `cdfarrow/flexlibs` API/version differences to be pinned down
  in the Phase-0 spike.)*
- **WebView2** is preinstalled on Win11 and near-universal on Win10; add a
  first-run check + installer bootstrap for the tail.
- **Audio caveat (all stacks):** the in-page `MediaRecorder` yields WebM/Opus, not
  arbitrary-bit-depth WAV. For **archival WAV at chosen bit depth**, capture on the
  **Python side** (`sounddevice` → `soundfile`/`wave`) — clean and exact with
  pywebview since Python is already in-process. (`getUserMedia` needs a secure
  context, so serve the UI over the built-in `http` server, never `file://`.)
- **Fallback:** choose **Electron** only if reusing the existing `electron/` shell
  tooling outweighs the ~200 MB and the two-process Python design.

---

## 3. The FLEx integration layer (Python / flexlibs)

Confirmed against `sillsdev/liblcm` + `cdfarrow/flexlibs` source:

- **Data model:** `Text` → `StText` → `StTxtPara` (its `Contents` `TsString` **is the
  baseline**) → `Segment` (free/literal translation + word/morpheme analyses).
- **Baseline writing system is DERIVED, not stored.** `IStText.MainWritingSystem` is
  read-only, taken from *the first character of the first paragraph*. Changing which WS
  is baseline would mean **physically rewriting the runs** of every paragraph's
  `Contents` — heavy original-data tampering. **We deliberately do NOT offer a
  baseline-swap feature** (see §6): the original transcription is preserved as-is, even
  if its WS isn't the database's preferred one. We *do* offer **WS relabel** (fix a
  misassigned WS code without changing the text), which is safe and data-preserving.
- **WS utilities available:** `GetWritingSystems()`, `GetAllVernacularWSs()`,
  `GetAllAnalysisWSs()`, `GetDefaultVernacularWS/AnalysisWS()`, `WSHandle(tag)`.
- **Genres = a real `CmPossibilityList`** (`LangProject.GenreListOA`); items are
  `CmPossibility` with **GUIDs** and **`SubPossibilitiesOS`** (hierarchy). `Text.Genres`
  is a reference collection. flexlibs can traverse (and, `writeEnabled`, edit) it. →
  Our recursive genre-tag system **reads this list** and does inheritance in *our*
  filter layer; users still edit the list in FLEx (we deep-link + instruct).
- **People / Sources / Participants** (for the permission model, §6): the project
  **People list** (`LangProject.PeopleOA`, a `CmPossibilityList` of `CmPerson`) holds
  speakers/participants; texts reference them for a **Source** (the recording's
  speaker/storyteller) and **participants** incl. the **transcriber**. We **read + link**
  these read-only for permission resolution. *(The exact FLEx fields/roles — how a Text
  records “Source” vs “Participant” vs “Transcriber”, and whether they're `CmPerson`
  refs or free text — is a **Phase-0 confirmation** against a real project; don't
  hard-code assumptions.)*
- **Deep links exist:** `silfw://localhost/link?app=flex&database=current&tool=…&guid=<GUID>…`
  is a registered Windows URL protocol; `flexlibs.BuildGotoURL(objOrGuid)` generates
  them for entries/senses/wordforms/reversals/texts. → "Open in FLEx" buttons are feasible.
- **Access pattern:** `OpenProject(name, writeEnabled=False)` (read-only default);
  mutations raise `FP_ReadOnlyError` unless write-enabled; close saves + disposes.

**Design rule:** a thin **Python FLEx-service module** wraps all flexlibs calls and
exposes a small, typed API to the UI via `window.pywebview.api` — read methods
(list projects, list texts, read segments/genres/WS/people, build goto-URLs) and a *few*
tightly-guarded write methods (WS relabel; Media field; **create an interlinear text**
— import a `.flextext` or create a blank text; **clone-and-prune** a project *copy* for
gated export). Every write path: verify preconditions → **back up `.fwdata`** → write in
one guarded unit of work → report.

---

## 4. Data & storage model — **files-as-truth + SQLite index** *(my call — revisit)*

Directly answers the "cloud sync hates live databases" concern by **separating the
two sync problems**:

- **Source of truth = plain structured documents** on disk (one per note, per
  text-record, per tag-tree, etc.) in the project folder — git/Dropbox/Drive/
  Backblaze-syncable, diffable, human + AI readable.
  - **Format = JSON for the app's own store** *(my call — revisit)*, pretty-printed
    (2-space) so it diffs and reads cleanly. Why JSON over YAML *here*: the store holds
    **arbitrary linguistic strings** (vernacular text, glosses, tone marks, tokens like
    `no`/`0`/`NO`), and YAML's whitespace-significance + type coercion (the "Norway
    problem", unquoted-scalar footguns) make it fragile and ambiguous for that. JSON is
    unambiguous and **native on both sides** (Python `json`; the JS engine already
    speaks JSON everywhere) with no extra parser to vendor.
  - **Accept YAML (and JSON) for human/AI-authored *import inputs*** — the bulk-import
    metadata sidecars a user or their AI assistant writes by hand (see §6) — and
    **normalize them to the internal JSON store on import.** That puts YAML's extra
    readability exactly where hand/AI editing happens, without exposing the whole store
    to YAML's fragility. (Note bodies may be **Markdown** with a small structured header.)
- **SQLite = a local, rebuildable query index** (never synced; gitignored/regenerated).
  Powers fast filtering/sorting/search and **recursive genre/tag inheritance** via
  recursive CTEs. If it's ever lost or corrupt, rebuild from the source documents.
- **Media/large binaries** live in a **managed file-store folder**, tracked by
  relative path + hash. Per-project and per-text setting: **link vs. copy ("embed")**.
- **FLEx data is NOT duplicated** — we store only references (GUIDs, `silfw://`),
  cached preview snippets, and *our* annotations.

**Sync / backup — two stores, two mechanisms (we host none of it; we structure the data
+ ship instructions so the user can):**
- **JSON project data → GitHub (private repo).** Git is ideal for the text/JSON store:
  free private repos, full history, real merges. Prefer **many small files** — one per
  note / text-record / tag-tree, plus a small top-level `project.json` manifest — rather
  than one monolith, so edits produce clean diffs and don't conflict on every change. We
  scaffold a **ready-made `.gitignore`** (excludes the file-store + the SQLite index) and
  give **step-by-step setup docs** (create private repo → init → commit → push). Ship a
  thin in-app **“commit & push” button** that shells to the user's own `git` (confirmed),
  plus a short **git-troubleshooting doc** for when it jams — its **primary advice is
  “select & copy the exact error text into an AI assistant and do what it says”**, backed
  by a few common fixes (auth/token expiry; `pull --rebase` on a push conflict; a
  large-file rejection means that file belongs in the **cloud file-store, not git**).
- **Media / attached files → cloud storage.** Large binaries don't belong in git — point
  **Drive Desktop / Dropbox / `rclone` / Backblaze B2** at the **file-store folder**. JSON
  references each file by **relative path + hash**, so the two stores reunite on any
  machine. Prefer **copy/embed** (not link) for anything that must travel. **Warn** about
  Google Drive Desktop's large-folder stalls; keep the **SQLite index out of both** (local,
  rebuildable).

**Project folder layout (makes the split clean — the two channels never overlap):**
```
<project>/
  data/         # JSON source-of-truth (+ project.json manifest) — git-tracked → GitHub
  files/        # media / attachments — cloud-synced (Drive/Dropbox/rclone/B2); gitignored
  index.sqlite  # local query cache — gitignored, rebuildable from data/
  .gitignore    # we scaffold this: ignores files/ and index.sqlite
```
So **git never sees the big media, and Drive never syncs the live database** — exactly
the two failure modes to avoid.

---

## 5. Engine reuse & repo layout — **vendor + self-update** *(my call — revisit)*

**Repo layout:** new top-level folder **`corpus-manager/`** (sibling to `electron/`,
`satellites/`, `android/`). It is **never served** (only `docs/` is published by
Pages), so it can't affect the live PWA or satellites. Suggested shape:
```
corpus-manager/
  PLAN.md              # this document
  CLAUDE.md            # its own contract (like satellites/*/CLAUDE.md) — later
  python/              # flexlibs FLEx-service, audio capture, QC, import, api bridge
  ui/                  # local HTML/JS UI (imports the shared engine modules)
  engine/              # vendored copy of reused docs/js modules + self-updater
  build/               # PyInstaller spec, WebView2 bootstrap
```

**Reuse (confirmed portable — dependency-injected already):**
- **`flextext.js`** — the crown jewel: FLEx `.flextext` parse/serialize/tokenize/
  segment/**lossless round-trip** + the in-memory interlinear model. Reused for
  import and the interlinear preview. (A small **`.eaf` reader** is net-new — `.eaf`
  is documented XML — feeding the same preview renderer; see §6.)
- **The record-mode consent/permissions modal** — the suite's consent flow (consent
  prompt/response capture + receipts; the `consentMode/Ask/Confirm/Msg/Audio`
  settings in `applyUrlSettings`). Reuse it so **in-app recording follows the exact
  same consent/permissions UX as the rest of the FlexText suite**, configurable by
  the user/researcher.
- **`crypto.js` / `sync.js` / `researcher.js` / `researcher-panel.js`** — the E2EE +
  Google-OAuth/Drive + Cloudflare-worker layer, all injected via `iface`/`deps`. Reuse
  for the Drive-browse/import and any researcher-account features. (OAuth is
  **server-mediated** by the worker — a new desktop origin must be **allow-listed in
  the worker + Google OAuth client**; the backend now lives in this repo's `worker/`
  folder [folded in], deployed to `*.workers.dev`.)
- The interlinear **rendering** patterns and i18n (`i18n.js`) as source material.

**Update strategy:** app serves the engine from its **own local `engine/` copy**
(same-origin → clean `window.pywebview.api` bridge, offline-capable, `getUserMedia`
works); a small **self-updater** fetches fresh engine files from the live site when
online (mirroring how satellites precache by path). This keeps the engine
single-source **without** the cross-origin problems of pointing the webview at the
live PWA. Native audio for archival WAV is **Python-side** (not the JS
`native-audio.js` contract), since we're not a browser recorder — but the **consent
modal and record UX around it are the reused engine ones**.

---

## 6. Feature architecture (mapping notes → build units)

- **Projects:** one Corpus-Manager project ↔ one FLEx project. List via flexlibs;
  browse for `.fwdata`/project folders FLEx doesn't list. Multiple projects supported.
- **Pre-transcription texts (recorded, not yet transcribed — a first-class state):**
  collecting recordings **far ahead** of transcription capacity (or sending them to a
  native speaker to pre-transcribe before FLEx import) is normal fieldwork, and the app
  supports it directly. A corpus record can exist as **just recording(s) + metadata (+
  an optional *provisional* genre)** with **no FLEx text yet**, sitting in early workflow
  stages (e.g. `recorded`, `permission obtained & documented`) *before* `transcribed` /
  `imported into FLEx`. These are **browsable/filterable as their own category** (the
  pre-transcription backlog) and are **not treated as mapping orphans** until they
  advance to a stage that expects a FLEx text.
- **1:1 FLEx↔corpus mapping (strongly encouraged, but *stage-aware*):** the app
  **reminds/pushes toward a one-to-one correspondence** — broadly, every FLEx text
  should have a corpus record and every corpus record should *eventually* map to a FLEx
  text. A persistent **reconciliation view** flags orphans, **but the pressure is gated
  by workflow stage**: a **recorded-but-not-yet-transcribed** record (still in pre-FLEx
  stages) is a **normal, expected backlog item — NOT nagged as an orphan**. Mapping
  pressure only kicks in once a record reaches a stage where a FLEx text *should* exist
  (e.g. `transcribed` / `imported into FLEx`). **FLEx texts with no corpus record are
  always flagged.** Resolve by mapping to the counterpart, or creating the missing side
  (a corpus record for a FLEx text, or a **blank FLEx text** for a record that's ready,
  §3). It reminds and pressures; it never strictly enforces or blocks the user's work.
- **Recursive genre/text-type tags (Pillar 1):** read `GenreListOA`; **inheritance is
  implied, not materialized** — a text tagged `legend` surfaces under `narrative`
  filters because we resolve the tree at query time, so moving a genre in FLEx just
  works. Ranked include/exclude filter rules; ship a discourse/genre template but keep
  it read-from-FLEx. Clear UX for delete/rename (references are GUIDs; show orphans).
  **For FLEx-mapped texts, genre lives only in FLEx** (we cache/mirror/read it, never
  store our own authoritative copy). A **pre-FLEx record** (recorded, not yet
  transcribed) has no FLEx text to read from, so it may carry an **optional *provisional*
  genre** stored in our app — a placeholder that is **offered/applied to FLEx when the
  text is later created or imported**, after which genre reverts to read-from-FLEx like
  everything else. (So genre stays FLEx-authoritative once mapped; the provisional value
  is only a pre-transcription convenience.)
- **Notes + observation-linking (Pillar 3 — the differentiator):** note documents with
  their own **separate recursive tag tree**; links to FLEx objects (text/segment/word)
  by **GUID** rendered as inline **tiles** (cut/copy/paste/drag/delete; copy = new
  independent link). Templates (grammar sketch, phonology, ethnography,
  comparative/historical, discourse). Nothing written to FLEx; each tile offers
  "open in FLEx" (`silfw://`) and "open this line in our preview."
- **Permissions & consent-gated export (granular human-subject / academic-use
  permissions):** the app tracks **use-permission** on individual **texts** and
  individual **sources/participants**, and gates archive (and other) exports — filter,
  sort, and bulk-export only what's permitted.
  - **Scopes are user-configured** named audience tiers, defaulting to **researcher-only
    → internal-organization → partners-only → public** (ranked least → most open), fully
    customizable (add / rename / reorder / add types).
  - **Whose permission applies (resolution, highest priority first; each optional, fall
    through if unset):**
    1. **Text-level** permission (explicit per-text override).
    2. **Source** (the *recording's* speaker/storyteller) **and Participant /
       Transcriber** (who produced the *interlinear text*) — **read from FLEx** (the
       People list, §3; exact fields = Phase-0).
    3. **Project default** — applies **only where nothing above is specified**.
  - **Asset-aware denial** (two exportable assets per text: the *recording(s)* and the
    *interlinear text*):
    - **Source denies** the target scope → **nothing exports** for that text (neither
      recording nor interlinear text) — the content is the source's.
    - **Participant/Transcriber denies** (but Source allows) → the **recording exports,
      but the interlinear text does not**.
    - A **Text-level** setting overrides both.
  - **Consent / proof linkage:** the permission level is a **field the researcher sets
    manually**, but it **links to the evidence** — the FlexText-Editor **consent
    prompt/response recordings + JSON receipts** (already tracked in Pillar 4), plus any
    other docs (**SIL-PNG or University Human-Research-Ethics forms**, etc.) — all **one
    click away** from the text and the permission UI.
  - **Every permission-involved export emits an exclusion report** — which texts (and
    which assets) were left out, and **why** (which level / who denied which scope).
  - **Bulk export, two mechanisms:** (a) drive **FLEx's own export formats** via the
    FLEx API (flexlibs2) over the permitted subset; or (b) **clone-and-prune** — produce
    an **identical copy of the FLEx project with excluded texts removed** (a sanitized,
    shareable project). Clone-and-prune writes to a **COPY, never the original** (guarded:
    backup, verify cross-refs, report).
- **Listening / playlist export:** filter/sort the corpus, pick **which audio file per
  text** (for multi-file texts; remembers the choice — Pillar 4), then export a
  **playlist** for easy phone/media-player listening (“on repeat”), fast to
  create/replace. Two modes: **(a) portable folder** — copy the chosen audio into a
  folder alongside an **`.m3u8`** (UTF-8, relative paths) to drop onto a phone; or **(b)
  in-place playlist-only** — an `.m3u8` pointing at the existing files in the corpus
  folder structure and/or linked files, for same-device playback.
- **Record a new text (in-app):** reuse the **suite-wide recording + consent/permissions
  modal** (same prompt/response + receipts flow as the rest of the FlexText suite),
  **configurable by the user/researcher**. Capture **archival-quality 24-bit WAV by
  default** (Python-side, true integer bit depth), user-changeable **only behind dire
  warnings**. On completion the recording lands as a **corpus record in the
  pre-transcription backlog** (recording + metadata + optional provisional genre); the
  user can immediately, or later, **create a blank interlinear text in FLEx** (guarded
  write — see §3) and **map it** — or leave it un-imported until it's ready to transcribe.
  (Transcription/glossing then happen in FLEx or a later in-app editor.)
- **Per-text:**
  - "Open in FLEx" (title/button → `silfw://` via `BuildGotoURL`).
  - **Interlinear preview (source fallback chain):** preview **primarily from FLEx**
    (live, via flexlibs). If the text isn't in FLEx yet, fall back in order to (1) the
    record's **authoritative `.flextext`** (each record designates one
    authoritative/original `.flextext`; else the first included one), then (2) its
    **authoritative `.eaf`** (one per record). Parsed via reused `flextext.js` (for
    `.flextext`) + a small new **`.eaf` reader** (`.eaf` is documented XML).
    - **`.eaf` preview = Simple-EAF-style segment-by-segment playback:** render each
      annotation aligned to its media time-code with a **per-segment play** control
      (play just that segment, or on repeat). Usually only **vernacular + free
      translation** tiers exist; if the `.eaf` *does* carry word/gloss tiers, render
      those too.
    - Any source: select segments/words → link to notes; select lines → **"Copy as
      TSV"** matching FLEx (feeds AcPub macros / LingTeX Tools). *Plan for* future
      LingTeX-Tools fold-in; don't build it now.
  - **Writing-system detection + relabel (fix misassignments — NOT baseline swap):**
    detect which WS have data. **We only offer WS-code relabel** — when a transcription
    was entered under the wrong WS code, re-assign it to the correct WS **without
    altering the text** (guarded write, dup-safe; precheck + `.fwdata` backup). We
    **deliberately do NOT rewrite or relocate baseline content** to change which WS is
    “baseline” — that's too much original-data tampering; the **original transcription
    is preserved even if its WS isn't the database's preferred one**, and the user can
    display/export whichever WS they want via FLEx's print/other tabs. A later phase may
    add a **bulk misassignment-relabel** report/wizard (find + fix wrong WS codes across
    the corpus), but never a bulk baseline rewrite.
  - **Workflow / progress stages (Pillar 2 — executive function):** user-defined
    **recursive** stage tree with **defaults but fully customizable**. The default
    template spans the *whole* lifecycle, **including the pre-FLEx stages** — e.g.
    `recorded` → `permission obtained & documented` → (optional `pre-transcribed by
    native speaker` / `glossed in LWC`) → `transcribed` → `imported into FLEx` →
    `glossed` → `morphological analysis` → `tagged` — each optional/mandatory with
    **prerequisites** gating later steps. The **`imported into FLEx` stage is the
    threshold** past which the 1:1-mapping reconciliation starts expecting a FLEx text
    (before it, records are pre-transcription backlog, not orphans). The payoff is a
    **corpus-wide dashboard**: sort and filter every text by stage/completion — including
    the *recorded-but-not-yet-transcribed* backlog — so you can see what's done and
    what's next at a glance. (Tag-step tooltip nudges sub-steps for specific
    constructions; pro-tips to be supplied later.)
  - **Attachments / file-store (Pillar 4):** per-text file tracking with clear
    provenance types — **original archive-grade recording(s)** (guarded, never
    silently converted), **cleaned-up listening copies** (FLAC/MP3), **consent
    prompt/response recordings + JSON receipts**, **permission-proof docs** (ethics
    forms), and any other files. Per-project and per-text **link vs. copy ("embed")**
    setting; hash + relative-path tracking; multi-file audio chooser with persisted last
    choice; QC status per file. Each record can mark **one authoritative/original
    `.flextext`** and **one authoritative/original `.eaf`** (used by the preview
    fallback chain, above).
  - **Metadata (lameta-informed field set):** per-text metadata linked to the FLEx
    text; the **optional field set is modeled on lameta's** (session / participants /
    recording conditions / consent / rights, IMDI/OLAC-derived) — collect what's
    useful, nothing mandatory. Deep-link to the FLEx Info tab for FLEx-owned fields;
    the **Media field** is a sanctioned write exception (FLEx UI currently flaky).
- **Import: FlexText Editor zips:** ingest a zip — recognize & catalog the master
  recording, consent prompt/response (audio + JSON receipts → metadata), and the
  `.flextext`; link-or-copy into the file-store. **Auto-import the `.flextext` into FLEx
  as a new interlinear text** (a sanctioned write — see §3) behind guardrails:
  **validate the file's writing systems against the target project's WSs first**
  (create/map/flag mismatches; never blind-write unknown WS codes), **back up
  `.fwdata`**, create the text, and open it in FLEx if possible. **Fidelity is fine for
  our scope:** we already know from this project that FLEx's `.flextext` import keeps
  **baseline, word glosses, and free translations** — exactly everything the FlexText
  Editor produces — so the import is lossless for our purposes (no morpheme-level
  analysis is involved). Drive-browse the researcher's uploads folder (reuse OAuth/worker).
- **Import: bulk folder import:** the common real-world case is a user with **loose
  folders of text recordings** (± `.flextext` files from FlexText Editor) who **arranges
  them into a folder structure our app recognizes**. We ship human + **AI-readable
  layout docs** so the user's own AI assistant can, *optionally*, generate a **metadata
  sidecar per text** (YAML or JSON — see §4) and include any `.flextext` files they have.
  On import the app **scans both the folder structure and the linked FLEx project** and,
  per detected text, **SUGGESTS a mapping to an existing FLEx text** (title/audio/metadata
  heuristics) — **the user always decides** — with a one-click option to **create a new
  blank FLEx text** (guarded write, §3) for anything unmapped, **or** leave it as a
  pre-transcription record. Includes fixes for mis-mappings (re-link, or merge a
  created-blank into an existing text discovered later).

---

## 7. Audio — capture, QC, archival guarding

- **Archival standard (confirmed):** uncompressed **WAV/BWF, ≥48 kHz / ≥24-bit**
  (IASA TC-04; PARADISEC/AILLA/ELAR align; 44.1/16 is the floor). **FLAC is lossless
  but NOT the specified archival master** — treat it as interchange/WhatsApp copy
  only. → **Guard the original master in its original format; never silently
  convert.** Verify compliance and, if non-compliant, advise re-record/omit per the
  target archive's rules (don't auto-"fix"). **Compliance also involves embedded BWF
  metadata** — the `bext` chunk (originator, origination date/time, description, coding
  history, …) and friends (iXML/aXML) — which some archives require; the app will
  eventually need to **read, preserve, and help populate** it. *(How — exact fields,
  tooling, and when to write — is deferred; flagged here only so the design leaves room
  for it.)*
- **Capture:** Python-side (`sounddevice`), **default archival 24-bit WAV** (true
  integer bit depth; user/researcher-changeable **only behind dire warnings**). Track
  provenance (device, encoding, bit depth, archival vs. WhatsApp-imported/non-compliant).
  The **consent/permissions modal + record UX are the reused suite engine** (§5).
- **QC (a clean differentiator, largely absent from field tools):** `ffprobe` for
  format compliance; `ffmpeg -af volumedetect`/`astats`/`ebur128` for **clipping,
  low level, DC offset, true-peak/loudness**. Flag suspected clipping / high noise /
  cut-off. (Bundle `ffmpeg`/`ffprobe` — the repo already carries an LGPL ffmpeg build
  with its licence + source offer.)
- **Player + “Open in…”:** failure-resistant across local/removable/cloud storage;
  multi-file chooser with **persisted last choice** (feeds the playlist export, §6).
  **Every audio file has an “Open in…” launcher** with **Ocenaudio** and **Audacity**
  built in (**auto-detect** the install path; if not found, let the user **browse** for
  the executable and **remember** it), plus a user-defined **“Other”** (name + locate a
  custom editor, remembered). Every external launch carries a **strict sound-file
  tampering / archiving warning**. (Launch = Python `subprocess`; editor paths persisted
  in settings.)
- **Future:** AI speech-enhanced/normalized **FLAC access copy** (never overwriting
  the master); **BWF `bext`/iXML metadata read/preserve/populate** for archive
  compliance (approach TBD); archive-export wizard with per-archive rules.

---

## 8. Interop / export roadmap

Core exchange format = **`.flextext`** (round-trip via `flextext.js`). Then, in
priority order: **TSV clipboard** (FLEx-style) → **`.eaf`** import/export (word-level
fidelity to verify on the ELAN path; note `.eaf` **reading** already powers the
interlinear-preview fallback, §6) → **OLAC/DC + IMDI/METS** emit for hand-off to
**RAMP/lameta** → **LaTeX** (ExPex / gb4e / langsci-gb4e) and **XLingPaper** export
(or hand to LingTeX Tools). Leave clean seams; build lazily. **Archival/other exports
are permission-gated (§6)** — either via FLEx's own export formats over the permitted
subset or a **clone-and-prune** project copy — and always emit an **exclusion report**.

---

## 9. Proposed phased roadmap

- **Phase 0 — De-risk spike (on the Windows machine, using the local FLExTools
  MCP):** prove pywebview + `flexlibs2` + `pythonnet` + a real FLEx project: open
  read-only while FLEx is open (share setting), read texts/segments/genres/**People +
  a text's Source/Participant fields** (pin down the permission-relevant fields),
  generate a `silfw://` link, do one **guarded write** (backup → WS relabel → verify),
  prove a **`.flextext` → new interlinear text** import with WS validation, prove
  **creating a blank interlinear text** mapped to a corpus entry, and prove a
  **clone-and-prune** (copy the project, delete a text, verify integrity). Spike Python
  archival **24-bit WAV** capture + `ffprobe` QC. **This validates the whole
  architecture cheaply before committing.**
- **Phase 1 — The four pillars (core):** repo scaffold in `corpus-manager/`;
  project↔FLEx linking + **stage-aware 1:1 reconciliation view** (flags orphans;
  exempts the pre-transcription backlog); **pre-transcription records** (recording +
  metadata + provisional genre, no FLEx text); read-only catalog/browse (**Pillar 1** —
  recursive genre-tag filter w/ inheritance + custom tags); **workflow stages +
  corpus-wide dashboard** (**Pillar 2**, defaults spanning pre-FLEx → FLEx lifecycle);
  **notes + tag tree + observation-linking** (**Pillar 3**); **attachment tracking +
  metadata field set + audio player** (**Pillar 4**, manual attach); files-as-truth +
  SQLite index; **interlinear preview with source fallback FLEx → authoritative
  `.flextext` → authoritative `.eaf`** (reuse `flextext.js` + a small `.eaf` reader;
  EAF segment-*playback* comes in Phase 2). Scaffold the **project folder layout +
  `.gitignore` + sync setup docs + in-app “commit & push” button + git-troubleshooting
  doc** (§4).
- **Phase 2 — Automation + audio (capture, QC, imports, listening):** in-app
  **record-new-text** (reused suite consent modal + 24-bit capture; lands in the
  pre-transcription backlog, optional blank-FLEx-text creation + mapping); FlexText-zip
  importer (incl. **auto-import `.flextext` into FLEx** behind WS validation + backup);
  **bulk folder-import** with suggested FLEx-text mappings (user-confirmed) +
  create-blank-on-no-match (or leave as pre-transcription record); file-store link/copy;
  `ffprobe`/`ffmpeg` QC (clipping/level/format-compliance) + master-guarding;
  listening-copy generation; **EAF segment-by-segment playback** in the preview; per-audio
  **“Open in…”** launcher (Ocenaudio/Audacity auto-detect + browse-remember + custom
  ‘Other’); **listening/playlist export** (portable folder + `.m3u8`, or in-place
  `.m3u8`); Drive browse (reuse OAuth/worker).
- **Phase 3 — Writing-system tools:** single-text **WS relabel** (guarded) → **bulk
  misassignment-relabel** report/wizard (find + fix wrong WS codes across the corpus).
  *(No baseline-swap feature — see §6: original transcriptions are preserved.)*
- **Phase 4 — Permissions, consent-gated export & interop:** granular use-permissions
  (user-configured scopes; per-text resolution Text → Source/Participant → project
  default, reading FLEx People; asset-aware denial; consent/proof linkage);
  **permission-gated bulk export** — FLEx-format export over the permitted subset **or**
  **clone-and-prune** project copy — with a mandatory **exclusion report**; then interop
  seams: TSV, `.eaf`, OLAC/IMDI/METS, LaTeX/XLingPaper.
- **Phase 5 — Future:** machine translation (BYO LLM key, hard AI-transparency
  warnings, enforce cross-analysis-language), AI audio enhancement, archive-export
  wizard (incl. BWF `bext` metadata), optional LingTeX-Tools fold-in.

---

## 10. Decisions to revisit (proceeded on these)

1. **Tech stack** = pywebview (vs Tauri sidecar / Electron subprocess).
2. **Data model** = files-as-truth (**JSON** store, many small files + `project.json`;
   **YAML accepted for AI/human import sidecars**, normalized on import) + SQLite index
   (vs SQLite-primary / YAML-as-store).
3. **Sync split** = **GitHub (private repo) for the JSON data** (+ in-app commit/push
   button + git-troubleshooting doc), **cloud storage (Drive/Dropbox/rclone/B2) for the
   media file-store**; we host no sync infra, only structure + instructions + a
   scaffolded `.gitignore`.
4. **Engine reuse** = vendor + self-update (vs load-live-remote / copy-only).
5. **v1 scope** = **all four pillars** (catalog/filter, workflow stages + dashboard,
   notes/tags/linking, attachment tracking + metadata + player) **plus pre-transcription
   records + stage-aware reconciliation** as the Phase-1 must-have; automation
   (record-new-text, zip import, bulk folder import, QC, Drive, playlist), WS-relabel,
   permissions/gated-export, and interop are later phases.
6. **No baseline-WS swap** — we preserve original transcriptions and never rewrite
   baseline content; only misassigned-WS relabel is offered.
7. **Pre-transcription texts are first-class** — a corpus record can exist with no FLEx
   text (recorded + metadata + optional provisional genre); the 1:1-mapping pressure is
   stage-gated and exempts this backlog.
8. **BWF `bext` metadata** is part of archival compliance — read/preserve/populate is an
   **open item, deferred** (mechanics not yet specced); the design should leave room.
9. **Permission model** = user-configured scopes (default researcher-only → internal →
   partners → public); per-text resolution **Text → Source/Participant → project
   default**; **asset-aware denial** (Source-deny excludes recording *and* text;
   Transcriber-deny excludes only the interlinear text); permission-gated export via
   FLEx-format export **or** clone-and-prune (on a copy), always with an **exclusion
   report**. *(Exact FLEx Source/Participant/Transcriber field mapping = Phase-0.)*
10. **Listening/playlist export** = `.m3u8` (UTF-8), either portable-folder or in-place.
11. **Interlinear preview source fallback** = FLEx → authoritative `.flextext` (or first
    included) → authoritative `.eaf`; each record designates one authoritative
    `.flextext` + one authoritative `.eaf`; the `.eaf` preview does Simple-EAF-style
    segment-by-segment playback (vernacular + free translation, or whatever tiers exist).
12. **Per-audio “Open in…”** = Ocenaudio + Audacity (auto-detect / browse-and-remember)
    + a custom “Other” (name + locate + remember), always with a tampering warning.

## 11. Key risks

- **flexlibs write/undo behavior** — mitigated by emulating the FlexTools modify-guard
  + mandatory `.fwdata` backup + read-only default; exact undo semantics = Phase-0 item.
- **Creating texts in FLEx** (blank-from-recording or imported `.flextext`) — main risk is
  **WS mismatch** against the target project; mitigated by pre-write WS validation +
  `.fwdata` backup. (Content fidelity is NOT a concern: FLEx keeps baseline + word
  glosses + free translations on `.flextext` import — already proven in this project —
  which is the full FlexText Editor scope.)
- **WS relabel** — could create duplicate WS entries or mislabel; mitigated by dup-safe
  checks, precheck, `.fwdata` backup, and the fact that it never alters the text itself.
- **Permission mis-gating (data leak)** — an export must NEVER include content whose
  Source/Participant/Text permission denies the target scope; mitigated by the explicit
  resolution order, the asset-aware rules, and a mandatory **exclusion report to review
  before sharing**. The exact FLEx Source/Participant/Transcriber field mapping is a
  **Phase-0 confirmation** — getting it wrong risks both over- and under-exclusion.
- **Clone-and-prune correctness** — deleting texts from a project copy must not corrupt
  cross-references; operate on a **verified copy** + backup, then report. Never the original.
- **Bulk-import mis-mapping** — the app only **suggests** folder↔FLEx mappings; the user
  confirms, and re-link/merge fixes exist for wrong guesses (nothing auto-writes to FLEx
  without confirmation).
- **Orphaned / unmapped texts** — the app pressures FLEx↔corpus 1:1 **stage-awarely**:
  persistent flags for FLEx texts with no record and for records that have *passed* the
  `imported into FLEx` threshold without one — **but recorded-but-not-yet-transcribed
  records are expected backlog, not orphans** (§6). It reminds/pressures, never hard-blocks.
  (A pre-FLEx record has only an optional *provisional* genre until its FLEx text exists.)
- **User-run sync misuse / jams** — e.g. committing media to git, syncing the live DB via
  Drive, or a stuck push; mitigated by the scaffolded `.gitignore` + folder layout + the
  in-app commit/push button + a git-troubleshooting doc (primary advice: copy the exact
  error to an AI assistant) (§4).
- **FLEx-must-be-installed + share-setting** — hard dependencies; need graceful detection + guidance.
- **Scope creep into a lameta/archiving tool** — mitigated by holding to the four
  FLEx-corpus pillars; metadata/archiving stay optional + interop-only.
- **Worker origin allow-listing** for a desktop origin — coordinate with the `worker/`
  Cloudflare Worker (now folded into this repo).
- **WebView2 tail on old Win10** — first-run check + bootstrap.

## 12. Separate follow-up (needs repo access — NOT done here)

Requested: add a note in **`rulingAnts/videoannotationtool`** that its recording
format should be revisited (likely 32-bit WAV; expose bit-depth options / archival
guidance). That repo is **out of scope for this session**, so it hasn't been touched.
To action it, add that repo to scope (or open a session there) and file the
note/issue. (It's also a good candidate to share this app's future `ffprobe` QC +
archival-format logic.)

## Development / testing aids

- **FLExTools MCP pipeline** — exists only on the maintainer's **local Windows
  machine**, not reachable from cloud sessions. Use it during Phase-0/local build to
  validate FLEx-data-model assumptions (share access, read/write, genre GUIDs, **People
  list + a text's Source/Participant/Transcriber fields**, `silfw://`, WS handles on
  runs (for relabel), `.flextext` import, blank-text creation, clone-and-prune) against
  a real project.

## Verification (when we build)

- **Phase 0 spike is the primary validation gate** — every risky assumption (share
  access, read/write, genre GUIDs, People/Source/Participant fields, `silfw://`, WS
  relabel (run WS handles), `.flextext`→new-text import, blank-text creation,
  clone-and-prune integrity, archival 24-bit capture, QC) is proven against a real FLEx
  project via the local FLExTools MCP before Phase 1.
- Round-trip tests for `flextext.js` reuse (parse → serialize identity on real files).
- Guarded-write tests: backup created, precondition checks fire, dup-safe relabel,
  WS-validated import, blank-text creation mapped to a corpus entry, no data loss on abort.
- **Permission-resolution tests**: Text/Source/Participant precedence + project-default
  fallthrough; asset-aware denial (Source-deny excludes all; Transcriber-deny keeps the
  recording, drops the interlinear text); exclusion report matches what actually exported.
- SQLite index rebuild-from-JSON test (source-of-truth integrity); round-trip a project
  through git (data/) + a cloud folder (files/) and confirm it reopens intact.
- **Preview + audio tests**: interlinear preview resolves the FLEx → `.flextext` → `.eaf`
  fallback in the right order; EAF segment-by-segment playback aligns to time-codes;
  “Open in…” auto-detects/remembers editor paths (Ocenaudio/Audacity/Other).
- Audio QC against known-clipped / non-compliant fixtures; **playlist export** produces a
  valid `.m3u8` (portable-folder relative paths + in-place paths resolve); bulk-import
  mapping suggestions against a folder + FLEx fixture; reconciliation flags orphans on
  both sides but exempts the pre-transcription backlog.
