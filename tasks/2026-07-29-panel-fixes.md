# Task: delete-strikethrough bug + placeholder leak + collapsible device cards

Three items for the **researcher panel**. Do them in this order — item 1 is a possible live bug,
item 2 is a small information leak, item 3 is UI polish.

---

## FIRST — read these, they are not optional

- **`CLAUDE.md` in the repo root.** It carries the branch model, the deploy-order rules, and two
  outages that came from ignoring them. Read it before touching anything.
- **Branches.** `main` = development. `productionWeb` = the LIVE site field translators load.
  `segmentation` = parked experimental work; **do not touch it, and never merge it** (it was removed
  from `main` by revert `1ef6df2`, so a merge silently reinstates nothing).
- **⚠ DO NOT PUSH `productionWeb`.** Land everything on `main` and stop. Releasing to production
  requires the maintainer's explicit test-drive sign-off, every time, no exceptions. A local
  `.git/hooks/pre-push` blocks it; **do not set `ALLOW_MAIN_PUSH=1` to get around that.**
- **Do not deploy the Cloudflare Worker** and do not run the D1 migration Actions. None of these
  three items needs the server.
- **Do not add or change anything under `.github/workflows/`** (billing guardrail).

### Version bumping — all four files or none

If you change ANY file under `docs/`, bump all of these together, each by one:

| file | constant |
|---|---|
| `docs/sw.js` | `VERSION` |
| `docs/js/i18n.js` | `ENGINE_VERSION` (must EQUAL `sw.js`'s `VERSION`) |
| `satellites/flextext-researcher/sw.js` | `VERSION` |
| `satellites/text-recorder/sw.js` | `VERSION` |

Current live is **v131** (researcher sw v69, recorder sw v79), so you are producing **v132**.
`test/version-sync.test.mjs` enforces this — run it.

**If you add a NEW top-level module under `docs/js/`,** it must also be added to the `SHELL` array in
all three service workers. ⚠ The editor uses RELATIVE paths (`'js/foo.js'`) and the satellites use
ABSOLUTE (`'/flextext-editor/js/foo.js'`) — one shared sed anchor matches neither everywhere. Insert
separately and verify all three. Precaching a path that does not exist makes `precacheAll()` throw
inside the service worker's `install`, so **new installs get no offline shell at all**. That is a
real outage this project has already had.

### Run the tests

```sh
./check-native-containment.sh     # containment checks + every test/*.test.mjs
```

All suites must pass before you commit. Add tests for what you change.

### Verifying in a browser

Serve the site and load it. **Use a port you have not used before in the session** — stale
HTTP/ES-module cache on a reused localhost origin produced two convincing false alarms during the
last session (a function appearing "missing" that was present on disk and served correctly).

```sh
python3 -m http.server 8090 --directory docs
```

The researcher panel needs a signed-in account, which you will not have. Verify by importing the
modules and asserting on the source and on pure functions, not by trying to log in.

---

## ITEM 1 — "Upload and remove" strikethrough bounces back to un-struck

### The report

The maintainer clicks **Remove from device**; the row strikes through, then reverts to normal while
the text is still on the device. He does not yet know whether the device ever performed the delete
("likely they haven't logged in yet").

### What was already done, and why this may NOT be a bug

This is the exact symptom **v131** was written to fix. Before v131 the strikethrough came from a
marker that expired on a 10-minute TIMER, so a request the device had not yet polled for became
indistinguishable from one never made.

v131 replaced that with state derived from `install.ack_seq`:

- `seq > max(ack_seq)` → queued, device has not seen it → **strikethrough stays**, button offers cancel
- `seq <= max(ack_seq)` → device has it → "in progress", not cancellable

The marker is persisted in `localStorage` and retired **only** on a real outcome.

The maintainer's browser failed to pick up a new service worker promptly **three times** in the
previous session. So the single most likely explanation is that he tested on v130. **Establish which
it is before changing any code.**

### How to investigate — in this order

1. **Confirm what is deployed.** Fetch the live panel and check the v131 logic is actually there:
   ```sh
   curl -s "https://rulingants.github.io/flextext-editor/js/researcher-panel.js?cb=$RANDOM" \
     | grep -c "p.seq > maxAck"          # expect 1
   ```
   Also confirm no surviving timer logic: `requestedUploads`, `requestedDeletes`, `UPLOAD_WAIT_MS`
   should all be **absent**.

2. **Check the prime suspect: an undefined `seq`.** The whole mechanism depends on the Worker
   returning the command's `seq` and the client keeping it. If `seq` is `undefined`, then
   `undefined > maxAck` is `false`, the row is treated as already-taken, and it will not behave as
   intended. Verify the chain end to end:
   - `worker/src/v1.js`, the `POST .../command` handler — does its JSON response include `seq`?
   - `docs/js/researcher.js` → `pushCommand()` — does it return `{ ok, seq, desired_rev }`?
   - `docs/js/researcher-panel.js` → the `del-text` branch — does it store that `seq` into
     `pendingCmds` and call `savePending()`?

3. **Check marker persistence across a re-render.** `renderDashboard()` calls `loadPending()` on
   every render, which overwrites the in-memory map from `localStorage`. So any code path that sets
   a marker **must** call `savePending()` before the next render, or the marker is lost on the next
   12-second poll — which would look exactly like "bounces back". Audit every `pendingCmds.set(...)`
   for a matching `savePending(...)`.

4. **Check the retirement condition.** In `renderDashboard`, a delete marker is retired when the doc
   is absent from every inventory AND `ackOf(...) >= p.seq`. Confirm `ackOf()` reads `ins.ack_seq`
   under the field name `listView()` actually returns (`docs/js/researcher.js` → `listView`), and
   that comparing a possibly-string `ack_seq` against a number cannot go wrong.

5. **Write a regression test** for whichever failure you find, driving the pure logic with
   synthetic inventory + ack values. If the bug is in `pendingCmds` handling, extract the decision
   into a small pure function so it can be tested without the DOM.

### ⚠ If the code turns out to be correct

**Say so and stop. Do not "fix" working code.** Report what you verified, and state plainly that the
most likely cause is a stale service worker on the maintainer's device. Include the exact console
snippet he can run to confirm, e.g. reporting the stored `pendingCmds` entry, its `seq`, and the
instance's `max(ack_seq)` from a fresh `listView()`.

A previous session wasted significant effort inventing explanations for a bug that did not exist.
Measure first.

---

## ITEM 2 — Remove the real organisation name from the Admin UI placeholders

### Why this matters

This repository is **public and mirrorable**. The Admin modal's "add domain" form uses a real
partner organisation as its placeholder text, which discloses who the maintainer works with. He
asked for it removed: *"That could give away info we don't want nefarious users to get, since our
app is open source and they could mirror it and see that."*

### What to change

In `docs/js/i18n.js`, both the **en** and **id** blocks:

- `panel.admin.addDomainPh` — currently a real partner domain → use a neutral shape hint such as `example.org`
- `panel.admin.addNotePh` — currently a real partner name → use a generic label (e.g. "Which organisation
  this is", localised)

The placeholder still has to teach the expected FORM (a bare domain, no `@`, no protocol), so do not
just blank it.

### Then sweep for others

Grep the whole repo for other real organisation names, e-mail addresses and domains left in sample
data, comments, fixtures or test files — anything that would tell a reader who this deployment
serves. Report what you find; remove what is genuinely a leak. Be careful to distinguish:

- **Leaks** — real partner orgs and addresses used as UI examples or committed sample data.
- **Legitimate** — the project's own domains (`flextext.app`, `rulingants.github.io`), and the
  `PUBLIC_EMAIL_DOMAINS` blocklist in `worker/src/v1.js`, which necessarily names public providers
  such as `gmail.com` and must NOT be touched.

Do not change any test that asserts on the blocklist.

---

## ITEM 3 — Make the device cards collapsible

The dashboard cards are busy. Each device card (`renderInstanceCard` in
`docs/js/researcher-panel.js`, rendered as `.rp-card.rp-inst`) should collapse to a compact summary
and expand on click.

Requirements:

- **Collapsed** shows enough to be useful without expanding: nickname, the app-type badge, the
  status badge, and the text count. Keep any warning state visible when collapsed — a pending
  install, a `wipe_state`, or a stale-engine badge must NOT be hidden behind a collapse, or the
  collapse conceals exactly what needs attention.
- **Expanded** is the current content, unchanged.
- **Remember state per instance** across renders and reloads (`localStorage`, keyed per researcher
  account — follow the pattern already used by `PENDING_KEY` / `loadPending` in the same file).
- **Default:** collapsed when there is more than one device, expanded when there is only one.
- Accessible: a real `<button>` toggle with `aria-expanded`, keyboard operable.
- ⚠ The dashboard re-renders on a 12-second poll. The collapsed state must survive that without
  flicker — read it during render, do not animate from scratch each time.
- New user-facing strings go in **both** `en` and `id` in `docs/js/i18n.js`.

---

## Finishing up

1. `./check-native-containment.sh` — all suites green.
2. Version bumps in all four files; `test/version-sync.test.mjs` passes.
3. Commit to `main` with a message that explains **why**, not just what. If item 1 turned out not to
   be a bug, say that explicitly in the commit or the summary.
4. **Push `main` only.** Leave `productionWeb` alone.
5. In your final report state, separately: what you changed, what you verified and how, and anything
   you could not confirm. If you could not reproduce item 1, say so plainly rather than shipping a
   speculative fix.
