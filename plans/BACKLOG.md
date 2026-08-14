# Backlog additions (2026-08-07) — paste into notes/BACKLOG.md

> ⚠ **Start at [`PENDING.md`](PENDING.md)** — the one-screen triage sheet that ranks everything below
> by risk to a field user's work and points back here for the detail. This file is the record; that
> one is the way in.


## TO-DO (when Fable is available): a system-resource and cheap-device audit (Seth, 2026-08-14)

> *"An audit for system resources and cheap phone/laptop compatibility would be in order. Let's not
> worry about that right now at this moment."*

⚠ **This is a to-do, not a live problem.** It was raised while a Mac at 4% battery was throttling —
Seth: *"everything gets slow and glitchy at that point"* — and explicitly deferred. Nothing here is
evidence that a field device is struggling today.

### Fixed in v369, off this audit's plate

Leaving the editor (Back, or return-after-send) leaked the tab tickers: 60 rAF/s + ~3,600
querySelector/s against hidden DOM on the texts list, plus ~180 canvases (~25MB) idling behind it.
`leaveEditor()` in app.js now stops all three tickers and drops the canvases — measured after:
0 rAF/s, 0 queries, 0 canvases, 0.0% CPU. Still open and measured for THIS audit: the in-editor
per-frame query load (~14k querySelector/s on the Cut tab, the deliberately-reverted caching), the
hidden-tab canvas accumulation WHILE in the editor (~25MB by the Gloss tab), and the 40-minute
decode heap (~492MB at 16kHz mono on desktop; a 44.1kHz phone recording is ~3× that, transiently on
every reopen since v368 decodes honestly on reopen).

### Measurements already taken, so the audit does not start from zero

Chromium, 1100×800, a 2-minute recording cut into 60 lines (v365). These were captured while chasing
the false alarm and are worth keeping:

| where | CPU | rAF loops | DOM lookups/s | canvases resident |
|---|---|---|---|---|
| Cut tab, idle (nothing playing) | 3.7% | 2 (120/s) | ~14,700 | 63 (10.6MB backing store) |
| Cut tab, playing | 37.7% | 2 | ~14,700 | 63 |
| Baseline, idle (Cut hidden behind it) | 3.9% | 1 | ~10,900 | 122 (20.3MB) |
| Gloss, idle (two tabs hidden behind) | 3.7% | 1 | ~3,600 | 182 (25.3MB) |
| **Texts list — editor left entirely** | 1.8% | **1 still running** | **~3,600** | **180 (24.7MB)** |

The three findings that stand out, in order of size:

1. **Hidden tabs keep their rAF loop.** Only some transitions stop the loop they are leaving, so
   Baseline→Cut leaves two walking two lists every frame, and **Back to the texts list leaves one
   running over a text nobody is looking at**, with all its canvases still resident.
2. **Per-frame DOM queries scale with the text.** Each ticker does `querySelectorAll` over every row
   plus ~3 `querySelector` calls per row, every frame: ~245 lookups/frame at 60 lines, ~2,600 at 650
   (a 40-minute recording, which "Guess the lines" can now produce in one press).
3. **The loops run at full rate while PAUSED**, which is most of a transcriber's time — and nothing
   they paint can change while the playhead is still.

### ⚠ The obvious fix has a trap in it — found the hard way

An "idle gate" (skip the per-row pass when the playhead has not moved and nothing is playing) was
written and measured: idle DOM lookups 14,700/s → 0, and the texts list to zero loops and zero
canvases. **It was reverted, and not only because the alarm was false: it leaves the per-row ▶/⏸
glyphs stuck showing "playing" after a pause**, because the row glyphs are painted by the ticker and
the playhead stops moving at exactly the moment the state changes. A correct gate must also treat a
CHANGE in `playing` as work, and the browser test must assert the row glyph after a pause — the
existing check watches the dock button, which the Player updates from its own event and which would
therefore have passed.

### Where to start

- stopping hidden tickers and freeing the editor DOM on Back are the cheap, behaviour-free half;
- the row-list caching is a pure refactor (build the `{row, wave, btn}` list at render, walk it per
  frame) with no UX change;
- the idle gate is the big win and the one that needs care, per above;
- and canvas backing store (~25MB at 60 lines, linear in the count) is the memory item to think
  about before anything else — `drawStrip` scales by `devicePixelRatio`, so a 3× phone pays 9× the
  pixels for a strip nobody is reading.

---

## ⚠ A LIST THAT REBUILDS MUST NOT THROW THE USER BACK TO THE TOP — general rule + one live bug (Seth, 2026-08-14)

