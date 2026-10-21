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
    /// Whether [`run_pipeline`] can execute it today. The catalog keeps planned
    /// ops visible, but the editor must not offer a step that cannot run.
    pub implemented: bool,
}

/// The result of running a pipeline: transformed series, per-channel units, the
/// exact steps applied, and any honest warnings (masked samples, bad baselines).
#[derive(Debug, Clone, Serialize)]
pub struct RecipeRun {
    pub channels: Vec<String>,
    pub units: Vec<String>,
    pub time: Vec<f64>,
    pub values: Vec<Vec<Option<f64>>>,
    pub applied: Vec<String>,
    pub warnings: Vec<String>,
}

/// The v1 op catalog — the `[core]` subset of the taxonomy in SMELL_OPERATIONS.md §3.
pub fn known_ops() -> Vec<OpInfo> {
    const OPS: &[(&str, &str, &str)] = &[
        // A. Acquisition & ingest
        ("import.csv", "Import a CSV/JSON recording", "core"),
        ("units.convert", "raw ADC / voltage / resistance → conductance / ΔR/R0 / ppm estimate", "core"),
        ("resample", "Resample to a uniform time grid", "core"),
        ("trim.range", "Trim to an explicit start/end second window", "core"),
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
    OPS.iter()
        .map(|(op, intent, status)| OpInfo {
            op,
            intent,
            status,
            implemented: is_runnable(op),
        })
        .collect()
}

/// Ops the executor understands today. Everything else stays in the catalog as
/// a labelled plan rather than a silent no-op.
pub fn is_runnable(op: &str) -> bool {
    matches!(
        op,
        "trim.range"
            | "missing.fill"
            | "outlier.remove"
            | "smooth.ema"
            | "smooth.movavg"
            | "detrend.linear"
            | "baseline.select"
            | "response.ratio"
            | "normalize.r0"
            | "scale.minmax"
            | "scale.zscore"
    )
}

fn param(step: &RecipeStep, key: &str, default: f64) -> f64 {
    step.params.get(key).copied().filter(|v| v.is_finite()).unwrap_or(default)
}

fn step_label(step: &RecipeStep) -> String {
    let mut s = step.op.clone();
    if !step.params.is_empty() {
        let ps: Vec<String> = step.params.iter().map(|(k, v)| format!("{k}={v}")).collect();
        s.push_str(&format!("({})", ps.join(",")));
    }
    match step.channel {
        Some(ci) => s.push_str(&format!(" → ch{ci}")),
        None => s.push_str(" → all channels"),
    }
    s
}

fn mean_first(v: &[f64], n: usize) -> Option<f64> {
    let mut sum = 0.0;
    let mut count = 0usize;
    for &x in v.iter().take(n) {
        if x.is_finite() {
            sum += x;
            count += 1;
        }
    }
    (count > 0).then_some(sum / count as f64)
}

fn mean_window(v: &[f64], time: &[f64], start: f64, end: f64) -> Option<f64> {
    let mut sum = 0.0;
    let mut count = 0usize;
    for (i, &x) in v.iter().enumerate() {
        let t = time.get(i).copied().unwrap_or(i as f64);
        if t >= start && t <= end && x.is_finite() {
            sum += x;
            count += 1;
        }
    }
    (count > 0).then_some(sum / count as f64)
}

fn movavg(v: &[f64], window: usize) -> Vec<f64> {
    let w = window.max(1);
    let half = w / 2;
    (0..v.len())
        .map(|i| {
            let lo = i.saturating_sub(half);
            let hi = (i + half).min(v.len().saturating_sub(1));
            let mut sum = 0.0;
            let mut count = 0usize;
            for &x in &v[lo..=hi] {
                if x.is_finite() {
                    sum += x;
                    count += 1;
                }
            }
            if count > 0 { sum / count as f64 } else { f64::NAN }
        })
        .collect()
}

fn ema(v: &[f64], alpha: f64) -> Vec<f64> {
    let a = alpha.clamp(0.0, 1.0);
    let mut prev = f64::NAN;
    v.iter()
        .map(|&x| {
            if x.is_finite() {
                prev = if prev.is_finite() { a * x + (1.0 - a) * prev } else { x };
                prev
            } else {
                prev
            }
        })
        .collect()
}

fn detrend(v: &[f64]) -> Vec<f64> {
    let pts: Vec<(f64, f64)> = v
        .iter()
        .enumerate()
        .filter_map(|(i, &x)| x.is_finite().then_some((i as f64, x)))
        .collect();
    if pts.len() < 2 {
        return v.to_vec();
    }
    let n = pts.len() as f64;
    let mx = pts.iter().map(|p| p.0).sum::<f64>() / n;
    let my = pts.iter().map(|p| p.1).sum::<f64>() / n;
    let mut num = 0.0;
    let mut den = 0.0;
    for (x, y) in &pts {
        num += (x - mx) * (y - my);
        den += (x - mx) * (x - mx);
    }
    let b = if den > 1e-12 { num / den } else { 0.0 };
    let a = my - b * mx;
    v.iter()
        .enumerate()
        .map(|(i, &x)| if x.is_finite() { x - (a + b * i as f64) } else { f64::NAN })
        .collect()
}

fn fill_linear(v: &[f64]) -> Vec<f64> {
    let mut out = v.to_vec();
    let n = out.len();
    let mut i = 0;
    while i < n {
        if out[i].is_finite() {
            i += 1;
            continue;
        }
        let start = i;
        while i < n && !out[i].is_finite() {
            i += 1;
        }
        let end = i;
        let prev = if start > 0 { out[start - 1] } else { f64::NAN };
        let next = if end < n { out[end] } else { f64::NAN };
        for j in start..end {
            out[j] = if prev.is_finite() && next.is_finite() {
                let f = (j - start + 1) as f64 / (end - start + 1) as f64;
                prev + (next - prev) * f
            } else if prev.is_finite() {
                prev
            } else {
                next
            };
        }
    }
    out
}

fn fill_locf(v: &[f64]) -> Vec<f64> {
    let mut last = f64::NAN;
    v.iter()
        .map(|&x| {
            if x.is_finite() {
                last = x;
                x
            } else {
                last
            }
        })
        .collect()
}

fn minmax(v: &[f64]) -> Vec<f64> {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for &x in v.iter().filter(|x| x.is_finite()) {
        lo = lo.min(x);
        hi = hi.max(x);
    }
    if !(hi - lo > 1e-12) {
        return v.iter().map(|x| if x.is_finite() { 0.0 } else { f64::NAN }).collect();
    }
    v.iter()
        .map(|&x| if x.is_finite() { (x - lo) / (hi - lo) } else { f64::NAN })
        .collect()
}

fn zscore(v: &[f64]) -> Vec<f64> {
    let finite: Vec<f64> = v.iter().copied().filter(|x| x.is_finite()).collect();
    if finite.is_empty() {
        return v.to_vec();
    }
    let mean = finite.iter().sum::<f64>() / finite.len() as f64;
    let var = finite.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>() / finite.len() as f64;
    let sd = var.sqrt();
    if !(sd > 1e-12) {
        return v.iter().map(|x| if x.is_finite() { 0.0 } else { f64::NAN }).collect();
    }
    v.iter()
        .map(|&x| if x.is_finite() { (x - mean) / sd } else { f64::NAN })
        .collect()
}

/// Execute a pipeline over one session. Returns the transformed series plus the
/// exact steps and warnings, so a result is reproducible rather than a screenshot.
pub fn run_pipeline(
    channels: &[String],
    time: &[f64],
    values: &[Vec<f64>],
    steps: &[RecipeStep],
) -> Result<RecipeRun, String> {
    if steps.is_empty() {
        return Err("a recipe needs at least one step".into());
    }
    let mut data: Vec<Vec<f64>> = values.to_vec();
    let mut timeline: Vec<f64> = time.to_vec();
    let mut units = vec!["raw".to_string(); channels.len()];
    let mut baseline: Option<Vec<f64>> = None;
    let mut applied = Vec::new();
    let mut warnings = Vec::new();

    for (i, step) in steps.iter().enumerate() {
        if !is_runnable(&step.op) {
            return Err(format!(
                "step {}: `{}` is in the catalog but not runnable yet",
                i + 1,
                step.op
            ));
        }
        let targets: Vec<usize> = match step.channel {
            Some(ci) if ci < data.len() => vec![ci],
            Some(ci) => {
                return Err(format!(
                    "step {}: channel {} is out of range ({} channels)",
                    i + 1,
                    ci,
                    data.len()
                ))
            }
            None => (0..data.len()).collect(),
        };

        match step.op.as_str() {
            "trim.range" => {
                let start = param(step, "start", 0.0);
                let end = param(step, "end", f64::INFINITY);
                if !start.is_finite() || end < start {
                    return Err(format!(
                        "step {}: trim.range needs finite start <= end",
                        i + 1
                    ));
                }
                let keep: Vec<usize> = timeline
                    .iter()
                    .enumerate()
                    .filter(|(_, t)| **t >= start && **t <= end)
                    .map(|(idx, _)| idx)
                    .collect();
                if keep.len() < 2 {
                    return Err(format!(
                        "step {}: trim.range kept {} sample(s); widen the window",
                        i + 1,
                        keep.len()
                    ));
                }
                timeline = keep.iter().map(|&idx| timeline[idx]).collect();
                data = data
                    .iter()
                    .map(|v| keep.iter().map(|&idx| v[idx]).collect())
                    .collect();
                warnings.push(format!(
                    "trimmed to {:.3}–{:.3}s ({} samples)",
                    timeline.first().copied().unwrap_or(0.0),
                    timeline.last().copied().unwrap_or(0.0),
                    timeline.len()
                ));
            }
            "baseline.select" => {
                let start = param(step, "start", 0.0);
                let end = param(step, "end", f64::INFINITY);
                let mut picked = vec![f64::NAN; data.len()];
                for ci in 0..data.len() {
                    picked[ci] = mean_window(&data[ci], &timeline, start, end)
                        .or_else(|| mean_first(&data[ci], 15))
                        .unwrap_or(f64::NAN);
                }
                baseline = Some(picked);
            }
            "response.ratio" | "normalize.r0" => {
                let base = baseline.clone().unwrap_or_else(|| {
                    data.iter().map(|v| mean_first(v, 15).unwrap_or(f64::NAN)).collect()
                });
                for &ci in &targets {
                    let r0 = base.get(ci).copied().unwrap_or(f64::NAN);
                    if !r0.is_finite() || r0.abs() < 1e-12 {
                        warnings.push(format!(
                            "{} has no usable baseline; its response is undefined",
                            channels.get(ci).cloned().unwrap_or_else(|| format!("ch{ci}"))
                        ));
                        data[ci] = vec![f64::NAN; data[ci].len()];
                        continue;
                    }
                    data[ci] = data[ci]
                        .iter()
                        .map(|&x| {
                            if !x.is_finite() {
                                f64::NAN
                            } else if step.op == "response.ratio" {
                                (x - r0) / r0
                            } else {
                                x / r0
                            }
                        })
                        .collect();
                    units[ci] = if step.op == "response.ratio" { "ΔR/R0" } else { "R/R0" }.to_string();
                }
            }
            "smooth.movavg" => {
                let w = param(step, "window", 5.0).round().max(1.0) as usize;
                for &ci in &targets {
                    data[ci] = movavg(&data[ci], w);
                }
            }
            "smooth.ema" => {
                let a = param(step, "alpha", 0.3);
                for &ci in &targets {
                    data[ci] = ema(&data[ci], a);
                }
            }
            "detrend.linear" => {
                for &ci in &targets {
                    data[ci] = detrend(&data[ci]);
                }
            }
            "missing.fill" => {
                let locf = param(step, "method", 0.0) >= 1.0;
                for &ci in &targets {
                    data[ci] = if locf { fill_locf(&data[ci]) } else { fill_linear(&data[ci]) };
                }
            }
            "outlier.remove" => {
                let z = param(step, "z", 3.0).abs().max(1.0);
                for &ci in &targets {
                    let finite: Vec<f64> = data[ci].iter().copied().filter(|x| x.is_finite()).collect();
                    if finite.len() < 3 {
                        continue;
                    }
                    let mean = finite.iter().sum::<f64>() / finite.len() as f64;
                    let var = finite.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>() / finite.len() as f64;
                    let sd = var.sqrt();
                    if !(sd > 1e-12) {
                        continue;
                    }
                    let mut masked = 0usize;
                    for x in data[ci].iter_mut() {
                        if x.is_finite() && (*x - mean).abs() > z * sd {
                            *x = f64::NAN;
                            masked += 1;
                        }
                    }
                    if masked > 0 {
                        warnings.push(format!(
                            "{} outlier(s) masked on {}; add missing.fill to interpolate",
                            masked,
                            channels.get(ci).cloned().unwrap_or_else(|| format!("ch{ci}"))
                        ));
                    }
                }
            }
            "scale.minmax" => {
                for &ci in &targets {
                    data[ci] = minmax(&data[ci]);
                    units[ci] = "min–max".into();
                }
            }
            "scale.zscore" => {
                for &ci in &targets {
                    data[ci] = zscore(&data[ci]);
                    units[ci] = "z-score".into();
                }
            }
            _ => unreachable!("is_runnable admitted an unknown op"),
        }
        applied.push(step_label(step));
    }

    Ok(RecipeRun {
        channels: channels.to_vec(),
        units,
        time: timeline,
        values: data
            .into_iter()
            .map(|v| v.into_iter().map(|x| x.is_finite().then_some(x)).collect())
            .collect(),
        applied,
        warnings,
    })
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

    fn step(op: &str) -> RecipeStep {
        RecipeStep { op: op.into(), channel: None, params: BTreeMap::new() }
    }

    #[test]
    fn response_ratio_uses_the_selected_baseline() {
        let channels = vec!["CO".to_string()];
        let time = vec![0.0, 1.0, 2.0, 3.0];
        let values = vec![vec![2.0, 2.0, 4.0, 6.0]];
        let mut base = step("baseline.select");
        base.params.insert("start".into(), 0.0);
        base.params.insert("end".into(), 1.0);
        let run = run_pipeline(&channels, &time, &values, &[base, step("response.ratio")]).unwrap();
        assert_eq!(run.units[0], "ΔR/R0");
        let out: Vec<f64> = run.values[0].iter().map(|v| v.unwrap()).collect();
        assert_eq!(out, vec![0.0, 0.0, 1.0, 2.0]);
    }

    #[test]
    fn a_channel_target_leaves_other_channels_alone() {
        let channels = vec!["A".to_string(), "B".to_string()];
        let time = vec![0.0, 1.0, 2.0, 3.0];
        let values = vec![vec![2.0, 2.0, 4.0, 6.0], vec![10.0, 10.0, 20.0, 30.0]];
        let mut ratio = step("response.ratio");
        ratio.channel = Some(0);
        let run = run_pipeline(&channels, &time, &values, &[ratio]).unwrap();
        assert_eq!(run.units[0], "ΔR/R0");
        assert_eq!(run.units[1], "raw");
        let b: Vec<f64> = run.values[1].iter().map(|v| v.unwrap()).collect();
        assert_eq!(b, vec![10.0, 10.0, 20.0, 30.0]);
    }

    #[test]
    fn trim_range_cuts_time_and_values_in_place() {
        let channels = vec!["CO".to_string()];
        let time = vec![0.0, 1.0, 2.0, 3.0, 4.0];
        let values = vec![vec![10.0, 20.0, 30.0, 40.0, 50.0]];
        let mut trim = step("trim.range");
        trim.params.insert("start".into(), 1.0);
        trim.params.insert("end".into(), 3.0);
        let run = run_pipeline(&channels, &time, &values, &[trim]).unwrap();
        assert_eq!(run.time, vec![1.0, 2.0, 3.0]);
        let out: Vec<f64> = run.values[0].iter().map(|v| v.unwrap()).collect();
        assert_eq!(out, vec![20.0, 30.0, 40.0]);
        assert!(run.warnings.iter().any(|w| w.contains("trimmed to")));
    }

    #[test]
    fn moving_average_smooths_without_shifting_the_edges() {
        let channels = vec!["CO".to_string()];
        let time = vec![0.0, 1.0, 2.0, 3.0, 4.0];
        let values = vec![vec![0.0, 0.0, 3.0, 0.0, 0.0]];
        let mut smooth = step("smooth.movavg");
        smooth.params.insert("window".into(), 3.0);
        let run = run_pipeline(&channels, &time, &values, &[smooth]).unwrap();
        let out: Vec<f64> = run.values[0].iter().map(|v| v.unwrap()).collect();
        assert_eq!(out, vec![0.0, 1.0, 1.0, 1.0, 0.0]);
    }

    #[test]
    fn planned_ops_fail_loudly_instead_of_silently_doing_nothing() {
        let channels = vec!["CO".to_string()];
        let time = vec![0.0, 1.0];
        let values = vec![vec![1.0, 2.0]];
        let err = run_pipeline(&channels, &time, &values, &[step("feature.auc")]).unwrap_err();
        assert!(err.contains("not runnable"));
        assert!(!is_runnable("feature.auc"));
        assert!(is_runnable("response.ratio"));
    }
}
