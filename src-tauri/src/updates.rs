//! Release checks.
//!
//! Design constraints: tiny bandwidth, low RAM, no in-place self-update. We
//! fetch the release list once per channel, keep an ETag so a repeat check is a
//! ~300-byte `304 Not Modified`, and enforce the cadence locally. The list
//! endpoint (not `releases/latest`) is deliberate: GitHub's `latest` excludes
//! prereleases, so beta builds would never see a beta update.
//!
//! Nothing is downloaded here. `recommended_url` and the asset list are URLs we
//! open in the user's browser only after they choose to.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Public repository that hosts desktop releases (matches `git remote -v`).
const RELEASES_API: &str =
    "https://api.github.com/repos/OpenSmell/osmograph-desktop/releases?per_page=30";
const CACHE_FILE: &str = "updates.json";
/// A day, in seconds — the minimum gap between successful automatic checks.
const AUTO_INTERVAL_SECS: i64 = 24 * 60 * 60;
/// Failed attempts retry sooner than a day, but not on every focus/launch.
const FAILED_RETRY_SECS: i64 = 15 * 60;
/// Release notes are capped so a runaway changelog cannot bloat the payload,
/// but the cap is generous enough to keep a full release body readable.
const MAX_NOTES_CHARS: usize = 20_000;
const MAX_ASSETS: usize = 12;
const HTTP_TIMEOUT_SECS: u64 = 15;

/// How often the app is allowed to look for a new release.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdatePolicy {
    /// On launch and periodically, at most once per 24h. The default.
    Auto,
    /// Only when the user presses "Check now".
    Manual,
    /// Never contact GitHub.
    Never,
}

impl UpdatePolicy {
    /// Parse the setting the frontend persists. Legacy `daily`/`on-launch`
    /// values map to `Auto`; an unknown or missing value also means `Auto`,
    /// because that is the documented default.
    pub fn parse(value: &str) -> UpdatePolicy {
        match value.trim().to_ascii_lowercase().as_str() {
            "manual" => UpdatePolicy::Manual,
            "never" => UpdatePolicy::Never,
            _ => UpdatePolicy::Auto,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            UpdatePolicy::Auto => "auto",
            UpdatePolicy::Manual => "manual",
            UpdatePolicy::Never => "never",
        }
    }
}

/// Which releases a build is willing to be told about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateChannel {
    /// Published releases without a prerelease tag.
    Stable,
    /// Everything, including `-beta.N` and `-alpha.N` tags.
    Beta,
}

impl UpdateChannel {
    pub fn parse(value: &str) -> Option<UpdateChannel> {
        match value.trim().to_ascii_lowercase().as_str() {
            "stable" => Some(UpdateChannel::Stable),
            "beta" => Some(UpdateChannel::Beta),
            _ => None,
        }
    }

    /// A build carrying a prerelease tag starts on the beta channel; a plain
    /// `x.y.z` build starts on stable. The user can always override this.
    pub fn for_version(version: &str) -> UpdateChannel {
        match semver::Version::parse(normalize(version)) {
            Ok(v) if !v.pre.is_empty() => UpdateChannel::Beta,
            _ => UpdateChannel::Stable,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            UpdateChannel::Stable => "stable",
            UpdateChannel::Beta => "beta",
        }
    }
}

/// `alpha`, `beta`, `rc`, or `release`, derived from the version tag. This is
/// what the UI shows beside the version — never a hand-written label.
pub fn version_stage(version: &str) -> &'static str {
    let Ok(parsed) = semver::Version::parse(normalize(version)) else {
        return "release";
    };
    let pre = parsed.pre.to_string().to_ascii_lowercase();
    if pre.starts_with("alpha") {
        "alpha"
    } else if pre.starts_with("beta") {
        "beta"
    } else if pre.starts_with("rc") {
        "rc"
    } else if pre.is_empty() {
        "release"
    } else {
        "prerelease"
    }
}

/// Pure scheduling decision. `last_checked` is the last successful check;
/// `last_attempt` throttles retries after a failed one. Only `Auto` fires
/// without an explicit user action.
pub fn should_check(
    policy: UpdatePolicy,
    last_checked: Option<i64>,
    last_attempt: Option<i64>,
    now: i64,
) -> bool {
    if policy != UpdatePolicy::Auto {
        return false;
    }
    if let Some(attempt) = last_attempt {
        // A future timestamp (clock skew) must not look overdue either.
        let since_attempt = now.saturating_sub(attempt);
        if since_attempt < FAILED_RETRY_SECS {
            return false;
        }
    }
    match last_checked {
        None => true,
        Some(last) => now.saturating_sub(last) >= AUTO_INTERVAL_SECS,
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

/// One readable block of a release body. `kind` is `fixes`, `features`,
/// `breaking`, `meta`, or `other`; the frontend styles by kind but always
/// displays the maintainer's own words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NoteSection {
    pub kind: String,
    pub title: String,
    pub body: String,
}

fn clean_heading(text: &str) -> String {
    text.trim().trim_end_matches('#').trim().to_string()
}

fn classify_heading(title: &str) -> &'static str {
    let t = title.to_ascii_lowercase();
    if t.contains("breaking") {
        "breaking"
    } else if t.contains("fix") || t.contains("bug") || t.contains("patch") {
        "fixes"
    } else if t.contains("contributor") || t.contains("changelog") || t.contains("thank") {
        "meta"
    } else if t.contains("new")
        || t.contains("feature")
        || t.contains("add")
        || t.contains("change")
        || t.contains("highlight")
        || t.contains("improve")
    {
        "features"
    } else {
        "other"
    }
}

