# FlexText Metadata (for lameta): a Windows lameta fork as a suite device (PLAN, 2026-10-09)

**Status:** planned 2026-10-09; building starts the same night. The app is a fork of lameta,
developed on branch **`flextext-metadata` of `rulingAnts/lameta`**, which carries a copy of this
plan at `docs/flextext-metadata/PLAN.md`. **This file owns the suite side**: the device contract
(§5) and how the lameta-device milestones (`plans/lameta-device.md`) meet the fork. Decisions
internal to the fork are recorded in its copy from now on.

Seth, 2026-10-09: *"What I need is just offline (enhanced with checklist and flexicon/LCM
integration) lameta with S3-storage integration (for lameta project-folder backup, all contents of
a project)."* It is Windows desktop only because flexicon runs only on Windows, and Python is
bundled so users install nothing. *"We need this lameta fork to be integrated with flextext
researcher panel as a 'device'."* Later: *"share that S3 folder with other lameta users on the same
project."*

The same session first planned a **browser port** of lameta, with the project in Drive or S3 and a
"virtual device". That was dropped once flexicon made the app Windows desktop only. A browser port
needed a rewrite only because a browser can't touch the disk or run Python; lameta is already a
Windows desktop app (Electron 37, TypeScript, Vite, electron-builder), so forking it keeps every
feature for free.

Builds on: `plans/lameta-session-export.md` (the session format), `plans/lameta-device.md` (the
agent), `plans/lameta-progress-spec.md` (progress fields v1).

## Decisions

| Topic | Decision |
|---|---|
| Base | **Fork lameta.** Branch `flextext-metadata` off **upstream `V3`** (6 commits ahead of `master`, which is a subset). TypeScript under lameta's own build |
| Name | **FlexText Metadata (for lameta).** Its own `productName` / `appId` / settings store, so it installs beside stock lameta. lameta's MIT notice is kept, and "lameta" is used only to describe compatibility |
| Licence | New code in the fork is **AGPL-3.0-or-later**; lameta's own files keep MIT and its notice |
| FLEx library | **flexicon**: `MattGyverLee/flexicon`, PyPI `pyflexicon` ≥4.12,<5, **LGPL-2.1-or-later**, Windows only, needs `pythonnet >=3.0.3,<3.2`. Formerly flexlibs2: import `flexicon`, never `flexlibs2` (that alias goes in v5). A fork of cdfarrow/flexlibs |
| Python | A **PyInstaller `--onedir` helper exe**, started by Electron, speaking **newline-delimited JSON-RPC 2.0 over stdin/stdout**. **One long-lived helper per app session** |
| FLEx access | **Shared mode**: FLEx *Project Properties → Sharing → "Share project contents with programs on this computer"*, so the helper reads and writes while FLEx is open |
| Builds | **Windows x64 on GitHub `windows-latest`**. Not on a Parallels VM on Apple silicon: that is Windows on ARM and would build arm64. Such a VM can still *test* the x64 build under emulation |
| Backup | **rclone**, the whole project folder to an S3-compatible bucket; never destructive. Team sharing later |
| Device | **The Researcher Panel's lameta-device agent is the device.** The fork cooperates with it (§5) |
| Checklist | **Seth's whole corpus checklist, user-customizable**, with import of existing `.crpck` data matched to sessions |

## 1. Child processes: what went wrong before, and what this design does instead

An earlier app of Seth's, **bulk_audio_normalizer**, began in Electron and ended in Python because
of child processes. Its `python_webview/COMPARISON.md` records what happened on Windows:
- `taskkill /T /F` sometimes missed child processes.
- ffmpeg kept running after the app closed.
- Process groups were unreliable.

The app started an ffprobe/ffmpeg **per file per phase**, and Stop had to find and kill all of
them. The Python version worked because **psutil reliably finds and kills every child**.

So Node never manages more than one process here:
1. **One helper, reused.** Per-item work is queued inside the helper, never a process per item.
2. **Cancel is a message** (`{"method":"cancel","params":{"id":N}}`), not a kill. Killing is
   only for shutdown and crash recovery.
3. **The helper owns its lifetime.** It exits when its stdin closes (Electron quit or crashed),
   with a parent-PID watchdog behind that.
4. **Python supervises the only grandchild.**
   - The helper puts itself in a Windows **Job Object with `KILL_ON_JOB_CLOSE`**, so rclone, which
     it starts, dies with it whatever the cause.
   - rclone runs as `rclone rcd` on loopback with a random token. Backups are rc jobs, stopped
     with `job/stop` and watched with `core/stats`.
5. **Electron's spawn rules (main process only):**
   - `shell:false` (a killed `cmd.exe` wrapper is how grandchildren get orphaned),
     `windowsHide:true`, not `detached`.
   - Drain stderr always.
   - stdout carries protocol only: UTF-8, flushed per line.
   - On quit: a `shutdown` request, three seconds, then `kill()` of that ONE process.
6. **`--onedir`, never `--onefile`.** A onefile exe is a bootloader parent plus the real child, and
   killing the parent orphans the child.
