# Handoff: real-FLEx tests and dress rehearsals for writing to the team's project

For a Claude Code session running INSIDE the Windows VM where FieldWorks, Python 3.13 and the FLEx
projects live. Written 2026-10-18 by the cloud session that built the write path (branch `desktop-flex`,
commits `9eb919d` and `5730cd9`); Seth is at the keyboard and at FLEx. Read this whole file, then
`desktop/README.md`, `plans/flex-desktop-segmenter.md` §5, §12.3–12.4 and §15, and `CLAUDE.md` at the
repo root, before touching anything.

## Ground rules — these are not negotiable

1. **Throwaway copies only, until Seth says otherwise in so many words.** Every write in Phases A–D goes to
   a copy you or the shell made. The team's project is Phase E, with Seth, one text at a time.
2. **Never Send/Receive from any copy.** A copy that carries the project's `.hg` store can push to the
   team. The shell's own copy leaves `.hg` behind for that reason; the hand copy Phase C needs keeps it,
   and the only `hg` commands allowed on it are `hg log` and ONE local `hg commit` (Phase C.6), never
   `push`, `pull`, `incoming`, `outgoing`, or FLEx's Send/Receive.
3. **Privacy.** The projects hold real language data from real people. Nothing from them goes into a commit,
   a test fixture, a log you keep, or a message you write: no text titles, no vernacular words, no speaker or
   project names, no paths from this machine. Fixtures are made up. Before every commit run
   `./check-secrets.sh --staged`. Describe any earlier import tool as "an earlier import tool outside this
   suite".
4. **Branch `desktop-flex` only.** Never touch `main`, `beta`, `productionWeb`, `staging` or any `time-*`
   branch. No version bumps (the branch stays at the engine version it has; `BUILD_TAG` stays), no deploys,
   no workflow files. Commit messages end with the Claude attribution lines the session is given.
5. **FLEx closed for every shell write.** The shell refuses otherwise (lock); if it does not, that is a bug to
   report, not a convenience.
6. **When something fails, stop and read the console before changing code.** The shell prints every bridge
   call, every refusal with its code, and every poisoned session with the cause. A fix goes in with a test
   that would have caught it (pytest under `desktop/tests`, the mock taught the real behaviour), then the
   suites run (`py -3.13 -m pytest desktop/tests -q`; `node test/<name>.test.mjs` for engine changes), then
   commit and push.

## 0. Setup (once)

```powershell
git clone https://github.com/rulingAnts/flextext-editor.git
cd flextext-editor
git checkout desktop-flex
py -3.13 -m pip install --upgrade --force-reinstall --no-deps ".\desktop"
flextext-segmenter-flex      # the first console line names the build: shell …, engine …, source <commit>
```

`source` must be the commit you checked out. Reinstall after every code change you make (the engine is
staged into the package at install time). For the tests, `py -3.13 -m pip install pytest`. The browser
end-to-end test (`desktop/tests/test_e2e_media.py`) needs Playwright and is optional here.

## 1. Making throwaway copies

**With the shell (preferred):** choose the project, press **Make a disposable copy instead…** (FLEx closed).
It copies the folder beside the original as `<name> - copy for writing`, renames the files, writes the
marker `flextext-disposable-copy.txt`, and leaves `.hg`, `.hgignore`, `OtherRepositories` and
`*.ChorusNotes` behind. Such a copy opens for writing with no checklist and takes no snapshots: it is the
"old" path, right for Phases A–B.

**From Python**, the same routine:

```powershell
py -3.13 -c "from flexshell import copyonly; print(copyonly.make_disposable_copy(r'<FLEx projects folder>', '<project>', '<project> - copy for writing'))"
```

**A copy that behaves like the team's project** (Phase C only): copy the whole project folder by hand,
INCLUDING `.hg`, to `<project>-teamtest`; rename `<project>.fwdata` (and any other `<project>.*` file at the
top level) to `<project>-teamtest.*`; do NOT add the marker. The shell then treats it as a team project:
the checklist, the snapshot, Recover…. Rule 2 applies with full force to this folder. Delete it when done.

## 2. Phase A — conformance (the mock against real LCM)

```powershell
py -3.13 desktop\vm\run_conformance.py --project "<project> - copy for writing"
```

Runs `desktop/tests/contract` against `lcm_real`. Every mismatch is a bug in `lcm_real.py` or in the mock's
model of LCM; fix it and re-run until clean. Then `py -3.13 desktop\vm\test_navguard_e2e.py` (V-10).

Also verify, by running them on the copy from Python or through the shell:
- `paragraph_refs(text_guid)` — `IStTxtPara.GetChartCellRefs()` / `GetTags()` over pythonnet
  (`desktop/flexshell/lcm_real.py`). Unverified as code. Make a chart cell on a text in FLEx first (Text
  Chart tool), close FLEx, and check the method counts it.
- `teamwrite.find_hg(code_dir)` — the assumed path is `<RootCodeDir>\Mercurial\hg.exe`. If it is not
  there, find where FieldWorks keeps Chorus's Mercurial and fix `find_hg`; then
  `teamwrite.hg_log(<folder with .hg>, code_dir)` must list commits.

## 3. Phase B — every write recipe on the marked copy, through the shell's UI

