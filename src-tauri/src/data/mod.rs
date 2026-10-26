//! Data-layer parity with the Python Osmograph reference (Osmograph/data/).
//!
//! Mirrors the semantics, constants and on-disk formats of:
//! - serial_reader.py   (lenient OSM line parsing, bootloader detection)
//! - validator.py       (per-sample DataValidator)
//! - recorder.py        (CSVRecorder: headers, timestamps, buffered flush, naming)
//! - session.py         (SessionManager: `.session_index.json` persistence)
//! - osmell_recorder.py (OsmellRecorder: before/during/after phases + `.osmell`)
//!
//! Submodules:
//! - `osmell`: phase-aware `.osmell` recorder + bundle writer (io.py/types.py).

pub mod osmell;
pub mod csv_parse;
pub mod osmell_read;
pub mod export;
pub mod hub;
pub mod dataset_io;
pub mod journal;
pub mod collections;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const DEFAULT_BAUD: u32 = 115200;
pub const EXPECTED_HEADER: &str = "OSM";
pub const MIN_DATA_VALUES: usize = 3;
pub const MAX_CHANNELS: usize = 6;
/// Python `types.py DEFAULT_ADC_MAX` — used by the quality subscores once the
/// QualityReportPanel parity lands (kept for parity documentation).
#[allow(dead_code)]
pub const ADC_MAX: f64 = 4095.0;
pub const VALIDATOR_HARD_LIMIT: f64 = 5000.0;

pub const BOOTLOADER_KEYWORDS: [&str; 16] = [
    "ets", "rst", "boot", "configsip", "load", "entry", "waiting", "download",
    "flash", "error", "bundles", "csum", "secure", "spi", "doubt", "mode",
];

/// Python `CSV_HEADERS` / `SENSOR_LABELS` (recorder.py:13-17) for the default 6-sensor layout.
pub const CSV_HEADERS: [&str; 7] =
    ["timestamp_ms", "VOC", "Alcohol", "LPG", "CO", "NO2", "C2H5OH"];

/// Default recordings directory used by the Python app: `~/Osmograph_Recordings`.
pub fn recordings_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("Osmograph_Recordings")
}

/// Python `SerialReader._parse_line` (serial_reader.py:161-190): lenient OSM parse.
///
/// Strips every "OSM" token, drops non-numeric tokens, requires >= 3 numeric
/// values, then pads/truncates to `expected_channels` (Python hard-codes 6).
/// Count the numeric CSV fields on a raw device line, without padding or
/// truncation. Returns `None` when the line isn't a plausible data line
/// (fewer than `MIN_DATA_VALUES` numeric tokens, or more than
/// `MAX_CHANNELS`). Mirrors the strict `parse_osm_line` tokenizer so a plain
/// Arduino/CSV stream (no `OSM` header) is detected exactly like a data line.
pub fn count_numeric_fields(line: &str) -> Option<usize> {
    let parts = data_tokens(line)?;
    let all_numeric = parts.iter().all(|part| {
        part.parse::<f64>().map(|v| v.is_finite()).unwrap_or(false)
    });
    if !all_numeric {
        return None;
    }
    if parts.len() >= MIN_DATA_VALUES && parts.len() <= MAX_CHANNELS {
        Some(parts.len())
    } else {
        None
    }
}

/// Tokenize a data frame. A replacement character means the reader lost bytes
/// mid-frame; every token must be present, so ragged frames never become data.
fn data_tokens(line: &str) -> Option<Vec<&str>> {
    let decoded = line.trim();
    if decoded.is_empty() || decoded.contains('\u{FFFD}') {
        return None;
    }
    let mut parts: Vec<&str> = decoded.split(',').map(str::trim).collect();
    if parts.first().map(|p| p.eq_ignore_ascii_case(EXPECTED_HEADER)).unwrap_or(false) {
        parts.remove(0);
    }
    if parts.is_empty() || parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    Some(parts)
}

