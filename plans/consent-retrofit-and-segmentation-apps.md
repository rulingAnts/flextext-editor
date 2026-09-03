# Two standalone Suite apps: consent retrofit, and audio segmentation

> **Status: BACK-BURNERED.** Specified by Seth 2026-09-02 — *"Let's back-burner those for now."*
> Do not start either without him raising it again. Recorded here so the specification survives
> rather than living in a chat log.

Both are **standalone apps in the FLExText Editor Suite**, not features bolted onto an existing
tool. They exist because a large back catalogue of texts predates the workflows that would have
captured what archives now require.

---

## 1. Consent collection app

Imports FLExText texts that already exist — with or without a recording, with or without audio
segmentation — and runs them through the **consent modal**, so a text ends up carrying consent it
was never captured with.

It must produce the **same receipts, results and prompts** as if the text had been recorded in
FLExText Editor / Recorder in the first place. There is no second-class consent record: a
retrofitted text and a natively recorded one must be indistinguishable downstream.

It then hands off through the **normal upload/save/send system**, so Researcher sees it almost as a
newly submitted text — manifest plus the usual options, or a downloadable bundle built from the
settings-configured exports, **including the audio consent**.

**The point is retrofitting consent onto legacy texts without re-recording them.**

## 2. Audio segmentation app

Does one thing: **segment audio, and match the resulting segments to lines of an existing
interlinear text.**

It must also offer to **discard existing segmentation and start fresh** — sometimes the existing
segmentation is bad enough that re-cutting beats correcting it.

It deliberately does **NOT** do adjustment. Someone with reasonably good segmentation who wants to
tweak it should use **ELAN**, or re-import into FLExText Editor, which gives them things this app
will not. Keeping adjustment out is what keeps the app small.

## 3. Two ELAN import paths in FLExText Editor

Same back burner, and they are what makes the segmentation app's *"use ELAN to adjust"* answer
actually workable — the round trip has to come back in:

- **ELAN + WAV import into FLExText Editor**, available in the editor itself. Optional, switched on
  or off by the researcher — or by the unpaired app's own settings when it is running standalone.
- **The text assignment modal should accept an ELAN file in lieu of a `.flextext`**, so a text can
  be assigned from what the user actually has.

---

## Why these two, and why now

**Consent is a hard requirement for archiving** — SIL International's, and every archive surveyed
(ELAR, PARADISEC, AILLA, TLA, Kaipuleohone, SIL REAP/RAMP). A corpus recorded before the consent
workflow existed cannot be deposited until that gap is closed, and re-recording is not an option
for texts whose speakers have died or moved away.

**Segmentation is the other thing legacy texts most often lack**, and it is the gate on time-aligned
transcription — which AILLA requires for anything published at *Public* access, and which is the
difference between an archive item and a searchable one.

## Relationship to the corpus progress checklist

Separate tool, separate repo (`fau_linguistics`, hosted on the Fayu Linguistics site). The checklist
only **records whether consent exists** — it tracks state, it does not capture anything. These two
apps are what would actually close the gaps the checklist makes visible.