7. A PID file, plus a sweep for a stale helper at the next launch.
8. Inside the helper (fdat's findings): a stdin reader thread and **one LCM worker thread** that
   calls `FLExInitialize()` and owns the project. LCM is not documented as thread-safe.
9. **A regression test on `windows-latest`, without FLEx:** kill the parent abruptly, then assert
   the helper and rclone are gone within five seconds.

**Why Electron stays the parent** (Seth asked whether the Python helper should launch the fork
instead):
- **Failure isolation.** The helper is the newest and riskiest code. As a child, its crash means
  "FLEx features unavailable, restarting"; as the parent, its crash would close lameta mid-edit.
- **Electron's launch model** assumes it is started directly: the single-instance lock, `.sprj`
  file association, auto-update relaunch, and taskbar pinning (a pinned window points at the
  Electron exe, bypassing a launcher).
- **No reliability gain.** The part that failed before, managing process trees, is already
  Python's job here.

**Fallback:** if the §1.9 test fails, a Python launcher holding a kill-on-close Job Object around
Electron. The JSON-RPC contract is unchanged, so the switch is local.

## 2. The flexicon helper

- **Base:** fdat's `desktop/sidecar/fdat_lcm.py` (public `rulingAnts/fdat`, branch
  `claude/stoic-albattani-oevuus`). It has the JSON-RPC 2.0 `serve` loop and session handling;
  move it from `flexlibs` to `flexicon`.
- **First methods, read-only:**
  - `ping`, `listProjects`, `openProject`, `listTexts`, `readText(guid)`
  - `textStats(guid)`: segmented / transcribed / glossed / translated fractions
  - `readGenres`, `readPeople`, `sharingStatus`
