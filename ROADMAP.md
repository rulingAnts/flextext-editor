# Roadmap and future directions

What is in progress, what is planned, and how each planned thing is meant to work. This is the
public technical companion to `README.md` (what the suite is) and `DEVELOPERS.md` (how it is
built). Nothing here is a promise of dates; the order is the order the maintainer intends to work
in, and every item names the document or issue that holds the full design.

Status words used below:

| word | meaning |
|---|---|
| **on staging** | built, tested by automation, waiting for the maintainer's manual smoke test and a production release |
| **in progress** | being built now |
| **designed** | a written plan exists; not started |
| **idea** | recorded so it is not lost; no design yet |

Last updated 2026-09-07 at v602. The production estate is at v602.

---

## 0. Released 2026-09-10 (v653 to v664)

**Typing safety — the release's reason for existing.** Autocorrect on a minority language is data
corruption, not an annoyance: the rewrite is silent, in a language the typist may not read, and the
wrong word is what gets archived. `docs/js/typing.js` is now the one chokepoint for what a keyboard
may do to a field, engine-wide across all seven apps.

- **Vernacular is silent everywhere** — baseline text, baseline words, segmenter rows, the mini-gloss
  word, PAT's paste box and consent names. Carried by four inherited attributes on each app's
  `<body>`, so it is in force from parse time before any script runs.
- **Three analysis-language dials** (spell-check / word suggestions / autocorrect), each on/off/auto,
  **all off by default** — Seth: *"it's not so much that we definitely want spell-checking as we don't
  want it when we don't want it."* Grouped under one sub-heading, each with a tap-reachable ⓘ.
- **The Android coupling is visible**: switching one dial on shows a glowing ⚠ triangle on the other
  two, since Android has a single keyboard setting behind all three. Choosing `auto` warns that it
  depends on the device having the dictionary — which no web page can install or even query.
- **#66** the device text list no longer traps trackpad scrolling · **#43 (partial)** the Android
  keyboard guard now runs in all seven apps, having never run in PAT or the crowd recorder ·
  **#70** a move no longer leaves a ghost on the source device waiting for a target that may be off
  for a week.

⚠ **Confirmed on real hardware:** Android/Gboard **ignores** the page's request to stop suggesting
words, while **not** autocorrecting. The destructive half is gone; the suggestion strip is not, and
no web-level lever remains — see #62, and #72 for the provisioning step that does work.

