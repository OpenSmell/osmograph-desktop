//! Data Hub: local contribution review + Hugging Face community sync.
//!
//! Local hub operations mirror `data_commons::VerificationPipeline` and let the
//! desktop app manage the full lifecycle (Pending -> Approved -> Published)
//! before anything leaves the machine. Community sync is split by trust:
//!
//! - **Download** uses only the public, read-only Hugging Face dataset API, so
//!   no token is ever required (or sent).
//! - **Upload** requires a write token. The token is **never persisted to
//!   disk, embedded in the binary, or committed**. The user is prompted for it
//!   at each upload; it is held in memory only for the duration of that single
//!   request and then dropped. Only `Published` (human-vetted) contributions
//!   can be uploaded.

use std::fs;
use std::io::BufRead;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::{SessionIndex, SessionRecord};

// ---------------------------------------------------------------------------
// In-memory Hugging Face write token (never persisted to disk)
// ---------------------------------------------------------------------------

static HF_TOKEN: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn hf_token_guard() -> &'static Mutex<Option<String>> {
    HF_TOKEN.get_or_init(|| Mutex::new(None))
}

/// Retain the token in memory only; never written to disk. Populated from the
/// user prompt at upload time. Returns an error (and clears the value) if the
/// token is empty.
pub fn set_hf_token(token: &str) -> Result<(), String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        *hf_token_guard().lock().unwrap() = None;
        return Err("Token is empty".to_string());
    }
    *hf_token_guard().lock().unwrap() = Some(token);
    Ok(())
}

/// Has a write token been supplied in this session?
pub fn has_hf_token() -> bool {
    hf_token_guard().lock().unwrap().is_some()
}

/// Drop the in-memory token so it does not linger in the process.
pub fn clear_hf_token() {
    *hf_token_guard().lock().unwrap() = None;
}

fn read_hf_token() -> Result<String, String> {
    hf_token_guard()
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| {
            "No Hugging Face write token in memory. Enter one in the Data Hub panel to enable uploads."
                .to_string()
        })
}

// ---------------------------------------------------------------------------
// HF dataset file listing + download (public, read-only)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HfFile {
    pub path: String,
    pub size: u64,
}

fn hf_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(120)))
        .build()
        .into()
}

/// List the files at the root of a public HF dataset repository.
pub fn hf_list_dataset_files(repo: &str) -> Result<Vec<HfFile>, String> {
    let url = format!("https://huggingface.co/api/datasets/{}/tree/main", repo);
    let body = hf_agent()
        .get(&url)
        .call()
        .map_err(|e| format!("Failed to reach HF dataset '{}': {}", repo, e))?;
    #[derive(Deserialize)]
    struct Entry {
        path: String,
        size: Option<u64>,
    }
    let entries: Vec<Entry> = body
        .into_body()
        .read_json()
        .map_err(|e| format!("Bad HF response: {}", e))?;
    Ok(entries
        .into_iter()
        .map(|e| HfFile {
            path: e.path,
            size: e.size.unwrap_or(0),
        })
        .collect())
}

/// Download a file from a public HF dataset into `recordings_dir/hf_downloads`.
/// Returns the destination path on success.
pub fn hf_download_file(
    recordings_dir: &Path,
    repo: &str,
    filename: &str,
) -> Result<String, String> {
    if filename.contains("..") || filename.contains('/') {
        return Err(format!("Refusing unsafe file name: {}", filename));
    }
    let dest_dir = recordings_dir.join("hf_downloads");
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(filename);
    let enc = urlencoding::encode(filename);
    let url = format!(
        "https://huggingface.co/datasets/{}/resolve/main/{}",
        repo, enc
    );
    let body = hf_agent()
        .get(&url)
        .call()
        .map_err(|e| format!("Download failed for '{}': {}", filename, e))?;

    let mut reader = body.into_body().into_reader();
    let mut file = fs::File::create(&dest).map_err(|e| e.to_string())?;
    std::io::copy(&mut reader, &mut file).map_err(|e| e.to_string())?;

    Ok(dest.to_string_lossy().to_string())
}

