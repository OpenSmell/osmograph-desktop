// UI harness: drives the real frontend (Vite dev server) with a faithful Tauri
// IPC mock, a synthetic 6-channel MOX rig, and screenshots every tab/view.
// Purpose: actually SEE and operate the UI instead of guessing from source.
//
//   node scripts/ui-harness.mjs [--url http://localhost:5173] [--out /tmp/opencode/ui]
//
// Not a test suite — it produces (a) screenshots for human/model review and
// (b) a console-error report. Failures to render loudly beat silent lies.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const URL_ = arg('url', 'http://localhost:5173');
const OUT = arg('out', '/tmp/opencode/ui');
fs.mkdirSync(OUT, { recursive: true });

const CH = ['MQ-135', 'MQ-3', 'MQ-6', 'MQ-7', 'MQ-4', 'MQ-8'];
const now = Date.now();

const MOCK = String.raw`
(() => {
  const CH = ${JSON.stringify(CH)};
  const NOW = ${now};
  const listeners = new Map();   // event -> Set(handlerId)
  const callbacks = new Map();   // id -> fn
  let nextId = 1;

  const mkSeries = (base, jitter) => {
    const n = 450, t0 = NOW - 60_000;
    const time = Array.from({ length: n }, (_, i) => t0 + i * 100);
    const values = CH.map((_, ci) => {
      const r0 = base + ci * 320;
      // baseline 0-18s, exposure ramp 18-38s, recovery 38-60s
      return time.map((_, i) => {
        const s = i * 0.1;
        let resp = 0;
        if (s >= 18 && s < 38) resp = (0.05 + ci * 0.035) * (1 - Math.exp(-(s - 18) / 2.5));
        else if (s >= 38) resp = (0.05 + ci * 0.035) * Math.exp(-(s - 38) / 9);
        const noise = (Math.sin(i * 1.7 + ci * 2.1) + Math.cos(i * 0.37 + ci)) * jitter;
        return r0 * (1 + resp) + noise;
      });
    });
    return { label: 'coffee', channels: CH.slice(), time, values };
    void jitter;
  };

  const sessions = [
    { file_id: 'h1', substance: 'coffee', label: 'coffee', timestamp: NOW - 3_600_000, duration_sec: 60, sensor_count: 6, quality: 82, csv_path: '/tmp/opencode/ui/coffee.csv', quality_report: null },
    { file_id: 'h2', substance: 'mint', label: 'mint', timestamp: NOW - 10_800_000, duration_sec: 60, sensor_count: 6, quality: 74, csv_path: '/tmp/opencode/ui/mint.csv', quality_report: null },
    { file_id: 'h3', substance: 'ethanol', label: 'ethanol', timestamp: NOW - 93_600_000, duration_sec: 60, sensor_count: 6, quality: 68, csv_path: '/tmp/opencode/ui/ethanol.csv', quality_report: null },
  ];

  const health = CH.map((_, i) => ({
    channel: i, health_score: 92 - i * 3, mean: 2000 + i * 320, std: 12 + i,
    cv: 0.006 + i * 0.001, noise_floor: 10 + i, drift_rate: 0.0008,
    stuck: false, status: i === 4 ? 'noisy' : 'ok',
    recommendation: i === 4 ? 'Noise above the rig median — check wiring.' : 'Healthy.',
  }));

  const emit = (event, payload) => {
    const ids = listeners.get(event);
    if (!ids) return;
    for (const id of ids) {
      const cb = callbacks.get(id);
      if (cb) { try { cb({ event, id: 0, payload }); } catch (e) { console.error('listener error', event, e); } }
    }
  };
  window.__MOCK_EMIT = emit;

  const ok = (v) => Promise.resolve(v);
  const handle = (cmd, a) => {
    switch (cmd) {
      case 'plugin:event|listen': {
        const set = listeners.get(a.event) || new Set();
        set.add(a.handler);
        listeners.set(a.event, set);
        return ok(1);
      }
      case 'plugin:event|unlisten': {
        listeners.get(a.event)?.delete(a.handler);
        return ok(null);
      }
      case 'plugin:app|version': return ok('0.1.1');
      case 'plugin:os|platform': return ok('linux');
      case 'get_data_dir': return ok('/tmp/opencode/ui/data');
      case 'get_recordings_dir': return ok('/tmp/opencode/ui/data/recordings');
      case 'get_plugins_dir': return ok('/tmp/opencode/ui/data/plugins');
      case 'dataset_dir': return ok('/tmp/opencode/ui/data/datasets');
      case 'get_session_index': return ok(sessions);
      case 'import_recordings': return ok(0);
      case 'load_session_series': {
        const i = ['h1', 'h2', 'h3'].indexOf(a.fileId);
        return ok(mkSeries(1800 + (i < 0 ? 0 : i) * 150, 2.5));
      }
      case 'assess_recording_health': return ok(health);
      case 'get_sensor_health': return ok(health);
      case 'list_serial_ports': return ok([{ name: '/dev/ttyACM0', description: 'Harness rig (mock)', kind: 'serial', hw_type: 'usb', manufacturer: 'OpenSmell' }]);
      case 'connect_serial': return ok(null);
      case 'disconnect_serial': return ok(null);
      case 'get_phase_recorder_state': return ok({ active: false, phase: 'idle', phase_name: '', elapsed_sec: 0, remaining_sec: 0, sample_count: 0, phases: [] });
      case 'load_live_classifier': return ok(null);
      case 'list_classifiers': return ok([]);
      case 'check_for_updates': return ok({ available: false });
      case 'fleet_scan': return ok({ devices: [] });
      case 'hub_list': return ok([]);
      case 'hf_has_token': return ok(false);
      case 'burnin_status': return ok({ total_hours: 24, elapsed_seconds: 0, remaining_seconds: 86400, remaining_hours: 24, is_complete: false, running: false });
      case 'list_recent_events': return ok([]);
      case 'get_change_log': return ok([]);
      default: return ok(null);
    }
  };

  window.__TAURI_INTERNALS__ = {
    callbacks,
    transformCallback(cb, once = false) {
      const id = nextId++;
      callbacks.set(id, once ? (...x) => { callbacks.delete(id); cb(...x); } : cb);
      return id;
    },
    invoke: (cmd, a) => handle(cmd, a),
    convertFileSrc: (p) => p,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  };
})();
`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