**lameta session export** (#71) — `docs/js/lameta.js` writes a session folder a researcher drops
straight into a lameta project. Format read from real files, not inferred; see
`plans/lameta-session-export.md`.

## 0b. Released 2026-09-10 (v665 to v668)

- **lameta session export, wired (v665).** The Researcher panel's export menu now offers it
  alongside SayMore and ELAN. The package carries the original recording, a converted
  `.annotations.wav` when the original is not WAV, complete ELAN `.eaf` + `.pfsx` (lameta has no
  built-in annotation editor — it opens ELAN), a `.flextext` serialized at export time from the same
  state the EAF comes from, the suite's history JSON, and a `.meta` sidecar per file. Verified by
  opening a produced folder in lameta 3.0.21-beta: the `.flextext` types as "FLEx", `fau` resolves
  to Fayu and `id` to Indonesian, and the sidecars are absorbed.
- **Full-line boxes wrap and grow (v666, fixed v667).** The baseline box in audio-segmentation mode
  and the free translation on the Gloss tab wrap onto as many lines as they need instead of scrolling
  sideways — on a phone the typist could not see the sentence being written. Line breaks are blocked
  inside them (one box is one line, from typing or from a paste); the plain box used when audio
  segmentation is *off* is untouched, where Enter still starts a paragraph. ⚠ The one-line floor is
  **CSS `min-height`, not script**, because the requirement is that an empty box is one line tall
  before anything has run; `field-sizing: content` does the growing natively where it exists (Chrome)
  and the JS path carries Firefox, which has no `field-sizing` yet.
- **Space becomes a period in glosses on Android (v667).** The fix now watches the field's value
  rather than the key, since an on-screen keyboard commits through the IME and never reports the
  space — so it also covers the suggestion strip, dictation and pasting. It tidies once more on blur,
  where the keyboard's own autocorrect cannot fight it.

**#43 is closed** (v668) — the Android keyboard no longer buries the box you tap, and nothing else
moves when it is revealed. Confirmed on real hardware. ⚠ The bug was ONE LINE, wrong twice the same
way: `overlays-content` resizes neither viewport, so a check that only subtracted the keyboard "if
there is no visualViewport" never subtracted it at all. v615 fixed exactly that mistake in
`coveredPx` and left `visibleBottom` holding it — which is why the bottom furniture rode above the
keyboard while the focused box stayed buried. The arithmetic now lives in two pure exported
functions (`visibleBandBottom`, `revealScrollBy`) tested across all three viewport modes with no
DOM, because both earlier failures were logic errors invisible to a suite that reads source as text.

## 0c. On staging, awaiting a production push (v669 to v672)

**One space between words (v669).** Seth: *"prevent them from typing multiple spaces in the baseline
or free translation… to help less tech-savvy/illiterate users."* Extra spaces go as they are typed
and the edges are tidied on blur, on the baseline and the free translation only — a word gloss keeps
its own rule, where a space becomes a period. The plain baseline box used when segmentation is off
also caps a gap at one blank line.

- ⚠ **DEFAULT DEPENDS ON PAIRING** — on for a paired device, off for an unpaired one. Seth's reason:
  a paired device is a field worker's, configured by a researcher who wants the guard; an unpaired
  device is the researcher's own, and rewriting their input is not a favor. One key, two defaults,
  and both surfaces' forms had to be told separately so neither misreports the device.
- ⚠⚠ **A TEXT WITH RECORDING TIMES NEVER HAS ITS BLANK LINES CAPPED.** There a blank baseline line is
  a timed span of silence, 1:1 with `doc.segments`; capping them is the 2026-08-16 corruption that
  turned 53 lines into 30 and ended a recording half a minute early. The cap is gated on **doc
  truth**, never on the setting, and `docCarriesTime()` is now the single definition of alignment
  shared with `applyBaseline` — two notions drifting apart is how that bug returns.
**Repeated punctuation too (v670).** Seth: *"Two dashes allowed, three periods OK, but not two. Two
commas definitely not OK. And in glosses only one period at a time allowed, no doubles, no
tripples."*

- ⚠⚠ **An ellipsis would have been untypeable** if the period rule ran on every keystroke: a 2→1
  rule eats the second dot, the third makes two again, eaten again. So periods are left alone while
  typing in a full-line box and settled on blur (two → one, three or more → exactly three). A gloss
  takes no ellipsis exemption — a period there separates parts of one label.
- ⚠⚠⚠ **Never the characters an orthography is built from.** `WORD_CHAR` counts the apostrophe
  family, `ʔ`, and `-` `_` `=` as word characters — glottal stops and morpheme boundaries. Only
  characters the tokenizer already treats as punctuation are collapsed, which is why "two dashes
  allowed" needed no special case.
- ⚠ And it never touches a key event — every path is `input` or `blur`, reading the value, because
  an Android IME commits with `keyCode 229` and no usable `key`. A test walks every listener that
  calls into the feature and fails if any is a `keydown`.

**The gloss word-break character is a setting (v671).** A space typed in a gloss becomes a
separator; a researcher now chooses which — period (default), underscore or hyphen. A space is not
offered, since a gloss containing one would make the word count disagree with the baseline. ⚠ A
hyphen or underscore is collapsed **only when it has been declared the separator** — otherwise it
may be marking a morpheme boundary, and is left alone.

**A gloss does not end in punctuation, and the keyboard's period is undone (v672).**

- Typing a space at the end of a gloss left a separator with nothing after it (`PST.`), tidied on
  blur. ⚠ A trailing **hyphen or equals sign is kept** — in Leipzig glossing those mark what the
  morpheme *is* (`PST-` a prefix, `CLT=` a proclitic, as `-PST` is a suffix), so stripping one would
  delete real analysis a character at a time. Blur only, because on input it would make a separator
  untypeable.
- ⚠⚠ **The stray period was the keyboard's, not ours.** Seth: *"If I type space three times in the
  free translation it puts a period before the last word. That looks like a failure of order of
  operations…"* The order was fine — our rules alone turn three spaces into one and insert nothing.
  Gboard (and iOS, and macOS) replaces a second space with `". "`, and our space collapse then tidied
  the leftover gap, which made the stray period look deliberate. The substitution has an exact
  signature — the previous value ended in a space, the new one is that text with the final space
  replaced by `". "` — and nothing a person can type produces it, so it is safe to undo. A period
  typed by hand is untouched. Needs the field's previous value, kept per element.

**The rules are now one table (v672).** Seth: *"There might be a way to simplify and combine some of
these rules..."* There are only ever two kinds of field (line, gloss) and two moments (input, blur),
and every rule is a cell in that grid — `tidyField` is the single entry point, and reading the table
is reading the policy. The primitives behind it are internal, and the tests go through the real path
rather than the internals. ⚠ `capBlankLines` stays deliberately **outside** the table, because its
safety depends on the *document*, not the field or the moment.

- Fixed in passing: the three typing dials were **missing from the settings snapshot** the panel
  prefills from, so the panel could push them but never read back what a device actually held.

**Known, deferred:**

- **#73** — no split ✂ appears at a word gap containing punctuation, because the scissors are hung
  off the chain-link button and `canMerge` (rightly) refuses to chain a word to a comma. The
  keyboard route still splits there; only the click target is missing.
- **#74** — Enter/Backspace handlers assume a physical key. Scoped by Seth to keys Gboard actually
  has (Enter in its Go/Next/Done/newline guises, and Backspace); Tab and Shift+Space are out of
  scope because Gboard has neither. ⚠ NOT YET REPRODUCED — space needed value-watching because it is
  a text-producing key committed through the IME, but Enter and Backspace are control keys that
  Chromium does dispatch, so the issue leads with a device test rather than a patch. Two things are
  certain regardless: `enterkeyhint` is set nowhere, so Gboard guesses the label and a key reading
  **Next** performs a line split; and v666's textarea conversion means Gboard now offers a newline
  key on the two prose boxes where we `preventDefault()` it, so it looks live and does nothing.
- **#62 / #72** — Gboard ignores the page's request to stop suggesting words; the mitigation is the
  on-device toggle during provisioning.

## 1. Recently released (v585 to v602)

All seven sites and the GitHub Pages editor are at v602 in production; staging matches. Human checks are listed per release in
`plans/RELEASE-SMOKE-TEST.md`.

- **Several analysis languages (v585).** The listening page gets a picker for the gloss language
  and one for the free-translation language when a text carries more than one; ELAN export writes
  one gloss tier and one free-translation tier per language.
- **Text size and typing (v586).** A researcher-set text size for the whole app, with the top
  player shrinking in proportion; when the Space bar is not the transport, a keystroke goes to the
  line last played; Shift+Space plays a text box's own line without moving the cursor.
- **Header row (v587, v589).** Icons on Save, Done and the three tabs; the header exempt from the
  text-size zoom; a setting for automatic, icons and words, icons only, or words only, where
  automatic means icons only when the window is narrower than 1000 px.
- **Touch model (v587, v588).** A tap parks the playhead, a drag on the playhead line scrubs, and
  every other finger movement scrolls the page, on every waveform strip and on the listening page.
  The small-screen player tiers (56 px on a tablet, 44 px on a phone) work again.
- **Gloss tab icon, Cut-tab chord, mobile Space (v590).** The researcher chooses one of seven
  pictures for the Gloss tab from a picker that shows them; each device keeps its own choice and the
  dashboard counts which is in use. Shift+Space plays and pauses on the Cut tab too. The Space
  setting's automatic mode is off on mobile devices, not on every touch screen.
- **Adjustable boundaries (v591).** A grip at each end of a line's waveform on the Cut, Baseline and
  Gloss tabs moves the boundary, never past a neighbour, one undo per drag; a new device setting
  removes every grip at once, independent of the texted-lines switch.
- **Top player gestures (v592).** Thin cut marks on all three tabs that follow a dragged grip while
  the player zooms in on the seam; tap to place, drag to scroll when zoomed, playhead line to scrub,
  pinch (or trackpad pinch) to zoom, on the editor and on the exported listening page. The editor
  never makes the top player's marks draggable; the segmenter's matcher keeps its own.
- **One splitting rule (v593 to v597).** A more basic tab cannot split or join a line with more
  advanced data; a split needs one position per part the line has, placed in any order, and writes
  nothing until all are placed. A scissors hangs under the blinking text cursor wherever Enter would
  split and follows it; a round ✕ cancels; the join button between lines is the chain link. Words
  on the Gloss tab are editable in place. Each piece of a split is its own phrase in the FLExText.
  The Paragraph Analysis Tool goes through the same planner.
- **The tool splits and joins; edge trims; scrub close-up (v598).** The Paragraph
  Analysis Tool has the full rule: a ✂ between two words, under the text cursor in a line or its
  translation, and under the row's playhead; a 🔗 joins with the next line and absorbs any blank
  audio between the two so the joined line spans the whole recording area. On the Gloss tab and in
  the tool a timed line also carries a ✂ before its first word and after its last, to trim the
  silence at that end into a line of its own. Scrubbing a line's waveform opens the same momentary
  close-up on the top player that dragging a boundary does, on the editor and the listening page.
- **The dragged boundary's mark (v600).** While a grip is dragged, the top player's mark
  for that seam is a 2px dashed blue line, distinct from the red playhead.
- **The tool's Join/split switch (v601).** The scissors and chain links in the Paragraph
  Analysis Tool are behind a toolbar switch, off by default and remembered per device; off, a line
  shows a plain playhead. Undo/Redo (buttons, Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y) cover splits and joins.
- **Toolbox / SFM converter (v610, #29).** A standard-format interlinear file becomes .flextext,
  from the Utilities tab in the editor and the segmenter, Utilities in the panel, and the tool's File
  menu — one modal, four doors. The reader was already there (`sfm.js`, which the Paragraph Analysis
  Tool imports with); this is the surface over it, so the two importers can never disagree about
  what a file means. Where one text ends and the next begins follows FLEx's own rules: an explicit
  "starts a new text" marker (FLEx's *New Text* destination, which `sfm.js` has always supported and
  nothing exposed), with the header-after-body fallback, and the count of texts shown live because
  FLEx's own documentation warns the split only works with consistent markers. Saves one text, or
  every text as a zip.
- **v617: each app wears its own colour, and its own mark.** Seth, with the Consent Collector and the
  Audio Segmenter installed as apps: "let's make sure our top heading bars match the title bar theme
  color." The shared header was hard-coded blue while each shell declares its own theme-color, so a
  violet or amber window chrome sat directly above a blue bar. `#topbar` now paints with `--topbar`,
  set beside each shell's meta tag, and topbar-theme.test.mjs asserts meta, manifest and CSS agree —
  and that white still reads on the bar and the selected tab's label still reads on white (the crowd
  recorder's green needed a darker ink at 4.08:1). The researcher panel had carried this fix alone
  since 2026-08-28; it is now general. The Paragraph Analysis Tool and the Researcher Panel also got
  real icons — a pilcrow over a square right-branching SSA spine, and a disc stack — replacing the
  editor's interlinear-rows mark recoloured, which differed by hue alone.
- **Distant future: real audio editing / splicing** (https://github.com/rulingAnts/flextext-editor/issues/57). Today the suite describes audio and never
  alters a sample. ⚠ The constraint that shapes it: "Preservation masters are never processed", so an
  edit must produce a DERIVATIVE with the master kept byte-identical — which points at an edit list
  rather than a destructive edit. It would also break the assumption that segment times index one
  continuous recording, and it raises a consent question nobody has a field for: a speaker consented
  to a recording, not to a version with their words removed or reordered.
- **v616: the review pass.** A structured review of v603..v615, with each finding checked by running
  the code rather than reading it, found 21 defects the release's own tests had missed — several
  introduced by the v614/v615 embedding rewrite. Fixed: the tool's autosave split could lose a
  recording on upgrade or across two tabs, and swallowed the user's own "hide the audio tier" choice;
  the #55 cancel cleanup covered only the tray route, not the queue card a researcher actually uses on
  a paused transfer; pause/cancel was read once and then ignored through ~62s of back-off on a dead
  link; a resumed upload left a phantom paused row forever; a cancelled Download-all and a refused
  conversion both ended with "done — check your downloads"; the Toolbox converter emitted 387 empty
  guids per story where FLEx honours an incoming one, let one marker hold two roles (silently
  dropping the loser), and only warned about column damage when it was TOTAL — a partial Word-paste
  mangle left 86% of words glossed and 45% of them wrong, with no warning; the segmenter refused an
  oversized .fxpa instead of degrading as conversionCaps documents; a single-file export still built
  and threw away a full zip (100 MB WAV: RSS 1078 MB → 627 MB); a 0-byte recording produced a
  listening page with a dead player. And the v609 Android keyboard guard was inert — it measured
  visualViewport, which `interactive-widget=overlays-content` is DEFINED not to shrink — so it now
  reads the Virtual Keyboard API with visualViewport kept as the iOS fallback.
- **v616: slow work says so.** Seth: "we genuinely don't want a UI response time that looks like
  something is jammed or broken … it only takes about a half second for that to feel like the case."
  The share menu, the tool's save and its export put a spinner up before the encode starts (two frames
  early, because appending an element does not paint it), and both generated pages show a moving
  "loading the sound" band until their waveform is ready. The share bundle was also encoding the
  recording TWICE — v614 dropped v602's encode-once memo — which is what made "Done — send" slow.
- **v616: a split with waveforms off could never finish.** The ✂ that places a split's audio tier
  rides the waveform lane; with waveforms off that lane did not exist, so a split stayed pending with
  no way forward. A thin playhead lane now stands in, only while the join/split switch is on.
- **v615: the v614 listening page had no waveforms** — the chunked decode left the waveform decoder with
  the last chunk only; the page now assembles one array for both the player and the decoder.
- **The recording is never one string (v614).** Seth hit "Could not build the download: allocation
  size overflow" exporting a .fxpa from the Audio Segmenter and "Download failed" building a listening
  page in the panel — one shared engine path. Measured in headless Firefox 155 on the rig: Firefox
  refuses to JSON.stringify a string past ~179M characters (~134 MB of audio), under the 200 MB size
  gate; V8 quietly yields nothing past its 536.9M-character cap. The engine now assembles both files
  around the recording as Blob chunks (seg-exports.js `fxpaBlob` / `previewBlob`, on `spliceB64` +
  `b64PartsOf`), byte-identical to before, and the listening page decodes chunk by chunk. The tool's
  save, export and autosave use the same primitives (autosave keeps the recording in its own record).
  The Audio Segmenter gained a listening-page download; dropping ELAN's .pfsx sidecar on the tool now
  says what it is. Verified at 150/200/300 MB in Firefox and Chromium.
- **A cancelled upload cleans up after itself (v613, #55).** Seth: "deleting the half-made text is
  the right decision here." The manifest is written before the first source byte, so a cancel used
  to leave a text in the estate with no recording and no way to resume it. Cancel now trashes the
  text folder when that run created it, or just the files that run uploaded when the text already
  existed — Drive trash, recoverable for 30 days.
- **Transfer controls, proven on a real account (v612).** Pause, resume and cancel were run against
  a researcher account on staging with a 19 MB upload: paused at 12%, settled at 35% after its chunk
  landed, survived a reload, resumed at 35% rather than zero, and a cancel read as cancelled. Two
  things it turned up: the Assignment uploads card showed a bare "?" for a project upload's
  destination (fixed here), and a cancel leaves the half-made text in Drive (#55, Seth's call).
- **The Toolbox reader, corrected by real files (v611).** Seth's samples exposed three faults no
  invented fixture had: a title marker occurring ONCE (`\id`, naming the file) beat one occurring
  per story (`\t`), so eleven narratives arrived as a single 407-line text; `\te` (a title
  translation) took the free-translation role from `\fte`; and the new-text marker's value replaced
  the real titles with record numbers, which FLEx's own rule forbids. Detection now prefers a title
  marker that recurs, drops it when it collides with the baseline, and treats the new-text value as
  a fallback only. Both files, and the same corpus copied out of Word, now convert untouched.
- **Next: the segmenter opens a .fxpa (#54).** The outbound leg shipped in v609 and blank audio
  survives the format (measured: four segments in, four lines out, silences keeping their times).
  What is missing is the return leg — the segmenter accepts `.flextext`/`.xml`/`.txt` only, and no
  `.fxpa` → editor-doc reader exists. ⚠ Every line must come back as a segment, blank ones included:
  the segmenter's job is the audio map, and the tool's `hideBlank` is a view setting that must not
  leak into the conversion (Seth, 2026-09-07).
- **Next: one converter for every interlinear source (#53).** The v610 converter reads Toolbox/SFM;
  ELAN `.eaf` joins it as a second source behind the same surface, and only then does the title
  become "Convert other interlinear to .flextext (Toolbox, ELAN, etc)" — naming a format it cannot
  yet read would promise what it refuses to do. `eaf-read.js` already parses ELAN and has a tier
  wizard in the tool, so this is a second source, not a second converter (Seth, 2026-09-07).
- **The Android keyboard covers instead of shoving (v609, #43).** The shells ask for
  `interactive-widget=overlays-content`, so nothing reflows when the suggestion strip or the
  keyboard opens. v579 had set `resizes-content` deliberately, for the first half of the same issue,
  and it was buying two things: a focused box never behind the keyboard, and the bottom-fixed
  furniture above it. Both are kept — a visual-viewport guard reveals the focused box, and the
  covered height is published as `--kb-inset`, which the toast, upload tray, activity tray, update
  banner and version badge add to their offset.
- **The segmenter exports .fxpa (v609).** A matched text goes straight into the Paragraph Analysis
  Tool, recording included.
- **The close-up drew nothing on a real recording (v608).** It zoomed by stretching the waveform
  element, which on an eight-minute file asks for a canvas ~150,000 device pixels wide — past every
  browser's maximum, where a canvas draws nothing at all. It now redraws a bounded window (three
  screens, the middle one visible) at the canvas's natural size, which costs the same at any length.
  The pinch zoom on the listening page was capped for the same reason. A short fixture could never
  have caught this; the smoke test now says to use a long recording.
- **Hairline waveforms in the tool (v607).** Each line's waveform is a hairline that thickens where
  the speech is, not a full waveform per row: the close-up on the top player is where a boundary is
  actually placed. The drag grips keep a full-size hit area (`ctx.minH`). The tool's exported page
  never had per-line waveforms, so it needed no change.
- **The close-up holds the lines still (v604).** The tool's player and the listening page's grow for a
  close-up without moving a line: the same height comes off the player's bottom margin, so the rows
  stay where the finger found them, and the pointer is captured so the drag survives. A seek during
  load can no longer throw. The listening page's mouse click pauses playback, as the editor's does.
- **The tool's grips and close-up (v602).** The editor's segment grips on the tool's rows
  (with the switch on), the overview showing the seams, and a close-up that zooms in, grows taller
  and marks the dragged seam blue while a grip is dragged or a line's waveform is scrubbed.

## 2. In progress

### 2.1 The listening page keeps up with the editor

The exported listening page (`.preview.html`) has the strips' tap, playhead-line and pan-to-scroll
model, since v592 the overview's tap, drag-to-scroll, pinch and trackpad-pinch grammar, and since
v598/v603 the scrub close-up: dragging the playhead across a line's waveform zooms the overview in
around it and grows it taller until the drag ends. Each new touch or mobile behaviour added to the
editor is added to the exported page in the same release, because the page is what a speaker
without the app gets. The page stays read-only — it gains the zooming and scrolling, never the
boundary adjustment (Seth, 2026-09-07).

### 2.2 Transfer controls in the In-progress tray (#21, #38) — next release

Seth, 2026-09-07: "Our 'In progress' indicator on researcher panel will need pause/resume/restart/
cancel support in our next release." Village bandwidth is the reason (#21, long-standing): a large
transfer that cannot be paused or resumed restarts from zero when the link drops, and on a slow link
that can mean it never completes.

What exists today: the tray (`jobStart` / `jobSet` / `jobEnd` in `researcher-panel.js`) holds
display-only rows — a label, a message, a direction arrow, done — with no handle on the transfer
behind them. Assignment uploads already run on the chunked resumable loop (`runChunkedUpload` in
`upload.js`), which exposes exactly the hooks needed: `shouldStop()` for a pause or a cancel between
chunks, `streamId` plus `onSession` for a mid-file resume across drops and restarts. The queue card
already offers cancel-before-start and retry-after-failure; what is missing is control of a
transfer that is *running*.

Design, per row in the tray, four verbs:

- **Pause** — sets the job's stop flag; the upload loop exits between chunks with `stopped`; the
  queue record persists `paused` and the session id, so the pause survives a reload.
- **Resume** — re-enters the loop with the persisted session id; Drive reports its byte count and
  the upload continues mid-file. Small single-POST uploads restart, since they are small.
- **Restart** — cancel, then re-queue from zero with a fresh session (for a transfer that has gone
  wrong in a way resume cannot repair).
- **Cancel** — abort the in-flight request, delete the queue record, drop the row.

Downloads (Drive to the panel) get Cancel through an `AbortController` at once; Pause/Resume for
downloads needs a `Range` read of the Drive file and is to be confirmed against the read path.

Also in the same change (#38): the tray stays collapsible and gains a movable position, and the
assignment-queue card keeps only rows that need a hand. Each verb is a button on the row with a
title; the state word on the row ("paused", "resuming…") replaces the spinner while it applies.

### 2.3 Contact page (#50)

`https://flextext.app/contact`: a form protected by Cloudflare Turnstile that emails the
maintainer through Resend from a small Worker, so the licence and README can point at a contact
without publishing a mailbox. Until it exists the link in `LICENSE` and `README.md` returns 404.

## 3. Designed, next in line

### 3.1 Corpus Keeper: FLEx, lameta, this suite and the corpus checklist, kept in step

Full plan and issues: <https://github.com/rulingAnts/corpus-keeper> (`plans/corpus-keeper.md`
there; `plans/corpus-keeper.md` here is a pointer). The problem it solves: a field linguist has
five tools that each do one job well and do not know about each other. FLEx holds the text and its
analysis; this suite is where native speakers record, transcribe, segment and consent; lameta
holds archive metadata, sessions, people and consent files; a corpus checklist tracks genre
coverage and workflow progress; and a folder tree holds the recordings and exports. The keeper is
one small program that keeps them in step, and the plan decides, per fact, which tool is the
source of truth.

**Source of truth, per fact.**

| fact | lives in |
|---|---|
| text, words, glosses, translations, notes, segments | FLEx |
| segment timing and which media file a line plays | FLEx (`Segment.BeginTimeOffset` / `EndTimeOffset`, `Segment.MediaURI`) |
| media file identity | FLEx points (`CmMediaURI`), the lameta session folder holds; never inside the FLEx project (Send/Receive cannot carry large media) |
| speaker of a line or a text | FLEx `Segment.Speaker` (a person in the project's People list) |
| people and demographics | FLEx People; lameta `.person` files generated from it |
| consent recording and receipt | lameta `People/<Name>/<Name>_Consent.*` plus a receipt JSON beside it |
| genre | FLEx `Text.Genres`, mapped to lameta's genre list through one alias map |
| archive metadata (access, location, setting, device, contributors) | lameta session and `.meta` sidecars |
| workflow facts that cannot be derived (release forms, published, deposited) | the corpus checklist, mirrored into lameta's built-in session status |
| everything derivable (recorded, segmented, % glossed, ELAN present, consent present) | derived at sync, never stored |

**Architecture in three phases.**

1. **On demand (the deliverable).** A Python library on the FLEx machine and three FLExTools
   modules: *Sync* (FLEx to lameta and a status file, dry run first), *Send to device* (a timed
   FLExText plus media plus consent bundle per text into an Outbox the researcher panel assigns
   from), *Receive* (bundles from an Inbox: timing and media references into FLEx by segment GUID,
   media and consent files into lameta, text changes staged for FLEx's own FLExText merge import).
   All run with FLEx closed, like every existing FLExTools module.
2. **Resident.** The same library behind a tray app that watches the Inbox and the FLEx save,
   syncs on a quiet period, and serves a localhost endpoint so the panel can list FLEx texts and
   assign straight from FLEx. Gated on a test that FLEx's shared backend allows a second process to
   read the project while FLEx has it open. When the panel runs in a virtual machine or on another
   computer, the endpoint is reached by port forwarding, documented for Parallels in the keeper
   repository; it never listens beyond localhost.
3. **Live editing.** The FLEx-backed audio segmenter (§3.3) uses the keeper library as its
   sidecar.

**What the keeper writes into lameta.** One session folder per FLEx text (keyed by the text GUID
in a custom field): the original recording, its `.meta` sidecar with contributors, an ELAN file
that is always generated from FLEx and never hand-edited there (a FLEx-independent snapshot: plain
values only, every analysis language, morpheme form and gloss tiers where FLEx has them), a timed
FLExText export, and optionally the listening page. One person folder per FLEx person with the
consent recording and receipt. The keeper creates a `.session` or `.person` once and afterwards
rewrites only the fields it owns; everything a person typed in lameta is never touched. lameta's
built-in four-value session status (Incoming, In Progress, Finished, Skipped) mirrors the
checklist under two picks: which checklist step starts "In Progress" and which one means
"Finished"; nothing else about lameta status is configurable because lameta has nothing else.

**Cloud-synced folders never jam.** lameta project folders may live in iCloud Drive or Google
Drive. Every tool that reads those folders treats an undownloaded placeholder as a normal state:
metadata work proceeds without the bytes, byte work queues with a visible "waiting for" line, a
Download action with progress exists, every media read has a timeout, and sync temporaries and
transient permission errors are tolerated with backoff. One writer at a time: the keeper takes a
lock while it writes and will not run while lameta's own lock is present.

**Migration of an existing corpus** is one assisted pass, not a folder scanner: an inventory
script lists every FLExText, ELAN and audio file with the FLEx text GUIDs that tie them together;
a proposal maps files to sessions; the researcher reviews it in a spreadsheet; `migrate apply`
copies (never moves) into the lameta layout and writes a report of every file placed and every
file it did not.

**Changes to this suite that the keeper needs**, all in the browser code:

- consent per person, not per text: a "who is consenting" step in the consent collector, a receipt
  that records scope, access level, script language and version; bundles carry consent as person
  files in lameta's naming;
- a Speaker on the text and an optional per-line override, written as the FLExText `speaker`
  attribute so FLEx's import creates the people;
- the `media-files` block and per-phrase `media-file` reference in the timed FLExText so FLEx's
  import fills `Text.MediaFiles` and `Segment.MediaURI` itself;
- morpheme tiers in the ELAN export, in FLEx's own tier naming, from the item values only;
- later (Seth, 2026-09-07, recorded not scheduled): a mode in which the ELAN paragraph tier mirrors
  FLEx's real paragraph grouping instead of one annotation per phrase. The writer already emits both
  structural tiers; the split-per-phrase form is right for the app, where the structure is built by
  joining in ELAN, and wrong for a file the keeper generates from FLEx, where it is already known.
  **The keeper's ELAN file is a ONE-WAY mirror of FLEx** (Seth, 2026-09-07) — nothing in it is ever
  read back into FLEx. That is separate from the suite's own ELAN import, where a user opens an
  `.eaf` they made as an input file; that stays;
- panel entries for *Assign from FLEx* (Outbox, later the localhost list) and *Receive* (download
  into the Inbox).

**Build order.** Facts on the FLEx machine (member names through the LCM API; the shared-backend
test) → `flex_read` and FLExText round-trip fixtures → lameta writers and status → the Sync module
→ the suite changes → Send/Receive → migration inventory → the checklist import.

### 3.2 Corpus checklist

Originally planned as a self-contained page on a separate site (Appendix A of the keeper plan);
now planned to fold into the researcher panel once the keeper's status file exists, with assisted
migration of anything entered before then. What it does that lameta does not:

- **Targets as rule lists.** A target (SIL PNG's *Collecting Texts*, an IDB handbook, a workshop
  minimum, an archive's baseline) is a list of rules of six kinds: a count of texts in a scope with
  required steps done, a minimum for every child genre, named texts to collect, coverage across a
  set, a quantity such as pages of vernacular text, and collection-level checklist items. A
  *Hybrid* target is the union of the selected ones, every line labelled with its source.
- **The finding that shapes it.** No major language archive publishes a minimum number of texts,
  hours, or a genre quota; archive requirements are about format, metadata, consent and access.
  Genre quotas are therefore an editorial standard, marked as such, and the DELAMAN minimal
  checklist is the cross-archive baseline every archive profile inherits.
- **Counting that is exactly right.** Tagging a genre implies its ancestors; every count is the
  size of a set union, never a sum of siblings; rules are evaluated independently; nothing derived is
  stored; texts may count by number or by summed audio duration.
- **A genre tree with one canonical set of nodes** and per-organisation aliases (including the
  OLAC discourse-type vocabulary lameta uses), a two-axis top level (texts about events, texts about
  things) that a user can re-arrange with the language-internal evidence recorded on the node.
- **Steps that are user-editable**, hidden until a selected target requires them, and, once the
  keeper exists, derived facts that are never ticked by hand.
- **Consent that only narrows.** Consent is a property of a person; a researcher may withhold a
  text with a written reason but may never grant what the speaker did not.
- **A printable report** that counts held texts without naming them and states the mode it was
  produced in; JSON export and import as the wire format.

### 3.3 FLEx-backed audio segmenter (#49)

A desktop app (Tauri, Windows first) that opens the Audio Segmenter's matcher on a text read live
from a FLEx project through the LCM API, edits only the audio segmentation, writes offsets back
by segment GUID, detects and repairs alignment broken by edits made in FLEx, keeps rotating
timestamped FLExText backups, and forces the settings that disable text editing. The user works
on the text in FLEx and on the audio beside it. Gated on the same shared-backend test as the
keeper's phase 2; built on the keeper library.

### 3.4 One-line export from the segmenter and the Paragraph Analysis Tool (idea, issue #52)

A per-row button that exports one audio segment or interlinear line in the form the moment
needs: a FLEx-like TSV copied to the clipboard, LaTeX `langsci-gb4e` code (reusing the LingTeX
Tools generator), the line's audio as a file, a self-contained one-line preview page with the
interlinear and a player, or Word 2007 XML in the schema FLEx's own interlinear export uses. It
matters most in the FLEx-backed segmenter (§3.3), where the Word file should open in a Word window
at once for copy and paste; in the browser it is a download the system opens.

### 3.5 Translators add a UI language without a coding session (#47)

Today a UI language is a block in `docs/js/i18n.js`, added by the maintainer. The plan: one
editable file per language, an in-app editor for it (a translator must never be asked to edit
JSON in a text editor), a parity check that names missing keys, and a way for a translated file to
reach the maintainer for inclusion in a release.

### 3.6 Right-to-left support (#48)

For the UI (Arabic-script interface languages) and for right-to-left vernaculars in the text boxes,
the listening page and the exports. The typing rule already targets the *logical* end of a box so
it needs nothing; the question of whether a waveform should run right-to-left in such a layout is
recorded as open (the answer is technically yes; whether users want it is not known).

## 4. Native shells

The web app is the product; the shells exist for archive-quality audio capture, which a browser
cannot provide (`android/README.md` and `electron/README.md` give the two archival reasons and the
honesty contract).

**`plans/native-shell-capabilities.md` is the register** of everything a native shell can do better
than a browser, and the design rule that goes with it: the shell *declares* a capability, the engine
*decides* what to do about it, so policy ships with the auto-updating engine instead of waiting on
an APK someone has to carry to a village. Add an entry whenever a limitation turns out to be the
platform's rather than ours, and put the seam in before the native side exists.

- **Android:** two Capacitor wrappers (recorder, editor) around one auditable plugin, built and
  in use. Open: the update story, since an installed APK pins its engine snapshot while the web app
  auto-updates.
- **Windows desktop (Electron):** captures through a bundled LGPL ffmpeg in the main process; one
  unsigned x64 test pre-release exists (2026-07-23). Open before it goes to field users: per-device
  format probing so a capture can be described as *captured at* rather than *written at* a bit
  depth, and code signing (a paid certificate) so SmartScreen stops warning.

## 5. Backlog, recorded as GitHub issues

Open items on the suite, in the order the maintainer named them; each issue holds the detail.

- **Editor:** a second word-gloss and free-translation layer per device (#41, partly met by v585's
  multi-language exports and listening page); keep the selected row in sync across tabs, number the
  rows, auto-scroll (#39); capture Ctrl+S (#40); Cut tab strips on very long files (#31, largely
  addressed by lazy strips in v580; SVG strips remain an idea, #46).
- **Researcher panel:** assignment-upload progress in a movable modal (#38); an uploaded but
  unsent assignment saved into Unassigned (#37); sub-folders and tags for texts (#34, #35); rename
  devices (#32); finished texts removed from devices and their afterlife (#30, a design question);
  pause, resume and cancel for transfers (#21); **an audit of settings that contradict each other**
  (Seth, 2026-09-08) — the v641 reorganisation went through all fifty and found no dead ones, but it
  looked for misfiling, not for combinations that cancel out (word glossing off while the gloss
  landing box is set to "the next empty word gloss", say). See `plans/settings-organisation.md`.
- **Interchange:** Toolbox / SFM to FLExText import, one or many texts per file (#29); lameta
  integration from the engine side (#28, superseded in scope by the keeper).
- **Devices:** native audio conversion as a fallback (#22); a resource audit for a 40-minute
  recording on a cheap phone (#19); pasting an invite into an already-linked device (#18).

Longer-range items with written analysis live in `plans/BACKLOG.md`: a project key so devices
belong to projects rather than to one researcher, one-time coworker pairing links, administrator
suspension of accounts, an estate snapshot-and-restore ("Clonezilla for the suite"), a universal
diagnostic dump behind a button, video sources with audio extraction, what a revoked device
retains, and the permission-prompt audit.

## 6. Deliberately not planned

- **A WaveSurfer regions plugin.** Boundary marks and drags are drawn by the suite itself so the
  Cut tab cannot silently gain an editable-region UI; the same mechanics are reused instead.
- **Service-worker hash verification of precached files.** Investigated for a missing-buttons
  report that turned out to be a one-off; the version sentinel already refuses a mixed install.
- **Folder scanning to import an existing corpus.** The messy step is done once, assisted, with a
  reviewed proposal (§3.1), not by a parser guessing at an irregular tree.
- **Secrets, contact lists or private URLs in this repository**, which is public; `plans/README.md`
  records what may and may not go into a design document.
