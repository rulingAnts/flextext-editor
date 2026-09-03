# Manual smoke test before releasing — things automated tests cannot check

Seth asked for this one by name (2026-09-03): *"Remind me when I manually smoke test this
release that I need to make sure EAF and FLExText Exports still import into their
respective apps accurately."*

## ⚠ 1. Round-trip the two annotation exports into the real applications

Nothing in `test/` can do this. The tests check what we WRITE; only FLEx and ELAN can say
whether they can READ it. Both writers changed on 2026-09-03.

- [ ] **.flextext → FLEx.** Export a text, import it into the live FLEx project.
      - Does it import at all? The `<document>` element now carries a new attribute,
        `exportSource="Flextext … v566"`. It is in FLEx's own published XSD as
        `use="optional"` (Technical Notes on FLEx Text Interlinear, Ken Zook, 2026-05-04),
        so it should be ignored — but "should" is why this list exists.
      - Do the paragraph breaks land where you expect? A text whose source distinguished
        phrases from paragraphs is now REGROUPED on export instead of exploding into one
        paragraph per phrase. A uniform text is unchanged (verified byte-identical on 74 of
        95 corpus files).
      - Are the segment numbers what FLEx expects? See issue #27 — we emit a plain running
        integer, FLEx computes `par.phr`. Unresolved, low priority, but this is the moment
        you would notice it mattering.

- [ ] **.eaf → ELAN.** Export, open in ELAN.
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

## 3. Version

- [ ] **`./bump-version.sh vNNN` BEFORE deploying.** The service worker caches by VERSION.
      Deploying changed code under an unchanged number means every device that has already
      opened the app keeps the old files — demonstrated accidentally on 2026-09-03, when a
      staging deploy kept serving stale code until the SW was unregistered by hand.
