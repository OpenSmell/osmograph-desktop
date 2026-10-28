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

/// One retry is not enough for a 500-file corpus on a flaky connection; three
/// attempts cover a transient reset without hammering the source.
const DOWNLOAD_ATTEMPTS: usize = 3;

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

/// Downloads stream into a hidden `.part` beside the final file. A crash or a
/// killed network must never leave a short file at the final path, because the
/// next launch would mistake it for a complete download and import it.
fn part_path(dest: &Path) -> PathBuf {
    let name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download");
    dest.with_file_name(format!(".{name}.part"))
}

fn cached_file(dest: &Path, expected_size: Option<u64>) -> Option<u64> {
    let m = fs::metadata(dest).ok()?;
    if !m.is_file() || m.len() == 0 {
        return None;
    }
    match expected_size {
        Some(want) if want != m.len() => None,
        _ => Some(m.len()),
    }
}

fn retryable(err: &str) -> bool {
    // A 4xx is not a transient network problem; retrying it would only delay
    // the honest failure the user needs to see.
    !err.contains("http status: 4")
}

/// Bytes needed beyond the actual download so a full disk cannot strand the
/// app while it writes manifests or extracts an archive.
const DISK_RESERVE: u64 = 32 * 1024 * 1024;

#[cfg(unix)]
fn available_space(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    let unit = if stat.f_frsize > 0 { stat.f_frsize } else { stat.f_bsize };
    Some((stat.f_bavail as u64).saturating_mul(unit as u64))
}

#[cfg(not(unix))]
fn available_space(_path: &Path) -> Option<u64> {
    // The download still checks advertised sizes after the fact; this build
    // cannot ask the OS for free space without a platform-specific call.
    None
}

fn fmt_bytes(n: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    if n >= 1024 * 1024 * 1024 {
        format!("{:.1} GB", n as f64 / (1024.0 * MB * 1024.0))
    } else if n >= 1024 * 1024 {
        format!("{:.0} MB", n as f64 / MB)
    } else if n >= 1024 {
        format!("{:.0} KB", n as f64 / 1024.0)
    } else {
        format!("{n} B")
    }
}

fn ensure_space(dir: &Path, needed: u64) -> Result<(), String> {
    if needed == 0 {
        return Ok(());
    }
    let Some(free) = available_space(dir) else {
        return Ok(());
    };
    let required = needed.saturating_add(DISK_RESERVE);
    if required > free {
        return Err(format!(
            "Not enough free disk space: this needs about {} plus a {} reserve, but only {} is available. Free up space or choose a smaller corpus.",
            fmt_bytes(needed),
            fmt_bytes(DISK_RESERVE),
            fmt_bytes(free)
        ));
    }
    Ok(())
}

fn cancelled_outcome(dest: &Path, filename: String, bytes: u64) -> DownloadOutcome {
    let _ = fs::remove_file(part_path(dest));
    DownloadOutcome {
        path: dest.to_string_lossy().into_owned(),
        filename,
        bytes,
        cancelled: true,
        cached: false,
    }
}

/// Stream `url` into `dest_dir/filename`, honouring `control` for pause/cancel and
/// calling `on_progress(received, total, paused)` as bytes land.
///
/// A partial `.part` is resumed with a Range request when the source supports
/// it, or restarted from byte zero when it does not. A finished download is
/// renamed atomically, so the visible path is always a complete file.
pub fn download_url(
    dest_dir: &Path,
    url: &str,
    filename: &str,
    expected_size: Option<u64>,
    control: &DownloadControl,
    mut on_progress: impl FnMut(u64, Option<u64>, bool),
) -> Result<DownloadOutcome, String> {
    let filename = safe_filename(filename)?;
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(&filename);

    // Already fetched? Hand it straight back — pressing Play twice must never
    // re-download. (Extraction/import downstream are idempotent.)
    if let Some(bytes) = cached_file(&dest, expected_size) {
        return Ok(DownloadOutcome {
            path: dest.to_string_lossy().into_owned(),
            filename,
            bytes,
            cancelled: false,
            cached: true,
        });
    }
    // A final path with the wrong size is a broken earlier attempt, not a
    // cache hit. Remove it so the next attempt can land cleanly.
    if dest.exists() {
        let _ = fs::remove_file(&dest);
    }
    if let Some(want) = expected_size {
        let already = fs::metadata(part_path(&dest)).map(|m| m.len()).unwrap_or(0);
        ensure_space(dest_dir, want.saturating_sub(already))?;
    }

    let mut last_err = String::new();
    for attempt in 0..DOWNLOAD_ATTEMPTS {
        if control.cancelled() {
            return Ok(cancelled_outcome(&dest, filename, 0));
        }
        match download_attempt(
            &dest,
            url,
            expected_size,
            control,
            &mut on_progress,
        ) {
            Ok(out) => return Ok(out),
            Err(err) => {
                if control.cancelled() {
                    return Ok(cancelled_outcome(&dest, filename, 0));
                }
                last_err = err;
                if attempt + 1 < DOWNLOAD_ATTEMPTS && retryable(&last_err) {
                    std::thread::sleep(Duration::from_millis(600 * (attempt as u64 + 1)));
                } else {
                    break;
                }
            }
        }
    }
    Err(last_err)
}

