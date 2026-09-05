import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// === Constants ===
const MAX_TRACE = 800;
const MAX_HISTORY = 20000; // long rolling history for scrub / rewind (beyond the 800-sample view)
const LIVE_WINDOW_DEFAULT = 800; // default trailing-sample window; reset-zoom target
// Cool, distinguishable trace palette (cyan→blue→indigo→violet) that stays
// readable on the warm paper canvas without going rainbow. The first 8 entries
// are the hand-tuned anchor hues; anything beyond is generated on the fly so
// every channel (up to 64) gets its own distinct color.
const PALETTE_ANCHORS = ['#0891b2', '#4338ca', '#0e7490', '#2563eb', '#06b6d4', '#7c3aed', '#164e63', '#93c5fd'];

// Golden-angle hue stepper keeps generated colors maximally separated so
// high channel counts never land on visually identical traces.
const GOLDEN_ANGLE = 137.50776405003785;
function channelColor(i: number): string {
  if (i < PALETTE_ANCHORS.length) return PALETTE_ANCHORS[i];
  // Cool range ~ 160° (cyan) → 280° (violet); walk it with the golden angle.
  const n = i - PALETTE_ANCHORS.length;
  const hue = (160 + (n * GOLDEN_ANGLE) % 120) % 360;
  return `hsl(${hue.toFixed(1)} 62% 42%)`;
}
// Legacy alias: callers keep working but color-per-channel is now unbounded.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const CH_COLORS = PALETTE_ANCHORS;
const chColor = (i: number) => channelColor(i);
const PRESETS: Record<string, { name: string; sensors: string[] }> = {
  '3-sensor-food': { name: '3-Sensor Food', sensors: ['MQ-135', 'MQ-3', 'MQ-7'] },
  '4-sensor-safety': { name: '4-Sensor Safety', sensors: ['MQ-7', 'MQ-8', 'MQ-135', 'MQ-3'] },
  '6-sensor-full': { name: '6-Sensor Full', sensors: ['MQ-135', 'MQ-3', 'MQ-6', 'MQ-7', 'MQ-4', 'MQ-8'] },
  '8-sensor-max': { name: '8-Sensor Max', sensors: ['MQ-135', 'MQ-3', 'MQ-6', 'MQ-7', 'MQ-4', 'MQ-8', 'MQ-2', 'MQ-9'] },
};

// === Channel kinds ===
// Semantic meaning per streamed column. Default: classic analog MOX. Firmware
// declares richer rigs (MEMS, DHT env, fan) with an `OSMK` line — the parser
// defaults every column to analog_mox when absent, so v1 MQ rigs are untouched.
// Kinds drive honest unit tags and keep a mixed MQ+MEMS array comparable.
type ChannelKind = 'analog_mox' | 'mems_index' | 'env_temp' | 'env_hum' | 'fan';
const KIND_META: Record<ChannelKind, { unit: string; tag: string }> = {
  analog_mox: { unit: 'ΔR/R₀', tag: 'MOX' },
  mems_index: { unit: 'idx', tag: 'I²C' },
  env_temp: { unit: '°C', tag: 'T' },
  env_hum: { unit: '%RH', tag: 'RH' },
  fan: { unit: 'rpm', tag: 'FAN' },
};
const KIND_GLYPH: Record<ChannelKind, string> = {
  analog_mox: '∿', mems_index: '◍', env_temp: '◇', env_hum: '≋', fan: '→',
};
let channelKinds: ChannelKind[] = [];
function inferKind(name: string): ChannelKind {
  const n = name.toUpperCase();
  if (/SGP|BME|CCS|MICS|MEMS|DIGITAL/.test(n)) return 'mems_index';
  if (/TEMP|DHT.*T/.test(n)) return 'env_temp';
  if (/HUM/.test(n)) return 'env_hum';
  if (/FAN|RPM/.test(n)) return 'fan';
  return 'analog_mox';
}
function kindOf(i: number): ChannelKind {
  if (i >= 0 && i < channelKinds.length) return channelKinds[i];
  return inferKind(chNames[i] || `CH${i + 1}`);
}
function applyChannelKinds(kinds: string[]) {
  if (!kinds || kinds.length < 1) return;
  const known: Record<string, ChannelKind> = {
    'analog_mox': 'analog_mox', 'mems_index': 'mems_index',
    'env_temp': 'env_temp', 'env_hum': 'env_hum', 'fan': 'fan',
  };
  // The kinds row implies the streamed channel width — align the rig so a mixed
  // declaration never drops or pads columns.
  if (kinds.length !== chNames.length) {
    const names = Array.from({ length: kinds.length }, (_, i) => chNames[i] || `CH${i + 1}`);
    if (connected) setChannelCount(kinds.length, names);
    else chNames = names;
  }
  channelKinds = chNames.map((name, i) => {
    const k = kinds[i];
    if (k && k in known) return known[k];
    return inferKind(name);
  });
}

// Ambient telemetry from the device's `ENV` frame (°C / %RH). Rendered as a
// quiet tagbar readout; NaN halves (unparseable on the device) are skipped so
// we never print a fake telemetry number.
let lastEnv: { temperature: number; humidity: number } | null = null;
function renderEnvReadout(env: { temperature: number; humidity: number } | null) {
  const el = document.getElementById('plotEnv');
  if (!el) return;
  if (!env || (!Number.isFinite(env.temperature) && !Number.isFinite(env.humidity))) {
    el.textContent = '';
    el.title = '';
    lastEnv = null;
    return;
  }
  lastEnv = env;
  const parts: string[] = [];
  if (Number.isFinite(env.temperature)) parts.push(`◇ ${env.temperature.toFixed(1)}°C`);
  if (Number.isFinite(env.humidity)) parts.push(`≋ ${env.humidity.toFixed(0)}%RH`);
  el.textContent = parts.join(' · ');
  el.title = 'Ambient telemetry from the device (ENV frame)';
}

// User-saved rig presets (persisted to localStorage). Unlike the built-in
// presets these can describe any channel count — the backend auto-assigns ADC
// pins from the count, so any board works out of the box.
interface CustomPreset { id: string; name: string; n_channels: number; sensors: string[]; peripherals?: { oledEnabled: boolean; buzzerEnabled: boolean }; }
const CP_KEY = 'osmograph.customPresets.v1';
let customPresets: CustomPreset[] = [];
function loadCustomPresets() { try { customPresets = JSON.parse(localStorage.getItem(CP_KEY) || '[]'); } catch { customPresets = []; } }
function persistCustomPresets() { try { localStorage.setItem(CP_KEY, JSON.stringify(customPresets)); } catch { /* ignore */ } }
function isCustomPreset(id: string): boolean { return id.startsWith('custom:'); }
// Channel count for any preset id (built-in or custom). 0 => auto-detect.
function presetChannelCount(id: string): number {
  if (isCustomPreset(id)) { const c = customPresets.find(p => p.id === id); return c ? c.n_channels : 0; }
  const b = PRESETS[id]; return b ? b.sensors.length : 0;
}
// Auto-assigned analog (ADC) GPIO pinout — mirrors the Rust
// `sensor_pins_for` so the on-screen mapping table shows the *real* firmware
// pins rather than a decorative 32+i*2 guess. Order matters: historical 3/4/6
// pinouts kept stable, then ADC1 (36,39) before ADC2 (27,14,12,13).
const PIN_ORDER: number[] = [32, 33, 34, 35, 25, 26, 36, 39, 27, 14, 12, 13];
function presetPins(count: number): number[] {
  const n = Math.max(1, Math.min(count, PIN_ORDER.length));
  return PIN_ORDER.slice(0, n);
}

// Human-readable descriptors for the sensor-to-channel mapping table.
const SENSOR_INFO: Record<string, { name: string; target: string; range: string }> = {
  'MQ-135': { name: 'MQ-135', target: 'Air quality / NH₃, benzene, CO₂', range: '10 – 1000 ppm' },
  'MQ-3':  { name: 'MQ-3',  target: 'Alcohol / ethanol, smoke', range: '0.05 – 10 mg/L' },
  'MQ-6':  { name: 'MQ-6',  target: 'LPG, butane, propane', range: '200 – 10000 ppm' },
  'MQ-7':  { name: 'MQ-7',  target: 'Carbon monoxide (CO)', range: '20 – 2000 ppm' },
  'MQ-4':  { name: 'MQ-4',  target: 'Methane (CH₄), natural gas', range: '300 – 10000 ppm' },
  'MQ-8':  { name: 'MQ-8',  target: 'Hydrogen (H₂)', range: '100 – 10000 ppm' },
};

function toDataChannels(values: number[]): number[] {
  // In auto-detect mode (channelCount === 0) the count is learned from the
  // device's first stream; use the incoming width until detection fills it in.
  const n = channelCount > 0 ? channelCount : values.length;
  const out = values.slice(0, n);
  while (out.length < n) out.push(0);
  return out;
}

// === State ===
let connected = false;
let activeMode: 'serial' | 'wifi' | 'ble' = 'serial';
let channelCount = 0;
let sessionStart: number | null = null;
let sampleCount = 0;
let lastSampleTime = 0;
let lastDataAt = 0; // wall-clock of the last successfully-ingested reading (stall watchdog)
let bootloaderHinted = false; // device answered in bootloader during the current link session
let bootFlashShown = false;   // the Flash modal was already auto-offered during this bootloader stall
let autoChannels = 0;         // channel count auto-detected from the live device stream (0 = none yet)
let activePreset = '6-sensor-full';
let chNames: string[] = PRESETS['6-sensor-full'].sensors;
let traceData: number[][] = chNames.map(() => []);
// History ring: a longer rolling buffer (independent of the 800-sample display
// window) so the user can rewind / scrub / fast-forward through recent history.
let historyData: number[][] = chNames.map(() => []);
let liveScrollSeek = 0;      // samples back from the newest sample the view is anchored at (0 = live)
let isLiveScrubbing = false; // a scrub is dragging / or user rewound: show frozen history window
// Trading-view style hover crosshair + geometry captured each draw for mapping
// cursor -> sample / value, plus interactive legend hover-highlight.
let cursorPX = -1, cursorPY = -1;
let hoverSeries = -1; // legend chip hovered: highlight that channel's trace
let lastPlotGeo: { wlen: number; gMin: number; gMax: number; slices: number[][] } | null = null;

// Live transport controls (pause / clear / time-window zoom). Pausing freezes
// the visible plot on a snapshot; ingestion keeps a live copy, and every
// frame we draw either the frozen view or the current buffer.
let livePaused = false;
let frozenTrace: number[][] = [];
let liveWindowSamples = 800; // trailing samples drawn on the x-axis
let liveRateHz = 20;         // updated from measured sample timing, falls back to 20
let sessionLabels: { ts: number; anomaly: boolean; note: string }[] = [];let sessions: SessionRecord[] = [];
let selectedSession: number | null = null;
let compareFiles: string[] = [];
const compareSeriesCache = new Map<string, SessionSeries | null>();
let compareLoaded: (SessionSeries | null)[] = [];
let activeCompareChannels: string[] = [];
let compareMode: 'overlay' | 'delta' | 'heatmap' = 'overlay';
let compareRefIdx = 0;
let fleetDevices: FleetDevice[] = [];
let bleDevices: { name: string; address: string }[] = [];
let oledPage = 0;
let dataDirValue = '';

// === Classifier state ===
let trainSelected = new Set<string>();
let liveSnapshot: LiveSnapshot | null = null;

interface SessionRecord {
  id: string;
  time: string;
  substance: string;
  label: string;
  format: string;
  duration: string;
  sensors: number;
  quality: number;
  path?: string;
  file_id?: string;
  quality_report?: QualityReport | null;
}

interface HubEntry {
  id: string;
  contributor: string;
  substance: string;
  device_id: string;
  submitted_at: string;
  quality_score: number;
  status: string;
  n_samples: number;
  n_channels: number;
  verification_log: string[];
  data_path: string;
}

interface HfFile {
  path: string;
  size: number;
}

interface FleetDevice {
  id: string;
  name: string;
  status: 'online' | 'offline' | 'warning';
  sensors: { name: string; value: number; health: string }[];
  firmware_version: string;
  n_channels: number;
  port: string;
  uptime_seconds: number;
  ip: string;
  kind: string;
  is_recognized: boolean;
}

interface SessionSeries {
  label: string;
  channels: string[];
  time: number[];
  values: number[][];
}

interface ClassifierInfo {
  name: string;
  file_id: string;
  path: string;
  mtime: number;
  n_classes: number;
  n_sensors: number;
  window_size: number;
  accuracy: number;
  loro_accuracy: number;
  warnings: string[];
}

interface ConfusionCell { actual: string; predicted: string; count: number }

interface ModelCard {
  accuracy: number;
  loro_mean_accuracy: number;
  in_sample_accuracy: number;
  per_class_precision: Record<string, number>;
  per_class_recall: Record<string, number>;
  confusion: ConfusionCell[];
  similarity: { class_a: string; class_b: string; cosine: number; fdr_mean: number; scaled_distance: number }[];
  warnings: string[];
}

interface TrainingReport {
  success: boolean;
  error: string | null;
  name: string;
  classes: string[];
  n_windows: number;
  windows_per_class: Record<string, number>;
  recordings_per_class: Record<string, number>;
  accuracy: number;
  loro_mean_accuracy: number;
  in_sample_accuracy: number;
  warnings: string[];
  model_json: string;
}

interface LiveSnapshot {
  loaded: boolean;
  classifier_name: string;
  loaded_path: string;
  classes: string[];
  n_sensors: number;
  window_size: number;
  confidence_threshold: number;
  training_accuracy: number;
  current_probs: number[];
  current_prediction: { label: string; confidence: number };
  lock_count: number;
  unknown_count: number;
  locked: boolean;
  locked_class: string;
  is_unknown: boolean;
  buffer_len: number;
}

// === Tab Navigation ===
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const tab = (btn as HTMLElement).dataset.tab!;
    document.getElementById(`panel-${tab}`)?.classList.add('active');
    if (tab === 'dashboard') {
      requestAnimationFrame(() => resizeTraces());
    } else if (tab === 'compare') {
      requestAnimationFrame(() => updateCompare());
    }
  });
});

document.querySelectorAll('.sys-nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.sys-nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.sys-panel').forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    const sys = (item as HTMLElement).dataset.sys!;
    document.getElementById(`sys-${sys}`)?.classList.add('active');
  });
});

// === Canvas: Traces ===
const tracesCanvas = document.getElementById('traces') as HTMLCanvasElement;
const tracesCtx = tracesCanvas.getContext('2d')!;

function resizeTraces() {
  const rect = tracesCanvas.parentElement!.getBoundingClientRect();
  // The dashboard tab may be hidden (display:none) when resize fires — a 0-size
  // canvas would then stay blank forever. Only adopt real sizes; the tab switch
  // handler re-runs resizeTraces when the dashboard becomes visible again.
  if (rect.width < 2 || rect.height < 2) return;
  tracesCanvas.width = Math.max(2, Math.floor(rect.width));
  tracesCanvas.height = Math.max(2, Math.floor(rect.height));
}
resizeTraces();
window.addEventListener('resize', resizeTraces);
new ResizeObserver(resizeTraces).observe(tracesCanvas.parentElement!);

function drawTraces() {
  const w = tracesCanvas.width, h = tracesCanvas.height;
  const gutterL = 44, gutterB = 18;
  const pw = w - gutterL, ph = h - gutterB;

  tracesCtx.fillStyle = '#f6f1e7';
  tracesCtx.fillRect(0, 0, w, h);

  // Source: frozen snapshot while paused, else the live buffer.
  const source = (livePaused && frozenTrace.length) ? frozenTrace : traceData;
  const liveSrc = (livePaused && frozenTrace.length) ? frozenTrace : historyData;
  const wlen = Math.max(2, liveWindowSamples);
  // Visible window per channel. When scrubbing (rewound / seeking), anchor the
  // window `liveScrollSeek` samples back from the newest sample instead of the
  // live trailing edge; otherwise show the newest data.
  const drawn = liveSrc[0] ? liveSrc : source;
  const slices: number[][] = drawn.map((chArr) => {
    const src = chArr.length ? chArr : [];
    if (src.length === 0) return [];
    if (isLiveScrubbing) {
      // Seek offset is samples back from the newest sample. Anchor the window's
      // RIGHT edge at `rightIndex` and always draw a full `wlen` slice so the
      // plot never stretches a short/partial window (that caused the slide/
      // glitch while rewinding). When fewer than `wlen` samples exist, draw all
      // of them (normal "not enough history yet" case, not a rewind artefact).
      const rightIndex = Math.max(0, src.length - liveScrollSeek);
      const start = Math.max(0, rightIndex - wlen);
      return src.slice(start, rightIndex);
    }
    return src.length <= wlen ? src.slice() : src.slice(src.length - wlen);
  });

  // Trading-view style leveled grid: choose a "nice" step for the value levels
  // (1/2/5×10^k) so the labels are clean, then render a strong major level every
  // step with a faint mid-level between. Time axis gets major 1s-ish + minor ticks.
  // Mixed rigs (MQ ΔR/R₀ + MEMS index + env + fan) live on incomparable scales,
  // so they get a fixed normalized 0→100% axis with each trace scaled to its own
  // window min/max — the crosshair still reads raw values with per-kind units.
  const mixed = mixedRig();
  const levels: number[] = [];
  let gMin: number, gMax: number;
  if (mixed) {
    gMin = 0;
    gMax = 1;
    levels.push(0, 0.25, 0.5, 0.75, 1);
  } else {
    let lo = Infinity, hi = -Infinity;
    for (const slice of slices) for (const v of slice) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo === Infinity) lo = 0;
    const rawRange = hi - lo || 1;
    gMin = lo - rawRange * 0.1;
    gMax = hi + rawRange * 0.1;

    // Nice step for vertical levels (aim for ~8 levels).
    const targetLevels = 8;
    const rough = (gMax - gMin) / targetLevels;
    const mag = Math.pow(10, Math.floor(Math.log10(rough || 1)));
    const normMag = rough / mag;
    const step = mag * (normMag < 1.5 ? 1 : normMag < 3.5 ? 2 : normMag < 7.5 ? 5 : 10);
    const first = Math.ceil(gMin / step) * step;
    for (let v = first; v <= gMax; v += step) levels.push(v);
    if (levels.length < 2) { levels.length = 0; levels.push(gMin, gMax); }
  }

  const span = gMax - gMin || 1;
  const geomY = (v: number) => ph - (ph * ((v - gMin) / span));

  // Minor mid-levels (half-step) drawn faintly, majors drawn stronger.
  tracesCtx.font = '9px monospace';
  tracesCtx.textAlign = 'right';
  tracesCtx.textBaseline = 'middle';
  const majorIdx = Math.max(1, Math.round(levels.length / 6));
  for (let li = 0; li < levels.length; li++) {
    const v = levels[li];
    const y = geomY(v);
    const minor = li % 2 === 1;
    tracesCtx.strokeStyle = minor ? '#efe7d6' : '#e2d8c2';
    tracesCtx.lineWidth = minor ? 0.6 : 1;
    tracesCtx.beginPath();
    tracesCtx.moveTo(gutterL, y);
    tracesCtx.lineTo(pw, y);
    tracesCtx.stroke();
    if (!minor) {
      const label = mixed ? `${Math.round(v * 100)}%` : (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0));
      tracesCtx.fillStyle = '#9a9484';
      tracesCtx.fillText(label, gutterL - 6, y);
    }
  }

  // Vertical time grid: minor ticks every ~1s, major (labeled) every ceil(4s).
  const totalSecs = Math.max(0.1, wlen / liveRateHz);
  const minorSpacingSecs = totalSecs / 24;
  const minorMs = Math.max(1, Math.round(minorSpacingSecs * liveRateHz));
  const majorSecs = Math.max(1, Math.ceil(totalSecs / 6));
  const majorMs = Math.round(majorSecs * liveRateHz);
  tracesCtx.textAlign = 'center';
  tracesCtx.textBaseline = 'top';
  // Draw minor ticks; detect majors by sample index spacing.
  const nMinor = Math.max(2, Math.ceil(wlen / minorMs));
  for (let i = 0; i <= nMinor; i++) {
    const s = Math.round(i * (wlen / nMinor));
    const x = gutterL + (s / (wlen - 1)) * pw;
    const major = Math.round(s / majorMs) * majorMs === s;
    tracesCtx.strokeStyle = major ? '#e0d6bf' : '#efeadb';
    tracesCtx.lineWidth = 1;
    tracesCtx.beginPath();
    tracesCtx.moveTo(x, 0);
    tracesCtx.lineTo(x, ph);
    tracesCtx.stroke();
    if (major) {
      // Seconds ago relative to NOW: the window's right edge sits
      // `liveScrollSeek` samples back from the newest when rewound.
      const secs = Math.round((liveScrollSeek + (wlen - s)) / liveRateHz);
      tracesCtx.fillStyle = '#9a9484';
      tracesCtx.fillText(`${secs}s`, x, ph + 4);
    }
  }
  tracesCtx.textAlign = 'left';
  tracesCtx.textBaseline = 'alphabetic';

  // Draw each channel's visible slice (highlight the hovered legend series).
  for (let ch = 0; ch < slices.length; ch++) {
    const slice = slices[ch];
    if (slice.length < 2) continue;
    const hidden = hiddenChannels.has(ch);
    const active = !hidden && (hoverSeries === -1 || hoverSeries === ch);
    tracesCtx.strokeStyle = channelColor(ch);
    tracesCtx.lineWidth = active ? (hoverSeries === ch ? 2.2 : 1.4) : 0.6;
    tracesCtx.globalAlpha = hidden ? 0.08 : (active ? 1 : 0.25);
    // Mixed rigs: normalize each trace to its own window min/max so shapes on
    // wildly different scales (ΔR/R₀ vs a 0–500 MEMS index vs °C/%RH) compare.
    let lo = 0, hi = 1;
    if (mixed) {
      lo = Infinity;
      hi = -Infinity;
      for (const v of slice) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const denom = (hi - lo) || 1;
    tracesCtx.beginPath();
    for (let i = 0; i < slice.length; i++) {
      const x = gutterL + (i / (wlen - 1)) * pw;
      const y = mixed
        ? (ph - (ph * ((slice[i] - lo) / denom)))
        : (ph - (ph * ((slice[i] - gMin) / span)));
      i === 0 ? tracesCtx.moveTo(x, y) : tracesCtx.lineTo(x, y);
    }
    tracesCtx.stroke();
    tracesCtx.globalAlpha = 1;
  }

  // Remember the visible geometry for crosshair mapping.
  lastPlotGeo = { wlen, gMin, gMax, slices };

  // Status overlay so it's obvious the plotted window is frozen / rewound.
  const statusLabel = livePaused
    ? '⏸ PAUSED — capturing behind the view'
    : isLiveScrubbing
      ? `⏪ REWOUND — at −${Math.round(liveScrollSeek / liveRateHz)}s`
      : null;
  if (statusLabel) {
    tracesCtx.fillStyle = 'rgba(217,88,16,0.08)';
    tracesCtx.fillRect(0, 0, w, ph);
    tracesCtx.fillStyle = '#d95810';
    tracesCtx.font = '600 10px monospace';
    tracesCtx.textAlign = 'left';
    tracesCtx.textBaseline = 'top';
    tracesCtx.fillText(statusLabel, gutterL + 6, 6);
    tracesCtx.textAlign = 'left';
    tracesCtx.textBaseline = 'alphabetic';
  }

  // Trading-view crosshair: read out the exact sample + values under the cursor.
  drawCrosshair(gutterL, pw, ph, wlen);

  // Box-zoom selection rectangle (shift+drag).
  if (box && dragStart) {
    const bx = Math.min(box.x0, box.x1), bx2 = Math.max(box.x0, box.x1);
    const by = Math.min(box.y0, box.y1), by2 = Math.max(box.y0, box.y1);
    tracesCtx.save();
    tracesCtx.strokeStyle = '#0891b2';
    tracesCtx.lineWidth = 1;
    tracesCtx.setLineDash([4, 3]);
    tracesCtx.strokeRect(bx, by, bx2 - bx, by2 - by);
    tracesCtx.fillStyle = 'rgba(8,145,178,0.08)';
    tracesCtx.fillRect(bx, by, bx2 - bx, by2 - by);
    tracesCtx.restore();
  }
}

function drawCrosshair(gutterL: number, pw: number, ph: number, wlen: number) {
  if (!lastPlotGeo || cursorPX < 0 || cursorPY < 0) return;
  const { gMin, gMax, slices } = lastPlotGeo;
  const inPlot = cursorPX >= gutterL && cursorPX <= gutterL + pw && cursorPY >= 0 && cursorPY <= ph;
  if (!inPlot) { drawCrosshairReadout(null); return; }

  const frac = (cursorPX - gutterL) / (pw || 1);
  const si = Math.round(frac * (wlen - 1));
  const idx = Math.max(0, Math.min(wlen - 1, si));
  const x = gutterL + idx * pw / ((wlen - 1) || 1);

  tracesCtx.save();
  // Vertical (time) crosshair.
  tracesCtx.strokeStyle = 'rgba(8,145,178,0.5)';
  tracesCtx.lineWidth = 1;
  tracesCtx.setLineDash([3, 3]);
  tracesCtx.beginPath(); tracesCtx.moveTo(x, -6); tracesCtx.lineTo(x, ph); tracesCtx.stroke();
  // Horizontal (value) crosshair.
  tracesCtx.strokeStyle = 'rgba(8,145,178,0.35)';
  tracesCtx.beginPath(); tracesCtx.moveTo(gutterL, cursorPY); tracesCtx.lineTo(gutterL + pw, cursorPY); tracesCtx.stroke();
  tracesCtx.setLineDash([]);

  // Time readout box pinned above the vertical line.
  const secs = Math.round(idx / liveRateHz);
  const tboxTxt = '-' + secs + 's';
  tracesCtx.font = '500 9px monospace';
  const tw = tracesCtx.measureText(tboxTxt).width;
  const tbx0 = Math.max(gutterL, Math.min(gutterL + pw - tw - 6, x - tw / 2 - 3));
  tracesCtx.fillStyle = '#0891b2';
  tracesCtx.fillRect(tbx0, 2, tw + 6, 12);
  tracesCtx.fillStyle = '#f6f1e7';
  tracesCtx.textAlign = 'left';
  tracesCtx.textBaseline = 'middle';
  tracesCtx.fillText(tboxTxt, tbx0 + 3, 8);
  tracesCtx.restore();

  // Per-channel values at the hovered sample.
  const vals: { name: string; v: number }[] = [];
  slices.forEach((slice, c) => {
    if (idx < slice.length) vals.push({ name: chNames[c] || `CH${c}`, v: slice[idx] });
  });
  drawCrosshairReadout(vals);
}

