//! Loopback JSON-RPC server exposing the same computer-use primitives the
//! webview uses, so a CLI / script / remote agent can observe and actuate apps
//! without the GUI.
//!
//! JSON-RPC 2.0 over HTTP: `POST /rpc` with `{jsonrpc, id, method, params}`
//! (params as a named object). Binds `127.0.0.1` only; port from `AX_RPC_PORT`
//! (default 8931). `GET /health` returns `ok`.
//!
//! Methods:
//! - `ax.ping` / `ax.version` / `ax.permissions`
//! - `ax.list_apps` / `ax.open` / `ax.frontmost`
//! - `ax.tree` (pid, depth?) / `ax.tree.text` / `ax.menu_bar` (pid?, depth?)
//! - `ax.element_at` (x, y) / `ax.trace` (x, y)
//! - `ax.actuate` (pid, path, action) / `ax.focus` / `ax.scroll_to`
//! - `ax.set_value` (pid, path, text) — post-verifies by reading AXValue back
//! - `ax.set_position` (pid, path, x, y) — post-verifies by reading AXPosition
//! - `ax.scroll` (x, y, lines) / `ax.key` (combo) / `ax.type_keys` (text)
//! - `ax.click_at` / `ax.double_click_at` / `ax.right_click_at` / `ax.drag`
//! - `ax.observe.register` (pid) / `ax.observe.wait` (pid, timeout?) /
//!   `ax.observe.unregister` (pid)
//! - `ax.screenshot` (pid)

use axum::{
    extract::{Json, State},
    http::{header, HeaderMap, StatusCode},
    routing::{get, post},
    Router,
};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::PathBuf;
use tokio::net::TcpListener;

use crate::ax_act;
use crate::ax_core;
use crate::commands;

const DEFAULT_PORT: u16 = 8931;
const MAX_DEPTH: usize = 12;

/// Shared secret for the loopback server. This endpoint can click, type and
/// screenshot the whole desktop, so any local process (browser hitting the
/// port, malware, misbehaving scripts) must be locked out. The token lives in
/// a 0600 file (or `AX_RPC_TOKEN`, which wins), is generated once on first
/// launch, and is shared with CLI clients through the file contract.
fn rpc_token() -> String {
    if let Ok(t) = std::env::var("AX_RPC_TOKEN") {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return t;
        }
    }
    let path = std::env::var("HOME")
        .ok()
        .map(|h| PathBuf::from(h).join(".ax-explorer/rpc.token"));
    let Some(path) = path else {
        return String::new(); // no HOME → tokenless loopback (fallback)
    };
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim().to_string();
        if !existing.is_empty() {
            return existing;
        }
    }
    // 32 random bytes straight from the OS CSPRNG (no new crate needed).
    let mut raw = [0u8; 32];
    let mut fresh = String::new();
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        if f.read_exact(&mut raw).is_ok() {
            fresh = raw.iter().map(|b| format!("{b:02x}")).collect();
        }
    }
    if fresh.is_empty() {
        eprintln!("[rpc] 无法生成鉴权 token（/dev/urandom 不可用）");
        return String::new(); // degraded: no auth on loopback
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, &fresh);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    fresh
}

/// Start the loopback JSON-RPC server on a background thread with its own
/// tokio runtime (Tauri's `.setup` runs on the main thread and has no reactor,
/// so we must not rely on `#[tokio::main]` or `tokio::spawn` there).
pub fn spawn() {
    let port = std::env::var("AX_RPC_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    std::thread::Builder::new()
        .name("ax-rpc".to_string())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("[rpc] 创建 tokio 运行时失败: {e}");
                    return;
                }
            };
            rt.block_on(serve(port));
        })
        .expect("无法启动 ax-rpc 线程");
}

async fn serve(port: u16) {
    let token = rpc_token();
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/rpc", post(handle_rpc))
        .with_state(token);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(listener) = TcpListener::bind(addr).await else {
        eprintln!("[rpc] 127.0.0.1:{port} 端口被占用，JSON-RPC 未启动");
        return;
    };
    eprintln!("[rpc] JSON-RPC 已就绪: http://127.0.0.1:{port}/rpc（需 Bearer token）");
    let _ = axum::serve(listener, app).await;
}