fn looks_like_fix(line: &str) -> bool {
    let t = line.to_ascii_lowercase();
    [
        "fix", "bug", "crash", "regression", "broken", "correct", "resolve", "patch",
        "error", "hang", "freeze", "leak",
    ]
    .iter()
    .any(|word| t.contains(word))
}

fn bullet_text(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    for prefix in ["* ", "- ", "+ "] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return Some(rest.trim().to_string());
        }
    }
    None
}

/// Split a release body into sections. Auto-generated GitHub notes put every
/// change under one `## What's Changed` heading; those bullets are grouped into
/// "What's new" and "Bug fixes" so users can scan them without reading PR
/// titles one by one. Manual headings are preserved as written.
pub fn split_notes(notes: &str) -> Vec<NoteSection> {
    let text = notes.replace("\r\n", "\n").replace('\r', "\n");
    let mut raw: Vec<(String, Vec<String>)> = Vec::new();
    let mut current: Option<String> = None;
    let mut body: Vec<String> = Vec::new();

    let flush = |current: &mut Option<String>, body: &mut Vec<String>, raw: &mut Vec<(String, Vec<String>)>| {
        let text = body.join("\n").trim().to_string();
        if current.is_some() || !text.is_empty() {
            let title = current.take().unwrap_or_else(|| "Release notes".to_string());
            if !text.is_empty() {
                raw.push((title, body.clone()));
            }
        }
        body.clear();
    };

    for line in text.lines() {
        let trimmed = line.trim();
        let heading = trimmed
            .strip_prefix("### ")
            .or_else(|| trimmed.strip_prefix("## "));
        if let Some(heading) = heading {
            flush(&mut current, &mut body, &mut raw);
            current = Some(clean_heading(heading));
        } else if let Some(rest) = trimmed.strip_prefix("**Full Changelog**:") {
            flush(&mut current, &mut body, &mut raw);
            raw.push(("Full changelog".to_string(), vec![rest.trim().to_string()]));
        } else {
            body.push(line.to_string());
        }
    }
    flush(&mut current, &mut body, &mut raw);

    let mut sections: Vec<NoteSection> = Vec::new();
    for (title, lines) in raw {
        let body_text = lines.join("\n").trim().to_string();
        if body_text.is_empty() {
            continue;
        }

        // Only the auto-generated "What's Changed" section is split by bullet.
        // A maintainer's prose keeps its own heading intact.
        if title.eq_ignore_ascii_case("What's Changed") || title.eq_ignore_ascii_case("Whats Changed")
        {
            let bullets: Vec<String> = lines.iter().filter_map(|l| bullet_text(l)).collect();
            let non_bullets = lines.iter().any(|l| !l.trim().is_empty() && bullet_text(l).is_none());
            if !bullets.is_empty() && !non_bullets {
                let (fixes, changes): (Vec<String>, Vec<String>) =
                    bullets.into_iter().partition(|b| looks_like_fix(b));
                if !changes.is_empty() {
                    sections.push(NoteSection {
                        kind: "features".to_string(),
                        title: "What's new".to_string(),
                        body: changes
                            .iter()
                            .map(|b| format!("• {}", b))
                            .collect::<Vec<_>>()
                            .join("\n"),
                    });
                }
                if !fixes.is_empty() {
                    sections.push(NoteSection {
                        kind: "fixes".to_string(),
                        title: "Bug fixes".to_string(),
                        body: fixes
                            .iter()
                            .map(|b| format!("• {}", b))
                            .collect::<Vec<_>>()
                            .join("\n"),
                    });
                }
                continue;
            }
        }

        sections.push(NoteSection {
            kind: classify_heading(&title).to_string(),
            title,
            body: body_text,
        });
    }

    if sections.is_empty() && !text.trim().is_empty() {
        sections.push(NoteSection {
            kind: "other".to_string(),
            title: "Release notes".to_string(),
            body: text.trim().to_string(),
        });
    }
    sections.truncate(10);
    sections
}

