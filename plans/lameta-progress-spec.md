# lameta progress fields — the shared spec (version 1)

**Spec version: 1** (2026-09-27). Implemented by the FlexText suite (`docs/js/lameta.js`), by the
lameta pull request for lameta issue #74 (Seth's fork `rulingAnts/lameta`, target branch `V3`), and
read by corpus-keeper and the corpus checklist. `test/lameta-progress.test.mjs` pins this version
number; bump it here and there together.

Seth, lameta issue #74 (2026-09-24): *"The checklist/phases for each text are fairly limited to
recording and archiving. It would be useful to be able to add other steps like transcription,
glossing, free translation, morpheme analysis, text charting, etc (and let the user add and remove
and customize those steps) so that they can use lameta also to track their progress on ANALYZING a
text corpus not just recording and archiving."*

## What lameta's code settles (3.0.21-beta, read from the shipped bundle and upstream source)

- lameta tracks one four-value `Status` per session and nothing else. There is no plugin, add-on,
  scripting or CLI route; its unmerged `plugins` branch cannot touch session metadata. New behavior
  is a pull request.
- `<CustomFields type="xml">` round-trips losslessly: every child is read as a custom field, kept
  verbatim, shown as a row in stock lameta, written back on save. Empty values are not written.
  A label used in any session appears as an empty row in every session.
- Unknown NESTED elements, or any element with a `type` attribute lameta does not know, are dropped
  on the next save. Unknown top-level simple text elements survive. So per-session state must be
  custom fields, and project-level definitions must not live inside the `.sprj` as nested XML.
- ⚠ Any XML tag whose lower-cased name contains `date` is force-parsed as a date and its text
  replaced. Step ids must therefore never contain `date`.
- Files in the project root are loaded but never displayed or saved (lameta's own
  `vocabulary-translations.json` lives there). Files directly under `Sessions/` are ignored.
- lameta has no file watcher and no lock file; it re-reads a project only on reopen and saves a
  session it holds in memory on window blur, tab switch and quit.

## 1. Step definitions: `<project>/progress-steps.json`

```json
{
  "version": 1,
  "steps": [
    { "id": "consent",    "label": "Consent" },
    { "id": "metadata",   "label": "Metadata" },
    { "id": "record",     "label": "Audio recording" },
    { "id": "segment",    "label": "Audio segmentation" },
    { "id": "transcribe", "label": "Transcription" },
    { "id": "gloss-lwc",  "label": "LWC word gloss" },
    { "id": "ft-lwc",     "label": "LWC free translation" },
    { "id": "flex",       "label": "Import into FLEx" },
    { "id": "gloss-en",   "label": "English word gloss" },
    { "id": "ft-en",      "label": "English free translation" },
    { "id": "morph",      "label": "Morphological analysis" },
    { "id": "tagging",    "label": "Tagging" },
    { "id": "charting",   "label": "Text charting" },
    { "id": "para",       "label": "Paragraph analysis" }
  ],
  "status": { "inProgressAfter": "record", "finishedAfter": "archive-submitted" }
}
```

- `id`: `^[a-z][a-z0-9_-]{0,31}$`, unique within the file, **stable forever** — a rename changes
  `label` only, so no session file is ever rewritten for a rename. Must not contain `date`.
- The default list is the corpus checklist's fourteen visible steps, ids reused verbatim, so the
  checklist, lameta and the suite share one vocabulary. The researcher may add, remove, rename and
  reorder steps in lameta (the PR) or by editing this file with lameta closed.
