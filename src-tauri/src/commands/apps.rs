//! Running / installed application enumeration and local example-task config
//! (`apps.local.json`).

use serde::Serialize;

use crate::ax_core;

/// Enumerate regular GUI applications (pid + name + bundle id).
///
/// NSWorkspace must be used from the main thread, which is where Tauri runs
/// sync commands.
#[tauri::command]
pub fn ax_list_apps() -> Vec<ax_core::AxAppInfo> {
    ax_core::list_applications()
}

/// Installed (not necessarily running) applications from the standard app
/// directories — used to generate example tasks.
///
/// # Errors
/// Rarely; standard dirs are always readable.
#[tauri::command]
pub fn ax_installed_apps() -> Result<Vec<ax_core::InstalledApp>, String> {
    ax_core::list_installed_apps()
}

/// Local, machine-specific overrides for example-task generation, read from
/// `apps.local.json` in the project root (gitignored; template:
/// `apps.local.example.json`). Missing file → empty config.
#[derive(Debug, Clone, serde::Deserialize, Serialize, Default)]
pub struct LocalAppsConfig {
    /// Bundles/names that never appear in example tasks.
    #[serde(default)]
    pub hidden: Vec<String>,
    /// Bundles/names forced to the front of example tasks.
    #[serde(default)]
    pub pinned: Vec<String>,
    /// User-authored example tasks (label optional).
    #[serde(default)]
    pub extra_tasks: Vec<LocalTask>,
    /// Cap on how many installed apps feed the template matrix.
    #[serde(default)]
    pub max_apps: Option<usize>,
}

/// A user-defined example task from the local config.
#[derive(Debug, Clone, serde::Deserialize, Serialize)]
pub struct LocalTask {
    #[serde(default)]
    pub label: String,
    pub task: String,
}

/// Two accepted spellings coexist in the wild: the flat form
/// `{"hidden":…,"pinned":…}` this struct has always used, and the nested form
/// `{"apps":{"hidden":…,"pinned":…}}` shipped in the template/example file.
#[derive(serde::Deserialize)]
struct LocalAppsFile {
    /// Flat spelling: captures the top-level `hidden`/`pinned` keys.
    #[serde(default, flatten)]
    flat_top_level: Sidecar,
    /// Nested spelling: `hidden` / `pinned` under the `apps` object.
    #[serde(default)]
    apps: Option<Sidecar>,
    #[serde(default)]
    extra_tasks: Vec<LocalTask>,
    #[serde(default)]
    max_apps: Option<usize>,
}

/// `hidden` / `pinned` as a self-contained group.
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct Sidecar {
    hidden: Vec<String>,
    pinned: Vec<String>,
}

impl From<LocalAppsFile> for LocalAppsConfig {
    fn from(file: LocalAppsFile) -> Self {
        let nested = file.apps.unwrap_or_default();
        // Nested `apps:*` wins; flat spelling is the backward-compatible fallback.
        let hidden = if nested.hidden.is_empty() {
            file.flat_top_level.hidden
        } else {
            nested.hidden
        };
        let pinned = if nested.pinned.is_empty() {
            file.flat_top_level.pinned
        } else {
            nested.pinned
        };
        Self {
            hidden,
            pinned,
            extra_tasks: file.extra_tasks,
            max_apps: file.max_apps,
        }
    }
}

/// Read `apps.local.json` (project root). Missing/unparsable file → default.
#[tauri::command]
pub fn ax_local_apps_config() -> LocalAppsConfig {
    // Dev cwd is src-tauri or the project root; try both, then CARGO_MANIFEST_DIR.
    let candidates = [
        std::path::PathBuf::from("apps.local.json"),
        std::path::PathBuf::from("../apps.local.json"),
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps.local.json"),
    ];
    for p in candidates {
        if let Ok(text) = std::fs::read_to_string(&p) {
            if let Ok(cfg) = serde_json::from_str::<LocalAppsFile>(&text) {
                return cfg.into();
            }
        }
    }
    LocalAppsConfig::default()
}

#[cfg(test)]
mod apps_config_tests {
    use super::*;

    #[test]
    fn parses_nested_apps_form() {
        let cfg: LocalAppsConfig = serde_json::from_str::<LocalAppsFile>(
            r#"{ "apps": {"hidden": ["Siri", "Stocks"], "pinned": ["WeChat", "腾讯视频"]},
                 "extra_tasks": [{"task": "x"}], "max_apps": 40 }"#,
        )
        .unwrap()
        .into();
        assert_eq!(cfg.hidden, ["Siri", "Stocks"]);
        assert_eq!(cfg.pinned, ["WeChat", "腾讯视频"]);
        assert_eq!(cfg.extra_tasks.len(), 1);
        assert_eq!(cfg.max_apps, Some(40));
    }

    #[test]
    fn parses_flat_form_backward_compat() {
        let cfg: LocalAppsConfig = serde_json::from_str::<LocalAppsFile>(
            r#"{ "hidden": ["Tips"], "pinned": ["备忘录"] }"#,
        )
        .unwrap()
        .into();
        assert_eq!(cfg.hidden, ["Tips"]);
        assert_eq!(cfg.pinned, ["备忘录"]);
    }

    #[test]
    fn missing_fields_default() {
        let cfg: LocalAppsConfig = serde_json::from_str::<LocalAppsFile>(r#"{}"#)
            .unwrap()
            .into();
        assert!(cfg.hidden.is_empty());
        assert!(cfg.pinned.is_empty());
        assert!(cfg.extra_tasks.is_empty());
        assert_eq!(cfg.max_apps, None);
    }
}
