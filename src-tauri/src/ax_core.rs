//! Accessibility (AXUIElement) core: trust check, app listing, AX tree walking.
//!
//! The macOS Accessibility API is a C API (HIServices inside ApplicationServices):
//! attribute reads are synchronous IPC (Mach messages) into the target process, so
//! every `AXUIElementCopyAttributeValue` call can block. We keep recursion shallow
//! (depth limit) and read a fixed set of "interesting" attributes instead of
//! enumerating everything, which keeps tree dumps fast even for large apps.
//!
//! Attribute values arrive as `CFTypeRef` (+1 retained, Copy rule). We wrap them
//! in `CFRetained<CFType>` immediately so ownership is release-safe, then downcast
//! to CFString / CFNumber / CFBoolean / AXValue for rendering.

use std::ptr::NonNull;

use objc2_app_kit::{NSApplicationActivationPolicy, NSWorkspace};
use objc2_application_services::{
    AXError, AXIsProcessTrusted, AXIsProcessTrustedWithOptions, AXUIElement, AXValue, AXValueType,
};
use objc2_core_foundation::{
    CFArray, CFBoolean, CFDictionary, CFNull, CFNumber, CFRetained, CFString, CFType,
};

use serde::Serialize;

// ---------------------------------------------------------------------------
// Data model (serialized to the frontend)
// ---------------------------------------------------------------------------

/// A single row of attribute data attached to a tree node.
#[derive(Debug, Clone, Serialize)]
pub struct AxAttr {
    pub name: String,
    pub value: String,
}

/// One node of the accessibility tree.
#[derive(Debug, Clone, Serialize)]
pub struct AxNode {
    /// Short label shown in the tree (title / description / role description).
    pub label: String,
    /// AXRole, e.g. "AXButton".
    pub role: String,
    /// Depth in the tree (root application element = 0).
    pub depth: usize,
    /// Display attributes gathered for this node.
    pub attributes: Vec<AxAttr>,
    /// Actions this element supports (e.g. "AXPress").
    pub actions: Vec<String>,
    /// Child nodes.
    pub children: Vec<AxNode>,
}

/// Summary info about a GUI application.
#[derive(Debug, Clone, Serialize)]
pub struct AxAppInfo {
    pub pid: i32,
    pub name: String,
    pub bundle_id: String,
    pub is_active: bool,
    pub is_hidden: bool,
}

/// Machine-friendly tree node used for JSON export / feeding the LLM: carries
/// the child-index path from the app root plus parsed geometry, so consumers
/// can re-address elements and do hit-test math without re-walking.
#[derive(Debug, Clone, Serialize)]
pub struct ExportNode {
    /// Child-index path from the application root (`[]` = the app itself).
    pub path: Vec<u32>,
    pub role: String,
    pub label: String,
    pub value: String,
    /// Global-screen top-left corner (points), parsed from AXPosition.
    pub position: Option<(f64, f64)>,
    /// Width/height (points), parsed from AXSize.
    pub size: Option<(f64, f64)>,
    pub actions: Vec<String>,
    pub children: Vec<ExportNode>,
}

// ---------------------------------------------------------------------------
// Permission (trusted accessibility client)
// ---------------------------------------------------------------------------

/// Check whether this process is trusted for accessibility. When `prompt` is
/// true, macOS opens System Settings on the Accessibility pane if not trusted.
#[must_use]
pub fn is_process_trusted(prompt: bool) -> bool {
    unsafe {
        if prompt {
            let key = CFString::from_str("AXTrustedCheckOptionPrompt");
            let options = CFDictionary::from_slices(&[&*key], &[CFBoolean::new(true)]);
            AXIsProcessTrustedWithOptions(Some(options.as_opaque()))
        } else {
            AXIsProcessTrusted()
        }
    }
}

/// Human-readable description of an [`AXError`], mirroring Apple's docs.
#[must_use]
pub fn ax_error_description(err: AXError) -> &'static str {
    match err {
        AXError::Success => "success",
        AXError::Failure => "system failure",
        AXError::IllegalArgument => "illegal argument",
        AXError::InvalidUIElement => "invalid UI element (app quit or element died)",
        AXError::InvalidUIElementObserver => "invalid UI element observer",
        AXError::CannotComplete => "cannot complete (app busy or messaging timed out)",
        AXError::AttributeUnsupported => "attribute not supported by this element",
        AXError::ActionUnsupported => "action not supported by this element",
        AXError::NotificationUnsupported => "notification not supported",
        AXError::NotImplemented => "process does not implement the accessibility API",
        AXError::NotificationAlreadyRegistered => "notification already registered",
        AXError::NotificationNotRegistered => "notification not registered",
        AXError::APIDisabled => "accessibility API is disabled on this system",
        AXError::NoValue => "attribute has no value",
        AXError::ParameterizedAttributeUnsupported => "parameterized attribute not supported",
        AXError::NotEnoughPrecision => "not enough precision",
        _ => "unknown AX error",
    }
}

