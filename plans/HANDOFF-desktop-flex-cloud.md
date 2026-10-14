# HANDOFF — build the FlexText Segmenter for FLEx (desktop shell) in a cloud session

You are a Claude Code session in the cloud: Linux, **no FieldWorks, no Windows, no VM, no
pythonnet runtime for LibLCM**. Your job is to build as much of the FLEx desktop shell as can be
built and tested without FLEx, against a **mock LCM layer**, on a branch of
`rulingAnts/flextext-editor`, and to leave a precise list of what must be verified later on the
Windows VM with real FLEx.

Do not copy this handoff file into the repository. The plan file (below) is the public document.

---

## 0. Read first

1. The repo's `CLAUDE.md` and `DEVELOPERS.md`, in full. Where they and this handoff differ on
   pushing, deploying or versioning, **the stricter rule wins**.
2. The plan: `plans/flex-desktop-segmenter.md`. If it is not on your base branch, it was handed
   to you with this prompt — commit it as the **first** commit on `desktop-flex`, unchanged. It is
   authoritative for design; this handoff is authoritative for process. Every LCM behaviour in it
   is marked **[verified]**, **[source]** or **[unverified]** — keep those labels honest in code
   comments.
3. `docs/js/native-audio.js` (header) and `check-native-containment.sh`: the existing native-seam
   pattern you will mirror.
4. `docs/js/external-link.js`, `docs/js/flextext.js` (tokeniser, `APP_ITEM_TYPES`, media-file
   handling), and the undo rings in `docs/js/app.js` (`undoStack`/`redoStack` for the editor,
   `mgUndoStack` for the Matcher).
5. `electron/README.md` — the other Windows shell. **Do not modify `electron/`.**

## 1. Branches — hard rules

- Find the latest engine line: `git ls-remote --heads origin time-gaps`. If `time-gaps` exists,
  base on it; otherwise base on `time-untimed`. Record which one (and its SHA) in your report.
- Create **`desktop-flex`** from that base. Engine work for M0 (§3) goes on its own branch
  **`seg-word-split`** from the same base (so it can ship to the web on its own); merge it into
  `desktop-flex` with `--no-ff`. If the base branch moves while you work, rebase both onto it.
- Push only `desktop-flex` and `seg-word-split`. **Never** push, merge into, rebase, or open a PR
  against `main`, `beta`, `beta-tier`, `productionWeb`, `staging`, or any `time-*` branch.
- **Never deploy anything**: no `deploy.sh`, no `wrangler`, no `gh workflow run`, no Actions
  dispatch, no Pages publish, no release or pre-release, no tag.
- **Do not add or change `.github/workflows/**`** (repository cost policy: workflows need Seth's
  explicit approval and a cost statement). The Windows build is a local `build.ps1`, not a
  workflow.
- Versioning: do **not** run `bump-version.sh` or change `ENGINE_VERSION` / `sw.js` VERSION / any
  satellite VERSION line. If a test demands a bump, leave it failing, explain it in the report,
  and let Seth assign the number at release time.

## 2. Non-negotiables to carry into the code

- **Privacy — the repo is public.** Commit no text titles, speaker names, vernacular (Fayu) text,
  Drive URLs, tokens, project names from Seth's machine, or real-data captures. All fixtures are
  made up (use strings like `aaa bbb§ ccc`). Grep your diff before every push.
- **Seth's write-safety rule (2026-10-13):** *"make sure any of our writes use ALL the extra
  undo-safe, partial-write-prevention, protections found in flextools normally (including what
  flex tools GUI would have). We don't want any partial writes or corrupted data possible at
  all."* — implement plan §5 exactly: verified backup before any change; one unit of work per user
  action; rollback on any exception; in-UOW invariants; `StopSaveTimer` at open; log-capture
  poisoning; disk read-back of `.bak` vs `.fwdata`; never `CloseProject()` on a poisoned session.
- **Seth's undo rule (all projects):** one user action = exactly **one** Undo item and **one**
  Redo item, however many objects it touches. Editor actions → one item in the engine's ring; one
  Save to FLEx → one LCM UOW → one FLEx-history item. Tests assert one Undo restores everything
  and one Redo redoes all of it. Extend the existing undo additively; never rewrite it.
- **Content-filter rule:** the shell is not a browser. Only `http://127.0.0.1:<fixed port>/`
  content; every other navigation refused; `http(s)` links handed to the OS default browser with
  no fallback; no URL input; no HTTP endpoint for FLEx operations; FLEx features need no network.
  The navigation guard is a pure, table-tested function (plan §2.2).
- **Containment:** `docs/js/native-flex.js` is the only engine file that may reference
  `window.pywebview`; extend `check-native-containment.sh` to enforce it. The engine must behave
  exactly as today in a browser.
- **Copy-only:** dev builds refuse writes unless the project carries the disposable-copy marker
  (plan §12.3). Fail closed.
