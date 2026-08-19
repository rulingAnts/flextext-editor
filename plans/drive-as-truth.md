# Drive as the source of truth — text identity, assignment, and a reconciler

**Status: DESIGN NOTE. Nothing is built.** Worked out with Seth on 2026-08-19, from his observation
that *"now that we have the manifest files and texts are discrete folders and each device has a
folder, we might be able to collapse our assignment system so that the folder structure in Google
Drive IS the assignment data — rather than having duplicate assignment data in D1."*

Every claim about the current code below was checked against the tree. Three questions are still
open and are marked as such — they belong to Seth, and the answers change the schema, so they want
settling before the first migration.

**This supersedes `plans/project-split.md` PART VII.1**, which proposed a `drive_object` table from
the other direction (auditing Phase C's Drive scoping). Same conclusion, better framing: read that
section as the problem statement and this as the design.

---

## 1. Why anything needs to change

The symptom Seth reported: *"I do want to make sure that Google Drive folder structure and D1 and
UI don't drift apart, which right now they do."*

The cause is not that two stores disagree. It is that **three** stores answer the question and only
two are ever consulted:

| Store | Answers | Authority today |
|---|---|---|
| Drive folder parentage | where the bytes live | **ignored** — `driveEnsureTextFolder`'s tag search is deliberately NOT parent-scoped |
| D1 | who may touch it, what we intended | **absent** — there is no text-level table at all |
| Device inventory report | what this device actually holds right now | **de facto authority** — `assignedDocIds()` is built from it |

D1's schema is `researcher / instance / install / invite / session / project / project_member /
member_key / crowd_*`. No texts, no folders. `assignment/begin` creates the device folder, the text
folder and `originals/`, returns their ids — and writes nothing.

So the UI answers "where is this text?" from device inventories, Drive answers it from parentage,
and nothing reconciles them. Every drift bug found this week has that one root:

- a text mid-assignment listed as "unassigned" with a live Remove-from-Drive button (fixed v391,
  by excluding in-flight ids — a patch on the symptom, not the cause);
- `drive-unassign` implemented in the worker and **called by nothing** — the sweep that would bring
  Drive into line with the UI's view has never run;
- a move that re-parents the folder immediately while the source device keeps reporting the text
  for as long as it stays offline;
- a researcher dragging a folder in the Drive UI, which nothing notices.

**Answering the question Seth asked:** yes, the folder structure is readable — Drive returns
`parents` on every file and `buildDriveEstate` already derives a text's device from its parent. The
obstacle was never visibility. It is that (a) Drive's *search* index is eventually consistent and
lags by minutes (this is the v167 duplicate-folder bug), while `files.get` by id is strongly
consistent; (b) anyone can rearrange Drive by hand, with no transaction and no audit trail;
(c) Drive has no multi-file atomicity; and (d) reading structure inside a request spends the
~50-subrequest Cloudflare budget that killed `drive-purge` twice.

So: **Drive is the source of truth. D1 is an index over it, addressed by id, never derived by
search.** The property that makes that honest rather than a slogan is in §5.

---

## 2. Identity: `doc_id` is currently doing two jobs

Seth: *"There may be cases where you want to assign the same recording to two different devices and
compare the results of native speaker work. And there may be cases where we want to re-assign a text
with the same audio and flextext file we downloaded and removed from Google Drive before, possibly
with a different title. But we don't want the same assignment instance on two devices or two
duplicate folders at the same time."*

Both of those are *same recording, different work item* — and neither is expressible today, because
the `flextextDoc` tag means the work item AND the source recording at once. Split them:

| | meaning | cardinality |
|---|---|---|
| `doc_id` | one assignment / work item | **PK** — exactly one folder, at most one device |
| `recording_id` | the underlying audio | **non-unique** — many docs may share one |

**The invariants Seth stated hold on `doc_id`, unchanged, and become unrepresentable rather than
merely forbidden:**

- one `doc_id` → exactly one folder (PK, plus `folder_id` UNIQUE)
- one `doc_id` → at most one `instance_id` (one column; `NULL` = Unassigned)
- many `doc_id` → one `recording_id` — allowed, and the point

What it buys:

- **Two devices, one recording** = two `doc_id`s sharing a `recording_id`. No duplicated work item,
  no second folder for the same assignment.
- **Comparing the results** becomes a query (`WHERE recording_id=?`) and a real side-by-side view,
  instead of something reconstructed from memory.
- **Re-assign what was downloaded and removed, with a new title** = a new `doc_id`, same
  `recording_id`. The lineage survives even though the old folder is gone.
- **Blind comparison comes free.** Two folders under two device folders means neither worker sees
  the other's results — provided the panel does not surface sibling work down to a device. That is a
  reason this model is *better* than one shared folder, not a workaround for the invariant.

`recording_id` lives **in the manifest**, alongside title, TTL and whatever text-level metadata comes
later ("whatever is needed… that can't be included in the flextext file, we can put in the
manifest" — Seth). That is what lets it survive download-and-remove: re-adopting a folder reads its
manifest, and D1 is re-derived from it.

⚠ **A recording has no folder of its own.** Deleting a doc deletes its folder and its copy of the
audio, and nothing else. Keep it that way — but the UI must say *"this recording has 2 assignments"*
so nobody deletes one believing the audio is gone everywhere.

---

## 3. Three origins — and one creation rule that covers all of them

Seth: *"texts that originate in the recorder or editor apps… our plan here needs to take those into
account as well."* This is the correction that reshaped the design.

| Origin | Identity minted by | In D1 today | How it reaches Drive |
|---|---|---|---|
| Researcher assignment | panel / worker | nothing | `assignment/begin` — folder created **before** any bytes |
| **Device (recorder / editor)** | **the device**, `newGuid()`, offline | nothing | worker creates the folder on **first upload**, under `authInstall` |
| Crowd recorder | worker | `crowd_submission` row | public page upload |

A device-originated text exists — real id, real audio, real work — **before anything else knows it
exists**, potentially for weeks. `origin` is therefore a first-class field.

The first draft of this note concluded that "stamp D1 before touching Drive" could not be universal,
and gave device texts their own creation path. **Seth pushed back — could the device stamp D1 first
too? — and he is right.** It is not two creation paths. It is:

- **one creation rule:** the D1 row exists before any Drive object, for every origin;
- **one recovery path:** adopt-what-you-find (§5), which can never be deleted, because existing field
  texts predate all of this and because *D1 must be rebuildable from Drive* — that property is the
  whole reason Drive is the source of truth and not merely the bigger copy.

Adopt is demoted from a co-equal creation route to recovery. That is strictly cleaner, easier to
assert, and it is what makes the invariant testable.

### 3.1 Why registering first is worth doing on its own merits

Not symmetry — it closes a live hole. `POST .../upload/start` authenticates the install, then passes
`body.docId`, `body.docTitle` and `body.folderId` **straight from the request body** into
`driveEnsureTextFolder`, which resolves by the GLOBAL `flextextDoc` tag. There is no check that this
install owns that docId. A device can therefore upload into any text folder in the researcher's
estate, including another device's. Contained today; not contained once a project has members.

Registering first turns the upload into: *look up the row by `doc_id`, verify this install owns it,
use its stored `folder_id`.* No client-supplied folder id, no tag search — which also removes the
eventually-consistent lookup (the v167 bug class) from the single most important path in the system.

**What it costs: nothing offline.** A device already cannot upload without connectivity, so the
registration simply precedes the upload when the network arrives. Local creation is untouched, and a
device can go on making texts for weeks. The one new failure mode — registered, then the upload fails,
leaving a row with no folder — is a state §3.2 already requires to be normal and safe.

⚠ **BATCH IT.** A device coming online after two weeks with 30 new texts must register them in ONE
request. Thirty round trips in front of the first upload on a village connection is a real
regression, and it is exactly the kind that looks fine in testing.

**Register at FIRST UPLOAD, not at creation.** A device that makes 50 texts and never uploads must
not fill D1 with rows for texts that may never exist in Drive. Nothing is lost by waiting, because
visibility is already served by the other channel:

| channel | carries | who can read it |
|---|---|---|
| inventory report | visibility — "I hold X, titled Y, not uploaded" | researcher only (E2EE under Ki) |
| registration | authorization + folder binding | the worker (plaintext index) |

⚠ **The honest cost, stated once:** the server learns doc ids, counts and origin in plaintext, where
today they sit inside the encrypted inventory blob. That is a step away from *"the worker routes, it
does not comprehend"* (CLAUDE.md). It is a cost of having an INDEX at all, not of registering early —
the `text` table widens this whichever way the row is created — and it should be accepted knowingly
or the whole design reconsidered, not discovered later.

### 3.2 ⚠ The safety asymmetry — the most important rule in this document

For a researcher-assigned text, the Drive folder is the backup. **For a device-originated text that
has not uploaded yet, the only bytes in existence are on a phone in a village.**

So: **the reconciler must never read "no folder" as "nothing here."** For a device-originated text
that is the NORMAL state, not drift. A sweep that "cleans up" D1 rows without folders would delete
the record of the only copy of somebody's week of work. This is the worst bug this design could
have, and it is available in one careless line.

The existing upload-first delete (`uploadDelete`) is the same principle already in the code; keep it,
and treat it as the pattern rather than a special case.

### 3.3 Vocabulary does not transfer

You cannot "cancel the assignment" of a text a device made itself, and you cannot move it to
Unassigned without first getting the bytes off the device. The UI must tell these apart, and
`origin` is what lets it.

---

## 4. Unassigned, defined once

> **Unassigned = a recording with no doc, or a doc with no instance.**

One box, three origins, no special cases:

- a cancelled assignment → `instance_id = NULL`, folder swept into Unassigned;
- a crowd submission nobody has assigned yet → a `recording_id` with no `doc_id`;
- a text a device dropped → `instance_id = NULL` on the next reconcile.

And **"upload now, assign later"** — which Seth asked whether we support — stops being a feature to
add. It is `instance_id = NULL` at creation, i.e. the shape the model already has.

---

## 5. The reconciler

Without one this is just more state to drift. Three ingredients.

**(a) A `rev` you can compare cheaply.** Monotonic in D1, mirrored into the folder's
`appProperties` whenever the worker touches it. "In sync?" becomes one field comparison, not a deep
diff. The code already uses `appProperties` this way (`flextextDoc`, `flextextRole`,
`flextextUnassigned`).

**(b) A written precedence rule per disagreement — not a merge heuristic:**

| Disagreement | Resolution | Why |
|---|---|---|
| folder exists, no D1 row | **adopt it** | this is what makes Drive the source of truth |
| D1 row, no folder | **flag; never drop** | for a device-originated text this is normal — §3.2 |
| folder's parent ≠ D1 `instance_id` | **D1 wins; re-parent Drive** | anyone can drag a folder; only the worker writes D1 |
| D1 says X holds it, and X **has reported since** the assignment without listing it | `instance_id = NULL` | the device dropped it |
| two folders share a `flextextDoc` tag | **merge to the oldest**, flag it | matches the existing `orderBy=createdTime` rule |

⚠ **The fourth row's wording is load-bearing.** *"Has reported since"* — not *"has not confirmed."*
A device offline for three weeks is **latency, not drift**; a reconciler that treats silence as
disagreement will fight the field constantly. `last_seen_at` and `ack_seq` already distinguish them.

**(c) Where it runs, given the subrequest budget.** Reconcile **the one text you are touching, when
you touch it** — `files.get` by stored id is strongly consistent and cheap — plus a **full sweep on
demand** from the storage modal. No cron (billable, and forbidden without Seth's explicit approval),
no per-request Drive cost.

**(d) Make disagreement visible.** The panel's current failure mode is that it *computes* a plausible
answer and shows it confidently — that is how a text mid-assignment acquired a Remove button. A
reconciled model must be able to render *"these disagree"* as a real state rather than picking one.

---

## 6. Sketch of the row

Illustrative, not settled — the open questions in §8 change it.

```
text(
  doc_id        TEXT PRIMARY KEY,   -- the work item. Device-minted or panel-minted.
  recording_id  TEXT,               -- the audio. NON-unique: many docs may share one.
  folder_id     TEXT UNIQUE,        -- Drive folder. NULL until bytes exist (§3.2!).
  instance_id   TEXT,               -- NULL = Unassigned. One column ⇒ never two devices.
  project_id    TEXT,               -- open question §8.1
  origin        TEXT,               -- 'assigned' | 'device' | 'crowd'
  state         TEXT,               -- 'assigning' | 'active' | 'moving' | 'unassigned' | 'conflict'
  rev           INTEGER,            -- mirrored into the folder's appProperties
  updated_at    INTEGER
)
```

Everything descriptive — title, TTL, text-level settings, future metadata — lives in the
**manifest**, not here. D1 holds ids and the minimum needed to authorize fast.

---

## 7. Preconditions worth doing first

- **`files.copy` for the sibling-doc copy.** ⚠ Twice-corrected, and the second correction removed the
  problem rather than working around it. The first draft said to replace the through-the-Worker copy
  in `assign-copy` with Drive's native `files.copy`; that was wrong, because its source was an
  arbitrary PUBLIC Drive file and `drive.file` cannot copy what the app did not create. Then Seth:
  *"we should not have our source be arbitrary public drive files anymore. The UI no longer works
  that way. We assign files by uploading them and our worker puts them in the target text's folder
  and manifest."* Confirmed — `assignModal`'s own comment records the retirement (*"pasted URLs are
  retired entirely… the upload IS the copy"*), and productionWeb and main both carry **zero** call
  sites — so **the route has been removed** (2026-08-19) along with its orphaned client wrapper.
  What remains is the §2 case, and there `files.copy` is simply correct: copying an audio file **this
  app created** from one text folder into a second, for the same-recording-two-devices workflow.
  Server-side, no bytes moved, one request.
- **Wire `drive-unassign`.** It is fully implemented in the worker, idempotent, and has zero callers
  in `docs/` or `satellites/`. It is the sweep that puts a cancelled assignment's folder where the
  UI already claims it is.
- **Make `driveEnsureTextFolder` the single write-side chokepoint**, taking an allowed-parents
  argument so the echoed folder id and the tag search become hints rather than authority.
  ⚠ KEEP the `files.get`-by-id echo — replacing it with a parent-scoped search runs on the
  eventually-consistent index and re-opens the v167 duplicate-folder bug.

---

## 8. Open questions — Seth's call, and they change the schema

1. **Does `project_id` live on the text row, or is it derived from the instance?** ⚠ §10.4(5)
   settles this on security grounds and reverses the earlier lean: **derive** it from the instance
   where there is one, and store it only on Unassigned rows, which have none to derive from.
   Storing it everywhere hands a D1 dump the project grouping for free. Confirm and this stops
   being an open question.
2. ~~Does the reconciler ever re-parent a folder without asking?~~ → **SETTLED (Seth, 2026-08-19):
   YES, ALWAYS, AND WITHOUT A SETTING.** See §8a — the "ask vs. silent" framing was the wrong one.
3. ~~A device-originated text the researcher wants in Unassigned: force an upload first, or mark it
   now?~~ → **SETTLED: a false choice.** In BOTH cases the bytes must upload before the text leaves
   the device (§3.2, non-negotiable), so the outcomes are identical — the only difference is what the
   panel *says* meanwhile. So: **allow marking it at any time, and show it as PENDING**, in the same
   vocabulary as every other in-flight action, never as complete. An offline device must not block
   the researcher from expressing the intent; it only delays completion, visibly. `uploadDelete` is
   already upload-first-then-delete, so the machinery exists — what is new is only that the intent
   lives in the account rather than in one browser.

---

## 8a. The ownership boundary — why auto-reparent, and why not a setting

Seth, 2026-08-19: *"I really like the idea of auto-reparenting because I'm afraid of the unintended
consequences of not doing that… Our app will manage and sort folders and files within the FlexText
Uploads folder, but they're free to move and rename THAT folder in whichever way makes sense to
them."*

He is right, and his framing is better than the question it answers. **A detector that never acts is
worse than one that acts**, because drift COMPOUNDS: one unreconciled folder is a curiosity, a
hundred is an unmanageable estate, and every later operation has to carry "it might not be where we
think" forever. "Ask the researcher" sounds cautious and is actually how you get there.

**The contract, stated once:**

> Inside the `FlexText Uploads` folder, the app owns the layout and will keep it sorted. The folder
> itself is yours — move it, rename it, nest it wherever suits you.

✅ **This is ALREADY TRUE in the code, not a feature to build.** `driveMasterFolder()` resolves by the
`appProperties` tag `flextextRole: 'uploads-master'` — not by name and not by parent — so renaming
the folder, nesting it under a project folder, or moving it anywhere in the Drive all keep working.
The contract only needs *documenting* and *honouring*, not implementing.

**Why not offer it as a preference**, despite the reasonable instinct that researchers differ:

- It is a setting about **invisible background behaviour**, whose consequences almost nobody can
  evaluate at the moment they are asked to choose.
- The "off" branch produces exactly the compounding drift above — it would be shipping a foot-gun as
  an option, and then supporting both worlds for ever.
- Two code paths for one invariant is the "rule enforced in one place that other paths reach
  differently" drift `plans/BACKLOG.md` already warns about.
- **The boundary IS the escape hatch, and it serves both temperaments**: the researcher who wants to
  organise does so *around* the folder — which is fully supported — while the app keeps the inside
  consistent for everyone. Nobody has to choose, and nobody can choose wrongly.

⚠ **One rule that is NOT a preference and must survive the "always auto-reparent" decision: never
move anything we cannot positively identify as ours.** A folder sitting inside the boundary with no
`flextextDoc` tag and no manifest is not ours — perhaps the researcher filed something there
deliberately. Leave it, and surface it. That is not asking permission; it is not touching other
people's things.

**Small follow-on worth doing with this:** `driveMasterFolder()` finds the boundary by SEARCH, which
runs on Drive's eventually-consistent index (the v167 class). Store the master folder id in D1
alongside the other folder ids — encrypted at rest per §10.4(2) — so the boundary resolves by a
strongly-consistent `files.get` and the one folder everything hangs from stops depending on a lagging
index.

---

## 9. Sequencing against Phase C

Not a detour. Phase C's Drive-scoping workstream (`project-split.md` R2-1 / II.D7) is specified
against folder **parentage**, which this codebase deliberately does not maintain — that is PART VII.1,
and this note is its answer. The table is the same table. Doing it as Phase C's foundation is far
cheaper than retrofitting it after the first migration, and it is what makes Seth's stated
requirement expressible at all:

> *"we do want to make sure that invited/assistant researchers can only see/access what they're
> given access to… only to texts they've been given access to (or created themselves if they're
> allowed to do that)."*

`created_by_researcher_id` on the text row is what makes *"or created themselves"* sayable. Nothing
in the current model can express it.

---

## 10. The cost of indexing, and how to keep it small

Seth, 2026-08-19: *"I think we have to accept the cost of indexing and update our documentation and
security claims accordingly, especially for e2ee. But whatever we can do to minimize the potentially
sensitive data a hostile actor could gain if they were to break into our D1 data would be good to
think about."* Accepted. This section is the threat model and the queue of work against it.

### 10.1 The assumption that makes this tractable

**A D1 breach is not a secrets breach.** `SERVER_HMAC_KEY` lives in Worker secrets, not in the
database, and `serverAesKey()` / `encAtRest()` / `decAtRest()` already protect `drive_refresh_enc`,
`kr_server_enc` and session `ip_enc` with it. So "attacker holds a full D1 dump and nothing else" is
a threat the codebase is already partly built for — and the primitive to extend is already there.

### 10.2 What a dump yields TODAY

Worth stating before adding anything, because it is more than the current documentation implied
(now corrected in DEVELOPERS.md):

- **`instance.nickname`** — plaintext, NOT NULL, and in practice a person or a place;
- **`crowd_submission.file_name` / `country`** — plaintext;
- **the plaintext `id` on an `assign` command** inside `desired_blob` — the worker needs it to route;
- **`email_sha256`** — not reversible, but it *confirms a guessed address*, which is the attack that
  matters when the attacker already has a list of suspects;
- everything else material — inventory reports, command payloads, wrapped keys — ciphertext.

### 10.3 What the index adds

Per-text rows: `doc_id`, `recording_id`, `folder_id`, `instance_id`, `project_id`, `origin`, counts,
and which texts share a recording.

⚠ **The sensitive artifact is the JOIN, not any single column.** `instance.nickname` ("Iwan's
phone") × N text rows = *this named person holds 47 texts, shares 12 recordings with that named
person, inside this project.* Against this suite's privacy obligations that is the output that matters: a
named individual tied to a body of work, at a measurable volume, with collaborators inferable.

Which yields the important insight: **the index does not create a new leak so much as multiply the
value of an existing one.** The highest-value defence is therefore not about the new table at all.

### 10.4 Minimization, ranked by value per unit of work

1. **Encrypt `instance.nickname` at rest.** The single change that most reduces the value of
   everything else in a dump, and it is a leak *today*, independent of this design. The worker needs
   the plaintext (it names Drive folders with it), so `encAtRest` — not Kr — is the practical
   choice: the worker can read it, a database dump cannot. **Do this one first, whatever else
   happens to this plan.**
2. **Encrypt `folder_id` and `oauth_folder_id` at rest.** Same primitive. A dump then hands the
   attacker no direct map into Drive if they obtain Drive access by some other route. Nearly free:
   the index is queried by `doc_id`, not by folder id.
3. **Never store `title` in D1.** Already the design — titles live in the manifest — but make it a
   hard rule with a test. It is the single most revealing field and the most tempting to denormalize
   the first time someone wants a fast list view.
4. **Store `HMAC(doc_id)`, not `doc_id`.** Drive's `flextextDoc` tag keeps the real id; D1 keeps only
   its HMAC. The worker computes it; a D1-only attacker cannot join rows to Drive folders.
   Rebuild-from-Drive still works — read the real ids from Drive and re-derive. ⚠ Only worth doing
   TOGETHER WITH (2): if `folder_id` is plaintext the join exists anyway. And it has a real
   operational cost — support and debugging get materially harder when no id in the database matches
   any id a human can see. Propose, do not assume.
5. **`project_id` only where it cannot be derived.** ⚠ This REVERSES the lean in §8.1: derive it
   from `instance` when there is one, and store it only on Unassigned rows, which have no instance to
   derive from. Deriving costs a join; storing hands an attacker the project grouping for free.
6. **Tombstone removed texts.** A deleted text does not need a live row for ever, and corpus size
   over time is itself a signal.
7. **Keep ids out of logs.** 13 handlers return `message: e.message` straight from a Drive error, and
   Drive errors can carry file ids. Sanitize before returning or logging — cheap, and it is the kind
   of leak that survives every other precaution.
8. **Give the client only its scope.** `listView` returns the whole account today; under Phase C it
   must return only a member's scope, and a client with no need for folder ids should not receive
   them. Attack surface is not only what is stored — it is what is handed out.

### 10.5 The claim the documentation must make once the index exists

Not yet true — the table does not exist — so it is recorded here rather than written into
DEVELOPERS.md prematurely. When the index lands, the accurate claim is:

> Corpus **content** and device inventory reports are end-to-end encrypted: D1 holds ciphertext that
> only the researcher's key opens. The corpus **index** — how many texts exist, which device holds
> which, and which share a recording — is server-visible by construction, because the worker must
> authorize access without being able to read content. Device names and Drive pointers are encrypted
> at rest under a key held in Worker secrets, so a database-only breach does not open them.

⚠ **Do not let "E2EE" stand unqualified anywhere once this ships.** The phrase will be read as "the
server knows nothing", which will then be false, and a security claim that is 90% true is worse than
a precise one — it is the 10% that gets somebody hurt.

### 10.6 The alternative, and why not

The index must be server-readable *because the worker authorizes access*. The alternative is
client-side authorization with capability tokens, leaving the server unable to see structure at all.
Rejected for this threat model: it moves trust onto devices that may **leave the team's control**, which is the
scenario the suite is explicitly built for. Server-side authorization with a minimized, encrypted-at-
rest index is the weaker-secrecy, stronger-control trade — and it is a considered trade, not a
default that nobody examined.

---

## 11. Drive itself as a target — what we must not make worse

Seth: *"The Google Drive Folder is a potential attack target as well. Security for that is primarily
Google's problem and that of the account owner, but we should definitely try to make sure our app
suite doesn't introduce holes there."* Right on the division of responsibility. This is our half.

### 11.1 Do titles or folder names have to be plaintext in D1? No.

- **Titles: never.** The worker authorizes on `doc_id → instance_id / project_id` and never consults
  a title to decide anything. Titles live in the manifest. §10.4(3).
- **Folder names: not stored in D1 at all.** What D1 holds is `instance.nickname`, which the worker
  USES to name the Drive folder; encrypting it at rest (§10.4(1)) takes it out of a dump while the
  worker goes on using it.

⚠ **But do NOT extend that to obfuscating the Drive tree**, and the reasoning is the durable part:

- against a **D1-only breach**, Drive folder names are irrelevant — the attacker has no Drive;
- against a **Drive-account compromise**, they are equally irrelevant — the `.flextext` and the audio
  are sitting right there in the clear. The content is the prize; the label adds nothing.

Obfuscation therefore defends against neither realistic threat, while destroying the property this
whole design rests on: that a researcher can open Drive and understand it, and that a folder is
droppable straight into FLEx or ELAN. **Legibility in Drive is a deliberate trade, not an oversight.**

A title in D1 is a different case *because it is readable in the one breach where content is not* —
which is exactly what earns that rule and does not generalise to Drive.

### 11.2 Two things already right — protect them

- **OAuth scope is `drive.file`.** The app can only ever see files it created; even total worker
  compromise cannot read the rest of the researcher's Drive. ⚠ Widening to `drive` or
  `drive.readonly` takes the blast radius from "our files" to "their entire Drive". Treat any such
  change as requiring Seth's explicit decision, not a convenience during development.
- **Nothing is ever link-shared.** No Drive `permissions` call exists anywhere in the worker; access
  is proxied through private streaming tokens (Seth's decision, recorded in the code). Do not
  introduce `anyone-with-link` as a shortcut for sharing a text with a colleague — Phase C's
  membership model is the mechanism for that, and a link grant is unrevocable in practice.

### 11.3 Three holes that ARE ours

1. **`/v1/textfile/<token>` — the one that matters.** Unscoped at mint (the file id arrives in the
   REQUEST BODY at all three mint sites), unrevocable at serve (it checks only that the token
   decrypts, has not expired, and that the named researcher still has a refresh token — no DB row,
   no session, no membership), and `clampTtlDays` permits up to **400 days**. That is a long-lived
   bearer URL that streams a Drive file to whoever holds it: the one place this suite manufactures
   Drive access outliving every other control. Put the scope INTO the token (owner, project,
   instance, doc, granting member, `jti`), re-check it against live D1 at serve, and clamp
   member-minted TTLs far below 400 days. Also in `project-split.md` VII.3.
2. **Write-anywhere within scope.** `upload/start` passes `body.folderId` and `body.docId`
   unverified into `driveEnsureTextFolder`, so a device can direct an upload into any app-created
   folder whose id it knows. Register-first (§3.1) closes it by construction.
3. **The refresh token is the crown jewel.** `drive_refresh_enc` is encrypted at rest under a Worker
   secret, so a D1 dump cannot use it — but a **Worker** compromise yields `drive.file` access to
   everything the app ever created. Minimal scope is the only structural mitigation and it is
   already in place; the only real remedy afterwards is the researcher revoking the app's grant at
   `myaccount.google.com` and re-authorising. ⚠ Write that down as a procedure in the runbook. A
   recovery step invented under pressure is one performed badly.

### 11.4 One thing to know rather than fix

`trashFiles` sets `trashed:true`, so "deleted" content stays recoverable for ~30 days. That is
deliberate and it is a SAFETY feature — the audit confirmed it is what makes a mistaken Remove
survivable. But it means deletion is not deletion for a month, and the researcher
should be told so rather than assuming otherwise. The nuclear-option wipe (Seth's, in
`project-split.md`) is the path that must genuinely purge, not trash.

### 11.5 What the RESEARCHER needs to be told — and it is narrower than it looks

Seth: *"the user should know that it's wise to take the fact that device and folder names are in the
database into account when naming said folders and devices."* Yes — but the advice should be aimed,
because aimed advice gets followed and blanket advice gets ignored.

**Device nicknames are the naming choice that matters.** A device name identifies a PERSON, and that
identification is **not recoverable from the file contents**: a `.flextext` of Mark 3 does not say
who transcribed it. So a nickname is the one label that hands an attacker something they could not
otherwise derive. It is plaintext in D1 today (§10.4(1) queues encrypting it) and it is in the Drive
folder name always.

**Text titles mostly do not matter, and we should not pretend otherwise.** They are in the Drive
folder name and the manifest, never in D1 — and against a Drive-account compromise, obfuscating a
title achieves nothing, because the `.flextext` itself discloses what the text is. Advising coy text
titles would be theatre that costs real usability and buys nothing.

⚠ **And the timing fact that changes the advice from "name carefully" to "name carefully BEFORE the
first upload":** `driveEnsureDeviceFolder` uses the nickname ONLY when it creates the folder. Once
`instance.oauth_folder_id` is set, the folder is resolved by id for ever and is never renamed. So:

- renaming a device in the panel updates D1 and **leaves the Drive folder's name unchanged**;
- the name that lands in Drive is chosen once, at first upload, and is frozen from the app's side;
- **renaming the folder by hand in Drive is safe** — resolution is by id, so nothing breaks. That is
  the actual remedy, and it is worth saying out loud, because the researcher's instinct will be that
  renaming in Drive will break the link. It will not.

**Where this belongs, in order of value:**

1. **In the panel, at the moment a device is named** — a one-line hint under the nickname field. That
   is where the decision is actually made; a warning in a document read once, months earlier, is not.
2. **In `docs/help/`**, with the rename-in-Drive-is-safe remedy, since that is the recovery path for
   everyone who has already named a device after a person.
3. Here, for the reasoning.

Not built. Item 1 is small and self-contained and would be a good thing to land alongside the
nickname-encryption work, so the hint and the protection arrive together.

---

## 12. Researcher identity: the pattern exists, one lane skipped it

Seth: *"we do still need to work on obfuscating or encrypting researcher email addresses and domain
names, ideally in a way I as admin can recover, but that wouldn't be readable in a D1 dump."*

Checked, and this is smaller than it sounds — it is not a new scheme to design, it is an existing
one to finish applying.

### 12.1 Already correct — the password lane and the domain list

| column | protection |
|---|---|
| `researcher.email_sha256` | HMAC under `SERVER_HMAC_KEY` — lookup + uniqueness, not reversible |
| `researcher.email_enc` | **AES-GCM at rest.** Its own comment: *"for sending resets; keeps D1 dumps clean"* |
| `researcher.totp_secret_enc`, `wrapped_kr`, `escrow_kr` | encrypted / wrapped |
| `approved_domain.domain_hash` | HMAC — matchable without being readable |
| `approved_domain.note_enc` | AES-GCM at rest (the operator's own label, which may name the org) |

The shape Seth is asking for is exactly `email_sha256` + `email_enc`: **a deterministic HMAC for the
lookup the worker must do, plus an AES-GCM copy for the recovery the operator must be able to
perform.** The worker (and therefore the admin, through it) can read it; a database dump cannot.

### 12.2 The gap — the Google sign-in lane, added later, did not follow it

All plaintext today:

- **`drive_email`** — the researcher's Google address, in the clear;
- **`display_name`** — in practice a person's real name;
- `avatar_url` — a Google URL that can embed an account identifier;
- `google_sub` — Google's stable user id (not an email, but a durable handle);
- `drive_folder_id` — a direct Drive pointer (already queued as §10.4(2));
- `drive_error` — free text from Drive, which can carry ids and addresses.

⚠ Note the worker genuinely needs `display_name`, `avatar_url` and `drive_email` at one moment: the
invite-claim response shows the device *"managed by «name»"* so the field user can confirm who they
are enrolling with. `encAtRest` supports that — decrypt on the path that needs it — so this is not a
functional obstacle, only work.

### 12.3 Domains are half-done

`domain_hash` makes a domain **matchable but not recoverable**: the operator can test membership and
read their own `note_enc` label, but cannot list which domains are actually approved. If admin
recovery is wanted (Seth's *"ideally in a way I as admin can recover"*), add a `domain_enc` beside
the hash. Same row, same primitive, additive.

### 12.4 Doing it safely

1. **Additive columns + backfill + NULL the originals.** ⚠ The step that gets forgotten is the last
   one: adding `drive_email_enc` while leaving `drive_email` populated protects nothing. The
   migration is not finished until the plaintext column is empty, and the rehearsal test should
   assert exactly that.
2. **Admin recovery goes THROUGH the worker, never by reading D1.** There is already an
   operator-gated route to copy (`POST /v1/researcher/admin/backfill-projects`), so the pattern
   exists; the recovery endpoint should log every use, because an operator-readable identity lookup
   is precisely the thing that wants an audit trail.
3. ⚠ **Concentration risk on `SERVER_HMAC_KEY`, which CLAUDE.md records as unrotatable in
   production.** Every column above ties more value to that one key. Two mitigations worth building
   in now rather than later: derive a **purpose-bound subkey** per use (`email`, `drive`, `ip`)
   rather than using the root key directly, and store a **version marker** with each ciphertext so a
   future re-key is a migration rather than an impossibility. The HMAC lookup columns are the ones
   that genuinely cannot move; the AES-GCM ones need not be stuck too.
4. **What cannot be fixed, and does not need to be:** `email_sha256` must stay deterministic or login
   lookup breaks. That is fine — it is not reversible, and without the key an attacker cannot even
   confirm a guessed address.

---

## 13. Compartmentalisation — what a lost device may reveal, and what it may not

Seth, 2026-08-19: *"we want a seized device to expose nothing other than data on that device… And we
don't want anything compromised to lead to anything else as much as possible. Names, contacts,
associates, originating Google account or researcher, other devices, other researchers or
organizations."*

That is a compartmentalisation rule, and it is a better organising principle than "encrypt more
things". It is written here as the test to apply to every future feature: **does holding this
artifact tell you anything about a person or a system OTHER than the one it belongs to?**

### 13.1 Names: encrypt in D1, do NOT move them into Drive manifests

Seth asked whether device/folder names could live in Drive manifests so D1 need not hold them.
**No — and the reason is decisive rather than a trade-off:**

⚠ **The device folder is NAMED after the nickname.** Putting that name into a manifest *inside that
folder* hides nothing; it is already the folder's own name in the Drive tree. The manifest would be a
second copy of a visible fact, not a protection.

The costs, had it protected anything:

- **Latency and the subrequest cap.** Production carries 34 instances. Per-folder manifests would be
  34 Drive reads on every 12-second dashboard poll, against the ~50-subrequest budget that killed
  `drive-purge` twice. A single manifest at the estate root is 1 read per poll instead of 34 — still
  a Drive round trip on a hot loop.
- **A new failure mode.** Drive down, token expired, or OAuth grant revoked ⇒ the panel cannot name
  any device at all. Today that information is local and always available.
- ⚠ **Drive is not the safer store.** The researcher's Google account is a larger and more-attacked
  surface than a D1 an attacker must already have breached. Moving identifying data toward Drive
  moves it toward the bigger target.

**So: `encAtRest` on `instance.nickname` (§10.4(1)), Drive stays legible (§11.1), and manifests carry
text-level metadata — `recording_id`, title, TTL — rather than a duplicate of a name Drive already
displays.** Same protection against the stated threat, no latency, no new failure mode.

### 13.2 Pairing by NUMBER, not by identity — replaces the claim response's disclosure

Seth: *"we don't want to present the Google account and avatar with the invite. Too risky. Better
just a pairing number… the researcher either pairs in person or over another secure communication
channel matching the number on both ends. Just like Bluetooth pairing."*

Agreed, and it is strictly better on three axes, not just privacy:

Today the claim response returns `{ name, avatar, email }` from the researcher row (v1.js, both claim
paths), so **a device that has left trusted hands names the researcher and their Google account.**
That is precisely a compromise leading to something else.

A short numeric code, shown on both ends and matched **out of band**, gives:

1. **Disclosure:** the device learns nothing about the researcher.
2. **Mutual authentication:** the field user confirms they are pairing with the right person because
   the number matches what that person told them — not because a name appeared on a screen, which
   any leaked link could also produce.
3. **Possession is no longer sufficient.** A phished, forwarded or found invite link cannot complete
   a pairing without the number, which travelled by a different channel.

⚠ **It must be matched OUT OF BAND or it is theatre.** If both ends learn the number from the worker
over the same channel, it proves nothing. The researcher reads it aloud in person or over a call; the
field user confirms it on the device.

**And it simplifies §12.** That claim response was the one place the worker needed `display_name`,
`avatar_url` and `drive_email` decrypted on a hot path. Remove it and those three columns can simply
be encrypted at rest with no exception carved out for them. A security change that makes the other
security work *easier* is worth taking on that ground alone.

### 13.3 What a device out of trusted hands exposes — audited

| It holds | Leads to anything else? |
|---|---|
| its own texts and audio | **inherent** — that is what the device is for |
| its `Ki` | no — decrypts only its own reports |
| its `instance_id` / `install_id` / install secret | no — the desired lane is per-instance |
| anything about OTHER devices | **no** — verified: nothing cross-instance is delivered |
| anything about other researchers or organisations | **no** |
| the researcher's name, avatar and Google address | ⚠ **YES, today** — fixed by §13.2 |
| minted `/v1/textfile` bearer URLs | ⚠ **YES** — unrevocable, long-lived (§11.3) |

**Two items, both already identified, and after both are closed a device would expose only its own
data — which is exactly the property Seth asked for.** That is a short list, and worth knowing it is
short: the per-instance design was already doing most of this work.

### 13.4 Later, and noted so the design does not preclude them

- **Optional password to decrypt on every app load**, and **a duress password that wipes instead of
  unlocking.** ⚠ One design constraint to respect now: a duress wipe must be **local and immediate**,
  completing before any network call — a wipe that needs to reach the worker first is useless under
  the circumstances it exists for. `eraseAllData()` already exists and is local, so the primitive is
  there; what would be new is the unlock gate and the second password.

  ⚠ **But Seth's objection to it is correct and should be recorded before anyone builds it** (2026-08-19):
  this suite is open source, so anyone who has read it knows the feature exists. That is not a flaw
  of publishing — security must never depend on the design being unknown, and a closed-source version
  would be one disassembly away from the same position. The feature bundles two things that fail
  differently, and only separating them is honest:

  - **Deniability — "there is nothing else here" — does not survive disclosure.** Someone who knows
    the feature exists knows to ask for both passwords. This half cannot be rescued.
  - **A fast wipe trigger does survive it.** Knowing the feature exists does not help once the wipe
    has run, and a password already in muscle memory beats finding a menu item under pressure.

  **So build it as a panic trigger and never describe it as deniability.** A user who believes they
  have deniability when they do not is in MORE danger, not less — the same reason accuracy is treated
  as a protective measure elsewhere in this document.

  Two alternatives that may be worth more than the feature itself:
  - **A dead-man timer** — wipe if the device has not checked in for N days. Survives disclosure
    equally well and does not depend on anyone acting correctly under pressure, which is the
    assumption a duress password quietly rests on.
  - **At-rest encryption whose key is not on the device**, because a device imaged at rest never
    reaches an unlock prompt at all and every unlock-time trick is moot against it.

  And the honest ranking: **holding less on the device beats all of it.** §13 does more real work
  here than any duress feature would.
- **Minimising owner-sees-assistant-email.** Seth: *"unavoidable at the moment, but it would be good
  for us to be thinking later how to minimize the exposure risk there."* The mechanism from §13.2
  generalises: **invite a researcher by CODE rather than by address**, so the owner never needs to
  hold the assistant's email at all and the account link is established by the same out-of-band
  match. Worth designing Phase C's invite flow so that this can be dropped in later rather than
  requiring the email column to be load-bearing.

---

## 14. Documentation — QUEUED, and deliberately AFTER the build

Seth, 2026-08-19: *"let's not update documentation right now, just put that in the plan. We want to
make architecture and design and UI changes FIRST (up through phase C at least) and THEN update
documentation."*

Right sequencing: most of what follows describes behaviour that does not exist yet, and documenting
unbuilt behaviour is its own kind of false claim. This section exists so the doc pass is a checklist
rather than an archaeology exercise — the content below was drafted and is recorded here rather than
shipped.

⚠ **One exception already taken, and it should not be re-litigated:** DEVELOPERS.md's E2EE wording
was *corrected* on 2026-08-19 because it was **already inaccurate about the code as it stands**
(§10.2). Correcting a false claim is not the same as documenting a new feature and does not wait.

### 14.1 A user-facing Drive page — `docs/help/google-drive.html`

Nothing currently tells a researcher any of this, and all of it is **true today**:

- **What gets created:** `FlexText Uploads/ → <device>/ → <text>/ → originals/`, plus `Unassigned/`.
- **The ownership boundary (§8a), stated for users:** *everything lives in one folder called
  `FlexText Uploads`; that folder is yours — move it, rename it, nest it wherever suits you, because
  the app finds it by an internal marker rather than by name or location. Leave the inside to the
  app.* ✅ Already true — `driveMasterFolder()` resolves by the `uploads-master` tag.
- **What may be rearranged:** the boundary folder freely; device and text folders may be renamed
  (they are tracked by identity). ⚠ Do **not** reorganise the inside — the app will put it back, and
  cannot distinguish that from a half-finished operation of its own.
- **`drive.file` scope in plain words:** the app can only ever see files it created; the rest of the
  Drive is invisible to it, and that is enforced by Google rather than by us. Reassuring, and true.
- **Three things that surprise people**, all verified against the code:
  1. **A device folder is named once.** The nickname becomes the folder name at FIRST upload; after
     that the folder is tracked by id, so **renaming the device in the panel does not rename the
     Drive folder.** ⚠ Rename it **by hand in Drive** — safe, nothing breaks, and people assume the
     opposite and so leave a person's name in place (§11.5).
  2. **Device names are the naming choice worth thought**, and text titles are not — a title is only
     as revealing as the text itself (§11.5). Say it in exactly that proportion; blanket "be careful
     what you name things" advice gets ignored.
  3. **"Remove" trashes, it does not delete.** ~30 days in Google's trash, deliberately, because it
     is what makes a mistaken removal recoverable — but "removed" is not "gone" until the trash is
     emptied (§11.4).
- Closing note: Unassigned means Drive has it and no device does, which is usually intended.

⚠ **Linking it costs a version bump.** `docs/help/*.html` is NOT precached (deliberate — see the
sw.js navigation-fallback comment), so the page itself can ship without one; but a link to it from
the panel is a `docs/js` + i18n change and therefore a bump. Land the link with whatever `docs/js`
change goes out anyway rather than bumping for a link.

### 14.2 README.md

Currently has **no data/privacy section at all** — it is the public front door and says nothing about
where a researcher's material lives. Add a short one: the single-folder boundary contract, the
`drive.file` scope, and a pointer to the help page. Keep it to a few sentences; the detail belongs in
help.

### 14.3 DEVELOPERS.md

- The **Drive ownership contract** as an architectural invariant, in the connectivity section: the
  app owns the layout inside the boundary, the boundary itself is the researcher's, resolution is by
  tag/id and never by name or parent.
- Once the index exists, **the exact E2EE claim from §10.5** — and never `E2EE` unqualified again.
- The identity model once built: `doc_id` vs `recording_id`, the three origins, register-first.

### 14.4 Written only when the corresponding feature ships

Do not write these ahead of the code: the reconciler and its precedence rules; pairing by number
(§13.2) and the removal of the identity disclosure from the claim response; encrypted `nickname`,
`drive_email` and `display_name`; `domain_enc`; per-project scoping under Phase C.

**Order:** architecture → design → UI → **then** all of the above, in one pass, against what actually
shipped.

---

## 15. Round-trips: what must pass through the worker, and what must not

Seth, 2026-08-19: *"We should limit our round-trips to Google Drive through the worker and API, and
as much as possible for things moving within Google Drive, we should use Google Drive API to move
them internally rather than routing them through the worker."*

Right, and the principle is worth stating once because it is easy to violate by accident. **Two
different costs are in play and they want different answers:**

### 15.1 BYTES — never route them through the worker for a Drive-internal operation

A Drive-internal change should be a Drive API call that moves no data:

| Operation | How it is done | Bytes through the worker |
|---|---|---|
| move / re-parent a folder | `files.update` + `addParents`/`removeParents` (`driveReparent`) | **none** |
| create a folder | `files.create` | none |
| rename | `files.update` | none |
| trash | `files.update {trashed:true}` | none |
| copy an app-created file | `files.copy` — **§2's sibling-doc copy** | none |

✅ **Already true.** Every move, adopt and unassign-sweep in this codebase is a metadata PATCH.

⚠ **There was exactly one violation, and it is gone**: `assign-copy` fetched a file from Drive and
re-uploaded it, so bytes went Drive → worker → Drive for what should have been an internal
operation. Removed 2026-08-19 (§7). Do not reintroduce that shape — if a copy is needed and the
source is app-created, `files.copy` does it server-side for one request and no egress.

**The two cases where bytes legitimately pass through the worker**, because the other end holds no
Drive credential and must not:

- **uploads** — the bytes originate on a device or in the panel; chunked and resumable precisely
  because the connection is weak;
- **`/v1/textfile` downloads** — Drive → worker → device. The device has no Drive token and giving
  it one would be the compartmentalisation failure §13 exists to prevent.

### 15.2 CALLS — the other cost, and the one that actually bites

Bytes are not the binding constraint; **the ~50-subrequest per-request cap is**, and it has already
caused two outages (`drive-purge`, twice) and one latent failure (the trash route, fixed 2026-08-19).
So "limit round-trips" mostly means *limit the NUMBER of Drive calls per request*:

- **Never one call per item** where one call per page will do. `driveListAll` is the model: under
  `drive.file` scope an unfiltered `files.list` returns the entire FlexText estate and nothing else,
  so the storage manager costs pages, not texts.
- **Bound anything that loops over items** with waves + a cap + a time budget, and return the
  remainder rather than silently truncating (`drive-purge`, and now `trash`).
- ⚠ **Resolve by stored id, never by search.** `files.get` is one strongly-consistent call;
  the `appProperties` tag search is one *eventually-consistent* call that can be minutes stale — the
  v167 duplicate-folder bug. Storing folder ids in D1 (§10.4(2), and the `driveMasterFolder`
  follow-on in §8a) therefore removes a round trip AND a consistency hazard at the same time. That
  is the strongest argument for the index that has nothing to do with authorization.

---

## 16. Should CROWD and UNASSIGNED become instance types? (Seth, 2026-08-19)

> *"We may need to make crowd a special type of instance."* … *"And same for the 'Google Drive
> (unassigned)' box."*

The unification is real and attractive: everything that owns a Drive folder and holds texts becomes
an `instance` with a `type` — `editor`, `recorder`, `crowd`, `unassigned`. One folder helper, one
upload lane, one place `project_id` lives, and §6's `text.instance_id` becomes never-null. Phase C's
project scoping would cover all four for free.

⚠ **They are NOT the same question, and they do not get the same answer.**

### 16.1 Crowd — defensible, with one hard blocker

A crowd recorder genuinely IS a thing that owns a Drive folder, belongs to a researcher, and
produces recordings. Making it an instance would delete a whole parallel lane: `driveEnsureCrowdFolder`,
a second chunked upload path, and the consent-prompt route this section was written to avoid building.

**The blocker is the security model, not the schema.** An `instance` has a `Ki`; its reports are
ciphertext. A crowd recorder is **deliberately keyless and plaintext** — CLAUDE.md: *"the public
recorder page is keyless, so it must be able to read its own config straight from the worker."* So
either `instance` stops implying E2EE, or crowd gets a key it cannot hold. That is a real property
to give up, not an inconvenience to route around.

Secondary cost: `crowd_recorder` carries ten columns `instance` has no notion of — `enabled`,
`submit_count`, `bytes_total`, `day_key`, `day_count`, `max_per_day`, `max_bytes_total`,
`drive_folder`, `config_json`, `label`. Public rate-limiting and quota are crowd-specific and would
need somewhere to live.

### 16.2 Unassigned — attractive, and I would argue against it

The panel already considered exactly this and rejected it, and the comment on `unassignedTexts` puts
it better than I would:

> *"⚠ IT IS NOT A PSEUDO-INSTANCE, deliberately. It has no instance_id, no ack_seq, no installs and
> no pairing secret… a synthetic entry there would have to be special-cased at every site that
> iterates instances."*

Making it a REAL row does not remove that special-casing — it **moves it from the panel into every
worker route** that assumes an instance can be commanded, keyed, approved, revoked or wiped. An
Unassigned instance can be none of those, so each of those routes grows a guard, and the guards are
the drift the backlog already warns about.

And §6 already has a cleaner answer: **`instance_id IS NULL` means Unassigned.** One nullable column
expresses it exactly, with no row that lies about what it is. §4's definition — *a recording with no
doc, or a doc with no instance* — stays a definition rather than becoming a lookup.

### 16.3 ⚠ The sequencing fact that gives this a deadline

`instance.type` carries `CHECK (type IN ('editor','recorder',''))`. **Widening it is a table
rebuild, not an additive migration** — the shape `migrate-instance-type-unified.sql` opens by warning
against in capitals. So if crowd is EVER to become an instance type, doing it inside Phase C's
migration is far cheaper than after it.

**That means the decision has a deadline even though the work does not.**

### 16.4 Recommendation, and what it blocks right now

- **Unassigned: no.** Keep `instance_id IS NULL`. The panel's existing reasoning holds and §6 is
  already cleaner than the alternative.
- **Crowd: decide before the Phase C migration, not now.** The E2EE question is the whole decision;
  everything else is mechanical.
- ⚠ **And it blocks the consent-prompt picker, which is why this is written down rather than built.**
  Seth asked for that "sooner rather than later" — but the client half (hidden carrier + status line
  + Upload button, reusing `paintPromptState`) is identical either way, while the TRANSPORT is not:
  a crowd-specific upload route is ~30 lines that becomes throwaway the moment crowd is an instance.
  **Building it before the decision means building the thing we would then delete.**

### 16.5 What actually differs, and how each difference survives unification

Measured against both tables. `instance` is 11 columns; `crowd_recorder` is 16. Five already align.

| | `instance` | `crowd_recorder` | If unified |
|---|---|---|---|
| id | `instance_id` | `crowd_id` | same column |
| owner | `researcher_id` | `researcher_id` | ✅ aligned |
| name | `nickname` | `label` | rename on migration |
| estate | `estate` | `estate` | ✅ aligned |
| project | `project_id` | `project_id` | ✅ aligned |
| Drive folder | `oauth_folder_id` | `oauth_folder_id` | ✅ aligned |

So the *shape* is already 6/11 identical. What follows is everything that is not.

**A. The key, and it is the whole decision.** An instance has a `Ki`; its `desired_blob` and its
reports are ciphertext. A crowd recorder is keyless, and `config_json` is *"plaintext by design: the
keyless public page must read it."* **How it survives:** a `type='crowd'` row simply has no Ki — the
engine already tolerates keyless instances (a provisional install has no key yet). But its config
cannot move into `desired_blob`, so a unified table carries **two config channels chosen by type**.
⚠ That is the drift risk, and it is the honest cost of unifying: one table, two rules.

**B. Installs.** An instance has enrollments with secrets, `ack_seq` and reports. A crowd recorder
has none — the public page is anonymous. **How it survives:** zero installs, which is already a
representable state. ⚠ But the panel renders that state as *"No device has claimed the invite yet"*,
which would be a lie for crowd — so every installs-derived affordance needs a type check.

**C. Invites.** Crowd has a public URL and no claim. **How it survives:** the invite/replace button
is hidden for `type='crowd'` (and the backlog already has that button needing type-awareness).

**D. The desired lane.** A crowd recorder never polls and cannot be commanded. **How it survives:**
refuse command pushes for `type='crowd'` at the route, not just in the UI — `cmd.forType` already
exists for exactly this shape of check.

**E. Rate limiting and quota** — `submit_count`, `bytes_total`, `day_key`, `day_count`,
`max_per_day`, `max_bytes_total`, `enabled`, `drive_folder`, `config_json`. Nine crowd-only columns.
**How it survives: a side table `crowd_config(instance_id PRIMARY KEY, …)`** rather than nine
nullable columns on `instance`. Two reasons: it keeps type-specific fields out of the shared row,
and — the practical one — **a side table is ADDITIVE**, so only the `type` CHECK forces a rebuild.

**F. `enabled` must NOT be folded into `revoked`.** They read alike and are not: `revoked` is
terminal and makes a device auto-release on its next poll; `enabled` is a reversible pause on a page
that never polls. Overloading them would make un-pausing a crowd page indistinguishable from
un-revoking a device, which the revoke path does not support.

**G. ⚠ The public projection is where a unified table is genuinely more dangerous.** A crowd
recorder has an anonymous public endpoint returning its config; an instance has no public projection
at all, and `drive_folder` is marked *"NEVER in the public projection"*. Today the separation is
structural — the public route reads a different table. Unified, it becomes a filter, and a filter is
a thing that can be got wrong. **How it survives:** the public route must build its response from an
explicit allow-list of fields, never by spreading a row, with a test that fails if an unlisted column
appears. That is the single guard this whole idea depends on.

### 16.6 Verdict on the shape

Unification is worth doing for crowd **if** the E2EE asymmetry (A) is acceptable and the public
projection is allow-listed (G). Everything else is mechanical: a rename, a side table, and type
checks on four affordances. The rebuild cost is the `type` CHECK alone, which Phase C's migration
is paying anyway.

**Unassigned stays as `instance_id IS NULL`** (§16.2) — none of the above applies to it, because it
has no config, no folder of its own beyond the sweep target, no quota and no public face. It is an
absence, and an absence is cheapest to model as one.

### 16.7 Invites and device settings — and the direction-of-travel problem

Seth: *"Obviously the invite link and device settings that do and don't apply would be different."*
Yes — and checking how the panel handles that today turned up the strongest argument against
unifying, which belongs in the record.

**There is no per-type settings form.** `GROUPS` is rendered whole: every tab, every field, for every
instance. The settings modal has no branch on `it.type` anywhere. And `instance.type` accepts `''`
because **`migrate-instance-type-unified.sql` deliberately ERASED the editor/recorder distinction** —
one device now runs both apps, so the type stopped meaning anything about which settings apply.

⚠ **So unifying crowd into `instance` runs against the grain of a migration that removed exactly this
kind of branching.** It would reintroduce a per-type settings model — for the first time — and the
crowd field set is not a subset of the device one: `welcome`, `maxSeconds`, `turnstile`, `lang` exist
only for crowd, while writing systems, gloss and segmentation settings, send options and auto-backup
are meaningless for a page that records one clip anonymously. Two disjoint-ish sets in one form.

That is not fatal, but it changes the accounting. The unification's appeal was *"one table, one lane,
fewer special cases"*; a per-type settings form, a per-type invite affordance, a per-type command
refusal and a per-type public projection is **four new branches** bought with one deleted table. The
honest question is whether that trade is still positive — and it is much less obviously positive
than it looked in §16.1.

**Concretely, what would need type-awareness if crowd joined:**

| Affordance | Editor/recorder | Crowd |
|---|---|---|
| Invite / Replace button | yes | **no** — public URL, no claim |
| Settings form fields | the device set | a disjoint crowd set, in plaintext config |
| Assign / commands | yes | **refuse at the route**, not just hide |
| Installs list, "no device yet" note | yes | **meaningless** — never enrolls |
| Public projection | none | allow-listed, and the guard everything rests on |
| Pause | `revoked` (terminal) | `enabled` (reversible) — §16.5 F |

**Revised recommendation.** The case for unifying crowd is weaker than it first appeared. What it
actually buys is one deleted upload lane and `project_id` uniformity; what it costs is reintroducing
per-type branching that a previous migration went out of its way to delete. ⚠ Since the only
*expensive* part is the `type` CHECK rebuild, the cheap middle path is worth considering instead:
**leave `crowd_recorder` as its own table, and give it the two things it actually needs from the
instance model — a consent-prompt upload route and `project_id` scoping under Phase C** — both of
which are additive and neither of which requires it to become an instance.

### 16.8 ⚠ A requirement that arrived after §16.7 and moves the verdict

Seth, immediately after §16.7 was written:

> *"We want to be able to 'assign' and 'move' texts to and from Google Drive (Unassigned) and be able
> to do all the same things with uploaded Crowd Recorder texts that we can do with texts on Google
> Drive and on Devices. So Crowd Recorders should create text folders with manifest files and work on
> Google Drive the same as the other 'device folders' as much as possible (though of course they
> won't be uploading flextext files)."*

Today a crowd submission uploads a **zip to the crowd folder root** — no text folder, no manifest, no
docId. The requirement makes crowd recordings **first-class texts**: their own folder, their own
manifest, movable to Unassigned, assignable onward to an editor device.

⚠ **That changes the argument, and §16.7 should be read knowing it.** §16.7 weighed the two TABLE
SHAPES and concluded the branching cost outweighed the benefit. This weighs the DATA MODEL, and it is
the stronger argument: if a `text` row's owner must be able to be a crowd recorder, there are only
two ways to express it —

1. **crowd is an instance type** — one owner column, `text.instance_id`, always meaning the same
   thing; or
2. **`text` gets a polymorphic owner** — `instance_id` OR `crowd_id`, nullable in complementary
   pairs, with every query and every guard having to remember which.

(2) is exactly the two-columns-one-meaning shape that produced the drift this whole document exists
to remove, and it would be baked into the NEW table rather than inherited. Against that, the
`type` CHECK rebuild and four UI branches look cheap.

**So the verdict swings back toward unifying — for a reason §16.1–16.7 never considered.** Not
settled here: §16.5's guards (the E2EE asymmetry, the allow-listed public projection, `enabled` vs
`revoked`) all still apply and are unaffected by this. What changes is only the weight on the other
side of the scale, and it is heavier than it looked.

**Consequence either way, worth separating from the unify decision:** crowd submissions need a docId,
a text folder and a manifest at upload time — which is `register-first` (§3.1) applied to a third
origin. §3's origin table gains nothing new conceptually; the crowd row simply stops being a special
case and becomes another way a text is born.

### 16.9 Crowd is a SOURCE, never a destination — which narrows §16.8

Seth: *"as much as possible we want it to participate in the drive-as-truth redesign, except that we
can't assign texts TO Crowd Recorders, we can only move and remove things FROM them."*

That is a real constraint and it is worth stating as one, because it changes how much the ownership
question actually costs:

- crowd uploads become **fully-fledged text folders with manifests**, movable to Unassigned or onward
  to a device, downloadable file-by-file or as a zip — everything a device text can do;
- but **nothing is ever assigned TO a crowd recorder.** It is where texts are born, never where they
  are sent.

⚠ **So a crowd recorder is a WRITE-ONCE owner and never a command target.** Every hard part of §16.8's
option 2 (a polymorphic owner on `text`) lives in the *destination* direction — assign, move-to,
command routing, ack tracking, lease-holding. None of that applies. What remains is a birth stamp
that only ever moves away.

That does not settle §16.8, but it shrinks it: the polymorphic owner would be read-mostly and
write-once, which is a much weaker version of the two-columns-one-meaning objection than the general
case. Worth re-weighing against the `type` CHECK rebuild when the decision is actually taken.

**And it gives a rule to enforce whichever way that goes:** the assign and move-to affordances must
refuse a crowd destination *at the route*, not merely omit it from a dropdown — the same shape as
§16.5 D.

### 16.10 Share the code, whatever the table shape says — and what that already bought

Seth, 2026-08-19, immediately after the crowd consent picker landed:

> *"And whenever a new recording is made and submitted, that should mirror how texts are created in
> text folders on devices, exact same folder structure, reparenting, etc as much as possible. And
> where we can use common code for both, that's a good idea. To avoid drift. Even if Crowd Recorders
> should not be a type of instance, exactly, which I do agree with."*

That last clause is the important one, because it **decouples two questions §16.1–16.9 kept treating
as one**. Whether `crowd_recorder` becomes an instance type is a D1 table-shape question. Whether a
crowd recording is born the same way a device text is, through the same functions, is a *code*
question — and it is answered yes regardless of how the first one goes. §16.7's verdict (leave the
table alone) and this instruction are not in tension; they are about different layers.

**Built now (v395), and it needed almost no new code, which is the point:**

- `driveEnsureCrowdTextFolder` calls `driveEnsureTextFolder` with the crowd folder standing in for
  the device folder. That is the whole implementation. Both crowd submit paths (single-POST and
  chunked) now land the zip inside a per-submission text folder instead of flat in the crowd folder
  root.
- **The submission id IS the doc id.** One submission is one text, and `sub_id` is already the
  identity in D1 *and* in the encrypted upload ticket — so the correlation costs no column and there
  is no second identifier that can disagree with the first. No migration.
- Everything downstream then works without a crowd branch anywhere: the folder carries `flextextDoc`,
  so `/move` and `/adopt` find it by tag, `driveReparent` re-homes it, the storage view rolls up its
  bytes, and a researcher who drags it elsewhere in Drive keeps ownership of it.
- The zip is tagged `flextextRole='crowd-submission'`, **not** `source-audio`: the panel resolves a
  text's audio by role, and claiming that role would make the download menu offer a bundle as though
  it were the bare audio file.

**One accident turned deliberate.** A crowd folder was untagged and unroled directly under master —
which is exactly `buildDriveEstate`'s definition of a *device*. Crowd recorders have therefore always
been listed as devices, without anyone deciding they should be, and one stray `appProperty` away from
silently changing. They now carry `flextextRole='crowd'`, the container filter admits that one role
explicitly, and each container reports `kind: 'device' | 'crowd'`. `test/drive-estate.test.mjs` pins
both halves, including that widening the filter did not re-admit "Unassigned" as a container (the bug
the original filter was written for). `kind` is also the hook for §16.9's rule — the panel can refuse
a crowd container as an assignment *destination* without inspecting names.

**Three things this deliberately did NOT do:**

1. **No manifest.** Crowd texts have no manifest because *device texts have none either* — the
   manifest is Phase C, and its format is not settled. Writing one crowd-first would be precisely the
   drift the instruction is aimed at. When it lands it must land in one shared writer used by both
   origins, and the crowd call site is already the right shape to receive it.
2. **The crowd → device handoff is still open.** `moveTextModal` delivers text content by extracting
   a `.flextext` from a STORE-only zip (`x:'flextext'`). A crowd zip contains a recording and a
   consent receipt and no `.flextext` at all, so moving a crowd text onto an editor device will fail
   `no_flextext_in_zip` today. The right answer is almost certainly to deliver the *audio* and let
   the editor create the transcription — i.e. a crowd text arrives as a fresh recording to be
   transcribed, which is what it is. Needs a decision before crowd texts are advertised as assignable.
3. **An abandoned upload now leaves an empty text folder.** The chunked path creates the folder at
   `/submit/start`, before any bytes arrive, so a visitor who starts and walks away leaves a 0-byte
   text in the estate. ⚠ Worth stating plainly: **this is not new behaviour, it is the device path's
   behaviour**, which has always created the text folder at start for the same reason (the upload
   needs a parent). Turnstile and the per-IP limit bound it. If it turns out to litter in practice
   the fix belongs in one place for both origins, not in a crowd-only sweep.

### 16.11 How crowd relates to the D1 text index — and why it is cheaper than §16.8 feared

Seth: *"how will Crowd Recorder relate to our D1 indexing system for texts? It should…"*

It should, and it already can, with **one nullable column** — because §16.9's constraint dissolves
the hard part of §16.8.

**The dilemma §16.8 posed was based on an assumption that turns out to be false.** It assumed a
`text` row's OWNER must be able to be a crowd recorder, forcing either a crowd instance type or a
polymorphic `instance_id`-or-`crowd_id` owner. But `instance_id` means *"which device HOLDS this
text"*, and a crowd recorder never holds anything — it emits. Texts move OUT of it and are never
assigned INTO it (§16.9). So from D1's point of view a crowd text is **born unassigned**:

```
doc_id       = the submission id (already true in Drive as of v395)
origin       = 'crowd'                 -- the sketch in §6 already has this value
instance_id  = NULL                    -- "Unassigned", exactly as §4 defines it
folder_id    = the text folder         -- non-NULL at birth; see the asymmetry note below
born_crowd_id = the recorder           -- NEW: a BIRTH STAMP, never a routing target
```

No polymorphic owner. No `type` CHECK rebuild. `origin` already records birthplaces, which is what a
crowd recorder is; ownership is a separate axis and crowd simply never appears on it.

**Why `born_crowd_id` rather than a join.** The attribution is *almost* free already: `doc_id` is the
`sub_id`, so `text JOIN crowd_submission ON sub_id = doc_id` names the recorder with no new column at
all. ⚠ But `crowd_submission` is **opportunistically pruned at 30 days** — deliberately, because that
log is "a visibility/forensics aid, not an archive". The text index *is* an archive. A join is
therefore an attribution that silently expires: a crowd recording still sitting in Drive six weeks
later would lose the name of the recorder that produced it. One write-once nullable column outlives
the prune and cannot be mistaken for an owner. **Recommendation: carry the column.**

**Reconcile with §4, which says a crowd submission is "a `recording_id` with no `doc_id`".** Those
are not in conflict once §2's many-docs-one-recording is applied: the submission is born as the
FIRST doc and stamps a `recording_id`; assigning it onward to a transcriber mints a SECOND doc
sharing that `recording_id`. §4's sentence describes the state *before* anyone transcribes it, which
under this model is simply `instance_id = NULL` — the same "upload now, assign later" shape §4 is
already pleased to have got for free. What v395 settled is only that the birth doc exists from the
moment the bytes land, which is what makes the folder addressable at all.

**⚠ The safety asymmetry (§3.2) runs the OTHER WAY for crowd, and that is worth saying out loud.**
For a device text, "no folder" is the normal state and the bytes exist only on a phone. For a crowd
text the folder is created *before* the bytes (the upload needs a parent), so the dangerous state is
inverted: **a crowd text row with a folder and no files is an abandoned submission, not a text whose
only copy is elsewhere.** It is the one origin where "empty folder" is safely collectable — but the
reconciler must key that on `origin='crowd'` explicitly, never on "folder exists but is empty",
which would be true of a device text mid-first-upload and is the one-careless-line bug §3.2 warns
about.
