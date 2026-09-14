//! Example: OCR a running app's main window — the self-drawn-UI pipeline
//! (CGWindowList window lookup → `screencapture -l` → Apple Vision OCR →
//! screen-point coordinates), used to verify the QQLive fallback path.
//!
//! Run (from `src-tauri`):
//!
//! ```text
//! cargo run --example ocr_window_demo -- <pid | app-name>
//! ```
//!
//! Permissions: Accessibility for the terminal + Screen Recording for the
//! terminal (screencapture).

use std::process::Command;

fn main() {
    let arg = std::env::args().nth(1).unwrap_or_else(|| "QQLive".into());
    let pid: i32 = match arg.parse() {
        Ok(p) => p,
        Err(_) => {
            // Resolve by app name via `lsappinfo` (keeps this example thin).
            let out = Command::new("bash")
                .arg("-c")
                .arg(format!(
                    "lsappinfo list | grep -B 3 -i \"{}\" | grep -o '\"pid\"=[0-9]*' | head -1 | grep -o '[0-9]*'",
                    arg
                ))
                .output()
                .expect("无法运行 lsappinfo");
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            match text.parse() {
                Ok(p) => p,
                Err(_) => {
                    eprintln!("无法把参数解析为 pid：{arg:?}（lsappinfo 输出 {text:?}）");
                    std::process::exit(1);
                }
            }
        }
    };

    // 1. Window lookup: AX tree first, CGWindowList fallback (the path under
    //    test — QQLive's AX windows have no size).
    let ax_tree = ax_explorer_lib::ax_core::build_tree_export(pid, 10);
    println!("AX 树: {}", ax_tree.as_ref().map(|_| "OK".into()).unwrap_or_else(|e| format!("失败 {e}")));
    let cg = ax_explorer_lib::ocr::find_window_cg(pid);
    let Some((win_id, pos, size)) = cg else {
        eprintln!("CGWindowList 也没找到 pid {pid} 的窗口");
        std::process::exit(1);
    };
    println!(
        "CGWindowList: 窗口 id={win_id} 位置=({:.0},{:.0}) 尺寸=({:.0}×{:.0})",
        pos.0, pos.1, size.0, size.1
    );

    // 2. Screenshot by window id.
    let out_path = std::env::temp_dir().join(format!("ocr-demo-{pid}.png"));
    let status = Command::new("/usr/sbin/screencapture")
        .arg("-x")
        .arg("-l")
        .arg(win_id.to_string())
        .arg(&out_path)
        .status()
        .expect("screencapture 启动失败");
    assert!(status.success(), "screencapture 失败（检查屏幕录制权限）");

    // 3. OCR + map to screen points (same math as ax_ocr_window).
    match ax_explorer_lib::ocr::ocr_image(&out_path) {
        Ok(res) => {
            let _ = std::fs::remove_file(&out_path);
            let sx = size.0 / res.width;
            let sy = size.1 / res.height;
            println!("识别到 {} 段文字：", res.words.len());
            let mut words = res.words;
            words.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap().then(a.x.partial_cmp(&b.x).unwrap()));
            for w in words.iter().take(40) {
                println!(
                    "  「{}」 (置信 {:.2}) 屏幕=({:.0},{:.0}) 尺寸=({:.0}×{:.0})",
                    w.text,
                    w.confidence,
                    pos.0 + w.x * sx,
                    pos.1 + w.y * sy,
                    w.w * sx,
                    w.h * sy
                );
            }
        }
        Err(e) => {
            eprintln!("OCR 失败: {e}");
            std::process::exit(1);
        }
    }
}
