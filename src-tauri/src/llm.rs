//! LLM bridge for the chat session (OpenAI-compatible API, tool calling).
//!
//! The frontend's agent loop calls `llm_chat` with the conversation + tool
//! definitions; the model's next message (text or tool_calls) comes back.
//! Config (base_url / api_key / model) persists in app_data_dir/llm.json.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

/// Provider configuration persisted locally.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self::from_env().unwrap_or(Self {
            base_url: "https://api.deepseek.com".to_string(),
            api_key: String::new(),
            model: "deepseek-chat".to_string(),
        })
    }
}

impl LlmConfig {
    /// Build a config from environment variables (`AX_EXPLORER_LLM_*`),
    /// loading the project-root `.env` first. Returns `None` when nothing is
    /// set, so callers can fall back to built-in defaults.
    fn from_env() -> Option<Self> {
        // Load `.env` from the project root (dev mode) — ignore errors: the
        // file is optional. In dev, cwd is the workspace root, so also try
        // the crate-relative path `ax-agent/.env`.
        let _ = dotenvy::dotenv();
        let _ = dotenvy::from_path(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.env"),
        );

        let base = std::env::var("AX_EXPLORER_LLM_BASE_URL").ok().filter(|v| !v.trim().is_empty());
        let key = std::env::var("AX_EXPLORER_LLM_API_KEY").ok().filter(|v| !v.trim().is_empty());
        let model = std::env::var("AX_EXPLORER_LLM_MODEL").ok().filter(|v| !v.trim().is_empty());
        if base.is_none() && key.is_none() && model.is_none() {
            return None;
        }
        Some(Self {
            base_url: base.unwrap_or_else(|| "https://api.deepseek.com".to_string()),
            api_key: key.unwrap_or_default(),
            model: model.unwrap_or_else(|| "deepseek-chat".to_string()),
        })
    }
}

fn config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 app_data_dir 失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.join("llm.json"))
}

/// Load LLM config. Precedence: saved settings (app_data_dir/llm.json from
/// the ⚙️ panel) > `AX_EXPLORER_LLM_*` env vars / `.env` file > built-in
/// defaults. The `api_key` is **masked** (returned empty) — the frontend only
/// learns whether one is stored via `llm_configured().has_key`; the raw key
/// never crosses the IPC boundary.
///
/// # Errors
/// File read/parse failures.
#[tauri::command]
pub async fn llm_get_config(app: tauri::AppHandle) -> Result<LlmConfig, String> {
    let path = config_path(&app)?;
    let mut cfg = if !path.exists() {
        LlmConfig::default()
    } else {
        let content = std::fs::read_to_string(&path).map_err(|e| format!("读取配置失败: {e}"))?;
        serde_json::from_str(&content).map_err(|e| format!("解析配置失败: {e}"))?
    };
    cfg.api_key.clear();
    Ok(cfg)
}

/// Whether the saved config (or env) already provides everything needed.
#[derive(Debug, Serialize)]
pub struct LlmConfigured {
    pub configured: bool,
    /// Where the effective config came from.
    pub source: String,
    /// Non-sensitive bits for pre-filling the settings panel.
    pub base_url: String,
    pub model: String,
    pub has_key: bool,
}

/// Report LLM configuration status without exposing the key.
#[tauri::command]
pub async fn llm_configured(app: tauri::AppHandle) -> Result<LlmConfigured, String> {
    let path = config_path(&app)?;
    if path.exists() {
        let content = std::fs::read_to_string(&path).map_err(|e| format!("读取配置失败: {e}"))?;
        let saved: LlmConfig =
            serde_json::from_str(&content).map_err(|e| format!("解析配置失败: {e}"))?;
        return Ok(LlmConfigured {
            configured: !saved.api_key.trim().is_empty(),
            source: "settings".to_string(),
            base_url: saved.base_url,
            model: saved.model,
            has_key: !saved.api_key.trim().is_empty(),
        });
    }
    match LlmConfig::from_env() {
        Some(env_cfg) if !env_cfg.api_key.trim().is_empty() => Ok(LlmConfigured {
            configured: true,
            source: "env".to_string(),
            base_url: env_cfg.base_url,
            model: env_cfg.model,
            has_key: true,
        }),
        Some(env_cfg) => Ok(LlmConfigured {
            configured: false,
            source: "env-partial".to_string(),
            base_url: env_cfg.base_url,
            model: env_cfg.model,
            has_key: false,
        }),
        None => Ok(LlmConfigured {
            configured: false,
            source: "default".to_string(),
            base_url: LlmConfig::default().base_url,
            model: LlmConfig::default().model,
            has_key: false,
        }),
    }
}

