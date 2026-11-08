// Focused UI probe for the update panel. Runs against the Vite dev server with
// the shared Tauri IPC mock; no network and no real release required.
//
//   npm run dev -- --port 5173        # in another terminal
//   node scripts/test-updates-ui.mjs [--url http://localhost:5173]

import { chromium } from 'playwright';
import { MOCK } from './tauri-mock.mjs';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const URL_ = arg('url', 'http://localhost:5173');
const OUT = arg('out', '/tmp/opencode/updates-ui');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.addInitScript({ content: MOCK });
await page.addInitScript({
  content: `try {
    localStorage.removeItem('osmograph.updatePolicy');
    localStorage.removeItem('osmograph.updateChannel');
    localStorage.removeItem('osmograph.updateSkipped');
    localStorage.removeItem('osmograph.updateNotified');
  } catch (e) {}`,
});
await page.addInitScript({ content: `window.__MOCK_UPDATE_SCENARIO = 'available';` });
await page.setDefaultTimeout(8000);
await page.goto(URL_, { waitUntil: 'domcontentloaded' });

await page.waitForFunction(() => {
  const b = document.getElementById('bootOverlay');
  return !b || b.style.display === 'none' || !b.isConnected;
}, undefined, { timeout: 20000 }).catch(() => errors.push('boot overlay never cleared'));

// Wait for the automatic launch check to render.
await page.waitForFunction(
  () => (document.getElementById('updateStatus')?.textContent || '').includes('Update available'),
  undefined,
  { timeout: 8000 },
).catch(() => {});

const badgeBefore = await page.evaluate(() => {
  const b = document.getElementById('updatesNavBadge');
  return !!b && !b.hidden;
});
check('launch check marks the Updates nav with NEW', badgeBefore);

await page.click('#settingsBtn');
await page.click('.sys-nav-item[data-sys="updates"]');
await page.waitForTimeout(200);

const state = await page.evaluate(() => ({
  status: document.getElementById('updateStatus')?.textContent || '',
  stage: document.getElementById('updateStage')?.textContent || '',
  stageHidden: !!document.getElementById('updateStage')?.hidden,
  channelBeta: document.querySelector('input[name="updChan"][value="beta"]')?.checked === true,
  policyAuto: document.querySelector('input[name="updPol"][value="auto"]')?.checked === true,
  notesVisible: getComputedStyle(document.getElementById('updateNotes')).display !== 'none',
  notes: document.getElementById('updateNotes')?.textContent || '',
  badgeHidden: !!document.getElementById('updatesNavBadge')?.hidden,
  calls: window.__MOCK_UPDATE_CALLS || [],
  footer: document.getElementById('footerVersion')?.textContent || '',
  about: document.getElementById('aboutVersion')?.textContent || '',
}));

check('automatic policy is the default', state.policyAuto);
check('prerelease build defaults to the Beta channel', state.channelBeta);
check('version stage is derived from the tag', state.stage === 'Beta' && !state.stageHidden, state.stage);
check('footer shows the real version', state.footer.includes('0.1.2-beta.2'), state.footer);
check('about shows the real version', state.about.includes('0.1.2-beta.2'), state.about);
check('update status names the new version', state.status.includes('v0.1.3-beta.1'), state.status);
check('release card is visible', state.notesVisible);
check('release card shows what is new', state.notes.includes("What's new") && state.notes.includes('Faster live charts'));
check('release card shows bug fixes', state.notes.includes('Bug fixes') && state.notes.includes('Fixed empty export'));
check('release card offers the platform build', state.notes.includes('Osmograph-linux-x86_64.AppImage'));
check('opening the panel clears the NEW badge', state.badgeHidden);
check('the check sent the beta channel', state.calls.some((c) => c.channel === 'beta'));

await page.screenshot({ path: `${OUT}-available.png` });

