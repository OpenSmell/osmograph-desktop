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

export interface VialHost {
  version: string;
  capabilities: VialCapabilities;
  
  // Data access
  getLiveReadings(): VialLiveReading | null;
  getChannels(): VialChannel[];
  getBaseline(): VialBaseline | null;
  getRecentReadings(count?: number): VialLiveReading[];
  
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
