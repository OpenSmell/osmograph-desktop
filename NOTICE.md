# NOTICE — third-party data, attribution, and what we link vs. rehost

Osmograph links to and (where permitted) bundles public smell / gas-sensor datasets.
We take licensing seriously. This file is the canonical attribution + policy record.
The in-app **Datasets** catalog (System → Datasets) shows the same license information
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
| SmellNet | github.com/MIT-MI/SmellNet | MIT | bundleable, attributed |
| IoT Indoor Air Quality (BME688) | data.mendeley.com/datasets/5c2fwppsvs/1 | CC BY 4.0 | bundleable, attributed |
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

**Never bundled:** Bosch BME AI-Studio / BSEC data (click-through, anti-viral terms),
ASTM DS61 raw content, Leffingwell/ASTM commercial databases, PurpleAir bulk data, and
anything with no license.

## Trademarks

Dataset and vendor names (ASTM, Bosch, Sensirion, PurpleAir, "The Good Scents Company"/
"tgsc", Leffingwell, NIST, Pyrfume, UCI) are referenced **descriptively only**. No
logos, no endorsement claims, no affiliation implied.

## Corrections

If you are a rights-holder and believe something here is wrong, open an issue and we
will act promptly. We would rather under-claim than damage anyone's rights or trust.
