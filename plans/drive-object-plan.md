# drive_object — the per-project Drive authorization table (build plan)

Status: **Phase 1 in progress.** This is the spec fix VII.1 called "DO THIS FIRST" and the completeness
critic's precondition for un-deferring `assignTexts`/`drive` — the nine gated Drive findings are
*unreachable, not repaired*, and this is what repairs them.

## The problem it fixes (VII.1 / R2-1)

Phase C's Drive routes were scoped to "resolve a folder by parentage, check it's under the member's
project." But this codebase **deliberately does not treat parentage as identity** — folders are found
by `appProperties` TAG, never by where they sit (`driveEnsureTextFolder`, `buildDriveEstate`,
`/texts/<docId>/files`), and `drive-unassign` re-parents finished texts to an account-level
"Unassigned" that belongs to no device. Build to the parentage spec and a member with Drive access
loses exactly the swept texts and any hand-filed folder — it fails *closed*, so it is a wrong
mechanism rather than a hole, but it is wrong.

**Replacement:** move Drive authorization into D1. One additive table, stamped at creation, resolved
by one indexed lookup. Parentage becomes display only.

## The table

```sql
CREATE TABLE drive_object (
  object_id   TEXT PRIMARY KEY,   -- the Drive file OR folder id
  kind        TEXT NOT NULL,      -- device | text | originals | project | unassigned | crowd | file
  doc_id      TEXT,               -- flextext docId (text folders + their files); NULL otherwise
  instance_id TEXT,               -- owning device; NULL for account-level (project/unassigned)
  project_id  TEXT,               -- ⚠ THE AUTHORIZATION KEY
  created_by  TEXT,               -- researcher_id that created it — makes "texts they made themselves" expressible
  created_at  INTEGER NOT NULL
);
-- indexes: project_id (auth), instance_id + doc_id (display/resolution)
```

⚠ Two facts to write down rather than rediscover (VII.1): it starts EMPTY against the existing estate
and needs a one-time idempotent backfill or every pre-existing file is denied day one; and it persists
a `doc_id ↔ instance_id` map in D1 **plaintext** — consistent with the plaintext tier, but a
deliberate widening, recorded here.

## The phases — each additive and independently deployable (backend-first)

**Phase 1 — table + STAMPING (additive, invisible).** ← in progress
Create the table; stamp a row at every worker Drive-object creation point (device/text/originals/
project/unassigned/crowd folders, and uploaded files). Nothing reads it for authorization yet, so
behaviour is unchanged. Deploy early so it captures every NEW object while the rest is built — then
only OLD objects need the backfill. Stamping lives in one pure, testable helper
(`worker/src/drive-object.js`, tested directly like `project-teardown.js`, since Drive routes cannot
run on the rig).

**Phase 2 — backfill (operator-gated, idempotent).** Populate drive_object for the existing estate
from `driveListAll`, same pattern as `backfill-projects`. Re-runnable, mints nothing twice.

**Phase 3 — authorization (behaviour change — the careful part).** Convert the ~13 account-wide Drive
routes to resolve the object via drive_object → project_id → `authMember(project)` instead of an
account-wide tag/docId search. Keep drive_object.project_id in sync when a device/text moves projects
(/projects/assign, /texts/*/move). Each conversion tested via the extract-and-shim pattern (#7).

**Phase 4 — re-enable (one line, once the routes are real).** Remove `assignTexts` and `drive` from
`DEFERRED_CAPS`. The tripwire in `check-project-scoping.sh` fails until this is deliberate; the nine
findings are now REPAIRED (scoped), not merely gated. Ships after Phases 1–3 are live and proven.

## Invariants to hold

- **Creation ⟹ stamped.** A Drive object the worker creates without a drive_object row is a hole in
  Phase 3's authorization. Stamp inside the creation helpers, not at scattered call sites, so it
  cannot be forgotten.
- **project_id tracks where the object IS now**, updated on every move — never a creation-time
  snapshot (the mistake member_key.project_id made; see the read-time scoping fix).
- **Fail closed.** An object with no drive_object row is denied to members (owner still reaches it
  via ownership) until the backfill or a re-stamp covers it.
- **Additive at every phase.** The deployed worker keeps working against the new table (ignores it)
  until the phase that reads it ships.
