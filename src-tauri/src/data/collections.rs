//! Folder-aware classification of recordings into collections.
//!
//! Downloaded corpora name the substance in the directory, not the file. A
//! SmellNet recording is `base_data/testing/apple/apple_6.csv`; deriving the
//! label from the filename alone yields an empty substance (and the old
//! `file_id` derivation collided on `sweet_potato_5` / `sweet_potato_6`).
//!
//! This module is the single place that turns a path into:
//!   collection id/name · substance · split · condition
//! and a stable id for imported files. Paths are evidence, not a schema: the
//! values are stored on the index record so a later move does not silently
//! relabel the library.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Classification {
    pub collection_id: String,
    pub collection_name: String,
    pub substance: String,
    /// Preparation/nuance inside a substance (`warm`, `after warm`, `ground`).
    /// Empty when the path does not declare one; never invented from a guess.
    pub preparation: String,
    /// `reference` (room air, blank, baseline) or `noise` for control runs.
    /// Empty for an ordinary sample. Controls stay in the library but are not
    /// counted as smell classes or training labels.
    pub role: String,
    pub split: String,
    pub condition: String,
}

/// Files the library can parse as recordings.
pub fn is_supported_recording(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("csv") || e.eq_ignore_ascii_case("osmell"))
        .unwrap_or(false)
}

/// Known non-recordings inside otherwise valid corpus folders. The TADI archive
/// ships an anemometer CSV beside the gas loggers; importing it as a methane
/// recording would invent a label for wind data.
pub fn is_known_non_recording(path: &Path) -> bool {
    let p = path.to_string_lossy().to_ascii_lowercase().replace('\\', "/");
    let file = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_ascii_lowercase();
    if file == "_index_.csv"
        || file == "test_index.csv"
        || file == "sonic3d_anemometer.csv"
        || file.contains("_index_")
    {
        return true;
    }
    if p.contains("/gcms_") || p.contains("/_index_") || p.contains("/test_index") {
        return true;
    }
    p.contains("gcms_") || p.contains("/test_index") || p.contains("sonic3d_anemometer.csv")
}

/// Split an explicit preparation prefix from a user label. Only unambiguous
/// words are treated as preparations; a bare name stays intact.
pub fn split_preparation(raw: &str) -> (String, String) {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    let prefixes: &[(&str, &str)] = &[
        ("after warm ", "after warm"),
        ("after-warm ", "after warm"),
        ("after warming ", "after warm"),
        ("warm ", "warm"),
        ("warmed ", "warm"),
        ("raw ", "raw"),
        ("ground ", "ground"),
        ("peeled ", "peeled"),
        ("sliced ", "sliced"),
        ("chopped ", "chopped"),
        ("crushed ", "crushed"),
        ("heated ", "heated"),
        ("cold ", "cold"),
    ];
    for (prefix, prep) in prefixes {
        if lower.starts_with(prefix) {
            let rest = trimmed[prefix.len()..].trim();
            if !rest.is_empty() {
                return (rest.to_string(), (*prep).to_string());
            }
        }
    }
    (trimmed.to_string(), String::new())
}

const GENERIC_DIRS: &[&str] = &[
    "datasets",
    "dataset",
    "extracted",
    "extract",
    "csv",
    "csvs",
    "data",
    "raw",
    "recordings",
    "recording",
    "exports",
    "export",
    "allsmaples-report",
    "all-samples-report",
    "all_samples_report",
    "samples",
    "downloads",
    "download",
    "imports",
    "import",
    "files",
    "new folder",
];

fn is_generic(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    GENERIC_DIRS.iter().any(|g| *g == n)
        || n.starts_with("allsm")
        || n.starts_with("all-samples")
}

fn is_split(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "training"
            | "train"
            | "testing"
            | "test"
            | "test_seen"
            | "test-seen"
            | "test_unseen"
            | "test-unseen"
            | "validation"
            | "val"
            | "calibration"
            | "real_time_testing"
            | "real_time_testing_nut"
    )
}

fn is_dataset_root(name: &str) -> bool {
    name.eq_ignore_ascii_case("datasets") || name.eq_ignore_ascii_case("dataset")
}

fn strip_ext(name: &str) -> &str {
    let mut out = name;
    loop {
        let lower = out.to_ascii_lowercase();
        if lower.ends_with(".csv") {
            out = &out[..out.len() - 4];
        } else if lower.ends_with(".osmell") {
            out = &out[..out.len() - 7];
        } else {
            return out;
        }
    }
}