function drawCrosshairReadout(vals: { name: string; v: number }[] | null) {
  const el = document.getElementById('hoverReadout');
  if (!el) return;
  if (!vals || vals.length === 0) { el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = 'flex';
  const n = vals.slice(0, 12).map(({ name, v }) => {
    const c = chNames.indexOf(name);
    const color = channelColor(c >= 0 ? c : 0);
    const unit = KIND_META[kindOf(c >= 0 ? c : 0)].unit;
    const label = Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(2)}k` : v.toFixed(2);
    return `<span class="xr-item"><i class="xr-dot" style="background:${color}"></i>${name} <b>${label} ${unit}</b></span>`;
  }).join('');
  el.innerHTML = n;
}

// === Canvas: Fingerprint (radar) ===
const fpCanvas = document.getElementById('fingerprint') as HTMLCanvasElement;
const fpCtx = fpCanvas.getContext('2d')!;

function drawFingerprint(values: number[]) {
  const rect = fpCanvas.parentElement!.getBoundingClientRect();
  fpCanvas.width = Math.max(1, Math.floor(rect.width - 8));
  fpCanvas.height = Math.max(80, Math.floor(rect.height - 8));
  const w = fpCanvas.width, h = fpCanvas.height;
  const cx = w / 2, cy = h / 2, r = Math.min(cx, cy) - 10;
  fpCtx.clearRect(0, 0, w, h);

  const n = values.length || chNames.length;
  if (n === 0) return;

  // Grid rings
  for (let ring = 1; ring <= 4; ring++) {
    fpCtx.strokeStyle = '#d7cdba';
    fpCtx.lineWidth = 1;
    fpCtx.beginPath();
    for (let i = 0; i <= n; i++) {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const rr = (ring / 4) * r;
      const x = cx + Math.cos(angle) * rr;
      const y = cy + Math.sin(angle) * rr;
      i === 0 ? fpCtx.moveTo(x, y) : fpCtx.lineTo(x, y);
    }
    fpCtx.stroke();
  }

  // Axes
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    fpCtx.strokeStyle = '#d7cdba';
    fpCtx.beginPath();
    fpCtx.moveTo(cx, cy);
    fpCtx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
    fpCtx.stroke();
  }

  if (values.length === 0) return;

  // Normalize values
  const maxVal = Math.max(...values, 1);

  // Fill — cyan (live monitoring data accent), per the paper & ink discipline
  fpCtx.fillStyle = 'rgba(14, 116, 144, 0.12)';
  fpCtx.strokeStyle = '#0e7490';
  fpCtx.lineWidth = 2;
  fpCtx.beginPath();
  for (let i = 0; i <= n; i++) {
    const idx = i % n;
    const angle = (idx / n) * Math.PI * 2 - Math.PI / 2;
    const norm = values[idx] !== undefined ? values[idx] / maxVal : 0;
    const x = cx + Math.cos(angle) * r * norm;
    const y = cy + Math.sin(angle) * r * norm;
    i === 0 ? fpCtx.moveTo(x, y) : fpCtx.lineTo(x, y);
  }
  fpCtx.closePath();
  fpCtx.fill();
  fpCtx.stroke();

  // Dots and labels
  fpCtx.font = '9px -apple-system, sans-serif';
  fpCtx.textAlign = 'center';
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    const norm = values[i] !== undefined ? values[i] / maxVal : 0;
    const x = cx + Math.cos(angle) * r * norm;
    const y = cy + Math.sin(angle) * r * norm;
    fpCtx.fillStyle = channelColor(i);
    fpCtx.beginPath();
    fpCtx.arc(x, y, 3, 0, Math.PI * 2);
    fpCtx.fill();

    // Label outside
    const lx = cx + Math.cos(angle) * (r + 8);
    const ly = cy + Math.sin(angle) * (r + 8);
    fpCtx.fillStyle = '#666';
    fpCtx.fillText(chNames[i] || `CH${i}`, lx, ly + 3);
  }
}

// === Canvas: Session Fingerprint ===
const sfpCanvas = document.getElementById('session-fp') as HTMLCanvasElement;
const sfpCtx = sfpCanvas?.getContext('2d');

function drawSessionFingerprint(values: number[]) {
  if (!sfpCtx || !sfpCanvas) return;
  const rect = sfpCanvas.parentElement!.getBoundingClientRect();
  sfpCanvas.width = rect.width - 20;
  sfpCanvas.height = 140;
  const w = sfpCanvas.width, h = sfpCanvas.height;
  const cx = w / 2, cy = h / 2, rr = Math.min(cx, cy) - 14;
  sfpCtx.clearRect(0, 0, w, h);
  const n = values.length || chNames.length;
  if (n === 0) return;
  for (let ring = 1; ring <= 4; ring++) {
    sfpCtx.strokeStyle = '#d7cdba'; sfpCtx.lineWidth = 1; sfpCtx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(a) * rr * (ring / 4);
      const y = cy + Math.sin(a) * rr * (ring / 4);
      i === 0 ? sfpCtx.moveTo(x, y) : sfpCtx.lineTo(x, y);
    }
    sfpCtx.stroke();
  }
  const maxVal = Math.max(...values, 1);
  sfpCtx.fillStyle = 'rgba(17, 17, 17, 0.06)';
  sfpCtx.strokeStyle = '#1a1a17'; sfpCtx.lineWidth = 2;
  sfpCtx.beginPath();
  for (let i = 0; i <= n; i++) {
    const idx = i % n;
    const a = (idx / n) * Math.PI * 2 - Math.PI / 2;
    const norm = values[idx] !== undefined ? values[idx] / maxVal : 0;
    const x = cx + Math.cos(a) * rr * norm;
    const y = cy + Math.sin(a) * rr * norm;
    i === 0 ? sfpCtx.moveTo(x, y) : sfpCtx.lineTo(x, y);
  }
  sfpCtx.closePath(); sfpCtx.fill(); sfpCtx.stroke();
  sfpCtx.font = '9px -apple-system, sans-serif'; sfpCtx.textAlign = 'center';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const norm = values[i] !== undefined ? values[i] / maxVal : 0;
    sfpCtx.fillStyle = channelColor(i);
    sfpCtx.beginPath(); sfpCtx.arc(cx + Math.cos(a) * rr * norm, cy + Math.sin(a) * rr * norm, 3, 0, Math.PI * 2); sfpCtx.fill();
    sfpCtx.fillStyle = '#666';
    sfpCtx.fillText(chNames[i] || `CH${i}`, cx + Math.cos(a) * (rr + 10), cy + Math.sin(a) * (rr + 10) + 3);
  }
}

// === Trace Legend ===
// Toggleable, hover-to-highlight channels (trading-view style). Hovering a chip
// dims other channels so you can isolate a sensor; clicking toggles it on/off.
let hiddenChannels = new Set<number>();
// A rig is "mixed" when its streamed columns carry more than one semantic kind
// (MQ ΔR/R₀ + MEMS index + DHT env + fan RPM). Mixed arrays live on different
// scales, so the plot normalizes each trace to its own window min/max — the
// crosshair readout still shows the raw values with per-kind units (honest).
function mixedRig(): boolean {
  const kinds = new Set<ChannelKind>();
  for (let i = 0; i < chNames.length; i++) kinds.add(kindOf(i));
  return kinds.size > 1;
}
function updatePlotScaleNote() {
  const el = document.getElementById('plotScaleNote');
  if (!el) return;
  if (mixedRig()) {
    el.textContent = 'MIXED RIG · axis per-channel';
    el.title = 'Channels carry different units — each trace is scaled to its own window min/max so shapes compare. Crosshair readout shows raw values with units; see the legend.';
    el.style.display = '';
  } else {
    el.textContent = '';
    el.title = '';
    el.style.display = 'none';
  }
}
function buildLegend() {
  const el = document.getElementById('traceLegend')!;
  el.innerHTML = chNames.map((name, i) => {
    const k = kindOf(i);
    const meta = KIND_META[k];
    return `<span class="tl-chip" data-ch="${i}" title="${name} · ${meta.tag} (${meta.unit}) — hover to isolate, click the eye to toggle"><span class="swatch" style="background:${channelColor(i)}"></span><span class="tl-eye" title="Show / hide this sensor">◉</span><span class="tl-kind" title="${meta.tag}">${KIND_GLYPH[k]}</span>${name}<span class="tl-unit">${meta.unit}</span></span>`;
  }).join('');
  updatePlotScaleNote();
  el.querySelectorAll<HTMLElement>('.tl-chip').forEach((chip) => {
    chip.addEventListener('mouseenter', () => { hoverSeries = parseInt(chip.dataset.ch || '-1', 10); });
    chip.addEventListener('mouseleave', () => { hoverSeries = -1; });
    chip.addEventListener('click', (e) => {
      const c = parseInt(chip.dataset.ch || '-1', 10);
      if (c < 0) return;
      if (hiddenChannels.has(c)) hiddenChannels.delete(c); else hiddenChannels.add(c);
      syncLegendState(chip, c);
    });
  });
}
function syncLegendState(chip: HTMLElement, c: number) {
  chip.classList.toggle('tl-off', hiddenChannels.has(c));
  const eye = chip.querySelector('.tl-eye') as HTMLElement | null;
  if (eye) eye.textContent = hiddenChannels.has(c) ? '○' : '◉';
}
buildLegend();

// Hover crosshair over the trace canvas.
tracesCanvas?.addEventListener('mousemove', (e) => {
  const r = tracesCanvas.getBoundingClientRect();
  cursorPX = e.clientX - r.left;
  cursorPY = e.clientY - r.top;
});
tracesCanvas?.addEventListener('mouseleave', () => { cursorPX = -1; cursorPY = -1; drawCrosshairReadout(null); });
tracesCanvas?.addEventListener('click', () => { cursorPX = -1; cursorPY = -1; drawCrosshairReadout(null); });

// === Data Ingestion ===
async function ingestReading(values: number[]) {
  if (values.length === 0) return;
  // Channels are auto-detected from the device (Rust `serial-auto`/`serial-info`
  // events → applyDetectedChannels). Here we just push whatever the stream gave.
  for (let ch = 0; ch < Math.min(values.length, traceData.length); ch++) {
    traceData[ch].push(values[ch]);
    if (traceData[ch].length > MAX_TRACE) traceData[ch].shift();
    historyData[ch].push(values[ch]);
    if (historyData[ch].length > MAX_HISTORY) historyData[ch].shift();
  }
  sampleCount++;

  // HUD readout
  const samplesEl = document.getElementById('plotSamples');
  if (samplesEl) samplesEl.textContent = `${sampleCount.toLocaleString()} SAMP`;

  // Update fingerprint
  drawFingerprint(values);

  try {
    const result = await invoke<{
      is_anomaly: boolean; raw_score: number; calibrated_confidence: number;
      triggered_channels: number[]; alert_level: number; alert_name: string;
      consecutive_anomalies: number; warming_up: boolean; baseline_progress: number;
    }>('ingest_reading_with_failsafe', { reading: values });

    // Anomaly card
    const card = document.getElementById('anomalyCard')!;
    if (result.warming_up) {
      // Baseline not established yet — show honest warm-up progress instead of
      // either a false "ANOMALY" or a premature "NORMAL".
      card.className = 'anomaly-card';
      document.getElementById('anomalyLabel')!.textContent = 'CALIBRATING';
      const pct = Math.round((result.baseline_progress ?? 0) * 100);
      document.getElementById('anomalySub')!.textContent = `Establishing baseline for detection… ${pct}%`;
      document.getElementById('mMahal')!.textContent = '—';
      document.getElementById('mConf')!.textContent = '—';
      document.getElementById('mCh')!.textContent = `—/${chNames.length}`;
      document.getElementById('mAlert')!.textContent = 'warming_up';
      const wDot = document.getElementById('statusDot')!;
      wDot.className = 'status-dot warn';
    } else {
      card.className = 'anomaly-card' + (result.is_anomaly ? (result.alert_level >= 2 ? ' critical' : ' warning') : '');
      document.getElementById('anomalyLabel')!.textContent = result.is_anomaly ? 'ANOMALY DETECTED' : 'NORMAL';
      document.getElementById('anomalySub')!.textContent =
        result.is_anomaly ? `${result.alert_name.toUpperCase()} — ${result.consecutive_anomalies} consecutive` : 'All channels nominal';
      document.getElementById('mMahal')!.textContent = result.raw_score.toFixed(2);
      document.getElementById('mConf')!.textContent = result.is_anomaly
        ? `${(result.calibrated_confidence * 100).toFixed(0)}%`
        : `${((1 - result.calibrated_confidence) * 100).toFixed(0)}%`;
      document.getElementById('mCh')!.textContent = `${result.triggered_channels.length}/${chNames.length}`;
      document.getElementById('mAlert')!.textContent = result.alert_name;

      const statusDot = document.getElementById('statusDot')!;
      if (result.is_anomaly) {
        statusDot.className = result.alert_level >= 2 ? 'status-dot crit' : 'status-dot warn';
      } else {
        statusDot.className = connected ? 'status-dot ok' : 'status-dot';
      }
    }
  } catch (err) {
    console.error('Detection error:', err);
  }

  // Rate counter
  const now = Date.now();
  if (lastSampleTime > 0) {
    const rate = 1000 / (now - lastSampleTime);
    liveRateHz = Math.min(200, Math.max(1, rate));
    document.getElementById('fRate')!.textContent = `${rate.toFixed(1)} Hz`;
  }
  lastSampleTime = now;
  lastDataAt = now;
  if (bootloaderHinted) {
    // Real data is flowing again — clear the bootloader diagnosis.
    bootloaderHinted = false;
    const banner = document.getElementById('bootBanner');
    if (banner) banner.classList.remove('show');
  }
  document.getElementById('fSamples')!.textContent = sampleCount.toString();
}

// === Session Time ===
function updateSessionTime() {
  if (sessionStart === null) return;
  const elapsed = Date.now() / 1000 - sessionStart;
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = Math.floor(elapsed % 60);
  const ts = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  document.getElementById('fSession')!.textContent = ts;
}

// === Port Management ===
async function refreshPorts() {
  try {
    const ports = await invoke<{ name: string; description: string; kind: string; hw_type: string; manufacturer: string }[]>('list_serial_ports');
    const sel = document.getElementById('portSelect') as HTMLSelectElement;
    const cur = sel.value;
    sel.innerHTML = '<option value="">Select port...</option>';
    for (const p of ports) {
      const opt = document.createElement('option');
      opt.value = p.name;
      const kind = p.kind;
      const boardLabel = kind === 'osmograph-e-nose' ? 'ESP32 e-nose' :
        kind && kind !== 'unknown-usb' ? kind.replace(/_/g, ' ').toUpperCase() : 'USB-SERIAL';
      // Every USB/BT serial device is listed and connectable — Arduino, Pico,
      // or any third-party controller — regardless of whether we recognise its
      // VID:PID. Unknown boards still get the manufacturer/product name shown.
      const desc = p.description || p.manufacturer || '';
      opt.textContent = `${p.name} · ${boardLabel}${desc ? ' — ' + desc : ''}`;
      if (p.name === cur) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch (e) {
    console.error('Port refresh failed:', e);
  }
}

// === Last connection memory (Python parity: reconnect to the same port on
// startup so plug-in-and-go works for Arduino / any controller) ===
const LAST_CONN_KEY = 'osmograph.lastConn';
type LastConn = { mode: string; baud: string; port: string; addr: string; ble: string };

function saveLastConnection() {
  try {
    const conn: LastConn = {
      mode: (document.getElementById('modeSelect') as HTMLSelectElement).value,
      baud: (document.getElementById('baudSelect') as HTMLSelectElement).value,
      port: (document.getElementById('portSelect') as HTMLSelectElement).value,
      addr: (document.getElementById('wifiAddr') as HTMLInputElement).value.trim(),
      ble: (document.getElementById('bleSelect') as HTMLSelectElement).value,
    };
    localStorage.setItem(LAST_CONN_KEY, JSON.stringify(conn));
  } catch { /* ignore */ }
}

function restoreLastConnection(): LastConn | null {
  try {
    return JSON.parse(localStorage.getItem(LAST_CONN_KEY) || 'null') as LastConn | null;
  } catch { return null; }
}

// === BLE ===
async function scanBleDevices() {
  const sel = document.getElementById('bleSelect') as HTMLSelectElement;
  const cur = sel.value;
  sel.innerHTML = '<option value="">Scanning (5s)...</option>';
  try {
    const devices = await invoke<Array<{ name: string; address: string }>>('list_ble_devices', { timeoutSec: 5 });
    bleDevices = devices;
    sel.innerHTML = '<option value="">Select device…</option>';
    if (devices.length === 0) {
      sel.innerHTML = '<option value="">No e-nose found — is it on & advertising?</option>';
      return;
    }
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d.address;
      opt.textContent = `${d.name} (${d.address})`;
      if (d.address === cur) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch (e) {
    sel.innerHTML = '<option value="">Scan failed</option>';
    console.error('BLE scan failed:', e);
  }
}

// === Connection ===
function setPlotLink(on: boolean) {
  const el = document.getElementById('plotLinkState');
  if (!el) return;
  el.textContent = on ? '● LIVE LINK' : '● NO LINK';
  el.classList.remove('stall');
  el.classList.toggle('on', on);
}

// Stall watchdog: if we claim to be connected but no reading has arrived for a
// few seconds, flag it — a plugged device that isn't streaming now visibly
// shows as "NO DATA" instead of silently looking live.
function updatePlotLinkState() {
  const el = document.getElementById('plotLinkState');
  if (!el) return;
  if (!connected) {
    el.textContent = '● NO LINK';
    el.classList.remove('stall', 'on');
    return;
  }
  const stalled = Date.now() - lastDataAt > 3000;
  el.textContent = stalled ? '● NO DATA' : '● LIVE LINK';
  el.classList.toggle('stall', stalled);
  el.classList.toggle('on', !stalled);
  // Only surface the bootloader diagnosis once we've actually lost data — a
  // working device also emits a bootloader hint during its first lines, so on
  // a normal connect this banner must never flash. The modal is offered once.
  const banner = document.getElementById('bootBanner');
  if (banner) banner.classList.toggle('show', stalled && bootloaderHinted);
  if (stalled && bootloaderHinted && !bootFlashShown) {
    bootFlashShown = true;
    openFlashModal();
  }
}
setInterval(updatePlotLinkState, 1000);

async function toggleConnection() {
  const port = (document.getElementById('portSelect') as HTMLSelectElement).value;
  const baud = parseInt((document.getElementById('baudSelect') as HTMLSelectElement).value);
  const mode = (document.getElementById('modeSelect') as HTMLSelectElement).value as 'serial' | 'wifi' | 'ble';

  const connMsg = document.getElementById('connMsg')!;
  const setMsg = (m: string, ok = false) => {
    connMsg.textContent = m;
    connMsg.style.color = ok ? '#9ece6a' : '#f6c177';
  };

  if (connected) {
    if (activeMode === 'wifi') {
      await invoke('disconnect_wifi');
    } else if (activeMode === 'ble') {
      await invoke('disconnect_ble');
    } else {
      await invoke('disconnect_serial');
    }
    connected = false;
    document.getElementById('connectBtn')!.textContent = 'Connect';
    document.getElementById('statusDot')!.className = 'status-dot';
    setPlotLink(false);
    setMsg('');
    return;
  }

  autoChannels = 0;
  bootFlashShown = false;
  updateRigNote();

  if (mode === 'wifi') {
    const addr = (document.getElementById('wifiAddr') as HTMLInputElement).value.trim();
    if (!addr) {
      console.warn('Enter the device address as host:port (e.g. 192.168.4.1:8080)');
      return;
    }
    let host = addr;
    let portN = 8080;
    const colon = addr.lastIndexOf(':');
    if (colon > 0) {
      host = addr.slice(0, colon);
      const maybe = parseInt(addr.slice(colon + 1));
      if (!isNaN(maybe)) portN = maybe;
    }
    try {
      await invoke('connect_wifi', { host, port: portN, nChannels: channelCount });
      activeMode = 'wifi';
      connected = true;
      document.getElementById('connectBtn')!.textContent = 'Disconnect';
      document.getElementById('statusDot')!.className = 'status-dot ok';
      setPlotLink(true);
      document.getElementById('fDevice')!.textContent = addr;
      sampleCount = 0;
      lastDataAt = Date.now();
      bootloaderHinted = false;
      document.getElementById('bootBanner')?.classList.remove('show');
      setMsg('WiFi connected', true);
      saveLastConnection();
    } catch (e) {
      setMsg(String(e).replace(/^Error invoking remote method '.*': /, '').replace(/^Error:\s*/, ''));
      console.error('WiFi connect failed:', e);
    }
    return;
  }
  if (mode === 'ble') {
    const addr = (document.getElementById('bleSelect') as HTMLSelectElement).value;
    if (!addr) {
      setMsg('Scan for devices (↻) first, then select the e-nose to connect.', false);
      console.warn('Scan for devices (↻), then select one to connect.');
      return;
    }
    try {
      await invoke('connect_ble', { address: addr });
      activeMode = 'ble';
      connected = true;
      document.getElementById('connectBtn')!.textContent = 'Disconnect';
      document.getElementById('statusDot')!.className = 'status-dot ok';
      setPlotLink(true);
      document.getElementById('fDevice')!.textContent = addr;
      sampleCount = 0;
      lastDataAt = Date.now();
      bootloaderHinted = false;
      document.getElementById('bootBanner')?.classList.remove('show');
      setMsg('BLE connected', true);
      saveLastConnection();
    } catch (e) {
      setMsg(String(e).replace(/^Error invoking remote method '.*': /, '').replace(/^Error:\s*/, ''));
      console.error('BLE connect failed:', e);
    }
    return;
  }

  if (port) {
    try {
      await invoke('connect_serial', { port, baudRate: baud, nChannels: channelCount });
      activeMode = 'serial';
      connected = true;
      document.getElementById('connectBtn')!.textContent = 'Disconnect';
      document.getElementById('statusDot')!.className = 'status-dot ok';
      setPlotLink(true);
      document.getElementById('fDevice')!.textContent = port;
      sampleCount = 0;
      lastDataAt = Date.now();
      bootloaderHinted = false;
      document.getElementById('bootBanner')?.classList.remove('show');
      setMsg('Serial connected', true);
      saveLastConnection();
    } catch (e) {
      setMsg(String(e).replace(/^Error invoking remote method '.*': /, '').replace(/^Error:\s*/, ''));
      console.error('Connect failed:', e);
    }
  }
}

// === Labeling ===
// === Sensor Health ===
async function updateSensorHealth() {
  try {
    const health = await invoke<Array<{ channel: number; health_score: number; status: string; mean: number }>>('get_sensor_health');
    const el = document.getElementById('sensorHealthList')!;
    if (health.length === 0) {
      el.innerHTML = '<div style="font-size:10px;color:var(--text-3)">No data yet</div>';
      return;
    }
    el.innerHTML = '<div class="health-grid">' + health.map((h, i) => {
      const color = h.status === 'OK' ? 'var(--green)' : h.status === 'WARNING' ? 'var(--yellow)' : 'var(--red)';
      return `<div class="health-cell" title="${h.status} · mean ${h.mean.toFixed(1)}">
        <span class="hd-dot" style="background:${color}"></span>
        <span class="hd-name">${chNames[i % chNames.length] || `CH${i + 1}`}</span>
        <span class="hd-mean">${h.mean.toFixed(0)}</span>
      </div>`;
    }).join('') + '</div>';
  } catch {}
}

// === Quality ===
// One shared 0-100 quality grader, matching the Rust `opensmell` scorer
// thresholds (quality.rs): >=90 Excellent, >=75 Good, >=50 Fair, else Poor.
// The same labels/buckets are used in the Library, Train, and inspector UI so
// a score always means the same thing no matter where you see it.
function qualityBadge(q: number): { label: string; cls: string } {
  const label = q >= 90 ? 'Excellent' : q >= 75 ? 'Good' : q >= 50 ? 'Fair' : 'Poor';
  const cls = q >= 75 ? 'good' : q >= 50 ? 'ok' : 'bad';
  return { label, cls };
}

// === Library ===
function renderLibrary() {
  const body = document.getElementById('libBody')!;
  if (sessions.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="8">No sessions yet — connect a device and record, or use <strong>Import</strong> / <strong>Import Folder</strong> to load recordings. They will appear here.</td></tr>`;
    document.getElementById('libStatus')!.textContent = '0 sessions';
    return;
  }
  const q = ((document.getElementById('libSearch') as HTMLInputElement | null)?.value || '').trim().toLowerCase();
  const rows = sessions
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !q || `${s.substance} ${s.label} ${s.format} ${s.duration} ${s.sensors}`.toLowerCase().includes(q));
  if (rows.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="8">Nothing matches "${q}" — try a different search.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map(({ s, i }) => {
    const analyzed = s.quality_report && typeof s.quality_report.total === 'number';
    let badge = '';
    let statusCell: string;
    if (analyzed) {
      const q = qualityBadge(s.quality);
      const prov = s.quality_report ? '' : '<em class="quality-prov" title="Provisional estimate — click Analyze for the full 7-factor report">prov</em>';
      statusCell = `<span class="quality-badge ${q.cls}">${q.label} ${s.quality}${prov}</span>`;
    } else {
      // Unanalyzed: show a neutral "not scored yet" tag instead of a plausible
      // Excellent score, so unanalyzed data is never mistaken for a great result.
      statusCell = `<button class="lib-analyze" data-idx="${i}" title="Run the full 7-factor quality analysis">⚡ Not analyzed — analyze</button>`;
    }
    const ticked = s.file_id ? compareFiles.includes(s.file_id) : false;
    return `<tr class="${i === selectedSession ? 'selected' : ''}" data-idx="${i}">
      <td><input type="checkbox" class="compare-tick" data-idx="${i}" ${ticked ? 'checked' : ''} title="Overlay in Compare"></td>
      <td>${s.time}</td><td class="lib-sub" data-idx="${i}" title="Double-click to rename the recording + its file">${s.substance}</td><td>${s.label}</td>
      <td>${s.format}</td><td>${s.duration}</td><td>${s.sensors}</td>
      <td>${statusCell}</td>
    </tr>`;
  }).join('');
  document.getElementById('libStatus')!.textContent = `${sessions.length} sessions`;
  const stamp = document.getElementById('libFilterStamp');
  if (stamp) stamp.textContent = `${sessions.length} records · ${sessions.filter(s => s.quality_report).length} analyzed`;
  body.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('.compare-tick')) return;
      if ((ev.target as HTMLElement).closest('.lib-analyze')) {
        const btn = ev.target as HTMLElement;
        analyzeLibrarySession(parseInt(btn.getAttribute('data-idx') || '-1', 10));
        return;
      }
      selectedSession = parseInt(tr.getAttribute('data-idx')!);
      renderLibrary();
      inspectSession(sessions[selectedSession]);
    });
  });
  body.querySelectorAll('.compare-tick').forEach(cb => {
    cb.addEventListener('change', () => {
      const box = cb as HTMLInputElement;
      const idx = parseInt(box.getAttribute('data-idx')!);
      const fid = sessions[idx]?.file_id;
      if (!fid) return;
      if (box.checked) {
        if (!compareFiles.includes(fid)) compareFiles.push(fid);
      } else {
        compareFiles = compareFiles.filter(f => f !== fid);
      }
      renderLibrary();
      updateCompare();
    });
  });
  body.querySelectorAll('.lib-sub').forEach(cell => {
    cell.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      beginRenameCell(cell as HTMLElement);
    });
  });
}

// === Rename a session from the library (file + index, keeps timestamp prefix) ===
async function doRename(idx: number, name: string): Promise<boolean> {
  const s = sessions[idx];
  if (!s || !s.file_id) return false;
  try {
    await invoke('rename_session', { fileId: s.file_id, newName: name });
    s.substance = name;
    s.label = name;
    return true;
  } catch (e) {
    await flashStatus('libStatus', `Rename failed: ${e}`, 'var(--red)');
    return false;
  }
}

function beginRenameCell(td: HTMLElement) {
  const idx = parseInt(td.getAttribute('data-idx')!, 10);
  const s = sessions[idx];
  if (!s) return;
  const cur = s.substance;
  td.innerHTML = `<input class="rename-input" value="${cur.replace(/"/g, '&quot;')}" style="width:100%;background:var(--bg-2);border:1px solid var(--green);color:var(--text-1);border-radius:var(--radius-sm);padding:2px 4px;font-size:11px" />`;
  const input = td.querySelector('input');
  if (!input) return;
  input.focus();
  input.select();
  let cancel = false;
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { cancel = true; input.blur(); }
  });
  input.addEventListener('blur', async () => {
    const val = input.value.trim();
    if (!cancel && val && val !== cur) {
      const ok = await doRename(idx, val);
      if (ok) await flashStatus('libStatus', `Renamed to "${val}"`, 'var(--green)');
    }
    renderLibrary();
    if (idx === selectedSession) inspectSession(sessions[idx]);
  });
}

function inspectSession(s: SessionRecord) {
  const details = `
    <div style="margin-bottom:6px"><strong>${s.substance}</strong></div>
    <div class="kv-row">
      <span class="k">Label</span><span class="v">${s.label || '—'}</span>
      <span class="k">Format</span><span class="v">${s.format}</span>
      <span class="k">Duration</span><span class="v">${s.duration}</span>
      <span class="k">Sensors</span><span class="v">${s.sensors}</span>
      <span class="k">Quality</span><span class="v">${s.quality}/100</span>
    </div>
  `;
  document.getElementById('inspectorDetails')!.innerHTML = details;
  if (s.quality_report) {
    renderQualityReport(s.quality_report);
  }
}

// === Quality Report Panel (Python `quality_panel.py` parity) ===
const SUBSCORES: Array<[string, string, string]> = [
  ['continuity', 'Continuity', '15%'],
  ['dynamicRange', 'Dynamic range', '10%'],
  ['saturationFree', 'Saturation-free', '10%'],
  ['baselineStability', 'Baseline stability', '20%'],
  ['signalStrength', 'Signal strength', '20%'],
  ['recoveryCompleteness', 'Recovery', '15%'],
  ['durationAdequacy', 'Duration', '10%'],
];

function badgeColor(badge: string): string {
  const b = (badge || '').toLowerCase();
  if (b === 'excellent') return 'var(--green)';
  if (b === 'good') return 'var(--cyan)';
  if (b === 'fair') return 'var(--orange)';
  if (b === 'poor') return 'var(--red)';
  return 'var(--text-3)';
}

interface QualitySubScore { value: number | null; reason: string }
interface QualityReport {
  total: number | null;
  badge: string;
  subscores: Record<string, QualitySubScore>;
  flags: { deadSensors?: string[] };
  notes?: string[];
}

function renderQualityReport(q: QualityReport) {
  const total = q.total;
  const badge = q.badge || '—';
  const totalStr = total !== null && total !== undefined ? `${total.toFixed(0)}/100 · ${badge}` : `—/100 · ${badge}`;
  const color = badgeColor(badge);
  const rows = SUBSCORES.map(([key, label, weight]) => {
    const sub = q.subscores?.[key];
    const val = sub?.value;
    const valStr = val !== null && val !== undefined ? `${val.toFixed(1)}/100` : 'N/A';
    const reason = sub?.reason;
    const hint = reason && reason !== 'ok' && reason !== 'None'
      ? `<div style="font-size:9px;color:var(--text-3);margin-top:1px">${reason}</div>` : '';
    return `<div style="margin-bottom:4px">
      <div style="display:flex;align-items:center;gap:6px;font-size:10px;color:var(--text-2)">
        <span style="flex:1">${label}</span>
        <span style="font-size:9px;color:var(--text-3)">${weight}</span>
        <span style="color:var(--text-1);min-width:52px;text-align:right">${valStr}</span>
      </div>
      ${hint}
    </div>`;
  }).join('');

  const dead = q.flags?.deadSensors || [];
  const deadHtml = dead.length
    ? `<div style="font-size:10px;color:var(--text-3);margin-bottom:4px">Dead sensors excluded from scoring: ${dead.join(', ')}</div>` : '';

  const notes = (q.notes || []).map(n => `<div style="font-size:10px;color:var(--text-3)">· ${n}</div>`).join('');

  document.getElementById('inspectorDetails')!.innerHTML += `
    <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:8px">
      <div style="font-size:10px;font-weight:600;color:var(--text-2)">Data quality</div>
      <div style="display:flex;flex-direction:row;justify-content:space-between;margin:4px 0 8px">
        <span style="font-size:14px;font-weight:600;color:var(--text-0)">Data quality</span>
        <span style="font-size:14px;font-weight:700;color:${color}">${totalStr}</span>
      </div>
      ${rows}
      ${deadHtml}
      ${notes ? `<div style="font-size:10px;font-weight:600;color:var(--text-2);margin-top:6px">Notes</div>${notes}` : ''}
    </div>`;
}

// === Compare Panel (Python `viz/compare_panel.py` parity, supersized) ===
const CHART_COLORS = CH_COLORS;
const COMPARE_R0_SAMPLES = 15;

const compareCanvas = document.getElementById('compareCanvas') as HTMLCanvasElement | null;
const compareCtx = compareCanvas?.getContext('2d');

async function loadCompareSeries(fid: string): Promise<SessionSeries | null> {
  if (compareSeriesCache.has(fid)) return compareSeriesCache.get(fid)!;
  try {
    const s = await invoke<SessionSeries>('load_session_series', { fileId: fid });
    compareSeriesCache.set(fid, s);
    return s;
  } catch (e) {
    console.error('Compare load failed:', e);
    compareSeriesCache.set(fid, null);
    return null;
  }
}

// Python `_auto_r0`: mean of the first 15 finite samples, else all finite.
function compareR0(values: number[]): number | null {
  const finite = values.filter(v => Number.isFinite(v));
  if (finite.length === 0) return null;
  const base = finite.slice(0, COMPARE_R0_SAMPLES);
  const r0 = base.reduce((a, b) => a + b, 0) / base.length;
  return r0 !== 0 ? r0 : null;
}

function cmpNorm(s: SessionSeries, ci: number): number[] | null {
  const r0 = compareR0(s.values[ci]);
  if (r0 === null || r0 <= 0) return null;
  return s.values[ci].map(v => (v - r0) / r0);
}

function meanOf(v: number[]): number {
  const f = v.filter(Number.isFinite);
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : NaN;
}
function meanAbs(v: number[]): number {
  const f = v.filter(Number.isFinite);
  return f.length ? Math.abs(f.reduce((a, b) => a + b, 0)) / f.length : NaN;
}

interface CompareMetrics {
  peak: number;
  peakDir: 1 | -1;
  t90: number;
  auc: number;
  baseCv: number;
  recover: number;
  sampleCount: number;
}

function compareMetricsFor(s: SessionSeries, name: string): CompareMetrics | null {
  const ci = s.channels.indexOf(name);
  if (ci < 0) return null;
  const norm = cmpNorm(s, ci);
  if (!norm) return null;
  const time = s.time.slice(0, norm.length);
  const finite = norm.filter(Number.isFinite);
  if (finite.length < 10) return null;
  const peakPos = finite.reduce((a, v) => Math.max(a, v), -Infinity);
  const peakNeg = finite.reduce((a, v) => Math.min(a, v), Infinity);
  const peak = Math.max(Math.abs(peakPos), Math.abs(peakNeg));
  const peakDir: 1 | -1 = peakPos >= Math.abs(peakNeg) ? 1 : -1;
  let t90 = NaN;
  if (peak > 0) {
    const target = 0.9 * peak;
    for (let i = 0; i < norm.length; i++) {
      if (Math.abs(norm[i]) >= target) { t90 = time[i] - time[0]; break; }
    }
  }
  let auc = 0;
  for (let i = 1; i < norm.length; i++) {
    const dt = time[i] - time[i - 1];
    if (!Number.isFinite(dt) || dt <= 0) continue;
    const a = Math.max(0, norm[i - 1]), b = Math.max(0, norm[i]);
    auc += 0.5 * (a + b) * dt;
  }
  const base = s.values[ci].slice(0, COMPARE_R0_SAMPLES).filter(Number.isFinite);
  const bm = meanOf(base);
  const bsd = Math.sqrt(base.reduce((a, v) => a + (v - bm) ** 2, 0) / Math.max(1, base.length));
  const baseCv = bm !== 0 && bm !== 0 ? (bsd / bm) * 100 : 0;
  const lastWin = meanAbs(norm.slice(-15));
  const recover = peak > 0 ? Math.max(0, Math.min(1, 1 - lastWin / peak)) : 1;
  return { peak, peakDir, t90, auc, baseCv, recover, sampleCount: finite.length };
}

