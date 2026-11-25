// Mixed-type sensor normalization tests.
//
// Exercises the per-slot normalization pipeline (src/sensors/ingest.ts) with a
// mixed rig: MOX + NDIR + piezo + pH/ISFET + env T/RH + MEMS on the same rig.
// Verifies each type resolves its own unit, calibration curve, min/max range,
// and warmup without cross-contamination between types.

import assert from 'node:assert/strict';
import { normalizeSlot } from '../src/sensors/ingest.ts';
import { sensorProfiles } from '../src/sensors/profiles.ts';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? error.message : error);
  }
}

function defaultState() {
  return { warmupSecondsElapsed: 0 };
}

function rawSlot(type, model, readings, calibration = {}) {
  return { index: 0, sensor_type: type, sensor_model: model, eeprom_id: null, calibration_date: null, readings, calibration };
}

// ── Per-type unit resolution ──────────────────────────────────────────────

test('MOX resolves ΔR/R₀ unit and analog interface', () => {
  const { slot } = normalizeSlot(0, rawSlot('MOX', 'MQ-135', { analog_value_v: 1.65 }), defaultState(), 'intake', 1);
  assert.equal(slot.type, 'MOX');
  assert.equal(slot.interface, 'analog_5v');
  assert.equal(slot.profileKind, 'mox');
  assert.equal(slot.readings.unit, 'ΔR/R₀');
  assert.equal(slot.profileMin, 0);
  assert.equal(slot.vendorModel, 'MQ-135');
});

test('NDIR resolves ppm unit and i2c interface', () => {
  const { slot } = normalizeSlot(0, rawSlot('NDIR', 'SCD40', { ppm: 412 }), defaultState(), 'intake', 1);
  assert.equal(slot.type, 'NDIR');
  assert.equal(slot.interface, 'i2c_3v3');
  assert.equal(slot.profileKind, 'ndir');
  assert.equal(slot.readings.unit, 'ppm');
  assert.equal(slot.profileMin, 0);
  assert.equal(slot.profileMax, 100000);
});

test('PID resolves ppb unit and analog interface', () => {
  const { slot } = normalizeSlot(0, rawSlot('PID', 'Tiger', { analog_value_v: 0.33 }), defaultState(), 'intake', 1);
  assert.equal(slot.type, 'PID');
  assert.equal(slot.interface, 'analog_5v');
  assert.equal(slot.profileKind, 'pid');
  assert.equal(slot.readings.unit, 'ppb');
});

test('Galvanic resolves % O₂ unit', () => {
  const { slot } = normalizeSlot(0, rawSlot('Galvanic', 'O2-A2', { analog_value_v: 0.2 }), defaultState(), 'intake', 1);
  assert.equal(slot.type, 'Galvanic');
  assert.equal(slot.profileKind, 'galvanic');
  assert.equal(slot.readings.unit, '% O₂');
  assert.equal(slot.profileMin, 0);
  assert.equal(slot.profileMax, 25);
});

test('Catalytic bead resolves % LEL unit', () => {
  const { slot } = normalizeSlot(0, rawSlot('CatalyticBead', 'LEL', { analog_value_v: 0.1 }), defaultState(), 'intake', 1);
  assert.equal(slot.type, 'CatalyticBead');
  assert.equal(slot.profileKind, 'catalyticBead');
  assert.equal(slot.readings.unit, '% LEL');
  assert.equal(slot.profileMin, 0);
  assert.equal(slot.profileMax, 100);
});

test('QCM resolves Δf Hz profile unit and frequency interface', () => {
  const { slot } = normalizeSlot(0, rawSlot('QCM', 'QCM coated quartz', { digital_value: 5000000 }), defaultState(), 'intake', 1);
  assert.equal(slot.type, 'QCM');
  assert.equal(slot.interface, 'frequency');
  assert.equal(slot.profileKind, 'qcm');
  assert.equal(slot.profileUnit, 'Δf Hz');
});

