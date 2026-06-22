#!/usr/bin/env bash
# devctl.sh — control the FlexText LOCAL dev rig as real daemons.
#
# STOPPED BY DEFAULT: nothing runs until you `./devctl.sh start`. Once started,
# each unit is DETACHED from this shell (reparented to init/launchd) and SELF-HEALING
# (a supervisor restarts it if it dies), so it survives terminal/SSH/Claude sessions
# closing. Stop it explicitly with `./devctl.sh stop`.
#
# Units:
#   editor  — no-cache static server on http://localhost:8012  (dev-serve.sh)        [Mac]
#   tunnel  — SSH -L 8787 → KDE-neon VM, i.e. the connectivity dev worker            [Mac]
#   worker  — `wrangler dev` on the VM (also supervised there)                        [VM via SSH]
#
# Usage:
#   ./devctl.sh start   [editor|tunnel|worker|all]   (default: all)
#   ./devctl.sh stop    [editor|tunnel|worker|all]
#   ./devctl.sh restart [editor|tunnel|worker|all]
#   ./devctl.sh status
#   ./devctl.sh logs    [editor|tunnel|worker]
#
# State (pidfiles + logs) lives in ~/.flextext-dev/.

set -uo pipefail

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
DIR="$HOME/.flextext-dev"; mkdir -p "$DIR"
EDITOR_REPO="$HOME/GIT/flextext editor"
WORKER_REPO="$HOME/GIT/flextext-r2-worker"
PORT_EDITOR=8012
PORT_TUNNEL=8787
VM_KEY="$HOME/.ssh/kde_neon_ed25519"
VM_HOST="claude@10.211.55.15"
VM_NAME="KDE neon"        # Parallels VM that runs the worker
VM_SSH=(ssh -i "$VM_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

# Power the worker's Parallels VM on if it's stopped (the systemd worker then auto-starts
# on boot). Without this, a suspended/stopped VM silently breaks every /v1 + /drive call.
ensure_vm() {
  command -v prlctl >/dev/null 2>&1 || return 0   # not this Mac → assume VM reachable
  local st; st="$(prlctl list -a 2>/dev/null | awk -v n="$VM_NAME" 'index($0,n){print $2; exit}')"
  [ "$st" = "running" ] && return 0
  echo "  VM '$VM_NAME' is ${st:-unknown} — starting it…"
  prlctl start "$VM_NAME" >/dev/null 2>&1 || true
  local i; for i in $(seq 1 30); do prlctl exec "$VM_NAME" true >/dev/null 2>&1 && { echo "  VM '$VM_NAME' up"; return 0; }; sleep 4; done
  echo "  WARNING: VM '$VM_NAME' did not come up in time"
}

# ---------------- internal: the detached supervisor loop for a Mac unit -----------
# Re-invoked as `devctl.sh __supervise <name> <cmd...>`; keeps <cmd> alive until killed.
if [ "${1:-}" = "__supervise" ]; then
  name="$2"; shift 2
  echo "$$" > "$DIR/$name.pid"
  child=""
  term() { [ -n "$child" ] && kill "$child" 2>/dev/null; rm -f "$DIR/$name.pid"; exit 0; }
  trap term TERM INT
  while true; do
    "$@" &
    child=$!
    wait "$child"; rc=$?
    echo "[$(date '+%F %T')] '$name' exited (rc=$rc) — restarting in 2s"
    sleep 2
  done
fi

# ---------------- helpers ----------------
is_running() { local n="$1"; [ -s "$DIR/$n.pid" ] && kill -0 "$(cat "$DIR/$n.pid" 2>/dev/null)" 2>/dev/null; }

start_mac() {  # name cmd...
  local name="$1"; shift
  if is_running "$name"; then echo "  $name: already running (pid $(cat "$DIR/$name.pid"))"; return 0; fi
  rm -f "$DIR/$name.pid"
  ( nohup "$SELF" __supervise "$name" "$@" >"$DIR/$name.log" 2>&1 </dev/null & )
  local i; for i in $(seq 1 25); do is_running "$name" && break; sleep 0.2; done
  if is_running "$name"; then echo "  $name: started (pid $(cat "$DIR/$name.pid"))"
  else echo "  $name: FAILED to start — see $DIR/$name.log"; fi
}

stop_mac() {  # name
  local name="$1"
  if is_running "$name"; then kill "$(cat "$DIR/$name.pid")" 2>/dev/null; sleep 0.4; echo "  $name: stopped"
  else echo "  $name: not running"; fi
  rm -f "$DIR/$name.pid"
}

port_up() { nc -z -G2 localhost "$1" >/dev/null 2>&1; }

# ---------------- worker (on the VM) ----------------
worker_install() {  # ship the VM-side daemon script (idempotent)
  scp -q -i "$VM_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
    "$WORKER_REPO/worker-daemon.sh" "$VM_HOST:~/worker-daemon.sh" 2>/dev/null
}
worker_cmd() { "${VM_SSH[@]}" "$VM_HOST" "bash ~/worker-daemon.sh $1" 2>&1; }

start_worker()  { ensure_vm; worker_install && echo "  worker: $(worker_cmd start)"; }
stop_worker()   { echo "  worker: $(worker_cmd stop)"; }
status_worker() { echo "  worker (VM): $(worker_cmd status)"; }

# ---------------- public verbs ----------------
do_start() {
  case "${1:-all}" in
    editor) start_mac editor bash "$EDITOR_REPO/dev-serve.sh" "$PORT_EDITOR" ;;
    tunnel) start_mac tunnel ssh -i "$VM_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
              -N -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
              -L "$PORT_TUNNEL:localhost:$PORT_TUNNEL" "$VM_HOST" ;;
    worker) start_worker ;;
    all) do_start worker; do_start tunnel; do_start editor ;;
    *) echo "unknown unit: $1"; exit 2 ;;
  esac
}
do_stop() {
  case "${1:-all}" in
    editor) stop_mac editor ;;
    tunnel) stop_mac tunnel ;;
    worker) stop_worker ;;
    all) stop_mac editor; stop_mac tunnel; stop_worker ;;
    *) echo "unknown unit: $1"; exit 2 ;;
  esac
}

do_status() {
  echo "FlexText dev rig:"
  for n in editor tunnel; do
    if is_running "$n"; then echo "  $n: RUNNING (pid $(cat "$DIR/$n.pid"))"; else echo "  $n: stopped"; fi
  done
  status_worker
  echo "Ports:  editor :$PORT_EDITOR $(port_up $PORT_EDITOR && echo up || echo down)   tunnel :$PORT_TUNNEL $(port_up $PORT_TUNNEL && echo up || echo down)"
  echo "URL:    http://localhost:$PORT_EDITOR/flextext-editor/?mode=researcher"
}

case "${1:-}" in
  start)   shift; echo "Starting…"; do_start "${1:-all}" ;;
  stop)    shift; echo "Stopping…"; do_stop "${1:-all}" ;;
  restart) shift; echo "Restarting…"; do_stop "${1:-all}"; sleep 1; do_start "${1:-all}" ;;
  status)  do_status ;;
  logs)    tail -n 40 "$DIR/${2:-editor}.log" 2>/dev/null || echo "no log for ${2:-editor}" ;;
  *) echo "usage: $0 {start|stop|restart} [editor|tunnel|worker|all] | status | logs [unit]"; exit 2 ;;
esac
