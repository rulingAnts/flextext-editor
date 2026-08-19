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

- **Use Drive's native `files.copy`.** The current copy path streams the whole file *through the
  Worker* (`drive.usercontent.google.com` download → resumable PUT). Assigning one recording to a
  second device would therefore cost a full download plus a full re-upload through Cloudflare,
  against the subrequest budget. `files.copy` is server-side, moves no bytes, one request. This is
  the difference between the compare-two-workers workflow being practical and being avoided.
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
2. **Does the reconciler ever re-parent a folder without asking?** It is a write to the researcher's
   own Drive. Proposal: silent when D1's intent is unambiguous, surfaced for confirmation when the
   folder was moved by hand — `flextextUnassigned` already distinguishes "we swept this" from "the
   researcher filed it here", and exists for exactly this.
3. **A device-originated text the researcher wants in Unassigned:** force an upload first (safe, but
   needs the device online), or allow marking it and let the sweep resolve later? §3.2 argues hard
   for the first.

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
person, inside this project.* Under hostile-government scrutiny that is the output that matters: a
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
Rejected for this threat model: it moves trust onto devices that may be **seized**, which is the
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
survivable. But under seizure it means deletion is not deletion for a month, and the researcher
should be told so rather than assuming otherwise. The nuclear-option wipe (Seth's, in
`project-split.md`) is the path that must genuinely purge, not trash.
