# Containing Drive access: what a compromise of this suite could and could not reach

> Seth, 2026-08-20: *"is there a way to scope our app's Google OAuth permissions to make sure a
> security hole in our app suite wouldn't potentially give an attacker full access to a researcher's
> Google Drive data outside our app suite's own folder that it creates and manages?"*

**Yes, and it is already what we do.** The suite requests exactly one Drive scope,
`https://www.googleapis.com/auth/drive.file`, which is the narrowest scope that can do this job. This
document exists to record *why that is the answer*, what it does and does not guarantee, what risk is
genuinely left over, and which of the remaining options are worth taking later — because a scope is
the kind of thing a future feature widens for one good-sounding reason, and then it is widened
forever.

## Where we stand today (verified 2026-08-20, v433)

One place in the whole repository names a Drive scope:

```
worker/src/v1.js:1578   scope: 'openid email profile https://www.googleapis.com/auth/drive.file'
```

Three properties fall out of that, and all three are worth keeping deliberately:

- **`drive.file` and nothing else.** No `drive`, no `drive.readonly`, no `drive.metadata`.
- **No client-side Google OAuth at all.** `docs/js/` never talks to `accounts.google.com` and never
  loads the Google Picker. Every Drive call in the suite goes through the worker.
- **One chokepoint.** Because there is exactly one scope string, a guard over it is possible and
  cheap — `test/google-only-auth.test.mjs` now fails the build if a broader Drive scope appears
  anywhere in the worker.

## What `drive.file` actually guarantees

`drive.file` is a **per-file** grant, not a per-folder one. The app can reach a file only if the app
**created** it, or the user explicitly handed it over through the Google Picker (which we do not
use). It is not "access to the FlexText folder" — it is "access to the files this app made".

That distinction produces two consequences, and the second is the counterintuitive one:

- ✅ **A researcher's other Drive files are unreachable, permanently and by construction.** Their
  photos, their organisation's shared drives, a colleague's documents — a token minted under this
  scope cannot list them, cannot read them, cannot see that they exist. This is the property the
  question was asking about, and it holds at Google's servers rather than in our code, which is what
  makes it worth relying on.
- ✅ **A file the researcher drags INTO the FlexText folder does not become reachable.** Parentage
  grants nothing under `drive.file`. If someone files a personal document alongside their texts, the
  app still cannot see it.
- ⚠ **A file the app created stays reachable after it leaves the folder.** Moving a text out of
  "FlexText Uploads", renaming it, or filing it elsewhere does not revoke our access to it — the
  grant followed the file at creation. Nothing here depends on that, but anyone reasoning about
  containment should know the boundary is the *set of files we made*, not the folder they sit in.

## `drive.appdata` — considered, and rejected on the arithmetic

Seth, 2026-08-20: *"Actually, drive.appdata would be OK with me. It's OK with me if they can only
access files through the researcher panel, as long as that route actually works."*

⚠ **It buys nothing against the risk that prompted the question.** Both scopes give the app access to
exactly zero of a researcher's other files. `drive.file` reaches only files this app created;
`drive.appdata` reaches only files this app created inside a hidden folder. For *"a hole in our suite
must not reach their wider Drive"*, the protection is already total, and it is enforced at Google
rather than by our code. The difference between the two scopes is not containment at all — it is who
ELSE can see the FlexText files. Which is a custody question, and the answer there runs the other way:

- **Application-data files cannot be shared with anyone, ever.** Permissions cannot be set on them.
  That makes the next two items on the roadmap — an owner inviting a guest researcher to a project,
  and transferring devices or ownership between researchers — not difficult but structurally
  impossible.
- **Existing estates cannot be moved there.** `appDataFolder` and `drive` are separate spaces, and
  files are not re-parented across them. Migrating live accounts would mean downloading every text
  and recording and re-uploading it, leaving the originals behind: a bulk migration over real field
  data, bought with no reduction in reach.
- **The archival story inverts, and this is the one that matters most.** Today a researcher's texts
  are their own visible files: they open in FLEx and ELAN, they can be handed to a colleague or an
  archive, and they outlive this software. In the app-data folder they are invisible, retrievable
  only through our own panel, and effectively unrecoverable if this project ever stops running. For
  a suite holding the language, voices and consent records of indigenous communities, durable
  custody by the community's own researcher is a protection, not a convenience — and appdata trades
  it away for a security improvement of zero.

**The one genuine difference, and what was done about it.** Under `drive.file`, a file the USER
selects in a Google Picker becomes reachable by the app. That is the only route by which this suite
could ever hold a handle on something it did not create, and `drive.appdata` has no equivalent. It
cannot open by accident — someone has to add the Picker — so it is pinned by assertion instead:
`test/google-only-auth.test.mjs` fails if `google.picker`, `apis.google.com` or `gapi.` appears in
client code. That single line buys the whole appdata guarantee while keeping visible, shareable,
archivable files. If a future feature genuinely needs a file the researcher already owns, that is the
moment to re-open this deliberately.

