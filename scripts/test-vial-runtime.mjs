// Runtime contract tests. Node 24 can import the TypeScript module directly
// with --experimental-strip-types, so this test exercises the same sandbox
// builder and payload helpers the desktop app uses.
import assert from 'node:assert/strict';

const runtime = await import('../src/vialRuntime.ts');
const profileModule = await import('../src/vialProfile.ts');

// The desktop test owns the runtime contract, not any author's Vial. A real Vial
// project validates its own fragments; keeping a fixture here means the test
// still runs when no Vial project is checked out beside this repository.
const runtimeFixture = `<div id="runtime-test"></div>
<script>
  const bridge = window.osmograph;
  bridge.onData(function (data) {
    document.getElementById('runtime-test').textContent = data.view || '';
  });
  bridge.action({ type: 'toast', message: 'runtime fixture' });
  bridge.ready();
</script>`;

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

for (const [name, html] of [['runtime-fixture', runtimeFixture]]) {
  test(`${name}: sandboxable fragment`, () => {
    assert.doesNotThrow(() => runtime.assertSandboxableUi(html));
    assert.match(html, /bridge\.onData/);
    assert.match(html, /bridge\.ready/);
    assert.match(html, /bridge\.action/);
    assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/i, 'UI must not load network resources');
    assert.doesNotMatch(html, /\blocalStorage\b/, 'UI must not use storage directly');
    assert.doesNotMatch(html, /\bfetch\s*\(/, 'UI must not fetch');
    assert.doesNotMatch(html, /\bXMLHttpRequest\b/, 'UI must not use XHR');
  });

  test(`${name}: inline scripts parse`, () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(scripts.length > 0, 'expected an inline script');
    for (const script of scripts) {
      assert.doesNotThrow(() => new Function(script), 'inline script should parse');
    }
  });
}

test('sandbox document blocks network, storage, forms, and frames', () => {
  const doc = runtime.buildSandboxDocument(runtimeFixture, 'nonce-123');
  assert.match(doc, /default-src 'none'/);
  assert.match(doc, /connect-src 'none'/);
  assert.match(doc, /form-action 'none'/);
  assert.match(doc, /frame-src 'none'/);
  assert.match(doc, /script-src 'unsafe-inline'/);
  assert.match(doc, /window\.osmograph/);
  assert.match(doc, /nonce-123/);
  assert.match(doc, /vialData/);
});

test('sandbox rejects a full document', () => {
  assert.throws(() => runtime.assertSandboxableUi('<html><body>hello</body></html>'), /body fragment/i);
});

test('sandbox rejects remote scripts', () => {
  assert.throws(() => runtime.assertSandboxableUi('<script src="https://evil.example/x.js"></script>'), /cannot load external/i);
});

test('sandbox rejects javascript URLs', () => {
  assert.throws(() => runtime.assertSandboxableUi('<a href="javascript:alert(1)">x</a>'), /javascript/i);
});

test('profile admissibility refuses a warming baseline and low coverage', () => {
  const profile = structuredClone(profileModule.VIAL_PROFILE_DEFAULTS);
  profile.detection.perChannelLimits = { ch0: 0.1, ch1: 0.1 };
  profile.admissibility.minCoverage = 0.5;
  const warming = profileModule.profileAdmissibility(profile, {
    baselineState: 'warming',
    channelLive: { ch0: true, ch1: true },
  });
  assert.equal(warming.admissible, false);
  assert.match(warming.reason, /baseline/i);
  const half = profileModule.profileAdmissibility(profile, {
    baselineState: 'ready',
    channelLive: { ch0: true, ch1: false },
  });
  assert.equal(half.admissible, true);
  const none = profileModule.profileAdmissibility(profile, {
    baselineState: 'ready',
    channelLive: { ch0: false, ch1: false },
  });
  assert.equal(none.admissible, false);
  assert.match(none.reason, /coverage/i);
});

test('profile maps corroboration and persistence into the host detector', () => {
  const profile = structuredClone(profileModule.VIAL_PROFILE_DEFAULTS);
  profile.baseline.warmupS = 180;
  profile.detection.minChannels = 2;
  profile.detection.sensitivity = 1;
  profile.detection.levelBudget = 4;
  profile.detection.levelRefS = 0;
  profile.detection.hysteresis = 0.25;
  profile.detection.escalation = {
    warningS: 90,
    criticalS: 600,
    emergencyS: 1800,
    resetNormalS: 900,
  };
  const config = profileModule.profileToDetectorConfig(profile);
  assert.equal(config.warmup_s, 180);
  assert.equal(config.min_channels, 2);
  assert.equal(config.level_budget, 4);
  assert.equal(config.level_ref_s, 0);
  assert.equal(config.warning_s, 90);
  assert.equal(config.critical_s, 600);
  assert.equal(config.emergency_s, 1800);
  assert.equal(config.reset_normal_s, 900);
  assert.equal(config.hysteresis, 0.25);
});

test('profile band gate requires minChannels and the confidence floor', () => {
  const ids = ['ch0', 'ch1', 'ch2'];
  const limits = { ch0: 0.1, ch1: 0.1, ch2: 0.1 };
  const responses = [
    [0.2, 0.25],
    [0.01, 0.02],
    [0.03, 0.04],
  ];
  const one = profileModule.evaluateBandDetection(true, 0.5, 2, limits, ids, responses, 0.9);
  assert.equal(one.active, false, 'one channel must not satisfy minChannels=2');
  assert.deepEqual(one.triggeredChannels, ['ch0']);

  responses[1] = [0.0, 0.2];
  const two = profileModule.evaluateBandDetection(true, 0.5, 2, limits, ids, responses, 0.9);
  assert.equal(two.active, true);
  assert.deepEqual(two.triggeredChannels, ['ch0', 'ch1']);

  const lowConfidence = profileModule.evaluateBandDetection(true, 0.8, 2, limits, ids, responses, 0.4);
  assert.equal(lowConfidence.active, false, 'confidence below the profile floor must refuse');

  const disabled = profileModule.evaluateBandDetection(false, 0.5, 2, limits, ids, responses, 0.9);
  assert.equal(disabled.active, false, 'a disabled profile must not arm');

  const missing = profileModule.evaluateBandDetection(true, 0.5, 1, { ch9: 0.1 }, ids, responses, 0.9);
  assert.equal(missing.active, false, 'a limit for an unknown channel must not invent a trigger');
});