// === GitHub metadata ===

#[derive(Deserialize, Clone)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Deserialize, Clone)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct CachedAsset {
    name: String,
    url: String,
    size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct CachedRelease {
    version: String,
    name: String,
    notes: String,
    html_url: String,
    published_at: String,
    prerelease: bool,
    assets: Vec<CachedAsset>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateAsset {
    pub name: String,
    pub url: String,
    pub size: u64,
    pub kind: String,
    pub recommended: bool,
}

/// A single release as the UI needs it. `sections` is empty when the release
/// has no notes; the UI then shows no notes rather than inventing any.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateRelease {
    pub version: String,
    pub name: String,
    pub notes: String,
    pub sections: Vec<NoteSection>,
    pub html_url: String,
    pub published_at: String,
    pub prerelease: bool,
    pub recommended_url: String,
    pub recommended_name: String,
    pub assets: Vec<UpdateAsset>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct ChannelCache {
    etag: Option<String>,
    last_checked_unix: Option<i64>,
    last_attempt_unix: Option<i64>,
    release: Option<CachedRelease>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct UpdateCache {
    #[serde(default)]
    stable: ChannelCache,
    #[serde(default)]
    beta: ChannelCache,
}

impl UpdateCache {
    fn slot(&self, channel: UpdateChannel) -> &ChannelCache {
        match channel {
            UpdateChannel::Stable => &self.stable,
            UpdateChannel::Beta => &self.beta,
        }
    }

    fn slot_mut(&mut self, channel: UpdateChannel) -> &mut ChannelCache {
        match channel {
            UpdateChannel::Stable => &mut self.stable,
            UpdateChannel::Beta => &mut self.beta,
        }
    }
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

fn cached_from(gh: &GhRelease) -> CachedRelease {
    let version = normalize(&gh.tag_name).to_string();
    CachedRelease {
        version: version.clone(),
        name: gh
            .name
            .clone()
            .filter(|n| {
                let trimmed = n.trim();
                !trimmed.is_empty() && normalize(trimmed) != version.as_str()
            })
            .unwrap_or_else(|| format!("Osmograph {}", version)),
        notes: truncate_notes(gh.body.clone().unwrap_or_default()),
        html_url: gh.html_url.clone().unwrap_or_default(),
        published_at: gh.published_at.clone().unwrap_or_default(),
        prerelease: gh.prerelease,
        assets: gh
            .assets
            .iter()
            .map(|a| CachedAsset {
                name: a.name.clone(),
                url: a.browser_download_url.clone(),
                size: a.size,
            })
            .collect(),
    }
}

/// A total, comparable key: valid semver first, then publication date for
/// tags that are not semver. Using a key keeps `max_by_key` consistent even
/// when a repository mixes `v1.2.3` and `nightly` tags.
fn release_key(release: &GhRelease) -> (bool, semver::Version, String) {
    match semver::Version::parse(normalize(&release.tag_name)) {
        Ok(version) => (
            true,
            version,
            release.published_at.clone().unwrap_or_default(),
        ),
        Err(_) => (
            false,
            semver::Version::new(0, 0, 0),
            release.published_at.clone().unwrap_or_default(),
        ),
    }
}

/// Pick the newest release the channel allows.
fn select_release(releases: Vec<GhRelease>, channel: UpdateChannel) -> Option<GhRelease> {
    releases
        .into_iter()
        .filter(|r| !r.draft)
        .filter(|r| channel == UpdateChannel::Beta || !r.prerelease)
        .max_by_key(release_key)
}

fn asset_kind(name: &str) -> &'static str {
    let n = name.to_ascii_lowercase();
    if n.ends_with(".appimage") {
        "appimage"
    } else if n.ends_with(".deb") {
        "deb"
    } else if n.ends_with(".rpm") {
        "rpm"
    } else if n.ends_with(".msi") {
        "msi"
    } else if n.ends_with("setup.exe") || n.ends_with(".exe") {
        "exe"
    } else if n.ends_with(".dmg") {
        "dmg"
    } else if n.ends_with(".app.tar.gz") {
        "app"
    } else if n.ends_with(".tar.gz") {
        "tarball"
    } else if n.ends_with("sha256sums.txt") || n.ends_with(".sig") {
        "checksums"
    } else {
        "other"
    }
}

/// `Some(true)` when the filename names the current architecture, `Some(false)`
/// when it names a different one, and `None` when it names none at all (treated
/// as compatible rather than guessed against).
fn arch_relation(name: &str, arch: &str) -> Option<bool> {
    let n = name.to_ascii_lowercase();
    let has = |tokens: &[&str]| tokens.iter().any(|t| n.contains(t));
    let file_arm = has(&["aarch64", "arm64"]);
    let file_x64 = has(&["x86_64", "x64", "amd64"]);
    if !file_arm && !file_x64 {
        return None;
    }
    if matches!(arch, "aarch64" | "arm64") {
        Some(file_arm)
    } else if matches!(arch, "x86_64" | "x64" | "amd64") {
        Some(file_x64)
    } else {
        None
    }
}

/// Lower is a better fit; `None` means the file is not an installer for this
/// platform. A known architecture mismatch adds 10, so any compatible package
/// outranks an incompatible one with a nicer extension. Kept pure and
/// parameterised so the ranking is testable.
fn asset_rank(os: &str, arch: &str, name: &str) -> Option<u8> {
    let kind = asset_kind(name);
    let mismatch = arch_relation(name, arch) == Some(false);
    let penalty = if mismatch { 10 } else { 0 };
    let arch_match = arch_relation(name, arch) == Some(true);
    match os {
        "windows" => match kind {
            "exe" if name.to_ascii_lowercase().contains("setup") => Some(penalty),
            "exe" => Some(1 + penalty),
            "msi" => Some(2 + penalty),
            _ => None,
        },
        "macos" => match kind {
            "dmg" if arch_match => Some(0),
            "dmg" => Some(1 + penalty),
            "app" if arch_match => Some(2),
            "app" => Some(3 + penalty),
            "tarball" => Some(4 + penalty),
            _ => None,
        },
        _ => match kind {
            "appimage" if arch_match => Some(0),
            "appimage" => Some(1 + penalty),
            "deb" => Some(2 + penalty),
            "rpm" => Some(3 + penalty),
            "tarball" => Some(4 + penalty),
            _ => None,
        },
    }
}

fn build_release(release: &CachedRelease, os: &str, arch: &str) -> UpdateRelease {
    // Keep every installer on the release, not just this platform's, so the
    // "All downloads" list is truthful; rank the current platform first.
    let mut ranked: Vec<(u8, &CachedAsset)> = release
        .assets
        .iter()
        .filter(|a| !a.url.is_empty())
        .filter(|a| !matches!(asset_kind(&a.name), "checksums" | "other"))
        .map(|a| (asset_rank(os, arch, &a.name).unwrap_or(90), a))
        .collect();
    ranked.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.name.cmp(&b.1.name)));

    let recommended = ranked
        .first()
        .filter(|(rank, _)| *rank < 10)
        .map(|(_, a)| *a);
    let assets: Vec<UpdateAsset> = ranked
        .iter()
        .take(MAX_ASSETS)
        .map(|(_, a)| UpdateAsset {
            name: a.name.clone(),
            url: a.url.clone(),
            size: a.size,
            kind: asset_kind(&a.name).to_string(),
            recommended: recommended.is_some_and(|r| r.name == a.name),
        })
        .collect();

    UpdateRelease {
        version: release.version.clone(),
        name: release.name.clone(),
        notes: release.notes.clone(),
        sections: split_notes(&release.notes),
        html_url: release.html_url.clone(),
        published_at: release.published_at.clone(),
        prerelease: release.prerelease,
        recommended_url: recommended
            .map(|a| a.url.clone())
            .unwrap_or_else(|| release.html_url.clone()),
        recommended_name: recommended
            .map(|a| a.name.clone())
            .unwrap_or_else(|| "release page".to_string()),
        assets,
    }
}

