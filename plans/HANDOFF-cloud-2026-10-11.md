# Cloud handoff — build v719, then an adversarial review (2026-10-11)

You have two jobs, in this order. **Phase 1: build v719** (gap rows, the last of a three-release plan) on a new branch, verify it, and put it on staging. **Phase 2: a thorough, adversarial review** of the FlexText Editor suite (repo `rulingAnts/flextext-editor`, public): production, staging (v719 included), three fix branches, and Brian Plimley's GitHub issues. Ultracode applies throughout: use Workflow orchestration with independent finders and adversarial verifiers. Every finding is verified by running code before it is reported. Token cost is not a constraint; correctness is.

## 0. First, read these (binding)
- `CLAUDE.md` and `DEVELOPERS.md` on `main`, and on each branch below. They hold the release flow, deploy order, i18n EN+ID, tests, and the privacy and research-ethics threat model.
- `plans/time-gaps-and-estimates.md` on `time-untimed` (the Fable-judged plan for v717–v719, with decisions and adversarial cases).
- `plans/move-upload-guards.md` on `fix/move-upload-guards`.
- `plans/PENDING.md` on `main`.

## 1. Hard rules (Seth's — do not break them)
- **Never** push or merge to `main`, `beta` or `productionWeb`. Never run the production or beta deploy, or the maintenance-notice workflow, unless Seth asks in the turn.
  - **The one exception (Seth approved, 2026-10-10):** once v719 passes every check in Phase 1, merge `time-gaps` into `staging` on a detached checkout (`git push origin HEAD:refs/heads/staging`) and run **Deploy to staging** for all seven apps. It is free: public repo, ubuntu-latest. Then verify each staging host serves v719.
  - Otherwise push only your own new branches: `time-gaps`, `review/2026-10-11` (the report, docs only) and `review/fix-<n>` prototypes.
- **GitHub costs:** nothing billable without Seth's explicit OK and a cost statement. Actions are free only on this public repo with standard runners. Never add or change `.github/workflows/**`.
- **Public repo, privacy and research ethics:** no speaker, user, device or text names. No Fayu text, Drive file IDs, tokens or URLs with `t=` in anything you commit or post. No security vulnerabilities in public issues or public files: report those only in your final message to Seth. Don't file GitHub issues unless Seth asks.
- **Never** touch live accounts or data. That means no D1 queries (the free quota is account-wide; a different site once took FlexText down), no Drive writes, and no signing in as anyone. Seth's own accounts hold real work.
- **Seth's undo rule:** one user action = exactly ONE Undo item and ONE Redo item, however many cells, rows or steps it touches. Flag any path that breaks it.
- **The 2026-08-16 lesson:** text and audio times must change together, at the same index, and never be re-paired by position.
- Read test counts exactly with `node --test "test/*.test.mjs" 2>&1 | grep -E '^# (tests|pass|fail) [0-9]+$'`. ES modules: `node --check` passes broken ESM, so parse each `docs/js` module as a real ES module (see `tools/` or write a vm.SourceTextModule check).

## 1b. PHASE 1: build v719 (gap rows) on branch `time-gaps`, stacked on `time-untimed`

Implement ONLY release **v719** from `plans/time-gaps-and-estimates.md` (on `time-untimed`): §4 "v719", the v719 rows of §5, the v719 tests of §6, and §9's v719 behaviour. v717 and v718 are built and reviewed; extend them additively.

**Seth's decisions (10 Oct), binding:**
- **Gaps become display rows plus a one-click add. Nothing is ever inserted when a text opens.** Each pause of 0.35 s or more between two PLACED lines, before the first or after the last, shows as an "unassigned audio" row with ▶, a waveform, a range label and **Add a line here**. Rows with speech in them get an amber tint (gapHasSpeech: a gap of 1000 ms or more with 400 ms or more voiced).
- **"Add a line for every gap (N)"** asks first, with the wording in the plan, and adds them all as ONE Undo and ONE Redo item. "Show gaps (N)" uses a device preference `showGaps`, on by default.
- **Never next to an untimed or placeholder line:** that room belongs to v718's spread.
- **✂ or Enter with the playhead inside a gap** adds the line there instead of refusing.
- **The tail gap row replaces `coverTail`**, which goes away.
- **While a red "check alignment" banner is unacknowledged**, Add is hidden on gap rows, which say "Check alignment first".
- **Researcher switch** `gapLines` (Add here, Add all, ✂ in a gap) with the shape `!Sync.hasSession() || settings.gapLines === true`, wired end to end like v717's `timingBanner` and v718's `keepTimes`. That covers the panel's device-settings field with EN+ID labels.
- **Gap rows must not break code that finds rows by order:** no `.seg-strip`, `.cut-row`, `.seg-text` or `data-i` on them. Gap marks on the player go in a separate layer (`Player.setGapMarks`), so dragging seam k still moves seam k.

