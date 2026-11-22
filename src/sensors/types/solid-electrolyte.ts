// Solid electrolyte handler (zirconia O₂, high-temp CO₂). Raw: analog mV / current.
// Feature: % O₂ or ppm via Nernst equation. Warmup: 300 s (heated to 700°C).

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
  { id: 'warmup_incomplete', enabled: true, label: 'Solid electrolyte not yet at operating temperature' },
]

export class SolidElectrolyteHandler extends BaseSensorType {
  readonly type: SensorType = 'SolidElectrolyte'
  readonly warmupSeconds = 300
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
    const av = raw.readings?.analog_value_v ?? null
    const currentUa = raw.readings?.current_ua ?? null
    const warmupElapsed = state.warmupSecondsElapsed + cycleDurationS
    let stateVal: 'warming' | 'ready' | 'fault' = 'ready'
    if (warmupElapsed < this.warmupSeconds) stateVal = 'warming'

    let feature: number | null = null
    if (currentUa !== null && calibration.sensitivity_nA_per_ppm) {
      feature = currentUa / calibration.sensitivity_nA_per_ppm
    } else if (av !== null) {
      feature = av
      stateVal = 'warming'
    }

    return {
      index,
      type: 'SolidElectrolyte',
      model: raw.sensor_model ?? null,
      eepromId: raw.eeprom_id ?? null,
      calibrationDate: raw.calibration_date ?? null,
      interface: 'analog_5v',
      warmupSeconds: this.warmupSeconds,
      state: stateVal,
      readings: {
        analogVolts: av,
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