/// The typed result handed back to the frontend.
#[derive(Debug, Serialize)]
pub struct UpdateCheck {
    pub available: bool,
    pub current_version: String,
    pub stage: String,
    pub channel: String,
    pub policy: String,
    /// `false` when the policy/interval skipped the network entirely.
    pub checked: bool,
    /// Unix seconds of the last successful check, or `null`.
    pub last_checked: Option<i64>,
    pub latest: Option<UpdateRelease>,
    /// An honest explanation when there is no release to show (no stable
    /// release yet, not checked) — never an invented version.
    pub notice: String,
    /// A failed check still returns the last cached release, with this set.
    pub error: Option<String>,
}

struct FetchFailure {
    message: String,
}

impl FetchFailure {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

enum FetchOutcome {
    Modified {
        etag: Option<String>,
        releases: Vec<GhRelease>,
    },
    NotModified,
}

fn rate_limit_message(reset_unix: Option<i64>, now_unix: i64) -> String {
    match reset_unix {
        Some(reset) if reset > now_unix => {
            let mins = ((reset - now_unix) + 59) / 60;
            format!(
                "GitHub's rate limit was reached. It resets in about {} minute{}.",
                mins,
                if mins == 1 { "" } else { "s" }
            )
        }
        _ => "GitHub's rate limit was reached. Try again in a little while.".to_string(),
    }
}

fn fetch_releases(etag: Option<&str>, now_unix: i64) -> Result<FetchOutcome, FetchFailure> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(HTTP_TIMEOUT_SECS)))
        // Read the status/headers ourselves so a 403 can say "rate limited"
        // instead of looking like a broken connection.
        .http_status_as_error(false)
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

    let response = request
        .call()
        .map_err(|e| FetchFailure::new(format!("Could not reach GitHub ({}).", e)))?;
    let status = response.status().as_u16();
    let etag = response
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    match status {
        200 => {
            let releases: Vec<GhRelease> = response
                .into_body()
                .read_json()
                .map_err(|e| FetchFailure::new(format!("GitHub sent unreadable release data ({}).", e)))?;
            Ok(FetchOutcome::Modified { etag, releases })
        }
        304 => Ok(FetchOutcome::NotModified),
        403 | 429 => {
            let reset = response
                .headers()
                .get("x-ratelimit-reset")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<i64>().ok());
            Err(FetchFailure::new(rate_limit_message(reset, now_unix)))
        }
        404 => Err(FetchFailure::new(
            "GitHub has no release list for this repository.",
        )),
        other => Err(FetchFailure::new(format!(
            "GitHub returned HTTP {}. Try again later.",
            other
        ))),
    }
}