> *"Researcher panel texts list bounces back to the top after a change made to a text on the bottom
> (delete or whatever). In general that's a default behavior we should be aware of and avoid from the
> start in all our new features — jumping back to the top/start when a change is made to the DOM (or
> data model? I don't know exactly how it works)."*

**KNOWN BUG — FIXED v369, pending the panel test drive:** the researcher panel's texts list. The
cause was the dashboard's full render repainting the panel to a "loading…" note before the fetch
(researcher-panel.js `renderDashboard`); it now refreshes in place when a dashboard is already on
screen and restores the offset across the swap. ⚠ Not live-driven in the audit environment (no dev
worker) — scroll deep, delete a bottom text, and watch the position before trusting it. v369 also
fixed the same class of bug on the Baseline strips (the playhead-Enter chop; measured 8021→0, now
held) and audited the rest: gloss joins and the texts-list delete already survive, because their
rebuilds are single-task.

**WHY IT HAPPENS**, since Seth asked: it is the DOM, not the data model. Our lists re-render by
emptying a container and rebuilding it (`innerHTML = ''` / `replaceChildren()`). An empty container
has no height, the browser CLAMPS `scrollTop` to the new maximum — zero — and refilling it cannot
restore what was already clamped away. Nothing "jumps"; the position was destroyed between the two
statements.

**THE RULE FOR NEW FEATURES:** any list that rebuilds in place must read its scroll offset BEFORE
emptying and restore it after. Where row heights can change, also anchor on the edited row's own
screen pixel. The Cut tab does exactly this (`renderCut`'s `keepTop` + anchor delta, v357) after
the same complaint about cuts and joins — copy that, and note the ordering trap it documents: the
offset must be read before `replaceChildren()`, not after.

**Places to check**, all of which rebuild the same way: the researcher panel's texts list (the
reported one), the Texts screen (`#doc-list`), the Files modal, the assignment list, the Gloss tab's
line groups. Worth one sweep rather than five separate reports.

**⚠ For the Fable audit** (see the top of this file): treat "does this list survive an edit to its
last row?" as one of the passes. It is invisible to every structural test we have and only shows up
on a list long enough to scroll — which is every real one in the field.

## (built v375) Assignment titles fill themselves in (Seth, 2026-08-14)

> "have a new text title default to the flextext filename (minus the file extension) if there is one,
> and the audio file's filename (minus the file extension) if there isn't … the manual edit is the
> final source of authority. But if it's blank and a file is attached, then populate it with the
> filename. If the filename is the same as the audio, and then a flextext file is added, pull the
> title from within the flextext XML."

**Low risk, and it stayed low by construction:** entirely inside `assignModal` in the researcher
panel — no engine, device, worker or format change, and the worst failure is a wrong default the
researcher edits before sending. `parseFlextext` was already imported there and already used by the
same modal's send handler, so nothing new entered the panel's dependency surface.

**The priority order (Seth, locked v376), highest first:**
1. what the researcher types into the box
2. the title inside the flextext's XML — the FIRST one that appears
3. the flextext's filename
4. the audio file's filename

⚠ **(2) beats (3) outright**, not just when the filenames happen to match. v375 shipped the narrower
reading — XML title only when the flextext and audio shared a base name — and Seth corrected it to
this, which is both simpler and better: FLEx stores a real title, and `export_final_2.flextext` is a
fact about somebody's desktop rather than about the text. The filename is the fallback for a flextext
that carries no title, and an unreadable file falls back to its filename too — never silently down to
the audio name.

⚠ **A field the researcher EMPTIED is refilled.** Typing latches authority and is never overwritten,
but clearing the box reads as asking for the default back — an assignment with no title at all helps
nobody downstream.

## ⚠ NEVER STRAND A DEVICE'S WORK — the send-capability trap (found by reasoning, fixed v374)

Seth, 2026-08-14, thinking one step past the queue fix rather than waiting for a report: *"if I pair
a device, set it to upload only, and then unpair it, the last setting it had was 'upload'. Will it
automatically enable the defaults for an unpaired app at that point?"*

**It did not, and the result was silent data stranding.** `sendOptions` is a PERSISTED device setting
that unpairing never touched, so an upload-only device that lost its pairing computed `share:false`,
`upload:false` (no target), `save:false` — and `updateShareButton()` hid the entire Send button.
Hours of transcription sat in IndexedDB with no route out and nothing on screen explaining why.

**The rule now:** when NOTHING is possible, saving becomes possible (`sendCapabilities`). Saving is
the one route that needs no server, no pairing and no permission from anyone. It is a LAST RESORT —
a working upload-only device gains nothing, and the researcher's restriction is honoured in full for
as long as the pipeline it points at exists.

⚠ **Not a hole in the seized-device story.** Revocation is not a wipe: the panel has a remote-wipe
directive for that, and anyone holding the hardware can read IndexedDB anyway. Hiding a button never
protected data from its holder, only from its author.

⚠ **It also closed a SECOND, older instance of the same trap** that app.js already documented from
the other side: a device permitted only `share`, on a browser with no `navigator.share` (desktop
Firefox), had every capability false and the button hidden. Same stranding, different route — and it
had been sitting there, documented, unnoticed, because the earlier fix asked "why is the menu empty?"
instead of "what can this person do now?".

**And being unlinked is now SAID.** Sync cleared the session on a 410 and told nobody (`onStatus`
was an empty function), so from the user's side the upload option vanished, a Save option they had
never seen appeared, and the queue stopped — three mysteries with nothing tying them together. One
toast now states the fact and what still works.

**Also v374:** the version badge rides above the upload tray instead of underneath it (Seth: "when
testing the dev or staging, it's useful to be able to see that and sometimes we can't"). Both are
fixed to the same corner; the badge now offsets by the tray's measured height, so it also moves when
the item list is expanded.

## ⚠ THE UNPAIRED-QUEUE JAM — diagnosed and fixed (v372/v373, 2026-08-14)

**What actually happened**, after two wrong hypotheses worth recording:

Seth deleted a device in the researcher panel. That PWA became UNPAIRED, so
`Sync.workerUploadTarget()` returned null, and `upload.js` threw its truthful "Uploads need this
device to be linked to a researcher." — which **the tray discarded**, showing the fixed string
"Failed — will retry" and the summary "3 file(s) waiting to upload — will retry shortly." forever,
once per `RETRY_EVERY_MS` sweep, on battery. Seth's own question is the indictment: *"It's an
unpaired flextext PWA. Which begs the question why it's trying to upload at all."*

**Nothing else was broken.** Not the release, not the worker, not CORS, not assignment — his remote
"Upload now" triggers to a coworker's device kept working throughout, and Drive kept receiving
bundles from his paired session. Only the unpaired device was stuck, and only its own queue.

### ⚠ Two hypotheses I chased and should not have

1. **A persisted `?devworker=staging` override.** Plausible (the staging worker refuses production
   origins by design) but he had never used it. Cost: a round trip.
2. **Chrome Local Network Access.** His DevTools showed the Cloudflare beacon BLOCKED at
   `[fd00:aa:bb:2200::6810:5049]` — a real public Cloudflare IP (104.16.80.73) wearing a private
   ULA prefix from his network's NAT64/DNS64, which Chrome 151 does block from a public page. All
   true, and **not the cause of the upload jam** — it blocked one analytics beacon. I over-committed
   to it because it was vivid and arrived with evidence.

   ⚠ **The fact that killed it was available the whole time and I under-weighted it:** two uploads
   for DIFFERENT texts landed in Drive in the same minute the "jammed" bundle failed. A
   network-level block cannot be that selective. When one item fails and its neighbour succeeds,
   the cause is per-item or per-state — never the network.

### The fixes

- **v372** — a failing upload says WHAT it could not reach; non-2xx carries its HTTP status (401/403
  and, added after this diagnosis, **410** = the device was deleted from the panel) with the remedy
  named; the tray row shows the real message instead of "Failed — will retry"; a diagnosis line
  names the backend and offers a one-tap way back off a non-default one.
- **v373** — an unpaired device **HOLDS** its queue: items are kept and shown, nothing is started,
  the tray says "kept here — this device is not linked to a researcher", and everything resumes by
  itself on re-pair (the target is read fresh per attempt). ⚠ HELD, NEVER DISCARDED — unpairing is
  routine and these blobs can be the only copy of hours of transcription.

⚠ **The regression test earned its keep twice.** The first version of the fix made held items
INVISIBLE (worse than the bug). The first version of the test then passed with the fix disabled,
because it counted network requests — and an unpaired device never reaches the fetch at all, so the
count is zero either way. Only the TRAY's wording discriminates. `test/browser/unpaired-queue.playwright.mjs`.

## A devworker override must be VISIBLE, not a console line (post-release incident, 2026-08-14)

Minutes after the v371 release, uploads "failed" from one browser session and read as a broken
release ("Did you manage to break CORS somehow?"). The evidence said otherwise — the worker was never
deployed, the release diff touched no upload surface, and Drive received complete bundles (including
a 25MB m4a) at 02:13, 02:17, 02:48 and 02:50Z, AFTER the report, while the "failing" bundle had
itself uploaded fine three times on 08-12. The pipeline was healthy; the failure was local to one
session — most plausibly the persisted `?devworker=staging` override, whose staging worker rejects
production origins BY DESIGN, presenting as CORS-like upload failure with the tray's generic
"Failed — will retry".

**The lesson:** the override's only trace is `[flextext] backend:` in the console, which nobody has
open. A silently-persisted staging backend on a production origin strands every upload behind a
message that looks like an outage. For a future release, pick one:
- a small persistent badge/banner whenever `relayWorker` differs from `DEFAULT_WORKER` ("dev backend:
  …", tap to revert) — the honest fix, cheap;
- and/or the tray's failure line should distinguish "the server refused this origin" (a CORS/network
  TypeError against a non-default backend) from an ordinary retryable failure, and say which backend
  it was talking to.
Do NOT silently auto-revert — the loud failure of a field device on the staging backend is a
deliberate guard (see originAllows); the fix is visibility, not silence.

**Diagnostic that settled it, reusable:** the researcher's own Drive listing is a live health check
of the whole upload pipeline — if bundles are landing, the worker, CORS, and the Drive token are all
fine, and the problem is the device in front of you.

## FUTURE RELEASE: gloss-scissors playhead guard + configurable span-play return (Seth, 2026-08-14)

Two connected requests, made during the v371 release round — **not in that release**:

**1. Guard the gloss tab's ✂ (line-split at a word gap) against an unplaced playhead.** The split
takes its TIME from the playhead; clicking the scissors while the playhead sits at the very start or
end of the line's span (i.e. nobody placed it) mints a sliver or a timePending half. Seth: *"If the
user clicks the scissors between words, but the playhead is all the way at the start or the end (not
in the middle), don't split and flash/highlight the waveform as a reminder that they need to place
the playhead."* So: refuse + a brief flash/highlight of that line's mini waveform — a visual nudge,
not a toast. "At the start or end" needs a tolerance (the playhead rests at exactly `start` after a
span play; treat within ~MIN_SEGMENT_MS of either edge as "not placed").

**2. Span playback should RETURN TO THE PLAYHEAD, not rewind to the span start — researcher-
configurable, default ON.** Seth, reversing the earlier rewind rule: *"let's undo what I said about
always rewinding to start when played to the end. It might actually be better especially for the
glossing tab split for it to remember and return to the playhead location instead of rewinding every
time it's played. Maybe actually the same for the baseline tab. Let's let the researcher configure
that behavior actually. Default to remembering and preserving playhead position when space is
pressed, but able to change that."*

- Today (v322/v364): a span played to its end pauses and rewinds to the SPAN START.
- New default: remember where the playhead stood when play started, and return THERE at span end —
  which is exactly what makes the scissors workflow above work (listen from the split point, play
  runs out, playhead comes home to the split point).
- Researcher setting (panel + engine reader must agree on the default, as with the v367 six); the
  rewind-to-start behaviour remains as the non-default option.
- Touches the span watcher (`playSpan` / `_spanTick`) — the component every previous transport bug
  lived in; browser-test both modes on all three tabs before merging.

## Slow the playback down without changing the pitch (Seth, 2026-08-14)

> *"is there an easy way for us to slow down the playback speed without distorting the pitch (I think
> there's ways to correct for that now…)? I realize with lossy files that might be especially
> unreliable… That's a plan to look into later though, not a fix now."*

**Yes, and it is close to free.** `HTMLMediaElement.preservesPitch` is standard and defaults to
**true** in Chromium, so `playbackRate = 0.6` already keeps the pitch by default — the browser
time-stretches. wavesurfer 7 exposes it as `setPlaybackRate(rate, preservePitch)`. The player
already has a speed picker (`select`, named in `transportKeysApply`'s exemption list); the question
is what its values do, not whether the capability exists.

**The lossy worry mostly evaporates in segmentation mode**, because playback there is already on the
derived WAV working copy (`segwav:`), not on the compressed original — the same reason that copy
exists at all (AAC priming). A basic-editor user with segmentation off does play the original.

What to actually decide before building:

- **Which rates.** 0.75 / 0.5 is the usual transcription pair; below ~0.5 Chromium's stretcher
  starts sounding metallic on speech, which is worse than useless for hearing a phoneme.
- **Does it survive a span play?** `playSpan` watches `timeupdate` against a captured stop time; at
  0.5× the watcher fires half as often in audio-time terms but the maths is unchanged. Worth a
  measurement, not an assumption — the span watcher is where every previous transport bug lived.
- **Does the rate persist per device, per text, or not at all?** Probably per device (it is a
  listening preference, not data), which means a setting, which means the researcher panel.
- **⚠ Do NOT let it reach the peaks or the exports.** Rate is a listening aid; every time written to
  `doc.segments`, an EAF or a `.flextext` is real-time. A rate that leaked into `playheadMs()` would
  put cuts in the wrong place, silently.

## 🅿 PARKED BRANCH: `parked-panel-and-matching` — panel work + segment matching (Seth, 2026-08-08)

> *"We need to park the Researcher Panel improvement and the 'segment matching' features on a
> feature branch and focus on bug fixes and improvements to the editor UI/UX itself."*

staging keeps the EDITOR cycle (bug list items 1–11 + the two OTHERS); everything panel- or
matching-shaped moved to **`parked-panel-and-matching`** (head = staging at v329).

**Parked (removed from staging, preserved on the branch):**
- **Audio Matching mode** (v323/v324) — the guided match-text-to-audio step, its trigger on doc
  open, host div, CSS, i18n. ⚠ It auto-entered on opening any unaligned text, so it would have sat
  in front of every editor test.
- **`fxCheck()`** (v328) — the assign-link diagnostic console helper.
- `plans/audio-matching-mode.md` stays on staging: it is a PLAN, never served, and the design
  decisions (no skip, undo-un-cut, seed-path trigger, researcher re-segmentation) must not be lost.

**Deliberately KEPT on staging** — bug fixes, not improvements, and removing them would knowingly
re-break assignment:
- v327 `driveFileId`/resolve fix (assigned flextext fetched raw → CORS → retried forever). Verified
  end-to-end in node against the real field file.
- v325 soft-degrade (a glitchy link must not hard-block a valid assignment).
- v329 "say why it has not arrived" (HTTP 401/403/404 vs outage, instead of one silent message).

⚠ **Re-merge is a plain `merge --no-ff`** — the removals were EDITS, not reverts, so nothing is
revert-poisoned. Expect conflicts in app.js around openDoc/applyUndoState/applyBaseline where the
matching hooks were removed; take the branch's side for matching-mode lines and staging's side for
everything else.

## 🅿 PARKED BRANCH: `parked-v319-v321` — ALL work newer than productionWeb, off staging (Seth, 2026-08-08)

> *"Can we park all our new, untested PAT features on a feature branch (remove them from staging) so
> that I can test those later and focus on the flextext editor app right now? … Everything newer
> than what's on productionWeb … we want to move ANY staging changes that aren't specifically
> flextext editor to that feature branch."*

**staging was RESET to `productionWeb` (v318)** so Seth's editor test round with a national coworker
runs on exactly what production runs, with nothing untested underneath. Everything newer is
preserved, unrevereted, on **`parked-v319-v321`** (head `054ce78` = staging's old head):

- v319 — device reports per-kind upload ids; `.fxpa` source stamp
- v320 — GUID similarity gate (`sameLineText`)
- v321 — the 12-agent audit hardening (classic-mode affix fix, NFC, demoted attrs, stale-note
  filter, serialized stamps, `fxpa-contract` suite) + audit records + the roadmap corrections
- (the constituent feature branches `fix-artifact-kinds-and-fxpa-stamp`, `guid-identity-gate`,
  `v321-hardening` also still exist on origin)

⚠ **How to bring it back — NO reverts were used, so there is no revert-poison:** plain
`git merge --no-ff parked-v319-v321` into staging when Seth is ready to test it. Do NOT rebase it;
nothing requires it.

⚠ **Version numbering:** v319–v321 are BURNED — Seth's devices saw them on staging during testing.
New editor work starts at **v322**; the parked work gets renumbered via `./bump-version.sh` when it
re-merges (same as the v317→v319 renumber before it).

## Worker: /drive edge-cache put copies Drive headers verbatim (Set-Cookie) — hygiene (2026-08-08 probe)

Found while ruling out the delete-then-reuse audio bug (verdict: NO poisoned state exists — partials
are docId-keyed and deleted with the doc; the probe is stateless; the only first-vs-second-use
asymmetry is the worker's 24h edge cache, which makes retry MORE likely to succeed). Remaining
hygiene: worker/src/index.js caches /drive responses with Drive's headers copied verbatim —
Cloudflare's Cache API rejects puts carrying Set-Cookie, and the waitUntil'd put + client-side
stream cancel is the one speculative poisoning shape. Strip hop-by-hop/Set-Cookie before
caches.default.put and guard the put. ⚠ WORKER change — rides the D1→worker→client release order,
not an editor cycle. The two CLIENT halves shipped in v325 (probe timeout remap; soft-degrade).

## Panel: warn when an assigned audio URL is ALREADY assigned to another active text (2026-08-08)

Field incident (Sentani): Drive's "Copy URL" silently failed to copy, the OLD URL stayed on the
clipboard, and the researcher pasted the same file into a second text without noticing — the same
URL sat in both boxes and the resulting confusion looked like an app bug ("Cannot use this audio:
NetworkError", initially blamed on delete-then-reuse). A cheap paste-time check — "this URL is
already assigned to '<title>'" — converts that silent clipboard failure into an immediate visible
one. WARN, never block: the same recording on two texts is a legitimate workflow. Panel-side only,
at the point the URL field is set/validated.

**Check ORDER (cheapest first, Seth):** (1) LOCAL, instant, offline — the audio URL and the
flextext URL within one assignment must DIFFER (one file cannot be both; the clipboard failure
makes this collision likely), and normalize before comparing so the same Drive file id in two URL
shapes still matches; (2) local — the duplicate-across-texts warning above, from panel state;
(3) only then the network content sniff below.
**(4) WRITING-SYSTEM match (Seth, 2026-08-08):** once the flextext probe has the file, run the
EXISTING `surveyWritingSystems()` (flextext.js — the panel's Utilities checker already uses it)
over the XML and compare the file's baseline/gloss writing systems against the assignment's own
`vernLang`/`analLang` fields in the same form. WARN on mismatch, never block — and remember FLEx
codes are CASE-SENSITIVE (the research.wsCase tip), so 'Fau' vs 'fau' is a real mismatch worth
naming exactly. The warning should point at the existing remap tool (`remapWritingSystems`) as the
fix path. ⚠ This upgrades the flextext probe from first-bytes to a full fetch — fine, flextext is
small text XML; the AUDIO probe stays first-bytes. Never spend a worker round-trip on something a
string compare already answers.

**Plus per-field CONTENT validation (Seth): each field verifies its file really is what the field
means.** The audio box fetches the first bytes (through the worker relay, never direct-to-Drive)
and sniffs audio magic (RIFF/WAVE, fLaC, OggS, ID3/MP3 sync, ftyp/M4A); the flextext box sniffs
XML with a `<document>` root. Catches the paste-the-wrong-file class outright (including the
clipboard failure above when the stale URL is the wrong KIND). ⚠ On a glitchy link the probe must
degrade to "could not verify" — a warning, never a block: Sentani bandwidth must not be able to
stop an assignment that is actually fine.

## Warn the researcher that an invite link OVERRIDES a device's existing setup (Seth, 2026-08-07)
**Where:** researcher-panel.js, the invite-link generation flow. NOT built — deliberately deferred.

A standalone editor can now be set up entirely on the device (Settings tab → device setup, v289).
When that device later claims an invite, the researcher's pushed settings replace ALL of it —
writing systems, recording, consent prompts, and the consent audio (their Drive URL outranks the
locally-picked file by construction; see consentLocalAudio()).

So the researcher should be told, at the moment they generate an invite, that pairing will overwrite
whatever setup already exists on that app.

⚠ WARN THE RESEARCHER, NEVER THE EDITOR USER. Seth's reasoning: "The logic of this suite is that
that user should not be expected to be tech savvy enough to understand what that means and make an
informed decision." A prompt on the device would ask a field worker to arbitrate a question that is
not theirs, at the worst possible moment.

## ~~Read and edit .fxpa in the FlexText Editor without breaking the analysis~~ — CANCELLED (Seth, 2026-08-08)

> *"We're moving away from editor able to read fxpa back. We don't actually want that. We don't want
> PAT to export to FLEx or Editor. EAF maybe, in the future. So fxpa only imports in PAT. It's PAT's
> save that can open in other PAT instances, or the same one."*

**The flow is ONE-WAY:** `Editor ──.fxpa──▶ PAT ──PAT save──▶ PAT`. The editor's own transfer format
is `.fxed` (`fxed-format-spec.md`), which can also *export* `.fxpa`. Nothing reads `.fxpa` back.

Kept rather than deleted so it is not re-proposed — and because the hard part it names (keeping the
tree's invariants across a line split/join) did not go away, it moved: it is now
`plans/pat-one-tree-model.md`, where every unit is a line and `splitLine` already exists.

### (cancelled — original entry)
**Not started. Next up after the current settings work.**

The editor should import a .fxpa, expose ONLY lines, free translations and glosses for editing, and
write it back with the paragraph-analysis tree as close to untouched as possible.

- It does NOT need to render any paragraph-analysis structure. No brackets, no diagram, no grouping UI.
- The hard part is the seams: combining or splitting lines must auto-adjust groupings, making the
  MINIMAL change needed to smooth over the break rather than re-deriving the tree.
- So the editor needs enough of the .fxpa model to keep the invariants (single parent, adjacency, no
  dangling ids) true across a line split/join — checkInvariants and repairDocument already exist in
  paragraph-model.js and are the natural seam.

## ⚠ CONFIRMED: a deleted line's GUID gets adopted by an unrelated new line — and FLEx honours GUIDs (2026-08-08)

**Seth, 2026-08-08: "FLEx honors an incoming guid."** That settles the question below and makes this
actionable. Two consequences, one good and one not:

✅ **The minting is a FEATURE — do not remove it.** Because FLEx honours the guid, re-importing an
updated export *updates the existing text* instead of creating a duplicate. That is exactly what the
field workflow wants, and it works today by accident of `makeSegment` minting UUIDs.

❌ **But identity can drift onto the wrong line**, and with FLEx honouring guids that means FLEx-side
work silently reattaching to different text.

### The demonstration (run against the shipped code, not reasoned)

Start `one / two / three`, then delete `one` and add `four`:

```
BEFORE:  one 890f9f65 | two 9bf2fd6e | three 67b438ac
AFTER:   two 9bf2fd6e | three 67b438ac | four 890f9f65
                                              ^^^^^^^^ the DELETED "one"'s guid
```

`two` and `three` keep theirs correctly (exact LCS match). `four` — a brand-new line — **inherits the
deleted line's identity.** On re-import FLEx updates the object that was "one" to now read "four",
carrying any FLEx-side glossing or analysis with it.

### ✅ Split and join are FINE — this was checked, not assumed

Seth: *"I'm really not sure what happens with guids of split items."*

| edit | behaviour |
|---|---|
| split `"alpha beta"` → `"alpha"`, `"beta"` | first half **keeps** the guid, second mints a **fresh** one, neighbours untouched |
| join `"alpha"` + `"beta"` → `"alpha beta"` | joined line carries **`alpha`'s** guid; `beta`'s is dropped |
| edit a line's text in place | keeps its guid — arguably correct, same slot retyped |
| **delete one line + add another** | **the new line adopts the deleted one's guid** ← the bug |

### Root cause: one line of code serving two purposes

`reconcileBaseline` **pass 2** pairs leftover-old to unmatched-new **in order, with no similarity
check**, and carries `attrs: old.attrs` wholesale.

Pass 2 exists to preserve **user work** (glosses, free translation) across an edit. Carrying `attrs`
also transfers **identity** — and, incidentally, imported `begin/end-time-offset`. Three things, one
assignment. Separating "keep the user's glosses" from "this is the same object" is the fix.

### ✅ DECIDED (Seth, 2026-08-08): keep FLEx's `guid` attribute, gate its inheritance on similarity

> *"I think what we should use is FLEx's guid attributes in flextext, but we should be extra careful
> to make sure we're not falsely applying old guids to deleted/added items… if the user deletes and
> re-adds something, it gets a new guid. Lines that get deleted or manually added in FlexText Editor
> should get brand new guids."* — then, on the gate: *"I agree with the similarity gate."*

**Why a gate and not simply "pass 2 always mints fresh".** Pass 2 cannot currently tell *deleted and
re-added* from *edited in place* — both land there. Fix a typo in line 5 of 20 and LCS matches the
other 19, so line 5 falls to pass 2 exactly like the `four`/`one` case. Minting unconditionally would
therefore give **every typo fix a new guid**, and with FLEx honouring guids that means a new FLEx
object and orphaned glossing on every correction — a worse regression than the bug being fixed.

**The rule:** pass 2 keeps pairing (so the user's glosses still carry), but the **guid** rides only
when the paired texts actually resemble each other.

| paired old → new | expect |
|---|---|
| `"one"` → `"four"` | **fresh guid** — the demonstrated bug |
| `"the dog run"` → `"the dog runs"` | **keep** — a typo fix stays one FLEx object |
| `"cat"` → `"cot"` | **keep** — short lines must not be penalised |
| `"alpha beta"` → `"alpha"` (split) | **keep** — today's correct behaviour, must not regress |

### ⚠ Three things must stop travelling together

The whole bug is that `attrs: old.attrs` does all three at once. Separate them:

| what | on a fuzzy pair |
|---|---|
| **user work** (`carryWords`, `free`, `freeLang`) | **always carry.** It is word-matched, so it degrades gracefully, and it is the user's typing. |
| **`guid`** | **gated** on the similarity test above. |
| **`begin`/`end-time-offset`** | **never carry.** Same `attrs` object, same drift, and a stale offset is a false alignment. |

### ⚠ Notes for whoever implements it

- **Token overlap alone is wrong.** `"cat"` → `"cot"` shares no tokens but is obviously an edit. Use
  a character-level normalised similarity (e.g. `1 - editDistance / max(len)`), or a hybrid.
- ⚠ **The naive threshold's usable window is NARROW — measured, not guessed:**

  | pair | `1 - lev/max(len)` | wanted |
  |---|---|---|
  | `"one"` → `"four"` | **0.25** | fresh |
  | `"alpha beta"` → `"alpha"` (split) | **0.50** | keep |
  | `"cat"` → `"cot"` | 0.67 | keep |
  | `"the dog run"` → `"the dog runs"` | 0.92 | keep |

  So a bare threshold must land in **(0.25, 0.50]** — the split case sets the ceiling and the bug
  sets the floor, with very little air between them. **Treat prefix/word-boundary containment as
  similar regardless of length ratio** (which is exactly what a split produces) and the split case
  leaves the threshold's way, giving it room to breathe. Without that, tuning the knob later will
  silently regress split.
- ⚠ **The tests are what pin this, not the formula.** Lock all four rows of the table above
  (plus join) so the threshold can be tuned later without anyone silently regressing split/join.
  They are pure `reconcileBaseline` calls — node-testable, no DOM.

⚠ **How likely is this in practice?** It needs a delete and an add in the *same* reconcile pass, then
a re-export, then a re-import over an earlier one. Plausible, not everyday — which is why it has
never been noticed, and why it will be found late if it is not fixed deliberately.

### (original entry — the question, now answered)

Surfaced while planning the PAT one-tree model, where Seth asked whether reusing FLEx's `guid`
attribute could cause problems. For PAT the answer is no (one-way flow, PAT output never reaches
FLEx). **For the editor the path is real**, so the question stood there instead.

**What happens today**, verified by running the exporter on a doc authored entirely in the editor
with no FLEx involvement at all:

```xml
<interlinear-text guid="c3650e12-04e0-40a8-b329-42879f30e252">
  <paragraph guid="bc6a158f-bf68-4989-bae2-49f42664537f">
    <phrase guid="bb5578c3-36cd-4500-b8d8-fe7c13f5362c">
```

`makeWord`/`makeSegment`/`makeDoc` mint `crypto.randomUUID()` (flextext.js:74, :85, :96, :116),
`:273` heals any phrase arriving without one, and `pAttrs` (:421) serializes every `seg.attrs` entry
— so they go out in the XML. It dates to the initial `docs/` restructure (`811f09f`) with **no
rationale comment anywhere**.

⚠ **Do NOT stop emitting them.** Answered above: FLEx honours them, which makes guid-stable
re-import a feature the field workflow depends on. The fix is upstream, in how `reconcileBaseline`
assigns them — not in whether they are written.

⚠ **Two ways ours are weaker than FLEx's, worth knowing whichever way the answer goes:**
- A **healed** guid is minted at heal time on that device, so two devices holding the same text
  independently heal to *different* guids.
- `reconcileBaseline` pass 2 carries `attrs: old.attrs` onto a new segment by ordered fallback
  pairing, so a guid can land on text that is completely different. Ours means "this slot descends
  from that slot", not "this is the same phrase".

## Expand localization across the whole Flextext Editor Suite (Seth, 2026-08-07)
**Next, after the current settings work ships.**

Baseline as of v290: en and id are at exact key parity (1267 each) across the editor, the recorder,
the researcher panel and PAT — verified both directions, plus every CONCATENATED label expanded
(`panel.opt.<group>.<value>`, `panel.grp.<id>`, `panel.f.<k>`, `setup.off.<k>`).

⚠ The failure mode to design against: a key built by concatenation renders its own raw name when it
is missing — "panel.opt.abm.30" where a label should be. Nothing throws, and it shows up in the
SECOND language first, because that is the side nobody reads while developing. test/device-setup
now expands the setup form's prefixes for exactly that reason; whatever comes next should do the
same for the surfaces it touches rather than trusting a count of literal t('x') calls.

Open questions for that round: which languages beyond en/id; whether the id copy gets a native
review pass (much of it is mine, not a speaker's); and whether the satellites' own shell strings
(index.html in satellites/*) are in scope — they are separate from the engine's i18n.js.

## ~~Drop the "Share" send option?~~ — DECIDED: KEEP IT (Seth, 2026-08-07)

**"Don't drop share."** Closed. Share stays exactly as it is: offered where the browser supports
it, disabled-with-a-reason where it does not, and never counted as a way to get the WORK out (its
allowlist covers neither XML nor ZIP). No migration needed. The original reasoning is kept below
only so nobody re-opens this from scratch.

### (superseded — original entry)
> "Yeah, the reason for share is for one more sending route over mobile devices. We actually don't
> really need it anymore."

NOT ACTED ON — flagged mid-test-cycle rather than ripped out under Seth's feet. What removing it
would touch, so the decision is a decision and not a surprise:

- `SETUP_SEND_OPTS` in the editor, the panel's `sendOptions` field, `allowedSend()`,
  `sendCapabilities()`, `canShareFiles()` and the `setup.off.share` reason line.
- Devices in the field with `sendOptions: ['share', ...]` already stored. Dropping the option
  without a migration leaves them configured for a route that no longer exists — `allowedSend()`
  would simply not offer it, which is safe, but a device configured ONLY for share would become a
  dead end. The dead-end validator catches that on the form; it does not catch it on a device
  nobody opens the form on. A migration that adds 'save' wherever 'share' was the only route is the
  honest version.
- The researcher panel offers it to MANAGED devices, whose browsers it cannot see. Its own reason
  for existing (a phone can hand a file to WhatsApp; a desktop cannot) is exactly the mobile route
  Seth says is no longer needed — so the panel side goes with it, not separately.

Its current state is already correct-if-kept: disabled with a reason on any browser without
`navigator.canShare({files})`, and excluded from counting as "a way to get work out" because
Chromium's share allowlist covers neither XML nor ZIP.

## PARKED: Panel parity — "Written reminder" ⇒ Consent message (Seth, 2026-08-07)

**"A good idea but not mission critical. We can park that."**
The editor's Settings tab now greys the Consent message box while "Written reminder" is unticked
(`dynOff` + `setupDynOff`, v298). The researcher panel has the identical field pair
(`consentAsk` / `consentMsg`, researcher-panel.js ~line 388) and does NOT do this.

Deliberately left alone: the ask named the editor, and Seth is mid-test on both apps. The panel's
case is also genuinely weaker — its Save-blocking validator already refuses a blank message when
text is asked for, which is the guarantee the greying buys in the editor now that nothing can
block. Worth doing for consistency, not for correctness.

## PARKED: the "FlexText Editor" item in the panel's Files drop-down does nothing (Seth, 2026-08-07)

Reported during the v301 test round; parked by Seth, not investigated.

Where it is: `researcher-panel.js` → `fileMenuHtml`/its filler (~line 1250). The label is the i18n
key **`panel.dl.bundle`** = "FlexText Editor" — so it is the row for the artifact of kind `bundle`,
emitted by the `resolveArtifacts(item, null)` loop as a plain link:

    <a class="rp-dl-item" href="${f.url}" target="_blank" rel="noopener noreferrer">

⚠ NOT the "Download all" button (`data-zipall` → `downloadAllZip`), which is a different code path
and was the double-zip fixed in v301. Do not conflate the two when picking this up.

### DIAGNOSED 2026-08-07 (not fixed — still parked)

**The menu has TWO kinds of row and only one of them is authenticated.**

- The folder-listing rows carry `data-drivefile` + `data-fname` and NO real href. The click handler
  (researcher-panel.js ~1409) intercepts them and calls `Researcher.fetchDriveFile(id)` — through the
  WORKER, on the researcher's stored token. Its own comment says why: *"a plain drive URL would work
  for the owner, but this behaves identically signed in or not, and never leaves a preview page."*
- The `resolveArtifacts` rows — **including "FlexText Editor"** (`panel.dl.bundle`), plus the audio
  row and the last-upload row — are plain `<a href="${f.url}">`, where `f.url` is
  `driveLink(id)` = `https://drive.usercontent.google.com/download?id=<id>&export=download&confirm=t`.

That is a DIRECT browser request to Drive. It authenticates with whatever Google session the
researcher's browser happens to have — not the Worker token the rest of the panel uses. If the
browser is signed out, signed into a different Google account, or the file simply is not shared with
the human (uploads are placed by the Worker's own credentials), the link is dead. The Worker-routed
rows in the SAME menu keep working, which is exactly the reported shape.

**The fix, mirroring code that already works two rows away:** give the artifact rows
`data-drivefile`/`data-fname` instead of an href, so the existing handler picks them up. That needs
the file ID, which `resolveArtifacts` currently discards into the URL — so either add `id` to the
objects it returns (additive, `artifacts.js` is pure and node-tested) or recover it with
`driveIdFrom(f.url)` at the call site. Prefer the former; `driveIdFrom` on a URL we just built is a
round trip that can silently return ''.

⚠ Verify against a real panel before believing it. This diagnosis is from reading, not from a
reproduction — the sandbox has no Drive.

Also worth doing while in there: the label. "FlexText Editor" names an APP but the row is a FILE
(the uploaded bundle), which is misleading whatever the cause.

Note the label is misleading regardless of the bug: "FlexText Editor" names an APP, but the row is
a FILE (the uploaded bundle). Worth renaming whatever the cause turns out to be.


## PARKED (built, not shipped): no "delete audio" button on paired devices (Seth, 2026-08-07)

> "The other thing we don't want is the 'delete audio' button on paired devices. On unpaired devices
> it SHOULD be there." … then, before it shipped: "let's park this on our backlog and leave it."

**DONE AND VERIFIED — on branch `paired-audio-delete-gate`** (from staging, v303). Merge `--no-ff`
into staging when it is wanted; nothing else needed. Not on main, not on staging, cannot ship by
accident.

What it does: a new `canRemoveAudio(rec)` predicate gates BOTH the ✕ button and the onRemove action.
Paired ⇒ no button and the action refuses. Unpaired ⇒ unchanged. Same principle as `allowDeleteOn()`
and `deleteAllAllowed()`, which already short-circuit on `hasSession()`.

⚠ **THE OBVIOUS IMPLEMENTATION IS A TRAP** — worth reading before anyone "simplifies" it. Adding
`Sync.hasSession()` to `isAudioLocked()` is what a reviewer would suggest, and it is wrong: that
function also decides `userAudio` in `buildBundleFor`, i.e. whether the recording rides the
upload/save bundle at all. That version silently stops PAIRED DEVICES UPLOADING THEIR OWN AUDIO —
the entire purpose of pairing — and surfaces far from its cause, as "the researcher's Drive has the
text but never the recording". `test/audio-remove-gate.test.mjs` asserts isAudioLocked stays
ignorant of pairing, for exactly this reason.

Verified in a browser on one doc, both ways: visible unpaired, hidden paired, forcing the hidden
button through deletes nothing, and buildBundleFor still yields a zip containing the audio while
paired.

## Localization: the audit is done, the DECISIONS are still yours (2026-08-07)

Nothing is broken. `test/i18n-parity.test.mjs` now enforces, on every run:
- **1273 keys in en, 1273 in id, key-for-key identical**, no duplicates in either;
- no multi-word English string sitting untranslated in the id block, with a 7-entry allowlist where
  identical IS correct, each carrying its reason.

⚠ **One of those seven is load-bearing and must not be "fixed"**: `para.csvHowRow1`
("Speaker · Start · End · Text · Glosses · Free translation") is not prose — those are the LITERAL
column headings `csv.js` auto-detects, and its patterns are English-only
(`/^(speaker|participant|who|voice)$/i` and friends). Translating that sentence would instruct an
Indonesian user to type headings that will NOT be recognised, silently losing the auto-detection it
promises and dropping them into manual column mapping with no explanation.

**A real improvement available here:** teach `csv.js` the Indonesian words (penutur, mulai, selesai,
teks, gloss, terjemahan) — THEN the sentence can be translated. Do it in that order; the test's
allowlist comment says so too. Small, self-contained, genuinely useful for the field.

Still needing your decisions, which is why the rest is not started:
- which languages beyond en/id;
- whether the id copy gets a native-speaker review pass (much of it is Claude's, not a speaker's) —
  the parity test cannot judge QUALITY, only presence;
- whether the satellites' own shell strings (`satellites/*/index.html`) are in scope; they are
  separate from the engine's i18n.js and not covered by the parity test.


## The exported `.fxpa` can go stale, and nothing says so (found 2026-08-07)

Not part of the PAT split/join feature — a separate, pre-existing risk found while planning it.

Independent of split/join, and arguably overdue: the editor exports a `.fxpa` whose line ids are
positional. Any later line-count change — Enter, Backspace, or this wizard — makes a previously
exported `.fxpa` describe a document that no longer exists, and re-importing it into PAT would
attach an analysis to the wrong lines.

The editor cannot fix that file. It can, cheaply:

- stamp the exported `.fxpa` with the doc's `modified` timestamp and line count (it already carries
  a version field), so PAT can compare on import and say "this analysis was made against 47 lines;
  this text now has 49";
- warn at export time when the doc has changed since the last `.fxpa` export.

The first is the one that matters — it puts the detection where the damage would occur, in PAT, and
does not depend on anyone reading a warning in the editor weeks earlier.


## PAT → ELAN EAF export (Seth, 2026-08-07 — "to do later")

> "The other export path that's eventually planned and on the backlog is PAT → ELAN EAF (using
> annotation segments and tiers to represent paragraph, segment, word, morpheme, proposition
> groupings), but that's also a to do later plan."

⚠ **This is the answer to the durability/lock-in question the formats discussion raised**, and it
changes that conclusion: `docs/fxed-fxpa-formats-plan.md` says PAT is TERMINAL because SSA cannot
go to FLEx. EAF is the standard format that CAN hold it — tiers and nested annotations are exactly
a bracket structure — so PAT is terminal only until this exists. Worth cross-referencing when either
is picked up.

Groundwork already in place:
- `seg-exports.js` `serializeEaf()` already emits two EAF profiles (ELAN-for-FLEx and SayMore) with
  a schema-validated `.pfsx` sidecar, and `test/seg-exports.test.mjs` covers them.
- PAT already IMPORTS `.eaf`, so the reader exists.

The design question when it comes up: ELAN tiers are *typed and hierarchical* (Symbolic Subdivision,
Symbolic Association, Included In), and the mapping from an SSA bracket — which can be asymmetric
(`heads`) and can nest arbitrarily — onto that type system is the whole job. A group with heads is
not a plain subdivision, and flattening it to one would lose the asymmetry that makes it an
analysis.

⚠ Also relevant: **NO segnum in EAFs** (standing rule), and ELAN reads display settings from a
same-basename `.pfsx` — without one, ELAN's remembered `sortAlphabetically` reorders tiers wrongly.
Both already handled by the editor's exports; a PAT exporter must not rediscover them the hard way.

## Planning notes to chew on (Seth, 2026-08-07) — `.fxed` follow-ons

### ✅ DECIDED: consent material, if it exists, MUST be included
> "Consent Material if it exists MUST be included."

Supersedes the opt-out proposed in `fxed-format-spec.md` §5.1 — **remove that checkbox from the
spec when it is implemented.** The reasoning is the stronger one: an IRB record that can be
separated from the text it documents is worse than one that travels. A `.fxed` is therefore always
a file containing personal data, and the UI should say so at export rather than offering a way to
make it not true.

### Writing systems need a JS-object twin of the XML functions — and that is a real tension
> "we'd need a JavaScript object/data/browserStorage/etc version or adaptation of those functions.
> And ideally avoid having duplicate things that could diverge easily, but also JSON/browser objects
> and XML are genuinely different things when it comes to modifying/writing especially."

Both halves are true and they pull against each other, so the resolution should be deliberate:

- `surveyWritingSystems` is a READ. It can stay XML-only if the object side derives its survey from
  `text.flextext` — one implementation, no twin.
- `remapWritingSystems` is a WRITE, and this is where a twin becomes hard to avoid: the doc object
  in `fxed.json` carries WS codes too, and rewriting XML then re-deriving the object is only safe
  if the derivation is lossless. **It is not** — `parseFlextext` keeps `preservedXML`, but a
  round-trip through serialise→parse is not proven identical.
- Suggested shape: **one pure function over a WS-code map** (`{oldCode: newCode}`) with two thin
  adapters — one that walks a DOM, one that walks the object. The decision logic lives once; only
  the traversal differs, which is exactly the part that genuinely differs. Test them against each
  other on the same input.

### Multi-text `.fxed` as an OPTION — and flextext already supports it
> "having the option of multi-text .fxed is a good idea (as an option). And the flextext format
> itself already supports this."

Right — a `.flextext` holds several `<interlinear-text>` elements. So `text.flextext` inside the zip
can carry the whole set with no format change, and `fxed.json` grows from `doc`/`media` to
`docs[]`/`media{}` keyed by doc id. Worth designing v1 so the singular case is just N=1, rather than
adding a second shape later.

### ⚠⚠ WHOLE-PROFILE EXPORT, AND THE PAIRING IDENTITY PROBLEM — the important one
> "exporting an entire browser/PWA profile (corpus/library, consent prompts, settings, and all) and
> transplanting it… but we would need to think about what to do with the pairing with the researcher
> app at that point. We shouldn't have the same pairing key/identity pointing to two duplicate app
> instances. Our whole suite system needs to guard against and handle that somehow."

**This is a suite-wide correctness problem, not a `.fxed` feature**, and it exists TODAY without any
export: anything that duplicates a profile (a browser profile copy, a device image restore, a
synced browser) already clones a session. The `.fxed` spec dodges it by refusing to carry the
session at all (§5) — a whole-profile export cannot dodge it.

Three shapes, roughly in order of honesty:

1. **Move, not copy.** The export invalidates the source's session as it writes, so only one live
   instance exists by construction. Clean, and unhelpful if the source device is already dead.
2. **Re-claim on import.** The imported profile arrives UNPAIRED with its texts intact, and the
   researcher issues a fresh invite. Safe, and costs one round trip with the researcher — probably
   the right default.
3. **Server-side detection.** The worker notices two devices presenting one identity (differing
   install ids, overlapping heartbeats) and flags it in the panel. ⚠ Needed **regardless** of
   which of the above is chosen, because profile duplication happens without our involvement — and
   because the failure is currently silent: two devices would each upload, each mark texts done, and
   the researcher would see one device behaving impossibly.

⚠ Whatever is chosen, **the researcher must be able to see it and act on it.** A duplicated identity
that only the worker knows about is the same class of problem as everything else this suite has hit
this week: true, silent, and discovered late.

## PARKED: the whole Files ▾ drop-down is HIDDEN (Seth, 2026-08-08) — supersedes the row-level park below

> "The download files function is kind of all out of whack and needs more attention. I pushed it
> before it was really working. For now let's hide that drop-down and let researchers go to Google
> Drive directly until I have time to really develop that feature."

**How:** `const FILES_MENU_ENABLED = false;` in researcher-panel.js, read by `filesMenuHtml` (which
early-returns `''`, so BOTH call sites — device rows and History rows — go dark from one flag) and by
`histHasMenu()`. Flip it to `true` to bring the whole feature back.

**⚠ Hidden, NOT deleted.** `populateFilesMenu`, `latestPerKind`, `cleanupCandidates`,
`downloadAllZip`, the `data-zipall` / `data-cleanup` handlers and all their tests stay live and
correct. Do not "clean up" the now-unreachable code — it is the feature being deferred, not removed,
and deleting it turns a one-line restore into a rewrite.

**⚠ The trap that hiding it nearly sprang.** On History rows the plain audio + last-upload links were
gated on `!(e.instanceId && e.docId)` — meaning *"the menu is showing instead of me"*. Hiding the
menu without touching that gate would have left those rows with **no link at all**, silently removing
more than the drop-down. Both now read `!histHasMenu(e)`, which is tied to the flag, so hiding the
menu restores exactly the pre-menu behaviour. `test/artifact-links.test.mjs` pins this, including
that the old raw condition is gone (leaving one behind is how a row ends up empty).

**What researchers lose meanwhile:** per-file download from a text's Drive folder, Download-all, and
the older-backup cleanup. All three are reachable in Drive itself, which is the interim answer.

**Why not replace it with an "Open in Drive" link:** the per-text folder id is not in the inventory
report — the device stamps `driveFolderId` on the doc but does not send it — so a folder link would
need the same Worker round-trip the menu already makes, and a link built from anything else would be
another link that looks authoritative and may not resolve. That is the failure being backed out of,
so it is not the fix. Reporting `driveFolderId` in the inventory is the cheap enabler if a direct
folder link is wanted before the menu returns.

**When picking this back up — the design problem to solve, not just the bugs:** the menu mixes rows
of genuinely different reliability and does not tell the person clicking which is which. Folder rows
fetch through the Worker on the researcher's stored token and work. `resolveArtifacts` rows are plain
Drive hrefs authenticated by whatever Google session the browser holds. Half a menu working is worse
than none of it working, because the failure looks like the app is broken rather than like the link
was never real. v317 (branch `fix-artifact-kinds-and-fxpa-stamp`) fixes one input to that — the
device now reports which KIND it uploaded instead of the panel inferring it — and is worth keeping
regardless, because it makes the data correct for whenever the menu returns.

## PARKED: the inferred "Bundle (.zip)" row promised a zip and delivered XML (2026-08-07)

⚠ **Superseded by the entry above — the whole menu is hidden as of v318, so this row is doubly
unreachable.** Kept because the diagnosis is still the live one, and the row-level suppression is
still what protects legacy texts if the menu is ever restored before the device-side fix ships.


Seth clicked **"Bundle (.zip, includes audio)"** in the panel's Files menu and got raw `.flextext`
XML. Row suppressed in v316; the underlying bug is NOT fixed.

**Cause — a guess that artifacts.js itself predicted.** `uploadedMap()`'s legacy branch has only the
old report's `hasAudio` flag to work with, and reasons *"the device uploads a ZIP when the text has
audio attached, a bare .flextext otherwise"*. But `hasAudio` is ALSO true when the audio is a
researcher-**ASSIGNED** Drive URL the device never uploaded — Seth's text's `media-files` block
points at `connect.flextext.app/drive?src=…`. So the device had uploaded a bare `.flextext` while
the row promised a zip with audio in it.

artifacts.js already says *"only the label could mislead"* — what it got wrong was calling that
harmless. Renaming the row to "Bundle (.zip)" in v304 made the false promise louder, not the bug
newer.

**What v316 does:** the panel skips any artifact with `inferred: true`. Costs a legacy text nothing —
the folder-listing rows above it are REAL (they come from the Drive listing) and Download-all still
fetches everything. `resolveArtifacts` is unchanged, so the model still reports the artifact and
still flags it; only the UI declines to render a guess.

**⚠ THE ACTUAL FIX is on the DEVICE, not in the panel.** `uploadedMap()` already reads an explicit
per-kind `uploaded` map (`{bundle: id, 'eaf-flex': id, …}`) — the device just does not send one yet,
so every older text falls back to the scalar `uploadedFileId` and the inference. Making the device
report per-kind ids RETIRES the inference instead of hiding it, and un-parks the row for free.
⚠ Both shapes must stay readable forever: field devices update on their own schedule.

Test: `test/artifact-links.test.mjs` pins that inferred artifacts are suppressed, that EXPLICIT
per-kind artifacts still render with their Drive ids, and that the folder-listing rows and
Download-all are untouched.

## Researcher signed in on MULTIPLE DEVICES at once — investigated 2026-08-14, not built

> Seth: "Is there a reason we can't allow the researcher to be logged into multiple devices at once?"
> Then: "I'd need to coordinate with all of my users for a planned outage for this, I think." And:
> "that would be the time to implement the project/researcher division."

**There is no cryptographic or architectural reason. It is ONE COLUMN.** `researcher.secret_hash`
holds a SINGLE session secret (written on sign-in, `worker/src/v1.js` ~1034; checked by
`authResearcher`, ~324). Signing in on device B overwrites it, so device A's next call 401s. Kr — the
data key — is **server-held and re-fetched on every sign-in**, memory-only on the client, so a second
device is entitled to everything it needs. Nothing in the E2EE design assumes one device.

### ⚠ THE HIDDEN COST IS NOT DOWNTIME — it is that the column has TWO JOBS

`researcher.secret_hash` is the session token AND the password hash for the legacy email login path
(`v1.js` ~924, `bad_login`). Any session work must separate those two meanings first, or it fixes
sessions and breaks password login in the same commit. **That, not the schema move, is the real
work.**

### An outage is probably NOT required for the sessions change alone

- **Field devices never touch it.** They authenticate through `authInstall` against the `install`
  table's own secret — a different table. Nothing a village user holds would notice.
- **The panel client does not change.** It sends `x-fx-researcher` + `x-fx-secret`; the token format
  is unchanged. Only the worker's LOOKUP moves — no editor release, no deploy-order hazard.
- **The migration is additive** (`CREATE TABLE researcher_session`). An old worker does not know the
  table exists; a new worker dual-reads (new table + legacy column) so existing sessions survive and
  rotate naturally. A later quiet deploy drops the legacy path.

### Decide before writing any of it

- **Sign-out semantics change, and that is a SECURITY question.** Today sign-out is global — one
  click kills every session, which is a real panic button for a lost laptop. Per-session sign-out
  removes it silently unless a session list + "sign out everywhere" ships alongside.
- **The audit log gains a question it cannot currently answer** ("which session did this?"). Cheaper
  to record now than to backfill.

### ⚠ SEQUENCE IT WITH THE PROJECT SPLIT, NOT BEFORE IT

Seth's own instinct, and it is right: sessions become "researcher × project" the moment projects
exist, and the table wants that shape from the start — the same retrofit warning the sharing entry
below already makes about an actor column. The project split is the harder animal and the one that
genuinely deserves planning:

- devices are paired to what is TODAY a researcher account and must migrate to a project **without
  re-pairing** — a field device needing re-onboarding IS the outage everyone is trying to avoid;
- the E2EE key becomes per-project and must be re-wrapped (real key management, not a schema move);
- the panel becomes project-scoped throughout, so THAT is a client release with worker-first ordering.

Done well, even the split should not need a user-facing outage — but that is the one claim I would
want **proved against a copy of D1** before promising it to anyone, rather than reasoned.

## FUTURE: multiple researchers sharing ONE project / panel (Seth, 2026-08-13)

> "Can we also make a way for a researcher to invite other Google users to be able to access their
> researcher account? … A way for multiple researchers to collaborate and share a project/researcher
> panel."

### ⚠ THE PREREQUISITE IS A DATA-MODEL SPLIT: PROJECT ≠ RESEARCHER (Seth, 2026-08-14)

> "Currently those are one and the same. But in a near future release, we want researchers to be able
> to manage multiple projects and also be able to invite other researchers to help manage one or more
> of their projects. But that's later."

So the shape is **researcher ↔ project is many-to-many**, in BOTH directions — one researcher, many
projects; one project, many researchers — and everything below (keys, Drive, roles, audit) hangs off
the PROJECT once it exists as its own thing. Today "the project" is implicitly the researcher's
account: one Ki, one Drive, one settings blob, one device fleet. The split is the schema work:

- **A device pairs to a PROJECT, not to a researcher** — this is already the right instinct in the
  constraint list below ("a field device is paired to a PROJECT; who administers it is not the
  device's business"), and the split is what makes it literally true. Existing pairings must migrate
  as "this researcher's implicit project", invisibly to every field device — a device must never
  need re-pairing because its researcher reorganised their projects.
- **The E2EE key becomes a PROJECT key**, wrapped per researcher — which is the same machinery the
  invite feature needs anyway (below). One researcher with three projects holds three wrapped keys.
- **The Drive question below multiplies**: per-project folders in whose Drive? The per-text folder
  dedupe contract (v167) is per-upload-target, so it survives, but the panel's storage-footprint
  reporting becomes per-project.
- **The panel grows a project switcher**, and every panel surface (texts, devices, assignment queue,
  history) becomes project-scoped. Worth grepping the panel for anything keyed on the account where
  it should key on the project — settings pushes especially, since a settings link encodes what will
  become project state.

⚠ **This is NOT the approval flow that already exists.** Today an OWNER approves people who sign in
(`panel.pending.*`, `/v1/researcher/approvals`, `logApproval()`), and the panel's own wording states
the outcome plainly: *"Each approved person gets their own separate console."* Approval creates a
PEER, not a collaborator. Sharing one project is a different feature with a different data model, and
anyone picking this up should read that string first so they do not mistake one for the other.

### The two hard constraints, and they are both load-bearing

**1. ⚠ THE METADATA IS E2EE.** D1 holds ciphertext; the worker cannot read device inventories,
nicknames or settings by design (`crypto.js`, `researcher.js`). So a second researcher cannot simply
be granted a database row — they need the KEY. That makes this a key-management feature wearing a
permissions feature's clothes:
- the project key has to be re-wrapped to each invited researcher's own identity (the escrow
  machinery in the auth plan is the nearest existing precedent — see
  `docs/connectivity-auth-plan.md`);
- **revocation is the part that will be got wrong**: removing someone's access does not un-know the
  key they already held, so a genuine revoke means re-keying the project and re-wrapping for everyone
  who remains. Decide up front whether "remove" means *revoke future access* (cheap, honest if said
  plainly) or *rotate* (expensive, and the only one that is actually a revocation).

**2. ⚠ WHOSE GOOGLE DRIVE?** Uploads land in the RESEARCHER'S own Drive on their OAuth token, and the
`drive.file` scope means an app can only ever see files IT created. A second researcher signing in
with their own Google account therefore **cannot see the first researcher's uploads at all** — not a
permissions problem we can fix, a scope boundary. Options, none free:
- the project keeps ONE Drive owner and collaborators act through that owner's token (simplest;
  concentrates quota and liability on one person — see the storage-footprint entry above);
- a Shared Drive, which changes the folder model and the quota story;
- per-researcher Drives with the manifest as the join, which multiplies the dedupe problem v167 just
  fixed.

### Worth deciding early, because they change the schema

- Roles: is an invited researcher equal to the owner, or read-only / no-delete? The panel already has
  destructive actions (Drive purge, remove-from-device) that a collaborator may not should have.
- Does the audit log record WHICH researcher did each action? Today `logApproval()` is append-only and
  owner-scoped; with several people acting on one project, "who removed this text" becomes a question
  the log must be able to answer, and retrofitting an actor column later is worse than adding it now.
- ⚠ The device side must not learn about this. A field device is paired to a PROJECT; who administers
  it is not the device's business, and leaking a researcher list into an inventory report would put
  personal data on every device.

## LATER RELEASE: pause / resume / CANCEL for panel downloads AND uploads (Seth, 2026-08-13)

> "I mean the researcher panel needs that machinery as well. The editor already has it. And smart
> chunking and pause/resume support, etc."
>
> then, scoping it: *"We do need to work on the modifications for the worker that would allow us to
> add pause/resume/cancel support to the Researcher Panel downloads and uploads. But that's for a
> later release."*

### ⚠ THE ASYMMETRY THAT SHOULD DRIVE THE PLAN: uploads are ALREADY resumable, downloads are not

This was checked in the code, not assumed, and it splits the work in two very unequal halves:

| | wire protocol today | what pause/resume/cancel needs |
|---|---|---|
| **UPLOAD** (`assignUploadChunk` → `relayDriveChunk`) | **already chunked AND resumable.** `x-fx-range: bytes N-M/TOTAL`, a **`bytes */TOTAL` PROBE** that asks the server how far it got, `308 → {done:false, received}`, `200 → {done:true,fileId}`, `session_gone` for a dead session. That is the Google resumable protocol, already relayed. 33 MB chunk cap. | **mostly CLIENT work.** The client can already ask "where did we get to" and continue from there. Pause = stop issuing chunks. Resume = probe, then continue. Cancel = stop and abandon the session. |
| **DOWNLOAD** (`GET /v1/researcher/drive-file/<id>`) | single unranged GET; fetches Drive `?alt=media` and returns `new Response(g.body)`. **No Range forwarded, no Content-Range returned.** | **a WORKER change** — forward `Range`, return `206` + `Content-Range`, and add `Access-Control-Expose-Headers`. |

**So the upload half needs little or no worker change and could ship in an ordinary editor cycle;
only the download half is gated on a worker deploy.** Worth splitting when this is picked up rather
than treating "pause/resume/cancel" as one indivisible feature — they are not.

⚠ **CANCEL is the one that needs a decision, not just code.** For an upload it should also release
the Drive session server-side rather than leaving it to expire, or a cancelled 200 MB upload silently
occupies a resumable session (and possibly partial Drive bytes) until Google times it out. That is
the piece most likely to need a new worker route, so scope it with the download change rather than
assuming cancel is free because pause and resume are.

### What v349 already shipped, so nobody rebuilds it

The activity tray and real streamed byte progress (`fetchDriveFile(fileId, onProgress)` reading
`response.body`). The tray already has a per-job row and a status line — it is the natural home for
pause/resume/cancel controls, so this feature is mostly *adding buttons to a surface that exists*.

**v348 shipped the VISIBLE half only** — an activity tray plus real streamed byte progress
(`fetchDriveFile(fileId, onProgress)` reads `response.body` instead of awaiting `.blob()`). That
needed no worker change. **Chunking and pause/resume are NOT built**, and the reason is a hard
dependency, not an oversight:

⚠ **`GET /v1/researcher/drive-file/<id>` does not support Range.** It fetches Drive with `?alt=media`
and returns `new Response(g.body)`, forwarding no `Range` header and returning no `Content-Range`. So
a resumable, chunk-retrying download from the panel is **blocked on a worker change** — which means
this rides the D1→worker→client release order rather than an editor cycle.

Two smaller worker facts found at the same time, both worth fixing in the same change:
- `v1Cors` sets **no `Access-Control-Expose-Headers`**, so a browser cannot read `content-length` from
  that endpoint. v348 works around it by taking the denominator from the Drive listing the panel
  already holds. Exposing `Content-Length`, `Content-Range` and `Accept-Ranges` would remove the
  workaround. (`worker/src/index.js` already exposes exactly these on the `/r2/` route — copy it.)
- The R2 route (`index.js`) *does* implement Range properly and is the model to follow.

⚠ **Do NOT simply reuse `AudioDownload` (docs/js/audio.js) as-is.** It is the right *engine* —
AIMD chunk sizing (`RELAY_CHUNK_FIRST/MIN/MAX`), per-chunk retries, `pause()`/`resume()`/`reset()`,
generation counters that invalidate superseded loops — but it is built for a DEVICE caching audio
for a doc: it is keyed by `docId`, persists every chunk to IndexedDB, checks storage quota, and
`_complete()` writes a **media record**. A researcher downloading forty texts does not want 200 MB of
each one written into their browser's IndexedDB, and the panel's destination is a file on disk, not a
doc's media slot.

**The shape that fits the core design principle** ("modularize what is app-specific, generalize what
is shared"): lift the TRANSFER loop — ranged chunk fetching, AIMD sizing, retry, pause/resume — into
a small shared module with a pluggable **sink** (IndexedDB chunks for the editor, an in-memory array
for the panel) and a pluggable **fetcher** (the relay for the editor, `/v1/researcher/drive-file` for
the panel). ⚠ Generalise on the second use, which this is — but the editor's path is field-critical
and auto-updates, so the refactor needs its own tests before either caller moves onto it.

## ~~segmentation on/off PER TEXT~~ — CANCELLED (Seth, 2026-08-13)

> **"Actually, we don't need the per-text setting. That's not worth doing. It's too much trouble.
> And no gain. For a single user one-time case."**

Closed the same day it was scoped. Segmentation stays a **device** setting.

⚠ **The reasoning is the durable part, so record it rather than just the verdict:** the whole feature
existed to serve ONE user's ONE-TIME migration — a person with in-progress texts to finish the old
way while new texts came the new way. That is a situation that resolves itself as he works through
his backlog, and the cost was a worker deploy, a new command type, an engine change, a panel control,
engine-version gating, and a live-flip hazard on open documents that can destroy typing. Permanent
machinery, with its own permanent failure modes, for a temporary problem. If this is ever re-proposed,
the question to ask first is whether the situation is still one-off — not whether the design works,
because the design was fine.

Kept rather than deleted so it is not re-proposed from scratch — and because three findings below are
about the SUITE, not about this feature, and stay true:

- **`setDone` is the template for ANY per-text command the researcher changes after assignment**
  (panel `pushCommand` → worker type whitelist → `syncDispatch` → the device's own local handler, so
  a pushed change behaves exactly like a local tap). Whatever the next per-text property turns out to
  be, this is its shape.
- ⚠ **A new command type is a WORKER change.** `worker/src/v1.js:1651` whitelists command types and
  returns `400 unknown_command` otherwise, so any new one rides the worker→engine→panel release
  order. Easy to miss when the feature otherwise looks client-only.
- ⚠ **Old devices ignore an unknown command safely but silently** (`syncDispatch` `default:` is a
  `console.warn`, no throw, still acks) — so the PANEL must engine-gate the control, or the
  researcher sets something, sees nothing happen, and concludes it is broken.

Everything below is the original entry, superseded.

### (cancelled — original entry)

> "audio segmentation enabled is a device setting, but I'd like the researcher to be able to enable
> or disable it for individual texts. Is there a way we can do that?"

**Yes, and the mechanism already half-exists.** `segmentationEnabled()` (app.js) is already a
three-way resolution, not a bare setting read:

```js
if (new URLSearchParams(location.search).get('segmentation') === '1') return true;
return settings.segmentation !== false;
```

So a per-text override is one more rung on a ladder that is already there:
`doc.segmentation ?? urlOverride ?? settings.segmentation !== false`. The assignment already carries
per-text fields (`Researcher.assign(instanceId, docId, fields)`), so the researcher's choice rides
the same path as every other per-text setting.

🔒 **CONFIRMED (Seth, 2026-08-13): "Texts that don't already have that setting set individually
should follow the current editor default when our update pushes through."** So ABSENT means INHERIT,
never "off" — and that is a migration-safety property, not a preference: every text in the field
today has no per-text value, so a default of anything other than "inherit" would silently flip the
mode on all of them the moment the update lands. `??` (not `||`) is the operator, because `false` is
a legitimate stored value meaning "this text, explicitly off".

### The mechanism: a per-text COMMAND, exactly like `setDone` (answered 2026-08-13)

> Seth: "I want it to be something the researcher can set or change for texts that are **already
> assigned**, rather than only on first assignment. My use case … is my own user who has a whole lot
> of texts he's already done some work on for which audio segmentation is a mess. And I'd rather let
> him finish what's on his plate the old way, but I want new texts I send him to use the new way. But
> I've got other users who have started using it the new way. **And I don't want to break their
> setup.**"

**Nothing new has to be invented — `setDone` is already this exact shape**, and it is the model to
copy line for line:

| piece | `setDone` today | `setSegmentation` |
|---|---|---|
| panel → worker | `pushCommand(instanceId, 'setDone', { docId, done })` (researcher.js:516) | `pushCommand(instanceId, 'setSegmentation', { docId, segmentation })` |
| worker | type whitelist, `v1.js:1651` | ⚠ **add the type there — see below** |
| device | `syncDispatch` case → `setDocDone(docId, done)` (app.js:3397), reusing the device's OWN local handler so a pushed change behaves identically to a local tap | same shape: set the per-doc field, persist, no other path |

So it is per-text, it is changeable **at any time after assignment**, and it is independent of
`assign` — which is precisely what Seth asked for.

**⚠ ONE WORKER CHANGE IS REQUIRED, and it gates the release order.** `worker/src/v1.js:1651`
whitelists command types and returns `400 unknown_command` for anything else, so the panel cannot
push `setSegmentation` until the worker knows it. Order: **worker deploy → engine → panel.** (No D1
migration — the command queue is generic.)

**Old devices are safe by construction**: `syncDispatch`'s `default:` branch is
`console.warn('sync: unknown command', …)` — it does not throw and the command still acks. A device
on an older engine therefore ignores the flag and keeps its device default, which is the correct
fallback. ⚠ But the RESEARCHER must be told it did not take effect: gate the control on engine
version the way the Done toggle already does (`engNum >= …`, researcher-panel.js), or they will set
it, see nothing happen, and reasonably conclude the feature is broken.

### Three states are what make Seth's two populations coexist

`true` / `false` / **absent = inherit**. The third state is not tidiness — it is the whole answer to
*"I don't want to break their setup"*: every text on every device today has no value, so the users
already working the new way are untouched **by construction**, not by remembering to leave them
alone. Use `??`, never `||`, because `false` is a legitimate stored value meaning "this text,
explicitly off".

### ⚠ WHICH DIRECTION TO USE FOR THE MESSY-TEXTS USER — the recommendation, and why

Two ways to get his result, and they are NOT equally safe:

- **(a) RECOMMENDED — leave his device default OFF (old way); set `segmentation: true` on each NEW
  text as you assign it.** His existing in-progress texts need no action at all.
- **(b) Flip his device default ON; set `false` on each of the existing texts.**

Choose by the cost of FORGETTING one, because that is the mistake that will actually happen:

| forgotten in… | what the user experiences |
|---|---|
| **(a)** | a new text opens the old way — mildly annoying, fixed by one command, no work at risk |
| **(b)** | a text he is **part-way through** silently switches to the new mode — exactly the outcome being avoided, on exactly the texts described as "a mess" |

(a)'s failure is cheap and (b)'s is the thing we are trying to prevent, so (a) wins even though (b)
needs fewer future actions. A bulk "set all current texts to X" would make (b) tolerable, but it is
not needed for (a) and should not be what the design depends on.

### ⚠ THE TRAP, and per-text makes it worse in a NEW way

`segmentationEnabled()` is currently a near-constant during a session: it changes only when the
researcher pushes a settings change. Per-text means it flips **every time the user opens a different
text** — and, now that it is a COMMAND, it can also flip **while the user is typing in that very
text**, arriving from the network unannounced. That is a genuinely new hazard: today no remote event
can change the editing mode of an open document.

The CLAUDE.md warning about `applyBaseline` exists for exactly this shape:

> `applyBaseline` is gated on DOM truth (`#baseline-text` hidden ⇒ skip), NOT on
> `segmentationEnabled()` — during a live settings flip the setting changes before the DOM, and the
> setting-based guard read the hidden empty textarea and WIPED the doc's text.

That bug cost a doc's text ONCE, on a rare researcher-initiated flip. Per-text makes the same race
available on every text open. So before building this: audit every `segmentationEnabled()` call site
for whether it is asking "what mode is the DOM in right now" (must stay DOM-gated) or "what mode
should this text be in" (may read the new resolution). They are different questions and the current
code does not have to distinguish them, because today the answer rarely changes.

🔒 **THE SAFETY RULE THAT FALLS OUT OF IT: a `setSegmentation` command MUST NOT re-mode a document
that is currently open.** Store the new value and let it take effect on the next open of that text.

The reasoning is not caution for its own sake — it is the one path in this feature that can destroy a
field worker's typing. Re-moding an open doc means tearing down the strips or the textarea underneath
someone mid-sentence, which is the exact live-flip sequence that already wiped a doc's text once, and
here it would be triggered remotely, with no local action to correlate it with and nothing on screen
explaining why. Deferring to next open costs the researcher nothing (they are changing how the NEXT
session on that text behaves) and removes the whole class.

⚠ Corollary for the panel: after pushing the change, the row should say it applies **when the text is
next opened**, not imply it has already happened — otherwise the researcher watching a device that is
mid-edit will think the command failed.

## FUTURE (soon): oral transcription + oral back-translation, and the format problem (Seth, 2026-08-13)

> "we'll be looking to add the option for other analysis languages (most commonly English) and for
> slow-speech oral transcription and maybe oral back translation, similar to what SayMore allows.
> All of those would be options enabled or disabled by the researcher. And actually once oral
> transcription and back translation are available, eventually the researcher can disable the
> glossing and written free translation. Maybe."

**The UI Seth specified:**
- **Slow-speech oral transcription** — a record button **on each line/segment** on the **Baseline**
  tab, marked with a **turtle**. ⚠ "joining or splitting will delete it, with a warning to the user"
  — the recording is bound to a line, and a line that splits is no longer that line.
- **Oral back-translation** — a record button **immediately left of the free-translation box** on the
  **Gloss** tab.
- Both **researcher-enabled**, off by default, like every other capability in this suite.
- Additional analysis languages (English most commonly) are the third leg of the same feature set.

**⚠ The format problem, and Seth's proposed answer.** `flextext` has no place for per-line audio.
His suggestion, which is the right shape:

> "MIGHT be we can add our own way, whether the filename will match a line guid (which our app does
> generate) `<phrase-guid>.slow.<ext>` or `<phrase-guid>.<lang/ws.code>.<ext>` and then have a sub
> folder for `oral/` with those files and a manifest for those files in it (that helps map them to
> the correct lines when we run an ELAN or SayMore conversion either downloading/saving from FlexText
> Editor directly or generating from Researcher)."

Why that is well-chosen, and what to watch:
- **It reuses the phrase `guid`, which the app already mints and FLEx already honours.** That is the
  one identifier that survives a round trip through FLEx, so the mapping is not ours to maintain.
- ⚠ **But guid stability is a KNOWN OPEN BUG** — see "a deleted line's GUID gets adopted by an
  unrelated new line" in this file. Today a delete-plus-add in one reconcile pass can move a guid
  onto different text. Binding AUDIO to guids makes that bug louder: a recording would reattach to
  the wrong line rather than merely mislabelling one. **The similarity gate should land before, or
  with, this feature** — the two are now coupled, which neither entry knew when it was written.
- **A sibling manifest in `oral/` is consistent with the v3 design**: `flextext-manifest.json`
  already exists to make a folder self-describing rather than name-sniffed. Same rule applies —
  readers ignore unknown keys, and the manifest is what the ELAN/SayMore converters read.
- The `<guid>.<ws-code>.<ext>` variant generalises to the extra analysis languages for free, which is
  probably why it should be preferred over a bare `.slow.` marker — one naming scheme, several uses.

## FUTURE: a standalone audio segmentation / matching app (Seth, 2026-08-13)

> "We also need to build that audio segmentation/matching app that can be used just for segmenting
> and matching audio to existing flextext files."

The engine for this largely EXISTS — `segments.js` (the time-span model and its ordering
invariants), `segment-strips.js` (the strip UI and peaks) and `seg-exports.js` are already separate
modules, and the parked `parked-panel-and-matching` branch holds the Audio Matching mode (v323/v324)
that was pulled off staging because it auto-entered on opening any unaligned text. So this is closer
to "another face on the same engine" — the suite's core pattern — than to new construction.

⚠ Read the parked-branch entry before starting: that mode was parked for a UX reason (it interrupted
every unaligned text), not because it did not work. A standalone app is precisely the place where
auto-entering IS correct, which may be the real resolution of why it was parked.

## Native audio conversion as a fallback — ON THE DEVICE, not in the panel (Seth, 2026-08-12)

> "Also let's make a backlog note to consider building that feature into the Electron shell as a
> fallback when the browser-based conversion doesn't work. Most of the time files won't be that
> huge."
>
> then, narrowing it: *"for the Researcher Panel, we're not planning to build a native shell at all.
> So forget that."*

⚠ **So this is NOT about the panel's export conversions.** `plans/oversize-conversions.md` settles
those in the browser alone: above the ceiling the panel ships the original audio, emits a text-only
`.fxpa`, and refuses only the preview. No shell, no stub, no capability negotiation. Anything that
reads this entry as licence to add a native path to the panel is misreading it.

**Where it does belong: the DEVICE-side decode**, which is both older and more consequential.
`app.js` `segWorkingMedia` runs `decodeAudioData` + `encodeWav` inline **on the field device** to
build the `segwav:` working copy for every lossy recording in segmentation mode, and already ends in

```js
} catch { return media; }   // undecodable → play the original; alignment caveat stands
```

That is the same degradation the panel is getting — but on a **phone**, where memory is tightest,
and where the cost of falling back is real: the ~44 ms AAC priming offset means the segmentation the
field worker is doing is quietly misaligned against the audio they hear. A native converter fixes it
exactly where it hurts. The researcher's browser was never the interesting case.

Constraints for whoever picks it up:

- ⚠ **The native boundary is one file for BOTH bridges.** `check-native-containment.sh` greps
  `docs/js/` for `window.Capacitor|Capacitor.Plugins` **and** `__flextextNative`, failing on any hit
  outside `docs/js/native-audio.js`. Electron is under the same rule as Android — not a looser one.
- ⚠ **Gate on CAPABILITY, never on platform.** The engine auto-updates; the APK does not. Being
  inside Capacitor says nothing about whether the installed plugin can convert. A
  `isNativeShell() ? offload() : fallback()` gate would ask every pre-feature field APK to convert,
  fail, and lose the fallback that would have worked — surfacing only on the oldest devices in the
  field. Use the async `nativeCapabilities()` / `EXPECTED_CONTRACT` negotiation that already exists,
  and treat "unknown" as no.
- ⚠ **Output must stay byte-identical to the browser's.** `seg-exports.js` is a pure format module
  precisely so one implementation produces the EAF/pfsx/preview/`.fxpa` everywhere; a second
  generator would be the "two code paths producing 'the ELAN export'" drift that
  `prepareConversionSources` was extracted to prevent. Call the same module with a streaming source.
- Touching `native-audio.js` means **rebuild and re-test the APK** (CLAUDE.md). That is this work's
  own release, never a side effect of an editor or panel feature.

⚠ **Sizing, so nobody over-builds it:** Seth — *"Most of the time files won't be that huge"*, and the
recording that surfaced all this was **deliberately bloated to test upload chunking**. A fallback
for the tail, not a second main path.

## Documentation: answer "does it save when I leave a text?" — FAQ *and* in situ (Seth, 2026-08-12)

> "When we update our documentation, our documentation will need to answer this question (maybe as
> an FAQ, but also in situ in the appropriate part): *'Oh yeah. I know it auto saves at intervals but
> does it also save when you go out from one text to the main screen? So that I can quit the program
> without worrying about losing work?'*"

**The answer is YES** — verified in `docs/js/app.js`, not assumed:

- `#btn-back` (the editor's Back control) runs `applyBaseline()` then **`await persist()`** before
  `show('texts')`. The write completes before the list appears.
- Ordinary typing autosaves on a 400 ms debounce (`schedulePersist`), and the baseline textarea also
  commits on `blur`.
- The visible **Save** button is a deliberate no-op reassurance: it flushes and toasts
  "✓ Saved automatically — your work is safe" (`toast.autoSaved`). Its comment says why it exists —
  so the Save reflex never triggers an upload.
- A pending service-worker update flushes `persist()` before it reloads (`applyUpdateIfSafe`,
  `forceApply`).

⚠ **The subtlety worth writing down for whoever edits this code, not for the user:** `persist()`
deliberately SKIPS the full doc write while `#view-texts` is visible. So Back is correct *because*
it persists **before** `show('texts')`. Reordering those two lines would silently turn "saves when
you leave" into "discards when you leave", and it would look like a tidy-up. Worth a test.

Where it needs to appear:
- **In situ** — `help.html` (i18n.js) currently says only *"Your work is saved automatically on this
  device — you can close the app and continue later from the Texts list."* That is true but does not
  answer the question actually asked, which is about the **moment of leaving** and about **quitting
  safely**. Say both: leaving a text saves it, and quitting afterwards is safe.
- **FAQ** — same answer, phrased as the question.
- Both in **en and id**, per the standing rule.

## Engine-wide drift is worth watching — and modularisation (Seth, 2026-08-07)

> "Latent drifts like that (engine wide things that are in the editor code) are worth keeping an eye
> on. Modularizing our code (shared, engine, various apps, etc) is worth thinking about doing as it
> makes sense (but carefully, and well planned/tested first)."

**The live example, found in the v315 release audit:** v305 made the editor's language picker derive
from `LANGS`, but `setup()` returns early for `RECORD_MODE` **before** `fillLangPickers()` runs — and
`satellites/text-recorder/index.html` and `satellites/crowd-recorder/index.html` each carry their own
`<select id="lang-select">` with hardcoded `en`/`id` options. Nothing is broken today because
hardcoded en/id happens to equal `LANGS` exactly. The moment a third language completes, the editor
gains it and the recorders silently do not — the gating rule leaking round the side.

That is the shape to watch for: **a rule enforced in `app.js` that the satellites reach by a
different path, or not at all.** Others of the same shape worth auditing when this is picked up:
`applyI18n` coverage, `allowedButtons`, and anything gated on `RECORD_MODE`/`CROWD_MODE` early
returns.

On modularisation: the honest constraint is that `app.js` is BOTH the editor and the satellites'
engine, and the early-return-per-mode pattern is how one file serves four apps. A split (shared
core / editor / recorder / crowd) would make drift structurally visible rather than something to
remember — but it touches every sw.js SHELL and the v108 outage is what happens when that goes
wrong. Plan and test first, exactly as Seth says.

## Google Drive storage footprint — especially for less-well-resourced users (Seth, 2026-08-12)

> "At some point we may have to think about storage space on Google Drive especially for
> less-well-resourced users."

**Why it is newly urgent:** the assign-by-upload v2 restructure deliberately traded bytes for a
consistent folder shape. Every text now lands its FULL original audio in `<Storyname>/originals/`
(previously a recorded text's audio was sealed in one bundle zip and an assigned text's audio was
never uploaded at all), plus a manifest, plus the consent artifacts. The per-text footprint went UP,
and it is the audio that dominates — a 24-bit WAV recording is roughly 8 MB/minute. A researcher on
a free 15 GB Google account shares that quota with Gmail and their own Drive, so a few dozen
recorded texts can fill it, and the failure mode is a device retrying an upload forever against a
quota error it cannot fix.

Things worth weighing when this is picked up (nothing decided):

- **Nothing here is a duplicate today, so dedupe is not the lever.** The originals are the archival
  copy; the derived WAV and the seg exports were deliberately taken OFF uploads in v3-era work
  (Lane B is the bare `.flextext`; the Downloads menu builds conversions on demand). The remaining
  growth is real source material plus the `.flextext` backup-copy pileup.
- **The backup-copy pileup is the cheap win.** Lane B uploads a timestamped `.flextext` per
  auto-backup, and they accumulate forever. `cleanupCandidates` already computes exactly the older-
  than-newest set and already refuses to touch assignment-role files — today it is a manual menu
  action. An automatic or prompted retention rule (keep N, or keep newest + weekly) would reclaim
  most of it with machinery that already exists and is already tested.
- **Quota needs to surface as a real state, not a retry loop.** A Drive 403 `storageQuotaExceeded`
  is PERMANENT for the device — it must classify like the expired-token 401 (stop, report), and the
  panel should be able to say "this researcher's Drive is full" rather than showing an upload that
  never lands. That is the piece that actually protects a field worker's day.
- **Lossy archival is a Seth decision, not an engineering one.** Offering a compressed upload lane
  would cut the dominant cost by ~10x, but it contradicts the archival stance the native apps exist
  to serve (see the `js/native-audio.js` boundary and the bext honesty rules). If it is ever offered
  it must be an explicit researcher choice, named as lossy, and never the default.
- **Whose Drive is it?** Uploads land in the RESEARCHER's Drive via their OAuth token, so the quota
  that runs out is theirs, not the device owner's — which is also why the device cannot resolve it
  and why the panel is the right place to show it.

### Yes — the Drive API supports both halves, and `drive.file` scope splits them cleanly (asked 2026-08-12; FUTURE RELEASE, not scoped now)

**Displaying quota: fully available, no scope problem.** `GET /drive/v3/about?fields=storageQuota,user`
returns `{ limit, usage, usageInDrive, usageInDriveTrash }` (bytes; `limit` is absent on unlimited
pooled accounts — treat missing as "no limit", never as zero). It reports on the USER, not on files,
so our `drive.file` scope is enough — no broader consent screen, nothing new for a researcher to
approve. That is one worker endpoint and a panel readout: "Drive: 11.2 GB of 15 GB used."

**⚠ The finding that matters most, and it is free to fix:** `usageInDriveTrash` is counted INSIDE
`usage`. Our existing cleanup (`Researcher.trashFiles`) moves files to trash — deliberately, so a
mistake is recoverable for 30 days — which means **today's "cleanup" reclaims no space at all until
the trash is emptied.** A researcher who is out of quota and dutifully runs cleanup will see nothing
change and reasonably conclude the feature is broken. Showing `usageInDriveTrash` beside the total,
with an explicit "empty trash to reclaim" action (`files.emptyTrash`, or per-file `files.delete`),
turns that from a silent no-op into the actual remedy.

**Cleanup: bounded by `drive.file` — and that boundary is a feature.** The scope means the app can
only list, trash or delete files IT created, so a storage tool built on it can never touch a
researcher's unrelated Drive contents even by mistake. Practically:
- `files.list` with `fields=files(id,name,size,quotaBytesUsed,modifiedTime,appProperties)` — note
  `quotaBytesUsed` is the field that actually charges the quota (it differs from `size` for some
  file types), and `orderBy=quotaBytesUsed desc` gives a biggest-first list for free.
- The per-text machinery already exists and is already tested: `cleanupCandidates` computes exactly
  the older-than-newest backup set and already refuses assignment-role files. What is missing is an
  ACCOUNT-WIDE view over it rather than one text at a time.
- What it cannot do: report or clean anything outside FlexText's own files. So the readout should
  name that honestly — "FlexText is using 3.1 GB of the 11.2 GB on this Drive" — rather than
  implying the app can tidy Gmail attachments or the researcher's own documents.

**Sequencing note for whoever builds it:** the quota readout is worth having BEFORE the retention
rules, because a number the researcher can watch is what makes a retention policy legible — and
because the write half (`storageQuotaExceeded` classified permanent, per the entry above) is what
stops a device retrying forever, which is the part that actually costs a field worker their day.

## NEXT CYCLE (Seth, 2026-08-12): a Drive-side text inventory modal — list, remove, Files ▾

> "We also should build a modal or a text list that shows Texts that are on the Google Drive folder.
> That should be easy to inventory now. And all have a 'Remove from Google drive' (which asks the
> user if they're sure they want to move it to their Google Drive trash folder), and also a 'Files'
> menu with the same behavior as anywhere else — download options if a manifest file is present,
> 'Open in Google Drive' if not."
>
> "That's also NEXT release cycle, not this one."

**Why it is genuinely easy now, and was not before.** The panel's existing text lists are keyed off
DEVICE INVENTORY — they show what a device currently reports holding. A text uploaded and then
deleted from the device disappears from the panel even though its Drive folder is still there, and
that gap is exactly what a researcher cannot see today. The v2 restructure makes the Drive side
enumerable in its own right: every text is `FlexText Uploads/<Device>/<Storyname>/`, tagged
`flextextDoc=<docId>` (v1.js `driveEnsureTextFolder`), so listing text folders is a tag search, not
a filename guess. The v3 manifest then names each one without opening anything.

**What it needs (nothing here is a redesign — it is assembly):**
- ONE additive worker endpoint: list the text folders under an instance's device folder(s), each
  with `{ folderId, docId, title, modified, hasManifest }`. Additive ⇒ straight-to-prod eligible
  under locked decision 9. Reuse `driveEnsureDeviceFolder` + the same tag search shape.
- The Files ▾ control is already renderable anywhere (`filesMenuHtml(instanceId, docId, …)` is
  deliberately independent of device rows — History entries already use it), and after v3 its body
  is manifest-driven, so "download options if a manifest is present, Open in Drive if not" is
  ALREADY the behaviour. The modal reuses it verbatim; no second menu.
- "Remove from Google Drive" is `Researcher.trashFiles([folderId])` with a confirm — the same call
  and the same 30-day-recoverable trash semantics the History row's folder removal already uses
  (`data-histclean`). Copy that confirm's wording: it already says trash, not delete.
- ⚠ Pair it with the storage-quota readout above. A "remove" that trashes does NOT free quota until
  the trash is emptied, so an inventory screen with removals on it is exactly where a researcher
  will expect the space to come back — and where the surprise will land if it does not.

**One judgement call to make when building it:** whether this modal replaces, or sits beside, the
per-text Files ▾ on device rows. Beside, probably — the device row answers "what is on this device",
the modal answers "what is in my Drive", and after v3 those are legitimately different questions.

### Same cluster, same cycle: an "unassigned" holding place, and moves in BOTH directions (Seth, 2026-08-12)

> "Also, let's make it possible to move unassigned texts back to the original device or to another
> device. And we could also make it possible to assign a text to the unassigned texts 'device' (or
> give it some other more generic name). (also for the next release)"

**The concept does not exist in the code yet** — there is no `unassigned` anywhere in `docs/js/` or
`worker/src/`. What exists is `moveTextModal` (researcher-panel.js), which moves a text from one
device to another: assign to the destination, watch for it to appear in that device's inventory,
then fire the upload-first remove at the source. It only offers OTHER DEVICES as destinations, and
it can only be started FROM a device row — both of which is what this asks to generalise.

So this is really one idea in two directions, and the inventory modal above is what makes both
reachable:
- **Drive → device.** A text sitting in Drive with no device holding it has no row today, so there
  is nowhere to click "move". The inventory modal gives it one. The move itself is the EXISTING
  assign path — the text folder already carries `flextextDoc=<docId>`, and after v3 its manifest
  names the source files, so re-assigning it to a device is the same begin/upload/finish flow with
  the files already in place. "Back to the original device" is worth distinguishing in the UI from
  "to another device" only if we record which device it came from — the folder tree already does
  (`FlexText Uploads/<Device>/<Storyname>/`), so the original device is READABLE, not something new
  to store.
- **Device → unassigned.** This is `moveTextModal` with a destination that is not a device: upload
  first, then remove from the source, and stop — deliberately parking the text in Drive. Note this
  is ALREADY the safe half of an existing flow: the upload-first-then-remove sequence is the whole
  reason a move cannot lose work, so parking is a move whose second leg is simply skipped.

**⚠ The naming question Seth flagged is the real design decision, and it is not cosmetic.** Calling
it a "device" makes it fit the existing UI for free (a card, rows, a Files ▾ menu) but it is a lie
the data model will eventually catch: a device has an `instance_id`, installs, an `ack_seq`, a
settings snapshot and a pairing secret, and none of that exists for a holding area. Everything that
iterates `lastData.instances` would have to special-case it, which is exactly the kind of
"rule enforced in app.js that the satellites reach by a different path" drift the entry at the
bottom of this file warns about. Suggest a distinct section in the panel ("In Drive, not on a
device" / "Archive" / "Parked") rendered by the SAME row + Files ▾ components, with no fake
instance_id anywhere near the worker. Seth's own instinct — "or give it some other more generic
name" — is pointing at this.

**Sequencing:** the inventory modal has to land first; it is the surface these actions live on.
