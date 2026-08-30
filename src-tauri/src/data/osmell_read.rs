//! Read a `.osmell` bundle (ZIP: manifest.json + data.csv + optional events.json)
//! for session analysis — mirrors `opensmell/opensmell/io.py::parse_osmell`.

use std::fs;
use std::io::Read;
use std::path::Path;

use serde_json::Value;

use super::csv_parse::parse_session_csv;

/// A `.osmell` bundle reduced to what the quality scorer needs (manifest params
/// + time/channel series). Events are carried for future analysis panels.
#[derive(Debug, Clone)]
pub struct OsmellBundle {
    pub sensor_type: String,
    pub channels: Vec<(String, Vec<f64>)>,
    pub time: Vec<f64>,
    pub adc_max: Option<f64>,
    pub sampling_rate_hz: Option<f64>,
    pub role: String,
    pub baseline_source: String,
    pub r0_samples: Option<usize>,
    pub events: Vec<Value>,
}

/// Read a `.osmell` bundle from disk (io.py::parse_osmell_file).
pub fn read_osmell(path: &Path) -> Result<OsmellBundle, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    let names: Vec<String> = archive.file_names().map(|s| s.to_string()).collect();
    if !names.iter().any(|n| n == "manifest.json") || !names.iter().any(|n| n == "data.csv") {
        return Err("Not a valid .osmell file: missing manifest.json or data.csv.".to_string());
    }

    let manifest: Value = {
        let mut entry = archive
            .by_name("manifest.json")
            .map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        serde_json::from_slice(&buf).map_err(|e| e.to_string())?
    };

    let sensor = &manifest["sensor"];
    let sensor_type = sensor
        .get("sensorType")
        .and_then(|v| v.as_str())
        .unwrap_or("mox")
        .to_string();
    let channel_ids: Vec<String> = sensor
        .get("channels")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| c.get("id").and_then(|id| id.as_str()))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    let adc_max = sensor
        .get("adcMax")
        .and_then(|v| v.as_f64())
        .map(|v| v as f64);
    let sampling_rate_hz = sensor.get("samplingRateHz").and_then(|v| v.as_f64());

    let session = &manifest["session"];
    let role = session
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("single")
        .to_string();

    let baseline = manifest.get("baseline");
    let baseline_source = baseline
        .and_then(|b| b.get("source"))
        .and_then(|v| v.as_str())
        .unwrap_or("none")
        .to_string();
    let r0_samples = baseline
        .and_then(|b| b.get("r0Samples"))
        .and_then(|v| v.as_u64())
        .map(|v| v as usize);

    let csv_text = {
        let mut csv_entry = archive.by_name("data.csv").map_err(|e| e.to_string())?;
        let mut csv_buf = Vec::new();
        csv_entry.read_to_end(&mut csv_buf).map_err(|e| e.to_string())?;
        String::from_utf8(csv_buf).map_err(|e| e.to_string())?
    };
    let parsed = parse_session_csv(&csv_text)?;

    if parsed.time.is_empty() {
        return Err("The .osmell data.csv is empty.".to_string());
    }

    // io.py: data columns must match the declared manifest channels, both ways.
    for (cid, _) in &parsed.channels {
        if !channel_ids.contains(cid) {
            return Err(format!(
                "data.csv has column \"{}\" not declared in the manifest.",
                cid
            ));
        }
    }
    for cid in &channel_ids {
        if !parsed.channels.iter().any(|(id, _)| id == cid) {
            return Err(format!(
                "Manifest channel \"{}\" is missing from data.csv.",
                cid
            ));
        }
    }

    let events: Vec<Value> = if names.iter().any(|n| n == "events.json") {
        let mut entry = archive.by_name("events.json").map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        serde_json::from_slice::<Vec<Value>>(&buf).unwrap_or_default()
    } else {
        Vec::new()
    };

    Ok(OsmellBundle {
        sensor_type,
        channels: parsed.channels,
        time: parsed.time,
        adc_max,
        sampling_rate_hz,
        role,
        baseline_source,
        r0_samples,
        events,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    fn write_bundle(dir: &Path, name: &str, manifest: &str, csv: &str, events: Option<&str>) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        let file = fs::File::create(&path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        writer.start_file("manifest.json", opts).unwrap();
        writer.write_all(manifest.as_bytes()).unwrap();
        writer.start_file("data.csv", opts).unwrap();
        writer.write_all(csv.as_bytes()).unwrap();
        if let Some(ev) = events {
            writer.start_file("events.json", opts).unwrap();
            writer.write_all(ev.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
        path
    }

    const MANIFEST: &str = r#"{
        "sensor": { "sensorType": "mox", "adcMax": 4095, "samplingRateHz": 10,
                    "channels": [{"id": "VOC"}, {"id": "CO"}] },
        "session": { "role": "exposure" },
        "baseline": { "source": "auto", "r0Samples": 15 }
    }"#;

    const CSV: &str = "timestamp_ms,VOC,CO\n0,1000.0,200.0\n100,1100.0,250.0\n200,1200.0,300.0\n";

    #[test]
    fn reads_bundle_with_events() {
        let dir = std::env::temp_dir().join("osm_test_bundle_ok");
        let _ = fs::remove_dir_all(&dir);
        let path = write_bundle(
            &dir,
            "a.osmell",
            MANIFEST,
            CSV,
            Some("[{\"type\":\"stimulus\",\"at\":0.1}]"),
        );
        let b = read_osmell(&path).unwrap();
        assert_eq!(b.sensor_type, "mox");
        assert_eq!(b.adc_max, Some(4095.0));
        assert_eq!(b.sampling_rate_hz, Some(10.0));
        assert_eq!(b.role, "exposure");
        assert_eq!(b.baseline_source, "auto");
        assert_eq!(b.r0_samples, Some(15));
        assert_eq!(b.channels.len(), 2);
        assert_eq!(b.channels[0].0, "VOC"); // header column order
        assert_eq!(b.channels[1].0, "CO");
        assert_eq!(b.time, vec![0.0, 100.0, 200.0]);
        assert_eq!(b.events.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_members_rejected() {
        let dir = std::env::temp_dir().join("osm_test_bundle_missing");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = fs::File::create(dir.join("bad.osmell")).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        writer
            .start_file("data.csv", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(CSV.as_bytes()).unwrap();
        writer.finish().unwrap();
        let err = read_osmell(&dir.join("bad.osmell")).unwrap_err();
        assert!(err.contains("missing manifest.json or data.csv"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn channel_mismatch_rejected_both_ways() {
        let dir = std::env::temp_dir().join("osm_test_bundle_mismatch");
        let _ = fs::remove_dir_all(&dir);

        let path = write_bundle(&dir, "extra.osmell", MANIFEST, "timestamp_ms,VOC,CO,EXTRA\n0,1.0,2.0,3.0\n", None);
        let err = read_osmell(&path).unwrap_err();
        assert!(err.contains("\"EXTRA\" not declared in the manifest"));

        let manifest_declares = MANIFEST.replace(
            "{\"id\": \"VOC\"}, {\"id\": \"CO\"}",
            "{\"id\": \"VOC\"}, {\"id\": \"GAS\"}",
        );
        let path2 = write_bundle(&dir, "missing.osmell", &manifest_declares, "timestamp_ms,VOC\n0,1.0\n", None);
        let err = read_osmell(&path2).unwrap_err();
        assert!(err.contains("Manifest channel \"GAS\" is missing from data.csv"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn field_defaults_when_absent() {
        let dir = std::env::temp_dir().join("osm_test_bundle_minima");
        let _ = fs::remove_dir_all(&dir);
        let manifest = r#"{"sensor": {"sensorType": "mox", "channels": [{"id": "VOC"}]}}"#;
        let path = write_bundle(&dir, "min.osmell", manifest, "timestamp_ms,VOC\n0,1.0\n", None);
        let b = read_osmell(&path).unwrap();
        assert_eq!(b.adc_max, None);
        assert_eq!(b.sampling_rate_hz, None);
        assert_eq!(b.role, "single");
        assert_eq!(b.baseline_source, "none");
        assert_eq!(b.r0_samples, None);
        assert!(b.events.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}