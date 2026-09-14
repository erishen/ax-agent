//! Actuation primitives for computer use, layered on top of the read-only
//! inspection in [`crate::ax_core`].
//!
//! Three ways to drive a target app, in increasing invasiveness:
//!
//! 1. **Semantic** — `AXUIElementPerformAction` (`AXPress`, `AXIncrement`, …)
//!    and `AXUIElementSetAttributeValue` (set `AXValue` on a text field, grab
//!    keyboard focus via `AXFocused`, move windows via `AXPosition`). Works
//!    even when the element is off-screen or occluded; no synthetic events.
//! 2. **Positional** — `AXUIElementCopyElementAtPosition` on the *system-wide*
//!    element: "which UI element is under this screen point". This is the
//!    primitive a computer-use agent uses to turn a click target into an
//!    inspectable/actable element.
//! 3. **Synthetic** — CGEvent scroll-wheel / mouse / keyboard events, which
//!    most apps expose no AX element/action for (long chat/contact lists,
//!    canvas widgets, keyboard shortcuts).

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::mpsc::{channel, Receiver, Sender, RecvTimeoutError};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex};

use objc2_application_services::{AXError, AXObserver, AXUIElement, AXValue, AXValueType};
use objc2_core_foundation::{
    CFArray, CFBoolean, CFEqual, CFRetained, CFRunLoop, CFString, CFType, CGPoint,
};
use objc2_core_foundation::Type as _; // retain() on CF references
use serde::Serialize;

use crate::ax_core::{
    ax_error_description, copy_attribute, copy_string_attribute, is_process_trusted,
};

// ---------------------------------------------------------------------------
// Change signalling: a best-effort `AXObserver` on the target app plus an
// atomic trigger counter bumped by synthetic events. The agent's settle step
// waits for a real notification (or the counter to move), never sleeps blind.
// ---------------------------------------------------------------------------

/// Bumped by every synthetic event (mouse/keyboard/menu-press). `u32::MAX` is
/// reserved as the "observer dead" marker (see `mark_observer_dead`).
pub(crate) static LAST_TRIGGER_BUMP: AtomicU32 = AtomicU32::new(0);

/// Channels for AXObserver notifications: one global sender kept in the static
/// tuple; waiters take turns receiving on the shared receiver.
static CHANGE: LazyLock<(Sender<i32>, Mutex<Option<Receiver<i32>>>)> = LazyLock::new(|| {
    let (tx, rx) = channel::<i32>();
    (tx, Mutex::new(Some(rx)))
});

/// The registered observer, kept alive for the process lifetime. Stored as a
/// raw pointer (the retained `CFTypeRef` we own, as an address-sized integer
/// so the static stays `Send`); never dereferenced after registration.
static OBSERVER: LazyLock<Mutex<Option<usize>>> = LazyLock::new(|| Mutex::new(None));

/// Set once `AXObserverCreate` reports an environment where observers don't
/// work (older macOS / missing feature); from then on we only poll.
static OBSERVER_DEAD: AtomicBool = AtomicBool::new(false);

/// AXObserver callback: ping any active change waiter.
///
/// # Safety
/// Signature must match `AXObserverCallback` exactly; the Context points are
/// managed by AppKit/ApplicationServices and only passed through.
unsafe extern "C-unwind" fn on_ax_change(
    _observer: NonNull<AXObserver>,
    _element: NonNull<AXUIElement>,
    _notification: NonNull<CFString>,
    _refcon: *mut c_void,
) {
    let _ = (*CHANGE).0.send(1);
}

/// Return the value of the trigger counter.
pub(crate) fn last_trigger_bump() -> u32 {
    LAST_TRIGGER_BUMP.load(Ordering::SeqCst)
}

