# Authoring a Vial

A **Vial** is a reusable, local-first way of working. There are two kinds:

| Kind | Schema | What it carries | How it is authored today |
|---|---|---|---|
| Decision Vial | `osmograph.vial/1` | A closed-set, same-array comparison with evidence, limits, and a method | Package a saved Check in **Vials → Decisions** |
| Domain Vial | `osmograph.domain-pack/1` | A protocol, log, risk model, decision rules, field notes, citations, a declarative workspace, and optional sandboxed UI assets | Write or generate a `.vial.json` manifest; any author can add `ui.html` and `home.html` beside it |

This document is about **domain Vials**, the kind that turns domain knowledge into a workspace. They are separate from the application binary: a `.vial.json` file can be exported, inspected, versioned, shared, and imported on another installation. The manifest is declarative data and the host renders a fixed vocabulary of widgets. Any Vial may also ship sandboxed `ui.html` and optional `home.html` fragments; they run in iframes with no network, storage, forms, frames, or Tauri access and receive only a typed data payload.

> **Current contract.** Every Vial is an author-hosted project. There is no official tier and no privileged author namespace. A Vial with a UI is installed from its manifest URL: the install fetches the manifest first, then `ui.html` and/or `home.html` beside it, and caches each asset by Vial id and version. A local file import can carry a declarative manifest but not the UI assets, so it is refused when the manifest declares `ui` or `homeUi`. There is still no signed bundle, revocation service, automatic update, or general plugin API. Do not describe those as implemented.

---

## Quick start

1. From the desktop repository, scaffold a project:

   ```bash
   npm run scaffold:vial -- ./my-vial "Coffee Roast Log" "@your-handle"
   ```

   The generator writes a complete `vial.json`, an empty host-snapshot fixture, and a README with the claim and the refusal.

2. Open **Vials → Aromatory**.
3. Use **Starter template** for a minimal manifest, or export an installed example to see a complete one. An example may open a sandboxed UI instead of the declarative widget stack; the manifest is still the same.
4. Edit the JSON. Change the `id`, `author`, `license`, claims, citations, and workspace content.
5. Validate without launching the app:

   ```bash
   npm run validate:vial -- ./my-vial
   ```

6. Import the file in **Aromatory → Import .vial.json**, or host it in your own GitHub repo and use **Aromatory → Install from URL** with the raw HTTPS manifest URL.
7. Install it, open the workspace, add a reading, and check that every widget renders. If you add a `ui.html` or `home.html`, install from the URL so the host can fetch the assets; a local file import cannot carry them.
8. Export it again, re-import it on a second installation, and inspect the result.
9. Share the manifest with the author, licence, evidence, and “what it is not” attached.

The runnable example is [`examples/example-coffee-roast.vial.json`](examples/example-coffee-roast.vial.json). It passes the local gate.

### Personal GitHub, without another registry repo

A Vial is a personal project. Put the manifest and optional `ui.html`/`home.html` in any repo you already control:

```text
https://raw.githubusercontent.com/<you>/<repo>/main/vial.json
https://raw.githubusercontent.com/<you>/<repo>/main/ui.html
https://raw.githubusercontent.com/<you>/<repo>/main/home.html
```

Paste the manifest URL into **Vials → Aromatory → Install from URL**. The app checks HTTPS, fetches the manifest, runs the local gate, fetches `ui.html` and/or `home.html` beside it when declared, and records the source in the installed pack. The project stays in your repo.

