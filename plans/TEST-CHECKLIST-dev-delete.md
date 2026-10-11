# Manual test checklist — staging, developer mode (v720–v723, `dev-delete v4`)

**Ready.** The second adversarial review is done — 18 agents, 12 confirmed findings, all fixed, plus
auto-trash on panel load. The version badge reads **`dev-delete v4`**; if it says anything else you
are not testing this build.

On staging: `d1c6a14`, ENGINE_VERSION `v723`, deployed to all seven apps from Actions → **Deploy to
staging / preview** (run 297). Check the engine with `/js/i18n.js` on the editor and
`/flextext-editor/js/i18n.js` on every other app — not `/sw.js` on the satellites.

## What is already machine-verified — you do not need to re-check these

- **1009/1009 node tests**, exit 0 — 1002 before the review, plus the lifted behavioural tests of the
  delete gate, the tombstone clock and cap, and the panel's claim set / open set / auto-trash.
- Each of the twelve fixes was checked by **reverting it and watching its test fail**.
- No new top-level import in `app.js`, so no SHELL change and no v108-class risk; version sync
  across all seven sites at v723; no worker change at all.

## 0. Read this before arming anything

Arming is per browser and persistent: `fxDev()` in the console; the red ☠ badge bottom-left says it
is on, and its own button turns it off. **A device you arm obeys the panel's "Remove, no backup" for
any un-uploaded text on it** — arm only test devices. Nothing here needs a real text: make throwaway
ones.

## 1. ⚠ THE ONE THAT MATTERS — the ordinary paths are unchanged on an armed device

This is the data-loss finding. Do it first, on an armed test device with a text that has been
uploaded once.

- [ ] Edit the text, press the ordinary **🗑**, let it queue the upload, then **reopen the text and
      keep editing while the upload is in flight** (airplane mode on, 🗑, edit more, airplane mode
      off). When the upload lands the text must **still be there** with your later edits; the
      console says `refusing remote delete — not safely on Drive`.
- [ ] From the panel, ordinary **Remove from device** on an un-uploaded text of an armed device →
      the device refuses (text stays), same console line.
- [ ] Delete-after-upload (Done → upload → remove) still removes a text only once its upload is
      confirmed — same as before.

## 2. The ☠ on the device

- [ ] Reload every app you have installed — editor, Audio Segmenter, recorder, researcher panel — on
      an armed browser: the **badge is there on boot**, before you touch anything (finding 9).
- [ ] `fxDev()` typed in the **researcher panel's** console on the **sign-in screen**: no crash, the
      sign-in screen stays (finding 10). Sign in → the dev buttons are there.
- [ ] The ☠ sits beside the 🗑 on every text list (editor list, Segmenter list, recorder list) and
      nowhere when disarmed.
- [ ] ☠ a text that **has** been to Drive: the confirm names the Drive folder being trashed; the text
      goes locally; `fxTombs()` lists it with its folder.
- [ ] ☠ a text that has **never** been to Drive: no tombstone (`fxTombs()` says none flagged).

## 3. The panel — tombstones, Unassigned, and the trash

Panel **not** armed first:
- [ ] The ☠'d text shows under its device **struck through, tagged "removed, no backup"**, with NO
      Upload / Move / Done toggle / state chip / Files menu, and NO trash button (finding 12).
- [ ] **It does NOT appear under Unassigned** (finding 2 — this is the hard requirement), not on this
      render and not after a manual refresh. In Drive, the folder is **still under the device**, not
      moved into Unassigned.
- [ ] Storage view: the text is not listed as unassigned.

Then arm the panel (`fxDev()` in its console):
- [ ] The row gains **"Remove, no unassign"**. Click → confirm says Drive's trash, recoverable ~30
      days, not Unassigned → folder is in Drive's **trash**; row gone; toast "Moved to Drive's trash".
- [ ] ☠ another uploaded text on the device, then **reload the panel**: it trashes it **by itself** on
      load, toast "Developer mode: sent 1 removed-text folder(s)…" (C3). Nothing was confirmed in the
      panel — the ☠ dialog was the confirm.
- [ ] Unassigned never showed either folder at any point; neither is in Unassigned in Drive.

## 4. Reuse of a docId (finding 5)

- [ ] ☠ an uploaded text on device A (tombstone written). From the panel, **assign the same text
      back** to device A (or to device B) — the text returns under the same id into the same folder.
      The tombstone row must be **gone** and the panel must **never** offer that folder for the
      trash, armed or not. On device A, `fxTombs()` no longer lists it after the next report.

## 5. "Remove, no backup" from the panel

- [ ] Panel armed, device armed, un-uploaded text: **Remove, no backup** → device deletes it; if the
      text had a Drive folder, a tombstone row appears and an armed panel trashes it on its next load.
- [ ] Same, device **not** armed → refused, text stays, no tombstone.
- [ ] A text already safely on Drive: removed either way — the confirm says so now (finding 13).

## 6. Regression danger areas this touched

- [ ] **Unassigned card and sweep** (`assignedDocIds` changed): a text you genuinely unassign (remove
      from a device the ordinary way, upload confirmed) still appears under Unassigned and is swept
      there as before. A text mid-move / mid-assign still does not.
- [ ] **Storage view** groups texts the same as before for ordinary texts.
- [ ] **Sync reports** still arrive (device cards update within ~20 s) — a new `onReported` hook rides
      the report path.
- [ ] **Boot** of every app with developer mode OFF looks exactly as before — no badge, no ☠.
