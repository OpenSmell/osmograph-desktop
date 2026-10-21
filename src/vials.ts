// Vials — the reusable, evidence-backed decision pack.
//
// A Vial is not a plugin for its own sake. It is the smallest object that can
// travel: a closed-set claim, the evidence that supports it, the array it was
// measured on, the limits of that claim, and the recipe that produced it.
// Local-first by design: the manifest is a file the author can export, import,
// inspect, or submit to a registry later.

export type SeparationVerdict = 'separable' | 'fragile' | 'confusable' | 'insufficient';
export type VialStatus = 'draft' | 'open' | 'sealed';

export interface VialEvidence {
  checkId?: string;
  question: string;
  referenceKey: string;
  sampleKey: string;
  reference: string;
  sample: string;
  verdict: SeparationVerdict;
  accuracy: number;
  nEval: number;
  nRef: number;
  nSample: number;
  pValue: number;
  channels: string[];
  source: string;
}

export interface VialClaim {
  question: string;
  decision: 'distinguish';
  referenceKey: string;
  sampleKey: string;
  reference: string;
  sample: string;
  verdict: SeparationVerdict;
  accuracy: number;
  nEval: number;
  lowerBound: number;
  pValue: number;
  nRef: number;
  nSample: number;
  channels: string[];
}

export interface VialCheck {
  id: string;
  label: string;
  passed: boolean;
  critical: boolean;
  detail: string;
}

export interface VialValidation {
  passed: boolean;
  score: number;
  checkedAt: number;
  summary: string;
  checks: VialCheck[];
}

export interface VialUsage {
  uses: number;
  lastUsedAt: number | null;
}

export interface VialRecipeRef {
  id: string;
  name: string;
  version: string;
  steps: number;
}

export interface VialManifest {
  schema: 'osmograph.vial/1';
  id: string;
  name: string;
  version: string;
  author: string;
  license: string;
  domain: string;
  description: string;
  claim: VialClaim;
  limits: string[];
  evidence: string[];
  source: string;
  recipe: VialRecipeRef | null;
  createdAt: number;
  status: VialStatus;
  validation: VialValidation | null;
  usage: VialUsage;
}

export interface VialInput {
  name: string;
  author: string;
  version: string;
  license: string;
  domain: string;
  description: string;
  limits: string[];
  recipe?: VialRecipeRef | null;
}

const STORAGE_KEY = 'osmograph.vials.v1';
const MAX_VIALS = 100;

// A Vial that claims a decision must not smuggle in a claim the evidence cannot
// support. These are the phrases the research gate forbids; the validator treats
// them as a hard stop, not a style warning.
const FORBIDDEN = [
  /identify (any|unknown|the) (smell|odor|substance)/i,
  /universal (smell|odor|e-?nose|sensor)/i,
  /absolute concentration/i,
  /100\s*%\s*accurate/i,
  /guarantee[ds]?/i,
  /safe to (eat|drink|use|consume)/i,
  /medical diagnos/i,
  /chemical fingerprint/i,
  /replaces? (a |the )?(gc-?ms|laboratory|lab test)/i,
  /works? on (any|every) (rig|array|device)/i,
];

export function wilsonLower(correct: number, n: number): number {
  if (n <= 0) return NaN;
  const z = 1.96;
  const p = Math.max(0, Math.min(1, correct / n));
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 42) || 'vial';
}

function semverOk(v: string): boolean {
  return /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(v.trim());
}

export function newVialId(name: string): string {
  return `vial_${slug(name)}_${Date.now().toString(36)}`;
}

export function createManifest(input: VialInput, evidence: VialEvidence): VialManifest {
  const lowerBound = wilsonLower(Math.round(evidence.accuracy * evidence.nEval), evidence.nEval);
  const limits = input.limits.map(l => l.trim()).filter(Boolean);
  if (!limits.length) {
    limits.push(
      'Closed-set comparison on the channels listed; not open-world identification.',
      'Validated on saved replicates from this source; not a cross-rig claim.',
    );
  }
  return {
    schema: 'osmograph.vial/1',
    id: newVialId(input.name),
    name: input.name.trim(),
    version: input.version.trim() || '0.1.0',
    author: input.author.trim() || '@anonymous',
    license: input.license.trim() || 'CC-BY-4.0',
    domain: input.domain.trim() || 'general',
    description: input.description.trim(),
    claim: {
      question: evidence.question.trim(),
      decision: 'distinguish',
      referenceKey: evidence.referenceKey,
      sampleKey: evidence.sampleKey,
      reference: evidence.reference,
      sample: evidence.sample,
      verdict: evidence.verdict,
      accuracy: evidence.accuracy,
      nEval: evidence.nEval,
      lowerBound,
      pValue: evidence.pValue,
      nRef: evidence.nRef,
      nSample: evidence.nSample,
      channels: evidence.channels.slice(),
    },
    limits,
    evidence: [
      ...(evidence.checkId ? [`check:${evidence.checkId}`] : []),
      `source:${evidence.source}`,
      `replicates:${evidence.nRef}+${evidence.nSample}`,
      `channels:${evidence.channels.join(',')}`,
    ],
    source: evidence.source,
    recipe: input.recipe || null,
    createdAt: Date.now(),
    status: 'draft',
    validation: null,
    usage: { uses: 0, lastUsedAt: null },
  };
}

function pushCheck(checks: VialCheck[], id: string, label: string, passed: boolean, critical: boolean, detail: string): void {
  checks.push({ id, label, passed, critical, detail });
}

