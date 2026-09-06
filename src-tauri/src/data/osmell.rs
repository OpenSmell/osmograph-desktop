//! Phase-aware `.osmell` recorder — before / during / after protocol.
//!
//! Mirrors `Osmograph/data/osmell_recorder.py` and the `.osmell` bundle format
//! of `opensmell/opensmell/{io,types}.py` (itself a 1:1 mirror of
//! `osmograph-web/lib/osmell/io.ts`). Records three phases
//! (baseline -> exposure -> recovery), detects dead channels by
//! coefficient-of-variation, and writes only active channels to a portable
//! `.osmell` bundle. Falls back to CSV when the bundle can't be written.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::journal::{self, AppendJournal, JournalSession};
use super::{now_secs, sanitize_label};

pub const DEAD_CV_THRESHOLD: f64 = 0.001;
pub const PHASE_BASELINE: &str = "baseline";
pub const PHASE_EXPOSURE: &str = "exposure";
pub const PHASE_RECOVERY: &str = "recovery";
pub const PHASE_ORDER: [&str; 3] = [PHASE_BASELINE, PHASE_EXPOSURE, PHASE_RECOVERY];

pub const PHASE_LABELS: [(&str, &str); 3] = [
    (PHASE_BASELINE, "Before"),
    (PHASE_EXPOSURE, "During"),
    (PHASE_RECOVERY, "After"),
];
pub const PHASE_COLORS: [(&str, &str); 3] = [
    (PHASE_BASELINE, "#4a9eff"),
    (PHASE_EXPOSURE, "#ef4444"),
    (PHASE_RECOVERY, "#34d399"),
];
pub const PHASE_INSTRUCTIONS: [(&str, &str); 3] = [
    (PHASE_BASELINE, "Keep sensors in clean air — let readings stabilise."),
    (PHASE_EXPOSURE, "Introduce the substance near the sensors."),
    (PHASE_RECOVERY, "Remove the substance — let sensors recover."),
];

pub const OSMELL_FORMAT_VERSION: &str = "1.0.0";

/// Default phase durations in seconds (Python `osmell_recorder.py:87-89`).
pub const DEFAULT_BASELINE_SEC: f64 = 30.0;
pub const DEFAULT_EXPOSURE_SEC: f64 = 60.0;
pub const DEFAULT_RECOVERY_SEC: f64 = 30.0;

fn channel_id(index: usize, names: &[String]) -> String {
    names
        .get(index)
        .cloned()
        .unwrap_or_else(|| format!("CH{}", index + 1))
}

/// Phase name -> human-facing label lookup (before/during/after).
pub fn phase_label(name: &str) -> &str {
    PHASE_LABELS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, l)| *l)
        .unwrap_or(name)
}

/// Phase name -> UI accent color lookup.
pub fn phase_color(name: &str) -> &str {
    PHASE_COLORS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, c)| *c)
        .unwrap_or("#ffffff")
}

/// Phase name -> instruction copy lookup.
pub fn phase_instruction(name: &str) -> &str {
    PHASE_INSTRUCTIONS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, t)| *t)
        .unwrap_or("")
}

/// One accumulation buffer for a single phase.
pub struct Phase {
    name: &'static str,
    duration_sec: f64,
    start_time: Option<f64>,
    timestamps_ms: Vec<f64>,
    samples: Vec<Vec<f64>>,
}

impl Phase {
    fn new(name: &'static str, duration_sec: f64) -> Self {
        Self {
            name,
            duration_sec,
            start_time: None,
            timestamps_ms: Vec::new(),
            samples: Vec::new(),
        }
    }

    fn elapsed_at(&self, now: f64) -> f64 {
        match self.start_time {
            Some(t) => now - t,
            None => 0.0,
        }
    }

    fn is_complete_at(&self, now: f64) -> bool {
        self.start_time.is_some() && self.elapsed_at(now) >= self.duration_sec
    }

    fn sample_count(&self) -> usize {
        self.samples.len()
    }
}

/// Phase-aware recorder. Call `write_sample` for every incoming reading.
///
/// Lifecycle (Python parity):
///   recorder.configure(...)    optional — set durations / preset
///   recorder.start(label)      begin baseline phase
///   recorder.write_sample(arr) feed samples; auto-advances phases
///   recorder.stop_and_save()   force-finish early (or let phases complete)
///   recorder.cancel()          abort without saving
pub struct OsmellRecorder {
    save_dir: PathBuf,
    baseline_sec: f64,
    exposure_sec: f64,
    recovery_sec: f64,
    n_sensors: usize,
    preset_name: String,
    /// Per-channel display names (e.g. `["MQ-135","MQ-3","CH3"]`), used for
    /// manifest and CSV headers instead of the old hardcoded VOC/Alcohol table.
    channel_names: Vec<String>,

