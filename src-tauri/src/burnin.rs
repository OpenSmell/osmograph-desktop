//! Burn-in tracker parity with the Python `Osmograph/burnin/tracker.py`.
//!
//! Mirrors the semantics:
//! - state (total_hours, elapsed_seconds, last_active) persists across restarts;
//! - the counter advances by the real wall-clock gap on every status poll, so
//!   the countdown runs in real time while the app is open and catches up after
//!   power loss / a closed app (a large gap simply adds the real elapsed time);
//! - it completes once `elapsed_seconds >= total_hours * 3600`.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const DEFAULT_BURNIN_HOURS: f64 = 24.0;

/// On-disk persistent state, stored as JSON next to the recordings dir.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BurnInState {
    pub total_hours: f64,
    pub elapsed_seconds: f64,
    pub last_active: f64,
}

impl Default for BurnInState {
    fn default() -> Self {
        Self {
            total_hours: DEFAULT_BURNIN_HOURS,
            elapsed_seconds: 0.0,
            last_active: now_secs(),
        }
    }
}

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

fn state_path(dir: &std::path::Path) -> PathBuf {
    dir.join(".burnin.json")
}

fn load(dir: &std::path::Path) -> BurnInState {
    let path = state_path(dir);
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(s) = serde_json::from_str::<BurnInState>(&text) {
            return s;
        }
    }
    BurnInState::default()
}

fn save(dir: &std::path::Path, s: &BurnInState) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    fs::write(state_path(dir), json).map_err(|e| e.to_string())
}

/// Advance the elapsed counter by real wall-clock time since `last_active`.
/// Called on every 1 s poll tick so the countdown runs in real time while the
/// app is open; large gaps (>60 s, i.e. power loss / app restart) are handled
/// by the same path — the elapsed counter simply catches up.
fn reconcile(mut s: BurnInState) -> BurnInState {
    let now = now_secs();
    let gap = now - s.last_active;
    if gap > 0.0 {
        s.elapsed_seconds += gap;
    }
    s.last_active = now;
    s
}

/// Full burn-in status sent to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BurnInStatus {
    pub total_hours: f64,
    pub elapsed_seconds: f64,
    pub remaining_seconds: f64,
    pub remaining_hours: f64,
    pub is_complete: bool,
}

impl BurnInStatus {
    fn from_state(s: &BurnInState) -> Self {
        let total = s.total_hours * 3600.0;
        let remaining = (total - s.elapsed_seconds).max(0.0);
        Self {
            total_hours: s.total_hours,
            elapsed_seconds: s.elapsed_seconds,
            remaining_seconds: remaining,
            remaining_hours: remaining / 3600.0,
            is_complete: s.elapsed_seconds >= total,
        }
    }
}

/// Read the current burn-in status (applying power-loss reconciliation).
pub fn get_status(dir: &std::path::Path) -> Result<BurnInStatus, String> {
    let s = reconcile(load(dir));
    save(dir, &s)?;
    Ok(BurnInStatus::from_state(&s))
}

/// Start/resume the burn-in timer at the configured duration.
pub fn start(dir: &std::path::Path) -> Result<BurnInStatus, String> {
    let mut s = reconcile(load(dir));
    s.last_active = now_secs();
    save(dir, &s)?;
    Ok(BurnInStatus::from_state(&s))
}

/// Reset the timer to a new duration (0 clears elapsed, keeps hours default).
pub fn reset(dir: &std::path::Path, hours: Option<f64>) -> Result<BurnInStatus, String> {
    let mut s = load(dir);
    if let Some(h) = hours {
        if h >= 1.0 && h <= 168.0 {
            s.total_hours = h;
        }
    }
    s.elapsed_seconds = 0.0;
    s.last_active = now_secs();
    save(dir, &s)?;
    Ok(BurnInStatus::from_state(&s))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reset_sets_hours_and_zeroes_elapsed() {
        let dir = std::env::temp_dir().join("osm_burnin_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        reset(&dir, Some(12.0)).unwrap();
        let s = load(&dir);
        assert_eq!(s.total_hours, 12.0);
        assert_eq!(s.elapsed_seconds, 0.0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn persists_across_load() {
        let dir = std::env::temp_dir().join("osm_burnin_persist");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        reset(&dir, Some(24.0)).unwrap();
        let mut s = load(&dir);
        s.elapsed_seconds = 500.0;
        save(&dir, &s).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.elapsed_seconds, 500.0);
        let _ = fs::remove_dir_all(&dir);
    }
}
