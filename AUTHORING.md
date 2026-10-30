# Authoring a Vial (this repository)

A **Vial** is a programmable anomaly workspace for the Osmograph array. It has
three parts:

| Part | What it is | Who owns it |
|---|---|---|
| Profile | A `vial.json` `anomaly` block: baseline, transforms, per-channel limits, min-channel corroboration, escalation, persistence, hysteresis, and admissibility. | The manifest. The host compiles it into a detector it owns. |
| Domain UI | Optional `ui.html` and `home.html` **body fragments**, or the host-rendered declarative workspace. | The author. Runs in a sandboxed iframe; cannot change the detector. |
| Evidence | A held-out report, citations, metrics, and declarative fixtures. | The author. Review checks the claim, not the screen. |

A folder of text and a screen is a description. The profile is what changes what
the instrument does. The host owns sampling, baseline health, detection, and every
safety refusal; the Vial owns the domain interpretation and the screen.

---

## Authoring tools in this repository

```bash
# 1. Scaffold a v2 project in the current directory
node scripts/create-vial.mjs praisejamesx.plant-respiration \
  --name "Plant Respiration" --author "@praisejamesx" --domain plants

# 2. Edit the project: vial.json, ui.html, home.html, fixtures/, EVIDENCE.md

# 3. Gate it locally (the same policy gate the host runs on import)
npm run validate:vial -- praisejamesx.plant-respiration

# 4. Install it
#    - "Import .vial.json" installs the declarative manifest only (no sandbox UI).
#    - "Install a Vial from URL" fetches a raw vial.json over HTTPS (localhost OK
#      for development), fetches and hash-verifies ui.html / home.html beside it,
#      and pins them. A local file cannot carry sandboxed UI assets.
```

`scripts/create-vial.mjs` writes a complete v2 project folder: `vial.json`,
`ui.html`, `home.html`, `fixtures/baseline-drift.json`, `EVIDENCE.md`, and
`README.md`. Host that folder (for example GitHub Pages) and install it from the
raw `vial.json` URL.

`npm run validate:vial` runs `src/domainPacks.ts` validation — the same gate the
host applies at install. It also checks that every `fixtures/<name>.json`
declared in `evidence.fixtures` exists and is valid JSON beside the manifest.

---

## Files

| Path | Required | Purpose |
|---|---|---|
| `vial.json` | yes | `osmograph.domain-pack/2`. The profile, UI contract, capabilities, and evidence. |
| `ui.html` | optional | Sandboxed workspace body fragment. Referenced by `ui.entry`. |
| `home.html` | optional | Compact Home body fragment. Referenced by `homeUi.entry`, paired with a `home` block. |
| `fixtures/*.json` | for Gated | Declarative cases declared in `evidence.fixtures`. A v2 without one is Ungated. Pinned at review. |
| `EVIDENCE.md` | for a listing | Your held-out report, at `evidence.reportUrl`. |
| `README.md` | yes | What the Vial does, how to install it, and the evidence path. |

A UI asset is a **body fragment**, not a document. It must not contain
`<!doctype>`, `<html>`, `<head>`, or `<body>`, and must not load an external
script, style, image, or frame, use `javascript:` URLs, inline event handlers,
`fetch`/`XMLHttpRequest`/`WebSocket`, browser storage (`localStorage`,
`sessionStorage`, `indexedDB`), or `eval`/`new Function`. The sandbox CSP blocks
network and storage; the runtime enforces it.

A v2 UI also must not call `osmograph.setDetection` or `osmograph.setTransforms`
(they throw). The anomaly profile in `vial.json` is the program; the host arms
it. The Vial reads live data through `window.__OSMOGRAPH_VIAL_HOST__` (the
VialHost SDK: `getLiveReadings`, `getChannels`, `getBaseline`,
`getRecentReadings`, `getSnapshot`, `getSeries`,
`on('tick'/'data'/'connect'/'disconnect')`,
`logEvent`, `getEvents`/`clearEvents`, `persist`/`retrieve`, `requestAction`,
`exportJournal`, and the math helpers) and asks the host for actions through
`requestAction`. An undeclared capability throws inside the sandbox and the host
shows a one-time “Vial permission denied” toast; the Vial must declare every
capability it calls in `vial.json`. `getSeries()` returns the host-applied window, including the
baseline-relative `response.values` the profile declares; `getSnapshot()`
returns channel health, per-channel limits (`cv`, `dead`, `r0`), the baseline,
and the host's detection verdict. Neither hands the Vial a way to change them.

