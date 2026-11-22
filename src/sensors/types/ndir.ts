// NDIR (non-dispersive infrared) handler.
//
// Raw signal: digital ppm (already compensated). Feature: ppm.
// Warmup: 60 s. QC: out_of_range, warmup_incomplete.

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
  { id: 'warmup_incomplete', enabled: true, label: 'Sensor not yet warmed up' },
]

export class NdirHandler extends BaseSensorType {
  readonly type: SensorType = 'NDIR'
  readonly warmupSeconds = 60
  readonly unit = 'ppm'
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
    if (ppm !== null && (ppm < 0 || ppm > 100000)) stateVal = 'fault'

    let feature: number | null = null
    if (ppm !== null && stateVal === 'ready') feature = ppm

    return {
      index,
      type: 'NDIR',
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
        unit: raw.readings?.unit ?? 'ppm',
        samples: raw.readings?.samples ?? undefined,
      },
      calibration,
      qcFlags: [],
      feature,
    }
  }
}
