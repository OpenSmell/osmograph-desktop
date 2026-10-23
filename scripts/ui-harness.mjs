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

// Install the real published vials into the test profile (same localStorage
// contract the Aromatory uses) so the harness exercises the actual sandboxed
// home/workspace UIs rather than an empty Vials tab.
const VIALS_DIR = process.env.OSMO_VIALS_DIR || '/home/praisejamesx/Documents/Documents/code/osmograph-vials';
function readVial(name) {
  const dir = path.join(VIALS_DIR, name);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'vial.json'), 'utf8'));
    const read = (f) => fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null;
    return { manifest, ui: read('ui.html'), home: read('home.html') };
  } catch {
    return null;
  }
}
const seeded = ['fermentation-lab', 'plant-respiration'].map(readVial).filter(Boolean);
const seedPacks = seeded.map(v => ({
  ...v.manifest,
  sourceUrl: `https://raw.githubusercontent.com/praisejamesx/${v.manifest.id.split('.')[1]}/main/vial.json`,
}));
const seedInstalled = seedPacks.map(p => p.id);
const seedUi = {};
for (const v of seeded) {
  if (v.ui) seedUi[v.manifest.id] = { version: v.manifest.version, html: v.ui, fetchedAt: Date.now() };
  if (v.home) seedUi[v.manifest.id + '::home'] = { version: v.manifest.version, html: v.home, fetchedAt: Date.now() };
}
const SEED = `try {
  localStorage.setItem('osmograph.wizard.seen.v1', '1');
  localStorage.setItem('osmograph.domain.packs.v1', ${JSON.stringify(JSON.stringify(seedPacks))});
  localStorage.setItem('osmograph.domain.installed.v1', ${JSON.stringify(JSON.stringify(seedInstalled))});
  localStorage.setItem('osmograph.domain.ui.v1', ${JSON.stringify(JSON.stringify(seedUi))});
} catch (e) {}`;



const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + (e.stack || e.message)));

await page.addInitScript({ content: MOCK });
// Onboarding + the published vials are installed before the app boots.
await page.addInitScript({ content: SEED });
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
// Home Vial: inert by default (one compact line), takeover only by explicit
// activation, and a clean exit back to the instrument. The takeover must
// replace the dashboard rather than squeeze the traces.
const takeoverBtn = await page.$('[data-vial-action="takeover"]');
if (takeoverBtn) {
  const barTraces = await page.evaluate(() => Math.round(document.getElementById('traces')?.getBoundingClientRect().height || 0));
  console.log('traces height with compact vial bar:', barTraces);
  await shot('03b-home-vial-bar');
  await takeoverBtn.click();
  await page.waitForTimeout(1000);
  await shot('03c-home-takeover');
  const take = await page.evaluate(() => {
    const frame = document.getElementById('vialTakeoverFrame');
    const rect = frame?.getBoundingClientRect();
    const dash = document.querySelector('#panel-dashboard .dashboard');
    return {
      active: document.getElementById('panel-dashboard')?.classList.contains('vial-takeover') || false,
      dashboard: dash ? getComputedStyle(dash).display : 'missing',
      frame: rect ? [Math.round(rect.width), Math.round(rect.height)] : [0, 0],
    };
  });
  console.log('takeover state:', JSON.stringify(take));
  if (!take.active || take.dashboard !== 'none') errors.push('takeover did not replace the instrument');
  if (take.frame[1] < 320) errors.push(`takeover frame too small: ${take.frame[1]}px`);

  // Drive the sandboxed Vial's own button and verify the host acts on it.
  let bridgeWorkspace = null;
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const btn = f.locator('[data-action="open-workspace"]');
    if (await btn.count()) {
      await btn.first().click().catch(() => {});
      await page.waitForTimeout(800);
      bridgeWorkspace = await page.evaluate(() => document.body.dataset.workspace || '');
      break;
    }
  }
  console.log('vial bridge -> workspace:', bridgeWorkspace);
  if (bridgeWorkspace !== 'vials') errors.push('vial bridge: open-workspace did not reach the host');
  await shot('03d-home-action');

  await page.evaluate(() => document.querySelector('.tab-btn[data-tab="dashboard"]')?.click());
  await page.waitForTimeout(600);
  if (!(await page.$('#vialTakeoverExit'))) {
    errors.push('exit takeover control missing');
  } else {
    await page.click('#vialTakeoverExit').catch(() => errors.push('exit takeover not clickable'));
    await page.waitForTimeout(500);
  }
  const back = await page.evaluate(() => {
    const dash = document.querySelector('#panel-dashboard .dashboard');
    return {
      active: document.getElementById('panel-dashboard')?.classList.contains('vial-takeover') || false,
      dashboard: dash ? getComputedStyle(dash).display : 'missing',
      bar: !!document.querySelector('[data-vial-action="takeover"]'),
    };
  });
  console.log('after exit:', JSON.stringify(back));
  if (back.active || back.dashboard === 'none' || !back.bar) errors.push('takeover exit did not restore Home');
  await shot('03e-home-exit');
} else {
  errors.push('no Vial takeover control found on Home');
}
const hCollapsed = await page.evaluate(() => Math.round(document.getElementById('traces')?.getBoundingClientRect().height || 0));
console.log('traces height collapsed:', hCollapsed);
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

// Open the installed Fermentation Lab workspace (real sandboxed UI, real host
// bridge) and capture both the host chrome and the iframe surface.
// The Home bridge test above leaves a Vial workspace open; close it so the
// list (and its Open buttons) is reachable again.
await page.evaluate(() => {
  const back = document.getElementById('domainBack');
  const ws = document.getElementById('domainWorkspace');
  if (back && ws && getComputedStyle(ws).display !== 'none') back.click();
});
await page.waitForTimeout(400);
await page.click('.tab-btn[data-tab="vials"]').catch(() => {});
await page.waitForTimeout(400);
const openSel = '[data-domain-open="praisejamesx.fermentation"]';
const openBtn = page.locator(openSel);
if (!(await openBtn.isVisible().catch(() => false))) {
  await page.click('[data-vials-tab="workspaces"]').catch(() => {});
  await page.waitForTimeout(400);
}
if (await openBtn.isVisible().catch(() => false)) {
  await openBtn.click().catch(e => errors.push('open vial workspace: ' + e.message));
  await page.waitForTimeout(1000);
  await shot('06-vial-workspace');
  const frames = await page.$$('iframe');
  for (let i = 0; i < frames.length; i++) {
    await frames[i].screenshot({ path: path.join(OUT, `06-vial-frame-${i}.png`) }).catch(() => {});
  }
  console.log('vial iframes:', frames.length);
} else {
  await shot('06-vials-state');
  console.log('vials state:', JSON.stringify(await page.evaluate(() => ({
    ws: document.body.dataset.workspace,
    vialsTabs: [...document.querySelectorAll('[data-vials-tab]')].map(b => ({ t: b.dataset.vialsTab, active: b.classList.contains('active') })),
    panes: ['vialsWorkspacesPane', 'vialsAromatoryPane', 'vialsDecisionsPane'].map(id => ({ id, visible: !!document.getElementById(id)?.offsetHeight })),
    openBtns: [...document.querySelectorAll('[data-domain-open]')].map(b => ({ id: b.dataset.domainOpen, visible: !!(b.offsetWidth || b.offsetHeight) })),
    workspaceEl: !!document.querySelector('.domain-workspace, #domainWorkspace'),
  }))));
  errors.push('vial workspace: Open button for praisejamesx.fermentation not found');
}

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ errors, tabs }, null, 2));
console.log(JSON.stringify({ out: OUT, errors }, null, 2));
await browser.close();
