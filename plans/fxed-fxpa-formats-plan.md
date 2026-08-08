# `.fxed` and `.fxpa` — file formats and app boundaries (PLAN ONLY)

Seth, 2026-08-07: *"I think we want .fxed and .fxpa separate but similar file formats. The Editor
can export but not import .fxpa. The PAT can export and import both, but the fxed format removes the
PAT specific structure and flattens it into only objects and data that the Editor app can deal with…
There really should be no reason though, once we've got join/split, why someone WOULD want to go
from PAT back to the Editor if PAT can edit content and join and split lines too."*

Nothing here is implemented. **Two findings below change the shape of the proposal, so read those
before the matrix.**

---

## ⚠ FINDING 1: the flattened format already exists, and it is `.flextext`

`.flextext` is not merely "the Editor's format" — it already carries exactly what Seth describes
`.fxed` as carrying:

| the analyst's data | where `.flextext` puts it |
|---|---|
| baseline text | phrase `<item type="txt">` |
| words + glosses | `<words>` / `<item type="gls">` |
| free translation | `<item type="gls">` on the phrase (free line) |
| **time alignment** | phrase `begin-time-offset` / `end-time-offset` + `<media-files>` |
| notes, literal translations | preserved `<item>` children |

That is "objects and data that the Editor app can deal with", flattened, with no PAT structure —
which is the definition of `.fxed` in the brief.

⚠ **And there is a standing rule against inventing an alternative** (CLAUDE.md, Seth 2026-08-03):

> **`flextext` IS the segmentation format — no proprietary sidecar.**

`.fxed` would be precisely the proprietary sidecar that rule forbids, and it would be the *second*
one after `.fxpa`. Before building it, the question worth answering is concrete:

> **What would `.fxed` carry that `.flextext` cannot?**

Candidates I can see, and none is obviously worth a new format:

- `timePending` / `timeEstimated` flags — currently expressed as the *absence* of offsets plus a
  `~` in the visible note line. Round-trips today, if coarsely.
- The derived-WAV pointer (`<orig>.converted-NOT-ARCHIVAL.wav`) — belongs in the bundle, not the
  document.
- Editor device settings — do not belong in a text file at all.

If the answer turns out to be "nothing", then `.fxed` should not exist and the work reduces to one
missing export (see Finding 2). If there IS something, it argues for **extending `.flextext`'s
preserved items**, not for a new container.

## ⚠ FINDING 2: PAT already IMPORTS `.flextext`. The gap is that it does not EXPORT it

`paragraph-ui.js` accepts `.flextext,.eaf,.fxpa,.csv,.tsv,.txt,audio/*` and reads `.flextext`
directly. So half the proposed matrix is already built — and the other half is one export away.

**So the missing piece is not a format. It is `serializeFlextext` in PAT's export menu.**

---

## ⚠ CORRECTION: there is no PAT → FLEx, and that changes the conclusion

I argued that PAT needed a `.flextext` export so analysis could return to FLEx. **Seth: "Analysis
done in PAT actually CAN'T go to FLEx, at least not the paragraph/ssa analysis that the whole app
exists to do. FLEx won't support that."**

That is decisive, and it kills the argument rather than qualifying it. A `.flextext` export from PAT
would not be "lossy but useful" — it would drop **precisely the thing PAT exists to produce**. An
export that discards the product is not an escape hatch; it is a transcription with extra steps.

So both rationales I offered for `.fxed` are now gone:

- ~~PAT → FLEx round trip~~ — impossible in principle. FLEx has no schema for a semantic-analysis
  bracket, and will not grow one for us.
- ~~PAT → Editor round trip~~ — Seth: unnecessary once PAT can edit content and split/join.

~~**Conclusion: do not build `.fxed`.**~~ — **SUPERSEDED THE SAME DAY. Seth found the use case
neither of us had, and it is a good one:**

> *"our proprietary json format embeds the audio. Which is a useful thing to be able to do. And it is
> useful to be able to move work (with ALL text-specific browser storage) from one FlexText Editor
> app install to another (as long as the writing system codes match…)"*

