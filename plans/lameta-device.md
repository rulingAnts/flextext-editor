# A lameta project as a device (PLAN, being built — 2026-09-27)

**Status:** in progress on branch `lameta-device`. Milestones and what Seth checks at each are at
the end. Companion contract: `plans/lameta-progress-spec.md`.

**2026-10-09: M1–M4 are merged into `main`** (the branch is 0 commits ahead), so M5 onward
continues from `main` on a feature branch. **The lameta app this agent serves is now usually
FlexText Metadata**, Seth's lameta fork (`plans/flextext-metadata.md`). It writes an open marker,
`<project>/.flextext-open.json`, and watches `Sessions/`.
- While the marker is fresh (heartbeat < 2 minutes old), new session folders may be written at
  once, and rewrites of existing `.session` files stay queued.
- With no fresh marker, everything below applies unchanged, because stock lameta gives no such
  signal.
- The contract is `plans/flextext-metadata.md` §5.

Seth, 2026-09-27: *"a Tauri or Electron-shell (or Chrome PWA with file system permissions?) version
of Researcher Panel let's the user browse to and link their lameta project file (and then the
sessions folder becomes basically a 'device' into which FLExText Editor texts can be moved in or
out. Each text in the sessions folder for that project gets our manifest file so that it can be
moved to and from other FLExText Editor apps and devices. For each text, the primary sound file and
(if it exists) flextext file need to be identified."*

Decisions taken with Seth the same day: the agent runs **inside the Researcher Panel as an
installed Chrome/Edge PWA** (File System Access API behind a seam; a shell can supply the same
folder handle later); move-out is a **checkout** (files stay, custody moves); existing sessions are
adopted **one at a time**; the suite's bookkeeping lives in a **`flextext/` subfolder** inside each
session; ELAN inside lameta is **view/listen only** in v1; **owner-only** linking. This reopens the
2026-08-12 note in `BACKLOG.md` ("no native shell for the panel") — Seth reopened it.

## 1. Why the agent lives in the panel, and what that costs

- The panel already holds every instance key (`getKi`, `docs/js/researcher.js`) and every route a
  device uses is an existing one. What the panel cannot do is *report*: the report route
  authenticates an **install**. So the agent **is** an install — of an ordinary `type=''` instance
  the panel creates, invites, claims and approves itself. No worker change, no schema change;
  `instance.type`'s CHECK constraint stays; `inventory.type:'lameta'` drives the badge.
- **Chromium desktop only.** Firefox and Safari cannot pick a local folder. The UI says so plainly.
  An installed PWA on current Chrome/Edge keeps the folder permission across sessions; a tab gets
  one click per session. The `files.js` seam is what makes a Tauri/Electron shell a later
  substitution rather than a rewrite.
- The panel must be open for the device to sync — like a phone must be on.

## 2. Loading and storage rules

- `docs/js/files.js` and `docs/js/lameta-agent.js` are reached from `researcher-panel.js` **only by
  dynamic `import()`**. `test/shells-precache-startup-modules.test.mjs` walks static imports only,
  so nothing here enters the five offline app shells; the researcher satellite's `sw.js` precaches
  nothing.
- `docs/js/sync.js` is **not** refactored: module singletons, the `flextext-sync-session` key, an
  `eraseAllData` on wipe, precached everywhere. The agent copies `randTok`, `uuid`, `sha256hex`, the
  seq-filter/ack loop and the backoff, and talks through `researcher.js`'s `api()` with
  `auth:false` plus `x-fx-install`/`x-fx-secret`. Extracting a shared device core is the job of
  the day a Kr-less shell agent is wanted.
- Storage: files.js's own IndexedDB `flextext-files` (one store): a record per link at
  `<accountId>:lameta:<instanceId>` holding the folder handle AND the install identity together, plus
  an index at `<accountId>:lameta-index`. (Built v692; the plan said `flextext-lameta` with two stores.) Never `flextext-sync-session` or the `flextext-sync` database — the
  panel also runs on the editor origin (`?mode=researcher`), where those belong to the editor's own
  install. The folder handle and the install credentials live together because the folder is on
  this computer; another browser sees the card but "linked on another computer".

## 3. What lives in a session folder

