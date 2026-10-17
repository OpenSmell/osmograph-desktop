// Catalog of real, public smell/gas-sensor datasets.
//
// PURPOSE — three things at once:
//   1. Utility: give a user with no hardware something real to explore on day one.
//   2. Rigour: cover several SENSOR TYPES (MOX, MEMS, electrochemical, GC-MS, odor),
//      so the app's per-type profiles are shaped by real data, not guesses.
//   3. Legal safety: show the license up front and link (never silently rehost).
//
// LICENSE RULES (see private/DATA_AND_LICENSING.md):
//   - `commercial: 'yes'`   → safe to bundle/rehost with attribution.
//   - `commercial: 'check'` → license is ambiguous (e.g. UCI's donor text contradicts
//                             its CC BY 4.0 field) → LINK ONLY until clarified.
//   - `commercial: 'no'`    → non-commercial / all-rights-reserved → LINK ONLY.
//   - `commercial: 'api'`   → usable via API under terms (attribution + key), don't rehost.
//
// We deliberately do NOT hardcode download URLs for anything but clearly-permissive
// sources. Restrictive datasets open in the browser so the user fetches under the
// source's own terms.

export type DatasetCommercial = 'yes' | 'no' | 'check' | 'api';

export interface DatasetEntry {
  id: string;
  name: string;
  /** What physical sensing technology this covers — drives per-type support. */
  sensors: string;
  /** Rough size, so users know what they're getting into. */
  size: string;
  /** SPDX-ish license label, shown verbatim to the user. */
  license: string;
  /** Can this be used commercially / rehosted? */
  commercial: DatasetCommercial;
  /** Who to credit (creators / maintainers). */
  credit: string;
  /** Canonical source page (always link here, never a mirror we made). */
  url: string;
  /** One honest sentence: what it contains AND its limits. */
  note: string;
}

