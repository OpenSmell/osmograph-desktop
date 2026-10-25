// The programmable core of a Vial.
//
// A Vial is not a folder of static text. It is a profile program plus a
// domain UI plus evidence. This module owns the profile contract: the
// baseline, the transforms, the anomaly thresholds, the persistence and
// hysteresis, the escalation ladder, and the evidence that constrains them.
//
// The host compiles this profile into a detector it owns. The Vial never
// replaces the detector and never raises the host's alert level; it declares
// what counts as a relevant change for one array and one process, inside the
// limits the host can verify.

export type VialBaselineProtocol = 'first-n' | 'session-mean';
export type VialResponseMode = 'delta-over-r0' | 'relative' | 'delta';
export type VialEvidenceGrade = 'A' | 'B' | 'C' | 'D';

export interface VialAnomalyProfile {
  baseline: {
    /** How the R0 reference is chosen for the domain UI's response series. */
    protocol: VialBaselineProtocol;
    /** Wall-clock seconds of clean readings before the detector trusts a baseline. */
    warmupS: number;
    /** Seconds of the early series used as R0 by the UI transform. */
    r0WindowS: number;
  };
  transforms: {
    /** Host-supported conditioning steps. Today: median3. */
    conditioning: string[];
    response: VialResponseMode;
  };
  detection: {
    enabled: boolean;
    /** 0.1–10; >1 flags smaller deviations, <1 requires a larger difference. */
    sensitivity: number;
    /** Minimum channels that must clear their budget before a multivariate claim. */
    minChannels: number;
    /** Level-anchored threshold in calibrated sigma. 0 disables the level leg. */
    levelBudget: number;
    /** Rolling reference seconds for the level leg. 0 uses the fixed baseline. */
    levelRefS: number;
    /** Confidence floor for the Vial's own per-channel watch, 0–1. */
    alertThreshold: number;
    /** Per-channel absolute response limits in transformed units. */
    perChannelLimits: Record<string, number>;
    /** 0–0.95; how far the signal must fall below its peak before clearing. */
    hysteresis: number;
    escalation: {
      warningS: number;
      criticalS: number;
      emergencyS: number;
      resetNormalS: number;
    };
    /** Optional deployment budget. The profile is the lever; this records the target. */
    farTargetPerMonth: number | null;
  };
  admissibility: {
    /** The host refuses to arm before the baseline is ready by default. */
    requireBaseline: 'ready' | 'any';
    /** Minimum fraction of declared channels that must be live and non-dead. */
    minCoverage: number;
  };
}

export interface VialEvidenceSpec {
  grade: VialEvidenceGrade;
  /** Held-out report or dataset DOI/URL. Required for a reviewed listing. */
  reportUrl: string;
  /** ISO date the measurement was taken. */
  measuredAt: string;
  /** What corpus, rig, and preparation the numbers describe. */
  dataset: string;
  metrics: {
    /** Episode false alarms per month on the held-out period. */
    farPerMonth?: number;
    /** Median seconds from change onset to the first alert. */
    latencyS?: number;
    /** Minimum detectable effect, in transformed units. */
    mde?: number;
    /** Held-out samples scored. */
    nSamples?: number;
    /** Held-out change episodes. */
    nAlarms?: number;
  };
  /** Declarative cases the author runs with `noses test`. */
  fixtures: Array<{
    id: string;
    /** Relative JSON file beside the manifest. */
    file: string;
    /** The state the fixture must reach at the end. */
    expect: 'normal' | 'warning' | 'critical' | 'emergency';
  }>;
}

