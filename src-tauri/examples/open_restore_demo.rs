//! Example: verify `open_application` restores a hidden/closed window.
//! Run: cargo run --example open_restore_demo -- 腾讯视频

fn main() {
    let target = std::env::args().nth(1).unwrap_or_else(|| "腾讯视频".into());
    match ax_explorer_lib::ax_open::open_application(&target) {
        Ok(info) => {
            println!("open_application → {} (pid {})", info.name, info.pid);
            let has_window = ax_explorer_lib::ocr::find_window_cg(info.pid).is_some();
            println!("窗口在屏上: {has_window}");
        }
        Err(e) => {
            eprintln!("失败: {e}");
            std::process::exit(1);
        }
    }
}
