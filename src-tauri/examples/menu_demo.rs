//! Example: menu-driven control — read the menu bar of the frontmost app,
//! then drive it **semantically** (AXPick/AXPress on menu items, no synthetic
//! mouse).
//!
//! The menu-chain protocol this demonstrates (verified on TextEdit):
//!   1. `AXPick` a top-level menu to open it
//!   2. **re-read the menu bar** — submenu items only populate in AX once
//!      their parent menu is open (a closed menu shows just an empty AXMenu)
//!   3. `AXPick` a submenu item, re-read again, then `AXPress` the leaf item
//!
//! Run (from `src-tauri`, from a terminal holding the Accessibility grant):
//!   cargo run --example menu_demo
use std::thread::sleep;
use std::time::Duration;

use ax_explorer_lib::ax_act::{self, MenuEntry};
use ax_explorer_lib::ax_core::{self, AxAppInfo};

/// Print the menu tree (top 2 levels is plenty for a demo).
fn print_menu(entry: &MenuEntry, depth: usize) {
    if depth <= 2 {
        let indent = "  ".repeat(depth);
        let sub = if entry.children.is_empty() { "" } else { " ▸" };
        println!("{indent}{} [{}]{} ({})", entry.title, entry.role, sub, entry.actions.join(","));
    }
    for child in &entry.children {
        print_menu(child, depth + 1);
    }
}

fn activate_textedit() -> Result<AxAppInfo, String> {
    let apps = ax_core::list_applications();
    let app = apps
        .iter()
        .find(|a| a.bundle_id == "com.apple.TextEdit")
        .ok_or_else(|| "TextEdit 未运行。请先打开 TextEdit。".to_string())?;
    let info = app.clone();
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg("tell application \"TextEdit\" to activate")
        .status();
    sleep(Duration::from_millis(600));
    Ok(info)
}

fn main() {
    if !ax_core::is_process_trusted(false) {
        eprintln!("✗ 未授予辅助功能权限：请从已获权限的终端运行。");
        std::process::exit(2);
    }

    // 1. Activate TextEdit.
    let app = match activate_textedit() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("✗ {e}");
            std::process::exit(1);
        }
    };
    println!("① TextEdit pid {} 已激活", app.pid);

    // 2. Read the menu bar (path-addressed tree).
    let bar = match ax_act::menu_bar_for_pid(app.pid, 6) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("✗ 读取菜单栏失败: {e}");
            std::process::exit(1);
        }
    };
    println!("② 菜单栏树（AXMenuBar，path 寻址）：");
    print_menu(&bar, 0);

    // 3. Open 格式 (AXPick), re-read, open 字体 submenu (AXPick), re-read.
    let geshi = bar.children.iter().find(|c| c.title == "格式").expect("格式");
    ax_core::perform_action_for_path(app.pid, &geshi.path, "AXPick").expect("打开 格式 失败");
    sleep(Duration::from_millis(600));

    let bar2 = ax_act::menu_bar_for_pid(app.pid, 6).expect("二次读树失败");
    let geshi2 = bar2.children.iter().find(|c| c.title == "格式").expect("格式2");
    let ziti = geshi2.children[0]
        .children
        .iter()
        .find(|c| c.title.contains("字体"))
        .expect("字体菜单项");
    ax_core::perform_action_for_path(app.pid, &ziti.path, "AXPick").expect("打开 字体 失败");
    sleep(Duration::from_millis(600));

    // 4. Re-read: the submenu items are NOW populated in AX.
    let bar3 = ax_act::menu_bar_for_pid(app.pid, 6).expect("三次读树失败");
    let geshi3 = bar3.children.iter().find(|c| c.title == "格式").expect("格式3");
    let ziti3 = geshi3.children[0]
        .children
        .iter()
        .find(|c| c.title.contains("字体"))
        .expect("字体3");
    let sub = ziti3.children.iter().find(|c| c.role == "AXMenu")
        .or_else(|| ziti3.children.first())
        .expect("字体子菜单容器");
    println!("\n③ 字体子菜单（打开后 AX 里才有）：{} 项", sub.children.len());
    for c in sub.children.iter().take(6) {
        println!("   · {} path={:?}", c.title, c.path);
    }

    // 5. Press a visible-menu action (显示字体 may be 「隐藏字体」 depending on
    // the panel state — look for either, else fall back to 显示颜色).
    let Some(xianshi) = sub
        .children
        .iter()
        .find(|c| c.title.contains("显示字体") || c.title.contains("隐藏字体") || c.title.contains("显示颜色"))
    else {
        eprintln!("✗ 子菜单里没有字体面板相关菜单项");
        std::process::exit(1);
    };
    ax_core::perform_action_for_path(app.pid, &xianshi.path, "AXPress")
        .expect("点击 显示字体 失败");
    println!("\n④ ✓ 已 AXPress「{}」（path={:?}）", xianshi.title, xianshi.path);
    sleep(Duration::from_millis(800));

    // 6. Close the font panel with Esc (synthetic keyboard).
    let _ = ax_act::press_key_combo("esc", None);
    println!("⑤ ✓ 已按 Esc 关闭字体面板");
    println!("完成 ✓ — 全语义菜单链路：AXPick 打开 → 重读 → AXPick 子菜单 → 重读 → AXPress 叶子项");
}
