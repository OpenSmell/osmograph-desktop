# Osmograph Desktop

Cross-platform e-nose recording and analysis desktop app (Tauri 2 + Rust + TypeScript/Vite), the
production replacement for the legacy Python Osmograph.

## Features

- **Live recording** from serial and BLE MOX sensor boards, with adaptive channel presets
  (3 / 4 / 6-sensor) and burn-in tracking.
- **Session library** with per-recording storage, CSV import/export, and `.osmell` bundle read/write.
- **Quality scoring** (`analyze_recording`) reusing the `opensmell` Rust quality scorer with the
  tolerant CSV parser's warnings surfaced in the report.
- **Calibration** reference-point power-law fitting and concentration inversion (quick
  datasheet-sourced and precise measured-fit paths).
- **Data Hub**: a quality-gated contribution pipeline (Pending → Approved → Published) for shared
  community data, plus **Hugging Face sync** — public list/download and token-gated upload. The HF
  write token is held **in memory only** (never written to disk or embedded) and entered per upload.

## Layout

- `src-tauri/src/` — Rust backend: DAQ (`live`), session data (`data/`), quality/classifier,
  burn-in (`burnin`), plugins (`plugins`), and 60+ Tauri commands in `lib.rs`.
- `src/main.ts` + `index.html` — TypeScript/Vite frontend.

## Development

```bash
npm install        # frontend deps
npm run dev        # Vite dev server
npm run build      # production frontend bundle
cargo test -p osmograph-desktop --lib   # backend unit tests
```

## Production / Windows build

```bash
npm install
cargo check -p osmograph-desktop        # verify backend + tauri context (incl. capabilities)
npm run tauri build                      # produce the installer bundle (MSI/NSIS on Windows)
```

Prerequisites on Windows: Rust toolchain (`rustup` stable + MSVC), `node + npm`, and the
[WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) runtime (preinstalled on
Windows 11). `serialport` and `btleplug` are pure Rust and build on Windows without extra drivers.

Note: app icons live in `src-tauri/icons/` (PNG set + `icon.ico` already checked in). If you swap
the logo, regenerate them with `npm run tauri icon <source.png>` from a 1024×1024 source.

_CSP note:_ `tauri.conf.json` currently sets `"csp": null`. This is a hardening TODO (see below) —
it is intentionally permissive so the app renders reliably during validation. Review before wider
distribution.

## Hardening TODO

- Set a real Content-Security-Policy in `tauri.conf.json` once the UI is validated (the frontend
  relies heavily on inline `style` attributes, so a policy allowing `'unsafe-inline'` for
  `style-src` and `'self'` for `script-src` is the next step).
- No live HF-upload or flash/BLE end-to-end test against physical hardware has been performed yet;
  run those flows during stress testing.

## Repo split

- `opensmell-rs` — the implementation SDK (features, quality, calibration, framework).
- `data-commons` — GitHub data pipeline (schemas, validator, reference `sensor_constants.json`).
- This `osmograph-desktop` repo — the application that consumes both.