// ---------------------------------------------------------------------------
// Params helpers
// ---------------------------------------------------------------------------

fn p_i32(v: &Value, key: &str) -> Option<i32> {
    v.get(key).and_then(Value::as_i64).map(|n| n as i32)
}

fn p_u32(v: &Value, key: &str) -> Option<u32> {
    v.get(key).and_then(Value::as_u64).map(|n| n as u32)
}

fn p_f64(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

fn p_str(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn p_path(v: &Value) -> Vec<u32> {
    v.get("path")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(Value::as_u64).map(|n| n as u32).collect())
        .unwrap_or_default()
}

fn p_usize_path(v: &Value) -> Vec<usize> {
    p_path(v).into_iter().map(|p| p as usize).collect()
}

fn p_timeout(v: &Value) -> u64 {
    v.get("timeout")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .clamp(0, 10)
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Run a heavy AX call off the async executor (AX reads are blocking IPC).
async fn blocking<F, T>(f: F) -> Result<T, (i64, String)>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| (-32603, format!("任务失败: {e}")))?
        .map_err(|e| (-1, e))
}

async fn dispatch(method: &str, params: &Value) -> Result<Value, (i64, String)> {
    match method {
        "ax.ping" => Ok(json!("pong")),
        "ax.version" => Ok(json!({ "name": "ax-explorer", "rpc": 1 })),
        "ax.permissions" => Ok(serde_json::to_value(commands::permission_overview())
            .map_err(|e| (-32603, format!("序列化失败: {e}")))?),

        "ax.list_apps" => Ok(serde_json::to_value(ax_core::list_applications())
            .map_err(|e| (-32603, format!("序列化失败: {e}")))?),
        "ax.open" => {
            let app = p_str(params, "app");
            if app.is_empty() {
                return Err((-32602, "缺少 params.app".to_string()));
            }
            let info = blocking(move || crate::ax_open::open_application(&app)).await?;
            Ok(serde_json::to_value(info).map_err(|e| (-32603, format!("序列化失败: {e}")))?)
        }
        "ax.frontmost" => {
            let pid = blocking(move || {
                ax_act::frontmost_pid().ok_or_else(|| "没有前台应用".to_string())
            })
            .await?;
            Ok(json!(pid))
        }

        "ax.tree" | "ax.tree.text" => {
            let pid = p_i32(params, "pid").ok_or((-32602, "缺少 params.pid".to_string()))?;
            let depth = p_u32(params, "depth").unwrap_or(10) as usize;
            let depth = depth.clamp(1, MAX_DEPTH);
            let tree = blocking(move || ax_core::build_tree_export(pid, depth)).await?;
            if method == "ax.tree.text" {
                Ok(json!(serde_json::to_string_pretty(&tree)
                    .map_err(|e| (-32603, format!("序列化失败: {e}")))?))
            } else {
                Ok(serde_json::to_value(tree)
                    .map_err(|e| (-32603, format!("序列化失败: {e}")))?)
            }
        }
        "ax.menu_bar" => {
            let pid = p_i32(params, "pid");
            let depth = p_u32(params, "depth").unwrap_or(8) as usize;
            let menu = blocking(move || match pid {
                Some(pid) => ax_act::menu_bar_for_pid(pid, depth),
                None => {
                    let pid = ax_act::frontmost_pid().ok_or("没有前台应用".to_string())?;
                    ax_act::menu_bar_for_pid(pid, depth)
                }
            })
            .await?;
            Ok(serde_json::to_value(menu).map_err(|e| (-32603, format!("序列化失败: {e}")))?)
        }

        "ax.element_at" => {
            let x = p_f64(params, "x").ok_or((-32602, "缺少 params.x".to_string()))?;
            let y = p_f64(params, "y").ok_or((-32602, "缺少 params.y".to_string()))?;
            let element = blocking(move || {
                ax_act::element_at_screen_position(x as f32, y as f32)
            })
            .await?;
            let element_v =
                serde_json::to_value(&element).map_err(|e| (-32603, format!("序列化失败: {e}")))?;
            // Reverse-path is best-effort on top of the hit.
            let path = blocking(move || ax_act::trace_path_at_screen_position(x as f32, y as f32))
                .await
                .ok()
                .and_then(|t| {
                    serde_json::to_value(t).ok()
                });
            Ok(json!({ "element": element_v, "path": path }))
        }
        "ax.trace" => {
            let x = p_f64(params, "x").ok_or((-32602, "缺少 params.x".to_string()))?;
            let y = p_f64(params, "y").ok_or((-32602, "缺少 params.y".to_string()))?;
            let traced = blocking(move || {
                ax_act::trace_path_at_screen_position(x as f32, y as f32)
            })
            .await?;
            Ok(serde_json::to_value(traced)
                .map_err(|e| (-32603, format!("序列化失败: {e}")))?)
        }

        "ax.actuate" => {
            let pid = p_i32(params, "pid").ok_or((-32602, "缺少 params.pid".to_string()))?;
            let pid_s = pid;
            let path_s = p_usize_path(params);
            let action_s = p_str(params, "action");
            if action_s.is_empty() {
                return Err((-32602, "缺少 params.action".to_string()));
            }
            let action_f = action_s.clone();
            blocking(move || ax_core::perform_action_for_path(pid_s, &path_s, &action_f)).await?;
            Ok(json!({ "ok": true, "action": action_s }))
        }
        "ax.focus" => {
            let pid = p_i32(params, "pid").ok_or((-32602, "缺少 params.pid".to_string()))?;
            let path = p_usize_path(params);
            blocking(move || ax_act::focus_element_for_path(pid, &path)).await?;
            Ok(json!({ "ok": true }))
        }
        "ax.scroll_to" => {
            let pid = p_i32(params, "pid").ok_or((-32602, "缺少 params.pid".to_string()))?;
            let path = p_usize_path(params);
            blocking(move || ax_act::scroll_to_visible_for_path(pid, &path)).await?;
            Ok(json!({ "ok": true }))
        }
        "ax.set_value" => {
            let pid = p_i32(params, "pid").ok_or((-32602, "缺少 params.pid".to_string()))?;
            let text = p_str(params, "text");
            let pid_s = pid;
            let path_s = p_usize_path(params);
            let text_s = text.clone();
            blocking(move || ax_act::set_value_for_path(pid_s, &path_s, &text_s)).await?;
            // Post-verification: read the control's AXValue back.
            let path_r = p_usize_path(params);
            let readback =
                blocking(move || ax_act::read_attribute_for_path(pid, &path_r, "AXValue")).await?;
            let verified = readback.as_deref().map(|v| v == text).unwrap_or(false);
            Ok(json!({ "ok": true, "verified": verified, "current": readback }))
        }
        "ax.set_position" => {
            let pid = p_i32(params, "pid").ok_or((-32602, "缺少 params.pid".to_string()))?;
            let x = p_f64(params, "x").ok_or((-32602, "缺少 params.x".to_string()))?;
            let y = p_f64(params, "y").ok_or((-32602, "缺少 params.y".to_string()))?;
            let pid_s = pid;
            let path_s = p_usize_path(params);
            blocking(move || ax_act::set_position_for_path(pid_s, &path_s, x, y)).await?;
            // Post-verification: read AXPosition back and compare with tolerance.
            let path_r = p_usize_path(params);
            let readback =
                blocking(move || ax_act::read_attribute_for_path(pid, &path_r, "AXPosition")).await?;
            let verified = readback.as_deref().is_some_and(|s| {
                let near = |key: &str, want: f64| -> bool {
                    let marker = format!("{key}: ");
                    let Some(start) = s.find(&marker) else {
                        return false;
                    };
                    let start = start + marker.len();
                    let rest = &s[start..];
                    let end = rest
                        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
                        .unwrap_or(rest.len());
                    rest[..end]
                        .trim()
                        .parse::<f64>()
                        .ok()
                        .is_some_and(|got| (got - want).abs() < 2.0)
                };
                near("x", x) && near("y", y)
            });
            Ok(json!({ "ok": true, "verified": verified, "position": readback }))
        }

        "ax.scroll" => {
            let x = p_f64(params, "x").ok_or((-32602, "缺少 params.x".to_string()))?;
            let y = p_f64(params, "y").ok_or((-32602, "缺少 params.y".to_string()))?;
            let lines = p_f64(params, "lines").ok_or((-32602, "缺少 params.lines".to_string()))?;
            let pid = p_i32(params, "pid");
            blocking(move || ax_act::scroll_at_position(x, y, lines, pid)).await?;
            Ok(json!({ "ok": true }))
        }
        "ax.key" => {
            let combo = p_str(params, "combo");
            if combo.is_empty() {
                return Err((-32602, "缺少 params.combo".to_string()));
            }
            let pid = p_i32(params, "pid");
            blocking(move || ax_act::press_key_combo(&combo, pid)).await?;
            Ok(json!({ "ok": true }))
        }
        "ax.type_keys" => {
            let text = p_str(params, "text");
            if text.is_empty() {
                return Err((-32602, "缺少 params.text".to_string()));
            }
            let pid = p_i32(params, "pid");
            blocking(move || ax_act::type_text_synthetic(&text, pid)).await?;
            Ok(json!({ "ok": true }))
        }
        "ax.click_at" => {
            let x = p_f64(params, "x").ok_or((-32602, "缺少 params.x".to_string()))?;
            let y = p_f64(params, "y").ok_or((-32602, "缺少 params.y".to_string()))?;
            let pid = p_i32(params, "pid");
            blocking(move || ax_act::click_at_position(x, y, pid)).await?;
            Ok(json!({ "ok": true }))
        }
        "ax.double_click_at" => {
            let x = p_f64(params, "x").ok_or((-32602, "缺少 params.x".to_string()))?;
            let y = p_f64(params, "y").ok_or((-32602, "缺少 params.y".to_string()))?;
            let pid = p_i32(params, "pid");
            blocking(move || ax_act::double_click_at_position(x, y, pid)).await?;
            Ok(json!({ "ok": true }))
        }
        "ax.right_click_at" => {
            let x = p_f64(params, "x").ok_or((-32602, "缺少 params.x".to_string()))?;
            let y = p_f64(params, "y").ok_or((-32602, "缺少 params.y".to_string()))?;
            let pid = p_i32(params, "pid");
            blocking(move || ax_act::right_click_at_position(x, y, pid)).await?;
            Ok(json!({ "ok": true }))
        }
        "ax.drag" => {
            let from_x = p_f64(params, "from_x").ok_or((-32602, "缺少 params.from_x".to_string()))?;
            let from_y = p_f64(params, "from_y").ok_or((-32602, "缺少 params.from_y".to_string()))?;
            let to_x = p_f64(params, "to_x").ok_or((-32602, "缺少 params.to_x".to_string()))?;
            let to_y = p_f64(params, "to_y").ok_or((-32602, "缺少 params.to_y".to_string()))?;
            let steps = p_u32(params, "steps").unwrap_or(12);
            let pid = p_i32(params, "pid");
            blocking(move || ax_act::drag(from_x, from_y, to_x, to_y, steps, pid)).await?;
            Ok(json!({ "ok": true }))
        }

        "ax.observe.register" => {
            let pid = p_i32(params, "pid").ok_or((-32602, "缺少 params.pid".to_string()))?;
            let result = blocking(move || ax_act::register_for_pid(pid)).await;
            match result {
                Ok(()) => Ok(json!({ "ok": true, "fallback_poll": false })),
                Err((_code, msg)) => Ok(json!({ "ok": false, "fallback_poll": true, "reason": msg })),
            }
        }
        "ax.observe.unregister" => {
            let pid = p_i32(params, "pid").ok_or((-32602, "缺少 params.pid".to_string()))?;
            blocking(move || {
                ax_act::unregister_for_pid(pid);
                Ok(())
            })
            .await?;
            Ok(json!({ "ok": true }))
        }
        "ax.observe.wait" => {
            let pid = p_i32(params, "pid").ok_or((-32602, "缺少 params.pid".to_string()))?;
            let timeout = p_timeout(params);
            let baseline = ax_act::last_trigger_bump();
            let result = blocking(move || {
                // Best-effort fast path: wake early on a real UI notification.
                let _ = ax_act::register_for_pid(pid);
                ax_act::wait_for_change(timeout) // Ok = change or timeout → caller polls
            })
            .await;
            match result {
                Ok(()) => {
                    let changed = !ax_act::observer_dead() && ax_act::has_bumped_since(baseline);
                    Ok(json!({ "changed": changed, "waited_secs": timeout }))
                }
                Err((_code, msg)) => Ok(json!({ "changed": false, "fallback_poll": true, "reason": msg })),
            }
        }

        "ax.screenshot" => {
            let pid = p_i32(params, "pid").ok_or((-32602, "缺少 params.pid".to_string()))?;
            let shot = blocking(move || capture_screenshot(pid)).await?;
            Ok(serde_json::to_value(shot)
                .map_err(|e| (-32603, format!("序列化失败: {e}")))?)
        }

        _ => Err((-32601, format!("未知方法: {method}"))),
    }
}

