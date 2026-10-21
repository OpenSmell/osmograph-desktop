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
  vocabulary, the local policy gate, security model, and the community submission path.
- [`NOTICE.md`](NOTICE.md) — the canonical attribution and licensing record for datasets and bundled
  material.
- [`examples/community-workspace.vial.json`](examples/community-workspace.vial.json) — a complete,
  validated community domain Vial.

## Features

- **Job-level navigation**: **Home** (live rig), **Explore** (smell library), **Analyse**
  (Compare, Check, Recipes, Train, Change Log), **Vials**, **Data** (recordings + datasets),
  **Rigs** (fleet), and **Settings** (hardware, calibration, release). Hardware controls stay on
  Home, Rigs, and Settings; content workspaces stay quiet.
- **No-hardware first run**: Explore ships 22 real, labelled SmellNet smells. Home's
  **Try a comparison** selects the starter pair and opens Analyse → Compare without pretending a
  rig is connected.
- **Recipes + trim**: source → named steps → preview → Save `.osmell`. Use `trim.range` to cut a
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

- **Decision Vials** package a saved Check: a closed-set, same-array claim with the reference and
  sample, unique channels, replicates, held-out evaluations, separation verdict, 95% Wilson lower
  bound, permutation p-value, limits, provenance, and method. The local gate seals a Vial only when
  every critical check passes. “Sealed” is a local evidence status, not external validation.
- **Domain Vials** package a protocol, a local log, a risk model, stop rules, field notes, citations,
  and a host-rendered workspace. Official examples are **Anomaly Watch** (high risk), **Fermentation
  Lab** (high risk), and **Plant Respiration** (medium risk). A domain Vial is declarative data: it
  can be exported as `.vial.json`, inspected, versioned, shared, and imported on another
  installation. It cannot ship executable code or custom HTML/CSS in Stage 1.
- **Personal GitHub, no new registry repo.** Host the `.vial.json` in a repo you already control and
  install it from the raw HTTPS URL in **Vials → Aromatory → Install from URL**. The app fetches one
  manifest, runs the local gate, and records the source host. The public
  [Aromatory page](https://www.opensmell.xyz/vials) is a discovery list backed by one JSON file in
  the existing `opensmell-web` site.
- **Community packs** are always treated as community on import, even if their manifest claims
  official status. The `official.*` id namespace and `@opensmell` author handle are reserved.
  “Official” means first-party, not correct, safe, or endorsed.

The local policy gate runs on import. It checks identity, licence, risk framing, required docs and
citations, widget shape, stop rules for high-risk packs, executable/remote UI patterns, and known
overclaim language. It is heuristic: passing is necessary, not sufficient, for trust.

Validate a manifest without launching the app:

```bash
npm run validate:vial -- examples/community-workspace.vial.json
```

Stage 1 includes direct HTTPS install of a single manifest. It does **not** include a hosted
marketplace, a signed registry feed, revocation, automatic updates, sandboxed third-party code, or
cross-rig calibration. Those are separate design problems; the authoring and submission limits are
documented in [`AUTHORING.md`](AUTHORING.md).

## Layout

- `src-tauri/src/` — Rust backend: DAQ (`live`), session data (`data/`), quality/classifier,
  burn-in (`burnin`), plugins (`plugins`), and 60+ Tauri commands in `lib.rs`.
- `src/main.ts` + `index.html` — TypeScript/Vite frontend.
- `src/domainPacks.ts` — domain-Vial schema, official packs, local policy gate, import/export.
- `src/guide.ts` — the in-app field guide content; mirrored publicly in `GUIDE.md`.
- `scripts/validate-vial.mjs` — CLI wrapper around the same domain-Vial gate.

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
