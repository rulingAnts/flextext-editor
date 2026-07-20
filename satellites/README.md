# satellites/ — THIS IS THE SOURCE. Edit here.

**You are in the right place.** These folders are the source of truth for the three sibling apps.
Change them here, in `flextext-editor`, and let CI publish them.

| Folder | Publishes to | Live at |
|---|---|---|
| `text-recorder/` | `rulingAnts/text-recorder` | `/text-recorder/` |
| `flextext-researcher/` | `rulingAnts/flextext-researcher` | `/flextext-researcher/` |
| `crowd-recorder/` | `rulingAnts/crowd-recorder` | `/crowd-recorder/` |

The published repos are **generated mirrors**. They carry a `DO-NOT-EDIT-HERE.md` that points back
here — that file is written by the workflow at publish time and deliberately does **not** exist in
this directory, because here it would be pointing at itself and telling you not to edit the very
place you are supposed to edit.

## What these apps are

Not forks. Each is a thin shell that loads **this repo's engine** (`docs/js/app.js` +
`docs/css/app.css`) and sets a mode flag. All the real logic lives in `docs/`.

They need their own repos only because GitHub Pages serves a project site at `/<repo-name>/`, and
two PWAs sharing a scope are treated by the browser as **one installed app** — so they must sit at
paths disjoint from `/flextext-editor/`.

## Publishing

Happens automatically when `productionWeb` is pushed, or by hand:

```sh
gh workflow run sync-satellites.yml                        # all three
gh workflow run sync-satellites.yml -f only=text-recorder  # just one
```

## ⚠ The one rule that matters

Each `sw.js` here precaches engine files **by path**. If you change the engine's top-level import
graph in `docs/js/app.js`, you must add the new file to these SHELL lists too — and **bump this
app's `sw.js` `VERSION`** so installed copies re-cache.

The workflow refuses to publish an app whose precached engine files are not live yet, because
publishing early makes `precacheAll()` throw during service-worker install: existing installs stick
on the old worker and new installs get no offline support at all. That is not hypothetical — it
happened on 2026-07-20.