// ---------------------------------------------------------------------------
// App enumeration (NSWorkspace; must run on the main thread)
// ---------------------------------------------------------------------------

/// An installed application on disk (name + full path).
#[derive(Debug, Clone, Serialize)]
pub struct InstalledApp {
    /// Localized display name (e.g. 备忘录 on a zh-CN system, Notes on en).
    pub name: String,
    /// Bundle display name from Info.plist (language-independent, e.g. Notes).
    pub bundle_name: String,
    /// CFBundleIdentifier from Info.plist (e.g. com.apple.Notes) — the only
    /// locale-proof way to launch an app (`open -b`).
    pub bundle_id: String,
    /// Full path to the .app bundle.
    pub path: String,
}

/// Directories scanned for installed applications. The user dir wins over
/// system dirs because later inserts overwrite earlier same-name entries.
fn app_scan_roots() -> Vec<std::path::PathBuf> {
    let mut roots = vec![
        std::path::PathBuf::from("/Applications"),
        std::path::PathBuf::from("/System/Applications"),
        std::path::PathBuf::from("/System/Applications/Utilities"),
        std::path::PathBuf::from("/Applications/Utilities"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(std::path::PathBuf::from(&home).join("Applications"));
    }
    roots
}

/// Collect `*.app` bundles under `root`, up to two levels deep (covers
/// `/Applications/Utilities/X.app` and `/Applications/Dev/Xcode.app` layouts).
fn scan_dir(root: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("app") {
            out.push(path);
        } else if path.is_dir()
            && !path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with('.'))
        {
            // One nesting level below the root only.
            let Ok(sub) = std::fs::read_dir(&path) else {
                continue;
            };
            for e in sub.flatten() {
                let p = e.path();
                if p.extension().and_then(|ext| ext.to_str()) == Some("app") {
                    out.push(p);
                }
            }
        }
    }
}

/// Localized display name of an `.app` (Finder's name for it, e.g. 备忘录);
/// falls back to the file stem.
fn localized_app_name(path: &std::path::Path, stem: &str) -> String {
    use objc2_foundation::NSFileManager;
    // Safe: pure getters into Foundation; no invariants to uphold.
    let ns_path = objc2_foundation::NSString::from_str(path.to_string_lossy().as_ref());
    let name = NSFileManager::defaultManager().displayNameAtPath(&ns_path);
    let s = name.to_string();
    if s.is_empty() {
        return stem.to_string();
    }
    // Some locales return "备忘录.app" — drop a trailing ".app" if present.
    s.strip_suffix(".app").unwrap_or(&s).to_string()
}

/// Pull `CFBundleName`/`CFBundleDisplayName` and `CFBundleIdentifier` from the
/// app's Info.plist. Handles both XML and binary plists (the latter via
/// `plutil -convert xml1`). Falls back to the file stem for the name.
fn bundle_info(path: &std::path::Path, stem: &str) -> (String, String) {
    let plist = path.join("Contents").join("Info.plist");
    let mut display = String::new();
    let mut bundle_id = String::new();
    if let Ok(bytes) = std::fs::read(&plist) {
        let text = if bytes.starts_with(b"<?xml") || bytes.first() == Some(&b'<') {
            String::from_utf8_lossy(&bytes).into_owned()
        } else if let Ok(decoded) = std::process::Command::new("plutil")
            .arg("-convert")
            .arg("xml1")
            .arg("-o")
            .arg("-")
            .arg(&plist)
            .output()
        {
            String::from_utf8_lossy(&decoded.stdout).into_owned()
        } else {
            String::new()
        };
        let value_after = |key: &str| -> Option<String> {
            let pos = text.find(&format!("<key>{key}</key>"))?;
            let start = text[pos..].find("<string>")?;
            let rest = &text[pos + start + "<string>".len()..];
            let end = rest.find("</string>")?;
            let v = rest[..end].trim();
            (!v.is_empty()).then(|| v.to_string())
        };
        display = value_after("CFBundleDisplayName").or_else(|| value_after("CFBundleName")).unwrap_or_default();
        bundle_id = value_after("CFBundleIdentifier").unwrap_or_default();
    }
    if display.is_empty() {
        display = stem.to_string();
    }
    (display, bundle_id)
}

