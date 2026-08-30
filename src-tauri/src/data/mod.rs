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
pub fn parse_osm_line(line: &str, expected_channels: usize) -> Option<Vec<f64>> {
    let decoded = line.trim();
    if decoded.is_empty() {
        return None;
    }
    let binding = decoded.replace(EXPECTED_HEADER, "");
    let cleaned = binding.trim();

    let mut values: Vec<f64> = Vec::new();
    for part in cleaned.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Ok(v) = part.parse::<f64>() {
            values.push(v);
        }
    }

    if values.len() < MIN_DATA_VALUES {
        return None;
    }

    values.truncate(expected_channels);
    while values.len() < expected_channels {
        values.push(0.0);
    }
    Some(values)
}

/// Python `DataValidator` (validator.py:19-72): per-sample streaming validation.
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

        if sample.iter().any(|&v| v < 0.0 || v > VALIDATOR_HARD_LIMIT) {
            self.total_gibberish += 1;
            return None;
        }

        let mean = sample.iter().sum::<f64>() / sample.len() as f64;
        let variance =
            sample.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / sample.len() as f64;
        if variance.sqrt() < 1e-8 {
            self.total_gibberish += 1;
            return None;
        }

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
        let filename = format!("{}_{}.csv", timestamp, safe_label);
        let path = self.save_dir.join(&filename);

        fs::create_dir_all(&self.save_dir).map_err(|e| e.to_string())?;
        let file = fs::File::create(&path).map_err(|e| e.to_string())?;

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionIndex {
    pub version: u32,
    pub updated: f64,
    pub records: Vec<SessionRecord>,
}

impl Default for SessionIndex {
    fn default() -> Self {
        Self {
            version: 1,
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
            if let Ok(idx) = serde_json::from_str::<SessionIndex>(&text) {
                return idx;
            }
        }
        Self::default()
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let mut updated = self.clone();
        updated.updated = now_secs();
        let json = serde_json::to_string_pretty(&updated).map_err(|e| e.to_string())?;
        fs::write(dir.join(".session_index.json"), json).map_err(|e| e.to_string())
    }

    /// Add a record, deduping by `file_id` (Python: dedupes legacy duplicates).
    pub fn upsert(&mut self, record: SessionRecord) {
        self.records.retain(|r| r.file_id != record.file_id);
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
    fn lenient_parse_drops_non_numeric() {
        let v = parse_osm_line("OSM,1.0,abc,2.0,3.0", 6).unwrap();
        assert_eq!(v, vec![1.0, 2.0, 3.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn lenient_parse_requires_three() {
        assert!(parse_osm_line("OSM,1.0,2.0", 6).is_none());
        assert!(parse_osm_line("INFO,device,1.2.3", 6).is_none());
        assert!(parse_osm_line("", 6).is_none());
    }

    #[test]
    fn lenient_parse_truncates_to_channels() {
        let v = parse_osm_line("OSM,1,2,3,4,5,6,7,8", 6).unwrap();
        assert_eq!(v.len(), 6);
    }

    #[test]
    fn validator_checks() {
        let mut v = SampleValidator::new();
        assert!(v.validate(&[1200.0, 1300.0, 1400.0]).is_some());
        assert!(v.validate(&[f64::NAN, 1.0, 2.0]).is_none());
        assert!(v.validate(&[-1.0, 2.0, 3.0]).is_none());
        assert!(v.validate(&[6000.0, 2.0, 3.0]).is_none());
        assert!(v.validate(&[1.0, 1.0, 1.0]).is_none()); // std < 1e-8
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
}