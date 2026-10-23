// Domain Vials — the part of the ecosystem that carries a way of working, not
// just a pairwise verdict. A Vial is an author-hosted project: a manifest with
// text, widgets, evidence, and a Home contribution, plus an optional HTML
// fragment beside it. The host never injects that fragment into its own
// document. It runs inside a sandboxed iframe with a typed postMessage bridge.
//
// There is no privileged tier. Every manifest goes through the same local gate,
// whether it was imported from a file or fetched from a personal GitHub repo.
// The sandbox is the execution boundary; it is not a signature or a review.

import type { VialHomeActionKind, VialHomeSpec } from './vialHost';

export interface DomainUiSpec {
  /** Only the host-owned sandbox bridge is supported today. */
  runtime: 'sandbox/1';
  /** Relative HTML fragment beside the manifest, for example ui.html. */
  entry: string;
  /** Initial frame height for this surface. The UI can request a different height. */
  height: number;
}

export type DomainRisk = 'low' | 'medium' | 'high' | 'critical';
export type DomainArt = 'fermentation' | 'plant' | 'generic';
export type DomainSeverity = 'info' | 'warn' | 'stop';

export interface DomainField {
  id: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select';
  unit?: string;
  placeholder?: string;
  options?: string[];
}

export interface DomainLog {
  id: string;
  at: number;
  values: Record<string, string>;
}

export type DomainWidget =
  | { type: 'hero'; art: DomainArt; title: string; subtitle: string; note: string }
  | { type: 'risk'; level: DomainRisk; headline: string; body: string; always: string[]; never: string[] }
  | { type: 'metrics'; title: string; items: Array<{ label: string; value: string; hint: string }> }
  | { type: 'diagram'; art: DomainArt; title: string; caption: string; hotspots: Array<{ id: string; label: string; x: number; y: number; body: string; severity: DomainSeverity }> }
  | { type: 'timeline'; title: string; steps: Array<{ label: string; range: string; body: string; warn?: string }> }
  | { type: 'tracking'; title: string; description: string; fields: DomainField[]; logFields: DomainField[]; logLabel: string }
  | { type: 'chart'; title: string; yLabel: string; logField: string; demo: Array<{ x: number; y: number }>; note: string }
  | {
      type: 'detector';
      title: string;
      intro: string;
      baseline: string;
      levels: Array<{ level: number; label: string; meaning: string; action: string }>;
      limits: string[];
      evidence: string;
    }
  | { type: 'rules'; title: string; rules: Array<{ when: string; then: string; severity: DomainSeverity }> }
  | { type: 'checklist'; title: string; items: Array<{ id: string; label: string; detail: string }> }
  | { type: 'docs'; title: string }
  | { type: 'rig'; title: string; body: string; cta: string };

export interface DomainDoc {
  id: string;
  title: string;
  body: string[];
}

export interface DomainPack {
  schema: 'osmograph.domain-pack/1';
  id: string;
  name: string;
  version: string;
  /** Oldest host version that renders this manifest without silent degradation.
   *  Manifests may omit it; when present the gate refuses instead of guessing. */
  minHost?: string;
  author: string;
  license: string;
  risk: DomainRisk;
  domain: string;
  tagline: string;
  summary: string;
  whatItIs: string;
  whatItIsNot: string;
  citations: string[];
  widgets: DomainWidget[];
  docs: DomainDoc[];
  /** Optional Home contribution, rendered by the host from a typed snapshot. */
  home?: VialHomeSpec;
  /** Optional sandboxed UI descriptor. The UI asset is separate from the manifest. */
  ui?: DomainUiSpec;
  /** Optional compact Home UI. Runs in the same sandbox as `ui`, with the same payload. */
  homeUi?: DomainUiSpec;
  /** Canonical UI asset fetched at install time, when the manifest declares one. */
  uiUrl?: string;
  /** Optional provenance for a manifest installed from a URL. */
  sourceUrl?: string;
}

export interface DomainState {
  packId: string;
  installedAt: number;
  fields: Record<string, string>;
  checks: Record<string, boolean>;
  logs: DomainLog[];
}

export interface DomainValidationCheck {
  id: string;
  label: string;
  passed: boolean;
  critical: boolean;
  detail: string;
}

