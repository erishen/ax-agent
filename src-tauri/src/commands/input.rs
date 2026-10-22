//! Synthetic input commands (mouse / keyboard / scroll) with a
//! bring-frontmost guard before HID events.

use crate::ax_act;

use super::u32_path;

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
    let path = u32_path(&path);
    ax_act::scroll_to_visible_for_path(pid, &path)
}

/// Perform an arbitrary named AX action (`AXIncrement`, `AXDecrement`,
/// `AXPick`, `AXShowMenu`, `AXConfirm`, …) on the element at `path`.
///
/// # Errors
/// Stale path or the element does not implement the action.
#[tauri::command(async)]
pub fn ax_named_action(pid: i32, path: Vec<u32>, action: String) -> Result<(), String> {
    let path = u32_path(&path);
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
/// `pid` (session app) is brought frontmost first; the click then goes
/// through the HID event tap, so hit-testing routes it to the app that owns
/// the point — reliable even for self-drawn UIs that ignore directed events.
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

/// Synthetic mouse/keyboard events all go through the HID event tap (the
/// same pipeline as real input), so the target must own the foreground for
/// the event to land in it. Bringing it forward is best-effort, but unlike
/// the old guard we do NOT silently continue when activation fails: that
/// made clicks land on whatever app was frontmost (23:23 session: Chrome /
/// OpenCode received the Tencent nav clicks, the page never changed, and the
/// model looped on 片库). Failing here lets the model re-open/focus instead.
fn frontmost_guard(pid: Option<i32>) -> Result<(), String> {
    if screen_locked() {
        return Err("屏幕已锁定，无法操作 GUI；请先解锁 Mac 再重试。".to_string());
    }
    let Some(want) = pid else {
        return Ok(());
    };
    match ax_act::frontmost_pid() {
        Some(front) if front == want => return Ok(()),
        None => return Ok(()), // cannot determine → don't block the click
        Some(_) => {}
    }
    activate_pid(want);
    // App activation is asynchronous; poll briefly instead of a single
    // fixed sleep. 10×150ms is enough for a normal window to come forward
    // without making every click feel sluggish when it is already active.
    for _ in 0..10 {
        if ax_act::frontmost_pid() == Some(want) {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
    Err(format!(
        "目标应用 (pid {want}) 未能切到前台；为避免点击落到其它应用，本次输入已取消。请先用 open_app/focus 激活目标应用再重试。"
    ))
}

/// True when the login window owns the foreground (screen locked / at the
/// login screen). Synthetic HID events cannot reach any app in this state,
/// so every click would silently land nowhere; fail with an actionable
/// message instead of letting the model loop.
pub(crate) fn screen_locked() -> bool {
    use objc2_app_kit::NSWorkspace;
    NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .and_then(|app| app.bundleIdentifier())
        .map(|id| id.to_string() == "com.apple.loginwindow")
        .unwrap_or(false)
}

/// Bring the app with `pid` to the front (best-effort, no-op when gone).
///
/// macOS 14 deprecated `ActivateIgnoringOtherApps` and made it a no-op, and
/// `activateWithOptions(empty())` does not pull a background app forward
/// when ax-agent itself is active (23:23 session: Chrome stayed frontmost
/// and every Tencent click landed there). LaunchServices' `open -b` is the
/// remaining API that reliably activates an already-running app from a
/// background process.
fn activate_pid(pid: i32) {
    use objc2_app_kit::{NSApplicationActivationOptions, NSWorkspace};
    for app in NSWorkspace::sharedWorkspace().runningApplications() {
        if app.processIdentifier() != pid {
            continue;
        }
        let _ = app.unhide();
        // Keep the in-process call as a cheap first attempt, then use
        // LaunchServices for the cross-app activation macOS 14 requires.
        let _ = app.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows);
        if let Some(bundle) = app.bundleIdentifier() {
            let _ = std::process::Command::new("open")
                .args(["-b", &bundle.to_string()])
                .status();
        }
        return;
    }
}