```
Sessions/<id>/
  <id>.session                      written ONCE, when the folder is created
  <id>.flextext  <id>.eaf  <id>.pfsx  the annotation set, replaced in place on a return trip
  <recording>                       never overwritten, never deleted
  <id>.converted-NOT-ARCHIVAL.wav   when the recording is not WAV
  <file>.meta                       for files WE created, once; existing ones are never rewritten
  flextext/                         ⚠ invisible to lameta and to archive exports
    flextext-manifest.json          birth facts — the immutable copy of the Drive manifest
    flextext-history.json           custody and events — the agent's own record
```

- **Custody is never in the manifest** (`plans/drive-as-truth.md` §16.12: birth facts in the
  manifest, everything assigned later in the history file). `flextext-history.json`:
  ```json
  { "schema": 1, "docId": "…",
    "custody": { "holder": { "kind": "lameta|device|unassigned", "id": "…", "name": "…" }, "since": "…" },
    "events": [ { "at": "…", "kind": "created|adopted|assigned|moved|checked_out|returned|renamed",
                  "from": {}, "to": {}, "by": { "kind": "lameta-agent", "id": "…" } } ] }
  ```
  **D1 `drive_object.instance_id` is the authority**; the local history is a mirror reconciled from
  the estate on every run (D1 wins; the panel shows "stale since …" until the text returns).
- The agent finds sessions by the **docId in the manifest**, never by folder name: lameta renames the
  folder and every id-prefixed file when a session id is edited; the subfolder survives, and file
  hashes in the manifest let the annotation set be re-matched after a rename (the media references
  inside `.flextext`/`.eaf` then need repair — a queued lameta update).
- Session id: `lametaSessionIdFor(title, docId, existing)` = lameta's own sanitizer over the title;
  `_2`, `_3` on collision with a folder whose manifest carries a different docId; an existing folder
  is never renamed; the folder name is never derived from the docId (opaque, and it may end in `_`).
- Nothing is ever written directly under `Sessions/` (every directory there is a session) and
  `HOW-TO-OPEN.txt` never enters a project: the zip download keeps it, the agent does not.

## 4. Commands, as the agent interprets them

| command | device meaning | lameta meaning |
|---|---|---|
| `assign` | fetch and hold | materialize `Sessions/<id>/`, or refresh the annotation set on a return trip |
| `uploadDelete` | upload first, then delete | **checkout**: upload `.flextext` (+ `.eaf`/`.pfsx`), record custody, stop reporting the text; files stay |
| `triggerUpload` | back up | the checkout's upload step alone |
| `setDone` | flip the flag | flip locally + queue a `.session` Status update |
| `changeSettings` | merge | merge `vernLang`/`analLang`/`doneEnabled`, echo in `inventory.settings` |
| `delete` | delete | **refused** with a toast, acked |
| `{wipe:true}` | erase everything | **unlink**: `wipe-ack`, forget the link, touch no file |

- `removeEntry` is never called anywhere in `lameta-agent.js`; the only deletions are IndexedDB
  records. A test pins it. Erase / force-remove / Remove-text are not rendered for a lameta card.
- **Ack rule differs from a phone's, deliberately.** A failed `assign`/`uploadDelete` is not acked:
  it stays queued on the card with its error and a Retry / Skip. A phone acks-and-moves-on because
  nobody is watching it; here somebody is.
- **A checkout is a normal `/move`.** The panel's move flow re-parents the text's Drive folder to the
  destination device and issues `uploadDelete` to the source; the agent answers by uploading the
  current annotation set to the text's Drive folder (a bare `.flextext` at the text level, which
  `pickSourceFiles` selects for the move) and recording custody. Reporting at once — the text
  leaves the lameta inventory — is what lets `pendingMoves` advance `'removing'` → done. Return =
  a `/move` back to the lameta instance; the agent sees itself as holder and pulls the new files.
- **Return trip file rules**: match by role and hash, not name; `.flextext`/`.eaf`/`.pfsx` replaced
  in place, the previous `.flextext` saved to `<project>/lameta-agent-backups/<date>/` (never
  inside the session, where lameta would list it); the recording is never overwritten — a returned
  recording with a different hash is written beside it as `<name>.returned-<date>.<ext>` and
  reported; `.session` and existing `.meta` untouched.

## 5. Inventory

Built from a folder scan cached per poll, in `syncGatherInventory`'s shape (`docs/js/app.js`):
`type:'lameta'`, `platform:'lameta'`, `engineVersion: ENGINE_VERSION` (≥ v138 makes the lameta
device a legal move destination), items = sessions whose history says custody is here:
`{ id: manifest.docId, title, hasAudio, modified, done, pendingDelete: checkoutInFlight, uploadState,
uploadedFileId, lameta: { sessionId, cloudPending } }`. Every held text is reported, so
`sweepUnassigned` never files it; a checked-out text is reported by its holder. Sessions whose
files are not downloaded yet (cloud-synced folders) are listed as "not downloaded yet" and skipped
by Adopt/checkout until they are; nothing ever blocks the loop.

