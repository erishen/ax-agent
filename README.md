[English](README.md) | [中文](README.zh.md)

# AX Agent → macOS Computer Use

**Computer use for macOS** — let an agent "see and operate" any running application.
Built with **Rust + Tauri 2 + React + TypeScript**: semantic operations go through the
macOS Accessibility API (`AXUIElement`), with CGEvent-synthesized input
(mouse / keyboard / scroll) as a fallback (see [TODO.md](./TODO.md) for the roadmap).

Not a shortcut tool — a general-purpose UI observation + control base.

## Capabilities (current)

**💬 Chat (default UI) — operate apps by talking**

Opening the app gives you a chat box. Just give a command; the assistant executes
and reports back:

```
You:      Open TextEdit
Assistant: ✅ Opened TextEdit (pid 1234). Actionable elements: …
You:      Type 你好，今天天气不错
Assistant: ✅ Text written to "Untitled"
You:      Click 显示字体
Assistant: ✅ AXPress performed on "显示字体"
```

Supported commands (Chinese or English, phrasing is flexible):
`打开 <app>` · `应用列表` · `读一下 [app]` · `找 <keyword>` ·
`点击 <keyword>` · `输入 <text> [@field]` · `聚焦 <keyword>` ·
`移动窗口 <x> <y>` · `点 <x> <y>` (inspect element at coordinates) · `帮助`

The session keeps a "current app + UI outline"; keywords resolve to concrete
elements, then the matching AX command runs
(`ax_perform_action` / `ax_set_value` / `ax_focus_element` …).

**Why offline?** Chat commands run entirely on your machine — no LLM, no network,
no API key. Nothing leaves the process: no AX tree, OCR text or session content
is ever sent anywhere. Perfect for quick single-step actions, and fully usable
before you configure an API.

**How it works:** each command is parsed locally (`parseCommand`) and executed
against the session state. There is no model in the loop.

**Limit:** one command per message. When your message carries follow-up steps
(e.g. "open Calendar, then show today's schedule"), the assistant tells you to
switch to Smart Mode — multi-step tasks need a model.

**🤖 Smart Mode (LLM agent)** — toggle on the left of the input box. The model
plans and executes multi-step operations automatically:

```
You: 帮我在备忘录记一下明天买牛奶
🤖 open_app app=备忘录
🤖 type_text text=明天买牛奶
🤖 done 已在备忘录新建笔记并写入「明天买牛奶」
```

Works with any OpenAI-compatible API (DeepSeek / Qwen / Ollama / LM Studio…):
click **⚙️** on the right of the input box to set the API URL, key and model,
with a one-click connection test. The key is stored locally in
`app_data_dir/llm.json`; HTTP requests are issued from the Rust side, never the webview.

Tools available to the model (**34**, see `DESKTOP_TOOLS` in `src/llm.ts` plus chat
commands): app management (`list_apps` / `open_app` / `frontmost_app`), observation
(`read_screen` / `ocr` / `find` / `element_at` / `screen_info` / `wait_for`), semantic
actions (`click` / `type_text` / `focus` / `named_action` / `scroll_to` / `menu_bar` /
`menu_click`), synthesized input (`click_at` / `double_click_at` / `right_click_at` /
`drag` / `scroll` / `key` / `type_keys`), windows (`move_window` / `resize_window`),
desktop (`clipboard_*` / `notify` / `open_url` / `speak` / `profile_search` /
`fs_scan` / `fs_move`), local MCP (`mcp_local_*`) and the final `done`. Hard budget
of 25 steps per run; when exhausted, "继续" resumes with the full context preserved.

### Safety mechanisms

- **Dangerous-operation confirmation**: element actions matching delete / send /
  log-out words pause and wait for your approval before executing. Also covered:
  real `fs_move`, `clipboard_get`, Enter/Return key, window close/minimize buttons.