/// Window screenshot + frame, mirroring `ax_screenshot_window` (which lives in
/// the command layer and also handles the base64 encoding).
fn capture_screenshot(pid: i32) -> Result<commands::ScreenshotInfo, String> {
    let tree = ax_core::build_tree_export(pid, 10)?;
    let win = find_window_node(&tree).ok_or("该应用当前没有窗口节点".to_string())?;
    let position = win.position.ok_or("窗口缺少 AXPosition".to_string())?;
    let size = win.size.ok_or("窗口缺少 AXSize".to_string())?;
    let path_u: Vec<usize> = win.path.iter().map(|p| *p as usize).collect();
    let window_id: i64 = ax_act::read_attribute_for_path(pid, &path_u, "AXWindowNumber")?
        .and_then(|s| s.trim().parse().ok())
        .ok_or("窗口号缺失".to_string())?;
    let out = std::env::temp_dir().join(format!("ax-rpc-shot-{pid}.png"));
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .arg("-x")
        .arg("-l")
        .arg(window_id.to_string())
        .arg(&out)
        .status()
        .map_err(|e| format!("screencapture 启动失败: {e}"))?;
    if !status.success() {
        return Err("截图失败（缺少屏幕录制权限？）".to_string());
    }
    let bytes = std::fs::read(&out).map_err(|e| format!("读取截图失败: {e}"))?;
    let _ = std::fs::remove_file(&out);
    Ok(commands::ScreenshotInfo {
        pid,
        window_id,
        position,
        size,
        image: format!("data:image/png;base64,{}", base64_encode(&bytes)),
    })
}

fn find_window_node(node: &ax_core::ExportNode) -> Option<&ax_core::ExportNode> {
    if node.role == "AXWindow" {
        return Some(node);
    }
    node.children.iter().find_map(find_window_node)
}

fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(n & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async fn handle_rpc(
    State(token): State<String>,
    headers: HeaderMap,
    Json(req): Json<Value>,
) -> (StatusCode, Json<Value>) {
    // Lock out every unauthenticated local caller (browsers, other processes).
    // `/health` intentionally stays open; everything else needs the token.
    let provided = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let authorized = provided
        .strip_prefix("Bearer ")
        .is_some_and(|t| t.trim() == token);
    if !authorized {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "jsonrpc": "2.0", "id": Value::Null,
                "error": { "code": -32000, "message": "未授权：缺少或错误的 Bearer token（设置 AX_RPC_TOKEN 或 ~/.ax-explorer/rpc.token）" }
            })),
        );
    }
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let params = req.get("params").cloned().unwrap_or_else(|| json!({}));
    match dispatch(&method, &params).await {
        Ok(result) => (
            StatusCode::OK,
            Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })),
        ),
        Err((code, message)) => (
            StatusCode::OK,
            Json(json!({
                "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message }
            })),
        ),
    }
}