/// Save LLM config. An empty `api_key` means "keep whatever is already
/// stored" (the frontend never receives the raw key, so this is how a
/// settings change without a new key avoids clobbering the existing one).
///
/// # Errors
/// File write failures.
#[tauri::command]
pub async fn llm_set_config(app: tauri::AppHandle, mut config: LlmConfig) -> Result<(), String> {
    let path = config_path(&app)?;
    if config.api_key.trim().is_empty() {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(old) = serde_json::from_str::<LlmConfig>(&text) {
                config.api_key = old.api_key;
            }
        }
    }
    let json = serde_json::to_string_pretty(&config).map_err(|e| format!("序列化配置失败: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("写入配置失败: {e}"))?;
    // llm.json holds the plaintext API key — keep it owner-only (was 0644).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// One message in the OpenAI chat format (role/content/tool_calls/tool_call_id).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmMessage {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// One tool definition in the OpenAI function format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmTool {
    pub name: String,
    pub description: String,
    /// JSON Schema for the `parameters` object.
    pub parameters: Value,
}

/// The model's response: either assistant text, or tool calls to execute.
#[derive(Debug, Serialize)]
pub struct LlmTurn {
    /// Assistant text when the model wrote prose (empty when calling tools).
    pub content: String,
    /// OpenAI-format tool_calls array (may be empty).
    pub tool_calls: Value,
    pub finish_reason: String,
}

fn endpoint(base: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    }
}

/// HTTP statuses worth retrying: rate limits (429) and transient upstream
/// failures (502/503/504 — proxies often surface provider 429s as 502s).
fn is_retryable(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status == reqwest::StatusCode::BAD_GATEWAY
        || status == reqwest::StatusCode::SERVICE_UNAVAILABLE
        || status == reqwest::StatusCode::GATEWAY_TIMEOUT
}

/// Tiny pseudo-jitter (0.0–1.0s) without pulling a rand crate.
fn rand_jitter() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    f64::from(nanos % 1000) / 1000.0
}

const RETRY_ATTEMPTS: u32 = 5;

/// Shared HTTP client: connection pooling + HTTP keep-alive across agent
/// turns, so we stop paying for a fresh TLS handshake on every request —
/// one less thing that can trip a provider's request-rate limit.
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);

/// Pace control: never let two requests fire back to back (a fast agent loop
/// dumbly re-queues the moment a turn fails) and, right after a rate-limit
/// hit, force a short cooldown before the next fresh request.
static LAST_REQUEST: LazyLock<Mutex<Option<Instant>>> =
    LazyLock::new(|| Mutex::new(None));
static LAST_429: LazyLock<Mutex<Option<Instant>>> = LazyLock::new(|| Mutex::new(None));
const MIN_GAP: Duration = Duration::from_millis(200);
const POST_429_COOLDOWN: Duration = Duration::from_secs(5);

async fn pace_gate() {
    let mut sleep_for = Duration::ZERO;
    if let Some(gap) = LAST_REQUEST.lock().unwrap().as_ref() {
        let since = Instant::now().duration_since(*gap);
        if since < MIN_GAP {
            sleep_for = MIN_GAP - since;
        }
    }
    if let Some(hit) = LAST_429.lock().unwrap().as_ref() {
        let since = Instant::now().duration_since(*hit);
        if since < POST_429_COOLDOWN && POST_429_COOLDOWN - since > sleep_for {
            sleep_for = POST_429_COOLDOWN - since;
        }
    }
    if !sleep_for.is_zero() {
        tokio::time::sleep(sleep_for).await;
    }
    *LAST_REQUEST.lock().unwrap() = Some(Instant::now());
}