**Also required:**
- **The functions:** `gapRowsFor`, `gapHasSpeech`, `insertLineAt` / `addGapLine` / `addAllGapLines` (they splice `doc.paragraphs` and `doc.segments` at the same index directly, never through reconcileBaseline; Add all works from the end backwards), and `gapMarks`.
- **CSS and i18n:** light and dark CSS; i18n `gap.*` in English and Indonesian; a v719 RELEASES entry in EN+ID.
- **Version:** `./bump-version.sh v719` and BUILD_TAG `'time-gaps v1'`.
- **Docs:** CLAUDE.md and DEVELOPERS.md where the repo's conventions require.

**Tests:**
- Every one listed in the plan for v719, using the sanitized timing skeletons in `test/fixtures/timing/`.
- Explicit one-Undo/one-Redo assertions for Add here, Add all and ✂-in-a-gap.

**Corpus gate:** extend `tools/corpus-timing.mjs`. It has to read Seth's real files, which a cloud session cannot reach. Instead check the skeletons the plan names: gap rows ELAN40 39, ELAN52 51, ELAN43 33, L29-damaged 1 (with Add hidden behind its red banner), and 0 everywhere else. Also confirm that opening still writes nothing and changes no time.

**Browser checks:**
- If a headless browser is available (Playwright/Chromium or Firefox), click through the plan's v719 R-checks with the repo's rig pattern.
- Label any synthetic step (file picks, playhead parking).
- If none is available, say so plainly and leave the click-through as a list for Seth.

**Then:**
1. Run an adversarial review of v719 with three lenses: data safety and #111; undo, UI and gating; the Segmenter and legacy docs.
2. Fix every confirmed defect, with a test that fails before the fix and passes after; bump BUILD_TAG to `v2` if anything changed.
3. Push `time-gaps`.
4. Deploy staging as in §1.
5. Only then start Phase 2.

## 2. What is where (2026-10-10, Jayapura time)

