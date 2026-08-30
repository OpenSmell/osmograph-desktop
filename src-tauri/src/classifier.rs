//! Classifier model store and training commands.
//!
//! Plugging the `opensmell::training` engine into the desktop:
//!   - `train_classifier` reads library recordings (CSV / `.osmell`), trains a
//!     logistic-regression classifier with LORO evaluation + reliability gates,
//!     and persists the honest model card to `{data_local}/osmograph/classifiers`.
//!   - `list_classifiers` / `delete_classifier` manage the on-disk model store.
//!   - `get_classifier` hands a model to the realtime predictor.
//!
//! Mirrors `train_tab.py` semantics: model saved under the lowercased,
//! space->underscore classifier name (extension `.json` instead of `.pkl`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use opensmell::{
    train_classifier as opensmell_train, ClassifierModel, LabeledRecording, TrainOptions,
    TrainingReport,
};

use crate::data::{csv_parse, osmell_read};
use crate::AppState;

/// `{data_local}/osmograph/classifiers` — the desktop replacement for the
/// Python `Osmograph/classifiers/` directory.
fn classifier_store() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| std::env::temp_dir())
        .join("osmograph")
        .join("classifiers")
}

/// Reference safe-name: lowercase, spaces -> underscores.
fn safe_name(name: &str) -> String {
    name.trim().replace(' ', "_").to_lowercase()
}

pub(crate) fn model_path(name: &str) -> PathBuf {
    classifier_store().join(format!("{}.json", safe_name(name)))
}

/// Transpose `[(channel, values), ...]` into `[timestamp][channel]` rows.
/// Returns `Ok(None)` when the recording has no data.
fn transpose_channels(channels: &[(String, Vec<f64>)]) -> Option<Vec<Vec<f64>>> {
    let n_cols = channels.len();
    let n_rows = channels.first().map(|(_, v)| v.len())?;
    let mut out = vec![Vec::with_capacity(n_cols); n_rows];
    for (_id, values) in channels {
        if values.len() != n_rows {
            continue;
        }
        for (row, &v) in out.iter_mut().zip(values.iter()) {
            row.push(v);
        }
    }
    out.retain(|row| !row.is_empty() || n_cols == 0);
    Some(out)
}

/// Read a recording (CSV or `.osmell`) into per-timestamp channel rows.
fn read_samples(path: &Path) -> Result<Vec<Vec<f64>>, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let channels: Vec<(String, Vec<f64>)> = if ext == "osmell" {
        let b = osmell_read::read_osmell(path)?;
        b.channels
    } else {
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
        csv_parse::parse_session_csv(&text)?.channels
    };
    transpose_channels(&channels).ok_or_else(|| format!("No samples in {}", path.display()))
}

/// Build the labeled training set from library file_ids + per-file labels.
///
/// Falls back to the record's substance when a label is missing; a record whose
/// substance is unknown/empty is skipped. Per-record quality (0-100) is carried
/// through so the quality gate in `TrainOptions.min_quality` can filter it.
fn load_training_set(
    index: &crate::data::SessionIndex,
    file_ids: &[String],
    labels: &[String],
) -> Result<Vec<LabeledRecording>, String> {
    let mut recordings = Vec::new();
    for (i, file_id) in file_ids.iter().enumerate() {
        let rec = index
            .records
            .iter()
            .find(|r| r.file_id == *file_id)
            .ok_or_else(|| format!("No session with file_id \"{}\"", file_id))?;

        let label = labels
            .get(i)
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .or_else(|| {
                let s = rec.substance.trim().to_string();
                if s.is_empty() || s.eq_ignore_ascii_case("unknown") {
                    None
                } else {
                    Some(s)
                }
            });
        let label = match label {
            Some(l) => l,
            None => continue,
        };

        let samples = read_samples(Path::new(&rec.csv_path))?;
        let mut tr = LabeledRecording::new(label, samples);
        tr.quality = Some((rec.quality / 100.0).clamp(0.0, 1.0));
        recordings.push(tr);
    }
    Ok(recordings)
}

#[derive(Serialize, Deserialize)]
pub struct TrainClassifierResult {
    pub report: TrainingReport,
    pub path: String,
}

