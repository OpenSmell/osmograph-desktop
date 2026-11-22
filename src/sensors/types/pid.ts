// PID (photoionization detector) handler.
//
// Raw signal: analog mV (divider) or digital ppb. Feature: ppb = mV × correction_factor.
// Warmup: 120 s. QC: adc_saturation, baseline_drift, warmup_incomplete.

import {
  BaseSensorType,
  type NormalizedSlot,
  type QcRule,
  type CalibrationData,
  type SlotState,
  type SensorType,
} from '../base'

const QC_RULES: QcRule[] = [
  { id: 'adc_saturation', enabled: true, label: 'ADC rail (0.0 V or 3.3 V × 2 cycles)' },
  { id: 'baseline_drift', enabled: true, label: 'Hold-phase slope > 0.05 mV/s' },
  { id: 'warmup_incomplete', enabled: true, label: 'Lamp not yet stabilized' },
]

export class PidHandler extends BaseSensorType {
  readonly type: SensorType = 'PID'
  readonly warmupSeconds = 120
  readonly unit = 'ppb'
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
    const ppbRaw = raw.readings?.ppm ?? null
    const cf = calibration.correction_factor ?? null

    const warmupElapsed = state.warmupSecondsElapsed + cycleDurationS
    let stateVal: 'warming' | 'ready' | 'fault' = 'ready'
    if (warmupElapsed < this.warmupSeconds) stateVal = 'warming'

    let feature: number | null = null
    if (ppbRaw !== null) {
      feature = ppbRaw
    } else if (av !== null && cf !== null) {
      feature = av * 1000 * cf // mV → ppb via correction factor
    } else if (av !== null) {
      feature = av
      stateVal = 'warming'
    }

    return {
      index,
      type: 'PID',
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
