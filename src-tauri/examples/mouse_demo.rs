//! Example: synthetic mouse primitives — click, double-click, drag.
//!
//! A safe, visible demo on **TextEdit**: the AX-invisible scrollbar. We drag
//! the window itself (title bar → AX-invisible drag) and scroll-wheel at a
//! point. Everything is reversible; nothing is typed.
//!
//! What it shows:
//! 1. find TextEdit by bundle id, read window position/size from the AX tree
//! 2. `drag` the window by its title bar to a new position (drag primitive)
//! 3. `click_at` + `double_click_at` on a text-area point (single click sets
//!    the caret, double click selects a word — both AX-invisible operations)
//! 4. verify by reading AXPosition from the tree after the drag
//!
//! Run (from `src-tauri`, from a terminal holding the Accessibility grant):
//!   cargo run --example mouse_demo
use std::thread::sleep;
use std::time::Duration;

use ax_explorer_lib::ax_act;
use ax_explorer_lib::ax_core::{self, AxNode};

/// Find the first window node and its (position, size) from attributes.
fn find_window(node: &AxNode) -> Option<((f64, f64), (f64, f64))> {
    if node.role == "AXWindow" {
        let pos = node
            .attributes
            .iter()
            .find(|a| a.name == "AXPosition")
            .map(|a| a.value.clone())
            .unwrap_or_default();
        let size = node
            .attributes
            .iter()
            .find(|a| a.name == "AXSize")
            .map(|a| a.value.clone())
            .unwrap_or_default();
        // "{x: 120, y: 120}" / "{w: 600, h: 400}"
        let parse = |s: &str| -> Vec<f64> {
            s.split(|c: char| !c.is_ascii_digit() && c != '.' && c != '-')
                .filter(|t| !t.is_empty())
                .filter_map(|t| t.parse().ok())
                .collect()
        };
        let p = parse(&pos);
        let s = parse(&size);
        if p.len() == 2 && s.len() == 2 {
            return Some(((p[0], p[1]), (s[0], s[1])));
        }
    }
    node.children.iter().find_map(find_window)
}

fn main() {
    if !ax_core::is_process_trusted(false) {
        eprintln!("✗ 未授予辅助功能权限：请从已获权限的终端运行。");
        std::process::exit(2);
    }

    // 1. Find TextEdit and its window geometry.
    let apps = ax_core::list_applications();
    let Some(app) = apps.iter().find(|a| a.bundle_id == "com.apple.TextEdit") else {
        eprintln!("✗ TextEdit 未运行。请先打开 TextEdit（open -a TextEdit）。");
        std::process::exit(1);
    };
    let tree = ax_core::build_tree_for_pid(app.pid, 12).expect("读取 AX 树失败");
    let Some(((wx, wy), (ww, wh))) = find_window(&tree) else {
        eprintln!("✗ 没找到 AXWindow（TextEdit 可能停在了打开面板）。");
        std::process::exit(1);
    };
    println!("① TextEdit 窗口 ({wx}, {wy}) 大小 {ww}×{wh}");

    // 2. Drag the window by its title bar (top 28pt) to the right by 160pt.
    let from = (wx + ww / 2.0, wy + 14.0);
    let to = (from.0 + 160.0, from.1 + 40.0);
    ax_act::drag(from.0, from.1, to.0, to.1, 16, None).expect("拖拽失败");
    println!("② 已拖拽标题栏 ({:.0},{:.0}) → ({:.0},{:.0})", from.0, from.1, to.0, to.1);
    sleep(Duration::from_millis(600));

    // 3. Verify the move via AX (the truth source).
    let tree2 = ax_core::build_tree_for_pid(app.pid, 12).expect("二次读树失败");
    match find_window(&tree2) {
        Some(((nx, ny), _)) if (nx - wx).abs() > 100.0 => {
            println!("   ✓ AX 验证: 窗口已移到 ({nx}, {ny})");
        }
        Some(((nx, ny), _)) => println!("   ⚠️ AX 验证: 窗口在 ({nx}, {ny})，位移不足"),
        None => println!("   ⚠️ AX 验证: 找不到窗口了"),
    }

    // 4. Click + double-click inside the text area (upper-left content).
    let cx = wx + 100.0;
    let cy = wy + 120.0;
    ax_act::click_at_position(cx, cy, None).expect("单击失败");
    println!("③ 已在 ({cx:.0}, {cy:.0}) 合成单击（移动光标）");
    sleep(Duration::from_millis(300));
    ax_act::double_click_at_position(cx + 20.0, cy, None).expect("双击失败");
    println!("④ 已在 ({:.0}, {cy:.0}) 合成双击（选中词）", cx + 20.0);

    println!("完成 ✓ — 切到 TextEdit 看看窗口位置与选中的词。");
}
