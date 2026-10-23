// The Vial runtime bridge.
//
// A Vial that needs a real frontend ships a UI fragment (HTML/CSS/JS) beside
// its manifest. The host never injects that fragment into its own document.
// It runs inside an iframe with `sandbox="allow-scripts"` and a CSP that blocks
// network, storage, forms, frames, and external assets. The Vial receives a
// typed data payload over postMessage and can only ask the host for a small,
// explicit set of actions.
//
// This is deliberately not a general-purpose plugin API. The host owns data,
// provenance, baselines, the classifier, and every safety refusal. The Vial
// owns the domain screen and the domain reasoning that helps a person use the
// data honestly.

import type { VialHostSnapshot } from './vialHost';

export const VIAL_RUNTIME_SCHEMA = 'osmograph.vial-runtime/1' as const;
export const VIAL_UI_MAX_BYTES = 512_000;

export type VialSourceKind = 'live' | 'recording';

export interface VialSourceOption {
  id: string;
  label: string;
  kind: VialSourceKind;
  detail?: string;
}

/** A downsampled, JSON-safe window. Nulls are used where a channel had no
 *  finite value at that sample; the UI must not turn those into zeroes. */
export interface VialSeriesWindow {
  source: VialSourceKind | 'none';
  label: string;
  channels: string[];
  time: number[];
  timeUnit: 's' | 'sample';
  values: Array<Array<number | null>>;
  fingerprint: Array<number | null>;
  evolution: {
    bins: number;
    values: Array<Array<number | null>>;
    maxAbs: number;
  } | null;
  /** Baseline-relative response computed with the Vial's declared transforms.
   *  Null until the Vial declares transforms and the host accepts them. */
  response: {
    baseline: VialBaseline;
    response: VialResponse;
    conditioning: string[];
    values: Array<Array<number | null>>;
  } | null;
}

export type VialBaseline = 'first-n' | 'session-mean';
export type VialResponse = 'delta-over-r0' | 'relative' | 'delta';

export const VIAL_BASELINES: VialBaseline[] = ['first-n', 'session-mean'];
export const VIAL_RESPONSES: VialResponse[] = ['delta-over-r0', 'relative', 'delta'];
export const VIAL_CONDITIONING = ['median3'] as const;

export interface VialTransforms {
  baseline: VialBaseline;
  conditioning: string[];
  response: VialResponse;
}

function median3(values: Array<number | null>): Array<number | null> {
  const out = values.slice();
  for (let i = 1; i < values.length - 1; i += 1) {
    const triple = [values[i - 1], values[i], values[i + 1]].filter(
      (v): v is number => v !== null && Number.isFinite(v),
    );
    if (triple.length < 2) continue;
    triple.sort((a, b) => a - b);
    out[i] = triple[Math.floor(triple.length / 2)];
  }
  return out;
}

/** Apply the Vial's declared baseline/conditioning/response to a window.
 *  The host computes this; a Vial never transforms its own raw data. */
export function applyVialTransforms(window: VialSeriesWindow, t: VialTransforms): VialSeriesWindow {
  const conditioning = t.conditioning.filter(c => c === 'median3');
  const values = window.values.map(channel => {
    const conditioned = conditioning.includes('median3') ? median3(channel) : channel;
    const finite = conditioned.filter((v): v is number => v !== null && Number.isFinite(v));
    const head = t.baseline === 'session-mean' ? finite : finite.slice(0, 15);
    const r0 = head.length ? head.reduce((a, b) => a + b, 0) / head.length : null;
    return conditioned.map(v => {
      if (v === null || !Number.isFinite(v)) return null;
      if (t.response === 'relative') return r0 ? v / r0 : null;
      if (t.response === 'delta') return r0 === null ? null : v - r0;
      if (r0 === null || r0 === 0) return null;
      return (v - r0) / r0;
    });
  });
  return { ...window, response: { baseline: t.baseline, conditioning, response: t.response, values } };
}

export interface VialEvent {
  start: number;
  end: number;
  alert: string;
  peak: number;
  channels: string[];
  ongoing: boolean;
}

