//! Desktop tools the agent can run **locally** — capabilities tsm-hub doesn't
//! have (its tool pool is server-side: calc/fetch_url/memory/…, none of them
//! can touch the Mac desktop).
//!
//! Implementation policy: shell out to battle-tested system binaries instead of
//! pulling private-API crates:
//! - clipboard: `pbcopy` / `pbpaste` (macOS built-in)
//! - notifications / dialogs / AppleScript: `osascript`
//! - open URLs/apps: `open`
//! - screen geometry: NSScreen via objc2-app-kit
//!
//! Every tool returns a human/LLM-readable result string (never panics; errors
//! become `error: …` text the model can react to).

use objc2_app_kit::NSScreen;

/// One desktop tool the local agent may call.
#[derive(Debug, Clone, Serialize)]
pub struct DesktopTool {
    pub name: String,
    pub description: String,
}

use serde::Serialize;

/// Catalog of desktop tools (names must match the frontend's tool schemas).
pub fn desktop_tool_catalog() -> Vec<DesktopTool> {
    vec![
        DesktopTool {
            name: "clipboard_set".into(),
            description: "把文本写入系统剪贴板".into(),
        },
        DesktopTool {
            name: "clipboard_get".into(),
            description: "读取系统剪贴板当前文本".into(),
        },
        DesktopTool {
            name: "notify".into(),
            description: "弹一条 macOS 系统通知（title + message）".into(),
        },
        DesktopTool {
            name: "open_url".into(),
            description: "用默认浏览器打开一个 http(s) URL".into(),
        },
        DesktopTool {
            name: "speak".into(),
            description: "用系统语音朗读一段文本（say）".into(),
        },
        DesktopTool {
            name: "screen_info".into(),
            description: "返回屏幕尺寸与各显示器的边界（布局/摆放窗口用）".into(),
        },
        DesktopTool {
            name: "frontmost_app".into(),
            description: "返回当前最前台应用的名称与 pid".into(),
        },
        DesktopTool {
            name: "profile_search".into(),
            description: "检索我的个人资料库（职业经历/年龄/人格画像/工作习惯等文档），返回最相关片段。我的资料里没有现成的「观影偏好」，做个性化推荐前要先用它查到我的画像特征再推断喜好".into(),
        },
    ]
}

