// Sensor profile registry — complete per-kind metadata for all OpenSmell sensor types.
//
// Each profile declares: engineering units, calibration curve parameters,
// expected min/max operating range, warmup time, interface family, and the
// vendor/model strings that map to it. Osmograph loads the matching profile
// for every channel so mixed rigs (MOX next to NDIR next to piezo) are handled
// per-slot without cross-contamination.
//
// No hardware discovery here yet — this is the *catalog* that a manual slot map
// or a future EEPROM/I²C ID read consults.

export type SensorKind =
  | 'mox'
  | 'electrochemical'
  | 'ndir'
  | 'pas'
  | 'pid'
  | 'galvanic'
  | 'catalyticBead'
  | 'qcm'
  | 'saw'
  | 'cantilever'
  | 'polymer'
  | 'solidElectrolyte'
  | 'phIsfet'
  | 'envTrh'
  | 'mems'
  | 'miris'
  | 'other'
  | 'unknown';

export type InterfaceKind = 'analog_5v' | 'i2c_3v3' | 'frequency' | 'onewire_id';

export interface CalibrationCurve {
  /** Model family: 'power' (RS/RO = a*C^b) | 'linear' (y = mx + c) | 'offset' | 'none' */
  model: 'power' | 'linear' | 'offset' | 'none';
  /** Power-law: a coefficient. Linear: slope. */
  a?: number;
  /** Power-law: b exponent. Linear: intercept. */
  b?: number;
  /** PID correction factor. */
  correction_factor?: number;
  /** Clean-air reference resistance (Ω) for MOX/polymer. */
  r0_typ?: number;
  /** Load resistor (Ω) for divider-based analog sensors. */
  load_resistor_ohm?: number;
  /** Sensitivity (nA/ppm) for electrochemical/galvanic. */
  sensitivity_nA_per_ppm?: number;
  /** Zero offset (µA). */
  zero_offset_ua?: number;
  /** Baseline frequency (Hz) for QCM/SAW/cantilever. */
  baseline_frequency_hz?: number;
  /** pH offset (mV) and slope (mV/pH). */
  ph_offset_mv?: number;
  ph_slope_mv_per_ph?: number;
}

export interface SensorProfile {
  kind: SensorKind;
  unit: string;            // engineering unit shown in UI (ppm, ppb, %LEL, ΔR/R₀, idx, °C, %RH, pH, Hz, V, raw)
  rawUnit?: string;        // raw ADC/frequency unit before transformation (V, Hz, counts)
  warmupSeconds: number;
  interface: InterfaceKind;
  min: number | null;      // expected operating minimum (null = not specified)
  max: number | null;      // expected operating maximum (null = not specified)
  curve: CalibrationCurve;
  vendorModels: string[];  // common vendor/model strings that map to this kind
  qcRules: string[];       // QC rule ids that apply
  description: string;
}

export interface ProfileRegistry {
  get(kind: SensorKind): SensorProfile | null;
  getByModel(model: string): SensorProfile | null;
  kinds(): SensorKind[];
  all(): SensorProfile[];
  register(profile: SensorProfile): void;
}

// ── Per-kind profiles ──────────────────────────────────────────────────────

