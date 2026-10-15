# FlexText Segmenter for FLEx — the Windows desktop shell

**Status (2026-10-14): built in a cloud session against a MOCK of LibLCM; nothing here has run on
Windows or against FieldWorks yet.** The plan is `plans/flex-desktop-segmenter.md`; this folder is
its implementation through M7's *prepare only*, on branch `desktop-flex`. Every LCM behaviour the
code relies on is labelled in comments as the plan labels it — **[verified]** (shown on real FW
9.3.12 on a disposable copy), **[source]** (read in liblcm / FieldWorks source) or **[unverified]**
(needs a VM run) — and §"What must be verified on the VM" below is the complete list.

## What it is

A Windows-only **pywebview** (Edge WebView2) shell around the Audio Segmenter. It serves the *same
engine* as the web app from `http://127.0.0.1:8017/` and adds the FLEx features that only make
sense beside a local FieldWorks: open a FLEx text in the Segmenter's **Matcher** (cut the recording,
match it to the lines, split or join lines), **Save to FLEx** from the text's row (preview → verified
backup → one atomic unit of work → disk read-back), find a recording whose link points nowhere and fix
the link, import a `.flextext` with FLEx's own importer, export a text as an editor bundle, copy a
line as FLEx's Print view. Everything outside FLEx is identical to the web app (plan §11.1).

## Layout

```
desktop/
  flexshell/            the shell (Python 3.13; imports on Linux without pywebview or pythonnet)
    app.py              entry: server → window → navigation guard (Windows only at run time)
    server.py           127.0.0.1-only static server, fixed port + nonce, Host check, CSP, /media/<token>
    navguard.py         the PURE navigation policy; webview_hooks.py wires it to WebView2 (Windows)
    api.py              window.pywebview.api: one dispatcher, never raises into JS, jobs + job_status
    worker.py           the ONE LCM thread, one job at a time, one project per process
    port.py             FlexPort — the abstract interface of every LCM operation the shell uses
    lcm_mock.py         FlexPort in pure Python, modelling the verified behaviours (cites each one)
    lcm_real.py         FlexPort on pythonnet + LibLCM — ⚠ UNTESTED until the VM conformance run
    prechecks.py        B1–B6: lock, sharing, file state, model version, disk space, copy-only
    protocol.py         Save to FLEx W1–W10, undo/redo of a save, poisoning, import, export
    segmentation.py     the § recipes: split / join / move boundary, phrase↔paragraph, word split/insert
    glosses.py          set one occurrence's gloss: reuse / edit-in-place / new, never touching others
    diskcheck.py        .bak vs .fwdata, keyed by rt guid, streaming, with a real XML parser
    model.py            LCM read model → the engine's doc; fingerprints; post-state comparison
    copyonly.py         copy-only dev builds (fail closed); fwfind.py, clipboard.py (Windows only)
    mediafind.py        a recording whose FLEx link points nowhere here: resolve, search, remember (§8.4)
  tests/                pytest, runs on Linux against lcm_mock (contract/ is parameterised by backend)
    e2e/                test-only harness: real Api + mock + server + staged engine in headless Chromium
  vm/                   run_conformance.py (contract tests on lcm_real, on a COPY); test_navguard_e2e.py
  build/                stage_engine.py (any OS), build.ps1 (Windows, PyInstaller --onedir), flexshell.spec
  requirements.lock     pinned versions — ⚠ hashes are placeholders until the first Windows build
```

Engine side (`docs/js/`): `native-flex.js` is the only engine file that may touch
`window.pywebview` (enforced by `check-native-containment.sh` rule 1c); `flex-ops.js` diffs the
FLEx base doc against the current doc into typed ops keyed by GUID; `printview-tsv.js` rebuilds
FLEx's Print-view clipboard text; `flex-panel.js` is the UI, dynamically imported only in the shell.

## Installing on the Windows VM with pip (the quick way to try it)

Python 3.13 and git must be on the VM. In PowerShell:

```powershell
py -3.13 -m pip install --upgrade --force-reinstall --no-deps "git+https://github.com/rulingAnts/flextext-editor.git@desktop-flex#subdirectory=desktop"
py -3.13 -m flexshell
```

