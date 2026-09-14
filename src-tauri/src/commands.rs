//! Tauri command layer over [`crate::ax_core`].
//!
//! Sync commands run on the main thread (required by NSWorkspace); the heavy
//! tree dump is `async` so cross-process AX reads never block the UI.

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

use crate::ax_act::{self, HitElement, TracedPoint};
use crate::ax_core::{self, AxNode, ExportNode};
use crate::ax_open;

/// Per-category macOS privacy permissions this app relies on.
///
/// - **Accessibility** (`AXIsProcessTrusted`) — semantic AX reads/writes and
///   screen hit-tests.
/// - **Input Monitoring** (`CGPreflightListenEventAccess`) — synthetic
///   *keyboard* events (press_key_combo / type_text_synthetic).
/// - **Post Events** (`CGPreflightPostEventAccess`) — synthetic mouse /
///   scroll events. macOS bundles this under the same Accessibility grant in
///   most versions; still worth surfacing separately.
/// - **Screen Recording** (`CGPreflightScreenCaptureAccess`) — screenshots
///   for the observe loop.
#[derive(Clone, Debug, Serialize)]
pub struct PermissionOverview {
    pub accessibility: bool,
    pub input_monitoring: bool,
    pub post_events: bool,
    pub screen_recording: bool,
}

/// Raw HIServices helpers not exposed by the objc2 crates. Safe to call from
/// any thread; they only query (or request) the system permission gate.
#[allow(unsafe_code)]
mod cg_permission {
    extern "C" {
        /// Query: can this process listen for keyboard events (Input Monitoring)?
        pub fn CGPreflightListenEventAccess() -> bool;
        /// Prompt the user for Input Monitoring access.
        pub fn CGRequestListenEventAccess() -> bool;
        /// Query: can this process post synthetic HID events (mouse/scroll)?
        pub fn CGPreflightPostEventAccess() -> bool;
        /// Query: can this process record the screen?
        pub fn CGPreflightScreenCaptureAccess() -> bool;
        /// Prompt the user for Screen Recording access (macOS 10.15+).
        pub fn CGRequestScreenCaptureAccess() -> bool;
    }
}

/// Snapshot of all four permission categories.
pub(crate) fn permission_overview() -> PermissionOverview {
    PermissionOverview {
        accessibility: ax_core::is_process_trusted(false),
        input_monitoring: unsafe { cg_permission::CGPreflightListenEventAccess() },
        post_events: unsafe { cg_permission::CGPreflightPostEventAccess() },
        screen_recording: unsafe { cg_permission::CGPreflightScreenCaptureAccess() },
    }
}

/// `true` when the current process is a trusted accessibility client.
#[tauri::command]
pub fn ax_permission_status() -> PermissionOverview {
    permission_overview()
}

/// Open System Settings → Privacy & Security → Accessibility if not trusted.
/// The system prompt is asynchronous; the return value is the pre-prompt state.
/// Re-check with [`ax_permission_status`] (or the auto-poll) after ticking the box.
#[tauri::command]
pub fn ax_request_permission() -> PermissionOverview {
    let _ = ax_core::is_process_trusted(true);
    permission_overview()
}

/// Open System Settings → Privacy & Security → Input Monitoring if not
/// granted (synthetic keyboard events need it). Same async pattern.
#[tauri::command]
pub fn ax_request_input_monitoring() -> PermissionOverview {
    request_input_monitoring_gate()
}

/// Open the Screen Recording permission prompt if not granted (screenshots /
/// OCR need it). Same async pattern as the other request commands.
#[tauri::command]
pub fn ax_request_screen_recording() -> PermissionOverview {
    request_screen_recording_gate()
}

/// Gate shared by the startup pass and the `ax_request_screen_recording`
/// command: pops the system Screen Recording dialog.
pub(crate) fn request_screen_recording_gate() -> PermissionOverview {
    let _ = unsafe { cg_permission::CGRequestScreenCaptureAccess() };
    permission_overview()
}

/// Gate shared by the startup pass and `ax_request_input_monitoring`: pops
/// the system Input Monitoring dialog.
pub(crate) fn request_input_monitoring_gate() -> PermissionOverview {
    let _ = unsafe { cg_permission::CGRequestListenEventAccess() };
    permission_overview()
}

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

