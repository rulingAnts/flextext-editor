# Google Drive Storage Manager (Seth, 2026-08-12) — APPROVED BUILD SPEC

A modal reached from the panel's top nav (beside History / Admin) that shows what the researcher's
Drive actually holds: every text, which device holds it or that it is unassigned, the space each
takes, the account's quota — and the ability to remove unassigned texts and reclaim the space.

## Why

Two gaps that only became visible after assign-by-upload:

1. **The panel's text lists are keyed off DEVICE INVENTORY.** A text uploaded and then removed from
   a device disappears from the panel while its Drive folder remains. There has never been a view of
   what is actually IN Drive, so those texts are invisible and their space is unaccounted for.
2. **Storage has no readout at all.** The v2 restructure deliberately traded bytes for a consistent
   folder shape — every text now lands its full original audio in `originals/`. A researcher on a
   free 15 GB Google account shares that quota with Gmail, and the failure mode is a device retrying
   an upload forever against a quota error it cannot fix.

## Locked decisions (Seth, 2026-08-12)

1. **Done marker: appProperties TAG is the truth, folder name carries a visible `(done)` suffix.**
   Nothing ever READS the name — same rule as `<Storyname>` today, where a stale name is cosmetic
   and breaks nothing. The suffix exists so a linguist browsing Drive sees it without our tools.
   ⚠ `docDone` does not currently reach the worker at all (it is a local callback field gating
   auto-delete), so this is new plumbing, not a display change.
2. **Only UNASSIGNED texts may be deleted.** A text still on a device keeps its Drive backup; to
   delete it, remove it from the device first, at which point it becomes unassigned. Two steps, and
   the safety property is real: Drive is the archive, and the device can be lost or wiped.
   ⚠ The worker CANNOT enforce this — device inventories are E2EE, so only the panel knows what is
   assigned. The gate is therefore a researcher-facing safety rail, not a security boundary, and it
   is stated as such rather than pretended otherwise.
3. **Delete = Drive trash (recoverable 30 days), plus a separate explicit reclaim.**
   ⚠ Trashing does NOT free quota: `usageInDriveTrash` is counted inside `usage`. A researcher who
   is out of space and deletes will see the number not move, conclude the feature is broken, and be
   right to. So the modal shows trashed bytes beside the total with an explicit reclaim action.
   ⚠⚠ **The reclaim must NOT be `files.emptyTrash`** — that empties the user's ENTIRE Drive trash,
   including unrelated personal files, and needs a broader scope than `drive.file`. It permanently
   deletes each FLEXTEXT file that is trashed (`files.delete` per file), which is precise, scoped to
   what we created, and honest to describe.

## What makes this cheap

`drive.file` scope means we can only ever see files THIS APP CREATED. So a single paginated
`files.list` returns the entire estate — no per-text round trip — and grouping happens from each
file's `parents`. One or two API calls for a typical account instead of one per text.

The same scope bounds the blast radius of everything destructive here: nothing outside FlexText's
own files is reachable, by construction rather than by care.

## Worker — `worker/src/v1.js`, additive only (straight-to-prod eligible)

- `driveListAll(access, {trashed})` — paginated `files.list`, `fields=files(id,name,size,mimeType,
  modifiedTime,parents,appProperties,trashed)`, bounded page count.
- `GET /v1/researcher/drive-estate` → `{ quota, master, devices[], texts[], trashed{n,bytes} }`.
  - `quota` from `GET /drive/v3/about?fields=storageQuota` — `limit` ABSENT means unlimited (pooled
    accounts); treat missing as no-limit, never as zero.
  - text folders are those tagged `flextextDoc`; their `originals/` (or legacy `assignment/`) child's
    files roll up into the parent text's byte total.
  - `bytes` per text sums `size` over its files. Folders have no size.
- `POST /v1/researcher/drive-purge` → permanently delete OUR trashed files. Returns `{deleted, bytes}`.
  A 404 on a child whose parent folder was deleted first is expected and ignored.
- Done marker: uploads may carry `x-fx-done: '1'|'0'`. On `'1'` the text folder gets
  `appProperties.flextextDone='1'` and a `(done)` name suffix; on `'0'` both are cleared. ABSENT
  means NO CHANGE — old engines send nothing and must not clear a marker they know nothing about.

## Device — `docs/js/upload.js`

Send `x-fx-done` on the text upload (both the single-POST and chunked-start paths), from the queue
record's existing `docDone`. Old workers ignore unknown `x-fx-*` headers, so deploy order cannot
break this.

## Panel — `docs/js/researcher-panel.js`, `docs/js/researcher.js`

- A third nav `link-btn` beside Admin / History.
- Modal: quota bar (used / limit, with trashed shown separately), then groups — one per device, then
  **"Google Drive (unassigned)"** — each listing texts with size, file count, `(done)` marker, the
  existing Files ▾ control, and (unassigned only) Remove.
- Assigned-ness is computed panel-side by intersecting estate `docId`s with every device inventory.
- Reclaim action, worded as what it does: permanently delete the FlexText files already in trash.

## Tests

