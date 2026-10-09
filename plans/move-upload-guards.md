# Move, adopt, cleanup and upload guards — design

**Status: DESIGN for review (2026-10-10). Nothing here is built yet.** Branch `fix/move-upload-guards`,
cut from `main` at v716 (= production). No worker change, no D1 change, no new top-level import,
no SHELL change. One version bump for the whole set at release time; it soaks on beta (it touches
sync, moves and uploads, so it is not a "small self-contained change").

## Why

A read-only investigation of a real researcher Drive estate, confirmed by an adversarial pass,
found that a text's transcription can go backwards without anyone pressing anything that says
"delete". The raw evidence stays in local notes; what matters here is the mechanism:

| # | Finding | Confirmed effect |
|---|---|---|
| 1 | Move and adopt deliver Drive's NEWEST `.flextext` in the text folder, not the source device's current state. The source's reported `uploadState: 'changed'` and `uploadedFileId` are ignored, and the move's release (`uploadDelete`) then uploads the source's final copy AFTER the destination already received an older one. | A text with 25 lines of transcription went back to its 4-line state on the new device; a text cut into 32 lines was replaced by an empty doc. |
| 2 | Files ▾ "Clean up old backups" keeps only the newest file by Drive `modifiedTime` — across every same-title folder the bridge pulls in. | On today's estate it would trash the good copy of several texts. |
| 3 | The legacy title bridge (`bridgedIds`) feeds every docId whose history title matches into `moveSources`, cleanup and folder removal. | Moving one text delivered ANOTHER text's content (seen once). |
| 4 | Auto-backup and release uploads send docs nobody has touched: deliveries never edited since they arrived, and placeholders still waiting for their transcription. | Those copies become "newest", which is exactly what findings 1 and 2 pick. |
| 5 | The Lane B queue keeps the built blob in IndexedDB and sends it without checking it. | A 489-byte all-NUL `.flextext` reached Drive after six days in the queue — and, being newest, became the copy later steps would pick. |

Plan-only items (not built tonight): 6 command replay, 7 typing into a waiting placeholder, 9 moving
back to a device that still holds an older copy — §8.

A thread runs through all five: **recency is being used as a proxy for "the current work", and it is
a bad proxy.** Drive's `modifiedTime` is UPLOAD time — a copy queued days ago sorts as newest the
moment it lands (the all-NUL file did exactly that). Every guard below replaces "newest" with a
fact: the device's own report, the file's actual contents, or the docId.

## Principles applied (and where each one bites)

