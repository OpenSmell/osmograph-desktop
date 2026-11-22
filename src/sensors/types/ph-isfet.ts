// pH / ISFET handler. Raw: analog mV. Feature: pH = (mV − offset) / slope.
// Warmup: 60 s. QC: warmup_incomplete, out_of_range.

import {
  BaseSensorType,
  type NormalizedSlot,
  type QcRule,
  type CalibrationData,
  type SlotState,
  type SensorType,
} from '../base'

const QC_RULES: QcRule[] = [
  { id: 'warmup_incomplete', enabled: true, label: 'ISFET not yet stabilized' },
  { id: 'out_of_range', enabled: true, label: 'pH outside 0–14 range' },
]

export class PhIsfetHandler extends BaseSensorType {
  readonly type: SensorType = 'pH_ISFET'
  readonly warmupSeconds = 60
  readonly unit = 'pH'
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
    const offset = calibration.ph_offset_mv ?? null
    const slope = calibration.ph_slope_mv_per_ph ?? null
    const warmupElapsed = state.warmupSecondsElapsed + cycleDurationS
    let stateVal: 'warming' | 'ready' | 'fault' = 'ready'
    if (warmupElapsed < this.warmupSeconds) stateVal = 'warming'

    let feature: number | null = null
    if (av !== null && offset !== null && slope !== null && slope !== 0) {
      // Convert V to mV, then pH = (mV − offset) / slope
      const mv = av * 1000
      feature = (mv - offset) / slope
      if (feature !== null && (feature < 0 || feature > 14)) stateVal = 'fault'
    } else if (av !== null) {
      feature = av
      stateVal = 'warming'
    }

    return {
      index,
      type: 'pH_ISFET',
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
        currentUa: null,
        ppm: null,
        index: null,
        ph: feature,
        unit: raw.readings?.unit ?? 'V',
        samples: raw.readings?.samples ?? undefined,
      },
      calibration,
      qcFlags: [],
      feature,
    }
  }
}
