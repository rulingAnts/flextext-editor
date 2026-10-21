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
