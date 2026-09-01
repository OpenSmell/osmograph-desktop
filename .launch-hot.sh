#!/usr/bin/env bash
# Persist in the project (survives /tmp cleaning). Launches the hot-reload dev
# server detached with the calling shell's X session env.
cd "$(dirname "${BASH_SOURCE[0]}")"
exec setsid bash ./run-dev.sh </dev/null >"$PWD/.devhot.log" 2>&1
