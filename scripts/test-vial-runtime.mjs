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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
