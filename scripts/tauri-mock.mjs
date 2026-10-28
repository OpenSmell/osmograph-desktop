// Shared Tauri IPC mock for the UI harness and ad-hoc probes.
// Fixtures mirror the Rust command contract closely enough to exercise real
// UI paths (live stream, detection, phenotype, session index).

const CH = ['MQ-135', 'MQ-3', 'MQ-6', 'MQ-7', 'MQ-4', 'MQ-8'];
const now = Date.now();

export const MOCK = String.raw`
(() => {
  const CH = ${JSON.stringify(CH)};
  const NOW = ${now};
  const listeners = new Map();   // event -> Set(handlerId)
  const callbacks = new Map();   // id -> fn
  let nextId = 1;

  const mkSeries = (base, jitter, label = 'coffee') => {
    // Time is RELATIVE seconds from the start of the recording, matching the
    // Rust load_session_series contract (relative_seconds).
    const n = 450;
    const time = Array.from({ length: n }, (_, i) => i * 0.1);
    const values = CH.map((_, ci) => {
      const r0 = base + ci * 320;
      // baseline 0-18s, exposure ramp 18-38s, recovery 38-60s
      return time.map((_, i) => {
        const s = i * 0.1;
        let resp = 0;
        if (s >= 18 && s < 38) resp = (0.05 + ci * 0.035) * (1 - Math.exp(-(s - 18) / 2.5));
        else if (s >= 38) resp = (0.05 + ci * 0.035) * Math.exp(-(s - 38) / 9);
        const noise = (Math.sin(i * 1.7 + ci * 2.1) + Math.cos(i * 0.37 + ci)) * jitter;
        return r0 * (1 + resp) + noise;
      });
    });
    return { label, channels: CH.slice(), time, values };
    void jitter;
  };

  const sessions = [
    { file_id: 'h1', substance: 'coffee', label: 'coffee', timestamp: (NOW - 3_600_000) / 1000, duration_sec: 60, sensor_count: 6, quality: 82, csv_path: '/tmp/opencode/ui/coffee.csv', quality_report: null },
    { file_id: 'h2', substance: 'mint', label: 'mint', timestamp: (NOW - 10_800_000) / 1000, duration_sec: 60, sensor_count: 6, quality: 74, csv_path: '/tmp/opencode/ui/mint.csv', quality_report: null },
    { file_id: 'h3', substance: 'ethanol', label: 'ethanol', timestamp: (NOW - 93_600_000) / 1000, duration_sec: 60, sensor_count: 6, quality: 68, csv_path: '/tmp/opencode/ui/ethanol.csv', quality_report: null },
  ];

  const playground = { file_id: 'playground', substance: 'apple (SmellNet)', label: 'SmellNet apple \u00b7 playground', timestamp: NOW / 1000, duration_sec: 60, sensor_count: 6, quality: 74, csv_path: '/tmp/opencode/ui/playground.csv', quality_report: null };

  const health = CH.map((_, i) => ({
    channel: i, health_score: (92 - i * 3) / 100, mean: 2000 + i * 320, std: 12 + i,
    cv: 0.006 + i * 0.001, noise_floor: 10 + i, drift_rate: 0.0008,
    stuck: false, status: i === 4 ? 'WARNING' : 'OK',
    recommendation: i === 4 ? 'Noise above the rig median — check wiring.' : 'Healthy.',
  }));

  const emit = (event, payload) => {
    const ids = listeners.get(event);
    if (!ids) return;
    for (const id of ids) {
      const cb = callbacks.get(id);
      if (cb) { try { cb({ event, id: 0, payload }); } catch (e) { console.error('listener error', event, e); } }
    }
  };
  window.__MOCK_EMIT = emit;

  const ok = (v) => Promise.resolve(v);
  const handle = (cmd, a) => {
    switch (cmd) {
      case 'plugin:event|listen': {
        const set = listeners.get(a.event) || new Set();
        set.add(a.handler);
        listeners.set(a.event, set);
        return ok(1);
      }
      case 'plugin:event|unlisten': {
        listeners.get(a.event)?.delete(a.handler);
        return ok(null);
      }
      case 'plugin:app|version': return ok('0.1.1');
      case 'plugin:os|platform': return ok('linux');
      case 'get_data_dir': return ok('/tmp/opencode/ui/data');
      case 'get_recordings_dir': return ok('/tmp/opencode/ui/data/recordings');
      case 'dataset_dir': return ok('/tmp/opencode/ui/data/datasets');
      case 'dataset_collections': return ok([]);
      case 'dataset_recover_archives': return ok([]);
      case 'dataset_extract': return ok([]);
      case 'dataset_write_manifest': return ok(null);
      case 'dataset_verify': return ok({ folder: a.destName || '', root: '', ok: true, checked: 0, missing: [], changed: [], extra: [], manifest_hash: '' });
      case 'import_paths': return ok([]);
      case 'set_collection_hidden': return ok(null);
      case 'get_session_index': return ok(self.playgroundInstalled ? [...sessions, playground] : sessions);
      case 'install_playground_sample': self.playgroundInstalled = true; return ok(playground);
      case 'import_recordings': return ok(0);
      case 'load_session_series': {
        if (a.fileId === 'playground') return ok(mkSeries(1800, 2.5, 'apple (SmellNet)'));
        const i = ['h1', 'h2', 'h3'].indexOf(a.fileId);
        return ok(mkSeries(1800 + (i < 0 ? 0 : i) * 150, 2.5, sessions[i]?.substance || 'coffee'));
      }
      case 'assess_recording_health': return ok(health);
      case 'get_sensor_health': return ok(health);
      case 'list_serial_ports': return ok([{ name: '/dev/ttyACM0', description: 'Harness rig (mock)', kind: 'serial', hw_type: 'usb', manufacturer: 'OpenSmell' }]);
      case 'open_https_url': (window.__MOCK_OPENED = window.__MOCK_OPENED || []).push(a.url); return ok(null);
      case 'connect_serial': return ok(null);
      case 'disconnect_serial': return ok(null);
      case 'get_phase_recorder_state': return ok({ active: false, phase: 'idle', phase_name: '', elapsed_sec: 0, remaining_sec: 0, sample_count: 0, phases: [] });
      case 'load_live_classifier': return ok(null);
      case 'list_classifiers': return ok([]);
      case 'check_for_updates': return ok({ available: false });
      case 'fleet_scan': return ok({ devices: [] });
      case 'hub_list': return ok([]);
      case 'hf_has_token': return ok(false);
      case 'burnin_status': return ok({ total_hours: 24, elapsed_seconds: 0, remaining_seconds: 86400, remaining_hours: 24, is_complete: false, running: false });
      case 'ingest_reading_with_failsafe': {
        self.detN = (self.detN || 0) + 1;
        const warming = self.detN <= 40;
        const isAnom = !warming && self.detN > 90;
        return ok({
          is_anomaly: isAnom, raw_score: isAnom ? 3.4 : 0.5,
          calibrated_confidence: isAnom ? 0.84 : 0.12,
          triggered_channels: isAnom ? [1, 2, 3] : [],
          alert_level: isAnom ? 1 : 0, alert_name: isAnom ? 'warning' : 'normal',
          consecutive_anomalies: isAnom ? 4 : 0,
          warming_up: warming, baseline_progress: Math.min(1, self.detN / 40),
        });
      }
      case 'detection_get_config': return ok({ smoothing_alpha: 0.6, drift_alpha: 0.002, sensitivity: 1.0 });
      case 'detection_set_config': return ok(null);
      case 'vial_detection_set_config': return ok(null);
      case 'vial_detection_reset': return ok(null);
      case 'vial_detection_ingest': {
        self.vialDetN = (self.vialDetN || 0) + 1;
        const warming = self.vialDetN <= 40;
        const isAnom = !warming && self.vialDetN > 90;
        return ok({
          is_anomaly: isAnom, anomaly_votes: isAnom ? 3 : 0,
          max_confidence: isAnom ? 0.84 : 0.12,
          raw_score: isAnom ? 3.4 : 0.5,
          calibrated_confidence: isAnom ? 0.84 : 0.12,
          triggered_channels: isAnom ? [1, 2, 3] : [],
          max_delta: isAnom ? 0.12 : 0.01, alert_level: isAnom ? 1 : 0,
          alert_name: isAnom ? 'warning' : 'normal', consecutive_anomalies: isAnom ? 4 : 0,
          anomalous_seconds: isAnom ? 1.2 : 0, sensor_failures: [], degraded_sensors: [],
          warming_up: warming, baseline_progress: Math.min(1, self.vialDetN / 40), smoothed: CH,
        });
      }
      case 'compute_phenotype': return ok({
        has_data: self.detN > 20, n_channels: 6, reference_geometry: true,
        per_channel: CH.map((_, i) => ({ channel: i, direction: i < 4 ? 'reducing' : 'oxidizing', delta: 0.12 + i * 0.02, cv: 0.01 + i * 0.002 })),
        a1: { valence: 'reducing', summary: '4 of 6 channels fall — the array is seeing a reducing plume.' },
        a2: { rise: 'fast', recovery: 'partial', rise_fraction: 0.72, recovery_observed: true, summary: 'Rise inside 3 s; recovery is still open at the end of the window.' },
        a3: { fingerprint: [], assignable: true, reason: '', response_type: 'rising', measured_membership: '2-cluster reference', percept: null, plain_language: 'A slow, partial recovery.', confidence: 'moderate', nearest_distance: 0.84 },
        protocol: { recording: false, current_phase: 'idle', phase_label: 'Idle', instruction: 'Start a recording to run the protocol.', complete: false, note: '' },
        boundaries_cannot: ['Identify the compound', 'Give a ppm without calibration'],
        caveat: 'Descriptors are array-relative, not absolute chemistry.',
      });
      case 'recover_phase_sessions': return ok([]);
      case 'list_recent_events': return ok([]);
      case 'get_change_log': return ok([]);
      default: return ok(null);
    }
  };

  window.__TAURI_INTERNALS__ = {
    callbacks,
    transformCallback(cb, once = false) {
      const id = nextId++;
      callbacks.set(id, once ? (...x) => { callbacks.delete(id); cb(...x); } : cb);
      return id;
    },
    invoke: (cmd, a) => handle(cmd, a),
    convertFileSrc: (p) => p,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  };
})();
`;