fn notice_for(
    cache: &ChannelCache,
    channel: UpdateChannel,
    current_version: &str,
    checked: bool,
) -> String {
    let Some(latest) = &cache.release else {
        if checked {
            return match channel {
                UpdateChannel::Stable => {
                    "No stable release has been published yet. Switch to the Beta channel for early builds."
                        .to_string()
                }
                UpdateChannel::Beta => "No releases have been published yet.".to_string(),
            };
        }
        return if cache.last_checked_unix.is_some() {
            format!(
                "No {} release has been published yet.",
                channel.as_str()
            )
        } else {
            "Not checked yet.".to_string()
        };
    };

    if is_newer_version(current_version, &latest.version) {
        format!(
            "This build (v{}) is newer than the latest {} release (v{}).",
            normalize(current_version),
            channel.as_str(),
            latest.version
        )
    } else {
        String::new()
    }
}

/// Run a check. `force` (the "Check now" button) bypasses the policy interval
/// but still records the attempt.
pub fn check(
    current_version: &str,
    policy: UpdatePolicy,
    channel: UpdateChannel,
    force: bool,
    now_unix: i64,
) -> UpdateCheck {
    let mut cache = load_cache();
    let mut checked = false;
    let mut error = None;

    {
        let slot = cache.slot_mut(channel);
        if force || should_check(policy, slot.last_checked_unix, slot.last_attempt_unix, now_unix) {
            checked = true;
            slot.last_attempt_unix = Some(now_unix);
            match fetch_releases(slot.etag.as_deref(), now_unix) {
                Ok(FetchOutcome::NotModified) => {
                    slot.last_checked_unix = Some(now_unix);
                }
                Ok(FetchOutcome::Modified { etag, releases }) => {
                    let selected = select_release(releases, channel);
                    slot.etag = etag;
                    slot.release = selected.as_ref().map(cached_from);
                    slot.last_checked_unix = Some(now_unix);
                }
                Err(failure) => {
                    // Keep the last good release; a network failure must not
                    // erase what the user was already told.
                    error = Some(failure.message);
                }
            }
        }
    }
    if checked {
        save_cache(&cache);
    }

    let slot = cache.slot(channel);
    let latest = slot
        .release
        .as_ref()
        .map(|r| build_release(r, std::env::consts::OS, std::env::consts::ARCH));
    let available = latest
        .as_ref()
        .is_some_and(|r| is_newer_version(&r.version, current_version));
    UpdateCheck {
        available,
        current_version: normalize(current_version).to_string(),
        stage: version_stage(current_version).to_string(),
        channel: channel.as_str().to_string(),
        policy: policy.as_str().to_string(),
        checked,
        last_checked: slot.last_checked_unix,
        notice: notice_for(slot, channel, current_version, checked),
        latest,
        error,
    }
}