/// Dump the AX tree of the app with the given pid. Runs on a worker thread so
/// slow cross-process attribute reads never block the UI.
///
/// # Errors
/// Returns a message when accessibility is untrusted or the app is gone.
#[tauri::command(async)]
pub fn ax_tree(pid: i32, depth: Option<u32>) -> Result<AxNode, String> {
    let max_depth = depth.unwrap_or(8).clamp(1, 16) as usize;
    ax_core::build_tree_for_pid(pid, max_depth)
}

/// Optional auto-relocation hint: when an action fails because its child-index
/// path went stale (the UI changed after the tree was dumped), the command
/// re-searches the tree by `role` + `label` and retries once.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct RelocateHint {
    pub role: String,
    pub label: String,
}

/// Run `f` on the element at `path`; on a stale-path failure (message starts
/// with the "路径失效" marker used by the path walkers), re-locate via `hint`
/// and retry once. All other failures pass through untouched.
fn with_relocate<F>(pid: i32, path: &[usize], hint: &Option<RelocateHint>, f: F) -> Result<(), String>
where
    F: Fn(&[usize]) -> Result<(), String>,
{
    match f(path) {
        Ok(()) => Ok(()),
        Err(e) if e.starts_with("路径失效") => {
            let Some(h) = hint else {
                return Err(e);
            };
            let fresh = ax_core::find_path_by_hint(pid, &h.role, &h.label)?;
            f(&fresh).map_err(|e2| {
                format!("路径失效后已按 role/label 重定位并重试，仍失败: {e2}")
            })
        }
        Err(e) => Err(e),
    }
}

/// Perform `action` (e.g. "AXPress") on the element addressed by `path`.
/// The path is the list of child indices from the app root, as captured in
/// the frontend while building the tree.
///
/// When the path is stale and `relocate` carries the element's role/label,
/// the command re-locates the element and retries once.
///
/// # Errors
/// Returns a message when the path is stale (and relocation fails) or the
/// action fails.
#[tauri::command(async)]
pub fn ax_perform_action(
    pid: i32,
    path: Vec<u32>,
    action: String,
    relocate: Option<RelocateHint>,
) -> Result<(), String> {
    let path: Vec<usize> = path.into_iter().map(|p| p as usize).collect();
    with_relocate(pid, &path, &relocate, |fresh| {
        ax_core::perform_action_for_path(pid, fresh, &action)
    })
}

// ---------------------------------------------------------------------------
// Computer-use actuation commands (see ax_act.rs)
// ---------------------------------------------------------------------------

/// Write text into the element's `AXValue` ("type into this field" without
/// synthetic keyboard events).
///
/// When the path is stale and `relocate` carries the element's role/label,
/// the command re-locates the element and retries once.
///
/// # Errors
/// Stale path (and relocation fails) or the element's AXValue is not settable.
#[tauri::command(async)]
pub fn ax_set_value(
    pid: i32,
    path: Vec<u32>,
    text: String,
    relocate: Option<RelocateHint>,
) -> Result<(), String> {
    let path: Vec<usize> = path.into_iter().map(|p| p as usize).collect();
    with_relocate(pid, &path, &relocate, |fresh| {
        ax_act::set_value_for_path(pid, fresh, &text)
    })
}

/// Move an element (typically a window) by setting its `AXPosition`.
///
/// When the path is stale and `relocate` carries the element's role/label,
/// the command re-locates the element and retries once.
///
/// # Errors
/// Stale path (and relocation fails) or AXPosition unsupported.
#[tauri::command(async)]
pub fn ax_set_position(
    pid: i32,
    path: Vec<u32>,
    x: f64,
    y: f64,
    relocate: Option<RelocateHint>,
) -> Result<(), String> {
    let path: Vec<usize> = path.into_iter().map(|p| p as usize).collect();
    with_relocate(pid, &path, &relocate, |fresh| {
        ax_act::set_position_for_path(pid, fresh, x, y)
    })
}

/// Resize the window to `w x h` (points) via `AXSize`.
///
/// When the path is stale and `relocate` carries the element's role/label,
/// the command re-locates the element and retries once.
///
/// # Errors
/// Stale path (and relocation fails) or the element cannot be resized.
#[tauri::command(async)]
pub fn ax_resize_window(
    pid: i32,
    path: Vec<u32>,
    w: f64,
    h: f64,
    relocate: Option<RelocateHint>,
) -> Result<(), String> {
    let path: Vec<usize> = path.into_iter().map(|p| p as usize).collect();
    with_relocate(pid, &path, &relocate, |fresh| {
        ax_act::resize_window_for_path(pid, fresh, w, h)
    })
}

