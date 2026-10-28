//! Collection manifests (`collection.json`) for downloaded and imported corpora.
//!
//! A folder alone is not provenance. `collection.json` is written beside the
//! recordings so the library can still say where the data came from, under
//! which licence it was obtained, and which exact bytes are on this device
//! after the original download tab is gone. The manifest is local evidence, not
//! a claim of redistribution rights: a rearranged third-party copy defaults to
//! `local.publishable = false`.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::collections::{self, Classification};
use super::dataset_io::{datasets_dir, safe_relative};

pub const MANIFEST_SCHEMA_VERSION: u32 = 1;
pub const MANIFEST_FILE: &str = "collection.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestSource {
    pub url: String,
    #[serde(default)]
    pub citation: String,
    #[serde(default)]
    pub credit: String,
    pub retrieved_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestLicence {
    pub id: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub commercial_use: bool,
    #[serde(default)]
    pub attribution_required: bool,
    #[serde(default)]
    pub share_alike: bool,
    #[serde(default = "unknown_redistribution")]
    pub redistribution: String,
    #[serde(default)]
    pub notes: String,
}

fn unknown_redistribution() -> String {
    "unknown".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestLocal {
    pub rearranged: bool,
    pub publishable: bool,
    #[serde(default)]
    pub transformations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestLayout {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub split_folders: BTreeMap<String, String>,
    #[serde(default)]
    pub substance_source: String,
    #[serde(default)]
    pub condition_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestFile {
    pub path: String,
    pub recording_id: String,
    pub sha256: String,
    pub bytes: u64,
    #[serde(default)]
    pub substance: String,
    #[serde(default)]
    pub preparation: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub split: String,
    #[serde(default)]
    pub condition: String,
    /// Mixture composition parsed from the folder/file name. Empty for a
    /// single substance; never a list of smell classes.
    #[serde(default)]
    pub mixture: Vec<collections::MixtureComponent>,
    #[serde(default)]
    pub replicate_group_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestQualityGates {
    #[serde(default)]
    pub critical: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

impl Default for ManifestQualityGates {
    fn default() -> Self {
        Self {
            critical: vec![
                "timestamp".to_string(),
                "channels".to_string(),
                "finite-values".to_string(),
                "non-empty-substance".to_string(),
            ],
            warnings: vec![
                "flat-channel".to_string(),
                "short-duration".to_string(),
                "condition-missing".to_string(),
            ],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub source: ManifestSource,
    pub licence: ManifestLicence,
    pub local: ManifestLocal,
    pub layout: ManifestLayout,
    pub files: Vec<ManifestFile>,
    #[serde(default)]
    pub quality_gates: ManifestQualityGates,
    #[serde(default)]
    pub manifest_hash: String,
}

/// Caller-supplied metadata for writing a manifest. Kept separate from the file
/// shape so stored values (retrieved_at, hashes) are generated here, not by the
/// UI. Camel-case on the wire matches Tauri command arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionMeta {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub source_url: String,
    #[serde(default)]
    pub citation: String,
    #[serde(default)]
    pub credit: String,
    #[serde(default)]
    pub source_version: Option<String>,
    #[serde(default)]
    pub licence_id: String,
    #[serde(default)]
    pub licence_url: String,
    #[serde(default)]
    pub commercial_use: bool,
    #[serde(default)]
    pub attribution_required: bool,
    #[serde(default)]
    pub share_alike: bool,
    #[serde(default)]
    pub redistribution: String,
    #[serde(default)]
    pub licence_notes: String,
    #[serde(default)]
    pub rearranged: bool,
    #[serde(default)]
    pub publishable: bool,
    #[serde(default)]
    pub transformations: Vec<String>,
    #[serde(default)]
    pub layout_kind: String,
    #[serde(default)]
    pub split_folders: BTreeMap<String, String>,
    #[serde(default)]
    pub substance_source: String,
    #[serde(default)]
    pub condition_source: String,
}

/// What the Datasets tab needs to show about one on-disk collection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionSummary {
    pub folder: String,
    pub root: String,
    pub id: String,
    pub name: String,
    pub description: String,
    pub source_url: String,
    pub citation: String,
    pub credit: String,
    pub licence: String,
    pub licence_url: String,
    pub commercial_use: bool,
    pub publishable: bool,
    pub rearranged: bool,
    pub has_manifest: bool,
    pub manifest_path: Option<String>,
    pub manifest_hash: String,
    pub retrieved_at: String,
    pub files: usize,
    pub bytes: u64,
    pub disk_files: usize,
    pub disk_bytes: u64,
    pub transformations: Vec<String>,
    pub manifest_error: Option<String>,
}

/// Write or refresh `<datasets>/<dest_name>/collection.json`.
///
/// With `if_missing`, an existing valid manifest is left untouched. Otherwise
/// the file list and checksums are rebuilt from disk; provenance and licence
/// fields come from `meta`.
pub fn write_manifest(
    recordings_dir: &Path,
    dest_name: &str,
    meta: &CollectionMeta,
    if_missing: bool,
) -> Result<CollectionSummary, String> {
    let root = datasets_dir(recordings_dir).join(safe_relative(dest_name)?);
    if !root.is_dir() {
        return Err(format!(
            "Collection folder does not exist: {}",
            root.display()
        ));
    }
    let manifest_path = root.join(MANIFEST_FILE);
    if if_missing && manifest_path.is_file() {
        if let Ok(existing) = read_manifest(&root) {
            let (disk_files, disk_bytes) = count_recordings(&root)?;
            return Ok(summary_from_manifest(
                &root,
                &existing,
                disk_files,
                disk_bytes,
                None,
            ));
        }
    }

    let previous = read_manifest(&root).ok();
    let retrieved_at = previous
        .as_ref()
        .map(|m| m.source.retrieved_at.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        });
    let source_version = meta
        .source_version
        .clone()
        .or_else(|| previous.as_ref().and_then(|m| m.source.source_version.clone()));

    let mut transformations = meta.transformations.clone();
    if let Some(prev) = &previous {
        for item in &prev.local.transformations {
            if !transformations.contains(item) {
                transformations.push(item.clone());
            }
        }
    }

    let files = enumerate_recordings(&root, recordings_dir)?;
    if files.is_empty() {
        return Err(format!(
            "No recording files were found in {}; nothing to describe.",
            root.display()
        ));
    }
    let bytes = files.iter().map(|f| f.bytes).sum();

    let mut manifest = CollectionManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        id: if meta.id.trim().is_empty() {
            previous
                .as_ref()
                .map(|m| m.id.clone())
                .unwrap_or_else(|| folder_slug(&root))
        } else {
            meta.id.trim().to_string()
        },
        name: if meta.name.trim().is_empty() {
            previous
                .as_ref()
                .map(|m| m.name.clone())
                .unwrap_or_else(|| folder_name(&root))
        } else {
            meta.name.trim().to_string()
        },
        description: meta.description.clone(),
        source: ManifestSource {
            url: meta.source_url.clone(),
            citation: meta.citation.clone(),
            credit: meta.credit.clone(),
            retrieved_at,
            source_version,
        },
        licence: ManifestLicence {
            id: if meta.licence_id.trim().is_empty() {
                "unknown".to_string()
            } else {
                meta.licence_id.trim().to_string()
            },
            url: meta.licence_url.clone(),
            commercial_use: meta.commercial_use,
            attribution_required: meta.attribution_required,
            share_alike: meta.share_alike,
            redistribution: if meta.redistribution.trim().is_empty() {
                "unknown".to_string()
            } else {
                meta.redistribution.trim().to_string()
            },
            notes: meta.licence_notes.clone(),
        },
        local: ManifestLocal {
            rearranged: meta.rearranged,
            publishable: meta.publishable,
            transformations,
        },
        layout: ManifestLayout {
            kind: if meta.layout_kind.trim().is_empty() {
                folder_slug(&root)
            } else {
                meta.layout_kind.clone()
            },
            split_folders: meta.split_folders.clone(),
            substance_source: if meta.substance_source.trim().is_empty() {
                "folder".to_string()
            } else {
                meta.substance_source.clone()
            },
            condition_source: if meta.condition_source.trim().is_empty() {
                "folder-or-filename".to_string()
            } else {
                meta.condition_source.clone()
            },
        },
        files,
        quality_gates: ManifestQualityGates::default(),
        manifest_hash: String::new(),
    };
    manifest.manifest_hash = manifest_hash(&manifest)?;
    write_json_atomic(&manifest_path, &manifest)?;

    Ok(CollectionSummary {
        folder: folder_name(&root),
        root: root.to_string_lossy().into_owned(),
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        description: manifest.description.clone(),
        source_url: manifest.source.url.clone(),
        citation: manifest.source.citation.clone(),
        credit: manifest.source.credit.clone(),
        licence: manifest.licence.id.clone(),
        licence_url: manifest.licence.url.clone(),
        commercial_use: manifest.licence.commercial_use,
        publishable: manifest.local.publishable,
        rearranged: manifest.local.rearranged,
        has_manifest: true,
        manifest_path: Some(manifest_path.to_string_lossy().into_owned()),
        manifest_hash: manifest.manifest_hash.clone(),
        retrieved_at: manifest.source.retrieved_at.clone(),
        files: manifest.files.len(),
        bytes,
        disk_files: manifest.files.len(),
        disk_bytes: bytes,
        transformations: manifest.local.transformations.clone(),
        manifest_error: None,
    })
}

/// Result of re-hashing a collection against its `collection.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestVerification {
    pub folder: String,
    pub root: String,
    pub ok: bool,
    pub checked: usize,
    pub missing: Vec<String>,
    pub changed: Vec<String>,
    pub extra: Vec<String>,
    pub manifest_hash: String,
}

/// Re-hash every file listed in the manifest and report drift. This proves the
/// local copy is the one the manifest describes; it does not claim the source
/// published those hashes.
pub fn verify_collection(
    recordings_dir: &Path,
    dest_name: &str,
) -> Result<ManifestVerification, String> {
    let root = datasets_dir(recordings_dir).join(safe_relative(dest_name)?);
    let manifest = read_manifest(&root)?;
    let mut checked = 0usize;
    let mut missing = Vec::new();
    let mut changed = Vec::new();
    let mut listed = std::collections::BTreeSet::new();
    for file in &manifest.files {
        let rel = safe_relative(&file.path)?;
        listed.insert(rel.to_string_lossy().replace('\\', "/"));
        let path = root.join(&rel);
        if !path.is_file() {
            missing.push(file.path.clone());
            continue;
        }
        checked += 1;
        let bytes = fs::metadata(&path).map_err(|e| e.to_string())?.len();
        if bytes != file.bytes {
            changed.push(file.path.clone());
            continue;
        }
        let sha = format!("sha256:{}", sha256_file(&path)?);
        if sha != file.sha256 {
            changed.push(file.path.clone());
        }
    }
    let actual = recording_paths(&root)?;
    let mut extra = Vec::new();
    for path in actual {
        let rel = path
            .strip_prefix(&root)
            .map_err(|_| format!("File escaped collection root: {}", path.display()))?
            .to_string_lossy()
            .replace('\\', "/");
        if !listed.contains(&rel) {
            extra.push(rel);
        }
    }
    missing.sort();
    changed.sort();
    extra.sort();
    Ok(ManifestVerification {
        folder: folder_name(&root),
        root: root.to_string_lossy().into_owned(),
        ok: missing.is_empty() && changed.is_empty() && extra.is_empty(),
        checked,
        missing,
        changed,
        extra,
        manifest_hash: manifest.manifest_hash,
    })
}

/// Summaries for every non-empty folder directly under `datasets/`.
pub fn scan_collections(recordings_dir: &Path) -> Result<Vec<CollectionSummary>, String> {
    let datasets = datasets_dir(recordings_dir);
    if !datasets.is_dir() {
        return Ok(Vec::new());
    }
    let mut dirs: Vec<PathBuf> = fs::read_dir(&datasets)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name.starts_with('_') {
                return None;
            }
            entry.file_type().ok().filter(|t| t.is_dir()).map(|_| entry.path())
        })
        .collect();
    dirs.sort();

    let mut out = Vec::new();
    for root in dirs {
        let (disk_files, disk_bytes) = count_recordings(&root)?;
        if disk_files == 0 {
            continue;
        }
        match read_manifest(&root) {
            Ok(manifest) => out.push(summary_from_manifest(
                &root,
                &manifest,
                disk_files,
                disk_bytes,
                None,
            )),
            Err(err) if root.join(MANIFEST_FILE).exists() => {
                let inferred = infer_summary(&root, recordings_dir, disk_files, disk_bytes);
                out.push(CollectionSummary {
                    has_manifest: false,
                    manifest_error: Some(err),
                    ..inferred
                });
            }
            Err(_) => out.push(infer_summary(
                &root,
                recordings_dir,
                disk_files,
                disk_bytes,
            )),
        }
    }
    Ok(out)
}