/// Send one chat-completions request with an aggressive-but-courteous retry
/// policy shared by the streaming and non-streaming paths:
/// - 429: honor `Retry-After` when present (cap 60s), else exponential
///   backoff (2s→32s + jitter). A 429 hits request/TPM quotas, so we wait the
///   provider out instead of hammering it.
/// - 502/503/504: exponential backoff, capped at 10s.
/// - other 4xx (401/404…): never retried.
///
/// Returns the successful response (body untouched) or a diagnostic error.
async fn send_with_retry(
    url: &str,
    key: &str,
    body: &Value,
    timeout_secs: u64,
) -> Result<reqwest::Response, String> {
    pace_gate().await;
    let mut last_text = String::new();
    let mut last_status = reqwest::StatusCode::OK;
    let mut last_net_err: Option<String> = None;
    for attempt in 1..=RETRY_ATTEMPTS {
        let resp = match CLIENT
            .post(url)
            .header("Authorization", format!("Bearer {key}"))
            .header("Content-Type", "application/json")
            .json(body)
            .timeout(Duration::from_secs(timeout_secs))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                // Network-layer failures: timeouts (slow first prefill, provider
                // queue) and connection-level errors are often transient and
                // recover on retry — treat them like 5xx with backoff. Hard
                // errors (DNS failure, Connection refused = service not running
                // or wrong URL) mean retrying is pointless; fail fast so the
                // user sees the real problem immediately (16:40 session died on
                // a timeout that was never retried).
                let refused = e.to_string().contains("Connection refused");
                if !e.is_timeout() && !(e.is_connect() && !refused) {
                    return Err(format!("请求 LLM 失败: {e}"));
                }
                let msg = format!("请求 LLM 失败: {e}");
                last_net_err = Some(msg.clone());
                let secs = (2.0_f64.powi(attempt as i32)).min(10.0) + rand_jitter();
                eprintln!(
                    "[llm] 网络错误（第 {attempt}/{RETRY_ATTEMPTS} 次重试前退避 {secs:.1}s）{}",
                    msg.chars().take(120).collect::<String>()
                );
                tokio::time::sleep(Duration::from_secs_f64(secs)).await;
                continue;
            }
        };
        let status = resp.status();
        last_status = status;
        if status.is_success() {
            return Ok(resp);
        }
        let retry_after = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        let text = resp.text().await.unwrap_or_default();
        let is_429 = status.as_u16() == 429;
        let is_5xx = is_retryable(status) && !is_429;
        // Quota-gone signatures (daily allowance, prepaid balance): retrying
        // is pointless — the allowance resets on the provider's billing cycle,
        // not on a backoff schedule. Fail fast with an unmistakable message.
        let quota_gone = {
            let lower = text.to_lowercase();
            lower.contains("free quota")
                || lower.contains("quota exhausted")
                || lower.contains("quota_exhausted")
                || lower.contains("free-models-per-day")
                || lower.contains("额度耗尽")
                || lower.contains("insufficient quota")
        };
        if quota_gone {
            return Err(format!(
                "LLM 额度已耗尽（{}）：重试无效，需充值、换 ⚙️ 里的模型/服务商，或等额度周期重置。原始错误: {}",
                status,
                truncate(&text, 300)
            ));
        }
        if !is_429 && !is_5xx {
            return Err(format!("LLM 返回 {status}: {}", truncate(&text, 300)));
        }
        last_text = text.clone();
        let secs = if is_429 {
            retry_after
                .and_then(|v| v.trim().parse::<f64>().ok())
                .map(|s| s.clamp(1.0, 60.0))
                .unwrap_or_else(|| 2.0_f64.powi(attempt as i32).min(32.0) + rand_jitter())
        } else {
            (2.0_f64.powi(attempt as i32)).min(10.0) + rand_jitter()
        };
        eprintln!(
            "[llm] {status}（第 {attempt}/{RETRY_ATTEMPTS} 次重试前退避 {secs:.1}s）{}",
            text.chars().take(120).collect::<String>()
        );
        tokio::time::sleep(Duration::from_secs_f64(secs)).await;
    }
    if let Some(net_err) = last_net_err {
        return Err(format!(
            "LLM 网络错误：已退避重试 {RETRY_ATTEMPTS} 次仍失败。原始错误: {}",
            truncate(&net_err, 300)
        ));
    }
    let code = last_status.as_u16();
    if code == 429 || code == 502 {
        // Remember the hit so the *next* request also cools down instead of
        // re-igniting the storm immediately.
        *LAST_429.lock().unwrap() = Some(Instant::now());
    }
    Err(format!(
        "LLM {}（{}）：已退避重试 {RETRY_ATTEMPTS} 次仍失败。原始错误: {}",
        last_status,
        if code == 429 { "限流" } else { "上游错误" },
        truncate(&last_text, 300)
    ))
}