⚠ **THIS IS A TRANSFER FORMAT, NOT A DOCUMENT FORMAT**, and the distinction is what makes it
legitimate rather than a third interchange format. `.flextext` remains the interchange and archival
format — the thing FLEx and ELAN read, and the thing the no-proprietary-sidecar rule is about.
`.fxed` would be a SUITCASE: one file that moves one text, entire, between two installs of the same
app. Nothing else in the suite can do that, because:

- **`.flextext` cannot embed audio.** It references a media file BY NAME (`<media-files>`), so a
  `.flextext` alone is a text that has lost its recording. `.fxpa` already embeds audio, which is
  exactly the precedent Seth is pointing at.
- **The save bundle is close but not sufficient.** The `.zip` already carries flextext + audio +
  consent receipt + EAFs, and segment times ride as offsets — so most of the *document* travels
  today. What does NOT travel is the DOC RECORD: title, created/modified, `done`, `audioSource`,
  `audioLocked`, `capture` (the recording provenance), `consentReceipt`, `driveFolderId`. Losing
  those turns a moved text into a text that looks the same and has forgotten where it came from.

### ⚠ What must NOT travel, and this is the important half

A suitcase that carries too much re-creates the two-sources-of-truth problem in a new place:

- **device settings** — the receiving install has its own, chosen for that device and that worker.
  A transfer that overwrote them would be the invite-link override, unannounced.
- **pairing / session** — a session belongs to a device, not a text. Carrying it would clone an
  identity.
- **upload queue state** — the destination has a different worker target and a different queue.

The rule that falls out: **`.fxed` carries the TEXT and its media. It never carries the DEVICE.**

### Writing systems: the capability is already built

Seth: *"as long as the writing system codes match and adding the ability to check and adjust that one
way or another isn't difficult"*. It is not difficult, because it already exists and ships in both
apps: `flextext.js` exports **`surveyWritingSystems(xmlString)`** and
**`remapWritingSystems(dom, mappings)`**, used today by the editor's Utilities checker and by the
researcher panel. An import would survey the incoming codes against the destination's settings and
offer the same remap UI that already exists — no new machinery, just a new caller.

### ⚠ One thing to decide before building: consent receipts are personal data

A `consentReceipt` carries a best-effort IP/location capture. Moving it between the researcher's own
installs is unremarkable; a `.fxed` handed to someone else is a transfer of a speaker's data. Either
the export asks, or receipts are excluded by default with an explicit opt-in — but it should not be
silent.

**Revised conclusion: `.fxed` is worth building, as a transfer format only.** The original rationales
(PAT → FLEx, PAT → Editor) remain dead; this is a different feature that happens to want a similar
container. Future plan, per Seth.

### The container: Seth's XML proposal, and the one thing that argues against it

> *"Basically fxpe would be flextext with embedded audio. And it could be XML-based and not JSON,
> basically just actual flextext XML including audio segmentation attributes our app already uses,
> plus a slightly adjusted header and XML element that embeds the audio binary data as base64 string
> (if XML supports that)"*

**Yes, XML supports it** — base64 is plain text, and `xs:base64Binary` is a standard schema type. No
obstacle there. And the proposal's real strength is that **the parser is already written**:
`parseFlextext()` reads the structure, the segmentation offsets already round-trip, and only the
audio element would be new. Inventing a JSON shape would throw that away.

⚠ **The cost is memory, and it is worse in XML than in JSON.** `DOMParser.parseFromString()` needs
the ENTIRE document as one JS string before it builds anything, and JS strings are UTF-16:

| a 6-minute mono 24-bit 48 kHz WAV | |
|---|---|
| raw | ~104 MB |
| base64 (+33%) | ~139 MB |
| as a JS string (×2, UTF-16) | **~278 MB**, before the DOM makes its own copy of the text node |

That is a normal field recording, and that is a crash on a phone. `.fxpa` has the same exposure via
`JSON.parse`, and it works today — but `.fxpa` files are made from the same recordings, so this is a
limit already being approached rather than one being invented.

