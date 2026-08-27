# Overnight report — 2026-08-26 (the "knock out Phase C/D" night)

**TL;DR: eight commits, all pushed to the feature branch, NOTHING deployed, every gate green**
(full rig incl. device-compat + the new freeze probe, 98 unit files, containment 8/8, secrets,
native, threat-language). Phase 3's worker half is **built**; issue #13 is **fixed on the branch,
both halves**; the coworker flow now **actually delivers keys**; your 2 a.m. freeze-switch idea is
**built and probe-tested**. Seven of Brian's eleven issues are fixed on the branch. Below: what
shipped, what needs YOU, and the paste-ready reply for issue #5.

---

## 1. What shipped tonight (in order)

| commit | what |
|---|---|
| `9f944b8` | The five creation⟹stamped holes closed + a variable-aware tripwire that caught two of its own targets while being written |
| `5cd19f8` | **Move-sync**: `drive_object.project_id` now tracks all seven re-parent sites + **the #13 worker fix** (sweep-tag honesty, the eventually-consistent silent skip closed by a client folder-id echo, D1 sync on every filing) + the rig now refuses to start over a stale worker (that trap cost a debugging cycle tonight) |
| `06b393c` | **Phase 3 gates**: all six capability-gated Drive routes resolve the caller-supplied doc through `drive_object` — owner passes on ownership (behaviour-preserving today), a member needs their project + a non-revoked device. The nine audit findings are now *repaired*, not just unreachable |
| `249df8c` | Client batch: **#12** (the one-flag Unassigned-tiles fix), **#9** (Cut-tab landing works on FIRST open + the download re-enter), **#5** (both chip rewordings, en+id), #13's client echo |
| `4ff6924` | **Member Ki-grant minting** — addMember now wraps every project device's Ki to the member (the flow that makes a membership able to read anything), with three honest outcomes |
| `dd013f5` | Browser-verified fixes to that flow: the Drive-down case no longer hides behind a cheerful toast, and outcomes survive the repaint that used to destroy them |
| `82a4988` | **Your freeze switch**: `maintenance` = banner only; `freeze` = banner + researcher-lane write lock (423, never 5xx). Operator exempt, device lanes untouchable by construction, both acts logged, full rig probe |
| `d73effd` | **#3** (editor-button note + "Open on this device" on invites) + **#7** (crowd dialog gets the born-into-this-project note) |

Also in `19be648` (yesterday evening): the PENDING.md branch-delete list that had become a
destructive command, defused.

## 2. What needs YOU this morning

1. **The v445 release from `main`** (unchanged from last night): the baseline audio-arriving fix is
   still live-broken in the field. `git fetch --all` in the main clone → clear `BUILD_TAG` on main
   → `./bump-version.sh v445` → staging test-drive → ff to productionWeb. Nothing from tonight
   rides this — it is pure and already tested on staging's identical tree.
2. **Test-drive tonight's client work on a branch preview** (it spans apps — tick editor at least):
   #12 (move an Unassigned text to another project's Unassigned — Brian's exact repro), #9 (assign
   a recording with "Open on Cut" set; it should land on Cut on FIRST open and resolve when the
   download finishes), the Coworkers add flow, the freeze banner (raise it on the staging worker
   via the new route). **Bump first** — v445 is spoken for by the main release, so the branch test
   build should take **v446**.
3. **Worker deploy decision.** Tonight's worker half (move-sync + #13 fix + Phase 3 gates + freeze)
   is additive and rig-proven, but it is a worker deploy: maintenance flag up (or try the freeze
   itself), deploy, your test, clear. The #13 fix only takes effect for field moves once this
   deploys.
4. **Approve (or decline) the Actions button for the freeze** — a `.github/workflows/`
   change, so per policy it waits for your explicit OK. Cost: **$0** (public repo, standard
   runner, manual dispatch). Proposed: `maintenance-notice.yml` gains a `flag` choice input
   (`maintenance` | `freeze`), same raise/clear verbs, calling the new operator route
   `POST /v1/researcher/admin/ops-flag` (or keeping the d1-execute style — either works; the route
   also means you can raise it from the panel console today:
   `await (await fetch(...)).json()` — or I can add an Admin-modal switch, one small panel change).
5. **Two decisions that unblock the member-side dashboard** (the big remaining Phase D piece):
   (a) what a MEMBER's drive-estate should be — today they'd silently get their own empty Drive;
   the honest options are a project-rooted listing (worker work, Phase-4-shaped) or hiding the
   Drive column for members v1; (b) whether `GET /v1/researcher` should return a member's
   project devices (worker SELECT widening + the enumerated-rebuild in listView).

## 3. Brian's issues — scoreboard