| Ref | Content |
|---|---|
| `productionWeb` = `beta` | v716 (`2f9d1da0`): operator notices with heading, More info, links and tones (another session's work). |
| `main` | `d4db4172` (v716 + docs). |
| `staging` | `70576db9` = v718 "time-untimed v2" (`time-untimed` merged; tree identical; 940/940 tests), deployed to all apps, at `https://staging-<app>.68mh29kgsd.workers.dev` for the apps flextext-editor, flextext-researcher, flextext-recorder, flextext-crowd, paragraph-analysis-tool, consent-collector and audio-segmenter. |
| `time-truth` | v717 (`64efcdfb`): estimates read back and written back per edge; the timing banner (red when lines and audio look out of step); times follow lines in the plain text box; quiet opens; no duration clamp. 884/884 tests. |
| `time-untimed` | v718 (`82296761`, on top of v717): untimed lines drawn in their gap as placeholders, never stored or exported; "needs timing" amber marks; Keep these times (researcher switch `keepTimes`); the Segmenter agrees; v714 seeds recognised. 940/940 tests. |
| `fix/flex-media-link` | `3e6e181a`, unversioned: every timed phrase the suite writes carries a `media-file` link, because FieldWorks' importer (`AddELANInfoToSegment`) drops times without one. 816/816 tests. |
| `fix/move-upload-guards` | `f9f3961a`, unversioned. Guards G1–G5 against confirmed v716 data-loss paths (§4). Not yet click-tested; the panel half sits behind Google sign-in. 868/868 tests. |
| `fix/resend-v709-uploads` | `f06448d3`, unversioned: devices re-send, once, any unchanged text with empty segments last uploaded at or after 2026-10-08T22:31Z (v709's production deploy), and every removal waits for a complete copy. 805/805 tests. |
| `parked/v709-v713-blank-lines` | Parked; do not ship. v709–v713 (only v709 reached production, 9–10 Oct). |
| `ops-notice` | Redundant (superseded by v715/v716). Ignore. |

After Phase 1, `staging` holds v719 (`time-gaps`, which contains v717 and v718). The three `fix/*` branches are NOT on staging. They conflict with `time-*` in `serializeFlextext` and the upload paths, so review them as branches. Note the conflicts you'd expect when they are combined.

## 3. PHASE 2: review scope (after v719 is on staging)

Use separate lenses, each with independent finders and adversarial verifiers.

**A. Production v716, live.** Audit the code at `productionWeb`. Probe the live hosts read-only with `curl` (app.flextext.app, research., record., crowd., pat., consent., audio-segmenter.flextext.app): versions, service-worker consistency, headers, CSP. Hunt for:
- data loss: moves, adopts, uploads, Done/auto-delete, cleanup, command replay, offline queues;
- text↔time mis-pairing;
- undo violations;
- i18n gaps;
- the listening page's strictness;
- FLEx/ELAN round-trip fidelity.

**B. Staging (v719 = v717 + v718 + v719).** Everything in A, plus a review of v717, v718 and v719 against the plan and its decisions. v719 has already had one adversarial pass in Phase 1, so this pass must use different finders and fresh eyes. Verify the plan's claims with the repo's tools: `tools/corpus-timing.mjs` and the timing skeletons in `test/fixtures/timing/`.

**C. The three fix branches.** Correctness, regressions, and how they combine with each other and with `time-*`.

**D. Brian Plimley's issues (GitHub `bplimley`): 5 open, 25 closed.** Open:
- #111 Missing audio segments with empty baseline after moving out and back into a device. v709 caused it; v714 rolled it back. Copies sent on 9–10 Oct still sit in Drive; `fix/resend-v709-uploads` and the move guard address that.
- #112 Support for mp4 audio files.
- #113 Researcher panel "Unassigned" folder in the device list disappears from the interface.
- #114 The link device dialog could disappear after you click "Copy link".
- #115 Clarify device setting: Sending > Delete after finished & uploaded.

For each open issue: reproduce from the code, find the cause, propose or prototype a fix on a branch `review/fix-<n>` (not pushed to shared branches), and say whether staging or any branch already covers it. For the closed ones: check each fix still holds in v716 and v718 (regressions). Seth's memory notes say issues can stay open after a fix, so check `git log --grep '#N'` and the tests before calling one unfixed.

## 4. Findings so far (don't redo them; verify where cheap and build on them)

- **"Everything is misaligned" (10 Oct) was the FILES, not the code.** v714–v716 load, draw and play every timed file exactly (checked in real Firefox and Chromium). Of about 110 texts in Seth's done folder, only 18 files carry times. Every FLEx export carries none, because FLEx dropped them (see the media-file finding), so those files open as an even spread. One text was damaged by the 2026-08-16 bug (fixed in v382). Two texts carry the editor's even estimates exported as times. The import ignored the `~` estimate mark (fixed in v717).
- **The plain text box re-paired times by position on v714–v716** (reproduced: insert a line and every later line takes its neighbour's time). Fixed in v717 and checked by real clicks.
- **Data-loss paths in v716, from Seth's Drive and confirmed:**
  1. Move/adopt sends Drive's NEWEST `.flextext`, not the source device's current state (`moveSources` → `pickSourceFiles`; the inventory's `changed` and `uploadedFileId` are ignored). This lost a coworker's 21 transcribed lines in one case and 32 cuts in another.
  2. Files ▾ "Clean up older copies" keeps only the newest by modifiedTime, which would trash good versions.
  3. The title bridge (`bridgedIds`) can deliver another text's content.
  4. Auto-backup uploads never-edited deliveries and placeholders, which then become "newest".
  5. The upload queue never validates its blob (a 489-byte all-NUL `.flextext` reached Drive).
  6. Plan-only:
     - command replay (ackSeq saved only after a batch; a fresh install starts at 0);
     - typing into a placeholder before its transcription arrives discards the transcription;
     - a move back to a device holding an older copy is a no-op.

  `fix/move-upload-guards` addresses 1–5.
- **FLEx import keeps times only when the phrase has `media-file`.** The editor's exports had a media block but no links. Fixed on `fix/flex-media-link`.
- **A device keeps running v709 until its app reloads**, and its uploads then lack empty segments.
- **Known open items:**
  - Back stamps `modified` on every editor close, even after only looking (v714 too).
  - "Done – send" with auto-delete on never removes an already-uploaded text.
  - The typing-dial warnings never show (`noticeDialog` undefined); another session is fixing that.
  - Whole-file ✨ still produces real times (Seth to decide).
  - Should `~` notes be written even with notes off, so estimates survive FLEx? (Seth to decide.)
  - The v718 open questions are in its plan section.

## 5. Output
- A ranked report: severity, then blast radius to field users (remote, low-bandwidth, offline coworkers are the primary audience). For each finding: the repro, file:line, which refs it affects (production / staging / branch), a fix proposal, and whether an existing branch fixes it.
- Commit it as `plans/REVIEW-2026-10-11.md` on a new branch `review/2026-10-11` (no names, no security details), and give Seth the security-sensitive items only in your final message.
- Lead with what Seth must decide, and with anything that can lose a coworker's work in production **today**.