fn download_attempt(
    dest: &Path,
    url: &str,
    expected_size: Option<u64>,
    control: &DownloadControl,
    on_progress: &mut impl FnMut(u64, Option<u64>, bool),
) -> Result<DownloadOutcome, String> {
    let filename = dest
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download")
        .to_string();
    let part = part_path(dest);
    let mut resume = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if let Some(want) = expected_size {
        if resume == want {
            fs::rename(&part, dest).map_err(|e| e.to_string())?;
            return Ok(DownloadOutcome {
                path: dest.to_string_lossy().into_owned(),
                filename,
                bytes: want,
                cancelled: false,
                cached: false,
            });
        }
        if resume > want {
            let _ = fs::remove_file(&part);
            resume = 0;
        }
    }

    // No global timeout: a slow corpus file may legitimately take a long time.
    // Connect and header waits are still bounded, so a dead host fails instead
    // of pinning the download worker forever.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(None)
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_recv_response(Some(Duration::from_secs(60)))
        .build()
        .into();
    let mut request = agent
        .get(url)
        .header("User-Agent", "Osmograph/0.1 dataset-import");
    if resume > 0 {
        request = request.header("Range", &format!("bytes={resume}-"));
    }
    let resp = match request.call() {
        Ok(resp) => resp,
        // A complete-looking `.part` can come from a crash just before rename.
        // Without an expected size we cannot prove it is complete, so discard
        // it and retry from byte zero instead of leaving the job stuck on 416.
        Err(ureq::Error::StatusCode(416)) if resume > 0 => {
            let _ = fs::remove_file(&part);
            return Err("Download could not resume; restarting from the start.".to_string());
        }
        Err(e) => return Err(format!("Download failed: {e}")),
    };

    // A server that ignores Range replies with 200 and the whole file. In that
    // case the old partial is discarded rather than appended twice.
    let resumed = resume > 0 && resp.status().as_u16() == 206;
    let base = if resumed { resume } else { 0 };
    let total = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .map(|n| n + base);

    let mut file = if resumed {
        fs::OpenOptions::new()
            .append(true)
            .open(&part)
            .map_err(|e| e.to_string())?
    } else {
        fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&part)
            .map_err(|e| e.to_string())?
    };
    let mut reader = resp.into_body().into_reader();
    let mut buf = [0u8; 64 * 1024];
    let mut received: u64 = base;

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
        return Ok(cancelled_outcome(dest, filename, received));
    }

    file.flush().map_err(|e| e.to_string())?;
    drop(file);

    if let Some(total) = total {
        if received != total {
            return Err(format!(
                "Download ended early: received {received} of {total} bytes. Retry to resume."
            ));
        }
    }
    if let Some(want) = expected_size {
        if received != want {
            return Err(format!(
                "Download size mismatch: received {received}, source lists {want} bytes."
            ));
        }
    }

    fs::rename(&part, dest).map_err(|e| e.to_string())?;
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
    /// The source's advertised size, when it lists one. Used to reject a short
    /// cached file instead of importing a truncated CSV.
    pub expected_size: Option<u64>,
}

#[derive(Serialize, Clone)]
pub struct BatchOutcome {
    pub root: String,
    pub files: Vec<String>,
    pub bytes: u64,
    pub cancelled: bool,
}