test('SAW resolves Δf Hz profile unit', () => {
  const { slot } = normalizeSlot(0, rawSlot('SAW', 'SAW delay line', { digital_value: 433000000 }), defaultState(), 'intake', 1);
  assert.equal(slot.type, 'SAW');
  assert.equal(slot.profileKind, 'saw');
  assert.equal(slot.profileUnit, 'Δf Hz');
});

test('Cantilever resolves Δf Hz profile unit', () => {
  const { slot } = normalizeSlot(0, rawSlot('Cantilever', 'Microcantilever array', { digital_value: 100000 }), defaultState(), 'intake', 1);
  assert.equal(slot.type, 'Cantilever');
  assert.equal(slot.profileKind, 'cantilever');
  assert.equal(slot.profileUnit, 'Δf Hz');
});

test('Polymer resolves ΔR/R₀ unit', () => {
  const { slot } = normalizeSlot(0, rawSlot('Polymer', 'Chemiresistor polymer', { analog_value_v: 1.2 }), defaultState(), 'intake', 1);
  assert.equal(slot.type, 'Polymer');
  assert.equal(slot.profileKind, 'polymer');
  assert.equal(slot.readings.unit, 'ΔR/R₀');
});

test('Solid electrolyte resolves % O₂ unit', () => {
  const { slot } = normalizeSlot(0, rawSlot('SolidElectrolyte', 'Zirconia O₂', { analog_value_v: 0.45 }), defaultState(), 'intake', 1);
  assert.equal(slot.type, 'SolidElectrolyte');
  assert.equal(slot.profileKind, 'solidElectrolyte');
  assert.equal(slot.readings.unit, '% O₂');
  assert.equal(slot.profileMin, 0);
  assert.equal(slot.profileMax, 25);
});

test('pH/ISFET resolves pH unit with 0-14 range', () => {
  const { slot } = normalizeSlot(0, rawSlot('pH_ISFET', 'ISFET pH', { analog_value_v: 0.414 }), defaultState(), 'intake', 1);
  assert.equal(slot.type, 'pH_ISFET');
  assert.equal(slot.profileKind, 'phIsfet');
  assert.equal(slot.readings.unit, 'pH');
  assert.equal(slot.profileMin, 0);
  assert.equal(slot.profileMax, 14);
});

test('Env T/RH resolves °C/%RH unit', () => {
  const { slot } = normalizeSlot(0, rawSlot('Env_TRH', 'SHT31', { analog_value_v: 0.0 }), defaultState(), 'intake', 1);
  assert.equal(slot.type, 'Env_TRH');
  assert.equal(slot.profileKind, 'envTrh');
  assert.equal(slot.readings.unit, '°C / %RH');
  assert.equal(slot.profileMin, -40);
  assert.equal(slot.profileMax, 125);
});

test('MEMS resolves idx unit', () => {
  const { slot } = normalizeSlot(0, rawSlot('MEMS', 'SGP40', { digital_value: 100 }), defaultState(), 'intake', 1);
  assert.equal(slot.type, 'MEMS');
  assert.equal(slot.profileKind, 'mems');
  assert.equal(slot.readings.unit, 'idx');
  assert.equal(slot.profileMin, 0);
  assert.equal(slot.profileMax, 500);
});

test('Unknown type resolves raw unit', () => {
  const { slot } = normalizeSlot(0, rawSlot('Unknown', 'Mystery sensor', { analog_value_v: 0.5 }), defaultState(), 'intake', 1);
  assert.equal(slot.type, 'unknown');
  assert.equal(slot.profileKind, 'unknown');
  assert.equal(slot.readings.unit, 'raw');
});

// ── Mixed rig: no cross-contamination ─────────────────────────────────────

