/**
 * Chat-style session over the AX commands: plain text in, actions executed,
 * human-readable replies out. No tree-walking skills required.
 *
 * Supported utterances (Chinese first, English aliases):
 *   打开 <app>          open <app>
 *   应用列表 / apps
 *   读一下 / 读取 <app>  read <app>     → compact outline of the AX tree
 *   找 <关键词>          find <keyword> → search the last outline
 *   点 <x> <y>           probe <x> <y>  → hit-test a screen point
 *   点击 <关键词>        click <keyword> → find element, perform AXPress
 *   输入 <文本> [@字段]   type <text> [@field]
 *   聚焦 <关键词>         focus <keyword>
 *   移动窗口 <x> <y>      move window <x> <y>
 *   刷新 / refresh · 帮助 / help
 *
 * The session keeps: current app pid, the last dumped outline (nodes with
 * their child-index paths), so 点击/输入/聚焦 can address elements by keyword.
 */
import {
  elementAt,
  focusElement,
  listApps,
  openApp,
  performAction,
  permissionStatus,
  readAttribute,
  resizeWindow,
  setPosition,
  setValue,
  tracePath,
} from "./api";
import {
  findNodes,
  renderOutline,
  truncate,
} from "./tree-utils.ts";
import {
  argsText,
  asText,
  extractAppNameFromLongArg,
  friendlyLlmError,
  parseCommand,
  stepHeading,
  withStepResult,
} from "./tool-utils.ts";
import type { AxAppInfo, OutlineNode, SessionState } from "./types";
import {
  CONTINUE_NUDGE,
  MAX_AGENT_STEPS,
  STEP_RE,
  SYSTEM_PROMPT,
  dangerousReason,
  environmentLimitNote,
} from "./agent-config.ts";
import { bringBack, focusSelf, hideAside } from "./windowctl";
import { invoke } from "@tauri-apps/api/core";
import { tui, treeOf, type ToolResult } from "./tools/shared";
import {
  toolFind,
  toolListApps,
  toolOcr,
  toolReadScreen,
  toolWaitFor,
} from "./tools/observe";
import {
  toolClick,
  toolClickAt,
  toolDoubleClickAt,
  toolDrag,
  toolFocus,
  toolKey,
  toolRightClickAt,
  toolScroll,
  toolScrollTo,
  toolTypeKeys,
  toolTypeText,
} from "./tools/input";
import {
  toolElementAt,
  toolMoveWindow,
  toolNamedAction,
  toolResizeWindow,
} from "./tools/window";
import {
  toolDesktop,
  toolDone,
  toolMenuBar,
  toolMenuClick,
  toolOpenApp,
} from "./tools/misc";

export type {
  ChatMessage,
  PendingAction,
  SessionState,
  UndoRecord,
} from "./types";

/** One chat message (assistant = command replies, user = typed input). */

export function newSession(): SessionState {
  return { messages: [], pid: null, appName: null, outline: [], lastObservedAt: null };
}

/**
 * Plain-text transcript messages carry the raw Markdown the LLM wrote
 * (**bold**, # headings, `code`, *em*). Inside the app react-markdown
 * renders it, but the copied/pasted transcript and the session log show
 * the literal syntax — that is what "Markdown 展示还不好" referred to.
 * Downgrade the visible markers (keep list dashes and numbering, they
 * read fine in plain text). Tool-step cards (STEP_RE) are skipped.
 */
/** Matches a tool-step bubble: `🤖 3/25 \`ocr\` …` + fenced code block. */
export function stripMarkdownSyntax(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/``/g, "")
    .replace(/^>\s?/gm, "")
    .replace(/[ \t]+\n/g, "\n");
}

/** Render the whole session as plain text — for the 📋 copy button and the log. */
export function sessionTranscript(s: SessionState): string {
  const lines: string[] = [];
  lines.push("# AX Agent 会话记录");
  lines.push(`- 时间：${new Date().toLocaleString("zh-CN")}`);
  if (s.appName) lines.push(`- 目标应用：${s.appName}（pid ${s.pid}）`);
  lines.push("");
  lines.push("---");
  lines.push("");
  for (const m of s.messages) {
    lines.push(`### ${m.role === "user" ? "🧑 用户" : "🤖 助手"}`);
    // Tool-step cards keep their fenced code block verbatim; prose
    // messages lose the Markdown markers that would render as literal
    // syntax in a pasted transcript.
    const text = m.role === "assistant" && !STEP_RE.test(m.text) ? stripMarkdownSyntax(m.text) : m.text;
    lines.push(text);
    lines.push("");
  }
  return lines.join("\n");
}

/** Persist the session transcript to the app's log dir (best-effort, never
 *  blocks or breaks the conversation). */
export async function logSession(s: SessionState): Promise<void> {
  try {
    await invoke("append_session_log", { text: sessionTranscript(s) });
  } catch {
    /* logging must never break the chat */
  }
}