The build stages the engine from the same commit into the package, so the shell runs the exact
engine it was installed with (`engine-version.json` beside it). `flextext-segmenter-flex` is the
same entry point as a console script, when pip's Scripts folder is on PATH. To update, run the same
install line again. ⚠ `--force-reinstall --no-deps` is not decoration: the package version does not
change per commit, and pip was seen (2026-10-14) to resolve the new commit, print "Requirement
already satisfied" for the dependencies and then install NOTHING — the old shell ran and showed the
old failure. The flag makes it rebuild every time; `--no-deps` keeps it from touching pywebview and
friends. **The first console line names the build** — `shell 0.1.0-dev, engine v719, source
<commit>` — compare that commit to the one pip printed in `Resolved … to commit` before reading any
other output. Nothing here deploys anything or touches a FLEx project until you open one for
writing, and a copy-only build refuses that unless the folder carries `flextext-disposable-copy.txt`.

⚠ Windows status (2026-10-14, Seth's Parallels VM, Python 3.13, pywebview 6.2.1): the pip install
builds and installs. The FIRST launch found two things, both fixed the same day and both
[unverified] since: `stage_engine` printed a non-cp1252 character under pip (wheel build failed), and
the guard asked for the native window before pywebview had created it — pywebview runs the
`webview.start()` function in its own thread at once — so the shell refused to run and WebView2
reported E_ABORT for the window torn down under it. `webview_hooks.install()` now waits for the
window and attaches on the UI thread when WebView2 is ready. The fourth launch opened the window
with a BLANK home screen: the CSP refused the shell page's inline `window.__MODE` script, so the
engine booted as the editor — the server now hashes inline scripts into `script-src`, and the same
page renders the Segmenter home headless on Linux (plan §2.4 items 6–7, which also cover why the
shell is not "localhost" to the engine and the worker allow-list entry the backend still needs).
The fifth launch listed the FLEx projects with the real FieldWorks version (pre-checks, `hello`,
`list_projects` all real) and failed on open: FLExTools' `flexlibs` had been imported instead of
pyflexicon's `flexicon` (plan §2.4 item 8). The sixth opened the project for real and died on a .NET
namespace written from memory; every namespace in `lcm_real.py` is now read from liblcm/FieldWorks
source and pinned by a test (plan §2.4 item 9). The seventh died on a pythonnet idiom
(`GetInstance`), after which the WHOLE file was audited against pyflexicon's own code and docs and
liblcm's model (plan §2.4 item 10) instead of one line per launch. The eighth opened the project
and tripped the shell's own one-thread guard on the read-back after the open (item 11: the rule is
now enforced on the mock too, so the suite catches it). Still never exercised on Windows: everything in `lcm_real.py` past `OpenProject`, the real `CoreWebView2` attribute path,
the Save dialog for exports.
The web Segmenter itself should come up at `http://127.0.0.1:8017/`; the FLEx section appears only
when `hello()` answers. Set `FLEXSHELL_DEVTOOLS=1` to run with DevTools on.

## Running the tests (Linux, Mac or Windows — no FLEx needed)

```sh
python3 -m pip install pytest
python3 -m pytest desktop/tests -q          # mock-backed: navguard, server, worker, prechecks, diskcheck,
                                            # protocol fault injection, contract tests, glosses, undo granularity
node test/flex-ops.test.mjs test/flex-records.test.mjs test/printview-tsv.test.mjs test/word-split-insert.test.mjs \
     test/boundary-marker.test.mjs test/flex-warnings.test.mjs test/paragraph-ops.test.mjs
LINGTEX_TOOLS=/path/to/LingTeX-Tools node test/printview-lingtex.test.mjs   # SKIPPED without the path
./check-native-containment.sh               # the containment rules + the whole engine suite
```

`desktop/tests/test_e2e_media.py` drives the shell end to end in headless Chromium — the real bridge
object over the mock backend, the real local server, the staged engine: finding a recording (read-only),
the Matcher's ✨ → Done → Save to FLEx, Fix link, Undo/Redo of both, a split with a Sentence break and a
join across paragraphs saved to FLEx, Copy line. It needs Node with Playwright and a Chromium
(`FLEX_E2E_SHOTS=<dir>` keeps screenshots) and skips itself without them. It is the first thing to run
after touching `flex-panel.js`, `flex-ops.js`, `api.py`, `protocol.py` or the server's CSP: it found the
CSP that loaded every recording and played none before any VM did, and with the protocol tests it found
four save paths that rolled back or poisoned on texts FLEx itself wrote (plan §5.4, 2026-10-15).

## Write safety, in one paragraph