export const VIAL_PROFILE_DEFAULTS: VialAnomalyProfile = {
  baseline: {
    protocol: 'first-n',
    warmupS: 6,
    r0WindowS: 10,
  },
  transforms: {
    conditioning: [],
    response: 'delta-over-r0',
  },
  detection: {
    enabled: true,
    sensitivity: 1,
    minChannels: 1,
    levelBudget: 0,
    levelRefS: 0,
    alertThreshold: 0.5,
    perChannelLimits: {},
    hysteresis: 0,
    escalation: {
      warningS: 0.2,
      criticalS: 0.5,
      emergencyS: 1,
      resetNormalS: 2,
    },
    farTargetPerMonth: null,
  },
  admissibility: {
    requireBaseline: 'ready',
    minCoverage: 0.8,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  return typeof value === 'number' && Number.isFinite(value) ? value : NaN;
}

function asProtocol(value: unknown): VialBaselineProtocol {
  return (typeof value === 'string' ? value : '') as VialBaselineProtocol;
}

function asResponse(value: unknown): VialResponseMode {
  return (typeof value === 'string' ? value : '') as VialResponseMode;
}

/** Coerce an untrusted manifest block into the profile contract. Missing
 *  fields take the documented defaults; present but invalid values are kept as
 *  NaN so the validator refuses them instead of guessing a safer number. */
export function coerceAnomalyProfile(value: unknown): VialAnomalyProfile {
  const d = VIAL_PROFILE_DEFAULTS;
  if (!isRecord(value)) throw new Error('The anomaly profile must be an object.');
  if (value.baseline !== undefined && !isRecord(value.baseline)) throw new Error('anomaly.baseline must be an object.');
  if (value.transforms !== undefined && !isRecord(value.transforms)) throw new Error('anomaly.transforms must be an object.');
  if (value.detection !== undefined && !isRecord(value.detection)) throw new Error('anomaly.detection must be an object.');
  if (value.admissibility !== undefined && !isRecord(value.admissibility)) throw new Error('anomaly.admissibility must be an object.');
  const baseline = isRecord(value.baseline) ? value.baseline : {};
  const transforms = isRecord(value.transforms) ? value.transforms : {};
  const detection = isRecord(value.detection) ? value.detection : {};
  if (detection.escalation !== undefined && !isRecord(detection.escalation)) throw new Error('anomaly.detection.escalation must be an object.');
  if (detection.perChannelLimits !== undefined && !isRecord(detection.perChannelLimits)) throw new Error('anomaly.detection.perChannelLimits must be an object keyed by channel id.');
  if (detection.enabled !== undefined && typeof detection.enabled !== 'boolean') throw new Error('anomaly.detection.enabled must be true or false.');
  if (value.admissibility !== undefined && isRecord(value.admissibility)
      && value.admissibility.requireBaseline !== undefined
      && value.admissibility.requireBaseline !== 'ready'
      && value.admissibility.requireBaseline !== 'any') {
    throw new Error('anomaly.admissibility.requireBaseline must be ready or any.');
  }
  const escalation = isRecord(detection.escalation) ? detection.escalation : {};
  const admissibility = isRecord(value.admissibility) ? value.admissibility : {};
  const perChannelLimits: Record<string, number> = {};
  if (isRecord(detection.perChannelLimits)) {
    for (const [key, raw] of Object.entries(detection.perChannelLimits)) {
      perChannelLimits[key] = numberOr(raw, NaN);
    }
  }
  const conditioning = Array.isArray(transforms.conditioning)
    ? transforms.conditioning.map((x) => String(x))
    : [];
  const warningS = numberOr(escalation.warningS, d.detection.escalation.warningS);
  const criticalS = numberOr(escalation.criticalS, d.detection.escalation.criticalS);
  const emergencyS = numberOr(escalation.emergencyS, d.detection.escalation.emergencyS);
  return {
    baseline: {
      protocol: asProtocol(baseline.protocol),
      warmupS: numberOr(baseline.warmupS, d.baseline.warmupS),
      r0WindowS: numberOr(baseline.r0WindowS, d.baseline.r0WindowS),
    },
    transforms: {
      conditioning,
      response: asResponse(transforms.response),
    },
    detection: {
      enabled: detection.enabled !== false,
      sensitivity: numberOr(detection.sensitivity, d.detection.sensitivity),
      minChannels: numberOr(detection.minChannels, d.detection.minChannels),
      levelBudget: numberOr(detection.levelBudget, 0),
      levelRefS: numberOr(detection.levelRefS, 0),
      alertThreshold: numberOr(detection.alertThreshold, d.detection.alertThreshold),
      perChannelLimits,
      hysteresis: numberOr(detection.hysteresis, 0),
      escalation: {
        warningS,
        criticalS,
        emergencyS,
        resetNormalS: numberOr(escalation.resetNormalS, d.detection.escalation.resetNormalS),
      },
      farTargetPerMonth: detection.farTargetPerMonth === null || detection.farTargetPerMonth === undefined
        ? null
        : numberOr(detection.farTargetPerMonth, NaN),
    },
    admissibility: {
      requireBaseline: admissibility.requireBaseline === 'any' ? 'any' : 'ready',
      minCoverage: numberOr(admissibility.minCoverage, d.admissibility.minCoverage),
    },
  };
}

export interface ProfileValidation {
  errors: string[];
  warnings: string[];
}

/** What the host checks beyond schema shape. These are hard stops: a profile
 *  that cannot run safely is refused before it can arm a detector. */
export function validateAnomalyProfile(profile: VialAnomalyProfile): ProfileValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const b = profile.baseline;
  const t = profile.transforms;
  const d = profile.detection;
  const e = d.escalation;

  if (b.protocol !== 'first-n' && b.protocol !== 'session-mean') errors.push('baseline.protocol must be first-n or session-mean.');
  if (t.response !== 'delta-over-r0' && t.response !== 'relative' && t.response !== 'delta') errors.push('transforms.response must be delta-over-r0, relative, or delta.');
  for (const step of t.conditioning) {
    if (step !== 'median3') errors.push(`transforms.conditioning has an unsupported step: ${step}.`);
  }
  if (!(b.warmupS >= 0.5 && b.warmupS <= 86400)) errors.push('baseline.warmupS must be between 0.5 and 86400 seconds.');
  if (!(b.r0WindowS >= 0.5 && b.r0WindowS <= 3600)) errors.push('baseline.r0WindowS must be between 0.5 and 3600 seconds.');
  if (b.r0WindowS > b.warmupS) warnings.push('baseline.r0WindowS is longer than warmupS; the UI will use fewer early samples than declared.');
  if (!(d.sensitivity >= 0.1 && d.sensitivity <= 10)) errors.push('detection.sensitivity must be between 0.1 and 10.');
  if (!Number.isInteger(d.minChannels) || d.minChannels < 1 || d.minChannels > 32) errors.push('detection.minChannels must be an integer between 1 and 32.');
  if (!(d.levelBudget >= 0 && d.levelBudget <= 12)) errors.push('detection.levelBudget must be between 0 and 12 sigma.');
  if (!(d.levelRefS >= 0 && d.levelRefS <= 86400)) errors.push('detection.levelRefS must be between 0 and 86400 seconds.');
  if (d.levelRefS > 0 && d.levelBudget === 0) errors.push('detection.levelRefS needs a non-zero levelBudget.');
  if (!(d.alertThreshold >= 0 && d.alertThreshold <= 1)) errors.push('detection.alertThreshold must be between 0 and 1.');
  if (!(e.warningS > 0 && e.warningS <= 86400)) errors.push('detection.escalation.warningS must be between 0 and 86400 seconds.');
  if (!(e.criticalS >= e.warningS && e.criticalS <= 86400)) errors.push('detection.escalation.criticalS must be at least warningS and at most 86400 seconds.');
  if (!(e.emergencyS >= e.criticalS && e.emergencyS <= 86400)) errors.push('detection.escalation.emergencyS must be at least criticalS and at most 86400 seconds.');
  if (!(e.resetNormalS > 0 && e.resetNormalS <= 86400)) errors.push('detection.escalation.resetNormalS must be between 0 and 86400 seconds.');
  if (!(d.hysteresis >= 0 && d.hysteresis <= 0.95)) errors.push('detection.hysteresis must be between 0 and 0.95.');
  if (d.farTargetPerMonth !== null && !(d.farTargetPerMonth >= 0 && d.farTargetPerMonth <= 1e6)) errors.push('detection.farTargetPerMonth must be between 0 and 1,000,000.');
  if (profile.admissibility.requireBaseline !== 'ready' && profile.admissibility.requireBaseline !== 'any') errors.push('admissibility.requireBaseline must be ready or any.');
  if (!(profile.admissibility.minCoverage >= 0 && profile.admissibility.minCoverage <= 1)) errors.push('admissibility.minCoverage must be between 0 and 1.');
  for (const [channel, limit] of Object.entries(d.perChannelLimits)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(channel)) errors.push(`detection.perChannelLimits has an invalid channel id: ${channel}.`);
    if (!(limit > 0 && limit <= 1e9)) errors.push(`detection.perChannelLimits.${channel} must be between 0 and 1,000,000,000.`);
  }
  if (d.minChannels > Object.keys(d.perChannelLimits).length && Object.keys(d.perChannelLimits).length > 0) {
    warnings.push('detection.minChannels is larger than the number of declared per-channel limits; the host falls back to the engine vote.');
  }
  if (d.farTargetPerMonth === null) {
    warnings.push('No farTargetPerMonth is declared; the profile states no deployment false-alarm budget.');
  }
  if (e.warningS < 1) {
    warnings.push('Persistence (escalation.warningS) is under one second; a fast transient can become an alert. Declare the latency you actually need.');
  }
  return { errors, warnings };
}

