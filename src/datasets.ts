// Curated catalog of public smell/gas-sensor datasets you can explore in the app.
//
// Design intent (see private/SMELL_OPERATIONS.md + FOUNDER_STRATEGY_DUMP.md):
//   * DISCOVERY, not legalese. A newcomer should read one card and know: what the
//     smells are, what's inside, and whether the app can just open it.
//   * NEVER empty. Something real is playable on day one, with no hardware.
//   * CURATED. We only surface datasets we can actually use (permissive or clearly
//     usable licences). Restrictive / contradictory-licence sources are kept out of
//     the browsable catalog entirely — see REFERENCE below.
//
// LICENSE RULES (private/DATA_AND_LICENSING.md):
//   - `commercial: 'yes'` → permissive / rehostable with attribution.
//   - anything else is NOT shown in the browsable catalog.

export type DatasetCommercial = 'yes' | 'no' | 'check' | 'api';

/** A directly fetchable file at the original source (never a mirror we host). */
export interface DatasetDownload {
  url: string;
  filename: string;
  /** Zip that must be extracted (CSVs pulled out) before import. */
  archive?: boolean;
  /** Advertised size in bytes, for the UI. */
  sizeBytes?: number;
}

/** How ready a dataset is to open, in plain terms the UI shows verbatim. */
export type DatasetFormat = 'ready' | 'converts' | 'raw';

export interface DatasetEntry {
  id: string;
  name: string;
  /** One plain-language sentence: what this data actually is. */
  what: string;
  /** What the sensors are, in human words. */
  sensors: string;
  /** Rough size, so users know what they're getting into. */
  size: string;
  /** Number of sensor channels, when known. */
  channels?: number;
  /** Number of distinct smells/substances/classes, when known. */
  smells?: number;
  /** Are the readings labelled with what the smell was? */
  labeled: boolean;
  /** Can the app open it as-is, or does it need conversion? */
  format: DatasetFormat;
  /** SPDX-ish licence label, kept for provenance (not shouted in the UI). */
  license: string;
  commercial: DatasetCommercial;
  /** Who to credit (creators / maintainers). */
  credit: string;
  /** Canonical source page (always link here, never a mirror we made). */
  url: string;
  /** One honest sentence: what it's good for AND its limits. */
  note: string;
  /** Present when the app can fetch it in one click (from the source). */
  download?: DatasetDownload;
}

/**
 * The browsable catalog — only datasets we can freely use and open.
 * Ordered so the most immediately playable, most legible thing is first.
 */
export const DATASET_CATALOG: DatasetEntry[] = [
  {
    id: 'food-freshness',
    name: 'Food Freshness E-Nose (Zenodo)',
    what: 'A cheap gas-array sensor watching food go off, sampled once a day — the classic freshness-monitoring shape, and small enough to fetch in one click.',
    sensors: 'MOX array (MQ-2 … MQ-9, MQ-135)',
    size: '10.3 MB (one zip)',
    channels: 8,
    labeled: true,
    format: 'converts',
    license: 'CC BY 4.0',
    commercial: 'yes',
    credit: 'Mahdian, Mehrab (2025), Zenodo',
    url: 'https://zenodo.org/records/17285312',
    note: 'Best first thing to open: one click, real spoilage dynamics, works with no hardware. The daily sampling means kinetics are coarse — it is about "how does this change over days", not fast responses.',
    download: {
      url: 'https://zenodo.org/api/records/17285312/files/Food-Freshness-E-Nose-Dataset.zip/content',
      filename: 'Food-Freshness-E-Nose-Dataset.zip',
      archive: true,
      sizeBytes: 10281838,
    },
  },
  {
    id: 'smellnet',
    name: 'SmellNet',
    what: 'Fifty pure odour substances plus 43 mixtures, sniffed by a mix of MOX and MEMS sensors over ~68 hours. The richest day-one dataset, spanning two sensor types.',
    sensors: 'MOX + MEMS (BME680, MQ-3/5/9, WSP2110, MP503)',
    size: '~828k time steps · 68 h',
    smells: 50,
    labeled: true,
    format: 'raw',
    license: 'MIT',
    commercial: 'yes',
    credit: 'Feng, Dai, Li, Pernigo, Wen & Liang (2026)',
    url: 'https://github.com/MIT-MI/SmellNet',
    note: 'The strongest set we have — with GC-MS priors, so responses can be tied back to chemistry. The bundled starter library is a 12-smell, 60-recording subset; the full 50-smell set is a separate clone/download. The app does not silently fetch it.',
  },
  {
    id: 'mendeley-bme688-iaq',
    name: 'IoT Indoor Air Quality (BME688)',
    what: 'Indoor air-quality events captured on a contemporary CMOS gas sensor (BME688) — a very different sensor family from the cheap MQ arrays.',
    sensors: 'MEMS/CMOS (BME688) + MQ135 + particulates',
    size: '1,500 observations',
    labeled: true,
    format: 'raw',
    license: 'CC BY 4.0',
    commercial: 'yes',
    credit: 'Siddique, Md Abubakar (2026), Mendeley Data',
    url: 'https://data.mendeley.com/datasets/5c2fwppsvs/1',
    note: 'Included to shape how the app reads a completely different sensor type. Small and labelled — good for trying the classifier, though modest in size.',
  },
];

