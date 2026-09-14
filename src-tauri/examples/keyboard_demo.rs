//! Example: drive **TextEdit** with the synthetic keyboard primitives —
//! the complement to `textedit_demo` (which used only semantic AX writes).
//!
//! What it shows:
//! 1. find running TextEdit by bundle id (`ax_core::list_applications`)
//! 2. locate the text area in the AX tree and focus it (semantic AX)
//! 3. `type_text_synthetic` — per-key typing with Unicode payload
//!    (Chinese works; fires key-driven reactions, unlike the atomic AXValue
//!    write in textedit_demo)
//! 4. `press_key_combo("Cmd+Up", None)` — caret to document start (no AX action
//!    exists for caret movement)
//! 5. `press_key_combo("Cmd+S", None)` — save via shortcut
//!
//! Run (from `src-tauri`): `cargo run --example keyboard_demo`
//! Requires the Accessibility grant for the launching terminal, and a
//! TextEdit document window to be open first (open -a TextEdit).
use std::thread::sleep;
use std::time::Duration;

use ax_explorer_lib::ax_act;
use ax_explorer_lib::ax_core;

/// Depth-first search for the first text area; returns its child-index path.
fn find_text_area(node: &ax_core::AxNode, path: Vec<usize>) -> Option<(Vec<usize>, String)> {
    if node.role == "AXTextArea" {
        return Some((path, node.label.clone()));
    }
    for (i, child) in node.children.iter().enumerate() {
        let mut p = path.clone();
        p.push(i);
        if let Some(hit) = find_text_area(child, p) {
            return Some(hit);
        }
    }
    None
}

fn main() {
    if !ax_core::is_process_trusted(false) {
        eprintln!("✗ 未授予辅助功能权限：请先在 系统设置 → 隐私与安全性 → 辅助功能 中勾选启动本示例的终端。");
        std::process::exit(2);
    }

    // 1. Find running TextEdit (bundle id is locale-proof: 文本编辑/TextEdit).
    let apps = ax_core::list_applications();
    let Some(app) = apps.iter().find(|a| a.bundle_id == "com.apple.TextEdit") else {
        eprintln!("✗ TextEdit 未运行。请先打开 TextEdit（open -a TextEdit）再运行本示例。");
        std::process::exit(1);
    };
    println!("① 找到 TextEdit: pid {} ({})", app.pid, app.name);

    // 2. Locate + focus the text area (semantic AX).
    let tree = ax_core::build_tree_for_pid(app.pid, 12).expect("读取 AX 树失败");
    let Some((path, label)) = find_text_area(&tree, Vec::new()) else {
        eprintln!("✗ TextEdit 里没有 AXTextArea（新建一个文档窗口后重试）。");
        std::process::exit(1);
    };
    ax_act::focus_element_for_path(app.pid, &path).expect("聚焦文本区失败");
    println!("② 已聚焦文本区域: {label:?}");

    // 3. Per-key synthetic typing — Chinese included via Unicode payload.
    let text = "键盘合成输入测试：逐键输入 + 中文支持 ✓";
    ax_act::type_text_synthetic(text, None).expect("逐键输入失败");
    println!("③ 已逐键输入 {text:?}");
    sleep(Duration::from_millis(400));

    // 4. Cmd+Up: caret to document start — impossible via AX actions.
    ax_act::press_key_combo("Cmd+Up", None).expect("按键失败");
    println!("④ 已按 Cmd+Up（光标移到文档开头）");

    // 5. Cmd+S: save via shortcut.
    ax_act::press_key_combo("Cmd+S", None).expect("按键失败");
    println!("⑤ 已按 Cmd+S（未保存文档会弹保存面板）");

    println!("完成 ✓ — 切到 TextEdit 看看。");
}