- `status` is optional. Absent means no Status derivation. `finishedAfter` may name a step that is
  not in `steps` (as `archive-submitted` above, one of the checklist's hidden steps): it then only
  ever fires when an external writer sets that stage.
- Unknown keys are ignored by every reader, so the file can grow.
- A writer that finds no file may create it with the defaults. Nobody writes it while lameta has the
  project open.

## 2. Per-session state: one custom field per step

```xml
<CustomFields type="xml">
  <Stage_Record type="string">done</Stage_Record>
  <Stage_Segment type="string">done</Stage_Segment>
  <Stage_Transcribe type="string">in_progress</Stage_Transcribe>
  <Stage_Gloss_Lwc type="string">in_progress</Stage_Gloss_Lwc>
  <Suite_Doc_Id type="string">bwpX_YzJZRolHdh_</Suite_Doc_Id>
  <Flex_Text_Guid type="string">4f2c0c2e-…</Flex_Text_Guid>
  <Suite_Stamp type="string">2026-09-27T10:00:00Z;v690;status=In_Progress</Suite_Stamp>
</CustomFields>
```

- **Key** = `Stage_` + the step id with each `-`- or `_`-separated part capitalized and joined by
  `_`: `record` → `Stage_Record`, `gloss-lwc` → `Stage_Gloss_Lwc`, `archive-submitted` →
  `Stage_Archive_Submitted`. Keys are valid XML names, contain no `date`, and cannot collide with a
  lameta field (none begins with `Stage_`). lameta treats custom-field keys case-sensitively; the
  derivation fixes the spelling.
- **Value** = `done` | `in_progress`. Not started = **element absent** (lameta would drop an empty
  element anyway). Readers accept `in-progress` / `in progress` and any case; writers emit the
  canonical spelling. Any other non-empty text is an *unknown* state: preserved verbatim, shown by
  the patched lameta with a "?" and the raw value, never rewritten unless a person picks a state.
- The `<CustomFields>` block goes **last**, after `<Contributions>` and any `<AdditionalFields>`,
  matching lameta's own element order.
- Identity fields beside the stages, all optional: `Suite_Doc_Id` (the suite's docId, the join key
  for moves), `Flex_Text_Guid` (the `<interlinear-text guid>` of the `.flextext`, the join key
  corpus-keeper and the checklist use), `Suite_Stamp` (`<ISO time>;<engine version>;status=<the
  Status value the suite last wrote>`).

## 3. Status derivation — the two picks

```
withdrawn                          → Skipped
stage(inProgressAfter) != done     → Incoming
stage(finishedAfter)   == done     → Finished
otherwise                          → In_Progress
```

Defaults: `record` / `archive-submitted`. The checklist has no plain "archive" step; deposit is the
researcher's own last act, while `archive-approved` is the archive's and may lag by months.

Rules every writer follows:
- The suite never writes `Skipped` (it does not know withdrawal) and never lowers a Status.
- The suite rewrites `Status` only when the file's current value equals the `status=` recorded in
  `Suite_Stamp`. A Status edited by hand in lameta is never touched.
- The patched lameta applies the rule only when a stage changes through its own UI or model — never
  on project load, which would dirty and rewrite every session. A "Recompute Status for all
  sessions" action applies it explicitly.

## 4. What the suite derives, and what stays manual

| step id | key | derived from | rule |
|---|---|---|---|
| consent | `Stage_Consent` | manifest `consent.response` or `consent.receipt`, or a `consent-*` role file present | present → done |
| record | `Stage_Record` | a `source-audio` role file present | present → done |
| segment | `Stage_Segment` | `segmentsFromOffsets(doc)` (`docs/js/flextext.js`) | aligned phrases ≥ 95% → done; > 0 → in_progress |
| transcribe | `Stage_Transcribe` | phrases with a non-empty baseline / phrases | same 95% bar (the checklist's `FX_DONE_BAR`) |
| gloss-`<x>` | `Stage_Gloss_<X>` | non-punctuation words with `glossIn(w, lang)` / words, per analysis language | same bar |
| ft-`<x>` | `Stage_Ft_<X>` | phrases with `freeIn(seg, lang)` / phrases, per analysis language | same bar |
| metadata, flex, morph, tagging, charting, para, and every hidden step | — | manual (flex/morph are corpus-keeper's) | never written by the suite |

Language suffix rule, fixed here: `en`/`eng` → `En`; the project's analysis language when it is not
English → `Lwc`; any other language code → the code capitalized (`fr` → `Fr`, so `Stage_Gloss_Fr`).
The checklist mints `gloss-<code>`/`ft-<code>` steps the same way.

**Merging is monotonic.** A derived value never lowers a stored one: `done` stays `done` even when
a recount says `in_progress` (the text may have been edited down on purpose, or the person may have
ticked it by hand). Lowering is a person's decision, made in lameta or the checklist.

## 5. Write safety (both writers)

- A `.session` is written in full only when the suite **creates** the session folder.
- Any later change (a stage, a Status, the media-reference repair after a rename) goes into a queue
  of pending lameta updates that the person applies after confirming lameta is closed. At apply
  time the writer re-reads the file, preserves every element it does not own byte for byte, merges
  stages monotonically, and applies §3.
- Never emit self-closing tags (`<Contributions></Contributions>`, as lameta writes them); UTF-8, no
  BOM; the `<?xml version="1.0" encoding="utf-8"?>` header; two-space indent.
- Keys outside this spec (`Progress_*`, anything else) are someone else's and are left alone.

## 6. The checklist mapping

Checklist state 2 ↔ `done`, 1 ↔ `in_progress`, 0 ↔ absent. The checklist's two picks
(`lameta.inProgressFrom` / `lameta.finishedAt` in `plans/corpus-keeper.md`) are superseded by §1's
`status` object: the lameta project owns the picks, and the checklist reads them.

## 7. External prerequisite

`/Users/Seth/GIT/lameta-editor/lameta_core.py` rebuilds a `.session` from `SESSION_ORDER` and has no
`CustomFields` handling — a bulk edit would erase every stage field. Before any bulk edit touches a
session carrying them: add `CustomFields` after `AdditionalFields` in `SESSION_ORDER`, carry it
verbatim, and replace `VOCAB.role` with lameta's 25 roles.
