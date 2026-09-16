// ax_ocr.rs - CLI smoke test + debug tool for the OCR pipeline (self-drawn
// UIs). Reuses the library bridge (src/ocr.rs) — the same code path the
// agent's `ocr` tool runs — so this bin doubles as an end-to-end check.
//
//   ax_ocr <png>         OCR an existing PNG (prints pixel coords)
//   ax_ocr --pid <pid>   screenshot the pid's main window, then OCR
//                        (prints screen-point coords, Retina-safe)
use std::path::Path;
use std::process;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.as_slice() {
        [_, png] => ocr_png(png),
        [_, flag, pid] if flag == "--pid" => match pid.parse::<i32>() {
            Ok(p) => ocr_window(p),
            Err(_) => {
                eprintln!("[ocr] bad pid: {pid}");
                process::exit(2);
            }
        },
        _ => {
            eprintln!("usage: ax_ocr <png>        OCR an existing PNG");
            eprintln!("       ax_ocr --pid <pid>  screenshot the pid's main window, then OCR");
            process::exit(2);
        }
    }
}

fn ocr_png(p: &str) {
    match ax_agent_lib::ocr::ocr_image(Path::new(p)) {
        Ok(res) => {
            println!(
                "[ocr] ok img={}x{} words={}",
                res.width as u32,
                res.height as u32,
                res.words.len()
            );
            for w in &res.words {
                println!(
                    "{:.2} px=({:.0},{:.0} {:.0}x{:.0})  {}",
                    w.confidence, w.x, w.y, w.w, w.h, w.text
                );
            }
        }
        Err(e) => {
            eprintln!("[ocr] error: {e}");
            process::exit(3);
        }
    }
}

fn ocr_window(pid: i32) {
    let Some((win_id, (x, y), (w, h))) = ax_agent_lib::ocr::find_window_cg(pid) else {
        eprintln!("[ocr] no on-screen window for pid {pid}");
        process::exit(4);
    };
    let out = std::env::temp_dir().join(format!("ax-ocr-{pid}.png"));
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .arg("-x")
        .arg("-l")
        .arg(win_id.to_string())
        .arg(&out)
        .status()
        .unwrap_or_else(|e| {
            eprintln!("[ocr] screencapture 启动失败: {e}");
            process::exit(5);
        });
    if !status.success() {
        eprintln!("[ocr] 截图失败（缺少屏幕录制权限？）");
        process::exit(6);
    }
    match ax_agent_lib::ocr::ocr_image(&out) {
        Ok(res) => {
            let _ = std::fs::remove_file(&out);
            println!(
                "[ocr] pid={pid} window={win_id} frame=({x:.0},{y:.0} {w:.0}x{h:.0}) img={}x{} words={}",
                res.width as u32,
                res.height as u32,
                res.words.len()
            );
            for wd in &res.words {
                // image px -> screen points, same Retina-safe formula as
                // commands::ocr_box_to_screen.
                let sx = x + wd.x * w / res.width;
                let sy = y + wd.y * h / res.height;
                let sw = wd.w * w / res.width;
                let sh = wd.h * h / res.height;
                println!(
                    "{:.2} screen=({sx:.0},{sy:.0} {sw:.0}x{sh:.0})  {}",
                    wd.confidence, wd.text
                );
            }
        }
        Err(e) => {
            eprintln!("[ocr] error: {e}");
            process::exit(3);
        }
    }
}