---

## The live-data and logging contract

The host does the signal math; the Vial reads the result. Never recompute a
baseline or a response from `getLiveReadings()` when `getSeries()` already
carries one — the profile is the single source of truth, and a second hidden
baseline will disagree with the detector.

### `getSeries()` — the window the profile produced

```js
{
  source: 'live' | 'recording',   // change calls only when 'live'
  timeUnit: 's',                  // seconds from the start of the window
  time: [0, 0.1, 0.2, ...],
  channels: ['MQ-135', ...],
  values:   [[2100, 2104, ...], ...],   // conditioned raw
  response: {                     // present when the profile declares it
    kind: 'delta-over-r0',
    values: [[0.001, 0.004, ...], ...]
  },
  fingerprint: [0.02, -0.01, ...], // latest per-channel response
  label: 'live'
}
```

- `time` is **seconds**, including when the link is live. It is not a sample
  index. `timeUnit` is explicit; test it rather than assuming.
- `response.values[i]` is already `(value − R0) / R0` as declared by the
  profile. Plot it as a fraction, not a concentration.
- `source === 'recording'` means a stored buffer. You may inspect it; you must
  withhold any "changed now" call.
- A missing/`null` value is not zero. Skip it.

### `getSnapshot()` — health, limits, and the host verdict

```js
{
  channels: [{ id: 'ch0', label: 'MQ-135', health: 'ok' }, ...],
  channelLimits: {
    ch0: { cv: 0.012, dead: false, r0: 2100 }
  },
  baseline: { state: 'warming' | 'ready' | 'none', progress: 0.4 },
  detection: { active: false, admissible: true, reason: '' },
  environment: { temperature: 22.4, humidity: 41.0 }
}
```

`cv` is `std / |mean|` of that channel's raw window. The honest noise band is
`max(0.005, 2 * cv)`; the 0.5 % floor stops a suspiciously quiet window from
turning sensor noise into an event. A channel is out of service when
`channelLimits[id].dead` or `health` is `stuck`/`saturated`; exclude it rather
than reading it as a flat line.

A defensible change call is: the response stays beyond the band for **at least
60 % of the recent 30 %** of samples, on a live source with a ready baseline.
A single excursion is handling, a door, or a draft. Withhold the call when the
enclosure moved (both examples use 1.5 °C / 5 %RH for a plant and 2 °C / 8 %RH
for a vessel) or when `detection.admissible === false`.

### Journal, export, and persistence

- `logEvent(type, message, data)` writes one JSON event. Types are free-form;
  the shipped examples use `care`, `context`, `session`, `phase`, `array-phase`,
  `disagreement`, `reference`, and `batch`.
- `getEvents(limit)` reads the journal (newest last). On a fresh page the local
  cache is empty, so it asks the host; this works with no params.
- `exportJournal('csv' | 'json')` returns text. For a real file, prefer
  `requestAction('journal-download', { format: 'csv' })`; the host creates the
  download and names it from the pack id.
- `persist(key, value)` / `retrieve(key)` store JSON per Vial (16 KB per value)
  in the app data directory, with a localStorage fallback. They survive a UI
  reload and a UI update. There is no cross-Vial store.
- The journal survives a reload (disk on the desktop, localStorage in the
  browser/dev build). It is capped at 2000 events.

### `requestAction` — the host actions a Vial can ask for

`get-source`, `get-sources`, `open-dashboard`, `open-datasets`, `open-smells`,
`open-gallery`, `open-vials`, `open-workspace`, `open-check`, `export-log`,
`toast`, `journal-events`, `journal-export`, `journal-download`.

`requestAction(name)` with no params is valid (`params` defaults to `null`).
Declare `action:request` in `capabilities` or the call throws.

### Patterns worth copying