## 6. Adopt (per session, explicit)

Candidates are root files only. Primary recording: audio by extension, minus
`*.converted-NOT-ARCHIVAL*` and `consent-*`, prefer lossless, then largest; several in the top class
→ a choice (name, size, WAV duration). Flextext: exactly one `*.flextext` → take it (title from
`parseFlextext`); none → audio-only adopt; several → ask. An `.eaf` present → role `elan-eaf`.
Then: mint `docId = crypto.randomUUID()`; `Researcher.assignBegin(instanceId, docId, title)`
creates the Drive text folder with `originals/` under the lameta device's folder and stamps
`drive_object`; upload the manifest first, then audio and flextext through `runAssignUpload`'s
path minus the finish/assign half (resumable), ending after the uploads; write `flextext/` locally
with custody `lameta`; read the existing `.session` for `Status` (→ done) and `Contributions`
(→ manifest contributors) — read only, never rewritten.

## 7. Pending lameta updates

`record.pendingLameta[]` holds Status changes, stage fields (per the spec), and the media-reference
repair after a rename. The card lists them with "Apply — lameta is closed" (`confirmModal`); apply
re-reads each file, merges monotonically, preserves everything else verbatim, writes. There is no
lock to check: lameta has none.

## 8. Recovery

Lost folder handle (IndexedDB cleared, folder moved) → "Reconnect…" picks again and verifies the
`.sprj` `ProjectName`/`guid` or any manifest docId, then resumes. Revoked install (410 on poll) →
forget the link locally, files untouched. Linking the same project from a second browser revokes
the first install, as any device re-pair does.

## 9. Milestones

| M | Build | Seth checks on staging (against a COPY of the lameta project — staging is the real account) |
|---|---|---|
| 0 | this plan, the spec, the doc corrections | — |
| 1 | ✅ v690 — Workstream 1 release: sanitizer port, 25 roles, type table, the `done`/contributors defects, manifest schema 3 | the lameta download passes lameta's naming rule; Status and contributors right |
| 2 | ✅ v691 (staging) — `files.js` + tests; hidden "Link…" that only picks and lists `Sessions/` | Chrome: folder picked, sessions listed, permission survives an installed-PWA relaunch; Firefox: the honest message |
| 3 | ✅ v692 (staging) — `researcher.js` helpers; agent link + poll/report; card badge/status/gates | a "linked" lameta card with the badge and engine version, zero texts; Unlink; second-browser link revokes the first |
| 4 | ✅ v693 (staging) — Adopt (recording + .flextext to Drive; the ELAN file stays in the session until the worker accepts an `elan-eaf` upload) | an adopted session appears; Files ▾ builds ELAN/lameta downloads from the Drive copy; Move… offered |
| 5 | ✅ v710 (branch only, `lameta-device-m5 v1`) — `assign` materialize + the open marker (§10) | a phone's text moved in; lameta reopened shows it; ELAN opens the EAF; media ref right; nothing of ours listed; the fork lists it live |
| 6 | checkout + return | out: phone holds it, card stops listing it, files remain; back: annotation set refreshed, `.session` untouched |
| 7 | setDone/changeSettings/triggerUpload/delete/wipe; pending-updates box; recovery | Done queues; Apply writes once lameta is closed; Erase absent; revoke → unlink only |
| 8 | gates audit, i18n EN/ID, RELEASES, bump, docs; then the real project | full suite, `check-native-containment.sh` |

## 10. Where the build stands, and how to continue (2026-10-10, M5 built)

