/**
 * Vial Host SDK types
 * 
 * This interface defines what vials can do when running inside the Osmograph host.
 * Vials receive the host via `window.__OSMOGRAPH_VIAL_HOST__` or through postMessage.
 */
export interface VialChannel {
  index: number;
  name: string;
  kind?: string;
  unit?: string;
}

export interface VialLiveReading {
  timestamp: number;
  channels: number[];
  channelsMeta?: VialChannel[];
  env?: {
    temperature?: number;
    humidity?: number;
    pressure?: number;
  };
}

export interface VialBaseline {
  channels: number[];
  timestamp: number;
}

export interface VialEvent {
  id: string;
  type: string;
  message: string;
  data?: any;
  timestamp: number;
}

export interface VialCapabilities {
  readLive: boolean;
  readBaseline: boolean;
  logEvents: boolean;
  persist: boolean;
  requestAction: boolean;
  exportData: boolean;
}

/** Per-channel evidence the host computes from the live stream. A Vial may
 *  read these to judge a response against the channel's own noise. */
export interface VialChannelLimit {
  dead: boolean;
  /** Coefficient of variation (std / |mean|) of the raw channel window. */
  cv: number;
  min: number;
  max: number;
  /** The live reference value, or null when the host has not set one. */
  r0: number | null;
}

export interface VialDetectionVerdict {
  active: boolean;
  triggeredChannels: string[];
  admissible?: boolean;
  reason?: string | null;
}

/** The host-applied window: raw values, a settled fingerprint, and (when the
 *  profile declares transforms) a baseline-relative response per channel. */
export interface VialSeriesWindow {
  source: 'live' | 'recording' | 'none';
  label: string;
  channels: string[];
  time: number[];
  timeUnit: 's' | 'sample';
  values: Array<Array<number | null>>;
  fingerprint: Array<number | null>;
  evolution: { bins: number; values: Array<Array<number | null>>; maxAbs: number } | null;
  response: {
    baseline: 'first-n' | 'session-mean';
    response: 'delta-over-r0' | 'relative' | 'delta';
    conditioning: string[];
    values: Array<Array<number | null>>;
  } | null;
}

/** The only live state a Vial may depend on. Read-only; the host owns it. */
export interface VialSnapshot {
  takenAt: number;
  source: 'live' | 'replay' | 'dataset' | 'none';
  samplingMode: 'timeseries' | 'trial' | 'unknown';
  channels: Array<{ id: string; label: string; kind: string; unit?: string; health?: string }>;
  environment: { temperature: number | null; humidity: number | null } | null;
  baseline: { state: 'none' | 'warming' | 'ready' | 'stale'; progress: number; ageSec: number | null };
  anomaly: {
    state: 'unknown' | 'normal' | 'warning' | 'critical';
    score: number | null;
    confidence: number | null;
    alertLevel: number;
    triggeredChannels: number;
    consecutive: number;
  };
  channelLimits: Record<string, VialChannelLimit>;
  detection: VialDetectionVerdict | null;
  transformsApplied: string[];
  trajectory: Array<{ at: number; values: Record<string, number> }>;
}

export interface VialHost {
  version: string;
  capabilities: VialCapabilities;
  
  // Data access
  getLiveReadings(): VialLiveReading | null;
  getChannels(): VialChannel[];
  getBaseline(): VialBaseline | null;
  getRecentReadings(count?: number): VialLiveReading[];
  /** The full host snapshot: channel health, baseline, detection verdict,
   *  per-channel limits, environment, and transforms. */
  getSnapshot(): VialSnapshot | null;
  /** The host-applied window, including the baseline-relative response the
   *  profile declares. Null until a window exists. */
  getSeries(): VialSeriesWindow | null;
  
  // Event subscription
  on(event: 'tick' | 'data' | 'connect' | 'disconnect', callback: (data: any) => void): () => void;
  off(event: string, callback: Function): void;
  
  // Vial state
  logEvent(type: string, message: string, data?: any): Promise<VialEvent>;
  getEvents(limit?: number): Promise<VialEvent[]>;
  clearEvents(): Promise<void>;
  
  // Persistence (scoped to vial)
  persist(key: string, value: any): Promise<void>;
  retrieve(key: string): Promise<any>;
  
  // Actions
  requestAction(action: string, params?: any): Promise<any>;
  
  // Utilities
  computeMovingAverage(values: number[], window: number): number[];
  computeDerivative(values: number[], window?: number): number[];
  computeRateOfChange(readings: VialLiveReading[], channelIndex: number, windowMs?: number): number;
  
  // Export
  exportJournal(format?: 'json' | 'csv'): Promise<string>;
}

declare global {
  interface Window {
    __OSMOGRAPH_VIAL_HOST__?: VialHost;
  }
}

export {};
