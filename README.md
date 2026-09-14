# AX Explorer → macOS Computer Use

**Computer use for macOS** — 让 agent 能「看懂 + 自由操作」任意正在运行的应用。
以 **Rust + Tauri 2 + React + TypeScript** 构建，语义操作通道走 **macOS Accessibility
API（AXUIElement）**，后续以 **CGEvent** 作为合成输入兜底（见 TODO.md 里程碑）。

不是快捷方式工具（对比 sprite），而是通用的界面观测 + 操控基座。

## 能力（当前）

**💬 会话（默认界面）—— 用说话的方式操作应用**

打开应用即是对话框，直接下指令，助手执行并汇报结果：

```
你：打开 TextEdit
助手：✅ 已打开 TextEdit（pid 1234），界面里的可操作元素：…
你：输入 你好，今天天气不错
助手：✅ 已把文本写入「未命名」
你：点击 显示字体
助手：✅ 已对「显示字体」执行 AXPress
```

支持的指令（中英文均可，说法可以随意些）：
`打开 <应用>` · `应用列表` · `读一下 [应用]` · `找 <关键词>` ·
`点击 <关键词>` · `输入 <文本> [@字段]` · `聚焦 <关键词>` ·
`移动窗口 <x> <y>` · `点 <x> <y>`（查坐标下的元素） · `帮助`

会话内部维护「当前应用 + 界面大纲」，关键词定位到具体元素后执行对应的
AX 命令（`ax_perform_action` / `ax_set_value` / `ax_focus_element`…）。

**🤖 智能模式（LLM 代理）**：输入框左侧切换。开启后由大模型规划并自动执行多步操作：

```
你：帮我在备忘录记一下明天买牛奶
🤖 open_app app=备忘录
🤖 type_text text=明天买牛奶
🤖 done 已在备忘录新建笔记并写入「明天买牛奶」
```

任意 OpenAI 兼容 API（DeepSeek / Qwen / Ollama / LM Studio…）：点输入框右侧
**⚙️** 填 API 地址、密钥、模型，可一键测试连接。密钥保存在本机
`app_data_dir/llm.json`，HTTP 请求从 Rust 端发出，不经过 webview。

模型可用的工具：`list_apps` / `open_app` / `read_screen` / `find` / `click` /
`type_text` / `focus` / `move_window` / `element_at` / `done`（最多 12 步）。

**🔎 检查器（高级）** —— 原树形查看器：手动选应用、看属性表、逐元素操作，
供调试和开发 agent 策略时用。

**观测（observe）**

- 权限检测 + 开发模式诊断：显示进程链与 responsible process，明确该给哪个 App 授权；
  每 1.5s 自动轮询，授权后自动进入
- `NSWorkspace.runningApplications` 枚举 GUI 应用；`ax_open_app` 按名启动/聚焦应用
- `AXUIElementCopyAttributeValue` 有界深度遍历 AX 树，节点属性（Role/Title/Value/…）
  与 AXValue（位置/大小）解码，2s 消息超时
- `AXUIElementCopyElementAtPosition`（system-wide）：给定屏幕坐标，返回该点下的元素

**操作（act）——语义层，无需合成事件，元素可被遮挡/离屏**

- `AXUIElementPerformAction`：`AXPress` 等元素原生动作（按子索引路径定位）
- `ax_named_action`：任意具名 AX 动作（`AXIncrement`/`AXDecrement`/`AXPick`/`AXShowMenu`…）
- `ax_scroll_to_visible`：语义滚动（把离屏元素滚到可见区域）
- `ax_scroll`：CGEvent 合成滚轮事件（大多数长列表没有 AX 滚动动作时用这个）
- `ax_set_value`：写 `AXValue`（文本框输入的语义等价物）
- `ax_focus_element`：写 `AXFocused` 抢键盘焦点
- `ax_set_position`：写 `AXPosition` 移动窗口
- UI：树 + 详情双栏，详情页内置操作按钮、AXValue 写入、聚焦

#### 「聚焦」和「写入」是什么意思？

两者都是**写属性**，不是模拟键鼠：

| UI 按钮 | 实际操作 | 等价的人肉动作 | 适合 |
| --- | --- | --- | --- |
| **聚焦** | 写 `AXFocused = true` | 点一下该元素让它获得键盘焦点 | 输入前定位焦点、切换输入目标 |
| **写入** | 写 `AXValue = "<文本>"` | 全选 + 输入新文本（原子替换整个内容） | 文本框/文本区的内容设置 |
| （动作按钮） | `AXUIElementPerformAction(AXPress…)` | 点击按钮、勾选复选框 | 所有暴露了 action 的元素 |
| （隐藏） | 写 `AXPosition = {x, y}` | 拖动窗口标题栏 | 移动窗口 |

