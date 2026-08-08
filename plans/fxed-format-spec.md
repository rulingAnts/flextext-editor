# `.fxed` — the FlexText Editor transfer format (SPEC / PLAN, not built)

**Status: design.** Nothing implemented. Supersedes the container discussion in
`fxed-fxpa-formats-plan.md`, which records how this was arrived at and why the alternatives lost.

---

## 1. What it is for

**One text, entire, moved from one FlexText Editor install to another.**

Seth's bar: *"containing everything that one flextext editor app had stored with a text in a way that
can be directly recovered by another session."*

The concrete uses:

| | |
|---|---|
| **Device to device** | a coworker's phone is failing, or is being replaced; move the work without a researcher, a Drive account, or a network |
| **Browser/PWA profile move** | the Pages install → the Cloudflare install, or a reinstall after `?devreset`. ⚠ A PWA's identity is its ORIGIN, so these are genuinely different apps with separate IndexedDB — today there is no way across at all |
| **Hand-off for continuation** | give a text to someone else to finish glossing, with the recording and the alignment intact |
| **A real backup** | the save bundle loses the doc record; this does not |
| **Support** | "send me the text and I'll see what happened" — reproducible on another machine, provenance included |

### ⚠ What it is NOT

- **Not an interchange format.** `.flextext` is that, and the rule stands: *flextext IS the
  segmentation format — no proprietary sidecar*. `.fxed` is a suitcase, and it carries a real
  `.flextext` inside it.
- **Not an archival format.** An archive gets the WAV and the `.flextext`, not a container only our
  app opens.
- **Not a device backup.** It carries the TEXT, never the DEVICE — see §5.

---

## 2. Container

A **ZIP** — the `.docx`/`.odt`/`.epub` pattern. Store-only (no deflate) is acceptable and simplest;
audio does not compress meaningfully and text is a rounding error beside it.

```
<title>.fxed
├── fxed.json           manifest + every record, verbatim, blobs stripped
├── media/<n>.bin       each stripped blob, raw bytes
└── text.flextext       a GENUINE .flextext — the escape hatch
```

**Why not JSON-with-base64:** `JSON.stringify` cannot serialise a Blob — it yields `{}`, silently —
so the audio must be base64'd, costing +33% and, worse, forcing the whole file through one JS string
(UTF-16, so ~2.7× the raw audio) before anything can be parsed. A 6-minute 24-bit take is ~104 MB
raw and ~278 MB as a string: a crash on a field phone. In a zip the blobs stay bytes.

**Why not XML+base64:** same size problem, and `DOMParser` additionally builds a DOM over it.

