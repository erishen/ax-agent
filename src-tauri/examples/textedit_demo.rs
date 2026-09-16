//! Example: drive **TextEdit** end-to-end with pure semantic AX operations —
//! no synthetic mouse/keyboard events.
//!
//! What it shows (each step maps to a Tauri command the UI exposes):
//!
//! 1. find TextEdit among running apps (`ax_list_apps`)
//! 2. locate its main text area in the AX tree (`ax_tree`)
//! 3. **聚焦** — set `AXFocused = true` on the text area (`ax_focus_element`)
//! 4. **写入** — set `AXValue = "..."` on the text area (`ax_set_value`):
//!    this replaces the *whole* text content of the field, like select-all +
//!    type, but as one atomic AX write
//! 5. move TextEdit's window via `AXPosition` (`ax_set_position`)
//! 6. verify by re-reading `AXValue`/`AXFocused`
//!
//! Run (from `src-tauri`):
//!
//! ```text
//! cargo run --example textedit_demo
//! ```
//!
//! Permissions: launch from a Terminal that is ticked in
//! System Settings → Privacy & Security → Accessibility.

use ax_agent_lib::ax_act;
use ax_agent_lib::ax_core;

/// One node of a minimal in-process AX tree walk (labels only).
fn summarize(node: &ax_core::AxNode) -> String {
    let value = node
        .attributes
        .iter()
        .find(|a| a.name == "AXValue")
        .map(|a| a.value.clone())
        .unwrap_or_default();
    format!(
        "{} [{}] value={:?} focused={}",
        node.label,
        node.role,
        value,
        {
            node.attributes
                .iter()
                .find(|a| a.name == "AXFocused")
                .map(|a| a.value.clone())
                .unwrap_or_default()
        }
    )
}

/// Depth-first search for the first node matching `predicate`.
fn find<'a>(
    node: &'a ax_core::AxNode,
    pred: &impl Fn(&ax_core::AxNode) -> bool,
) -> Option<&'a ax_core::AxNode> {
    if pred(node) {
        return Some(node);
    }
    node.children.iter().find_map(|c| find(c, pred))
}

fn main() {
    if !ax_core::is_process_trusted(false) {
        eprintln!("✗ 未授予辅助功能权限：请先在 系统设置 → 隐私与安全性 → 辅助功能 中勾选启动本示例的终端。");
        std::process::exit(2);
    }

    // 1. Find (or launch) TextEdit.
    let apps = ax_core::list_applications();
    let textedit = apps.iter().find(|a| a.bundle_id == "com.apple.TextEdit");
    let Some(app) = textedit else {
        eprintln!("✗ TextEdit 未运行。请先打开 TextEdit（open -a TextEdit）再运行本示例。");
        std::process::exit(1);
    };
    println!("① 找到 TextEdit: pid {} ({})", app.pid, app.name);

    // 2. Dump its AX tree and locate the main text area (AXTextArea).
    let tree = ax_core::build_tree_for_pid(app.pid, 12).expect("读取 AX 树失败");
    let area = find(&tree, &|n: &ax_core::AxNode| n.role == "AXTextArea")
        .or_else(|| find(&tree, &|n: &ax_core::AxNode| n.role == "AXTextField"))
        .unwrap_or_else(|| {
            eprintln!("✗ 树里没找到文本区域（TextEdit 可能停在了打开面板）。");
            std::process::exit(1);
        });
    println!("② 定位文本区域: {}", summarize(area));

    // Rebuild the child-index path of `area` (the UI addresses elements the
    // same way; AXUIElement handles cannot cross IPC).
    fn path_of(root: &ax_core::AxNode, target: &ax_core::AxNode) -> Option<Vec<usize>> {
        if std::ptr::eq(root, target) {
            return Some(Vec::new());
        }
        for (i, child) in root.children.iter().enumerate() {
            if let Some(mut p) = path_of(child, target) {
                p.insert(0, i);
                return Some(p);
            }
        }
        None
    }
    let path = path_of(&tree, area).expect("内部错误: 路径");

    // 3. 聚焦 — give the text area keyboard focus.
    ax_act::focus_element_for_path(app.pid, &path).expect("聚焦失败");
    println!("③ 已聚焦文本区域 (AXFocused = true)");

    // 4. 写入 — replace the text content via AXValue.
    let demo_text = "Hello from AX Agent!\n这一行是用 AXUIElementSetAttributeValue 写入的。\n";
    ax_act::set_value_for_path(app.pid, &path, demo_text).expect("写入 AXValue 失败");
    println!("④ 已写入 {} 字节文本 (AXValue)", demo_text.len());

    // 5. Move the window (AXPosition on the AXWindow node).
    let window = find(&tree, &|n: &ax_core::AxNode| n.role == "AXWindow");
    if let Some(win) = window {
        if let Some(wpath) = path_of(&tree, win) {
            match ax_act::set_position_for_path(app.pid, &wpath, 120.0, 120.0) {
                Ok(()) => println!("⑤ 已把 TextEdit 窗口移到 (120, 120)"),
                Err(e) => println!("⑤ 窗口移动失败（部分窗口不支持 AXPosition）: {e}"),
            }
        }
    }

    // 6. Verify: re-dump the (small) tree and print the text area state.
    let tree2 = ax_core::build_tree_for_pid(app.pid, 12).expect("二次读取失败");
    if let Some(area2) = find(&tree2, &|n: &ax_core::AxNode| n.role == "AXTextArea") {
        println!("⑥ 验证: {}", summarize(area2));
    }

    println!("完成 ✓ — 切到 TextEdit 看看，文字已经在里面了。");
}
