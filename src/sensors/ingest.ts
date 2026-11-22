// .osmell ingestion pipeline.
//
// Takes a raw .osmell record (v1.0 or v1.1), normalizes each slot through its
// sensor-type handler, and returns normalized slots with feature values ready
// for detection / QC / UI rendering.
//
// Backward compatible: v1.0 records (which only have analog_value_v /
// digital_value) are mapped to the appropriate handler based on sensor_type.

import {
  type NormalizedSlot,
  type SlotState,
  type CalibrationData,
  type SensorType,
} from './base'
import { sensorTypeRegistry } from './registry'

// Map legacy v1.0 sensor_type strings to v1.1 enum values where possible.
const LEGACY_TYPE_MAP: Record<string, SensorType> = {
  MOX: 'MOX',
  MEMS: 'MEMS',
  NDIR: 'NDIR',
  Electrochemical: 'Electrochemical',
  PID: 'PID',
  QCM: 'QCM',
  pH: 'pH_ISFET',
  other: 'other',
  unknown: 'unknown',
}

function mapSensorType(rawType: string | undefined): SensorType {
  if (!rawType) return 'unknown'
  const mapped = LEGACY_TYPE_MAP[rawType]
  if (mapped) return mapped
  // Try direct enum match
  const known: SensorType[] = [
    'MOX', 'MEMS', 'NDIR', 'PAS', 'PID', 'Electrochemical', 'Galvanic',
    'CatalyticBead', 'QCM', 'SAW', 'Cantilever', 'Polymer', 'SolidElectrolyte',
    'pH_ISFET', 'Env_TRH', 'other', 'unknown',
  ]
  if (known.includes(rawType as SensorType)) return rawType as SensorType
  return 'unknown'
}

function mapInterface(rawType: SensorType): 'analog_5v' | 'i2c_3v3' | 'frequency' | 'onewire_id' {
  const digitalTypes: SensorType[] = ['NDIR', 'PAS', 'MEMS', 'Env_TRH']
  const freqTypes: SensorType[] = ['QCM', 'SAW', 'Cantilever']
  if (digitalTypes.includes(rawType)) return 'i2c_3v3'
  if (freqTypes.includes(rawType)) return 'frequency'
  return 'analog_5v'
}

function defaultCalibration(): CalibrationData {
  return {
    r0_ohm: null,
    load_resistor_ohm: null,
    sensitivity_nA_per_ppm: null,
    zero_offset_ua: null,
    correction_factor: null,
    baseline_frequency_hz: null,
    ph_offset_mv: null,
    ph_slope_mv_per_ph: null,
    pressure_compensation_hpa: null,
    offset: null,
    scale: null,
  }
}

function defaultSlotState(): SlotState {
  return {
    lastAnalogV: null,
    lastIntakeAnalogV: null,
    saturatedConsecutive: 0,
    intakeFlatCount: 0,
    lastFrequencyHz: null,
    flatFrequencyCount: 0,
    warmupSecondsElapsed: 0,
  }
}

// Normalize a single .osmell slot through its sensor-type handler.
export function normalizeSlot(
  index: number,
  raw: any,
  state: SlotState,
  cyclePhase: string,
  cycleDurationS: number
): { slot: NormalizedSlot; state: SlotState } {
  const type = mapSensorType(raw?.sensor_type)
  const handler = sensorTypeRegistry.get(type)
  const calibration: CalibrationData = raw?.calibration ?? defaultCalibration()

  // Validate calibration for this type.
  const problems = handler.validateCalibration(calibration)
  let stateVal: 'warming' | 'ready' | 'fault' = 'ready'
  if (problems.length > 0) stateVal = 'fault'

  const normalized = handler.normalize(
    index,
    raw ?? {},
    calibration,
    state,
    cyclePhase,
    cycleDurationS
  )

  // Override state if calibration is invalid.
  if (stateVal === 'fault') normalized.state = 'fault'

  // Track warmup elapsed time across cycles.
  const nextState: SlotState = { ...state }
  nextState.warmupSecondsElapsed += cycleDurationS
  if (normalized.state === 'ready') {
    // Once ready, cap warmup tracking.
    nextState.warmupSecondsElapsed = handler.warmupSeconds
  }

  // Carry over handler-mutated state (e.g. flatFrequencyCount for piezo).
  // The handler mutates the passed-in state object directly, so we just return it.
  return { slot: normalized, state: nextState }
}

// Normalize all slots in a .osmell record.
export function normalizeRecord(
  record: any,
  states: Map<number, SlotState>,
  cyclePhase: string,
  cycleDurationS: number
): { slots: NormalizedSlot[]; states: Map<number, SlotState> } {
  const slots: NormalizedSlot[] = []
  const nextStates = new Map<number, SlotState>(states)

  const rawSlots = record.slots ?? []
  for (const rawSlot of rawSlots) {
    const idx = rawSlot.index ?? 0
    const prevState = nextStates.get(idx) ?? defaultSlotState()
    const { slot, state } = normalizeSlot(idx, rawSlot, prevState, cyclePhase, cycleDurationS)
    slots.push(slot)
    nextStates.set(idx, state)
  }

  return { slots, states: nextStates }
}

// Reset all slot states (called on link adopt / drop).
export function resetSlotStates(states: Map<number, SlotState>): void {
  states.clear()
}