/// Grab keyboard focus for the element (`AXFocused = true`).
///
/// When the path is stale and `relocate` carries the element's role/label,
/// the command re-locates the element and retries once.
///
/// # Errors
/// Stale path (and relocation fails) or the element cannot take focus.
#[tauri::command(async)]
pub fn ax_focus_element(
    pid: i32,
    path: Vec<u32>,
    relocate: Option<RelocateHint>,
) -> Result<(), String> {
    let path: Vec<usize> = path.into_iter().map(|p| p as usize).collect();
    with_relocate(pid, &path, &relocate, |fresh| {
        ax_act::focus_element_for_path(pid, fresh)
    })
}

/// Which UI element is under the given global screen position? (The
/// computer-use hit-test primitive; system-wide, any app.)
///
/// # Errors
/// Untrusted process or no element at that position.
#[tauri::command(async)]
pub fn ax_element_at(x: f32, y: f32) -> Result<HitElement, String> {
    ax_act::element_at_screen_position(x, y)
}

/// Read one display attribute of the element addressed by `path` as a string
/// (AXValue / AXPosition / AXTitle …). `null` when the attribute is
/// unsupported or empty. Powers action post-verification and undo snapshots.
///
/// # Errors
/// Untrusted process or stale path.
#[tauri::command(async)]
pub fn ax_read_attribute(
    pid: i32,
    path: Vec<u32>,
    attr: String,
) -> Result<Option<String>, String> {
    let path: Vec<usize> = path.into_iter().map(|p| p as usize).collect();
    ax_act::read_attribute_for_path(pid, &path, &attr)
}

/// Reverse hit-test: find the element under a screen point, walk its AXParent
/// chain to the owning app root and return the child-index path — "click a
/// point, then take over that element" by (`pid`, `path`).
///
/// # Errors
/// Untrusted process, no element at the position, or an unresolvable AX tree.
#[tauri::command(async)]
pub fn ax_trace_path(x: f32, y: f32) -> Result<TracedPoint, String> {
    ax_act::trace_path_at_screen_position(x, y)
}

/// Full accessibility tree of `pid` as pretty JSON — for snapshots, LLM
/// interface analysis, and diffing before/after an action.
///
/// # Errors
/// Untrusted process or app quit.
#[tauri::command(async)]
pub fn ax_tree_json(pid: i32) -> Result<String, String> {
    let node = ax_core::build_tree_export(pid, 10)?;
    serde_json::to_string_pretty(&node)
        .map_err(|e| format!("JSON 序列化失败: {e}"))
}

/// One app-window screenshot plus its global frame, for the AX↔pixel
/// alignment overlay.
#[derive(Debug, Clone, Serialize)]
pub struct ScreenshotInfo {
    pub pid: i32,
    /// kCGWindowNumber used by `screencapture -l`.
    pub window_id: i64,
    /// Window's global top-left corner in points (matches AXPosition).
    pub position: (f64, f64),
    /// Window size in points (matches AXSize; the image renders at 1 pt = 1 px).
    pub size: (f64, f64),
    /// PNG bytes as a base64 `data:` URL, ready for <img>.
    pub image: String,
}

/// Collect every AXWindow in the tree (depth-first order).
fn collect_windows<'a>(node: &'a ExportNode, out: &mut Vec<&'a ExportNode>) {
    if node.role == "AXWindow" {
        out.push(node);
    }
    for child in &node.children {
        collect_windows(child, out);
    }
}

