//! Tauri command layer over [`crate::ax_core`].
//!
//! Sync commands run on the main thread (required by NSWorkspace); the heavy
//! tree dump is `async` so cross-process AX reads never block the UI.

mod apps;
mod input;
mod misc;
mod permissions;
mod screen;
mod tree;

pub use apps::*;
pub use input::*;
pub use misc::*;
pub use permissions::*;
pub use screen::*;
pub use tree::*;

// Re-exports for the startup pass in lib.rs (pub(crate), not part of the
// generated command surface).
pub(crate) use permissions::{
    permission_overview, request_input_monitoring_gate, request_screen_recording_gate,
};

/// Shared by the tree / screen / input sub-modules: frontend `u32` child-index
/// paths → the `usize` paths the AX walkers use.
fn u32_path(path: &[u32]) -> Vec<usize> {
    path.iter().map(|p| *p as usize).collect()
}
