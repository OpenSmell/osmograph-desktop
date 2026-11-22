// "other" handler. Catch-all for sensor types that don't match a known family.
// Raw: whatever the cartridge sends. Feature: raw value passthrough.

import {
  BaseSensorType,
  type NormalizedSlot,
  type QcRule,
  type CalibrationData,
  type SlotState,
  type SensorType,
} from '../base'

const QC_RULES: QcRule[] = [
  { id: 'out_of_range', enabled: false, label: 'Reading outside expected range' },
  { id: 'warmup_incomplete', enabled: false, label: 'Sensor warmup incomplete' },
]

export class OtherHandler extends BaseSensorType {
  readonly type: SensorType = 'other'
  readonly warmupSeconds = 60
  readonly unit = 'raw'
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
    const dv = raw.readings?.digital_value ?? null
    const warmupElapsed = state.warmupSecondsElapsed + cycleDurationS
    let stateVal: 'warming' | 'ready' | 'fault' = 'ready'
    if (warmupElapsed < this.warmupSeconds) stateVal = 'warming'

    let feature: number | null = null
    if (dv !== null) feature = dv
    else if (av !== null) feature = av

    return {
      index,
      type: 'other',
      model: raw.sensor_model ?? null,
      eepromId: raw.eeprom_id ?? null,
      calibrationDate: raw.calibration_date ?? null,
      interface: 'analog_5v',
      warmupSeconds: this.warmupSeconds,
      state: stateVal,
      readings: {
        analogVolts: av,
        digitalValue: dv,
        frequencyHz: null,
        currentUa: null,
        ppm: null,
        index: null,
        ph: null,
        unit: raw.readings?.unit ?? 'raw',
        samples: raw.readings?.samples ?? undefined,
      },
      calibration,
      qcFlags: [],
      feature,
    }
  }
}
