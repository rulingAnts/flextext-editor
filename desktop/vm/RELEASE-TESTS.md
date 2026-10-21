# Release tests for `desktop-flex` — run on the Windows VM, in this order

For a Claude Code session inside Seth's Windows VM. Two handoffs, run one after the other; each has its own
ground rules and they all apply. Read BOTH files and `CLAUDE.md` before running anything, then start with 1.

1. **Writing to FLEx safely — `desktop/vm/HANDOFF-real-flex-tests.md`.** First, because it is the part that can
   damage real data. Phases A–D, on throwaway copies only:
   - **A** conformance against real LCM, and the **FwDataFixer gate** (`check_data` runs over pythonnet and writes
     nothing beside its temp copy). If the gate cannot be made to work, STOP the FLEx part here and say so — no
     write may reach a real project without it.
   - **B** every write recipe on a marked copy, each checked by Seth in FLEx and undone;
   - **C** the team-project path on the `-teamtest` copy: checklist, snapshot, Recover, the refusal after a
     Send/Receive (one local `hg commit` only, never push/pull/Send/Receive);
   - **D** the dress rehearsal of exactly what Seth will do on the team project.
   **Phase E (the team's real project) is NOT part of these release tests.** Do it only if Seth says, in this
   session and in so many words, to start Phase E — and then strictly as that handoff describes.

2. **fxdiag, the diagnostic and USB-exchange tool — `desktop/vm/HANDOFF-fxdiag-windows-tests.md`.** Phases A–F,
   read-only toward every browser.

**Release gate:** FLEx Phases A–D and fxdiag Phases A–F all pass on the current code and the current fxdiag
pre-release file, with every failure fixed (a test for each fix, pushed to `desktop-flex`) and re-run. Report as
each handoff's last section says. Merging `desktop-flex` and turning the fxdiag pre-release into a release are
then Seth's decisions — not this session's.

**One rule both share that matters most:** nothing from Seth's real projects or real browser profiles goes into a
commit, a fixture, a log you keep, or a message — no titles, no vernacular words, no names, no paths from this
machine. Fixtures are made up. `bash check-secrets.sh --staged` before every commit.