- **Reference snapshot** (`fermentation-lab`): capture
  `{ level, noise, phase, channels, at }` from a clean live window, store it
  with `persist('reference', …)`, and refuse the comparison when the live
  channel set no longer matches. A reference is this array's own past response,
  not a lab blank and not comparable across rigs.
- **Batch lifecycle** (`fermentation-lab`): a `status` field
  (`active` / `completed` / `archived`) stored via `save-field`. Closing a
  batch blocks new readings, stops phase journaling, and keeps the log and
  export readable. Reopening is an explicit status change, logged as an event.
- **Diurnal comparison** (`plant-respiration`): save sessions with the clock
  hour and per-channel response, then compare only against sessions within
  ±2 h of the current time and older than 5 minutes. A different time of day is
  a different measurement.
- **Unified journal**: `getEvents()` is the record; render it with a type
  filter and export the same rows. Do not keep a second private log.

`node scripts/vial-e2e.mjs` is the reference proof: it drives both example
Vials through add-reading, reference, close-batch, care, session, export, and
reload, asserting the journal and persisted state survive.

---

## The profile

The `anomaly` block is the program. At minimum:

```json
{
  "baseline": { "protocol": "first-n", "warmupS": 60, "r0WindowS": 10 },
  "transforms": { "conditioning": ["median3"], "response": "delta-over-r0" },
  "detection": {
    "enabled": true,
    "sensitivity": 1,
    "minChannels": 2,
    "levelBudget": 0,
    "levelRefS": 0,
    "alertThreshold": 0.5,
    "perChannelLimits": {},
    "hysteresis": 0.2,
    "escalation": {
      "warningS": 30,
      "criticalS": 120,
      "emergencyS": 300,
      "resetNormalS": 300
    },
    "farTargetPerMonth": null
  },
  "admissibility": { "requireBaseline": "ready", "minCoverage": 0.8 }
}
```

Use the measured single-unit noise floor for `perChannelLimits` and state a
false-alarm budget you can defend (`farTargetPerMonth`). `warningS` is the
persistence lever; `hysteresis` keeps a state from chattering around a limit.
`minChannels` is corroboration: one noisy channel is not enough. The host
refuses to arm when the baseline is not ready, channel coverage is below
`minCoverage`, or fewer than `minChannels` declared channels are live and
non-dead. A dead channel is a refusal, not a zero.

### What each lever does

| Field | Range | Meaning |
|---|---|---|
| `baseline.protocol` | `first-n`, `session-mean` | How R0 is chosen. `first-n` uses the early clean window; `session-mean` uses a recorded session mean. |
| `baseline.warmupS` | 0.5–86400 s | Clean time before the host trusts a baseline. Too short turns switch-on drift into an event. |
| `baseline.r0WindowS` | 0.5–3600 s | Early samples averaged into R0. Must not exceed `warmupS`. |
| `transforms.conditioning` | `["median3"]` | The only supported filter. Use it for a spiky MOX channel; leave it empty when you need raw timing. |
| `transforms.response` | `delta-over-r0`, `relative`, `delta` | The response the UI receives. `delta-over-r0` is a fraction of the reference; `delta` keeps raw counts. |
| `detection.sensitivity` | 0.1–10 | Higher flags smaller deviations. Above ~2 a quiet array starts calling sensor noise. |
| `detection.minChannels` | 1–32 | Corroboration. For a multi-channel array, 2 is the honest minimum; 3 is better. |
| `detection.levelBudget` | 0–12 σ | Level-anchored threshold in calibrated sigma. `0` disables the level leg and leaves only the change leg. |
| `detection.levelRefS` | 0–86400 s | Rolling reference for the level leg. Requires `levelBudget > 0`. |
| `detection.alertThreshold` | 0–1 | Confidence floor for a channel-level alert. |
| `detection.perChannelLimits` | `{"ch0": 0.03, …}` | Absolute response limit per channel, in transformed units. Leave it empty **only** when the UI judges against its own `2 × cv` band, as both examples do. |
| `detection.hysteresis` | 0–0.95 | How far the signal must fall below its peak before clearing. Stops chatter at the limit. |
| `escalation.warningS` / `criticalS` / `emergencyS` | seconds, ascending | How long the condition must persist for each rung. These are latency promises, not decoration. |
| `escalation.resetNormalS` | seconds | Quiet time required to return to normal. |
| `detection.farTargetPerMonth` | `null` or a number | Your deployment false-alarm budget. `null` is honest when you have not measured it; it also means the profile claims no budget. |
| `admissibility.requireBaseline` | `ready`, `any` | `ready` refuses to arm during warm-up. |
| `admissibility.minCoverage` | 0–1 | Fraction of declared channels that must be live and non-dead. |

