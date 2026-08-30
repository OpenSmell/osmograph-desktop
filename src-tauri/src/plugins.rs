//! Plugin discovery parity with the Python `Osmograph/plugins/loader.py`.
//!
//! The Python side scans a plugins directory for `*.py` files, reads declarative
//! `# name:` / `# description:` / `# version:` header lines, and registers each
//! PluginInfo. The desktop mirrors that for both Python plugin scripts and
//! serialized model files (`.pkl`, `.json`), so users can drop a model or script
//! into the plugins folder and have it appear here.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Default plugin directory mirroring `pathlib.Path.home() / ".config" / "Osmograph" / "plugins"`.
pub fn default_plugin_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("Osmograph")
        .join("plugins")
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginInfo {
    pub name: String,
    pub path: String,
    pub description: String,
    pub version: String,
    pub kind: String,
    pub size_bytes: u64,
    pub loaded: bool,
    pub error: String,
}

/// Parse `# name:`, `# description:`, `# version:` header lines from a source file.
fn inspect_script(path: &Path, source: &str) -> (String, String, String) {
    let mut name = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut description = String::new();
    let mut version = String::from("0.1.0");
    for line in source.lines() {
        let t = line.trim_start();
        if let Some(v) = t.strip_prefix("# description:") {
            description = v.trim().to_string();
        } else if let Some(v) = t.strip_prefix("# version:") {
            version = v.trim().to_string();
        } else if let Some(v) = t.strip_prefix("# name:") {
            name = v.trim().to_string();
        }
    }
    (name, description, version)
}

/// Discover serialized models / scripts in the plugin directory.
pub fn discover(dir: &Path) -> Result<Vec<PluginInfo>, String> {
    if !dir.exists() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        return Ok(Vec::new());
    }

    let mut plugins = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .filter_map(|e| e.path().is_file().then(|| e.path()))
        .collect();
    files.sort();

    for path in files {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let fname = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        // Skip internal/hidden files.
        if fname.starts_with('_') || fname.starts_with('.') {
            continue;
        }
        let size_bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let (name, description, version, kind) = match ext.as_str() {
            "py" => {
                let source = fs::read_to_string(&path).unwrap_or_default();
                let (n, d, v) = inspect_script(&path, &source);
                (n, d, v, "python-plugin".to_string())
            }
            "pkl" => (
                fname.replace(".pkl", ""),
                "Serialized scikit-learn model (import from Python side)".to_string(),
                "unknown".to_string(),
                "model-pkl".to_string(),
            ),
            "json" => {
                if let Some((n, d, v)) = inspect_model_json(&path) {
                    (n, d, v, "model-json".to_string())
                } else {
                    (fname.replace(".json", ""), String::new(), String::new(), "config".to_string())
                }
            }
            _ => {
                (fname.clone(), String::new(), String::new(), "file".to_string())
            }
        };
        plugins.push(PluginInfo {
            name,
            path: path.to_string_lossy().to_string(),
            description,
            version,
            kind,
            size_bytes,
            loaded: false,
            error: String::new(),
        });
    }
    Ok(plugins)
}

/// Try to read `name`/`description`/`version` from a JSON model file.
fn inspect_model_json(path: &Path) -> Option<(String, String, String)> {
    let text = fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let name = v
        .get("name")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            path.file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        });
    let description = v
        .get("description")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let version = v
        .get("version")
        .and_then(|x| x.as_str())
        .unwrap_or("model")
        .to_string();
    Some((name, description, version))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_script_metadata() {
        let dir = std::env::temp_dir().join("osm_plugins_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("my_plugin.py"),
            "# name: My Cool Plugin\n# description: Classifies garlic\n# version: 2.1.0\ndef run(x):\n    pass\n",
        )
        .unwrap();
        fs::write(dir.join("ignored.py"), "x = 1\n").unwrap();
        let found = discover(&dir).unwrap();
        let mine = found.iter().find(|p| p.name == "My Cool Plugin").unwrap();
        assert_eq!(mine.description, "Classifies garlic");
        assert_eq!(mine.version, "2.1.0");
        assert_eq!(mine.kind, "python-plugin");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn skips_private_files_and_creates_dir() {
        let dir = std::env::temp_dir().join("osm_plugins_empty");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("_private.py"), "x=1\n").unwrap();
        let found = discover(&dir).unwrap();
        assert!(found.is_empty());
        let missing = std::env::temp_dir().join("osm_plugins_new");
        let _ = fs::remove_dir_all(&missing);
        assert!(discover(&missing).is_ok());
        let _ = fs::remove_dir_all(&missing);
        let _ = fs::remove_dir_all(&dir);
    }
}