test('profile coverage floor applies to all channels when no bands are declared', () => {
  const profile = structuredClone(profileModule.VIAL_PROFILE_DEFAULTS);
  profile.admissibility.minCoverage = 0.8;
  const half = profileModule.profileAdmissibility(profile, {
    baselineState: 'ready',
    channelLive: { ch0: true, ch1: false },
  });
  assert.equal(half.admissible, false);
  assert.match(half.reason, /coverage/i);
  const all = profileModule.profileAdmissibility(profile, {
    baselineState: 'ready',
    channelLive: { ch0: true, ch1: true },
  });
  assert.equal(all.admissible, true);
});

test('sandbox rejects an unknown osmograph method', () => {
  assert.throws(() => runtime.assertSandboxableUi('<script>osmograph.getSnapshot()</script>'), /unknown osmograph method/i);
});

test('sandbox rejects network, storage, and code evaluation', () => {
  assert.throws(() => runtime.assertSandboxableUi('<script>fetch("/x")</script>'), /network/i);
  assert.throws(() => runtime.assertSandboxableUi('<script>localStorage.setItem("x", "1")</script>'), /storage/i);
  assert.throws(() => runtime.assertSandboxableUi('<script>eval("1")</script>'), /evaluate strings/i);
});

test('downsample keeps a bounded window and preserves nulls', () => {
  const values = [
    Array.from({ length: 5000 }, (_, i) => i),
    Array.from({ length: 5000 }, (_, i) => (i % 7 === 0 ? NaN : i * 2)),
    [],
  ];
  const sampled = runtime.downsampleChannels(values, 120);
  assert.ok(sampled.indices.length <= 121);
  assert.equal(sampled.values.length, 3);
  assert.equal(sampled.values[0].length, sampled.indices.length);
  assert.ok(sampled.values[1].some(v => v === null), 'NaN should become null');
});

test('fingerprint is baseline-relative and JSON-safe', () => {
  const channel = Array.from({ length: 100 }, (_, i) => 100 + i);
  const fp = runtime.fingerprintFromSeries([channel]);
  assert.equal(fp.length, 1);
  assert.ok(fp[0] !== null && fp[0] > 0, 'a rising channel should have a positive fingerprint');
  assert.doesNotThrow(() => JSON.stringify(fp));
});

test('evolution is bounded and signed', () => {
  const channel = Array.from({ length: 100 }, (_, i) => 100 - i * 0.2);
  const evo = runtime.evolutionFromSeries([channel], 32);
  assert.equal(evo.bins, 32);
  assert.equal(evo.values.length, 1);
  assert.equal(evo.values[0].length, 32);
  assert.ok(evo.maxAbs > 0);
  assert.doesNotThrow(() => JSON.stringify(evo));
});

test('action envelope accepts a valid log action', () => {
  const parsed = runtime.parseVialActionEnvelope({
    nonce: 'n',
    vialAction: { type: 'add-log', values: { ph: '3.8', temp: 21 } },
  });
  assert.equal(parsed?.vialAction.type, 'add-log');
  assert.equal(parsed?.vialAction.values.ph, '3.8');
  assert.equal(parsed?.vialAction.values.temp, '21');
});

test('action envelope accepts opening the Vial workspace from Home', () => {
  const parsed = runtime.parseVialActionEnvelope({
    nonce: 'n',
    vialAction: { type: 'open-workspace' },
  });
  assert.equal(parsed?.vialAction.type, 'open-workspace');
});

test('action envelope rejects prototype keys and unknown types', () => {
  assert.equal(runtime.parseVialActionEnvelope({ nonce: 'n', vialAction: { type: 'save-field', key: '__proto__', value: 'x' } }), null);
  assert.equal(runtime.parseVialActionEnvelope({ nonce: 'n', vialAction: { type: 'eval', code: 'x' } }), null);
  assert.equal(runtime.parseVialActionEnvelope({ vialAction: { type: 'ready' } }), null);
});

test('action envelope clamps resize and truncates toast text', () => {
  const resized = runtime.parseVialActionEnvelope({ nonce: 'n', vialAction: { type: 'resize', height: 99999 } });
  assert.equal(resized?.vialAction.height, 2000);
  const toast = runtime.parseVialActionEnvelope({ nonce: 'n', vialAction: { type: 'toast', message: 'x'.repeat(5000) } });
  assert.equal(toast?.vialAction.message.length, 400);
});

test('action envelope accepts host requests with null params', () => {
  const parsed = runtime.parseVialActionEnvelope({
    nonce: 'n',
    vialAction: { type: 'host-request', requestId: 'r1', request: 'action', action: 'journal-events', params: null },
  });
  assert.equal(parsed?.vialAction.type, 'host-request');
  assert.equal(parsed?.vialAction.action, 'journal-events');
  const bad = runtime.parseVialActionEnvelope({
    nonce: 'n',
    vialAction: { type: 'host-request', requestId: 'r2', request: 'action', action: 'journal-events', params: 'x' },
  });
  assert.equal(bad, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
