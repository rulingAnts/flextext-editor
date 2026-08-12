# Oversized recordings and the generated exports — APPROVED BUILD SPEC (Seth, 2026-08-12)

> *"We also need a plan for what happens in this case with ELAN and SayMore packages (or fxpa). I
> think if the original is WAV, we can just use the original and put it in the zip."*

**Round 2 decisions are LOCKED (below). Not yet built.**

⚠ Context that keeps this in proportion: the recording that produced the toast was **deliberately
bloated to test upload chunking** — Seth: *"I deliberately converted it into as bloated a file as I
could."* Real field recordings are far smaller. The goal is not to support gigabytes; it is to stop
refusing conversions we can plainly do, and to degrade honestly when we cannot.

## The bug in one line

`prepareConversionSources` refuses **every** conversion above one threshold
(`CONV_DECODED_MAX = 200 MB`, on a decoded-size estimate) — including for a WAV original, which is
never decoded at all. `if (isWav) segMedia = media;` skips `convertAudio` entirely, so the estimate
the gate is built on does not describe the work being refused.

### The actual case, from the v345 test drive (read off the screenshot, not assumed)

Text **"Two Women EXTENDED"** in Drive (unassigned): **217 MB · 3 files**, source
**`Two women EXTRA EXTENDED.wav · 217.3` MB** — a **WAV**. (The 939 MB on the card is the total
across all 42 unassigned texts, not this recording.)

So the refusal is `217 > 200` on a **decode estimate for a file that is never decoded**. Worse, the
rows it refuses already describe themselves as *"EAF + tier order + **WAV** — built here, on click"*:
the menu says it will put the WAV in a zip, then refuses because it thinks it must decode it.

## The three real costs, measured from the code

| output | what the audio has to become | peak ≈ |
|---|---|---|
| **Recording package** | zip entry, byte-for-byte | ~2× (already unguarded, and works) |
| **ELAN / SayMore, WAV original** | zip entry, byte-for-byte | ~2× |
| **ELAN / SayMore, LOSSY original** | decode → Float32 PCM → 16-bit WAV → zip entry | **~10×**, then ~2× |
| **`.preview.html`** | base64 inside one HTML string | ~3–4× |
| **`.fxpa`** | base64 inside one JSON file | ~3–4× |

`makeZip` does `arrayBuffer()` per entry then copies into a Blob (two copies, no decode);
`convertAudio` decodes to Float32 per channel (the only genuinely expensive path, **lossy only**);
`toB64` holds a byte-string, its base64 (+33%), and the assembled document — three live strings.

## 🔒 LOCKED DECISIONS (Seth, 2026-08-12 round 2)

**One ceiling, not three.** `CONV_DECODED_MAX = 200 MB` keeps its name and value and becomes the
single "too big to decode/embed" line. The 150 MB `EMBED_MAX` I floated is **dropped** — Seth:
*"set the ceiling at 200MB, not 150MB."* Fewer knobs, one number to reason about.

| output | above the ceiling | why |
|---|---|---|
| **ELAN / SayMore** | **ship the ORIGINAL audio unconverted** — never refuse | the zip only needs the bytes; the EAF references media by name either way |
| **`.fxpa`** | **generate it WITH NO AUDIO, and warn** — never refuse | the analysis structure is the value; PAT can still group a text-only `.fxpa` |
| **`.preview.html`** | **REFUSE** | Seth: *"The whole value of that is the embedded sound and following/auto-scrolling/segmented players."* A preview with no audio is a worse `.flextext` |
| **any zip > `ZIP_HARD_MAX` (3.5 GB)** | **refuse loudly** | `zip.js` is ZIP32 (`le32` sizes/offsets), so ≥ 4 GiB silently writes a CORRUPT archive |

**Lossy original shipped unconverted ⇒ WARN about alignment.** The derived WAV exists because AAC
priming makes decode and playback disagree by ~44 ms. Shipping the lossy original is allowed, but
the researcher must be told, never silently handed a quietly-misaligned EAF.