/// Train a classifier from library recordings and persist the model card.
///
/// `labels[i]` is the class label for `file_ids[i]`. `window_size` is clamped
/// 20..=500 by the engine; `min_quality` (0..=1) gates recordings by their
/// library quality score.
#[tauri::command]
pub fn train_classifier(
    state: State<'_, AppState>,
    file_ids: Vec<String>,
    labels: Vec<String>,
    name: String,
    window_size: usize,
    min_quality: f64,
) -> Result<TrainClassifierResult, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Name your classifier to enable training.".to_string());
    }
    if file_ids.is_empty() {
        return Err("Select at least 2 recordings to train.".to_string());
    }

    let index = state.session_index.lock().map_err(|e| e.to_string())?;
    let recordings = load_training_set(&index, &file_ids, &labels)?;

    // Effective sensor count comes from the data itself (used for the class-cap
    // warning and model metadata); the engine refines it from actual channels.
    let n_sensors = recordings
        .first()
        .map(|r| r.samples.first().map_or(3, |row| row.len().clamp(3, 6)))
        .unwrap_or(3);

    let options = TrainOptions {
        window_size,
        n_sensors,
        min_quality: min_quality.clamp(0.0, 1.0),
        stride: opensmell::TRAIN_STRIDE,
        feature_mode: "framework".to_string(),
        sr: 10.0,
    };

    let report = opensmell_train(&recordings, &name, &options)
        .map_err(|e| e.to_string())?;

    let dir = classifier_store();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = model_path(&name);
    std::fs::write(&path, &report.model_json).map_err(|e| e.to_string())?;

    Ok(TrainClassifierResult {
        report,
        path: path.to_string_lossy().to_string(),
    })
}

/// One entry in the classifier list.
#[derive(Serialize, Deserialize)]
pub struct ClassifierInfo {
    pub name: String,
    pub file_id: String,
    pub path: String,
    pub mtime: f64,
    pub n_classes: usize,
    pub n_sensors: usize,
    pub window_size: usize,
    pub accuracy: f64,
    pub loro_accuracy: f64,
    pub warnings: Vec<String>,
}

/// List persisted classifiers, newest first.
#[tauri::command]
pub fn list_classifiers() -> Result<Vec<ClassifierInfo>, String> {
    let dir = classifier_store();
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "json").unwrap_or(false) {
                if let Ok(model) = std::fs::read_to_string(&path).map_err(|e| e.to_string())
                    .and_then(|s| ClassifierModel::from_json(&s).map_err(|e| e.to_string()))
                {
                    let mtime = std::fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs_f64())
                        .unwrap_or(0.0);
                    out.push(ClassifierInfo {
                        name: model.name.clone(),
                        file_id: safe_name(&model.name),
                        path: path.to_string_lossy().to_string(),
                        mtime,
                        n_classes: model.classes.len(),
                        n_sensors: model.n_sensors,
                        window_size: model.window_size,
                        accuracy: model.model_card.accuracy,
                        loro_accuracy: model.model_card.loro_mean_accuracy,
                        warnings: model.model_card.warnings,
                    });
                }
            }
        }
    }
    out.sort_by(|a, b| b.mtime.partial_cmp(&a.mtime).unwrap());
    Ok(out)
}

