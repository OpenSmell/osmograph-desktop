#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function usage() {
  console.log(`Usage: node scripts/create-vial.mjs <vial-id> [options]

Options:
  --name <name>        Display name
  --description <desc> Description
  --author <author>    Author name
  --template <type>    Template: fermentation|respiration|custom (default: custom)

Examples:
  node scripts/create-vial.mjs my-vial --name "My Vial" --template fermentation
`);
}

if (args.length === 0 || args.includes('--help')) {
  usage();
  process.exit(0);
}

const vialId = args[0];
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const name = getArg('--name', vialId.split('.').pop() || vialId);
const description = getArg('--description', `Custom vial: ${name}`);
const author = getArg('--author', 'local');
const template = getArg('--template', 'custom');

const outDir = path.join(__dirname, '..', 'vials', vialId.replace(/\./g, '-'));
fs.mkdirSync(outDir, { recursive: true });

const manifest = {
  id: vialId,
  version: '1.0.0',
  name,
  description,
  author,
  capabilities: ['read:live', 'log:events', 'write:persist', 'export:data'],
  homepage: '',
  permissions: {
    readLive: true,
    readBaseline: true,
    logEvents: true,
    persist: true,
    requestAction: true,
    exportData: true
  }
};

fs.writeFileSync(path.join(outDir, 'vial.json'), JSON.stringify(manifest, null, 2));

const uiHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${name}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #0f0f0e; color: #e7e5e4; }
    header { padding: 12px 16px; border-bottom: 1px solid #292524; display: flex; align-items: center; justify-content: space-between; }
    h1 { font-size: 14px; margin: 0; }
    .status { font-size: 11px; color: #a8a29e; }
    main { padding: 16px; display: grid; gap: 12px; }
    .card { border: 1px solid #292524; border-radius: 6px; padding: 12px; background: #151413; }
    .card h2 { font-size: 12px; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 0.05em; color: #a8a29e; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
    .metric { padding: 8px; border: 1px solid #292524; border-radius: 4px; }
    .metric .label { font-size: 10px; color: #78716c; }
    .metric .value { font-size: 18px; font-variant-numeric: tabular-nums; }
    button { background: #292524; color: #e7e5e4; border: 1px solid #44403c; padding: 6px 10px; border-radius: 4px; cursor: pointer; font-size: 11px; }
    button:hover { background: #44403c; }
    .log { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; max-height: 200px; overflow: auto; border: 1px solid #292524; border-radius: 4px; }
    .log-entry { padding: 4px 6px; border-bottom: 1px solid #1c1917; display: flex; gap: 8px; }
    .log-entry .time { color: #78716c; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${name}</h1>
      <div class="status" id="status">Initializing...</div>
    </div>
    <button id="logEvent">Log Event</button>
  </header>
  <main>
    <section class="card">
      <h2>Live Readings</h2>
      <div class="grid" id="metrics"></div>
    </section>
    <section class="card">
      <h2>Event Log</h2>
      <div class="log" id="log"></div>
    </section>
  </main>
  <script type="module">
    const host = window.__OSMOGRAPH_VIAL_HOST__;
    const statusEl = document.getElementById('status');
    const metricsEl = document.getElementById('metrics');
    const logEl = document.getElementById('log');
    
    if (!host) {
      statusEl.textContent = 'No host API available';
    } else {
      statusEl.textContent = \`Host v\${host.version} • \${host.capabilities.readLive ? 'Live' : 'No live data'}\`;
      
      function render() {
        const readings = host.getLiveReadings();
        const channels = host.getChannels();
        metricsEl.innerHTML = '';
        if (readings && channels.length) {
          channels.forEach((ch, i) => {
            const div = document.createElement('div');
            div.className = 'metric';
            div.innerHTML = \`<div class="label">\${ch.name}</div><div class="value">\${readings.channels[i]?.toFixed(0) || '--'}</div>\`;
            metricsEl.appendChild(div);
          });
        } else {
          metricsEl.innerHTML = '<div style="color:#78716c;font-size:11px">No live data</div>';
        }
      }
      
      async function refreshLog() {
        const events = await host.getEvents(20);
        logEl.innerHTML = events.reverse().map(ev => 
          \`<div class="log-entry"><span class="time">\${new Date(ev.timestamp).toLocaleTimeString()}</span><span><strong>\${ev.type}:</strong> \${ev.message}</span></div>\`
        ).join('') || '<div style="padding:8px;color:#78716c">No events</div>';
      }
      
      host.on('tick', render);
      render();
      refreshLog();
      setInterval(refreshLog, 2000);
      
      document.getElementById('logEvent').addEventListener('click', async () => {
        await host.logEvent('manual', 'User logged event');
        refreshLog();
      });
    }
  </script>
</body>
</html>`;

fs.writeFileSync(path.join(outDir, 'ui.html'), uiHtml);

const homeHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${name} - Home</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #0f0f0e; color: #e7e5e4; padding: 12px; }
    .compact { display: flex; align-items: center; justify-content: space-between; font-size: 11px; }
    .status { color: #a8a29e; }
  </style>
</head>
<body>
  <div class="compact">
    <span>${name}</span>
    <span class="status" id="status">--</span>
  </div>
  <script>
    const host = window.__OSMOGRAPH_VIAL_HOST__;
    const status = document.getElementById('status');
    if (host) {
      function update() {
        const readings = host.getLiveReadings();
        if (readings && readings.channels.length) {
          const avg = readings.channels.reduce((a,b)=>a+b,0)/readings.channels.length;
          status.textContent = \`Live • avg \${avg.toFixed(0)}\`;
        } else {
          status.textContent = 'Idle';
        }
      }
      host.on('tick', update);
      update();
    }
  </script>
</body>
</html>`;

fs.writeFileSync(path.join(outDir, 'home.html'), homeHtml);

const readme = `# ${name}

${description}

## Installation
Copy this directory to your Osmograph vials folder or load it via the Vials tab.

## Development
Use the host API exposed via \`window.__OSMOGRAPH_VIAL_HOST__\`. See \`src/vials/host.d.ts\` for full API.

## Capabilities
${manifest.capabilities.map(c => `- ${c}`).join('\n')}
`;

fs.writeFileSync(path.join(outDir, 'README.md'), readme);

console.log(`Created vial scaffold at: ${outDir}`);
console.log(`Files: vial.json, ui.html, home.html, README.md`);
