// The stable bridge between the Osmograph data plane and a Vial.
//
// The host owns sampling, baseline health, anomaly detection, and the safety
// gates. A Vial receives a small, typed snapshot and returns a bounded Home
// contribution. It never receives raw buffers, never owns the detector, and
// never gets to override a host refusal.

export const VIAL_HOST_SCHEMA = 'osmograph.vial-host/1' as const;
export const VIAL_HOME_SCHEMA = 'osmograph.vial-home/1' as const;

export type HostSource = 'live' | 'replay' | 'dataset' | 'none';
export type SamplingMode = 'timeseries' | 'trial' | 'unknown';
export type BaselineState = 'none' | 'warming' | 'ready' | 'stale';
export type AnomalyState = 'unknown' | 'normal' | 'warning' | 'critical';
export type ClassifierState = 'none' | 'loaded' | 'unknown';
export type VialHomeState = 'idle' | 'warming' | 'live' | 'attention' | 'ready';

export interface HostChannel {
  id: string;
  label: string;
  kind: string;
  unit?: string;
  health?: 'ok' | 'stuck' | 'saturated' | 'noisy' | 'unknown';
}

export interface HostEnvironment {
  temperature: number | null;
  humidity: number | null;
}

export interface HostBaseline {
  state: BaselineState;
  progress: number;
  ageSec: number | null;
}

export interface HostAnomaly {
  state: AnomalyState;
  score: number | null;
  confidence: number | null;
  alertLevel: number;
  triggeredChannels: number;
  consecutive: number;
}

export interface HostClassifier {
  state: ClassifierState;
  name: string | null;
  label: string | null;
  confidence: number | null;
}

/** Per-channel single-unit limits, computed from live data by the host.
 *  A channel with cv below the dead threshold is flagged dead and excluded
 *  from derived features. These are the rigor floor: a Vial may tighten
 *  them but never loosen them below what the data supports. */
export interface ChannelLimit {
  dead: boolean;
  cv: number;
  min: number;
  max: number;
  r0: number | null;
}

/** Detection config a Vial may declare. The host validates against hardware
 *  sufficiency before applying; a Vial may tighten limits but never bypass
 *  a host refusal. */
export interface VialDetectionConfig {
  enabled: boolean;
  alertThreshold: number;   // 0..1, calibrated-confidence-equivalent floor
  perChannelLimits: Record<string, number>; // channel id -> max allowed delta magnitude
}

/** A single trajectory point: timestamp + per-field values the Vial asked to track. */
export interface TrajectoryPoint {
  at: number;
  values: Record<string, number>;
}

/** The host's verdict after applying a Vial-declared detection config to the
 *  current window. Null when no config is in force. */
export interface VialDetectionResult {
  active: boolean;
  triggeredChannels: string[];
  /** False when the profile's admissibility gate refuses to arm (baseline
   *  not ready, or channel coverage below the declared minimum). */
  admissible?: boolean;
  /** Why the profile is not admissible, or null. */
  reason?: string | null;
}

/** The only live state a Vial is allowed to depend on. */
export interface VialHostSnapshot {
  schema: typeof VIAL_HOST_SCHEMA;
  takenAt: number;
  source: HostSource;
  samplingMode: SamplingMode;
  channels: HostChannel[];
  environment: HostEnvironment | null;
  baseline: HostBaseline;
  anomaly: HostAnomaly;
  classifier: HostClassifier;
  /** Per-channel limits computed from the live stream. Read-only for the Vial. */
  channelLimits: Record<string, ChannelLimit>;
  /** Detection config currently in force. Null until a Vial declares one and
   *  the host accepts it after the hardware-sufficiency gate. */
  detectionConfig: VialDetectionConfig | null;
  /** Host verdict for the declared config; null when no config is in force. */
  detection: VialDetectionResult | null;
  /** Transform IDs the host has applied to the live stream. */
  transformsApplied: string[];
  /** Recent trajectory points tracked at the Vial's requested interval. */
  trajectory: TrajectoryPoint[];
}

export interface VialHomeMetric {
  label: string;
  value: string;
  hint?: string;
}

export type VialHomeActionKind =
  | 'open-workspace'
  | 'open-check'
  | 'open-datasets'
  | 'open-gallery'
  | 'external';

export interface VialHomeAction {
  id: string;
  label: string;
  kind: VialHomeActionKind;
  href?: string;
}

