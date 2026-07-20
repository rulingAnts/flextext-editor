# ⚠ This repository is GENERATED — do not edit it here

Every file in this repo is published automatically from:

### `rulingAnts/flextext-editor` → `satellites/__SATELLITE__/`

Anything committed directly here is **overwritten** on the next publish. Make the change in
`flextext-editor` instead, then deploy from there.

## Why this repo exists at all

GitHub Pages serves a project site at `/<repo-name>/`, and this app needs a path **disjoint** from
`/flextext-editor/` — two PWAs sharing a scope are treated by the browser as a single installed
app. So the repo must exist to *serve*; it is not where the source lives.

## How it gets published

The `Publish satellites` workflow in `flextext-editor` mirrors the source here, but only after it
has (1) waited until the live editor actually serves the matching engine version, and (2) verified
every engine file this app precaches returns 200. Publishing ahead of the engine would make this
app's service-worker install fail — costing new installs their offline support.
