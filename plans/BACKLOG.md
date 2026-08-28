# Backlog additions (2026-08-07) — paste into notes/BACKLOG.md

> ⚠ **Start at [`PENDING.md`](PENDING.md)** — the one-screen triage sheet that ranks everything below
> by risk to a field user's work and points back here for the detail. This file is the record; that
> one is the way in.


## NEXT, IN ORDER (Seth, 2026-08-20) — the queue after v433

Recorded verbatim because the order is his and it is not the order the work naturally suggests.

1. **The GitHub → Cloudflare build process.** Blocking everything below it: *"we need to fix our
   GitHub->Cloudflare build process before going any farther."* Already decided (2026-08-19): two
   MANUAL wrangler workflows — one for `staging`, one for `productionWeb` — calling a single
   reusable workflow, and Cloudflare's git integration disconnected so a repo push stops building
   anything. It is the root fix for the build-collision rule that this file and CLAUDE.md both carry
   several paragraphs of workarounds for, and Seth's reason is cost as much as correctness: *"that's
   costing us a lot on the speed of our development. And also probably AI tokens."*
   ⚠ Touching `.github/workflows/**` needs his explicit OK plus a cost estimate first.

2. **Multiple researchers sharing a project.** *"an owner inviting and able to revoke and have
   granular access controls for a guest/assistant researcher."* The isolation requirement is already
   locked in `plans/project-split.md` II.5c and is absolute: an invited researcher gets no access of
   ANY kind — UI, API, Drive permission, worker endpoint, JS object — outside what they were given,
   and all of it revokable. Seth asked for *"some planning discussion first before we move straight
   to implementation."*

3. **Movement between owners**, which the item above makes possible and which is its own design
   problem: *"the ability to transfer devices across projects with different owners and also
   transfer ownership/Google Drive root parentage between researchers."*
   ⚠ The second half is the hard one and should not be waved through with the first. Every folder in
   an estate lives in ONE researcher's Drive under `drive.file` scope — the scope only reaches files
   this app created FOR THAT USER — so transferring ownership is not a re-parent, it is a change of
   which Google account holds the bytes. Drive's own ownership transfer, a copy-and-repoint, and
   "leave the bytes and move the index" are three genuinely different products with different
   failure modes. Decide which one it is before building any of it.

## LATER: administrators need to suspend / ban / delete accounts for abuse (Seth, 2026-08-20)

> *"I will eventually need a way for administrators (including me) to at least suspend if not
> ban/delete accounts if later on abuse is detected. But that's a later feature."*

Filed with what already exists, because most of the mechanism does — the gap is smaller than it
sounds, except for one part that is genuinely hard.

**Already built:**
- `researcher.approved` is the gate. `isApproved()` guards every privileged endpoint, so
  `approved=0` on an existing row IS a suspension — the account can sign in and do nothing.
- `logApproval` already writes an audit trail (`account_signup`, `account_auto_approved`,
  `account_declined`), so a suspension has somewhere to be recorded.
- Deletion exists twice: self-delete (`POST /v1/researcher/delete`) and the owner's decline of a
  pending account.
- Session revocation exists — `revoke-others` and per-session revoke — so a suspension can also cut
  live sessions rather than waiting for them to expire.

**So "suspend" is roughly: set `approved=0`, revoke that researcher's sessions, log it, and give the
owner a button.** Checked: the Google callback only re-approves on sign-in for env-listed OWNERS
(`ALLOWED_RESEARCHERS`), not for domain-approved accounts — the domain check applies at account
CREATION only. So a suspension sticks across sign-ins. Good.

⚠ **"BAN" IS THE HARD ONE, AND IT IS HARD FOR A REASON WORTH RESPECTING.** A suspended person can
delete their own account and sign up again, and a fresh row created under a pre-approved domain is
auto-approved on sight — so deletion launders a suspension. Making a ban survive deletion means
keeping a record of the banned identity AFTER the account is gone, which is retaining personal data
as a side effect of erasing it. That is the same trade already rejected under the deletion notes
above, and it should not be quietly accepted here just because the word is "ban".

Plausible ways through, none free, to be chosen deliberately rather than defaulted into:
1. **Block deletion while suspended.** The account stays, visibly suspended, and cannot be laundered.
   Cheapest and keeps no extra data — but means someone under investigation cannot exercise deletion,
   which is its own thing to be comfortable with.
2. **Ban the DOMAIN's auto-approval rather than the person** — remove the domain from
   `approved_domain`, so returning accounts land pending and are simply not approved. Retains nothing
   about an individual. Blunt: it affects their colleagues too.
3. **Keep a minimal ban list** (an HMAC of the address, like `email_sha256`, and nothing else). Least
   data that could work, still a record of a deleted person; only worth it if 1 and 2 prove
   insufficient in practice.

**Priority: later, as Seth said.** Nothing here is load-bearing while the researcher set is seven
people who are all known personally. It becomes real the moment sign-up is genuinely open.

## ~~SOON: an unassigned box cannot move a text to ANOTHER project's unassigned box~~ — FIXED on the feature branch 2026-08-26 (NOT released)

> Also filed as GitHub issue #12. One flag: the Unassigned card's Move button called
> `adoptTextModal` without `{ unassign: true }`, so `groupedDestinations` never emitted the
> `__unassigned:` tiles from exactly the card whose texts are already unassigned — while the crowd
> row two lines down passed the flag and could file cross-project all along. Fixed at the call site
> (commit 249df8c, feature branch), pinned by test/files-modal-and-move-gate. The cross-project
> confirm Seth asked for was already in the modal and now actually fires from this card.

## SOON: a TYPEABLE invite code beside the invite URL (researcher request via Seth, 2026-08-27)

A researcher asked for a shorter, manually typeable alternative to the invite link — for devices
where pasting a long URL is impractical. Shape: keep the URL exactly as-is; ADD a short one-time
code (8–10 base32 chars, shown grouped: AB3D-7F2K) the worker maps to a pending invite. The paste
box already accepts arbitrary text, so parseInviteInput learns the code shape and calls a resolve
endpoint that returns the id+secret the normal claim flow needs.

