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
  pause, resume and cancel for transfers (#21).
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
