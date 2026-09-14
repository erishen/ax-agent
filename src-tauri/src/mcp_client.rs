//! Minimal MCP (Model Context Protocol) client so MCP servers **tsm-hub
//! hasn't mounted** can still be used from ax-explorer — local, per-machine,
//! gitignored config (`mcp.local.json`).
//!
//! Protocol: JSON-RPC 2.0 over stdio (the common local-server transport).
//! Lifecycle per call: spawn → initialize → initialized → tools/list or
//! tools/call → kill. Simpler than a persistent connection and immune to
//! leaked subprocesses; MCP servers start in tens of milliseconds.
//!
//! Config shape (`mcp.local.json`, project root, gitignored — template
//! `mcp.local.example.json`):
//! ```json
//! { "servers": {
//!     "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] },
//!     "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
//!                 "env": { "GITHUB_TOKEN": "…" } }
//! } }
//! ```

use serde::Serialize;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use std::sync::LazyLock;

/// One configured local MCP server entry.
#[derive(Debug, Clone, serde::Deserialize, Serialize)]
pub struct McpServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
}

/// All local MCP servers (from mcp.local.json).
#[derive(Debug, Clone, serde::Deserialize, Serialize, Default)]
pub struct McpConfig {
    #[serde(default)]
    pub servers: std::collections::BTreeMap<String, McpServerConfig>,
}

/// Read `mcp.local.json` (project root / src-tauri cwd fallbacks). Missing → empty.
pub fn load_config() -> McpConfig {
    let candidates = [
        std::path::PathBuf::from("mcp.local.json"),
        std::path::PathBuf::from("../mcp.local.json"),
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mcp.local.json"),
    ];
    for p in candidates {
        if let Ok(text) = std::fs::read_to_string(&p) {
            if let Ok(cfg) = serde_json::from_str::<McpConfig>(&text) {
                return cfg;
            }
        }
    }
    McpConfig::default()
}

/// A tool exposed by an MCP server: `{server}.{tool}` in our namespace.
#[derive(Debug, Clone, Serialize)]
pub struct McpTool {
    /// Fully qualified: `{server}.{tool}`.
    pub name: String,
    pub description: String,
    /// Raw JSON schema from the server (OpenAI-compatible parameters).
    pub parameters: serde_json::Value,
}

/// List tools across every configured server. A server that fails to start is
/// reported as an error entry in the list (visible, not silent).
///
/// # Errors
/// Only if config parsing fails (never in practice; missing file = empty list).
pub fn list_tools() -> Result<Vec<McpTool>, String> {
    let cfg = load_config();
    let mut out = Vec::new();
    for (server, sc) in &cfg.servers {
        match server_tools(server, sc) {
            Ok(tools) => out.extend(tools),
            Err(e) => out.push(McpTool {
                name: format!("{server}.__error__"),
                description: format!("MCP 服务器启动失败: {e}"),
                parameters: serde_json::json!({"type": "object", "properties": {}}),
            }),
        }
    }
    Ok(out)
}

/// Call one tool, namespaced `{server}.{tool}`.
pub fn call_tool(qualified: &str, args: serde_json::Value) -> Result<String, String> {
    let (server, tool) = qualified
        .split_once('.')
        .ok_or_else(|| format!("工具名必须是 server.tool 形式: {qualified}"))?;
    let cfg = load_config();
    let sc = cfg
        .servers
        .get(server)
        .ok_or_else(|| format!("未配置 MCP 服务器「{server}」（见 mcp.local.json）"))?;
    with_session(sc, |rpc| rpc.request("tools/call", serde_json::json!({
        "name": tool,
        "arguments": args,
    })))
    .map(|v| extract_tool_text(&v))
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio plumbing
// ---------------------------------------------------------------------------

struct RpcSession {
    child: Child,
    stdin: std::process::ChildStdin,
    reader: BufReader<std::process::ChildStdout>,
    next_id: u64,
}

impl RpcSession {
    /// false once the child has exited (so the pool never reuses a dead one).
    fn is_alive(&mut self) -> bool {
        self.child
            .try_wait()
            .map(|s| s.is_none())
            .unwrap_or(false)
    }
    fn send(&mut self, method: &str, params: serde_json::Value, id: Option<u64>) -> Result<(), String> {
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let msg = match id {
            Some(id) => {
                let mut m = msg;
                m["id"] = serde_json::json!(id);
                m
            }
            None => msg,
        };
        writeln!(self.stdin, "{}", msg).map_err(|e| format!("MCP stdin 写入失败: {e}"))
    }

    /// Send a request and wait for the matching response id (skipping
    /// notifications like `notifications/*`).
    fn request(&mut self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(method, params, Some(id))?;
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if Instant::now() > deadline {
                return Err(format!("MCP 调用 {method} 超时（30s）"));
            }
            let mut line = String::new();
            let n = self
                .reader
                .read_line(&mut line)
                .map_err(|e| format!("MCP stdout 读取失败: {e}"))?;
            if n == 0 {
                return Err("MCP 服务器意外关闭了连接".into());
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
                continue; // non-JSON line (some servers log to stdout)
            };
            if v.get("id").and_then(|i| i.as_u64()) == Some(id) {
                if let Some(err) = v.get("error") {
                    return Err(format!("MCP 错误: {err}"));
                }
                return Ok(v.get("result").cloned().unwrap_or(serde_json::Value::Null));
            }
            // else: notification or mismatched id — keep reading.
        }
    }
}

