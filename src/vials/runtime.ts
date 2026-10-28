/**
 * Vial Runtime - Host API implementation
 * Provides the VialHost interface to vials running in iframes
 */

import type { VialHost, VialChannel, VialLiveReading, VialBaseline, VialEvent, VialCapabilities } from './host';

export class VialRuntime implements VialHost {
  version = '1.0.0';
  capabilities: VialCapabilities = {
    readLive: true,
    readBaseline: true,
    logEvents: true,
    persist: true,
    requestAction: true,
    exportData: true,
  };

  private vialId: string;
  private listeners: Map<string, Set<Function>> = new Map();
  private events: VialEvent[] = [];
  private storageKey: string;

  constructor(vialId: string) {
    this.vialId = vialId;
    this.storageKey = `osmograph.vial.data.${vialId}`;
    this.loadEvents();
  }

  getLiveReadings(): VialLiveReading | null {
    // Access host state from global
    const hostState = (window as any).__OSMOGRAPH_HOST_STATE__;
    if (!hostState || !hostState.readings || hostState.readings.length === 0) {
      return null;
    }
    return {
      timestamp: Date.now(),
      channels: hostState.readings,
      channelsMeta: hostState.channels || [],
      env: hostState.env,
    };
  }

  getChannels(): VialChannel[] {
    const hostState = (window as any).__OSMOGRAPH_HOST_STATE__;
    if (!hostState || !hostState.channelMeta) return [];
    return hostState.channelMeta.map((m: any, i: number) => ({
      index: i,
      name: m.name || `CH${i + 1}`,
      kind: m.kind,
    }));
  }

  getBaseline(): VialBaseline | null {
    const hostState = (window as any).__OSMOGRAPH_HOST_STATE__;
    if (!hostState || !hostState.baseline) return null;
    return {
      channels: hostState.baseline,
      timestamp: hostState.baselineTimestamp || Date.now(),
    };
  }

  getRecentReadings(count: number = 100): VialLiveReading[] {
    const buffer = (window as any).__OSMOGRAPH_READINGS_BUFFER__ || [];
    return buffer.slice(-count).map((r: any) => ({
      timestamp: r.timestamp,
      channels: r.channels,
      channelsMeta: r.channelsMeta,
    }));
  }

  on(event: string, callback: Function): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
    return () => this.off(event, callback);
  }

  off(event: string, callback: Function): void {
    this.listeners.get(event)?.delete(callback);
  }

  emit(event: string, data: any): void {
    this.listeners.get(event)?.forEach(cb => {
      try {
        cb(data);
      } catch (e) {
        console.error('Vial listener error:', e);
      }
    });
  }

  async logEvent(type: string, message: string, data?: any): Promise<VialEvent> {
    const event: VialEvent = {
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type,
      message,
      data,
      timestamp: Date.now(),
    };
    this.events.push(event);
    this.saveEvents();
    this.emit('event', event);
    return event;
  }

  async getEvents(limit: number = 100): Promise<VialEvent[]> {
    return this.events.slice(-limit);
  }

  async clearEvents(): Promise<void> {
    this.events = [];
    this.saveEvents();
  }

  private loadEvents(): void {
    try {
      const data = localStorage.getItem(`${this.storageKey}.events`);
      if (data) this.events = JSON.parse(data);
    } catch {}
  }

  private saveEvents(): void {
    try {
      localStorage.setItem(`${this.storageKey}.events`, JSON.stringify(this.events.slice(-1000)));
    } catch {}
  }

  async persist(key: string, value: any): Promise<void> {
    try {
      const data = JSON.parse(localStorage.getItem(this.storageKey) || '{}');
      data[key] = value;
      localStorage.setItem(this.storageKey, JSON.stringify(data));
    } catch (e) {
      throw new Error(`Failed to persist: ${e}`);
    }
  }

  async retrieve(key: string): Promise<any> {
    try {
      const data = JSON.parse(localStorage.getItem(this.storageKey) || '{}');
      return data[key];
    } catch {
      return undefined;
    }
  }

  async requestAction(action: string, params?: any): Promise<any> {
    // Dispatch to host
    const host = (window as any).__OSMOGRAPH_VIAL_HOST_BRIDGE__;
    if (host && typeof host.requestAction === 'function') {
      return host.requestAction(action, params);
    }
    throw new Error('Host does not support requestAction');
  }

  computeMovingAverage(values: number[], window: number): number[] {
    if (window <= 0 || values.length === 0) return values;
    const result: number[] = [];
    for (let i = 0; i < values.length; i++) {
      const start = Math.max(0, i - Math.floor(window / 2));
      const end = Math.min(values.length, i + Math.ceil(window / 2));
      const slice = values.slice(start, end);
      const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
      result.push(avg);
    }
    return result;
  }

  computeDerivative(values: number[], window: number = 1): number[] {
    if (values.length < 2) return [];
    const result: number[] = [];
    for (let i = window; i < values.length; i++) {
      const d = (values[i] - values[i - window]) / window;
      result.push(d);
    }
    return result;
  }

  computeRateOfChange(readings: VialLiveReading[], channelIndex: number, windowMs: number = 10000): number {
    if (readings.length < 2) return 0;
    const now = readings[readings.length - 1].timestamp;
    const recent = readings.filter(r => now - r.timestamp <= windowMs);
    if (recent.length < 2) return 0;
    const first = recent[0].channels[channelIndex] || 0;
    const last = recent[recent.length - 1].channels[channelIndex] || 0;
    const dt = (recent[recent.length - 1].timestamp - recent[0].timestamp) / 1000;
    if (dt === 0) return 0;
    return (last - first) / dt;
  }

  async exportJournal(format: 'json' | 'csv' = 'json'): Promise<string> {
    if (format === 'csv') {
      const headers = 'id,type,message,timestamp\n';
      const rows = this.events.map(e => 
        `${e.id},${e.type},"${e.message.replace(/"/g, '""')}",${e.timestamp}`
      ).join('\n');
      return headers + rows;
    }
    return JSON.stringify(this.events, null, 2);
  }
}

export function injectVialHost(vialId: string): void {
  const runtime = new VialRuntime(vialId);
  (window as any).__OSMOGRAPH_VIAL_HOST__ = runtime;
}
