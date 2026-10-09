# Move, adopt, cleanup and upload guards

**Status (2026-10-10): BUILT on `fix/move-upload-guards`** — G1a/b, G2, G3, G4, G5, the panel half
of finding 9, and a post-move flag in place of G1c. **Not built, by decision:** G1c (the source keeps
a text changed after the move) and the plan-only items in §8. Cut from `main` at v716 (= production).
No worker change, no D1 change, no new module or top-level import, no SHELL change. No version bump
and no RELEASES entry on this branch: one bump for the whole set at release time, then a beta soak
(it touches sync, moves and uploads, so it is not a "small self-contained change"). G4 (device) and
G1's handling of untouched deliveries (panel) must ship in the same release — they do, here.

The first version of this document was reviewed twice before anything was built (a verdict and an
adversarial pass). Their findings are folded in below, and §6 lists every case they raised with
what was done about it.

## Why

A read-only investigation of a real researcher Drive estate, confirmed by an adversarial pass,
found that a text's transcription can go backwards without anyone pressing anything that says
"delete". The raw evidence stays in local notes; what matters here is the mechanism:

| # | Finding | Confirmed effect |
|---|---|---|
| 1 | Move and adopt delivered Drive's NEWEST `.flextext` in the text folder, not the source device's current state. The source's `uploadState: 'changed'` and `uploadedFileId` were ignored, and the move's release (`uploadDelete`) then uploaded the source's final copy AFTER the destination already received an older one. | A text with 25 lines of transcription went back to its 4-line state on the new device; a text cut into 32 lines was replaced by an empty doc. |
| 2 | Files ▾ "Clean up old backups" kept only the newest file by Drive `modifiedTime` — across every same-title folder the bridge pulled in. | On that estate it would have trashed the good copy of several texts. |
| 3 | The legacy title bridge (`bridgedIds`) fed every docId whose history title matched into `moveSources`, cleanup and folder removal. | Moving one text delivered ANOTHER text's content (seen once). |
| 4 | Auto-backup and release uploads sent docs nobody had touched: deliveries never edited, and placeholders still waiting for their transcription. | Those copies became "newest", which is exactly what findings 1 and 2 picked. |
| 5 | The Lane B queue kept the built blob in IndexedDB and sent it without checking it. | A 489-byte all-NUL `.flextext` reached Drive after six days in the queue — and, being newest, became the copy later steps would pick. |

A thread runs through all five: **recency was being used as a proxy for "the current work", and it
is a bad proxy.** Drive's `modifiedTime` is UPLOAD time. Every guard replaces "newest" with a fact:
the device's own report, the file's actual contents, or the docId.

## Principles applied

- **Field work is never blocked.** Every guard is panel-side, or stops an AUTOMATIC upload of
  something that holds no work, or checks bytes the device was about to send anyway. No guard adds
  a step for a coworker, blocks editing, or blocks an offline device.
- **Refuse a lossy step with a clear message to the researcher, rather than doing it silently** —
  and always leave a deliberate way out (a lost or stuck device is exactly when a move is needed).
- **Never silently change data.** No guard edits a doc. Cleanup still only moves files to Drive
  trash (30-day recoverable). A damaged queued copy is held, never deleted.
- **Unknown means keep.** A copy that cannot be fetched, parsed or checked is kept by cleanup, and a
  move never sends an unknown copy over a known one.
- **Undo.** Nothing here is an editor action, so no Undo/Redo history changes.
- **Researcher toggles.** These are safety rails on researcher-console actions, each with an
  explicit per-action choice inside its own modal; no new device setting. G4 has no toggle (§10 Q3).