export interface DomainValidation {
  passed: boolean;
  imported: boolean;
  checks: DomainValidationCheck[];
  errors: string[];
  warnings: string[];
}

export interface DomainImportResult {
  pack: DomainPack;
  validation: DomainValidation;
}

const INSTALLED_KEY = 'osmograph.domain.installed.v1';
const STATE_KEY = 'osmograph.domain.state.v1';
const CUSTOM_PACKS_KEY = 'osmograph.domain.packs.v1';
const UI_CACHE_KEY = 'osmograph.domain.ui.v1';
const UI_CACHE_MAX_BYTES = 512_000;

interface DomainUiCacheEntry {
  version: string;
  html: string;
  sourceUrl?: string;
  fetchedAt: number;
}

function readUiCache(): Record<string, DomainUiCacheEntry> {
  try {
    const raw = localStorage.getItem(UI_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};
    const out: Record<string, DomainUiCacheEntry> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!isRecord(value) || typeof value.html !== 'string' || typeof value.version !== 'string') continue;
      out[id] = {
        version: value.version,
        html: value.html,
        sourceUrl: typeof value.sourceUrl === 'string' ? value.sourceUrl : undefined,
        fetchedAt: typeof value.fetchedAt === 'number' ? value.fetchedAt : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Cache the author-hosted UI asset. The cache is bound to a manifest version,
 *  so a new manifest cannot silently reuse an old screen. */
export function saveDomainUi(id: string, version: string, html: string, sourceUrl?: string): void {
  if (!html || html.length > UI_CACHE_MAX_BYTES) return;
  try {
    const cache = readUiCache();
    cache[id] = { version, html, sourceUrl, fetchedAt: Date.now() };
    localStorage.setItem(UI_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Quota or private mode: the declarative workspace still works.
  }
}

export function loadDomainUi(id: string, version: string): string | null {
  const entry = readUiCache()[id];
  return entry && entry.version === version ? entry.html : null;
}

export function clearDomainUi(id: string): void {
  try {
    const cache = readUiCache();
    if (!(id in cache)) return;
    delete cache[id];
    localStorage.setItem(UI_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore cache failures.
  }
}

export const RISK_LABEL: Record<DomainRisk, string> = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
  critical: 'Critical risk',
};

export const SEVERITY_LABEL: Record<DomainSeverity, string> = {
  info: 'context',
  warn: 'caution',
  stop: 'stop',
};


export function loadInstalledIds(): string[] {
  try {
    const raw = localStorage.getItem(INSTALLED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function isInstalled(id: string): boolean {
  return loadInstalledIds().includes(id);
}

export function installDomainPack(id: string): void {
  const pack = domainPackById(id);
  if (!pack) throw new Error('Unknown domain Vial.');
  const ids = loadInstalledIds();
  if (!ids.includes(id)) {
    ids.unshift(id);
    localStorage.setItem(INSTALLED_KEY, JSON.stringify(ids));
  }
  ensureDomainState(id);
}

export function uninstallDomainPack(id: string): void {
  localStorage.setItem(INSTALLED_KEY, JSON.stringify(loadInstalledIds().filter(x => x !== id)));
}

function allStates(): Record<string, DomainState> {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, DomainState> : {};
  } catch {
    return {};
  }
}

function writeStates(states: Record<string, DomainState>): void {
  localStorage.setItem(STATE_KEY, JSON.stringify(states));
}

export function ensureDomainState(packId: string): DomainState {
  const states = allStates();
  const existing = states[packId];
  if (existing) return normalizeState(existing, packId);
  const state: DomainState = {
    packId,
    installedAt: Date.now(),
    fields: {},
    checks: {},
    logs: [],
  };
  states[packId] = state;
  writeStates(states);
  return state;
}

function normalizeState(state: DomainState, packId: string): DomainState {
  return {
    packId,
    installedAt: state.installedAt || Date.now(),
    fields: state.fields || {},
    checks: state.checks || {},
    logs: Array.isArray(state.logs) ? state.logs : [],
  };
}

export function loadDomainState(packId: string): DomainState {
  return ensureDomainState(packId);
}

export function saveDomainState(state: DomainState): void {
  const states = allStates();
  states[state.packId] = state;
  writeStates(states);
}

export function deleteDomainState(packId: string): void {
  const states = allStates();
  delete states[packId];
  writeStates(states);
}

export function addDomainLog(state: DomainState, values: Record<string, string>): DomainState {
  const log: DomainLog = {
    id: `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
    at: Date.now(),
    values,
  };
  return { ...state, logs: [log, ...state.logs].slice(0, 200) };
}

export function removeDomainLog(state: DomainState, logId: string): DomainState {
  return { ...state, logs: state.logs.filter(log => log.id !== logId) };
}

// === Domain pack library: author-hosted projects ===
// The manifest is data. Import is a policy gate followed by a declarative
// render. A declared sandbox/1 UI is fetched separately and runs in an iframe.
// No manifest string is ever inserted as HTML; the renderer escapes every field.

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

function coerceRisk(value: unknown): DomainRisk {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical' ? value : 'medium';
}

function coerceSeverity(value: unknown): DomainSeverity {
  return value === 'info' || value === 'warn' || value === 'stop' ? value : 'info';
}

/** This host's frontend contract version — bump alongside tauri.conf.json. */
export const OSMOGRAPH_HOST_VERSION = '0.1.1';

/** Numeric semver ordering: 1.10.0 > 1.2.0; prerelease suffixes are ignored. */
function semverTuple(version: string): [number, number, number] {
  const parts = version.split('.').map(p => parseInt(p, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function minHostSatisfied(minHost: string): boolean {
  const tuple = semverTuple(minHost);
  if (tuple.every(n => n === 0)) return false; // nonsense values refuse.
  const host = semverTuple(OSMOGRAPH_HOST_VERSION);
  return host[0] > tuple[0]
    || (host[0] === tuple[0] && host[1] > tuple[1])
    || (host[0] === tuple[0] && host[1] === tuple[1] && host[2] >= tuple[2]);
}

function coerceArt(value: unknown): DomainArt {
  return value === 'plant' || value === 'generic' ? value : 'fermentation';
}

function coerceField(value: unknown): DomainField | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  const label = asString(value.label);
  if (!id || !label) return null;
  const type = value.type === 'number' || value.type === 'date' || value.type === 'select' ? value.type : 'text';
  return {
    id,
    label,
    type,
    unit: asString(value.unit) || undefined,
    placeholder: asString(value.placeholder) || undefined,
    options: Array.isArray(value.options) ? asStringArray(value.options) : undefined,
  };
}

function coerceWidget(value: unknown): DomainWidget | null {
  if (!isRecord(value)) return null;
  const type = asString(value.type);
  if (type === 'hero') {
    return { type, art: coerceArt(value.art), title: asString(value.title), subtitle: asString(value.subtitle), note: asString(value.note) };
  }
  if (type === 'risk') {
    return { type, level: coerceRisk(value.level), headline: asString(value.headline), body: asString(value.body), always: asStringArray(value.always), never: asStringArray(value.never) };
  }
  if (type === 'metrics') {
    const items = Array.isArray(value.items) ? value.items.filter(isRecord).map(item => ({
      label: asString(item.label), value: asString(item.value), hint: asString(item.hint),
    })) : [];
    return { type, title: asString(value.title), items };
  }
  if (type === 'diagram') {
    const hotspots = Array.isArray(value.hotspots) ? value.hotspots.filter(isRecord).map(h => ({
      id: asString(h.id), label: asString(h.label),
      x: typeof h.x === 'number' ? h.x : Number(h.x) || 50,
      y: typeof h.y === 'number' ? h.y : Number(h.y) || 50,
      body: asString(h.body), severity: coerceSeverity(h.severity),
    })) : [];
    return { type, art: coerceArt(value.art), title: asString(value.title), caption: asString(value.caption), hotspots };
  }
  if (type === 'timeline') {
    const steps = Array.isArray(value.steps) ? value.steps.filter(isRecord).map(s => ({
      label: asString(s.label), range: asString(s.range), body: asString(s.body), warn: asString(s.warn) || undefined,
    })) : [];
    return { type, title: asString(value.title), steps };
  }
  if (type === 'tracking') {
    const fields = Array.isArray(value.fields) ? value.fields.map(coerceField).filter((f): f is DomainField => !!f) : [];
    const logFields = Array.isArray(value.logFields) ? value.logFields.map(coerceField).filter((f): f is DomainField => !!f) : [];
    return { type, title: asString(value.title), description: asString(value.description), fields, logFields, logLabel: asString(value.logLabel) };
  }
  if (type === 'chart') {
    const demo = Array.isArray(value.demo) ? value.demo.filter(isRecord).map(p => ({
      x: typeof p.x === 'number' ? p.x : Number(p.x) || 0,
      y: typeof p.y === 'number' ? p.y : Number(p.y) || 0,
    })) : [];
    return { type, title: asString(value.title), yLabel: asString(value.yLabel), logField: asString(value.logField), demo, note: asString(value.note) };
  }
  if (type === 'detector') {
    const levels = Array.isArray(value.levels) ? value.levels.filter(isRecord).map(l => ({
      level: typeof l.level === 'number' ? l.level : Number(l.level) || 0,
      label: asString(l.label),
      meaning: asString(l.meaning),
      action: asString(l.action),
    })) : [];
    return {
      type,
      title: asString(value.title),
      intro: asString(value.intro),
      baseline: asString(value.baseline),
      levels,
      limits: asStringArray(value.limits),
      evidence: asString(value.evidence),
    };
  }
  if (type === 'rules') {
    const rules = Array.isArray(value.rules) ? value.rules.filter(isRecord).map(r => ({
      when: asString(r.when), then: asString(r.then), severity: coerceSeverity(r.severity),
    })) : [];
    return { type, title: asString(value.title), rules };
  }
  if (type === 'checklist') {
    const items = Array.isArray(value.items) ? value.items.filter(isRecord).map(i => ({
      id: asString(i.id), label: asString(i.label), detail: asString(i.detail),
    })) : [];
    return { type, title: asString(value.title), items };
  }
  if (type === 'docs') return { type, title: asString(value.title) };
  if (type === 'rig') return { type, title: asString(value.title), body: asString(value.body), cta: asString(value.cta) };
  return null;
}

function coerceUi(value: unknown, surface: 'workspace' | 'home' = 'workspace'): DomainUiSpec | undefined {
  if (!isRecord(value) || value.runtime !== 'sandbox/1') return undefined;
  const entry = asString(value.entry);
  const height = Number(value.height);
  const min = surface === 'home' ? 320 : 420;
  const max = surface === 'home' ? 620 : 2000;
  const fallback = surface === 'home' ? 420 : 900;
  return {
    runtime: 'sandbox/1',
    entry: entry.slice(0, 120),
    height: Number.isFinite(height) ? Math.max(min, Math.min(max, Math.round(height))) : fallback,
  };
}

function coerceHome(value: unknown): VialHomeSpec | undefined {
  if (!isRecord(value)) return undefined;
  const metrics = Array.isArray(value.metrics) ? value.metrics.filter(isRecord).map(m => ({
    label: asString(m.label), value: asString(m.value), hint: asString(m.hint) || undefined,
  })) : [];
  const actions = Array.isArray(value.actions) ? value.actions.filter(isRecord).map(a => ({
    id: asString(a.id),
    label: asString(a.label),
    kind: asString(a.kind) as VialHomeActionKind,
    href: asString(a.href) || undefined,
  })) : [];
  return {
    headline: asString(value.headline),
    detail: asString(value.detail),
    metrics,
    actions,
    limits: asStringArray(value.limits),
    sources: asStringArray(value.sources),
  };
}

function coercePack(raw: unknown): DomainPack {
  const source = isRecord(raw) ? raw : {};
  const docs = Array.isArray(source.docs) ? source.docs.filter(isRecord).map(d => ({
    id: asString(d.id), title: asString(d.title), body: asStringArray(d.body),
  })) : [];
  const widgets = Array.isArray(source.widgets) ? source.widgets.map(coerceWidget).filter((w): w is DomainWidget => !!w) : [];
  const home = coerceHome(source.home);
  const ui = coerceUi(source.ui);
  const homeUi = coerceUi(source.homeUi, 'home');
  return {
    schema: 'osmograph.domain-pack/1',
    id: asString(source.id),
    name: asString(source.name),
    version: asString(source.version),
    minHost: asString(source.minHost) || asString(source.min_host) || undefined,
    author: asString(source.author),
    license: asString(source.license),
    risk: coerceRisk(source.risk),
    domain: asString(source.domain),
    tagline: asString(source.tagline),
    summary: asString(source.summary),
    whatItIs: asString(source.whatItIs),
    whatItIsNot: asString(source.whatItIsNot),
    citations: asStringArray(source.citations),
    widgets,
    docs,
    home,
    ui,
    homeUi,
    sourceUrl: asString(source.sourceUrl) || undefined,
  };
}

export function loadCustomPacks(): DomainPack[] {
  try {
    const raw = localStorage.getItem(CUSTOM_PACKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(coercePack)
      .filter(pack => validateDomainPack(pack, true).passed)
      .filter(pack => (!pack.ui || !!pack.sourceUrl) && (!pack.homeUi || !!pack.sourceUrl));
  } catch {
    return [];
  }
}

function writeCustomPacks(packs: DomainPack[]): void {
  localStorage.setItem(CUSTOM_PACKS_KEY, JSON.stringify(packs));
}

export function saveCustomPack(pack: DomainPack): void {
  const packs = loadCustomPacks().filter(p => p.id !== pack.id);
  packs.unshift(pack);
  writeCustomPacks(packs);
}

export function deleteCustomPack(id: string): void {
  writeCustomPacks(loadCustomPacks().filter(p => p.id !== id));
}

export function allDomainPacks(): DomainPack[] {
  // Every Vial is an author-hosted manifest. There is no built-in tier and no
  // bundled fallback: the app runs the manifest the author published.
  return loadCustomPacks();
}

export function domainPackById(id: string): DomainPack | undefined {
  return allDomainPacks().find(p => p.id === id);
}

function allPackText(pack: DomainPack): string {
  const chunks: string[] = [
    pack.id, pack.name, pack.author, pack.license, pack.domain, pack.tagline,
    pack.summary, pack.whatItIs, pack.whatItIsNot, ...pack.citations,
  ];
  for (const doc of pack.docs) chunks.push(doc.title, ...doc.body);
  for (const widget of pack.widgets) {
    chunks.push(JSON.stringify(widget));
  }
  if (pack.home) {
    chunks.push(pack.home.headline, pack.home.detail, ...pack.home.limits, ...pack.home.sources);
  }
  return chunks.join('\n');
}

function negatedBefore(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const sentenceStart = Math.max(
    before.lastIndexOf('.'),
    before.lastIndexOf('!'),
    before.lastIndexOf('?'),
    before.lastIndexOf('\n'),
  );
  const sentence = before.slice(sentenceStart + 1).toLowerCase();
  return /\b(?:not|no|cannot|can't|never|without|refuse|refuses|refused|doesn't|does not|isn't|is not|zero)\b/.test(sentence);
}

function firstUnnegated(text: string, re: RegExp): RegExpExecArray | null {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = global.exec(text))) {
    if (!negatedBefore(text, match.index)) return match;
    if (match.index === global.lastIndex) global.lastIndex++;
  }
  return null;
}

const OVERCLAIM_PATTERNS: Array<{ id: string; re: RegExp; label: string }> = [
  { id: 'safety', re: /\bsafe to eat\b/i, label: 'a “safe to eat” claim' },
  { id: 'pathogen', re: /\bpathogen(?: test| detection| identification)\b/i, label: 'a pathogen test claim' },
  { id: 'diagnosis', re: /\bdiagnos(?:e|es|is|tic)\b/i, label: 'a diagnosis claim' },
  { id: 'ethylene', re: /\bdetect(?:s|ing)? ethylene\b/i, label: 'an ethylene detection claim' },
  { id: 'universal', re: /\buniversal smell (?:id|identifier)\b/i, label: 'a universal smell ID claim' },
  { id: 'concentration', re: /\b(?:absolute concentration|parts per million|ppm)\b/i, label: 'an absolute concentration claim' },
  { id: 'crossrig', re: /\bcross[- ]rig\b/i, label: 'a cross-rig claim' },
  { id: 'anyrig', re: /\bworks? on any (?:rig|array|device)\b/i, label: 'a works-on-any-rig claim' },
  { id: 'guarantee', re: /\bguarantee(?:d|s)?\b/i, label: 'a guarantee' },
  { id: 'medical', re: /\bmedical (?:diagnosis|device|advice)\b/i, label: 'a medical claim' },
  { id: 'safety-device', re: /\b(?:gas leak detector|certified safety device|life[- ]safety device|safety instrument)\b/i, label: 'a safety-device claim' },
  { id: 'safety-verdict', re: /\b(?:safe to (?:enter|occupy|breathe)|(?:room|space|area) is safe)\b/i, label: 'a safety verdict' },
];

const EXECUTABLE_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'script-tag', re: /<script\b/i },
  { id: 'iframe', re: /<iframe\b/i },
  { id: 'object', re: /<object\b|<embed\b|<img\b|<link\b/i },
  { id: 'javascript-url', re: /javascript:/i },
  { id: 'inline-handler', re: /\bon[a-z]+\s*=/i },
  { id: 'data-html', re: /data:text\/html/i },
];

export function validateDomainPack(pack: DomainPack, imported = false): DomainValidation {
  const checks: DomainValidationCheck[] = [];
  const add = (id: string, label: string, passed: boolean, critical: boolean, detail: string) => {
    checks.push({ id, label, passed, critical, detail });
  };
  const text = allPackText(pack);
  const widgetTypes = new Set(pack.widgets.map(w => w.type));

  add('schema', 'Manifest schema', pack.schema === 'osmograph.domain-pack/1', true, 'Expected osmograph.domain-pack/1.');
  if (pack.minHost != null) {
    const ok = minHostSatisfied(pack.minHost);
    add('min-host', 'Host version', ok, true, ok
      ? `Requires Osmograph ≥ ${pack.minHost}; this install satisfies it.`
      : `Requires Osmograph ≥ ${pack.minHost}; this install is ${OSMOGRAPH_HOST_VERSION}. Refusing over silent degradation.`);
  } else {
    add('min-host', 'Host version', true, false, 'No minimum host declared.');
  }
  add('id', 'Stable id', /^[a-z0-9][a-z0-9._-]{2,80}$/.test(pack.id), true, 'Use a lowercase, globally unique id (3–80 chars).');
  add('name', 'Name', pack.name.trim().length >= 2 && pack.name.trim().length <= 80, true, 'A pack needs a short display name.');
  add('version', 'Semantic version', /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pack.version), true, 'Use semver, for example 0.2.0.');
  add('author', 'Author identity', pack.author.trim().length >= 2 && pack.author.trim().length <= 80, true, 'Credit the author or handle.');
  add('license', 'Licence', pack.license.trim().length >= 2 && pack.license.trim().length <= 80, true, 'State a licence (SPDX id or a licence URL).');
  add('risk', 'Risk level', ['low', 'medium', 'high', 'critical'].includes(pack.risk), true, 'Declare low, medium, high, or critical risk.');
  add('domain', 'Domain', pack.domain.trim().length >= 2, true, 'Name the domain, for example fermentation or plants.');
  add('tagline', 'Tagline', pack.tagline.trim().length >= 4 && pack.tagline.trim().length <= 160, true, 'One honest line about the workspace.');
  add('summary', 'Summary', pack.summary.trim().length >= 30 && pack.summary.trim().length <= 600, true, 'Explain the workspace and its scope.');
  add('what-it-is', 'What it is', pack.whatItIs.trim().length >= 30, true, 'State the useful claim or protocol.');
  add('what-it-is-not', 'What it is not', pack.whatItIsNot.trim().length >= 30 && /(?:not|cannot|no\s|never|without|refuse)/i.test(pack.whatItIsNot), true, 'Name the claim you refuse to make.');
  add('citations', 'Citations', pack.citations.length >= 1 && pack.citations.every(c => c.trim().length >= 10), true, 'At least one real reference, not a vibe.');
  add('docs', 'Field notes', pack.docs.length >= 2 && pack.docs.every(d => d.title.trim() && d.body.length >= 1), true, 'At least two documented sections with body text.');
  add('hero', 'Overview panel', widgetTypes.has('hero'), true, 'A domain Vial needs an overview.');
  add('risk-panel', 'Risk panel', widgetTypes.has('risk'), true, 'A domain Vial must show its risk framing.');
  add('docs-panel', 'Docs panel', widgetTypes.has('docs'), true, 'A domain Vial must expose its field notes.');
  add('rig-panel', 'Rig handoff', widgetTypes.has('rig'), true, 'Show how the workspace connects to Check.');
  add('workspace', 'A workspace surface', widgetTypes.has('tracking') || widgetTypes.has('diagram') || widgetTypes.has('rules'), true, 'Add a log, a diagram, or decision rules.');

  if (pack.home) {
    const h = pack.home;
    const validKinds = ['open-workspace', 'open-check', 'open-datasets', 'open-gallery', 'external'];
    add('home-contract', 'Home contribution', h.headline.trim().length > 0 && h.detail.trim().length > 0, true, 'A Home contribution needs a headline and a detail line.');
    add('home-actions', 'Home actions', h.actions.length >= 1 && h.actions.length <= 3 && h.actions.every(a => a.id.trim() && a.label.trim() && validKinds.includes(a.kind) && (a.kind !== 'external' || !!a.href)), true, 'Provide one to three valid actions; external actions need an href.');
    add('home-metrics', 'Home metrics', h.metrics.length <= 4 && h.metrics.every(m => m.label.trim() && m.value.trim()), true, 'At most four metrics, each with a label and a value.');
    add('home-limits', 'Home limits', h.limits.length >= 1 && h.limits.every(l => l.trim().length >= 10), true, 'State at least one explicit limit in the Home contribution.');
    add('home-sources', 'Home sources', h.sources.length >= 1 && h.sources.every(s => s.trim().length >= 10), true, 'Cite at least one source for the Home contribution.');
  } else {
    add('home-contract', 'Home contribution', true, false, 'No Home contribution declared; this Vial stays workspace-only.');
  }

  const riskWidgets = pack.widgets.filter((w): w is Extract<DomainWidget, { type: 'risk' }> => w.type === 'risk');
  add('risk-lists', 'Always / never limits', riskWidgets.length > 0 && riskWidgets.every(w => w.always.length >= 1 && w.never.length >= 1), true, 'The risk panel needs explicit always and never lists.');
  add('risk-match', 'Risk level consistency', riskWidgets.every(w => w.level === pack.risk), false, 'The risk panel and pack should declare the same level.');

  if (pack.risk === 'high' || pack.risk === 'critical') {
    const stopRules = pack.widgets.flatMap(w => w.type === 'rules' ? w.rules : []).filter(r => r.severity === 'stop');
    add('high-risk-stop', 'High-risk stop rules', stopRules.length >= 1, true, 'High and critical risk packs need at least one explicit stop rule.');
    add('high-risk-docs', 'High-risk documentation', pack.docs.length >= 3, true, 'High and critical risk packs need at least three field-note sections.');
  }

  for (const widget of pack.widgets) {
    if (widget.type === 'tracking') {
      add('tracking-fields', 'Tracking fields', widget.fields.length >= 2 && widget.logFields.length >= 2, true, 'A log needs at least two context fields and two reading fields.');
    }
    if (widget.type === 'diagram') {
      add('diagram-hotspots', 'Diagram hotspots', widget.hotspots.length >= 1 && widget.hotspots.every(h => h.x >= 0 && h.x <= 100 && h.y >= 0 && h.y <= 100), true, 'Diagram points need labels, notes, and 0–100 coordinates.');
    }
    if (widget.type === 'detector') {
      add('detector-levels', 'Detector states', widget.levels.length >= 3 && widget.levels.every(l => Number.isFinite(l.level) && l.label.trim() && l.meaning.trim() && l.action.trim()), true, 'Document at least three detector states with a meaning and an action.');
      add('detector-limits', 'Detector limits', widget.limits.length >= 2 && widget.limits.every(l => l.trim().length >= 10), true, 'A detector panel needs at least two explicit limits.');
      add('detector-evidence', 'Detector evidence', widget.evidence.trim().length >= 20, true, 'State the evidence behind the detector mapping.');
    }
    if (widget.type === 'rules') {
      add('rule-text', 'Rule text', widget.rules.every(r => r.when.trim() && r.then.trim()), true, 'Every rule needs a when and a then.');
    }
    if (widget.type === 'checklist') {
      add('checklist-items', 'Checklist items', widget.items.length >= 1 && widget.items.every(i => i.id && i.label), true, 'Checklist items need stable ids and labels.');
    }
  }

  const executable = EXECUTABLE_PATTERNS.find(p => p.re.test(text));
  const uiSpecs: Array<{ key: string; label: string; spec: DomainUiSpec }> = [];
  if (pack.ui) uiSpecs.push({ key: 'ui', label: 'UI', spec: pack.ui });
  if (pack.homeUi) uiSpecs.push({ key: 'home-ui', label: 'Home UI', spec: pack.homeUi });
  if (uiSpecs.length) {
    for (const { key, label, spec } of uiSpecs) {
      add(`${key}-runtime`, `${label} runtime`, spec.runtime === 'sandbox/1', true, 'Only sandbox/1 is supported. The UI runs in an iframe with no network, storage, file, or Tauri access.');
      add(
        `${key}-entry`,
        `${label} entry`,
        /^[a-z0-9][a-z0-9._-]*\.html$/i.test(spec.entry) && !spec.entry.includes('..'),
        true,
        'Use a relative .html filename beside the manifest; no paths, schemes, or query strings.',
      );
      add(`${key}-scope`, `${label} scope`, true, false, 'The UI is a body fragment in an iframe: no file, network, storage, forms, or Tauri access. It is not signed or reviewed.');
    }
    add('no-code', 'Manifest stays declarative', !executable, true, executable ? `Rejected ${executable.id}: the manifest itself must stay declarative. Executable UI belongs in the separate sandboxed asset.` : 'Manifest text only; executable UI is a separate sandboxed asset.');
  } else {
    add('no-code', 'No executable or remote UI', !executable, true, executable ? `Rejected ${executable.id}: packs are declarative; no HTML, JavaScript, or embedded resources.` : 'Declarative text only.');
  }

  const overclaims = OVERCLAIM_PATTERNS.filter(p => !!firstUnnegated(text, p.re));
  add('no-overclaim', 'No overclaim language', overclaims.length === 0, true, overclaims.length ? `Remove or negate: ${overclaims.map(o => o.label).join(', ')}.` : 'No unnegated forbidden claims found.');

  const errors = checks.filter(c => c.critical && !c.passed).map(c => c.detail);
  const warnings = checks.filter(c => !c.critical && !c.passed).map(c => c.detail);
  return { passed: errors.length === 0, imported, checks, errors, warnings };
}

export function domainPackToJson(pack: DomainPack): string {
  // A manifest describes the UI asset; it never embeds it. The author-hosted
  // ui.html beside the manifest is the canonical source.
  return JSON.stringify(pack, null, 2);
}

export function inspectDomainPackJson(raw: string, sourceUrl?: string): DomainImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!isRecord(parsed) || parsed.schema !== 'osmograph.domain-pack/1') {
    throw new Error('Expected a domain pack with schema osmograph.domain-pack/1.');
  }
  const pack = coercePack(parsed);
  pack.sourceUrl = sourceUrl;
  return { pack, validation: validateDomainPack(pack, true) };
}

export function parseDomainPackJson(raw: string, sourceUrl?: string): DomainImportResult {
  const result = inspectDomainPackJson(raw, sourceUrl);
  if (!result.validation.passed) {
    throw new Error(`Domain Vial rejected by the policy gate: ${result.validation.errors[0] || 'unknown reason'}`);
  }
  return result;
}

export function importDomainPackJson(raw: string, sourceUrl?: string): DomainImportResult {
  const result = parseDomainPackJson(raw, sourceUrl);
  if ((result.pack.ui || result.pack.homeUi) && !sourceUrl) {
    throw new Error('This Vial ships a sandboxed UI. Install it from its manifest URL so Osmograph can fetch the ui.html and home.html beside it; a local file cannot carry the UI assets.');
  }
  saveCustomPack(result.pack);
  return result;
}