const PROFILES: SensorProfile[] = [
  {
    kind: 'mox',
    unit: 'ΔR/R₀',
    rawUnit: 'V',
    warmupSeconds: 300,
    interface: 'analog_5v',
    min: 0,
    max: null,
    curve: { model: 'power', r0_typ: 10000, load_resistor_ohm: 10000 },
    vendorModels: ['MQ-2', 'MQ-3', 'MQ-4', 'MQ-6', 'MQ-7', 'MQ-8', 'MQ-9', 'MQ-135', 'TGS2600', 'TGS2620', 'MICS-4514', 'MICS-5524', 'MiCS-5525', 'MiCS-2710', 'MiCS-2610'],
    qcRules: ['adc_saturation', 'baseline_drift', 'flow_stagnation', 'warmup_incomplete'],
    description: 'Metal-oxide semiconductor. Heated resistive element; resistance changes with target gas.',
  },
  {
    kind: 'electrochemical',
    unit: 'ppm',
    rawUnit: 'µA',
    warmupSeconds: 90,
    interface: 'analog_5v',
    min: 0,
    max: null,
    curve: { model: 'linear', sensitivity_nA_per_ppm: 1000, zero_offset_ua: 0 },
    vendorModels: ['Alphasense CO-A4', 'Alphasense H2S-A1', 'Alphasense NO2-A1', 'Alphasense SO2-A1', 'SPEC-DGS', 'CityTech'],
    qcRules: ['out_of_range', 'warmup_incomplete', 'adc_saturation'],
    description: 'Electrochemical cell. Generates current proportional to gas concentration.',
  },
  {
    kind: 'ndir',
    unit: 'ppm',
    rawUnit: 'ppm',
    warmupSeconds: 60,
    interface: 'i2c_3v3',
    min: 0,
    max: 100000,
    curve: { model: 'offset' },
    vendorModels: ['Sensirion SCD30', 'Sensirion SCD40', 'Sensirion SCD41', 'SenseAir S8', 'SenseAir Sunrise', 'Telaire T6713'],
    qcRules: ['out_of_range', 'warmup_incomplete'],
    description: 'Non-dispersive infrared. Already-compensated digital ppm output.',
  },
  {
    kind: 'pas',
    unit: 'ppb',
    rawUnit: 'counts',
    warmupSeconds: 30,
    interface: 'i2c_3v3',
    min: 0,
    max: null,
    curve: { model: 'linear', a: 1, b: 0 },
    vendorModels: ['Sensirion SGP41', 'PAS CO2'],
    qcRules: ['out_of_range', 'warmup_incomplete'],
    description: 'Photoacoustic sensing. ppb-resolution gas detection.',
  },
  {
    kind: 'pid',
    unit: 'ppb',
    rawUnit: 'mV',
    warmupSeconds: 120,
    interface: 'analog_5v',
    min: 0,
    max: null,
    curve: { model: 'linear', correction_factor: 1.0 },
    vendorModels: ['Ion Science Tiger', 'MiniRAE', 'ppbRAE', 'Aeroqual VOC'],
    qcRules: ['out_of_range', 'warmup_incomplete', 'adc_saturation'],
    description: 'Photoionization detector. UV lamp ionizes VOCs; current proportional to concentration.',
  },
  {
    kind: 'galvanic',
    unit: '% O₂',
    rawUnit: 'µA',
    warmupSeconds: 60,
    interface: 'analog_5v',
    min: 0,
    max: 25,
    curve: { model: 'linear', sensitivity_nA_per_ppm: 1000, zero_offset_ua: 0 },
    vendorModels: ['Alphasense O2-A2', 'CityTech O2', 'Maxtec'],
    qcRules: ['out_of_range', 'warmup_incomplete'],
    description: 'Galvanic oxygen cell. Consumes O₂ to produce current.',
  },
  {
    kind: 'catalyticBead',
    unit: '% LEL',
    rawUnit: 'Ω',
    warmupSeconds: 90,
    interface: 'analog_5v',
    min: 0,
    max: 100,
    curve: { model: 'linear', a: 1, b: 0 },
    vendorModels: ['Alphasense LEL', 'Membrapor', 'Oldham'],
    qcRules: ['out_of_range', 'warmup_incomplete', 'adc_saturation'],
    description: 'Catalytic bead / pellistor. Heated bead changes resistance with combustible gas.',
  },
  {
    kind: 'qcm',
    unit: 'Δf Hz',
    rawUnit: 'Hz',
    warmupSeconds: 120,
    interface: 'frequency',
    min: null,
    max: null,
    curve: { model: 'offset', baseline_frequency_hz: 5000000 },
    vendorModels: ['QCM vapor sensor', 'QCM coated quartz'],
    qcRules: ['out_of_range', 'warmup_incomplete'],
    description: 'Quartz crystal microbalance. Mass-loading shifts resonant frequency.',
  },
  {
    kind: 'saw',
    unit: 'Δf Hz',
    rawUnit: 'Hz',
    warmupSeconds: 120,
    interface: 'frequency',
    min: null,
    max: null,
    curve: { model: 'offset', baseline_frequency_hz: 433000000 },
    vendorModels: ['SAW vapor sensor', 'SAW delay line'],
    qcRules: ['out_of_range', 'warmup_incomplete'],
    description: 'Surface acoustic wave. Coated path shifts acoustic frequency.',
  },
  {
    kind: 'cantilever',
    unit: 'Δf Hz',
    rawUnit: 'Hz',
    warmupSeconds: 300,
    interface: 'frequency',
    min: null,
    max: null,
    curve: { model: 'offset', baseline_frequency_hz: 100000 },
    vendorModels: ['Microcantilever array', 'Cantilever sensor'],
    qcRules: ['out_of_range', 'warmup_incomplete'],
    description: 'Microcantilever. Surface stress shifts resonant frequency.',
  },
  {
    kind: 'polymer',
    unit: 'ΔR/R₀',
    rawUnit: 'Ω',
    warmupSeconds: 300,
    interface: 'analog_5v',
    min: 0,
    max: null,
    curve: { model: 'power', r0_typ: 100000, load_resistor_ohm: 10000 },
    vendorModels: ['PolyTech', 'Chemiresistor polymer', 'SPM'],
    qcRules: ['adc_saturation', 'baseline_drift', 'flow_stagnation', 'warmup_incomplete'],
    description: 'Conductive polymer chemiresistor. Resistance swells with vapor absorption.',
  },
  {
    kind: 'solidElectrolyte',
    unit: '% O₂',
    rawUnit: 'mV',
    warmupSeconds: 300,
    interface: 'analog_5v',
    min: 0,
    max: 25,
    curve: { model: 'linear', a: 1, b: 0 },
    vendorModels: ['Zirconia O₂', 'Solid electrolyte O₂'],
    qcRules: ['out_of_range', 'warmup_incomplete'],
    description: 'Zirconia solid electrolyte. Nernst voltage vs oxygen partial pressure.',
  },
  {
    kind: 'phIsfet',
    unit: 'pH',
    rawUnit: 'mV',
    warmupSeconds: 60,
    interface: 'analog_5v',
    min: 0,
    max: 14,
    curve: { model: 'offset', ph_offset_mv: 0, ph_slope_mv_per_ph: -59.16 },
    vendorModels: ['ISFET pH', 'pH electrode', 'Atlas Scientific pH'],
    qcRules: ['out_of_range', 'warmup_incomplete'],
    description: 'Ion-sensitive field-effect transistor or glass electrode. mV per pH unit.',
  },
  {
    kind: 'envTrh',
    unit: '°C / %RH',
    rawUnit: 'counts',
    warmupSeconds: 10,
    interface: 'i2c_3v3',
    min: -40,
    max: 125,
    curve: { model: 'offset' },
    vendorModels: ['Sensirion SHT31', 'Sensirion SHT40', 'Adafruit SHT31-D', 'DHT22', 'DHT11'],
    qcRules: ['out_of_range', 'sht31_out_of_range'],
    description: 'Temperature and relative humidity reference sensor.',
  },
  {
    kind: 'mems',
    unit: 'idx',
    rawUnit: 'idx',
    warmupSeconds: 30,
    interface: 'i2c_3v3',
    min: 0,
    max: 500,
    curve: { model: 'offset' },
    vendorModels: ['Sensirion SGP40', 'Bosch BME680', 'Bosch BME688', 'CCS811', 'AMS'],
    qcRules: ['out_of_range', 'warmup_incomplete'],
    description: 'MEMS VOC / IAQ index. Digital index output (no absolute ppm without calibration).',
  },
  {
    kind: 'miris',
    unit: 'counts',
    rawUnit: 'counts',
    warmupSeconds: 600,
    interface: 'i2c_3v3',
    min: 0,
    max: null,
    curve: { model: 'none' },
    vendorModels: ['Miris'],
    qcRules: ['warmup_incomplete'],
    description: 'Miris gas sensor module.',
  },
  {
    kind: 'other',
    unit: 'raw',
    rawUnit: 'raw',
    warmupSeconds: 600,
    interface: 'analog_5v',
    min: null,
    max: null,
    curve: { model: 'none' },
    vendorModels: [],
    qcRules: [],
    description: 'Unclassified sensor. Treat readings as raw; no calibration assumed.',
  },
  {
    kind: 'unknown',
    unit: 'raw',
    rawUnit: 'raw',
    warmupSeconds: 600,
    interface: 'analog_5v',
    min: null,
    max: null,
    curve: { model: 'none' },
    vendorModels: [],
    qcRules: [],
    description: 'Unknown sensor. No calibration; show raw values only.',
  },
];