For each item: do it in the Matcher → Done → **Save to FLEx…** on the text row → read the preview →
confirm → read the console (W7/W8 lines: the disk read-back's added/removed/changed counts and "NOT
EXPLAINED" lines, which must be absent) → close the project → **Seth opens the copy in FLEx** and checks
Baseline, Interlinear, Gloss and Print views of that text → close FLEx → reopen in the shell → **Undo Save
to FLEx** → Seth checks again. Record pass/fail per item in your reply, never the text.

1. Times only (cut by pauses, Done, save).
2. A free translation; a free translation in a second analysis writing system.
3. A word gloss: on a word FLEx had unglossed; on one FLEx was guessing for (the guess adopted); a change
   to a gloss other words share (the preview must say "new gloss; the other n use(s) keep the old one").
4. Word split (Space inside a word), word join (Backspace at a word start), both with glosses on the words.
5. A line split with the device's break kind Clause (phrase split, § written), and with Sentence (new
   paragraph).
6. A line join (⤴) where FLEx has a §; a join refused where the first line ends in a full stop (the
   message must say so, nothing written).
7. A split of a line that ends in a hard line break (Shift+Enter in FLEx), and a paragraph join onto a
   paragraph ending in a line break: the § must land BEFORE the break (`segmentation.py
   paragraph_to_phrase`), the break stays its own segment, FLEx shows the text unchanged apart from the
   join. Check the ↵ in the Matcher and that a join across the break is refused with its own message.
8. Fix FLEx's recording link… (a text whose link points nowhere; choose the file).
9. Import a .flextext (a made-up one) with FLEx's own importer; Undo removes it.
10. **Chart/tag guard:** on the text with the chart cell from Phase A, a line split must be refused with
    "A discourse chart or a text tag in FLEx refers to this paragraph…"; a free translation on the same
    paragraph must still save.
11. Two saves on one text, then Undo twice: FLEx back to the start, the work still in the app.

Anything that poisons the session, rolls back half-way, or shows differently in FLEx than in the preview
is a finding: console lines (without text), the op, the fix with its test.

## 4. Phase C — the team-project path, on the `-teamtest` copy (keeps `.hg`)

1. Choose the copy. **Open for writing** must show the checklist with "Last Send/Receive on this computer: …"
   and, if `hg_log` works, "Last Send/Receive commit: <date> (<id>)". Both boxes, then open. The toast must
   say "Snapshot taken".
2. Check the snapshot: `%LOCALAPPDATA%\FlexTextSegmenterFLEx\snapshots\<copy>\<stamp>\` holds
   `<copy>.fwdata` and `meta.json` with `fwdata.sha256`, `hg.sig`, `hg.tip`, `hgLog` (commits), `saves: []`.
3. Save a text (times). The saved toast must end with "check this save in FLEx BEFORE saving more or
   doing a Send/Receive". `meta.json` now has one entry in `saves` with the file's new hash.
4. Save a second text. A second snapshot folder appears (the file changed since the first); its `saves` has
   one entry. Close the project.
5. **Recover…**: the dialog lists both snapshots; pick the first (the older) — the body must say "2 write(s)
   from here after it" — tick both boxes, RECOVER. Then: the copy's `.fwdata` hash equals the first
   snapshot's; `<copy>.fwdata.before-recover-<stamp>` is beside it; Seth opens the copy in FLEx and sees the
   text as before any write; in the shell both texts' rows say "changes not in FLEx yet" and open with the
   matching intact. Then Save to FLEx one of them again: it must go through.
6. **The refusal:** close the project; make ONE local Mercurial commit in the copy's repository (edit a
   harmless text file, e.g. a new `teamtest.txt` in the copy folder, then `hg -R "<copy folder>" add
   teamtest.txt` and `hg -R "<copy folder>" commit -m teamtest -u teamtest` — this never leaves the machine;
   use Chorus's `hg.exe` found in Phase A). Recover… must refuse with the "already gone to the team" message
   and no dialog. Also check the checklist's "Last Send/Receive" time moved. Delete the copy afterwards.
7. **Sharing on**, if the team's project has it on (it did on Seth's machine): turn sharing on for a marked
   copy in FLEx, close FLEx, Open for writing: the checklist appears (sharing note included), the open
   succeeds with both boxes, and C4 is exercised — with FLEx holding the copy open as a peer the open must
   fail with E_PEERS_CONNECTED. Report what happened either way.

## 5. Phase D — dress rehearsal for the real session

On a FRESH marked copy made right before, do exactly the ops Seth intends on the team's project tomorrow
(the texts he matched, in the order he will save them), check each in FLEx, Undo, check again. Only when
every one passes does Phase E start. A dress rehearsal that fails is a finding and ends the day for the
real project.

## 6. Phase E — the team's project, with Seth, one text

Seth does the Send/Receive in FLEx and closes FLEx and everything else; you do nothing to the real project
except through the shell's UI, with Seth watching. One text → save → Seth opens FLEx, checks → closes FLEx
→ in the shell, Recover… ONLY if something is wrong (and before any Send/Receive) → otherwise Seth does the
Send/Receive, and the next text begins. The toast says this order; follow it even when it feels slow.

## 7. What to report back (in the session, not in a commit)

- Per phase, per item: pass / fail, with console lines (codes, counts — no text) for failures.
- Every fix: file, test, commit id.
- Whether `hg.exe` was where `find_hg` looks, and whether `GetChartCellRefs` worked over pythonnet.
- Anything the shell asked, said or showed that was unclear to Seth: that is a finding too.
