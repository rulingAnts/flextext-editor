# Readiness tests for the Audio Segmenter desktop app writing to FLEx — run on the Windows VM

For a Claude Code session inside Seth's Windows VM. The app under test is the FLEx shell (`desktop/flexshell`,
`flextext-segmenter-flex`) on branch `desktop-flex`. The full brief is **`desktop/vm/HANDOFF-real-flex-tests.md`**:
read it, `desktop/README.md`, `plans/flex-desktop-segmenter.md` §5, §12.3–12.4 and §15, and `CLAUDE.md` before
running anything. Its ground rules all apply.

**Since that handoff was written, the write path gained W8b** — FLEx's own file check (liblcm's FwDataFixer) after
every save. If an earlier session already ran some phases, re-run Phase A in full anyway: its `check_data` gate is
new and gates everything after it.

**What is on the branch now (2026-10-21):** `desktop-flex` at engine **v727**, badge
`desktop-flex + tabfix-utility v1 + gloss-edge-trim v1` — the FLEx work plus staging's v727 fixes (tabs become spaces
in every text box and never leave in a .flextext; leaving a word gloss trims the break character from its edges),
merged in on 2026-10-21. `main` had nothing newer. The shell's first console line must name this commit.

**The readiness tests are Phases A–D, on throwaway copies only:**
- **A** conformance against real LCM; `paragraph_refs` (chart cells, text tags); `find_hg` / `hg_log`; and the
  **FwDataFixer gate** — `check_data` runs over pythonnet and writes nothing beside its temp copy. If the gate cannot
  be made to work, STOP: no write may reach a real project without it.
- **B** every write recipe on a marked copy, each checked by Seth in FLEx and then undone.
- **C** the team-project path on the `-teamtest` copy: checklist, snapshot, Recover, and the refusal after a
  Send/Receive (one local `hg commit` only — never push, pull or FLEx's Send/Receive).
- **D** the dress rehearsal of exactly what Seth will do on the team project.

**Phase E — the team's real project — is NOT part of these tests.** Do it only if Seth says, in the session and
in so many words, to start Phase E, and then strictly as the handoff describes: one text at a time, Seth checking in
FLEx before any Send/Receive.

**Ready means:** Phases A–D pass on the current `desktop-flex`, every failure fixed with a test (pytest under
`desktop/tests`), suites green, pushed, and the affected phases re-run. Report as the handoff's last section says.
Nothing is released, merged or deployed by this session: what happens next is Seth's call.

(`desktop/vm/HANDOFF-fxdiag-windows-tests.md` is a separate plan for the fxdiag tool and is not part of these tests.)

## Progress (update at the end of every session — pass/fail only, never text, titles or words)

**As of 2026-10-24** (shell at `28b21603`, engine v727; FW 9.3.12, LCM 11):

| Phase / item | State |
|---|---|
| **A** conformance, V-10, `paragraph_refs`, `find_hg` / `hg_log`, `check_data` gate | **PASSED** 2026-10-21. Conformance re-run 2026-10-24 after `lcm_real` changed: 44 passed, 8 skipped (mock-only by design), `.fwdata` unchanged. Seth: no full re-run needed again unless `lcm_real.py` or the contract tests change — then re-run `run_conformance.py` only. |
| B1 times | PASSED (2026-10-21) |
| B2 free translations (first and second analysis WS) | PASSED (2026-10-21, 2026-10-24) |
| B3 glosses (unglossed, guessed, shared) | PASSED (2026-10-21) |
| B4 word split + word join with glosses | PASSED (2026-10-24) |
| B5 line split, Clause and Sentence | partly (2026-10-21); finish |
| **B6 ⤴ across a §; a join refused at a full stop** | **NEXT** |
| B7–B12 | to do (B12b is a known gap: a tab already stored in a record — find out what happens, fix on both sides) |
| C, D | to do. C uses the hand copy with `.hg` (its hgrc remotes commented out). |
| E | not part of these tests; only on Seth's word in the session. |

**Findings fixed so far in this run:** the "N problems already in the project" note in the saved toast repeated
after every reopen — keyed by the open-project object, and every save is followed by a close so FLEx can check it;
now keyed by the project's name, said again only if the number changes (`28b21603`, `test/flex-datacheck-toast`).

**From the cloud session (2026-10-24):** the headless end-to-end test (`desktop/tests/test_e2e_media.py`, Linux CI
and the cloud session; optional on the VM — it needs Playwright) still expected a join across a FLEx line break to be
REFUSED in the Matcher. `2edab7e2` made it accepted, so §18 now checks that, and that a SAVED join across a break whose
first line ends with a full stop is refused by name before any preview, with FLEx untouched — the mock's version of B6.
pytest 377 passed / 1 skipped on Linux at this commit; every node test passes.

**Notes for whoever resumes:**
- Rules Seth added during the run: the shell writes **hard line breaks, never §**; joining makes one phrase,
  splitting two, and the paragraph toggle alone decides paragraphs. No per-item Undo on the throwaway copy — a
  different text per item; Undo is item 11. Toasts short, details in the console.
- Reading W8b in the console: the FIRST `FwDataFixer ran on a copy` line is the SAVED file, the second the
  pre-save `.bak`. A count one lower after the save is the save tidying one, not a new problem.
- A preview gloss without "marks the analysis approved" is right when the word's analysis was already approved.
- On a checkout with `core.autocrlf=true`, `git stash` rewrites files with CRLF and the tests that slice engine
  source on `\n` fail; keep the working tree LF. Node 24 prints its own `MODULE_TYPELESS_PACKAGE_JSON` warning
  through `console.error` (`flex-shell-page` ignores it).