/// Delete a persisted classifier by its display name.
#[tauri::command]
pub fn delete_classifier(name: String) -> Result<(), String> {
    let path = model_path(&name);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Fetch a classifier model for the realtime predictor.
#[tauri::command]
pub fn get_classifier(name: String) -> Result<ClassifierModel, String> {
    let path = model_path(&name);
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("No classifier named \"{}\": {}", name, e))?;
    ClassifierModel::from_json(&text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_rows(n: usize, base: f64, amp: f64, channels: usize) -> Vec<Vec<f64>> {
        (0..n)
            .map(|i| {
                let t = i as f64 / 10.0;
                (0..channels)
                    .map(|c| base + amp * (t * 1.0 + c as f64 * 0.7).sin())
                    .collect()
            })
            .collect()
    }

    #[test]
    fn transpose_rotates_correctly() {
        let channels = vec![
            ("VOC".to_string(), vec![1.0, 2.0, 3.0]),
            ("LPG".to_string(), vec![4.0, 5.0, 6.0]),
        ];
        let rows = transpose_channels(&channels).unwrap();
        assert_eq!(rows, vec![vec![1.0, 4.0], vec![2.0, 5.0], vec![3.0, 6.0]]);
    }

    #[test]
    fn safe_name_lowercases_and_swaps_spaces() {
        assert_eq!(safe_name("Kitchen Spices"), "kitchen_spices");
        assert_eq!(safe_name("  Coffee  "), "coffee");
    }

    #[test]
    fn read_samples_parses_timestamped_csv() {
        use std::io::Write;
        let dir = std::env::temp_dir().join("osm_cls_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("20260828_120000_coffee.csv");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"timestamp_ms,VOC,LPG\n0,1000.0,20.0\n100,1050.0,22.0\n200,1100.0,25.0\n")
            .unwrap();
        drop(f);
        let rows = read_samples(&path).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0], vec![1000.0, 20.0]);
        assert_eq!(rows[2], vec![1100.0, 25.0]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn end_to_end_train_and_reload() {
        use std::io::Write;
        use std::time::{SystemTime, UNIX_EPOCH};
        use crate::data::SessionIndex;

        let dir = std::env::temp_dir().join("osm_cls_e2e");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Write four recordings (2 garlic, 2 ginger).
        let mut files = Vec::new();
        for (i, (base, label)) in [(100.0, "garlic"), (120.0, "garlic"), (900.0, "ginger"), (950.0, "ginger")]
            .iter()
            .enumerate()
        {
            let path = dir.join(format!("20260828_12000{i}_{label}.csv"));
            let mut f = std::fs::File::create(&path).unwrap();
            f.write_all(b"timestamp_ms,VOC,LPG,CO\n").unwrap();
            for (k, row) in sample_rows(300, *base, 4.0, 3).iter().enumerate() {
                f.write_all(format!("{},", k * 10).as_bytes()).unwrap();
                let line: Vec<String> = row.iter().map(|v| format!("{:.2}", v)).collect();
                f.write_all(line.join(",").as_bytes()).unwrap();
                f.write_all(b"\n").unwrap();
            }
            drop(f);
            files.push(path);
        }

        let mut index = SessionIndex::default();
        let start = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64();
        for (i, (path, label)) in files.iter().zip(["garlic", "garlic", "ginger", "ginger"]).enumerate() {
            index.records.push(crate::data::SessionRecord {
                file_id: format!("fid{}", i),
                substance: label.to_string(),
                label: "Recorded".to_string(),
                csv_path: path.to_string_lossy().to_string(),
                timestamp: start,
                duration_sec: 30.0,
                sensor_count: 3,
                preset_name: "3-sensor".to_string(),
                notes: String::new(),
                opensmell_result: None,
                quality_report: None,
                quality: 100.0,
            });
        }

        let file_ids: Vec<String> = (0..4).map(|i| format!("fid{}", i)).collect();
        let labels: Vec<String> = ["garlic", "garlic", "ginger", "ginger"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let recs = load_training_set(&index, &file_ids, &labels).unwrap();
        assert_eq!(recs.len(), 4);
        assert_eq!(recs[0].label, "garlic");

        // Persist via the same path the command uses, then reload it.
        let store = dir.join("classifiers");
        std::fs::create_dir_all(&store).unwrap();
        let model_json = opensmell_train(
            &recs,
            "Kitchen",
            &TrainOptions {
                window_size: 100,
                n_sensors: 3,
                min_quality: 0.0,
                stride: 5,
                feature_mode: "framework".to_string(),
                sr: 10.0,
            },
        )
        .unwrap()
        .model_json;
        let path = store.join("kitchen.json");
        std::fs::write(&path, &model_json).unwrap();
        let loaded = ClassifierModel::from_json(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(loaded.n_channels(), 3);
        assert_eq!(loaded.classes, vec!["garlic", "ginger"]);

        // Predict a novel ginger window.
        let win: Vec<Vec<f64>> = sample_rows(100, 950.0, 4.0, 3);
        let (label, conf) = loaded.predict(&win).unwrap();
        assert_eq!(label, "ginger");
        assert!(conf > 0.5);
        let _ = std::fs::remove_dir_all(&dir);
    }
}