function reply(state: SessionState, text: string): SessionState {
  return {
    ...state,
    messages: [
      ...state.messages,
      { id: nextId++, role: "assistant", text },
    ],
  };
}


// ---------------------------------------------------------------------------
// Command handlers — each returns the next session state
// ---------------------------------------------------------------------------

async function cmdOpen(
  state: SessionState,
  target: string,
  tail?: string,
): Promise<SessionState> {
  let next = reply(state, `正在打开「${target}」…`);
  // 19:52 session: '打开日历，用 ocr 或 read_screen 查看今天的日期区域…'
  // opened but never reported — offline quick commands are single-shot. Tell
  // the user the rest of the task needs the agent (LLM configured) instead
  // of silently stopping after the launch.
  const tailNote = tail
    ? `\n\n📎 这条消息还包含后续步骤（「${tail.slice(0, 40)}${tail.length > 40 ? "…" : ""}」）。离线快捷指令只能执行单条命令；配置 LLM 后重新发送，我会完整执行。`
    : "";
  // Open + warm outline + report, with an optional recovery note.
  const openAndReport = async (name: string, note: string): Promise<SessionState> => {
    const app: AxAppInfo = await openApp(name);
    const withPid: SessionState = {
      ...next,
      pid: app.pid,
      appName: app.name,
      outline: [],
    };
    // The launched app steals focus; take our window back to the front so the
    // conversation continues seamlessly (setAlwaysOnTop keeps it there).
    void focusSelf();
    // Warm the outline so 点击/输入 work immediately after 打开.
    try {
      const outline = await treeOf(app.pid, 10);
      return reply(
        { ...withPid, outline },
        `${note}✅ 已打开 ${app.name}（pid ${app.pid}）\n当前界面里的可操作元素：\n${renderOutline(outline) || "（未发现常规元素）"}${tailNote}`,
      );
    } catch {
      return reply(
        withPid,
        `${note}✅ 已打开 ${app.name}（pid ${app.pid}）。说「读一下」查看它的界面。${tailNote}`,
      );
    }
  };
  try {
    return await openAndReport(target, "");
  } catch (e) {
    // 17:40 session: the parsed target was the whole task sentence
    // ("打开访达，read_screen 浏览…"), so openApp failed on the Rust guard.
    // If exactly one known running app name appears in the text, recover by
    // opening that instead of failing the whole task.
    try {
      const apps = await listApps();
      const hit = extractAppNameFromLongArg(target, apps.map((a) => a.name));
      if (hit) {
        return await openAndReport(hit, `⚠️ 参数过长（疑似粘贴了任务描述），已自动提取应用名「${hit}」。\n`);
      }
    } catch {
      /* recovery is best-effort */
    }
    return reply(next, `❌ 打开失败：${asText(e)}`);
  }
}

async function cmdRead(state: SessionState, appName: string): Promise<SessionState> {
  try {
    let pid = state.pid;
    let name = state.appName;
    if (appName) {
      const apps = await listApps();
      const app = apps.find(
        (a) =>
          a.name.toLowerCase().includes(appName.toLowerCase()) ||
          a.bundle_id.toLowerCase().includes(appName.toLowerCase()),
      );
      if (!app) {
        return reply(state, `❌ 没找到运行中的应用「${appName}」。试试「应用列表」。`);
      }
      pid = app.pid;
      name = app.name;
    }
    if (pid === null) {
      return reply(state, "先告诉我操作哪个应用：说「打开 <应用名>」或「读取 <应用名>」。");
    }
    const outline = await treeOf(pid, 10);
    return reply(
      { ...state, pid, appName: name, outline },
      `📋 ${name}（pid ${pid}）的界面结构：\n${renderOutline(outline) || "（未发现常规元素，试试提高深度）"}`,
    );
  } catch (e) {
    return reply(state, `❌ 读取失败：${asText(e)}`);
  }
}

async function cmdFind(state: SessionState, keyword: string): Promise<SessionState> {
  const hits = findNodes(state.outline, keyword);
  if (!hits.length) {
    return reply(
      state,
      state.outline.length
        ? `没有找到含「${keyword}」的元素。说「读一下」刷新界面结构。`
        : "还没有界面结构，先说「打开 <应用>」或「读一下」。",
    );
  }
  const lines = hits
    .slice(0, 12)
    .map((n, i) => `${i + 1}. ${n.role.replace("AX", "")}「${truncate(n.label, 40)}」${n.value ? `值=${truncate(n.value, 30)}` : ""}${n.actions.length ? ` ⟨${n.actions.join(",")}⟩` : ""}`);
  return reply(state, `🔍 找到 ${hits.length} 个：\n${lines.join("\n")}\n（取第 1 个作为目标；也可以说「点击 ${keyword}」直接执行）`);
}