/// Best-effort classify an HF download by extension so the caller can import it.
pub fn download_extension(filename: &str) -> String {
    Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

// ---------------------------------------------------------------------------
// HF upload (write token required)
// ---------------------------------------------------------------------------

/// Upload a vetted contribution's CSV to a HF dataset using the stored write
/// token. Builds the `multipart/form-data` body manually (no extra crate).
/// Returns the committed path on the hub.
pub fn hf_upload_csv(repo: &str, csv_path: &Path, commit_msg: &str) -> Result<String, String> {
    let token = read_hf_token()?;
    let csv = fs::read(csv_path).map_err(|e| e.to_string())?;
    let filename = csv_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "session.csv".to_string())
        .replace([' ', '(', ')', '&', '#', '%', '?'], "_");

    let boundary = format!(
        "----osmograph{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let mut body = Vec::new();

    // metadata part
    {
        let meta_field = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"; filename=\"session_meta.json\"\r\nContent-Type: application/json\r\n\r\n{{}}\r\n",
            boundary = boundary
        );
        body.extend_from_slice(meta_field.as_bytes());
    }
    // file part
    {
        let header = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: text/csv\r\n\r\n",
            boundary = boundary, filename = filename
        );
        body.extend_from_slice(header.as_bytes());
        body.extend_from_slice(&csv);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

    let url = format!(
        "https://huggingface.co/api/datasets/{}/upload?commitDescription={}",
        repo,
        urlencoding::encode(commit_msg)
    );

    let resp = hf_agent()
        .post(&url)
        .header("Authorization", &format!("Bearer {}", token))
        .header("Content-Type", &format!("multipart/form-data; boundary={}", boundary))
        .send(body)
        .map_err(|e| format!("Upload failed: {}", e))?;

    #[derive(Deserialize)]
    struct UploadResp {
        path: Option<String>,
        error: Option<String>,
    }
    let status = resp.status();
    let parsed: Result<UploadResp, _> = resp.into_body().read_json();
    if status == 200 || status == 201 {
        if let Ok(r) = parsed {
            if let Some(err) = r.error {
                return Err(format!("HF upload rejected: {}", err));
            }
            return Ok(r.path.unwrap_or(filename));
        }
        Ok(filename)
    } else {
        let msg = parsed
            .ok()
            .and_then(|r| r.error)
            .unwrap_or_else(|| format!("HTTP {}", status));
        Err(format!("HF upload rejected: {}", msg))
    }
}

// ---------------------------------------------------------------------------
// Local import of external/research CSVs into the library
// ---------------------------------------------------------------------------

fn substance_from_filename(name: &str) -> String {
    let stem = name.strip_suffix(".csv").unwrap_or(name);
    let mut parts = stem.splitn(3, '_');
    let _date = parts.next();
    let _time = parts.next();
    let label = parts.next().unwrap_or("").replace(['_', '-'], " ").trim().to_string();
    let lower = label.to_lowercase();
    if ["room air", "air", "fresh", "baseline", "unknown", "empty", "blank", "clean"]
        .iter()
        .any(|k| lower.contains(k))
    {
        "unknown".to_string()
    } else {
        label
    }
}

/// Lightweight header/rows/duration scan of a CSV (same semantics as the
/// library's `parse_csv_summary`).
fn csv_summary_for(path: &Path) -> (usize, usize, f64) {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (0, 0, 0.0),
    };
    let reader = std::io::BufReader::new(file);
    let mut rows = 0usize;
    let mut sensor_count = 0usize;
    let mut header_checked = false;
    let mut first_ts: Option<f64> = None;
    let mut last_ts: Option<f64> = None;
    for line in reader.lines().flatten() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if !header_checked {
            header_checked = true;
            let cols = line.split(',').count();
            let has_ts = line.to_lowercase().starts_with("timestamp");
            sensor_count = cols.saturating_sub(if has_ts { 1 } else { 0 });
            continue;
        }
        rows += 1;
        if let Some(first) = line.split(',').next() {
            if let Ok(v) = first.trim().parse::<f64>() {
                if first_ts.is_none() {
                    first_ts = Some(v);
                }
                last_ts = Some(v);
            }
        }
    }
    let duration = match (first_ts, last_ts) {
        (Some(a), Some(b)) => ((b - a) / 1000.0).max(0.0),
        _ => 0.0,
    };
    (rows, sensor_count, duration)
}

