#!/usr/bin/env node
// Scaffold a v2 Vial project in the current directory.
//
//   node scripts/create-vial.mjs praisejamesx.plant-respiration \
//     --name "Plant Respiration" --author "@praisejamesx" --domain plants
//
// Produces: <vial-id>/vial.json, ui.html, home.html, fixtures/, EVIDENCE.md,
// README.md. Host the folder (for example on GitHub Pages) and install it from
// the raw vial.json URL: "Install a Vial from URL" in the Vials tab. A file
// import installs the declarative manifest only; a sandboxed ui.html requires
// a manifest URL so Osmograph can fetch and hash-verify the UI assets.
//
// The manifest is intentionally incomplete: `evidence` needs real, measured
// numbers you fill in. A Vial with placeholder evidence installs as Ungated
// and cannot be listed until the evidence is real. Never invent a number.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help')) {
  console.log(`Usage: node scripts/create-vial.mjs <vial-id> [options]

Options:
  --name <name>        Display name
  --author <author>    Author handle or name
  --domain <domain>    Domain, e.g. fermentation, plants, safety
  --risk <level>       low | medium | high | critical (default: medium)
  --license <id>       SPDX licence id (default: CC-BY-4.0)

Examples:
  node scripts/create-vial.mjs praisejamesx.plant-respiration \\
    --name "Plant Respiration" --author "@praisejamesx" --domain plants
`);
  process.exit(0);
}

const vialId = args[0];
if (!/^[a-z0-9][a-z0-9._-]{2,80}$/.test(vialId)) {
  console.error(`Invalid vial id "${vialId}": use lowercase, 3–80 chars, e.g. praisejamesx.plant-respiration`);
  process.exit(2);
}

const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const name = getArg('name', vialId.split('.').pop() || vialId);
const author = getArg('author', 'local');
const domain = getArg('domain', 'custom');
const risk = getArg('risk', 'medium');
const license = getArg('license', 'CC-BY-4.0');

if (!['low', 'medium', 'high', 'critical'].includes(risk)) {
  console.error(`Invalid risk "${risk}": low, medium, high, or critical.`);
  process.exit(2);
}

const outDir = path.join(process.cwd(), vialId);
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(outDir, 'fixtures'), { recursive: true });

const now = new Date().toISOString().slice(0, 10);

