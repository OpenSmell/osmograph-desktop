// PAS (photoacoustic spectroscopy) handler. Raw: digital ppb/ppm.
// Feature: ppb/ppm passthrough. Warmup: 30 s. QC: out_of_range, warmup_incomplete.

import {
  BaseSensorType,
  type NormalizedSlot,
  type QcRule,
  type CalibrationData,
  type SlotState,
  type SensorType,
} from '../base'

const QC_RULES: QcRule[] = [
  { id: 'out_of_range', enabled: true, label: 'Reading outside calibrated range' },
  { id: 'warmup_incomplete', enabled: true, label: 'Photoacoustic cell not yet stabilized' },
]

export class PasHandler extends BaseSensorType {
  readonly type: SensorType = 'PAS'
  readonly warmupSeconds = 30
  readonly unit = 'ppb'
  readonly qcRules = QC_RULES
  readonly defaultSensitivity = 1
  readonly baselineProtocol = 'factory'

  normalize(
    index: number,
    raw: any,
    calibration: CalibrationData,
    state: SlotState,
    cyclePhase: string,
    cycleDurationS: number
  ): NormalizedSlot {
    const ppm = raw.readings?.ppm ?? null
    const warmupElapsed = state.warmupSecondsElapsed + cycleDurationS
    let stateVal: 'warming' | 'ready' | 'fault' = 'ready'
    if (warmupElapsed < this.warmupSeconds) stateVal = 'warming'

    let feature: number | null = null
    if (ppm !== null && stateVal === 'ready') feature = ppm

    return {
      index,
      type: 'PAS',
      model: raw.sensor_model ?? null,
      eepromId: raw.eeprom_id ?? null,
      calibrationDate: raw.calibration_date ?? null,
      interface: 'i2c_3v3',
      warmupSeconds: this.warmupSeconds,
      state: stateVal,
      readings: {
        analogVolts: null,
        digitalValue: raw.readings?.digital_value ?? null,
        frequencyHz: null,
        currentUa: null,
        ppm,
        index: null,
        ph: null,
        unit: raw.readings?.unit ?? 'ppb',
        samples: raw.readings?.samples ?? undefined,
      },
      calibration,
      qcFlags: [],
      feature,
    }
  }
}