/// Recursively collect recording paths under a collection root, deterministically.
pub fn recording_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    collect_paths(root, &mut paths)?;
    paths.sort();
    Ok(paths)
}

fn collect_paths(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name.starts_with('_') {
                continue;
            }
            collect_paths(&path, out)?;
        } else if collections::is_supported_recording(&path)
            && !collections::is_known_non_recording(&path)
        {
            out.push(path);
        }
    }
    Ok(())
}

fn enumerate_recordings(root: &Path, recordings_dir: &Path) -> Result<Vec<ManifestFile>, String> {
    let paths = recording_paths(root)?;
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let c = collections::classify(&path, recordings_dir);
        let rel = path
            .strip_prefix(root)
            .map_err(|_| format!("File escaped collection root: {}", path.display()))?
            .to_string_lossy()
            .replace('\\', "/");
        let bytes = fs::metadata(&path).map_err(|e| e.to_string())?.len();
        let sha256 = format!("sha256:{}", sha256_file(&path)?);
        let path_str = path.to_string_lossy().to_string();
        out.push(ManifestFile {
            path: rel,
            recording_id: collections::stable_import_id(&path_str),
            sha256,
            bytes,
            substance: c.substance.clone(),
            preparation: c.preparation.clone(),
            role: c.role.clone(),
            split: c.split.clone(),
            condition: c.condition.clone(),
            mixture: c.mixture.clone(),
            replicate_group_id: replicate_group_id(&c),
        });
    }
    Ok(out)
}

