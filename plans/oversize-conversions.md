# Oversized recordings and the generated exports — PLAN (Seth, 2026-08-12)

> *"We also need a plan for what happens in this case with ELAN and SayMore packages (or fxpa). I
> think if the original is WAV, we can just use the original and put it in the zip or the fxpa file
> (well, not fxpa, because that's not a zip)."*

Seth is right, and the current guard is over-broad. This is the plan; **nothing is built yet.**

⚠ Context that keeps this in proportion: the recording that produced the toast was **deliberately
bloated to test upload chunking** — Seth: *"I deliberately converted it into as bloated a file as I
could."* Real field recordings are far smaller. So the goal is not to support gigabytes; it is to
stop refusing conversions we can plainly do, and to say something useful when we genuinely cannot.

## The bug in one line

`prepareConversionSources` refuses **every** conversion above one threshold
(`CONV_DECODED_MAX = 200 MB`, on a decoded-size estimate) — including for a WAV original, which is
never decoded at all. `if (isWav) segMedia = media;` skips `convertAudio` entirely, so the estimate
the gate is built on does not describe the work being refused.

### The actual case, from the v345 test drive (read off the screenshot, not assumed)

Text **"Two Women EXTENDED"** in Google Drive (unassigned): **217 MB · 3 files**. The Files ▾ menu
names the source as **`Two women EXTRA EXTENDED.wav · 217.3` MB** — a **WAV**. (The 939 MB in the
card's summary line is the total across all 42 unassigned texts, not this recording.)

So the refusal is `217 > 200`, on a **decode estimate for a file that is never decoded** — a WAV
17 MB over a ceiling that exists to bound `decodeAudioData`. Worse, the two rows it refuses already
describe themselves as *"EAF + tier order + **WAV** — built here, on click"*: the menu is telling
the researcher it will put the WAV in a zip, and then refusing because it thinks it must decode it.

This is the single clearest argument for the split below — a 10% overshoot on the wrong metric
costs the researcher every generated export on a text that needs no conversion at all.

## The three costs, measured from the code (not estimated)

| output | what the audio has to become | peak memory ≈ |
|---|---|---|
| **Recording package** | a zip entry, byte-for-byte | ~2× file size |
| **ELAN / SayMore zip, WAV original** | a zip entry, byte-for-byte | ~2× file size |
| **ELAN / SayMore zip, LOSSY original** | decode → Float32 PCM → 16-bit WAV → zip entry | **~10×**, then ~2× |
| **`.preview.html`** | base64 inside one HTML string | ~3–4× |
| **`.fxpa`** | base64 inside one JSON file | ~3–4× |

Where those numbers come from:

- **zip** — `zip.js makeZip` does `new Uint8Array(await entry.data.arrayBuffer())` per entry, CRC32s
  it, then `new Blob([...parts])` copies it again. Linear, two copies, no decode.
- **decode** — `convertAudio(await blob.arrayBuffer(), …)`; `decodeAudioData` yields Float32 per
  channel, which is why the existing `size * 10` estimate exists for compressed sources. It is the
  only genuinely expensive path, and it applies to **lossy sources only**.
- **base64** — `seg-exports.js toB64` builds a one-byte-per-byte JS string, `btoa`s it (+33%), and
  the result is interpolated into the HTML/JSON string. Three live strings at once. This is the path
  that truly cannot take a large recording.

**The proof that the zip path already tolerates what the gate refuses:** `buildRecordingPackage`
(the "Recording package" row) downloads and zips the same originals with **no size guard at all**,
and works. One row in the menu refuses what the row above it does routinely.

## Proposed rule: one gate per cost, not one gate for everything

Replace the single `tooBig` boolean with three named ceilings and a per-kind capability set:

| constant | governs | proposed value | why |
|---|---|---|---|
| `DECODE_MAX` | lossy → WAV conversion | **200 MB** decoded estimate (unchanged) | today's number, now applied only where decoding happens |
| `ZIP_MAX` | raw bytes as a zip entry | **2 GiB** | the two-copy cost above; ⚠ `zip.js` is ZIP32 (`le32` sizes/offsets) with **no Zip64**, so ≥ 4 GiB silently wraps and writes a corrupt archive — that is a hard wall to name in a comment, not a limit to approach |
| `EMBED_MAX` | base64-into-one-file | **150 MB** | preview/`.fxpa` hold 3–4 copies as strings; this is the one that must stay strict |

`prepareConversionSources` then returns `caps = { elan, saymore, preview, fxpa }` instead of
`tooBig`, computed from the source's real shape (`isWav`, size) — and it **only fetches and decodes
what the requested kind needs**, so asking for an ELAN zip of a WAV never pays the decode cost it
currently pays the guard for.

Concretely, for "Two Women EXTENDED" (**217 MB WAV**): ELAN ✓, SayMore ✓, preview ✗, `.fxpa` ✗ —
two of the four rows that are refused today start working, and the two that stay refused say why.

⚠ **`EMBED_MAX` at 150 MB is a judgement call, not a measurement**, and it is the one number here
worth checking against a real machine before shipping. 217 MB of WAV becomes ~290 MB of base64 on
top of the byte-string and the assembled document; a desktop may well survive it and a low-end field
laptop may not. If it turns out to be comfortably fine, raise it — the constant exists so that is a
one-line decision rather than a rewrite.

## What changes in the UI

1. **Rows are disabled with the reason, before the click.** A menu that refuses on click after a
   long download is the worst version. Show `.preview.html` and `.fxpa` greyed with an inline
   "too large to embed (217 MB)" — the same disabled-with-a-reason pattern the send options already
   use (`setup.off.*`). This is the part that actually answers "what happens in this case".
   ⚠ Cheap, because the affordance already exists: every row in that menu **already renders a
   `.rp-dl-sub` line** carrying its own description and size estimate ("EAF + tier order + WAV —
   built here, on click · about …"). The reason goes there. No new layout.
2. **`panel.dl.tooBigConvert` is replaced.** The current string is a blanket refusal
   ("too large to convert in the browser — download the original instead") and would now be a lie on
   a row that works. New strings name **which** outputs are unavailable and why, in en **and** id.
3. **Download-all delivers the possible ones and reports the rest.** Today `src.tooBig` skips every
   conversion with one message; it should include ELAN/SayMore and say precisely which files were
   left out.

## Open question for Seth — lossy original above `DECODE_MAX`

A large **lossy** original still cannot be converted. Two options:

- **(a) Keep refusing** — with a message that names the reason and points at Recording package.
- **(b) Ship the ELAN zip pointing at the lossy original**, unconverted.

⚠ **(b) is not free and I do not recommend it silently.** The derived WAV exists precisely because
AAC priming makes decode and playback disagree by ~44 ms, so an EAF referencing the lossy original
is *quietly* misaligned — the same class of thing as a false alignment, which the segmentation
design deliberately refuses to invent (`~` estimated markers exist for exactly this reason). If it
is offered at all it must be a distinct, explicitly-labelled row, never the default fallback.

**Recommendation: (a) now**, and let the Electron fallback below be the real answer for big lossy
files.

## Tests

- `prepareConversionSources` caps as a pure table: WAV 900 MB → `{elan:1, saymore:1, preview:0,
  fxpa:0}`; lossy 900 MB → all 0; WAV 50 MB → all 1. This is the whole plan in one assertion.
- No decode is attempted for a WAV source at any size (pin the absence — that is the bug).
- `zip.js`: a comment + test pinning the ZIP32 ceiling so nobody raises `ZIP_MAX` past 4 GiB
  without adding Zip64.
- The Download-all path reports skipped kinds individually rather than as one blanket message.

## Not in scope here

Chunked/streaming zip writing (would remove the 2× and the ZIP32 wall) and streaming base64. Both
are real engineering, neither is warranted by field file sizes.
