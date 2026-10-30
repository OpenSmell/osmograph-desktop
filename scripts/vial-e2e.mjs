// End-to-end proof for the two shipped example Vials.
//
// The UI harness proves the shell renders. This probe proves the parts a user
// actually relies on: add a reading, set a reference, close a batch, log care,
// save a session, export the journal to a real file, reload, and find the
// state again. It uses the real frontend, the real sandbox, the real host
// journal and persist paths — with a synthetic rig, so it proves the software
// contract, not the sensor science.
//
//   node scripts/vial-e2e.mjs [--url http://localhost:5173] [--out /tmp/opencode/e2e]

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
const OUT = arg('out', '/tmp/opencode/e2e');
fs.mkdirSync(OUT, { recursive: true });

const VIALS_DIR = process.env.OSMO_VIALS_DIR || '/home/praisejamesx/Documents/Documents/code/osmograph-vials';
const NAMES = ['fermentation-lab', 'plant-respiration'];
const loaded = NAMES.map((name) => {
  const dir = path.join(VIALS_DIR, name);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'vial.json'), 'utf8'));
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null);
  return { manifest, ui: read('ui.html'), home: read('home.html') };
});
const packs = loaded.map((v) => ({ ...v.manifest, sourceUrl: `https://example.invalid/${v.manifest.id}/vial.json` }));
const uiSeed = {};
for (const v of loaded) {
  if (v.ui) uiSeed[v.manifest.id] = { version: v.manifest.version, html: v.ui, fetchedAt: Date.now() };
  if (v.home) uiSeed[v.manifest.id + '::home'] = { version: v.manifest.version, html: v.home, fetchedAt: Date.now() };
}
const SEED = `try {
  localStorage.setItem('osmograph.wizard.seen.v1', '1');
  localStorage.setItem('osmograph.domain.packs.v1', ${JSON.stringify(JSON.stringify(packs))});
  localStorage.setItem('osmograph.domain.installed.v1', ${JSON.stringify(JSON.stringify(packs.map((p) => p.id)))});
  localStorage.setItem('osmograph.domain.ui.v1', ${JSON.stringify(JSON.stringify(uiSeed))});
} catch (e) {}`;

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (/127\.0\.0\.1:5501/.test(m.location()?.url || '')) return;
  consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(e.stack || e.message));
const downloads = [];
page.on('download', (d) => downloads.push(d));

await page.addInitScript({ content: MOCK });
await page.addInitScript({ content: SEED });
await page.setDefaultTimeout(8000);
await page.goto(URL_, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => {
  const b = document.getElementById('bootOverlay');
  return !b || b.style.display === 'none' || !b.isConnected;
}, undefined, { timeout: 20000 });

async function streamSamples(count, offset) {
  await page.evaluate(async ({ count, offset }) => {
    const CH = ['MQ-135', 'MQ-3', 'MQ-6', 'MQ-7', 'MQ-4', 'MQ-8'];
    const emit = window.__MOCK_EMIT;
    for (let i = 0; i < count; i++) {
      const s = (i + offset) * 0.1;
      const chans = CH.map((_, ci) => {
        const r0 = 2100 + ci * 300;
        const resp = 0.02 + ci * 0.012 + Math.sin(s / 8 + ci) * 0.004;
        const noise = (Math.sin(i * 1.9 + ci * 1.3) + Math.cos(i * 0.41 + ci * 2.2)) * 2.2;
        return Math.round(r0 * (1 + resp) + noise);
      });
      emit('serial-data', { channels: chans, timestamp: Date.now(), raw_line: 'MOCK,' + chans.join(',') });
      await new Promise((r) => setTimeout(r, 45));
    }
  }, { count, offset });
}

async function connectRig() {
  await page.evaluate(() => {
    const sel = document.getElementById('portSelect');
    if (sel && !sel.value) sel.value = '/dev/ttyACM0';
    const btn = document.getElementById('connectBtn');
    // The shell can adopt the mock link on boot; clicking again would drop it.
    if (btn && /^connect$/i.test(btn.textContent.trim())) btn.click();
  });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const emit = window.__MOCK_EMIT;
    emit('serial-info', { device_id: 'OSMO-E2E', firmware_version: '1.3.0', n_sensors: 6 });
    emit('serial-kinds', { kinds: new Array(6).fill('analog_mox') });
    emit('serial-env', { temperature: 22.6, humidity: 43.1 });
  });
}