/// Pick the largest window that has both AXPosition and AXSize — apps expose
/// several AXWindow nodes (QQLive: an extra `Window「Window」` without size),
/// and the first one in tree order is not necessarily the real main window.
fn find_window_node(tree: &ExportNode) -> Option<&ExportNode> {
    let mut windows = Vec::new();
    collect_windows(tree, &mut windows);
    windows
        .into_iter()
        .filter(|w| w.position.is_some() && w.size.is_some())
        .max_by(|a, b| {
            let area = |w: &ExportNode| {
                let s = w.size.unwrap_or((0.0, 0.0));
                s.0 * s.1
            };
            area(a)
                .partial_cmp(&area(b))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
}

/// Minimal base64 (RFC 4648) — avoids pulling a dependency just for this.
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(n & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// Captured window: (png path, CG window number, position, size) in points.
type CapturedWindow = (std::path::PathBuf, i64, (f64, f64), (f64, f64));

/// Capture the app's main window (`screencapture -l`) into a temp PNG.
/// Returns (temp path, window number, window AX position in points, AX size).
///
/// # Errors
/// Untrusted process, no window, missing window number, or screen-recording
/// permission not granted.
fn capture_window_png(
    pid: i32,
) -> Result<CapturedWindow, String> {
    if !ax_core::is_process_trusted(false) {
        return Err("未授予辅助功能权限 (Accessibility permission not granted)".to_string());
    }
    // CGWindowList is the ground truth for window geometry here: AX window
    // nodes of self-drawn UIs (QQLive 这类) return position (0,0), which made
    // OCR coordinates collapse onto the *primary* screen even when the window
    // sits on a secondary display. Fallbacks (other Spaces / AX) are only
    // used when they yield a *real* frame — otherwise we error out instead of
    // emitting misleading coordinates.
    let tree = || ax_core::build_tree_export(pid, 10);
    let (window_id, position, size) = match crate::ocr::find_window_cg(pid) {
        Some(found) => found,
        None => match crate::ocr::find_window_cg_all(pid) {
            // Window on another Space: true bounds still known, screenshot may
            // fail — that will surface as an explicit error, not bad coords.
            Some(found) => found,
            None => {
                let tree = tree()?;
                let win = find_window_node(&tree).ok_or(
                    "找不到该应用在屏幕上的窗口（可能被最小化/隐藏，或已关闭）。先 open_app 重新激活它，若仍失败请用户手动点开它的窗口",
                )?;
                // AX positions of (0,0) are a self-drawn-UI lie: reject them.
                let position = win
                    .position
                    .filter(|(x, y)| *x != 0.0 || *y != 0.0)
                    .ok_or("窗口没有可用位置（AX 与 CGWindowList 都拿不到），无法定位 OCR 坐标")?;
                let size = win
                    .size
                    .filter(|(w, h)| *w > 0.0 && *h > 0.0)
                    .ok_or("窗口没有可用尺寸（AX 与 CGWindowList 都拿不到），无法定位 OCR 坐标")?;
                let path_u: Vec<usize> = win.path.iter().map(|p| *p as usize).collect();
                let window_number = ax_act::read_attribute_for_path(pid, &path_u, "AXWindowNumber")
                    .ok()
                    .and_then(|s| s.and_then(|s| s.trim().parse::<i64>().ok()))
                    .ok_or("窗口号缺失（AX 与 CGWindowList 都拿不到），无法截屏")?;
                (window_number, position, size)
            }
        },
    };

    let out = std::env::temp_dir().join(format!("ax-shot-{pid}.png"));
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .arg("-x")
        .arg("-l")
        .arg(window_id.to_string())
        .arg(&out)
        .status()
        .map_err(|e| format!("screencapture 启动失败: {e}"))?;
    if !status.success() {
        return Err(
            "截图失败：请先在「系统设置 → 隐私与安全性 → 屏幕录制」中允许本应用".to_string(),
        );
    }
    Ok((out, window_id, position, size))
}

/// Capture the app's main window and return the PNG plus its global frame.
///
/// # Errors
/// See [`capture_window_png`].
#[tauri::command(async)]
pub fn ax_screenshot_window(pid: i32) -> Result<ScreenshotInfo, String> {
    let (out, window_id, position, size) = capture_window_png(pid)?;
    let bytes = std::fs::read(&out).map_err(|e| format!("读取截图失败: {e}"))?;
    let _ = std::fs::remove_file(&out);
    let image = format!("data:image/png;base64,{}", base64_encode(&bytes));
    Ok(ScreenshotInfo {
        pid,
        window_id,
        position,
        size,
        image,
    })
}

/// The main on-screen window frame of `pid` in screen points (top-left
/// origin, same space as screen_info / OCR coordinates). Used by the drive
/// mode to park our window on a screen the target does not occupy.
#[derive(Debug, Clone, serde::Serialize)]
pub struct WindowBounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[tauri::command]
pub fn ax_window_bounds(pid: i32) -> Option<WindowBounds> {
    let (_, (x, y), (w, h)) = crate::ocr::find_window_cg(pid)?;
    Some(WindowBounds { x, y, w, h })
}

/// One OCR'd text span mapped to *screen* coordinates (points, top-left
/// origin) — directly usable with click_at / type_keys / element_at.
#[derive(Debug, Clone, serde::Serialize)]
pub struct OcrScreenWord {
    pub text: String,
    pub confidence: f64,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Convert an image-pixel coordinate inside a screenshot to screen points:
/// `origin + pixel * window_points / image_pixels`. This single formula is the
/// Retina-safe bridge between the screenshot PNG and the window's global frame.
fn pixel_to_screen(pixel: f64, image_pixels: f64, window_points: f64, origin: f64) -> f64 {
    origin + pixel * window_points / image_pixels
}

/// Map an OCR bounding box (image pixels) into global screen points.
fn ocr_box_to_screen(
    box_tl: (f64, f64),
    box_wh: (f64, f64),
    window_pos: (f64, f64),
    window_size: (f64, f64),
    image_px: (f64, f64),
) -> (f64, f64, f64, f64) {
    (
        pixel_to_screen(box_tl.0, image_px.0, window_size.0, window_pos.0),
        pixel_to_screen(box_tl.1, image_px.1, window_size.1, window_pos.1),
        box_wh.0 * window_size.0 / image_px.0,
        box_wh.1 * window_size.1 / image_px.1,
    )
}

/// OCR the app's main window and return every text span with its screen
/// coordinates. Purpose-built for self-drawn UIs (自绘 UI) whose AX tree has
/// no readable labels.
///
/// # Errors
/// See [`capture_window_png`]; also Vision failures.
#[tauri::command(async)]
pub fn ax_ocr_window(pid: i32) -> Result<Vec<OcrScreenWord>, String> {
    let (out, _window_id, position, size) = capture_window_png(pid)?;
    let res = crate::ocr::ocr_image(&out).map_err(|e| format!("OCR 失败: {e}"))?;
    let _ = std::fs::remove_file(&out);
    // Map image pixels → window points (handles Retina scale factors).
    let img = (res.width, res.height);
    Ok(res
        .words
        .into_iter()
        .map(|w| {
            let (x, y, ww, hh) = ocr_box_to_screen(
                (w.x, w.y),
                (w.w, w.h),
                position,
                size,
                img,
            );
            OcrScreenWord {
                text: w.text,
                confidence: w.confidence,
                x,
                y,
                w: ww,
                h: hh,
            }
        })
        .collect())
}

/// Result of waiting for a UI change on a pid (AX notifications or timeout).
#[derive(Clone, serde::Serialize)]
pub struct ObserveWaitResult {
    pub changed: bool,
    pub waited_secs: u64,
}

/// Wait up to `timeout` seconds for the app's UI to change, waking early on a
/// real AX notification when possible. Exposed to the agent as the `wait_for`
/// tool so long tasks can synchronize on app launch / list loading instead of
/// blind sleeps. Blocking wait runs on a background thread; `timeout` is
/// clamped to 10 s to bound the call.
#[tauri::command(async)]
pub async fn ax_observe_wait(pid: i32, timeout: u64) -> Result<ObserveWaitResult, String> {
    let timeout = timeout.clamp(0, 10);
    tauri::async_runtime::spawn_blocking(move || {
        let baseline = crate::ax_act::last_trigger_bump();
        // Best-effort fast path: wake early on a real UI notification.
        let _ = crate::ax_act::register_for_pid(pid);
        crate::ax_act::wait_for_change(timeout)
            .map_err(|e| format!("等待失败: {e}"))?;
        let changed =
            !crate::ax_act::observer_dead() && crate::ax_act::has_bumped_since(baseline);
        Ok(ObserveWaitResult {
            changed,
            waited_secs: timeout,
        })
    })
    .await
    .map_err(|e| format!("等待任务异常: {e}"))?
}

#[cfg(test)]
mod ocr_mapping_tests {
    use super::*;

    #[test]
    fn retina_secondary_screen() {
        // 2x Retina window on the secondary display: 1345 pt window == 2690 px image.
        let (x, y, w, h) = ocr_box_to_screen(
            (500.0, 300.0),
            (100.0, 40.0),
            (1941.0, 80.0),
            (1345.0, 760.0),
            (2690.0, 1520.0),
        );
        assert_eq!((x, y, w, h), (2191.0, 230.0, 50.0, 20.0));
    }

    #[test]
    fn unit_scale_primary_screen() {
        // 1x: pixels == points, no scaling.
        let (x, y, w, h) = ocr_box_to_screen(
            (100.0, 50.0),
            (200.0, 30.0),
            (0.0, 0.0),
            (800.0, 600.0),
            (800.0, 600.0),
        );
        assert_eq!((x, y, w, h), (100.0, 50.0, 200.0, 30.0));
    }

    #[test]
    fn pixel_to_screen_matches_formula() {
        assert_eq!(pixel_to_screen(500.0, 2690.0, 1345.0, 1941.0), 2191.0);
        assert_eq!(pixel_to_screen(0.0, 100.0, 50.0, 10.0), 10.0);
    }
}

/// Synthetic scroll-wheel event at a global screen point (points; most apps
/// interpret `lines` as wheel notches; negative = scroll down).
///
/// # Errors
/// Untrusted process or the CG event could not be created.
#[tauri::command(async)]
pub fn ax_scroll(x: f64, y: f64, lines: f64, pid: Option<i32>) -> Result<(), String> {
    frontmost_guard(pid)?;
    ax_act::scroll_at_position(x, y, lines, pid)
}

/// Ask the app to bring the element addressed by `path` into view
/// (`AXScrollToVisible` — semantic, no synthetic events).
///
/// # Errors
/// Stale path or the element does not support `AXScrollToVisible`.
#[tauri::command(async)]
pub fn ax_scroll_to_visible(pid: i32, path: Vec<u32>) -> Result<(), String> {
    let path: Vec<usize> = path.into_iter().map(|p| p as usize).collect();
    ax_act::scroll_to_visible_for_path(pid, &path)
}

/// Perform an arbitrary named AX action (`AXIncrement`, `AXDecrement`,
/// `AXPick`, `AXShowMenu`, `AXConfirm`, …) on the element at `path`.
///
/// # Errors
/// Stale path or the element does not implement the action.
#[tauri::command(async)]
pub fn ax_named_action(pid: i32, path: Vec<u32>, action: String) -> Result<(), String> {
    let path: Vec<usize> = path.into_iter().map(|p| p as usize).collect();
    ax_act::named_action_for_path(pid, &path, &action)
}

/// Press a key or shortcut (synthetic CGEvent keyboard): "enter", "esc",
/// "Cmd+F", "Cmd+Shift+T", "Alt+Left". Goes to the focused element; when `pid`
/// is given the events are posted straight to that application.
///
/// # Errors
/// Untrusted process or an unknown key name.
#[tauri::command(async)]
pub fn ax_key(combo: String, pid: Option<i32>) -> Result<(), String> {
    frontmost_guard(pid)?;
    ax_act::press_key_combo(&combo, pid)
}

/// Type text as per-key synthetic keyboard events (Chinese/emoji included via
/// the Unicode payload). Goes to the focused element — focus the field first;
/// when `pid` is given the events are posted straight to that application.
///
/// # Errors
/// Untrusted process or empty text.
#[tauri::command(async)]
pub fn ax_type_keys(text: String, pid: Option<i32>) -> Result<(), String> {
    frontmost_guard(pid)?;
    ax_act::type_text_synthetic(&text, pid)
}

/// Left single-click at a global screen point (synthetic CGEvent mouse).
/// For widgets with no AX element at all.
///
/// `pid` (session app) targets the events straight at that process via
/// CGEventPostToPid — works even when the app is not frontmost; without it,
/// clicks go to whatever is currently frontmost.
///
/// # Errors
/// Untrusted process, or the CG event failed.
#[tauri::command(async)]
pub fn ax_click(x: f64, y: f64, pid: Option<i32>) -> Result<(), String> {
    frontmost_guard(pid)?;
    ax_act::click_at_position(x, y, pid)
}

/// Left double-click at a global screen point.
///
/// # Errors
/// Untrusted process, or the CG event failed.
#[tauri::command(async)]
pub fn ax_double_click(x: f64, y: f64, pid: Option<i32>) -> Result<(), String> {
    frontmost_guard(pid)?;
    ax_act::double_click_at_position(x, y, pid)
}

/// Drag from one global screen point to another (interpolated path).
///
/// # Errors
/// Untrusted process, invalid steps, or the CG event failed.
#[tauri::command(async)]
pub fn ax_drag(from_x: f64, from_y: f64, to_x: f64, to_y: f64, steps: Option<u32>, pid: Option<i32>) -> Result<(), String> {
    frontmost_guard(pid)?;
    ax_act::drag(from_x, from_y, to_x, to_y, steps.unwrap_or(12), pid)
}

/// Right-click at a global screen point (context menu).
///
/// # Errors
/// Untrusted process, or the CG event failed.
#[tauri::command(async)]
pub fn ax_right_click(x: f64, y: f64, pid: Option<i32>) -> Result<(), String> {
    frontmost_guard(pid)?;
    ax_act::right_click_at_position(x, y, pid)
}

/// Synthetic mouse/keyboard can target the session app directly via
/// `CGEventPostToPid` (no foreground requirement), but aiming at the frontmost
/// app is still the most natural path for scroll/focus-dependent apps — so we
/// bring the target frontmost when possible, and never block on failure (the
/// targeted post below handles the backgrounded case).
fn frontmost_guard(pid: Option<i32>) -> Result<(), String> {
    let Some(want) = pid else {
        return Ok(());
    };
    for round in 0..2 {
        let Some(front) = ax_act::frontmost_pid() else {
            return Ok(()); // cannot determine → don't block the click
        };
        if front == want {
            return Ok(());
        }
        if round == 0 {
            // The target dropped to the background (e.g. ax-explorer took
            // focus). Reactivate it, wait a beat, then re-check. The command
            // wrappers are sync-bodied #[tauri::command(async)], so a real
            // sleep is the only option here; it's once per agent step.
            activate_pid(want);
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
    }
    // Activation failed (target app refuses focus, background-only phase, …).
    // Not fatal: the caller posts events straight to `want` via postToPid.
    Ok(())
}

/// Bring the app with `pid` to the front (best-effort, no-op when gone).
fn activate_pid(pid: i32) {
    use objc2_app_kit::{
        NSApplicationActivationOptions, NSApplicationActivationPolicy, NSWorkspace,
    };
    for app in NSWorkspace::sharedWorkspace().runningApplications() {
        if app.processIdentifier() != pid
            || app.activationPolicy() != NSApplicationActivationPolicy::Regular
        {
            continue;
        }
        let _ = app.unhide();
        let _ = app.activateWithOptions(NSApplicationActivationOptions::empty());
        return;
    }
}

/// Read the menu bar of the app with `pid` (defaults to the frontmost app),
/// addressed by child-index paths so entries can be AXPressed directly.
///
/// # Errors
/// Untrusted process, app gone, or no AXMenuBar.
#[tauri::command(async)]
pub fn ax_menu_bar(pid: Option<i32>, depth: Option<u32>) -> Result<ax_act::MenuEntry, String> {
    let pid = match pid {
        Some(p) => p,
        None => ax_act::frontmost_pid().ok_or_else(|| "没有前台应用".to_string())?,
    };
    let max_depth = depth.unwrap_or(4).clamp(1, 6) as usize;
    ax_act::menu_bar_for_pid(pid, max_depth)
}

// ---------------------------------------------------------------------------
// App launching (for chat sessions: "打开 TextEdit")
// ---------------------------------------------------------------------------

/// Launch (or focus if already running) the app with the given bundle id or
/// name via NSWorkspace. Returns the pid it resolved to.
///
/// Async: cold launches can take 10s+ to register with NSWorkspace (QQLive),
/// so this polls for up to ~15s — never block the UI thread for that.
///
/// # Errors
/// App not found.
#[tauri::command(async)]
pub fn ax_open_app(target: String) -> Result<ax_core::AxAppInfo, String> {
    ax_open::open_application(&target)
}

// ---------------------------------------------------------------------------
// Local desktop tools + local MCP (capabilities tsm-hub doesn't provide)
// ---------------------------------------------------------------------------

/// Catalog of local desktop tools (names match frontend AGENT_TOOLS entries).
#[tauri::command]
pub fn desktop_tool_catalog() -> Vec<crate::desktop_tools::DesktopTool> {
    crate::desktop_tools::desktop_tool_catalog()
}

/// Execute a local desktop tool; args is the model's JSON arguments object.
/// Errors are returned as `error: …` text so the agent can react.
///
/// `screen_info` reads NSScreen which is main-thread-only, in a `(async)`
/// command context it would run on a background thread and fail. So we
/// dispatch that one call to the main thread and await the result; all other
/// tools run right here.
#[tauri::command(async)]
pub async fn desktop_tool_exec(
    app: tauri::AppHandle,
    name: String,
    args: serde_json::Value,
) -> String {
    if name == "screen_info" {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if let Err(e) = app.run_on_main_thread(move || {
            let _ = tx.send(crate::desktop_tools::exec(&name, &args));
        }) {
            return format!("error: 无法调度到主线程: {e}");
        }
        return rx
            .await
            .unwrap_or_else(|e| format!("error: 主线程执行失败: {e}"));
    }
    crate::desktop_tools::exec(&name, &args)
}

/// One MCP tool exposed by a local server (mcp.local.json).
#[derive(Clone, Serialize)]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// List tools across all locally configured MCP servers (mcp.local.json).
#[tauri::command(async)]
pub fn mcp_local_tools() -> Result<Vec<McpToolInfo>, String> {
    Ok(crate::mcp_client::list_tools()
        .unwrap_or_default()
        .into_iter()
        .map(|t| McpToolInfo {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
        })
        .collect())
}

/// Call a local MCP tool, namespaced `{server}.{tool}`.
#[tauri::command(async)]
pub fn mcp_local_call(qualified: String, args: serde_json::Value) -> Result<String, String> {
    crate::mcp_client::call_tool(&qualified, args)
}

// ---------------------------------------------------------------------------
// Permission diagnostics
// ---------------------------------------------------------------------------

/// One process in the ancestor chain of the ax-explorer process.
#[derive(Clone, Serialize)]
pub struct ProcessChainEntry {
    pub pid: u32,
    pub name: String,
}

/// Permission diagnostics for the classic "why is it still untrusted?" case.
///
/// In dev mode the app is `cargo run`-launched from a terminal, so macOS
/// attributes the Accessibility grant to the *responsible* process — the app
/// at the root of the chain (Terminal / iTerm / VS Code), not ax-explorer
/// itself. The gate shows this chain so the user knows exactly which entry to
/// tick in System Settings.
///
/// # Errors
/// Returns a message when /proc-style process data cannot be read (should not
/// happen on macOS).
#[tauri::command(async)]
pub fn ax_permission_diagnostics() -> Result<PermissionDiagnostics, String> {
    let trusted = ax_core::is_process_trusted(false);

    let mut system = System::new();
    let self_pid = std::process::id();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        // Only names + parent pids are needed; skip cmd/cpu/memory details.
        ProcessRefreshKind::nothing(),
    );

    // Walk parent PIDs from our own process up to launchd.
    let mut chain: Vec<ProcessChainEntry> = Vec::new();
    let mut current: Option<Pid> = Some(Pid::from_u32(self_pid));
    let mut guard = 0;
    while let Some(pid) = current {
        guard += 1;
        if guard > 32 {
            break; // cycle safety
        }
        let Some(process) = system.process(pid) else {
            break;
        };
        chain.push(ProcessChainEntry {
            pid: pid.as_u32(),
            name: process.name().to_string_lossy().into_owned(),
        });
        current = process.parent();
    }

    // macOS "responsible process": the app the permission applies to in dev
    // mode — the outermost non-launchd entry of the chain (launchd pid 1).
    let responsible = chain.iter().rev().find(|entry| entry.pid != 1).cloned();

    Ok(PermissionDiagnostics {
        trusted,
        permissions: permission_overview(),
        responsible,
        chain,
    })
}

/// Payload of [`ax_permission_diagnostics`].
#[derive(Serialize)]
pub struct PermissionDiagnostics {
    pub trusted: bool,
    /// Per-category permission status (Accessibility / Input Monitoring / …).
    pub permissions: PermissionOverview,
    /// App the grant applies to in dev mode (outermost non-launchd ancestor).
    pub responsible: Option<ProcessChainEntry>,
    /// Ancestor chain of this process, self first.
    pub chain: Vec<ProcessChainEntry>,
}
