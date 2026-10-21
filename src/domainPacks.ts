// Domain Vials — the part of the ecosystem that carries a way of working, not
// just a pairwise verdict. A pack is declarative on purpose: the host renders
// the screen, so a domain expert can ship a workspace without shipping code.
//
// Design source: private/PLUGIN_ECOSYSTEM.md, private/SDK_AND_VIAL_AUTHORING.md,
// and the extension design in OPENSMELL_MASTER.md §2.1 / §3.1. Stage 1 here is
// host-rendered; the manifest is designed to grow into sandboxed UI later.

export type DomainRisk = 'low' | 'medium' | 'high' | 'critical';
export type DomainArt = 'fermentation' | 'plant' | 'generic';
export type DomainSeverity = 'info' | 'warn' | 'stop';

export interface DomainField {
  id: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select';
  unit?: string;
  placeholder?: string;
  options?: string[];
}

export interface DomainLog {
  id: string;
  at: number;
  values: Record<string, string>;
}

export type DomainWidget =
  | { type: 'hero'; art: DomainArt; title: string; subtitle: string; note: string }
  | { type: 'risk'; level: DomainRisk; headline: string; body: string; always: string[]; never: string[] }
  | { type: 'metrics'; title: string; items: Array<{ label: string; value: string; hint: string }> }
  | { type: 'diagram'; art: DomainArt; title: string; caption: string; hotspots: Array<{ id: string; label: string; x: number; y: number; body: string; severity: DomainSeverity }> }
  | { type: 'timeline'; title: string; steps: Array<{ label: string; range: string; body: string; warn?: string }> }
  | { type: 'tracking'; title: string; description: string; fields: DomainField[]; logFields: DomainField[]; logLabel: string }
  | { type: 'chart'; title: string; yLabel: string; logField: string; demo: Array<{ x: number; y: number }>; note: string }
  | {
      type: 'detector';
      title: string;
      intro: string;
      baseline: string;
      levels: Array<{ level: number; label: string; meaning: string; action: string }>;
      limits: string[];
      evidence: string;
    }
  | { type: 'rules'; title: string; rules: Array<{ when: string; then: string; severity: DomainSeverity }> }
  | { type: 'checklist'; title: string; items: Array<{ id: string; label: string; detail: string }> }
  | { type: 'docs'; title: string }
  | { type: 'rig'; title: string; body: string; cta: string };

export interface DomainDoc {
  id: string;
  title: string;
  body: string[];
}

export interface DomainPack {
  schema: 'osmograph.domain-pack/1';
  id: string;
  name: string;
  version: string;
  author: string;
  license: string;
  tier: 'official' | 'community';
  risk: DomainRisk;
  domain: string;
  tagline: string;
  summary: string;
  whatItIs: string;
  whatItIsNot: string;
  citations: string[];
  widgets: DomainWidget[];
  docs: DomainDoc[];
  /** Optional provenance for a manifest installed from a URL. */
  sourceUrl?: string;
}

export interface DomainState {
  packId: string;
  installedAt: number;
  fields: Record<string, string>;
  checks: Record<string, boolean>;
  logs: DomainLog[];
}

export interface DomainValidationCheck {
  id: string;
  label: string;
  passed: boolean;
  critical: boolean;
  detail: string;
}

export interface DomainValidation {
  passed: boolean;
  imported: boolean;
  checks: DomainValidationCheck[];
  errors: string[];
  warnings: string[];
}

export interface DomainImportResult {
  pack: DomainPack;
  validation: DomainValidation;
}

const INSTALLED_KEY = 'osmograph.domain.installed.v1';
const STATE_KEY = 'osmograph.domain.state.v1';
const CUSTOM_PACKS_KEY = 'osmograph.domain.packs.v1';

export const RISK_LABEL: Record<DomainRisk, string> = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
  critical: 'Critical risk',
};

export const SEVERITY_LABEL: Record<DomainSeverity, string> = {
  info: 'context',
  warn: 'caution',
  stop: 'stop',
};