/** What an author declares in the Vial manifest. */
export interface VialHomeSpec {
  headline: string;
  detail: string;
  metrics: VialHomeMetric[];
  actions: VialHomeAction[];
  limits: string[];
  sources: string[];
}

/** What the host renders after combining the spec with live state. */
export interface VialHomeContribution extends VialHomeSpec {
  schema: typeof VIAL_HOME_SCHEMA;
  vialId: string;
  vialName: string;
  state: VialHomeState;
  stateLabel: string;
  generatedAt: number;
  runtime: VialHomeMetric[];
}

export function emptyHostSnapshot(now = Date.now()): VialHostSnapshot {
  return {
    schema: VIAL_HOST_SCHEMA,
    takenAt: now,
    source: 'none',
    samplingMode: 'unknown',
    channels: [],
    environment: null,
    baseline: { state: 'none', progress: 0, ageSec: null },
    anomaly: {
      state: 'unknown',
      score: null,
      confidence: null,
      alertLevel: 0,
      triggeredChannels: 0,
      consecutive: 0,
    },
    classifier: { state: 'none', name: null, label: null, confidence: null },
    channelLimits: {},
    detectionConfig: null,
    detection: null,
    transformsApplied: [],
    trajectory: [],
  };
}

function runtimeFor(snapshot: VialHostSnapshot): { state: VialHomeState; label: string; metrics: VialHomeMetric[] } {
  if (snapshot.source === 'none') {
    return {
      state: 'idle',
      label: 'No rig',
      metrics: [{ label: 'Baseline', value: 'not armed', hint: 'Connect a rig or replay a real recording.' }],
    };
  }

  if (snapshot.baseline.state === 'warming') {
    return {
      state: 'warming',
      label: 'Baseline forming',
      metrics: [
        { label: 'Baseline', value: `${Math.round(snapshot.baseline.progress * 100)}%`, hint: 'No alarm can fire yet.' },
      ],
    };
  }

  if (snapshot.anomaly.state === 'warning' || snapshot.anomaly.state === 'critical') {
    return {
      state: 'attention',
      label: snapshot.anomaly.state === 'critical' ? 'Critical change' : 'Change detected',
      metrics: [
        {
          label: 'Alert',
          value: snapshot.anomaly.state,
          hint: `${snapshot.anomaly.triggeredChannels} channel(s) triggered. This is a change signal, not an identity.`,
        },
      ],
    };
  }

  if (snapshot.classifier.state === 'loaded') {
    return {
      state: 'ready',
      label: 'Classifier loaded',
      metrics: [
        {
          label: 'Prediction',
          value: snapshot.classifier.label || 'waiting',
          hint: snapshot.classifier.confidence !== null
            ? `${Math.round(snapshot.classifier.confidence * 100)}% confidence. Closed-set output only.`
            : 'Closed-set output only.',
        },
      ],
    };
  }

  return {
    state: 'live',
    label: 'Live',
    metrics: [{ label: 'Baseline', value: 'ready', hint: 'Watching this array for a sustained change.' }],
  };
}

export function homeContributionFor(
  pack: { id: string; name: string; home?: VialHomeSpec },
  snapshot: VialHostSnapshot,
): VialHomeContribution | null {
  if (!pack.home) return null;
  const runtime = runtimeFor(snapshot);
  return {
    schema: VIAL_HOME_SCHEMA,
    vialId: pack.id,
    vialName: pack.name,
    ...pack.home,
    state: runtime.state,
    stateLabel: runtime.label,
    generatedAt: snapshot.takenAt,
    runtime: runtime.metrics,
  };
}

export interface HomeValidation {
  ok: boolean;
  errors: string[];
}

export function validateHomeContribution(contribution: VialHomeContribution): HomeValidation {
  const errors: string[] = [];
  if (!contribution.headline.trim()) errors.push('headline is required');
  if (!contribution.detail.trim()) errors.push('detail is required');
  if (contribution.metrics.length > 4) errors.push('at most four declared metrics');
  if (contribution.actions.length === 0) errors.push('at least one action is required');
  if (contribution.actions.length > 3) errors.push('at most three actions');
  if (contribution.limits.length === 0) errors.push('at least one limit is required');
  if (contribution.sources.length === 0) errors.push('at least one source is required');
  for (const action of contribution.actions) {
    if (!action.id.trim() || !action.label.trim()) errors.push('every action needs an id and label');
    if (action.kind === 'external' && !action.href) errors.push(`external action ${action.id} needs an href`);
  }
  return { ok: errors.length === 0, errors };
}
