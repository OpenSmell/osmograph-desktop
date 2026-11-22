// QC flags for the live OpenSmell stream.
//
// Every rule is rule-based (no neural net), runs on each completed `.osmell`
// record as it arrives from the Smell Monitor firmware, and appends flag
// strings to the affected slot's `qc_flags` array. Thresholds are starting
// values and MUST be tuned against clean-air / known-bad data before any
// field claim is made — they are not performance numbers.
//
// State (previous cycle per slot) lives in this module and is reset on
// `resetQcState()` (call it when the link is adopted or dropped).

export const QC_FLAGS = [
  "baseline_drift",
  "sht31_out_of_range",
  "adc_saturation",
  "eeprom_mismatch",
  "flow_stagnation",
] as const

export type QcFlag = (typeof QC_FLAGS)[number]

// --- tuning thresholds (starting values, not claims) -----------------------
// Baseline drift, mV per second, applied to hold-phase averaged slot voltage.
// 0.05 mV/s is the worked example in the spec; convert to per-cycle using the
// cycle period.
export const BASELINE_DRIFT_MV_PER_S = 0.05
// SHT31 out-of-range: step larger than this in one cycle = seal leak / fan fail.
export const SHT31_TEMP_DELTA_C = 5
export const SHT31_RH_DELTA_PCT = 15
// ADC saturation rails (slot volts). ADS1115 full scale with the fixed 2:1
// divider; 0.0 V or 3.3 V for two consecutive cycles = disconnected/shorted.
export const ADC_RAIL_V = 3.3
export const ADC_EPSILON_V = 0.005
// flow_stagnation: intake voltage that does not move beyond this band between
// two consecutive cycles is treated as a stuck cell / blocked flow. A live MOX
// cell always shows more than a millivolt of movement in moving air; a single
// flat sample is noise, two in a row is a fault.
export const STAGNATION_FLAT_V = 0.001

export interface QcSlotState {
  lastAnalogV: number | null
  lastIntakeAnalogV: number | null
  saturatedConsecutive: number
  intakeFlatCount: number
}

export interface QcReport {
  slots: Record<number, QcFlag[]>
  envFlags: QcFlag[]
}

function clampFlags(existing: QcFlag[], add: QcFlag[]): QcFlag[] {
  const set = new Set<QcFlag>(existing)
  for (const f of add) set.add(f)
  return QC_FLAGS.filter((f) => set.has(f))
}

function isRail(v: number | null): boolean {
  if (v === null) return false
  return Math.abs(v - 0.0) <= ADC_EPSILON_V || Math.abs(v - ADC_RAIL_V) <= ADC_EPSILON_V
}