export const DATASET_CATALOG: DatasetEntry[] = [
  {
    id: 'smellnet',
    name: 'SmellNet (MIT)',
    sensors: 'MOX + MEMS (BME680, MQ-3/5/9, WSP2110, MP503)',
    size: '828k time steps · 68 h',
    license: 'MIT',
    commercial: 'yes',
    credit: 'Feng, Liang et al., MIT Media Lab',
    url: 'https://github.com/MIT-MI/SmellNet',
    note: '50 substances + 43 mixtures with GC-MS priors. The strongest day-one dataset and it spans two sensor types at once.',
  },
  {
    id: 'mendeley-bme688-iaq',
    name: 'IoT Indoor Air Quality (BME688)',
    sensors: 'MEMS/CMOS (BME688) + MQ135 + PM',
    size: '1,500 observations',
    license: 'CC BY 4.0',
    commercial: 'yes',
    credit: 'Mendeley Data 10.17632/5c2fwppsvs.1',
    url: 'https://data.mendeley.com/datasets/5c2fwppsvs/1',
    note: 'Indoor air-quality events on a modern CMOS gas sensor — the second sensor type we must shape around.',
  },
  {
    id: 'uci-224',
    name: 'UCI Gas Sensor Array Drift',
    sensors: 'MOX (16× Figaro TGS2600/2602/2610/2620)',
    size: '13,910 samples · 36 months',
    license: 'CC BY 4.0 field ⚠ / donor text says research-only',
    commercial: 'check',
    credit: 'Vergara et al. (UCI 224)',
    url: 'https://archive.ics.uci.edu/dataset/224/gas+sensor+array+drift+dataset',
    note: 'The classic drift benchmark. License is contradictory on UCI\u2019s own page — link only until clarified. Note: baseline alone predicts the gas; strip drift and accuracy collapses.',
  },
  {
    id: 'uci-361',
    name: 'UCI Twin Gas Sensor Arrays',
    sensors: 'MOX (5 identical arrays × 8 TGS)',
    size: '640 experiments',
    license: 'CC BY 4.0',
    commercial: 'check',
    credit: 'Fonollosa et al. (UCI 361)',
    url: 'https://archive.ics.uci.edu/dataset/361/twin+gas+sensor+arrays',
    note: 'Five copies of the same array — the set for cross-device / session-invariance research. Critical for our transfer claims.',
  },
  {
    id: 'uci-270',
    name: 'UCI Drift at Different Concentrations',
    sensors: 'MOX (16 Figaro)',
    size: '13,910 samples',
    license: 'CC BY 4.0 field ⚠ / donor text says research-only',
    commercial: 'check',
    credit: 'Vergara et al. (UCI 270)',
    url: 'https://archive.ics.uci.edu/dataset/270/gas+sensor+array+drift+dataset+at+different+concentrations',
    note: 'Adds concentration labels to the drift data — useful for quantification work.',
  },
  {
    id: 'uci-322',
    name: 'UCI Dynamic Gas Mixtures',
    sensors: 'MOX (16 Figaro)',
    size: '~4.2M instances',
    license: 'CC BY 4.0',
    commercial: 'check',
    credit: 'Fonollosa et al. (UCI 322)',
    url: 'https://archive.ics.uci.edu/dataset/322/gas+sensor+array+under+dynamic+gas+mixtures',
    note: 'Long continuous mixtures — good for change-detection and kinetics study.',
  },
  {
    id: 'uci-251',
    name: 'UCI Open Sampling (72 MOX)',
    sensors: 'MOX (72 sensors, 6 locations)',
    size: '18,000 series',
    license: 'CC BY 4.0 field ⚠ / donor text says research-only',
    commercial: 'check',
    credit: 'Vergara et al. (UCI 251)',
    url: 'https://archive.ics.uci.edu/dataset/251/gas+sensor+arrays+in+open+sampling+settings',
    note: 'Big arrays in open (non-sealed) sampling — closer to real deployments than wind-tunnel data.',
  },
  {
    id: 'uci-360',
    name: 'UCI Air Quality',
    sensors: 'MOX (5× tin/tungsten/indium oxide)',
    size: '9,358 hourly',
    license: 'CC BY 4.0 field ⚠ / donor text says research-only',
    commercial: 'check',
    credit: 'De Vito et al. (UCI 360)',
    url: 'https://archive.ics.uci.edu/dataset/360/air+quality',
    note: 'Field air-quality monitoring with humidity/temperature — the realistic confounders.',
  },
  {
    id: 'openaq',
    name: 'OpenAQ',
    sensors: 'Electrochemical / reference AQ',
    size: 'Continuous, global',
    license: 'CC BY 4.0 (API terms)',
    commercial: 'api',
    credit: 'OpenAQ + original station operators',
    url: 'https://docs.openaq.org',
    note: 'Real-world electrochemical/air-quality data via API (key required; dual attribution). We do not rehost it.',
  },
  {
    id: 'mona',
    name: 'MassBank of North America',
    sensors: 'GC-MS / EI spectra',
    size: 'Large record set',
    license: 'CC BY 4.0 (per-record licenses vary)',
    commercial: 'check',
    credit: 'MoNA / Fiehn Lab, UC Davis',
    url: 'https://mona.fiehnlab.ucdavis.edu',
    note: 'Spectra for linking sensor responses to chemistry — check each record\u2019s license before reuse.',
  },
  {
    id: 'pyrfume',
    name: 'Pyrfume',
    sensors: 'Odor / psychophysics (molecular)',
    size: '>20,000 odorants · ~50 archives',
    license: 'Per-archive (many non-commercial)',
    commercial: 'check',
    credit: 'Gerkin & Mainland et al.',
    url: 'https://pyrfume.org',
    note: 'The bridge from chemistry to perceived smell (CID/SMILES join). Honors each archive\u2019s own license — never launder NC data.',
  },
  {
    id: 'dravnieks',
    name: 'Dravnieks Odor Atlas (ASTM DS61)',
    sensors: 'Human odor descriptors',
    size: '160 chemicals · 146 descriptors',
    license: '© ASTM — no redistribution',
    commercial: 'no',
    credit: 'Dravnieks, ASTM DS61',
    url: 'https://store.astm.org/ds61-eb.html',
    note: 'The canonical odor descriptor set. Link and cite only — never bundle.',
  },
  {
    id: 'nist-webbook',
    name: 'NIST Chemistry WebBook',
    sensors: 'Reference spectra & properties',
    size: 'Reference data',
    license: 'US SRD — link only',
    commercial: 'no',
    credit: 'NIST SRD 69',
    url: 'https://webbook.nist.gov',
    note: 'Authoritative reference values. Link only; redistribution needs a separate agreement.',
  },
];