- **Writes come later**, in short `BeginNonUndoableTask` / `EndNonUndoableTask` / `Save` windows.
- **Shared mode (fdat's plan §7, verified in LCM source):**
  - LCM promotes a project to its shared backend when sharing is enabled.
  - Peers coordinate through a global mutex and a commit log.
  - A peer sees FLEx's edits only on commit, so poll with `IUndoStackManager.Save()` while holding
    no open unit of work.
  - Sharing off with the project locked raises `FP_FileLockedError`: **show the Sharing-tab remedy;
    never toggle the setting silently.**
  - `FP_MigrationRequired` means "open it in FLEx once first".
  - The setting travels with Send/Receive.
- **Start-up checks, with plain messages:**
  - FieldWorks is installed.
  - Python's architecture matches FieldWorks (x64): flexlibs' README warns that a mismatch fails
    at import with an unhelpful error.
  - The FieldWorks major version is one this flexicon pin was tested with.
- **Licences in the bundle:**
  - flexicon is collected as plain `.py` files, so the LGPL library stays replaceable, with its
    licence and a source link.
  - pythonnet and clr_loader ship no licence files, so their MIT texts are added by hand
    (bulk_audio_normalizer found this).
  - rclone is MIT.

## 3. S3 backup (rclone)

- **Credentials:** endpoint, region, bucket, prefix, key id and secret, with the secret encrypted
  by Electron `safeStorage` (DPAPI on Windows). They are passed to rclone in its environment
  per job, never written to a plaintext `rclone.conf`. A test-connection check runs before saving.
- **A backup never destroys.** `sync --backup-dir <prefix>-history/<timestamp>` moves anything
  overwritten or deleted on the remote aside. Everything is backed up except OS clutter and the
  §5 marker.
- **UI:**
  - Back up now, with progress.
  - Last-backup time.
  - Optional automatic backups.
  - **Restore to a new folder**, never over the open project.
  - A bandwidth limit for poor connections.
- **Team sharing (later):**
  - `rclone bisync` among a project's team;
  - per-person keys scoped to the project prefix;
  - a conflict policy. lameta has no locking, so probably one editor per session at a time,
    plus conflict copies.

## 4. The corpus checklist

- **Source:** Seth's corpus checklist, a single-page app in a private repository.
  - 20 steps (14 visible, 6 that appear when a selected target requires them).
  - A 0/1/2 state per text, done at a 95% bar.
  - Targets built from six rule kinds (`count`, `eachChild`, `named`, `coverage`, `quantity`,
    `checklist`), plus "what to do next".
  - A 32-node genre tree with OLAC codes, custom fields, and the `.crpck` exchange format.
- **Published model.** Seth decided to publish the *model only*: step list, genre tree, targets and
  the pure functions. It goes to the fork's `docs/flextext-metadata/checklist-model/`, without the
  original's hosting details or any list data.
- **New work** (planned for the original but never built there): a step editor, plus whatever of
  hybrid targets and an archive baseline is decided later.
- **Storage (progress spec v2, extending `plans/lameta-progress-spec.md`):**
  - `<project>/progress-steps.json`: v1's file plus `full` / `order` / `hidden` / `aliases`.
  - `<project>/flextext-checklist.json`: genres, facets, targets, stimuli, custom fields,
    collection checklist state.
  - `Sessions/<id>/flextext/progress.json`: `steps {id: 0|1|2}`, `status`, `consentHold`,
    `genres[]`, `primaryGenre`, `facets`, `satisfies[]`, `custom{}`.
  - **The `Stage_*` CustomFields are mirrored on every save** (2 → `done`, 1 → `in_progress`,
    0 → absent), with v1's Status rule, so stock lameta and corpus-keeper still see progress.
- **Derived steps** come live from FLEx through `textStats`, and never lower a stored state.
- **`.crpck` import** matches by FLEx text GUID (`Flex_Text_Guid`), then by title.

## 5. The suite device, and the contract between the fork and the agent

The project is an ordinary lameta folder on the researcher's disk. So the panel's lameta-device
agent (`docs/js/lameta-agent.js` + `files.js`, built through M4 and in production behind
`?lameta=1`) links it exactly as it would a stock lameta project.

What the fork changes is the cooperation. Stock lameta has no lock and no file watcher, which is
why the agent queues every rewrite of an existing `.session` until the researcher confirms lameta
is closed.

**The open marker: `<project>/.flextext-open.json`**

```json
{ "app": "FlexText Metadata", "version": "…", "pid": 1234, "since": "2026-10-09T20:00:00Z",
  "heartbeat": "2026-10-09T20:05:30Z" }
```

- **The fork:**
  - writes it when a project opens;
  - rewrites `heartbeat` every 30 seconds;
  - deletes it on close;
  - excludes it from backups.
- **Staleness:** a marker whose `heartbeat` is more than 2 minutes old is stale and treated as
  absent; a crash leaves one behind.
- **Why the project root is safe:** lameta loads files there but never displays or saves them.
- **The agent, when the marker is fresh:**
  - new session folders are written at once, and the fork's watcher loads them live;
  - rewrites of existing `.session` files stay queued, as today.
- **The agent, when the marker is absent or stale:** it behaves exactly as designed for stock
  lameta.
- **Later (M7):** the fork applies the agent's queued `.session` updates in-process, through a
  request file in `Sessions/<id>/flextext/`. That contract is written when M7 starts.

**Suite milestones still to build** (`plans/lameta-device.md` §9–10):
- **M5:** a moved-in text becomes a session.
- **M6:** checkout and return.
- **M7:** setDone, changeSettings, recovery.
- **M8:** gates, i18n, release.

`lameta-device` is fully merged into `main`, so the work continues from `main` on a feature branch.

## 6. Fork hygiene

- ⚠ **Upstream's workflow publishes releases.** `onset/lameta`'s `.github/workflows/main.yml`
  builds Windows + macOS and **publishes a GitHub Release** on every push to `V2`, `beta`,
  `release` or `V3`, and a fork inherits it.
  - It is **disabled on the fork**.
  - Even so, never push those branch names there.
- ⚠ **Telemetry is off.** Upstream sends Sentry error reports and Segment analytics. A rebranded
  fork must not report into upstream's accounts, and nothing should leave a researcher's machine
  unasked, given the privacy obligations this suite carries to the communities it serves.
- **The fork's own workflow:**
  - `windows-latest`, x64, with its actions pinned.
  - A PyInstaller helper; rclone pinned and checksum-verified.
  - `electron-builder --win --x64 --publish never`.
  - Artifacts only: **no releases, no secrets, no schedule.**
  - Unsigned for now; price code signing before any release.
- **No pull requests against `onset/lameta`** from this branch: in a fork, `gh pr create` defaults
  to the upstream. Anything meant for upstream (the #74 checklist) goes later as a clean per-feature
  branch.

## 7. Phases

| P | Where | Build |
|---|---|---|
| A0–A5 | fork | rebrand + telemetry off; helper manager + helper skeleton (fake flexicon); rclone backup; open marker + Sessions watcher; checklist model port; Windows CI incl. the §1.9 test |
| B1 | this repo | lameta-device **M5**, plus reading the open marker |
| S1 | Windows, supervised | **spike:** the CI-built x64 helper opens a COPY of a real project in shared mode **while FLEx has it open**, lists texts, computes `textStats`; FLEx's integrity check stays clean |
| later | both | checklist targets / genres / next / report UI, `.crpck` import UI, FLEx → lameta sync, helper writes, M6–M8, team sharing, signing |

## 8. Verification

- **Fork:** its unit tests against a baseline recorded before any change; pytest for the helper
  with a fake flexicon; the §1.9 test on `windows-latest`.
- **Backup:** back up, restore to a new folder, hash-compare every file; delete a file, back up
  again, and find it in the history prefix.
- **Compatibility:** after checklist edits, stock lameta 3.0.21-beta opens the project with nothing
  lost and the `Stage_*` rows visible.
- **Device:** a phone's text moved in through the panel appears live in the fork as a new session.

## Open

- Code-signing cost.
- A courtesy note to the lameta maintainers.
- How corpus-keeper's FLExTools modules and this app divide FLEx → lameta sync. This app may take
  over corpus-keeper's planned resident phase.