Two rules follow from this:

1. **A channel's noise is not the same as the process noise.** Measure `cv` on
   the actual rig, in the actual enclosure. A profile copied from another array
   has not been measured on yours.
2. **Persistence is part of the claim.** A one-second excursion and a
   sixty-second one are different findings. If you set `warningS` below a
   second, say so in the Vial's limits.

### Ungated and Gated

A v2 Vial without an `evidence` block installs as **Ungated**. It runs, it
keeps its log, and it must not claim a measured false-alarm rate. Both shipped
examples are deliberately Ungated: no measured held-out numbers exist yet, and
inventing them is forbidden.

**Gated** (and eligible for listing) needs all critical policy checks, at least
one declarative fixture, real measured `evidence.metrics`, a real
`evidence.reportUrl`, and manual approval through `/admin`. Approval is human;
the app never converts a grade into a safety permission. Payments are deferred;
nothing is charged for a listing.

---

## Evidence (never invent a number)

A v2 listing needs:

- `evidence.grade`: `A`, `B`, `C`, or `D`.
- `evidence.reportUrl`: an HTTPS URL to a real held-out report.
- `evidence.measuredAt`: an ISO date.
- `evidence.dataset`: the corpus, rig, unit count, sessions, and preparation.
- `evidence.metrics`: at least one measured number (`farPerMonth`, `latencyS`,
  `mde`, `nSamples`, `nAlarms`). Never invent a number.
- `evidence.fixtures`: at least one `fixtures/<name>.json` case with an expected
  final state (`normal`, `warning`, `critical`, or `emergency`).

`npm run validate:vial` checks the static surface: fixture paths exist, the
manifest is well-formed, the profile values are in range, and no unnegated
overclaim language appears (`safe to eat`, pathogen detection, diagnosis,
ethylene detection, concentration, cross-rig, guarantee, medical, safety
verdict). It does not run the live detector; the app is the live proof.

A grade describes the evidence. It is not a safety certification and the host
never converts it into permission.

---

## Install, update, and review

Every install is:

1. Fetch the manifest over HTTPS (localhost allowed for development).
2. Parse it and run the local gate.
3. Fetch each declared UI asset and verify it.
4. Save the pack and install it.

A mismatch leaves the previous copy untouched. Updates use the same path and are
manual and hash-verified.

To submit a listing:

1. Push the project. The manifest must be at the repo root, and `ui.html`,
   `home.html`, and `fixtures/` beside it.
2. Confirm the raw URLs serve exactly the bytes you tested.
3. Submit the manifest URL. The server re-runs the gate, hashes the manifest,
   every UI asset, and every fixture, and opens a review queue issue.
4. A reviewer approves the issue in `/admin`. The server re-fetches and re-hashes;
   changed bytes are refused. Approval commits the registry.
5. Installing or updating verifies the pinned bytes.

There is no manual registry edit in the normal path.

---

## v1 vs v2

- `osmograph.domain-pack/2` is the v2 contract. It requires `anomaly` and
  `evidence`, and uses positive `scope` + `limits`. Required for a Gated listing.
- `osmograph.domain-pack/1` remains installable as a legacy manifest. It displays
  as **Ungated**. New listings require v2; a legacy entry stays visible until it
  is re-authored.
- `osmograph.vial/1` is retired.

`npm run validate:vial` reports **PASS** when the install gate passes and
**PASS (Ungated)** when it passes but the Vial is not Gated (for example, v2
without real evidence and fixtures, or v1). A vial that does not pass cannot be
installed.