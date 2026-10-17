//! Recipe + provenance — the smell-native data model.
//!
//! Design source: `private/SMELL_OPERATIONS.md` §0–§3.N/§6. Core principles:
//!   * the unit of work is a **Recipe** (source → ordered transforms → result),
//!     not a file;
//!   * **no invented numbers** — every derived quantity is traceable to a named,
//!     versioned, re-runnable transform;
//!   * every bundle carries **provenance**: source, licence, contributor, software
//!     version, and a content hash, so results form a derivation graph.
//!
//! This module owns the model, persistence and the op catalog. The visible pipeline
//! UI (Sources → Recipe → Result) is layered on top later; the model must exist now.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// A saved, re-runnable pipeline: a source plus an ordered list of transforms.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Recipe {
    pub id: String,
    pub name: String,
    pub version: String,
    /// Where the data comes from: `live`, `osmell:<id>`, or `dataset:<id>`.
    pub source: String,
    pub steps: Vec<RecipeStep>,
    #[serde(default)]
    pub notes: String,
}

/// One named transform in the pipeline.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecipeStep {
    /// Op name from the catalog (see [`known_ops`]).
    pub op: String,
    /// Target channel index, when the op is per-channel.
    #[serde(default)]
    pub channel: Option<usize>,
    /// Scalar parameters (window size, R0 override, threshold, …).
    #[serde(default)]
    pub params: BTreeMap<String, f64>,
}

/// Where a derived artifact's data came from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProvenanceSource {
    pub kind: String,
    pub id: String,
    pub license: String,
    pub origin_url: String,
    pub credit: String,
}

/// Pointer to the recipe that produced a derived artifact.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecipeRef {
    pub id: String,
    pub version: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Software {
    pub name: String,
    pub version: String,
}

/// Full provenance record stamped onto every bundle/export.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Provenance {
    pub source: ProvenanceSource,
    pub recipe: Option<RecipeRef>,
    pub software: Software,
    pub created_ms: u64,
    pub content_hash: String,
}

/// Metadata describing one op in the catalog, surfaced to the UI and validators.
#[derive(Debug, Clone, Serialize)]
pub struct OpInfo {
    pub op: &'static str,
    pub intent: &'static str,
    /// `core` = must ship v1, `next` = v1.1+, `research` = needs our own R&D.
    pub status: &'static str,
}

/// The v1 op catalog — the `[core]` subset of the taxonomy in SMELL_OPERATIONS.md §3.
pub fn known_ops() -> Vec<OpInfo> {
    const OPS: &[(&str, &str, &str)] = &[
        // A. Acquisition & ingest
        ("import.csv", "Import a CSV/JSON recording", "core"),
        ("units.convert", "raw ADC / voltage / resistance → conductance / ΔR/R0 / ppm estimate", "core"),
        ("resample", "Resample to a uniform time grid", "core"),
        ("trim.idle", "Trim leading/trailing idle", "core"),
        // B. Conditioning
        ("missing.fill", "Fill gaps (linear / LOCF) and flag them", "core"),
        ("outlier.remove", "z-score / IQR / Hampel outlier removal", "core"),
        ("smooth.ema", "Exponential moving average", "core"),
        ("smooth.movavg", "Moving average", "core"),
        ("detrend.linear", "Remove a linear/polynomial baseline roll", "core"),
        // C. Baseline & reference
        ("baseline.select", "Pick the reference window (pre-exposure / first-N / rolling)", "core"),
        ("response.ratio", "Response definition ΔR/R0", "core"),
        ("normalize.r0", "Per-channel / per-session / per-rig R0 normalization", "core"),
        ("blank.subtract", "Blank / solvent subtraction", "core"),
        ("ratio.ab", "Channel ratio (A/B)", "core"),
        ("differential.ab", "Channel differential (A−B)", "core"),
        // D. Static response
        ("feature.steady", "Steady-state value / amplitude", "core"),
        ("feature.peak", "Peak (max/min) and polarity", "core"),
        ("feature.auc", "Integral / AUC", "core"),
        ("feature.fingerprint", "Unit-norm fingerprint vector", "core"),
        // E. Kinetics
        ("feature.kinetics", "Rise/decay rate, t50/t90, onset", "core"),
        ("changepoint", "Change-point detection", "core"),
        // G. Representation
        ("scale.minmax", "Min–max scaling", "core"),
        ("scale.zscore", "z-score scaling", "core"),
        // H. Cross-session/device
        ("align.session", "Align a session to a shared reference", "next"),
        ("align.rig", "Rig transfer / calibration", "next"),
        // I. Identification
        ("train.classifier", "Train a classifier / regressor", "core"),
        ("detect.anomaly", "Novelty / anomaly vs a learned baseline", "core"),
        ("descriptor.lookup", "Odor descriptor retrieval via CID/SMILES", "next"),
        ("confidence.calibrate", "Confidence calibration + refusal when unsupported", "core"),
        // J. Comparison
        ("compare.diff", "Align two sessions and take the difference", "core"),
        ("compare.similarity", "Similarity (Pearson / cosine)", "core"),
        ("cluster", "Cluster results", "core"),
        // N. Provenance
        ("provenance.stamp", "Content hash + contributor + licence", "core"),
        // O. Export
        ("export.csv", "Export CSV", "core"),
        ("export.osmell", "Export a .osmell bundle", "core"),
    ];
    OPS.iter().map(|(op, intent, status)| OpInfo { op, intent, status }).collect()
}