- **Personal-path `fs_scan` confirmation**: scanning `~` / `/Users/…` folders
  pauses for approval (file names/sizes could be personal and would be sent to
  the LLM API with the context); non-personal paths (`/tmp`, project roots) flow.
- **Stale-snapshot guard**: coordinate / synthesized input operations
  (`click_at` / `drag` / `scroll` / `type_keys` …) are rejected when the latest
  observation (`ocr` / `read_screen` / `open_app`) is older than 60s — re-observe first.
- **Password-field protection**: auto-input is refused when the target is an
  AXSecureTextField / AXPasswordField — sensitive input stays with the human.

**🔎 Inspector (advanced)** — pick an app, inspect the property table, drive
elements one by one. For debugging and developing agent strategies.

**Observation**

- Permission check + dev-mode diagnostics: shows the process chain and
  responsible process so you know exactly which app to authorize; polls every
  1.5s and proceeds automatically once granted.
- `NSWorkspace.runningApplications` enumerates GUI apps; `ax_open_app` launches /
  focuses by name.
- Bounded-depth AX tree traversal with `AXUIElementCopyAttributeValue`; node
  attributes (Role / Title / Value / …) and AXValues (position / size) decoded,
  2s message timeout.
- `AXUIElementCopyElementAtPosition` (system-wide): resolve the element under a
  screen coordinate.

**Acting — semantic layer, no synthesized events; elements may be occluded or off-screen**

- `AXUIElementPerformAction`: native element actions like `AXPress`
  (addressed by child-index path).
- `ax_named_action`: any named AX action (`AXIncrement` / `AXDecrement` /
  `AXPick` / `AXShowMenu` …).
- `ax_scroll_to_visible`: semantic scroll (bring off-screen elements into view).
- `ax_scroll`: CGEvent-synthesized wheel events (most long lists expose no AX scroll).
- `ax_set_value`: write `AXValue` (semantic equivalent of typing into a text field).
- `ax_focus_element`: write `AXFocused` to grab keyboard focus.
- `ax_set_position`: write `AXPosition` to move a window.
- UI: tree + detail split view with action buttons, AXValue writing, focusing.

#### What do "Focus" and "Write" mean?

Both are *property writes*, not simulated key/mouse:

| UI button | Actual operation | Human equivalent | Best for |
| --- | --- | --- | --- |
| **Focus** | Write `AXFocused = true` | Click the element to give it keyboard focus | Positioning focus before input |
| **Write** | Write `AXValue = "<text>"` | Select-all + type new text (atomic replace) | Setting text fields/areas |
| (action buttons) | `AXUIElementPerformAction(AXPress…)` | Click button, tick checkbox | Everything exposing an action |
| (hidden) | Write `AXPosition = {x, y}` | Drag the window title bar | Moving windows |

Compared with CGEvent-synthesized input: semantic operations don't occupy the real
mouse/keyboard, don't require on-screen visibility, and aren't blocked by occluding
windows — but they can only do what the target app explicitly exposes. The two
complement each other:

- Synthesized **scroll** (`ax_scroll`): `scroll_at_position` (CGEvent wheel).
- Synthesized **keyboard** (`ax_key` / `ax_type_keys`): `press_key_combo`
  (enter/Esc/Cmd+F/arrows) and `type_text_synthetic` (per-keystroke input,
  Unicode payload incl. Chinese; triggers search-as-you-type / autocomplete —
  impossible via semantic AXValue writes).
- Synthesized **mouse** (`ax_click` / `ax_double_click` / `ax_drag`): coordinate
  clicks/drags for self-drawn controls with neither AX actions nor detectable
  elements (canvas, map, sliders, embedded webviews). Note: HID mouse events only
  go to the frontmost app — activate the target first.

#### Runnable examples (built-in macOS apps)

