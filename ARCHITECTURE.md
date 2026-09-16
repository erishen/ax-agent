# AX Agent 架构文档

> macOS Computer Use：让 agent「看懂 + 自由操作」任意运行中的应用。
> 技术栈：Rust + Tauri 2 + React 19 + TypeScript。本文档面向二次开发与故障排查，描述 2026-09 时点的实际架构。

---

## 1. 总览

AX Agent 是**通用桌面操控基座**，不是快捷方式工具。它把「屏幕观察」与「界面操作」抽象成两层能力：

| 通道 | 机制 | 特点 |
| --- | --- | --- |
| **语义层** | macOS Accessibility API（AXUIElement） | 不占用真实键鼠、不要求元素可见；只能做应用暴露的动作 |
| **合成层** | CGEvent 注入（HID tap） | 模拟真实键鼠/滚轮；能触达自绘控件，但只投给最前台应用 |

两个通道互补，由前端统一编排。上层提供三种使用形态：

1. **💬 会话（离线指令模式）**：本地正则解析中文指令 → 单步执行（不依赖 LLM）
2. **🤖 智能模式（LLM 代理）**：OpenAI 兼容 API + tool calling，模型规划多步任务并自动执行（25 步预算）
3. **🔎 检查器**：手动选应用、看 AX 树、逐元素操作（调试/开发用）

