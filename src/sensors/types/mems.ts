// MEMS handler (BME688, SGP4x, etc.). Raw: digital index / ppb (opaque).
// Feature: index passthrough. Warmup: 30 s. QC: out_of_range, warmup_incomplete.

import {
  BaseSensorType,
  type NormalizedSlot,
  type QcRule,
  type CalibrationData,
  type SlotState,
  type SensorType,
} from '../base'

const QC_RULES: QcRule[] = [
  { id: 'out_of_range', enabled: true, label: 'Index outside expected range' },
  { id: 'warmup_incomplete', enabled: true, label: 'MEMS element not yet stabilized' },
]

export class MemsHandler extends BaseSensorType {
  readonly type: SensorType = 'MEMS'
  readonly warmupSeconds = 30
  readonly unit = 'idx'
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
    const idx = raw.readings?.index ?? null
    const ppm = raw.readings?.ppm ?? null
    const warmupElapsed = state.warmupSecondsElapsed + cycleDurationS
    let stateVal: 'warming' | 'ready' | 'fault' = 'ready'
    if (warmupElapsed < this.warmupSeconds) stateVal = 'warming'

    let feature: number | null = null
    if (idx !== null) feature = idx
    else if (ppm !== null) feature = ppm

    return {
      index,
      type: 'MEMS',
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
        ppm: null,
        index: idx,
        ph: null,
        unit: raw.readings?.unit ?? 'idx',
        samples: raw.readings?.samples ?? undefined,
      },
      calibration,
      qcFlags: [],
      feature,
    }
  }
}
