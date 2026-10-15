# FlexText Segmenter for FLEx — a Windows desktop shell

Status: **plan**, 2026-10-13. Nothing here is built yet. Every LCM behaviour this plan relies on
is labelled **[verified]** (shown on real FieldWorks 9.3.12 / SIL.LCModel 11.0.0.55180,
ModelVersion 7000072, on a disposable copy of a real project, with a second independent session
re-checking the claims), **[source]** (read in liblcm 018befb8 / FieldWorks a90754c8, not run), or
**[unverified]** (still needs a VM test, listed in §15).

> ⚠ **Seth's non-negotiable (2026-10-13):** *"make sure any of our writes use ALL the extra
> undo-safe, partial-write-prevention, protections found in flextools normally (including what flex
> tools GUI would have). We don't want any partial writes or corrupted data possible at all."*
> And his standing rule for every app: **one user action = exactly one Undo item and one Redo
> item.** §5 is built around both. Note that FlexTools' own protections turned out to be a *weak
> floor* (§5.1); this plan goes well past them.

> ⚠ **Privacy (public repo).** This file and everything committed beside it contain no text
> titles, speaker names, vernacular text, Drive URLs or tokens. Test fixtures are made up.
> Real-data captures (golden clipboard copies, census output) stay in scratch, never in git.

---

## 1. What it is

A Windows-only **pywebview** shell around the Audio Segmenter. It runs the *same engine* as the
web app (`docs/js/…`), served from `127.0.0.1`, and adds FLEx features that only make sense with a
local FieldWorks install:

| Feature | Writes to FLEx? |
|---|---|
| Open a FLEx text in the Segmenter (and close it) | no |
| Edit it: baseline/words, phrase and paragraph structure, word glosses, free/literal translations, times | only on **Save to FLEx** |
| Match an untimed FLEx text to its recording (the engine's Matcher) | only on Save to FLEx |
| **Save to FLEx** — change preview → backup → one atomic write → disk read-back | yes |
| Relink a recording whose file is missing | yes (via Save to FLEx) |
| Import a `.flextext` into FLEx (explicit File action, FLEx's own importer) | yes (creates a text) |
| Export a FLEx text as an editor bundle (audio + generated `.flextext`) | no |
| Export a FLEx text as an ELAN bundle (`.eaf` + audio) | no |
| Copy the current line as FLEx Print-view TSV | no |

Edit scope, enforced in Python (not just hidden in the UI):

- **May change:** paragraph `Contents` in the default vernacular WS (baseline and word forms are the
  same string, so they stay in sync by construction); segment boundaries (via §, §6); paragraph
  boundaries; `Segment.FreeTranslation` / `LiteralTranslation` in user-chosen analysis WSs;
  which `WfiGloss` an occurrence points at, and the `Form` of a gloss **used only by that
  occurrence** (§7); segment `BeginTimeOffset` / `EndTimeOffset` / `MediaURIRA`; a missing
  `CmMediaURI.MediaURI` path (relink).
- **Never changes:** morpheme analyses (`WfiMorphBundle`, `MoForm`, `MSA`, sense choice,
  `CategoryRA`), lexicon (`LexEntry`, `LexSense`), wordform case, guesses, shared glosses in
  place, notes (moved only as LCM itself moves them on a join), `SpeakerRA` (copied only onto the
  new half of a split), writing-system definitions, custom fields, project settings.
- **FLEx texts are opened and closed by the Segmenter, never created or deleted by it.** The single
  creation path is the explicit **Import .flextext** action (§9), which uses FLEx's own importer.
  Nothing in the shell ever deletes a `Text`, `StText`, `CmMediaContainer` or `CmMediaURI`.

Everything outside FLEx stays **identical to the web app**: same engine build, same UI, same
pairing, same send/receive with the researcher panel, same exports. The shell adds; it does not
fork.

---

## 2. Architecture

```
flextext-editor/
  docs/js/native-flex.js     ← NEW: the ONLY engine file that may touch window.pywebview
  docs/js/…                  ← engine, unchanged except features gated through native-flex.js
  desktop/                   ← NEW: the shell (Python)
    flexshell/
      app.py                 ← entry: start server, create window, install nav guard
      server.py              ← 127.0.0.1 static server for the bundled engine + media tokens
      navguard.py            ← pure navigation policy (unit-tested) + WebView2 hooks
      api.py                 ← js_api object: one dispatcher, never raises into JS
      worker.py              ← the single LCM worker thread + job queue
      port.py                ← FlexPort: abstract interface of every LCM operation we use
      lcm_real.py            ← FlexPort on pythonnet/LibLCM (Windows only)
      lcm_mock.py            ← FlexPort in pure Python, models the verified LCM behaviours
      prechecks.py           ← pure-filesystem checks before open (lock, sharing, version…)
      protocol.py            ← Save to FLEx: preview, backup, UOW, invariants, save, read-back
      segmentation.py        ← the § recipes (§6), written against FlexPort
      glosses.py             ← gloss choice algorithm (§7), written against FlexPort
      diskcheck.py           ← .bak vs .fwdata validator (streaming XML)
      fwfind.py              ← locate FLEx install, projects dir, versions (registry)
      clipboard.py           ← CF_UNICODETEXT writer (Windows), no-op elsewhere
    tests/                   ← pytest; runs on Linux against lcm_mock
    vm/                      ← conformance suite: same scenarios against lcm_real, on a COPY
    build/                   ← PyInstaller spec, build.ps1, stage_engine.py
    README.md
```

### 2.1 The native seam (`docs/js/native-flex.js`)

The repo already has one chokepoint for native globals: `docs/js/native-audio.js`, enforced by
`check-native-containment.sh` (Capacitor and `__flextextNative`). The FLEx shell gets a **second,
separate chokepoint with the same rules**:

- `native-flex.js` is the only file allowed to reference `window.pywebview`. Extend
  `check-native-containment.sh` with a rule 1c for `pywebview` and a header check
  (`THE ENGINE AUTO-UPDATES. THE SHELL DOES NOT.`), plus `EXPECTED_FLEX_CONTRACT` stated exactly
  once.
- Why a separate file and not more code in `native-audio.js`: that file's header forbids touching
  it for unrelated work, because installed APKs depend on it.
- **Inert on the web.** Every export is safe in a browser. `isFlexShell()` returns false;
  `flex.*` calls reject with `E_NOT_SHELL`. The engine shows FLEx menus/buttons **only** when
  `isFlexShell()` is true and the contract matches.
- **Contract check.** `hello()` returns the shell's `contract`; on mismatch the seam refuses all
  FLEx features and says so (same posture as `EXPECTED_CONTRACT` in `native-audio.js`).
- **Waiting for the bridge.** pywebview injects `window.pywebview.api` asynchronously and fires
  `pywebviewready`. The seam exposes `whenFlexReady()` (resolves on the event or immediately if
  already present; resolves `false` after a short timeout in a browser).
- `external-link.js` asks the seam for `openExternal(url)` when in the shell (it imports from the
  seam; it never touches the global).

### 2.2 Local content only (Seth's content-filter rule)

The shell must never become a browser. Rules, all enforced in Python, fail-closed:

1. **The engine is bundled and served from `http://127.0.0.1:<port>/`** by `server.py`, bound to
   `127.0.0.1` only (never `0.0.0.0`). No directory listing; paths are resolved and must stay
   inside the bundle root; the `Host` header must equal `127.0.0.1:<port>` (DNS-rebinding defence).
   Response headers include a CSP: `default-src 'self'; frame-src 'self'; form-action 'self';
   connect-src 'self' <the relay worker origin(s)>; img-src 'self' blob: data:; media-src 'self'
   blob:`.
2. **Fixed port, stable origin.** IndexedDB is per-origin, so a random port would lose the user's
   Segmenter data every launch. Use a fixed port (default `8017`, configurable). At startup, if the
   port is taken, query `/__flextext_shell_nonce`; if the answer is not this process's nonce,
   refuse to start with a clear message (never fall back to another port silently).
3. **Persistent storage.** `webview.start(gui='edgechromium', private_mode=False,
   storage_path=<%LOCALAPPDATA%\FlexTextSegmenterFLEx\webview>)`. pywebview's default private mode
   would wipe IndexedDB on exit. Refuse to start on any backend other than Edge WebView2.
4. **Navigation guard** (`navguard.py`): a pure function `decide(url, kind)` →
   `allow | open_external | refuse`, unit-tested, wired to WebView2 events through
   `window.native` (the WinForms form) → `CoreWebView2`:
   - `NavigationStarting` and `FrameNavigationStarting`: allow only `http://127.0.0.1:<port>/…`,
     `about:blank`, and `blob:`/`data:` **frames** created by our own origin; cancel everything
     else. A top-level `http(s)` navigation elsewhere is cancelled **and** handed to the OS
     default browser; anything else (`file:`, `ftp:`, custom schemes, `javascript:` targets) is
     just cancelled.
   - `NewWindowRequested`: always `Handled = true` (no second webview ever); `http(s)` →
     OS browser via `os.startfile(url)` (Cold Turkey governs that browser). No fallback: if the OS
     refuses, nothing opens.
   - `DownloadStarting`: allow only when the source is `blob:http://127.0.0.1:<port>/…` (the
     engine's own exports); everything else cancelled.
   - Settings: `AreDevToolsEnabled = false` (release), `AreDefaultContextMenusEnabled = false`,
     `IsStatusBarEnabled = false`, `AreBrowserAcceleratorKeysEnabled = false` (no F5-to-anywhere,
     no Ctrl+P print-to-URL tricks; the engine's own shortcuts are handled in JS),
     `IsZoomControlEnabled` left as is.
   - If any hook cannot be installed, **the shell refuses to show the window**.
5. **No URL input anywhere**, no "open URL" command, no in-app browser view.
6. **Network is only data, never content.** `fetch` to the relay worker (pairing, send/receive) is
   allowed by CSP `connect-src`; no off-origin page, script, style, font or frame is ever loaded.
   All engine subresources must be same-origin: `stage_engine.py` fails the build if the staged
   bundle references an off-origin script/style/font/frame.
7. **FLEx features need no network.** Every FLEx call goes through `js_api` in-process. There is
   **no HTTP endpoint for FLEx operations** (a local HTTP write API could be driven by any web page
   via CSRF or DNS rebinding). The only non-static HTTP route is `/media/<token>` (§8.3).
8. **Flows that would need an off-site page** (e.g. Google sign-in, if any Segmenter path uses it)
   are not available in the shell: the seam reports `capabilities.offsiteAuth = false` and the
   engine hides those entry points. Audit this in M1.

**Navigation-guard tests** (required before any build is handed out):
- `desktop/tests/test_navguard.py`: table-driven — own origin paths allowed; `127.0.0.1` with
  another port, `localhost`, `[::1]`, `http://127.0.0.1.evil.example`, `https://example.com`,
  `file:///C:/`, `javascript:`, `data:text/html` top-level, `blob:` from another origin,
  userinfo tricks (our host and port placed before an `@`, so the real host is elsewhere), percent-encoded and mixed-case hosts,
  IDN hosts — each with the expected decision.
- `desktop/vm/test_navguard_e2e.py` (Windows, real WebView2): a test page on our origin tries
  `location.href = 'https://example.com'`, `window.open(...)`, `<a target=_blank>`, an `<iframe>`
  to an external URL, `<meta http-equiv=refresh>`, a form POST off-site, `history.pushState` to an
  external origin, and a download from a non-blob URL. Pass = the page stays on our origin, no
  second window exists, and the OS-browser handoff stub recorded exactly the expected `http(s)`
  URLs (the stub replaces `os.startfile` in test mode; no browser is opened during tests).

### 2.3 The Python side

- **One LCM worker thread** owns the cache, created at startup, COM-initialised as STA. Every
  `js_api` call (pywebview calls them on assorted threads) enqueues a job and waits on a
  `Future`. **[verified]** a unit of work begun on one thread and disposed on another leaves the
  first thread holding UndoStack's write lock: every later UOW fails with
  `LockRecursionException` and `Save()` throws `NullReferenceException` — the session is wedged.
  (STA specifically is FLEx's own convention; that it matters for these calls is **[unverified]**.)
- **One open project per process**, enforced by a registry in `worker.py`. **[verified]** a second
  `OpenProject` of the same project inside one process succeeds (LCM's lock is per process/peer).
- **One job at a time.** A second write request while a job runs returns `E_BUSY`.
- **Exceptions never cross into JS.** `api.py` wraps every call: `{ok: true, result}` or
  `{ok: false, error: {code, message, detail}}`.

### 2.4 pywebview pitfalls — hit on TWO projects now (Seth, 2026-10-14: *"Last project you made had this problem too."*)

Read these before writing a line against pywebview; each one cost a VM round trip, and the second
one cost it twice.

1. **The `js_api` object is exposed to the page RECURSIVELY.** `util.parse_api_js` walks every
   attribute without a leading underscore: a method becomes `window.pywebview.api.<name>`, and a
   non-callable object is walked in turn. So a public `worker` hands the page `worker.run()`, a
   public `server` hands it `server.stop()`, and a stored pywebview `window` sends the walker into
   WinForms (`native.AccessibilityObject.Bounds.Empty.Empty…`) until *maximum recursion depth
   exceeded* — the symptom both projects showed. **Rule:** every public member of the api object is
   an `@exposed` method and nothing else; attributes and wiring methods are underscored.
   `desktop/tests/test_api.py::test_the_page_can_reach_only_exposed_methods` reimplements the walk
   and fails on anything else.
2. **The function handed to `webview.start()` runs at once, in its own thread, before the window
   exists.** `window.native` is `None` there, and WebView2 has not begun initialising. Anything that
   needs the native window waits for `window.events.shown`, then runs on the UI thread
   (`native.Invoke`, as pywebview does), and attaches to `CoreWebView2` either at once or from
   `CoreWebView2InitializationCompleted`. Destroying the window while that initialisation runs is
   what WebView2 reports as **E_ABORT** — a consequence, not a cause. `SystemExit` raised in that
   thread ends the thread, not the process; use `os._exit` to refuse to run.
3. **pywebview's own CoreWebView2 handlers are subscribed first and run first.** It cancels every
   download (`ALLOW_DOWNLOADS=False`) — re-allow yours by setting `Cancel = False` after it; and it
   turns every `NewWindowRequested` into a navigation of the same window (or, with
   `OPEN_EXTERNAL_LINKS_IN_BROWSER=True`, the default, opens the OS browser itself, bypassing any
   policy of yours). Set that to `False` and swallow the follow-up navigation.
4. **Build-time output is read through a pipe encoded as cp1252 on Windows** (pip's wheel build): a
   non-ASCII character in a `print()` fails the whole install. ASCII only in anything that runs
   under pip.
5. **pip does not reinstall a `git+…@branch` package whose version has not changed**, even when it
   resolves a newer commit — it prints "Requirement already satisfied" for the dependencies and
   installs nothing. Install with `--force-reinstall --no-deps`, and have the program print its
   source commit first thing so "which build is this" is never inferred from pip's output.
6. **A strict CSP refuses the shell page's own inline scripts.** The satellite shell sets
   `window.__MODE` in a classic inline `<script>`; under `default-src 'self'` WebView2 refused it,
   the engine booted as the EDITOR and the home screen was blank (header and badge rendered, body
   empty). `server.py` hashes every inline script in every staged `.html` into `script-src` at
   start-up — strict and self-maintaining, no `'unsafe-inline'`. Reproduced and fixed headless on
   Linux (Playwright against the staged engine) before the next VM round trip; do that first.
7. **The shell's `127.0.0.1` is not a developer's localhost.** The engine's `isLocalDev()` matched
   it and aimed at `http://localhost:8787` (the `wrangler dev` worker) with Turnstile test keys —
   nothing of which exists on a user's machine. The staged page carries
   `<meta name="flextext-flex-shell" content="1">` (stage_engine), `native-flex.js isFlexShellPage()`
   reads it synchronously, and `isLocalDev()` is false on it: the shell talks to the production
   relay worker as an installed app. **Backend step, Seth's:** the production worker's
   `ALLOWED_ORIGINS` must carry the exact plaintext origin `http://127.0.0.1:8017` (`originAllows`
   accepts an exact `http://` entry, never a pattern) before pairing from the shell can work.
   OAuth callbacks are not in play: v1 has no researcher sign-in from the shell (`offsiteAuth:
   false`).
8. **pyflexicon is `flexicon`; FLExTools' `flexlibs` is a DIFFERENT library on the same machine.**
   `lcm_real` imported `flexlibs` first "as pyflexicon's import name" — wrong: pyflexicon 4.x is
   `flexicon` (`flexlibs2` its deprecated alias), and a FLExTools install provides a `flexlibs`
   whose `OpenProject(projectName, writeEnabled)` has no `undoable` and opens one session-long
   non-undoable task (`TypeError … unexpected keyword argument 'undoable'`, fifth VM launch).
   `_flexicon()` imports `flexicon` then `flexlibs2`, never `flexlibs`, and checks the signature.
   And **`FLExInitialize()` once per process before the first open** (registry, ICU, offline SLDR):
   without it liblcm finds the SLDR down, renames the project's `.ldml` files to `.ldml.bad` and
   re-synthesises writing systems on every open (pyflexicon #249) — a write to the project folder
   even read-only. `FLExCleanup()` at exit. Headless UI and `DisableDataMigration` are pyflexicon's
   own defaults **[source]**; its `FP_*` open errors map to our codes by class name.
9. **.NET namespaces are read from source, never from memory.** The sixth launch opened the project
   and died on the next line: `IUndoStackManager` imported from `SIL.LCModel.Infrastructure` — it is
   in `SIL.LCModel` (InterfaceDeclarations.cs). Cross-checking every `from SIL… import` in
   `lcm_real.py` against liblcm `src/`, FieldWorks `Src/` and pyflexicon found five more:
   `SharedBackendServices` is `SIL.LCModel.DomainServices`; `FwDirectoryFinder` is FieldWorks'
   `SIL.FieldWorks.Common.FwUtils` (FwUtils.dll), not liblcm's; `HeadlessThreadedProgress` is
   pyflexicon's own class, not a liblcm type; `StopSaveTimer()` is on `IUndoStackManager`;
   `GetDiffsInTsStrings(old, new)` returns a `TsStringDiffInfo` (null when identical), not out
   parameters; `BackupProject(progress, out backupFile)` returns `(ok, path)` under pythonnet; and
   `InterlinearExporter.ExportDisplay()` dereferences its `InterlinVc`, so the export builds one with
   `InterlinLineChoices.DefaultChoices` as FLEx's own export dialog does. `test_lcm_real_lib.py`
   pins a name→namespace table taken from source; a new `from SIL… import` fails it until its
   namespace has been read from source too. Sparse clones for the lookup:
   `git clone --filter=blob:none --depth 1 https://github.com/sillsdev/liblcm` and the same for
   `sillsdev/FieldWorks` with `git sparse-checkout` on `Src/LexText/Interlinear`.
10. **pythonnet rules — read pyflexicon's code, not just liblcm's signatures** (Seth, after the
    seventh launch died on `'ILcmServiceLocator' object has no attribute 'GetInstance'`: *"Do we
    really have to do this one error at a time… go thoroughly read the pyflexicon documentation
    instead of just doing trial and error."*). The whole of `lcm_real.py` was then audited line
    by line against pyflexicon 4.13 (`github.com/MattGyverLee/flexicon`: `flexicon/code/*`,
    `docs/EXCEPTION_HANDLING.md`, `docs/TRANSACTION_GUIDE.md`, `lcm_casting.py`) and liblcm's
    `MasterLCModel.xml`. What a correct call looks like, each with pyflexicon's own usage as the
    witness:
    - services, factories, repositories: `ServiceLocator.GetService(IFoo)` (40+ uses); the generic
      `GetInstance<T>` is unreachable from pythonnet (`FLExProject.GetFactory` docstring).
    - an object by GUID: `ServiceLocator.GetObject(System.Guid(g))` (`FLExProject.Object`).
    - **interface typing is strict**: `ParagraphsOS` yields `IStPara` (no `Contents`, no
      `SegmentsOS`), `AnalysesRS` yields `IAnalysis` (no `Form`), `.Owner` is `ICmObject`. Cast:
      `IStTxtPara(p)`, `IWfiWordform(an.Owner)`, or by ClassName (`cast_to_concrete`; ours is
      `_cast`, total). `MediaFilesOA` is reached on the cast text.
    - multi-strings: `ITsString(ms.get_String(ws)).Text`; present alternatives are
      `ms.AvailableWritingSystemIds`; `IStTxtPara.Contents` is a bare `ITsString` whose run-0
      writing system is `Contents.get_Properties(0).GetIntPropValues(1, 0)[0]`.
    - `out` parameters, omitted from the call, come back in a tuple (`TryGetObject(tss)`,
      `BackupProject(progress)`).
    - a throwing CLR **property** getter surfaces as a bare `TypeError` with the .NET type
      stripped: probe state, never catch exception types around a property read.
    - edits to `Contents` go through `GetBldr()` + `ReplaceTsString` + `GetString()`
      (`SegmentOperations.SetBaselineText`); the assignment fires `AnalysisAdjuster`.
    - approvals: `IWfiAnalysis.GetAgentOpinion/SetAgentOpinion(lp.DefaultUserAgent, Opinions.…)`
      (interface-declared; pyflexicon's `SetApprovalStatus` writes the same opinion through
      `ICmAgent.SetEvaluation`).
    `test_lcm_real_lib.py` pins the source idioms and that no `GetInstance` is in code.
11. **The one-thread rule is enforced by a proxy, on the mock too.** Eighth launch: *"LCM call off
    the worker thread"* — the open had run on the worker, then `api.open_project` read
    `writing_systems()` on pywebview's bridge thread; and because that happened AFTER the open, the
    session stayed live holding the project's lock, so the next click reported *another program*
    holding it (our own). `worker.ThreadBound` now wraps every port — real and mock — and raises on
    any call off the worker thread, so the suite finds such a call on Linux; the open's read-back
    runs inside the job; a failure after the open closes the session without saving and releases
    the claim; a second open while one is live is `E_ALREADY_OPEN` before the pre-checks run.
    ⚠ Seth's Mac runs a separate LCM bridge server on the VM: if it holds the same project with
    sharing off, every open from the shell is `E_LOCKED_OTHER` for real; with sharing on, reads
    work and writes stay refused (§14).

---

## 3. Bridge API (`window.pywebview.api`, wrapped by `native-flex.js`)

All calls are async. Long operations return `{jobId}`; the seam polls `job_status`. Strings are
NFC on the JS side and NFD inside LCM; the bridge converts (`TsStringUtils.NormalizeNfd` on the way
in, NFC on the way out). Every write call takes a `previewToken`, never raw edits.

| Call | Input | Output | Notes |
|---|---|---|---|
| `hello()` | — | `{contract, shellVersion, engineVersion, fwVersion, lcmVersion, modelVersion, python, copyOnly, capabilities}` | No LCM work. `copyOnly` true in dev builds (§12.3). |
| `list_projects()` | — | `[{name, sizeBytes, headerVersion, sharing, lock: 'free'\|'flex'\|'other'\|'stale'\|'busy', crashedSave, localFixedDrive, cloudSynced, readOnlyFile, writable, reasons[]}]` | Pure filesystem (§5.3 B). Never opens a project. |
| `open_project(name, mode)` | `mode: 'read'\|'write'` | `{session, writable, reasons[], ws: {vern:[…], anal:[…]}, printViewConfig, glossWsDefaults}` | Write mode runs every §5.3 B/C check. Each WS entry: `{id, abbr, isDefault, rtl, graphite, wordForming: [extra chars]}`. |
| `close_project()` | — | `{saved: false}` | Never saves (writes happen only in `save_to_flex`). Releases the lock so FLEx can open the project. |
| `list_texts()` | — | `[{guid, title, paras, segs, timedSegs, media: [{uri, exists}], fragileParas, labelSegs}]` | Titles go to the UI only; never logged. |
| `open_text(textGuid)` | — | `{doc, baseRev}` | `doc` is the engine's flextext-shaped model (§4.1). `baseRev` = fingerprint hash of the text. Read-only; no UOW. |
| `close_text(textGuid)` | — | — | Drops the cached fingerprint. |
| `preview_save(textGuid, baseRev, ops)` | `ops` from the engine diff (§4.2) | `{previewToken, summary[], counts, warnings[], blockers[]}` | Validates scope, stale base, fragile paragraphs, empty phrases; computes the exact intended post-state. **No LCM write.** |
| `save_to_flex(previewToken)` | — | job → `{undoLabel, backup: {path, verified}, disk: {ok, changed: {class: n}}, newBaseRev}` | §5.4. |
| `undo_flex()` / `redo_flex()` | — | job → `{label, disk, newBaseRev}` | Undo/redo the last Save to FLEx (§5.5). |
| `relink_preview(textGuid, uriGuid, newPath)` | path from `pick_file` | same as `preview_save` | Refused unless the current target is missing (§8.2). |
| `export_editor_bundle(textGuid)` | — | job → `{zipPath}` | FLEx's own exporter, mode **`elan`** (§9.2), plus the audio file. |
| `get_media(textGuid)` | — | `{tracks: [{uriGuid, url: '/media/<token>', exists}]}` | §8.3. |
| `import_preview(path)` | `.flextext` path | `{previewToken, texts, paras, phrases, warnings[], blockers[]}` | §9.1. |
| `import_flextext(previewToken)` | — | job → `{newTextGuids, backup, disk}` | The only path that creates a FLEx text. |
| `printview_data(segGuid)` | — | plain data for the TSV generator (§10) | Read-only. |
| `copy_text(text)` | string | — | Puts exactly this on the clipboard as CF_UNICODETEXT only. |
| `pick_file(kind)` | `'media'\|'flextext'` | `{path}` or null | Native open dialog. |
| `open_external(url)` | `http(s)` only | — | OS default browser; no fallback. |
| `job_status(jobId)` | — | `{state, progress, result?, error?}` | |

**Error codes** (stable; the engine maps each to a translated message):
`E_NOT_SHELL, E_CONTRACT, E_BUSY, E_NOT_FOUND, E_ALREADY_OPEN,
E_FLEX_HOLDS_PROJECT, E_LOCKED_OTHER, E_LOCK_BUSY, E_SHARING_ON, E_PEERS_CONNECTED,
E_MODEL_NEWER, E_MODEL_OLDER, E_CRASHED_SAVE_STATE, E_NOT_LOCAL_DISK, E_CLOUD_FOLDER,
E_READONLY_FILE, E_DISK_SPACE, E_COPY_ONLY,
E_STALE_BASE, E_FRAGILE_PARAGRAPH, E_EMPTY_PHRASE, E_SCOPE, E_PREVIEW_EXPIRED,
E_BACKUP_FAILED, E_INVARIANT, E_ROLLBACK_INCOMPLETE, E_SAVE_FAILED, E_DISK_CHECK_FAILED,
E_POISONED, E_MEDIA_PRESENT, E_MEDIA_FILE_MISSING, E_IMPORT_INVALID, E_INTERNAL`.

`E_ROLLBACK_INCOMPLETE`, `E_SAVE_FAILED`, `E_DISK_CHECK_FAILED` and any wedge **poison** the
session: every later call except `close_project` returns `E_POISONED` (§5.6).

---

## 4. Engine changes

### 4.1 Loading a FLEx text into the engine

`open_text` returns the engine's existing flextext-shaped model so nothing downstream changes:
paragraphs → phrases (= LCM segments, phrase guid = segment guid) → words (`txt`, `gls` per WS,
`punct`), plus phrase `gls`/`lit` per WS, times in milliseconds, media. Extra fields the shell
needs ride along and are ignored by the web build:

- `flex: {paraGuid, segGuid, analysisGuid, analysisKind: 'wordform'|'analysis'|'gloss'|'punct'}`
- `boundaryMarker: true` on a phrase-final `§` punctuation item (§6.3): the engine hides it and
  never offers it for editing.
- `readOnly: true` on label segments (`IsLabel`, which includes the one-character U+2028
  hard-line-break segments).
- Paragraph structure is preserved as paragraphs (the engine must not flatten paragraphs into a
  phrase list when the doc came from FLEx).

### 4.2 From editor history to FLEx ops

Edits live in the engine's model and its existing undo ring (one item per user action, as now)
until Save to FLEx. At preview time the engine diffs the FLEx base doc against the current doc,
**keyed by GUIDs** (paragraph, segment, analysis), and produces typed ops:

`phrase.split, phrase.join, phrase.moveBoundary, para.split, para.join, phrase.toPara,
para.toPhrase, word.split, word.insert, baseline.replace, gloss.set, ft.set, lt.set, times.set,
media.attach, media.relink`.

Python never trusts the op list alone: `preview_save` also receives the full intended post-state
of every touched paragraph, and the protocol's last in-UOW check is **"re-read the touched text
from LCM, convert it to the engine model, and compare with the intended post-state"** (§5.4 W4).
A diff bug therefore causes a rollback, not a wrong write.

### 4.3 Engine features that ship on the web first

These are engine changes, usable everywhere, and go through the normal branch preview → staging →
release path **before** the shell depends on them:

1. **Word split / word insert** in the web Segmenter (also changes the baseline). Rules match
   §6.5 so a later Save to FLEx is a minimal diff.
2. **§ as a boundary marker**: hide a phrase-final `§` / punct-only `§` item; never offer it for
   editing; round-trip it unchanged in `.flextext` export. (FLEx's own importer writes `§` after
   every phrase without end-of-sentence punctuation **[source + verified]**, so imported texts
   already carry it; the engine has no § handling today.)
3. **Save-blocking warnings** (shown only when the doc is FLEx-bound, but computed everywhere):
   phrases with no word-forming character (FLEx cannot make them a segment, §6.1); phrases with
   an internal end-of-sentence character followed by a letter (FLEx will split them).
4. **Paragraph-level split/join and phrase↔paragraph conversion** where the doc has paragraph
   structure.
5. **Word-forming set from the WS**: tokenisation accepts an injected set of extra word-forming
   characters (from `open_project`'s `wordForming`); the default stays the current Unicode rule.

### 4.4 Two histories, never interleaved

- **Editor history** (Ctrl+Z / Ctrl+Y): the engine's ring, one item per editor action. It never
  touches FLEx.
- **FLEx history** (buttons in the FLEx panel: *Undo Save to FLEx*, *Redo Save to FLEx*): one
  item per Save to FLEx, held by LCM's undo stack for the session.
- Undoing a save returns FLEx to the pre-save state **and leaves the editor's edits in place as
  unsaved**: the natural meaning of "undo the save". Redo re-applies it. Each is one item.
- Why separate: an editor Ctrl+Z must never silently rewrite a FLEx database.
  (Decision D1, §14.)

---

## 5. Write protocol (as verified)

### 5.1 What FlexTools actually gives you — and why it is not enough

**[source]** FlexTools/flexlibs open one session-long `BeginNonUndoableTask()` and, on
`CloseProject()`, call `EndNonUndoableTask()` then `Save()` — **even after a module throws**
(`stopOnError` defaults to false). A failed module's half-done changes are saved. Its real
protections are: dry-run by default, `FTM_ModifiesDB`, a confirm dialog that *tells* you to back
up (it does not back up), refusing when FLEx holds the lock, refusing data migration, a locked UI
while running. The shell keeps every one of these and adds atomic units of work, a mandatory
verified backup, invariant checks, poisoning, and a disk read-back.

**[verified]** flexicon's `CloseProject()` also saves whenever the session is write-enabled, even
after an exception. So the shell **never calls `CloseProject()` on a poisoned session** (§5.6).

### 5.2 LCM facts the protocol depends on

| Fact | Status |
|---|---|
| `UndoableUnitOfWorkHelper(ah, undo, redo)`; `Dispose()` rolls back unless `RollBack` was set false. Any exception inside → whole UOW rolled back (contents edit + `SplitParaAt` + FT + time, then raise → fingerprint, object counts, depth, undo count all restored; unchanged on disk after reopen in a new process). | **verified** (twice, 5 extra injection points incl. an exception thrown inside LCM and after 190 edits) |
| **pythonnet trap:** `helper.RollBack = False` raises nothing and the UOW is still rolled back. Must call `helper.set_RollBack(False)`. | **verified** |
| `BeginUndoTask` while a UOW is open throws "Nested tasks are not supported" **and discards the outer UOW's changes**; the outer `Dispose` then throws. flexicon's `UndoableOperation` nested inside our helper **joins** it (one item). | **verified** |
| `Save()` inside an open UOW throws "Commit at wrong place" and rolls it back. `BackupProject` inside a UOW throws and rolls it back. ⇒ backup and save only at depth 0. | **verified** |
| LCM **auto-saves** on a 1-second timer (≥10 s since last save, ≥2 s idle) from a thread-pool thread. Seen rewriting `.fwdata` 10.6 s after a commit. After `StopSaveTimer()`: no save. | **verified** (the race against an open UOW was not stress-tested) |
| Save failures are **silent** under the headless UI: `.bak` held open by another process → no exception, `HasUnsavedChanges` false, disk unchanged, `.tmp` left behind, only an ERROR log line. **Worse:** the next successful save wrote only the newer edit; the failed edit, still in memory, never reached disk. `.fwdata` mtime changed by another program → "modified by another program", no exception, disk unchanged. | **verified** |
| Opening the project creates no pending changes; the backup's own pre-save writes nothing. | **verified** |
| Undo works after a save; saving again gives a net-empty disk diff. | **verified** |
| The XML save is temp file + delete `.bak` + rename `.fwdata→.bak` + rename `.tmp→.fwdata`; no fsync; a window exists with no `.fwdata`. `.bak` = previous save only. | **source** |
| `ProjectBackupService.BackupProject` writes FLEx's own `.fwbackup` (appears in File ▸ Restore); it saves first. | **verified** (1.7 s; zip verified) / appearing in Restore list **unverified** |
| A failed rollback/undo (`kuresFailed`) is ignored by `UnitOfWork.Rollback` and by flexicon's `Undo()`. | **source** (injection test **unverified**) |
| `LcmCache.Dispose` does not save data. | **source** (**unverified** as the poisoned-close path) |

### 5.3 Before and at open

**B — prechecks, pure filesystem, before any LCM call** (`prechecks.py`, all unit-testable):

- **B1 lock.** Read `<proj>.fwdata.lock` (JSON: `__type, PID, ProcessName, Timestamp` in .NET
  ticks) with normal sharing.
  - Read fails with a sharing violation → `E_LOCK_BUSY` **[verified: that is what an exclusive
    holder looks like]**.
  - PID alive and process is `FieldWorks` → `E_FLEX_HOLDS_PROJECT` ("Close FLEx first").
  - PID alive, other process → `E_LOCKED_OTHER`.
  - PID dead → stale; LCM takes it over **[source; takeover unverified]**.
- **B2 sharing.** ⚠ **[verified]** the lock file is **not** a reliable signal when project
  sharing is on: `SharedSettings\LexiconSettings.plsx` with `projectSharing="true"` switches LCM to
  `SharedXMLBackendProvider`, where only the first opener writes the lock file and later openers
  join as peers without touching it. A second process opened the project with no error while the
  first held it. Sharing is on in the project this was tested on (and in the production project
  it was copied from). **Rule: write mode requires sharing OFF** → else `E_SHARING_ON` with the
  instruction to turn it off in FLEx (Project Properties ▸ Sharing). Read mode is allowed with
  sharing on. (Decision D2.)
- **B3 file state.** Refuse write mode on: `.fwdata` missing; a stray `<proj>.tmp`, or `.bak`
  without `.fwdata` (a crashed save → `E_CRASHED_SAVE_STATE` with recovery guidance, never an
  automatic repair); read-only `.fwdata`; project not on a fixed local drive; project under a
  cloud-sync folder (OneDrive, iCloud, Google Drive, Dropbox, or a Parallels shared Mac folder).
- **B4 model version.** `<languageproject version="N">` must equal `LcmCache.ModelVersion` of the
  installed FLEx → else `E_MODEL_NEWER` / `E_MODEL_OLDER` ("open it in FLEx first"). Data
  migration is never run by the shell.
- **B5 disk space.** Free space ≥ 3 × `.fwdata` size (tmp + bak + backup zip).
- **B6 copy-only guard** (dev builds only, §12.3).

**C — open:**

- **C1** `OpenProject(name, writeEnabled=(mode=='write'), undoable=True)` with the headless UI and
  data migration disabled. **[verified]** with `undoable=True` there is no session-wide task
  (depth starts at 0), so our UOWs work; with `undoable=False` they cannot be used — never use it.
  Map `FP_FileLockedError → E_FLEX_HOLDS_PROJECT`, `FP_MigrationRequired → E_MODEL_OLDER`,
  `LcmNewerVersionException → E_MODEL_NEWER` (flexicon may not map the last one;
  **[unverified]**).
- **C2** immediately `usm.StopSaveTimer()` (`usm = IUndoStackManager(cache.ServiceLocator.GetService(IUndoStackManager))`
  — **[verified]** `GetInstance[T]` is not reachable from pythonnet).
- **C3** attach a `logging.Handler` to flexicon's headless-UI logger; **any ERROR record poisons
  the session** (it is the only signal of a failed save).
- **C4** `SharedBackendServices.AreMultipleApplicationsConnected(cache)` → if true, read-only
  (`E_PEERS_CONNECTED`). **[verified]** returns true while a second process has it open, false
  after that process ends.
- **C5** record per-class object counts (`LexEntry, LexSense, MoForm, WfiWordform, WfiAnalysis,
  WfiGloss, WfiMorphBundle, PunctuationForm, Text, StText, StTxtPara, Segment, CmMediaContainer,
  CmMediaURI`) and, per opened text, a fingerprint per paragraph: Contents text + WS runs,
  segment GUIDs and Begin/EndOffsets, FT/LT per WS, times, media GUID, speaker GUID, notes,
  `AnalysesRS` GUIDs.
- **C6** read paths never open a UOW.

### 5.4 Save to FLEx — the sequence

One **Save to FLEx** = one user action = **one LCM UOW = one FLEx history item**.

- **W1 preview** (no write). Re-read the touched paragraphs; compare with the C5 fingerprint
  (mismatch → `E_STALE_BASE`: reload and re-merge). Check scope (§1), fragile paragraphs
  (§6.2 → `E_FRAGILE_PARAGRAPH`), empty phrases (`E_EMPTY_PHRASE`), internal end-of-sentence
  warnings, shared-gloss outcomes (§7), media outcomes (§8). Build a human change list. The
  preview token pins: base fingerprint, op list, intended post-state, and an expiry. Proceed
  only on the user's confirm.
- **W2 mandatory backup**, at depth 0, before any change:
  `BackupProjectSettings(cache, None, FwDirectoryFinder.DefaultBackupDirectory, <FW version>)`,
  comment "FlexText Segmenter before save", every `Include*` flag false;
  `ProjectBackupService(cache, s).BackupProject(HeadlessThreadedProgress(), None)`.
  Then **verify**: the zip opens, `testzip()` passes, it contains `<proj>.fwdata` whose header
  version is right and whose `rt` count equals the live file's. Any failure → `E_BACKUP_FAILED`,
  nothing written (fail closed). One verified backup per session is enough if nothing has been
  saved since; after a save, the next save backs up again. ⚠ On the test VM the default backup
  folder is a Parallels-shared Mac folder (the backup leaves the VM); see D3.
- **W3 apply** on the worker thread: refuse if `ah.CurrentDepth > 0`;
  `h = UndoableUnitOfWorkHelper(ah, "Undo Save to FLEx (N changes)", "Redo Save to FLEx (N changes)")`;
  apply the ops (§6–§8). Never call flexicon's segment operations (§6.6).
- **W4 invariants, still inside the UOW** — any failure raises → rollback:
  1. Segmentation invariant on every touched paragraph (§6.2), no zero-length segments.
  2. Expected segment GUID list per paragraph; untouched words keep their analysis GUIDs.
  3. Every edited value reads back exactly (FT/LT/gloss text, times, media GUID).
  4. Untouched paragraphs' fingerprints unchanged (in touched texts).
  5. Object counts: `LexEntry, LexSense, MoForm, WfiMorphBundle` unchanged; `WfiAnalysis` changed
     only by the trivial analyses the preview announced; `WfiGloss`, `WfiWordform`,
     `PunctuationForm`, `StTxtPara`, `Segment`, `CmMediaContainer`, `CmMediaURI` changed by
     exactly the preview's counts.
  6. Re-read the touched text into the engine model = the intended post-state (§4.2).
- **W5 commit or roll back**: success → `h.set_RollBack(False)`; `h.Dispose()`. Exception →
  `h.Dispose()` with RollBack left true. If `Dispose`/`EndUndoTask` throws and depth is still 1 →
  `ah.Rollback(0)`. Then assert depth 0 and `UndoableActionCount` +1 with the expected undo text
  (success) or unchanged (failure).
- **W6 after any rollback**: compare every touched fingerprint with the pre-state. Mismatch →
  `E_ROLLBACK_INCOMPLETE`, poison.
- **W7 save**: `usm.Save()` at depth 0, then wait for the commit thread by reflection
  (`IDataSetup` from `SIL.LCModel.Infrastructure`, `GetType().GetMethod("CompleteAllCommits").Invoke(ds, None)`
  — **[verified]** reachable). Any captured ERROR log → `E_SAVE_FAILED`, poison.
- **W8 disk read-back** (`diskcheck.py`): stream-parse `.bak` (exactly the pre-save file, because
  auto-save is off) against the new `.fwdata`, keyed by `rt guid`, with a real XML parser.
  Every added/changed/removed `rt` must belong to the class set the preview allowed (table
  below) and to a touched text (ownership chain), or be a `WfiWordform`/`WfiAnalysis`/`WfiGloss`/
  `PunctuationForm` referenced from a touched segment; field values must equal the intended
  values; zero unexplained changes. Also: `.tmp` is gone, `.fwdata` mtime changed. Failure →
  `E_DISK_CHECK_FAILED`, poison, then W9.
  - ⚠ **[verified] validator pitfalls:** self-closing `<rt …/>` elements exist (a regex missed
    185 of them); hashing `ET.tostring(el)` at an iterparse end event includes the element's
    *tail*, which depends on buffer boundaries — set `el.tail = None` first, and always test the
    validator with an edit that changes the file length. Runtime 1–1.7 s on a 25 MB file.
- **W9 on W7/W8 failure**: close **without** saving (§5.6); rename `.fwdata →
  .fwdata.failed-<ts>` (never delete); offer, after confirmation, to restore `.bak → .fwdata` or
  restore the W2 backup through FLEx (File ▸ Restore). Tell the user exactly what happened.
- **W10** (optional, end of session): close, reopen read-only, recheck fingerprints and counts.

Expected disk-diff classes per op (from the verified runs; plus `LangProject`/`StText`/`Text`
`DateModified`, which every save touches):

| Op | Classes that may change |
|---|---|
| FT / LT edit | `Segment` |
| times | `Segment` |
| § split / join / move | `StTxtPara`, `Segment` (+/−), `PunctuationForm` (+ on first use) |
| paragraph split / join / convert | `StTxtPara` (+/−), `StText`, `Segment`; `PunctuationForm` (+ on first use, when a join appends `§`) |
| word split / insert | `StTxtPara`, `Segment`, `WfiWordform` (+) |
| gloss set | `Segment`, `WfiGloss` (+ or edited single-use), `WfiAnalysis` (gains a gloss; + new trivial analysis; its evaluations change on approval — exact objects **[unverified]**, V-12), `WfiMorphBundle` (+ only with a new trivial analysis) |
| relink | `CmMediaURI` |
| media attach | `Text`, `CmMediaContainer` (+), `CmMediaURI` (+), `Segment` |
| import | the new `Text` subtree, `WfiWordform`/`WfiAnalysis`/`WfiGloss`/`PunctuationForm` (+) |

**Found by the tests, 2026-10-15** (each would have stopped real saves; none had a test before):

- The engine's intended post-state carries FLEx's phrase-final `§` words; the re-read drops them. As
  sent, every save touching a paragraph whose phrases end in `§` — every text FLEx's importer wrote —
  compared "words differ" and rolled back. `model.normalize_post_state` makes the engine's side
  marker-agnostic too, at preview, so the comparison and the blocker checks see the same thing.
- A paragraph join removes the paragraph merged into the one before it. It was not counted as
  touched, so "an untouched paragraph changed" rolled every paragraph join back. The preview marks it.
- FLEx makes the `§` `PunctuationForm` once, the first time a save writes a `§`; the preview counted
  one per split and none for a paragraph join. Now once per save, from whichever op writes the first.
- A paragraph join followed by the phrase join deletes the `§` it wrote, so the new form is referenced
  by nothing: the disk check called it "new object outside every touched text" and would have
  POISONED a save that had succeeded. Exactly that form, and only when the preview counted it
  (`newPunctForms`), is now explained.

### 5.5 Undo / redo of a save

`undo_flex()`: refuse at depth > 0; `r = ah.Undo()`; require `r == kuresSuccess` (flexicon's
wrapper ignores the result — call the ActionHandler directly); compare fingerprints with the
pre-save state (W6); then W7–W8 with the class set of the undone save. `redo_flex()` likewise.
**[verified]** Undo returned `kuresSuccess` and restored the exact fingerprint and counts; Redo
restored the exact post-state including the new paragraph's GUID; undo after a save then save
again gave an empty net disk diff. No new backup is needed for undo/redo (the session's verified
backup still predates everything).

### 5.6 Poisoned sessions

Triggers: any ERROR from the headless UI log, `E_ROLLBACK_INCOMPLETE`, `E_SAVE_FAILED`,
`E_DISK_CHECK_FAILED`, a wedge (`LockRecursionException`, `NullReferenceException` from the undo
stack, state stuck in `BroadcastingPropChanges`), or any exception from `Save`.

Response: block every further call; **dispose the cache without saving** (never flexicon's
`CloseProject`, which saves); keep the process alive only to show the message; the user reopens
from disk. **[unverified]** that `LcmCache.Dispose()` without `Save()` leaves the disk untouched
in a write-enabled session — must be proven on the VM before release (V-5).

### 5.7 Close

If not poisoned and `HasUnsavedChanges` (should never be true outside a save, since all writes
go through W7): run W7–W8, then close. Otherwise dispose without save. Never kill the process
during W7; the window's close button waits for a running job.

---

## 6. Segmentation (as verified)

### 6.1 How FLEx decides segments

**[source]** FLEx re-derives segments from baseline punctuation (`SegmentBreaker`):

- End-of-sentence characters are a fixed list, **not per WS**: `! . ?`, their script variants
  (Arabic, Devanagari danda, CJK, fullwidth…), `‼ ‽ ⁇ ⁈ ⁉`, and **U+00A7 `§`**, FLEx's
  forced break without punctuation.
- A period between digits (`3.5`), an exact three-dot ellipsis, or a period after another
  period does not break; four periods do.
- A break needs a word-forming character before it and a later word-forming character (or
  label). It falls after the whitespace following the EOS character; trailing `."`/`.)` stay with
  the earlier segment.
- A phrase with no word-forming character cannot be its own segment (it joins the next).
- Word-forming is per WS (`IsWordForming`, with the WS's character-set overrides).
- Runs in Verse/Chapter Number styles become label segments; U+2028 is its own one-character
  label segment. The shell never inserts U+2028.

### 6.2 When FLEx re-segments, and the one invariant

**[source + verified]** Opening a text in the Interlinear, Gloss or Print tab runs
`ParagraphParser.ForceParse` on **every** paragraph
(`InterlinMaster.LoadParagraphAnnotationsAndGenerateEntryGuessesIfNeeded`). Every write to
`Contents` runs the `AnalysisAdjuster`, which recomputes segment offsets from punctuation.
`ForceParse` **reuses segment objects by order**, not by offset.

**[verified] consequence:** a boundary created without punctuation (a new segment at a word gap)
does not survive. In a one-segment paragraph the new segment is deleted with its FT and times. In
a five-segment paragraph the new segment survives *on the next segment's text*, every later
segment slides one place onto the wrong text with its FT and times, and the last segment is
deleted with its FT. A zero-length (empty, timed) segment is also deleted.

**THE INVARIANT** — checked before and after every write; failing it after a write raises inside
the UOW:

```
[seg.BeginOffset for seg in para.SegmentsOS]
  == [s.IchMin for s in SegmentServices.GetSegments(para.Contents, cache.WritingSystemFactory)]
and no segment has zero length
```

A paragraph failing it before an edit is **fragile**: the shell refuses to edit it
(`E_FRAGILE_PARAGRAPH`) and may later offer a separate, previewed repair (§6.7, unverified). The
tested copy had 0 fragile paragraphs, 0 zero-length segments, 0 letter-less segments; 604 `§`
in baselines; internal boundaries were `§` (most), `.` and `?`; the remaining boundaries were
edges of U+2028 label segments. **[verified]** A `ForceParse` dry run (rolled back) on three
texts changed 0 paragraphs.

### 6.3 Phrase operations (all **[verified]** on the copy, each followed by FLEx's own routine)

- **Split a phrase** between word *i* and *i+1* of segment *k*:
  1. *p* = just after the last character of the first half (after any trailing punctuation).
  2. Both halves must contain a word-forming character, else refuse.
  3. If the first half does not already end in an EOS character, insert `"§"` at *p* with
     **null properties** (it inherits the previous run, so the diff stays minimal); a space must
     already follow, else insert `"§ "`. Before assigning, `TsStringUtils.GetDiffsInTsStrings`
     must return exactly the expected (ich, cchInsert, cchDelete).
  4. LCM creates the new segment at *k+1*. Segment *k* keeps its GUID, FT, notes and start
     time; the new segment has an empty FT. All analysis GUIDs are kept; the only new analysis
     item is the `§` `PunctuationForm`.
  5. Set the new segment's Begin/EndTimeOffset, `MediaURIRA` (= *k*'s) and `SpeakerRA` (= *k*'s);
     trim *k*'s EndTimeOffset. **[verified]** a split segment keeps its full time range unless
     the shell trims it.
  6. Verify; commit. One undo item. The boundary survived `ForceParse`, a later baseline edit and
     a reopen.
- **Join two phrases** across a `§`: delete the `§` (leave the space). LCM merges *k+1* into *k*:
  FT/LT joined with a space, notes moved, analyses kept, *k+1*'s GUID, times, media and speaker
  gone. Set *k*'s EndTimeOffset to the old *k+1* end. **[verified]** split + join is an exact
  round trip (Segment and StTxtPara byte-identical on disk). A boundary at real punctuation
  (`. ? !`) is joined only as an explicit baseline edit, never by silently deleting the mark.
- **Move a boundary** (shift words between neighbours): **one** `Contents` assignment that removes
  the old `§` and inserts the new one. Both segment GUIDs, FTs and times survive; words inside the
  diff span become bare wordforms — restore them with `seg.AnalysesRS[i] = <snapshot analysis>`;
  `ForceParse` then changes nothing. **[verified] control:** two separate assignments lose the
  second segment and its times.

### 6.4 Paragraph operations (**[verified]**)

- **Phrase boundary → paragraph boundary:** `para.SplitParaAt(seg[k+1].BeginOffset)` (exactly on
  the boundary, so no segment is partly moved); then delete the trailing `"§ "` from the first
  paragraph (keep it if it is real punctuation). Segments *k+1…* move whole with GUIDs, FT, notes,
  times, media, speaker and analyses. **Control:** `SplitParaAt` mid-segment creates a new segment
  with a *duplicate* of the FT and no times — the shell only splits paragraphs at segment
  boundaries.
- **Paragraph boundary → phrase boundary (join P and Q):** if P does not end in EOS, append
  `"§ "` (one assignment); then `P.MergeParaWithNext()`. All of Q's segments survive with FT and
  times; the fingerprint round-trips exactly. Q's paragraph GUID and style are lost (that is what
  a join means). **Control:** `MergeParaWithNext` without the `§` merged P's last and Q's first
  timed segments — the second's times deleted, FTs concatenated.
- **Paragraph split/join without a phrase change** are the same two recipes, applied where both
  sides already end in EOS or `§`.

### 6.5 Word operations (**[verified]**)

- **Split a word:** insert `" "` inside it with null props (expect diff `(ich, 1, 0)`). Only that
  word becomes two unanalysed `WfiWordform`s; every other analysis GUID kept; segments and the
  invariant unchanged; `ForceParse` changes nothing. Undo restores all counts with no orphan
  wordforms.
- **Insert a word:** `"new "` at X's start, or `" new"` at X's end; only the new word is
  unanalysed. Two **[verified] risks**:
  1. The diff LCM computes is the minimal common prefix/suffix, so the reported insertion point
     can differ from the intended one (a `" xyz"` after a word was reported one character later).
     Compute the expected diff *the way LCM does* before assigning.
  2. Inserting a copy of a word next to itself moves the existing gloss to the *first* copy. After
     the write, set `AnalysesRS` to the intended mapping, then verify.
- **General baseline edit:** same pattern — minimal diff, restore analyses for unchanged tokens
  inside the diff span, verify.

### 6.6 Do not use flexicon's segment operations (**[verified]**)

`SplitSegment` raised part-way and left a corrupt paragraph (negative-length segment, extra
segments; our UOW rolled it back). `MergeSegments` leaves the `§` in the baseline; its
`ValidateSegments` says "valid", and `ForceParse` re-creates the boundary as a new segment with
none of the original data. `RebuildSegments` is missing from the installed version. These are
worth an upstream issue; the shell uses only the recipes above, on raw LCM calls.

### 6.7 Fragile-paragraph repair (**[unverified]**, not in v1)

One `Contents` assignment inserting `§` at every stored boundary that is not at an EOS
character, then restore analyses, verify, `ForceParse` no diff. Done step by step it would make
the adjuster merge segments in between. Ship only after VM test V-14.

### 6.8 Editor-side rules

- Hide `§` boundary markers; never offer them for editing.
- Block Save to FLEx for phrases with no word-forming character (FLEx cannot hold them; the
  Segmenter often has timed, not-yet-transcribed phrases — they stay in the editor until text is
  typed or the user merges them; Decision D4).
- Warn on internal EOS + letter inside one phrase (FLEx would split it, giving a timed segment
  followed by an untimed one).
- Tokenise with the FLEx WS's word-forming set.
- Label segments are read-only.

**The Matcher's ✂ and ⤴ on a FLEx text (2026-10-15)** — the shell opens FLEx texts in the Matcher
(§11), so its text-side verbs are what reach FLEx. `flex-ops.js` reads them in document order:

- **✂ a line**: the first half IS the phrase that was split (its guid, notes and items; not its time
  offsets — `mgSplitLine`), the second is new, as §6.3 step 4. → `phrase.split` per new piece, all in
  the base paragraph; when the device's break kind is Sentence (the default), `phrase.toPara` after the
  piece, marked `afterSplit` so the shell runs it after every split; each new piece's free translation
  as `ft.set` on the guid the engine gave it. The shell accepts ops naming a phrase or paragraph that
  the same save creates, and nothing else it does not know. Times ride on the split when every piece
  has one, else each piece's are set (or cleared) outright.
- **⤴ a line into the one above**: `phrase.join` across a `§`; across a paragraph break,
  `para.toPhrase` first — only when the joined line opens its paragraph and the rest of that
  paragraph now sits in the survivor's (else refused: join the paragraphs first with ¶). The
  survivor's times are set outright.
- **Refused up front**, each with its own reason in the preview, never guessed and never left to a
  rollback: a join across a real stop (`joinAtStop` — FLEx keeps two sentences apart, §6.3), a line
  added here (`addedLine` — the + row, or Done's padding for leftover audio), a split and a join of the
  same phrase, a gloss edit on a reshaped phrase, a phrase whose words are nowhere (`phraseRemoved`).

---

## 7. Glosses and free translations

### 7.1 Model facts (**[source]**)

`Segment.AnalysesRS` items are `WfiWordform` (unanalysed), `WfiAnalysis`, `WfiGloss` or
`PunctuationForm`. A segment references a **shared** `WfiGloss`; editing a gloss's `Form` changes
every occurrence in every text. `WfiGloss.Form` is MultiUnicode (plain per WS); FT/LT are
MultiString. **[verified]** on the copy: no `WfiGloss` is referenced by anything but segments;
roughly a third of the glosses in use are shared by more than one occurrence; 0 non-NFD strings.

### 7.2 Set the word gloss of one occurrence in WS X (stricter than FLEx)

Inputs: segment, index *i*, the user's chosen gloss WSs *C* (limited to the project's current
analysis WSs), the new value for X.

1. **Concurrency:** re-read `seg.AnalysesRS[i]`; abort if its GUID, the segment's baseline or
   `AnalysesRS.Count` changed since preview. Refuse `PunctuationForm`.
2. Find `A` (analysis) and `g0` (current gloss) from the occurrence.
3. Target *T* over *C* = `g0`'s values with X replaced. All-empty *T* → point the occurrence back at
   `A` (never delete `g0`) (Decision D5).
4. **Unanalysed word** (no `A`): reuse an exact FLEx-style trivial analysis (no category, one
   bundle with Morph/Msa/Sense/InflType null and bundle Form = wordform; else 0 bundles);
   otherwise create one the way FLEx does (`WfiAnalysis` + one `WfiMorphBundle` whose Form is the
   wordform; `wf.Checksum = 0`). Never use guesses; never change case. (Decision D6: allow at all?)
5. **Choose the gloss:**
   - (i) reuse a gloss in `A.MeaningsOC` equal to *T* on every WS in *C* (blank = blank; tie-break:
     fewest other non-empty WSs). Write nothing to it.
   - (ii) else, if `g0` exists and is referenced **exactly once in the whole project** (this
     occurrence), edit it in place, only the WSs that differ.
   - (iii) else create a new `WfiGloss` in `A.MeaningsOC` with *T*.
   FLEx's "fill a blank on a shared gloss" match is deliberately skipped; every result is a state
   FLEx itself can produce, and **no other occurrence ever changes**.
6. `seg.AnalysesRS[i] = g`.
7. **Approval:** if `A` is not yet approved by `DefaultUserAgent`, `SetEvaluation(A, approves)`, as
   FLEx does; the preview says so (Decision D7).
8. **Invariants** (in the UOW): `g.Owner == A`; `A.Wordform` unchanged; `A`'s bundles and
   category identical to the snapshot (new trivial analysis exempt); every other segment that
   referenced `g0` still does and `g0.Form` is unchanged unless (ii); re-read gives *T*.

**[verified]** single-use gloss edited in place; a gloss shared by two occurrences → a new gloss,
the other occurrence untouched; unanalysed word → existing trivial analysis reused plus a new
gloss (the *create trivial analysis* path is **[unverified]**, V-12). No LexEntry, LexSense,
MoForm, MorphBundle or WfiWordform changed. Reverting a value can leave the replaced single-use
gloss unused (FLEx leaves those too; Decision D8). A dry run on 20 occurrences: 5 in place, 15 new
gloss.

**"Change this gloss everywhere (N occurrences)"** is not in v1. If added later it is a separate
explicit action whose preview lists all N occurrences.

### 7.3 Free / literal translation in WS X

NFD-normalise; `TsStringUtils.MakeString(text, ws)` (or `EmptyString(ws)`); skip if equal;
`seg.FreeTranslation.set_String(ws, tss)` in the same UOW. If the old value had several runs or a
named style, the preview warns that formatting will be replaced (**[verified]** such values exist:
150 in the copy). `LiteralTranslation` likewise. The baseline, analyses and notes are untouched.

---

## 8. Times and media

### 8.1 Rules

- Times are stored as millisecond integer strings in `BeginTimeOffset` / `EndTimeOffset`
  (`OffsetType` is unset in the tested data; the shell never sets it).
- **Times are always saved together with a media link.** **[verified]** FLEx's importer drops
  phrase times when the phrase has no media-file; FLEx's exporter writes times only for segments
  with `MediaURIRA` set, and only in the `elan` export mode.
- A segment's `MediaURIRA` points at a `CmMediaURI` in the text's `MediaFilesOA` container.
- **[verified]** setting times + `MediaURIRA` on an untimed segment, and creating a new media
  container with a split and times on both halves, both survived reopening in a new process.

### 8.2 Relink (only a missing recording)

**[verified]** all segments of an ELAN-imported text point to one `CmMediaURI`; one UOW setting
`uri.MediaURI` to an existing file fixed all of them; survived reopen; disk diff only
`CmMediaURI` (+ DateModified). Rules:

- Allowed only when the current target **does not exist** on this machine → else
  `E_MEDIA_PRESENT`. Never retarget a link whose file exists.
- The new path must exist (`E_MEDIA_FILE_MISSING`) and is picked through the native file dialog.
- Store the path the way FLEx does (absolute; relative to the project's LinkedFiles folder when
  inside it — **[unverified]**, V-11).
- Goes through the full Save to FLEx protocol (preview, backup, one UOW, read-back).

**Attach** (Decision D9): when a Match produces times for a text with no media link, the save must
create one `CmMediaContainer`/`CmMediaURI` for the recording, or FLEx will not keep or export
the times. Read narrowly, "relink only" forbids this and makes Match-into-FLEx impossible; the
plan recommends allowing **attach when none exists**, shown in the preview, never deleting or
retargeting existing media objects.

### 8.3 Playing FLEx-linked audio

`get_media` registers each existing media file under a random 128-bit token and the engine loads
it from `/media/<token>` on the local server (range requests supported, read-only, only
registered paths, tokens die with the project session). No file bytes cross `js_api`. Missing
files report `exists: false`, and opening the text runs §8.4.

### 8.4 Finding a recording whose link points nowhere (2026-10-14)

Seth: *"Most of the recordings found in FLEx text media fields will point to an incorrect path. Our
app needs to give the user the option to find the correct audio file. It should cache it for our
app, and later (once we add write to FLEx capability), it should fix the media file field."*

- **How FLEx reads a link** **[source]**: FieldWorks `InterlinVc.CheckFileExistsFromUri` treats
  `MediaURI` as a URI (`new Uri(s)`, `IsFile`, `LocalPath`), so `file:///C:/…` and plain absolute
  paths both occur; liblcm resolves `%lf%\…` and unrooted paths under
  `LangProject.LinkedFilesRootDir` (default `<project>\LinkedFiles`) for linked files.
  `mediafind.link_path` reads all three; every existence check in the shell goes through it (the
  old `os.path.isfile(uri)` called every `file:///` link missing).
- **The app keeps its own copy.** Opening a FLEx text copies its recording into the media store
  under the record's id — `flexDocId(project, text)`, **never with a colon** (db.mediaKeys ignores
  colon keys, so the old `flex:<project>:<guid>` ids could never count as having a recording). The
  order: FLEx's link when it resolves here → the file the user chose for that link before (no
  question) → the find-the-recording card: files of the link's name the shell found (the remembered
  folders depth 1, LinkedFiles depth 3, the project folder depth 2; at most 20 000 entries looked at;
  exact name first, case-insensitive, then the same stem with another audio extension) and "Choose
  the recording…" (the native dialog, opening in the folder of the last recording found, else
  LinkedFiles\AudioVisual). A pick whose name differs from FLEx's asks once. "Not now" stores
  nothing. Works in a **read-only** session: nothing is written to FLEx.
- **Only what the shell offered is served.** `find_media` and `choose_media` OFFER paths;
  `use_media` adopts one — serves it and remembers it — and accepts nothing it did not offer, so a
  page cannot name an arbitrary file. A pick the user then turns down is never remembered.
- **Memory**: `%LOCALAPPDATA%\FlexTextSegmenterFLEx\media-map.json` — link → chosen file (absolute
  links are one recording whatever project carries them, so a disposable copy finds the original's
  choice; relative links are per project), plus the folders recordings were found in. This
  machine's paths; never leaves it. A damaged file is set aside as `.bad`.
- **The FLEx fix waits for a write session.** `rec.flex.mediaFix = {uriGuid, path}` records it; the
  next Save to FLEx carries a `media.relink` (or `media.attach` when the text had no link and the
  save writes times, D9), shown in the preview, through the full protocol; "Fix FLEx's recording
  link…" does it on its own. §8.2's rules still hold (never retarget a link whose file exists).
- **Re-opening never discards local work** (`reopenDecision`): FLEx unchanged → the local record
  opens as it is; FLEx changed and nothing done here → FLEx's version loads; both changed → the user
  decides, and Escape keeps the work. "Local work" = a stamped edit since loading (`modified >
  flex.loadedAt`), a Segmenter draft, or a save that was undone (`flex.dirty`, judged by the diff).
- A text with several media links: the Segmenter uses one (the one that resolves, else the first)
  and the card says so.
- ⚠ The shell's CSP had no `blob:` in `connect-src`: the waveform player fetches the stored
  recording through a blob URL, so every recording loaded and none played. Found by the headless
  end-to-end test (`desktop/tests/test_e2e_media.py`), before the VM.
- **[unverified]** on real FLEx: the forms links take in Seth's data; reading `LinkedFilesRootDir`
  through pythonnet; the path form a relink should write (V-11). The README's VM list item 5.

---

## 9. Import and export

### 9.1 Import a `.flextext` into FLEx (explicit File action)

- FLEx's own importer: `SIL.FieldWorks.IText.LinguaLinksImport` (`ITextDll.dll` via
  `clr.AddReference`), `ImportInterlinear(HeadlessThreadedProgress(), [path])`, **inside our
  UOW**. **[verified]** it joins our UOW (depth 1); rollback removed everything (text count and
  object counts restored); it inserted `§` between phrases; a phrase with a media-file kept its
  times and link, a phrase with times but no media-file had its times dropped.
- **Preview blockers/warnings:** phrases with times but no media-file (the shell offers to add
  the media reference to the file copy before import, never silently); phrases with no
  word-forming character; internal EOS; and the honest note that **FLEx's importer does not keep
  analysis identity** (**[verified]**: in an export→import round trip 19 of 52 segments got a
  different same-text `WfiGloss`, and 4 analyses + 4 glosses were created).
- Full protocol (backup, UOW, W4 counts adjusted for the new text, W8 with the import class set).
- Import into an existing text (merge) is out of scope for v1.

### 9.2 Export a FLEx text

- **Editor bundle** (`.flextext` + audio): FLEx's own `InterlinearExporter` in mode **`elan`**
  (the GUI's "ELAN, SayMore, FLEx" option). **[verified]** mode `xml` wrote 0 of 52 phrase times;
  mode `elan` writes times, media-file and phrase GUIDs, and an elan-mode export re-imported by
  FLEx preserved times and media paths for every segment of three texts. Read-only (no UOW). The
  audio comes from the media link (or the bundle says it is missing).
- **ELAN bundle** (`.eaf` + audio): open the text in the engine and use the engine's existing EAF
  exporter (FLEx has no EAF writer). No new Python.

---

## 10. Print-view TSV ("copy this line as FLEx would")

FLEx's Print view copy (`VwSelection::GetSelectionString`) puts **two** clipboard formats: a
private TsString and CF_UNICODETEXT (NFC, CRLF line ends, trailing CRLF). No RTF/HTML. The shell
writes CF_UNICODETEXT only (`copy_text`), from a pure JS generator `docs/js/printview-tsv.js`
fed by `printview_data(segGuid)`:

1. **Line set** = the user's own Print-view configuration: `ConfigurationSettings\db$local$Settings.xml`
   → key `db$local$InterlinConfig_v3_Doc_PrintView` (fallback `_v2_`), value
   `InterlinLineChoices_v3,<flid>%<ws>%<True|False>[%name],…`. Flids: Word 5062001, Morphemes
   5112002, Lex. Entries 103, Lex. Gloss 5112004, Lex. Gram. Info. 5112003, Word Gloss 5060001,
   Word Cat. 5059003, Free −61, Lit. −62, Note −63, Media −65. Absent → FLEx's standard set.
   (**[verified]** the key exists and decodes on the tested FW 9.3.12; the Media line flid exists
   in that version.)
2. **Line 0** = `ref TAB label TAB cells`; `ref` = paragraph number, plus `.segment` only when the
   paragraph has more than one segment (label segments count in numbering but are not printed).
   Later lines start with an empty number cell.
3. **Labels** (English UI strings): `Word, Morphemes, Lex. Entries, Lex. Gloss, Lex. Gram. Info.,
   Word Gloss, Word Cat.`; `" " + WS Abbreviation` only when a line type repeats.
4. **Columns**: a word bundle spans the sum of its morph columns when morpheme lines are shown,
   else 1; a variant with an inflection type spreads Lex. Gloss over 3 columns
   (prepend/gloss/append) and Lex. Entries over 2. Each pile is padded with TABs to its width;
   one TAB between piles.
5. **Missing data** = `***`. FLEx shows guesses instead of `***` with nothing marking them; the
   generator does this only as a labelled option (Decision D10).
6. **Punctuation** (incl. `§`) is a 1-line, 1-column pile: text on line 0, empty cells below.
7. **Free / Lit. / Note** lines: `M_v Free␠ M_v M_a text` (one WS) or with `Abbr` (several), where
   the marks are U+200E (U+200F for RTL), omitted for a Graphite-enabled WS. Empty values still
   produce a labelled line. Each Note gets its own block.
8. Join with CRLF, trailing CRLF, NFC.

**Tests** (`test/printview-tsv.test.mjs`, made-up data only): the box algorithm on default lines,
repeated WSs, 2- and 3-column variants, `***`, punctuation and `§`, Graphite, RTL analysis WS,
multi-segment paragraphs, label segments, multi-WS notes. **LingTeX round trip**
(`test/printview-lingtex.test.mjs`): when `LINGTEX_TOOLS` points at a LingTeX-Tools checkout,
feed each output through `docs/core.js` `parseFLExBlock`/`parseFLExBlocks` and through
`LingTeX-Word/tools/reference.js` `buildModels` → `modelToTsv`; otherwise report **SKIPPED**
(never "pass"). Two known parser gaps stay as expected failures until fixed in LingTeX-Tools:
trailing TABs trimmed on line 0 when a number leads it; sentence-final punctuation that exists
only on the Word row dropped. Test against FLEx's code rules and real captures, not against the
partly made-up examples in LingTeX's prompt file. A prototype already reproduces a real captured
Print-view block byte for byte (kept in scratch). **Golden test:** a real FLEx copy of the same
segment, captured by Seth on a disposable copy, byte-compared — scratch only, never committed.

---

## 11. Save to FLEx — what the user sees

1. **Save to FLEx…** opens the preview: per paragraph/phrase, what changes (baseline before/after,
   split/join/move, FT/LT per WS, gloss outcome — *"edits this gloss (used only here)"* / *"new
   gloss; the other N uses keep the old one"* / *"reuses an existing gloss"* / *"marks the
   analysis approved"*), times, media attach/relink; blockers in red, warnings in amber; the
   backup destination.
2. **Confirm** → progress: *Backing up… Verifying backup… Writing… Checking… Saving… Checking the
   file on disk…*
3. **Done** → *"Saved N changes to FLEx. Backup: <name>. Undo Save to FLEx is available until you
   close the project."*
4. **Failure** → nothing was written (rollback) — said plainly, with the reason; or, for a
   poisoned session, *"FLEx reported a problem saving. The project is closed without saving; your
   last good file is preserved as …; your edits are still here in the editor."*

### 11.1 In the shell: the Audio Segmenter, with a FLEx section (2026-10-15)

Seth: *"This is NOT our audio segmenter app. Specifically the Audio Segmenter app for audio
segmenting/matching is what I want loading in this … app."* A FLEx text opens in the Segmenter's own
**Matcher** (`mgOpen`), exactly as its list opens a text — never the editor's tabs.

- **Home**: the FLEx section above the Segmenter's list — project picker, Open read-only / Open for
  writing, and on the project row Undo / Redo Save to FLEx and Import .flextext. One row per text:
  paragraphs · phrases · timed · the recording's state · *matching in progress* (a Matcher draft) ·
  *changes not in FLEx yet*. Actions: **Save to FLEx…** (writable, and the work committed here differs
  from FLEx — judged by the diff Save would make, never by timestamps), **Fix FLEx's recording
  link…** (writable, a relink pending), **Export bundle…**, **Open**.
- **The Segmenter's own list leaves FLEx texts to that section** (`hideFromList`; a FLEx record's id
  starts `flex-`): it showed each text again, once per project copy, with no project to tell them apart.
- **In the Matcher**, a strip under its bar: *FLEx text* (· read-only) and **Copy line as FLEx Print
  view** for the selected line. Done commits here (its toast says Saved — to this app); Save to FLEx is
  on the text's row, through the preview.
- **Undo / Redo** re-read the text and judge "not in FLEx" by the same diff (two saves undone and one
  redone leaves work FLEx does not have); an undone relink offers Fix link again.
- The native dialog uses `webview.FileDialog.OPEN` (pywebview 6 deprecates `OPEN_DIALOG`).

---

## 12. Packaging

### 12.1 Build

- **Python** 3.13 x64 (matches the VM), **pythonnet** 3.x on .NET Framework (`clr_loader` netfx),
  **pywebview** pinned, **pyflexicon** pinned to an exact version (4.13.0 tested; installed under
  its old import name on the VM — detect both), all pinned with hashes in
  `desktop/requirements.lock`.
- **PyInstaller `--onedir`** (not onefile: onefile unpacks to `%TEMP%` every launch, is slow, and
  trips antivirus with pythonnet). Output: a zip of the folder; optional Inno Setup later.
- **LibLCM is not bundled.** `fwfind.py` reads FLEx's install and projects folders from the
  registry (`HKLM\SOFTWARE\SIL\FieldWorks\9`: `RootCodeDir`, `ProjectsDir`), adds `RootCodeDir` to
  the assembly search path, and loads FLEx's own `SIL.LCModel*.dll` and `ITextDll.dll`. The model
  version therefore always matches the user's FLEx. Supported range starts at FW 9.3.12 /
  ModelVersion 7000072; other versions → read-only with a message until tested.
- **WebView2 Evergreen runtime**: checked at start; if missing, a message with Microsoft's
  installer name (the shell does not download it). Optionally ship the offline standalone
  installer beside the zip.
- **Engine bundle**: `desktop/build/stage_engine.py` (Python, runs on Mac/Linux/Windows) copies
  the Segmenter build output into the shell, stamps the engine version, and fails on any
  off-origin subresource. The engine is **pinned per shell build** (the web engine auto-updates;
  the shell does not) — the shell shows its engine version, and sync-protocol changes require a
  new shell build (risk R4). No bash is needed on Windows (bash/WSL/Git Bash are not used on that
  machine).
- `desktop/build/build.ps1` runs PyInstaller on Windows. **No GitHub Actions workflow in v1**
  (repository policy: workflows only with Seth's explicit approval and a cost statement; a
  standard `windows-latest` runner on this public repo is free, but still needs that approval).
- Unsigned, like the existing Electron test build: SmartScreen warns on first run; testers are
  told in advance.
- The service worker: the shell serves no `sw.js` (404) so no stale engine is cached across shell
  upgrades; M1 confirms the engine tolerates that.

### 12.2 Relationship to `electron/`

The existing Electron shell (archival audio capture, loads the live site) is untouched. Merging
the two shells is a later question (risk R7).

### 12.3 Copy-only dev builds

Until Seth signs off on the VM results, every build is **copy-only**: write mode refuses
(`E_COPY_ONLY`) unless the project folder contains a marker file `flextext-disposable-copy.txt`
created by the copy script, and the project name is not in a protected list. The flag is read
like `electron/src/flags.js`: anything but an explicit release stamp means copy-only (fail
closed). Read-only features work on any project.

---

## 13. Testing strategy

### 13.1 Cloud / CI (Linux, no FLEx): the mock LCM layer

- `port.py` defines `FlexPort`: exactly the operations the shell uses (open/close, counts,
  fingerprints, read text, UOW begin/commit/rollback, `Contents` assignment, `SplitParaAt`,
  `MergeParaWithNext`, segment field setters, gloss/analysis lookup and creation, evaluation,
  media objects, save, backup, `ForceParse`, `GetSegments`, `GetDiffsInTsStrings`, undo/redo,
  error-log subscription).
- `lcm_mock.py` implements it in pure Python and **models every verified behaviour this plan
  depends on**, each with a comment citing the VM result: UOW rollback on exception; one undo item
  per UOW; nested `BeginUndoTask` discards the outer UOW; `Save`/backup inside a UOW roll it back;
  the segment breaker (EOS set incl. `§`, special periods, whitespace placement, word-forming
  requirement, labels, U+2028); the adjuster for the ops we use (insert `§` → new segment after
  *k*; delete `§` → merge with FT/LT concat, notes moved; one-assignment move keeps both GUIDs;
  `SplitParaAt` moves whole segments, mid-segment split duplicates FT; `MergeParaWithNext` edge
  merge without `§`); `ForceParse` realign-by-order; word split → two bare wordforms; the
  insertion-point ambiguity and the duplicate-word gloss shift; fault injection (silent save
  failure as an ERROR log only; save after a failed save drops the failed edit; wedge after
  cross-thread dispose; rollback that reports failure).
- **Contract tests** (`desktop/tests/contract/`) are written against `FlexPort`, parameterised
  by backend. On Linux they run against the mock; on the VM the **same files** run against
  `lcm_real` on a copy. A mock behaviour that the VM contradicts is a bug in the mock.
- Protocol tests: every W-step failure path (backup fails, invariant fails, rollback incomplete,
  save error log, disk check mismatch) ends rolled back or poisoned, never half-written.
- `diskcheck.py` tests on synthetic `.fwdata` pairs: self-closing `rt`, length-changing edits,
  tail handling, unexplained change detection, ownership-chain checks.
- `prechecks.py` tests on synthetic folders: lock JSON variants, unreadable lock, stale PID,
  `SharedSettings\LexiconSettings.plsx` sharing on/off, crashed-save leftovers, version header.
- `navguard.py` table tests (§2.2).
- JS: engine tests for § hiding/round-trip, word split/insert, diff → ops, WS word-forming
  tokenisation, the seam's inertness on the web, `check-native-containment.sh` extension,
  `printview-tsv`.
- `undo-granularity` tests: one editor action = one ring item; one Save to FLEx = one FLEx item;
  one undo restores all, one redo re-applies all (mock backend).

### 13.2 VM (real FLEx) — always on a disposable COPY

- **Never on a production project.** Make the copy with FLEx closed: copy the project folder to a
  new name under FLEx's projects folder, rename the `.fwdata` inside to match, add the
  copy-only marker file. Record FW/LCM/model versions.
- Run `desktop/vm/run_conformance.py --project <copy>` (contract tests on `lcm_real`), then the
  V-list in §15.
- Before the first write of each run, assert the open project is the copy (cache project name,
  `.fwdata` name and folder name all equal the copy's name).
- Restore point before writes (copy of the `.fwdata`) and a disk diff at the end.
- FLEx GUI checks (V-1) need Seth at FLEx on the copy.

---

## 14. Decisions for Seth

- **Shared projects (Seth, 2026-10-14): "Eventually, we want it to work with shared projects
  successfully. But for now, safe is what we want."** So E_SHARING_ON keeps refusing WRITES while
  "Share project contents with programs on this computer" is on; reading works with sharing on
  (and is the only way to read while FLEx holds the project). Writing to a shared project is a later
  milestone with its own verification (peer schema guard, `AreMultipleApplicationsConnected`, the
  conflicting-save path), not a flag to flip.

| # | Question | Recommendation |
|---|---|---|
| D1 | Separate editor history and FLEx history (Undo Save to FLEx as its own button)? | Yes (§4.4). |
| D2 | Project sharing is on in the production project. Writes require it off (FLEx ▸ Project Properties ▸ Sharing), because a peer — possibly FLEx itself — cannot be detected by the lock file. Turn it off, or keep the shell read-only? | Turn sharing off for this project; the shell refuses writes while it is on. |
| D3 | Backups go to FLEx's default backup folder (on the VM: a Parallels-shared Mac folder, so the backup leaves the VM; if that Mac folder is cloud-synced, files can be evicted). Keep, or choose a local VM folder? | Keep FLEx's folder (it shows in File ▸ Restore), verify after writing; add a setting. |
| D4 | Phrases with no letters (timed, not yet transcribed) cannot be FLEx segments. Block the save, or save the rest and keep those in the editor? | Block, with "merge into neighbour" offered. |
| D5 | Clearing the last gloss WS: point back to the analysis, or keep an empty gloss as FLEx does? | Point back to the analysis. |
| D6 | Allow glossing unanalysed words (creates a trivial analysis, as FLEx does)? | Allow. |
| D7 | Mark the analysis approved (as FLEx does) when re-pointing an occurrence that already had an analysis, or only for new trivial ones? | As FLEx does, shown in the preview. |
| D8 | Delete glosses this save leaves unused? | No (FLEx leaves them; never delete in v1). |
| D9 | Allow **attaching** a media link when a matched text has none (needed for times to survive)? | Yes; never retarget or delete existing links. |
| D10 | Include FLEx's guesses in the TSV copy (as FLEx does) or `***`? | Default FLEx-like, labelled option. |
| D11 | English labels in the TSV always, or FLEx's UI language? | English (LingTeX parses English). |

---

## 15. Still unverified — must be run on the VM, on a copy, before release

| ID | What | How |
|---|---|---|
| V-1 | **FLEx GUI round trip** after shell writes: § split/join/move, phrase↔paragraph, word split/insert, glosses, FT, times, relink. | Seth opens the copy in FLEx: Baseline, Interlinear, Gloss, Print tabs on each touched text; close FLEx; shell re-reads and diffs against its post-write snapshot (expect identical, except guesses). Also export elan-mode and confirm `§` is a phrase-final punct item and phrase GUIDs = segment GUIDs. |
| V-2 | Auto-save race (timer running vs an open UOW). | Loop ~2000 UOWs (FT ws1, sleep, FT ws2, raise in half), timer on; close without own save; scan for inconsistent pairs. Repeat with `StopSaveTimer` (expect zero). |
| V-3 | Kill during save. | Kill the process at random points during W7, 20×; each time list `.fwdata/.bak/.tmp` and try to open; hand-craft `.bak + .tmp, no .fwdata` → B3 detects it; try FLEx on that state. |
| V-4 | A failing undo action (`kuresFailed`) is silent. | Add a pythonnet `IUndoAction` whose `Undo()` returns false after real changes; raise; confirm the W6 fingerprint check catches it. |
| V-5 | Poisoned close: `LcmCache.Dispose()` without `Save()` leaves disk untouched in a write-enabled session. | Commit a UOW, dispose without save, check mtime and content. |
| V-6 | Backup restore: the `.fwbackup` appears in FLEx File ▸ Restore and restores (as a new name) to an identical `rt` set; a truncated backup is rejected by the W2 check. | Seth in FLEx + script. |
| V-7 | A throwing change listener wedges the state (`BroadcastingPropChanges`); the shell poisons. | Register a throwing `IVwNotifyChange`, commit. |
| V-8 | Real FLEx holding the project: with sharing off, `FP_FileLockedError` and the B1 lock JSON shows `FieldWorks`; stale lock takeover after FLEx is killed; with sharing on, FLEx joins as a peer and C4 sees it. | Seth starts/kills FLEx on the copy. |
| V-9 | `LcmNewerVersionException` mapping (copy with header version + 1). | Script. |
| V-10 | STA worker + pywebview `js_api` marshalling; WebView2 navigation hooks; `private_mode=False` persistence across launches; fixed-port nonce check. | `desktop/vm/test_navguard_e2e.py` and a launch/relaunch test. |
| V-11 | Relink path form (absolute vs LinkedFiles-relative) as FLEx writes it. | Relink in FLEx on a copy and compare. |
| V-12 | Create-new-trivial-analysis path for an unanalysed word; the exact objects `SetEvaluation` adds. | Script + disk diff. |
| V-13 | Golden Print-view clipboard capture (a variant morph with final punctuation; a multi-segment paragraph; two Free WSs). | Seth copies in FLEx on the copy; saved to scratch; byte-compare. |
| V-14 | Fragile-paragraph repair (only if a fragile paragraph is ever found). | Script. |
| V-15 | PyInstaller onedir build loading FLEx's DLLs from the install folder; clean Windows user account. | Build + run. |
| V-16 | Other FW 9.x versions (model version, exporter/importer signatures). | When available. |

---

## 16. Milestones

| M | Scope | Where tested |
|---|---|---|
| M0 | Engine, web first: word split/insert; § hiding/round-trip; WS word-forming tokenisation; empty-phrase / internal-EOS warnings; paragraph-level ops where the doc has paragraphs. Ships through branch preview → staging → release like any engine change. | web, node tests |
| M1 | `desktop/` skeleton: local server, nav guard + tests, persistent storage, fixed port, `native-flex.js` + containment rule, `hello()`, mock-backed bridge, copy-only flag. Audit off-site flows. | Linux tests; V-10 on VM |
| M2 | Read path: prechecks, `list_projects`, open read-only, `list_texts`, `open_text` into the engine, media playback, export bundles, Print-view TSV + LingTeX tests. | mock + VM (read-only on a copy) |
| M3 | Write core: protocol W1–W10, backup, poison, disk check; FT/LT and times; relink/attach. | mock contract tests; VM conformance on a copy |
| M4 | Segmentation writes: phrase split/join/move, phrase↔paragraph, paragraph split/join. | mock; VM + V-1 |
| M5 | Word split/insert into FLEx; glosses. | mock; VM + V-1, V-12 |
| M6 | Import `.flextext`; Match an untimed FLEx text and save times. | mock; VM |
| M7 | Packaging, V-list complete, Seth's go → copy-only flag lifted. | VM |

---

## 17. Risks

- **R1** Sharing on in the production project (D2): until it is off, the shell is read-only there.
- **R2** Silent save failures are only detectable through the log hook and the disk read-back;
  if either is skipped, memory and disk can disagree silently (**verified** failure mode).
- **R3** The mock can drift from LCM; contract tests on the VM are the guard.
- **R4** Engine pinned per shell build: sync-protocol or data-format changes on the web need a
  shell rebuild; old shells must refuse a newer contract rather than misbehave.
- **R5** FLEx's importer does not preserve analysis identity (new glosses on import).
- **R6** Backup folder may be cloud-synced (D3).
- **R7** Two Windows shells (Electron for capture, pywebview for FLEx) until merged.
- **R8** flexicon upstream gaps (no `StopSaveTimer`, log-only errors, ignored `UndoResult`, saving
  `CloseProject`, broken segment ops) — the shell works around them; worth reporting upstream.
- **R9** Edits outside the default vernacular WS (a paragraph with runs in another vernacular WS)
  are refused in v1 rather than guessed.

---

## Sources

liblcm 018befb8 (UnitOfWorkHelper, UndoableUnitOfWorkHelper, UndoStack, UnitOfWork,
UnitOfWorkService, XMLBackendProvider, SharedXMLBackendProvider, BackendProvider, ITextUtils
(ParagraphParser, SegmentBreaker), AnalysisAdjuster, StTxtPara, OverridesCellar, TsStringUtils,
DomainObjectServices, ProjectBackupService, LcmCache, LcmSettings, SharedBackendServices);
FieldWorks a90754c8 (BIRDInterlinearImporter, LinguaLinksImport, InterlinearExporter,
InterlinMaster, InterlinDocRootSiteBase, RawTextPane, InterlinVc, InterlinPrintView,
InterlinLineChoices, VwSelection.cpp, EditingHelper, SandboxBase, FocusBoxController,
BackupProjectPresenter, FwLcmUI, FieldWorks.cs); FlexTools b22d4141; flexlibs 3ee88f53;
flexicon 1477cea0 (PyPI pyflexicon 4.13.0); FlexToolsMCP bc02a41b; libpalaso SimpleFileLock.
VM results: two independent sessions on a disposable copy, 2026-10-13 (logs kept outside the
repo).