**Native fallback: leave STUBS now — Electron AND Capacitor.** If running in a native shell, hand
the oversized conversion to it; otherwise use the original. Seth: *"Fallback on Electron Native
(leave a stub for that) if running in Electron, but if not running in Electron, then just use the
original"*, then: *"we need a Capacitor stub (that only fires when run in a Capacitor environment)
as well."* Design in its own section below — it touches the hard native boundary.

**On `ZIP_HARD_MAX`** — Seth: *"with THIS app at least, it's exceptionally unlikely we'll ever be
anywhere near that limit. Lots of other limits (bandwidth, browser storage, memory) would break
first."* Agreed. Its value is not that it will fire; it is that the failure it replaces is **silent
corruption** — a zip that looks fine and is not. Cheap insurance, loud when wrong.

## ⚠ THE BIG FINDING: `seg-exports.js` NEEDS NO CHANGES

Every decision above is already a supported code path in `assembleSegEntries`. Verified by reading
it, not assumed:

- **Ship-the-original is literally the already-WAV path.** `segMediaName` is
  `segMedia.derived ? derivedWavName(base) : mediaNameFor(base, segMedia)`; `mediaMime` adapts
  (`wavName ? 'audio/x-wav' : segMedia.mimeType || 'audio/*'`); the SayMore `.annotations.eaf`
  filename is built **from `segMediaName`**, so it follows the audio actually shipped; the BWF
  `bext` stamping is gated on `segMedia.derived`, so an original correctly gets no
  "DERIVED — NOT an archival master" chunk. And `buildSegEntriesFor` **already** pushes a
  non-derived `segMedia` into the zip explicitly. Setting `segMedia = media` is the whole change.
- **Text-only `.fxpa` is already first-class.** `const fxpaAudio = segMedia && segMedia.blob ? {…}
  : null;` with the comment *"deliberately NOT gated on alignment: an unaligned or audio-less doc
  exports a TEXT-ONLY .fxpa the paragraph app can still group."* Passing `segMedia: null` is the
  whole change — which is also why the menu row already reads "text-only when unaligned".

**Consequence for blast radius:** the work is confined to `researcher-panel.js`, `zip.js`, and
i18n. No new top-level `import` in `js/app.js`, so **no SHELL entry, no satellite `sw.js` change,
no v108-shaped risk.** The one exception is the wording change below.

### The one deliberate exception: `howToOpenText`

The alignment warning must not live only in an 8-second toast. `assembleSegEntries` already emits
`HOW-TO-OPEN.txt` on the principle that *"the instructions travel WITH the files"* — and it already
receives `derived`. Add the lossy-unconverted caveat there, so the warning survives in the zip the
researcher opens next week. Small, additive, and the right home for it.

## What changes, by file

**`docs/js/researcher-panel.js`** — `prepareConversionSources` returns `caps` + a `degraded` reason
instead of `tooBig`; above the ceiling it sets `segMedia = media` (originals) rather than returning
early; `runMenuConversion` passes `segMedia: null` for an oversized `.fxpa`, refuses `preview`, and
raises the warnings. Menu rows render their state in the **`.rp-dl-sub` line that already exists**
on every row — no new layout.

**`docs/js/zip.js`** — `ZIP_HARD_MAX = 3.5 * 1024³`; `makeZip` throws a named error when the running
total would exceed it, plus a comment stating the ZIP32 `le32` reason so nobody raises it to 4 GiB
without adding Zip64.

**`docs/js/native-convert.js`** (new) — the native offload stubs. See the section below; it is the
one part of this that touches the hard native boundary and it must be got right.

**i18n** — new strings in **en AND id**: fxpa-without-audio, preview-refused, lossy-alignment
warning, zip-too-large. The blanket `panel.dl.tooBigConvert` is retired; it would be a lie on a row
that now works.

## The native stubs — Electron AND Capacitor (Seth, 2026-08-12)

