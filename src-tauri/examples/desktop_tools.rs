//! Example: smoke-test the local desktop tools + local MCP plumbing without
//! the UI. Each tool result is exactly what the agent would receive.
//!
//! ```bash
//! cd src-tauri && cargo run --example desktop_tools
//! ```

use ax_explorer_lib::desktop_tools::desktop_tool_catalog;

fn main() {
    println!("== catalog ==");
    for t in desktop_tool_catalog() {
        println!("  {} — {}", t.name, t.description);
    }

    println!("\n== exec ==");
    let clipboard_probe = ax_explorer_lib::desktop_tools::exec(
        "clipboard_set",
        &serde_json::json!({ "text": "ax-explorer desktop tools OK" }),
    );
    println!("clipboard_set: {clipboard_probe}");
    println!(
        "clipboard_get: {}",
        ax_explorer_lib::desktop_tools::exec("clipboard_get", &serde_json::json!({}))
    );
    println!(
        "frontmost_app: {}",
        ax_explorer_lib::desktop_tools::exec("frontmost_app", &serde_json::json!({}))
    );
    println!(
        "screen_info: {}",
        ax_explorer_lib::desktop_tools::exec("screen_info", &serde_json::json!({}))
    );

    println!("\n== local MCP (mcp.local.json) ==");
    match ax_explorer_lib::mcp_client::list_tools() {
        Ok(tools) if tools.is_empty() => println!("（未配置本机 MCP 服务器 — 复制 mcp.local.example.json 为 mcp.local.json）"),
        Ok(tools) => {
            for t in &tools {
                println!("  {} — {}", t.name, t.description);
            }
            // Live-call the first tool of the first healthy server.
            if let Some(first) = tools.iter().find(|t| !t.name.ends_with(".__error__")) {
                println!("\ncall {}:", first.name);
                match ax_explorer_lib::mcp_client::call_tool(&first.name, serde_json::json!({})) {
                    Ok(out) => println!("  {}", out.chars().take(200).collect::<String>()),
                    Err(e) => println!("  error: {e}"),
                }
            }
        }
        Err(e) => println!("error: {e}"),
    }
}