export const OFFICIAL_DOMAIN_PACKS: DomainPack[] = [
  {
    schema: 'osmograph.domain-pack/1',
    id: 'official.fermentation',
    name: 'Fermentation Lab',
    version: '0.2.0',
    author: '@opensmell',
    license: 'CC-BY-4.0',
    tier: 'official',
    risk: 'high',
    domain: 'fermentation',
    tagline: 'Track the batch, not just the bubble.',
    summary: 'A workspace for tracking a ferment with pH, temperature, visual cues, and your own array baseline — with food safety kept out of the smell channel.',
    whatItIs: 'A protocol, log, and decision-support workspace for home fermentation. It helps you record what changed, compare a batch to a reference blank on the same array, and stop when the primary controls say stop.',
    whatItIsNot: 'Not a pathogen test, not a pH meter, not a universal fermentation classifier, and not a cross-rig claim. A pleasant smell cannot clear a batch.',
    citations: [
      'FDA. Bad Bug Book: Foodborne Pathogenic Microorganisms and Natural Toxins, 2nd ed. (2012).',
      'USDA. Complete Guide to Home Canning (2015).',
      'Codex Alimentarius. General Principles of Food Hygiene (CXC 1-1969, rev.).',
      '21 CFR 114 / FDA acidified foods guidance uses pH 4.6 as the botulism-control boundary for low-acid foods.',
    ],
    widgets: [
      {
        type: 'hero',
        art: 'fermentation',
        title: 'Fermentation Lab',
        subtitle: 'A batch log that keeps the sensor honest.',
        note: 'Official domain Vial · host-rendered · no executable code',
      },
      {
        type: 'risk',
        level: 'high',
        headline: 'Food safety is not a smell test.',
        body: 'A Vial can tell you a sample changed on your array. It cannot tell you a batch is safe. pH, time, temperature, recipe, and visible evidence decide.',
        always: [
          'Use a calibrated pH meter and a tested recipe.',
          'Log every batch: date, salt or brine, temperature, pH, and visual cues.',
          'When in doubt, discard. Discard is a valid batch outcome.',
        ],
        never: [
          'Never use a pleasant smell to overrule mould, slime, or a pH above 4.6 in a low-acid ferment.',
          'Never sell or serve a batch you cannot trace.',
          'Never compare readings from a different array or rig.',
        ],
      },
      {
        type: 'metrics',
        title: 'What this workspace is allowed to claim',
        items: [
          { label: 'Array can do', value: 'Change detection', hint: 'Same array, same sample prep, against your own reference blank.' },
          { label: 'Array cannot do', value: 'Safety verdict', hint: 'No pathogen, toxin, or “safe to eat” call. Ever.' },
          { label: 'Primary controls', value: 'pH · time · temp', hint: 'These decide. The nose only flags that something changed.' },
        ],
      },
      {
        type: 'diagram',
        art: 'fermentation',
        title: 'The vessel, as a checklist',
        caption: 'Click a point. Every point is a place where a clean batch can turn into a risk.',
        hotspots: [
          { id: 'airlock', label: 'Airlock', x: 50, y: 12, severity: 'info', body: 'Gas should escape, not pressurise. Check the seal and keep the airlock clean. A dry airlock is not proof of safety.' },
          { id: 'lid', label: 'Lid / seal', x: 50, y: 28, severity: 'warn', body: 'A sealed anaerobic vessel is exactly why low-acid ferments need a proven recipe and pH control. Do not improvise a low-acid anaerobic batch.' },
          { id: 'brine', label: 'Brine line', x: 50, y: 50, severity: 'info', body: 'Keep solids submerged. A surface exposed to air is a mould opportunity, not a flavour choice.' },
          { id: 'liquid', label: 'Active ferment', x: 50, y: 70, severity: 'info', body: 'Bubbles and cloudiness are process cues. They are not a safety certificate. Log them with pH and temperature.' },
          { id: 'sensor', label: 'Sensor port', x: 77, y: 60, severity: 'warn', body: 'Use the array as a change detector against a clean reference on the same channels. Ethanol and acids can dominate the response; high VOC can saturate or poison MOX sensors.' },
        ],
      },
      {
        type: 'timeline',
        title: 'A simple fermentation rhythm',
        steps: [
          { label: 'Prep', range: 'Day 0', body: 'Clean the vessel and hands. Weigh salt or measure brine. Label the batch. Record starting pH and temperature.' },
          { label: 'Lag', range: 'Day 1–3', body: 'Bubbles may be quiet. Keep solids submerged. Log pH, temperature, smell, and anything visible.', warn: 'No bubbles at day 3 is a prompt to verify pH and temperature, not to assume it is safe.' },
          { label: 'Active', range: 'Day 4–10', body: 'Acidity should move toward the recipe target. Keep temperature stable. Off-odours, slime, or fuzzy growth are stop signals.' },
          { label: 'Finish', range: 'Recipe end', body: 'Chill or package exactly as the tested recipe says. Keep the batch record. Smell never overrides the recipe.' },
        ],
      },
      {
        type: 'tracking',
        title: 'Batch log',
        description: 'The log is the valuable object. The sensor reading is one column, not the verdict.',
        fields: [
          { id: 'batch', label: 'Batch name', type: 'text', placeholder: 'Sauerkraut #4' },
          { id: 'started', label: 'Started', type: 'date' },
          { id: 'recipe', label: 'Recipe / salt', type: 'text', placeholder: '2.5% salt by weight' },
          { id: 'target', label: 'Target pH', type: 'number', placeholder: '3.8' },
        ],
        logFields: [
          { id: 'day', label: 'Day', type: 'number', placeholder: '3' },
          { id: 'ph', label: 'pH', type: 'number', placeholder: '4.1' },
          { id: 'temp', label: 'Temp', type: 'number', unit: '°C', placeholder: '21' },
          { id: 'smell', label: 'Smell note', type: 'text', placeholder: 'sour, cabbage, clean' },
          { id: 'visual', label: 'Visual note', type: 'text', placeholder: 'cloudy brine, no surface growth' },
          { id: 'action', label: 'Action', type: 'select', options: ['none', 'verify pH', 'chill', 'discard'] },
        ],
        logLabel: 'Add reading',
      },
      {
        type: 'chart',
        title: 'pH trajectory',
        yLabel: 'pH',
        logField: 'ph',
        demo: [
          { x: 0, y: 6.2 }, { x: 1, y: 5.8 }, { x: 2, y: 5.1 }, { x: 3, y: 4.5 },
          { x: 4, y: 4.1 }, { x: 5, y: 3.8 },
        ],
        note: 'The line is your log. The example is not a target and not a safety curve. Follow the recipe and measure pH.',
      },
      {
        type: 'rules',
        title: 'Stop rules',
        rules: [
          { when: 'pH above 4.6 after 48 h in a low-acid ferment', then: 'Stop. Chill or discard per the recipe; verify with a calibrated meter. Do not rely on smell.', severity: 'stop' },
          { when: 'Fuzzy, pink, black, or blue mould', then: 'Discard. Do not salvage by removing the surface. Toxins can be invisible.', severity: 'stop' },
          { when: 'Slime, rope, or a foul turn in the smell', then: 'Discard. Do not taste.', severity: 'stop' },
          { when: 'No bubbles, no acidity, warm room, day 3', then: 'Treat as stalled or risky. Verify pH and temperature; do not assume it is safe.', severity: 'warn' },
          { when: 'Clean sour smell, pH in target, no visible faults', then: 'Continue the protocol. This is not a safety certificate.', severity: 'info' },
        ],
      },
      {
        type: 'checklist',
        title: 'Before you taste',
        items: [
          { id: 'clean', label: 'Vessel and hands clean', detail: 'No residue, no cracks, no exposed surfaces.' },
          { id: 'ph', label: 'pH meter calibrated', detail: 'A reading you do not trust is worse than no reading.' },
          { id: 'salt', label: 'Salt or brine measured by weight', detail: 'Volume spoons drift; weight is reproducible.' },
          { id: 'label', label: 'Batch labelled', detail: 'Date, recipe, salt %, start temperature.' },
          { id: 'temp', label: 'Temperature logged', detail: 'Warm is faster, not automatically safer.' },
          { id: 'discard', label: 'Discard rule understood', detail: 'Decide now, not when the batch is emotionally valuable.' },
        ],
      },
      { type: 'docs', title: 'Field notes' },
      { type: 'rig', title: 'Use this with your rig', body: 'Record a clean reference blank, then a batch sample on the same channels and sample prep. Compare with Check. If the arrays differ, the app will refuse the comparison.', cta: 'Open Check' },
    ],
    docs: [
      {
        id: 'how',
        title: 'How to use this workspace',
        body: [
          'Start one batch. Fill the batch fields, then add a reading whenever you measure pH, temperature, or inspect the vessel.',
          'The array is a change detector: capture a clean reference and a sample on the same array, then compare them in Check. Do not compare a batch from one rig with a reference from another.',
          'The stop rules are deliberately conservative. A sensor reading cannot clear a batch; it can only add a prompt to look, measure, or discard.',
        ],
      },
      {
        id: 'sensor',
        title: 'What the sensor is actually doing',
        body: [
          'A MOX array responds to a mixture of volatile compounds. Ethanol, organic acids, and other fermentation products can dominate the response, and high concentrations can saturate or poison a sensor.',
          'The useful signal is a change relative to a reference on the same array. The absolute number is not concentration and is not comparable across rigs.',
          'Humidity, temperature, sample distance, and vessel headspace all change the reading. Log them as context, not as afterthoughts.',
        ],
      },
      {
        id: 'risk',
        title: 'What can go wrong',
        body: [
          'Low-acid, anaerobic ferments can support Clostridium botulinum growth. Smell is not a reliable botulinum test. Follow a tested recipe, use a calibrated pH meter, and respect the pH 4.6 boundary for low-acid foods.',
          'Moulds can produce mycotoxins that are not removed by scraping the surface. Discard fuzzy or coloured growth.',
          'Cross-contamination from hands, utensils, or an airlock turns a clean batch into an uncontrolled one.',
          'A drifted or saturated sensor can make a changing batch look stable. The log and the primary measurements matter more than the trace.',
        ],
      },
      {
        id: 'validate',
        title: 'How to validate a Vial on your rig',
        body: [
          'Record a clean reference blank and at least three batch samples on the same array, with the same sample preparation and distance.',
          'Use Check to compare the reference and the batch. Read the lower bound and the permutation p-value, not just the badge.',
          'A sealed Vial is a claim about a closed-set comparison on the array that produced the evidence. It is not a transferable calibration and it is not a safety certification.',
        ],
      },
      {
        id: 'clean',
        title: 'Cleaning and traceability',
        body: [
          'Clean the vessel, lid, airlock, weights, and hands before the batch. Keep raw and finished batches separate.',
          'Label every batch with date, recipe, salt or brine, and starting temperature. A batch you cannot trace is a batch you cannot debug.',
        ],
      },
      {
        id: 'refs',
        title: 'References',
        body: [
          'FDA. Bad Bug Book: Foodborne Pathogenic Microorganisms and Natural Toxins, 2nd ed. (2012).',
          'USDA. Complete Guide to Home Canning (2015).',
          'Codex Alimentarius. General Principles of Food Hygiene (CXC 1-1969, rev.).',
          '21 CFR 114 / FDA acidified foods guidance: pH 4.6 is the botulism-control boundary for low-acid foods.',
          'These are references for the safety context, not an endorsement of this Vial or a substitute for local food-safety guidance.',
        ],
      },
    ],
  },
  {
    schema: 'osmograph.domain-pack/1',
    id: 'official.plant',
    name: 'Plant Respiration',
    version: '0.2.0',
    author: '@opensmell',
    license: 'CC-BY-4.0',
    tier: 'official',
    risk: 'medium',
    domain: 'plants',
    tagline: 'Watch the plant, not just the number.',
    summary: 'A weekly plant-health workspace that pairs array response with light, water, leaf, and root context — and states what the array cannot see.',
    whatItIs: 'A structured log for one plant. It helps you notice a VOC or respiration change and correlate it with care, light, and visible symptoms.',
    whatItIsNot: 'Not ethylene detection, not a pest or pathogen diagnosis, not a substitute for inspecting roots and leaves, and not a cross-rig claim.',
    citations: [
      'Kesselmeier, J. & Staudt, M. (1999). Biogenic volatile organic compounds (VOC): an overview. Journal of Atmospheric Chemistry 33, 23–88.',
      'Dicke, M. & Baldwin, I. T. (2010). The evolutionary context for herbivore-induced plant volatiles. Trends in Plant Science 15(3), 167–175.',
    ],
    widgets: [
      {
        type: 'hero',
        art: 'plant',
        title: 'Plant Respiration',
        subtitle: 'A weekly change log with roots, leaves, and light in the frame.',
        note: 'Official domain Vial · host-rendered · no executable code',
      },
      {
        type: 'risk',
        level: 'medium',
        headline: 'A change signal is not a diagnosis.',
        body: 'The array can notice that a plant’s volatile profile changed. It cannot tell you why. Check water, light, pests, roots, and recent moves.',
        always: [
          'Record light, watering, and leaf condition with every sample.',
          'Inspect the roots and the undersides of leaves.',
          'Quarantine new plants before placing them near others.',
        ],
        never: [
          'Never treat a sensor spike as a pest or disease identification.',
          'Never assume the array can see ethylene; the current constants table has no ethylene response.',
          'Never compare a plant’s reading to a different array or rig.',
        ],
      },
      {
        type: 'metrics',
        title: 'What this workspace is allowed to claim',
        items: [
          { label: 'Array can do', value: 'Change detection', hint: 'Same plant, same array, same time of day, against a baseline.' },
          { label: 'Array cannot do', value: 'Ethylene / diagnosis', hint: 'No ethylene channel and no pathogen or pest identification.' },
          { label: 'Best signal', value: 'Context + trend', hint: 'A single reading is weak; a weekly trend plus symptoms is stronger.' },
        ],
      },
      {
        type: 'diagram',
        art: 'plant',
        title: 'The plant, as a checklist',
        caption: 'Click a point. The sensor is one clue; the plant body is the rest of the evidence.',
        hotspots: [
          { id: 'leaf', label: 'Leaf surface', x: 33, y: 31, severity: 'info', body: 'Look for spots, curling, yellowing, sticky honeydew, webbing, or a change in leaf gloss. Check the underside, not just the top.' },
          { id: 'stem', label: 'Stem', x: 50, y: 56, severity: 'info', body: 'Soft, black, or constricted stems are structural problems the array cannot name. Record them with the reading.' },
          { id: 'soil', label: 'Soil / pot', x: 50, y: 78, severity: 'warn', body: 'Overwatering and poor drainage can look like a slow decline. Smell the soil, check moisture, and look for fungus gnats.' },
          { id: 'root', label: 'Roots', x: 50, y: 90, severity: 'warn', body: 'Root rot can be invisible above the pot. If the plant is declining without an obvious leaf cause, inspect the root ball.' },
          { id: 'sensor', label: 'Sensor', x: 76, y: 61, severity: 'info', body: 'Same array, same distance, same time of day. Temperature and humidity are confounds; log them. The array sees a VOC mixture, not ethylene.' },
        ],
      },
      {
        type: 'timeline',
        title: 'A weekly rhythm',
        steps: [
          { label: 'Baseline', range: 'Week 0', body: 'Pick one plant and one location. Record light, watering, pot size, and leaf condition. Take a clean reference blank.' },
          { label: 'Weekly', range: 'Week 1–4', body: 'Sample at the same time of day. Log the reading with water, light, leaf, and soil notes.' },
          { label: 'Change', range: 'Any week', body: 'A spike or drop is a prompt to inspect. Look for pests, root problems, drafts, or a recent move before changing care.' },
          { label: 'Review', range: 'Monthly', body: 'Compare the trend, not one point. Re-baseline after a move, repot, or season change.' },
        ],
      },
      {
        type: 'tracking',
        title: 'Plant log',
        description: 'The plant name, care context, and symptoms are part of the measurement.',
        fields: [
          { id: 'plant', label: 'Plant name', type: 'text', placeholder: 'Monstera by the window' },
          { id: 'species', label: 'Species', type: 'text', placeholder: 'Monstera deliciosa' },
          { id: 'location', label: 'Location', type: 'text', placeholder: 'north window, living room' },
          { id: 'light', label: 'Light', type: 'select', options: ['low', 'medium', 'bright indirect', 'direct'] },
        ],
        logFields: [
          { id: 'date', label: 'Date', type: 'date' },
          { id: 'smell', label: 'Smell / respiration index', type: 'number', placeholder: '0–10' },
          { id: 'leaf', label: 'Leaf note', type: 'text', placeholder: 'one yellow lower leaf' },
          { id: 'soil', label: 'Soil / water', type: 'text', placeholder: 'moist, watered 2 days ago' },
          { id: 'action', label: 'Action', type: 'select', options: ['none', 'inspect roots', 'isolate', 'adjust water', 're-baseline'] },
        ],
        logLabel: 'Add weekly reading',
      },
      {
        type: 'chart',
        title: 'Smell index trend',
        yLabel: 'index',
        logField: 'smell',
        demo: [
          { x: 0, y: 3.0 }, { x: 1, y: 3.2 }, { x: 2, y: 4.8 }, { x: 3, y: 6.1 }, { x: 4, y: 5.9 },
        ],
        note: 'The line is your log. A rise is a prompt to inspect, not a diagnosis. The current array has no ethylene channel.',
      },
      {
        type: 'rules',
        title: 'What to do with a change',
        rules: [
          { when: 'Sudden rise plus wilting', then: 'Check water, heat, and root health. Isolate if pests are visible. Do not treat the number as the cause.', severity: 'warn' },
          { when: 'Gradual rise plus sticky leaves or webbing', then: 'Inspect for pests, especially under the leaves. Do not spray blindly.', severity: 'warn' },
          { when: 'No change plus yellowing', then: 'Look at roots, drainage, and light. The array may be blind to the cause.', severity: 'info' },
          { when: 'Sharp drop after moving indoors', then: 'Re-baseline after the move. Do not compare readings across rooms or seasons.', severity: 'info' },
          { when: 'Suspected pesticide or toxic exposure', then: 'Do not use smell as exposure measurement. Ventilate and seek appropriate guidance.', severity: 'stop' },
        ],
      },
      {
        type: 'checklist',
        title: 'Before you change care',
        items: [
          { id: 'leaves', label: 'Both leaf surfaces inspected', detail: 'Pests often hide underneath.' },
          { id: 'roots', label: 'Roots / drainage checked', detail: 'If the plant is declining without a leaf cause.' },
          { id: 'water', label: 'Water and light logged', detail: 'Context is part of the measurement.' },
          { id: 'same', label: 'Same array and time of day', detail: 'Do not compare across rigs or rooms.' },
          { id: 'quarantine', label: 'New plants quarantined', detail: 'Do not let a new plant share air with the baseline plant.' },
          { id: 'rebaseline', label: 'Re-baseline after a change', detail: 'A move or repot invalidates the old baseline.' },
        ],
      },
      { type: 'docs', title: 'Field notes' },
      { type: 'rig', title: 'Use this with your rig', body: 'Record a clean reference blank and a plant sample on the same array and at the same time of day. Compare with Check. If the arrays differ, the app will refuse the comparison.', cta: 'Open Check' },
    ],
    docs: [
      {
        id: 'how',
        title: 'How to use this workspace',
        body: [
          'Pick one plant and one location. Fill the plant fields, then add a weekly reading with the smell index, leaf, soil, water, and any action.',
          'A reading is a prompt to look, not a diagnosis. The plant body and the care context are the evidence.',
          'Use Check to compare the plant sample to a clean reference on the same array. A difference is a change signal, not an identification.',
        ],
      },
      {
        id: 'sensor',
        title: 'What the sensor is actually doing',
        body: [
          'Plants emit a mixture of biogenic volatile organic compounds. Wounding, ripening, and stress can change that mixture. A MOX array sees a combined response, not a single compound.',
          'The current constants table has no ethylene response, so the app cannot make an ethylene claim. Do not use it to decide whether fruit will ripen or whether a plant is emitting ethylene.',
          'Humidity, temperature, distance, and the room’s background air all affect the reading. Log them.',
        ],
      },
      {
        id: 'risk',
        title: 'What can go wrong',
        body: [
          'A change signal can be caused by watering, a draft, a new cleaning product, a person, or a different time of day. It is not specific to a pest or pathogen.',
          'Pests and root problems can be present without a large VOC change. Inspect the plant.',
          'A sensor that has drifted or been exposed to a strong VOC can report a change that is about the sensor, not the plant.',
        ],
      },
      {
        id: 'validate',
        title: 'How to validate a Vial on your rig',
        body: [
          'Record a clean reference and at least three plant samples on the same array, at the same time of day, with the same distance.',
          'Use Check to compare the reference and the plant. Read the lower bound and the permutation p-value.',
          'A sealed Vial is a closed-set claim on the array that produced the evidence. It is not a diagnosis and it is not transferable to another rig.',
        ],
      },
      {
        id: 'refs',
        title: 'References',
        body: [
          'Kesselmeier, J. & Staudt, M. (1999). Biogenic volatile organic compounds (VOC): an overview. Journal of Atmospheric Chemistry 33, 23–88.',
          'Dicke, M. & Baldwin, I. T. (2010). The evolutionary context for herbivore-induced plant volatiles. Trends in Plant Science 15(3), 167–175.',
          'These references describe plant VOC biology; they do not validate this Vial or turn a sensor response into a diagnosis.',
        ],
      },
    ],
  },
  {
    schema: 'osmograph.domain-pack/1',
    id: 'official.anomaly-watch',
    name: 'Anomaly Watch',
    version: '0.1.0',
    author: '@opensmell',
    license: 'CC-BY-4.0',
    tier: 'official',
    risk: 'high',
    domain: 'general',
    tagline: 'A clean baseline, a sustained change, and a decision to inspect.',
    summary: 'A domain-agnostic change watch built on Osmograph’s live anomaly engine. It gives a custom process a clean baseline, a local log, alert-level rules, and a hard refusal: no identity, no concentration, no safety verdict.',
    whatItIs: 'A baseline-and-change workspace for a process you already know how to inspect. It arms the same-device anomaly detector, records the context around each alert, and tells you when to stop and use the primary measurement.',
    whatItIsNot: 'Not a gas leak detector, not a safety device, not a chemical identifier, not a concentration meter, not a cross-rig calibration, and not a replacement for a certified instrument or a human inspection.',
    citations: [
      'TotalEnergies Anomaly Detection Initiative (TADI) 2019. Controlled methane release corpus, Zenodo 8399829.',
      'OpenSmell. Leave-one-board-out evaluation of the dual-Kalman anomaly engine on TADI-2019. anomaly-evals/loocv_tadi_results.json (2026).',
      'OpenSmell. Real-cadence TADI re-run and the false-alarm ceiling. reports/tadi_cadence_rerun.md (2026).',
    ],
    widgets: [
      {
        type: 'hero',
        art: 'generic',
        title: 'Anomaly Watch',
        subtitle: 'A clean baseline. A sustained change. A decision to inspect — not an identity.',
        note: 'Official domain Vial · same-device only · not a safety device',
      },
      {
        type: 'risk',
        level: 'high',
        headline: 'A quiet detector is not a safe room.',
        body: 'The engine flags a sustained departure from a clean baseline on this array. It cannot tell you which gas, how much, or whether a space is safe. If the domain is life safety, this Vial is a prompt to use the certified instrument and the emergency procedure — never a substitute for either.',
        always: [
          'Verify a clean baseline on this exact array before you arm it.',
          'Log the context around every alert: location, process step, recent cleaning, temperature, humidity, and sample path.',
          'Keep a certified detector and a written emergency procedure for any hazardous gas.',
        ],
        never: [
          'Never call this a gas leak detector or a safety device.',
          'Never use a quiet reading to decide that a space is safe to enter.',
          'Never compare a reading from one array or rig to another.',
          'Never treat an alert as an identification or a concentration.',
        ],
      },
      {
        type: 'metrics',
        title: 'What this workspace is allowed to claim',
        items: [
          { label: 'Signal', value: 'Sustained change', hint: 'Innovation and level budgets on the same array, against its own clean baseline.' },
          { label: 'Baseline', value: 'Per-device clean air', hint: 'Warm-up never alarms. A baseline from another array does not transfer.' },
          { label: 'Not', value: 'Identity or safety', hint: 'No gas name, no concentration, no safe/unsafe verdict, no cross-rig claim.' },
        ],
      },
      {
        type: 'detector',
        title: 'Detector contract',
        intro: 'This panel maps the live engine’s states to a decision you can audit. The detector is the same one on the Dashboard; this Vial does not add a second model.',
        baseline: 'A fresh clean-air window on this exact array. The engine reports warming up and will not alarm until the baseline is built. Verify a quiet clean window before you arm a hazardous process.',
        levels: [
          { level: 0, label: 'Warming up', meaning: 'The baseline is still forming; no alarm is possible.', action: 'Keep the clean-air window stable. Do not arm yet.' },
          { level: 0, label: 'Normal', meaning: 'No sustained anomaly from this baseline.', action: 'Keep logging context. Absence of an alarm is not proof of absence.' },
          { level: 1, label: 'Warning', meaning: 'The anomaly has persisted past the warning duration.', action: 'Stop the process, inspect, and verify with the primary measurement.' },
          { level: 2, label: 'Critical', meaning: 'The anomaly has persisted past the critical duration.', action: 'Follow the stop rule for the domain. Do not treat the alert as an identification.' },
          { level: 3, label: 'Emergency', meaning: 'The anomaly has persisted past the emergency duration.', action: 'Use the emergency procedure and a certified instrument. Leave the area if there is any hazard.' },
        ],
        limits: [
          'In the leave-one-board-out TADI-2019 evaluation, held-out detection at the 0-false-alarm operating point was 4.2–31.6% across boards. A single cross-device configuration is not viable.',
          'A bare single-unit MOS array cannot separate a slow plume from post-exposure residue. The optional level leg catches more slow changes but also alarms on harmless residue.',
          'The 0-false-alarm ceiling is per-device. Verify a clean window on each array; do not import another array’s baseline.',
          'The engine detects a change, not a gas. It does not identify the compound, measure concentration, or certify that a space is safe.',
        ],
        evidence: 'Evidence: TADI-2019 controlled methane releases, leave-one-board-out and real-cadence evaluations. See Field notes for the numbers and the refusals.',
      },
      {
        type: 'tracking',
        title: 'Watch log',
        description: 'The context is part of the measurement. An alert without a location, process step, and primary reading is not a usable record.',
        fields: [
          { id: 'site', label: 'Site / room', type: 'text', placeholder: 'Garage bench 2' },
          { id: 'array', label: 'Array / rig', type: 'text', placeholder: 'Osmograph v2 · array A' },
          { id: 'baseline', label: 'Baseline note', type: 'text', placeholder: 'clean air, 6 min, verified quiet' },
          { id: 'primary', label: 'Primary instrument', type: 'text', placeholder: 'certified CH4 detector or process gauge' },
        ],
        logFields: [
          { id: 'date', label: 'When', type: 'date' },
          { id: 'level', label: 'Alert level', type: 'select', options: ['0 normal', '1 warning', '2 critical', '3 emergency', 'warming up'] },
          { id: 'context', label: 'Context', type: 'text', placeholder: 'what changed? cleaning, door, process step' },
          { id: 'primaryReading', label: 'Primary reading', type: 'text', placeholder: 'instrument + value, or “none”' },
          { id: 'action', label: 'Action', type: 'select', options: ['none', 'inspect', 'stop process', 'evacuate', 're-baseline', 'service sensor'] },
        ],
        logLabel: 'Add watch entry',
      },
      {
        type: 'rules',
        title: 'Stop rules',
        rules: [
          { when: 'The detector is warming up', then: 'Do not arm a hazardous process. Keep the clean-air window stable until the baseline is built.', severity: 'warn' },
          { when: 'Alert level 1 or 2 without an obvious benign cause', then: 'Stop the process and inspect. Verify with the primary measurement before continuing. Do not treat the alert as an identification.', severity: 'stop' },
          { when: 'Alert level 3', then: 'Use the written emergency procedure and a certified instrument. Leave the area if there is any hazard. Do not wait for the app.', severity: 'stop' },
          { when: 'You smell gas, feel symptoms, or suspect a leak while the detector is quiet', then: 'Do not enter or stay. Leave, ventilate only if it is safe, and call the emergency service. A quiet reading is not a safety verdict.', severity: 'stop' },
          { when: 'You move the array, change the enclosure, sensor, or sample path', then: 'Re-baseline. The old baseline belongs to the old physical setup.', severity: 'warn' },
          { when: 'You want to compare this reading with another rig', then: 'Do not. Re-baseline on the rig that produced the reading.', severity: 'info' },
        ],
      },
      {
        type: 'checklist',
        title: 'Before you arm it',
        items: [
          { id: 'clean', label: 'Clean-air window verified', detail: 'No solvent, cleaning spray, cooking, or known source in the baseline window.' },
          { id: 'same', label: 'Same array and sample path', detail: 'Do not move the sensor or change the enclosure between baseline and watch.' },
          { id: 'warm', label: 'Warm-up complete', detail: 'The engine must leave warming up before an alarm is possible.' },
          { id: 'quiet', label: 'Quiet baseline observed', detail: 'Watch for false alarms before you rely on the alert. A clean window is not a guarantee.' },
          { id: 'primary', label: 'Primary instrument ready', detail: 'A certified detector or the process’s own safety measurement.' },
          { id: 'plan', label: 'Emergency procedure written', detail: 'Who leaves, who calls, who ventilates, and where the shutoff is.' },
        ],
      },
      { type: 'docs', title: 'Field notes' },
      { type: 'rig', title: 'Use this with your rig', body: 'Open the Dashboard to arm the live detector on this array. For a two-sample comparison, record a clean reference and a sample on the same array and use Check. The app refuses comparisons across different arrays.', cta: 'Open Check' },
    ],
    docs: [
      {
        id: 'arm',
        title: 'How to arm a change watch',
        body: [
          'Pick one process, one array, and one physical setup. Record the site, the array, the baseline conditions, and the primary instrument in the watch log.',
          'Run the array in clean air until the baseline is built. Confirm the Dashboard shows a normal state and no warming-up flag. If the clean window is noisy, fix the setup before you trust an alert.',
          'Arm the watch only for the process you described. If the setup changes, re-baseline. A baseline is a property of the physical device and sample path, not a reusable calibration.',
        ],
      },
      {
        id: 'engine',
        title: 'What the engine actually does',
        body: [
          'The live engine compares each reading with a baseline model on the same array. It combines an innovation budget, a multi-channel corroboration rule, and a wall-clock persistence gate. A single noisy sample should not become an emergency.',
          'Alert levels are reached after a duration of continuous anomaly: warning, then critical, then emergency. The exact durations are part of the engine, not this Vial. Treat the level as an escalation prompt, not a measurement.',
          'The optional level-anchored leg can catch a slow change that the innovation budget absorbs. It also alarms on elevated residue after a real exposure. That trade-off is a deployment choice, not a hidden improvement.',
        ],
      },
      {
        id: 'evidence',
        title: 'What the evidence says',
        body: [
          'On the TADI-2019 controlled methane releases, the real-cadence engine detected 16.7–42.1% of release windows at the baseline operating point, with 383–643 false-alarm seconds per month. A per-device calibration stack reached 0 false-alarm seconds per month on two boards, with detection around 33–40% on those boards and 47% on the third at a higher false-alarm cost.',
          'The leave-one-board-out evaluation is the honest transfer test: held-out detection at the 0-false-alarm point was 4.2%, 25.0%, and 31.6% across the three boards. A configuration tuned on two boards did not transfer its false-alarm contract to the third.',
          'The practical reading is narrow: a per-device, clean-air-verified watch can be a useful change flag. It is not a reliable leak detector, and it is not a safety instrument. The missing detections and the residue confusion are physics and decision-layer limits, not a promise that a future UI update removes.',
        ],
      },
      {
        id: 'limits',
        title: 'What it cannot do',
        body: [
          'It cannot identify a gas. A MOX array responds to a mixture; the same change can come from a solvent, cooking, cleaning, a person, humidity, or the sensor itself.',
          'It cannot measure concentration or exposure. The output is a change signal on one device, not a calibrated value in air.',
          'It cannot certify a space as safe. A quiet detector can miss a slow leak, a sensor can drift, and a saturated or poisoned channel can go quiet. Use a certified instrument and a written procedure for any life-safety decision.',
        ],
      },
      {
        id: 'hazard',
        title: 'If this is a hazardous gas',
        body: [
          'This Vial is not a gas leak detector and must not be the primary safety measure. Install and maintain a certified detector appropriate to the gas and the space. Follow local code and the manufacturer’s instructions.',
          'If you smell gas, hear a leak, or feel symptoms, leave the area. Do not switch electrical devices on or off, do not use a flame, and call the emergency service from a safe location. Ventilate only if you can do so without putting yourself at risk.',
          'Do not use the app to decide whether it is safe to enter, stay, or re-enter. The app has no authority to make that decision.',
        ],
      },
      {
        id: 'refs',
        title: 'References and artifacts',
        body: [
          'TotalEnergies Anomaly Detection Initiative (TADI) 2019. Controlled methane release corpus, Zenodo 8399829.',
          'OpenSmell. Leave-one-board-out evaluation of the dual-Kalman anomaly engine on TADI-2019. anomaly-evals/loocv_tadi_results.json (2026).',
          'OpenSmell. Real-cadence TADI re-run and the false-alarm ceiling. reports/tadi_cadence_rerun.md (2026).',
          'These artifacts document the detector’s measured behavior. They do not certify this Vial, your rig, or any safety decision.',
        ],
      },
    ],
  },
];