/// Check for a newer release. Metadata only — never downloads an installer.
#[tauri::command]
pub fn check_for_updates(
    policy: Option<String>,
    channel: Option<String>,
    force: Option<bool>,
) -> Result<UpdateCheck, String> {
    let current = env!("CARGO_PKG_VERSION");
    let policy = UpdatePolicy::parse(policy.as_deref().unwrap_or("auto"));
    let channel = channel
        .as_deref()
        .and_then(UpdateChannel::parse)
        .unwrap_or_else(|| UpdateChannel::for_version(current));
    Ok(check(
        current,
        policy,
        channel,
        force.unwrap_or(false),
        chrono::Utc::now().timestamp(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_is_the_default_and_legacy_values_migrate() {
        assert_eq!(UpdatePolicy::parse("auto"), UpdatePolicy::Auto);
        assert_eq!(UpdatePolicy::parse(""), UpdatePolicy::Auto);
        assert_eq!(UpdatePolicy::parse("daily"), UpdatePolicy::Auto);
        assert_eq!(UpdatePolicy::parse("on-launch"), UpdatePolicy::Auto);
        assert_eq!(UpdatePolicy::parse("manual"), UpdatePolicy::Manual);
        assert_eq!(UpdatePolicy::parse("never"), UpdatePolicy::Never);
        assert_eq!(UpdatePolicy::parse("bogus"), UpdatePolicy::Auto);
    }

    #[test]
    fn policy_round_trips_through_strings() {
        for p in [UpdatePolicy::Auto, UpdatePolicy::Manual, UpdatePolicy::Never] {
            assert_eq!(UpdatePolicy::parse(p.as_str()), p);
        }
    }

    #[test]
    fn only_auto_checks_without_a_press() {
        assert!(!should_check(UpdatePolicy::Never, None, None, 1_000));
        assert!(!should_check(UpdatePolicy::Manual, None, None, 1_000));
        assert!(should_check(UpdatePolicy::Auto, None, None, 1_000));
    }

    #[test]
    fn auto_gates_success_to_a_day() {
        let day = AUTO_INTERVAL_SECS;
        assert!(!should_check(UpdatePolicy::Auto, Some(0), Some(0), day - 1));
        assert!(should_check(UpdatePolicy::Auto, Some(0), Some(0), day));
        assert!(should_check(UpdatePolicy::Auto, Some(0), Some(0), day + 1));
    }

    #[test]
    fn failed_attempts_back_off_fifteen_minutes() {
        let now = 1_000_000;
        // No success yet, but a failed attempt a minute ago: wait.
        assert!(!should_check(
            UpdatePolicy::Auto,
            None,
            Some(now - 60),
            now
        ));
        // Still inside the retry window even if the last success is a day old.
        assert!(!should_check(
            UpdatePolicy::Auto,
            Some(now - AUTO_INTERVAL_SECS),
            Some(now - 60),
            now
        ));
        assert!(should_check(
            UpdatePolicy::Auto,
            Some(now - AUTO_INTERVAL_SECS),
            Some(now - FAILED_RETRY_SECS),
            now
        ));
    }

    #[test]
    fn clock_skew_does_not_trigger_a_check() {
        assert!(!should_check(
            UpdatePolicy::Auto,
            Some(10_000),
            Some(10_000),
            1_000
        ));
    }

    #[test]
    fn version_comparison_includes_prereleases() {
        assert!(is_newer_version("0.2.0", "0.1.0"));
        assert!(is_newer_version("v1.0.0", "0.9.9"));
        assert!(is_newer_version("0.2.0-beta.2", "0.2.0-beta.1"));
        assert!(is_newer_version("0.2.0", "0.2.0-beta.9"));
        assert!(!is_newer_version("0.2.0-beta.1", "0.2.0"));
        assert!(!is_newer_version("v0.1.0", "0.1.0"));
        assert!(is_newer_version("0.10.0", "0.9.0"));
        assert!(is_newer_version("nightly", "0.1.0"));
    }

    #[test]
    fn version_stage_comes_from_the_tag() {
        assert_eq!(version_stage("0.1.2-beta.1"), "beta");
        assert_eq!(version_stage("v0.1.2-alpha.3"), "alpha");
        assert_eq!(version_stage("1.0.0-rc.1"), "rc");
        assert_eq!(version_stage("0.1.2"), "release");
        assert_eq!(version_stage("1.0.0-point.1"), "prerelease");
        assert_eq!(version_stage("dev"), "release");
    }

    #[test]
    fn prerelease_builds_default_to_the_beta_channel() {
        assert_eq!(
            UpdateChannel::for_version("0.1.2-beta.1"),
            UpdateChannel::Beta
        );
        assert_eq!(UpdateChannel::for_version("1.0.0"), UpdateChannel::Stable);
        assert_eq!(UpdateChannel::parse("BETA"), Some(UpdateChannel::Beta));
        assert_eq!(UpdateChannel::parse("nightly"), None);
    }

    #[test]
    fn stable_channel_ignores_prereleases() {
        let gh = |tag: &str, pre: bool, at: &str| GhRelease {
            tag_name: tag.to_string(),
            name: None,
            body: None,
            html_url: None,
            published_at: Some(at.to_string()),
            prerelease: pre,
            draft: false,
            assets: vec![],
        };
        let list = vec![
            gh("v0.2.0-beta.3", true, "2026-03-03T00:00:00Z"),
            gh("v0.1.2", false, "2026-03-02T00:00:00Z"),
            gh("v0.1.1", false, "2026-03-01T00:00:00Z"),
        ];
        assert_eq!(
            select_release(list.clone(), UpdateChannel::Stable)
                .unwrap()
                .tag_name,
            "v0.1.2"
        );
        assert_eq!(
            select_release(list, UpdateChannel::Beta).unwrap().tag_name,
            "v0.2.0-beta.3"
        );
    }

    #[test]
    fn drafts_are_never_offered() {
        let list = vec![GhRelease {
            tag_name: "v9.9.9".to_string(),
            name: None,
            body: None,
            html_url: None,
            published_at: None,
            prerelease: false,
            draft: true,
            assets: vec![],
        }];
        assert!(select_release(list, UpdateChannel::Stable).is_none());
    }

    #[test]
    fn asset_ranking_matches_the_platform() {
        assert_eq!(asset_rank("windows", "x86_64", "Osmograph-setup.exe"), Some(0));
        assert_eq!(asset_rank("windows", "x86_64", "Osmograph-x64-setup.exe"), Some(0));
        assert_eq!(asset_rank("windows", "x86_64", "Osmograph.msi"), Some(2));
        assert_eq!(asset_rank("windows", "x86_64", "Osmograph.deb"), None);
        assert_eq!(asset_rank("linux", "x86_64", "Osmograph.AppImage"), Some(1));
        assert_eq!(
            asset_rank("linux", "x86_64", "Osmograph-linux-x86_64.AppImage"),
            Some(0)
        );
        assert_eq!(asset_rank("linux", "x86_64", "Osmograph-linux-amd64.deb"), Some(2));
        // A mismatched AppImage must lose to a matching .deb.
        assert_eq!(
            asset_rank("linux", "x86_64", "Osmograph-linux-aarch64.AppImage"),
            Some(11)
        );
        assert!(
            asset_rank("linux", "x86_64", "Osmograph-linux-aarch64.AppImage").unwrap()
                > asset_rank("linux", "x86_64", "Osmograph-linux-amd64.deb").unwrap()
        );
        assert_eq!(
            asset_rank("macos", "aarch64", "Osmograph-macos-aarch64.dmg"),
            Some(0)
        );
        assert_eq!(
            asset_rank("macos", "x86_64", "Osmograph-macos-aarch64.dmg"),
            Some(11)
        );
        assert_eq!(
            asset_rank("windows", "aarch64", "Osmograph-x64-setup.exe"),
            Some(10)
        );
        assert_eq!(asset_rank("linux", "x86_64", "SHA256SUMS.txt"), None);
    }

    #[test]
    fn release_payload_marks_one_recommended_asset() {
        let release = CachedRelease {
            version: "0.2.0".to_string(),
            name: "Osmograph 0.2.0".to_string(),
            notes: String::new(),
            html_url: "https://example.test/release".to_string(),
            published_at: "2026-03-02T00:00:00Z".to_string(),
            prerelease: false,
            assets: vec![
                CachedAsset {
                    name: "Osmograph-linux-amd64.deb".to_string(),
                    url: "https://example.test/a.deb".to_string(),
                    size: 10,
                },
                CachedAsset {
                    name: "Osmograph-linux-x86_64.AppImage".to_string(),
                    url: "https://example.test/a.AppImage".to_string(),
                    size: 20,
                },
                CachedAsset {
                    name: "SHA256SUMS.txt".to_string(),
                    url: "https://example.test/sums".to_string(),
                    size: 1,
                },
            ],
        };
        let out = build_release(&release, "linux", "x86_64");
        assert_eq!(out.recommended_name, "Osmograph-linux-x86_64.AppImage");
        assert_eq!(out.recommended_url, "https://example.test/a.AppImage");
        assert_eq!(out.assets.iter().filter(|a| a.recommended).count(), 1);
        assert!(out.assets.iter().all(|a| a.name != "SHA256SUMS.txt"));
    }

    #[test]
    fn other_platforms_are_listed_but_never_recommended() {
        let release = CachedRelease {
            version: "0.2.0".to_string(),
            name: "Osmograph 0.2.0".to_string(),
            notes: String::new(),
            html_url: "https://example.test/release".to_string(),
            published_at: String::new(),
            prerelease: false,
            assets: vec![
                CachedAsset {
                    name: "Osmograph-linux-amd64.deb".to_string(),
                    url: "https://example.test/a.deb".to_string(),
                    size: 10,
                },
                CachedAsset {
                    name: "Osmograph-macos-aarch64.dmg".to_string(),
                    url: "https://example.test/a.dmg".to_string(),
                    size: 20,
                },
                CachedAsset {
                    name: "Osmograph-x64-setup.exe".to_string(),
                    url: "https://example.test/a.exe".to_string(),
                    size: 30,
                },
                CachedAsset {
                    name: "SHA256SUMS.txt".to_string(),
                    url: "https://example.test/sums".to_string(),
                    size: 1,
                },
            ],
        };
        let out = build_release(&release, "linux", "x86_64");
        assert_eq!(out.assets.len(), 3);
        assert_eq!(out.recommended_name, "Osmograph-linux-amd64.deb");
        assert_eq!(
            out.assets
                .iter()
                .filter(|a| a.recommended)
                .map(|a| a.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Osmograph-linux-amd64.deb"]
        );
    }

    #[test]
    fn a_mismatched_only_release_falls_back_to_the_release_page() {
        let release = CachedRelease {
            version: "0.2.0".to_string(),
            name: "Osmograph 0.2.0".to_string(),
            notes: String::new(),
            html_url: "https://example.test/release".to_string(),
            published_at: String::new(),
            prerelease: false,
            assets: vec![CachedAsset {
                name: "Osmograph-linux-aarch64.AppImage".to_string(),
                url: "https://example.test/a.AppImage".to_string(),
                size: 10,
            }],
        };
        let out = build_release(&release, "linux", "x86_64");
        assert_eq!(out.recommended_url, "https://example.test/release");
        assert_eq!(out.recommended_name, "release page");
        assert_eq!(out.assets.len(), 1);
        assert!(!out.assets[0].recommended);
    }

    #[test]
    fn recommendation_falls_back_to_the_release_page() {
        let release = CachedRelease {
            version: "0.2.0".to_string(),
            name: "Osmograph 0.2.0".to_string(),
            notes: String::new(),
            html_url: "https://example.test/release".to_string(),
            published_at: String::new(),
            prerelease: false,
            assets: vec![],
        };
        let out = build_release(&release, "linux", "x86_64");
        assert_eq!(out.recommended_url, "https://example.test/release");
        assert_eq!(out.recommended_name, "release page");
        assert!(out.assets.is_empty());
    }

    #[test]
    fn auto_notes_are_grouped_into_new_and_fixes() {
        let notes = "## What's Changed\n* Add Vial live harness by @a in #1\n* Fix crash when the rig disconnects by @b in #2\n* Improve plant chart contrast by @c in #3\n\n**Full Changelog**: https://github.com/OpenSmell/osmograph-desktop/compare/v1...v2";
        let sections = split_notes(notes);
        let titles: Vec<&str> = sections.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(titles, vec!["What's new", "Bug fixes", "Full changelog"]);
        assert_eq!(sections[0].kind, "features");
        assert!(sections[0].body.contains("Add Vial live harness"));
        assert!(sections[0].body.contains("Improve plant chart"));
        assert_eq!(sections[1].kind, "fixes");
        assert!(sections[1].body.contains("Fix crash"));
        assert_eq!(sections[2].kind, "meta");
    }

    #[test]
    fn manual_sections_keep_their_own_headings() {
        let notes = "A short intro.\n\n### Breaking changes\nConfig moved.\n\n### Bug Fixes\n- Fixed export\n";
        let sections = split_notes(notes);
        assert_eq!(sections[0].title, "Release notes");
        assert_eq!(sections[0].kind, "other");
        assert_eq!(sections[1].kind, "breaking");
        assert_eq!(sections[2].kind, "fixes");
        assert_eq!(sections[2].body, "- Fixed export");
    }

    #[test]
    fn release_name_falls_back_when_it_only_repeats_the_tag() {
        let gh = GhRelease {
            tag_name: "v0.2.0".to_string(),
            name: Some("v0.2.0".to_string()),
            body: None,
            html_url: None,
            published_at: None,
            prerelease: false,
            draft: false,
            assets: vec![],
        };
        assert_eq!(cached_from(&gh).name, "Osmograph 0.2.0");

        let named = GhRelease {
            name: Some("Faster charts and a quieter pump".to_string()),
            ..gh
        };
        assert_eq!(cached_from(&named).name, "Faster charts and a quieter pump");
    }

    #[test]
    fn empty_notes_produce_no_sections() {
        assert!(split_notes("").is_empty());
        assert!(split_notes("   \n\n").is_empty());
    }

    #[test]
    fn notes_are_truncated() {
        let long = "x".repeat(MAX_NOTES_CHARS + 50);
        let out = truncate_notes(long);
        assert!(out.chars().count() <= MAX_NOTES_CHARS + 1);
        assert!(out.ends_with('…'));
        assert_eq!(truncate_notes("fixed a bug".to_string()), "fixed a bug");
    }

    #[test]
    fn rate_limit_message_uses_the_reset_header() {
        let now = 1_000_000;
        let msg = rate_limit_message(Some(now + 125), now);
        assert!(msg.contains("3 minutes"));
        let msg = rate_limit_message(Some(now + 30), now);
        assert!(msg.contains("1 minute."));
        let msg = rate_limit_message(None, now);
        assert!(msg.contains("Try again"));
    }
}
