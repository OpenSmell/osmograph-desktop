// Electrochemical handler.
//
// Raw signal: current in µA (or analog mV via divider). Feature: ppm = (µA − offset) / sensitivity.
// Warmup: 90 s. QC: baseline_drift, out_of_range, warmup_incomplete.

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
  { id: 'out_of_range', enabled: true, label: 'Reading outside calibrated range' },
  { id: 'warmup_incomplete', enabled: true, label: 'Electrode not yet polarized' },
]

export class ElectrochemicalHandler extends BaseSensorType {
  readonly type: SensorType = 'Electrochemical'
  readonly warmupSeconds = 90
  readonly unit = 'ppm'
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
    const av = raw.readings?.analog_value_v ?? null
    const sens = calibration.sensitivity_nA_per_ppm ?? null
    const offset = calibration.zero_offset_ua ?? null

    const warmupElapsed = state.warmupSecondsElapsed + cycleDurationS
    let stateVal: 'warming' | 'ready' | 'fault' = 'ready'
    if (warmupElapsed < this.warmupSeconds) stateVal = 'warming'

    let feature: number | null = null
    if (currentUa !== null && sens !== null && sens !== 0) {
      feature = (currentUa - (offset ?? 0)) / sens
    } else if (av !== null) {
      feature = av
      stateVal = 'warming'
    }

    return {
      index,
      type: 'Electrochemical',
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