/// `20260615_190732_mosquito coil` -> `mosquito coil`.
pub fn strip_timestamp(stem: &str) -> Option<&str> {
    let b = stem.as_bytes();
    if b.len() <= 16
        || b.get(8) != Some(&b'_')
        || b.get(15) != Some(&b'_')
        || !b[..8].iter().all(u8::is_ascii_digit)
        || !b[9..15].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    if !stem.is_char_boundary(16) {
        return None;
    }
    let rest = stem[16..].trim();
    if rest.is_empty() {
        None
    } else {
        Some(rest)
    }
}

pub fn has_timestamp_prefix(name: &str) -> bool {
    strip_timestamp(strip_ext(name)).is_some()
}

fn split_concatenated_pascal(s: &str) -> Option<String> {
    if s.contains(' ') || s.contains('_') || s.contains('-') {
        return None;
    }
    let chars: Vec<char> = s.chars().collect();
    if chars.len() < 12 {
        return None;
    }
    let mut parts = Vec::new();
    let mut start = 0;
    for i in 1..chars.len() {
        let c = chars[i];
        let prev = chars[i - 1];
        if c.is_ascii_uppercase() && (prev.is_ascii_lowercase() || prev.is_ascii_digit()) {
            let part: String = chars[start..i].iter().collect();
            if part.len() >= 2 {
                parts.push(part);
            }
            start = i;
        } else if c.is_ascii_digit() && prev.is_ascii_lowercase() {
            let part: String = chars[start..i].iter().collect();
            if part.len() >= 2 {
                parts.push(part);
            }
            start = i;
        }
    }
    if start < chars.len() {
        let part: String = chars[start..].iter().collect();
        if part.len() >= 2 {
            parts.push(part);
        }
    }
    if parts.len() >= 3 {
        Some(parts.join(" "))
    } else {
        None
    }
}

pub fn is_suspicious_substance(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() {
        return true;
    }
    if t.to_ascii_lowercase() == "unknown" {
        return true;
    }
    if t.contains(' ') || t.contains('_') || t.contains('-') || t.contains('+') {
        return false;
    }
    let chars: Vec<char> = t.chars().collect();
    if chars.len() > 28 {
        return true;
    }
    let upper = chars.iter().filter(|c| c.is_ascii_uppercase()).count();
    let lower = chars.iter().filter(|c| c.is_ascii_lowercase()).count();
    if upper >= 3 && lower >= chars.len() / 3 {
        return true;
    }
    false
}

fn prettify(raw: &str) -> String {
    if let Some(split) = split_concatenated_pascal(raw) {
        let mut out = String::with_capacity(split.len());
        let mut last_space = true;
        for c in split.chars() {
            if c == '_' || c == '-' || c.is_whitespace() {
                if !last_space {
                    out.push(' ');
                    last_space = true;
                }
            } else {
                out.push(c);
                last_space = false;
            }
        }
        return out.trim().to_string();
    }
    let mut out = String::with_capacity(raw.len());
    let mut last_space = true;
    for c in raw.chars() {
        if c == '_' || c == '-' || c.is_whitespace() {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(c);
            last_space = false;
        }
    }
    out.trim().to_string()
}

