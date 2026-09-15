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
        DesktopTool {
            name: "fs_scan".into(),
            description: "扫描目录列出文件/子目录（名称/扩展名/大小/修改时间），供文件归档与整理决策使用。返回 JSON 数组，按修改时间倒序".into(),
        },
        DesktopTool {
            name: "fs_move".into(),
            description: "批量移动/重命名文件（仅移动，永不删除）。dry_run=true（默认）只校验并报告计划，不真正移动；dry_run=false 才执行。目标重名时自动追加序号，绝不覆盖".into(),
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
        "fs_scan" => fs_scan(args),
        "fs_move" => fs_move(args),
        other => format!("error: 未知桌面工具 {other}"),
    }
}

// ---------------------------------------------------------------------------
// File archiving tools: fs_scan (read-only) + fs_move (move-only, never deletes)
// ---------------------------------------------------------------------------

/// Expand a leading `~` to the caller's home directory.
fn expand_tilde(p: &str) -> String {
    if p == "~" {
        std::env::var("HOME").unwrap_or_default()
    } else if let Some(rest) = p.strip_prefix("~/") {
        format!("{}/{}", std::env::var("HOME").unwrap_or_default(), rest)
    } else {
        p.to_string()
    }
}

/// True if `child` is `parent` itself or lives anywhere under it.
fn is_inside(child: &std::path::Path, parent: &std::path::Path) -> bool {
    child.starts_with(parent)
}

/// If `target` exists, return a non-colliding "name (n).ext" sibling.
fn unique_target(target: &std::path::Path) -> std::path::PathBuf {
    if !target.exists() {
        return target.to_path_buf();
    }
    let parent = target.parent().unwrap_or_else(|| std::path::Path::new("."));
    let stem = target
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let ext = target
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for n in 1..10_000 {
        let candidate = parent.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    // Practically unreachable; fall back to a timestamped name.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    parent.join(format!("{stem}-{ts}{ext}"))
}

/// List a directory (bounded depth) as JSON rows for the model to reason over.
fn fs_scan(args: &serde_json::Value) -> String {
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .map(expand_tilde)
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| ".".to_string());
    let root = std::path::PathBuf::from(&path);
    if !root.is_dir() {
        return format!("error: 目录不存在或不可读: {path}");
    }
    let max_depth = args
        .get("max_depth")
        .and_then(|v| v.as_u64())
        .unwrap_or(1)
        .min(3) as usize;
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(500)
        .min(2000) as usize;

    let mut rows: Vec<serde_json::Value> = Vec::new();
    let mut stack: Vec<(std::path::PathBuf, usize)> = vec![(root.clone(), 0)];
    let mut skipped_dirs = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        // Subdirectories at the depth cap are listed (as rows) but their
        // contents are not expanded.
        if depth > 0 && depth >= max_depth {
            continue;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue, // unreadable subdir: skip silently
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue; // dotfiles stay out of the archive plan
            }
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let is_dir = meta.is_dir();
            let rel = path
                .strip_prefix(&root)
                .map(|r| r.to_string_lossy().to_string())
                .unwrap_or_else(|_| name.clone());
            rows.push(serde_json::json!({
                "path": path.to_string_lossy(),
                "name": name,
                "rel": rel,
                "ext": path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default(),
                "size": meta.len(),
                "mtime": meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0),
                "is_dir": is_dir,
            }));
            if is_dir && depth < max_depth {
                if meta.file_type().is_symlink() {
                    skipped_dirs += 1;
                } else {
                    stack.push((path, depth + 1));
                }
            }
            if rows.len() >= limit {
                break;
            }
        }
        if rows.len() >= limit {
            break;
        }
    }
    rows.sort_by(|a, b| b["mtime"].as_u64().cmp(&a["mtime"].as_u64()));
    let mut out = serde_json::to_string(&rows).unwrap_or_else(|_| "error: serialize".into());
    if skipped_dirs > 0 {
        out.push_str(&format!("\n(跳过 {skipped_dirs} 个符号链接目录)"));
    }
    if rows.len() >= limit {
        out.push_str(&format!("\n(已达 {limit} 条上限，可加 max_depth/limit 或缩小目录范围)"));
    }
    out
}

