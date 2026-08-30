//! Tolerant CSV parsing for session analysis — mirrors the quality-relevant
//! subset of `opensmell/opensmell/csv.py::parse_csv` (1:1 semantics).
//!
//! Never rejects on structure: a missing time column becomes synthetic 10 Hz
//! timing, context columns (environmental metadata) are never scored as sensor
//! channels, and every interpretation decision is surfaced as a warning that
//! gets merged into the quality report notes (parity with `app.py`).

use std::collections::BTreeMap;

/// `opensmell/csv.py MOX_CHANNEL_IDS`.
pub const MOX_CHANNEL_IDS: [&str; 6] = ["VOC", "Alcohol", "LPG", "CO", "NO2", "C2H5OH"];
/// `opensmell/types.py CONTEXT_COLUMN_HINTS`.
pub const CONTEXT_COLUMN_HINTS: [&str; 6] =
    ["temperature", "pressure", "humidity", "gas_res", "resistance", "altitude"];
/// `opensmell/types.py DEFAULT_SYNTHETIC_RATE_HZ`.
pub const DEFAULT_SYNTHETIC_RATE_HZ: f64 = 10.0;

#[derive(Debug, Clone)]
pub struct ParsedSession {
    pub time: Vec<f64>,
    pub channels: Vec<(String, Vec<f64>)>,
    pub guess_sampling_rate_hz: f64,
    pub non_finite: usize,
    pub unsorted: bool,
    pub warnings: Vec<String>,
}

/// Python `csv.py::_parse_row` (quote- and delimiter-aware).
fn parse_row(raw: &str, delim: char) -> Vec<String> {
    let mut cells: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            if in_quotes && i + 1 < chars.len() && chars[i + 1] == '"' {
                current.push('"');
                i += 1;
            } else {
                in_quotes = !in_quotes;
            }
        } else if c == delim && !in_quotes {
            cells.push(std::mem::take(&mut current));
        } else {
            current.push(c);
        }
        i += 1;
    }
    cells.push(current);
    cells
}

/// Python `csv.py::_detect_time_column_info`: returns `(name, "ms"|"s")`.
fn detect_time_column_info(header: &[String]) -> Option<(String, String)> {
    for raw in header {
        let n: String = raw
            .to_lowercase()
            .replace(['(', ')', '[', ']'], "")
            .split_whitespace()
            .collect();
        let n = n.as_str();
        if n == "timestamp" || n == "timestamp_ms" || n == "elapsed" || n == "elapsed_ms" {
            return Some((raw.clone(), "ms".to_string()));
        }
        if n == "time_ms" || n == "time" {
            return Some((raw.clone(), "ms".to_string()));
        }
        if n == "time_s" || n == "times" {
            return Some((raw.clone(), "s".to_string()));
        }
        if n == "synthetic_index" {
            return Some((raw.clone(), "ms".to_string()));
        }
    }
    None
}

/// Python `csv.py::_detect_delimiter`.
fn detect_delimiter(sample_line: &str) -> char {
    let mut best: (usize, char) = (0, ',');
    for c in [',', ';', '\t', '|'] {
        let n = sample_line.matches(c).count();
        if n > best.0 {
            best = (n, c);
        }
    }
    best.1
}

/// Python `csv.py::is_context_column`.
fn is_context_column(name: &str) -> bool {
    let n = name.to_lowercase();
    CONTEXT_COLUMN_HINTS.iter().any(|hint| n.contains(hint))
}

fn safe_float(raw: &str) -> Option<f64> {
    raw.trim().parse::<f64>().ok()
}

/// Python `csv.py::_parse_time_value`: plain numbers (ms or s) and HH:MM:SS[.mmm].
/// ISO/datetime strings are not supported here (the desktop recorder writes ms).
fn parse_time_value(raw: &str, unit: &str) -> Option<f64> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(n) = safe_float(s) {
        return Some(if unit == "s" { n * 1000.0 } else { n });
    }
    parse_clock(s)
}

