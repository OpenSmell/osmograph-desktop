# Process sensors (pH, dissolved oxygen, redox)

A process sensor is a primary measurement of the batch, not a gas channel. pH is
the first supported case. It is deliberately outside `snapshot.channels` and
outside the MOX anomaly detector. The gas array never gets a pH coordinate, and
a pH probe never gets a vote in the gas change call.

## Contract

The host exposes process readings in `snapshot.process`, keyed by id:

```ts
interface HostProcessReading {
  id: string;                 // "ph"
  label: string;              // "pH"
  quantity: string;           // "pH"
  unit: string;               // "pH"
  value: number | null;
  at: number | null;
  source: 'probe' | 'manual' | 'none';
  calibration: {
    state: 'calibrated' | 'stale' | 'uncalibrated' | 'unknown';
    at: number | null;
    slope: number | null;
  };
  health: 'ok' | 'drift' | 'open' | 'short' | 'unknown';
}
```

`process` is optional and may be `null`. A Vial must fall back to its manual log
when it is absent. The host does not invent a process reading.

## Why it is separate

The MOX array is a cross-sensitive mixture detector. Its channels share a
baseline-relative response and a per-channel noise floor. pH has a different
unit, a different failure mode, and a different safety role. Putting pH in the
same array would:

- make the anomaly score depend on a calibrated process measurement;
- let a gas change "corroborate" a pH change, which is not evidence;
- hide a failed pH probe behind the array's noise band;
- make the detector's false-alarm rate depend on two unrelated instruments.

The contract therefore exposes process readings as a separate block, and the gas
detector consumes only the gas channel array. A mixed-rig ingest filter is not
implemented yet: until it is, do not place a process channel in the OSM array.
The Vial prefers `snapshot.process` and never treats a gas channel as pH.

## Calibration and safety

A pH probe is more safety-critical than the gas array. The host carries:

- the calibration state and time;
- the slope, so a flat or inverted probe is visible;
- a health state for open, short, drift, and unknown;
- the source, so a manual reading is never presented as a probe reading.

A Vial may gate an at-target call on `calibration.state === 'calibrated'`. It
must not treat a stale or uncalibrated reading as a pass. A high-pH low-acid
ferment remains a provisional stop even when the probe is uncalibrated; the
verdict asks for a fresh two-point calibration and a re-measure.

## Current status

The contract and the Vial consumer are implemented. A live pH probe driver,
firmware channel, and calibration fixture are not. The Vial falls back to the
manual log today. Do not claim a live pH measurement until a real probe trace
and a calibration record exist.
