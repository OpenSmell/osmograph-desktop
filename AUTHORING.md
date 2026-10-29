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