```
┌──────────────────────────── 前端 (React + TS) ────────────────────────────┐
│  App.tsx (权限门/Tab)   ChatView.tsx (会话UI)   Inspector.tsx (检查器)    │
│                                                                            │
│  chat.ts ── 会话编排: 指令解析 / agent循环(runSteps) / 工具分发(runTool)   │
│     │                    │                                                 │
│     │ 离线指令模式        │ 智能模式                                        │
│     ▼                    ▼                                                 │
│  parseCommand          llm.ts (OpenAI兼容 SSE + tool calling)             │
│     │                    │                                                 │
│     └──────────┬─────────┘                                                 │
│                ▼                                                           │
│  tools/ (工具层)  observe · input · window · misc · shared                 │
│  netease-ui.ts / tencent-ui.ts (自绘UI决策状态机)   windowctl.ts (分屏)    │
│  tool-utils.ts / tree-utils.ts (纯决策纯函数)                              │
└───────────────┬───────────────────────────────────────────────────────────┘
                │ Tauri invoke (IPC)
┌───────────────▼────────────────── Rust 后端 ───────────────────────────────┐
│  commands/ (命令层)  permissions · apps · tree · screen · input · misc     │
│  ax_core.rs   AX基础: 权限/枚举/树遍历/属性/perform action                  │
│  ax_act.rs    语义操作 + CGEvent 合成 + frontmost_guard                    │
│  ax_open.rs   应用启动/聚焦 (bundle id 优先 + 中文别名)                     │
│  ocr.rs       Apple Vision 屏幕文字识别                                     │
│  llm.rs       LLM 配置/流式对话/重试/tsm-hub 目录                           │
│  desktop_tools.rs  本地桌面工具 (clipboard/fs/notify/…)                    │
│  mcp_client.rs  stdio MCP 客户端 (JSON-RPC 2.0)                            │
│  rpc.rs       127.0.0.1 JSON-RPC loopback (Bearer token)                   │
│  lib.rs       命令注册 + 会话日志落盘                                       │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 前端架构

### 2.1 会话状态（SessionState）

`chat.ts` 维护单一不可变状态对象（每次操作返回新 state）：

- `pid` / `appName`：当前目标应用（工具间共享，`uiKind()` 据此路由到对应状态机）
- `outline`：最近一次 AX 树快照（扁平化大纲，`tree-utils.ts` 渲染）
- `llmHistory`：与 LLM 的消息历史（agent 循环续传）
- `pending`：**危险操作确认挂起项**（`{name, args, reason}`，等用户批准）
- `appName` / `timestamps`：观察快照时间戳（60s 过期守卫依据）

### 2.2 双模式

**离线指令模式**（`parseCommand`）——单条命令，本地执行，无网络：

```
打开 <应用> · 应用列表 · 读一下 [应用] · 找 <关键词> · 点击 <关键词>
· 输入 <文本> [@字段] · 聚焦 <关键词> · 移动窗口 <x> <y> · 点 <x> <y> · 帮助
```

关键细节：`open_app` 解析「应用名 + 后续步骤」——离线模式只能执行单条命令，若用户消息包含后续步骤（如"打开日历，然后看今天日程"），会提示用户配置 LLM 后重发。

**智能模式**（`runSteps`）——agent 循环，核心流程：

```
┌─ 每段任务 (最多 MAX_AGENT_STEPS=25 步) ─────────────────────┐
│ 1. 注入系统提示: 权限缺失清单(environmentLimitNote)          │
│    + 跨会话记忆(memoryList: 常用应用)                        │
│ 2. 循环:                                                     │
│    a. 调 llmChat(history + tools) → 模型输出                 │
│    b. 若含 tool_calls → runTool 逐个执行                     │
│       · dangerousReason 命中 → 挂起 pending，等用户批准      │
│       · 执行结果写回 history，提交视图进度                    │
│    c. 模型输出正文 → 追加 history                             │
│    d. 检查 stopRequested / 步数耗尽 → 暂停可「继续」          │
│ 3. 模型 done → 结束，会话转录落盘                             │
└──────────────────────────────────────────────────────────────┘
```

循环内三个关键守卫：

- **权限预注入**：每段任务开始前查一次系统权限，把缺失能力写进系统提示（模型不再烧步数试错）
- **重复调用签名守卫**：记录最近 4 次工具调用签名，模型原地打转（重复点击同一坐标）时给出纠正提示
- **危险操作确认**：见 §5.3

### 2.3 工具层（src/tools/）

| 模块 | 工具 | 职责 |
| --- | --- | --- |
| `observe.ts` | list_apps · read_screen · wait_for · ocr · find | 观察：AX 树、OCR、等待、检索 |
| `input.ts` | click · type_text · focus · click_at · double_click_at · right_click_at · drag · scroll · type_keys · key · scroll_to | 语义 + 合成输入（含 60s 快照守卫、重复点击守卫、自绘 UI 点击守卫） |
| `window.ts` | move_window · resize_window · element_at · named_action | 窗口与元素定位 |
| `misc.ts` | open_app · menu_bar · menu_click · done · desktop 透传 | 应用启动、菜单、收尾、桌面工具转发 |
| `shared.ts` | ToolResult / 观察快照 / 大纲刷新 / clamp | 共享辅助 |

工具调用统一入口 `runTool`（chat.ts）：按名字分发到对应实现，危险判定先行。

### 2.4 自绘 UI 决策状态机（netease-ui / tencent-ui）

网易云音乐、腾讯视频是自绘 Chromium UI（AX 树几乎为空），无法用语义操作，必须 ocr + 坐标点击。每个目标应用族对应一个**可回归测试的状态机**：

- **页面分类**：从 OCR 词列表识别当前页面（首页/歌单页/详情页/播放中…）
- **点击守卫**：拦截「同一位置反复点击」「点首页卡片直接播放无关内容」等已知失败模式，输出纠正提示
- **证据判定**：播放成功 = 底部播放栏歌名切换（旧歌不算）；评分达标 = 详情页 ocr 复核
- **状态更新**：维护播放过的歌曲列表，防止重复点播

架构：`chat.ts` 持有状态机实例，把 ocr / click_at / scroll 结果路由给它；所有判定逻辑是纯函数，`tests/netease-ui.test.mjs` / `tests/tencent-ui.test.mjs` 用真实会话词表回归。

### 2.5 窗口管理（windowctl.ts）

驱动目标应用时，把 ax-agent 自己的窗口**停靠到目标不占用的屏幕角落**（紧凑面板），保持目标应用前台——合成鼠标只投给最前台应用，窗口抢占焦点会破坏后续点击。

### 2.6 纯决策层（tool-utils.ts / tree-utils.ts）

从 chat.ts 抽出的**无 IO 纯函数**：窗口布局计算、OCR 质量判定、导航词识别、应用名解析（`resolveAppMatch`）、菜单过滤、危险词判定等。全部可单测（`tests/tool-utils.test.mjs` 等 8 个测试文件）。

---

## 3. Rust 后端架构

### 3.1 命令层（commands/）

薄封装层：`#[tauri::command(async)]` + 参数校验 + 错误字符串化。六模块：