/// Bump the global trigger counter (called from every synthetic-event path).
pub(crate) fn bump_trigger() -> Result<(), String> {
    LAST_TRIGGER_BUMP.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

/// Return whether the trigger counter changed since `since`.
pub(crate) fn has_bumped_since(since: u32) -> bool {
    LAST_TRIGGER_BUMP.load(Ordering::SeqCst) != since
}

/// Mark the observer path dead (fall back to polling permanently).
fn mark_observer_dead() {
    OBSERVER_DEAD.store(true, Ordering::SeqCst);
    LAST_TRIGGER_BUMP.store(u32::MAX, Ordering::SeqCst);
}

/// Whether the observer path has been abandoned.
pub(crate) fn observer_dead() -> bool {
    OBSERVER_DEAD.load(Ordering::SeqCst)
}

/// Best-effort: register an `AXObserver` on `pid` so a later
/// [`wait_for_change`] can wake on real UI changes instead of polling.
///
/// # Errors
/// Returns a message when the observer can't be created (environments where
/// `AXObserver` isn't available), after which the code falls back to polling.
pub(crate) fn register_for_pid(pid: i32) -> Result<(), String> {
    if observer_dead() {
        return Err("AXObserver 已标记死亡，不再尝试注册".to_string());
    }
    if OBSERVER.lock().unwrap().is_some() {
        return Ok(());
    }
    unsafe {
        let mut raw: *mut AXObserver = std::ptr::null_mut();
        let err = AXObserver::create(
            pid,
            Some(on_ax_change),
            NonNull::new(&mut raw).expect("raw *mut AXObserver 始终非空"),
        );
        if err != AXError::Success {
            mark_observer_dead();
            return Err(format!(
                "AXObserver::create 失败: {} ({})",
                err.0,
                ax_error_description(err)
            ));
        }
        let observer = CFRetained::from_raw(NonNull::new_unchecked(raw));

        // Watch the app root for structural/focus changes. The observer is a
        // push source; waiters still time out and poll as a safety net.
        let app = AXUIElement::new_application(pid);
        let _ = app.set_messaging_timeout(2.0);
        for notification in [
            "AXUIElementDestroyedNotification",
            "AXWindowCreatedNotification",
            "AXFocusedUIElementChangedNotification",
            "AXValueChangedNotification",
        ] {
            let name = CFString::from_str(notification);
            let _ = observer.add_notification(&app, &name, std::ptr::null_mut());
        }

        // Attach the observer's run loop source so notifications actually
        // reach us. Tauri runs on the main thread's run loop.
        let source = observer.run_loop_source();
        if let Some(rl) = CFRunLoop::main() {
            rl.add_source(Some(&source), objc2_core_foundation::kCFRunLoopDefaultMode);
        }

        // Keep the observer alive for the rest of the process: store its
        // pointer and deliberately leak the +1 retain (the main run loop
        // retains the source, so notifications keep flowing).
        *OBSERVER.lock().unwrap() = Some((&*observer) as *const AXObserver as usize);
        std::mem::forget(observer);
        Ok(())
    }
}

/// Drop the registered observer (best-effort).
pub(crate) fn unregister_for_pid(_pid: i32) {
    *OBSERVER.lock().unwrap() = None;
}

/// Wait up to `timeout_secs` for a real UI change notification. Returns `Ok`
/// on a notification *or* on timeout — the caller re-reads the tree either
/// way, and a timeout means "nothing changed, safe to poll".
///
/// # Errors
/// Returns a message when the observer path is dead or the channel closed;
/// callers then fall back to polling.
pub(crate) fn wait_for_change(timeout_secs: u64) -> Result<(), String> {
    if observer_dead() {
        return Err("AXObserver 已标记死亡，走轮询路径".to_string());
    }
    let guard = CHANGE.1.lock().unwrap();
    let Some(rx) = guard.as_ref() else {
        return Err("通知通道缺失".to_string());
    };
    match rx.recv_timeout(std::time::Duration::from_secs(timeout_secs)) {
        Ok(_) => Ok(()),
        Err(RecvTimeoutError::Disconnected) => Err("通知通道已关闭".to_string()),
        Err(RecvTimeoutError::Timeout) => Ok(()), // timeout → caller polls
    }
}

// ---------------------------------------------------------------------------
// Path addressing (same convention as ax_core::perform_action_for_path)
// ---------------------------------------------------------------------------

/// Resolve the element addressed by a child-index path under the app root.
///
/// # Errors
/// Untrusted process, stale path, or an AX messaging failure.
fn element_at_path(pid: i32, path: &[usize]) -> Result<CFRetained<AXUIElement>, String> {
    if !is_process_trusted(false) {
        return Err("未授予辅助功能权限 (Accessibility permission not granted)".to_string());
    }
    unsafe {
        let app = AXUIElement::new_application(pid);
        let _ = app.set_messaging_timeout(2.0);

        let mut element = app.clone();
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
        Ok(element)
    }
}

/// Generic `AXUIElementSetAttributeValue` over a path. All CF types we set
/// (CFString / CFBoolean / AXValue) implement `AsRef<CFType>`.
unsafe fn set_attribute<T: AsRef<CFType>>(
    element: &AXUIElement,
    attribute: &str,
    value: &T,
) -> Result<(), String> {
    let name = CFString::from_str(attribute);
    // SAFETY: `value` really is of the type the caller chose for this
    // attribute (AXValue←CFString, AXFocused←CFBoolean, AXPosition←AXValue).
    let err = element.set_attribute_value(&name, value.as_ref());
    if err == AXError::Success {
        Ok(())
    } else {
        Err(format!(
            "设置 {attribute} 失败: {} ({})",
            err.0,
            ax_error_description(err)
        ))
    }
}

/// Read one display attribute of the element addressed by `path`
/// (e.g. `AXValue`, `AXPosition`, `AXTitle`). Returns `None` when the
/// attribute is unsupported or has no value — the same rendering as the tree
/// dumper, without a full re-walk. Used for action post-verification and
/// undo snapshots.
///
/// # Errors
/// Untrusted process or stale path.
pub fn read_attribute_for_path(
    pid: i32,
    path: &[usize],
    attr: &str,
) -> Result<Option<String>, String> {
    let element = element_at_path(pid, path)?;
    copy_attribute(&element, attr)
        .map(|value| value.and_then(|v| crate::ax_core::cftype_to_string(&v)))
        .map_err(|e| format!("读取 {attr} 失败: {}", ax_error_description(e)))
}

/// Check `AXUIElementIsAttributeSettable`; `Ok(false)`-style info is folded
/// into a friendly message by the caller.
fn is_settable(element: &AXUIElement, attribute: &str) -> Option<bool> {
    unsafe {
        let name = CFString::from_str(attribute);
        let mut settable: u8 = 0;
        let err = element.is_attribute_settable(&name, NonNull::from(&mut settable));
        if err == AXError::Success {
            Some(settable != 0)
        } else {
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Semantic writes
// ---------------------------------------------------------------------------

/// Set the text content of an element (`AXValue`) — the "type into this field"
/// primitive. Works on text fields / areas that expose a settable AXValue.
///
/// # Errors
/// Untrusted process, stale path, or the attribute is missing/not settable.
pub fn set_value_for_path(pid: i32, path: &[usize], text: &str) -> Result<(), String> {
    let element = element_at_path(pid, path)?;
    if is_settable(&element, "AXValue") == Some(false) {
        return Err("该元素的 AXValue 不可写 (AXValue is not settable)".to_string());
    }
    let value = CFString::from_str(text);
    // SAFETY: AXValue of a text element takes a CFString.
    unsafe { set_attribute(&element, "AXValue", &value) }
}

/// Move an element (typically a window) by setting its `AXPosition`.
///
/// # Errors
/// Untrusted process, stale path, or AXPosition unsupported.
pub fn set_position_for_path(pid: i32, path: &[usize], x: f64, y: f64) -> Result<(), String> {
    let element = element_at_path(pid, path)?;
    unsafe {
        let point = CGPoint { x, y };
        let Some(value) = AXValue::new(AXValueType::CGPoint, NonNull::from(&point).cast()) else {
            return Err("AXValue::new(CGPoint) 返回空".to_string());
        };
        // SAFETY: AXPosition takes a CGPoint-typed AXValue.
        let result = set_attribute(&element, "AXPosition", &*value);
        drop(value);
        result
    }
}

/// Grab keyboard focus by setting `AXFocused = true`.
///
/// # Errors
/// Untrusted process, stale path, or the element cannot take focus.
pub fn focus_element_for_path(pid: i32, path: &[usize]) -> Result<(), String> {
    let element = element_at_path(pid, path)?;
    if is_settable(&element, "AXFocused") == Some(false) {
        return Err("该元素不支持聚焦 (AXFocused is not settable)".to_string());
    }
    // SAFETY: AXFocused takes a CFBoolean.
    unsafe { set_attribute(&element, "AXFocused", CFBoolean::new(true)) }
}

/// Perform an arbitrary **named** AX action (anything the element lists in
/// its `AXActionNames`): `AXPress`, `AXIncrement`, `AXDecrement`, `AXPick`,
/// `AXShowMenu`, `AXConfirm`, `AXCancel`, … This is the general form of the
/// click helper (which always uses the element's first action).
///
/// # Errors
/// Untrusted process, stale path, or `AXError::ActionUnsupported` when the
/// element does not implement the action.
pub fn named_action_for_path(pid: i32, path: &[usize], action: &str) -> Result<(), String> {
    let element = element_at_path(pid, path)?;
    unsafe {
        let name = CFString::from_str(action);
        let err = element.perform_action(&name);
        if err == AXError::Success {
            Ok(())
        } else {
            Err(format!(
                "执行 {action} 失败: {} ({})",
                err.0,
                ax_error_description(err)
            ))
        }
    }
}

// ---------------------------------------------------------------------------
// Synthetic scroll (CGEvent scroll wheel)
// ---------------------------------------------------------------------------

/// Scroll the element under a *global* screen point with a synthetic
/// scroll-wheel event (CGEvent, `kCGScrollEventUnitLine`), e.g. to move a
/// long WeChat/Notes list that exposes no AX scroll action.
///
/// `lines > 0` scrolls up (content moves down, like a wheel away from you);
/// `lines < 0` scrolls down. Most apps interpret one line ≈ one notch; a
/// larger magnitude scrolls faster. Events post to the HID tap (whatever is
/// under `x, y`) unless `target` pid is given, in which case they go straight
/// to that app.
///
/// # Errors
/// Untrusted for accessibility (posting HID events needs the same grant),
/// or the CG event could not be created.
pub fn scroll_at_position(x: f64, y: f64, lines: f64, target: Option<i32>) -> Result<(), String> {
    use core_graphics::event::{CGEvent, ScrollEventUnit};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use core_graphics::geometry::CGPoint as CGCGPoint;

    if !is_process_trusted(false) {
        return Err("未授予辅助功能权限 (Accessibility permission not granted)".to_string());
    }

    bump_trigger()?;

    // Notches of the virtual wheel; magnitude rounds like a physical wheel.
    let notches = lines.round().clamp(-100.0, 100.0) as i32;
    if notches == 0 {
        return Err("滚动量太小（取整后为 0），请给更大的数值".to_string());
    }

    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| "CGEventSource 创建失败".to_string())?;
    // wheel1 = vertical axis; positive = scroll up (wheel away from user).
    let event = CGEvent::new_scroll_event(source, ScrollEventUnit::LINE, 1, notches, 0, 0)
        .map_err(|_| "滚动事件创建失败".to_string())?;
    event.set_location(CGCGPoint { x, y });
    post_event(&event, target);
    Ok(())
}

/// Ask an app to scroll the element addressed by `path` into view via the
/// semantic `AXScrollToVisible` action (no synthetic events; works for
/// off-screen elements inside scrollable containers that support it).
///
/// # Errors
/// Untrusted process, stale path, or the element/container does not support
/// `AXScrollToVisible` (common — fall back to [`scroll_at_position`]).
pub fn scroll_to_visible_for_path(pid: i32, path: &[usize]) -> Result<(), String> {
    named_action_for_path(pid, path, "AXScrollToVisible")
}

// ---------------------------------------------------------------------------
// Synthetic keyboard (CGEvent) — for key-driven UI the app exposes no AX
// write path for: Enter to send, Escape to dismiss, Cmd+F to search, arrow
// navigation in custom list widgets, per-key IME-triggering input.
// ---------------------------------------------------------------------------

use core_graphics::event::CGKeyCode;

/// Virtual keycodes for names the model may use. Physical-key codes (ANSI_*)
/// work on ANSI layouts; special keys are layout-independent.
fn keycode_for_name(name: &str) -> Option<CGKeyCode> {
    use core_graphics::event::KeyCode;
    Some(match name.to_ascii_lowercase().as_str() {
        // Special keys (layout-independent).
        "enter" | "return" => KeyCode::RETURN,
        "tab" => KeyCode::TAB,
        "space" => KeyCode::SPACE,
        "delete" | "backspace" => KeyCode::DELETE,
        "escape" | "esc" => KeyCode::ESCAPE,
        "up" | "uparrow" | "arrowup" => KeyCode::UP_ARROW,
        "down" | "downarrow" | "arrowdown" => KeyCode::DOWN_ARROW,
        "left" | "leftarrow" | "arrowleft" => KeyCode::LEFT_ARROW,
        "right" | "rightarrow" | "arrowright" => KeyCode::RIGHT_ARROW,
        // Punctuation at ANSI positions.
        "-" | "minus" => KeyCode::ANSI_MINUS,
        "=" | "equal" => KeyCode::ANSI_EQUAL,
        "." | "period" => KeyCode::ANSI_PERIOD,
        "," | "comma" => KeyCode::ANSI_COMMA,
        "/" | "slash" => KeyCode::ANSI_SLASH,
        // Letters/numbers via physical ANSI positions — with the Unicode
        // string override below they type correctly on any layout.
        s if s.chars().count() == 1 => {
            let c = s.chars().next()?;
            if let Some(kc) = ansi_keycode(c) {
                kc
            } else {
                return None;
            }
        }
        _ => return None,
    })
}

fn ansi_keycode(c: char) -> Option<CGKeyCode> {
    use core_graphics::event::KeyCode;
    Some(match c {
        'a' => KeyCode::ANSI_A,
        'b' => KeyCode::ANSI_B,
        'c' => KeyCode::ANSI_C,
        'd' => KeyCode::ANSI_D,
        'e' => KeyCode::ANSI_E,
        'f' => KeyCode::ANSI_F,
        'g' => KeyCode::ANSI_G,
        'h' => KeyCode::ANSI_H,
        'i' => KeyCode::ANSI_I,
        'j' => KeyCode::ANSI_J,
        'k' => KeyCode::ANSI_K,
        'l' => KeyCode::ANSI_L,
        'm' => KeyCode::ANSI_M,
        'n' => KeyCode::ANSI_N,
        'o' => KeyCode::ANSI_O,
        'p' => KeyCode::ANSI_P,
        'q' => KeyCode::ANSI_Q,
        'r' => KeyCode::ANSI_R,
        's' => KeyCode::ANSI_S,
        't' => KeyCode::ANSI_T,
        'u' => KeyCode::ANSI_U,
        'v' => KeyCode::ANSI_V,
        'w' => KeyCode::ANSI_W,
        'x' => KeyCode::ANSI_X,
        'y' => KeyCode::ANSI_Y,
        'z' => KeyCode::ANSI_Z,
        '0' => KeyCode::ANSI_0,
        '1' => KeyCode::ANSI_1,
        '2' => KeyCode::ANSI_2,
        '3' => KeyCode::ANSI_3,
        '4' => KeyCode::ANSI_4,
        '5' => KeyCode::ANSI_5,
        '6' => KeyCode::ANSI_6,
        '7' => KeyCode::ANSI_7,
        '8' => KeyCode::ANSI_8,
        '9' => KeyCode::ANSI_9,
        _ => return None,
    })
}

/// Send a created event — to a target pid when given (CGEventPostToPid,
/// delivered to that process regardless of foreground), otherwise to the HID
/// tap (which routes to whatever has keyboard/mouse focus).
fn post_event(event: &CGEvent, target: Option<i32>) {
    match target {
        Some(pid) => event.post_to_pid(pid),
        None => event.post(CGEventTapLocation::HID),
    }
}

/// Post a key-down/key-up pair for `keycode` with the given modifier flags
/// (use `CGEventFlags::CGEventFlagNull` for no modifiers).
fn post_key_tap(
    keycode: CGKeyCode,
    flags: core_graphics::event::CGEventFlags,
    target: Option<i32>,
) -> Result<(), String> {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| "CGEventSource 创建失败".to_string())?;
    for is_down in [true, false] {
        let event =
            CGEvent::new_keyboard_event(source.clone(), keycode, is_down).map_err(|_| "键盘事件创建失败".to_string())?;
        event.set_flags(flags);
        post_event(&event, target);
    }
    Ok(())
}

/// Press a key or shortcut: `"enter"`, `"esc"`, `"Cmd+F"`, `"Cmd+Shift+T"`,
/// `"Alt+Left"`. Modifier names (any case, `+`/`-` separated): cmd/⌘/command,
/// ctrl/⌃/control, alt/⌥/option, shift/⇧; the remaining token is the key.
///
/// Synthetic keyboard events require the same Accessibility grant as the AX
/// writes (posting at the HID tap, so they go to whatever has focus).
///
/// # Errors
/// Untrusted process, or an unknown key/modifier name.
pub fn press_key_combo(combo: &str, target: Option<i32>) -> Result<(), String> {
    use core_graphics::event::CGEventFlags;

    if !is_process_trusted(false) {
        return Err("未授予辅助功能权限 (Accessibility permission not granted)".to_string());
    }
    bump_trigger()?;

    let mut flags = CGEventFlags::CGEventFlagNull;
    let mut key_name: Option<String> = None;
    for token in combo.split(['+', '-']).map(str::trim).filter(|t| !t.is_empty()) {
        let lower = token.to_ascii_lowercase();
        match lower.as_str() {
            "cmd" | "command" | "⌘" => flags |= CGEventFlags::CGEventFlagCommand,
            "ctrl" | "control" | "⌃" => flags |= CGEventFlags::CGEventFlagControl,
            "alt" | "option" | "opt" | "⌥" => flags |= CGEventFlags::CGEventFlagAlternate,
            "shift" | "⇧" => flags |= CGEventFlags::CGEventFlagShift,
            _ => {
                if key_name.is_some() {
                    return Err(format!("组合键里有多个非修饰键: {combo}"));
                }
                key_name = Some(lower);
            }
        }
    }
    let key = key_name.ok_or_else(|| format!("组合键缺少主键: {combo}"))?;
    let keycode = keycode_for_name(&key).ok_or_else(|| {
        format!("不认识的按键「{key}」（支持 enter/tab/space/delete/esc/方向键/字母/数字/常用标点）")
    })?;
    post_key_tap(keycode, flags, target)?;
    Ok(())
}

/// Type `text` as a burst of synthetic keyboard events (per-key, with the
/// Unicode string override on each so Chinese/emoji type correctly and IME
/// composition fires like real input).
///
/// When to use instead of the semantic AXValue write (`ax_set_value`):
/// the target only reacts to real keystrokes (search-as-you-type, auto-
/// completing comboboxes, chat inputs with send-on-enter), the field must be
/// *appended to* rather than replaced, or AXValue is not settable.
///
/// Each character becomes its own key-down/key-up pair carrying the character
/// as its Unicode payload; key events go to the focused element, so focus the
/// field first (`ax_focus_element` / a click).
///
/// # Errors
/// Untrusted process, or the text is empty.
pub fn type_text_synthetic(text: &str, target: Option<i32>) -> Result<(), String> {
    use core_graphics::event::{CGEvent, CGEventFlags};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    if !is_process_trusted(false) {
        return Err("未授予辅助功能权限 (Accessibility permission not granted)".to_string());
    }
    if text.is_empty() {
        return Err("文本为空".to_string());
    }

    bump_trigger()?;
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| "CGEventSource 创建失败".to_string())?;

    // Chars with no virtual keycode of their own (中文, emoji, …) still type:
    // we post a neutral keycode carrying the Unicode payload.
    const NEUTRAL_KEYCODE: CGKeyCode = 0;
    let mut payload_buf = [0u16; 2];
    for ch in text.chars() {
        let payload = ch.encode_utf16(&mut payload_buf);
        for is_down in [true, false] {
            let event = CGEvent::new_keyboard_event(source.clone(), NEUTRAL_KEYCODE, is_down)
                .map_err(|_| "键盘事件创建失败".to_string())?;
            event.set_string_from_utf16_unchecked(payload);
            event.set_flags(CGEventFlags::CGEventFlagNonCoalesced);
            post_event(&event, target);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Synthetic mouse (CGEvent) — for custom-drawn widgets that expose neither
// AX actions nor hit-testable elements: canvas strokes, map panning, drag
// handles, games, embedded web views. Everything AX can't see.
// ---------------------------------------------------------------------------

use core_graphics::event::{CGEvent, CGEventTapLocation, CGEventType, CGMouseButton};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint as CGCGPoint;

/// Post one mouse event of `event_type` at `(x, y)` with `click_state`
/// (1 = single, 2 = double). Button is ignored for MouseMoved.
fn post_mouse_event(
    source: &core_graphics::event_source::CGEventSource,
    event_type: CGEventType,
    x: f64,
    y: f64,
    click_state: i64,
    button: CGMouseButton,
    target: Option<i32>,
) -> Result<(), String> {
    let event = CGEvent::new_mouse_event(source.clone(), event_type, CGCGPoint { x, y }, button)
        .map_err(|_| "鼠标事件创建失败".to_string())?;
    event.set_integer_value_field(
        core_graphics::event::EventField::MOUSE_EVENT_CLICK_STATE,
        click_state,
    );
    post_event(&event, target);
    Ok(())
}

fn mouse_event_source() -> Result<core_graphics::event_source::CGEventSource, String> {
    if !is_process_trusted(false) {
        return Err("未授予辅助功能权限 (Accessibility permission not granted)".to_string());
    }
    CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| "CGEventSource 创建失败".to_string())
}

/// Click (left, single) at a global screen point: move → down → up.
/// Use for widgets with no AX element at all (the click lands on whatever is
/// rendered there — verify intent with `element_at` first when in doubt).
///
/// `target` (session app pid) delivers the events straight to that process via
/// CGEventPostToPid — works even when the app is not frontmost. When `None`,
/// events go to the HID tap (whatever is under the cursor, usually the
/// frontmost app).
///
/// # Errors
/// Untrusted process, or the CG event could not be created.
pub fn click_at_position(x: f64, y: f64, target: Option<i32>) -> Result<(), String> {
    let source = mouse_event_source()?;
    post_mouse_event(&source, CGEventType::MouseMoved, x, y, 0, CGMouseButton::Left, target)?;
    post_mouse_event(&source, CGEventType::LeftMouseDown, x, y, 1, CGMouseButton::Left, target)?;
    post_mouse_event(&source, CGEventType::LeftMouseUp, x, y, 1, CGMouseButton::Left, target)?;
    Ok(())
}

/// Double-click at a global screen point (click_state 2 down/up pairs).
///
/// # Errors
/// Untrusted process, or the CG event could not be created.
pub fn double_click_at_position(x: f64, y: f64, target: Option<i32>) -> Result<(), String> {
    let source = mouse_event_source()?;
    post_mouse_event(&source, CGEventType::MouseMoved, x, y, 0, CGMouseButton::Left, target)?;
    for state in [1, 2] {
        post_mouse_event(&source, CGEventType::LeftMouseDown, x, y, state, CGMouseButton::Left, target)?;
        post_mouse_event(&source, CGEventType::LeftMouseUp, x, y, state, CGMouseButton::Left, target)?;
    }
    Ok(())
}

/// Right-click at a global screen point (context menu).
///
/// # Errors
/// Untrusted process, or the CG event could not be created.
pub fn right_click_at_position(x: f64, y: f64, target: Option<i32>) -> Result<(), String> {
    let source = mouse_event_source()?;
    post_mouse_event(&source, CGEventType::MouseMoved, x, y, 0, CGMouseButton::Right, target)?;
    post_mouse_event(&source, CGEventType::RightMouseDown, x, y, 1, CGMouseButton::Right, target)?;
    post_mouse_event(&source, CGEventType::RightMouseUp, x, y, 1, CGMouseButton::Right, target)?;
    Ok(())
}

/// Drag from `(from_x, from_y)` to `(to_x, to_y)` in `steps` interpolated
/// MouseMoved→LeftMouseDragged hops (default 12): left-press at the start,
/// drag through intermediate points so apps see real movement (picking a
/// single jump-to-end event loses rubber-band feedback), release at the end.
///
/// # Errors
/// Untrusted process, invalid step count, or the CG event could not be
/// created.
pub fn drag(
    from_x: f64,
    from_y: f64,
    to_x: f64,
    to_y: f64,
    steps: u32,
    target: Option<i32>,
) -> Result<(), String> {
    let steps = steps.clamp(2, 120);
    let source = mouse_event_source()?;

    post_mouse_event(&source, CGEventType::MouseMoved, from_x, from_y, 0, CGMouseButton::Left, target)?;
    post_mouse_event(&source, CGEventType::LeftMouseDown, from_x, from_y, 1, CGMouseButton::Left, target)?;

    let dx = (to_x - from_x) / f64::from(steps);
    let dy = (to_y - from_y) / f64::from(steps);
    for i in 1..=steps {
        let x = from_x + dx * f64::from(i);
        let y = from_y + dy * f64::from(i);
        post_mouse_event(&source, CGEventType::LeftMouseDragged, x, y, 1, CGMouseButton::Left, target)?;
        // ~120 Hz pacing so fast handlers don't coalesce the path away.
        std::thread::sleep(std::time::Duration::from_micros(8_000));
    }

    post_mouse_event(&source, CGEventType::LeftMouseUp, to_x, to_y, 1, CGMouseButton::Left, target)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Menu bar (AXMenuBar) — path-addressed so the frontend can AXPress any
// entry with the existing perform_action_for_path.
// ---------------------------------------------------------------------------

/// One menu-bar / menu entry, addressed by its child-index path from the app
/// root (so the frontend can press it via `perform_action_for_path`).
#[derive(Debug, Clone, Serialize)]
pub struct MenuEntry {
    /// AXTitle (localized, e.g. 文件 / 新建窗口).
    pub title: String,
    /// AXRole of the node (AXMenuBarItem / AXMenuItem / AXMenu / …).
    pub role: String,
    /// Child-index path from the app root to this node.
    pub path: Vec<usize>,
    /// Actions this entry supports (usually AXPress).
    pub actions: Vec<String>,
    /// Submenu entries (one level below), if any.
    pub children: Vec<MenuEntry>,
}

/// The pid of the frontmost GUI application (menu bar target by default).
#[must_use]
pub fn frontmost_pid() -> Option<i32> {
    use objc2_app_kit::NSWorkspace;
    NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .map(|a| a.processIdentifier())
}

/// Recursively walk the menu tree from `element` (already positioned at the
/// app root) collecting child-index paths.
fn walk_menu(
    element: &AXUIElement,
    path: Vec<usize>,
    depth: usize,
    max_depth: usize,
) -> MenuEntry {
    let title = copy_string_attribute(element, "AXTitle")
        .or_else(|| copy_string_attribute(element, "AXDescription"))
        .unwrap_or_default();
    let role = copy_string_attribute(element, "AXRole").unwrap_or_default();
    let actions = crate::ax_core::copy_action_names(element);

    let mut children: Vec<MenuEntry> = Vec::new();
    if depth < max_depth {
        if let Ok(Some(value)) = copy_attribute(element, "AXChildren") {
            unsafe {
                if let Some(array) = value.downcast_ref::<CFArray>() {
                    let typed = array.cast_unchecked::<AXUIElement>();
                    for (i, child) in typed.iter().enumerate() {
                        let mut p = path.clone();
                        p.push(i);
                        children.push(walk_menu(&child, p, depth + 1, max_depth));
                    }
                }
            }
        }
    }

    MenuEntry {
        title,
        role,
        path,
        actions,
        children,
    }
}

/// Read the menu bar of the app with `pid`: the `AXMenuBar` node (usually the
/// first child of the application root) and its full menu tree, addressed by
/// child-index paths for direct AXPress.
///
/// # Errors
/// Untrusted process, app gone, or the app exposes no AXMenuBar (some custom
/// apps draw their own menus — fall back to click_at/right_click_at).
pub fn menu_bar_for_pid(pid: i32, max_depth: usize) -> Result<MenuEntry, String> {
    if !is_process_trusted(false) {
        return Err("未授予辅助功能权限 (Accessibility permission not granted)".to_string());
    }
    // Best-effort AXObserver registration: the agent can then wait on a real
    // notification envelope instead of sleeping blindly after each action.
    let _ = register_for_pid(pid);
    unsafe {
        let app = AXUIElement::new_application(pid);
        let _ = app.set_messaging_timeout(2.0);

        let value = copy_attribute(&app, "AXChildren")
            .map_err(|e| format!("读取 AXChildren 失败: {}", ax_error_description(e)))?
            .ok_or_else(|| "应用没有子元素".to_string())?;
        let array = value
            .downcast_ref::<CFArray>()
            .ok_or_else(|| "AXChildren 不是数组".to_string())?;
        let typed = array.cast_unchecked::<AXUIElement>();
        for (i, child) in typed.iter().enumerate() {
            let role = copy_string_attribute(&child, "AXRole").unwrap_or_default();
            if role == "AXMenuBar" {
                return Ok(walk_menu(&child, vec![i], 0, max_depth));
            }
        }
        Err("该应用没有 AXMenuBar（自绘菜单？试试 right_click_at）".to_string())
    }
}

// ---------------------------------------------------------------------------
// Positional hit-test (system-wide)
// ---------------------------------------------------------------------------

/// The element found under a screen point, summarized for the UI/agent.
#[derive(Debug, Clone, Serialize)]
pub struct HitElement {
    pub pid: i32,
    pub role: String,
    pub title: String,
    pub description: String,
}

/// Copy the element under a global screen point (system-wide hit test).
///
/// # Errors
/// Untrusted process, or no element at that position.
fn hit_element_at_screen_position(x: f32, y: f32) -> Result<CFRetained<AXUIElement>, String> {
    unsafe {
        let system_wide = AXUIElement::new_system_wide();
        let _ = system_wide.set_messaging_timeout(2.0);

        let mut raw: *const AXUIElement = std::ptr::null();
        let err = system_wide.copy_element_at_position(x, y, NonNull::from(&mut raw));
        match err {
            AXError::Success if !raw.is_null() => {
                // SAFETY: on Success the API hands us a +1 retained element
                // (Copy rule); CFRetained::from_raw takes ownership.
                Ok(CFRetained::from_raw(NonNull::new_unchecked(
                    raw as *mut AXUIElement,
                )))
            }
            AXError::Success | AXError::NoValue => {
                Err("该坐标下没有 UI 元素 (no element at position)".to_string())
            }
            other => Err(format!(
                "CopyElementAtPosition 失败: {} ({})",
                other.0,
                ax_error_description(other),
            )),
        }
    }
}

/// Return the UI element under the given *global* screen position (points,
/// top-left origin, same coordinate space as CGEvent clicks) using the
/// system-wide element — regardless of which app owns it.
///
/// # Errors
/// Untrusted process, or no element at that position.
pub fn element_at_screen_position(x: f32, y: f32) -> Result<HitElement, String> {
    if !is_process_trusted(false) {
        return Err("未授予辅助功能权限 (Accessibility permission not granted)".to_string());
    }
    unsafe {
        let element = hit_element_at_screen_position(x, y)?;
        let mut pid: i32 = 0;
        let _ = element.pid(NonNull::from(&mut pid));
        return Ok(HitElement {
            pid,
            role: copy_string_attribute(&element, "AXRole").unwrap_or_default(),
            title: copy_string_attribute(&element, "AXTitle").unwrap_or_default(),
            description: copy_string_attribute(&element, "AXDescription").unwrap_or_default(),
        });
    }
}

/// A screen point and the element found there — for reverse-path lookup.
#[derive(Debug, Clone, Serialize)]
pub struct TracedPoint {
    /// pid of the app that owns the hit element.
    pub pid: i32,
    /// Child-index path from that app's AXApplication root to the element.
    pub path: Vec<u32>,
}

/// Find the element under a screen point and walk up its `AXParent` chain to
/// the owning application root, recording child indices. The returned path can
/// address the very same element by (`pid`, `path`) — "click a point, then
/// take over that element".
///
/// # Errors
/// Untrusted process, no element at the position, or the parent chain is not
/// resolvable (broken AX tree).
pub fn trace_path_at_screen_position(x: f32, y: f32) -> Result<TracedPoint, String> {
    if !is_process_trusted(false) {
        return Err("未授予辅助功能权限 (Accessibility permission not granted)".to_string());
    }
    unsafe {
        let hit = hit_element_at_screen_position(x, y)?;
        let mut pid: i32 = 0;
        let _ = hit.pid(NonNull::from(&mut pid));
        if pid <= 0 {
            return Err("命中元素没有有效 pid".to_string());
        }

        let app = AXUIElement::new_application(pid);
        let _ = app.set_messaging_timeout(2.0);

        let mut path: Vec<u32> = Vec::new();
        let mut cursor = hit;
        for _ in 0..64 {
            // Root reached: matches the application element itself.
            let is_root = CFEqual(Some(&*app), Some(&*cursor))
                || copy_string_attribute(&cursor, "AXRole").as_deref() == Some("AXApplication");
            if is_root {
                return Ok(TracedPoint { pid, path });
            }
            let parent_value = copy_attribute(&cursor, "AXParent")
                .map_err(|e| format!("读取 AXParent 失败: {}", ax_error_description(e)))?
                .ok_or_else(|| "AXParent 不存在（元素可能已失效）".to_string())?;
            let parent = parent_value
                .downcast_ref::<AXUIElement>()
                .ok_or_else(|| "AXParent 不是 UI 元素".to_string())?
                .retain();
            let children_value = copy_attribute(&parent, "AXChildren")
                .map_err(|e| format!("读取 AXChildren 失败: {}", ax_error_description(e)))?
                .ok_or_else(|| "AXChildren 不存在".to_string())?;
            let array = children_value
                .downcast_ref::<CFArray>()
                .ok_or_else(|| "AXChildren 不是数组".to_string())?;
            let typed = array.cast_unchecked::<AXUIElement>();
            let mut index: Option<u32> = None;
            for (i, child) in typed.iter().enumerate() {
                if CFEqual(Some(&*child), Some(&*cursor)) {
                    index = Some(i as u32);
                    break;
                }
            }
            let index = index.ok_or_else(|| "在父节点 AXChildren 中找不到当前元素".to_string())?;
            path.insert(0, index);
            cursor = parent;
        }
        Err("AXParent 链超长或出现环".to_string())
    }
}