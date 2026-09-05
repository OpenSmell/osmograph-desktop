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
///
/// `running` is persisted and defaults to `false` so that a fresh install (or an
/// upgrade from a state file written before the field existed) does not start
/// counting until the user explicitly presses Start.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BurnInState {
    pub total_hours: f64,
    pub elapsed_seconds: f64,
    pub last_active: f64,
    #[serde(default)]
    pub running: bool,
}

impl Default for BurnInState {
    fn default() -> Self {
        Self {
            total_hours: DEFAULT_BURNIN_HOURS,
            elapsed_seconds: 0.0,
            last_active: now_secs(),
            running: false,
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

/// Advance the elapsed counter by real wall-clock time since `last_active` —
/// but only while the timer is `running`. Called on every status poll so the
/// countdown runs in real time while the app is open. When the timer is not
/// running (never started, or explicitly stopped), the elapsed counter is
/// frozen and `last_active` is refreshed so no time is lost when it resumes.
fn reconcile(mut s: BurnInState) -> BurnInState {
    let now = now_secs();
    let gap = now - s.last_active;
    if s.running && gap > 0.0 {
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
    /// Whether the countdown is currently advancing.
    pub running: bool,
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
            running: s.running,
        }
    }
}

/// Read the current burn-in status (applying wall-clock reconciliation).
pub fn get_status(dir: &std::path::Path) -> Result<BurnInStatus, String> {
    let s = reconcile(load(dir));
    save(dir, &s)?;
    Ok(BurnInStatus::from_state(&s))
}

/// Start/stop the burn-in timer. Acts as a toggle: pressing Start while stopped
/// begins the countdown; pressing it again pauses it. The countdown only ever
/// advances while running (see [`reconcile`]). When (re)starting, an optional
/// `hours` duration is applied so the UI's duration field configures the run —
/// a countdown that ignores the requested duration looks broken.
pub fn start(dir: &std::path::Path, hours: Option<f64>) -> Result<BurnInStatus, String> {
    let mut s = reconcile(load(dir));
    s.running = !s.running;
    if s.running {
        if let Some(h) = hours {
            if h >= 1.0 && h <= 168.0 {
                s.total_hours = h;
            }
        }
        s.last_active = now_secs();
    }
    save(dir, &s)?;
    Ok(BurnInStatus::from_state(&s))
}

/// Reset the timer to a new duration (0 clears elapsed, keeps hours default)
/// and stops it — a reset must not silently resume counting.
pub fn reset(dir: &std::path::Path, hours: Option<f64>) -> Result<BurnInStatus, String> {
    let mut s = load(dir);
    if let Some(h) = hours {
        if h >= 1.0 && h <= 168.0 {
            s.total_hours = h;
        }
    }
    s.elapsed_seconds = 0.0;
    s.running = false;
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

    #[test]
    fn does_not_run_until_started_and_toggles() {
        let dir = std::env::temp_dir().join("osm_burnin_toggle");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // Fresh state: not running.
        let status = get_status(&dir).unwrap();
        assert!(!status.running, "must not auto-run on a fresh install");

        // Start begins counting.
        let status = get_status(&dir).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        let started = start(&dir, None).unwrap();
        assert!(started.running, "start should begin the countdown");

        // Start again toggles it off (a second press pauses).
        let stopped = start(&dir, None).unwrap();
        assert!(!stopped.running, "second press should pause");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn start_applies_requested_hours() {
        let dir = std::env::temp_dir().join("osm_burnin_hours");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        reset(&dir, Some(24.0)).unwrap();

        let started = start(&dir, Some(6.0)).unwrap();
        assert!(started.running);
        assert_eq!(started.total_hours, 6.0);
        // A paused press ignores the duration (still 6h).
        let stopped = start(&dir, Some(12.0)).unwrap();
        assert!(!stopped.running);
        assert_eq!(stopped.total_hours, 6.0);
        // Re-starting applies the new duration.
        let restarted = start(&dir, Some(12.0)).unwrap();
        assert_eq!(restarted.total_hours, 12.0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn elapsed_only_advances_while_running() {
        let dir = std::env::temp_dir().join("osm_burnin_gate");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        reset(&dir, Some(24.0)).unwrap();

        // Not running: a status poll must not advance elapsed.
        let before = get_status(&dir).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        let after = get_status(&dir).unwrap();
        assert!(
            (after.elapsed_seconds - before.elapsed_seconds) < 0.001,
            "elapsed advanced while not running: {} -> {}",
            before.elapsed_seconds,
            after.elapsed_seconds
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