export interface ProfileDetectorConfig {
  sensitivity: number;
  min_channels: number;
  level_budget: number;
  level_ref_s: number;
  warmup_s: number;
  warning_s: number;
  critical_s: number;
  emergency_s: number;
  reset_normal_s: number;
  hysteresis: number;
}

/** The subset of the host detection config a Vial may compile. The host
 *  supplies use_ukf, q_state, q_param, and the legacy fields. */
export function profileToDetectorConfig(profile: VialAnomalyProfile): ProfileDetectorConfig {
  const d = profile.detection;
  const e = d.escalation;
  return {
    sensitivity: d.sensitivity,
    min_channels: d.minChannels,
    level_budget: d.levelBudget,
    level_ref_s: d.levelRefS,
    warmup_s: profile.baseline.warmupS,
    warning_s: e.warningS,
    critical_s: e.criticalS,
    emergency_s: e.emergencyS,
    reset_normal_s: e.resetNormalS,
    hysteresis: d.hysteresis,
  };
}

/** A compact summary for the registry and the Vial header. */
export function profileSummary(profile: VialAnomalyProfile): string {
  const d = profile.detection;
  const e = d.escalation;
  const persistence = e.warningS >= 1 ? `${Math.round(e.warningS)} s` : `${e.warningS} s`;
  return `${persistence} persistence · ${d.minChannels}+ channels · ${d.sensitivity}× sensitivity · ${d.hysteresis > 0 ? `${Math.round(d.hysteresis * 100)}% hysteresis` : 'no hysteresis'}`;
}

/** Whether the profile is admissible on the current host state. The host
 *  applies this before it reports an alert: a profile that requires a ready
 *  baseline or a minimum channel coverage refuses to arm, rather than turning
 *  a missing channel or a warming baseline into a normal reading. */
export interface ProfileAdmissibility {
  admissible: boolean;
  reason: string | null;
}

export function profileAdmissibility(
  profile: VialAnomalyProfile,
  state: {
    baselineState: 'none' | 'warming' | 'ready' | 'stale';
    channelLive: Record<string, boolean>;
  },
): ProfileAdmissibility {
  if (profile.admissibility.requireBaseline === 'ready' && state.baselineState !== 'ready') {
    return { admissible: false, reason: 'The baseline is not ready.' };
  }
  const declared = Object.keys(profile.detection.perChannelLimits);
  if (declared.length) {
    const live = declared.filter((id) => state.channelLive[id] === true).length;
    const coverage = live / declared.length;
    if (coverage + 1e-9 < profile.admissibility.minCoverage) {
      return {
        admissible: false,
        reason: `Channel coverage ${Math.round(coverage * 100)}% is below the profile's ${Math.round(profile.admissibility.minCoverage * 100)}% minimum.`,
      };
    }
  }
  return { admissible: true, reason: null };
}