**Built:** M0 docs; M1 = v690; M2 = v691 (`files.js`, the hidden Link preview); M3 = v692
(`lameta-agent.js`: link/poll/report/held commands, the card's badge, status line and gates); M4 =
v693 (Adopt through the assign-upload queue; `flextext/` written after the bytes land) — all four
**in production since v709** (merged to `main`, released with the `?lameta=1` gate still on). **M5 =
v710, `BUILD_TAG 'lameta-device-m5 v1'`, on branch `lameta-device` only** (built overnight,
2026-10-10; not merged to `staging` or `main`, not deployed anywhere — no preview build has been
dispatched, no worker touched). Everything stays behind `?lameta=1` and owner-only.

### What M5 does (v710)

- **`assign` is a handler, no longer held** (`HANDLED = changeSettings, delete, assign`; `HELD =
  uploadDelete, triggerUpload, setDone`). The panel's Move… re-parents the text's Drive folder to
  the lameta device and issues `assign`; the agent ignores the command's streaming URLs and, as the
  researcher, calls `R.listTextFiles(lametaInstanceId, docId)` (roles from Drive's tags) and
  `R.fetchDriveFile` for the manifest, the recording, the `.flextext` and the consent receipt.
- **Two more injected deps** keep it node-testable: `convertWav` (the panel passes the same
  `convertAudio(…, { format: 'wav', wavBits: 16 })` call the loose-file converter uses) and
  `parseFlextext` (needs a DOMParser at call time, so it is a dep rather than an import; the agent
  statically imports only `segmentsFromOffsets` from `flextext.js` — the isolation test now allows
  exactly `flextext.js`, `lameta.js`, `seg-exports.js`).
- **Session id** = `lametaSessionIdFor(title, docId, scan)`: a folder whose manifest carries this
  docId is a return trip and keeps its name; otherwise the title's id with `_2`, `_3` on a
  case-insensitive collision; a folder that exists under the chosen id without our manifest is
  refused (`session_folder_taken`), never written into.
- **Files** (built by the same code as the panel's lameta download): `parseFlextext` +
  `segmentsFromOffsets` → `assembleSegEntries({ wants: { eaf: true }, full: false })` gives
  `<id>.eaf` / `<id>.pfsx` and, when the recording is not WAV and the text is aligned, the derived
  `<id>.converted-NOT-ARCHIVAL.wav` (above `conversionCaps`' ceiling the lossy original is the
  timeline, as in the download); the recording under `<id>.<ext>`; `lametaFlextextMedia` repoints the
  fetched XML's media reference at the file that ships (byte-for-byte otherwise);
  `lametaSessionEntries` gives the layout, the `Sessions/<id>/` prefix is stripped and
  `HOW-TO-OPEN.txt` is dropped (`LAMETA_ROOT_FILES`). `.session` only when the folder is NEW;
  `.meta` only beside files this pass created; `flextext/flextext-manifest.json` = the Drive bytes,
  written once; `flextext-history.json` written LAST (`newHistory({ kind: 'assigned' })`, custody
  `{ kind: 'lameta', id, name: nickname }`). Stages via `deriveStages`; `Suite_Doc_Id`,
  `Flex_Text_Guid`, `Suite_Stamp` in the CustomFields; the receipt's `signatureName` as a speaker.
- **Return trip:** `.flextext` / `.eaf` / `.pfsx` replaced in place, the previous `.flextext` copied
  to `<project>/lameta-agent-backups/<date>/` first (a second trip the same day gets a time-stamped
  name); the recording is matched by hash and never overwritten — different bytes are written beside
  it as `<name>.returned-<date>.<ext>` (with a `.meta`) and noted in the history event; the
  `.session` and every existing `.meta` are untouched; `withHistoryEvent(h, { kind: 'returned' })`
  moves custody back; the stage facts the return brought go into **`link.pendingLameta[]`**
  (`queueLametaUpdate`: one entry per session and kind, stages merged monotonically) — the §7 queue,
  which M7 applies. On a return to an ADOPTED session the `.flextext` to replace and the recording to
  leave alone are the ones the session's manifest names (match by role, not name), when still there.
- **Ack rule:** `ack` only after the history file is written. A throw anywhere holds the command with
  its error (`status().heldFail`), nothing behind it is acked, the lane is re-read each tick; the
  failed command is not retried on its own within `HELD_RETRY_MS` (5 min) — the card shows the error
  with **Retry** (`retryHeld`) and **Skip** (`skipHeld`, confirmed first; acks it untouched).
- **The open marker** (`plans/flextext-metadata.md` §5): `readOpenMarker(F, handle)` reads
  `<project>/.flextext-open.json` through the seam with a 3 s timeout (a cloud placeholder reports
  `absent` + `timeout`, never a hang); `openMarkerState` is pure: `fresh` / `stale` (heartbeat older
  than 2 min) / `absent`. The agent reads it every tick (`status().openMarker`). `lametaWritePolicy`:
  a new session folder is written at once in EVERY state (fresh: the fork's watcher lists it live;
  absent/stale: lameta lists it on reopen — today's behaviour, unchanged); a rewrite of an existing
  `.session` is queued in every state; the queue may be APPLIED only while the marker is not fresh.
  **`pendingGate(instanceId)`** is that gate — the card reads it now ("cannot be applied while the
  project is open"), and M7's apply must call it first.
- **Card:** a working line (list / fetch N% / convert / build / write), the failed command with
  Retry / Skip, "FlexText Metadata has this project open", the pending count, and the last result
  ("Session X written — reopen lameta" / "— already listed in the open project" / "refreshed; the
  previous .flextext is in lameta-agent-backups/"). EN + ID strings added.
- **Tests:** `test/lameta-agent-assign.test.mjs` (16 tests, fake folder with file contents, fake
  researcher serving a text by role, fake converter and parser): the new-session folder listing to
  the file, the WAV and audio-less cases, the id collision, the return trip (backup, untouched
  recording/.session/.meta, the queued stages, the twin), the ack/hold/Retry/Skip rule, the marker's
  three states, the timeout, the policy and its wiring. `panel-lameta-gates` pins the injection and
  the card. Full suite 797/797 (`node --test test/*.test.mjs`), `check-native-containment.sh` and
  `check-secrets.sh` clean.

### What Seth checks on a PREVIEW build (the M5 row of §9) — against a COPY of the lameta project

Dispatch *Deploy to staging / preview* from `lameta-device`, ticking **researcher** (and editor, for
`?mode=researcher`); the agent runs in the installed researcher panel with `?lameta=1`.

1. Link the copy (M3), confirm the badge. Move a phone's text (one with a recording and an aligned
   `.flextext`) to the lameta device with Move…. Watch the card: "Working on …: fetching / converting
   / writing", then "Session `<id>` written".
2. `Sessions/<id>/` holds exactly: `<id>.session`, `<id>.flextext`, `<id>.eaf`, `<id>.pfsx`, the
   recording as `<id>.<ext>`, `<id>.converted-NOT-ARCHIVAL.wav` when the recording is not WAV, one
   `.meta` beside each, and `flextext/` with the manifest and history. **Nothing of ours listed by
   lameta**, no `HOW-TO-OPEN.txt`, nothing directly under `Sessions/`.
3. Reopen the project in lameta: the session lists with the title, Status (In_Progress unless Done),
   the languages, the speaker from the consent receipt, and the `Stage_*` / `Suite_Doc_Id` rows.
   "Open in ELAN" on the EAF: tiers vernacular-first, waveform from the derived WAV, times right.
   **The `.flextext`'s media reference names the WAV that is there** (open it in FLEx: no media hunt).
4. The card now lists the text (inventory `items`), the panel's device view shows it moved; Files ▾
   works on it (the Drive folder is unchanged).
5. Return trip: move the text out to a phone (M6 is not built — do this with a second device if the
   move offers it, or skip) and back: the annotation set refreshed, the old `.flextext` under
   `<project>/lameta-agent-backups/<date>/`, the recording's mtime unchanged, the `.session` unchanged,
   the card saying "1 update(s) to existing sessions waiting".
6. Failure path: move a text whose Drive folder has no `.flextext` and no recording → the card shows
   the error with Retry / Skip; nothing was written; Skip asks first.
7. With FlexText Metadata (the fork) running on the project: the card says it is open; a moved-in
   text appears in the fork without a reopen; the pending line says the updates cannot be applied
   while it is open. Quit the fork → the line changes within a tick. Kill it → after 2 min the same.

### Unverified (fakes only — nothing in M5 has run in a browser yet)

- The real File System Access handles under `ensureDir` / `statFile` / `writeFile` for the backup
  folder at the project root and for a session folder written in one pass; the installed-PWA
  permission across the whole sequence.
- `convertAudio` on a real phone recording through the injected `convertWav` (progress reaches the
  card via `s.work.pct`); the EAF's `MEDIA_URL` against the file lameta/ELAN see on Windows.
- The `.session` written with stages opens in stock lameta 3.0.21-beta without complaint (same caveat
  as `plans/lameta-session-export.md` §6) and in the fork.
- A pre-manifest (legacy) text: no roles on Drive → the `.flextext` is picked by name only and a
  recording without a role is NOT picked (the text materializes audio-less). Decide whether to fall
  back to audio-by-extension before M8.
- The move flow still calls `Researcher.adoptText` (which mints streaming URLs the agent never reads)
  before `assign`; harmless, but a lameta destination could skip it.
- `cmd.done` on `assign` is never set by the panel's move flow, so a Done text arrives `In_Progress`
  until `setDone` (M7); the inventory's `done` comes from the `.session` on the next scan.

**Release notes:** `CLAUDE.md` requires the `RELEASES` modal entry before any PRODUCTION push. Not
written — this is a feature build (`BUILD_TAG` set), nothing is released, and the entry belongs to
the release that will carry M5–M8 together (M8). No deploy of any kind was made in this session.

### How it was before M5 (2026-09-27, for the record)

**What Seth checks before M5 is worth building** (staging = the real account; use a COPY of the
lameta project): the folder permission survives a relaunch of the INSTALLED panel; Link makes a
device with the `lameta` badge; Adopt of one session uploads its recording + `.flextext`, the
session gains `flextext/`, lameta still lists nothing new, Files ▾ works on the adopted text.

**M5 — `assign` materialize (a phone's text moved in), the plan that fits what is built** (✅ built
as above; kept because it is the spec the code follows):
- The agent already HOLDS `assign` (`HELD`); M5 turns it into a handler. Do not use the command's
  streaming URLs: the agent is the researcher, so `R.listTextFiles(docId)` (roles) +
  `R.fetchDriveFile(fileId)` fetch the manifest, the recording and the `.flextext`; inject both
  through `R` and inject `convertAudio` (Web Audio, browser-only) as a dep — the agent stays
  node-testable with a fake converter.
- Session id: `lametaSessionIdFor(title, docId, existing)` over the scan (`s.sessions` gives
  `{ name, docId }`); an existing session with this docId (a return trip) is refreshed, never
  renamed. Files: `parseFlextext` + `segmentsFromOffsets` → `assembleSegEntries({ wants: { eaf: true },
  full: false })` for `<id>.eaf`/`.pfsx` (+ the derived WAV when the recording is not WAV),
  `lametaFlextextMedia` for the `.flextext`, `lametaSessionEntries(session, files, suiteFiles)` for
  the layout — strip the `Sessions/<id>/` prefix and write into the session dir; skip
  `HOW-TO-OPEN.txt` (LAMETA_ROOT_FILES). `.session` only when the folder is new; `.meta` only for
  files that did not exist; on a return trip replace `.flextext/.eaf/.pfsx` in place, back the old
  `.flextext` up to `<project>/lameta-agent-backups/<date>/`, never touch the recording (a different
  hash → `<name>.returned-<date>.<ext>`). Stages via `deriveStages` (the manifest's consent/audio, the
  parsed doc); `docId`/`flexGuid`/`engine` into the CustomFields; `done` from the command/inventory.
- History: `newHistory({ kind: 'assigned' })` on creation, `withHistoryEvent(h, { kind: 'returned' })`
  on a return trip; custody `{ kind: 'lameta', id: instanceId, name: nickname }`.
- Ack only after every file is written (the ack rule); failure keeps it held and shows on the card.
- The panel's Move… already offers the lameta device (engineVersion ≥ v138 reported).

**M6 — checkout (`uploadDelete`) and return:** upload the current `.flextext` (and `.eaf`/`.pfsx`
once the worker's upload-start accepts kinds `elan-eaf`/`elan-pfsx` — today it accepts only
audio/flextext/consent-prompt/manifest, so the EAF upload needs that one worker line) to the text's
Drive folder as the INSTALL (`x-fx-install` headers on the install upload route), skip when the
hash matches the last upload, read `R.getMoves()` for the destination, write custody
(`checked_out`), stop listing the text (inventory) so `pendingMoves` advances, then ack.

**M7:** `setDone` → local + queued `.session` Status/stage update (`mergeStages`, `lametaStatusFor`,
the `Suite_Stamp` rule) applied on "lameta is closed"; `triggerUpload` = the checkout's upload
alone; `delete` stays refused; recovery (Reconnect… on a lost handle).

**M8:** remove the `?lameta=1` gate, EN/ID pass, RELEASES, DEVELOPERS.md, then the real project.

**Deferred, not forgotten:** the worker deploy (v687's `prompt=select_account` + v690's
`sha256Checksum` listing field + the `elan-eaf` upload kind) — prepare a rollback first
(`wrangler deployments list` / `rollback`) and deploy next week; the corpus-keeper
`lameta_core.py` CustomFields prerequisite (spec §7); the lameta PR (Workstream 3) — draft the #74
design comment for Seth to post before any code.
