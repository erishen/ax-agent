//! AX tree dump and path-addressed read/write commands with
//! relocate-on-stale-path retry.

use crate::ax_act::{self, HitElement, TracedPoint};
use crate::ax_core::{self, AxNode};

use super::u32_path;

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


/// Convert the frontend path and run `f` through [`with_relocate`] — the
/// shared skeleton of the five path-addressed commands that support
/// relocation (`ax_perform_action` / `ax_set_value` / `ax_set_position` /
/// `ax_resize_window` / `ax_focus_element`).
fn with_path_relocate<F>(
    pid: i32,
    path: Vec<u32>,
    hint: &Option<RelocateHint>,
    f: F,
) -> Result<(), String>
where
    F: Fn(&[usize]) -> Result<(), String>,
{
    let path = u32_path(&path);
    with_relocate(pid, &path, hint, f)
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
    with_path_relocate(pid, path, &relocate, |fresh| {
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
    with_path_relocate(pid, path, &relocate, |fresh| {
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
    with_path_relocate(pid, path, &relocate, |fresh| {
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
    with_path_relocate(pid, path, &relocate, |fresh| {
        ax_act::resize_window_for_path(pid, fresh, w, h)
    })
}

/// Move the app's first window via `AXPosition` — pid-level fallback that
/// needs no outline path (self-drawn UIs / freshly launched apps).
///
/// # Errors
/// Untrusted process, no window, or AXPosition unsupported.
#[tauri::command(async)]
pub fn ax_move_window(pid: i32, x: f64, y: f64) -> Result<(), String> {
    ax_act::move_window_for_pid(pid, x, y)
}

/// Resize the app's first window via `AXSize` — pid-level fallback that
/// needs no outline path (self-drawn UIs / freshly launched apps).
///
/// # Errors
/// Untrusted process, no window, or the element cannot be resized.
#[tauri::command(async)]
pub fn ax_resize_window_pid(pid: i32, w: f64, h: f64) -> Result<(), String> {
    ax_act::resize_window_for_pid(pid, w, h)
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
    with_path_relocate(pid, path, &relocate, |fresh| {
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
    let path = u32_path(&path);
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