pub fn parse_osm_line(line: &str, expected_channels: usize) -> Option<Vec<f64>> {
    let parts = data_tokens(line)?;
    let mut values: Vec<f64> = Vec::with_capacity(parts.len());
    for part in parts {
        let value = part.parse::<f64>().ok()?;
        if !value.is_finite() {
            return None;
        }
        values.push(value);
    }

    if values.len() < MIN_DATA_VALUES || values.len() != expected_channels {
        return None;
    }
    Some(values)
}

/// Streaming sample validation. Based on Python `DataValidator`
/// (validator.py:19-72) with one deliberate hardening change: a resting baseline
/// where all channels sit at the same value is legitimate stream data and is
/// kept (the Python rule that dropped near-zero-variance samples blanked the
/// live plot for idle rigs). Small negative dips are tolerated; only genuinely
/// out-of-range or non-finite samples count as gibberish. Quality analysis
/// still grades recordings honestly on top of this.
#[derive(Clone)]
pub struct SampleValidator {
    consecutive_zeros: usize,
    total_gibberish: usize,
}

impl Default for SampleValidator {
    fn default() -> Self {
        Self::new()
    }
}

impl SampleValidator {
    pub fn new() -> Self {
        Self {
            consecutive_zeros: 0,
            total_gibberish: 0,
        }
    }

    /// Returns the sample unchanged if valid, None if it must be dropped.
    pub fn validate(&mut self, sample: &[f64]) -> Option<Vec<f64>> {
        if sample.is_empty() {
            return None;
        }
        if sample.iter().any(|v| !v.is_finite()) {
            self.total_gibberish += 1;
            return None;
        }
        if sample.iter().all(|&v| v == 0.0) {
            self.consecutive_zeros += 1;
            if self.consecutive_zeros > 10 {
                return None;
            }
            return Some(sample.to_vec());
        }
        self.consecutive_zeros = 0;

        if sample.iter().any(|&v| v < -50.0 || v > VALIDATOR_HARD_LIMIT) {
            self.total_gibberish += 1;
            return None;
        }

        // A resting baseline where all channels sit at the same value is
        // legitimate stream data (an idle MOX array idles equal), not garbage —
        // dropping it blanks the live plot. Only non-finite / out-of-range
        // samples are counted as gibberish.

        Some(sample.to_vec())
    }

    /// Consumed once the signal-quality state machine (WARMING_UP/UNSTABLE/STABLE/
    /// READY) lands; mirrors the Python API.
    #[allow(dead_code)]
    pub fn gibberish_count(&self) -> usize {
        self.total_gibberish
    }

    /// Python `signal_stable`: True when fewer than 50 gibberish samples.
    #[allow(dead_code)]
    pub fn signal_stable(&self) -> bool {
        self.total_gibberish < 50
    }

    #[allow(dead_code)]
    pub fn reset(&mut self) {
        *self = Self::new();
    }

    /// Python `DataValidator.is_bootloader_line` (validator.py:74-77).
    pub fn is_bootloader_line(text: &str) -> bool {
        let lower = text.to_lowercase();
        BOOTLOADER_KEYWORDS.iter().any(|kw| lower.contains(kw))
    }
}

/// Python `CSVRecorder` (recorder.py:20-123): streaming CSV with Python-format
/// headers, elapsed-ms timestamps, buffered writes, duration auto-stop, label
/// file naming and cancel-with-delete.
pub struct CsvRecorder {
    save_dir: PathBuf,
    label: String,
    duration_sec: f64,
    sensor_count: usize,
    file_path: Option<PathBuf>,
    file: Option<fs::File>,
    buffer: Vec<String>,
    rows_written: usize,
    recording: bool,
    start_time: f64,
}

impl CsvRecorder {
    pub fn new(save_dir: PathBuf) -> Self {
        Self {
            save_dir,
            label: String::new(),
            duration_sec: 0.0,
            sensor_count: MAX_CHANNELS,
            file_path: None,
            file: None,
            buffer: Vec::new(),
            rows_written: 0,
            recording: false,
            start_time: 0.0,
        }
    }

    pub fn is_recording(&self) -> bool {
        self.recording
    }

    pub fn file_path(&self) -> Option<&Path> {
        self.file_path.as_deref()
    }

