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
//   - `commercial: 'yes'` → importable with attribution.
//   - `check` / `no` → reference-only: show the source and terms, never import
//     or bundle. The UI labels these separately so breadth never looks like
//     permission.

export type DatasetCommercial = 'yes' | 'no' | 'check' | 'api';

/** A fetch from the original source (never a mirror we host). */
export interface DatasetDownload {
  /** `file` = one URL; `hf-tree` = a filtered Hugging Face repo; `batch` = explicit URL list. */
  kind?: 'file' | 'hf-tree' | 'batch';
  /** Single-file sources. */
  url?: string;
  filename?: string;
  /** Zip that must be extracted (CSVs pulled out) before import. */
  archive?: boolean;
  /** Hugging Face dataset repo, e.g. `DeweiFeng/SmellNet`. */
  repo?: string;
  /** Only paths under this prefix are fetched. */
  include?: string;
  /** Skip paths containing any of these fragments (indexes, manifests, …). */
  exclude?: string[];
  /** Folder under the local datasets directory. */
  destName?: string;
  /** Explicit multi-file sources. `filename` is the relative path on disk. */
  files?: Array<{ url: string; filename: string }>;
  /** Advertised size in bytes, for the UI. */
  sizeBytes?: number;
  /** Open size after extraction, when known. Helps a person judge the trade. */
  extractedBytes?: number;
  /** Number of tabular files the importer will create. */
  fileCount?: number;
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
  /** Human-readable licence link, shown beside the badge. */
  licenseUrl?: string;
  commercial: DatasetCommercial;
  /** Who to credit (creators / maintainers). */
  credit: string;
  /** Ready-to-paste attribution. Licences that require credit get this verbatim. */
  citation?: string;
  /** Canonical source page (always link here, never a mirror we made). */
  url: string;
  /** One concrete reason to fetch this: what you can do with it next. */
  useFor?: string;
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
    name: 'Food Freshness E-Nose',
    what: '59 CSV recordings of produce left to spoil across several days on a cheap 8-channel MOX array.',
    sensors: 'MOX (MQ-2 … MQ-9, MQ-135)',
    size: '10.3 MB zip · 38 MB open · 59 CSVs',
    channels: 8,
    smells: 10,
    labeled: true,
    format: 'converts',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    commercial: 'yes',
    credit: 'Mahdian, Mehrab · Zenodo (2025)',
    citation: 'Mahdian, M. (2025). Food Freshness E-Nose Dataset. Zenodo. https://zenodo.org/records/17285312',
    url: 'https://zenodo.org/records/17285312',
    useFor: 'Compare produce on the day it was stored vs later, animate the settled fingerprint, or build a recipe that removes the baseline drift.',
    note: 'Sampled across days, not seconds. Use it for slow spoilage trends, not fast response kinetics. Some files combine two or three fruits.',
    download: {
      url: 'https://zenodo.org/api/records/17285312/files/Food-Freshness-E-Nose-Dataset.zip/content',
      filename: 'Food-Freshness-E-Nose-Dataset.zip',
      archive: true,
      sizeBytes: 10281838,
      extractedBytes: 38005711,
      fileCount: 59,
    },
  },
  {
    id: 'smellnet',
    name: 'SmellNet · single substances',
    what: '300 CSV recordings of 50 whole kitchen substances, sniffed by a MOX + MEMS array over 50 hours.',
    sensors: 'MOX + MEMS (BME680, MQ-3/5/9, WSP2110, MP503)',
    size: '3.6 MB · 300 CSVs · 50 substances',
    channels: 6,
    smells: 50,
    labeled: true,
    format: 'ready',
    license: 'MIT',
    licenseUrl: 'https://github.com/MIT-MI/SmellNet/blob/main/LICENSE',
    commercial: 'yes',
    credit: 'Feng, Dai, Li, Pernigo, Wen & Liang (2026)',
    citation: 'Feng, Dai, Li, Pernigo, Wen & Liang (2026). SmellNet. MIT-MI. https://huggingface.co/datasets/DeweiFeng/SmellNet',
    url: 'https://huggingface.co/datasets/DeweiFeng/SmellNet',
    useFor: 'Download the real 50-substance sensor corpus, not a teaser subset. Compare foods and spices, test separability, and train a first classifier.',
    note: 'This is the complete single-substance sensor set from the source. The repository also contains GC-MS and mixture data; those are separate entries because they answer different questions.',
    download: {
      kind: 'hf-tree',
      repo: 'DeweiFeng/SmellNet',
      include: 'base_data/',
      destName: 'SmellNet-single',
      sizeBytes: 3644191,
      fileCount: 300,
    },
  },
  {
    id: 'smellnet-mixtures',
    name: 'SmellNet · mixtures',
    what: '538 recordings of two- and three-component odour mixtures, with the same sensor array and protocol as SmellNet.',
    sensors: 'MOX + MEMS (BME680, MQ-3/5/9, WSP2110, MP503)',
    size: '13.2 MB · 538 CSVs · 43 mixtures',
    channels: 6,
    smells: 43,
    labeled: true,
    format: 'ready',
    license: 'MIT',
    licenseUrl: 'https://github.com/MIT-MI/SmellNet/blob/main/LICENSE',
    commercial: 'yes',
    credit: 'Feng, Dai, Li, Pernigo, Wen & Liang (2026)',
    citation: 'Feng, Dai, Li, Pernigo, Wen & Liang (2026). SmellNet. MIT-MI. https://huggingface.co/datasets/DeweiFeng/SmellNet',
    url: 'https://huggingface.co/datasets/DeweiFeng/SmellNet',
    useFor: 'Study mixtures instead of single smells: test whether the array separates blends, and build a recipe that compares mixture fingerprints to their components.',
    note: 'Mixture labels are proportions (for example Almond20_Orange80), not concentrations in air. Do not read mixture class as a quantitative composition claim.',
    download: {
      kind: 'hf-tree',
      repo: 'DeweiFeng/SmellNet',
      include: 'mixture_data/',
      exclude: ['_index_'],
      destName: 'SmellNet-mixtures',
      sizeBytes: 13174660,
      fileCount: 538,
    },
  },
  {
    id: 'tadi-2019',
    name: 'TADI Methane Releases',
    what: 'Six low-cost MOX logger recordings of controlled methane releases, plus an anemometer, at the TADI test site.',
    sensors: 'MOX loggers + reference CH₄ + wind',
    size: '4.6 MB · 6 logger CSVs · 2019',
    channels: 4,
    smells: 1,
    labeled: true,
    format: 'converts',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    commercial: 'yes',
    credit: 'Gladston et al. · Zenodo (2023)',
    citation: 'Gladston, A. et al. (2023). Dataset for using metal oxide gas sensors for the estimate of methane controlled releases. Zenodo. https://doi.org/10.5281/zenodo.8399829',
    url: 'https://zenodo.org/records/8399829',
    useFor: 'Practise change detection and release-event annotation on real outdoor gas plumes. Compare logger response with the reference methane channel.',
    note: 'This is a controlled outdoor release, not a safety device or a leak detector. Logger files include weather columns; treat them as context, not smell channels.',
    download: {
      kind: 'batch',
      destName: 'TADI-2019',
      files: [
        { url: 'https://zenodo.org/api/records/8399829/files/Logger_A.csv/content', filename: 'Logger_A.csv' },
        { url: 'https://zenodo.org/api/records/8399829/files/Logger_C.csv/content', filename: 'Logger_C.csv' },
        { url: 'https://zenodo.org/api/records/8399829/files/Logger_D.csv/content', filename: 'Logger_D.csv' },
        { url: 'https://zenodo.org/api/records/8399829/files/Logger_E.csv/content', filename: 'Logger_E.csv' },
        { url: 'https://zenodo.org/api/records/8399829/files/Logger_F.csv/content', filename: 'Logger_F.csv' },
        { url: 'https://zenodo.org/api/records/8399829/files/Logger_H.csv/content', filename: 'Logger_H.csv' },
        { url: 'https://zenodo.org/api/records/8399829/files/sonic3d_anemometer.csv/content', filename: 'sonic3d_anemometer.csv' },
        { url: 'https://zenodo.org/api/records/8399829/files/Loggers_COLUMNS.txt/content', filename: 'Loggers_COLUMNS.txt' },
      ],
      sizeBytes: 4830000,
      fileCount: 7,
    },
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
  {
    id: 'mendeley-bme688-iaq',
    name: 'BME688 Indoor Air Quality',
    what: 'Indoor-air observations from a BME688 plus MQ-135 and particulate channels.',
    sensors: 'MEMS + MOX + PM',
    size: '1,500 observations',
    labeled: true,
    format: 'raw',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    commercial: 'yes',
    credit: 'Mendeley Data · 5c2fwppsvs',
    url: 'https://data.mendeley.com/datasets/5c2fwppsvs/1',
    note: 'Source-only until the importer has a tested mapping for this layout. Attribution required.',
  },
  {
    id: 'beef-spoilage',
    name: 'Beef Spoilage E-Nose',
    what: 'Twelve beef cuts measured minute-by-minute while they spoil, with TVC reference labels.',
    sensors: 'MOX (11× MQ)',
    size: '12 cuts · 2,220 min each',
    labeled: true,
    format: 'raw',
    license: 'CC0 1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    commercial: 'yes',
    credit: 'Wijaya et al. · Harvard Dataverse (2022)',
    url: 'https://doi.org/10.7910/DVN/XNFVTS',
    note: 'The source of record is a multi-sheet XLSX; convert to CSV before import. CC0, but keep provenance.',
  },
  {
    id: 'uci-146',
    name: 'UCI Drift at Different Concentrations',
    what: 'The 16-sensor drift benchmark at controlled concentration levels.',
    sensors: 'MOX (16× Figaro)',
    size: '13,910 samples · 36 months',
    labeled: true,
    format: 'raw',
    license: 'CC BY 4.0 field ⚠ / donor text says research-only',
    commercial: 'check',
    credit: 'Vergara et al. (UCI 146)',
    url: 'https://archive.ics.uci.edu/dataset/146/gas+sensor+array+drift+dataset+at+different+concentrations',
    note: 'Contradictory licence on the source page. Link only, research use, until UCI confirms in writing.',
  },
  {
    id: 'uci-270',
    name: 'UCI Drift at Different Concentrations (270)',
    what: 'The same drift experiment packaged as a separate UCI release.',
    sensors: 'MOX (16× Figaro)',
    size: '13,910 samples',
    labeled: true,
    format: 'raw',
    license: 'CC BY 4.0 field ⚠ / donor text says research-only',
    commercial: 'check',
    credit: 'Vergara et al. (UCI 270)',
    url: 'https://archive.ics.uci.edu/dataset/270/gas+sensor+array+drift+dataset+at+different+concentrations',
    note: 'Contradictory licence on the source page. Link only, research use.',
  },
  {
    id: 'uci-251',
    name: 'UCI Open Sampling System',
    what: 'A 72-sensor array recorded with an open sampling protocol.',
    sensors: 'MOX (72×)',
    size: '18,000 series',
    labeled: true,
    format: 'raw',
    license: 'CC BY 4.0 field ⚠ / donor text says research-only',
    commercial: 'check',
    credit: 'Fonollosa et al. (UCI 251)',
    url: 'https://archive.ics.uci.edu/dataset/251/gas+sensor+array+under+open+sampling+system',
    note: 'Large and useful for array design, but the licence text is contradictory. Link only.',
  },
  {
    id: 'uci-309',
    name: 'UCI Turbulent Gas Mixtures',
    what: 'Eight MOX sensors in a wind tunnel with ethylene, CO, and methane mixtures.',
    sensors: 'MOX (8× TGS)',
    size: '180 recordings · 3 gases',
    labeled: true,
    format: 'raw',
    license: 'CC BY 4.0 field ⚠ / donor text says research-only',
    commercial: 'check',
    credit: 'Fonollosa et al. (UCI 309)',
    url: 'https://archive.ics.uci.edu/dataset/309/gas+sensor+array+exposed+to+turbulent+gas+mixtures',
    note: 'The strongest public mixed-gas benchmark. Research-only until the licence is clarified.',
  },
  {
    id: 'uci-322',
    name: 'UCI Dynamic Gas Mixtures',
    what: 'Two 12-hour, 100 Hz recordings of changing ethylene/CO and ethylene/methane mixtures.',
    sensors: 'MOX (16× TGS)',
    size: '2 × 12 h · 100 Hz',
    labeled: true,
    format: 'raw',
    license: 'CC BY 4.0 field ⚠ / donor text says research-only',
    commercial: 'check',
    credit: 'Fonollosa et al. (UCI 322)',
    url: 'https://archive.ics.uci.edu/dataset/322/gas+sensor+array+under+dynamic+gas+mixtures',
    note: 'Excellent for transition and leak-event work. Very large; research-only.',
  },
  {
    id: 'uci-362',
    name: 'UCI Home Activity Monitoring',
    what: 'A home air-quality array with wine, banana, and background inductions.',
    sensors: 'MOX (8× TGS) + T/RH',
    size: '99 inductions · 928k rows',
    labeled: true,
    format: 'raw',
    license: 'CC BY 4.0 field ⚠ / donor text says research-only',
    commercial: 'check',
    credit: 'Huerta et al. (UCI 362)',
    url: 'https://archive.ics.uci.edu/dataset/362/gas+sensors+for+home+activity+monitoring',
    note: 'Good indoor-air context set. Research-only; not imported by default.',
  },
  {
    id: 'uci-360',
    name: 'UCI Air Quality',
    what: 'A long indoor air-quality record from a five-sensor MOX array.',
    sensors: 'MOX (5×)',
    size: '9,358 hourly records',
    labeled: true,
    format: 'raw',
    license: 'CC BY 4.0 field ⚠ / donor text says research-only',
    commercial: 'check',
    credit: 'De Vito et al. (UCI 360)',
    url: 'https://archive.ics.uci.edu/dataset/360/air+quality',
    note: 'Reference only. No absolute concentration claims from this array.',
  },
  {
    id: 'massbank-mona',
    name: 'MassBank of North America',
    what: 'GC-MS reference spectra for chemical annotation.',
    sensors: 'GC-MS',
    size: 'Large · per-record licences',
    labeled: true,
    format: 'raw',
    license: 'CC BY 4.0 (per-record varies)',
    commercial: 'check',
    credit: 'MoNA / Fiehn Lab',
    url: 'https://mona.fiehnlab.ucdavis.edu',
    note: 'Link only. Check the licence on each record before redistributing or using commercially.',
  },
];