const manifest = {
  schema: 'osmograph.domain-pack/2',
  id: vialId,
  name,
  version: '1.0.0',
  author,
  license,
  risk,
  domain,
  tagline: `${name} — a programmable anomaly workspace.`,
  summary: `A ${domain} workspace for the Osmograph array. Replace this summary with an honest statement of the decision this Vial supports and the conditions where it refuses.`,
  scope: `Decide whether the ${domain} process shows a sustained array response beyond its measured noise floor, on this array, in this enclosure.`,
  limits: [
    `Cannot identify a compound, concentration, pathogen, or safety state from a MOX response alone.`,
    `Readings do not transfer across arrays, rooms, enclosures, or seasons without recalibration.`,
    `A single sensor excursion is not an alert; ${risk === 'low' ? 'one' : risk === 'medium' ? 'two' : 'three'} or more channels must clear their declared limit.`,
  ],
  anomaly: {
    baseline: { protocol: 'first-n', warmupS: 60, r0WindowS: 10 },
    transforms: { conditioning: ['median3'], response: 'delta-over-r0' },
    detection: {
      enabled: true,
      sensitivity: 1,
      minChannels: 2,
      levelBudget: 0,
      levelRefS: 0,
      alertThreshold: 0.5,
      perChannelLimits: {},
      hysteresis: 0.2,
      escalation: {
        warningS: 30,
        criticalS: 120,
        emergencyS: 300,
        resetNormalS: 300,
      },
      farTargetPerMonth: null,
    },
    admissibility: { requireBaseline: 'ready', minCoverage: 0.8 },
  },
  evidence: {
    grade: 'D',
    reportUrl: `https://example.org/${vialId.replace(/\./g, '-')}-evidence`,
    measuredAt: now,
    dataset: `Describe the corpus, rig, unit count, sessions, and preparation this evidence describes.`,
    metrics: {},
    fixtures: [
      { id: 'baseline-drift', file: 'fixtures/baseline-drift.json', expect: 'normal' },
    ],
  },
  citations: [
    `Replace with a real reference for ${domain}. Do not cite a paper you have not read.`,
  ],
  docs: [
    {
      id: 'how',
      title: 'How to use this workspace',
      body: ['Explain the first action, the reading cadence, and what the log is for.'],
    },
    {
      id: 'limits',
      title: 'What it cannot tell you',
      body: ['State the specific overclaim a user might make, and the primary measurement or inspection that replaces it.'],
    },
  ],
  widgets: [
    {
      type: 'hero',
      art: 'generic',
      title: name,
      subtitle: 'A protocol, a log, and the limits that keep it honest.',
      note: 'Personal Vial · host-rendered · add a sandboxed UI when you need a custom screen',
    },
    {
      type: 'risk',
      level: risk,
      headline: 'Operating boundary.',
      body: `Name the decision this ${domain} workspace supports and the conditions where it refuses.`,
      always: ['Record the context that changes the interpretation.'],
      never: ['Keep the sensor in its measurement role.'],
    },
    {
      type: 'docs',
      title: 'Field notes',
    },
    {
      type: 'rig',
      title: 'Use this with your rig',
      body: 'Record a clean reference and a sample on the same array, then compare in Separability. If the arrays differ, the app refuses the comparison.',
      cta: 'Open Separability',
    },
    {
      type: 'tracking',
      title: 'Workspace log',
      description: 'Replace these fields with the ones a practitioner would actually keep.',
      fields: [
        { id: 'batch', label: 'Batch / subject', type: 'text', placeholder: 'Batch 01' },
        { id: 'started', label: 'Started', type: 'date' },
      ],
      logFields: [
        { id: 'day', label: 'Day / reading', type: 'number', placeholder: '1' },
        { id: 'note', label: 'Observation', type: 'text', placeholder: 'what changed?' },
        { id: 'action', label: 'Action', type: 'select', options: ['none', 'inspect', 'discard'] },
      ],
      logLabel: 'Add reading',
    },
  ],
  capabilities: ['read:live', 'read:baseline', 'log:events', 'write:persist', 'action:request', 'export:data'],
  permissions: {
    readLive: true,
    readBaseline: true,
    logEvents: true,
    persist: true,
    requestAction: true,
    exportData: true,
  },
  home: {
    headline: name,
    detail: `Log ${domain} context with every sample. A change is a prompt to inspect, not a diagnosis.`,
    metrics: [
      { label: 'Claim', value: 'Change only', hint: 'Same plant, same array, same time of day.' },
      { label: 'Blind spot', value: 'Compound ID', hint: 'The array sees a mixture, not a single compound.' },
    ],
    actions: [
      { id: 'workspace', label: 'Open workspace', kind: 'open-workspace' },
      { id: 'check', label: 'Compare with Check', kind: 'open-check' },
    ],
    limits: [
      'No compound identification or concentration from a MOX response.',
      'Readings do not transfer across arrays or seasons.',
    ],
    sources: ['Author measurement. Replace with real citations.'],
  },
  ui: { runtime: 'sandbox/1', entry: 'ui.html', height: 860 },
  homeUi: { runtime: 'sandbox/1', entry: 'home.html', height: 420 },
};