/// The default location for saved recipes: `<config>/Osmograph/recipes`.
pub fn recipes_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("Osmograph").join("recipes")
}

/// FNV-1a 64-bit content hash. Cheap, dependency-free, and enough to detect
/// accidental tampering / duplicate bundles. Real signatures are a `[next]` item.
pub fn content_hash(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{h:016x}")
}

/// Validate a recipe before it can be saved or run. Returns human-readable errors.
pub fn validate_recipe(recipe: &Recipe) -> Vec<String> {
    let mut errs = Vec::new();
    if recipe.id.trim().is_empty() {
        errs.push("recipe.id is required".into());
    }
    if recipe.name.trim().is_empty() {
        errs.push("recipe.name is required".into());
    }
    if semver_like(&recipe.version).is_none() {
        errs.push(format!("recipe.version `{}` is not semver (MAJOR.MINOR.PATCH)", recipe.version));
    }
    if recipe.source.trim().is_empty() {
        errs.push("recipe.source is required (e.g. live, osmell:<id>, dataset:<id>)".into());
    }
    if recipe.steps.is_empty() {
        errs.push("a recipe needs at least one step".into());
    }
    let known = known_ops();
    for (i, step) in recipe.steps.iter().enumerate() {
        if !known.iter().any(|o| o.op == step.op) {
            errs.push(format!("step {i}: unknown op `{}`", step.op));
        }
    }
    errs
}

fn semver_like(v: &str) -> Option<(u64, u64, u64)> {
    let mut it = v.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    let patch = it.next()?.split('-').next()?.parse().ok()?;
    Some((major, minor, patch))
}