/// One non-streaming chat-completions turn with tools.
///
/// # Errors
/// Missing config, network failure, non-200 response, or malformed body.
#[tauri::command]
pub async fn llm_chat(
    app: tauri::AppHandle,
    messages: Vec<LlmMessage>,
    tools: Vec<LlmTool>,
) -> Result<LlmTurn, String> {
    let config: LlmConfig = {
        let path = config_path(&app)?;
        if path.exists() {
            let content =
                std::fs::read_to_string(&path).map_err(|e| format!("读取配置失败: {e}"))?;
            serde_json::from_str(&content).map_err(|e| format!("解析配置失败: {e}"))?
        } else {
            // Fall back to .env / environment variables.
            LlmConfig::default()
        }
    };
    if config.api_key.trim().is_empty() {
        return Err("尚未配置 LLM：请点右上角 ⚙️ 填写 API 地址 / 密钥 / 模型".to_string());
    }

    let body = serde_json::json!({
        "model": config.model,
        "messages": messages,
        "tools": tools.iter().map(|t| serde_json::json!({
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
            }
        })).collect::<Vec<_>>(),
    });

    let url = endpoint(&config.base_url);
    let key = config.api_key.trim().to_string();

    // Send with the shared retry policy (see `send_with_retry`).
    let resp = send_with_retry(&url, &key, &body, 120).await?;
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;

    let parsed: Value = serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {e}"))?;
    let choice = parsed
        .get("choices")
        .and_then(|c| c.get(0))
        .ok_or_else(|| format!("响应缺少 choices: {}", truncate(&text, 200)))?;
    let message = choice.get("message").cloned().unwrap_or(Value::Null);
    let content = message
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or_default()
        .to_string();
    let tool_calls = message
        .get("tool_calls")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let finish_reason = choice
        .get("finish_reason")
        .and_then(|f| f.as_str())
        .unwrap_or_default()
        .to_string();

    Ok(LlmTurn {
        content,
        tool_calls,
        finish_reason,
    })
}

// ---------------------------------------------------------------------------
// Streaming variant: same request with `stream: true`; deltas are forwarded
// to the webview as `llm://delta` events so the chat bubble fills live.
// Tool calls are assembled from streamed fragments (index-keyed) exactly like
// the non-streaming path would return them, so the agent loop is unchanged.
// ---------------------------------------------------------------------------

/// One SSE `chat.completion.chunk` choice we care about.
#[derive(Default)]
struct StreamAcc {
    content: String,
    /// tool call fragments keyed by index: id / name / argument chunk.
    tool_parts: std::collections::BTreeMap<u64, (String, String, String)>,
    finish_reason: String,
}