fn title_case(raw: &str) -> String {
    let mut chars = raw.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn pretty_split(raw: &str) -> String {
    title_case(&prettify(raw))
}

fn slug(raw: &str) -> String {
    let mut out = String::new();
    for c in raw.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

fn dataset_identity(dest: &str) -> (String, String) {
    let d = dest.to_ascii_lowercase();
    if d.contains("smellnet") {
        if d.contains("mixture") {
            ("smellnet-mixtures".to_string(), "SmellNet mixtures".to_string())
        } else {
            ("smellnet".to_string(), "SmellNet".to_string())
        }
    } else if d.contains("tadi") {
        ("tadi-2019".to_string(), "TADI".to_string())
    } else if d.contains("food") || d.contains("freshness") || d == "extracted" {
        ("food-freshness".to_string(), "Food Freshness".to_string())
    } else {
        (slug(dest), prettify(dest))
    }
}

fn strip_run_suffix(raw: &str) -> &str {
    if let Some((base, tail)) = raw.rsplit_once('_') {
        if !base.is_empty()
            && !tail.is_empty()
            && tail.len() <= 2
            && tail.chars().all(|c| c.is_ascii_digit())
        {
            return base;
        }
    }
    raw
}

fn run_condition(file: &str) -> String {
    let stem = strip_ext(file);
    let stem = stem.split('.').next().unwrap_or(stem);
    if let Some((_, tail)) = stem.rsplit_once('_') {
        if !tail.is_empty() && tail.len() <= 2 && tail.chars().all(|c| c.is_ascii_digit()) {
            return format!("run {tail}");
        }
    }
    String::new()
}

/// `Almond20_Orange80` -> `Almond 20 + Orange 80`; other names just prettified.
fn mixture_label(raw: &str) -> String {
    if !raw.contains('_') {
        return prettify(raw);
    }
    let parts: Vec<String> = raw
        .split('_')
        .filter(|p| !p.is_empty())
        .map(|part| {
            let split_at = part
                .char_indices()
                .find(|(_, c)| c.is_ascii_digit())
                .map(|(i, _)| i);
            match split_at {
                Some(i) if i > 0 => {
                    let (name, amount) = part.split_at(i);
                    format!("{} {}", title_case(name), amount)
                }
                _ => title_case(part),
            }
        })
        .collect();
    parts.join(" + ")
}

fn condition_from_suffix(raw: &str) -> String {
    let raw = raw.trim_matches('.');
    if raw.is_empty() {
        return String::new();
    }
    // `Almond20_Orange80.4v30t9nt.ingestion-balanced` -> only the final
    // dot segment is a condition; the preceding segment is the run hash.
    let Some((_, tail)) = raw.rsplit_once('.') else {
        return String::new();
    };
    let tail = tail.trim_matches('.');
    if tail.is_empty() {
        return String::new();
    }
    // A bare alphanumeric token with digits (`4v30t9nt`) is a run hash, not a
    // condition. Real conditions carry a separator or a word (`dry`).
    if tail.len() <= 12
        && tail.chars().any(|c| c.is_ascii_digit())
        && !tail.contains('-')
        && !tail.contains('_')
        && !tail.contains(' ')
    {
        return String::new();
    }
    prettify(tail)
}

/// `Banana D1` -> (`Banana`, `day 1`).
fn food_label(file: &str) -> (String, String) {
    let stem = strip_ext(file);
    for sep in [' ', '_'] {
        if let Some((base, tail)) = stem.rsplit_once(sep) {
            if let Some(rest) = tail.strip_prefix('D').or_else(|| tail.strip_prefix('d')) {
                if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
                    let base = prettify(base);
                    if !base.is_empty() {
                        return (base, format!("day {rest}"));
                    }
                }
            }
        }
    }
    (prettify(stem), String::new())
}

/// Control runs are evidence, not smell classes. A label is only treated as a
/// reference/noise run when the word is explicit; `air freshener` stays a
/// sample.
pub fn recording_role(substance: &str) -> String {
    let s = substance.trim().to_ascii_lowercase();
    if s == "noise" || s.starts_with("noise ") {
        "noise".to_string()
    } else if s == "air"
        || s == "reference"
        || s.starts_with("room air")
        || s.starts_with("ambient air")
        || s.starts_with("fresh air")
        || s.starts_with("clean air")
        || s.starts_with("baseline")
        || s.starts_with("blank")
        || s.starts_with("empty")
    {
        "reference".to_string()
    } else {
        String::new()
    }
}

fn filename_substance(file: &str) -> String {
    let stem = strip_ext(file);
    if let Some(rest) = strip_timestamp(stem) {
        return prettify(rest);
    }
    // Hugging Face files are `apple.6e9ce5acaf80.csv`; the hash is not a label.
    let first = stem.split('.').next().unwrap_or(stem);
    prettify(strip_run_suffix(first))
}

fn file_stem(file: &str) -> String {
    prettify(strip_ext(file))
}

fn nearest_folder<'a>(dirs: &'a [&'a str]) -> Option<&'a str> {
    dirs.iter()
        .rev()
        .copied()
        .find(|d| !is_generic(d) && !is_split(d))
}

fn classify_dataset(id: &str, inner: &[&str], file: &str, c: &mut Classification) {
    let split_idx = inner.iter().position(|part| is_split(part));
    let split = split_idx.map(|i| inner[i]).unwrap_or("");
    let after = split_idx.map(|i| &inner[i + 1..]).unwrap_or(inner);
    c.split = pretty_split(split);

    match id {
        "smellnet" => {
            let folder = after
                .iter()
                .rev()
                .copied()
                .find(|part| !part.contains('.') && !is_generic(part));
            c.substance = folder
                .map(prettify)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| filename_substance(file));
            c.condition = run_condition(file);
        }
        "smellnet-mixtures" => {
            let folder = after
                .iter()
                .rev()
                .copied()
                .find(|part| !part.contains('.') && !is_generic(part));
            let mixture = folder
                .map(prettify)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    let stem = strip_ext(file);
                    mixture_label(stem.split('.').next().unwrap_or(stem))
                });
            c.substance = mixture;
            let stem = strip_ext(file);
            c.condition = condition_from_suffix(stem);
        }
        "tadi-2019" => {
            c.substance = "methane".to_string();
            c.condition = file_stem(file);
            if c.split.is_empty() {
                c.split = "Release".to_string();
            }
        }
        "food-freshness" => {
            let (substance, condition) = food_label(file);
            c.substance = substance;
            c.condition = condition;
        }
        _ => {
            c.substance = nearest_folder(after)
                .map(prettify)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| filename_substance(file));
            c.condition = run_condition(file);
        }
    }
}

