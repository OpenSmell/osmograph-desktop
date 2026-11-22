// Microcantilever handler. Raw: frequency Hz or mV deflection.
// Feature: Δf Hz or ΔmV. Warmup: 300 s. QC: sensor_fault, warmup_incomplete.

import {
  BaseSensorType,
  type NormalizedSlot,
  type QcRule,
  type CalibrationData,
  type SlotState,
  type SensorType,
} from '../base'

const QC_RULES: QcRule[] = [
  { id: 'sensor_fault', enabled: true, label: 'Cantilever signal flatlined' },
  { id: 'warmup_incomplete', enabled: true, label: 'Cantilever not yet thermally stable' },
]

export class CantileverHandler extends BaseSensorType {
  readonly type: SensorType = 'Cantilever'
  readonly warmupSeconds = 300
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
    const av = raw.readings?.analog_value_v ?? null

    const warmupElapsed = state.warmupSecondsElapsed + cycleDurationS
    let stateVal: 'warming' | 'ready' | 'fault' = 'ready'
    if (warmupElapsed < this.warmupSeconds) stateVal = 'warming'

    let feature: number | null = null
    if (f !== null && f0 !== null && stateVal === 'ready') {
      feature = f - f0
    } else if (av !== null) {
      feature = av
    }

    return {
      index,
      type: 'Cantilever',
      model: raw.sensor_model ?? null,
      eepromId: raw.eeprom_id ?? null,
      calibrationDate: raw.calibration_date ?? null,
      interface: 'frequency',
      warmupSeconds: this.warmupSeconds,
      state: stateVal,
      readings: {
        analogVolts: av,
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