- No WSL/Git Bash/bash assumptions on Windows: Windows-side scripts are PowerShell or Python.
- **pywebview pitfalls (plan §2.4) — read them first.** The `js_api` object is exposed to the page
  recursively (every public member must be an `@exposed` method, nothing else — `test_api` pins
  it); the `webview.start()` function runs before the window exists; pywebview's own WebView2
  handlers run before yours. Each has already cost a VM round trip on two projects.

## 3. What to build (in order)

### M0 — engine, on `seg-word-split` (ships on the web first)
Engine changes usable everywhere, behind no shell check:
1. **Word split** and **word insert** in the web Segmenter (they change the baseline). One user
   action = one undo item. Rules match plan §6.5 so a later FLEx write is a minimal diff.
2. **`§` as a boundary marker**: hide a phrase-final `§` punct item, never offer it for editing,
   round-trip it unchanged in `.flextext` import/export.
3. Warnings (computed everywhere; Save-to-FLEx-blocking only in the shell): phrases with no
   word-forming character; internal end-of-sentence + letter inside a phrase.
4. Paragraph split/join and phrase↔paragraph conversion where the doc has paragraph structure.
5. Tokenisation accepts an injected set of extra word-forming characters (default unchanged).
Node tests for each, including undo/redo granularity. Add i18n strings for **every** UI language
the repo carries (there is an i18n parity test).

### M1 — shell skeleton, on `desktop-flex`
`desktop/flexshell/` per plan §2: `server.py` (127.0.0.1 only, fixed port + nonce, Host check,
CSP, path confinement, `/media/<token>`), `navguard.py` (pure) + WebView2 wiring isolated in a
module that is only imported on Windows, `api.py` (dispatcher, never raises into JS, error codes
from plan §3), `worker.py` (single worker thread, job queue, one project per process, one job at a
time), `native-flex.js` + containment rule + contract version, `hello()`. Everything must import
and test on Linux **without** pywebview or pythonnet installed (lazy imports).

### M2–M6 — against `lcm_mock`
- `port.py` (`FlexPort`), `lcm_mock.py` modelling every behaviour listed in plan §13.1, each with a
  comment naming the VM result it encodes; `lcm_real.py` written from the call sequences below,
  **marked untested** at the top of the file.
- `prechecks.py`, `protocol.py` (W1–W10), `segmentation.py` (§6 recipes), `glosses.py` (§7),
  `diskcheck.py` (§5.4 W8, real XML parser, `el.tail = None`, self-closing `rt`), relink/attach,
  import (FLEx importer called through the port), elan-mode export through the port.
- Engine side: diff of FLEx base doc → typed ops keyed by GUID (plan §4.2), Save-to-FLEx preview
  UI, FLEx history buttons (plan §4.4), `docs/js/printview-tsv.js` + tests (plan §10; the LingTeX
  round-trip test is SKIPPED, not passed, when `LINGTEX_TOOLS` is unset).
- **Contract tests** in `desktop/tests/contract/`, parameterised by backend, so the same files run
  on the VM against `lcm_real`.
- Fault-injection tests for every W-step failure: each ends rolled back or poisoned, never
  half-written.

### M7 (prepare only) — packaging
`desktop/build/stage_engine.py` (fails on off-origin subresources), `build.ps1` (PyInstaller
`--onedir`), `requirements.lock` with pinned versions and hashes, `desktop/README.md`. Do not run
a Windows build.

## 4. Verified LCM call sequences to encode in `lcm_real.py`

(From two independent VM sessions on a disposable copy, FieldWorks 9.3.12, SIL.LCModel
11.0.0.55180, ModelVersion 7000072, Python 3.13, pythonnet.)

- Open: `FLExProject().OpenProject(name, writeEnabled=…, undoable=True)` (never `undoable=False`).
  `usm = IUndoStackManager(cache.ServiceLocator.GetService(IUndoStackManager))` (`GetInstance[T]`
  is not reachable from pythonnet); `usm.StopSaveTimer()` immediately.
- UOW: refuse if `ah.CurrentDepth > 0`; `h = UndoableUnitOfWorkHelper(ah, undo, redo)`; …;
  success → **`h.set_RollBack(False)`** (the property assignment `h.RollBack = False` silently
  leaves it rolling back); `h.Dispose()`. On exception leave RollBack true and Dispose; if Dispose
  throws and depth is 1, `ah.Rollback(0)`.
- Save: `usm.Save()` at depth 0, then
  `ds = IDataSetup(cache.ServiceLocator.GetService(IDataSetup))` (namespace
  `SIL.LCModel.Infrastructure`); `ds.GetType().GetMethod("CompleteAllCommits").Invoke(ds, None)`.
- Backup: `ProjectBackupService(cache, BackupProjectSettings(cache, None,
  FwDirectoryFinder.DefaultBackupDirectory, fwVersion))` with all `Include*` false, then
  `.BackupProject(HeadlessThreadedProgress(), None)` at depth 0.
