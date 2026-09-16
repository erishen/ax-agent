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
/// same pipeline as real input); aiming at the frontmost app is the natural
/// path for scroll/focus-dependent apps — so we bring the target frontmost
/// when possible, and never block on failure (a backgrounded target simply
/// doesn't receive the event, which the agent verifies via ocr/read_screen).
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
            // The target dropped to the background (e.g. ax-agent took
            // focus). Reactivate it, wait a beat, then re-check. The command
            // wrappers are sync-bodied #[tauri::command(async)], so a real
            // sleep is the only option here; it's once per agent step.
            activate_pid(want);
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
    }
    // Activation failed (target app refuses focus, background-only phase, …).
    // Not fatal: the caller's event goes to HID anyway, so it simply lands on
    // whatever is frontmost — the agent notices via ocr/read_screen.
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