- `permissions.rs`：权限状态/申请/诊断（进程链 + responsible process）
- `apps.rs`：应用枚举（`ax_list_apps` 返回 pid/name/bundle_id/is_active）
- `tree.rs`：AX 树读取/路径解析/属性读写
- `screen.rs`：窗口位置/截图/OCR/观察等待
- `input.rs`：合成输入命令（**每个都先跑 `frontmost_guard(pid)`**）
- `misc.rs`：open_app / menu / memory / installed_apps / local_apps_config

### 3.2 AX 核心（ax_core.rs）

- **权限**：AXIsProcessTrustedWithOptions 检测 + 申请弹窗
- **枚举**：NSWorkspace.runningApplications
- **树遍历**：AXUIElementCopyAttributeValue 有界深度（2s 超时），节点序列化为 `ExportNode`（role/title/value/位置/子索引路径）
- **动作**：AXUIElementPerformAction / AXValue 读写 / AXFocused 写入
- **命中测试**：AXUIElementCopyElementAtPosition（system-wide）

### 3.3 执行层（ax_act.rs）

- **语义操作**：`ax_set_value` / `ax_focus_element` / `ax_set_position` / `ax_scroll_to_visible` / `ax_named_action`
- **合成输入**：CGEvent 构造 + `post(CGEventTapLocation::HID)`——**HID tap 路径**（不是 CGEventPostToPid，自绘应用会忽略定向事件）
- **前台守卫 `frontmost_guard(pid)`**：点击/输入前检查前台，不一致则 `activate_pid` + 等待 400ms + 复查；激活失败不阻断（事件仍投出，由观察层发现）

### 3.4 应用启动（ax_open.rs）

- 中文名 → bundle id 解析表（`SYSTEM_APPS`）+ 已安装应用扫描（/Applications 等，读 Info.plist）
- `open -b <bundle_id>` 优先（规避 locale 对中文名的解析失败）
- 启动后轮询 `runningApplications` 拿新 pid

### 3.5 OCR（ocr.rs）

Apple Vision（VNRecognizeTextRequest）截屏识别，返回**屏幕坐标**（points，左上原点）+ 置信度。前端直接 `click_at` 这些坐标。OCR 质量低时（大量置信 30% 乱码词）给出提示，引导模型等加载/换窗口状态。

### 3.6 LLM 桥（llm.rs）

- **配置**：保存设置（llm.json）> env/`.env` > 内置默认；`api_key` **永不过 IPC**（前端只知 has_key）
- **对话**：OpenAI 兼容 `/chat/completions`，流式（SSE → `llm://delta` 事件）与非流式双通道
- **重试**：429 / 502 / 503 / 504 + 抖动退避
- **网关**：tsm-hub 技能/工具/MCP 目录（`llm_skills` / `llm_catalog`），驱动示例任务 chips

### 3.7 桌面工具（desktop_tools.rs）

tsm-hub 网关没有的本地能力，跑在本进程：`clipboard_set/get` · `notify` · `open_url` · `speak` · `screen_info` · `frontmost_app` · `profile_search`（本地 RAG 127.0.0.1:8001）· `fs_scan` · `fs_move`。工具目录（`desktop_tool_catalog`）+ 执行（`desktop_tool_exec`）双命令，前端按需透传。

### 3.8 MCP 客户端（mcp_client.rs）

本地 gitignored `mcp.local.json` 挂载 MCP 服务器（tsm-hub 未挂载的）：**每次调用 spawn → initialize → tools/list 或 tools/call → kill**（JSON-RPC 2.0 over stdio）。短生命周期设计，无泄漏子进程，启动毫秒级。

### 3.9 RPC loopback（rpc.rs）

