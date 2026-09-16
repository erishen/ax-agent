//! Window screenshot, OCR coordinate mapping, and UI-change observation.

use serde::Serialize;

use crate::ax_act;
use crate::ax_core::{self, ExportNode};
use super::u32_path;

/// One app-window screenshot plus its global frame, for the AX↔pixel
/// alignment overlay.
#[derive(Debug, Clone, Serialize)]
pub struct ScreenshotInfo {
    pub pid: i32,
    /// kCGWindowNumber used by `screencapture -l`.
    pub window_id: i64,
    /// Window's global top-left corner in points (matches AXPosition).
    pub position: (f64, f64),
    /// Window size in points (matches AXSize; the image renders at 1 pt = 1 px).
    pub size: (f64, f64),
    /// PNG bytes as a base64 `data:` URL, ready for <img>.
    pub image: String,
}

/// Collect every AXWindow in the tree (depth-first order).
fn collect_windows<'a>(node: &'a ExportNode, out: &mut Vec<&'a ExportNode>) {
    if node.role == "AXWindow" {
        out.push(node);
    }
    for child in &node.children {
        collect_windows(child, out);
    }
}

/// Pick the largest window that has both AXPosition and AXSize — apps expose
/// several AXWindow nodes (QQLive: an extra `Window「Window」` without size),
/// and the first one in tree order is not necessarily the real main window.
fn find_window_node(tree: &ExportNode) -> Option<&ExportNode> {
    let mut windows = Vec::new();
    collect_windows(tree, &mut windows);
    windows
        .into_iter()
        .filter(|w| w.position.is_some() && w.size.is_some())
        .max_by(|a, b| {
            let area = |w: &ExportNode| {
                let s = w.size.unwrap_or((0.0, 0.0));
                s.0 * s.1
            };
            area(a)
                .partial_cmp(&area(b))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
}

/// Minimal base64 (RFC 4648) — avoids pulling a dependency just for this.
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(n & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// Captured window: (png path, CG window number, position, size) in points.
type CapturedWindow = (std::path::PathBuf, i64, (f64, f64), (f64, f64));

/// Capture the app's main window (`screencapture -l`) into a temp PNG.
/// Returns (temp path, window number, window AX position in points, AX size).
///
/// # Errors
/// Untrusted process, no window, missing window number, or screen-recording
/// permission not granted.
fn capture_window_png(
    pid: i32,
) -> Result<CapturedWindow, String> {
    if !ax_core::is_process_trusted(false) {
        return Err("未授予辅助功能权限 (Accessibility permission not granted)".to_string());
    }
    // CGWindowList is the ground truth for window geometry here: AX window
    // nodes of self-drawn UIs (QQLive 这类) return position (0,0), which made
    // OCR coordinates collapse onto the *primary* screen even when the window
    // sits on a secondary display. Fallbacks (other Spaces / AX) are only
    // used when they yield a *real* frame — otherwise we error out instead of
    // emitting misleading coordinates.
    let tree = || ax_core::build_tree_export(pid, 10);
    let (window_id, position, size) = match crate::ocr::find_window_cg(pid) {
        Some(found) => found,
        None => match crate::ocr::find_window_cg_all(pid) {
            // Window on another Space: true bounds still known, screenshot may
            // fail — that will surface as an explicit error, not bad coords.
            Some(found) => found,
            None => {
                let tree = tree()?;
                let win = find_window_node(&tree).ok_or(
                    "找不到该应用在屏幕上的窗口（可能被最小化/隐藏，或已关闭）。先 open_app 重新激活它，若仍失败请用户手动点开它的窗口",
                )?;
                // AX positions of (0,0) are a self-drawn-UI lie: reject them.
                let position = win
                    .position
                    .filter(|(x, y)| *x != 0.0 || *y != 0.0)
                    .ok_or("窗口没有可用位置（AX 与 CGWindowList 都拿不到），无法定位 OCR 坐标")?;
                let size = win
                    .size
                    .filter(|(w, h)| *w > 0.0 && *h > 0.0)
                    .ok_or("窗口没有可用尺寸（AX 与 CGWindowList 都拿不到），无法定位 OCR 坐标")?;
                let path_u = u32_path(&win.path);
                let window_number = ax_act::read_attribute_for_path(pid, &path_u, "AXWindowNumber")
                    .ok()
                    .and_then(|s| s.and_then(|s| s.trim().parse::<i64>().ok()))
                    .ok_or("窗口号缺失（AX 与 CGWindowList 都拿不到），无法截屏")?;
                (window_number, position, size)
            }
        },
    };

    let out = std::env::temp_dir().join(format!("ax-shot-{pid}.png"));
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .arg("-x")
        .arg("-l")
        .arg(window_id.to_string())
        .arg(&out)
        .status()
        .map_err(|e| format!("screencapture 启动失败: {e}"))?;
    if !status.success() {
        return Err(
            "截图失败：请先在「系统设置 → 隐私与安全性 → 屏幕录制」中允许本应用".to_string(),
        );
    }
    Ok((out, window_id, position, size))
}

/// Capture the app's main window and return the PNG plus its global frame.
///
/// # Errors
/// See [`capture_window_png`].
#[tauri::command(async)]
pub fn ax_screenshot_window(pid: i32) -> Result<ScreenshotInfo, String> {
    let (out, window_id, position, size) = capture_window_png(pid)?;
    let bytes = std::fs::read(&out).map_err(|e| format!("读取截图失败: {e}"))?;
    let _ = std::fs::remove_file(&out);
    let image = format!("data:image/png;base64,{}", base64_encode(&bytes));
    Ok(ScreenshotInfo {
        pid,
        window_id,
        position,
        size,
        image,
    })
}

/// The main on-screen window frame of `pid` in screen points (top-left
/// origin, same space as screen_info / OCR coordinates). Used by the drive
/// mode to park our window on a screen the target does not occupy.
#[derive(Debug, Clone, serde::Serialize)]
pub struct WindowBounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[tauri::command]
pub fn ax_window_bounds(pid: i32) -> Option<WindowBounds> {
    let (_, (x, y), (w, h)) = crate::ocr::find_window_cg(pid)?;
    Some(WindowBounds { x, y, w, h })
}

/// One OCR'd text span mapped to *screen* coordinates (points, top-left
/// origin) — directly usable with click_at / type_keys / element_at.
#[derive(Debug, Clone, serde::Serialize)]
pub struct OcrScreenWord {
    pub text: String,
    pub confidence: f64,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Convert an image-pixel coordinate inside a screenshot to screen points:
/// `origin + pixel * window_points / image_pixels`. This single formula is the
/// Retina-safe bridge between the screenshot PNG and the window's global frame.
fn pixel_to_screen(pixel: f64, image_pixels: f64, window_points: f64, origin: f64) -> f64 {
    origin + pixel * window_points / image_pixels
}

/// Map an OCR bounding box (image pixels) into global screen points.
fn ocr_box_to_screen(
    box_tl: (f64, f64),
    box_wh: (f64, f64),
    window_pos: (f64, f64),
    window_size: (f64, f64),
    image_px: (f64, f64),
) -> (f64, f64, f64, f64) {
    (
        pixel_to_screen(box_tl.0, image_px.0, window_size.0, window_pos.0),
        pixel_to_screen(box_tl.1, image_px.1, window_size.1, window_pos.1),
        box_wh.0 * window_size.0 / image_px.0,
        box_wh.1 * window_size.1 / image_px.1,
    )
}

/// OCR the app's main window and return every text span with its screen
/// coordinates. Purpose-built for self-drawn UIs (自绘 UI) whose AX tree has
/// no readable labels.
///
/// # Errors
/// See [`capture_window_png`]; also Vision failures.
#[tauri::command(async)]
pub fn ax_ocr_window(pid: i32) -> Result<Vec<OcrScreenWord>, String> {
    let (out, _window_id, position, size) = capture_window_png(pid)?;
    let res = crate::ocr::ocr_image(&out).map_err(|e| format!("OCR 失败: {e}"))?;
    let _ = std::fs::remove_file(&out);
    // Map image pixels → window points (handles Retina scale factors).
    let img = (res.width, res.height);
    Ok(res
        .words
        .into_iter()
        .map(|w| {
            let (x, y, ww, hh) = ocr_box_to_screen(
                (w.x, w.y),
                (w.w, w.h),
                position,
                size,
                img,
            );
            OcrScreenWord {
                text: w.text,
                confidence: w.confidence,
                x,
                y,
                w: ww,
                h: hh,
            }
        })
        .collect())
}

/// Result of waiting for a UI change on a pid (AX notifications or timeout).
#[derive(Clone, serde::Serialize)]
pub struct ObserveWaitResult {
    pub changed: bool,
    pub waited_secs: u64,
}

/// Wait up to `timeout` seconds for the app's UI to change, waking early on a
/// real AX notification when possible. Exposed to the agent as the `wait_for`
/// tool so long tasks can synchronize on app launch / list loading instead of
/// blind sleeps. Blocking wait runs on a background thread; `timeout` is
/// clamped to 10 s to bound the call.
#[tauri::command(async)]
pub async fn ax_observe_wait(pid: i32, timeout: u64) -> Result<ObserveWaitResult, String> {
    let timeout = timeout.clamp(0, 10);
    tauri::async_runtime::spawn_blocking(move || {
        let baseline = crate::ax_act::last_trigger_bump();
        // Best-effort fast path: wake early on a real UI notification.
        let _ = crate::ax_act::register_for_pid(pid);
        crate::ax_act::wait_for_change(timeout)
            .map_err(|e| format!("等待失败: {e}"))?;
        let changed =
            !crate::ax_act::observer_dead() && crate::ax_act::has_bumped_since(baseline);
        Ok(ObserveWaitResult {
            changed,
            waited_secs: timeout,
        })
    })
    .await
    .map_err(|e| format!("等待任务异常: {e}"))?
}

#[cfg(test)]
mod ocr_mapping_tests {
    use super::*;

    #[test]
    fn retina_secondary_screen() {
        // 2x Retina window on the secondary display: 1345 pt window == 2690 px image.
        let (x, y, w, h) = ocr_box_to_screen(
            (500.0, 300.0),
            (100.0, 40.0),
            (1941.0, 80.0),
            (1345.0, 760.0),
            (2690.0, 1520.0),
        );
        assert_eq!((x, y, w, h), (2191.0, 230.0, 50.0, 20.0));
    }

    #[test]
    fn unit_scale_primary_screen() {
        // 1x: pixels == points, no scaling.
        let (x, y, w, h) = ocr_box_to_screen(
            (100.0, 50.0),
            (200.0, 30.0),
            (0.0, 0.0),
            (800.0, 600.0),
            (800.0, 600.0),
        );
        assert_eq!((x, y, w, h), (100.0, 50.0, 200.0, 30.0));
    }

    #[test]
    fn pixel_to_screen_matches_formula() {
        assert_eq!(pixel_to_screen(500.0, 2690.0, 1345.0, 1941.0), 2191.0);
        assert_eq!(pixel_to_screen(0.0, 100.0, 50.0, 10.0), 10.0);
    }

    #[test]
    fn u32_path_converts_and_preserves_order() {
        assert_eq!(u32_path(&[]), Vec::<usize>::new());
        assert_eq!(u32_path(&[0, 1, 2]), vec![0, 1, 2]);
        assert_eq!(u32_path(&[7, 42, 65535]), vec![7, 42, 65535]);
    }
}
