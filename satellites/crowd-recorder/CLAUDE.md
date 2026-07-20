# FlexText Crowd Recorder — repo guide for Claude / LLMs

This repo ships the **PUBLIC crowd recorder** (<https://rulingants.github.io/crowd-recorder/>):
a one-page recorder that **anonymous members of the public** open from a shared
link (or inside an `<iframe>` via `embed.js`) to record a story and submit it to a
researcher — no account, no install, nothing to learn. It is a **thin companion**
to the **Flextext Editor**, which is the **main project** — a separate,
independent Git repo at `rulingAnts/flextext-editor` (local:
`/Users/Seth/GIT/flextext editor/`).

## The one thing to understand: this is a SHELL, not a fork

`index.html` here is a thin shell. It loads the **editor's engine** cross-path
over the same GitHub Pages origin — `/flextext-editor/js/app.js` +
`/flextext-editor/css/app.css` — and sets `window.__MODE='crowd'` so that shared
engine renders the crowd UI (welcome → consent → record → submit).

**⇒ All recording / consent / storage / submit logic lives in the EDITOR repo,
not here.** To change behavior, edit the editor repo's `js/`. Do **not** copy
engine code into this repo. This repo holds ONLY:

- `index.html` — the shell (sets `window.__MODE='crowd'`)
- `embed.js` — the one-tag **script** embed snippet for third-party sites (injects
  and auto-sizes the iframe itself — see "Embedding" below)
- `icons/` — the favicon (green sibling of the Text Recorder icon)

### ⚠ Consent modal markup — KEEP IN SYNC across three shells
`index.html` here carries the consent modal markup (recorded-response → typed
signature → yes/no **radio** choices, one submit) **stamped identically** into the
editor's and the text-recorder's `index.html` as well. The shared engine only
wires behavior onto that markup — change one copy, change all three.

## Deliberately NOT a PWA — no manifest, no service worker, no offline

Unlike the sibling `text-recorder`, this app must **never install or cache**:

- Its users are **anonymous strangers** visiting once from a link — an install
  prompt is noise, and a home-screen icon they'll never tap again is litter.
- **No `sw.js` means no stale-cache problem.** Every visit loads whatever editor
  engine is live *right now*, so there is **no VERSION coupling** to manage here
  (contrast `text-recorder/sw.js`, which precaches the engine by path and must be
  bumped on every engine change). The page is always-fresh by design.
- No manifest and no apple-touch/apple-mobile meta, so the browser never treats
  it as installable — keep it that way. A `<meta name="robots" content="noindex">`
  keeps it public-but-unsearchable.

The one durability the page DOES need — not losing a recording if the submit
fails mid-flight — is handled by the **engine**, not by any caching here: unsent
takes persist in this page's **own IndexedDB (`flextext-crowd`)** until the
Worker **confirms Drive delivery**, and retry silently when the visitor returns
(the code for that store lives in the editor repo).

## Architecture / where things live

- Recorder configs (welcome text, consent text, on/off state) live in **D1**,
  served by the **flextext-r2-worker** Cloudflare Worker
  (`/Users/Seth/GIT/flextext-r2-worker/`); the page fetches its config by the
  `?c=<id>` query param.
- Submissions POST to the Worker, which delivers to the researcher's Google
  Drive. Design + privacy/abuse model: the editor repo's
  `docs/crowd-recorder.md`.
- `embed.js` injects `https://rulingants.github.io/crowd-recorder/?c=<id>&embed=1`
  as an iframe with `allow="microphone; autoplay"`. The host page must permit
  microphone delegation or recording is dead inside the frame — guidance for
  site builders is in `docs/crowd-recorder.md` too.

## ⚠ DEPLOY ORDER — editor first, always

GitHub Pages serves this repo's root at <https://rulingants.github.io/crowd-recorder/>.
When a change spans repos:

1. Deploy the Worker/D1 first if the backend changed (see the editor repo's
   `docs/RELEASE-RUNBOOK.md`).
2. Deploy the **editor's `productionWeb`**; confirm `/flextext-editor/` is live.
3. **Then** push this repo — **LAST**. It precaches nothing, but it renders with
   whatever engine is live, so shipping a shell that expects `CROWD_MODE` before
   the live engine has it shows visitors a blank `#view-record`.

## Branches / deploy

Single `main` branch, deployed straight to Pages (root) — no dev/prod split like
the editor, so this repo is effectively always "production." Test engine changes
on the **editor** repo's dev rig first (`dev-serve.sh` serves this repo at
`/crowd-recorder/` alongside the editor); this shell itself rarely changes. Per
the editor's release rule, do not push without the maintainer's OK.

---

## ⚠️ GitHub costs — ask before anything billable (firm policy, 2026-07-07)

**Claude: never trigger anything that can incur GitHub charges without Seth's explicit
approval AND a stated cost estimate first.**

- FREE, always: Actions on **public** repos with **standard** GitHub-hosted runners;
  self-hosted runners; GitHub Pages.
- METERED (free monthly quota, then paid): Actions in **private** repos (2,000 min/mo;
  **Windows counts 2×, macOS 10×**); Codespaces; Packages; Git LFS.
- **ALWAYS billable, even on public repos: larger / GPU runners** (anything beyond the
  standard `ubuntu-latest` / `windows-latest` / `macos-latest` tiers).
- Safety valve: with **no payment method on file, GitHub blocks usage at the quota and
  cannot bill** — keep it that way, or set stop-usage budgets.

So WITHOUT Seth's explicit OK (and cost), do **not**: add or change `.github/workflows/**`;
use a non-standard `runs-on:`; add a `schedule:` (cron) trigger; create Codespaces; use
Git LFS; publish private Packages; or change the plan / budgets. The local
`.git/hooks/pre-push` blocks workflow pushes (override `ALLOW_WORKFLOW_PUSH=1`) and
production-branch pushes (`ALLOW_MAIN_PUSH=1`) — set those flags only after Seth approves
that specific push.