function pearson(x: number[], y: number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 8) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx, b = y[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

// Chemoprint similarity: Pearson over the shared overlap of the active channels,
// each channel normalized to its own R0, channels concatenated. When two rigs
// label channels differently (custom names), named overlap can be empty — fall
// back to positional overlap across the shared channel count so the fingerprint
// still adapts to any rig. Returns the correlation plus an honest overlap basis.
function cmpCorrelation(a: SessionSeries, b: SessionSeries): { corr: number | null; basis: 'name' | 'position'; nChannels: number } | null {
  let X: number[] = [], Y: number[] = [], nChannels = 0;
  // 1) Named overlap first.
  for (const name of activeCompareChannels) {
    const ia = a.channels.indexOf(name), ib = b.channels.indexOf(name);
    if (ia < 0 || ib < 0) continue;
    const na = cmpNorm(a, ia), nb = cmpNorm(b, ib);
    if (!na || !nb) continue;
    nChannels++;
    const n = Math.min(na.length, nb.length);
    for (let i = 0; i < n; i++) {
      const x = na[i], y = nb[i];
      if (Number.isFinite(x) && Number.isFinite(y)) { X.push(x); Y.push(y); }
    }
  }
  let basis: 'name' | 'position' = 'name';
  // 2) If named pairing produced no usable samples, fall back to positional.
  if (X.length < 8) {
    X = []; Y = []; nChannels = 0;
    const nCh = Math.min(a.channels.length, b.channels.length);
    for (let c = 0; c < nCh; c++) {
      const na = cmpNorm(a, c), nb = cmpNorm(b, c);
      if (!na || !nb) continue;
      nChannels++;
      const n = Math.min(na.length, nb.length);
      for (let i = 0; i < n; i++) {
        const x = na[i], y = nb[i];
        if (Number.isFinite(x) && Number.isFinite(y)) { X.push(x); Y.push(y); }
      }
    }
    if (X.length >= 8) basis = 'position';
  }
  const corr = X.length >= 8 ? pearson(X, Y) : null;
  return { corr, basis, nChannels };
}

function truncateLabel(s: string, max = 16): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function renderCompareLabels() {
  const el = document.getElementById('compareLabels')!;
  const delta = compareMode === 'delta';
  const parts = compareLoaded.map((r, i) => {
    const name = r ? r.label : '(unreadable)';
    const refTag = delta && i === compareRefIdx ? ' <i style="color:var(--yellow)">(ref)</i>' : '';
    return `<b style="color:${CHART_COLORS[i % CHART_COLORS.length]};">${i + 1}. </b>${name}${refTag}`;
  }).join(' · ');
  el.innerHTML = parts || '<span style="color:var(--text-3)">Tick sessions in the Library to compare.</span>';
}

function renderCompareChips() {
  const el = document.getElementById('compareChs')!;
  const all: string[] = [];
  for (const s of compareLoaded) { if (s) for (const c of s.channels) if (!all.includes(c)) all.push(c); }
  if (all.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = all.map(c =>
    `<button class="cmp-chip ${activeCompareChannels.includes(c) ? 'on' : 'off'}" data-ch="${c}">${c}</button>`
  ).join('');
  el.querySelectorAll<HTMLElement>('.cmp-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const c = btn.dataset.ch!;
      if (activeCompareChannels.includes(c)) {
        if (activeCompareChannels.length > 1) activeCompareChannels = activeCompareChannels.filter(x => x !== c);
      } else {
        activeCompareChannels.push(c);
      }
      renderCompareChips();
      renderCompareRef();
      renderCompareMetrics();
      drawCompare();
    });
  });
}

function renderCompareRef() {
  const el = document.getElementById('compareRef') as HTMLSelectElement | null;
  if (!el) return;
  const items = compareLoaded.filter(Boolean) as SessionSeries[];
  if (items.length < 2 || compareMode !== 'delta') {
    el.style.display = 'none';
    document.getElementById('cmpRefLabel')!.style.display = 'none';
    return;
  }
  el.style.display = '';
  document.getElementById('cmpRefLabel')!.style.display = '';
  const prev = items[compareRefIdx]?.label;
  el.innerHTML = items.map((s, i) => `<option value="${i}" ${s.label === prev ? 'selected' : ''}>${truncateLabel(s.label, 20)}</option>`).join('');
  compareRefIdx = Math.min(compareRefIdx, items.length - 1);
  el.value = String(compareRefIdx);
}

function renderCompareMetrics() {
  const el = document.getElementById('compareMetrics')!;
  const stamp = document.getElementById('cmpMetricStamp')!;
  const items = compareLoaded.filter(Boolean) as SessionSeries[];
  if (items.length === 0) {
    el.innerHTML = '<div style="font-size:10px;color:var(--text-3);padding:6px 0">No sessions selected.</div>';
    stamp.textContent = '—';
    return;
  }
  const perSession = items.map((s, si) => {
    const m: Record<string, number> = {};
    for (const name of activeCompareChannels) {
      const mem = compareMetricsFor(s, name);
      if (mem) m[name] = 0; // placeholder; real aggregation below
    }
    const peaks: number[] = [], t90s: number[] = [], aucs: number[] = [], cvs: number[] = [], recs: number[] = [];
    for (const name of activeCompareChannels) {
      const mem = compareMetricsFor(s, name);
      if (!mem) continue;
      peaks.push(mem.peak);
      if (!isNaN(mem.t90)) t90s.push(mem.t90);
      aucs.push(mem.auc);
      cvs.push(mem.baseCv);
      recs.push(mem.recover);
    }
    return { si, s, peaks, t90s, aucs, cvs, recs, peak: peaks.length ? Math.max(...peaks) : NaN };
  }).filter(x => x.peaks.length);
  if (perSession.length === 0) {
    el.innerHTML = '<div style="font-size:10px;color:var(--text-3);padding:6px 0">No overlapping channel data.</div>';
    stamp.textContent = '—';
    return;
  }
  const bestPeak = Math.max(...perSession.map(x => x.peak));
  const bestAuc = Math.max(...perSession.map(x => x.aucs.reduce((a, b) => a + b, 0)));
  const bestCv = Math.min(...perSession.map(x => (x.cvs.length ? Math.max(...x.cvs) : Infinity)));
  const bestRec = Math.max(...perSession.map(x => (x.recs.length ? Math.min(...x.recs) : 0)));
  const rows = perSession.map(p => {
    const t90v = p.t90s.length ? Math.max(...p.t90s) : NaN;
    const auc = p.aucs.reduce((a, b) => a + b, 0);
    const baseCv = p.cvs.length ? Math.max(...p.cvs) : NaN;
    const recover = p.recs.length ? Math.min(...p.recs) : 0;
    return `<tr data-si="${p.si}" ${'class="' + (p.peak === bestPeak ? 'cmp-best' : '') + '"'} 
      <td title="${p.s.label}">${truncateLabel(p.s.label, 22)}</td>
      <td>${p.peak.toFixed(3)}</td>
      <td>${isNaN(t90v) ? '—' : t90v.toFixed(1)}</td>
      <td>${auc.toFixed(2)}</td>
      <td class=${isNaN(baseCv) ? '' : baseCv <= 2 ? 'cmp-recover-hi' : baseCv >= 10 ? 'cmp-recover-lo' : ''}>${isNaN(baseCv) ? '—' : baseCv.toFixed(1)}%</td>
      <td>${Math.round(recover * 100)}%</td>
    </tr>`;
  }).join('');
  el.innerHTML = `<table class="cmp-metrics-table">
    <thead><tr><th>Session</th><th>Peak ΔR/R0</th><th>T90 s</th><th>AUC</th><th>Base CV</th><th>Recover</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  stamp.textContent = `${perSession.length} sessions · ${activeCompareChannels.length} ch`;
}

function drawCompare() {
  const ctx = compareCtx;
  const canvas = compareCanvas;
  if (!ctx || !canvas) return;
  if (compareMode === 'heatmap') { drawCompareHeatmap(); return; }
  drawComparePanels();
}

function drawComparePanels() {
  const ctx = compareCtx;
  const canvas = compareCanvas;
  if (!ctx || !canvas) return;
  const wrap = document.getElementById('compareWrap')!;
  const rect = wrap.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width - 2));
  canvas.height = Math.max(1, Math.floor(rect.height - 2));
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const showEmpty = (msg: string) => {
    ctx.fillStyle = '#666';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(msg, w / 2, h / 2);
  };
  const delta = compareMode === 'delta';
  const ref = delta ? (compareLoaded[compareRefIdx] ?? null) : null;

  const lanes: { name: string; curves: { x: number[]; y: number[]; s: number }[] }[] = [];
  let x0 = Infinity, x1 = -Infinity;
  for (const name of activeCompareChannels) {
    const curves: { x: number[]; y: number[]; s: number }[] = [];
    compareLoaded.forEach((s, si) => {
      if (!s) return;
      const ci = s.channels.indexOf(name);
      if (ci < 0) return;
      const norm = cmpNorm(s, ci);
      if (!norm) return;
      const refCi = ref ? ref.channels.indexOf(name) : -1;
      const refNorm = ref && refCi >= 0 ? cmpNorm(ref, refCi) : null;
      let n = norm.length;
      if (delta && refNorm) n = Math.min(n, refNorm.length);
      if (n < 2) return;
      const x = s.time.slice(0, n);
      let y: number[];
      if (delta && refNorm) {
        y = new Array(n);
        for (let i = 0; i < n; i++) {
          const dv = norm[i] - refNorm[i];
          y[i] = Number.isFinite(dv) ? dv : NaN;
        }
      } else {
        y = norm.slice(0, n);
      }
      x0 = Math.min(x0, x[0]);
      x1 = Math.max(x1, x[n - 1]);
      curves.push({ x, y, s: si });
    });
    if (curves.length) lanes.push({ name, curves });
  }

  if (lanes.length === 0) {
    showEmpty(compareFiles.length === 0
      ? 'No sessions selected. Tick sessions in the Library to compare them here.'
      : 'No overlapping channels in the selected sessions.');
    return;
  }

  const padL = 66, padR = 12, padT = 6, padB = 26, gap = 8;
  const rows = lanes.length;
  const laneH = (h - padT - padB - gap * (rows - 1)) / rows;
  if (x0 === x1) { x0 -= 0.5; x1 += 0.5; }
  const sx = (v: number) => padL + (v - x0) / (x1 - x0) * (w - padL - padR);

  lanes.forEach((lane, r) => {
    const top = padT + r * (laneH + gap);
    const yMin = Math.min(...lane.curves.map(c => c.y.filter(Number.isFinite).reduce((a, v) => Math.min(a, v), Infinity)));
    const yMax = Math.max(...lane.curves.map(c => c.y.filter(Number.isFinite).reduce((a, v) => Math.max(a, v), -Infinity)));
    const yLo = Number.isFinite(yMin) ? yMin : -1;
    const yHi = Number.isFinite(yMax) ? yMax : 1;
    let yA = yLo, yB = yHi;
    if (yB - yA < 1e-9) { yA -= 0.5; yB += 0.5; }
    const sy = (v: number) => top + laneH - (v - yA) / (yB - yA) * laneH;

    // Lane frame + grid
    ctx.strokeStyle = 'rgba(8,8,12,0.06)';
    ctx.lineWidth = 1;
    for (let g = 0; g <= 2; g++) {
      const gy = top + (laneH / 2) * g;
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
    }
    ctx.strokeStyle = '#333';
    ctx.strokeRect(padL, top, w - padL - padR, laneH);
    // Channel label
    ctx.fillStyle = '#9aa0a6';
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(lane.name, padL - 6 - ctx.measureText(lane.name).width, top + laneH / 2);
    // Y axis labels
    ctx.textAlign = 'right';
    ctx.fillStyle = '#666';
    ctx.font = '8px -apple-system, sans-serif';
    ctx.fillText(yB.toFixed(2), padL - 6, top + 2);
    ctx.fillText(yA.toFixed(2), padL - 6, top + laneH - 2);
    // Zero line (overlay: baseline; delta: reference)
    ctx.strokeStyle = delta ? 'rgba(246,193,119,0.6)' : 'rgba(8,8,12,0.25)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    const zy = delta ? sy(0) : top + laneH - sy(0) + top; // delta zero is sy(0)
    if (delta) {
      ctx.moveTo(padL, zy); ctx.lineTo(w - padR, zy); ctx.stroke();
    }
    ctx.setLineDash([]);

    lane.curves.forEach((c) => {
      ctx.strokeStyle = CHART_COLORS[c.s % CHART_COLORS.length];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (let k = 0; k < c.x.length; k++) {
        const X = sx(c.x[k]);
        const Yv = c.y[k];
        if (!Number.isFinite(Yv)) { started = false; continue; }
        const Y = sy(Yv);
        if (!started) { ctx.moveTo(X, Y); started = true; } else ctx.lineTo(X, Y);
      }
      ctx.stroke();
    });
  });

  // X axis
  ctx.fillStyle = '#666';
  ctx.font = '9px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let g = 0; g <= 5; g++) {
    const val = x0 + (x1 - x0) * (g / 5);
    ctx.fillText(val >= 100 || val <= -100 ? val.toFixed(0) : val.toFixed(1),
      sx(val), padT + rows * laneH + gap * (rows - 1) + 4);
  }
  ctx.fillText(delta ? 'relative time (s) · Δ vs reference' : 'relative time (s)', padL + (w - padL - padR) / 2, h - 10);
}

function drawCompareHeatmap() {
  const ctx = compareCtx;
  const canvas = compareCanvas;
  if (!ctx || !canvas) return;
  const wrap = document.getElementById('compareWrap')!;
  const rect = wrap.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width - 2));
  canvas.height = Math.max(1, Math.floor(rect.height - 2));
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.setLineDash([]);

  const items = compareLoaded.filter(Boolean) as SessionSeries[];
  if (items.length === 0) {
    ctx.fillStyle = '#666';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Tick sessions in the Library to see their similarity.', w / 2, h / 2);
    return;
  }
  const n = items.length;
  const padL = 74, padT = 6, padR = 10;
  const cell = Math.min((w - padL - padR) / n, (h - padT - 20) / n);
  const cw = cell * n;
  let anyPositionBasis = false;

  const heat = (v: number) => {
    const t = Math.max(-1, Math.min(1, v));
    if (t >= 0) {
      const k = t; // 0->gray-green, 1->green
      return `rgba(${Math.round(70 + 130 * (1 - k))}, ${Math.round(200 - 40 * (1 - k))}, ${Math.round(120 + 90 * (1 - k))}, ${0.35 + 0.6 * k})`;
    }
    const k = -t;
    return `rgba(${Math.round(190 + 60 * (1 - k))}, ${Math.round(90 + 100 * (1 - k))}, ${Math.round(90 + 60 * (1 - k))}, ${0.35 + 0.6 * k})`;
  };

  ctx.font = '9px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = CHART_COLORS[i % CHART_COLORS.length];
    ctx.fillText(`${i + 1}. ${truncateLabel(items[i].label, 12)}`, padL - 4, padT + i * cell + cell / 2);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let j = 0; j < n; j++) {
    ctx.fillStyle = CHART_COLORS[j % CHART_COLORS.length];
    ctx.fillText(`${j + 1}`, padL + j * cell + cell / 2, padT + n * cell + 2);
  }

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = padL + j * cell, y = padT + i * cell;
      const r = i === j ? { corr: 1 as number | null, basis: 'name' as const, nChannels: 0 } : cmpCorrelation(items[i], items[j]);
      const corr = r ? r.corr : null;
      ctx.fillStyle = corr === null ? 'rgba(30,30,30,0.4)' : heat(corr);
      ctx.fillRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
      if (cell >= 26) {
        ctx.fillStyle = corr !== null && Math.abs(corr) > 0.5 ? '#0b0f12' : (corr === null ? 'var(--text-3)' : '#e6e6e6');
        ctx.font = cell >= 40 ? '10px -apple-system, sans-serif' : '8px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(corr === null ? '·' : corr.toFixed(2), x + cell / 2, y + cell / 2 + 1);
      }
      if (r && r.basis === 'position') anyPositionBasis = true;
    }
  }
  if (anyPositionBasis) {
    ctx.fillStyle = 'var(--text-3)';
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('— matched by channel position (rigs label channels differently)', 2, h - 2);
  }
}

async function updateCompare() {
  const countEl = document.getElementById('compareCount')!;
  if (compareFiles.length === 0) {
    compareLoaded = [];
    countEl.textContent = '';
    document.getElementById('compareLabels')!.innerHTML = '';
    document.getElementById('compareChs')!.innerHTML = '';
    activeCompareChannels = [];
    compareRefIdx = 0;
    renderCompareRef();
    renderCompareMetrics();
    drawCompare();
    return;
  }
  compareLoaded = await Promise.all(compareFiles.map(id => loadCompareSeries(id)));
  countEl.textContent = `${compareLoaded.filter(Boolean).length} session(s)`;
  // Default channel selection: everything the first readable session provides.
  const first = compareLoaded.find(Boolean);
  const channels = first ? first.channels : [];
  if (activeCompareChannels.length === 0 && channels.length) {
    activeCompareChannels = channels.slice();
  }
  if (compareRefIdx >= compareLoaded.length) compareRefIdx = 0;
  renderCompareChips();
  renderCompareRef();
  renderCompareLabels();
  renderCompareMetrics();
  drawCompare();
}

// === Fleet ===
function renderFleet() {
  const grid = document.getElementById('fleetGrid')!;
  const summary = document.getElementById('fleetSummary')!;
  const recognized = fleetDevices.filter(d => d.is_recognized).length;
  const online = fleetDevices.filter(d => d.status === 'online').length;
  summary.textContent = `${fleetDevices.length} device(s) · ${recognized} recognized · ${online} online`;
  if (fleetDevices.length === 0) {
    grid.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-3);font-size:12px">No devices found.<br/>Plug in a USB e-nose, or click "Scan Network" to search USB + mDNS.</div>';
    document.getElementById('fleetBadge')!.style.display = 'none';
    return;
  }
  // Sort: recognized + online first, then the rest on the wire, then other.
  const sorted = [...fleetDevices].sort((a, b) =>
    (b.is_recognized ? 1 : 0) - (a.is_recognized ? 1 : 0) ||
    (b.status === 'online' ? 1 : 0) - (a.status === 'online' ? 1 : 0));
  document.getElementById('fleetBadge')!.style.display = '';
  document.getElementById('fleetBadge')!.textContent = fleetDevices.length.toString();
  grid.innerHTML = sorted.map(d => {
    const statusClass = d.status;
    const sensorsHtml = d.sensors.map(s =>
      `<div class="sensor-slot${s.name === 'Empty' ? ' empty' : ''}">
        <div class="s-name">${s.name}</div>
        <div class="s-val" style="color:${s.health === 'OK' ? 'var(--green)' : s.health === 'WARNING' ? 'var(--yellow)' : 'var(--red)'}">${s.value > 0 ? s.value.toFixed(0) + ' Ω' : '--'}</div>
      </div>`
    ).join('');
    const kindLabel = d.kind === 'osmograph-e-nose' ? 'E-NOSE' : d.kind
      ? d.kind.replace(/_/g, ' ').toUpperCase() : 'UNKNOWN';
    const recognizedTxt = d.is_recognized;
    const badgeHtml = `<span class="fleet-kind ${recognizedTxt ? 'recognized' : 'unknown'}">${recognizedTxt ? '●' : '○'} ${kindLabel}</span>`;
    return `<div class="device-card">
      <div class="dev-header">
        <div class="dev-name">${d.name}</div>
        <span class="dev-status ${statusClass}">${d.status}</span>
      </div>
      <div class="dev-meta">${badgeHtml}</div>
      <div style="font-size:10px;color:var(--text-3)">${d.port || '—'} · CH${d.n_channels} · FW ${d.firmware_version || '—'}</div>
      <div class="sensor-grid">${sensorsHtml}</div>
    </div>`;
  }).join('');
}

// === OLED Preview ===
function updateOledPreview() {
  const layout = (document.getElementById('oledLayout') as HTMLSelectElement).value;
  const preview = document.getElementById('oledPreview')!;
  const last = traceData.map(ch => ch[ch.length - 1] || 0);
  const previewLines = chNames.slice(0, 6).map((name, i) =>
    `CH${i + 1}: ${name.padEnd(8)} ${(last[i] || 0).toFixed(0).padStart(5)} Ω`
  ).join('\n');

  if (layout === 'overview') {
    preview.textContent = `OSMOGRAPH v0.1.0\n${'─'.repeat(18)}\n${previewLines}\n\nStatus: NORMAL`;
  } else if (layout === 'alert') {
    preview.textContent = `⚠ ANOMALY DETECTED ⚠\n${'─'.repeat(18)}\nMahal: 4.23\nConfidence: 97%\n\nChannels: 3/6`;
  } else if (layout === 'minimal') {
    preview.textContent = `●  NORMAL\n  1523 Ω`;
  } else {
    preview.textContent = `OSMOGRAPH v0.1.0\n${'─'.repeat(18)}\n${previewLines}`;
  }
}

// === Buzzer Pattern Preview ===
function drawBuzzerPattern(containerId: string, pattern: string) {
  const el = document.getElementById(containerId)!;
  const bars = 24;
  let heights: number[] = [];
  if (pattern === 'off') {
    heights = Array(bars).fill(2);
  } else if (pattern === 'beep') {
    heights = Array(bars).fill(2);
    for (let i = 8; i < 12; i++) heights[i] = 20 + Math.random() * 15;
  } else if (pattern === 'double') {
    heights = Array(bars).fill(2);
    for (let i = 4; i < 7; i++) heights[i] = 20 + Math.random() * 15;
    for (let i = 10; i < 13; i++) heights[i] = 20 + Math.random() * 15;
  } else if (pattern === 'triple') {
    heights = Array(bars).fill(2);
    for (let i = 3; i < 5; i++) heights[i] = 18;
    for (let i = 8; i < 10; i++) heights[i] = 22;
    for (let i = 13; i < 15; i++) heights[i] = 28;
  } else if (pattern === 'continuous') {
    heights = Array(bars).fill(0).map((_, i) => 10 + Math.sin(i * 0.5) * 10 + Math.random() * 8);
  } else if (pattern === 'sos') {
    heights = Array(bars).fill(2);
    [3, 4, 5, 10, 11, 12, 18, 19, 20].forEach(i => { heights[i] = 12; });
    [6, 7, 8, 14, 15, 16].forEach(i => { heights[i] = 30; });
  } else if (pattern === 'rapid') {
    heights = Array(bars).fill(0).map((_, i) => i % 2 === 0 ? 30 : 2);
  }
  el.innerHTML = heights.map(h =>
    `<div class="buzzer-bar${h <= 2 ? ' off' : ''}" style="height:${h}px"></div>`
  ).join('');
}

function updateBuzzerPreviews() {
  drawBuzzerPattern('buzPrevWarn', (document.getElementById('buzzerWarn') as HTMLSelectElement).value);
  drawBuzzerPattern('buzPrevCrit', (document.getElementById('buzzerCrit') as HTMLSelectElement).value);
  drawBuzzerPattern('buzPrevEmerg', (document.getElementById('buzzerEmerg') as HTMLSelectElement).value);
}

// === Dynamic channel count (auto-detected from the connected device) ===
// The device's stream decides how many channels are plotted — parity with the
// Python app: firmware announces INFO,id,fw,n_channels and any Arduino (or
// third-party board) that dumps N numeric CSV columns is detected from its own
// stream width. There is no manual selector: the app just adapts to the device.
function setChannelCount(n: number, names?: string[]) {
  // n === 0 means "auto-detect": wait for the connected device to announce its
  // channel count (see applyDetectedChannels) instead of forcing one.
  if (n <= 0) {
    if (channelCount === 0 && chNames.length === 0 && !names) return;
    channelCount = 0;
    chNames = names && names.length ? names : [];
    autoChannels = 0;
    channelKinds = [];
    traceData = [];
    historyData = [];
    buildLegend();
    const sc = document.getElementById('sysChannels') as HTMLInputElement | null;
    if (sc && sc.value !== '0') sc.value = '0';
    const pc = document.getElementById('plotChCount');
    if (pc) pc.textContent = 'auto';
    updateRigNote();
    updateRailCoord();
    refreshCalibrationViews();
    return;
  }
  const next = Math.max(1, Math.min(64, Math.floor(n) || 1));
  if (next === channelCount && !names) return;
  channelCount = next;
  channelKinds = [];
  if (names && names.length === next) {
    chNames = names;
  } else {
    chNames = Array.from({ length: next }, (_, i) => PRESETS[activePreset]?.sensors[i] || `CH${i + 1}`);
  }
  traceData = chNames.map(() => []);
  historyData = chNames.map(() => []);
  buildLegend();
  const sc = document.getElementById('sysChannels') as HTMLInputElement | null;
  if (sc && sc.value !== String(next)) sc.value = String(next);
  const pc = document.getElementById('plotChCount');
  if (pc) pc.textContent = String(next);
  updateRigNote();
  updateRailCoord();
  refreshCalibrationViews();
}

// Apply a channel count learned from the live device (Rust `serial-auto` /
// `serial-info` events). Ignore resizes back to the default until a device is
// actually present so the pre-connect state stays tidy.
function applyDetectedChannels(n: number, source?: string) {
  const count = Math.floor(n);
  if (!count || count < 1) return;
  const wasConnected = connected;
  autoChannels = count;
  if (wasConnected) setChannelCount(count);
  else channelCount = count;
  // If the user has custom channel names for this count, apply them now.
  applyCustomNames();
  updateRigNote();
  const cm = document.getElementById('connMsg');
  if (cm && wasConnected) {
    cm.textContent = `${count}-channel device detected (auto)`;
    cm.style.color = 'var(--text-3)';
  }
  console.log(`[osmograph] auto-detected ${count} channels (${source || 'stream'})`);
}

function defaultRigNote(): string {
  return 'Connect a device — its channels are auto-detected from the stream.';
}

function updateRigNote() {
  const note = document.getElementById('rigNote');
  if (!note) return;
  if (autoChannels > 0) {
    note.textContent = `Auto-detected: ${autoChannels} channel${autoChannels === 1 ? '' : 's'} from the device — plot adapted.`;
    note.classList.add('ok');
  } else {
    note.textContent = defaultRigNote();
    note.classList.remove('ok');
  }
}

function updateRailCoord() {
  const el = document.getElementById('railCoord');
  if (el) el.textContent = `${channelCount} CH · ${activePreset}`;
  refreshRigBlueprint();
}

// === Rig Blueprint (Firmware schematic + pre-flight) ===
// The schematic is data-derived so the drawing always shows the *actual* rig:
// active preset → channel count → auto-assigned ADC pins, plus the peripheral
// state from its own panels. Cyan is never used here — the schematic is
// hardware/ink; live monitoring data is the only cyan in the app.
const BOOT_CRITICAL_GPIO: number[] = [0, 2, 12];
const I2C_SDA = 21, I2C_SCL = 22;
const I2C_PINS = [I2C_SDA, I2C_SCL];
const OLED_I2C_ADDR = 0x3C;          // SSD1306 default (0x3C; some boards are 0x3D)
const BUZZER_GPIO = 16;

// A fitted I²C device: everything that will live on the SDA/SCL bus. The OLED
// is implicit once enabled; MEMS/env breakouts (BME, SGP, CCS, …) are declared
// in the rig profile. The pre-flight uses this list to catch two devices on one
// address — a real wiring failure that mutes the whole bus.
type I2cDevice = { device: string; address: number };

// Parse a 7-bit I²C address from JSON (accepts 0x3C / 60 / "0x3C"). Impossible
// values are rejected honestly rather than silently rounded into the bus range.
function parseI2cAddress(v: unknown): number | null {
  let n: number | null = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = parseInt(v.trim(), /^0x/i.test(v) ? 16 : 10);
  if (n === null || !Number.isInteger(n) || n < 0 || n > 0x7F) return null;
  return n;
}
function fmtI2c(addr: number): string {
  return `0x${addr.toString(16).toUpperCase().padStart(2, '0')}`;
}

function themeCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function rigPeriphPins(): number[] {
  const pins: number[] = [];
  if (peripheralState.oledEnabled) pins.push(...I2C_PINS);
  if (peripheralState.buzzerEnabled) pins.push(BUZZER_GPIO);
  return pins;
}

// The fitted I²C bus inventory (OLED + profile-declared breakouts), de-duplicated
// on (device, address) so double-listing a device can't false-positive the clash.
function rigI2cFit(): I2cDevice[] {
  const fit: I2cDevice[] = [];
  if (peripheralState.oledEnabled) fit.push({ device: 'OLED SSD1306', address: OLED_I2C_ADDR });
  for (const d of hardwareProfile.i2cDevices ?? []) {
    if (d && parseI2cAddress(d.address) !== null) fit.push(d);
  }
  const seen = new Set<string>();
  const out: I2cDevice[] = [];
  for (const d of fit) {
    const key = `${d.address}|${d.device}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

function rigChannelCount(): number {
  if (autoChannels > 0) return autoChannels;
  return channelCount > 0 ? channelCount : 0;
}

function setFlight(id: string, label: string, cls: 'ok' | 'warn' | 'bad') {
  const el = document.getElementById(id);
  if (!el) return;
  const wasBad = el.classList.contains('bad');
  el.textContent = '◆ ' + label;
  el.className = 'flight ' + cls;
  // First time a flight turns red, tick the LED once so a *new* safety issue
  // draws the eye; it then settles into the steady red state.
  if (cls === 'bad' && !wasBad) {
    el.classList.add('flash-bad');
    el.addEventListener('animationend', () => el.classList.remove('flash-bad'), { once: true });
  }
}

function updatePreflight() {
  const sensorP = presetPins(rigChannelCount() || 6);
  const periphP = rigPeriphPins();
  const clash = sensorP.some(p => periphP.includes(p));
  const boot = [...sensorP, ...periphP].filter(p => BOOT_CRITICAL_GPIO.includes(p));
  setFlight('pfPins', clash ? 'PIN CLASH' : 'PINS SAFE', clash ? 'bad' : 'ok');
  setFlight('pfBoot', boot.length ? `BOOT PIN ${boot.join('/')}` : 'NO BOOT PINS', boot.length ? 'bad' : 'ok');

  // I²C bus: every fitted device shares SDA/SCL — two devices on one address
  // means a dead bus, so that's flagged as hard as a pin clash (not a warning).
  const i2c = rigI2cFit();
  const addrCounts = new Map<number, number>();
  for (const d of i2c) addrCounts.set(d.address, (addrCounts.get(d.address) || 0) + 1);
  const duplicated: string[] = [];
  addrCounts.forEach((count, addr) => { if (count > 1) duplicated.push(`${fmtI2c(addr)}×${count}`); });
  const i2cEl = document.getElementById('pfI2C');
  if (duplicated.length) {
    setFlight('pfI2C', `I²C CLASH ${duplicated.join(' ')}`, 'bad');
    if (i2cEl) i2cEl.title = 'Two fitted devices share one I²C address — the bus will hang. Fix the strap/address pins before flashing.';
  } else if (i2c.length) {
    setFlight('pfI2C', `I²C SAFE · ${i2c.map(d => fmtI2c(d.address)).sort().join('/')}`, 'ok');
    if (i2cEl) i2cEl.title = `Fitted on SDA ${I2C_SDA} / SCL ${I2C_SCL}: ${i2c.map(d => `${d.device}@${fmtI2c(d.address)}`).sort().join(' · ')}`;
  } else if (i2cEl) {
    i2cEl.textContent = '◆ I²C — NONE FITTED';
    i2cEl.className = 'flight';
    i2cEl.title = 'Declare fitted I²C breakouts (MEMS/env) in Rig Setup → Advanced JSON to get the bus-clash check.';
  }

  // Wiring nodes breathe only while the whole pre-flight is clean; on any clash
  // the schematic goes still — an un-energized board. Motion is a state signal.
  const svg = document.getElementById('rigSchematic');
  if (svg) svg.classList.toggle('energized', !clash && boot.length === 0 && duplicated.length === 0);
}

function renderRigSchematic() {
  const svg = document.getElementById('rigSchematic');
  const stamp = document.getElementById('schStamp');
  if (!svg) return;
  const ink = themeCssVar('--text-1') || '#201f1c';
  const dim = themeCssVar('--text-3') || '#9a9484';
  const faint = themeCssVar('--border') || '#d7cdba';
  const fillA = themeCssVar('--bg-2') || '#efe8dc';
  const fillB = themeCssVar('--bg-1') || '#f6f1e7';
  const n = rigChannelCount();
  const auto = n === 0;
  const pins = presetPins(auto ? 6 : n);
  const names = chNames.length === n
    ? chNames
    : Array.from({ length: n }, (_, i) => PRESETS[activePreset]?.sensors[i] || `CH${i + 1}`);
  const oledOn = peripheralState.oledEnabled;
  const bzOn = peripheralState.buzzerEnabled;
  const short = (s: string) => (s.length > 6 ? s.slice(0, 6) : s);

  let rows = '';
  if (auto) {
    rows = `<text x="${456}" y="62" text-anchor="middle" font-family="var(--font-mono)" font-size="9" fill="${dim}">AUTO-CHECK</text>
      <text x="${456}" y="76" text-anchor="middle" font-family="var(--font-mono)" font-size="9" fill="${dim}">detect on connect</text>`;
  } else {
    rows = names.slice(0, 8).map((nm, i) => {
      const y = 34 + i * 11;
      return `<text x="${410}" y="${y}" font-family="var(--font-mono)" font-size="8" fill="${ink}">CH${i + 1}</text>
        <text x="${444}" y="${y}" font-family="var(--font-mono)" font-size="8" fill="${ink}">${short(nm)}</text>
        <text x="${530}" y="${y}" text-anchor="end" font-family="var(--font-mono)" font-size="8" fill="${dim}">GPIO${pins[i]}</text>`;
    }).join('');
    if (n > 8) rows += `<text x="${456}" y="${34 + 8 * 11}" text-anchor="middle" font-family="var(--font-mono)" font-size="8" fill="${dim}">+${n - 8} MORE …</text>`;
  }

  const periphTxt = oledOn
    ? `<text x="${218}" y="${106}" text-anchor="middle" font-family="var(--font-mono)" font-size="9" fill="${ink}">OLED · SSD1306</text>
       <text x="${218}" y="${120}" text-anchor="middle" font-family="var(--font-mono)" font-size="8" fill="${dim}">SDA 21 · SCL 22</text>`
    : `<text x="${218}" y="${106}" text-anchor="middle" font-family="var(--font-mono)" font-size="9" fill="${dim}">OLED · NOT FITTED</text>
       <text x="${218}" y="${120}" text-anchor="middle" font-family="var(--font-mono)" font-size="8" fill="${faint}">I²C —</text>`;
  const alertTxt = bzOn
    ? `<text x="${287}" y="${106}" text-anchor="middle" font-family="var(--font-mono)" font-size="9" fill="${ink}">ALERT · PWM</text>
       <text x="${287}" y="${120}" text-anchor="middle" font-family="var(--font-mono)" font-size="8" fill="${dim}">GPIO 16</text>`
    : `<text x="${287}" y="${106}" text-anchor="middle" font-family="var(--font-mono)" font-size="9" fill="${dim}">ALERT · NOT FITTED</text>
       <text x="${287}" y="${120}" text-anchor="middle" font-family="var(--font-mono)" font-size="8" fill="${faint}">PWM —</text>`;

  const corner = (x: number, y: number) =>
    `<path d="M${x + 6} ${y} H${x} V${y + 6}" fill="none" stroke="${dim}" stroke-width="1"/>`;

  svg.innerHTML = `
    ${corner(2, 2)}${corner(558, 2)}${corner(2, 148)}${corner(558, 148)}
    <g stroke="${ink}" stroke-width="1" fill="none">
      <path d="M130 75 H200"/>
      <path d="M200 130 V78"/>
      <path d="M200 75 H400"/>
    </g>
    <circle cx="130" cy="75" r="3" fill="${ink}"/>
    <circle cx="200" cy="75" r="2.5" fill="${ink}"/>
    <circle cx="400" cy="75" r="2.5" fill="${ink}"/>
    <g font-family="var(--font-mono)" text-anchor="middle">
      <rect x="12" y="45" width="118" height="60" fill="${fillA}" stroke="${ink}"/>
      <text x="71" y="71" font-size="10" fill="${ink}">ESP32</text>
      <text x="71" y="86" font-size="8" fill="${dim}">DEVKIT-V1</text>
      <text x="71" y="97" font-size="7" letter-spacing="1" fill="${dim}">ARDUINO CORE</text>
      <rect x="402" y="16" width="148" height="118" fill="${fillB}" stroke="${ink}"/>
      <text x="456" y="29" font-size="10" fill="${ink}">SENSOR ARRAY</text>
      <path d="M408 34 H504" stroke="${ink}" stroke-width="1"/>
      ${rows}
      <rect x="150" y="92" width="155" height="42" fill="${fillA}" stroke="${ink}"/>
      ${periphTxt}
      ${alertTxt}
    </g>`;

  if (stamp) {
    // I²C bus summary: fitted device@address list, else the wiring fallback
    // ("21/22" pins when only the OLED is fitted) or a dash when nothing is.
    const i2cFit = rigI2cFit();
    const i2cStamp = i2cFit.length
      ? i2cFit.map(d => `${short(d.device)}@${fmtI2c(d.address)}`).join('/')
      : (oledOn ? `${I2C_SDA}/${I2C_SCL}` : '—');
    stamp.textContent = auto
      ? `SENSORS · AUTO DETECT   ·   I²C ${i2cStamp}   ·   ALERT ${bzOn ? '· GPIO 16' : '—'}`
      : `SENSORS · ${n}ch · ${pins.join('/')}   ·   I²C ${i2cStamp}   ·   ALERT ${bzOn ? '· GPIO 16' : '—'}`;
  }
  const fp = document.getElementById('fwPreset');
  if (fp) {
    const label = PRESETS[activePreset]?.name
      || customPresets.find(c => c.id === activePreset)?.name
      || (activePreset === 'auto' ? 'auto-detect' : activePreset);
    fp.textContent = label;
  }
  updatePreflight();
}

function refreshRigBlueprint() {
  renderRigSchematic();
}

/// If the hardware profile has custom channel names for the current count,
/// apply them to `chNames` + the legend. Called on init, auto-detect, and when
/// the user edits the channel names input.
function applyCustomNames() {
  const names = hardwareProfile.customChannelNames;
  if (!names || names.length === 0) return;
  // Use custom names when their count matches the current channel count;
  // otherwise truncate/pad with CHn defaults to keep the UI consistent.
  if (names.length !== channelCount) {
    chNames = Array.from({ length: channelCount }, (_, i) => names[i] || `CH${i + 1}`);
  } else {
    chNames = [...names];
  }
  channelKinds = [];
  traceData = chNames.map(() => []);
  buildLegend();
  const pc = document.getElementById('plotChCount');
  if (pc) pc.textContent = String(channelCount);
  updateRailCoord();
  refreshCalibrationViews();
}

// === Preset Change ===
function onPresetChange(preset: string) {
  activePreset = preset;
  if (preset === 'auto') {
    setChannelCount(0);
    const mapping = document.getElementById('channelMapping');
    if (mapping) mapping.textContent = '';
    const detail = document.getElementById('presetDetail');
    if (detail) detail.innerHTML = '<span class="hint">Channels are detected automatically from the connected device.</span>';
    return;
  }
  const p = PRESETS[preset];
  if (!p) return;
  chNames = p.sensors;
  channelCount = p.sensors.length;
  channelKinds = [];
  traceData = chNames.map(() => []);
  buildLegend();
  const pc = document.getElementById('plotChCount');
  if (pc) pc.textContent = String(channelCount);
  updateRigNote();
  updateRailCoord();
  refreshCalibrationViews();
  const detail = document.getElementById('presetDetail');
  if (detail) {
    detail.innerHTML = `<div style="font-size:11px;color:var(--text-2)">
      <strong>${p.name}</strong> — ${p.sensors.length} sensor array<br/>
      ${p.sensors.map((s, i) => `<span class="preset-chip" style="border-color:${channelColor(i)};color:${channelColor(i)}">${s}</span>`).join(' ')}
    </div>`;
  }
  // Channel mapping — a coherent CH → sensor → target-gas table, with the
  // *actual* auto-assigned ADC GPIO pins (not a placeholder 32+i*2 guess).
  const mapping = document.getElementById('channelMapping');
  if (mapping) {
    const pins = presetPins(p.sensors.length);
    mapping.innerHTML = p.sensors.map((s, i) => {
      const info = SENSOR_INFO[s] || { name: s, target: 'Unspecified target', range: '—' };
      return `<div class="map-row">
        <div class="map-ch" style="color:${channelColor(i)}">CH${i + 1}</div>
        <div class="map-sensor">
          <div class="map-name">${info.name}</div>
          <div class="map-target">${info.target} · ${info.range}</div>
        </div>
        <div class="map-gpio">GPIO ${pins[i] ?? '—'}</div>
      </div>`;
    }).join('');
  }
}

// === Classifier: Train Tab ===
function renderTrain() {
  const body = document.getElementById('trainBody')!;
  const minQ = trainMinQualityValue();
  body.innerHTML = sessions.map((s, i) => {
    const fid = s.file_id || '';
    const checked = fid ? trainSelected.has(fid) : false;
    const q = qualityBadge(s.quality);
    const analyzed = s.quality_report && typeof s.quality_report.total === 'number';
    const below = minQ > 0 && s.quality < minQ * 100;
    const rowCls = below ? ' class="train-blocked"' : '';
    const filename = s.path ? String(s.path).split('/').pop() || s.label : s.substance;
    const qualityCell = analyzed
        ? (below
          ? `<span class="quality-badge bad" title="Below the ${(minQ * 100).toFixed(0)}/100 quality gate — will be excluded from training">${q.label} ${s.quality} blocked</span>`
          : `<span class="quality-badge ${q.cls}">${q.label} ${s.quality}</span>`)
        : `<button class="lib-analyze train-analyze" data-fid="${fid}" title="Run the full 7-factor quality analysis">Not analyzed — Analyze</button>`;
      return `<tr${rowCls}>
      <td><input type="checkbox" class="train-tick" data-fid="${fid}" ${checked ? 'checked' : ''} ${fid ? '' : 'disabled'}></td>
      <td>${s.time}</td>
      <td>${s.substance}</td>
      <td><input type="text" class="train-label" data-fid="${fid}" value="${s.substance.replace(/"/g, '&quot;')}" placeholder="label" ${fid ? '' : 'disabled'} /></td>
      <td style="overflow:hidden;text-overflow:ellipsis;color:var(--text-2)" title="${filename}">${filename}</td>
      <td>${qualityCell}</td>
    </tr>`;
  }).join('');
  const analyzedCount = sessions.filter(s => s.quality_report && typeof s.quality_report.total === 'number').length;
  const stamp = document.querySelector('#panel-train .hud-panel-head .coord-tag');
  if (stamp) stamp.textContent = `${sessions.length} recordings · ${analyzedCount} analyzed`;
  document.getElementById('trainStatus')!.textContent = trainSufficiencyText();
  body.querySelectorAll('.train-tick').forEach(cb => {
    cb.addEventListener('change', () => {
      const box = cb as HTMLInputElement;
      const fid = box.getAttribute('data-fid')!;
      if (box.checked) trainSelected.add(fid);
      else trainSelected.delete(fid);
      updateTrainButton();
    });
  });
  body.querySelectorAll('.train-analyze').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const fid = btn.getAttribute('data-fid') || '';
      const idx = sessions.findIndex(s => s.file_id === fid);
      if (idx >= 0) {
        btn.textContent = 'Analyzing…';
        btn.setAttribute('disabled', 'true');
        await analyzeLibrarySession(idx);
        renderTrain();
      }
    });
  });
  body.querySelectorAll('.train-label').forEach(inp => {
    inp.addEventListener('input', () => updateTrainButton());
  });
  updateTrainButton();
}