// ── Model → kind inference (vendor/model string → SensorKind) ──────────────

const MODEL_TO_KIND: Record<string, SensorKind> = {
  // MQ series (analog MOX)
  'MQ-2': 'mox', 'MQ-3': 'mox', 'MQ-4': 'mox', 'MQ-5': 'mox', 'MQ-6': 'mox',
  'MQ-7': 'mox', 'MQ-8': 'mox', 'MQ-9': 'mox', 'MQ-131': 'mox', 'MQ-135': 'mox',
  'MQ-136': 'mox', 'MQ-137': 'mox', 'MQ-138': 'mox', 'MQ-216': 'mox',
  // TGS / MiCS / MICS (analog MOX)
  'TGS2600': 'mox', 'TGS2602': 'mox', 'TGS2610': 'mox', 'TGS2611': 'mox',
  'TGS2612': 'mox', 'TGS2620': 'mox',
  'MICS-4514': 'mox', 'MICS-5524': 'mox', 'MICS-6814': 'mox',
  'MiCS-2610': 'mox', 'MiCS-2710': 'mox', 'MiCS-5525': 'mox',
  // MEMS / digital
  'SGP40': 'mems', 'SGP41': 'mems', 'BME680': 'mems', 'BME688': 'mems',
  'CCS811': 'mems', 'AMS': 'mems',
  // NDIR
  'SCD30': 'ndir', 'SCD40': 'ndir', 'SCD41': 'ndir', 'S8': 'ndir',
  'Sunrise': 'ndir', 'T6713': 'ndir', 'K30': 'ndir',
  // PID
  'Tiger': 'pid', 'MiniRAE': 'pid', 'ppbRAE': 'pid',
  // Electrochemical
  'CO-A4': 'electrochemical', 'H2S-A1': 'electrochemical', 'NO2-A1': 'electrochemical',
  'SO2-A1': 'electrochemical', 'O2-A2': 'galvanic',
  // Env T/RH
  'SHT31': 'envTrh', 'SHT40': 'envTrh', 'DHT22': 'envTrh', 'DHT11': 'envTrh',
  // pH
  'ISFET': 'phIsfet', 'pH electrode': 'phIsfet',
};