export interface VialDomainState {
  fields: Record<string, string>;
  checks: Record<string, boolean>;
  logs: Array<{ id: string; at: number; values: Record<string, string> }>;
}

export interface VialDataPayload {
  schema: typeof VIAL_RUNTIME_SCHEMA;
  snapshot: VialHostSnapshot;
  series: VialSeriesWindow | null;
  sources: VialSourceOption[];
  selectedSource: string;
  events: VialEvent[];
  domain: VialDomainState;
  /** Which surface mounted this document: the full workspace or the compact Home view. */
  view: 'workspace' | 'home';
  host: {
    name: string;
    version: string;
    runtime: 'sandbox/1';
  };
}

export type VialAction =
  | { type: 'ready' }
  | { type: 'toast'; message: string }
  | { type: 'resize'; height: number }
  | { type: 'save-field'; key: string; value: string }
  | { type: 'add-log'; values: Record<string, string> }
  | { type: 'remove-log'; id: string }
  | { type: 'export-log' }
  | { type: 'open-dashboard' }
  | { type: 'open-datasets' }
  | { type: 'open-check' }
  | { type: 'open-vials' }
  | { type: 'open-workspace' }
  | { type: 'set-source'; source: string }
  | {
      type: 'set-detection';
      enabled: boolean;
      alertThreshold: number;
      perChannelLimits: Record<string, number>;
    }
  | { type: 'set-transforms'; baseline: string; conditioning: string[]; response: string }
  | { type: 'set-trajectory'; fields: string[]; intervalMs: number };

export interface VialActionEnvelope {
  vialAction: VialAction;
  nonce: string;
}