// --- per-slot rules --------------------------------------------------------
export function slotQc(
  slotIndex: number,
  slot: {
    index: number
    sensor_type: string
    sensor_model: string | null
    eeprom_id: string | null
    readings: { analog_value_v: number | null; digital_value: number | null; unit: string }
    qc_flags: QcFlag[]
  },
  env: { temperature_c: number | null; humidity_pct: number | null },
  cycle: { phase: string; duration_s: number },
  state: QcSlotState,
): { flags: QcFlag[]; state: QcSlotState } {
  const flags: QcFlag[] = [...slot.qc_flags]
  const r = slot.readings
  const av = r.analog_value_v

  // 1. baseline_drift — hold phase: slope of the hold-averaged slot voltage
  //    between consecutive hold cycles exceeds the threshold.
  if (cycle.phase === "hold" && av !== null && state.lastAnalogV !== null) {
    const dt = Math.max(cycle.duration_s, 0.001)
    const slopeMvPerS = ((av - state.lastAnalogV) * 1000) / dt
    if (Math.abs(slopeMvPerS) > BASELINE_DRIFT_MV_PER_S) {
      flags.push("baseline_drift")
    }
  }
  if (cycle.phase === "hold") state.lastAnalogV = av

  // 4. eeprom_mismatch — data present but no cartridge EEPROM ID.
  const hasReading = r.analog_value_v !== null || r.digital_value !== null || !!slot.sensor_model
  if (hasReading && (!slot.eeprom_id || slot.eeprom_id === "null")) {
    flags.push("eeprom_mismatch")
  }

  // 3. adc_saturation — rail for two consecutive cycles.
  if (isRail(av)) {
    state.saturatedConsecutive += 1
    if (state.saturatedConsecutive >= 2) flags.push("adc_saturation")
  } else {
    state.saturatedConsecutive = 0
  }

  // 5. flow_stagnation — intake phase: a live cell moves with the air it
  //    samples. Two consecutive intake readings that stay inside a 1 mV band
  //    mean the cell is dead or the flow path is blocked. Flat *clean air* is
  //    normal only if the cell still shows sub-mV noise, so we test movement,
  //    not direction.
  if (cycle.phase === "intake" && av !== null) {
    if (state.lastIntakeAnalogV !== null) {
      const moved = Math.abs(av - state.lastIntakeAnalogV) > STAGNATION_FLAT_V
      if (moved) {
        state.intakeFlatCount = 0
      } else {
        state.intakeFlatCount += 1
        if (state.intakeFlatCount >= 2) flags.push("flow_stagnation")
      }
    }
    state.lastIntakeAnalogV = av
  }

  return { flags: clampFlags(slot.qc_flags, flags), state }
}

// --- environment rule ------------------------------------------------------
export function envQc(
  env: { temperature_c: number | null; humidity_pct: number | null },
  prev: { temperature_c: number | null; humidity_pct: number | null } | null,
): QcFlag[] {
  const flags: QcFlag[] = []
  if (!prev) return flags
  if (env.temperature_c !== null && prev.temperature_c !== null &&
      Math.abs(env.temperature_c - prev.temperature_c) > SHT31_TEMP_DELTA_C) {
    flags.push("sht31_out_of_range")
  }
  if (env.humidity_pct !== null && prev.humidity_pct !== null &&
      Math.abs(env.humidity_pct - prev.humidity_pct) > SHT31_RH_DELTA_PCT) {
    flags.push("sht31_out_of_range")
  }
  return flags
}

// --- aggregate -------------------------------------------------------------
export function computeQcFlags(
  record: {
    cycle: { id: number; phase: string; duration_s: number }
    environment: { temperature_c: number | null; humidity_pct: number | null; sensor_id: string }
    slots: Array<{
      index: number
      sensor_type: string
      sensor_model: string | null
      eeprom_id: string | null
      calibration_date: string | null
      readings: { analog_value_v: number | null; digital_value: number | null; unit: string }
      qc_flags: QcFlag[]
    }>
  },
  states: Map<number, QcSlotState>,
  prevEnv: { temperature_c: number | null; humidity_pct: number | null } | null,
): { report: QcReport; prevEnvOut: { temperature_c: number | null; humidity_pct: number | null } } {
  const envFlags = envQc(record.environment, prevEnv)
  const slots: Record<number, QcFlag[]> = {}

  for (const slot of record.slots) {
    let state = states.get(slot.index)
    if (!state) { state = { lastAnalogV: null, lastIntakeAnalogV: null, saturatedConsecutive: 0, intakeFlatCount: 0 }; states.set(slot.index, state) }
    const { flags, state: next } = slotQc(slot.index, slot, record.environment, record.cycle, state)
    states.set(slot.index, next)
    // Environmental faults apply to every reading taken in that cycle.
    slots[slot.index] = [...flags, ...envFlags]
  }

  return {
    report: { slots, envFlags },
    prevEnvOut: {
      temperature_c: record.environment.temperature_c,
      humidity_pct: record.environment.humidity_pct,
    },
  }
}

export function resetQcState<T>(states: Map<number, T>): void {
  states.clear()
}
