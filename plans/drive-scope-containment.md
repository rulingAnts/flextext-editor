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

There is no narrower scope that would work. `drive.appdata` is tighter still, but it writes to a
hidden application-data folder the user cannot see or share — and the entire point of this suite is
that a researcher's texts and recordings are **their own visible files in their own Drive**, shareable
with FLEx, with ELAN, with a colleague. Trading that away for a scope reduction would break the data
custody model, which is the more important protection.

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

1. **Isolate the token store from the metadata store.** Refresh tokens sit in the same D1 row as
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
