# Authoring a Vial

A **Vial** is a programmable anomaly app. It has three parts:

| Part | What it is | Who owns it |
|---|---|---|
| Profile | A v2 `anomaly` block: baseline, transforms, per-channel limits, min-channel corroboration, persistence, hysteresis, escalation, admissibility, and a false-alarm target. | The manifest. The host compiles it into a detector owned by this Vial. |
| Domain UI | Optional `ui.html` and `home.html` body fragments, or the host-rendered declarative workspace. | The author. It runs in a sandbox and cannot change the detector. |
| Evidence | A held-out report, measured metrics, citations, and declarative fixtures. | The author. Review checks the claim, not the screen. |

A folder of text and a screen is a description. The profile is what changes what the
instrument does. The host owns sampling, baseline health, detection, and every safety
refusal; the Vial owns the domain interpretation and the screen.

The website tutorials are the canonical authoring reference:
[`/docs/vials`](https://www.opensmell.xyz/docs/vials). This file is the repository
checklist.

---

## The loop

```bash
# 1. Scaffold a v2 project (from the opensmell-rs repository)
cargo run --bin noses -- new "Fermentation Lab" --publisher your-handle --domain fermentation
cd fermentation-lab

# 2. Write the profile, the evidence, and the domain UI
#    vial.json, ui.html, fixtures/step.json, EVIDENCE.md

# 3. Gate it locally
noses lint
noses test

# 4. Print the registry entry and the bytes to push
noses publish --repo https://github.com/you/fermentation-lab

# 5. Submit at https://www.opensmell.xyz/appstore
# 6. A reviewer approves it in /admin; the registry pins the hashes
# 7. Install or update from Aromatory
```

The desktop repository can also run the same host gate against a manifest or a
project directory:

```bash
npm run validate:vial -- ./vial.json
npm run validate:vial -- ./fermentation-lab
```

`noses lint` mirrors the host gate and adds the authoring checks (fixtures,
citations, panels, sandbox rules). The desktop is the authority at install. When
the two disagree, the host wins.

---

## Files

| Path | Required | Purpose |
|---|---|---|
| `vial.json` | yes | `osmograph.domain-pack/2`. The profile, the UI contract, and the evidence. |
| `ui.html` | optional | The workspace body fragment. Referenced by `ui.entry`. |
| `home.html` | optional | The compact Home fragment. Referenced by `homeUi.entry` and paired with a `home` block. |
| `fixtures/*.json` | for a listing | Declarative cases for `noses test`. Pinned at review. |
| `EVIDENCE.md` | for a listing | The held-out report at `evidence.reportUrl`. |
| `README.md` | yes | What the Vial does, how to install it, and the evidence path. |

A UI asset is a **body fragment**, not a document. It cannot contain `<!doctype>`,
`<html>`, `<head>`, or `<body>`, load an external script/style/image, use the
network, use browser storage, or evaluate strings as code. A v2 UI also cannot call
`osmograph.setDetection` or `osmograph.setTransforms`; the profile in the manifest
is the program. The host rejects these at install, not only at runtime.

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
    "perChannelLimits": { "ch1": 0.08, "ch2": 0.08 },
    "hysteresis": 0.2,
    "escalation": {
      "warningS": 30,
      "criticalS": 120,
      "emergencyS": 300,
      "resetNormalS": 300
    },
    "farTargetPerMonth": 1
  },
  "admissibility": { "requireBaseline": "ready", "minCoverage": 0.8 }
}
```

Use the measured single-unit noise floor for `perChannelLimits` and state a
false-alarm budget you can defend. `warningS` is the persistence lever; there is no
separate `persistenceS`. `hysteresis` keeps a state from chattering around a limit.
`minChannels` is corroboration: one noisy channel is not enough. A baseline from a
different array, enclosure, or sample path is not transferable without its own
calibration.

The host refuses to arm when the baseline is not ready, the channel coverage is
below `minCoverage`, or fewer than `minChannels` declared channels are live and
non-dead. A dead channel is a refusal, not a zero.

---

## Evidence

A v2 listing needs:

- `evidence.grade`: `A`, `B`, `C`, or `D`.
- `evidence.reportUrl`: an HTTPS URL to a real held-out report.
- `evidence.measuredAt`: an ISO date.
- `evidence.dataset`: the corpus, rig, unit count, sessions, and preparation.
- `evidence.metrics`: at least one measured number (`farPerMonth`, `latencyS`, `mde`,
  `nSamples`, `nAlarms`). Never invent a number.
- `evidence.fixtures`: at least one `fixtures/<name>.json` case with an expected
  final state.

`noses test` runs the declared state machine against the fixtures. It does not run
the live UKF/Kalman engine, sensor faults, or covariance; the app is the live proof.
A fixture that does not reproduce the declared behaviour is a finding, not a
formality.

A grade describes the evidence. It is not a safety certification and the host never
converts it into permission. A paid listing needs a held-out unit report; free and
experimental Vials may use held-out session evidence. State the scope and the
limits positively; do not add a `whatItIsNot` field.

---

## Install, update, and review

Every install is:

1. Fetch the manifest over HTTPS.
2. Parse it and run the local gate.
3. Verify the manifest sha256 pinned in the registry.
4. Fetch each declared UI asset and verify its pinned sha256.
5. Save the pack and install it.

A mismatch leaves the previous copy untouched. Updates use the same path; the
Aromatory shows **Update to vX** only when the registry pins a newer version. The
update is manual and hash-verified.

To submit:

1. Push the project. The manifest must be at the repo root, and `ui.html`,
   `home.html`, and `fixtures/` must be beside it.
2. Confirm the raw URLs serve exactly the bytes you tested.
3. Submit the manifest URL at `/appstore`. The server re-runs the gate, hashes the
   manifest, every UI asset, and every fixture, and opens a queue issue.
4. A reviewer approves the issue in `/admin`. The server re-fetches and re-hashes;
   changed bytes are refused. Approval commits `public/vials/registry.json`.
5. The next Aromatory open sees the entry. Installing or updating verifies the
   pinned bytes.

There is no manual registry edit in the normal path. A listing records a human
review of the claim and its evidence; the host still owns every refusal on install.

---

## Desktop compatibility

- `osmograph.domain-pack/2` is the v2 contract. It requires `anomaly` and
  `evidence`, and uses positive `scope` + `limits`.
- `osmograph.domain-pack/1` remains installable as a legacy manifest. It displays
  as **Ungated**. New listings require v2; a legacy entry remains visible until it is
  re-authored.
- `osmograph.vial/1` is a saved Separability decision record in the local Decisions
  tab. It stays local; a programmable DOMAIN Vial is a separate install.

Use `noses` for new work. The desktop's old scaffold script has been removed so
there is one authoring path.
