# Assign-by-upload: file pickers + private delivery + panel-side conversions

**Status: APPROVED BUILD SPEC (Seth, 2026-08-11). This document is the contract for the build
session.** Branch: `assign-by-upload`, cut fresh from `main` at a2b2655 (== productionWeb, the
v333 release). An earlier branch of the same name (based on pre-release d7ec070) was deleted; its
"set anyone-with-link" mechanism is SUPERSEDED by the private-token design below.

## ⬛ v2 RESTRUCTURE — one canonical folder shape (Seth, 2026-08-12, after the v335 test drive)

The first test drive passed the core flow (file pickers, private delivery, folder dedupe, WS
warning, round trip) and exposed one architectural gap: a text CREATED BY RECORDING has a different
Drive shape from an ASSIGNED text — its audio is sealed inside the upload zip, so the Files menu
cannot offer the original audio, and the saved ELAN/SayMore bundles came out with no WAV. Seth:
*"let's have the uploaded zip land on Google Drive as a folder and not as a zip… have that folder
be the assignment folder, and have it include an initial flextext file after all. That way our
assignment folder shape is consistent regardless of how the text was created."*

**Locked decisions**
1. **`<Storyname>/originals/`** is the canonical source folder for EVERY text, however it was
   created. Assigned texts get it at assign time; recorded texts create it on the first media
   upload. NOT called `assignment/` (Seth, 2026-08-12): the name has to cover both cases, and for a
   linguist browsing Drive "originals" says exactly what is in there — the untouched, as-delivered
   or as-recorded materials, as against the derived and working copies elsewhere. File role tags
   follow the same logic: `source-audio`, `source-flextext`, `consent-*`, `manifest`. (The panel's
   `/assignment/*` WORKER ROUTES keep their name: they really are the assign flow, and the device
   reaches the same folder through the ordinary upload endpoint with `x-fx-sub: originals`.)
   ⚠ **No blank initial flextext** (Seth): an untranscribed text has nothing worth uploading. The
   assigned flextext, when the researcher supplies one, IS a real source file and lives here —
   "the only thing that really needs that original file, if it exists, is the client FlexText
   Editor and only the first time it loads." It is therefore stored but NOT offered as its own
   download item; the manifest records whether it exists.
2. The device uploads the recording package as INDIVIDUAL FILES into that folder, not a zip.
   Considered and rejected: uploading a zip and having the worker unzip it into the folder. It is
   possible (our zips are STORE-only, so entries are contiguous byte ranges and could be streamed
   Drive→worker→Drive off the central directory) but it fails hardest on the biggest files — a
   128 MB isolate, every byte crossing the network twice, wall-clock exposure, and a half-extracted
   folder plus an orphan zip to reconcile. The existing zip-extract path already caps at 60 MB for
   the same reason. A Drive resumable session is atomic per FILE either way; only the SET differs.