⚠ **`docs/js/native-audio.js` is the single chokepoint for BOTH bridges, not just Android.**
`check-native-containment.sh` greps `docs/js/` for `window.Capacitor|Capacitor.Plugins` **and** for
`__flextextNative`, failing on any hit outside that one file. So an Electron stub is under exactly
the same rule as a Capacitor one — a correction to what this plan said in its first draft, which
treated Electron as unconstrained.

**How the stub stays legal without touching `native-audio.js` at all.** That file already exports
the detectors this needs — `isNativeShell()`, `nativePlatform()`, `nativeCapabilities()`,
`nativeEngineInfo()`. `native-convert.js` imports those and never names a global. Detection: free
and already built.

**What the stub does NOW:** `nativeConvertAvailable()` returns **false**, always. There is no bridge
method to call yet, on either platform. Every caller therefore takes the browser path, which after
this change means *use the original* — precisely the behaviour Seth specified. The stub exists so
the decision point is written down once, in the right place, rather than rediscovered later.

**⚠ Gate on CAPABILITY, never on platform — this is the part that will be got wrong.** Being inside
Capacitor does not mean the installed APK can convert anything: **the engine auto-updates and the
APK does not**, so field devices run older plugins indefinitely. If the stub ever graduates to
`isNativeShell() ? offload() : fallback()`, every pre-feature APK gets asked to convert, fails, and
the researcher loses the fallback that would have worked — a regression that only appears in the
field, on the oldest devices, which is the worst place to find one. Gate on the async
`nativeCapabilities()` (the existing `EXPECTED_CONTRACT` negotiation), and treat "unknown" as no.

**When it graduates, `native-audio.js` DOES get edited — deliberately.** The actual bridge call has
to live there, and per CLAUDE.md that is the signal to STOP and rebuild + re-test the APK, not
something to slip in beside a panel feature. Building the stub now costs nothing and touches
nothing; building the bridge is its own release with its own APK.

### ⚠ The device-side case is the stronger one, and it already exists

`convertAudio` has four call sites, but the one that matters most is not any of them: `app.js`
**`segWorkingMedia`** does its own inline `decodeAudioData` + `encodeWav` to build the `segwav:`
working copy — **on the field device, in the editor**, for every lossy recording in segmentation
mode. And it already ends in:

```js
} catch { return media; }   // undecodable → play the original; alignment caveat stands
```

**The fallback Seth just specified for the panel is already the device's behaviour, with the same
reasoning and the same caveat.** The panel is the outlier that refuses instead of degrading — which
is further evidence the fix is a degradation ladder, not a bigger ceiling.

It also means a native converter would pay off most on a **phone**, where memory is tightest and a
big lossy recording silently loses alignment today. Worth remembering when the native side is
scoped: this plan's panel case is the smaller half.

## Tests

- Caps table, pure: 217 MB WAV → ELAN ✓ SayMore ✓ preview ✗ fxpa ✓(no audio); 900 MB lossy → ELAN ✓
  (original + warning) preview ✗ fxpa ✓(no audio); 50 MB anything → all ✓ converted.
- **No decode is attempted for a WAV at any size** — pin the absence; that is the original bug.
- An oversized-lossy ELAN zip contains the ORIGINAL, its EAF's `RELATIVE_MEDIA_URL` names that
  file, the `.annotations.eaf` matches it, and **no `bext` chunk claims it is derived**.
- `.fxpa` built with `segMedia: null` parses and has no `audio` key.
- `makeZip` throws (not truncates) past `ZIP_HARD_MAX`.
- `./check-native-containment.sh` still passes with `native-convert.js` present — i.e. the new
  module names neither `window.Capacitor` nor `__flextextNative`. This is the assertion that keeps
  the stub honest, and it is already automated.
- `nativeConvertAvailable()` is false in a plain browser **and** false when `isNativeShell()` is
  true but capabilities are unknown — pin the platform-vs-capability distinction, since that is the
  failure that would only surface on old field APKs.

## Not in scope

Streaming zip writing and streaming base64 — real engineering, not warranted by field file sizes.
The Electron implementation itself (stub only here; see `plans/BACKLOG.md`).