// Counts the ticked recordings per label (a "label" = a smell class). This is
// the single source of truth for whether a training set is sufficient — the
// rule is ≥2 recordings per smell, for at least 2 different smells. It mirrors
// the Rust quality gate (train_classifier → TrainOptions.min_quality): ticked
// recordings below the min-quality threshold are excluded, so the verdict the
// user sees matches the recordings the backend will actually train on.
function trainMinQualityValue(): number {
  return (parseFloat((document.getElementById('trainMinQuality') as HTMLInputElement | null)?.value || '0') || 0) / 100;
}
function trainSufficiencyCounts(): Map<string, number> {
  const minQ = trainMinQualityValue();
  const counts = new Map<string, number>();
  for (const fid of Array.from(trainSelected)) {
    const s = sessions.find(x => x.file_id === fid);
    if (minQ > 0 && s && s.quality < minQ * 100) continue;
    const inp = document.querySelector(`.train-label[data-fid="${fid}"]`) as HTMLInputElement | null;
    const label = (inp ? inp.value.trim() : '') || '(unlabeled)';
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return counts;
}

// Rough window count per labelled class, so the user sees "this smell will only
// give ~5 windows" BEFORE training instead of hitting the hard backend floor.
// Windows ≈ (n − window) / stride + 1  (TRAIN_STRIDE=5), one edge-padded window
// when a recording is shorter than the window; 10 Hz reference rate.
function estimateWindowsPerClass(): Map<string, number> {
  const minQ = trainMinQualityValue();
  const ws = trainWindowParam();
  const stride = 5;
  const rate = liveRateHz > 0 ? liveRateHz : 10;
  const windows = new Map<string, number>();
  for (const fid of Array.from(trainSelected)) {
    const s = sessions.find(x => x.file_id === fid);
    if (!s) continue;
    if (minQ > 0 && s.quality < minQ * 100) continue;
    const inp = document.querySelector(`.train-label[data-fid="${fid}"]`) as HTMLInputElement | null;
    const label = (inp ? inp.value.trim() : '') || '(unlabeled)';
    const n = Math.round((parseInt(s.duration, 10) || 0) * rate);
    const w = n >= ws ? Math.floor((n - ws) / stride) + 1 : Math.max(1, n > 0 ? 1 : 0);
    windows.set(label, (windows.get(label) || 0) + w);
  }
  return windows;
}

function trainWindowParam(): number {
  return parseInt((document.getElementById('trainWindow') as HTMLInputElement | null)?.value || '100', 10) || 100;
}

// Declares, in plain language, whether the ticked+labelled recordings are
// sufficient to train — per smell — and what data quality they carry.
function trainSufficiencyText(): string {
  const counts = trainSufficiencyCounts();
  if (counts.size === 0) return `${sessions.length} recordings — tick at least 2 per smell to train`;
  const windows = estimateWindowsPerClass();
  const parts: string[] = [];
  let ready = 0;
  for (const [label, n] of counts) {
    const ok = n >= 2;
    if (ok) ready++;
    const w = windows.get(label) || 0;
    parts.push(`${label}: ${n} rec · ~${w} win${!ok ? ' ✗ need ≥2' : w < 8 ? ' (short — more = more accurate)' : ' ✓'}`);
  }
  const minQ = (document.getElementById('trainMinQuality') as HTMLInputElement | null)?.value || '0';
  const sufficient = counts.size >= 2 && ready === counts.size;
  const verdict = sufficient ? 'sufficient ✓ — ready to train' : 'not sufficient — need ≥2 recordings in ≥2 smells (at or above the quality gate)';
  const eligible = Array.from(counts.values()).reduce((a, n) => a + n, 0);
  const blocked = trainSelected.size - eligible;
  const blockedNote = blocked > 0 ? ` · ⚠ ${blocked} ticked below quality gate` : '';
  return `${trainSelected.size} recordings · ${parts.join(' · ')} · ${verdict} · min quality ${(parseFloat(minQ) * 100).toFixed(0)}/100${blockedNote}`;
}

function updateTrainButton() {
  const btn = document.getElementById('trainBtn') as HTMLButtonElement;
  const counts = trainSufficiencyCounts();
  const ready = counts.size >= 2 && Array.from(counts.values()).every(n => n >= 2);
  btn.disabled = !ready;
  btn.title = ready ? 'Train' : 'Select ≥2 recordings for at least 2 different smells';
  document.getElementById('trainStatus')!.textContent = trainSufficiencyText();
}

// Run the full 7-factor quality analysis on any selected recording that only
// has the provisional heuristic, so training-time quality filtering uses real
// scores. Returns how many recordings were newly analyzed.
async function ensureQualityAnalyzed(fileIds: string[]): Promise<number> {
  let analyzed = 0;
  for (const fid of fileIds) {
    const s = sessions.find(x => x.file_id === fid);
    if (!s || (s.quality_report && typeof s.quality_report.total === 'number')) continue;
    try {
      const json = await invoke<string>('analyze_recording', { fileId: fid });
      const report = JSON.parse(json) as QualityReport;
      s.quality_report = report;
      if (typeof report.total === 'number') s.quality = Math.round(report.total);
      analyzed++;
    } catch (e) {
      console.error(`Quality analysis failed for ${fid}:`, e);
    }
  }
  if (analyzed > 0) {
    renderLibrary();
    renderTrain();
  }
  return analyzed;
}

async function trainClassifier() {
  const log = document.getElementById('trainLog')!;
  const name = (document.getElementById('trainName') as HTMLInputElement).value.trim();
  const windowSize = parseInt((document.getElementById('trainWindow') as HTMLInputElement).value) || 100;
  const minQuality = (parseFloat((document.getElementById('trainMinQuality') as HTMLInputElement).value) || 0) / 100;
  if (!name) { log.innerHTML = '<span class="train-err">Enter a classifier name.</span>'; return; }
  const sufficiency = trainSufficiencyCounts();
  const ready = sufficiency.size >= 2 && Array.from(sufficiency.values()).every(n => n >= 2);
  if (!ready) { log.innerHTML = '<span class="train-err">Select ≥2 recordings for at least 2 different smells (each class needs ≥2 recordings).</span>'; return; }
  const fileIds = Array.from(trainSelected);
  const labels = fileIds.map(fid => {
    const inp = document.querySelector(`.train-label[data-fid="${fid}"]`) as HTMLInputElement;
    return inp ? inp.value.trim() : '';
  });
  log.innerHTML = 'Training…';
  try {
    // The min-quality gate is only as honest as the scores it reads. Selected
    // recordings that only carry the provisional heuristic are analyzed with
    // the full 7-factor scorer first, so quality filtering happens on real
    // scores, not estimates.
    const analyzed = await ensureQualityAnalyzed(fileIds);
    if (analyzed > 0) {
      log.innerHTML = `Analyzed quality for ${analyzed} recording(s), then training…`;
    }
    const res = await invoke<{ report: TrainingReport; path: string }>('train_classifier', {
      fileIds, labels, name, windowSize, minQuality,
    });
    renderModelCard(res.report);
    log.innerHTML = '<span style="color:var(--green)">✓ Trained and saved: ' + res.report.name + ' (JSON)</span>';
    // Load the freshly-trained model into the Dashboard live classifier right
    // away, so Train → the model is immediately live, no extra clicks.
    try {
      liveSnapshot = await invoke<LiveSnapshot>('load_live_classifier', { name: res.report.name });
      renderLiveState();
      log.innerHTML = '<span style="color:var(--green)">✓ Trained and saved: ' + res.report.name
        + ' (JSON) — now live on the Dashboard classifies new samples.</span>';
    } catch { /* model card stands alone if loading fails */ }
    reloadClassifiers();
  } catch (e) {
    const msg = String(e);
    const tooFew = msg.match(/Class '([^']+)' has too few windows \((\d+); need at least (\d+)\)/);
    if (tooFew) {
      renderTrainShortfall(tooFew[1], parseInt(tooFew[2], 10), parseInt(tooFew[3], 10));
      return;
    }
    const tooFewRecs = msg.match(/Select at least (\d+) recordings to train \((\d+) usable\)/);
    if (tooFewRecs) {
      log.innerHTML = `<span class="train-err">Not enough usable recordings (${tooFewRecs[2]} usable, need ${tooFewRecs[1]}). Record more or lower the quality gate above.</span>`;
      return;
    }
    const friendly = msg
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^Error:\s*/, '');
    log.innerHTML = `<span class="train-err">${friendly}</span>`;
  }
}

// A class came up short of the backend window floor. Say *what to do* instead
// of dumping the raw feature-extraction error on the user.
function renderTrainShortfall(label: string, got: number, need: number) {
  const log = document.getElementById('trainLog')!;
  log.innerHTML = `
    <div class="train-shortfall">
      <div class="ts-title">One class needs more data — ${label}</div>
      <div>That smell only produced <b>${got}</b> feature windows (needs ${need}). Each ~30–60s of clean exposure gives several windows — record a little longer, or add one more sample of <b>${label}</b>, then train again.</div>
      <div class="ts-actions">
        <button id="tsRecord" class="green">Record '${label}' now</button>
        <button id="tsDismiss">Dismiss</button>
      </div>
    </div>`;
  const record = document.getElementById('tsRecord');
  record?.addEventListener('click', () => {
    const sub = document.getElementById('recSubstance') as HTMLInputElement;
    if (sub) sub.value = label;
    openRecordModal();
  });
  document.getElementById('tsDismiss')?.addEventListener('click', () => { log.innerHTML = ''; });
}

function renderModelCard(report: TrainingReport) {
  const ins = document.getElementById('trainInspector')!;
  if (report.success === false) {
    ins.innerHTML = `<div class="train-err">${report.error || 'Training failed.'}</div>`;
    return;
  }
  const pct = (x: number) => (x * 100).toFixed(1) + '%';
  const similarity = parseSimilarityFromJson(report.model_json);
  const warnings = (report.warnings || []).map(w => `<div class="train-warn">⚠ ${w}</div>`).join('');
  ins.innerHTML = `
    <h4>Model</h4>
    <div class="train-metric"><span>Name</span><strong>${report.name}</strong></div>
    <div class="train-metric"><span>Classes</span><span>${report.classes.join(', ')}</span></div>
    <div class="train-metric"><span>Windows</span><span>${report.n_windows} (${report.classes.map(c => report.windows_per_class[c]).join('/')})</span></div>
    <div class="train-metric"><span>Recordings</span><span>${report.classes.map(c => report.recordings_per_class[c]).join('/')}</span></div>

    <h4>Accuracy</h4>
    <div class="train-metric"><span>Out-of-sample (LORO)</span><strong style="color:var(--green)">${pct(report.accuracy)}</strong></div>
    <div class="train-metric"><span>Mean-fold LORO</span><span>${(report.loro_mean_accuracy * 100).toFixed(1)}%</span></div>
    <div class="train-metric"><span>In-sample (reference)</span><span style="color:var(--text-3)">${pct(report.in_sample_accuracy)}</span></div>

    <h4>Similarity</h4>
    ${similarity.map(s =>
      `<div class="train-metric"><span>${s.class_a} ↔ ${s.class_b}</span><span style="color:${s.fdr_mean < 0.25 ? 'var(--yellow)' : 'var(--text-2)'}">cos ${s.cosine.toFixed(2)} · FDR ${s.fdr_mean.toFixed(2)}</span></div>`
    ).join('') || '<div style="color:var(--text-3)">—</div>'}

    ${renderAdequacyVerdict(report, similarity)}

    ${warnings}
  `;
}

// Declares, in plain language, whether the training set was healthy enough to
// trust — flagging smells that were too similar to one another to separate.
function renderAdequacyVerdict(report: TrainingReport, similarity: { class_a: string; class_b: string; cosine: number; fdr_mean: number }[]): string {
  const confusing = similarity.filter(s => s.fdr_mean < 0.25);
  const lowAcc = report.accuracy < 0.6;
  const parts: string[] = [];
  if (confusing.length) {
    parts.push(`⚠ Smells too similar to separate well: ${confusing.map(s => `${s.class_a} ↔ ${s.class_b}`).join(', ')} — consider re-recording with more distinct samples or a longer exposure.`);
  }
  if (lowAcc) {
    parts.push('⚠ Out-of-sample accuracy below 60% — the smells may be too similar, or there may be too few recordings per class.');
  }
  if (!parts.length) {
    parts.push('✓ Training set is sufficiently distinct — smells separate cleanly out-of-sample.');
  }
  return parts.map(p => {
    if (confusing.length || lowAcc) {
      return `<div class="train-warn">${p}</div>`;
    }
    return `<div class="adequacy-ok">${p}</div>`;
  }).join('');
}

function parseSimilarityFromJson(modelJson: string): { class_a: string; class_b: string; cosine: number; fdr_mean: number }[] {
  try {
    const m = JSON.parse(modelJson);
    const card = m?.model_card;
    return card?.similarity || [];
  } catch { return []; }
}

// === Classifier: Live (Dashboard sidebar) ===
function renderLiveControls(classifiers: ClassifierInfo[]) {
  const ctrl = document.getElementById('liveCtrl')!;
  const selClass = liveSnapshot?.loaded ? liveSnapshot.classifier_name : '';
  ctrl.innerHTML = `
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
      <select id="liveModel" style="flex:1">
        <option value="">— none —</option>
        ${classifiers.map(c => `<option value="${c.name}" ${c.name === selClass ? 'selected' : ''}>${c.name} (${c.n_classes})</option>`).join('')}
      </select>
      <button id="liveLoad" ${classifiers.length ? '' : 'disabled'}>Load</button>
      <button id="liveUnload" ${liveSnapshot?.loaded ? '' : 'disabled'}>Unload</button>
    </div>`;
  const loadBtn = document.getElementById('liveLoad')!;
  const unloadBtn = document.getElementById('liveUnload')!;
  loadBtn.addEventListener('click', async () => {
    const name = (document.getElementById('liveModel') as HTMLSelectElement).value;
    if (!name) return;
    try {
      liveSnapshot = await invoke<LiveSnapshot>('load_live_classifier', { name });
      renderLiveState();
      renderLiveControls(classifiers);
    } catch (e) { console.error('Load classifier failed:', e); }
  });
  unloadBtn.addEventListener('click', async () => {
    try {
      liveSnapshot = await invoke<LiveSnapshot>('unload_live_classifier');
      renderLiveState();
      renderLiveControls(classifiers);
    } catch (e) { console.error('Unload failed:', e); }
  });
}

function renderLiveState() {
  const wrap = document.getElementById('liveProbs')!;
  const lock = document.getElementById('liveLock')!;
  if (!liveSnapshot || !liveSnapshot.loaded) {
    wrap.innerHTML = '';
    lock.innerHTML = '';
    return;
  }
  const probs = liveSnapshot.current_probs;
  const classes = liveSnapshot.classes;
  wrap.innerHTML = classes.map((c, i) => {
    const p = probs[i] || 0;
    const color = channelColor(i);
    return `<div class="live-row">
      <span class="p-name" title="${c}">${c}</span>
      <div class="p-track"><div class="p-fill" style="width:${(p * 100).toFixed(1)}%;background:${color}"></div></div>
      <span class="p-val">${(p * 100).toFixed(0)}%</span>
    </div>`;
  }).join('');
  const pred = liveSnapshot.current_prediction;
  if (!pred || !pred.label) { lock.innerHTML = ''; return; }
  if (pred.label === 'unknown') {
    lock.innerHTML = `<span class="live-lock unknown">unknown · ${Math.round(liveSnapshot.unknown_count / 20 * 100)}% · ${(pred.confidence * 100).toFixed(0)}%</span>`;
  } else if (liveSnapshot.locked) {
    lock.innerHTML = `<span class="live-lock">🔒 ${pred.label} · ${(pred.confidence * 100).toFixed(0)}%</span>`;
  } else {
    lock.innerHTML = `<span class="live-lock" style="background:var(--bg-3);color:var(--text-2)">${pred.label} · lock ${liveSnapshot.lock_count}/10</span>`;
  }
}

async function reloadClassifiers() {
  try {
    const classifiers = await invoke<ClassifierInfo[]>('list_classifiers');
    renderLiveControls(classifiers);
  } catch (e) { console.error('List classifiers failed:', e); }
}

async function refreshTrainLibrary() {
  try {
    await invoke('import_recordings');
    sessions = await invoke<SessionRecord[]>('get_session_index');
    renderTrain();
  } catch (e) { console.error('Refresh train library failed:', e); }
}

// === Event Listeners ===
// Auto-detect e-noses on the LAN via mDNS `_osmograph._tcp` and offer them in
// the WiFi-mode dropdown. Selecting one fills the address field.
async function scanWifiDevices() {
  const sel = document.getElementById('wifiScan') as HTMLSelectElement;
  if (!sel) return;
  sel.innerHTML = '<option value="">Scanning…</option>';
  try {
    const devs = await invoke<Array<{ host: string; ip: string; port: number; firmware_version: string; n_channels: number }>>('find_osmograph_devices');
    if (!devs.length) {
      sel.innerHTML = '<option value="">No e-nose found (mDNS)</option>';
      return;
    }
    sel.innerHTML = '<option value="">Pick auto-detected e-nose</option>' + devs.map(d => {
      const addr = `${d.ip}:${d.port}`;
      const label = `${d.ip}:${d.port} · ${d.firmware_version !== 'unknown' ? 'fw ' + d.firmware_version : 'no INFO'}${d.n_channels > 0 ? ` · ${d.n_channels}ch` : ''}`;
      return `<option value="${addr}">${label}</option>`;
    }).join('');
  } catch {
    sel.innerHTML = '<option value="">Scan failed</option>';
  }
}