/**
 * Kept for the research/rigour mission but deliberately NOT shown in the browsable
 * catalog: licences are restrictive, contradictory, or API-only. We do not put data
 * in front of newcomers that they cannot legally just use.
 */
export const REFERENCE_CATALOG: DatasetEntry[] = [
  {
    id: 'uci-224',
    name: 'UCI Gas Sensor Array Drift',
    what: 'The classic sensor-drift benchmark.',
    sensors: 'MOX (16× Figaro)',
    size: '13,910 samples · 36 months',
    labeled: true,
    format: 'raw',
    license: 'CC BY 4.0 field ⚠ / donor text says research-only',
    commercial: 'check',
    credit: 'Vergara et al. (UCI 224)',
    url: 'https://archive.ics.uci.edu/dataset/224/gas+sensor+array+drift+dataset',
    note: 'Licence is contradictory on UCI’s own page — excluded from the catalog until clarified. Note: baseline alone predicts the gas.',
    download: {
      url: 'https://archive.ics.uci.edu/static/public/224/gas+sensor+array+drift+dataset.zip',
      filename: 'gas-sensor-array-drift-dataset.zip',
      archive: true,
      sizeBytes: 9989262,
    },
  },
  {
    id: 'uci-361',
    name: 'UCI Twin Gas Sensor Arrays',
    what: 'Five copies of the same array.',
    sensors: 'MOX (5 identical arrays × 8 TGS)',
    size: '640 experiments',
    labeled: true,
    format: 'raw',
    license: 'CC BY 4.0',
    commercial: 'check',
    credit: 'Fonollosa et al. (UCI 361)',
    url: 'https://archive.ics.uci.edu/dataset/361/twin+gas+sensor+arrays',
    note: 'Cross-device / session-invariance reference. Not surfaced in the catalog.',
  },
  {
    id: 'openaq',
    name: 'OpenAQ',
    what: 'Global air-quality feeds.',
    sensors: 'Electrochemical / reference AQ',
    size: 'Continuous, global',
    labeled: true,
    format: 'raw',
    license: 'CC BY 4.0 (API terms)',
    commercial: 'api',
    credit: 'OpenAQ + original station operators',
    url: 'https://docs.openaq.org',
    note: 'API-only, key required, dual attribution. Not surfaced in the catalog.',
  },
  {
    id: 'pyrfume',
    name: 'Pyrfume',
    what: 'Chemistry → perceived smell.',
    sensors: 'Odor / psychophysics (molecular)',
    size: '>20,000 odorants · ~50 archives',
    labeled: true,
    format: 'raw',
    license: 'Per-archive (many non-commercial)',
    commercial: 'check',
    credit: 'Gerkin & Mainland et al.',
    url: 'https://pyrfume.org',
    note: 'Per-archive licences; never launder NC data. Not surfaced in the catalog.',
  },
  {
    id: 'dravnieks',
    name: 'Dravnieks Odor Atlas (ASTM DS61)',
    what: 'Canonical human odor descriptors.',
    sensors: 'Human odor descriptors',
    size: '160 chemicals · 146 descriptors',
    labeled: true,
    format: 'raw',
    license: '© ASTM — no redistribution',
    commercial: 'no',
    credit: 'Dravnieks, ASTM DS61',
    url: 'https://store.astm.org/ds61-eb.html',
    note: 'Link and cite only. Not surfaced in the catalog.',
  },
];