### The alternative that reuses even more and dodges the wall entirely: make it a ZIP

`.docx`, `.odt`, `.epub` are all zips with a distinct extension. The suite already has `makeZip()`,
and **the save bundle is already 90% of this file** — flextext + audio + receipts, with segment
times riding as offsets. `.fxed` would be that bundle plus a `manifest.json` carrying the doc record
(title, timestamps, `done`, `audioSource`, `audioLocked`, capture provenance, `driveFolderId`).

| | XML + base64 | ZIP |
|---|---|---|
| audio overhead | **+33%** | none (stored raw) |
| peak memory to read | whole file as UTF-16 string, then a DOM | one entry at a time |
| code to write | new audio element + writer; parser reuse ✅ | `makeZip` exists; a READER does not (zip.js is write-only) |
| inspectable | in principle — but no editor opens a 139 MB file | unzip it and read the `.flextext` directly |
| precedent | `.fxpa` | `.docx` / `.odt` / `.epub`, and our own bundle |

The reader is the honest cost of the zip route: `docs/js/zip.js` exports `makeZip` and nothing else,
so a store-only (no deflate) reader would need writing — perhaps 60 lines, and it would ALSO unlock
the "flatten inner bundles" fix in the panel's Download-all.

### ✅ DECIDED: a ZIP, the `.docx` pattern

Seth, 2026-08-07: *"maybe our fxpe format would be similar to docx — actually a zip file with xml and
other files (audio for example) inside."*

That is the recommendation and it settles the container. Shape:

```
<title>.fxed                        (a zip)
├── text.flextext                   the REAL flextext XML — segmentation offsets and all
├── manifest.json                   { format, version, docRecord{…}, wsCodes{vern,anal} }
├── media/<name>.wav                raw bytes, no base64, no +33%
├── media/<name>.converted-NOT-ARCHIVAL.wav   the segwav working copy, if one exists
└── consent/…                       receipts + prompt, ONLY if the export opts in (see below)
```

Why this is better than it first looks:

- **`text.flextext` is a genuine, valid `.flextext`.** Unzip the file and you have something FLEx
  can import — so the escape hatch is the container's own contents, not a separate export path. That
  answers the lock-in question more completely than the format spec would have.
- **Nothing new to parse.** `parseFlextext()` reads the text; the audio is bytes.
- **No size cliff.** The 278 MB string problem simply does not arise.
- ⚠ **The one thing to build is a zip READER.** `docs/js/zip.js` exports `makeZip` and nothing else.
  Store-only (no deflate) is enough for our own files and is perhaps 60 lines — and it also unlocks
  the "flatten inner bundles" fix the panel's Download-all wants, so it pays for itself twice.

⚠ **Still true, and now easier to satisfy:** the file must not be mistakable for a `.flextext`. A zip
is not XML, so nothing will hand it to FLEx by accident — the extension and the magic bytes disagree
with `.flextext` at the first byte, which is exactly the property the XML route could not have.

### The completeness bar: *everything* the app had stored, directly recoverable

Seth: *"containing everything that one flextext editor app had stored with a text in a way that can
be directly recovered by another session."*

⚠ **That is a stronger requirement than "the document plus its audio", and it is the one that should
drive the manifest.** The test is not "does it look the same" — it is **would the receiving install
be in the same state as the sending one**. So the manifest is written from the actual storage, not
from a list someone remembered:

| what the app stores per text | where | in `.fxed`? |
|---|---|---|
| the doc record — title, created, modified, `done` | `db.putDoc` | ✅ manifest |
| the interlinear content + segment times | doc → `text.flextext` | ✅ (offsets round-trip) |
| `audioSource`, `audioLocked` | doc record | ✅ manifest |
| `capture` — recording provenance | doc record | ✅ manifest (it is the point of the bext work) |
| `driveFolderId` | doc record | ⚠ **decide** — see below |
| `consentReceipt` | doc record | ⚠ opt-in — personal data |
| the audio | `db.putMedia(docId)` | ✅ `media/` |
| the segwav working copy | `db.putMedia('segwav:'+id)` | ✅ `media/` (or regenerate; see below) |
| the consent prompt + recorded assent | `db.putMedia('consent-prompt:'+id)` etc. | ⚠ opt-in |
| pending upload blob | `db.putMedia('upload:'+id)` | ❌ never — see below |