document.getElementById('modeSelect')!.addEventListener('change', () => {
  const value = (document.getElementById('modeSelect') as HTMLSelectElement).value;
  const wifi = document.getElementById('wifiAddr') as HTMLInputElement;
  const wifiScan = document.getElementById('wifiScan') as HTMLSelectElement;
  const ble = document.getElementById('bleSelect') as HTMLSelectElement;
  wifi.style.display = value === 'wifi' ? '' : 'none';
  wifiScan.style.display = value === 'wifi' ? '' : 'none';
  ble.style.display = value === 'ble' ? '' : 'none';
  if (value === 'ble') scanBleDevices();
  if (value === 'wifi') void scanWifiDevices();
});
document.getElementById('wifiScan')!.addEventListener('change', () => {
  const sel = document.getElementById('wifiScan') as HTMLSelectElement;
  const addr = (document.getElementById('wifiAddr') as HTMLInputElement);
  if (sel.value) addr.value = sel.value;
});
document.getElementById('connectBtn')!.addEventListener('click', toggleConnection);
document.getElementById('refreshBtn')!.addEventListener('click', () => {
  const mode = (document.getElementById('modeSelect') as HTMLSelectElement).value;
  if (mode === 'ble') scanBleDevices();
  else if (mode === 'wifi') void scanWifiDevices();
  else refreshPorts();
});
document.getElementById('detectBtn')!.addEventListener('click', async () => {
  const status = document.getElementById('fwToolchain')!;
  status.textContent = 'Detecting…';
  try {
    const boards = await invoke<Array<{ board_type: string; port: string; vid_pid: string; serial_number: string; manufacturer: string; label: string }>>('detect_board');
    if (boards.length === 0) {
      status.textContent = 'No board detected — plug in a USB board and retry.';
      return;
    }
    const esp = boards.find(b => b.board_type === 'esp32') || boards[0];
    const sel = document.getElementById('portSelect') as HTMLSelectElement;
    const exists = Array.from(sel.options).some(o => o.value === esp.port);
    if (!exists) {
      const opt = document.createElement('option');
      opt.value = esp.port;
      opt.textContent = `${esp.port} — ${esp.label}`;
      sel.appendChild(opt);
    }
    sel.value = esp.port;
    status.textContent = `${esp.label} on ${esp.port} (${esp.vid_pid})${esp.serial_number ? ' · SN ' + esp.serial_number : ''}`;
  } catch (e) {
    status.textContent = `Detection failed: ${e}`;
  }
});

// Compare mode switching + delta reference
document.querySelectorAll<HTMLElement>('#compareModes .cmp-mode').forEach(btn => {
  btn.addEventListener('click', () => {
    compareMode = (btn.dataset.mode as 'overlay' | 'delta' | 'heatmap') || 'overlay';
    document.querySelectorAll<HTMLElement>('#compareModes .cmp-mode').forEach(b => b.classList.toggle('active', b === btn));
    const title = document.getElementById('cmpVizTitle')!;
    const foot = document.getElementById('compareFoot')!;
    title.textContent = compareMode === 'heatmap'
      ? 'Similarity — Pearson correlation across sessions'
      : compareMode === 'delta'
        ? 'Δ vs ref — each session minus the reference'
        : 'Overlay — per-channel normalized response';
    foot.textContent = compareMode === 'heatmap'
      ? 'Similarity: Pearson correlation over the shared overlap of the selected channels.'
      : 'Overlay / Δ: one lane per sensor channel, sessions overlaid (Δ shows each session minus the reference).';
    renderCompareRef();
    renderCompareMetrics();
    drawCompare();
  });
});

document.getElementById('compareRef')!.addEventListener('change', (e) => {
  compareRefIdx = Number((e.target as HTMLSelectElement).value) || 0;
  renderCompareLabels();
  drawCompare();
});

document.getElementById('libRefresh')!.addEventListener('click', () => reloadLibrary());
document.getElementById('libSearch')?.addEventListener('input', () => renderLibrary());

document.getElementById('inspAnalyze')!.addEventListener('click', async () => {
  const s = sessions[selectedSession ?? -1];
  if (!s) return;
  await analyzeLibrarySession(selectedSession ?? -1);
});

// Run the full 7-factor quality analysis on a library session. Shared by the
// Inspector "Analyze" button and the in-row library "Analyze" tag.
async function analyzeLibrarySession(idx: number) {
  const s = sessions[idx];
  if (!s) return;
  const btn = document.getElementById('inspAnalyze') as HTMLButtonElement | null;
  const prev = btn ? btn.textContent : '';
  if (btn) btn.textContent = 'Analyzing…';
  try {
    const json = await invoke<string>('analyze_recording', { fileId: s.file_id });
    const report = JSON.parse(json) as QualityReport;
    s.quality_report = report;
    if (report.total !== null && report.total !== undefined) s.quality = report.total;
    renderLibrary();
    if (idx === (selectedSession ?? -1)) inspectSession(s);
  } catch (e) {
    document.getElementById('inspectorDetails')!.innerHTML =
      `<div style="color:var(--red);font-size:11px">Analysis failed: ${e}</div>`;
  } finally {
    if (btn) btn.textContent = prev;
  }
}

async function reloadLibrary() {
  try {
    compareSeriesCache.clear();
    await invoke('import_recordings');
    const records = await invoke<Array<{
      file_id: string; substance: string; label: string; timestamp: number;
      duration_sec: number; sensor_count: number; quality: number; csv_path: string;
      quality_report: string | null;
    }>>('get_session_index');
    sessions = records.map(r => {
      let report: QualityReport | null = null;
      if (r.quality_report) {
        try { report = JSON.parse(r.quality_report) as QualityReport; } catch {}
      }
      // Prefer the full analyzed score when available; fall back to the
      // provisional heuristic only when no real report exists yet.
      let quality = r.quality;
      if (report && typeof report.total === 'number') quality = Math.round(report.total);
      return {
        id: `s-${r.file_id}`,
        time: new Date(r.timestamp * 1000).toLocaleString(),
        substance: r.substance === 'unknown' ? 'Unknown' : r.substance,
        label: r.label,
        format: 'CSV',
        duration: `${Math.round(r.duration_sec)}s`,
        sensors: r.sensor_count,
        quality,
        path: r.csv_path,
        file_id: r.file_id,
        quality_report: report,
      };
    });
  } catch (e) {
    console.error('Library reload failed:', e);
  }
  renderLibrary();
}

// Import files/folders from anywhere via the native picker (Tauri dialog
// plugin). The Rust `import_paths` command registers the chosen absolute
// paths with the session index; we then refresh the library.
document.getElementById('libImport')!.addEventListener('click', async () => {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const paths = await open({
      multiple: true,
      directory: false,
      filters: [{ name: 'Recordings', extensions: ['csv', 'osmell'] }],
    });
    if (!paths) return; // cancelled
    const list = Array.isArray(paths) ? paths : [paths];
    if (list.length === 0) return;
    await invoke('import_paths', { paths: list });
    await reloadLibrary();
    await flashStatus('libStatus', `Imported ${list.length} file(s)`);
  } catch (e) {
    await flashStatus('libStatus', `Import failed: ${e}`, 'var(--red)');
  }
});

document.getElementById('libImportFolder')!.addEventListener('click', async () => {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const dir = await open({ directory: true, multiple: false });
    if (!dir) return; // cancelled
    await invoke('import_paths', { paths: [dir as string] });
    await reloadLibrary();
    await flashStatus('libStatus', `Imported folder: ${dir}`);
  } catch (e) {
    await flashStatus('libStatus', `Import failed: ${e}`, 'var(--red)');
  }
});

// === Drag & drop import (whole library area) ===
// Tauri v2 webview exposes dropped files with their real filesystem path on
// `File.path`, so dropping CSVs / .osmell files imports them straight in.
const libMainEl = document.getElementById('libMain');
const libDropHint = document.getElementById('libDropHint');
let libDragDepth = 0;
if (libMainEl) {
  libMainEl.addEventListener('dragenter', (e) => {
    e.preventDefault();
    libDragDepth++;
    if (libDropHint) libDropHint.style.display = 'flex';
  });
  libMainEl.addEventListener('dragover', (e) => { e.preventDefault(); });
  libMainEl.addEventListener('dragleave', (e) => {
    e.preventDefault();
    libDragDepth--;
    if (libDragDepth <= 0 && libDropHint) libDropHint.style.display = 'none';
  });
  libMainEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    libDragDepth = 0;
    if (libDropHint) libDropHint.style.display = 'none';
    const files = Array.from(e.dataTransfer?.files || []);
    const paths = files
      .map(f => (f as File & { path?: string }).path)
      .filter((p: string | undefined): p is string => typeof p === 'string' && p.length > 0);
    if (paths.length === 0) {
      await flashStatus('libStatus', 'No readable files dropped — use Import instead.', 'var(--yellow)');
      return;
    }
    try {
      await invoke('import_paths', { paths });
      await reloadLibrary();
      await flashStatus('libStatus', `Imported ${paths.length} file(s) by drag & drop`, 'var(--green)');
    } catch (e) {
      await flashStatus('libStatus', `Import failed: ${e}`, 'var(--red)');
    }
  });
}

async function selectedSessionRecord(): Promise<SessionRecord | null> {
  const s = sessions[selectedSession ?? -1];
  if (!s) {
    await flashStatus('libStatus', 'Select a session first');
    return null;
  }
  return s;
}

async function flashStatus(id: string, msg: string, color?: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  if (color) (el as HTMLElement).style.color = color;
  await new Promise(r => setTimeout(r, 2500));
  (el as HTMLElement).style.color = '';
}

document.getElementById('inspRename')!.addEventListener('click', () => {
  const idx = selectedSession;
  if (idx === null || idx === undefined) { flashStatus('libStatus', 'Select a session first'); return; }
  const td = document.querySelector<HTMLElement>(`tr[data-idx="${idx}"] .lib-sub`);
  if (td) beginRenameCell(td);
});

document.getElementById('inspDelete')!.addEventListener('click', async () => {
  const s = await selectedSessionRecord();
  if (!s) return;
  if (!confirm(`Delete session "${s.substance}" (${s.time})? This removes the file.`)) return;
  try {
    if (s.file_id) await invoke('remove_session', { fileId: s.file_id });
    sessions.splice(selectedSession!, 1);
    selectedSession = null;
    renderLibrary();
    document.getElementById('inspectorDetails')!.textContent = 'Select a session';
    if (sfpCtx && sfpCanvas) sfpCtx.clearRect(0, 0, sfpCanvas.width, sfpCanvas.height);
  } catch (e) {
    await flashStatus('libStatus', `Delete failed: ${e}`, 'var(--red)');
  }
});

document.getElementById('inspExport')!.addEventListener('click', async () => {
  const s = await selectedSessionRecord();
  if (!s) return;
  try {
    const out = sessionExportPath(s, 'csv');
    const msg = await invoke<string>('export_session_copy', { fileId: s.file_id, outputPath: out });
    await flashStatus('libStatus', msg, 'var(--green)');
  } catch (e) {
    await flashStatus('libStatus', `Export failed: ${e}`, 'var(--red)');
  }
});

document.getElementById('libConvert')!.addEventListener('click', async () => {
  const s = await selectedSessionRecord();
  if (!s) return;
  try {
    const out = sessionExportPath(s, 'osmell');
    const msg = await invoke<string>('export_session_osmell', { fileId: s.file_id, outputPath: out });
    await flashStatus('libStatus', msg, 'var(--green)');
  } catch (e) {
    await flashStatus('libStatus', `Export failed: ${e}`, 'var(--red)');
  }
});

function sessionExportPath(s: SessionRecord, ext: 'csv' | 'osmell'): string {
  const base = dataDirValue || 'exports';
  const safe = (s.substance || 'session').replace(/[^a-z0-9-_]+/gi, '_');
  return `${base}/${s.time.replace(/[^0-9]/g, '').slice(0, 12)}_${safe}.${ext}`;
}

// === Data Storage panel (System -> Data) ===
async function refreshDataPanel() {
  try {
    dataDirValue = await invoke<string>('get_data_dir');
    const el = document.getElementById('dataDir') as HTMLInputElement;
    if (el) el.value = dataDirValue;
  } catch {}
}
document.getElementById('dataBrowse')!.addEventListener('click', refreshDataPanel);

document.getElementById('dataExportCSV')!.addEventListener('click', async () => {
  try {
    const msg = await invoke<string>('export_labeled_data', { outputDir: dataDirValue || (await invoke<string>('get_data_dir')) });
    await flashStatus('libStatus', msg, 'var(--green)');
  } catch (e) {
    await flashStatus('libStatus', `Export failed: ${e}`, 'var(--red)');
  }
});

document.getElementById('dataSubmitCommons')!.addEventListener('click', async () => {
  try {
    const dir = dataDirValue || (await invoke<string>('get_data_dir'));
    const infos = await invoke<Array<{
      id: string; substance: string; quality_score: number; status: string;
      n_samples: number; n_channels: number;
    }>>('export_and_submit_commons', { dataDir: dir });
    const first = infos[0];
    await flashStatus('libStatus', `Submitted ${infos.length} session(s) — ${first.substance} · q ${first.quality_score.toFixed(0)} · ${first.status}`, 'var(--green)');
    await refreshHub();
  } catch (e) {
    await flashStatus('libStatus', `Submit failed: ${e}`, 'var(--red)');
  }
});

// === Data Hub — review queue ===
function hubDataDir(): string {
  return dataDirValue || '';
}

async function refreshHub() {
  const el = document.getElementById('hubList');
  if (!el) return;
  const dir = hubDataDir();
  if (!dir) {
    await refreshDataPanel();
  }
  try {
    const entries = await invoke<HubEntry[]>('hub_list', { dataDir: hubDataDir() });
    if (!entries.length) {
      el.innerHTML = 'No contributions yet. Submit labeled data to begin vetting.';
      return;
    }
    el.innerHTML = entries.map(e => {
      const t10 = e.submitted_at.replace('T', ' ').slice(0, 19);
      const log = e.verification_log.slice(-3).join('<br>');
      const shortId = e.id.slice(0, 10);
      return `<div style="border:1px solid var(--border);border-left:3px solid var(--border-focus);padding:8px;margin-bottom:8px;border-radius:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <strong>${esc(e.substance) || 'unknown'}</strong>
          <span style="color:var(--text-3)">${shortId}</span>
          <span style="color:${statusColor(e.status)}">${esc(e.status)}</span>
          <span style="margin-left:auto;color:var(--text-2)">q ${e.quality_score.toFixed(0)} · ${e.n_samples} samples · ${e.n_channels}ch</span>
        </div>
        <div style="color:var(--text-3);margin:4px 0">${esc(e.contributor || 'anon')} · ${esc(e.device_id)} · ${t10}</div>
        <div style="color:var(--text-3);font-size:10px">${log}</div>
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
          ${statusBtn('hubApprove', e.id, 'Approve')}
          ${statusBtnReject(e.id)}
          ${statusBtn('hubPublish', e.id, 'Publish')}
          <button class="mini" data-hub-upload="${e.id}" data-subst="${esc(e.substance)}">Upload to HF</button>
        </div>
        <span class="hub-note" style="display:block;margin-top:4px;font-size:10px;color:var(--text-3)"></span>
      </div>`;
    }).join('');
    el.querySelectorAll('[data-hub-approve]').forEach(b => {
      b.addEventListener('click', () => hubAction('hub_approve', b.getAttribute('data-hub-approve')!));
    });
    el.querySelectorAll('[data-hub-reject]').forEach(b => {
      b.addEventListener('click', () => hubReject(b.getAttribute('data-hub-reject')!));
    });
    el.querySelectorAll('[data-hub-publish]').forEach(b => {
      b.addEventListener('click', () => hubAction('hub_publish', b.getAttribute('data-hub-publish')!));
    });
    el.querySelectorAll('[data-hub-upload]').forEach(b => {
      b.addEventListener('click', () => hubUpload((b as HTMLElement).dataset.hubUpload!, b.getAttribute('data-subst') || 'session'));
    });
    const hubStatus = document.getElementById('hubStatus');
    if (hubStatus) hubStatus.textContent = `${entries.length} contribution(s)`;
    const tokenOk = await invoke<boolean>('hf_has_token');
    if (hubStatus) hubStatus.textContent += tokenOk ? ' · HF token ✓' : ' · HF token not set';
  } catch (e) {
    el.innerHTML = `Failed to load hub: ${esc(String(e))}`;
  }
}

function statusColor(status: string): string {
  if (status.includes('Approved') || status.includes('Published')) return 'var(--green)';
  if (status.includes('Rejected')) return 'var(--red)';
  if (status.includes('Pending') || status.includes('AutoVerified')) return 'var(--yellow)';
  return 'var(--text-3)';
}

function statusBtn(action: string, id: string, label: string): string {
  return `<button class="mini" data-hub-${action}="${id}">${label}</button>`;
}
function statusBtnReject(id: string): string {
  return `<button class="mini" data-hub-reject="${id}">Reject</button>`;
}

async function hubAction(cmd: string, id: string) {
  try {
    await invoke(cmd, { dataDir: hubDataDir(), id });
    await refreshHub();
  } catch (e) {
    await flashStatus('hubStatus', `Action failed: ${e}`, 'var(--red)');
  }
}

async function hubReject(id: string) {
  const reason = prompt('Rejection reason:') || '';
  try {
    await invoke('hub_reject', { dataDir: hubDataDir(), id, reason });
    await refreshHub();
  } catch (e) {
    await flashStatus('hubStatus', `Reject failed: ${e}`, 'var(--red)');
  }
}

async function hubUpload(id: string, substance: string) {
  const repo = (document.getElementById('hfRepo') as HTMLInputElement).value.trim();
  if (!repo) {
    await flashStatus('hubStatus', 'Enter a HF dataset repo to upload to.', 'var(--red)');
    return;
  }
  const btn = document.querySelector(`[data-hub-upload="${id}"]`) as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
  try {
    const msg = await invoke<string>('hf_upload', { dataDir: hubDataDir(), repo, id, commitMessage: `OpenSmell ${substance} session` });
    const note = document.querySelector(`[data-hub-upload="${id}"]`)?.parentElement?.querySelector('.hub-note');
    if (note) (note as HTMLElement).textContent = msg;
  } catch (e) {
    await flashStatus('hubStatus', `Upload failed: ${e}`, 'var(--red)');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Upload to HF'; }
  }
}

// === Community Sync — HF list / download / token ===
document.getElementById('hfList')!.addEventListener('click', async () => {
  const repo = (document.getElementById('hfRepo') as HTMLInputElement).value.trim();
  const filesEl = document.getElementById('hfFiles');
  if (!filesEl) return;
  if (!repo) { filesEl.textContent = 'Enter a dataset repo first.'; return; }
  filesEl.textContent = 'Listing…';
  try {
    const files = await invoke<HfFile[]>('hf_list', { repo });
    filesEl.innerHTML = files.length
      ? files.map(f => {
          const kb = (f.size / 1024).toFixed(1);
          return `<div style="display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border);padding:4px 0">
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis">${esc(f.path)}</span>
            <span style="color:var(--text-3)">${kb} KB</span>
            <button class="mini" data-hf-dl="${esc(f.path)}">Download</button>
          </div>`;
        }).join('')
      : 'No files found in this dataset.';
    filesEl.querySelectorAll('[data-hf-dl]').forEach(b => {
      b.addEventListener('click', async () => {
        const fn = b.getAttribute('data-hf-dl')!;
        b.textContent = 'Downloading…';
        try {
          const msg = await invoke<string>('hf_download', { repo, filename: fn });
          await flashStatus('hubStatus', msg, 'var(--green)');
          await refreshHub();
          await reloadLibrary();
        } catch (e) {
          await flashStatus('hubStatus', `Download failed: ${e}`, 'var(--red)');
        } finally {
          b.textContent = 'Download';
        }
      });
    });
  } catch (e) {
    filesEl.textContent = `List failed: ${e}`;
  }
});

document.getElementById('hfTokenSave')!.addEventListener('click', async () => {
  const token = (document.getElementById('hfToken') as HTMLInputElement).value.trim();
  if (!token) { await flashStatus('hubStatus', 'Enter a token to use.', 'var(--red)'); return; }
  try {
    const msg = await invoke<string>('hf_set_token', { token });
    (document.getElementById('hfToken') as HTMLInputElement).value = '';
    await flashStatus('hubStatus', msg, 'var(--green)');
    await refreshHub();
  } catch (e) {
    await flashStatus('hubStatus', `Token set failed: ${e}`, 'var(--red)');
  }
});

const hfTokenClear = document.getElementById('hfTokenClear');
if (hfTokenClear) {
  hfTokenClear.addEventListener('click', async () => {
    try {
      await invoke('hf_clear_token');
      await flashStatus('hubStatus', 'HF token cleared from memory.', 'var(--green)');
      await refreshHub();
    } catch (e) {
      await flashStatus('hubStatus', `Clear failed: ${e}`, 'var(--red)');
    }
  });
}

document.getElementById('hubRefresh')!.addEventListener('click', refreshHub);

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// === Train Tab listeners ===
document.getElementById('trainBtn')!.addEventListener('click', trainClassifier);
document.getElementById('trainRefresh')!.addEventListener('click', refreshTrainLibrary);
document.getElementById('trainName')!.addEventListener('input', () => {
  const btn = document.getElementById('trainBtn') as HTMLButtonElement;
  btn.disabled = trainSelected.size < 2 || !(document.getElementById('trainName') as HTMLInputElement).value.trim();
});
document.getElementById('trainMinQuality')!.addEventListener('input', () => {
  renderTrain();
});
document.getElementById('fleetScan')!.addEventListener('click', async () => {
  try {
    fleetDevices = await invoke<FleetDevice[]>('fleet_scan');
    renderFleet();
  } catch { renderFleet(); }
});

// OLED + Buzzer: conditional (only if the user actually has the peripheral
// wired up), persisted, and pushed into Rust state so the plumbing is real.
const PERIPH_KEY = 'osmograph.peripherals.v1';
interface PeripheralState {
  oledEnabled: boolean;
  oled: { screen_size: string; layout: string; rotation: number; cycle_interval_secs: number };
  buzzerEnabled: boolean;
  buzzer: { warning_pattern: string; critical_pattern: string; emergency_pattern: string; volume: number; frequency_hz: number };
}
let peripheralState: PeripheralState = {
  oledEnabled: false,
  oled: { screen_size: '128x64', layout: 'overview', rotation: 0, cycle_interval_secs: 5 },
  buzzerEnabled: false,
  buzzer: { warning_pattern: 'double', critical_pattern: 'continuous', emergency_pattern: 'continuous', volume: 70, frequency_hz: 2000 },
};
function loadPeripheralState() {
  try {
    const raw = localStorage.getItem(PERIPH_KEY);
    if (raw) peripheralState = { ...peripheralState, ...(JSON.parse(raw) as Partial<PeripheralState>) };
  } catch { /* defaults */ }
}
function persistPeripheralState() { try { localStorage.setItem(PERIPH_KEY, JSON.stringify(peripheralState)); } catch { /* ignore */ } }
function saveOledToRust() {
  const cfg = { screen_size: peripheralState.oled.screen_size, layout: peripheralState.oled.layout, rotation: peripheralState.oled.rotation, cycle_interval_secs: peripheralState.oled.cycle_interval_secs };
  invoke('oled_set_config', { config: cfg }).catch(e => console.error('oled_set_config failed:', e));
}
function saveBuzzerToRust() {
  const cfg = { warning_pattern: peripheralState.buzzer.warning_pattern, critical_pattern: peripheralState.buzzer.critical_pattern, emergency_pattern: peripheralState.buzzer.emergency_pattern, volume: peripheralState.buzzer.volume, frequency_hz: peripheralState.buzzer.frequency_hz };
  invoke('buzzer_set_config', { config: cfg }).catch(e => console.error('buzzer_set_config failed:', e));
}
function syncPeripheralUI() {
  const oledEnabled = document.getElementById('oledEnabled') as HTMLSelectElement;
  const oledStatus = document.getElementById('oledStatus');
  const oledBody = document.getElementById('oledBody');
  if (oledEnabled) oledEnabled.value = peripheralState.oledEnabled ? 'yes' : 'no';
  if (oledBody) oledBody.classList.toggle('off', !peripheralState.oledEnabled);
  if (oledStatus) {
    oledStatus.textContent = peripheralState.oledEnabled
      ? 'OLED selected — this config is saved and will be used when firmware with display support is flashed.'
      : 'No OLED. If your board has one, set "I have an OLED" to configure it.';
    oledStatus.style.color = peripheralState.oledEnabled ? 'var(--green)' : 'var(--text-3)';
  }
  const buzzerEnabled = document.getElementById('buzzerEnabled') as HTMLSelectElement;
  const buzzerStatus = document.getElementById('buzzerStatus');
  const buzzerBody = document.getElementById('buzzerBody');
  if (buzzerEnabled) buzzerEnabled.value = peripheralState.buzzerEnabled ? 'yes' : 'no';
  if (buzzerBody) buzzerBody.classList.toggle('off', !peripheralState.buzzerEnabled);
  if (buzzerStatus) {
    buzzerStatus.textContent = peripheralState.buzzerEnabled
      ? 'Buzzer selected — patterns are saved and will be used when firmware with buzzer support is flashed.'
      : 'No buzzer. If your board has one, set "I have a buzzer" to configure alerts.';
    buzzerStatus.style.color = peripheralState.buzzerEnabled ? 'var(--green)' : 'var(--text-3)';
  }
  refreshRigBlueprint();
}
// Apply the persisted/peripheral form values into the config state (read from DOM).
function captureOledFromDom() {
  peripheralState.oled.screen_size = (document.getElementById('oledScreen') as HTMLSelectElement).value;
  peripheralState.oled.layout = (document.getElementById('oledLayout') as HTMLSelectElement).value;
  peripheralState.oled.rotation = Number((document.getElementById('oledRotation') as HTMLSelectElement).value) || 0;
  const cyc = (document.getElementById('oledCycle') as HTMLSelectElement).value;
  peripheralState.oled.cycle_interval_secs = cyc === 'off' ? 0 : (Number(cyc) || 5);
  saveOledToRust();
}
function applyOledToDom() {
  (document.getElementById('oledScreen') as HTMLSelectElement).value = peripheralState.oled.screen_size;
  (document.getElementById('oledLayout') as HTMLSelectElement).value = peripheralState.oled.layout;
  (document.getElementById('oledRotation') as HTMLSelectElement).value = String(peripheralState.oled.rotation);
  const cycEl = document.getElementById('oledCycle') as HTMLSelectElement;
  cycEl.value = peripheralState.oled.cycle_interval_secs > 0 ? String(peripheralState.oled.cycle_interval_secs) : 'off';
}
function captureBuzzerFromDom() {
  peripheralState.buzzer.warning_pattern = (document.getElementById('buzzerWarn') as HTMLSelectElement).value;
  peripheralState.buzzer.critical_pattern = (document.getElementById('buzzerCrit') as HTMLSelectElement).value;
  peripheralState.buzzer.emergency_pattern = (document.getElementById('buzzerEmerg') as HTMLSelectElement).value;
  peripheralState.buzzer.volume = Number((document.getElementById('buzzerVolume') as HTMLInputElement).value) || 0;
  peripheralState.buzzer.frequency_hz = Number((document.getElementById('buzzerFreq') as HTMLInputElement).value) || 2000;
  saveBuzzerToRust();
}
function applyBuzzerToDom() {
  (document.getElementById('buzzerWarn') as HTMLSelectElement).value = peripheralState.buzzer.warning_pattern;
  (document.getElementById('buzzerCrit') as HTMLSelectElement).value = peripheralState.buzzer.critical_pattern;
  (document.getElementById('buzzerEmerg') as HTMLSelectElement).value = peripheralState.buzzer.emergency_pattern;
  (document.getElementById('buzzerVolume') as HTMLInputElement).value = String(peripheralState.buzzer.volume);
  (document.getElementById('buzzerVolVal') as HTMLSpanElement).textContent = `${peripheralState.buzzer.volume}%`;
  (document.getElementById('buzzerFreq') as HTMLInputElement).value = String(peripheralState.buzzer.frequency_hz);
}

// === Hardware profile (declared here, before the peripheral wiring below that
// (via syncPeripheralUI → refreshRigBlueprint) reads `hardwareProfile` during
// module evaluation. Ordering matters — a top-level call must never hit the
// const/let temporal-dead-zone of a value declared later in the module: that
// aborts init and strands the boot loader. ===
const HW_KEY = 'osmograph.hardware';
let hardwareProfile: HardwareProfile = {
  preset: 'custom', name: '', adcBits: 12, rloadOhm: 1000, vcc: 5.0, sensorOnLowSide: true, i2cDevices: [],
};

// OLED
document.getElementById('oledLayout')!.addEventListener('change', () => { captureOledFromDom(); persistPeripheralState(); updateOledPreview(); });
document.getElementById('oledRotation')!.addEventListener('change', () => { captureOledFromDom(); persistPeripheralState(); updateOledPreview(); });
document.getElementById('oledCycle')!.addEventListener('change', () => { captureOledFromDom(); persistPeripheralState(); updateOledPreview(); });
document.getElementById('oledScreen')!.addEventListener('change', () => { captureOledFromDom(); persistPeripheralState(); updateOledPreview(); });
document.getElementById('oledEnabled')!.addEventListener('change', () => {
  peripheralState.oledEnabled = (document.getElementById('oledEnabled') as HTMLSelectElement).value === 'yes';
  persistPeripheralState(); syncPeripheralUI();
});

// Buzzer
['buzzerWarn', 'buzzerCrit', 'buzzerEmerg'].forEach(id => {
  document.getElementById(id)!.addEventListener('change', () => { captureBuzzerFromDom(); persistPeripheralState(); updateBuzzerPreviews(); });
});
document.getElementById('buzzerVolume')!.addEventListener('input', (e) => {
  document.getElementById('buzzerVolVal')!.textContent = `${(e.target as HTMLInputElement).value}%`;
});
document.getElementById('buzzerVolume')!.addEventListener('change', () => { captureBuzzerFromDom(); persistPeripheralState(); });
document.getElementById('buzzerFreq')!.addEventListener('change', () => { captureBuzzerFromDom(); persistPeripheralState(); });
document.getElementById('buzzerEnabled')!.addEventListener('change', () => {
  peripheralState.buzzerEnabled = (document.getElementById('buzzerEnabled') as HTMLSelectElement).value === 'yes';
  persistPeripheralState(); syncPeripheralUI();
});

// Load once at startup: prefer Rust-side defaults (fresh), fall back to saved local.
loadPeripheralState();
applyOledToDom(); applyBuzzerToDom(); syncPeripheralUI();
updateBuzzerPreviews(); updateOledPreview();

// Preset
document.getElementById('sysPreset')!.addEventListener('change', (e) => {
  onPresetChange((e.target as HTMLSelectElement).value);
});

// Dynamic channel count (device-agnostic): user pins N channels before connecting,
// or sets 0 to auto-detect the count from the device's own stream.
document.getElementById('sysChannels')!.addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement;
  const n = parseInt(el.value, 10);
  if (isNaN(n)) return;
  setChannelCount(n);
  applyCustomNames();
});

// === Phase Recording (.osmell) ===

interface PhaseSnapshot {
  name: string;
  duration_sec: number;
  sample_count: number;
}
interface PhaseRecorderState {
  active: boolean;
  label: string;
  current_phase: string;
  current_phase_label: string;
  current_phase_color: string;
  current_phase_instruction: string;
  phase_elapsed: number;
  phase_duration: number;
  phase_progress: number;
  total_elapsed: number;
  total_duration: number;
  total_progress: number;
  phases: PhaseSnapshot[];
  saved_path: string | null;
}
interface PhaseRecordingSummary {
  label: string;
  path: string | null;
  file_id: string | null;
  total_duration: number;
  n_samples: number;
  quality_score: number;
  phases: PhaseSnapshot[];
}

const PHASE_ORDER = ['baseline', 'exposure', 'recovery'];
const PHASE_LABELS: Record<string, string> = { baseline: 'Before', exposure: 'During', recovery: 'After' };
const PHASE_COLORS: Record<string, string> = { baseline: '#1a1a17', exposure: '#e11d48', recovery: '#0e7490' };

function phaseLabelOf(name: string): string { return PHASE_LABELS[name] ?? name; }
function phaseColorOf(name: string): string { return PHASE_COLORS[name] ?? '#888'; }
function phaseIdx(name: string): number {
  const i = PHASE_ORDER.indexOf(name);
  return i === -1 ? 99 : i;
}
function fmtDur(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
}