Before any change: prechecks on the folder (FLEx holding the lock → *close FLEx first*; project
sharing on → *turn it off in FLEx*; a stray `.tmp` or orphan `.bak` → *open it in FLEx*, never an
automatic repair). At open: `undoable=True`, `StopSaveTimer()` immediately, the headless-UI log
captured (**any ERROR poisons the session** — a failed save is otherwise silent), peers → read-only.
On Save to FLEx: preview with the exact intended post-state → mandatory backup, verified (zip opens,
holds the `.fwdata`, right header version, same `rt` count) → ONE unit of work (one FLEx history
item) → in-UOW invariants (segmentation invariant, segment GUIDs, values read back, untouched
paragraphs unchanged, object counts exactly as announced, re-read == intended) → commit with
`set_RollBack(False)` → Save + `CompleteAllCommits` → stream-parse `.bak` against `.fwdata`: every
changed `rt` in the allowed classes, under a touched text, with the intended values, zero
unexplained. Any failure after the commit **poisons**: the cache is disposed WITHOUT saving (never
flexicon's `CloseProject()`, which saves), the suspect `.fwdata` is renamed `.fwdata.failed-<ts>`
(never deleted), and the user is offered `.bak` or FLEx ▸ File ▸ Restore. Undo Save to FLEx / Redo
Save to FLEx are the shell's own buttons; the Segmenter's own Undo never writes to FLEx.

## Copy-only builds

Every build is copy-only until Seth lifts it: write mode refuses unless the project folder carries
`flextext-disposable-copy.txt`. The flag is read like `electron/src/flags.js` — anything but an
exact `release-stamp.json` holding `{"copyOnlyLifted": true}` beside the executable means copy-only.
Read-only features work on any project.

**Making a disposable copy (FLEx closed):** copy the project folder under FLEx's projects folder to
a new name, rename the `.fwdata` inside to match, add `flextext-disposable-copy.txt`, take a
restore-point copy of the `.fwdata`, note FW / LCM / model versions.

## Building on Windows (never from a cloud session)

```powershell
# 1. on the VM: pin the wheels (replaces the PLACEHOLDER hashes in desktop/requirements.lock)
py -3.13 -m pip download --only-binary=:all: --platform win_amd64 --python-version 3.13 -d wheels `
   pywebview==5.4 pythonnet==3.0.5 clr-loader==0.2.7 pyflexicon==4.13.0 pyinstaller==6.11.1 pytest==8.3.4
py -3.13 -m pip hash wheels\*.whl
# 2. build
powershell -ExecutionPolicy Bypass -File desktop\build\build.ps1
```

`build.ps1` makes a venv from the lock file, stages the engine (`stage_engine.py` fails on any
off-origin script/style/font/frame), runs the tests, runs PyInstaller `--onedir` (onefile unpacks to
`%TEMP%` every launch and trips antivirus with pythonnet), and zips the folder. LibLCM is **not**
bundled: `fwfind.py` loads FLEx's own DLLs from `HKLM\SOFTWARE\SIL\FieldWorks\9\RootCodeDir`, so the
model version always matches the user's FLEx. Unsigned (SmartScreen warns on first run), like the
Electron test build. No GitHub Actions workflow (repository policy).

## What must be verified on the VM, with real FLEx, on a disposable copy

In this order. The scripts refuse a folder without the copy marker.

1. **Conformance** — `python desktop/vm/run_conformance.py --project <copy>` runs
   `desktop/tests/contract` against `lcm_real`. Any mismatch with the mock is a bug in the mock or
   in `lcm_real.py`; fix and re-run. Everything in `lcm_real.py` is unverified AS CODE until this
   passes: the pythonnet attribute paths (`AnalysesRS` indexer assignment, `MeaningsOC.Add`,
   `SetAgentOpinion`, `GetDiffsInTsStrings`'s out-parameter shape, `InterlinearExporter.Create`'s
   signature, `LinguaLinksImport`'s constructor, `FileVersionInfo` for the FW version) were written
   from the plan's call sequences and liblcm source, not run.
2. **Navigation guard e2e + persistence (V-10)** — `python desktop/vm/test_navguard_e2e.py`: off-site
   `location`, `window.open`, `_blank`, iframe, meta refresh, form POST, pushState, non-blob download
   all refused; the OS-browser stub records exactly the expected URLs; a second launch on the taken
   port is refused by the nonce; relaunch keeps IndexedDB (`private_mode=False`). Also: the
   WebView2 control path in `webview_hooks._webview2_control` for the installed pywebview; that an
   allowed export download shows ONE Save dialog and lands where chosen (pywebview cancels downloads
   first, the guard re-allows ours); that a `window.open` opens the OS browser ONCE (pywebview
   re-issues it as a navigation of our window, which the guard must swallow).
3. **Plan §15, each on the copy:** V-1 FLEx GUI round trip after shell writes of every op type (Seth at
   FLEx: Baseline, Interlinear, Gloss, Print tabs; elan export shows § as a phrase-final punct item
   and phrase GUIDs = segment GUIDs); V-2 auto-save race stress; V-3 kill during save (20×) and the
   `.bak + .tmp` state; V-4 a failing undo action is caught by W6; **V-5 poisoned close leaves disk
   untouched** (`LcmCache.Dispose()` without `Save()` in a write-enabled session); V-6 the backup
   appears in File ▸ Restore and restores identically, a truncated backup is rejected by W2; V-7 a
   throwing change listener wedges and the shell poisons; V-8 real FLEx holding the project (sharing
   off: lock error + lock JSON names FieldWorks; stale-lock takeover; sharing on: FLEx as a peer seen
   by `AreMultipleApplicationsConnected`); V-9 `LcmNewerVersionException` mapping to E_MODEL_NEWER;
   V-11 the relink path form (absolute vs LinkedFiles-relative) as FLEx writes it; V-12 the
   create-new-trivial-analysis path and the exact objects `SetAgentOpinion` adds; V-13 golden
   Print-view clipboard capture by Seth (scratch only, never committed); V-14 fragile repair (only if
   a fragile paragraph is ever found); V-15 PyInstaller onedir on a clean account; V-16 other FW 9.x.
4. **Mock assumptions the VM must confirm or correct** (each marked in `lcm_mock.py`): whether FLEx's
   importer writes `word§` or `word §` (the mock writes ` §`); the adjuster's segment-count rule
   (equal count → every object kept in order; more → new ones in the modified region; fewer → merge
   into the earlier) against a boundary MOVE that also changes the count; that a `Contents`
   assignment touching a token's end re-tokenises it (word split → two bare wordforms) — the mock
   carries an analysis only when the old token at that position has the same end and form; the
   `Text`/`StText`/`LangProject` `DateModified` stamps every save makes; whether `SplitParaAt` at a
   segment boundary leaves the new paragraph's first segment's time offsets intact.
5. **Finding recordings on real data (plan §8.4)** — read-only, any project: open texts whose link
   points nowhere here. Expect the card to name FLEx's file and offer files of that name from the
   project's LinkedFiles; Use one, cut a few lines, close the shell, reopen it, open the text again —
   no card, the cut lines still there. On a text whose link is a `file:///` URI to a file that does
   exist, expect no card at all. Then on a marked disposable copy opened for writing: "Fix FLEx's
   recording link…", confirm, and in FLEx check that the text's media plays (this is also V-11: the
   path form FLEx expects). Report what the links in the field actually look like (URI, absolute,
   relative) — only the forms, never the paths.