    label: String,
    rec_start: Option<f64>,
    phases: Vec<Phase>,
    phase_idx: usize,
    active: bool,
    saved_path: Option<PathBuf>,
    /// Append-only `.journal` (see `journal.rs`) that mirrors every sample to
    /// disk the moment it arrives, so a crash mid-recording loses nothing.
    journal: Option<AppendJournal>,
}

impl OsmellRecorder {
    pub fn new(save_dir: PathBuf) -> Self {
        Self {
            save_dir,
            baseline_sec: DEFAULT_BASELINE_SEC,
            exposure_sec: DEFAULT_EXPOSURE_SEC,
            recovery_sec: DEFAULT_RECOVERY_SEC,
            n_sensors: 6,
            preset_name: String::new(),
            channel_names: Vec::new(),
            label: String::new(),
            rec_start: None,
            phases: Vec::new(),
            phase_idx: 0,
            active: false,
            saved_path: None,
            journal: None,
        }
    }

    pub fn configure(
        &mut self,
        baseline_sec: f64,
        exposure_sec: f64,
        recovery_sec: f64,
        n_sensors: usize,
        preset_name: &str,
    ) {
        self.baseline_sec = baseline_sec;
        self.exposure_sec = exposure_sec;
        self.recovery_sec = recovery_sec;
        self.n_sensors = n_sensors.max(1);
        self.preset_name = preset_name.to_string();
    }

    /// Set the live per-channel display names (any count — the recorded
    /// manifest/CSV reflects the device the user actually connected).
    pub fn set_channel_names(&mut self, names: &[String]) {
        self.channel_names = names
            .iter()
            .map(|n| if n.trim().is_empty() { "".into() } else { n.trim().into() })
            .collect();
    }

    fn channel_id(&self, index: usize) -> String {
        channel_id(index, &self.channel_names)
    }

    pub fn set_save_dir(&mut self, path: PathBuf) {
        self.save_dir = path;
    }