/// Scan all standard + user application directories for installed `.app`
/// bundles. Deduplicated by Info.plist bundle name (a user-dir app shadows
/// the system one). Returns localized display names so example tasks can say
/// 「打开 备忘录」 on a Chinese system and 「打开 Notes」 on an English one.
///
/// # Errors
/// Returns a message only when none of the directories can be read.
pub fn list_installed_apps() -> Result<Vec<InstalledApp>, String> {
    let mut paths: Vec<std::path::PathBuf> = Vec::new();
    for root in app_scan_roots() {
        scan_dir(&root, &mut paths);
    }
    if paths.is_empty() {
        return Err("无法读取任何应用程序目录".to_string());
    }

    // Dedupe by bundle display name; user-dir entries come last and win.
    let mut by_name: std::collections::BTreeMap<String, InstalledApp> =
        std::collections::BTreeMap::new();
    for path in paths {
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let (bundle_name, bundle_id) = bundle_info(&path, stem);
        let name = localized_app_name(&path, &bundle_name);
        by_name.insert(
            bundle_name.to_lowercase(),
            InstalledApp {
                name,
                bundle_name,
                bundle_id,
                path: path.to_string_lossy().into_owned(),
            },
        );
    }
    let mut apps: Vec<InstalledApp> = by_name.into_values().collect();
    apps.sort_by_key(|a| a.bundle_name.to_lowercase());
    Ok(apps)
}

