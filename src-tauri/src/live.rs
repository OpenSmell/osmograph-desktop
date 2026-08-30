//! Realtime classification commands.
//!
//! Bridges the `opensmell::live` engine (port of `realtime_classifier.py`) to
//! the desktop: `load_live_classifier` swaps in a trained model from the store,
//! `get_live_classification` polls the rolling-window prediction state, and the
//! OSM ingest path feeds every validated sample into the engine so the frontend
//! can render live probability bars and the locked/unknown state machine.

use tauri::State;

use opensmell::{ClassifierModel, LiveSnapshot};

use crate::classifier::model_path;
use crate::AppState;

/// Load a trained classifier from the model store for live use.
///
/// Resets the engine (buffer + lock/unknown state) exactly like the Python
/// `RealtimeClassifier.load`. Returns the fresh snapshot.
#[tauri::command]
pub fn load_live_classifier(
    state: State<'_, AppState>,
    name: String,
) -> Result<LiveSnapshot, String> {
    let path = model_path(&name);
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("No classifier named \"{}\": {}", name, e))?;
    let model = ClassifierModel::from_json(&text).map_err(|e| e.to_string())?;
    let mut live = state.live_classifier.lock().map_err(|e| e.to_string())?;
    live.load(model, Some(path.to_string_lossy().to_string()));
    Ok(live.snapshot())
}

/// Unload the live classifier (mirrors `RealtimeClassifier.unload`).
#[tauri::command]
pub fn unload_live_classifier(state: State<'_, AppState>) -> Result<LiveSnapshot, String> {
    let mut live = state.live_classifier.lock().map_err(|e| e.to_string())?;
    live.unload();
    Ok(live.snapshot())
}

/// Poll the current live classification state (probabilities + lock/unknown).
#[tauri::command]
pub fn get_live_classification(state: State<'_, AppState>) -> Result<LiveSnapshot, String> {
    let live = state.live_classifier.lock().map_err(|e| e.to_string())?;
    Ok(live.snapshot())
}