与 CGEvent 合成键鼠的区别：语义操作不占用真实鼠标键盘、不要求元素在屏幕可见、
不会被遮挡挡住；但只能做「目标 App 明确暴露的」事情。两者互补：

- 合成**滚动**（`ax_scroll`）：`scroll_at_position`（CGEvent 滚轮，多数长列表没有 AX 滚动动作）
- 合成**键盘**（`ax_key` / `ax_type_keys`）：`press_key_combo`（enter/Esc/Cmd+F/方向键）
  与 `type_text_synthetic`（逐键输入，Unicode payload 支持中文，触发随输入即搜索、
  自动补全等逐键反应 —— 这是语义 AXValue 写入做不到的）
- 合成**鼠标**（`ax_click` / `ax_double_click` / `ax_drag`）：坐标点击/双击/拖拽，
  用于既没有 AX 动作、也探测不到元素的自绘控件（画布、地图、拖动滑块、内嵌网页）。
  注意：HID 鼠标事件只会投给**最前台应用**，先激活目标应用再操作。

#### 完整示例（可直接跑，操作系统自带应用）

```bash
cd src-tauri

# 例 1：全自动驱动 TextEdit —— 定位文本区 → 聚焦 → 写入一段文字 → 移动窗口 → 验证
cargo run --example textedit_demo        # 先确保 TextEdit 已打开（open -a TextEdit）

# 例 2：屏幕坐标点选 —— 问 "这个坐标下是什么元素？"（任意 App）
cargo run --example probe_at -- 600 400   # 全局屏幕坐标（points，左上原点）

# 例 3：合成键盘 —— 逐键输入（中文 OK）+ Cmd+Up/Cmd+S 快捷键
cargo run --example keyboard_demo        # 需先打开 TextEdit 并新建文档

# 例 4：WeChat 全链路压测 —— Cmd+F 搜索 → 逐键输入 → 点选结果 → 验证切换
# （只读安全：目标是文件传输助手，不发送任何消息）
cargo run --example wechat_stress

# 例 5：合成鼠标 —— 拖拽窗口标题栏（AX 不可见的拖拽）+ 单击/双击
cargo run --example mouse_demo   # 需先打开 TextEdit 并保持其在前台

# 例 6：菜单驱动 —— 读菜单栏树 → AXPick 逐级打开 → AXPress 叶子项（全语义）
cargo run --example menu_demo
```

`textedit_demo` 对应的 agent 决策序列（也是 UI 里各按钮背后的命令）：

```
ax_list_apps        → 找到 com.apple.TextEdit 的 pid
ax_tree(pid)        → 在树里找到 AXTextArea 节点（记录子索引路径）
ax_focus_element    → 写 AXFocused=true   ←「聚焦」
ax_set_value        → 写 AXValue="Hello…" ←「写入」
ax_set_position     → 写 AXPosition={120,120}（移动窗口）
ax_tree(pid)        → 重读验证 AXValue / AXFocused 生效
```

其它典型场景（同样命令组合，换目标 App 即可）：

| 想做的事 | 命令组合 |
| --- | --- |
| 在备忘录/搜索框里输入文字 | `ax_tree` 定位文本框 → `ax_focus_element` → `ax_set_value` |
| 点另一个 App 的某个按钮 | `ax_element_at` 点选或 `ax_tree` 定位 → `ax_perform_action(AXPress)` |
| 把某 App 窗口挪到屏幕角落 | `ax_tree` 找 AXWindow → `ax_set_position` |
|切换输入焦点到另一个字段| `ax_focus_element` |

#### 示例任务（输入框上方的 chips）

chips 不是写死的，而是按你的机器动态生成：

1. **已安装应用**（`ax_installed_apps`）：扫描 `/Applications`、`/System/Applications`、
   `~/Applications`（含一层子目录），读 Info.plist 取 `CFBundleName`/`CFBundleIdentifier`，
   用 `NSFileManager.displayNameAtPath` 取本地化名 —— 所以你的微信/QQ/腾讯视频/印象笔记
   都会出现；正在运行的应用优先。
