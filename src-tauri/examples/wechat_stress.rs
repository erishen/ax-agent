//! Stress test: the full computer-use loop on **WeChat**, read-only and
//! send-free.
//!
//! Scenario (mirrors what the chat agent would do with the same tools):
//!   1. open/focus WeChat (`ax_open::open_application` — bundle-id path)
//!   2. dump the AX tree, locate the search affordance (`find`-style walk)
//!   3. press `Cmd+F` (`ax_act::press_key_combo` — synthetic keyboard)
//!   4. `type_text_synthetic("文件传输助手", None)` — per-key Unicode typing that
//!      must drive WeChat's search-as-you-type
//!   5. re-dump the tree, find the matching result row, `AXPress` it
//!      (semantic click — WeChat's custom list rows expose AXPress)
//!   6. verify the conversation switched, then `esc` to close the search
//!
//! Safety: targets 文件传输助手 (File Transfer Assistant) — nothing is sent;
//! every step is observe/type/click on our own machine, no messages composed.
//!
//! Run (from `src-tauri`, from a terminal holding the Accessibility grant):
//!   cargo run --example wechat_stress
use std::thread::sleep;
use std::time::Duration;

use ax_explorer_lib::ax_act;
use ax_explorer_lib::ax_core::{self, AxNode};

/// Depth-first search collecting (path, node) for matches.
fn collect<'a>(
    node: &'a AxNode,
    path: Vec<usize>,
    pred: &impl Fn(&AxNode) -> bool,
    out: &mut Vec<(Vec<usize>, &'a AxNode)>,
) {
    if pred(node) {
        out.push((path.clone(), node));
    }
    for (i, child) in node.children.iter().enumerate() {
        let mut p = path.clone();
        p.push(i);
        collect(child, p, pred, out);
    }
}

fn matches(pred: &impl Fn(&AxNode) -> bool, tree: &AxNode) -> Vec<(Vec<usize>, String)> {
    let mut hits = Vec::new();
    collect(tree, Vec::new(), pred, &mut hits);
    hits.into_iter()
        .map(|(p, n)| {
            let label = if n.label.is_empty() { n.role.clone() } else { n.label.clone() };
            (p, label)
        })
        .collect()
}

fn step(n: u8, what: &str) {
    println!("\n── ①②③④⑤⑥⑦⑧⑨⑩[{n}] {what}");
}

fn main() {
    if !ax_core::is_process_trusted(false) {
        eprintln!("✗ 未授予辅助功能权限：请从已获权限的终端运行（dev 应用所在终端）。");
        std::process::exit(2);
    }

    // 1. Open/focus WeChat.
    step(1, "打开/聚焦 WeChat");
    let app = match ax_explorer_lib::ax_open::open_application("WeChat") {
        Ok(a) => a,
        Err(e) => {
            eprintln!("✗ 打开 WeChat 失败: {e}");
            std::process::exit(1);
        }
    };
    println!("   ✓ pid={} name={}", app.pid, app.name);
    sleep(Duration::from_millis(1200));

    // 2. Dump the tree; find the search affordance.
    step(2, "读 AX 树，找搜索入口");
    let tree = match ax_core::build_tree_for_pid(app.pid, 14) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("✗ 读树失败: {e}");
            std::process::exit(1);
        }
    };
    let search_hits = matches(
        &|n: &AxNode| {
            (n.label.contains("搜索") || n.label.to_lowercase().contains("search"))
                && (n.role == "AXButton"
                    || n.role == "AXTextField"
                    || n.role == "AXSearchField"
                    || n.role == "AXStaticText")
        },
        &tree,
    );
    for (p, label) in search_hits.iter().take(8) {
        println!("   候选 path={p:?} {label:?}");
    }
    if search_hits.is_empty() {
        println!("   ⚠️ 树里没有「搜索」节点 —— WeChat 的自绘 UI 可能不暴露搜索元素，只能靠 Cmd+F");
    }

    // 3. Cmd+F — synthetic shortcut.
    step(3, "按 Cmd+F 聚焦搜索");
    if let Err(e) = ax_act::press_key_combo("Cmd+F", None) {
        eprintln!("✗ Cmd+F 失败: {e}");
        std::process::exit(1);
    }
    println!("   ✓ 已发送 Cmd+F");
    sleep(Duration::from_millis(800));

    // Re-dump: did a search field appear / get focused?
    let tree2 = ax_core::build_tree_for_pid(app.pid, 14).expect("二次读树失败");
    let field_hits = matches(
        &|n: &AxNode| {
            n.role == "AXTextField"
                || n.role == "AXSearchField"
                || (n.role == "AXTextArea" && n.label.contains("搜索"))
        },
        &tree2,
    );
    println!("   现在树里的输入框 {} 个:", field_hits.len());
    for (p, label) in field_hits.iter().take(6) {
        println!("   path={p:?} {label:?}");
    }

    // 4. Type the target per-key (Unicode payload → IME-safe).
    step(4, "逐键输入「文件传输助手」");
    if let Err(e) = ax_act::type_text_synthetic("文件传输助手", None) {
        eprintln!("✗ 逐键输入失败: {e}");
        std::process::exit(1);
    }
    println!("   ✓ 已逐键输入 6 个字符");
    sleep(Duration::from_millis(1500));

    // 5. Re-dump; find the result row and AXPress it.
    step(5, "找搜索结果并点击");
    let tree3 = ax_core::build_tree_for_pid(app.pid, 14).expect("三次读树失败");
    let result_hits = matches(&|n: &AxNode| n.label.contains("文件传输助手"), &tree3);
    println!("   「文件传输助手」命中 {} 个节点:", result_hits.len());
    for (p, label) in result_hits.iter().take(10) {
        println!("   path={p:?} {label:?}");
    }
    let pressed = result_hits
        .iter()
        .find(|(p, _)| !p.is_empty())
        .and_then(|(p, _)| {
            // Prefer a node that actually has actions: re-read its actions via
            // a fresh walk is expensive; try AXPress directly and report.
            ax_act::named_action_for_path(app.pid, p, "AXPress").ok()
        });
    match pressed {
        Some(()) => println!("   ✓ 已 AXPress 结果行"),
        None => println!("   ✗ 没有可按的结果行（见上方命中列表）—— 记录为断点"),
    }
    sleep(Duration::from_millis(1500));

    // 6. Verify the conversation switched.
    step(6, "验证会话已切换");
    let tree4 = ax_core::build_tree_for_pid(app.pid, 14).expect("四次读树失败");
    let conv_hits = matches(&|n: &AxNode| n.label.contains("文件传输助手"), &tree4);
    println!("   切换后含「文件传输助手」的节点 {} 个", conv_hits.len());

    // 7. Esc to close any search overlay (send-free cleanup).
    step(7, "按 Esc 关闭搜索浮层");
    let _ = ax_act::press_key_combo("esc", None);
    println!("   ✓ 已发送 Esc");

    println!("\n压测结束 — 以上每一步的 ✓/✗ 就是断点清单。");
}