function buildPhaseBars(
  containerId: string,
  phases: PhaseSnapshot[],
  current: string,
  curProgress: number,
) {
  const box = document.getElementById(containerId)!;
  box.innerHTML = phases.map(p => {
    let width = '0%';
    if (p.name === current) width = `${(curProgress * 100).toFixed(0)}%`;
    else if (phaseIdx(p.name) < phaseIdx(current)) width = '100%';
    return `<div class="phase-bar">
      <span class="p-name" style="color:${phaseColorOf(p.name)}">${phaseLabelOf(p.name)}</span>
      <div class="p-track"><div class="p-fill" style="background:${phaseColorOf(p.name)};width:${width}"></div></div>
      <span class="p-count">${p.sample_count}</span>
    </div>`;
  }).join('');
}

function renderPhaseState(s: PhaseRecorderState) {
  const hud = document.getElementById('phaseHud')!;
  hud.style.display = s.active ? '' : 'none';
  if (!s.active) return;
  document.getElementById('phasePhase')!.textContent = s.current_phase_label;
  document.getElementById('phaseSub')!.textContent = s.label;
  document.getElementById('phaseInstr')!.textContent = s.current_phase_instruction;
  document.getElementById('phaseTotal')!.textContent =
    `${fmtDur(s.total_elapsed)} / ${fmtDur(s.total_duration)}`;
  buildPhaseBars('phaseBars', s.phases, s.current_phase, s.phase_progress);

  document.getElementById('recLabel')!.textContent = s.label;
  document.getElementById('recInstr')!.textContent =
    `${s.current_phase_label}: ${s.current_phase_instruction}`;
  document.getElementById('recTotal')!.textContent =
    `${fmtDur(s.total_elapsed)} / ${fmtDur(s.total_duration)}`;
  const total = s.phases.reduce((a, p) => a + p.sample_count, 0);
  document.getElementById('recSamples')!.textContent = `${total} samples`;
  buildPhaseBars('recBars', s.phases, s.current_phase, s.phase_progress);
}

function openRecordModal() {
  document.getElementById('recSetup')!.style.display = '';
  document.getElementById('recLive')!.style.display = 'none';
  document.getElementById('recordModal')!.style.display = 'flex';
  (document.getElementById('recSubstance') as HTMLInputElement).focus();
}
function closeRecordModal() {
  document.getElementById('recordModal')!.style.display = 'none';
}

function addPhaseToLibrary(summary: PhaseRecordingSummary) {
  if (!summary.path || !summary.file_id) return;
  sessions.unshift({
    id: `s-${summary.file_id}`,
    time: new Date().toLocaleString(),
    substance: summary.label === 'unknown' ? 'Unknown' : summary.label,
    label: 'Recorded',
    format: 'OSMELL',
    duration: `${Math.floor(summary.total_duration)}s`,
    sensors: summary.phases.length > 0 ? chNames.length : 0,
    quality: summary.quality_score,
    path: summary.path,
    file_id: summary.file_id,
  });
  renderLibrary();
}

async function stopPhaseRecordingFromUI() {
  try {
    const summary = await invoke<PhaseRecordingSummary>('stop_phase_recording');
    addPhaseToLibrary(summary);
  } catch (e) {
    console.error('Stop phase recording failed:', e);
  }
  recPhaseActive = false;
  sessionStart = null;
  setRecordButton(false);
  closeRecordModal();
}

// Sync both record controls (header + graph-proximate) to the recording state.
function setRecordButton(active: boolean) {
  const header = document.getElementById('recordBtn');
  const near = document.getElementById('liveRecord');
  const label = active ? '■ Stop' : '● Rec';
  if (header) header.textContent = active ? '■ Stop' : '● Record';
  if (near) {
    near.textContent = label;
    near.classList.toggle('recording', active);
    near.title = active ? 'Stop recording' : 'Start a recording session';
  }
}

async function pollPhaseRecorder() {
  try {
    const s = await invoke<PhaseRecorderState>('get_phase_recorder_state');
    renderPhaseState(s);
    setRecordButton(s.active);
    if (!s.active && prevPhaseActive && !autoFinalized) {
      autoFinalized = true;
      await stopPhaseRecordingFromUI();
    }
    prevPhaseActive = s.active;
  } catch (e) {
    console.error('Phase recorder poll error:', e);
  }
}

let recPhaseActive = false;
let prevPhaseActive = false;
let autoFinalized = false;

// A recording is only meaningful if a device is actually streaming data. This
// returns true when we're connected AND fresh readings are arriving (same
// 3 s threshold as the LIVE LINK / NO DATA indicator). Refuses to record into
// an empty session when nothing is connected.
function isStreamingActive(): boolean {
  return connected && Date.now() - lastDataAt <= 3000;
}

// Show an inline toast (auto-hides). Falls back to window.alert if the toast
// container is missing so messages are never silently swallowed.
function showToast(msg: string, ms = 3500): void {
  const toast = document.getElementById('toast') ?? document.getElementById('toastHost');
  if (toast) {
    const el = document.getElementById('toastMsg');
    if (el) el.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), ms);
  } else {
    window.alert(msg);
  }
}

function alertNotStreaming(): void {
  showToast('Nothing is streaming — connect your e-nose first (header Connect).');
}

// Record button
document.getElementById('recordBtn')!.addEventListener('click', async () => {
  if (recPhaseActive || prevPhaseActive) {
    stopPhaseRecordingFromUI();
  } else {
    if (!isStreamingActive()) {
      alertNotStreaming();
      return;
    }
    openRecordModal();
  }
});
// Graph-proximate record control (next to the live trace transport).
(document.getElementById('liveRecord') as HTMLButtonElement | null)?.addEventListener('click', async () => {
  if (recPhaseActive || prevPhaseActive) {
    stopPhaseRecordingFromUI();
  } else {
    if (!isStreamingActive()) {
      alertNotStreaming();
      return;
    }
    openRecordModal();
  }
});

document.getElementById('recModalClose')!.addEventListener('click', closeRecordModal);

// Live protocol summary chips (Baseline → Exposure → Recovery) in the modal.
function updateProtocolSeq() {
  const set = (outId: string, inputId: string) => {
    const el = document.getElementById(outId);
    const inp = document.getElementById(inputId) as HTMLInputElement | null;
    if (el && inp) el.textContent = (inp.value || '0') + 's';
  };
  set('psBaseline', 'recBaseline');
  set('psExposure', 'recExposure');
  set('psRecovery', 'recRecovery');
}
['recBaseline', 'recExposure', 'recRecovery'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', updateProtocolSeq);
});

 document.getElementById('recStart')!.addEventListener('click', async () => {
   const substance = (document.getElementById('recSubstance') as HTMLInputElement).value.trim();
   if (!substance) {
     (document.getElementById('recSubstance') as HTMLInputElement).focus();
     return;
   }
   if (!isStreamingActive()) {
     alertNotStreaming();
     return;
   }
   const num = (id: string, fallback: number) => {
    const v = parseFloat((document.getElementById(id) as HTMLInputElement).value);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  const baseline = num('recBaseline', 30);
  const exposure = num('recExposure', 60);
  const recovery = num('recRecovery', 30);
  try {
    const state = await invoke<PhaseRecorderState>('start_phase_recording', {
      substance,
      baselineSec: baseline,
      exposureSec: exposure,
      recoverySec: recovery,
      presetName: activePreset,
      channelNames: chNames,
    });
    recPhaseActive = true;
    prevPhaseActive = true;
    autoFinalized = false;
    sessionStart = Date.now() / 1000;
    setRecordButton(true);
    document.getElementById('recSetup')!.style.display = 'none';
    document.getElementById('recLive')!.style.display = '';
    renderPhaseState(state);
  } catch (e) {
    console.error('Start phase recording failed:', e);
  }
});

document.getElementById('recStop')!.addEventListener('click', async () => {
  document.getElementById('recStop')!.textContent = 'Saving...';
  stopPhaseRecordingFromUI();
});

document.getElementById('recCancel')!.addEventListener('click', async () => {
  try {
    await invoke('cancel_phase_recording');
  } catch (e) {
    console.error('Cancel phase recording failed:', e);
  }
  recPhaseActive = false;
  prevPhaseActive = false;
  sessionStart = null;
  document.getElementById('recordBtn')!.textContent = '● Record';
  closeRecordModal();
});

// System sub-nav interactions

interface BurnInStatus {
  total_hours: number;
  elapsed_seconds: number;
  remaining_seconds: number;
  remaining_hours: number;
  is_complete: boolean;
  running: boolean;
}

function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
}

function renderBurnIn(s: BurnInStatus) {
  document.getElementById('burninTime')!.textContent = fmtClock(s.remaining_seconds);
  const total = s.total_hours * 3600;
  const pct = total > 0 ? Math.min(100, (s.elapsed_seconds / total) * 100) : 0;
  document.getElementById('burninBar')!.style.width = `${pct.toFixed(1)}%`;
  const startBtn = document.getElementById('burninStart') as HTMLButtonElement | null;
  const statusEl = document.getElementById('burninStatus');
  if (startBtn) startBtn.textContent = s.running && !s.is_complete ? 'Stop' : 'Start';
  if (statusEl) {
    const label = s.is_complete
      ? 'Complete'
      : s.running
        ? 'Running — countdown active'
        : s.elapsed_seconds > 0
          ? 'Paused'
          : 'Not started';
    statusEl.textContent = label;
  }
}

async function refreshBurnIn() {
  try {
    const s = await invoke<BurnInStatus>('burnin_get_status');
    renderBurnIn(s);
  } catch {}
}

document.getElementById('burninStart')!.addEventListener('click', async () => {
  try {
    const hours = parseFloat((document.getElementById('burninHours') as HTMLInputElement).value) || undefined;
    const s = await invoke<BurnInStatus>('burnin_start', { hours });
    renderBurnIn(s);
  } catch (e) {
    console.error('Burn-in start failed:', e);
  }
});

document.getElementById('burninReset')!.addEventListener('click', async () => {
  const hrs = parseFloat((document.getElementById('burninHours') as HTMLInputElement).value) || 24;
  try {
    const s = await invoke<BurnInStatus>('burnin_reset', { hours: hrs });
    renderBurnIn(s);
  } catch (e) {
    console.error('Burn-in reset failed:', e);
  }
});


interface PluginInfo {
  name: string;
  path: string;
  description: string;
  version: string;
  kind: string;
  size_bytes: number;
  loaded: boolean;
  error: string;
}

document.getElementById('pluginRefresh')!.addEventListener('click', refreshPlugins);

async function refreshPlugins() {
  try {
    const [plugins, dir] = await Promise.all([
      invoke<PluginInfo[]>('discover_plugins'),
      invoke<string>('get_plugins_dir'),
    ]);
    const list = document.getElementById('pluginList')!;
    if (!plugins.length) {
      list.textContent = 'No plugins loaded';
      list.style.color = 'var(--text-3)';
      return;
    }
    list.style.color = 'var(--text-2)';
    list.innerHTML = plugins
      .map((p) => {
        const size = p.size_bytes >= 1024 * 1024 ? `${(p.size_bytes / 1048576).toFixed(1)} MB` : `${Math.round(p.size_bytes / 1024)} KB`;
        const state = p.loaded ? '<span style="color:#1a1a17">&#9679;</span> loaded' : `<span style="color:#e11d48">&#9679;</span> ${p.error || 'stub'}`;
        return `<div style="padding:4px 0;border-bottom:1px solid var(--border)"><strong>${p.name}</strong> <span style="color:var(--text-3)">v${p.version || '?'} · ${p.kind} · ${size}</span><br/><span style="color:var(--text-3)">${p.description || ''}</span> &nbsp; ${state}</div>`;
      })
      .join('');
    const hint = document.querySelector('#sys-plugins p')!;
    hint.textContent = `Plugin folder: ${dir}`;
  } catch {
    document.getElementById('pluginList')!.textContent = 'Plugin discovery failed';
  }
}

document.getElementById('sysRefreshPorts')!.addEventListener('click', refreshPorts);
document.getElementById('flashBtn')!.addEventListener('click', async () => {
  const port = (document.getElementById('portSelect') as HTMLSelectElement).value;
  if (!port) return;
  const wifiSsid = (document.getElementById('fwSsid') as HTMLInputElement).value.trim();
  const wifiPassword = (document.getElementById('fwPass') as HTMLInputElement).value;
  const fp = document.getElementById('flashProgress')!;
  fp.style.display = '';
  fp.classList.add('flashing');
  document.getElementById('flashStatus')!.textContent = 'Flashing...';
  document.getElementById('flashBar')!.style.width = '30%';
  try {
    await invoke('flash_firmware', { port, preset: activePreset, nChannels: presetChannelCount(activePreset), sensorPins: [], wifiSsid, wifiPassword });
    document.getElementById('flashBar')!.style.width = '100%';
    document.getElementById('flashStatus')!.textContent = 'Complete — mDNS: osmograph.local (service _osmograph._tcp)';
  } catch (e) {
    document.getElementById('flashBar')!.style.width = '0%';
    document.getElementById('flashStatus')!.textContent = `Failed: ${e}`;
  } finally {
    fp.classList.remove('flashing');
  }
});

async function refreshToolchain() {
  try {
    const tc = await invoke<ToolchainInfo>('check_flash_toolchain');
    const el = document.getElementById('fwToolchain');
    const s = toolchainSummary(tc);
    if (el) { el.textContent = s.text; el.title = tc.message; }
    setFlight('pfTc', s.flight, s.kind);
  } catch {
    const el = document.getElementById('fwToolchain');
    if (el) el.textContent = 'tool check failed';
    setFlight('pfTc', 'TOOLS UNKNOWN', 'warn');
  }
}

document.getElementById('readMacBtn')!.addEventListener('click', async () => {
  const port = (document.getElementById('portSelect') as HTMLSelectElement).value;
  if (!port) { document.getElementById('fwMac')!.textContent = 'Select a port first'; return; }
  document.getElementById('fwMac')!.textContent = 'Reading…';
  try {
    const mac = await invoke<string>('read_mac', { port });
    document.getElementById('fwMac')!.textContent = mac;
  } catch (e) {
    document.getElementById('fwMac')!.textContent = `Failed: ${e}`;
  }
});

document.getElementById('eraseBtn')!.addEventListener('click', async () => {
  const port = (document.getElementById('portSelect') as HTMLSelectElement).value;
  if (!port) { document.getElementById('flashStatus')!.textContent = 'Select a port first'; return; }
  const ok = confirm('Erase the entire flash on ' + port + '? This is irreversible.');
  if (!ok) return;
  document.getElementById('flashStatus')!.textContent = 'Erasing…';
  document.getElementById('flashBar')!.style.width = '50%';
  try {
    const msg = await invoke<string>('erase_flash', { port });
    document.getElementById('flashBar')!.style.width = '100%';
    document.getElementById('flashStatus')!.textContent = msg;
  } catch (e) {
    document.getElementById('flashBar')!.style.width = '0%';
    document.getElementById('flashStatus')!.textContent = `Failed: ${e}`;
  }
});

// === Flash modal — one-click firmware programming (Python-app parity) ===
// The header ⚡ Flash button and the bootloader-stall diagnosis both open this;
// it drives the same `flash_firmware` backend as the System tab.
let fmTimer: number | null = null;

// Live wiring preview: shows, in plain words, exactly which firmware gets built
// for the preset currently selected in the dialog — channel count, sensor
// names, and the GPIO pins the backend will assign. Mirrors `presetPins` and
// the Rust `sensor_pins_for`, so the preview shows the *real* firmware pins.
function renderFmWiring() {
  const el = document.getElementById('fmWiring');
  const preset = (document.getElementById('fmPreset') as HTMLSelectElement).value;
  if (!el || !preset) { if (el) el.textContent = '—'; return; }
  const count = presetChannelCount(preset);
  const sensors = (isCustomPreset(preset)
    ? customPresets.find(p => p.id === preset)?.sensors
    : PRESETS[preset]?.sensors) || [];
  const pins = presetPins(count);
  if (count < 1 || pins.length === 0) {
    el.innerHTML = '<b>WIRING</b> · pick a rig preset above';
    return;
  }
  const names = Array.from({ length: count }, (_, i) => sensors[i] || `CH${i + 1}`);
  el.innerHTML = `<b>WIRING</b> · ${count} CH → GPIO ${pins.join('/')}<br><span style="opacity:.75">${names.join(' · ')}</span>`;
}

// Fill the modal's rig-preset dropdown with the built-in presets plus any
// user-saved custom rigs. Keeps the current selection when it still exists.
function populateFmPresets() {
  loadCustomPresets();
  const sel = document.getElementById('fmPreset') as HTMLSelectElement;
  if (!sel) return;
  // Default to the rig the panel is showing when the dialog first opens, so
  // the wiring preview and the flashed firmware always agree out of the box.
  // The panel starts in auto-detect mode (not a buildable preset), so fall back
  // to the flagship 6-sensor rig until the panel has a concrete preset to carry.
  const prev = sel.value || (activePreset === 'auto' ? '6-sensor-full' : activePreset);
  const builtIns = Object.keys(PRESETS).map(id => `<option value="${id}">${PRESETS[id].name}</option>`);
  const customs = customPresets.map(p => `<option value="${p.id}">${p.name} (custom, ${p.n_channels} ch)</option>`);
  sel.innerHTML = builtIns.join('') + customs.join('');
  if (prev && Array.from(sel.options).some(o => o.value === prev)) sel.value = prev;
  renderFmWiring();
}

function openFlashModal() {
  const modal = document.getElementById('flashModal');
  if (!modal) return;
  resetFmState();
  populateFmPresets();
  populateFmPort().then(() => {
    // Port-not-required nicety: if we already know which board we're talking to
    // (connected or remembered), prefill it so the user doesn't have to re-pick.
    const sel = document.getElementById('fmPort') as HTMLSelectElement;
    const cur = document.getElementById('portSelect') as HTMLSelectElement | null;
    if (cur?.value && sel) { if (Array.from(sel.options).some(o => o.value === cur.value)) sel.value = cur.value; }
  });
  const presetSelect = document.getElementById('fmPreset') as HTMLSelectElement;
  if (presetSelect && activePreset && (PRESETS[activePreset] || isCustomPreset(activePreset))) presetSelect.value = activePreset;
  const ssid = document.getElementById('fwSsid') as HTMLInputElement | null;
  if (ssid && ssid.value) {
    (document.getElementById('fmSsid') as HTMLInputElement).value = ssid.value;
  }
  const pass = document.getElementById('fwPass') as HTMLInputElement | null;
  if (pass && pass.value) {
    (document.getElementById('fmPass') as HTMLInputElement).value = pass.value;
  }
  renderFmWiring();
  void checkFmToolchain();
  modal.style.display = 'flex';
  setTimeout(() => (document.getElementById('fmPort') as HTMLSelectElement)?.focus(), 50);
}

function closeFlashModal() {
  if (fmTimer !== null) { clearInterval(fmTimer); fmTimer = null; }
  const modal = document.getElementById('flashModal');
  if (modal) modal.style.display = 'none';
}

// Reset progress/status/button to a clean, ready state (used on open and after
// any flash attempt so a stale/closed run never leaks into the next one).
function resetFmState() {
  if (fmTimer !== null) { clearInterval(fmTimer); fmTimer = null; }
  const progress = document.getElementById('fmProgress') as HTMLDivElement;
  const bar = document.getElementById('fmBar') as HTMLDivElement;
  const status = document.getElementById('fmStatus') as HTMLDivElement;
  const btn = document.getElementById('fmFlash') as HTMLButtonElement;
  if (progress) progress.style.display = 'none';
  if (bar) { bar.style.width = '0%'; bar.classList.remove('busy'); }
  if (status) { status.textContent = ''; status.style.color = ''; }
  if (btn) { btn.disabled = false; btn.textContent = 'Flash Firmware'; }
}

// Visible busy state while flashing. Uses an indeterminate pulse rather than a
// fake percentage we can't actually measure — honest and non-toy.
function setFmBusy(busy: boolean) {
  const progress = document.getElementById('fmProgress') as HTMLDivElement;
  const bar = document.getElementById('fmBar') as HTMLDivElement;
  const btn = document.getElementById('fmFlash') as HTMLButtonElement;
  if (progress) {
    progress.style.display = busy ? '' : 'none';
    progress.classList.toggle('flashing', busy);
  }
  if (bar) bar.classList.toggle('busy', busy);
  if (btn) { btn.disabled = busy; btn.textContent = busy ? 'Flashing…' : 'Flash Firmware'; }
}

async function populateFmPort() {
  const sel = document.getElementById('fmPort') as HTMLSelectElement;
  if (!sel) return;
  const cur = document.getElementById('portSelect') as HTMLSelectElement | null;
  const opts = cur ? Array.from(cur.options).map(o => o.value).filter(Boolean) : [];
  if (opts.length) {
    sel.innerHTML = '<option value="">Select port...</option>' + opts.map(o => `<option value="${o}">${o}</option>`).join('');
    sel.value = cur!.value || (opts.length === 1 ? opts[0] : '');
  } else {
    try {
      const ports = await invoke<{ name: string; description: string }[]>('list_serial_ports');
      const real = ports.filter(p => p.name);
      sel.innerHTML = '<option value="">Select port...</option>' + real.map(p => `<option value="${p.name}">${p.name} — ${p.description || ''}</option>`).join('');
      if (real.length === 1) sel.value = real[0].name;
    } catch { /* flow through */ }
  }
}

interface ToolchainInfo { platformio: boolean; arduino_cli: boolean; esptool: boolean; message: string }

// Plain-language summary of the flash toolchain state, keyed off the same flags
// the Rust side reports. The raw `message` stays available as a tooltip detail;
// the visible copy avoids jargon ("PlatformIO", "arduino-cli") for anyone who
// just wants to know "can I flash or not". Honest: a build needs a compiler
// (PlatformIO or Arduino CLI); esptool alone can wipe/read, not rebuild.
function toolchainSummary(tc: ToolchainInfo): { text: string; flight: string; kind: 'ok' | 'warn'; color: string } {
  if (tc.platformio || tc.arduino_cli) {
    return { text: 'Ready — build and upload tools installed.', flight: 'TOOLS READY', kind: 'ok', color: 'var(--green)' };
  }
  if (tc.esptool) {
    return { text: 'Upload tool found, but no compiler — install Arduino IDE or PlatformIO to flash.', flight: 'TOOLS PARTIAL', kind: 'warn', color: 'var(--yellow)' };
  }
  return { text: 'No Arduino tools found — install Arduino IDE or PlatformIO, then retry.', flight: 'TOOLS MISSING', kind: 'warn', color: 'var(--red)' };
}

async function checkFmToolchain() {
  const el = document.getElementById('fmToolchain');
  if (!el) return;
  try {
    const tc = await invoke<ToolchainInfo>('check_flash_toolchain');
    const s = toolchainSummary(tc);
    el.textContent = s.text;
    el.style.color = s.color;
    el.title = tc.message;
  } catch (e) {
    el.textContent = 'Tool check failed: ' + e;
    el.style.color = 'var(--red)';
  }
}

document.getElementById('flashQuick')?.addEventListener('click', () => openFlashModal());
document.getElementById('fmClose')?.addEventListener('click', closeFlashModal);
// Keep the dialog and the Firmware panel in agreement: choosing a rig preset in
// the dialog updates the wiring preview and the panel's Rig Preset label, and
// edits to the WiFi fields echo straight back to the System tab's fields. The
// reverse copy happens in `openFlashModal`, so the two never drift apart.
document.getElementById('fmPreset')?.addEventListener('change', () => {
  renderFmWiring();
  const preset = (document.getElementById('fmPreset') as HTMLSelectElement).value;
  if (preset && (PRESETS[preset] || isCustomPreset(preset))) {
    activePreset = preset;
    renderRigSchematic();
  }
});
document.getElementById('fmSsid')?.addEventListener('input', () => {
  const t = document.getElementById('fwSsid') as HTMLInputElement | null;
  if (t) t.value = (document.getElementById('fmSsid') as HTMLInputElement).value;
});
document.getElementById('fmPass')?.addEventListener('input', () => {
  const t = document.getElementById('fwPass') as HTMLInputElement | null;
  if (t) t.value = (document.getElementById('fmPass') as HTMLInputElement).value;
});
// Close on backdrop click and Escape (same pattern as other modals); never let
// a stray key while typing in a field close it.
document.getElementById('flashModal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeFlashModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const fm = document.getElementById('flashModal');
    if (fm && fm.style.display !== 'none') { closeFlashModal(); e.preventDefault(); }
  }
});

document.getElementById('fmFlash')?.addEventListener('click', async () => {
  const port = (document.getElementById('fmPort') as HTMLSelectElement).value;
  const preset = (document.getElementById('fmPreset') as HTMLSelectElement).value;
  const wifiSsid = (document.getElementById('fmSsid') as HTMLInputElement).value.trim();
  const wifiPassword = (document.getElementById('fmPass') as HTMLInputElement).value;
  const status = document.getElementById('fmStatus') as HTMLDivElement;
  if (!port) { status.textContent = 'Pick a port first.'; status.style.color = 'var(--yellow)'; return; }
  resetFmState();
  setFmBusy(true);
  status.textContent = 'Building & flashing… this can take ~30 s.';
  status.style.color = '';
  try {
    const done = await invoke<string>('flash_firmware', { port, preset, nChannels: presetChannelCount(preset), sensorPins: [], wifiSsid, wifiPassword });
    setFmBusy(false);
    status.textContent = done || 'Complete — mDNS: osmograph.local (_osmograph._tcp)';
    status.style.color = 'var(--green)';
    setTimeout(closeFlashModal, 900);
  } catch (e) {
    setFmBusy(false);
    status.textContent = `Failed: ${e}`;
    status.style.color = 'var(--red)';
  }
});

// === Custom Rig Presets (System → Firmware) ===
function renderCustomPresetList() {
  loadCustomPresets();
  const el = document.getElementById('cpList');
  if (!el) return;
  if (!customPresets.length) { el.innerHTML = '<span style="font-size:11px;color:var(--text-3)">No custom presets saved yet.</span>'; return; }
  el.innerHTML = customPresets.map(p => {
    const periphs = p.peripherals && (p.peripherals.oledEnabled || p.peripherals.buzzerEnabled)
      ? ` <span style="color:var(--text-3);font-size:10px">· ${[p.peripherals.oledEnabled ? 'OLED' : '', p.peripherals.buzzerEnabled ? 'BZR' : ''].filter(Boolean).join('+')}</span>`
      : '';
    return `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border)">
       <span style="flex:1;font-size:12px" title="${(p.sensors || []).join(', ')}">
         <strong>${p.name}</strong> <span style="color:var(--text-3)">· ${p.n_channels} ch · ${(p.sensors || []).join(', ')}</span>${periphs}
       </span>
       <button data-cp-use="${p.id}" style="font-size:11px;padding:2px 8px">Use</button>
       <button data-cp-del="${p.id}" style="font-size:11px;padding:2px 8px;color:var(--red)">✕</button>
     </div>`;
  }).join('');
}

function applyCustomPreset(p: CustomPreset) {
  activePreset = p.id;
  chNames = (p.sensors && p.sensors.length ? p.sensors : Array.from({ length: p.n_channels }, (_, i) => `CH${i + 1}`));
  setChannelCount(chNames.length, chNames);
  if (p.peripherals) {
    peripheralState.oledEnabled = p.peripherals.oledEnabled;
    peripheralState.buzzerEnabled = p.peripherals.buzzerEnabled;
    persistPeripheralState();
    syncPeripheralUI();
  }
}

// Live GPIO-pin hint for the channel-count input, so the auto-assigned analog
// pins are visible before the user saves a custom rig preset.
function updateCpPinsHint() {
  const countEl = document.getElementById('cpCount') as HTMLInputElement;
  const hint = document.getElementById('cpPinsHint');
  if (!countEl || !hint) return;
  const n = Math.max(1, Math.min(12, Number(countEl.value) || 6));
  hint.textContent = 'auto-assigns GPIO ' + presetPins(n).join(', ');
}
document.getElementById('cpCount')?.addEventListener('input', updateCpPinsHint);
void Promise.resolve().then(updateCpPinsHint);

document.getElementById('cpSave')?.addEventListener('click', () => {
  const name = (document.getElementById('cpName') as HTMLInputElement).value.trim();
  const countEl = document.getElementById('cpCount') as HTMLInputElement;
  const count = Math.max(1, Math.min(12, Number(countEl.value) || 6));
  const sensorsRaw = (document.getElementById('cpSensors') as HTMLInputElement).value.trim();
  const sensors = sensorsRaw ? sensorsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  if (!name) { flashStatus('libStatus', 'Give the preset a name first.', 'var(--yellow)'); return; }
  const id = 'custom:' + Date.now().toString(36);
  customPresets.push({ id, name, n_channels: count, sensors, peripherals: { oledEnabled: peripheralState.oledEnabled, buzzerEnabled: peripheralState.buzzerEnabled } });
  persistCustomPresets();
  renderCustomPresetList();
  activePreset = id;
  chNames = (sensors.length ? sensors : Array.from({ length: count }, (_, i) => `CH${i + 1}`));
  setChannelCount(chNames.length, chNames);
  flashStatus('libStatus', `Saved custom preset "${name}" (${count} ch).`, 'var(--green)');
});

document.getElementById('cpList')?.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const use = t.getAttribute('data-cp-use');
  const del = t.getAttribute('data-cp-del');
  if (use) {
    const p = customPresets.find(x => x.id === use);
    if (p) { applyCustomPreset(p); flashStatus('libStatus', `Applied preset "${p.name}" (${p.n_channels} ch).`, 'var(--green)'); }
  } else if (del) {
    customPresets = customPresets.filter(x => x.id !== del);
    persistCustomPresets();
    renderCustomPresetList();
    flashStatus('libStatus', 'Custom preset removed.', 'var(--green)');
  }
});

void Promise.resolve().then(() => renderCustomPresetList());

// === Tauri Serial Data Event ===
listen<{ channels: number[]; timestamp: number; raw_line: string }>('serial-data', (event) => {
  const { channels } = event.payload;
  if (channels.length > 0) ingestReading(channels);
});

listen<{ device_id: string; firmware_version: string; n_sensors: number }>('serial-info', (event) => {
  const { device_id, firmware_version, n_sensors } = event.payload;
  console.log(`Device: ${device_id} v${firmware_version} (${n_sensors} sensors)`);
  applyDetectedChannels(n_sensors, 'info');
});

// Rust auto-detected the channel width from the live stream (any Arduino /
// third-party board that dumps N numeric CSV columns).
listen<{ n_channels: number; source: string }>('serial-auto', (event) => {
  applyDetectedChannels(event.payload.n_channels, event.payload.source);
});

// OSMK — the device declared each streamed column's semantic kind (MQ / MEMS /
// env / fan). Rust already falls back to analog_mox for unknown tokens; here the
// real kind name or a name-based inference decides, then the legend/units refresh.
listen<{ kinds: string[] }>('serial-kinds', (event) => {
  applyChannelKinds(event.payload.kinds);
  buildLegend();
});

// ENV — device-reported ambient telemetry (°C / %RH). Purely informational.
listen<{ temperature: number; humidity: number }>('serial-env', (event) => {
  renderEnvReadout(event.payload);
});