- **Field work is never blocked.** Every guard is either panel-side (the researcher's console) or
  stops an AUTOMATIC upload of something that holds no work. No guard adds a step for a coworker,
  blocks editing, or blocks an offline device.
- **Refuse a lossy step with a clear message to the researcher, rather than doing it silently.**
  Move refuses-with-a-choice when the source has unsent changes (G1); cleanup shows what it will
  trash and why (G2); a device keeps a text it changed after a move instead of burying the change
  (G1c).
- **Never silently change data.** No guard edits a doc. Cleanup still only ever moves files to
  Drive trash (30-day recoverable). A damaged queued copy is held, never discarded (G5).
- **Unknown means keep.** A file that cannot be fetched or parsed is kept by cleanup and is never
  chosen as a move source.
- **Undo.** None of these touch an editor action, so no Undo/Redo history changes. (The plan-only
  item 7 must keep that true: holding a delivery is not an edit.)
- **Researcher toggles.** These are safety rails on researcher-console actions, each with an
  explicit per-action override inside its own modal; no new device setting is proposed. See §11
  for the one place a toggle might be wanted.
- **Backend untouched.** Verified in `worker/src/v1.js`: command payloads travel inside `enc`
  (opaque to the worker, so a new field on `uploadDelete` needs nothing from it), inventory reports
  are E2EE blobs (new item fields likewise), and `/move` and `/adopt` mint whatever
  `flextextFileId` the owner names (a member's ids are checked by `driveFileBelongsToDoc`, which a
  device copy in the text's own folder passes). So no maintenance flag and no worker deploy.

## 1. Shared building blocks

### 1.1 `flextextStats(xml)` and `checkFlextextBytes(xml, expect)` — `docs/js/flextext.js`

Pure, exported, DOMParser-based (the module already parses with `DOMParser`; node tests use
`test/lib/mini-xml-dom.mjs`). Already imported by both `app.js` and `researcher-panel.js`, so no
new module and no SHELL entry.

```js
flextextStats(xml) → {
  ok, reason,            // reason: '' | 'empty' | 'nul' | 'parse' | 'root' | 'noText'
  bytes, nul,            // nul: the string contains U+0000 anywhere
  guid,                  // first <interlinear-text guid>, '' if none
  phrases,               // <phrase> count
  timed,                 // phrases carrying begin-time-offset
  textLines,             // phrases with a non-empty txt item, or non-empty word txt
  words,                 // <word> count
  glossed,               // words with a non-empty gls item
  freeLines,             // phrases with a non-empty phrase-level gls (free translation)
}
checkFlextextBytes(xml, expect = {}) → { ok, reason, stats }
  // ok ⇔ stats.ok && !stats.nul && (expect.sha256 ? matches : true)
```

The counts mirror the investigation's own metrics so the numbers the researcher sees match the
evidence. `ok` requires a `<document>` root and at least one `<interlinear-text>` — the structural
skeleton. **Deliberately no byte-size floor:** a genuine empty text serializes to ~475 bytes and the
damaged file was 489, so a size threshold cannot tell them apart; structure can.

### 1.2 Copy stats in the panel — `copyStats(files, { onProgress, signal })`

Fetches `.flextext` rows through `Researcher.fetchDriveFile` (the route the manifest read already
uses) and returns `Map(fileId → stats|null)`.

- **Dedupe by `sha256`** (the listing already carries Drive's SHA-256, worker ~L5409): identical
  backups are fetched once. Most folders have far fewer distinct versions than files.
- **Session cache** keyed by `sha256 || id`, so a move after a cleanup (or a re-opened modal) costs
  nothing.
- **Caps for slow links:** at most 12 distinct copies and 4 MB per call, largest first (a richer
  copy is almost always a larger one); anything skipped is `null` = "not checked" and is said so.
  Concurrency 2. Cancellable (`signal`); a cancel trashes and sends nothing.
- Progress through the existing `stage()` / `dlStatus` lines ("Checking copy 3 of 7…").

### 1.3 `deviceItems(instanceId, docId)` — panel

`findInventoryItem` (~L4526) returns the FIRST install's item. An instance can have several
installs (a PWA and an APK on one handset), each with its own state, so the guards read all of them:
returns every install's item for the docId. `findInventoryItem` stays for its existing callers.

### 1.4 The dominance rule — `dominates(a, b)`, pure

`a` dominates `b` when they share a `guid` and `a` has **≥ b in every measure** (`phrases`,
`textLines`, `words`, `glossed`, `freeLines`, `timed`); `strictlyRicher(a, b)` additionally needs
`a` > `b` in at least one. Cleanup trashes a copy a kept copy DOMINATES (so an exact tie goes, as
today); a move only stops to ask when another copy is STRICTLY RICHER (a tie is not worth a
question). A copy that has more of ANYTHING than every copy kept is never dominated. Different
guid = a different version of the text (for example a fresh placeholder that replaced the delivered
doc): never compared, each keeps its own best.

⚠ It is a COUNT comparison. Two copies with equal counts and different wording compare as equal —
the older one is then trashable, exactly as today, and still recoverable for 30 days. The UI words
this honestly ("no more lines, words, glosses or timings than …"), never as "contains".

## 2. G1 — a move sends the source's current state (findings 1, 4)

### Code points

- `moveSources` (researcher-panel.js ~L7263): resolves sources; today `picks.flextext` = newest.
- `moveTextModal` (~L7500): gate before the picker; commit at ~L7608 sends `idOf(src.picks.flextext)`.
- `adoptTextModal` (~L8469): gate via `moveSources`, commit re-lists and sends newest (~L8552).
- Move sweep in `renderDashboard` (~L2908): stage `'assigned'` fires `Researcher.uploadDelete(mv.from, docId)`.
- Device `syncDispatch` `'uploadDelete'` (app.js ~L5271).

### 2a. Choose the copy from facts — `chooseMoveCopy(...)`, pure

Input: the source's `deviceItems`, the own-folder file list (G3), `copyStats`, and — for adopt — the
latest `deleted`/`submitted` history `fileId` for exactly this docId (this browser's log;
best-effort). Output: `{ decision, file, candidates, why }`.

| Source reports | Decision | What the modal shows |
|---|---|---|
| no item for the docId on any install | `noReport` | device destinations disabled; "has not reported this text yet — open the app on it, then try again". Unassigned stays available. |
| `asDelivered` (G4) or `awaitingTranscript` on every install | `send` the best Drive copy (newest non-dominated, §1.4) | "Will send: …" line |
| `uploaded` and `uploadedFileId` listed in the own folder, stats `ok` | `send` that file (a `.zip` goes as `extractFromZipId`) | "Will send: … ({device}'s current copy)" |
| `uploaded` but that file is not listed (trashed, or not visible yet) | `lastCopyMissing` | "…'s last copy is not in Drive any more" + **Ask {device} to send its copy** |
| `uploaded` but the file fails `checkFlextextBytes` (G5's damaged-upload case) | `damaged` | same as above, with "is damaged" |
| `changed`, `local` (not asDelivered), missing `uploadState`, or installs disagreeing | `needsUpload` | amber note + **Ask {device} to send its copy** + **Move the copy already in Drive instead…** |
| `uploading` | `wait` | "{device} is sending its copy now — try Move again when it shows uploaded ✓" |
| adopt (no source device) | history fileId if listed and `ok`, else newest `ok` copy | "Will send: …" |

Then, for any `send`: if another checked `ok` copy is strictly richer than the chosen one, or has a
different guid and more lines with text or more words (the "device holds a fresh placeholder, Drive
holds the transcription" case), the decision becomes `pick`: the modal lists the candidates (date, lines with
text, words, timed, and which is "{device}'s current copy" / "newest in Drive"), **with no
preselection**, and Move stays disabled for device destinations until one is chosen. This fires
only in the anomaly case, so the ordinary move costs no extra click.

**A file whose stats are not `ok` is never sent** — it cannot be a candidate.

**"Will send" is always shown** (name, date, line/word counts): one line, and it is the thing that
would have made every confirmed incident visible before it happened.

**"Ask {device} to send its copy"** reuses the row's existing upload request (~L5463):
`Researcher.triggerUpload` + a `pendingCmds` marker `{ kind: 'upload', prevFileId }`, so the row
reads "request sent…" and the existing outcome sweep retires it. The modal closes with "When
{device} shows uploaded ✓, choose Move again." The automatic continue (a `sourcing` move stage) is
deliberately NOT in tonight's build — see §8.4.

**"Move the copy already in Drive instead…"** is the escape hatch for a lost, broken or long-offline
source — exactly when a move is most needed. It expands to the candidate list, names the cost
("changes made on {device} since {when} will NOT go to the new device; they stay on {device}"), and
requires a pick.

Unassigned (the upload-first release) is never gated by any of this: it sends nothing to a device.

### 2b. Commit

- `fields.flextextFileId` / `extractFromZipId` come from `src.send` (the chosen file), never from
  `src.picks.flextext`. `picks` still drives the manifest gate (`declaredMissing` etc.) unchanged.
- The move record gains `sentFileId` (additive; the moves map is E2EE account settings):
  `{ from, to, title, at, stage, sentFileId }`.
- `adoptTextModal` uses the same `src.send` instead of re-listing and taking newest.

### 2c. G1c — the source keeps a text it changed after the move (device; P1, see build order)

A move's release can run days later on an offline source, while the coworker keeps typing. Today
that device uploads its final copy and deletes the text: the destination works on the older copy
and the newer work is buried in Drive.

- Panel: the sweep's stage-`assigned` release sends `uploadDelete(mv.from, docId, { sentFileId })`
  (`researcher.js` `uploadDelete(instanceId, docId, extra = {})` → `pushCommand(…, { docId, ...extra })`).
- Device, `case 'uploadDelete'`: when `cmd.sentFileId` is present and the doc is NOT the copy that
  was sent — `!(d.uploadedFileId === cmd.sentFileId && (d.uploadedModified === d.modified ||
  d.uploadedSig === uploadContentSig(d)))` and not `asDelivered` — then:
  stamp `d.releaseHeld = { sentFileId, at }`, queue an upload if it is not already on Drive, and do
  **NOT** add it to `pendingUpDel`. The text stays on the device. No toast for the coworker.
- Inventory reports `releaseHeld: true`. The panel's sweep closes the move record on seeing it
  (so no stale record hides the Move button — the trap described at ~L2895) and toasts once:
  "Move finished, but '{title}' was kept on {device} because it changed after the move. Its newest
  copy is in Drive." The source row carries a chip, "Kept here: changed after it was moved", with
  **Remove from this device anyway** = a plain `uploadDelete` (today's behaviour).
- Only ever KEEPS more than today. Old engines ignore `sentFileId`; old panels never send it.
- A release of an `asDelivered` doc still uploads-then-deletes as today (the delete-safety rule is
  not touched here — see §11).

### Tests (G1)

- `test/move-copy-choice.test.mjs`: lift `chooseMoveCopy` and run the decision table above, plus:
  multi-install disagreement → `needsUpload`; a damaged device copy is never sent; only a strictly
  richer copy (or a different-guid copy with more text) turns a `send` into `pick`, a tie does not;
  adopt prefers the exact-docId history fileId; a `.zip` device copy goes as `extractFromZipId`.
- Static pins: `moveTextModal` and `adoptTextModal` commit `src.send`, never `picks.flextext`; the
  move record carries `sentFileId`; the sweep passes `{ sentFileId }`; the chooser runs BEFORE
  `modal(` (keep the existing gate-before-picker pin).
- `test/release-held-after-move.test.mjs` (G1c): lift the `uploadDelete` case; mismatch keeps the
  doc and never touches `pendingUpDel`; a match takes the existing path; no `sentFileId` = today.
- Update `test/files-modal-and-move-gate.test.mjs` (it pins `idOf(src.picks.flextext)`).
- Real-click check on the dev rig: a source reporting `changed`, a damaged copy, a `pick`.

### Risks (G1)

- Slower Move on a slow link (fetching copies). Bounded by §1.2's caps; the chosen copy alone is
  usually one small fetch.
- A stale inventory (device uploaded, report not yet in) yields `needsUpload` — the benign
  direction; the researcher waits or asks.
- Old devices lack `asDelivered`, so an untouched delivery on an old engine may read `local` →
  `needsUpload`. Old engines auto-back such texts up anyway, so this is rare; the escape hatch covers it.
- The Files ▾ menu's ".flextext" row and conversions still take the newest own-folder copy
  (follow-up §8.5); the move modal's "Will send" line may then name a different file. Say so in the
  release note if the follow-up has not landed.

## 3. G2 — cleanup keeps every copy that has something the kept ones lack (finding 2)

### Code points

`cleanupCandidates` (~L3939, unchanged: still the explicit list of what MAY go), the row render
(~L4158), the click handler (~L4714).

### Behaviour

1. The row reads "Review older copies" with "checks {n} older copies; only copies with nothing the
   kept ones lack go to Drive trash". It still appears only for the owner and only own-folder files
   count (G3).
2. Click → modal → `copyStats` over the candidates plus the newest → `cleanupPlan(...)`, pure:
   - **Protected, always kept:** the newest copy; every `uploadedFileId` any device currently reports
     for this docId (its proof of backup — trashing it today makes the device believe in a backup
     Drive no longer shows); the exact-docId history `fileId` of the last release; any
     `sentFileId` of an in-flight move. **While an assignment or move of this text is in flight
     (`pendingMoves` / `inFlightAssignIds`) cleanup is not offered at all** — trashing the file a
     destination is still fetching breaks its download.
   - Walk the rest newest → oldest; keep a copy unless a kept copy of the same guid dominates it.
   - Byte-identical (`sha256`) to a kept copy → trash ("identical to a kept copy").
   - All-NUL or zero bytes → trash ("empty or damaged file") — it holds nothing.
   - Not fetched, not parsable (but not NUL), or over the caps → **keep** ("could not be checked").
3. A table: date · lines with text · words · timed · verdict. Button "Move {n} to Drive trash", or
   "Nothing to clean up: every older copy has something the kept copies lack" with no button.
4. `Researcher.trashFiles` receives `plan.trash` ids only. Trash, never delete — unchanged.

### Tests (G2)

`test/cleanup-keeps-richest.test.mjs`, fixtures shaped like the incidents (anonymised): newest is an
empty new-guid placeholder and an older copy has 21 lines with text → the older one is kept; a
25-line copy older than a 4-line one → kept; all-NUL → trashed; sha duplicates → trashed; unknown
stats → kept; a device's `uploadedFileId` is kept even when dominated; different guids each keep
their best; in-flight text → no plan offered. Static pins: the handler builds a plan before
`trashFiles` and passes only `plan.trash`; still owner-only. `test/text-folder-files.test.mjs` keeps
its pins on `cleanupCandidates` (the MAY-GO list is unchanged).

### Risks (G2)

Bandwidth on the researcher's link (bounded); a count tie trashes the older of two differently
worded copies (as today, recoverable); unusual FLEx exports parse oddly → "could not be checked" →
kept (safe direction).

**Stop-gap if G2 cannot ship tonight:** hide the cleanup row (one condition at ~L4158). It is the one
control in this set that can move good work out of sight today.

## 4. G3 — the title bridge is for display only (finding 3)

`bridgedIds` (~L3911) joins docIds by matching history TITLES, from this browser's history. It was
built for pre-v137 texts split across two folders. Its four callers:

| Caller | Today | After |
|---|---|---|
| `populateFilesMenu` (~L3976) | merged list drives the manifest, the ".flextext"/audio rows, conversions AND cleanup | rows are tagged with their folder's docId; picks, manifest, conversions and cleanup use **own-folder rows only**; the merged list feeds "Download all" only |
| `downloadAllZip` (~L4574) | every bridged folder | unchanged (a download moves nothing) |
| `histclean` (~L4735) — "Remove folder" on a deleted text | trashes EVERY bridged folder | **docId's own folder only**; the confirm adds "Folders of other texts with the same title are not touched." |
| `moveSources` (~L7264) | sources from every bridged folder | **docId only** |

Nothing a move can use is lost: the move gate requires a manifest, and manifests arrived with v336
(2026-08-12), after the v137 identity fix — so in practice a split legacy text was never movable,
and the bridge only ever added foreign files to a manifest-gated text. Same-title texts are common
(one recording assigned twice, numbered recording names), which is how the confirmed case happened.

Tests: `test/bridge-display-only.test.mjs` — static: `moveSources` and the histclean handler never
call `bridgedIds`; `populateFilesMenu` computes `pickSourceFiles` and `cleanupCandidates` over
own-folder rows; lifted `moveSources` with a `listTextFiles` stub that serves a different folder per
docId never asks for the sibling. Update the `bridgedIds` stub in `test/move-text-without-audio.test.mjs`.

Risk: a legacy split text loses its "other half" from Files ▾ picks (still in Download all and
Open folder, which is what pre-manifest texts get anyway).

## 5. G4 — no automatic backup of an untouched delivery or a waiting placeholder (finding 4)

Matches the assign-by-upload rule already on record: an untranscribed text has nothing worth
uploading.

### Code points

`autoBackupSweep` (app.js ~L5072); stamps in `openUrlTask` (~L4113, the new-record branch) and
`tryDownloadFlextext` (~L4230, the populate branch); `syncGatherInventory` (~L5402); the panel's
upload-state allow-list (~L4986).

### Behaviour

- New field `rec.deliveredSig = uploadContentSig(rec)`, stamped when a delivery creates a doc
  (placeholder or populated) and re-stamped when a waiting transcription populates it.
- `backupSkipReason(rec)`, pure, returns `''` unless ALL of: `rec.assigned`, no unsent local media
  (`isAudioLocked(rec)` or no recording of its own), never uploaded from here (`!rec.uploadedFileId`),
  and either
  - `'awaitingTranscript'` / no work: `docHasNoText(doc) && docIsUncut(doc)` (both existing
    helpers, ~L897/~L907) and no free translation — real cuts by a person ARE work and back up as
    today; or
  - `'asDelivered'`: `uploadContentSig(rec) === rec.deliveredSig`.
- `autoBackupSweep` skips when it returns non-empty. **Only the automatic sweep.** Send, Done, the
  researcher's triggerUpload and the release (`uploadDelete`) are explicit and unchanged.
- Inventory gains `asDelivered: true` and `awaitingTranscript: !!rec.pendingFlextext` (E2EE like the
  rest; old panels ignore them). The panel shows a chip "as delivered" / "waiting for its
  transcription" instead of "no upload from this device yet" — added to the allow-list, still a
  fixed literal set. G1 reads the same flags.
- Grandfathered: docs delivered before this version have no `deliveredSig` and back up as today.

### Tests (G4)

`test/backup-skip-untouched.test.mjs`: lift `backupSkipReason` — untouched placeholder → skip;
placeholder with typed text → back up; placeholder cut by hand → back up; delivered and unchanged →
skip; delivered then edited → back up; a recorded (not assigned) empty text → back up (unchanged);
legacy delivery without `deliveredSig` → back up. Static: `autoBackupSweep` consults it before
`uploadDocById`; both stamp points set `deliveredSig`; the inventory reports both flags; `doUpload`,
`setDocDone`, `userDeleteDoc`, `triggerUpload`, `uploadDelete` do NOT consult it.

### Risks (G4)

Opening a delivered text in Audio Segmentation Mode seeds estimated spans, which changes its
signature, so it backs up as today — the safe direction. Old panels show such texts as not yet
uploaded (cosmetic). **G4 must ship with G1's `asDelivered` handling**, or a move from a device
holding an untouched delivery would ask for an upload first.

## 6. G5 — a queued copy is checked before it leaves (finding 5)

### Code points

`uploadDocById` (app.js ~L6124, builds and queues), `pumpUploads` (~L6579, starts a `DriveUpload`),
`retryPendingUploads` (~L6627), the tray.

### Behaviour

- **At queue time:** after `buildBundleFor`, read the blob, `checkFlextextBytes` it, and store
  `sha256` (`crypto.subtle.digest`) in the record. A build that fails the check is not queued (never
  send garbage): an explicit Send/Done toasts "This text could not be prepared for sending. It is
  still saved on this device."; the automatic sweep logs and retries after its existing 30-minute
  back-off.
- **At send time,** in `pumpUploads` after `db.getMedia` and before `new DriveUpload`, for Lane B
  records (non-`media:` keys, `.flextext` names): recompute the SHA-256 and compare; a record from an
  older engine (no hash) gets the structural check (no NUL, parses, `<document>` +
  `<interlinear-text>`). Up to 64 MB is checked whole; above that, the first and last 64 KB.
- **Damaged and the doc still exists → rebuild:** release the `'uploading'` claim and call
  `uploadDocById(docId)`, which rebuilds from the doc's CURRENT state and overwrites the record (a
  half-done chunked session is simply abandoned; Drive expires it). `docModified`/`docSig` then
  describe what is actually sent, so proof-of-backup stays honest.
- **Damaged and the doc is gone → hold:** persist `rec.damaged = reason`, show it in the tray as an
  error ("A queued copy was damaged and could not be sent"), never `deleteMedia` it, and have
  `retryPendingUploads` leave damaged records in `'error'` rather than resetting them to `'waiting'`.
  Cancel stays available to the user, as for every item.
- **Lane A (`media:` keys), P1:** only a cheap header check (first 4 KB all NUL → hold). No hashing
  of recordings: a whole-file digest of a long WAV is exactly the memory spike the field phones
  cannot afford.

### Tests (G5)

`test/upload-queue-integrity.test.mjs`: `checkFlextextBytes` over all-NUL, empty, truncated,
wrong root, no interlinear-text, BOM-prefixed valid, hash mismatch. Static: `uploadDocById` stores
`sha256`; `pumpUploads` checks before `new DriveUpload` for non-media keys; the damaged branch
rebuilds when the doc exists and never calls `deleteMedia`; `retryPendingUploads` keeps damaged
records out of `'waiting'`.

### Risks (G5)

A false "damaged" rebuilds from the doc — still a correct upload. CPU for a large `.flextext` once
per send. The check reads the blob from IndexedDB once more before sending (the Firefox
lazy-read case in `readChunk` is unaffected).

## 7. Compatibility, blast radius, deploy

| Pairing | Result |
|---|---|
| new panel + old device | G1/G2/G3 work from fields old engines already report (`uploadState`, `uploadedFileId`). `asDelivered` absent → treated as not delivered. `sentFileId` ignored. |
| old panel + new device | G4 means fewer junk "newest" copies; untouched deliveries read "no upload from this device yet". G5 is device-only. |
| both new | everything above |

Blast radius: `researcher-panel.js` (researcher app; the editor's `?mode=researcher`),
`app.js` (every app that loads the engine — G4/G5/G1c sit behind `assigned`, Lane B and a paired
device), `flextext.js` (two new exports, nothing existing changes), `researcher.js` (one optional
argument). No new import, so no SHELL entry and no satellite change beyond the routine version
bump. No worker, no D1, no maintenance flag. Release: bump, RELEASES entry written then, beta soak.

## 8. Plan only — not built tonight

### 8.1 (finding 6) Command replay

- `sync.js` advances `ackSeq` per command but saves the session only after the whole batch (~L448);
  a tab killed mid-batch replays it. **Fix:** `saveSession(s)` after each command. Trivial, and the
  handlers are idempotent; worth doing first.
- A background `assign` awaits the full audio download inside the batch (`openUrlTask` →
  `await tryDownloadAudio`), holding every later command and the ack behind a long download.
  **Fix:** in background mode, list the doc, start the download without awaiting it, return;
  `retryPendingAudio` already resumes.
- A fresh install starts at `ackSeq 0`, and the desired blob never prunes (by design, worker
  ~L5130), so a new install replays every command the instance ever received — old assigns included,
  which re-create texts that were long since moved away, as placeholders whose old tokens may have
  expired. Those placeholders are what G4 now stops from becoming "newest". **Fix (client-only):** on
  an install's first batch, compact by net effect per docId — an assign followed later in the same
  batch by a delete/uploadDelete for that docId is skipped along with it; `setDone`/`triggerUpload`
  for a doc that does not exist are no-ops already. A worker-side start cursor for new installs is
  the fuller fix and is a backend change, so it waits.

### 8.2 (finding 7) Typing into a placeholder before its transcription arrives

`tryDownloadFlextext` (~L4230) drops the arrived transcription with `task.ftSkipped` when the
coworker has typed, and — worse — its "untouched" test reads only baseline text, so a placeholder
someone has CUT into lines is replaced by the transcription and the cuts vanish. **Design:** never
drop either side. If the placeholder holds work (`!docHasNoText || !docIsUncut`), keep the doc as is
and hold the arrived XML in the media store (`delivery:<docId>`), report `deliveryHeld: true`, and
let the researcher decide from the panel (a later command to accept it, or a comparison in Files).
The coworker gets a calm toast and no new step. Holding is not an edit: no Undo entry.

### 8.3 (finding 9) Moving back to a device that still holds an older copy

`openUrlTask` matches the existing doc by identity (`id:<docId>`) and, without `replace`, the
background assign is a silent no-op — the destination keeps its old copy, the panel believes the
move delivered, and the source's release then removes the newer one. **Panel half (cheap, could ride
with G1):** a destination that already reports the docId is a disabled tile, "already has a copy of
this text (changed {when}) — remove it there first". **Device half:** an assign for an existing
docId whose local doc is `asDelivered`/no-work replaces it (nothing of the coworker's is lost);
otherwise hold it as in 8.2.

### 8.4 Automatic continue after "Ask {device} to send"

A `sourcing` move stage that records `prevFileId` and commits the move from the sweep once the
source reports a new `uploadedFileId`. Deferred: an autonomous move days later can surprise, and the
manual two-step is honest about what is waiting.

### 8.5 Files ▾ picks

The ".flextext" row and the ELAN/SayMore/listening-page conversions still take the newest own-folder
copy. They should name the file and date they use and offer the richer copy when §1.4 says the
newest is dominated.

## 9. i18n (every new string, EN + ID)

| key | EN | ID |
|---|---|---|
| `panel.move.willSend` | Will send: {name} · {when} · {lines} lines with text, {words} words, {timed} timed | Yang akan dikirim: {name} · {when} · {lines} baris berisi teks, {words} kata, {timed} bertanda waktu |
| `panel.move.notOnDrive` | {device} has changes to this text that are not in Google Drive yet (changed {when}). Moving it now would send an older copy. | {device} memiliki perubahan pada teks ini yang belum ada di Google Drive (diubah {when}). Jika dipindahkan sekarang, yang terkirim adalah salinan yang lebih lama. |
| `panel.move.askSend` | Ask {device} to send its copy | Minta {device} mengirim salinannya |
| `panel.move.askSent` | Request sent. When {device} shows "uploaded ✓", choose Move again. | Permintaan terkirim. Setelah {device} menunjukkan "terunggah ✓", pilih Pindahkan lagi. |
| `panel.move.sendingNow` | {device} is sending its copy now. Try Move again when it shows "uploaded ✓". | {device} sedang mengirim salinannya. Coba Pindahkan lagi setelah statusnya "terunggah ✓". |
| `panel.move.useDrive` | Move the copy already in Drive instead… | Pindahkan salinan yang sudah ada di Drive saja… |
| `panel.move.useDriveWarn` | Changes made on {device} since {when} will NOT go to the new device. They stay on {device} until it sends them. | Perubahan di {device} sejak {when} TIDAK akan ikut ke perangkat baru. Perubahan itu tetap di {device} sampai dikirim. |
| `panel.move.noReport` | {device} has not reported this text yet, so the panel cannot tell which copy is current. Open the app on {device}, then try again. | {device} belum melaporkan teks ini, jadi panel tidak dapat mengetahui salinan mana yang terkini. Buka aplikasinya di {device}, lalu coba lagi. |
| `panel.move.lastCopyMissing` | {device}'s last copy is not in Google Drive any more. Ask {device} to send it again. | Salinan terakhir dari {device} sudah tidak ada di Google Drive. Minta {device} mengirimnya lagi. |
| `panel.move.lastCopyDamaged` | {device}'s last copy in Google Drive is damaged. Ask {device} to send it again. | Salinan terakhir dari {device} di Google Drive rusak. Minta {device} mengirimnya lagi. |
| `panel.move.pickCopy` | These copies disagree. Choose which one to send: | Salinan-salinan ini berbeda. Pilih salinan yang akan dikirim: |
| `panel.move.copyRow` | {when} · {lines} lines with text · {words} words · {timed} timed | {when} · {lines} baris berisi teks · {words} kata · {timed} bertanda waktu |
| `panel.move.copyDevice` | {device}'s current copy | salinan terkini {device} |
| `panel.move.copyNewest` | newest in Drive | terbaru di Drive |
| `panel.move.checking` | Checking the copies in Drive… ({i} of {n}) | Memeriksa salinan di Drive… ({i} dari {n}) |
| `panel.move.notChecked` | {n} older cop(y/ies) were not checked. | {n} salinan lama tidak diperiksa. |
| `panel.move.heldToast` | Move finished, but "{title}" was kept on {device} because it changed after the move. Its newest copy is in Google Drive. | Pemindahan selesai, tetapi "{title}" tetap disimpan di {device} karena diubah setelah dipindahkan. Salinan terbarunya ada di Google Drive. |
| `panel.move.heldChip` | Kept here: changed after it was moved | Tetap di sini: diubah setelah dipindahkan |
| `panel.move.heldRemove` | Remove from this device anyway | Tetap hapus dari perangkat ini |
| `panel.dl.cleanup` (changed) | Review older copies | Tinjau salinan lama |
| `panel.dl.cleanupSub` (changed) | checks {n} older cop(y/ies); only copies with nothing the kept ones lack go to Drive trash | memeriksa {n} salinan lama; hanya salinan yang isinya sudah ada di salinan yang disimpan yang dipindahkan ke sampah Drive |
| `panel.dl.cleanupKeepNewest` | Keep — newest | Simpan — terbaru |
| `panel.dl.cleanupKeepRicher` | Keep — has more than the copies kept | Simpan — isinya lebih banyak dari salinan yang disimpan |
| `panel.dl.cleanupKeepDevice` | Keep — a device's current copy | Simpan — salinan terkini sebuah perangkat |
| `panel.dl.cleanupKeepUnknown` | Keep — could not be checked | Simpan — tidak dapat diperiksa |
| `panel.dl.cleanupTrashSame` | Trash — identical to a kept copy | Buang — sama persis dengan salinan yang disimpan |
| `panel.dl.cleanupTrashLess` | Trash — no more lines, words, glosses or timings than the copy from {when} | Buang — baris, kata, glos, dan penanda waktunya tidak lebih banyak dari salinan {when} |
| `panel.dl.cleanupTrashEmpty` | Trash — empty or damaged file | Buang — berkas kosong atau rusak |
| `panel.dl.cleanupGo` | Move {n} to Drive trash | Pindahkan {n} ke sampah Drive |
| `panel.dl.cleanupNothing` | Nothing to clean up: every older copy has something the kept copies lack. | Tidak ada yang perlu dibersihkan: setiap salinan lama memiliki isi yang tidak ada di salinan yang disimpan. |
| `panel.dl.cleanupInFlight` | Wait until {device} has received this text before cleaning up its copies. | Tunggu sampai {device} menerima teks ini sebelum membersihkan salinannya. |
| `panel.hist.removeFolderOwnOnly` | Folders of other texts with the same title are not touched. | Folder teks lain yang berjudul sama tidak disentuh. |
| `panel.up.asDelivered` | as delivered — nothing new to back up | seperti yang dikirim — belum ada yang perlu dicadangkan |
| `panel.up.awaitingTranscript` | waiting for its transcription | menunggu transkripsinya |
| `upload.buildFailed` | This text could not be prepared for sending. It is still saved on this device. | Teks ini tidak dapat disiapkan untuk dikirim. Teks tetap tersimpan di perangkat ini. |
| `upload.damagedHeld` | A queued copy was damaged and could not be sent. | Salinan dalam antrean rusak dan tidak dapat dikirim. |

## 10. Build order (tonight)

0. If G2 will not land: hide the cleanup row (stop-gap, §3).
1. `flextextStats` / `checkFlextextBytes` + tests.
2. G3 (smallest; removes cross-text contamination from send and trash paths).
3. G2 (`cleanupPlan` + review modal).
4. G1a/b (chooser, "Will send", the choice UI, `sentFileId`) — together with G4's panel half.
5. G5 (device queue integrity).
6. G4 (device skip, `deliveredSig`, inventory flags).
7. G1c (device hold) — only with the maintainer's go-ahead; it changes how a device answers a command.

After each: `node --test "test/*.test.mjs"` (0 fail) and the ESM parse gate; then real clicks on the
dev rig for the move choice, the cleanup review and a damaged queue record. No version bump and no
RELEASES entry on this branch.

## 11. Open questions for the maintainer

1. **G1c** — keep a text on the source when it changed after the move (proposed), or accept today's
   upload-then-remove and only flag it?
2. **Deleting an untouched placeholder without an upload** on release. It holds nothing, so the
   upload is pure noise — but it would be the first exception to the upload-first delete rule, so it
   is not proposed without an explicit yes.
3. **A researcher toggle for G4** (back up untouched deliveries anyway)? Proposed: no — the chip
   says why nothing was sent.
4. **Order of the candidate list in `pick`** — newest first (proposed) or richest first? Either way,
   nothing is preselected.
