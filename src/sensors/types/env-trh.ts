// Environmental T/RH handler (SHT31, etc.). Raw: digital °C / %RH.
// Feature: temperature and humidity passthrough. Warmup: 10 s.

import {
  BaseSensorType,
  type NormalizedSlot,
  type QcRule,
  type CalibrationData,
  type SlotState,
  type SensorType,
} from '../base'

const QC_RULES: QcRule[] = [
  { id: 'out_of_range', enabled: true, label: 'T/RH outside operating range' },
  { id: 'warmup_incomplete', enabled: true, label: 'Environmental sensor not yet ready' },
]

export class EnvTrhHandler extends BaseSensorType {
  readonly type: SensorType = 'Env_TRH'
  readonly warmupSeconds = 10
  readonly unit = '°C / %RH'
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
    const tempC = raw.readings?.analog_value_v ?? null // some T/RH stream analog
    const rhPct = raw.readings?.digital_value ?? null
    const warmupElapsed = state.warmupSecondsElapsed + cycleDurationS
    let stateVal: 'warming' | 'ready' | 'fault' = 'ready'
    if (warmupElapsed < this.warmupSeconds) stateVal = 'warming'
    if (tempC !== null && (tempC < -50 || tempC > 150)) stateVal = 'fault'
    if (rhPct !== null && (rhPct < 0 || rhPct > 100)) stateVal = 'fault'

    let feature: number | null = null
    if (tempC !== null) feature = tempC // primary feature = temperature
    else if (rhPct !== null) feature = rhPct

    return {
      index,
      type: 'Env_TRH',
      model: raw.sensor_model ?? null,
      eepromId: raw.eeprom_id ?? null,
      calibrationDate: raw.calibration_date ?? null,
      interface: 'i2c_3v3',
      warmupSeconds: this.warmupSeconds,
      state: stateVal,
      readings: {
        analogVolts: tempC,
        digitalValue: rhPct,
        frequencyHz: null,
        currentUa: null,
        ppm: null,
        index: null,
        ph: null,
        unit: raw.readings?.unit ?? '°C / %RH',
        samples: raw.readings?.samples ?? undefined,
      },
      calibration,
      qcFlags: [],
      feature,
    }
  }
}
