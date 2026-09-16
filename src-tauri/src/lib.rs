//! AX Agent — macOS computer-use agent (AXUIElement + OCR + synthetic input) built with Tauri 2.
//!
//! Commands (see `commands.rs`):
//!   - ax_permission_status  : is the process a trusted accessibility client
//!   - ax_request_permission : trigger the System Settings prompt
//!   - ax_permission_diagnostics : process chain + responsible app (dev-mode grant target)
//!   - ax_list_apps          : enumerate regular GUI apps (pid, name, bundle id)
//!   - ax_tree               : dump the AX tree of an app by pid (bounded depth)
//!   - ax_perform_action     : perform an action (AXPress...) via an index path
//!
//! Computer-use actuation (see `ax_act.rs`):
//!   - ax_set_value          : write text into an element's AXValue
//!   - ax_set_position       : move an element (window) via AXPosition
//!   - ax_focus_element      : grab keyboard focus (AXFocused = true)
//!   - ax_element_at         : hit-test which element is under a screen point
//!   - ax_open_app           : launch/focus an app by name (for chat sessions)
//!
//! LLM bridge (see `llm.rs`):
//!   - llm_chat (non-streaming) / llm_chat_stream (SSE → llm://delta events)
//!   - llm_get_config / llm_set_config / llm_list_models
//!   - llm_configured: config status (saved ⚙️ settings > .env > defaults)
//!   - llm_skills / llm_skill: tsm-hub gateway skill discovery (ax-explore key)
//!   - llm_catalog: gateway tools/skills/mcps catalog (example-task generation)
//!
//! Installed-app discovery (see `ax_core.rs`):
//!   - ax_installed_apps: /Applications scan, feeds dynamic example tasks
//!   - ax_local_apps_config: gitignored apps.local.json overrides (pin/hide)
//!
//! Local capabilities tsm-hub doesn't have (see `desktop_tools.rs` / `mcp_client.rs`):
//!   - desktop_tool_catalog / desktop_tool_exec: clipboard, notify, open_url,
//!     speak, screen_info, frontmost_app (native macOS, runs in this process)
//!   - mcp_local_tools / mcp_local_call: stdio MCP client for servers mounted
//!     locally via gitignored mcp.local.json (not on the hub)

pub mod ax_act;
pub mod ax_core;
pub mod ax_open;
pub mod commands;
pub mod desktop_tools;
pub mod llm;
pub mod mcp_client;
pub mod ocr;
pub mod rpc;

use tauri::Manager;

/// UTC wall-clock, e.g. `2026-09-13 09:41:02 UTC`, without pulling clock deps.
fn utc_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // civil_from_days (Howard Hinnant) → (y, m, d).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} UTC",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Append one session transcript to `<app_data>/logs/sessions.md`.
/// Returns the log file path so the UI can show it in errors/the notes.
#[tauri::command]
fn append_session_log(app: tauri::AppHandle, text: String) -> Result<String, String> {
    use std::io::Write;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取数据目录失败: {e}"))?
        .join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建日志目录失败: {e}"))?;
    let file = dir.join("sessions.md");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|e| format!("打开日志失败: {e}"))?;
    let ts = utc_now();
    writeln!(f, "\n===== {ts} =====").map_err(|e| format!("写入日志失败: {e}"))?;
    writeln!(f, "{text}").map_err(|e| format!("写入日志失败: {e}"))?;
    Ok(file.display().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| {
            rpc::spawn();
            // Startup permission pass: if the accessibility grant is already
            // there but Screen Recording / Input Monitoring are missing, pop
            // their system dialogs once so users don't discover the gap mid-
            // task (screenshots/OCR and synthetic keys fail without them).
            std::thread::spawn(|| {
                let preflight = commands::permission_overview();
                if preflight.accessibility {
                    if !preflight.screen_recording {
                        let _ = commands::request_screen_recording_gate();
                    }
                    if !preflight.input_monitoring {
                        let _ = commands::request_input_monitoring_gate();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ax_permission_status,
            commands::ax_request_permission,
            commands::ax_request_input_monitoring,
            commands::ax_request_screen_recording,
            commands::ax_permission_diagnostics,
            commands::ax_list_apps,
            commands::ax_tree,
            commands::ax_perform_action,
            commands::ax_set_value,
            commands::ax_set_position,
            commands::ax_move_window,
            commands::ax_resize_window,
            commands::ax_resize_window_pid,
            commands::ax_focus_element,
            commands::ax_element_at,
            commands::ax_read_attribute,
            commands::ax_trace_path,
            commands::ax_tree_json,
            commands::ax_screenshot_window,
            commands::ax_window_bounds,
            commands::ax_ocr_window,
            commands::ax_observe_wait,
            commands::ax_scroll,
            commands::ax_scroll_to_visible,
            commands::ax_named_action,
            commands::ax_key,
            commands::ax_type_keys,
            commands::ax_click,
            commands::ax_double_click,
            commands::ax_drag,
            commands::ax_right_click,
            commands::ax_menu_bar,
            commands::ax_open_app,
            commands::ax_profile_rag_configured,
            commands::ax_memory_add,
            commands::ax_memory_list,
            commands::ax_installed_apps,
            commands::ax_local_apps_config,
            commands::desktop_tool_catalog,
            commands::desktop_tool_exec,
            commands::mcp_local_tools,
            commands::mcp_local_call,
            llm::llm_chat,
            llm::llm_chat_stream,
            llm::llm_get_config,
            llm::llm_set_config,
            llm::llm_list_models,
            llm::llm_configured,
            llm::llm_skills,
            llm::llm_skill,
            llm::llm_catalog,
            append_session_log,
            mcp_client::mcp_pool_stats
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
