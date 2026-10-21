# NOTICE — third-party data, attribution, and what we link vs. rehost

Osmograph links to and (where permitted) bundles public smell / gas-sensor datasets.
We take licensing seriously. This file is the canonical attribution + policy record.
The in-app **Datasets** catalog (Smells → Datasets) shows the same license information
next to every source.

## Policy

- **We link, we do not silently rehost.** Restrictive or ambiguous datasets open in the
  browser so you fetch under the source's own terms.
- **We bundle only clearly-permissive data** (e.g. MIT, CC BY 4.0) with attribution.
- **Non-commercial data is never shipped in commercial builds.**
- **We credit creators, the source, and the license**, always.

## Datasets referenced (see `src/datasets.ts`)

| Dataset | Source | License | Handling |
|---|---|---|---|
| SmellNet | github.com/MIT-MI/SmellNet | MIT | bundled starter subset + link to full data |
| Food Freshness (Zenodo) | zenodo.org | CC BY 4.0 | one-click download with attribution |
| IoT Indoor Air Quality (BME688) | data.mendeley.com/datasets/5c2fwppsvs/1 | CC BY 4.0 | bundleable/downloadable, attributed |
| UCI Gas Sensor Array Drift (224) | archive.ics.uci.edu/dataset/224 | CC BY 4.0 field ⚠ / donor text "research-only" | **link only** until clarified |
| UCI Twin Gas Sensor Arrays (361) | archive.ics.uci.edu/dataset/361 | CC BY 4.0 | link only (pending UCI clarification) |
| UCI Drift @ diff. concentrations (270) | archive.ics.uci.edu/dataset/270 | CC BY 4.0 field ⚠ / research-only text | link only |
| UCI Dynamic Gas Mixtures (322) | archive.ics.uci.edu/dataset/322 | CC BY 4.0 | link only |
| UCI Open Sampling (251) | archive.ics.uci.edu/dataset/251 | CC BY 4.0 field ⚠ / research-only text | link only |
| UCI Air Quality (360) | archive.ics.uci.edu/dataset/360 | CC BY 4.0 field ⚠ / research-only text | link only |
| OpenAQ | docs.openaq.org | CC BY 4.0 (API terms) | API / link, dual attribution |
| MassBank of North America | mona.fiehnlab.ucdavis.edu | CC BY 4.0 (per-record varies) | link, per-record check |
| Pyrfume | pyrfume.org | per-archive (many non-commercial) | link; never launder NC data |
| Dravnieks Odor Atlas (ASTM DS61) | store.astm.org/ds61-eb.html | © ASTM — no redistribution | link only |
| NIST Chemistry WebBook | webbook.nist.gov | US SRD — link only | link only |

### SmellNet

Feng, Dai, Li, Pernigo, Wen & Liang (2026), *SmellNet: A Large-scale Dataset for
Real-world Smell Recognition*, ICLR 2026. Collected by the Multisensory
Intelligence Group at the MIT Media Lab and MIT EECS.

"MIT" in this table is the **software/data licence**, not an institutional
endorsement. The app bundles a 12-smell, 60-recording starter subset; the full
50-smell dataset is linked, not silently fetched.

**Never bundled:** Bosch BME AI-Studio / BSEC data (click-through, anti-viral terms),
ASTM DS61 raw content, Leffingwell/ASTM commercial databases, PurpleAir bulk data, and
anything with no license.

## Domain Vials and community manifests

Domain Vials are declarative `.vial.json` manifests. They are separate from the application binary
and can be exported, inspected, versioned, shared, imported, or installed from a raw HTTPS URL. They
are not executable plugins and cannot ship custom HTML, CSS, JavaScript, remote images, or other
remote resources in Stage 1.

### Official packs

The first-party **Anomaly Watch**, **Fermentation Lab**, and **Plant Respiration** packs are authored
for this project and published under **CC BY 4.0**. Their citations point to third-party work; a
citation is a reference, not a redistribution or an endorsement by the cited authors. The packs state
their own limits. They are not medical, food-safety, life-safety, or regulatory advice.

### Community packs

Each community manifest declares its own `author` and `license`. Importing a pack does not transfer
ownership, and the app does not relicense it. A community pack is always treated as **community** on
import, even if its JSON claims to be official. The `official.*` id namespace and the `@opensmell`
author handle are reserved for first-party packs.

The local import gate checks identity, licence, risk framing, required docs and citations, widget
shape, detector claims, executable/remote UI patterns, and known overclaim language. It is heuristic
and is **not** peer review, a security audit, or a validation of the domain claim. Passing the gate
is necessary, not sufficient, for trust. See [`AUTHORING.md`](AUTHORING.md) for the contract and
[`GUIDE.md`](GUIDE.md) for the public claim language.

If a community pack includes third-party data, text, or images, the author is responsible for the
right to redistribute them. Do not submit a manifest that rehosts restrictive data, scrapes a
commercial database, or removes attribution.

## Trademarks

Dataset and vendor names (ASTM, Bosch, Sensirion, PurpleAir, "The Good Scents Company"/
"tgsc", Leffingwell, NIST, Pyrfume, UCI) are referenced **descriptively only**. No
logos, no endorsement claims, no affiliation implied.

## Corrections

If you are a rights-holder and believe something here is wrong, open an issue and we
will act promptly. We would rather under-claim than damage anyone's rights or trust.