await connectRig();
await streamSamples(180, 0);
await page.waitForTimeout(700);

async function vialFrame(marker) {
  const frames = page.frames().filter((f) => f !== page.mainFrame());
  for (const frame of frames) {
    const text = await frame.evaluate(() => document.body?.innerText?.slice(0, 400) || '').catch(() => '');
    if (text.includes(marker)) return frame;
  }
  return null;
}

async function openWorkspace(packId) {
  await page.evaluate(() => {
    const back = document.getElementById('domainBack');
    const ws = document.getElementById('domainWorkspace');
    if (back && ws && getComputedStyle(ws).display !== 'none') back.click();
  });
  await page.waitForTimeout(350);
  await page.click('.tab-btn[data-tab="vials"]').catch(() => {});
  await page.waitForTimeout(350);
  let button = page.locator(`[data-domain-open="${packId}"]`);
  if (!(await button.isVisible().catch(() => false))) {
    await page.click('[data-vials-tab="workspaces"]').catch(() => {});
    await page.waitForTimeout(350);
  }
  button = page.locator(`[data-domain-open="${packId}"]`);
  if (!(await button.isVisible().catch(() => false))) return false;
  await button.click();
  await page.waitForTimeout(1200);
  return true;
}

async function shot(name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
}

async function waitForFrameValue(frame, fn, predicate, timeout = 6000) {
  const startedAt = Date.now();
  let value = null;
  while (Date.now() - startedAt < timeout) {
    value = await frame.evaluate(fn).catch(() => null);
    if (value && predicate(value)) return value;
    await page.waitForTimeout(250);
  }
  return value;
}

// ---------------------------------------------------------------- fermentation
{
  const opened = await openWorkspace('praisejamesx.fermentation');
  check('fermentation workspace opens', opened);
  const frame = await vialFrame('FERMENTATION LAB');
  check('fermentation sandbox found', !!frame);
  if (frame) {
    const structure = await frame.evaluate(() => ({
      facts: document.querySelectorAll('#facts .fact').length,
      refLevel: document.getElementById('refLevel')?.textContent || '',
      phaseBody: !!document.getElementById('phaseBody'),
      journal: !!document.getElementById('journalList'),
      status: document.getElementById('fStatus')?.value || ''
    }));
    check('fermentation facts panel renders', structure.facts === 6, JSON.stringify(structure));
    check('fermentation reference panel present', structure.refLevel === '—', structure.refLevel);
    check('fermentation phase history present', structure.phaseBody && structure.journal);
    check('fermentation lifecycle default is active', structure.status === 'active', structure.status);

    // Add a reading through the real form -> host domain log.
    await frame.fill('#logForm [name="day"]', '1');
    await frame.fill('#logForm [name="ph"]', '4.1');
    await frame.fill('#logForm [name="temp"]', '21');
    await frame.fill('#logForm [name="sg"]', '1.040');
    await frame.fill('#logForm [name="smell"]', 'sour, clean');
    await frame.fill('#logForm [name="visual"]', 'no surface growth');
    await frame.selectOption('#logForm [name="fault"]', 'none');
    await frame.click('#logSubmit');
    await page.waitForTimeout(1200);
    const logText = await frame.evaluate(() => document.getElementById('logList')?.innerText || '');
    check('fermentation reading reaches the log', /pH 4\.1/.test(logText), logText.slice(0, 80).replace(/\n/g, ' | '));
    const factsAfter = await frame.evaluate(() => document.getElementById('facts')?.innerText || '');
    check('fermentation facts use the reading', /4\.10/.test(factsAfter) && /1\.040/.test(factsAfter));

    // Reference blank from the live window.
    await frame.click('#setReference');
    await page.waitForTimeout(900);
    const ref = await frame.evaluate(() => ({
      stamp: document.getElementById('refStamp')?.textContent || '',
      level: document.getElementById('refLevel')?.textContent || '',
      current: document.getElementById('refCurrent')?.textContent || '',
      note: document.getElementById('refNote')?.textContent || ''
    }));
    check('fermentation reference saves from the live window', ref.stamp !== 'none' && ref.level !== '—', JSON.stringify(ref));
    check('fermentation reference compares the current window', ref.current !== '—', ref.current);

    // Close the batch.
    await frame.selectOption('#fStatus', 'completed');
    await page.waitForTimeout(1000);
    const closed = await frame.evaluate(() => ({
      verdict: document.getElementById('verdictLabel')?.textContent || '',
      phase: document.getElementById('phasePill')?.textContent || '',
      journal: document.getElementById('journalList')?.innerText || ''
    }));
    check('fermentation close writes a closed verdict', /completed/i.test(closed.verdict), closed.verdict);
    check('fermentation close is shown in the phase strip', /Completed/i.test(closed.phase), closed.phase);
    check('fermentation close is journaled', /Batch status/i.test(closed.journal), closed.journal.slice(0, 100).replace(/\n/g, ' | '));

    const journalRows = await frame.evaluate(() => document.querySelectorAll('#journalList .journal-row').length);
    check('fermentation journal lists events', journalRows >= 2, String(journalRows));

    // Real export.
    const before = downloads.length;
    await frame.click('#exportJournal');
    await page.waitForTimeout(1200);
    const got = downloads.length > before ? downloads[downloads.length - 1] : null;
    check('fermentation journal exports a file', !!got, got ? got.suggestedFilename() : 'no download event');
    if (got) {
      const target = path.join(OUT, got.suggestedFilename());
      await got.saveAs(target).catch(() => {});
      const text = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
      check('fermentation export contains the batch status event', /Batch status|completed/i.test(text), text.slice(0, 120).replace(/\n/g, ' | '));
    }
    await shot('fermentation-workspace');
  }
}

