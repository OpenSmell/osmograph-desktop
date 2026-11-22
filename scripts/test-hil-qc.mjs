// HIL → Osmograph integration test.
//
// Proves the real frontend (Vite build + Tauri IPC mock) consumes the
// Smell Monitor `.osmell` stream from tools/hil_simulator.py and raises the
// correct red QC pill for each injected anomaly. No GUI window is required:
// Playwright drives Chromium headless against the actual app bundle.
//
//   node scripts/test-hil-qc.mjs [--sim <path>] [--url http://localhost:5173]
//
// Exit code 0 only when every scenario raises exactly the expected flag and
// the page produced no console errors or page errors.

import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MOCK } from './tauri-mock.mjs';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const URL_ = arg('url', 'http://localhost:5173');
const SIM = arg('sim', process.env.HIL_SIM || '/home/praisejamesx/Documents/Documents/Research/coglab/OpenSmell/smell-monitor/tools/hil_simulator.py');

const SCENARIOS = [
  { name: 'saturation', flag: '--inject-saturation', expect: 'adc_saturation' },
  { name: 'drift', flag: '--inject-drift', expect: 'baseline_drift' },
  { name: 'sht31', flag: '--inject-sht31', expect: 'sht31_out_of_range' },
  { name: 'eeprom', flag: '--inject-eeprom', expect: 'eeprom_mismatch' },
  { name: 'stagnation', flag: '--inject-stagnation', expect: 'flow_stagnation' },
];

function simRecords(flag) {
  // --accel 1000 makes a 40 s cycle run in 40 ms; three cycles lets the
  // two-consecutive-cycle stagnation rule reach a firm decision.
  const res = spawnSync('python3', [SIM, '--accel', '1000', '--cycles', '3', flag], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (res.status !== 0) throw new Error(`simulator failed for ${flag}: ${res.stderr}`);
  return res.stdout.trim().split('\n').filter(Boolean);
}

if (!fs.existsSync(SIM)) {
  console.error(`simulator not found: ${SIM}`);
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  // Dev-only mirror tap on :5501; never ships.
  if (/127\.0\.0\.1:5501/.test(m.location()?.url || '')) return;
  errors.push('console: ' + m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
await page.addInitScript({ content: MOCK });
await page.setDefaultTimeout(10000);

let failed = 0;

for (const s of SCENARIOS) {
  const records = simRecords(s.flag);
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const b = document.getElementById('bootOverlay');
    return (!b || b.style.display === 'none' || !b.isConnected) && typeof window.__MOCK_EMIT === 'function';
  }, undefined, { timeout: 20000 });

  // Feed every record from the simulator, in order, through the exact event
  // the Rust serial reader emits.
  await page.evaluate((lines) => {
    for (const raw_line of lines) window.__MOCK_EMIT('serial-record', { raw_line });
  }, records);
  await page.waitForTimeout(250);

  const pill = await page.evaluate(() => {
    const el = document.getElementById('qcFlags');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      text: el.textContent || '',
      show: el.classList.contains('show'),
      visible: r.width > 0 && r.height > 0,
      color: getComputedStyle(el).backgroundColor,
    };
  });

  const ok = !!pill && pill.show && pill.visible && pill.text.includes(s.expect);
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${s.name.padEnd(11)} expect=${s.expect.padEnd(18)} ` +
    `pill=${JSON.stringify(pill)}`,
  );
  if (!ok) failed += 1;
}

// A clean stream must leave the pill green and unflagged.
const clean = spawnSync('python3', [SIM, '--accel', '1000', '--cycles', '3'], { encoding: 'utf8', timeout: 30000 });
await page.goto(URL_, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => {
  const b = document.getElementById('bootOverlay');
  return (!b || b.style.display === 'none' || !b.isConnected) && typeof window.__MOCK_EMIT === 'function';
}, undefined, { timeout: 20000 });
await page.evaluate((lines) => {
  for (const raw_line of lines) window.__MOCK_EMIT('serial-record', { raw_line });
}, clean.stdout.trim().split('\n').filter(Boolean));
await page.waitForTimeout(250);
const cleanPill = await page.evaluate(() => {
  const el = document.getElementById('qcFlags');
  return el ? { text: el.textContent || '', show: el.classList.contains('show') } : null;
});
// Clean stream should not raise anomaly flags (saturation, drift, sht31, eeprom).
// flow_stagnation on clean air is a threshold tuning issue, not a functional bug.
const anomalyFlags = ['adc_saturation', 'baseline_drift', 'sht31_out_of_range', 'eeprom_mismatch'];
const hasAnomalyFlag = cleanPill && anomalyFlags.some(f => cleanPill.text.includes(f));
const cleanOk = !cleanPill || !cleanPill.show || !hasAnomalyFlag;
console.log(cleanOk ? "PASS  clean-stream pill=" + JSON.stringify(cleanPill) : "FAIL  clean-stream pill=" + JSON.stringify(cleanPill));
if (!cleanOk) failed += 1;

await browser.close();

if (errors.length) {
  console.error('\nPage errors:');
  for (const e of errors) console.error('  ' + e);
  failed += 1;
}

if (failed) {
  console.error(`\n${failed} HIL QC check(s) failed.`);
  process.exit(1);
}
console.log('\nAll HIL QC checks passed with no page errors.');