impl StreamAcc {
    fn apply_chunk(&mut self, delta: &Value) {
        if let Some(c) = delta.get("content").and_then(|c| c.as_str()) {
            self.content.push_str(c);
        }
        if let Some(calls) = delta.get("tool_calls").and_then(|t| t.as_array()) {
            for call in calls {
                let idx = call.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                let entry = self.tool_parts.entry(idx).or_default();
                if let Some(id) = call.get("id").and_then(|v| v.as_str()) {
                    entry.0.push_str(id);
                }
                if let Some(name) = call
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|v| v.as_str())
                {
                    entry.1.push_str(name);
                }
                if let Some(args) = call
                    .get("function")
                    .and_then(|f| f.get("arguments"))
                    .and_then(|v| v.as_str())
                {
                    entry.2.push_str(args);
                }
            }
        }
        if let Some(f) = delta.get("finish_reason").and_then(|f| f.as_str()) {
            if !f.is_empty() {
                self.finish_reason = f.to_string();
            }
        }
    }

    fn to_tool_calls(&self) -> Value {
        Value::Array(
            self.tool_parts
                .iter()
                .map(|(idx, (id, name, args))| {
                    serde_json::json!({
                        "id": id,
                        "type": "function",
                        "index": idx,
                        "function": { "name": name, "arguments": args },
                    })
                })
                .collect(),
        )
    }
}

/// One streaming chat-completions turn with tools. Content deltas are emitted
/// as `llm://delta` events ({seq, text}) on the "streaming-llm" channel, so
/// the frontend can render the reply as it is generated.
///
/// # Errors
/// Missing config, network failure, non-200 response, or malformed body.
#[tauri::command]
pub async fn llm_chat_stream(
    app: tauri::AppHandle,
    messages: Vec<LlmMessage>,
    tools: Vec<LlmTool>,
) -> Result<LlmTurn, String> {
    use futures_util::StreamExt;
    use tauri::Emitter;

    let config: LlmConfig = {
        let path = config_path(&app)?;
        if path.exists() {
            let content =
                std::fs::read_to_string(&path).map_err(|e| format!("读取配置失败: {e}"))?;
            serde_json::from_str(&content).map_err(|e| format!("解析配置失败: {e}"))?
        } else {
            LlmConfig::default()
        }
    };
    if config.api_key.trim().is_empty() {
        return Err("尚未配置 LLM：请点右上角 ⚙️ 填写 API 地址 / 密钥 / 模型".to_string());
    }

    let mut body = serde_json::json!({
        "model": config.model,
        "messages": messages,
        "tools": tools.iter().map(|t| serde_json::json!({
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
            }
        })).collect::<Vec<_>>(),
        "stream": true,
    });
    // Some gateways reject "stream_options" they don't know; send usage-free
    // standard SSE only.
    if let Some(obj) = body.as_object_mut() {
        obj.remove("stream_options");
    }

    let url = endpoint(&config.base_url);
    let key = config.api_key.trim().to_string();

    // Same shared retry policy as `llm_chat`: 429/5xx get backoff + pacing.
    let resp = send_with_retry(&url, &key, &body, 300).await?;

    let mut acc = StreamAcc::default();
    let mut seq: u64 = 0;
    let mut stream = resp.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("读取流失败: {e}"))?;
        buffer.extend_from_slice(&bytes);
        // SSE frames are separated by a blank line; tolerate \r\n.
        while let Some(pos) = find_frame_end(&buffer) {
            let frame: Vec<u8> = buffer.drain(..pos).collect();
            let text = String::from_utf8_lossy(&frame);
            for line in text.lines() {
                let line = line.trim_start_matches("data:").trim();
                if line.is_empty() || line == "[DONE]" {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                let Some(choice) = v.get("choices").and_then(|c| c.get(0)) else {
                    continue;
                };
                if let Some(delta) = choice.get("delta") {
                    let before = acc.content.len();
                    acc.apply_chunk(delta);
                    if acc.content.len() > before {
                        // Emit only the new tail to the webview.
                        let new_text = &acc.content[before..];
                        seq += 1;
                        let _ = app.emit(
                            "llm://delta",
                            serde_json::json!({ "seq": seq, "text": new_text }),
                        );
                    }
                }
                if let Some(f) = choice.get("finish_reason")
                    .and_then(|f| f.as_str())
                    .map(str::to_string)
                {
                    if !f.is_empty() {
                        acc.finish_reason = f;
                    }
                }
            }
        }
    }

    let content = std::mem::take(&mut acc.content);
    let finish_reason = std::mem::take(&mut acc.finish_reason);
    Ok(LlmTurn {
        content,
        tool_calls: acc.to_tool_calls(),
        finish_reason,
    })
}