test('Mixed rig normalizes each slot independently with correct types', () => {
  const rig = [
    rawSlot('MOX', 'MQ-135', { analog_value_v: 1.65 }),
    rawSlot('NDIR', 'SCD40', { ppm: 412 }),
    rawSlot('PID', 'Tiger', { analog_value_v: 0.33 }),
    rawSlot('QCM', 'QCM coated quartz', { digital_value: 5000000 }),
    rawSlot('pH_ISFET', 'ISFET pH', { analog_value_v: 0.414 }),
    rawSlot('Env_TRH', 'SHT31', { analog_value_v: 0.0 }),
    rawSlot('MEMS', 'SGP40', { digital_value: 100 }),
    rawSlot('CatalyticBead', 'LEL', { analog_value_v: 0.1 }),
  ];
  const states = new Map();
  let phase = 'intake';
  let dur = 1;
  for (let i = 0; i < rig.length; i++) {
    const { slot, state } = normalizeSlot(i, rig[i], states.get(i) || defaultState(), phase, dur);
    states.set(i, state);
    // Each slot keeps its own type — no cross-contamination.
    assert.equal(slot.type, rig[i].sensor_type, `slot ${i} type`);
    assert.ok(slot.profileKind, `slot ${i} has profileKind`);
    assert.ok(slot.profileUnit, `slot ${i} has profileUnit`);
    assert.equal(slot.vendorModel, rig[i].sensor_model, `slot ${i} model`);
    // Each slot resolves its own unit — no cross-contamination.
    assert.ok(slot.readings.unit && slot.readings.unit !== 'raw', `slot ${i} has non-raw unit: ${slot.readings.unit}`);
  }
  assert.equal(states.size, rig.length, 'all slots tracked');
});

// ── Profile registry coverage ─────────────────────────────────────────────

test('Registry covers the core sensor kinds', () => {
  const kinds = sensorProfiles.kinds();
  assert.ok(kinds.includes('mox'));
  assert.ok(kinds.includes('ndir'));
  assert.ok(kinds.includes('pid'));
  assert.ok(kinds.includes('phIsfet'));
  assert.ok(kinds.includes('envTrh'));
  assert.ok(kinds.includes('mems'));
  assert.ok(kinds.includes('unknown'));
  assert.ok(kinds.length > 10, `expected more than 10 kinds, got ${kinds.length}`);
});

test('Model inference maps MQ-135 to mox, SCD40 to ndir, SGP40 to mems', () => {
  const mq = sensorProfiles.getByModel('MQ-135');
  assert.ok(mq, 'MQ-135 found');
  assert.equal(mq.kind, 'mox');
  const scd = sensorProfiles.getByModel('SCD40');
  assert.ok(scd, 'SCD40 found');
  assert.equal(scd.kind, 'ndir');
  const sgp = sensorProfiles.getByModel('SGP40');
  assert.ok(sgp, 'SGP40 found');
  assert.equal(sgp.kind, 'mems');
  const isfet = sensorProfiles.getByModel('ISFET pH');
  assert.ok(isfet, 'ISFET pH found');
  assert.equal(isfet.kind, 'phIsfet');
  const tiger = sensorProfiles.getByModel('Tiger');
  assert.ok(tiger, 'Tiger found');
  assert.equal(tiger.kind, 'pid');
});

// ── Warmup tracking ───────────────────────────────────────────────────────

test('MOX reports warming until 300s elapsed (with calibration)', () => {
  let st = defaultState();
  let sl;
  const cal = { r0_ohm: 10000, load_resistor_ohm: 10000 };
  ({ slot: sl, state: st } = normalizeSlot(0, rawSlot('MOX', 'MQ-135', { analog_value_v: 1.65 }, cal), st, 'intake', 1));
  assert.equal(sl.state, 'warming');
  ({ slot: sl, state: st } = normalizeSlot(0, rawSlot('MOX', 'MQ-135', { analog_value_v: 1.65 }, cal), st, 'intake', 300));
  assert.equal(sl.state, 'ready');
});

test('NDIR reports ready after 60s', () => {
  let st = defaultState();
  let sl;
  ({ slot: sl, state: st } = normalizeSlot(0, rawSlot('NDIR', 'SCD40', { ppm: 412 }), st, 'intake', 60));
  assert.equal(sl.state, 'ready');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