/// List GUI applications that are interesting for AX inspection: regular
/// (window-capable) apps only, active app first.
#[must_use]
pub fn list_applications() -> Vec<AxAppInfo> {
    let mut out = Vec::new();
    {
        for app in NSWorkspace::sharedWorkspace().runningApplications() {
            if app.activationPolicy() != NSApplicationActivationPolicy::Regular {
                continue;
            }
            if app.isTerminated() {
                continue;
            }
            let pid = app.processIdentifier();
            if pid <= 0 {
                continue;
            }
            let name = app
                .localizedName()
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("pid {pid}"));
            let bundle_id = app
                .bundleIdentifier()
                .map(|s| s.to_string())
                .unwrap_or_default();
            out.push(AxAppInfo {
                pid,
                name,
                bundle_id,
                is_active: app.isActive(),
                is_hidden: app.isHidden(),
            });
        }
    }
    out.sort_by(|a, b| {
        b.is_active
            .cmp(&a.is_active)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}

// ---------------------------------------------------------------------------
// CFType -> readable string
// ---------------------------------------------------------------------------

/// Convert an arbitrary CFType attribute value to a display string.
/// AXUIElement and AXValue values get structural decoding; everything else
/// falls back to common property-list types.
pub(crate) fn cftype_to_string(value: &CFType) -> Option<String> {
    {
        // AXUIElement: render as a summary instead of dumping a pointer.
        if value.downcast_ref::<AXUIElement>().is_some() {
            return Some("<AXUIElement>".to_string());
        }

        // AXValue: CGPoint / CGSize / CGRect / CFRange — try each in turn;
        // AXValueGetValue returns false when the encoded type doesn't match.
        if let Some(ax_value) = value.downcast_ref::<AXValue>() {
            return decode_ax_value(ax_value);
        }

        // Numbers (f64 covers all integer widths we care about here).
        if let Some(num) = value.downcast_ref::<CFNumber>() {
            return num.as_f64().map(trim_float);
        }

        // Booleans.
        if let Some(b) = value.downcast_ref::<CFBoolean>() {
            return Some(b.value().to_string());
        }

        // Strings.
        if let Some(s) = value.downcast_ref::<CFString>() {
            return Some(s.to_string());
        }
    }
    None
}

/// Decode an AXValue (CGPoint / CGSize / CGRect / CFRange) into a string.
fn decode_ax_value(value: &AXValue) -> Option<String> {
    unsafe {
        let mut point = CGPointStruct { x: 0.0, y: 0.0 };
        if value.value(AXValueType::CGPoint, NonNull::from(&mut point).cast()) {
            return Some(format!("{{x: {}, y: {}}}", point.x, point.y));
        }

        let mut size = CGSizeStruct { w: 0.0, h: 0.0 };
        if value.value(AXValueType::CGSize, NonNull::from(&mut size).cast()) {
            return Some(format!("{{w: {}, h: {}}}", size.w, size.h));
        }

        let mut rect = CGRectStruct::default();
        if value.value(AXValueType::CGRect, NonNull::from(&mut rect).cast()) {
            return Some(format!(
                "{{x: {}, y: {}, w: {}, h: {}}}",
                rect.origin.x, rect.origin.y, rect.size.w, rect.size.h
            ));
        }

        let mut range = CFRangeStruct { loc: 0, len: 0 };
        if value.value(AXValueType::CFRange, NonNull::from(&mut range).cast()) {
            return Some(format!("{{loc: {}, len: {}}}", range.loc, range.len));
        }

        None
    }
}

fn trim_float(f: f64) -> String {
    let s = format!("{f:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Layout structs used with AXValueGetValue. Field order must match the C
/// structs (CGPoint / CGSize / CGRect / CFRange) exactly.
#[repr(C)]
#[derive(Default)]
struct CGPointStruct {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Default)]
struct CGSizeStruct {
    w: f64,
    h: f64,
}

#[repr(C)]
#[derive(Default)]
struct CGRectStruct {
    origin: CGPointStruct,
    size: CGSizeStruct,
}

#[repr(C)]
struct CFRangeStruct {
    loc: isize,
    len: isize,
}

// ---------------------------------------------------------------------------
// Main-thread dispatch (WebKit crash guard)
// ---------------------------------------------------------------------------

/// Run a closure on the main thread and return its value.
///
/// The macOS Accessibility API is generally callable from any thread, but
/// **WebKit** (any WKWebView-based app) explicitly crashes the *calling
/// process* — `WebKit::crashDueToApplicationCallingMainThreadOnlyWebKitAPIFromBackgroundThread`
/// → SIGTRAP — when an AX message arrives from a background thread. Our AX
/// calls run on tokio worker threads, so every AX IPC entry point must hop
/// to the main queue first. No-op (no hop) when already on the main thread,
/// so synchronous handlers cannot deadlock.
pub(crate) fn run_on_main<T: Send + 'static, F: FnOnce() -> T + Send + 'static>(f: F) -> T {
    use objc2_foundation::NSThread;
    if NSThread::isMainThread_class() {
        return f();
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let mut slot = Some(f);
    let block = move || {
        let f = slot.take().expect("run_on_main block invoked twice");
        let _ = tx.send(f());
    };
    dispatch::Queue::main().exec_async(block);
    rx.recv().expect("main queue is not running")
}

// ---------------------------------------------------------------------------
// Attribute reading
// ---------------------------------------------------------------------------

/// Attributes rendered as rows in the detail panel (one IPC call each).
const DISPLAY_ATTRIBUTES: &[&str] = &[
    "AXRoleDescription",
    "AXSubrole",
    "AXTitle",
    "AXDescription",
    "AXValue",
    "AXHelp",
    "AXPlaceholderValue",
    "AXFocused",
    "AXEnabled",
    // Geometry — needed for window ops and hit-test math.
    "AXPosition",
    "AXSize",
    "AXWindowNumber",
];

/// Every attribute [`walk`] needs, read in one batched IPC round-trip via
/// [`copy_multiple_attributes`]. Failed reads come back `None` positionally.
/// (The detail-panel rows stay a contiguous slice so rendering is unchanged.)
const BATCH_ATTRIBUTES: &[&str] = &[
    "AXRole",
    "AXRoleDescription",
    "AXSubrole",
    "AXTitle",
    "AXDescription",
    "AXValue",
    "AXHelp",
    "AXPlaceholderValue",
    "AXFocused",
    "AXEnabled",
    "AXPosition",
    "AXSize",
    "AXWindowNumber",
    "AXChildren",
];

/// Indices into [`BATCH_ATTRIBUTES`].
const BATCH_ROLE: usize = 0;
const BATCH_DISPLAY_START: usize = 1; // BATCH_ATTRIBUTES[1..=12] = detail rows
const BATCH_TITLE: usize = 3;
const BATCH_DESCRIPTION: usize = 4;
const BATCH_CHILDREN: usize = 13;

/// Read one attribute of an element as a retained CFType. Returns `None` when
/// the attribute is unsupported, has no value, or is null.
///
/// # Errors
/// Returns the AXError for anything other than success / no-value /
/// attribute-unsupported, which callers usually want to surface.
pub(crate) fn copy_attribute(
    element: &AXUIElement,
    attribute: &str,
) -> Result<Option<CFRetained<CFType>>, AXError> {
    // Hop to the main thread: querying a WKWebView app from a background
    // thread crashes the whole process (WebKit main-thread-only guard).
    // AXUIElement is not Send, so cross the hop as a raw pointer. The
    // caller's reference stays alive for the duration of the synchronous
    // call (run_on_main blocks until the main thread returns). The result
    // crosses back as a plain pointer address (the +1 Copy-rule retain is
    // re-wrapped into CFRetained on this thread).
    let raw = element as *const AXUIElement as usize;
    let attribute = attribute.to_string();
    let ptr = run_on_main(move || unsafe {
        let element = &*(raw as *const AXUIElement);
        let name = CFString::from_str(&attribute);
        let mut raw_value: *const CFType = std::ptr::null();
        let err = element.copy_attribute_value(&name, NonNull::from(&mut raw_value));
        match err {
            AXError::Success if !raw_value.is_null() => Ok(Some(raw_value as usize)),
            AXError::Success => Ok(None), // success but null value
            AXError::NoValue | AXError::AttributeUnsupported => Ok(None),
            other => Err(other),
        }
    })?;
    // SAFETY: the pointer came from a Success copy (+1 retain, Copy rule) and
    // is handed to CFRetained::from_raw on this (original) thread.
    Ok(ptr.map(|p| unsafe { CFRetained::from_raw(NonNull::new_unchecked(p as *mut CFType)) }))
}

/// Read a string attribute, if present and of string type.
pub(crate) fn copy_string_attribute(element: &AXUIElement, attribute: &str) -> Option<String> {
    let value = copy_attribute(element, attribute).ok()??;
    value.downcast_ref::<CFString>().map(|s| s.to_string())
}

/// AXRole of the element that currently holds keyboard focus in `pid`'s app
/// ("" when there is no focus or the role is unknown).
///
/// Feeds the secure-field guard: typing into `AXSecureTextField` /
/// `AXPasswordField` must be refused — passwords and secrets are for the
/// human to type, never for synthetic input (dsh-computer-use parity).
pub(crate) fn focused_role(pid: i32) -> Result<String, String> {
    if !is_process_trusted(false) {
        return Err("未授予辅助功能权限 (Accessibility permission not granted)".to_string());
    }
    let app = unsafe { AXUIElement::new_application(pid) };
    let _ = unsafe { app.set_messaging_timeout(1.0) };
    let focused = copy_attribute(&app, "AXFocusedUIElement")
        .map_err(|e| format!("读取焦点元素失败: {}", ax_error_description(e)))?
        .ok_or_else(|| "当前没有焦点元素".to_string())?;
    let focused = focused
        .downcast_ref::<AXUIElement>()
        .ok_or_else(|| "焦点元素类型异常".to_string())?;
    Ok(copy_string_attribute(focused, "AXRole").unwrap_or_default())
}

/// Batch-read several attributes of one element in a **single** AX IPC
/// round-trip (the tree dumper reads 14 attributes per node; doing them one
/// call at a time dominates traversal latency on busy apps). `names` and the
/// returned vec align positionally; a failed or unsupported read yields
/// `None` (the API fills those slots with `kCFNull` when not StopOnError).
///
/// # Errors
/// Only for AX-level failures (element gone, messaging timeout) — callers
/// degrade by treating the whole batch as empty, which matches the old
/// per-attribute behavior where every read also failed.
pub(crate) fn copy_multiple_attributes(
    element: &AXUIElement,
    names: &[&str],
) -> Result<Vec<Option<CFRetained<CFType>>>, AXError> {
    // Main-thread hop (WebKit background-thread crash guard). AXUIElement is
    // not Send; cross the hop as a raw pointer (see copy_attribute). The batch
    // result also crosses as pointers: the array's +1 Copy-rule retain and
    // each element's +1 get-retain are re-wrapped into CFRetained here.
    let raw = element as *const AXUIElement as usize;
    let names: Vec<String> = names.iter().map(|n| (*n).to_string()).collect();
    let (array_ptr, items) = run_on_main(move || unsafe {
        let element = &*(raw as *const AXUIElement);
        let cfnames: Vec<CFRetained<CFString>> =
            names.iter().map(|n| CFString::from_str(n)).collect();
        let attributes = CFArray::from_retained_objects(&cfnames);
        let mut raw_array: *const CFArray = std::ptr::null();
        let err = element.copy_multiple_attribute_values(
            attributes.as_opaque(),
            objc2_application_services::AXCopyMultipleAttributeOptions(0), // options=0: fill every slot (kCFNull on failure)
            NonNull::from(&mut raw_array),
        );
        if err != AXError::Success || raw_array.is_null() {
            return Err(err);
        }
        // SAFETY: +1 retained CFArrayRef (Copy rule) on Success.
        let array = CFRetained::from_raw(NonNull::new_unchecked(raw_array as *mut CFArray));
        // SAFETY: every entry is a CFTypeRef (some may be kCFNull).
        let typed = array.cast_unchecked::<CFType>();
        let mut items = Vec::with_capacity(names.len());
        for i in 0..names.len() {
            // `get` retains each element (+1); kCFNull marks a failed read.
            // The retain is preserved for the re-wrap on this thread.
            match typed.get(i) {
                Some(item) if item.downcast_ref::<CFNull>().is_some() => items.push(None),
                Some(item) => {
                    let p = &*item as *const CFType as usize;
                    std::mem::forget(item); // keep the +1 retain
                    items.push(Some(p));
                }
                None => items.push(None),
            }
        }
        let array_ptr = &*array as *const CFArray as usize;
        std::mem::forget(array); // keep the +1 Copy-rule retain
        Ok((array_ptr, items))
    })?;

    // Re-wrap both retains on this thread; ownership is now exact again.
    let array = unsafe { CFRetained::from_raw(NonNull::new_unchecked(array_ptr as *mut CFArray)) };
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        match item {
            Some(p) => {
                // SAFETY: the pointer is a +1 get-retain preserved above; the
                // backing array is alive via `array`.
                out.push(Some(unsafe {
                    CFRetained::from_raw(NonNull::new_unchecked(p as *mut CFType))
                }));
            }
            None => out.push(None),
        }
    }
    drop(array);
    Ok(out)
}

/// Copy the list of actions this element supports (e.g. AXPress, AXIncrement).
pub(crate) fn copy_action_names(element: &AXUIElement) -> Vec<String> {
    // Main-thread hop (WebKit background-thread crash guard).
    let raw = element as *const AXUIElement as usize;
    run_on_main(move || unsafe {
        let element = &*(raw as *const AXUIElement);
        let mut raw_array: *const CFArray = std::ptr::null();
        let err = element.copy_action_names(NonNull::from(&mut raw_array));
        if err != AXError::Success || raw_array.is_null() {
            return Vec::new();
        }
        // SAFETY: +1 retained CFArrayRef (Copy rule), non-null on Success.
        let array = CFRetained::from_raw(NonNull::new_unchecked(raw_array as *mut CFArray));
        // Every entry of AXUIElementCopyActionNames is a CFString.
        let typed = array.cast_unchecked::<CFString>();
        typed.iter().map(|s| s.to_string()).collect()
    })
}

// ---------------------------------------------------------------------------
// Tree walking
// ---------------------------------------------------------------------------

/// Whether a display attribute of a secure-field element must be withheld.
/// Secure fields (password boxes) never leak their `AXValue` into the tree
/// (which is sent to the LLM / JSON export / session log); every other
/// attribute (title, help, placeholder, geometry) is kept so the element can
/// still be located and described.
fn should_skip_secure_value(role: &str, attr_name: &str) -> bool {
    crate::ax_act::is_secure_role(role) && attr_name == "AXValue"
}

/// Recursively walk the AX tree, bounded by `max_depth`.
fn walk(element: &AXUIElement, depth: usize, max_depth: usize) -> AxNode {
    // One batched IPC round-trip for every attribute the tree shows (was 14
    // separate calls per node). Batch failure (element gone / timeout) yields
    // an empty vec — every read degrades to None, same as the old per-read
    // failures.
    let values = copy_multiple_attributes(element, BATCH_ATTRIBUTES).unwrap_or_default();
    let string_at = |i: usize| -> Option<String> {
        values
            .get(i)
            .cloned()
            .flatten()
            .and_then(|v| v.downcast_ref::<CFString>().map(|s| s.to_string()))
    };

    let role = string_at(BATCH_ROLE).unwrap_or_default();
    let title = string_at(BATCH_TITLE);
    let description = string_at(BATCH_DESCRIPTION);

    // Read the remaining display attributes from the same batch.
    let mut attributes: Vec<AxAttr> = Vec::new();
    for (i, name) in DISPLAY_ATTRIBUTES.iter().enumerate() {
        if should_skip_secure_value(&role, name) {
            continue;
        }
        if let Some(Some(value)) = values.get(BATCH_DISPLAY_START + i) {
            if let Some(rendered) = cftype_to_string(value) {
                if !rendered.is_empty() {
                    attributes.push(AxAttr {
                        name: (*name).to_string(),
                        value: rendered,
                    });
                }
            }
        }
    }

    // Tree label: prefer a human-readable name, fall back to the role.
    let label = title
        .or_else(|| description.clone())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            attributes
                .iter()
                .find(|a| a.name == "AXRoleDescription")
                .map(|a| a.value.clone())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if role.is_empty() {
                "(未知)".to_string()
            } else {
                role.clone()
            }
        });

    let mut children = Vec::new();
    if depth < max_depth {
        if let Some(Some(value)) = values.get(BATCH_CHILDREN) {
            unsafe {
                if let Some(array) = value.downcast_ref::<CFArray>() {
                    // Every entry of AXChildren is an AXUIElement.
                    let typed = array.cast_unchecked::<AXUIElement>();
                    for child in typed.iter() {
                        children.push(walk(&child, depth + 1, max_depth));
                    }
                }
            }
        }
    }

    AxNode {
        label,
        role,
        depth,
        attributes,
        actions: copy_action_names(element),
        children,
    }
}

