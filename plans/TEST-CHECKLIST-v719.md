# Manual test checklist — staging, v717 + v718 + v719

**Ready.** The adversarial review is done — two waves, ten independent finders, thirteen confirmed
findings, all fixed. The version badge reads **`time-gaps v2`**; if it says anything else you are not
testing this build.

On staging: `a696dd0`, ENGINE_VERSION `v719`. Deploy it from Actions → **Deploy to staging /
preview** from branch `staging`, ticking **all** apps — this wave spans the editor and the Audio
Segmenter, and staging's aliases can otherwise sit at different versions.

## What is already machine-verified — you do not need to re-check these

So your time goes on what only you can judge:

- **976/976 node tests**, exit 0 — 962 before the review, plus 14 pinning its findings.
- **26/26 browser checks** clicked in real Chromium — including R9 (39 gap rows on ELAN40, ▶ plays
  the gap, Add here → 41 lines → one Undo → 40, Add all → 79 → one Undo → 40, Enter jumps to the
  next *line* not a gap row, dock mark k drags seam k), R10 (✂ with the playhead in a gap adds a
  line, one Undo) and R12 (375 px, no horizontal scroll).
- **The corpus gate** on the timing skeletons: 0 time changes on placed lines, 0 lines gained on
  open, 0 placeholders written, 0 stamped writes.
- All 33 `docs/js` modules parse as real ES modules; native containment PASS; no new top-level
  import in `app.js`, so no SHELL change and no v108-class risk.
- Every one of the thirteen fixes was checked by **reverting it and watching its test fail** — so
  these are regression tests, not decoration.
- Version sync across all seven sites at v719.

## 1. The judgement only you can make — is this the right amount of machinery?

**This is the first and most important item.** On 2026-10-09 you rejected a gap interface:
*"We don't actually want that interface. It's too much machinery and too buggy."* That work
(v709–v713) is parked. v719 is the re-think — gaps are **drawn only**, nothing is written until you
click, and the whole feature is two dock buttons plus a thin row.

Open ELAN40 with its audio in Segmentation mode and just look at it for a minute:

- [ ] With 39 gap rows on screen, is the Baseline tab still **readable**, or does it now look like
      twice as many lines as the text has?
- [ ] Is it obvious at a glance which rows are **your text** and which are **unclaimed audio**?
- [ ] Does "Show gaps (39)" give you a clean way out when they are in the way?
- [ ] Is this less machinery than what you rejected, or the same amount wearing a different coat?

If the answer to the last one is "the same", say so and stop testing — the rest does not matter.

## 2. Gaps on a real file with real audio

The automated checks use **timing skeletons** (the real files' times with none of their words). Only
you can run this on real texts with real recordings.

- [ ] A pause you know is silence shows as a plain gap row; a pause you know contains **speech**
      is tinted amber. Does the amber actually correlate with speech, or does it fire on noise?
- [ ] ▶ on a gap row plays **just that gap**, and when it finishes the playhead has not wandered
      somewhere that makes the next ▶ jump.
- [ ] "Add a line here" adds **one empty line in the right place** — your text above and below it
      is untouched, glosses and free translations included.
- [ ] One Ctrl+Z puts it back. One redo re-applies it. (Not two of either.)
- [ ] "Add a line for every gap" asks first, then adds them all, and **one** Ctrl+Z returns to where
      you were.
- [ ] A gap shorter than about a third of a second does **not** get a row.

## 3. The damaged L29 file — case 16

This is the one real file with a red "lines and audio look out of step" banner.

- [ ] The red banner appears, and the tail gap row shows **with no Add button**.
- [ ] After you dismiss the banner, Add appears.
- [ ] Dismissing is quiet — it does not mark the text modified or trigger an upload.

## 4. v717 and v718 ride along — they have never been in production either

Staging carries all three versions. Production is v716, so **everything below is also new to the
field**, not just the gap rows.

- [ ] **v717 banners** read true on your files: the estimate banner on E78/E19, the "no times yet"
      info banner on a FLEx export, the red one only on the damaged L29s.
- [ ] **v717 per-edge drags**: dragging the edge next to a pause moves **only that edge** — the
      pause is not swallowed.
- [ ] **v718 untimed lines** draw dashed in their share of the gap with an amber "needs timing"
      mark, and the Gloss tab shows the same bars.
- [ ] **v718 Keep times** on the active line makes it solid, one Undo, one Redo.
- [ ] **Opening is not an edit**: open a text that is in sync with Drive, close it, and confirm it
      did **not** re-upload.

## 5. Exports — the part no test can do

Automated tests validate the XML. Only you can open it in the real applications.

- [ ] Add a gap line, export, and open the `.flextext` **in FLEx**. The new empty line is there with
      its times; every other line's times are unchanged.
- [ ] Open the `.eaf` **in ELAN**. Tier order is right (no gloss tier above its own vernacular
      partner), there is **no segnum tier**, and the empty added line does not break the file.
- [ ] Drop `<audio>.annotations.eaf` beside the audio in a **SayMore** session folder and confirm it
      is picked up.
- [ ] Round trip: export, re-import, and the spans come back the same.

## 6. The researcher gate

- [ ] From the panel, switch **gap lines** off and push it. On the device, the gap rows, both dock
      buttons and the Add controls all disappear.
- [ ] Switch it back on; they return.
- [ ] A device with **no researcher session** gets gap rows by default (the `!hasSession()` half of
      the gate).
- [ ] The device-side "Show gaps" preference survives a reload.

## 7. Looks and reach

- [ ] **Dark mode**: the gap tint and the amber speech tint are still distinguishable from each
      other and from a real row, and the text on them is legible.
- [ ] **Phone (Android Chrome, the real field device)**: no horizontal scroll, and both gap buttons
      are big enough to hit with a thumb.
- [ ] **Indonesian**: switch languages and confirm no raw key strings (`gap.addHere` etc.) appear
      anywhere in the new UI, including the confirmation dialog and the release-notes modal.
- [ ] The ✨ guess button is still the **last** control on the dock.

## 7b. One thing I did not change — your call

v719 defines dark-mode `--gap-*` colours, so with the OS in dark mode a gap row renders near-black
**inside an otherwise white app** (there is no dark page theme: `--bg: #ffffff` has no dark
override, and `.seg-strip` is hard-coded white).

I left it alone because **v717 already does exactly the same thing** for the timing banners, which
are on staging now — so this is one pattern spanning two releases, not a v719 bug, and narrowing it
is a design decision rather than a fix. It also sits against your 2026-10-09 line, *"Only the panel
gets a dark mode variant. Other apps don't."*

- [ ] Look at a gap row and a timing banner with your OS in dark mode. If they should both follow
      the white page, say so and I will strip both sets of tokens in one change.

## 8. Before any production release — not part of this test pass

- [ ] `BUILD_TAG` must be cleared to `''`. While it is set, the badge shows the feature name **and**
      `test/release-notes-current.test.mjs` does not fire, so the release-notes guard is silent
      exactly when you need it.
- [ ] The `RELEASES` entry must name v719 and **its words must still be true** — re-read them
      against what actually shipped (the v538 lesson).
- [ ] This wave touches the engine, the data model and exports, so by CLAUDE.md's blast-radius test
      it **soaks on beta first**. Note that the seven `<worker>-beta` Workers do not exist yet; the
      first "Deploy to beta" creates them and their custom domains are attached by hand afterwards.