6. **The Matcher on real data (plan §11.1)** — a marked disposable copy opened for writing: open a text
   (it opens in the Matcher), ✨ or cut by hand, Done, then on the text's row Save to FLEx…, confirm, and
   check the times in FLEx. Then ✂ a line at a pause (with the device's break kind as it is — Sentence
   makes a new paragraph), Done, Save; ⤴ two lines FLEx parted with a `§`, Done, Save; look at both in
   FLEx's Baseline and Interlinear tabs. A join across a full stop should be refused before the
   preview. This is the first run of the four fixes in plan §5.4 on real LCM.
7. Only after all of that and Seth's explicit go: the release stamp lifts the copy-only flag.

## Decisions still Seth's (plan §14, plus new ones from the build)

- D1–D11 as in the plan (the code follows each recommendation).
- **D12** The classic Baseline text box shows the raw baseline, `§` included (word-level views hide
  it). Four suites pin the raw box; `getDisplayParagraphs`/`restoreBoundaryMarkers` exist, tested,
  for the day it hides the marker too.
- **D13** A word split in the Segmenter leaves BOTH halves unglossed (FLEx leaves two unanalysed
  wordforms; carrying the gloss would make the save a gloss write on top of the split). The lost
  gloss is announced; Undo restores it.
- **D14** A split together with a word edit in the same phrase, in one save, is refused by the diff
  (`splitWithTextChange`) rather than guessed: save the split first, then edit.
- **D15** Literal translations are read into the doc (`lits`) but the engine has no editor for them,
  so `lt.set` is never emitted by the diff in v1.
- **D16** (Seth, 2026-10-14) The engine's `breakKind` setting (Sentence = `<paragraph>`, Clause =
  `<phrase>`) and the once-per-text replacement of § marks by the chosen kind both live on the flat
  line model as `paraOf`, so the shell's diff sees them as `phrase.toPara` / `para.toPhrase` and the
  post-state comparison ignores phrase-final § on both sides (`model._drop_final_markers`). FLEx keeps
  its § items; the engine may show the text without them. V-1 should include a text whose marks were
  replaced by sentence breaks and then saved.