    pub fn elapsed(&self) -> f64 {
        if !self.recording {
            return 0.0;
        }
        now_secs() - self.start_time
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn start(&mut self, label: &str, duration_sec: f64, sensor_count: usize) -> Result<PathBuf, String> {
        self.label = if label.trim().is_empty() {
            format!("recording_{}", chrono::Local::now().format("%Y%m%d_%H%M%S"))
        } else {
            label.to_string()
        };
        self.duration_sec = duration_sec.max(0.0);
        self.sensor_count = sensor_count.max(1);

        let safe_label = sanitize_label(&self.label);
        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
        // Second-resolution timestamps can collide (stop → restart in the same
        // second with the same label). Never truncate an existing recording:
        // step to a `_2`, `_3`, ... suffix instead of overwriting.
        let mut path = self.save_dir.join(format!("{}_{}.csv", timestamp, safe_label));
        let mut n = 2;
        while path.exists() {
            path = self.save_dir.join(format!("{}_{}_{}.csv", timestamp, n, safe_label));
            n += 1;
        }

        fs::create_dir_all(&self.save_dir).map_err(|e| e.to_string())?;
        // create_new (not File::create) so the same-second restart — and any
        // cross-process race — can never clobber an existing recording.
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| e.to_string())?;

        let header = self.header_row();
        self.file = Some(file);
        self.buffer.clear();
        self.rows_written = 0;
        self.file_path = Some(path.clone());
        self.start_time = now_secs();
        self.recording = true;
        self._push(&header);

        Ok(path)
    }

    pub fn write_sample(&mut self, sensor_values: &[f64]) {
        if !self.recording {
            return;
        }
        let ts = ((now_secs() - self.start_time) * 1000.0) as i64;
        let mut row = String::from(&ts.to_string());
        for i in 0..self.sensor_count {
            row.push(',');
            if i < sensor_values.len() {
                row.push_str(&format!("{:.6}", sensor_values[i]));
            } else {
                row.push('0');
            }
        }
        self._push(&row);

        if self.buffer.len() >= 100 {
            self._flush_buffer();
        }

        if self.duration_sec > 0.0 && self.elapsed() >= self.duration_sec {
            let _ = self.stop();
        }
    }

    pub fn stop(&mut self) -> Option<PathBuf> {
        if !self.recording {
            return self.file_path.clone();
        }
        self._flush_buffer();
        self.recording = false;
        self.file = None;
        self.file_path.clone()
    }

    pub fn cancel(&mut self) {
        self.recording = false;
        self.file = None;
        if let Some(path) = &self.file_path {
            let _ = fs::remove_file(path);
        }
        self.file_path = None;
    }

    fn header_row(&self) -> String {
        if self.sensor_count == MAX_CHANNELS {
            CSV_HEADERS.join(",")
        } else {
            let mut h = String::from("timestamp_ms");
            for i in 0..self.sensor_count {
                h.push_str(&format!(",ch_{}", i));
            }
            h
        }
    }

    fn _push(&mut self, row: &str) {
        if let Some(file) = &mut self.file {
            let _ = writeln!(file, "{}", row);
        }
        self.rows_written += 1;
    }

    fn _flush_buffer(&mut self) {
        let _ = self.buffer.clear();
    }
}