// Skip → status changes and the version is persisted.
await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('#updateNotes button')];
  buttons.find((b) => b.textContent === 'Skip this version')?.click();
});
await page.waitForTimeout(150);
const skipped = await page.evaluate(() => ({
  status: document.getElementById('updateStatus')?.textContent || '',
  stored: localStorage.getItem('osmograph.updateSkipped'),
  badgeHidden: !!document.getElementById('updatesNavBadge')?.hidden,
  hasUnskip: [...document.querySelectorAll('#updateNotes button')].some((b) => b.textContent === 'Unskip this version'),
}));
check('skip persists the version', skipped.stored === '0.1.3-beta.1', skipped.stored || 'null');
check('skip is reflected in the status', skipped.status.includes('skipped on this device'), skipped.status);
check('skip hides the NEW badge', skipped.badgeHidden);
check('a skipped version can be unskipped', skipped.hasUnskip);

// Unskip restores the prompt.
await page.evaluate(() => {
  [...document.querySelectorAll('#updateNotes button')].find((b) => b.textContent === 'Unskip this version')?.click();
});
await page.waitForTimeout(150);
check(
  'unskip restores the available status',
  await page.evaluate(() => (document.getElementById('updateStatus')?.textContent || '').includes('Update available')),
);

// Offline/error state is honest and still keeps the cached release visible.
await page.evaluate(() => { window.__MOCK_UPDATE_SCENARIO = 'error'; });
await page.click('#updateCheckBtn');
await page.waitForTimeout(200);
const errored = await page.evaluate(() => ({
  status: document.getElementById('updateStatus')?.textContent || '',
  notesVisible: getComputedStyle(document.getElementById('updateNotes')).display !== 'none',
}));
check('network failure is reported, not hidden', errored.status.includes('Couldn'), errored.status);
check('cached release stays visible after a failed check', errored.notesVisible);

// Switching to Stable asks for stable and reports the honest empty state.
await page.evaluate(() => { window.__MOCK_UPDATE_SCENARIO = 'none'; });
await page.click('input[name="updChan"][value="stable"]');
await page.waitForTimeout(200);
const stable = await page.evaluate(() => ({
  status: document.getElementById('updateStatus')?.textContent || '',
  notice: document.getElementById('updateNoticeLine')?.textContent || '',
  channel: (window.__MOCK_UPDATE_CALLS || []).slice(-1)[0]?.channel,
  hint: document.getElementById('updateChannelHint')?.textContent || '',
}));
check('selecting Stable forces a stable check', stable.channel === 'stable', String(stable.channel));
check('no-stable-release state is explained', /No stable release/.test(stable.status + ' ' + stable.notice), stable.status || stable.notice);
check('channel hint explains the difference', /prerelease/i.test(stable.hint));

// Signed in-place install: only offered when the release publishes a manifest
// and the running package type can replace itself.
await page.evaluate(() => { window.__MOCK_UPDATE_SCENARIO = 'available'; });
await page.click('#updateCheckBtn');
await page.waitForFunction(
  () => [...document.querySelectorAll('#updateNotes button')].some((b) => b.textContent === 'Install update'),
  undefined,
  { timeout: 8000 },
).catch(() => {});
const installVisible = await page.evaluate(
  () => [...document.querySelectorAll('#updateNotes button')].some((b) => b.textContent === 'Install update'),
);
check('release card offers signed in-place install', installVisible);

await page.evaluate(() => {
  [...document.querySelectorAll('#updateNotes button')]
    .find((b) => b.textContent === 'Install update')
    ?.click();
});
await page.waitForFunction(() => window.__MOCK_RESTARTED === true, undefined, { timeout: 6000 }).catch(() => {});
const installed = await page.evaluate(() => ({
  status: document.getElementById('updateStatus')?.textContent || '',
  urls: window.__MOCK_INSTALLS || [],
  restarted: window.__MOCK_RESTARTED === true,
}));
check(
  'in-place install uses the release manifest',
  installed.urls.some((u) => u.endsWith('/latest.json')),
  installed.urls.join(', '),
);
check('in-place install reports success and restarts', installed.restarted && /Installed/i.test(installed.status), installed.status);

// The panel still renders in a real browser without layout escapes.
await page.screenshot({ path: `${OUT}.png`, fullPage: false });

if (errors.length) {
  console.log(`\nBrowser errors (${errors.length}):`);
  for (const e of errors) console.log(`  ${e}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} assertions passed.`);
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