async function cmdClick(state: SessionState, keyword: string): Promise<SessionState> {
  if (state.pid === null) return reply(state, "先「打开 <应用>」或「读取 <应用>」。");
  const hits = findNodes(state.outline, keyword);
  const target = hits[0];
  if (!target) return reply(state, `❌ 当前结构里没有「${keyword}」。说「读一下」刷新后再试。`);
  if (!target.actions.length) {
    return reply(state, `❌ 元素「${truncate(target.label, 30)}」不支持任何动作（不可点击）。`);
  }
  try {
    await performAction(state.pid, target.path, target.actions[0], { role: target.role, label: target.label });
    // UI may have changed: refresh outline in the background.
    let next = reply(state, `✅ 已对「${truncate(target.label, 30)}」执行 ${target.actions[0]}`);
    try {
      const outline = await treeOf(state.pid, 10);
      next = { ...next, outline };
    } catch {
      /* keep old outline */
    }
    return next;
  } catch (e) {
    return reply(state, `❌ 点击失败：${asText(e)}（界面可能已变化，说「读一下」重新定位）`);
  }
}

async function cmdType(state: SessionState, rest: string): Promise<SessionState> {
  if (state.pid === null) return reply(state, "先「打开 <应用>」或「读取 <应用>」。");
  // Syntax: 输入 <文本> [@字段关键词] — field defaults to first text area/field.
  const atIdx = rest.lastIndexOf("@");
  const text = (atIdx > 0 ? rest.slice(0, atIdx) : rest).trim();
  const field = atIdx > 0 ? rest.slice(atIdx + 1).trim() : "";
  if (!text) return reply(state, "用法：输入 <文本> [@字段关键词]，例如：输入 你好 @搜索");
  const candidates = field ? findNodes(state.outline, field) : state.outline;
  const target = candidates.find(
    (n) => n.role === "AXTextArea" || n.role === "AXTextField" || n.role === "AXSearchField",
  );
  if (!target) {
    return reply(
      state,
      field
        ? `❌ 没找到字段「${field}」。说「读一下」看看界面里有什么。`
        : "❌ 界面里没有文本输入区域。",
    );
  }
  try {
    const prev = await readAttribute(state.pid, target.path, "AXValue").catch(() => null);
    await setValue(state.pid, target.path, text, { role: target.role, label: target.label });
    // Refocus so the user sees the caret there.
    try {
      await focusElement(state.pid, target.path, { role: target.role, label: target.label });
    } catch {
      /* focus is best-effort */
    }
    return reply(
      { ...state, undo: { kind: "set_value", pid: state.pid, path: target.path, prev: prev ?? "", label: target.label } },
      `✅ 已把文本写入「${truncate(target.label, 30)}」：\n${truncate(text, 80)}`,
    );
  } catch (e) {
    return reply(state, `❌ 写入失败：${asText(e)}`);
  }
}

async function cmdFocus(state: SessionState, keyword: string): Promise<SessionState> {
  if (state.pid === null) return reply(state, "先「打开 <应用>」或「读取 <应用>」。");
  const target = findNodes(state.outline, keyword)[0];
  if (!target) return reply(state, `❌ 没找到「${keyword}」。说「读一下」刷新。`);
  try {
    await focusElement(state.pid, target.path, { role: target.role, label: target.label });
    return reply(state, `✅ 焦点已给到「${truncate(target.label, 30)}」`);
  } catch (e) {
    return reply(state, `❌ 聚焦失败：${asText(e)}`);
  }
}

async function cmdMoveWindow(state: SessionState, x: number, y: number): Promise<SessionState> {
  if (state.pid === null) return reply(state, "先「打开 <应用>」或「读取 <应用>」。");
  const win = state.outline.find((n) => n.role === "AXWindow");
  if (!win) return reply(state, "❌ 当前结构里没有窗口节点，说「读一下」刷新。");
  try {
    const prev = await readAttribute(state.pid, win.path, "AXPosition").catch(() => null);
    await setPosition(state.pid, win.path, x, y, { role: win.role, label: win.label });
    const undo =
      prev && prev.includes("x:")
        ? { kind: "set_position" as const, pid: state.pid, path: win.path, prev, label: "窗口" }
        : state.undo;
    return reply(
      { ...state, undo },
      `✅ 已把 ${state.appName ?? "应用"} 的窗口移到 (${x}, ${y})`,
    );
  } catch (e) {
    return reply(state, `❌ 移动失败：${asText(e)}`);
  }
}

