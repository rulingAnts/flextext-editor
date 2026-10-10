# Danger checklist — v717 + v718 + v719 before production

Production is **v716**. This wave is **three unreleased engine versions at once**, all touching the
timing model, the data model and exports. Ordered by what it costs if it is wrong, not by how likely
it is. Each item says what to do, what you should see, and why it is on this list.

## 0. Blockers — mechanical, already verified

- [x] **With `BUILD_TAG` cleared, the whole suite passes** (976/976), the release-notes guard passes,
      version-sync passes, `engNum` parses to **719**. Checked by actually clearing it and running
      them — so nothing fails at the last step of your push.
- [ ] **`BUILD_TAG` must be `''` before the production commit.** It currently reads `'time-gaps v2'`.
      While it is set, `test/release-notes-current.test.mjs` **does not fire at all** — the guard that
      protects the release is silent exactly when you need it — and the badge shows a feature name in
      production.
- [ ] **Beta.** By your own rule this wave soaks on beta: it changes UI, data and functionality, not
      just stability. The exemption fits the thirteen review fixes, not the wave carrying them.

---

## ⚠ Tier 1 — could lose a coworker's typed work

### 1.1 The CLASSIC textarea, segmentation OFF — the one most likely to be skipped

**Segmentation is researcher-gated and defaults OFF, so most production users never see a gap row.
But v717 rewired the classic box's save path** (`applyBaseline` → `reconcileBaselineWithOrigins` →
`segmentsFollowLines`). Every visible new feature is in segmentation mode, so the instinct is to test
those — and the regression risk for the majority of your users is here.

- [ ] Segmentation **OFF**. Open a text that already has audio times. Type a **new line in the
      middle** of the textarea. Save, close, reopen.
      - **Expect:** every original line still carries **its own** time. No line has taken its
        neighbour's. Glosses and free translations are still on the lines they belong to.
      - **Why:** a mis-pairing here moves someone's gloss onto the wrong sentence *permanently*, and
        it looks like nothing at save time. This is the 2026-08-16 failure.
- [ ] **Move** a line — cut it and paste it several lines away. Save, reopen.
      - **Expect:** it keeps its words but **not** its old time. The recording's order is fixed.
- [ ] If the app ever had to fall back to pairing by position, the timing banner should be **red**
      ("lines and audio look out of step"). Seeing red here is correct behaviour, not a bug —
      silently keeping wrong times would be the bug.
- [ ] Ctrl+Z after each: one undo step per typing session, and it restores text **and** times.

### 1.2 One action = one Undo (your rule)

- [ ] Segmentation ON, a text with gaps. **"Add a line for every gap (N)"** → confirm → **one**
      Ctrl+Z returns you exactly to before. Not N presses.
- [ ] **"Add a line here"** on one gap → one Ctrl+Z. One Redo puts it back.
- [ ] **Keep times** on a dashed line → one Ctrl+Z.
- [ ] A join, and a split at the playhead → one each.
- [ ] A **refused** Add (while the red banner stands) leaves **no** undo item at all.

### 1.3 Placeholders must never be stored or written

- [ ] Open an **untimed** text (any plain FLEx export) **with** its audio, segmentation ON. The lines
      draw dashed, spread across the recording, with one quiet info banner.
- [ ] **Change nothing.** Close it. Reopen it.
      - **Expect:** still dashed and still untimed — the spread was *drawn*, not saved.
- [ ] Export it without editing.
      - **Expect:** **no** time offsets in the `.flextext` at all.
      - **Why:** if the drawn spread ever reaches storage, every untimed text in your corpus gains
        fabricated times, and they go to FLEx looking like measurements.

---

## ⚠ Tier 2 — goes permanently into someone's FLEx or ELAN

A bad export is not recoverable by updating the app. It is already in the database.

- [ ] Export a timed text → open the `.flextext` **in FLEx**. Times land on the right phrases; no
      duplicated lines; no unexpected empty phrases.
- [ ] Open the `.eaf` **in ELAN**. Tier order is right (no gloss tier above its own vernacular
      partner), **no segnum tier**, and nothing refuses to load.
- [ ] A text with `~` **estimates** (E78-shaped): export, then re-import into the app.
      - **Expect:** still marked as estimates. The `~` survives the round trip.
      - **Why:** v717 exists so a guess never leaves as a measurement — and the review found exactly
        that leak in v719's first draft.
- [ ] **Add a gap line, then export.** The new line is there with its own times; every other line's
      times are byte-for-byte unchanged.
- [ ] A gap added **between two estimated lines** exports with `~` on the inherited edge — not as a
      hard time. (This was the most serious review finding; worth confirming by eye.)
