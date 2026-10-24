//! In-app download of the public Datasets catalog.
//!
//! Files are fetched from the ORIGINAL source straight onto the user's machine
//! (we never rehost), streamed to `<recordings>/datasets/` with progress events
//! so the UI can show an honest byte count — and so it can pause or cancel.
//! Ambiguous or restrictive licences are not a blocker here: the user is pulling
//! the file themselves, under the source's own terms (private/DATA_AND_LICENSING.md).

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;

/// Shared, thread-safe controls for one in-flight download.
#[derive(Default)]
pub struct DownloadControl {
    pub cancel: AtomicBool,
    pub paused: AtomicBool,
}

impl DownloadControl {
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
    pub fn paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }
    pub fn set_paused(&self, on: bool) {
        self.paused.store(on, Ordering::Relaxed);
    }
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
        self.paused.store(false, Ordering::Relaxed);
    }
}

#[derive(Serialize, Clone)]
pub struct DownloadOutcome {
    pub path: String,
    pub filename: String,
    pub bytes: u64,
    pub cancelled: bool,
    /// True when the file was already on disk and we skipped the network entirely.
    pub cached: bool,
}

pub fn datasets_dir(recordings_dir: &Path) -> PathBuf {
    recordings_dir.join("datasets")
}

fn safe_filename(name: &str) -> Result<String, String> {
    let name = name.rsplit(['/', '\\']).next().unwrap_or(name);
    if name.is_empty() || name == "." || name == ".." || name.contains("..") {
        return Err(format!("Unsafe dataset filename: {name}"));
    }
    Ok(name.to_string())
}

/// Stream `url` into `dest_dir/filename`, honouring `control` for pause/cancel and
/// calling `on_progress(received, total, paused)` as bytes land.
pub fn download_url(
    dest_dir: &Path,
    url: &str,
    filename: &str,
    control: &DownloadControl,
    mut on_progress: impl FnMut(u64, Option<u64>, bool),
) -> Result<DownloadOutcome, String> {
    let filename = safe_filename(filename)?;
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(&filename);

    // Already fetched? Hand it straight back — pressing Play twice must never
    // re-download. (Extraction/import downstream are idempotent.)
    if let Ok(m) = fs::metadata(&dest) {
        if m.is_file() && m.len() > 0 {
            return Ok(DownloadOutcome {
                path: dest.to_string_lossy().into_owned(),
                filename,
                bytes: m.len(),
                cancelled: false,
                cached: true,
            });
        }
    }

    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(None)
        .build()
        .into();

    let resp = agent
        .get(url)
        .call()
        .map_err(|e| format!("Download failed: {e}"))?;
    let total = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok());

    let mut reader = resp.into_body().into_reader();
    let mut file = fs::File::create(&dest).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 64 * 1024];
    let mut received: u64 = 0;

    loop {
        if control.paused() {
            let _ = file.flush();
            on_progress(received, total, true);
            while control.paused() && !control.cancelled() {
                std::thread::sleep(Duration::from_millis(150));
            }
            if control.cancelled() {
                break;
            }
        }
        if control.cancelled() {
            break;
        }
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        received += n as u64;
        on_progress(received, total, false);
    }

    if control.cancelled() {
        drop(file);
        let _ = fs::remove_file(&dest);
        return Ok(DownloadOutcome {
            path: dest.to_string_lossy().into_owned(),
            filename,
            bytes: received,
            cancelled: true,
            cached: false,
        });
    }

    Ok(DownloadOutcome {
        path: dest.to_string_lossy().into_owned(),
        filename,
        bytes: received,
        cancelled: false,
        cached: false,
    })
}

/// A single file inside a multi-file corpus. `path` is relative to the corpus root.
#[derive(Clone, Debug)]
pub struct BatchFile {
    pub url: String,
    pub path: String,
}

#[derive(Serialize, Clone)]
pub struct BatchOutcome {
    pub root: String,
    pub files: Vec<String>,
    pub bytes: u64,
    pub cancelled: bool,
}

fn safe_relative(path: &str) -> Result<PathBuf, String> {
    let rel = Path::new(path);
    if rel.is_absolute() {
        return Err(format!("Unsafe dataset path: {path}"));
    }
    let mut out = PathBuf::new();
    for component in rel.components() {
        match component {
            std::path::Component::Normal(part) => out.push(part),
            _ => return Err(format!("Unsafe dataset path: {path}")),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(format!("Empty dataset path: {path}"));
    }
    Ok(out)
}

/// Download a list of files into one corpus folder, preserving relative paths.
/// The caller supplies the already-filtered list, so a Hugging Face tree fetch
/// and an explicit URL list behave identically after this point.
pub fn download_batch(
    dest_root: &Path,
    files: &[BatchFile],
    control: &DownloadControl,
    mut on_progress: impl FnMut(usize, usize, u64, Option<u64>, bool),
) -> Result<BatchOutcome, String> {
    fs::create_dir_all(dest_root).map_err(|e| e.to_string())?;
    let total_bytes: Option<u64> = None;
    let mut received_total: u64 = 0;
    let mut saved: Vec<String> = Vec::new();

    for (index, file) in files.iter().enumerate() {
        if control.cancelled() {
            return Ok(BatchOutcome {
                root: dest_root.to_string_lossy().into_owned(),
                files: saved,
                bytes: received_total,
                cancelled: true,
            });
        }
        let rel = safe_relative(&file.path)?;
        let parent = dest_root.join(rel.parent().unwrap_or_else(|| Path::new("")));
        let name = rel.file_name().and_then(|n| n.to_str()).unwrap_or("file");
        let outcome = download_url(&parent, &file.url, name, control, |received, _total, paused| {
            on_progress(index, files.len(), received_total + received, total_bytes, paused);
        })?;
        if outcome.cancelled {
            return Ok(BatchOutcome {
                root: dest_root.to_string_lossy().into_owned(),
                files: saved,
                bytes: received_total,
                cancelled: true,
            });
        }
        received_total += outcome.bytes;
        saved.push(outcome.path);
        on_progress(index + 1, files.len(), received_total, total_bytes, false);
    }

    Ok(BatchOutcome {
        root: dest_root.to_string_lossy().into_owned(),
        files: saved,
        bytes: received_total,
        cancelled: false,
    })
}

/// Extract every `.csv` entry from a zip into `dest_dir`, returning the paths.
pub fn extract_csvs(zip_path: &Path, dest_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let file = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Not a readable zip: {e}"))?;
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let name = entry
            .name()
            .map_err(|e| format!("Invalid zip entry name: {e}"))?
            .into_owned();
        if !name.to_ascii_lowercase().ends_with(".csv") {
            continue;
        }
        let target = dest_dir.join(safe_filename(&name)?);
        let mut w = fs::File::create(&target).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut w).map_err(|e| e.to_string())?;
        out.push(target);
    }
    Ok(out)
}
