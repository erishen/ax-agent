//! Diagnostics: print every display's logical frame (as Tauri's Monitor API
//! would compute it) beside the target window's CGWindowBounds, so we can see
//! whether `hideAside`'s "which screen is the target on" decision is right.
//!
//! Usage: cargo run --example bounds_demo -- <pid-or-app-name e.g. 腾讯视频>
use objc2_app_kit::{NSScreen, NSWorkspace};

fn main() {
    // 1. Which pid are we inspecting?
    let arg = std::env::args().nth(1);
    let pid: i32 = match arg {
        Some(a) => a.parse().unwrap_or_else(|_| find_pid(&a)),
        None => find_pid("腾讯视频"),
    };
    println!("target pid = {pid}");

    // 2. CG window bounds for that pid.
    match ax_explorer_lib::ocr::find_window_cg(pid) {
        Some((wid, (x, y), (w, h))) => {
            println!("CGWindow #{wid} bounds: x={x:.1} y={y:.1} w={w:.1} h={h:.1}");
            println!("  center = ({:.1}, {:.1})", x + w / 2.0, y + h / 2.0);
        }
        None => println!("find_window_cg -> None (no ON-SCREEN window; screen-recording grant? different Space?)"),
    }

    // 2b. Enumerate every window of the pid (incl. other Spaces / offscreen)
    //     to see whether OnScreenOnly filtering is what hid it.
    {
        use core_foundation::base::TCFType;
        use core_foundation::dictionary::CFDictionary;
        use core_foundation::number::CFNumber;
        use core_foundation::string::CFString;
        type Void = *const std::ffi::c_void;
        type VoidDict = CFDictionary<Void, Void>;
        fn n(d: &VoidDict, key: core_foundation::string::CFStringRef) -> Option<f64> {
            let v = d.find(key as Void)?;
            unsafe { CFNumber::wrap_under_get_rule(*v as _) }.to_f64()
        }
        let list = core_graphics::window::copy_window_info(
            core_graphics::window::kCGWindowListOptionAll,
            core_graphics::window::kCGNullWindowID,
        )
        .expect("copy_window_info(All)");
        let mut shown = 0;
        for item in list.iter() {
            let raw = *item;
            let entry: VoidDict = unsafe { CFDictionary::wrap_under_get_rule(raw as _) };
            let Some(owner) = n(&entry, unsafe { core_graphics::window::kCGWindowOwnerPID })
            else { continue };
            if owner != pid as f64 { continue; }
            let Some(wid) = n(&entry, unsafe { core_graphics::window::kCGWindowNumber })
            else { continue };
            let onscreen = n(&entry, unsafe { core_graphics::window::kCGWindowIsOnscreen })
                .map(|v| if v != 0.0 { "yes" } else { "no" })
                .unwrap_or("?");
            let mut geom = " <no-bounds>".to_string();
            if let Some(bp) = entry.find(unsafe { core_graphics::window::kCGWindowBounds } as Void) {
                let b: VoidDict = unsafe { CFDictionary::wrap_under_get_rule(*bp as _) };
                let g = |k: &str| {
                    let key = CFString::new(k);
                    b.find(key.as_concrete_TypeRef() as Void)
                        .and_then(|v| unsafe { CFNumber::wrap_under_get_rule(*v as _) }.to_f64())
                };
                geom = format!(
                    " x={:.0} y={:.0} w={:.0} h={:.0}",
                    g("X").unwrap_or(0.0),
                    g("Y").unwrap_or(0.0),
                    g("Width").unwrap_or(0.0),
                    g("Height").unwrap_or(0.0)
                );
            }
            println!("  ALL-list window #{wid} onscreen={onscreen}{geom}");
            shown += 1;
        }
        if shown == 0 { println!("  (no windows for pid {pid} even with OptionAll)"); }
    }

    // 3. Every display NSScreen knows about (Tauri's Monitor API basis).
    let mtm = objc2::MainThreadMarker::new().expect("main thread");
    println!("displays:");
    for s in NSScreen::screens(mtm) {
        let f = s.frame();
        let scale = s.backingScaleFactor();
        println!(
            "  logical: x={:.1} y={:.1} w={:.1} h={:.1}  scale={:.2} (frame={{x:{}, y:{}, w:{}, h:{}}})",
            f.origin.x, f.origin.y, f.size.width, f.size.height, scale,
            f.origin.x, f.origin.y, f.size.width, f.size.height
        );
    }

    // 4. Cross-check with the CoreGraphics online-display list (bypasses the
    //    higher-level APIs entirely).
    unsafe {
        use core_graphics::display::CGGetActiveDisplayList;
        use core_graphics::geometry::CGPoint;
        let mut ids = [0u32; 8];
        let mut count = 0;
        CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count);
        println!("active CG displays online: {count}");
        for i in 0..count {
            let id = ids[i as usize];
            let b = core_graphics::display::CGDisplayBounds(id);
            let tag = if b.origin.x == 0.0 && b.origin.y == 0.0 { " [primary]" } else { "" };
            println!(
                "  CG display #{id}: x={:.1} y={:.1} w={:.1} h={:.1}{tag}",
                b.origin.x, b.origin.y, b.size.width, b.size.height
            );
        }
    }
}

fn find_pid(needle: &str) -> i32 {
    let needle = needle.trim().to_lowercase();
    for app in unsafe { NSWorkspace::sharedWorkspace().runningApplications() } {
        if app.isTerminated() || app.processIdentifier() == std::process::id() as i32 {
            continue;
        }
        let name = app
            .localizedName()
            .map(|s| s.to_string())
            .unwrap_or_default();
        if name.to_lowercase().contains(&needle) {
            return app.processIdentifier();
        }
    }
    println!("no running app matches «{needle}»; falling back to frontmost");
    unsafe {
        NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|a| a.processIdentifier())
            .unwrap_or(-1)
    }
}