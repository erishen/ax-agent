//! Menu bar, app launching, local desktop tools / MCP, and permission
//! diagnostics.

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

use crate::ax_act;
use crate::ax_core;
use crate::ax_open;

use super::permissions::{permission_overview, PermissionOverview};

/// Read the menu bar of the app with `pid` (defaults to the frontmost app),
/// addressed by child-index paths so entries can be AXPressed directly.
///
/// # Errors
/// Untrusted process, app gone, or no AXMenuBar.
#[tauri::command(async)]
pub fn ax_menu_bar(pid: Option<i32>, depth: Option<u32>) -> Result<ax_act::MenuEntry, String> {
    let pid = match pid {
        Some(p) => p,
        None => ax_act::frontmost_pid().ok_or_else(|| "没有前台应用".to_string())?,
    };
    let max_depth = depth.unwrap_or(4).clamp(1, 6) as usize;
    ax_act::menu_bar_for_pid(pid, max_depth)
}

// ---------------------------------------------------------------------------
// App launching (for chat sessions: "打开 TextEdit")
// ---------------------------------------------------------------------------

/// Launch (or focus if already running) the app with the given bundle id or
/// name via NSWorkspace. Returns the pid it resolved to.
///
/// Async: cold launches can take 10s+ to register with NSWorkspace (QQLive),
/// so this polls for up to ~15s — never block the UI thread for that.
///
/// # Errors
/// App not found.
#[tauri::command(async)]
pub fn ax_open_app(target: String) -> Result<ax_core::AxAppInfo, String> {
    ax_open::open_application(&target)
}

/// Whether the local profile RAG (profile_search tool) is configured —
/// PROFILE_RAG_KEY present and non-empty. The TS layer registers the
/// profile_search tool only when this is true, so the LLM never wastes a
/// call on an unconfigured RAG (three 9/16 sessions each burned a step on
/// the same "未配置 PROFILE_RAG_KEY" error).
#[tauri::command]
pub fn ax_profile_rag_configured() -> bool {
    std::env::var("PROFILE_RAG_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .is_some()
}

// ---------------------------------------------------------------------------
// Local desktop tools + local MCP (capabilities tsm-hub doesn't provide)
// ---------------------------------------------------------------------------

/// Catalog of local desktop tools (names match frontend AGENT_TOOLS entries).
#[tauri::command]
pub fn desktop_tool_catalog() -> Vec<crate::desktop_tools::DesktopTool> {
    crate::desktop_tools::desktop_tool_catalog()
}

/// Execute a local desktop tool; args is the model's JSON arguments object.
/// Errors are returned as `error: …` text so the agent can react.
///
/// `screen_info` reads NSScreen which is main-thread-only, in a `(async)`
/// command context it would run on a background thread and fail. So we
/// dispatch that one call to the main thread and await the result; all other
/// tools run right here.
#[tauri::command(async)]
pub async fn desktop_tool_exec(
    app: tauri::AppHandle,
    name: String,
    args: serde_json::Value,
) -> String {
    if name == "screen_info" {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if let Err(e) = app.run_on_main_thread(move || {
            let _ = tx.send(crate::desktop_tools::exec(&name, &args));
        }) {
            return format!("error: 无法调度到主线程: {e}");
        }
        return rx
            .await
            .unwrap_or_else(|e| format!("error: 主线程执行失败: {e}"));
    }
    crate::desktop_tools::exec(&name, &args)
}

/// One MCP tool exposed by a local server (mcp.local.json).
#[derive(Clone, Serialize)]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// List tools across all locally configured MCP servers (mcp.local.json).
#[tauri::command(async)]
pub fn mcp_local_tools() -> Result<Vec<McpToolInfo>, String> {
    Ok(crate::mcp_client::list_tools()
        .unwrap_or_default()
        .into_iter()
        .map(|t| McpToolInfo {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
        })
        .collect())
}

/// Call a local MCP tool, namespaced `{server}.{tool}`.
#[tauri::command(async)]
pub fn mcp_local_call(qualified: String, args: serde_json::Value) -> Result<String, String> {
    crate::mcp_client::call_tool(&qualified, args)
}

// ---------------------------------------------------------------------------
// Permission diagnostics
// ---------------------------------------------------------------------------

/// One process in the ancestor chain of the ax-agent process.
#[derive(Clone, Serialize)]
pub struct ProcessChainEntry {
    pub pid: u32,
    pub name: String,
}

/// Permission diagnostics for the classic "why is it still untrusted?" case.
///
/// In dev mode the app is `cargo run`-launched from a terminal, so macOS
/// attributes the Accessibility grant to the *responsible* process — the app
/// at the root of the chain (Terminal / iTerm / VS Code), not ax-agent
/// itself. The gate shows this chain so the user knows exactly which entry to
/// tick in System Settings.
///
/// # Errors
/// Returns a message when /proc-style process data cannot be read (should not
/// happen on macOS).
#[tauri::command(async)]
pub fn ax_permission_diagnostics() -> Result<PermissionDiagnostics, String> {
    let trusted = ax_core::is_process_trusted(false);

    let mut system = System::new();
    let self_pid = std::process::id();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        // Only names + parent pids are needed; skip cmd/cpu/memory details.
        ProcessRefreshKind::nothing(),
    );

    // Walk parent PIDs from our own process up to launchd.
    let mut chain: Vec<ProcessChainEntry> = Vec::new();
    let mut current: Option<Pid> = Some(Pid::from_u32(self_pid));
    let mut guard = 0;
    while let Some(pid) = current {
        guard += 1;
        if guard > 32 {
            break; // cycle safety
        }
        let Some(process) = system.process(pid) else {
            break;
        };
        chain.push(ProcessChainEntry {
            pid: pid.as_u32(),
            name: process.name().to_string_lossy().into_owned(),
        });
        current = process.parent();
    }

    // macOS "responsible process": the app the permission applies to in dev
    // mode — the outermost non-launchd entry of the chain (launchd pid 1).
    let responsible = chain.iter().rev().find(|entry| entry.pid != 1).cloned();

    Ok(PermissionDiagnostics {
        trusted,
        permissions: permission_overview(),
        responsible,
        chain,
    })
}

/// Payload of [`ax_permission_diagnostics`].
#[derive(Serialize)]
pub struct PermissionDiagnostics {
    pub trusted: bool,
    /// Per-category permission status (Accessibility / Input Monitoring / …).
    pub permissions: PermissionOverview,
    /// App the grant applies to in dev mode (outermost non-launchd ancestor).
    pub responsible: Option<ProcessChainEntry>,
    /// Ancestor chain of this process, self first.
    pub chain: Vec<ProcessChainEntry>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_rag_configured_requires_non_empty_key() {
        std::env::remove_var("PROFILE_RAG_KEY");
        assert!(!ax_profile_rag_configured(), "no key → not configured");

        std::env::set_var("PROFILE_RAG_KEY", "test-key");
        assert!(ax_profile_rag_configured(), "non-empty key → configured");

        std::env::set_var("PROFILE_RAG_KEY", "   ");
        assert!(!ax_profile_rag_configured(), "blank key → not configured");

        std::env::remove_var("PROFILE_RAG_KEY");
    }
}