/// Move/rename files. dry_run=true (default) validates and reports only.
/// Never deletes, never overwrites — colliding targets get a " (n)" suffix.
fn fs_move(args: &serde_json::Value) -> String {
    let dry_run = args
        .get("dry_run")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let Some(moves) = args.get("moves").and_then(|v| v.as_array()) else {
        return "error: 缺少 moves 数组（[{from, to}, …]）".into();
    };
    if moves.is_empty() {
        return "error: moves 为空".into();
    }

    let mut lines: Vec<String> = Vec::new();
    let mut ok_count = 0usize;
    for (i, m) in moves.iter().enumerate() {
        let from = m
            .get("from")
            .and_then(|v| v.as_str())
            .map(expand_tilde)
            .unwrap_or_default();
        let to = m
            .get("to")
            .and_then(|v| v.as_str())
            .map(expand_tilde)
            .unwrap_or_default();
        let (src, dst) = (std::path::PathBuf::from(&from), std::path::PathBuf::from(&to));
        let label = format!("#{i}: {from} → {to}");
        if from.is_empty() || to.is_empty() {
            lines.push(format!("{label} 失败: 路径不完整"));
            continue;
        }
        if !src.is_absolute() || !dst.is_absolute() {
            lines.push(format!("{label} 失败: 必须是绝对路径（可用 ~ 开头）"));
            continue;
        }
        if !src.exists() {
            lines.push(format!("{label} 失败: 源不存在"));
            continue;
        }
        if src == dst {
            lines.push(format!("{label} 跳过: 源与目标相同"));
            ok_count += 1;
            continue;
        }
        // Refuse to move a directory into itself (would loop forever).
        if src.is_dir() && is_inside(&dst, &src) {
            lines.push(format!("{label} 失败: 不能把目录移动到自己内部"));
            continue;
        }
        if let Some(parent) = dst.parent() {
            if !parent.is_dir() {
                lines.push(format!("{label} 失败: 目标父目录不存在: {}", parent.display()));
                continue;
            }
        }
        let final_dst = unique_target(&dst);
        if final_dst != dst {
            lines.push(format!(
                "{label} 目标已存在，将改用: {}",
                final_dst.display()
            ));
        }
        if dry_run {
            lines.push(format!("{label} (dry-run，未执行)"));
            ok_count += 1;
            continue;
        }
        // Battle-tested system binary: handles cross-volume moves automatically.
        let st = std::process::Command::new("/bin/mv")
            .arg(&src)
            .arg(&final_dst)
            .status();
        match st {
            Ok(s) if s.success() => {
                lines.push(format!("{label} ✓ → {}", final_dst.display()));
                ok_count += 1;
            }
            Ok(s) => lines.push(format!(
                "{label} 失败: mv 退出码 {}",
                s.code().unwrap_or(-1)
            )),
            Err(e) => lines.push(format!("{label} 失败: {e}")),
        }
    }
    let mode = if dry_run { "dry-run 预演" } else { "已执行" };
    format!(
        "[fs_move {mode}] 成功 {ok_count}/{} 项\n{}",
        moves.len(),
        lines.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!(
            "ax-fs-test-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn expand_tilde_resolves_home() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(expand_tilde("~"), home);
        assert_eq!(expand_tilde("~/x"), format!("{home}/x"));
        assert_eq!(expand_tilde("/abs/path"), "/abs/path");
    }

    #[test]
    fn unique_target_appends_suffix_on_collision() {
        let d = tmpdir("unique");
        let a = d.join("a.txt");
        fs::write(&a, "1").unwrap();
        let b = d.join("b.txt");
        // b does not exist → unchanged
        assert_eq!(unique_target(&b), b);
        // a exists → gets " (1)" suffix
        let uniq = unique_target(&a);
        assert_eq!(uniq, d.join("a (1).txt"));
        fs::write(&uniq, "2").unwrap();
        assert_eq!(unique_target(&a), d.join("a (2).txt"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn is_inside_detects_subtree() {
        let root = std::path::Path::new("/a/b");
        assert!(is_inside(std::path::Path::new("/a/b/c"), root));
        assert!(is_inside(root, root));
        assert!(!is_inside(std::path::Path::new("/a/bc"), root));
        assert!(!is_inside(std::path::Path::new("/a"), root));
    }

    #[test]
    fn fs_scan_lists_files_bounded() {
        let d = tmpdir("scan");
        fs::write(d.join("one.txt"), "x").unwrap();
        fs::write(d.join("two.png"), "y").unwrap();
        let sub = d.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("deep.txt"), "z").unwrap();
        let out = fs_scan(&serde_json::json!({ "path": d.to_string_lossy() }));
        let rows: serde_json::Value = serde_json::from_str(&out).unwrap();
        let arr = rows.as_array().unwrap();
        // default max_depth=1: sub listed as dir, its child not expanded
        let names: Vec<&str> = arr.iter().map(|r| r["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"one.txt"));
        assert!(names.contains(&"two.png"));
        assert!(names.contains(&"sub"));
        assert!(!names.contains(&"deep.txt"));
        // one.txt row has the metadata fields
        let one = arr.iter().find(|r| r["name"] == "one.txt").unwrap();
        assert_eq!(one["ext"], "txt");
        assert_eq!(one["size"], 1);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn fs_move_dry_run_does_not_touch_disk() {
        let d = tmpdir("dry");
        let src = d.join("keep.txt");
        fs::write(&src, "data").unwrap();
        let dst = d.join("moved.txt");
        let out = fs_move(&serde_json::json!({
            "moves": [{ "from": src.to_string_lossy(), "to": dst.to_string_lossy() }],
            "dry_run": true
        }));
        assert!(out.contains("dry-run"));
        assert!(src.exists(), "dry-run 不得移动文件");
        assert!(!dst.exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn fs_move_moves_and_renames_on_collision() {
        let d = tmpdir("move");
        let src = d.join("a.txt");
        fs::write(&src, "data").unwrap();
        let dst = d.join("target.txt");
        fs::write(&dst, "existing").unwrap();
        let out = fs_move(&serde_json::json!({
            "moves": [{ "from": src.to_string_lossy(), "to": dst.to_string_lossy() }],
            "dry_run": false
        }));
        assert!(out.contains("已执行"));
        assert!(out.contains("target (1).txt"), "冲突时应加后缀: {out}");
        assert!(!src.exists());
        assert!(d.join("target (1).txt").exists());
        assert_eq!(fs::read_to_string(d.join("target (1).txt")).unwrap(), "data");
        assert_eq!(fs::read_to_string(&dst).unwrap(), "existing");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn fs_move_rejects_missing_source_and_dir_into_self() {
        let d = tmpdir("bad");
        let ghost = d.join("ghost.txt");
        let out = fs_move(&serde_json::json!({
            "moves": [{ "from": ghost.to_string_lossy(), "to": d.join("x.txt").to_string_lossy() }],
            "dry_run": false
        }));
        assert!(out.contains("源不存在"));
        // directory into itself
        let sub = d.join("sub");
        fs::create_dir_all(sub.join("inner")).unwrap();
        let out2 = fs_move(&serde_json::json!({
            "moves": [{ "from": sub.to_string_lossy(), "to": sub.join("inner").to_string_lossy() }],
            "dry_run": false
        }));
        assert!(out2.contains("自己内部"), "{out2}");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn fs_move_requires_absolute_paths() {
        let out = fs_move(&serde_json::json!({
            "moves": [{ "from": "relative.txt", "to": "/tmp/x.txt" }],
            "dry_run": false
        }));
        assert!(out.contains("绝对路径"));
    }
}
