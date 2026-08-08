# `plans/` — design documents, tracked in git, never published

Seth, 2026-08-07: *"Maybe we can make a plans/ folder and exempt it, and make sure that nothing goes
in there that's secret. If the code is open source anyway, plans for features, etc won't increase
security risk at all. But it would be good to keep them in a specific place though."*

## Why this folder exists, and why it is the exception

`.gitignore` excludes AI/dev-facing Markdown by default, for a reason recorded there:

> *"md files meant for AI models' use during development shouldn't be tracked, **unless they're
> specifically meant for public use by others cloning the repository**." … one of them
> (`worker/docs/approved-domains.md`) once leaked the operator's whole partner list into a public
> repo.*

`plans/` is the "unless" clause. These are design documents an adopter — SIL LSDev, Payap, anyone
forking this — would genuinely want: why the architecture is the way it is, what was considered and
rejected, and what the traps are. They belong in the repository.

## ⚠ NOT under `docs/`, and that is deliberate

**`docs/` IS THE WEBSITE.** GitHub Pages serves `productionWeb:/docs`, so a Markdown file there is
published at a public URL. Three of these documents lived in `docs/` for a few hours and were
served. `plans/` is tracked in git but never served — the right place for something meant to be
*readable by anyone who clones the repo* rather than *fetchable by anyone who guesses a URL*.

## What may go in here

Design notes, feature plans, architecture decisions, backlog items, post-mortems, the reasoning
behind a rule.

## ⚠ What may NOT — the list exists because one of these already happened

- **Partner, customer, or contact lists** — the leak that created the default-ignore rule.
- **Credentials of any kind**: tokens, secrets, `RELAY_SECRET`, `.dev.vars` contents, Turnstile
  keys, D1 connection details, worker IDs that function as secrets.
- **Personal data**: real speaker names, consent receipts, IP or location captures, real recordings,
  anything from `samples/`.
- **Private URLs** — internal hostnames, unpublished preview aliases tied to an account, admin
  endpoints.
- **An unfixed security vulnerability described in operational detail.** The engine is AGPL and the
  source is public, so a *design* discussion of a weakness is fair — but a document that amounts to
  a working exploit for something still live in production does not belong in a public repo while it
  is still live. Fix first, then write it up.

The test before adding a file: **would you be comfortable if a stranger read this the day it
landed?** If the answer depends on nobody finding the repo, it goes in `notes/` instead.

## What is in here now

| file | status |
|---|---|
| `BACKLOG.md` | living list of parked work, decisions taken, and diagnosed-but-unfixed bugs |
| `localization-overlay-plan.md` | in-app translation editing via a D1 overlay — **plan only** |
| `segment-split-join-plan.md` | guided split/join in the **Paragraph Analysis Tool** — plan only |
| `fxed-fxpa-formats-plan.md` | how the `.fxed` decision was reached, and why the alternatives lost |
| `fxed-format-spec.md` | **the `.fxed` spec** — container, manifest, what must not travel — plan only |

⚠ `notes/` stays gitignored and is still the right home for working scratch, task briefs, and
anything with a real name or a real recording in it.
