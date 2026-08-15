# The loose-file converter — SHIPPED v377 (staging)

> Seth, 2026-08-14, and this is the whole specification:
>
> *"Basically, what we want is exactly the same thing that our files drop down box already does for
> texts that are on Google Drive, except that the user can submit their own flextext and matching
> audio file in order to generate any of the outputs that the files drop down can do, except we
> wanna give the user a backup way to do it with files they just happen to have lying around that
> match. That's the goal of this utility, period."*
>
> And, 2026-08-15: *"our utility here should be on the utilities modal for both Researcher panel AND
> for unpaired Editor sessions (with the settings tab)."*

**Where it is:** editor **Utilities** tab (no pairing, no reveal — an unpaired editor gets it) and
the researcher panel's **Utilities** modal. Both offer the same five rows the Files ▾ menu offers:
ELAN package, SayMore package, listening page, `.fxpa`, and the `.flextext` itself.

## The one design decision everything else follows from

**PARITY is the feature.** Two ways to obtain "the ELAN export" that disagree is worse than only
having one, because the researcher cannot tell which they got. So the decisions live in
`docs/js/seg-exports.js` and are *called*, never re-typed:

| | |
|---|---|
| `loosePlan()` | which rows are possible, and the reason CODE for each one that is not |
| `buildLooseConversion()` | what each row builds — wrapping the same `assembleSegEntries` |

The UI holds only the DOM and the sentences (a format module has no i18n, by the repo's rule). The
widget necessarily **exists twice** — a static `<section>` in the editor, a built modal in the panel,
and there is no shared UI layer to put a component in — which is exactly why the decisions had to
move out of it. `test/loose-conversions.test.mjs` asserts the parity against
`researcher-panel.js`'s own want/full table, so a change to the menu fails this suite rather than
silently diverging.

## What this tool needs that the menu does not

The menu gets its pair from a MANIFEST, so the audio provably belongs to the text. **Two file
pickers cannot.** Two checks close that gap, and both refuse a ROW, never the tool:

- `alignmentIsOrdered()` — overlapping or backward phrase offsets cannot make a valid EAF, so the
  ELAN/SayMore rows grey out with `badAlign` *before* the build rather than producing a file ELAN
  refuses to open.
- `durationVerdict()` — warns when the text is aligned past the end of the recording (Seth: *"check
  to make sure the duration matches … If not, don't worry about it"*). A **longer** recording is
  never flagged: trailing silence is normal. A lossy source cannot be measured without decoding it,
  so it reports `unknown` and says nothing rather than guessing.

⚠ The warning is prominent and **non-blocking**. The user may know something we do not, and refusing
would strand them with two files and no way to convert them — which is the exact situation this tool
exists to end.

## Deliberate behaviours worth not "fixing"

- **No audio ⇒ the ELAN package is still offered**, text-only: `serializeEaf` needs times, not
  sound. It carries a note saying the EAF has no media descriptor, because a silent one would look
  like a normal package with a broken link. (`assembleSegEntries` gates its whole annotation block
  on `media && segMedia`, so this path calls `serializeEaf` directly.)
- **An unaligned text still makes a `.fxpa`** — grouping is what that file is for.
- **A text with no phrase rows offers nothing at all.** An empty `.fxpa` that pat.flextext.app then
  refuses is worse than an honest refusal here.
- **The `.flextext` row is a byte-for-byte passthrough**, renamed to the text's title. It is never
  re-serialized — so it cannot mint a stale media reference, and it is the natural place for the
  `.flextext` PACKAGE plan (BACKLOG, "the exported .flextext writes a worker URL") to land later.
- **Lossy sources convert to WAV with the non-archival BWF `bext`, exactly as everywhere else**, and
  an undecodable one **degrades** — the package ships with the original audio and a `lossyTiming`
  note — rather than taking the build down.
- The oversize ladder is `conversionCaps`' , unchanged: only the listening page refuses on size; the
  `.fxpa` drops its audio; the EAFs ride the original.

## The bug the browser test caught, and why it needed a browser

Both copies read the WAV header off a 64 KB slice to measure the recording — and both passed a
`Uint8Array` to `readWavHeader`, which does `new DataView(buf)` and **throws** on a typed array. The
surrounding `catch` swallowed it into `durationMs = 0`, which reads as "undecodable", so the pair
check was **permanently off while looking implemented**. Every node test passed.

`test/browser/loose-exporter.playwright.mjs` drives both surfaces for real — including the panel's,
which is behind a sign-in and is reached by appending one test-only line to the served module. Run
it deliberately:

```sh
cd docs && python3 -m http.server 8765 &
node test/browser/loose-exporter.playwright.mjs
```

## v378 — Seth's follow-ups (2026-08-15)

- **Renamed.** "Make files from a .flextext" → **"Convert/Export Interlinear Texts (ELAN, SayMore,
  Listening HTML, etc…)"**, localized in both languages. The old name described the INPUT; someone
  scanning Utilities is looking for the destination format, not for what we call the source file.
  The browser test pins that the heading still names the formats.
- **Packaging is a COUNT, not a per-kind table.** Seth: *"If there's more than one file, build a ZIP
  just like our built in converter for Google Drive files already does."* `buildLooseConversion` now
  ends every branch through one `pack()` helper — more than one entry ⇒ a zip; exactly one ⇒ that
  file, under its own name. It changes no current behaviour (ELAN and SayMore always carry ≥2
  files), which is the point: nothing can hand someone a one-item zip later.
  ⚠ The preview and `.fxpa` still drop the assembler's extra entries rather than zipping them —
  both embed their audio, so a HOW-TO-OPEN and a second copy of the recording would be dead weight,
  and the Files ▾ menu hands over a bare `.html` / `.fxpa` too. Parity is the specification.
- **A missing progress string, found by making the test derive its list from the source.** The
  builder emits `embedding` while base64-ing the recording into the listening page or the `.fxpa`,
  and nothing translated it — the status line would have shown the raw key `exp.phase.embedding`.
  The i18n-parity check had matched `say('code')` and so never saw a code inside a ternary; it now
  extracts every quoted string from every `say(...)` call. The call itself was simplified to
  `say(full ? …)` so the extraction cannot over-capture a comparison operand and start reporting
  phantom missing keys — a check that cries wolf gets muted, which is worse than no check.

### Why the duration check is a warning and nothing more (Seth, 2026-08-15)

> *"The duration check is just a quick sanity check to make sure that the audio file and the flextext
> file being submitted plausibly match … really, that's mostly up to the user, but for the clumsy,
> forgetful, or dyslexic, or whatever, if they mismatch it and the total duration is obviously not
> the same, that's a quick and easy way for us to stop them from making a dumb mistake. Our files
> drop down didn't need that because it's already got files that were created together, or assigned
> together, so they definitely do match."*

So its job is **plausibility, not verification** — and that is why the tolerances are loose (1.5 s),
why a LONGER recording is never flagged at all, why an unmeasurable (lossy) file says nothing rather
than guessing, and above all why it never blocks a row. Tightening it into a gate would be a
misreading of what it is for.
