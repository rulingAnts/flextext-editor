# A lameta project as a device (PLAN, being built — 2026-09-27)

**Status:** in progress on branch `lameta-device`. Milestones and what Seth checks at each are at
the end. Companion contract: `plans/lameta-progress-spec.md`.

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
| 5 | `buildConversionSources` + `buildLametaSessionFiles`; `assign` materialize | a phone's text moved in; lameta reopened shows it; ELAN opens the EAF; media ref right; nothing of ours listed |
| 6 | checkout + return | out: phone holds it, card stops listing it, files remain; back: annotation set refreshed, `.session` untouched |
| 7 | setDone/changeSettings/triggerUpload/delete/wipe; pending-updates box; recovery | Done queues; Apply writes once lameta is closed; Erase absent; revoke → unlink only |
| 8 | gates audit, i18n EN/ID, RELEASES, bump, docs; then the real project | full suite, `check-native-containment.sh` |

## 10. Where the build stands, and how to continue (2026-09-27, end of session)

**Built (branch `lameta-device`, on staging):** M0 docs; M1 = v690 (also fast-forwarded onto
`satellite-apps-v566`, the production candidate); M2 = v691 (`files.js`, the hidden Link preview);
M3 = v692 (`lameta-agent.js`: link/poll/report/held commands, the card's badge, status line and
gates); M4 = v693 (Adopt through the assign-upload queue; `flextext/` written after the bytes land).
Everything is behind `?lameta=1` and owner-only. `satellite-apps-v566` stays at v690 until the
device is complete; production has not moved.

**What Seth checks before M5 is worth building** (staging = the real account; use a COPY of the
lameta project): the folder permission survives a relaunch of the INSTALLED panel; Link makes a
device with the `lameta` badge; Adopt of one session uploads its recording + `.flextext`, the
session gains `flextext/`, lameta still lists nothing new, Files ▾ works on the adopted text.

**M5 — `assign` materialize (a phone's text moved in), the plan that fits what is built:**
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