The public [Aromatory page](https://www.opensmell.xyz/vials) is an index, not a trust seal. To list a Vial there, add one entry to `opensmell-web/public/vials/registry.json` with the id, version, source URL, and the **sha256 of the manifest file**. Installers verify that hash: Osmograph refuses a manifest whose bytes do not match the registry entry (`sha256sum vial.json` after your last commit is the value to record). You do not need an npm release or a server, and the registry never hosts the Vial. A listing is not review or endorsement.

---

## What “separate” means

- **The manifest is separate.** It is a JSON file with its own version, author, licence, citations, and content. You can keep it in Git, attach it to an issue, or hand it to another rig owner.
- **The renderer is shared.** The host draws the declarative workspace from the widget vocabulary below. Any Vial may add separate `ui.html`/`home.html` assets that run in the host-owned sandbox; the manifest never carries code.
- **The log is local.** Installing a Vial stores the manifest in local storage and creates a local log. The log is not uploaded by the app. Deleting a Vial removes the pack and its local log on this installation.
- **There is no official tier.** Every Vial is an author-hosted project and every manifest goes through the same local gate. A local import is not a lesser class of Vial; it simply cannot carry a UI asset, so a manifest with `ui` or `homeUi` must be installed from its URL.

| Label | Meaning | Not a claim of |
|---|---|---|
| **Author-hosted** | A Vial installed from its author's manifest URL | Peer review, endorsement, or a security audit |
| **Local** | A declarative manifest imported from a file | Review, endorsement, or a UI asset |
| **Gated** (decision Vials) | The saved evidence passed the local decision-Vial gate | External validation or cross-rig transferability; "Sealed" is reserved for reviewed, signed Vials and is never minted locally |
| **Ungated** (decision Vials) | The evidence did not clear the gate | "Broken"; it means unusable for a decision |

---

## The host contract

A Vial does not read the raw feature vector. It receives a small, versioned snapshot from `src/vialHost.ts`:

| Field | Meaning |
|---|---|
| `source` | `live` (connected rig), `replay`, `dataset`, or `none`. The Home snapshot is `live` only while a rig streams; else `none`. The workspace source picker can load a `recording` — a captured series window labelled as such, never as live. |
| `samplingMode` | `timeseries`, `trial`, or `unknown`. Osmograph currently ships `timeseries` by construction; timeseries-only primitives must still refuse trial-level data. |
| `channels` | Per-channel `id`, `label`, `kind`, `unit`, and `health`. `unit` is the channel's natural unit (e.g. `ΔR/R₀` for analog MOX). `health` is the host's rolling-window verdict: `ok`, `stuck`, `saturated`, `noisy`, or `unknown` while unmeasured. |
| `environment` | Temperature (`°C`) and humidity (`%RH`), or `null`. Context, not an excuse. |
| `baseline` | `none`, `warming`, `ready`, or `stale`, plus `progress`. `ageSec` is the seconds since the baseline became ready **in this session** — measured, or `null` when the host has not observed it. No alarm before the host says ready. |
| `anomaly` | Host state (`unknown`, `normal`, `warning`, `critical`), score, confidence, alert level, triggered channels, and consecutive count. |
| `classifier` | `none` or loaded, with a closed-set label and confidence. |

The host owns the data plane, the detector, the classifier, and every refusal. A Vial may explain a host state, add a protocol, and point to the next human action. It may not override the host, invent a second detector, or turn a change signal into an identity, concentration, cross-rig claim, or safety verdict.

---

## Manifest shape

```json
{
  "schema": "osmograph.domain-pack/1",
  "id": "example.coffee-roast",
  "name": "Coffee Roast Log",
  "version": "0.1.0",
  "author": "@example-author",
  "license": "CC-BY-4.0",
  "risk": "medium",
  "domain": "coffee",
  "tagline": "Track the roast, not just the aroma.",
  "summary": "A small example workspace for logging roast batches and the context that changes what the array response means.",
  "whatItIs": "A protocol and a local log for recording roast batch context, tasting notes, and a same-array comparison against a reference bean.",
  "whatItIsNot": "Not a roast defect classifier, not a universal coffee identifier, not a concentration meter, and not a safety verdict.",
  "citations": [
    "A real reference: author, year, title, venue. A citation is context, not decoration."
  ],
  "widgets": [],
  "docs": []
}
```

### Required identity fields

| Field | Rule |
|---|---|
| `schema` | Must be `osmograph.domain-pack/1`. |
| `id` | Lowercase, 3–80 characters, `[a-z0-9._-]`. Must be unique across the registry. |
| `name` | 2–80 characters. |
| `version` | Semver, for example `0.1.0`, `1.2.0-beta.1`. |
| `minHost` | Optional. Oldest Osmograph version that renders this manifest without silent degradation, semver (also accepted: `min_host`). When declared, the gate **refuses to install** on an older host instead of silently dropping unknown widgets. Omit it only if every host since the first release renders the manifest correctly. |
| `author` | Credit a person or handle, 2–80 characters. |
| `license` | An SPDX id or a licence URL. Do not publish a pack whose content you cannot license. |
| `risk` | `low`, `medium`, `high`, or `critical`. See below. |
| `domain` | The domain or practice, for example `fermentation`, `plants`, `coffee`. |
| `tagline` | 4–160 characters. One honest line about the workspace. |
| `summary` | 30–600 characters. Explain the scope. |
| `whatItIs` | At least 30 characters. The useful claim or protocol. |
| `whatItIsNot` | At least 30 characters and must contain an explicit refusal (`not`, `cannot`, `no`, `never`, `without`, or `refuse`). |
| `citations` | At least one reference, each at least 10 characters. Real references, not “trust me”. |
| `docs` | At least two sections, each with a title and body text. High/critical risk packs need at least three. |

### Optional Home contribution

A Vial may add one compact Home card. The host composes it from the declared spec and a typed snapshot; the Vial never receives raw buffers or owns the detector. A Vial may instead ship a custom Home view as `homeUi`; the declarative card remains the fallback.

```json
"home": {
  "headline": "Arm one clean baseline. Watch for one sustained change.",
  "detail": "The host anomaly engine runs here, on this array. This Vial adds the protocol and the refusal.",
  "metrics": [
    { "label": "Scope", "value": "same device" },
    { "label": "Evidence", "value": "TADI-2019" }
  ],
  "actions": [
    { "id": "workspace", "label": "Open change watch", "kind": "open-workspace" },
    { "id": "datasets", "label": "Get a real corpus", "kind": "open-datasets" }
  ],
  "limits": [
    "A change signal is not an identity, a concentration, or a safety verdict."
  ],
  "sources": [
    "TADI-2019, doi:10.5281/zenodo.8399829"
  ]
}
```

| Field | Rule |
|---|---|
| `headline` | One short sentence. Required. |
| `detail` | One or two sentences. Required. |
| `metrics` | Zero to four `{label, value, hint?}` entries. |
| `actions` | One to three host verbs: `open-workspace`, `open-check`, `open-datasets`, `open-gallery`, or `external` (requires `href`). |
| `limits` | At least one explicit limit, each at least 10 characters. |
| `sources` | At least one real source, each at least 10 characters. |

The host merges the spec with `source`, `baseline`, `anomaly`, `classifier`, `environment`, and channel health from `src/vialHost.ts`. A malformed contribution is refused at import; the host never renders half a card. A Vial without `home` or `homeUi` stays workspace-only.

The desktop repo ships four fixtures in `fixtures/vial-host/` — `empty`, `warming`, `attention`, and `classifier` — plus `npm run test:vial-host`. Use them to test your own contribution before you connect a rig.

### Optional sandboxed UI (any author)

A Vial can add a real UI when the workspace or Home needs a chart, a domain-specific form, or a decision surface that the widget vocabulary cannot express. The manifest still carries no code; the UI is a separate body fragment beside it.

```json
"ui": {
  "runtime": "sandbox/1",
  "entry": "ui.html",
  "height": 900
}
```

| Field | Rule |
|---|---|
| `runtime` | Only `sandbox/1` is accepted in this build. |
| `entry` | A relative `.html` filename beside the manifest. No scheme, query, directory traversal, or remote path. |
| `height` | The initial workspace height, 420–2000 px. The UI can request a different height with `resize`. |

The asset is an HTML **body fragment**, not a document. It may contain inline `<style>` and `<script>`, but no `<html>`, `<head>`, `<body>`, `<base>`, external `src`/`href`, remote images, or `javascript:` URLs. The host wraps it in a document with a restrictive CSP:

```text
default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;
script-src 'unsafe-inline'; connect-src 'none'; media-src 'none';
frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none';
```

The frame also has `sandbox="allow-scripts"`, so it gets an opaque origin and no same-origin access to the app. It cannot use the network, `localStorage`, forms, frames, workers, or Tauri. The host owns the data, the anomaly engine, the classifier, persistence, and every refusal.

#### Optional Home view

A Vial may ship a second sandboxed fragment for Home. The declarative `home` card remains the fallback; when `homeUi` is installed, the host mounts the fragment instead of the card. This is a status surface, not a second source of truth: protocol fields, logs, baselines, and decisions still go through the host.

```json
"homeUi": {
  "runtime": "sandbox/1",
  "entry": "home.html",
  "height": 420
}
```

| Field | Rule |
|---|---|
| `runtime` | Only `sandbox/1` is accepted in this build. |
| `entry` | A relative `.html` filename beside the manifest. No scheme, query, directory traversal, or remote path. |
| `height` | The initial Home height, 320–620 px. The UI can request a different height with `resize` in the same range. |

The Home fragment uses the same CSP, `sandbox="allow-scripts"`, typed payload, and action allowlist as `ui.html`. Its payload sets `"view": "home"`; the workspace payload sets `"view": "workspace"`. The `open-workspace` action closes the compact view and opens the full workspace. A manifest that declares `ui` or `homeUi` must be installed from its manifest URL; a local file import is refused because it cannot carry the assets. The host caches the two assets separately by Vial id and version.

#### Runtime payload

The host sends one JSON payload over `postMessage`:

```json
{
  "schema": "osmograph.vial-runtime/1",
  "snapshot": { "source": "live", "baseline": {}, "anomaly": {}, "classifier": {} },
  "series": {
    "source": "live",
    "label": "Live array",
    "channels": ["MQ-2", "MQ-3"],
    "time": [0, 4, 8],
    "timeUnit": "sample",
    "values": [[1.0, 1.1, 1.3], [0.9, 1.0, 1.2]],
    "fingerprint": [0.12, 0.08],
    "evolution": { "bins": 64, "values": [[0.0, 0.1]], "maxAbs": 0.4 }
  },
  "sources": [{ "id": "live", "label": "Live array", "kind": "live" }],
  "selectedSource": "live",
  "events": [],
  "domain": { "fields": {}, "checks": {}, "logs": [] },
  "view": "workspace",
  "host": { "name": "Osmograph", "version": "desktop", "runtime": "sandbox/1" }
}
```

- `snapshot` is the typed host contract from `src/vialHost.ts`.
- `series` is a downsampled, JSON-safe window (at most about 600 points). Missing values are `null`; do not turn them into zeroes.
- `fingerprint` is baseline-relative: the settled response against the opening window. It is descriptive, not a classifier.
- `evolution` is a signed `ΔR/R0` matrix over equal time bins. Use it to show change over time, not only a mean.
- `sources` includes `live` and available recordings. Its first entry is the live slot: `kind: "live"` only while a rig is connected — with no rig it is `kind: "recording"`, labelled "Captured buffer", because the same bytes are then the tail of past samples, not a stream. `selectedSource` says which one is loaded. The UI can request another with `set-source`; the host caches recording windows per source.
- `events` is the host anomaly event history. A Vial may explain it; it may not invent a second detector.

#### Bridge and actions

```js
window.osmograph.onData((payload) => { /* render */ });
window.osmograph.ready();
window.osmograph.action({ type: 'set-source', source: 'rec:file-id' });
window.osmograph.toast('Reading added.');
```

| Action | Payload | Host behavior |
|---|---|---|
| `ready` | none | Marks the UI ready and sends the current payload. |
| `toast` | `message` | Shows a short status message. |
| `resize` | `height` | Sets the frame height: 420–2000 px in the workspace, 320–620 px on Home. |
| `save-field` | `key`, `value` | Persists one text field in the Vial's local state. |
| `add-log` | `values` | Adds a local log entry, capped and string-normalized. |
| `remove-log` | `id` | Removes one local entry. |
| `export-log` | none | Downloads the Vial's local log as JSON. |
| `open-dashboard` | none | Opens Home, where the host anomaly engine lives. |
| `open-datasets` | none | Opens the Datasets source library. |
| `open-check` | none | Opens Separability, the evidence gate. |
| `open-workspace` | none | From Home, opens this Vial's full workspace. |
| `open-vials` | none | Closes the workspace. |
| `set-source` | `source` | Switches between live and a recording, after validating the id. |

The parser is deliberately small: unknown action types, unsafe property keys (`__proto__`, `prototype`, `constructor`), oversized values, and non-string payloads are dropped. A sandboxed UI cannot call a Tauri command, evaluate host code, or read the raw feature vector.

#### Install, cache, and fallback

- An install from a manifest URL fetches the manifest, then `ui.html` and/or `home.html` beside it. The workspace cache key is the Vial id; the Home key is `<id>::home`.
- If a UI fetch fails, the host renders the declarative widgets or the `home` card. There is no built-in fallback copy.
- A manifest with `ui` or `homeUi` imported from a local file is rejected; the host cannot fetch the assets, so install it from its URL.
- `npm run test:vial-runtime` checks the sandbox builder, parser, downsampling, fingerprint, evolution, and the example workspace and Home fragments. It is a contract test, not a security certification.

A sandboxed UI is still a Vial, not a second app. It must state its scope and limits, use the host's state rather than re-deriving it, and refuse identity, concentration, cross-rig, and safety claims. If the domain decision depends on a certified instrument, the UI must say so and point to it.

### Risk levels

| Level | Use it when | Extra gate requirement |
|---|---|---|
| `low` | A reversible, low-consequence record or observation | None |
| `medium` | A decision-support workspace where a wrong reading costs time or money, but not safety | None |
| `high` | A process where a wrong decision could spoil a batch, waste significant resources, or create a health risk | At least one `stop` rule and at least three docs |
| `critical` | A process where a wrong decision could cause serious harm | Same as high; expect the pack to be rejected until the safety story is explicit |

Risk is a declaration, not a certification. A high-risk pack with a stop rule is still not a safety instrument.

---

## Widget vocabulary

The host renders only these widget types. Unknown widget types are ignored by this host, so a widget that depends on a future host will not appear. Check the rendered workspace before publishing.

Widgets are rendered in a stable order:

- **Full width:** `hero`, `risk`, `metrics`
- **Two columns:** `detector`, `tracking`, and `chart` on the left; `diagram`, `timeline`, `rules`, `checklist`, and `docs` on the right
- **Full width:** `rig`

Every pack must have `hero`, `risk`, `docs`, `rig`, and at least one of `tracking`, `diagram`, or `rules`.

### `hero`

```json
{
  "type": "hero",
  "art": "generic",
  "title": "Coffee Roast Log",
  "subtitle": "A batch record with a sensor column, not a sensor verdict.",
  "note": "Author-hosted Vial · declarative · host-rendered · optional sandboxed UI"
}
```

`art` is one of `fermentation`, `plant`, or `generic`. The art is a host-owned diagram. You cannot supply an image, SVG, or URL.

### `risk`

```json
{
  "type": "risk",
  "level": "medium",
  "headline": "The roast is the evidence; the array is a prompt.",
  "body": "A roast can smell pleasant and still be under-developed, baked, or scorched.",
  "always": ["Record the context that changes the interpretation."],
  "never": ["Do not turn a pleasant aroma into a quality score."]
}
```

`always` and `never` must both be non-empty. `level` should match the pack’s `risk`.

### `metrics`

```json
{
  "type": "metrics",
  "title": "What this workspace can claim",
  "items": [
    { "label": "Signal", "value": "Same-array change", "hint": "Against your own reference." },
    { "label": "Not a", "value": "Quality score", "hint": "No defect classification." }
  ]
}
```

### `diagram`

```json
{
  "type": "diagram",
  "art": "generic",
  "title": "The loop",
  "caption": "A dotted guide, not a chemical pathway.",
  "hotspots": [
    { "id": "sample", "label": "Sample", "x": 20, "y": 50, "body": "What went in, and how it was prepared.", "severity": "info" }
  ]
}
```

Coordinates are 0–100. `severity` is `info`, `warn`, or `stop`.

### `timeline`

```json
{
  "type": "timeline",
  "title": "Rhythm",
  "steps": [
    { "label": "Day 0", "range": "0–24 h", "body": "Record the starting context." },
    { "label": "Day 2", "range": "48 h", "body": "Inspect.", "warn": "Do not infer safety from the smell." }
  ]
}
```

### `tracking`

```json
{
  "type": "tracking",
  "title": "Roast log",
  "description": "Keep the context fixed enough that a comparison means something.",
  "fields": [
    { "id": "bean", "label": "Bean / lot", "type": "text", "placeholder": "Lot 04" },
    { "id": "roast_level", "label": "Roast level", "type": "select", "options": ["light", "medium", "dark"] }
  ],
  "logFields": [
    { "id": "day", "label": "Rest day", "type": "number", "placeholder": "3" },
    { "id": "drop_temp", "label": "Drop temp", "type": "number", "unit": "°C" }
  ],
  "logLabel": "Add roast reading"
}
```

A tracking widget needs at least two context fields and at least two reading fields. Field types are `text`, `number`, `date`, and `select`. `select` needs `options`. The log stores strings locally.

### `chart`

```json
{
  "type": "chart",
  "title": "Trend",
  "yLabel": "Reading",
  "logField": "day",
  "demo": [{ "x": 0, "y": 0 }, { "x": 2, "y": 1 }],
  "note": "The line is your log, not a diagnosis."
}
```

`demo` is the empty-state example. It is not data. The chart plots the selected log field if it is numeric.

### `detector`

Use this only when the workspace is wired to the live anomaly engine. It documents the detector contract; it does not add a second model.

```json
{
  "type": "detector",
  "title": "Detector contract",
  "intro": "Maps the live engine states to a decision you can audit.",
  "baseline": "A fresh clean-air window on this exact array. Warming up never alarms.",
  "levels": [
    { "level": 0, "label": "Warming up", "meaning": "The baseline is still forming.", "action": "Do not arm yet." },
    { "level": 1, "label": "Warning", "meaning": "A sustained change from the baseline.", "action": "Stop and inspect." },
    { "level": 2, "label": "Critical", "meaning": "The change persisted past the critical duration.", "action": "Follow the domain stop rule." }
  ],
  "limits": [
    "Same-device and same-array only. A baseline from another rig does not transfer.",
    "A change is not an identity, a concentration, or a safety verdict."
  ],
  "evidence": "State the evidence behind the mapping, or remove this panel."
}
```

The panel needs at least three levels, each with a label, meaning, and action; at least two limits of 10+ characters; and an evidence sentence of 20+ characters. The “Open live detector” button goes to Home. Do not use this widget to imply a gas-leak detector or a safety instrument.

### `rules`

```json
{
  "type": "rules",
  "title": "Decision rules",
  "rules": [
    { "when": "The context changed", "then": "Do not compare to the old baseline.", "severity": "warn" },
    { "when": "The primary measurement is outside the safe range", "then": "Stop. The smell does not clear it.", "severity": "stop" }
  ]
}
```

`severity` is `info`, `warn`, or `stop`. High and critical risk packs need at least one `stop` rule.

### `checklist`

```json
{
  "type": "checklist",
  "title": "Before you start",
  "items": [
    { "id": "array", "label": "Same array", "detail": "The reference and sample share the same channel set." }
  ]
}
```

### `docs`

```json
{ "type": "docs", "title": "Field notes" }
```

This renders the pack-level `docs` array. It has no inline body of its own.

### `rig`

```json
{
  "type": "rig",
  "title": "Use this with your rig",
  "body": "If the channel sets differ, Check refuses the comparison.",
  "cta": "Open Check"
}
```

`cta` must open the existing Check flow. The pack cannot inject a URL or run code.

---

## The policy gate

On import, the local gate coerces the manifest and runs these checks. Critical failures reject the import; warnings do not.

| Check | Critical? | What it means |
|---|---|---|
| Schema | yes | The file declares `osmograph.domain-pack/1`. |
| Id | yes | Stable, lowercase, unique across the registry. |
| Name | yes | 2–80 characters. |
| Version | yes | Semver. |
| Author | yes | Credit a person or handle. |
| Licence | yes | Present. |
| Risk | yes | One of the four levels. |
| Domain / tagline / summary | yes | Present and within length limits. |
| What it is / what it is not | yes | Both explicit; the refusal must contain a negation. |
| Citations | yes | At least one real reference. |
| Docs | yes | At least two sections (three for high/critical). |
| Required widgets | yes | `hero`, `risk`, `docs`, `rig`, and a workspace surface. |
| Risk lists | yes | `always` and `never` are non-empty. |
| Risk consistency | no | The risk panel should match the pack level. |
| High-risk stop rule | yes | High/critical packs need a `stop` rule. |
| Tracking fields | yes | At least two context and two reading fields. |
| Diagram hotspots | yes | At least one valid 0–100 hotspot. |
| Detector states | yes | A `detector` widget needs three states with meaning and action. |
| Detector limits | yes | A `detector` widget needs two explicit limits. |
| Detector evidence | yes | A `detector` widget needs a stated evidence basis. |
| Rule text | yes | Every rule has a `when` and a `then`. |
| Checklist items | yes | Stable ids and labels. |
| No executable/remote UI | yes | Manifest text contains no `<script>`, `<iframe>`, `<object>`, `<embed>`, `<img>`, `<link>`, `javascript:`, inline handlers, or `data:text/html`. |
| UI runtime and entry | yes | If `ui` is present, `runtime` is `sandbox/1`, `entry` is a safe relative `.html`, and the asset passes the sandbox fragment checks. |
| UI source | yes | A manifest with `ui` must be installed from its manifest URL. A local file import cannot carry the asset and is refused. |
| No overclaim language | yes | No unnegated safety-device, safety-verdict, pathogen, diagnosis, ethylene, universal-ID, concentration/ppm, cross-rig, any-rig, guarantee, or medical claim. |

The overclaim check is **heuristic**. It looks for known phrases and allows them when the same sentence contains a negation. It is not a semantic proof. A cleverly worded overclaim can still pass, and that is why a Vial is not endorsed just because it passes.

### Refused examples

- “The array detects ethylene.”
- “A pleasant smell means the batch is safe to eat.”
- “This diagnoses a plant disease.”
- “A gas leak detector for your room.”
- “The room is safe to enter.”
- “Universal smell ID.”
- “Reads concentration in ppm.”
- “Works on any rig.”
- “Guaranteed to detect spoilage.”
- “Medical advice.”

### Honest alternatives

- “A same-array change signal; inspect the plant and the context.”
- “A prompt to look, not a diagnosis.”
- “No ethylene channel is present in the current constants table.”
- “Not a safety verdict; use the primary measurement.”
- “Not a gas leak detector or a safety device; use a certified instrument.”
- “Not a concentration meter; the number is a normalised response shape.”
- “Not transferable to another rig without calibration.”

---

## Security and privacy model

- **The manifest is data.** The host does not `eval`, import, or run it. If the manifest contains executable or remote UI patterns, the gate rejects it.
- **The UI is sandboxed.** A `ui.html` or `home.html` asset is a body fragment in an iframe with `sandbox="allow-scripts"` and a CSP that blocks network, storage, forms, frames, workers, external assets, and Tauri. The host injects the document; the Vial never gets same-origin access.
- **The UI must stay beside the manifest.** The host fetches each UI asset from the same origin and path as the manifest. A redirect that leaves that origin or path is rejected. The UI cannot load remote CSS, images, fonts, or scripts.
- **No runtime telemetry.** The UI has no network access. Installing a Vial makes the requests needed to fetch the manifest and, when declared, its UI asset. Saving fields and logs is local.
- **No privileged identity.** There is no official label, reserved namespace, or reserved author handle. The source URL is recorded for provenance; it is not a trust claim.
- **Local storage.** Vials live under `osmograph.domain.packs.v1`; install state under `osmograph.domain.installed.v1`; logs under `osmograph.domain.state.v1`; fetched UI assets under `osmograph.domain.ui.v1`, keyed by Vial id and version. A URL-installed pack keeps its `sourceUrl` in the manifest. Delete a Vial to remove the pack and its log on this installation.
- **Export is explicit.** The manifest export writes the manifest without the UI asset. The UI's export action writes the local log as JSON. Neither action uploads anything.

The local gate is a content and policy gate, not a sandbox for arbitrary code. The sandbox and CSP are the enforcement boundary for `ui.html` and `home.html`. A signed bundle with revocation, per-Vial permissions, and a threat model is still future work; that is not this build.

---

## Vibe-coding a domain Vial

You can use an LLM to draft a manifest. Give it the constraints, not just the idea. A useful prompt:

> Write a complete `osmograph.domain-pack/1` JSON manifest for an **author-hosted** domain Vial about **[domain/task]**. The manifest must be declarative data, not code; a UI, if needed, is a separate sandboxed `ui.html` or `home.html`. Use only the widget types `hero`, `risk`, `metrics`, `detector`, `diagram`, `timeline`, `tracking`, `chart`, `rules`, `checklist`, `docs`, and `rig`. Include `hero`, `risk`, `docs`, `rig`, and at least one of `tracking`, `diagram`, or `rules`. Use `art: "generic"` unless the domain is fermentation or plants. State a real `risk` level, at least two citations, at least three docs, and an explicit `whatItIsNot` that refuses the most tempting overclaim. Do not claim universal smell ID, absolute concentration, cross-rig transfer, pathogen detection, ethylene detection, diagnosis, safety, or guaranteed performance. Do not include HTML, JavaScript, URLs as resources, base64, or remote images. Every field must be plain text. The workspace should help a practitioner record context, inspect a change, and stop when the primary measurement says stop. After writing it, list the claims that still need evidence.

Then run the validator, import it, and read the rendered workspace. A model can produce plausible domain text; it cannot produce your evidence. Treat the draft as a scaffold, not a source.

---

## Submission and review

There is **no hosted marketplace, signed registry, or account system**. The submission unit is the Vial project: `vial.json` plus optional `ui.html`/`home.html`. Direct URL install is implemented; the [Aromatory page](https://www.opensmell.xyz/vials) is an index. To propose a listing:

1. Host the manifest and optional UI assets in your own repository and validate them locally.
2. Open a pull request that adds one registry entry to `opensmell-web/public/vials/registry.json`, or open an issue with the raw manifest URL.
3. Include the author, licence, domain, risk level, citations, source URL, and the exact “what it is not”.
4. State what you tested: validate, install, log entry, export, re-import, deletion, and the UI if present.
5. Explain who the Vial is for and what decision it supports.
6. Disclose any data, images, or text you did not author, and confirm you have the right to license it.
7. Do not claim official status, clinical validation, safety certification, or endorsement.

Review is editorial and policy-focused: identity, licence, citations, scope, risk framing, forbidden claims, and whether the workspace is useful. It is not a laboratory validation of your domain claim. A listing is not a trust seal. A Vial can be useful and still be wrong; the docs and limits are how a user sees that.

---

## Known limits of this authoring stage

- Direct HTTPS install of a manifest and its optional `ui.html`/`home.html`. No signed registry feed, marketplace, payments, revocation, or automatic updates.
- A Vial may ship a sandboxed UI, but it is an HTML fragment with no network, storage, forms, frames, workers, remote assets, or Tauri access. It is not a general-purpose plugin API.
- No custom widget types beyond the vocabulary above. The sandboxed UI is the escape hatch for a domain screen, not a new public widget API.
- No per-pack permissions. Every UI runs under one fixed CSP and the same small action allowlist.
- No identity verification beyond the author string and the recorded source URL.
- No server-side validation; the gate runs locally.
- No migration system for pack data beyond the local schema version.
- No cross-rig calibration story. A Vial that implies one is overclaiming.
- The local gate is heuristic. Passing it is necessary, not sufficient, for trust.

If you need one of these, say so in the issue. Do not quietly simulate it in the manifest.

---

## Related documents

- [`GUIDE.md`](GUIDE.md) — the public field guide: claim ladder, Check, Vials, data, privacy, limits, glossary.
- [The Aromatory](https://www.opensmell.xyz/vials) — the public Vial discovery page and registry JSON.
- [`NOTICE.md`](NOTICE.md) — attribution, dataset licences, and what is linked versus rehosted.
- [`examples/example-coffee-roast.vial.json`](examples/example-coffee-roast.vial.json) — a complete, validated example.
- [`src/domainPacks.ts`](src/domainPacks.ts) — the schema, coercion, gate, and import/export implementation.
- [`src/vialRuntime.ts`](src/vialRuntime.ts) — the sandbox document builder, payload helpers, CSP, and action parser.
- `/home/praisejamesx/Documents/Documents/code/osmograph-vials/` — the author-hosted reference projects. They are not inside this repository or the web app.
- [`scripts/test-vial-runtime.mjs`](scripts/test-vial-runtime.mjs) — the sandboxed UI contract test.
- [`src/guide.ts`](src/guide.ts) — the in-app field guide source.
