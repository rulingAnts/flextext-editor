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

## 🚨 0 — SECRETS EXPOSED (Seth, 2026-08-15) — ahead of everything below

> *"Don't let me forget to secure the accounts/secrets found in my OneStory Editor project file that
> was online for a while, because those could actually damage a lot of things I'm working on (it also
> covers my flextext database send/receive server account)."*

**This outranks every feature item in this file.** Credentials that were publicly reachable must be
treated as compromised from the moment they were exposed — not from the moment someone is seen using
them. By Seth's own account the blast radius includes the **flextext database send/receive server
account**, which is the backend this whole suite's field devices talk to.

**The order that matters — rotate first, investigate second.** Deleting the file or making the repo
private does NOT un-expose anything: it is already cloned, cached and indexed.

1. **ROTATE / REVOKE every credential in that file**, whatever it protects. Not "check whether it was
   used" first — rotation is the only action that ends the exposure.
2. **Then** purge the file from git history (`git filter-repo` or BFG) and force-push, so a fresh
   clone does not hand them out again. History rewrite is cleanup, never the fix.
3. **Then** read the access/audit logs for the window it was public, for anything that already used
   them.
4. Turn on **GitHub secret scanning + push protection** on every repo of Seth's, so the next one is
   blocked at push rather than found later.
5. ⚠ **Anything derived from those secrets rotates too** — session tokens, signed URLs, and any
   worker secret that was pasted from the same file (`RELAY_SECRET` and the D1/Drive credentials are
   the ones to check for this repo; see `notes/RELEASE-RUNBOOK.md` for how they are deployed).

⚠ **A worker-secret rotation is a DEPLOY, and deploy order applies** — the client and the worker must
not disagree about a shared secret, or field devices get 401s on `/drive`. Read the runbook before
rotating anything the client also holds.

**Claude: this session cannot do any of it** — the credentials are not in this repo and GitHub access
here is scoped to `rulingants/flextext-editor`. Raise it at the START of the next session until Seth
says it is done.

---

## Where things stand (2026-08-16)

- **production (`productionWeb`) = v382** (released 2026-08-16; gates green). Carries everything
  through: the loose-file converter (v377/378), listening-page transport + guards (v379), the
  Interlinear page (v380), the exported-page speed picker (v381), and the round-trip blank-line
  fix (v382) — all test-driven by Seth on staging first.
- **staging = v382** — identical to production. Clean slate for the next feature branch.
- **`main` is fast-forwarded locally but UNPUSHED** (the spacing rule): push it alone once the
  Cloudflare dashboard confirms the productionWeb deploys, or from the next session.

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
| 3.1 | **PROJECT ≠ researcher split** — ⭐ **SETH, 2026-08-15: high priority, next working day**, together with 3.2 | Prerequisite for multi-project and for researcher-sharing. Devices must migrate **without re-pairing**; per-project E2EE key re-wrap; panel becomes project-scoped (a client release, worker-first). |
| 3.2 | **Researcher signed in on multiple devices** — ⭐ **same priority, same day as 3.1** (Seth: *"also think through some guards and safeguards to protect that"* — so the deliverable is the session model AND its abuse story, not just the column split; see BACKLOG for what "guards" has to cover) | Blocked by ONE column — which also doubles as the legacy password hash. Sequence WITH 3.1, not before: sessions become "researcher × project" the moment projects exist. Probably needs no outage on its own. |
| 3.3 | **Multiple researchers sharing one project** | Depends on 3.1. The hard parts are key re-wrap and what "revoke" honestly means. |
| 3.4 | **Engine-wide drift / modularisation** | Standing watch item, not a task. |

## 4 — Features and polish

**Attribution traces in exports** (Seth, 2026-08-15 — *"that's a later priority"*): stamp
"made with FlexText Editor" where each destination format already keeps provenance — `.fxpa`
`generator`, a `<meta name="generator">` in the listening page, a version + URL on the EAF's
existing `AUTHOR`, the BWF `bext` (which is the STANDARD place for it, so archival quality is not at
risk — the constraint is never touching the original capture and never naming a person). ⚠ The
`.flextext` one is the risky member: FLEx re-imports it against a schema. Detail + the two traps in
`BACKLOG.md`. ·
Assign to "Google Drive (Unassigned)" — park an uploaded text ready to move to any device (Seth 2026-08-17; BACKLOG) · Drive storage footprint + inventory modal · PAT → ELAN EAF export · oral transcription and
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

## Branch hygiene (verified 2026-08-17 — deletion still needs Seth's terminal)

`git push origin --delete` returns **403** from the remote-execution environment (re-confirmed
2026-08-17 with a live attempt): the credentials push but cannot delete refs. Run locally.

**Safe — every branch below re-verified ZERO content difference against `productionWeb` (v383)
immediately before this list was written.** `assign-by-upload` is 6 merges FROM staging with an
empty three-dot diff; everything else is a plain ancestor of production.

```sh
git push origin --delete segmentation assign-by-upload parked-panel-and-matching \
  segmentation2 seg-exports editor-fixes-v322 paragraph-analysis tok-pisin-l10n \
  heads-model cycle-rest \
  claude/assign-by-upload-build-7d5ee8 claude/assign-by-upload-build-uik28u \
  claude/cut-tab-waveform-displays-2owdfx claude/paragraph-analysis-backlog-1bb9bd \
  claude/prompt-too-large-error-d767f1 claude/unpaired-device-setup-w3u9ck \
  claude/worker-cache-poisoning-536b2c
```

Takes the repo from 24 branches to 9: the three trunks plus six carrying real decisions.

⚠ **Do NOT delete these six — unique commits, each awaiting a decision:**
`guid-identity-gate` (the v320 GUID fix — rebase + re-verify, PENDING 1.1), `v321-hardening`,
`parked-v319-v321`, `fix-artifact-kinds-and-fxpa-stamp` (v317/v319), `paired-audio-delete-gate`
(its own commit says do not merge without Seth's go-ahead), and
`claude/flextext-import-onestory-1jjm0p` (~15 lines of OneStory-injection plans — cheapest close is
copying the plan into plans/ then deleting).

## What a session should open with

1. **Pick from §1 or §2.1**, or explicitly decide the release comes first.
2. **Re-read the entry** in `BACKLOG.md`. Several record decisions already made and reasons already
   litigated; re-deriving them wastes the session and risks reversing them by accident.
3. **Check whether it touches the worker.** If so, `notes/RELEASE-RUNBOOK.md` owns the order, and
   getting it wrong gives field users 404s.
4. **Write the regression check before the fix, and watch it FAIL.** Twice on 2026-08-14 a test
   passed with the bug still present — once because the fixture was too short to show it, once
   because it measured the wrong thing entirely. A test nobody has seen fail is a comment.