/// Build the AX tree for the application with the given pid.
///
/// # Errors
/// Returns a message if accessibility is not trusted or the first attribute
/// read fails (app quit, timeout, ...).
pub fn build_tree_for_pid(pid: i32, max_depth: usize) -> Result<AxNode, String> {
    if !is_process_trusted(false) {
        return Err("未授予辅助功能权限 (Accessibility permission not granted)".to_string());
    }
    unsafe {
        let app = AXUIElement::new_application(pid);
        // A short messaging timeout keeps the UI responsive when a target app
        // is busy; 2s is plenty for attribute reads.
        let _ = app.set_messaging_timeout(2.0);

        let mut child_pid: i32 = 0;
        let err = app.pid(NonNull::from(&mut child_pid));
        if err != AXError::Success {
            return Err(format!(
                "AXUIElementGetPid 失败: {} ({})",
                err.0,
                ax_error_description(err)
            ));
        }
        Ok(walk(&app, 0, max_depth))
    }
}

/// Parse `{x: 12.5, y: 34}` / `{x: ..., y: ..., w: ..., h: ...}` strings that
/// `cftype_to_string` produces for AXPosition / AXSize / AXFrame — used so the
/// JSON export and overlay can consume geometry as numbers.
fn parse_geometry(text: &str) -> Option<(f64, f64)> {
    let pick = |key: &str| -> Option<f64> {
        let marker = format!("{key}: ");
        let start = text.find(&marker)? + marker.len();
        let rest = &text[start..];
        let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))?;
        rest[..end].trim().parse::<f64>().ok()
    };
    Some((pick("x")?, pick("y")?))
}