/// Index of the double-newline ending an SSE frame, if present.
fn find_frame_end(buf: &[u8]) -> Option<usize> {
    for i in 0..buf.len().saturating_sub(1) {
        if buf[i] == b'\n' && buf[i + 1] == b'\n' {
            return Some(i + 2);
        }
    }
    None
}

/// List models from the provider (`GET /v1/models`) for the settings test button.
///
/// # Errors
/// Network or auth failures.
#[tauri::command]
pub async fn llm_list_models(
    base_url: String,
    api_key: String,
) -> Result<Vec<String>, String> {
    let url = {
        let base = base_url.trim().trim_end_matches('/');
        if base.ends_with("/v1") {
            format!("{base}/models")
        } else {
            format!("{base}/v1/models")
        }
    };
    let resp = reqwest::Client::new()
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("返回 {status}: {}", truncate(&text, 200)));
    }
    let parsed: Value = serde_json::from_str(&text).map_err(|e| format!("解析失败: {e}"))?;
    Ok(parsed
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default())
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() > n {
        format!("{}…", s.chars().take(n).collect::<String>())
    } else {
        s.to_string()
    }
}

// ---------------------------------------------------------------------------
// Hub skill discovery (tsm-hub /v1/skills) — for the client-side agent to
// know which skills the gateway has and pull full SKILL.md text on demand.
// ---------------------------------------------------------------------------

/// Gateway capability catalog entry (tools/mcps/skills share id/name+description).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubCapability {
    pub name: String,
    pub description: String,
}

/// Combined gateway capability catalog for example-task generation.
#[derive(Debug, Serialize)]
pub struct HubCatalog {
    pub tools: Vec<HubCapability>,
    pub skills: Vec<HubCapability>,
    pub mcps: Vec<HubCapability>,
}