async function cmdProbe(state: SessionState, x: number, y: number): Promise<SessionState> {
  try {
    const hit = await elementAt(x, y);
    const where = hit.title || hit.description || "(无标题)";
    // Reverse hit-test: resolve the element's path inside its own app, then
    // switch the session to that app so the user can keep operating on it.
    let traceLine = "";
    let next: SessionState = state;
    try {
      const traced = await tracePath(x, y);
      traceLine = `\n路径 [${traced.path.join(", ")}]（已在当前会话接管 pid ${traced.pid}）`;
      if (traced.pid > 0) {
        let outline: OutlineNode[] = [];
        try {
          outline = await treeOf(traced.pid, 10);
        } catch {
          /* outline is best-effort */
        }
        next = { ...state, pid: traced.pid, outline };
      }
    } catch (e) {
      traceLine = `\n（反查路径失败：${asText(e)}）`;
    }
    return reply(
      next,
      `📍 (${x}, ${y}) 处是 ${hit.role.replace("AX", "")}「${where}」，属于 pid ${hit.pid}。${traceLine}\n要操作它：直接说「点击/输入…」或先「读一下」。`,
    );
  } catch (e) {
    return reply(state, `❌ 点选失败：${asText(e)}`);
  }
}

async function cmdApps(state: SessionState): Promise<SessionState> {
  try {
    const apps = await listApps();
    const lines = apps
      .slice(0, 25)
      .map((a) => `· ${a.name}${a.is_active ? "（当前活跃）" : ""}`);
    return reply(state, `🖥 正在运行的 GUI 应用：\n${lines.join("\n")}\n说「打开 <名称>」开始操作其中一个。`);
  } catch (e) {
    return reply(state, `❌ 列举失败：${asText(e)}`);
  }
}