- [ ] Drop `<audio>.annotations.eaf` beside the audio in a **SayMore** session folder → picked up.

---

## ⚠ Tier 3 — could kill offline support silently (the v108 class)

This is the failure that destroys the entire point of a field app, affects **only new installs**, and
shows no error anywhere.

- [ ] On a real device: let the editor update to v719 (or `?devreset` and install fresh). Then turn
      the **network off** and reload.
      - **Expect:** it still opens and still works.
      - **Why:** if any precached module 404s, the service-worker install *throws* and a new install
        gets no offline shell at all.
- [ ] Same test on the **Recorder** and the **Audio Segmenter** — they carry their own SHELLs.
- [ ] Check the version badge actually changed on the device. If it still says v716 the update did
      not reach it, and nothing below was really tested.

---

## ⚠ Tier 4 — one engine, seven faces

An engine change changes every app at once. The two that matter most are the ones **community
members** use, not your team.

- [ ] **Crowd recorder** (community-facing): loads, records, submits.
- [ ] **Consent collector** (community-facing): loads, records consent.
- [ ] **Recorder**: record, save, and the recording survives a reload.
- [ ] **Researcher panel**: opens with no console errors; a settings push reaches a device; the
      release-notes modal shows the v719 entry — check it in **both** languages.
- [ ] **PAT** (pat.flextext.app): opens a `.fxpa`, groups paragraphs.
- [ ] **Audio Segmenter**: open a recording, cut, Done — and confirm Done adds **no** stray tail line.

---

## ⚠ Tier 5 — field bandwidth

- [ ] Open a text that is **already in sync with Drive**. Change nothing. Close it.
      - **Expect:** it does **not** re-upload.
      - **Why:** v717/v718 write quietly on open (reading estimates back, seeding one-line docs). If
        any of that stamps `modified`, every text a field worker opens re-uploads over a village
        connection.
- [ ] Open the same text twice in a row — the second open should also be silent.

---

## ⚠ Tier 6 — the Android APK

- [ ] If any field device runs the APK: the **engine auto-updates under it, the APK does not**. Open
      it, record, save, and confirm the recording lands in IndexedDB.
      - `check-native-containment.sh` passes and nothing in this wave touched
        `js/native-audio.js`, so this is a confirmation rather than a suspicion — but it is the one
        failure you cannot fix by pushing again.

---

## Your own rule, applied per version (Seth, 2026-10-10)

> *"For enhancements, or less critical issues where the risk of doing something hastily is greater
> than the risk of leaving something broken, we go through beta first."*
> *"…for fixes that are thoroughly tested and purely aimed at making the current feature set more
> stable rather than making changes to the UI/UX/data/functionality… we can skip beta."*

The two halves point different ways for different parts of this wave, which is the argument for not
shipping it as one lump:

| | what it is | risk of leaving it | risk of haste | verdict |
|---|---|---|---|---|
| **v717** | truth and safety. Production **right now** writes v714's even-spread seeds into exports as if they were measured times — fabricated alignments arriving in FLEx looking real. | **Real and ongoing.** Every export from a seeded text carries it. | Moderate: it rewires the classic box's save path, which most users are on. | the one with a genuine "leaving it broken" cost |
| **v718** | untimed lines drawn rather than stored. Mostly the same safety argument, plus new drawn UI and the `keepTimes` control. | Moderate — it is what stops v717's placeholders being stored. | Moderate: new UI, new data states. | rides with v717; they are one design |
| **v719** | gap rows. A **new feature**: nothing is broken without it. | **None.** No one is waiting on it. | Higher: two new controls, a new insert path, and it is the design you rejected once already. | **enhancement → beta first, by your own rule** |

**So the shape your rules actually imply:** v717 + v718 to production after your Tier 1/2/3/5 pass
(the truth fix has a cost to leaving it), and **v719 through beta** — it is an enhancement, nothing
is broken without it, and the risk of haste plainly exceeds the risk of waiting.

That also happens to be the diagnosable order, below.

## If you want to cut the risk in half instead of testing more

These are **three** versions. If something misbehaves you will not know which one caused it, and a
rollback takes all three. The cheaper shape, if you have the patience for one more round:

1. Ship **v717 + v718** first (truth, safety, untimed lines — no new controls to learn).
2. Then **v719** (gap rows) on its own.

Tier 1.1 and Tier 5 belong to v717/v718; Tiers 1.2, 2 (gap items) and 4's Segmenter line belong to
v719. Splitting makes a bad outcome diagnosable instead of a three-way guess.