/// Classify one recording path. `recordings_dir` anchors the `datasets/` tree;
/// paths outside it are treated as explicit imports.
pub fn classify(path: &Path, recordings_dir: &Path) -> Classification {
    let p = path.to_string_lossy().replace('\\', "/");
    let rd = recordings_dir.to_string_lossy().replace('\\', "/");
    let rel = p.strip_prefix(rd.as_str()).unwrap_or(&p).trim_start_matches('/');
    let comps: Vec<&str> = rel.split('/').filter(|part| !part.is_empty()).collect();
    let file = comps.last().copied().unwrap_or("");
    let mut c = Classification::default();

    if comps.len() >= 2 && is_dataset_root(comps[0]) {
        let dest = comps[1];
        let (id, name) = dataset_identity(dest);
        c.collection_id = id.clone();
        c.collection_name = name;
        // The final component is the file itself; only directories inside the
        // collection root describe split/substance.
        let inner = if comps.len() > 2 {
            &comps[2..comps.len() - 1]
        } else {
            &[]
        };
        classify_dataset(&id, inner, file, &mut c);
        let (substance, preparation) = split_preparation(&c.substance);
        c.substance = substance;
        c.preparation = preparation;
        c.role = recording_role(&c.substance);
        return c;
    }

    if comps.first().is_some_and(|part| part.eq_ignore_ascii_case("legacy")) {
        c.collection_id = "legacy".to_string();
        c.collection_name = "Legacy".to_string();
        let (substance, preparation) = split_preparation(&filename_substance(file));
        c.substance = substance;
        c.preparation = preparation;
        c.role = recording_role(&c.substance);
        return c;
    }
    if comps.first().is_some_and(|part| part.eq_ignore_ascii_case("derived")) {
        c.collection_id = "derived".to_string();
        c.collection_name = "Derived".to_string();
        let (substance, preparation) = split_preparation(&filename_substance(file));
        c.substance = substance;
        c.preparation = preparation;
        c.role = recording_role(&c.substance);
        return c;
    }

    // The bundled no-hardware sample is a real SmellNet apple recording, not a
    // user recording that happens to sit in the recordings root.
    if file.starts_with("playground_smellnet_") {
        c.collection_id = "smellnet".to_string();
        c.collection_name = "SmellNet".to_string();
        c.substance = "apple".to_string();
        c.split = "Playground".to_string();
        return c;
    }

    // Recordings written by this app live directly under the recordings dir and
    // use the timestamp + user label convention.
    if p.starts_with(rd.as_str()) {
        c.collection_id = "own".to_string();
        c.collection_name = "Own rig".to_string();
        let (substance, preparation) = split_preparation(&filename_substance(file));
        c.substance = substance;
        c.preparation = preparation;
        c.role = recording_role(&c.substance);
        return c;
    }

    // Explicit import from anywhere else. A meaningful parent folder is a
    // collection; the file itself carries the smell only when the folder is a
    // generic container (Downloads, csv, …).
    let parent = comps.iter().rev().nth(1).copied().unwrap_or("");
    let parent_clean = prettify(parent);
    c.collection_id = "imported".to_string();
    c.collection_name = if parent.is_empty() || is_generic(parent) {
        "Imported".to_string()
    } else {
        title_case(&parent_clean)
    };
    let raw_substance = if !parent.is_empty() && !is_generic(parent) {
        parent_clean
    } else {
        filename_substance(file)
    };
    let (substance, preparation) = split_preparation(&raw_substance);
    c.substance = substance;
    c.preparation = preparation;
    c.role = recording_role(&c.substance);
    c.condition = run_condition(file);
    c
}

/// A deterministic id for an imported file. The old timestamp-derived id
/// collided whenever two labels shared their first two `_` segments.
pub fn stable_import_id(path: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in path.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("i-{hash:016x}")
}

