// Unknown handler. Fallback when the cartridge EEPROM is blank or unreadable.
// Raw: whatever is available. Feature: raw value passthrough. Marked warming until calibrated.

import {
  BaseSensorType,
  type NormalizedSlot,
  type QcRule,
  type CalibrationData,
  type SlotState,
  type SensorType,
} from '../base'

const QC_RULES: QcRule[] = [
  { id: 'eeprom_mismatch', enabled: true, label: 'No cartridge ID chip detected' },
  { id: 'warmup_incomplete', enabled: true, label: 'Sensor type not yet identified' },
]

export class UnknownHandler extends BaseSensorType {
  readonly type: SensorType = 'unknown'
  readonly warmupSeconds = 600
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
    let stateVal: 'warming' | 'ready' | 'fault' = 'warming'

    let feature: number | null = null
    if (dv !== null) feature = dv
    else if (av !== null) feature = av

    return {
      index,
      type: 'unknown',
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
