# Corpus Keeper — one simple system tying FLEx, lameta, the FLExText suite and the corpus checklist together

Plan written 2026-09-06 while Seth tests v585. Decisions taken with Seth in this session: **FLExTools
module first** (resident later), **lameta session folders are the canonical home of the recordings**,
**manual workflow facts live in lameta session fields**, **new repo `corpus-keeper`**, and the
consent-collection process in the suite is changed where lameta and FLEx need it.

---

## Context

Seth has five pieces that each do one job well and do not know about each other: FLEx (text +
analysis, on Windows), the FLExText suite (recording, transcription, audio segmentation, consent
capture, a researcher panel, all in the browser), lameta (archive metadata, sessions, people,
consent files), a planned corpus checklist (genre coverage and workflow progress, Appendix A), and a
disorganised iCloud folder tree holding the actual recordings and exports. The goal is the simplest
system that ties them together for a disorganised researcher: FLEx is the source of truth for
everything its model can hold; lameta is the archive-facing view and the home of the media; the
suite is where native speakers edit; the checklist shows progress without anyone ticking boxes; and
one small program, the **keeper**, keeps them in step.

"Simple for starters, but works well": phase 1 is a FLExTools module you run on demand plus two
folders (Outbox, Inbox). Nothing resident, nothing that needs FLEx and another process to share the
project. The live pieces (a tray app, the FLEx-backed audio segmenter, #49) come after the shared-
backend test on the VM, on the same library.

---

## What was established (verified this session)

**FLEx data model** (from LCM `MasterLCModel.xml`, master branch, and Ken Zook's *Technical Notes on
FLEx Text Interlinear*, 2026-05-04):
- `Text` owns `MediaFiles` (one `CmMediaContainer` with `OffsetType` and a collection of
  `CmMediaURI`, each a `MediaURI` string holding the **full path** to the file). `Text` also has
  `Genres` (refs into `LangProject.GenreList`), `Source`, `Abbreviation`, `IsTranslated`, `Contents`.
- `Segment` (one per phrase) has `BeginTimeOffset` and `EndTimeOffset` (milliseconds as strings),
  `MediaURI` (a reference to **one** of the text's `CmMediaURI` objects, so **each line can point at
  its own media file** — Seth's "individual media files for lines"), `Speaker` (a `CmPerson` from
  `LangProject.People`; import creates people that do not exist), `Notes`, `FreeTranslation`,
  `LiteralTranslation`. FLExText carries these as phrase attributes `begin-time-offset`,
  `end-time-offset`, `media-file="<guid>"`, `speaker="<name>"` and a text-level `<media-files>` block.
- **FLEx has no UI for media files**; it stores them for round trip. Segment and text GUIDs survive
  import; paragraph GUIDs do not. So the keeper can address timing by segment GUID, exactly as #49.
- `CmPerson`: `Alias`, `Gender`, `DateOfBirth`, `PlaceOfBirth`, `PlacesOfResidence`, `Education`,
  `Positions`, `IsResearcher`. No consent field; no custom fields on people. Custom fields exist for
  Texts (Tools ▸ Configure ▸ Custom Fields) but are not needed in this plan.
- Send/Receive cannot carry large media: recordings must never live in `LinkedFiles`.
- flexlibs raises `FP_FileLockedError` while FLEx has the project open (flextools/FACTS.md). Phase 1
  therefore runs with FLEx closed, like every existing FLExTools module.

**lameta on-disk format** (from the `onset/lameta` sample project, plain XML files):
- `Sessions/<id>/<id>.session`: `<Session>` with `title`, `participants` ("A; B"), `genre`,
  `access`, `location`, `setting`, `situation`, `date`, `status` (Incoming / In Progress / Finished /
  Skipped), `description`, `<CustomFields>`. Media, ELAN (`<media>.annotations.eaf`), documents and
  images sit in the same folder, each with a `<file>.meta` sidecar (`Device`, `Microphone`, `notes`,
  `<contributions>` with `name`/`role`/`date`).
- `People/<Name>/<Name>.person`: `name`, `birthYear`, `gender`, `education`, `primaryOccupation`,
  `description`, `languages`, `contributions`, `CustomFields`; consent is a file in the folder named
  `<Name>_Consent.<ext>`, and lameta's People list shows who has one.
- External tools can create these files; lameta reads the folders when it opens and writes sidecars
  for files that lack them. The keeper writes only when lameta is closed and never rewrites a
  `.session` a person has edited (rule below).

**The suite today**: the consent collector stores, per text, `consentClip` (recorded assent),
`consentPromptClip`, and `consentReceipt` (JSON built by `buildConsentReceipt` in `docs/js/app.js`,
which already carries `recordedAssentFile` and a signature name). Bundles carry them in the upload
zip. `serializeFlextext` writes timing attributes; nothing writes `speaker` or `media-file` yet. The
ELAN writer (`docs/js/seg-exports.js`, v585) emits one tier per analysis language. The researcher
panel's worker exposes `/v1/projects/<pf>/texts/<docId>/upload/*` (assign by upload) and
`/v1/researcher/drive*` (the project's Drive folder).

**The corpus checklist** (Appendix A) is a browser app whose steps are ticks. Almost every tick it
wants (recorded, segmented, transcribed, glossed, translated, in FLEx, consent, ELAN, archived) is a
fact the keeper can derive. Its planned JSON import becomes the way it learns them.

**lameta's own workflow tracking, checked against its field definitions**
(`archive-configurations/lameta/fields.json5` in the lameta repo, 2026-09-06):
- One session field, `status`, with exactly four values: `Incoming`, `In_Progress`, `Finished`,
  `Skipped`. It sits on its own small "status" form beside the main metadata form, is not
  required, and is set by hand. That is the whole of lameta's progress model.
- No stages. SayMore's stage bar (consent, careful speech, oral translation, transcription,
  written translation, detected from file names and annotation content) was not carried into
  lameta; lameta's Session class has no stage, progress or checklist code, and its session fields
  are all descriptive metadata (id, date, participants, title, description, genre, subgenre,
  access, keywords, topics, location, languages, working languages, researcher involvement,
  region/country/continent, planning type, social context, custom fields).
- Consent is tracked only as "this person has a consent file" in the People list.
- Nothing per genre, no targets, no coverage, no rules, no "what to do next", no per-step matrix,
  no time-vs-count view, no report.

So the checklist keeps every feature that makes it worth having (Appendix A §3–§8): the genre tree
with per-organisation quotas, the step matrix, the rule engine, next actions, the health strip, the
report. **Where lameta does have a concept, lameta mirrors the checklist** (Seth, 2026-09-06:
"wherever lameta DOES include something like stages/process steps, we want the lameta session data
to be able to automatically mirror those from corpus checklist"). The checklist is where workflow is
managed; lameta shows the result in the archive record; the keeper carries it across.

**Mirroring the checklist into lameta's built-in status** (Seth, 2026-09-06, final: "keep
steps/checklist system within lameta rather than using a custom field in lameta … a way to map our
steps to lameta steps in the built in system that already exists"). lameta's built-in system is one
`status` per session with four fixed values, so the map is from the checklist's many steps to those
four states. It is two picks with sensible defaults, on one small card in the checklist's Steps tab,
and nothing else; custom fields are not used:

```
lameta status for each text
  Incoming     until  [ Audio recording        ▾ ]  is done          ← pick 1 (default: record)
  In Progress  from that step until
  Finished     when   [ Archived / deposited   ▾ ]  is done          ← pick 2 (default: archive)
  Skipped      when the text is withdrawn                              (fixed)
  Today: 12 Incoming · 30 In Progress · 5 Finished · 1 Skipped          (live preview)
```
The two dropdowns list the checklist's steps in their order; pick 2 must come after pick 1, and the
card says in words what will happen ("A text becomes Finished in lameta the moment you tick
Archived"). Nothing else about lameta status is configurable, because lameta has nothing else.

**Why it is two picks and not more.** Checked against lameta's source (2026-09-06): `status` and
its four values are a fixed definition in the field catalogue bundled inside the application
(`archive-configurations/lameta/fields.json5`); the institution configurations (ELAR, PARADISEC, …)
are folders in the same bundle, not files a user can drop into a project; and no field definition
anywhere carries colour, icon or ordering properties. So lameta's built-in system cannot gain
stages, cannot be recoloured or reordered, and needs nothing from the checklist's settings beyond
the two picks above. Custom Fields exist in lameta (a free table of labels and values) but are not
used for this, per Seth. Consent needs nothing written either, since lameta already shows the
consent file.

Fixed, not configurable: genre tags reach lameta's `genre`/`subgenre` through the one alias map
(FLEx `Text.Genres` is where the tags come from); consent needs nothing written, since lameta already
shows the consent file.

The two picks are two values in the checklist's export (`lameta.inProgressFrom`,
`lameta.finishedAt`); there is no mapping file and nothing per step. Direction and conflicts: the keeper
writes the mirrored fields on every sync; if a mirrored field was edited by hand in lameta since the
last sync (the keeper stamps what it wrote), the keeper reports the difference and, by default,
restores the checklist's value — the setting "lameta edits win for status" flips that for people
who prefer to tick in lameta. Every other session field (`access`, `description`, `setting`,
`situation`, keywords, all custom fields) is lameta's own and is never touched.

How the checklist's state reaches the keeper in phase 1: the checklist's Save writes
`corpus-checklist.json` (its existing export format, plus the mapping) into the keeper's project
folder, and the keeper reads it at Sync; the keeper's `corpus-status.json` goes the other way. Phase
2 replaces the two files with the localhost bridge. Derived steps are never ticked by hand in
either place; they come from `corpus-status.json` and may be mirrored into lameta like any other
step.

Verdict: lameta is the archive record and the right editor for archive metadata; the checklist is
the workflow tool lameta is not; the keeper makes lameta's built-in status a faithful, automatic
reflection of the checklist, under the two picks the user controls.

---

## Source of truth, decided per fact

| Fact | Lives in | Why |
|---|---|---|
| Text, words, glosses, translations, notes, segments | FLEx | its model |
| Segment timing, which media file a line plays | FLEx (`Segment.Begin/EndTimeOffset`, `MediaURI`) | its model; written by the segmenter, read by everything |
| Media file identity and path | FLEx `CmMediaURI` → **file in the lameta session folder** | FLEx points, lameta holds; never in the project |
| Speaker of a line / of a text | FLEx `Segment.Speaker` → `CmPerson` | its model; lameta participants derive from it |
| People identity, demographics | FLEx People list; lameta `.person` generated from it | one list of people |
| Consent recording and receipt | lameta `People/<Name>/<Name>_Consent.*` (+ receipt JSON beside it) | lameta's convention; FLEx has no field |
| Genre | FLEx `Text.Genres` → lameta `genre` via an alias map (lameta's genre list, also OLAC) | one tree, per Appendix A §5 |
| Archive metadata: access, location, setting, situation, device, mic, contributors | lameta session + `.meta` | no FLEx home |
| Workflow facts not derivable (release forms, published, deposited, approved) | the corpus checklist (its export file in the keeper's project folder), **mirrored into lameta's built-in** session `status` under the two picks | managed in the checklist, visible in the archive record |
| Everything derivable (recorded, segmented, % glossed, % translated, ELAN present, consent present) | **derived at sync, never stored** | Appendix A §4's rule |

---

## Architecture

```
FLEx project (.fwdata)  ──LCM read (flexlibs2)──►  keeper library (Python)  ──►  lameta project folder
        ▲                                               │        │                (Sessions/, People/)
        │ LCM write: timing, media refs, speakers        │        └──►  corpus-status.json  ──►  corpus checklist (import)
        │                                               │
   Inbox/  ◄── researcher drops device bundles ◄─── researcher panel (Drive) ◄── devices (editor / segmenter / consent collector)
   Outbox/ ──► researcher assigns bundles ─────────►
```

**Phase 1 — on demand (the deliverable of this plan).** `corpus-keeper` repo: a Python library
(flexlibs2 + pythonnet on the FLEx machine) and three FLExTools modules:
1. **Corpus Keeper ▸ Sync** — FLEx → lameta + status. Dry run first, then apply.
2. **Corpus Keeper ▸ Send to device** — writes a timed FLExText + media + consent bundle per chosen
   text into `Outbox/`, ready for the panel's Assign-by-upload (drag the zip in).
3. **Corpus Keeper ▸ Receive** — imports everything in `Inbox/` (bundles downloaded from the panel):
   timing and media references into FLEx by segment GUID, media and consent files into lameta, and
   stages any text changes as a FLExText for FLEx's own *File ▸ Import ▸ FLExText (merge)*, which is
   the one step FLEx does better than we can (it merges analyses by GUID).
All three run with FLEx closed, from FLExTools, which Seth already uses on the VM.

**Phase 2 — resident.** The same library behind a tray app on the FLEx machine (not a Windows
service: services cannot show UI and the shared backend is per-user). It watches `Inbox/` and the
FLEx save, syncs on a quiet period, and serves `http://localhost:<port>` so the researcher panel can
list FLEx texts and assign straight from FLEx ("Assign from FLEx"; browsers exempt localhost from
mixed-content blocking). Gated on the shared-backend test in #49; until then it is phase 1 on a timer
with FLEx closed.

**Phase 3 — live editing.** The FLEx-backed audio segmenter (#49) uses the keeper library's
FLExText-in / offsets-out functions as its sidecar. Nothing in this plan is redone for it.

---

## The lameta layout the keeper writes

Per FLEx text (keyed by the Text GUID, stored in the session's `CustomFields/flexTextGuid`):
```
Sessions/<Abbreviation-or-slug>/
  <slug>.session                   generated once; later runs update ONLY keeper-owned fields (below)
  <slug>.wav                       the original recording (moved/copied here once; FLEx MediaURI points here)
  <slug>.wav.meta                  contributions: speaker(s) from Segment.Speaker, recorder from the receipt;
                                   Device/Microphone from the recorder's provenance (bext) when known
  <slug>.wav.annotations.eaf       ALWAYS present, ALWAYS generated: our ELAN writer (FLEx profile, every
                                   analysis language, plus morpheme form and lex-gloss tiers where FLEx
                                   has them — suite change 7), regenerated from FLEx on every sync so it reflects
                                   the source of truth (Seth, 2026-09-06). A NON-FLEx-DEPENDENT SNAPSHOT
                                   (Seth, 2026-09-06): plain text values only — baseline, words, morpheme
                                   forms, glosses, translations, notes, speaker names, times — with no
                                   GUIDs, object references or anything that needs FLEx to read. Whoever
                                   opens the session in ELAN in twenty years sees the whole analysis with
                                   just the WAV beside it. Never hand-edited here: if the file is newer
                                   than the keeper's stamp (someone edited it in ELAN), the keeper does not
                                   overwrite it; it reports the conflict and offers to import the ELAN
                                   timing into FLEx through the suite's EAF reader first.
  <slug>.flextext                  timed FLExText export — refreshed each sync (also the rollback copy)
  <slug>.preview.html              the listening page — refreshed each sync (optional, off by default)
People/<Name>/
  <Name>.person                    generated from CmPerson once; keeper-owned fields updated
  <Name>_Consent.wav               from the consent collector's assent clip
  <Name>_Consent.json              the receipt (script, language, scope, access chosen, date, device)
```
Rules: (1) the keeper writes lameta files only when lameta is not running (it checks the lock/
process, like FLExTools checks FLEx); (2) a `.session` or `.person` is **created** by the keeper and
thereafter only these fields are rewritten: `title`, `participants`, `genre`, `date` (if empty),
`CustomFields/flexTextGuid`, `CustomFields/keeper*`; everything a person typed (`access`,
`description`, `setting`, `status`, other custom fields) is never touched; (3) derived files
(`.eaf`, `.flextext`, `.preview.html`) are always regenerated; (4) media is copied in once and
verified by size and hash, never re-copied, and FLEx's `CmMediaURI` is rewritten to the session path.
Session `status` is left to the researcher, but the keeper proposes `In Progress` on creation and
never changes it afterwards.

**Where the lameta project folder lives** (Seth, 2026-09-06: "can we store our lameta folders in a
cloud folder like Google Drive or iCloud?"). Yes. lameta is a plain-files application with no
server and no licence term about location; a project folder in iCloud Drive or Google Drive is an
ordinary folder to it. The keeper is the same. Three conditions make it safe, and the keeper checks
the first two before it writes:
1. **Files must really be on disk, not placeholders.** iCloud's "Optimise Mac Storage" and Google
   Drive's "Stream files" evict large files to the cloud and leave stubs; lameta and the keeper then
   see a missing WAV. Mark the project folder "Keep Downloaded" (iCloud) or "Available offline" /
   mirror mode (Drive) on every machine that opens it; the keeper refuses to run when it finds a
   stub (`.icloud` placeholder or a zero-length Drive stub).
2. **One writer at a time.** Cloud sync merges nothing; two machines editing the same `.session`
   produce a conflicted copy. The keeper takes a lock file in the project folder while it writes
   and will not run while lameta's own lock is present; a person edits in lameta on one machine.
3. **The FLEx side reaches it through the Parallels share.** Seth's corpus is already in iCloud
   Drive on the Mac; the FLEx VM sees the Mac's folders as `\\Mac\Home\…`, so the keeper on the VM
   reads and writes the same lameta project the Mac's lameta opens, with no second copy. FLEx's
   `CmMediaURI` paths are written in the VM's form of the path; the keeper rewrites them if the
   share letter changes (a setting, checked at each sync).
Google Drive is the better fit if collaborators outside Apple need the folder; iCloud is the better
fit for Seth alone because the corpus is already there. Either way the archive deposit is a zip of
session folders made from the Mac.

Multiple recordings for one text (FLEx allows one `CmMediaURI` per line): all live in the same
session folder; each gets its own `.meta` and its own `.annotations.eaf`; the FLExText carries the
`media-file` guid per phrase. The suite's editor and segmenter assume one recording per text today;
that limit is recorded in #49 and is not lifted by this plan.

---

## Migration of the existing corpus (one-time, assisted)

Seth's iCloud tree ("99 Already In Flex" and siblings) holds folders with random extras, sometimes
several texts and several recordings in one folder. The keeper does not scan folders (Appendix A §9
made the same call): the messy step is done once with Claude reading the tree and proposing a
mapping, and Seth approving it.
1. **Inventory** (read-only script in `corpus-keeper/migrate/`): walk the tree, list every
   `.flextext`, `.eaf`, audio file, and their FLEx text GUIDs (the FLExText `interlinear-text guid`
   ties a file to a FLEx text; the `.eaf` media reference ties an annotation to a recording; audio
   duration and file dates break ties). Output `migration-inventory.json` + a readable table.
2. **Proposal**: for each FLEx text, the recording(s) and files that belong to it, the session slug,
   and what is left over (junk, duplicates, older exports). Produced with Claude in a session over
   the inventory; ambiguous folders listed for Seth with the evidence.
3. **Review**: Seth edits the proposal (a CSV/JSON he can open in a spreadsheet); nothing moves yet.
4. **Apply**: the keeper's `migrate apply` copies (never moves, until Seth deletes the source
   himself) each file into its session folder with the layout above, writes the sessions, points
   FLEx's `CmMediaURI` at the new paths, and writes `migration-report.md` listing every file it
   placed and every file it did not.
Originals are never converted: a WAV is kept as is; a lossy original is kept beside the derived WAV
the ELAN file references, both in the session.

---

## Changes to the FLExText suite (small, all in the browser code)

**Consent collection** (Seth: "if we need to modify our consent collection process, work that in"):
1. **Consent is per person, not per text.** The consent collector gains a *who is consenting* step:
   a person chosen from a list the researcher pushed to the device (the project's People, from FLEx
   via the keeper → panel settings), or typed as a new name. The receipt carries the person's name
   and FLEx person GUID when known. One assent recording can cover several texts by the same
   speaker; the collector offers "same speaker as the previous text" so nobody re-records consent per
   text unless the researcher's script says so.
2. **The receipt records scope and access**: what was consented to (this recording / all my
   recordings for this project), the access level the speaker chose from the researcher's list
   (mapped to lameta's `access` values), the consent script's language and version, the date, the
   device. `buildConsentReceipt` already produces JSON; these are added fields.
3. **Bundles carry consent as person files**: the zip gets `consent/<Name>_Consent.wav` and
   `consent/<Name>_Consent.json`, the names lameta expects, so the keeper's Receive step files them
   without renaming. Today's `consentClip` per text stays for backward compatibility.
4. **Speaker on the text and on lines**: an editable *Speaker* on the text (default for every line)
   and an optional per-line override in the segmenter's row menu; `serializeFlextext` writes the
   FLExText `speaker="<name>"` phrase attribute; `parseFlextext` keeps it. FLEx's import turns names
   into `CmPerson` objects, which is what makes lameta participants and the People folders derive
   from FLEx rather than from typing.
5. **`media-file` in the timed FLExText**: `serializeFlextext` writes the `<media-files>` block and
   per-phrase `media-file` guid (one recording per text for now) so FLEx's import fills
   `Text.MediaFiles` and `Segment.MediaURI` itself; the keeper only has to rewrite the path.
6. **Researcher panel**: an *Assign from FLEx* entry that reads `Outbox/` bundles in phase 1 (drag a
   zip, as today) and the keeper's localhost list in phase 2; a *Receive* download that lands
   bundles in `Inbox/` (a chosen folder), so the round trip is two clicks each way.
7. **Morpheme tiers in the ELAN export** (Seth, 2026-09-06: "including a morpheme analysis tier
   where possible … morpheme transcriptions and chosen lex glosses, not GUIDs or FLEx data"). When
   FLEx's export carries `<morphemes>` under a word (it does when the interlinear configuration shows
   the morpheme lines), the suite's parser keeps that block verbatim in `preservedXML`. A reader
   beside `wordGlosses` (`wordMorphs(w)` in `docs/js/flextext.js`) returns each morph's `txt`
   (morpheme form), `cf` (citation form), `gls` per analysis language (the chosen lex gloss) and
   `msa` (category), from the item elements only, never the guid attributes. `serializeEaf` then adds,
   in FLEx's own ELAN tier naming so ELAN's FLEx import and FLEx's ELAN import both recognise them:
   `A_morph-txt-<vern>` as a Symbolic_Subdivision of the word tier, and `A_morph-gls-<anal>` (one per
   analysis language, primary first) as a Symbolic_Association on it; `cf` and `msa` tiers are
   optional and off by default. Words without morphemes simply have no morph annotations. The `.pfsx`
   sidecar orders them under their word. The listening page may show the morpheme line later; not
   in this plan. Tests extend `test/multi-analysis-ws.test.mjs` with a morpheme fixture.

**Corpus checklist** (Appendix A, adjusted): the derived steps become read-only facts imported from
`corpus-status.json` (per text: FLEx GUID, title, abbreviation, genre, speakers, consent present,
recorded, segmented, % glossed per language, % free-translated per language, ELAN present, session
status, lameta custom workflow fields, durations, word counts). Manual steps stay tickable. Import
creates or refreshes texts by FLEx GUID, never overwrites a manual tick. Everything else in Appendix
A (genre tree, targets, rules engine, report) stands.

---

## Repo: `corpus-keeper`

```
corpus-keeper/
  keeper/            Python package (3.10+, type hints, pathlib)
    flex_read.py       LCM → Text model (texts, segments, timing, media, speakers, genres, people)
    flex_write.py      LCM writes: segment offsets, MediaURI paths, media container entries — nothing else
    flextext.py        timed FLExText out (media-files block, media-file + speaker attrs) and in (by GUID)
    lameta.py          session/person/meta writers with the never-rewrite rules; lameta-closed check
    status.py          derived facts → corpus-status.json
    genres.py          FLEx genre ↔ lameta/OLAC alias map (Appendix A §5 tree as data)
    bundles.py         Outbox/Inbox zip formats (the suite's bundle layout + consent/ folder)
    eaf.py             calls the suite's ELAN writer; see below
  modules/           FLExTools modules: keeper_sync.py, keeper_send.py, keeper_receive.py
  migrate/           inventory.py, apply.py
  tests/             pure-Python tests on fixtures (a small fake LCM, sample lameta folders);
                     one live test script for the VM
  docs/              FACTS.md (verified LCM facts, as in flextools/), lameta layout, runbook
```
The ELAN and listening-page writers exist only in JavaScript (`docs/js/seg-exports.js`, tested,
multi-language since v585). The keeper does not port them: `eaf.py` runs them with Node if present
on the FLEx machine (a 3 MB bundle shipped in the repo), otherwise leaves `.eaf` generation to the
Tauri app or the panel and says so in the report. Porting is a later option if Node proves awkward.

---

## Build order

1. **Facts on the VM** (½ day, needs FLEx + the bridge): read a real text's `MediaFiles`,
   `Segment.MediaURI`, `Speaker` through pythonnet; confirm member names; try the shared-backend
   open (also #49's gate). Record in `docs/FACTS.md`.
2. **`flex_read` + `flextext` + tests** (2 days): the timed FLExText the keeper produces must parse
   in the suite's `parseFlextext` byte-for-byte compatibly (a fixture round-trips through both).
3. **`lameta` + `status` + `genres`** (2 days): generate a session and a person from fixtures; the
   never-rewrite rules tested; `corpus-status.json` schema frozen and documented for the checklist.
4. **Sync module** (1 day) with dry run and report; run on Seth's project.
5. **Suite changes** (3 days across editor, consent collector, segmenter, panel; v586+): consent
   per person + receipt fields + bundle layout; speaker field; `media-file`/`speaker` in FLExText;
   panel Assign-from-Outbox / Receive-to-Inbox. Tests in the suite's style.
6. **Send / Receive modules + `flex_write`** (2 days): round trip one text through a device.
7. **Migration inventory + assisted proposal** (1 day of tooling, then a session with Seth over the
   real tree), then `migrate apply`.
8. **Checklist import** (1 day, in fau_linguistics per Appendix A's build order).
Phase 2 (tray app, localhost bridge) and phase 3 (#49) follow, on the same library.

---

## Verification

- Unit: fixtures for FLExText ↔ model, lameta writers (golden files), status derivation (a text at
  every stage), genre aliasing, bundle packing; the suite's `test/*.test.mjs` for its changes.
- Round trip on the VM: export a real text (timed) → open in the suite locally → change one boundary
  → bundle → Receive → the segment's offsets in FLEx changed and nothing else did (fwdata diff).
- lameta: open the generated project in lameta; sessions, people, consent files and ELAN files
  appear with the right participants; edit `access` in lameta, run Sync again, the edit survives.
- ELAN: open a generated session's `.annotations.eaf` beside its WAV with no relink dialog.
- Checklist: import `corpus-status.json`; derived steps read correctly for three known texts.
- Migration: dry run on the real tree lists every file with a decision and touches nothing.

---

## Still Seth's to decide (not blocking phase 1)

- Consent script versions and the access-level list offered to speakers (mapped to lameta's values).
- Whether `.preview.html` belongs in the archive session or only in the working copy.
- The session slug convention (FLEx abbreviation vs a date-based id, as lameta users often do).
- Whether the corpus checklist stays a separate app (Appendix A) or becomes a view in the panel
  once `corpus-status.json` exists; the import works either way.

---

---

*Appendix A (the corpus checklist plan) lives with the checklist itself in the fau_linguistics repo.*