/// The human label shown in the library's Label column for imported records.
pub fn display_label(c: &Classification) -> String {
    if c.collection_id == "own" {
        return "Recorded".to_string();
    }
    if !c.preparation.is_empty() {
        return title_case(&c.preparation);
    }
    if !c.condition.is_empty() {
        return title_case(&c.condition);
    }
    if !c.split.is_empty() {
        return title_case(&c.split);
    }
    "Imported".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn root() -> PathBuf {
        PathBuf::from("/home/me/Osmograph_Recordings")
    }

    #[test]
    fn smellnet_uses_the_substance_folder() {
        let p = root().join("datasets/SmellNet-single/base_data/training/walnuts/walnuts_5.csv");
        let c = classify(&p, &root());
        assert_eq!(c.collection_id, "smellnet");
        assert_eq!(c.substance, "walnuts");
        assert_eq!(c.split, "Training");
        assert_eq!(c.condition, "run 5");
        assert_eq!(display_label(&c), "Run 5");
    }

    #[test]
    fn hashed_smellnet_name_does_not_become_the_label() {
        let p = root().join("datasets/SmellNet-single/base_data/testing/apple/apple.6e9ce5acaf80.csv.csv");
        let c = classify(&p, &root());
        assert_eq!(c.substance, "apple");
    }

    #[test]
    fn mixtures_are_named_from_the_prefix() {
        let p = root().join(
            "datasets/SmellNet-mixtures/mixture_data/test_seen/Almond20_Orange80.4v30t9nt.ingestion-balanced.csv",
        );
        let c = classify(&p, &root());
        assert_eq!(c.collection_id, "smellnet-mixtures");
        assert_eq!(c.substance, "Almond 20 + Orange 80");
        assert_eq!(c.condition, "ingestion balanced");
    }

    #[test]
    fn food_freshness_keeps_the_day() {
        let p = root().join("datasets/extracted/AllSmaples-Report/Green Apple D3.csv");
        let c = classify(&p, &root());
        assert_eq!(c.collection_id, "food-freshness");
        assert_eq!(c.substance, "Green Apple");
        assert_eq!(c.condition, "day 3");
    }

    #[test]
    fn own_timestamped_recording_keeps_its_label() {
        let p = root().join("20260615_190732_mosquito coil 15 jun.csv");
        let c = classify(&p, &root());
        assert_eq!(c.collection_id, "own");
        assert_eq!(c.substance, "mosquito coil 15 jun");
        assert_eq!(c.preparation, "");
    }

    #[test]
    fn own_preparation_is_a_nuance_not_a_new_smell() {
        let warm = root().join("20260613_180633_warm garlic.csv");
        let after = root().join("20260613_180921_after warm garlic.csv");
        let w = classify(&warm, &root());
        let a = classify(&after, &root());
        assert_eq!(w.substance, "garlic");
        assert_eq!(w.preparation, "warm");
        assert_eq!(a.substance, "garlic");
        assert_eq!(a.preparation, "after warm");
        assert_ne!(w.preparation, a.preparation);
    }

    #[test]
    fn controls_are_not_ordinary_smells() {
        assert_eq!(recording_role("room air"), "reference");
        assert_eq!(recording_role("Baseline 2"), "reference");
        assert_eq!(recording_role("noise"), "noise");
        assert_eq!(recording_role("air freshener"), "");
        assert_eq!(recording_role("garlic"), "");
    }

    #[test]
    fn tadi_anemometer_is_not_a_methane_recording() {
        let p = root().join("datasets/TADI-2019/sonic3d_anemometer.csv");
        assert!(is_known_non_recording(&p));
        let logger = root().join("datasets/TADI-2019/Logger_A.csv");
        assert!(!is_known_non_recording(&logger));
    }

    #[test]
    fn stable_ids_do_not_collide_on_a_shared_prefix() {
        let a = stable_import_id("/x/sweet_potato_5.csv");
        let b = stable_import_id("/x/sweet_potato_6.csv");
        assert_ne!(a, b);
        assert_eq!(a, stable_import_id("/x/sweet_potato_5.csv"));
    }

    #[test]
    fn external_folder_is_the_collection() {
        let p = PathBuf::from("/home/me/Downloads/coffee/run1.csv");
        let c = classify(&p, &root());
        assert_eq!(c.collection_id, "imported");
        assert_eq!(c.collection_name, "Coffee");
        assert_eq!(c.substance, "coffee");
    }
}