export function validateVial(vial: VialManifest): VialValidation {
  const checks: VialCheck[] = [];
  const c = vial.claim;
  const text = [vial.name, vial.description, c.question, ...vial.limits, ...vial.evidence].join(' ');
  const overclaim = FORBIDDEN.find(rx => rx.test(text));

  pushCheck(checks, 'identity', 'Name, author, and version are present', !!vial.name.trim() && !!vial.author.trim() && semverOk(vial.version), true,
    !vial.name.trim() ? 'Name is empty.' : !vial.author.trim() ? 'Author is empty.' : !semverOk(vial.version) ? 'Version is not semver.' : `${vial.name} ${vial.version} by ${vial.author}`);
  pushCheck(checks, 'license', 'License is declared', !!vial.license.trim(), true, vial.license || 'No license.');
  pushCheck(checks, 'claim', 'Claim names a reference and a sample', !!c.question.trim() && !!c.reference.trim() && !!c.sample.trim() && c.decision === 'distinguish', true,
    c.question || 'No question.');
  pushCheck(checks, 'array', 'Both sides use the same array channels', c.channels.length >= 2 && new Set(c.channels).size === c.channels.length, true,
    c.channels.length ? c.channels.join(' · ') : 'No channels recorded.');
  pushCheck(checks, 'replicates', 'At least 3 comparable recordings per side', c.nRef >= 3 && c.nSample >= 3, true,
    `${c.nRef} reference vs ${c.nSample} sample.`);
  pushCheck(checks, 'evaluated', 'At least 6 held-out recordings were evaluated', c.nEval >= 6, true,
    `${c.nEval} held-out recordings.`);
  pushCheck(checks, 'verdict', 'The pair reaches the separable verdict', c.verdict === 'separable', true,
    `Verdict: ${c.verdict}.`);
  pushCheck(checks, 'lower', '95% Wilson lower bound is at least 55%', Number.isFinite(c.lowerBound) && c.lowerBound >= 0.55, true,
    Number.isFinite(c.lowerBound) ? `${Math.round(c.lowerBound * 100)}% lower bound.` : 'Not computed.');
  pushCheck(checks, 'pvalue', 'Label-shuffle p-value is at most 0.05', Number.isFinite(c.pValue) && c.pValue <= 0.05, true,
    Number.isFinite(c.pValue) ? `p = ${c.pValue.toFixed(3)}.` : 'Not computed.');
  pushCheck(checks, 'limits', 'At least one explicit limit is declared', vial.limits.length > 0 && vial.limits.every(l => !!l.trim()), true,
    vial.limits.length ? `${vial.limits.length} limit(s).` : 'No limits.');
  pushCheck(checks, 'provenance', 'Source and evidence are recorded', !!vial.source.trim() && vial.evidence.length > 0, true,
    vial.source || 'No source.');
  pushCheck(checks, 'overclaim', 'No forbidden overclaim language', !overclaim, true,
    overclaim ? `Forbidden phrase: ${overclaim}.` : 'No forbidden claim language.');
  pushCheck(checks, 'recipe', 'Recipe provenance is attached', !!vial.recipe, false,
    vial.recipe ? `${vial.recipe.name} ${vial.recipe.version} · ${vial.recipe.steps} step(s)` : 'No recipe attached; the claim is still inspectable from the check evidence.');

  const critical = checks.filter(x => x.critical);
  const passedCritical = critical.filter(x => x.passed).length;
  const allPassed = passedCritical === critical.length;
  const score = checks.length ? checks.filter(x => x.passed).length / checks.length : 0;
  const summary = allPassed
    ? 'Sealed: the local evidence supports this closed-set claim. It still does not generalize to another rig.'
    : 'Open: the evidence does not yet support a sealed decision. Do not use this for a real decision.';
  return { passed: allPassed, score, checkedAt: Date.now(), summary, checks };
}

export function applyValidation(vial: VialManifest): VialManifest {
  const validation = validateVial(vial);
  return { ...vial, validation, status: validation.passed ? 'sealed' : 'open' };
}

export function loadVials(): VialManifest[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row): row is VialManifest => {
      if (!row || typeof row !== 'object') return false;
      const o = row as Record<string, unknown>;
      return o.schema === 'osmograph.vial/1'
        && typeof o.id === 'string'
        && typeof o.name === 'string'
        && !!o.claim && typeof o.claim === 'object';
    }).slice(0, MAX_VIALS);
  } catch {
    return [];
  }
}

export function persistVials(vials: VialManifest[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(vials.slice(0, MAX_VIALS)));
}

export function upsertVial(vial: VialManifest): VialManifest[] {
  const all = loadVials().filter(v => v.id !== vial.id);
  all.unshift(vial);
  persistVials(all);
  return loadVials();
}

export function deleteVial(id: string): VialManifest[] {
  const all = loadVials().filter(v => v.id !== id);
  persistVials(all);
  return all;
}

export function recordVialUse(id: string): VialManifest[] {
  const all = loadVials().map(v => v.id === id
    ? { ...v, usage: { uses: (v.usage?.uses || 0) + 1, lastUsedAt: Date.now() } }
    : v);
  persistVials(all);
  return all;
}

export function vialToJson(vial: VialManifest): string {
  return JSON.stringify(vial, null, 2);
}

export function importVialJson(text: string): VialManifest {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('Not a Vial manifest.');
  const o = parsed as Record<string, unknown>;
  if (o.schema !== 'osmograph.vial/1') throw new Error('Unknown Vial schema.');
  if (typeof o.id !== 'string' || typeof o.name !== 'string' || !o.claim || typeof o.claim !== 'object') {
    throw new Error('Vial manifest is missing id, name, or claim.');
  }
  const vial = o as unknown as VialManifest;
  return { ...vial, usage: vial.usage || { uses: 0, lastUsedAt: null } };
}
