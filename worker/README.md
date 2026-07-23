> **FOLDED INTO `flextext-editor` (2026-07-23).** This directory is the former private repo
> `rulingAnts/flextext-r2-worker`, now public and AGPL-3.0 like the rest of this repository. It was
> imported as a FRESH SNAPSHOT — the old repo's history was deliberately left behind so nothing that
> may lurk in old commits was published. Its GitHub Actions now live at the repo root as
> `worker-deploy.yml`, `worker-wrangler.yml`, `worker-d1-migrate.yml` (all manual-dispatch; they need
> the `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets in THIS repo's settings). Secrets were
> never in this tree: `wrangler secret put` only. The one token in `.dev.vars.example` is the
> deliberately-public read token already shipped in every client (`DEFAULT_RELAY_TOKEN`, app.js).

# flextext-r2-worker

Cloudflare Worker + D1 + R2 backing the FlexText apps:
- **`/drive`, `/probe`, `/r2/*`** — relay/proxy for Google-Drive + R2 reads (and owner R2 writes). Read access uses the public `?t=<RELAY_SECRET>` token; writes use a separate owner-only `?w=<RELAY_WRITE_SECRET>`. Source: `src/index.js`.
- **`/v1/*`** — the no-login connectivity + researcher layer (email+password+escrow+optional TOTP auth, E2EE sync, instances/installs/invites). Source: `src/v1.js`. D1 = `flextext-connectivity`; R2 = `flextext-back-end`; client base = `DEFAULT_WORKER` in the editor's `js/app.js`.

The client repo is **flextext-editor** (`/Users/Seth/GIT/flextext editor/`). Full
ship sequence lives there in **`docs/RELEASE-RUNBOOK.md`** — read it before deploying.

## ⚠ wrangler discipline (one install drives MANY Workers)
`wrangler` is authed **only on the KDE-neon VM**, and that one install manages
multiple Workers under one Cloudflare account (e.g. `flextext-r2-worker`, `locate`).
It acts on the Worker named in the `wrangler.toml` of the directory it runs from.
**Before any `deploy` / `secret` / `d1`:** `cd ~/flextext-r2-worker` and confirm
`grep '^name' wrangler.toml` → `flextext-r2-worker`. Treat `--remote` D1 as live.

## Deploy
```sh
cd ~/flextext-r2-worker
grep '^name' wrangler.toml     # confirm flextext-r2-worker
wrangler deploy --dry-run
wrangler deploy
```
Prod uses `wrangler.toml [vars]` (`ALLOWED_ORIGINS=https://rulingants.github.io`) +
secrets set via `wrangler secret put` / the dashboard. Required secrets:
`TURNSTILE_SECRET`, `SERVER_HMAC_KEY`, `ESCROW_PUBLIC_KEY`, `ESCROW_PRIVATE_KEY`,
`RESEND_API_KEY`, `RELAY_SECRET`. Keep `DEV_ECHO_RESET` **unset** in prod.

## D1 schema / migrations
`schema.sql` is the full schema, but its `ALTER`s are commented and `CREATE`s are
`IF NOT EXISTS` — **re-running it does NOT migrate an existing DB**. Apply explicit
additive migrations, e.g. the auth redesign:
```sh
wrangler d1 execute flextext-connectivity --remote --file=migrate-auth.sql
```
Migrations must stay additive/nullable so old cached PWA engines never break.

## Local dev
- `dev-worker.sh` — runs `wrangler dev` on the VM and SSH-forwards `:8787` to the Mac (one-shot, foreground).
- `worker-daemon.sh {start|stop|status}` — runs `wrangler dev` as a **systemd `--user` service** (linger on → survives logout/reboot/crash). Driven remotely by the editor's `devctl.sh`.
- `.dev.vars` (gitignored; copy from `.dev.vars.example`) overlays dev-only config for `wrangler dev`: localhost origins in `ALLOWED_ORIGINS`, Turnstile TEST secret, and `RELAY_SECRET` = the client's public `DEFAULT_RELAY_TOKEN` (or `/drive` downloads 401 in dev). `wrangler deploy` ignores `.dev.vars`.

## CORS
Production is locked to `https://rulingants.github.io` (verified: good origin
reflected, other origins get no `Access-Control-Allow-Origin`). `/v1/*` has its own
CORS that allows the `x-fx-*` headers; it's dispatched above the global handler.