fs.writeFileSync(
  path.join(outDir, 'vial.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);

const uiHtml = `<div class="vial-${vialId.split('.').pop()}">
  <header>
    <h2>${escapeHtml(name)}</h2>
    <span class="pill" id="sourcePill">NO INPUT</span>
    <span class="pill" id="baselinePill">BASELINE —</span>
  </header>
  <div class="metrics" id="metrics">
    <div class="metric"><div class="k">Channel</div><div class="v" id="mLatest">—</div></div>
    <div class="metric"><div class="k">Δ</div><div class="v" id="mDelta">—</div></div>
    <div class="metric"><div class="k">Rate</div><div class="v" id="mRate">—<span class="u">/s</span></div></div>
    <div class="metric"><div class="k">Samples</div><div class="v" id="mSamples">0</div></div>
  </div>
  <div class="note" id="note">No live reading. The chart stays empty rather than inventing a baseline.</div>
  <div class="actions">
    <button type="button" id="logEvent">Log event</button>
    <button type="button" id="exportJournal">Export journal</button>
  </div>
  <style>
    * { box-sizing: border-box; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--line-strong, #b9ab95); }
    h2 { margin: 0; font-size: 17px; letter-spacing: -.02em; font-weight: 650; font-family: var(--sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif); }
    .pill { font-family: var(--mono, ui-monospace, monospace); font-size: 8px; letter-spacing: .09em; text-transform: uppercase; border: 1px solid var(--line-strong, #b9ab95); padding: 3px 7px; color: var(--muted, #6b6152); background: var(--panel, #fffdf8); white-space: nowrap; }
    .pill.live { color: #0e7490; border-color: #7fc3d2; background: #d9eef3; }
    .metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin: 8px 0; }
    .metric { border: 1px solid var(--line, #d8cdbb); background: var(--panel-2, #f1eadc); padding: 7px 8px; }
    .k { font-family: var(--mono, ui-monospace, monospace); font-size: 7px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted-2, #8a7f6c); }
    .v { font-family: var(--mono, ui-monospace, monospace); font-size: 17px; margin-top: 2px; font-variant-numeric: tabular-nums; }
    .u { font-size: 8px; color: var(--muted-2, #8a7f6c); margin-left: 3px; }
    .note { border-left: 3px solid #b45309; background: #f7e5cf; padding: 7px 8px; font-size: 10px; line-height: 1.5; }
    .actions { display: flex; gap: 5px; margin-top: 8px; }
    button { border: 1px solid var(--line-strong, #b9ab95); background: var(--panel, #fffdf8); padding: 6px 10px; border-radius: 3px; cursor: pointer; font-family: var(--mono, ui-monospace, monospace); font-size: 9px; letter-spacing: .04em; text-transform: uppercase; }
    button:hover { border-color: var(--ink, #1d1a16); background: var(--panel-2, #f1eadc); }
  </style>
  <script>
    (function () {
      "use strict";
      var host = window.__OSMOGRAPH_VIAL_HOST__;
      var $ = function (id) { return document.getElementById(id); };
      var latest = null;
      var channels = [];
      var recent = [];
      var raf = 0;

      function num(v) { return typeof v === "number" && Number.isFinite(v) ? v : null; }
      function fmt(v, digits) {
        var n = num(v);
        return n === null ? "—" : n.toFixed(digits === undefined ? 1 : digits);
      }
      function setText(id, value) { var el = $(id); if (el) el.textContent = value; }
      function setPill(id, text, cls) {
        var el = $(id);
        if (!el) return;
        el.textContent = text;
        el.className = "pill" + (cls ? " " + cls : "");
      }
      function scheduleRender() {
        if (raf) return;
        raf = requestAnimationFrame(function () { raf = 0; render(); });
      }
      function readLive() {
        if (!host) return null;
        try { return host.getLiveReadings(); } catch (e) { return null; }
      }
      function readChannels() {
        if (!host) return [];
        try { return host.getChannels(); } catch (e) { return []; }
      }
      function readRecent() {
        if (!host) return [];
        try { return host.getRecentReadings(600) || []; } catch (e) { return []; }
      }
      function selectedChannel() { return 0; }
      function seriesPoints(windowSec) {
        var cutoff = Date.now() - windowSec * 1000;
        return recent.filter(function (r) { return r && r.timestamp >= cutoff; })
          .map(function (r) { return { t: r.timestamp, v: num(r.channels && r.channels[0]); } })
          .filter(function (p) { return p.v !== null; });
      }
      function renderMetrics() {
        var value = latest && latest.channels ? num(latest.channels[0]) : null;
        var points = seriesPoints(180);
        var first = points.length ? points[0].v : null;
        var last = points.length ? points[points.length - 1].v : null;
        var delta = (first !== null && last !== null) ? last - first : null;
        var rate = 0;
        if (points.length > 1 && first !== null && last !== null) {
          var dt = (points[points.length - 1].t - points[0].t) / 1000;
          if (dt > 0) rate = (last - first) / dt;
        }
        setText("mLatest", fmt(value));
        setText("mDelta", fmt(delta));
        setText("mRate", fmt(rate, 2));
        setText("mSamples", String(points.length));
      }
      function renderStatus() {
        var connected = !!(latest && latest.channels && latest.channels.some(function (v) { return num(v) !== null; }));
        setPill("sourcePill", connected ? "LIVE ARRAY" : "NO INPUT", connected ? "live" : "");
        var baseline = null;
        try { baseline = host ? host.getBaseline() : null; } catch (e) { baseline = null; }
        if (!baseline) setPill("baselinePill", "BASELINE —", "");
        else if (baseline.state === "ready") setPill("baselinePill", "BASELINE READY", "");
        else if (baseline.state === "warming") setPill("baselinePill", "BASELINE WARMING " + Math.round((baseline.progress || 0) * 100) + "%", "");
        else setPill("baselinePill", "BASELINE " + String(baseline.state || "—").toUpperCase(), "");
      }
      function render() {
        if (!host) {
          setText("note", "This Vial needs the Osmograph host. The SDK (window.__OSMOGRAPH_VIAL_HOST__) is not present in this frame.");
          return;
        }
        channels = readChannels();
        latest = readLive();
        recent = readRecent();
        renderStatus();
        renderMetrics();
      }
      async function logEvent() {
        if (!host) return;
        try {
          await host.logEvent("manual", "User logged event");
          setText("note", "Event logged.");
          setTimeout(function () { setText("note", "Ready."); }, 1500);
        } catch (e) {
          setText("note", "Log failed: " + (e && e.message ? e.message : "unknown"));
        }
      }
      async function exportJournal() {
        if (!host) return;
        try {
          await host.requestAction("journal-download", { format: "csv" });
          setText("note", "Journal exported.");
          setTimeout(function () { setText("note", "Ready."); }, 1500);
        } catch (e) {
          setText("note", "Export failed: " + (e && e.message ? e.message : "unknown"));
        }
      }
      if (host) {
        host.on("tick", function () { scheduleRender(); });
        host.on("connect", scheduleRender);
        host.on("disconnect", scheduleRender);
        render();
      } else {
        render();
      }
      $("logEvent").addEventListener("click", logEvent);
      $("exportJournal").addEventListener("click", exportJournal);
    })();
  </script>
</div>`;

fs.writeFileSync(path.join(outDir, 'ui.html'), uiHtml);

const homeHtml = `<div class="vial-home-${vialId.split('.').pop()}">
  <div class="eyebrow">${escapeHtml(name)}</div>
  <div class="headline">${escapeHtml(manifest.home.headline)}</div>
  <div class="detail">${escapeHtml(manifest.home.detail)}</div>
  <div class="metrics">
    ${manifest.home.metrics.map(function (m) {
      return `<div class="metric"><div class="k">${escapeHtml(m.label)}</div><div class="v">${escapeHtml(m.value)}</div><div class="u">${escapeHtml(m.hint || '')}</div></div>`;
    }).join('')}
  </div>
  <div class="limits">
    <strong>Limits</strong>
    <ul>${manifest.home.limits.map(function (l) { return "<li>" + escapeHtml(l) + "</li>"; }).join('')}</ul>
  </div>
  <div class="actions">
    ${manifest.home.actions.map(function (a) {
      return '<button type="button" data-action="' + escapeHtml(a.kind) + '">' + escapeHtml(a.label) + '</button>';
    }).join('')}
  </div>
  <style>
    * { box-sizing: border-box; }
    .eyebrow { font-family: var(--mono, ui-monospace, monospace); font-size: 7px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted-2, #8a7f6c); }
    .headline { margin: 2px 0 3px; font-size: 17px; letter-spacing: -.02em; font-weight: 650; }
    .detail { font-size: 11px; line-height: 1.45; color: var(--muted, #6b6152); margin-bottom: 8px; }
    .metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin-bottom: 8px; }
    .metric { border: 1px solid var(--line, #d8cdbb); background: var(--panel-2, #f1eadc); padding: 7px 8px; }
    .k { font-family: var(--mono, ui-monospace, monospace); font-size: 7px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted-2, #8a7f6c); }
    .v { font-family: var(--mono, ui-monospace, monospace); font-size: 16px; margin-top: 2px; font-variant-numeric: tabular-nums; }
    .u { font-size: 8px; color: var(--muted-2, #8a7f6c); margin-left: 3px; }
    .limits { border: 1px solid var(--line, #d8cdbb); background: var(--panel, #fffdf8); padding: 7px 8px; font-size: 10px; line-height: 1.45; margin-bottom: 8px; }
    .limits strong { font-family: var(--mono, ui-monospace, monospace); font-size: 7px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted-2, #8a7f6c); display: block; margin-bottom: 3px; }
    .actions { display: flex; gap: 5px; }
    button { border: 1px solid var(--line-strong, #b9ab95); background: var(--panel, #fffdf8); padding: 6px 10px; border-radius: 3px; cursor: pointer; font-family: var(--mono, ui-monospace, monospace); font-size: 9px; letter-spacing: .04em; text-transform: uppercase; }
    button:hover { border-color: var(--ink, #1d1a16); background: var(--panel-2, #f1eadc); }
  </style>
  <script>
    (function () {
      "use strict";
      var host = window.__OSMOGRAPH_VIAL_HOST__;
      document.querySelectorAll("[data-action]").forEach(function (button) {
        button.addEventListener("click", function () {
          if (host && host.capabilities.requestAction) {
            host.requestAction(button.dataset.action).catch(function () {});
          }
        });
      });
      if (host) {
        host.on("tick", function () {});
      }
    })();
  </script>
</div>`;

fs.writeFileSync(path.join(outDir, 'home.html'), homeHtml);

const fixture = {
  id: 'baseline-drift',
  file: 'fixtures/baseline-drift.json',
  expect: 'normal',
  state: {
    baseline: { state: 'ready', progress: 1, ageSec: 120 },
    anomaly: { state: 'normal', score: null, confidence: null, alertLevel: 0, triggeredChannels: 0, consecutive: 0 },
    channels: [{ id: 'ch0', label: 'VOC', kind: 'gas', unit: 'ohms', health: 'ok' }],
    environment: { temperature: 21, humidity: 45 },
  },
  series: {
    source: 'live', label: 'baseline', channels: ['VOC'],
    time: [], timeUnit: 's', values: [[]],
    fingerprint: [0], evolution: null,
    response: { baseline: 'first-n', response: 'delta-over-r0', conditioning: ['median3'], values: [[0]] },
  },
};
fs.writeFileSync(
  path.join(outDir, 'fixtures', 'baseline-drift.json'),
  JSON.stringify(fixture, null, 2) + '\n',
);

const evidence = `# Evidence — ${name}

## Report
Placeholder. Replace \`evidence.reportUrl\` with a real HTTPS URL to a held-out report you have written. Do not invent a report.

## Dataset
Describe the corpus, rig, unit count, sessions, and preparation. Replace \`evidence.dataset\` in vial.json.

## Metrics
Replace \`evidence.metrics\` in vial.json with at least one measured number (\`farPerMonth\`, \`latencyS\`, \`mde\`, \`nSamples\`, \`nAlarms\`). Never invent a number.

## Grade
Current placeholder grade: D. State the grade your evidence actually supports (A–D). A grade is not a safety certification.

## Fixture
\`fixtures/baseline-drift.json\` declares one declarative case. The host gate checks the static surface; the live proof is on your array.

## Limits
${manifest.limits.map(function (l) { return '- ' + l; }).join('\n')}
`;

fs.writeFileSync(path.join(outDir, 'EVIDENCE.md'), evidence);

const readme = `# ${name}

${manifest.summary}

## What it is
A programmable anomaly workspace for the Osmograph array, in the \`${domain}\` domain.

## What it is not
Not a compound identifier, not a concentration meter, not a safety certificate. ${manifest.limits[0]}

## Installation
Host this folder (for example on GitHub Pages) and install the raw \`vial.json\` URL from the Vials tab → "Install a Vial from URL". Osmograph fetches the manifest, verifies the gate, fetches \`ui.html\` and \`home.html\` over HTTPS, and pins their hashes.

## Authoring
- \`vial.json\`: the v2 manifest (profile, scope, limits, evidence, capabilities). Edit with \`npm run validate:vial -- .\`.
- \`ui.html\`: sandboxed workspace body fragment. No network, storage, or \`setDetection\`/\`setTransforms\` — the profile is the program.
- \`fixtures/baseline-drift.json\`: one declarative fixture for the Gated listing gate.
- \`EVIDENCE.md\`: your held-out report. Fill in real measured values before seeking a listing.

## Capabilities
${manifest.capabilities.map(function (c) { return '- ' + c; }).join('\n')}
`;

fs.writeFileSync(path.join(outDir, 'README.md'), readme);

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

console.log(`Created Vial project at: ${outDir}`);
console.log('Files: vial.json, ui.html, home.html, fixtures/baseline-drift.json, EVIDENCE.md, README.md');
console.log(`Next: npm run validate:vial -- ${vialId}`);
