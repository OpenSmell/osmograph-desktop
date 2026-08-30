//! Session export helpers: copy a session file, or convert a session CSV into
//! a valid `.osmell` bundle (ZIP: manifest.json + data.csv + events.json).
//!
//! Mirrors the Python app's ability to re-export a recorded session in the
//! OSMELL interchange format. Native sessions are already CSV in the desktop,
//! so conversion produces a single-phase `before-during-after` bundle wrapping
//! the whole recording.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::json;

use super::csv_parse::{parse_session_csv, MOX_CHANNEL_IDS};
use super::{SessionIndex, sanitize_label};

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

/// Copy a session's underlying file to `output_path`. Trivial but useful for
/// "export selected session" — works for both CSV and OSMELL sources.
pub fn export_session_copy(
    index: &SessionIndex,
    file_id: &str,
    output_path: &Path,
) -> Result<String, String> {
    let src: PathBuf = index
        .records
        .iter()
        .find(|r| r.file_id == file_id)
        .map(|r| r.csv_path.clone().into())
        .ok_or_else(|| format!("No session with file_id \"{}\"", file_id))?;

    if !src.is_file() {
        return Err(format!("Source file not found: {}", src.display()));
    }
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(&src, output_path).map_err(|e| e.to_string())?;
    Ok(format!(
        "Exported {} -> {}",
        src.file_name().unwrap_or_default().to_string_lossy(),
        output_path.file_name().unwrap_or_default().to_string_lossy()
    ))
}

/// Convert a session CSV into a valid `.osmell` ZIP bundle at `output_path`.
pub fn export_session_osmell(
    index: &SessionIndex,
    file_id: &str,
    output_path: &Path,
) -> Result<String, String> {
    let rec = index
        .records
        .iter()
        .find(|r| r.file_id == file_id)
        .ok_or_else(|| format!("No session with file_id \"{}\"", file_id))?;

    let text = fs::read_to_string(&rec.csv_path)
        .map_err(|e| format!("Failed to read {}: {}", rec.csv_path, e))?;
    let parsed = parse_session_csv(&text)?;

    let channel_ids: Vec<&str> = parsed
        .channels
        .iter()
        .map(|(id, _)| id.as_str())
        .collect();
    // Fall back to MOX channel ids if none parsed.
    let channel_ids: Vec<&str> = if channel_ids.is_empty() {
        MOX_CHANNEL_IDS.to_vec()
    } else {
        channel_ids
    };

    // Serialize to CSV: timestamp_ms + one column per channel.
    let mut csv = String::from("timestamp_ms");
    for cid in &channel_ids {
        csv.push(',');
        csv.push_str(cid);
    }
    csv.push('\n');
    for (i, t) in parsed.time.iter().enumerate() {
        csv.push_str(&t.to_string());
        for (_id, values) in parsed.channels.iter() {
            csv.push(',');
            let v = values.get(i).copied().unwrap_or(f64::NAN);
            if v.is_finite() {
                csv.push_str(&format!("{:.6}", v));
            } else {
                csv.push_str("");
            }
        }
        // If channels list was empty we padded nothing; ensure row length.
        if parsed.channels.is_empty() {
            for _ in channel_ids.iter() {
                csv.push(',');
            }
        }
        csv.push('\n');
    }

    let label = if rec.substance.is_empty() || rec.substance == "unknown" {
        sanitize_label(&rec.label)
    } else {
        sanitize_label(&rec.substance)
    };
    let recorded_at = Some(rec.timestamp * 1000.0);

    let manifest = json!({
        "osmell": {"formatVersion": "1.0.0"},
        "sensor": {
            "sensorType": "mox",
            "channels": channel_ids.iter().map(|cid| json!({"id": cid, "unit": "adc"})).collect::<Vec<_>>(),
            "samplingRateHz": parsed.guess_sampling_rate_hz,
            "timeColumn": "timestamp_ms",
        },
        "session": {
            "role": "single",
            "label": label,
            "groupId": label,
            "recordedAt": recorded_at,
            "durationMs": (parsed.time.last().copied().unwrap_or(0.0) * 1000.0).clamp(0.0, f64::MAX),
        },
        "software": {"recorder": "Osmograph"},
        "recording": {
            "protocol": "before-during-after",
            "phases": {
                "exposure": {
                    "name": "exposure",
                    "startMs": 0,
                    "durationMs": (parsed.time.last().copied().unwrap_or(0.0) * 1000.0).clamp(0.0, f64::MAX),
                    "sampleCount": parsed.time.len(),
                }
            },
            "deadChannels": [],
            "totalChannels": channel_ids.len(),
            "activeChannels": channel_ids.len(),
        }
    });

    let manifest_str = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    let events_str = serde_json::to_string(&json!([])).map_err(|e| e.to_string())?;

    write_bundle(output_path, &manifest_str, &csv, &events_str)?;
    Ok(format!(
        "Exported .osmell -> {}",
        output_path.file_name().unwrap_or_default().to_string_lossy()
    ))
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    fn write_csv(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(body.as_bytes()).unwrap();
    }

    #[test]
    fn copies_session_file() {
        let dir = std::env::temp_dir().join("osm_export_copy");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("session_a.csv");
        write_csv(&src, "timestamp_ms,VOC,CO\n0,1000.0,20.0\n100,1100.0,25.0\n");

        let mut idx = SessionIndex::default();
        idx.upsert(super::super::SessionRecord {
            file_id: "a".into(),
            substance: "coffee".into(),
            label: "coffee".into(),
            timestamp: 1_000.0,
            duration_sec: 1.0,
            sensor_count: 2,
            quality: 80.0,
            csv_path: src.to_string_lossy().to_string(),
            opensmell_result: None,
            quality_report: None,
            preset_name: String::new(),
            notes: String::new(),
        });

        let out = dir.join("out/session_a_export.csv");
        let msg = export_session_copy(&idx, "a", &out).unwrap();
        assert!(msg.contains("Exported"));
        assert!(out.is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn converts_csv_to_osmell_bundle() {
        let dir = std::env::temp_dir().join("osm_export_osmell");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("session_a.csv");
        let content = "timestamp_ms,VOC,CO\n0,1000.0,20.0\n100,1100.0,25.0\n200,1300.0,30.0\n";
        write_csv(&src, content);

        let mut idx = SessionIndex::default();
        idx.upsert(super::super::SessionRecord {
            file_id: "a".into(),
            substance: "coffee".into(),
            label: "coffee".into(),
            timestamp: 1_000.0,
            duration_sec: 1.0,
            sensor_count: 2,
            quality: 80.0,
            csv_path: src.to_string_lossy().to_string(),
            opensmell_result: None,
            quality_report: None,
            preset_name: String::new(),
            notes: String::new(),
        });

        let out = dir.join("out/session_a.osmell");
        let msg = export_session_osmell(&idx, "a", &out).unwrap();
        assert!(msg.contains("Exported .osmell"));
        assert!(out.is_file());

        // read back the bundle
        let bundle = super::super::osmell_read::read_osmell(&out).unwrap();
        assert_eq!(bundle.channels.len(), 2);
        assert_eq!(bundle.channels[0].1.len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