3. **`flextext-manifest.json` — the package's metadata record AND its completeness contract**
   (Seth: *"assigned texts should also generate a manifest file with metadata… a place to specify
   HOW the text was originated in case our suite or some app needs to know"*). Every text gets one,
   however it was created.
   - ⚠ Written **FIRST**, not last. Writing it last would make its absence mean "something is
     missing" without saying WHAT. Written first, it declares the intended file set, so a consumer
     compares that list against the folder and can name the missing piece. **Completeness is
     DERIVED, never a stored `complete: true` flag** — a flag goes stale the moment a later write
     fails, and would then assert the opposite of the truth. A `completedAt` stamp may be added on
     the final write as a convenience, but nothing may trust it over the file list.
   - Shape (versioned, additive-only; unknown keys must be ignored by readers):
     `{ schema: 1, docId, title, origin, originatedAt, writtenAt, engine, buildTag,
        writingSystems: { vern, anal }, audio: { name, mime, bytes, derived }, files: [ { name,
        role, mime, bytes } ], consent: { mode, prompt, response, receipt } }`
   - `origin` is the provenance field Seth asked for — `'assigned' | 'recorded' | 'imported' |
     'pair-import' | 'crowd'` — plus who/what produced it (researcher account for an assignment,
     device nickname for a recording). Additive: a new origin value must never break an old reader.
   - Contains NO consent CONTENT and no personal data beyond what the folder already holds; it
     records that a receipt exists, not what it says.
   - Small files land in seconds; only the audio is slow, so the incomplete window is short and
     self-heals through the existing retry-forever queue.
4. **Original audio is named `<Storyname>.<ext>`** (Seth), sanitised with the same rule as the
   folder name (slashes/unicode/120-char cap). Detection uses Drive **role tags**, never filenames,
   so a later story rename leaves a cosmetically stale name and nothing breaks.
5. The ELAN/SayMore builders derive a WAV **only when the original is not already one**, and the
   EAF references whichever file ships beside it (`<Storyname>.wav`, or the
   `.converted-NOT-ARCHIVAL.wav` derived copy) — identical to the editor's local-save behaviour.
6. "Recording Package (with consent records)" becomes a CLIENT-SIDE zip built by the Files menu
   from whatever the folder holds, offered when consent artifacts or a recording are present.
7. Re-uploading a text whose title matches an existing folder yields `Folder (1)` — verified and
   ACCEPTED for that case only (it is no longer the every-upload behaviour). Document it.

8. **The Files menu READS the manifest instead of inferring** (Seth: *"the manifest file also helps
   us with the download menu"*). It replaces filename sniffing (`EXT_KIND`) + `latestPerKind`
   guessing for the source files: names them directly, reports which declared file has not arrived
   yet, sizes the conversions before a click (the big-file guard gets a real number instead of a
   download-then-discover), takes `vern`/`anal` from the manifest instead of a separate
   instance-settings fetch, offers the recording package only when consent artifacts are actually
   declared, and labels the source item by `origin`.
   **NO MANIFEST → ONE ITEM: "Open the Drive folder ↗"** (Seth, 2026-08-12: *"our fallback on the
   files menu for previously assigned texts should rather just point [to] the Google Drive folder
   for that text. That's good enough."*). Pre-manifest texts get a link, not a reconstructed menu.
   - This DELETES the heuristic path rather than carrying it: no `EXT_KIND` filename sniffing, no
     `latestPerKind` newest-per-kind guessing, no legacy zip extraction in the panel. Seth's
     reasoning, which is the durable part: *"the inferred menu has actually never worked correctly
     and it's not worth our time making it work correctly if it's just a fallback."* It is the
     machinery that earned the old Files menu its "all out of whack" reputation and got it parked
     behind `FILES_MENU_ENABLED = false` — debugging it now would be paying off a design that the
     manifest exists to replace. A folder link cannot be wrong.
   - `Researcher.listTextFiles` still supplies `folderId`, so the link is
     `https://drive.google.com/drive/folders/<folderId>` with no extra call.
   - Accepted consequence: a PRE-EXISTING text still being worked on keeps uploading new bare
     `.flextext` files, and those are reachable through the folder link rather than as a menu item.
   - Cleanup: `unzipStoreEntry` (zip.js) was added for the legacy read path and has no other
     caller — drop it with the heuristic unless something else claims it. `cleanupCandidates` /
     `latestPerKind` stay only if the cleanup feature still uses them.

**Build order:** upload shape (device lanes + worker + manifest writer + the spoken-prompt file
picker) → Files menu rebuilt on the new shape (manifest-first, heuristic fallback) → the six
downloads. Downloads testing is blocked until this lands.

## ⬛ v3 WORK ORDER — from the v336 / `assign-by-upload v2` test drive (2026-08-12)

Seth's v2 results: record ✅, assign ✅, edit+upload ✅ (bare `.flextext` lands in the text folder,
not `originals/`), consent prompt ✅, join/split ✅. Four items came out of it, in priority order.

**1. GIBBERISH EXPORT FILENAMES — fix first, it is one line of cause.**
Observed: `bwpX_YzJZRolHdh_.converted-NOT-ARCHIVAL.wav`, `….preview.html`, `….annotations.eaf`.
Root cause: every downloader names the file from the URL's LAST PATH SEGMENT
(`decodeURIComponent(url.split('/').pop()…)` — audio.js:104, :372, :536, :557). For an assigned
text the URL is `/v1/textfile/<token>`, so the name becomes the opaque token. Everything derived
downstream inherits it.
Fix BOTH ends:
  - At download, name the stored media from the story title (`<Storyname>.<ext>`, the same
    `sanitizeBase` + `extOf` rule the source package uses), falling back to content-disposition,
    and only then to the URL tail. A token must never become a filename.
  - At export, derive the base from the STORY TITLE, never from `media.name` — so a text whose
    media was stored under a bad name before this fix still exports correctly. Applies to the
    editor's local save AND the Files-menu conversions. Note `docFilename` already sanitises to 80
    chars while the source package uses 120: pick one rule and share it.

**2. BUILD THE FILES/DOWNLOADS MENU** on the manifest, per §8 above (manifest → six items;
no manifest → a single "Open the Drive folder ↗" link; the inferred menu is deleted).

**3. A PENDING UPLOAD MUST BE VISIBLE IN THE PANEL.** Seth: an edit-and-upload "just disappears
until the remote device loads it and then uploads it again". The panel should show a pending/in-
flight state the way it shows a pending delete, persisting until it lands or is cancelled. Compose
this with the deferred "Pending actions" modal (a History-like list of everything waiting on a
device to come online or a transfer to finish).

**4. CONSENT-PROMPT UPLOAD NEEDS PROGRESS, AND MUST NOT ERROR WHILE IT RUNS.** Today "push to
device" throws an error until the background upload finishes. Show uploading/percentage, and make
the push either wait for the upload or refuse with a clear "still uploading" state — never an error
that looks like failure when the thing is simply not done yet.

**Known issue, deliberately not blocking (Seth):** "It's only assigned flextext files that have no
timing in them that cause glitches with the baseline editor." An assigned flextext with no
`begin/end-time-offset` attributes seeds no spans, and the baseline strip view misbehaves. He is
willing to ship without this fixed; investigate when convenient. Test 6 (brand-new device gets
segmentation by default) was skipped in this round.

## Why

Assignments today ride hand-shared public Drive URLs. Live verification (2026-08-11, memory
`drive-second-use-bug-status`) proved the failure class — sharing state on reused/copied files,
link shapes, Drive interstitials, probe false-alarms surfacing as bare "NetworkError", duplicate
Storyname folders. Decision: retire pasted URLs entirely. The researcher picks the actual files;
the suite stores, delivers, and converts them. **The researcher never needs to open Google Drive,
and nothing is ever link-shared** — private, researcher-bound streaming tokens (the mechanism
move-text has used in production since v13x) replace public links.

## Locked decisions

1. `<input type="file">` fields replace the assign modal's URL inputs **entirely** (no fallback).
   The **consent PROMPT** also becomes a file upload (same mechanism; delivered through its
   existing settings-push URL field as a token URL). Old in-flight URL assignments keep working;
   the `/drive` proxy stays untouched.
2. Folder tree KEEPS the device level: `FlexText Uploads/<Device>/<Storyname>/` plus a new
   `assignment/` subfolder holding the assigned audio + flextext. Device uploads land in
   `<Storyname>/` itself. One folder per story.
3. Delivery: worker-minted private `/v1/textfile/<token>` URLs inside the byte-identical E2EE
   assign command. **TTL researcher-configurable**: default 90 days, clamped 7–400 server-side.
   TTL bounds only the initial claim/download; files persist in device IndexedDB forever once
   fetched.
4. **Upload policy — two lanes, replacing hold-until-finished:**
   - Lane A: recording + consent (prompt, response, receipt) upload **ASAP after recording
     finishes**, as ONE zip, via the existing connection-tolerant queue. Zips exist ONLY for this.
   - Lane B: flextext uploads are **bare `.flextext` files** (auto-backup copies and/or finished),
     never zipped. Assigned-from-Drive audio never re-uploads.
5. WS mismatch at assign: panel-styled two-button dialog naming BOTH sides — explicit
   **"Send anyway" / "Cancel"** (Cancel visibly aborts). Never remap, never hard-block.
6. Downloads item 1 is the ORIGINAL audio, byte-faithful, exact format as uploaded. Conversions
   (ELAN/SayMore WAVs) are additional derived copies, never replacements.
7. Panel ELAN export calls the SAME shared `serializeEaf` → structure identical to today's
   (paragraph tier mirrors phrase tier 1:1; mergeable, never needs splitting; no segnum).
8. **Assignment uploads get the same fault tolerance as device uploads**: absorbed into IndexedDB
   before anything else, persistent queue, chunked resumable sessions, resume on reconnect AND on
   panel restart, assign command sent only after upload finishes. A dropped connection can never
   produce a half-assignment.
9. Worker deployment rule: purely ADDITIVE changes may deploy straight to production; any change
   to an EXISTING endpoint is tested on the staging worker first (`[env.staging]` has the
   `routes = []` guard — still verify the deploy log lists only workers.dev).
10. Devices auto-update via the PWA service worker: no stuck old devices, no re-invites. Old
    engines during the update window degrade to today's semantics harmlessly.

## Architecture

```
ASSIGN:   panel file pickers → local probe + WS warn → worker (researcher-authed chunked upload)
          → Drive <Device>/<Storyname>/assignment/ → mint token URLs → E2EE assign command
          {title, audioUrl, flextextUrl, folderId} → device downloads via /v1/textfile (Range+resume)
UPLOADS:  Lane A voice+consent zip ASAP; Lane B bare flextext — both into <Storyname>/ via the
          existing install-authed path, folder id stamped from birth (dedupe search never runs)
EXPORTS:  panel lists folder → on-click client-side conversions → 6 downloads
```

### Verified code facts the build relies on (explored 2026-08-11 — trust, spot-check when editing)

- Command path: `assignModal` (researcher-panel.js:1929–2040) → `Researcher.assign` (researcher.js:371)
  → `pushCommand` `{type:'assign', id:docId plaintext, enc:E2EE(payload)}` → worker v1.js:1247
  (type allowlist :1256; payload opaque) → device sync.js:346–393 → `syncDispatch` 'assign'
  (app.js:3300–3306) → `openUrlTask` (app.js:2614). Unknown payload fields are ignored safely at
  every layer; never name a new field `id`/`type`/`seq` (they'd shadow at sync.js:383).
- **Root-cause defect to fix**: app.js:2618's background allowlist strips `task.docId`, so the
  panel docId is never adopted (`id: task.docId || newGuid()` at :2682 is dead code — the v137
  fix). This is why duplicate Storyname folders exist, and why moveTextModal's `>=138` gate
  (researcher-panel.js:2511) checks for behavior that isn't there.
- Drive writes happen ONLY in worker/src/v1.js, with the researcher's OAuth refresh token
  (encrypted in D1; `driveAccessToken` v1.js:326). Hierarchy: `driveMasterFolder` :383
  ("FlexText Uploads", tag `flextextRole='uploads-master'`), `driveEnsureDeviceFolder` :397,
  `driveEnsureTextFolder` :453 (tag `flextextDoc=<docId>`, tries knownId via files.get first,
  falls back to tag search `orderBy=createdTime`; deliberately NOT parent-scoped). v167 echo:
  worker returns folderId on upload responses (:1618/:1696); device stamps `rec.driveFolderId`
  (app.js:4147) and echoes via `x-fx-folder` (upload.js:159) / chunked-start `folderId`
  (upload.js:249). `assign-copy` (:1419) omits knownId (:1432) — retire for new assignments, keep
  the endpoint for old panels.
- Private delivery EXISTS: `GET /v1/textfile/<token>` (v1.js:578) — AES-GCM token `{r,f,x,e}`
  minted by the move endpoint's inline closure (v1.js:1399–1404, hardcoded 90d — parameterize),
  streams with the researcher's access token, forwards Range (206 verified), `no-store`, and has a
  zip-extract mode (`x:'flextext'`, `storeZipEntry`, 60 MB bound). moveTextModal
  (researcher-panel.js:2507–2553) already assigns these URLs — the shipped precedent.
- Device downloads: `resolveAudioInput` (app.js:3647) passes any https URL through untouched;
  `AudioDownload._runDirect` does Range+resume keyed on stable sourceUrl; `tryDownloadFlextext` →
  `fetchFileViaUrl`. Zero download-path changes needed.
- Device uploads: single zip per doc today, `buildBundleFor` (app.js:3784–3917) decides contents;
  `uploadDocById` (app.js:4003) sets identity/folder; wire formats upload.js:148–163 (single POST
  ≤16 MiB) and :244–249 (chunked); worker v1.js:1693/:1604. Device auth `x-fx-install`/
  `x-fx-secret` (sync.js:53). The derived-WAV re-upload leak for assigned texts is app.js:3837–3848
  (rides every EAF bundle regardless of `isAudioLocked`, app.js:1142).
- Conversion machinery (pure unless noted): seg-exports.js — `serializeEaf` :131 (profiles
  'flex'/'saymore'), `serializeEafPrefs` :319, `buildSegPreviewHtml` :352, `buildFxpa` :69,
  `wavWithBext` :660, `captureBext`, `fmtClock`, `peakPlan`; flextext.js — `parseFlextext` :167
  (DOMParser, fine in panel), `segmentsFromOffsets` :519 (spans from phrase begin/end-time-offset
  attrs; null when unaligned), `surveyWritingSystems` :731; zip.js `makeZip` :39 (STORE-only,
  pure); convert.js — `convertAudio` :322 (lossy→WAV needs AudioContext — fine in panel),
  `detectFormat` :154, `readWavHeader`, `parseWav`, `pickMono`, `validOutputs` (all pure);
  record-pcm.js `encodeWav` :325. The exact "uploaded flextext + audio, no live doc" precedent is
  paragraph-ui.js:184–199. `audioConverterModal` (researcher-panel.js:2815–2933) is the shipped
  file-picker→convert→download precedent, and the panel already imports convert.js + zip.js.
- KNOWN defect to dodge (or fix as a one-line drive-by): `loadLame()` convert.js:28 uses a
  page-relative src → MP3 ENCODE is dead in the standalone researcher app. This feature never
  encodes MP3, only →WAV. (flac.js:33's `import.meta.url` form is the correct pattern.)
- Panel listing/download plumbing EXISTS and works: `Researcher.listTextFiles` (researcher.js:341
  → v1.js:1345, `{folderId, files:[{id,name,size,mime,modified,role?}]}` newest-first),
  `Researcher.fetchDriveFile` (researcher.js:353 → Blob). Only the Files▾ UI is flag-parked:
  `FILES_MENU_ENABLED = false` (researcher-panel.js:1156). `EXT_KIND` :1178, `latestPerKind`
  :1183, `cleanupCandidates` :1234, `bridgedIds` :1202, `artifacts.js` (pure). This feature
  REPLACES that parked UI.
- WS validation EXISTS: `analyzeFlextextWs` + `WS_VERN_LABELS`/`WS_ANAL_LABELS` (app.js:3684–3697,
  only dependency `surveyWritingSystems`). Instance codes: `Researcher.getInstanceSettings`
  (researcher.js:409).
- Arrival progress data EXISTS: the audio downloader maintains received/total for Range-resume;
  `getDownload(docId)` (audio.js) exposes it. The "still arriving" row is app.js:401–405
  (`doc-arriving` class, `texts.arriving` i18n).

## Changes

### Worker — `worker/src/v1.js` only; no D1 schema changes

Additive (straight-to-prod eligible):
- Extract `mintTextfileUrl(env, urlOrigin, researcherId, fileId, extract, ttlMs)` from the move
  endpoint's closure; move endpoint calls it with the default TTL.
- `export function clampTtlDays(v)` — pure: absent/NaN → 90; clamp [7, 400]. Exported for tests.
- `driveEnsureChildFolder(access, parentId, name, role)` — PARENT-SCOPED tag search (`'{parent}'
  in parents … appProperties flextextRole='{role}'`), create on miss. Used with
  `name='assignment'`, `role='assignment'`. (Parent-scoped so a moved text folder carries it.)
- `relayDriveChunk(request, sess)` — extract from v1.js:1631–1660 (range validation, ≤33 MiB
  buffer, PUT to session, 308/200/404 mapping); device endpoint keeps its `sess.i === installId`
  check, researcher endpoints check a DISTINCT key `sess.rr === researcher_id` (session tokens
  must never cross routes).
- New researcher-authed endpoints (`authResearcher` + instance-ownership check, same as v1.js:1352)
  under `/v1/instances/<iid>/texts/<docId>/assignment/`:
  - `POST begin {title, folderId?}` → device folder → `driveEnsureTextFolder(access, deviceFolder,
    docId, title, body.folderId)` → `driveEnsureChildFolder(…,'assignment','assignment')` →
    `{folderId, assignmentFolderId}`.
  - `POST upload/start {name, mime, size, assignmentFolderId, kind}` → Drive resumable session
    with `parents:[assignmentFolderId]`, `appProperties.flextextRole = kind==='audio' ?
    'assigned-audio' : 'assigned-flextext'` (`assigned-audio` reuses assign-copy's exact tag so
    existing classification keeps working). Returns encrypted `{uploadId}`.
  - `PUT upload/chunk` → decrypt `x-fx-upload`, check `sess.rr`, `relayDriveChunk`. Same wire
    contract as device chunks (`x-fx-range`, 308 → `{done:false,received}`, 200 →
    `{done:true,fileId}`, `session_gone`).
  - `POST finish {audioFileId?, flextextFileId?, ttlDays}` → `clampTtlDays` → mint →
    `{audioUrl?, flextextUrl?}`. Optionally `logApproval(… 'assigned_upload' …)`.
- Consent-prompt upload reuses the same start/chunk/finish mechanism targeting the DEVICE folder
  (kind `'consent-prompt'`, role `'consent-prompt'`); the settings push carries the minted URL in
  the existing prompt-URL field.

Modification (STAGING-WORKER-TESTED FIRST, per rule 9):
- Files listing (v1.js:1345): filter folder rows out of `files[]`; if an `assignment` child
  exists, list it too and merge (each file keeps its `role`); return `assignmentFolderId`.
  Newest-first across the merge. Additive JSON fields — old panels ignore.

### Device — `docs/js/app.js` (+ upload queue)

1. app.js:2618 background allowlist: add `docId: task.docId, folderId: task.folderId`. THE
   load-bearing dedupe fix.
2. `syncDispatch` 'assign' (~:3302): forward `cmd.folderId`; set `task.assigned = true`.
3. `openUrlTask` new-rec (~:2682) + replace branch (~:2650): stamp `rec.driveFolderId` and
   `rec.assigned`. The existing upload echo does the rest — zero wire changes.
4. **Two-lane upload split** (ships the v317 per-kind backlog; the one structural device change):
   - Lane A `upload-media:<docId>`: queued the moment a recording is saved — one zip of recording
     + consent clip + consent prompt + receipt, via the existing tolerant queue/backoff.
   - Lane B `upload:<docId>`: bare `.flextext` (no zip) on auto-backup and finish.
   - `buildBundleFor` upload path: assigned/locked → no seg exports, no audio (kills the
     derived-WAV leak); pass the ORIGINAL media name (not segMediaName) to `serializeDocBlob`
     when the rule fires. `opts.full` local saves byte-identical to today.
   - Queue records must stay backward-readable: an in-flight old-format entry still uploads after
     a mid-queue engine update.
5. **Arrival progress on the text tile**: while `pendingAudio` is downloading, the `doc-arriving`
   row shows a progress bar/percent from `getDownload(docId)` (received/total), refreshed by a
   light ticker only while a download is active.

Back-compat: old engines ignore the new payload fields and already consume `/v1/textfile` URLs
(the moveText path). New panel + old worker: `begin` 404s → assignment blocked loudly, nothing
half-sent. Old panel + new worker: URL path + assign-copy still work.

### Panel — `docs/js/researcher-panel.js`, `docs/js/researcher.js`

- Pure moves (NO new SHELL entries — all target modules already precached in the editor and every
  satellite sw.js; verify with grep before relying on it):
  - `analyzeFlextextWs` + label sets → flextext.js (app.js imports back).
  - Extract `assembleSegEntries({doc, title, media, segMedia, wants:{eaf,saymore,preview,fxpa},
    vern, anal, full}) → entries[]` from app.js:3810–3884 → seg-exports.js. buildBundleFor and the
    panel both call it. A parity test pins against drift.
  - `blobToBase64` → seg-exports.js (kills the app.js:3988 / paragraph-ui.js:621 duplication).
  - `unzipStoreEntry(buf, nameRe)` added to zip.js (client twin of worker `storeZipEntry` —
    LEGACY read path only, for extracting flextexts from pre-existing bundles).
- Assign modal rework (researcher-panel.js:1929–2040): file inputs (audio accept audio/* + common
  extensions; flextext accept .flextext,.xml); ≥1 required; DELETE `probeAudioUrl` usage, softWhy,
  the soft-CORS confirm ladder, and the `assignCopy` call. Local pure probe `assignAudioVerdict
  ({buf, name, size})` (detectFormat: block AIFF, oversize, obvious non-audio). Flextext:
  `parseFlextext` single-text rule + `wsAssignMismatch(analysis, instanceCodes)` → the two-button
  Send-anyway/Cancel dialog.
- **Resilient sends**: absorb picked Files into panel IndexedDB first; persistent
  `assign-upload:<docId>` queue record; chunk loop modeled on upload.js `_streamChunked` (8 MiB
  slices, 308-resume, `session_gone` restart, backoff, resume on `online` + on panel restart);
  assign command sent ONLY after `finish` succeeds; modal + dashboard show queued/uploading
  N%/sent; exhausted retries surface loudly with a retry action; records inspectable/cancellable.
- TTL setting: per-account localStorage key (pattern `STALE_WATCH_KEY`, :829), numeric days field
  in the utilities/settings modal; server clamp authoritative.
- Downloads section: flip `FILES_MENU_ENABLED` (:1156); rewrite `populateFilesMenu` (:1239–1357)
  into the fixed 6-item list sourced from the merged+roled listing across `bridgedIds`:
  1. Original audio (`role:'assigned-audio'`) — `fetchDriveFile`, byte-faithful.
  2. Most recent flextext — newest of `assigned-flextext` role / bare uploaded `.flextext` /
     (legacy only) extracted from newest bundle via `unzipStoreEntry`.
  3. ELAN zip — parseFlextext → `doc.segments = segmentsFromOffsets(doc) || []` → audio→WAV via
     `convertAudio` if non-WAV → `assembleSegEntries {eaf}` → `makeZip` (Title.eaf + Title.pfsx +
     media WAV; EAF references the WAV by name).
  4. SayMore zip — same with `{saymore}` (`<media>.annotations.eaf` + WAV).
  5. Preview HTML (embedded audio). 6. `.fxpa` (embedded audio; text-only when unaligned).
  On-click only, one at a time, progress + size guards, per-menu-open byte cache. vern/anal from
  instance settings, falling back to the parsed doc's codes. Extend `EXT_KIND`/`latestPerKind`
  (`assigned-flextext` → its own kind) and `cleanupCandidates` (NEVER propose assignment-role
  files). `moveTextModal` needs no changes (folder re-parent carries `assignment/`).
- researcher.js: `assignBegin/assignUploadStart/assignUploadChunk/assignFinish` + the chunk loop
  (raw fetch with `x-fx-researcher`/`x-fx-secret`, the `fetchDriveFile` precedent — `api()` is
  JSON-only). ~80 lines.
- i18n: every new string in BOTH en and id (parity test enforces); delete dead keys (urlPh,
  checkingAudio, couldNotVerify family); update researcher help pages (help-doc-accuracy test).

## Tests (plain node, zero deps, `for f in test/*.test.mjs; do node "$f"; done`)

New:
- `assemble-seg-entries.test.mjs` — entry coverage per `wants` combination; upload-vs-full parity;
  source-lift assertion that buildBundleFor actually calls the shared function.
- `assignment-ttl.test.mjs` — `clampTtlDays` direct import (worker-email-domain precedent):
  absent→90, floor 7, ceiling 400, garbage→90.
- `assign-modal-verdicts.test.mjs` — source-lift `assignAudioVerdict` + `wsAssignMismatch`
  (text-folder-files technique): AIFF/oversize/non-audio block; WAV/MP3 pass; mismatch names both
  sides; matching codes pass; missing snapshot → silent skip.
- `assign-intake.test.mjs` — regex-pin that the app.js:2618 allowlist carries `docId` and
  `folderId` (this exact line silently broke once), and syncDispatch forwards `folderId`.
- `upload-lanes.test.mjs` — Lane A fires on recording save; Lane B is a bare flextext; assigned
  audio never rides an upload.
Extend `text-folder-files.test.mjs`: new roles; folder rows never classified as files; cleanup
exclusions. Existing gates: i18n-parity, version-sync, seg-exports, help-doc-accuracy,
command-seq-invariant, audio-converter.

## Phases with gates

0. (done at branch creation) Fresh branch from main a2b2655; this spec committed.
1. Pure extractions + device edits 1–3. Gate: full suite green + local-save bundle entry-name
   parity spot-check.
2. Worker helpers + additive endpoints; the listing change flagged for staging-first testing.
   Gate: ttl/lift tests; live curl sequence begin→start→chunk×N→finish→`GET /v1/textfile` with
   `-r 0-99` → 206, against `npx wrangler dev` (Miniflare local D1 — seed a researcher row; no
   cloud resources needed).
3. Panel assign path + consent-prompt upload + resilient queue. Gate: end-to-end on the local rig
   — assign → device adopts docId, stamps folderId, downloads via tokens, edits, uploads → ONE
   Storyname folder with `assignment/` + bare flextext (+ media bundle if recorded). Resilience:
   kill the connection mid-upload → queue persists; reload panel → resumes, completes, assign
   command sends itself.
4. Downloads menu. Gate: all 6 items produce correct files; EAF↔WAV naming; fxpa opens in PAT.
5. Two-lane upload split + arrival progress bar. Gate: lanes behave; local saves unchanged; suite
   green.
6. i18n sweep, help docs, `./bump-version.sh vNNN`, merge `--no-ff` → staging (deploy staging
   worker FIRST via `worker-wrangler.yml` `deploy --env staging`, verify the log lists ONLY
   workers.dev, then push staging — spaced, never together with main). Seth test-drives with
   `?devworker=staging`. Production only after his explicit sign-off: worker deploy (additive) →
   runbook order → satellites.

## Risks

- Panel conversion memory: decodeAudioData + base64 embeds on huge files — size/duration guards;
  refuse above ~200 MB decoded-estimate with "download the original instead".
- Expired-token 401 on the device must classify as PERMANENT (no infinite retry) — verify in
  Phase 3; remedy is re-assign.
- `/v1/textfile` has no edge cache (private by design) — accepted; moveText lives with it.
- Orphaned assignment files on abort between upload and send — harmless (researcher's own Drive);
  optional best-effort trash.
- The Lane A/B queue split is the one device area needing real care; keep queue records
  backward-readable.

## Backlog (recorded, NOT in scope)

- Bloom upload (SIL literacy/shell-book library publishing).
- OneStory Editor injection — write a non-biblical story INTO a `.onestory` project; XML knowledge
  in `/Users/Seth/GIT/ose-interlinear-viewer`.
- Separate audio-segmenting/matching satellite app (adds segmentation to EXISTING texts; NOT mixed
  into the editor; PAT satellite pattern is the model).
- Re-mint-links action on the files menu; Google Picker composing on top of this design.

## Build log (build session, 2026-08-11 — Claude, autonomous overnight run)

Phases 1–5 built in order, each committed with the full suite + eslint + native-containment green
(`7922d26` P1, `d1be514` P2, `b24be93` P3, `54c2a95` P4, `4fd58fa` P5, then the i18n/help sweep).
No version bump, no deploys, no merges — all reserved for the morning session per the brief.

### Done per phase

- **P1** — extractions landed exactly as mapped: `analyzeFlextextWs`+label sets → flextext.js;
  `assembleSegEntries`+`howToOpenText`+`blobToBase64` → seg-exports.js (blobToBase64 rewritten
  FileReader-free so the format module stays node-testable; paragraph-ui's `blobToB64` duplicate
  deleted); `unzipStoreEntry` → zip.js. Device edits 1–3 in: the :2618 allowlist now carries
  `docId`, `folderId` **and `assigned`** (see deviations), syncDispatch forwards folderId + marks
  assigned, openUrlTask stamps `driveFolderId`/`assigned` in both branches. Tests:
  assemble-seg-entries (wants coverage, upload-vs-full parity, source-lift), assign-intake.
- **P2** — worker: `clampTtlDays` (exported), `mintTextfileUrl` (move endpoint now calls it),
  `driveEnsureChildFolder` (parent-scoped), `relayDriveChunk` (device endpoint refactored onto it;
  researcher routes check the DISTINCT `sess.rr` key), the four assignment endpoints
  (begin / upload/start / upload/chunk / finish, consent-prompt kind targets the device folder),
  and the files-listing merge (folder rows filtered, assignment/ child merged newest-first,
  `assignmentFolderId` returned) — that one flagged in-code as STAGING-FIRST per rule 9.
  Test: assignment-ttl (clamp + full begin→start→chunk×2→finish→`GET /v1/textfile` Range→206 flow
  against a fake Drive fetch + fake D1, incl. cross-route token refusal, expired-token 401, and
  the listing merge).
- **P3** — assign modal reworked to file pickers (probe/soft-CORS ladder + assignCopy call
  deleted); pure `assignAudioVerdict` + `wsAssignMismatch` with the two-button Send-anyway/Cancel
  dialog; resilient queue (`assign-upload:<docId>` IndexedDB records with blobs, single-flight
  runner, begin→chunked uploads→finish→ONLY THEN `Researcher.assign` carrying token URLs +
  folderId; resume on panel restart + `online`; transient→requeue, 4xx→loud error with Retry;
  dashboard card inspect/cancel). researcher.js gained
  assignBegin/assignUploadStart/assignUploadChunk/assignFinish + the 8 MiB chunk loop with
  persisted session tokens. Consent-prompt upload button on the settings form fills the existing
  `consentAudioUrl` field with the minted URL. Per-account TTL field in Utilities. Test:
  assign-modal-verdicts.
- **P4** — `FILES_MENU_ENABLED = true`; populateFilesMenu rebuilt around the fixed six items with
  on-click client-side conversions (parseFlextext → segmentsFromOffsets → convertAudio to 16-bit
  WAV when lossy, same `.converted-NOT-ARCHIVAL.wav` name + bext → the shared assembleSegEntries →
  makeZip), one-at-a-time, per-menu-open byte cache, ~200 MB decoded-estimate guard. EXT_KIND
  role kinds + cleanup exclusions for all assignment roles. Tests: text-folder-files extended,
  assignment-ttl listing section, artifact-links updated (flag now pinned ON — see deviations).
- **P5** — Lane A `upload:media:<docId>` media+consent zip queued at recording save (linked
  devices only) with a catch-up in uploadDocById for pre-split texts; completion stamps
  `mediaUploaded` + folder echo only, never the text's backup proof, docDone pinned false. Lane B:
  buildBundleFor's non-full path returns the BARE `.flextext`; assigned/locked reference the
  ORIGINAL media name. upload.js sends `rec.docId || this.docId` (old queue records
  backward-readable). Arrival progress bar on the text tile from `getDownload()`'s
  received/total, 1 s ticker only while a download moves. Test: upload-lanes.
- **P6 (i18n part only)** — every new string in en AND id; dead keys removed (urlPh,
  checkingAudio, checkingFlextext, couldNotVerify, whyBlocked, whyTimeout, needUrl, the old
  audio/flextext link labels); panel help HTML's "Assign a text" bullet rewritten in both
  languages. Bump + staging merge deliberately NOT done.

### Untested by construction (needs the live rig / morning session)

- Everything against REAL Drive/OAuth: the harness fakes Drive's resumable sessions, 308 Range
  answers and alt=media; Google's actual behaviour (session lifetimes, interstitials, quota) is
  only exercised live.
- The P3 gate end-to-end: assign → device adopts docId, stamps folderId, downloads via tokens,
  edits, uploads → ONE Storyname folder with assignment/ + bare flextext; kill-connection
  mid-upload → queue persists; panel reload → resumes and the assign command sends itself.
- The P4 gate: all six items against real files; in-browser decodeAudioData; EAF↔WAV naming in
  ELAN/SayMore; the .fxpa opening in PAT.
- The P5 gate: lanes on a real device; a byte-level spot-check that `opts.full` local saves are
  identical to v333 (the test pins entry names/content parity, not whole-zip bytes).
- The device classifying an expired-token 401 as PERMANENT (spec risk) — verify on the rig.
- All new UI (modal, dashboard card, TTL field, consent-upload button, arrival bar) has never
  been rendered in a browser this session.
- The staging-first rule for the LISTING change stands: deploy the worker to staging and test the
  panel against it BEFORE any production worker deploy.

### Deviations from the spec, with reasons

1. **`assigned` added to the :2618 allowlist and the assign dispatch** (spec named only
   docId/folderId): syncDispatch sets `task.assigned` but the allowlist strip would have dropped
   it before the openUrlTask stamp — the exact v137 trap the spec warns about, one field over.
2. **`assembleSegEntries` takes an explicit `base`** alongside `title`: the filename base is
   sanitized differently from the display title, and deriving it inside the module would have
   duplicated docFilename's rule (drift risk both ways).
3. **The assign modal closes after queuing** (toast + the dashboard card carry queued/N%/sent)
   instead of showing live progress inside the modal — the card is the single live surface, and
   the modal's job (validate, absorb) is done at that point.
4. **Lane B is the bare flextext for ALL texts**, not only assigned ones — locked decision 4 says
   zips exist ONLY for Lane A and flextext uploads are never zipped, so seg exports no longer
   ride ANY upload; the Downloads menu builds them on demand (that is what it is for). The
   "assigned/locked → no seg exports" bullet is thereby subsumed. Flagging for Seth since the
   Changes bullet could be read as assigned-only.
5. **The Downloads menu keeps the legacy fill rows** (report artifacts, history fileId last
   resort) after the six fixed items: they only fire for kinds nothing else claimed, legacy texts
   keep their coverage, and artifact-links.test.mjs pins that machinery.
6. **artifact-links.test.mjs was updated**: it pinned `FILES_MENU_ENABLED = false` — the exact
   state this feature un-parks. The one-flag/one-predicate chokepoints stay pinned; only the
   flag's value assertion flipped.
7. **The consent-prompt upload uses the assignment routes with a placeholder docId path segment**
   ('consent-prompt'): the worker ignores the segment for that kind (a prompt is per-device).
   A dedicated route would have duplicated start/chunk/finish for one caller.
8. **The P2 gate's live-curl-against-wrangler-dev was replaced** by the module-level fake-Drive +
   fake-D1 harness (drive-cache-integrity/worker-seclog pattern) — no Google credentials in this
   session, per the build brief.
9. **task.badAudio / task.badFlextext / task.ftFetchFailed / task.checkFailed kept** although now
   unreferenced: the spec's deletion list named the urlPh/checkingAudio/couldNotVerify family
   only, and pruning beyond it felt like scope creep for a review session to confirm.

### Morning-session checklist (in order)

1. `worker-wrangler.yml` → `deploy --env staging`; read the deploy log and verify it lists ONLY
   workers.dev routes (the `[env.staging]` routes=[] guard).
2. Optional: seed the staging D1 with a researcher row if testing against a fresh DB (no schema
   changes were made — no migration needed).
3. Local rig e2e (`./devctl.sh start`, panel on :8012): run the P3/P4/P5 gates listed above,
   including the resilience kills. Verify expired-token 401 classifies permanent on the device.
4. Review the new Indonesian strings (drafted this session, not native-checked).
5. `./bump-version.sh vNNN` (docs/ changed → all version sites together; no new SHELL entries
   were added anywhere — verified by the untouched sw.js files).
6. Merge `--no-ff` → staging, SPACED from any main push; Seth test-drives with
   `?devworker=staging`.
7. Production only after explicit sign-off, runbook order: worker deploy (additive endpoints are
   straight-to-prod eligible; the files-listing CHANGE must have passed its staging test) →
   editor `productionWeb` → satellites.

## Build log — v3 (2026-08-12, Claude session)

All four work-order items built in priority order, each committed with the full suite + eslint +
native-containment green. Bumped to **v337**, `BUILD_TAG = 'assign-by-upload v3'`, merged `--no-ff`
into `staging` for Seth's test drive. No worker deploy, no Actions dispatch, no production branch
touched.

### Done, per item

**1. Gibberish export filenames — fixed at BOTH ends** (`1602ef5`).
The root cause was as diagnosed: every downloader named its file from the URL's last path segment,
which for `/v1/textfile/<token>` is the token. Fixed at download AND at export, because either alone
leaves half the field broken.
- **Download** (`audio.js`): precedence is story title → a server-STATED filename (relay envelope /
  Content-Disposition) → the URL tail. `nameFromUrl` refuses the `/v1/textfile/` route outright (it
  is a token by construction, whatever the segment looks like) and refuses any tail with no
  plausible extension. `AudioDownload._complete` is the single chokepoint every completion path goes
  through, so a partial persisted by a pre-v3 build heals simply by finishing.
- **Export** (`seg-exports.js`, `app.js`, `researcher-panel.js`): names derive from the TITLE base,
  never off the stored media record. **This is what makes the fix retroactive** — a text assigned
  before v3 still has the token in IndexedDB and now exports correctly anyway, no migration, no
  re-download. Worth keeping in mind if this code is ever "simplified".
- The EAF's media reference and the WAV entry beside it come from the same derivation, so they
  cannot disagree. Fixing only one side would have produced a tidy-looking bundle ELAN cannot open —
  a worse failure than an ugly name. The bext chunk still names the REAL source file: renaming for
  tidiness must not launder provenance.
- `sanitizeBase`/`extOf` moved to `seg-exports.js` beside `MANIFEST_NAME`, for the reason stated
  there. That settles the work order's 80-vs-120 question at **120**, which is also the worker's
  Drive folder rule, so `<Storyname>.<ext>` and `<Storyname>/` cannot disagree.

**2. Files menu on the manifest; inferred menu deleted** (`f926028`, `0e4c1a1`).
Two states, as specified: manifest → the fixed item list; no manifest → ONE item, "Open the Drive
folder ↗". Deleted: `EXT_KIND`, `latestPerKind`, the panel's legacy zip reading, `unzipStoreEntry`
(zip.js), the `resolveArtifacts` fill rows, the history-fileId last-resort row, and
`assignedCache`/`assignedFor` (orphaned by the fallback row's removal).
What the manifest buys beyond not guessing: a declared-but-absent file is NAMED ("not uploaded yet")
plus a summary of what is still to arrive, with completeness DERIVED from declared-vs-present and no
stored flag to go stale; conversions carry a real size estimate before the click; writing systems
come from the package rather than a second `getInstanceSettings` round trip; item 1 is labelled by
`origin` (an unknown origin degrades to its raw value, never a raw i18n key); the recording package
appears only when consent artifacts are DECLARED.

**3. A sent assignment stays visible** (`0fe8044`).
The gap was after the upload queue's record is deleted: the assign command is sent and then nothing
is on screen until the device reports the text. Composed into `pendingCmds` as `kind: 'assign'`,
carrying the Worker seq, set BEFORE the queue record is deleted, retired by the inventory FACT of
the text appearing. Rendered as a synthesized row through the SAME renderer as every other text, so
it reads "the way a pending delete reads". Cancel while queued (seq > ack_seq) reuses the existing
seq-checked `cancelCommand`; once taken it says so instead of offering a cancel the Worker would
refuse. The deferred "Pending actions" modal composes on top: everything waiting is now one
persisted, seq-bearing marker map.

**4. Consent-prompt upload: progress, and Save stops erroring** (`f7572fd`).
`assignUploadFile` had accepted an `onProgress` callback all along and this caller never passed one.
It now paints a real percentage plus a distinct "Finishing…" state for the URL-minting round trip
after the last chunk. An in-flight flag (cleared in a `finally`) makes Save refuse plainly —
"still uploading (N%) — nothing has gone wrong" — instead of running validation that correctly
reports a not-yet-filled required field and incorrectly makes it look like a failure.

### Deviations from the brief, with reasons

1. **`BUILD_TAG` WAS edited** to `'assign-by-upload v3'` (the brief reserved it for the release
   session). Seth authorised the bump mid-session for a staging test drive, and per CLAUDE.md the
   tag exists precisely so the on-screen badge answers "am I testing the right build?" — leaving it
   at `v2` while test-driving v3 work would actively mislead. Trivially reverted if unwanted.
   `ENGINE_VERSION` stayed numeric (`v337`), so the `engNum` capability gates are unaffected.
2. **The whole of the inferred menu went, not only the three named pieces.** The work order named
   `EXT_KIND`, `latestPerKind`, the legacy zip read and `unzipStoreEntry`. The `resolveArtifacts`
   fill rows and the history-fileId row had to go too: the spec defines exactly two menu states and
   neither has a place for a device-REPORTED artifact. `artifact-links.test.mjs` was inverted to pin
   them as absent.
3. **`cleanupCandidates` was REWRITTEN, not merely detached from `latestPerKind`.** §8 said those
   helpers "stay only if the cleanup feature still uses them", which would have kept the deleted
   heuristic alive inside a destructive operation. Instead it now lists what MAY GO (older bare
   `.flextext` backup copies) rather than subtracting what must stay — so a role it has never heard
   of is kept by default. ⚠ The old form derived "keep" from the extension table, so deleting that
   table could have silently WIDENED what cleanup proposes to trash. That is the single most
   dangerous edit in this session and it is why `text-folder-files.test.mjs` is mostly about it.
4. **`artifacts.js` is left in place though the panel no longer imports it.** It is pure and still
   tested; deleting it would touch every satellite `sw.js` SHELL for no gain, and SHELL edits were
   out of bounds. **Retiring it is Seth's call.**
5. **`moveTextModal` keeps a legacy `.zip` pick.** The panel no longer reads zips, but the WORKER
   still extracts a `.flextext` from one server-side for a legacy move, so the selection had to
   survive somewhere. It is scoped to that one call site and commented as such.
6. **A pending assign is NOT recorded on the move path.** `moveTextModal` already shows its own chip
   via `pendingMoves`; two markers for one wait is worse than none.
7. **The empty-inventory short-circuit was removed** (`inv && inv.length ? inv.map(...)`). It had to
   go for item 3 or a brand-new device's FIRST assignment — the likeliest moment for the feature to
   matter — would still have rendered "no texts yet".

### Untested by construction — needs the live rig

- **Nothing in this session ran in a browser.** Every new surface (the rebuilt Files menu, the
  pending-assign row and its chips, the consent upload's percentage, the Save refusal) has only ever
  been exercised as source, or through lifted-function harnesses with a fake DOM.
- **Item 1's download half needs a real assigned text.** The tests prove the naming rule and prove
  the wiring is present, but the actual `/v1/textfile/<token>` fetch → stored media record → export
  chain has not run against the real worker. **This is the one to test first**, because it is the
  reported bug: assign a text with audio, let the device fetch it, then save locally and confirm the
  zip contains `<Storyname>.<ext>`, `<Storyname>.converted-NOT-ARCHIVAL.wav` and
  `<Storyname>.preview.html` — no token anywhere.
- **The retroactive path is worth a separate check**: open a text that was assigned under v336
  (whose stored `media.name` IS a token) and export it. It should come out clean without
  re-downloading. That is the half a re-download would mask.
- **Item 2 against real Drive folders**: a v2 text (manifest present → the item list, sizes, origin
  label) and a pre-v2 text (no manifest → exactly one folder link). Also the "declared but not
  arrived" row, which needs an upload caught mid-flight.
- **The recording package** has never been built from a real folder.
- **Item 3's timing** only shows against a device that has NOT polled — a device that checks in
  immediately looks identical with or without the fix.
- **Item 4's percentage** needs a prompt file big enough to take more than one 8 MiB chunk.
- **The staging-first rule for the files-LISTING worker change still stands** and is unchanged from
  v2: it was flagged in-code then and has not been deployed or tested since.
- The new Indonesian strings were drafted here, not native-checked.

### Remaining steps for Seth's next session, in order

1. **Deploy the worker to staging** (`worker-wrangler.yml` → `deploy --env staging`) and read the
   log for workers.dev-only routes. The v2 files-listing change has still never been tested against
   a real Drive; everything in item 2 reads its output.
2. **Test drive staging** with `?devworker=staging` — the badge should read `v337 · assign-by-upload
   v3`. Priority order matches the work order: filenames first (incl. the retroactive case), then
   the Files menu's two states, then the pending-assign row, then the consent upload.
3. **Review the Indonesian strings** added this session (`panel.dl.*`, `panel.up.assign*`,
   `panel.f.consent*`).
4. **Decide on `artifacts.js`** — retire it, or leave it as a pure module with no caller.
5. Production only after explicit sign-off, runbook order: worker deploy → editor `productionWeb` →
   satellites. **Clear `BUILD_TAG` to `''` before any production release** (`bump-version.sh` warns
   while it is set).

### Recorded during this session, deliberately NOT built (see `plans/BACKLOG.md`)

Four items Seth raised mid-session, all explicitly deferred by him to a future cycle: Google Drive
storage footprint; the Drive API answer for a quota readout + cleanup (incl. the finding that
**today's cleanup reclaims no space until the trash is emptied**, since `usageInDriveTrash` counts
inside `usage`); a Drive-side text inventory modal with per-text remove and the same Files ▾; and an
"unassigned" holding place with moves in both directions.

## Build log — v3.1 (v338, `assign-by-upload v4`)

Seth's review round on v337. Both items were real; one was a bug in my v3 work.

### Download-all now builds and injects the exports (Seth: "Is that possible?")

Yes, and it is done. `Download all (ZIP)` now carries the folder's raw bytes PLUS a freshly built
ELAN `.eaf` + `.pfsx`, the SayMore `.annotations.eaf`, the derived WAV, the listening page and the
`.fxpa`.

The design point worth keeping: they are built by the **same** `prepareConversionSources` +
`assembleSegEntries` the individual menu rows use, extracted for this purpose. Two code paths each
producing "the ELAN export" would drift, and the researcher would have no way to tell which one they
got.

⚠ **The degradation rule is the load-bearing part.** The raw bytes are what was actually asked for;
the generated files are a bonus, and a bonus must not be able to take the request down with it — the
failure modes (audio too big to decode in a tab, no alignment, an unparseable flextext, an outright
throw) are exactly the texts where a researcher most needs the originals. Every one of them still
delivers the folder zip and explains what was skipped. `drive-download.test.mjs` asserts each case.
Name clashes with a real folder file are disambiguated, never overwritten: one copy is the
researcher's own file, the other is built from the current flextext, and silently losing either
would be bad.

### The 0%-then-finished upload — my bug, now fixed at the cause

Seth's assumption was right and the code was wrong. `assignUploadFile` was modelled on the device's
`upload.js _streamChunked` but had flattened its adaptive sizing to a **fixed 8 MiB**, which caused
two problems sharing one cause:

1. `onProgress` fires once per COMPLETED chunk, so any file under 8 MiB — every spoken consent
   prompt — was a single chunk and reported nothing until it was already done.
2. **A failing chunk retried at the same size**, which on a weak field connection is the one thing
   you must not do. The device path halves on failure precisely because of this. This half was never
   visible in the test drive and is the more important fix.

Now the same AIMD as `upload.js`: 256 KiB granularity (**Drive requires multiples of 256 KiB for
every chunk but the last** — a naive "use smaller chunks" fix would 400 on the *second* chunk, so it
would pass any single-chunk test and fail only on big uploads), doubling under 15 s, halving on
failure or over 60 s, ceiling 8 MiB (the old fixed size), and a size-aware opening guess aiming at
~8 slices so a small file shows movement immediately. A resumed upload now paints its true offset
instead of starting the display at zero.

`assign-chunk-policy.test.mjs` drives the REAL loop against a fake transport (researcher.js imports
cleanly under node once its worker base and auth storage are supplied).

### Answers to the questions asked

- **The three "worth your attention" items were heads-ups, not decisions**, except one: whether to
  retire `artifacts.js` (now unimported by the panel). That is optional and can wait indefinitely.
- **Production version handling is unchanged and correct.** `bump-version.sh` remains the only way
  versions move; `ENGINE_VERSION` is numeric `vNNN` (v338) so the `engNum` capability gates parse it;
  `docs/sw.js` VERSION equals it, which is what makes installed PWAs fetch a new shell; each
  satellite bumped its own VERSION and declares `ENGINE = 'v338'`, enforced by `version-sync`.
  **The ONLY production-specific step is clearing `BUILD_TAG` to `''`** — `bump-version.sh` prints a
  warning while it is set, and the badge shows it on screen, so a tagged build reaching production
  announces itself.

### ⚠ Correction to the v3 checklist: NO WORKER DEPLOY IS NEEDED

The v3 build log's step 1 said "deploy the worker to staging first". That is **stale**. Verified by
`git diff cf4c77c..HEAD -- worker/`: **zero worker changes** across all of v3 and v3.1. Everything
built in these two rounds is client-side (`docs/js/`). The v2 worker — including the files-listing
merge that carried the staging-first flag — was already deployed to both staging and production
before this session began, and Seth's v336/v337 test drives exercised it (assign, upload and the
Files menu all read that endpoint).

So the release is an ordinary editor release: bump (done), staging test, clear `BUILD_TAG`, ff to
`productionWeb`, satellites. No D1 migration, no worker step.

### What still needs a human, in priority order (v338)

1. **⚠ Assign a text with an audio file big enough to need SEVERAL chunks (5–20 MB).** Highest risk
   in this round: the adaptive chunking is on the ASSIGN CRITICAL PATH (`assignUploadFile` carries
   the manifest, the audio and the flextext, plus the consent prompt), it is new code, and it has
   never touched real Drive. Drive itself enforces the 256 KiB rule, so a mistake is a 400 on the
   *second* chunk — invisible on any small file. The percentage moving IS the evidence that more
   than one chunk was sent.
2. **Download-all on a text with aligned audio.** New, never run in a browser, and the only
   memory-heavy path (decode + base64 in the panel). Confirm the zip holds the folder's files plus
   the generated ELAN/SayMore/listening/`.fxpa`, and that ELAN opens the EAF and finds its WAV.
3. **Re-check the four individual conversion rows** (ELAN, SayMore, listening page, `.fxpa`). They
   worked in v337, but v3.1 REFACTORED them onto the shared `prepareConversionSources` — so code
   already signed off has moved underneath. Cheap to verify alongside (2).
4. **The retroactive filename case.** Open a text assigned under v336 — whose stored media name IS
   the token — and save/export it locally WITHOUT re-downloading the audio. It should come out
   clean. Easy to miss by accident: re-downloading first would let the download-side fix mask
   whether the export-side fix works, and the export side is what rescues every text already in the
   field.
5. **A pre-v2 text's Files menu** (no manifest) — exactly one item, "Open the Drive folder".

Lower value, test only if convenient: the recording package; the "not uploaded yet" row (needs an
upload caught mid-flight); the pending-assign row against a device that is actually offline.