- Peers: `SharedBackendServices.AreMultipleApplicationsConnected(cache)`.
- Import: `clr.AddReference("ITextDll")`; `SIL.FieldWorks.IText.LinguaLinksImport(...)
  .ImportInterlinear(HeadlessThreadedProgress(), [path])` inside our UOW (it joins it).
- Export: FLEx's `InterlinearExporter`, mode **`elan`** (mode `xml` drops all times).
- Undo/redo: `ah.Undo()` / `ah.Redo()` directly; require `UndoResult.kuresSuccess`.
- Reparse probe: `ParagraphParser(cache).ForceParse(para)`; FLEx's own tab-open routine is
  `InterlinMaster.LoadParagraphAnnotationsAndGenerateEntryGuessesIfNeeded(stText, True)` in
  `ITextDll.dll`.
- Invariant: `[s.BeginOffset for s in para.SegmentsOS] == [x.IchMin for x in
  SegmentServices.GetSegments(para.Contents, cache.WritingSystemFactory)]`, no zero-length segment.
- Every LCM call on **one** worker thread: a UOW begun on one thread and disposed on another
  wedges the session (`LockRecursionException`, then `NullReferenceException` on Save).
- Project sharing (`SharedSettings\LexiconSettings.plsx`, `projectSharing="true"`) makes the lock
  file useless for detecting other openers → write mode requires sharing off.
- Silent save failure: no exception, `HasUnsavedChanges` false, only an ERROR log record; the
  next save then drops the failed edit. Capture the log; poison on any ERROR.

## 5. Tests you must leave green (or explain)

- The repo's full existing suite (as `CLAUDE.md`/`DEVELOPERS.md` describe), plus your new node
  tests, plus `./check-native-containment.sh`.
- `python -m pytest desktop/tests` on Linux: navguard table, server (Host check, path
  confinement, port nonce, media tokens), prechecks, diskcheck, protocol fault injection, contract
  tests on the mock, segmentation recipes, gloss algorithm branches (i)/(ii)/(iii), undo
  granularity.
- A privacy grep over the whole diff (no vernacular text, titles, names, URLs with tokens).

## 6. Report back (your final message)

Base branch + SHA; commits pushed on `desktop-flex` and `seg-word-split`; test results (pass /
fail / skipped, with the reason for each skip or failure); every place where you had to guess an
LCM behaviour the plan does not mark **[verified]** (these join the VM list); any test that
demands a version bump; decisions you need from Seth (plan §14 plus new ones).

## 7. What must be verified later on the VM with real FLEx — and how

**Always on a fresh disposable COPY of a project, never on a production project.** With FLEx
closed: copy the project folder under FLEx's projects folder to a new name, rename the `.fwdata`
inside to match, add `flextext-disposable-copy.txt`, take a restore-point copy of the `.fwdata`,
record FW/LCM/model versions. Before each run's first write, assert the open project is that copy
(cache project name, `.fwdata` file name and folder name all equal). At the end, diff the
`.fwdata` against the restore point.

1. **Conformance:** `python desktop/vm/run_conformance.py --project <copy>` — the contract tests
   against `lcm_real`. Any mismatch with the mock is a bug in the mock or in `lcm_real`; fix and
   re-run.
2. **Navigation guard e2e + persistence (V-10):** `desktop/vm/test_navguard_e2e.py` on real
   WebView2 (off-site `location`, `window.open`, `_blank`, iframe, meta refresh, form POST,
   non-blob download all refused; OS-browser stub records only the expected URLs); relaunch keeps
   IndexedDB; port-taken nonce check.
3. Plan §15 list, each on the copy:
   - **V-1 FLEx GUI round trip** (needs Seth at FLEx): after shell writes for every op type, open
     each touched text in FLEx's Baseline, Interlinear, Gloss and Print tabs, close FLEx, re-read
     and diff against the shell's post-write snapshot; elan-mode export shows `§` as a phrase-final
     punct item and phrase GUIDs = segment GUIDs.
   - V-2 auto-save race stress; V-3 kill during save (20×) and the `.bak + .tmp` state; V-4 failing
     undo action; **V-5 poisoned close leaves disk untouched**; V-6 backup in File ▸ Restore and
     restore-as-new identical, truncated backup rejected; V-7 throwing change listener; V-8 real
     FLEx holding the project (sharing off: lock error + lock JSON; stale-lock takeover; sharing
     on: FLEx as a peer seen by the peer check); V-9 newer-model exception mapping; V-11 relink
     path form; V-12 new trivial analysis + approval objects; V-13 golden Print-view clipboard
     capture by Seth (scratch only); V-14 fragile repair (only if needed); V-15 PyInstaller onedir
     build on a clean account; V-16 other FW 9.x versions.
4. Only after all of that and Seth's explicit go: lift the copy-only flag (a release stamp), and
   only then may the shell write to a real project.
