//! App launching for chat sessions ("打开 TextEdit").
//!
//! Strategy: if the app is already running we just unhide + activate it via
//! NSWorkspace; otherwise shell out to `open -a <name>` (reliable, handles
//! localized names) and poll `runningApplications` for the new pid.

use objc2_app_kit::{
    NSApplicationActivationOptions, NSApplicationActivationPolicy, NSRunningApplication, NSWorkspace,
};

use crate::ax_core::AxAppInfo;

/// Launch or focus the app matching `target` (localized name or bundle id,
/// case-insensitive). Returns the resolved app info (with a fresh pid).
///
/// # Errors
/// Returns a message when no app matches and cannot be launched.
pub fn open_application(target: &str) -> Result<AxAppInfo, String> {
    let needle = target.trim().to_lowercase();
    if needle.is_empty() {
        return Err("应用名为空".to_string());
    }

    // Already running? Re-activate (and unhide) it. Match by bundle id first
    // (locale-proof: TextEdit runs as 文本编辑 on a zh-CN system, so a name
    // needle "textedit" only matches on English-locale machines).
    let running = if let Some(hit) = find_installed(&needle) {
        find_running_by_bundle(&hit.bundle_id)
    } else {
        find_running_by_name(&needle)
    };
    if let Some(info) = running {
        if let Some(activated) = activate(info.pid) {
            // The app is up, but its window may be gone (QQLive closes its
            // window without quitting; activate alone does not restore it).
            // `open` on a running app delivers an App reopen event, which
            // Electron/macOS apps answer by re-showing the main window.
            // Prefer bundle id (locale-proof) with the name as fallback.
            if crate::ocr::find_window_cg(activated.pid).is_none() {
                let reopen = if activated.bundle_id.is_empty() {
                    std::process::Command::new("open").arg("-a").arg(&activated.name).status()
                } else {
                    std::process::Command::new("open")
                        .arg("-b")
                        .arg(&activated.bundle_id)
                        .status()
                };
                let _ = reopen;
                // Reopen may take a beat to land; poll briefly so the caller
                // (agent) doesn't OCR a still-hidden window on the next step.
                for _ in 0..20 {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    if crate::ocr::find_window_cg(activated.pid).is_some() {
                        break;
                    }
                }
            }
            return Ok(activated);
        }
        return Ok(info);
    }

    // Not running: resolve `target` against the installed-apps list, then
    // launch by bundle id (`open -b`) — the only locale-proof way: on a
    // machine whose CLI locale is English, `open -a 备忘录` fails, but
    // `open -b com.apple.Notes` always works.
    let mut bundle_id = String::new();
    let mut display = target.trim().to_string();
    if let Some(hit) = find_installed(&needle) {
        bundle_id = hit.bundle_id.clone();
        display = hit.bundle_name.clone();
    }

    let launch = |arg: &str, value: &str| std::process::Command::new("open").arg(arg).arg(value).status();
    let ok = (launch("-b", &bundle_id), !bundle_id.is_empty())
        .0
        .map(|s| s.success())
        .unwrap_or(false)
        || matches!(launch("-a", target.trim()), Ok(s) if s.success())
        || (display != target.trim()
            && matches!(launch("-a", &display), Ok(s) if s.success()));
    if !ok {
        return Err(format!("找不到或无法启动应用「{target}」"));
    }

    // Poll accepting bundle id (primary — locale-proof), then name forms.
    // Cold launches can take 10s+ to show up in runningApplications (QQLive,
    // Electron apps) — poll ~15s before giving up.
    for _ in 0..100 {
        std::thread::sleep(std::time::Duration::from_millis(150));
        if !bundle_id.is_empty() {
            if let Some(info) = find_running_by_bundle(&bundle_id) {
                return Ok(info);
            }
        }
        if let Some(info) = find_running_by_name(&display.to_lowercase()) {
            return Ok(info);
        }
        if let Some(info) = find_running_by_name(&needle) {
            return Ok(info);
        }
    }
    Err(format!("应用「{target}」已启动但未在运行列表中出现"))
}

