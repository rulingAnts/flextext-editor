#!/usr/bin/env bash
# worker-daemon.sh — manage the FlexText connectivity dev worker (`wrangler dev` on
# :8787) as a systemd --user service on THIS VM. Installed + driven by the Mac's
# devctl.sh over SSH. With user lingering enabled, the service survives SSH logout AND
# reboot, and systemd restarts wrangler if it dies (Restart=always). Stopped by default
# (disabled until `start`). Logs: `journalctl --user -u flextext-worker -f`.
set -uo pipefail
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
UNIT="flextext-worker"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT.service"
PORT=8787
WRANGLER="$(command -v wrangler || echo /usr/local/bin/wrangler)"

install_unit() {
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=FlexText connectivity dev worker (wrangler dev on :$PORT)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/flextext-r2-worker
ExecStart=$WRANGLER dev --port $PORT
Restart=always
RestartSec=2
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
}

port_up() { ss -ltn 2>/dev/null | grep -q ":$PORT[[:space:]]"; }

case "${1:-}" in
  start)
    loginctl enable-linger "$USER" >/dev/null 2>&1 || true   # survive logout + reboot
    install_unit
    systemctl --user enable --now "$UNIT" >/dev/null 2>&1
    for i in $(seq 1 35); do port_up && break; sleep 0.4; done
    if port_up; then echo "started ($(systemctl --user is-active "$UNIT"))"
    else echo "started but :$PORT not up yet ($(systemctl --user is-active "$UNIT")) — see: journalctl --user -u $UNIT"; fi
    ;;
  stop)
    systemctl --user disable --now "$UNIT" >/dev/null 2>&1
    echo "stopped"
    ;;
  status)
    act="$(systemctl --user is-active "$UNIT" 2>/dev/null || true)"
    echo "${act:-inactive}$(port_up && echo ", :$PORT up" || echo ", :$PORT down")"
    ;;
  *) echo "usage: worker-daemon.sh {start|stop|status}"; exit 2 ;;
esac
