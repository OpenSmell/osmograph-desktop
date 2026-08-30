import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// === Constants ===
const MAX_TRACE = 800;
const DATA_CHANNELS = 6;
const CH_COLORS = ['#4ade80', '#60a5fa', '#f87171', '#fbbf24', '#a78bfa', '#f472b6', '#22d3ee', '#fb923c'];
const PRESETS: Record<string, { name: string; sensors: string[] }> = {
  '3-sensor-food': { name: '3-Sensor Food', sensors: ['MQ-135', 'MQ-3', 'MQ-7'] },
  '4-sensor-safety': { name: '4-Sensor Safety', sensors: ['MQ-7', 'MQ-8', 'MQ-135', 'MQ-3'] },
  '6-sensor-full': { name: '6-Sensor Full', sensors: ['MQ-135', 'MQ-3', 'MQ-6', 'MQ-7', 'MQ-4', 'MQ-8'] },
};

function toDataChannels(values: number[]): number[] {
  const out = values.slice(0, DATA_CHANNELS);
  while (out.length < DATA_CHANNELS) out.push(0);
  return out;
}

// === State ===
let connected = false;
let activeMode: 'serial' | 'wifi' | 'ble' = 'serial';
let sessionStart: number | null = null;
let sampleCount = 0;
let lastSampleTime = 0;
let activePreset = '6-sensor-full';
let chNames: string[] = PRESETS['6-sensor-full'].sensors;
let traceData: number[][] = chNames.map(() => []);
let sessionLabels: { ts: number; anomaly: boolean; note: string }[] = [];
let sessions: SessionRecord[] = [];
let selectedSession: number | null = null;
let compareFiles: string[] = [];
const compareSeriesCache = new Map<string, SessionSeries | null>();
let compareLoaded: (SessionSeries | null)[] = [];
let compareChannel = '';
let fleetDevices: FleetDevice[] = [];
let bleDevices: { name: string; address: string }[] = [];
let demoPhase = 0;
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
  firmware: string;
  uptime_seconds: number;
  ip: string;
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
    if (tab === 'compare') {
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
  tracesCanvas.width = rect.width;
  tracesCanvas.height = rect.height;
}
resizeTraces();
window.addEventListener('resize', resizeTraces);

function drawTraces() {
  const w = tracesCanvas.width, h = tracesCanvas.height;
  tracesCtx.fillStyle = '#fafafa';
  tracesCtx.fillRect(0, 0, w, h);

  // Grid lines
  tracesCtx.strokeStyle = '#ececef';
  tracesCtx.lineWidth = 1;
  for (let i = 1; i < 5; i++) {
    const y = (h / 5) * i;
    tracesCtx.beginPath(); tracesCtx.moveTo(0, y); tracesCtx.lineTo(w, y); tracesCtx.stroke();
  }

  let gMin = Infinity, gMax = -Infinity;
  for (const ch of traceData) {
    for (const v of ch) {
      if (v < gMin) gMin = v;
      if (v > gMax) gMax = v;
    }
  }
  if (gMin === Infinity) return;
  const range = gMax - gMin || 1;
  gMin -= range * 0.1;
  gMax += range * 0.1;
  const span = gMax - gMin;

  for (let ch = 0; ch < traceData.length; ch++) {
    const data = traceData[ch];
    if (data.length < 2) continue;
    tracesCtx.strokeStyle = CH_COLORS[ch % CH_COLORS.length];
    tracesCtx.lineWidth = 1.2;
    tracesCtx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (i / (MAX_TRACE - 1)) * w;
      const y = h - ((data[i] - gMin) / span) * h;
      i === 0 ? tracesCtx.moveTo(x, y) : tracesCtx.lineTo(x, y);
    }
    tracesCtx.stroke();
  }
}

// === Canvas: Fingerprint (radar) ===
const fpCanvas = document.getElementById('fingerprint') as HTMLCanvasElement;
const fpCtx = fpCanvas.getContext('2d')!;