```bash
cd src-tauri

# 1. Fully drive TextEdit: locate text area → focus → write → move window → verify
cargo run --example textedit_demo        # open TextEdit first (open -a TextEdit)

# 2. Probe a screen coordinate: "what element is under this point?" (any app)
cargo run --example probe_at -- 600 400   # global screen points, top-left origin

# 3. Synthesized keyboard: per-keystroke typing (Chinese OK) + Cmd+Up/Cmd+S
cargo run --example keyboard_demo        # open TextEdit and create a doc first

# 4. WeChat end-to-end: Cmd+F search → type → click result → verify switch
#    (read-only safe: target is 文件传输助手, no messages are sent)
cargo run --example wechat_stress

# 5. Synthesized mouse: drag window title bar (AX-invisible) + single/double click
cargo run --example mouse_demo           # open TextEdit and keep it frontmost

# 6. Menu-driven: read menu-bar tree → AXPick down → AXPress leaf (fully semantic)
cargo run --example menu_demo
```

The agent decision sequence behind `textedit_demo` (also what the UI buttons issue):

```
ax_list_apps        → find the pid of com.apple.TextEdit
ax_tree(pid)        → locate the AXTextArea node in the tree (record child-index path)
ax_focus_element    → write AXFocused=true                ←「聚焦」
ax_set_value        → write AXValue="Hello…"              ←「写入」
ax_set_position     → write AXPosition={120,120} (move window)
ax_tree(pid)        → re-read to verify AXValue / AXFocused took effect
```

Other typical scenarios (same command combos, swap the target app):

| Goal | Command combo |
| --- | --- |
| Type into Notes / a search box | `ax_tree` locate text field → `ax_focus_element` → `ax_set_value` |
| Click a button in another app | `ax_element_at` pick or `ax_tree` locate → `ax_perform_action(AXPress)` |
| Move an app window to a corner | `ax_tree` find AXWindow → `ax_set_position` |
| Switch input focus to another field | `ax_focus_element` |

#### Example-task chips (above the input box)

Chips are not hardcoded — generated dynamically for your machine:

1. **Installed apps** (`ax_installed_apps`): scans `/Applications`,
   `/System/Applications`, `~/Applications` (one level deep), reads Info.plist for
   `CFBundleName` / `CFBundleIdentifier`, localizes names via
   `NSFileManager.displayNameAtPath` — your WeChat / QQ / Tencent Video / Evernote
   all show up; running apps rank first.
2. **tsm-hub gateway catalog** (`llm_catalog`): `/v1/skills`, `/v1/tools`,
   `/v1/mcps` become skill / tool / MCP task chips.
3. **Built-in fallback**: usable suggestions whenever the gateway is down or offline.

Click **🔄 换一批** to reshuffle; 5-minute cache, rebuilt on entering 🤖 mode.

Personal tasks (e.g. app-specific "pick by my taste" workflows) live in a
git-ignored local config (`apps.local.json`), never in the codebase.

Launch reliability: when the CLI locale resolves to English, `open -a 备忘录` fails
but `open -b com.apple.Notes` always works — `ax_open_app` resolves Chinese names to
bundle ids first, so both phrasings open the app.

Inspect your machine's scan results:

```bash
cd src-tauri && cargo run --example installed_apps   # display/bundle/bundle id + path
```

## Run

```bash
pnpm install
pnpm tauri dev      # dev mode
pnpm tauri build    # produces .app / .dmg (dock icon generated from app-icon.svg)
```

Install the built app to `/Applications` (or use `make help` for the full list):

```bash
make build                      # release build (.app / .dmg)
make install                    # install the built .app to /Applications
make install INSTALL_FLAGS="-y" # skip the overwrite prompt
make uninstall                  # remove the app (data kept; --purge deletes it too)
```

The install script handles version comparison, codesign verification and
sudo elevation; `--dry-run` prints the plan without touching anything.

### Before committing

- Full verification: `make lint` (tsc + `clippy --all-targets -D warnings`),
  `cargo test --lib`.
