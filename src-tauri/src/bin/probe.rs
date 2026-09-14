
use std::process;

use objc2_application_services::{AXError, AXUIElement};
use objc2_core_foundation::{CFArray, CFRetained, CFString, CFType};
use std::ptr::NonNull;

fn main() {
    let pid: i32 = match std::env::args().nth(1) {
        Some(s) => s.parse().unwrap_or_else(|_| { process::exit(2) }),
        None => { process::exit(2) },
    };
    let trusted = unsafe { objc2_application_services::AXIsProcessTrusted() };
    println!("[trusted] AXIsProcessTrusted = {trusted}");
    if !trusted {
        println!("[AX] probe process NOT trusted by AX API (accessibility permission missing)");
        println!("[AX] -> this is the REAL reason System Events sees 0 windows");
        process::exit(3);
    }
    // SAFETY: pid is a live process id; new_application returns a retained ref.
    let app = unsafe { AXUIElement::new_application(pid) };
    println!("[app] created AXUIElement for pid={pid}");
    let mut out: *const CFType = std::ptr::null();
    let err = unsafe {
        app.copy_attribute_value(&CFString::from_str("AXWindows"), NonNull::from(&mut out))
    };
    println!("[AXWindows] err={err:?} value={:p}", out);
    if out.is_null() {
        println!("[AXWindows] null -> custom-drawn shell gives no AX window child to app");
        println!("[AXWindows] depth: app only (tree height=1)");
    } else {
        // SAFETY: +1 retained CFArrayRef (Copy rule), non-null on Success.
        let array = unsafe { CFRetained::from_raw(NonNull::new_unchecked(out as *mut CFArray)) };
        // SAFETY: every entry of AXWindows is an AXUIElement.
        let typed = unsafe { array.cast_unchecked::<AXUIElement>() };
        let n = typed.iter().count();
        println!("[AXWindows] count={n}");
        for (i, w) in typed.iter().enumerate() {
            let role = window_role(&w);
            println!("[win {i}] role={role:?}");
        }
    }
}

/// Read AXRole of a window element (mirrors ax_core::copy_string_attribute).
fn window_role(w: &AXUIElement) -> Option<String> {
    let mut raw: *const CFType = std::ptr::null();
    let err = unsafe {
        w.copy_attribute_value(&CFString::from_str("AXRole"), NonNull::from(&mut raw))
    };
    if err != AXError::Success || raw.is_null() {
        return None;
    }
    // SAFETY: +1 retained CFTypeRef (Copy rule) on Success.
    let value = unsafe { CFRetained::from_raw(NonNull::new_unchecked(raw as *mut CFType)) };
    value.downcast_ref::<CFString>().map(|s| s.to_string())
}
