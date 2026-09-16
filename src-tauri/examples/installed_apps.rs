//! Example: list installed applications exactly as the frontend's
//! `ax_installed_apps` command sees them — proofs the scan finds YOUR apps,
//! with localized display names (备忘录, not Notes) for example-task chips.
//!
//! ```bash
//! cargo run -p ax-agent --example installed_apps
//! ```

fn main() {
    match ax_agent_lib::ax_core::list_installed_apps() {
        Ok(apps) => {
            println!("found {} installed applications\n", apps.len());
            println!("{:<22} {:<20} {:<28} path", "display name", "bundle name", "bundle id");
            println!("{}", "-".repeat(110));
            for a in &apps {
                println!(
                    "{:<22} {:<20} {:<28} {}",
                    a.name, a.bundle_name, a.bundle_id, a.path
                );
            }
        }
        Err(e) => {
            eprintln!("scan failed: {e}");
            std::process::exit(1);
        }
    }
}