await page.addInitScript({ content: MOCK });
await page.goto(URL_, { waitUntil: 'domcontentloaded' });
// Boot overlay is removed when init completes; cap the wait so a hang is visible.
await page.waitForFunction(() => {
  const b = document.getElementById('bootOverlay');
  return !b || b.style.display === 'none' || !b.isConnected;
}, undefined, { timeout: 20000 }).catch(() => errors.push('BOOT: overlay never cleared'));

const shot = async (name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
};

await shot('01-boot');

// Connect the synthetic rig through the real Connect button path.
await page.evaluate(() => {
  const sel = document.getElementById('portSelect');
  if (sel) sel.value = '/dev/ttyACM0';
});
await page.click('#connectBtn').catch(() => errors.push('click #connectBtn failed'));
await page.waitForTimeout(500);

await page.evaluate(() => {
  const emit = window.__MOCK_EMIT;
  emit('serial-info', { device_id: 'OSMO-HARNESS', firmware_version: '1.3.0', n_sensors: 6 });
  emit('serial-kinds', { kinds: new Array(6).fill('analog_mox') });
  emit('serial-env', { temperature: 23.4, humidity: 41.2 });
});

// 200 samples @ 10 Hz: 8 s baseline, 8 s exposure, 4 s recovery.
const stream = await page.evaluateHandle(async () => {
  const CH = ['MQ-135', 'MQ-3', 'MQ-6', 'MQ-7', 'MQ-4', 'MQ-8'];
  const emit = window.__MOCK_EMIT;
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) {
    const s = i * 0.1;
    const chans = CH.map((_, ci) => {
      const r0 = 2100 + ci * 300;
      let resp = 0;
      if (s >= 8 && s < 16) resp = (0.04 + ci * 0.03) * (1 - Math.exp(-(s - 8) / 2));
      else if (s >= 16) resp = (0.04 + ci * 0.03) * Math.exp(-(s - 16) / 5);
      const noise = (Math.sin(i * 1.9 + ci * 1.3) + Math.cos(i * 0.41 + ci * 2.2)) * 2.2;
      return Math.round(r0 * (1 + resp) + noise);
    });
    emit('serial-data', { channels: chans, timestamp: t0 + i * 100, raw_line: 'MOCK,' + chans.join(',') });
    await new Promise(r => setTimeout(r, 80));
  }
});
await page.waitForTimeout(800);
await stream.dispose().catch(() => {});

await shot('02-live-after-stream');

const tabs = ['dashboard', 'explore', 'analyse', 'vials', 'rig', 'settings'];
for (const tab of tabs) {
  const sel = `.tab-btn[data-tab="${tab}"]`;
  const exists = await page.$(sel);
  if (!exists) { errors.push(`missing tab ${tab}`); continue; }
  await page.click(sel).catch(() => errors.push(`click tab ${tab} failed`));
  await shot(`tab-${tab}`);
  const subnavs = await page.$$eval('.src-subnav-btn[data-src]', els =>
    els.filter(e => e.offsetParent !== null).map(e => e.dataset.src).filter(Boolean));
  for (const src of subnavs) {
    await page.click(`.src-subnav-btn[data-src="${src}"]`).catch(() => errors.push(`click subnav ${src} failed`));
    await shot(`view-${src}`);
  }
}

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ errors, tabs }, null, 2));
console.log(JSON.stringify({ out: OUT, errors }, null, 2));
await browser.close();