/// Python clock regex `^(\d{1,3}):(\d{2}):(\d{2})(?:[.,](\d{1,6}))?$` → ms.
fn parse_clock(s: &str) -> Option<f64> {
    let (clock, frac_raw) = match s.rfind(['.', ',']) {
        Some(idx) => {
            let frac = &s[idx + 1..];
            if frac.is_empty()
                || frac.len() > 6
                || !frac.chars().all(|c| c.is_ascii_digit())
            {
                return None;
            }
            (&s[..idx], Some(frac))
        }
        None => (s, None),
    };
    let parts: Vec<&str> = clock.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let is_digits = |t: &str, max_digits: usize| {
        !t.is_empty() && t.len() <= max_digits && t.chars().all(|c| c.is_ascii_digit())
    };
    if !is_digits(parts[0], 3) || !is_digits(parts[1], 2) || !is_digits(parts[2], 2) {
        return None;
    }
    let h: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let sec: f64 = parts[2].parse().ok()?;
    if !(0.0..60.0).contains(&m) || !(0.0..60.0).contains(&sec) {
        return None;
    }
    let frac = match frac_raw {
        Some(fr) => fr.parse::<f64>().unwrap_or(0.0) / 10f64.powi(fr.len() as i32),
        None => 0.0,
    };
    Some((h * 3600.0 + m * 60.0 + sec) * 1000.0 + frac * 1000.0)
}

fn median(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    let m = if n % 2 == 0 {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    } else {
        v[n / 2]
    };
    Some(m)
}