⚠ **A widening would also cost far more than the code change suggests.** `drive.file` is not a
restricted scope. Moving to `drive` or `drive.readonly` would pull the project into Google's
restricted-scope regime — annual third-party security assessment and its costs, on a project that has
none — quite apart from handing every researcher's whole Drive to any hole in our worker. The
compliance burden and the security argument point the same way, which is a pleasant thing to be able
to say about a rule.

## The risk that is actually left over

`drive.file` bounds the blast radius to *the FlexText estate*. Inside that bound, the concentration
of risk is one thing:

**The worker holds a long-lived Drive refresh token for every researcher** (`researcher.drive_refresh_enc`,
encrypted at rest under `SERVER_HMAC_KEY`), because field devices upload through the worker while the
researcher is offline. That is the design that makes no-login field sync possible, and it means a
sufficiently deep compromise of the worker reaches **every researcher's FlexText texts and
recordings** — not their wider Drive, but everything this suite has ever put in it.

⚠ **And inside that bound the reach is TOTAL, not partial — do not let the narrow scope suggest
otherwise.** It was reasoned, plausibly, that the worker never lists or queries Drive, so a
compromised one could create files but would have to GUESS file ids to touch anything existing. The
code says otherwise, and the correction matters because it is the difference between a small residual
and a complete one:

- `driveListAll` (v1.js) is an **unqualified listing** — `q=trashed=false`, no folder constraint,
  paged to 20,000 files, returning `id`, `name`, `size`, `parents` and `appProperties`. It is `ls -R`
  over everything the token can see, and `/drive-estate` calls it on a ~12-second panel poll.
- Around fifteen further searches resolve folders by `appProperties` tag or by `'<id>' in parents`.
- Every mutating verb is already implemented and reachable: `driveReparent` (PATCH
  addParents/removeParents), `DELETE` by file id, and content reads via `?alt=media` in five places.

So nothing has to be guessed: one call enumerates the estate with ids, and moving, deleting and
downloading are already built. The Drive contents are plaintext by necessity — they have to open in
FLEx and ELAN — so the E2EE that protects D1 metadata does not protect them.

⚠ **The reassuring half of the same correction: knowing a file id buys nothing outside the grant
set.** `drive.file` is grant-based, not id-based. A guessed id, an id leaked from elsewhere, an id
from a shared link — `files.get`, PATCH and DELETE against any of them fail. There is no
"if they could discover the ids" pathway into a researcher's other files, which is exactly why the
outer boundary is worth relying on: it is not obscurity, and it does not weaken as ids become known.

Being precise about this matters. The protections here exist to honour the privacy and research-ethics
obligations the suite carries to the communities whose language, voices and consent records it holds,
and the honest statement of the residual is part of that: the scope makes the *outer* boundary
strong, and the token store is where the *inner* one lives.

Two facts about the token store worth having written down before an incident rather than during one:

- **Google refresh tokens for a published app do not expire on their own.** A leaked one stays
  useful until it is revoked.
- **The researcher can revoke everything themselves, instantly**, at Google Account → Security →
  Your connections to third-party apps. That kills every token this suite holds for them in one
  action, without us doing anything. It is the fastest containment step available and it belongs in
  the incident runbook.

## Options worth considering later, roughly in order of value for effort

1. **Isolate the token store from the metadata store.** ⚠ Ranked first because of the paragraph
   above: the reach inside the bound is total, so the token IS the boundary that is left. Refresh tokens sit in the same D1 row as
   everything else, so any read primitive that reaches researcher rows reaches tokens. Moving them
   behind a separate binding with its own key narrows what a single query bug yields. Cheap, additive,
   no client change — the best ratio on this list.
2. **Alert on anomalous Drive activity.** `secLog`/`secAlert` already exist and already carry the
   sign-in notice. A researcher whose token is being used from somewhere they are not is exactly the
   sort of thing that notice model handles well.
3. **Shorten what the worker needs to hold.** Nothing except *unattended device uploads* actually
   requires a refresh token; researcher-initiated work could run on a short-lived access token
   obtained while they are present. This does not remove the store — the field case is the whole
   product — but it could reduce how often the long-lived credential is loaded and used.
4. **Client-held tokens for researcher-initiated Drive work.** The strongest version, and the one to
   be most sceptical of: it cannot cover device uploads (the researcher is asleep and the device is in
   a village), so it would split Drive access into two code paths with two failure modes. Per the
   suite's own design principle, that is a duplication to justify carefully, not a default.

⚠ **What is NOT on this list, deliberately: widening the scope for convenience.** If a future feature
seems to need `drive` — importing a file the researcher already has, say — the answer is the Google
Picker, which grants us that one file under the scope we already hold. Reach for the picker, never
the scope.

## The guard

`test/google-only-auth.test.mjs` asserts that the only Drive scope named in the worker is
`drive.file`. It is deliberately literal: it will fail on `drive.readonly`, on `drive.metadata`, and
on bare `auth/drive`, including inside a comment, because a scope that appears in a comment today is
a scope someone pastes into the request tomorrow.


## Deleting a researcher account does not revoke the Google grant (Seth, 2026-08-20)