/// Recursively build a machine-friendly tree with child-index paths.
fn walk_export(element: &AXUIElement, depth: usize, max_depth: usize, path: Vec<u32>) -> ExportNode {
    let role = copy_string_attribute(element, "AXRole").unwrap_or_default();
    // Never export the value of password/secure fields (same guarantee as
    // walk(): the export goes to the LLM / JSON / session log).
    let value = if should_skip_secure_value(&role, "AXValue") {
        None
    } else {
        copy_string_attribute(element, "AXValue")
    };
    // Reuse the same label rule as the display tree.
    let label = copy_string_attribute(element, "AXTitle")
        .or_else(|| copy_string_attribute(element, "AXDescription"))
        .filter(|s| !s.is_empty())
        .or_else(|| copy_string_attribute(element, "AXRoleDescription"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if role.is_empty() {
                "(未知)".to_string()
            } else {
                role.clone()
            }
        });

    let position = copy_attribute(element, "AXPosition")
        .ok()
        .flatten()
        .and_then(|v| cftype_to_string(&v))
        .and_then(|s| parse_geometry(&s));
    let size = copy_attribute(element, "AXSize")
        .ok()
        .flatten()
        .and_then(|v| cftype_to_string(&v))
        .and_then(|s| parse_geometry(&s));

    let mut children = Vec::new();
    if depth < max_depth {
        if let Ok(Some(cf_value)) = copy_attribute(element, "AXChildren") {
            unsafe {
                if let Some(array) = cf_value.downcast_ref::<CFArray>() {
                    let typed = array.cast_unchecked::<AXUIElement>();
                    for (i, child) in typed.iter().enumerate() {
                        let mut child_path = path.clone();
                        child_path.push(i as u32);
                        children.push(walk_export(&child, depth + 1, max_depth, child_path));
                    }
                }
            }
        }
    }

    ExportNode {
        path,
        role,
        label,
        value: value.unwrap_or_default(),
        position,
        size,
        actions: copy_action_names(element),
        children,
    }
}

