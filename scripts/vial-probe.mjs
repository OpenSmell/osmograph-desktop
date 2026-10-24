// Per-Vial programmable-surface probe.
//
// The UI harness covers the shell (tabs, takeover, settings). This probe
// covers what a single authored Vial actually does inside the sandbox: declare
// host transforms, declare a trajectory, and arm a single-unit watch through
// the host gate. It seeds exactly one Vial so the Home takeover cannot be
// claimed by a different pack.
//
//   node scripts/vial-probe.mjs --vial=fermentation-lab
//   node scripts/vial-probe.mjs --vial=plant-respiration

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { MOCK } from './tauri-mock.mjs';

const arg = (name, dflt) => {
  const inline = process.argv.find(a => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const VIAL = arg('vial', 'fermentation-lab');
const URL_ = arg('url', 'http://localhost:5173');
const OUT = arg('out', '/tmp/opencode/ui');
const VIALS_DIR = process.env.OSMO_VIALS_DIR || '/home/praisejamesx/Documents/Documents/code/osmograph-vials';

fs.mkdirSync(OUT, { recursive: true });
const dir = path.join(VIALS_DIR, VIAL);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'vial.json'), 'utf8'));
const read = f => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null);
const homeHtml = read('home.html');
if (!homeHtml) {
  console.error(`${VIAL} has no home.html — nothing to probe.`);
  process.exit(2);
}
const pack = { ...manifest, sourceUrl: `https://raw.githubusercontent.com/praisejamesx/${manifest.id.split('.')[1]}/main/vial.json` };
const seedUi = { [manifest.id + '::home']: { version: manifest.version, html: homeHtml, fetchedAt: Date.now() } };
const SEED = `try {
  localStorage.setItem('osmograph.wizard.seen.v1', '1');
  localStorage.setItem('osmograph.domain.packs.v1', ${JSON.stringify(JSON.stringify([pack]))});
  localStorage.setItem('osmograph.domain.installed.v1', ${JSON.stringify(JSON.stringify([manifest.id]))});
  localStorage.setItem('osmograph.domain.ui.v1', ${JSON.stringify(JSON.stringify(seedUi))});
} catch (e) {}`;

const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', m => {
  if (m.type() !== 'error') return;
  // The dev-only tap mirrors readings to a local listener on :5501; with no
  // listener attached the browser logs one connection error per frame. Dev
  // plumbing, never a product error (it cannot ship: DEV-only).
  if (/127\.0\.0\.1:5501/.test(m.location()?.url || '')) return;
  errors.push('console: ' + m.text());
});
page.on('pageerror', e => errors.push('pageerror: ' + (e.stack || e.message)));

await page.addInitScript({ content: MOCK });
await page.addInitScript({ content: SEED });
await page.setDefaultTimeout(8000);
await page.goto(URL_, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);

await page.evaluate(() => document.getElementById('connectBtn')?.click());
await page.waitForTimeout(700);

// A rig-shaped stream: two live channels, four idle zeros.
await page.evaluate(async () => {
  const emit = window.__MOCK_EMIT;
  const t0 = Date.now();
  for (let i = 0; i < 120; i++) {
    const ch = [Math.round(1730 + Math.sin(i / 4) * 12), Math.round(212 + Math.cos(i / 5) * 6), 0, 0, 0, 0];
    emit('serial-data', { channels: ch, timestamp: t0 + i * 50, raw_line: ch.join(',') });
    await new Promise(r => setTimeout(r, 45));
  }
});
await page.waitForTimeout(1400);

await page.click('.tab-btn[data-tab="dashboard"]').catch(() => {});
await page.waitForTimeout(500);
const takeover = await page.$('[data-vial-action="takeover"]');
if (!takeover) {
  errors.push('no Home takeover control');
} else {
  await takeover.click();
  await page.waitForTimeout(1800);
}

const frame = page.frames().find(f => f !== page.mainFrame() && f.url().includes('srcdoc')) || page.frames().find(f => f !== page.mainFrame());
let report = null;
if (!frame) {
  errors.push('no sandboxed Vial frame');
} else {
  report = await frame.evaluate(() => {
    const limits = document.querySelectorAll('#watchLimits input[data-channel]').length;
    return {
      limits,
      pill: document.getElementById('watchPill')?.textContent || '',
      headline: document.getElementById('plantHeadline')?.textContent || document.getElementById('batchName')?.textContent || '',
    };
  });
  if (report.limits !== 2) errors.push(`watch exposes ${report.limits} channels; only the 2 live channels may carry a limit`);
  const apply = frame.locator('#watchApply');
  if (await apply.count()) {
    await apply.click().catch(() => {});
    await page.waitForTimeout(900);
  } else {
    errors.push('no watch apply control in the Vial Home');
  }
}

const stored = await page.evaluate((id) => ({
  transforms: localStorage.getItem(`osmograph.vial.transforms.${id}`),
  trajectory: localStorage.getItem(`osmograph.vial.trajectorySpec.${id}`),
  detection: localStorage.getItem(`osmograph.vial.detection.${id}`),
}), manifest.id);
if (!stored.transforms) errors.push('the Vial never declared host transforms');
if (!stored.trajectory) errors.push('the Vial never declared a trajectory');
let detection = null;
try { detection = JSON.parse(stored.detection || 'null'); } catch { detection = null; }
if (!detection || !detection.enabled || Object.keys(detection.perChannelLimits || {}).length !== 2) {
  errors.push('the watch was not armed on exactly the two live channels');
}
await page.screenshot({ path: path.join(OUT, `vial-${VIAL}.png`) });
await browser.close();

console.log(`vial ${VIAL}:`, JSON.stringify({ ...report, detection }));
console.log(JSON.stringify({ errors }, null, 2));
process.exit(errors.length ? 1 : 0);