listen<{ code: number; message: string }>('serial-error', (event) => {
  console.error(`Serial error ${event.payload.code}: ${event.payload.message}`);
  const cm = document.getElementById('connMsg');
  if (cm) {
    cm.textContent = `Serial error ${event.payload.code}: ${event.payload.message}`;
    cm.style.color = 'var(--red)';
  }
});

function dropLink(reason: string) {
  connected = false;
  bootloaderHinted = false;
  autoChannels = 0;
  channelKinds = [];
  renderEnvReadout(null);
  bootFlashShown = false;
  updateRigNote();
  document.getElementById('bootBanner')?.classList.remove('show');
  document.getElementById('connectBtn')!.textContent = 'Connect';
  document.getElementById('statusDot')!.className = 'status-dot';
  setPlotLink(false);
  const cm = document.getElementById('connMsg');
  if (cm) {
    cm.textContent = reason;
    cm.style.color = 'var(--yellow)';
  }
}

listen('serial-disconnected', () => {
  dropLink('Device disconnected — replug or reselect the port and reconnect.');
});

listen('wifi-disconnected', () => {
  dropLink('WiFi device disconnected from the network.');
});

// === BLE Events ===
listen<string>('ble-connected', (event) => {
  document.getElementById('fDevice')!.textContent = event.payload;
});

listen('ble-disconnected', () => {
  dropLink('BLE device disconnected.');
});

// A device answering in bootloader streams nothing, so the graph looks "dead"
// while it's really unflashed. Surface the diagnosis and offer the flash path
// instead of leaving the user guessing why the traces stopped moving.
listen<string>('bootloader-detected', () => {
  bootloaderHinted = true;
  const st = document.getElementById('statusDot');
  if (st) st.className = 'status-dot warn';
  updatePlotLinkState();
});

document.getElementById('bootDismiss')?.addEventListener('click', () => {
  bootloaderHinted = false;
  document.getElementById('bootBanner')?.classList.remove('show');
});

document.getElementById('bootToFlash')?.addEventListener('click', () => {
  document.getElementById('bootBanner')?.classList.remove('show');
  const tab = document.querySelector<HTMLElement>('.tab-btn[data-tab="system"]');
  tab?.click();
  const port = (document.getElementById('portSelect') as HTMLSelectElement).value;
  const fwPort = document.getElementById('fwPort');
  if (fwPort) fwPort.textContent = port || 'No port selected';
  document.getElementById('flashBtn')?.focus();
});

listen<string>('ble-error', (event) => {
  console.error('BLE error:', event.payload);
});

// === Live Classification Event ===
listen<LiveSnapshot>('live-classification', (event) => {
  liveSnapshot = event.payload;
  renderLiveState();
});

// === Session Replay (offline inspection) ===
const replayCanvas = document.getElementById('replayCanvas') as HTMLCanvasElement | null;
const replayCtx = replayCanvas?.getContext('2d') || null;
let replaySeries: SessionSeries | null = null;
let replayFrame = 0;
let replayPlaying = false;
let replayLastTs: number | null = null;

function fmtRecTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
}

function replayCurrentSample(): number[] | null {
  if (!replaySeries) return null;
  const idx = Math.max(0, Math.min(replayFrame - 1, (replaySeries.time.length || 1) - 1));
  const chans = replaySeries.channels.length;
  const sample: number[] = [];
  for (let ch = 0; ch < chans; ch++) {
    sample.push(replaySeries.values[ch]?.[idx] ?? 0);
  }
  return sample;
}

function replayReflectOnDashboard() {
  const sample = replayCurrentSample();
  if (sample) drawFingerprint(sample);
  document.getElementById('replayNote')!.textContent =
    `Replaying "${replaySeries?.label}" — ${replaySeries?.time.length ?? 0} samples · ${replaySeries?.channels.length ?? 0} channels. Inspection only (fingerprint reflects the replayed moment; not fed to the detector/classifier).`;
}

function populateReplaySelect() {
  const sel = document.getElementById('replaySession') as HTMLSelectElement;
  if (!sel) return;
  const cur = sel.value;
  const withFid = sessions.filter(s => s.file_id);
  sel.innerHTML = '<option value="">Select a session...</option>' +
    withFid
      .map(s => `<option value="${s.file_id}">${s.substance} · ${s.time}</option>`)
      .join('');
  sel.value = cur || (withFid[0]?.file_id ?? '');
}

function openReplayPanel() {
  populateReplaySelect();
  document.getElementById('replayPanel')!.style.display = '';
}

function closeReplayPanel() {
  replayPlaying = false;
  document.getElementById('replayPanel')!.style.display = 'none';
  const btn = document.getElementById('replayPlay');
  if (btn) btn.textContent = '▶ Play';
}

async function loadReplay() {
  const sel = document.getElementById('replaySession') as HTMLSelectElement;
  const note = document.getElementById('replayNote');
  if (!sel) return;
  const fid = sel.value;
  if (!fid) {
    replayPlaying = false;
    const btn = document.getElementById('replayPlay');
    if (btn) btn.textContent = '▶ Play';
    if (note) note.textContent = sessions.length === 0
      ? 'Nothing to replay yet — import a recording in the Library tab (or record one live), then it will appear here.'
      : 'No session selected — pick one from the list above, then Load again.';
    return;
  }
  try {
    replaySeries = await invoke<SessionSeries>('load_session_series', { fileId: fid });
    replayFrame = 0;
    replayLastTs = null;
    if (replaySeries.time.length) {
      const dur = replaySeries.time[replaySeries.time.length - 1];
      const scrb = document.getElementById('replayScrub') as HTMLInputElement;
      if (scrb) { scrb.max = '1000'; scrb.value = '0'; }
      document.getElementById('replayTime')!.textContent = `00:00 / ${fmtRecTime(dur)}`;
    }
    replayReflectOnDashboard();
    replayPlaying = false;
    const btn = document.getElementById('replayPlay');
    if (btn) btn.textContent = '▶ Play';
  } catch (e) {
    document.getElementById('replayNote')!.textContent = `Failed to load session: ${e}`;
  }
}

function drawReplay() {
  if (!replayCtx || !replayCanvas) return;
  const parent = replayCanvas.parentElement!;
  const rect = parent.getBoundingClientRect();
  replayCanvas.width = Math.max(1, Math.floor(rect.width - 4));
  replayCanvas.height = Math.max(1, Math.floor(rect.height - 4));
  const w = replayCanvas.width, h = replayCanvas.height;
  const ctx = replayCtx;
  ctx.fillStyle = '#f6f1e7';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = '#ece4d4';
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) {
    const y = (h / 5) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  if (!replaySeries) {
    ctx.fillStyle = '#8a8a91';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Pick a session and press Load to replay', w / 2, h / 2);
    return;
  }

  const chans = replaySeries.channels;
  const nCh = chans.length;
  const nSamples = replaySeries.time.length;
  const limit = Math.max(1, Math.min(replayFrame, nSamples));

  let gMin = Infinity, gMax = -Infinity;
  for (let ch = 0; ch < nCh; ch++) {
    const vals = replaySeries.values[ch] || [];
    for (let i = 0; i <= limit && i < vals.length; i++) {
      const v = vals[i];
      if (Number.isFinite(v)) { if (v < gMin) gMin = v; if (v > gMax) gMax = v; }
    }
  }
  if (gMin === Infinity) return;
  const range = gMax - gMin || 1;
  gMin -= range * 0.1; gMax += range * 0.1;
  const span = gMax - gMin;

  for (let ch = 0; ch < nCh; ch++) {
    const vals = replaySeries.values[ch] || [];
    if (vals.length < 2) continue;
    ctx.strokeStyle = channelColor(ch);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    const count = Math.min(limit, vals.length);
    for (let i = 0; i < count; i++) {
      const x = (i / Math.max(1, nSamples - 1)) * w;
      const y = h - ((vals[i] - gMin) / span) * h;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Playhead
  if (limit < nSamples) {
    const x = (limit / Math.max(1, nSamples - 1)) * w;
    ctx.strokeStyle = 'rgba(8,8,12,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
}

function replayTick(dtMs: number) {
  if (!replaySeries || !replayPlaying) return;
  const speed = parseFloat((document.getElementById('replaySpeed') as HTMLSelectElement).value) || 1;
  const times = replaySeries.time;
  if (!times.length) return;
  const dur = times[times.length - 1];
  const cur = replayLastTs !== null ? replayLastTs : 0;
  const next = cur + (dtMs / 1000) * speed;
  if (next >= dur) {
    replayFrame = times.length;
    pauseReplay();
    return;
  }
  // find highest index with time <= next (binary-ish scan)
  let lo = 0, hi = times.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= next) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  replayFrame = best + 1;
  replayLastTs = next;
  const scrb = document.getElementById('replayScrub') as HTMLInputElement;
  if (scrb) scrb.value = String((next / dur) * 1000);
  document.getElementById('replayTime')!.textContent = `${fmtRecTime(next)} / ${fmtRecTime(dur)}`;
  replayReflectOnDashboard();
}

function pauseReplay() {
  replayPlaying = false;
  const btn = document.getElementById('replayPlay');
  if (btn) btn.textContent = '▶ Play';
}

async function toggleReplay() {
  if (replayPlaying) { pauseReplay(); return; }
  if (!replaySeries) {
    await loadReplay();
    if (!replaySeries) return;
  }
  replayPlaying = true;
  replayLastTs = null;
  const btn = document.getElementById('replayPlay');
  if (btn) btn.textContent = '❚❚ Pause';
}

let lastReplayTick: number | null = null;
function replayLoop(ts: number) {
  if (lastReplayTick !== null) {
    replayTick(ts - lastReplayTick);
  }
  lastReplayTick = ts;
  drawReplay();
  requestAnimationFrame(replayLoop);
}

function seekReplayByRatio(ratio: number) {
  if (!replaySeries || !replaySeries.time.length) return;
  const dur = replaySeries.time[replaySeries.time.length - 1];
  const target = Math.max(0, Math.min(dur, ratio * dur));
  let lo = 0, hi = replaySeries.time.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (replaySeries.time[mid] <= target) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  replayFrame = best + 1;
  replayLastTs = target;
  document.getElementById('replayTime')!.textContent = `${fmtRecTime(target)} / ${fmtRecTime(dur)}`;
  replayReflectOnDashboard();
}

// === Replay transport: rewind / step-back / pause / fast-forward ===
function rewindReplay() {
  if (!replaySeries) return;
  replayFrame = 0;
  replayLastTs = null;
  document.getElementById('replayTime')!.textContent =
    `00:00 / ${fmtRecTime(replaySeries.time[replaySeries.time.length - 1] || 0)}`;
  const scrb = document.getElementById('replayScrub') as HTMLInputElement;
  if (scrb) scrb.value = '0';
  replayReflectOnDashboard();
}

function stepReplay(dir: number) {
  if (!replaySeries) return;
  const next = Math.max(0, Math.min((replayFrame ?? 0) + dir, replaySeries.time.length));
  replayFrame = next;
  replayLastTs = next > 0 ? replaySeries.time[Math.min(next - 1, replaySeries.time.length - 1)] : null;
  seekReplayByRatio(next / Math.max(1, replaySeries.time.length));
}

function skipReplayForward() {
  if (!replaySeries) return;
  // Jump ahead ~5% of the loaded recording/session each press.
  const jump = Math.max(1, Math.ceil(replaySeries.time.length * 0.05));
  stepReplay(jump);
}

document.getElementById('replayLoad')!.addEventListener('click', loadReplay);
document.getElementById('replayPlay')!.addEventListener('click', toggleReplay);
document.getElementById('replayRewind')!.addEventListener('click', rewindReplay);
document.getElementById('replayStepBack')!.addEventListener('click', () => stepReplay(-1));
document.getElementById('replayFastForward')!.addEventListener('click', skipReplayForward);
document.getElementById('replayClose')!.addEventListener('click', closeReplayPanel);
document.getElementById('replaySpeed')!.addEventListener('change', () => { replayLastTs = null; });

(document.getElementById('inspReplay') as HTMLButtonElement)?.addEventListener('click', async () => {
  const s = sessions[selectedSession ?? -1];
  if (!s || !s.file_id) return;
  const sel = document.getElementById('replaySession') as HTMLSelectElement;
  sel.value = s.file_id;
  openReplayPanel();
  await loadReplay();
  toggleReplay();
});
(document.getElementById('replayScrub') as HTMLInputElement)?.addEventListener('input', (e) => {
  const ratio = (parseInt((e.target as HTMLInputElement).value, 10) || 0) / 1000;
  seekReplayByRatio(ratio);
});
requestAnimationFrame(replayLoop);

// === Live transport controls (pause / rewind-seek / window zoom / clear) ===
function toggleLivePause() {
  livePaused = !livePaused;
  if (livePaused) {
    // Freeze the FULL rolling history so rewind can replay everything captured
    // so far, not just the on-screen 800-sample trace window.
    frozenTrace = historyData[0] && historyData[0].length ? historyData.map(ch => ch.slice()) : traceData.map(ch => ch.slice());
  } else {
    frozenTrace = [];
    // Resuming from pause: snap back to live so the reader isn't stuck on a stale
    // frozen window from a long time ago.
    liveScrollSeek = 0;
    isLiveScrubbing = false;
  }
  updateTransportUI();
}
function setLiveWindow(samples: number) {
  liveWindowSamples = Math.min(MAX_HISTORY, Math.max(2, Math.round(samples)));
  // Keep the seek within the new window's valid range.
  const maxSeek = (historyData[0] ? historyData[0].length : 0) - liveWindowSamples;
  if (liveScrollSeek > maxSeek) {
    liveScrollSeek = Math.max(0, maxSeek);
    isLiveScrubbing = liveScrollSeek > 0;
  }
  updateTransportUI();
}
function clearLiveView() {
  traceData = traceData.map(() => []);
  historyData = historyData.map(() => []);
  frozenTrace = [];
  liveScrollSeek = 0;
  isLiveScrubbing = false;
  lastSampleTime = 0;
  updateTransportUI();
  updateScrubber();
}
// Seek: samples back from the newest sample. 0 = live following.
function setLiveSeek(offsetSamples: number) {
  const maxSeek = Math.max(0, (historyData[0] ? historyData[0].length : 0) - liveWindowSamples);
  liveScrollSeek = Math.max(0, Math.min(maxSeek, Math.round(offsetSamples)));
  isLiveScrubbing = liveScrollSeek > 0;
  updateTransportUI();
  updateScrubber();
}
// Jump control helpers.
// Number of samples the replay/rewind transport can seek over: while paused we
// replay the frozen snapshot (a true, static rewind archive); live we seek over
// the rolling history buffer.
function liveTotalHistory(): number {
  if (livePaused && frozenTrace.length && frozenTrace[0] && frozenTrace[0].length > 0) {
    return frozenTrace[0].length;
  }
  return historyData[0] ? historyData[0].length : 0;
}
function liveHistorySource(): number[][] {
  return (livePaused && frozenTrace.length && frozenTrace[0] && frozenTrace[0].length > 0) ? frozenTrace : historyData;
}
function liveMaxSeek(): number { return Math.max(0, liveTotalHistory() - liveWindowSamples); }
function goLive() { liveScrollSeek = 0; isLiveScrubbing = false; livePaused = false; frozenTrace = []; updateTransportUI(); updateScrubber(); }
function stepLiveBack() { setLiveSeek(liveScrollSeek + liveWindowSamples); }
function stepLiveFwd() { setLiveSeek(liveScrollSeek - liveWindowSamples); }
// Scrubber (timeline): right end = live/now, left = oldest history.
function updateScrubber() {
  const scrub = document.getElementById('liveScrub') as HTMLInputElement | null;
  const stamp = document.getElementById('liveScrubStamp') as HTMLElement | null;
  const total = liveTotalHistory();
  if (!scrub) return;
  if (total <= 1 || !isLiveScrubbing) {
    scrub.value = '1000';
    scrub.disabled = true;
    if (stamp) stamp.textContent = livePaused ? 'PAUSED' : ''; // live: LIVE button already says it
    return;
  }
  scrub.disabled = false;
  let pct: number;
  if (!isLiveScrubbing) {
    pct = 1;
  } else {
    const avail = Math.max(1, total - liveWindowSamples);
    const seekSamples = Math.min(liveScrollSeek, avail);
    pct = 1 - seekSamples / avail;
  }
  scrub.value = String(Math.round(Math.max(0, Math.min(1, pct)) * 1000));
  if (stamp) stamp.textContent = isLiveScrubbing
    ? `rev ${Math.round(liveScrollSeek / liveRateHz)}s`
    : (livePaused ? 'PAUSED' : '');
}
function updateTransportUI() {
  const playBtn = document.getElementById('livePlayPause') as HTMLButtonElement | null;
  if (playBtn) playBtn.textContent = livePaused ? '▶' : '⏸';
  if (playBtn) playBtn.title = livePaused ? 'Resume live view' : 'Pause live view';
  const rd = document.getElementById('liveWindowReadout') as HTMLElement | null;
  if (rd) rd.textContent = `${(liveWindowSamples / liveRateHz).toFixed(0)}s · ${liveRateHz.toFixed(1)} Hz · zoom ${Math.round((liveWindowSamples / LIVE_WINDOW_DEFAULT) * 100)}%`;
  const resetBtn = document.getElementById('liveZoomReset') as HTMLButtonElement | null;
  if (resetBtn) resetBtn.disabled = liveWindowSamples === LIVE_WINDOW_DEFAULT;

  // Accurate step disable state: rewind available while there is history to step
  // into; fast-forward available when currently scrubbing (seek > 0).
  const revBtn = document.getElementById('liveRev') as HTMLButtonElement | null;
  const fwdBtn = document.getElementById('liveFwd') as HTMLButtonElement | null;
  const jumpBtn = document.getElementById('liveJump') as HTMLButtonElement | null;
  const canRewind = liveMaxSeek() > 0 || liveTotalHistory() > liveWindowSamples;
  const canFwd = liveScrollSeek > 0 || isLiveScrubbing;
  if (revBtn) revBtn.disabled = !canRewind;
  if (fwdBtn) fwdBtn.disabled = !canFwd || (!livePaused && !isLiveScrubbing && liveScrollSeek === 0);
  if (jumpBtn) jumpBtn.disabled = !isLiveScrubbing && !livePaused;
  updateScrubber();
}
document.getElementById('livePlayPause')!.addEventListener('click', toggleLivePause);
document.getElementById('liveClear')!.addEventListener('click', clearLiveView);
(document.getElementById('liveRev') as HTMLButtonElement | null)?.addEventListener('click', (e) => {
  if (e.altKey) setLiveSeek(liveMaxSeek()); else stepLiveBack();
});
(document.getElementById('liveFwd') as HTMLButtonElement | null)?.addEventListener('click', (e) => {
  if (e.altKey) goLive(); else stepLiveFwd();
});
(document.getElementById('liveJump') as HTMLButtonElement | null)?.addEventListener('click', goLive);
(document.getElementById('liveZoomIn') as HTMLButtonElement | null)?.addEventListener('click', () => setLiveWindow(liveWindowSamples * 0.6));
(document.getElementById('liveZoomOut') as HTMLButtonElement | null)?.addEventListener('click', () => setLiveWindow(liveWindowSamples * 1.6));
(document.getElementById('liveZoomReset') as HTMLButtonElement | null)?.addEventListener('click', () => { setLiveWindow(LIVE_WINDOW_DEFAULT); goLive(); });
(document.getElementById('dockToggle') as HTMLButtonElement | null)?.addEventListener('click', () => {
  const dock = document.getElementById('underDock');
  if (!dock) return;
  dock.classList.toggle('collapsed');
  const btn = document.getElementById('dockToggle');
  if (btn) btn.textContent = dock.classList.contains('collapsed') ? '▦' : '—';
});
(document.getElementById('liveScrub') as HTMLInputElement | null)?.addEventListener('input', (e) => {
  const pct = (parseInt((e.target as HTMLInputElement).value, 10) || 0) / 1000;
  const total = liveTotalHistory();
  const avail = Math.max(1, total - liveWindowSamples);
  setLiveSeek(avail * (1 - pct));
});

// Pointer interactions on the trace: crosshair cursor, drag-to-pan, shift+drag
// box-zoom, double-click to return to live.
let dragStart: { x: number; y: number; seek: number } | null = null;
let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
function canvasClientXY(e: MouseEvent) { const r = tracesCanvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
tracesCanvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const p = canvasClientXY(e);
  dragStart = { x: p.x, y: p.y, seek: liveScrollSeek };
  box = null;
  tracesCanvas.classList.add(e.shiftKey ? 'tl-boxing' : 'tl-panning');
});
window.addEventListener('mousemove', (e) => {
  const r = tracesCanvas.getBoundingClientRect();
  const inCanvas = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  if (!inCanvas) return;
  const p = canvasClientXY(e);
  if (dragStart && !e.shiftKey) {
    // Drag-pan horizontally: shift the seek by the dragged pixel distance mapped
    // to samples. Pausing follows naturally.
    const dx = p.x - dragStart.x;
    const gutter = 44, pw = (tracesCanvas.width - gutter);
    const perPx = pw > 0 ? liveWindowSamples / pw : 0;
    setLiveSeek(dragStart.seek + dx * perPx);
  }
  if (e.shiftKey && dragStart) {
    box = { x0: dragStart.x, y0: dragStart.y, x1: p.x, y1: p.y };
  }
  cursorPX = p.x; cursorPY = p.y;
});
window.addEventListener('mouseup', (e) => {
  if (!dragStart) return;
  const p = canvasClientXY(e);
  if (e.shiftKey && box) {
    const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1);
    const perPx = (tracesCanvas.width - 44) > 0 ? liveWindowSamples / (tracesCanvas.width - 44) : 0;
    const minX = perPx * (x0 - 44), maxX = perPx * (x1 - 44);
    const newWlen = Math.max(8, Math.min(MAX_HISTORY, Math.round(maxX - minX)));
    if (newWlen >= 8 && Math.abs(newWlen - liveWindowSamples) > 1) {
      liveWindowSamples = newWlen;
      setLiveSeek(liveScrollSeek + minX);
    }
  }
  dragStart = null;
  box = null;
  tracesCanvas.classList.remove('tl-panning', 'tl-boxing');
});
tracesCanvas.addEventListener('dblclick', () => { goLive(); });

// Continuous zoom with the mouse wheel over the trace canvas. Wheel up zooms in
// (narrower window), wheel down zooms out; the zoom anchors at the cursor x.
function handleTracesWheel(ev: WheelEvent) {
  ev.preventDefault();
  const rect = tracesCanvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const frac = Math.max(0, Math.min(1, x / rect.width));
  const old = liveWindowSamples;
  let steps = 0;
  if (ev.deltaY < 0) steps = -1; else if (ev.deltaY > 0) steps = 1;
  const factor = Math.pow(1.25, steps);
  const next = Math.min(MAX_HISTORY, Math.max(8, Math.round(old * factor)));
  if (next === old) return;
  // Zoom around the cursor: keep the history position p that sits under the
  // cursor fixed. p = seek + (1-frac)*window (samples back from newest).
  // Preserve p with the new window -> seek' = p - (1-frac)*next.
  if (isLiveScrubbing) {
    const p = liveScrollSeek + (1 - frac) * old;
    setLiveSeek(p - (1 - frac) * next);
  }
  liveWindowSamples = next;
  updateTransportUI();
  updateScrubber();
}
tracesCanvas.addEventListener('wheel', handleTracesWheel, { passive: false });

// === Animation Loop ===
function animate() {
  drawTraces();
  updateSessionTime();
  updateTransportUI();
  requestAnimationFrame(animate);
}

// === Periodic Updates ===
setInterval(updateSensorHealth, 2000);
setInterval(updateOledPreview, 1000);
setInterval(pollPhaseRecorder, 500);
setInterval(reloadClassifiers, 4000);
setInterval(refreshBurnIn, 1000);

// === Measured Phenotype Strip ===
// Live readout of the Rust `compute_phenotype` report over the readings ring.
// Mirrors the perception-layer honesty rules: only the validated 2-cluster
// response-type reference is used; everything else surfaces as a boundary.
type PhenotypeReport = {
  has_data: boolean;
  n_channels: number;
  reference_geometry: boolean;
  per_channel: Array<{
    channel: number;
    direction: string;
    delta: number;
    cv: number;
  }>;
  a1: { valence: string; summary: string };
  a2: {
    rise: string;
    recovery: string;
    rise_fraction: number | null;
    recovery_observed: boolean;
    summary: string;
  };
  a3: {
    fingerprint: number[];
    assignable: boolean;
    reason: string;
    response_type: string | null;
    measured_membership: string | null;
    percept: string | null;
    plain_language: string | null;
    confidence: string | null;
    nearest_distance: number | null;
  };
  protocol: {
    recording: boolean;
    current_phase: string;
    phase_label: string;
    instruction: string;
    complete: boolean;
    note: string;
  };
  boundaries_cannot: string[];
  caveat: string;
};

const PHENO_DIR_GLYPH: Record<string, string> = {
  reducing: '▼',
  oxidizing: '▲',
  flat: '·',
  masked: '⊘',
};
const PHENO_DIR_COLOR: Record<string, string> = {
  reducing: 'var(--green)',
  oxidizing: 'var(--yellow)',
  flat: 'var(--text-3)',
  masked: 'var(--text-3)',
};

function setA1Direction(valence: string) {
  const tri = document.getElementById('phenoA1Tri');
  const val = document.getElementById('phenoA1Val');
  const color = PHENO_DIR_COLOR[valence] || 'var(--text-3)';
  const glyph = PHENO_DIR_GLYPH[valence] || '·';
  if (tri) {
    tri.textContent = glyph;
    tri.style.color = color;
  }
  if (val) {
    val.style.color = color;
    val.textContent = valence === 'none' ? '—' : valence;
  }
}

function cssVarColor(name: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || '#888';
}

function drawPhenoBars(fp: number[], validGeometry: boolean) {
  const canvas = document.getElementById('phenoBars') as HTMLCanvasElement | null;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, canvas.clientWidth);
  const h = Math.max(1, canvas.clientHeight);
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, pw, ph);
  if (fp.length === 0) {
    ctx.fillStyle = cssVarColor('--text-3');
    ctx.globalAlpha = 0.7;
    ctx.font = `${Math.max(8, Math.round(h * 0.24))}px monospace`;
    ctx.textBaseline = 'middle';
    ctx.fillText('no fingerprint', 4, h / 2);
    ctx.globalAlpha = 1;
    return;
  }
  const cry = cssVarColor(validGeometry ? '--cyan' : '--text-3');
  const maxV = Math.max(...fp, 0.001);
  const pad = 2 * dpr;
  const bw = (pw - pad * 2) / fp.length;
  for (let i = 0; i < fp.length; i++) {
    const bh = Math.max(1.5 * dpr, (fp[i] / maxV) * (ph - pad * 2));
    ctx.fillStyle = cry;
    ctx.globalAlpha = validGeometry ? 0.85 : 0.45;
    ctx.fillRect(pad + i * bw, ph - pad - bh, Math.max(1, bw - dpr), bh);
  }
  ctx.globalAlpha = 1;
}

function phenoA3Reason(reason: string): string {
  if (reason === 'flat_selectivity_profile') return 'flat selectivity — no dominant response direction to classify';
  if (reason === 'reference_space_mismatch') return 'not a 16-sensor reference array — no validated response-type space for this geometry';
  if (reason === 'insufficient_data') return 'insufficient data';
  return reason;
}

function drawBoundaryList(p: PhenotypeReport) {
  const el = document.getElementById('phenoBoundList');
  if (!el) return;
  const cannot = p.boundaries_cannot.length ? p.boundaries_cannot.map((b) => `✗ ${b}`).join('<br/>') : '';
  const caveat = p.caveat ? `<span title="${esc(p.caveat)}">⚠ ${esc(p.caveat)}</span>` : '';
  el.innerHTML = cannot + (cannot && caveat ? '<br/><br/>' : '') + caveat;
}

function renderPhenotype(p: PhenotypeReport) {
  const setVal = (id: string, v: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };

  const a1Color = p.a1.valence === 'reducing'
    ? 'var(--green)'
    : p.a1.valence === 'oxidizing' ? 'var(--yellow)' : 'var(--text-3)';
  const tag = document.getElementById('phenoA1Tag');
  if (tag) {
    tag.style.color = a1Color;
    tag.textContent = p.has_data ? `A1 · ${p.a1.valence}` : 'A1 —';
  }

  if (!p.has_data) {
    setA1Direction(p.a1.valence);
    setVal('phenoA1Sub', p.a1.summary);
    setVal('phenoA1Chips', '');
    setVal('phenoA3Val', 'no reference');
    setVal('phenoA3Sub', phenoA3Reason(p.a3.reason));
    const cap0 = document.getElementById('phenoA3Cap');
    if (cap0) cap0.textContent = p.n_channels > 0 ? `${p.n_channels} channels` : '';
    setVal('phenoA2Val', p.a2.rise === 'unknown' ? '—' : p.a2.rise);
    setVal('phenoA2Sub', p.a2.summary);
    drawPhenoBars([], false);
    drawBoundaryList(p);
    return;
  }

  // A1 — redox valence of the responding-channel majority.
  setA1Direction(p.a1.valence);
  setVal('phenoA1Sub', p.a1.summary);
  const chips = document.getElementById('phenoA1Chips')!;
  chips.innerHTML = p.per_channel.map((c) => {
    const color = PHENO_DIR_COLOR[c.direction] || 'var(--text-3)';
    const tri = PHENO_DIR_GLYPH[c.direction] || '';
    return `<span class="pheno-chip" title="${c.direction} · Δ ${c.delta.toFixed(2)} · CV ${c.cv.toFixed(2)}">` +
      `<span class="pd-dot" style="background:${color}"></span>${esc(chNames[c.channel] || `CH${c.channel + 1}`)} <span style="color:${color}">${tri}</span></span>`;
  }).join('');

  // A3 — response type vs the validated 2-cluster reference.
  if (p.a3.assignable && p.a3.response_type) {
    setVal('phenoA3Val', p.a3.response_type + (p.a3.confidence ? ` · ${p.a3.confidence}` : ''));
    const dist = p.a3.nearest_distance != null ? `d ${p.a3.nearest_distance.toFixed(2)}` : '';
    setVal('phenoA3Sub', [p.a3.plain_language, p.a3.measured_membership, dist].filter(Boolean).join(' — '));
  } else {
    setVal('phenoA3Val', 'not assigned');
    setVal('phenoA3Sub', phenoA3Reason(p.a3.reason));
  }
  const cap = document.getElementById('phenoA3Cap');
  if (cap) cap.textContent = `${p.a3.fingerprint.length} channels · ${p.a3.reason}`;
  drawPhenoBars(p.a3.fingerprint, p.reference_geometry);

  // A2 — live kinetic binding (rise / recovery shape), mirroring phenotype.py.
  // Rise is computed live from the window shape; recovery is honest "unknown"
  // until a real decay phase is present.
  {
    let v = p.a2.rise === 'unknown' ? '—' : p.a2.rise.toUpperCase();
    const sfx = p.a2.recovery_observed ? ` · rec ${p.a2.recovery}` : '';
    if (p.protocol.recording) {
      v += ` (${p.protocol.current_phase})`;
    } else if (p.protocol.complete) {
      v += ' · session complete';
    }
    setVal('phenoA2Val', v ? v : '—');
    setVal('phenoA2Sub', `${p.a2.summary}${sfx}`);
  }

  drawBoundaryList(p);
}

