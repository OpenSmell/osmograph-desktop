#!/usr/bin/env bash
# Light dev loop: the prebuilt debug binary + Vite. NO Rust build.
#
# The full `tauri dev` path compiles 605 crates and OOMs this machine; this
# script assumes the binary is already built (cargo build --no-default-features
# inside src-tauri/) and only restarts the two cheap processes. Frontend edits
# hot-reload into the running window.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# --- Vite (frontend dev server, ~90 MB) ---
if ! ss -ltn 2>/dev/null | grep -q ':5173'; then
  setsid nohup npm run dev >.vite.log 2>&1 </dev/null &
  echo "vite: starting"
  for _ in $(seq 1 40); do
    ss -ltn 2>/dev/null | grep -q ':5173' && break
    sleep 0.25
  done
fi
ss -ltn 2>/dev/null | grep -q ':5173' && echo "vite: up on :5173" || { echo "vite: FAILED"; tail -20 .vite.log; }

# --- App window (prebuilt debug binary, loads from Vite) ---
BIN=./src-tauri/target/debug/osmograph-desktop
if [ ! -x "$BIN" ]; then
  echo "!! no binary at $BIN — build once: (cd src-tauri && CARGO_BUILD_JOBS=1 cargo build --no-default-features)"
  exit 1
fi
if [ "${1:-}" = "--stop" ]; then
  pkill -f "src-tauri/target/debug/osmograph-desktop" 2>/dev/null
  sleep 2
  echo "app: stopped"
  exit 0
fi
if [ "${1:-}" = "--restart" ]; then
  # Safe: this script's own argv is just "hot.sh", so it cannot match itself.
  pkill -f "src-tauri/target/debug/osmograph-desktop" 2>/dev/null
  sleep 2
fi
if pgrep -f "$BIN" >/dev/null 2>&1; then
  echo "app: already running"
else
  setsid nohup env -i \
    HOME="$HOME" \
    DISPLAY="${DISPLAY:-:0}" \
    XAUTHORITY="${XAUTHORITY:-}" \
    XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" \
    XDG_DATA_DIRS="$HOME/.local/share:/usr/share" \
    PATH=/usr/bin:/bin \
    GDK_BACKEND=x11 \
    WEBKIT_DISABLE_COMPOSITING_MODE=1 \
    GSETTINGS_BACKEND=memory \
    "$BIN" >.app.log 2>&1 </dev/null &
  echo "app: launched"
fi
sleep 6
wmctrl -l 2>/dev/null | grep -qi osmograph && echo "window: Osmograph is up" || echo "window: not visible yet"