function helpReply(state: SessionState): SessionState {
  return reply(
    state,
    [
      "直接用自然语言告诉我目标就行，比如：",
      "· 帮我在备忘录记一下明天买牛奶",
      "· 打开腾讯视频摆到屏幕中间，看看有没有弹窗",
      "· 把 WeChat 和备忘录左右分屏，各总结一下界面",
      "",
      "也保留了一批快捷指令（离线兜底，不依赖模型）：",
      "· 打开 TextEdit —— 启动/聚焦一个应用",
      "· 应用列表 —— 看看现在都开着什么",
      "· 读一下 / 读 Safari —— 看界面上有什么",
      "· 找 设置 · 点击 新建 —— 搜元素 / 按关键词点击",
      "· 输入 你好 @搜索 —— 往文本框写文字（@字段 可省略）",
      "· 聚焦 搜索 · 移动窗口 100 100 · 点 600 400",
      "",
      "配置模型后（⚙️ 或项目根目录 .env）就能说完整任务，我会自己规划步骤。",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// LLM agent mode (🤖): the model plans, we execute tools, it reports back
// ---------------------------------------------------------------------------

import { agentTools, llmChatStream, llmConfigured, type LlmMessage } from "./llm";
import { mcpLocalCall, memoryList } from "./api";

/** Monotonic id for assistant tool-step cards (🤖 N/25 bubbles). */
let nextId = 1;




/** Execute one tool call against the session; returns JSON result text. */
async function runTool(
  state: SessionState,
  name: string,
  args: Record<string, unknown>,
  opts?: { confirmed?: boolean },
): Promise<ToolResult> {
  try {
    if (!opts?.confirmed) {
      const danger = dangerousReason(name, args);
      if (danger) return { result: "⏸ 等待用户确认", state, dangerous: danger };
    }
    switch (name) {
      case "list_apps":
        return toolListApps(state, args);
      case "open_app":
        return toolOpenApp(state, args);
      case "read_screen":
        return toolReadScreen(state, args);
      case "wait_for":
        return toolWaitFor(state, args);
      case "ocr":
        return toolOcr(state, args);
      case "find":
        return toolFind(state, args);
      case "click":
        return toolClick(state, args);
      case "type_text":
        return toolTypeText(state, args);
      case "focus":
        return toolFocus(state, args);
      case "move_window":
        return toolMoveWindow(state, args);
      case "resize_window":
        return toolResizeWindow(state, args);
      case "element_at":
        return toolElementAt(state, args);
      case "scroll":
        return toolScroll(state, args);
      case "scroll_to":
        return toolScrollTo(state, args);
      case "named_action":
        return toolNamedAction(state, args);
      case "key":
        return toolKey(state, args);
      case "type_keys":
        return toolTypeKeys(state, args);
      case "click_at":
        return toolClickAt(state, args);
      case "double_click_at":
        return toolDoubleClickAt(state, args);
      case "drag":
        return toolDrag(state, args);
      case "menu_bar":
        return toolMenuBar(state, args);
      case "menu_click":
        return toolMenuClick(state, args);
      case "right_click_at":
        return toolRightClickAt(state, args);
      case "done":
        return toolDone(state, args);
      case "clipboard_set":
      case "clipboard_get":
      case "notify":
      case "open_url":
      case "speak":
      case "screen_info":
      case "frontmost_app":
      case "profile_search":
      case "fs_scan":
      case "fs_move":
        return toolDesktop(state, name, args);
      default:
        if (name.startsWith("mcp_local_")) {
          const qualified = name.slice("mcp_local_".length);
          return { result: await mcpLocalCall(qualified, args), state };
        }
        return { result: `未知工具 ${name}`, state };
    }
  } catch (e) {
    return { result: `工具执行失败: ${asText(e)}`, state };
  }
}

/**
 * LLM agent loop: send conversation to the model, execute its tool calls,
 * repeat until it answers with prose (or the step budget runs out).
 */
/** Human-friendly message for common LLM API failures. */
/** Cooperative stop flag: the ChatView stop button sets this mid-run. */
let stopRequested = false;

/** Guard: only one agent loop may run at a time (double-click / rapid sends). */
let isRunning = false;

/** Ask the running agent loop to stop at the next safe point. */
export function requestStop(): void {
  stopRequested = true;
}

/** Tools that only observe — exempt from the exact-signature loop guard
 *  (re-reading the screen after an action is the correct verification loop). */
const OBSERVE_TOOLS = new Set([
  "ocr",
  "read_screen",
  "screen_info",
  "frontmost_app",
  "list_apps",
  "wait_for",
  "find",
  "element_at",
]);

interface StepOutcome {
  state: SessionState;
  ended: "prose" | "paused" | "budget";
}

/**
 * Core agent step loop: stream a model turn, execute its tool calls inline
 * (each step bubble shows args first, then its result), until the model
 * answers with prose, the step budget runs out, a dangerous tool pauses for
 * user confirmation, or the user hits stop.
 *
 * Every intermediate state is pushed through `onProgress` so the chat renders
 * live (thinking → steps → results → prose) instead of all at once after the
 * run finishes.
 *
 * Shared by runAgent / resumeAgent / confirmPending so every resume path
 * behaves identically.
 */
async function runSteps(
  working: SessionState,
  llmHistory: LlmMessage[],
  budget: number,
  seqBase: number,
  onProgress?: (s: SessionState) => void,
): Promise<StepOutcome> {
  // Commit an intermediate state to the view without losing the return value.
  const commit = (s: SessionState): SessionState => {
    onProgress?.(s);
    return s;
  };

  // One permission snapshot per segment, injected into the system prompt so
  // the model knows up front which capabilities are unavailable (avoids
  // burning steps discovering "截图失败" errors mid-task).
  let sysPrompt = SYSTEM_PROMPT;
  try {
    const perm = await permissionStatus();
    const missing: string[] = [];
    if (!perm.screen_recording) missing.push("截图/OCR（屏幕录制未授权，screenshot/ocr 会直接失败——不要尝试，改用 AX 工具）");
    if (!perm.input_monitoring) missing.push("合成键盘 key/type_keys（输入监控未授权——不要尝试，改用 type_text 语义写入）");
    if (!perm.post_events) missing.push("合成鼠标 click_at/drag/scroll（事件注入未授权——只用语义 click）");
    sysPrompt = SYSTEM_PROMPT + environmentLimitNote(missing);
  } catch {
    /* probe failed → fall back to the static prompt */
  }

  // Cross-session memory: apps the agent has driven before, injected so the
  // model knows what the user actually uses (and can open them faster).
  try {
    const mem = await memoryList();
    if (mem.length > 0) {
      const apps = mem
        .slice(0, 8)
        .map((e) => `${e.name}（${e.count}次，最近 ${new Date(e.last_used * 1000).toLocaleDateString("zh-CN")}）`)
        .join("、");
      sysPrompt += `\n\n【跨会话记忆】你以前驱动过这些应用（按次数排序）：${apps}。用户熟悉它们、常在里面做任务——需要打开应用时优先考虑列表里的名字。`;
    }
  } catch {
    /* memory is best-effort */
  }

  // Signatures of recently executed tool calls; repeating one (even with
  // other calls in between) means the model is stuck in a loop — clicking
  // the same self-drawn UI target over and over without re-reading. Kept to
  // the last 4 so a legitimate repeated action (same key twice, etc.) still
  // slips through after a few other steps.
  let recentSigs: string[] = [];

  for (let steps = 0; steps < budget; steps += 1) {
    if (stopRequested) {
      stopRequested = false;
      working = commit({ ...working, pending: null, llmHistory });
      return {
        state: commit(
          reply(
            working,
            `🛑 已在第 ${seqBase + steps + 1} 步停下（上下文已保留）。回复「继续」接着做，或直接说新任务。`,
          ),
        ),
        ended: "paused",
      };
    }

    let turn;
    try {
      // Streaming: forward content deltas into a live bubble. When the model
      // is calling tools (no prose) the stream emits nothing and the step
      // bubbles below are the visible feedback instead.
      let streamIdx: number | null = null;
      turn = await llmChatStream(
        [{ role: "system", content: sysPrompt }, ...llmHistory],
        await agentTools(),
        (full) => {
          if (streamIdx === null) {
            streamIdx = nextId++;
            working = commit({
              ...working,
              messages: [...working.messages, { id: streamIdx, role: "assistant", text: full }],
            });
          } else {
            working = commit({
              ...working,
              messages: working.messages.map((m) =>
                m.id === streamIdx ? { ...m, text: full } : m,
              ),
            });
          }
        },
      );
    } catch (e) {
      // On transient failures keep the conversation (user message + progress)
      // so the user can simply resend / continue after the rate limit clears.
      return {
        state: commit({
          ...reply(working, friendlyLlmError(asText(e))),
          llmHistory: llmHistory.slice(0, -1), // drop the unserved user turn
        }),
        ended: "paused",
      };
    }

    if (turn.finish_reason === "tool_calls" || (turn.tool_calls?.length ?? 0) > 0) {
      llmHistory.push({ role: "assistant", content: turn.content || null, tool_calls: turn.tool_calls });
      for (const call of turn.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          /* treat as empty args */
        }
        const argsSig = (call.function.arguments || "{}").replace(/\s+/g, " ");
        const sig = OBSERVE_TOOLS.has(call.function.name)
          ? ""
          : `${call.function.name} ${argsSig}`;
        if (recentSigs.includes(sig)) {
          // Loop guard: the model just ran this exact operation (possibly a
          // few calls ago). Don't re-execute — prompt it to check the state.
          const hint =
            `您最近已执行过完全相同的操作（工具与参数一致）：${sig}。不要原样重试。\n` +
            "请先确认界面现状（自绘 UI 用 ocr；AX 树用 read_screen 加 filter）：\n" +
            "- 若用户目标已经客观达成 → 直接用 done 汇报并结束；\n" +
            "- 若未达成 → 换一种操作推进（改坐标、换工具、先滚动/等待），不要重复点击同一位置。";
          const seq = `${seqBase + steps + 1}/${budget}`;
          const heading = stepHeading(seq, call.function.name, args);
          const stepId = nextId++;
          working = commit({
            ...working,
            messages: [...working.messages, { id: stepId, role: "assistant", text: withStepResult(heading, hint) }],
          });
          llmHistory.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: hint });
          continue;
        }
        if (sig) {
          recentSigs.push(sig);
          if (recentSigs.length > 4) recentSigs.shift();
        }
        // Blind-click guard: clicking without ever re-reading the screen.
        // Exact-signature dedup above is dodged by micro-adjusting coordinates
        // (115,318 → 118,320), and self-drawn UIs (Tencent Video etc.) render
        // nothing into the AX tree, so the model literally cannot see the
        // result of a click unless it ocr/wait_for. Same-region repeats are
        // the true blindness loop and get BLOCKED; clicks at different
        // coordinates may still be legitimate progression (e.g. closing a
        // dialog after two stray probes), so those get a warning appended to
        // the real result instead of being refused.
        let blindWarn: string | null = null;
        const isClickTool =
          call.function.name === "click_at" || call.function.name === "double_click_at";
        const cx = isClickTool && typeof args.x === "number" ? Number(args.x) : null;
        const cy = isClickTool && typeof args.y === "number" ? Number(args.y) : null;
        const blind = tui.trackMove(call.function.name, cx, cy);
        if (blind.block) {
          const seq = `${seqBase + steps + 1}/${budget}`;
          const heading = stepHeading(seq, call.function.name, args);
          const stepId = nextId++;
          working = commit({
            ...working,
            messages: [...working.messages, { id: stepId, role: "assistant", text: withStepResult(heading, blind.block) }],
          });
          llmHistory.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: blind.block });
          continue;
        }
        blindWarn = blind.warn ?? null;
        const seq = `${seqBase + steps + 1}/${budget}`;
        const heading = stepHeading(seq, call.function.name, args);
        const stepId = nextId++;
        working = commit({
          ...working,
          messages: [...working.messages, { id: stepId, role: "assistant", text: heading }],
        });
        const { result: rawResult, state: next, dangerous } = await runTool(working, call.function.name, args);
        const result = blindWarn ? `${rawResult}\n${blindWarn}` : rawResult;
        working = next;
        if (dangerous) {
          working = commit({
            ...working,
            pending: { name: call.function.name, args, reason: dangerous, toolCallId: call.id },
            messages: working.messages.map((m) =>
              m.id === stepId
                ? {
                    ...m,
                    text:
                      `⚠️ 需要确认：\`${call.function.name}\`${argsText(args) ? " " + argsText(args) : ""}\n\n` +
                      `${dangerous}\n\n在底部选择「✅ 执行」或「取消」。`,
                  }
                : m,
            ),
          });
          return { state: working, ended: "paused" };
        }
        working = commit({
          ...working,
          messages: working.messages.map((m) =>
            m.id === stepId ? { ...m, text: withStepResult(heading, result) } : m,
          ),
        });
        llmHistory.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: result });
        // `done` is the model's terminal report — end the segment right here
        // instead of looping (a follow-up LLM turn used to re-summarize and
        // duplicate the text in the transcript). When the model also emitted
        // body text alongside the tool call, prefer THAT as the final reply:
        // tool-call args are emitted last and get truncated on small output
        // budgets (19:24 session showed a summary cut off at '- P'), while
        // the streamed body text stays complete.
        if (call.function.name === "done") {
          const body = (turn.content || "").trim();
          const finalState = body
            ? reply(working, body)
            : working;
          return {
            state: commit({ ...finalState, pending: null, llmHistory }),
            ended: "prose",
          };
        }
      }
      continue;
    }

    // Final prose answer.
    llmHistory.push({ role: "assistant", content: turn.content });
    return {
      state: commit({ ...reply(working, turn.content || "（模型没有返回内容）"), pending: null, llmHistory }),
      ended: "prose",
    };
  }
  return { state: commit({ ...working, pending: null, llmHistory }), ended: "budget" };
}

