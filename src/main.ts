import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import { DATASET_CATALOG, REFERENCE_CATALOG, type DatasetEntry, type DatasetFormat } from './datasets';
import * as Domain from './domainPacks';
import * as VialHost from './vialHost';
import * as VialRuntime from './vialRuntime';
import * as VialProfile from './vialProfile';
import { fetchVialRegistry, type RegistryVialEntry } from './vialRegistry';
import { GUIDE_SECTIONS, guideSection } from './guide';

// Read a design token from :root once; canvas code must not re-hardcode the
// same colors the CSS already owns, or a future theme change silently forks.
// Declared before PALETTE_ANCHORS, which calls it during module evaluation.
const CSS_TOKEN_CACHE = new Map<string, string>();
function cssToken(name: string): string {
  let v = CSS_TOKEN_CACHE.get(name);
  if (!v) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#000000';
    CSS_TOKEN_CACHE.set(name, v);
  }
  return v;
}

// === Constants ===
const MAX_TRACE = 800;
const MAX_HISTORY = 20000; // long rolling history for scrub / rewind (beyond the 800-sample view)
const LIVE_WINDOW_DEFAULT = 800; // default trailing-sample window; reset-zoom target
// Cool, distinguishable trace palette (cyan→blue→indigo→violet) that stays
// readable on the warm paper canvas without going rainbow. The first 8 entries
// are the hand-tuned anchor hues; anything beyond is generated on the fly so
// every channel (up to 64) gets its own distinct color.
const PALETTE_ANCHORS = ['#0891b2', '#4338ca', cssToken('--cyan'), '#2563eb', '#06b6d4', '#7c3aed', '#164e63', '#93c5fd'];
let lastAnomalyKey = '';  // anomaly-card state key: only re-stamp DOM when this CHANGES
// Wall-clock of the moment this session's detector baseline finished warming.
// Feeds the vial contract's baseline.ageSec; null until actually observed, so
// the contract never ships an invented age.
let baselineReadyAt: number | null = null;

// Rolling per-channel health verdict from Rust, captured by the 2 s
// updateSensorHealth() side panel poll and consumed by the vial snapshot.
// Expiry (20 s without a successful poll) falls back to 'unknown' rather than
// reusing a stale verdict.
type ChannelHealth = 'ok' | 'stuck' | 'saturated' | 'noisy' | 'unknown';
let sensorHealthCache: SensorHealthInfoApi[] | null = null;
let sensorHealthAt = 0;

/** Map the Rust health ladder onto the vial contract enum. Rust reports one
 *  status string per channel plus the measurements behind it, so CRITICAL
 *  (drift OR noise) resolves to whichever measurement drove it. */
function healthEnumFor(channel: number): ChannelHealth {
  if (!sensorHealthCache || Date.now() - sensorHealthAt > 20000) return 'unknown';
  const h = sensorHealthCache.find(x => x.channel === channel);
  if (!h) return 'unknown';
  if (h.stuck || h.status === 'FAILED') return 'stuck';
  if (h.status === 'OK') return 'ok';
  if (h.status === 'CRITICAL') return h.cv >= h.drift_rate ? 'noisy' : 'saturated';
  if (h.status === 'WARNING') return 'noisy';
  return 'unknown';
}
let lastAnomalyReading: {
  state: VialHost.AnomalyState;
  score: number | null;
  confidence: number | null;
  alertLevel: number;
  triggeredChannels: number;
  consecutive: number;
  warming: boolean;
  baselineProgress: number;
} = {
  state: 'unknown', score: null, confidence: null, alertLevel: 0,
  triggeredChannels: 0, consecutive: 0, warming: false, baselineProgress: 0,
};

/** A Vial's own detector verdict, keyed by Vial id. The base app keeps its
 *  detector; a Vial profile never mutates the global one. */
interface VialDetectorResult {
  is_anomaly: boolean;
  anomaly_votes: number;
  max_confidence: number;
  raw_score: number;
  calibrated_confidence: number;
  triggered_channels: number[];
  max_delta: number;
  alert_level: number;
  alert_name: string;
  consecutive_anomalies: number;
  anomalous_seconds: number;
  sensor_failures: unknown[];
  degraded_sensors: number[];
  warming_up: boolean;
  baseline_progress: number;
  smoothed: number[];
}
const vialDetectorResults = new Map<string, VialDetectorResult>();
const vialDetectorResets = new Map<string, Promise<unknown>>();

/** Compile a Vial's declared profile into its own Rust detector. The base
 *  app's detection config is read once for the legacy fields and never
 *  mutated, so two Vials can run different persistence and escalation. */
async function syncVialDetector(pack: Domain.DomainPack, reset = false): Promise<void> {
  if (!pack.anomaly) {
    vialDetectorResults.delete(pack.id);
    return;
  }
  try {
    const pendingReset = vialDetectorResets.get(pack.id);
    if (pendingReset) await pendingReset;
    if (reset) await resetVialDetector(pack.id);
    const base = await invoke<Record<string, unknown>>('detection_get_config');
    const merged = { ...base, ...VialProfile.profileToDetectorConfig(pack.anomaly) };
    await invoke('vial_detection_set_config', {
      vialId: pack.id,
      channels: Math.max(1, chNames.length || 1),
      config: merged,
    });
  } catch (error) {
    console.error('vial_detection_set_config failed', error);
  }
}

function openVialPacks(): Domain.DomainPack[] {
  const packs = [activeVialRuntime?.pack, homeVialRuntime?.pack]
    .filter((pack): pack is Domain.DomainPack => !!pack);
  const seen = new Set<string>();
  return packs.filter((pack) => {
    if (seen.has(pack.id)) return false;
    seen.add(pack.id);
    return true;
  });
}

/** Recompile every open Vial after a rig layout change. A Vial opened before
 *  the device announced its width must not keep a detector built for the
 *  placeholder channel count. */
function syncOpenVialDetectors(reset = false): void {
  for (const pack of openVialPacks()) {
    if (pack.anomaly) void syncVialDetector(pack, reset);
  }
}

/** Feed one reading to a Vial detector. The result is read by the next host
 *  snapshot; a failed call leaves the previous verdict in place. */
async function feedVialDetector(pack: Domain.DomainPack, reading: number[]): Promise<void> {
  if (!pack.anomaly || !connected) return;
  try {
    const result = await invoke<VialDetectorResult>('vial_detection_ingest', {
      vialId: pack.id,
      reading,
    });
    vialDetectorResults.set(pack.id, result);
  } catch (error) {
    if (import.meta.env.DEV) console.error('vial_detection_ingest failed', error);
  }
}

// === Change Log (single-unit, label-free) ===
// The live detector flags deviations from a learned baseline with no labels —
// the one thing a lone device can honestly do. We turn those transient flags
// into a record: what changed, when, for how long, how many channels moved.
interface ChangeEvent { start: number; end: number; peak: number; channels: number[]; alert: string; }
let changeLog: ChangeEvent[] = [];
let openChange: { start: number; peak: number; channels: Set<number>; alert: string } | null = null;
const CHANGE_LOG_KEY = 'osmograph.changeLog';
function loadChangeLog() {
  try { changeLog = JSON.parse(localStorage.getItem(CHANGE_LOG_KEY) || '[]'); } catch { changeLog = []; }
}
function saveChangeLog() {
  try { localStorage.setItem(CHANGE_LOG_KEY, JSON.stringify(changeLog.slice(0, 50))); } catch { /* ignore */ }
}
function clFmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function clFmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
function renderChangeLog() {
  const el = document.getElementById('changeLog');
  if (!el) return;
  const rows: string[] = [];
  if (openChange) {
    rows.push(`<div class="cl-row cl-open"><span class="cl-time">${clFmtTime(openChange.start)}</span>` +
      `<span class="cl-badge">ongoing</span>` +
      `<span class="cl-meta">peak ${openChange.peak.toFixed(1)} · ${openChange.channels.size} ch</span></div>`);
  }
  for (const ev of changeLog) {
    rows.push(`<div class="cl-row"><span class="cl-time">${clFmtTime(ev.start)}</span>` +
      `<span class="cl-badge${ev.alert === 'critical' ? ' crit' : ''}">${ev.alert}</span>` +
      `<span class="cl-meta">${clFmtDur(ev.end - ev.start)} · ${ev.channels.length} ch · peak ${ev.peak.toFixed(1)}</span></div>`);
  }
  el.innerHTML = rows.length ? rows.join('') : '<div class="cl-empty">No events recorded yet.</div>';
}

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
  // The live trace and crosshair plot the raw ADC counts the rig sends; the
  // normalized ΔR/R₀ is computed for fingerprints and comparisons, not here.
  analog_mox: { unit: 'ADC', tag: 'MOX' },
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
let activePort = '';
let activeBaud = 0;
type SerialPortInfo = { name: string; description: string; kind: string; hw_type: string; manufacturer: string };
let knownPorts: SerialPortInfo[] = [];
let channelCount = 0;
let sessionStart: number | null = null;
let sampleCount = 0;
let lastSampleTime = 0;
let lastDataAt = 0; // wall-clock of the last successfully-ingested reading (stall watchdog)
let gotLiveData = false; // any valid reading genuinely ingested this link
let bootloaderHinted = false; // device answered in bootloader during the current link session
let bootFlashShown = false;   // the Flash modal was already auto-offered during this bootloader stall
// Firmware `collectBaseline()` runs ~30 s silent (300 samples @ 100 ms) after
// boot; stall past 35 s before ever suggesting the board is stuck unflashed.
const BOOT_STALL_MS = 35000;
let autoChannels = 0;         // channel count auto-detected from the live device stream (0 = none yet)
let activePreset = '6-sensor-full';
// Board type per serial port, from the last port refresh, so flashing can pick
// the right firmware/toolchain: 'esp32' | 'arduino_uno' | '' (unknown).
const portBoardMap = new Map<string, string>();
// Raw USB kind per port ('osmograph-e-nose' | 'arduino_uno' | 'ch340' |
// 'unknown-usb' | ...) so the UI can explain *why* flashing is held up.
const portKindMap = new Map<string, string>();

// Plain-language description of a raw USB kind (used in port labels and in the
// "board not identified" fences so a held-up flash explains itself).
function kindLabel(kind: string): string {
  if (kind === 'osmograph-e-nose' || kind === 'esp32') return 'ESP32 e-nose';
  if (kind === 'arduino_uno') return 'Arduino Uno';
  if (kind === 'raspberry_pi_pico') return 'Raspberry Pi Pico';
  if (kind === 'ch340') return 'CH340 adapter — could be an ESP32 OR an Arduino Nano';
  if (kind && kind !== 'unknown-usb') return kind.replace(/_/g, ' ');
  return 'USB-serial (unrecognised)';
}

// Board a port resolves to for flashing/erasing: an explicit manual override
// wins; otherwise only a definitive VID:PID detection counts. Never falls back
// to a guessed ESP32 — an unconfirmed (or CH340-ambiguous) target returns ''
// so the caller must ask the user to pick the board first.
function resolvedBoard(port: string, manual: string): string {
  if (manual === 'esp32' || manual === 'arduino_uno') return manual;
  return port ? portBoardMap.get(port) || '' : '';
}
let chNames: string[] = PRESETS['6-sensor-full'].sensors;
// Fixed-size rolling buffers: push is O(1) regardless of window length (no
// array `shift` memmove on every sample). Reads mirror the array surface the
// trace renderer uses: length / map / slice / last.
class RingBuffer {
  private buf: Float64Array;
  private start = 0;
  private size = 0;
  constructor(readonly capacity: number) {
    this.buf = new Float64Array(capacity);
  }
  get length(): number { return this.size; }
  push(v: number): void {
    if (this.size < this.capacity) {
      this.buf[(this.start + this.size) % this.capacity] = v;
      this.size++;
    } else {
      this.buf[this.start] = v;
      this.start = (this.start + 1) % this.capacity;
    }
  }
  last(): number { return this.size ? this.buf[(this.start + this.size - 1) % this.capacity] : NaN; }
  slice(from: number = 0, to: number = this.size): number[] {
    if (this.size === 0 || to <= from) return [];
    const a = Math.max(0, from), b = Math.min(this.size, to);
    const out = new Array(b - a);
    for (let i = a; i < b; i++) out[i - a] = this.buf[(this.start + i) % this.capacity];
    return out;
  }
  map<T>(fn: (v: number) => T): T[] {
    const out = new Array<T>(this.size);
    for (let i = 0; i < this.size; i++) out[i] = fn(this.buf[(this.start + i) % this.capacity]);
    return out;
  }
}
function newTraceChannels(count: number): RingBuffer[] {
  return Array.from({ length: count }, () => new RingBuffer(MAX_TRACE));
}
function newHistoryChannels(count: number): RingBuffer[] {
  return Array.from({ length: count }, () => new RingBuffer(MAX_HISTORY));
}
let traceData: RingBuffer[] = newTraceChannels(chNames.length);
// History ring: a longer rolling buffer (independent of the 800-sample display
// window) so the user can rewind / scrub / fast-forward through recent history.
let historyData: RingBuffer[] = newHistoryChannels(chNames.length);
let liveScrollSeek = 0;      // samples back from the newest sample the view is anchored at (0 = live)
let isLiveScrubbing = false; // a scrub is dragging / or user rewound: show frozen history window
// Trading-view style hover crosshair + geometry captured each draw for mapping
// cursor -> sample / value, plus interactive legend hover-highlight.
let cursorPX = -1, cursorPY = -1;
let traceDirty = true; // set when new samples / crosshair motion arrive; gates re-renders
let lastTraceDraw = 0;
let hoverSeries = -1; // legend chip hovered: highlight that channel's trace
let lastPlotGeo: { wlen: number; gMin: number; gMax: number; slices: number[][] } | null = null;
let lastSilentKey = '';

// Live transport controls (pause / clear / time-window zoom). Pausing freezes
// the visible plot on a snapshot; ingestion keeps a live copy, and every
// frame we draw either the frozen view or the current buffer.
let livePaused = false;
let frozenTrace: number[][] = [];
let liveWindowSamples = 800; // trailing samples drawn on the x-axis
let liveRateHz = 20;         // updated from measured sample timing, falls back to 20
let sessionLabels: { ts: number; anomaly: boolean; note: string }[] = [];let sessions: SessionRecord[] = [];
let libSearchDebounce: number | null = null;
let selectedSession: number | null = null;
let compareFiles: string[] = [];
const compareSeriesCache = new Map<string, SessionSeries | null>();
let compareLoaded: (SessionSeries | null)[] = [];
let activeCompareChannels: string[] = [];
let compareMode: 'overlay' | 'delta' | 'heatmap' | 'trajectory' = 'overlay';
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
  preparation?: string;
  role?: string;
  label: string;
  format: string;
  duration: string;
  sensors: number;
  quality: number;
  path?: string;
  file_id?: string;
  quality_report?: QualityReport | null;
  collection_id?: string;
  collection_name?: string;
  split?: string;
  condition?: string;
  /** Present only when the source path names a composition. A mixture is one
   *  recording with components, not several smell classes. */
  mixture?: { name: string; fraction?: number | null }[];
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

// === Workspace router ===
// The app is organised by jobs, not implementation buckets:
// observe (Home), browse (Explore), analyse, run a domain workspace (Vials),
// manage hardware (Rigs), configure (Settings). Public corpora, raw recordings,
// and smell cards live together in Explore: a dataset is not a separate job.
type WorkspaceKey = 'dashboard' | 'explore' | 'analyse' | 'vials' | 'rig' | 'settings';
interface SourceViewSpec { workspace: WorkspaceKey; id: string; }
const SOURCE_VIEWS: Record<string, SourceViewSpec> = {
  smells: { workspace: 'explore', id: 'src-smells' },
  compare: { workspace: 'analyse', id: 'panel-compare' },
  check: { workspace: 'analyse', id: 'src-check' },
  recipes: { workspace: 'analyse', id: 'panel-recipe' },
  train: { workspace: 'analyse', id: 'panel-train' },
  changelog: { workspace: 'analyse', id: 'src-changelog' },
  vials: { workspace: 'vials', id: 'src-vials' },
  sessions: { workspace: 'explore', id: 'src-sessions' },
  datasets: { workspace: 'explore', id: 'src-datasets' },
  fleet: { workspace: 'rig', id: 'panel-fleet' },
  system: { workspace: 'settings', id: 'panel-system' },
};
const WORKSPACE_DEFAULT: Record<WorkspaceKey, string> = {
  dashboard: 'dashboard', explore: 'smells', analyse: 'compare', vials: 'vials',
  rig: 'fleet', settings: 'system',
};
const workspaceLastView: Partial<Record<WorkspaceKey, string>> = {};

function installWorkspaceShell(): void {
  const move = (id: string, parentId: string): void => {
    const node = document.getElementById(id);
    const parent = document.getElementById(parentId);
    if (node && parent) parent.appendChild(node);
  };
  move('src-smells', 'exploreBody');
  move('src-sessions', 'exploreBody');
  move('src-datasets', 'exploreBody');
  move('panel-compare', 'analyseBody');
  move('src-check', 'analyseBody');
  move('panel-recipe', 'analyseBody');
  move('panel-train', 'analyseBody');
  move('src-changelog', 'analyseBody');
  move('src-vials', 'panel-vials');
  move('panel-fleet', 'rigBody');
  move('panel-system', 'panel-settings');
  // Panels that used to be top-level tabs are now views inside a workspace.
  for (const id of ['panel-compare', 'panel-fleet', 'panel-system', 'panel-train', 'panel-recipe']) {
    const node = document.getElementById(id);
    if (!node) continue;
    node.classList.remove('tab-panel');
    node.classList.add('workspace-view');
  }
}

function activateWorkspace(ws: WorkspaceKey): void {
  const panel = document.getElementById(`panel-${ws}`);
  if (!panel) return;
  document.body.dataset.workspace = ws;
  document.querySelectorAll<HTMLElement>('.content > .tab-panel').forEach(p => p.classList.remove('active'));
  panel.classList.add('active');
  document.querySelectorAll<HTMLElement>('.tab-btn[data-tab]').forEach(b => b.classList.remove('active'));
  document.querySelector<HTMLElement>(`.tab-btn[data-tab="${ws}"]`)?.classList.add('active');
  if (ws === 'dashboard') {
    requestAnimationFrame(() => {
      resizeTraces();
      redrawFingerprintIfReady();
    });
  }
}

function showWorkspaceView(src: string): void {
  const spec = SOURCE_VIEWS[src];
  if (!spec) return;
  activateWorkspace(spec.workspace);
  document.querySelectorAll<HTMLElement>('.src-view, .workspace-view').forEach(v => v.classList.remove('active'));
  document.getElementById(spec.id)?.classList.add('active');
  document.querySelectorAll<HTMLElement>('.src-subnav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.src === src);
  });
  workspaceLastView[spec.workspace] = src;

  if (src === 'smells') void renderSmellGallery();
  else if (src === 'compare') requestAnimationFrame(() => updateCompare());
  else if (src === 'check') void renderCheckView(true);
  else if (src === 'recipes') void refreshRecipes();
  else if (src === 'changelog') renderChangeLog();
  else if (src === 'vials') renderVials();
  else if (src === 'sessions') renderLibrary();
  else if (src === 'datasets') renderDatasetCatalog();
  else if (src === 'fleet') renderFleet();
}

function showWorkspaceDefault(ws: WorkspaceKey): void {
  if (ws === 'dashboard') {
    activateWorkspace(ws);
    return;
  }
  showWorkspaceView(workspaceLastView[ws] || WORKSPACE_DEFAULT[ws]);
}

installWorkspaceShell();

// Top-level navigation.
document.querySelectorAll<HTMLElement>('.tab-btn[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab!;
    if (tab === 'explore' || tab === 'analyse' || tab === 'vials' || tab === 'rig' || tab === 'settings') {
      showWorkspaceDefault(tab as WorkspaceKey);
      return;
    }
    activateWorkspace(tab as WorkspaceKey);
  });
});

// Local workspace subnavs and their hidden legacy controls all route through
// the same source-view registry.
document.querySelectorAll<HTMLElement>('.src-subnav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const src = btn.dataset.src;
    if (src) showWorkspaceView(src);
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

// === PNG export: share artifacts without a screenshot ===
async function exportCanvasPng(canvas: HTMLCanvasElement | null, defaultName: string) {
  if (!canvas || !canvas.width || !canvas.height) return;
  const { save } = await import('@tauri-apps/plugin-dialog');
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (!path) return;
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#0f1115';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  await invoke<string>('save_png_data_url', { path, dataUrl: out.toDataURL('image/png') });
}
document.getElementById('exportTracesPng')?.addEventListener('click', () =>
  exportCanvasPng(document.getElementById('traces') as HTMLCanvasElement, 'osmograph-traces.png'));
document.getElementById('exportFingerprintPng')?.addEventListener('click', () =>
  exportCanvasPng(document.getElementById('fingerprint') as HTMLCanvasElement, 'osmograph-fingerprint.png'));

// === First-run wizard (shown once, dismissed forever) ===
(function initFirstRunWizard() {
  const KEY = 'osmograph.wizard.seen.v1';
  const wiz = document.getElementById('wizard');
  if (!wiz) return;
  try { if (localStorage.getItem(KEY) === '1') return; } catch { return; }
  const slides = wiz.querySelectorAll('.wslide');
  const dots = wiz.querySelectorAll('.wdot');
  const back = document.getElementById('wizardBack') as HTMLButtonElement;
  const next = document.getElementById('wizardNext') as HTMLButtonElement;
  let step = 0;
  const draw = () => {
    slides.forEach((s, i) => s.classList.toggle('active', i === step));
    dots.forEach((d, i) => d.classList.toggle('active', i === step));
    back.style.display = step > 0 ? '' : 'none';
    next.textContent = step === slides.length - 1 ? 'Get started' : 'Next';
  };
  const close = () => {
    wiz.style.display = 'none';
    try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ }
  };
  document.getElementById('wizardSkip')?.addEventListener('click', close);
  next.addEventListener('click', () => {
    if (step < slides.length - 1) { step++; draw(); }
    else { close(); void showWorkspaceView('smells'); }
  });
  back.addEventListener('click', () => { if (step > 0) { step--; draw(); } });
  draw();
  wiz.style.display = 'flex';
})();

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

  tracesCtx.fillStyle = cssToken('--bg-1');
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
      tracesCtx.fillStyle = cssToken('--text-3');
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
    if (major && x < gutterL + pw - 30) {
      // Seconds ago relative to NOW: the window's right edge sits
      // `liveScrollSeek` samples back from the newest when rewound.
      const secs = Math.round((liveScrollSeek + (wlen - s)) / liveRateHz);
      tracesCtx.fillStyle = cssToken('--text-3');
      tracesCtx.fillText(`${secs}s`, x, ph + 4);
    }
  }
  // Tick alignment can skip the right edge, which made the axis read as if it
  // ended in the past ("65s … 21s"). Name the present explicitly.
  const rightSecs = Math.round(liveScrollSeek / liveRateHz);
  tracesCtx.textAlign = 'right';
  tracesCtx.fillStyle = cssToken('--text-3');
  tracesCtx.fillText(rightSecs <= 0 ? 'now' : `${rightSecs}s ago`, gutterL + pw - 2, ph + 4);
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

  // Silent = every visible sample is exactly zero. Name it in the legend; the
  // flat line stays (honest) but no longer reads as a live measurement.
  const silentKey = slices.map(s => s.length >= 5 && s.every(v => v === 0) ? '1' : '0').join('');
  if (silentKey !== lastSilentKey) {
    lastSilentKey = silentKey;
    document.querySelectorAll<HTMLElement>('#traceLegend .tl-chip').forEach((chip) => {
      const ch = parseInt(chip.dataset.ch || '-1', 10);
      chip.classList.toggle('tl-silent', silentKey[ch] === '1');
    });
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
  tracesCtx.fillStyle = cssToken('--bg-1');
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
    const ppm = c >= 0 ? calibratedPPM(c, v) : null;
    // The datasheet curve is an order-of-magnitude heuristic at best, so the
    // readout never implies precision: magnitude-rounded, flagged "est.",
    // never more than two significant figures.
    const ppmTag = ppm !== null
      ? `<span class="xr-ppm" title="Datasheet-curve estimate — not a lab figure, not a calibrated measurement">≈ ${ppm >= 1000 ? `${Math.round(ppm / 100) / 10}k` : ppm >= 100 ? Math.round(ppm / 10) * 10 : ppm >= 10 ? Math.round(ppm / 2) * 2 : ppm >= 1 ? Math.round(ppm * 2) / 2 : ppm.toFixed(1)} ppm est.</span>`
      : '';
    return `<span class="xr-item"><i class="xr-dot" style="background:${color}"></i>${name} <b>${label} ${unit}</b>${ppmTag}</span>`;
  }).join('');
  el.innerHTML = n;
}

// === Canvas: Fingerprint (radar) ===
const fpCanvas = document.getElementById('fingerprint') as HTMLCanvasElement;
const fpCtx = fpCanvas.getContext('2d')!;
// One shared peak for the live radar (peak-hold with slow decay), matching how
// a recorded fingerprint is scaled. Per-channel normalization made every
// channel look equally responsive: the shape could never say "CH6 moved 4×
// more than CH1", which is the only thing the radar is for.
let fingerprintPeak = 0;
// Where the values currently ON the radar came from. The radar is a live-
// monitoring surface; a replayed recording may drive it, but then the stamp
// says REPLAY — cyan never marks replayed data, and a connected rig always
// wins the canvas over replay so the two never flicker-fight at 10 Hz.
type FpSource = 'live' | 'replay' | 'capture' | 'idle';
let fpSource: FpSource = 'idle';
let lastFpValues: number[] | null = null;

// Live response baseline: the mean of this link's first samples, frozen until
// the next connect. Raw ADC magnitudes are near-identical across MQ channels,
// so normalizing by them drew a full hexagon no matter what the array smelled.
let liveBaseline: number[] | null = null;
let liveBaselineSum: number[] = [];
let liveBaselineN = 0;
const LIVE_BASELINE_SAMPLES = 30;

function resetLiveBaseline(): void {
  liveBaseline = null;
  liveBaselineSum = [];
  liveBaselineN = 0;
  fingerprintPeak = 0;
}

function liveResponse(values: number[]): number[] {
  if (liveBaselineSum.length !== values.length) {
    liveBaseline = null;
    liveBaselineSum = new Array(values.length).fill(0);
    liveBaselineN = 0;
  }
  if (!liveBaseline) {
    liveBaselineN += 1;
    for (let i = 0; i < values.length; i++) {
      liveBaselineSum[i] = (liveBaselineSum[i] || 0) + (Number.isFinite(values[i]) ? values[i] : 0);
    }
    if (liveBaselineN >= LIVE_BASELINE_SAMPLES) {
      liveBaseline = liveBaselineSum.map(s => s / liveBaselineN);
    }
  }
  const base = liveBaseline;
  return values.map((v, i) => {
    const r0 = base ? base[i] : 0;
    return r0 > 0 && Number.isFinite(v) ? (v - r0) / r0 : 0;
  });
}

const FP_SOURCE_META: Record<FpSource, { text: string; cls: string; title: string }> = {
  live: { text: 'LIVE', cls: 'fp-source live', title: 'Live per-channel response (ΔR/R₀) against the first 30 samples of this link' },
  replay: { text: 'REPLAY', cls: 'fp-source replay', title: 'Replayed recording — not live data; the detector is not evaluating it' },
  capture: { text: 'CAPTURE', cls: 'fp-source capture', title: 'Tail of previously captured samples — no rig connected' },
  idle: { text: '—', cls: 'fp-source', title: 'No data has reached the radar yet' },
};

function currentFpSource(): FpSource {
  if (connected) return 'live';
  const replayOpen = document.getElementById('replayPanel')?.style.display !== 'none';
  if (replayOpen && replaySeries) return 'replay';
  return historyData.some(ch => ch.length > 0) ? 'capture' : 'idle';
}

/** Re-evaluate which source the radar reflects and keep the stamp, tooltip and
 *  pixels in agreement. Cheap enough to call every second and after each draw. */
function refreshFpSource(): void {
  const next = currentFpSource();
  if (next === fpSource) return;
  const meta = FP_SOURCE_META[next];
  const el = document.getElementById('fpSource');
  if (el) {
    if (el.textContent !== meta.text) el.textContent = meta.text;
    el.className = meta.cls;
    el.title = meta.title;
  }
  const was = fpSource;
  fpSource = next;
  // Redraw so the canvas shape matches the stamp, not just the label.
  if (lastFpValues && was !== 'idle' && next !== 'idle') drawFingerprint(lastFpValues);
}

function drawFingerprint(values: number[]) {
  lastFpValues = values.slice();
  const rect = fpCanvas.parentElement!.getBoundingClientRect();
  // A hidden tab reports a 0×0 box; sizing the canvas there bakes a 1-px-wide
  // buffer that CSS then stretches into a sliver. Keep the values and wait for
  // the ResizeObserver below to fire once the dock is actually visible.
  if (rect.width < 40 || rect.height < 40) return;
  fpCanvas.width = Math.max(1, Math.floor(rect.width - 8));
  fpCanvas.height = Math.max(80, Math.floor(rect.height - 8));
  const w = fpCanvas.width, h = fpCanvas.height;
  const cx = w / 2, cy = h / 2, r = Math.min(cx, cy) - 10;
  fpCtx.clearRect(0, 0, w, h);

  const n = values.length || chNames.length;
  if (n === 0) return;

  // Grid rings
  for (let ring = 1; ring <= 4; ring++) {
    fpCtx.strokeStyle = cssToken('--border');
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
    fpCtx.strokeStyle = cssToken('--border');
    fpCtx.beginPath();
    fpCtx.moveTo(cx, cy);
    fpCtx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
    fpCtx.stroke();
  }

  if (values.length === 0) return;

  // Shared peak-hold scale: a channel responding three times harder must reach
  // three times farther out. Decay keeps an old burst from flattening the next.
  const peak = values.reduce((m, v) => Math.max(m, Math.abs(v ?? 0)), 0);
  fingerprintPeak = Math.max(fingerprintPeak * 0.99, peak, 1e-4);
  const norms: number[] = values.map(v =>
    Math.min(1, Math.abs(v ?? 0) / fingerprintPeak));

  // Fill — cyan (live monitoring data accent), per the paper & ink discipline
  fpCtx.fillStyle = 'rgba(14, 116, 144, 0.12)';
  fpCtx.strokeStyle = cssToken('--cyan');
  fpCtx.lineWidth = 2;
  fpCtx.beginPath();
  for (let i = 0; i <= n; i++) {
    const idx = i % n;
    const angle = (idx / n) * Math.PI * 2 - Math.PI / 2;
    const norm = norms[idx] ?? 0;
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
    const norm = norms[i] ?? 0;
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

function redrawFingerprintIfReady(): void {
  if (lastFpValues && lastFpValues.length && fpCanvas.offsetParent !== null) {
    drawFingerprint(lastFpValues);
  }
}

// Home's dock is hidden while another tab is open. Without this, a stream that
// arrives entirely in the background leaves the fingerprint canvas at 1×N
// until the next reading — which never comes once the recording stops.
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => redrawFingerprintIfReady()).observe(fpCanvas.parentElement!);
}

// === Canvas: Session Fingerprint ===
// The inspector is a recording-level view, so it must show the recording's
// settled fingerprint immediately — and, as an option, how that fingerprint
// formed over time. Previously this canvas existed but nothing ever drew into
// it, which is why clicking a recording looked empty.
type InspectorFpMode = 'mean' | 'evolution';
let inspectorFpMode: InspectorFpMode = 'mean';
let inspectorSeries: SessionSeries | null = null;
let inspectorFingerprint: { channels: string[]; values: number[] } | null = null;
let inspectorFpToken = 0;

interface EvolutionMatrix {
  channels: string[];
  values: number[][];
  maxAbs: number;
  bins: number;
}

/** Signed, baseline-relative response in equal time bins: rows are channels,
 *  columns are time. This is the fingerprint's transformation, not a mean. */
function buildEvolutionMatrix(s: SessionSeries, bins = 64): EvolutionMatrix {
  const n = s.time.length;
  const width = Math.max(12, Math.min(96, bins));
  const rows: number[][] = [];
  let maxAbs = 1e-9;
  for (let ci = 0; ci < s.channels.length; ci++) {
    const seriesValues = s.values[ci] || [];
    const r0 = compareR0(seriesValues);
    const row: number[] = [];
    for (let b = 0; b < width; b++) {
      if (!r0 || !(r0 > 0)) { row.push(NaN); continue; }
      const start = Math.floor((b / width) * n);
      const end = Math.max(start + 1, Math.floor(((b + 1) / width) * n));
      const seg = seriesValues.slice(start, end)
        .filter(Number.isFinite)
        .map(v => (v - r0) / r0);
      const v = meanOf(seg);
      row.push(v);
      if (Number.isFinite(v)) maxAbs = Math.max(maxAbs, Math.abs(v));
    }
    rows.push(row);
  }
  return { channels: s.channels.slice(), values: rows, maxAbs, bins: width };
}

function evolutionColor(v: number, maxAbs: number): string {
  if (!Number.isFinite(v)) return 'rgba(29,26,22,0.035)';
  const a = Math.min(0.92, 0.07 + 0.85 * Math.min(1, Math.abs(v) / maxAbs));
  return v >= 0 ? `rgba(14,116,144,${a.toFixed(3)})` : `rgba(180,83,9,${a.toFixed(3)})`;
}

/** Heatmap of the signed response. Labels stay at the left; a playhead can be
 *  laid over the time axis for replay. */
function drawEvolutionHeatmap(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  matrix: EvolutionMatrix, opts: { labels?: boolean; playhead?: number | null } = {},
): void {
  if (w <= 0 || h <= 0 || !matrix.channels.length) return;
  const labelW = opts.labels ? Math.min(58, Math.max(34, w * 0.2)) : 0;
  const gridX = x + labelW;
  const gridW = Math.max(1, w - labelW);
  const rowH = h / matrix.channels.length;
  const colW = gridW / matrix.bins;
  ctx.save();
  for (let r = 0; r < matrix.channels.length; r++) {
    const row = matrix.values[r];
    for (let b = 0; b < matrix.bins; b++) {
      ctx.fillStyle = evolutionColor(row[b], matrix.maxAbs);
      ctx.fillRect(gridX + b * colW, y + r * rowH, Math.max(1, colW + 0.4), Math.max(1, rowH + 0.4));
    }
    if (opts.labels) {
      ctx.fillStyle = '#6b6152';
      ctx.font = '7.5px ui-monospace, "SF Mono", Menlo, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const name = matrix.channels[r] || `CH${r + 1}`;
      ctx.fillText(name.length > 10 ? `${name.slice(0, 9)}…` : name, gridX - 4, y + r * rowH + rowH / 2);
    }
  }
  // Zero is the neutral line; a thin rule makes polarity readable.
  ctx.strokeStyle = 'rgba(29,26,22,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(gridX, y);
  ctx.lineTo(gridX, y + h);
  ctx.stroke();
  // Time ticks.
  ctx.fillStyle = '#8a7f6c';
  ctx.font = '7px ui-monospace, "SF Mono", Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('start', gridX, y + h + 2);
  ctx.textAlign = 'right';
  ctx.fillText('end', gridX + gridW, y + h + 2);
  if (opts.playhead != null && Number.isFinite(opts.playhead)) {
    const px = gridX + Math.max(0, Math.min(1, opts.playhead)) * gridW;
    ctx.strokeStyle = 'rgba(8,8,12,0.6)';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(px, y); ctx.lineTo(px, y + h); ctx.stroke();
  }
  ctx.restore();
}

// Playable evolution: scrub/step through the recording and watch the fingerprint
// form. Frame is a 0..1 fraction of the timeline; the caption reports the
// leading movers at the current moment so motion carries information, not
// decoration.
let inspPlaying = false;
let inspFrame = 0;
let inspPlayRaf = 0;
let inspPlayLastTs: number | null = null;
const INSP_BINS = 64;
const INSP_BINS_PER_SEC = 12;

function inspMomentReadout(matrix: EvolutionMatrix, frame: number): string {
  const bin = Math.max(0, Math.min(matrix.bins - 1, Math.floor(frame * matrix.bins)));
  const movers = matrix.channels
    .map((name, r) => ({ name, v: matrix.values[r]?.[bin] }))
    .filter(m => m.v != null && Number.isFinite(m.v))
    .sort((a, b) => Math.abs(b.v!) - Math.abs(a.v!))
    .slice(0, 3);
  if (!movers.length) return 'unmeasured';
  return `at ${Math.round(frame * 100)}% · ${movers.map(m => `${m.name} ${m.v! >= 0 ? '+' : ''}${m.v!.toFixed(2)}`).join(' · ')}`;
}

function inspectorLabelWidth(w: number): number {
  return Math.min(58, Math.max(34, w * 0.2));
}

function stopInspectorPlay(): void {
  inspPlaying = false;
  if (inspPlayRaf) { cancelAnimationFrame(inspPlayRaf); inspPlayRaf = 0; }
  inspPlayLastTs = null;
  const btn = document.getElementById('inspFpPlay');
  if (btn) btn.textContent = '▶ Play';
}

function inspPlayTick(ts: number): void {
  if (!inspPlaying) { inspPlayRaf = 0; return; }
  if (inspPlayLastTs !== null && inspectorSeries) {
    const dt = Math.min(0.2, (ts - inspPlayLastTs) / 1000);
    inspFrame = Math.min(1, inspFrame + (dt * INSP_BINS_PER_SEC) / INSP_BINS);
  }
  inspPlayLastTs = ts;
  drawInspectorFingerprint();
  if (inspFrame >= 1) { stopInspectorPlay(); return; }
  inspPlayRaf = requestAnimationFrame(inspPlayTick);
}

function startInspectorPlay(): void {
  if (!inspectorSeries) { showToast('Select a recording first.'); return; }
  setInspectorFpMode('evolution');
  if (inspFrame >= 1) inspFrame = 0; // replay from the start, not from the end
  inspPlaying = true;
  inspPlayLastTs = null;
  const btn = document.getElementById('inspFpPlay');
  if (btn) btn.textContent = '❚❚ Stop';
  if (!inspPlayRaf) inspPlayRaf = requestAnimationFrame(inspPlayTick);
}

function toggleInspectorPlay(): void {
  if (inspPlaying) stopInspectorPlay();
  else startInspectorPlay();
}

function drawInspectorFingerprint(): void {
  const canvas = document.getElementById('session-fp') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(160, canvas.clientWidth || 240);
  const h = Math.max(120, canvas.clientHeight || 158);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const caption = document.getElementById('inspFpCaption');

  if (!inspectorSeries || !inspectorFingerprint) {
    ctx.fillStyle = '#8a7f6c';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Select a recording', w / 2, h / 2);
    if (caption) caption.textContent = 'Settled response per channel · ΔR/R0';
    return;
  }

  if (inspectorFpMode === 'evolution') {
    const matrix = buildEvolutionMatrix(inspectorSeries!, INSP_BINS);
    drawEvolutionHeatmap(ctx, 0, 0, w, h - 12, matrix, {
      labels: true,
      playhead: inspFrame > 0 || inspPlaying ? inspFrame : null,
    });
    if (caption) caption.textContent = inspFrame > 0 || inspPlaying
      ? inspMomentReadout(matrix, inspFrame)
      : 'Signed response over time · cyan = increase, amber = decrease · play or click to scrub';
    canvas.title = 'Click to scrub — the playhead shows when the fingerprint formed';
  } else {
    drawFingerprintInto(ctx, 0, 0, w, h, inspectorFingerprint.values, inspectorFingerprint.channels, { labels: true });
    if (caption) {
      const n = inspectorFingerprint.channels.length;
      const finite = inspectorFingerprint.values.filter(Number.isFinite).length;
      caption.textContent = `Settled response · ${finite}/${n} channels · ΔR/R0`;
    }
  }
  document.querySelectorAll<HTMLElement>('.fp-mode').forEach(btn => {
    btn.classList.toggle('active', btn.id === (inspectorFpMode === 'mean' ? 'inspFpMean' : 'inspFpEvo'));
  });
}

function setInspectorFpMode(mode: InspectorFpMode): void {
  inspectorFpMode = mode;
  drawInspectorFingerprint();
}

async function renderInspectorFingerprint(s: SessionRecord): Promise<void> {
  const token = ++inspectorFpToken;
  inspectorSeries = null;
  inspectorFingerprint = null;
  // A new recording restarts the story: stop playback, rewind the playhead.
  stopInspectorPlay();
  inspFrame = 0;
  drawInspectorFingerprint();
  if (!s.file_id) return;
  try {
    const series = await invoke<SessionSeries>('load_session_series', { fileId: s.file_id });
    if (token !== inspectorFpToken) return;
    inspectorSeries = series;
    inspectorFingerprint = settledFingerprint(series);
    drawInspectorFingerprint();
  } catch {
    if (token !== inspectorFpToken) return;
    const canvas = document.getElementById('session-fp') as HTMLCanvasElement | null;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(160, canvas.clientWidth || 240), h = Math.max(120, canvas.clientHeight || 158);
        canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#8a7f6c'; ctx.font = '10px -apple-system, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('No readable channel series', w / 2, h / 2);
      }
    }
  }
}

document.getElementById('inspFpMean')?.addEventListener('click', () => { stopInspectorPlay(); setInspectorFpMode('mean'); });
document.getElementById('inspFpEvo')?.addEventListener('click', () => { stopInspectorPlay(); inspFrame = 0; setInspectorFpMode('evolution'); });
document.getElementById('inspFpPlay')?.addEventListener('click', toggleInspectorPlay);

// Scrub: click / drag on the heatmap seeks the playhead (evolution mode only).
// Label gutter is subtracted so the seek ratio matches the drawn time axis.
let inspScrubbing = false;
(function inspScrubWiring() {
  const canvas = document.getElementById('session-fp') as HTMLCanvasElement | null;
  if (!canvas) return;
  const seek = (ev: PointerEvent | MouseEvent) => {
    if (inspectorFpMode !== 'evolution' || !inspectorSeries) return;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(160, canvas.clientWidth || 240);
    const frac = (ev.clientX - rect.left - inspectorLabelWidth(w)) / Math.max(1, w - inspectorLabelWidth(w));
    inspFrame = Math.max(0, Math.min(1, frac));
    drawInspectorFingerprint();
  };
  canvas.addEventListener('pointerdown', (ev) => {
    if (inspPlaying) stopInspectorPlay();
    inspScrubbing = true;
    canvas.setPointerCapture(ev.pointerId);
    seek(ev);
  });
  canvas.addEventListener('pointermove', (ev) => { if (inspScrubbing) seek(ev); });
  canvas.addEventListener('pointerup', () => { inspScrubbing = false; });
})();

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
  lastSilentKey = '';
  el.innerHTML = chNames.map((name, i) => {
    const k = kindOf(i);
    const meta = KIND_META[k];
    return `<span class="tl-chip" data-ch="${i}" title="${name} · ${meta.tag} (${meta.unit}) — hover to isolate, click the eye to toggle, ✎ to rename"><span class="swatch" style="background:${channelColor(i)}"></span><span class="tl-eye" title="Show / hide this sensor">◉</span><span class="tl-kind" title="${meta.tag}">${KIND_GLYPH[k]}</span>${name}<span class="tl-unit">${meta.unit}</span><span class="tl-edit" title="Rename this channel / set its sensor kind">✎</span></span>`;
  }).join('');
  updatePlotScaleNote();
  el.querySelectorAll<HTMLElement>('.tl-chip').forEach((chip) => {
    const c = parseInt(chip.dataset.ch || '-1', 10);
    chip.addEventListener('mouseenter', () => { hoverSeries = c; });
    chip.addEventListener('mouseleave', () => { hoverSeries = -1; });
    chip.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.tl-edit')) return;
      if (c < 0) return;
      if (hiddenChannels.has(c)) hiddenChannels.delete(c); else hiddenChannels.add(c);
      syncLegendState(chip, c);
    });
    const edit = chip.querySelector('.tl-edit');
    if (edit) edit.addEventListener('click', (e) => { e.stopPropagation(); editChannelInline(chip, c); });
  });
}

// Inline channel rename + sensor-kind picker on the live legend (✎). Commits
// the name and kind into the shared hardware profile so Settings, calibration
// and export all agree; re-derives the legend through applyCustomNames().
function editChannelInline(chip: HTMLElement, c: number) {
  const old = chNames[c] || `CH${c + 1}`;
  const k = kindOf(c);
  const options = (Object.keys(KIND_META) as ChannelKind[])
    .map(kind => `<option value="${kind}" ${kind === k ? 'selected' : ''}>${KIND_META[kind].tag} · ${KIND_META[kind].unit}</option>`)
    .join('');
  chip.innerHTML = `<input class="tl-edit-input" type="text" value="${esc(old)}" data-ch="${c}" aria-label="Channel name" /><select class="tl-edit-kind" data-ch="${c}" aria-label="Sensor kind">${options}</select>`;
  const nameIn = chip.querySelector('.tl-edit-input') as HTMLInputElement;
  const kindSel = chip.querySelector('.tl-edit-kind') as HTMLSelectElement;
  nameIn.focus();
  nameIn.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const nm = nameIn.value.trim() || old;
    // Keep every channel's name: build the full list from what's displayed,
    // then swap this one, so a single-legend edit never blanks the others.
    const list = chNames.slice();
    while (list.length <= c) list.push(`CH${list.length + 1}`);
    list[c] = nm;
    hardwareProfile.customChannelNames = list;
    persistHardwareProfile();
    channelKinds[c] = kindSel.value as ChannelKind;
    const nameInput = document.getElementById('channelNamesInput') as HTMLInputElement | null;
    if (nameInput) nameInput.value = list.join(', ');
    applyCustomNames();
    traceDirty = true;
  };
  const cancel = () => { if (done) return; done = true; buildLegend(); };
  nameIn.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  kindSel.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    else if (e.key === 'Enter') { e.preventDefault(); commit(); }
  });
  // Clicking the kind dropdown opens focus on it AFTER the name input is no
  // longer focused — don't commit the old kind on that blur; the select's own
  // change/blur commits instead. Abstracting to a short timer keeps clicks
  // inside the chip from closing the editor underneath the pointer.
  const safeCommit = () => { if (done) return; commit(); };
  nameIn.addEventListener('blur', () => {
    if (document.activeElement === kindSel) return;
    window.setTimeout(safeCommit, 30);
  });
  kindSel.addEventListener('change', commit);
  kindSel.addEventListener('blur', () => { window.setTimeout(safeCommit, 30); });
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
  traceDirty = true;
});
tracesCanvas?.addEventListener('mouseleave', () => { cursorPX = -1; cursorPY = -1; traceDirty = true; drawCrosshairReadout(null); });
tracesCanvas?.addEventListener('click', () => { cursorPX = -1; cursorPY = -1; traceDirty = true; drawCrosshairReadout(null); });

// === Data Ingestion ===
// DEV-only: mirror what the UI actually receives to a local listener so the
// developer can verify live numbers against the screen. import.meta.env.DEV
// is statically false in production builds, so this cannot ship.
function devTap(kind: string, payload: unknown): void {
  if (!import.meta.env.DEV) return;
  try {
    void fetch('http://127.0.0.1:5501/tap', { method: 'POST', body: JSON.stringify({ kind, payload }) }).catch(() => {});
  } catch { /* ignore */ }
}
let lastDetectorTapAt = 0;

async function ingestReading(values: number[]) {
  if (values.length === 0) return;
  // Self-heal the live buffers to the ACTUAL stream width before pushing.
  // Auto-detect can race the first samples and an "Auto" connect leaves
  // traceData empty — without this, live samples are silently dropped by the
  // `min(values.length, traceData.length)` guard below and the plot stays blank
  // while the fingerprint (which reads `values` directly) still moves.
  // setChannelCount early-returns when count already matches, so this is a
  // no-op on the steady-state path and only reallocates on a real width change.
  if (traceData.length !== values.length) {
    setChannelCount(values.length);
  }
  for (let ch = 0; ch < Math.min(values.length, traceData.length); ch++) {
    traceData[ch].push(values[ch]);
    historyData[ch].push(values[ch]);
  }
  sampleCount++;
  traceDirty = true;

  // HUD readout
  const samplesEl = document.getElementById('plotSamples');
  if (samplesEl) samplesEl.textContent = `${sampleCount.toLocaleString()} SAMP`;

  // Update fingerprint
  drawFingerprint(liveResponse(values));
  refreshFpSource();

  try {
    const result = await invoke<{
      is_anomaly: boolean; raw_score: number; calibrated_confidence: number;
      triggered_channels: number[]; alert_level: number; alert_name: string;
      consecutive_anomalies: number; warming_up: boolean; baseline_progress: number;
    }>('ingest_reading_with_failsafe', { reading: values });

    // Baseline age is a real observation, not a guess: stamp the first tick
    // where the detector reports the baseline ready in this session.
    if (!result.warming_up && baselineReadyAt === null) baselineReadyAt = Date.now();

    // Anomaly card — state-transition guard: only re-stamp DOM when the
    // composite state actually CHANGES, not every ~10Hz tick. This kills the
    // flicker/glitch from re-assigning className + textContent each frame where
    // nothing moved (which re-triggers CSS transitions on a static card).
    lastAnomalyReading = {
      state: result.warming_up
        ? 'unknown'
        : result.is_anomaly
          ? (result.alert_level >= 2 ? 'critical' : 'warning')
          : 'normal',
      score: result.raw_score,
      confidence: result.calibrated_confidence,
      alertLevel: result.alert_level,
      triggeredChannels: result.triggered_channels.length,
      consecutive: result.consecutive_anomalies,
      warming: result.warming_up,
      baselineProgress: result.baseline_progress ?? 0,
    };
    // Each open Vial gets the same reading through its own detector. The base
    // detector above is never reconfigured by a Vial.
    for (const pack of openVialPacks()) {
      if (pack.anomaly) void feedVialDetector(pack, values);
    }
    const stateKey = `${result.warming_up ? 1 : 0}:${result.is_anomaly ? 1 : 0}:${result.alert_level}`;
    if (import.meta.env.DEV) {
      const now = Date.now();
      if (now - lastDetectorTapAt > 1000) {
        lastDetectorTapAt = now;
        devTap('detector', {
          ch: chNames.length,
          score: result.raw_score,
          conf: result.calibrated_confidence,
          anomaly: result.is_anomaly,
          alert: result.alert_level,
          triggered: result.triggered_channels,
          warming: result.warming_up,
          progress: result.baseline_progress,
          samples: sampleCount,
          connected,
        });
      }
    }
    const anomalyStateChanged = stateKey !== lastAnomalyKey;
    if (anomalyStateChanged) {
      lastAnomalyKey = stateKey;
      const card = document.getElementById('anomalyCard')!;
      const fAlert = document.getElementById('fAlert')!;
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
      fAlert.textContent = `warm-up ${pct}%`;
      fAlert.style.color = 'var(--yellow)';
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
      fAlert.textContent = result.is_anomaly ? result.alert_name : 'nominal';
      fAlert.style.color = result.alert_level >= 2 ? 'var(--red)' : result.is_anomaly ? 'var(--yellow)' : '';

      const statusDot = document.getElementById('statusDot')!;
      if (result.is_anomaly) {
        statusDot.className = result.alert_level >= 2 ? 'status-dot crit' : 'status-dot warn';
      } else {
        statusDot.className = connected ? 'status-dot ok' : 'status-dot';
      }
    }
    }
    if (anomalyStateChanged) renderVialHome();

    // Log change events: open one when a deviation starts, close it when the
    // array returns to baseline. This is the single-unit value of the detector.
    if (!result.warming_up) {
      const ts = Date.now();
      if (result.is_anomaly) {
        if (!openChange) {
          openChange = { start: ts, peak: result.raw_score, channels: new Set(result.triggered_channels), alert: result.alert_name };
          renderChangeLog();
        } else {
          openChange.peak = Math.max(openChange.peak, result.raw_score);
          result.triggered_channels.forEach((c) => openChange!.channels.add(c));
          openChange.alert = result.alert_name;
        }
      } else if (openChange) {
        changeLog.unshift({ start: openChange.start, end: ts, peak: openChange.peak, channels: [...openChange.channels], alert: openChange.alert });
        if (changeLog.length > 50) changeLog.length = 50;
        saveChangeLog();
        openChange = null;
        renderChangeLog();
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
  gotLiveData = true;
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
    portBoardMap.clear();
    portKindMap.clear();
    for (const p of ports) {
      const opt = document.createElement('option');
      opt.value = p.name;
      const kind = p.kind;
      portKindMap.set(p.name, kind);
      // Map the raw kind to a board key that flash_firmware understands. Only
      // a definitive VID:PID resolves automatically; ambiguous/unknown adapters
      // (CH340, unrecognised USB) resolve to '' so flashing asks the user to
      // confirm the board instead of guessing ESP32.
      const board = (kind === 'osmograph-e-nose' || kind === 'esp32') ? 'esp32' :
        kind === 'arduino_uno' ? 'arduino_uno' : '';
      if (board) portBoardMap.set(p.name, board);
      const boardLabel = kind === 'osmograph-e-nose' ? 'ESP32 e-nose' :
        kind === 'arduino_uno' ? 'Arduino Uno' :
        kind === 'ch340' ? 'CH340 — board? confirm in Firmware' :
        kind && kind !== 'unknown-usb' ? kind.replace(/_/g, ' ') : 'USB-SERIAL (unrecognised)';
      const desc = p.description || p.manufacturer || '';
      opt.textContent = `${p.name} · ${boardLabel}${desc ? ' — ' + desc : ''}`;
      if (p.name === cur) opt.selected = true;
      sel.appendChild(opt);
    }
    updateFwBoardLabel();
    knownPorts = ports;
    renderSysPorts();
  } catch (e) {
    console.error('Port refresh failed:', e);
  }
}

/** The Settings → Connection panel is a real port switchboard: it lists what
 *  the OS reported, names the open link, and can open/close it without sending
 *  the user to the titlebar. */
function renderSysPorts(): void {
  const host = document.getElementById('sysPortList');
  const state = document.getElementById('sysConnState');
  if (!host) return;
  if (state) {
    const target = activePort ? ` to <code>${escapeHtmlText(activePort)}</code>` : '';
    const extras = [
      activeBaud ? `${activeBaud} baud` : '',
      `${chNames.length} ch`,
      connected && activeMode !== 'serial' ? activeMode.toUpperCase() : '',
    ].filter(Boolean).join(' · ');
    state.innerHTML = connected
      ? `<span class="sys-dot on"></span>Connected${target}${extras ? ` · ${extras}` : ''}`
      : '<span class="sys-dot"></span>Not connected. Pick a port below to open it.';
  }
  if (knownPorts.length === 0) {
    host.innerHTML = '<div class="hint">No serial ports found. Plug the rig in and refresh.</div>';
    return;
  }
  host.innerHTML = knownPorts.map((p) => {
    const here = connected && activePort === p.name;
    const label = p.kind === 'osmograph-e-nose' ? 'ESP32 e-nose'
      : p.kind === 'arduino_uno' ? 'Arduino Uno'
        : p.kind === 'ch340' ? 'CH340 (confirm board in Firmware)'
          : p.description || p.manufacturer || p.hw_type || 'USB serial';
    return `<div class="sys-port-row${here ? ' active' : ''}">
      <code>${escapeHtmlText(p.name)}</code>
      <span class="sys-port-kind">${escapeHtmlText(label)}</span>
      <span class="sys-port-desc">${escapeHtmlText(p.manufacturer || '')}</span>
      <button class="mini-btn${here ? '' : ' primary'}" type="button" data-sys-port="${escapeHtmlText(p.name)}">${here ? 'Disconnect' : 'Connect'}</button>
    </div>`;
  }).join('');
  host.querySelectorAll<HTMLButtonElement>('[data-sys-port]').forEach((btn) => {
    btn.addEventListener('click', () => { void connectFromSettings(btn.dataset.sysPort || ''); });
  });
}

async function connectFromSettings(port: string): Promise<void> {
  if (!port) return;
  if (connected && activePort === port) {
    await toggleConnection();
    renderSysPorts();
    return;
  }
  if (connected) {
    await toggleConnection();
    await new Promise(r => setTimeout(r, 250));
  }
  const modeSel = document.getElementById('modeSelect') as HTMLSelectElement | null;
  if (modeSel && modeSel.value !== 'serial') modeSel.value = 'serial';
  const sel = document.getElementById('portSelect') as HTMLSelectElement | null;
  if (sel) sel.value = port;
  await toggleConnection();
  renderSysPorts();
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
  document.body.classList.toggle('no-rig', !on);
  document.getElementById('dashboardEmpty')?.classList.toggle('show', !on);
  if (!on) clearAnomalyForNoRig();
  renderVialHome();
  renderSysPorts();
}

function clearAnomalyForNoRig(): void {
  const card = document.getElementById('anomalyCard');
  if (card) card.className = 'anomaly-card';
  const label = document.getElementById('anomalyLabel');
  if (label) label.textContent = 'NO RIG';
  const sub = document.getElementById('anomalySub');
  if (sub) sub.textContent = 'Connect a rig or replay a recording.';
  const mahal = document.getElementById('mMahal');
  if (mahal) mahal.textContent = '--';
  const conf = document.getElementById('mConf');
  if (conf) conf.textContent = '--';
  const ch = document.getElementById('mCh');
  if (ch) ch.textContent = `0/${chNames.length}`;
  const alert = document.getElementById('mAlert');
  if (alert) alert.textContent = '0';
  lastAnomalyReading = {
    state: 'unknown', score: null, confidence: null, alertLevel: 0,
    triggeredChannels: 0, consecutive: 0, warming: false, baselineProgress: 0,
  };
  // Force the next detector pass to re-stamp the DOM instead of treating a
  // stale key as "nothing changed" while the card says NO RIG.
  lastAnomalyKey = '';
}

// Stall watchdog: if we claim to be connected but no reading has arrived for a
// few seconds, flag it — a plugged device that isn't streaming now visibly
// shows as "NO DATA" instead of silently looking live.
function updatePlotLinkState() {
  refreshFpSource();
  const el = document.getElementById('plotLinkState');
  if (!el) return;
  const wasNoRig = document.body.classList.contains('no-rig');
  if (!connected) {
    el.textContent = '● NO LINK';
    el.classList.remove('stall', 'on');
    document.body.classList.add('no-rig');
    document.getElementById('dashboardEmpty')?.classList.add('show');
    clearAnomalyForNoRig();
    if (!wasNoRig) renderVialHome();
    return;
  }
  const stalled = Date.now() - lastDataAt > 3000;
  el.textContent = stalled ? '● NO DATA' : '● LIVE LINK';
  el.classList.toggle('stall', stalled);
  el.classList.toggle('on', !stalled);
  document.body.classList.remove('no-rig');
  document.getElementById('dashboardEmpty')?.classList.toggle('show', false);
  if (wasNoRig) renderVialHome();
  // Bootloader diagnosis must never fire on a healthy board: EVERY ESP32
  // reset prints the ROM banner ("boot mode:..." — a keyword hit) and the
  // flashed firmware then stays silent for ~30 s collecting its baseline.
  // So only offer the re-flash path when a bootloader keyword matched AND no
  // valid reading has ever arrived this link AND the silence outlasts the
  // baseline window (BOOT_STALL_MS covers it with margin).
  const blSuspected = bootloaderHinted && !gotLiveData && Date.now() - lastDataAt > BOOT_STALL_MS;
  const banner = document.getElementById('bootBanner');
  if (banner) banner.classList.toggle('show', blSuspected);
  if (blSuspected && !bootFlashShown) {
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
    activePort = '';
    activeBaud = 0;
    resetLiveBaseline();
    document.getElementById('connectBtn')!.textContent = 'Connect';
    document.getElementById('statusDot')!.className = 'status-dot';
    setPlotLink(false);
    setMsg('');
    return;
  }

  autoChannels = 0;
  bootFlashShown = false;
  gotLiveData = false;

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
      activePort = addr;
      activeBaud = 0;
      connected = true;
      resetLiveBaseline();
      document.getElementById('connectBtn')!.textContent = 'Disconnect';
      document.getElementById('statusDot')!.className = 'status-dot ok';
      setPlotLink(true);
      document.getElementById('fDevice')!.textContent = addr;
      sampleCount = 0;
      baselineReadyAt = null;
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
      activePort = addr;
      activeBaud = 0;
      connected = true;
      resetLiveBaseline();
      document.getElementById('connectBtn')!.textContent = 'Disconnect';
      document.getElementById('statusDot')!.className = 'status-dot ok';
      setPlotLink(true);
      document.getElementById('fDevice')!.textContent = addr;
      sampleCount = 0;
      baselineReadyAt = null;
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
      // A previous UI lifetime can leave the Rust serial task holding the port
      // while its reader is silent, so Connect must start from a clean handle.
      // Disconnecting a link that is not there is harmless.
      try { await invoke('disconnect_serial'); } catch { /* no prior link */ }
      await invoke('connect_serial', { port, baudRate: baud, nChannels: channelCount });
      activeMode = 'serial';
      activePort = port;
      activeBaud = baud;
      connected = true;
      resetLiveBaseline();
      document.getElementById('connectBtn')!.textContent = 'Disconnect';
      document.getElementById('statusDot')!.className = 'status-dot ok';
      setPlotLink(true);
      document.getElementById('fDevice')!.textContent = port;
      sampleCount = 0;
      baselineReadyAt = null;
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
interface SensorHealthInfoApi {
  channel: number;
  health_score: number;
  mean: number;
  std: number;
  cv: number;
  noise_floor: number;
  drift_rate: number;
  stuck: boolean;
  status: string;
  recommendation: string;
}

async function updateSensorHealth() {
  try {
    const health = await invoke<SensorHealthInfoApi[]>('get_sensor_health');
    sensorHealthCache = health;
    sensorHealthAt = Date.now();
    const el = document.getElementById('sensorHealthList')!;
    if (health.length === 0) {
      el.innerHTML = '<div style="font-size:10px;color:var(--text-3)">No data yet</div>';
      renderFleetHealth([]);
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
    renderFleetHealth(health);
  } catch {}
}

// Rich per-channel health cards in the Fleet tab: score, verdict, noise floor,
// drift rate and an actionable recommendation — grounded in the same rolling
// signal the sidebar summary uses.
function renderFleetHealth(health: SensorHealthInfoApi[]) {
  const grid = document.getElementById('fleetHealthGrid')!;
  const stamp = document.getElementById('fleetHealthStamp')!;
  if (!grid || !stamp) return;
  if (health.length === 0) {
    grid.innerHTML = '<div style="font-size:11px;color:var(--text-3);padding:8px">Connect a device and stream data to see each sensor\'s live health assessment.</div>';
    stamp.textContent = 'no stream yet';
    return;
  }
  const worst = health.reduce((a, b) => (b.health_score < a ? b.health_score : a), 1);
  stamp.textContent = `${health.length} sensor(s) · worst ${(worst * 100).toFixed(0)}%`;
  stamp.style.color = worst < 0.4 ? 'var(--red)' : worst < 0.8 ? 'var(--yellow)' : 'var(--green)';
  grid.innerHTML = health.map((h, i) => {
    const name = esc(chNames[i % chNames.length] || `CH${i + 1}`);
    const statusColor = h.status === 'OK' ? 'var(--green)' : h.status === 'WARNING' ? 'var(--yellow)' : 'var(--red)';
    const score = (h.health_score * 100).toFixed(0);
    const noise = h.noise_floor.toExponential(1);
    const drift = `${(h.drift_rate * 100).toFixed(1)}%`;
    const reco = esc(h.recommendation);
    return `<div class="health-card" style="border-color:${statusColor}66">
      <div class="hc-head">
        <span class="hc-name" title="${name} — channel ${h.channel + 1}">${name}</span>
        <span class="hc-status" style="color:${statusColor}">${esc(h.status)}</span>
      </div>
      <div class="hc-score" style="color:${statusColor}">${score}</div>
      <div class="hc-reco">${reco}</div>
      <div class="hc-metrics">
        <span title="Temporal resolution of the signal">noise ${noise}</span>
        <span title="Relative change across the window">drift ${drift}</span>
        <span title="Baseline level">mean ${h.mean.toFixed(0)}</span>
      </div>
    </div>`;
  }).join('');
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
    body.innerHTML = `<tr class="empty-row"><td colspan="9">No sessions yet — connect a device and record, or use <strong>Import</strong> / <strong>Import Folder</strong>. No hardware? <button class="text-link" type="button" data-playground>Open the Playground</button> (a real SmellNet recording, replayed) or download a corpus from <strong>Datasets</strong>.</td></tr>`;
    document.getElementById('libStatus')!.textContent = '0 sessions';
    return;
  }
  const q = ((document.getElementById('libSearch') as HTMLInputElement | null)?.value || '').trim().toLowerCase();
  const rows = sessions
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !q || `${s.substance} ${s.label} ${s.format} ${s.duration} ${s.sensors} ${recordingSource(s).name}`.toLowerCase().includes(q));
  if (rows.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="9">Nothing matches "${q}" — try a different search.</td></tr>`;
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
    const src = recordingSource(s);
    const srcTitle = [src.credit, src.license && `Licence: ${src.license}`, src.citation].filter(Boolean).join(' · ');
    const mixture = Array.isArray(s.mixture) && s.mixture.length >= 2;
    const mixtureTitle = mixture
      ? `Mixture: ${s.mixture!.map(c => `${c.name}${typeof c.fraction === 'number' ? ` ${Math.round(c.fraction * 100)}%` : ''}`).join(' + ')}`
      : '';
    return `<tr class="${i === selectedSession ? 'selected' : ''}" data-idx="${i}">
      <td><input type="checkbox" class="compare-tick" data-idx="${i}" ${ticked ? 'checked' : ''} title="Overlay in Compare"></td>
      <td>${s.time}</td><td class="lib-sub" data-idx="${i}" title="Double-click to rename the recording + its file">${s.substance}${mixture ? ` <span class="lib-mixture-tag" title="${esc(mixtureTitle)}">mixture</span>` : ''}</td><td>${s.label}</td>
      <td><span class="lib-source" title="${esc(srcTitle)}">${esc(src.name)}</span></td>
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
  const mixture = Array.isArray(s.mixture) ? s.mixture : [];
  const mixtureRow = mixture.length >= 2
    ? `<span class="k">Composition</span><span class="v">${mixture.map(c => `${c.name}${typeof c.fraction === 'number' ? ` ${Math.round(c.fraction * 100)}%` : ''}`).join(' + ')}</span>`
    : '';
  const details = `
    <div style="margin-bottom:6px"><strong>${s.substance}</strong></div>
    <div class="kv-row">
      <span class="k">Label</span><span class="v">${s.label || '—'}</span>
      <span class="k">Format</span><span class="v">${s.format}</span>
      <span class="k">Duration</span><span class="v">${s.duration}</span>
      <span class="k">Sensors</span><span class="v">${s.sensors}</span>
      <span class="k">Quality</span><span class="v">${s.quality}/100</span>
      ${mixtureRow}
    </div>
  `;
  document.getElementById('inspectorDetails')!.innerHTML = details;
  if (s.quality_report) {
    renderQualityReport(s.quality_report);
  }
  void renderRigHealth(s);
  void renderInspectorFingerprint(s);
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

// === Rig health — is this array actually sane? ===
// The same per-channel verdict the live monitor gives, applied to a saved
// recording, so a rig can be checked after the fact. Reported *before* any
// interpretation, because every number downstream depends on the array working.
interface SensorHealthInfo {
  channel: number;
  health_score: number;
  mean: number;
  std: number;
  cv: number;
  noise_floor: number;
  drift_rate: number;
  stuck: boolean;
  status: string;
  recommendation: string;
}

const rigHealthCache = new Map<string, { names: string[]; health: SensorHealthInfo[] } | null>();

async function renderRigHealth(s: SessionRecord): Promise<void> {
  const section = document.getElementById('inspHealthSection');
  const body = document.getElementById('inspHealthBody');
  const stamp = document.getElementById('inspHealthStamp');
  if (!section || !body || !stamp) return;
  if (!s.file_id) { section.hidden = true; return; }
  section.hidden = false;
  stamp.textContent = '';
  body.innerHTML = '<span style="color:var(--text-3)">Checking channels…</span>';
  let entry = rigHealthCache.get(s.file_id);
  if (entry === undefined) {
    try {
      const series = await invoke<SessionSeries>('load_session_series', { fileId: s.file_id });
      const health = await invoke<SensorHealthInfo[]>('assess_recording_health', { fileId: s.file_id });
      entry = { names: series.channels, health };
    } catch {
      entry = null;
    }
    rigHealthCache.set(s.file_id, entry);
  }
  // A newer selection may have landed while this one was loading.
  if (selectedSession != null && sessions[selectedSession]?.file_id !== s.file_id) return;
  if (!entry || !entry.health.length) {
    body.innerHTML = '<span style="color:var(--text-3)">Could not assess this recording.</span>';
    return;
  }
  const okCount = entry.health.filter(h => h.status === 'OK').length;
  stamp.textContent = `${okCount}/${entry.health.length} OK`;
  const names = entry.names;
  const rows = entry.health.map(h => {
    const name = names[h.channel] || `CH${h.channel + 1}`;
    const cls = h.status === 'OK' ? 'ok' : (h.stuck || h.status === 'CRITICAL' ? 'bad' : 'warn');
    const detail = h.stuck
      ? 'unresponsive — no signal change'
      : `${h.status.toLowerCase()} · drift ${(h.drift_rate * 100).toFixed(0)}% · noise ${h.noise_floor.toFixed(1)}`;
    return `<div class="rig-row"><span class="rig-dot ${cls}"></span><span class="rig-name">${name}</span><span class="rig-detail">${detail}</span></div>`;
  }).join('');
  const notOk = entry.health.length - okCount;
  const note = notOk
    ? `<div class="rig-note">${notOk} of ${entry.health.length} channels are not OK. Fingerprints, comparisons and classifiers are all weaker while that is true — fix the array before trusting a result.</div>`
    : `<div class="rig-note">All channels responsive.</div>`;
  body.innerHTML = rows + note;

  // Mirror the verdict onto the front door: the state of the instrument is not
  // something a user should have to go looking for.
  const strip = document.getElementById('smellsRig');
  if (strip) {
    if (!notOk) {
      strip.hidden = true;
    } else {
      const label = (h: SensorHealthInfo) => names[h.channel] || `CH${h.channel + 1}`;
      const down = entry.health.filter(h => h.stuck).map(label);
      const rest = entry.health.filter(h => !h.stuck && h.status !== 'OK').map(label);
      const parts: string[] = [];
      if (down.length) parts.push(`unresponsive: ${down.join(', ')}`);
      if (rest.length) parts.push(`${rest.join(', ')} unstable`);
      strip.innerHTML =
        `<span>Your rig, newest recording — <strong>${okCount}/${entry.health.length} channels OK</strong>` +
        (parts.length ? ` · ${parts.join(' · ')}` : '') + `</span>` +
        `<span style="flex:1"></span><button class="mini-btn" id="smellsRigOpen">Details</button>`;
      strip.hidden = false;
      document.getElementById('smellsRigOpen')?.addEventListener('click', () => {
        document.querySelector<HTMLElement>('.src-subnav-btn[data-src="sessions"]')?.click();
        renderLibrary();
      });
    }
  }
}

/** Show the newest recording from the user's own rig, so the rig's state is the
 *  first thing on screen rather than something they have to go looking for. */
function autoInspectOwnRig(): void {
  if (selectedSession != null || !sessions.length) return;
  const idx = sessions.findIndex(s => (s.path || '').includes('Osmograph_Recordings/') && !(s.path || '').includes('/SmellNet/'));
  // Never dress the bundled starter library up as "your rig". With no own
  // recording there is nothing to inspect yet; the gallery is the right home.
  if (idx < 0) return;
  selectedSession = idx;
  renderLibrary();
  inspectSession(sessions[idx]);
}

// === Compare Panel (Python `viz/compare_panel.py` parity, supersized) ===
// Session colours must be tellable apart at a glance; the channel palette is
// deliberately all cool tones, which is wrong for overlaying four recordings.
const CHART_COLORS = [
  cssToken('--cyan'), // deep cyan
  '#b45309', // amber
  '#6d28d9', // violet
  '#15803d', // green
  '#be123c', // crimson
  '#1d4ed8', // blue
  '#a16207', // ochre
  '#0f766e', // teal
];
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
  el.innerHTML = parts || '<span style="color:var(--text-3)">Tick sessions in Data → Recordings to compare.</span>';
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
    return `<tr data-si="${p.si}"${p.peak === bestPeak ? ' class="cmp-best"' : ''}>
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
    <tbody>${rows}</tbody></table><div id="compareVerdict" class="cmp-verdict"></div>`;
  stamp.textContent = `${perSession.length} sessions · ${activeCompareChannels.length} ch`;
  void renderCompareVerdict();
}

// A pairwise reading of the two selected traces: are they two runs of one
// smell (repeatability) or two different smells (separation)? This is the
// question the numbers above cannot answer on their own.
let cmpVerdictToken = 0;

function settledFingerprint(s: SessionSeries): { channels: string[]; values: number[] } {
  return {
    channels: s.channels,
    values: s.channels.map((_, ci) => {
      const norm = cmpNorm(s, ci);
      if (!norm || !norm.length) return NaN;
      return meanOf(norm.slice(Math.floor(norm.length * 0.4)));
    }),
  };
}

async function renderCompareVerdict(): Promise<void> {
  const el = document.getElementById('compareVerdict');
  if (!el) return;
  const items = compareLoaded.filter(Boolean) as SessionSeries[];
  if (items.length !== 2) { el.innerHTML = ''; return; }
  const token = ++cmpVerdictToken;
  const [a, b] = items;
  const fa = settledFingerprint(a), fb = settledFingerprint(b);
  const shared = fa.channels.filter(c => fb.channels.includes(c));
  const pairs = shared.map(c => {
    const va = fa.values[fa.channels.indexOf(c)];
    const vb = fb.values[fb.channels.indexOf(c)];
    return { c, va, vb, delta: Math.abs(va - vb) };
  }).filter(x => Number.isFinite(x.va) && Number.isFinite(x.vb));
  if (!pairs.length) { el.innerHTML = ''; return; }

  let dot = 0, na = 0, nb = 0;
  for (const p of pairs) { dot += p.va * p.vb; na += p.va * p.va; nb += p.vb * p.vb; }
  const cos = na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : NaN;
  pairs.sort((x, y) => y.delta - x.delta);
  const top = pairs.slice(0, 2)
    .map(p => `${p.c} (${(p.va * 100).toFixed(0)}% vs ${(p.vb * 100).toFixed(0)}%)`)
    .join(', ');

  const substanceOf = (i: number) => {
    const rec = sessions.find(x => x.file_id === compareFiles[i]);
    return (rec?.substance || '').trim();
  };
  const subA = substanceOf(0), subB = substanceOf(1);
  const same = !!subA && subA.toLowerCase() === subB.toLowerCase();
  const cosText = Number.isFinite(cos) ? `shape cosine ${cos.toFixed(2)}` : 'no shared channels';

  let headline: string;
  let tone: 'ok' | 'warn' | 'info';
  if (same) {
    if (Number.isFinite(cos) && cos >= 0.9) {
      headline = `Same smell, two runs — the array repeats itself (${cosText}).`;
      tone = 'ok';
    } else if (Number.isFinite(cos) && cos >= 0.6) {
      headline = `Same smell, but the two runs only partly agree (${cosText}). Baseline or exposure conditions drifted.`;
      tone = 'warn';
    } else {
      headline = `Same smell, different response (${cosText}) — this is run-to-run variability, not a new odour.`;
      tone = 'warn';
    }
  } else {
    headline = Number.isFinite(cos) && cos < 0
      ? `Different smells with opposite response shapes (${cosText}).`
      : `Different smells (${cosText}).`;
    tone = 'info';
  }

  let across = '';
  if (!same && subA && subB) {
    const cardA = smellCards.find(c => c.key === subA.toLowerCase());
    const cardB = smellCards.find(c => c.key === subB.toLowerCase());
    if (cardA && cardB) {
      const [ra, rb] = await Promise.all([smellReplicates(cardA), smellReplicates(cardB)]);
      if (token !== cmpVerdictToken) return;
      if (ra && rb && ra.rows.length >= 2 && rb.rows.length >= 2) {
        const { acc, nEval, pValue } = separationBetween(ra, rb);
        if (Number.isFinite(acc)) {
          const right = Math.round(acc * nEval);
          const caveat = Number.isFinite(pValue) && pValue > 0.05
            ? ` (label-shuffle p = ${pValue.toFixed(2)} — promising, not established)`
            : '';
          across = ` Across all replicates: ${right}/${nEval} left-out recordings separate them${caveat} — see Analyse → Compare for the lever.`;
        }
      }
    }
  }

  el.innerHTML = `
    <div class="cmp-verdict-head">Pairwise verdict</div>
    <div class="cmp-verdict-line ${tone}">${headline}</div>
    <div class="cmp-verdict-sub">Largest difference: ${top}.${across}</div>`;
}

function drawCompare() {
  const ctx = compareCtx;
  const canvas = compareCanvas;
  if (!ctx || !canvas) return;
  if (compareMode === 'heatmap') { drawCompareHeatmap(); return; }
  if (compareMode === 'trajectory') { drawCompareTrajectory(); return; }
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
      ? 'No sessions selected. Select smells in Explore to compare them here.'
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
    ctx.fillText('Select smells in Explore to see their similarity.', w / 2, h / 2);
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

// A smell is a curve, not a point. This projects each recording's normalised
// multi-channel path onto its two principal axes, so the *transformation* is
// visible: does this smell trace a distinct loop, or the same line as another?
// PCA is only a projection — the advisor's held-out check remains the evidence.
function drawCompareTrajectory() {
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

  const empty = (msg: string) => {
    ctx.fillStyle = '#666';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(msg, w / 2, h / 2);
  };
  const items = compareLoaded.filter(Boolean) as SessionSeries[];
  if (items.length === 0) { empty('Select smells in Explore to see their trajectories.'); return; }

  // A shared channel set is required: PC axes are meaningless across different
  // array widths or differently named channels.
  const channels = activeCompareChannels.filter(ch => items.every(s => s.channels.includes(ch)));
  if (channels.length < 2) {
    empty('Trajectory needs at least 2 shared channels — select sessions from the same array.');
    return;
  }

  const T = 90;
  const lerp = (xs: number[], ys: number[], at: number): number | null => {
    let lo = -1, hi = -1;
    for (let i = 0; i < ys.length; i++) {
      if (!Number.isFinite(ys[i])) continue;
      if (xs[i] <= at) lo = i;
      if (xs[i] >= at && hi < 0) hi = i;
    }
    if (lo < 0 && hi < 0) return null;
    if (lo < 0) return ys[hi];
    if (hi < 0 || hi === lo) return ys[lo];
    const span = xs[hi] - xs[lo];
    const f = span > 0 ? (at - xs[lo]) / span : 0;
    return ys[lo] + (ys[hi] - ys[lo]) * f;
  };

  const paths: { s: SessionSeries; si: number; rows: number[][] }[] = [];
  items.forEach((s, si) => {
    const norms = channels.map(ch => {
      const ci = s.channels.indexOf(ch);
      return ci >= 0 ? cmpNorm(s, ci) : null;
    });
    if (norms.some(n => !n)) return;
    const t0 = s.time[0], t1 = s.time[Math.min(s.time.length, Math.max(...norms.map(n => n!.length))) - 1];
    if (!(t1 > t0)) return;
    const rows: number[][] = [];
    for (let k = 0; k < T; k++) {
      const at = t0 + (t1 - t0) * (k / (T - 1));
      const row = norms.map(n => lerp(s.time.slice(0, n!.length), n!.slice(0, n!.length), at));
      if (row.some(v => v === null)) continue;
      rows.push(row as number[]);
    }
    if (rows.length >= 5) paths.push({ s, si, rows });
  });
  if (!paths.length) { empty('No complete multi-channel trajectory in the selected sessions.'); return; }

  const c = channels.length;
  // Smooth before projecting: sensor noise turns a phase portrait into a
  // scribble, and the point of this view is the shape, not the jitter.
  const smoothRows = (rows: number[][], win = 7): number[][] => {
    const half = Math.floor(win / 2);
    return rows.map((_, i) => {
      const from = Math.max(0, i - half), to = Math.min(rows.length - 1, i + half);
      return rows[0].map((_, j) => {
        let s = 0, n = 0;
        for (let k = from; k <= to; k++) { s += rows[k][j]; n++; }
        return s / n;
      });
    });
  };
  paths.forEach(p => { p.rows = smoothRows(p.rows); });

  const raw = paths.flatMap(p => p.rows);
  const mean = new Array(c).fill(0);
  for (const r of raw) for (let j = 0; j < c; j++) mean[j] += r[j] / raw.length;
  const scale = new Array(c).fill(0);
  for (let j = 0; j < c; j++) {
    let v = 0;
    for (const r of raw) v += (r[j] - mean[j]) ** 2;
    scale[j] = Math.sqrt(v / raw.length) || 1;
  }
  const z = (r: number[]) => r.map((v, j) => (v - mean[j]) / scale[j]);

  // Compare transformations, not strengths: centre each recording on its own
  // opening vector and scale it to unit size, so intensity differences do not
  // masquerade as shape differences.
  const shaped = paths.map(p => {
    const zr = p.rows.map(r => z(r));
    const start = zr[0];
    const centred = zr.map(r => r.map((v, j) => v - start[j]));
    let rms = 0;
    for (const r of centred) for (const v of r) rms += v * v;
    rms = Math.sqrt(rms / (centred.length * c)) || 1;
    return centred.map(r => r.map(v => v / rms));
  });
  const all = shaped.flat();
  // PCA needs zero-mean data; per-path centring leaves the pooled mean of the
  // starts, so remove it. It also puts every path's start on the same point.
  const pm = new Array(c).fill(0);
  for (const r of all) for (let j = 0; j < c; j++) pm[j] += r[j] / all.length;
  const cov: number[][] = Array.from({ length: c }, () => new Array(c).fill(0));
  for (const r of all) {
    const zr = r.map((v, j) => v - pm[j]);
    for (let i = 0; i < c; i++) for (let j = 0; j < c; j++) cov[i][j] += (zr[i] * zr[j]) / all.length;
  }
  const power = (m: number[][], start: number[]) => {
    let v = start.slice();
    for (let it = 0; it < 100; it++) {
      const wv = m.map(row => row.reduce((a, x, j) => a + x * v[j], 0));
      const nv = Math.sqrt(wv.reduce((a, x) => a + x * x, 0)) || 1;
      v = wv.map(x => x / nv);
    }
    const val = v.reduce((a, x, i) => a + x * m[i].reduce((b, y, j) => b + y * v[j], 0), 0);
    return { v, val };
  };
  const e1 = power(cov, Array(c).fill(1 / Math.sqrt(c)));
  const deflated = cov.map((row, i) => row.map((x, j) => x - e1.val * e1.v[i] * e1.v[j]));
  const e2 = power(deflated, Array.from({ length: c }, (_, i) => (i === 0 ? 1 : -1)));
  const degenerate = !(e2.val > 1e-6 * Math.max(e1.val, 1e-12));

  const pts = shaped.map(path => path.map(r => {
    const zr = r.map((v, j) => v - pm[j]);
    const x = zr.reduce((a, v, j) => a + v * e1.v[j], 0);
    const y = degenerate ? 0 : zr.reduce((a, v, j) => a + v * e2.v[j], 0);
    return [x, y];
  }));

  const xsAll = pts.flat().map(p => p[0]);
  const ysAll = degenerate ? [0, 1] : pts.flat().map(p => p[1]);
  let x0 = Math.min(...xsAll), x1 = Math.max(...xsAll);
  let y0 = Math.min(...ysAll), y1 = Math.max(...ysAll);
  if (!(x1 - x0 > 1e-9)) { x0 -= 0.5; x1 += 0.5; }
  if (!(y1 - y0 > 1e-9)) { y0 -= 0.5; y1 += 0.5; }
  const padX = (x1 - x0) * 0.08, padY = (y1 - y0) * 0.08;
  x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;

  const padL = 46, padR = 16, padT = 16, padB = 30;
  const sx = (v: number) => padL + ((v - x0) / (x1 - x0)) * (w - padL - padR);
  // When the second component is empty the plot degenerates to a line, so time
  // becomes the vertical axis instead of a meaningless zero.
  const sy = (v: number, k: number) => degenerate
    ? padT + (1 - k / (T - 1)) * (h - padT - padB)
    : padT + (1 - (v - y0) / (y1 - y0)) * (h - padT - padB);

  // Axes
  ctx.strokeStyle = 'rgba(8,8,12,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, h - padB); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(padL, h - padB); ctx.lineTo(w - padR, h - padB); ctx.stroke();
  ctx.fillStyle = '#8a7f6c';
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('PC1 →', w - padR - 40, h - padB + 8);
  ctx.save();
  ctx.translate(12, padT + 52);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(degenerate ? 'time →' : 'PC2 →', 0, 0);
  ctx.restore();

  paths.forEach((p, pi) => {
    const colour = CHART_COLORS[p.si % CHART_COLORS.length];
    const pp = pts[pi];
    for (let k = 1; k < pp.length; k++) {
      const a = 0.12 + 0.8 * (k / (pp.length - 1));
      ctx.strokeStyle = colour;
      ctx.globalAlpha = a;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(sx(pp[k - 1][0]), sy(pp[k - 1][1], k - 1));
      ctx.lineTo(sx(pp[k][0]), sy(pp[k][1], k));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const [lx, ly] = pp[pp.length - 1];
    ctx.beginPath();
    ctx.arc(sx(lx), sy(ly, pp.length - 1), 3.2, 0, Math.PI * 2);
    ctx.fillStyle = colour; ctx.fill();
    ctx.fillStyle = colour;
    ctx.font = '600 10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${p.si + 1}`, sx(lx) + 6, sy(ly, pp.length - 1));
  });

  // Every path is centred on its own opening vector, so they share one start.
  const [stx, sty] = pts[0][0];
  ctx.beginPath();
  ctx.arc(sx(stx), sy(sty, 0), 4, 0, Math.PI * 2);
  ctx.strokeStyle = '#3a3630';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.fillStyle = '#8a7f6c';
  ctx.font = '9px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText('start', sx(stx) + 7, sy(sty, 0) - 2);

  ctx.fillStyle = '#8a7f6c';
  ctx.font = '9px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(
    degenerate
      ? 'Paths are nearly one-dimensional; showing PC1 against time.'
      : 'Smoothed, centred and size-normalised · filled end labelled.',
    2, h - 2,
  );
}

function renderCompareEmpty(): void {
  buildSmellCards();
  const pair = defaultCheckPair();
  const a = pair ? smellCards.find(c => c.key === pair.ref) : null;
  const b = pair ? smellCards.find(c => c.key === pair.sample) : null;
  const btn = document.getElementById('compareEmptyTry') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = false;
    btn.textContent = a && b
      ? `Try ${titleCase(a.substance)} vs ${titleCase(b.substance)} →`
      : 'Get data →';
  }
}

/** One-click useful path for a no-hardware visitor: compare the same starter
 *  pair the Explore advisor would suggest, using one representative recording
 *  from each smell's dominant array. */
async function tryStarterCompare(): Promise<void> {
  buildSmellCards();
  const pair = defaultCheckPair();
  if (!pair) { showWorkspaceView('datasets'); return; }
  const a = smellCards.find(c => c.key === pair.ref);
  const b = smellCards.find(c => c.key === pair.sample);
  if (!a || !b) return;
  await Promise.all([ensureMean(a), ensureMean(b)]);
  const ids: string[] = [];
  for (const card of [a, b]) {
    const group = card.groupRecords?.length ? card.groupRecords : card.records;
    for (const rec of group.filter(r => !!r.file_id).slice(0, 3)) {
      if (rec.file_id && !ids.includes(rec.file_id)) ids.push(rec.file_id);
    }
  }
  if (!ids.length) return;
  compareFiles = ids;
  await updateCompare();
}

async function updateCompare() {
  const countEl = document.getElementById('compareCount')!;
  const compareRoot = document.querySelector<HTMLElement>('.compare');
  compareRoot?.classList.toggle('empty', compareFiles.length === 0);
  if (compareFiles.length === 0) {
    compareLoaded = [];
    countEl.textContent = '';
    document.getElementById('compareLabels')!.innerHTML = '';
    document.getElementById('compareChs')!.innerHTML = '';
    activeCompareChannels = [];
    compareRefIdx = 0;
    renderCompareRef();
    renderCompareMetrics();
    renderCompareEmpty();
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
  summary.textContent = `${fleetDevices.length} device(s) · ${recognized} recognized · ${online} online${connected ? ' · local rig connected' : ''}`;
  if (fleetDevices.length === 0) {
    grid.innerHTML = `<div class="fleet-empty">
      <b>No fleet devices registered.</b>
      <p>${connected
        ? 'Your rig is connected and streaming on Home. Fleet is where devices stay attached to their source and to the Vial applied to their live stream.'
        : 'USB, local network, or a remote host:port. Fleet is where a device stays attached to its source and to the Vial applied to its live stream.'}</p>
      <div class="fleet-empty-actions">
        ${connected ? '<button class="mini-btn" id="fleetEmptyHome" type="button">Open Home</button>' : ''}
        <button class="mini-btn primary" id="fleetEmptyScan" type="button">Scan network</button>
        <button class="mini-btn" id="fleetEmptyRemote" type="button">Connect remote</button>
        <button class="mini-btn" id="fleetEmptySmells" type="button">Explore smells →</button>
      </div>
    </div>`;
    document.getElementById('fleetBadge')!.style.display = 'none';
    return;
  }
  // Sort: recognized + online first, then the rest on the wire, then other.
  const sorted = [...fleetDevices].sort((a, b) =>
    (b.is_recognized ? 1 : 0) - (a.is_recognized ? 1 : 0) ||
    (b.status === 'online' ? 1 : 0) - (a.status === 'online' ? 1 : 0));
  document.getElementById('fleetBadge')!.style.display = '';
  document.getElementById('fleetBadge')!.textContent = fleetDevices.length.toString();
  const installedHomeVials = Domain.loadInstalledIds()
    .map(id => Domain.domainPackById(id))
    .filter((pack): pack is Domain.DomainPack => !!pack && !!pack.home);
  const appliedVial = selectedHomeVialId() || '';
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
    const vialRow = installedHomeVials.length
      ? `<div class="dev-vial-row">
          <span class="dev-vial-label">Home Vial</span>
          <select class="fleet-vial-select" data-device-id="${esc(d.id)}" title="Choose the Vial for Home. A Vial with a Home view opens in place of the dashboard.">
            <option value="">None</option>
            ${installedHomeVials.map(p => `<option value="${esc(p.id)}"${p.id === appliedVial ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
          <button class="mini-btn" type="button" data-fleet-live="${esc(d.id)}" title="Open the live Home view">Live →</button>
        </div>`
      : `<div class="dev-vial-row">
          <span class="dev-vial-label">Apply Vial</span>
          <span class="dev-vial-empty">No Vial with a Home view installed.</span>
          <button class="mini-btn" type="button" data-fleet-vials="1">Vials →</button>
        </div>`;
    return `<div class="device-card">
      <div class="dev-header">
        <div class="dev-name">${d.name}</div>
        <span class="dev-status ${statusClass}">${d.status}</span>
      </div>
      <div class="dev-meta">${badgeHtml}</div>
      <div style="font-size:10px;color:var(--text-3)">${d.port || '—'} · CH${d.n_channels} · FW ${d.firmware_version || '—'}</div>
      <div class="sensor-grid">${sensorsHtml}</div>
      ${vialRow}
    </div>`;
  }).join('');
}

// === OLED Preview ===
// Preview of the on-device screen layout for the chosen layout option.
// Honest by construction: when a rig is streaming it renders the real
// detector/trace values; when nothing is connected every value is "—"
// under a SIMULATED marker, because invented Mahal/confidence numbers on a
// device screen would be exactly the telemetry we refuse everywhere else.
function updateOledPreview() {
  const layout = (document.getElementById('oledLayout') as HTMLSelectElement).value;
  const preview = document.getElementById('oledPreview')!;
  const rule = '─'.repeat(18);
  const sim = 'PREVIEW · SIMULATED';
  const hasLive = connected && traceData.some(ch => ch.length > 0);

  if (!hasLive) {
    const blankChannels = chNames.slice(0, 6).map((name, i) =>
      `CH${i + 1}: ${name.padEnd(8)} ${'—'.padStart(5)}`
    ).join('\n');
    if (layout === 'alert') {
      preview.textContent = `⚠ ANOMALY DETECTED ⚠\n${rule}\n${sim}\nMahal: —\nConfidence: —\n\nChannels: —/${chNames.length}`;
    } else if (layout === 'minimal') {
      preview.textContent = `●  PREVIEW\n  ${sim}`;
    } else if (layout === 'overview') {
      preview.textContent = `OSMOGRAPH\n${rule}\n${blankChannels}\n\nStatus: — · ${sim}`;
    } else {
      preview.textContent = `OSMOGRAPH\n${rule}\n${blankChannels}\n\n${sim}`;
    }
    return;
  }

  const last = traceData.map(ch => ch.last() || 0);
  const previewLines = chNames.slice(0, 6).map((name, i) =>
    `CH${i + 1}: ${name.padEnd(8)} ${(last[i] || 0).toFixed(0).padStart(5)} Ω`
  ).join('\n');
  const anomaly = lastAnomalyReading;
  const warned = anomaly.state === 'warning' || anomaly.state === 'critical';
  const status = anomaly.warming ? 'WARMING UP' : anomaly.state === 'unknown' ? '—' : warned ? 'ANOMALY' : 'NORMAL';

  if (layout === 'overview') {
    preview.textContent = `OSMOGRAPH\n${rule}\n${previewLines}\n\nStatus: ${status}`;
  } else if (layout === 'alert') {
    if (warned) {
      preview.textContent = `⚠ ANOMALY DETECTED ⚠\n${rule}\nMahal: ${anomaly.score != null ? anomaly.score.toFixed(2) : '—'}\nConfidence: ${anomaly.confidence != null ? `${(anomaly.confidence * 100).toFixed(0)}%` : '—'}\n\nChannels: ${anomaly.triggeredChannels}/${chNames.length}`;
    } else {
      preview.textContent = `Status: ${status}\n${rule}\n(Alert layout — renders when\nthe detector raises)` ;
    }
  } else if (layout === 'minimal') {
    preview.textContent = `●  ${status}\n  ${(last[0] || 0).toFixed(0)} Ω`;
  } else {
    preview.textContent = `OSMOGRAPH\n${rule}\n${previewLines}`;
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
    updateRailCoord();
    refreshCalibrationViews();
    syncOpenVialDetectors();
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
  traceData = newTraceChannels(next);
  historyData = newHistoryChannels(next);
  traceDirty = true;
  buildLegend();
  const sc = document.getElementById('sysChannels') as HTMLInputElement | null;
  if (sc && sc.value !== String(next)) sc.value = String(next);
  const pc = document.getElementById('plotChCount');
  if (pc) pc.textContent = String(next);
  updateRailCoord();
  refreshCalibrationViews();
  syncOpenVialDetectors();
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
  const cm = document.getElementById('connMsg');
  if (cm && wasConnected) {
    cm.textContent = `${count}-channel device detected (auto)`;
    cm.style.color = 'var(--text-3)';
  }
  console.log(`[osmograph] auto-detected ${count} channels (${source || 'stream'})`);
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

function boardDisplay(board: string): string {
  if (board === 'esp32') return 'ESP32';
  if (board === 'arduino_uno') return 'ARDUINO UNO';
  if (board === 'ch340') return 'CH340 — CONFIRM BOARD';
  return board ? board.replace(/_/g, ' ').toUpperCase() : '—';
}

function activeBoard(): string {
  const port = (document.getElementById('portSelect') as HTMLSelectElement).value;
  const manual = (document.getElementById('fwBoard') as HTMLSelectElement)?.value || '';
  if (manual === 'esp32' || manual === 'arduino_uno') return manual;
  return port ? portBoardMap.get(port) || '' : '';
}

function updateFwBoardLabel() {
  const b = boardDisplay(activeBoard());
  const label = document.getElementById('fwBoardLabel');
  if (label) label.textContent = 'BOARD · ' + b;
  const detail = document.getElementById('fwBoardDetail');
  if (detail) detail.textContent = b;
}

function maxChannelsForBoard(board: string): number {
  if (board === 'esp32') return 12;
  if (board === 'arduino_uno') return 6;
  // Unknown / CH340-ambiguous: cap at 6 until the board is confirmed, so the
  // 8-sensor rig can't be flashed onto an Arduino by accident.
  return 6;
}

function renderRigSchematic() {
  const svg = document.getElementById('rigSchematic');
  const stamp = document.getElementById('schStamp');
  if (!svg) return;
  const ink = themeCssVar('--text-1') || '#201f1c';
  const dim = themeCssVar('--text-3') || cssToken('--text-3');
  const faint = themeCssVar('--border') || cssToken('--border');
  const fillA = themeCssVar('--bg-2') || '#efe8dc';
  const fillB = themeCssVar('--bg-1') || cssToken('--bg-1');
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
  updateFwBoardLabel();
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
  // NOTE: renaming must NEVER reallocate the live buffers. This runs on every
  // serial-info/serial-auto event, and wiping traceData there blanked the plot
  // on each INFO (the old `traceData = newTraceChannels(...)` reset caused a
  // subtle "graph keeps starting over / never shows" bug on devices that re-send
  // INFO). Buffer width is owned by setChannelCount + ingest-time adaptation.
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
  traceData = newTraceChannels(channelCount);
  historyData = newHistoryChannels(channelCount);
  traceDirty = true;
  buildLegend();
  const pc = document.getElementById('plotChCount');
  if (pc) pc.textContent = String(channelCount);
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
  const starter = document.getElementById('trainStarter') as HTMLButtonElement | null;
  if (starter) starter.hidden = !sessions.some(s => (s.path || '').includes('/SmellNet/'));
}

// One-click route to a working model. The no-hardware loop only counts if a new
// user can watch a real, honestly-scored classifier appear before they own any
// sensors — so this picks a balanced set from the bundled pack and trains it.
function selectStarterTrainingSet(maxPerSmell = 3, maxSmells = 4): number {
  const bySmell = new Map<string, SessionRecord[]>();
  for (const s of sessions) {
    if (!s.file_id || !(s.path || '').includes('/SmellNet/')) continue;
    const key = (s.substance || '').trim().toLowerCase();
    if (!key) continue;
    const list = bySmell.get(key) || [];
    list.push(s);
    bySmell.set(key, list);
  }
  const chosen = [...bySmell.entries()]
    .filter(([, recs]) => recs.length >= maxPerSmell)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, maxSmells);
  trainSelected.clear();
  for (const [, recs] of chosen) {
    recs.slice()
      .sort((a, b) => (b.quality || 0) - (a.quality || 0))
      .slice(0, maxPerSmell)
      .forEach(r => trainSelected.add(r.file_id!));
  }
  return chosen.length;
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
  log.innerHTML = `Training ${fileIds.length} recordings… scoring each one honestly (one model fit per recording) — allow a minute.`;
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
  const chance = report.classes.length ? 1 / report.classes.length : 0;
  // FDR is a variance ratio with no natural ceiling; "1.13e+27" tells nobody
  // anything, so clamp it to a readable range.
  const fdr = (x: number) => (!Number.isFinite(x) ? '∞' : x >= 100 ? '>100' : x.toFixed(2));
  const similarity = parseSimilarityFromJson(report.model_json);
  const pairs = [...similarity].sort((a, b) => a.fdr_mean - b.fdr_mean);
  const shown = pairs.slice(0, 5);
  const rest = pairs.length - shown.length;
  const warnings = (report.warnings || []).map(w => `<div class="train-warn">⚠ ${w}</div>`).join('');
  ins.innerHTML = `
    <h4>Model</h4>
    <div class="train-metric"><span>Name</span><strong>${report.name}</strong></div>
    <div class="train-metric"><span>Classes</span><span>${report.classes.join(', ')}</span></div>
    <div class="train-metric"><span>Windows</span><span>${report.n_windows} (${report.classes.map(c => report.windows_per_class[c]).join('/')})</span></div>
    <div class="train-metric"><span>Recordings</span><span>${report.classes.map(c => report.recordings_per_class[c]).join('/')}</span></div>

    <h4>Accuracy</h4>
    <div class="train-metric"><span>Out-of-sample (LORO)</span><strong style="color:var(--green)">${pct(report.accuracy)}</strong></div>
    <div class="train-metric"><span>Chance</span><span>${pct(chance)}</span></div>
    <div class="train-metric"><span>Mean-fold LORO</span><span>${pct(report.loro_mean_accuracy)}</span></div>
    <div class="train-metric"><span>In-sample (reference)</span><span style="color:var(--text-3)">${pct(report.in_sample_accuracy)}</span></div>
    <div class="train-note">Out-of-sample holds out whole recordings the model never saw — that is the number to trust. In-sample only shows it can memorise.</div>

    <h4>Similarity <span style="font-weight:400;color:var(--text-3)">worst first</span></h4>
    ${shown.map(s =>
      `<div class="train-metric"><span>${s.class_a} ↔ ${s.class_b}</span><span style="color:${s.fdr_mean < 0.25 ? 'var(--yellow)' : 'var(--text-2)'}">cos ${s.cosine.toFixed(2)} · FDR ${fdr(s.fdr_mean)}</span></div>`
    ).join('') || '<div style="color:var(--text-3)">—</div>'}
    ${rest > 0 ? `<div class="train-note">${rest} more pair${rest === 1 ? '' : 's'} better separated.</div>` : ''}

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
  let html = parts.length
    ? parts.map(p => `<div class="train-warn">${p}</div>`).join('')
    : '<div class="adequacy-ok">✓ Training set is sufficiently distinct — smells separate cleanly out-of-sample.</div>';
  const perClass = report.classes.map(c => report.recordings_per_class[c] || 0);
  const minPer = perClass.length ? Math.min(...perClass) : 0;
  if (!confusing.length && !lowAcc && minPer <= 3) {
    html += `<div class="train-note">Small sample — ${minPer} recording${minPer === 1 ? '' : 's'} per class. A high LORO can still be chance; confirm with the label-shuffle p-value in Analyse → Compare before trusting it.</div>`;
  }
  return html;
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
  const clsFoot = document.getElementById('fClassifier');
  if (clsFoot) clsFoot.textContent = (liveSnapshot && liveSnapshot.loaded) ? liveSnapshot.classifier_name : 'none';
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

// === Host snapshot → Vial Home ===
/** Per-channel single-unit limits from the live window. A channel is 'dead'
 *  when the rig reports it stuck, or when every finite sample in the window is
 *  identical (cv = 0). Dead channels never originate a claim. */
function channelLimitsFor(): Record<string, VialHost.ChannelLimit> {
  const limits: Record<string, VialHost.ChannelLimit> = {};
  const fresh = sensorHealthCache && Date.now() - sensorHealthAt <= 20000 ? sensorHealthCache : null;
  chNames.forEach((_, i) => {
    const health = fresh?.find(h => h.channel === i) || null;
    const values = historyData[i] ? historyData[i].slice() : [];
    const finite = values.filter(v => Number.isFinite(v));
    const min = finite.length ? Math.min(...finite) : 0;
    const max = finite.length ? Math.max(...finite) : 0;
    const mean = finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : 0;
    const std = finite.length
      ? Math.sqrt(finite.reduce((a, b) => a + (b - mean) ** 2, 0) / finite.length)
      : 0;
    const cv = health?.cv ?? (mean !== 0 ? std / Math.abs(mean) : 0);
    const dead = !!health?.stuck || (finite.length >= 20 && std === 0);
    limits[`ch${i}`] = {
      dead,
      cv,
      min,
      max,
      r0: liveBaseline && Number.isFinite(liveBaseline[i]) && liveBaseline[i] > 0 ? liveBaseline[i] : null,
    };
  });
  return limits;
}

function currentHostSnapshot(runtime: ActiveVialRuntime | null = null): VialHost.VialHostSnapshot {
  // A Vial with a profile reads its own detector. Legacy Vials and the base
  // app read the global fail-safe verdict.
  // A per-Vial detector only has a live verdict. A recording or a captured
  // buffer must not inherit the last live result as if it were current.
  const vialResult = runtime && runtime.source === 'live' && connected
    ? vialDetectorResults.get(runtime.pack.id)
    : undefined;
  // A v2 profile is compiled for the live array. On a recording or a captured
  // buffer it has no verdict, so the base app's live state is not a substitute.
  const profileOffLive = !!runtime?.pack.anomaly && (!connected || runtime.source !== 'live');
  const warming = profileOffLive ? false : vialResult ? vialResult.warming_up : lastAnomalyReading.warming;
  const anomalyState: VialHost.AnomalyState = profileOffLive
    ? 'unknown'
    : vialResult
      ? (vialResult.warming_up
          ? 'unknown'
          : vialResult.is_anomaly
            ? (vialResult.alert_level >= 2 ? 'critical' : 'warning')
            : 'normal')
      : lastAnomalyReading.state;
  const anomalyScore = profileOffLive ? null : vialResult ? vialResult.raw_score : lastAnomalyReading.score;
  const anomalyConfidence = profileOffLive ? null : vialResult ? vialResult.calibrated_confidence : lastAnomalyReading.confidence;
  const anomalyLevel = profileOffLive ? 0 : vialResult ? vialResult.alert_level : lastAnomalyReading.alertLevel;
  const anomalyTriggered = profileOffLive ? 0 : vialResult ? vialResult.triggered_channels.length : lastAnomalyReading.triggeredChannels;
  const anomalyConsecutive = profileOffLive ? 0 : vialResult ? vialResult.consecutive_anomalies : lastAnomalyReading.consecutive;
  const baselineProgress = profileOffLive ? 0 : vialResult ? vialResult.baseline_progress : lastAnomalyReading.baselineProgress;
  return {
    schema: VialHost.VIAL_HOST_SCHEMA,
    takenAt: Date.now(),
    // 'live' only when a rig streams; the contract's other values (replay,
    // dataset) belong to explicitly chosen sources, which Home never is.
    source: connected ? 'live' : 'none',
    // True for this host by construction: every source feeds an ordered
    // array; there is no trial-discrete mode in Osmograph today.
    samplingMode: 'timeseries',
    channels: chNames.map((name, i) => ({
      id: `ch${i}`,
      label: name,
      kind: kindOf(i),
      unit: KIND_META[kindOf(i)].unit,
      // The Rust rolling-window verdict; 'unknown' while unmeasured.
      health: healthEnumFor(i),
    })),
    environment: lastEnv ? { temperature: lastEnv.temperature, humidity: lastEnv.humidity } : null,
    baseline: {
      state: warming ? 'warming' : anomalyState === 'unknown' ? 'none' : 'ready',
      progress: baselineProgress,
      // Age only when observed in this session; null is honest elsewhere.
      ageSec: !vialResult && baselineReadyAt !== null
        ? Math.max(0, Math.round((Date.now() - baselineReadyAt) / 1000))
        : null,
    },
    anomaly: {
      state: anomalyState,
      score: anomalyScore,
      confidence: anomalyConfidence,
      alertLevel: anomalyLevel,
      triggeredChannels: anomalyTriggered,
      consecutive: anomalyConsecutive,
    },
    classifier: liveSnapshot?.loaded
      ? {
          state: 'loaded',
          name: liveSnapshot.classifier_name,
          label: liveSnapshot.current_prediction?.label || null,
          confidence: liveSnapshot.current_prediction?.confidence ?? null,
        }
      : { state: 'none', name: null, label: null, confidence: null },
    channelLimits: channelLimitsFor(),
    detectionConfig: runtime?.pack.anomaly
      ? {
          enabled: runtime.pack.anomaly.detection.enabled,
          alertThreshold: runtime.pack.anomaly.detection.alertThreshold,
          perChannelLimits: runtime.pack.anomaly.detection.perChannelLimits,
        }
      : runtime?.detectionConfig || null,
    detection: null,
    transformsApplied: runtime?.transforms
      ? [runtime.transforms.baseline, ...runtime.transforms.conditioning, runtime.transforms.response]
      : [],
    trajectory: runtime ? runtime.trajectory.slice(-600) : [],
  };
}

function renderVialHome(): void {
  const body = document.getElementById('vialHomeBody');
  const section = document.getElementById('vialHomeSection');
  if (!body) return;

  const installed = Domain.loadInstalledIds()
    .map(id => Domain.domainPackById(id))
    .filter((pack): pack is Domain.DomainPack => !!pack);
  const preferred = selectedHomeVialId();
  const active = (preferred ? installed.find(p => p.id === preferred) : undefined)
    || (activeDomainPackId ? installed.find(p => p.id === activeDomainPackId) : undefined)
    || installed.find(p => p.home)
    || installed[0];

  if (!active) {
    if (homeTakeoverVialId) clearHomeTakeover();
    destroyHomeVialRuntime();
    section?.classList.remove('stage');
    body.innerHTML = `<div class="vial-home-empty">No Vial installed. <button class="mini-btn" type="button" data-vial-action="browse">Browse Vials →</button></div>`;
    body.querySelector<HTMLButtonElement>('[data-vial-action="browse"]')?.addEventListener('click', () => showWorkspaceView('vials'));
    return;
  }

  const homeHtml = active.homeUi ? resolveDomainUiHtml(active, 'home') : null;
  if (homeHtml) {
    if (homeTakeoverVialId === active.id) {
      renderHomeTakeover(active, homeHtml);
      return;
    }
    if (homeTakeoverVialId) clearHomeTakeover();
    destroyHomeVialRuntime();
    section?.classList.remove('stage');
    body.innerHTML = vialHomeBarHtml(active);
    body.querySelector<HTMLButtonElement>('[data-vial-action="takeover"]')?.addEventListener('click', () => {
      activateHomeTakeover(active.id);
    });
    body.querySelector<HTMLButtonElement>('[data-vial-action="open-workspace"]')?.addEventListener('click', () => {
      showWorkspaceView('vials');
      openDomainWorkspace(active.id);
    });
    return;
  }

  if (homeTakeoverVialId) clearHomeTakeover();
  destroyHomeVialRuntime();
  if (active.homeUi) {
    body.innerHTML = `<div class="vial-home-empty"><b>${escapeHtmlText(active.name)}</b><br>The compact Home view is not cached. Reinstall this Vial to fetch <code>home.html</code>.<br><button class="mini-btn" type="button" data-vial-action="open-workspace" data-vial-id="${escapeHtmlText(active.id)}">Open workspace →</button></div>`;
    body.querySelector<HTMLButtonElement>('[data-vial-action="open-workspace"]')?.addEventListener('click', (event) => {
      const id = (event.currentTarget as HTMLButtonElement).dataset.vialId!;
      showWorkspaceView('vials');
      openDomainWorkspace(id);
    });
    return;
  }

  const contribution = VialHost.homeContributionFor(active, currentHostSnapshot());
  if (!contribution) {
    body.innerHTML = `<div class="vial-home-empty"><b>${escapeHtmlText(active.name)}</b><br>${escapeHtmlText(active.tagline)}<br><button class="mini-btn" type="button" data-vial-action="open-workspace" data-vial-id="${escapeHtmlText(active.id)}">Open workspace →</button></div>`;
    body.querySelector<HTMLButtonElement>('[data-vial-action="open-workspace"]')?.addEventListener('click', (event) => {
      const id = (event.currentTarget as HTMLButtonElement).dataset.vialId!;
      showWorkspaceView('vials');
      openDomainWorkspace(id);
    });
    return;
  }

  const gate = VialHost.validateHomeContribution(contribution);
  if (!gate.ok) {
    body.innerHTML = `<div class="vial-home-empty"><b>${escapeHtmlText(active.name)}</b><br>This Vial's Home contribution did not pass the host contract: ${escapeHtmlText(gate.errors[0])}</div>`;
    return;
  }

  const metrics = [...contribution.runtime, ...contribution.metrics].slice(0, 4);
  body.innerHTML = `<div class="vial-home-card ${contribution.state}" title="${escapeHtmlText(`${contribution.detail} ${contribution.limits.join(' ')}`)}">
    <div class="vial-home-top">
      <span class="vial-home-state ${contribution.state}">${escapeHtmlText(contribution.stateLabel)}</span>
      <span class="vial-home-state">${escapeHtmlText(contribution.vialName)}</span>
    </div>
    <div class="vial-home-headline">${escapeHtmlText(contribution.headline)}</div>
    <div class="vial-home-detail">${escapeHtmlText(contribution.detail)}</div>
    <div class="vial-home-metrics">${metrics.map(m => `<div class="vial-home-metric" title="${escapeHtmlText(m.hint || '')}"><div class="k">${escapeHtmlText(m.label)}</div><div class="v">${escapeHtmlText(m.value)}</div></div>`).join('')}</div>
    <div class="vial-home-actions">${contribution.actions.map(a => `<button class="mini-btn" type="button" data-vial-action="${escapeHtmlText(a.kind)}" data-vial-id="${escapeHtmlText(contribution.vialId)}"${a.href ? ` data-vial-href="${escapeHtmlText(a.href)}"` : ''}>${escapeHtmlText(a.label)}</button>`).join('')}</div>
    <div class="vial-home-limit" title="${escapeHtmlText(contribution.limits.join(' '))}">${escapeHtmlText(contribution.limits[0])}</div>
  </div>`;

  body.querySelectorAll<HTMLButtonElement>('[data-vial-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.vialAction;
      if (kind === 'open-workspace') {
        showWorkspaceView('vials');
        openDomainWorkspace(btn.dataset.vialId!);
      } else if (kind === 'open-check') {
        showWorkspaceView('check');
      } else if (kind === 'open-datasets') {
        showWorkspaceView('datasets');
      } else if (kind === 'open-gallery') {
        showWorkspaceView('smells');
      } else if (kind === 'external' && btn.dataset.vialHref) {
        window.open(btn.dataset.vialHref, '_blank', 'noopener,noreferrer');
      }
    });
  });
}

async function refreshTrainLibrary() {
  try {
    await invoke('import_recordings');
    sessions = mapIndexRecords(await invoke<RawSessionRecord[]>('get_session_index'));
    renderLibrary();
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
    updateFwBoardLabel();
    status.textContent = `${esp.label} on ${esp.port} (${esp.vid_pid})${esp.serial_number ? ' · SN ' + esp.serial_number : ''}`;
  } catch (e) {
    status.textContent = `Detection failed: ${e}`;
  }
});

// Compare mode switching + delta reference
document.getElementById('comparePick')?.addEventListener('click', () => {
  showWorkspaceView('smells');
});
document.getElementById('compareEmptyPick')?.addEventListener('click', () => {
  showWorkspaceView('smells');
});
document.getElementById('compareEmptyTry')?.addEventListener('click', () => {
  void tryStarterCompare();
});
document.querySelectorAll<HTMLElement>('#compareModes .cmp-mode').forEach(btn => {
  btn.addEventListener('click', () => {
    compareMode = (btn.dataset.mode as 'overlay' | 'delta' | 'heatmap' | 'trajectory') || 'overlay';
    document.querySelectorAll<HTMLElement>('#compareModes .cmp-mode').forEach(b => b.classList.toggle('active', b === btn));
    const title = document.getElementById('cmpVizTitle')!;
    const foot = document.getElementById('compareFoot')!;
    title.textContent = compareMode === 'heatmap'
      ? 'Similarity — Pearson correlation across sessions'
      : compareMode === 'trajectory'
        ? 'Trajectory — the shape of the response'
        : compareMode === 'delta'
          ? 'Δ vs ref — each session minus the reference'
          : 'Overlay — per-channel normalized response';
    foot.textContent = compareMode === 'heatmap'
      ? 'Similarity: Pearson correlation over the shared overlap of the selected channels.'
      : compareMode === 'trajectory'
        ? 'Trajectory: each path is smoothed, centred on its own opening vector and scaled to its own size, then projected onto two principal axes — so this compares transformation, not strength. Start is shared; filled end is labelled. Descriptive projection; the Explore advisor is the held-out test.'
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
document.getElementById('libTransform')?.addEventListener('click', () => showWorkspaceView('recipes'));
document.getElementById('anomalyEvents')?.addEventListener('click', () => showWorkspaceView('changelog'));
document.getElementById('eventsBack')?.addEventListener('click', () => activateWorkspace('dashboard'));
document.getElementById('libSearch')?.addEventListener('input', () => {
  if (libSearchDebounce !== null) clearTimeout(libSearchDebounce);
  libSearchDebounce = window.setTimeout(renderLibrary, 150);
});

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

// Compact library timestamp — one line, no seconds/AM-PM noise. Sessions are
// usually minutes apart; the full date is a hover away in the inspector.
function fmtLibTime(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// === Smells gallery — substances as first-class objects ===
// The library is files; a person is interested in smells. This groups the
// library by substance and shows what the array actually did when it met each
// one — the mean baseline-relative response across that substance's recordings.
interface SmellCardData {
  /** Case-folded identity used for selection and caching. */
  key: string;
  /** Display name, taken from the first recording seen. */
  substance: string;
  records: SessionRecord[];
  channels: string[];
  values: number[] | null;
  /** Mean shape per channel over relative time, once loaded. */
  traces?: number[][];
  /** The recordings that share the dominant array signature, once loaded. */
  groupRecords?: SessionRecord[];
  /** How many of that group were averaged into the mean fingerprint. */
  usedInMean?: number;
  meanQuality: number;
  analyzed: number;
}

interface MeanResponse {
  channels: string[];
  values: number[];
  /** How many recordings were averaged into the fingerprint. */
  used: number;
  /** How many recordings share this channel-for-channel array. */
  groupSize: number;
  /** How many usable recordings the card had before the array check. */
  total: number;
  /** The recordings that share this array; used for provenance. */
  records: SessionRecord[];
}

let smellCards: SmellCardData[] = [];

/** Explicit preparations inside one substance, e.g. `Warm · After warm`.
 *  These are nuances, not separate smell identities, and never invented. */
function smellPreparationLabel(c: SmellCardData): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of c.records) {
    const prep = (r.preparation || '').trim();
    const key = prep.toLowerCase();
    if (!prep || seen.has(key)) continue;
    seen.add(key);
    out.push(titleCase(prep));
  }
  return out.join(' · ');
}

const smellSel = new Set<string>();
const smellFpCache = new Map<string, MeanResponse | null>();
// In-flight fingerprint loads, so opening a detail while the gallery is still
// filling does not fetch the same recordings twice.
const smellFpPending = new Map<string, Promise<MeanResponse | null>>();
// Bumped whenever the library changes; a load that started before the change
// must not write its stale result back into the cache.
let smellCacheGen = 0;

function titleCase(s: string): string {
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

/** Mean settled, baseline-relative response per channel, across up to 3 recordings
 *  from the card's dominant array. A smell can have recordings from more than one
 *  physical array (an imported dataset plus the user's rig); those must never be
 *  blended, so pick the largest channel-for-channel group first, then average. */
async function meanResponseFor(recs: SessionRecord[]): Promise<MeanResponse | null> {
  const usable = recs.filter(r => !!r.file_id);
  interface Group { channels: string[]; series: SessionSeries[]; records: SessionRecord[]; }
  const groups = new Map<string, Group>();
  for (const r of usable) {
    const series = await loadCompareSeries(r.file_id!);
    if (!series || !series.channels.length) continue;
    const sig = series.channels.join('\u0000');
    let g = groups.get(sig);
    if (!g) {
      g = { channels: series.channels.slice(), series: [], records: [] };
      groups.set(sig, g);
    }
    g.series.push(series);
    g.records.push(r);
  }
  // The dominant array, not whichever recording happened to sort first.
  const best = [...groups.values()].sort((a, b) => b.series.length - a.series.length)[0];
  if (!best) return null;
  // Use every replicate on the dominant array. The verdict already uses all of
  // them (up to its row cap); making the displayed mean match avoids a card
  // that describes three recordings while the separation test used five.
  const used = best.series;
  const acc: number[][] = [];
  for (const series of used) {
    const per: number[] = [];
    for (let ci = 0; ci < series.channels.length; ci++) {
      const norm = cmpNorm(series, ci);
      if (!norm || !norm.length) { per.push(NaN); continue; }
      per.push(meanOf(norm.slice(Math.floor(norm.length * 0.4))));
    }
    acc.push(per);
  }
  const values = best.channels.map((_, i) => {
    const v = acc.map(a => a[i]).filter(Number.isFinite);
    // NaN (not 0) when a channel could not be normalised at all: an absent
    // measurement must never be drawn as a small real one.
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  });
  return {
    channels: best.channels,
    values,
    used: used.length,
    groupSize: best.series.length,
    total: usable.length,
    records: best.records,
  };
}

// === Separability advisor ===
// "Can this array tell these two smells apart?" is the question that decides
// whether a classifier is even possible. It is answerable *before* training,
// from the replicates already in the library: between-smell gap versus
// within-smell scatter, per channel, plus a leave-one-recording-out check.
// The output is deliberately not just a score — it names the channel that
// carries the difference and the smallest realistic change that would widen it.
interface SmellReplicates {
  channels: string[];
  /**
   * One fingerprint row per recording, `channels.length * FINGERPRINT_FEATURES.length`
   * wide; NaN = that feature is not usable for this channel.
   */
  rows: number[][];
  /** Recordings considered before the array-compatibility filter. */
  considered: number;
}

const smellRepCache = new Map<string, SmellReplicates | null>();

// The settled level alone misses odour identity carried by kinetics: two smells
// can land at the same ΔR/R0 while one rises fast and the other keeps climbing.
// Every feature here is baseline-relative, so it survives a new session on the
// same rig (the absolute sensor offsets do not).
//
// Level and shape are deliberately split. Level features describe *where* the
// response ends up; shape features are amplitude-normalised and describe *how*
// it gets there (timing, rise, retention, late slope). Scoring them separately
// answers whether the array is reading a chemoprint or a transformation — and
// whether kinetics add anything beyond concentration.
const FINGERPRINT_FEATURES = ['settled', 'peak', 'mean', 'early', 'ttp', 'rise', 'retain', 'slope'] as const;
const FP = FINGERPRINT_FEATURES.length;
const LEVEL_FEATURES = new Set(['settled', 'peak', 'mean', 'early']);
const SHAPE_FEATURES = new Set(['ttp', 'rise', 'retain', 'slope']);

function fingerprintFeatures(norm: number[]): number[] {
  const n = norm.length;
  const idx = norm.map((v, i) => (Number.isFinite(v) ? i : -1)).filter(i => i >= 0);
  if (idx.length < 5) return new Array(FP).fill(NaN);
  const vals = idx.map(i => norm[i]);
  let peak = 0;
  let peakIdx = -1;
  for (const i of idx) {
    if (Math.abs(norm[i]) > Math.abs(peak)) { peak = norm[i]; peakIdx = i; }
  }

  const settleStart = Math.floor(n * 0.6);
  const settle: number[] = [];
  const early: number[] = [];
  for (const i of idx) {
    if (i >= settleStart) settle.push(norm[i]);
    if (i >= n * 0.1 && i < n * 0.35) early.push(norm[i]);
  }
  // Slope over the settled stretch, expressed as the change across that whole
  // stretch so it is on the same scale as the response itself.
  let slope = NaN;
  if (settle.length >= 3) {
    const m = meanOf(settle);
    let num = 0, den = 0;
    for (let k = 0; k < settle.length; k++) {
      const t = k - (settle.length - 1) / 2;
      num += t * (settle[k] - m);
      den += t * t;
    }
    if (den > 0) slope = (num / den) * settle.length;
  }
  const settled = settle.length ? meanOf(settle) : NaN;
  const earlyMean = early.length ? meanOf(early) : NaN;
  // Shape features need a response to normalise against; below 0.1% the ratios
  // are numerically meaningless and must not masquerade as strong separation.
  const hasPeak = Math.abs(peak) >= 1e-3;
  return [
    settled,
    peak,
    meanOf(vals),
    earlyMean,
    peakIdx >= 0 && n > 1 ? peakIdx / (n - 1) : NaN,
    hasPeak && Number.isFinite(earlyMean) ? (peak - earlyMean) / Math.abs(peak) : NaN,
    hasPeak ? settled / peak : NaN,
    hasPeak && Number.isFinite(slope) ? Math.max(-10, Math.min(10, slope / Math.abs(peak))) : NaN,
  ];
}

async function smellReplicates(card: SmellCardData, max = 6): Promise<SmellReplicates | null> {
  const cached = smellRepCache.get(card.key);
  if (cached !== undefined) return cached;
  const gen = smellCacheGen;
  const usable = card.records.filter(r => !!r.file_id);
  interface Group { channels: string[]; rows: number[][]; }
  const groups = new Map<string, Group>();
  for (const r of usable) {
    const series = await loadCompareSeries(r.file_id!);
    if (!series || !series.channels.length) continue;
    // Never blend a 6-channel rig with a 7-channel one, even when the width
    // happens to match but the sensors are wired differently. Group first, then
    // use the largest group; a card can contain more than one physical array.
    const sig = series.channels.join('\u0000');
    let g = groups.get(sig);
    if (!g) {
      g = { channels: series.channels.slice(), rows: [] };
      groups.set(sig, g);
    }
    const row: number[] = [];
    for (let ci = 0; ci < series.channels.length; ci++) {
      const norm = cmpNorm(series, ci);
      row.push(...(norm && norm.length ? fingerprintFeatures(norm) : new Array(FP).fill(NaN)));
    }
    g.rows.push(row);
  }
  const best = [...groups.values()].sort((a, b) => b.rows.length - a.rows.length)[0];
  const out = best && best.rows.length
    ? { channels: best.channels, rows: best.rows.slice(0, max), considered: usable.length }
    : null;
  if (gen === smellCacheGen) smellRepCache.set(card.key, out);
  return out;
}

interface ChannelSeparation {
  channel: string;
  /** Feature carrying the largest gap, and its effect size. */
  feature: string;
  d: number;
  meanA: number;
  meanB: number;
  /** Reads exactly nothing for this smell — dead or poisoned, not different. */
  silentA: boolean;
  silentB: boolean;
}

type SeparationVerdict = 'separable' | 'fragile' | 'confusable' | 'insufficient';

interface SmellPairSeparation {
  a: SmellCardData;
  b: SmellCardData;
  nA: number;
  nB: number;
  consideredA: number;
  consideredB: number;
  channels: ChannelSeparation[];
  best: ChannelSeparation | null;
  /** Leave-one-recording-out nearest-centroid accuracy; NaN if unevaluable. */
  acc: number;
  /** Same check using only level features / only amplitude-normalised shape. */
  accLevel: number;
  accShape: number;
  nEval: number;
  /** Label-shuffle p-value for the best view; NaN if not computed. */
  pValue: number;
  /** Number of label arrangements the p-value is based on. */
  permutations: number;
  verdict: SeparationVerdict;
  lever: string;
}

function sdOf(v: number[]): number {
  if (v.length < 2) return NaN;
  const m = meanOf(v);
  return Math.sqrt(v.reduce((a, x) => a + (x - m) * (x - m), 0) / (v.length - 1));
}

function finiteColumn(rows: number[][], ci: number): number[] {
  return rows.map(r => r[ci]).filter(Number.isFinite);
}

// Hedges-corrected standardized mean difference between two replicate sets.
// NaN when either side has fewer than two usable replicates.
function cohensD(fa: number[], fb: number[]): number {
  if (fa.length < 2 || fb.length < 2) return NaN;
  const varA = sdOf(fa) ** 2;
  const varB = sdOf(fb) ** 2;
  const pooled = Math.sqrt(((fa.length - 1) * varA + (fb.length - 1) * varB) / (fa.length + fb.length - 2));
  const delta = Math.abs(meanOf(fa) - meanOf(fb));
  // A flat channel with a tiny real offset must not read as infinite
  // separation; cap it at the top of the credible range.
  let d = pooled > 1e-9 ? delta / pooled : (delta > 1e-9 ? 8 : 0);
  const df = fa.length + fb.length - 2;
  return Math.min(8, d * (1 - 3 / (4 * df - 1)));
}

// A channel that is flat-zero for every replicate carries no information. It
// is not "similar" — it is absent, and the advice differs.
function columnSilent(v: number[]): boolean {
  return v.length === 0 || v.every(x => Math.abs(x) < 1e-4);
}

function separationBetween(a: SmellReplicates, b: SmellReplicates, runPermutation = true): {
  channels: ChannelSeparation[]; acc: number; accLevel: number; accShape: number; nEval: number;
  pValue: number; permutations: number;
} {
  const channels: ChannelSeparation[] = [];
  for (let ci = 0; ci < a.channels.length; ci++) {
    if (a.channels[ci] !== b.channels[ci]) continue;
    const allA: number[] = [];
    const allB: number[] = [];
    let bestD = NaN;
    let bestFeature = '';
    let bestMeanA = NaN;
    let bestMeanB = NaN;
    for (let f = 0; f < FP; f++) {
      const fa = finiteColumn(a.rows, ci * FP + f);
      const fb = finiteColumn(b.rows, ci * FP + f);
      allA.push(...fa);
      allB.push(...fb);
      const d = cohensD(fa, fb);
      if (Number.isFinite(d) && !(d <= bestD)) {
        bestD = d;
        bestFeature = FINGERPRINT_FEATURES[f];
        bestMeanA = meanOf(fa);
        bestMeanB = meanOf(fb);
      }
    }
    channels.push({
      channel: a.channels[ci], feature: bestFeature, d: bestD,
      meanA: bestMeanA, meanB: bestMeanB,
      silentA: columnSilent(allA), silentB: columnSilent(allB),
    });
  }
  const observed = bestViewAccuracy(a.rows, b.rows);
  const perm = runPermutation
    ? separationPermutationP(a.rows, b.rows, observed.best)
    : { p: NaN, total: 0 };
  return {
    channels,
    acc: observed.acc, accLevel: observed.level, accShape: observed.shape,
    nEval: observed.n,
    pValue: perm.p, permutations: perm.total,
  };
}

// Honest small-sample check: standardize each feature by its pooled spread,
// then ask whether each recording is closer to its own smell's centroid when
// that recording is left out. This is the same logic the classifier is scored
// with, minus the model — so it cannot flatter the data.
//
// Only the strongest features are used: with 5 replicates and dozens of
// candidates, feeding every candidate into a nearest-centroid test lets
// irrelevant noise outvote the channels that actually separate the pair.
// Feature choice therefore happens *inside* every permutation too, so the
// p-value pays for the selection rather than pretending the features were
// fixed in advance.
function rankFeatureIndices(aRows: number[][], bRows: number[][], allow?: Set<string>): number[] {
  const width = aRows[0]?.length ?? 0;
  const out: { f: number; d: number }[] = [];
  for (let f = 0; f < width; f++) {
    if (allow && !allow.has(FINGERPRINT_FEATURES[f % FP])) continue;
    const fa = aRows.map(r => r[f]).filter(Number.isFinite);
    const fb = bRows.map(r => r[f]).filter(Number.isFinite);
    const d = cohensD(fa, fb);
    if (Number.isFinite(d)) out.push({ f, d });
  }
  return out.sort((x, y) => y.d - x.d).map(x => x.f);
}

function looFromRows(aRows: number[][], bRows: number[][], features: number[]): { acc: number; n: number } {
  if (aRows.length < 2 || bRows.length < 2 || !features.length) return { acc: NaN, n: 0 };
  let A = aRows.map(row => features.map(f => row[f]));
  let B = bRows.map(row => features.map(f => row[f]));
  const k = A[0].length;
  const mean: number[] = [];
  const scale: number[] = [];
  for (let j = 0; j < k; j++) {
    const all = [...A.map(r => r[j]), ...B.map(r => r[j])].filter(Number.isFinite);
    if (!all.length) { mean.push(0); scale.push(0); continue; }
    const m = meanOf(all);
    const sd = sdOf(all);
    mean.push(m);
    scale.push(Number.isFinite(sd) ? sd : 0);
  }
  const standardize = (r: number[]) => r.map((v, j) => {
    if (!(scale[j] > 1e-9)) return 0;
    return (Number.isFinite(v) ? (v - mean[j]) / scale[j] : 0);
  });
  A = A.map(standardize);
  B = B.map(standardize);
  const centroid = (rows: number[][]) => {
    const out = new Array(rows[0].length).fill(0);
    for (const r of rows) for (let j = 0; j < out.length; j++) out[j] += r[j] / rows.length;
    return out;
  };
  const sq = (p: number[], q: number[]) => {
    let s = 0;
    for (let j = 0; j < p.length; j++) s += (p[j] - q[j]) ** 2;
    return s;
  };
  let correct = 0;
  for (let i = 0; i < A.length; i++) {
    const own = centroid(A.filter((_, j) => j !== i));
    const other = centroid(B);
    if (sq(A[i], own) <= sq(A[i], other)) correct++;
  }
  for (let i = 0; i < B.length; i++) {
    const own = centroid(B.filter((_, j) => j !== i));
    const other = centroid(A);
    if (sq(B[i], own) <= sq(B[i], other)) correct++;
  }
  return { acc: correct / (A.length + B.length), n: A.length + B.length };
}

// The verdict is the best of three views (level, shape, together), so the
// permutation test uses that same maximum as its statistic. Taking the maximum
// under every shuffle is what keeps the three views from inflating the claim.
function bestViewAccuracy(aRows: number[][], bRows: number[][]): {
  acc: number; level: number; shape: number; n: number; best: number;
} {
  const combined = looFromRows(aRows, bRows, rankFeatureIndices(aRows, bRows).slice(0, 5));
  const level = looFromRows(aRows, bRows, rankFeatureIndices(aRows, bRows, LEVEL_FEATURES).slice(0, 3));
  const shape = looFromRows(aRows, bRows, rankFeatureIndices(aRows, bRows, SHAPE_FEATURES).slice(0, 3));
  const finite = [combined.acc, level.acc, shape.acc].filter(Number.isFinite);
  return {
    acc: combined.acc, level: level.acc, shape: shape.acc,
    n: aRows.length + bRows.length,
    best: finite.length ? Math.max(...finite) : NaN,
  };
}

function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const rec = (start: number) => {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i <= n - (k - cur.length); i++) {
      cur.push(i);
      rec(i + 1);
      cur.pop();
    }
  };
  rec(0);
  return out;
}

function randomCombinations(n: number, k: number, count: number): number[][] {
  let s = 0x9e3779b9;
  const rnd = () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  const out: number[][] = [];
  for (let c = 0; c < count; c++) {
    const idx = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    out.push(idx.slice(0, k).sort((a, b) => a - b));
  }
  return out;
}

function separationPermutationP(
  aRows: number[][], bRows: number[][], observedBest: number,
): { p: number; total: number } {
  const n = aRows.length + bRows.length;
  if (!Number.isFinite(observedBest) || aRows.length < 2 || bRows.length < 2) return { p: NaN, total: 0 };
  const rows = [...aRows, ...bRows];
  // Enumerate every label arrangement while it is cheap (5+5 gives 252); fall
  // back to a fixed-seed sample otherwise so the p-value stays stable.
  const totalCombos = (() => {
    let v = 1;
    for (let i = 1; i <= aRows.length; i++) v = (v * (n - aRows.length + i)) / i;
    return Math.round(v);
  })();
  const combos = totalCombos <= 3000
    ? combinations(n, aRows.length)
    : randomCombinations(n, aRows.length, 2000);
  let atLeastAsGood = 0;
  for (const chosen of combos) {
    const inA = new Set(chosen);
    const A2 = rows.filter((_, i) => inA.has(i));
    const B2 = rows.filter((_, i) => !inA.has(i));
    const stat = bestViewAccuracy(A2, B2).best;
    if (Number.isFinite(stat) && stat >= observedBest - 1e-9) atLeastAsGood++;
  }
  return { p: (atLeastAsGood + 1) / (combos.length + 1), total: combos.length };
}

function separationLever(p: SmellPairSeparation): string {
  const silentA = p.channels.filter(c => c.silentA && !c.silentB).map(c => c.channel);
  const silentB = p.channels.filter(c => c.silentB && !c.silentA).map(c => c.channel);
  const silentBoth = p.channels.filter(c => c.silentA && c.silentB).map(c => c.channel);
  const notes: string[] = [];
  const imported = [p.a, p.b].some(c => (c.records[0]?.path || '').includes('/SmellNet/'))
    || [p.a, p.b].every(c => !(c.records[0]?.path || '').includes('Osmograph_Recordings/'));
  const deadWord = imported ? 'an empty/constant column in this dataset' : 'a dead or poisoned channel';

  if (silentBoth.length) {
    notes.push(`${silentBoth.join(', ')} ${silentBoth.length === 1 ? 'is' : 'are'} flat for both smells — ${silentBoth.length === 1 ? 'it contributes' : 'they contribute'} nothing to this decision (${deadWord}). Separation is being computed on the channels that actually move.`);
  }
  if (silentA.length) {
    notes.push(`${silentA.join(', ')} is flat only for ${titleCase(p.a.substance)} — ${deadWord}, not a difference between smells. Do not count it as separation.`);
  }
  if (silentB.length) {
    notes.push(`${silentB.join(', ')} is flat only for ${titleCase(p.b.substance)} — ${deadWord}, not a difference between smells. Do not count it as separation.`);
  }

  const best = p.best;
  if (!best || !Number.isFinite(best.d)) {
    notes.push(`Need at least two comparable recordings per smell: ${titleCase(p.a.substance)} has ${p.nA}/${p.consideredA} on this array, ${titleCase(p.b.substance)} has ${p.nB}/${p.consideredB}. One replicate each cannot show whether the gap is real or just run-to-run drift.`);
    return notes.join(' ');
  }
  const bestName = `${best.channel} ${best.feature === 'settled' ? 'settled level' : best.feature}`;
  const views = [
    { label: 'level', acc: p.accLevel },
    { label: 'shape', acc: p.accShape },
    { label: 'together', acc: p.acc },
  ].filter(v => Number.isFinite(v.acc)).sort((a, b) => b.acc - a.acc);
  const verdictAcc = views.length ? views[0].acc : p.acc;
  const viewNote = views.length && views[0].label !== 'together' ? ` (${views[0].label} view)` : '';
  const featureLever = best.feature === 'peak' || best.feature === 'early'
    ? 'sharpen the exposure (the transient carries the difference) and keep sampling fast'
    : best.feature === 'slope'
      ? 'hold the exposure open longer so the rise-versus-plateau difference has room to show'
      : 'a longer or stronger exposure';
  const wrong = p.nEval - Math.round(verdictAcc * p.nEval);

  if (p.verdict === 'confusable') {
    if (best.d < 1) {
      notes.push(`Even the best feature, ${bestName}, separates them by only ${best.d.toFixed(1)}σ — the array is largely responding to something they share. Need roughly ${Math.ceil(2 / Math.max(best.d, 0.2))}× more gap: ${featureLever}, or a channel with a different sensing material (another MOX mostly repeats the same cross-sensitivity).`);
    } else {
      notes.push(`${bestName} separates them by ${best.d.toFixed(1)}σ; a reliable margin needs about 2σ. Widen that gap ≈${(2 / best.d).toFixed(1)}× with ${featureLever}, or add a channel tuned to a gas where they differ.`);
    }
  } else if (p.verdict === 'fragile') {
    if (Number.isFinite(p.pValue) && p.pValue > 0.05 && verdictAcc >= 0.9) {
      notes.push(`${Math.round(verdictAcc * p.nEval)}/${p.nEval} left-out recordings land on the right smell, but with ${p.nEval} recordings and ${p.channels.length * FP} candidate features a label shuffle reaches the same best score ${Math.round(p.pValue * 100)}% of the time (p = ${p.pValue.toFixed(2)} over ${p.permutations} arrangements, with the feature choice repeated inside each). Promising, not established — collect independent replicates after fixing the channel set, rather than selecting features on the same runs.`);
    } else if (best.d >= 2) {
      notes.push(`The average gap on ${bestName} is ${best.d.toFixed(1)}σ, but replicate scatter erodes it (${wrong}/${p.nEval} left-out recordings land on the wrong smell). The lever is consistency — same exposure time, baseline and temperature every run — plus one more replicate per smell.`);
    } else {
      notes.push(`Only ${Math.round(verdictAcc * p.nEval)}/${p.nEval} left-out recordings land on the right smell${viewNote}. Push ${bestName} past 2σ (${(2 / Math.max(best.d, 0.2)).toFixed(1)}× wider) or add a channel with different selectivity before relying on this pair.`);
    }
  } else {
    notes.push(`No change needed: ${Math.round(verdictAcc * p.nEval)}/${p.nEval} left-out recordings land on the right smell${viewNote}, best feature ${bestName} at ${best.d.toFixed(1)}σ. Hold exposure time and baseline conditions steady so the margin survives the next session.`);
  }

  // Say *which kind* of information carries the separation. Treating a kinetic
  // signature as a chemoprint is a real error: concentration changes the level,
  // while flow/temperature/timing change the shape. The user needs to know which
  // one they are trusting.
  const level = p.accLevel, shape = p.accShape;
  if (Number.isFinite(level) && Number.isFinite(shape) && Number.isFinite(p.acc)
      && (!Number.isFinite(p.pValue) || p.pValue <= 0.15)) {
    if (shape >= p.acc - 0.15 && shape >= level + 0.15) {
      notes.push(`Most of that comes from the temporal shape, not the steady level — so keep exposure duration, flow and temperature identical between runs; changing concentration will move the level while leaving this signal intact.`);
    } else if (level >= p.acc - 0.15 && level >= shape + 0.15) {
      notes.push(`The steady-state pattern does the work and the trajectory adds little — spend the next effort on channel selectivity, not a more elaborate protocol.`);
    }
  }
  return notes.join(' ');
}

// Wilson score lower bound (95%). With only 10 held-out recordings, raw
// accuracy is too optimistic: 8/10 is not the same evidence as 80% from 200
// trials. The bound keeps a small lucky run from reading as "separable".
function wilsonLower(correct: number, n: number): number {
  if (n <= 0) return NaN;
  const z = 1.96;
  const p = Math.max(0, Math.min(1, correct / n));
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

function separationVerdict(acc: number, bestD: number, n: number, p: number): SeparationVerdict {
  if (!Number.isFinite(acc) || n <= 0) return 'insufficient';
  const lower = wilsonLower(Math.round(acc * n), n);
  if (lower >= 0.55 && bestD >= 1.2 && (!Number.isFinite(p) || p <= 0.05)) return 'separable';
  if (lower >= 0.3) return 'fragile';
  return 'confusable';
}

const SEP_VERDICT_LABEL: Record<SeparationVerdict, string> = {
  separable: 'separable',
  fragile: 'fragile',
  confusable: 'confusable',
  insufficient: 'needs replicates',
};

/** One pair verdict, shared by the front-door advisor and the smell detail. */
function sepPairHtml(p: SmellPairSeparation): string {
  const active = p.channels.filter(c => Number.isFinite(c.d) && !(c.silentA && c.silentB));
  const comparable = `${p.nA}${p.nA < p.consideredA ? `/${p.consideredA}` : ''} vs ${p.nB}${p.nB < p.consideredB ? `/${p.consideredB}` : ''}`;
  const lower = Number.isFinite(p.acc) && p.nEval > 0
    ? wilsonLower(Math.round(p.acc * p.nEval), p.nEval)
    : NaN;
  const lowerText = Number.isFinite(lower) ? ` · 95% lower ${Math.round(lower * 100)}%` : '';
  const pText = Number.isFinite(p.pValue)
    ? `<span class="pval" title="${p.permutations} label arrangements; the feature choice was repeated inside each one, so p pays for the selection">p ${p.pValue < 0.001 ? '< 0.001' : `= ${p.pValue.toFixed(3)}`}</span>`
    : '';
  const splitChip = (label: string, v: number) => Number.isFinite(v)
    ? `<span class="${v >= 0.8 ? 'good' : v >= 0.6 ? 'mid' : 'poor'}">${label} <b>${Math.round(v * p.nEval)}/${p.nEval}</b></span>`
    : `<span class="pval">${label} n/a</span>`;
  return `<div class="sep-pair ${p.verdict}">
    <div class="sep-pair-head">
      <span class="sep-names">${titleCase(p.a.substance)} ↔ ${titleCase(p.b.substance)}</span>
      <span class="sep-badge ${p.verdict}">${SEP_VERDICT_LABEL[p.verdict]}</span>
    </div>
    <div class="sep-sub">${Number.isFinite(p.acc)
      ? `${Math.round(p.acc * p.nEval)}/${p.nEval} left-out recordings match their own smell${lowerText} · ${comparable} on this array`
      : `${comparable} recordings on this array — add a second recording of each for a verdict`}</div>
    <div class="sep-chans">
      ${active.map(c => `<span class="sep-ch ${c.d >= 2 ? 'good' : c.d >= 1 ? 'mid' : 'poor'}" title="${c.channel} · ${c.feature} · ${c.d.toFixed(1)}σ separation">${c.channel}${c.feature && c.feature !== 'settled' ? ` ${c.feature}` : ''} ${c.d.toFixed(1)}σ</span>`).join('')}
    </div>
    ${[p.acc, p.accLevel, p.accShape].some(Number.isFinite) ? `<div class="sep-split">
      ${splitChip('level', p.accLevel)}
      ${splitChip('shape', p.accShape)}
      ${splitChip('together', p.acc)}
      ${pText}
    </div>` : ''}
    <div class="sep-lever">${p.lever}</div>
  </div>`;
}

/** Build one pair verdict from two replicate sets. Shared by the gallery
 *  advisor and Check so both use the same uncertainty rules. */
function makeSeparationPair(
  a: SmellCardData, b: SmellCardData, ra: SmellReplicates, rb: SmellReplicates,
  runPermutation = true,
): SmellPairSeparation | null {
  const { channels, acc, accLevel, accShape, nEval, pValue, permutations } = separationBetween(ra, rb, runPermutation);
  if (!channels.length) return null;
  const best = [...channels].sort((x, y) => (Number.isFinite(y.d) ? y.d : -1) - (Number.isFinite(x.d) ? x.d : -1))[0] || null;
  const pair: SmellPairSeparation = {
    a, b,
    nA: ra.rows.length, nB: rb.rows.length,
    consideredA: ra.considered, consideredB: rb.considered,
    channels, best, acc, accLevel, accShape, nEval, pValue, permutations,
    verdict: separationVerdict(
      Math.max(acc, Number.isFinite(accLevel) ? accLevel : -1, Number.isFinite(accShape) ? accShape : -1),
      best && Number.isFinite(best.d) ? best.d : 0,
      nEval,
      pValue,
    ),
    lever: '',
  };
  pair.lever = separationLever(pair);
  return pair;
}

let sepRenderToken = 0;

async function renderSmellSeparation(): Promise<void> {
  const panel = document.getElementById('smellsSep');
  if (!panel) return;
  const chosen = smellCards.filter(c => smellSel.has(c.key));
  if (chosen.length < 2) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }
  const token = ++sepRenderToken;
  panel.hidden = false;
  panel.innerHTML = `<div class="sep-head"><span class="sep-title">Would these separate on a new session?</span>
    <span class="coord-tag">reading replicates…</span></div>`;

  const reps = await Promise.all(chosen.map(c => smellReplicates(c)));
  if (token !== sepRenderToken) return;

  const pairs: SmellPairSeparation[] = [];
  for (let i = 0; i < chosen.length; i++) {
    for (let j = i + 1; j < chosen.length; j++) {
      const ra = reps[i], rb = reps[j];
      if (!ra || !rb) continue;
      const pair = makeSeparationPair(chosen[i], chosen[j], ra, rb);
      if (pair) pairs.push(pair);
    }
  }

  if (!pairs.length) {
    const widths = chosen.map(c => {
      const w = c.records.map(r => r.sensors).filter(n => n > 0);
      const uniq = [...new Set(w)];
      return `${titleCase(c.substance)} (${uniq.length ? uniq.join('/') : '?'} ch)`;
    });
    panel.innerHTML = `<div class="sep-head"><span class="sep-title">Would these separate on a new session?</span>
        <span class="sep-head-actions">
          <button class="mini-btn" id="sepClearSel" type="button">Deselect all</button>
          <span class="coord-tag">incomparable arrays</span>
        </span></div>
      <div class="sep-lever">No channel-for-channel comparison: ${widths.join(' vs ')}. Separation is only meaningful between recordings from the same array width — re-record the missing smell on the same rig to compare them.</div>`;
    panel.querySelector<HTMLButtonElement>('#sepClearSel')?.addEventListener('click', clearSmellSelection);
    return;
  }

  const rank: Record<SeparationVerdict, number> = { confusable: 0, fragile: 1, insufficient: 2, separable: 3 };
  pairs.sort((x, y) => rank[x.verdict] - rank[y.verdict]
    || (Number.isFinite(x.acc) ? x.acc : 2) - (Number.isFinite(y.acc) ? y.acc : 2));
  const shown = pairs.slice(0, 3);
  const rest = pairs.length - shown.length;

  // The signed difference wheel belongs in the gallery too: selecting A and B
  // should show what actually changed, not only a verdict badge. It is drawn
  // only for a same-array pair; different channel sets get an explicit refusal.
  let diffHtml = '';
  let diffValues: number[] | null = null;
  let diffChannels: string[] = [];
  if (chosen.length === 2) {
    const [ma, mb] = await Promise.all([ensureMean(chosen[0]), ensureMean(chosen[1])]);
    if (token !== sepRenderToken) return;
    const sameArray = !!ma && !!mb && ma.channels.join('\u0000') === mb.channels.join('\u0000');
    if (sameArray) {
      diffChannels = ma!.channels;
      diffValues = ma!.values.map((v, i) => {
        const other = mb!.values[i];
        return Number.isFinite(v) && Number.isFinite(other) ? other - v : NaN;
      });
    }
    const names = `${titleCase(chosen[0].substance)} → ${titleCase(chosen[1].substance)}`;
    diffHtml = `<div class="sep-diff">
      <canvas class="sep-diff-print" id="sepDiffPrint"></canvas>
      <div class="sep-diff-copy">
        <div class="sep-diff-names">${escapeHtmlText(names)}</div>
        <div>Signed difference on the same array. Outward means the sample is higher; inward means lower. This is not a chemical ID and it does not transfer to another rig.</div>
        <button class="mini-btn" id="sepOpenCheck" type="button">Open in Separability →</button>
      </div>
    </div>`;
  }

  panel.innerHTML = `
    <div class="sep-head">
      <span class="sep-title">Would these separate on a new session?</span>
      <span class="sep-head-actions">
        <button class="mini-btn" id="sepClearSel" type="button">Deselect all</button>
        <span class="coord-tag">${chosen.length} smells · ${pairs.length} pair${pairs.length === 1 ? '' : 's'} · worst first</span>
      </span>
    </div>
    ${diffHtml}
    <div class="sep-pairs">
      ${shown.map(sepPairHtml).join('')}
    </div>
    ${rest > 0 ? `<div class="sep-more">${rest} more pair${rest === 1 ? '' : 's'} better separated.</div>` : ''}
    <div class="sep-foot">σ = between-smell gap ÷ pooled replicate scatter. Level and shape are scored separately: level uses the steady response, shape uses amplitude-normalised timing (peak time, rise, retention, late slope). Each is a leave-one-recording-out nearest-centroid preview; the badge takes the best view, applies a 95% lower bound (8/10 ≠ 80%) and a label-shuffle p-value whose feature choice is repeated inside every shuffle. Absolute sensor levels are deliberately removed so the verdict reflects what survives a new session — a model trained on one dataset can score higher on it. Shuffling labels assumes the runs are exchangeable; if every replicate of one smell was collected together, a session or day confound can pass this test.</div>`;

  panel.querySelector<HTMLButtonElement>('#sepClearSel')?.addEventListener('click', clearSmellSelection);
  const diffCanvas = document.getElementById('sepDiffPrint') as HTMLCanvasElement | null;
  if (diffCanvas) {
    if (diffValues) drawCheckDifference(diffCanvas, diffValues, diffChannels);
    else drawCheckDifferenceMessage(diffCanvas, 'Different arrays\nNo channel-for-channel\ndifference');
  }
  document.getElementById('sepOpenCheck')?.addEventListener('click', () => {
    if (chosen.length !== 2) return;
    checkPrefill = { ref: chosen[0].key, sample: chosen[1].key };
    document.querySelector<HTMLElement>('.src-subnav-btn[data-src="check"]')?.click();
  });
}

// === Fingerprint (radar) ===
// The signature visual: one axis per channel, the mean settled response of the
// array to this smell. This is the object people recognise and share — the
// pattern across sensors, not a time-series chart. The signed bars carry
// polarity; a dead channel is drawn hollow at the centre, never as a zero.
interface FingerprintOpts {
  /** Draw channel names around the ring (detail view, share card). */
  labels?: boolean;
  /** Thinner stroke for the small gallery cards. */
  compact?: boolean;
  /** Keep the surrounding background (share cards); UI canvases clear first. */
  clear?: boolean;
}

function drawFingerprintInto(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  values: number[], channels: string[], opts: FingerprintOpts = {},
): void {
  if (w <= 0 || h <= 0) return;
  const compact = !!opts.compact;
  const n = Math.max(values.length, channels.length, 1);
  const pad = opts.labels ? (compact ? 16 : 26) : 6;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const r = Math.max(8, Math.min(w, h) / 2 - pad);
  const finite = values.filter(Number.isFinite);
  const max = Math.max(1e-9, ...finite.map(v => Math.abs(v)));

  ctx.save();
  if (opts.clear !== false) ctx.clearRect(x, y, w, h);

  // Grid rings and axes.
  for (let ring = 1; ring <= 4; ring++) {
    ctx.strokeStyle = ring === 4 ? 'rgba(29,26,22,0.16)' : 'rgba(29,26,22,0.075)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const rr = (ring / 4) * r;
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    ctx.strokeStyle = 'rgba(29,26,22,0.08)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.stroke();
  }

  const norm = Array.from({ length: n }, (_, i) =>
    Number.isFinite(values[i]) ? Math.min(1, Math.abs(values[i]) / max) : 0);

  // One polygon for the array. Fill is deliberately quiet; the shape and the
  // signed dots carry the information.
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const idx = i % n;
    const a = (idx / n) * Math.PI * 2 - Math.PI / 2;
    const px = cx + Math.cos(a) * r * norm[idx];
    const py = cy + Math.sin(a) * r * norm[idx];
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(14,116,144,0.10)';
  ctx.fill();
  ctx.strokeStyle = compact ? '#0f6f86' : cssToken('--cyan');
  ctx.lineWidth = compact ? 1.4 : 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Points and labels. A negative (oxidising) channel is amber; a missing
  // channel is a hollow grey dot at the centre, so it cannot masquerade as a
  // small real response.
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const v = values[i];
    const px = cx + Math.cos(a) * r * norm[i];
    const py = cy + Math.sin(a) * r * norm[i];
    ctx.beginPath();
    ctx.arc(px, py, compact ? 2.2 : 3.2, 0, Math.PI * 2);
    if (!Number.isFinite(v)) {
      ctx.strokeStyle = '#a99e8b';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.fillStyle = v < 0 ? '#b45309' : '#0f6f86';
      ctx.fill();
    }

    if (opts.labels) {
      const lx = cx + Math.cos(a) * (r + (compact ? 10 : 15));
      const ly = cy + Math.sin(a) * (r + (compact ? 10 : 15));
      ctx.fillStyle = Number.isFinite(v) ? '#5f564a' : '#a99e8b';
      ctx.font = `500 ${compact ? 8 : 9}px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.textAlign = Math.cos(a) > 0.25 ? 'left' : Math.cos(a) < -0.25 ? 'right' : 'center';
      ctx.textBaseline = Math.sin(a) > 0.25 ? 'top' : Math.sin(a) < -0.25 ? 'bottom' : 'middle';
      const label = (channels[i] || `CH${i + 1}`).slice(0, 11);
      ctx.fillText(Number.isFinite(v) ? label : `${label} n/a`, lx, ly);
    }
  }
  ctx.restore();
}

function drawCardFingerprint(canvas: HTMLCanvasElement, values: number[], channels: string[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(60, canvas.clientWidth || 180);
  const h = Math.max(50, canvas.clientHeight || 92);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  drawFingerprintInto(ctx, 0, 0, w, h, values, channels, { compact: true });
}

function drawDetailFingerprint(canvas: HTMLCanvasElement, values: number[], channels: string[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(260, canvas.clientWidth || 820);
  const h = Math.max(120, canvas.clientHeight || 190);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  drawFingerprintInto(ctx, 0, 0, w, h, values, channels, { labels: true });
}

function updateSmellSelection(): void {
  const stamp = document.getElementById('smellSelStamp');
  const bar = document.getElementById('smellSelectionBar');
  const btn = document.getElementById('smellCompare') as HTMLButtonElement | null;
  if (stamp) stamp.textContent = `${smellSel.size} selected`;
  if (bar) bar.hidden = smellSel.size === 0;
  if (btn) btn.disabled = smellSel.size < 2;
}

/** One way out of a working set, from both the gallery bar and the comparison
 *  brief. Reselecting is then just ticking cards again. */
function clearSmellSelection(): void {
  if (!smellSel.size) return;
  smellSel.clear();
  void renderSmellGallery();
}

function buildSmellCards(): void {
  const bySub = new Map<string, { display: string; records: SessionRecord[] }>();
  const controls = sessions.filter(s => s.role === 'reference' || s.role === 'noise').length;
  // A mixture is one recording with several components. Counting it as a new
  // smell would turn every combination into a fake class, so mixtures stay in
  // the Library (where the composition is visible) and out of the gallery.
  const isMixture = (s: SessionRecord) => Array.isArray(s.mixture) && s.mixture.length >= 2;
  const mixtures = sessions.filter(isMixture).length;
  function looksConcatenatedSubstance(s: string): boolean {
    const t = s.trim();
    if (!t || t.includes(' ') || t.includes('_') || t.includes('-') || t.includes('+')) return false;
    if (t.length < 10 || t.length > 60) return false;
    const upper = (t.match(/[A-Z]/g) || []).length;
    const lower = (t.match(/[a-z]/g) || []).length;
    if (upper >= 3 && lower >= t.length / 4) return true;
    // Also catch long mixed case runs with no separators
    if (upper >= 2 && lower >= 5 && t.length > 15) return true;
    return false;
  }
  function splitConcatenatedSubstance(s: string): string {
    const t = s.trim();
    if (t.includes(' ') || t.includes('_') || t.includes('-')) return t;
    const re = /[A-Z][a-z]+|\d+[A-Za-z]+/g;
    const parts = t.match(re);
    if (parts && parts.length >= 2) {
      return parts.join(' ');
    }
    return t;
  }
  for (const s of sessions) {
    let raw = (s.substance || '').trim();
    if (!raw || raw.toLowerCase() === 'unknown') continue;
    // Reference/noise runs stay in the Library as evidence, but they are not
    // smell classes and must not be counted as substances.
    if (s.role === 'reference' || s.role === 'noise') continue;
    if (isMixture(s)) continue;
    if (looksConcatenatedSubstance(raw)) {
      const split = splitConcatenatedSubstance(raw);
      if (split !== raw && split.split(/\s+/).length >= 2) {
        raw = split;
      } else {
        // Still try to be defensive - don't drop everything, just normalize if possible
        const re = /[A-Z][a-z]+/g;
        const parts = raw.match(re);
        if (parts && parts.length >= 2) {
          raw = parts.join(' ');
        } else {
          console.warn('Suspicious concatenated substance label dropped from gallery:', raw);
          continue;
        }
      }
    }
    // Group case-insensitively: "Mosquito coil" and "mosquito coil" are one smell.
    const key = raw.toLowerCase();
    const g = bySub.get(key);
    if (g) g.records.push(s); else bySub.set(key, { display: raw, records: [s] });
  }
  smellCards = [...bySub.entries()]
    .map(([key, g]) => {
      const qs = g.records.map(r => r.quality).filter(q => Number.isFinite(q));
      return {
        key, substance: g.display, records: g.records, channels: [], values: null,
        meanQuality: qs.length ? Math.round(qs.reduce((a, b) => a + b, 0) / qs.length) : 0,
        analyzed: g.records.filter(r => r.quality_report).length,
      };
    })
    .sort((a, b) => b.records.length - a.records.length || a.substance.localeCompare(b.substance));
  const sub = document.getElementById('smellsSub');
  if (sub) {
    sub.textContent = `${smellCards.length} smells · ${sessions.length} recordings${mixtures ? ` · ${mixtures} mixture${mixtures === 1 ? '' : 's'} in Library` : ''}${controls ? ` · ${controls} control${controls === 1 ? '' : 's'} in Library` : ''} · grouped by substance`;
  }
}

type SmellFilter = 'all' | 'ready' | 'needs' | 'multi';
type SmellSort = 'recordings' | 'name' | 'quality' | 'newest';
let smellQuery = '';
let smellFilter: SmellFilter = 'all';
let smellSort: SmellSort = 'recordings';
let smellSearchTimer = 0;

function smellArrayCount(c: SmellCardData): number {
  return new Set(c.records.map(r => r.sensors || 0)).size;
}

function smellNewest(c: SmellCardData): string {
  return c.records.reduce((latest, r) => (r.time || '') > latest ? r.time || '' : latest, '');
}

/** The gallery is a working set, not the whole shelf. Search, filters, and sort
 *  are shared by the grid, the "surprise me" action, and the detail arrows so a
 *  person never loses their place when they narrow the list. */
function visibleSmellCards(): SmellCardData[] {
  const q = smellQuery.trim().toLowerCase();
  const out = smellCards.filter(c => {
    if (q && !`${c.substance} ${smellPreparationLabel(c)} ${smellSource(c)}`.toLowerCase().includes(q)) return false;
    if (smellFilter === 'ready' && c.records.filter(r => !!r.file_id).length < 2) return false;
    if (smellFilter === 'needs' && c.analyzed > 0) return false;
    if (smellFilter === 'multi' && smellArrayCount(c) < 2) return false;
    return true;
  });
  out.sort((a, b) => {
    if (smellSort === 'name') return a.substance.localeCompare(b.substance);
    if (smellSort === 'quality') return b.meanQuality - a.meanQuality || b.records.length - a.records.length;
    if (smellSort === 'newest') return smellNewest(b).localeCompare(smellNewest(a));
    return b.records.length - a.records.length || a.substance.localeCompare(b.substance);
  });
  return out;
}

function resetSmellFilters(): void {
  smellQuery = '';
  smellFilter = 'all';
  smellSort = 'recordings';
  const search = document.getElementById('smellSearch') as HTMLInputElement | null;
  if (search) search.value = '';
  const sort = document.getElementById('smellSort') as HTMLSelectElement | null;
  if (sort) sort.value = 'recordings';
  document.querySelectorAll<HTMLElement>('.smell-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.smellFilter === 'all');
  });
  void renderSmellGallery();
}

function renderDiscoveryStrip(): void {
  const strip = document.getElementById('discoveryStrip');
  if (!strip) return;
  // Suggestions are for browsing the whole library. Once someone searches or
  // filters, the results are the interface; don't compete with them.
  if (smellQuery.trim() || smellFilter !== 'all' || smellCards.length < 2) {
    strip.hidden = true;
    strip.innerHTML = '';
    return;
  }
  strip.hidden = false;
  const pair = defaultCheckPair();
  const a = pair ? smellCards.find(c => c.key === pair.ref) : null;
  const b = pair ? smellCards.find(c => c.key === pair.sample) : null;
  const most = [...smellCards].sort((x, y) =>
    y.records.length - x.records.length || x.substance.localeCompare(y.substance))[0];
  const pool = smellCards.filter(c => c.key !== most?.key);
  const random = pool.length ? pool[Math.floor(Math.random() * pool.length)] : most;
  const pairLabel = a && b
    ? `Can the array tell <b>${escapeHtmlText(titleCase(a.substance))}</b> from <b>${escapeHtmlText(titleCase(b.substance))}</b>? →`
    : 'Pick two smells to check →';
  strip.innerHTML = `
    <span class="discovery-label">Start here</span>
    <button class="discovery-btn" type="button" data-discovery="check" ${a && b ? '' : 'disabled'}>${pairLabel}</button>
    <button class="discovery-btn" type="button" data-discovery="smell"><b>Meet ${escapeHtmlText(titleCase(most.substance))}</b> · ${most.records.length} recording${most.records.length === 1 ? '' : 's'} →</button>
    <button class="discovery-btn" type="button" data-discovery="random"><b>Surprise me</b> →</button>`;
  strip.querySelector<HTMLElement>('[data-discovery="check"]')?.addEventListener('click', () => {
    if (!a || !b) return;
    checkPrefill = { ref: a.key, sample: b.key };
    document.querySelector<HTMLElement>('.src-subnav-btn[data-src="check"]')?.click();
  });
  strip.querySelector<HTMLElement>('[data-discovery="smell"]')?.addEventListener('click', () => {
    openSmellDetail(most);
  });
  strip.querySelector<HTMLElement>('[data-discovery="random"]')?.addEventListener('click', () => {
    if (random) openSmellDetail(random);
  });
}

async function renderSmellGallery(): Promise<void> {
  const grid = document.getElementById('smellsGrid');
  if (!grid) return;
  buildSmellCards();
  const visible = visibleSmellCards();
  const stamp = document.getElementById('smellResultStampTop') || document.getElementById('smellResultStamp');
  if (stamp) stamp.textContent = `${visible.length} smell${visible.length === 1 ? '' : 's'}`;

  if (!visible.length) {
    grid.innerHTML = `<div class="smells-empty">
      <b>No smells match that.</b>
      Try a shorter search, or clear the filters to see the whole library.
      <div style="margin-top:10px"><button class="mini-btn" id="smellClearFilters" type="button">Clear search and filters</button></div>
    </div>`;
    document.getElementById('smellClearFilters')?.addEventListener('click', resetSmellFilters);
    updateSmellSelection();
    void renderSmellSeparation();
    return;
  }

  grid.innerHTML = visible.map((c, i) => {
    const prep = smellPreparationLabel(c);
    return `
    <div class="smell-card${smellSel.has(c.key) ? ' selected' : ''}" data-idx="${i}" role="button" tabindex="0">
      <button class="smell-card-save" data-idx="${i}" title="Save a shareable Smell Card (PNG)">&#8595;</button>
      <span class="smell-card-name">${titleCase(c.substance)}</span>
      <canvas class="smell-card-print" data-idx="${i}" title="Fingerprint — mean settled response across the array"></canvas>
      <span class="smell-card-meta" data-idx="${i}">${c.records.length} recording${c.records.length === 1 ? '' : 's'}${prep ? ` · ${prep}` : ''}</span>
      <span class="smell-card-foot">
        <input type="checkbox" class="smell-card-pick" data-idx="${i}" ${smellSel.has(c.key) ? 'checked' : ''}>
        <span class="smell-card-pick-label">compare</span>
      </span>
    </div>`;
  }).join('');
  grid.querySelectorAll<HTMLElement>('.smell-card').forEach(el => {
    el.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      if (t.classList.contains('smell-card-pick') || t.classList.contains('smell-card-save')) return;
      const c = visible[parseInt((el as HTMLElement).dataset.idx || '-1', 10)];
      if (!c) return;
      openSmellDetail(c);
    });
    el.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const t = ev.target as HTMLElement;
      if (t.classList.contains('smell-card-pick') || t.classList.contains('smell-card-save')) return;
      ev.preventDefault();
      const c = visible[parseInt((el as HTMLElement).dataset.idx || '-1', 10)];
      if (c) openSmellDetail(c);
    });
  });
  grid.querySelectorAll('.smell-card-save').forEach(el => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const c = visible[parseInt((el as HTMLElement).dataset.idx || '-1', 10)];
      if (c) void exportSmellCard(c);
    });
  });
  grid.querySelectorAll('.smell-card-pick').forEach(el => {
    el.addEventListener('change', (ev) => {
      const box = ev.target as HTMLInputElement;
      const c = visible[parseInt(box.dataset.idx || '-1', 10)];
      if (!c) return;
      if (box.checked) smellSel.add(c.key); else smellSel.delete(c.key);
      void renderSmellGallery();
    });
  });
  updateSmellSelection();
  void renderSmellSeparation();
  // Fill fingerprints lazily so the grid paints immediately.
  for (let i = 0; i < visible.length; i++) {
    const c = visible[i];
    const canvas = grid.querySelector<HTMLCanvasElement>(`.smell-card-print[data-idx="${i}"]`);
    if (!canvas) continue;
    void (async () => {
      const fp = await ensureMean(c);
      if (fp) {
        const meta = grid.querySelector<HTMLElement>(`.smell-card-meta[data-idx="${i}"]`);
        if (meta) {
          const prep = smellPreparationLabel(c);
          const prepSuffix = prep ? ` · ${prep}` : '';
          if (fp.groupSize < c.records.length) {
            meta.textContent = `${fp.groupSize} of ${c.records.length} on this array · mean of ${fp.used}${prepSuffix}`;
            meta.title = `${c.records.length - fp.groupSize} recording${c.records.length - fp.groupSize === 1 ? '' : 's'} use a different array and are not blended into this fingerprint.${prep ? ` Preparations: ${prep}.` : ''}`;
          } else {
            meta.textContent = `${fp.groupSize} recording${fp.groupSize === 1 ? '' : 's'} · mean of ${fp.used}${prepSuffix}`;
            if (prep) meta.title = `Preparations: ${prep}.`;
          }
        }
        drawCardFingerprint(canvas, fp.values, fp.channels);
      }
    })();
  }
}

// === Check — the core question, as a first-class object ===
// A Check is not a chart. It is a decision: on this array, can these two smells
// be told apart? It shows both fingerprints, a signed difference fingerprint,
// and the same replicate-based verdict the gallery advisor uses. No model is
// trained, no array is blended, and a saved check is a snapshot that can be
// reopened and recomputed.

interface DifferenceOpts {
  labels?: boolean;
  compact?: boolean;
  clear?: boolean;
}

/** A signed radial difference: zero is a ring, not the centre. Positive values
 *  (sample higher) grow outward in teal; negative values cut inward in amber.
 *  A channel with no signal is a hollow dot on the zero ring. */
function drawDifferenceInto(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  diffs: number[], channels: string[], opts: DifferenceOpts = {},
): void {
  if (w <= 0 || h <= 0) return;
  const labels = !!opts.labels;
  const compact = !!opts.compact;
  const n = Math.max(diffs.length, channels.length, 1);
  const pad = labels ? (compact ? 22 : 46) : 10;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const r = Math.max(10, Math.min(w, h) / 2 - pad);
  const zeroR = r * 0.34;
  const finite = diffs.filter(Number.isFinite);
  const maxPos = Math.max(1e-9, ...finite.filter(v => v > 0));
  const maxNeg = Math.max(1e-9, ...finite.filter(v => v < 0).map(v => -v));

  ctx.save();
  if (opts.clear !== false) ctx.clearRect(x, y, w, h);

  // Rings, with the zero ring emphasised. The centre is the negative extreme,
  // so a decrease is visible as a cut inward rather than a smaller "increase".
  for (let ring = 1; ring <= 4; ring++) {
    ctx.strokeStyle = ring === 4 ? 'rgba(29,26,22,0.14)' : 'rgba(29,26,22,0.065)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, (ring / 4) * r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(29,26,22,0.32)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.arc(cx, cy, zeroR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    ctx.strokeStyle = 'rgba(29,26,22,0.075)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.stroke();
  }

  const half = Math.max(0.035, (Math.PI * 2 / n) * 0.28);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const v = diffs[i];
    if (!Number.isFinite(v)) {
      const px = cx + Math.cos(a) * zeroR;
      const py = cy + Math.sin(a) * zeroR;
      ctx.beginPath();
      ctx.arc(px, py, compact ? 2 : 2.8, 0, Math.PI * 2);
      ctx.strokeStyle = '#a99e8b';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      const mag = v >= 0 ? Math.min(1, v / maxPos) : Math.min(1, -v / maxNeg);
      const rr = v >= 0 ? zeroR + (r - zeroR) * mag : zeroR * (1 - mag);
      ctx.beginPath();
      ctx.arc(cx, cy, zeroR, a - half, a + half);
      if (rr > 0.5) ctx.arc(cx, cy, rr, a + half, a - half, true);
      else ctx.lineTo(cx, cy);
      ctx.closePath();
      ctx.fillStyle = v >= 0 ? 'rgba(14,116,144,0.18)' : 'rgba(180,83,9,0.18)';
      ctx.fill();
      ctx.strokeStyle = v >= 0 ? 'rgba(14,116,144,0.55)' : 'rgba(180,83,9,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr;
      ctx.beginPath();
      ctx.arc(px, py, compact ? 2.2 : 3, 0, Math.PI * 2);
      ctx.fillStyle = v >= 0 ? '#0f6f86' : '#b45309';
      ctx.fill();
    }

    if (labels) {
      const lx = cx + Math.cos(a) * (r + (compact ? 10 : 16));
      const ly = cy + Math.sin(a) * (r + (compact ? 10 : 16));
      ctx.fillStyle = Number.isFinite(v) ? '#5f564a' : '#a99e8b';
      ctx.font = `500 ${compact ? 8 : 9}px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.textAlign = Math.cos(a) > 0.25 ? 'left' : Math.cos(a) < -0.25 ? 'right' : 'center';
      ctx.textBaseline = Math.sin(a) > 0.25 ? 'top' : Math.sin(a) < -0.25 ? 'bottom' : 'middle';
      const label = (channels[i] || `CH${i + 1}`).slice(0, 11);
      ctx.fillText(Number.isFinite(v) ? label : `${label} n/a`, lx, ly);
    }
  }

  if (!compact && labels) {
    ctx.fillStyle = '#a99e8b';
    ctx.font = '500 8px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('0', cx, cy - zeroR - 2);
  }
  ctx.restore();
}

function drawCheckFingerprint(canvas: HTMLCanvasElement | null, values: number[], channels: string[]): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(160, canvas.clientWidth || 240);
  const h = Math.max(120, canvas.clientHeight || 196);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  drawFingerprintInto(ctx, 0, 0, w, h, values, channels, { labels: true, compact: true });
}

function drawCheckDifference(canvas: HTMLCanvasElement | null, diffs: number[], channels: string[]): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(160, canvas.clientWidth || 280);
  const h = Math.max(180, canvas.clientHeight || 280);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  drawDifferenceInto(ctx, 0, 0, w, h, diffs, channels, { labels: true });
}

function drawCheckDifferenceMessage(canvas: HTMLCanvasElement | null, message: string): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(160, canvas.clientWidth || 280);
  const h = Math.max(120, canvas.clientHeight || 260);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = cssToken('--text-3');
  ctx.font = '500 11px "Geist", "Inter", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = message.split('\n');
  lines.forEach((line, i) => ctx.fillText(line, w / 2, h / 2 + (i - (lines.length - 1) / 2) * 16));
}

function sameChannelSignature(a: string[], b: string[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((ch, i) => ch === b[i]);
}

function formatPermP(p: number): string {
  if (!Number.isFinite(p)) return 'p n/a';
  return p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3)}`;
}

function escapeHtmlText(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] || c));
}

interface SavedCheck {
  id: string;
  name: string;
  ref: string;
  sample: string;
  verdict: SeparationVerdict;
  acc: number;
  nEval: number;
  pValue: number;
  savedAt: number;
  array: string;
  nA: number;
  nB: number;
}

interface CheckCurrent {
  a: SmellCardData;
  b: SmellCardData;
  fa: MeanResponse | null;
  fb: MeanResponse | null;
  pair: SmellPairSeparation | null;
  diffs: number[];
  diffChannels: string[];
  sameArray: boolean;
}

const CHECK_STORAGE_KEY = 'osmograph.checks.v1';
let checkCurrent: CheckCurrent | null = null;
let checkToken = 0;
let checkPrefill: { ref?: string; sample?: string } | null = null;

function loadSavedChecks(): SavedCheck[] {
  try {
    const raw = localStorage.getItem(CHECK_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row): row is SavedCheck => {
      if (!row || typeof row !== 'object') return false;
      const o = row as Record<string, unknown>;
      const v = o.verdict;
      return typeof o.id === 'string'
        && typeof o.name === 'string'
        && typeof o.ref === 'string'
        && typeof o.sample === 'string'
        && (v === 'separable' || v === 'fragile' || v === 'confusable' || v === 'insufficient');
    }).slice(0, 60);
  } catch {
    return [];
  }
}

function persistSavedChecks(checks: SavedCheck[]): void {
  try {
    localStorage.setItem(CHECK_STORAGE_KEY, JSON.stringify(checks.slice(0, 60)));
  } catch {
    showToast('Could not save the check on this machine.');
  }
}

function defaultCheckPair(): { ref: string; sample: string } | null {
  if (smellSel.size >= 2) {
    const keys = [...smellSel];
    return { ref: keys[0], sample: keys[1] };
  }
  const candidates = smellCards.filter(c => c.records.filter(r => !!r.file_id).length >= 2);
  let bestA: SmellCardData | null = null;
  let bestB: SmellCardData | null = null;
  let bestScore = -1;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const wa = candidates[i].records.find(r => !!r.file_id)?.sensors || 0;
      const wb = candidates[j].records.find(r => !!r.file_id)?.sensors || 0;
      if (!wa || wa !== wb) continue;
      const score = Math.min(candidates[i].records.length, candidates[j].records.length);
      if (score > bestScore) {
        bestScore = score;
        bestA = candidates[i];
        bestB = candidates[j];
      }
    }
  }
  if (!bestA || !bestB) {
    const top = candidates.slice(0, 2);
    if (top.length === 2) { bestA = top[0]; bestB = top[1]; }
  }
  return bestA && bestB ? { ref: bestA.key, sample: bestB.key } : null;
}

function populateCheckSelectors(prefill?: { ref?: string; sample?: string }): void {
  const refSel = document.getElementById('checkRef') as HTMLSelectElement | null;
  const sampleSel = document.getElementById('checkSample') as HTMLSelectElement | null;
  if (!refSel || !sampleSel) return;
  const prevRef = prefill?.ref ?? refSel.value;
  const prevSample = prefill?.sample ?? sampleSel.value;
  if (!smellCards.length) {
    refSel.innerHTML = '<option value="">No smells yet</option>';
    sampleSel.innerHTML = '<option value="">No smells yet</option>';
    return;
  }
  const makeOptions = () => smellCards.map(c => {
    const usable = c.records.filter(r => !!r.file_id).length;
    return new Option(`${titleCase(c.substance)} · ${usable} recording${usable === 1 ? '' : 's'}`, c.key);
  });
  refSel.replaceChildren(...makeOptions());
  sampleSel.replaceChildren(...makeOptions());
  if (prevRef && smellCards.some(c => c.key === prevRef)) refSel.value = prevRef;
  if (prevSample && smellCards.some(c => c.key === prevSample)) sampleSel.value = prevSample;
  if (!refSel.value) refSel.value = smellCards[0].key;
  if (!sampleSel.value) sampleSel.value = smellCards.find(c => c.key !== refSel.value)?.key || refSel.value;
}

function checkDecisionHtml(pair: SmellPairSeparation): string {
  const stat = Number.isFinite(pair.acc) && pair.nEval > 0
    ? ` ${Math.round(pair.acc * pair.nEval)}/${pair.nEval} left-out recordings still land with their own smell.`
    : '';
  switch (pair.verdict) {
    case 'separable':
      return `<b>Yes.</b> On this array, the two smells are distinguishable from saved replicates.${stat}`;
    case 'fragile':
      return `<b>Not yet.</b> Some replicates separate, but the 95% lower bound is below the bar; add comparable replicates before trusting this on a new session.${stat}`;
    case 'confusable':
      return `<b>No.</b> This array cannot reliably tell these two smells apart from saved replicates.${stat}`;
    default:
      return `<b>Not enough evidence.</b> Add comparable replicates on the same array before treating this pair as separable.${stat}`;
  }
}

function checkPickMeta(card: SmellCardData, fp: MeanResponse | null): string {
  if (!fp) {
    return `${card.records.length} recording${card.records.length === 1 ? '' : 's'} · no shared channel series`;
  }
  const other = fp.total - fp.groupSize;
  const bits = [
    `${fp.groupSize} on this array`,
    `mean of ${fp.used}`,
    `${fp.channels.length}-channel`,
    sourceForRecords(fp.records),
  ];
  if (other > 0) bits.push(`${other} on another array`);
  return bits.join(' · ');
}

async function runCheck(): Promise<void> {
  const refSel = document.getElementById('checkRef') as HTMLSelectElement | null;
  const sampleSel = document.getElementById('checkSample') as HTMLSelectElement | null;
  const result = document.getElementById('checkResult');
  const stamp = document.getElementById('checkStamp');
  const refPrint = document.getElementById('checkRefPrint') as HTMLCanvasElement | null;
  const samplePrint = document.getElementById('checkSamplePrint') as HTMLCanvasElement | null;
  const diffPrint = document.getElementById('checkDiffPrint') as HTMLCanvasElement | null;
  const diffTag = document.getElementById('checkDiffTag');
  if (!refSel || !sampleSel || !result || !stamp) return;

  const a = smellCards.find(c => c.key === refSel.value);
  const b = smellCards.find(c => c.key === sampleSel.value);
  if (!a || !b) {
    result.innerHTML = '<div class="check-empty"><b>No smells to compare.</b> Download a corpus from Explore → Datasets or import a recording.</div>';
    stamp.textContent = 'no smells';
    return;
  }
  if (a.key === b.key) {
    result.innerHTML = '<div class="check-empty"><b>Pick two different smells.</b> A check compares a reference with a sample, not a smell with itself.</div>';
    stamp.textContent = 'same smell';
    return;
  }

  const token = ++checkToken;
  checkCurrent = null;
  stamp.textContent = 'reading replicates…';
  result.innerHTML = '<div class="check-empty">Reading saved replicates on both smells…</div>';
  drawCheckDifferenceMessage(refPrint, 'Reading…');
  drawCheckDifferenceMessage(samplePrint, 'Reading…');
  drawCheckDifferenceMessage(diffPrint, 'Reading replicates…');
  if (diffTag) diffTag.textContent = 'reference → sample';
  const refMeta = document.getElementById('checkRefMeta');
  const sampleMeta = document.getElementById('checkSampleMeta');
  if (refMeta) refMeta.textContent = 'Reading…';
  if (sampleMeta) sampleMeta.textContent = 'Reading…';

  try {
    const [ra, rb, fa, fb] = await Promise.all([
      smellReplicates(a), smellReplicates(b), ensureMean(a), ensureMean(b),
    ]);
    if (token !== checkToken) return;

    if (fa) drawCheckFingerprint(refPrint, fa.values, fa.channels);
    else drawCheckDifferenceMessage(refPrint, 'No usable\nfingerprint');
    if (fb) drawCheckFingerprint(samplePrint, fb.values, fb.channels);
    else drawCheckDifferenceMessage(samplePrint, 'No usable\nfingerprint');
    if (refMeta) refMeta.textContent = checkPickMeta(a, fa);
    if (sampleMeta) sampleMeta.textContent = checkPickMeta(b, fb);

    const sameArray = !!ra && !!rb && sameChannelSignature(ra.channels, rb.channels);
    let pair: SmellPairSeparation | null = null;
    if (sameArray && ra && rb) pair = makeSeparationPair(a, b, ra, rb);

    let diffs: number[] = [];
    let diffChannels: string[] = [];
    const fpSame = !!fa && !!fb && sameChannelSignature(fa.channels, fb.channels);
    if (fpSame && fa && fb) {
      diffChannels = fa.channels.slice();
      diffs = fa.values.map((v, i) => fb.values[i] - v);
      drawCheckDifference(diffPrint, diffs, diffChannels);
      const max = Math.max(0, ...diffs.filter(Number.isFinite).map(v => Math.abs(v)));
      if (diffTag) diffTag.textContent = `reference → sample · max |Δ| ${(max * 100).toFixed(0)}%`;
    } else if (!sameArray) {
      drawCheckDifferenceMessage(diffPrint, 'Different arrays\nNo channel-for-channel\ndifference');
      if (diffTag) diffTag.textContent = 'different arrays';
    } else {
      drawCheckDifferenceMessage(diffPrint, 'No comparable\nfingerprint series');
      if (diffTag) diffTag.textContent = 'no fingerprint';
    }

    checkCurrent = { a, b, fa, fb, pair, diffs, diffChannels, sameArray };

    if (!sameArray) {
      const aCh = ra?.channels.length ? ra.channels.join(' · ') : 'no usable series';
      const bCh = rb?.channels.length ? rb.channels.join(' · ') : 'no usable series';
      stamp.textContent = 'incomparable arrays';
      result.innerHTML = `<div class="check-empty">
        <b>No channel-for-channel comparison.</b><br>
        ${escapeHtmlText(titleCase(a.substance))} uses ${escapeHtmlText(aCh)}.<br>
        ${escapeHtmlText(titleCase(b.substance))} uses ${escapeHtmlText(bCh)}.<br>
        A verdict needs the same channels in the same order. Re-record one smell on the other's array; the app will not blend arrays to manufacture a difference.
      </div>`;
      return;
    }

    if (!pair) {
      stamp.textContent = 'needs replicates';
      result.innerHTML = `<div class="check-empty"><b>No usable replicates.</b> Both smells need at least one recording with a channel series on this array. ${escapeHtmlText(titleCase(a.substance))} has ${ra?.rows.length ?? 0}, ${escapeHtmlText(titleCase(b.substance))} has ${rb?.rows.length ?? 0}.</div>`;
      return;
    }

    stamp.textContent = `${SEP_VERDICT_LABEL[pair.verdict]} · ${pair.nA} vs ${pair.nB}`;
    result.innerHTML = `
      <div class="check-verdict">
        <span class="sep-badge ${pair.verdict}">${SEP_VERDICT_LABEL[pair.verdict]}</span>
        <span class="coord-tag">${pair.nA} vs ${pair.nB} recordings</span>
      </div>
      <p class="check-decision">${checkDecisionHtml(pair)}</p>
      ${sepPairHtml(pair)}
      <div class="check-actions">
        <button class="mini-btn primary" type="button" data-check-action="save">Save check</button>
        <button class="mini-btn" type="button" data-check-action="card">Save card</button>
        <button class="mini-btn" type="button" data-check-action="copy">Copy summary</button>
      </div>`;
  } catch (err) {
    if (token !== checkToken) return;
    console.error('Check failed:', err);
    stamp.textContent = 'check failed';
    result.innerHTML = '<div class="check-empty"><b>Could not read these replicates.</b> Try refreshing the library, then run the check again.</div>';
  }
}

function renderCheckSaved(): void {
  const list = document.getElementById('checkSavedList');
  const count = document.getElementById('checkSavedCount');
  if (!list) return;
  const checks = loadSavedChecks();
  if (count) count.textContent = String(checks.length);
  if (!checks.length) {
    list.innerHTML = '<div class="check-empty" style="font-size:11px">No saved checks yet. Run one above and save it.</div>';
    return;
  }
  list.innerHTML = checks.map(ch => {
    const lower = Number.isFinite(ch.acc) && ch.nEval > 0
      ? wilsonLower(Math.round(ch.acc * ch.nEval), ch.nEval)
      : NaN;
    const correct = Number.isFinite(ch.acc) && ch.nEval > 0
      ? `${Math.round(ch.acc * ch.nEval)}/${ch.nEval}`
      : 'n/a';
    const meta = [
      SEP_VERDICT_LABEL[ch.verdict] || ch.verdict,
      correct,
      Number.isFinite(lower) ? `95% lower ${Math.round(lower * 100)}%` : '',
      `${ch.nA} vs ${ch.nB}`,
      new Date(ch.savedAt).toLocaleDateString(),
    ].filter(Boolean).join(' · ');
    return `<div class="check-saved-item">
      <button class="check-saved-main" type="button" data-check-open="${escapeHtmlText(ch.id)}" title="${escapeHtmlText(ch.array)}">
        <span class="check-saved-name">${escapeHtmlText(ch.name)}</span>
        <span class="check-saved-meta">${escapeHtmlText(meta)}</span>
      </button>
      <button class="check-saved-del" type="button" data-check-del="${escapeHtmlText(ch.id)}" title="Delete saved check">×</button>
    </div>`;
  }).join('');
}

function openSaveCheckDialog(): void {
  const c = checkCurrent;
  if (!c || !c.pair) {
    showToast('Run a pair before saving it.');
    return;
  }
  const modal = document.getElementById('checkSaveModal');
  const input = document.getElementById('checkSaveName') as HTMLInputElement | null;
  const err = document.getElementById('checkSaveError');
  if (!modal || !input) return;
  input.value = `${titleCase(c.a.substance)} ↔ ${titleCase(c.b.substance)}`;
  if (err) err.style.display = 'none';
  modal.style.display = 'flex';
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function closeSaveCheckDialog(): void {
  const modal = document.getElementById('checkSaveModal');
  if (modal) modal.style.display = 'none';
}

function commitCurrentCheck(name: string): void {
  const c = checkCurrent;
  if (!c || !c.pair) {
    closeSaveCheckDialog();
    return;
  }
  const trimmed = name.trim().slice(0, 80);
  const input = document.getElementById('checkSaveName') as HTMLInputElement | null;
  const err = document.getElementById('checkSaveError');
  if (!trimmed) {
    if (err) err.style.display = '';
    input?.focus();
    return;
  }
  const checks = loadSavedChecks();
  checks.unshift({
    id: `chk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: trimmed,
    ref: c.a.key,
    sample: c.b.key,
    verdict: c.pair.verdict,
    acc: c.pair.acc,
    nEval: c.pair.nEval,
    pValue: c.pair.pValue,
    savedAt: Date.now(),
    array: c.pair.channels.map(ch => ch.channel).join(' · '),
    nA: c.pair.nA,
    nB: c.pair.nB,
  });
  persistSavedChecks(checks);
  closeSaveCheckDialog();
  renderCheckSaved();
  showToast('Separability result saved.');
}

function openSavedCheck(id: string): void {
  const saved = loadSavedChecks().find(ch => ch.id === id);
  if (!saved) return;
  if (!smellCards.some(c => c.key === saved.ref) || !smellCards.some(c => c.key === saved.sample)) {
    showToast('One of the smells in this check is no longer in the library.');
    return;
  }
  const refSel = document.getElementById('checkRef') as HTMLSelectElement | null;
  const sampleSel = document.getElementById('checkSample') as HTMLSelectElement | null;
  if (!refSel || !sampleSel) return;
  refSel.value = saved.ref;
  sampleSel.value = saved.sample;
  void runCheck();
}

let checkDeleteArm: { id: string; timer: number; button: HTMLButtonElement } | null = null;

function armOrDeleteSavedCheck(id: string, button: HTMLButtonElement): void {
  // Two-step delete instead of a native confirm dialog: the first click arms
  // the control, the second within 2.5s deletes. No unstyled OS prompt.
  if (checkDeleteArm?.id === id) {
    window.clearTimeout(checkDeleteArm.timer);
    checkDeleteArm = null;
    persistSavedChecks(loadSavedChecks().filter(ch => ch.id !== id));
    renderCheckSaved();
    showToast('Saved check deleted.');
    return;
  }
  if (checkDeleteArm) {
    window.clearTimeout(checkDeleteArm.timer);
    checkDeleteArm.button.textContent = '×';
    checkDeleteArm.button.title = 'Delete saved check';
  }
  button.textContent = '×?';
  button.title = 'Click again to delete';
  const timer = window.setTimeout(() => {
    if (checkDeleteArm?.id === id) {
      checkDeleteArm = null;
      button.textContent = '×';
      button.title = 'Delete saved check';
    }
  }, 2500);
  checkDeleteArm = { id, timer, button };
}

async function copyCurrentCheck(): Promise<void> {
  const c = checkCurrent;
  if (!c || !c.pair) {
    showToast('Run a pair first.');
    return;
  }
  const p = c.pair;
  const lower = Number.isFinite(p.acc) && p.nEval > 0
    ? wilsonLower(Math.round(p.acc * p.nEval), p.nEval)
    : NaN;
  const carried = p.channels
    .filter(ch => Number.isFinite(ch.d) && !(ch.silentA && ch.silentB))
    .sort((x, y) => y.d - x.d)
    .slice(0, 3)
    .map(ch => `${ch.channel} ${ch.feature || 'response'} ${ch.d.toFixed(1)}σ`);
  const lines = [
    `Osmograph check — ${titleCase(c.a.substance)} ↔ ${titleCase(c.b.substance)}`,
    `Verdict: ${SEP_VERDICT_LABEL[p.verdict]}`,
    Number.isFinite(p.acc) && p.nEval > 0
      ? `${Math.round(p.acc * p.nEval)}/${p.nEval} left-out recordings match their own smell`
      : 'Not enough replicates for a left-out score',
    Number.isFinite(lower) ? `95% lower bound: ${Math.round(lower * 100)}%` : '',
    formatPermP(p.pValue),
    `Replicates on this array: ${p.nA} vs ${p.nB}`,
    `Array: ${p.channels.map(ch => ch.channel).join(', ')}`,
    carried.length ? `Carried by: ${carried.join(' · ')}` : '',
    p.lever,
    'Preview from saved replicates, before training. Not a chemical identification. Different arrays are never blended.',
  ].filter(Boolean);
  const ok = await copyText(lines.join('\n'));
  showToast(ok ? 'Separability summary copied.' : 'Copy failed.');
}

function wrapCanvasText(
  ctx: CanvasRenderingContext2D, text: string, x: number, y: number,
  maxWidth: number, lineHeight: number, maxLines = 4,
): number {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown[maxLines - 1] = `${shown[maxLines - 1]}…`;
  shown.forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
  return y + shown.length * lineHeight;
}

function drawCheckCardCanvas(c: CheckCurrent): HTMLCanvasElement | null {
  if (!c.pair) return null;
  const W = 1000, H = 760, dpr = 2;
  const canvas = document.createElement('canvas');
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  const sans = '"Geist", "Inter", system-ui, sans-serif';
  const mono = 'ui-monospace, "SF Mono", Menlo, monospace';
  const p = c.pair;

  ctx.fillStyle = '#f8f4ea';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#e4dac6';
  ctx.lineWidth = 2;
  ctx.strokeRect(14, 14, W - 28, H - 28);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#8a7f6c';
  ctx.font = `600 12px ${mono}`;
  ctx.fillText('O S M O G R A P H', 44, 52);
  ctx.textAlign = 'right';
  ctx.fillText('CHECK CARD', W - 44, 52);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#1d1a16';
  ctx.font = `600 36px ${sans}`;
  ctx.fillText(`${titleCase(c.a.substance)}  ↔  ${titleCase(c.b.substance)}`, 44, 102);

  const lower = Number.isFinite(p.acc) && p.nEval > 0
    ? wilsonLower(Math.round(p.acc * p.nEval), p.nEval)
    : NaN;
  const meta = [
    SEP_VERDICT_LABEL[p.verdict],
    Number.isFinite(p.acc) && p.nEval > 0 ? `${Math.round(p.acc * p.nEval)}/${p.nEval} left-out correct` : 'no left-out score',
    Number.isFinite(lower) ? `95% lower ${Math.round(lower * 100)}%` : '',
    formatPermP(p.pValue),
    `${p.nA} vs ${p.nB} recordings`,
  ].filter(Boolean).join('   ·   ');
  ctx.fillStyle = '#6b6152';
  ctx.font = `400 14px ${sans}`;
  ctx.fillText(meta, 44, 130);

  ctx.strokeStyle = '#e4dac6';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(44, 150);
  ctx.lineTo(W - 44, 150);
  ctx.stroke();

  // Two fingerprints, each on its own array. They are never blended into a
  // single pseudo-fingerprint.
  ctx.fillStyle = '#1d1a16';
  ctx.font = `600 12px ${mono}`;
  ctx.textAlign = 'left';
  ctx.fillText('REFERENCE', 44, 182);
  ctx.fillStyle = '#6b6152';
  ctx.font = `400 12px ${sans}`;
  ctx.fillText(titleCase(c.a.substance), 130, 182);
  ctx.fillStyle = '#1d1a16';
  ctx.font = `600 12px ${mono}`;
  ctx.fillText('SAMPLE', 520, 182);
  ctx.fillStyle = '#6b6152';
  ctx.font = `400 12px ${sans}`;
  ctx.fillText(titleCase(c.b.substance), 584, 182);

  if (c.fa) drawFingerprintInto(ctx, 44, 192, 430, 210, c.fa.values, c.fa.channels, { labels: true, clear: false });
  else {
    ctx.fillStyle = '#a99e8b';
    ctx.font = `400 12px ${sans}`;
    ctx.textAlign = 'center';
    ctx.fillText('No usable fingerprint', 259, 300);
  }
  if (c.fb) drawFingerprintInto(ctx, 520, 192, 430, 210, c.fb.values, c.fb.channels, { labels: true, clear: false });
  else {
    ctx.fillStyle = '#a99e8b';
    ctx.font = `400 12px ${sans}`;
    ctx.textAlign = 'center';
    ctx.fillText('No usable fingerprint', 735, 300);
  }

  ctx.strokeStyle = '#e4dac6';
  ctx.beginPath();
  ctx.moveTo(44, 418);
  ctx.lineTo(W - 44, 418);
  ctx.stroke();

  // Signed difference fingerprint: the part a person cannot see by comparing
  // two radars by eye.
  ctx.textAlign = 'left';
  ctx.fillStyle = '#1d1a16';
  ctx.font = `600 12px ${mono}`;
  ctx.fillText('DIFFERENCE FINGERPRINT', 44, 448);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#8a7f6c';
  ctx.font = `400 10px ${sans}`;
  ctx.fillText('sample − reference · one shared scale', 44, 463);
  if (c.sameArray && c.diffs.length) {
    drawDifferenceInto(ctx, 44, 470, 420, 206, c.diffs, c.diffChannels, { labels: true, compact: true, clear: false });
    ctx.textAlign = 'left';
    ctx.fillStyle = '#8a7f6c';
    ctx.font = `400 10px ${sans}`;
    ctx.fillText('● sample higher    ● sample lower    ○ no signal', 44, 690);
  } else {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#a99e8b';
    ctx.font = `400 12px ${sans}`;
    ctx.fillText('Different arrays — no difference fingerprint.', 254, 560);
  }

  // Verdict panel — the decision, not just a score.
  const badgeFill = p.verdict === 'separable' ? cssToken('--text-0')
    : p.verdict === 'fragile' ? '#f6e3bc'
      : p.verdict === 'confusable' ? cssToken('--red') : '#e7dfd0';
  const badgeText = p.verdict === 'separable' ? cssToken('--bg-0')
    : p.verdict === 'fragile' ? '#7a5208'
      : p.verdict === 'confusable' ? '#fff' : '#5a5750';
  ctx.fillStyle = badgeFill;
  const badgeLabel = SEP_VERDICT_LABEL[p.verdict].toUpperCase();
  ctx.font = `600 11px ${mono}`;
  const bw = ctx.measureText(badgeLabel).width + 20;
  ctx.fillRect(520, 460, bw, 22);
  ctx.fillStyle = badgeText;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(badgeLabel, 530, 471);

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#1d1a16';
  ctx.font = `600 21px ${sans}`;
  const decision = p.verdict === 'separable'
    ? 'Yes. These are distinguishable on this array.'
    : p.verdict === 'fragile'
      ? 'Not yet. The gap is too thin to trust.'
      : p.verdict === 'confusable'
        ? 'No. This array cannot tell them apart.'
        : 'Not enough replicates to answer.';
  wrapCanvasText(ctx, decision, 520, 510, 430, 27, 3);

  ctx.fillStyle = '#3a342c';
  ctx.font = `500 12px ${sans}`;
  const statLines = [
    Number.isFinite(p.acc) && p.nEval > 0 ? `${Math.round(p.acc * p.nEval)}/${p.nEval} left-out recordings match their own smell` : 'No left-out score yet',
    Number.isFinite(lower) ? `95% lower bound: ${Math.round(lower * 100)}%` : 'Lower bound: n/a',
    formatPermP(p.pValue),
    `${p.channels.length}-channel array · ${p.nA} vs ${p.nB} replicates`,
  ];
  statLines.forEach((line, i) => ctx.fillText(line, 520, 590 + i * 19));

  const carried = p.channels
    .filter(ch => Number.isFinite(ch.d) && !(ch.silentA && ch.silentB))
    .sort((x, y) => y.d - x.d)
    .slice(0, 2)
    .map(ch => `${ch.channel} ${ch.d.toFixed(1)}σ`);
  ctx.fillStyle = '#6b6152';
  ctx.font = `400 11px ${sans}`;
  if (carried.length) ctx.fillText(`Carried by ${carried.join(' · ')}`, 520, 676);

  ctx.strokeStyle = '#e4dac6';
  ctx.beginPath();
  ctx.moveTo(44, 708);
  ctx.lineTo(W - 44, 708);
  ctx.stroke();
  ctx.fillStyle = '#8a7f6c';
  ctx.font = `400 10px ${mono}`;
  ctx.textAlign = 'left';
  ctx.fillText('Saved replicates · one array · not a chemical identification', 44, 732);
  ctx.textAlign = 'right';
  ctx.fillText('OSMOGRAPH', W - 44, 732);
  return canvas;
}

async function exportCurrentCheckCard(): Promise<void> {
  if (!checkCurrent?.pair) {
    showToast('Run a pair first.');
    return;
  }
  const canvas = drawCheckCardCanvas(checkCurrent);
  if (!canvas) return;
  const safe = `${checkCurrent.a.substance}-vs-${checkCurrent.b.substance}`
    .replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  await exportCanvasPng(canvas, `osmograph-check-${safe || 'pair'}.png`);
}

let checkMatrixToken = 0;
let checkMatrixClasses: SmellCardData[] = [];

/** A class-level view of the same replicate evidence. Pairwise checks answer
 *  “can the array tell these two apart?”; this answers “which classes are
 *  confusable before I train?”. It deliberately skips the permutation test
 *  (the pair bench below runs it) so a matrix of classes stays responsive. */
async function renderCheckMatrix(): Promise<void> {
  const section = document.getElementById('checkMatrixSection');
  const host = document.getElementById('checkMatrix');
  const stamp = document.getElementById('checkMatrixStamp');
  if (!section || !host || !stamp) return;
  const candidates = smellCards
    .filter(c => c.records.filter(r => !!r.file_id).length >= 2)
    .slice(0, 8);
  checkMatrixClasses = candidates;
  if (candidates.length < 2) {
    section.hidden = true;
    host.innerHTML = '';
    return;
  }
  section.hidden = false;
  const token = ++checkMatrixToken;
  stamp.textContent = 'reading replicates…';
  host.innerHTML = '<div class="hint" style="padding:4px 2px">Reading class pairs…</div>';
  const reps = await Promise.all(candidates.map(c => smellReplicates(c)));
  if (token !== checkMatrixToken) return;

  const pairs = new Map<string, SmellPairSeparation | null>();
  let separable = 0;
  let known = 0;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const ra = reps[i], rb = reps[j];
      const pair = ra && rb ? makeSeparationPair(candidates[i], candidates[j], ra, rb, false) : null;
      pairs.set(`${i}:${j}`, pair);
      if (pair) {
        known++;
        if (pair.verdict === 'separable') separable++;
      }
    }
  }

  const short = (s: string) => titleCase(s).length > 12 ? `${titleCase(s).slice(0, 11)}…` : titleCase(s);
  const cell = (i: number, j: number) => {
    if (i === j) return '<td><span class="sep-matrix-cell diag">·</span></td>';
    const key = i < j ? `${i}:${j}` : `${j}:${i}`;
    const pair = pairs.get(key) || null;
    const verdict = pair?.verdict || 'insufficient';
    const text = pair && Number.isFinite(pair.acc) && pair.nEval > 0
      ? `${Math.round(pair.acc * pair.nEval)}/${pair.nEval}`
      : '–';
    const title = pair
      ? `${titleCase(candidates[i].substance)} ↔ ${titleCase(candidates[j].substance)} · ${SEP_VERDICT_LABEL[pair.verdict]} · ${text} left-out recordings match their own smell`
      : `${titleCase(candidates[i].substance)} ↔ ${titleCase(candidates[j].substance)} · not enough comparable replicates`;
    return `<td><button class="sep-matrix-cell ${verdict}" type="button"
      data-check-pair-a="${esc(candidates[i].key)}" data-check-pair-b="${esc(candidates[j].key)}"
      title="${esc(title)}">${text}</button></td>`;
  };
  const head = `<tr><th></th>${candidates.map(c => `<th title="${esc(titleCase(c.substance))}">${esc(short(c.substance))}</th>`).join('')}</tr>`;
  const body = candidates.map((c, i) =>
    `<tr><th class="row" title="${esc(titleCase(c.substance))}">${esc(short(c.substance))}</th>${candidates.map((_, j) => cell(i, j)).join('')}</tr>`
  ).join('');
  host.innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
  stamp.textContent = `${candidates.length} classes · ${separable}/${known} pairs separable`;
  host.querySelectorAll<HTMLButtonElement>('[data-check-pair-a]').forEach(btn => {
    btn.addEventListener('click', () => {
      const refSel = document.getElementById('checkRef') as HTMLSelectElement | null;
      const sampleSel = document.getElementById('checkSample') as HTMLSelectElement | null;
      if (!refSel || !sampleSel) return;
      refSel.value = btn.dataset.checkPairA || '';
      sampleSel.value = btn.dataset.checkPairB || '';
      void runCheck();
      document.querySelector<HTMLElement>('.check-bench')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });
}

document.getElementById('checkMatrixTrain')?.addEventListener('click', () => {
  if (!checkMatrixClasses.length) return;
  const minQ = trainMinQualityValue();
  trainSelected.clear();
  for (const c of checkMatrixClasses) {
    c.records
      .filter(r => !!r.file_id && (!minQ || r.quality >= minQ * 100))
      .slice(0, 6)
      .forEach(r => trainSelected.add(r.file_id!));
  }
  showWorkspaceView('train');
  renderTrain();
});

async function renderCheckView(force = false): Promise<void> {
  if (force || !smellCards.length) buildSmellCards();
  populateCheckSelectors(checkPrefill || undefined);
  checkPrefill = null;
  renderCheckSaved();
  void renderCheckMatrix();

  const result = document.getElementById('checkResult');
  const stamp = document.getElementById('checkStamp');
  const refSel = document.getElementById('checkRef') as HTMLSelectElement | null;
  const sampleSel = document.getElementById('checkSample') as HTMLSelectElement | null;
  if (!smellCards.length) {
    if (stamp) stamp.textContent = 'no smells';
    if (result) {
      result.innerHTML = '<div class="check-empty"><b>No smells in the library yet.</b> Download a corpus from Explore → Datasets or import a recording, then come back.</div>';
    }
    drawCheckDifferenceMessage(document.getElementById('checkDiffPrint') as HTMLCanvasElement | null, 'No smells');
    return;
  }
  if (smellCards.length < 2) {
    if (stamp) stamp.textContent = 'needs a second smell';
    if (result) {
      result.innerHTML = '<div class="check-empty"><b>Separability needs two smells.</b> Record or import one more smell on the same array.</div>';
    }
    return;
  }
  if (!refSel || !sampleSel) return;
  if (!refSel.value) refSel.value = smellCards[0].key;
  if (!sampleSel.value || sampleSel.value === refSel.value) {
    sampleSel.value = smellCards.find(c => c.key !== refSel.value)?.key || refSel.value;
  }
  await runCheck();
}

document.getElementById('checkRun')?.addEventListener('click', () => { void runCheck(); });
document.getElementById('checkSwap')?.addEventListener('click', () => {
  const refSel = document.getElementById('checkRef') as HTMLSelectElement | null;
  const sampleSel = document.getElementById('checkSample') as HTMLSelectElement | null;
  if (!refSel || !sampleSel) return;
  const tmp = refSel.value;
  refSel.value = sampleSel.value;
  sampleSel.value = tmp;
  void runCheck();
});
document.getElementById('checkRef')?.addEventListener('change', () => { void runCheck(); });
document.getElementById('checkSample')?.addEventListener('change', () => { void runCheck(); });
document.getElementById('checkResult')?.addEventListener('click', (ev) => {
  const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-check-action]');
  if (!target) return;
  const action = target.dataset.checkAction;
  if (action === 'save') openSaveCheckDialog();
  else if (action === 'card') void exportCurrentCheckCard();
  else if (action === 'copy') void copyCurrentCheck();
});
document.getElementById('checkSavedList')?.addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement;
  const open = target.closest<HTMLElement>('[data-check-open]');
  if (open?.dataset.checkOpen) {
    openSavedCheck(open.dataset.checkOpen);
    return;
  }
  const del = target.closest<HTMLButtonElement>('[data-check-del]');
  if (del?.dataset.checkDel) armOrDeleteSavedCheck(del.dataset.checkDel, del);
});

let activeDomainPackId: string | null = null;

/** The Vial the user wants applied to the live Home view. Kept separate from
 *  the “currently open workspace” id so Fleet can choose a live Vial without
 *  pretending to open its editor. */
const HOME_VIAL_KEY = 'osmograph.homeVial.v1';
function selectedHomeVialId(): string | null {
  try { return localStorage.getItem(HOME_VIAL_KEY) || null; } catch { return null; }
}
function setSelectedHomeVialId(id: string): void {
  try {
    if (id) localStorage.setItem(HOME_VIAL_KEY, id);
    else localStorage.removeItem(HOME_VIAL_KEY);
  } catch { /* ignore */ }
  renderVialHome();
}
let activeDomainState: Domain.DomainState | null = null;
let activeDomainHotspot: string | null = null;
let domainRemoveArm: { id: string; timer: number; button: HTMLButtonElement } | null = null;
let domainPackDeleteArm: { id: string; timer: number; button: HTMLButtonElement } | null = null;

function domainArtSvg(art: Domain.DomainArt, hotspots: Array<{ id: string; label: string; x: number; y: number }> = []): string {
  const marks = hotspots.map(h => {
    const cx = (h.x / 100) * 320;
    const cy = (h.y / 100) * 240;
    return `<g class="domain-hotspot ${activeDomainHotspot === h.id ? 'active' : ''}" data-domain-hotspot="${escapeHtmlText(h.id)}">
      <title>${escapeHtmlText(h.label)}</title>
      <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" />
      <text x="${(cx + 8).toFixed(1)}" y="${(cy + 2.6).toFixed(1)}">${escapeHtmlText(h.label)}</text>
    </g>`;
  }).join('');

  if (art === 'generic') {
    return `<svg class="domain-art" viewBox="0 0 320 240" role="img" aria-label="Declarative domain pack diagram">
      <rect x="24" y="86" width="78" height="68" rx="6" class="domain-art-fill domain-art-line" />
      <text x="63" y="112" text-anchor="middle" class="domain-art-label">SAMPLE</text>
      <text x="63" y="128" text-anchor="middle" class="domain-art-label">+ context</text>
      <path d="M102 120 H126" class="domain-art-line" />
      <path d="M120 114 L128 120 L120 126" class="domain-art-line" />
      <circle cx="160" cy="120" r="34" class="domain-art-soft" />
      <circle cx="160" cy="120" r="16" class="domain-art-line domain-art-fill" />
      <circle cx="160" cy="120" r="5" class="domain-art-sensor" />
      <text x="160" y="168" text-anchor="middle" class="domain-art-label">same array</text>
      <path d="M194 120 H218" class="domain-art-line" />
      <path d="M212 114 L220 120 L212 126" class="domain-art-line" />
      <rect x="218" y="86" width="78" height="68" rx="6" class="domain-art-fill domain-art-line" />
      <text x="257" y="112" text-anchor="middle" class="domain-art-label">DECISION</text>
      <text x="257" y="128" text-anchor="middle" class="domain-art-label">+ limits</text>
      <text x="12" y="232" class="domain-art-label">declarative · host-rendered · no executable code</text>
      ${marks}
    </svg>`;
  }

  if (art === 'plant') {
    return `<svg class="domain-art" viewBox="0 0 320 240" role="img" aria-label="Dotted plant diagram">
      <path d="M112 166 L208 166 L197 228 L123 228 Z" class="domain-art-fill domain-art-line" />
      <line x1="115" y1="176" x2="205" y2="176" class="domain-art-soft" />
      <path d="M160 170 C158 145 162 120 160 76" class="domain-art-line" />
      <path d="M160 124 C132 120 112 98 108 66 C138 72 154 90 160 110 Z" class="domain-art-soft" />
      <path d="M160 108 C186 104 206 82 212 52 C182 58 164 74 160 94 Z" class="domain-art-soft" />
      <path d="M160 92 C148 78 146 56 154 38 C166 50 170 68 166 84 Z" class="domain-art-line domain-art-fill" />
      <path d="M160 124 C150 118 142 106 142 94 C154 98 160 108 160 116 Z" class="domain-art-line domain-art-fill" />
      <path d="M160 110 C170 104 178 92 178 80 C166 84 160 94 160 102 Z" class="domain-art-line domain-art-fill" />
      <path d="M145 228 C140 234 134 236 128 238" class="domain-art-soft" />
      <path d="M175 228 C180 234 186 236 192 238" class="domain-art-soft" />
      <line x1="234" y1="198" x2="234" y2="150" class="domain-art-line" />
      <circle cx="234" cy="146" r="5" class="domain-art-sensor" />
      <text x="246" y="148" class="domain-art-label">sensor</text>
      <text x="12" y="232" class="domain-art-label">no ethylene channel · change detector only</text>
      ${marks}
    </svg>`;
  }

  return `<svg class="domain-art" viewBox="0 0 320 240" role="img" aria-label="Fermentation vessel diagram">
    <rect x="96" y="56" width="128" height="152" rx="10" class="domain-art-fill domain-art-line" />
    <rect x="88" y="43" width="144" height="12" rx="4" class="domain-art-fill domain-art-line" />
    <path d="M160 43 L160 24 Q160 16 170 16 L192 16" class="domain-art-line" />
    <circle cx="198" cy="16" r="3" class="domain-art-sensor" />
    <rect x="101" y="102" width="118" height="100" rx="6" class="domain-art-accent" />
    <line x1="101" y1="102" x2="219" y2="102" class="domain-art-soft" />
    <circle cx="130" cy="132" r="2.5" class="domain-art-soft domain-bubble" />
    <circle cx="148" cy="158" r="2" class="domain-art-soft domain-bubble" style="animation-delay:.7s" />
    <circle cx="176" cy="126" r="2.5" class="domain-art-soft domain-bubble" style="animation-delay:1.4s" />
    <circle cx="190" cy="170" r="2" class="domain-art-soft domain-bubble" style="animation-delay:2.1s" />
    <line x1="224" y1="118" x2="250" y2="118" class="domain-art-line" />
    <circle cx="256" cy="118" r="5" class="domain-art-sensor" />
    <text x="12" y="232" class="domain-art-label">same array · same sample prep · not a safety test</text>
    ${marks}
  </svg>`;
}

function domainChartSvg(w: Extract<Domain.DomainWidget, { type: 'chart' }>, state: Domain.DomainState): string {
  const logged = state.logs
    .map((log, i) => {
      const value = Number.parseFloat(log.values[w.logField] ?? '');
      return Number.isFinite(value) ? { x: i + 1, y: value } : null;
    })
    .filter((p): p is { x: number; y: number } => !!p)
    .reverse();
  const demo = logged.length < 2;
  const points = demo ? w.demo : logged;
  const W = 640, H = 220, L = 46, R = 16, T = 20, B = 30;
  const xVals = points.map(p => p.x);
  const yVals = points.map(p => p.y);
  const xMin = Math.min(...xVals), xMax = Math.max(...xVals);
  let yMin = Math.min(...yVals), yMax = Math.max(...yVals);
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) { yMin = 0; yMax = 1; }
  if (yMax - yMin < 0.5) { yMin -= 0.5; yMax += 0.5; }
  const pad = (yMax - yMin) * 0.12;
  yMin -= pad;
  yMax += pad;
  const sx = (x: number) => L + ((x - xMin) / Math.max(1, xMax - xMin)) * (W - L - R);
  const sy = (y: number) => T + (1 - (y - yMin) / Math.max(0.0001, yMax - yMin)) * (H - T - B);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(' ');
  const dots = points.map(p => `<circle class="domain-chart-dot" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3"><title>${escapeHtmlText(`${p.x}: ${p.y}`)}</title></circle>`).join('');
  const grid = [0.25, 0.5, 0.75].map(f => {
    const y = T + f * (H - T - B);
    return `<line x1="${L}" y1="${y.toFixed(1)}" x2="${W - R}" y2="${y.toFixed(1)}" class="domain-chart-axis" />`;
  }).join('');
  return `<svg class="domain-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtmlText(w.title)}${demo ? ' (example points)' : ''}">
    <text x="${L}" y="12" class="domain-chart-title">${escapeHtmlText(w.yLabel)}</text>
    ${demo ? '<text x="' + (W - R) + '" y="12" text-anchor="end" class="domain-chart-demo">EXAMPLE</text>' : ''}
    ${grid}
    <line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="domain-chart-axis" />
    <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="domain-chart-axis" />
    <text x="8" y="${(T + 6).toFixed(1)}" class="domain-chart-label">${yMax.toFixed(1)}</text>
    <text x="8" y="${(H - B).toFixed(1)}" class="domain-chart-label">${yMin.toFixed(1)}</text>
    <text x="${L}" y="${H - 8}" class="domain-chart-label">${xMin}</text>
    <text x="${W - R}" y="${H - 8}" text-anchor="end" class="domain-chart-label">${xMax}</text>
    <path d="${path}" class="domain-chart-line${demo ? ' demo' : ''}" />
    ${dots}
  </svg>
  <div class="domain-chart-note">${escapeHtmlText(w.note)}${demo ? ' Showing example points until you add two readings.' : ''}</div>`;
}

function domainFieldHtml(f: Domain.DomainField, value: string, attr: 'domain-field' | 'domain-log-field'): string {
  const id = escapeHtmlText(f.id);
  const label = `${escapeHtmlText(f.label)}${f.unit ? ` <span style="text-transform:none;letter-spacing:0">(${escapeHtmlText(f.unit)})</span>` : ''}`;
  const common = `data-${attr}="${id}"`;
  if (f.type === 'select') {
    const options = (f.options || []).map(o => `<option value="${escapeHtmlText(o)}" ${value === o ? 'selected' : ''}>${escapeHtmlText(o)}</option>`).join('');
    return `<div class="domain-field"><label>${label}</label><select ${common}><option value="">—</option>${options}</select></div>`;
  }
  return `<div class="domain-field"><label>${label}</label><input type="${f.type}" ${common} value="${escapeHtmlText(value)}" placeholder="${escapeHtmlText(f.placeholder || '')}" ${f.type === 'number' ? 'step="any" inputmode="decimal"' : ''} /></div>`;
}

function domainLogHtml(log: Domain.DomainLog, fields: Domain.DomainField[]): string {
  const values = fields
    .map(f => {
      const value = log.values[f.id];
      if (!value) return '';
      return `<b>${escapeHtmlText(f.label)}</b> ${escapeHtmlText(value)}${f.unit ? ` ${escapeHtmlText(f.unit)}` : ''}`;
    })
    .filter(Boolean)
    .join(' · ');
  return `<div class="domain-log-entry">
    <div class="domain-log-values">${values || '<span class="hint">Empty reading</span>'}<br><span class="hint">${new Date(log.at).toLocaleString()}</span></div>
    <button class="domain-log-del" type="button" data-domain-log-del="${escapeHtmlText(log.id)}" title="Delete reading">×</button>
  </div>`;
}

function domainHotspotInfo(pack: Domain.DomainPack, id: string | null): string {
  if (!id) return 'Click a point on the diagram. Every point is a place where a confident reading can turn into a bad decision.';
  for (const w of pack.widgets) {
    if (w.type !== 'diagram') continue;
    const h = w.hotspots.find(x => x.id === id);
    if (h) return `<b>${escapeHtmlText(h.label)}</b> · ${escapeHtmlText(Domain.SEVERITY_LABEL[h.severity])}<br>${escapeHtmlText(h.body)}`;
  }
  return 'Click a point on the diagram.';
}

function domainWidgetHtml(w: Domain.DomainWidget, pack: Domain.DomainPack, state: Domain.DomainState): string {
  if (w.type === 'hero') {
    return `<div class="domain-hero">
      <div>
          <h2>${escapeHtmlText(w.title)}</h2>
        <p>${escapeHtmlText(w.subtitle)}</p>
        <p>${escapeHtmlText(pack.summary)}</p>
        <p><b>Scope:</b> ${escapeHtmlText(pack.scope || pack.whatItIs || '')}</p>
        <div class="domain-hero-note">${escapeHtmlText(w.note)}</div>
      </div>
      <div>${domainArtSvg(w.art)}</div>
    </div>`;
  }
  if (w.type === 'risk') {
    return `<div class="domain-risk-banner ${w.level}">
      <div class="domain-risk-head"><b>${escapeHtmlText(w.headline)}</b></div>
      <div class="domain-risk-body">${escapeHtmlText(w.body)}</div>
      <div class="domain-risk-lists">
        <div class="always"><h4>Always</h4><ul>${w.always.map(x => `<li>${escapeHtmlText(x)}</li>`).join('')}</ul></div>
        <div class="never"><h4>Never</h4><ul>${w.never.map(x => `<li>${escapeHtmlText(x)}</li>`).join('')}</ul></div>
      </div>
    </div>`;
  }
  if (w.type === 'metrics') {
    return `<div class="domain-panel"><h3>${escapeHtmlText(w.title)}</h3><div class="domain-metrics">
      ${w.items.map(item => `<div class="domain-metric"><span>${escapeHtmlText(item.label)}</span><strong>${escapeHtmlText(item.value)}</strong><p>${escapeHtmlText(item.hint)}</p></div>`).join('')}
    </div></div>`;
  }
  if (w.type === 'diagram') {
    return `<div class="domain-panel"><h3>${escapeHtmlText(w.title)}</h3><p class="hint">${escapeHtmlText(w.caption)}</p>
      ${domainArtSvg(w.art, w.hotspots)}
      <div class="domain-hotspot-info" id="domainHotspotInfo">${domainHotspotInfo(pack, activeDomainHotspot)}</div>
    </div>`;
  }
  if (w.type === 'timeline') {
    return `<div class="domain-panel"><h3>${escapeHtmlText(w.title)}</h3><div class="domain-timeline">
      ${w.steps.map(step => `<div class="domain-step"><div class="domain-step-range">${escapeHtmlText(step.range)}</div><div><div class="domain-step-label">${escapeHtmlText(step.label)}</div><div class="domain-step-body">${escapeHtmlText(step.body)}</div>${step.warn ? `<div class="domain-step-warn">${escapeHtmlText(step.warn)}</div>` : ''}</div></div>`).join('')}
    </div></div>`;
  }
  if (w.type === 'tracking') {
    const logs = state.logs.length
      ? state.logs.map(log => domainLogHtml(log, w.logFields)).join('')
      : '<div class="hint">No readings yet. Add one when you measure or inspect.</div>';
    return `<div class="domain-panel" id="domainTracking"><h3>${escapeHtmlText(w.title)}</h3><p class="hint">${escapeHtmlText(w.description)}</p>
      <div class="domain-track-grid">${w.fields.map(f => domainFieldHtml(f, state.fields[f.id] || '', 'domain-field')).join('')}</div>
      <div class="domain-log-form">${w.logFields.map(f => domainFieldHtml(f, '', 'domain-log-field')).join('')}<button class="mini-btn primary domain-log-add" type="button" data-domain-log-add>${escapeHtmlText(w.logLabel)}</button></div>
      <div class="domain-log-list">${logs}</div>
    </div>`;
  }
  if (w.type === 'chart') {
    return `<div class="domain-panel"><h3>${escapeHtmlText(w.title)}</h3>${domainChartSvg(w, state)}</div>`;
  }
  if (w.type === 'detector') {
    const levels = w.levels.map(level => {
      const n = Math.max(0, Math.min(3, Math.round(level.level)));
      return `<div class="domain-detector-level l${n}">
        <div class="domain-detector-level-key">L${n} · ${escapeHtmlText(level.label)}</div>
        <div class="domain-detector-level-meaning">${escapeHtmlText(level.meaning)}</div>
        <div class="domain-detector-level-action">→ ${escapeHtmlText(level.action)}</div>
      </div>`;
    }).join('');
    return `<div class="domain-panel domain-detector">
      <div class="domain-detector-head">
        <div><h3>${escapeHtmlText(w.title)}</h3><p class="hint">${escapeHtmlText(w.intro)}</p></div>
        <button class="mini-btn primary" type="button" data-domain-dashboard>Open live detector</button>
      </div>
      <div class="domain-detector-baseline"><b>Baseline</b><span>${escapeHtmlText(w.baseline)}</span></div>
      <div class="domain-detector-levels">${levels}</div>
      <div class="domain-detector-limits"><b>Limits</b><ul>${w.limits.map(limit => `<li>${escapeHtmlText(limit)}</li>`).join('')}</ul></div>
      <div class="domain-detector-evidence">${escapeHtmlText(w.evidence)}</div>
    </div>`;
  }
  if (w.type === 'rules') {
    return `<div class="domain-panel"><h3>${escapeHtmlText(w.title)}</h3><div class="domain-rules">
      ${w.rules.map(rule => `<div class="domain-rule ${rule.severity}"><div class="domain-rule-sev">${escapeHtmlText(Domain.SEVERITY_LABEL[rule.severity])}</div><div><div class="domain-rule-when">${escapeHtmlText(rule.when)}</div><div class="domain-rule-then">${escapeHtmlText(rule.then)}</div></div></div>`).join('')}
    </div></div>`;
  }
  if (w.type === 'checklist') {
    return `<div class="domain-panel"><h3>${escapeHtmlText(w.title)}</h3><div class="domain-checklist">
      ${w.items.map(item => {
        const inputId = `dchk_${pack.id}_${item.id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        return `<div class="domain-check"><input id="${inputId}" type="checkbox" data-domain-check="${escapeHtmlText(item.id)}" ${state.checks[item.id] ? 'checked' : ''} /><label for="${inputId}">${escapeHtmlText(item.label)}<span>${escapeHtmlText(item.detail)}</span></label></div>`;
      }).join('')}
    </div></div>`;
  }
  if (w.type === 'docs') {
    const docs = pack.docs.map(doc => `<details class="domain-doc"><summary>${escapeHtmlText(doc.title)}</summary><div class="domain-doc-body">${doc.body.map(p => `<p>${escapeHtmlText(p)}</p>`).join('')}</div></details>`).join('');
    const cites = `<details class="domain-doc"><summary>Citations and limits</summary><div class="domain-doc-body">${pack.citations.map(c => `<p>${escapeHtmlText(c)}</p>`).join('')}<p>Citations describe the domain context; they do not turn this Vial into a diagnostic or safety instrument.</p></div></details>`;
    return `<div class="domain-panel" id="domainDocs"><h3>${escapeHtmlText(w.title)}</h3><div class="domain-docs">${docs}${cites}</div></div>`;
  }
  if (w.type === 'rig') {
    return `<div class="domain-rig"><div><b>${escapeHtmlText(w.title)}</b><p>${escapeHtmlText(w.body)}</p></div><button class="mini-btn primary" type="button" data-domain-rig>${escapeHtmlText(w.cta)}</button></div>`;
  }
  return '';
}

function domainSourceLabel(pack: Domain.DomainPack): string {
  if (!pack.sourceUrl) return '';
  try {
    const url = new URL(pack.sourceUrl);
    return ` · from ${url.hostname}`;
  } catch {
    return '';
  }
}

function domainSourceHref(pack: Domain.DomainPack): string {
  return pack.sourceUrl || '';
}

function domainSourceHost(href: string): string {
  try { return new URL(href).hostname; } catch { return ''; }
}

function domainCardHtml(pack: Domain.DomainPack, installed: boolean): string {
  const sourceHref = domainSourceHref(pack);
  const sourceHost = domainSourceHost(sourceHref);
  const gate = Domain.validateDomainPack(pack, true);
  const gateStatus = pack.schema === 'osmograph.domain-pack/2'
    ? (gate.gated ? ' · Gated' : ' · Ungated · add a fixture')
    : ' · legacy · Ungated';
  const state = installed ? 'installed' : 'source';
  const cockpit = pack.ui ? ' · sandboxed UI' : '';
  const actions = installed
    ? `<button class="mini-btn primary" type="button" data-domain-open="${escapeHtmlText(pack.id)}">Open</button>
       ${sourceHref ? `<a class="text-link domain-source" href="${escapeHtmlText(sourceHref)}" target="_blank" rel="noopener noreferrer" title="Manifest source">Source ↗</a>` : ''}
       <details class="ds-row-menu domain-menu">
         <summary title="More actions">⋯</summary>
         <div class="ds-row-menu-pop">
           <button type="button" data-domain-docs="${escapeHtmlText(pack.id)}">Docs</button>
           <button type="button" data-domain-export="${escapeHtmlText(pack.id)}">Export</button>
           <button type="button" class="ds-remove" data-domain-remove="${escapeHtmlText(pack.id)}">Remove</button>
         </div>
       </details>`
    : `<button class="mini-btn primary" type="button" data-domain-install="${escapeHtmlText(pack.id)}">Install</button>
       ${sourceHref ? `<a class="text-link domain-source" href="${escapeHtmlText(sourceHref)}" target="_blank" rel="noopener noreferrer" title="Manifest source">Source ↗</a>` : ''}
       <details class="ds-row-menu domain-menu">
         <summary title="More actions">⋯</summary>
         <div class="ds-row-menu-pop">
           <button type="button" data-domain-export="${escapeHtmlText(pack.id)}">Export</button>
           <button type="button" class="ds-remove" data-domain-delete="${escapeHtmlText(pack.id)}">Delete</button>
         </div>
       </details>`;
  return `<div class="domain-card ${installed ? 'installed' : ''}" title="${escapeHtmlText(pack.summary)}">
    <div class="domain-card-head">
      <div style="min-width:0"><div class="domain-card-name">${escapeHtmlText(pack.name)}</div><div class="domain-card-sub">v${escapeHtmlText(pack.version)} · ${escapeHtmlText(pack.author)}</div></div>
      <span class="domain-card-state ${state}">${state}</span>
    </div>
    <div class="domain-card-tagline">${escapeHtmlText(pack.tagline)}</div>
    <div class="domain-card-meta">${escapeHtmlText(pack.domain)} · ${escapeHtmlText(pack.license)} · ${gate.checks.filter(c => c.passed).length}/${gate.checks.length} gate${cockpit}${gateStatus}${sourceHost ? ` · ${escapeHtmlText(sourceHost)}` : ''}</div>
    <div class="domain-card-actions">${actions}</div>
  </div>`;
}

function registryRemotePacks(): RegistryVialEntry[] {
  return registryEntries.filter(entry => !!entry.manifestUrl);
}

function registryUnpublishedCount(): number {
  return registryEntries.filter(entry => !entry.manifestUrl).length;
}

function versionTuple(version: string): [number, number, number] {
  const parts = version.split('.').map(p => parseInt(p, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function versionGreater(a: string, b: string): boolean {
  const [a0, a1, a2] = versionTuple(a);
  const [b0, b1, b2] = versionTuple(b);
  return a0 > b0 || (a0 === b0 && (a1 > b1 || (a1 === b1 && a2 > b2)));
}

function registryEntryHasUpdate(entry: RegistryVialEntry): boolean {
  if (!Domain.loadInstalledIds().includes(entry.id)) return false;
  const installed = Domain.domainPackById(entry.id);
  return !!installed && versionGreater(entry.version, installed.version);
}

/** sha256 hex of a text payload, via the platform WebCrypto (secure context). */
async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function registryCardHtml(entry: RegistryVialEntry): string {
  let host = 'author-hosted';
  try { host = new URL(entry.manifestUrl || '').hostname; } catch { /* keep fallback */ }
  const installed = Domain.domainPackById(entry.id);
  const update = registryEntryHasUpdate(entry);
  const installedActive = !!installed && Domain.loadInstalledIds().includes(entry.id);
  const label = update
    ? `Update to v${entry.version}`
    : installedActive
      ? `Reinstall v${entry.version}`
      : 'Install from source';
  const assets = entry.assets ? ` data-registry-assets="${escapeHtmlText(JSON.stringify(entry.assets))}"` : '';
  const version = ` data-registry-version="${escapeHtmlText(entry.version)}"`;
  return `<div class="domain-card remote">
    <div class="domain-card-head">
      <div style="min-width:0"><div class="domain-card-name">${escapeHtmlText(entry.name)}</div><div class="domain-card-sub">v${escapeHtmlText(entry.version)} · ${escapeHtmlText(entry.author)}</div></div>
      <span class="domain-card-state source">${update
      ? `update from v${escapeHtmlText(installed?.version || '')}`
      : `${entry.schema === 'osmograph.domain-pack/2' ? 'v2' : 'legacy · Ungated'}${entry.hasUi ? ' · UI' : ''}`}</span>
    </div>
    <div class="domain-card-tagline">${escapeHtmlText(entry.tagline)}</div>
    <div class="domain-card-meta">${escapeHtmlText(entry.domain)} · ${escapeHtmlText(entry.license)}${entry.evidence ? ` · evidence ${escapeHtmlText(entry.evidence)}` : ''} · ${escapeHtmlText(host)}</div>
    <div class="domain-card-actions">
      <button class="mini-btn primary" type="button" data-registry-install="${escapeHtmlText(entry.manifestUrl || '')}" data-registry-id="${escapeHtmlText(entry.id)}"${entry.hash ? ` data-registry-hash="${escapeHtmlText(entry.hash)}"` : ''}${version}${assets}>${escapeHtmlText(label)}</button>
      <a class="text-link domain-source" href="${escapeHtmlText(entry.manifestUrl || '')}" target="_blank" rel="noopener noreferrer">Source ↗</a>
    </div>
  </div>`;
}

async function loadVialRegistry(): Promise<void> {
  if (registryLoading || registryLoaded) return;
  registryLoading = true;
  registryError = '';
  try {
    registryEntries = await fetchVialRegistry();
  } catch (err) {
    registryError = err instanceof Error ? err.message : 'The registry could not be reached.';
  } finally {
    registryLoading = false;
    registryLoaded = true;
    if (activeVialsTab === 'aromatory') renderDomainArea();
  }
}

function renderDomainArea(): void {
  const installedHost = document.getElementById('domainInstalledList');
  const catalogHost = document.getElementById('domainCatalog');
  const all = Domain.allDomainPacks();
  const installedIds = new Set(Domain.loadInstalledIds());
  const installed = all.filter(p => installedIds.has(p.id));
  const available = all.filter(p => !installedIds.has(p.id));
  const remoteAll = registryRemotePacks();
  const updates = remoteAll.filter(registryEntryHasUpdate);
  const remote = remoteAll.filter(entry => !installedIds.has(entry.id));
  if (installedHost) {
    installedHost.innerHTML = installed.length
      ? `<div class="domain-grid">${installed.map(p => domainCardHtml(p, true)).join('')}</div>`
      : `<div class="domain-empty"><b>No domain Vials installed.</b><br>Install a workspace to get a protocol, a log, scope limits, and the questions the array cannot answer. <button class="text-link" type="button" data-vials-tab-go="aromatory">Open the Aromatory →</button></div>`;
  }
  if (catalogHost) {
    const registryNote = registryLoading
      ? 'Loading the public registry…'
      : registryError
        ? `Registry unavailable (${escapeHtmlText(registryError)}). Install from a URL instead.`
        : remote.length
          ? `${remote.length} author-hosted project${remote.length === 1 ? '' : 's'} discovered. Each still passes the local gate.${registryUnpublishedCount() ? ` ${registryUnpublishedCount()} more named in the registry have no published manifest URL — nothing to install yet.` : ''}`
          : registryUnpublishedCount()
            ? `Registry checked. ${registryUnpublishedCount()} named project${registryUnpublishedCount() === 1 ? ' has' : 's have'} no published manifest URL. Install from a URL instead.`
            : 'Registry checked. No new author-hosted projects.';
    catalogHost.innerHTML = `
      <div class="vials-section-head" style="margin-top:0"><span>Domain packs</span><span class="domain-catalog-actions"><button class="mini-btn" type="button" data-domain-import>Import .vial.json</button><button class="mini-btn" type="button" data-domain-url>Install from URL</button><button class="mini-btn" type="button" data-domain-template>Starter template</button><button class="mini-btn" type="button" data-domain-submit>Submit</button><button class="mini-btn" type="button" data-guide-open="authoring">Authoring</button><span class="coord-tag">${available.length} available</span></span></div>
      <div class="domain-grid">
        ${available.length ? available.map(p => domainCardHtml(p, false)).join('') : '<div class="domain-empty">No local manifests. Fetch an author-hosted <b>vial.json</b> by URL, import a file, or start from the template.</div>'}
      </div>
      ${updates.length ? `<div class="vials-section-head" style="margin-top:14px"><span>Updates</span><span class="coord-tag">${updates.length} newer version${updates.length === 1 ? '' : 's'} pinned in the registry</span></div>
      <div class="domain-grid">${updates.map(registryCardHtml).join('')}</div>` : ''}
      <div class="vials-section-head" style="margin-top:14px"><span>From the registry</span><span class="coord-tag">${registryNote}</span></div>
      ${remote.length ? `<div class="domain-grid">${remote.map(registryCardHtml).join('')}</div>` : ''}`;
  }
  void loadVialRegistry();
}

const DOMAIN_SECTION_LABEL: Record<string, string> = {
  hero: 'Overview', risk: 'Scope', metrics: 'Claims', detector: 'Detector', diagram: 'Diagram', timeline: 'Rhythm',
  tracking: 'Log', chart: 'Trend', rules: 'Stop rules', checklist: 'Checklist', docs: 'Field notes', rig: 'Rig',
};
const DOMAIN_JUMP_ORDER = ['hero', 'risk', 'metrics', 'detector', 'tracking', 'chart', 'diagram', 'timeline', 'rules', 'checklist', 'docs', 'rig'];
const DOMAIN_TOP_TYPES = new Set(['hero', 'risk', 'metrics']);
const DOMAIN_LEFT_TYPES = new Set(['detector', 'tracking', 'chart']);
const DOMAIN_RIGHT_TYPES = new Set(['diagram', 'timeline', 'rules', 'checklist', 'docs']);

function domainSectionHtml(w: Domain.DomainWidget, pack: Domain.DomainPack, state: Domain.DomainState): string {
  return `<section class="domain-section domain-section--${w.type}" id="domainSection_${w.type}" data-domain-section="${w.type}">${domainWidgetHtml(w, pack, state)}</section>`;
}

function updateDomainJumpActive(): void {
  const workspace = document.getElementById('domainWorkspace');
  const jumpBar = document.getElementById('domainJumpBar');
  if (!workspace || !jumpBar) return;
  const workspaceTop = workspace.getBoundingClientRect().top;
  const sections = [...workspace.querySelectorAll<HTMLElement>('[data-domain-section]')];
  let active = sections[0]?.dataset.domainSection || '';
  for (const section of sections) {
    if (section.getBoundingClientRect().top - workspaceTop <= 128) active = section.dataset.domainSection || active;
  }
  jumpBar.querySelectorAll<HTMLElement>('.domain-jump').forEach(button => {
    button.classList.toggle('active', button.dataset.domainJump === active);
  });
}

interface ActiveVialRuntime {
  pack: Domain.DomainPack;
  nonce: string;
  iframe: HTMLIFrameElement;
  source: string;
  sources: VialRuntime.VialSourceOption[];
  recordingCache: Map<string, VialRuntime.VialSeriesWindow | null>;
  timer: number | null;
  ready: boolean;
  mount: 'workspace' | 'home';
  destroyed: boolean;
  uiHtml: string;
  transforms: VialRuntime.VialTransforms | null;
  detectionConfig: VialHost.VialDetectionConfig | null;
  trajectoryFields: string[];
  trajectoryIntervalMs: number;
  trajectory: VialHost.TrajectoryPoint[];
  lastTrajectoryAt: number;
}

const VIAL_SOURCE_KEY = 'osmograph.vial.source.';
let activeVialRuntime: ActiveVialRuntime | null = null;
let homeVialRuntime: ActiveVialRuntime | null = null;
/** Which Vial currently owns Home, if any. The selected Home Vial is restored
 *  on launch; exiting its view clears the selection and returns to the instrument. */
let homeTakeoverVialId: string | null = selectedHomeVialId();
if (homeTakeoverVialId) {
  window.setTimeout(() => {
    if (!homeTakeoverVialId) return;
    activateWorkspace('dashboard');
    renderVialHome();
  }, 0);
}

function uiCacheKey(id: string, kind: 'workspace' | 'home'): string {
  return kind === 'home' ? `${id}::home` : id;
}

function resolveDomainUiHtml(pack: Domain.DomainPack, kind: 'workspace' | 'home' = 'workspace'): string | null {
  const spec = kind === 'home' ? pack.homeUi : pack.ui;
  if (!spec) return null;
  return Domain.loadDomainUi(uiCacheKey(pack.id, kind), pack.version);
}

function domainUiAssetUrl(pack: Domain.DomainPack, manifestUrl: string | undefined, kind: 'workspace' | 'home' = 'workspace'): string | null {
  const spec = kind === 'home' ? pack.homeUi : pack.ui;
  if (!spec) return null;
  const base = manifestUrl || pack.sourceUrl || '';
  if (!base) return null;
  try {
    return new URL(spec.entry, base).toString();
  } catch {
    return null;
  }
}

async function fetchDomainUiAsset(pack: Domain.DomainPack, manifestUrl: string, kind: 'workspace' | 'home' = 'workspace'): Promise<string> {
  const raw = domainUiAssetUrl(pack, manifestUrl, kind);
  if (!raw) throw new Error('This Vial has no UI asset URL.');
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'))) {
    throw new Error('A sandboxed Vial UI must use HTTPS (localhost is allowed for development).');
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url.toString(), {
      headers: { Accept: 'text/html' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`The UI server returned HTTP ${response.status}.`);
    const finalUrl = new URL(response.url);
    if (finalUrl.origin !== url.origin || finalUrl.pathname !== url.pathname) {
      throw new Error('The UI redirect left the manifest source path. Refusing to run it.');
    }
    const html = await response.text();
    VialRuntime.assertSandboxableUi(html);
    return html;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('The UI download timed out.');
    }
    throw err;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function cacheDomainUi(
  pack: Domain.DomainPack,
  manifestUrl: string,
  expected?: Record<string, string>,
): Promise<Record<string, string>> {
  // Fetch and verify everything before writing anything. A second asset that
  // fails must not leave a half-updated cache behind a working install.
  const pending: Array<{ kind: 'workspace' | 'home'; html: string; source: string }> = [];
  const hashes: Record<string, string> = {};
  for (const kind of ['workspace', 'home'] as const) {
    const spec = kind === 'home' ? pack.homeUi : pack.ui;
    if (!spec) continue;
    const pinned = expected?.[spec.entry];
    if (expected && !pinned) {
      throw new Error(`The registry does not pin ${spec.entry}. Refusing to install a reviewed Vial with an unpinned UI asset.`);
    }
    const html = await fetchDomainUiAsset(pack, manifestUrl, kind);
    if (pack.anomaly && /\b(?:setDetection|setTransforms)\b/.test(html)) {
      throw new Error(`${spec.entry} calls a legacy detector override. A v2 profile is compiled from the manifest; remove setDetection/setTransforms from the UI.`);
    }
    const actual = await sha256Hex(html);
    if (pinned && actual !== pinned.toLowerCase()) {
      throw new Error(`${spec.entry} does not match the sha256 pinned in the registry. Refusing to run it.`);
    }
    hashes[spec.entry] = actual;
    pending.push({ kind, html, source: domainUiAssetUrl(pack, manifestUrl, kind) || '' });
  }
  for (const item of pending) {
    Domain.saveDomainUi(uiCacheKey(pack.id, item.kind), pack.version, item.html, item.source || undefined);
  }
  return hashes;
}

function runtimeSourceOptions(): VialRuntime.VialSourceOption[] {
  const options: VialRuntime.VialSourceOption[] = [{
    id: 'live',
    // "Live" must mean a connected rig. Without one, the buffer is the tail of
    // past samples — a capture, not a stream — and must not borrow the word.
    label: connected ? 'Live array' : 'Captured buffer',
    kind: connected ? 'live' : 'recording',
    detail: connected ? 'This rig, current session' : 'No rig connected — the tail of previously captured samples',
  }];
  for (const session of sessions) {
    if (!session.file_id) continue;
    options.push({
      id: `rec:${session.file_id}`,
      label: `${session.substance} · ${session.time}`,
      kind: 'recording',
      detail: session.label,
    });
    if (options.length >= 25) break;
  }
  return options;
}

function liveVialSeries(): VialRuntime.VialSeriesWindow | null {
  const channels = chNames.slice();
  if (!channels.length) return null;
  const raw = channels.map((_, i) => historyData[i]?.slice() ?? []);
  const n = raw.reduce((max, values) => Math.max(max, values.length), 0);
  if (n < 4) return null;
  const sampled = VialRuntime.downsampleChannels(raw, 600);
  return {
    // Source follows reality, not the slot name: a connected rig is live; with
    // no rig the same bytes are a capture and vials must brand them as such.
    source: connected ? 'live' : 'recording',
    label: connected ? 'Live array' : 'Captured buffer — no rig connected',
    channels,
    time: sampled.indices,
    timeUnit: 'sample',
    values: sampled.values,
    fingerprint: VialRuntime.fingerprintFromSeries(sampled.values),
    evolution: VialRuntime.evolutionFromSeries(sampled.values),
    response: null,
  };
}

async function recordingVialSeries(sourceId: string): Promise<VialRuntime.VialSeriesWindow | null> {
  const fileId = sourceId.startsWith('rec:') ? sourceId.slice(4) : '';
  if (!fileId) return null;
  const session = sessions.find(s => s.file_id === fileId);
  try {
    const series = await invoke<SessionSeries>('load_session_series', { fileId });
    if (!series || !Array.isArray(series.channels) || !Array.isArray(series.values)) return null;
    const sampled = VialRuntime.downsampleChannels(series.values, 600);
    return {
      source: 'recording',
      label: session ? `${session.substance} · ${session.time}` : series.label,
      channels: series.channels,
      time: sampled.indices.map(i => series.time[i] ?? i),
      timeUnit: 's',
      values: sampled.values,
      fingerprint: VialRuntime.fingerprintFromSeries(sampled.values),
      evolution: VialRuntime.evolutionFromSeries(sampled.values),
      response: null,
    };
  } catch {
    return null;
  }
}

function vialEvents(): VialRuntime.VialEvent[] {
  const label = (index: number): string => chNames[index] || `CH ${index + 1}`;
  const events: VialRuntime.VialEvent[] = [];
  if (openChange) {
    events.push({
      start: openChange.start,
      end: Date.now(),
      alert: openChange.alert,
      peak: openChange.peak,
      channels: [...openChange.channels].map(label),
      ongoing: true,
    });
  }
  for (const event of changeLog.slice(0, 40)) {
    events.push({
      start: event.start,
      end: event.end,
      alert: event.alert,
      peak: event.peak,
      channels: event.channels.map(label),
      ongoing: false,
    });
  }
  return events;
}

const VIAL_TRAJECTORY_FIELDS = new Set(['anomaly.score', 'anomaly.confidence', 'baseline.progress', 'env.temperature', 'env.humidity']);

function resolveTrajectoryFields(fields: string[]): string[] {
  const liveIds = new Set(chNames.map((_, i) => `ch${i}`));
  return fields.filter(f => liveIds.has(f) || VIAL_TRAJECTORY_FIELDS.has(f)).slice(0, 8);
}

function sampleTrajectory(fields: string[]): Record<string, number> {
  const values: Record<string, number> = {};
  const env = lastEnv as { temperature?: number | null; humidity?: number | null } | null;
  for (const field of fields) {
    if (field === 'anomaly.score') {
      if (lastAnomalyReading.score !== null) values[field] = lastAnomalyReading.score;
      continue;
    }
    if (field === 'anomaly.confidence') {
      if (lastAnomalyReading.confidence !== null) values[field] = lastAnomalyReading.confidence;
      continue;
    }
    if (field === 'baseline.progress') {
      values[field] = lastAnomalyReading.baselineProgress;
      continue;
    }
    if (field === 'env.temperature') {
      if (env && typeof env.temperature === 'number') values[field] = env.temperature;
      continue;
    }
    if (field === 'env.humidity') {
      if (env && typeof env.humidity === 'number') values[field] = env.humidity;
      continue;
    }
    if (field.startsWith('ch')) {
      const index = Number(field.slice(2));
      const buffer = historyData[index];
      if (!buffer) continue;
      const tail = buffer.slice();
      const latest = [...tail].reverse().find(v => Number.isFinite(v));
      if (latest !== undefined) values[field] = latest;
    }
  }
  return values;
}

function recordVialTrajectory(runtime: ActiveVialRuntime): void {
  if (runtime.source !== 'live' || !runtime.trajectoryFields.length) return;
  if (lastAnomalyReading.state === 'unknown') return;
  const now = Date.now();
  if (now - runtime.lastTrajectoryAt < runtime.trajectoryIntervalMs) return;
  const values = sampleTrajectory(runtime.trajectoryFields);
  if (!Object.keys(values).length) return;
  runtime.lastTrajectoryAt = now;
  runtime.trajectory.push({ at: now, values });
  if (runtime.trajectory.length > VIAL_TRAJECTORY_MAX) {
    runtime.trajectory.splice(0, runtime.trajectory.length - VIAL_TRAJECTORY_MAX);
  }
  try {
    localStorage.setItem(VIAL_TRAJECTORY_KEY + runtime.pack.id, JSON.stringify(runtime.trajectory));
  } catch { /* storage full: keep the in-memory series */ }
}

/** A Vial-declared limit only ever tightens the host's own evidence. The host
 *  checks each declared channel against its transformed response; it never
 *  invents a value for a silent channel. */
function evaluateVialDetection(
  config: VialHost.VialDetectionConfig,
  snapshot: VialHost.VialHostSnapshot,
  series: VialRuntime.VialSeriesWindow | null,
): VialHost.VialDetectionResult {
  const triggeredChannels: string[] = [];
  const responseValues = series?.response?.values || [];
  for (const [channelId, limit] of Object.entries(config.perChannelLimits)) {
    const index = snapshot.channels.findIndex(c => c.id === channelId);
    if (index < 0) continue;
    const latest = [...(responseValues[index] || [])]
      .reverse()
      .find(v => v !== null && Number.isFinite(v));
    if (latest === undefined || latest === null) continue;
    if (Math.abs(latest) >= limit) triggeredChannels.push(channelId);
  }
  const confidence = snapshot.anomaly.confidence;
  const confidenceClears = confidence === null || confidence >= config.alertThreshold;
  return {
    active: config.enabled && triggeredChannels.length > 0 && confidenceClears,
    triggeredChannels,
  };
}

async function sendVialData(runtime: ActiveVialRuntime | null = activeVialRuntime, force = false): Promise<void> {
  if (!runtime || runtime.destroyed || !runtime.iframe.isConnected) return;
  if (!force && runtime.source !== 'live') return;
  let series: VialRuntime.VialSeriesWindow | null = null;
  if (runtime.source === 'live') {
    series = liveVialSeries();
  } else if (runtime.source.startsWith('rec:')) {
    if (!runtime.recordingCache.has(runtime.source)) {
      runtime.recordingCache.set(runtime.source, await recordingVialSeries(runtime.source));
    }
    series = runtime.recordingCache.get(runtime.source) || null;
  }
  if (runtime.destroyed || !runtime.iframe.isConnected) return;
  if (series && runtime.transforms) {
    series = VialRuntime.applyVialTransforms(series, runtime.transforms);
  }
  recordVialTrajectory(runtime);
  const snapshot = currentHostSnapshot(runtime);
  const profile = runtime.pack.anomaly;
  const liveV2 = !!profile && connected && runtime.source === 'live';
  if (profile && !liveV2) {
    snapshot.detection = {
      active: false,
      triggeredChannels: [],
      admissible: false,
      reason: connected
        ? 'The profile detector runs on the live array, not a recording.'
        : 'The profile detector needs a connected rig; this is a captured buffer.',
    };
  } else if (profile && !vialDetectorResults.get(runtime.pack.id)) {
    // The engine has not produced its first verdict yet. Do not substitute the
    // base app's detector or the per-channel bands: they are a different program.
    snapshot.detection = null;
  } else if (vialDetectorResults.get(runtime.pack.id)) {
    const vialResult = vialDetectorResults.get(runtime.pack.id)!;
    const bands = profile?.detection.perChannelLimits || {};
    const bandChannels = Object.keys(bands);
    let result: VialHost.VialDetectionResult;
    if (bandChannels.length && runtime.detectionConfig && series?.response) {
      // The profile declares both a multivariate level budget and absolute
      // per-channel bands. A Vial alert requires both: the engine must see a
      // sustained multivariate change, and at least minChannels channels must
      // clear their declared band. Neither lever is decorative.
      const band = evaluateVialDetection(runtime.detectionConfig, snapshot, series);
      const minChannels = Math.max(1, profile?.detection.minChannels || 1);
      result = {
        active: vialResult.is_anomaly && band.triggeredChannels.length >= minChannels,
        triggeredChannels: band.triggeredChannels,
      };
    } else {
      result = {
        active: vialResult.is_anomaly,
        triggeredChannels: vialResult.triggered_channels.map(i => snapshot.channels[i]?.id || `ch${i}`),
      };
    }
    const channelLive: Record<string, boolean> = {};
    for (const channel of snapshot.channels) {
      const limit = snapshot.channelLimits[channel.id];
      channelLive[channel.id] = !!limit && !limit.dead;
    }
    const admissibility = profile
      ? VialProfile.profileAdmissibility(profile, {
          baselineState: snapshot.baseline.state,
          channelLive,
        })
      : { admissible: true, reason: null };
    snapshot.detection = {
      ...result,
      active: admissibility.admissible && result.active,
      admissible: admissibility.admissible,
      reason: admissibility.reason,
    };
  } else if (runtime.detectionConfig && series?.response) {
    snapshot.detection = evaluateVialDetection(runtime.detectionConfig, snapshot, series);
  }
  const state = activeDomainState && activeDomainState.packId === runtime.pack.id
    ? activeDomainState
    : Domain.loadDomainState(runtime.pack.id);
  const payload: VialRuntime.VialDataPayload = {
    schema: VialRuntime.VIAL_RUNTIME_SCHEMA,
    snapshot,
    series,
    sources: runtime.sources,
    selectedSource: runtime.source,
    events: vialEvents(),
    domain: { fields: state.fields, checks: state.checks, logs: state.logs },
    view: runtime.mount,
    host: { name: 'Osmograph', version: 'desktop', runtime: 'sandbox/1' },
  };
  runtime.iframe.contentWindow?.postMessage({ vialData: true, payload }, '*');
  const stampText = series
    ? `${series.label} · ${series.channels.length} ch · ${series.values[0]?.length || 0} pts`
    : runtime.source === 'live'
      ? 'no live window yet'
      : 'recording unavailable';
  const stamp = document.getElementById(runtime.mount === 'home' ? 'vialHomeStamp' : 'vialRuntimeStamp');
  if (stamp) stamp.textContent = stampText;
}

function vialRuntimeShellHtml(pack: Domain.DomainPack): string {
  const sourceHref = domainSourceHref(pack);
  const sourceHost = domainSourceHost(sourceHref);
  return `<div class="vial-runtime-shell">
    <div class="vial-runtime-bar">
      <div class="vial-runtime-title"><span class="vial-runtime-dot"></span>${escapeHtmlText(pack.name)}<span class="coord-tag">sandbox/1</span></div>
      <span class="vial-runtime-stamp" id="vialRuntimeStamp">starting…</span>
      <span class="vial-runtime-lock" title="Unsigned sandboxed UI: no file, network, storage, or Tauri access">host-owned data · sandboxed UI · unsigned</span>
      ${sourceHost ? `<a class="text-link" href="${escapeHtmlText(sourceHref)}" target="_blank" rel="noopener noreferrer">${escapeHtmlText(sourceHost)} ↗</a>` : ''}
      <button class="mini-btn" type="button" id="vialReportBtn" title="Open a prefilled issue with this Vial's id, version, and hashes">Report a problem</button>
      <button class="mini-btn" type="button" id="vialRuntimeReload">Reload UI</button>
    </div>
    <iframe id="vialRuntimeFrame" class="vial-runtime-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${escapeHtmlText(pack.name)} sandboxed Vial UI"></iframe>
  </div>`;
}

function destroyRuntime(runtime: ActiveVialRuntime | null, clearFrame = true): void {
  if (!runtime) return;
  runtime.destroyed = true;
  if (runtime.timer !== null) window.clearInterval(runtime.timer);
  if (clearFrame) runtime.iframe.srcdoc = '';
  if (activeVialRuntime === runtime) activeVialRuntime = null;
  if (homeVialRuntime === runtime) homeVialRuntime = null;
}

function resetVialDetector(id: string): Promise<unknown> {
  vialDetectorResults.delete(id);
  const reset = invoke('vial_detection_reset', { vialId: id }).catch((error) => {
    if (import.meta.env.DEV) console.error('vial_detection_reset failed', error);
  });
  vialDetectorResets.set(id, reset);
  void reset.finally(() => {
    if (vialDetectorResets.get(id) === reset) vialDetectorResets.delete(id);
  });
  return reset;
}

function releaseVialDetector(id: string | null): void {
  if (!id) return;
  if (activeVialRuntime?.pack.id === id || homeVialRuntime?.pack.id === id) return;
  void resetVialDetector(id);
}

function destroyVialRuntime(clearFrame = true): void {
  const id = activeVialRuntime?.pack.id || null;
  destroyRuntime(activeVialRuntime, clearFrame);
  releaseVialDetector(id);
}

function destroyHomeVialRuntime(clearFrame = true): void {
  const id = homeVialRuntime?.pack.id || null;
  destroyRuntime(homeVialRuntime, clearFrame);
  releaseVialDetector(id);
}

const VIAL_TRAJECTORY_KEY = 'osmograph.vial.trajectory.';
const VIAL_TRAJECTORY_SPEC_KEY = 'osmograph.vial.trajectorySpec.';
const VIAL_TRANSFORMS_KEY = 'osmograph.vial.transforms.';
const VIAL_DETECTION_KEY = 'osmograph.vial.detection.';
const VIAL_TRAJECTORY_MAX = 2000;

function loadVialTransforms(packId: string): VialRuntime.VialTransforms | null {
  try {
    const raw = JSON.parse(localStorage.getItem(VIAL_TRANSFORMS_KEY + packId) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    if (!VialRuntime.VIAL_BASELINES.includes(raw.baseline)) return null;
    if (!VialRuntime.VIAL_RESPONSES.includes(raw.response)) return null;
    const conditioning = Array.isArray(raw.conditioning)
      ? raw.conditioning.filter((c: unknown): c is string => typeof c === 'string')
      : [];
    return { baseline: raw.baseline, response: raw.response, conditioning };
  } catch {
    return null;
  }
}

function loadVialDetection(packId: string): VialHost.VialDetectionConfig | null {
  try {
    const raw = JSON.parse(localStorage.getItem(VIAL_DETECTION_KEY + packId) || 'null');
    if (!raw || typeof raw !== 'object' || !raw.perChannelLimits) return null;
    const perChannelLimits: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw.perChannelLimits)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        perChannelLimits[key] = value;
      }
    }
    return {
      enabled: raw.enabled !== false,
      alertThreshold: typeof raw.alertThreshold === 'number' ? raw.alertThreshold : 0.5,
      perChannelLimits,
    };
  } catch {
    return null;
  }
}

function loadVialTrajectory(packId: string): VialHost.TrajectoryPoint[] {
  try {
    const raw = JSON.parse(localStorage.getItem(VIAL_TRAJECTORY_KEY + packId) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p): p is VialHost.TrajectoryPoint => !!p && typeof p.at === 'number' && !!p.values)
      .slice(-VIAL_TRAJECTORY_MAX);
  } catch {
    return [];
  }
}

function loadVialTrajectorySpec(packId: string): { fields: string[]; intervalMs: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(VIAL_TRAJECTORY_SPEC_KEY + packId) || 'null');
    if (!raw || !Array.isArray(raw.fields)) return { fields: [], intervalMs: 10000 };
    return {
      fields: raw.fields.filter((f: unknown): f is string => typeof f === 'string').slice(0, 8),
      intervalMs: typeof raw.intervalMs === 'number' ? Math.max(1000, raw.intervalMs) : 10000,
    };
  } catch {
    return { fields: [], intervalMs: 10000 };
  }
}

function vialProgrammableState(pack: Domain.DomainPack): Pick<
  ActiveVialRuntime,
  'transforms' | 'detectionConfig' | 'trajectoryFields' | 'trajectoryIntervalMs' | 'trajectory' | 'lastTrajectoryAt'
> {
  const trajectory = loadVialTrajectory(pack.id);
  const spec = loadVialTrajectorySpec(pack.id);
  // A v2 profile is the program. Its transforms and detection settings are
  // compiled from the manifest, so a stale localStorage override cannot
  // silently change what the author declared.
  const profileTransforms = pack.anomaly
    ? {
        baseline: pack.anomaly.baseline.protocol,
        response: pack.anomaly.transforms.response,
        conditioning: pack.anomaly.transforms.conditioning,
        r0WindowS: pack.anomaly.baseline.r0WindowS,
      }
    : null;
  const profileDetection = pack.anomaly
    ? {
        enabled: pack.anomaly.detection.enabled,
        alertThreshold: pack.anomaly.detection.alertThreshold,
        perChannelLimits: pack.anomaly.detection.perChannelLimits,
      }
    : null;
  return {
    transforms: profileTransforms || loadVialTransforms(pack.id),
    detectionConfig: profileDetection || loadVialDetection(pack.id),
    trajectoryFields: spec.fields,
    trajectoryIntervalMs: spec.intervalMs,
    trajectory,
    lastTrajectoryAt: trajectory.length ? trajectory[trajectory.length - 1].at : 0,
  };
}

function mountVialRuntime(pack: Domain.DomainPack, uiHtml: string): void {
  const iframe = document.getElementById('vialRuntimeFrame') as HTMLIFrameElement | null;
  if (!iframe) return;
  destroyRuntime(activeVialRuntime, false);
  const sources = runtimeSourceOptions();
  const saved = localStorage.getItem(VIAL_SOURCE_KEY + pack.id);
  const preferred = saved && sources.some(s => s.id === saved) ? saved : '';
  // A live Vial starts on the live source even when it has no data yet. The
  // source picker lets a recording-oriented UI opt into a saved dataset.
  const source = preferred || 'live';
  const runtime: ActiveVialRuntime = {
    pack,
    nonce: VialRuntime.makeRuntimeNonce(),
    iframe,
    source,
    sources,
    recordingCache: new Map(),
    timer: null,
    ready: false,
    mount: 'workspace',
    destroyed: false,
    uiHtml,
    ...vialProgrammableState(pack),
  };
  activeVialRuntime = runtime;
  void syncVialDetector(pack);
  iframe.style.height = `${pack.ui?.height || 900}px`;
  iframe.srcdoc = VialRuntime.buildSandboxDocument(uiHtml, runtime.nonce, VialRuntime.resolveVialCapabilities(pack));
  iframe.addEventListener('load', () => {
    if (runtime.destroyed) return;
    runtime.ready = false;
    void sendVialData(runtime, true);
  }, { once: true });
  runtime.timer = window.setInterval(() => {
    if (runtime.destroyed || !runtime.ready || runtime.source !== 'live') return;
    const workspace = document.getElementById('domainWorkspace');
    if (!workspace || workspace.style.display === 'none') return;
    void sendVialData(runtime);
  }, 1200);
  document.getElementById('vialRuntimeReload')?.addEventListener('click', () => {
    if (runtime.destroyed) return;
    runtime.ready = false;
    runtime.recordingCache.clear();
    runtime.iframe.srcdoc = VialRuntime.buildSandboxDocument(uiHtml, runtime.nonce, VialRuntime.resolveVialCapabilities(runtime.pack));
    showToast('Vial UI reloaded from the same sandbox.');
  });
  document.getElementById('vialReportBtn')?.addEventListener('click', () => { void reportVialIssue(pack); });
}

// Home belongs to the instrument. A Vial with a home.html gets one compact
// line; taking over Home is an explicit, reversible act, not a permanent
// panel that squeezes the live traces.
function vialHomeBarHtml(pack: Domain.DomainPack): string {
  const sourceHref = domainSourceHref(pack);
  const sourceHost = domainSourceHost(sourceHref);
  return `<div class="vial-home-bar">
    <span class="vial-home-stage-title"><span class="vial-runtime-dot"></span>${escapeHtmlText(pack.name)}<span class="coord-tag">home/1</span></span>
    <span class="vial-home-bar-note">host-owned data · sandboxed UI · unsigned</span>
    <span class="vial-takeover-fill"></span>
    ${sourceHost ? `<a class="text-link" href="${escapeHtmlText(sourceHref)}" target="_blank" rel="noopener noreferrer">${escapeHtmlText(sourceHost)} ↗</a>` : ''}
    <button class="mini-btn" type="button" data-vial-action="open-workspace" data-vial-id="${escapeHtmlText(pack.id)}">Workspace</button>
    <button class="mini-btn primary" type="button" data-vial-action="takeover" data-vial-id="${escapeHtmlText(pack.id)}" title="Use this Vial as Home; exit any time to return to the instrument">Use as Home</button>
  </div>`;
}

function activateHomeTakeover(id: string): void {
  const pack = Domain.domainPackById(id);
  if (!pack?.homeUi) return;
  if (!resolveDomainUiHtml(pack, 'home')) {
    showToast('This Vial’s Home view is not cached. Reinstall it to fetch home.html.');
    return;
  }
  activateWorkspace('dashboard');
  homeTakeoverVialId = id;
  setSelectedHomeVialId(id);
  document.getElementById('vialTakeoverExit')?.focus();
}

function clearHomeTakeover(): void {
  homeTakeoverVialId = null;
  document.getElementById('panel-dashboard')?.classList.remove('vial-takeover');
  const shell = document.getElementById('vialTakeover');
  if (shell) shell.hidden = true;
  destroyHomeVialRuntime();
}

function exitHomeTakeover(notify = true): void {
  if (!homeTakeoverVialId) return;
  clearHomeTakeover();
  setSelectedHomeVialId('');
  if (notify) showToast('Home returned to the instrument.');
}

function updateVialHostTruth(runtime: ActiveVialRuntime | null): void {
  const snapshot = currentHostSnapshot(runtime);
  const fresh = connected && Date.now() - lastDataAt <= 3000;
  const replay = runtime?.source.startsWith('rec:') || false;
  const input = document.getElementById('vialHostInput');
  if (input) {
    input.textContent = replay ? 'Replay · inspection only'
      : fresh ? 'Live array'
      : connected ? 'Captured · link has no data'
      : historyData.some(channel => channel.length > 0) ? 'Captured buffer · no rig'
      : 'No input';
    input.className = `vial-host-value${fresh && !replay ? ' live' : ''}`;
    input.title = replay
      ? runtime?.sources.find(source => source.id === runtime.source)?.label || 'Saved recording'
      : '';
  }

  const rig = document.getElementById('vialHostRig');
  if (rig) {
    rig.textContent = fresh ? 'Live data'
      : connected ? 'No data'
      : 'No rig connected';
    rig.className = `vial-host-value${fresh ? ' live' : connected ? ' warning' : ''}`;
  }

  const baseline = document.getElementById('vialHostBaseline');
  if (baseline) {
    baseline.textContent = snapshot.baseline.state === 'warming'
      ? `Warming · ${Math.round(snapshot.baseline.progress * 100)}%`
      : snapshot.baseline.state === 'ready' && snapshot.baseline.ageSec !== null
        ? `Ready · ${snapshot.baseline.ageSec}s`
        : snapshot.baseline.state === 'ready'
          ? 'Ready'
          : snapshot.baseline.state === 'stale'
            ? 'Stale'
            : 'Not ready';
    baseline.className = `vial-host-value${snapshot.baseline.state === 'warming' || snapshot.baseline.state === 'stale' ? ' warning' : ''}`;
  }

  const change = document.getElementById('vialHostChange');
  if (change) {
    change.textContent = replay ? 'Not evaluated on replay'
      : !fresh || snapshot.anomaly.state === 'unknown' ? 'Not evaluated'
      : snapshot.anomaly.state === 'normal' ? 'No change detected'
      : snapshot.anomaly.state === 'warning' ? `Change warning · ${snapshot.anomaly.triggeredChannels} channels`
      : `Critical change · ${snapshot.anomaly.triggeredChannels} channels`;
    change.className = `vial-host-value${!replay && fresh && snapshot.anomaly.state === 'warning' ? ' warning' : ''}${!replay && fresh && snapshot.anomaly.state === 'critical' ? ' critical' : ''}`;
  }
}

function renderHomeTakeover(pack: Domain.DomainPack, homeHtml: string): void {
  const panel = document.getElementById('panel-dashboard');
  const shell = document.getElementById('vialTakeover');
  if (!panel || !shell) return;
  panel.classList.add('vial-takeover');
  shell.hidden = false;
  updateVialHostTruth(homeVialRuntime?.pack.id === pack.id ? homeVialRuntime : null);

  const name = document.getElementById('vialTakeoverName');
  if (name) name.textContent = pack.name;
  const tag = document.getElementById('vialTakeoverTag');
  if (tag) tag.textContent = `v${pack.version} · home/1`;

  const source = document.getElementById('vialTakeoverSource') as HTMLAnchorElement | null;
  const href = domainSourceHref(pack);
  if (source) {
    if (href) {
      source.href = href;
      source.textContent = `${domainSourceHost(href)} ↗`;
      source.hidden = false;
    } else {
      source.hidden = true;
    }
  }

  const exit = document.getElementById('vialTakeoverExit');
  if (exit) exit.onclick = () => exitHomeTakeover();
  const workspace = document.getElementById('vialTakeoverWorkspace');
  if (workspace) workspace.onclick = () => {
    showWorkspaceView('vials');
    openDomainWorkspace(pack.id);
  };

  if (
    homeVialRuntime
    && !homeVialRuntime.destroyed
    && homeVialRuntime.pack.id === pack.id
    && homeVialRuntime.pack.version === pack.version
    && homeVialRuntime.uiHtml === homeHtml
    && homeVialRuntime.iframe.isConnected
  ) {
    void sendVialData(homeVialRuntime, true);
    return;
  }
  destroyHomeVialRuntime();
  mountHomeVialRuntime(pack, homeHtml, 'vialTakeoverFrame');
}

function mountHomeVialRuntime(pack: Domain.DomainPack, uiHtml: string, frameId: string): void {
  const iframe = document.getElementById(frameId) as HTMLIFrameElement | null;
  if (!iframe) return;
  destroyRuntime(homeVialRuntime, false);
  const sources = runtimeSourceOptions();
  const saved = localStorage.getItem(VIAL_SOURCE_KEY + pack.id);
  const preferred = saved && sources.some(s => s.id === saved) ? saved : '';
  const source = preferred || 'live';
  const runtime: ActiveVialRuntime = {
    pack,
    nonce: VialRuntime.makeRuntimeNonce(),
    iframe,
    source,
    sources,
    recordingCache: new Map(),
    timer: null,
    ready: false,
    mount: 'home',
    destroyed: false,
    uiHtml,
    ...vialProgrammableState(pack),
  };
  homeVialRuntime = runtime;
  void syncVialDetector(pack);
  iframe.srcdoc = VialRuntime.buildSandboxDocument(uiHtml, runtime.nonce, VialRuntime.resolveVialCapabilities(pack));
  iframe.addEventListener('load', () => {
    if (runtime.destroyed) return;
    runtime.ready = false;
    // The sandbox bridge owns the host object. No module import, eval, or
    // same-origin access is needed; data arrives over the nonce-checked
    // postMessage channel and the SDK stays available on every payload.
    void sendVialData(runtime, true);
  }, { once: true });
  runtime.timer = window.setInterval(() => {
    if (runtime.destroyed || !runtime.ready) return;
    if (iframe.offsetParent === null) return;
    if (runtime.mount === 'home') updateVialHostTruth(runtime);
    if (runtime.source === 'live') void sendVialData(runtime);
  }, 1200);
}

const VIAL_JOURNAL_KEY = 'osmograph.vial.journal.';
const VIAL_PERSIST_KEY = 'osmograph.vial.persist.';

/** Journal reads prefer the disk copy; localStorage is the browser/mock
 *  fallback so the same UI runs in the harness and on a real install. */
async function vialJournalEvents(vialId: string, limit = 2000): Promise<unknown[]> {
  try {
    const events = await invoke<unknown[]>('vial_get_journal', { vialId, limit });
    if (Array.isArray(events)) return events;
  } catch { /* fall through */ }
  try {
    const raw = localStorage.getItem(VIAL_JOURNAL_KEY + vialId);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(-limit) : [];
  } catch {
    return [];
  }
}

async function vialJournalLog(vialId: string, event: unknown): Promise<void> {
  try {
    const raw = localStorage.getItem(VIAL_JOURNAL_KEY + vialId);
    const parsed = raw ? JSON.parse(raw) : [];
    const next = (Array.isArray(parsed) ? parsed : []).concat([event]).slice(-2000);
    localStorage.setItem(VIAL_JOURNAL_KEY + vialId, JSON.stringify(next));
  } catch { /* storage full: disk may still accept it */ }
  try {
    await invoke('vial_log_event', { vialId, event });
  } catch { /* mock/browser: localStorage remains the fallback */ }
}

async function vialJournalClear(vialId: string): Promise<void> {
  try { localStorage.removeItem(VIAL_JOURNAL_KEY + vialId); } catch { /* ignore */ }
  try { await invoke('vial_clear_journal', { vialId }); } catch { /* ignore */ }
}

async function vialJournalExport(vialId: string, format: 'json' | 'csv'): Promise<string> {
  try {
    return await invoke<string>('vial_export_journal', { vialId, format });
  } catch {
    const events = await vialJournalEvents(vialId, 5000);
    if (format === 'csv') {
      const cell = (value: unknown) => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
      const rows = ['id,type,message,timestamp,data'];
      for (const raw of events) {
        const event = raw as Record<string, unknown>;
        rows.push([
          cell(event.id), cell(event.type), cell(event.message), cell(event.timestamp),
          cell(JSON.stringify(event.data ?? null)),
        ].join(','));
      }
      return rows.join('\n');
    }
    return JSON.stringify(events, null, 2);
  }
}

function vialPersistGet(vialId: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(VIAL_PERSIST_KEY + vialId);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function vialPersistSet(vialId: string, key: string, value: unknown): void {
  const data = vialPersistGet(vialId);
  data[key] = value;
  localStorage.setItem(VIAL_PERSIST_KEY + vialId, JSON.stringify(data));
}

async function handleVialHostRequest(runtime: ActiveVialRuntime, action: Extract<VialRuntime.VialAction, { type: 'host-request' }>): Promise<void> {
  const caps = VialRuntime.resolveVialCapabilities(runtime.pack);
  const reply = (ok: boolean, result?: unknown, error?: string) => {
    runtime.iframe.contentWindow?.postMessage(
      { vialHostResponse: true, requestId: action.requestId, ok, result: ok ? result ?? null : undefined, error },
      '*',
    );
  };
  try {
    if (action.request === 'persist' || action.request === 'retrieve') {
      if (!caps.persist) throw new Error('Vial does not declare write:persist.');
      if (action.request === 'persist') {
        vialPersistSet(runtime.pack.id, action.key!, action.value);
        reply(true, null);
      } else {
        reply(true, vialPersistGet(runtime.pack.id)[action.key!] ?? null);
      }
      return;
    }
    if (!caps.requestAction) throw new Error('Vial does not declare action:request.');
    switch (action.action) {
      case 'get-source':
        reply(true, runtime.source);
        break;
      case 'get-sources':
        reply(true, runtime.sources);
        break;
      case 'open-dashboard':
        showWorkspaceView('dashboard');
        reply(true, null);
        break;
      case 'open-datasets':
        showWorkspaceView('datasets');
        reply(true, null);
        break;
      case 'open-smells':
      case 'open-gallery':
        showWorkspaceView('smells');
        reply(true, null);
        break;
      case 'open-vials':
        showWorkspaceView('vials');
        reply(true, null);
        break;
      case 'open-workspace':
        openDomainWorkspace(runtime.pack.id);
        reply(true, null);
        break;
      case 'export-log':
        exportVialLog(runtime.pack);
        reply(true, null);
        break;
      case 'toast':
        showToast(String((action.params as { message?: string } | null)?.message || 'Vial message.'));
        reply(true, null);
        break;
      case 'journal-events':
        reply(true, await vialJournalEvents(runtime.pack.id, 2000));
        break;
      case 'journal-export': {
        const format = (action.params as { format?: string } | null)?.format === 'csv' ? 'csv' : 'json';
        reply(true, await vialJournalExport(runtime.pack.id, format));
        break;
      }
      case 'journal-download': {
        const format = (action.params as { format?: string } | null)?.format === 'csv' ? 'csv' : 'json';
        const text = await vialJournalExport(runtime.pack.id, format);
        const blob = new Blob([text], { type: format === 'csv' ? 'text/csv' : 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${runtime.pack.id.replace(/[^a-z0-9._-]+/gi, '-')}-journal.${format}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        reply(true, null);
        break;
      }
      default:
        throw new Error(`Unsupported vial action: ${action.action}`);
    }
  } catch (e) {
    reply(false, undefined, e instanceof Error ? e.message : String(e));
  }
}

function exportVialLog(pack: Domain.DomainPack): void {
  const state = activeDomainState && activeDomainState.packId === pack.id
    ? activeDomainState
    : Domain.loadDomainState(pack.id);
  const body = JSON.stringify({
    schema: 'osmograph.vial-log/1',
    vialId: pack.id,
    vialVersion: pack.version,
    exportedAt: new Date().toISOString(),
    fields: state.fields,
    checks: state.checks,
    logs: state.logs,
  }, null, 2);
  const blob = new Blob([body], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${pack.id}.log.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('Vial log exported. The portable record is the point.');
}

function refreshVialRuntimes(packId: string): void {
  for (const runtime of [activeVialRuntime, homeVialRuntime]) {
    if (runtime && runtime.pack.id === packId) void sendVialData(runtime, true);
  }
}

function handleVialAction(runtime: ActiveVialRuntime, action: VialRuntime.VialAction): void {
  const state = activeDomainState && activeDomainState.packId === runtime.pack.id
    ? activeDomainState
    : Domain.loadDomainState(runtime.pack.id);
  switch (action.type) {
    case 'ready':
      runtime.ready = true;
      void sendVialData(runtime, true);
      break;
    case 'toast':
      showToast(action.message || 'Vial message.');
      break;
    case 'resize':
      runtime.iframe.style.height = runtime.mount === 'home'
        ? `${Math.max(320, Math.min(620, action.height))}px`
        : `${Math.max(420, Math.min(2000, action.height))}px`;
      break;
    case 'save-field': {
      const next = { ...state, fields: { ...state.fields, [action.key]: action.value } };
      Domain.saveDomainState(next);
      activeDomainState = next;
      refreshVialRuntimes(runtime.pack.id);
      break;
    }
    case 'add-log': {
      const next = Domain.addDomainLog(state, action.values);
      Domain.saveDomainState(next);
      activeDomainState = next;
      refreshVialRuntimes(runtime.pack.id);
      showToast('Reading added to the local log.');
      break;
    }
    case 'remove-log': {
      const next = Domain.removeDomainLog(state, action.id);
      Domain.saveDomainState(next);
      activeDomainState = next;
      refreshVialRuntimes(runtime.pack.id);
      break;
    }
    case 'host-request':
      void handleVialHostRequest(runtime, action);
      break;
    case 'journal-log':
      void vialJournalLog(runtime.pack.id, action.event);
      break;
    case 'journal-clear':
      void vialJournalClear(runtime.pack.id);
      break;
    case 'export-log':
      exportVialLog(runtime.pack);
      break;
    case 'open-workspace':
      showWorkspaceView('vials');
      openDomainWorkspace(runtime.pack.id);
      break;
    case 'open-dashboard':
      openDomainDashboard();
      break;
    case 'open-datasets':
      closeDomainWorkspace();
      showWorkspaceView('datasets');
      break;
    case 'open-check':
      openDomainCheck();
      break;
    case 'open-vials':
      closeDomainWorkspace();
      break;
    case 'set-source': {
      if (!runtime.sources.some(s => s.id === action.source)) return;
      runtime.source = action.source;
      localStorage.setItem(VIAL_SOURCE_KEY + runtime.pack.id, action.source);
      for (const other of [activeVialRuntime, homeVialRuntime]) {
        if (other && other.pack.id === runtime.pack.id) {
          other.source = action.source;
          void sendVialData(other, true);
        }
      }
      break;
    }
    case 'set-detection': {
      if (runtime.pack.anomaly) {
        showToast('This Vial’s detection profile is compiled from its manifest. Update the Vial to change it.');
        return;
      }
      const snapshot = currentHostSnapshot(runtime);
      if (snapshot.source !== 'live') {
        showToast('Detection is only configurable on a live rig.');
        return;
      }
      const channelIds = new Set(snapshot.channels.map(c => c.id));
      const declared = Object.keys(action.perChannelLimits);
      if (!declared.length) {
        showToast('Declare at least one per-channel limit.');
        return;
      }
      const unknown = declared.filter(id => !channelIds.has(id));
      if (unknown.length) {
        showToast(`Unknown channel: ${unknown.join(', ')}.`);
        return;
      }
      const dead = declared.filter(id => snapshot.channelLimits[id]?.dead);
      if (dead.length) {
        showToast(`${dead.join(', ')} ${dead.length === 1 ? 'is' : 'are'} silent on this rig — no limit can be supported there.`);
        return;
      }
      if (!snapshot.channels.some(c => !snapshot.channelLimits[c.id]?.dead)) {
        showToast('All channels are silent or dead; detection stays off.');
        return;
      }
      runtime.detectionConfig = action;
      localStorage.setItem(VIAL_DETECTION_KEY + runtime.pack.id, JSON.stringify(action));
      showToast(snapshot.baseline.state === 'ready'
        ? 'Detection accepted for this rig.'
        : 'Detection saved. It applies when the baseline is ready.');
      refreshVialRuntimes(runtime.pack.id);
      break;
    }
    case 'set-transforms': {
      if (runtime.pack.anomaly) {
        showToast('This Vial’s transforms are declared in its manifest. Update the Vial to change them.');
        return;
      }
      const baseline = action.baseline as VialRuntime.VialBaseline;
      const response = action.response as VialRuntime.VialResponse;
      if (!VialRuntime.VIAL_BASELINES.includes(baseline)
        || !VialRuntime.VIAL_RESPONSES.includes(response)) {
        showToast('Unsupported transform. Host supports first-n/session-mean baseline and delta-over-r0/relative/delta response.');
        return;
      }
      const conditioning = action.conditioning.filter(c => c === 'median3');
      runtime.transforms = { baseline, response, conditioning };
      localStorage.setItem(VIAL_TRANSFORMS_KEY + runtime.pack.id, JSON.stringify(runtime.transforms));
      showToast(`Transforms accepted: ${baseline} → ${response}${conditioning.length ? ` · ${conditioning.join(', ')}` : ''}.`);
      refreshVialRuntimes(runtime.pack.id);
      break;
    }
    case 'set-trajectory': {
      const fields = resolveTrajectoryFields(action.fields);
      if (!fields.length) {
        showToast('No trackable fields. Use ch0…chN, anomaly.score, anomaly.confidence, baseline.progress, env.temperature, env.humidity.');
        return;
      }
      const intervalMs = Math.max(1000, Math.min(600000, action.intervalMs));
      runtime.trajectoryFields = fields;
      runtime.trajectoryIntervalMs = intervalMs;
      localStorage.setItem(VIAL_TRAJECTORY_SPEC_KEY + runtime.pack.id, JSON.stringify({ fields, intervalMs }));
      showToast(`Tracking ${fields.length} field(s) every ${Math.round(intervalMs / 1000)}s.`);
      refreshVialRuntimes(runtime.pack.id);
      break;
    }
  }
}

window.addEventListener('message', (event) => {
  const runtime = [activeVialRuntime, homeVialRuntime].find(
    candidate => !!candidate && event.source === candidate.iframe.contentWindow,
  );
  if (!runtime) return;
  const envelope = VialRuntime.parseVialActionEnvelope(event.data);
  if (!envelope || envelope.nonce !== runtime.nonce) return;
  handleVialAction(runtime, envelope.vialAction);
});

function renderDomainWorkspace(pack: Domain.DomainPack): void {
  const body = document.getElementById('domainWorkspaceBody');
  const meta = document.getElementById('domainWorkspaceMeta');
  const jumpBar = document.getElementById('domainJumpBar');
  const state = activeDomainState || Domain.loadDomainState(pack.id);
  activeDomainState = state;
  const origin = pack.sourceUrl ? 'Author-hosted' : 'Local';
  if (meta) {
    const gate = Domain.validateDomainPack(pack, true);
    const gateStatus = pack.schema === 'osmograph.domain-pack/2'
      ? (gate.gated ? 'Gated' : 'Ungated · add a fixture')
      : 'legacy · Ungated';
    meta.innerHTML = `${escapeHtmlText(origin)} · v${escapeHtmlText(pack.version)} · ${escapeHtmlText(pack.license)} · ${gateStatus}${escapeHtmlText(domainSourceLabel(pack))} · log local-only <button class="text-link" type="button" data-domain-export="${escapeHtmlText(pack.id)}">Export manifest</button> <button class="text-link" type="button" data-guide-open="domain">Policy gate</button>`;
  }
  const uiHtml = resolveDomainUiHtml(pack);
  if (pack.ui && !uiHtml && meta) {
    meta.innerHTML += ' · <span class="domain-ui-missing">UI asset unavailable · declarative fallback</span>';
  }
  if (uiHtml) {
    if (jumpBar) { jumpBar.hidden = true; jumpBar.innerHTML = ''; }
    if (!body) return;
    if (activeVialRuntime?.pack.id === pack.id && activeVialRuntime.pack.version === pack.version) {
      void sendVialData(activeVialRuntime, true);
      return;
    }
    body.innerHTML = vialRuntimeShellHtml(pack);
    mountVialRuntime(pack, uiHtml);
    return;
  }
  if (jumpBar) jumpBar.hidden = false;
  const present = new Set<string>(pack.widgets.map(w => w.type));
  if (jumpBar) {
    jumpBar.innerHTML = DOMAIN_JUMP_ORDER
      .filter(type => present.has(type))
      .map((type, index) => `<button class="domain-jump" type="button" data-domain-jump="${type}"><span>${String(index + 1).padStart(2, '0')}</span>${escapeHtmlText(DOMAIN_SECTION_LABEL[type] || type)}</button>`)
      .join('');
    jumpBar.scrollLeft = 0;
  }
  if (!body) return;
  const top = pack.widgets.filter(w => DOMAIN_TOP_TYPES.has(w.type));
  const left = pack.widgets.filter(w => DOMAIN_LEFT_TYPES.has(w.type));
  const right = pack.widgets.filter(w => DOMAIN_RIGHT_TYPES.has(w.type));
  const bottom = pack.widgets.filter(w => !DOMAIN_TOP_TYPES.has(w.type) && !DOMAIN_LEFT_TYPES.has(w.type) && !DOMAIN_RIGHT_TYPES.has(w.type));
  body.innerHTML = `
    ${top.length ? `<div class="domain-full">${top.map(w => domainSectionHtml(w, pack, state)).join('')}</div>` : ''}
    ${left.length || right.length ? `<div class="domain-columns"><div class="domain-col">${left.map(w => domainSectionHtml(w, pack, state)).join('')}</div><div class="domain-col">${right.map(w => domainSectionHtml(w, pack, state)).join('')}</div></div>` : ''}
    ${bottom.length ? `<div class="domain-full">${bottom.map(w => domainSectionHtml(w, pack, state)).join('')}</div>` : ''}`;
  window.requestAnimationFrame(updateDomainJumpActive);
}

function openDomainWorkspace(id: string): void {
  const pack = Domain.domainPackById(id);
  if (!pack) return;
  if (activeVialRuntime && activeVialRuntime.pack.id !== id) destroyVialRuntime();
  activeDomainPackId = id;
  activeDomainState = Domain.loadDomainState(id);
  activeDomainHotspot = null;
  const main = document.getElementById('vialsMain');
  const ws = document.getElementById('domainWorkspace');
  if (main) main.style.display = 'none';
  if (ws) ws.style.display = 'flex';
  renderDomainWorkspace(pack);
  if (ws) ws.scrollTop = 0;
}

function closeDomainWorkspace(): void {
  destroyVialRuntime();
  const main = document.getElementById('vialsMain');
  const ws = document.getElementById('domainWorkspace');
  if (ws) ws.style.display = 'none';
  if (main) main.style.display = '';
  activeDomainPackId = null;
  activeDomainState = null;
  activeDomainHotspot = null;
  renderVials();
}

async function installDomainVial(id: string): Promise<void> {
  const pack = Domain.domainPackById(id);
  if (!pack) return;
  Domain.installDomainPack(id);
  renderVials();
  renderVialHome();
  openDomainWorkspace(id);
  showToast(pack.ui
    ? `Installed ${pack.name}. Its unsigned UI runs in the sandbox; the log stays local.`
    : `Installed ${pack.name}. Your log stays on this machine.`);
}

function openDomainDocs(id: string): void {
  openDomainWorkspace(id);
  window.setTimeout(() => document.getElementById('domainDocs')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
}

function armOrRemoveDomainVial(id: string, button: HTMLButtonElement): void {
  if (domainRemoveArm?.id === id) {
    window.clearTimeout(domainRemoveArm.timer);
    domainRemoveArm = null;
    Domain.uninstallDomainPack(id);
    if (selectedHomeVialId() === id) {
      clearHomeTakeover();
      setSelectedHomeVialId('');
    }
    if (activeDomainPackId === id) closeDomainWorkspace();
    else renderVials();
    renderVialHome();
    showToast('Domain Vial removed. Its local log is kept until you clear site data.');
    return;
  }
  if (domainRemoveArm) {
    window.clearTimeout(domainRemoveArm.timer);
    domainRemoveArm.button.textContent = 'Remove';
  }
  button.textContent = 'Confirm';
  const timer = window.setTimeout(() => {
    if (domainRemoveArm?.id === id) {
      domainRemoveArm = null;
      button.textContent = 'Remove';
    }
  }, 2500);
  domainRemoveArm = { id, timer, button };
}

function armOrDeleteDomainPack(id: string, button: HTMLButtonElement): void {
  if (domainPackDeleteArm?.id === id) {
    window.clearTimeout(domainPackDeleteArm.timer);
    domainPackDeleteArm = null;
    Domain.uninstallDomainPack(id);
    Domain.deleteCustomPack(id);
    Domain.deleteDomainState(id);
    Domain.clearDomainUi(id);
    localStorage.removeItem(`osmograph.vial.source.${id}`);
    if (selectedHomeVialId() === id) {
      clearHomeTakeover();
      setSelectedHomeVialId('');
    }
    if (activeDomainPackId === id) closeDomainWorkspace();
    else renderVials();
    renderVialHome();
    showToast('Vial deleted, including its local log.');
    return;
  }
  if (domainPackDeleteArm) {
    window.clearTimeout(domainPackDeleteArm.timer);
    domainPackDeleteArm.button.textContent = 'Delete';
  }
  button.textContent = 'Confirm';
  const timer = window.setTimeout(() => {
    if (domainPackDeleteArm?.id === id) {
      domainPackDeleteArm = null;
      button.textContent = 'Delete';
    }
  }, 2500);
  domainPackDeleteArm = { id, timer, button };
}

function selectDomainHotspot(id: string): void {
  const pack = activeDomainPackId ? Domain.domainPackById(activeDomainPackId) : null;
  if (!pack) return;
  activeDomainHotspot = id;
  document.querySelectorAll<HTMLElement>('#domainWorkspaceBody .domain-hotspot').forEach(el => {
    el.classList.toggle('active', el.dataset.domainHotspot === id);
  });
  const info = document.getElementById('domainHotspotInfo');
  if (info) info.innerHTML = domainHotspotInfo(pack, id);
}

function addDomainLogFromForm(): void {
  if (!activeDomainState || !activeDomainPackId) return;
  const fields = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#domainWorkspaceBody [data-domain-log-field]')];
  const values: Record<string, string> = {};
  for (const field of fields) {
    const key = field.dataset.domainLogField;
    if (key && field.value.trim()) values[key] = field.value.trim();
  }
  if (!Object.keys(values).length) {
    showToast('Add at least one value to the reading.');
    return;
  }
  activeDomainState = Domain.addDomainLog(activeDomainState, values);
  Domain.saveDomainState(activeDomainState);
  const pack = Domain.domainPackById(activeDomainPackId);
  if (pack) renderDomainWorkspace(pack);
  showToast('Reading added to the local log.');
}

function openDomainCheck(): void {
  closeDomainWorkspace();
  showWorkspaceView('check');
}

function openDomainDashboard(): void {
  closeDomainWorkspace();
  (document.querySelector('.tab-btn[data-tab="dashboard"]') as HTMLElement | null)?.click();
}

// === Field guide + command palette ===
let activeGuideId = GUIDE_SECTIONS[0]?.id || 'start';
let guideQuery = '';

function openGuide(id?: string): void {
  if (id && guideSection(id)) activeGuideId = id;
  const overlay = document.getElementById('guideOverlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  guideQuery = '';
  const search = document.getElementById('guideSearch') as HTMLInputElement | null;
  if (search) search.value = '';
  renderGuide();
}

function closeGuide(): void {
  const overlay = document.getElementById('guideOverlay');
  if (overlay) overlay.style.display = 'none';
}

function filteredGuideSections(): typeof GUIDE_SECTIONS {
  const q = guideQuery.trim().toLowerCase();
  if (!q) return GUIDE_SECTIONS;
  return GUIDE_SECTIONS.filter(section => {
    const haystack = [section.title, section.summary, ...section.paragraphs, ...(section.bullets || [])].join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

function renderGuide(): void {
  const sections = filteredGuideSections();
  const nav = document.getElementById('guideNav');
  const content = document.getElementById('guideContent');
  const count = document.getElementById('guideCount');
  if (count) count.textContent = `${sections.length} section${sections.length === 1 ? '' : 's'}`;
  if (!sections.some(s => s.id === activeGuideId) && sections[0]) activeGuideId = sections[0].id;
  if (nav) {
    const groups: Array<{ group: string; items: typeof GUIDE_SECTIONS }> = [];
    for (const section of sections) {
      let group = groups.find(g => g.group === section.group);
      if (!group) { group = { group: section.group, items: [] }; groups.push(group); }
      group.items.push(section);
    }
    nav.innerHTML = groups.length
      ? groups.map(group => `<div class="guide-nav-group">${escapeHtmlText(group.group)}</div>${group.items.map(section => `<button class="guide-nav-btn ${section.id === activeGuideId ? 'active' : ''}" type="button" data-guide-id="${escapeHtmlText(section.id)}">${escapeHtmlText(section.title)}</button>`).join('')}`).join('')
      : '<div class="guide-empty">No section matches that search.</div>';
  }
  if (!content) return;
  const section = guideSection(activeGuideId);
  if (!section) {
    content.innerHTML = '<div class="guide-empty">No section selected.</div>';
    return;
  }
  content.innerHTML = `<div class="coord-tag">${escapeHtmlText(section.group)} · ${escapeHtmlText(section.id)}</div>
    <h2>${escapeHtmlText(section.title)}</h2>
    <p class="guide-summary">${escapeHtmlText(section.summary)}</p>
    ${section.paragraphs.map(p => `<p class="guide-p">${escapeHtmlText(p)}</p>`).join('')}
    ${section.bullets?.length ? `<ul class="guide-list">${section.bullets.map(b => `<li>${escapeHtmlText(b)}</li>`).join('')}</ul>` : ''}`;
}

function activateTab(tab: string): void {
  (document.querySelector(`.tab-btn[data-tab="${tab}"]`) as HTMLElement | null)?.click();
}

function activateSmellsView(src: string): void {
  showWorkspaceView(src);
}

interface CommandAction {
  id: string;
  group: string;
  title: string;
  hint: string;
  run: () => void;
}

const COMMANDS: CommandAction[] = [
  { id: 'dashboard', group: 'Go', title: 'Home', hint: 'live rig', run: () => activateTab('dashboard') },
  { id: 'gallery', group: 'Go', title: 'Explore → Gallery', hint: 'browse fingerprints', run: () => activateSmellsView('smells') },
  { id: 'check', group: 'Go', title: 'Analyse → Separability', hint: 'which classes can this array tell apart?', run: () => activateSmellsView('check') },
  { id: 'compare', group: 'Go', title: 'Analyse → Compare', hint: 'overlay saved recordings', run: () => activateSmellsView('compare') },
  { id: 'recipes', group: 'Go', title: 'Analyse → Transforms', hint: 'trim, normalize, export a derived recording', run: () => activateSmellsView('recipes') },
  { id: 'vials', group: 'Go', title: 'Vials', hint: 'domain workspaces', run: () => activateSmellsView('vials') },
  { id: 'aromatory', group: 'Go', title: 'Vials → Aromatory', hint: 'install a domain Vial', run: () => { activateSmellsView('vials'); setVialsTab('aromatory'); window.setTimeout(() => document.getElementById('domainCatalog')?.scrollIntoView({ block: 'start' }), 80); } },
  { id: 'sessions', group: 'Go', title: 'Explore → Recordings', hint: 'import, inspect, replay, trim', run: () => activateSmellsView('sessions') },
  { id: 'playground', group: 'Go', title: 'Playground', hint: 'replay a real recording, no rig needed', run: () => { void openPlayground(); } },
  { id: 'datasets', group: 'Go', title: 'Explore → Datasets', hint: 'download a public corpus', run: () => activateSmellsView('datasets') },
  { id: 'train', group: 'Go', title: 'Analyse → Train', hint: 'teach this array', run: () => activateSmellsView('train') },
  { id: 'changelog', group: 'Go', title: 'Analyse → Events', hint: 'anomaly history from this device', run: () => activateSmellsView('changelog') },
  { id: 'fleet', group: 'Go', title: 'Rigs → Fleet', hint: 'multiple rigs', run: () => activateSmellsView('fleet') },
  { id: 'system', group: 'Go', title: 'Settings', hint: 'hardware, calibration, release', run: () => activateSmellsView('system') },
  { id: 'import-domain', group: 'Vials', title: 'Import a domain Vial', hint: '.vial.json', run: () => (document.getElementById('domainImportFile') as HTMLInputElement | null)?.click() },
  { id: 'install-domain-url', group: 'Vials', title: 'Install a Vial from URL', hint: 'raw GitHub vial.json', run: () => { activateSmellsView('vials'); setVialsTab('aromatory'); showDomainUrlBar(); } },
  { id: 'template', group: 'Vials', title: 'Download starter domain Vial', hint: 'authoring template', run: () => downloadDomainTemplate() },
  { id: 'guide-start', group: 'Guide', title: 'Field guide: Start here', hint: 'scope', run: () => openGuide('start') },
  { id: 'guide-check', group: 'Guide', title: 'Field guide: How Separability works', hint: 'method', run: () => openGuide('check') },
  { id: 'guide-vials', group: 'Guide', title: 'Field guide: Vial validation', hint: 'gate + limits', run: () => openGuide('vials') },
  { id: 'guide-domain', group: 'Guide', title: 'Field guide: Domain Vials', hint: 'policy + limits', run: () => openGuide('domain') },
  { id: 'guide-authoring', group: 'Guide', title: 'Field guide: Authoring a domain Vial', hint: 'schema + gate', run: () => openGuide('authoring') },
  { id: 'guide-data', group: 'Guide', title: 'Field guide: Data provenance', hint: 'licences', run: () => openGuide('data') },
  { id: 'guide-limits', group: 'Guide', title: 'Field guide: Known limits', hint: 'refusals', run: () => openGuide('limits') },
  // Do: real verbs, not navigation. Each respects the same guards the clicked
  // button has (streaming checks, selections) — the palette must not become a
  // shortcut around the refusals.
  { id: 'do-connect', group: 'Do', title: 'Connect / disconnect the rig', hint: 'uses the selected port + baud', run: () => { activateTab('dashboard'); void toggleConnection(); } },
  { id: 'do-record', group: 'Do', title: 'Record an exposure', hint: 'baseline → exposure → recovery', run: () => { activateTab('dashboard'); openRecordModal(); } },
  { id: 'do-stop-record', group: 'Do', title: 'Stop & save the recording', hint: 'finishes early, still saves', run: () => { if (recPhaseActive) void stopPhaseRecordingFromUI(); else showToast('No recording in progress.'); } },
  { id: 'do-check', group: 'Do', title: 'Run a separability check', hint: 'reference vs sample, same array', run: () => { activateSmellsView('check'); void runCheck(); } },
  { id: 'do-clear', group: 'Do', title: 'Clear the live view', hint: 'empty the buffers', run: () => { activateTab('dashboard'); clearLiveView(); } },
  { id: 'do-burnin', group: 'Do', title: 'Start a burn-in check', hint: 'long-run rig health', run: () => { activateSmellsView('fleet'); void invoke('burnin_start', { hours: null }).then((s) => { const st = s as { running?: boolean; total_hours?: number }; showToast(st.running ? `Burn-in running — target ${st.total_hours || 0} h. Fleet tab shows the countdown.` : 'Burn-in is already complete.'); }).catch((e) => showToast(String(e).replace(/Error invoking remote method '.*': /, ''))); } },
];

let commandActive = 0;
let commandResults = COMMANDS;

function openCommandPalette(): void {
  const overlay = document.getElementById('commandOverlay');
  const input = document.getElementById('commandInput') as HTMLInputElement | null;
  if (!overlay) return;
  overlay.style.display = 'flex';
  commandActive = 0;
  if (input) { input.value = ''; window.setTimeout(() => input.focus(), 20); }
  renderCommands('');
}

function closeCommandPalette(): void {
  const overlay = document.getElementById('commandOverlay');
  if (overlay) overlay.style.display = 'none';
}

function renderCommands(query: string): void {
  const q = query.trim().toLowerCase();
  commandResults = COMMANDS.filter(c => [c.title, c.hint, c.group].join(' ').toLowerCase().includes(q));
  commandActive = Math.min(commandActive, Math.max(0, commandResults.length - 1));
  const list = document.getElementById('commandList');
  if (!list) return;
  list.innerHTML = commandResults.length
    ? commandResults.map((c, i) => `<button class="command-item ${i === commandActive ? 'active' : ''}" type="button" data-command-id="${escapeHtmlText(c.id)}"><span class="cmd-group">${escapeHtmlText(c.group)}</span><span class="cmd-title">${escapeHtmlText(c.title)}</span><span class="cmd-hint">${escapeHtmlText(c.hint)}</span></button>`).join('')
    : '<div class="guide-empty">No command matches that.</div>';
}

function runCommand(id: string): void {
  const command = COMMANDS.find(c => c.id === id);
  if (!command) return;
  closeCommandPalette();
  command.run();
}

document.getElementById('guideBtn')?.addEventListener('click', () => openGuide());
document.getElementById('guideClose')?.addEventListener('click', closeGuide);
document.getElementById('guideSearch')?.addEventListener('input', (ev) => {
  guideQuery = (ev.target as HTMLInputElement).value;
  renderGuide();
});
document.getElementById('guideNav')?.addEventListener('click', (ev) => {
  const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-guide-id]');
  if (!target?.dataset.guideId) return;
  activeGuideId = target.dataset.guideId;
  renderGuide();
});
document.querySelectorAll('[data-guide-close]').forEach(el => el.addEventListener('click', closeGuide));
document.addEventListener('click', (ev) => {
  const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-guide-open]');
  if (target?.dataset.guideOpen) openGuide(target.dataset.guideOpen);
});
document.getElementById('commandBtn')?.addEventListener('click', openCommandPalette);
document.querySelectorAll('[data-command-close]').forEach(el => el.addEventListener('click', closeCommandPalette));
document.getElementById('commandInput')?.addEventListener('input', (ev) => {
  commandActive = 0;
  renderCommands((ev.target as HTMLInputElement).value);
});
document.getElementById('commandList')?.addEventListener('click', (ev) => {
  const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-command-id]');
  if (target?.dataset.commandId) runCommand(target.dataset.commandId);
});
document.addEventListener('keydown', (ev) => {
  const commandOverlay = document.getElementById('commandOverlay');
  const commandOpen = commandOverlay?.style.display !== 'none';
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
    ev.preventDefault();
    if (commandOpen) closeCommandPalette();
    else openCommandPalette();
    return;
  }
  if (ev.key === 'Escape') {
    closeCommandPalette();
    closeGuide();
    if (homeTakeoverVialId) {
      ev.preventDefault();
      exitHomeTakeover();
    }
    return;
  }
  if (!commandOpen) return;
  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    commandActive = Math.min(commandActive + 1, Math.max(0, commandResults.length - 1));
    renderCommands((document.getElementById('commandInput') as HTMLInputElement | null)?.value || '');
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    commandActive = Math.max(0, commandActive - 1);
    renderCommands((document.getElementById('commandInput') as HTMLInputElement | null)?.value || '');
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    const command = commandResults[commandActive];
    if (command) runCommand(command.id);
  }
});

document.getElementById('domainBack')?.addEventListener('click', closeDomainWorkspace);
document.getElementById('vialsMain')?.addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement;
  const tab = target.closest<HTMLElement>('[data-vials-tab]');
  if (tab?.dataset.vialsTab) { setVialsTab(tab.dataset.vialsTab); return; }
  const tabGo = target.closest<HTMLElement>('[data-vials-tab-go]');
  if (tabGo?.dataset.vialsTabGo) { setVialsTab(tabGo.dataset.vialsTabGo); return; }
  const registryInstall = target.closest<HTMLButtonElement>('[data-registry-install]');
  if (registryInstall?.dataset.registryInstall) {
    let assets: Record<string, string> = {};
    try {
      const parsed = JSON.parse(registryInstall.dataset.registryAssets || '{}') as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        assets = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>)
            .filter(([, value]) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value))
            .map(([key, value]) => [key, value as string]),
        );
      }
    } catch { /* no pinned assets */ }
    void installRegistryManifest(
      registryInstall.dataset.registryInstall,
      registryInstall.dataset.registryId || '',
      registryInstall.dataset.registryHash || '',
      registryInstall.dataset.registryVersion || '',
      assets,
      registryInstall,
    );
    return;
  }
  const install = target.closest<HTMLElement>('[data-domain-install]');
  if (install?.dataset.domainInstall) { void installDomainVial(install.dataset.domainInstall); return; }
  const open = target.closest<HTMLElement>('[data-domain-open]');
  if (open?.dataset.domainOpen) { openDomainWorkspace(open.dataset.domainOpen); return; }
  const docs = target.closest<HTMLElement>('[data-domain-docs]');
  if (docs?.dataset.domainDocs) { openDomainDocs(docs.dataset.domainDocs); return; }
  const exp = target.closest<HTMLElement>('[data-domain-export]');
  if (exp?.dataset.domainExport) { exportDomainPack(exp.dataset.domainExport); return; }
  if (target.closest('[data-domain-import]')) {
    (document.getElementById('domainImportFile') as HTMLInputElement | null)?.click();
    return;
  }
  if (target.closest('[data-domain-url]')) { showDomainUrlBar(); return; }
  if (target.closest('[data-domain-template]')) { downloadDomainTemplate(); return; }
  if (target.closest('[data-domain-submit]')) {
    void invoke('open_https_url', { url: 'https://github.com/OpenSmell/opensmell-web/issues/new?template=vial-submission.yml' });
    return;
  }
  const del = target.closest<HTMLButtonElement>('[data-domain-delete]');
  if (del?.dataset.domainDelete) { armOrDeleteDomainPack(del.dataset.domainDelete, del); return; }
  const remove = target.closest<HTMLButtonElement>('[data-domain-remove]');
  if (remove?.dataset.domainRemove) armOrRemoveDomainVial(remove.dataset.domainRemove, remove);
});
document.getElementById('domainWorkspace')?.addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement;
  const jump = target.closest<HTMLElement>('[data-domain-jump]');
  if (jump?.dataset.domainJump) {
    document.getElementById(`domainSection_${jump.dataset.domainJump}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const exp = target.closest<HTMLElement>('[data-domain-export]');
  if (exp?.dataset.domainExport) exportDomainPack(exp.dataset.domainExport);
  const guide = target.closest<HTMLElement>('[data-guide-open]');
  if (guide?.dataset.guideOpen) openGuide(guide.dataset.guideOpen);
});
let domainJumpRaf = 0;
document.getElementById('domainWorkspace')?.addEventListener('scroll', () => {
  if (domainJumpRaf) return;
  domainJumpRaf = window.requestAnimationFrame(() => {
    domainJumpRaf = 0;
    updateDomainJumpActive();
  });
});
document.getElementById('domainImportFile')?.addEventListener('change', (ev) => {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) importDomainPackFile(file);
  input.value = '';
});
document.getElementById('domainUrlCancel')?.addEventListener('click', hideDomainUrlBar);
document.getElementById('domainUrlInstall')?.addEventListener('click', () => {
  const input = document.getElementById('domainUrlInput') as HTMLInputElement | null;
  void installDomainFromUrl(input?.value || '');
});
document.getElementById('domainUrlInput')?.addEventListener('keydown', (ev) => {
  if ((ev as KeyboardEvent).key === 'Enter') {
    ev.preventDefault();
    const input = ev.target as HTMLInputElement;
    void installDomainFromUrl(input.value);
  }
});
document.getElementById('domainWorkspaceBody')?.addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement;
  const hotspot = target.closest<HTMLElement>('[data-domain-hotspot]');
  if (hotspot?.dataset.domainHotspot) { selectDomainHotspot(hotspot.dataset.domainHotspot); return; }
  if (target.closest('[data-domain-log-add]')) { addDomainLogFromForm(); return; }
  const del = target.closest<HTMLElement>('[data-domain-log-del]');
  if (del?.dataset.domainLogDel && activeDomainState) {
    activeDomainState = Domain.removeDomainLog(activeDomainState, del.dataset.domainLogDel);
    Domain.saveDomainState(activeDomainState);
    const pack = activeDomainPackId ? Domain.domainPackById(activeDomainPackId) : null;
    if (pack) renderDomainWorkspace(pack);
    return;
  }
  if (target.closest('[data-domain-dashboard]')) { openDomainDashboard(); return; }
  if (target.closest('[data-domain-rig]')) openDomainCheck();
});
document.getElementById('domainWorkspaceBody')?.addEventListener('input', (ev) => {
  const target = ev.target as HTMLInputElement;
  const field = target.closest<HTMLInputElement>('[data-domain-field]');
  if (field?.dataset.domainField && activeDomainState) {
    activeDomainState.fields[field.dataset.domainField] = target.value;
    Domain.saveDomainState(activeDomainState);
    return;
  }
  if (target.matches('[data-domain-check]') && activeDomainState) {
    activeDomainState.checks[target.dataset.domainCheck || ''] = target.checked;
    Domain.saveDomainState(activeDomainState);
  }
});
document.getElementById('domainWorkspaceBody')?.addEventListener('change', (ev) => {
  const target = ev.target as HTMLInputElement;
  const field = target.closest<HTMLInputElement>('[data-domain-field]');
  if (field?.dataset.domainField && activeDomainState) {
    activeDomainState.fields[field.dataset.domainField] = target.value;
    Domain.saveDomainState(activeDomainState);
  }
  if (target.matches('[data-domain-check]') && activeDomainState) {
    activeDomainState.checks[target.dataset.domainCheck || ''] = target.checked;
    Domain.saveDomainState(activeDomainState);
  }
});

let activeVialsTab: 'workspaces' | 'aromatory' = 'workspaces';
let registryEntries: RegistryVialEntry[] = [];
let registryLoading = false;
let registryLoaded = false;
let registryError = '';

function syncVialsTabs(): void {
  const panes: Record<string, string> = {
    workspaces: 'vialsWorkspacesPane',
    aromatory: 'vialsAromatoryPane',
  };
  for (const [tab, id] of Object.entries(panes)) {
    const pane = document.getElementById(id);
    if (pane) pane.style.display = tab === activeVialsTab ? 'flex' : 'none';
  }
  document.querySelectorAll<HTMLElement>('[data-vials-tab]').forEach(button => {
    button.classList.toggle('active', button.dataset.vialsTab === activeVialsTab);
  });
}

function setVialsTab(tab: string): void {
  if (tab !== 'workspaces' && tab !== 'aromatory') return;
  activeVialsTab = tab;
  if (tab === 'aromatory') renderDomainArea();
  syncVialsTabs();
}

function installedDomainCount(): number {
  const allDomain = Domain.allDomainPacks();
  return Domain.loadInstalledIds().filter(id => allDomain.some(p => p.id === id)).length;
}

function renderVials(): void {
  const summary = document.getElementById('vialsSummary');
  const allDomain = Domain.allDomainPacks();
  const installed = installedDomainCount();
  if (summary) {
    summary.textContent = `${installed} workspace${installed === 1 ? '' : 's'} · ${allDomain.length} available`;
  }
  const workspaces = document.getElementById('vialsWorkspacesCount');
  const aromatory = document.getElementById('vialsAromatoryCount');
  if (workspaces) workspaces.textContent = String(installed);
  if (aromatory) aromatory.textContent = String(allDomain.length);
  renderDomainArea();
  syncVialsTabs();
}

function downloadTextFile(filename: string, text: string, type = 'application/json'): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportDomainPack(id: string): void {
  const pack = Domain.domainPackById(id);
  if (!pack) return;
  downloadTextFile(`${pack.id}.vial.json`, Domain.domainPackToJson(pack));
  showToast('Domain Vial exported. The manifest is the submission unit.');
}

function starterDomainPack(): Domain.DomainPack {
  return {
    schema: 'osmograph.domain-pack/2',
    id: 'vial.my-workspace',
    name: 'My domain workspace',
    version: '0.1.0',
    author: '@your-handle',
    license: 'CC-BY-4.0',
    risk: 'medium',
    domain: 'custom',
    tagline: 'A short, honest line about the decision this workspace supports.',
    summary: 'Explain the narrow, repeated decision this workspace is for, the context it records, and the evidence behind it.',
    scope: 'A protocol, a detector profile, and a log for one repeated domain decision. Replace this with the specific decision your workspace supports.',
    limits: ['Replace this with the conditions where the profile refuses to arm or where the user must stop.'],
    anomaly: structuredClone(VialProfile.VIAL_PROFILE_DEFAULTS),
    evidence: {
      grade: 'D',
      reportUrl: '',
      measuredAt: '',
      dataset: '',
      metrics: {},
      fixtures: [],
    },
    citations: [
      'Replace with a real reference: author, year, title, venue. A citation is not decoration; it is the context for your claims.',
    ],
    widgets: [
      { type: 'hero', art: 'generic', title: 'My domain workspace', subtitle: 'A protocol, a log, and the limits that keep it honest.', note: 'Personal Vial · host-rendered · add a sandboxed UI when you need a custom screen' },
      { type: 'risk', level: 'medium', headline: 'Operating boundary.', body: 'Name the decision this workspace supports and the conditions where it refuses.', always: ['Record the context that changes the interpretation.'], never: ['Keep the sensor in its measurement role.'] },
      { type: 'metrics', title: 'What this workspace can claim', items: [
        { label: 'Signal', value: 'Change detection', hint: 'Same array, same sample preparation, against your own baseline.' },
        { label: 'Scope', value: 'Closed set', hint: 'State the array, protocol, and operating envelope.' },
        { label: 'Primary record', value: 'Context + log', hint: 'The sensor is one column; the primary measurement decides.' },
      ] },
      { type: 'detector', title: 'Detector contract', intro: 'If this workspace uses the live anomaly engine, copy this panel and replace the domain-specific actions. Use the host detector and declare the profile in the manifest.', baseline: 'A fresh clean-air window on this exact array. Verify a quiet baseline before you arm it.', levels: [
        { level: 0, label: 'Warming up', meaning: 'The baseline is still forming; no alarm is possible.', action: 'Keep the baseline window stable. Do not arm yet.' },
        { level: 1, label: 'Warning', meaning: 'A sustained change from the baseline.', action: 'Stop and inspect. Verify with the primary measurement.' },
        { level: 2, label: 'Critical', meaning: 'The change persisted past the critical duration.', action: 'Follow the domain stop rule. Confirm the cause with the primary measurement.' },
      ], limits: [
        'Scope the profile to this device and this array; a baseline from another rig needs its own calibration.',
        'A change is evidence for the person to interpret; identity, concentration, and safety decisions need their own primary measurements.',
      ], evidence: 'State the evidence behind the detector mapping, or remove this panel if the workspace does not use the live anomaly engine.' },
      { type: 'tracking', title: 'Workspace log', description: 'Replace these fields with the ones a practitioner would actually keep.', fields: [
        { id: 'batch', label: 'Batch / subject', type: 'text', placeholder: 'Batch 01' },
        { id: 'started', label: 'Started', type: 'date' },
      ], logFields: [
        { id: 'day', label: 'Day / reading', type: 'number', placeholder: '1' },
        { id: 'note', label: 'Observation', type: 'text', placeholder: 'what changed?' },
        { id: 'action', label: 'Action', type: 'select', options: ['none', 'inspect', 'discard'] },
      ], logLabel: 'Add reading' },
      { type: 'rules', title: 'Decision rules', rules: [
        { when: 'A reading changes without a context change', then: 'Inspect the sample and the sensor before changing the process.', severity: 'warn' },
        { when: 'The process is outside its safe range', then: 'Stop and use the primary measurement, not the smell.', severity: 'stop' },
      ] },
      { type: 'docs', title: 'Field notes' },
      { type: 'rig', title: 'Use this with your rig', body: 'Record a clean reference and a sample on the same array, then compare in Separability. If the arrays differ, the app refuses the comparison.', cta: 'Open Separability' },
    ],
    docs: [
      { id: 'how', title: 'How to use this workspace', body: ['Explain the first action, the reading cadence, and what the log is for.'] },
      { id: 'limits', title: 'What it cannot tell you', body: ['State the specific overclaim a user might make, and the primary measurement or inspection that replaces it.'] },
      { id: 'refs', title: 'References', body: ['List the domain references and say that they contextualise the workspace; they do not validate the sensor.'] },
    ],
  };
}

function downloadDomainTemplate(): void {
  downloadTextFile('my-domain-vial.vial.json', Domain.domainPackToJson(starterDomainPack()));
  showToast('Starter domain Vial downloaded. Edit the JSON, then import it.');
}

function importDomainPackText(text: string): void {
  const result = Domain.importDomainPackJson(text);
  Domain.installDomainPack(result.pack.id);
  renderVials();
  openDomainWorkspace(result.pack.id);
  const passed = result.validation.checks.filter(c => c.passed).length;
  showToast(`Vial installed. ${passed}/${result.validation.checks.length} policy checks passed.`);
}

function importDomainPackFile(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      importDomainPackText(String(reader.result || ''));
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not import this domain Vial.');
    }
  };
  reader.onerror = () => showToast('Could not read that file.');
  reader.readAsText(file);
}

function domainUrlAllowed(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
}

function showDomainUrlBar(): void {
  const bar = document.getElementById('domainUrlBar');
  const input = document.getElementById('domainUrlInput') as HTMLInputElement | null;
  if (!bar) return;
  bar.hidden = false;
  if (input) {
    input.focus();
    input.select();
  }
}

function hideDomainUrlBar(): void {
  const bar = document.getElementById('domainUrlBar');
  if (bar) bar.hidden = true;
}

function setDomainUrlStatus(text: string, state: 'idle' | 'busy' | 'pass' | 'fail' = 'idle'): void {
  const status = document.getElementById('domainUrlStatus');
  if (!status) return;
  status.textContent = text;
  status.className = `domain-url-status${state === 'idle' ? '' : ` ${state}`}`;
}

interface FetchedDomainManifest {
  result: Domain.DomainImportResult;
  finalUrl: URL;
  /** The manifest bytes as fetched, for hash verification. */
  text: string;
  /** sha256 of the manifest bytes. */
  manifestHash: string;
  /** sha256 of each UI asset that was fetched and cached. */
  assetHashes: Record<string, string>;
}

async function fetchDomainManifest(
  raw: string,
  timeoutMs = 20000,
  expected?: { hash?: string; assets?: Record<string, string> },
): Promise<FetchedDomainManifest> {
  const url = new URL(raw.trim());
  if (!domainUrlAllowed(url)) {
    throw new Error('Use https:// for a remote manifest. http://localhost is allowed for development only.');
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);
    const finalUrl = new URL(response.url);
    if (!domainUrlAllowed(finalUrl)) {
      throw new Error('The download redirected away from HTTPS. Refusing to install it.');
    }
    const text = await response.text();
    if (text.length > 1_500_000) {
      throw new Error('That manifest is larger than 1.5 MB. Refusing to install it.');
    }
    // Parse and gate *before* writing anything. A registry install must verify
    // the fetched bytes against the pinned hashes before the pack can replace a
    // working one on disk.
    const result = Domain.parseDomainPackJson(text, finalUrl.toString());
    const manifestHash = await sha256Hex(text);
    const wantManifest = expected?.hash?.toLowerCase();
    if (wantManifest && manifestHash !== wantManifest) {
      throw new Error('The manifest on disk does not match the sha256 recorded in the registry — it changed upstream. Refusing to install; check the source repo.');
    }
    result.pack.manifestHash = manifestHash;
    const assetHashes = (result.pack.ui || result.pack.homeUi)
      ? await cacheDomainUi(result.pack, finalUrl.toString(), expected?.assets)
      : {};
    result.pack.assetHashes = assetHashes;
    return { result, finalUrl, text, manifestHash, assetHashes };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`The download timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw err;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function installDomainFromUrl(raw: string): Promise<void> {
  const input = document.getElementById('domainUrlInput') as HTMLInputElement | null;
  const install = document.getElementById('domainUrlInstall') as HTMLButtonElement | null;
  const urlText = raw.trim();
  if (!urlText) {
    setDomainUrlStatus('Paste the raw URL of a .vial.json manifest.', 'fail');
    input?.focus();
    return;
  }

  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    setDomainUrlStatus('That is not a valid URL.', 'fail');
    input?.focus();
    return;
  }
  if (!domainUrlAllowed(url)) {
    setDomainUrlStatus('Use https:// for a remote manifest. http://localhost is allowed for development only.', 'fail');
    input?.focus();
    return;
  }

  const previous = install?.textContent || 'Validate & install';
  if (install) { install.disabled = true; install.textContent = 'Fetching…'; }
  setDomainUrlStatus(`Fetching ${url.hostname}…`, 'busy');
  try {
    const fetched = await fetchDomainManifest(url.toString());
    setDomainUrlStatus('Fetched. Running the local policy gate…', 'busy');
    // The pack is written only after the gate passes and, when the source is
    // the registry, after the pinned manifest and UI hashes verify.
    Domain.saveCustomPack(fetched.result.pack);
    Domain.installDomainPack(fetched.result.pack.id);
    hideDomainUrlBar();
    if (input) input.value = '';
    renderVials();
    renderVialHome();
    openDomainWorkspace(fetched.result.pack.id);
    const passed = fetched.result.validation.checks.filter(c => c.passed).length;
    setDomainUrlStatus('', 'idle');
    showToast(`Installed from ${fetched.finalUrl.hostname}. ${passed}/${fetched.result.validation.checks.length} policy checks passed.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not install that manifest.';
    setDomainUrlStatus(message, 'fail');
    showToast(message);
  } finally {
    if (install) { install.disabled = false; install.textContent = previous; }
  }
}

async function installRegistryManifest(
  url: string,
  id: string,
  expectedHash: string,
  expectedVersion: string,
  expectedAssets: Record<string, string>,
  button: HTMLButtonElement,
): Promise<void> {
  if (!url) return;
  const previous = button.textContent || 'Install from source';
  button.disabled = true;
  button.textContent = 'Fetching…';
  const wasInstalled = Domain.loadInstalledIds().includes(id);
  try {
    const fetched = await fetchDomainManifest(url, 20000, { hash: expectedHash, assets: expectedAssets });
    if (fetched.result.pack.id !== id) {
      throw new Error('The manifest id does not match its registry entry. Refusing to install it.');
    }
    if (expectedVersion && fetched.result.pack.version !== expectedVersion) {
      throw new Error(`The manifest version ${fetched.result.pack.version} does not match the registry entry ${expectedVersion}. Refusing to install it.`);
    }
    Domain.saveCustomPack(fetched.result.pack);
    Domain.installDomainPack(fetched.result.pack.id);
    renderVials();
    renderVialHome();
    openDomainWorkspace(fetched.result.pack.id);
    const passed = fetched.result.validation.checks.filter(c => c.passed).length;
    const hashNote = expectedHash ? ' sha256 verified.' : '';
    showToast(`${wasInstalled ? 'Updated' : 'Installed'} ${fetched.result.pack.name} to v${fetched.result.pack.version} from ${fetched.finalUrl.hostname}. ${passed}/${fetched.result.validation.checks.length} policy checks passed.${hashNote}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not install that manifest.';
    showToast(message);
    button.disabled = false;
    button.textContent = previous;
  }
}

// === Smell detail — the front door's one-click answer ===
// A card click used to list files. A smell is not a file: this view shows its
// fingerprint, its signed response, and the nearest smell the array struggles
// to tell it apart from, using the same replicate test as the advisor.

let smellDetailToken = 0;
let detailCard: SmellCardData | null = null;
let detailNeighbor: SmellCardData | null = null;
let detailPair: SmellPairSeparation | null = null;
// The order currently visible in the gallery. The arrows walk that order, so
// narrowing the gallery and then opening a card gives a coherent way to browse
// the result set instead of dumping the person back into the whole library.
let detailList: SmellCardData[] = [];
let detailIndex = -1;

async function ensureMean(card: SmellCardData): Promise<MeanResponse | null> {
  const cached = smellFpCache.get(card.key);
  if (cached !== undefined) {
    if (cached) {
      card.channels = cached.channels;
      card.values = cached.values;
      card.groupRecords = cached.records;
      card.usedInMean = cached.used;
    }
    return cached;
  }
  let pending = smellFpPending.get(card.key);
  if (!pending) {
    const gen = smellCacheGen;
    pending = meanResponseFor(card.records)
      .then(fp => {
        if (gen === smellCacheGen) {
          smellFpCache.set(card.key, fp);
          smellFpPending.delete(card.key);
          if (fp) {
            card.channels = fp.channels;
            card.values = fp.values;
            card.groupRecords = fp.records;
            card.usedInMean = fp.used;
          }
        }
        return fp;
      })
      .catch(err => {
        if (gen === smellCacheGen) smellFpPending.delete(card.key);
        throw err;
      });
    smellFpPending.set(card.key, pending);
  }
  return pending;
}

function cosineOf(a: number[], b: number[]): number {
  let ab = 0, aa = 0, bb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : NaN;
}

/** Linear resample over the finite stretch, so traces of different lengths can
 *  share an axis. NaN gaps are dropped rather than drawn as real samples. */
function resampleCurve(v: number[], n = 96): number[] {
  const pts = v.map((y, x) => [x, y] as const).filter(([, y]) => Number.isFinite(y));
  if (pts.length < 2) return new Array(n).fill(NaN);
  const x0 = pts[0][0], x1 = pts[pts.length - 1][0];
  const out: number[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const x = x0 + (x1 - x0) * (k / (n - 1));
    while (j < pts.length - 2 && pts[j + 1][0] < x) j++;
    const [xa, ya] = pts[j];
    const [xb, yb] = pts[j + 1];
    out.push(xb === xa ? ya : ya + (yb - ya) * (x - xa) / (xb - xa));
  }
  return out;
}

/** Mean normalized trace for one array group on one channel. Descriptive: it
 *  makes the shape/level distinction visible, not a substitute for the test. */
interface DetailTraceSet {
  channels: string[];
  /** [channel][recording] over 96 relative-time samples. */
  curves: number[][][];
  /** Largest number of replicate curves on any one channel. */
  used: number;
}

/** Load the individual normalized curves behind a smell's mean fingerprint.
 *  This is deliberately not a single averaged line: the spread between
 *  replicates is part of what the evidence can and cannot support. */
async function detailTraceSet(card: SmellCardData, max = 6): Promise<DetailTraceSet | null> {
  const group = card.groupRecords?.length ? card.groupRecords : card.records;
  const usable = group.filter(r => !!r.file_id).slice(0, max);
  let channels: string[] = [];
  const curves: number[][][] = [];
  for (const rec of usable) {
    const series = await loadCompareSeries(rec.file_id!);
    if (!series || !series.channels.length) continue;
    if (!channels.length) {
      channels = series.channels.slice();
      for (let ci = 0; ci < channels.length; ci++) curves.push([]);
    }
    if (series.channels.join('\u0000') !== channels.join('\u0000')) continue;
    for (let ci = 0; ci < channels.length; ci++) {
      const norm = cmpNorm(series, ci);
      if (!norm || norm.length < 2) continue;
      if (norm.filter(Number.isFinite).length < 2) continue;
      curves[ci].push(resampleCurve(norm, 96));
    }
  }
  if (!channels.length || !curves.some(c => c.length)) return null;
  return { channels, curves, used: Math.max(0, ...curves.map(c => c.length)) };
}

function drawCurvesPlaceholder(canvas: HTMLCanvasElement, message: string): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(280, canvas.clientWidth || 600);
  const h = Math.max(140, canvas.clientHeight || 252);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#8a7f6c';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, w / 2, h / 2);
}

/** Small multiples of the response over relative time: one panel per channel,
 *  thin lines for individual recordings, bold line for their mean. Level and
 *  kinetics are both visible; this replaces the decorative single radar on the
 *  detail view. */
function drawDetailCurves(canvas: HTMLCanvasElement, set: DetailTraceSet): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(280, canvas.clientWidth || 600);
  const h = Math.max(160, canvas.clientHeight || 252);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const n = set.channels.length;
  if (!n) return;
  const cols = n <= 2 ? n : n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const gapX = 12, gapY = 10;
  const panelW = (w - gapX * (cols - 1)) / cols;
  const panelH = (h - gapY * (rows - 1)) / rows;
  ctx.textBaseline = 'top';
  for (let ci = 0; ci < n; ci++) {
    const col = ci % cols;
    const row = Math.floor(ci / cols);
    const x = col * (panelW + gapX);
    const y = row * (panelH + gapY);
    const curves = set.curves[ci];
    const finite = curves.flat().filter(Number.isFinite);
    ctx.strokeStyle = 'rgba(29,26,22,0.10)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, panelW - 1, panelH - 1);
    ctx.fillStyle = '#3a3630';
    ctx.font = '600 9px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.fillText((set.channels[ci] || `CH${ci + 1}`).slice(0, 14), x + 5, y + 4);
    ctx.fillStyle = '#8a7f6c';
    ctx.font = '8px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(curves.length ? `n=${curves.length}` : 'n/a', x + panelW - 5, y + 4);
    if (!finite.length) continue;
    let lo = Math.min(...finite), hi = Math.max(...finite);
    if (!(hi - lo > 1e-9)) { lo -= 0.5; hi += 0.5; }
    const pad = (hi - lo) * 0.12;
    lo -= pad; hi += pad;
    const left = x + 5, right = x + panelW - 5;
    const top = y + 17, bottom = y + panelH - 5;
    const px = (i: number) => left + (i / 95) * (right - left);
    const py = (v: number) => top + (1 - (v - lo) / (hi - lo)) * (bottom - top);
    if (lo < 0 && hi > 0) {
      ctx.strokeStyle = 'rgba(29,26,22,0.18)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(left, py(0));
      ctx.lineTo(right, py(0));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const color = CHART_COLORS[ci % CHART_COLORS.length];
    for (const curve of curves) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.18;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < curve.length; i++) {
        if (!Number.isFinite(curve[i])) { started = false; continue; }
        const X = px(i), Y = py(curve[i]);
        if (started) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
        started = true;
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (curves.length) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < 96; i++) {
        const vals = curves.map(c => c[i]).filter(Number.isFinite);
        if (!vals.length) { started = false; continue; }
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const X = px(i), Y = py(mean);
        if (started) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
        started = true;
      }
      ctx.stroke();
    }
  }
}

function closeSmellDetail(): void {
  smellDetailToken++;
  detailCard = null;
  detailNeighbor = null;
  detailPair = null;
  const modal = document.getElementById('smellDetailModal');
  if (modal) modal.style.display = 'none';
}

function drawSignedBars(values: number[], channels: string[]): void {
  const el = document.getElementById('sdBars');
  if (!el) return;
  const finite = values.filter(Number.isFinite);
  if (!finite.length) {
    el.innerHTML = '<div class="sd-section-title" style="margin-top:8px">Signed settled response</div><div class="hint">No signed response available.</div>';
    return;
  }
  const max = Math.max(...finite.map(v => Math.abs(v)), 1e-9);
  const rows = channels.map((ch, i) => {
    const v = values[i];
    if (!Number.isFinite(v)) {
      return `<div class="sd-bar-row"><span class="sd-bar-name" title="${esc(ch)}">${esc(ch)}</span><span class="hint" style="grid-column:span 2">n/a</span></div>`;
    }
    const frac = Math.min(1, Math.abs(v) / max);
    const width = (frac * 50).toFixed(1);
    const left = v >= 0 ? 50 : 50 - frac * 50;
    const color = v >= 0 ? cssToken('--cyan') : '#b45309';
    return `<div class="sd-bar-row">
      <span class="sd-bar-name" title="${esc(ch)}">${esc(ch)}</span>
      <span class="sd-bar-track"><span class="sd-bar-zero"></span><span class="sd-bar-fill" style="left:${left}%;width:${width}%;background:${color}"></span></span>
      <span class="sd-bar-val" title="settled ΔR/R0">${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%</span>
    </div>`;
  }).join('');
  el.innerHTML = `<div class="sd-section-title" style="margin-top:8px">Signed settled response · ΔR/R0</div>${rows}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection-based fallback.
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** A compact, honest text version of the detail view — for lab notes and chat. */
function smellSummaryText(card: SmellCardData): string {
  const lines: string[] = [];
  lines.push(`${titleCase(card.substance)} — ${smellSource(card)}`);
  const groupN = card.groupRecords?.length || card.records.length;
  lines.push(`${groupN} recording${groupN === 1 ? '' : 's'} on this array · ${card.analyzed} analyzed${card.meanQuality ? ` · mean quality ${card.meanQuality}` : ''}`);
  if (card.channels.length && card.values) {
    const parts = card.channels.map((ch, i) => {
      const v = card.values![i];
      return Number.isFinite(v) ? `${ch} ${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : `${ch} n/a`;
    });
    lines.push(`Mean settled response (ΔR/R0): ${parts.join(', ')}`);
  }
  const p = detailPair;
  if (p) {
    const acc = Number.isFinite(p.acc) ? `${Math.round(p.acc * p.nEval)}/${p.nEval}` : 'n/a';
    const lower = Number.isFinite(p.acc) && p.nEval > 0
      ? wilsonLower(Math.round(p.acc * p.nEval), p.nEval)
      : NaN;
    const split = [p.accLevel, p.accShape, p.acc].map((v, i) =>
      Number.isFinite(v) ? `${['level', 'shape', 'together'][i]} ${Math.round(v * 100)}%` : `${['level', 'shape', 'together'][i]} n/a`,
    ).join(', ');
    lines.push(`Closest confusable: ${titleCase(p.b.substance)} — ${SEP_VERDICT_LABEL[p.verdict]}`);
    lines.push(`${acc} left-out recordings match their own smell (${split})${Number.isFinite(lower) ? `; 95% lower ${Math.round(lower * 100)}%` : ''}${Number.isFinite(p.pValue) ? `; p = ${p.pValue.toFixed(3)} over ${p.permutations} label arrangements` : ''}.`);
    if (p.lever) lines.push(`Lever: ${p.lever}`);
  } else {
    lines.push('No confusable verdict yet — needs at least two comparable recordings on this array.');
  }
  lines.push('Preview from saved replicates, not a trained model. Osmograph.');
  return lines.join('\n');
}

function openSmellSessions(card: SmellCardData): void {
  closeSmellDetail();
  const search = document.getElementById('libSearch') as HTMLInputElement | null;
  if (search) search.value = card.substance;
  document.querySelector<HTMLElement>('.src-subnav-btn[data-src="sessions"]')?.click();
  renderLibrary();
}

/** Plain-language version of a pair verdict. The statistics stay in the
 *  evidence drawer; this is what a person needs before trusting the smell. */
function confusableNarrative(card: SmellCardData, p: SmellPairSeparation): string {
  const name = esc(titleCase(card.substance));
  const other = esc(titleCase(p.b.substance));
  const acc = Number.isFinite(p.acc) ? `${Math.round(p.acc * p.nEval)}/${p.nEval}` : 'n/a';
  const lower = Number.isFinite(p.acc) && p.nEval > 0
    ? wilsonLower(Math.round(p.acc * p.nEval), p.nEval)
    : NaN;
  const lowerTxt = Number.isFinite(lower) ? ` Even the conservative 95% estimate is ${Math.round(lower * 100)}%.` : '';
  const pTxt = Number.isFinite(p.pValue)
    ? (p.pValue < 0.001 ? '&lt; 0.001' : p.pValue.toFixed(3))
    : null;
  const chanceTxt = Number.isFinite(p.pValue)
    ? ` A label shuffle reaches that score ${Math.round(p.pValue * 100)}% of the time (p = ${pTxt}).`
    : '';
  const dTxt = p.best && Number.isFinite(p.best.d) ? `${p.best.d.toFixed(1)}σ` : 'a narrow margin';

  if (p.verdict === 'separable') {
    return `<b>Separable on this array.</b> ${acc} held-out recordings matched their own smell.${lowerTxt}${chanceTxt ? '' : ' The permutation test is unavailable.'} Keep baseline, flow and exposure time steady so the margin survives the next session.`;
  }
  if (p.verdict === 'fragile') {
    if (Number.isFinite(p.pValue) && p.pValue > 0.05 && p.acc >= 0.9) {
      return `<b>Promising, not established.</b> ${acc} held-out recordings matched, but with this many recordings and candidate features, chance can reach the same score.${chanceTxt} Do not use ${name} vs ${other} as an identity test yet.`;
    }
    return `<b>Not reliable yet.</b> ${acc} held-out recordings matched their own smell, and the best feature separates them by ${dTxt}.${lowerTxt} That is too fragile to identify either smell from one recording.`;
  }
  if (p.verdict === 'confusable') {
    return `<b>Confusable.</b> ${acc} held-out recordings matched — close to chance for ${name} vs ${other}. The best feature separates them by only ${dTxt}. More of the same MOX sensor mostly repeats the same cross-sensitivity.`;
  }
  return `<b>Needs replicates.</b> ${name} has ${p.nA} comparable recording${p.nA === 1 ? '' : 's'} and ${other} has ${p.nB}. A pair verdict needs at least two of each on the same array.`;
}

function confusableAction(p: SmellPairSeparation): string {
  if (p.verdict === 'separable') {
    return 'Keep the protocol identical next time — baseline, flow, temperature and exposure duration — so the margin survives a new session.';
  }
  if (p.verdict === 'fragile') {
    return 'Collect independent, interleaved replicates of both smells on this array before relying on this pair.';
  }
  if (p.verdict === 'confusable') {
    return 'Add a channel with different selectivity, or change the exposure protocol. More of the same MOX sensor mostly repeats the same cross-sensitivity.';
  }
  return 'Record at least two replicates of each smell on the same channel-for-channel array.';
}

function hideDetailEvidence(): void {
  const method = document.getElementById('sdMethod') as HTMLDetailsElement | null;
  if (method) {
    method.hidden = true;
    method.open = false;
  }
  const evidence = document.getElementById('sdEvidence');
  if (evidence) evidence.innerHTML = '';
}

async function findClosestConfusable(card: SmellCardData, token: number): Promise<void> {
  const panel = document.getElementById('sdNeighbor');
  if (!panel) return;
  hideDetailEvidence();
  const ownFp = smellFpCache.get(card.key);
  if (!ownFp) {
    panel.innerHTML = '<p class="sd-verdict-line">This smell has no usable channel series, so a confusion verdict cannot be computed.</p>';
    return;
  }
  const candidates: { card: SmellCardData; cos: number }[] = [];
  for (const c of smellCards) {
    if (c.key === card.key) continue;
    const fp = await ensureMean(c);
    if (token !== smellDetailToken) return;
    if (!fp || fp.channels.length !== ownFp.channels.length) continue;
    if (fp.channels.some((ch, i) => ch !== ownFp.channels[i])) continue;
    const cos = cosineOf(ownFp.values, fp.values);
    if (Number.isFinite(cos)) candidates.push({ card: c, cos });
  }
  if (!candidates.length) {
    panel.innerHTML = '<p class="sd-verdict-line">No other smell uses the same channel-for-channel array. A confusion verdict needs the same sensors wired the same way — record another smell on this rig to compare.</p>';
    return;
  }
  candidates.sort((a, b) => b.cos - a.cos);
  const ownRep = await smellReplicates(card);
  if (token !== smellDetailToken) return;
  const closest = candidates[0].card;
  if (!ownRep || ownRep.rows.length < 2) {
    panel.innerHTML = `<div class="sd-neighbor-name">${esc(titleCase(closest.substance))}</div>
      <p class="sd-verdict-line">Closest by steady response, but ${esc(titleCase(card.substance))} needs at least two comparable recordings before a confusion verdict is meaningful. Add replicates of both smells on this array.</p>`;
    return;
  }
  const pairs: SmellPairSeparation[] = [];
  const considered: string[] = [];
  let evaluable = 0;
  for (const cand of candidates) {
    if (evaluable >= 3 || considered.length >= 6) break;
    const rep = await smellReplicates(cand.card);
    if (token !== smellDetailToken) return;
    if (!rep) continue;
    const sep = separationBetween(ownRep, rep);
    if (!sep.channels.length) continue;
    considered.push(titleCase(cand.card.substance));
    const best = [...sep.channels].sort((x, y) => (Number.isFinite(y.d) ? y.d : -1) - (Number.isFinite(x.d) ? x.d : -1))[0] || null;
    const pair: SmellPairSeparation = {
      a: card, b: cand.card,
      nA: ownRep.rows.length, nB: rep.rows.length,
      consideredA: ownRep.considered, consideredB: rep.considered,
      channels: sep.channels, best, acc: sep.acc, accLevel: sep.accLevel, accShape: sep.accShape,
      nEval: sep.nEval, pValue: sep.pValue, permutations: sep.permutations,
      verdict: separationVerdict(
        Math.max(sep.acc, Number.isFinite(sep.accLevel) ? sep.accLevel : -1, Number.isFinite(sep.accShape) ? sep.accShape : -1),
        best && Number.isFinite(best.d) ? best.d : 0,
        sep.nEval,
        sep.pValue,
      ),
      lever: '',
    };
    pair.lever = separationLever(pair);
    pairs.push(pair);
    if ([pair.acc, pair.accLevel, pair.accShape].some(Number.isFinite)) evaluable++;
  }
  if (!pairs.length) {
    panel.innerHTML = `<div class="sd-neighbor-name">${esc(titleCase(closest.substance))}</div>
      <p class="sd-verdict-line">Closest by steady response, but the two arrays could not be compared channel-for-channel with enough replicates.</p>`;
    return;
  }
  const score = (p: SmellPairSeparation): number => {
    const v = [p.acc, p.accLevel, p.accShape].filter(Number.isFinite);
    return v.length ? Math.max(...v) : 2;
  };
  pairs.sort((a, b) => score(a) - score(b));
  const pick = pairs[0];
  detailNeighbor = pick.b;
  detailPair = pick;
  const btn = document.getElementById('sdCompare') as HTMLButtonElement | null;
  if (btn) btn.disabled = false;
  const note = considered.length > 1
    ? `Compared with the ${considered.length} most similar smells by steady response (${considered.join(', ')}); showing the least separable.`
    : 'Compared with the most similar smell by steady response.';
  panel.innerHTML = `<div class="sd-neighbor-name">${esc(titleCase(pick.b.substance))} <span class="sep-badge ${pick.verdict}">${SEP_VERDICT_LABEL[pick.verdict]}</span></div>
    <p class="sd-verdict-line">${confusableNarrative(card, pick)}</p>
    <p class="sd-action">${esc(confusableAction(pick))}</p>
    <div class="hint" style="margin-top:2px">${esc(note)}</div>`;
  const evidence = document.getElementById('sdEvidence');
  if (evidence) evidence.innerHTML = sepPairHtml(pick);
  const method = document.getElementById('sdMethod') as HTMLDetailsElement | null;
  if (method) method.hidden = false;
}

function openSmellDetail(card: SmellCardData): void {
  detailCard = card;
  detailNeighbor = null;
  detailPair = null;
  detailList = visibleSmellCards();
  detailIndex = detailList.findIndex(c => c.key === card.key);
  if (detailIndex < 0) {
    detailList = smellCards.slice();
    detailIndex = detailList.findIndex(c => c.key === card.key);
  }
  const pos = document.getElementById('sdPos');
  if (pos) pos.textContent = `${detailIndex + 1} / ${detailList.length}`;
  const prev = document.getElementById('sdPrev') as HTMLButtonElement | null;
  const next = document.getElementById('sdNext') as HTMLButtonElement | null;
  if (prev) prev.disabled = detailList.length < 2;
  if (next) next.disabled = detailList.length < 2;
  hideDetailEvidence();
  const modal = document.getElementById('smellDetailModal');
  if (!modal) return;
  modal.style.display = 'flex';
  const name = document.getElementById('sdName');
  if (name) name.textContent = titleCase(card.substance);
  const meta = document.getElementById('sdMeta');
  if (meta) {
    meta.textContent = `${card.records.length} recording${card.records.length === 1 ? '' : 's'} · ${card.analyzed} analyzed${card.meanQuality ? ` · mean quality ${card.meanQuality}` : ''} · ${smellSource(card)}`;
  }
  // Clear the previous smell's fingerprint immediately; never let one smell's
  // shape sit under another smell's name while the replicates load.
  const print = document.getElementById('sdPrint') as HTMLCanvasElement | null;
  if (print) drawCurvesPlaceholder(print, 'Reading replicate curves…');
  const bars = document.getElementById('sdBars');
  if (bars) bars.innerHTML = '<div class="hint">Reading replicates…</div>';
  const btn = document.getElementById('sdCompare') as HTMLButtonElement | null;
  if (btn) btn.disabled = !card.records.some(r => !!r.file_id);
  const neighbor = document.getElementById('sdNeighbor');
  if (neighbor) neighbor.innerHTML = '<div class="hint">Ranking smells by steady-response similarity…</div>';
  const token = ++smellDetailToken;
  void (async () => {
    const fp = await ensureMean(card);
    if (token !== smellDetailToken) return;
    if (!fp) {
      if (neighbor) neighbor.innerHTML = '<p class="sd-verdict-line">This smell has no usable channel series on a single array.</p>';
      return;
    }
    if (meta) {
      const other = fp.total - fp.groupSize;
      const otherNote = other > 0 ? ` · ${other} on another array` : '';
      meta.textContent = `${fp.groupSize} recording${fp.groupSize === 1 ? '' : 's'} on this array${otherNote} · mean of ${fp.used} · ${smellSource(card)}`;
      meta.title = `${card.analyzed} analyzed${card.meanQuality ? ` · mean quality ${card.meanQuality}` : ''}. ${other > 0
        ? `${other} recording${other === 1 ? '' : 's'} use a different array and are not blended into this fingerprint.`
        : 'All recordings use this array.'}`;
    }
    drawSignedBars(fp.values, fp.channels);
    if (print) {
      const traces = await detailTraceSet(card);
      if (token !== smellDetailToken) return;
      if (traces) drawDetailCurves(print, traces);
      else drawCurvesPlaceholder(print, 'No comparable replicate curves on one array.');
    }
    await findClosestConfusable(card, token);
  })();
}

function stepSmellDetail(delta: number): void {
  if (!detailCard || detailList.length < 2) return;
  let idx = detailList.findIndex(c => c.key === detailCard!.key);
  if (idx < 0) idx = detailIndex;
  const next = detailList[(idx + delta + detailList.length) % detailList.length];
  if (next) openSmellDetail(next);
}

function randomSmellDetail(): void {
  if (smellCards.length < 2) return;
  const pool = smellCards.filter(c => c.key !== detailCard?.key);
  const pick = pool[Math.floor(Math.random() * pool.length)];
  if (pick) openSmellDetail(pick);
}

document.getElementById('sdClose')?.addEventListener('click', closeSmellDetail);
document.getElementById('sdPrev')?.addEventListener('click', () => stepSmellDetail(-1));
document.getElementById('sdNext')?.addEventListener('click', () => stepSmellDetail(1));
document.getElementById('sdRandom')?.addEventListener('click', randomSmellDetail);
document.getElementById('smellDetailModal')?.addEventListener('click', (ev) => {
  if (ev.target === ev.currentTarget) closeSmellDetail();
});
document.addEventListener('keydown', (ev) => {
  const modal = document.getElementById('smellDetailModal');
  if (!modal || modal.style.display === 'none') return;
  const target = ev.target as HTMLElement | null;
  const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
  if (ev.key === 'Escape') closeSmellDetail();
  else if (!typing && ev.key === 'ArrowLeft') { ev.preventDefault(); stepSmellDetail(-1); }
  else if (!typing && ev.key === 'ArrowRight') { ev.preventDefault(); stepSmellDetail(1); }
});
document.getElementById('sdAll')?.addEventListener('click', () => {
  if (detailCard) openSmellSessions(detailCard);
});
document.getElementById('sdCard')?.addEventListener('click', () => {
  if (detailCard) void exportSmellCard(detailCard);
});
document.getElementById('sdCopy')?.addEventListener('click', async (ev) => {
  const card = detailCard;
  if (!card) return;
  const btn = ev.currentTarget as HTMLButtonElement | null;
  await ensureMean(card);
  if (card !== detailCard) return;
  const ok = await copyText(smellSummaryText(card));
  if (!btn) return;
  const prev = btn.textContent;
  btn.textContent = ok ? 'Copied' : 'Copy failed';
  setTimeout(() => { btn.textContent = prev; }, 1600);
});
function showRecipePanel(): void {
  // Recipes are part of the analysis workbench; opening one from a smell
  // should not silently move the person into a hidden panel.
  showWorkspaceView('recipes');
}

document.getElementById('recipeBack')?.addEventListener('click', () => {
  showWorkspaceView('sessions');
});

document.getElementById('sdRecipe')?.addEventListener('click', async () => {
  const card = detailCard;
  if (!card) return;
  // Use the same array group the fingerprint and verdict came from, not just
  // the newest file that shares the smell name.
  const group = card.groupRecords?.length ? card.groupRecords : card.records;
  const rec = group.find(r => !!r.file_id);
  if (!rec?.file_id) return;
  const recipeName = `${titleCase(card.substance)} response`;
  closeSmellDetail();
  showRecipePanel();
  await ensureRecipeOps();
  openRecipeEditor({
    id: `${recipeSlug(recipeName)}-${Date.now().toString(36)}`,
    name: recipeName,
    version: '1.0.0',
    source: `osmell:${rec.file_id}`,
    steps: [
      { op: 'smooth.movavg', channel: null, params: { window: 5 } },
      { op: 'response.ratio', channel: null, params: {} },
    ],
    notes: '',
  });
});
document.getElementById('sdCheck')?.addEventListener('click', () => {
  const a = detailCard;
  if (!a) return;
  const b = detailNeighbor && detailNeighbor.key !== a.key ? detailNeighbor : null;
  checkPrefill = { ref: a.key, sample: b?.key };
  closeSmellDetail();
  showWorkspaceView('check');
});
document.getElementById('sdCompare')?.addEventListener('click', () => {
  const a = detailCard;
  if (!a) return;
  const ids: string[] = [];
  for (const c of [a, detailNeighbor]) {
    if (!c) continue;
    // Compare the array group the verdict was computed on, not every file that
    // happens to share the smell name. Mixing arrays would silently blend them.
    const group = c.groupRecords?.length ? c.groupRecords : c.records;
    for (const r of group.filter(rec => !!rec.file_id).slice(0, 6)) {
      if (r.file_id && !ids.includes(r.file_id)) ids.push(r.file_id);
    }
  }
  if (!ids.length) return;
  closeSmellDetail();
  compareFiles = ids;
  showWorkspaceView('compare');

});

document.getElementById('smellCompare')?.addEventListener('click', () => {
  // One representative recording per selected smell, from the same dominant
  // array group the fingerprint and advisor use — never a stray file from a
  // different rig that happens to share the smell name.
  compareFiles = smellCards
    .filter(c => smellSel.has(c.key))
    .map(c => (c.groupRecords?.length ? c.groupRecords : c.records).find(r => !!r.file_id)?.file_id)
    .filter((f): f is string => !!f);
  showWorkspaceView('compare');
});
document.getElementById('smellClearSel')?.addEventListener('click', clearSmellSelection);

// Gallery controls. A search field that only filters after Enter is a dead
// control, so this re-renders after a short pause and keeps the result count
// visible. "Surprise me" draws from the current result set, not the whole shelf.
(document.getElementById('smellSearch') as HTMLInputElement | null)?.addEventListener('input', (ev) => {
  smellQuery = (ev.target as HTMLInputElement).value;
  window.clearTimeout(smellSearchTimer);
  smellSearchTimer = window.setTimeout(() => { void renderSmellGallery(); }, 120);
});
document.querySelectorAll<HTMLElement>('.smell-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    smellFilter = (chip.dataset.smellFilter as SmellFilter) || 'all';
    document.querySelectorAll<HTMLElement>('.smell-chip').forEach(c => {
      c.classList.toggle('active', c === chip);
    });
    void renderSmellGallery();
  });
});
(document.getElementById('smellSort') as HTMLSelectElement | null)?.addEventListener('change', (ev) => {
  smellSort = (ev.target as HTMLSelectElement).value as SmellSort;
  void renderSmellGallery();
});
document.getElementById('smellSurprise')?.addEventListener('click', () => {
  const pool = visibleSmellCards();
  if (!pool.length) { void renderSmellGallery(); return; }
  openSmellDetail(pool[Math.floor(Math.random() * pool.length)]);
});
// "/" focuses the gallery search unless the person is already typing somewhere.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== '/' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const t = ev.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  const panel = document.getElementById('panel-explore');
  if (!panel?.classList.contains('active')) return;
  ev.preventDefault();
  document.getElementById('smellSearch')?.focus();
});

document.getElementById('smellImport')?.addEventListener('click', () => {
  // The gallery front door should not make a person hunt for the Sessions tab
  // just to add a recording.
  document.getElementById('libImport')?.click();
});
document.getElementById('smellCapture')?.addEventListener('click', () => {
  if (!isStreamingActive()) {
    showToast('Connect your e-nose to capture a smell — or Import a CSV.');
    return;
  }
  openRecordModal();
});

// === Smell Card — the unit of sharing ===
// One image that carries the thing a person actually wants to send someone:
// what this smell did to this array, how many recordings back it, where the
// data came from, and what it does *not* claim. The caveat is not decoration —
// it is the reason the number is trustworthy.
function smellSource(card: SmellCardData): string {
  return sourceForRecords(card.groupRecords || card.records);
}

function sourceForRecords(records: SessionRecord[]): string {
  const paths = records.map(r => r.path || '');
  // Keep the everyday provenance short. The full citation, institution, and
  // licence live in Datasets and NOTICE — repeating "MIT Media Lab" on every
  // card, check, and share image reads like an endorsement badge.
  if (paths.length && paths.every(p => p.includes('/SmellNet/'))) {
    return 'SmellNet';
  }
  const own = paths.some(p => p.includes('Osmograph_Recordings/') && !p.includes('/SmellNet/'));
  if (own) return 'Recorded on this rig';
  return 'Imported';
}

function drawSmellCardCanvas(card: SmellCardData): HTMLCanvasElement {
  const W = 1000, H = 760, dpr = 2;
  const c = document.createElement('canvas');
  c.width = W * dpr;
  c.height = H * dpr;
  const ctx = c.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const sans = '"Geist", "Inter", system-ui, sans-serif';
  const mono = 'ui-monospace, "SF Mono", Menlo, monospace';

  ctx.fillStyle = '#f8f4ea';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#e4dac6';
  ctx.lineWidth = 2;
  ctx.strokeRect(14, 14, W - 28, H - 28);

  // Header
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#8a7f6c';
  ctx.font = `600 12px ${mono}`;
  ctx.fillText('O S M O G R A P H', 44, 56);
  ctx.textAlign = 'right';
  ctx.fillText('SMELL CARD', W - 44, 56);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#1d1a16';
  ctx.font = `600 40px ${sans}`;
  ctx.fillText(titleCase(card.substance), 44, 110);

  const width = card.channels.length || card.records[0]?.sensors || 0;
  const groupN = card.groupRecords?.length || card.records.length;
  const used = card.usedInMean || Math.min(3, groupN);
  const other = Math.max(0, card.records.length - groupN);
  ctx.fillStyle = '#6b6152';
  ctx.font = `400 14px ${sans}`;
  const metaBits = [
    `${groupN} recording${groupN === 1 ? '' : 's'} on this array`,
    `mean of ${used}`,
    `${width}-channel array`,
    'baseline-relative',
  ];
  if (other > 0) metaBits.push(`${other} on another array`);
  ctx.fillText(metaBits.join('   ·   '), 44, 138);

  ctx.strokeStyle = '#e4dac6';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(44, 160);
  ctx.lineTo(W - 44, 160);
  ctx.stroke();

  // Fingerprint — the hero. The pattern across channels is the identity; the
  // signed bars below carry amplitude and polarity.
  ctx.textAlign = 'left';
  ctx.fillStyle = '#1d1a16';
  ctx.font = `600 13px ${mono}`;
  ctx.fillText('FINGERPRINT', 44, 196);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#8a7f6c';
  ctx.font = `400 11px ${sans}`;
  ctx.fillText('mean settled response per channel · shared scale', W - 44, 196);

  if (card.values?.length) {
    drawFingerprintInto(ctx, 44, 206, W - 88, 246, card.values, card.channels, { labels: true, clear: false });
  } else {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#a99e8b';
    ctx.font = `400 13px ${sans}`;
    ctx.fillText('No channel series available for this recording.', W / 2, 330);
  }

  ctx.strokeStyle = '#e4dac6';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(44, 484);
  ctx.lineTo(W - 44, 484);
  ctx.stroke();

  const values = card.values || [];
  const max = Math.max(...values.filter(Number.isFinite).map(v => Math.abs(v)), 1e-9);

  // Left: signed settled response — polarity is real information.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#1d1a16';
  ctx.font = `600 12px ${mono}`;
  ctx.fillText('SETTLED RESPONSE', 44, 512);
  ctx.fillStyle = '#8a7f6c';
  ctx.font = `400 10px ${sans}`;
  ctx.fillText('teal = reducing · amber = oxidising', 44, 528);

  const trackX = 112, trackW = 310, valX = 470;
  const zx = trackX + trackW / 2;
  const rowH = Math.min(27, 156 / Math.max(1, values.length));
  for (let i = 0; i < values.length; i++) {
    const y = 548 + i * rowH;
    const label = (card.channels[i] || `CH${i + 1}`);
    const v = values[i];
    ctx.fillStyle = '#3a342c';
    ctx.font = `500 11px ${mono}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label.slice(0, 10), 44, y);

    ctx.strokeStyle = '#eee5d5';
    ctx.beginPath();
    ctx.moveTo(trackX, y);
    ctx.lineTo(trackX + trackW, y);
    ctx.stroke();
    ctx.strokeStyle = '#cfc3ab';
    ctx.beginPath();
    ctx.moveTo(zx, y - 7);
    ctx.lineTo(zx, y + 7);
    ctx.stroke();

    if (Number.isFinite(v)) {
      const w = Math.min(Math.abs(v) / max, 1) * (trackW / 2);
      ctx.fillStyle = v < 0 ? '#b45309' : '#0f6f86';
      if (v < 0) ctx.fillRect(zx - w, y - 5, w, 10);
      else ctx.fillRect(zx, y - 5, w, 10);
    }

    ctx.fillStyle = Number.isFinite(v) ? '#3a342c' : '#a99e8b';
    ctx.font = `500 10px ${mono}`;
    ctx.textAlign = 'right';
    ctx.fillText(Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : 'n/a', valX, y);
  }

  // Right: what the picture means. The caveat is part of the artifact.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#1d1a16';
  ctx.font = `600 12px ${mono}`;
  ctx.fillText('WHAT THIS IS', 540, 512);
  ctx.fillStyle = '#3a342c';
  ctx.font = `500 13px ${sans}`;
  ctx.fillText(smellSource(card), 540, 538);
  ctx.fillStyle = '#6b6152';
  ctx.font = `400 11px ${sans}`;
  const notes = [
    "One axis is one sensor's mean settled response.",
    'The pattern across channels is the fingerprint.',
    'Teal = reducing, amber = oxidising. Hollow = no signal.',
    'Different arrays give different fingerprints; never blend them.',
    'A measurement of this array, not a chemical identification.',
  ];
  notes.forEach((line, i) => ctx.fillText(line, 540, 562 + i * 20));

  ctx.strokeStyle = '#e4dac6';
  ctx.beginPath();
  ctx.moveTo(44, 706);
  ctx.lineTo(W - 44, 706);
  ctx.stroke();
  ctx.fillStyle = '#8a7f6c';
  ctx.font = `400 10px ${mono}`;
  ctx.fillText(`mean of ${used} recording${used === 1 ? '' : 's'} · baseline-relative ΔR/R0`, 44, 730);
  ctx.textAlign = 'right';
  ctx.fillText('OSMOGRAPH', W - 44, 730);
  return c;
}

async function exportSmellCard(card: SmellCardData): Promise<void> {
  // The gallery fills lazily; a save click can land before the first paint.
  // Load the same dominant-array mean the card shows instead of failing.
  const fp = await ensureMean(card);
  if (!fp || !fp.values.some(Number.isFinite)) {
    await flashStatus('smellsSub', 'This smell has no usable channel series to export.');
    return;
  }
  const safe = card.substance.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  await exportCanvasPng(drawSmellCardCanvas(card), `osmograph-smell-${safe}.png`);
}

// The single translation from the Rust session index to UI records. Both the
// library load and the Train-tab refresh must go through it — assigning the raw
// index straight into `sessions` silently drops `time`/`path` and leaves the
// Train table full of "undefined".
interface RawSessionRecord {
  file_id: string; substance: string; preparation?: string; role?: string; label: string; timestamp: number;
  duration_sec: number; sensor_count: number; quality: number; csv_path: string;
  quality_report: string | null;
  collection_id?: string; collection_name?: string; split?: string; condition?: string;
  mixture?: { name: string; fraction?: number | null }[];
}

function mapIndexRecords(records: RawSessionRecord[]): SessionRecord[] {
  return records.map(r => {
    let report: QualityReport | null = null;
    if (r.quality_report) {
      try { report = JSON.parse(r.quality_report) as QualityReport; } catch { /* provisional */ }
    }
    // Prefer the full analyzed score when available; fall back to the
    // provisional heuristic only when no real report exists yet.
    let quality = r.quality;
    if (report && typeof report.total === 'number') quality = Math.round(report.total);
    return {
      id: `s-${r.file_id}`,
      time: fmtLibTime(r.timestamp),
      substance: r.substance && r.substance !== 'unknown' ? r.substance : 'Unknown',
      preparation: r.preparation || '',
      role: r.role || '',
      label: r.label,
      format: 'CSV',
      duration: `${Math.round(r.duration_sec)}s`,
      sensors: r.sensor_count,
      quality,
      path: r.csv_path,
      file_id: r.file_id,
      quality_report: report,
      collection_id: r.collection_id,
      collection_name: r.collection_name,
      split: r.split,
      condition: r.condition,
      mixture: Array.isArray(r.mixture) ? r.mixture : [],
    };
  });
}

/// Install the bundled recording and open it in the replay panel. This is the
/// no-hardware path: a real SmellNet file (MIT) copied into the library and
/// then replayed. Every replay surface stamps it REPLAY — it never feeds the
/// detector or the classifier.
async function openPlayground(): Promise<void> {
  try {
    const rec = await invoke<RawSessionRecord>('install_playground_sample');
    await reloadLibrary();
    showWorkspaceView('sessions');
    const sel = document.getElementById('replaySession') as HTMLSelectElement | null;
    if (sel && rec?.file_id) {
      populateReplaySelect();
      sel.value = rec.file_id;
    }
    openReplayPanel();
    await loadReplay();
    showToast('Playground loaded — a real SmellNet recording (MIT). Replay only; no rig needed.');
  } catch (e) {
    showToast(`Playground unavailable: ${e}`);
  }
}

async function reloadLibrary() {
  try {
    compareSeriesCache.clear();
    rigHealthCache.clear();
    smellCacheGen++;
    smellFpCache.clear();
    smellFpPending.clear();
    smellRepCache.clear();
    await invoke('import_recordings');
    sessions = mapIndexRecords(await invoke<RawSessionRecord[]>('get_session_index'));
  } catch (e) {
    console.error('Library reload failed:', e);
  }
  renderLibrary();
  renderTrain();
  if (document.getElementById('src-smells')?.classList.contains('active')) void renderSmellGallery();
  if (document.getElementById('src-check')?.classList.contains('active')) void renderCheckView(true);
  autoInspectOwnRig();
}

// Recover recordings that were interrupted before save (a crash left a
// `.journal` behind). Offered once on boot, then the recovered `.osmell` files
// are indexed into the library. Never blocks — a failure just logs.
async function checkRecoveredSessions() {
  try {
    const leftover = await invoke<Array<{
      journal_path: string; label: string; preset: string;
      rec_start_epoch_ms: number; baseline_sec: number; exposure_sec: number;
      recovery_sec: number; n_sensors: number; sample_count: number;
    }>>('recover_phase_sessions');
    if (!leftover.length) return;
    const ok = window.confirm(
      `Osmograph found ${leftover.length} recording${leftover.length === 1 ? '' : 's'} that ${leftover.length === 1 ? 'was' : 'were'} interrupted before saving (e.g. a crash). ` +
      `Recover ${leftover.length} session${leftover.length === 1 ? '' : 's'} so nothing is lost?`
    );
    if (!ok) return;
    let recovered = 0;
    for (const s of leftover) {
      try {
        await invoke('recover_phase_session', { journalPath: s.journal_path });
        recovered++;
      } catch (e) {
        console.error('Recovery failed for', s.journal_path, e);
      }
    }
    if (recovered > 0) {
      showToast(`Recovered ${recovered} interrupted session${recovered === 1 ? '' : 's'} — check Explore.`);
      await reloadLibrary();
      await refreshTrainLibrary();
    }
  } catch (e) {
    console.error('Recovery scan failed:', e);
  }
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

/** Open the recipe workbench with a trim step already targeted at the selected
 *  recording. Run previews the cut; Save .osmell adds the derived recording
 *  back to the library. This is the edit path; the original is never overwritten. */
function openTrimEditorForSession(): void {
  const rec = sessions[selectedSession ?? -1];
  if (!rec?.file_id) {
    void flashStatus('libStatus', 'Select an indexed recording first.');
    return;
  }
  showWorkspaceView('recipes');
  void (async () => {
    await ensureRecipeOps();
    const raw = parseFloat((rec.duration || '').replace(/[^0-9.]/g, ''));
    const end = Number.isFinite(raw) && raw > 0 ? Math.round(raw * 10) / 10 : 10;
    const base = (rec.substance && rec.substance !== 'unknown' ? rec.substance : rec.label) || 'Recording';
    openRecipeEditor({
      id: `trim-${rec.file_id!.slice(0, 8)}-${Date.now().toString(36)}`,
      name: `${base} trimmed`,
      version: '1.0.0',
      source: `osmell:${rec.file_id}`,
      steps: [{ op: 'trim.range', channel: null, params: { start: 0, end } }],
      notes: '',
    });
    const msg = document.getElementById('recMsg');
    if (msg) {
      msg.style.color = 'var(--text-3)';
      msg.textContent = `Trim ${base}: set start/end seconds, Run to preview, Save .osmell to keep a derived recording.`;
    }
  })();
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
    inspectorFpToken++;
    inspectorSeries = null;
    inspectorFingerprint = null;
    drawInspectorFingerprint();
  } catch (e) {
    await flashStatus('libStatus', `Delete failed: ${e}`, 'var(--red)');
  }
});

document.getElementById('inspTrim')?.addEventListener('click', () => openTrimEditorForSession());

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

// === Reset & Forget (System -> Data) ===
const resetScopeEl = document.getElementById('resetScope') as HTMLSelectElement | null;
const resetConfirmEl = document.getElementById('resetConfirm') as HTMLInputElement | null;
const resetDoEl = document.getElementById('resetDo') as HTMLButtonElement | null;
const resetStatusEl = document.getElementById('resetStatus');

function updateResetDoState() {
  if (resetDoEl && resetConfirmEl) {
    resetDoEl.disabled = resetConfirmEl.value.trim().toUpperCase() !== 'RESET';
  }
}
resetConfirmEl?.addEventListener('input', updateResetDoState);
resetScopeEl?.addEventListener('change', () => { if (resetConfirmEl) resetConfirmEl.value = ''; updateResetDoState(); });

async function resetSettings() {
  const keys = [CP_KEY, LAST_CONN_KEY, PERIPH_KEY, HW_KEY, CALIB_KEY];
  keys.forEach(k => localStorage.removeItem(k));
  customPresets = [];
  calibrationPerChannel = [];
  if (peripheralState) Object.keys(peripheralState).forEach(k => { (peripheralState as unknown as Record<string, unknown>)[k] = false; });
  try { persistPeripheralState(); } catch { /* ignore */ }
}

resetDoEl?.addEventListener('click', async () => {
  if (!resetDoEl || resetDoEl.disabled) return;
  if (!resetConfirmEl || resetConfirmEl.value.trim().toUpperCase() !== 'RESET') return;
  resetDoEl.disabled = true;
  const scope = resetScopeEl?.value || 'recordings';
  if (resetStatusEl) resetStatusEl.textContent = '';
  try {
    let removed = 0;
    if (scope === 'recordings' || scope === 'all') {
      removed = await invoke<number>('clear_recordings');
    }
    if (scope === 'settings' || scope === 'all') {
      await resetSettings();
    }
    sessions = [];
    selectedSession = -1;
    compareFiles = [];
    renderLibrary();
    loadCustomPresets();
    loadHardwareProfile();
    renderHardwareProfile();
    loadCalibration();
    renderEnvReadout(null);
    if (resetConfirmEl) resetConfirmEl.value = '';
    updateResetDoState();
    const what = scope === 'all' ? 'Everything' : scope === 'settings' ? 'Settings' : 'Recordings';
    if (resetStatusEl) {
      resetStatusEl.textContent = `${what} reset — ${removed} recording(s) removed.`;
      resetStatusEl.style.color = 'var(--green)';
    }
  } catch (e) {
    if (resetStatusEl) {
      resetStatusEl.textContent = `Reset failed: ${e}`;
      resetStatusEl.style.color = 'var(--red)';
    }
  } finally {
    resetDoEl.disabled = false;
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
document.getElementById('trainStarter')?.addEventListener('click', async () => {
  const starter = document.getElementById('trainStarter') as HTMLButtonElement;
  if (selectStarterTrainingSet() < 2) return;
  const nameEl = document.getElementById('trainName') as HTMLInputElement;
  if (!nameEl.value.trim()) nameEl.value = 'smellnet_model';
  renderTrain();
  starter.disabled = true;
  try {
    await trainClassifier();
  } finally {
    starter.disabled = false;
  }
});
document.getElementById('trainRefresh')!.addEventListener('click', refreshTrainLibrary);
document.getElementById('trainSep')?.addEventListener('click', () => showWorkspaceView('check'));
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

function setFleetRemotePanel(open: boolean): void {
  const panel = document.getElementById('fleetRemotePanel');
  if (panel) panel.hidden = !open;
  if (open) {
    const input = document.getElementById('fleetRemoteAddr') as HTMLInputElement | null;
    input?.focus();
    input?.select();
  }
}

document.getElementById('fleetRemote')?.addEventListener('click', () => setFleetRemotePanel(true));
document.getElementById('fleetRemoteCancel')?.addEventListener('click', () => setFleetRemotePanel(false));
document.getElementById('fleetRemoteAddr')?.addEventListener('keydown', (ev) => {
  if ((ev as KeyboardEvent).key === 'Enter') (document.getElementById('fleetRemoteConnect') as HTMLButtonElement | null)?.click();
});
document.getElementById('fleetRemoteConnect')?.addEventListener('click', async () => {
  const addrEl = document.getElementById('fleetRemoteAddr') as HTMLInputElement | null;
  const msg = document.getElementById('fleetRemoteMsg');
  const button = document.getElementById('fleetRemoteConnect') as HTMLButtonElement | null;
  const addr = addrEl?.value.trim() || '';
  if (!addr) { if (msg) msg.textContent = 'Enter host:port first.'; return; }
  if (connected) { if (msg) msg.textContent = 'Disconnect the current link first.'; return; }
  if (msg) msg.textContent = 'Connecting…';
  if (button) button.disabled = true;
  const modeSel = document.getElementById('modeSelect') as HTMLSelectElement;
  modeSel.value = 'wifi';
  modeSel.dispatchEvent(new Event('change'));
  const wifiAddr = document.getElementById('wifiAddr') as HTMLInputElement;
  wifiAddr.value = addr;
  try {
    await toggleConnection();
    if (connected) {
      if (msg) msg.textContent = 'Connected. Opening the live view…';
      setFleetRemotePanel(false);
      activateWorkspace('dashboard');
    } else if (msg) {
      msg.textContent = 'Could not connect. Check the endpoint, WiFi, and that the device is streaming.';
    }
  } catch (e) {
    if (msg) msg.textContent = String(e).replace(/^Error invoking remote method '.*': /, '').replace(/^Error:\s*/, '');
  } finally {
    if (button) button.disabled = false;
  }
});

document.getElementById('fleetGrid')?.addEventListener('click', (ev) => {
  const t = ev.target as HTMLElement;
  if (t.id === 'fleetEmptyScan') document.getElementById('fleetScan')?.click();
  else if (t.id === 'fleetEmptyRemote') setFleetRemotePanel(true);
  else if (t.id === 'fleetEmptyHome') activateWorkspace('dashboard');
  else if (t.id === 'fleetEmptySmells') showWorkspaceView('smells');
  else if (t.closest('[data-fleet-live]')) activateWorkspace('dashboard');
  else if (t.closest('[data-fleet-vials]')) showWorkspaceView('vials');
});
document.getElementById('fleetGrid')?.addEventListener('change', (ev) => {
  const select = (ev.target as HTMLElement).closest<HTMLSelectElement>('.fleet-vial-select');
  if (!select) return;
  if (!select.value) {
    clearHomeTakeover();
    setSelectedHomeVialId('');
    showToast('Core instrument Home restored.');
    return;
  }
  const pack = Domain.domainPackById(select.value);
  if (!pack?.home) {
    select.value = selectedHomeVialId() || '';
    showToast('That Home Vial is no longer installed.');
    return;
  }
  if (pack.homeUi) {
    if (!resolveDomainUiHtml(pack, 'home')) {
      select.value = selectedHomeVialId() || '';
      showToast(`${pack.name} Home view is not cached. Reinstall the Vial to fetch it.`);
      return;
    }
    activateHomeTakeover(pack.id);
    if (homeTakeoverVialId === pack.id) showToast(`${pack.name} is now Home.`);
    return;
  }
  clearHomeTakeover();
  setSelectedHomeVialId(pack.id);
  showToast(`${pack.name} is set as the Home summary.`);
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

// === Detection Sensitivity (live anomaly-tuning) ===
// Mirrors the BuzzerConfig persistence pattern: pull the Rust-side
// opensmell::DetectionConfig, push it back on change — the backend applies it
// to every ensemble detector immediately.
interface DetectionConfigApi {
  smoothing_alpha: number;
  drift_alpha: number;
  sensitivity: number;
}
let detectionConfig: DetectionConfigApi = { smoothing_alpha: 0.6, drift_alpha: 0.002, sensitivity: 1.0 };

async function loadDetectionConfig() {
  try {
    detectionConfig = await invoke<DetectionConfigApi>('detection_get_config');
  } catch (e) { console.error('detection_get_config failed:', e); }
  applyDetectionToDom();
}
function saveDetectionToRust() {
  invoke('detection_set_config', { config: detectionConfig }).catch(e => console.error('detection_set_config failed:', e));
}
function captureDetectionFromDom() {
  detectionConfig.sensitivity = Number((document.getElementById('detSensitivity') as HTMLInputElement).value) || 1.0;
  saveDetectionToRust();
}
function applyDetectionToDom() {
  const el = document.getElementById('detSensitivity') as HTMLInputElement | null;
  if (el) el.value = String(detectionConfig.sensitivity);
  const sv = document.getElementById('detSensitivityVal');
  if (sv) sv.textContent = `${detectionConfig.sensitivity.toFixed(1)}×`;
}

// The dual-Kalman engine ignores the legacy smoothing/drift fields, so the UI
// exposes only the control that actually reaches it.
document.getElementById('detSensitivity')!.addEventListener('change', () => { captureDetectionFromDom(); });
document.getElementById('detSensitivity')!.addEventListener('input', (e) => {
  document.getElementById('detSensitivityVal')!.textContent = `${(e.target as HTMLInputElement).value}×`;
});

// Load once at startup: prefer Rust-side defaults (fresh), fall back to saved local.
loadPeripheralState();
applyOledToDom(); applyBuzzerToDom(); syncPeripheralUI();
updateBuzzerPreviews(); updateOledPreview();
loadDetectionConfig();

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
const PHASE_COLORS: Record<string, string> = { baseline: cssToken('--text-0'), exposure: cssToken('--red'), recovery: cssToken('--cyan') };

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
  const frec = document.getElementById('fRec');
  if (frec) {
    frec.textContent = s.active ? `${s.label} · ${s.current_phase_label}` : '—';
    frec.style.color = s.active ? 'var(--red)' : '';
  }
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
    time: fmtLibTime(Date.now() / 1000),
    substance: summary.label === 'unknown' ? 'Unknown' : summary.label,
    label: 'Recorded',
    format: 'OSMELL',
    duration: `${Math.floor(summary.total_duration)}s`,
    sensors: summary.phases.length > 0 ? chNames.length : 0,
    quality: summary.quality_score,
    path: summary.path,
    file_id: summary.file_id,
  });
  // A new replicate changes the fingerprint and the confusability verdict.
  // Invalidate the derived caches and refresh the front door if it is visible,
  // so recording a second sample has a visible effect immediately.
  smellCacheGen++;
  smellFpCache.clear();
  smellFpPending.clear();
  smellRepCache.clear();
  rigHealthCache.clear();
  renderLibrary();
  if (document.getElementById('src-smells')?.classList.contains('active')) void renderSmellGallery();
  if (document.getElementById('src-check')?.classList.contains('active')) void renderCheckView(true);
}

async function stopPhaseRecordingFromUI() {
  autoFinalized = true; // claim finalize so the poll loop can't double-fire
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

// Adaptive phase-recorder polling: while a recording runs (or its modal is on
// screen) we need fresh state every 500 ms for the HUD and auto-finalize; once
// idle a slow 4 s heartbeat still catches externally-started recordings without
// burning an IPC round-trip every half second for nothing.
let phasePollBusy = false;
let phasePollTimer: number | null = null;

async function phasePollTick() {
  if (!phasePollBusy) {
    phasePollBusy = true;
    try {
      await pollPhaseRecorder();
    } finally {
      phasePollBusy = false;
    }
  }
  const fast = recPhaseActive || prevPhaseActive || document.getElementById('recordModal')?.style.display === 'flex';
  phasePollTimer = window.setTimeout(phasePollTick, fast ? 500 : 4000);
}

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
  const foot = document.getElementById('fBurnin');
  if (foot) {
    foot.textContent = s.is_complete
      ? 'done'
      : s.running
        ? `${fmtClock(s.remaining_seconds)} left`
        : s.elapsed_seconds > 0
          ? 'paused'
          : 'idle';
  }
  const total = s.total_hours * 3600;
  const pct = total > 0 ? Math.min(100, (s.elapsed_seconds / total) * 100) : 0;
  document.getElementById('burninBar')!.style.width = `${pct.toFixed(1)}%`;
  const elapsedEl = document.getElementById('burninElapsed');
  if (elapsedEl) {
    const hours = s.total_hours;
    elapsedEl.textContent = s.is_complete
      ? `${hours}h complete — sensors should be stable now`
      : `${fmtClock(s.elapsed_seconds)} of ${hours}h elapsed`;
  }
  const startBtn = document.getElementById('burninStart') as HTMLButtonElement | null;
  const statusEl = document.getElementById('burninStatus');
  if (startBtn) {
    // Explicit label — the timer is a Start/Pause, never a hidden toggle.
    startBtn.textContent = s.is_complete ? 'Restart' : (s.running ? 'Pause' : 'Start');
    startBtn.classList.toggle('green', !s.running);
    startBtn.classList.toggle('blue', s.running);
  }
  if (statusEl) {
    const label = s.is_complete
      ? 'Complete'
      : s.running
        ? 'Running — counting down'
        : s.elapsed_seconds > 0
          ? 'Paused'
          : 'Waiting to start';
    statusEl.textContent = label;
  }
}

// Local 1 s tick so the countdown visibly moves between backend polls and
// never looks frozen. Mirrors the wall-clock reconcile the backend already does.
let burninLocal: BurnInStatus | null = null;
function burninTick() {
  if (burninLocal && burninLocal.running && !burninLocal.is_complete) {
    const remaining = Math.max(0, burninLocal.remaining_seconds - 1);
    const total = burninLocal.total_hours * 3600;
    const elapsed = Math.min(total, total - remaining);
    burninLocal = { ...burninLocal, remaining_seconds: remaining, elapsed_seconds: elapsed };
    renderBurnIn(burninLocal);
  }
}
setInterval(burninTick, 1000);

async function refreshBurnIn() {
  try {
    const s = await invoke<BurnInStatus>('burnin_get_status');
    burninLocal = s;
    renderBurnIn(s);
  } catch {}
}

document.getElementById('burninStart')!.addEventListener('click', async () => {
  try {
    const raw = (document.getElementById('burninHours') as HTMLInputElement).value.trim();
    const hours = raw === '' ? undefined : parseFloat(raw);
    const s = await invoke<BurnInStatus>('burnin_start', { hours });
    burninLocal = s;
    renderBurnIn(s);
  } catch (e) {
    console.error('Burn-in start failed:', e);
  }
});

document.getElementById('burninReset')!.addEventListener('click', async () => {
  const hrs = parseFloat((document.getElementById('burninHours') as HTMLInputElement).value) || 24;
  try {
    const s = await invoke<BurnInStatus>('burnin_reset', { hours: hrs });
    burninLocal = s;
    renderBurnIn(s);
  } catch (e) {
    console.error('Burn-in reset failed:', e);
  }
});


// === Datasets catalog ===
// A dataset has to answer four questions before a person commits: what is inside,
// how big is the fetch, what may I do with it, and where does it land? The card
// carries all four. Downloads still come from the original source, never a mirror.
type RecordingSource = {
  id: string;
  name: string;
  label: string;
  license?: string;
  credit?: string;
  citation?: string;
  url?: string;
  datasetId?: string;
};

const DATASET_BY_ID = new Map(DATASET_CATALOG.map(d => [d.id, d]));
const DATASET_SOURCE_NAME: Record<string, string> = {
  'smellnet': 'SmellNet',
  'smellnet-mixtures': 'SmellNet mixtures',
  'food-freshness': 'Food Freshness',
  'tadi-2019': 'TADI',
};

function pathHas(path: string | undefined, re: RegExp): boolean {
  return !!path && re.test(path.replace(/\\/g, '/'));
}

const COLLECTION_SOURCES: Record<string, RecordingSource> = {
  'smellnet': {
    id: 'smellnet',
    name: 'SmellNet',
    label: 'SmellNet',
    license: 'MIT',
    credit: 'Feng et al. · MIT-MI (2026)',
    citation: 'Feng, Dai, Li, Pernigo, Wen & Liang (2026). SmellNet. MIT-MI. https://huggingface.co/datasets/DeweiFeng/SmellNet',
    url: 'https://huggingface.co/datasets/DeweiFeng/SmellNet',
    datasetId: 'smellnet',
  },
  'smellnet-mixtures': {
    id: 'smellnet-mixtures',
    name: 'SmellNet mixtures',
    label: 'SmellNet mixture',
    license: 'MIT',
    credit: 'Feng et al. · MIT-MI (2026)',
    citation: 'Feng, Dai, Li, Pernigo, Wen & Liang (2026). SmellNet. MIT-MI. https://huggingface.co/datasets/DeweiFeng/SmellNet',
    url: 'https://huggingface.co/datasets/DeweiFeng/SmellNet',
    datasetId: 'smellnet-mixtures',
  },
  'tadi-2019': {
    id: 'tadi-2019',
    name: 'TADI',
    label: 'TADI methane release',
    license: 'CC BY 4.0',
    credit: 'Gladston et al. · Zenodo (2023)',
    citation: 'Gladston, A. et al. (2023). Dataset for using metal oxide gas sensors for the estimate of methane controlled releases. Zenodo. https://doi.org/10.5281/zenodo.8399829',
    url: 'https://zenodo.org/records/8399829',
    datasetId: 'tadi-2019',
  },
  'food-freshness': {
    id: 'food-freshness',
    name: 'Food Freshness',
    label: 'Food Freshness E-Nose',
    license: 'CC BY 4.0',
    credit: 'Mahdian · Zenodo (2025)',
    citation: 'Mahdian, M. (2025). Food Freshness E-Nose Dataset. Zenodo. https://zenodo.org/records/17285312',
    url: 'https://zenodo.org/records/17285312',
    datasetId: 'food-freshness',
  },
  'legacy': { id: 'legacy', name: 'Legacy', label: 'Legacy import' },
  'derived': { id: 'derived', name: 'Derived', label: 'Derived locally' },
  'own': { id: 'own', name: 'Own rig', label: 'Recorded on this rig' },
  'commons': { id: 'commons', name: 'Data Commons', label: 'Community contribution' },
  'imported': { id: 'imported', name: 'Imported', label: 'Imported file' },
};

/** Provenance for one recording. Short in the table, complete in the inspector. */
function recordingSource(s: SessionRecord): RecordingSource {
  if (s.collection_id && COLLECTION_SOURCES[s.collection_id]) {
    return COLLECTION_SOURCES[s.collection_id];
  }
  if (s.collection_id && s.collection_id !== 'imported') {
    return {
      id: s.collection_id,
      name: s.collection_name || s.collection_id,
      label: s.collection_name || 'Imported file',
    };
  }
  // Legacy fallback for indexes written before collection metadata existed.
  const p = (s.path || '').replace(/\\/g, '/');
  if (pathHas(p, /\/Derived\//i)) {
    return COLLECTION_SOURCES.derived;
  }
  if (pathHas(p, /SmellNet-mixtures/i)) {
    return COLLECTION_SOURCES['smellnet-mixtures'];
  }
  if (pathHas(p, /SmellNet/i)) {
    return COLLECTION_SOURCES.smellnet;
  }
  if (pathHas(p, /TADI-2019/i)) {
    return COLLECTION_SOURCES['tadi-2019'];
  }
  if (pathHas(p, /AllSmaples-Report|Food[- ]Freshness|datasets\/extracted/i)) {
    return COLLECTION_SOURCES['food-freshness'];
  }
  if (pathHas(p, /\/legacy\//i)) {
    return COLLECTION_SOURCES.legacy;
  }
  if (pathHas(p, /Osmograph_Recordings/i) || s.label === 'Recorded') {
    return COLLECTION_SOURCES.own;
  }
  return COLLECTION_SOURCES.imported;
}

type SourceBucket = { source: RecordingSource; records: SessionRecord[]; smells: Set<string> };

function librarySources(): SourceBucket[] {
  const map = new Map<string, SourceBucket>();
  for (const s of sessions) {
    const source = recordingSource(s);
    let bucket = map.get(source.id);
    if (!bucket) {
      bucket = { source, records: [], smells: new Set() };
      map.set(source.id, bucket);
    }
    bucket.records.push(s);
    const mixture = Array.isArray(s.mixture) && s.mixture.length >= 2;
    if (!mixture && s.role !== 'reference' && s.role !== 'noise'
      && s.substance && s.substance.toLowerCase() !== 'unknown') {
      bucket.smells.add(s.substance.toLowerCase());
    }
  }
  return [...map.values()].sort((a, b) => b.records.length - a.records.length || a.source.name.localeCompare(b.source.name));
}

function datasetLocalCount(id: string): number {
  return sessions.filter(s => recordingSource(s).datasetId === id).length;
}

interface CollectionSummary {
  folder: string;
  root: string;
  id: string;
  name: string;
  description: string;
  source_url: string;
  citation: string;
  credit: string;
  licence: string;
  licence_url: string;
  commercial_use: boolean;
  publishable: boolean;
  rearranged: boolean;
  has_manifest: boolean;
  manifest_path: string | null;
  manifest_hash: string;
  retrieved_at: string;
  files: number;
  bytes: number;
  disk_files: number;
  disk_bytes: number;
  transformations: string[];
  manifest_error: string | null;
}

interface ManifestVerification {
  folder: string;
  root: string;
  ok: boolean;
  checked: number;
  missing: string[];
  changed: string[];
  extra: string[];
  manifest_hash: string;
}

interface CollectionMeta {
  id: string;
  name: string;
  description: string;
  sourceUrl: string;
  citation: string;
  credit: string;
  licenceId: string;
  licenceUrl: string;
  commercialUse: boolean;
  attributionRequired: boolean;
  shareAlike: boolean;
  redistribution: string;
  licenceNotes: string;
  rearranged: boolean;
  publishable: boolean;
  transformations: string[];
  layoutKind: string;
  splitFolders: Record<string, string>;
  substanceSource: string;
  conditionSource: string;
}

let collectionSummaries: CollectionSummary[] = [];

function datasetDestName(d: DatasetEntry): string {
  const dl = d.download;
  if (!dl) return '';
  if (dl.destName) return dl.destName;
  if (dl.archive && dl.filename) return dl.filename.replace(/\.zip$/i, '');
  return '';
}

function collectionForDataset(d: DatasetEntry): CollectionSummary | null {
  const dest = datasetDestName(d);
  return collectionSummaries.find((s) => s.id === d.id || (dest && s.folder === dest)) || null;
}

function collectionForSource(source: RecordingSource): CollectionSummary | null {
  if (!source.datasetId) return null;
  return collectionSummaries.find((s) => s.id === source.datasetId || s.id === source.id) || null;
}

function collectionMetaFor(d: DatasetEntry, archive: boolean): CollectionMeta {
  const dest = datasetDestName(d) || d.id;
  const splitFolders: Record<string, string> = {};
  if (d.id === 'smellnet') {
    splitFolders.Training = 'base_data/training';
    splitFolders.Testing = 'base_data/testing';
  } else if (d.id === 'smellnet-mixtures') {
    splitFolders['test_seen'] = 'mixture_data/test_seen';
    splitFolders['test_unseen'] = 'mixture_data/test_unseen';
  }
  const transformations = [`downloaded from the original source`, `stored under datasets/${dest}`];
  if (archive) transformations.push('extracted archive preserving paths');
  return {
    id: d.id,
    name: d.name,
    description: d.what,
    sourceUrl: d.url,
    citation: d.citation || '',
    credit: d.credit,
    licenceId: d.license,
    licenceUrl: d.licenseUrl || '',
    commercialUse: d.commercial === 'yes',
    attributionRequired: !/CC0/i.test(d.license),
    shareAlike: /BY-SA/i.test(d.license),
    redistribution: /MIT|CC BY|CC0|Apache/i.test(d.license) ? 'allowed' : 'unknown',
    licenceNotes: 'Local working copy. The source terms govern reuse; this copy is not published by Osmograph.',
    rearranged: true,
    publishable: false,
    transformations,
    layoutKind: d.id,
    splitFolders,
    substanceSource: 'folder-or-filename',
    conditionSource: 'filename',
  };
}

function storeCollectionSummary(summary: CollectionSummary | null): void {
  if (!summary || !summary.folder) return;
  collectionSummaries = [
    ...collectionSummaries.filter((s) => s.folder !== summary.folder),
    summary,
  ].sort((a, b) => a.folder.localeCompare(b.folder));
}

async function loadCollectionSummaries(): Promise<void> {
  try {
    const loaded = await invoke<CollectionSummary[]>('dataset_collections');
    collectionSummaries = Array.isArray(loaded) ? loaded : [];
  } catch (e) {
    console.warn('Collection manifest scan failed:', e);
    collectionSummaries = [];
  }
}

async function writeCollectionManifest(
  d: DatasetEntry,
  ifMissing = true,
  folder?: string,
): Promise<CollectionSummary | null> {
  const dest = folder || datasetDestName(d);
  if (!dest) return null;
  try {
    const summary = await invoke<CollectionSummary>('dataset_write_manifest', {
      destName: dest,
      meta: collectionMetaFor(d, !!d.download?.archive),
      ifMissing,
    });
    storeCollectionSummary(summary);
    return summary;
  } catch (e) {
    console.warn(`Collection file for ${d.name} was not written:`, e);
    return null;
  }
}

async function verifyDataset(folder: string): Promise<void> {
  try {
    const v = await invoke<ManifestVerification>('dataset_verify', { destName: folder });
    if (v.ok) {
      showToast(`Verified ${v.checked} file${v.checked === 1 ? '' : 's'} against collection.json.`);
      return;
    }
    const parts = [
      v.missing.length ? `${v.missing.length} missing` : '',
      v.changed.length ? `${v.changed.length} changed` : '',
      v.extra.length ? `${v.extra.length} unlisted` : '',
    ].filter(Boolean);
    showToast(`Collection drift in ${v.folder}: ${parts.join(', ')}.`);
  } catch (e) {
    showToast(`Could not verify the collection: ${e}`);
  }
}

async function addLocalDataset(id: string): Promise<void> {
  const d = DATASET_BY_ID.get(id);
  if (!d) return;
  const summary = collectionForDataset(d);
  if (!summary) return;
  try {
    const imported = await invoke<SessionRecord[]>('import_paths', { paths: [summary.root] });
    await loadCollectionSummaries();
    await reloadLibrary();
    renderDatasetCatalog();
    showToast(imported.length
      ? `Added ${imported.length} recording${imported.length === 1 ? '' : 's'} from disk.`
      : 'Those recordings are already in the library.');
  } catch (e) {
    showToast(`Could not add the local copy: ${e}`);
  }
}

function fmtBytes(n?: number): string {
  if (!n || !Number.isFinite(n) || n <= 0) return '';
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
}

function renderDatasetLocal(): void {
  const host = document.getElementById('dsLocalList');
  if (!host) return;
  const buckets = librarySources();
  const recordings = sessions.length;
  const smells = new Set(sessions.map(s => (s.substance || '').trim().toLowerCase()).filter(x => x && x !== 'unknown')).size;
  const stamp = document.getElementById('dsLibraryStamp');
  if (stamp) stamp.textContent = `${recordings} recording${recordings === 1 ? '' : 's'} · ${smells} smell${smells === 1 ? '' : 's'}`;
  const localStamp = document.getElementById('dsLocalStamp');
  const manifests = collectionSummaries.filter((s) => s.has_manifest).length;
  if (localStamp) localStamp.textContent = `${buckets.length} source${buckets.length === 1 ? '' : 's'} · ${manifests} collection file${manifests === 1 ? '' : 's'}`;
  if (!buckets.length) {
    host.innerHTML = `<div class="ds-local-empty">No recordings. <button class="text-link" type="button" data-ds-import-inline>Import a CSV</button> or download a corpus below.</div>`;
    host.querySelector<HTMLElement>('[data-ds-import-inline]')?.addEventListener('click', () => (document.getElementById('dsImport') as HTMLButtonElement | null)?.click());
    return;
  }
  host.innerHTML = buckets.map(b => {
    const source = b.source;
    const dataset = source.datasetId ? DATASET_BY_ID.get(source.datasetId) : null;
    const summary = collectionForSource(source);
    const license = source.license ? `<span class="ds-source-license">${esc(source.license)}</span>` : '';
    const manifest = summary?.has_manifest
      ? `<span class="ds-source-manifest" title="Collection file · ${summary.files} files · ${esc(summary.licence || 'licence unknown')} · local copy, not published">manifest</span>`
      : '';
    const title = [
      `${b.records.length} recording${b.records.length === 1 ? '' : 's'} · ${b.smells.size} smell${b.smells.size === 1 ? '' : 's'}`,
      summary?.has_manifest ? `collection.json · ${summary.files} files` : 'no collection file yet',
      source.credit,
      source.citation,
    ].filter(Boolean).join(' · ');
    const menu = [
      `<button type="button" data-ds-open-recordings="${esc(source.name)}">Recordings</button>`,
      summary?.manifest_path ? `<button type="button" data-ds-open-manifest="${esc(summary.manifest_path)}">Collection file</button>` : '',
      summary?.manifest_path ? `<button type="button" data-ds-verify="${esc(summary.folder)}">Verify files</button>` : '',
      summary?.root ? `<button type="button" data-ds-open-folder="${esc(summary.root)}">Folder</button>` : '',
      dataset ? `<button type="button" data-ds-cite="${esc(dataset.id)}">Cite</button>` : '',
      dataset?.download ? `<button type="button" class="ds-remove" data-ds-remove="${esc(dataset.id)}">Remove from library</button>` : '',
    ].filter(Boolean).join('');
    return `<div class="ds-source${source.id === 'own' ? ' own' : ''}" title="${esc(title)}">
      <button class="ds-source-main" type="button" data-ds-open-gallery="${esc(source.name)}" aria-label="Open ${esc(source.name)} in Gallery">
        <span class="ds-source-dot"></span>
        <span class="ds-source-name">${esc(source.name)}</span>
        <span class="ds-source-count">${b.records.length}</span>
        ${manifest}
        ${license}
      </button>
      <details class="ds-row-menu">
        <summary title="More actions">⋯</summary>
        <div class="ds-row-menu-pop">${menu}</div>
      </details>
    </div>`;
  }).join('');
}

function renderDatasetCatalog() {
  const el = document.getElementById('datasetCatalog');
  if (!el) return;
  renderDatasetLocal();
  const q = (document.getElementById('dsFilter') as HTMLInputElement | null)?.value.trim().toLowerCase() || '';
  renderReferenceCatalog(q);
  const rows = DATASET_CATALOG.filter((d) =>
    !q || `${d.name} ${d.what} ${d.sensors} ${d.license} ${d.credit} ${d.note} ${d.useFor || ''} ${d.citation || ''}`.toLowerCase().includes(q));
  const filterStamp = document.getElementById('dsFilterStamp');
  if (filterStamp) filterStamp.textContent = `${rows.length} source${rows.length === 1 ? '' : 's'}`;
  if (!rows.length) {
    el.innerHTML = '<div class="hint" style="grid-column:1/-1">No datasets match. Try a broader search.</div>';
    return;
  }
  el.innerHTML = rows.map((d) => {
    const local = datasetLocalCount(d.id);
    const installed = local > 0;
    const summary = collectionForDataset(d);
    const onDisk = summary?.disk_files || 0;
    const present = onDisk > 0;
    const chips = [
      d.sensors,
      d.channels ? `${d.channels} channels` : '',
      d.smells ? `${d.smells} smells` : '',
      d.labeled ? 'labelled' : 'unlabelled',
      d.size,
    ].filter(Boolean)
      .map((c) => `<span class="ds-chip">${esc(c)}</span>`).join('');
    const formatClass = installed || present ? 'ready' : d.format;
    const formatLabel = installed
      ? `${local} in library`
      : present
        ? `${onDisk} on disk · not in library`
        : d.format === 'ready' ? 'Ready to open' : d.format === 'converts' ? 'Imports into Osmograph' : 'Source only';
    const license = d.licenseUrl
      ? `<a class="ds-license-link" href="${esc(d.licenseUrl)}">${esc(d.license)}</a>`
      : `<span class="ds-license-link">${esc(d.license)}</span>`;
    const sourceName = DATASET_SOURCE_NAME[d.id] || d.name;
    const primary = d.download
      ? installed
        ? `<button class="mini-btn primary" data-ds-open-gallery="${esc(sourceName)}" type="button">Open</button>`
        : present
          ? `<button class="mini-btn primary ds-add-local" data-id="${esc(d.id)}" type="button" title="Add the ${onDisk} files already on disk back to the library">Add to library</button>`
          : `<button class="mini-btn primary ds-download" data-id="${esc(d.id)}" type="button" title="Download and import${d.download.sizeBytes ? ` (${fmtBytes(d.download.sizeBytes)})` : ''}">Download</button>`
      : `<a class="mini-btn" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">Source ↗</a>`;
    const manifest = summary
      ? `<div class="ds-manifest ${summary.has_manifest ? 'ok' : 'missing'}" title="${esc(summary.manifest_hash || '')}">${summary.has_manifest
          ? `Collection file · ${summary.disk_files} file${summary.disk_files === 1 ? '' : 's'} · ${esc(summary.licence || 'licence unknown')} · private working copy`
          : 'No collection file yet'}</div>`
      : '';
    return `
    <article class="ds-card${installed ? ' installed' : ''}${present && !installed ? ' ondisk' : ''}">
      <div class="ds-card-head">
        <div style="min-width:0">
          <div class="ds-card-name">${esc(d.name)}</div>
          <div class="ds-card-credit">${esc(d.credit)}</div>
        </div>
        <span class="ds-format ${formatClass}">${formatLabel}</span>
      </div>
      <div class="ds-what">${esc(d.what)}</div>
      <div class="ds-actions">
        ${primary}
        ${d.download?.sizeBytes ? `<span class="ds-filecount">${fmtBytes(d.download.sizeBytes)}</span>` : ''}
      </div>
      <details class="ds-details">
        <summary>Details · sensors, risks, licence</summary>
        <div class="ds-details-body">
          <div class="ds-chips">${chips}</div>
          ${d.useFor ? `<div class="ds-use"><span>Use it for</span>${esc(d.useFor)}</div>` : ''}
          <div class="ds-note"><span>Watch out</span>${esc(d.note)}</div>
          <div class="ds-rights">${license}<span>${esc(d.credit)}</span></div>
          ${manifest}
          <div class="ds-details-links">
            ${d.citation ? `<button class="text-link" type="button" data-ds-cite="${esc(d.id)}">Cite</button>` : ''}
            <a class="text-link" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">Source ↗</a>
            ${summary ? `<button class="text-link" type="button" data-ds-open-folder="${esc(summary.root)}">Open folder</button>` : ''}
            ${summary?.manifest_path ? `<button class="text-link" type="button" data-ds-verify="${esc(summary.folder)}">Verify files</button>` : ''}
            ${installed ? `<button class="text-link ds-remove" type="button" data-ds-remove="${esc(d.id)}">Remove</button>` : ''}
          </div>
        </div>
      </details>
    </article>`;
  }).join('');
}

let refSelectedId = '';

function refAccess(d: DatasetEntry): { key: string; label: string } {
  if (d.commercial === 'yes') return { key: 'source', label: 'Source only' };
  if (d.commercial === 'api') return { key: 'api', label: 'API terms' };
  if (d.commercial === 'no') return { key: 'link', label: 'Link only' };
  return { key: 'research', label: 'Research only' };
}

function renderReferenceCatalog(query = ''): void {
  const host = document.getElementById('referenceCatalog');
  if (!host) return;
  const all = REFERENCE_CATALOG;
  const rows = all.filter((d) =>
    !query || `${d.name} ${d.what} ${d.sensors} ${d.size} ${d.license} ${d.credit} ${d.note}`.toLowerCase().includes(query));
  const count = document.getElementById('dsRefCount');
  if (count) count.textContent = `${all.length}`;
  const stamp = document.getElementById('dsRefStamp');
  if (stamp) stamp.textContent = `${rows.length} shown`;

  const legend = document.getElementById('dsRefLegend');
  if (legend) {
    const tiers = new Map<string, number>();
    for (const d of all) {
      const key = refAccess(d).key;
      tiers.set(key, (tiers.get(key) || 0) + 1);
    }
    legend.innerHTML = [...tiers.entries()].map(([key, n]) => {
      const label = key === 'research' ? 'Research only'
        : key === 'source' ? 'Source only'
        : key === 'api' ? 'API terms'
        : 'Link only';
      return `<span class="ds-ref-key tier-${key}"><i></i>${label} <b>${n}</b></span>`;
    }).join('');
  }

  if (!rows.length) {
    host.innerHTML = '<div class="ds-ref-empty">No reference datasets match this search.</div>';
    return;
  }
  if (!rows.some((d) => d.id === refSelectedId)) refSelectedId = rows[0].id;

  const tiles = rows.map((d) => {
    const access = refAccess(d);
    const index = `R·${String(all.indexOf(d) + 1).padStart(2, '0')}`;
    const active = d.id === refSelectedId;
    return `<button class="ds-ref-tile${active ? ' is-active' : ''}" type="button" data-ref-id="${esc(d.id)}" aria-pressed="${active}">
      <span class="ds-ref-index">${index}</span>
      <span class="ds-ref-tile-main">
        <span class="ds-ref-name">${esc(d.name)}</span>
        <span class="ds-ref-meta">${esc(d.sensors)} · ${esc(d.size)}</span>
      </span>
      <span class="ds-ref-tier tier-${access.key}">${access.label}</span>
    </button>`;
  }).join('');

  const d = rows.find((r) => r.id === refSelectedId) || rows[0];
  const access = refAccess(d);
  const index = `R·${String(all.indexOf(d) + 1).padStart(2, '0')}`;
  const license = d.licenseUrl
    ? `<a class="text-link" href="${esc(d.licenseUrl)}" target="_blank" rel="noopener noreferrer">${esc(d.license)}</a>`
    : `<span>${esc(d.license)}</span>`;
  host.innerHTML = `<div class="ds-ref-grid">${tiles}</div>
    <aside class="ds-ref-inspector" aria-label="Reference details">
      <div class="ds-ref-inspector-head">
        <span class="ds-ref-inspector-index">${index}</span>
        <span class="ds-ref-inspector-flag">${access.label} · no import</span>
      </div>
      <div class="ds-ref-inspector-name">${esc(d.name)}</div>
      <p class="ds-ref-inspector-what">${esc(d.what)}</p>
      <div class="ds-ref-inspector-note"><span>Watch out</span>${esc(d.note)}</div>
      <dl class="ds-ref-spec">
        <dt>Sensors</dt><dd>${esc(d.sensors)}</dd>
        <dt>Size</dt><dd>${esc(d.size)}</dd>
        <dt>Licence</dt><dd>${license}</dd>
        <dt>Credit</dt><dd>${esc(d.credit)}</dd>
      </dl>
      <div class="ds-ref-inspector-actions">
        <a class="text-link" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>
        <span class="ds-ref-meta">Read-only · not bundled</span>
      </div>
    </aside>`;

  host.querySelectorAll<HTMLButtonElement>('[data-ref-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.refId || '';
      if (id === refSelectedId) return;
      refSelectedId = id;
      renderReferenceCatalog(query);
      host.querySelector<HTMLButtonElement>(`[data-ref-id="${id}"]`)?.focus({ preventScroll: true });
    });
  });
}

// === Global download dock ===
// A side panel showing every in-flight fetch: real byte progress, speed/ETA, and
// Pause / Resume / Cancel. It lives at app level (not inside a card) so a running
// download is always visible and controllable, wherever you are in the app.
interface DlJob { el: HTMLElement; bar: HTMLElement; pct: HTMLElement; meta: HTMLElement; pause: HTMLButtonElement; d: DatasetEntry; }

function dlFmt(n: number): string {
  if (!isFinite(n) || n <= 0) return '0 KB';
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
}

function dlDock(): HTMLElement {
  let dock = document.getElementById('dlDock');
  if (dock) return dock;
  dock = document.createElement('div');
  dock.id = 'dlDock';
  dock.className = 'dl-dock';
  dock.innerHTML = '<div class="dl-dock-head"><span>Downloads</span><button id="dlDockClear" class="mini-btn">Clear</button></div><div id="dlList" class="dl-list"></div>';
  document.body.appendChild(dock);
  dock.querySelector('#dlDockClear')!.addEventListener('click', () => {
    dock!.querySelectorAll('.dl-item.done, .dl-item.failed').forEach((el) => el.remove());
    if (!dock!.querySelector('.dl-item')) dock!.style.display = 'none';
  });
  return dock;
}

function dlKey(d: DatasetEntry): string {
  return d.download?.destName || d.download?.filename || d.id;
}

function dlNewJob(d: DatasetEntry): DlJob {
  const dock = dlDock();
  dock.style.display = 'flex';
  const list = dock.querySelector('#dlList') as HTMLElement;
  const el = document.createElement('div');
  el.className = 'dl-item';
  el.innerHTML = `
    <div class="dl-item-head"><span class="dl-name">${esc(d.name)}</span><span class="dl-pct">0%</span></div>
    <div class="progress-track"><div class="progress-fill"></div></div>
    <div class="dl-meta">Contacting source…</div>
    <div class="dl-actions">
      <button class="mini-btn dl-pause">Pause</button>
      <button class="mini-btn dl-cancel">Cancel</button>
    </div>`;
  list.appendChild(el);

  const job: DlJob = {
    el,
    bar: el.querySelector('.progress-fill') as HTMLElement,
    pct: el.querySelector('.dl-pct') as HTMLElement,
    meta: el.querySelector('.dl-meta') as HTMLElement,
    pause: el.querySelector('.dl-pause') as HTMLButtonElement,
    d,
  };
  const filename = dlKey(d);
  job.pause.addEventListener('click', () => {
    const nowPaused = !job.pause.classList.contains('paused');
    job.pause.classList.toggle('paused', nowPaused);
    job.pause.textContent = nowPaused ? 'Resume' : 'Pause';
    void invoke('dataset_control', { filename, action: nowPaused ? 'pause' : 'resume' });
  });
  (el.querySelector('.dl-cancel') as HTMLButtonElement).addEventListener('click', () => {
    void invoke('dataset_control', { filename, action: 'cancel' });
  });
  return job;
}

function dlDone(job: DlJob, text: string, opts: { failed?: boolean; actions?: Array<[string, () => void]> } = {}) {
  job.el.classList.add('done');
  if (opts.failed) job.el.classList.add('failed');
  job.meta.textContent = text;
  job.pause.remove();
  job.el.querySelector('.dl-cancel')?.remove();
  if (opts.actions?.length) {
    const row = document.createElement('div');
    row.className = 'dl-actions';
    for (const [label, fn] of opts.actions) {
      const b = document.createElement('button');
      b.className = 'mini-btn';
      b.textContent = label;
      b.addEventListener('click', fn);
      row.appendChild(b);
    }
    job.el.appendChild(row);
  }
}

interface DatasetBatchProgress {
  filename: string;
  files_done: number;
  files_total: number;
  received: number;
  total: number | null;
  paused: boolean;
}

interface DatasetBatchOutcome {
  root: string;
  files: string[];
  bytes: number;
  cancelled: boolean;
}

async function finishDatasetImport(d: DatasetEntry, importedCount: number, job: DlJob, folder: string): Promise<void> {
  await loadCollectionSummaries();
  await reloadLibrary();
  renderDatasetCatalog();
  const sourceName = DATASET_SOURCE_NAME[d.id] || d.name;
  const local = datasetLocalCount(d.id);
  smellQuery = '';
  const search = document.getElementById('smellSearch') as HTMLInputElement | null;
  if (search) search.value = '';
  showWorkspaceView('smells');
  void renderSmellGallery();
  const text = importedCount > 0
    ? `Imported ${importedCount} recording${importedCount === 1 ? '' : 's'} · ${local} ${sourceName} in the library.`
    : `Already in the library · ${local} ${sourceName} recording${local === 1 ? '' : 's'}.`;
  dlDone(job, text, {
    actions: [
      ['Browse smells', () => showWorkspaceView('smells')],
      ['Recordings', () => openSourceRecordings(sourceName)],
      ['Open folder', () => void invoke('open_path', { path: folder })],
    ],
  });
}

async function downloadDatasetRow(d: DatasetEntry) {
  const dl = d.download;
  if (!dl) return;
  const cardBtn = document.querySelector(`.ds-download[data-id="${d.id}"]`) as HTMLButtonElement | null;
  const setCard = (text: string, disabled = true) => { if (cardBtn) { cardBtn.textContent = text; cardBtn.disabled = disabled; } };
  setCard('Starting…');

  const job = dlNewJob(d);
  const key = dlKey(d);

  if (dl.kind === 'hf-tree' || dl.kind === 'batch') {
    const unlisten = await listen<DatasetBatchProgress>('dataset-batch-progress', (e) => {
      if (e.payload.filename !== key) return;
      const done = e.payload.files_done;
      const all = e.payload.files_total || dl.fileCount || 0;
      const pctVal = all ? (done / all) * 100 : 0;
      job.bar.style.width = `${pctVal.toFixed(1)}%`;
      job.pct.textContent = all ? `${pctVal.toFixed(0)}%` : `${done}`;
      job.meta.textContent = e.payload.paused
        ? `Paused — ${done}/${all || '?'} files · ${dlFmt(e.payload.received)}`
        : `${done}/${all || '?'} files · ${dlFmt(e.payload.received)}`;
    });
    try {
      const out = dl.kind === 'hf-tree'
        ? await invoke<DatasetBatchOutcome>('dataset_download_tree', {
            repo: dl.repo,
            include: dl.include,
            exclude: dl.exclude || [],
            destName: dl.destName,
          })
        : await invoke<DatasetBatchOutcome>('dataset_download_batch', {
            destName: dl.destName,
            files: dl.files,
          });
      await unlisten();
      if (out.cancelled) {
        dlDone(job, 'Cancelled. Files already fetched stay in the corpus folder.', { failed: true });
        setCard('Retry', false);
        return;
      }
      if (!out.files.length) {
        dlDone(job, 'The source returned no CSV files.', { failed: true });
        setCard('Retry', false);
        return;
      }
      job.meta.textContent = `Importing ${out.files.length} file${out.files.length === 1 ? '' : 's'}…`;
      const imported = await invoke<SessionRecord[]>('import_paths', { paths: [out.root] });
      await writeCollectionManifest(d, true);
      await finishDatasetImport(d, imported.length, job, out.root);
      setCard('In library ✓', false);
    } catch (e) {
      await unlisten();
      dlDone(job, `Failed: ${e}`, { failed: true });
      setCard('Retry', false);
    }
    return;
  }

  let total: number | null = null;
  let received = 0;
  let speed = 0;
  let lastT = performance.now();
  let lastB = 0;

  const unlisten = await listen<{ filename: string; received: number; total: number | null; paused: boolean }>(
    'dataset-download-progress',
    (e) => {
      if (e.payload.filename !== key) return;
      received = e.payload.received;
      total = e.payload.total;
      const now = performance.now();
      if (now - lastT > 400) {
        speed = (received - lastB) / ((now - lastT) / 1000);
        lastT = now;
        lastB = received;
      }
      const pctVal = total ? (received / total) * 100 : 0;
      job.bar.style.width = total ? `${pctVal.toFixed(1)}%` : '100%';
      job.pct.textContent = total ? `${pctVal.toFixed(0)}%` : dlFmt(received);
      const eta = total && speed > 0 && !e.payload.paused ? ` · ~${Math.round((total - received) / speed)}s left` : '';
      job.meta.textContent = e.payload.paused
        ? `Paused — ${dlFmt(received)}${total ? ` / ${dlFmt(total)}` : ''}`
        : total
          ? `${dlFmt(received)} / ${dlFmt(total)} · ${dlFmt(speed)}/s${eta}`
          : `${dlFmt(received)} · ${dlFmt(speed)}/s`;
    },
  );

  try {
    const out = await invoke<{ path: string; filename: string; bytes: number; cancelled: boolean; cached?: boolean }>(
      'dataset_download',
      { url: dl.url, filename: dl.filename },
    );
    await unlisten();

    if (out.cancelled) {
      dlDone(job, 'Cancelled — partial file removed.', { failed: true });
      setCard('Retry', false);
      return;
    }

    let paths = [out.path];
    if (dl.archive) {
      job.meta.textContent = 'Extracting…';
      paths = await invoke<string[]>('dataset_extract', {
        path: out.path,
        destName: datasetDestName(d) || undefined,
      });
    }
    if (!paths.length) {
      dlDone(job, `Downloaded ${dlFmt(out.bytes)} — no CSV inside.`, {
        actions: [['Open folder', () => void invoke('open_path', { path: out.path })]],
      });
      setCard('Retry', false);
      return;
    }

    job.meta.textContent = `Importing ${paths.length} file${paths.length > 1 ? 's' : ''}…`;
    const imported = await invoke<SessionRecord[]>('import_paths', { paths });
    await writeCollectionManifest(d, true);
    await finishDatasetImport(d, imported.length, job, await invoke<string>('dataset_dir'));
    setCard('In library ✓', false);
  } catch (e) {
    await unlisten();
    dlDone(job, `Failed: ${e}`, { failed: true });
    setCard('Retry', false);
  }
}

function openDatasetSource(name: string): void {
  showWorkspaceView('smells');
  smellQuery = name;
  const search = document.getElementById('smellSearch') as HTMLInputElement | null;
  if (search) search.value = name;
  void renderSmellGallery();
}

function openSourceRecordings(name: string): void {
  const search = document.getElementById('libSearch') as HTMLInputElement | null;
  if (search) search.value = name;
  showWorkspaceView('sessions');
  renderLibrary();
}

async function copyDatasetCitation(id: string): Promise<void> {
  const d = DATASET_BY_ID.get(id);
  if (!d?.citation) return;
  const ok = await copyText(d.citation);
  showToast(ok ? 'Citation copied.' : 'Could not copy the citation.');
}

async function removeDataset(id: string): Promise<void> {
  const d = DATASET_BY_ID.get(id);
  if (!d) return;
  const matches = sessions.filter(s => recordingSource(s).datasetId === id);
  if (!matches.length) return;
  const name = DATASET_SOURCE_NAME[id] || d.name;
  const summary = collectionForDataset(d);
  if (!confirm(`Remove ${matches.length} ${name} recording${matches.length === 1 ? '' : 's'} from the library?\n\nThe downloaded files stay in the datasets folder. You can add them back from this card without downloading again.`)) return;
  try {
    await invoke('set_collection_hidden', { collectionId: summary?.id || id, hidden: true });
  } catch (e) {
    showToast(`Could not remove the collection: ${e}`);
    return;
  }
  selectedSession = null;
  await loadCollectionSummaries();
  await reloadLibrary();
  renderDatasetCatalog();
  showToast(`Removed ${matches.length} recording${matches.length === 1 ? '' : 's'}. Files kept on disk.`);
}

interface ArchiveRecovery {
  archive: string;
  dest: string;
  files: string[];
  extracted: boolean;
  error: string | null;
}

/// Finish downloads that landed on disk but never made it into the library.
/// This is deliberately idempotent: an archive whose folder is already imported
/// is left alone, and manifests are backfilled only where one is missing.
async function reconcileDatasetCorpora(): Promise<void> {
  let imported = 0;
  const recovered: string[] = [];
  const archives = DATASET_CATALOG
    .filter((d) => d.download?.archive && d.download.filename)
    .map((d) => ({
      archive: d.download!.filename!,
      destName: datasetDestName(d),
    }))
    .filter((a) => a.destName);
  if (archives.length) {
    try {
      const outcomes = await invoke<ArchiveRecovery[]>('dataset_recover_archives', { archives });
      for (const out of outcomes) {
        if (out.error) {
          console.warn(`Archive recovery failed for ${out.archive}: ${out.error}`);
          continue;
        }
        if (!out.extracted || !out.files.length) continue;
        const d = DATASET_CATALOG.find((x) => x.download?.filename === out.archive);
        if (!d) continue;
        const added = await invoke<SessionRecord[]>('import_paths', { paths: [out.dest] });
        imported += added.length;
        await writeCollectionManifest(d, true);
        recovered.push(d.name);
      }
    } catch (e) {
      console.warn('Archive recovery scan failed:', e);
    }
  }

  await loadCollectionSummaries();
  for (const d of DATASET_CATALOG) {
    const summary = collectionForDataset(d);
    if (summary && !summary.has_manifest) {
      await writeCollectionManifest(d, true, summary.folder);
    }
  }
  await loadCollectionSummaries();
  if (imported > 0 || recovered.length) {
    await reloadLibrary();
    renderDatasetCatalog();
    showToast(recovered.length
      ? `Finished importing ${recovered.join(', ')} · ${imported} recording${imported === 1 ? '' : 's'}.`
      : `Added ${imported} recording${imported === 1 ? '' : 's'} from downloaded files.`);
  }
}

function initDatasetCatalog() {
  renderDatasetCatalog();
  void loadCollectionSummaries().then(renderDatasetCatalog);
  setTimeout(() => { void reconcileDatasetCorpora(); }, 600);
  document.getElementById('dsFilter')?.addEventListener('input', renderDatasetCatalog);
  void (async () => {
    try {
      const dir = await invoke<string>('dataset_dir');
      const el = document.getElementById('dsStoragePath');
      if (el) { el.textContent = dir; el.title = dir; }
      const openBtn = document.getElementById('dsOpenFolder');
      if (openBtn) openBtn.title = `Open ${dir}`;
    } catch { /* non-fatal */ }
  })();
  document.getElementById('dsOpenFolder')?.addEventListener('click', async () => {
    try { await invoke('open_path', { path: await invoke<string>('dataset_dir') }); } catch { /* ignore */ }
  });
  document.getElementById('dsImport')?.addEventListener('click', async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        multiple: true,
        directory: false,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (!picked) return;
      const list = Array.isArray(picked) ? picked : [picked];
      if (!list.length) return;
      await invoke('import_paths', { paths: list });
      await reloadLibrary();
      showWorkspaceView('sessions');
    } catch (e) {
      console.error('Dataset import failed:', e);
      showToast(`Import failed: ${e}`);
    }
  });
  const el = document.getElementById('datasetCatalog');
  const local = document.getElementById('dsLocalList');
  const handle = async (target: EventTarget | null) => {
    const btn = (target as HTMLElement | null)?.closest('button');
    if (!btn) return;
    if (btn.classList.contains('ds-download')) {
      const d = DATASET_CATALOG.find((x) => x.id === btn.dataset.id);
      if (d) void downloadDatasetRow(d);
    } else if (btn.classList.contains('ds-add-local')) {
      void addLocalDataset(btn.dataset.id || '');
    } else if (btn.dataset.dsOpenGallery) {
      openDatasetSource(btn.dataset.dsOpenGallery);
    } else if (btn.dataset.dsOpenRecordings) {
      openSourceRecordings(btn.dataset.dsOpenRecordings);
    } else if (btn.dataset.dsOpenManifest) {
      void invoke('open_path', { path: btn.dataset.dsOpenManifest }).catch((e) => showToast(`Could not open the collection file: ${e}`));
    } else if (btn.dataset.dsOpenFolder) {
      void invoke('open_path', { path: btn.dataset.dsOpenFolder }).catch((e) => showToast(`Could not open the folder: ${e}`));
    } else if (btn.dataset.dsVerify) {
      void verifyDataset(btn.dataset.dsVerify);
    } else if (btn.dataset.dsCite) {
      void copyDatasetCitation(btn.dataset.dsCite);
    } else if (btn.dataset.dsRemove) {
      void removeDataset(btn.dataset.dsRemove);
    }
  };
  el?.addEventListener('click', (ev) => { void handle(ev.target); });
  local?.addEventListener('click', (ev) => { void handle(ev.target); });
}

// === Recipes (source → transforms → result) ===
// The smell-native unit of work. Backed by the Rust `recipe` module: saved recipes
// live under <config>/Osmograph/recipes, are validated server-side, and every step
// is a named op from the catalog (no invented numbers — see SMELL_OPERATIONS.md).
interface RecipeStep { op: string; channel?: number | null; params: Record<string, number>; }
interface Recipe { id: string; name: string; version: string; source: string; steps: RecipeStep[]; notes: string; }
interface OpInfo { op: string; intent: string; status: string; implemented: boolean; }
interface RecipeRun {
  channels: string[];
  units: string[];
  time: number[];
  values: (number | null)[][];
  applied: string[];
  warnings: string[];
}

let recipeOpsCache: OpInfo[] = [];
let currentEditingId: string | null = null;

function recipeSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'recipe';
}

function recipeStepRow(op = '', channel: number | string = '', params = ''): string {
  const initial = op || recipeOpsCache.find((o) => o.implemented)?.op || '';
  const opts = recipeOpsCache
    .map((o) => {
      const selected = o.op === initial ? ' selected' : '';
      const disabled = o.implemented ? '' : ' disabled';
      return `<option value="${esc(o.op)}"${selected}${disabled}>${esc(o.op)}${o.implemented ? '' : ' (planned)'}</option>`;
    })
    .join('');
  return `<div class="rec-step">
    <select class="stepOp" title="Named transform">${opts}</select>
    <input class="stepChannel" type="number" min="0" placeholder="ch" title="Target channel; blank = all" value="${channel}" />
    <input class="stepParams" placeholder="window=5" title="Parameters" value="${esc(params)}" />
    <button class="mini-btn stepDel" type="button">&times;</button>
  </div>`;
}

function renderRecipeList(list: Recipe[]) {
  const el = document.getElementById('recipeList');
  if (!el) return;
  el.classList.add('recipe-list');
  if (!list.length) {
    el.innerHTML = '<div class="hint">No saved recipes yet — create one above.</div>';
    return;
  }
  el.innerHTML = list
    .map(
      (r) => `<div class="recipe-card">
      <div class="recipe-card-main">
        <div class="recipe-card-name">${esc(r.name)}</div>
        <div class="recipe-card-meta">${esc(r.source)} · v${esc(r.version)} · ${r.steps.length} step(s)</div>
        <div class="recipe-steps">${r.steps.map((s) => `<span class="recipe-tag">${esc(s.op)}</span>`).join('')}</div>
      </div>
      <button class="mini-btn recEdit" data-id="${esc(r.id)}">Edit</button>
      <button class="mini-btn recDel" data-id="${esc(r.id)}">Delete</button>
    </div>`
    )
    .join('');
}

function renderRecipeOps(ops: OpInfo[]) {
  const el = document.getElementById('recipeOps');
  if (!el) return;
  const runnable = ops.filter(o => o.implemented);
  el.innerHTML = runnable
    .map(
      (o) => `<div class="op-row"><span class="op-name">${esc(o.op)}</span><span class="op-intent">${esc(o.intent)}</span>
        <span class="op-status ${esc(o.status)}">${esc(o.status)}</span>
        <span class="op-status core">runnable</span></div>`
    )
    .join('') + '<div class="hint" style="font-size:10px;margin-top:6px">Only runnable steps are listed. Planned transforms are not exposed as if they work.</div>';
}

async function refreshRecipes() {
  try {
    const [list, ops] = await Promise.all([
      invoke<Recipe[]>('recipe_list'),
      recipeOpsCache.length ? Promise.resolve(recipeOpsCache) : invoke<OpInfo[]>('recipe_ops'),
    ]);
    recipeOpsCache = ops;
    renderRecipeList(list);
    renderRecipeOps(ops);
  } catch {
    const el = document.getElementById('recipeList');
    if (el) el.textContent = 'Recipe load failed';
  }
}

function populateRecipeSources(selected?: string) {
  const sel = document.getElementById('recSourceSel') as HTMLSelectElement | null;
  if (!sel) return;
  const list = sessions.filter((s) => !!s.file_id);
  const opts: string[] = [];
  if (selected && !list.some((s) => s.file_id === selected)) {
    opts.push(`<option value="${esc(selected)}" selected>Unavailable source · ${esc(selected)}</option>`);
  }
  for (const s of list.slice(0, 200)) {
    const name = (s.substance && s.substance !== 'unknown' ? s.substance : s.label) || 'recording';
    const meta = [s.time, s.file_id!.slice(0, 8)].filter(Boolean).join(' · ');
    opts.push(`<option value="${esc(s.file_id!)}"${s.file_id === selected ? ' selected' : ''}>${esc(name)}${meta ? ` · ${meta}` : ''}</option>`);
  }
  if (!opts.length) opts.push('<option value="">No recordings — import one first</option>');
  sel.innerHTML = opts.join('');
  const hint = document.getElementById('recSourceHint');
  if (hint) {
    hint.textContent = list.length
      ? `${list.length} indexed recording${list.length === 1 ? '' : 's'}. Run reads this file; nothing is overwritten.`
      : 'Import a CSV or .osmell first.';
  }
}

async function ensureRecipeOps() {
  if (!recipeOpsCache.length) await refreshRecipes();
}

function openRecipeEditor(r?: Recipe) {
  document.getElementById('recipeEditor')!.style.display = 'block';
  hideRecipeResult();
  const sourceId = r?.source?.startsWith('osmell:') ? r.source.slice('osmell:'.length) : (r?.source || sessions.find((s) => !!s.file_id)?.file_id || '');
  populateRecipeSources(sourceId);
  const srcRec = sessions.find((s) => s.file_id === sourceId);
  const suggested = srcRec
    ? `${srcRec.substance && srcRec.substance !== 'unknown' ? srcRec.substance : srcRec.label || 'Recording'} response`
    : 'Untitled response';
  (document.getElementById('recName') as HTMLInputElement).value = r?.name || suggested;
  (document.getElementById('recVersion') as HTMLInputElement).value = r?.version || '1.0.0';
  const steps = document.getElementById('recSteps')!;
  steps.innerHTML = '';
  if (r && r.steps.length) {
    r.steps.forEach((s) =>
      steps.insertAdjacentHTML(
        'beforeend',
        recipeStepRow(s.op, s.channel ?? '', Object.entries(s.params || {}).map(([k, v]) => `${k}=${v}`).join(','))
      )
    );
  } else {
    steps.insertAdjacentHTML('beforeend', recipeStepRow('smooth.movavg', '', 'window=5'));
    steps.insertAdjacentHTML('beforeend', recipeStepRow('response.ratio'));
  }
  currentEditingId = r?.id || null;
  const msg = document.getElementById('recMsg')!;
  msg.style.color = 'var(--text-3)';
  msg.textContent = r
    ? `Editing ${r.id}`
    : 'New recipe — source and two steps are prefilled. Press Run.';
}

function collectSteps(): RecipeStep[] {
  const steps: RecipeStep[] = [];
  const bad: string[] = [];
  document.querySelectorAll('#recSteps .rec-step').forEach((row) => {
    const op = (row.querySelector('.stepOp') as HTMLSelectElement).value;
    const chRaw = (row.querySelector('.stepChannel') as HTMLInputElement).value.trim();
    const params: Record<string, number> = {};
    (row.querySelector('.stepParams') as HTMLInputElement)
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((pair) => {
        const [k, v] = pair.split('=').map((s) => s.trim());
        if (!k || v === undefined) { bad.push(pair); return; }
        const n = Number(v);
        if (Number.isNaN(n)) bad.push(pair); else params[k] = n;
      });
    steps.push({ op, channel: chRaw === '' ? null : Number(chRaw), params });
  });
  if (bad.length) throw new Error(`Bad parameter${bad.length === 1 ? '' : 's'}: ${bad.join(', ')} (use key=number)`);
  return steps;
}

function collectRecipe(): Recipe {
  const name = (document.getElementById('recName') as HTMLInputElement).value.trim();
  const sourceId = (document.getElementById('recSourceSel') as HTMLSelectElement | null)?.value || '';
  const source = sourceId ? (sourceId.includes(':') ? sourceId : `osmell:${sourceId}`) : '';
  const version = (document.getElementById('recVersion') as HTMLInputElement).value.trim() || '1.0.0';
  return {
    id: currentEditingId || recipeSlug(name || 'recipe'),
    name,
    version,
    source,
    steps: collectSteps(),
    notes: '',
  };
}

async function saveRecipe() {
  const msg = document.getElementById('recMsg')!;
  try {
    const recipe = collectRecipe();
    await invoke('recipe_save', { recipe });
    msg.style.color = 'var(--green)';
    msg.textContent = `Saved ${recipe.id}.`;
    document.getElementById('recipeEditor')!.style.display = 'none';
    currentEditingId = null;
    await refreshRecipes();
  } catch (e) {
    msg.style.color = 'var(--red)';
    msg.textContent = String(e);
  }
}

let lastRecipeRun: RecipeRun | null = null;

function hideRecipeResult() {
  lastRecipeRun = null;
  const el = document.getElementById('recipeResult');
  if (el) el.style.display = 'none';
  const msg = document.getElementById('recipeResultMsg');
  if (msg) msg.textContent = '';
}

function renderRecipeRun(run: RecipeRun) {
  lastRecipeRun = run;
  const card = document.getElementById('recipeResult')!;
  card.style.display = 'block';
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const n = run.values[0]?.length ?? 0;
  const dur = run.time.length > 1 ? run.time[run.time.length - 1] - run.time[0] : 0;
  document.getElementById('recipeResultMeta')!.textContent =
    `${run.channels.length} channel${run.channels.length === 1 ? '' : 's'} · ${n} samples · ${dur.toFixed(1)} s`;
  document.getElementById('recipeResultSteps')!.innerHTML =
    run.applied.map((a) => `<span class="recipe-tag">${esc(a)}</span>`).join('');
  const warn = document.getElementById('recipeResultWarn')!;
  warn.textContent = run.warnings.length ? run.warnings.join(' · ') : '';
  const out = document.getElementById('recipeResultMsg')!;
  out.textContent = '';
  out.style.color = 'var(--text-3)';
  requestAnimationFrame(() => drawRecipeChart(run));
}

function drawRecipeChart(run: RecipeRun) {
  const canvas = document.getElementById('recipeChart') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(320, canvas.clientWidth || 600);
  const h = 230;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const padL = 86, padR = 10, padT = 6, padB = 4;
  const n = Math.max(1, run.channels.length);
  const laneH = (h - padT - padB) / n;
  for (let ci = 0; ci < run.channels.length; ci++) {
    const top = padT + ci * laneH;
    if (ci > 0) {
      ctx.strokeStyle = 'rgba(8,8,12,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, top);
      ctx.lineTo(w, top);
      ctx.stroke();
    }
    const vals = run.values[ci].map((v) => (v === null ? NaN : v));
    const finite = vals.filter(Number.isFinite);
    ctx.fillStyle = '#3a3630';
    ctx.font = '600 10px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(run.channels[ci], 4, top + laneH / 2 - 4);
    ctx.fillStyle = '#8a7f6c';
    ctx.font = '8px ui-monospace, monospace';
    ctx.fillText(run.units[ci] || 'raw', 4, top + laneH / 2 + 7);
    if (!finite.length) {
      ctx.fillStyle = '#8a7f6c';
      ctx.font = '9px -apple-system, sans-serif';
      ctx.fillText('n/a', padL + 4, top + laneH / 2);
      continue;
    }
    let lo = Math.min(...finite), hi = Math.max(...finite);
    if (!(hi - lo > 1e-12)) { lo -= 0.5; hi += 0.5; }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    const py = (v: number) => top + 4 + (1 - (v - lo) / (hi - lo)) * (laneH - 8);
    if (lo < 0 && hi > 0) {
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = 'rgba(8,8,12,0.18)';
      ctx.beginPath();
      ctx.moveTo(padL, py(0));
      ctx.lineTo(w - padR, py(0));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = CHART_COLORS[ci % CHART_COLORS.length];
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < vals.length; i++) {
      if (!Number.isFinite(vals[i])) { started = false; continue; }
      const px = padL + (vals.length <= 1 ? 0 : (i / (vals.length - 1)) * (w - padL - padR));
      const yy = py(vals[i]);
      if (!started) { ctx.moveTo(px, yy); started = true; } else { ctx.lineTo(px, yy); }
    }
    ctx.stroke();
  }
}

function recipeRunInput(): { fileId: string; steps: RecipeStep[] } | null {
  const msg = document.getElementById('recMsg')!;
  const fileId = (document.getElementById('recSourceSel') as HTMLSelectElement | null)?.value || '';
  if (!fileId || !sessions.some((s) => s.file_id === fileId)) {
    msg.style.color = 'var(--red)';
    msg.textContent = 'Pick an indexed recording as the source.';
    return null;
  }
  let steps: RecipeStep[];
  try {
    steps = collectSteps();
  } catch (e) {
    msg.style.color = 'var(--red)';
    msg.textContent = String(e);
    return null;
  }
  if (!steps.length) {
    msg.style.color = 'var(--red)';
    msg.textContent = 'Add at least one step.';
    return null;
  }
  const planned = steps.filter((s) => !recipeOpsCache.find((o) => o.op === s.op)?.implemented);
  if (planned.length) {
    msg.style.color = 'var(--red)';
    msg.textContent = `Not runnable yet: ${planned.map((s) => s.op).join(', ')}. Replace with a runnable op.`;
    return null;
  }
  return { fileId, steps };
}

async function runRecipe() {
  const msg = document.getElementById('recMsg')!;
  const input = recipeRunInput();
  if (!input) return;
  msg.style.color = 'var(--text-3)';
  msg.textContent = 'Running…';
  try {
    const run = await invoke<RecipeRun>('recipe_run', { fileId: input.fileId, steps: input.steps });
    renderRecipeRun(run);
    msg.style.color = 'var(--green)';
    msg.textContent = `Ran ${input.steps.length} step${input.steps.length === 1 ? '' : 's'} on ${run.channels.length} channels.`;
  } catch (e) {
    msg.style.color = 'var(--red)';
    msg.textContent = String(e);
  }
}

async function saveRecipeResult() {
  const input = recipeRunInput();
  if (!input) return;
  const out = document.getElementById('recipeResultMsg')!;
  let recipe: Recipe;
  try {
    recipe = collectRecipe();
  } catch (e) {
    out.style.color = 'var(--red)';
    out.textContent = String(e);
    return;
  }
  out.style.color = 'var(--text-3)';
  out.textContent = 'Saving…';
  try {
    const dir = await invoke<string>('get_recordings_dir');
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const path = `${dir}/Derived/${stamp}_${recipeSlug(recipe.name)}.osmell`;
    const saved = await invoke<string>('recipe_export_osmell', {
      fileId: input.fileId,
      steps: input.steps,
      outputPath: path,
      recipeId: recipe.id,
      recipeName: recipe.name,
      recipeVersion: recipe.version,
    });
    await invoke('import_paths', { paths: [path] });
    await reloadLibrary();
    out.style.color = 'var(--green)';
    out.textContent = `${saved} · added to your Smell library.`;
  } catch (e) {
    out.style.color = 'var(--red)';
    out.textContent = `Save failed: ${e}`;
  }
}

function initRecipes() {
  refreshRecipes();
  document.getElementById('recipeNew')?.addEventListener('click', async () => {
    await ensureRecipeOps();
    openRecipeEditor();
  });
  document.getElementById('recipeRefresh')?.addEventListener('click', refreshRecipes);
  document.getElementById('recAddStep')?.addEventListener('click', () => {
    hideRecipeResult();
    document.getElementById('recSteps')!.insertAdjacentHTML('beforeend', recipeStepRow());
  });
  document.getElementById('recAddTrim')?.addEventListener('click', () => {
    hideRecipeResult();
    document.getElementById('recSteps')!.insertAdjacentHTML('beforeend', recipeStepRow('trim.range', '', 'start=0,end=10'));
    const msg = document.getElementById('recMsg');
    if (msg) {
      msg.style.color = 'var(--text-3)';
      msg.textContent = 'Trim step added. Set start/end seconds, then Run.';
    }
  });
  document.getElementById('recRun')?.addEventListener('click', runRecipe);
  document.getElementById('recSaveResult')?.addEventListener('click', saveRecipeResult);
  document.getElementById('recSave')?.addEventListener('click', saveRecipe);
  document.getElementById('recSourceSel')?.addEventListener('change', hideRecipeResult);
  document.getElementById('recSteps')?.addEventListener('input', hideRecipeResult);
  document.getElementById('recCancel')?.addEventListener('click', () => {
    document.getElementById('recipeEditor')!.style.display = 'none';
    hideRecipeResult();
    currentEditingId = null;
  });
  window.addEventListener('resize', () => {
    if (lastRecipeRun) requestAnimationFrame(() => drawRecipeChart(lastRecipeRun!));
  });

  document.getElementById('recSteps')!.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('.stepDel');
    if (btn) {
      (btn.closest('.rec-step') as HTMLElement)?.remove();
      hideRecipeResult();
    }
  });

  document.getElementById('recipeList')!.addEventListener('click', async (ev) => {
    const btn = (ev.target as HTMLElement).closest('button');
    if (!btn) return;
    const id = btn.getAttribute('data-id') || '';
    if (btn.classList.contains('recEdit')) {
      try {
        await ensureRecipeOps();
        const r = await invoke<Recipe>('recipe_load', { id });
        openRecipeEditor(r);
      } catch { /* ignore */ }
    } else if (btn.classList.contains('recDel')) {
      try {
        await invoke('recipe_delete', { id });
        await refreshRecipes();
      } catch { /* ignore */ }
    }
  });
}

document.getElementById('sysRefreshPorts')!.addEventListener('click', refreshPorts);
// A manual board pick in the Firmware panel updates the board label immediately.
document.getElementById('fwBoard')?.addEventListener('change', updateFwBoardLabel);
document.getElementById('flashBtn')!.addEventListener('click', async () => {
  const port = (document.getElementById('portSelect') as HTMLSelectElement).value;
  if (!port) return;
  const wifiSsid = (document.getElementById('fwSsid') as HTMLInputElement).value.trim();
  const wifiPassword = (document.getElementById('fwPass') as HTMLInputElement).value;
  const manual = (document.getElementById('fwBoard') as HTMLSelectElement)?.value || '';
  const board = resolvedBoard(port, manual);
  if (!board) {
    const kind = portKindMap.get(port) || 'unknown';
    document.getElementById('flashStatus')!.textContent =
      `Can't tell which board is on ${port} (${kindLabel(kind)}). Pick the board in Firmware → Board, then flash again.`;
    return;
  }
  if (board === 'arduino_uno' && presetChannelCount(activePreset) > 6) {
    document.getElementById('flashStatus')!.textContent = 'Arduino UNO has 6 analog inputs — pick a 6-channel (or smaller) rig preset.';
    return;
  }
  const fp = document.getElementById('flashProgress')!;
  fp.style.display = '';
  fp.classList.add('flashing');
  document.getElementById('flashStatus')!.textContent = 'Flashing...';
  document.getElementById('flashBar')!.style.width = '30%';
  try {
    await invoke('flash_firmware', { port, preset: activePreset, nChannels: presetChannelCount(activePreset), sensorPins: [], wifiSsid, wifiPassword, board });
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
  const manual = (document.getElementById('fwBoard') as HTMLSelectElement)?.value || '';
  const board = resolvedBoard(port, manual);
  if (board !== 'esp32') { document.getElementById('fwMac')!.textContent = 'MAC read is ESP32-only — pick ESP32 in Firmware → Board first.'; return; }
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
  const manual = (document.getElementById('fwBoard') as HTMLSelectElement)?.value || '';
  const board = resolvedBoard(port, manual);
  if (board !== 'esp32') {
    const kind = portKindMap.get(port) || 'unknown';
    document.getElementById('flashStatus')!.textContent =
      `Erase is blocked: this port isn't confirmed as an ESP32 (${kindLabel(kind)}). Erasing wipes the whole chip — pick ESP32 in Firmware → Board only if you're certain.`;
    return;
  }
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
  const port = (document.getElementById('fmPort') as HTMLSelectElement).value;
  const activePort = (document.getElementById('portSelect') as HTMLSelectElement).value;
  const manual = (document.getElementById('fmBoard') as HTMLSelectElement)?.value || '';
  const auto = portBoardMap.get(port || activePort) || '';
  const board = manual || auto;
  const isAvr = board === 'arduino_uno';
  const pins = isAvr
    ? Array.from({ length: Math.min(count, 6) }, (_, i) => `A${i}`)
    : presetPins(count).map(String);
  if (count < 1 || pins.length === 0) {
    el.innerHTML = '<b>WIRING</b> · pick a rig preset above';
    return;
  }
  const names = Array.from({ length: Math.min(count, pins.length) }, (_, i) => sensors[i] || `CH${i + 1}`);
  const pinLabel = isAvr ? 'ANALOG' : 'GPIO';
  if (!board) {
    const kind = portKindMap.get(port || activePort) || 'unknown';
    el.innerHTML = `<b>BOARD · CONFIRM</b> · ${kindLabel(kind)}. Pick ESP32 or Arduino Uno above to unlock flashing.<br><span style="opacity:.75">Preview shown on ESP32 pinout — not yet safe to flash.</span>`;
    return;
  }
  el.innerHTML = `<b>BOARD · ${boardDisplay(board)}</b> · <b>WIRING</b> · ${pins.length} CH → ${pinLabel} ${pins.join('/')}<br><span style="opacity:.75">${names.join(' · ')}</span>`;
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
  const fmPort = (document.getElementById('fmPort') as HTMLSelectElement).value;
  const activePort = (document.getElementById('portSelect') as HTMLSelectElement).value;
  const manual = (document.getElementById('fmBoard') as HTMLSelectElement)?.value || '';
  const auto = portBoardMap.get(fmPort || activePort) || '';
  const board = manual || auto;
  const max = maxChannelsForBoard(board);
  const builtIns = Object.keys(PRESETS)
    .filter(id => PRESETS[id].sensors.length <= max)
    .map(id => `<option value="${id}">${PRESETS[id].name}</option>`);
  const customs = customPresets
    .filter(p => p.n_channels <= max)
    .map(p => `<option value="${p.id}">${p.name} (custom, ${p.n_channels} ch)</option>`);
  sel.innerHTML = builtIns.join('') + customs.join('');
  if (prev && Array.from(sel.options).some(o => o.value === prev)) sel.value = prev;
  else if (Array.from(sel.options).some(o => o.value === '6-sensor-full')) sel.value = '6-sensor-full';
  renderFmWiring();
}

function openFlashModal() {
  const modal = document.getElementById('flashModal');
  if (!modal) return;
  resetFmState();
  // Re-detect the board on every open: a manual pick from a previous session
  // must not silently survive — the user should confirm the target each time.
  const fmBoard = document.getElementById('fmBoard') as HTMLSelectElement | null;
  if (fmBoard) fmBoard.value = '';
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
document.getElementById('fmPort')?.addEventListener('change', () => {
  populateFmPresets();
  renderFmWiring();
});
// Choosing the board in the dialog re-filters the rig presets (an 8-sensor rig
// is only valid on an ESP32) and re-renders the live wiring preview.
document.getElementById('fmBoard')?.addEventListener('change', () => {
  populateFmPresets();
  renderFmWiring();
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
  const manual = (document.getElementById('fmBoard') as HTMLSelectElement)?.value || '';
  const board = resolvedBoard(port, manual);
  const status = document.getElementById('fmStatus') as HTMLDivElement;
  if (!port) { status.textContent = 'Pick a port first.'; status.style.color = 'var(--yellow)'; return; }
  // Never flash to a board we haven't identified: an ambiguous CH340 adapter
  // or unrecognised USB could be an Arduino Nano just as easily as an ESP32,
  // and wrong firmware can whack a bootloader. Require an explicit pick.
  if (!board) {
    const kind = (portKindMap.get(port) || 'unknown');
    status.textContent = `Can't tell which board is on ${port} (${kindLabel(kind)}). Pick ESP32 or Arduino Uno in the Board menu above.`;
    status.style.color = 'var(--red)';
    return;
  }
  if (board === 'arduino_uno' && presetChannelCount(preset) > 6) {
    status.textContent = 'Arduino (Uno/Nano) has 6 analog inputs — pick a 6-channel or smaller rig preset.';
    status.style.color = 'var(--red)';
    return;
  }
  resetFmState();
  setFmBusy(true);
  status.textContent = 'Building & flashing… this can take ~30 s.';
  status.style.color = '';
  try {
    const done = await invoke<string>('flash_firmware', { port, preset, nChannels: presetChannelCount(preset), sensorPins: [], wifiSsid, wifiPassword, board });
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
  devTap('reading', event.payload);
  if (!connected && channels.length > 0) {
    // The backend can still be streaming when this UI has no link state (hot
    // reload, or a connect that raced the previous lifetime). Incoming data is
    // ground truth: adopt the link instead of claiming NO LINK while plotting.
    adoptLiveLink();
  }
  if (channels.length > 0) {
    ingestReading(channels);
    try {
      (window as any).__OSMOGRAPH_HOST_STATE__ = {
        readings: channels,
        channels: channels,
        channelMeta: chNames.map((name, i) => ({ name, kind: channelKinds[i] || 'analog_mox' })),
        env: (window as any).__OSMOGRAPH_LAST_ENV__ || null,
        baseline: (window as any).__OSMOGRAPH_BASELINE__ || null,
        baselineTimestamp: (window as any).__OSMOGRAPH_BASELINE_TS__ || null,
        connected: true,
        timestamp: event.payload.timestamp || Date.now(),
      };
      if (!(window as any).__OSMOGRAPH_READINGS_BUFFER__) {
        (window as any).__OSMOGRAPH_READINGS_BUFFER__ = [];
      }
      (window as any).__OSMOGRAPH_READINGS_BUFFER__.push({
        timestamp: event.payload.timestamp || Date.now(),
        channels: [...channels],
        channelsMeta: chNames.map((name, i) => ({ name, kind: channelKinds[i] || 'analog_mox' })),
      });
      if ((window as any).__OSMOGRAPH_READINGS_BUFFER__.length > 2000) {
        (window as any).__OSMOGRAPH_READINGS_BUFFER__ = (window as any).__OSMOGRAPH_READINGS_BUFFER__.slice(-2000);
      }
      if ((window as any).__OSMOGRAPH_VIAL_HOST__) {
        const host = (window as any).__OSMOGRAPH_VIAL_HOST__;
        if (typeof host.emit === 'function') {
          host.emit('tick', (window as any).__OSMOGRAPH_HOST_STATE__);
          host.emit('data', (window as any).__OSMOGRAPH_HOST_STATE__);
        }
      }
    } catch (e) {
      console.warn('Failed to pump vial host state:', e);
    }
  }
});

function adoptLiveLink(): void {
  if (connected) return;
  connected = true;
  devTap('link', { connected: true, adopted: true, mode: activeMode });
  lastDataAt = Date.now();
  resetLiveBaseline();
  syncOpenVialDetectors(true);
  const btn = document.getElementById('connectBtn');
  if (btn) btn.textContent = 'Disconnect';
  const dot = document.getElementById('statusDot');
  if (dot) dot.className = 'status-dot ok';
  setPlotLink(true);
  const stored = restoreLastConnection();
  if (stored?.mode === 'wifi' || stored?.mode === 'ble' || stored?.mode === 'serial') {
    activeMode = stored.mode;
  }
  if (stored?.port) activePort = stored.port;
  if (stored?.addr) activePort = stored.addr;
  if (stored?.baud) activeBaud = parseInt(stored.baud) || 0;
  refreshFpSource();
  updatePlotLinkState();
  renderSysPorts();
}

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
  try {
    (window as any).__OSMOGRAPH_LAST_ENV__ = event.payload;
    if ((window as any).__OSMOGRAPH_HOST_STATE__) {
      (window as any).__OSMOGRAPH_HOST_STATE__.env = event.payload;
    }
  } catch {}
});

listen<{ code: number; message: string }>('serial-error', (event) => {
  console.error(`Serial error ${event.payload.code}: ${event.payload.message}`);
  const cm = document.getElementById('connMsg');
  if (cm) {
    cm.textContent = `Serial error ${event.payload.code}: ${event.payload.message}`;
    cm.style.color = 'var(--red)';
  }
});

listen<{ title: string; message: string }>('error-dialogue', (event) => {
  console.error(`${event.payload.title}: ${event.payload.message}`);
  const { title, message } = event.payload;
  if (title) {
    showToast(`${title}: ${message}`, 6000);
  } else {
    showToast(message, 6000);
  }
});

function dropLink(reason: string) {
  connected = false;
  bootloaderHinted = false;
  autoChannels = 0;
  channelKinds = [];
  renderEnvReadout(null);
  bootFlashShown = false;
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

// === Buzzer Alerts ===
// Tauri v2 (WebKitGTK) exposes no Web Audio API, so anomaly escalation is
// signalled with a generated WAV through a plain <audio> element plus a frame
// flash. Honest levels: 1 = warning (amber), 2+ = critical/emergency (pink/red).

let buzzerArmed = 0;

function buzzerToneWav(frequencyHz: number, pattern: string, volume: number): string {
  const sr = 8000;
  const beepMs = pattern === 'continuous' ? 500 : 150;
  const repeats = pattern === 'double' ? 2 : pattern === 'triple' ? 3 : 2;
  const gapMs = 180;
  const amp = Math.round((Math.min(100, Math.max(0, volume)) / 100) * 7000);
  const seg = (ms: number, sound: boolean): Int16Array => {
    const n = Math.round((sr * ms) / 1000);
    const out = new Int16Array(n);
    if (!sound) return out;
    let phase = 0;
    const step = frequencyHz / sr;
    for (let i = 0; i < n; i++) {
      phase += step;
      if (phase >= 1) phase -= 1;
      out[i] = phase < 0.5 ? amp : -amp;
    }
    return out;
  };
  const parts: Int16Array[] = [];
  for (let i = 0; i < repeats; i++) {
    parts.push(seg(beepMs, true));
    if (i < repeats - 1) parts.push(seg(gapMs, false));
  }
  const nSamples = parts.reduce((a, p) => a + p.length, 0);
  const wav = new Uint8Array(44 + nSamples * 2);
  const dv = new DataView(wav.buffer);
  const put = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) wav[off + i] = s.charCodeAt(i);
  };
  put(0, 'RIFF'); dv.setUint32(4, 36 + nSamples * 2, true); put(8, 'WAVE');
  put(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  put(36, 'data'); dv.setUint32(40, nSamples * 2, true);
  let off = 44;
  for (const p of parts) {
    wav.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), off);
    off += p.byteLength;
  }
  let bin = '';
  for (let i = 0; i < wav.length; i++) bin += String.fromCharCode(wav[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
}

function fireBuzzerAlert(level: number, pattern: string, volume: number, frequencyHz: number): void {
  if (level <= buzzerArmed) return;
  buzzerArmed = level;
  document.body.classList.add('alert-flash');
  window.setTimeout(() => document.body.classList.remove('alert-flash'), 2600);
  try {
    const a = new Audio(buzzerToneWav(frequencyHz || 2000, pattern || 'double', volume || 70));
    a.volume = 1;
    a.play().catch(() => {});
  } catch (err) {
    console.error('buzzer audio unavailable:', err);
  }
}

listen<{
  alert_level: number; alert_name: string; consecutive_anomalies: number;
  pattern: string; volume: number; frequency_hz: number;
}>('buzzer-alert', (event) => {
  fireBuzzerAlert(event.payload.alert_level, event.payload.pattern, event.payload.volume, event.payload.frequency_hz);
});

listen('buzzer-alert-clear', () => {
  buzzerArmed = 0;
  document.body.classList.remove('alert-flash');
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
  showWorkspaceView('system');
  const port = (document.getElementById('portSelect') as HTMLSelectElement).value;
  const fwPort = document.getElementById('fwPort');
  if (fwPort) fwPort.textContent = port || 'No port selected';
  updateFwBoardLabel();
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
let replayHeat: EvolutionMatrix | null = null;
let replayFrame = 0;
let lastReplayFpDraw = 0;
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

/** A trailing window of the replay at the current frame, expressed as a
 *  baseline-relative fingerprint. This is what the “now” radar shows. */
function replayWindowFingerprint(frame: number): { channels: string[]; values: number[] } | null {
  if (!replaySeries) return null;
  const n = replaySeries.time.length;
  if (!n) return null;
  const end = Math.max(1, Math.min(n, frame || n));
  const window = Math.max(4, Math.floor(n * 0.08));
  const start = Math.max(0, end - window);
  const values = replaySeries.channels.map((_, ci) => {
    const seriesValues = replaySeries!.values[ci] || [];
    const r0 = compareR0(seriesValues);
    if (!r0 || !(r0 > 0)) return NaN;
    return meanOf(seriesValues.slice(start, end)
      .filter(Number.isFinite)
      .map(v => (v - r0) / r0));
  });
  return { channels: replaySeries.channels, values };
}

function drawReplayFingerprint(force = false): void {
  const canvas = document.getElementById('replayFingerprint') as HTMLCanvasElement | null;
  if (!canvas) return;
  const panel = document.getElementById('replayPanel');
  if (!force && (!panel || panel.style.display === 'none')) return;
  const nowMs = performance.now();
  if (!force && nowMs - lastReplayFpDraw < 100) return;
  lastReplayFpDraw = nowMs;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(220, canvas.clientWidth || 600);
  const h = Math.max(120, canvas.clientHeight || 156);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const stamp = document.getElementById('replayFpStamp');

  if (!replaySeries || !replayHeat) {
    ctx.fillStyle = '#8a7f6c';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Load a session to see its fingerprint form', w / 2, h / 2);
    if (stamp) stamp.textContent = 'load a session';
    return;
  }

  const n = replaySeries.time.length;
  const playhead = n ? replayFrame / n : 0;
  const radarW = Math.min(148, Math.max(96, w * 0.28));
  const heatW = Math.max(120, w - radarW - 14);
  drawEvolutionHeatmap(ctx, 0, 0, heatW, h - 12, replayHeat, { labels: true, playhead });

  const now = replayWindowFingerprint(replayFrame);
  if (now) {
    drawFingerprintInto(ctx, heatW + 14, 0, radarW, h - 14, now.values, now.channels, { compact: true });
    ctx.fillStyle = '#8a7f6c';
    ctx.font = '7px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('now · trailing window', heatW + 14 + radarW / 2, h - 11);
  }
  if (stamp) stamp.textContent = `${Math.round(playhead * 100)}% · ${now ? now.values.filter(Number.isFinite).length : 0} channels`;
}

function replayReflectOnDashboard() {
  // A connected rig always owns the Home radar; replay drives it only when
  // there is no live stream to fight (the panel has its own radar regardless).
  const sample = !connected ? replayCurrentSample() : null;
  if (sample) drawFingerprint(sample);
  document.getElementById('replayNote')!.textContent =
    `Replaying "${replaySeries?.label}" — ${replaySeries?.time.length ?? 0} samples · ${replaySeries?.channels.length ?? 0} channels. Inspection only (fingerprint reflects the replayed moment; not fed to the detector/classifier).`;
  drawReplayFingerprint();
  if (sample) refreshFpSource();
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

const REPLAY_HEIGHT_KEY = 'osmograph.replayHeight';

function replayParentHeight(panel: HTMLElement): number {
  const parent = panel.parentElement;
  return parent ? parent.getBoundingClientRect().height : window.innerHeight;
}

function defaultReplayHeight(panel: HTMLElement): number {
  return Math.max(260, Math.min(380, replayParentHeight(panel) - 300));
}

function redrawReplayDock(): void {
  drawReplayFingerprint(true);
  drawReplay();
}

/** `undefined` returns the dock to its compact default; a number pins it. */
function applyReplayHeight(panel: HTMLElement, next?: number): void {
  const max = Math.max(280, replayParentHeight(panel) - 230);
  const desired = next == null ? defaultReplayHeight(panel) : next;
  const h = Math.max(230, Math.min(desired, max));
  panel.style.height = `${Math.round(h)}px`;
  panel.style.flex = '0 0 auto';
}

function replayHeightIsExpanded(panel: HTMLElement): boolean {
  return panel.getBoundingClientRect().height > replayParentHeight(panel) * 0.55;
}

function toggleReplayHeight(): void {
  const panel = document.getElementById('replayPanel') as HTMLElement | null;
  if (!panel) return;
  if (replayHeightIsExpanded(panel)) {
    applyReplayHeight(panel);
    localStorage.removeItem(REPLAY_HEIGHT_KEY);
  } else {
    applyReplayHeight(panel, Math.max(320, replayParentHeight(panel) - 190));
    localStorage.setItem(REPLAY_HEIGHT_KEY, String(Math.round(panel.getBoundingClientRect().height)));
  }
  redrawReplayDock();
}

function restoreReplayHeight(): void {
  const panel = document.getElementById('replayPanel') as HTMLElement | null;
  if (!panel) return;
  const raw = localStorage.getItem(REPLAY_HEIGHT_KEY);
  const saved = raw ? Number(raw) : NaN;
  if (Number.isFinite(saved) && saved >= 230) applyReplayHeight(panel, saved);
  else applyReplayHeight(panel, defaultReplayHeight(panel));
}

function initReplayResize(): void {
  const panel = document.getElementById('replayPanel') as HTMLElement | null;
  const grip = document.getElementById('replayGrip') as HTMLElement | null;
  if (!panel || !grip) return;
  let dragging = false;
  let startY = 0;
  let startH = 0;
  const onMove = (ev: PointerEvent) => {
    if (!dragging) return;
    applyReplayHeight(panel, startH - (ev.clientY - startY));
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
    const h = Math.round(panel.getBoundingClientRect().height);
    if (h > 0) localStorage.setItem(REPLAY_HEIGHT_KEY, String(h));
    redrawReplayDock();
  };
  grip.addEventListener('pointerdown', (ev) => {
    dragging = true;
    startY = ev.clientY;
    startH = panel.getBoundingClientRect().height;
    ev.preventDefault();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  });
  grip.addEventListener('dblclick', toggleReplayHeight);
  grip.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      const delta = ev.key === 'ArrowUp' ? 24 : -24;
      applyReplayHeight(panel, panel.getBoundingClientRect().height + delta);
      localStorage.setItem(REPLAY_HEIGHT_KEY, String(Math.round(panel.getBoundingClientRect().height)));
      redrawReplayDock();
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      applyReplayHeight(panel);
      localStorage.removeItem(REPLAY_HEIGHT_KEY);
      redrawReplayDock();
    }
  });
  document.getElementById('replayExpand')?.addEventListener('click', toggleReplayHeight);
  window.addEventListener('resize', () => {
    if (!panel.style.height) return;
    applyReplayHeight(panel, parseFloat(panel.style.height));
    redrawReplayDock();
  });
}

function openReplayPanel() {
  populateReplaySelect();
  document.getElementById('replayPanel')!.style.display = '';
  restoreReplayHeight();
  refreshFpSource();
  redrawReplayDock();
}

function closeReplayPanel() {
  replayPlaying = false;
  document.getElementById('replayPanel')!.style.display = 'none';
  const btn = document.getElementById('replayPlay');
  if (btn) btn.textContent = '▶ Play';
  refreshFpSource();
}

async function loadReplay() {
  const sel = document.getElementById('replaySession') as HTMLSelectElement;
  const note = document.getElementById('replayNote');
  if (!sel) return;
  const fid = sel.value;
  if (!fid) {
    replayPlaying = false;
    replaySeries = null;
    replayHeat = null;
    drawReplayFingerprint(true);
    const btn = document.getElementById('replayPlay');
    if (btn) btn.textContent = '▶ Play';
    if (note) note.textContent = sessions.length === 0
      ? 'Nothing to replay yet — import a recording in the Library tab (or record one live), then it will appear here.'
      : 'No session selected — pick one from the list above, then Load again.';
    return;
  }
  try {
    replaySeries = await invoke<SessionSeries>('load_session_series', { fileId: fid });
    replayHeat = buildEvolutionMatrix(replaySeries, 72);
    replayFrame = 0;
    replayLastTs = null;
    if (replaySeries.time.length) {
      const dur = replaySeries.time[replaySeries.time.length - 1];
      const scrb = document.getElementById('replayScrub') as HTMLInputElement;
      if (scrb) { scrb.max = '1000'; scrb.value = '0'; }
      document.getElementById('replayTime')!.textContent = `00:00 / ${fmtRecTime(dur)}`;
    }
    replayReflectOnDashboard();
    drawReplayFingerprint(true);
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
  ctx.fillStyle = cssToken('--bg-1');
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
    drawReplayFingerprint();
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
  drawReplayFingerprint();
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
initReplayResize();

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
  traceDirty = true;
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
  traceDirty = true;
  updateTransportUI();
}
function clearLiveView() {
  traceData = newTraceChannels(traceData.length);
  historyData = newHistoryChannels(historyData.length);
  frozenTrace = [];
  liveScrollSeek = 0;
  isLiveScrubbing = false;
  lastSampleTime = 0;
  traceDirty = true;
  updateTransportUI();
  updateScrubber();
  refreshFpSource();
}
// Seek: samples back from the newest sample. 0 = live following.
function setLiveSeek(offsetSamples: number) {
  const maxSeek = Math.max(0, (historyData[0] ? historyData[0].length : 0) - liveWindowSamples);
  liveScrollSeek = Math.max(0, Math.min(maxSeek, Math.round(offsetSamples)));
  isLiveScrubbing = liveScrollSeek > 0;
  traceDirty = true;
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
function liveHistorySource(): number[][] | RingBuffer[] {
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
document.getElementById('dashExplore')?.addEventListener('click', () => {
  showWorkspaceView('smells');
});
document.getElementById('dashPlayground')?.addEventListener('click', () => {
  void openPlayground();
});
document.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement | null)?.closest('[data-playground]');
  if (target) void openPlayground();
});
document.getElementById('dashConnect')?.addEventListener('click', () => {
  showWorkspaceView('system');
  document.querySelector<HTMLElement>('.sys-nav-item[data-sys="connection"]')?.click();
});
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
const DASH_RAIL_KEY = 'osmograph.railWidth';
const DASH_DOCK_KEY = 'osmograph.dockHeight';

function clampPx(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(n, hi));
}

function applyRailWidth(dash: HTMLElement, width?: number): void {
  if (width == null || !Number.isFinite(width)) {
    dash.style.removeProperty('--rail-w');
    return;
  }
  const max = Math.max(220, dash.clientWidth - 430);
  dash.style.setProperty('--rail-w', `${Math.round(clampPx(width, 220, max))}px`);
}

function applyDockHeight(dock: HTMLElement, height?: number): void {
  if (height == null || !Number.isFinite(height)) {
    dock.style.height = '';
    return;
  }
  const parentH = dock.parentElement?.clientHeight || 420;
  // Leave room for the trace header, tag row, and the canvas minimum, so a
  // tall dock never pushes the live trace out of the column.
  const reserve = window.innerHeight <= 700 ? 300 : 380;
  const max = Math.max(160, parentH - reserve);
  dock.style.height = `${Math.round(clampPx(height, 120, max))}px`;
}

function restoreDashboardLayout(): void {
  const dash = document.querySelector('.dashboard') as HTMLElement | null;
  const dock = document.getElementById('underDock');
  const rail = localStorage.getItem(DASH_RAIL_KEY);
  const dockH = localStorage.getItem(DASH_DOCK_KEY);
  if (dash && rail) applyRailWidth(dash, Number(rail));
  if (dock && dockH) applyDockHeight(dock, Number(dockH));
}

function initDashboardResize(): void {
  const dash = document.querySelector('.dashboard') as HTMLElement | null;
  const rail = document.getElementById('railGrip') as HTMLElement | null;
  const dock = document.getElementById('underDock') as HTMLElement | null;
  const dockGrip = document.getElementById('dockGrip') as HTMLElement | null;
  restoreDashboardLayout();

  if (dash && rail) {
    const sidebar = dash.querySelector('.sidebar') as HTMLElement | null;
    let dragging = false;
    let startX = 0;
    let startW = 0;
    const onMove = (ev: PointerEvent) => {
      if (!dragging) return;
      applyRailWidth(dash, startW - (ev.clientX - startX));
    };
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      const w = sidebar?.getBoundingClientRect().width || 0;
      if (w > 0) localStorage.setItem(DASH_RAIL_KEY, String(Math.round(w)));
      resizeTraces();
    };
    rail.addEventListener('pointerdown', (ev) => {
      dragging = true;
      startX = ev.clientX;
      startW = sidebar?.getBoundingClientRect().width || 300;
      ev.preventDefault();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
    });
    rail.addEventListener('dblclick', () => {
      applyRailWidth(dash);
      localStorage.removeItem(DASH_RAIL_KEY);
      resizeTraces();
    });
    rail.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight' && ev.key !== 'Home') return;
      ev.preventDefault();
      if (ev.key === 'Home') {
        applyRailWidth(dash);
        localStorage.removeItem(DASH_RAIL_KEY);
      } else {
        const delta = ev.key === 'ArrowLeft' ? 16 : -16;
        const w = (sidebar?.getBoundingClientRect().width || 300) + delta;
        applyRailWidth(dash, w);
        const max = Math.max(220, dash.clientWidth - 430);
        localStorage.setItem(DASH_RAIL_KEY, String(Math.round(clampPx(w, 220, max))));
      }
      resizeTraces();
    });
  }

  if (dock && dockGrip) {
    const toggle = document.getElementById('dockToggle');
    const syncToggle = () => {
      if (toggle) toggle.textContent = dock.classList.contains('collapsed') ? '▦' : '—';
    };
    let dragging = false;
    let startY = 0;
    let startH = 0;
    const onMove = (ev: PointerEvent) => {
      if (!dragging) return;
      applyDockHeight(dock, startH - (ev.clientY - startY));
    };
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      dock.style.transition = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      const h = dock.getBoundingClientRect().height;
      if (h > 0) localStorage.setItem(DASH_DOCK_KEY, String(Math.round(h)));
    };
    dockGrip.addEventListener('pointerdown', (ev) => {
      dragging = true;
      dock.classList.remove('collapsed');
      syncToggle();
      dock.style.transition = 'none';
      startY = ev.clientY;
      startH = dock.getBoundingClientRect().height;
      ev.preventDefault();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
    });
    dockGrip.addEventListener('dblclick', () => {
      dock.classList.toggle('collapsed');
      if (dock.classList.contains('collapsed')) {
        dock.style.height = '';
      } else {
        const saved = localStorage.getItem(DASH_DOCK_KEY);
        if (saved) applyDockHeight(dock, Number(saved));
      }
      syncToggle();
    });
    dockGrip.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown' && ev.key !== 'Home') return;
      ev.preventDefault();
      dock.classList.remove('collapsed');
      syncToggle();
      if (ev.key === 'Home') {
        applyDockHeight(dock);
        localStorage.removeItem(DASH_DOCK_KEY);
      } else {
        const delta = ev.key === 'ArrowUp' ? 24 : -24;
        applyDockHeight(dock, dock.getBoundingClientRect().height + delta);
        localStorage.setItem(DASH_DOCK_KEY, String(Math.round(dock.getBoundingClientRect().height)));
      }
    });
  }

  window.addEventListener('resize', () => {
    if (dash) {
      const w = dash.style.getPropertyValue('--rail-w');
      if (w) applyRailWidth(dash, parseFloat(w));
    }
    if (dock && dock.style.height) applyDockHeight(dock, parseFloat(dock.style.height));
    resizeTraces();
  });
}

(document.getElementById('dockToggle') as HTMLButtonElement | null)?.addEventListener('click', () => {
  const dock = document.getElementById('underDock');
  if (!dock) return;
  const collapsed = dock.classList.toggle('collapsed');
  if (collapsed) {
    dock.style.height = '';
  } else {
    const saved = localStorage.getItem(DASH_DOCK_KEY);
    if (saved) applyDockHeight(dock, Number(saved));
  }
  const btn = document.getElementById('dockToggle');
  if (btn) btn.textContent = collapsed ? '▦' : '—';
});
initDashboardResize();
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
// The canvas only changes when new samples arrive, the crosshair moves, or the
// user scrubs — gate re-renders on that instead of repainting at 60 fps while
// idle. A slow 250 ms heartbeat keeps the time axis / HUD ticking on still data.
function animate() {
  const now = performance.now();
  if (traceDirty || now - lastTraceDraw > 250) {
    drawTraces();
    lastTraceDraw = now;
    traceDirty = false;
  }
  updateSessionTime();
  updateTransportUI();
  requestAnimationFrame(animate);
}

// === Periodic Updates ===
setInterval(updateSensorHealth, 2000);
setInterval(updateOledPreview, 1000);
phasePollTick();
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

function drawPhenoBars(values: number[], validGeometry: boolean) {
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
  if (values.length === 0) {
    ctx.fillStyle = cssVarColor('--text-3');
    ctx.globalAlpha = 0.7;
    ctx.font = `${Math.max(8, Math.round(h * 0.24 * dpr))}px monospace`;
    ctx.textBaseline = 'middle';
    ctx.fillText('no fingerprint', 4 * dpr, ph / 2);
    ctx.globalAlpha = 1;
    return;
  }
  const maxAbs = Math.max(...values.map(v => Math.abs(v)), 0.001);
  const pad = 2 * dpr;
  const bw = (pw - pad * 2) / values.length;
  const mid = ph / 2;
  // Signed profile: the live monitor must not collapse reducing and oxidising
  // into the same magnitude bar. Green = reducing, amber = oxidising.
  ctx.strokeStyle = cssVarColor('--border');
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.moveTo(pad, mid);
  ctx.lineTo(pw - pad, mid);
  ctx.stroke();
  ctx.globalAlpha = 1;
  const reducing = cssVarColor('--green');
  const oxidizing = cssVarColor('--yellow');
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v) || Math.abs(v) < 1e-12) continue;
    const bh = Math.max(1.5 * dpr, (Math.abs(v) / maxAbs) * (ph / 2 - pad));
    ctx.fillStyle = v < 0 ? reducing : oxidizing;
    ctx.globalAlpha = validGeometry ? 0.9 : 0.6;
    if (v < 0) ctx.fillRect(pad + i * bw, mid, Math.max(1, bw - dpr), bh);
    else ctx.fillRect(pad + i * bw, mid - bh, Math.max(1, bw - dpr), bh);
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
  // The fingerprint cell hosts the live radar; the honesty caveats (what the
  // measured phenotype can/can't claim) belong on the ⓘ affordance's hover
  // tooltip rather than cluttering the canvas.
  const el = document.getElementById('phenoBoundList');
  if (el) el.innerHTML = '';
  const hint = document.querySelector('#phenoBound .fp-hint');
  if (hint) {
    const cannot = p.boundaries_cannot.map((b) => `✗ ${b}`).join('\n');
    hint.setAttribute('title', `${cannot}\n\n${p.caveat}`);
  }
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
    tag.textContent = p.has_data ? `Direction · ${p.a1.valence}` : 'Direction —';
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
  if (cap) cap.textContent = `${p.per_channel.length} channels · signed ΔR/R0 · ${p.a3.reason}`;
  drawPhenoBars(p.per_channel.map(c => c.delta), p.reference_geometry);

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
refreshPorts().then(() => {
  maybeAutoReconnect();
  // A single USB-serial instrument is unambiguous: open it instead of sitting
  // on an empty cockpit until the user hunts for Connect. Saved connections
  // get first refusal above; this only fires when nothing claimed the port.
  setTimeout(() => { void autoConnectSoleRig(); }, 1400);
});

let autoConnectTried = false;
async function autoConnectSoleRig(): Promise<void> {
  if (connected || autoConnectTried) return;
  const mode = (document.getElementById('modeSelect') as HTMLSelectElement | null)?.value;
  if (mode && mode !== 'serial') return;
  const sel = document.getElementById('portSelect') as HTMLSelectElement | null;
  if (!sel) return;
  const ports = Array.from(sel.options)
    .map(o => o.value)
    .filter(v => /^(?:\/dev\/tty(?:USB|ACM)\d+|COM\d+)$/i.test(v));
  if (ports.length !== 1) return;
  autoConnectTried = true;
  sel.value = ports[0];
  const msg = document.getElementById('connMsg');
  if (msg) {
    msg.textContent = `Detected ${ports[0]} — connecting…`;
    msg.style.color = 'var(--text-2)';
  }
  await toggleConnection();
}

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
setPlotLink(false);
renderLiveState();
loadChangeLog();
renderChangeLog();
initDatasetCatalog();
initRecipes();
refreshBurnIn();
refreshDataPanel();
// A fresh install has no recordings. That is the correct empty state: the
// library fills from the user's rig, their imports, or a corpus they fetch.
// Nothing is silently seeded from the developer's machine.
reloadLibrary()
  .then(() => landOnWork())
  .catch((e) => console.error('Boot chain failed:', e));

setTimeout(() => { refreshDataPanel().then(refreshHub).catch(() => {}); }, 200);
checkRecoveredSessions();

// Land where there is something to do. With a device link the live dashboard is
// the right home; with no link it is an empty cockpit, so open the library —
// which now holds the starter pack — instead of a blank instrument panel.
function landOnWork(): void {
  if (connected) return;
  if (!sessions.length) {
    // No rig and no data: show the corpus shelf, not an empty cockpit.
    showWorkspaceView('datasets');
    return;
  }
  const onDashboard = document.querySelector('.tab-btn[data-tab="dashboard"]')?.classList.contains('active');
  if (onDashboard) showWorkspaceView('smells');
}

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

// === Updates ===
// Policy is localStorage-persisted like every other setting. The Rust backend
// enforces the actual check cadence and ETag caching; this just wires the UI.
const UPD_POLICY_KEY = 'osmograph.updatePolicy';

function loadUpdatePolicy(): string {
  try { return localStorage.getItem(UPD_POLICY_KEY) || 'daily'; } catch { return 'daily'; }
}
function saveUpdatePolicy(v: string) {
  try { localStorage.setItem(UPD_POLICY_KEY, v); } catch { /* ignore */ }
}

type UpdateCheckResult = {
  available: boolean;
  latest_version: string;
  current_version: string;
  release_notes: string;
  download_url: string;
  published_at: string;
  policy: string;
  last_checked: number | null;
  checked: boolean;
};

function renderUpdateStatus(msg: string, cls?: string) {
  const el = document.getElementById('updateStatus')!;
  el.textContent = msg;
  el.className = cls || '';
}

function renderUpdateNotes(notes: string, url: string) {
  const el = document.getElementById('updateNotes')!;
  if (!notes && !url) { el.style.display = 'none'; return; }
  el.textContent = notes || '';
  el.style.display = 'block';
}

async function runUpdateCheck(force: boolean) {
  const btn = document.getElementById('updateCheckBtn') as HTMLButtonElement;
  btn.disabled = true;
  renderUpdateStatus('Checking…', '');
  // Insert the spinner via a DOM node so prefers-reduced-motion CSS applies.
  const spinner = document.createElement('span');
  spinner.className = 'update-spinner';
  document.getElementById('updateStatus')!.prepend(spinner);
  try {
    const policy = (document.querySelector('input[name="updPol"]:checked') as HTMLInputElement)?.value || 'daily';
    const res = await invoke<UpdateCheckResult>('check_for_updates', { policy, force });
    if (res.available) {
      renderUpdateStatus(`Update available: v${res.latest_version}`, 'update-avail');
      renderUpdateNotes(res.release_notes, res.download_url);
      // Wire the release-page open once, so repeated checks don't stack handlers.
      const openBtn = document.getElementById('updateOpenBtn') ||
        (() => {
          const b = document.createElement('button');
          b.id = 'updateOpenBtn';
          b.textContent = 'Open download page';
          b.addEventListener('click', () => invoke('open_https_url', { url: res.download_url }));
          document.getElementById('updateStatus')!.after(b);
          return b;
        })();
      (openBtn as HTMLButtonElement).onclick = () => invoke('open_https_url', { url: res.download_url });
    } else {
      renderUpdateStatus('Up to date', 'update-ok');
      renderUpdateNotes('', '');
    }
  } catch (e) {
    // Offline or rate-limited: non-alarming, the user can retry.
    renderUpdateStatus('Could not check (offline?)', '');
  } finally {
    btn.disabled = false;
  }
}

// === Feedback: a prefilled issue the user reviews before anything leaves ===
// Memory only. The last few failures are quoted back to the person reporting
// them, never uploaded, and never written to disk.
const recentFailures: string[] = [];
function noteFailure(message: string): void {
  const at = new Date().toISOString().slice(11, 19);
  recentFailures.push(`${at}Z ${message}`.slice(0, 240));
  if (recentFailures.length > 5) recentFailures.shift();
}
window.addEventListener('error', (e) => noteFailure(String(e.message || e.error || 'script error')));
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason as { message?: string } | string | undefined;
  noteFailure(String(typeof reason === 'string' ? reason : reason?.message || 'unhandled rejection'));
});

async function reportIssue(): Promise<void> {
  const version = await getVersion().catch(() => 'dev');
  const linkText = document.getElementById('plotLinkState')?.textContent?.trim() || 'unknown';
  const rig = connected
    ? `${activeMode || 'serial'} · ${activePort || '—'} @ ${activeBaud || '—'} · ${channelCount || 'auto'} channels · ${liveRateHz.toFixed(1)} Hz`
    : `not connected · last mode ${activeMode || 'none'}`;
  const body = [
    '## What happened',
    '',
    '',
    '## What you expected',
    '',
    '',
    '## Steps to reproduce',
    '1. ',
    '',
    '<details><summary>Diagnostics (no recordings)</summary>',
    '',
    '```',
    `Osmograph ${version}`,
    `Platform: ${navigator.platform}`,
    `UA: ${navigator.userAgent}`,
    `Rig: ${rig}`,
    `Link: ${linkText} · ${sampleCount} samples this session`,
    `Vials: ${installedDomainCount()} installed · ${Domain.allDomainPacks().length} available`,
    recentFailures.length ? `Recent failures:\n${recentFailures.join('\n')}` : 'Recent failures: none captured',
    '```',
    '',
    '</details>',
  ].join('\n');
  const url = `https://github.com/OpenSmell/osmograph-desktop/issues/new?${new URLSearchParams({ title: '[Report] ', body })}`;
  try {
    await invoke('open_https_url', { url });
    showToast('Opened a prefilled issue in your browser. Edit it there, then Submit.');
  } catch (e) {
    showToast(`Could not open the browser: ${e}`);
  }
}
document.getElementById('reportIssueBtn')?.addEventListener('click', () => { void reportIssue(); });

/** A Vial report carries the identity of the Vial that failed, not just the
 *  host. If the Vial names a GitHub source, the author's tracker is the
 *  destination; otherwise the report lands in the Osmograph issue queue with
 *  the id, version, hashes, and profile so it can be reproduced. */
async function reportVialIssue(pack: Domain.DomainPack): Promise<void> {
  const version = await getVersion().catch(() => 'dev');
  const linkText = document.getElementById('plotLinkState')?.textContent?.trim() || 'unknown';
  const rig = connected
    ? `${activeMode || 'serial'} · ${activePort || '—'} @ ${activeBaud || '—'} · ${channelCount || 'auto'} channels · ${liveRateHz.toFixed(1)} Hz`
    : `not connected · last mode ${activeMode || 'none'}`;
  const source = pack.sourceUrl || '';
  const github = source.match(/^https:\/\/github\.com\/([^/]+)\/([^/?#]+)/i);
  const endpoint = github
    ? `https://github.com/${github[1]}/${github[2]}/issues/new`
    : 'https://github.com/OpenSmell/osmograph-desktop/issues/new';
  const assetHashes = pack.assetHashes && Object.keys(pack.assetHashes).length
    ? Object.entries(pack.assetHashes).map(([name, hash]) => `  ${name}: ${hash}`).join('\n')
    : '  none verified';
  const body = [
    '## What happened',
    '',
    '',
    '## What you expected',
    '',
    '',
    '## Steps to reproduce',
    '1. ',
    '',
    '<details><summary>Vial identity</summary>',
    '',
    '```',
    `Vial: ${pack.id} v${pack.version} — ${pack.name}`,
    `Author: ${pack.author}`,
    `Manifest sha256: ${pack.manifestHash || 'unknown (installed before hash pinning)'}`,
    `Source: ${source || 'no source URL recorded'}`,
    `Profile: ${pack.anomaly ? VialProfile.profileSummary(pack.anomaly) : 'legacy manifest (no programmable profile)'}`,
    `Assets:`,
    assetHashes,
    '```',
    '',
    '</details>',
    '',
    '<details><summary>Diagnostics (no recordings)</summary>',
    '',
    '```',
    `Osmograph ${version}`,
    `Platform: ${navigator.platform}`,
    `UA: ${navigator.userAgent}`,
    `Rig: ${rig}`,
    `Link: ${linkText} · ${sampleCount} samples this session`,
    `Vials: ${installedDomainCount()} installed · ${Domain.allDomainPacks().length} available`,
    recentFailures.length ? `Recent failures:\n${recentFailures.join('\n')}` : 'Recent failures: none captured',
    '```',
    '',
    '</details>',
  ].join('\n');
  const title = `${github ? '[Vial]' : '[Vial report]'} ${pack.id} v${pack.version} — `;
  const url = `${endpoint}?${new URLSearchParams({ title, body })}`;
  try {
    await invoke('open_https_url', { url });
    showToast(github
      ? `Opened a prefilled issue on ${github[1]}/${github[2]}. Edit it there, then Submit.`
      : 'Opened a prefilled Osmograph issue with this Vial’s identity. Edit it there, then Submit.');
  } catch (e) {
    showToast(`Could not open the browser: ${e}`);
  }
}

// Restore persisted policy onto the radios.
(function initUpdatePolicy() {
  const saved = loadUpdatePolicy();
  const radio = document.querySelector(`input[name="updPol"][value="${saved}"]`) as HTMLInputElement | null;
  if (radio) radio.checked = true;
})();

document.getElementById('updatePolicy')!.addEventListener('change', (e) => {
  const v = (e.target as HTMLInputElement).value;
  saveUpdatePolicy(v);
});

document.getElementById('updateCheckBtn')!.addEventListener('click', () => runUpdateCheck(true));

// Silent on-launch check, gated by the persisted policy and last-check time.
// The backend enforces the 24h cooldown, so this fires on every launch and the
// decision happens server-side — one code path for both auto and manual.
(async () => {
  const policy = loadUpdatePolicy();
  if (policy === 'never' || policy === 'manual') return;
  try {
    const res = await invoke<UpdateCheckResult>('check_for_updates', { policy, force: false });
    if (res.available) {
      renderUpdateStatus(`Update available: v${res.latest_version}`, 'update-avail');
      renderUpdateNotes(res.release_notes, res.download_url);
    }
  } catch { /* silent: launch checks must never block or alarm */ }
})();