- **Backend untouched.** `/move` and `/adopt` mint whatever `flextextFileId` the owner names (a
  member's ids pass `driveFileBelongsToDoc`); command payloads, inventory items and the moves map are
  E2EE and opaque to the worker; the folder listing already returns Drive's `sha256Checksum`.

## 1. What was built — where

| Guard | Code (file: function) | Tests |
|---|---|---|
| Shared: what a copy holds | `flextext.js`: `checkFlextextBytes`, `flextextStats` | `test/copy-stats.test.mjs` |
| Shared: comparing copies | `researcher-panel.js`: `STAT_ALL`, `STAT_CONTENT`, `statsDominate`, `statsRicher`, `statsHaveContent`, `copyStats`, `deviceFileIds`, `recordedFileIds`, `cleanupBlocked` | `test/cleanup-keeps-richest.test.mjs` |
| G3 bridge display-only | `researcher-panel.js`: `moveSources`, `populateFilesMenu` (`ownFiles`), `downloadAllZip` (sub-folder), the `[data-histclean]` handler | `test/bridge-display-only.test.mjs` |
| G2 cleanup review | `researcher-panel.js`: `cleanupPlan`, `cleanupReviewModal`, the `[data-cleanup]` handler and row | `test/cleanup-keeps-richest.test.mjs`, `test/files-menu-manifest.test.mjs` |
| G1 move/adopt copy | `researcher-panel.js`: `deviceItems`, `instanceHoldsDoc`, `deliveredFileId`, `moveCopyRows`, `chooseMoveCopy`, `resolveMoveCopy`, `paintCopyChoice`, `askDeviceToSend`, `moveTextModal`, `adoptTextModal`; `history.js`: `assignedEvent` (`fileId`) | `test/move-copy-choice.test.mjs` |
| G1 after the move | `researcher-panel.js`: `flagNewerAfterMove` (called from the move sweep in `renderDashboard`), History row note | `test/move-copy-choice.test.mjs` |
| Finding 9, panel half | `researcher-panel.js`: `instanceHoldsDoc`, `blockedSub` in `moveTextModal` | `test/move-text-without-audio.test.mjs`, `test/move-copy-choice.test.mjs` |
| G4 panel half | `researcher-panel.js`: row `disp` / `DISP` (`asDelivered`, `awaitingTranscript` chips) | `test/move-copy-choice.test.mjs` |
| G4 device | `app.js`: `docHasFree`, `deliveredContentSig`, `backupSkipReason`, stamps in `openUrlTask` and `tryDownloadFlextext`, `autoBackupSweep`, `syncGatherInventory` | `test/backup-skip-untouched.test.mjs` |
| G5 device | `app.js`: `uploadDocById` (check + `sha256` + `rebuilds`), `bytesSha256`, `isQueuedText`, `verifyQueuedText`, `rebuildOrHoldQueued`, `pumpUploads`, `retryPendingUploads`, completion stamp `uploadedSha256`, `syncGatherInventory`; `upload.js`: `DriveUpload.emit` (`sha256`) | `test/upload-queue-integrity.test.mjs` |

Existing pins updated, each with the reason in place: `files-modal-and-move-gate` (the commit sends
the chosen copy, not `src.picks.flextext`), `move-text-without-audio` (the `_holds` refusal; adopt
reuses `src.picks.audio`), `pending-assign-visible` (the move record's new fields),
`panel-pending-cmds` / `panel-shared-state` / `move-stuck-source` (Move hidden while an upload is
QUEUED, not once TAKEN), `files-menu-manifest` (the review row, and its in-flight state).

## 2. Shared building blocks

### 2.1 `checkFlextextBytes(text)` and `flextextStats(xml)` — `flextext.js`

Pure, exported, already imported by both `app.js` and `researcher-panel.js`.

- **`checkFlextextBytes` is structural, never a parse**, and it is the only check a DEVICE runs:
  `empty` · `nul` · `root` (not a `<document>` after an optional BOM, prolog and comments) ·
  `noText` (no `<interlinear-text>`) · `truncated` (no closing `</document>`). The serializer's
  `esc()` escapes only `& < > "`, so a control character pasted from a word processor is written
  raw and a real XML parser rejects the file; a strict device check would refuse the only backup of
  such a text for ever. Every reason above describes a file that holds nothing usable. No size
  floor: an empty text serializes to ~475 bytes and the damaged file was 489.
- **`flextextStats`** returns `ok`, `reason`, `damaged` (= `checkFlextextBytes` failed), `guid`, and
  the counts `phrases`, `timed` (begin offset present and NOT an estimate — the serializer marks
  estimates with `~` in the note), `textLines`, `words`, `glossed`, `freeLines`, `chars`
  (non-whitespace baseline characters), `freeChars` (non-whitespace free-translation characters).
  XML-forbidden characters are blanked before parsing, so the panel still counts such a text.
  `reason: 'parse'` with `damaged: false` means "this parser could not read it" — unknown, not bad.

### 2.2 Two sets of measures (F1)

- `STAT_ALL` (every count) decides what **cleanup** may trash. A false keep costs Drive space only.
- `STAT_CONTENT` = `words`, `glossed`, `chars`, `freeChars` decides when a **move** stops to ask.
  A join turns two lines into one (and two free translations into one, joined with a space), so the
  pre-join copy has more `phrases`, `textLines` and `freeLines`. Content measures survive joins and
  splits unchanged, so ordinary editing never makes an older copy look "richer" to a move.
- `statsDominate(a, b, keys)`: `a ≥ b` in every key. `statsRicher`: dominates and `>` in one.
- `statsHaveContent(s)`: any words, characters, free-translation characters, glosses or timed
  (non-estimated) spans. An untouched placeholder has none.
- ⚠ Still a COUNT comparison: equal counts with different wording compare as equal. The UI says
  "no more lines, words, glosses or timings than", never "contains".

### 2.3 `copyStats(files, { need, onProgress, signal, via })` — panel

Fetches `.flextext` copies through `Researcher.fetchDriveFile` and returns
`Map(id → { state: 'ok'|'damaged'|'unreadable'|'unchecked'|'missing', stats, why })`.
Deduplicated by Drive's `sha256` (identical backups fetched once), cached for the session by
content hash, two at a time, cancellable. **`need` (the copy that will actually be sent) is fetched
whatever its size**; the rest are capped (12 distinct copies, 8 MB each, 24 MB in all) and reported
`unchecked: 'cap'`. A `.zip` is `unchecked: 'zip'` (the panel reads no zips). A 404 is `missing`;
any other failure is `unchecked: 'fetch'` — never `damaged`.

## 3. G3 — the title bridge is for display only (finding 3)

| Caller | Before | Now |
|---|---|---|
| `moveSources` | listed every bridged folder | lists THIS docId's folder only; a failed listing throws, so the modal says the listing failed rather than "no manifest" |
| `populateFilesMenu` | merged list fed manifest, picks, conversions, cleanup | `ownFiles` feed all of those; the merged `allFiles` feeds only "Download all" |
| `downloadAllZip` | every bridged folder, side by side | still every bridged folder (a legacy split text wants both halves), but another docId's files go under a sub-folder "Same title, another text (<id8>)/" in the zip |
| "Remove folder" (History, `deleted` rows) | trashed every bridged folder | see below |

**"Remove folder" could trash a LIVE folder** (found in the adversarial pass, independent of the
bridge): every move records `deleted` for the device it left, and the folder lookup is by docId —
which the destination shares. The handler now refuses while any device reports the docId, while a
move or an assignment of it is in flight, or unless the estate shows the text filed under
Unassigned (where the sweep puts every text no device holds); then it trashes this docId's own
folder only, and the confirm says other same-title texts are not touched.

Nothing a move could use is lost: the move gate needs a manifest, manifests arrived (v336) after the
identity fix (v137), so a split legacy text was never movable.

## 4. G2 — cleanup is a review that keeps every copy holding more (finding 2)

The Files ▾ row reads **"Review older copies"** (sub-line "older copies: {n} — each is read first,
…"). It is owner-only, as before. While the text is still being delivered — a move or assignment in
flight, or any device reporting `awaitingTranscript` for it — the row stays, greyed, with the reason
(never a live trash button), and the review re-checks this at the moment of the act.

`cleanupPlan({ backups, stats, deviceIds, keepIds })` — pure. `backups` is the newest bare
`.flextext` plus `cleanupCandidates` (unchanged: still the explicit MAY-GO list; no source file,
consent record or manifest can ever be a row). Precedence, first match wins:

1. a device's current backup (`uploadedFileId` any install reports) → **keep, even if damaged**
   (trashing it makes the device believe in a backup Drive no longer shows);
2. a copy a delivery used (`assigned` history `fileId`, an in-flight move's `sentFileId`) → keep —
   extra protection only; this browser's history is never relied on;
3. damaged (`empty`/`nul`/`root`/`noText`/`truncated`) → **trash — this beats "newest"**, because
   the damaged file WAS the newest;
4. not fetched, unreadable, a zip → keep ("could not be checked");
5. the newest readable copy WITH CONTENT → keep (a placeholder that landed last does not hold this
   place over the transcription; if no copy holds content, the newest readable one is kept);
6. byte-identical (`sha256`) to a kept copy → trash;
7. holds nothing while a kept copy holds content → trash, **whatever its guid** (a placeholder
   minted on a device has a fresh guid; a same-guid rule alone would keep every one for ever);
8. a kept copy of the same guid has at least as much of every `STAT_ALL` measure → trash, naming it;
9. otherwise it has more of something than every kept copy → keep.

The review modal shows date · lines with text · words · glossed · timed · verdict for every row,
then "Move {n} to Drive trash" — exactly `plan.trash` — or "Nothing to move to the trash: every
older copy either has more of something than the copies kept, or could not be checked."

Accepted: every pre-join backup is kept for ever (a false keep is cheap), and a count tie trashes
the older of two differently worded copies (as before; 30-day recoverable).

## 5. G1 — a move sends the source's current copy (findings 1, 4)

### 5.1 The decision — `chooseMoveCopy`, pure

Input: the freshest LIVE install's item for the docId (`deviceItems`: pending and wiped installs
excluded, most recently seen first — a dormant install's old report never decides), the own-folder
listing, `copyStats`, the `assigned` history `fileId` for this device (F3), and `adopt`.

| Source reports | Decision |
|---|---|
| nothing (no live install reports the doc) | `noReport` (kept for safety; the Move button only renders on reported rows) |
| `asDelivered` or `awaitingTranscript` (G4) | the DELIVERED file (`assigned` event `fileId`) when listed and usable, else the newest readable copy — path `delivered` |
| `uploaded`, its `uploadedFileId` listed or **found by id** | `send` that file — path `device` |
| `uploaded`, not listed and the lookup by id says 404 / unreachable | `lastCopyMissing` |
| `uploaded`, the file is damaged, or the device's `uploadedSha256` ≠ Drive's `sha256` | `damaged` |
| `changed` | `needsUpload` (flavor `changed`) |
| `local` (not delivered) or no state | `needsUpload` (flavor `local` — its own sentence: "has never sent this text to Google Drive; if it was changed there, those changes would not move") |
| `uploading` | `wait` |
| adopt (no source device) | the newest readable copy — the history id is a LABEL only (F2) |

Then, for a `send` with a readable chosen copy, it becomes **`pick`** (the researcher chooses, nothing
preselected, candidates listed richest-by-words first with labels "{device}'s current copy" /
"the copy {device} received" / "newest in Drive") only when:
(a) the chosen copy holds no content and another does; (b) another copy is a DIFFERENT text (guid)
with more words or characters — the "device holds a fresh placeholder, Drive holds the
transcription" case; (c) with no device to trust (adopt, an untouched delivery) another copy is
content-richer; (d) a copy NEWER than the device's last upload is content-richer (a stale report,
or another writer). An OLDER same-text copy that is content-richer (glosses cleared, junk words
deleted) is a **note** on the device path, never a question and never what is sent: the device's
own current state is what moves.

A damaged copy is never sent or offered. An unchecked copy (zip, unreadable, fetch failed) is sent
only when it is the device's own copy or the only one, and the modal says it could not be checked.

### 5.2 The modal

- The gate (`moveSources`) still runs before the picker. The copy check then runs **inside the open
  modal** with "Checking the copies in Drive… (i of n)" and is cancelled when the modal closes, so a
  slow link shows progress instead of a frozen button; Unassigned never waits for it.
- A `send` shows **"Will send: {name} · {when} · lines with text: … · words: … · timed: …"** and
  where it comes from — "{device}'s current copy, as it last reported {ago}" (the report's AGE, so a
  days-old report reads as one), "the copy {device} received, unchanged there", or "the newest
  readable copy in Drive".
- Every refusal that has a usable copy in Drive offers **"Move the copy already in Drive instead…"**
  — `needsUpload`, `wait` (a stuck queue must not block a move for days), `lastCopyMissing` and
  `damaged` alike. It expands to the candidate list (no preselection) and, when there is a source
  device, says what is left behind: "Changes made on {device} that are not in Google Drive will NOT
  go to the new device. When {device} next connects, it sends them to Google Drive and removes the
  text from {device}." (accurate without G1c).
- `needsUpload` / `lastCopyMissing` / `damaged` also offer **"Ask {device} to send its copy"** — the
  row's own `triggerUpload` with a `pendingCmds` marker `{ kind: 'upload', prevFileId }`, retired by
  the existing outcome sweep. The researcher then chooses Move again (no automatic continue, §8.4).
- **Move stays available once a device has TAKEN an upload request.** `moveBtn` is hidden for
  `uploading && queued` (a queued request has its own Cancel, so one pending command per text still
  holds), not for any upload marker: a device that took "send your copy" and then lost signal would
  otherwise have hidden the escape hatch for good. The move's release still waits for the marker to
  retire (`pendingFor` in the sweep).
- **A device that already holds the text is a disabled destination** — "already has a copy of this
  text — remove it there first" (finding 9's panel half: its assign would be a silent no-op, and the
  source's release would then remove the newer copy).

### 5.3 Commit

- Exactly one of `flextextFileId` / `extractFromZipId` is sent: the chosen copy. (Sending both made
  the worker fall back from a `.flextext` to an older zip silently if the first mint failed.)
  `picks` still drives the manifest gate, unchanged. Adopt no longer re-lists at commit; it sends the
  chosen copy and the role-tagged `src.picks.audio`, as before.
- **F3:** the `assigned` history event carries `fileId` (move and adopt), and the move record gains
  `sentFileId` / `sentModified` (additive; the moves map is E2EE account settings).
- A device-copy send usually meets the release's fast branch on the device (already on Drive →
  delete, no re-upload) — fewer uploads than before on field bandwidth.

### 5.4 After the move — the flag that replaces G1c (Q1)

`flagNewerAfterMove(docId, mv)` runs once when a move finishes (the sweep's `removing → done`): one
listing; a `.flextext` that landed after the move started, is not the copy that was sent, has
different bytes, and is not a backup the destination itself reports, means the source sent newer
work into Drive on its way out (offline edits, a stale report, the Drive-copy escape hatch). The
researcher gets one toast — "A newer copy of '{title}' reached Google Drive from {from} after the
move. {to} has the copy from {when}. Compare them under Files." — and a History `submitted` row
marked "· after the text had been moved away". Nothing is changed or held.

## 6. Every case the reviews raised, and what was done

| Case | Resolution |
|---|---|
| F1 joins trip "strictly richer" | `STAT_CONTENT` for moves; older same-text richer = note (§2.2, §5.1) |
| F2 history fileId is one upload behind | adopt uses the newest readable copy; the history id is a label and cleanup's extra protection only. Device `reportNow` between stamp and delete → §8.6 |
| F3 persist what was sent | `assigned` event `fileId`; move record `sentFileId` (§5.3) |
| A1 Remove folder trashes a live folder | refuses while held / in flight / not filed under Unassigned (§3) |
| A2 no way out on wait/missing/damaged | Drive-copy option on every refusal with a usable copy (§5.2) |
| A3 "Ask to send" hides Move | Move hidden only while the request is QUEUED (§5.2) |
| A4 adopt prefers a stale history id | dropped (F2) |
| A5 offline device, stale report | the report's age is shown; newer work after the move is flagged (§5.4). G1c itself → §8.1 |
| A6 ordinary editing reads as loss | content measures; note not question (§5.1); cleanup keeps pre-join copies (accepted) |
| A7 size cap blocks large texts | the copy to send is never capped; "not checked" ≠ damaged; a timeout is `unchecked` (§2.3) |
| A8 pasted control characters | device check is structural; the panel blanks forbidden characters (§2.1) |
| A9 check one read, send another | the checked buffer is the body; the sent hash is reported and compared with Drive's (§7) |
| A10 several installs | live installs only, freshest report (§5.1). Residual: "Ask to send" makes every live install holding the text upload; the chooser then trusts the freshest report and asks if a newer copy is richer |
| A11 `awaitingTranscript` after typing | set only when nothing was typed, cut or translated (§8 G4) |
| A12, A13 G1c two writers / false "changed" | G1c not built (§8.1) |
| A14 Drive-copy warning false without G1c | reworded to what happens (§5.2) |
| A15 estimated spans count as work | `deliveredContentSig` ignores seed spans; `timed` excludes estimates |
| A16 false "last copy missing" | looked up by id before it is called missing (§5.1) |
| A17 Download all mixes texts | other texts under a sub-folder (§3) |
| A18 G2 wording claims containment | "holds no more than" in EN and ID; "Nothing to move…" includes "could not be checked" |
| A19 empty placeholders with a new guid kept | outranked by any copy with content (§4 rule 7) |
| A20 destination still waiting for its transcription | cleanup blocked while any device reports `awaitingTranscript` |
| A21 held damaged records | text gone → kept, out of the tray; text present → shown, re-read after 6 h, never reset every 90 s (§7) |
| A22 slow moves | check inside the open modal with progress and Cancel; dedupe, cache, caps |
| A23 zip uploads | `unchecked`, never `damaged` |
| A24 §8.2 compaction must keep a later re-assign | recorded in §8.2 |
| Verdict: `local` ≠ `changed` | its own sentence (`panel.move.neverSent`) |
| Verdict: cap G5 rebuilds | two, stored in the record (§7) |
| Verdict: queue-time build failure on the remove-after-upload path | the intent is left in place (the text is never deleted without a confirmed upload); an explicit send toasts, the sweep stays silent and retries |

## 7. G5 — a queued copy is checked before it leaves (finding 5)

- **Queue time** (`uploadDocById`): a fresh Lane B build is checked with `checkFlextextBytes` and its
  SHA-256 stored in the record with `rebuilds`. A build that fails is not queued: an explicit send
  toasts `upload.buildFailed`; the automatic sweep (`{ auto: true }`) stays silent.
- **Send time** (`pumpUploads`, Lane B `.flextext` only — `isQueuedText`): `verifyQueuedText` reads
  the record once, checks size against `total`, structure, and the stored hash (an older engine's
  record has no hash and gets the structural check), and **sends an in-memory copy of exactly the
  checked bytes**. Above 64 MB only the head is checked and the stored blob is sent as before.
- **Failed** (`rebuildOrHoldQueued`): the text exists → rebuilt from what it holds now
  (`uploadDocById` overwrites the record; a half-done chunked session is abandoned), **at most
  twice**; otherwise held, **never `deleteMedia`**. Text present → tray error `upload.damagedHeld`,
  re-read after a six-hour back-off with one more rebuild allowed. Text gone → kept as an orphan and
  left out of the tray (it holds nothing to send and nothing anyone can act on). A held copy no
  longer counts as "still uploading", so it cannot pin the text at `uploading` and block a move.
- The completion hook stamps `uploadedSha256` (the hash of the bytes sent) together with
  `uploadedFileId`, and the inventory reports it; the move chooser compares it with Drive's
  `sha256Checksum`, which catches damage after the bytes left the device.
- Recordings (Lane A) are not hashed — a whole-file digest of a long WAV is the memory spike field
  phones cannot afford. Their header check is §8.7.

## 8. Plan only — not built

### 8.1 G1c — the source keeps a text it changed after the move (maintainer decision)

Not built (Q1: flag, do not hold — §5.4 is the flag). If it is ever wanted, it must ship WITH: a
content- or edit-time comparison (not file ids — a pick, the Drive-copy option or a second install
would otherwise read as "changed after the move"), only live installs, and §8.3's device half — or
it manufactures "one folder, two writers" silently for the coworker.

### 8.2 (finding 6) Command replay

- `sync.js` advances `ackSeq` per command but saves the session only after the whole batch; a tab
  killed mid-batch replays it. Fix: `saveSession(s)` after each command (handlers are idempotent).
- A background `assign` awaits the full audio download inside the batch (`openUrlTask` →
  `tryDownloadAudio`), holding every later command and the ack. Fix: start the download without
  awaiting it in background mode; `retryPendingAudio` already resumes.
- A fresh install starts at `ackSeq 0` and replays every command the instance ever received, which
  re-creates long-moved texts as placeholders (G4 now stops those becoming "newest"). Fix
  (client-only): on an install's first batch, compact by net effect per docId — ⚠ **in ORDER**: an
  assign followed by `uploadDelete`/`delete` of that docId is skipped with it, but an assign AFTER
  such a delete (moved away and back) must be kept. A worker-side start cursor is the fuller fix and
  is a backend change.

### 8.3 (finding 7) Typing into a placeholder before its transcription arrives

`tryDownloadFlextext` drops the arrived transcription with `task.ftSkipped` when the coworker has
typed — and its "untouched" test reads only baseline text, so a placeholder someone has CUT into
lines is replaced by the transcription and **the cuts vanish**. That second half is a real bug and
should be filed as an issue. Design: never drop either side — hold the arrived XML in the media
store (`delivery:<docId>`), report `deliveryHeld`, let the researcher decide. Holding is not an edit.

### 8.4 (finding 9) Device half, and automatic continue

- Device half of finding 9: an assign for a docId whose local doc is untouched replaces it;
  otherwise hold it as in §8.3. (The panel half is built.)
- Automatic continue after "Ask {device} to send": a `sourcing` move stage committing once a new
  `uploadedFileId` arrives. Deferred: an autonomous move days later can surprise.

### 8.5 Files ▾ picks

The ".flextext" row and the ELAN/SayMore/listening-page conversions still take the newest own-folder
copy (now own folder only, G3). They should name the file and date they use and offer the richer
copy when §2.2 says the newest is outranked. Until then the move modal's "Will send" line may name a
different file than Files ▾ — say so in the release note.

### 8.6 F2, device half

In the upload-completion hook the order is stamp → `putDoc` → `deleteConfirmedDoc` →
`Sync.reportNow`, so a release's final upload id is never reported before the doc vanishes and the
`deleted` history event carries the previous id. One `await Sync.reportNow()` between stamp and
delete would report it (and make `submitted` fire for release uploads). Nothing built here relies on
it — `flagNewerAfterMove` lists the folder instead.

### 8.7 Smaller follow-ups

- Lane A header check (first 4 KB all NUL → hold), P1.
- Report held damaged queue records in the inventory so the panel can show them.
- Delete an untouched placeholder on release without uploading it (Q2: no, not now).

## 9. Compatibility, blast radius, deploy

| Pairing | Result |
|---|---|
| new panel + old device | G1/G2/G3 work from fields old engines already report (`uploadState`, `uploadedFileId`). No `asDelivered` → an untouched delivery on an old engine reads `local` → "has never sent this text" with the Drive-copy option: **grandfathered deliveries ask once** — say so in the release note. No `uploadedSha256` → no hash comparison. |
| old panel + new device | G4 means fewer junk "newest" copies; untouched deliveries read "no upload from this device yet" (cosmetic). G5 is device-only. Unknown inventory fields are ignored. |
| both new | everything above |

Blast radius: `researcher-panel.js` (the researcher app and the editor's `?mode=researcher`),
`app.js` (every app on the engine — G4 sits behind `assigned` + never-uploaded and the automatic
sweep only; G5 behind Lane B `.flextext` records), `flextext.js` (two new exports), `upload.js` (one
emitted field), `history.js` (one optional field), `i18n.js`, `app.css`. No new module, so no SHELL
entry and no satellite change beyond the routine version bump. No worker, no D1, no maintenance
flag. Release: bump, RELEASES entry written then, beta soak.

## 10. Maintainer questions — recommended answers (from the review)

1. **G1c** — flag, do not hold (built as §5.4; G1c in §8.1).
2. **Delete an untouched placeholder without uploading it on release?** No exception tonight: the
   upload is noise, but upload-first's simplicity is worth more. Revisit with §8.2's compaction.
3. **A researcher toggle for G4?** No — the chip explains, the device still reports the text, and
   nothing a researcher relied on disappears. It changes every device, hence the beta soak.
4. **Order of the candidate list** — words descending, the device's copy, the delivered copy and the
   newest in Drive labelled, nothing preselected (newest-first would hide what the researcher is
   being asked to judge). Built that way.

## 11. Verification

Done: the full node suite (0 fail), the ESM parse gate, `check-secrets`, and a no-undef scan of every
added line. **Still to do before release: real clicks on the dev rig** — a move from a source
reporting `changed`, `local` and `uploading` (both the ask and the Drive-copy routes), a damaged
device copy, a `pick`, a destination that already holds the text, the cleanup review on a folder
with a placeholder newer than the transcription, "Remove folder" on a moved text's old-device row,
and a damaged queue record on a paired device (tray state, rebuild, hold, six-hour re-read).