const ACTION_TYPES = new Set<VialAction['type']>([
  'ready', 'toast', 'resize', 'save-field', 'add-log', 'remove-log', 'export-log',
  'open-dashboard', 'open-datasets', 'open-check', 'open-vials', 'open-workspace', 'set-source',
  'set-detection', 'set-transforms', 'set-trajectory',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function safeActionKey(key: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,47}$/i.test(key)
    && !['__proto__', 'prototype', 'constructor'].includes(key.toLowerCase());
}

export function parseVialActionEnvelope(value: unknown): VialActionEnvelope | null {
  if (!isRecord(value) || !isRecord(value.vialAction)) return null;
  const nonce = typeof value.nonce === 'string' ? value.nonce : '';
  const raw = value.vialAction;
  const type = typeof raw.type === 'string' ? raw.type : '';
  if (!nonce || !ACTION_TYPES.has(type as VialAction['type'])) return null;

  if (type === 'toast') {
    return { nonce, vialAction: { type, message: String(raw.message ?? '').slice(0, 400) } };
  }
  if (type === 'resize') {
    return { nonce, vialAction: { type, height: clampInt(raw.height, 420, 2000, 720) } };
  }
  if (type === 'save-field') {
    const key = typeof raw.key === 'string' ? raw.key.trim().slice(0, 48) : '';
    const value = typeof raw.value === 'string' ? raw.value.slice(0, 400) : '';
    if (!safeActionKey(key)) return null;
    return { nonce, vialAction: { type, key, value } };
  }
  if (type === 'add-log') {
    if (!isRecord(raw.values)) return null;
    const values: Record<string, string> = {};
    for (const [key, val] of Object.entries(raw.values)) {
      if (!safeActionKey(key)) continue;
      if (typeof val !== 'string' && typeof val !== 'number') continue;
      values[key] = String(val).slice(0, 400);
      if (Object.keys(values).length >= 24) break;
    }
    return { nonce, vialAction: { type, values } };
  }
  if (type === 'remove-log') {
    const id = typeof raw.id === 'string' ? raw.id.slice(0, 80) : '';
    if (!/^[a-z0-9_-]{1,80}$/i.test(id)) return null;
    return { nonce, vialAction: { type, id } };
  }
  if (type === 'set-source') {
    const source = typeof raw.source === 'string' ? raw.source.slice(0, 120) : '';
    return { nonce, vialAction: { type, source } };
  }
  if (type === 'set-detection') {
    if (!isRecord(raw.perChannelLimits)) return null;
    const perChannelLimits: Record<string, number> = {};
    for (const [key, val] of Object.entries(raw.perChannelLimits)) {
      if (!safeActionKey(key)) continue;
      const n = typeof val === 'number' ? val : Number(val);
      if (!Number.isFinite(n) || n < 0) continue;
      perChannelLimits[key] = Math.min(1e9, n);
      if (Object.keys(perChannelLimits).length >= 16) break;
    }
    const threshold = typeof raw.alertThreshold === 'number' ? raw.alertThreshold : Number(raw.alertThreshold);
    return {
      nonce,
      vialAction: {
        type,
        enabled: raw.enabled !== false,
        alertThreshold: Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : 0.5,
        perChannelLimits,
      },
    };
  }
  if (type === 'set-transforms') {
    const baseline = typeof raw.baseline === 'string' ? raw.baseline.slice(0, 40) : '';
    const response = typeof raw.response === 'string' ? raw.response.slice(0, 40) : '';
    const conditioning: string[] = [];
    if (Array.isArray(raw.conditioning)) {
      for (const item of raw.conditioning) {
        if (typeof item !== 'string') continue;
        conditioning.push(item.slice(0, 40));
        if (conditioning.length >= 8) break;
      }
    }
    if (!baseline || !response) return null;
    return { nonce, vialAction: { type, baseline, conditioning, response } };
  }
  if (type === 'set-trajectory') {
    const fields: string[] = [];
    if (Array.isArray(raw.fields)) {
      for (const item of raw.fields) {
        if (typeof item !== 'string') continue;
        if (!/^[a-z0-9_.-]{1,40}$/i.test(item) || item.includes('..')) continue;
        fields.push(item);
        if (fields.length >= 8) break;
      }
    }
    const intervalMs = clampInt(raw.intervalMs, 1000, 600000, 10000);
    return { nonce, vialAction: { type, fields, intervalMs } };
  }
  return { nonce, vialAction: { type } as VialAction };
}

/** Turn a possibly ragged channel array into a bounded, JSON-safe window. */
export function downsampleChannels(
  values: number[][],
  maxPoints = 600,
): { values: Array<Array<number | null>>; indices: number[] } {
  const n = values.reduce((max, channel) => Math.max(max, channel.length), 0);
  if (!n) return { values: values.map(() => []), indices: [] };
  const max = Math.max(8, Math.min(4000, Math.round(maxPoints)));
  const step = Math.max(1, Math.ceil(n / max));
  const indices: number[] = [];
  for (let i = 0; i < n; i += step) indices.push(i);
  if (indices[indices.length - 1] !== n - 1) indices.push(n - 1);
  return {
    indices,
    values: values.map(channel => indices.map(i => {
      const v = channel[i];
      return Number.isFinite(v) ? Number(v) : null;
    })),
  };
}

function finiteMean(values: Array<number | null>): number {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : NaN;
}

/** Baseline-relative settled fingerprint: early window as R0, late window as
 *  the settled response. This is descriptive; it is not a classifier. */
export function fingerprintFromSeries(values: Array<Array<number | null>>): Array<number | null> {
  return values.map(channel => {
    const finite = channel.filter((v): v is number => v !== null && Number.isFinite(v));
    if (finite.length < 6) return null;
    const baselineN = Math.max(3, Math.floor(finite.length * 0.15));
    const r0 = finite.slice(0, baselineN).reduce((a, b) => a + b, 0) / baselineN;
    if (!(r0 > 0)) return null;
    const settled = finite.slice(Math.floor(finite.length * 0.6));
    const mean = settled.reduce((a, b) => a + b, 0) / Math.max(1, settled.length);
    const out = (mean - r0) / r0;
    return Number.isFinite(out) ? out : null;
  });
}

/** Signed response in equal time bins. Rows are channels, columns are time. */
export function evolutionFromSeries(
  values: Array<Array<number | null>>,
  bins = 64,
): { bins: number; values: Array<Array<number | null>>; maxAbs: number } {
  const width = Math.max(12, Math.min(96, Math.round(bins)));
  let maxAbs = 1e-9;
  const rows = values.map(channel => {
    const n = channel.length;
    const finite = channel.filter((v): v is number => v !== null && Number.isFinite(v));
    if (!n || finite.length < 6) return Array.from({ length: width }, () => null);
    const baselineN = Math.max(3, Math.floor(finite.length * 0.15));
    const r0 = finite.slice(0, baselineN).reduce((a, b) => a + b, 0) / baselineN;
    if (!(r0 > 0)) return Array.from({ length: width }, () => null);
    const row: Array<number | null> = [];
    for (let b = 0; b < width; b++) {
      const start = Math.floor((b / width) * n);
      const end = Math.max(start + 1, Math.floor(((b + 1) / width) * n));
      const mean = finiteMean(channel.slice(start, end));
      if (!Number.isFinite(mean)) { row.push(null); continue; }
      const v = (mean - r0) / r0;
      if (Number.isFinite(v)) {
        row.push(v);
        maxAbs = Math.max(maxAbs, Math.abs(v));
      } else {
        row.push(null);
      }
    }
    return row;
  });
  return { bins: width, values: rows, maxAbs };
}

/** Reject a fragment that can escape the sandbox's resource model. The CSP is
 *  the real enforcement; this catches the obvious mistakes before install. */
export function assertSandboxableUi(html: string): void {
  if (typeof html !== 'string' || !html.trim()) throw new Error('The Vial UI asset is empty.');
  if (html.length > VIAL_UI_MAX_BYTES) throw new Error('The Vial UI asset is larger than 512 KB.');
  if (/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]|<base[\s>]/i.test(html)) {
    throw new Error('A Vial UI must be a body fragment, not a full HTML document.');
  }
  if (/<(?:script|iframe|object|embed|link)[^>]+(?:src|href)\s*=/i.test(html)) {
    throw new Error('A Vial UI cannot load external scripts, frames, objects, or stylesheets.');
  }
  if (/<(?:img|source|video|audio)[^>]+src\s*=\s*["'](?!#|data:)/i.test(html)) {
    throw new Error('A Vial UI cannot load remote images or media.');
  }
  if (/javascript\s*:/i.test(html)) throw new Error('A Vial UI cannot use javascript: URLs.');
}

const SANDBOX_BASE_CSS = `
:root {
  --bg: #f6f1e7;
  --panel: #fffdf8;
  --panel-2: #f1eadc;
  --panel-3: #e9dfcf;
  --ink: #1d1a16;
  --muted: #6b6152;
  --muted-2: #8a7f6c;
  --line: #d8cdbb;
  --line-strong: #b9ab95;
  --cyan: #0e7490;
  --cyan-soft: #d9eef3;
  --amber: #b45309;
  --amber-soft: #f7e5cf;
  --green: #0d6b4f;
  --green-soft: #dcefe7;
  --red: #b91c1c;
  --red-soft: #f7dede;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0; background: var(--bg); color: var(--ink);
  font-family: var(--sans); font-size: 12px; line-height: 1.45;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
button, input, select, textarea { font: inherit; color: inherit; }
button {
  border: 1px solid var(--line-strong); background: var(--panel);
  padding: 6px 10px; border-radius: 3px; cursor: pointer;
  font-family: var(--mono); font-size: 9px; letter-spacing: .04em;
  text-transform: uppercase;
}
button:hover { border-color: var(--ink); background: var(--panel-2); }
button.primary { background: var(--ink); color: var(--bg); border-color: var(--ink); }
button.primary:hover { background: #3a342c; }
button:disabled { opacity: .45; cursor: not-allowed; }
input, select, textarea {
  border: 1px solid var(--line); background: var(--panel); border-radius: 3px;
  padding: 5px 7px; min-width: 0;
}
input:focus, select:focus, textarea:focus { outline: 2px solid var(--cyan-soft); border-color: var(--cyan); }
label { display: grid; gap: 3px; font-family: var(--mono); font-size: 8px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.panel {
  background: var(--panel); border: 1px solid var(--line); border-radius: 4px;
  padding: 11px 12px; min-width: 0;
}
.panel h2 {
  margin: 0; font-family: var(--mono); font-size: 9px; font-weight: 650;
  letter-spacing: .08em; text-transform: uppercase; color: var(--muted);
}
.panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 7px; }
.stamp { font-family: var(--mono); font-size: 8px; color: var(--muted-2); white-space: nowrap; }
.eyebrow { font-family: var(--mono); font-size: 8px; letter-spacing: .14em; text-transform: uppercase; color: var(--muted-2); }
h1 { margin: 4px 0 2px; font-size: 22px; line-height: 1.05; letter-spacing: -.02em; font-weight: 650; }
h3 { margin: 0; font-size: 11px; }
.hint { color: var(--muted); font-size: 10px; line-height: 1.5; }
.mono { font-family: var(--mono); }
.grid { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(280px, .85fr); gap: 10px; align-items: start; }
.col-main, .col-side { display: grid; gap: 10px; min-width: 0; }
.log-form { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.log-form .wide { grid-column: 1 / -1; }
.log-form button { grid-column: 1 / -1; }
@media (max-width: 860px) {
  .grid { grid-template-columns: minmax(0, 1fr); }
}
`;

function bridgeScript(nonce: string): string {
  const safeNonce = JSON.stringify(nonce);
  return `<script>(function(){
  "use strict";
  var NONCE = ${safeNonce};
  var last = null;
  var handlers = new Set();
  function send(action) {
    try { parent.postMessage({ vialAction: action, nonce: NONCE }, "*"); } catch (e) {}
  }
  window.osmograph = {
    version: "sandbox/1",
    onData: function(fn) {
      if (typeof fn !== "function") return function(){};
      handlers.add(fn);
      if (last) { try { fn(last); } catch (e) { console.error(e); } }
      return function(){ handlers.delete(fn); };
    },
    action: send,
    ready: function(){ send({ type: "ready" }); },
    toast: function(message){ send({ type: "toast", message: String(message || "") }); },
    setDetection: function(config){
      config = config || {};
      send({
        type: "set-detection",
        enabled: config.enabled !== false,
        alertThreshold: typeof config.alertThreshold === "number" ? config.alertThreshold : 0.5,
        perChannelLimits: config.perChannelLimits || {}
      });
    },
    setTransforms: function(t){
      t = t || {};
      send({
        type: "set-transforms",
        baseline: String(t.baseline || "first-n"),
        conditioning: Array.isArray(t.conditioning) ? t.conditioning : [],
        response: String(t.response || "delta-over-r0")
      });
    },
    setTrajectory: function(spec){
      spec = spec || {};
      send({
        type: "set-trajectory",
        fields: Array.isArray(spec.fields) ? spec.fields : [],
        intervalMs: typeof spec.intervalMs === "number" ? spec.intervalMs : 10000
      });
    }
  };
  window.addEventListener("message", function(event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.vialData !== true || !data.payload) return;
    last = data.payload;
    handlers.forEach(function(fn) {
      try { fn(last); } catch (e) { console.error(e); send({ type: "toast", message: "Vial UI error: " + (e && e.message ? e.message : "unknown") }); }
    });
  });
  window.addEventListener("error", function(event) {
    send({ type: "toast", message: "Vial UI error: " + (event.message || "unknown") });
  });
})();</script>`;
}

/** Build the only document the host ever puts into the sandbox. The CSP is
 *  intentionally narrow: no network, no storage, no forms, no frames. */
export function buildSandboxDocument(uiHtml: string, nonce: string): string {
  assertSandboxableUi(uiHtml);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'; connect-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none';">
<style>${SANDBOX_BASE_CSS}</style>
</head>
<body>
${bridgeScript(nonce)}
${uiHtml}
</body>
</html>`;
}

export function makeRuntimeNonce(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `vial_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}