// ── Registry ───────────────────────────────────────────────────────────────

export class ProfileRegistryImpl implements ProfileRegistry {
  private byKind = new Map<SensorKind, SensorProfile>();
  private byModel = new Map<string, SensorProfile>();

  constructor() {
    for (const p of PROFILES) {
      this.byKind.set(p.kind, p);
      for (const m of p.vendorModels) {
        this.byModel.set(m.toUpperCase(), p);
      }
    }
    for (const [model, kind] of Object.entries(MODEL_TO_KIND)) {
      this.byModel.set(model.toUpperCase(), this.byKind.get(kind)!);
    }
  }

  get(kind: SensorKind): SensorProfile | null {
    return this.byKind.get(kind) ?? null;
  }

  getByModel(model: string): SensorProfile | null {
    return this.byModel.get(model.toUpperCase()) ?? null;
  }

  kinds(): SensorKind[] {
    return Array.from(this.byKind.keys());
  }

  all(): SensorProfile[] {
    return Array.from(this.byKind.values());
  }

  register(profile: SensorProfile): void {
    this.byKind.set(profile.kind, profile);
    for (const m of profile.vendorModels) {
      this.byModel.set(m.toUpperCase(), profile);
    }
  }
}

export const sensorProfiles = new ProfileRegistryImpl();

// ── Convenience: infer kind from a vendor/model string ─────────────────────

export function inferKindFromModel(model: string | null | undefined): SensorKind {
  if (!model) return 'unknown';
  const m = model.trim();
  if (!m) return 'unknown';
  // Direct model match.
  const direct = sensorProfiles.getByModel(m);
  if (direct) return direct.kind;
  // Fallback: keyword heuristics (same rules as inferSensorType in main.ts).
  const n = m.toUpperCase();
  if (/SGP|BME|CCS|MEMS|DIGITAL/.test(n)) return 'mems';
  if (/TEMP|DHT.*T/.test(n)) return 'envTrh';
  if (/HUM/.test(n)) return 'envTrh';
  if (/FAN|RPM/.test(n)) return 'mox';
  if (/CO2|CO₂|NDIR/.test(n)) return 'ndir';
  if (/PID|photoionization/.test(n)) return 'pid';
  if (/H2S|electrochemical|EC[-_]/i.test(n)) return 'electrochemical';
  if (/O2|O₂|oxygen|galvanic/i.test(n)) return 'galvanic';
  if (/LEL|combustible|catalytic|pellistor/i.test(n)) return 'catalyticBead';
  if (/QCM|quartz/i.test(n)) return 'qcm';
  if (/SAW|surface.acoustic/i.test(n)) return 'saw';
  if (/cantilever/i.test(n)) return 'cantilever';
  if (/polymer|chemiresist/i.test(n)) return 'polymer';
  if (/zirconia|solid.electrolyte/i.test(n)) return 'solidElectrolyte';
  if (/pH|ISFET/i.test(n)) return 'phIsfet';
  if (/miris/i.test(n)) return 'miris';
  if (/MQ|TGS|MICS|ZnO|SnO2|VOC|Alcohol|LPG|Methane|CH4|Ammonia|Hydrogen|CO$/i.test(n)) return 'mox';
  return 'unknown';
}
