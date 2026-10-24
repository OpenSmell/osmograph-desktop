//! Auto-update metadata checks.
//!
//! Constraints: tiny bandwidth, low RAM, no in-place self-update this round.
//! We only ever fetch the small `releases/latest` JSON, and we send
//! `If-None-Match` with a persisted ETag so a repeat check is a ~300-byte
//! `304 Not Modified` — or nothing at all when the policy interval says it is
//! too soon. Unauthenticated GitHub API requests are capped at 60/hour per IP,
//! so the ETag plus the 24h gate keeps us far below that.
//!
//! This never downloads an installer. `download_url` is only opened in the
//! user's browser when they explicitly ask for it.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Public repository that hosts desktop releases (matches `git remote -v`).
const RELEASES_API: &str =
    "https://api.github.com/repos/OpenSmell/osmograph-desktop/releases/latest";
const CACHE_FILE: &str = "updates.json";
/// A day, in seconds — the minimum gap between automatic checks.
const MIN_AUTO_INTERVAL_SECS: i64 = 24 * 60 * 60;
/// Release notes are truncated so a huge changelog never bloats the payload.
const MAX_NOTES_CHARS: usize = 800;
const HTTP_TIMEOUT_SECS: u64 = 15;

/// How often the app is allowed to look for a new release.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdatePolicy {
    /// Never contact GitHub.
    Never,
    /// Only when the user presses "Check now".
    Manual,
    /// On launch, at most once per 24h.
    OnLaunch,
    /// At most once per 24h.
    Daily,
}

impl UpdatePolicy {
    /// Parse the lowercase setting value the frontend persists.
    pub fn parse(value: &str) -> UpdatePolicy {
        match value {
            "manual" => UpdatePolicy::Manual,
            "on-launch" => UpdatePolicy::OnLaunch,
            "daily" => UpdatePolicy::Daily,
            _ => UpdatePolicy::Never,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            UpdatePolicy::Never => "never",
            UpdatePolicy::Manual => "manual",
            UpdatePolicy::OnLaunch => "on-launch",
            UpdatePolicy::Daily => "daily",
        }
    }
}

/// Pure scheduling decision, so it can be unit-tested without a clock or
/// network. `last_check_unix` is `None` until the first successful check.
/// Only `on-launch` and `daily` auto-fire, both gated to one check per 24h;
/// `manual` and `never` never auto-fire (the UI's "Check now" bypasses this
/// with `force`).
pub fn should_check(policy: UpdatePolicy, last_check_unix: Option<i64>, now_unix: i64) -> bool {
    match policy {
        UpdatePolicy::Never | UpdatePolicy::Manual => false,
        UpdatePolicy::OnLaunch | UpdatePolicy::Daily => match last_check_unix {
            None => true,
            Some(last) => now_unix.saturating_sub(last) >= MIN_AUTO_INTERVAL_SECS,
        },
    }
}

fn normalize(tag: &str) -> &str {
    tag.trim().trim_start_matches('v')
}

/// Semantic version comparison, tolerant of tags that aren't valid semver
/// (falls back to a plain inequality so a weird tag still surfaces an update).
pub fn is_newer_version(latest: &str, current: &str) -> bool {
    match (
        semver::Version::parse(normalize(latest)),
        semver::Version::parse(normalize(current)),
    ) {
        (Ok(l), Ok(c)) => l > c,
        _ => normalize(latest) != normalize(current),
    }
}

fn truncate_notes(mut notes: String) -> String {
    if notes.chars().count() > MAX_NOTES_CHARS {
        let cut: String = notes.chars().take(MAX_NOTES_CHARS).collect();
        notes = format!("{}…", cut.trim_end());
    }
    notes
}

/// Everything we remember between checks: the ETag to make the next request
/// conditional, the last-check time to enforce the interval, and the last
/// release metadata so the UI can render without another request.
#[derive(Default, Serialize, Deserialize)]
struct UpdateCache {
    etag: Option<String>,
    last_checked_unix: Option<i64>,
    latest_version: Option<String>,
    release_notes: Option<String>,
    download_url: Option<String>,
    published_at: Option<String>,
}

fn cache_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("Osmograph")
        .join(CACHE_FILE)
}

fn load_cache() -> UpdateCache {
    fs::read_to_string(cache_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_cache(cache: &UpdateCache) {
    let path = cache_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(cache) {
        let _ = fs::write(path, text);
    }
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

/// Prefer a platform installer asset; fall back to the release page so the
/// user always has somewhere to land.
fn pick_download_url(release: &GhRelease) -> String {
    let wanted: &[&str] = if cfg!(target_os = "windows") {
        &[".msi", ".exe"]
    } else if cfg!(target_os = "macos") {
        &[".dmg", ".app.tar.gz", ".tar.gz"]
    } else {
        &[".appimage", ".deb", ".rpm", ".tar.gz"]
    };
    for ext in wanted {
        if let Some(asset) = release
            .assets
            .iter()
            .find(|a| a.name.to_ascii_lowercase().ends_with(ext))
        {
            return asset.browser_download_url.clone();
        }
    }
    release.html_url.clone().unwrap_or_default()
}

/// The typed result handed back to the frontend.
#[derive(Serialize)]
pub struct UpdateCheck {
    pub available: bool,
    pub latest_version: String,
    pub current_version: String,
    pub release_notes: String,
    pub download_url: String,
    pub published_at: String,
    pub policy: String,
    /// Unix seconds of the last successful check, or `null`.
    pub last_checked: Option<i64>,
    /// `false` when the policy/interval skipped the network entirely.
    pub checked: bool,
}

fn result_from_cache(
    cache: &UpdateCache,
    current_version: &str,
    policy: UpdatePolicy,
    checked: bool,
) -> UpdateCheck {
    let latest = cache.latest_version.clone().unwrap_or_default();
    UpdateCheck {
        available: !latest.is_empty() && is_newer_version(&latest, current_version),
        latest_version: latest,
        current_version: current_version.to_string(),
        release_notes: cache.release_notes.clone().unwrap_or_default(),
        download_url: cache.download_url.clone().unwrap_or_default(),
        published_at: cache.published_at.clone().unwrap_or_default(),
        policy: policy.as_str().to_string(),
        last_checked: cache.last_checked_unix,
        checked,
    }
}

enum FetchOutcome {
    Modified {
        etag: Option<String>,
        release: GhRelease,
    },
    NotModified,
}

fn fetch_latest(etag: Option<&str>) -> Result<FetchOutcome, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(HTTP_TIMEOUT_SECS)))
        .build()
        .into();
    let mut request = agent
        .get(RELEASES_API)
        .header("User-Agent", "Osmograph-Desktop")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(tag) = etag {
        request = request.header("If-None-Match", tag);
    }
    match request.call() {
        Ok(response) => {
            let etag = response
                .headers()
                .get("etag")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let release: GhRelease = response
                .into_body()
                .read_json()
                .map_err(|e| format!("Malformed release metadata: {}", e))?;
            Ok(FetchOutcome::Modified { etag, release })
        }
        // GitHub answers a matching ETag with 304 and no body: ~300 bytes.
        Err(ureq::Error::StatusCode(304)) => Ok(FetchOutcome::NotModified),
        Err(e) => Err(format!("Update check failed: {}", e)),
    }
}

