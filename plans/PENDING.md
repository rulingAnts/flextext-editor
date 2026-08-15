# Pending issues — the triage sheet (assembled 2026-08-14)

**What this is:** one screen naming everything outstanding, so a working session starts by *choosing*
rather than by re-reading a 1500-line backlog. Every line points at the entry that holds the real
detail — `plans/BACKLOG.md` unless another file is named. **This file ranks; it does not explain.**

⚠ **The ranking is a proposal, not a decision.** It is ordered by *risk to a field user's work*,
because that is the one currency this suite cannot refund: a lost transcription is somebody's
afternoon in a village, and no amount of feature polish buys it back. Seth's own priorities may
differ and win.

⚠ **Read `CLAUDE.md` first** — branch, version and deploy rules are binding, and two of the items
below touch the worker, where deploy ORDER is the difference between a release and an outage.

---

## Where things stand (2026-08-14)

- **production (`productionWeb`) = v371.** Everything from v372 on is staging-only and untested by
  Seth.
- **staging = v377:** upload-failure honesty (v372), the unpaired-queue hold (v373), the
  send-capability trap + version badge (v374), assignment title auto-fill (v375/v376), and the
  loose-file converter (v377 — Utilities → "Make files from a .flextext", on BOTH the editor's
  Utilities tab and the panel's Utilities modal). v377 carries `BUILD_TAG = 'loose-file converter
  v1'`; **clear it to `''` before any production release.**
- **A test drive of v372–v376 is the immediate next step**, not a new feature. The scripted list is
  in the session notes; the short version is: pair a staging device upload-only, queue a bundle,
  delete the device in the panel, confirm the queue HOLDS and the Send button still offers Save, then
  re-pair and confirm the held bundle sends itself.

---

## 1 — Correctness and data safety (do these first)

| # | Item | Why it ranks here |
|---|---|---|
| 1.1 | **GUID adoption: a deleted line's guid gets reused by an unrelated new line, and FLEx honours guids** | CONFIRMED against shipped code; corrupts a researcher's FLEx data *silently and downstream*. ⚠ **THE FIX IS ALREADY WRITTEN AND STRANDED** — v320 on branch `guid-identity-gate` (commit `c8e40ac`, 2026-08-08). Verified NOT an ancestor of `productionWeb`, and the similarity gate exists nowhere in the live tree; it was orphaned when `parked-v319-v321` was parked, taking v319–v321 with it. So this is a **rebase + re-verify**, not a rewrite. `v321-hardening` carries the adversarial-audit hardening that followed it. |
| 1.2 | **Lists lose their scroll position on rebuild** — panel texts list FIXED v369 but **unverified live**; the general rule is written | A fix nobody has watched work is a claim. The panel one could not be driven here (no dev worker). |
| 1.3 | **The exported `.fxpa` can go stale and nothing says so** | Silent staleness in an export is the same family as 1.1: wrong data that looks right. |
| 1.5 | **The exported `.flextext` writes a worker URL into `<media-files location=…>`** | An ASSIGNED text exports pointing at a time-boxed `/v1/textfile/` token on an origin we may retire; a file-attached text exports a bare filename. Two provenance stories from one exporter, and the durable one is the accident. Fix = a .flextext PACKAGE with a relative reference, exactly as ELAN and SayMore already do. |
| 1.4 | **Gloss ✂ splits at an unplaced playhead** | Mints slivers/pending spans from a mis-click. Small, well-specified, cheap. |

## 2 — Field-user experience under bad conditions

| # | Item | Why it ranks here |
|---|---|---|
| 2.1 | **Resource + cheap-device audit** — measurements already taken, incl. ~492 MB heap on a 40-min recording | A 44.1 kHz phone recording is ~3× that transiently. Tab-kill territory on the hardware this suite exists for. The one item here that could stop work outright. |
| 2.2 | **A devworker override must be VISIBLE, not a console line** | Cost a whole diagnosis round on 2026-08-14. A device silently on the wrong backend is indistinguishable from a broken release. |
| 2.3 | **Pause / resume / cancel for panel transfers** | Village bandwidth. Long-standing. |
| 2.4 | **Native audio conversion as a device-side fallback** | Unblocks formats the browser cannot decode. |
| 2.5 | **Configurable span-play return-to-playhead** (default: remember) | Seth reversed the always-rewind rule; it makes the chop-and-listen loop work properly. Pairs naturally with 1.4. |
| 2.6 | **Slow playback without pitch change** | Nearly free (`preservesPitch` defaults true); the work is choosing rates and proving the span watcher survives. |

## 3 — Architecture (plan before touching)

| # | Item | Why it ranks here |
|---|---|---|
| 3.1 | **PROJECT ≠ researcher split** | Prerequisite for multi-project and for researcher-sharing. Devices must migrate **without re-pairing**; per-project E2EE key re-wrap; panel becomes project-scoped (a client release, worker-first). |
| 3.2 | **Researcher signed in on multiple devices** | Blocked by ONE column — which also doubles as the legacy password hash. Sequence WITH 3.1, not before: sessions become "researcher × project" the moment projects exist. Probably needs no outage on its own. |
| 3.3 | **Multiple researchers sharing one project** | Depends on 3.1. The hard parts are key re-wrap and what "revoke" honestly means. |
| 3.4 | **Engine-wide drift / modularisation** | Standing watch item, not a task. |

## 4 — Features and polish

Drive storage footprint + inventory modal · PAT → ELAN EAF export · oral transcription and
back-translation (format problem first) · standalone segmentation/matching app · assignment-URL
collision warning · invite-link-overrides warning · localization expansion (decisions still Seth's) ·
the `.fxed` follow-ons · in-situ "does it save when I leave?" answer.

## 5 — Parked, and parked for reasons

`parked-panel-and-matching` · `parked-v319-v321` · Files ▾ drop-down hidden · the inferred
"Bundle (.zip)" row · consent-message panel parity · no delete-audio button on paired devices ·
`/drive` edge-cache header hygiene.

⚠ **Check these before starting anything adjacent** — several are parked *because* they collide with
work that has since shipped, and one (`parked-v319-v321`) predates the whole v351–v376 line.

---

## Branch hygiene (blocked — this session's git token cannot delete refs)

`git push origin --delete` returns **403** from the remote-execution environment: the credentials
grant push but not delete. Run locally. Verified safe — zero unique commits AND zero content
difference against `productionWeb`:

```sh
git push origin --delete assign-by-upload \
  claude/assign-by-upload-build-7d5ee8 claude/assign-by-upload-build-uik28u \
  claude/cut-tab-waveform-displays-2owdfx claude/paragraph-analysis-backlog-1bb9bd \
  claude/prompt-too-large-error-d767f1 claude/unpaired-device-setup-w3u9ck \
  claude/worker-cache-poisoning-536b2c
```

(`assign-by-upload` is 6 commits "ahead", but all six are merges FROM staging and the three-dot diff
is empty — it holds nothing of its own.)

⚠ **Do NOT delete these — they hold unique commits:** `guid-identity-gate` (the v320 fix above),
`v321-hardening` + `parked-v319-v321` (v319–v321), `fix-artifact-kinds-and-fxpa-stamp` (v317/v319),
`paired-audio-delete-gate` (its own commit says "do not merge without Seth's go-ahead"), and
`claude/flextext-import-onestory-1jjm0p` (the OneStory injection plan).

`segmentation` is separately deletable whenever convenient — CLAUDE.md marks it obsolete and says it
must never be merged.

## What a session should open with

1. **Pick from §1 or §2.1**, or explicitly decide the release comes first.
2. **Re-read the entry** in `BACKLOG.md`. Several record decisions already made and reasons already
   litigated; re-deriving them wastes the session and risks reversing them by accident.
3. **Check whether it touches the worker.** If so, `notes/RELEASE-RUNBOOK.md` owns the order, and
   getting it wrong gives field users 404s.
4. **Write the regression check before the fix, and watch it FAIL.** Twice on 2026-08-14 a test
   passed with the bug still present — once because the fixture was too short to show it, once
   because it measured the wrong thing entirely. A test nobody has seen fail is a comment.