/// Build a machine-friendly tree with child-index paths, for JSON export and
/// for feeding the LLM / overlay hit-test math.
///
/// # Errors
/// Same as [`build_tree_for_pid`].
pub fn build_tree_export(pid: i32, max_depth: usize) -> Result<ExportNode, String> {
    if !is_process_trusted(false) {
        return Err("未授予辅助功能权限 (Accessibility permission not granted)".to_string());
    }
    unsafe {
        let app = AXUIElement::new_application(pid);
        let _ = app.set_messaging_timeout(2.0);
        Ok(walk_export(&app, 0, max_depth, Vec::new()))
    }
}

/// Perform an action (e.g. "AXPress") on the element of the given app.
///
/// Note: AXUIElement handles cannot be persisted across calls, so the frontend
/// addresses elements by walking the tree with a path of child indices.
///
/// # Errors
/// Returns a message when accessibility is untrusted, the path is stale, or
/// the action fails.
pub fn perform_action_for_path(pid: i32, path: &[usize], action: &str) -> Result<(), String> {
    if !is_process_trusted(false) {
        return Err("未授予辅助功能权限 (Accessibility permission not granted)".to_string());
    }
    unsafe {
        let app = AXUIElement::new_application(pid);
        let _ = app.set_messaging_timeout(2.0);

        // Walk down the tree following the recorded child-index path.
        // (Clone retains the CFRetained, which is all we need here.)
        let mut element: CFRetained<AXUIElement> = app.clone();
        for &index in path {
            let value = copy_attribute(&element, "AXChildren")
                .map_err(|e| format!("读取 AXChildren 失败: {}", ax_error_description(e)))?
                .ok_or_else(|| "路径失效: AXChildren 不存在".to_string())?;
            let array = value
                .downcast_ref::<CFArray>()
                .ok_or_else(|| "路径失效: AXChildren 不是数组".to_string())?;
            let typed = array.cast_unchecked::<AXUIElement>();
            element = typed
                .get(index)
                .ok_or_else(|| format!("路径失效: 子索引 {index} 越界"))?;
        }

        // Main-thread hop (WebKit background-thread crash guard). `element`
        // is not Send; cross the hop as a raw pointer (it stays alive here).
        let raw = &*element as *const AXUIElement as usize;
        let action = action.to_string();
        run_on_main(move || {
            let name = CFString::from_str(&action);
            // SAFETY (performed within the enclosing unsafe block): element
            // pointer is valid for the duration of the call.
            let err = (&*(raw as *const AXUIElement)).perform_action(&name);
            if err == AXError::Success {
                Ok(())
            } else {
                Err(format!(
                    "执行 {action} 失败: {} ({})",
                    err.0,
                    ax_error_description(err)
                ))
            }
        })
    }
}