- **绑定**：127.0.0.1 仅本机；端口 `AX_RPC_PORT`（默认 8931）
- **鉴权**：`/health` 开放（仅 ok）；`/rpc` 需 Bearer token（`~/.ax-agent/rpc.token` 0600 或 `AX_RPC_TOKEN`，生成一次）
- **用途**：CLI / 外部脚本以 JSON-RPC 驱动（等价 Tauri 命令子集，含截图/点击/输入/OCR）
- **隔离**：在独立 tokio runtime 的 background 线程（Tauri setup 主线程无 reactor）

### 3.10 会话日志（lib.rs `append_session_log`）

智能模式结束把完整转录（指令/工具调用/OCR 文字）追加到 `<app_data>/logs/sessions.md`：目录 0700、文件 0600、**1MB 轮转**（归档一份后开新文件）。删除文件即清除历史。

---

## 4. 关键设计决策

| 决策 | 内容 | 动机 |
| --- | --- | --- |
| **子索引路径定位** | AX 句柄不能跨 IPC 持久化 → 操作按「树转储时记录的子索引路径」寻址 | 每次操作前重查树太慢，路径定位一次转储多次使用 |
| **relocate 重定位** | 路径失效时按 `{role, label}` hint 重搜树重试一次 | UI 变化后路径过期，自动恢复而不是失败 |
| **HID 事件而非定向事件** | `event.post(HID)` 代替 CGEventPostToPid | 自绘/游戏类应用忽略定向事件，HID 路径总能到达 |
| **frontmost_guard** | 合成输入前激活目标 + 复查 | 合成鼠标只投给最前台应用 |
| **bundle id 启动** | `open -b` 优先，中文名先解析成 bundle id | locale 英文时 `open -a 备忘录` 失败 |
| **显示名统一** | open_app 回显 display name；所有按名工具走 `resolveAppMatch`（display/bundle_id/pid） | 避免模型学到其他工具不认的名字 |
| **密码框拒绝** | AXSecureTextField/AXPasswordField 输入侧拦截 | 敏感信息只由用户本人输入 |
| **60s 快照守卫** | 坐标/合成输入基于 60s 内观察，过期先重新观察 | 旧坐标点击会落空或点错 |
| **危险操作确认** | 命中危险词/高风险操作 → pending 等用户批准 | 不可逆动作（删除/发送/移动/读剪贴板/扫个人目录）需要人确认 |
| **零 shell 调用** | open/fs/OCR 全走 Command 参数，无 `sh -c` | 消除命令注入面 |
| **RPC token 文件** | token 存 0600 文件，/health 免鉴权 | 本地进程也可能有恶意，端口服务必须锁 |

### 4.1 危险操作确认清单（dangerousReason）

| 触发 | 理由 |
| --- | --- |
| `key` 含 enter/return | 可能触发发送/提交/删除 |
| `fs_move` 且 `dry_run=false` | 真实移动文件（批量影响） |
| `clipboard_get` | 剪贴板内容注入模型上下文发往 LLM |
| `fs_scan` 个人路径（`~/`、`/Users/…`） | 文件名/元数据可能是个人文件，随上下文外发 |
| `click/named_action/menu_click` 命中删除/发送/退出登录等词 | 不可逆界面动作 |
| 窗口关闭/最小化按钮 | 关闭整个应用窗口 |

---

## 5. 数据流

### 5.1 观察 → 操作循环（核心）

```
open_app / read_screen / ocr / wait_for
        │  (刷新 state.outline + 时间戳)
        ▼
模型/指令 决策 → find/定位元素 → 语义操作 或 坐标点击
        │
        ▼
操作后自动刷新大纲 → 验证效果（ocr / wait_for / read_screen）
```

### 5.2 智能模式 LLM 数据流

```
屏幕内容 (AX树/OCR文字) ──▶ 前端组装 system prompt + tools
        │ invoke llm_chat/llm_chat_stream
        ▼
Rust llm.rs ──▶ 配置的 LLM API (用户自配端点，可本地 tsm-hub)
        │ SSE 流式返回
        ▼
前端解析 tool_calls → runTool 本地执行 → 结果回填 → 下一轮
```

### 5.3 危险操作确认流

