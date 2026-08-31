#!/usr/bin/env bash
# Osmograph Desktop — fast dev/test launcher.
#
# The terminal here is a VS Code snap, which leaks snap glibc into child
# processes and crashes the Tauri binary ("Bus error"/symbol-lookup error).
# This script rebuilds the frontend and launches the binary with a clean env,
# so the dev cycle is:  edit source -> ./dev.sh  (rebuild + relaunch in ~1s).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BIN="$ROOT/target/release/osmograph-desktop"

echo "==> Building frontend (dist/)..."
(cd "$HERE" && npm run build)

if [ ! -f "$BIN" ]; then
  echo "!! release binary not found at $BIN"
  echo "!! build it once with:  (cd '$HERE/src-tauri' && cargo build --release)"
  echo "!! using a clean env (see discussion). Aborting."
  exit 1
fi

echo "==> Launching with clean env (X11)..."
pkill -x osmograph-desktop 2>/dev/null || true
sleep 0.3

env -i \
  HOME="$HOME" \
  DISPLAY="${DISPLAY:-:0}" \
  XAUTHORITY="${XAUTHORITY:-}" \
  XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" \
  PATH=/usr/bin:/bin:/usr/local/bin \
  GDK_BACKEND=x11 \
  WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  "$BIN" &
echo "==> Launched pid $! — window should appear."
