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
    // App names are short; a long argument means the caller pasted the whole
    // task sentence in. Fail with guidance (defense in depth — the TS tool
    // layer already guards, but RPC/other callers bypass it).
    let len = needle.chars().count();
    if len > 24 {
        return Err(format!(
            "app 参数疑似包含任务描述（{len} 字符，应 ≤24）：只填应用名称（如「网易云音乐」「TextEdit」），不要粘贴任务说明"
        ));
    }

    // Already running? Re-activate (and unhide) it. Match by bundle id first
    // (locale-proof: TextEdit runs as 文本编辑 on a zh-CN system, so a name
    // needle "textedit" only matches on English-locale machines).
    let installed = find_installed(&needle);
    let running = if let Some(hit) = &installed {
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
    if let Some(hit) = &installed {
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

    // Poll accepting pid via the main-binary path probe (primary — works the
    // moment the process forks; `open` registers with LaunchServices
    // asynchronously and `runningApplications` can serve a stale snapshot
    // from before registration in non-runloop contexts), then bundle id,
    // then name forms. Cold launches can take 10s+ to show a window (QQLive,
    // Electron apps) — poll ~15s before giving up.
    for _ in 0..100 {
        std::thread::sleep(std::time::Duration::from_millis(150));
        if let Some(hit) = &installed {
            if let Some(info) = find_running_by_main_binary(hit) {
                return Ok(info);
            }
        }
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
    let bundle = alias_bundle(needle)?;
    apps.into_iter().find(|a| name_matches(a, &bundle))
}

fn name_matches(a: &crate::ax_core::InstalledApp, needle: &str) -> bool {
    a.name.to_lowercase() == needle
        || a.bundle_name.to_lowercase() == needle
        || a.bundle_id.to_lowercase() == needle
}

/// Marketing-name aliases for apps whose macOS name/bundle differs from what
/// users call them (Tencent Video ships as QQLive.app; NetEase CloudMusic
/// ships as NeteaseMusic.app with NO CFBundleDisplayName, so the installed-
/// apps scan reports the English bundle name and `open -a 网易云音乐` fails).
/// Key is the Chinese phrase, value is the lowercased bundle name it
/// resolves to.
const CONSUMER_ALIASES: &[(&str, &str)] = &[
    ("腾讯视频", "qqlive"),
    ("网易云音乐", "neteasemusic"),
    ("网易云", "neteasemusic"),
];

/// Map a Chinese marketing name to the canonical bundle name.
///
/// Strict match only: `needle` arrives trimmed + lowercased from
/// `open_application`. A prefix match (`needle.starts_with(zh)`) used to let a
/// long task sentence like "网易云音乐。网易云音乐是自绘 UI..." slip through
/// and open the app — silently hiding a wrong tool-call argument from the
/// agent. Fail loudly instead so the agent sees "找不到应用" and retries with a
/// clean name.
fn alias_bundle(needle: &str) -> Option<String> {
    CONSUMER_ALIASES
        .iter()
        .find(|(zh, _)| needle == *zh)
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

/// Fallback process-table probe for apps `runningApplications` has not
/// surfaced yet. `open` registers the pid with LaunchServices asynchronously;
/// in non-runloop contexts (Rust tests, off-main-thread callers) the
/// NSWorkspace snapshot can stay stale for many seconds even though the
/// process forked immediately. Matching the exact main binary path is
/// registration-independent and anchors to the end so helper processes
/// ("NeteaseMusic Helper", ...) never match.
fn find_running_by_main_binary(app: &crate::ax_core::InstalledApp) -> Option<AxAppInfo> {
    let exe = format!(
        "{}/Contents/MacOS/{}",
        app.path.trim_end_matches('/'),
        app.bundle_name
    );
    let out = std::process::Command::new("pgrep")
        .args(["-f", &format!("{exe}$")])
        .output()
        .ok()?;
    if !out.status.success() {
        return None; // pgrep exit 1 = no match
    }
    let pid = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()?
        .trim()
        .parse::<i32>()
        .ok()?;
    Some(AxAppInfo {
        pid,
        name: app.bundle_name.clone(),
        bundle_id: app.bundle_id.clone(),
        is_active: false,
        is_hidden: false,
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consumer_aliases_resolve_chinese_marketing_names() {
        assert_eq!(alias_bundle("腾讯视频").as_deref(), Some("qqlive"));
        assert_eq!(alias_bundle("网易云音乐").as_deref(), Some("neteasemusic"));
        assert_eq!(alias_bundle("网易云").as_deref(), Some("neteasemusic"));
        // exact match only: a long task sentence must NOT resolve (it would hide
        // a wrong open_app argument from the agent)
        assert_eq!(alias_bundle("网易云音乐。网易云音乐是自绘 UI..."), None);
        // unknown phrases resolve to nothing (caller falls back to open -a)
        assert_eq!(alias_bundle("微信"), None);
        assert_eq!(alias_bundle(""), None);
    }

    #[test]
    fn long_app_arguments_are_rejected_before_any_launch() {
        let long = "网易云音乐。网易云音乐是自绘 UI（AX 树基本为空），全程以 ocr + click_at 为主";
        let err = open_application(long).unwrap_err();
        assert!(err.contains("疑似包含任务描述"), "unexpected error: {err}");
        assert!(err.contains("只填应用名称"), "unexpected error: {err}");
    }
}
