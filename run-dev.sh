#!/usr/bin/env bash
# Rapid dev launcher — `tauri dev` with a live-reloading vite dev server, but
# with the terminal's snap-injected glibc paths scrubbed so the Tauri binary
# doesn't crash with "undefined symbol __libc_pthread_init / SIGBUS".
#
# This is the FAST loop: edit src/main.ts or index.html -> save -> app hot-reloads.
# (For a frozen snapshot build instead, run the release binary after `cargo build --release`.)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

env \
  -u LD_LIBRARY_PATH -u LD_PRELOAD -u LD_DEBUG -u LOCPATH \
  -u GTK_PATH -u GIO_MODULE_DIR -u GSETTINGS_SCHEMA_DIR -u GTK_IM_MODULE_FILE \
  -u GNOME_SETUP_DISPLAY \
  HOME="$HOME" \
  DISPLAY="${DISPLAY:-:0}" \
  XAUTHORITY="${XAUTHORITY:-}" \
  XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" \
  DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}" \
  PATH="$PATH" \
  GDK_BACKEND=x11 \
  WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  GSETTINGS_BACKEND=memory \
  npm run tauri dev