/**
 * Resume a paused agent run (budget exhausted): same LLM context, fresh
 * budget, and a nudge so the model knows it may continue.
 */
async function resumeAgent(
  state: SessionState,
  onProgress?: (s: SessionState) => void,
): Promise<SessionState> {
  const llmHistory: LlmMessage[] = state.llmHistory ?? [];
  llmHistory.push({ role: "user", content: CONTINUE_NUDGE });
  void hideAside(state.pid ?? undefined); // drive mode: out of the target's way

  const working = reply({ ...state, pending: null }, "🤖 继续执行…（新额度 " + MAX_AGENT_STEPS + " 步）");
  onProgress?.(working);
  const outcome = await runSteps(working, llmHistory, MAX_AGENT_STEPS, 0, onProgress);
  const next = outcome.state;
  void bringBack();
  if (outcome.ended === "budget") {
    const nudge = reply(next, `⚠️ 又执行了 ${MAX_AGENT_STEPS} 步，再次暂停。任务比较大？把它拆成几句小指令会更稳。`);
    onProgress?.(nudge);
    return nudge;
  }
  return next; // prose / paused（确认或已停止）
}

async function runAgent(
  state: SessionState,
  userText: string,
  onProgress?: (s: SessionState) => void,
): Promise<SessionState> {
  const llmHistory: LlmMessage[] = state.llmHistory ?? [];
  llmHistory.push({ role: "user", content: userText });

  let working = reply(state, "🤖 正在思考…");
  onProgress?.(working);
  stopRequested = false;
  // Drive mode: while the agent operates another app, move our window to a
  // screen the target does not occupy (or a free corner), so the target keeps
  // focus and the user can watch it act. Restored on every exit path below.
  void hideAside(state.pid ?? undefined);

  // Hard budget: at most MAX_AGENT_STEPS tool steps per run, then we pause and
  // hand control back. No silent auto-continue — the step counter ("N/25")
  // must never be exceeded, otherwise it looks like the task runs away.
  const outcome = await runSteps(working, llmHistory, MAX_AGENT_STEPS, 0, onProgress);
  working = outcome.state;
  void bringBack(); // task segment over (budget/paused/prose): window back
  if (outcome.ended === "budget") {
    working = reply(
      working,
      `⚠️ 已执行满 ${MAX_AGENT_STEPS} 步，暂停（上下文已保留）。\n· 回复「继续」接着做，可再获得 ${MAX_AGENT_STEPS} 步\n· 或让我调整方向`,
    );
    onProgress?.(working);
  }
  void logSession(working);
  return working;
}

