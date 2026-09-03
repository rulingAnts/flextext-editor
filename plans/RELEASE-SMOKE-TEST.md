# Manual smoke test before releasing — things automated tests cannot check

Seth asked for this one by name (2026-09-03): *"Remind me when I manually smoke test this
release that I need to make sure EAF and FLExText Exports still import into their
respective apps accurately."*

## ⚠ 1. Round-trip the two annotation exports into the real applications

Nothing in `test/` can do this. The tests check what we WRITE; only FLEx and ELAN can say
whether they can READ it. Both writers changed on 2026-09-03.

**Already done for you (2026-09-03), so this is confirmation rather than discovery:** both
exports were generated from a real corpus text (*Cerita Mama Raimon*, 1 paragraph / 14
phrases / 122 words) and validated with `xmllint` against the published schemas —

| | result |
|---|---|
| `.eaf` vs the official `EAFv3.0.xsd` | **validates** |
| `.flextext` vs SIL's XSD (from the Technical Notes) | **validates** |
| the untouched source file, as a control | **validates** (so the check is not lenient) |
| a genuinely MIXED text (*Tautua Do*, 163 paragraphs / 165 phrases) through the grouping path | **validates**, 163 paragraphs out, no duplicate guids |

Counts through the round trip: phrases 14→14, words 122→122, items 273→273, segnum 0→0.

Schema-valid is not the same as "the application opens it", which is why the list below
still stands.

- [x] **.flextext → FLEx.** Export a text, import it into the live FLEx project.
      - Does it import at all? The `<document>` element now carries a new attribute,
        `exportSource="Flextext … v566"`. It is in FLEx's own published XSD as
        `use="optional"` (Technical Notes on FLEx Text Interlinear, Ken Zook, 2026-05-04),
        so it should be ignored — but "should" is why this list exists.
      - Do the paragraph breaks land where you expect? A text whose source distinguished
        phrases from paragraphs is now REGROUPED on export instead of exploding into one
        paragraph per phrase. A uniform text is unchanged (verified byte-identical on 74 of
        95 corpus files).
      - **We no longer emit `<item type="segnum">` at all** (issue #27, closed). The spec
        makes it optional and says FLEx "calculated automatically based on paragraph and
        segment numbers", so ours was a number FLEx would overwrite, in the wrong format.
        Confirm FLEx numbers the segments itself on import and does not complain about
        their absence — 35 of 95 corpus files never had them, but none of those has been
        put through a FLEx import under observation.

- [x] **.eaf → ELAN.** Export, open in ELAN. *(Both round trips confirmed by Seth, 2026-09-03, on the v568 build.)*
      - `AUTHOR` is now `""` instead of `"FlexText Editor"` — the tool moved OUT of a field
        meant for a person. ELAN should not care; confirm it does not.
      - A new `<PROPERTY NAME="generator">` sits at the END of `<HEADER>` (the XSD sequence
        is MEDIA_DESCRIPTOR*, LINKED_FILE_DESCRIPTOR*, PROPERTY*, so the position matters).
      - Media still relinks with no dialog, i.e. RELATIVE_MEDIA_URL still works.
      - Tiers, times and text all present.

## 2. The Audio Segmenter on a REAL recording

- [ ] A text that has never been cut opens with ONE whole-file span (not an empty pane).
- [ ] ✨ guesses sensible lines on real village audio with a real noise floor.
- [ ] The dock waveform draws on FIRST open, with no reload. (This was broken engine-wide;
      it is also worth a look in the editor, where the same bug lived.)
- [ ] Leftovers: audio matched to nothing is left out, a line matched to nothing keeps its
      words, and Done is reachable without matching everything.
- [ ] A 40+ minute recording — see the memory ceiling note in
      plans/preserve-paragraph-structure.md. Expect trouble; this is the known one.

Two ninety-second checks the release audit (2026-09-03) asked for by name. Each is a bug
that was fixed the same day; each is the gesture that reproduced it.

- [ ] **Commit, then take an update.** Match a text, press Done, stay on the list, and
      force an update (Ctrl/⌘+Alt+U, or wait for one). Reopen the text: the match must still
      be there. Before the fix, persist() wrote the pre-session record back over the commit.
- [ ] **Join two text lines, press Done, reopen.** The joined line must come back as ONE
      line with its audio still attached. Before the fix, the next open re-split it and
      cleared every span with it.
- [ ] **Split a line that has a comma before the cut**, in a text with no free translation.
      The cut must land where the scissors was, and both halves must be pickable.

## 2a. Getting work OUT, and getting a recording IN

- [ ] **Audio Segmenter, unpaired: ⤓ on a list row** downloads a zip holding the `.flextext`
      (with times), the `.eaf`, and the recording. A text with an unfinished draft says so in a
      toast — the zip carries what Done committed, not the draft.
- [ ] **Consent Collector opens a recording on its own** (Seth, 2026-09-03: "either or both
      flextext and audio"): a `.m4a`/`.wav` alone becomes a text titled from the filename with no
      words; a `.flextext` alone still works; the two together pair as before. The button reads
      "Open text and/or recording…".
- [ ] **A v567 draft with joined lines** (Birds vs Snakes on the feature preview): open, pair,
      Done, reopen — the joined lines must come back as ONE line each, with the audio attached.

## 2b. The two apps are linked

- [ ] Editor → Utilities → the two links at the bottom open the Audio Segmenter and the
      Consent Collector **in a new tab**, on the SAME estate you are on (staging links
      staging). Same from the researcher panel's Utilities.
- [ ] Export an .eaf from the panel's Files ▾ menu and open it in a text editor: the HEADER
      ends with `<PROPERTY NAME="generator">Flextext Researcher v568</PROPERTY>` and
      `AUTHOR=""`. v567 would have had neither.

## 3. Version

- [x] **`./bump-version.sh v568` — done 2026-09-03.** The service worker caches by VERSION.
      Deploying changed code under an unchanged number means every device that has already
      opened the app keeps the old files — demonstrated accidentally on 2026-09-03, when a
      staging deploy kept serving stale code until the SW was unregistered by hand.
