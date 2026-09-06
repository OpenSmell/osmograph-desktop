//! Append-only recording journal for crash-safe phase recording.
//!
//! Every sample a phase recorder receives is appended to a `.journal` file the
//! moment it arrives. If the app is killed mid-recording (power loss, crash,
//! force-quit) the journal survives on disk, so a later launch can rebuild the
//! session instead of silently losing it. On a normal finish the journal is
//! removed; a leftover `.journal` is the crash signature.
//!
//! Format (one record per line, tab-separated):
//!   header: `#OSMELLJ1\t<label>\t<preset>\t<rec_start_epoch_ms>\t<baseline>\t<exposure>\t<recovery>\t<n_sensors>\t<channel_names_json>`
//!   row:    `<ms_from_rec_start>\t<phase>\t<val0>,<val1>,...`
//!
//! The row keeps the phase name explicitly (not derived from duration math) so
//! recovery is exact even when a stream's sample timing is irregular.

use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

pub const JOURNAL_MAGIC: &str = "#OSMELLJ1";

/// A complete journal descriptor recovered from disk (header + rows).
#[derive(Debug, Clone)]
pub struct JournalSession {
    pub path: PathBuf,
    pub label: String,
    pub preset: String,
    pub rec_start_epoch_ms: f64,
    pub baseline_sec: f64,
    pub exposure_sec: f64,
    pub recovery_sec: f64,
    pub n_sensors: usize,
    pub channel_names: Vec<String>,
    /// `(ms_from_start, phase, values)` in append order.
    pub rows: Vec<(f64, String, Vec<f64>)>,
}

/// Append-only writer for one live session's journal.
pub struct AppendJournal {
    path: PathBuf,
    writer: Option<BufWriter<fs::File>>,
    rows: usize,
    finished: bool,
}

impl AppendJournal {
    /// Create (and immediately header) a journal for a new session.
    pub fn open(
        dir: &Path,
        label: &str,
        preset: &str,
        rec_start_epoch_ms: f64,
        baseline_sec: f64,
        exposure_sec: f64,
        recovery_sec: f64,
        n_sensors: usize,
        channel_names: &[String],
    ) -> Result<Self, String> {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let safe = super::sanitize_label(label);
        let ts = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
        let path = dir.join(format!("{}_{}.journal", ts, safe));
        let file = fs::File::create(&path).map_err(|e| e.to_string())?;
        let mut writer = BufWriter::new(file);
        let names = serde_json::to_string(channel_names).map_err(|e| e.to_string())?;
        writeln!(
            writer,
            "{JOURNAL_MAGIC}\t{label}\t{preset}\t{rec_start_epoch_ms}\t{baseline_sec}\t{exposure_sec}\t{recovery_sec}\t{n_sensors}\t{names}"
        )
        .map_err(|e| format!("journal header: {e}"))?;
        Ok(Self {
            path,
            writer: Some(writer),
            rows: 0,
            finished: false,
        })
    }


    /// Append one sample row. Values are written comma-separated.
    pub fn append(&mut self, ms_from_start: f64, phase: &str, values: &[f64]) -> Result<(), String> {
        let Some(writer) = self.writer.as_mut() else {
            return Ok(());
        };
        let vals = values
            .iter()
            .map(|v| format!("{:.6}", v))
            .collect::<Vec<_>>()
            .join(",");
        writeln!(writer, "{ms_from_start}\t{phase}\t{vals}")
            .map_err(|e| format!("journal append: {e}"))?;
        self.rows += 1;
        Ok(())
    }

    /// Force the buffered bytes to the OS (best-effort; no fsync on the hot
    /// path so recording stays fast).
    pub fn flush(&mut self) {
        if let Some(w) = self.writer.as_mut() {
            let _ = w.flush();
        }
    }

    /// Drop the journal because the session finished successfully (saved or
    /// cancelled). Best-effort; leftovers are harmless.
    pub fn finish_ok(&mut self) {
        self.finished = true;
        self.writer.take();
        let _ = fs::remove_file(&self.path);
    }
}

