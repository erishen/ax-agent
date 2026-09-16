//! macOS privacy permission commands: Accessibility / Input Monitoring /
//! Post Events / Screen Recording, plus the raw HIServices gates.

use serde::Serialize;

use crate::ax_core;


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
