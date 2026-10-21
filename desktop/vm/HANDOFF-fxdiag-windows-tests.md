# Handoff: the Windows tests fxdiag must pass before its pre-release becomes a release

For a Claude Code session running INSIDE Seth's Windows VM. Written 2026-10-21 by the cloud session that built
`tools/fxdiag` and its portable exe (branch `desktop-flex`). Seth is at the keyboard. Read this whole file, then
`tools/fxdiag/README.md` and the "fxdiag FOLLOWS THE SUITE'S STORAGE" section of `CLAUDE.md`, before running
anything.

**What is under test:** the pre-release `fxdiag-v0.1.0-pre` —
https://github.com/rulingAnts/flextext-editor/releases/tag/fxdiag-v0.1.0-pre — one file,
`fxdiag-0.1.0-windows-x64.exe`. It was already proven on GitHub's Windows Server runner (tests, the exe with
Node removed from PATH against a made-up Chromium profile, its window). What that runner could NOT prove is
everything below: a real desktop, real browser profiles, SmartScreen and Defender, Firefox, and a person.

## Ground rules — not negotiable

1. **Read-only toward every browser.** fxdiag never writes browser storage, and nothing in this session may
   either. Do not delete, move or edit anything under a browser profile. If a check seems to need it, stop.
2. **Real profiles hold real language data.** Reports from Seth's real profiles go to
   `%USERPROFILE%\fxdiag-reports\`, NEVER inside the repository. When YOU read a report, make it with
   `--redact-titles` and read counts and structure only; do not quote titles, words or names in a message, a
   log you keep or a commit. Full exports (`--flextext --with-audio`) are for Seth to open, not for you to read.
3. **Branch `desktop-flex` only.** Pull it (`git pull --ff-only origin desktop-flex`); do NOT rebase it onto
   `main` (the cloud session pushes to it too). Never touch `main`, `beta`, `productionWeb`, `staging`. No
   workflow edits, no version bumps. Before every commit: `bash check-secrets.sh --staged` (Git Bash) and read
   the diff. Fixtures are made up. Commit messages end with the attribution lines your session is given.
4. **A push that changes `tools/fxdiag/` rebuilds and REPLACES the pre-release** (same link). After such a
   push, wait for "Build fxdiag (Windows exe)" to go green in Actions, re-download, and re-run Phase B on the
   new file before continuing — results on an older exe do not count.
5. **When something fails: read the output, find the cause, fix it with a test that would have caught it**
   (`tools/fxdiag/tests`), run Phase A again, then commit and push. Never weaken a check to get green.

## 0. Setup (once)

```powershell
py -3.13 -m pip install --upgrade "flextext-fxdiag[gui,test] @ git+https://github.com/rulingAnts/flextext-editor.git@desktop-flex#subdirectory=tools/fxdiag"
mkdir $env:USERPROFILE\fxdiag-reports -Force
mkdir $env:USERPROFILE\fxdiag-test -Force
Invoke-WebRequest https://github.com/rulingAnts/flextext-editor/releases/download/fxdiag-v0.1.0-pre/fxdiag-0.1.0-windows-x64.exe -OutFile $env:USERPROFILE\fxdiag-test\fxdiag.exe
Invoke-WebRequest https://github.com/rulingAnts/flextext-editor/releases/download/fxdiag-v0.1.0-pre/fxdiag-0.1.0-windows-x64.exe.sha256 -OutFile $env:USERPROFILE\fxdiag-test\fxdiag.exe.sha256
```

Check the hash: `(Get-FileHash $env:USERPROFILE\fxdiag-test\fxdiag.exe).Hash` must equal the first field of the
`.sha256` file (case aside). Record it and the release's target commit (the release page shows it): every
result you report is for THAT file.

## Phase A — the source, on this Windows

```powershell
py -3.13 -m pytest tools\fxdiag\tests -q -rs
node test\fxdiag-suite-sync.test.mjs
```

Expected: all pass; one skip (the Firefox fixture — Phase D removes it).

## Phase B — the shipped exe, by script

```powershell
py -3.13 tools\fxdiag\packaging\smoke_exe.py $env:USERPROFILE\fxdiag-test\fxdiag.exe
py -3.13 tools\fxdiag\packaging\smoke_exe.py $env:USERPROFILE\fxdiag-test\fxdiag.exe --gui
& $env:USERPROFILE\fxdiag-test\fxdiag.exe doctor
```

Both smoke runs must end `SMOKE PASSED` / all `ok`; `doctor` must show the bundled Node and `import webview: ok`.
Also note how long the exe takes to start (it unpacks itself to %TEMP% each run) — report it.

## Phase C — Seth's real profiles, read-only

Ask Seth which browsers on this VM have the FlexText apps in them (installed or just used), and whether the
Flextext Desktop shell or the FLEx shell has been run here.

1. **Browser CLOSED** (ask Seth to close it fully, including background apps / tray):
   `fxdiag.exe scan` — every expected profile and suite origin listed; nothing from any other site.
   `fxdiag.exe report --redact-titles --out $env:USERPROFILE\fxdiag-reports\c1.zip` — read `report.json` and the
   `storage-*.json` files: `copyProblems` empty, `problems` empty, `deserializeErrors` 0. Ask Seth how many texts
   the app shows on this profile and compare with the manifest's count. Credential-named keys must appear only
   as `{present, length}`.
2. **Browser OPEN with the app open:** the same `report`. Expected: it completes; any files Windows refused to copy
   are listed under `copyProblems` and the README says the manifest may be incomplete. A crash, a hang or a
   silent short read is a failure.
3. **The full export, for Seth:** `fxdiag.exe report --flextext --with-audio --out $env:USERPROFILE\fxdiag-reports\c3.zip`.
   Seth unzips it and checks two or three texts: open the `.flextext` in the FlexText editor's *Open text +
   recording together* in a SEPARATE browser profile made for testing (not his working one), and/or import it
   into a THROWAWAY FLEx project (never a real one, never Send/Receive). Text, glosses, free translations, times
   and the recording must match what the app shows. Report pass/fail per text, never the text.
4. If the Electron shell or the FLEx shell is on this machine, `scan` must find it too
   (`--user-data-dir` the folder if not).

## Phase D — Firefox

1. **The fixture** (made-up data, so it may be committed):
   ```powershell
   mkdir $env:TEMP\pw -Force; cd $env:TEMP\pw; npm init -y; npm install playwright; npx playwright install firefox
   $env:FXDIAG_PLAYWRIGHT = "$env:TEMP\pw\node_modules\playwright\index.js"; $env:FXDIAG_BROWSER = "firefox"
   node <repo>\tools\fxdiag\tests\make_profile.mjs $env:TEMP\ffprof
   ```
   Zip it so the zip's ROOT holds `storage\default\<the suite origin folders>` (only those, e.g.
   `https+++rulingants.github.io`), as `tools\fxdiag\tests\fixtures\firefox-fixture.zip`. Run Phase A: the
   gecko IndexedDB test now runs instead of skipping. Make it pass by fixing `fxdiag/gecko.py` /
   `fxdiag/reader.py` — that file has never met a real Firefox profile, so expect findings (blob records,
   the `file_ids` format, the key encoding). Commit fixture + fixes.
2. **A real Firefox:** `winget install Mozilla.Firefox` if absent. Seth opens https://app.flextext.app/ in it,
   makes ONE made-up text with a short made-up recording, closes Firefox. `fxdiag.exe scan` must list the
   Firefox profile and origin; `report --flextext --with-audio` must export that text and its recording intact.
   (The suite does not support Firefox as a field browser; this proves only that fxdiag can read one.)
3. When both pass, remove the "Firefox … provisional" lines: the BLIND_SPOTS entry in `fxdiag/report.py`, the
   caveat in `tools/fxdiag/README.md`, the `[unverified]` notes in `gecko.py` and `CLAUDE.md`.

## Phase E — the window, by hand (Seth)

1. Double-click the downloaded exe from Explorer. Expected: SmartScreen ("Windows protected your PC") → More info
   → Run anyway. Record whether Defender (or any antivirus) quarantines or blocks it, before or after.
2. The window lists the profiles from Phase C. Tick one, tick *.flextext files* and *recordings*, **Make the
   report…** → the save dialog appears → save → the README text appears in the window.
3. Close the window: the console closes with it. Then run `fxdiag.exe gui` from a terminal and confirm the
   console shows no errors while the window is open and used.
4. Anything unclear on screen is a finding (wording, order, what a checkbox means).

## Phase F — the USB package round trip

1. `fxdiag.exe pack $env:USERPROFILE\fxdiag-reports\c3.zip --out $env:USERPROFILE\fxdiag-test\pkg --device "test" --assign vern=xx --assign anal=en`
   (use Seth's real codes if he prefers — the package is for the test profile only).
2. In the SEPARATE test browser profile from C.3: open `pkg\assign.html`, follow its link → the app applies the
   settings (check the writing systems changed). Import one pair with *Open text + recording together* → the
   text arrives with its recording and times.
3. Read `pkg\README.txt` with Seth: are the steps clear enough for a coworker? Wording fixes are welcome.

## Phase G — report back (in the session, not in a commit)

- The exe's SHA-256 and the commit it was built from.
- Per phase, per item: pass / fail; for a failure the command, the console output (no titles or text) and
  the fix with its commit id.
- Start-up time, SmartScreen / Defender behaviour, anything Seth found unclear.
- Whether Firefox reading is now verified (Phase D) or still provisional, and why.

**Release gate:** every phase passes on the CURRENT pre-release file. Then the decision to turn the pre-release
into a release is Seth's. The researcher panel's link to the tool points at `main`, so it works only once
`desktop-flex` is merged — that is a separate step.