fn run(cmd: &mut std::process::Command) -> Result<String, String> {
    let out = cmd
        .output()
        .map_err(|e| format!("无法执行 {:?}: {e}", cmd.get_program()))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(format!(
            "error: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Execute a desktop tool by name; args is the model's JSON object.
pub fn exec(name: &str, args: &serde_json::Value) -> String {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("");
    match name {
        "clipboard_set" => {
            let text = s("text");
            if text.is_empty() {
                return "error: missing 'text'".into();
            }
            use std::io::Write;
            let mut child = match std::process::Command::new("pbcopy")
                .stdin(std::process::Stdio::piped())
                .spawn()
            {
                Ok(c) => c,
                Err(e) => return format!("error: pbcopy: {e}"),
            };
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(text.as_bytes());
            }
            match child.wait() {
                Ok(st) if st.success() => "已写入剪贴板".into(),
                _ => "error: pbcopy failed".into(),
            }
        }
        "clipboard_get" => {
            let mut cmd = std::process::Command::new("pbpaste");
            match run(&mut cmd) {
                Ok(t) if t.is_empty() => "（剪贴板为空）".into(),
                Ok(t) => t.chars().take(2000).collect(),
                Err(e) => e,
            }
        }
        "notify" => {
            let (title, msg) = (s("title"), s("message"));
            if msg.is_empty() {
                return "error: missing 'message'".into();
            }
            let esc = |t: &str| t.replace('\\', "\\\\").replace('"', "\\\"");
            let script = format!(
                "display notification \"{}\" with title \"{}\"",
                esc(msg),
                esc(if title.is_empty() { "AX Explorer" } else { title })
            );
            let mut script_cmd = std::process::Command::new("osascript");
            script_cmd.arg("-e").arg(&script);
            match run(&mut script_cmd) {
                Ok(_) => "已发送系统通知".into(),
                Err(e) => e,
            }
        }
        "open_url" => {
            let url = s("url");
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return "error: url 必须是 http(s):// 开头".into();
            }
            let mut open_cmd = std::process::Command::new("open");
            open_cmd.arg(url);
            match run(&mut open_cmd) {
                Ok(_) => format!("已在默认浏览器打开 {url}"),
                Err(e) => e,
            }
        }
        "speak" => {
            let text = s("text");
            if text.is_empty() {
                return "error: missing 'text'".into();
            }
            let mut say_cmd = std::process::Command::new("say");
            say_cmd.arg(text);
            match run(&mut say_cmd) {
                Ok(_) => "已朗读".into(),
                Err(e) => e,
            }
        }
        "screen_info" => {
            // NSScreen::screens requires a main-thread marker. `exec` may run
            // on a background thread, so commands::desktop_tool_exec dispatches
            // this one call to the main thread before it gets here.
            let Some(mtm) = objc2::MainThreadMarker::new() else {
                return "error: 不在主线程，无法读取屏幕信息".into();
            };
            let screens: Vec<serde_json::Value> = {
                NSScreen::screens(mtm)
                    .iter()
                    .enumerate()
                    .map(|(i, sc)| {
                        let f = sc.frame();
                        serde_json::json!({
                            "index": i,
                            "origin": [f.origin.x, f.origin.y],
                            "size": [f.size.width, f.size.height],
                        })
                    })
                    .collect()
            };
            serde_json::to_string(&screens).unwrap_or_else(|_| "error: serialize".into())
        }
        "frontmost_app" => {
            use objc2_app_kit::NSWorkspace;
            let app = NSWorkspace::sharedWorkspace().frontmostApplication();
            match app {
                Some(a) => format!(
                    "{} (pid {})",
                    a.localizedName().map(|n| n.to_string()).unwrap_or_default(),
                    a.processIdentifier()
                ),
                None => "error: 无法获取前台应用".into(),
            }
        }
        "profile_search" => {
            // Personal-profile RAG retrieval from the local langchain-llm-toolkit
            // (127.0.0.1:8001). The agent is the LLM: it needs the source
            // snippets, not a generated answer, so we call the search-only
            // endpoint. Credentials belong in env (PROFILE_RAG_URL/KEY), not in
            // the source tree.
            let query = s("query");
            if query.is_empty() {
                return "error: missing 'query'".into();
            }
            let k = args.get("k").and_then(|v| v.as_u64()).unwrap_or(4).min(8);
            let base = std::env::var("PROFILE_RAG_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8001".to_string());
            let Some(key) = std::env::var("PROFILE_RAG_KEY").ok().filter(|v| !v.trim().is_empty())
            else {
                return "error: 未配置 PROFILE_RAG_KEY 环境变量，无法访问本地资料库".into();
            };
            let body = format!("{{\"query\":{},\"k\":{}}}", serde_json::to_string(&query).unwrap_or_default(), k);
            let out = std::process::Command::new("curl")
                .args([
                    "-s", "-m", "20",
                    "-X", "POST", &format!("{base}/api/v1/rag/search"),
                    "-H", &format!("X-API-Key: {key}"),
                    "-H", "Content-Type: application/json",
                    "-d", &body,
                ])
                .output();
            match out {
                Ok(o) if o.status.success() => {
                    let text = String::from_utf8_lossy(&o.stdout).to_string();
                    match serde_json::from_str::<serde_json::Value>(&text) {
                        Ok(v) => {
                            let sources = v
                                .get("sources")
                                .and_then(|s| s.as_array())
                                .cloned()
                                .unwrap_or_default();
                            if sources.is_empty() {
                                return "（个人资料库没有相关内容——资料服务未导入或没建库）".into();
                            }
                            let parts: Vec<String> = sources
                                .iter()
                                .take(k as usize)
                                .enumerate()
                                .map(|(i, s)| {
                                    let m = s.get("metadata").cloned().unwrap_or_default();
                                    let cat = m.get("category").and_then(|c| c.as_str()).unwrap_or("");
                                    let file = m.get("file").and_then(|f| f.as_str()).unwrap_or("");
                                    let content = s.get("content").and_then(|c| c.as_str()).unwrap_or("");
                                    format!("【{i}】[{cat}]{file}\n{}", content.chars().take(400).collect::<String>())
                                })
                                .collect();
                            format!("个人资料相关片段：\n{}", parts.join("\n---\n"))
                        }
                        Err(e) => format!("error: 解析资料服务响应失败: {e}"),
                    }
                }
                Ok(o) => format!(
                    "error: 资料服务不可达（{}），确认 langchain-llm-toolkit 在 8001 端口运行",
                    o.status
                ),
                Err(e) => format!("error: curl 调用失败: {e}"),
            }
        }
        other => format!("error: 未知桌面工具 {other}"),
    }
}