pub(crate) fn safe_relative(path: &str) -> Result<PathBuf, String> {
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
    let total_bytes = files
        .iter()
        .map(|f| f.expected_size)
        .try_fold(0u64, |sum, size| size.map(|n| sum + n));
    // Sum what is actually missing so a resumed or partly cached corpus is not
    // rejected because the full payload would not fit twice.
    let mut needed = 0u64;
    for file in files {
        let Ok(rel) = safe_relative(&file.path) else { continue };
        let Some(want) = file.expected_size else { continue };
        let dest = dest_root.join(&rel);
        if cached_file(&dest, Some(want)).is_some() {
            continue;
        }
        let already = fs::metadata(part_path(&dest)).map(|m| m.len()).unwrap_or(0);
        needed = needed.saturating_add(want.saturating_sub(already));
    }
    ensure_space(dest_root, needed)?;
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
        let outcome = download_url(
            &parent,
            &file.url,
            name,
            file.expected_size,
            control,
            |received, _total, paused| {
                on_progress(index, files.len(), received_total + received, total_bytes, paused);
            },
        )?;
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
    let mut needed = 0u64;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().map_err(|e| e.to_string())?;
        if name.to_ascii_lowercase().ends_with(".csv") {
            needed = needed.saturating_add(entry.size());
        }
    }
    ensure_space(dest_dir, needed)?;

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
        // Preserve the archive's own folders (e.g. `AllSmaples-Report/`).
        // Flattening every CSV into one directory destroys the only label a
        // corpus gives us, and makes two same-named files overwrite each other.
        let rel = safe_relative(&name)?;
        let target = dest_dir.join(&rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut w = fs::File::create(&target).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut w).map_err(|e| e.to_string())?;
        out.push(target);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "osmograph-dataset-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn serve_once(
        listener: TcpListener,
        assert_request: impl Fn(&str) + Send + 'static,
        response: Vec<u8>,
    ) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap();
            let request = String::from_utf8_lossy(&buf[..n]);
            assert_request(&request);
            stream.write_all(&response).unwrap();
        })
    }

    #[cfg(unix)]
    #[test]
    fn disk_preflight_rejects_an_impossible_batch() {
        let dir = temp_dir("space");
        assert!(ensure_space(&dir, u64::MAX).is_err());
        assert!(ensure_space(&dir, 0).is_ok());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn resumes_a_partial_file_with_range() {
        let dir = temp_dir("resume");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = serve_once(
            listener,
            |request| assert!(request.to_ascii_lowercase().contains("range: bytes=6-")),
            b"HTTP/1.1 206 Partial Content\r\nContent-Length: 5\r\nContent-Range: bytes 6-10/11\r\nConnection: close\r\n\r\nworld".to_vec(),
        );

        let dest = dir.join("note.txt");
        fs::write(part_path(&dest), b"hello ").unwrap();
        let control = DownloadControl::default();
        let out = download_url(
            &dir,
            &format!("http://{addr}/note.txt"),
            "note.txt",
            Some(11),
            &control,
            |_, _, _| {},
        )
        .unwrap();
        server.join().unwrap();

        assert_eq!(out.bytes, 11);
        assert_eq!(fs::read(&dest).unwrap(), b"hello world");
        assert!(!part_path(&dest).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn restarts_when_the_source_ignores_range() {
        let dir = temp_dir("restart");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = serve_once(
            listener,
            |request| assert!(request.to_ascii_lowercase().contains("range: bytes=4-")),
            b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\ncomplete".to_vec(),
        );

        let dest = dir.join("note.txt");
        fs::write(part_path(&dest), b"junk").unwrap();
        let control = DownloadControl::default();
        let out = download_url(
            &dir,
            &format!("http://{addr}/note.txt"),
            "note.txt",
            Some(8),
            &control,
            |_, _, _| {},
        )
        .unwrap();
        server.join().unwrap();

        assert_eq!(out.bytes, 8);
        assert_eq!(fs::read(&dest).unwrap(), b"complete");
        assert!(!part_path(&dest).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn restarts_when_a_complete_looking_part_is_rejected() {
        let dir = temp_dir("rejected-resume");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            for attempt in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap();
                let request = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
                if attempt == 0 {
                    assert!(request.contains("range: bytes=5-"));
                    stream
                        .write_all(
                            b"HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        )
                        .unwrap();
                } else {
                    assert!(!request.contains("range:"));
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nfresh",
                        )
                        .unwrap();
                }
            }
        });

        let dest = dir.join("note.txt");
        fs::write(part_path(&dest), b"stale").unwrap();
        let control = DownloadControl::default();
        let out = download_url(
            &dir,
            &format!("http://{addr}/note.txt"),
            "note.txt",
            None,
            &control,
            |_, _, _| {},
        )
        .unwrap();
        server.join().unwrap();

        assert_eq!(out.bytes, 5);
        assert_eq!(fs::read(&dest).unwrap(), b"fresh");
        assert!(!part_path(&dest).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_parent_components() {
        assert!(safe_relative("corpus/../../etc/passwd").is_err());
        assert!(safe_relative("/absolute/path").is_err());
        assert!(safe_relative("corpus/base_data/apple.csv").is_ok());
    }
}