function drawFingerprint(values: number[]) {
  const rect = fpCanvas.parentElement!.getBoundingClientRect();
  fpCanvas.width = rect.width - 8;
  fpCanvas.height = 120;
  const w = fpCanvas.width, h = fpCanvas.height;
  const cx = w / 2, cy = h / 2, r = Math.min(cx, cy) - 10;
  fpCtx.clearRect(0, 0, w, h);

  const n = values.length || chNames.length;
  if (n === 0) return;

  // Grid rings
  for (let ring = 1; ring <= 4; ring++) {
    fpCtx.strokeStyle = '#d4d4d8';
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
    fpCtx.strokeStyle = '#d4d4d8';
    fpCtx.beginPath();
    fpCtx.moveTo(cx, cy);
    fpCtx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
    fpCtx.stroke();
  }

  if (values.length === 0) return;

  // Normalize values
  const maxVal = Math.max(...values, 1);

  // Fill
  fpCtx.fillStyle = 'rgba(74, 222, 128, 0.15)';
  fpCtx.strokeStyle = '#4ade80';
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
    fpCtx.fillStyle = CH_COLORS[i % CH_COLORS.length];
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
    sfpCtx.strokeStyle = '#d4d4d8'; sfpCtx.lineWidth = 1; sfpCtx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(a) * rr * (ring / 4);
      const y = cy + Math.sin(a) * rr * (ring / 4);
      i === 0 ? sfpCtx.moveTo(x, y) : sfpCtx.lineTo(x, y);
    }
    sfpCtx.stroke();
  }
  const maxVal = Math.max(...values, 1);
  sfpCtx.fillStyle = 'rgba(96, 165, 250, 0.15)';
  sfpCtx.strokeStyle = '#60a5fa'; sfpCtx.lineWidth = 2;
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
    sfpCtx.fillStyle = CH_COLORS[i % CH_COLORS.length];
    sfpCtx.beginPath(); sfpCtx.arc(cx + Math.cos(a) * rr * norm, cy + Math.sin(a) * rr * norm, 3, 0, Math.PI * 2); sfpCtx.fill();
    sfpCtx.fillStyle = '#666';
    sfpCtx.fillText(chNames[i] || `CH${i}`, cx + Math.cos(a) * (rr + 10), cy + Math.sin(a) * (rr + 10) + 3);
  }
}

// === Trace Legend ===
function buildLegend() {
  const el = document.getElementById('traceLegend')!;
  el.innerHTML = chNames.map((name, i) =>
    `<span><span class="swatch" style="background:${CH_COLORS[i % CH_COLORS.length]}"></span>${name}</span>`
  ).join('');
}
buildLegend();

// === Data Ingestion ===
async function ingestReading(values: number[], demo = false) {
  if (values.length === 0) return;
  for (let ch = 0; ch < Math.min(values.length, traceData.length); ch++) {
    traceData[ch].push(values[ch]);
    if (traceData[ch].length > MAX_TRACE) traceData[ch].shift();
  }
  sampleCount++;

  // Update fingerprint
  drawFingerprint(values);

  // Demo/synthetic samples are purely visual — never feed the real detector,
  // live classifier, or recorder so backend state stays clean for real data.
  if (!demo) {
    try {
      const result = await invoke<{
        is_anomaly: boolean; raw_score: number; calibrated_confidence: number;
        triggered_channels: number[]; alert_level: number; alert_name: string;
        consecutive_anomalies: number;
      }>('ingest_reading_with_failsafe', { reading: values });

      // Anomaly card
      const card = document.getElementById('anomalyCard')!;
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
    } catch (err) {
      console.error('Detection error:', err);
    }
  } else {
    document.getElementById('anomalyLabel')!.textContent = 'DEMO';
    document.getElementById('anomalySub')!.textContent = 'Synthetic samples — connect a device for live detection';
    document.getElementById('statusDot')!.className = 'status-dot';
  }

  // Rate counter
  const now = Date.now();
  if (lastSampleTime > 0) {
    const rate = 1000 / (now - lastSampleTime);
    document.getElementById('fRate')!.textContent = `${rate.toFixed(1)} Hz`;
  }
  lastSampleTime = now;
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
    const ports = await invoke<{ name: string; description: string; hw_type: string }[]>('list_serial_ports');
    const sel = document.getElementById('portSelect') as HTMLSelectElement;
    const cur = sel.value;
    sel.innerHTML = '<option value="">Select port...</option>';
    for (const p of ports) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.description ? `${p.name} — ${p.description}` : p.name;
      if (p.name === cur) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch (e) {
    console.error('Port refresh failed:', e);
  }
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
      sel.innerHTML = '<option value="">No Osmograph-BLE found</option>';
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
async function toggleConnection() {
  const port = (document.getElementById('portSelect') as HTMLSelectElement).value;
  const baud = parseInt((document.getElementById('baudSelect') as HTMLSelectElement).value);
  const mode = (document.getElementById('modeSelect') as HTMLSelectElement).value as 'serial' | 'wifi' | 'ble';

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
    return;
  }

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
      await invoke('connect_wifi', { host, port: portN, nChannels: DATA_CHANNELS });
      activeMode = 'wifi';
      connected = true;
      document.getElementById('connectBtn')!.textContent = 'Disconnect';
      document.getElementById('statusDot')!.className = 'status-dot ok';
      document.getElementById('fDevice')!.textContent = addr;
      sampleCount = 0;
    } catch (e) {
      console.error('WiFi connect failed:', e);
    }
    return;
  }
  if (mode === 'ble') {
    const addr = (document.getElementById('bleSelect') as HTMLSelectElement).value;
    if (!addr) {
      console.warn('Scan for devices (↻), then select one to connect.');
      return;
    }
    try {
      await invoke('connect_ble', { address: addr });
      activeMode = 'ble';
      connected = true;
      document.getElementById('connectBtn')!.textContent = 'Disconnect';
      document.getElementById('statusDot')!.className = 'status-dot ok';
      document.getElementById('fDevice')!.textContent = addr;
      sampleCount = 0;
    } catch (e) {
      console.error('BLE connect failed:', e);
    }
    return;
  }

  if (port) {
    try {
      await invoke('connect_serial', { port, baudRate: baud, nChannels: DATA_CHANNELS });
      activeMode = 'serial';
      connected = true;
      document.getElementById('connectBtn')!.textContent = 'Disconnect';
      document.getElementById('statusDot')!.className = 'status-dot ok';
      document.getElementById('fDevice')!.textContent = port;
      sampleCount = 0;
    } catch (e) {
      console.error('Connect failed:', e);
    }
  }
}