/**
 * Handle the dangerous-operation confirmation bar. `approve=true` executes
 * the paused tool call; `false` feeds the model a "user cancelled" result.
 * Either way the remaining task keeps running with a fresh step budget.
 */
export async function confirmPending(
  state: SessionState,
  approve: boolean,
  onProgress?: (s: SessionState) => void,
): Promise<SessionState> {
  const pending = state.pending;
  if (!pending) return state;
  const llmHistory: LlmMessage[] = state.llmHistory ?? [];
  let working: SessionState = { ...state, pending: null };
  const commit = (s: SessionState): SessionState => {
    onProgress?.(s);
    return s;
  };

  if (approve) {
    const { result, state: next } = await runTool(working, pending.name, pending.args, { confirmed: true });
    working = next;
    llmHistory.push({ role: "tool", tool_call_id: pending.toolCallId, name: pending.name, content: result });
    working = commit(reply(working, `✅ 已执行你确认的操作：\`${pending.name}\`${argsText(pending.args) ? " " + argsText(pending.args) : ""}`));
  } else {
    llmHistory.push({
      role: "tool",
      tool_call_id: pending.toolCallId,
      name: pending.name,
      content:
        "用户取消了该操作（未执行）。请调整方案去完成剩余目标；后续不要再触发同类不可逆操作，需要时先向用户确认。",
    });
    working = commit(reply(working, `🚫 已取消 \`${pending.name}\`，继续完成其余部分。`));
  }

  void hideAside(state.pid ?? undefined); // continuing the paused task: drive mode again
  const outcome = await runSteps(working, llmHistory, MAX_AGENT_STEPS, 0, commit);
  const next = outcome.state;
  void bringBack();
  if (outcome.ended === "budget") {
    const nudge = reply(next, `⚠️ 又执行了 ${MAX_AGENT_STEPS} 步，暂停。回复「继续」续跑。`);
    commit(nudge);
    void logSession(nudge);
    return nudge;
  }
  void logSession(next);
  return next;
}