/// Python `recorder.py:62` label sanitization: keep alphanumeric plus ` _-`, else `_`.
pub fn sanitize_label(label: &str) -> String {
    label
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, ' ' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Python `session.py` `SessionRecord` + `SessionManager` (`.session_index.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub file_id: String,
    pub substance: String,
    pub label: String,
    pub csv_path: String,
    pub timestamp: f64,
    pub duration_sec: f64,
    pub sensor_count: usize,
    pub preset_name: String,
    pub notes: String,
    pub opensmell_result: Option<String>,
    pub quality_report: Option<String>,
    /// Provisional deterministic quality score (0-100). Desktop extension;
    /// replaced by the full QualityReportPanel subscores in the quality-parity phase.
    #[serde(default)]
    pub quality: f64,
    /// Collection/corpus this recording belongs to. Filled at import time from
    /// the folder structure, so the library no longer has to guess from a path.
    #[serde(default)]
    pub collection_id: String,
    #[serde(default)]
    pub collection_name: String,
    /// Source split (`Training`, `Testing`, `test_seen`, …) when the corpus has one.
    #[serde(default)]
    pub split: String,
    /// Per-record condition inside the split (`run 5`, `day 3`, `ingestion balanced`).
    #[serde(default)]
    pub condition: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionIndex {
    pub version: u32,
    pub updated: f64,
    pub records: Vec<SessionRecord>,
}

/// Bumped when the index gains derived fields that older builds cannot fill.
pub const INDEX_VERSION: u32 = 2;

impl Default for SessionIndex {
    fn default() -> Self {
        Self {
            version: INDEX_VERSION,
            updated: now_secs(),
            records: Vec::new(),
        }
    }
}

impl SessionIndex {
    /// Python `%Y%m%d_%H%M%S_%f` microsecond file_id (session.py:29).
    pub fn make_file_id(now: chrono::DateTime<chrono::Local>) -> String {
        let micros = now.timestamp_subsec_micros();
        format!("{}_{:06}", now.format("%Y%m%d_%H%M%S"), micros)
    }

    pub fn load(dir: &Path) -> Self {
        let path = dir.join(".session_index.json");
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(mut idx) = serde_json::from_str::<SessionIndex>(&text) {
                if idx.migrate(dir) {
                    let _ = idx.save(dir);
                }
                return idx;
            }
        }
        Self::default()
    }

    /// Repair indexes written by the filename-only importer. Idempotent: once
    /// `version` is current and the records carry collection fields, this only
    /// normalises a missing field.
    fn migrate(&mut self, dir: &Path) -> bool {
        let mut changed = false;
        if self.version < INDEX_VERSION {
            self.version = INDEX_VERSION;
            changed = true;
        }
        let mut out: Vec<SessionRecord> = Vec::with_capacity(self.records.len());
        let mut paths: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        for mut r in std::mem::take(&mut self.records) {
            let path_norm = r.csv_path.replace('\\', "/");
            let c = self::collections::classify(Path::new(&r.csv_path), dir);
            // Folder structure, not the old label, decides what is an import.
            // Legacy indexes mislabelled some root recordings as "Imported".
            let imported = path_norm.contains("/datasets/")
                || path_norm.contains("/legacy/")
                || path_norm.contains("/derived/")
                || (!c.collection_id.is_empty() && c.collection_id != "own");
            if imported {
                let id = self::collections::stable_import_id(&path_norm);
                if r.file_id != id {
                    r.file_id = id;
                    changed = true;
                }
                let label = self::collections::display_label(&c);
                if !c.substance.is_empty() && r.substance != c.substance {
                    r.substance = c.substance.clone();
                    changed = true;
                }
                if (r.label.is_empty() || r.label == "Imported") && r.label != label {
                    r.label = label;
                    changed = true;
                }
            } else {
                if r.substance.trim().is_empty() && !c.substance.is_empty() {
                    r.substance = c.substance.clone();
                    changed = true;
                }
                if (r.label.is_empty() || r.label == "Imported") && r.label != "Recorded" {
                    r.label = "Recorded".to_string();
                    changed = true;
                }
            }
            if r.collection_id != c.collection_id {
                r.collection_id = c.collection_id;
                changed = true;
            }
            if r.collection_name != c.collection_name {
                r.collection_name = c.collection_name;
                changed = true;
            }
            if r.split != c.split {
                r.split = c.split;
                changed = true;
            }
            if r.condition != c.condition {
                r.condition = c.condition;
                changed = true;
            }
            if !paths.insert(r.csv_path.clone()) {
                changed = true;
                continue;
            }
            if !ids.insert(r.file_id.clone()) {
                let base = r.file_id.clone();
                let mut n = 2;
                loop {
                    let candidate = format!("{base}-{n}");
                    if ids.insert(candidate.clone()) {
                        r.file_id = candidate;
                        changed = true;
                        break;
                    }
                    n += 1;
                }
            }
            out.push(r);
        }
        self.records = out;
        changed
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let mut updated = self.clone();
        updated.updated = now_secs();
        let json = serde_json::to_string_pretty(&updated).map_err(|e| e.to_string())?;
        fs::write(dir.join(".session_index.json"), json).map_err(|e| e.to_string())
    }

    /// Add a record, deduping by `file_id` and by path (Python dedupes legacy
    /// duplicates; path dedupe also survives an id repair).
    pub fn upsert(&mut self, record: SessionRecord) {
        self.records
            .retain(|r| r.file_id != record.file_id && r.csv_path != record.csv_path);
        self.records.push(record);
    }

    pub fn remove(&mut self, file_id: &str) -> Option<SessionRecord> {
        let idx = self.records.iter().position(|r| r.file_id == file_id)?;
        Some(self.records.remove(idx))
    }

    /// Python `remove_record`: also deletes the on-disk CSV.
    pub fn remove_record_and_file(&mut self, _dir: &Path, file_id: &str) -> Option<SessionRecord> {
        let rec = self.remove(file_id)?;
        let _ = fs::remove_file(&rec.csv_path);
        Some(rec)
    }

    /// Mirror of `get_records_for_adapter_training`: non-empty substance, unlabelled unknown excluded.
    pub fn records_for_training(&self) -> Vec<&SessionRecord> {
        self.records
            .iter()
            .filter(|r| !r.substance.trim().is_empty())
            .collect()
    }

    /// Deterministic provisional quality score (0-100) so the library badge is
    /// honest. Replaced by full QualityReportPanel parity (subscores) later.
    pub fn provision_quality(duration_sec: f64, n_readings: usize) -> f64 {
        let rate_ok = if duration_sec > 0.0 && n_readings > 0 {
            let rate = n_readings as f64 / duration_sec;
            rate >= 0.5
        } else {
            false
        };
        let mut score: f64 = 55.0;
        if rate_ok {
            score += 15.0;
        }
        if duration_sec >= 30.0 {
            score += 15.0;
        } else if duration_sec >= 10.0 {
            score += 8.0;
        }
        if n_readings >= 100 {
            score += 15.0;
        } else if n_readings >= 30 {
            score += 8.0;
        }
        score.min(100.0).max(0.0).round()
    }
}

pub fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_parse_rejects_non_numeric() {
        assert!(parse_osm_line("OSM,1.0,abc,2.0,3.0", 3).is_none());
        assert!(parse_osm_line("OSM,1.0,,2.0,3.0", 3).is_none());
    }

    #[test]
    fn strict_parse_requires_exact_width() {
        assert!(parse_osm_line("OSM,1.0,2.0", 6).is_none());
        assert!(parse_osm_line("OSM,1,2,3,4,5,6,7,8", 6).is_none());
        assert_eq!(parse_osm_line("1710,205,0,0,0,0", 6).unwrap().len(), 6);
        assert_eq!(parse_osm_line("OSM,1,2,3", 3).unwrap(), vec![1.0, 2.0, 3.0]);
    }

    #[test]
    fn strict_parse_rejects_corrupt_frames() {
        assert!(parse_osm_line("OSM,1.0,\u{FFFD}\u{FFFD},3.0", 3).is_none());
        assert!(parse_osm_line("OSM,1.0,NaN,3.0", 3).is_none());
        assert!(parse_osm_line("OSM,1.0,inf,3.0", 3).is_none());
        assert!(parse_osm_line("INFO,device,1.2.3", 3).is_none());
        assert!(parse_osm_line("", 6).is_none());
    }

    #[test]
    fn field_count_reflects_strict_tokens() {
        assert_eq!(count_numeric_fields("1710,205,0,0,0,0"), Some(6));
        assert_eq!(count_numeric_fields("OSM,1710,205,0"), Some(3));
        assert_eq!(count_numeric_fields("OSM,1710,\u{FFFD},0"), None);
        assert_eq!(count_numeric_fields("RIG,1710,205,0"), None);
        assert_eq!(count_numeric_fields("1710,205"), None);
    }

    #[test]
    fn validator_checks() {
        let mut v = SampleValidator::new();
        assert!(v.validate(&[1200.0, 1300.0, 1400.0]).is_some());
        assert!(v.validate(&[f64::NAN, 1.0, 2.0]).is_none());
        // Small negative dips from relative signals are noise, not garbage.
        assert!(v.validate(&[-1.0, 2.0, 3.0]).is_some());
        // A resting baseline (all channels equal) is legitimate — the graph must
        // still render it.
        assert!(v.validate(&[1.0, 1.0, 1.0]).is_some());
        assert!(v.validate(&[-1000.0, 2.0, 3.0]).is_none());
        assert!(v.validate(&[6000.0, 2.0, 3.0]).is_none());
    }

    #[test]
    fn validator_zero_streak_after_ten() {
        let mut v = SampleValidator::new();
        for _ in 0..10 {
            assert!(v.validate(&[0.0, 0.0, 0.0]).is_some());
        }
        assert!(v.validate(&[0.0, 0.0, 0.0]).is_none());
    }

    #[test]
    fn bootloader_keywords() {
        assert!(SampleValidator::is_bootloader_line("ets Jun 8 2016 rst:0x1"));
        assert!(SampleValidator::is_bootloader_line("waiting for download"));
        assert!(!SampleValidator::is_bootloader_line("OSM,1,2,3"));
    }

    #[test]
    fn csv_recorder_roundtrip() {
        let dir = std::env::temp_dir().join("osm_test_recorder");
        let _ = fs::remove_dir_all(&dir);
        let mut rec = CsvRecorder::new(dir.clone());
        let path = rec.start("test sample", 0.0, 6).unwrap();
        assert!(path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.ends_with("test sample.csv"))
            .unwrap_or(false));
        for _ in 0..120 {
            rec.write_sample(&[1000.0, 1100.0, 1200.0, 1300.0, 1400.0, 1500.0]);
        }
        rec.stop();
        let text = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "timestamp_ms,VOC,Alcohol,LPG,CO,NO2,C2H5OH");
        assert_eq!(lines.len(), 121);
        assert!(lines[1].starts_with("0,"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn csv_recorder_cancel_deletes() {
        let dir = std::env::temp_dir().join("osm_test_recorder_cancel");
        let _ = fs::remove_dir_all(&dir);
        let mut rec = CsvRecorder::new(dir.clone());
        let path = rec.start("will cancel", 0.0, 6).unwrap();
        assert!(path.exists());
        rec.cancel();
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_index_roundtrip() {
        let dir = std::env::temp_dir().join("osm_test_index");
        let _ = fs::remove_dir_all(&dir);
        let mut idx = SessionIndex::default();
        idx.upsert(SessionRecord {
            file_id: "20260828_120000_000001".into(),
            substance: "garlic".into(),
            label: "Recorded".into(),
            csv_path: dir.join("a.csv").to_string_lossy().to_string(),
            timestamp: 1.0,
            duration_sec: 60.0,
            sensor_count: 6,
            preset_name: "6-sensor-full".into(),
            notes: String::new(),
            opensmell_result: None,
            quality_report: None,
            quality: 0.0,
            collection_id: "own".into(),
            collection_name: "Own rig".into(),
            split: String::new(),
            condition: String::new(),
        });
        idx.save(&dir).unwrap();
        let loaded = SessionIndex::load(&dir);
        assert_eq!(loaded.records.len(), 1);
        assert_eq!(loaded.records[0].substance, "garlic");
        idx.upsert(loaded.records[0].clone()); // dedupe
        assert_eq!(idx.records.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitize_keeps_alnum_space_dash() {
        assert_eq!(sanitize_label("Coffee #1!"), "Coffee _1_");
        assert_eq!(sanitize_label("room air"), "room air");
    }

    fn legacy_record(
        dir: &Path,
        file_id: &str,
        label: &str,
        substance: &str,
        rel: &str,
    ) -> SessionRecord {
        SessionRecord {
            file_id: file_id.into(),
            substance: substance.into(),
            label: label.into(),
            csv_path: dir.join(rel).to_string_lossy().to_string(),
            timestamp: 1.0,
            duration_sec: 60.0,
            sensor_count: 6,
            preset_name: "6-sensor-full".into(),
            notes: String::new(),
            opensmell_result: None,
            quality_report: None,
            quality: 0.0,
            collection_id: String::new(),
            collection_name: String::new(),
            split: String::new(),
            condition: String::new(),
        }
    }

    #[test]
    fn session_index_migrates_legacy_imports() {
        let dir = std::env::temp_dir().join(format!("osm_test_migration_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let walnuts = "datasets/SmellNet-single/base_data/training/walnuts";
        let mixture = "datasets/SmellNet-mixtures/mixture_data/test_seen/\
                       Almond20_Orange80.4v30t9nt.ingestion-balanced.csv";
        let legacy = SessionIndex {
            version: 1,
            updated: 0.0,
            records: vec![
                legacy_record(
                    &dir,
                    "20260101_120000_000001",
                    "Recorded",
                    "banana",
                    "20260101_120000_banana.csv",
                ),
                legacy_record(&dir, "walnuts_5_000000", "Imported", "", &format!("{walnuts}/walnuts_5.csv")),
                legacy_record(&dir, "walnuts_6_000000", "Imported", "", &format!("{walnuts}/walnuts_6.csv")),
                // Same path as the first walnut: the migration must drop it.
                legacy_record(&dir, "walnuts_5_000000", "Imported", "", &format!("{walnuts}/walnuts_5.csv")),
                legacy_record(&dir, "mixture_000000", "Imported", "", mixture),
            ],
        };
        fs::write(
            dir.join(".session_index.json"),
            serde_json::to_string_pretty(&legacy).unwrap(),
        )
        .unwrap();

        let idx = SessionIndex::load(&dir);
        assert_eq!(idx.version, INDEX_VERSION);
        assert_eq!(idx.records.len(), 4);

        let own = idx.records.iter().find(|r| r.label == "Recorded").unwrap();
        assert_eq!(own.substance, "banana");
        assert_eq!(own.collection_id, "own");
        assert_eq!(own.file_id, "20260101_120000_000001");

        let walnuts: Vec<_> = idx.records.iter().filter(|r| r.substance == "walnuts").collect();
        assert_eq!(walnuts.len(), 2);
        assert!(walnuts.iter().all(|r| r.collection_id == "smellnet"));
        assert!(walnuts.iter().all(|r| r.split == "Training"));
        assert!(walnuts.iter().all(|r| r.label != "Imported"));
        assert_ne!(walnuts[0].file_id, walnuts[1].file_id);

        let mix = idx
            .records
            .iter()
            .find(|r| r.collection_id == "smellnet-mixtures")
            .unwrap();
        assert_eq!(mix.substance, "Almond 20 + Orange 80");
        assert_eq!(mix.condition, "ingestion balanced");

        // A second load is a no-op (the migration is idempotent).
        let again = SessionIndex::load(&dir);
        assert_eq!(again.records.len(), 4);
        assert_eq!(again.version, INDEX_VERSION);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Explicit maintenance hook: migrate the real index in place. Run with
    /// `OSMO_MIGRATE_DIR=~/Osmograph_Recordings cargo test --lib \
    ///  migrate_real_index_by_env -- --ignored --nocapture`.
    #[test]
    #[ignore = "mutates the index at OSMO_MIGRATE_DIR; run explicitly"]
    fn migrate_real_index_by_env() {
        let Ok(dir) = std::env::var("OSMO_MIGRATE_DIR") else {
            return;
        };
        let dir = std::path::PathBuf::from(dir);
        let idx = SessionIndex::load(&dir);
        let empty = idx.records.iter().filter(|r| r.substance.trim().is_empty()).count();
        let imported = idx.records.iter().filter(|r| r.label == "Imported").count();
        println!(
            "migrated {} records: {} empty substances, {} still labelled Imported",
            idx.records.len(),
            empty,
            imported
        );
        assert_eq!(empty, 0, "every record still needs a substance");
        assert_eq!(imported, 0, "every import still needs a real label");
    }
}