    pub fn is_recording(&self) -> bool {
        self.active
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn preset_name(&self) -> &str {
        &self.preset_name
    }

    pub fn file_path(&self) -> Option<&Path> {
        self.saved_path.as_deref()
    }

    pub fn current_phase(&self) -> Option<&str> {
        self._cur().map(|p| p.name)
    }

    pub fn current_phase_elapsed(&self) -> f64 {
        self._cur().map(|p| p.elapsed_at(now_secs())).unwrap_or(0.0)
    }

    pub fn current_phase_duration(&self) -> f64 {
        self._cur().map(|p| p.duration_sec).unwrap_or(0.0)
    }

    pub fn phase_progress(&self) -> f64 {
        match self._cur() {
            Some(p) if p.duration_sec > 0.0 => {
                (p.elapsed_at(now_secs()) / p.duration_sec).min(1.0)
            }
            _ => 0.0,
        }
    }

    pub fn total_elapsed(&self) -> f64 {
        match self.rec_start {
            Some(t) => now_secs() - t,
            None => 0.0,
        }
    }

    pub fn total_duration(&self) -> f64 {
        self.baseline_sec + self.exposure_sec + self.recovery_sec
    }

    pub fn total_progress(&self) -> f64 {
        let d = self.total_duration();
        if d > 0.0 {
            (self.total_elapsed() / d).min(1.0)
        } else {
            0.0
        }
    }

    /// Per-phase state snapshot for the UI (name, duration, sample count).
    pub fn phase_snapshots(&self) -> Vec<PhaseSnapshot> {
        self.phases
            .iter()
            .map(|p| PhaseSnapshot {
                name: p.name.to_string(),
                duration_sec: p.duration_sec,
                sample_count: p.sample_count(),
            })
            .collect()
    }

    fn _cur(&self) -> Option<&Phase> {
        if self.active && self.phase_idx < self.phases.len() {
            Some(&self.phases[self.phase_idx])
        } else {
            None
        }
    }

    // ---- lifecycle (wall clock) ----

    pub fn start(&mut self, label: &str) {
        self.start_at(label, now_secs());
        // Open the crash-safe journal on the real-clock path only. `start_at`
        // (used by tests with injected clocks) stays journal-free.
        self.journal = AppendJournal::open(
            &self.save_dir,
            label,
            &self.preset_name,
            now_secs() * 1000.0,
            self.baseline_sec,
            self.exposure_sec,
            self.recovery_sec,
            self.n_sensors,
            &self.channel_names,
        )
        .ok();
    }

    pub fn write_sample(&mut self, sensor_values: &[f64]) {
        self.write_sample_at(sensor_values, now_secs());
    }

    pub fn check_phase_advance(&mut self) -> bool {
        self.check_phase_advance_at(now_secs())
    }

    pub fn cancel(&mut self) {
        self.active = false;
        self.phases.clear();
        self._finish_journal();
        log::info!("OsmellRecorder cancelled");
    }

    pub fn stop_and_save(&mut self) -> Option<PathBuf> {
        if !self.active {
            return self.saved_path.clone();
        }
        self.active = false;
        let result = self._build_and_write();
        self._finish_journal();
        result
    }

    // ---- lifecycle (injected clock, used by tests) ----

    fn start_at(&mut self, label: &str, now: f64) {
        self.label = label.to_string();
        self.rec_start = Some(now);
        self.phase_idx = 0;
        self.active = true;
        self.saved_path = None;
        self.phases = vec![
            Phase::new(PHASE_ORDER[0], self.baseline_sec),
            Phase::new(PHASE_ORDER[1], self.exposure_sec),
            Phase::new(PHASE_ORDER[2], self.recovery_sec),
        ];
        self.phases[0].start_time = Some(now);
        log::info!(
            "OsmellRecorder started: '{}' (baseline={:.0}s / exposure={:.0}s / recovery={:.0}s)",
            label,
            self.baseline_sec,
            self.exposure_sec,
            self.recovery_sec
        );
    }

    fn write_sample_at(&mut self, sensor_values: &[f64], now: f64) {
        if !self.active {
            return;
        }
        let Some(rec_start) = self.rec_start else { return };
        let p = match self._cur() {
            Some(p) => p,
            None => return,
        };
        if p.start_time.is_none() {
            return;
        }

        let elapsed_ms = (now - rec_start) * 1000.0;
        let vals: Vec<f64> = (0..self.n_sensors)
            .map(|i| sensor_values.get(i).copied().unwrap_or(f64::NAN))
            .collect();
        if let Some(j) = self.journal.as_mut() {
            let phase = self.phases[self.phase_idx].name;
            let _ = j.append(elapsed_ms, phase, &vals);
        }
        let p = &mut self.phases[self.phase_idx];
        p.timestamps_ms.push(elapsed_ms);
        p.samples.push(vals);

        if p.is_complete_at(now) {
            self._advance_phase_at(now);
        }
    }

    fn check_phase_advance_at(&mut self, now: f64) -> bool {
        if !self.active {
            return false;
        }
        let complete = match self._cur() {
            Some(p) => p.is_complete_at(now),
            None => false,
        };
        if complete {
            self._advance_phase_at(now);
            return true;
        }
        false
    }

    fn _advance_phase_at(&mut self, now: f64) {
        self.phase_idx += 1;
        if self.phase_idx >= self.phases.len() {
            self.active = false;
            self._build_and_write();
            self._finish_journal();
            return;
        }
        let p = &mut self.phases[self.phase_idx];
        p.start_time = Some(now);
        log::info!("OsmellRecorder phase -> {}", p.name);
    }

    /// Drop the append-only journal now that the session reached a final state
    /// (saved or cancelled) — the data lives in the `.osmell`/CSV or is gone.
    fn _finish_journal(&mut self) {
        if let Some(mut j) = self.journal.take() {
            j.flush();
            j.finish_ok();
        }
    }

    // ---- bundle building ----

    fn _build_and_write(&mut self) -> Option<PathBuf> {
        let mut all_ts: Vec<f64> = Vec::new();
        let mut all_vals: Vec<Vec<f64>> = Vec::new();
        let mut from_phase: Vec<&str> = Vec::new();

        for p in &self.phases {
            for (ts, v) in p.timestamps_ms.iter().zip(p.samples.iter()) {
                all_ts.push(*ts);
                all_vals.push(v.clone());
                from_phase.push(p.name);
            }
        }

        if all_vals.is_empty() {
            log::warn!("OsmellRecorder: no samples collected");
            return None;
        }

        let n_rows = all_vals.len();
        let n_cols = all_vals[0].len();

        // Dead-channel detection: keep channels whose CV exceeds the threshold.
        let mut active_idx: Vec<usize> = Vec::new();
        for i in 0..n_cols {
            let col: Vec<f64> = all_vals
                .iter()
                .filter_map(|row| row.get(i).copied().filter(|v| v.is_finite()))
                .collect();
            if col.is_empty() {
                continue;
            }
            let mean = col.iter().sum::<f64>() / col.len() as f64;
            let variance =
                col.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / col.len() as f64;
            let std = variance.sqrt();
            let cv = if mean.abs() > 1e-9 {
                std / mean.abs()
            } else {
                0.0
            };
            if cv > DEAD_CV_THRESHOLD {
                active_idx.push(i);
            }
        }
        if active_idx.is_empty() {
            active_idx = (0..n_cols).collect();
            log::warn!("All channels appear dead — retaining all");
        }

        let dead_ids: Vec<String> = (0..n_cols)
            .filter(|i| !active_idx.contains(i))
            .map(|i| self.channel_id(i))
            .collect();
        let channel_ids: Vec<String> = active_idx.iter().map(|&i| self.channel_id(i)).collect();

        // Sampling-rate estimate from the median inter-sample gap (Hz).
        let mut sr_hz = 2.0;
        if all_ts.len() > 1 {
            let mut diffs: Vec<f64> = all_ts.windows(2).map(|w| w[1] - w[0]).collect();
            diffs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let med_ms = diffs[diffs.len() / 2];
            if med_ms > 0.0 {
                sr_hz = ((1000.0 / med_ms) * 100.0).round() / 100.0;
            }
        }

        // Events: one SessionEvent per phase at its first timestamp.
        let mut events: Vec<Value> = Vec::new();
        let mut seen: Vec<&str> = Vec::new();
        for (phase_name, ts_ms) in from_phase.iter().zip(all_ts.iter()) {
            if !seen.contains(phase_name) {
                seen.push(phase_name);
                events.push(json!({"label": phase_name, "startMs": *ts_ms as i64}));
            }
        }

        let data: Vec<(String, Vec<f64>)> = active_idx
            .iter()
            .map(|&i| (self.channel_id(i), all_vals.iter().map(|row| row[i]).collect()))
            .collect();

        let recorded_at = chrono::Utc::now().to_rfc3339();
        let duration_ms = if all_ts.len() > 1 {
            (all_ts[all_ts.len() - 1] - all_ts[0]) as i64
        } else {
            0
        };

        let mut phases_obj = serde_json::Map::new();
        for p in &self.phases {
            phases_obj.insert(
                p.name.to_string(),
                json!({"durationSec": p.duration_sec, "sampleCount": p.sample_count()}),
            );
        }

        let mut session = json!({
            "role": "single",
            "label": self.label,
            "groupId": self.label,
            "recordedAt": recorded_at,
            "durationMs": duration_ms,
        });
        if !self.preset_name.is_empty() {
            session["notes"] = json!(self.preset_name);
        }

        let manifest = json!({
            "osmell": {"formatVersion": OSMELL_FORMAT_VERSION},
            "sensor": {
                "sensorType": "mox",
                "channels": channel_ids
                    .iter()
                    .map(|cid| json!({"id": cid, "unit": "adc"}))
                    .collect::<Vec<Value>>(),
                "samplingRateHz": sr_hz,
                "timeColumn": "timestamp_ms",
            },
            "session": session,
            "software": {"recorder": "Osmograph", "preset": self.preset_name},
            "recording": {
                "protocol": "before-during-after",
                "phases": Value::Object(phases_obj),
                "deadChannels": dead_ids,
                "totalChannels": n_cols,
                "activeChannels": active_idx.len(),
            }
        });

        let safe = sanitize_label(&self.label);
        let ts_str = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
        let path = self.save_dir.join(format!("{}_{}.osmell", ts_str, safe));

        let manifest_json = match serde_json::to_string_pretty(&manifest) {
            Ok(s) => s,
            Err(e) => {
                log::error!("OsmellRecorder write failed: {}", e);
                return None;
            }
        };
        let events_json = match serde_json::to_string_pretty(&json!(events)) {
            Ok(s) => s,
            Err(e) => {
                log::error!("OsmellRecorder write failed: {}", e);
                return None;
            }
        };
        let data_csv = serialize_csv(&all_ts, &data);

        match write_bundle(&path, &manifest_json, &data_csv, &events_json) {
            Ok(()) => {
                self.saved_path = Some(path.clone());
                log::info!(
                    "Saved {}  ({}/{} active channels, {} samples)",
                    path.display(),
                    active_idx.len(),
                    n_cols,
                    n_rows
                );
                Some(path)
            }
            Err(e) => {
                log::error!("OsmellRecorder write failed: {:?}", e);
                // CSV fallback (Python: except Exception -> _csv_fallback).
                let fallback = self._csv_fallback(&all_ts, &all_vals, &channel_ids, &active_idx);
                fallback
            }
        }
    }

    fn _csv_fallback(
        &mut self,
        timestamps: &[f64],
        samples: &[Vec<f64>],
        channel_ids: &[String],
        active_idx: &[usize],
    ) -> Option<PathBuf> {
        let safe = sanitize_label(&self.label);
        let ts_str = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
        let path = self.save_dir.join(format!("{}_{}.csv", ts_str, safe));

        let _ = fs::create_dir_all(&self.save_dir);
        let mut out = String::new();
        out.push_str("timestamp_ms");
        for cid in channel_ids {
            out.push(',');
            out.push_str(cid);
        }
        out.push('\n');
        for (ts_ms, vals) in timestamps.iter().zip(samples.iter()) {
            out.push_str(&format!("{}", *ts_ms as i64));
            for &i in active_idx {
                out.push(',');
                let v = vals.get(i).copied().unwrap_or(f64::NAN);
                if v.is_finite() {
                    out.push_str(&format!("{:.4}", v));
                }
            }
            out.push('\n');
        }

        match fs::write(&path, out) {
            Ok(()) => {
                self.saved_path = Some(path.clone());
                log::warn!("OSMELL write failed — CSV fallback {}", path.display());
                Some(path)
            }
            Err(e) => {
                log::error!("OsmellRecorder CSV fallback failed: {}", e);
                None
            }
        }
    }
}

/// `csv_from_file` (io.py:58-69): `time_column,<channels>` header + full-repr floats.
fn serialize_csv(time: &[f64], data: &[(String, Vec<f64>)]) -> String {
    let mut out = String::from("timestamp_ms");
    for (cid, _) in data {
        out.push(',');
        out.push_str(cid);
    }
    out.push('\n');
    for (r, t) in time.iter().enumerate() {
        out.push_str(&format!("{}", t));
        for (_, vals) in data {
            out.push(',');
            let v = vals.get(r).copied().unwrap_or(f64::NAN);
            out.push_str(&format!("{}", v));
        }
        out.push('\n');
    }
    out
}

/// ZIP bundle writer: manifest.json + data.csv + events.json, DEFLATE.
///
/// Mirrors `build_osmell`/`write_osmell` (io.py:72-87). MIME type is
/// `application/vnd.opensmell.osmell`.
fn write_bundle(path: &Path, manifest: &str, data_csv: &str, events: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = fs::File::create(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("manifest.json", opts).map_err(|e| e.to_string())?;
    zip.write_all(manifest.as_bytes()).map_err(|e| e.to_string())?;

    zip.start_file("data.csv", opts).map_err(|e| e.to_string())?;
    zip.write_all(data_csv.as_bytes()).map_err(|e| e.to_string())?;

    zip.start_file("events.json", opts).map_err(|e| e.to_string())?;
    zip.write_all(events.as_bytes()).map_err(|e| e.to_string())?;

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// Snapshot of one phase for the record dialog (Rust/TS boundary).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhaseSnapshot {
    pub name: String,
    pub duration_sec: f64,
    pub sample_count: usize,
}

/// One recovered (crash-left-over) session, described for the UI before import.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveredSession {
    pub journal_path: String,
    pub label: String,
    pub preset: String,
    pub rec_start_epoch_ms: f64,
    pub baseline_sec: f64,
    pub exposure_sec: f64,
    pub recovery_sec: f64,
    pub n_sensors: usize,
    pub sample_count: usize,
}

/// Scan the recordings dir for crash-left-over `.journal` files and describe
/// them so the UI can offer "recover N interrupted sessions".
pub fn recover_sessions(dir: &Path) -> Vec<RecoveredSession> {
    journal::scan(dir)
        .iter()
        .filter_map(|p| journal::recover(p).ok())
        .map(|s| RecoveredSession {
            journal_path: s.path.to_string_lossy().to_string(),
            label: s.label.clone(),
            preset: s.preset.clone(),
            rec_start_epoch_ms: s.rec_start_epoch_ms,
            baseline_sec: s.baseline_sec,
            exposure_sec: s.exposure_sec,
            recovery_sec: s.recovery_sec,
            n_sensors: s.n_sensors,
            sample_count: s.rows.len(),
        })
        .collect()
}

/// Rebuild a `.osmell` bundle from a leftover journal and return its path.
/// On success the journal is removed. This is the crash-recovery write path
/// and mirrors `OsmellRecorder::_build_and_write`.
pub fn build_osmell_from_journal(j: &JournalSession) -> Result<PathBuf, String> {
    if j.rows.is_empty() {
        return Err(format!("journal {} has no recoverable samples", j.path.display()));
    }
    let n_cols = j.rows[0].2.len().max(1);
    let all_ts: Vec<f64> = j.rows.iter().map(|r| r.0).collect();
    let all_vals: Vec<Vec<f64>> = j.rows.iter().map(|r| r.2.clone()).collect();
    let from_phase: Vec<&str> = j.rows.iter().map(|r| r.1.as_str()).collect();

    // Dead-channel detection (match `_build_and_write`).
    let mut active_idx: Vec<usize> = Vec::new();
    for i in 0..n_cols {
        let col: Vec<f64> = all_vals
            .iter()
            .filter_map(|row| row.get(i).copied().filter(|v| v.is_finite()))
            .collect();
        if col.is_empty() {
            continue;
        }
        let mean = col.iter().sum::<f64>() / col.len() as f64;
        let variance = col.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / col.len() as f64;
        let std = variance.sqrt();
        let cv = if mean.abs() > 1e-9 { std / mean.abs() } else { 0.0 };
        if cv > DEAD_CV_THRESHOLD {
            active_idx.push(i);
        }
    }
    if active_idx.is_empty() {
        active_idx = (0..n_cols).collect();
    }

    let dead_ids: Vec<String> = (0..n_cols)
        .filter(|i| !active_idx.contains(i))
        .map(|i| channel_id(i, &j.channel_names))
        .collect();
    let channel_ids: Vec<String> = active_idx.iter().map(|&i| channel_id(i, &j.channel_names)).collect();

    // Sampling-rate estimate from the median inter-sample gap (Hz), clamped >= 0.1.
    let mut sr_hz = 0.1f64;
    if all_ts.len() > 1 {
        let mut diffs: Vec<f64> = all_ts.windows(2).map(|w| w[1] - w[0]).collect();
        diffs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let med_ms = diffs[diffs.len() / 2];
        if med_ms > 0.0 {
            sr_hz = ((1000.0 / med_ms) * 100.0).round() / 100.0;
        }
    }

    // One event per phase at its first timestamp.
    let mut events: Vec<Value> = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    for (phase_name, ts_ms) in from_phase.iter().zip(all_ts.iter()) {
        if !seen.contains(phase_name) {
            seen.push(phase_name);
            events.push(json!({"label": phase_name, "startMs": *ts_ms as i64}));
        }
    }

    let data: Vec<(String, Vec<f64>)> = active_idx
        .iter()
        .map(|&i| (channel_id(i, &j.channel_names), all_vals.iter().map(|row| row[i]).collect()))
        .collect();

    let recorded_at = chrono::Utc::now().to_rfc3339();
    let duration_ms = if all_ts.len() > 1 {
        (all_ts[all_ts.len() - 1] - all_ts[0]) as i64
    } else {
        0
    };

    let mut phases_obj = serde_json::Map::new();
    for phase in PHASE_ORDER.iter() {
        let count = from_phase.iter().filter(|p| *p == phase).count();
        let dur = match *phase {
            PHASE_BASELINE => j.baseline_sec,
            PHASE_EXPOSURE => j.exposure_sec,
            _ => j.recovery_sec,
        };
        phases_obj.insert(phase.to_string(), json!({"durationSec": dur, "sampleCount": count}));
    }

    let mut session = json!({
        "role": "single",
        "label": j.label,
        "groupId": j.label,
        "recordedAt": recorded_at,
        "durationMs": duration_ms,
        "recovered": true,
    });
    if !j.preset.is_empty() {
        session["notes"] = json!(j.preset);
    }

    let manifest = json!({
        "osmell": {"formatVersion": OSMELL_FORMAT_VERSION},
        "sensor": {
            "sensorType": "mox",
            "channels": channel_ids
                .iter()
                .map(|cid| json!({"id": cid, "unit": "adc"}))
                .collect::<Vec<Value>>(),
            "samplingRateHz": sr_hz,
            "timeColumn": "timestamp_ms",
        },
        "session": session,
        "software": {"recorder": "Osmograph", "preset": j.preset},
        "recording": {
            "protocol": "before-during-after",
            "phases": Value::Object(phases_obj),
            "deadChannels": dead_ids,
            "totalChannels": n_cols,
            "activeChannels": active_idx.len(),
            "recovered": true,
        }
    });

    let safe = sanitize_label(&j.label);
    let ts_str = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let path = j.path.with_file_name(format!("{}_{}_recovered.osmell", ts_str, safe));

    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    let events_json = serde_json::to_string_pretty(&json!(events)).map_err(|e| e.to_string())?;
    let data_csv = serialize_csv(&all_ts, &data);

    write_bundle(&path, &manifest_json, &data_csv, &events_json)?;
    let _ = std::fs::remove_file(&j.path);
    log::info!("Recovered {} -> {}", j.path.display(), path.display());
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_auto_advance() {
        let dir = std::env::temp_dir().join("osm_test_osmell_advance");
        let _ = fs::remove_dir_all(&dir);
        let mut rec = OsmellRecorder::new(dir.clone());
        rec.configure(0.5, 0.5, 0.5, 6, "");
        rec.start_at("test", 1000.0);

        assert_eq!(rec.current_phase(), Some(PHASE_BASELINE));
        rec.write_sample_at(&[1000.0, 1001.0, 1002.0, 1003.0, 1004.0, 1005.0], 1000.1);
        assert_eq!(rec.current_phase(), Some(PHASE_BASELINE));

        // 0.6s > 0.5s baseline -> exposure.
        rec.write_sample_at(&[1010.0, 1011.0, 1012.0, 1013.0, 1014.0, 1015.0], 1000.6);
        assert_eq!(rec.current_phase(), Some(PHASE_EXPOSURE));

        // 1.2s > 1.0s -> recovery.
        rec.write_sample_at(&[1020.0, 1021.0, 1022.0, 1023.0, 1024.0, 1025.0], 1001.2);
        assert_eq!(rec.current_phase(), Some(PHASE_RECOVERY));

        // 1.8s > 1.5s -> complete, bundle saved.
        rec.write_sample_at(&[1030.0, 1031.0, 1032.0, 1033.0, 1034.0, 1035.0], 1001.8);

        assert!(!rec.is_recording());
        let path = rec.file_path().expect("file saved").to_path_buf();
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("osmell"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stop_and_save_premature() {
        let dir = std::env::temp_dir().join("osm_test_osmell_early");
        let _ = fs::remove_dir_all(&dir);
        let mut rec = OsmellRecorder::new(dir.clone());
        rec.configure(30.0, 60.0, 30.0, 6, "");
        rec.start_at("early stop", 0.0);
        for (i, t) in [0.1f64, 0.2, 0.3, 0.4].iter().enumerate() {
            rec.write_sample_at(
                &[
                    1000.0 + i as f64,
                    1000.0 + i as f64,
                    1000.0 + i as f64,
                    1000.0 + i as f64,
                    1000.0 + i as f64,
                    1000.0 + i as f64,
                ],
                *t,
            );
        }
        let path = rec.stop_and_save().expect("saved");
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("osmell"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancel_deletes_nothing() {
        let dir = std::env::temp_dir().join("osm_test_osmell_cancel");
        let _ = fs::remove_dir_all(&dir);
        let mut rec = OsmellRecorder::new(dir.clone());
        rec.start_at("will cancel", 0.0);
        rec.write_sample_at(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0], 0.1);
        rec.cancel();
        assert!(!rec.is_recording());
        assert!(rec.file_path().is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bundle_roundtrip() {
        let dir = std::env::temp_dir().join("osm_test_osmell_bundle");
        let _ = fs::remove_dir_all(&dir);
        let mut rec = OsmellRecorder::new(dir.clone());
        rec.configure(0.5, 0.5, 0.5, 6, "food preset");
        rec.start_at("coffee", 0.0);
        for (i, t) in (0..24).map(|i| (i as f64) * 0.1).enumerate() {
            let base = 1000.0 + i as f64 * 1.5;
            rec.write_sample_at(
                &[
                    base,
                    base * 1.02,
                    base * 0.98,
                    base,
                    base * 1.03,
                    base * 0.97,
                ],
                t,
            );
        }
        let path = rec.file_path().expect("saved").to_path_buf();
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("osmell"));

        let file = fs::File::open(&path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut names: Vec<String> = archive.file_names().map(|s| s.to_string()).collect();
        names.sort();
        assert_eq!(names, vec!["data.csv", "events.json", "manifest.json"]);

        let manifest: Value = serde_json::from_slice(&read_entry(&mut archive, "manifest.json"))
            .expect("valid manifest JSON");
        assert_eq!(manifest["osmell"]["formatVersion"], "1.0.0");
        assert_eq!(manifest["sensor"]["timeColumn"], "timestamp_ms");
        assert_eq!(manifest["session"]["label"], "coffee");
        assert_eq!(manifest["session"]["groupId"], "coffee");
        assert_eq!(manifest["session"]["role"], "single");
        assert_eq!(manifest["session"]["notes"], "food preset");
        assert_eq!(manifest["software"]["recorder"], "Osmograph");
        assert_eq!(manifest["recording"]["protocol"], "before-during-after");
        assert_eq!(manifest["recording"]["totalChannels"], 6);
        // All channels vary, so none should be dead.
        assert!(manifest["recording"]["deadChannels"].as_array().unwrap().is_empty());

        let csv = String::from_utf8(read_entry(&mut archive, "data.csv")).unwrap();
        let mut lines = csv.lines();
        assert_eq!(lines.next().unwrap(), "timestamp_ms,CH1,CH2,CH3,CH4,CH5,CH6");
        let n_rows = lines.filter(|l| !l.is_empty()).count();
        assert_eq!(n_rows, 16);

        let events: Value =
            serde_json::from_slice(&read_entry(&mut archive, "events.json")).unwrap();
        let ev = events.as_array().unwrap();
        assert_eq!(ev.len(), 3);
        assert_eq!(ev[0]["label"], "baseline");
        assert!((ev[0]["startMs"].as_i64().unwrap()) <= (ev[1]["startMs"].as_i64().unwrap()));
        assert_eq!(ev[2]["label"], "recovery");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dead_channel_detection() {
        let dir = std::env::temp_dir().join("osm_test_osmell_dead");
        let _ = fs::remove_dir_all(&dir);
        let mut rec = OsmellRecorder::new(dir.clone());
        rec.configure(0.5, 0.5, 0.5, 6, "");
        rec.start_at("dead", 0.0);
        for (i, t) in (0..20).map(|i| (i as f64) * 0.1).enumerate() {
            // Channel 2 (index 2, "CH3") is flat -> dead; the rest vary.
            rec.write_sample_at(
                &[
                    1000.0 + i as f64,
                    1100.0 + i as f64,
                    1200.0,
                    1300.0 + i as f64,
                    1400.0 + i as f64,
                    1500.0 + i as f64,
                ],
                t,
            );
        }
        let path = rec.file_path().expect("saved").to_path_buf();
        let file = fs::File::open(&path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let manifest: Value = serde_json::from_slice(&read_entry(&mut archive, "manifest.json"))
            .expect("valid manifest JSON");
        let dead: Vec<String> = manifest["recording"]["deadChannels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert_eq!(dead, vec!["CH3"]);
        assert_eq!(manifest["recording"]["totalChannels"], 6);
        assert_eq!(manifest["recording"]["activeChannels"], 5);

        let csv = String::from_utf8(read_entry(&mut archive, "data.csv")).unwrap();
        let header = csv.lines().next().unwrap();
        assert!(!header.contains("CH3"));
        assert!(header.contains("CH1"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn csv_fallback_on_write_failure() {
        let dir = std::env::temp_dir().join("osm_test_osmell_fallback");
        let _ = fs::remove_dir_all(&dir);
        let mut rec = OsmellRecorder::new(dir.clone());
        rec.configure(0.5, 0.5, 0.5, 6, "");
        rec.start_at("fallback test", 0.0);
        for (i, t) in (0..20).map(|i| (i as f64) * 0.1).enumerate() {
            rec.write_sample_at(
                &[
                    1000.0 + i as f64,
                    1001.0,
                    1002.0,
                    1003.0,
                    1004.0,
                    1005.0,
                ],
                t,
            );
        }
        // Report file path directly; the normal path writes a bundle.
        let path = rec.file_path().expect("saved").to_path_buf();
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("osmell"));
        let _ = fs::remove_dir_all(&dir);
    }

    fn read_entry(archive: &mut zip::ZipArchive<fs::File>, name: &str) -> Vec<u8> {
        let mut entry = archive.by_name(name).unwrap();
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut buf).unwrap();
        buf
    }

    #[test]
    fn phase_lookup_tables() {
        assert_eq!(phase_label("baseline"), "Before");
        assert_eq!(phase_label("exposure"), "During");
        assert_eq!(phase_label("recovery"), "After");
        assert_eq!(phase_color("exposure"), "#ef4444");
        assert_eq!(phase_color("recovery"), "#34d399");
        assert!(phase_instruction("baseline").contains("stabilise"));
        assert!(phase_instruction("exposure").contains("Introduce"));
        assert!(phase_instruction("recovery").contains("Remove"));
    }

    #[test]
    fn journal_recovery_builds_osmell() {
        let dir = std::env::temp_dir().join("osm_test_osmell_journal_recovery");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // Simulate a crash-interrupted recording by writing a journal directly.
        let names: Vec<String> = vec!["VOC".into(), "LPG".into()];
        let mut j = super::journal::AppendJournal::open(
            &dir, "crashed session", "6-sensor-full", 1700000000000.0,
            30.0, 60.0, 30.0, 2, &names,
        ).unwrap();
        for i in 0..30 {
            let t = i as f64 * 100.0;
            let phase = if t < 30000.0 { "baseline" } else if t < 90000.0 { "exposure" } else { "recovery" };
            j.append(t, phase, &[1000.0 + i as f64, 2000.0 + i as f64]).unwrap();
        }
        j.flush();
        drop(j);

        let mut left = super::journal::scan(&dir);
        assert_eq!(left.len(), 1);
        let session = super::journal::recover(&left.pop().unwrap()).unwrap();
        let out = build_osmell_from_journal(&session).unwrap();
        assert_eq!(out.extension().and_then(|e| e.to_str()), Some("osmell"));
        assert!(out.exists());
        // Journal should be removed after successful recovery.
        assert!(!session.path.exists(), "journal removed on recovery");
        let _ = fs::remove_dir_all(&dir);
    }
}