/// Resolve the target phrase against the installed-apps scan (installed list
/// is cached by `ax_core`; this is a cheap name lookup).
///
/// Matches display / bundle name / bundle id, then falls back to marketing
/// aliases so a Chinese user phrase like「腾讯视频」can open QQLive.app.
fn find_installed(needle: &str) -> Option<crate::ax_core::InstalledApp> {
    let apps = crate::ax_core::list_installed_apps().ok()?;
    if let Some(hit) = apps.iter().find(|a| name_matches(a, needle)) {
        return Some(hit.clone());
    }
    let Some(bundle) = alias_bundle(needle) else {
        return None;
    };
    apps.into_iter().find(|a| name_matches(a, &bundle))
}

fn name_matches(a: &crate::ax_core::InstalledApp, needle: &str) -> bool {
    a.name.to_lowercase() == needle
        || a.bundle_name.to_lowercase() == needle
        || a.bundle_id.to_lowercase() == needle
}

/// Marketing-name aliases for apps whose macOS name/bundle differs from what
/// users call them (Tencent Video ships as QQLive.app). Key is the Chinese
/// phrase, value is the lowercased bundle name it resolves to.
const CONSUMER_ALIASES: &[(&str, &str)] = &[("腾讯视频", "qqlive")];

/// Map a Chinese marketing name to the canonical bundle name.
fn alias_bundle(needle: &str) -> Option<String> {
    CONSUMER_ALIASES
        .iter()
        .find(|(zh, _)| zh.eq_ignore_ascii_case(needle) || needle.starts_with(zh))
        .map(|(_, bundle)| bundle.to_string())
}


/// Search regular GUI apps for one whose localized name matches `needle`.
fn find_running_by_name(needle: &str) -> Option<AxAppInfo> {
    unsafe {
        for app in NSWorkspace::sharedWorkspace().runningApplications() {
            if app.activationPolicy() != NSApplicationActivationPolicy::Regular {
                continue;
            }
            if app.isTerminated() {
                continue;
            }
            let hit = app
                .localizedName()
                .is_some_and(|n| n.to_string().to_lowercase() == needle);
            if hit {
                let pid = app.processIdentifier();
                return Some(app_info(&app, pid));
            }
        }
    }
    None
}

/// Search running apps by bundle identifier — the locale-proof match used
/// whenever the target resolves to an installed app.
fn find_running_by_bundle(bundle_id: &str) -> Option<AxAppInfo> {
    if bundle_id.is_empty() {
        return None;
    }
    unsafe {
        for app in NSWorkspace::sharedWorkspace().runningApplications() {
            if app.activationPolicy() != NSApplicationActivationPolicy::Regular {
                continue;
            }
            if app.isTerminated() {
                continue;
            }
            if app
                .bundleIdentifier()
                .is_some_and(|b| b.to_string() == bundle_id)
            {
                let pid = app.processIdentifier();
                return Some(app_info(&app, pid));
            }
        }
    }
    None
}

/// Bring the app with `pid` to the front. Returns fresh info, or `None` when
/// the app vanished in the meantime.
fn activate(pid: i32) -> Option<AxAppInfo> {
    unsafe {
        for app in NSWorkspace::sharedWorkspace().runningApplications() {
            if app.processIdentifier() != pid {
                continue;
            }
            let _ = app.unhide();
            let _ = app.activateWithOptions(NSApplicationActivationOptions::empty());
            return Some(app_info(&app, pid));
        }
    }
    None
}

/// Copy the fields we expose about a running app.
unsafe fn app_info(app: &NSRunningApplication, pid: i32) -> AxAppInfo {
    AxAppInfo {
        pid,
        name: app
            .localizedName()
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("pid {pid}")),
        bundle_id: app
            .bundleIdentifier()
            .map(|s| s.to_string())
            .unwrap_or_default(),
        is_active: app.isActive(),
        is_hidden: app.isHidden(),
    }
}