**⚠ THE DERIVATION TO WRITE FIRST is the enumeration itself.** A hand-kept list of doc-record fields
will drift the moment a field is added — the same silent-drift failure the device-setup parity test
exists to catch. Prefer: serialise the WHOLE doc record minus an explicit deny-list, so a new field
travels by default and only deliberate exclusions are named. Getting this backwards means a future
field silently fails to transfer and nobody notices until a text arrives subtly wrong.

**`driveFolderId`** deserves a decision rather than a default. It names a folder in the SENDING
researcher's Drive. Carried across, the receiving install would upload into a folder it may not own;
dropped, the next upload mints a fresh folder (the old, pre-v167 behaviour — correct, just untidy).
Recommend **drop it**, and let the worker's `appProperties` tag search re-find or re-create.

**The segwav copy** is derivable from the original, so including it is a size-vs-time trade: a
6-minute recording roughly doubles the file to save the receiving device one decode-and-re-encode.
Recommend **include it when it exists** — the receiving device may be the weaker one, and the
conversion is exactly what the first-load bug was about.

**Never the upload queue.** It is addressed to a worker the destination may not share, and it is
device state, not text state — the same line the "carries the TEXT, never the DEVICE" rule draws.

### ⚠ Whatever the container: it must not be mistakable for a real `.flextext`

If it keeps the flextext root element and merely adds a child, someone will eventually hand it to
FLEx — which will either reject it or import it while silently dropping the audio, and the user will
conclude the recording was lost. A distinct extension is necessary but not sufficient: use a
distinct root element or namespace too, so the file identifies itself by its CONTENT and not only by
its name.

### Naming

Both `.fxed` and `.fxpe` have been used for this in conversation. Worth settling on one — `.fxed`
reads as "FlexText EDitor", which matches what it is (a transfer between Editor installs).

### What the lock-in concern becomes instead

The concern was real even though the answer was wrong. If no standard format can hold SSA, then the
answer is not "export to a standard" — it is **make `.fxpa` itself durable**:

- an OPEN, documented, versioned schema — `FXPA_FORMAT`, `FXPA_VERSION`, `validateFxpa()` already
  exist, and the whole engine is AGPL, so the format is readable by anyone who wants to write a
  reader;
- ⚠ what is missing is the DOCUMENT. The schema lives only in `paragraph-model.js`. For the
  SIL/Payap adopters this suite is aimed at, "here is the format spec" is the answer to "what
  happens if you stop maintaining this", and it does not exist yet. **That is the deliverable the
  `.fxed` idea was really reaching for**, and it is a page of Markdown rather than a new format.

### ⚠ AND A CONSEQUENCE WORTH FACING: PAT BECOMES TERMINAL

If the analysis can go nowhere else, then **the `.fxpa` is the only copy of work that may represent
many hours**, held in one browser origin's storage, with:

- no researcher-panel sync (that is the editor/recorder estate, not PAT);
- no upload path;
- the same "clear site data and it is gone" exposure every browser app has.

The editor mitigates this with uploads, auto-backup and the Drive estate. **PAT has none of it.**
That is not a formats question, but it is the risk the formats question was standing in front of,
and it is worth its own plan: at minimum an explicit "save your `.fxpa`" discipline, at most a sync
path of its own.

## The matrix, as it should stand

| | `.flextext` | `.fxpa` | `.eaf` |
|---|---|---|---|
| **Editor** | import ✅ · export ✅ | export ✅ · **import ✗** (correct — nowhere to put a tree) | export ✅ |
| **PAT** | **import ✅ (already works)** · export ✗ *(and no longer wanted)* | import ✅ · export ✅ | import ✅ |