```
runTool 命中 dangerousReason
   → 返回 { dangerous, result: "⏸ 等待用户确认" }
   → runSteps 存入 state.pending，UI 底部弹出确认条
   → confirmPending(approve=true) 以 confirmed:true 重放该工具
   → 拒绝则丢弃，模型继续
```

---

## 6. 测试架构

```
tests/                          # 前端纯函数/状态机回归 (node:test, 159 用例)
├── agent-config.test.mjs       # SYSTEM_PROMPT / dangerousReason / 环境注记
├── tool-utils.test.mjs         # 应用解析 / 窗口布局 / OCR 判定 (纯函数)
├── tree-utils.test.mjs         # AX 树渲染 / find 检索
├── guard.test.mjs              # 点击守卫 / 重复点击拦截
├── netease.test.mjs            # 网易云 OCR 词处理 / 歌名配对
├── netease-ui.test.mjs         # 网易云决策状态机 (真实会话词表)
├── tencent.test.mjs / tencent-ui.test.mjs   # 腾讯视频同构
└── finder-archive.test.mjs     # 访达归档流程

src-tauri/                      # Rust lib 测试 (27 用例)
└── desktop_tools.rs 内嵌测试    # fs_scan/fs_move 等
```

- 前端：`npm test`（node:test，纯函数无 mock）
- Rust：`cargo test -p ax-agent --no-default-features --lib`（**禁止整 workspace**——会触发无关大数据依赖全量编译）
- 门禁：`make lint`（tsc + clippy -D warnings）；pre-commit hook 只查 `.ts` 的 `tsc --noEmit`

---

## 7. 目录结构

```
ax-agent/
├── src/                        # React + TS 前端
│   ├── App.tsx                 # 权限门 / 会话↔检查器 Tab
│   ├── ChatView.tsx            # 会话 UI（气泡 / 输入框 / 隐私提示 / 确认条）
│   ├── chat.ts                 # 会话编排：指令解析 + agent 循环 + runTool 分发
│   ├── llm.ts                  # LLM 工具 schema + 对话补全 (SSE) + 目录
│   ├── agent-config.ts         # 系统提示词 / 危险词 / 策略常量
│   ├── tool-utils.ts           # 纯决策函数（应用解析/守卫/布局）
│   ├── tree-utils.ts           # AX 树渲染 / 检索纯函数
│   ├── examples.ts             # 内置示例任务 chips
│   ├── finder-archive.ts       # 访达归档工作流
│   ├── tencent.ts / tencent-ui.ts   # 腾讯视频自绘 UI 决策状态机
│   ├── netease.ts / netease-ui.ts   # 网易云自绘 UI 决策状态机
│   ├── windowctl.ts            # 分屏停靠 / 前台保持
│   ├── tools/                  # 工具层（observe/input/window/misc/shared）
│   └── api.ts / types.ts       # invoke 封装 / 类型
├── tests/                      # 前端回归测试（node:test）
├── src-tauri/
│   ├── src/ax_core.rs          # AX 基础
│   ├── src/ax_act.rs           # 语义+合成操作 / frontmost_guard
│   ├── src/ax_open.rs          # 应用启动/聚焦
│   ├── src/ocr.rs              # Apple Vision OCR
│   ├── src/llm.rs              # LLM 桥 / 网关
│   ├── src/desktop_tools.rs    # 本地桌面工具
│   ├── src/mcp_client.rs       # stdio MCP 客户端
│   ├── src/rpc.rs              # JSON-RPC loopback
│   ├── src/commands/           # Tauri 命令层（六模块）
│   └── src/lib.rs              # 命令注册 + 会话日志
├── app-icon.svg
├── README.md / README.zh.md    # 使用文档（双语）
└── Makefile                    # dev / lint / test 工作流
```

---

## 8. 演进路线（TODO.md 摘要）

1. **观察闭环**：AXObserver 事件订阅（替代轮询快照）、截图对齐、overlay 标注
2. **合成输入完善**：手势/多键组合/拖拽增强
3. **Agent 接口层**：observe/act JSON-RPC 契约化、动作后验证、自动重定位强化
4. **状态机扩展**：更多自绘 UI 应用（自绘列表/图表类）接入 ocr + 状态机模式