impl Drop for RpcSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Idle TTL for a pooled MCP child. After this a session is considered stale
/// (and its child reaped on next use) so long agent runs don't accumulate
/// idle subprocesses.
const SESSION_TTL: std::time::Duration = std::time::Duration::from_secs(120);

/// Single live child per `(command, args)` identity — key reuse lets consecutive
/// MCP tool calls skip the ~100ms+ spawn+initialize startup.
struct PoolEntry {
    rpc: RpcSession,
    last_used: std::time::Instant,
}

static SESSION_POOL: LazyLock<Mutex<BTreeMap<String, PoolEntry>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

static SPAWNS: AtomicUsize = AtomicUsize::new(0);
static SESSION_REUSES: AtomicUsize = AtomicUsize::new(0);

/// Number of MCP subprocesses spawned since startup — surfaced for tests so a
/// reused session (spawn==1 across two calls) is observable without a real server.
pub fn spawn_count() -> usize {
    SPAWNS.load(Ordering::Relaxed)
}

/// Number of pooled-session reuses (second+ calls that skipped a spawn).
pub fn reuse_count() -> usize {
    SESSION_REUSES.load(Ordering::Relaxed)
}

/// Reset the pool + counters (tests only, or a server config reload).
/// Entries are drained under the lock, then dropped outside it so the
/// child-kill/wait in `Drop` doesn't block other pool users.
pub fn reset_pool() {
    // Swap in an empty map under the lock, then drop the taken entries
    // outside it so the child-kill/wait in `Drop` doesn't block other users.
    let entries: Vec<PoolEntry> = {
        let mut pool = SESSION_POOL.lock().unwrap();
        std::mem::take(&mut *pool).into_values().collect()
    };
    drop(entries); // Drop kills each child
    SPAWNS.store(0, Ordering::Relaxed);
    SESSION_REUSES.store(0, Ordering::Relaxed);
}

/// Read-only pool observer for real-session verification: how many children
/// are alive, how many total spawns, how many pooled reuses. A caller hitting
/// the SAME (command,args) twice should see reuse tick up (cache hit) — not a
/// fresh spawn.
#[tauri::command]
pub fn mcp_pool_stats() -> Result<serde_json::Value, String> {
    let size = SESSION_POOL.lock().map(|p| p.len()).unwrap_or(0);
    Ok(serde_json::json!({
        "pool_size": size,
        "total_spawns": spawn_count(),
        "total_reuses": reuse_count(),
    }))
}


/// Run `f` against a session for `sc`, reusing a live pooled child when
/// possible. The pool lock is held only for the `remove`/`insert` bookkeeping —
/// spawning a child (or killing a stale one) can take ~100ms+ and must not
/// block other callers waiting on the pool lock.
fn with_session<T>(
    sc: &McpServerConfig,
    f: impl FnOnce(&mut RpcSession) -> Result<T, String>,
) -> Result<T, String> {
    let key = format!("{:?}|{:?}", sc.command, sc.args);
    // Take any pooled entry out under the lock, then decide outside it.
    // `remove` is an atomic take, so a concurrent caller can never steal the
    // same entry — worst case it spawns its own child, which is correct.
    let entry = {
        let mut pool = SESSION_POOL.lock().unwrap();
        pool.remove(&key)
    };
    let mut rpc = match entry {
        Some(mut e) => {
            // Reuse only a fresh+alive child; otherwise reap+respawn.
            let reusable = e.last_used.elapsed() <= SESSION_TTL && e.rpc.is_alive();
            if reusable {
                e.last_used = Instant::now();
                SESSION_REUSES.fetch_add(1, Ordering::Relaxed);
                e.rpc
            } else {
                drop(e.rpc); // stale or dead child — Drop kills it
                spawn_session(sc)?
            }
        }
        None => spawn_session(sc)?,
    };
    // Run the user closure on the (possibly reused) session.
    let result = f(&mut rpc);
    // Put it back only if still alive — don't pool a crashed child.
    let alive = rpc.is_alive();
    if alive {
        let mut pool = SESSION_POOL.lock().unwrap();
        pool.insert(key, PoolEntry { rpc, last_used: Instant::now() });
    }
    result
}

