# TODO — ax-agent → macOS Computer Use

项目定位：**Computer Use for macOS** —— 让 agent 能「看懂 + 操作」任意应用，
以 Accessibility (AXUIElement) 为语义操作通道，CGEvent 为兜底合成输入通道。
（不再只是 AX 树查看器。）

> **收尾状态（2026-09）**：核心能力已全部落地并验证（观察/操作闭环、LLM 智能模式、
> 自绘 UI 支持、打包产物）。下文 `[ ]` 项均为**可选增强**，不影响项目收尾使用。

## 里程碑 1 — Actuation 基础（本轮已完成 ✅）

- [x] `AXPress` 等 semantic action（已有）
- [x] `ax_set_value`：写 `AXValue`（无合成键盘事件的「输入文本」）
- [x] `ax_focus_element`：写 `AXFocused` 抢焦点
- [x] `ax_set_position`：写 `AXPosition` 移动窗口
- [x] `ax_element_at`：`AXUIElementCopyElementAtPosition` 屏幕坐标点选（system-wide）

## 里程碑 1.5 — 可跑的端到端示例（部分完成）

- [x] `examples/textedit_demo.rs`：TextEdit 全自动（定位→聚焦→写入→移窗→验证）
- [x] `examples/probe_at.rs`：屏幕坐标点选示例
- [x] 更多示例：keyboard / mouse / menu / wechat_stress（见 README「完整示例」）
- [x] 更多 App 示例：Finder（选文件/打开）、Calendar（建日程）、System Settings（切开关）— 可选增强（只读版示例已交付：访达最近文件/日历今日日程/系统设置显示器信息）
- [x] 示例参数化：目标 App / 文本从命令行传入 — 可选增强（textedit_demo 支持 bundle_id/文本/窗口坐标 CLI 参数）

## 里程碑 1.7 — 会话式操作界面（已完成 ✅，持续打磨）

- [x] 💬 会话 Tab（默认）：自然语言指令 → 执行 → 结果回复
- [x] 指令集：打开/应用列表/读一下/找/点击/输入/聚焦/移动窗口/点选/帮助
- [x] 会话内维护「当前应用 + 界面大纲」，关键词定位元素
- [x] LLM 接入：把「会话」从固定指令升级为真正的自然语言理解（本地模型或 API）——
      由里程碑 1.8 的智能模式完成，模糊指令可执行
- [x] 执行历史与撤销（如恢复被替换的文本框内容）
- [ ] 指令补全/快捷短语按钮 — 可选增强（示例 chips 已覆盖大部分场景）

## 里程碑 1.8 — LLM 智能模式（已完成 ✅，持续打磨）

- [x] 🤖 智能模式开关：LLM 规划多步操作，应用执行（OpenAI 兼容 API，tool calling）
- [x] Rust 端发请求：密钥存本地 llm.json，不出 webview
- [x] ⚙️ 设置弹窗：API 地址 / 密钥 / 模型 + 测试连接
- [x] 11 个工具：list_apps / open_app / read_screen / find / click / type_text / focus / move_window / element_at / ocr / done；步数上限 25 步，超限暂停后「继续」可携带完整上下文续跑（新额度）
- [x] LLM 限流自愈：共享 reqwest 连接池 + 200ms 限速门 + send_with_retry（RETRY_ATTEMPTS=5；429 尊重 Retry-After 上限 60s/缺省指数 2→32s+jitter；5xx 封顶 10s；其他 4xx 立即失败并 5s 冷却）
- [x] 执行过程流式展示（每个工具调用的参数与结果摘要）
- [x] 危险操作确认（如关闭应用、删除文本）
- [x] 安全机制：过期快照守卫（坐标/合成输入类工具 60s 未观察拒绝执行）+ 密码框保护
      （AXSecureTextField / AXPasswordField 拒绝自动输入）—— 借鉴 dsh-computer-use
- [x] 记忆：跨会话记住常用应用与习惯 — 可选增强（memory.json + system prompt 注入，已交付）

## 里程碑 2 — 观察与反馈闭环

- [x] `AXObserver` 订阅元素/窗口变化通知，树自动刷新 —— 最新着手项：
      `ax_act.rs` 新增对目标 pid 的 `AXObserver` 注册（feed 通知到 Tauri event `ax://change`），
      `ax_menu_bar` 也注册同 pid，命令/示例触发后 `runTool` 不再 sleep，而是 poll `ax://change` envelope 收到变动信号后再重读；
      用途文档写进 README 示例任务章