**Nothing to build.** Data flows FLEx → Editor → PAT, and PAT is where analysis lives. The one
direction Seth confirmed is useful — FLEx → PAT — is already supported: `paragraph-ui.js` accepts
`.flextext` and reads it directly.

---

## Questions

1. ✅ ~~Is there something `.fxed` must carry that `.flextext` cannot?~~ **Moot — `.fxed` has no
   direction left to serve. Recommend not building it.**
2. **Is a written `.fxpa` format spec worth a page?** I think yes, and that it is what the `.fxed`
   idea was actually reaching for — the answer to an adopter asking "what if you stop maintaining
   this". Cheap: the schema already exists in code and is already validated and versioned.
3. **PAT is now terminal for analysis. What is the durability plan?** No sync, no upload, no
   backup — one browser origin holding the only copy of hours of work. This is the biggest thing
   the formats discussion surfaced and it deserves its own plan.
4. **Does the Editor's inability to import `.fxpa` need saying out loud** when a user tries? The
   file picker simply will not accept it, which reads as "broken" rather than "wrong app" — the
   same standing rule as every other disabled control.


---

## The JSON-vs-zip question, resolved: **use both**

Seth: *"that's an argument for using json with embedded audio. JSON is actually basically just a
direct JavaScript copy of the browser storage model, variables, objects, etc. Might make it easier
to faithfully copy from one browser/PWA profile to another."*

The premise is right and it is the strongest argument made for any container so far: an IndexedDB
record **is** a JS object, so JSON round-trips it with no schema in between, no mapping layer to
drift, and no field silently lost because a serialiser did not know about it. That is exactly the
completeness bar. **It should decide the METADATA format.**

⚠ **But it cannot decide the AUDIO, because JSON cannot hold a Blob.**

```js
JSON.stringify({ blob: someBlob })   // → '{"blob":{}}'
```

IndexedDB stores the recording as a **Blob** — opaque bytes, natively. `JSON.stringify` does not
serialise it; it produces an empty object and says nothing. So "a direct JavaScript copy of the
storage model" holds for every field EXCEPT the one that carries the recording, which must be
base64'd — reintroducing +33% and the ~278 MB string wall for a 6-minute take.

And base64-in-JSON is arguably the *less* faithful copy: the Blob was never text. A file inside a
zip is opaque bytes, which is what a Blob is; a base64 string is a re-encoding of something that had
no encoding to begin with.

### So: a zip whose metadata is JSON

```
<title>.fxed                        (a zip — the .docx pattern)
├── store.json        ⚠ THE DOC RECORD AND EVERY MEDIA RECORD, VERBATIM JS OBJECTS,
│                       minus their .blob fields — whole-record-minus-deny-list, so a
│                       future field travels by default (see the completeness bar above)
├── media/<key>.bin     each stripped .blob, raw. store.json names the file per key.
└── text.flextext       the interchange copy — a genuine .flextext FLEx can import
```

Every advantage Seth is pointing at survives:

| | |
|---|---|
| faithful object copy of storage | ✅ `store.json` is `JSON.stringify` of the real records |
| no mapping layer to drift | ✅ same — the deny-list is the only hand-kept part |
| easy "recover directly into another profile" | ✅ `JSON.parse` → `db.putDoc` / `db.putMedia`, with each blob read from its zip entry |
| no +33%, no string wall | ✅ blobs stay bytes |
| FLEx escape hatch inside the file | ✅ `text.flextext` |

The blob-stripping is the only real work, and it is small: walk the record, move every `Blob`/`File`
value into `media/` under a generated name, leave a `{ "$blob": "media/x.bin", "type": "audio/wav" }`
marker in its place, and reverse it on import. That marker convention is worth writing down once —
it is the whole contract between exporter and importer.

**If a single-file JSON is still wanted** (no zip reader to write, one `JSON.parse` to import), it
remains workable — but then the export must refuse, with a clear message, above a size where the
receiving browser will fail. Discovering that limit as a tab reload on a field phone, holding the
only copy of a text, is the outcome this whole document is trying to avoid.