| # | state |
|---|---|
| #2 | Already fixed AND live (v432/v433) — ask him to confirm his panel ≥ v433, then close |
| #3 | **Fixed on branch** (note + invite "Open on this device") |
| #4 | Accepted, builds on Phase 3's route shape (upload-to-project) — later; label clarification can ride any release |
| #5 | Chips reworded on branch; **paste-ready inventory below** — post it, keep open until the reword ships |
| #6 | Honest split-message on branch (creation vs settings-delivery failure); idempotent-create worker half + estate-refetch design still queued (BACKLOG has your own design) |
| #7 | Note on branch (device + crowd dialogs); structural half lands with the projects-home redesign |
| #9 | **Fixed on branch**, both halves |
| #10 | Interim live-backed count fix on branch; the real cleanup is the decided sweep-then-move retention build |
| #11 | **Built on branch** (researcher-pushed `sortAlpha`, default off, numeric-aware, mirrored on the standalone setup screen) — plus a bonus: the assigned-audio arrival progress bar was dead (missing projection field), now live |
| #12 | **Fixed on branch** — one flag, pinned by test |
| #13 | **Fixed on branch, both halves** (worker mechanism + client echo) — *takes effect on the next worker deploy*; reply drafted in the triage, optionally ask if the moved text had unsynced edits (confirms the intermittency condition) |

## 4. Paste-ready answer for issue #5

> Thanks for pushing on this — the confusion is real and it's a wording problem, not a bug. The
> status chip reports exactly **one thing: whether *this device* has backed its copy of the text up
> to Drive, and whether that backup is current.** It says nothing about assignment, glossing
> progress, or whether the files exist in Drive from some other source. That's why a freshly
> assigned text you haven't touched says "not uploaded" — the files *are* in Drive (the assignment
> put them there), but the device itself has never sent its own copy back.
>
> Full inventory of the main status chip:
>
> | Chip | When it shows | What it actually means |
> |---|---|---|
> | **not uploaded** | The device has never completed an upload of this text | Covers both freshly-assigned untouched texts and edited-but-never-uploaded ones |
> | **changed since upload** | The device uploaded before, but has local edits newer than that upload | Work exists on the device that isn't in Drive yet |
> | **uploaded ✓** | The device's latest state matches its last upload | The device's current copy is safely in Drive |
> | **request sent…** | You clicked Upload; the device hasn't polled the command yet | Still cancellable |
> | **awaiting device…** | The device picked up the upload command but hasn't reported fresh results | It's working on it |
> | **assignment sent…** | An assignment is queued; the device hasn't polled it yet | Waiting for the device to come online |
> | **device is fetching…** | The device has the assignment and is downloading the files | The text appears in its list when done |
>
> Separate tags on the same row (different axes): **done / not done** (workflow progress, only when
> that device's Done toggle is on), **deleting…**, **moving — waiting for the new device /
> removing from this device**, **in progress** (a picked-up command, no longer cancellable),
> **audio**, and **on its way…** (Unassigned rows mid-adopt).
>
> Two things your question surfaced: there's a defined "uploaded just now ✓" state that currently
> never displays (we'll wire it or remove it), and there is currently **no** "started glossing"
> indicator — the device's encrypted status report doesn't carry glossing progress, so that's a
> feature rather than a wording fix. It's on the list.
>
> Shipping soon: "not uploaded" → **"no upload from this device yet"**, "changed since upload" →
> **"edited on device — not yet uploaded"**, so the chip names its direction.

## 5. Observations worth your attention (not changed tonight)

- **First panel paint waits ~16 s when Drive is unreachable** (measured on the rig): the estate
  retry ladder runs to exhaustion before the dashboard renders, even though every device row is
  already in hand from D1. A researcher on a dead connection stares at "Loading…" for it. Fits your
  BACKLOG #6 estate-refresh design — paint devices first, let the estate arrive late.
- **A device created AFTER a membership gets no member key grants** (recorded in BACKLOG with the
  sweep design + the additive worker field it needs). Until then: remove + re-add the member
  re-mints everything, and the panel's own messages say so.
- **`assignment/finish` fileIds are the named Phase 4 blocker** — verify-or-stamp before members
  ever mint streaming URLs (route comment + plan updated).
- The **stale-worker rig trap** (27 phantom failures) is now impossible: the rig refuses a bound
  port with the pkill hint.

## 6. State of the branch

`claude/cut-tab-waveform-displays-2owdfx` @ `d73effd`, clean, pushed. v444 + BUILD_TAG
`phase-d-sharing v1` (bump to v446 for your test drive; v445 belongs to main's release). The live
worker still runs `aaaeecd`-era code — tonight's worker half is committed, not deployed. `main` is
still behind production for the worker; merging this branch to main after your test-drive closes
that gap (pushing main builds nothing — free).
