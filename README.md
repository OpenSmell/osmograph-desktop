# Osmograph Desktop

Cross-platform e-nose recording and analysis desktop app (Tauri 2 + Rust + TypeScript/Vite), the
production replacement for the legacy Python Osmograph.

Osmograph digitises **the experiment around a smell**, not the smell itself. The useful product is a
reproducible, same-array comparison with its context, evidence, uncertainty, and limits attached —
not a universal smell identifier, a concentration meter, or a safety instrument.

## Documentation

- [`GUIDE.md`](GUIDE.md) — the public field guide: claim ladder, fingerprints, Check, Vials, data
  provenance, privacy, tutorials, known limits, and glossary. The same content is available in the
  app as **? Guide** and with `Ctrl/Cmd+K`.
- [`AUTHORING.md`](AUTHORING.md) — how domain Vials work, the `.vial.json` schema, the widget
  vocabulary, the local policy gate, the sandboxed UI contract, and the author-hosted submission path.
- [`NOTICE.md`](NOTICE.md) — the canonical attribution and licensing record for datasets and third-party
  material.
- [`examples/example-coffee-roast.vial.json`](examples/example-coffee-roast.vial.json) — a complete,
  validated example domain Vial.

## Features

- **Job-level navigation**: **Home** (live rig or selected domain Vial), **Explore** (smell library), **Analyse**
  (Compare, Separability, Train), **Vials**, and **Explore** (gallery, recordings, datasets),
  **Fleet** (devices and remote endpoints), and **Settings** (hardware, calibration, release). Hardware controls stay on
  Home, Fleet, and Settings; content workspaces stay quiet.
- **Vial Home handoff**: choosing a Home Vial in Fleet opens its sandboxed domain view in place of
  the core dashboard and restores that choice on launch. Instrument link, baseline, and change state
  remain host-rendered; Exit returns to the core Home.
- **No-hardware first run**: Explore ships 22 real, labelled SmellNet smells. Home's
  **Try a comparison** selects the starter pair and opens Analyse → Compare without pretending a
  rig is connected.
- **Transforms + trim**: source → named steps → preview → Save `.osmell`. Use `trim.range` to cut a
  recording, smooth/filter, baseline, normalize, and add the derived result back to the library
  without overwriting the original.
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

## Vials

Vials are installable ways of working, not just saved files.

- **Domain Vials** package a protocol, a local log, a risk model, stop rules, field notes, citations,
  and a workspace. The app ships no domain Vial source. The reference projects live in author-hosted
  repos: **Fermentation Lab** has a workspace UI and a compact Home view, **Plant Respiration** is
  declarative, and **Anomaly Watch** is retired and unlisted. A published Vial can be exported as
  `.vial.json`, inspected, versioned, shared, and installed on another installation.
- **Any Vial may ship a UI.** The sandbox is the execution boundary, not a trust tier. A Vial with a
  `ui.html` or `home.html` must be installed from its manifest URL so the host can fetch the assets
  beside it.
- **Personal GitHub, no new registry repo.** Host `vial.json` and optional `ui.html`/`home.html` in a
  repo you already control and install from the raw HTTPS manifest URL in **Vials → Aromatory →
  Install from URL**. The app fetches the manifest, runs the local gate, fetches the declared assets,
  and records the source. The public [Aromatory page](https://www.opensmell.xyz/vials) is an index backed by one
  JSON file in the existing `opensmell-web` site. It does not host the Vial.
- **No official tier.** Every Vial is an author-hosted project. There is no reserved namespace, no
  privileged author handle, and no built-in copy. A listing is discovery, not endorsement.

The local policy gate runs on import. It checks identity, licence, scope framing, required docs and
citations, widget shape, explicit stop rules, executable/remote UI patterns, and known
overclaim language. It is heuristic: passing is necessary, not sufficient, for trust.

Validate a manifest without launching the app:

```bash
npm run validate:vial -- examples/example-coffee-roast.vial.json
```

Stage 1 includes direct HTTPS install of a manifest and its optional sandboxed `ui.html`/`home.html`. It does
**not** include a hosted marketplace, a signed registry feed, revocation, automatic updates, signed
code bundles, per-Vial permissions, or cross-rig calibration. Those are separate design problems;
the authoring and submission limits are documented in [`AUTHORING.md`](AUTHORING.md).

## Layout

- `src-tauri/src/` — Rust backend: DAQ (`live`), session data (`data/`), quality/classifier,
  burn-in (`burnin`), plugins (`plugins`), and 60+ Tauri commands in `lib.rs`.
- `src/main.ts` + `index.html` — TypeScript/Vite frontend.
- `src/domainPacks.ts` — domain-Vial schema, local policy gate, import/export, UI cache.
- `src/vialRuntime.ts` — sandbox document builder, typed payload, CSP, and action parser.
- `src/guide.ts` — the in-app field guide content; mirrored publicly in `GUIDE.md`.
- `scripts/validate-vial.mjs` — CLI wrapper around the same domain-Vial gate and UI fragment checks.
- `scripts/test-vial-runtime.mjs` — sandbox, payload, and parser contract test.

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
