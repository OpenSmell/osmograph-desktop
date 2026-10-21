# Authoring a Vial

A **Vial** is a reusable, local-first way of working. There are two kinds:

| Kind | Schema | What it carries | How it is authored today |
|---|---|---|---|
| Decision Vial | `osmograph.vial/1` | A closed-set, same-array comparison with evidence, limits, and a method | Package a saved Check in **Vials → Decisions** |
| Domain Vial | `osmograph.domain-pack/1` | A protocol, log, risk model, decision rules, field notes, citations, and a host-rendered workspace | Write or generate a `.vial.json` manifest and import it |

This document is about **domain Vials**, the kind that turns domain knowledge into a workspace. They are separate from the application binary: a `.vial.json` file can be exported, inspected, versioned, shared, and imported on another installation. They are **not** executable plugins. The host renders a fixed vocabulary of declarative widgets. No third-party JavaScript runs in the app.

> **Stage 1 contract.** A domain Vial is data. The host owns the renderer. This is why importing a Vial is safe enough to offer as a file action today. A direct **Install from URL** fetches a single `.vial.json` manifest over HTTPS and runs the same local policy gate; it does not execute remote code. A hosted registry feed, signatures, revocation, automatic updates, and a sandboxed code runtime are **not** implemented. Do not describe them as if they are.

---

## Quick start

1. Open **Vials → Aromatory**.
2. Click **Export** on an official pack to get a complete example, or **Starter template** for a minimal one.
3. Edit the JSON. Change the `id`, `author`, `license`, claims, citations, and workspace content.
4. Validate without launching the app:

   ```bash
   npm run validate:vial -- examples/community-workspace.vial.json
   ```

5. Import the file in **Aromatory → Import .vial.json**, or host it in your own GitHub repo and use **Aromatory → Install from URL** with the raw HTTPS URL.
6. Install it, open the workspace, add a reading, and check that every widget renders.
7. Export it again, re-import it on a second installation, and inspect the result.
8. Share the manifest with the author, licence, evidence, and “what it is not” attached.

The runnable example is [`examples/community-workspace.vial.json`](examples/community-workspace.vial.json). It passes the local gate.

### Personal GitHub, without another registry repo

A Vial does not need its own package or registry repository. Put the manifest in any repo you already control:

```text
https://raw.githubusercontent.com/<you>/<repo>/main/<vial>.vial.json
```

Paste that raw URL into **Vials → Aromatory → Install from URL**. The app checks HTTPS, fetches a single manifest, runs the local gate, and records the source host in the installed pack. The manifest stays in your repo.