// Reload: the sandbox is torn down and rebuilt from disk/localStorage.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => {
  const b = document.getElementById('bootOverlay');
  return !b || b.style.display === 'none' || !b.isConnected;
}, undefined, { timeout: 20000 });
await page.waitForTimeout(700);

{
  const opened = await openWorkspace('praisejamesx.fermentation');
  check('fermentation workspace reopens after reload', opened);
  const frame = await vialFrame('FERMENTATION LAB');
  if (frame) {
    const restored = await waitForFrameValue(frame, () => ({
      status: document.getElementById('fStatus')?.value || '',
      verdict: document.getElementById('verdictLabel')?.textContent || '',
      refStamp: document.getElementById('refStamp')?.textContent || '',
      journalRows: document.querySelectorAll('#journalList .journal-row').length
    }), (v) => v.journalRows >= 2);
    check('fermentation batch status persists across reload', restored.status === 'completed', restored.status);
    check('fermentation closed verdict persists across reload', /completed/i.test(restored.verdict), restored.verdict);
    check('fermentation reference persists across reload', restored.refStamp !== 'none', restored.refStamp);
    check('fermentation journal persists across reload', restored.journalRows >= 2, String(restored.journalRows));
  } else {
    check('fermentation sandbox after reload', false);
  }
}

