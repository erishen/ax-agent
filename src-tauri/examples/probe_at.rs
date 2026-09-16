//! Example: positional hit-test — "which UI element is under screen point
//! (x, y)?" via `AXUIElementCopyElementAtPosition` on the system-wide element.
//!
//! This is the primitive a computer-use agent uses to translate a click target
//! (screen coordinates) into an inspectable/actable AX element — regardless of
//! which app owns it.
//!
//! Run (from `src-tauri`):
//!
//! ```text
//! cargo run --example probe_at -- 600 400
//! ```
//!
//! Permissions: same as textedit_demo (Accessibility ticked for the terminal).

use ax_agent_lib::ax_act;

fn main() {
    // Parse args: x y (defaults to 600 400, the middle of a small display).
    let mut args = std::env::args().skip(1);
    let x: f32 = args.next().and_then(|s| s.parse().ok()).unwrap_or(600.0);
    let y: f32 = args.next().and_then(|s| s.parse().ok()).unwrap_or(400.0);

    match ax_act::element_at_screen_position(x, y) {
        Ok(hit) => {
            println!("点 ({x:.0}, {y:.0}) 处的元素:");
            println!("  role        = {}", hit.role);
            if !hit.title.is_empty() {
                println!("  title       = {}", hit.title);
            }
            if !hit.description.is_empty() {
                println!("  description = {}", hit.description);
            }
            println!("  owner pid   = {}", hit.pid);
            println!(
                "\n下一步（agent 视角）：用 ax_tree(pid {}) 找到它，然后可以",
                hit.pid
            );
            println!("  · ax_perform_action  执行 AXPress 等动作");
            println!("  · ax_set_value       写入文本");
            println!("  · ax_focus_element   抢焦点");
        }
        Err(e) => {
            eprintln!("✗ {e}");
            eprintln!("  提示：坐标是全局屏幕坐标（points，左上原点）。先 `screencapture -x /tmp/s.png` 对照取点。");
            std::process::exit(1);
        }
    }
}