/// Parse a CSV recording into the time/channel series the quality scorer needs.
pub fn parse_session_csv(text: &str) -> Result<ParsedSession, String> {
    let mut warnings: Vec<String> = Vec::new();

    let rows: Vec<String> = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| l.to_string())
        .collect();

    if rows.is_empty() {
        return Err("The CSV file is empty.".to_string());
    }
    if rows.len() == 1 {
        return Err("The CSV has a header but no data rows.".to_string());
    }

    let delim = detect_delimiter(&rows[1]);
    if delim != ',' {
        let escaped = match delim {
            ';' => ";",
            '\t' => "\\t",
            '|' => "|",
            _ => ",",
        };
        warnings.push(format!(
            "Detected \"{}\"-delimited values; parsed accordingly. Convert to comma-delimited CSV for widest tool compatibility.",
            escaped
        ));
    }

    let header: Vec<String> = parse_row(&rows[0], delim)
        .into_iter()
        .map(|h| h.trim().to_string())
        .collect();
    if header.is_empty() {
        return Err("The CSV has no columns.".to_string());
    }

    let time_info = detect_time_column_info(&header);
    let time_col: Option<String> = time_info.as_ref().map(|(n, _)| n.clone());
    let time_unit: String = time_info.as_ref().map(|(_, u)| u.clone()).unwrap_or_else(|| "ms".to_string());
    let mut synthetic_time = time_col.is_none();
    if synthetic_time {
        warnings.push(
            "No time column found (expected timestamp_ms or elapsed_ms); synthesized 10 Hz timing from row index. Add a timestamp column for accurate time-based features.".to_string(),
        );
    }

    let mut time_idx = time_col.as_ref().and_then(|c| header.iter().position(|h| h == c));
    let context_columns: Vec<String> = header
        .iter()
        .enumerate()
        .filter(|(i, h)| Some(*i) != time_idx && is_context_column(h))
        .map(|(_, h)| h.clone())
        .collect();
    if !context_columns.is_empty() {
        warnings.push(format!(
            "Detected context column(s) kept as metadata, not scored: {}.",
            context_columns.join(", ")
        ));
    }

    let sensor_candidates: Vec<String> = header
        .iter()
        .enumerate()
        .filter(|(i, h)| Some(*i) != time_idx && !context_columns.contains(h))
        .map(|(_, h)| h.clone())
        .collect();

    // First pass: columns with at least one numeric cell become channels.
    let mut numeric: BTreeMap<String, usize> = BTreeMap::new();
    for r in rows.iter().skip(1) {
        let cells = parse_row(r, delim);
        for c in &sensor_candidates {
            if let Some(idx) = header.iter().position(|h| h == c) {
                if idx < cells.len() && safe_float(cells[idx].as_str()).is_some() {
                    *numeric.entry(c.clone()).or_insert(0) += 1;
                }
            }
        }
    }
    let channel_ids: Vec<String> = sensor_candidates
        .iter()
        .filter(|c| numeric.get(*c).map(|n| *n > 0).unwrap_or(false))
        .cloned()
        .collect();
    if channel_ids.is_empty() {
        return Err("No numeric sensor columns found.".to_string());
    }
    let skipped: Vec<String> = sensor_candidates
        .iter()
        .filter(|c| !channel_ids.contains(*c))
        .cloned()
        .collect();
    if !skipped.is_empty() {
        warnings.push(format!("Non-numeric column(s) skipped: {}.", skipped.join(", ")));
    }
    let unknown: Vec<String> = channel_ids
        .iter()
        .filter(|c| !MOX_CHANNEL_IDS.contains(&c.as_str()))
        .cloned()
        .collect();
    if !unknown.is_empty() {
        warnings.push(format!(
            "Column(s) not in the MOX set treated as sensor channels: {}.",
            unknown.join(", ")
        ));
    }

    // Pre-scan: a detected-but-unreadable time column falls back to synthetic
    // timing so every data row is still adopted (Python: csv.py:231-254).
    if !synthetic_time {
        let mut parsed = 0usize;
        let mut checked = 0usize;
        for r in rows.iter().skip(1) {
            if checked >= 25 {
                break;
            }
            let cells = parse_row(r, delim);
            if cells.len() != header.len() {
                continue;
            }
            checked += 1;
            if let Some(idx) = time_idx {
                if parse_time_value(&cells[idx], &time_unit).is_some() {
                    parsed += 1;
                }
            }
        }
        if parsed == 0 {
            synthetic_time = true;
            time_idx = None;
            let col = time_col.clone().unwrap_or_default();
            warnings.push(format!(
                "Column \"{}\" was not readable as time (expected ms, epoch seconds, ISO datetime or HH:MM:SS); synthesized 10 Hz timing instead.",
                col
            ));
        }
    }

    let mut samples: Vec<(f64, BTreeMap<String, f64>)> = Vec::new();
    let mut non_finite = 0usize;

    for r in rows.iter().skip(1) {
        let cells = parse_row(r, delim);
        if cells.len() != header.len() {
            continue;
        }
        let raw_time = if let Some(idx) = time_idx {
            let v = parse_time_value(&cells[idx], &time_unit);
            match v {
                Some(t) => t,
                None => {
                    non_finite += 1;
                    continue;
                }
            }
        } else {
            samples.len() as f64 * 100.0
        };

        let mut values: BTreeMap<String, f64> = BTreeMap::new();
        let mut row_non_finite = false;
        for ch in &channel_ids {
            let col_idx = header.iter().position(|h| h == ch).unwrap();
            let raw = safe_float(&cells[col_idx]);
            match raw {
                Some(v) => {
                    values.insert(ch.clone(), v);
                }
                None => {
                    non_finite += 1;
                    row_non_finite = true;
                }
            }
        }
        if row_non_finite {
            continue;
        }
        samples.push((raw_time, values));
    }

    // Numeric time that clearly sits in epoch-seconds range (≈2001–2036) is
    // scaled to ms. Mirrors csv.py:252: `times[len(times)//2]` (upper-middle,
    // no averaging) and is gated on a real time column like Python.
    if !synthetic_time && !samples.is_empty() {
        let mut sorted: Vec<f64> = samples.iter().map(|(t, _)| *t).collect();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let median_time = sorted[sorted.len() / 2];
        if (1_200_000_000.0..=4_000_000_000.0).contains(&median_time) {
            for s in samples.iter_mut() {
                s.0 *= 1000.0;
            }
            warnings.push("Time column read as epoch seconds and converted to milliseconds.".to_string());
        }
    }

    let mut unsorted = false;
    for i in 1..samples.len() {
        if samples[i].0 < samples[i - 1].0 {
            unsorted = true;
            break;
        }
    }
    if unsorted {
        samples.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        warnings.push("Rows were out of order and were sorted.".to_string());
    }

    let mut gaps: Vec<f64> = samples.windows(2).map(|w| w[1].0 - w[0].0).collect();
    gaps.retain(|g| *g > 0.0);
    let median_gap = median(&gaps);
    let mut guess_sampling_rate_hz = match median_gap {
        Some(mg) => 1000.0 / mg,
        None => DEFAULT_SYNTHETIC_RATE_HZ,
    };
    if synthetic_time {
        guess_sampling_rate_hz = DEFAULT_SYNTHETIC_RATE_HZ;
    }

    let channels: Vec<(String, Vec<f64>)> = channel_ids
        .iter()
        .map(|cid| {
            let vals = samples.iter().map(|(_, v)| v.get(cid).copied().unwrap_or(f64::NAN)).collect();
            (cid.clone(), vals)
        })
        .collect();

    Ok(ParsedSession {
        time: samples.iter().map(|(t, _)| *t).collect(),
        channels,
        guess_sampling_rate_hz,
        non_finite,
        unsorted,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recorder_csv(n: usize) -> String {
        let mut s = String::from("timestamp_ms,VOC,Alcohol,LPG,CO,NO2,C2H5OH\n");
        for i in 0..n {
            let t = i * 100;
            s.push_str(&format!(
                "{t},900.0,920.0,880.0,1500.0,300.0,1200.0\n"
            ));
        }
        s
    }

    #[test]
    fn parses_recorder_csv() {
        let p = parse_session_csv(&recorder_csv(120)).unwrap();
        assert_eq!(p.time.len(), 120);
        assert_eq!(p.time[0], 0.0);
        assert_eq!(p.time[119], 11900.0);
        assert_eq!(p.channels.len(), 6);
        assert_eq!(p.channels[0].0, "VOC");
        assert_eq!(p.channels[0].1.len(), 120);
        assert_eq!(p.guess_sampling_rate_hz, 10.0);
        assert_eq!(p.non_finite, 0);
        assert!(!p.unsorted);
        assert!(p.warnings.is_empty());
    }

    #[test]
    fn quotes_and_embedded_delimiter() {
        let csv = "timestamp_ms,\"VOC,Total\",CO\n0,1000.5,1.5\n100,1100.0,3.0\n";
        let p = parse_session_csv(csv).unwrap();
        assert_eq!(p.channels.len(), 2);
        assert_eq!(p.channels[0].0, "VOC,Total");
        assert_eq!(p.channels[0].1, vec![1000.5, 1100.0]);
        assert_eq!(p.channels[1].1, vec![1.5, 3.0]);
    }

    #[test]
    fn semicolon_detected_with_warning() {
        let csv = "timestamp_ms;VOC;CO\n0;1.0;2.0\n100;3.0;4.0\n";
        let p = parse_session_csv(csv).unwrap();
        assert!(p
            .warnings
            .iter()
            .any(|w| w.contains("\";\"-delimited")));
        assert_eq!(p.channels.len(), 2);
        assert_eq!(p.time[1], 100.0);
    }

    #[test]
    fn missing_time_column_is_synthetic() {
        let csv = "VOC,Alcohol\n1.0,2.0\n3.0,4.0\n5.0,6.0\n";
        let p = parse_session_csv(csv).unwrap();
        assert!(p
            .warnings
            .iter()
            .any(|w| w.contains("synthesized 10 Hz timing from row index")));
        assert_eq!(p.time, vec![0.0, 100.0, 200.0]);
        assert_eq!(p.guess_sampling_rate_hz, DEFAULT_SYNTHETIC_RATE_HZ);
        assert_eq!(p.channels.len(), 2);
    }

    #[test]
    fn unreadable_time_col_falls_back_to_synthetic() {
        let csv = "timestamp_ms,VOC,CO\nblah,1.0,2.0\nnoway,3.0,4.0\nnope,5.0,6.0\n";
        let p = parse_session_csv(csv).unwrap();
        assert!(p.warnings.iter().any(|w| w.contains(
            "Column \"timestamp_ms\" was not readable as time"
        )));
        assert_eq!(p.time, vec![0.0, 100.0, 200.0]);
        assert_eq!(p.guess_sampling_rate_hz, DEFAULT_SYNTHETIC_RATE_HZ);
        assert_eq!(p.channels.len(), 2);
        assert_eq!(p.channels[1].1, vec![2.0, 4.0, 6.0]);
    }

    #[test]
    fn epoch_seconds_scaled_to_ms() {
        let mut csv = String::from("timestamp_ms,VOC\n");
        for i in 0..5 {
            csv.push_str(&format!("{}.0,{}.0\n", 1_700_000_000 + i, 1000 + i));
        }
        let p = parse_session_csv(&csv).unwrap();
        assert!(p
            .warnings
            .iter()
            .any(|w| w.contains("epoch seconds and converted to milliseconds")));
        assert_eq!(p.time[0], 1_700_000_000_000.0);
        assert_eq!(p.time[4], 1_700_000_004_000.0);
    }

    #[test]
    fn clock_style_time_parsed() {
        let csv = "time,CO\n\"00:00:00.500\",1.0\n\"00:00:02.250\",2.0\n";
        let p = parse_session_csv(csv).unwrap();
        assert_eq!(p.time[0], 500.0);
        assert_eq!(p.time[1], 2250.0);
    }

    #[test]
    fn context_columns_kept_not_scored() {
        let csv =
            "timestamp_ms,VOC,Temperature,Humidity,CO\n0,1.0,23.5,40.0,2.0\n100,3.0,23.6,41.0,4.0\n";
        let p = parse_session_csv(csv).unwrap();
        assert!(p
            .warnings
            .iter()
            .any(|w| w.contains("context column(s)") && w.contains("Temperature, Humidity")));
        assert!(p.channels.iter().all(|(c, _)| c != "Temperature"));
    }

    #[test]
    fn non_numeric_column_skipped() {
        let csv = "timestamp_ms,VOC,CO,note\n0,1.0,2.0,hello\n100,3.0,4.0,world\n";
        let p = parse_session_csv(csv).unwrap();
        assert!(p
            .warnings
            .iter()
            .any(|w| w.contains("Non-numeric column(s) skipped: note")));
        assert!(p.channels.iter().all(|(c, _)| c != "note"));
    }

    #[test]
    fn unknown_column_treated_as_sensor() {
        let csv = "timestamp_ms,VOC,smell\n0,1.0,7.0\n100,2.0,8.0\n";
        let p = parse_session_csv(csv).unwrap();
        assert!(p
            .warnings
            .iter()
            .any(|w| w.contains("not in the MOX set treated as sensor channels: smell")));
        assert!(p.channels.iter().any(|(c, _)| c == "smell"));
    }

    #[test]
    fn unsorted_rows_are_sorted() {
        let csv = "timestamp_ms,VOC,CO\n200,1.0,2.0\n0,3.0,4.0\n100,5.0,6.0\n";
        let p = parse_session_csv(csv).unwrap();
        assert!(p.unsorted);
        assert!(p.warnings.iter().any(|w| w.contains("out of order and were sorted")));
        assert_eq!(p.time, vec![0.0, 100.0, 200.0]);
        assert_eq!(p.channels[0].1, vec![3.0, 5.0, 1.0]);
    }

    #[test]
    fn structural_errors() {
        assert!(parse_session_csv("").is_err());
        assert!(parse_session_csv("timestamp_ms,VOC\n").is_err());
        assert!(parse_session_csv("a,b\n\n").is_err());
    }

    #[test]
    fn no_numeric_columns_errors() {
        let csv = "timestamp_ms,a,b\n0,x,y\n100,xx,yy\n";
        assert!(parse_session_csv(csv).is_err());
    }
}