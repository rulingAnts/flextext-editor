#!/usr/bin/env bash
# Bring up the connectivity dev worker so the Mac-served client reaches it at
# http://localhost:8787 — the address the editor's env-switch already targets on
# localhost. wrangler lives on the KDE-neon VM, so this:
#   1. ensures the VM is running + finds its (Parallels host-only) IP,
#   2. starts `wrangler dev` ON THE VM (local D1 + .dev.vars: localhost CORS + Turnstile TEST secret),
#   3. SSH-forwards the VM's :8787 to the Mac's localhost:8787.
# Run this on the Mac, then start your editor dev server (e.g. 8765/8767) as usual;
# the client auto-connects. Ctrl-C stops wrangler dev + the tunnel together.
#
# NOTE: use an HTTP editor dev server for connectivity dev (an HTTPS page can't fetch
# the http://localhost:8787 worker — mixed content). Audio/HTTPS testing is separate.
set -euo pipefail
KEY="$HOME/.ssh/kde_neon_ed25519"
VM="KDE neon"

if ! prlctl list 2>/dev/null | grep -q "$VM"; then
  echo "Starting VM '$VM'..."; prlctl start "$VM" >/dev/null
fi
echo "Finding $VM host-only IP..."
IP=""
for _ in $(seq 1 30); do
  IP=$(prlctl exec "$VM" "hostname -I" 2>/dev/null | tr ' ' '\n' | grep -E '^10\.211\.55\.' | head -1 || true)
  [ -n "$IP" ] && break; sleep 2
done
[ -z "$IP" ] && { echo "ERROR: could not get $VM IP (is it booted?)."; exit 1; }

echo "VM at $IP."
echo "Starting 'wrangler dev' on the VM + forwarding it to Mac localhost:8787."
echo "Leave this running; Ctrl-C stops both. Now start your editor dev server (HTTP)."
exec ssh -t -i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
  -L 8787:localhost:8787 "claude@$IP" \
  'cd ~/flextext-r2-worker && wrangler dev --port 8787'
