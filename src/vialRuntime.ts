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
import type { VialCapabilities } from './vials/host';

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
  /** Seconds of the early series used as R0 when baseline is `first-n`.
   *  A v2 manifest declares this; legacy UI calls use the 15-sample default. */
  r0WindowS?: number;
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
    const r0Samples = t.r0WindowS && t.r0WindowS > 0 && window.time.length
      ? Math.max(1, window.time.filter(tv => tv - window.time[0] <= t.r0WindowS!).length)
      : 15;
    const head = t.baseline === 'session-mean' ? finite : finite.slice(0, r0Samples);
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
  | { type: 'set-trajectory'; fields: string[]; intervalMs: number }
  | {
      type: 'host-request';
      requestId: string;
      request: 'persist' | 'retrieve' | 'action';
      key?: string;
      value?: unknown;
      action?: string;
      params?: unknown;
    }
  | { type: 'journal-log'; event: { id: string; type: string; message: string; data?: unknown; timestamp: number } }
  | { type: 'journal-clear' };

export interface VialActionEnvelope {
  vialAction: VialAction;
  nonce: string;
}

const ACTION_TYPES = new Set<VialAction['type']>([
  'ready', 'toast', 'resize', 'save-field', 'add-log', 'remove-log', 'export-log',
  'open-dashboard', 'open-datasets', 'open-check', 'open-vials', 'open-workspace', 'set-source',
  'set-detection', 'set-transforms', 'set-trajectory', 'host-request', 'journal-log', 'journal-clear',
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
  // The bridge stamps a schema version. Absent is accepted for vials mounted
  // before this field existed; a different version is refused rather than
  // interpreted with the wrong rules.
  if (value.schema !== undefined && value.schema !== 'osmograph.vial-action/1') return null;
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
  if (type === 'host-request') {
    const requestId = typeof raw.requestId === 'string' ? raw.requestId : '';
    const request = typeof raw.request === 'string' ? raw.request : '';
    if (!/^[a-z0-9_-]{1,64}$/i.test(requestId)) return null;
    if (request === 'persist') {
      const key = typeof raw.key === 'string' ? raw.key.trim() : '';
      if (!safeActionKey(key)) return null;
      let serialized = '';
      try { serialized = JSON.stringify(raw.value ?? null); } catch { return null; }
      if (serialized.length > 16_384) return null;
      return { nonce, vialAction: { type, requestId, request, key, value: raw.value ?? null } };
    }
    if (request === 'retrieve') {
      const key = typeof raw.key === 'string' ? raw.key.trim() : '';
      if (!safeActionKey(key)) return null;
      return { nonce, vialAction: { type, requestId, request, key } };
    }
    if (request === 'action') {
      const action = typeof raw.action === 'string' ? raw.action.trim() : '';
      if (!safeActionKey(action)) return null;
      if (raw.params !== undefined && !isRecord(raw.params) && !Array.isArray(raw.params)) return null;
      let serialized = '';
      try { serialized = JSON.stringify(raw.params ?? null); } catch { return null; }
      if (serialized.length > 8_192) return null;
      return { nonce, vialAction: { type, requestId, request, action, params: raw.params ?? null } };
    }
    return null;
  }
  if (type === 'journal-log') {
    if (!isRecord(raw.event)) return null;
    const event = raw.event;
    const id = typeof event.id === 'string' ? event.id.slice(0, 80) : '';
    const kind = typeof event.type === 'string' ? event.type.slice(0, 40) : '';
    const message = typeof event.message === 'string' ? event.message.slice(0, 400) : '';
    const timestamp = typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
      ? event.timestamp
      : Date.now();
    if (!/^[a-z0-9_-]{1,80}$/i.test(id) || !kind) return null;
    let serialized = '';
    try { serialized = JSON.stringify(event.data ?? null); } catch { return null; }
    if (serialized.length > 8_192) return null;
    return { nonce, vialAction: { type, event: { id, type: kind, message, data: event.data ?? null, timestamp } } };
  }
  if (type === 'journal-clear') {
    return { nonce, vialAction: { type } };
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
  if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/i.test(html)) {
    throw new Error('A Vial UI cannot use the network; the sandbox has no network access.');
  }
  if (/\b(?:localStorage|sessionStorage|indexedDB)\b/i.test(html)) {
    throw new Error('A Vial UI cannot use browser storage; the sandbox has no storage access.');
  }
  if (/\beval\s*\(|new\s+Function\s*\(/i.test(html)) {
    throw new Error('A Vial UI cannot evaluate strings as code.');
  }
  const allowed = new Set([
    'version', 'onData', 'action', 'ready', 'toast',
  ]);
  for (const match of html.matchAll(/osmograph\.([A-Za-z_$][\w$]*)/g)) {
    if (!allowed.has(match[1])) {
      throw new Error(`A Vial UI calls an unknown osmograph method: ${match[1]}.`);
    }
  }
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
[hidden] { display: none !important; }
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

/** Capabilities are declared by the manifest. A legacy pack that declares
 *  neither `permissions` nor `capabilities` keeps the historical full surface;
 *  a pack that declares a list grants only what it names. */
export function resolveVialCapabilities(pack: {
  capabilities?: string[];
  permissions?: Partial<VialCapabilities>;
}): VialCapabilities {
  const all: VialCapabilities = {
    readLive: true,
    readBaseline: true,
    logEvents: true,
    persist: true,
    requestAction: true,
    exportData: true,
  };
  const explicit = pack.permissions;
  if (explicit && Object.keys(explicit).length) {
    return {
      readLive: explicit.readLive !== false,
      readBaseline: explicit.readBaseline !== false,
      logEvents: explicit.logEvents !== false,
      persist: explicit.persist !== false,
      requestAction: explicit.requestAction !== false,
      exportData: explicit.exportData !== false,
    };
  }
  const declared = Array.isArray(pack.capabilities) ? pack.capabilities : [];
  if (!declared.length) return all;
  const set = new Set(declared);
  return {
    readLive: set.has('read:live'),
    readBaseline: set.has('read:baseline'),
    logEvents: set.has('log:events'),
    persist: set.has('write:persist'),
    requestAction: set.has('action:request'),
    exportData: set.has('export:data'),
  };
}

function bridgeScript(nonce: string, capabilities: VialCapabilities): string {
  const safeNonce = JSON.stringify(nonce);
  const safeCaps = JSON.stringify(capabilities);
  return `<script>(function(){
  "use strict";
  var NONCE = ${safeNonce};
  var CAPS = ${safeCaps};
  var last = null;
  var handlers = new Set();
  var hostHandlers = { tick: [], data: [], connect: [], disconnect: [], event: [] };
  var hostState = { channels: [], latest: null, baseline: null, readings: [], snapshot: null, series: null, source: null, connected: false };
  var journal = [];
  var pending = {};
  var requestSeq = 0;

  function send(action) {
    try {
      parent.postMessage({ schema: "osmograph.vial-action/1", vialAction: action, nonce: NONCE }, "*");
    } catch (e) {}
  }
  var deniedCaps = {};
  function assertCap(name, label) {
    if (CAPS[name]) return;
    if (!deniedCaps[label]) {
      deniedCaps[label] = true;
      send({ type: "toast", message: "Vial permission denied: it did not declare " + label + " in vial.json." });
    }
    throw new Error("Vial does not declare the " + label + " capability.");
  }
  function hostRequest(request, body) {
    var id = String(++requestSeq) + "_" + Math.random().toString(36).slice(2, 8);
    return new Promise(function(resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      send(Object.assign({ type: "host-request", requestId: id, request: request }, body || {}));
      setTimeout(function() {
        if (pending[id]) { delete pending[id]; reject(new Error("Host request timed out.")); }
      }, 5000);
    });
  }
  function emit(name, value) {
    (hostHandlers[name] || []).slice().forEach(function(fn) {
      try { fn(value); } catch (e) { console.error("Vial host listener error:", e); }
    });
  }
  function hostOn(name, fn) {
    if (typeof fn !== "function") return function() {};
    if (!hostHandlers[name]) hostHandlers[name] = [];
    hostHandlers[name].push(fn);
    if (name === "tick" && hostState.latest) {
      try { fn(hostState.latest); } catch (e) { console.error(e); }
    }
    return function() { hostOff(name, fn); };
  }
  function hostOff(name, fn) {
    var list = hostHandlers[name];
    if (!list) return;
    hostHandlers[name] = list.filter(function(item) { return item !== fn; });
  }
  function movingAverage(values, window) {
    if (!Array.isArray(values) || !(window > 0)) return Array.isArray(values) ? values.slice() : [];
    var out = [];
    for (var i = 0; i < values.length; i++) {
      var start = Math.max(0, i - Math.floor(window / 2));
      var end = Math.min(values.length, i + Math.ceil(window / 2));
      var slice = values.slice(start, end);
      var sum = 0;
      var n = 0;
      for (var j = 0; j < slice.length; j++) {
        if (Number.isFinite(slice[j])) { sum += slice[j]; n++; }
      }
      out.push(n ? sum / n : null);
    }
    return out;
  }
  function derivative(values, window) {
    var w = Math.max(1, Math.round(window || 1));
    var out = [];
    if (!Array.isArray(values) || values.length < 2) return out;
    for (var i = w; i < values.length; i++) {
      var a = values[i];
      var b = values[i - w];
      out.push(Number.isFinite(a) && Number.isFinite(b) ? (a - b) / w : null);
    }
    return out;
  }
  function rateOfChange(readings, channelIndex, windowMs) {
    if (!Array.isArray(readings) || readings.length < 2) return 0;
    var span = windowMs || 10000;
    var now = readings[readings.length - 1].timestamp;
    var recent = readings.filter(function(r) { return now - r.timestamp <= span; });
    if (recent.length < 2) return 0;
    var first = recent[0].channels[channelIndex];
    var last = recent[recent.length - 1].channels[channelIndex];
    var dt = (recent[recent.length - 1].timestamp - recent[0].timestamp) / 1000;
    if (!Number.isFinite(first) || !Number.isFinite(last) || dt <= 0) return 0;
    return (last - first) / dt;
  }
  function journalCsv(events) {
    function cell(value) { return '"' + String(value == null ? "" : value).replace(/"/g, '""') + '"'; }
    var rows = ["id,type,message,timestamp,data"];
    events.forEach(function(e) {
      rows.push([cell(e.id), cell(e.type), cell(e.message), cell(e.timestamp), cell(JSON.stringify(e.data == null ? null : e.data))].join(","));
    });
    return rows.join("\\n");
  }
  function ingest(payload) {
    var snapshot = payload.snapshot || null;
    var series = payload.series || null;
    hostState.snapshot = snapshot;
    hostState.series = series;
    hostState.channels = ((snapshot && snapshot.channels) || []).map(function(c, i) {
      return { index: i, name: c.label || c.id || ("CH" + (i + 1)), id: c.id, kind: c.kind, unit: c.unit };
    });
    if (!hostState.channels.length && series && series.channels) {
      hostState.channels = series.channels.map(function(name, i) {
        return { index: i, name: name, id: name, kind: "", unit: "" };
      });
    }
    var channels = [];
    if (series && Array.isArray(series.values)) {
      channels = series.values.map(function(channel) {
        for (var i = channel.length - 1; i >= 0; i--) {
          if (channel[i] !== null && Number.isFinite(channel[i])) return channel[i];
        }
        return null;
      });
    }
    var environment = snapshot && snapshot.environment
      ? { temperature: snapshot.environment.temperature, humidity: snapshot.environment.humidity }
      : undefined;
    var reading = {
      timestamp: Date.now(),
      channels: channels,
      channelsMeta: hostState.channels,
      env: environment
    };
    hostState.latest = reading;
    hostState.readings.push(reading);
    if (hostState.readings.length > 2000) hostState.readings.splice(0, hostState.readings.length - 2000);
    var baseline = snapshot && snapshot.baseline;
    hostState.baseline = baseline
      ? { channels: [], timestamp: Date.now(), state: baseline.state, progress: baseline.progress, ageSec: baseline.ageSec }
      : null;
    hostState.source = series ? series.source : null;

    window.__OSMOGRAPH_HOST_STATE__ = {
      readings: channels,
      channels: hostState.channels,
      env: environment,
      baseline: []
    };
    window.__OSMOGRAPH_READINGS_BUFFER__ = hostState.readings;
    if (reading.channels.some(function(value) { return value !== null; })) {
      if (!hostState.connected) { hostState.connected = true; emit("connect", reading); }
      emit("tick", reading);
      emit("data", reading);
    } else if (hostState.connected) {
      hostState.connected = false;
      emit("disconnect", reading);
    }
  }

  window.osmograph = {
    version: "sandbox/1",
    host: function() { return window.__OSMOGRAPH_VIAL_HOST__; },
    onData: function(fn) {
      if (typeof fn !== "function") return function(){};
      handlers.add(fn);
      if (last) { try { fn(last); } catch (e) { console.error(e); } }
      return function(){ handlers.delete(fn); };
    },
    action: send,
    ready: function(){ send({ type: "ready" }); },
    toast: function(message){ send({ type: "toast", message: String(message || "") }); },
    setDetection: function(){
      throw new Error("A v2 Vial cannot set detection from its UI; the anomaly profile in vial.json is the program.");
    },
    setTransforms: function(){
      throw new Error("A v2 Vial cannot set transforms from its UI; the anomaly profile in vial.json is the program.");
    },
    setTrajectory: function(){
      throw new Error("A v2 Vial cannot set trajectory from its UI; the trajectory spec is set by the host.");
    }
  };

  var host = {
    version: "1.0.0",
    capabilities: CAPS,
    getLiveReadings: function() {
      assertCap("readLive", "read:live");
      return hostState.latest;
    },
    getChannels: function() {
      assertCap("readLive", "read:live");
      return hostState.channels.slice();
    },
    getBaseline: function() {
      assertCap("readBaseline", "read:baseline");
      return hostState.baseline;
    },
    getRecentReadings: function(count) {
      assertCap("readLive", "read:live");
      var n = Math.max(1, Math.min(2000, Math.round(count || 100)));
      return hostState.readings.slice(-n);
    },
    getSnapshot: function() {
      assertCap("readLive", "read:live");
      return hostState.snapshot;
    },
    getSeries: function() {
      assertCap("readLive", "read:live");
      return hostState.series;
    },
    on: hostOn,
    off: hostOff,
    logEvent: function(type, message, data) {
      assertCap("logEvents", "log:events");
      var event = {
        id: Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
        type: String(type || "note").slice(0, 40),
        message: String(message || "").slice(0, 400),
        data: data === undefined ? null : data,
        timestamp: Date.now()
      };
      journal.push(event);
      if (journal.length > 2000) journal.splice(0, journal.length - 2000);
      send({ type: "journal-log", event: event });
      emit("event", event);
      return Promise.resolve(event);
    },
    getEvents: function(limit) {
      assertCap("logEvents", "log:events");
      var n = Math.max(1, Math.min(2000, Math.round(limit || 100)));
      if (!journal.length && CAPS.requestAction) {
        return hostRequest("action", { action: "journal-events", params: null }).then(function(events) {
          if (Array.isArray(events)) journal = events.slice(-2000);
          return journal.slice(-n);
        }).catch(function() { return journal.slice(-n); });
      }
      return Promise.resolve(journal.slice(-n));
    },
    clearEvents: function() {
      assertCap("logEvents", "log:events");
      journal = [];
      send({ type: "journal-clear" });
      return Promise.resolve();
    },
    persist: function(key, value) {
      assertCap("persist", "write:persist");
      return hostRequest("persist", { key: String(key || ""), value: value });
    },
    retrieve: function(key) {
      assertCap("persist", "write:persist");
      return hostRequest("retrieve", { key: String(key || "") });
    },
    requestAction: function(action, params) {
      assertCap("requestAction", "action:request");
      return hostRequest("action", { action: String(action || ""), params: params === undefined ? null : params });
    },
    computeMovingAverage: movingAverage,
    computeDerivative: derivative,
    computeRateOfChange: rateOfChange,
    exportJournal: function(format) {
      assertCap("exportData", "export:data");
      var wantsCsv = String(format || "json") === "csv";
      var ready = (!journal.length && CAPS.requestAction)
        ? hostRequest("action", { action: "journal-events", params: null }).then(function(events) {
            if (Array.isArray(events)) journal = events.slice(-2000);
          }).catch(function() {})
        : Promise.resolve();
      return ready.then(function() {
        return wantsCsv ? journalCsv(journal) : JSON.stringify(journal, null, 2);
      });
    }
  };
  window.__OSMOGRAPH_VIAL_HOST__ = host;

  window.addEventListener("message", function(event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.vialHostResponse === true && data.requestId && pending[data.requestId]) {
      var waiting = pending[data.requestId];
      delete pending[data.requestId];
      if (data.ok) waiting.resolve(data.result);
      else waiting.reject(new Error(String(data.error || "Host request failed.")));
      return;
    }
    if (data.vialData !== true || !data.payload) return;
    last = data.payload;
    ingest(last);
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
export function buildSandboxDocument(
  uiHtml: string,
  nonce: string,
  capabilities: VialCapabilities = resolveVialCapabilities({}),
): string {
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
${bridgeScript(nonce, capabilities)}
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