- **Dev discipline**: for desktop work only run `make dev` (tauri watch
  auto-recompiles; trust the watch output for Rust changes). **Never run
  `cargo check` / `cargo build` in parallel** — contending for the shared
  `work/rust` target with the watcher corrupts the macro cache. When no watch is
  running, `cargo test --no-default-features --lib` is fine.
- pre-commit hook (`.githooks/pre-commit`, installed via
  `git config core.hooksPath .githooks`): runs `tsc --noEmit` on staged `.ts`
  changes as a fast gate; Rust changes are **not** checked here — rely on
  `make lint` / `cargo test`. Skip: `git commit --no-verify`.

### Permissions (important)

Accessibility permission goes to the **responsible process**, not the
ax-agent binary itself:

- `pnpm tauri dev`: authorize the app that launched the dev command
  (Terminal / iTerm / VS Code / the agent host) — System Settings → Privacy &
  Security → Accessibility → 「+」add and tick it; the in-app permission page shows
  the process chain and highlights the app to tick.
- Packaged `.app`: authorize **AX Agent** itself.

### Port allocation (workspace convention)

| Project | vite port | HMR port |
| --- | --- | --- |
| `sprite` | 1420 | 1421 |
| `ax-agent` | 1520 | 1521 |

## Structure

> Architecture deep-dive: [ARCHITECTURE.md](./ARCHITECTURE.md).

```
ax-agent/
├── index.html / src/           # React + TypeScript frontend
│   ├── App.tsx                 # permission gate / Chat↔Inspector tabs / inspector view
│   ├── ChatView.tsx            # 💬 chat UI (bubbles, input box)
│   ├── chat.ts                 # session logic: command mode + agent loop (runSteps) + runTool dispatch
│   ├── llm.ts                  # LLM tool schemas (DESKTOP_TOOLS) + chat completion
│   ├── agent-config.ts         # system prompt / danger words / policy constants
│   ├── tool-utils.ts           # command parsing, tool args validation, helpers
│   ├── examples.ts             # built-in example task chips
│   ├── finder-archive.ts       # Finder archive workflow (fs_scan / fs_move)
│   ├── tencent.ts / netease.ts # Tencent Video / NetEase Music self-drawn-UI decision machines
│   ├── tools/                  # tool implementations by domain + shared helpers
│   │   ├── shared.ts           #   ToolResult / observation snapshot / UI state machine / clamp / outline refresh
│   │   ├── observe.ts          #   list_apps · read_screen · wait_for · ocr · find
│   │   ├── input.ts            #   click/type/focus/synthesized coordinate clicks & scroll (with guards)
│   │   ├── window.ts           #   move_window · resize_window · element_at · named_action
│   │   └── misc.ts             #   open_app · menu_bar · menu_click · done · desktop passthrough
│   ├── api.ts / types.ts       # invoke wrappers & types
├── app-icon.svg                # app icon source (tauri icon generates sizes)
└── src-tauri/
    ├── src/ax_core.rs          # AX basics: permission / enumeration / tree walk / attribute read / perform action
    ├── src/ax_act.rs           # computer-use semantic+synthetic ops: set_value / focus / coordinate pick / CGEvent
    ├── src/ax_open.rs          # app launch/focus (bundle id first, Chinese-name aliases)
    ├── src/ocr.rs              # Apple Vision OCR (self-drawn UI text recognition)
    ├── src/commands/           # Tauri command layer (permissions/apps/tree/screen/input/misc)
    ├── src/rpc.rs              # JSON-RPC loopback service (127.0.0.1:8931)
    └── src/lib.rs              # command registration
```

## Tauri commands