/// Does `node` match a relocation hint (role exact, label case-insensitive
/// substring; empty label matches any)? Used by [`find_path_by_hint`] and kept
/// as a pure function so the matching rule is unit-testable.
fn node_matches_hint(node: &AxNode, role: &str, label: &str) -> bool {
    if node.role != role {
        return false;
    }
    let label = label.trim().to_lowercase();
    label.is_empty() || node.label.to_lowercase().contains(&label)
}

/// Depth-first search for the first node matching `role` + `label`, recording
/// the child-index path along the way. Module-level so the matching order is
/// unit-testable.
fn search_by_hint(
    node: &AxNode,
    path: &mut Vec<usize>,
    role: &str,
    label: &str,
) -> Option<Vec<usize>> {
    if node_matches_hint(node, role, label) {
        return Some(path.clone());
    }
    for (i, child) in node.children.iter().enumerate() {
        path.push(i);
        if let Some(found) = search_by_hint(child, path, role, label) {
            return Some(found);
        }
        path.pop();
    }
    None
}

/// Re-locate an element whose child-index path has gone stale (UI changed
/// after the tree dump): walks the tree at the same bounded depth as
/// [`build_tree_for_pid`]'s default and returns the fresh path of the first
/// node matching `role` (exact) + `label` (substring, case-insensitive).
///
/// # Errors
/// Untrusted process, tree read failure, or no matching element.
pub fn find_path_by_hint(pid: i32, role: &str, label: &str) -> Result<Vec<usize>, String> {
    let root = build_tree_for_pid(pid, 8)?;
    let mut path = Vec::new();
    search_by_hint(&root, &mut path, role, label)
        .ok_or_else(|| format!("自动重定位失败: 未找到 role={role} label={label} 的元素"))
}

#[cfg(test)]
mod relocate_hint_tests {
    use super::*;

    fn node(role: &str, label: &str, children: Vec<AxNode>) -> AxNode {
        AxNode {
            label: label.to_string(),
            role: role.to_string(),
            depth: 0,
            attributes: Vec::new(),
            actions: Vec::new(),
            children,
        }
    }

    #[test]
    fn matches_exact_role_and_substring_label() {
        let n = node("AXButton", "Save File", Vec::new());
        assert!(node_matches_hint(&n, "AXButton", "save"));
        assert!(node_matches_hint(&n, "AXButton", "SAVE"));
        assert!(node_matches_hint(&n, "AXButton", ""));
        assert!(!node_matches_hint(&n, "AXTextField", "save"));
        assert!(!node_matches_hint(&n, "AXButton", "delete"));
    }

    #[test]
    fn search_finds_first_depth_first_match() {
        let tree = node(
            "AXApplication",
            "App",
            vec![
                node("AXWindow", "Main", vec![node("AXButton", "OK", Vec::new())]),
                node("AXWindow", "Other", vec![node("AXButton", "OK", Vec::new())]),
            ],
        );
        let mut path = Vec::new();
        let found = search_by_hint(&tree, &mut path, "AXButton", "OK");
        // First depth-first match: window 0 → button 0.
        assert_eq!(found, Some(vec![0, 0]));
    }
}

#[cfg(test)]
mod secure_value_tests {
    use super::should_skip_secure_value;

    #[test]
    fn secure_field_values_are_withheld() {
        assert!(should_skip_secure_value("AXPasswordField", "AXValue"));
        assert!(should_skip_secure_value("AXSecureTextField", "AXValue"));
    }

    #[test]
    fn non_secure_roles_keep_their_value() {
        assert!(!should_skip_secure_value("AXTextField", "AXValue"));
        assert!(!should_skip_secure_value("AXTextArea", "AXValue"));
        assert!(!should_skip_secure_value("", "AXValue"));
        assert!(!should_skip_secure_value("AXStaticText", "AXValue"));
    }

    #[test]
    fn secure_fields_keep_other_attributes() {
        // Title / help / geometry stay visible so the element can still be
        // located and described — only the value is withheld.
        assert!(!should_skip_secure_value("AXPasswordField", "AXTitle"));
        assert!(!should_skip_secure_value("AXPasswordField", "AXHelp"));
        assert!(!should_skip_secure_value("AXPasswordField", "AXPosition"));
        assert!(!should_skip_secure_value("AXSecureTextField", "AXDescription"));
    }
}