/**
 * Undo the last reversible mutation (text overwrite / window move): restore
 * the value/position captured before it ran. Returns the updated session.
 */
export async function undoLast(state: SessionState): Promise<SessionState> {
  const u = state.undo;
  if (!u) return state;
  try {
    if (u.kind === "set_value") {
      await setValue(u.pid, u.path, u.prev);
    } else if (u.kind === "set_size") {
      const w = Number(/(?:w:\s*)(-?\d+(?:\.\d+)?)/.exec(u.prev)?.[1] ?? NaN);
      const h = Number(/(?:h:\s*)(-?\d+(?:\.\d+)?)/.exec(u.prev)?.[1] ?? NaN);
      if (!Number.isFinite(w) || !Number.isFinite(h)) throw new Error(`无法解析原尺寸 ${u.prev}`);
      await resizeWindow(u.pid, u.path, w, h);
    } else {
      const x = Number(/(?:x:\s*)(-?\d+(?:\.\d+)?)/.exec(u.prev)?.[1] ?? NaN);
      const y = Number(/(?:y:\s*)(-?\d+(?:\.\d+)?)/.exec(u.prev)?.[1] ?? NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`无法解析原位置 ${u.prev}`);
      await setPosition(u.pid, u.path, x, y);
    }
    return reply(
      { ...state, undo: null },
      `↩️ 已撤销对「${u.label}」的修改（恢复原${u.kind === "set_value" ? "文本" : u.kind === "set_size" ? "尺寸" : "位置"}）。`,
    );
  } catch (e) {
    return reply(state, `❌ 撤销失败：${asText(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Handle one user utterance; returns the updated session. */
export async function handleUtterance(
  state: SessionState,
  raw: string,
  onProgress?: (s: SessionState) => void,
): Promise<SessionState> {
  const input = raw.trim();
  if (!input) return state;

  const withUser: SessionState = {
    ...state,
    messages: [...state.messages, { id: nextId++, role: "user", text: input }],
  };

  const cmd = parseCommand(input);

  // 帮助 always answered locally: cheap and works without a model.
  if (cmd?.kind === "help") return helpReply(withUser);

  // Unified mode: the LLM plans and executes everything natural-language;
  // the fixed parser below is only an offline fallback when no model is
  // configured (⚙️ settings or AX_EXPLORER_LLM_* in .env).
  try {
    const info = await llmConfigured();
    if (info.configured) {
      // 「继续」 resumes the paused run with a fresh step budget.
      if (cmd?.kind === "continue") {
        if (isRunning) return reply(withUser, "⏳ 上一轮还在执行，请等待完成或先「停止」再「继续」。");
        const history = withUser.llmHistory ?? [];
        if (!history.length) {
          return reply(withUser, "还没有进行中的任务，直接说你想做什么吧。");
        }
        isRunning = true;
        try {
          const next = await resumeAgent(withUser, onProgress);
          void logSession(next);
          return next;
        } finally {
          isRunning = false;
        }
      }
      if (isRunning) return reply(withUser, "⏳ 上一轮还在执行，请等待完成或先「停止」再发新指令。");
      isRunning = true;
      try {
        const next = await runAgent(withUser, input, onProgress);
        void logSession(next);
        return next;
      } finally {
        isRunning = false;
      }
    }
  } catch {
    // Config probe failed (e.g. backend restarting) → parser fallback.
  }

  switch (cmd?.kind) {
    case "open":
      return cmdOpen(withUser, cmd.target, cmd.tail);
    case "apps":
      return cmdApps(withUser);
    case "read":
      return cmdRead(withUser, cmd.app);
    case "refresh":
      return cmdRead(withUser, "");
    case "probe":
      return cmdProbe(withUser, cmd.x, cmd.y);
    case "move":
      return cmdMoveWindow(withUser, cmd.x, cmd.y);
    case "type":
      return cmdType(withUser, cmd.text);
    case "click":
      return cmdClick(withUser, cmd.keyword);
    case "focus":
      return cmdFocus(withUser, cmd.keyword);
    case "find":
      return cmdFind(withUser, cmd.keyword);
    default:
      // Fallback: explain that natural language needs a configured model.
      return reply(
        withUser,
        [
          `没听懂「${truncate(input, 30)}」。`,
          "当前没有配置 LLM，只能用快捷指令：",
          "打开 / 读一下 / 找 <词> / 点击 <词> / 输入 <文本> / 帮助。",
          "配置模型后就能直接说完整任务 —— 点 ⚙️ 设置，或在项目根目录 .env 里填 AX_EXPLORER_LLM_*。",
        ].join("\n"),
      );
  }
}
