// MOX (metal-oxide semiconductor) handler.
//
// Raw signal: analog voltage after fixed 2:1 divider. Feature: ΔR/R₀.
// Warmup: 300 s (MOX heaters need thermal stabilization).
// QC: adc_saturation, baseline_drift, flow_stagnation, warmup_incomplete.

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
  { id: 'flow_stagnation', enabled: true, label: 'Intake flat × 2 cycles (stuck cell / blocked flow)' },
  { id: 'warmup_incomplete', enabled: true, label: 'Heater not yet thermally stable' },
]

export class MoxHandler extends BaseSensorType {
  readonly type: SensorType = 'MOX'
  readonly warmupSeconds = 300
  readonly unit = 'ΔR/R₀'
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
    const r0 = calibration.r0_ohm ?? null
    const loadR = calibration.load_resistor_ohm ?? null

    let feature: number | null = null
    let stateVal: 'warming' | 'ready' | 'fault' = 'ready'

    // Warmup tracking.
    const warmupElapsed = state.warmupSecondsElapsed + cycleDurationS
    if (warmupElapsed < this.warmupSeconds) stateVal = 'warming'

    // Convert voltage to resistance: Rₛ = V / (Vcc − V) × Rₗ
    // Vcc = 5 V, divider halves it at the ADC node, slot volts = 2 × node.
    // So divider output at ADC node = av / 2. Rₛ = (av/2) / (3.3 − av/2) × Rₗ
    // But the divider is fixed; we can compute ΔR/R₀ directly if R₀ is known.
    if (av !== null && r0 !== null && loadR !== null && r0 > 0 && loadR > 0) {
      const vcc = 5.0
      const nodeV = av / 2.0
      if (nodeV >= 0 && nodeV < vcc) {
        const rs = (nodeV / (vcc - nodeV)) * loadR
        feature = (rs - r0) / r0
      } else {
        // Rail or out of range.
        stateVal = 'fault'
        feature = null
      }
    } else if (av !== null) {
      // No R₀ yet — feature is raw voltage, marked warming until calibrated.
      feature = av
      stateVal = 'warming'
    }

    return {
      index,
      type: 'MOX',
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

  validateCalibration(calibration: CalibrationData): string[] {
    const problems: string[] = []
    if (calibration.r0_ohm != null && calibration.r0_ohm <= 0)
      problems.push('r0_ohm must be positive')
    if (calibration.load_resistor_ohm != null && calibration.load_resistor_ohm <= 0)
      problems.push('load_resistor_ohm must be positive')
    return problems
  }
}