/// Build a provenance record. `data` is hashed so the record is bound to content.
pub fn build_provenance(
    source: ProvenanceSource,
    recipe: Option<RecipeRef>,
    now_ms: u64,
    data: &[u8],
) -> Provenance {
    Provenance {
        source,
        recipe,
        software: Software { name: "Osmograph".into(), version: env!("CARGO_PKG_VERSION").into() },
        created_ms: now_ms,
        content_hash: content_hash(data),
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn safe_name(id: &str) -> String {
    let s: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    if s.trim_matches('_').is_empty() { "recipe".to_string() } else { s }
}

// --- persistence (dir-parameterised so tests never touch the real config) ---

fn save_in(dir: &Path, recipe: &Recipe) -> Result<PathBuf, String> {
    let errs = validate_recipe(recipe);
    if !errs.is_empty() {
        return Err(errs.join("; "));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", safe_name(&recipe.id)));
    let body = serde_json::to_string_pretty(recipe).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    Ok(path)
}

fn list_in(dir: &Path) -> Result<Vec<Recipe>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(r) = serde_json::from_str::<Recipe>(&text) {
                out.push(r);
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn load_in(dir: &Path, id: &str) -> Result<Recipe, String> {
    let path = dir.join(format!("{}.json", safe_name(id)));
    let text = std::fs::read_to_string(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("invalid recipe JSON: {e}"))
}

fn delete_in(dir: &Path, id: &str) -> Result<(), String> {
    let path = dir.join(format!("{}.json", safe_name(id)));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// --- Tauri commands ---

/// List saved recipes, sorted by name.
#[tauri::command]
pub fn recipe_list() -> Result<Vec<Recipe>, String> {
    list_in(&recipes_dir())
}

/// Save (create or overwrite) a recipe. Returns the file path.
#[tauri::command]
pub fn recipe_save(recipe: Recipe) -> Result<String, String> {
    save_in(&recipes_dir(), &recipe).map(|p| p.to_string_lossy().to_string())
}

/// Load a recipe by id.
#[tauri::command]
pub fn recipe_load(id: String) -> Result<Recipe, String> {
    load_in(&recipes_dir(), &id)
}

/// Delete a recipe by id.
#[tauri::command]
pub fn recipe_delete(id: String) -> Result<(), String> {
    delete_in(&recipes_dir(), &id)
}

/// The v1 op catalog, for the visible pipeline UI and validators.
#[tauri::command]
pub fn recipe_ops() -> Vec<OpInfo> {
    known_ops()
}

/// Stamp a provenance record for an artifact, hashing the file at `data_path`.
#[tauri::command]
pub fn provenance_stamp(
    source_kind: String,
    source_id: String,
    license: String,
    origin_url: String,
    credit: String,
    recipe_id: Option<String>,
    data_path: String,
) -> Result<Provenance, String> {
    let data = std::fs::read(&data_path).map_err(|e| format!("cannot read {data_path}: {e}"))?;
    let recipe = match recipe_id {
        Some(id) => {
            let r = load_in(&recipes_dir(), &id)?;
            Some(RecipeRef { id: r.id, version: r.version, name: r.name })
        }
        None => None,
    };
    Ok(build_provenance(
        ProvenanceSource { kind: source_kind, id: source_id, license, origin_url, credit },
        recipe,
        now_ms(),
        &data,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Recipe {
        Recipe {
            id: "fermentation".into(),
            name: "Fermentation".into(),
            version: "1.0.0".into(),
            source: "dataset:smellnet".into(),
            steps: vec![
                RecipeStep { op: "smooth.ema".into(), channel: None, params: BTreeMap::new() },
                RecipeStep { op: "response.ratio".into(), channel: Some(0), params: BTreeMap::new() },
            ],
            notes: String::new(),
        }
    }

    #[test]
    fn content_hash_is_deterministic_and_content_bound() {
        assert_eq!(content_hash(b"abc"), content_hash(b"abc"));
        assert_ne!(content_hash(b"abc"), content_hash(b"abd"));
    }

    #[test]
    fn valid_recipe_passes_validation() {
        assert!(validate_recipe(&sample()).is_empty());
    }

    #[test]
    fn unknown_op_and_bad_version_are_rejected() {
        let mut r = sample();
        r.steps[0].op = "does.not.exist".into();
        r.version = "v1".into();
        let errs = validate_recipe(&r);
        assert!(errs.iter().any(|e| e.contains("unknown op")));
        assert!(errs.iter().any(|e| e.contains("semver")));
    }

    #[test]
    fn save_list_load_delete_roundtrip() {
        let dir = std::env::temp_dir().join("osm_recipes_test");
        let _ = std::fs::remove_dir_all(&dir);
        save_in(&dir, &sample()).unwrap();
        let all = list_in(&dir).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "fermentation");
        let loaded = load_in(&dir, "fermentation").unwrap();
        assert_eq!(loaded, sample());
        delete_in(&dir, "fermentation").unwrap();
        assert!(list_in(&dir).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn saving_an_invalid_recipe_fails() {
        let dir = std::env::temp_dir().join("osm_recipes_bad");
        let _ = std::fs::remove_dir_all(&dir);
        let mut r = sample();
        r.steps.clear();
        assert!(save_in(&dir, &r).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn provenance_binds_to_content_and_software() {
        let src = ProvenanceSource {
            kind: "dataset".into(),
            id: "smellnet".into(),
            license: "MIT".into(),
            origin_url: "https://github.com/MIT-MI/SmellNet".into(),
            credit: "MIT Media Lab".into(),
        };
        let p = build_provenance(src, None, 123, b"data");
        assert_eq!(p.created_ms, 123);
        assert_eq!(p.software.name, "Osmograph");
        assert_eq!(p.content_hash, content_hash(b"data"));
        assert!(p.recipe.is_none());
    }
}