⚠ THE SECURITY SHAPE IS THE FEATURE: a short code is guessable where the long fragment secret is
not. Required: short TTL (minutes-to-hours, not the link's 7 days), single use, aggressive
rate-limiting on the resolve route (per-IP and per-code), and the code NEVER printed in logs. The
panel shows both forms at mint time. Build after the Phase D member work settles.

## PHASE D GAP — a device created AFTER a membership gets no member key grants (2026-08-26)

`grantKeysToMember` (researcher.js) mints wrapped Kis for a project's devices at the moment a
coworker is ADDED — but nothing re-mints when a NEW device is created in that project afterwards,
so the member sees the new device's rows and reads ciphertext. Small follow-up, two halves:
- worker: `GET /v1/projects/<id>/members` additionally returns, per member, which of the project's
  instances they hold a `member_key` row for (additive field; the owner cannot see this today —
  GET /keys returns only the CALLER's grants).
- client: a `memberGrantSweep` on panel load (selfGrantMissing's pattern): for each owned project
  with members, mint the missing grants. Idempotent (INSERT OR REPLACE), so over-running is free.
Until then the workaround is remove + re-add the member (removal deletes their grants; re-adding
re-mints for every current device) — the panel's own error strings already say so.

## SOON (superseded original entry follows for context)

> *"We still can't move texts from one unassigned box to the unassigned box on another project.
> That's something I'd like somewhat soon. All other moves work as expected though."*

Confirmed still open after v434's test drive. Every other move works: device→device, device→unassigned,
and both of those across projects. The one gap is unassigned→unassigned across projects.

The worker is already capable — `drive-unassign` accepts an explicit `projectFolderId` (added
2026-08-20) and verifies the target really is a project folder before trusting it. So this is a
CLIENT gap: the source-less move flow that both the Unassigned card and crowd rows use offers devices
as destinations but not other projects' unassigned boxes. The fix is in `groupedDestinations` /
the source-less move modal, not in the backend.

⚠ Keep the confirm distinction Seth asked for when it lands: moving across projects already has its
own confirm, precisely so a cross-project move cannot be made by the same reflex as a local one.

## LATER, FOR FABLE: audit researcher-panel latency and cross-app sync responsiveness (Seth, 2026-08-20)

> *"There's significant lag in the researcher panel and auto refreshing/syncing across our apps, but
> a lot of that is due to having actually a pretty poor connection. It's still very functional within
> the realm of expectations. Later when we have time we can task Fable with auditing and finding ways
> to improve that without compromising the guards we have in place to prevent partial downloads,
> things dropped or reset or un-cached as a result of connection instability or working offline."*

⚠ **The constraint is the whole job.** Most obvious speed-ups here trade away exactly the property the
suite exists for. The guards that must survive any change: chunked/resumable uploads with probe-first
resume, the absorb-then-delete rule on native captures, offline-first caching, the optimistic-locked
settings writes, and the estate-settle polling that exists because Drive's search index lags a write.
Anything that makes the panel feel faster by assuming the network is good is a regression on a field
device, not an improvement.

Two concrete leads already in hand from the client-vs-server audit: `GET /v1/researcher/drive-estate`
is unlimited, uncached and polled while doing TWO full `driveListAll` passes (each paged to 20k
files); and the panel polls `GET /v1/researcher` every 12s. Neither is the cause of a bad-connection
day, but both are real work per tick.

## FUTURE: right-to-left language support — Arabic-script vernaculars (Seth, 2026-08-27)

> *"That'll be most challenging in our gloss/free translation tab. Future feature, not now."*

The data-language case (an RTL VERNACULAR and/or analysis language), distinct from an RTL UI
language (full panel mirroring — separate, bigger, unrequested). Three shapes to support: RTL vern
+ LTR analysis (Arabic text glossed in English/Indonesian — the common one), the reverse, both RTL.

What makes it tractable when its time comes:
- Direction should DERIVE from the writing system (script subtag: -Arab etc.), with a per-WS
  override in settings — never a global toggle. The WS codes already ride the flextext.
- `dir="auto"` on every text input/textarea (baseline, gloss fields, free translation) gets the
  easy majority free — browsers do per-paragraph bidi. The REAL work is Seth's point: the
  interlinear ROW on the Gloss tab — token ORDER must flow right-to-left for an RTL vernacular
  while each token's gloss beneath may be LTR, and wrapping must break rows from the right.
  (CSS: row-reverse/rtl direction on the token row + logical properties instead of left/right.)
- ⚠ The TIME AXIS NEVER FLIPS: Cut-tab strips, mini-waves, and the player run left→right by
  convention regardless of text direction — only text runs RTL. Mixing these is the classic
  RTL-audio-tool mistake.
- FLEx itself renders RTL interlinear; its behaviour is the round-trip fidelity reference.
- Exports need dir too: the HTML preview (dir on the container), EAF is direction-neutral.

## FUTURE: permission prompts are asked too broadly and too often (Seth, 2026-08-20)

> *"On the crowd recorder (and other recorders maybe?) it asks for recording permissions at multiple
> points during the process (once for the consent response and once for the actual recording). Also,
> for editor and recorder, our location permissions request may need to be scoped more narrowly —
> when a new recording consent is triggered/recorded, rather than for the whole app all the time."*

Both are future fixes, filed with what the code actually does so neither gets re-diagnosed from the
symptom.

### Location: asked once, app-wide, at first tap — and that is DELIBERATE

`primeGeolocationOnce()` runs from app setup (`app.js`) and attaches a one-shot `pointerdown`
listener, so the browser's location prompt fires on the **first tap anywhere in the app**, whether or
not a consent recording will ever be taken. `readGeoIfGranted()` then reads silently during consent,
never prompting.

⚠ **Its comment states the reason, and any fix has to solve that problem rather than rediscover
it:** *"The location permission popup is too disruptive to fire mid-consent, so on the first user tap
we make the single request at a calm moment."* Moving the prompt to consent time puts a system
dialog in the middle of asking a speaker for their consent — which is the worst possible moment for a
modal, and is exactly what the current design was avoiding.

So this is a genuine trade-off, not an oversight: **scope** (asked app-wide, always) versus
**timing** (asked at a calm moment). Seth now wants scope prioritised. Something has to give, and the
plausible middle is priming at the START of the consent flow — after the speaker has been told what
is about to happen but before the recording itself — rather than at first tap or mid-consent. Worth
designing rather than moving one function call.

⚠ And the narrower scope is the more defensible one for a suite carrying research-ethics obligations:
location should be collected when it is part of a consent record, not held ambiently because the app
happened to open.

### Microphone: asked more than once in the crowd flow

Two separate opens exist in one session when the consent response is itself a recording
(`consentResp=record`): the consent-assent recorder, then the actual text recording. There are three
`getUserMedia` call sites — `record-pcm.js` (lossless), `startMediaRecorder`, and the record-mode
path — and nothing shares a stream or a grant between them.

⚠ **A hypothesis to TEST before designing anything, not to build on:** in a top-level page Chromium
persists a mic grant for the origin, so a second `getUserMedia` should not re-prompt — which suggests
the doubled prompt is specific to the crowd recorder being an **IFRAME EMBED**, where the grant is
per-frame and depends on the embedding page's permissions policy. The code already knows this area is
strange: `crowdShowFrameEscape` exists because a frame without `allow="microphone"` fails with no
prompt at all, indistinguishable from a user Block.

So the first task is to establish **where** the second prompt actually comes from — embed vs
top-level, and which two call sites — because "open the mic once and keep the stream" and "fix the
iframe permissions policy" are completely different fixes and only one of them will work.

## FUTURE FEATURE: "Clonezilla for the suite" — snapshot and restore an estate (Seth, 2026-08-20)

> *"a workflow that makes a manual backup copy (on Google Drive) of the whole Google Drive folder
> structure (and any relevant D1 data that is important and isn't rebuildable from Google Drive, like
> paired devices)... useful for development as well (the ability to back up all my data before trying
> something potentially destructive, or to back up from one Google researcher account and then restore
> on another (and a way to make sure that doesn't result in things being duplicated that shouldn't
> be)."*

Distant future, filed so the design constraints are recorded while they are known rather than
rediscovered.

**Half of it already exists.** `GET /v1/researcher/drive-snapshot` returns the RAW Drive listing —
deliberately not the `buildDriveEstate` projection, because a snapshot should record what Drive held,
not what our grouping logic made of it. That is the structural backup; what is missing is the D1 half,
somewhere to keep it, and a restore.

⚠ **These are TWO products, and conflating them is the trap.** They share a file format and almost
nothing else:

- **Snapshot-before-something-destructive (same account).** Cheap, genuinely useful today, and mostly
  already built. Ids stay valid, keys stay valid, nothing is re-wrapped. A restore here is "put the
  folders back where the snapshot says they were" — the same metadata-only re-parenting the projects
  migration already does.
- **Restore onto a DIFFERENT researcher account.** A different thing wearing the same word, and every
  hard problem lives here.

### What is NOT rebuildable from Drive, and therefore has to be in the backup

Drive holds the texts, the audio and the folder tree. D1 holds what Drive cannot: instances and their
`oauth_folder_id`, installs and their pairing state, crowd recorders and their public links, approval
state, and the wrapped-Ki key map in `settings_blob`.

### The constraints a design has to satisfy

1. ⚠ **Keys do not travel between accounts.** Each instance's Ki is wrapped under that researcher's
   Kr, and each install holds Ki wrapped to its own public key. Restoring onto another account is not
   a copy — it is a re-wrap under the new Kr, and the installs cannot be re-wrapped at all without the
   devices present. So **paired devices do not survive a cross-account restore**, and the honest
   design says so up front rather than appearing to restore them.
2. ⚠ **Duplication is the failure mode Seth named, and this repo has already had it once.** v167's
   "Title (n)" folders came from re-searching a lagging index and minting a second folder. A restore
   that recreates folders while the originals still exist reproduces it deliberately. The restore
   must be **id-aware**: match on the id first (`files.get` is strongly consistent), then on the
   `appProperties` tag, and create only when both miss.
3. **A Drive-to-Drive byte copy is not one request.** There is no recursive copy in the Drive API —
   it is one call per file, against the ~50-subrequest Cloudflare cap. Any real implementation is a
   resumable job with progress, like the chunked uploader, not a single endpoint.
4. **Consider not copying the bytes at all for v1.** Drive already has trash and version history; the
   thing that actually gets lost is the STRUCTURE and the D1 rows. A manifest-plus-D1 export is far
   smaller, far cheaper, and covers the development use case ("back up before trying something
   destructive") completely.
5. ⚠ **A backup file is a copy of the estate's metadata**, and the privacy and research-ethics
   obligations that apply to the estate apply to it unchanged: encrypted, minimal, and never holding
   anything the live system would not hold.

**Sequence, if it is ever built:** same-account snapshot/restore first, because it is small and
useful; cross-account only after, with the key and pairing limits stated in the UI rather than
discovered.

## NEXT RELEASE: a text whose audio is still arriving opens in the CLASSIC editor — fixed on `main` at v442, ⚠ **NOT RELEASED** (re-checked 2026-08-24)

> ⚠ **The strikethrough here used to say "FIXED v442", which was true of the tree and false of every
> field device.** `origin/productionWeb` is **v441** and has **zero** occurrences of the guard
> (`attachingAudioFor === stripsFor`, `docs/js/app.js:1407`); `origin/main` and `origin/staging`
> (v442) have one. So the bug Seth reported in the v440 test drive is still live in Papua today, and
> the fix has been sitting one fast-forward away since 2026-08-20.
>
> "Fixed" means fixed **where the user is**. Until a release marks it, this entry stays open — that
> is the whole reason it was missed. **Ship it: clear `BUILD_TAG` on `main` (currently
> `'baseline-loading v1'`), `./bump-version.sh v445`, test-drive staging, ff `main` → `productionWeb`.**

> *"It initially loaded the classic text editor while the audio was loading. And then after I
> switched tabs it switched to audio segmentation mode… You can type in the baseline textbox, but
> then when you switch to another tab and back it renders as audio-segmentation-enabled and whatever
> you typed in the baseline tab ends up on the first line. […] Suffice to say it is a bit of a UI
> glitch that we should plan to fix in our NEXT release."*

Found during the v440 test drive. ⚠ **PRE-EXISTING — it is in productionWeb (v433) too**, so v440
neither causes it nor makes it worse. Filed for the next release as Seth asked, not held against
this one.

**DIAGNOSED, and it is an asymmetry rather than a mystery.** The Baseline tab's segmentation branch
treats "no media" as one case:

```js
if (!media || !media.blob) {  …show #baseline-text…  return; }
```

The Cut tab already distinguishes the two, and says why in its own comment:

```js
const coming = !!(current.pendingAudio || attachingAudioFor === forDoc);
loading.textContent = t(coming ? 'seg.loadingAudio' : 'cut.noAudio');
```

So on the Cut tab an arriving recording says "Loading the recording…", while on the Baseline tab the
identical state silently falls back to the classic textarea — indistinguishable from a text that
genuinely has no audio. That window is the normal case for a text just made from a file (the editor
opens before the attach finishes) and for an assigned text still downloading.

**Why the typing goes to line 1.** `applyBaseline` is gated on DOM truth, so a VISIBLE textarea is
read as the user's intent on tab-leave. `reconcileBaseline(..., {flatSegments:true})` then makes one
paragraph per line, and the strips render that as the first span.

⚠ **Text is never lost, and that is worth stating** — the words survive into the doc. What is wrong
is that the user was offered an editor they should not have been, and the result lands somewhere
they did not choose.

**The fix is the Cut tab's guard, applied here**: when `pendingAudio` or `attachingAudioFor` says a
recording is on its way, keep `#seg-loading` up (with `seg.loadingAudio`) instead of revealing the
textarea, and let the existing re-entry path render the strips when it lands.

⚠ **Not yet known**: what happens with TWO OR MORE typed lines. Seth did not try it. Expect
`reconcileBaseline` to make one paragraph per line and the seed to divide the recording evenly as
`timeEstimated` (dashed) — text intact, alignment a guess — but that is reasoning, not a test. Check
it while fixing.

**FIXED in v442**, exactly as predicted above: the Baseline branch now runs the same
`pendingAudio || attachingAudioFor` test the Cut tab has had since v433, keeps `#seg-loading` up
while a recording is on its way, and never reveals the textarea on that path. Mutation-tested —
neutering the guard fails three assertions by name.

⚠ The TWO-LINE question is still open. It was a prediction, it stayed a prediction, and the fix
removes the window in which anyone can type at all — so the answer no longer matters in practice and
was never established. If the branch is ever reached again, it is still unknown.

## SOON-ISH: "creating the device failed" but the device exists — and then shows in two tabs (Seth, 2026-08-20)

Reported by a researcher, verbatim sequence: one existing project with one device → created a second
project → added a device for it, changed their mind, left it **awaiting key** → added a *second* new
device, which "processed for a minute, then showed a message that it had failed to create the new
device" → revoked the first new device. Result: the first is gone as expected, and **the second
appears twice — under the new project's tab AND under "Not in a project yet"**, despite the panel
having said its creation failed.

### The "failed but exists" half is EXPLAINED, and it is a compensating action that did not complete

`createInstance` (researcher.js) is three acts, not one:

1. `POST /v1/instances` — inserts the row. Correctly `retry: false`, so this is **not** a duplicate
   from an auto-retried POST; that theory was checked and is wrong.
2. generate Ki, wrap it to Kr, and CAS it into the settings blob (`fetchSettings` → `putSettings`,
   up to 4 conflict retries).
3. On any failure in 2, a **best-effort `revokeInstance`** so a keyless instance is not stranded —
   already commented `/* leave for manual cleanup */`.

So the row is created first and the failure the researcher saw came from step 2 or its cleanup. The
minute of processing says the network was unwell at exactly the moment step 3 needed it, and step 3
is the one call in the sequence with no compensation of its own. **The panel then reports the whole
thing as a flat failure**, which is the actively harmful part: the researcher believes nothing
happened and takes corrective action against a false picture.

⚠ The cheap, honest fix is not "make it atomic" (it cannot be — D1 and the settings blob are
separate stores). It is to stop *asserting* a failure the client cannot verify: on a step-2/3
failure say the device **may** have been created and re-render the dashboard, so the truth is on
screen rather than in a claim.

### The "shows in two tabs" half IS explained — the panel does not refresh what decides the tab

Seth, 2026-08-20: *"I often have to manually refresh to see changes in the researcher panel."* That
is not a vague impression; it is a documented property of `renderDashboard`, and it lands exactly on
the derivation this report is about.

**Which tab a device appears in is a function of `estateCache`.** `projectScope` → `projOfInst`
reads the worker-stamped `instanceId` off `estate.devices`, falling back to `oauth_folder_id`. And:

> `⚠ THE ESTATE DOES NOT RIDE THE 12s POLL` … *"`renderDashboard` refetches `estateCache` only on a
> FULL render (initial load, manual Refresh, or after an action); the poll passes `prefetched` and
> deliberately skips the Drive round trip."* — researcher-panel.js, its own comment

So the poll DOES pick up the new instance (that comes from `listView`, i.e. D1) but joins it against
an estate fetched **before the device existed**. No estate entry ⇒ `projOfInst` returns `''` ⇒ the
device lands in **"Not in a project yet"** and stays there until something forces a full render.

Three things compound it, and all three were active in the reported sequence:

1. **The failure path of the new-device modal does not re-render.** Success does
   `m.close(); renderDashboard();`; the catch does only `errToast(err)`. So after a failed create
   there is no estate refetch — and the modal stays open.
2. **An open modal suspends polling entirely** — `pollDashboard` returns early on
   `document.querySelector('.modal')`, and re-checks after every await. So the panel is not merely
   stale, it is frozen.
3. **Revoking the first device is an ACTION**, which triggers a full render and refetches the estate
   — at which point the second device's folder is finally visible and it **moves** to the project
   tab. That is precisely the moment the researcher describes noticing the duplicate.

⚠ **And a genuine SIMULTANEOUS double is available too**, without needing a duplicate row: the
Projects card counts `estate.devices` by folder parentage (`devices.filter(d => d.projectId ===
p.folderId)`) while the tab bar partitions **D1 instances** through the stale-estate join. Two
derivations, two sources, one screen — they can disagree at the same instant, which is what "shows
up twice" reads like to anyone not holding the code.

**Still worth the query before closing it**, because a genuine duplicate row is the one variant this
does not explain: `SELECT instance_id, nickname, oauth_folder_id, project_id, created_at FROM
instance WHERE researcher_id=? ORDER BY created_at`. Two rows ⇒ a double submit past `busy()`. One
row ⇒ this section is the whole answer.

### The general fix, which is bigger than this report

The estate is skipped on the poll for a real reason — it is a Drive round trip, and the comment
argues the unassigned card changes "on the timescale of a researcher removing a text, not seconds".
That reasoning was sound when the estate only fed a storage card. It stopped being sound when
**project membership** started being derived from it: tab assignment is not a slow-moving display
detail, it changes the moment a device is created.

Options, cheapest first — none chosen yet:

- **Refetch the estate after the actions that invalidate it** (create/revoke a device, move a
  container), including on the FAILURE paths. Narrow, no new polling cost, fixes this report.
- **Let `viewSig` notice an instance the estate has never heard of** — an instance in `listView`
  with no matching `estate.devices` entry is a known-stale signal, and could trigger ONE estate
  refetch rather than a poll-rate one.
- **Poll the estate at a slower cadence** (say every 5th tick) — simple, but pays a Drive round trip
  forever to fix a transient.

⚠ Whatever is chosen, `viewSig` is the trap: anything rendered that is not in the signature never
repaints, and the signature's own comment says the estate entries in it "CANNOT change on the poll
path". Adding a refetch without teaching the signature to notice it would change nothing on screen.

### Judgment: not urgent, but do not let it sit behind Phase C

Nothing here loses work — the device is real, it can be revoked, and the tab flip corrects itself.
It is a *confusion* bug, and its cost is that people act on a false report (this researcher revoked
a device partly because of it). The message fix is small and worth doing in the next release that
touches the panel; the duplicate needs the query first.

⚠ Related but separate, and already fixed: D1 having only ONE project row for two Drive project
folders (2026-08-20, `reconcileProjects`). That made "not in a project yet" wrong for real reasons
too, so re-check this report against a reconciled estate before digging further. ⚠ Note that
`reconcileProjects` hangs off `drive-estate`, so it too runs on FULL renders only — the repair
lands on a panel LOAD or manual Refresh, not within a poll tick.

## AFTER PHASE C+D: one universal diagnostic dump, `fxDump()` (Seth, 2026-08-20)

> *"a sort of universal diagnostic data dump console function would be useful. Let's implement that
> soon (after Phase C and D are basically working)."*

⚠ **Sequenced deliberately after C and D**, and not only because they are more urgent: the dump's
whole value is printing the state that matters, and Phase C/D CHANGE what that is — a project's
members, a viewer's caps, which grants exist. Writing it first means writing it twice.

### Why this earns its place — every item is a real diagnosis from 2026-08-20

The day this was asked, four separate questions each needed a hand-written D1 query or a code read:

| the question | what it took |
|---|---|
| "why does the panel not show the pairing code?" | reading `listView()` to find the enumerated-rebuild trap |
| "why does one researcher's device appear in two tabs?" | still unanswered — needs `SELECT … FROM instance WHERE researcher_id=?` |
| "did the backfill break anybody's data?" | four dispatched `wrangler d1 execute` runs |
| "is D1 in step with Drive?" | comparing a screenshot of Drive against a `project` row by eye |

⚠ **The last one is the shape of most of them: two stores that are supposed to agree, and no cheap
way to ask whether they do.** That is the function's real job — not "print some state" but **print
the DISAGREEMENTS**, because the state itself is mostly uninteresting when it is correct.

### What it should print

**Local (device or panel, from the browser console):** engine + sw VERSION and `BUILD_TAG`, which
worker base and estate this origin points at, instance/install ids, `desired_rev` vs `ack_seq`,
IndexedDB doc count and bytes, pending uploads, whether a Ki is resolvable for each instance, and
the settings that change behaviour (`segmentation`, export toggles, consent mode).

**Server (the panel, authenticated):** the caller's projects and role in each, the instances D1
holds versus the containers Drive holds, `member_key` grants versus `project_member` rows, and
`instance.project_id` versus the Drive folder's actual parent.

**And the derived answers, which are the point:**

- containers in Drive with no D1 instance, and instances with no Drive folder
- a `project_id` that disagrees with Drive parentage (what `reconcileProjects` repairs — the dump
  should be able to SAY it, not just leave it repaired silently)
- `member_key` rows whose `project_id` is `''` while the instance now has a real one
- a grant with no matching `project_member` row, or a member with no grant — the two halves of
  Phase C that can drift apart
- version skew across the five apps

### The second half Seth asked for: capture the LOGS too, behind a UI BUTTON

> *"maybe some kind of universal dump of all browser web dev tools logs that have anything to do
> with our web app saved as a text file. And have a UI button that triggers it instead of just a
> console function. … So then I can have my friend run that and send me the text file."*

That last sentence is the requirement, and it changes the design: **the person running it is a field
user who will not open a console.** A console-only helper cannot serve the case that motivated it.

**Doable — with one honest boundary.** A web page CANNOT read the browser's DevTools console or
Network history; no API exposes it, and none is coming. What it can do is **capture its own** from
startup, which for our purposes is nearly the same thing because almost everything in that console
is ours:

| capture | how |
|---|---|
| our console output | wrap `console.log/warn/error/info` at the TOP of the entry module into a capped ring buffer |
| uncaught errors | `window.onerror` + `unhandledrejection` (with stack) |
| network | wrap our own `fetch` — method, path, status, duration, size. NEVER bodies or headers |
| CSP violations | the `securitypolicyviolation` event |
| service-worker logs | a separate context: the SW ring-buffers its own and `postMessage`s them on request |

⚠ **State the blind spots in the file itself**, or the reader will assume silence means nothing
happened: anything logged before the wrapper installs (little, if it is first), browser-generated
console text we never see (a resource 404, the detailed CORS explanation behind an opaque fetch
rejection), and other tabs.

The button: Help menu is the natural home — and the **admin drawer** (seven taps) is the natural
place for it if it should not clutter a field translator's UI. Output is one text file via a Blob
download, combining the state dump above and the captured log, so there is exactly ONE artefact to
send rather than two to correlate.

⚠ **Cap the buffer and say so.** A ring buffer means a long session DROPS its oldest entries — and
the interesting event is often the first one. Record the drop count in the header so a truncated log
announces itself instead of reading as a complete one.

### Constraints, from rules this repo already enforces

- ⚠ **A UI button AND a console entry point.** The button is the requirement (a field user sends
  the file); the console name is for us. NEVER a keyboard shortcut — the existing rule, and its reason is
  concrete: a ⌃⌥E binding could never fire on a Mac, because Option+E is a dead key. Register it
  beside `fxUpdate()` / `fxLinks()` / `fxProjects()` and document it in DEVELOPERS.md, which is
  where the list lives.
- ⚠ **It will be pasted into chat and issue threads, so it must be safe to publish.** No secrets, no
  refresh tokens, no wrapped keys, no `x-fx-secret`, and no other researcher's email. Ids are fine;
  credentials never are. Given `check-secrets.sh` exists precisely because credentials reached a
  public repo once, the dump needs a test asserting its output carries none — the format-based scan
  already knows what those look like.
- ⚠ **Read-only.** A diagnostic that repairs is a diagnostic nobody can safely run twice, and the
  repair belongs where the authority is (the worker), not in a console helper.
- It should work OFFLINE, printing the local half and saying plainly that the server half is
  unavailable — a field device with no signal is exactly when someone wants it.

## VIDEO SOURCES (.mp4) — audio extraction first, preview later (Seth, 2026-08-21)

> *"Can our editor app make use of video files (like mp4)? For now just automatically extracting and
> using just the audio is good enough, but in the near future we'll want to be able to see the video
> playing in a small preview viewer somehow. But THAT part is for later."*

**Most of the machinery already exists, and it is not the part anyone would guess.**

`segWorkingMedia` (app.js:1595) already takes ANY non-WAV media, decodes it with `decodeAudioData`,
re-encodes to 16-bit WAV, stores it under `segwav:<docId>` as `derived:true`, and leaves the original
untouched. That IS audio extraction — built for the lossy-source timeline fix (AAC priming makes
decode and playback disagree by ~44ms), and a video container is the same problem wearing a
different hat. Playback needs nothing either: media plays via `URL.createObjectURL(blob)` on an
`<audio>` element, and Chrome plays an MP4's audio track through one.

⚠ **The blocker is the FILE PICKERS, not the pipeline.** Five inputs in `docs/index.html` (lines 89,
93, 173, 225, 296) accept `audio/*` plus an extension list. An `.mp4` simply cannot be selected.
Adding `video/mp4,video/quicktime,.mp4,.mov` is the bulk of the change.

⚠ The `/^audio\//` guard at app.js:5826 is NOT a blocker — it is the CONSENT PROMPT picker only, and
should stay audio-only: a consent prompt is played aloud to a speaker.

### ⚠ MUST BE TESTED BEFORE BUILDING — cannot be verified from source

**Does `decodeAudioData` accept an MP4 that contains a VIDEO track?** Chrome is expected to decode
the audio track and ignore the video, which is what makes the whole approach work — but that is an
expectation, not a verified fact, and this container has no ffmpeg and no Playwright to test it. If
it throws, extraction needs a real demuxer (a large dependency, and a new top-level import in
`js/app.js` is a new SHELL entry in the editor AND every satellite sw.js — the v108 outage).
**Test on Android Chrome with a real phone-camera MP4 before any of this is scoped.**

Second thing to test: whether `<audio src=blob:...>` reports correct `duration` for an MP4. The
segmentation seeds divide the recording by duration, so a wrong or `Infinity` duration produces a
false alignment rather than an error.

### ⚠ THREE DECISIONS, and the first one bites in the field

1. **Video bytes must never ride a field upload.** An MP4 is many times the size of its audio, and a
   field device would store AND upload the video over expensive bandwidth. There is exact precedent
   to follow rather than invent: the derived WAV and the preview HTML already ride LOCAL bundles
   only, because *"field upload bandwidth never pays for embedded audio."* Video should follow the
   same rule, with more force.
2. **But do not extract-and-discard.** The archival rule is that the ORIGINAL is never touched,
   replaced or deleted (app.js:1591). It also happens to be what the future preview viewer needs. So:
   keep the video locally, derive the audio as the working copy, exclude the video from uploads.
   Those three are the same decision, which is a good sign it is the right one.
3. **`segWorkingMedia` only runs when segmentation is enabled** (app.js:1598). In the classic editor
   a video would stay the media as-is — fine for playback, but no extraction happens, so the WAV
   working copy the exports assume would not exist. Decide whether video import forces the
   conversion regardless of mode.

### Smaller things that follow

- The derived WAV's BWF `bext` names its lossy origin (`seg-exports.js:1006`); a video origin should
  be named too — the honesty stamp is the point, and "derived from video" is a different fact.
- `paragraph-ui.js` (134, 191) picks the audio file out of a drop by `/^audio\//` or an extension
  list; PAT would need the same widening or it silently ignores a dropped video.
- The recorder and crowd satellites use their own capture paths and are unaffected.

**Sequence:** test the decode → widen the pickers → force the WAV derivation for video → exclude
video from uploads → (later, separately) the preview viewer.

## PHASE C INCREMENT 2 — all 23 audit findings FIXED, still not a clean run (2026-08-21)

**See `plans/AUDIT-FINDINGS-2026-08-21.md`.** Two adversarial rounds (6 lenses + 3), 35 candidates,
23 confirmed, all fixed — plus two live defects the completeness critic found in the REMEDIATION
itself. Nothing is deployed and no `project_member` rows exist, so none of it was ever reachable.

**What members get in v1: DEVICE MANAGEMENT.** `manageDevices` and `createInvites`. `assignTexts`
and `drive` are refused on BOTH the write and the read path — nine of round 1's findings live behind
them, and they close by making the capability ungrantable rather than by repairing the routes. The
account-wide `docId` searches are still there; the Drive lane is deferred, not fixed.

⚠ **THE HEURISTIC THAT JUSTIFIED THE DEFERRAL WAS FALSE, and that is the lesson worth carrying.** It
read "EVERY dangerous route is one where the member names a Drive file or text." The sweep disproved
it within hours: `changeSettings` names no Drive id and let a member repoint a field device's entire
backend — install credentials, every upload, and a wipe. A rule that explains the last outage is not
thereby a rule about the next one.

⚠ **NOT A CLEAN RUN YET.** The critic's verdict was a plain NO. Its three grounds are now addressed,
but **no sweep has run against the CURRENT code**, and six items nobody examined are filed under
"STILL OPEN" in the findings doc — none reachable by a v1 member, all inherited by whoever widens
capabilities. Re-run `Workflow({ scriptPath: 'plans/audit-sweep-workflow.js' })` before shipping.

⚠ **Before ANY deploy:** this now includes a `docs/` change (v443), so it carries the satellite
version coupling, not just a worker push. And two live bugs unrelated to Phase C are still unfixed —
the assigned-text manifest fields and `consent.mode`, both filed above.

## DECIDED 2026-08-20: the Drive permission checkbox does NOT ship in Phase D

Seth agreed: don't offer a control that looks functional and is not.

The `drive: read|manage` capability is accepted and stored, and today it grants access on exactly
ONE route — `GET /v1/instances/<id>/texts/<docId>/files`. Every account-wide Drive route still
resolves through `authResearcher`, so a member calling one acts on **their own** Drive and gets an
error. That is safe (and pinned by a rig assertion), but it means a "Drive access" checkbox in the
sharing UI would be a promise the backend does not keep.

**So: leave it out of the sharing UI entirely until the Drive routes are converted.** Not greyed
out, not "coming soon" — absent. A disabled control still tells the owner the feature exists and
invites them to wait for it; an absent one lets the UI describe what the system actually does. Add
it in the same release that makes it true.

## NEXT IN PHASE C: the account-wide Drive routes are still unconverted (2026-08-20)

Phase C increment 2 landed everything except R2-1, the Drive half. **Stopping there is safe, and it
is safe for a reason worth writing down rather than trusting.**

`drive-estate`, `drive-purge`, `trash` and `drive-file/<id>` still resolve through `authResearcher`,
which hands back **the caller's own researcher row**. So a member calling them acts on their OWN
Drive, never the owner's — an unconverted route means *"members cannot do that yet"*, not a leak.
That is precisely the property R2-4's filter shape was chosen to give, and
`worker-members.probe.mjs` now pins it: a member holding `drive: "manage"` gets 502 from all three,
because the route reached Drive with THEIR credentials and they have none. ⚠ If that assertion ever
returns 200, a member is reading the owner's estate through a route nobody converted.

**Consequence for now:** the `drive` capability grants nothing except on
`/v1/instances/<id>/texts/<docId>/files`, which IS converted and IS bounded (per-instance, and the
`see` list applies). Do not offer `drive: read/manage` in the sharing UI as though it did more.

### What converting them actually requires — and the decision it is blocked on

1. `driveListAll` is **account-wide**. Scoping the estate means resolving the project's folders
   (`instance.oauth_folder_id WHERE project_id=?`) and filtering to those parents.
2. `drive-purge` takes **no id list** and empties the whole trash. It needs an explicitly derived
   list, not a filter applied afterwards (R2-4).
3. `trash` takes an **unverified** `fileIds`; every parent must be checked.
4. `drive-file/<id>` serves **any** file id.

⚠ And design-gap 5 is the blocker on the rest: a member with `see` restricted to device A but
`drive: read` can still reach device B's file NAMES through docId-routed routes, because Drive
folders are per-device with plaintext names. The doc's own recommendation is **accept + disclose**
("Drive read shows all project files, including devices hidden from them"), because a filtered
estate that leaks to direct docIds is worse than an honest sentence. **That is decision II.D7 and it
is Seth's, not a default to pick.** Cross-PROJECT scoping (1–4 above) is not blocked on it and is
the part actually worth building first.

## SOON: a REVOKED device keeps its holder's name and their text index, forever (Seth, 2026-08-20)

> Seth, on stale rows: *"probably better practice to have that cleaned up… Especially if we're being
> security/privacy conscious."*

He is right, and it is stronger than housekeeping: it is the same rule
`test/d1-minimization-invariants.test.mjs` already enforces for titles, applied to fields the rules
have not reached yet. §10.4 is one long argument about making a database dump worth as little as
possible; these rows work against it.

### What a revoked row actually retains

`revoke` is a flag flip. Nothing is cleared. So indefinitely afterwards:

| table | field | what it is |
|---|---|---|
| `instance` | `nickname` | routinely **a person's real name** — "Wemis Wanimbo's Phone", "Yohanis Suhu (Intel Mac)" |
| `instance` | `desired_blob` | settings + queued commands, **plaintext** (the worker JSON.parses it) |
| `install` | `reported_blob` | device info + the text/recording list (titleHash, not titles) |
| `install` | `wrapped_key`, `pubkey` | key material for a device that no longer exists |

Production on 2026-08-20:

| project | live | revoked | revoked but still holding a Drive folder |
|---|---|---|---|
| Fayu Text Corpus | 3 | **28** | 13 |
| Dani Dictionary | 1 | **2** | 2 |

⚠ Most of that is Seth's own development account across months of testing, so it overstates what a
real researcher accumulates. It does not overstate the *shape* of the problem, which is that nothing
ever removes any of it.

### ⚠ The obvious fix is wrong, and wrong in a way that would feel like success

**Deleting the D1 row does not remove the name.** The Drive folder is still called
"Yohanis Suhu (Intel Mac)" — the name is on the folder, and the rename route deliberately keeps it
in step. What the delete removes is the JOIN: which device produced which texts. So the visible
identifier survives and the provenance dies, which is the exact opposite of the intended trade.

**The shape that works is MINIMISE, DON'T DELETE:**

1. **Clear the payload, keep the skeleton.** On revoke (or after a retention window): blank
   `nickname`, `desired_blob`, `reported_blob`. Keep `instance_id`, `oauth_folder_id`, timestamps and
   `researcher_id` — provenance and audit survive, the personal data does not.
2. **Delete `member_key` rows for revoked instances outright.** The most sensitive thing in the set,
   and the most useless: key material for a device that cannot be reached. `DELETE FROM member_key
   WHERE instance_id IN (SELECT instance_id FROM instance WHERE revoked=1)`.
3. **Decide the Drive half deliberately**, because it is where the name actually lives. Rename the
   folder to a neutral label on revoke? Leave it, on the grounds that the researcher's own Drive is
   theirs to organise? ⚠ This is a decision for Seth, not a default to pick — and until it is made,
   step 1 buys less than it appears to.
4. `approval_log` is append-only and separate, so device history is NOT lost by any of this. That
   argument does not block the work — worth stating, since it is the first objection anyone raises.

### ⚠ THE DRIVE HALF — DECIDED, and it is a SWEEP-THEN-MOVE, not a rename (Seth, 2026-08-20)

> Seth: *"for the sake of organization, especially with ADHD (like me), we need some way in Drive for
> revoked devices to end up in a 'Revoked' or 'Remove' or other folder so that I'm not confused about
> which ones are active and which ones aren't. Also, all the text folders should end up in
> 'Unassigned' in any case… What I don't want is stale Google Drive clutter and no idea which is
> stale and which is not. For someone with my brain that's a real problem. I also don't want to
> delete things carelessly for which it would be good to save originals."*

**The decided shape: revoke → sweep the texts to Unassigned → move the now-EMPTY device folder into
a "Revoked" container.** In that order, and the order is the whole design.

⚠ **WHY A CONTAINER IS SAFE ONLY AFTER THE SWEEP, and unsafe before it.** `buildDriveEstate` defines
a device as a folder whose parent is in `containerParents = new Set([masterId, ...projectIds])`
(v1.js:804, filter at :820-821). Nest a device folder inside a plain "Revoked" folder while its
texts are still in it and: it stops being a device, its texts lose `device`/`deviceFolderId`
(:858-859), and their `projectId` join (:877) resolves against the Revoked folder and yields `''` —
so those texts vanish from every project tab AND from the per-project Unassigned card. Once the
folder is EMPTY that entire failure mode has nothing to act on: the folder simply leaves the estate
view, which is exactly the decluttering being asked for. **Verified against the source, not assumed.**

⚠ **DO NOT give the folder a `flextextRole`** to mark it. The device filter requires
`!roleOf(f) || roleOf(f) === 'crowd'` (v1.js:820-821), so any other role drops it out of `devices`,
and `projects/assign` would reject it as `not_a_container` (v1.js:3202) — the route behind the
panel's "Move to project…" button. A NON-role `appProperties` key is safe; the filter reads only
`flextextDoc` and the role.

**Marking follows the `(done)` precedent** (v1.js:951-960): `appProperties.flextextRevoked='1'` as
truth PLUS a visible name suffix. The tag is what code reads; ⚠ the SUFFIX is what Seth actually
asked for, because an appProperty is invisible in Drive's own UI and the requirement is legibility
while looking at Drive in Finder.

**Reuse `drive-unassign`, do not write a second sweep** (v1.js:2925-3021). It already resolves each
text's OWN project's Unassigned (`targetFor`, :2959-2981), creates it on demand, re-parents, and tags
`flextextUnassigned:'1'` so an adopt can bring it back (:3009-3010, cleared at :3849-3850).
⚠ It is bounded at `CAP = 10, BUDGET_MS = 9000` and returns `remaining` because the ~50-subrequest
cap already killed `drive-purge` twice (:2984-2994). Any revoke-time bulk Drive work inherits that
ceiling and must report a remainder the same way.

⚠ **D1 FLAGS FIRST, DRIVE SECOND.** Revoke today makes ZERO Drive calls — two D1 UPDATEs and a
return (v1.js:3941-3945, verified) — so it cannot half-fail. Revocation must never become dependent
on Drive being reachable. Sweep and move are best-effort follow-ups, resumable, never preconditions.

✅ **AND TWO PROPERTIES ALREADY HOLD, so the move is safe by construction:** minted assignment URLs
name a fileId, never a path (v1.js:1216), and re-check `revoked=0` at redemption (:1861-1866); device
and text folders resolve by ID and by TAG, never by parent (v1.js:1015-1025, :934-937). Moving or
renaming a folder therefore cannot orphan a pending upload or an outstanding URL.

⚠ **WHAT HAPPENS TODAY, which this replaces:** the texts already drift into Unassigned — `sweepUnassigned`
runs only on a FULL panel render, 12 ids at a time (researcher-panel.js:1434, :5064), and its
exclusions do not protect a revoked device's texts because `assignedDocIds()` reads `lastData.instances`
which no longer contains the instance. So it happens silently, partially, and only while someone has
the panel open. The work is to make it deliberate, not to invent it.

### ⚠ "The history metadata file isn't working so far" — it was never built

Seth referred to *"our history metadata file (which isn't working so far, but will be)"*. Checked:
**`flextext-history.json` has ZERO code** — no writer, no reader, no filename constant, no test. It
exists only as a settled DESIGN in `plans/drive-as-truth.md:1408-1425` and §16.13 (:1440-1495), whose
own text says *"Shape (not yet built — this is the decision, not the implementation)"*. Nothing is
broken; it is unstarted. Worth stating plainly because "not working yet" and "does not exist" lead to
very different next actions.

**And the nickname has nowhere to live today.** `manifest.source.name` is `''` in every manifest ever
written — the schema has the slot and none of the three call sites passes a name (app.js:4619,
app.js:6974, researcher-panel.js:3369; verified). ⚠ Do NOT fill it: the manifest is written ONCE and
is immutable by contract (seg-exports.js:1073-1080, pinned by test/manifest-provenance.test.mjs),
while a nickname is researcher-set and renameable — a frozen name would quietly disagree with the
panel after the first rename. The correct carrier is a **name-at-event-time snapshot in the history
file**: *"at time T this device was called X"* stays true forever, and it is precisely what makes the
D1 forget survivable.

**The keystone, and it is small:** the device folder carries NO tag linking it to its instance —
`driveEnsureDeviceFolder` creates it with `parents` and nothing else (v1.js:1029-1031, verified). One
`flextextInstance` appProperty there is the cheapest durable device→folder link that survives both a
folder move and the D1 forget, and it is what makes `manifest.source.id` resolvable from Drive alone.
Everything else in this section depends on it.

### ⚠ TWO LIVE BUGS found while mapping this — independent, small, worth fixing first

Both make bad data accumulate right now, so fixing them stops the pile growing while the rest is built.

1. **Every assigned text ships empty writing systems and a wrong birth time.** The assignment queue
   record writes `at: Date.now()` (researcher-panel.js:3224) but the manifest builder reads
   `rec.queuedAt`, `rec.vernLang` and `rec.analLang` (:3359-3361) — none of which is ever set. So
   `originatedAt` becomes the moment the UPLOAD ran, not the assignment, and `writingSystems` is
   `{vern:'', anal:''}` on every assigned text. Verified.
2. **`manifest.consent.mode` is always `'off'`.** It reads `settings.consentMode` (app.js:4608), a key
   deliberately DELETED during settings migration (`delete s.consentMode`, app.js:250). Nothing reads
   `mode`, so it went unnoticed and no test pins it. Verified.

⚠ Both are in `docs/js/`, so they need a version bump and ride the satellite coupling — unlike the
Drive/worker work above, which is worker-only and carries no SHELL risk. That asymmetry is a good
argument for doing the worker half first.

### ⚠ THE DRIVE HALF — DECIDED, and it is a SWEEP-THEN-MOVE, not a rename (Seth, 2026-08-20)

> Seth: *"for the sake of organization, especially with ADHD (like me), we need some way in Drive for
> revoked devices to end up in a 'Revoked' or 'Remove' or other folder so that I'm not confused about
> which ones are active and which ones aren't. Also, all the text folders should end up in
> 'Unassigned' in any case… What I don't want is stale Google Drive clutter and no idea which is
> stale and which is not. For someone with my brain that's a real problem. I also don't want to
> delete things carelessly for which it would be good to save originals."*

**The decided shape: revoke → sweep the texts to Unassigned → move the now-EMPTY device folder into
a "Revoked" container.** In that order, and the order is the whole design.

⚠ **WHY A CONTAINER IS SAFE ONLY AFTER THE SWEEP, and unsafe before it.** `buildDriveEstate` defines
a device as a folder whose parent is in `containerParents = new Set([masterId, ...projectIds])`
(v1.js:804, filter at :820-821). Nest a device folder inside a plain "Revoked" folder while its
texts are still in it and: it stops being a device, its texts lose `device`/`deviceFolderId`
(:858-859), and their `projectId` join (:877) resolves against the Revoked folder and yields `''` —
so those texts vanish from every project tab AND from the per-project Unassigned card. Once the
folder is EMPTY that entire failure mode has nothing to act on: the folder simply leaves the estate
view, which is exactly the decluttering being asked for. **Verified against the source, not assumed.**

⚠ **DO NOT give the folder a `flextextRole`** to mark it. The device filter requires
`!roleOf(f) || roleOf(f) === 'crowd'` (v1.js:820-821), so any other role drops it out of `devices`,
and `projects/assign` would reject it as `not_a_container` (v1.js:3202) — the route behind the
panel's "Move to project…" button. A NON-role `appProperties` key is safe; the filter reads only
`flextextDoc` and the role.

**Marking follows the `(done)` precedent** (v1.js:951-960): `appProperties.flextextRevoked='1'` as
truth PLUS a visible name suffix. The tag is what code reads; ⚠ the SUFFIX is what Seth actually
asked for, because an appProperty is invisible in Drive's own UI and the requirement is legibility
while looking at Drive in Finder.

**Reuse `drive-unassign`, do not write a second sweep** (v1.js:2925-3021). It already resolves each
text's OWN project's Unassigned (`targetFor`, :2959-2981), creates it on demand, re-parents, and tags
`flextextUnassigned:'1'` so an adopt can bring it back (:3009-3010, cleared at :3849-3850).
⚠ It is bounded at `CAP = 10, BUDGET_MS = 9000` and returns `remaining` because the ~50-subrequest
cap already killed `drive-purge` twice (:2984-2994). Any revoke-time bulk Drive work inherits that
ceiling and must report a remainder the same way.

⚠ **D1 FLAGS FIRST, DRIVE SECOND.** Revoke today makes ZERO Drive calls — two D1 UPDATEs and a
return (v1.js:3941-3945, verified) — so it cannot half-fail. Revocation must never become dependent
on Drive being reachable. Sweep and move are best-effort follow-ups, resumable, never preconditions.

✅ **AND TWO PROPERTIES ALREADY HOLD, so the move is safe by construction:** minted assignment URLs
name a fileId, never a path (v1.js:1216), and re-check `revoked=0` at redemption (:1861-1866); device
and text folders resolve by ID and by TAG, never by parent (v1.js:1015-1025, :934-937). Moving or
renaming a folder therefore cannot orphan a pending upload or an outstanding URL.

⚠ **WHAT HAPPENS TODAY, which this replaces:** the texts already drift into Unassigned — `sweepUnassigned`
runs only on a FULL panel render, 12 ids at a time (researcher-panel.js:1434, :5064), and its
exclusions do not protect a revoked device's texts because `assignedDocIds()` reads `lastData.instances`
which no longer contains the instance. So it happens silently, partially, and only while someone has
the panel open. The work is to make it deliberate, not to invent it.

### ⚠ "The history metadata file isn't working so far" — it was never built

Seth referred to *"our history metadata file (which isn't working so far, but will be)"*. Checked:
**`flextext-history.json` has ZERO code** — no writer, no reader, no filename constant, no test. It
exists only as a settled DESIGN in `plans/drive-as-truth.md:1408-1425` and §16.13 (:1440-1495), whose
own text says *"Shape (not yet built — this is the decision, not the implementation)"*. Nothing is
broken; it is unstarted. Worth stating plainly because "not working yet" and "does not exist" lead to
very different next actions.

**And the nickname has nowhere to live today.** `manifest.source.name` is `''` in every manifest ever
written — the schema has the slot and none of the three call sites passes a name (app.js:4619,
app.js:6974, researcher-panel.js:3369; verified). ⚠ Do NOT fill it: the manifest is written ONCE and
is immutable by contract (seg-exports.js:1073-1080, pinned by test/manifest-provenance.test.mjs),
while a nickname is researcher-set and renameable — a frozen name would quietly disagree with the
panel after the first rename. The correct carrier is a **name-at-event-time snapshot in the history
file**: *"at time T this device was called X"* stays true forever, and it is precisely what makes the
D1 forget survivable.

**The keystone, and it is small:** the device folder carries NO tag linking it to its instance —
`driveEnsureDeviceFolder` creates it with `parents` and nothing else (v1.js:1029-1031, verified). One
`flextextInstance` appProperty there is the cheapest durable device→folder link that survives both a
folder move and the D1 forget, and it is what makes `manifest.source.id` resolvable from Drive alone.
Everything else in this section depends on it.

### ⚠ TWO LIVE BUGS found while mapping this — independent, small, worth fixing first

Both make bad data accumulate right now, so fixing them stops the pile growing while the rest is built.

1. **Every assigned text ships empty writing systems and a wrong birth time.** The assignment queue
   record writes `at: Date.now()` (researcher-panel.js:3224) but the manifest builder reads
   `rec.queuedAt`, `rec.vernLang` and `rec.analLang` (:3359-3361) — none of which is ever set. So
   `originatedAt` becomes the moment the UPLOAD ran, not the assignment, and `writingSystems` is
   `{vern:'', anal:''}` on every assigned text. Verified.
2. **`manifest.consent.mode` is always `'off'`.** It reads `settings.consentMode` (app.js:4608), a key
   deliberately DELETED during settings migration (`delete s.consentMode`, app.js:250). Nothing reads
   `mode`, so it went unnoticed and no test pins it. Verified.

⚠ Both are in `docs/js/`, so they need a version bump and ride the satellite coupling — unlike the
Drive/worker work above, which is worker-only and carries no SHELL risk. That asymmetry is a good
argument for doing the worker half first.

### Sequencing

⚠ **After Phase C, and specifically after member removal exists** — which it now does. Removing a
member already deletes their grants (2026-08-20); revoked-device cleanup is the same idea one level
down, and building both against one retention helper is cheaper than retrofitting the second.

⚠ **And it wants a `wipe_state`-style guard**: a revoked device may still be OFFLINE IN THE FIELD
holding unuploaded work. Minimising its server-side row must not be read anywhere as "this device is
finished" — the remote-wipe machinery already distinguishes those states and should be consulted
before inventing another.

## LATER: revisit auto-cutting a LONG recording (Seth, 2026-08-20)

> *"At some point we need to revisit what happens with auto-cutting a long text (like 16 minutes
> long), but not right now. That's a file for later issue."*

Raised during the v442 test drive. **Checked immediately, and it is almost certainly working as
designed rather than misbehaving** — which is the useful thing to know before anyone investigates.

`GUESS_MAX_MS = 10 * 60 * 1000` (segments.js:368). A 16-minute recording is over the cap, so
✨ Guess refuses it and says so by name (segment-strips.js:1268 and :1314):

> *"This recording is 16 minutes long, and the lines can only be guessed for recordings up to 10
> minutes. Cut this one by hand — or record in shorter pieces."*

The cap's own comment explains why it is on the INPUT rather than the output: the alternative runs
out of memory AFTER the edit has already replaced the document, whereas a refusal can be explained
before anything happens. It also argues the honest position — *"a 40-minute text is a different unit
of work from a 5-minute one and probably wants splitting first."*

⚠ **So the question to revisit is a PRODUCT one, not a bug**: is 10 minutes the right ceiling, and is
"cut it by hand" an acceptable answer for a 16-minute story? Options if it is not — raise the cap
(and pay the memory cost the comment describes), chunk the detector so length stops mattering, or
offer to split the recording itself first. ⚠ Do not start by "fixing" the detector; start by deciding
what should happen to a long recording.

**Second, separate cost, if the cap is ever raised:** the per-row rendering cost is what actually
scales badly. From the resource audit in this file — each ticker does a `querySelectorAll` over every
row plus ~3 `querySelector` calls per row, EVERY FRAME: ~245 lookups/frame at 60 lines, ~2,600 at
650. That audit's own worked example is "a 40-minute recording, which ✨ Guess can now produce in one
press". Group the two: raising the cap without the idle-gate work would trade a clear refusal for a
slow, confusing success.

**Priority: later, as Seth said.**

## LATER: the recorder and crowd recorder do not refresh themselves after a recording (Seth, 2026-08-20)

> *"Our recorder app needs some work with UI responsiveness and auto-refreshing, as does the crowd
> recorder. I had to refresh the page after recording (although I'm not 100% sure there isn't a
> difference between production and staging on this). But those are later issues."*

Observed on the staging recorder during the v439 pairing test drive: a recording completed and the
list did not show it until the page was reloaded.

⚠ **NOT YET DIAGNOSED, and the report itself flags the doubt worth keeping** — Seth is unsure whether
staging and production differ here. So the first job is to reproduce on BOTH and say which, rather
than to start fixing. A "fix" for a staging-only artefact would be a change to field code for no
field benefit.

Two leads worth checking first, both cheap:
- `renderRecordList()` is called from the save path and from `applyLiveSettings`, but the recorder
  rebuilds its whole view in `renderRecordView()` — if the save path repaints only one of them, the
  new row exists in storage and not on screen, which is exactly this shape.
- The researcher panel has the identical bug class already documented THREE times (viewSig missing a
  field, pending markers, the maintenance banner). Worth checking whether the recorder has its own
  version of "the thing that decides whether to redraw cannot see what changed".

Related and probably the same sitting: this is the same family as the loading-status work in v436 —
a UI that has done something but does not say so. Group them if someone picks this up.

**Priority: later, as Seth said.** Nothing is lost — the recording is saved and a reload shows it.

## KNOWN ISSUE, LOW PRIORITY: un-checking "Done" shows a toast and then nothing (Seth, 2026-08-20)

> *"Unchecking 'done' gives a brief toast promising to relay the command, but no 'pending' UI change
> for the researcher beyond that brief toast, and I'm not sure that command is actually persistent
> and effective. But that's a later, lower priority fix. Can be a known issue for now."*

**Filed as a known issue, deliberately not fixed now.** Two halves, and reading the code separates
them — one of them turns out not to be a bug at all.

**The command IS persistent and effective** (read, not yet re-tested end to end). `toggle-done` calls
`Researcher.setDone`, which is `pushCommand(instanceId, 'setDone', …)` — the SAME durable desired-lane
queue that carries assign, move and uploadDelete. The device applies it in `syncDispatch`'s
`case 'setDone'`, which routes into the device's own `setDocDone()` so the auto-delete-after-upload
gating behaves exactly as a local tap does. A device that is offline, or in a village with no signal,
picks it up on its next poll. So the doubt in the report is answerable: nothing is dropped on the
floor.

⚠ **The real gap is that the panel says so only for four seconds.** `toggle-done` fires the command,
toasts, and records NOTHING. The tag itself does not change until the device reports a fresh
inventory — which on a field connection can be minutes — so a researcher who blinks has no way to
tell whether the toggle registered, and the honest reading of the screen is "it did not work". That
is the same shape as the pairing-code bug: a transient control carrying the only evidence of a
durable fact.

**The fix is small and the mechanism already exists.** The move/delete flow has exactly this solved:
`pendingCmds` + `savePending` + `pendingFor`, with the design rule already written down beside it —
*"Retire pending markers on OUTCOME, never on a clock. A request stays visible for as long as it is
genuinely outstanding."* `toggle-done` simply never opted in. Giving it a pending marker on the same
terms would put a visible "pending" state on the tag until the device's inventory confirms the new
value, and would also stop two panels queueing the same toggle twice.

⚠ Keep the engine gate when it lands: the tag is only a BUTTON when `canSetDone` (engine v138+); an
older install gets a static span, and a pending marker must not appear on something that was never
sent.

**Priority: as Seth said, later.** Nothing is lost today — the command arrives and is applied. What
is missing is the researcher being able to see that, which costs a re-check rather than any work.

## LOW PRIORITY: account deletion leaves the Google grant standing (Seth, 2026-08-20)

Deleting a researcher account — self-delete, or an owner declining a pending one — never calls
Google's revocation endpoint, so the app stays listed under the researcher's third-party access with
Drive permission intact. Confirmed in the code; Seth filed it explicitly as not urgent.

Exposure is limited (the delete destroys our only copy of the refresh token, which is never logged),
but two things stop it being cosmetic: a D1 point-in-time restore brings the token back against a
grant nobody revoked, and a deletion that visibly leaves access behind contradicts what deletion
means to the person who asked for it. Fix, constraints and ordering are in
[`drive-scope-containment.md`](drive-scope-containment.md).

⚠ **The same question about APPROVAL has a split answer, checked 2026-08-20.** Individual approval
does NOT survive a deletion — approving writes only `approved=1` on that row, so a hand-approved
researcher comes back PENDING. But **domain pre-approval does**, which means deleting the account of
someone whose organisation's domain is on the list is not a removal at all: they reappear, approved,
on their next sign-in. That mismatch between what deletion looks like and what it does is the part
worth acting on, and the likely fix is a warning at the moment of the wrong expectation rather than
new mechanism. ⚠ Not by remembering deleted addresses in order to refuse them — that retains personal
data as a side effect of erasing it.

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

## The exported .flextext should point at a RELATIVE FILE, not a URL — and probably ship as a PACKAGE (Seth, 2026-08-14)

> "Our exported flextext files should name the original audio filename with a relative path rather
> than a URL if possible. We shouldn't count on the connect.flextext.app URL being a permanent
> reference, and our FlexText file should point to a permanent reference. Maybe we should make a
> flextext package just like we make ELAN and SayMore packages, with the media tag pointing to that.
> That's a plan for later, not implement now."

### ⚠ Confirmed in the code — a worker URL really does get written into the archival file

`ensureMediaRef` (docs/js/app.js:1602) decides the `location` attribute of the `<media-files>` block:

```js
const location = sourceUrl && isProbablyUrl(sourceUrl) ? sourceUrl : (name || 'audio');
rec.doc.mediaXML = [`<media-files offset-type="milliseconds">
  <media guid="…" location="${location}" /></media-files>`];
```

Two callers, two outcomes:
- **audio attached from a file** (app.js:2823) passes `''` → `location` is the **bare filename**;
- **audio delivered by ASSIGNMENT** (`finalizeAudioDownload`, app.js:2846) passes `media.sourceUrl`
  → `location` is the **worker URL**.

So the two ways a text gets its recording produce two different provenance stories from one
exporter, and the durable one is the accident rather than the design.

**Why a URL is the wrong thing to write, in one line:** it is a delivery address, not an identity.
Those `/v1/textfile/<token>` links are time-boxed (90-day tokens) and the origin is ours to retire; a
`.flextext` opened in FLEx in five years should still say which recording it belongs to.

### The answer is already in this repo

Every OTHER package the suite emits gets this right:
- **ELAN** — `MEDIA_URL="file:///./<name>" RELATIVE_MEDIA_URL="./<name>"` (seg-exports.js:167): a
  relative reference beside a file that ships in the same zip.
- **SayMore** — the filename convention IS the link (`<mediafile>.annotations.eaf`).

So Seth's own suggestion is the design: **a .flextext package = the .flextext + its audio, with
`location` a relative name that resolves inside the folder.** "A permanent reference" here does not
mean a better URL — it means no URL at all.

### What to decide before building

- **The `location` value.** Bare filename or `./<name>`? Settle it against what FLEx itself WRITES,
  not merely what it accepts (docs/FlexInterlinear.xsd is the schema; the behaviour is the question).
- **⚠ ROUND-TRIP FIDELITY IS THE TRAP.** An IMPORTED doc keeps its original `<media-files>` block
  verbatim (`doc.mediaXML`, flextext.js:230) and its phrases keep their own `media-file` references.
  flextext.js:429 records an audit find where filtering those unconditionally "silently unlinked
  every phrase from its media". Any rewrite must touch ONLY blocks this app minted (`rec.mediaGuid`
  set) and never a foreign file's.
- **Does the plain (non-package) export change too?** Rewriting `location` to a filename when no
  audio ships beside it trades a stale URL for a dangling name. Probably still better — a name can be
  re-found, an expired token cannot — but it is a real judgement call, and it is the one that touches
  EVERY existing export path rather than a new one.
- **Where the package is produced.** `assembleSegEntries` (seg-exports.js:857) is already the one
  assembler for the ELAN/SayMore/preview bundles; a `flextext` want belongs beside them rather than
  in a new writer. ⚠ Note it currently gates its whole annotation block on `media && segMedia`.
- **Sequencing with the loose-file converter** — ⚠ **the converter SHIPPED FIRST, in v377.** Its
  `flextext` row is a byte-for-byte passthrough of the file the user handed it (renamed to the
  text's title), which is deliberately the one output that does not re-serialize anything: it cannot
  mint a stale reference because it writes nothing. When the package lands, that row becomes the
  package — one change, in `buildLooseConversion`'s `kind === 'flextext'` branch
  (`seg-exports.js`), and both surfaces follow because neither decides anything itself. Nothing
  about the converter has to be undone first.

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

## Leaving traces: attribution metadata in everything we export (Seth, 2026-08-15) — LATER PRIORITY

> *"I'd also like us to think about how our app can leave traces of itself in places where it
> exports. If there's metadata tags or comments or history metadata where we can leave an imprint
> showing that this was created in flextext editor, that might be useful later on when dealing with
> language software development people — because eventually they can see data evidence of how my
> apps are being used and being helpful if there are metadata traces. That would include even
> places like BWF or audio file metadata (as long as we can do that without invalidating
> archive-quality standards)."*
>
> And immediately after: **"That's a later priority though."** So this entry is the design, not a
> task in flight.

**What this is FOR, and it changes the design.** The audience is not the transcriber and not the
researcher — it is a linguist or a software person at SIL LSDev / Payap / an archive, opening one of
these files years from now with no idea where it came from. The trace has to survive being renamed,
re-foldered, forwarded and re-opened in someone else's tool. That rules out anything that lives in a
sidecar we ship, and points at the metadata fields the destination format ALREADY has.

### What is already stamped (do not re-invent these)

| Where | What it says today | Gap |
|---|---|---|
| EAF (both profiles) | `<ANNOTATION_DOCUMENT AUTHOR="FlexText Editor" DATE=…>` | no version, no URL |
| Derived WAV (BWF `bext`) | `Originator = "FlexText Editor"`, a Description, and an EBU `CodingHistory` line reading `T=DERIVED by FlexText Editor - …` | only on DERIVED audio, which is correct — see below |
| `flextext-manifest.json` | `engine`, `buildTag`, `origin`, writing systems | ⚠ **stays inside the suite** — it is the package manifest the Files ▾ menu reads, not something a linguist ever receives |

### Where a trace is missing, and what the format actually offers

- **`.flextext`** — nothing at all today (`<document version="2">` and straight into the data).
  ⚠ **The riskiest one.** FLEx re-imports these; `docs/FlexInterlinear.xsd` is the schema and an
  unknown element or attribute is how an import starts failing for every user at once. An XML
  **comment** above the root is schema-invisible and the obvious candidate — but confirm FLEx
  preserves rather than chokes, and note that `flextext.js`'s round-trip policy would need to carry
  it. Test against real FLEx before believing anything here.
- **`.fxpa`** — `{ format, version, title, … }` with no generator field. The cheapest and safest of
  the lot: it is **our own JSON format**, `paragraph-model.js` validates it, and readers already
  ignore unknown keys by design. `generator: { app, version, url }` costs one line and one schema
  note.
- **`.preview.html`** — no `<meta name="generator">`. Free, standard, and this file in particular
  gets forwarded to people outside the project, which is exactly the audience.
- **`.pfsx`** — ELAN rewrites it freely; a trace here is worth little. Skip.
- **`HOW-TO-OPEN.txt`** — prose, already ours. Worth an explicit "made with …, <url>" line.

### The archive-quality constraint, stated precisely so nobody has to re-derive it

Seth's caveat is the right one and the answer is **better than "we can get away with it"**: BWF's
`bext` chunk (EBU Tech 3285) is *the standard place for provenance*. `Originator`,
`OriginatorReference`, `Description` and `CodingHistory` exist to record exactly this, and archives
READ them. Stamping them is conforming, not a compromise. What would break archival quality is
different and must stay ruled out:

1. **Never touch the ORIGINAL capture.** The rule the suite already holds: only the derived
   `*.converted-NOT-ARCHIVAL.wav` carries `bext`, and the original bytes are never rewritten. A
   trace is not worth a modified master.
2. **No invented chunks.** A non-standard RIFF chunk is exactly the kind of thing a validator flags
   and a preservation tool strips — or worse, a naive reader mis-parses.
3. **Nothing identifying a PERSON.** Attribution to the APP, not to the user: no email, no account,
   no project name, no device id, no location. These files go to archives with speakers' voices on
   them, and a provenance stamp must never become a privacy leak. This is a hard line, not a
   preference.

### Two practical traps to plan around

- **A version string in every export makes every export change every release.** Several suites
  compare serialized output. The EAF already stamps a `DATE`, so the pattern for handling it exists
  — follow that, and pass the stamp in through `opts` so tests can pin it.
- **One writer, not five.** The moment three formats each hand-roll "FlexText Editor v377" they
  drift. A single `provenance()` helper in `seg-exports.js` (name + version + URL, plus the pieces
  each format wants) is the shape; the loose-file converter is a live reminder of why — it exists
  precisely because two surfaces re-deciding the same thing is the failure mode.

**Sequencing:** unrelated to everything in §1–§3 of `PENDING.md` and blocks nothing. Natural to do
alongside the `.flextext` PACKAGE work (see "the exported `.flextext` writes a worker URL"), since
that entry is already opening the `.flextext` writer and asking what belongs in a header.

## Multi-device researcher sign-in: the GUARDS half (Seth, 2026-08-15) — pairs with the project split

> *"Making sure one researcher can be logged into multiple devices at once (but also think through
> some guards and safeguards to protect that)."*

The mechanism is already investigated (see "Researcher signed in on MULTIPLE DEVICES at once" above):
it is one column with two jobs. **This entry is the other half Seth asked for — what has to be true
before that column is allowed to hold more than one session**, because today the single-secret design
is accidentally providing a safety property, and splitting it removes that property silently.

**⚠ What the current design accidentally protects, and what is lost.** One session secret means a
stolen or borrowed sign-in is self-limiting: the moment the real researcher signs in again, the
attacker's session dies, and the researcher NOTICES because they were logged out. Multi-session
removes both halves at once — the intruder is no longer evicted, and nothing tells the owner. Any
design that adds sessions without adding visibility is strictly worse than what is shipped now, even
though it looks like pure capability.

**So the guards are not optional extras; they are the feature.**

- **A session list the researcher can SEE**, in the panel: device/browser, rough location or IP,
  first seen, last seen, and which one is *this* one. Nobody can act on "someone else is signed in"
  they cannot observe.
- **Revoke one / revoke all others**, from that list, taking effect on the next request rather than
  at the next sign-in. This is what replaces the eviction the old design gave for free.
- **A cap, and an eviction rule when it is hit** (oldest session out). Unbounded sessions is a
  credential-stuffing amplifier.
- **Per-session expiry independent of "stay signed in."** The existing stay-signed-in flag is a
  choice about ONE device; it must not silently become a fleet of immortal sessions.
- **Notify on a NEW session** — the cheapest intrusion detector there is, and the only one that works
  when the attacker never triggers anything else.
- ⚠ **Kr is re-fetched from the server on every sign-in** (that is why a second device works at all),
  so a session is a data key. Revocation therefore has to mean something at the crypto layer too:
  decide honestly whether "revoke" is *this device can no longer FETCH Kr* or *the material it
  already holds is dead*. Only the first is achievable without re-wrapping, and the panel's wording
  must say the true one — the same honesty rule already applied to instance revocation.
- **Sequence with 3.1, not before it.** Sessions become "researcher × project" the moment projects
  exist, and building a session table that does not know about projects means migrating it twice.

**Rate limiting and the login path stay in scope**: the column's second job is the legacy password
hash, so separating them touches `bad_login` (`worker/src/v1.js` ~924). Anything that touches the
login path needs its throttle re-checked in the same pass — that is exactly where a quiet regression
turns into an online-guessable password.

## Classic-textarea edits on an ALIGNED doc: line deletion still truncates spans positionally (2026-08-16)

Adjacent to the round-trip blank-line fix (v382), found while tracing it, NOT fixed there. When an
aligned doc is edited in the CLASSIC textarea (which happens whenever such a doc is open before its
audio attaches, or on a segmentation-OFF device), deleting a LINE removes its paragraph via
reconcileBaseline — but doc.segments then shrinks positionally (tail-clipped), not by removing the
DELETED line's span. Every line after the deletion shifts one span earlier: the same corruption
class as the blank-line bug, just requiring a deliberate deletion instead of an automatic filter.

The v382 fix removes the AUTOMATIC trigger (blanks are no longer filtered on aligned docs), so this
now needs a user to actually delete a line in the classic view of an aligned doc — rare, but the
failure is silent misalignment, the worst kind. Right fix likely lives where reconcileBaseline
reports deletions: aligned docs should delete the corresponding span (or convert the edit into a
segments.js merge), never tail-clip. Needs the LCS pairing's deletion indices surfaced.

## Assign texts to "Google Drive (Unassigned)" (Seth, 2026-08-17) — queued feature

> *"Add the ability to 'Assign' texts to Google Drive (Unassigned) so that a folder is there that
> is ready to be moved to another device as an assignment (and already uploaded)."*

The assignment modal gains a destination that is not a device: **Google Drive (unassigned)**. The
upload leg runs exactly as assign-by-upload does today — flextext + audio + manifest streamed into
the researcher's Drive — but into an `Unassigned/<Storyname>/` folder instead of
`<Device>/<Storyname>/`, and NO device command is queued. Later, assigning it to a device is the
existing move machinery's second leg (the bytes are already up; only the device-assignment command
remains), which is precisely the "parking is a move whose second leg is simply skipped" observation
already recorded under the storage-manager entry — this feature is that observation run FORWARD.

Mechanics notes for whoever builds it:
- The manifest must ride, so the Files ▾ menu's conversions work on parked texts unchanged.
- The panel's existing "Unassigned texts" card becomes the natural surface for parked texts — and
  gains its first DELIBERATE members (today it only shows leftovers). Wording should distinguish
  "parked, ready to assign" from "no longer on any device".
- ⚠ Interplay with the project split (plans/project-split.md, finding II.0.6): the unassigned
  card's classify-then-offer-to-trash behavior is being gated to full-visibility contexts; parked
  texts must remain visible there and the "ready to move" affordance must live behind assignTexts.
- Sequencing: independent of the project split (works per-researcher today); if built first, the
  split's Drive-owner routing inherits it for free.

## Multi-session: PENDING ACTIONS must sync across researcher sessions (Seth, 2026-08-18)

> *"Pending actions SHOULD sync across researcher sessions. An upload can't of course."*

Observed live once two panels could be signed in at the same time: **successful uploads appear in
both panels; PENDING ones do not.** Seth's distinction is the right one — the device's actual
transfer to Drive is happening on a phone and cannot be "synced" as an in-progress thing, but the
fact that a researcher ISSUED an action is server state and should be visible to every panel.

**Why it behaves that way.** The pending indicator is driven by `pendingCmds`, a per-browser
localStorage map (`researcher-panel.js`). The command itself goes to the worker immediately, so the
RESULT converges on the 12-second dashboard poll — but the in-flight marker only ever exists in the
browser that clicked.

⚠ **The harm is not only that the second panel looks emptier.** A panel that does not know an upload
is already in flight will happily issue a second one, which is a duplicate command with a fresh seq
that the device will dutifully run twice. That is the same family of annoyance the per-text Drive
folder dedupe contract (v167) exists to prevent.

**The fix, and it needs NO worker change** — the evidence is already server-side and already reachable:

1. `listView` already returns `desired_rev` per instance and `ack_seq` per install, so "this device is
   behind on something" is derivable today, in every panel, with no new request.
2. For the DETAIL — which doc, which kind — the existing desired-lane route already serves a
   researcher: `GET /v1/instances/<id>?since=-1` returns `{type, desired_rev, settings, commands}` for
   the owning researcher (the `asResearcher` branch in v1.js). The panel has Ki, so it can read them.
3. So: fetch that detail ONLY for instances where `desired_rev > max(ack_seq)`. In steady state that
   set is empty and the poll costs exactly what it costs today; it only spends a request while
   something really is pending.

`pendingCmds` then stops being the source of truth and becomes what it should have been — an
optimistic hint that makes the initiating browser feel instant before the next poll confirms it from
the server.

⚠ This is a `docs/` change, so it rides the Phase B client batch with a version bump and a test
drive, not a hotfix.

## Multi-session: a move is owned by the browser that started it (noted 2026-08-18)

With two researcher panels signed in at once — possible since Phase A — server truth converges
between them on the 12-second dashboard poll, and the settings/key store is already optimistic-locked
with a refetch-and-retry on 409 (`researcher.js`, whose comment predates this work and says "a
concurrent tab wrote first"). Those halves are fine.

What is per-browser is `pendingCmds` and `pendingMoves` in localStorage. They are optimistic markers
for work already SENT, so the underlying change shows in both panels; only the in-flight decoration
is local.

⚠ The exception worth knowing: a text MOVE is two stages, and the sweep that advances it
(`assigned` → destination reports the doc → fire the remove at the source → `removing` → gone) runs
in `renderDashboard` of the browser that started it. A second panel will not advance someone else's
move, so closing the initiating browser mid-move stalls it until that browser returns.

This is a pre-existing single-browser assumption, not something sessions introduced — multi-session
only makes it visible, because a person reasonably expects the other panel to finish the job. The fix,
if it ever matters, is to derive the move state from server-side facts (both inventories already carry
them) instead of a localStorage marker; the sweep's inputs are already the inventory, so it is the
MARKER that is local, not the evidence.

## Invite lifecycle: two cases Seth flagged, investigated (2026-08-19) — fix after Phase C

Seth asked what happens (a) if texts are assigned to a device before its invite is claimed, and
(b) if an invite link is reused by a second or third device. Both checked against the code rather
than left as questions. **(b) is already correct. (a) is real, and worse than it looks.**

### ✅ (b) Invite reuse — already behaves the way Seth wants

- **A second device claiming an already-claimed link gets `409 already_claimed`.** The claim guard is
  explicit (`if (inv.claimed_at) return 409`), and the batch's INSERT/UPDATE are both conditioned on
  `claimed_at IS NULL`, so even a race cannot produce two enrollments.
- **The same install re-claiming succeeds**, deliberately — lost-response recovery, so a device that
  claimed but never saw the reply is not stranded.
- **The researcher genuinely cannot find the link again.** D1 stores only `secret_hash`; the
  plaintext secret is returned once by the mint response and lives only in that modal. Exactly the
  property Seth described wanting.

⚠ **But the adjacent case IS the chaos, from the other direction: an UNCLAIMED link that is
forgotten.** The claim batch revokes every other install of the instance *before any researcher
approval*, so a fresh browser opening a stale link displaces the live field device — it takes a 410
on its next poll, `clearSession()`s, and must be re-paired. With no way to list or revoke invites,
the researcher cannot clean these up, and production carries ~33 unclaimed ones. That is
`plans/project-split.md` VII (rank 3) and is already slated to land WITH Phase C's `createInvites`
capability. Nothing further to do here beyond not losing the connection between the two.

### ⚠ (a) Assigning to a device whose invite is unclaimed — a text that appears NOWHERE

Nothing stops it: the Assign action lives on the instance card, and an instance exists as soon as it
is created, long before any device claims its invite. What follows:

1. `assignment/begin` creates the device folder and the text folder in Drive — **for a device that
   may never enroll.**
2. The assign command queues on the instance, carrying minted `/v1/textfile` URLs whose default TTL
   is **90 days**.
3. An unapproved install receives no commands (the desired lane returns `{pending:true}`), which is
   correct. A newly approved install starts at `ack_seq = 0`, so it then receives **every** queued
   command at once.
4. **If enrollment takes longer than the token TTL, the device receives an assign pointing at
   EXPIRED URLs.** The fetch fails, the text never arrives, and the panel shows the command as
   delivered.

⚠ **And the panel hides it.** `inFlightAssignIds()` (v391) excludes a docId with a live queued assign
from the Unassigned card — correctly, to stop a mid-assignment text being offered for deletion. With
no install, `ackOf()` is 0, so the assign is *permanently* "queued" and the exclusion never lifts.
The text is therefore on no device AND excluded from Unassigned: **invisible in the panel, with a
real Drive folder holding real bytes.** That is a consequence of the v391 fix meeting this case, not
a fault in either alone, and it is the part that makes this worth fixing rather than documenting.

**Fix direction (after Phase C, and it wants the §-numbering of `plans/drive-as-truth.md`):** the
text row's `state` distinguishes *queued for a device that exists* from *queued for one that has
never enrolled*, and the Unassigned exclusion keys off the former only. Whether to refuse the assign
outright, or accept it and show it honestly as "waiting for the device to be set up", is a UI call —
but the current outcome, invisible, is the one option that is certainly wrong. Re-minting the URLs
at approval time would also remove the TTL cliff in (4).

### Invite UI — designed, reverted, queued for after Phase C (2026-08-19)

Seth: *"I think we should make the 'Invite link' button go away after the invite has been claimed
once, just in case… Or just to make it more obvious that that's not a reusable link."*

**Verified first, since the premise mattered:** the secret is NOT persisted anywhere client-side.
`inviteModal` holds it in a local `const` from the mint response; a grep for any localStorage,
sessionStorage or IndexedDB write touching invites is empty. D1 stores only `sha256(secret)`. So it
is genuinely unrecoverable once the modal closes — by anyone, including the researcher.

⚠ **Do NOT hide the button after a claim.** A fresh claim revokes the prior install by design
(single-live-device, §D.4), which makes re-inviting the *supported recovery path for a lost or broken
phone*. Hiding the button would remove the only way to recover one.

**What to build instead** (drafted and reverted; two i18n strings per language plus ~6 panel lines):

1. **Relabel the card button** to *"Replace device…"* when the instance already has an install. The
   action is a replace, not an add, and saying so is the difference between recovering a broken
   phone and unknowingly signing out a working one.
2. **Say the link cannot be shown again.** The modal says "used only once", which reads as a property
   of the LINK; it never says nobody can retrieve it, so a researcher who closes the modal expecting
   to find it later has already lost it.
3. **Warn when replacing**: opening a new link signs the current app out — it keeps its texts but
   stops syncing until set up again.

⚠ Trap hit while drafting: the explanatory comment contained backticks inside a template literal —
the recurring trap already recorded in this repo. Keep prose comments OUT of template literals.

### Consent prompt: the device side is done, the CROWD side is not (2026-08-19)

Seth: *"We don't want consentAudio to work with a free URL. It should instead be uploaded to Google
Drive by a file picker, and stored in the device folder root (Crowd Recorders also have 'device'
folders)… Our UI doesn't have the consentURL textbox anymore."*

✅ **Right about the device settings, and it already works that way.** The renderer special-cases
`consentAudioUrl` into a hidden value carrier + a status line + an Upload button + a file picker,
with the reasoning recorded in situ (Seth, 2026-08-12: showing the box *"implied a URL was still
something a researcher pastes"*). The worker's comment confirms the destination: `'consent-prompt'
targets the DEVICE folder`. Nothing to do.

❌ **The crowd recorder still has the raw text box.** `#cr-caudio` is a plain `<input>` with no
picker, and `CROWD_DEFAULT_CONFIG.consentAudioUrl` is a free string — so pasting a URL is still the
only way to give a crowd page a spoken prompt, which is exactly the shape Seth wants gone.

**Why it is not a copy-paste of the device flow:** the upload path is INSTANCE-scoped
(`/v1/instances/<id>/texts/<docId>/assignment/upload/...`), and a crowd recorder is not an instance
— it is a `crowd_recorder` row with its own `oauth_folder_id`. So it needs a crowd-side upload
route rather than a reused one.

**Shape of the work** (additive, therefore deployable on its own per the standing backend rule):

1. **Worker:** `POST /v1/crowd/<id>/consent-prompt/upload/{start,chunk,finish}` — the same chunked
   mechanism, resolving the destination through `driveEnsureCrowdFolder` and tagging the file
   `flextextRole: 'consent-prompt'`. Ownership-resolved first, in the pattern of the revoke fix.
2. **Panel:** replace `#cr-caudio` with the device flow's exact trio — hidden carrier, status line,
   Upload button — reusing `paintPromptState` so the two read identically.
3. **Then** stop accepting a pasted string: once both surfaces mint their own, `consentAudioUrl`
   can be validated as a worker-minted URL rather than free text.

⚠ **This is why the audit's promptUrl fix mattered.** A consent prompt is now deliberately minted
UNSCOPED (v1.js, assignFinish) — a crowd recorder has no instance, so an instance-scoped token could
never have worked for one. Had the scope shipped, step 1 would have been impossible without
unpicking it.

## From the v395 test drive (Seth, 2026-08-19)

**1. Restore a trashed text from the storage modal.** *"Trashing texts works (though we don't have a
way to restore them in our storage modal, that would be a good future release)."* Drive keeps trashed
files for 30 days, so the bytes are there — `files.update` with `trashed:false` is the whole
operation. ⚠ The modal already has `drive-purge`, which is **permanent and unrecoverable**; shipping
un-trash without making the difference between the two obvious in the UI would be worse than shipping
neither. The listing already fetches the trashed set (`driveListAll(access, true)`), so the data side
is done.

**2. Rename a text from the researcher panel — and rename its folder with it.** Seth: *"we should
have a way to rename texts in the Researcher panel (and renaming a text should also rename the
folder, at least the part of the folder name that is the title). That's probably a client-side code
change though, not a worker change."* Correct that it is mostly client-side — but not entirely, and
the exception matters:
- The folder name is display only; identity is the `flextextDoc` tag, so a rename cannot orphan
  anything. That is what makes this safe at all.
- ⚠ The `(done)` suffix is part of the folder name and is written by `driveTextHousekeeping`, which
  derives its base by stripping `/\s*\(done\)\s*$/`. A rename must go through the same stripping rule
  or a renamed done-text becomes `New name (done) (done)`.
- ⚠ A crowd text's folder is named `<recorder> — <timestamp>` **because the contributor never enters
  a title** (Seth confirmed this is working as designed). Renaming those is the main use case, which
  argues for doing this soon rather than late.
- The manifest records the title at package time and is written once; a later rename does NOT rewrite
  it. That is correct and deliberate (plans/drive-as-truth.md §16.12) — the manifest is a birth
  record. If the panel ever shows "manifest title" it must be labelled as the original.

**3. Auto-segmentation: how silence becomes lines — a researcher-configurable device setting.**
Seth: *"we need to consider having our auto-segmentation have an option to either segment out as much
empty audio as possible as empty lines OR have the same number of segments as speech lines (so like
the segment starts near the beginning of suspected speech, but then empty silence isn't split at the
end until it's near another speech segment, so that empty lines don't trip up mother-tongue speakers
as they might). That should be a device setting the researcher can configure (including turning the
auto segment feature off altogether)."*

Three settings, not two — **off** is a first-class choice. The distinction is what happens to a
silence run between two utterances: *split it out as its own blank line* (today's behaviour) or
*absorb it into the preceding speech span* so the line count equals the utterance count. The second
is the one that matches how a mother-tongue transcriber reads the strip — a blank row with no text is
a thing to explain, and in the field it reads as a mistake.

⚠ Blank lines are **real timed spans** in the segmentation model, not padding, and the exports depend
on that (`segmentsFromOffsets`, the EAF/SayMore tiers). So "absorb" must change where the boundary is
DRAWN, never make a span text-only — the invariant that alignment edits never touch text, and that
text is sacred, applies in both directions.

**4. Unassigned texts do not reparent into the Unassigned folder.** Seth saw a text tagged
`unassigned` in the panel while its folder still sat inside the device folder in Drive. **Known and
expected** — `drive-unassign` is fully implemented in the worker, idempotent, and has **zero callers**
in `docs/` or `satellites/` (drive-as-truth §7, second precondition). Seth: *"maybe it won't [work]
until we build D1 and other drive-as-truth changes."* Partly — wiring the sweep is client-side and
does not need the D1 index, so it can land before Phase C. It is listed as a precondition precisely
because it is cheap and makes Drive stop contradicting the panel.

## A duplicate upload seen in the wild (2026-08-19 snapshot)

`Dairi Hike with Health Workers 2026-08-18-1442.flextext` appears **twice**, byte-identical (28,384),
uploaded **20 seconds apart** (05:42:34 and 05:42:54). One text, one device, two files.

Not urgent — a duplicate `.flextext` is harmless next to the audio, and Lane B keeps every timestamped
revision on purpose, so two in the same minute is untidy rather than wrong. But 20 seconds is too
close to be two deliberate saves, which makes a double-fire more likely than a coincidence: either the
upload queue enqueued the same doc twice, or a save-then-send raced an autosave.

Worth a look when the upload queue is next open, with the snapshot as the evidence. ⚠ Do NOT
"deduplicate by content hash" as a fix — identical bytes at different times is a legitimate state
(a text saved, unchanged, and saved again), and collapsing it would hide the actual double-fire.

## Assign to a device that has not been paired yet (Seth, 2026-08-19)

> *"making sure new devices that haven't paired yet (via invite link) can have texts assigned to them
> and show those as pending (until the invite is accepted and then they're successfully downloaded)."*

The natural workflow: create the device, assign its first texts, hand over the phone and the invite
together — rather than pair first, then walk back to the panel to assign.

**⚠ This is probably MOSTLY BUILT ALREADY, which is the useful part of filing it now.** Checked
rather than assumed:

- An `instance` row exists from `POST /v1/instances`, before any invite is minted or claimed.
- **Ki is per INSTANCE, not per install** (`settingsCache.wrappedKis[instanceId]`), so a command can
  be encrypted for a device that does not exist yet. That is the fact that makes the whole thing
  possible, and it is already true.
- Commands land in `desired_blob` and are served by seq, so one queued before the first claim is
  simply waiting when the device first polls. No expiry, no ordering problem.

So the DATA path likely works today. What needs doing is the panel:

1. **Render an instance with zero installs** as a real card that can be assigned to — today the tiles
   are driven by installs, so an unclaimed instance shows little or nothing.
2. **Show those assignments as pending, and say WHY** — "waiting for this device to be set up", not
   the generic waiting-for-device wording, which would look like a fault rather than the expected
   state.
3. **Do not let it look stuck.** An unclaimed device may sit for days between creation and someone
   walking to a village with it. Distinguish "not set up yet" from "set up but offline".

⚠ **Check first, before building anything:** whether an assign to an instance with no installs
actually succeeds end to end today. If it does, this is purely a rendering job. If it does not, the
place it fails is worth knowing precisely — the desired lane has a `pending: true` branch for
PROVISIONAL installs (status !== 'approved'), and a not-yet-claimed instance is a different state
again: no install row at all.

⚠ **And check it against §16.19.** Anything touching the desired lane's install/instance lookups is
in bricking distance — a live device must never read as absent or revoked. An instance with no
installs is exactly the shape a careless guard would treat as "gone".

### Note toward "B" — a flextext may be OPTIONAL in an assignment (Seth, 2026-08-19)

Raised and immediately parked, but worth keeping: *"for assignments a flextext is optional."*

If true, the crowd → device handoff may be much cheaper than plans/drive-as-truth.md §16.10 "B"
assumes. That entry says the blocker is that `/adopt` extracts a `.flextext` from the source zip and
a crowd zip has none. But if an assignment can legitimately carry **audio only** — a recording to be
transcribed from scratch, which is exactly what a crowd submission IS — then the fix may be to let
the delivery path skip the flextext rather than to restructure how crowd uploads.

⚠ Check before designing anything: whether `/adopt` and `/move` genuinely tolerate a missing
flextext end-to-end, or merely do not crash. The panel, the command, and the device's intake all have
to agree that audio-only is a complete delivery.

## ⚠ Timestamps are in TWO different timezones, unlabelled (Seth, 2026-08-19)

> *"what timezone are they in and how is that set? At some point we'll want to clarify that and let
> the researcher set that."*

Checked rather than guessed, and the answer is worse than "which one": **there are two, nine hours
apart, side by side in the same Drive folder.**

| Written by | Code | Timezone |
|---|---|---|
| Worker — crowd text folder names, submission zip names | `new Date(at).toISOString()` | **UTC** |
| Client — `.flextext` filenames | `d.getFullYear()…getHours()…` | **the DEVICE's local time** |

Both visible in the 2026-08-19 snapshot of the production estate:

- `Test Crowd Recorder — 2026-08-19 09_23` — modified `11:32 UTC`. The name is UTC; at UTC+9 the
  researcher recorded it at **6:23 PM** and the folder says 09:23.
- `Dairi Hike with Health Workers 2026-08-19-1559.flextext` — modified `07:04 UTC`, i.e. 16:04 local.
  The name is **local**.

So a researcher browsing one folder sees two conventions with no marker distinguishing them, and the
crowd one is off by their whole UTC offset — which for Papua is nine hours, enough to name a folder
with the wrong DAY either side of 3 PM.

⚠ **The device one cannot simply be switched to UTC.** A field transcriber names and finds their work
by when they did it; "1559" meaning 3:59 PM to them is correct and useful. The bug is the crowd side
being UTC *and* the absence of any label.

**Options, roughly in order of cost:**

1. ✅ **DONE (v411) — label it.** Agreed as the interim fix (Seth, 2026-08-19). The crowd text folder
   name now ends `… UTC`, and both zip-name paths carry ISO 8601's `Z` — needed because the colons
   were already replaced with dashes for filename safety, which loses the usual visual cue. New names
   only; existing ones stay as they are, which is fine because folder names are display-only and
   identity lives in the `flextextDoc` tag.
2. **A researcher-set timezone** on the account, used by the WORKER for anything it names. The device
   keeps local time, which is right for the device.
3. **Derive it** from the researcher's browser on first sign-in as the default for (2), so nobody has
   to know what UTC+9 means.

⚠ Whatever is chosen: it can only affect NEW names. Renaming existing folders to fix a timestamp
would rewrite history for cosmetics — and folder names are display-only precisely so nothing depends
on them (identity is the `flextextDoc` tag), so old names can simply stay wrong.

## Move the site builds off Cloudflare's git integration onto GitHub Actions (Seth, 2026-08-20)

> *"changing our build process (if we can do that without disrupting any current cloudflare site
> content) so that builds are only triggered by wrangler on GitHub workflows and not by every single
> repo change detected by CloudFlare."* — explicitly to be explored AFTER the productionWeb build.

**This is better than the dashboard "build watch paths" idea recorded in CLAUDE.md, and the reason is
not the filtering — it is WHERE the filtering lives.** GitHub Actions has `on.push.paths` natively,
so the rule sits in the repo: reviewable, diffable, and impossible to have quietly differ between
five Workers. A dashboard setting is five separate places to get right and nowhere to see them.

**The pattern is already proven here.** `worker-deploy.yml` deploys the connectivity Worker with
`wrangler-action` and the same two secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`). Five
more targets is the same mechanism, not a new one — and one workflow run could deploy all five,
turning six builds per release into one.

**Cost: free.** Public repo, standard `ubuntu-latest`. (Stated because CLAUDE.md requires an explicit
estimate before any `.github/workflows/**` change — which this is.)

### ⚠ Four things that must survive the move, or it is a downgrade

1. **THE STRUCTURAL GUARD.** `apps/*/build.sh` currently REFUSES to build when the branch is not
   `productionWeb` and was not routed through `deploy.sh` — that is what makes it impossible for a
   feature branch to overwrite the live site. Any workflow replacing it needs an equivalent that is
   structural, not a flag someone remembers to set. ⚠ A `workflow_dispatch` with a free-text branch
   input is precisely where production gets overwritten by a typo.
2. **BRANCH PREVIEWS.** `https://<branch>-<worker>.68mh29kgsd.workers.dev` are automatic today, and
   the whole feature-branch policy leans on them ("test a MAJOR feature on its OWN branch preview").
   Manual-only deploys would quietly kill that. Keep a push-triggered workflow for non-production
   branches — with `paths:` filters, which is what removes the waste without removing the previews.
3. **VERIFY DISCONNECTING DOES NOT UNSERVE ANYTHING.** A deployed Worker should keep serving when its
   build integration is removed — the deployment is not the connection. ⚠ Should, not does: confirm
   on ONE Worker (the crowd one, least critical) before touching the editor or the researcher panel.
4. **THE VERSION-BUMP SURFACE.** Any `paths:` filter must include everything `bump-version.sh`
   touches — `docs/sw.js`, `docs/js/i18n.js`, and all three satellite `sw.js` files — or a release
   will look pushed and silently not deploy, which is the exact failure CLAUDE.md's deploy-order
   section exists to prevent.

### ✅ DECIDED SHAPE: two manual workflows, nothing automatic (Seth, 2026-08-20)

> *"Move our build process to a manual GitHub workflow that only runs when we deliberately run it.
> One for staging, one for productionWeb."* … *"(Or sub-actions)"*

⚠ **This goes further than the `paths:` filters proposed above, and supersedes them.** Filters make
irrelevant pushes free; manual dispatch makes EVERY build deliberate. Given that that day's cost was
not only irrelevant pushes but also relevant ones firing before anyone was ready to test, that is the
stronger answer.

**The shape:**

- `deploy-staging.yml` — `workflow_dispatch`, deploys all five Workers to their staging aliases.
- `deploy-production.yml` — `workflow_dispatch`, deploys all five to production.
- Both call ONE reusable workflow (`workflow_call` — the "sub-actions" idea) that takes the target and
  loops the five app folders, so the deploy logic exists once. Five copies of a deploy step is the
  drift this repo has been fighting all week.
- Cloudflare's git integration is then disconnected, per Worker, and nothing builds on push.

⚠ **THE GUARD THAT MUST BE STRUCTURAL.** `workflow_dispatch` lets the caller choose a ref, so the
production workflow can be pointed at any branch — which is exactly how a feature branch overwrites
the live site, the thing `apps/*/build.sh` currently refuses by construction. The production workflow
must FAIL on any ref other than `productionWeb`, as its first step, before it can deploy anything. A
comment saying "only run this on productionWeb" is not a guard.

⚠ **The trade being accepted, so it is not discovered later:** branch previews stop being automatic.
The feature-branch policy leans on them ("test a MAJOR feature on its OWN branch preview"), and after
this they exist only when someone dispatches the staging workflow. That is a real loss, deliberately
taken — it is the same button either way, and the cost of forgetting to press it is a preview that
does not exist rather than a build nobody wanted.

**Cost: free** — public repo, standard `ubuntu-latest` runners. Stated because CLAUDE.md requires an
explicit estimate before any `.github/workflows/**` change, and this is one. Seth's instruction above
is the approval.

### ⚠ Sequencing — FIRST, and ahead of the branch collapse

> *"That's probably actually more important than merging main and productionWeb. And more solves the
> root problem."* (Seth)

⚠ **This reverses what this section said when first written** ("do it after the collapse, so the
workflows are written once"). That was optimising for a small cost — a few lines of branch handling
rewritten — and missing the larger point.

**The collapse is an optimisation; this is the root cause.** Collapsing halves the number of builds a
release costs, but every push still builds. Moving to Actions with `paths:` filters means an
irrelevant push builds **nothing at all** — the plans, notes, tests and worker changes that made up
most of that waste stop costing anything, whatever branch they land on. The collapse then takes
what remains from two to one.

**And the risk profile points the same way**, which is the part that settles it:

| | Actions move | branch collapse |
|---|---|---|
| reversible? | yes — reconnect the git integration | not cheaply: the branch NAME is load-bearing in the Pages source, the sync-satellites trigger, `deploy.sh` routing, `check-release-integrity.sh`'s default ref and the pre-push hook |
| blast radius if wrong | a build does not fire; nothing is served wrongly | the release mechanism itself |
| fixes the waste? | at the source | halves it |

Doing the reversible root-cause fix before the irreversible optimisation is the right order, and the
few lines of branch handling that get rewritten afterwards are a trivial price for it.

## Export to Bloom books / Bloom Library (SIL) — explore next week (Seth, 2026-08-20)

> *"for the sake of interesting stakeholders who aren't interested in linguistics and language
> documentation for its own sake until they see it applied to things they care about: explore an
> export path from our app's results to Bloom books (Bloom Library by SIL)."*

**The strategic point is the real one.** A recorded, transcribed, translated text is an artefact only
a linguist values. The same content as a *book a child can read and hear* is legible to funders,
churches, education offices and communities themselves. This is the shortest path from what the app
already produces to something a non-specialist can hold.

### ⚠ The piece that makes this OURS rather than a generic export

Bloom's **Talking Book** feature pairs audio with text blocks — and segmentation already gives us
**per-phrase time offsets against the original recording** (§ Audio Segmentation Mode). Most people
making a talking book have to record it phrase by phrase inside Bloom; we would arrive with a natural
recording already aligned. That is a real advantage and it is worth leading with.

### What maps, and what does not — say this out loud rather than discovering it in a demo

| FlexText | Bloom |
|---|---|
| baseline phrase | a text block on a page (vernacular) |
| free translation | the second language field on the same page |
| aligned segment times | per-block talking-book audio |
| **word glosses** | **nothing — lost in this direction** |
| — | **images, which we have none of** |

⚠ **So the export is a SCAFFOLD, not a finished book**, and it must be described that way. A book with
no pictures is not a book anyone wants; somebody still has to illustrate it. Overselling this to a
stakeholder is worse than not building it.

### Verify before committing to a shape (a morning's work, not a guess)

- **The package format** — a Bloom book is HTML-plus-assets in a folder; `.bloomPUB` is the bundled
  form. Confirm what current Bloom actually imports, and from which version.
- ⚠ **The audio model.** Bloom has historically wanted ONE AUDIO FILE PER TEXT BLOCK rather than
  offsets into a long recording. If that still holds, export must SPLIT the recording per segment —
  which we can already do (the preview page does per-segment playback, and `seg-exports.js` writes
  derived WAVs), but it changes the deliverable from "one file plus timings" to "N files plus a
  manifest", and that is the difference between an afternoon and a week.
- **Language codes** — we hold vern/anal writing systems; Bloom uses BCP-47. Probably a direct map,
  worth confirming against a real book.

### Scope the first attempt narrowly

Produce a FILE the researcher imports into Bloom. ⚠ Do NOT start with Bloom Library upload — that is
an account, an API and a publishing decision (who owns it, what licence, is the community consenting
to public hosting) and it drags the consent model in with it. One thing at a time: a file first, and
whether it should ever be published is a separate conversation with its own ethics.

## Three deferred at the projects release (Seth, 2026-08-20) — none a blocker

Recorded at the moment of shipping, with their priority as stated rather than as re-guessed later.
The release went out because a researcher was waiting behind the maintenance banner to set up a new
device, and the migration is the piece that was holding him.

### 1. ⚠ Radio/tile alignment — SUITE-WIDE, and newly urgent for a reason

> *"radio tile alignment is a problem ACROSS our app suite that we should audit and clean up later.
> Just so far it hasn't been a big, blocking problem. But it actually could cause problems for the
> users who are joining now."*

The move modal was fixed in v429 (tiles), but the CAUSE is general: `.rp-field` is a stacked
label-above-input layout, so any bare radio rendered inside one sits centred ABOVE the following
option's text. Everywhere that pattern appears, the control and its label are visually mismatched.

⚠ **Why it stops being cosmetic:** it has been survivable because the people using it already knew
what the options were. New researchers do not, and a mis-selected option in a modal that moves data
is not a cosmetic outcome. `tileOpt()` in researcher-panel.js is the fix to propagate; the audit is
finding every `rp-field` containing a radio or checkbox.

### 2. The target Unassigned box does not show the text until the source device finishes

Cosmetic, and it does work. A text filed into another project's box is re-parented immediately, but
the row appears only once the upload-first removal completes — because until then it is legitimately
still on the source device and shown as in-flight there. ⚠ So the honest fix is not to show it in two
places at once, but to show it in the DESTINATION as pending too. Low value, real subtlety.

### 3. A text cannot be moved from one project's Unassigned to another's — NEXT release

> *"looks like I can't move texts from one project's unassigned to another's. We do want that to
> work, but we don't want to make it a pre-condition for pushing a release."*

v429 added another project's box as a destination from a DEVICE. The source-less flow
(`adoptTextModal`) offers device destinations plus its own project's box, and the cross-project box
path there was not wired — so an already-unassigned text has nowhere to go but a device. The pieces
all exist (`drive-unassign` takes a target project, `confirmCrossProjectFile` exists); this is
connecting them, not building them.

## The editor should show its own paired device nickname (Seth, 2026-08-20)

> *"Would be good for our FlexText Editor UI to show its own paired device name/nickname somewhere in
> the UI, that would be helpful for a researcher to be able to see."*

A paired editor currently gives no on-screen answer to "which device am I?" — the nickname exists only
in the researcher's panel. That is fine for a field user, who has one device and never wonders, and
unhelpful for the researcher, who is looking at three of them and has to guess from context which
window is which.

⚠ **The nickname is already on the device**, so this is probably display-only: the instance's
`nickname` rides the pairing, and the panel's rename pushes a change. Check before building whether
the device stores it or merely receives it — if it only receives it, this needs a place to keep it,
which is a bigger change than it looks.

**Where:** the same corner as the version badge is the obvious spot, and it is already the "what am I"
line. ⚠ But that badge is deliberately `pointer-events:none` and very quiet; a device nickname is more
useful than the version to the person asking, so it may deserve better placement rather than being
appended to a line designed to be ignored.

⚠ **Not the researcher panel's "This device" card** — that is the browser the panel is running in,
which is a different question with a confusingly similar name.

## Project-level default settings — after the multi-researcher release (Seth, 2026-08-20)

> *"We will want to have project-level default settings for new devices with the ability to apply
> those settings to daughter devices. But that's for later, after we get the multiple researchers
> release working later today."*

**It is a TEMPLATE, not inheritance** — and the wording says so: *defaults for new devices*, plus an
explicit *apply to daughter devices*. That is the simpler and much safer of the two shapes:

| template (this) | live inheritance (not this) |
|---|---|
| copied into a device at creation; the device then owns its settings and may diverge | the project's value wins continuously, and a device's own setting is either overridden or a permanent exception |
| "apply to all" is a deliberate act with a visible before/after | every project edit silently rewrites every device, including ones tuned for a reason |
| no new precedence rules anywhere | every read of a setting needs to know which layer won |

⚠ **It probably needs NO new storage and NO worker change.** Device settings already live in the
researcher's E2EE settings blob (`settingsCache`, wrapped under Kr, `desired_blob`/`desired_rev` per
instance). A project default is one more key in that same blob, keyed by the project's FOLDER ID —
the same identifier the estate already uses. No D1 column, no new authority, nothing to drift, and
the worker keeps seeing only ciphertext.

**Two rules to carry over from the migration work, because they are the same problem:**

- ⚠ **"Apply to daughter devices" OVERWRITES settings somebody may have tuned per device** — a
  recording format chosen for one handset, a consent mode for one village. It must PREVIEW: which
  devices, which settings, what changes to what. Same discipline as the folder migration, for the
  same reason.
- **A device created into a project takes the template at birth** — which is exactly the path v426
  built for folders (`projectFolderId` at instance creation), so the hook already exists.

⚠ **Sequenced explicitly AFTER the multi-researcher release**, and not merely by preference: project
defaults are settings that a MEMBER may or may not be allowed to change, so building them before the
grant model exists would bake in an answer to a question that has not been asked yet.

## The scheduled DRIFT DETECTOR — designed, not built (Seth, 2026-08-19)

> ⚠ **SEQUENCED, and the order is deliberate** (Seth): *"Let's do these audits as soon as we've
> got our project/researcher split up and running and proved working and functional."* Both this
> and the client-vs-server guard audit come AFTER the split is proven — not before, and not
> alongside. Auditing a system that is still moving produces findings that expire before they are
> acted on, and a drift detector written against a half-built model would encode the half.


> *"a scheduled drift detector is a good idea, and it should e-mail me when it detects drift with
> technical details in a JSON attachment that I can feed to you as diagnostic info. Maybe also log
> entries in a D1 table that you can use for troubleshooting?"*

### ⚠ DETECT ONLY. It must never correct anything.

The distinction is the whole design, not caution. A job that silently repairs drift **hides the bug
that caused it** — and it runs unattended across every project, so if its notion of "correct" is
wrong it propagates that error everywhere before a human looks. Today's own bug is the illustration:
a nightly repair could have re-tagged those devices every night for a year while the broken join went
right on being broken. Detection makes defects louder; correction makes them quieter.

Narrow, provably-idempotent repairs can be added later, one at a time, each behind its own flag. The
default stays: report, never touch.

### What it checks

Read-only, from `driveListAll` plus the D1 rows for one researcher:

1. a container whose parent is neither master nor a project folder
2. an instance with a NULL `oauth_folder_id`, or one pointing at a missing/trashed folder
3. two folders claiming the same `flextextDoc` tag (duplicate text folders)
4. more than one folder tagged `flextextDefault=1` (the duplicate-default-project failure §16.27 guards against on the client)
5. a text folder under no container at all
6. `instance.project_id` / `crowd_recorder.project_id` disagreeing with the folder's real parent in Drive
7. an Unassigned folder that is not a direct child of a project, or two under one project
8. orphans — any object whose parent is not in the live set

### ⚠ Three classes of finding — and only ONE of them mails

> *"The e-mail should only happen on change and only when a drift is detected that needs fixing. And
> only if it's a drift that our system doesn't already auto-correct."* (Seth)

Right, and it needs one guard or the exemption becomes a blind spot. Several kinds of drift in this
system genuinely DO heal themselves during ordinary use: `driveEnsureDeviceFolder` and
`driveEnsureTextFolder` resolve by id and recreate a trashed folder on the next upload;
`driveEnsureCrowdFolder` backfills a missing `flextextRole` tag when it next runs; the unassigned
sweep is estate-driven and self-healing; the projects migration is idempotent, so an interrupted run
finishes on the next press.

| class | example | what happens |
|---|---|---|
| **benign** | an empty trashed `Default Project` left by a migrate→undo cycle | logged, never mailed — it is expected residue, not drift |
| **heals** | a device folder trashed by hand; a crowd folder missing its role tag | logged; mailed ONLY if it survives N consecutive runs |
| **needs-human** | two folders claiming one `flextextDoc`; two `flextextDefault=1`; D1 and Drive disagreeing about a project | mailed on change |

⚠ **THE GUARD, and it is the point of the table: "self-healing" is conditional on the operation
actually happening.** A device folder heals on the device's next upload — from a device that may
never upload again. A crowd tag backfills when that recorder next receives a submission — from a
recorder that may be paused for a year. Exempting those outright means the one case where the
self-heal never fires is exactly the case nobody is told about.

**ESCALATION IS A TIMER. Nothing else.** A `heals` finding still present after N runs is mailed.

The sharper-sounding alternative was to verify causally — record for each finding which operation
would fix it (`healBy`) and which observable proves that operation ran (`healWitness` —
`install.last_seen_at`, `crowd_recorder.submit_count`), then escalate the moment the witness advanced
and the drift was still there. It asks the better question: not "has enough time passed" but *"did
the thing that would have fixed this actually happen?"*

**It is not being built, and the reason is worth more than the feature** (Seth):

> *"a timer might be more reliable… because 'should have corrected' needs to keep getting updated
> with new features and changes. And has its own drift potential that we'd rather not have to
> police."*

⚠ **THE CAUSAL TEST IS ITSELF A MODEL THAT DRIFTS.** `healBy`/`healWitness` is a hand-maintained
description of which operation heals which fault. Every feature that changes what self-heals silently
invalidates a row, and nobody will remember to update it — so the drift detector would acquire drift
of its own, and need its own detector. That recursion is the thing to refuse, not to manage.

Two further reasons the trade is bad even before the maintenance cost:

- **The witness can be wrong in both directions.** `last_seen_at` advances on any contact, not
  specifically on an upload that would run `driveEnsureDeviceFolder` — so it moves without the heal
  firing, and can fail to move when it did.
- **A timer errs toward telling you too much; a mis-witnessed causal test errs toward telling you
  NOTHING.** For a monitor, false silence is much the worse failure — the reasoning `sendEmail`
  already records about a system that lies about its own delivery: you stop watching the inbox AND
  believe the silence means safety.

**What is actually given up:** on a busy device, a broken self-heal would have been visible in minutes
instead of N days. That is the entire benefit, and it does not buy a permanently stale table.

### ⚠ The one design that WOULD make a causal signal maintainable — if it is ever wanted

> *"Unless you've got some idea of how to reliably keep track of what 'should have corrected' without
> having to manually define and duplicate 'what should have corrected' with each auto-correction
> change or guard we build."* (Seth)

There is one, and it works by inverting where the knowledge lives. **Stop describing what heals; make
the healing code declare that it ran.**

The unmaintainable version is a table in the detector saying "fault X is healed by operation Y,
observable as Z" — a second copy of a fact that lives in the healing code, in a different file, which
is exactly the duplication that rots. Instead, every self-healing chokepoint —
`driveEnsureDeviceFolder`, `driveEnsureTextFolder`, `driveEnsureCrowdFolder`, the sweep — stamps the
object it touched: **`healed_at`, plus what it did.**

The escalation rule then becomes generic, and carries no model at all:

> *A healing path touched this object after the fault was first seen, and the fault is still here.*

No mapping. No per-fault knowledge in the detector. It never needs updating when a new
auto-correction is added, because it does not know what corrections exist — it only knows that
something claimed to have handled this object and the object is still wrong.

**What it still costs, stated honestly:** a new healing path has to remember to stamp. That is a
manual step. But it is a *local* one — a line in the function that already does the repair, not a row
in a distant table — and unlike a mapping it can be ENFORCED: the same idiom as
`check-native-containment.sh`, a script that enumerates the ensure/heal helpers and fails when one of
them does not record. Enforceable duplication is a different animal from unenforceable duplication.

**The zero-cooperation variant, and why it is worse:** Drive's own `modifiedTime` already says
whether an object changed since the fault was seen, with no code changes anywhere. But *any*
modification counts — an upload, a rename, a re-parent — so "touched and still broken" stops meaning
"a repair ran and failed" and becomes noise. It needs nothing and proves nothing.

⚠ **None of this changes v1: the timer is still the gate.** This is recorded so that if the timer
does prove too slow, the causal signal can be added *without* the maintenance burden that ruled it
out — and so nobody rebuilds the table version, having forgotten why it was rejected.

⚠ **The test for whether this was the wrong call, so it can be revisited on evidence rather than
taste:** if real reports show `heals` findings routinely sitting out the full timer while the device
was demonstrably active throughout, the timer is too slow and a causal signal earns its place. Until a
report says that, it has not.

### ⚠ CAN THE DETECTOR BE TRUSTED NOT TO DRIFT ITSELF?

> *"We don't want to have to build the drift monitor and update it with everything else we build —
> except when we make major architecture changes that redefine what normal/non-drift should look
> like."* … *"And can we trust it not to drift itself?"* (Seth)

**Mostly yes, and the design is what buys it — not discipline.** Two separate pieces, with different
answers.

**1. The heal stamp: cannot drift into unsafety, only into uselessness.**

It is a fact emitted at the moment of action, not a description maintained elsewhere, so it has no
"stale" state — a stamp either happened or did not. The only failure is a NEW healing path that
forgets to stamp, and its consequence is that that fault never accelerates and **falls back to the
timer**. Since the timer is the gate and can never be suppressed, a forgotten stamp costs latency and
nothing else. That asymmetry is the reason it is safe to build at all, and the reason the timer must
stay the gate. A containment script over the ensure/heal helpers catches the omission anyway.

**2. The CHECKS themselves — this is the real question, and the answer is: don't give the detector its
own model of the tree.**

The eight checks could each be hand-written tree rules ("a container's parent must be master or a
project"). That version drifts on contact with any new folder role: it would have flagged the
`unassigned` role as an error the day it shipped, and `crowd` the day after.

⚠ **Instead the detector calls `buildDriveEstate` — the same pure function the app itself relies on
— and asserts INVARIANTS OF ITS OUTPUT.** There is then exactly one definition of what the tree is,
and the detector inherits every change to it for free:

| hand-written rule (drifts) | invariant over the estate (does not) |
|---|---|
| "parent must be master or a project" | every container the estate returns has a `projectId`, or is reported as outside one |
| "these roles are structural" | nothing the estate classifies as a device is also tagged with a role |
| "one Unassigned per project" | `unassignedFolderIds` has no duplicate `projectId` |
| — | no two texts share a `docId`; no object's parent is absent; D1's `project_id` agrees with the estate's |

`buildDriveEstate` is already pure and fixture-tested (`test/drive-estate.test.mjs`), which is what
makes this possible: the detector adds no new understanding of Drive, only arithmetic over an answer
the app already trusts.

**So when DOES it need updating?** Exactly when Seth said and no more often: when an architecture
change redefines what normal looks like — as projects just did, adding a legitimate layer that any
older rule would have called drift. A new feature that adds files, tags or containers within the
existing model needs nothing.

⚠ **And the direction of its failures is the right one.** When the architecture does change ahead of
the detector, invariants over the estate produce FALSE POSITIVES — noise, an email about something
that is fine. The hand-written version fails the other way, quietly accepting a new shape as normal.
For a monitor, being wrong loudly is the survivable error.

### Shape

- **Cloudflare Cron Trigger**, free tier. ⚠ **One researcher per invocation**, cursor in `ops_flag`.
  The binding constraint is NOT the request allowance, it is the **~50-subrequest ceiling** — a full
  `driveListAll` is several pages for one account, and that ceiling has already killed two features
  in this repo. A sweep over everything in one tick cannot work and must not be attempted.
- **`drift_report` table**: `report_id`, `researcher_id`, `ran_at`, `fingerprint`, `summary`,
  `findings_json`. Pruned at 30 days, like `crowd_submission`.
- **Email on CHANGE, never on every run.** Compare the findings `fingerprint` to the previous report;
  identical means log-and-stay-quiet. ⚠ A monitor that mails every night becomes a filter rule, and
  then silence stops meaning anything — the same reasoning as `sendEmail`'s "a monitoring system that
  lies about its own delivery is worse than none".
- **The JSON rides as a Resend attachment.** ⚠ Extend `sendEmail` in `seclog.js` — that file states
  outright why there is exactly ONE place that talks to Resend, and a second copy for this would
  inherit precisely the hole it describes. The same JSON is in `drift_report`, so a lost email is not
  a lost report.
- **A kill switch that needs no deploy:** an `ops_flag` row, exactly as the maintenance notice does.
  ⚠ The detector runs unattended against a live Drive on a schedule; if it ever misbehaves, the fix
  must not require shipping code.

### ⚠ What it is NOT

It is not a substitute for making drift impossible. Where we own both copies, the answer is still to
have one authority and derive the rest (project-split II.5d). A reconciler earns its place only for
what we do NOT control — a human moving folders in the Drive UI — and there Drive is truth and the
index follows. Building this must not become a reason to relax that.

## The client-vs-server guard audit — queued behind the split (Seth, 2026-08-19)

> *"We may soon want to audit our project for client-side code/guards/etc that would be better on the
> server side (or maybe good to duplicate on the server side??)"*
> *"We've been putting those things on the client side in order to avoid breaking the worker or having
> to have a staging worker. But might be we want to rethink that, as long as changes are additive."*

⚠ **The premise has already changed, and that is what makes the audit worth doing.** A staging worker
EXISTS: `worker/wrangler.toml` carries `[env.staging]`, it deploys from any ref through the
`wrangler (one-off command)` workflow with `deploy --env staging`, and the client aims at it with
`?devworker=staging` (persisted per device). The reason for keeping guards client-side — no safe
place to test a worker change — is out of date.

**The sorting question, applied to each guard, in this order:**

> *If a buggy or hostile client skipped this check entirely, what happens?*

| answer | where it belongs |
|---|---|
| something looks wrong | leave it in the client; it is presentation |
| wrong DATA is written | duplicate it server-side — the client copy stays for the fast, kind error message |
| access is widened, or data is lost | it MUST be server-side. The client copy is a nicety and must never be the only one. |

**Already known to belong in the third row**, before the audit starts:

- `/drive-estate` scoping to a member's grants (drive-as-truth §16.30) — today it returns the owner's
  whole tree, and a hidden tab is paper.
- `/v1/textfile` resolving the grant at redemption, not just validating the token (II.5d, I2).
- The unassign sweep: the PANEL decides which texts are unassigned, because inventories are E2EE and
  the worker genuinely cannot know. ⚠ That one is not a mistake to fix — it is a real constraint, and
  the audit must recognise it rather than "correct" it into a server check that cannot exist.

**The instance→project join (v425) is the worked example** of the second row: the client held two
halves of a fact and joined them wrongly, and moving the join to where both halves already live cost
one indexed D1 read and removed the failure mode entirely.

⚠ **Additive-only remains the gate.** Every worker change made today was strictly additive — fields
appearing in a response that previously omitted them, ignored by every shipped client. A change that
alters what an existing field MEANS is a different animal and needs the staging worker plus a test
drive, however small it looks.

## Housekeeping, deliberately deferred (Seth, 2026-08-19, right after the v419 release)

> *"we don't actually need main and productionWeb to be separate branches and having them as such is
> definitely a bottleneck with Cloudflare especially, and we need to go through and sort finished,
> unfinished, and moot plans and feature branches and clean up those that are finished or moot. Also
> a good idea, for security reasons, to go through and clean up old Claude code sessions associated
> with this project. But later."*

Three items. Recorded now with the facts gathered, so the later pass starts from data rather than
from a fresh survey.

### 1. Collapse `main` and `productionWeb` — after the Actions build move

> ⚠ **Re-sequenced again (Seth, 2026-08-20):** the GitHub Actions build move now comes FIRST —
> *"more important than merging main and productionWeb… and more solves the root problem."* This
> collapse halves the builds a release costs; the Actions move stops irrelevant pushes building at
> all. And it is the reversible one of the two. See the Actions entry for the full argument.


> ⚠ **Re-sequenced (Seth, 2026-08-20), and the reason is measured rather than aesthetic:**
> *"I think we maybe need to work on removing the main/productionWeb split sooner rather than
> later. It's too costly in terms of time when we're developing gradually, testing things one at a
> time like this. Which sometimes we do need to do. Let's make a plan and fix this BEFORE working
> on multiple researchers (but AFTER this release ships)."*

The cost showed up in practice today: a single-bug fix costs a full triple Cloudflare build, and
an evening of one-bug-at-a-time iteration paid that repeatedly. The two branches are
fast-forward-identical at every release **by definition**, so the second build buys nothing that
the first did not already prove.


**The bottleneck is real and it is structural, not a habit.** Both branches build the SAME Cloudflare
Worker per app, so every release is two pushes that must be spaced and verified — and the spacing is
the slowest part of shipping. Since they are also fast-forward-identical at every release by
definition (`merge --ff-only main`), the pair buys a distinction that costs a build window and gains
nothing Cloudflare can see. Collapsing leaves `staging` → `main`(live), which is still two rungs: a
dev site to test on and a live site.

⚠ **What makes it more than deleting a branch** — the NAME is load-bearing in at least five places,
and each needs repointing in the same change or the release silently stops working:

| Thing | How it depends on the name |
|---|---|
| GitHub Pages source | publishes `productionWeb:/docs` |
| `sync-satellites.yml` | triggers on a `productionWeb` push, and is what gates the mirrors |
| `apps/*/deploy.sh` | routes `productionWeb` → real deploy, anything else → preview alias |
| `check-release-integrity.sh` | `FLEXTEXT_REF` defaults to `productionWeb` |
| `.git/hooks/pre-push` | blocks production-branch pushes without `ALLOW_MAIN_PUSH=1` |

⚠ And the guard in `apps/*/build.sh` REFUSES to build when the branch is not `productionWeb` and was
not routed through `deploy.sh` — a structural protection against a feature branch overwriting the
live site. Whatever replaces the name must keep that property, not merely satisfy it.

### 2. Sort the plans and branches — the inventory, taken today

**Fully merged into `main` (nothing would be lost by deleting):** `segmentation2`, `seg-exports`,
`paragraph-analysis`, `heads-model`, `cycle-rest`, `editor-fixes-v322`, `parked-panel-and-matching`,
`tok-pisin-l10n`, and `segmentation` — the last being the one CLAUDE.md already says to delete when
convenient. ⚠ For `segmentation`, "merged" means its commits are ANCESTORS of main; the work itself
was removed by revert (`1ef6df2`) and is NOT live. Deleting the branch is still safe — it adds
nothing — but do not read the zero as "it shipped".

**Still holding commits `main` does not have — a decision each, not a deletion:**

| branch | commits ahead of main |
|---|---|
| `parked-v319-v321` | 9 |
| `v321-hardening` | 7 |
| `assign-by-upload` | 6 |
| `fix-artifact-kinds-and-fxpa-stamp` | 2 |
| `guid-identity-gate` | 1 |
| `paired-audio-delete-gate` | 1 |

Plus seven `claude/*` session branches and one `dependabot/*`.

⚠ **The rule that must survive the cleanup** (CLAUDE.md, feature-branch policy): a branch ever removed
from `main` by revert must be REBASED onto main, never merged — a merge meets the reverts and
silently reinstates nothing. Check that before adopting anything from the parked branches.

### 4. Documentation, README, DEVELOPERS.md — and code comments

Added by Seth in the same breath, with an explicit instruction attached: *"don't spend time
inventorying these right now."* So this entry deliberately carries NO list.

What it is: the same finished/unfinished/moot sort as the plans, applied to the prose. CLAUDE.md's own
rule is that DEVELOPERS.md must state the same rules this file does and both must be updated
together — which is exactly the kind of pairing that drifts silently, because nothing fails when it
does. Code comments belong in the same pass for the same reason: this repo comments the WHY, and a
why that has since been reversed reads as current guidance.

⚠ Do the sort AFTER Phase C, not during. The documentation pass is already queued behind the build
(§14 of drive-as-truth), and re-describing a system that is still moving is how the two descriptions
get out of step in the first place.

### 3. Old Claude Code sessions — a SECURITY item, and it has a specific target

Not tidiness. It belongs with the standing policy that the repo and anything published from it must
never state the underlying concern plainly, and with the note that history needs cleaning of it. A
session transcript is another place that text can sit, outside the repo and outside the history
rewrite. ⚠ Scope it to what is actually reachable: transcripts held in the account, not just the
working copies in this container, which are discarded when it is reclaimed anyway.

## ~~The crowd upload has the two defects v337 already fixed everywhere else~~ — DONE in v418

**Fixed 2026-08-19.** The loop now lives ONCE, as `runChunkedUpload` in `upload.js`, and the crowd
submit path is its third caller — no third implementation. Every submission is chunked whatever its
size (the 16 MiB single-POST case is gone; it was the only path that could show no progress at
all), slices open size-aware and adapt, a failed slice is halved before the retry, and the visitor
gets a real percentage. `test/crowd-chunk-policy.test.mjs` drives the loop against a fake transport
rather than grepping for it, and both the halving and the size-aware opening are mutation-checked.

⚠⚠ **AND THE VISIBLE SYMPTOM IS NOT FIXED — PARKED, NOT SOLVED** (Seth, 2026-08-19, testing v418
on a genuinely bad connection): *"the crowd recorder is ALWAYS registering a 'failed, will try
again later' response before ultimately succeeding."* It does succeed, and the chunk policy is a
net improvement, but the visitor still sees a failure banner on the way there.

**What that almost certainly is, for whoever picks this up:** `crowdFlush` paints `failed` for ANY
error that is not `too_large`/`too_small`, and `runChunkedUpload` returns `{ stalled: true }` —
which `crowdSubmitOne` turns into a throw — whenever it exhausts its five strikes on a live
session. That is the CORRECT outcome for the queue (keep the item, resume from Drive's offset
next flush) and the WRONG thing to tell the visitor, because nothing has failed: the bytes are
safe and the upload is mid-flight. The state machine has no word for "still going, come back".
So the fix is a third visitor-facing state between `sending` and `failed`, not more retries.

⚠ Do NOT read this as the chunk policy not working. Compare against the old path before judging:
the same connection previously sent fixed 8 MiB slices with no progress at all and re-sent each
one in full on every failure.

**Deliberately parked** (Seth: *"the crowd recorder is not in use by anybody at the moment and is
not our immediate priority… I want to save further work on the Crowd recorder for later"*).

⚠ **Still outstanding:** `assignUploadFile` (researcher.js) and `_streamChunked` (upload.js) remain
their own copies. Migrating them is the right end state — three copies of one state machine is what
caused this — but it means re-testing two field-proven upload paths, so it is deliberately a
separate change rather than a rider on the crowd fix.

The original entry, kept because the reasoning is the reason the fix was prioritised:


> *"We're going to need to work on UI responsiveness on slow connections with the Crowd recorder…
> UI responsiveness and also slow, glitchy uploads."*

Checked rather than guessed, and the answer is uncomfortable: the crowd submit path is the **only**
upload in the suite that never got the v337 chunk-policy fix — and its user is the worst-connected
person in the whole system.

| | crowd (`app.js`) | device / panel (`researcher.js`) |
|---|---|---|
| chunk size | **fixed 8 MB** (`CROWD_CHUNK`) | size-aware opening guess, AIMD |
| on failure | **retries the same size** | `shrinkChunk` — halves it |
| progress | **none** | `onProgress(sent, total)` per chunk |
| below 16 MB | **one POST, no feedback at all** | chunked with progress regardless |

`researcher.js` records both of these as diagnosed bugs, from the v337 test drive:

> *"Progress hung at 0% and then suddenly jumped to finished… Indistinguishable from a hang."*
> *"A failing chunk retried at the SAME size. On a weak field connection that is the one thing you
> must not do: the retry is as likely to fail as the attempt was, and each failure costs the whole
> slice again."*

⚠ **Both sentences describe the crowd path today**, word for word. A 12 MB recording is a single POST
with no feedback; a 30 MB one is fixed 8 MB slices that re-send in full on every failure.

⚠⚠ **And the irony is the point:** a crowd contributor is a villager on a phone on the worst
connection anyone in this system has. The paths belonging to the researcher — on a laptop, on
wifi — are the adaptive ones.

**The fix is not new work.** `assignUploadFile` already implements the whole loop (probe-first resume,
AIMD sizing, session persistence, per-chunk progress), and it was **parameterized by base path** on
2026-08-19 so the crowd consent-prompt upload could reuse it. Pointing the submit path at the same
loop is a third caller, not a third implementation — which is exactly the "generalize on the second
use" rule.

⚠ One thing that genuinely differs and must not be flattened: the crowd path is PUBLIC and
Turnstile-gated per submission, so a "fresh session" restart costs a new bot check. The retry ladder
has to distinguish a dead Drive session from a spent Turnstile token, which the researcher path never
has to think about.

## Minimise cleartext email addresses in D1 — after the multi-researcher system is fully functional (Seth, 2026-08-27)

> *"As much as possible, we want to avoid clear text e-mail addresses in the D1 data, but that can
> be something for us to fix in a later release, after this system is fully functional."* And the
> standing bar until then: *"Let's just make sure we're not adding NEW plain text data"* of the kind
> that identifies the people in a project.

**What D1 holds in cleartext today (the inventory to shrink):** `researcher.drive_email` /
`display_name` / `avatar_url` (Google sign-in identity — read by the owner-side Coworkers modal and
the drive-status card), and operational rows that reference researchers by UUID (fine — UUIDs name
rows, not people). The E2EE metadata blobs already keep device/text names out of D1; the researcher
identity row is the remaining cleartext class.

**Direction when built:** the same wrap-to-owner pattern the rest of the metadata uses — identity
encrypted under a key the account (and where sharing requires it, the project owner) holds, with
only what routing genuinely needs left readable. Blockers to design around: the operator approval
queue reads emails to decide approvals; password-reset/escrow flows key on email; the Coworkers
identity row (2026-08-27) reads name/email over an owner-authed route. None are unsolvable; all are
why this waits for "fully functional" rather than riding the current batch.

**What was checked TODAY (2026-08-27) about not adding new cleartext:** the member-view and
member-create work sends researcher identity only owner-panel-ward over authed routes (the Coworkers
modal join); the claim/pairing surface now sends NO researcher identity to devices at all (the pair
code is the recognition mechanism); new secLog rows reference UUIDs, never emails.

## Cross-researcher visibility of unclaimed invites, pending commands, unassigned texts (Seth, 2026-08-27)

> *"It would be better if they WERE shared, but it's ok in the short term if they don't work maybe."*

Accepted gaps for now, each with its future shape:
- **Unclaimed invite links**: the secret is shown once at mint and only its hash is stored, so another
  seat can never RETRIEVE the same link — but any capable seat can mint a FRESH one (multiple
  unclaimed invites coexist; a claim revokes prior installs, not prior invites). Future: show "an
  unclaimed invite exists (minted by X, expires T)" on the card for every capable seat, so the second
  researcher knows one is already out before minting another.
- **Pending commands**: serverPending crosses BROWSERS of one researcher today, not researchers.
  Future: surface a member's queued commands on the owner's card and vice versa (the D1 rows exist;
  it is a read-scoping + viewSig change).
- **Unassigned texts / Drive estate**: owner-Drive views (Unassigned card, storage) stay owner-only
  until the deferred `drive` capability lands (Phase 4 — member Drive routes). This is the deliberate
  DEFERRED_CAPS line, not an oversight.

## Concurrent researcher commands — the collision plan (Seth, 2026-08-27)

> *"We may need a plan though for what happens when duplicate or contradictory commands are sent."*
> Raised the day `assignTexts` was un-deferred, i.e. the day two accounts could first race.

**What already holds (the mechanics are favorable):** commands are appended SERVER-side into the
device's desired queue in D1 (requests serialize; no client read-modify-write of the queue), each
carries a `seq` and — since the `by` stamp — its issuer; the device applies in order and acks
`ack_seq`. So nothing is lost on a race, and "contradictory" resolves as last-command-wins in queue
order, which is the same rule two browsers of ONE researcher already live under.

**What is genuinely open, in rough priority:**
1. **Duplicate assigns** — two researchers assigning the same text: does the device dedupe by doc
   id, or hold two copies? Decide + pin with a device-compat probe.
2. **delete-vs-assign races** — a delete queued after an assign of the same doc should win (queue
   order says it does), but the PANEL's optimistic pending rows on the LOSING seat need to converge
   rather than show a phantom.
3. **Cross-account pending visibility** — the earlier backlog entry; solving it also softens 1 and
   2, because a researcher SEES the other's queued command before duplicating it.
4. **setDone toggling** — benign (idempotent last-wins), needs nothing beyond documentation.

**Non-goal:** locking or reservation. Two researchers on one device is cooperative, low-frequency,
and the queue is already ordered; a lock would add a stuck-lock failure mode for no real conflict.

## Google's "You need access" page leaks nothing about the owner — VERIFIED 2026-08-28, re-test periodically

Seth asked whether a bad actor who recovered a Drive folder/file id and pasted it into a browser
would learn the owner's identity from Google's request-access page. **Tested empirically** with two
real accounts (an account with no access opening a real folder id owned by another account): the
page shows "You need access", the Viewer/Commenter/Editor request form, and *"You're signed in as
&lt;the viewer's own address&gt;"*. The full DOM contained **no owner email, no owner name, and not
even the folder's name**; the page title is a generic "Access Denied". The only address anywhere in
the markup was the viewer's own.

Residual signal, stated for completeness: an **existence oracle** — a real id renders the
request-access page while a bogus one does not, so an actor learns a folder exists, but not whose,
what it is called, or what it holds. Clicking "Request access" would reveal the *actor* to the
owner, not the reverse.

⚠ **This is Google's behaviour, not ours, so it can change without notice.** Seth: *"maybe to
periodically check on that and make sure it's still true."* Re-run the check when convenient (it
takes one page load from an account without access) rather than inheriting this note as permanent
truth — the same discipline this repo already applies to believed-once limitations.

## Owner-visible history of MEMBER actions, + optional email notification (Seth, 2026-08-28)

> *"We want our 'history' modal for the researcher account to also log actions taken by member
> researchers on projects they share so that they can see who's doing what. And maybe the option to
> e-mail notify them of specific (or all) actions taken by member researchers — a researcher-account-
> wide setting that applies to all of their projects."*

**The logging half is already built.** `logApproval` records an `actor` and every member-reachable
mutation already passes `ctx.caller.drive_email` — 11 call sites: `member_added`, `member_removed`,
`grant_revoked`, `device_renamed`, `device_invited`, `device_revoked`, `install_approved`,
`device_key_delivered`, `assigned_upload`, `text_adopted`, `text_moved`. So "who did what" is in D1
today, for members as well as owners.

**The read half is the wrong shape.** `GET /v1/researcher/approvals` is **operator-only**
(`isOperator` → 403 for everyone else — verified live: an ordinary approved researcher gets
`403 not_owner`) and returns the **entire global log with no scoping at all**: every researcher,
every project, every actor email, `SELECT … FROM approval_log ORDER BY at DESC LIMIT ?`. So a
project owner cannot see their own project's history, and the operator sees everyone's.

**What the feature needs:**
1. An **owner-scoped** read: rows whose subject is an instance/doc/project belonging to the caller,
   or whose project the caller owns. ⚠ Today `subject`/`detail` are free text (truncated ids +
   nicknames), so filtering on them is fragile — the log should carry explicit `project_id` /
   `instance_id` columns (additive migration) rather than being parsed.
2. Keep the operator's global view as a separate, explicitly-operator route.

**⚠ PII tension to resolve in the same change, not after.** `actor` stores a **cleartext email** in
D1, which is precisely what
[the D1 email-minimisation item](#minimise-cleartext-email-addresses-in-d1) wants to remove — and
this feature would put those emails in front of more people. Store `actor_researcher_id` and resolve
to a display name **at read time, for the entitled owner only**. That serves both goals at once and
is cheaper to do now than to unpick later.

**Email notification** — the account-wide toggle Seth describes — has a hard dependency worth
stating before it is scoped: the worker has **no outbound mail path today**. It needs a provider
(and a from-domain, and a bounce/abuse story), which is a bigger decision than the toggle. A
cheaper first step that meets most of the need: a per-owner **unread-activity badge** on the History
button, driven by the same scoped query and a last-seen timestamp — no email infrastructure, no new
PII leaving the system.

## Progress + time tracking derived from the editor's undo/redo history (Seth, 2026-08-28) — FUTURE

> *"Editor devices already log undo/redo history. There's probably a way for us to share that with
> the researchers … more granular tracking … which texts have used which tabs and what all has been
> done on each tab — how many lines created on the cut tab, if and how many lines typed into on the
> baseline tab, and then what percentage of glossing, free translation, etc. of non-blank lines
> filled in … stats, changes to those stats, and time-stamps for each update … eventually some kind
> of semi-automatic time/progress tracking."*

**The channel already exists — do not build a second one.** Devices already report an ENCRYPTED
inventory (`reported_blob`, decrypted panel-side with Ki) carrying per-text items (`uploadState`,
`hasAudio`, `done`, `uploadedFileId`…). Progress counters are a natural extension of that same
blob: no new endpoint, no new key, no new plumbing, and the panel's existing 12s poll already
carries it. `viewSig` would need the new fields or the tiles will not redraw (the trap this repo has
sprung five times).

**⚠ SEND DERIVED COUNTERS, NEVER THE UNDO STACK.** The undo/redo history contains the actual
language content, keystroke by keystroke. Shipping it — even encrypted — would multiply what a
seized device and a compromised account expose, for no gain the counters do not already give.
Compute locally, transmit aggregates only: lines cut, lines with baseline text, glossed / total
non-blank, free-translated / total, per tab, plus a small ring of (timestamp, delta) points.

**Counting is harder than it looks — decide before building:** undo/redo means an action can be
applied, reverted and reapplied; counters derived naively double-count. Count the RESULTING STATE at
checkpoints (how many lines currently have gloss text) rather than summing events, and treat the
event stream only as the trigger for recomputation.

**Device clocks are untrusted.** A field phone's clock can be wrong, reset, or timezone-shifted, so
device timestamps are approximate by nature. Record the SERVER receipt time alongside the device
time and present them as such — an hours-worked figure built on an unverified clock will eventually
be wrong in a way that matters to a person's reputation.

**⚠ THE ETHICS POINT, because this is the one feature in the suite that measures PEOPLE rather than
data.** "Which coworker did how much, when" is workplace monitoring, and this project's whole
posture is the informed participation of the communities it serves. Whatever is built should be
visible to the person being measured — they should be able to see their own numbers on their own
device — and its existence should be something a researcher tells their team about, not something
they discover. That is a design requirement, not a footnote: a monitoring feature that surprises the
person monitored damages exactly the trust the rest of this suite is built to protect.

## Orphaned Drive folders when a device is revoked (Seth, 2026-08-28)

> *"We also need to clean up Google Drive folders whose devices were deleted from our early
> experimentation (and failed attempts) at the sharing setup. Ideally that doesn't happen."*

**Confirmed first-hand:** revoking an instance removes it from D1's live set and kills its keys and
tokens, but its Drive folder stays parented under the project. Three orphans were created in minutes
during the 2026-08-28 capability/revocation testing (`CapMatrix probe` ×2, `DeviceRevokeTest (fw)`),
and Seth's own `23Aug_New_Device` project carries several from earlier sharing experiments.

**Why "ideally that doesn't happen" is the harder half.** Deleting the folder on revoke is exactly
what must NOT be automatic: revoke is also what you do to a device that is lost or out of the team's
control, and that device's folder may hold the only copy of recordings the community consented to
make. Silent deletion there would be data loss dressed as tidiness.

**Suggested shape (needs Seth's call):**
- Revoke keeps the folder but MARKS it — rename to a `(retired) ` prefix, or stamp
  `appProperties.flextextRetired=<timestamp>` — so orphans are identifiable rather than
  indistinguishable from live devices.
- The panel's Drive-storage view grows a **"Retired devices"** section listing them with their size
  and last activity, and an explicit per-folder delete. Deliberate, reviewable, never automatic.
- A one-off sweep for the EXISTING orphans: `drive_object` rows whose `instance_id` is revoked or
  absent, cross-checked against the live estate, presented as a list to confirm before anything is
  trashed.
- ⚠ Anything that deletes Drive content must be owner-only regardless of member capabilities, and
  should route through the trash (recoverable for 30 days) rather than a permanent delete.

## Researcher↔researcher pairing by CODE + local nickname, not real identity (Seth, 2026-08-28)

> *"For researchers, it's a better idea for us not to have their actual name/e-mail/avatar delivered
> to the owner researcher, but rather use a simple pairing code similar to what's done with devices.
> Just give the researchers on both ends the ability to give that pairing a nickname … nothing in
> our app automatically gives bad actors free information about other researchers if they seize a
> device or compromise an account."*

**⚠ This deliberately REVERSES part of v449, and the reversal is an improvement rather than a
correction of a mistake.** v449 added the coworker identity row (avatar + display name + email) to
the Coworkers modal because the owner had *"no info about the coworker except the ID"* — a real
usability problem: a raw UUID is unusable for deciding who you are granting access to. The nickname
solves that same problem **without** making every account compromise a disclosure of a colleague's
name and address. Same need, better mechanism.

**Shape, mirroring the device pairing that already works:**
- The join is established by a short **pairing code** the two researchers verify out of band (the
  same recognition mechanism devices use since the identity-free claim change of v452), not by one
  party typing the other's UUID or email.
- Each side stores its **own local nickname** for the pairing. Whether that nickname is the person's
  real name is the researcher's choice, made offline — the app never decides it for them.
- The members listing stops joining the `researcher` identity table. `GET /v1/projects/<id>/members`
  returns `{researcher_id, caps, granted, pubkey_set, nickname}` and no PII at all.

**What this is worth beyond privacy:** it removes the last join between `project_member` and
personal data, which is a concrete step toward
[the D1 cleartext-email minimisation goal](#minimise-cleartext-email-addresses-in-d1) rather than a
competing one.

**Stays as-is:** the v463 panel header showing the signed-in account's OWN name/email/avatar. That
is the account holder reading their own identity on their own screen — the thing that tells two open
panels apart — and it discloses nothing about anybody else.

## Members can leave a project themselves — "Leave project" (Seth, 2026-08-28)

Today `DELETE /v1/projects/<id>/members` is owner-only, so a member cannot end their own
participation; only the owner can remove them. A member must be able to withdraw — it is their
access to end, and requiring the owner's cooperation is wrong in exactly the situations where it
matters most.

- Route: allow the DELETE when `researcher_id` in the body **is the caller** and the caller is a
  member of that project (`authMember`, no capability needed — leaving is not a privilege).
- Must do everything owner-initiated removal does, in the same batch: drop the `project_member` row
  AND delete the member's key grants, so leaving is a real withdrawal rather than a UI state.
- Panel: a "Leave project" control on the shared-project tab, confirmed, warning that they will lose
  access to the project's devices and texts until re-invited.
- ⚠ The owner must still see it happened — log it via `logApproval` like any other membership change,
  or an owner discovers a coworker is gone with no record of why.

## Existing project names that embed an owner's identity (follow-on to the v464 fix)

The v464 fix stops NEW default projects being named `"<owner display name>'s project"`, but it
deliberately does not rename existing ones — renaming someone's project out from under them is
worse than the leak, and the name may already be meaningful to their team.

What is still needed:
- The panel should notice when the signed-in owner's default project name still contains their own
  display name or email local-part, and offer a one-click rename (suggesting "Default Project"),
  explaining in one line that project names are visible to everyone they share the project with.
- ⚠ Only ever offered to the OWNER about their OWN project, and never automatic.

## ⚠⚠ SEIZED-DEVICE GAP: remote wipe does NOT revoke streaming tokens (verified live 2026-08-28)

**The scenario this breaks is the one it exists for.** A device is lost or seized, the researcher
remote-wipes it and believes access is withdrawn. It is not: every `/v1/textfile/<token>` URL already
minted for that device keeps working — and those URLs are unauthenticated bearer credentials that
stream community voice recordings. An attacker who dumped the device's IndexedDB (assignment payloads
persist there indefinitely) keeps reading for the life of the token.

**Empirically confirmed against the production worker**, using a purpose-made device and install on a
test account. A token minted for a nonexistent file id isolates AUTHORIZATION from the Drive fetch:
`404 not_found` means the token was honoured and only the file was missing; `410 gone` means the token
itself was refused.

| owner action | redemption result | token alive? |
|---|---|---|
| baseline | `404 not_found` | yes |
| **remote wipe the install** | `404 not_found` | **YES — wipe does not revoke it** |
| **revoke the install** | `404 not_found` | **YES** |
| revoke the whole instance | `410 gone` | no |

**Root cause:** redemption's only device-level check is
`SELECT … FROM instance WHERE instance_id=? AND revoked=0`, and `UPDATE instance SET revoked=1` occurs
at exactly ONE place in the worker — the whole-instance revoke. The install-level paths (wipe,
wipe-ack, install revoke, force-remove) never touch it. Scoped v2 tokens therefore outlive every
lost-device action except the one that removes the device entirely.

**Compounding facts from the same audit:**
- The TTL ceiling is **400 days**, not the 90 the comments claim.
- **Consent-prompt tokens are deliberately unscoped** (no `tk.i`), so they have *no* device kill switch
  at all, live in plaintext `localStorage`, and are designed to be copy-pasted between devices.
- Redemption is **unlogged and unrate-limited**, so replay from a seized device is invisible and
  unlimited.

**Suggested fix — a per-instance token epoch.** Add `instance.tokens_valid_from` (additive, nullable).
Wipe, wipe-ack, install revoke and force-remove all set it to `now`; redemption rejects any token whose
`iat` predates it. This kills previously-minted URLs without revoking the instance itself, needs no
change to token format (`iat` is already carried and currently unused — the comment on `mintTextfileUrl`
says exactly this: *"`n` AND `iat` ARE FREE NOW AND CANNOT BE ADDED LATER"*), and old tokens without
`iat` can be treated as pre-epoch, i.e. refused, which is the safe direction.
Consent tokens need a separate answer since they are unscoped by design — most likely an owner-level
epoch as well.

## Opaque handles for every Drive id — apps never see a real Google file/folder id (Seth, 2026-08-28)

> *"All our apps never actually know Google Drive file/folder IDs directly, they just see the GUUID
> that corresponds to that ID, and then our worker matches that to the corresponding Google
> file/folder ID … Google folder/file/account IDs should never be transparent to any of our browsers
> beyond the current user's own OAuth ID."*

**Verdict after Seth's own objection: DO NOT do this for files. Folders only, if at all.**

⚠ Seth reconsidered within the hour and was right: *"it would require us to track every single
folder and file anywhere — which we don't currently need to do."* That is the real cost, and it is
architectural rather than mechanical. `drive_object` stamps FOLDERS reliably (five inline creation
sites, guarded), but the 2026-08-28 audit found only **one of seven file-creation paths** stamps a
file at creation — every chunked upload, i.e. every large field recording, creates a Drive file with
no row. Issuing handles for files would mean a D1 write on every upload, a backfill of the whole
existing estate, and a second index that must never drift from Drive — in which an unstamped file
becomes UNREACHABLE rather than merely opaque. That trades a phishing-surface reduction for a data-
availability risk, which is the wrong trade for a corpus of irreplaceable recordings.

**Third cost, and the one most likely to bite (Seth):** *"more indexing that needs to be in sync and
more round trip Google Drive requests, which are currently severely limited and slow."* This is
sharper than it first sounds. Today several flows pass a Drive id STRAIGHT THROUGH to Drive with no
lookup at all — the device echoes back the `folderId` it was handed, which is the entire v167 dedupe
contract, built because the `appProperties` tag search is slow, rate-limited and
eventually-consistent, and minted a fresh "Title (n)" folder on every upload until the echo replaced
it. Handle indirection puts a D1 read in front of that path, and any handle that is unknown or stale
degrades to precisely the Drive search v167 removed. A privacy change that reintroduces a
duplicate-folder bug in the field would be a bad trade.

**The scoped version that keeps most of the value:** handles for FOLDERS ONLY. Folder ids are
already tracked, so it is a wire change rather than a new tracking obligation — and folders are what
the request-access phish actually targets (you request access to a folder, and a folder id is what
yields a whole project). File ids would keep flowing as today.

**Original assessment, kept for the reasoning:** right idea, moderate — not easy. It converts "Drive ids are secrets
scattered across every field device" into "Drive ids never leave the worker", which closes the
realistic path to the request-access phish: an attacker who dumps a seized phone finds handles that
mean nothing to Google. It also removes the existence oracle and the id-derived phishing channel for
everything the device population holds.

**Why it is cheaper than it looks:** the mapping table already exists. `drive_object` has
`object_id` (the Drive id) as PRIMARY KEY, with `kind`/`doc_id`/`instance_id`/`project_id` already
maintained at all seven re-parent sites. Add `handle TEXT UNIQUE` (a UUID) plus an index, backfill
one per existing row, and the model is done.

**And there is a real elegance:** the place a handle must be resolved is exactly the place
authorization already happens (`authorizeDocForProject`, `authorizeObjectForProject`,
`memberFileIdsOk`). Translation and authorization collapse into one step — a handle that does not
resolve *for this caller* is simply not found, which is the same 404 everything else answers.

**Measured blast radius (2026-08-28):** 17 worker responses hand a Drive id to a client. Client-side
references: `researcher-panel.js` 102, `app.js` 38, `upload.js` 19, `researcher.js` 17, `sync.js` 0
— but most of those are one of a few variables threaded through UI, not 102 decisions.

**The genuinely hard part is the fleet, not the mapping.** This is a wire-format change to the
DEVICE protocol, and deployed devices cannot be forced to update. It needs a dual-read window:
accept a handle OR a legacy raw id on input, and keep emitting what the caller understands, until
the estate has turned over. The v167 dedupe contract (device echoes back the `folderId` it was
given) works unchanged once the device echoes a handle instead.

**Deliberate exceptions:**
- The OWNER's "Open in Drive" needs a real id. Best shape: the worker returns the finished
  `drive.google.com/…` URL on an owner-only request, so even then the id never sits in client state.
- The user's own OAuth identity stays visible to their own panel (Seth's carve-out; this is the v463
  header).

**Complements, does not replace, an ACL-drift check:** the invariant is that every project/device
folder carries exactly ONE permission — the owner's (verified empirically 2026-08-28). A periodic
worker check that lists permissions on its own folders and raises a panel warning when anything else
appears would DETECT an accepted phish, which handles the case where an id leaked by some other
route. Handles prevent; the drift check notices.

**Shipped in the meantime (v465):** the Coworkers modal now warns, at the moment a member is added,
never to accept Google Drive access requests for these folders — because the correct answer is always
no: sharing works through the panel and a coworker never needs Drive permissions.

## FUTURE DESIGN — seal Drive ids with the worker's own key instead of indexing them (Seth, 2026-08-28)

> *"Is there maybe a way for us to have our worker auto encrypt/decrypt drive and OAuth IDs …?
> That wouldn't require indexing, but it also would mean someone couldn't just get a Google Drive
> folder id from the browser console and place a view/edit request."*

**This is the better version of the opaque-handle idea, and it survives every objection that killed
that one.** Instead of mapping id→GUID in D1, the worker SEALS the Drive id and hands out the
ciphertext; the client stores and echoes the blob; the worker unseals it on receipt. The ciphertext
IS the identifier, so there is:

- **no table, no backfill, no index to keep in sync** — the objection that sank handles;
- **no unreachable-file failure mode** — nothing can be "missing a row";
- **no extra Google round trips** — unsealing is local, so the v167 echo contract keeps its single
  Drive call and never degrades to the rate-limited tag search.

**The machinery is already in production.** `encAtRest` / `decAtRest` (AES-GCM under a server key,
`iv.ct` base64url) already seal the `/v1/textfile` tokens, the OAuth `state`, session IPs, Drive
refresh tokens and TOTP secrets. This would be the same primitive applied to one more value type.

**Refinement worth building in from the start — bind the blob to its holder.** Seal
`{f: <drive id>, i: <instance or researcher id>}` and check `i` matches the caller on receipt. Then a
blob lifted from a seized device is inert when replayed from anywhere else, which is exactly what v2
textfile tokens already do with `tk.i`.

⚠ **Not literally encrypted with the device's pairing key / Ki.** The worker deliberately does not
hold Ki — that is the whole point of the E2EE model — and per-recipient re-encryption would mean
holding per-device keys. Server-key sealing plus the binding claim delivers the same property without
touching that boundary.

**⚠ SEALING CHANGES THE IDENTIFIER, NOT THE TRANSFER — and that must be verified, not assumed
(Seth, 2026-08-28):** *"if our worker converts a drive id into a blob, we may want to make sure that
also includes all of our poor-connection/slow-connection/pause/resume/auto-chunk-adjust/retry/
redundancy functions … We don't want that to mean they only get the blob as one big one-time
non-resumable download."*

The sealed value replaces an id in a request, so streaming, `Range` requests, chunked upload
tickets, retry/backoff and resume should be untouched by construction. But "should be" is how
regressions ship. Before this lands, confirm end to end that: `/v1/textfile` still honours `Range`
and partial content; a resumed download re-presents the same sealed value and continues rather than
restarting; the chunked upload tickets (which are themselves `encAtRest` blobs already) keep their
resume semantics; and a sealed value stays valid across a multi-hour interrupted transfer — its
lifetime must not be shorter than a realistic bush-connection download. A privacy change that turns
a resumable 200 MB WAV into a one-shot download would be a far worse regression than the leak it
closes.

**Honest limits:**
- The OWNER's panel still needs real ids for "Open in Drive"; that stays an owner-only exception
  (better: the worker returns the finished URL so the id never lands in client state).
- It does not help if an id leaks by some other route — a link in the owner's own history, an old
  share. The ACL-drift check above is the detective control for that; sealing is the preventive one.
- Still a wire-format change to the device protocol, so it needs a dual-read window (accept a raw id
  OR a sealed blob) until the fleet turns over.

**⚠ THE MIGRATION WORRY IS THE GOOD NEWS HERE — there is nothing to migrate.** Seth: *"it probably
would require some careful implementation so as not to brick existing devices and projects and
accounts. Maybe another migration path. :("* Checked against the code (2026-08-28), and sealing is
the one version of this idea that needs **no data migration and no forced client update**:

1. **Nothing stored needs converting.** The ciphertext is computed on the fly from the id the worker
   already holds. Unlike handles, there is no row to backfill, so there is no half-migrated state and
   no object that can end up unreachable.
2. **Devices never parse these ids — they store and echo them.** `docs/js/upload.js` assigns
   `uploadedFolderId = out.folderId` and sends it straight back as `folderId` (lines 166-167, 317-318,
   391-400). To a device the value is already an opaque token, so an UNCHANGED deployed device works
   with sealed blobs. That is what removes the flag day.
3. **Exactly two places build a Drive URL from an id**, and neither is on a device:
   `app.js:4301` (legacy pasted-link resolution, not an id we issue) and `history.js:175`
   `driveFolderLink()` — the owner-only "Open in Drive". That one guards with `/^[\w-]{10,}$/`, which
   a sealed `iv.ct` blob fails because of the dot, so it would render NO link rather than a broken
   one. It fails closed by accident; give it the real id (or a worker-built URL) deliberately.

**So the whole change is worker-side:** seal on output, and one `resolveDriveId(x)` on input that
unseals a blob or accepts a legacy raw id. Both forms stay valid indefinitely — no cutoff, no
bricking, and old and new clients interoperate in either direction.

**Sequencing (Seth: "future design, rather than current plan"):** after the sharing feature ships.
The cheap mitigations are already in place — the v465 warning tells owners never to accept Drive
access requests, and an ACL-drift check would likely give more safety per unit of effort than either
this or handles.

## Offline / poor-connection tolerance is the DEFAULT — a standing constraint (Seth, 2026-08-28)

> *"Our primary user base — especially mine — offline/poor-connection tolerance is more important and
> should be the default … I don't want someone out in the bush for six months coming back to town and
> finding out their device is unpaired (or even worse, wiped automatically). But I do want people in
> sensitive contexts with better internet to have that option in their settings."*

**Rules this imposes on anything touching device state:**
1. **Silence is the normal state, never a signal.** No feature may expire, unpair, wipe or degrade a
   device because it has not been heard from. Six months offline is a working device, not a stale one.
2. **Strictness is opt-in, per account.** A researcher in a sensitive, well-connected context may
   choose shorter token TTLs, inactivity limits, or auto-revocation — but it is never the default and
   never inferred from behaviour.
3. **Every withdrawal must be an explicit human act.** The v466 token epoch follows this: it is
   stamped only by wipe / wipe-ack / install revoke / force-remove, never by a clock. The code says so
   at the function, because "also expire after N days" is the obvious-looking change that would break
   the primary use case.

**Related, still open — partial/interrupted transfers.** Seth: *"[don't allow] them to partially
download updates, settings, files and then break things because their app tried to load something
partially downloaded or interrupted."* Worth an audit of its own: settings pushes, engine/service-worker
updates, and assignment downloads should each be all-or-nothing at the point they become visible to
the app — write to a staging key and flip a pointer, verify length/hash before adopting, and never let
a half-written record become the one the editor opens. The service worker's `precacheAll()` already
fails the whole install rather than adopting a partial shell (the v108 lesson); the same discipline
should be confirmed for settings and for downloaded media.

## Old worker versions as an attack surface — worth checking properly (Seth, 2026-08-28)

> *"If old worker versions present an attack surface we don't want, we may at some point want to
> consider cleaning them up."*

**Why this deserves a real answer rather than a shrug:** every worker-side fix we ship is only as
good as the impossibility of reaching the OLD code. If a previous version is addressable — e.g. via
a Cloudflare version-preview URL — then an attacker with valid credentials could route around any
fix by talking to a pre-fix build against the SAME live D1. CORS would not stop them (it is not a
data-protection boundary), and auth would succeed, because the credentials are real.

Not yet established, and needs checking before it is dismissed: whether version preview URLs are
enabled for `flextext-r2-worker` (`workers_dev = true` is set, which is a different thing), and what
`wrangler versions list` reports for alias/preview availability. If previews ARE reachable, the
mitigations are to disable preview URLs on the production worker and/or prune old versions after a
release is confirmed healthy.

⚠ Note the tension with rollback: pruning versions removes rollback targets. Keep at least the last
known-good, and prune on a schedule rather than immediately after a deploy.

## R2 caching of files is permitted, with conditions (Seth, 2026-08-28)

> *"It's OK for our worker to cache files on my R2 storage as long as they're removed after a
> successful download has been verified and as long as that doesn't make them publicly viewable."*

Recorded as a standing permission for future work (likely relevant to resumable/poor-connection
downloads). The three conditions are the whole of it:
1. **Deleted after a download is VERIFIED complete** — not after it is merely started or assumed.
   A partial or interrupted transfer must leave the cached object in place so it can be resumed.
2. **Never publicly viewable** — no public bucket, no unauthenticated URL. Access goes through the
   worker with the same authorization every other file read gets.
3. Implied by (1): a sweeper for objects whose download never completed, so the bucket cannot grow
   without bound when a device goes offline mid-transfer.

## Let a MEMBER finish enrolling a device — key fingerprints (Seth, 2026-08-28)

**The gap, in one line:** a member can approve a device but not key it, so a member-enrolled device
does not work until the OWNER next opens their panel. Seth: *"so it requires the owner to log in no
matter what before it works?"* — yes, whenever a member does the enrolling. In a field context that
can be days, for exactly the delegation the sharing feature exists to enable.

**Why the route is owner-only, and why that reasoning is right:** `wrapped_key` is opaque ciphertext
the worker cannot inspect, and the route bumps `desired_rev` so the device ADOPTS what it is given.
A member could therefore install a Ki *they* chose, after which the owner's stored Ki no longer
decrypts the device's reports and the owner's own commands stop being readable by it — E2EE sabotage
reached through device management. The worker cannot validate its way out: it cannot read the key,
so "is this the right key" is not a question it can ask.

**But the worker is not the only possible verifier — the DEVICE is.**

- When the owner creates an instance, store `ki_fp` = SHA-256 of Ki on the instance row (the owner is
  the only party who has Ki at that moment, so only they can write it).
- The desired lane serves `ki_fp` alongside `wrapped_key`.
- The device, after unwrapping, hashes what it got and compares. Mismatch → refuse to adopt, keep
  the old key, and report the mismatch so it surfaces in the panel.
- With that check in place, `POST .../installs/<id>/key` can accept `manageDevices`: a substituted
  key cannot land, so the sabotage the owner-only rule prevents becomes impossible rather than
  merely detectable-after-the-fact.

**Properties worth keeping in mind:**
- ⚠ `ki_fp` is a hash of a symmetric key. It is NOT a secret to protect, but it IS a verifier — do
  not let a member write or change it, or the check verifies nothing. Owner-written, immutable.
- Existing instances have no `ki_fp`, so they keep the owner-only path. Degrades cleanly, no
  migration of key material, no flag day.
- Key ROTATION (Phase E) must update the fingerprint in the same act, or every device refuses the
  new key. Worth designing the two together.

**✅ SETH APPROVED THE DIRECTION (2026-08-28):** *"A member substituting a key gets caught by the
device itself. That turns the risk … into 'impossible to land', and members could then key devices
safely. — This would be fine, I think."* So the end state is: members CAN fully enrol a device once
the device verifies the fingerprint.

**⚠ THE ONE COMPLICATION THAT DECIDES THE ROLLOUT: old devices cannot verify.** The check lives on
the DEVICE, so an already-deployed editor/recorder would adopt whatever key it is handed, exactly as
today. Allowing member key delivery therefore cannot be a simple route change — it must be gated on
the device having an engine new enough to perform the check. The instance's reported
`inventory.engineVersion` already carries that (`engNum`, the same signal the panel uses for
capability gates), so the rule is: a member may deliver a key ONLY to an install whose reported
engine is at or above the version that verifies. Everything older stays owner-only, forever if need
be — which is safe, and degrades to today's behaviour rather than to a hole.

⚠ That also means the device-side check must ship and REACH THE FIELD before the route opens. In
deploy terms: engine first, let the estate update, then the worker change — the reverse of the usual
backend-first order, and worth stating loudly because getting it backwards opens the sabotage window
this design exists to close.

**Until it is built**, v471 is the interim (v470's sweep alone was not enough): the member is not offered Approve at all — the card
says the owner must approve and key it — so no half-genuine install can be minted (Seth: "better not
to give the member a way to mint an install that isn't actually genuine until the owner gets around
to it"). v470's owner-side key sweep stays, because it also repairs installs whose delivery failed or
was interrupted. And the constraint is deliberately VISIBLE: a team whose owner will not be bothered
with approvals should reverse who owns the project, and they can only decide that if they can see
the limit.

## Crowd recorders are invisible to members in a shared project (found 2026-08-28)

`renderCrowdCard` is called from the FLAT branch and the owned-project tab only; the shared-project
tab (`renderMemberProjectContent`) renders device cards and nothing else. So a project containing
crowd recorders shows a coworker no trace of them — not an empty section, not a note, nothing.

⚠ It is silent, which is the part that matters. A member helping run a project with crowd collection
sees a dashboard that looks complete and simply lacks a feature, so the natural conclusion is that
the project has no recorders rather than that they cannot see them.

**The decision to make (not obviously either way):**
- Crowd recorders are a PUBLIC intake surface — a link anyone can submit through — so the privacy
  argument that keeps Drive owner-only does not apply in the same form.
- But their config includes the prompt and the consent wording, and editing those is closer to
  changing what participants are told than to managing a device.

Cheapest honest option for v1: render the section for members read-only, or a single line saying the
project has N crowd recorders that only the owner can manage. Either beats silence. Full member
management of crowd recorders needs its own capability and is a separate piece of work.