export function loadInstalledIds(): string[] {
  try {
    const raw = localStorage.getItem(INSTALLED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function isInstalled(id: string): boolean {
  return loadInstalledIds().includes(id);
}

export function installDomainPack(id: string): void {
  const pack = domainPackById(id);
  if (!pack) throw new Error('Unknown domain Vial.');
  const ids = loadInstalledIds();
  if (!ids.includes(id)) {
    ids.unshift(id);
    localStorage.setItem(INSTALLED_KEY, JSON.stringify(ids));
  }
  ensureDomainState(id);
}

export function uninstallDomainPack(id: string): void {
  localStorage.setItem(INSTALLED_KEY, JSON.stringify(loadInstalledIds().filter(x => x !== id)));
}

function allStates(): Record<string, DomainState> {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, DomainState> : {};
  } catch {
    return {};
  }
}

function writeStates(states: Record<string, DomainState>): void {
  localStorage.setItem(STATE_KEY, JSON.stringify(states));
}

export function ensureDomainState(packId: string): DomainState {
  const states = allStates();
  const existing = states[packId];
  if (existing) return normalizeState(existing, packId);
  const state: DomainState = {
    packId,
    installedAt: Date.now(),
    fields: {},
    checks: {},
    logs: [],
  };
  states[packId] = state;
  writeStates(states);
  return state;
}

function normalizeState(state: DomainState, packId: string): DomainState {
  return {
    packId,
    installedAt: state.installedAt || Date.now(),
    fields: state.fields || {},
    checks: state.checks || {},
    logs: Array.isArray(state.logs) ? state.logs : [],
  };
}

export function loadDomainState(packId: string): DomainState {
  return ensureDomainState(packId);
}

export function saveDomainState(state: DomainState): void {
  const states = allStates();
  states[state.packId] = state;
  writeStates(states);
}

export function deleteDomainState(packId: string): void {
  const states = allStates();
  delete states[packId];
  writeStates(states);
}

export function addDomainLog(state: DomainState, values: Record<string, string>): DomainState {
  const log: DomainLog = {
    id: `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
    at: Date.now(),
    values,
  };
  return { ...state, logs: [log, ...state.logs].slice(0, 200) };
}

export function removeDomainLog(state: DomainState, logId: string): DomainState {
  return { ...state, logs: state.logs.filter(log => log.id !== logId) };
}

// === Domain pack library: official + imported community packs ===
// The pack is data, not code. Import is a policy gate followed by a declarative
// render. No string is ever inserted as HTML; the renderer escapes every field.

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

function coerceRisk(value: unknown): DomainRisk {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical' ? value : 'medium';
}

function coerceSeverity(value: unknown): DomainSeverity {
  return value === 'info' || value === 'warn' || value === 'stop' ? value : 'info';
}

function coerceArt(value: unknown): DomainArt {
  return value === 'plant' || value === 'generic' ? value : 'fermentation';
}

function coerceField(value: unknown): DomainField | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  const label = asString(value.label);
  if (!id || !label) return null;
  const type = value.type === 'number' || value.type === 'date' || value.type === 'select' ? value.type : 'text';
  return {
    id,
    label,
    type,
    unit: asString(value.unit) || undefined,
    placeholder: asString(value.placeholder) || undefined,
    options: Array.isArray(value.options) ? asStringArray(value.options) : undefined,
  };
}

function coerceWidget(value: unknown): DomainWidget | null {
  if (!isRecord(value)) return null;
  const type = asString(value.type);
  if (type === 'hero') {
    return { type, art: coerceArt(value.art), title: asString(value.title), subtitle: asString(value.subtitle), note: asString(value.note) };
  }
  if (type === 'risk') {
    return { type, level: coerceRisk(value.level), headline: asString(value.headline), body: asString(value.body), always: asStringArray(value.always), never: asStringArray(value.never) };
  }
  if (type === 'metrics') {
    const items = Array.isArray(value.items) ? value.items.filter(isRecord).map(item => ({
      label: asString(item.label), value: asString(item.value), hint: asString(item.hint),
    })) : [];
    return { type, title: asString(value.title), items };
  }
  if (type === 'diagram') {
    const hotspots = Array.isArray(value.hotspots) ? value.hotspots.filter(isRecord).map(h => ({
      id: asString(h.id), label: asString(h.label),
      x: typeof h.x === 'number' ? h.x : Number(h.x) || 50,
      y: typeof h.y === 'number' ? h.y : Number(h.y) || 50,
      body: asString(h.body), severity: coerceSeverity(h.severity),
    })) : [];
    return { type, art: coerceArt(value.art), title: asString(value.title), caption: asString(value.caption), hotspots };
  }
  if (type === 'timeline') {
    const steps = Array.isArray(value.steps) ? value.steps.filter(isRecord).map(s => ({
      label: asString(s.label), range: asString(s.range), body: asString(s.body), warn: asString(s.warn) || undefined,
    })) : [];
    return { type, title: asString(value.title), steps };
  }
  if (type === 'tracking') {
    const fields = Array.isArray(value.fields) ? value.fields.map(coerceField).filter((f): f is DomainField => !!f) : [];
    const logFields = Array.isArray(value.logFields) ? value.logFields.map(coerceField).filter((f): f is DomainField => !!f) : [];
    return { type, title: asString(value.title), description: asString(value.description), fields, logFields, logLabel: asString(value.logLabel) };
  }
  if (type === 'chart') {
    const demo = Array.isArray(value.demo) ? value.demo.filter(isRecord).map(p => ({
      x: typeof p.x === 'number' ? p.x : Number(p.x) || 0,
      y: typeof p.y === 'number' ? p.y : Number(p.y) || 0,
    })) : [];
    return { type, title: asString(value.title), yLabel: asString(value.yLabel), logField: asString(value.logField), demo, note: asString(value.note) };
  }
  if (type === 'detector') {
    const levels = Array.isArray(value.levels) ? value.levels.filter(isRecord).map(l => ({
      level: typeof l.level === 'number' ? l.level : Number(l.level) || 0,
      label: asString(l.label),
      meaning: asString(l.meaning),
      action: asString(l.action),
    })) : [];
    return {
      type,
      title: asString(value.title),
      intro: asString(value.intro),
      baseline: asString(value.baseline),
      levels,
      limits: asStringArray(value.limits),
      evidence: asString(value.evidence),
    };
  }
  if (type === 'rules') {
    const rules = Array.isArray(value.rules) ? value.rules.filter(isRecord).map(r => ({
      when: asString(r.when), then: asString(r.then), severity: coerceSeverity(r.severity),
    })) : [];
    return { type, title: asString(value.title), rules };
  }
  if (type === 'checklist') {
    const items = Array.isArray(value.items) ? value.items.filter(isRecord).map(i => ({
      id: asString(i.id), label: asString(i.label), detail: asString(i.detail),
    })) : [];
    return { type, title: asString(value.title), items };
  }
  if (type === 'docs') return { type, title: asString(value.title) };
  if (type === 'rig') return { type, title: asString(value.title), body: asString(value.body), cta: asString(value.cta) };
  return null;
}

function coercePack(raw: unknown): DomainPack {
  const source = isRecord(raw) ? raw : {};
  const docs = Array.isArray(source.docs) ? source.docs.filter(isRecord).map(d => ({
    id: asString(d.id), title: asString(d.title), body: asStringArray(d.body),
  })) : [];
  const widgets = Array.isArray(source.widgets) ? source.widgets.map(coerceWidget).filter((w): w is DomainWidget => !!w) : [];
  return {
    schema: 'osmograph.domain-pack/1',
    id: asString(source.id),
    name: asString(source.name),
    version: asString(source.version),
    author: asString(source.author),
    license: asString(source.license),
    tier: source.tier === 'official' ? 'official' : 'community',
    risk: coerceRisk(source.risk),
    domain: asString(source.domain),
    tagline: asString(source.tagline),
    summary: asString(source.summary),
    whatItIs: asString(source.whatItIs),
    whatItIsNot: asString(source.whatItIsNot),
    citations: asStringArray(source.citations),
    widgets,
    docs,
    sourceUrl: asString(source.sourceUrl) || undefined,
  };
}

export function loadCustomPacks(): DomainPack[] {
  try {
    const raw = localStorage.getItem(CUSTOM_PACKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(coercePack).filter(pack => validateDomainPack(pack, true).passed);
  } catch {
    return [];
  }
}

function writeCustomPacks(packs: DomainPack[]): void {
  localStorage.setItem(CUSTOM_PACKS_KEY, JSON.stringify(packs));
}

export function saveCustomPack(pack: DomainPack): void {
  const packs = loadCustomPacks().filter(p => p.id !== pack.id);
  packs.unshift(pack);
  writeCustomPacks(packs);
}

export function deleteCustomPack(id: string): void {
  writeCustomPacks(loadCustomPacks().filter(p => p.id !== id));
}

export function allDomainPacks(): DomainPack[] {
  return [...OFFICIAL_DOMAIN_PACKS, ...loadCustomPacks()];
}

export function domainPackById(id: string): DomainPack | undefined {
  return allDomainPacks().find(p => p.id === id);
}

function allPackText(pack: DomainPack): string {
  const chunks: string[] = [
    pack.id, pack.name, pack.author, pack.license, pack.domain, pack.tagline,
    pack.summary, pack.whatItIs, pack.whatItIsNot, ...pack.citations,
  ];
  for (const doc of pack.docs) chunks.push(doc.title, ...doc.body);
  for (const widget of pack.widgets) {
    chunks.push(JSON.stringify(widget));
  }
  return chunks.join('\n');
}

function negatedBefore(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const sentenceStart = Math.max(
    before.lastIndexOf('.'),
    before.lastIndexOf('!'),
    before.lastIndexOf('?'),
    before.lastIndexOf('\n'),
  );
  const sentence = before.slice(sentenceStart + 1).toLowerCase();
  return /\b(?:not|no|cannot|can't|never|without|refuse|refuses|refused|doesn't|does not|isn't|is not|zero)\b/.test(sentence);
}

function firstUnnegated(text: string, re: RegExp): RegExpExecArray | null {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = global.exec(text))) {
    if (!negatedBefore(text, match.index)) return match;
    if (match.index === global.lastIndex) global.lastIndex++;
  }
  return null;
}

const OVERCLAIM_PATTERNS: Array<{ id: string; re: RegExp; label: string }> = [
  { id: 'safety', re: /\bsafe to eat\b/i, label: 'a “safe to eat” claim' },
  { id: 'pathogen', re: /\bpathogen(?: test| detection| identification)\b/i, label: 'a pathogen test claim' },
  { id: 'diagnosis', re: /\bdiagnos(?:e|es|is|tic)\b/i, label: 'a diagnosis claim' },
  { id: 'ethylene', re: /\bdetect(?:s|ing)? ethylene\b/i, label: 'an ethylene detection claim' },
  { id: 'universal', re: /\buniversal smell (?:id|identifier)\b/i, label: 'a universal smell ID claim' },
  { id: 'concentration', re: /\b(?:absolute concentration|parts per million|ppm)\b/i, label: 'an absolute concentration claim' },
  { id: 'crossrig', re: /\bcross[- ]rig\b/i, label: 'a cross-rig claim' },
  { id: 'anyrig', re: /\bworks? on any (?:rig|array|device)\b/i, label: 'a works-on-any-rig claim' },
  { id: 'guarantee', re: /\bguarantee(?:d|s)?\b/i, label: 'a guarantee' },
  { id: 'medical', re: /\bmedical (?:diagnosis|device|advice)\b/i, label: 'a medical claim' },
  { id: 'safety-device', re: /\b(?:gas leak detector|certified safety device|life[- ]safety device|safety instrument)\b/i, label: 'a safety-device claim' },
  { id: 'safety-verdict', re: /\b(?:safe to (?:enter|occupy|breathe)|(?:room|space|area) is safe)\b/i, label: 'a safety verdict' },
];

const EXECUTABLE_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'script-tag', re: /<script\b/i },
  { id: 'iframe', re: /<iframe\b/i },
  { id: 'object', re: /<object\b|<embed\b|<img\b|<link\b/i },
  { id: 'javascript-url', re: /javascript:/i },
  { id: 'inline-handler', re: /\bon[a-z]+\s*=/i },
  { id: 'data-html', re: /data:text\/html/i },
];

export function validateDomainPack(pack: DomainPack, imported = false): DomainValidation {
  const checks: DomainValidationCheck[] = [];
  const add = (id: string, label: string, passed: boolean, critical: boolean, detail: string) => {
    checks.push({ id, label, passed, critical, detail });
  };
  const text = allPackText(pack);
  const widgetTypes = new Set(pack.widgets.map(w => w.type));

  add('schema', 'Manifest schema', pack.schema === 'osmograph.domain-pack/1', true, 'Expected osmograph.domain-pack/1.');
  add('id', 'Stable id', /^[a-z0-9][a-z0-9._-]{2,80}$/.test(pack.id), true, 'Use a lowercase, globally unique id (3–80 chars).');
  if (imported) add('reserved-id', 'Reserved official namespace', !pack.id.startsWith('official.'), true, 'The official.* namespace is reserved for first-party packs.');
  add('name', 'Name', pack.name.trim().length >= 2 && pack.name.trim().length <= 80, true, 'A pack needs a short display name.');
  add('version', 'Semantic version', /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pack.version), true, 'Use semver, for example 0.2.0.');
  add('author', 'Author identity', pack.author.trim().length >= 2 && pack.author.trim().length <= 80, true, 'Credit the author or handle.');
  if (imported) add('reserved-author', 'Reserved author handle', pack.author !== '@opensmell', true, 'The @opensmell handle is reserved for first-party packs.');
  add('license', 'Licence', pack.license.trim().length >= 2 && pack.license.trim().length <= 80, true, 'State a licence (SPDX id or a licence URL).');
  add('risk', 'Risk level', ['low', 'medium', 'high', 'critical'].includes(pack.risk), true, 'Declare low, medium, high, or critical risk.');
  add('domain', 'Domain', pack.domain.trim().length >= 2, true, 'Name the domain, for example fermentation or plants.');
  add('tagline', 'Tagline', pack.tagline.trim().length >= 4 && pack.tagline.trim().length <= 160, true, 'One honest line about the workspace.');
  add('summary', 'Summary', pack.summary.trim().length >= 30 && pack.summary.trim().length <= 600, true, 'Explain the workspace and its scope.');
  add('what-it-is', 'What it is', pack.whatItIs.trim().length >= 30, true, 'State the useful claim or protocol.');
  add('what-it-is-not', 'What it is not', pack.whatItIsNot.trim().length >= 30 && /(?:not|cannot|no\s|never|without|refuse)/i.test(pack.whatItIsNot), true, 'Name the claim you refuse to make.');
  add('citations', 'Citations', pack.citations.length >= 1 && pack.citations.every(c => c.trim().length >= 10), true, 'At least one real reference, not a vibe.');
  add('docs', 'Field notes', pack.docs.length >= 2 && pack.docs.every(d => d.title.trim() && d.body.length >= 1), true, 'At least two documented sections with body text.');
  add('hero', 'Overview panel', widgetTypes.has('hero'), true, 'A domain Vial needs an overview.');
  add('risk-panel', 'Risk panel', widgetTypes.has('risk'), true, 'A domain Vial must show its risk framing.');
  add('docs-panel', 'Docs panel', widgetTypes.has('docs'), true, 'A domain Vial must expose its field notes.');
  add('rig-panel', 'Rig handoff', widgetTypes.has('rig'), true, 'Show how the workspace connects to Check.');
  add('workspace', 'A workspace surface', widgetTypes.has('tracking') || widgetTypes.has('diagram') || widgetTypes.has('rules'), true, 'Add a log, a diagram, or decision rules.');

  const riskWidgets = pack.widgets.filter((w): w is Extract<DomainWidget, { type: 'risk' }> => w.type === 'risk');
  add('risk-lists', 'Always / never limits', riskWidgets.length > 0 && riskWidgets.every(w => w.always.length >= 1 && w.never.length >= 1), true, 'The risk panel needs explicit always and never lists.');
  add('risk-match', 'Risk level consistency', riskWidgets.every(w => w.level === pack.risk), false, 'The risk panel and pack should declare the same level.');

  if (pack.risk === 'high' || pack.risk === 'critical') {
    const stopRules = pack.widgets.flatMap(w => w.type === 'rules' ? w.rules : []).filter(r => r.severity === 'stop');
    add('high-risk-stop', 'High-risk stop rules', stopRules.length >= 1, true, 'High and critical risk packs need at least one explicit stop rule.');
    add('high-risk-docs', 'High-risk documentation', pack.docs.length >= 3, true, 'High and critical risk packs need at least three field-note sections.');
  }

  for (const widget of pack.widgets) {
    if (widget.type === 'tracking') {
      add('tracking-fields', 'Tracking fields', widget.fields.length >= 2 && widget.logFields.length >= 2, true, 'A log needs at least two context fields and two reading fields.');
    }
    if (widget.type === 'diagram') {
      add('diagram-hotspots', 'Diagram hotspots', widget.hotspots.length >= 1 && widget.hotspots.every(h => h.x >= 0 && h.x <= 100 && h.y >= 0 && h.y <= 100), true, 'Diagram points need labels, notes, and 0–100 coordinates.');
    }
    if (widget.type === 'detector') {
      add('detector-levels', 'Detector states', widget.levels.length >= 3 && widget.levels.every(l => Number.isFinite(l.level) && l.label.trim() && l.meaning.trim() && l.action.trim()), true, 'Document at least three detector states with a meaning and an action.');
      add('detector-limits', 'Detector limits', widget.limits.length >= 2 && widget.limits.every(l => l.trim().length >= 10), true, 'A detector panel needs at least two explicit limits.');
      add('detector-evidence', 'Detector evidence', widget.evidence.trim().length >= 20, true, 'State the evidence behind the detector mapping.');
    }
    if (widget.type === 'rules') {
      add('rule-text', 'Rule text', widget.rules.every(r => r.when.trim() && r.then.trim()), true, 'Every rule needs a when and a then.');
    }
    if (widget.type === 'checklist') {
      add('checklist-items', 'Checklist items', widget.items.length >= 1 && widget.items.every(i => i.id && i.label), true, 'Checklist items need stable ids and labels.');
    }
  }

  const executable = EXECUTABLE_PATTERNS.find(p => p.re.test(text));
  add('no-code', 'No executable or remote UI', !executable, true, executable ? `Rejected ${executable.id}: packs are declarative; no HTML, JavaScript, or embedded resources.` : 'Declarative text only.');

  const overclaims = OVERCLAIM_PATTERNS.filter(p => !!firstUnnegated(text, p.re));
  add('no-overclaim', 'No overclaim language', overclaims.length === 0, true, overclaims.length ? `Remove or negate: ${overclaims.map(o => o.label).join(', ')}.` : 'No unnegated forbidden claims found.');

  const errors = checks.filter(c => c.critical && !c.passed).map(c => c.detail);
  const warnings = checks.filter(c => !c.critical && !c.passed).map(c => c.detail);
  if (imported && pack.tier === 'official') warnings.push('Imported packs are always treated as community; official status is reserved for first-party packs.');
  return { passed: errors.length === 0, imported, checks, errors, warnings };
}

export function domainPackToJson(pack: DomainPack): string {
  return JSON.stringify(pack, null, 2);
}

export function inspectDomainPackJson(raw: string): DomainImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!isRecord(parsed) || parsed.schema !== 'osmograph.domain-pack/1') {
    throw new Error('Expected a domain pack with schema osmograph.domain-pack/1.');
  }
  if (OFFICIAL_DOMAIN_PACKS.some(p => p.id === parsed.id)) {
    throw new Error('That id belongs to a built-in official pack. Choose a unique community id.');
  }
  if (parsed.author === '@opensmell') {
    throw new Error('The @opensmell author handle is reserved for first-party packs.');
  }
  const pack = coercePack(parsed);
  pack.tier = 'community';
  return { pack, validation: validateDomainPack(pack, true) };
}

export function parseDomainPackJson(raw: string): DomainImportResult {
  const result = inspectDomainPackJson(raw);
  if (!result.validation.passed) {
    throw new Error(`Domain Vial rejected by the policy gate: ${result.validation.errors[0] || 'unknown reason'}`);
  }
  return result;
}

export function importDomainPackJson(raw: string, sourceUrl?: string): DomainImportResult {
  const result = parseDomainPackJson(raw);
  if (sourceUrl) result.pack.sourceUrl = sourceUrl;
  saveCustomPack(result.pack);
  return result;
}

