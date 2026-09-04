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
- [ ] **A v567 draft with joined lines** (Birds vs Snakes on the feature preview): open — the 149
      cuts and 136 lines come back as rows, paired by number — Done, reopen: the joined lines
      must come back as ONE line each, with the audio attached, and 13 blank lines at the end.
- [ ] **Pairing is the row number** (Seth, 2026-09-03). One list, audio left beside text right.
      ✨ Guess, then split/join on either side and watch the numbers and colours follow; `+` adds
      a blank line on the text side only; Done with more audio than lines adds blank lines at the
      end; Done with more lines than audio leaves the last lines without audio and says so.
- [ ] **Interrupt a load, then reopen.** Open a text and press ← Back while the note still says
      "Preparing…"; open the same text again. The big player must show its waveform and every strip
      must draw — no refresh. (Seth, 2026-09-04: "there definitely are times when the big player
      and/or the segments don't load … Refreshing and exiting and opening the text again fixes
      that. But that shouldn't be necessary.")
- [ ] **✂ on the big player** cuts the piece under the playhead, where the playhead is; Enter does
      the same when no field or button has focus; with the playhead at 0 or between pieces it says
      so instead of cutting nothing.
- [ ] **⤓ offers three downloads** — everything (zip), ELAN only (.eaf), .flextext only — and a
      six-minute WAV no longer fails with "allocation size overflow" in Firefox.

## 2c. The segmenter as a THIRD invite kind (needs a researcher account — staging or the rig)

No worker change: the segmenter pairs as its own device on its own origin; the invite modal
prints the same one-time secret on a third base URL; the app reports itself as `segmenter`.

- [ ] Panel → New device "Rig segmenter" → Settings (vern/anal, send = upload) → **Invite link**:
      three rows now; copy the **Segmenter link**.
- [ ] Open it on a fresh profile: consent modal + pair code → panel **Approve** → device toasts
      "linked"; the panel's device badge reads **segmenter**.
- [ ] Assign a `.flextext` **and** its recording → the segmenter list shows the row
      "· from your researcher" with a **progress bar, "{pct}% — got of size MB · about N left"**,
      and a Pause on the row; pause → Resume; go offline mid-download → after ~20 s the bar
      turns amber and says "No data for N s" with Retry; back online it continues from where it
      was. Then audio arrives, Open enables.
- [ ] **A withdrawn link** (revoke the device's install in the panel, or re-link it, then open an
      assignment minted before that): the row says the link was withdrawn and offers no Retry;
      assigning the text again from the panel makes it download. No 26 retries in the console.
- [ ] Match, **Done** → the upload bar drains → the row reads "· sent to your researcher" → the
      panel tile shows uploaded, and Files ▾ offers the ELAN zip and the `.eaf` (built on demand
      from the uploaded `.flextext` + the audio the researcher already has).
- [ ] Push a settings change from the panel → the list repaints, no console error.
- [ ] Unpaired device: the list carries **Link to a researcher…** (paste box) beside Open, and ⤓
      still works as the way out.

## 2d. Settings and editing in the segmenter (Seth, 2026-09-04)

- [ ] **Unpaired: a Settings tab** beside Texts, with only Languages (codes), Segmentation (the
      timing-note switch + the four export formats — no segmentation switch: always on here) and
      Other (delete / blank lines / edit in place, greyed with the standalone note). Hide it with
      the button; Ctrl+Alt+R brings it back. Pair the device: the tab disappears.
- [ ] **Timing as notes**: untick it, export a `.flextext` — the begin/end attributes are there,
      the `audio 0:01.000–…` note items are not. Re-tick, both are back. Same switch in the panel's
      Segmentation section for a managed device.
- [ ] **Edit in place** (on by default unpaired; the researcher's `allowTextEdit` when paired):
      tap a word → type → Enter or tap away; Escape restores. Space at the END of a word adds an
      empty pair after it with the caret in it; at the START, before it. Backspace in an empty
      word removes the pair. Tap the free translation to edit it. Every step undoes.
- [ ] **The dock loads every time**: Back during the decode, then reopen; a text whose decode
      failed once; reopening the same text — no more refresh-to-fix.

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

## Tablet / Android (v579, issues #42–#45)

- [ ] Editor on an Android tablet: with the keyboard open on the Gloss tab, the player stays visible above it (the page shrinks; nothing is hidden behind the bottom bar).
- [ ] Cut tab, forty strips: an up-down finger drag over the strips scrolls the page; a sideways drag on one strip scrubs it; a tap parks the playhead and pauses.
- [ ] Gloss tab, tablet: typing a space in a word box types a space (audio does not start). Shift+Space plays and pauses from inside the box. Enter in a translation box moves to the next line's translation.
- [ ] Settings ▸ Other: "Text size" Larger makes everything bigger at once; Normal restores it. Pushing the same setting from the panel lands on the device without a reload.
- [ ] Desktop regression: plain Space still plays / pauses outside a text box; the Cut tab's Space is unchanged.