> *"deleting a researcher account does not delete Google OAuth access granted to our app via that
> account. That's worth thinking about, though I don't really know if we need to take any action or
> what action to take, and neither is particularly high or immediate priority."*

**Confirmed in the code.** Neither deletion path calls Google's revocation endpoint:

- `POST /v1/researcher/delete` (self-delete) runs one atomic D1 batch and returns. The grant is
  untouched.
- The owner's **decline** of a pending account (`DELETE FROM researcher … AND approved=0`) does the
  same, and this one is worth calling out separately because it is the path most likely to be used
  on an account created by someone who should not have had one.

### How much this actually exposes, stated honestly

**Less than it sounds, but not nothing, and the reasons are worth separating.**

Deleting the row destroys `drive_refresh_enc` — our only copy of the token — so after the delete the
worker cannot use the grant even though the grant is still live. The refresh token is never logged
(checked: it appears only as ciphertext in D1 and as an in-memory value on the token-exchange path).
So there is no live capability sitting around afterwards.

Two things keep it from being purely cosmetic:

1. ⚠ **D1 point-in-time recovery undoes the deletion.** A restore brings the encrypted refresh token
   back, and the grant it refers to is still valid because nobody ever told Google otherwise. That
   turns "we no longer hold the token" into "we no longer hold the token unless the database is
   rolled back", which is a materially weaker sentence.
2. **It quietly contradicts what deletion appears to mean.** A researcher who deletes their account
   and then looks at Google Account → Security → third-party access still sees this app listed with
   Drive permission. For a suite whose entire premise is that the researcher owns their own data and
   can withdraw at will, an account deletion that visibly leaves access behind reads as a deletion
   that did not work — and the person best placed to notice is exactly the person who cared enough
   to delete.

### The action, if and when it is taken

Small and additive: before the delete batch, POST the refresh token to
`https://oauth2.googleapis.com/revoke`. Revoking a refresh token revokes the whole grant, including
every access token derived from it, which is precisely the intent.

Three constraints that matter more than the call itself:

- **Revoke BEFORE the delete**, since the delete destroys the token the revoke needs.
- ⚠ **A failed revoke must never block the deletion.** The user asked for their account to be
  removed; a Google outage is not a reason to refuse. Attempt it, catch, and delete regardless.
- ⚠ **But do not fire-and-forget it either.** A silent failure recreates exactly the situation this
  section describes, while looking solved. Log the outcome (`oauth_revoke_failed`) so a grant left
  standing is visible rather than assumed away.

Apply it to both paths — self-delete and owner-decline — and to any future "disconnect Drive" action.
The researcher's FILES are correctly untouched by all of this: they are the researcher's own
property, and deleting them is not what account deletion means.

**Priority: low, as Seth put it.** It belongs behind the token-store isolation above, which addresses
a live capability rather than a dormant one.

### The related question: does APPROVAL survive a deletion too?

> Seth, 2026-08-20: *"do we want an account to be automatically approved a second time? Probably
> that's no problem, but it's a problem worth asking."*

Worth asking, and the code gives a split answer — the individual half is already safe, the domain
half is not, and it is the domain half that deserves the note.

**Individual approval does NOT survive.** Approving a researcher runs exactly one statement,
`UPDATE researcher SET approved=1 WHERE researcher_id=?`. It writes nothing to `approved_domain` and
nothing outside that row, so deleting the account destroys the approval with it. Someone approved by
hand, then deleted, comes back **pending** on their next sign-in and needs approving again. That is
the behaviour one would want, and it is already what happens.

⚠ **Domain pre-approval does survive, and that makes account deletion NOT a way to remove someone.**
`isDomainApproved` checks the hashed domain against `approved_domain` on every sign-in. A researcher
whose organisation's domain is on that list is auto-approved *every time they sign in*, including
immediately after their account is deleted. Delete them and they simply reappear, approved, the next
time they open the panel — and nothing on screen says why.

That is the version of this worth acting on eventually, because it is a **mismatch between what
deletion looks like and what it does**. The removal action for a domain-approved person is to take
the domain off the list (or to have not approved by domain for that organisation); deleting the
account is not it, and someone will one day expect it to be. The same is true a step further out for
`ALLOWED_RESEARCHERS`: an env-listed owner is re-approved as an OWNER on sign-in, by design, and no
database action can change that — which is the correct arrangement (no row can grant owner rights),
but is another case where deletion is not removal.

**If this is ever fixed, the shape is probably a panel that says so** rather than new mechanism: when
an owner deletes or declines an account whose domain is pre-approved, tell them plainly that this
person will be re-approved on their next sign-in and offer the domain list as the place to act. A
warning at the moment of the wrong expectation is worth more than a policy change, and it cannot
drift out of step with the approval rules the way a duplicated check would.

⚠ Do NOT "fix" this by suppressing auto-approval for previously-deleted addresses. That would mean
keeping a record of deleted people in order to refuse them — retaining personal data as a side effect
of erasing it, which is the wrong trade for this suite whatever it buys.
