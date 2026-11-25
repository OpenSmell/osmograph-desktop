// Base sensor type handler for OpenSmell v1.1.
//
// Every sensor family (MOX, NDIR, PID, piezo, …) registers a handler that
// knows how to:
//   1. Convert a raw .osmell slot reading into a normalized feature value.
//   2. Declare its warmup time, default QC rules, and engineering units.
//   3. Validate its calibration block.
//
// The registry maps sensor_type strings -> handlers. Osmograph's ingestion
// pipeline calls the handler for each slot, so mixed-rig rigs (MOX next to
// NDIR next to piezo) are handled per-slot without cross-contamination.

export type SensorType =
  | 'MOX'
  | 'MEMS'
  | 'NDIR'
  | 'PAS'
  | 'PID'
  | 'Electrochemical'
  | 'Galvanic'
  | 'CatalyticBead'
  | 'QCM'
  | 'SAW'
  | 'Cantilever'
  | 'Polymer'
  | 'SolidElectrolyte'
  | 'pH_ISFET'
  | 'Env_TRH'
  | 'other'
  | 'unknown'

export type QcRuleId =
  | 'baseline_drift'
  | 'sht31_out_of_range'
  | 'adc_saturation'
  | 'eeprom_mismatch'
  | 'flow_stagnation'
  | 'sensor_fault'
  | 'warmup_incomplete'
  | 'out_of_range'

export interface QcRule {
  id: QcRuleId
  enabled: boolean
  // Human description shown in the UI tooltip.
  label: string
}

export interface CalibrationData {
  r0_ohm?: number | null
  load_resistor_ohm?: number | null
  sensitivity_nA_per_ppm?: number | null
  zero_offset_ua?: number | null
  correction_factor?: number | null
  baseline_frequency_hz?: number | null
  ph_offset_mv?: number | null
  ph_slope_mv_per_ph?: number | null
  pressure_compensation_hpa?: number | null
  offset?: number | null
  scale?: number | null
}

export interface NormalizedSlot {
  index: number
  type: SensorType
  model: string | null
  eepromId: string | null
  calibrationDate: string | null
  interface: 'analog_5v' | 'i2c_3v3' | 'frequency' | 'onewire_id'
  warmupSeconds: number
  state: 'warming' | 'ready' | 'fault'
  readings: {
    analogVolts: number | null
    digitalValue: number | null
    frequencyHz: number | null
    currentUa: number | null
    ppm: number | null
    index: number | null
    ph: number | null
    unit: string
    samples?: Array<{ t_ms: number; v: number }>
  }
  calibration: CalibrationData
  qcFlags: QcRuleId[]
  // Engineering-unit feature value, or null if not yet ready / fault.
  feature: number | null
  // ── Sensor profile metadata (resolved from the sensor profile registry) ──
  profileKind?: string | null          // resolved SensorKind string
  profileUnit?: string | null          // engineering unit from profile (authoritative)
  profileMin?: number | null           // expected operating minimum
  profileMax?: number | null           // expected operating maximum
  profileCurve?: CalibrationData | null // normalized curve params for this channel
  vendorModel?: string | null          // matched vendor/model string
}

export interface SlotState {
  lastAnalogV: number | null
  lastIntakeAnalogV: number | null
  saturatedConsecutive: number
  intakeFlatCount: number
  lastFrequencyHz: number | null
  flatFrequencyCount: number
  warmupSecondsElapsed: number
}

// Abstract handler every sensor type implements.
export abstract class BaseSensorType {
  readonly type: SensorType
  readonly warmupSeconds: number
  readonly unit: string
  readonly qcRules: QcRule[]
  readonly defaultSensitivity: number
  readonly baselineProtocol: 'first-n' | 'session-mean' | 'factory'

  constructor(opts?: {
    type?: SensorType
    warmupSeconds?: number
    unit?: string
    qcRules?: QcRule[]
    defaultSensitivity?: number
    baselineProtocol?: 'first-n' | 'session-mean' | 'factory'
  }) {
    this.type = opts?.type ?? 'unknown'
    this.warmupSeconds = opts?.warmupSeconds ?? 60
    this.unit = opts?.unit ?? 'raw'
    this.qcRules = opts?.qcRules ?? []
    this.defaultSensitivity = opts?.defaultSensitivity ?? 1
    this.baselineProtocol = opts?.baselineProtocol ?? 'first-n'
  }

  // Convert a raw .osmell slot + calibration into a normalized slot.
  abstract normalize(
    index: number,
    raw: any,
    calibration: CalibrationData,
    state: SlotState,
    cyclePhase: string,
    cycleDurationS: number
  ): NormalizedSlot

  // Validate calibration block for this type. Returns array of problems.
  validateCalibration(calibration: CalibrationData): string[] {
    return []
  }
}
