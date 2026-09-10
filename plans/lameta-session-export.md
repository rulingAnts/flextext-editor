# The lameta session folder — format, and what we emit

**Status:** the writer is built (`docs/js/lameta.js`, `test/lameta-session.test.mjs`, 11 tests).
Panel wiring is not. Issue #71.

⚠ **Everything in this document was read from real files, not inferred.** Ground truth is Seth's own
project at `~/Documents/lameta/Fayu-restructure-plan/` and the working tool from the corpus
restructuring session (`lameta-editor/lameta_core.py`), which edits lameta projects on disk. Where a
value or an order is stated below, it was copied from there.

---

## 1. Why a session folder at all

Seth, 2026-09-10: *"I've got texts coming that I need to move from Researcher panel into my organized
text corpus. And I want to make that easier."*

One text becomes one lameta session. That mapping is natural rather than forced: our texts already
carry a recording, an annotation, a speaker and a consent record, which is very nearly what a lameta
session *is* — and a lameta session corresponds to a **bundle** in ELAR.

## 2. ⚠ Sessions are DISCOVERED, not registered — which is what makes a drop-in folder work

The `.sprj` project file carries only project-level settings:

```xml
<Project minimum_lameta_version_to_read="0.0.0">
  <ArchiveConfigurationName>REAP</ArchiveConfigurationName>
  <AccessProtocol>REAP</AccessProtocol>          <!-- emitted for SayMore/older lameta -->
  <ProjectName>…</ProjectName>
  <VernacularISO3CodeAndName/>                   <!-- superseded by SubjectLanguages -->
  <AnalysisISO3CodeAndName/>                     <!-- superseded by WorkingLanguages -->
  <guid>…</guid>
  <Contributions></Contributions>
</Project>
```

**No session list.** lameta finds sessions by scanning `Sessions/` for a directory containing
`<dirname>.session` — the same rule `lameta_core.py` uses:

```python
if os.path.isdir(os.path.join(S,d)) and os.path.exists(os.path.join(S,d,d+'.session'))
```

So a researcher **copies the folder into `Sessions/` and reopens the project.** No import UI, no
registration, no add-on required. That question was asked and this is the answer.

⚠ **The folder name MUST equal the session id**, and both must equal the `<id>` inside the file. A
mismatch makes the session **invisible** — not an error, invisible. A test pins all three agreeing.

## 3. The session file

`Sessions/<id>/<id>.session`, verbatim from Seth's project:

```xml
<?xml version="1.0" encoding="utf-8"?>
<Session minimum_lameta_version_to_read="0.0.0">
  <id type="string">narr_air_rifle_accident</id>
  <Title type="string">Air Rifle Accident</Title>
  <Genre type="string">narrative</Genre>
  <Status type="string">In_Progress</Status>
  <Contributions>
    <contributor>
      <name>Suhu, Yohanis</name>
      <role>author</role>
      <date>0001-01-01</date>
    </contributor>
  </Contributions>
</Session>
```

Field order (`SESSION_ORDER`): `id, Title, Description, languages, WorkingLanguages, Genre,
Sub-Genre, Status, Date, Location, Location_Region, Location_Country, Location_Continent, Access,
AccessExplanation, Keywords, Topic, Contributions, AdditionalFields`.

Note `0001-01-01` is what lameta writes for "no date" — matched so our files look like its own.

### ⚠ Controlled vocabularies — lameta DROPS an unrecognised value rather than complaining

That is why anything outside these lists is **omitted, never approximated**. A field that looks
answered but was silently discarded is worse than a blank one.

| field | permitted values |
|---|---|
| `Status` | `Incoming` `In_Progress` `Finished` `Skipped` |
| `Genre` | `narrative` `description` `oratory` `procedural_discourse` `procedural_text` `singing` `stimuli` `conversation` `elicitation` `formulaic_discourse` `ludic` `report` `interactive_discourse` `language_play` `unintelligible_speech` |
| `role` | `author` `speaker` `transcriber` `translator` `researcher` `participant` `recorder` |
| `Location_Continent` | `Africa` `Americas` `Asia` `Australia` `Europe` `North-America` `Middle-America` `Oceania` `South-America` |
| `Involvement` | `elicited` `non-elicited` `no-observer` |
| `Planning_Type` | `spontaneous` `semi-spontaneous` `planned` |
| `Social_Context` | `family` `private` `public` `controlled environment` |
| `Gender` (person) | `Unknown` `Male` `Female` `Other` |