The public [Aromatory page](https://www.opensmell.xyz/vials) is a discovery list, not a trust seal. To list a Vial there, add one entry to the existing `opensmell-web/public/vials/registry.json` file. You do not need a new repository, an npm release, or a server. A listing is not review or endorsement.

---

## What “separate” means

- **The manifest is separate.** It is a JSON file with its own version, author, licence, citations, and content. You can keep it in Git, attach it to an issue, or hand it to another rig owner.
- **The renderer is shared.** The host draws the workspace from the widget vocabulary below. A domain Vial cannot ship custom HTML, CSS, or JavaScript in Stage 1.
- **The log is local.** Installing a Vial stores the manifest in local storage and creates a local log. The log is not uploaded by the app. Deleting a community pack removes the pack and its local log on this installation.
- **“Official” is first-party.** Only packs shipped in the app source are labelled Official. Imported packs are always treated as **Community**, even if their JSON says `"tier": "official"`. The `official.*` id namespace and the `@opensmell` author handle are reserved.

| Label | Meaning | Not a claim of |
|---|---|---|
| **Official** | First-party pack shipped with Osmograph | Correctness, safety, regulatory approval, or endorsement |
| **Community** | Authored outside the first-party set; passed the local import gate | Peer review, endorsement, or a security audit |
| **Sealed** (decision Vials) | The saved evidence passed the local decision-Vial gate | External validation or cross-rig transferability |
| **Open** (decision Vials) | The evidence did not clear the gate | “Broken”; it means unusable for a decision |

---

## Manifest shape

```json
{
  "schema": "osmograph.domain-pack/1",
  "id": "community.example-coffee-roast",
  "name": "Coffee Roast Log",
  "version": "0.1.0",
  "author": "@example-author",
  "license": "CC-BY-4.0",
  "tier": "community",
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
| `id` | Lowercase, 3–80 characters, `[a-z0-9._-]`. Must be unique. Do not use `official.*`. |
| `name` | 2–80 characters. |
| `version` | Semver, for example `0.1.0`, `1.2.0-beta.1`. |
| `author` | Credit a person or handle, 2–80 characters. `@opensmell` is reserved. |
| `license` | An SPDX id or a licence URL. Do not publish a pack whose content you cannot license. |
| `risk` | `low`, `medium`, `high`, or `critical`. See below. |
| `domain` | The domain or practice, for example `fermentation`, `plants`, `coffee`. |
| `tagline` | 4–160 characters. One honest line about the workspace. |
| `summary` | 30–600 characters. Explain the scope. |
| `whatItIs` | At least 30 characters. The useful claim or protocol. |
| `whatItIsNot` | At least 30 characters and must contain an explicit refusal (`not`, `cannot`, `no`, `never`, `without`, or `refuse`). |
| `citations` | At least one reference, each at least 10 characters. Real references, not “trust me”. |
| `docs` | At least two sections, each with a title and body text. High/critical risk packs need at least three. |

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
  "note": "Community domain Vial · declarative · host-rendered · no executable code"
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

On import, the local gate coerces the manifest, forces `tier` to `community`, and runs these checks. Critical failures reject the import; warnings do not.

| Check | Critical? | What it means |
|---|---|---|
| Schema | yes | The file declares `osmograph.domain-pack/1`. |
| Id | yes | Stable, lowercase, unique, not `official.*`. |
| Name | yes | 2–80 characters. |
| Version | yes | Semver. |
| Author | yes | Present; not the reserved `@opensmell` handle. |
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
| No executable/remote UI | yes | No `<script>`, `<iframe>`, `<object>`, `<embed>`, `<img>`, `<link>`, `javascript:`, inline handlers, or `data:text/html`. |
| No overclaim language | yes | No unnegated safety-device, safety-verdict, pathogen, diagnosis, ethylene, universal-ID, concentration/ppm, cross-rig, any-rig, guarantee, or medical claim. |

The overclaim check is **heuristic**. It looks for known phrases and allows them when the same sentence contains a negation. It is not a semantic proof. A cleverly worded overclaim can still pass, and that is why community packs are not endorsed just because they pass.

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

- **No executable code.** The manifest is data. The host does not `eval`, import, or run it.
- **No remote UI.** The gate rejects common embedded-resource and script patterns. The renderer escapes every field, so text is text. A URL install fetches the manifest itself; it does not load remote CSS, images, fonts, or scripts into the workspace.
- **No telemetry.** Importing, installing, and logging are local actions. The app does not upload a pack or its log. A URL install makes the one outbound request needed to fetch the manifest you named.
- **No silent identity.** Imported packs are community. The `official.*` namespace and `@opensmell` handle are reserved.
- **Local storage.** Custom packs live under `osmograph.domain.packs.v1`; install state under `osmograph.domain.installed.v1`; logs under `osmograph.domain.state.v1`. A URL-installed pack keeps its `sourceUrl` in the manifest. Delete a community pack to remove the pack and its log on this installation.
- **Export is explicit.** The export button writes the manifest. It does not include the local log.

The local gate is not a security boundary for arbitrary code, because no arbitrary code is accepted in Stage 1. It is a content and policy gate. A future Stage 2 with sandboxed code would need a different security model: permissions, isolation, signing, revocation, and a threat model that treats third-party code as hostile.

---

## Vibe-coding a domain Vial

You can use an LLM to draft a manifest. Give it the constraints, not just the idea. A useful prompt:

> Write a complete `osmograph.domain-pack/1` JSON manifest for a **community** domain Vial about **[domain/task]**. It must be declarative data, not code. Use only the widget types `hero`, `risk`, `metrics`, `detector`, `diagram`, `timeline`, `tracking`, `chart`, `rules`, `checklist`, `docs`, and `rig`. Include `hero`, `risk`, `docs`, `rig`, and at least one of `tracking`, `diagram`, or `rules`. Use `art: "generic"` unless the domain is fermentation or plants. State a real `risk` level, at least two citations, at least three docs, and an explicit `whatItIsNot` that refuses the most tempting overclaim. Do not claim universal smell ID, absolute concentration, cross-rig transfer, pathogen detection, ethylene detection, diagnosis, safety, or guaranteed performance. Do not include HTML, JavaScript, URLs as resources, base64, or remote images. Every field must be plain text. The workspace should help a practitioner record context, inspect a change, and stop when the primary measurement says stop. After writing it, list the claims that still need evidence.

Then run the validator, import it, and read the rendered workspace. A model can produce plausible domain text; it cannot produce your evidence. Treat the draft as a scaffold, not a source.

---

## Submission and review

There is **no hosted marketplace, signed registry, or account system**. The submission unit is the `.vial.json` file. Direct URL install is implemented; the [Aromatory page](https://www.opensmell.xyz/vials) is a discovery list. To propose a community pack:

1. Host the manifest in your own repository and validate it locally.
2. Open a pull request that adds one registry entry to `opensmell-web/public/vials/registry.json`, or open an issue with the raw URL.
3. Include the author, licence, domain, risk level, citations, and the exact “what it is not”.
4. State what you tested: import, install, log entry, export, re-import, and deletion.
5. Explain who the pack is for and what decision it supports.
6. Disclose any data, images, or text you did not author, and confirm you have the right to license it.
7. Do not claim official status, clinical validation, safety certification, or endorsement.

Review is editorial and policy-focused: identity, licence, citations, scope, risk framing, forbidden claims, and whether the workspace is useful. It is not a laboratory validation of your domain claim. A listing is not a trust seal. A pack can be useful and still be wrong; the docs and limits are how a user sees that.

---

## Known limits of this authoring stage

- Direct HTTPS install of a single manifest, but no registry feed, marketplace, payments, signatures, revocation, or automatic updates.
- No third-party JavaScript, custom HTML/CSS, custom images, or remote assets.
- No custom widget types beyond the vocabulary above.
- No per-pack permissions or sandboxed iframe runtime.
- No identity verification beyond the author string.
- No server-side validation; the gate runs locally.
- No migration system for pack data beyond the local schema version.
- No cross-rig calibration story. A pack that implies one is overclaiming.
- The local gate is heuristic. Passing it is necessary, not sufficient, for trust.

If you need one of these, say so in the issue. Do not quietly simulate it in the manifest.

---

## Related documents

- [`GUIDE.md`](GUIDE.md) — the public field guide: claim ladder, Check, Vials, data, privacy, limits, glossary.
- [The Aromatory](https://www.opensmell.xyz/vials) — the public Vial discovery page and registry JSON.
- [`NOTICE.md`](NOTICE.md) — attribution, dataset licences, and what is linked versus rehosted.
- [`examples/community-workspace.vial.json`](examples/community-workspace.vial.json) — a complete, validated example.
- [`src/domainPacks.ts`](src/domainPacks.ts) — the schema, coercion, gate, and import/export implementation.
- [`src/guide.ts`](src/guide.ts) — the in-app field guide source.