// === Labeling ===
async function labelCurrent(isAnomaly: boolean) {
  const values = traceData.map(ch => ch[ch.length - 1] || 0);
  try {
    await invoke('label_sample', {
      reading: values,
      isAnomaly,
      note: isAnomaly ? 'User flagged anomaly' : 'User confirmed normal',
    });
    sessionLabels.push({ ts: Date.now(), anomaly: isAnomaly, note: isAnomaly ? 'Anomaly' : 'Normal' });
    updateLabelUI();
  } catch (e) {
    console.error('Label failed:', e);
  }
}

async function updateLabelUI() {
  try {
    const stats = await invoke<{ total: number; normal: number; anomaly: number; anomaly_ratio: number }>('get_labeling_stats');
    document.getElementById('mLabels')!.textContent = stats.total.toString();
    document.getElementById('mAnomPct')!.textContent = `${(stats.anomaly_ratio * 100).toFixed(0)}%`;
  } catch {}
  try {
    const state = await invoke<{ thresholds: Array<{ confidence: number }>; n_feedback: number }>('get_detector_state');
    const avg = state.thresholds.reduce((a, t) => a + t.confidence, 0) / Math.max(state.thresholds.length, 1);
    document.getElementById('mThreshConf')!.textContent = `${(avg * 100).toFixed(0)}%`;
    document.getElementById('learningBar')!.style.width = `${(avg * 100).toFixed(0)}%`;
    document.getElementById('mFeedback')!.textContent = `${state.n_feedback} feedback samples`;
  } catch {}
}