// ---------------------------------------------------------------------- plant
// The reload dropped the serial link; reconnect so the plant session has a
// live window to save.
await connectRig();
await streamSamples(140, 200);
await page.waitForTimeout(700);
{
  const opened = await openWorkspace('praisejamesx.plant-respiration');
  check('plant workspace opens', opened);
  const frame = await vialFrame('Has this plant moved beyond its own noise');
  check('plant sandbox found', !!frame);
  if (frame) {
    const structure = await frame.evaluate(() => ({
      diurnal: !!document.getElementById('diurnalGrid'),
      history: document.querySelectorAll('#historyGrid .history-cell').length,
      care: !!document.getElementById('careForm'),
      journal: !!document.getElementById('journalList'),
      rows: document.querySelectorAll('#chanBody tr').length
    }));
    check('plant diurnal panel present', structure.diurnal);
    check('plant channel history present', structure.history === 4, String(structure.history));
    check('plant care log present', structure.care);
    check('plant journal present', structure.journal);
    check('plant channel verdicts render', structure.rows >= 1, String(structure.rows));

    // Care context.
    await frame.fill('#contextForm [name="plant"]', 'basil by the window');
    await frame.fill('#contextForm [name="species"]', 'Ocimum basilicum');
    await frame.click('#saveContext');
    await page.waitForTimeout(900);

    // Session save needs a finite response on a live window.
    await frame.click('#saveSession');
    await page.waitForTimeout(1000);
    const session = await frame.evaluate(() => ({
      stamp: document.getElementById('sessionStamp')?.textContent || '',
      body: document.getElementById('callBody')?.textContent || ''
    }));
    check('plant session saves', /[1-9]/.test(session.stamp), session.stamp);

    // Care event.
    await frame.selectOption('#careForm [name="kind"]', 'water');
    await frame.fill('#careForm [name="note"]', 'watered 200 ml');
    await frame.click('#addCare');
    await page.waitForTimeout(900);
    const journalText = await frame.evaluate(() => document.getElementById('journalList')?.innerText || '');
    check('plant care event reaches the journal', /watered 200 ml|Care event/i.test(journalText), journalText.slice(0, 100).replace(/\n/g, ' | '));

    // Filter.
    await frame.click('.journal-filters [data-filter="care"]');
    await page.waitForTimeout(250);
    const filtered = await frame.evaluate(() => ({
      stamp: document.getElementById('journalStamp')?.textContent || '',
      kinds: [...document.querySelectorAll('#journalList .journal-row .kind')].map((e) => e.textContent)
    }));
    check('plant journal filter shows only care', filtered.kinds.length >= 1 && filtered.kinds.every((k) => k === 'care'), JSON.stringify(filtered));

    // Interpretation panel reflects the verdict.
    const interpret = await frame.evaluate(() => document.querySelectorAll('#interpretGrid .interpret-item').length);
    check('plant interpretation panel renders', interpret >= 1, String(interpret));

    const before = downloads.length;
    await frame.click('#exportBtn');
    await page.waitForTimeout(1200);
    const got = downloads.length > before ? downloads[downloads.length - 1] : null;
    check('plant journal exports a file', !!got, got ? got.suggestedFilename() : 'no download event');
    if (got) {
      const target = path.join(OUT, got.suggestedFilename());
      await got.saveAs(target).catch(() => {});
      const text = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
      check('plant export contains care and session rows', /care/i.test(text) && /session/i.test(text), text.slice(0, 120).replace(/\n/g, ' | '));
    }
    await shot('plant-workspace');
  }
}

// Reload once more and confirm the plant context and sessions survive.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => {
  const b = document.getElementById('bootOverlay');
  return !b || b.style.display === 'none' || !b.isConnected;
}, undefined, { timeout: 20000 });
await page.waitForTimeout(700);
{
  const opened = await openWorkspace('praisejamesx.plant-respiration');
  check('plant workspace reopens after reload', opened);
  const frame = await vialFrame('Has this plant moved beyond its own noise');
  if (frame) {
    await page.waitForTimeout(600);
    const restored = await waitForFrameValue(frame, () => ({
      plant: document.querySelector('#contextForm [name="plant"]')?.value || '',
      sessions: document.getElementById('sessionStamp')?.textContent || '',
      care: document.getElementById('careForm') ? true : false
    }), (v) => v.plant === 'basil by the window' && /[1-9]/.test(v.sessions));
    check('plant context persists across reload', restored.plant === 'basil by the window', restored.plant);
    check('plant sessions persist across reload', /[1-9]/.test(restored.sessions), restored.sessions);
  } else {
    check('plant sandbox after reload', false);
  }
}

check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

const failed = checks.filter((c) => !c.ok);
console.log('\n' + JSON.stringify({ out: OUT, passed: checks.length - failed.length, failed: failed.length }, null, 2));
await browser.close();
process.exit(failed.length ? 1 : 0);