/// Extract the current `with_session` body as its own function so the pool can
/// spawn a fresh child when no reusable session is available.
fn spawn_session(sc: &McpServerConfig) -> Result<RpcSession, String> {
    let mut cmd = Command::new(&sc.command);
    cmd.args(&sc.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (k, v) in &sc.env {
        cmd.env(k, v);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 MCP 服务器 {:?}: {e}", sc.command))?;
    let stdin = child.stdin.take().ok_or("MCP stdin 不可用")?;
    let stdout = child.stdout.take().ok_or("MCP stdout 不可用")?;
    let mut rpc = RpcSession {
        child,
        stdin,
        reader: BufReader::new(stdout),
        next_id: 0,
    };
    let init = rpc.request(
        "initialize",
        serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "ax-explorer", "version": "0.1.0" },
        }),
    )?;
    if let Some(pv) = init.get("protocolVersion").and_then(|p| p.as_str()) {
        if !pv.starts_with("2024") && !pv.starts_with("2025") {
            return Err(format!("不支持的 MCP 协议版本: {pv}"));
        }
    }
    // MCP spec: after a successful `initialize`, the client must send
    // `notifications/initialized` before issuing further requests. Send it
    // exactly once per spawn (not per call) so a reused pooled session stays
    // compliant too; some servers (and the echo_mcp.py test double) enforce
    // the ordering and would otherwise hang/error on tools/list.
    rpc.send("notifications/initialized", serde_json::json!({}), None)?;
    SPAWNS.fetch_add(1, Ordering::Relaxed);
    Ok(rpc)
}

fn server_tools(server: &str, sc: &McpServerConfig) -> Result<Vec<McpTool>, String> {
    with_session(sc, |rpc| {
        let v = rpc.request("tools/list", serde_json::json!({}))?;
        let mut out = Vec::new();
        if let Some(tools) = v.get("tools").and_then(|t| t.as_array()) {
            for t in tools {
                let name = t.get("name").and_then(|n| n.as_str()).unwrap_or("");
                if name.is_empty() {
                    continue;
                }
                out.push(McpTool {
                    name: format!("{server}.{name}"),
                    description: t
                        .get("description")
                        .and_then(|d| d.as_str())
                        .unwrap_or("（无描述）")
                        .to_string(),
                    parameters: t
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({"type": "object", "properties": {}})),
                });
            }
        }
        Ok(out)
    })
}

/// MCP tools/call returns `{content: [{type: "text", text: …}, …]}` —
/// flatten to plain text for the model.
fn extract_tool_text(v: &serde_json::Value) -> String {
    if let Some(content) = v.get("content").and_then(|c| c.as_array()) {
        let parts: Vec<String> = content
            .iter()
            .filter_map(|c| {
                c.get("text")
                    .and_then(|t| t.as_str())
                    .map(String::from)
                    .or_else(|| {
                        if c.get("type").and_then(|t| t.as_str()) == Some("text") {
                            Some(String::new())
                        } else {
                            None
                        }
                    })
            })
            .collect();
        let joined = parts.join("\n");
        if !joined.trim().is_empty() {
            return joined;
        }
    }
    if let Some(err) = v.get("isError").and_then(|e| e.as_bool()) {
        if err {
            return format!("MCP 工具报告错误: {v}");
        }
    }
    v.to_string()
}

#[cfg(test)]
mod session_pool_tests {
    use super::*;

    /// Test double: the echo stdio MCP server under scripts/testdata/.
    fn echo_config() -> McpServerConfig {
        McpServerConfig {
            command: "python3".into(),
            // echo_mcp.py lives in the project root scripts/testdata/.
            args: vec![format!(
                "{}/../scripts/testdata/echo_mcp.py",
                env!("CARGO_MANIFEST_DIR")
            )],
            env: BTreeMap::new(),
        }
    }

    /// Full pool lifecycle in one serial flow (spawn/reuse counters are
    /// process-global, so separate parallel tests would race): spawn exactly
    /// once across two calls → reuse ticks → reset reaps + zeroes → next call
    /// spawns fresh. The initialized notification must have been sent
    /// (echo_mcp.py replies to tools/call only after a valid handshake).
    #[test]
    fn pool_reuse_and_reset_flow() {
        reset_pool();
        let sc = echo_config();
        let call = |rpc: &mut RpcSession| {
            let v = rpc.request("tools/call", serde_json::json!({
                "name": "ping",
                "arguments": {},
            }))?;
            Ok(extract_tool_text(&v))
        };
        let first = with_session(&sc, call);
        let second = with_session(&sc, call);
        assert!(first.as_deref().unwrap_or("").contains("pong from pid"),
            "第一次调用应拿到 pong：{first:?}");
        assert!(second.as_deref().unwrap_or("").contains("pong from pid"),
            "第二次调用应拿到 pong：{second:?}");
        assert_eq!(spawn_count(), 1, "两次调用应只 spawn 一次子进程");
        assert_eq!(reuse_count(), 1, "第二次调用应复用池内会话");

        reset_pool();
        assert_eq!(spawn_count(), 0, "reset 应清零 spawn 计数");
        assert_eq!(reuse_count(), 0, "reset 应清零 reuse 计数");
        let again = with_session(&sc, call);
        assert!(again.as_deref().unwrap_or("").contains("pong from pid"),
            "reset 后的调用应能重新握手并返回 pong：{again:?}");
        assert_eq!(spawn_count(), 1, "reset 后第一次调用应重新 spawn");
        assert_eq!(reuse_count(), 0);
    }
}
