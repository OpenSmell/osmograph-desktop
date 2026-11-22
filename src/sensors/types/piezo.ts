// Piezo / QCM handler. Raw: frequency Hz. Feature: Δf = f − f₀.
// Warmup: 120 s. QC: sensor_fault (flat frequency), warmup_incomplete.

import {
  BaseSensorType,
  type NormalizedSlot,
  type QcRule,
  type CalibrationData,
  type SlotState,
  type SensorType,
} from '../base'

const QC_RULES: QcRule[] = [
  { id: 'sensor_fault', enabled: true, label: 'Frequency flatlined (dead crystal)' },
  { id: 'warmup_incomplete', enabled: true, label: 'Oscillator not yet stable' },
]

export class PiezoHandler extends BaseSensorType {
  readonly type: SensorType = 'QCM'
  readonly warmupSeconds = 120
  readonly unit = 'Δf Hz'
  readonly qcRules = QC_RULES
  readonly defaultSensitivity = 1
  readonly baselineProtocol = 'first-n'

  normalize(
    index: number,
    raw: any,
    calibration: CalibrationData,
    state: SlotState,
    cyclePhase: string,
    cycleDurationS: number
  ): NormalizedSlot {
    const f = raw.readings?.frequency_hz ?? null
    const f0 = calibration.baseline_frequency_hz ?? null

    const warmupElapsed = state.warmupSecondsElapsed + cycleDurationS
    let stateVal: 'warming' | 'ready' | 'fault' = 'ready'
    if (warmupElapsed < this.warmupSeconds) stateVal = 'warming'
    if (f !== null && state.lastFrequencyHz !== null && Math.abs(f - state.lastFrequencyHz) < 0.001) {
      state.flatFrequencyCount += 1
      if (state.flatFrequencyCount >= 2) stateVal = 'fault'
    } else {
      state.flatFrequencyCount = 0
    }

    let feature: number | null = null
    if (f !== null && f0 !== null && stateVal === 'ready') {
      feature = f - f0
    } else if (f !== null) {
      feature = f
    }

    return {
      index,
      type: 'QCM',
      model: raw.sensor_model ?? null,
      eepromId: raw.eeprom_id ?? null,
      calibrationDate: raw.calibration_date ?? null,
      interface: 'frequency',
      warmupSeconds: this.warmupSeconds,
      state: stateVal,
      readings: {
        analogVolts: null,
        digitalValue: null,
        frequencyHz: f,
        currentUa: null,
        ppm: null,
        index: null,
        ph: null,
        unit: raw.readings?.unit ?? 'Hz',
        samples: raw.readings?.samples ?? undefined,
      },
      calibration,
      qcFlags: [],
      feature,
    }
  }
}