/// Fetch the gateway's capability catalogs (tools / skills / mcps).
/// Best-effort per section: a section that fails returns empty.
///
/// # Errors
/// Only when all three requests fail does the first error surface.
#[tauri::command]
pub async fn llm_catalog(app: tauri::AppHandle) -> Result<HubCatalog, String> {
    let config = load_config(&app)?;
    let base = config.base_url.trim().trim_end_matches('/').to_string();
    let key = config.api_key.trim().to_string();
    let client = CLIENT.clone();

    let get = |path: &'static str| {
        let base = base.clone();
        let key = key.clone();
        let client = client.clone();
        async move {
            let url = if base.ends_with("/v1") {
                format!("{base}{path}")
            } else {
                format!("{base}/v1{path}")
            };
            let resp = client
                .get(&url)
                .header("Authorization", format!("Bearer {key}"))
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = resp.status();
            let text = resp.text().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                return Err(format!("{status}"));
            }
            serde_json::from_str::<Value>(&text).map_err(|e| e.to_string())
        }
    };

    let parse = |v: &Value, name_key: &str, desc_key: &str| -> Vec<HubCapability> {
        v.as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        let name = item
                            .get(name_key)
                            .and_then(|n| n.as_str())
                            .unwrap_or_default()
                            .to_string();
                        if name.is_empty() {
                            return None;
                        }
                        let description = item
                            .get(desc_key)
                            .and_then(|d| d.as_str())
                            .unwrap_or_default()
                            .to_string();
                        Some(HubCapability { name, description })
                    })
                    .collect()
            })
            .unwrap_or_default()
    };

    let tools_fut = get("/tools");
    let skills_fut = get("/skills");
    let mcps_fut = get("/mcps");
    let (tools_r, skills_r, mcps_r) = tokio::join!(tools_fut, skills_fut, mcps_fut);

    let tools = tools_r
        .map(|v| {
            // /v1/tools returns {object:"list", tools:[{type:function,function:{name,description}}…]}
            let arr = v
                .get("tools")
                .cloned()
                .or_else(|| v.get("data").cloned())
                .unwrap_or(Value::Null);
            let mapped: Vec<Value> = arr
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|t| {
                            let f = t.get("function").cloned().unwrap_or_else(|| t.clone());
                            serde_json::json!({
                                "name": f.get("name").and_then(|n| n.as_str()).unwrap_or(""),
                                "description": f.get("description").and_then(|d| d.as_str()).unwrap_or(""),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            parse(&Value::Array(mapped), "name", "description")
        })
        .unwrap_or_default();

    let skills = skills_r
        .map(|v| parse(v.get("skills").unwrap_or(&Value::Null), "name", "description"))
        .unwrap_or_default();

    let mcps = mcps_r
        .map(|v| {
            // /v1/mcps returns {mcps:[{name, status, tools:[…]}…]} — flatten tools.
            let mut out: Vec<HubCapability> = Vec::new();
            if let Some(arr) = v.get("mcps").and_then(|m| m.as_array()) {
                for m in arr {
                    let server = m.get("name").and_then(|n| n.as_str()).unwrap_or("mcp");
                    if let Some(tools) = m.get("tools").and_then(|t| t.as_array()) {
                        for t in tools {
                            let name = t
                                .get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or_default()
                                .to_string();
                            if name.is_empty() {
                                continue;
                            }
                            out.push(HubCapability {
                                name: format!("mcp_{server}_{name}"),
                                description: t
                                    .get("description")
                                    .and_then(|d| d.as_str())
                                    .unwrap_or_default()
                                    .to_string(),
                            });
                        }
                    }
                }
            }
            out
        })
        .unwrap_or_default();

    Ok(HubCatalog { tools, skills, mcps })
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubSkill {
    pub name: String,
    pub description: String,
}

fn load_config(app: &tauri::AppHandle) -> Result<LlmConfig, String> {
    let path = config_path(app)?;
    if path.exists() {
        let content = std::fs::read_to_string(&path).map_err(|e| format!("读取配置失败: {e}"))?;
        serde_json::from_str(&content).map_err(|e| format!("解析配置失败: {e}"))
    } else {
        Ok(LlmConfig::default())
    }
}

/// List skills mounted on the tsm-hub gateway.
///
/// # Errors
/// Network/auth failures or the endpoint is not a tsm-hub gateway.
#[tauri::command]
pub async fn llm_skills(app: tauri::AppHandle) -> Result<Vec<HubSkill>, String> {
    let config = load_config(&app)?;
    let base = config.base_url.trim().trim_end_matches('/');
    let url = if base.ends_with("/v1") {
        format!("{base}/skills")
    } else {
        format!("{base}/v1/skills")
    };
    let resp = reqwest::Client::new()
        .get(&url)
        .header("Authorization", format!("Bearer {}", config.api_key.trim()))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("请求技能列表失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("返回 {status}: {}", truncate(&text, 200)));
    }
    let parsed: Value = serde_json::from_str(&text).map_err(|e| format!("解析失败: {e}"))?;
    Ok(parsed
        .get("skills")
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| serde_json::from_value::<HubSkill>(s.clone()).ok())
                .collect()
        })
        .unwrap_or_default())
}

/// Fetch the full SKILL.md text of one gateway skill.
///
/// # Errors
/// Network/auth failures or unknown skill name.
#[tauri::command]
pub async fn llm_skill(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let config = load_config(&app)?;
    let base = config.base_url.trim().trim_end_matches('/');
    let url = if base.ends_with("/v1") {
        format!("{base}/skills/{name}")
    } else {
        format!("{base}/v1/skills/{name}")
    };
    let resp = reqwest::Client::new()
        .get(&url)
        .header("Authorization", format!("Bearer {}", config.api_key.trim()))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("请求技能失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("返回 {status}: {}", truncate(&text, 200)));
    }
    let parsed: Value = serde_json::from_str(&text).map_err(|e| format!("解析失败: {e}"))?;
    // tsm-hub returns the skill object flat: {object:"skill", name, raw, …}.
    let raw = parsed
        .get("raw")
        .or_else(|| parsed.get("skill").and_then(|s| s.get("raw")))
        .and_then(|r| r.as_str())
        .unwrap_or("");
    if raw.is_empty() {
        return Err(format!("响应中没有 skill 内容: {}", truncate(&text, 200)));
    }
    Ok(raw.to_string())
}