/// Run a check. `force` (the "Check now" button) bypasses the policy interval.
pub fn check(
    current_version: &str,
    policy: UpdatePolicy,
    force: bool,
    now_unix: i64,
) -> Result<UpdateCheck, String> {
    let mut cache = load_cache();
    if !force && !should_check(policy, cache.last_checked_unix, now_unix) {
        return Ok(result_from_cache(&cache, current_version, policy, false));
    }

    match fetch_latest(cache.etag.as_deref())? {
        FetchOutcome::NotModified => {}
        FetchOutcome::Modified { etag, release } => {
            cache.etag = etag;
            cache.latest_version = Some(normalize(&release.tag_name).to_string());
            cache.download_url = Some(pick_download_url(&release));
            cache.release_notes = Some(truncate_notes(release.body.unwrap_or_default()));
            cache.published_at = release.published_at;
        }
    }
    cache.last_checked_unix = Some(now_unix);
    save_cache(&cache);
    Ok(result_from_cache(&cache, current_version, policy, true))
}

/// Check for a newer release. Metadata only — never downloads an installer.
#[tauri::command]
pub fn check_for_updates(policy: String, force: bool) -> Result<UpdateCheck, String> {
    let policy = UpdatePolicy::parse(&policy);
    let now = chrono::Utc::now().timestamp();
    check(env!("CARGO_PKG_VERSION"), policy, force, now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_and_manual_never_auto_check() {
        assert!(!should_check(UpdatePolicy::Never, None, 1_000));
        assert!(!should_check(UpdatePolicy::Manual, None, 1_000));
        // ...even long after the last check.
        assert!(!should_check(UpdatePolicy::Never, Some(0), 10_000_000));
        assert!(!should_check(UpdatePolicy::Manual, Some(0), 10_000_000));
    }

    #[test]
    fn on_launch_and_daily_gate_to_24h() {
        let day = MIN_AUTO_INTERVAL_SECS;
        assert!(should_check(UpdatePolicy::OnLaunch, None, 0));
        assert!(should_check(UpdatePolicy::Daily, None, 0));
        assert!(!should_check(UpdatePolicy::OnLaunch, Some(0), day - 1));
        assert!(!should_check(UpdatePolicy::Daily, Some(0), day - 1));
        assert!(should_check(UpdatePolicy::OnLaunch, Some(0), day));
        assert!(should_check(UpdatePolicy::Daily, Some(0), day + 1));
    }

    #[test]
    fn clock_skew_does_not_trigger_a_check() {
        // A stored timestamp in the future must not underflow into "due".
        assert!(!should_check(UpdatePolicy::Daily, Some(10_000), 1_000));
    }

    #[test]
    fn version_comparison_is_semantic() {
        assert!(is_newer_version("0.2.0", "0.1.0"));
        assert!(is_newer_version("v1.0.0", "0.9.9"));
        assert!(is_newer_version("0.1.1", "0.1.0"));
        assert!(!is_newer_version("0.1.0", "0.1.0"));
        assert!(!is_newer_version("v0.1.0", "0.1.0"));
        assert!(!is_newer_version("0.0.9", "0.1.0"));
        // Numeric, not lexical: 0.10 > 0.9.
        assert!(is_newer_version("0.10.0", "0.9.0"));
        // A non-semver tag still surfaces as "different".
        assert!(is_newer_version("nightly", "0.1.0"));
    }

    #[test]
    fn policy_round_trips_through_strings() {
        for p in [
            UpdatePolicy::Never,
            UpdatePolicy::Manual,
            UpdatePolicy::OnLaunch,
            UpdatePolicy::Daily,
        ] {
            assert_eq!(UpdatePolicy::parse(p.as_str()), p);
        }
        assert_eq!(UpdatePolicy::parse("bogus"), UpdatePolicy::Never);
    }

    #[test]
    fn notes_are_truncated() {
        let long = "x".repeat(MAX_NOTES_CHARS + 50);
        let out = truncate_notes(long);
        assert!(out.chars().count() <= MAX_NOTES_CHARS + 1);
        assert!(out.ends_with('…'));
        // Short notes pass through untouched.
        assert_eq!(truncate_notes("fixed a bug".to_string()), "fixed a bug");
    }
}