- [x] `AXUIElementCopyElementAtPosition` + 树内定位：点选后反查路径，直接接管该元素
- [x] 截图（`screencapture -l` 窗口级截图）与 AX 树坐标对齐，给 agent 提供「视觉 + 语义」双通道；Vision OCR（`ocr` 工具）：对窗口截图做 Apple Vision 文字识别，返回屏幕坐标，专供自绘 UI 替代 read_screen
- [x] 元素高亮 overlay 窗口（把 `AXPosition`+`AXSize` 画框），验证点选与坐标换算
- [x] AX 树导出 JSON（快照对比、喂给 LLM 做界面分析）

## 里程碑 3 — 合成输入（CGEvent 兜底）

- [x] `CGEventPost` 鼠标移动 / 点击 / 双击 / 右键 / 拖拽
- [x] `CGEventPost` 键盘事件（含修饰键组合、Unicode 文本输入 `CGEventKeyboardSetUnicodeString`）
- [~] 全局坐标与 `AXPosition`（top-left，points）与 CGEvent 坐标一致性验证；
      Retina 缩放、多显示器空间换算 —— 坐标夹回窗口（clampToWindow）+ 窗口移动后
      「旧坐标失效」提示已实现；完整多显示器换算为可选增强
- [x] 合成键盘输入（CGEvent 路线）：`ax_key`（单键/组合键 Cmd+F、Alt+Left…）与
      `ax_type_keys`（逐键输入，Unicode payload 支持中文/emoji，触发随输入即搜索等逐键反应）
      —— 见 `ax_act::press_key_combo` / `ax_act::type_text_synthetic`
- [x] 新增权限检测：`CGPreflightListenEventAccess` / `CGRequestListenEventAccess`
      （Input Monitoring）+ `CGPreflightPostEventAccess`（Accessibility 已含）
      —— `commands::PermissionOverview` + 权限页分项展示/请求

## 里程碑 4 — Agent 接口层

- [x] 稳定的 JSON-RPC / HTTP 接口：`observe`（树+截图）、`act`（click/type/key/drag/scroll/set）
      —— loopback 服务 `src-tauri/src/rpc.rs`（`http://127.0.0.1:8931/rpc`，POST JSON-RPC 2.0，
      `AX_RPC_PORT` 可改；方法见文件头注释），CLI 客户端 `scripts/ax-rpc.py`
- [x] `ax.observe.register` / `ax.observe.wait` / `ax.observe.unregister`：
      AXObserver 通知快路径（register 后 `wait_for_change` 提前唤醒）+ 合成事件计数器
      兜底（`last_trigger_bump`/`has_bumped_since`），超时退化为轮询
- [x] 动作后验证：`ax.set_value` 读回 AXValue 对比、`ax.set_position` 读回 AXPosition 比坐标
      （±2px），返回 `verified` 字段
- [x] 路径失效自动重定位：动作命令带 `relocate{role,label}` hint，路径失效时
      `ax_core::find_path_by_hint` 按 role+title 重搜树并重试一次（会话指令与 LLM 工具已接入）
- [x] 动作前置校验：settable 检查（`ax_act::set_value_for_path` 前置 is_settable +
      relocate 重试均已实现）
- [x] 滚动（`AXScrollToVisible` + CGEvent scroll wheel）：`ax_scroll`（合成滚轮事件，lines 正=上/负=下）、
      `ax_scroll_to_visible`（语义滚动）、`ax_named_action`（AXIncrement/AXDecrement/AXPick/AXShowMenu 等）
- [~] 菜单栏 / Dock / 通知中心 等系统 UI 的处理 —— 应用菜单栏已完成（`ax_menu_bar` /
      `menu_click`）；系统级 UI（Dock / 通知中心，`AXUIElementCreateSystemWide`、
      `AXExtrasMenuBar`）为可选扩展
- [x] 打包为可签名 .app（权限授给自身，不再依赖终端进程）：`make build`（tauri build
      产出 .app / .dmg）—— 2026-09 验证通过

## 打磨

- [x] 权限页显示「当前缺哪些权限」（Accessibility / Screen Recording / Input Monitoring 分项状态）
- [x] 树转储性能：`AXUIElementCopyMultipleAttributeValues` 批量读属性（每节点 14 属性一次 IPC 往返），
      减少跨进程 IPC 开销 —— `ax_core::copy_multiple_attributes`
- [x] 把 vite 端口、进程清理等 workspace 约定文档化进根 README（端口表 + 开发纪律已写入）
