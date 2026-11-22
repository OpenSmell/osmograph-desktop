// Catalytic bead / pellistor handler (combustibles, % LEL). Raw: analog bridge voltage.
// Feature: % LEL. Warmup: 90 s. QC: adc_saturation, baseline_drift, warmup_incomplete.

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
  { id: 'warmup_incomplete', enabled: true, label: 'Bead not yet thermally stable' },
]

export class CatalyticBeadHandler extends BaseSensorType {
  readonly type: SensorType = 'CatalyticBead'
  readonly warmupSeconds = 90
  readonly unit = '% LEL'
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
    const warmupElapsed = state.warmupSecondsElapsed + cycleDurationS
    let stateVal: 'warming' | 'ready' | 'fault' = 'ready'
    if (warmupElapsed < this.warmupSeconds) stateVal = 'warming'

    let feature: number | null = null
    if (av !== null) feature = av // % LEL requires calibration gas curve

    return {
      index,
      type: 'CatalyticBead',
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