/// Scan a directory for leftover (crash) journal files, newest first.
pub fn scan(dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("journal") {
                if let Ok(md) = fs::metadata(&p) {
                    if md.is_file() {
                        found.push(p);
                    }
                }
            }
        }
    }
    found.sort_by_key(|p| fs::metadata(p).and_then(|m| m.modified()).ok());
    found.reverse();
    found
}

/// Parse a `.journal` file back into a full `JournalSession`.
pub fn recover(path: &Path) -> Result<JournalSession, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("journal read {path:?}: {e}"))?;
    let mut lines = raw.lines();
    let header = lines.next().ok_or_else(|| "jourkh empty".to_string())?;
    let mut it = header.split('\t');
    if it.next() != Some(JOURNAL_MAGIC) {
        return Err(format!("{path:?} is not an OSMELL journal"));
    }
    let label = it.next().unwrap_or_default().to_string();
    let preset = it.next().unwrap_or_default().to_string();
    let rec_start_epoch_ms: f64 = it.next().and_then(|v| v.parse().ok()).ok_or("bad epoch")?;
    let baseline_sec: f64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let exposure_sec: f64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let recovery_sec: f64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let n_sensors: usize = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let names_json: &str = it.next().unwrap_or("[]");
    let channel_names: Vec<String> = serde_json::from_str(names_json).unwrap_or_default();

    let mut rows: Vec<(f64, String, Vec<f64>)> = Vec::new();
    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut f = line.splitn(3, '\t');
        let ms: f64 = f.next().and_then(|v| v.parse().ok()).ok_or("bad ms")?;
        let phase = f.next().unwrap_or_default().to_string();
        let vals: Vec<f64> = f
            .next()
            .unwrap_or_default()
            .split(',')
            .filter_map(|v| v.parse().ok())
            .collect();
        rows.push((ms, phase, vals));
    }

    Ok(JournalSession {
        path: path.to_path_buf(),
        label,
        preset,
        rec_start_epoch_ms,
        baseline_sec,
        exposure_sec,
        recovery_sec,
        n_sensors,
        channel_names,
        rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn write_and_parse_roundtrip() {
        let dir = std::env::temp_dir().join("osm_journal_roundtrip");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let names = vec!["CH1".into(), "CH2".into()];
        let mut j = AppendJournal::open(&dir, "test session", "6-sensor-full", 1700000000000.0, 30.0, 60.0, 30.0, 2, &names).unwrap();
        j.append(0.0, "baseline", &[1000.0, 2000.0]).unwrap();
        j.append(500.0, "baseline", &[1001.0, 2001.0]).unwrap();
        j.append(31000.0, "exposure", &[1100.0, 2100.0]).unwrap();
        j.flush();
        drop(j);

        let mut found = scan(&dir);
        assert_eq!(found.len(), 1, "journal file exists");
        let session = recover(&found.pop().unwrap()).unwrap();
        assert_eq!(session.label, "test session");
        assert_eq!(session.preset, "6-sensor-full");
        assert_eq!(session.channel_names, vec!["CH1", "CH2"]);
        assert_eq!(session.rows.len(), 3);
        assert_eq!(session.rows[0].1, "baseline");
        assert_eq!(session.rows[0].2, vec![1000.0, 2000.0]);
        assert_eq!(session.rows[2].1, "exposure");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn finish_removes_journal_file() {
        let dir = std::env::temp_dir().join("osm_journal_finish");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let mut j = AppendJournal::open(&dir, "gone", "", 0.0, 30.0, 60.0, 30.0, 1, &["C".into()]).unwrap();
        j.append(0.0, "baseline", &[1.0]).unwrap();
        j.finish_ok();

        let leftover = scan(&dir);
        assert!(leftover.is_empty(), "journal removed on finish_ok");
        let _ = fs::remove_dir_all(&dir);
    }
}