Filename charset (`VALID`): `0-9 a-z A-Z _ . -`

### Per-file sidecar

Every media/annotation file gets `<filename>.meta` beside it:

```xml
<?xml version="1.0" encoding="utf-8"?>
<Meta minimum_lameta_version_to_read="0.0.0">
  <Contributions></Contributions>
</Meta>
```

lameta will create these itself if absent, but the restructuring tool writes them, so we do too — it
costs nothing and matches a project lameta has already touched.

## 4. What we put in the folder

```
Sessions/<id>/<id>.session
Sessions/<id>/<base>.eaf              complete ELAN-for-FLEx hierarchy, all six tiers
Sessions/<id>/<base>.pfsx             tier display order — vernacular-first, not alphabetical
Sessions/<id>/<base>.flextext         serialized at export time, from the same doc as the EAF
Sessions/<id>/<base>.history.json     this text's provenance only  ⚠ not built yet — #75
Sessions/<id>/<original recording>    the master, in whatever format it was recorded
Sessions/<id>/<base>.converted-NOT-ARCHIVAL.wav   only when the master is not WAV
… plus a .meta sidecar per file
```

### ⚠ ELAN EAF, never the SayMore profile

Seth: *"Lameta doesn't have a built in eaf/annotation editor like SayMore does. It just opens ELAN."*

SayMore **managed** annotation files — it rewrote `<media>.annotations.eaf`, which is why our
`saymore` profile is deliberately two tiers (`Transcription` / `Free Translation`) and why SIL advise
against adding any. lameta delegates to ELAN, so nothing rewrites the file and the complete six-tier
hierarchy survives. The two-tier file would be a strict **downgrade** in the tool the researcher
lands in, so it does not appear in this package at all.

⚠ **And lameta already recognises our formats.** Its annotation extension set (`ANN`) is
`{.eaf, .pfsx, .flextext, .fxpa}` — so the `.flextext` is a first-class annotation file there, not a
foreign body. `.pfsx` earns its place because a researcher arriving from lameta lands directly in
ELAN, and that sidecar is the difference between tiers opening vernacular-first and alphabetically
inverted.

### The derived WAV

If the master is not WAV, `<base>.converted-NOT-ARCHIVAL.wav` rides along, because the EAF references
media by name and ELAN needs something it can draw a waveform from. Its name states its status and
its bytes carry a BWF `bext` chunk naming the lossy origin. **The original always ships as well** —
the derived WAV is additional, never a replacement.

## 5. What we can fill, and what the researcher fills

| field | from |
|---|---|
| `id` | the text's base name, through `lametaSessionId()` |
| `Title` | the doc title |
| `Status` | `Finished` when the coworker marked it done, else `In_Progress` |
| `languages` | the vernacular writing-system code |
| `WorkingLanguages` | the analysis writing-system code |
| `Contributions` | the consent speaker, role `speaker` |
| everything else | the researcher, in lameta — which is what lameta is for |

## 6. Still to do

- **Panel wiring**: a download that zips these entries. `docs/js/zip.js` (`makeZip`) exists; the panel
  already builds artifact downloads from Drive file ids.
- **`<base>.history.json`** ([#75](https://github.com/rulingAnts/flextext-editor/issues/75)): the per-text slice of the event log. ⚠ There is no per-text history file
  today — `history.js`'s log is account-wide, so the slice is derived at export time. See
  `plans/fxed-format-spec.md` §9b: when built, it ships in the lameta, SayMore **and** "All" exports,
  not just this one.
- **`Genre`** is not something we hold. Leave it out and let the researcher choose from lameta's list.
- ⚠ **Verify a produced folder actually opens in lameta** before trusting this. The format here is
  read from real files, but "reproduces the format" and "lameta imports it cleanly" are different
  claims and only the second one matters.
