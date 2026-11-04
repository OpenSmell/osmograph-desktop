# AGENTS.md — working in `osmograph-desktop`

A Tauri v2 desktop app: Rust core in `src-tauri/`, TypeScript UI in `src/` + `index.html`.

## Commands
- **UI only (fast, hot-reloads):** `npm run dev` (Vite on `:5173`).
- **Full app:** `npm run tauri -- dev` — rebuilds Rust when `src-tauri/` changes.
  This is slow (~4–8 min). On low-RAM machines set `CARGO_BUILD_JOBS=1`.
- **Type check:** `npx tsc --noEmit`.
- **Rust tests:** `cargo test` (inside `src-tauri/`). Run them with a **separate
  `CARGO_TARGET_DIR`** from a live `tauri dev` (or stop dev first) — sharing the target
  dir relinks the running binary and kills the app.
- **Update manifest tests:** `npm run test:latest-json`.
- **Update UI probe:** start `npm run dev -- --port 5173`, then `npm run test:updates-ui`.
- **Release build:** `npm run tauri -- build`.

## Conventions
- Do not add comments unless they explain *why*.
- Frontend-only edits hot-reload instantly; editing Rust or `tauri.conf.json` forces a full rebuild.
- Tauri commands are registered in `src-tauri/src/lib.rs`; keep each JS `invoke('name', {…})` and its Rust handler in sync.
- The `.osmell` bundle is a ZIP of `manifest.json` + `data.csv` + `events.json`
  + `quality.json` (scored at save time; recorder + recovery paths only).
- **Never rehost restrictive datasets** — link only. See `NOTICE.md`.

## Environment note
When launched from an IDE or a snap, GTK env vars can leak in and crash the app. Launch with:

```
env -u GTK_PATH -u GTK_EXE_PREFIX -u GTK_IM_MODULE_FILE -u GIO_MODULE_DIR -u GDK_BACKEND -u GTK_MODULES …
```

and include `~/.local/share/opensmell-schemas` on `XDG_DATA_DIRS`.

## Where things live
- `src/main.ts` — all UI logic (single entry point).
- `src/datasets.ts` — public dataset catalog + licence metadata.
- `src-tauri/src/data/` — import/export, `.osmell` bundles, hub download.
- `src-tauri/src/plugins.rs` — plugin discovery.
- `src-tauri/src/updates.rs` — release checks, policies, channels, signed in-place install, and restart.
- `scripts/set-version.mjs` — sets/checks `package.json`, lockfiles, Cargo, and Tauri versions together.
- `scripts/setup-updater-keys.mjs` — generates the update signing keypair and patches the public key.
- `scripts/make-latest-json.mjs` — builds the signed `latest.json` updater manifest from release assets.
- `docs/UPDATES.md` — update architecture, trust model, platform matrix, signing and release operations.
- `RELEASING.md` — tag → build → channel → release-notes process.