| Command | Description |
| --- | --- |
| `ax_permission_status` / `ax_request_permission` | permission check / system prompt |
| `ax_permission_diagnostics` | process chain + responsible process (dev-mode authorization target) |
| `ax_list_apps` | enumerate GUI apps |
| `ax_tree(pid, depth)` | read the AX tree of a pid |
| `ax_perform_action(pid, path, action)` | run an AX action on an element |
| `ax_set_value(pid, path, text)` | write AXValue (semantic input; password fields refused) |
| `ax_focus_element(pid, path)` | grab focus on an element |
| `ax_set_position(pid, path, x, y)` | move an element/window |
| `ax_element_at(x, y)` | resolve element at screen coordinate (system-wide) |
| `ax_open_app(target)` | launch/focus app by name (bundle id first + Chinese aliases) |
| `ax_type_keys(text, pid)` / `ax_key(combo, pid)` | synthesized keystrokes / keys (password fields refused) |
| `ax_click(x, y, pid)` / `ax_double_click` / `ax_right_click` | synthesized mouse (self-drawn UI) |
| `ax_scroll(x, y, lines, pid)` | synthesized wheel events |
| `ax_menu_bar(pid)` / `ax_menu_click(pid, path)` | menu-bar semantic read / click |
| `ocr_window(pid)` | Apple Vision OCR (returns screen coordinates) |
| `llm_chat(messages, tools)` | OpenAI-compatible chat completion (incl. tool calling) |
| `llm_get_config` / `llm_set_config` | LLM config read/write (base_url / api_key / model) |
| `llm_list_models(base, key)` | fetch model list (settings connection test) |

## Roadmap

See [TODO.md](./TODO.md): observation loop (AXObserver / screenshot alignment /
overlay) → CGEvent synthesized input (mouse / keyboard / scroll) → agent interface
layer (observe/act JSON-RPC, action validation & post-verification, auto-relocation).
LLM Smart Mode is ready (OpenAI-compatible, tool calling).

## Notes

- AX attribute reads/writes are cross-process synchronous IPC; `#[tauri::command(async)]`
  runs them on worker threads so the UI never blocks.
- `AXUIElement` handles cannot persist across IPC: actions address elements by the
  child-index path recorded at tree-dump time; paths can go stale after UI changes —
  action commands support a `relocate{role,label}` hint to re-search the tree by
  role+title and retry once (both chat commands and LLM tools use it).

## Privacy & security (audited 2026-09)

This tool can "see and operate" your whole desktop. Know the data flows:

- **Screen content egress**: in Smart Mode, the AX tree and OCR text of the current
  app (i.e. text on your screen) are sent to the ⚙️-configured LLM API (self-hosted /
  local routing, e.g. tsm-hub). On sensitive pages (mail, chat, banking, 2FA codes):
  password fields (AXSecureTextField/AXPasswordField) are refused for auto-input at
  the input side, but if a page shows sensitive text in plain view, OCR will still
  read it. A one-time privacy notice shows in the chat UI before Smart Mode is used.
- **Session logs on disk**: a finished Smart-Mode session appends the full transcript
  (user commands, tool calls, OCR text) to
  `~/Library/Application Support/cn.erishen.ax-agent/logs/sessions.md`
  (owner-only 0600, log dir 0700). Deleting the file removes the history; transcripts
  never leave the local disk (no third party).
- **Keys & config**: the LLM API key is stored in plaintext at `…/llm.json` (0600,
  readable only by the current user; masked in the UI). `memory.json` (app-usage
  habits) is also 0600. The RPC service binds 127.0.0.1 only and uses a 0600 bearer
  token; screenshot temp files are deleted after use; `.env` / `apps.local.json` /
  `mcp.local.json` are git-ignored.
- **No telemetry**: no analytics or crash reporting anywhere. The only external
  connections are the configured LLM API and the optional local profile RAG
  (127.0.0.1:8001).
- **Permissions**: this app requests Accessibility (read UI + simulate input),
  Screen Recording (screenshot/OCR) and Input Monitoring (synthesized keyboard).
  Once granted, the process can control the whole machine — run it only in a trusted
  environment, and never hand the authorized terminal/process to an untrusted script.
- **Git hygiene**: the commit history has been rewritten to remove personal profile
  data and real file names; personal example tasks live only in the local
  `apps.local.json`, never in the repository.
