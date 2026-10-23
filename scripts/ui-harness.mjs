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
import { MOCK } from './tauri-mock.mjs';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const URL_ = arg('url', 'http://localhost:5173');
const OUT = arg('out', '/tmp/opencode/ui');
fs.mkdirSync(OUT, { recursive: true });



const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + (e.stack || e.message)));

await page.addInitScript({ content: MOCK });
// First-run onboarding must not block automation: mark it seen before boot.
await page.addInitScript({ content: `try { localStorage.setItem('osmograph.wizard.seen.v1', '1'); } catch (e) {}` });
await page.setDefaultTimeout(6000);
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
const connErr = await page.evaluate(() => {
  const btn = document.getElementById('connectBtn');
  if (!btn) return 'missing #connectBtn';
  btn.click();
  return '';
});
if (connErr) errors.push('connect: ' + connErr);
await page.waitForTimeout(700);
const linkState = await page.evaluate(() => document.getElementById('plotLinkState')?.textContent || '');
if (!/LIVE|DATA|LINK/i.test(linkState)) errors.push('connect: link state still ' + JSON.stringify(linkState));

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

// Inspect the Home canvases at native resolution: a screenshot can hide a
// canvas that never drew (or drew into the wrong buffer), so dump pixels.
await page.click('.tab-btn[data-tab="dashboard"]').catch(() => {});
await page.waitForTimeout(500);
await shot('03-home-live');
const canv = await page.evaluate(() => {
  const out = {};
  for (const id of ['traces', 'fingerprint', 'phenoBars']) {
    const c = document.getElementById(id);
    if (!c) continue;
    const r = c.getBoundingClientRect();
    out[id] = { attr: [c.width, c.height], rect: [Math.round(r.width), Math.round(r.height)], data: c.toDataURL('image/png') };
  }
  return out;
});
for (const [id, c] of Object.entries(canv)) {
  fs.writeFileSync(path.join(OUT, `canvas-${id}.png`), Buffer.from(c.data.split(',')[1], 'base64'));
  console.log(`canvas ${id}: attr ${c.attr[0]}x${c.attr[1]} css ${c.rect[0]}x${c.rect[1]}`);
}

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
