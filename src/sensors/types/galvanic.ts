// Galvanic / fuel-cell handler (O₂, specific toxics). Raw: current µA.
// Feature: % O₂ or ppm. Warmup: 60 s. QC: baseline_drift, warmup_incomplete.

import {
  BaseSensorType,
  type NormalizedSlot,
  type QcRule,
  type CalibrationData,
  type SlotState,
  type SensorType,
} from '../base'

const QC_RULES: QcRule[] = [
  { id: 'baseline_drift', enabled: true, label: 'Hold-phase slope > 0.05 mV/s' },
  { id: 'warmup_incomplete', enabled: true, label: 'Electrode not yet polarized' },
]

export class GalvanicHandler extends BaseSensorType {
  readonly type: SensorType = 'Galvanic'
  readonly warmupSeconds = 60
  readonly unit = '% O₂'
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
    const currentUa = raw.readings?.current_ua ?? null
    const sens = calibration.sensitivity_nA_per_ppm ?? null
    const offset = calibration.zero_offset_ua ?? null

    const warmupElapsed = state.warmupSecondsElapsed + cycleDurationS
    let stateVal: 'warming' | 'ready' | 'fault' = 'ready'
    if (warmupElapsed < this.warmupSeconds) stateVal = 'warming'

    let feature: number | null = null
    if (currentUa !== null && sens !== null && sens !== 0) {
      feature = (currentUa - (offset ?? 0)) / sens
    }

    return {
      index,
      type: 'Galvanic',
      model: raw.sensor_model ?? null,
      eepromId: raw.eeprom_id ?? null,
      calibrationDate: raw.calibration_date ?? null,
      interface: 'analog_5v',
      warmupSeconds: this.warmupSeconds,
      state: stateVal,
      readings: {
        analogVolts: raw.readings?.analog_value_v ?? null,
        digitalValue: raw.readings?.digital_value ?? null,
        frequencyHz: null,
        currentUa,
        ppm: null,
        index: null,
        ph: null,
        unit: raw.readings?.unit ?? 'V',
        samples: raw.readings?.samples ?? undefined,
      },
      calibration,
      qcFlags: [],
      feature,
    }
  }
}
