//! macOS Vision OCR bridge for self-drawn UIs (腾讯视频/QQLive 这类 AX 树
//! 没有语义标签的 app)：截图 → Apple Vision 文字识别 → 每段文字的图像
//! 像素坐标。屏幕坐标换算在 commands::ax_ocr_window 完成。
//!
//! Uses objc2-vision (generated bindings); `en_US` not needed — we force
//! zh-Hans/zh-Hant/en automatically so ad posters and movie titles OCR well.
//! `find_window_cg` is the CGWindowList fallback used when the AX tree has no
//! window with position/size (Electron/CEF clients expose none).

use std::path::Path;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::AnyThread;
use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
use objc2_vision::{
    VNImageRequestHandler, VNRecognizeTextRequest, VNRecognizedTextObservation,
    VNRequest, VNRequestTextRecognitionLevel,
};

/// One recognized text span, coordinates in *image pixels* (top-left origin).
#[derive(Debug, Clone, serde::Serialize)]
pub struct OcrWord {
    pub text: String,
    pub confidence: f64,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Full OCR result: the image size (needed to map pixels → screen points)
/// plus every recognized word.
#[derive(Debug)]
pub struct OcrResult {
    pub width: f64,
    pub height: f64,
    pub words: Vec<OcrWord>,
}

/// Parse the PNG header (IHDR) for pixel dimensions — no image decoding.
pub fn png_size(path: &Path) -> Result<(f64, f64), String> {
    let f = std::fs::File::open(path).map_err(|e| format!("打开截图失败: {e}"))?;
    use std::io::Read;
    let mut buf = [0u8; 24];
    let mut rd = f.take(24);
    rd.read_exact(&mut buf)
        .map_err(|e| format!("读取 PNG 头失败: {e}"))?;
    if &buf[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("截图不是 PNG 格式".to_string());
    }
    let w = u32::from_be_bytes([buf[16], buf[17], buf[18], buf[19]]) as f64;
    let h = u32::from_be_bytes([buf[20], buf[21], buf[22], buf[23]]) as f64;
    Ok((w, h))
}

/// Run Apple Vision text recognition on a PNG file.
pub fn ocr_image(path: &Path) -> Result<OcrResult, String> {
    let (width, height) = png_size(path)?;
    let bytes = std::fs::read(path).map_err(|e| format!("读取截图失败: {e}"))?;

    let data = NSData::from_vec(bytes);
    // Empty options dict (VNImageOption is NSString-typed; empty = no options).
    let options = NSDictionary::<NSString, AnyObject>::dictionary();
    let handler = VNImageRequestHandler::initWithData_options(
        VNImageRequestHandler::alloc(),
        &data,
        &options,
    );

    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    request.setUsesLanguageCorrection(true);
    // Force Chinese + English so 中文海报/片名识别更稳。
    let langs: Retained<NSArray<NSString>> = ["zh-Hans", "zh-Hant", "en-US"]
        .into_iter()
        .map(|l| NSString::from_str(l))
        .collect();
    request.setRecognitionLanguages(&langs);

    let requests: Retained<NSArray<VNRequest>> = vec![unsafe { Retained::<VNRecognizeTextRequest>::cast_unchecked(request.clone()) }]
        .into_iter()
        .collect();
    handler
        .performRequests_error(&requests)
        .map_err(|e| format!("Vision 识别失败: {e:?}"))?;

    let results = request.results()
        .ok_or_else(|| "Vision 未返回识别结果".to_string())?;
    let mut words = Vec::new();
    for obs in results.to_vec() {
        let Some(text_obs) = obs.downcast_ref::<VNRecognizedTextObservation>() else {
            continue;
        };
        let Some(candidate) = text_obs.topCandidates(1).to_vec().into_iter().next() else {
            continue;
        };
        let text = candidate.string().to_string();
        let confidence = candidate.confidence() as f64;
        // boundingBox is normalized [0..1], origin at bottom-left.
        let b = unsafe { text_obs.boundingBox() };
        let x = b.origin.x * width;
        let w = b.size.width * width;
        let h = b.size.height * height;
        let y = (1.0 - (b.origin.y + b.size.height)) * height;
        if text.trim().is_empty() {
            continue;
        }
        words.push(OcrWord {
            text,
            confidence,
            x,
            y,
            w,
            h,
        });
    }

    Ok(OcrResult {
        width,
        height,
        words,
    })
}

/// Find `pid`'s main on-screen window via CGWindowList — the fallback for
/// self-drawn UIs (Electron/CEF) whose AX windows carry no
/// AXPosition/AXSize. Takes the largest window by area.
///
/// Returns `(kCGWindowNumber, position, size)` in points, top-left origin —
/// the same coordinate space as AXPosition.
pub fn find_window_cg(pid: i32) -> Option<(i64, (f64, f64), (f64, f64))> {
    find_window_cg_with(
        pid,
        core_graphics::window::kCGWindowListOptionOnScreenOnly,
    )
}

/// Like [`find_window_cg`] but skips the on-screen filter: windows sitting on
/// *another* macOS Space / minimized are still matched, so their true bounds
/// (rather than an AX `(0,0)`) survive into OCR coordinate mapping.
pub fn find_window_cg_all(pid: i32) -> Option<(i64, (f64, f64), (f64, f64))> {
    find_window_cg_with(pid, core_graphics::window::kCGWindowListOptionAll)
}

fn find_window_cg_with(
    pid: i32,
    option: core_graphics::window::CGWindowListOption,
) -> Option<(i64, (f64, f64), (f64, f64))> {
    use core_foundation::base::TCFType;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;

    type Void = *const std::ffi::c_void;
    type VoidDict = CFDictionary<Void, Void>;

    /// Read `key` (a CG window-info constant) from `dict` as a number.
    fn dict_num(dict: &VoidDict, key: core_foundation::string::CFStringRef) -> Option<f64> {
        // SAFETY: the values really are CFNumbers; keys are the documented
        // CGWindowList constants owned by CoreGraphics.
        let v = dict.find(key as Void)?;
        unsafe { CFNumber::wrap_under_get_rule(*v as _) }.to_f64()
    }

    let list = core_graphics::window::copy_window_info(option, core_graphics::window::kCGNullWindowID)?;
    let mut best: Option<(f64, i64, (f64, f64), (f64, f64))> = None;
    for i in 0..list.len() {
        // Each entry is a CFDictionary of window attributes.
        let entry: VoidDict = unsafe { CFDictionary::wrap_under_get_rule(*list.get(i)? as _) };
        let Some(owner_pid) = dict_num(&entry, unsafe { core_graphics::window::kCGWindowOwnerPID })
        else {
            continue;
        };
        if owner_pid != pid as f64 {
            continue;
        }
        let Some(win_id) = dict_num(&entry, unsafe { core_graphics::window::kCGWindowNumber })
        else {
            continue;
        };
        // Bounds is a nested CFDictionary {X, Y, Width, Height}.
        let bounds_ptr =
            *entry.find(unsafe { core_graphics::window::kCGWindowBounds } as Void)?;
        let bounds: VoidDict = unsafe { CFDictionary::wrap_under_get_rule(bounds_ptr as _) };
        let coord = |k: &str| -> Option<f64> {
            let key = CFString::new(k); // keep the key alive during find()
            let v = bounds.find(key.as_concrete_TypeRef() as Void)?;
            unsafe { CFNumber::wrap_under_get_rule(*v as _) }.to_f64()
        };
        let (Some(x), Some(y), Some(w), Some(h)) =
            (coord("X"), coord("Y"), coord("Width"), coord("Height"))
        else {
            continue;
        };
        if w <= 0.0 || h <= 0.0 {
            continue;
        }
        // Prefer the largest window; ties keep the first (usually the main).
        if best.as_ref().is_none_or(|(a, _, _, _)| w * h > *a) {
            best = Some((w * h, win_id as i64, (x, y), (w, h)));
        }
    }
    best.map(|(_, id, pos, size)| (id, pos, size))
}