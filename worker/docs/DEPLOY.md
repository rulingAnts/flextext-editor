# Deploy & operate flextext-r2-worker — no local wrangler, no VM

Everything runs from **GitHub Actions** (Linux runners) + the **Cloudflare dashboard**. You do
**not** need wrangler installed locally and you do **not** need the KDE-neon VM. Edit on the Mac →
`git push` → click a workflow.

## One-time setup (done)
Repo secrets — Settings → Secrets and variables → Actions:
- `CLOUDFLARE_API_TOKEN` — a custom token scoped to this account: **Workers Scripts: Edit** + **D1: Edit**
  (narrower than a full `wrangler login`).
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare dashboard → Workers & Pages → right sidebar.

## Every wrangler / Cloudflare task → where it runs
| Task | Where |
|---|---|
| Deploy the worker | **Actions → "Deploy worker"** → Run workflow |
| Run a D1 migration file | **Actions → "D1 migrate"** → type the `.sql` filename. ⚠ `--remote` is LIVE; run each file **once**. |
| Any other wrangler command (D1 query, `versions list`, `rollback`, `deployments list`, …) | **Actions → "wrangler (one-off command)"** → type the args |
| Ad-hoc D1 query | the one-off runner above, **or** Dashboard → D1 → `flextext-connectivity` → **Console** (easiest for SQL with quotes) |
| Set / edit a secret | **Dashboard → the Worker → Settings → Variables and Secrets** (not a workflow — a workflow input would print the value into the run log) |
| Live logs (`wrangler tail`) | **Dashboard → the Worker → Logs** (real-time) |
| Roll back a bad deploy | re-run **Deploy worker** from an earlier commit: `gh workflow run deploy.yml --ref <commit> -R rulingAnts/flextext-r2-worker`  (or `rollback` via the one-off runner) |

The three workflows live in [`.github/workflows/`](../.github/workflows): `deploy.yml`,
`d1-migrate.yml`, `wrangler.yml`. All are **manual** (`workflow_dispatch`) — nothing deploys on
push, so your sign-off is preserved.

## Deploy order (when a change spans repos)
Backend first, clients second (see the editor repo's `docs/RELEASE-RUNBOOK.md`):
1. **This worker** — migrate D1 (if the schema changed) → Deploy worker.
2. **Editor** `productionWeb` (the client).
3. **Recorder** + **researcher app** SW bumps.

`workers_dev = true` in `wrangler.toml` keeps the `…workers.dev` URL live **alongside**
`connect.flextext.app`, so already-deployed field clients never break mid-release.

## Developing locally — keep it all under Covenant Eyes + Cold Turkey
The goal isn't "no VM" — it's "no dev environment that lacks the accountability filters." GitHub
Actions is fine (a locked-down CI runner that executes the workflow and exits — not a box you can
sit and browse from). `wrangler dev`'s local runtime needs Linux/workerd or Windows and won't run
on this Mac, but you rarely need it:
- **Client / UI / engine work (the 90%):** the editor's Mac static dev server (`dev-serve.sh` —
  bash + python, *not* wrangler). No worker required, all on the filtered Mac.
- **Worker changes (rare — the backend is built):** deploy + test against the live worker; or set up
  a **staging worker** (`[env.staging]` in `wrangler.toml` + a "Deploy staging" workflow) and test
  its URL from the filtered Mac browser; or run `wrangler dev` on a **Windows VM that has Covenant
  Eyes + Cold Turkey** (modern wrangler runs `wrangler dev` natively on Windows — no WSL needed).
- **Do NOT** use a GitHub Codespace or a fresh/unfiltered Linux VM for this — that reintroduces the
  exact unaccountable environment this setup is meant to remove.

## Secrets this worker uses (set them in the dashboard)
`TURNSTILE_SECRET`, `SERVER_HMAC_KEY`, `ESCROW_PUBLIC_KEY`, `ESCROW_PRIVATE_KEY`, `RESEND_API_KEY`,
`RELAY_SECRET`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `ALLOWED_RESEARCHERS`.
(`.dev.vars` / `.dev.vars.example` only matter for a local `wrangler dev` path.)

## ⚠ "remote = live"
`d1 execute --remote` and `deploy` act on the **live** database / worker. There is no staging
unless you add one. Confirm `grep '^name' wrangler.toml` (→ `flextext-r2-worker`) and the D1 name
(`flextext-connectivity`) before any destructive D1 statement.