2. **tsm-hub 网关目录**（`llm_catalog`）：`/v1/skills`、`/v1/tools`、`/v1/mcps` 变成
   技能/工具/MCP 任务 chips。
3. **内置兜底**：网关不可用或离线时永远有可用建议。

点 **🔄 换一批** 重新洗牌；5 分钟缓存，切换 🤖 模式自动重建。

启动的可靠性：系统把本机 CLI locale 解析为英文时，`open -a 备忘录` 会失败而
`open -b com.apple.Notes` 总是成功 —— `ax_open_app` 会先把中文名解析成 bundle id
再启动，两种说法都能打开。

查看本机扫描结果：

```bash
cd src-tauri && cargo run --example installed_apps   # 打印 display/bundle/bundle id + 路径
```

## 运行

```bash
pnpm install
pnpm tauri dev      # 开发模式
pnpm tauri build    # 产出 .app / .dmg（Dock 图标用 app-icon.svg 生成）
```

### 权限（重要）

辅助功能权限授给 **responsible process**，不是 ax-explorer 二进制本身：

- `pnpm tauri dev`：给 **启动 dev 命令的 App**（Terminal / iTerm / VS Code / agent 宿主）
  授权 —— 系统设置 → 隐私与安全性 → 辅助功能 → 「+」添加并勾选；
  应用内权限页会显示进程链并高亮该勾选的 App
- 打包后的 `.app`：给 **AX Explorer** 本身授权

### 端口分配（workspace 约定）

| 项目 | vite 端口 | HMR 端口 |
| --- | --- | --- |
| `sprite` | 1420 | 1421 |
| `ax-explorer` | 1520 | 1521 |

## 结构

```
ax-explorer/
├── index.html / src/           # React + TypeScript 前端
│   ├── App.tsx                 # 权限门 / 会话↔检查器 Tab / 检查器视图
│   ├── ChatView.tsx            # 💬 会话 UI（气泡、输入框）
│   ├── chat.ts                 # 会话逻辑：指令解析 → AX 命令 → 回复
│   ├── api.ts / types.ts       # invoke 封装与类型
├── app-icon.svg                # 应用图标源文件（tauri icon 生成各尺寸）
└── src-tauri/
    ├── src/ax_core.rs          # AX 基础：权限 / 枚举 / 树遍历 / perform action
    ├── src/ax_act.rs           # computer-use 语义操作：set_value / focus / position / 坐标点选
    ├── src/commands.rs         # Tauri 命令层（含 sysinfo 权限诊断）
    └── src/lib.rs              # 命令注册
```

## Tauri 命令

| 命令 | 说明 |
| --- | --- |
| `ax_permission_status` / `ax_request_permission` | 权限检测 / 触发系统弹窗 |
| `ax_permission_diagnostics` | 进程链 + responsible process（开发模式授权对象） |
| `ax_list_apps` | 枚举常规 GUI 应用 |
| `ax_tree(pid, depth)` | 读取指定 pid 的 AX 树 |
| `ax_perform_action(pid, path, action)` | 对元素执行 AX 动作 |
| `ax_set_value(pid, path, text)` | 写元素 AXValue（语义输入） |
| `ax_focus_element(pid, path)` | 元素抢焦点 |
| `ax_set_position(pid, path, x, y)` | 移动元素/窗口 |
| `ax_element_at(x, y)` | 屏幕坐标点选（system-wide） |
| `ax_open_app(target)` | 按名启动/聚焦应用（会话用） |
| `llm_chat(messages, tools)` | OpenAI 兼容对话补全（含 tool calling） |
| `llm_get_config` / `llm_set_config` | LLM 配置读写（base_url / api_key / model） |
| `llm_list_models(base, key)` | 拉取模型列表（设置页测试连接） |

## 路线图

见 [TODO.md](./TODO.md)：观察闭环（AXObserver / 截图对齐 / overlay）→
CGEvent 合成输入（鼠标/键盘/滚动）→ Agent 接口层（observe/act JSON-RPC、
动作校验与后验证、自动重定位）。LLM 智能模式已就绪（OpenAI 兼容，tool calling）。

## 注意

- AX 属性读写是跨进程同步 IPC，`#[tauri::command(async)]` 已放到工作线程，不卡 UI。
- `AXUIElement` 句柄不能跨 IPC 持久化：动作按「树转储时记录的子索引路径」定位，
  UI 变化后路径可能失效（刷新重试；后续按 role+title 自动重定位）。