/// Copy an external CSV into `recordings_dir` and index it. Reuses the same
/// file_id/naming conventions as recorder output so the library and analysis
/// panels treat imported data identically to local recordings.
pub fn import_external_csv(
    recordings_dir: &Path,
    index: &mut SessionIndex,
    src_path: &Path,
) -> Result<SessionRecord, String> {
    if !src_path.is_file() {
        return Err(format!("Import source not found: {}", src_path.display()));
    }
    if src_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase() != "csv")
        .unwrap_or(true)
    {
        return Err("Only .csv files can be imported".to_string());
    }

    let now = chrono::Local::now();
    let file_id = SessionIndex::make_file_id(now);
    let stem = src_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "import".to_string());
    let safe = super::sanitize_label(&stem);
    let dest_name = format!("{}_{}.csv", now.format("%Y%m%d_%H%M%S"), safe);
    let dest_path = recordings_dir.join(&dest_name);
    fs::create_dir_all(recordings_dir).map_err(|e| e.to_string())?;
    fs::copy(src_path, &dest_path).map_err(|e| e.to_string())?;

    let (rows, sensor_count, duration_sec) = csv_summary_for(&dest_path);
    let substance = substance_from_filename(&dest_name);
    let record = SessionRecord {
        file_id,
        substance,
        label: "Imported".to_string(),
        csv_path: dest_path.to_string_lossy().to_string(),
        timestamp: now.timestamp() as f64,
        duration_sec,
        sensor_count,
        preset_name: String::new(),
        notes: String::new(),
        opensmell_result: None,
        quality_report: None,
        quality: SessionIndex::provision_quality(duration_sec, rows),
    };
    index.upsert(record.clone());
    let _ = index.save(recordings_dir);
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn token_held_in_memory_only() {
        // Token must live in memory only, never touch the filesystem.
        clear_hf_token();
        assert!(!has_hf_token());
        set_hf_token("hf_test_secret_123").unwrap();
        assert!(has_hf_token());
        assert_eq!(read_hf_token().unwrap(), "hf_test_secret_123");
        clear_hf_token();
        assert!(!has_hf_token());
        assert!(read_hf_token().is_err());
        // Empty token clears and errors.
        set_hf_token("  ").unwrap_err();
        assert!(!has_hf_token());
    }

    #[test]
    fn rejects_unsafe_filename() {
        let rec_dir = std::env::temp_dir().join("osm_hub_dl_test");
        assert!(hf_download_file(&rec_dir, "opensmell/opensmell-datasets", "../etc/passwd").is_err());
        assert!(hf_download_file(&rec_dir, "opensmell/opensmell-datasets", "a/b.csv").is_err());
    }

    #[test]
    fn imports_external_csv() {
        let dir = std::env::temp_dir().join("osm_hub_import_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("research_coffee.csv");
        let mut f = fs::File::create(&src).unwrap();
        f.write_all(b"timestamp_ms,VOC,CO\n0,1000.0,20.0\n100,1100.0,25.0\n")
            .unwrap();
        drop(f);

        let mut idx = SessionIndex::default();
        let rec = import_external_csv(&dir, &mut idx, &src).unwrap();
        assert_eq!(rec.label, "Imported");
        assert_eq!(rec.substance, "research coffee");
        assert!(Path::new(&rec.csv_path).exists());
        assert!(format!("{}", rec.csv_path).contains("research_coffee.csv"));
        let _ = fs::remove_dir_all(&dir);
    }
}