// === Sensor Health ===
async function updateSensorHealth() {
  try {
    const health = await invoke<Array<{ channel: number; health_score: number; status: string; mean: number }>>('get_sensor_health');
    const el = document.getElementById('sensorHealthList')!;
    if (health.length === 0) {
      el.innerHTML = '<div style="font-size:10px;color:var(--text-3)">No data</div>';
      return;
    }
    el.innerHTML = health.map((h, i) => {
      const color = h.status === 'OK' ? 'var(--green)' : h.status === 'WARNING' ? 'var(--yellow)' : 'var(--red)';
      return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
        <div style="width:6px;height:6px;border-radius:50%;background:${color}"></div>
        <span style="font-size:10px;flex:1;color:var(--text-2)">${chNames[i] || `CH${i}`}</span>
        <span style="font-size:10px;color:var(--text-3)">${h.mean.toFixed(1)}</span>
      </div>`;
    }).join('');
  } catch {}
}

// === Library ===
function renderLibrary() {
  const body = document.getElementById('libBody')!;
  body.innerHTML = sessions.map((s, i) => {
    const qBadge = s.quality >= 70 ? 'good' : s.quality >= 40 ? 'ok' : 'bad';
    const ticked = s.file_id ? compareFiles.includes(s.file_id) : false;
    return `<tr class="${i === selectedSession ? 'selected' : ''}" data-idx="${i}">
      <td><input type="checkbox" class="compare-tick" data-idx="${i}" ${ticked ? 'checked' : ''} title="Overlay in Compare"></td>
      <td>${s.time}</td><td>${s.substance}</td><td>${s.label}</td>
      <td>${s.format}</td><td>${s.duration}</td><td>${s.sensors}</td>
      <td><span class="quality-badge ${qBadge}">${s.quality}</span></td>
    </tr>`;
  }).join('');
  document.getElementById('libStatus')!.textContent = `${sessions.length} sessions`;
  body.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => {
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
}

function inspectSession(s: SessionRecord) {
  const details = `
    <div style="margin-bottom:6px"><strong>${s.substance}</strong></div>
    <div>Label: ${s.label}</div>
    <div>Format: ${s.format}</div>
    <div>Duration: ${s.duration}</div>
    <div>Sensors: ${s.sensors}</div>
    <div>Quality: ${s.quality}/100</div>
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

// === Compare Panel (Python `viz/compare_panel.py` parity) ===
const CHART_COLORS = ['#4f8df7', '#4ade80', '#f59e0b', '#f472b6', '#a78bfa', '#22d3ee', '#f87171', '#34d399'];
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

function renderCompareLabels() {
  const el = document.getElementById('compareLabels')!;
  const parts = compareLoaded.map((r, i) => {
    const name = r ? r.label : '(unreadable)';
    return `<b style="color:${CHART_COLORS[i % CHART_COLORS.length]};">${i + 1}. </b>${name}`;
  }).join(' · ');
  el.innerHTML = parts;
}

function drawCompare() {
  const ctx = compareCtx;
  const canvas = compareCanvas;
  if (!ctx || !canvas) return;
  const wrap = document.getElementById('compareWrap')!;
  const rect = wrap.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width - 2));
  canvas.height = Math.max(1, Math.floor(rect.height - 2));
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (!compareChannel) {
    ctx.fillStyle = '#666';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      compareFiles.length === 0
        ? 'No sessions selected. Tick sessions in the Library to overlay them here.'
        : 'No readable sessions selected.',
      w / 2, h / 2,
    );
    return;
  }

  type Curve = { x: number[]; y: number[] };
  const curves: Curve[] = [];
  for (const s of compareLoaded) {
    if (!s) continue;
    const ci = s.channels.indexOf(compareChannel);
    if (ci < 0) continue;
    const r0 = compareR0(s.values[ci]);
    if (r0 === null) continue;
    curves.push({
      x: s.time.slice(0, s.values[ci].length),
      y: s.values[ci].map(v => (v - r0) / r0),
    });
  }
  if (curves.length === 0) {
    ctx.fillStyle = '#666';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Channel "${compareChannel}" not present in selected sessions.`, w / 2, h / 2);
    return;
  }

  const pad = { left: 54, right: 16, top: 14, bottom: 32 };
  const pw = w - pad.left - pad.right;
  const ph = h - pad.top - pad.bottom;
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const c of curves) {
    for (const v of c.x) { if (v < xMin) xMin = v; if (v > xMax) xMax = v; }
    for (const v of c.y) { if (v < yMin) yMin = v; if (v > yMax) yMax = v; }
  }
  if (xMin === xMax) { xMin -= 0.5; xMax += 0.5; }
  if (yMin === yMax) { yMin -= 0.5; yMax += 0.5; }
  const sx = (v: number) => pad.left + (v - xMin) / (xMax - xMin) * pw;
  const sy = (v: number) => pad.top + ph - (v - yMin) / (yMax - yMin) * ph;

  ctx.strokeStyle = 'rgba(8,8,12,0.06)';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 5; g++) {
    const gy = pad.top + (ph / 5) * g;
    ctx.beginPath(); ctx.moveTo(pad.left, gy); ctx.lineTo(w - pad.right, gy); ctx.stroke();
    const gx = pad.left + (pw / 5) * g;
    ctx.beginPath(); ctx.moveTo(gx, pad.top); ctx.lineTo(gx, pad.top + ph); ctx.stroke();
  }
  ctx.strokeStyle = '#333';
  ctx.strokeRect(pad.left, pad.top, pw, ph);

  ctx.font = '9px -apple-system, sans-serif';
  ctx.fillStyle = '#666';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let g = 0; g <= 5; g++) {
    const val = xMin + (xMax - xMin) * (g / 5);
    ctx.fillText(val >= 100 || val <= -100 ? val.toFixed(0) : val.toFixed(1),
      pad.left + (pw / 5) * g, pad.top + ph + 4);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let g = 0; g <= 5; g++) {
    const val = yMax - (yMax - yMin) * (g / 5);
    ctx.fillText(val.toFixed(2), pad.left - 6, pad.top + (ph / 5) * g);
  }
  ctx.textBaseline = 'alphabetic';

  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('relative time (s)', pad.left + pw / 2, h - 3);
  ctx.save();
  ctx.translate(12, pad.top + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('(R - R0)/R0', 0, 0);
  ctx.restore();

  curves.forEach((c, i) => {
    ctx.strokeStyle = CHART_COLORS[i % CHART_COLORS.length];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    c.x.forEach((xv, k) => {
      const X = sx(xv), Y = sy(c.y[k]);
      k === 0 ? ctx.moveTo(X, Y) : ctx.lineTo(X, Y);
    });
    ctx.stroke();
  });
}

async function updateCompare() {
  const countEl = document.getElementById('compareCount')!;
  const channelEl = document.getElementById('compareChannel') as HTMLSelectElement;
  if (compareFiles.length === 0) {
    compareLoaded = [];
    countEl.textContent = '';
    document.getElementById('compareLabels')!.innerHTML = '';
    channelEl.innerHTML = '';
    channelEl.disabled = true;
    compareChannel = '';
    drawCompare();
    return;
  }
  compareLoaded = await Promise.all(compareFiles.map(id => loadCompareSeries(id)));
  countEl.textContent = `${compareLoaded.filter(Boolean).length} session(s)`;
  renderCompareLabels();
  let channels: string[] = [];
  for (const s of compareLoaded) {
    if (s && s.channels.length) { channels = s.channels; break; }
  }
  const prev = compareChannel;
  channelEl.innerHTML = channels.map(c => `<option value="${c}">${c}</option>`).join('');
  channelEl.disabled = channels.length === 0;
  compareChannel = channels.includes(prev) ? prev : (channels[0] || '');
  channelEl.value = compareChannel;
  drawCompare();
}

// === Fleet ===
function renderFleet() {
  const grid = document.getElementById('fleetGrid')!;
  if (fleetDevices.length === 0) {
    grid.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-3);font-size:12px">No devices found. Click "Scan Network" or "+ Add Device".</div>';
    document.getElementById('fleetBadge')!.style.display = 'none';
    return;
  }
  document.getElementById('fleetBadge')!.style.display = '';
  document.getElementById('fleetBadge')!.textContent = fleetDevices.length.toString();
  grid.innerHTML = fleetDevices.map(d => {
    const statusClass = d.status;
    const sensorsHtml = d.sensors.map(s =>
      `<div class="sensor-slot${s.name === 'Empty' ? ' empty' : ''}">
        <div class="s-name">${s.name}</div>
        <div class="s-val" style="color:${s.health === 'OK' ? 'var(--green)' : s.health === 'WARNING' ? 'var(--yellow)' : 'var(--red)'}">${s.value > 0 ? s.value.toFixed(0) + ' Ω' : '--'}</div>
      </div>`
    ).join('');
    return `<div class="device-card">
      <div class="dev-header">
        <div class="dev-name">${d.name}</div>
        <span class="dev-status ${statusClass}">${d.status}</span>
      </div>
      <div style="font-size:10px;color:var(--text-3)">IP: ${d.ip || '—'} · FW: ${d.firmware} · Up: ${d.uptime_seconds > 0 ? Math.round(d.uptime_seconds) + 's' : '—'}</div>
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

// === Preset Change ===
function onPresetChange(preset: string) {
  activePreset = preset;
  const p = PRESETS[preset];
  if (!p) return;
  chNames = p.sensors;
  traceData = chNames.map(() => []);
  buildLegend();
  const detail = document.getElementById('presetDetail');
  if (detail) {
    detail.innerHTML = `<div style="font-size:11px;color:var(--text-2)">
      <strong>${p.name}</strong> — ${p.sensors.length} sensors<br/>
      ${p.sensors.map((s, i) => `<span style="color:${CH_COLORS[i]}">${s}</span>`).join(' · ')}
    </div>`;
  }
  // Channel mapping
  const mapping = document.getElementById('channelMapping');
  if (mapping) {
    mapping.innerHTML = p.sensors.map((s, i) =>
      `<div class="form-row">
        <label style="color:${CH_COLORS[i]}">Slot ${i + 1}</label>
        <select style="width:120px"><option selected>${s}</option><option>Empty</option></select>
        <span class="hint">GPIO ${32 + i * 2}</span>
      </div>`
    ).join('');
  }
}

// === Demo Data ===
function updateDemoBadge() {
  const el = document.getElementById('demoBadge');
  if (el) el.style.display = connected ? 'none' : '';
}
function generateDemoData() {
  updateDemoBadge();
  if (connected) return;
  demoPhase += 0.05;
  const values: number[] = [];
  for (let i = 0; i < DATA_CHANNELS; i++) {
    const base = 1200 + i * 200;
    const wave = Math.sin(demoPhase * (0.5 + i * 0.2)) * (100 + i * 30);
    const noise = (Math.random() - 0.5) * 40;
    values.push(base + wave + noise);
  }
  ingestReading(values, true);
}

// === Classifier: Train Tab ===
function renderTrain() {
  const body = document.getElementById('trainBody')!;
  body.innerHTML = sessions.map((s, i) => {
    const fid = s.file_id || '';
    const checked = fid ? trainSelected.has(fid) : false;
    const qBadge = s.quality >= 70 ? 'good' : s.quality >= 40 ? 'ok' : 'bad';
    const filename = s.path ? String(s.path).split('/').pop() || s.label : s.substance;
    return `<tr>
      <td><input type="checkbox" class="train-tick" data-fid="${fid}" ${checked ? 'checked' : ''} ${fid ? '' : 'disabled'}></td>
      <td>${s.time}</td>
      <td>${s.substance}</td>
      <td><input type="text" class="train-label" data-fid="${fid}" value="${s.substance.replace(/"/g, '&quot;')}" placeholder="label" ${fid ? '' : 'disabled'} /></td>
      <td style="overflow:hidden;text-overflow:ellipsis;color:var(--text-2)" title="${filename}">${filename}</td>
      <td><span class="quality-badge ${qBadge}">${s.quality}</span></td>
    </tr>`;
  }).join('');
  document.getElementById('trainStatus')!.textContent =
    `${sessions.length} recordings — tick at least 2 with ≥8 windows/class to train`;
  body.querySelectorAll('.train-tick').forEach(cb => {
    cb.addEventListener('change', () => {
      const box = cb as HTMLInputElement;
      const fid = box.getAttribute('data-fid')!;
      if (box.checked) trainSelected.add(fid);
      else trainSelected.delete(fid);
      updateTrainButton();
    });
  });
  updateTrainButton();
}

function updateTrainButton() {
  const btn = document.getElementById('trainBtn') as HTMLButtonElement;
  btn.disabled = trainSelected.size < 2;
}

async function trainClassifier() {
  const log = document.getElementById('trainLog')!;
  const name = (document.getElementById('trainName') as HTMLInputElement).value.trim();
  const windowSize = parseInt((document.getElementById('trainWindow') as HTMLInputElement).value) || 100;
  const minQuality = parseFloat((document.getElementById('trainMinQuality') as HTMLInputElement).value) || 0;
  if (!name) { log.innerHTML = '<span class="train-err">Enter a classifier name.</span>'; return; }
  if (trainSelected.size < 2) { log.innerHTML = '<span class="train-err">Select at least 2 recordings.</span>'; return; }
  const fileIds = Array.from(trainSelected);
  const labels = fileIds.map(fid => {
    const inp = document.querySelector(`.train-label[data-fid="${fid}"]`) as HTMLInputElement;
    return inp ? inp.value.trim() : '';
  });
  log.innerHTML = 'Training…';
  try {
    const res = await invoke<{ report: TrainingReport; path: string }>('train_classifier', {
      fileIds, labels, name, windowSize, minQuality,
    });
    renderModelCard(res.report);
    log.innerHTML = '<span style="color:var(--green)">✓ Trained and saved: ' + res.report.name + ' (JSON)</span>';
    onPresetChange(activePreset); // refresh dashboard live-classifier model list
  } catch (e) {
    log.innerHTML = `<span class="train-err">${String(e)}</span>`;
  }
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
    ${warnings}
  `;
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
  const colors = CH_COLORS;
  wrap.innerHTML = classes.map((c, i) => {
    const p = probs[i] || 0;
    const color = colors[i % colors.length];
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
document.getElementById('modeSelect')!.addEventListener('change', () => {
  const value = (document.getElementById('modeSelect') as HTMLSelectElement).value;
  const wifi = document.getElementById('wifiAddr') as HTMLInputElement;
  const ble = document.getElementById('bleSelect') as HTMLSelectElement;
  wifi.style.display = value === 'wifi' ? '' : 'none';
  ble.style.display = value === 'ble' ? '' : 'none';
  if (value === 'ble') scanBleDevices();
});
document.getElementById('connectBtn')!.addEventListener('click', toggleConnection);
document.getElementById('refreshBtn')!.addEventListener('click', () => {
  const mode = (document.getElementById('modeSelect') as HTMLSelectElement).value;
  if (mode === 'ble') scanBleDevices();
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
document.getElementById('labelNormal')!.addEventListener('click', () => labelCurrent(false));
document.getElementById('labelAnomaly')!.addEventListener('click', () => labelCurrent(true));

document.getElementById('compareChannel')!.addEventListener('change', (e) => {
  compareChannel = (e.target as HTMLSelectElement).value;
  drawCompare();
});

document.getElementById('libRefresh')!.addEventListener('click', () => reloadLibrary());

document.getElementById('inspAnalyze')!.addEventListener('click', async () => {
  const s = sessions[selectedSession ?? -1];
  if (!s) return;
  const btn = document.getElementById('inspAnalyze') as HTMLButtonElement;
  const prev = btn.textContent;
  btn.textContent = 'Analyzing…';
  try {
    const json = await invoke<string>('analyze_recording', { fileId: s.file_id });
    const report = JSON.parse(json) as QualityReport;
    s.quality_report = report;
    if (report.total !== null && report.total !== undefined) s.quality = report.total;
    renderLibrary();
    inspectSession(s);
  } catch (e) {
    document.getElementById('inspectorDetails')!.innerHTML =
      `<div style="color:var(--red);font-size:11px">Analysis failed: ${e}</div>`;
  } finally {
    btn.textContent = prev;
  }
});

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
      return {
        id: `s-${r.file_id}`,
        time: new Date(r.timestamp * 1000).toLocaleString(),
        substance: r.substance === 'unknown' ? 'Unknown' : r.substance,
        label: r.label,
        format: 'CSV',
        duration: `${Math.round(r.duration_sec)}s`,
        sensors: r.sensor_count,
        quality: r.quality,
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

document.getElementById('libImport')!.addEventListener('click', reloadLibrary);
document.getElementById('libImportFolder')!.addEventListener('click', reloadLibrary);

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
    await invoke('export_labeled_data', { outputDir: dir });
    const csvPath = `${dir}/session_unknown.csv`;
    const metaPath = `${dir}/session_unknown.json`;
    const info = await invoke<{
      id: string; substance: string; quality_score: number; status: string;
      n_samples: number; n_channels: number;
    }>('commons_submit', { csvPath, metaPath, dataDir: dir });
    await flashStatus('libStatus', `Submitted to Data Commons — id ${info.id} · ${info.substance} · q ${info.quality_score.toFixed(0)} · ${info.status}`, 'var(--green)');
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
document.getElementById('fleetScan')!.addEventListener('click', async () => {
  try {
    fleetDevices = await invoke<FleetDevice[]>('fleet_scan');
    renderFleet();
  } catch { renderFleet(); }
});
document.getElementById('fleetAdd')!.addEventListener('click', () => {
  fleetDevices.push({
    id: `dev-${Date.now()}`, name: `Device ${fleetDevices.length + 1}`,
    status: 'offline',
    sensors: chNames.map(s => ({ name: s, value: 0, health: 'OK' })),
    firmware: 'v0.1.0', uptime_seconds: 0, ip: '192.168.1.' + (100 + fleetDevices.length),
  });
  renderFleet();
});

// OLED
document.getElementById('oledLayout')!.addEventListener('change', updateOledPreview);
document.getElementById('oledRotation')!.addEventListener('change', updateOledPreview);
document.getElementById('oledCycle')!.addEventListener('change', updateOledPreview);
document.getElementById('oledScreen')!.addEventListener('change', updateOledPreview);

// Buzzer
['buzzerWarn', 'buzzerCrit', 'buzzerEmerg'].forEach(id => {
  document.getElementById(id)!.addEventListener('change', updateBuzzerPreviews);
});
document.getElementById('buzzerVolume')!.addEventListener('input', (e) => {
  document.getElementById('buzVolVal')!.textContent = `${(e.target as HTMLInputElement).value}%`;
});

// Preset
document.getElementById('sysPreset')!.addEventListener('change', (e) => {
  onPresetChange((e.target as HTMLSelectElement).value);
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
const PHASE_COLORS: Record<string, string> = { baseline: '#4a9eff', exposure: '#ef4444', recovery: '#34d399' };

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
  document.getElementById('recordBtn')!.textContent = '● Record';
  closeRecordModal();
}

async function pollPhaseRecorder() {
  try {
    const s = await invoke<PhaseRecorderState>('get_phase_recorder_state');
    renderPhaseState(s);
    document.getElementById('recordBtn')!.textContent = s.active ? '■ Stop' : '● Record';
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

// Record button
document.getElementById('recordBtn')!.addEventListener('click', async () => {
  if (recPhaseActive || prevPhaseActive) {
    stopPhaseRecordingFromUI();
  } else {
    openRecordModal();
  }
});

document.getElementById('recModalClose')!.addEventListener('click', closeRecordModal);

document.getElementById('recStart')!.addEventListener('click', async () => {
  const substance = (document.getElementById('recSubstance') as HTMLInputElement).value.trim();
  if (!substance) {
    (document.getElementById('recSubstance') as HTMLInputElement).focus();
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
    });
    recPhaseActive = true;
    prevPhaseActive = true;
    autoFinalized = false;
    sessionStart = Date.now() / 1000;
    document.getElementById('recordBtn')!.textContent = '■ Stop';
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
}

async function refreshBurnIn() {
  try {
    const s = await invoke<BurnInStatus>('burnin_get_status');
    renderBurnIn(s);
  } catch {}
}

document.getElementById('burninStart')!.addEventListener('click', async () => {
  try {
    const s = await invoke<BurnInStatus>('burnin_start');
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
        const state = p.loaded ? '<span style="color:#3fbf5f">&#9679;</span> loaded' : `<span style="color:#d64">&#9679;</span> ${p.error || 'stub'}`;
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
  document.getElementById('flashProgress')!.style.display = '';
  document.getElementById('flashStatus')!.textContent = 'Flashing...';
  document.getElementById('flashBar')!.style.width = '30%';
  try {
    await invoke('flash_firmware', { port, preset: activePreset, wifiSsid, wifiPassword });
    document.getElementById('flashBar')!.style.width = '100%';
    document.getElementById('flashStatus')!.textContent = 'Complete — mDNS: osmograph.local (service _osmograph._tcp)';
  } catch (e) {
    document.getElementById('flashBar')!.style.width = '0%';
    document.getElementById('flashStatus')!.textContent = `Failed: ${e}`;
  }
});

async function refreshToolchain() {
  try {
    const tc = await invoke<{ platformio: boolean; arduino_cli: boolean; esptool: boolean; message: string }>('check_flash_toolchain');
    document.getElementById('fwToolchain')!.textContent = tc.message;
  } catch {
    document.getElementById('fwToolchain')!.textContent = 'toolchain check failed';
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

// === Tauri Serial Data Event ===
listen<{ channels: number[]; timestamp: number; raw_line: string }>('serial-data', (event) => {
  const { channels } = event.payload;
  if (channels.length > 0) ingestReading(channels);
});

listen<{ device_id: string; firmware_version: string; n_sensors: number }>('serial-info', (event) => {
  const { device_id, firmware_version, n_sensors } = event.payload;
  console.log(`Device: ${device_id} v${firmware_version} (${n_sensors} sensors)`);
});

listen<{ code: number; message: string }>('serial-error', (event) => {
  console.error(`Serial error ${event.payload.code}: ${event.payload.message}`);
});

listen('serial-disconnected', () => {
  connected = false;
  document.getElementById('connectBtn')!.textContent = 'Connect';
  document.getElementById('statusDot')!.className = 'status-dot';
});

// === BLE Events ===
listen<string>('ble-connected', (event) => {
  document.getElementById('fDevice')!.textContent = event.payload;
});

listen('ble-disconnected', () => {
  connected = false;
  document.getElementById('connectBtn')!.textContent = 'Connect';
  document.getElementById('statusDot')!.className = 'status-dot';
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
  const fid = sel.value;
  if (!fid) return;
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
  ctx.fillStyle = '#fafafa';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = '#ececef';
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
    ctx.strokeStyle = CH_COLORS[ch % CH_COLORS.length];
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

function toggleReplay() {
  if (replayPlaying) { pauseReplay(); return; }
  if (!replaySeries) { loadReplay(); }
  replayPlaying = true;
  replayLastTs = replaySeries ? null : null;
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

document.getElementById('replayLoad')!.addEventListener('click', loadReplay);
document.getElementById('replayPlay')!.addEventListener('click', toggleReplay);
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

// === Animation Loop ===
function animate() {
  drawTraces();
  updateSessionTime();
  requestAnimationFrame(animate);
}

// === Periodic Updates ===
setInterval(updateSensorHealth, 2000);
setInterval(updateLabelUI, 5000);
setInterval(generateDemoData, 100);
setInterval(updateOledPreview, 1000);
setInterval(pollPhaseRecorder, 500);
setInterval(reloadClassifiers, 4000);
setInterval(refreshBurnIn, 1000);

// === Init ===
refreshPorts();
animate();
onPresetChange('6-sensor-full');
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
updateDemoBadge();