async function pollPhenotype() {
  try {
    const p = await invoke<PhenotypeReport>('compute_phenotype');
    renderPhenotype(p);
  } catch (e) {
    // Keep the last good frame; the Rust side reports honest refusals in-band.
    console.error('Phenotype poll error:', e);
  }
}
pollPhenotype();
setInterval(pollPhenotype, 2000);

// === Hardware Profile ===
// Plain per-rig description matching the perception-layer `sensor_profile.json`
// (schema v1). It records how the user's board is wired (circuit reference) and
// what each channel is — NOT signal direction. Direction is the n/p + wiring
// mirror ambiguity from `ontology/detect.py`; research is incomplete, so we do
// not ask for it or encode it here.
type HardwareProfile = {
  preset: string;
  name: string;
  adcBits: number;
  rloadOhm: number;
  vcc: number;
  sensorOnLowSide: boolean;
  /// User-specified channel names (any count) — overrides preset names when set.
  customChannelNames?: string[];
  /// Fitted I²C devices besides the OLED (MEMS/env breakouts on the SDA/SCL
  /// bus). The blueprint pre-flight uses this to flag a duplicate-address clash
  /// before flashing — two devices on one address produce a dead bus.
  i2cDevices?: I2cDevice[];
};
// Hardware live state — see the HW_KEY / hardwareProfile declarations above the
// peripheral wiring block (they must precede the top-level syncPeripheralUI()).

// Built-in profile templates (channel sensor lists mirror the desktop presets).
const HW_PRESET_TEMPLATES: Record<string, Partial<HardwareProfile>> = {
  custom: { name: 'My Rig', adcBits: 12, rloadOhm: 1000, vcc: 5.0, sensorOnLowSide: true, i2cDevices: [] },
  smellmonitor: { name: 'Example: SmellMonitor', adcBits: 12, rloadOhm: 1000, vcc: 5.0, sensorOnLowSide: true, i2cDevices: [] },
  reference: { name: 'Example: 6-sensor lab rig', adcBits: 12, rloadOhm: 1000, vcc: 5.0, sensorOnLowSide: true, i2cDevices: [] },
};

function loadHardwareProfile() {
  try {
    const raw = localStorage.getItem(HW_KEY);
    if (raw) hardwareProfile = { ...hardwareProfile, ...(JSON.parse(raw) as Partial<HardwareProfile>) };
  } catch { /* defaults */ }
}
function persistHardwareProfile() {
  try { localStorage.setItem(HW_KEY, JSON.stringify(hardwareProfile)); } catch { /* ignore */ }
}

function renderHardwareProfile() {
  const presetEl = document.getElementById('hwProfilePreset') as HTMLSelectElement | null;
  const nameEl = document.getElementById('hwProfileName') as HTMLInputElement | null;
  const adcEl = document.getElementById('hwAdcBits') as HTMLInputElement | null;
  const rlEl = document.getElementById('hwRload') as HTMLInputElement | null;
  const vccEl = document.getElementById('hwVcc') as HTMLInputElement | null;
  const lowEl = document.getElementById('hwLowSide') as HTMLSelectElement | null;
  const status = document.getElementById('hwStatus');

  if (presetEl) presetEl.value = hardwareProfile.preset;
  if (nameEl) nameEl.value = hardwareProfile.name;
  if (adcEl) adcEl.value = String(hardwareProfile.adcBits);
  if (rlEl) rlEl.value = String(hardwareProfile.rloadOhm);
  if (vccEl) vccEl.value = String(hardwareProfile.vcc);
  if (lowEl) lowEl.value = String(hardwareProfile.sensorOnLowSide);

  if (status) {
    status.textContent = `${hardwareProfile.name || 'Unnamed rig'} · ${hardwareProfile.adcBits}bit · ${hardwareProfile.vcc}V · RL ${hardwareProfile.rloadOhm}Ω · ${hardwareProfile.sensorOnLowSide ? 'sensor on low side' : 'sensor on high side'}`;
    status.style.color = 'var(--text-2)';
  }
}

function wireHardwareProfile() {
  const presetEl = document.getElementById('hwProfilePreset') as HTMLSelectElement | null;
  presetEl?.addEventListener('change', () => {
    const t = HW_PRESET_TEMPLATES[presetEl.value] || HW_PRESET_TEMPLATES.custom;
    hardwareProfile = { ...hardwareProfile, ...t, preset: presetEl.value };
    persistHardwareProfile();
    renderHardwareProfile();
  });

  const nameEl = document.getElementById('hwProfileName') as HTMLInputElement | null;
  nameEl?.addEventListener('input', () => { hardwareProfile.name = nameEl.value; persistHardwareProfile(); });

  const adcEl = document.getElementById('hwAdcBits') as HTMLInputElement | null;
  adcEl?.addEventListener('input', () => { hardwareProfile.adcBits = Math.max(8, Math.min(24, Number(adcEl.value) || 12)); persistHardwareProfile(); });
  const rlEl = document.getElementById('hwRload') as HTMLInputElement | null;
  rlEl?.addEventListener('input', () => { hardwareProfile.rloadOhm = Number(rlEl.value) || 1000; persistHardwareProfile(); });
  const vccEl = document.getElementById('hwVcc') as HTMLInputElement | null;
  vccEl?.addEventListener('input', () => { hardwareProfile.vcc = Number(vccEl.value) || 5.0; persistHardwareProfile(); });
  const lowEl = document.getElementById('hwLowSide') as HTMLSelectElement | null;
  lowEl?.addEventListener('change', () => {
    hardwareProfile.sensorOnLowSide = lowEl.value === 'true';
    persistHardwareProfile();
  });

  // Custom channel names — comma-separated, persists to HW profile.
  const namesEl = document.getElementById('channelNamesInput') as HTMLInputElement | null;
  if (namesEl) {
    namesEl.value = (hardwareProfile.customChannelNames || []).join(', ');
    namesEl.addEventListener('input', () => {
      const parts = namesEl.value.split(',').map(s => s.trim()).filter(Boolean);
      hardwareProfile.customChannelNames = parts.length > 0 ? parts : undefined;
      persistHardwareProfile();
      applyCustomNames();
    });
  }

  const exportBtn = document.getElementById('hwExport');
  exportBtn?.addEventListener('click', () => exportHardwareProfile());
  const importBtn = document.getElementById('hwImport');
  importBtn?.addEventListener('click', () => importHardwareProfile());

  // Advanced JSON drawer — full-profile edit surface. Opening/reload re-syncs
  // from live state; Save validates (never silently clamps into the bus range)
  // then persists and re-renders the form + blueprint pre-flight.
  const jsonWrap = document.getElementById('hwJsonWrap');
  const jsonEl = document.getElementById('hwJson') as HTMLTextAreaElement | null;
  const jsonToggle = document.getElementById('hwJsonToggle');
  const jsonStatus = document.getElementById('hwJsonStatus');
  const fillJson = () => { if (jsonEl) jsonEl.value = JSON.stringify(hardwareProfile, null, 2); };
  jsonToggle?.addEventListener('click', () => {
    const open = !jsonWrap || jsonWrap.style.display !== 'none';
    if (jsonWrap) jsonWrap.style.display = open ? 'none' : 'block';
    if (jsonToggle) jsonToggle.textContent = open ? 'show' : 'hide';
    if (!open) fillJson();
  });
  document.getElementById('hwJsonReload')?.addEventListener('click', () => {
    fillJson();
    if (jsonStatus) { jsonStatus.textContent = ''; jsonStatus.style.color = ''; }
  });
  jsonEl?.addEventListener('input', () => {
    if (jsonStatus) { jsonStatus.textContent = ''; jsonStatus.style.color = ''; }
  });
  document.getElementById('hwJsonSave')?.addEventListener('click', () => {
    if (!jsonEl || !jsonStatus) return;
    try {
      const p = JSON.parse(jsonEl.value) as Partial<HardwareProfile>;
      const i2cDevices: I2cDevice[] = (Array.isArray(p.i2cDevices) ? p.i2cDevices : [])
        .filter((d): d is I2cDevice => !!d && typeof (d as I2cDevice).device === 'string' && parseI2cAddress((d as I2cDevice).address) !== null)
        .map(d => ({ device: d.device || 'I²C device', address: d.address }));
      const custom = Array.isArray(p.customChannelNames)
        ? p.customChannelNames.filter((c): c is string => typeof c === 'string')
        : [];
      hardwareProfile = {
        preset: typeof p.preset === 'string' ? p.preset : 'custom',
        name: typeof p.name === 'string' ? p.name : '',
        adcBits: Math.max(8, Math.min(24, Number(p.adcBits) || 12)),
        rloadOhm: Number(p.rloadOhm) > 0 ? Number(p.rloadOhm) : 1000,
        vcc: Number(p.vcc) > 0 ? Number(p.vcc) : 5.0,
        sensorOnLowSide: typeof p.sensorOnLowSide === 'boolean' ? p.sensorOnLowSide : true,
        customChannelNames: custom.length ? custom : undefined,
        i2cDevices: i2cDevices.length ? i2cDevices : [],
      };
      persistHardwareProfile();
      renderHardwareProfile();
      if (hardwareProfile.customChannelNames) { channelKinds = []; applyCustomNames(); }
      refreshRigBlueprint();
      fillJson();
      jsonStatus.textContent = 'Saved and validated.';
      jsonStatus.style.color = 'var(--green)';
    } catch (e) {
      jsonStatus.textContent = `Invalid JSON: ${e}`;
      jsonStatus.style.color = 'var(--red)';
    }
  });
}

// Serialize the current app rig config into the perception-layer sensor_profile.json (schema v1).
function exportHardwareProfile() {
  const model = (i: number) => chNames[i] || `CH${i + 1}`;
  const chCount = Math.max(channelCount, chNames.length);
  const profile = {
    $schema: 'https://opensmell.org/schemas/sensor_profile_v1.json',
    schema_version: '1.0.0',
    sensor_profile: {
      device_id: hardwareProfile.name || hardwareProfile.preset,
      manufacturer: 'OpenSmell Desktop',
      model: hardwareProfile.name || 'Custom rig',
      firmware_version: 'desktop-0.1.0',
      board: {
        family: 'esp32',
        name: 'ESP32 (DevKit-V1 / WROOM-32)',
        toolchain: 'arduino-core/esp32',
      },
      recording_protocol: {
        name: 'osmell_baseline_exposure_recovery',
        baseline_seconds: 30, exposure_seconds: 45, recovery_seconds: 120, sample_rate_hz: 10,
      },
      channels: Array.from({ length: chCount }, (_, i) => {
        const c = calibrationPerChannel[i];
        const s = SENSOR_LIBRARY[model(i)];
        return {
          channel_id: i,
          sensor_model: model(i),
          target_gases: s ? s.target.split('/').map(x => x.trim().toLowerCase()) : [],
          material: 'SnO2',
          nominal_sensitivity_a: c?.a ?? s?.a ?? null,
          nominal_exponent_b: c?.b ?? s?.b ?? null,
          heater_voltage: hardwareProfile.vcc,
          heater_power_w: null,
          operating_surface_temp_c: null,
        };
      }),
      circuit: {
        supply_voltage_vcc: hardwareProfile.vcc,
        load_resistor_rl_ohm: hardwareProfile.rloadOhm,
        is_voltage_divider: true,
        adc_bits: hardwareProfile.adcBits,
        adc_reference_voltage: 3.3,
        adc_max_count: Math.pow(2, hardwareProfile.adcBits) - 1,
        // ADC pin row is the firmware's fixed assignment (mirrors
        // `sensor_pins_for` in the desktop) so the profile travels truthfully.
        adc_pins: chCount > 0 ? presetPins(chCount) : [],
        i2c_bus: {
          sda: I2C_SDA,
          scl: I2C_SCL,
          devices: rigI2cFit().map(d => ({ device: d.device, address: fmtI2c(d.address) })),
        },
      },
      environment: { has_temp_humidity_sensor: false, humidity_compensation: {} },
      gas_delivery: { intake_flow_lpm: null, has_ptfe_filter: false, filter_pore_um: null, chamber_volume_ml: null, flush_time_seconds: null },
      compliance: {
        records_osmell_osm: false,
        // NOTE: signal direction / doping are intentionally NOT encoded here.
        // MOX direction is the n/p + divider-wiring mirror ambiguity described in
        // perception-layer `detect.py`; research is incomplete, so we never guess it.
      },
    },
  };
  const pre = document.getElementById('hwExported');
  if (pre) { pre.style.display = 'block'; pre.textContent = JSON.stringify(profile, null, 2); }
  const status = document.getElementById('hwStatus');
  if (status) status.textContent = `Exported sensor_profile.json for ${hardwareProfile.name || 'your rig'}`;
}

async function importHardwareProfile() {
  const status = document.getElementById('hwStatus');
  const pickProfile = (): Promise<string> => new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      document.body.removeChild(input);
      if (!f) return reject(new Error('no file selected'));
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsText(f);
    });
    input.click();
  });
  try {
    const text = await pickProfile();
    const data = JSON.parse(text);
    const sp = data?.sensor_profile ?? data ?? {};
    const ckt = sp.circuit ?? {};
    const chs = sp.channels ?? [];
    const i2cRaw = Array.isArray(ckt.i2c_bus?.devices) ? ckt.i2c_bus.devices
      : (Array.isArray(ckt.i2c_devices) ? ckt.i2c_devices : []);
    const i2cDevices: I2cDevice[] = [];
    for (const d of i2cRaw) {
      const addr = parseI2cAddress(d?.address);
      if (addr !== null) i2cDevices.push({ device: String(d?.device || 'I²C device'), address: addr });
    }
    hardwareProfile = {
      preset: 'custom',
      name: sp.model || sp.device_id || 'Imported rig',
      adcBits: Number(ckt.adc_bits) || 12,
      rloadOhm: Number(ckt.load_resistor_rl_ohm) || 1000,
      vcc: Number(ckt.supply_voltage_vcc) || 5.0,
      sensorOnLowSide: ckt.is_voltage_divider !== false,
      i2cDevices,
    };
    // If the imported profile declares channel sensors, adopt them as the preset.
    if (chs.length > 0) {
      const names = chs.map((c: any) => c.sensor_model || `CH${c.channel_id + 1}`);
      setChannelCount(names.length, names);
    }
    persistHardwareProfile();
    renderHardwareProfile();
    refreshRigBlueprint();
    if (status) status.textContent = `Imported ${hardwareProfile.name}`;
  } catch (e) {
    if (status) { status.textContent = `Import failed: ${e}`; status.style.color = 'var(--red)'; }
  }
}

// === Calibration & Sensor Library ===
// Representative MQ-datasheet sensitivity-curve coefficients. Per the classic
// MQ model:  RS/RO = a · C^b   (C = target-gas concentration in ppm).
// `a` = sensitivity factor on the variable-resistance air point, `b` = log-log
// slope. `r0_typ` and `rl` are the typical clean-air sensor resistance and the
// board load resistor. Values are starting points — real units should be
// tube-calibrated, but these keep the UI useful out of the box.
const SENSOR_LIBRARY: Record<string, {
  name: string; target: string; range: string;
  a: number; b: number; r0_typ: number; rl: number; notes: string;
}> = {
  'MQ-135': { name: 'MQ-135', target: 'Air quality / NH₃ / benzene / CO₂', range: '10 – 1000 ppm', a: 102.2, b: -2.473, r0_typ: 100, rl: 20, notes: 'Low cost, general air-quality (CO₂/NH₃/VOC).' },
  'MQ-3':   { name: 'MQ-3',   target: 'Alcohol / ethanol / smoke', range: '0.05 – 10 mg/L', a: 0.2924, b: -1.688, r0_typ: 2000, rl: 4.7, notes: 'Alcohol & smoke. Heater: 0.9 V.' },
  'MQ-6':   { name: 'MQ-6',   target: 'LPG / butane / propane', range: '200 – 10000 ppm', a: 0.2549, b: -0.538, r0_typ: 30, rl: 20, notes: 'LPG/gas leak. Fast response.' },
  'MQ-7':   { name: 'MQ-7',   target: 'Carbon monoxide (CO)', range: '20 – 2000 ppm', a: 99.04, b: -1.537, r0_typ: 1000, rl: 10, notes: 'CO; requires 1.4/5.0 V heater cycling.' },
  'MQ-4':   { name: 'MQ-4',   target: 'Methane (CH₄) / natural gas', range: '300 – 10000 ppm', a: 0.5810, b: -0.5173, r0_typ: 1000, rl: 20, notes: 'Methane/natural-gas sensing.' },
  'MQ-8':   { name: 'MQ-8',   target: 'Hydrogen (H₂)', range: '100 – 10000 ppm', a: 0.1052, b: -0.4035, r0_typ: 100, rl: 10, notes: 'H₂; also detects CO/LPG mildly.' },
  'MQ-2':   { name: 'MQ-2',   target: 'LPG / smoke / alcohol / H₂', range: '300 – 10000 ppm', a: 1.035, b: -0.450, r0_typ: 68, rl: 5, notes: 'Combustible gas / smoke, multi-gas.' },
  'MQ-9':   { name: 'MQ-9',   target: 'CO / combustible gas', range: '10 – 1000 ppm', a: 10.35, b: -0.823, r0_typ: 1000, rl: 10, notes: 'CO + methane; heater cycling like MQ-7.' },
};

// Per-channel calibration state, persisted to localStorage so it survives reloads.
type CalibEntry = { model: string; r0: number; a: number; b: number; enabled: boolean };
const CALIB_KEY = 'osmograph.calibration';
let calibrationPerChannel: CalibEntry[] = [];
function loadCalibration() {
  try {
    const raw = localStorage.getItem(CALIB_KEY);
    if (raw) calibrationPerChannel = JSON.parse(raw) as CalibEntry[];
  } catch { /* fall through to defaults */ }
  if (!Array.isArray(calibrationPerChannel)) calibrationPerChannel = [];
}
function persistCalibration() {
  try { localStorage.setItem(CALIB_KEY, JSON.stringify(calibrationPerChannel)); } catch { /* ignore */ }
}

// Ensure the calibration array covers every active channel with library defaults.
function ensureCalibrationLength() {
  while (calibrationPerChannel.length < chNames.length) {
    const model = chNames[calibrationPerChannel.length] || `CH${calibrationPerChannel.length + 1}`;
    const lib = SENSOR_LIBRARY[model];
    calibrationPerChannel.push(lib
      ? { model, r0: lib.r0_typ, a: lib.a, b: lib.b, enabled: true }
      : { model, r0: 0, a: 1, b: -1, enabled: false });
  }
}

// Convert a raw resistance reading to ppm using the active calibration for a channel.
function calibratedPPM(ch: number, raw: number): number | null {
  const c = calibrationPerChannel[ch];
  if (!c || !c.enabled || !c.r0 || c.r0 <= 0 || raw <= 0) return null;
  // rs/r0 ratio; RS ≈ rl*(Vcc/Vout - 1) handled upstream; here `raw` is a ratio proxy.
  const rsRatio = raw;
  const ppm = Math.pow(rsRatio / c.a, 1 / c.b);
  return isFinite(ppm) && ppm > 0 ? ppm : null;
}

function renderCalibration() {
  ensureCalibrationLength();
  const table = document.getElementById('calibTable');
  if (!table) return;
  if (chNames.length === 0) { table.innerHTML = '<span class="hint">No channels configured.</span>'; return; }
  table.innerHTML = [
    '<div class="calib-row calib-head">',
    '<span>CH</span><span>Sensor</span><span>R₀ (Ω)</span><span>a</span><span>b</span><span>Apply</span>',
    '</div>',
    ...chNames.map((name, i) => {
      const c = calibrationPerChannel[i];
      const lib = SENSOR_LIBRARY[name];
      const opts = Object.keys(SENSOR_LIBRARY).map(m =>
        `<option value="${m}" ${c.model === m ? 'selected' : ''}>${m}</option>`).join('');
      const modelSel = `<select class="calib-model" data-ch="${i}">${lib ? `<option value="${name}">${name}</option>` : ''}${opts}</select>`;
      return `<div class="calib-row">
        <span class="calib-ch" style="color:${channelColor(i)}">CH${i + 1}</span>
        ${modelSel}
        <input class="calib-r0"  type="number" min="0" step="any" value="${c.r0}"  data-ch="${i}" />
        <input class="calib-a"   type="number" min="0" step="any" value="${c.a}"   data-ch="${i}" />
        <input class="calib-b"   type="number" step="any" value="${c.b}" data-ch="${i}" />
        <span class="calib-toggle"><input class="calib-on" type="checkbox" data-ch="${i}" ${c.enabled ? 'checked' : ''} /></span>
      </div>`;
    }).join('')
  ].join('');

  table.querySelectorAll<HTMLSelectElement>('.calib-model').forEach(sel => {
    sel.addEventListener('change', () => {
      const i = Number(sel.dataset.ch);
      const m = sel.value;
      const lib = SENSOR_LIBRARY[m];
      calibrationPerChannel[i] = lib
        ? { model: m, r0: lib.r0_typ, a: lib.a, b: lib.b, enabled: true }
        : { model: m, r0: calibrationPerChannel[i].r0, a: calibrationPerChannel[i].a, b: calibrationPerChannel[i].b, enabled: calibrationPerChannel[i].enabled };
      renderCalibration();
    });
  });
  table.querySelectorAll<HTMLInputElement>('.calib-r0,.calib-a,.calib-b').forEach(inp => {
    inp.addEventListener('input', () => {
      const i = Number(inp.dataset.ch);
      const c = calibrationPerChannel[i];
      if (!c) return;
      if (inp.classList.contains('calib-r0')) c.r0 = Number(inp.value);
      if (inp.classList.contains('calib-a')) c.a = Number(inp.value);
      if (inp.classList.contains('calib-b')) c.b = Number(inp.value);
    });
  });
  table.querySelectorAll<HTMLInputElement>('.calib-on').forEach(cb => {
    cb.addEventListener('change', () => {
      const i = Number(cb.dataset.ch);
      if (calibrationPerChannel[i]) calibrationPerChannel[i].enabled = cb.checked;
    });
  });
}

function renderSensorLibrary(filter = '') {
  const el = document.getElementById('sensorLibTable');
  if (!el) return;
  const q = filter.trim().toLowerCase();
  const rows = Object.values(SENSOR_LIBRARY)
    .filter(s => !q || `${s.name} ${s.target} ${s.range}`.toLowerCase().includes(q));
  el.innerHTML = rows.length === 0
    ? '<span class="hint">No sensors match that filter.</span>'
    : `<table class="sensor-lib-table">
        <thead><tr><th>Model</th><th>Target</th><th>Range</th><th>a</th><th>b</th><th>R₀ typ</th><th></th></tr></thead>
        <tbody>${rows.map(s => `<tr>
          <td><b>${s.name}</b></td>
          <td title="${s.notes}">${s.target}</td>
          <td>${s.range}</td>
          <td>${s.a}</td>
          <td>${s.b}</td>
          <td>${s.r0_typ} Ω</td>
          <td><button class="mini-btn" data-model="${s.name}">Apply → CH1</button></td>
        </tr>`).join('')}</tbody>
      </table>`;
  el.querySelectorAll<HTMLButtonElement>('.mini-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = btn.dataset.model!;
      applySensorToFirstChannel(m);
    });
  });
}

function applySensorToFirstChannel(model: string) {
  const lib = SENSOR_LIBRARY[model];
  if (!lib || chNames.length === 0) return;
  ensureCalibrationLength();
  // If the library model matches one of the configured sensor names, apply to
  // that channel; otherwise apply to the first (or first empty) channel.
  const idx = chNames.findIndex(n => n === model);
  const target = idx >= 0 ? idx : 0;
  calibrationPerChannel[target] = { model, r0: lib.r0_typ, a: lib.a, b: lib.b, enabled: true };
  persistCalibration();
  renderCalibration();
  const st = document.getElementById('calibStatus');
  if (st) { st.textContent = `Applied ${model} to CH${target + 1}.`; st.style.color = 'var(--text-2)'; }
}

document.getElementById('calibSave')!.addEventListener('click', () => {
  persistCalibration();
  const st = document.getElementById('calibStatus');
  if (st) { st.textContent = 'Saved ✓'; st.style.color = 'var(--cyan)'; }
  setTimeout(() => { if (st) st.textContent = 'Adjust values then Save.'; }, 2200);
});

document.getElementById('sensorLibSearch')!.addEventListener('input', (e) => {
  renderSensorLibrary((e.target as HTMLInputElement).value);
});

// Export a sensor model as shareable JSON (the contribution payload).
function exportSensorJSON(i: number) {
  const c = calibrationPerChannel[i];
  const pre = document.getElementById('calibExported');
  if (!pre) return;
  const payload = {
    sensor: c.model,
    target_gas: SENSOR_LIBRARY[c.model]?.target || '',
    range_ppm: SENSOR_LIBRARY[c.model]?.range || '',
    sensitivity_a: c.a,
    exponent_b: c.b,
    r0_typical_ohm: c.r0,
    load_resistor_kohm: SENSOR_LIBRARY[c.model]?.rl ?? null,
    source: 'osmograph-desktop',
  };
  pre.style.display = 'block';
  pre.textContent = JSON.stringify(payload, null, 2);
}
document.getElementById('calibExport')!.addEventListener('click', () => {
  ensureCalibrationLength();
  exportSensorJSON(0);
});

// Copy the current JSON payload to the clipboard so the user can paste it into
// a GitHub PR, and walk them through the exact flow. Kept simple: copy, then
// point to the sensor library file + Discord.
document.getElementById('calibContribute')!.addEventListener('click', async () => {
  ensureCalibrationLength();
  exportSensorJSON(0);
  const pre = document.getElementById('calibExported');
  const json = pre?.textContent || '';
  let copied = false;
  if (json) {
    try {
      await navigator.clipboard.writeText(json);
      copied = true;
    } catch { copied = false; }
  }
  showToast(
    copied
      ? 'Sensor JSON copied. Open a PR against opensmell/opensmell adding it to the sensor library, or share it on Discord.'
      : 'Select the JSON below, copy it, then open a PR against opensmell/opensmell (or share it on Discord).',
    6000);
});

// Explain where the calibration constants come from and how to make them honest.
document.getElementById('calibInfo')!.addEventListener('click', () => {
  showToast(
    'Constants: R₀, a, b come from the datasheet power-law curve for each sensor (see the Sensor Library for typical values). '
    + 'That curve is a datasheet approximation, not a lab-grade reference, so a ppm figure here is an estimate — treat it as '
    + 'an order-of-magnitude guide. For trustworthy numbers, recalibrate R₀ against a known gas concentration on your own rig.',
    9000);
});

// Re-render the calibration panel whenever the channel set changes.
function refreshCalibrationViews() {
  renderCalibration();
  renderSensorLibrary((document.getElementById('sensorLibSearch') as HTMLInputElement)?.value || '');
}

// Open external http(s) links in the user's default browser. Tauri 2 routes
// `window.open` for remote http(s) URLs to the system browser by default.
// Falls back to testless handling and absorbs failures so a missing browser
// never breaks the rest of the UI.
function openExternal(url: string): void {
  try {
    const opener = window.open(url, '_blank', 'noopener, noreferrer');
    if (opener) opener.opener = null;
  } catch { /* ignore */ }
}
document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest?.('a');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (/^https?:\/\//i.test(href)) {
    e.preventDefault();
    openExternal(href);
  }
});

// === Init ===
// --- Boot loader ---
// The #bootOverlay is rendered by static HTML before this script runs, so the
// window is never blank. These helpers log progress as the UI initializes and
// then fade the overlay away once the core is wired up.
function bootLog(msg: string): void {
  const log = document.getElementById('bootLog');
  if (!log) return;
  const line = document.createElement('div');
  line.className = 'boot-line';
  line.textContent = msg;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  // Keep only the last ~8 lines so the log stays compact.
  while (log.children.length > 8) log.removeChild(log.firstChild!);
}
function bootDone(): void {
  (window as any).__osmographBootReady = true;
  bootLog('ready');
  setTimeout(() => {
    const ov = document.getElementById('bootOverlay');
    if (ov) { ov.classList.add('done'); setTimeout(() => ov.remove(), 260); }
  }, 120);
}
bootLog('initializing UI…');
bootLog('scanning ports…');
refreshPorts().then(() => maybeAutoReconnect());

// Restore the last connection and, for serial, reconnect automatically once the
// remembered port shows up (Python parity). Non-critical — silently no-ops
// when nothing is remembered or plugged in.
let autoReconnectDone = false;
function maybeAutoReconnect() {
  const stored = restoreLastConnection();
  if (!stored || autoReconnectDone) return;
  autoReconnectDone = true;
  const modeSel = document.getElementById('modeSelect') as HTMLSelectElement;
  const wifi = document.getElementById('wifiAddr') as HTMLInputElement;
  const wifiScan = document.getElementById('wifiScan') as HTMLSelectElement;
  const ble = document.getElementById('bleSelect') as HTMLSelectElement;
  if (stored.mode && (stored.mode === 'serial' || stored.mode === 'wifi' || stored.mode === 'ble')) {
    modeSel.value = stored.mode;
    wifi.style.display = stored.mode === 'wifi' ? '' : 'none';
    wifiScan.style.display = stored.mode === 'wifi' ? '' : 'none';
    ble.style.display = stored.mode === 'ble' ? '' : 'none';
    if (stored.mode === 'wifi') void scanWifiDevices();
  }
  if (stored.mode === 'wifi' && stored.addr) {
    wifi.value = stored.addr;
  }
  if (stored.mode === 'ble') {
    if (stored.ble) {
      (document.getElementById('bleSelect') as HTMLSelectElement).value = stored.ble;
    }
  }
  if (stored.mode !== 'serial') return;
  const baudSel = document.getElementById('baudSelect') as HTMLSelectElement;
  if (stored.baud) {
    try { baudSel.value = stored.baud; } catch { /* not a valid option */ }
  }
  const sel = document.getElementById('portSelect') as HTMLSelectElement;
  const present = stored.port && Array.from(sel.options).some(o => o.value === stored.port);
  if (!present) return; // device not plugged in — user picks it manually; no nag
  sel.value = stored.port;
  toggleConnection();
}
animate();
loadCalibration();
loadHardwareProfile();
wireHardwareProfile();
onPresetChange('auto');
renderHardwareProfile();
applyCustomNames();
renderSensorLibrary();
// Core UI is wired and the window is interactive — hand control over now and
// let the idempotent data fills below finish behind the fading boot overlay.
bootLog('core wired');
bootDone();

updateBuzzerPreviews();
updateOledPreview();
renderFleet();
refreshToolchain();
reloadLibrary();
refreshTrainLibrary();
renderLiveState();
refreshBurnIn();
refreshPlugins();
refreshDataPanel();
setTimeout(() => { refreshDataPanel().then(refreshHub).catch(() => {}); }, 200);

// Fit the window to the screen: never let it overstretch past the monitor's
// work area. Degrades silently when the core doesn't grant window sizing.
async function fitWindowToScreen() {
  try {
    const { getCurrentWindow, currentMonitor } = await import('@tauri-apps/api/window');
    const { LogicalSize } = await import('@tauri-apps/api/dpi');
    const win = getCurrentWindow();
    const mon = await currentMonitor();
    if (!mon) return;
    const work = mon.size;
    const w = Math.min(1320, Math.max(720, work.width - 48));
    const h = Math.min(880, Math.max(560, work.height - 96));
    await win.setSize(new LogicalSize(w, h));
    await win.center();
  } catch { /* not granted in this build — keep the configured window */ }
}
fitWindowToScreen();