fn replicate_group_id(c: &Classification) -> String {
    let part = |value: &str| -> String {
        let key = value
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() {
                    ch.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect::<String>();
        let key = key.trim_matches('-').to_string();
        if key.is_empty() {
            "none".to_string()
        } else {
            key
        }
    };
    // `run 5` is a replicate number, not a distinct condition. Ignoring it
    // groups the runs of one substance while a real condition (`day 3`,
    // `ingestion balanced`) still separates groups.
    let condition = if c.condition.to_ascii_lowercase().starts_with("run ") {
        ""
    } else {
        &c.condition
    };
    format!(
        "{}:{}:{}:{}:{}",
        part(&c.collection_id),
        part(&c.split),
        part(&c.substance),
        part(&c.preparation),
        part(condition)
    )
}

fn count_recordings(root: &Path) -> Result<(usize, u64), String> {
    let paths = recording_paths(root)?;
    let mut bytes = 0;
    for path in &paths {
        if let Ok(meta) = fs::metadata(path) {
            bytes += meta.len();
        }
    }
    Ok((paths.len(), bytes))
}

fn read_manifest(root: &Path) -> Result<CollectionManifest, String> {
    let path = root.join(MANIFEST_FILE);
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let manifest: CollectionManifest =
        serde_json::from_str(&text).map_err(|e| format!("Invalid {}: {e}", path.display()))?;
    Ok(manifest)
}

fn summary_from_manifest(
    root: &Path,
    manifest: &CollectionManifest,
    disk_files: usize,
    disk_bytes: u64,
    manifest_error: Option<String>,
) -> CollectionSummary {
    CollectionSummary {
        folder: folder_name(root),
        root: root.to_string_lossy().into_owned(),
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        description: manifest.description.clone(),
        source_url: manifest.source.url.clone(),
        citation: manifest.source.citation.clone(),
        credit: manifest.source.credit.clone(),
        licence: manifest.licence.id.clone(),
        licence_url: manifest.licence.url.clone(),
        commercial_use: manifest.licence.commercial_use,
        publishable: manifest.local.publishable,
        rearranged: manifest.local.rearranged,
        has_manifest: true,
        manifest_path: Some(root.join(MANIFEST_FILE).to_string_lossy().into_owned()),
        manifest_hash: manifest.manifest_hash.clone(),
        retrieved_at: manifest.source.retrieved_at.clone(),
        files: manifest.files.len(),
        bytes: manifest.files.iter().map(|f| f.bytes).sum(),
        disk_files,
        disk_bytes,
        transformations: manifest.local.transformations.clone(),
        manifest_error,
    }
}

fn infer_summary(
    root: &Path,
    recordings_dir: &Path,
    disk_files: usize,
    disk_bytes: u64,
) -> CollectionSummary {
    let first = recording_paths(root).ok().and_then(|p| p.into_iter().next());
    let c = first
        .as_deref()
        .map(|path| collections::classify(path, recordings_dir))
        .unwrap_or_default();
    CollectionSummary {
        folder: folder_name(root),
        root: root.to_string_lossy().into_owned(),
        id: c.collection_id,
        name: c.collection_name,
        description: String::new(),
        source_url: String::new(),
        citation: String::new(),
        credit: String::new(),
        licence: String::new(),
        licence_url: String::new(),
        commercial_use: false,
        publishable: false,
        rearranged: false,
        has_manifest: false,
        manifest_path: None,
        manifest_hash: String::new(),
        retrieved_at: String::new(),
        files: 0,
        bytes: 0,
        disk_files,
        disk_bytes,
        transformations: Vec::new(),
        manifest_error: None,
    }
}

fn manifest_hash(manifest: &CollectionManifest) -> Result<String, String> {
    let mut copy = manifest.clone();
    copy.manifest_hash.clear();
    let json = serde_json::to_vec(&copy).map_err(|e| e.to_string())?;
    Ok(format!("sha256:{}", hex_digest(&json)))
}

fn write_json_atomic(path: &Path, value: &CollectionManifest) -> Result<(), String> {
    let tmp = path.with_file_name(format!(".{MANIFEST_FILE}.tmp"));
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    // Windows does not replace an existing file with rename(); removing first
    // keeps the update cross-platform. The temp file is complete either way.
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Hash a file without loading a long recording into memory.
pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_digest(&hasher.finalize()))
}

fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn folder_name(root: &Path) -> String {
    root.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn folder_slug(root: &Path) -> String {
    folder_name(root)
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "osmograph-manifest-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn meta() -> CollectionMeta {
        CollectionMeta {
            id: "smellnet".to_string(),
            name: "SmellNet".to_string(),
            description: "test collection".to_string(),
            source_url: "https://example.test/smellnet".to_string(),
            citation: "Example et al.".to_string(),
            credit: "Example lab".to_string(),
            source_version: None,
            licence_id: "CC-BY-4.0".to_string(),
            licence_url: "https://creativecommons.org/licenses/by/4.0/".to_string(),
            commercial_use: true,
            attribution_required: true,
            share_alike: false,
            redistribution: "allowed".to_string(),
            licence_notes: String::new(),
            rearranged: true,
            publishable: false,
            transformations: vec!["downloaded from the original source".to_string()],
            layout_kind: "smellnet".to_string(),
            split_folders: BTreeMap::new(),
            substance_source: "folder".to_string(),
            condition_source: "filename".to_string(),
        }
    }

    #[test]
    fn writes_a_private_manifest_with_checksums() {
        let dir = temp_root("write");
        let root = dir.join("datasets/SmellNet-single/base_data/testing/apple");
        fs::create_dir_all(&root).unwrap();
        let csv = root.join("apple_1.csv");
        fs::write(&csv, "timestamp,VOC\n0,1000\n1,1100\n").unwrap();

        let summary = write_manifest(
            &dir,
            "SmellNet-single",
            &meta(),
            false,
        )
        .unwrap();
        assert!(summary.has_manifest);
        assert_eq!(summary.id, "smellnet");
        assert_eq!(summary.files, 1);
        assert!(!summary.publishable);
        assert!(summary.rearranged);
        assert!(summary.manifest_hash.starts_with("sha256:"));

        let manifest = read_manifest(&dir.join("datasets/SmellNet-single")).unwrap();
        assert_eq!(manifest.files[0].substance, "apple");
        assert_eq!(manifest.files[0].split, "Testing");
        assert_eq!(manifest.files[0].condition, "run 1");
        assert!(manifest.files[0].sha256.starts_with("sha256:"));
        assert_eq!(manifest.files[0].bytes, 28);
    }

    #[test]
    fn if_missing_does_not_rewrite_an_existing_manifest() {
        let dir = temp_root("if-missing");
        let root = dir.join("datasets/Corpus");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("run.csv"), "timestamp,VOC\n0,1000\n").unwrap();
        let first = write_manifest(&dir, "Corpus", &meta(), false).unwrap();
        let second = write_manifest(&dir, "Corpus", &meta(), true).unwrap();
        assert_eq!(first.manifest_hash, second.manifest_hash);
    }

    #[test]
    fn scan_marks_a_folder_without_a_manifest() {
        let dir = temp_root("scan");
        let root = dir.join("datasets/TADI-2019");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("Logger_A.csv"), "timestamp,VOC\n0,1000\n").unwrap();
        fs::write(root.join("sonic3d_anemometer.csv"), "timestamp,wind\n0,2\n").unwrap();

        let collections = scan_collections(&dir).unwrap();
        assert_eq!(collections.len(), 1);
        assert_eq!(collections[0].id, "tadi-2019");
        assert_eq!(collections[0].disk_files, 1, "anemometer is not a recording");
        assert!(!collections[0].has_manifest);
    }

    #[test]
    fn verify_reports_missing_changed_and_unlisted_files() {
        let dir = temp_root("verify");
        let root = dir.join("datasets/Corpus");
        fs::create_dir_all(&root).unwrap();
        let csv = root.join("run.csv");
        fs::write(&csv, "timestamp,VOC\n0,1000\n").unwrap();
        write_manifest(&dir, "Corpus", &meta(), false).unwrap();

        let clean = verify_collection(&dir, "Corpus").unwrap();
        assert!(clean.ok);
        assert_eq!(clean.checked, 1);

        fs::write(&csv, "timestamp,VOC\n0,2000\n").unwrap();
        fs::write(root.join("new.csv"), "timestamp,VOC\n0,1\n").unwrap();
        let dirty = verify_collection(&dir, "Corpus").unwrap();
        assert!(!dirty.ok);
        assert_eq!(dirty.changed, vec!["run.csv".to_string()]);
        assert_eq!(dirty.extra, vec!["new.csv".to_string()]);
        assert!(dirty.missing.is_empty());
    }

    #[test]
    fn preparation_is_written_as_a_nuance() {
        let dir = temp_root("prep");
        let root = dir.join("datasets/Own");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("20260613_180633_warm garlic.csv"), "timestamp,VOC\n0,1\n").unwrap();
        write_manifest(&dir, "Own", &meta(), false).unwrap();
        let manifest = read_manifest(&root).unwrap();
        assert_eq!(manifest.files[0].substance, "garlic");
        assert_eq!(manifest.files[0].preparation, "warm");
    }
}
