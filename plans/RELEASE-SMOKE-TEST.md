# Manual smoke test before releasing — things automated tests cannot check

Seth asked for this one by name (2026-09-03): *"Remind me when I manually smoke test this
release that I need to make sure EAF and FLExText Exports still import into their
respective apps accurately."*

## How touch lines are marked (Seth, 2026-09-06, "for now")

Seth's only Android test device is MDM-locked to the production Editor WebAPK, so staging
can be smoke-tested on the desktop app and in the browser's responsive mode, and with the
trackpad where a gesture has a trackpad twin (a two-finger trackpad pinch is the same wheel
event as a touch pinch; a two-finger trackpad swipe is the same as a two-finger touch drag).
Anything that needs a real finger and has no trackpad twin is marked **[real device]** below:
it is checked on production after the release, not before, and the code behind it is kept
additive and fail-safe (a throw or a missing capability leaves today's behaviour in place).

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

## Backlog fixes (v580, issues #31 #33 #36)

- [ ] Paired device, auto-backup on: edit a text, wait for the quiet-time backup, then tap Done — send ▸ Upload. Expect "already saved", the text marked done on the device AND in the panel, and a return to the list.
- [ ] Assigned text with locked audio: Share / Save on the device and ⤓ on the segmenter both yield a zip containing the recording.
- [ ] Panel Files ▾ ELAN zip on a text whose original is m4a: the zip holds the converted WAV and the original m4a.
- [ ] A 10–15 minute recording on the Cut tab: strips draw all the way down as you scroll; none stay blank.

## Matcher waveforms (v581, regression from v580)

- [ ] Audio Segmenter: open a text with a recording. Every audio row on the left shows a waveform, not an empty box.
- [ ] Scroll the matcher list to the bottom: the lower rows draw as they arrive.
- [ ] Split an audio piece (scissors): the rebuilt list still shows waveforms.
- [ ] Editor Baseline, Cut and Gloss tabs: strips still draw, as in v580.

## Several analysis languages (v585)

- [ ] Utilities ▸ convert a FLExText that carries Indonesian and English glosses: the listening page shows "Gloss language" and "Translation language" pickers; switching shows the other language's lines; a one-language text shows no pickers.
- [ ] The same text's ELAN zip opened in ELAN: A_word-gls-id, A_word-gls-en, A_phrase-gls-id, A_phrase-gls-en, in that order under their word and phrase tiers.
- [ ] SayMore zip: Transcription and Free Translation only, the free translation in the device's language.

## Text size and typing (v586)

- [ ] Settings ▸ Other ▸ Text size Large: the top player's buttons stay the same size, its waveform gets shorter, the strips and text get bigger. Normal restores everything.
- [ ] Space setting off (or a tablet): play a line with its ▶, then type with no box selected: the text lands at the end of that line's box. On the Gloss tab it lands in the first empty gloss of that line.
- [ ] Cursor in the middle of a line's box: Shift+Space plays that line and the cursor does not move; Shift+Space again pauses. Same with the Space setting on.

## Header (v587)

- [ ] Text size Large: the top row (tabs, Save, Done — send, back, help) does not grow; everything below it does.
- [ ] Save shows a disk, Done — send a green check and a send arrow, the tabs a waveform / typing mark / interlinear rows, each with its label. In Indonesian too, the row stays on one line on a laptop and on the tablet.
- [ ] Tablet, Cut or Baseline tab with many strips: a finger dragged up or down anywhere on the strips scrolls, even at a slant. A tap on a strip places the playhead line. Touching anywhere on that line and dragging scrubs that line. The same three on the listening page.

## Top-row labels and the small-screen player (v589)

- [ ] Settings ▸ Other ▸ "Top-row buttons and tabs": Icons only hides the words on Cut / Baseline / Gloss / Save / Done; Words only hides the icons; Icons and words shows both; Automatic shows icons only when the window is narrower than 1000 px and both above. Same field in the researcher panel, pushed to a device.
- [ ] Phone: the top player's waveform is visibly shorter than on a laptop (44 px vs 72 px); tablet 56 px. Rotate the phone: it follows.


## Gloss tab icon, Cut-tab chord, mobile Space (v590)

- [ ] Researcher panel, a device's settings → Other: "Gloss tab icon" shows seven picture tiles with
      the current one highlighted; tapping another highlights it; Save pushes it and the device's
      Gloss tab shows that picture without a reload. The Settings tab of an unpaired editor shows the
      same tiles and changes the tab at once.
- [ ] A device that has never had the setting reports "Interlinear rows" (the default, written into
      its own settings at first boot); the dashboard shows "Gloss tab icon on devices: … ×N" once at
      least one editor device has reported.
- [ ] Cut tab: Shift+Space from the page and from inside the title box plays, then pauses, once per
      press; plain Space in the title box types a space.
- [ ] Space setting "Automatic": on a laptop, touch screen or not, Space plays; in the browser's
      Android emulation (or on the phone, [real device]) Space types.

## Adjustable boundaries (v591)

- [ ] Cut tab, mouse: a blue grip sits at each end of every line's waveform (none at the recording's
      start and end). Dragging a grip moves the boundary and redraws both neighbours as you drag; it
      stops at the neighbour and never passes it. Release: the rows rebuild, Ctrl+Z undoes the whole
      drag in one step, the ✨ button disappears after a manual move.
- [ ] Cut tab, top player: the cut marks carry a small pill; dragging one moves the same boundary
      (the strips follow live). On the Baseline and Gloss tabs the top player's marks are gone and
      nothing there is draggable.
- [ ] Baseline and Gloss tabs: the same grips on the strips; dragging keeps the cursor in the text
      box and the words unchanged; the moved line plays from its new start.
- [ ] A line that already has text keeps its grips with "cut or join lines that already have text"
      OFF. Switching "Allow moving line boundaries by dragging" off (panel push or Settings tab)
      removes every grip and the top-player pills at once, without a reload; the Cut hint drops its
      drag sentence.
- [ ] [real device] On a phone: a grip is a 32 px zone; dragging it moves the boundary and does not
      scroll; dragging the waveform beside it still scrolls the page.
