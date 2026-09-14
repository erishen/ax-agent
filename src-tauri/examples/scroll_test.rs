//! Smoke test for the synthetic scroll primitive in `ax_act`.
//!
//! Posts a small (2-line) scroll event at a fixed screen point — put a
//! scrollable window (browser, notes list) there before running.

fn main() {
    let (x, y) = (600.0, 400.0);
    println!("scrolling +2 lines at ({x}, {y})");
    match ax_explorer_lib::ax_act::scroll_at_position(x, y, 2.0, None) {
        Ok(()) => println!("scroll event posted OK"),
        Err(e) => {
            eprintln!("scroll failed: {e}");
            std::process::exit(1);
        }
    }
}