- `drive-estate.test.mjs` — the grouping/rollup from a fake `files.list` (originals rolled into its
  parent text; folders contribute no bytes; a text with no device is unassigned; absent quota `limit`
  is unlimited, not zero).
- Extend `text-folder-files.test.mjs` / a new one for the done-marker rules, especially that an
  ABSENT header changes nothing.

## Deploy record — production worker, 2026-08-12

Triggered from this session at Seth's request (Actions on a public repo with standard runners are
free, so no cost approval was needed).

| | |
|---|---|
| Deployed from | branch `staging`, sha `129f76a` |
| Workflow | `worker-deploy.yml` (run `31575642967`, success) |
| Worker | `flextext-r2-worker` (production) |
| **New version ID** | `91967304-8061-4c0b-b3b8-2b3b88f9f302` |
| **ROLLBACK TARGET** | `60a1e3a9-2b5d-496e-bc0d-4e9b9f071a7f` (was live, deployed 2026-08-12T02:46:33Z) |

Deploy log confirmed the production target: `connect.flextext.app` retained (NOT reassigned — the
2026-08-11 incident did not recur), D1 `flextext-connectivity`, R2 `flextext-back-end`,
`ALLOWED_ORIGINS` starting `https://rulingants.github.io`. The single warning was wrangler noting
that no `--env` was given, which is correct here: no flag means the top-level production
environment.

**Roll back** via `wrangler (one-off command)` on branch `staging`:
```
rollback 60a1e3a9-2b5d-496e-bc0d-4e9b9f071a7f --message "reverting drive-storage worker"
```

⚠ **The deployed worker is now AHEAD of `productionWeb`, which does not carry this code.** A routine
"Deploy worker" run from `productionWeb` would silently roll these endpoints back and the storage
modal would return `not_found` again. Until the editor release merges to `main`/`productionWeb`,
always deploy the worker from `staging`.

## Round 2 — decided 2026-08-12 (Seth). NOT YET BUILT.

### A. "Unassigned" appears in the DEVICES display, not just the storage modal

A card in the dashboard's device list holding every text no device claims, with **all the same
options as a device row** — Files ▾, Move…, and **"Remove from Google Drive"** in place of
"Remove from Device".

⚠ **It is NOT a pseudo-instance** (Seth agreed). It has no `instance_id`, no `ack_seq`, no installs
and no pairing secret, so it is rendered by the SAME row components from the Drive estate, and **no
fake instance_id ever reaches the worker**. Everything that iterates `lastData.instances` must stay
untouched; a synthetic entry there would have to be special-cased at every one of those sites, which
is precisely the "rule enforced in app.js that the satellites reach by a different path" drift the
backlog warns about.

### B. Move from Unassigned → a device is a REAL re-assignment (Seth: "AND re-filing the folder")

Not merely re-parenting the folder. It is the existing move flow with no source device to remove
from: mint token URLs from the Drive files → assign command → the device downloads and the text is
live again → the folder re-parents under that device. The return trip already exists
(`driveTextHousekeeping` clears `flextextUnassigned` and moves the folder back on the next upload),
so the re-filing half is largely built; what is new is offering the action with Unassigned as the
SOURCE.

### C. Storage limits + warning banner

- Researcher sets a **limit for the FlexText Uploads footprint** (our own files, not the whole
  Google account). Banner in the panel as usage approaches it.
- **What is blocked at the limit — decided: OPTIONAL UPLOADS ONLY.**
  Hard-block new ASSIGNMENTS and optional extras (derived files, repeat backup copies). **NEVER
  block a text's first upload of its originals.**
  ⚠ The reasoning is the load-bearing part: a text that exists only on a device is unbacked-up work,
  and the person who sets the limit is not the person who pays for it. A translator who finishes
  hours of work must always be able to get it off the device; they cannot raise a limit or free
  space, and a lost or wiped device would take the only copy. The limit throttles what is
  replaceable and never what is irreplaceable.
- The coworker is not warned — same asymmetry as the invite-override warning: the researcher weighs
  the decision, the field user is not asked to.
- **Usage tracking — decided: a running total in D1**, incremented as each upload lands, and
  RECOMPUTED from the true estate whenever the storage modal is opened. Cheap per upload,
  self-correcting, and can only drift slightly between refreshes. Explicitly NOT a per-upload
  estate walk — that is the critical-path cost just removed from the done marker.

⚠ **This is the first D1 SCHEMA CHANGE in this feature set** (a byte counter + its timestamp on the
researcher row). The release order therefore becomes **D1 migrate → worker deploy → editor**, per
the runbook — every previous step in this feature has been schema-free.

### D. Assignment/movement history in the manifest — OPEN, not decided

Seth: *"Maybe our manifest file can also list the history of text assignment/movement."* The
manifest is written ONCE at upload time, so it cannot accumulate history without being rewritten on
every move — which would stop it being an immutable record of what was uploaded. Recommendation: a
SEPARATE append-only `flextext-history.json` beside it. Also undecided: what it records, given
device nicknames are personal data and this file sits in Drive beside consent material.