**Why JSON for the metadata anyway** (Seth's point, and it is the right one): an IndexedDB record
*is* a JS object, so JSON round-trips it with no schema in between and no mapping layer to drift.

---

## 3. `fxed.json`

```jsonc
{
  "format": "flextext-editor-transfer",
  "version": 1,
  "created": 1786000000000,
  "producer": { "app": "FlexText Editor", "engine": "v315" },

  // What the receiving install must reconcile before importing. See §6.
  "writingSystems": { "vern": "fau", "anal": "en" },

  // The doc record from db.putDoc, VERBATIM, minus the deny-list in §5.
  "doc": { "id": "…", "title": "…", "created": …, "modified": …, "doc": { … }, … },

  // Every media record for this text, keyed as the store keys them. Blobs replaced by markers.
  "media": {
    "<docId>":                  { "name": "rec.wav", "mimeType": "audio/wav",
                                  "blob": { "$blob": "media/0.bin", "size": 104857600 } },
    "segwav:<docId>":           { "name": "rec.converted-NOT-ARCHIVAL.wav", "derived": true,
                                  "blob": { "$blob": "media/1.bin", "size": … } },
    "consent:<docId>":          { … },   // recorded assent — opt-in, §5
    "consent-prompt:<docId>":   { … }    // the frozen prompt actually played — opt-in, §5
  }
}
```

### ⚠ 3.1 The `$blob` marker is the whole exporter/importer contract

Export walks each record and replaces every `Blob`/`File` value — **at any depth, not just at the
top** — with `{ "$blob": "<zip path>", "size": n, "type": "<mime>" }`. Import walks the same shape
and swaps each marker back for the bytes at that path. Write it once, in one function pair, and test
it against a nested case; two implementations of this will diverge.

### ⚠ 3.2 Whole-record-minus-deny-list, NEVER a field allow-list

The doc record is serialised as-is, with named exclusions removed. **Not** by copying a list of
fields.

The reason is drift, and it is the same failure the device-setup parity test exists to catch: with an
allow-list, a field added next month simply does not travel, silently, and the text arrives subtly
wrong with nothing to indicate it. The field list found in the code today —

`id, title, created, modified, doc, audioId, audioSource, audioLocked, audioError, capture, done,
doneAt, consentClip, consentPromptClip, consentReceipt, flextextId, flextextForce, pendingAudio,
pendingFlextext, sharedInstall, driveFolderId`

— is offered as evidence of how many there are and how easily one is missed, **not as the list to
implement.**

---

## 4. `text.flextext`

A genuine, valid `.flextext` produced by the existing `serializeFlextext()`, segmentation offsets and
all. It is redundant with `doc` in the manifest, and it earns its place anyway:

- **The escape hatch is inside the file.** Unzip, and there is something FLEx imports. That answers
  "what if you stop maintaining this" better than a format spec would, and it means `.fxed` can never
  become a place work goes and does not come back.
- **It is the recovery path** if `fxed.json` is ever unreadable — a version we cannot parse, a
  truncated download.
- It costs kilobytes against megabytes of audio.

---

## 5. ⚠ What must NOT travel

The rule: **`.fxed` carries the TEXT and its media. It never carries the DEVICE.**

| excluded | why |
|---|---|
| **device settings** (`flextext-ws-settings`) | the destination chose its own, for its own worker and speakers. Overwriting them is the invite-link override, unannounced |
| **pairing / session** (`flextext-sync-session`) | a session identifies a DEVICE. Carrying it clones an identity, and two devices answering as one is a security problem, not a sync problem |
| **`upload:<docId>`** | addressed to a worker the destination may not share, and re-queuing an upload the sender already made would double-post |
| **`driveFolderId`** | names a folder in the SENDING researcher's Drive. Dropped, the worker's `appProperties` search re-finds or re-creates — the pre-v167 behaviour, correct if untidy |
| **`sharedInstall`, `pendingAudio`, `pendingFlextext`** | in-flight state of the sending device's session; meaningless on arrival and actively misleading |

### 5.1 Consent material is opt-in, and the export must ask

`consentReceipt` carries a best-effort IP/location capture, and `consent:<docId>` is a recording of a
person saying yes. Between one researcher's own devices this is unremarkable. Handed to a third
party it is a transfer of a speaker's personal data.

**Default: include** (it is the same researcher's device in the common case, and an IRB record that
silently detaches from its text is its own harm) — **with a plainly worded checkbox to exclude, and
the resulting file marked** `"consentIncluded": false` so the receiving app can say so rather than
appear to have lost it.

---

## 6. ⚠ Writing systems: check on IMPORT, and the machinery already exists

Seth: *"as long as the writing system codes match and adding the ability to check and adjust that one
way or another isn't difficult"*. It is not difficult, because it is already built and already ships
in both apps: `flextext.js` exports **`surveyWritingSystems(xmlString)`** and
**`remapWritingSystems(dom, mappings)`** — what the editor's Utilities checker runs on.

Import compares `writingSystems` in the manifest against the destination's settings:

- **identical** → import silently.
- **different** → show the existing remap UI over `text.flextext`, apply the mapping, and re-derive
  `doc` from the remapped XML. ⚠ **Remap the XML, not the object.** The XML is where WS codes are
  addressable and where the existing function operates; hand-walking the object would be a second
  implementation of a thing that already works.
- **destination has none set** → adopt the incoming codes and say so.

A mismatch must never be silent: a text whose vernacular is labelled `id` on arrival will render in
the wrong font and export wrongly to FLEx, and nothing downstream will notice.

---

## 7. Import behaviour

- **Always a NEW doc id.** Never overwrite an existing text by matching ids — the same text
  legitimately exists on both devices with the same id, and clobbering the destination's copy would
  destroy work that was never sent. If the incoming id already exists, mint a new one and title it
  `<title> (imported)`.
- **Atomic-ish**: write all media first, then the doc record last. A failure mid-way leaves orphan
  media (harmless, sweepable) rather than a doc pointing at audio that is not there.
- **Refuse an unknown `version`** with a clear message naming the producing engine, rather than
  importing a subset and appearing to work.
- Reachable from the same place `.flextext` import is — one picker, sniffed by content.

---

## 8. Risks, honestly

- **A `.fxed` is a whole text in one file, including a consent recording.** Losing one on a USB stick
  is a bigger event than losing a `.flextext`. The consent opt-out in §5.1 is the mitigation; the
  filename should not include a speaker's name.
- **The zip reader does not exist.** `docs/js/zip.js` is `makeZip` and nothing else. Store-only
  reading is perhaps 60 lines — and it also unlocks the "flatten inner bundles" fix the panel's
  Download-all wants, so it pays for itself twice.
- **`version: 1` is a promise.** Once one is in the field, changing the shape means supporting both.
  Hence whole-record-minus-deny-list: new fields ride along without a version bump.

## 9. Order of work

1. **Zip reader** in `zip.js` (store-only), with its own tests. Independently useful.
2. **Blob strip/restore** (`$blob`) as a pure, tested pair. This is the contract; get it right alone.
3. **Export**: manifest + media + `text.flextext`. Behind the researcher-gated Buttons group at
   first, like the other export toggles.
4. **Import**: version check → WS reconcile → media → doc.
5. Consent opt-out and its labelling.

⚠ Steps 1–2 are pure and node-testable, and together they are most of the risk. Do not start at
step 3.

## 10. Open questions

1. **Extension**: `.fxed` or `.fxpe`? Both have been used. `.fxed` reads as "FlexText EDitor", which
   matches what it is.
2. **Should the recorder satellite export it too?** It holds recordings but no glossing. Probably
   yes for the device-replacement case, but it doubles the surface.
3. **Multi-text `.fxed`** — a whole library in one file? Tempting for device replacement, and a
   different feature: it would need settings (excluded by §5), and the file gets very large. Suggest
   one text per file for v1, and revisit.
