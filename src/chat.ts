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
  clickAt,
  doubleClickAt,
  drag,
  elementAt,
  fetchTree,
  focusElement,
  listApps,
  menuBar,
  namedAction,
  openApp,
  performAction,
  ocrWindow,
  observeWait,
  permissionStatus,
  pressKey,
  readAttribute,
  resizeWindow,
  resizeWindowByPid,
  moveWindowByPid,
  rightClickAt,
  scrollAt,
  scrollToVisible,
  setPosition,
  setValue,
  tracePath,
  typeKeys,
  windowBounds,
} from "./api";
import type { AxAppInfo, OcrScreenWord } from "./types";
import { TencentUiState } from "./tencent-ui";
import { NeteaseUiState } from "./netease-ui";
import {
  CONTINUE_NUDGE,
  MAX_AGENT_STEPS,
  STEP_RE,
  SYSTEM_PROMPT,
  dangerousReason,
  environmentLimitNote,
} from "./agent-config.ts";
import {
  findNodes,
  findNodesAny,
  flatten,
  renderOutline,
  truncate,
} from "./tree-utils.ts";
import {
  argsText,
  asText,
  filterMenu,
  friendlyLlmError,
  parseCommand,
  renderMenu,
  stepHeading,
  withStepResult,
} from "./tool-utils.ts";
import {
  NAV_WORDS,
  garbledOcrNote,
  navWordNote,
  resolveWindowPlacement,
  type ScreenInfo,
} from "./tool-utils.ts";
import type { OutlineNode } from "./types.ts";
import { bringBack, focusSelf, hideAside } from "./windowctl";
import { invoke } from "@tauri-apps/api/core";

/** One chat message (assistant = command replies, user = typed input). */
export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
}

/** One reversible mutation, remembered so the user can undo it. */
export interface UndoRecord {
  kind: "set_value" | "set_position" | "set_size";
  pid: number;
  path: number[];
  /** Old AXValue text, or "x,y" position, or "w,h" size, before the mutation. */
  prev: string;
  label: string;
}

/** A tool call paused for dangerous-operation confirmation. */
export interface PendingAction {
  name: string;
  args: Record<string, unknown>;
  /** Human-readable reason shown in the confirm bar. */
  reason: string;
  /** id of the assistant tool_call, needed to post the tool result later. */
  toolCallId: string;
}

export interface SessionState {
  messages: ChatMessage[];
  /** pid of the app the session is driving, if any. */
  pid: number | null;
  appName: string | null;
  /** Flattened outline of the last tree dump. */
  outline: OutlineNode[];
  /** LLM (OpenAI-format) conversation history for agent mode. */
  llmHistory?: LlmMessage[];
  /** Last reversible mutation, for the undo button. */
  undo?: UndoRecord | null;
  /** Dangerous tool call awaiting user confirmation. */
  pending?: PendingAction | null;
}

let nextId = 1;

/** Last read_screen output (app+pid → text) so an unchanged re-read is flagged. */
let lastRead: { key: string; text: string } | null = null;

export function newSession(): SessionState {
  return { messages: [], pid: null, appName: null, outline: [] };
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
  lines.push("# AX Explorer 会话记录");
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

async function treeOf(pid: number, depth: number): Promise<OutlineNode[]> {
  const tree = await fetchTree(pid, depth);
  return flatten(tree);
}

// ---------------------------------------------------------------------------
// Command handlers — each returns the next session state
// ---------------------------------------------------------------------------

async function cmdOpen(state: SessionState, target: string): Promise<SessionState> {
  let next = reply(state, `正在打开「${target}」…`);
  try {
    const app: AxAppInfo = await openApp(target);
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
        `✅ 已打开 ${app.name}（pid ${app.pid}）\n当前界面里的可操作元素：\n${renderOutline(outline) || "（未发现常规元素）"}`,
      );
    } catch {
      return reply(withPid, `✅ 已打开 ${app.name}（pid ${app.pid}）。说「读一下」查看它的界面。`);
    }
  } catch (e) {
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
import { desktopToolExec, mcpLocalCall } from "./api";



const tui = new TencentUiState();
const nui = new NeteaseUiState();

/** Which per-app UI decision state a target app uses. NetEase and Tencent
 * are both self-drawn (AX empty) but have different page models; every
 * other app gets no UI hints (the generic ocr/click loop). */
function uiKind(appName: string | null): "tencent" | "netease" | null {
  if (!appName) return null;
  if (/网易云音乐|netease|163music/i.test(appName)) return "netease";
  if (/腾讯视频|tencent/i.test(appName)) return "tencent";
  return null;
}

/**
 * Clamp a screen point into the session target's main window frame, so
 * synthetic scroll/click/drag events never land on another app or the
 * desktop when the model guesses out-of-window coordinates. Returns the
 * corrected point plus a human note ("" when unchanged).
 */
async function clampToWindow(
  pid: number | null,
  x: number,
  y: number,
): Promise<{ x: number; y: number; note: string }> {
  if (pid === null) return { x, y, note: "" };
  try {
    const b = await windowBounds(pid);
    if (!b) return { x, y, note: "" };
    const cx = Math.min(Math.max(x, b.x), b.x + b.w - 1);
    const cy = Math.min(Math.max(y, b.y), b.y + b.h - 1);
    if (cx !== x || cy !== y) {
      return {
        x: cx,
        y: cy,
        note: `（坐标 (${Math.round(x)}, ${Math.round(y)}) 不在目标应用窗口内，已校正为 (${Math.round(cx)}, ${Math.round(cy)})）`,
      };
    }
  } catch {
    /* 拿不到窗口就不校正 */
  }
  return { x, y, note: "" };
}

/** Re-dump the outline after an action, keeping the old one on failure. */
async function refreshOutline(state: SessionState, depth = 10): Promise<SessionState> {
  if (state.pid === null) return state;
  try {
    return { ...state, outline: await treeOf(state.pid, depth) };
  } catch {
    return state;
  }
}

/** Strict numeric x/y arg parsing (null when missing or non-numeric). */
function coordArgs(args: Record<string, unknown>): { x: number; y: number } | null {
  const x = Number(args.x);
  const y = Number(args.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** Execute one tool call against the session; returns JSON result text. */
async function runTool(
  state: SessionState,
  name: string,
  args: Record<string, unknown>,
  opts?: { confirmed?: boolean },
): Promise<{ result: string; state: SessionState; dangerous?: string }> {
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  try {
    if (!opts?.confirmed) {
      const danger = dangerousReason(name, args);
      if (danger) return { result: "⏸ 等待用户确认", state, dangerous: danger };
    }
    switch (name) {
      case "list_apps": {
        const apps = await listApps();
        state = { ...state };
        return {
          result: apps.slice(0, 25).map((a) => `${a.name} (pid ${a.pid})`).join("\n"),
          state,
        };
      }
      case "open_app": {
        const app: AxAppInfo = await openApp(str("app"));
        // No focusSelf() here: in drive mode the target app must KEEP the
        // focus it just got — stealing it back breaks every subsequent
        // click_at (synthetic mouse goes to the frontmost app). The window
        // itself is parked on the other screen by hideAside().
        let outline: OutlineNode[] = [];
        try {
          outline = await treeOf(app.pid, 10);
        } catch {
          /* outline is best-effort */
        }
        state = { ...state, pid: app.pid, appName: app.name, outline };
        if (uiKind(app.name) === "netease") nui.resetForOpenApp();
        else tui.resetForOpenApp();
        // First moment the drive target's pid is known: park our window on a
        // screen the target does NOT occupy (the runAgent start may not have
        // known the pid yet when the app was already running).
        void hideAside(app.pid);
        return {
          result: `已打开 ${app.name} (pid ${app.pid})。界面元素：\n${renderOutline(outline) || "（未发现常规元素）"}`,
          state,
        };
      }
      case "read_screen": {
        const wanted = str("app");
        const filter = str("filter");
        let pid = state.pid;
        let name = state.appName ?? "";
        if (wanted) {
          const apps = await listApps();
          const hit = apps.find((a) => a.name.toLowerCase().includes(wanted.toLowerCase()));
          if (!hit) return { result: `未找到运行中的应用「${wanted}」`, state };
          pid = hit.pid;
          name = hit.name;
        }
        if (pid === null) return { result: "尚未选择应用，先用 open_app 打开一个", state };
        const outline = await treeOf(pid, 10);
        state = { ...state, pid, appName: name, outline };
        const shown = filter
          ? findNodesAny(outline, filter.split(/[,，\s]+/).filter(Boolean))
          : outline;
        const head = filter
          ? `${name} 中与「${filter}」相关的元素`
          : `${name} (pid ${pid}) 的界面`;
        const rendered = renderOutline(shown);
        const emptyHint = filter
          ? "（无匹配元素）"
          : "（未发现可读元素——若该应用界面有图片或文字内容，它可能是自绘 UI，请改用 ocr 读取屏幕文字）";
        const summary = `${head}：\n${rendered || emptyHint}`;
        const key = `${name}:${pid}`;
        let result = summary;
        if (lastRead && lastRead.key === key && lastRead.text === summary) {
          result =
            summary +
            "\n（注意：与上一次 read_screen 结果完全相同，界面在这一步没有变化。不要重复读取同一个界面：先用 find 检索当前大纲，或换一个操作推进；交互发生后界面自然会更新。）";
        }
        lastRead = { key, text: summary };
        return { result, state };
      }
      case "wait_for": {
        const keyword = str("element");
        const ocrText = str("text");
        const gone = args.gone === true;
        const timeout = Math.min(Math.max(Number(args.timeout) || 8, 1), 10);
        const pid = state.pid;
        if (pid === null)
          return { result: "尚未选择应用，先用 open_app 打开一个", state };
        if (!keyword && !ocrText) {
          return {
            result:
              "wait_for 未指定目标，仅报告界面是否变化（不推荐：空等待常是浪费步数）。" +
              "请给 element（等 AX 元素出现/消失）或 text（等屏幕文字出现/消失，自绘 UI 用）后再等。",
            state,
          };
        }
        const deadline = Date.now() + timeout * 1000;
        let lastOutline = state.outline;
        let lastWords: OcrScreenWord[] = [];
        let waited = 0;
        let step = 2;
        while (Date.now() < deadline) {
          const w = await observeWait(pid, step);
          waited += w.waited_secs;
          if (ocrText) {
            // 自绘 UI：用 OCR 等某段屏幕文字出现（gone=false）或消失（gone=true）。
            // 截图+识别开销大：界面文字没变化时拉长轮询间隔（2→5s），有变化
            // 时回到密集轮询，兼顾响应速度与资源。
            let words: OcrScreenWord[] = [];
            try {
              words = await ocrWindow(pid);
            } catch {
              /* 截图/识别失败时继续等下一轮 */
            }
            const stable =
              words.length === lastWords.length &&
              words.every((wd, i) => wd.text === lastWords[i]?.text);
            step = stable ? Math.min(step + 1, 5) : 2;
            lastWords = words;
            const hit = words.find((x) => x.text.includes(ocrText));
            if (gone ? !hit : hit) {
              const where = hit
                ? ` (${Math.round(hit.x)}, ${Math.round(hit.y)})`
                : "";
              // Nav words are always visible — matching one does not prove a
              // page switch, and the model must not treat it as one.
              const navWarn = navWordNote(ocrText, gone);
              return {
                result: `等待完成（${waited}s）：屏幕文字「${ocrText}」已${gone ? "消失" : `出现${where}`}${navWarn}`,
                state,
              };
            }
          } else {
            let outline = lastOutline;
            try {
              outline = await treeOf(pid, 10);
            } catch {
              /* 树读取失败时沿用上一份 */
            }
            if (keyword) {
              const hits = findNodes(outline, keyword);
              if (gone ? hits.length === 0 : hits.length > 0) {
                state = { ...state, outline };
                return {
                  result: gone
                    ? `等待完成（${waited}s）：「${keyword}」已消失`
                    : `等待完成（${waited}s）：「${keyword}」已出现\n${renderOutline(hits)}`,
                  state,
                };
              }
            } else if (JSON.stringify(outline) !== JSON.stringify(lastOutline)) {
              state = { ...state, outline };
              return { result: `等待完成（${waited}s）：界面已发生变化`, state };
            }
            lastOutline = outline;
            state = { ...state, outline };
          }
        }
        const tail = ocrText
          ? `屏幕文字「${ocrText}」在 ${timeout}s 内未${gone ? "消失" : "出现"}。当前可见文字：\n${
              lastWords.slice(0, 12).map((x) => x.text).join(" / ") || "（无）"
            }`
          : keyword
            ? `「${keyword}」在 ${timeout}s 内未${gone ? "消失" : "出现"}`
            : `界面在 ${timeout}s 内无变化`;
        // Nav words are always on screen — waiting for them proves nothing
        // about page switches and fails hard when OCR garbles the whole bar.
        const navHint =
          ocrText && !gone && NAV_WORDS.some((w) => ocrText.includes(w))
            ? `\n注意：「${ocrText}」是导航栏常驻词，几乎任何页面都有，等它出现无法证明页面切换。` +
              "应等页面切换后才会出现的特征词：频道页的筛选栏（最热/最新/高分好评/类型）、影片名、评分数字等。"
            : "";
        const garbledHint = garbledOcrNote(lastWords);
        return {
          result: `${tail}${navHint}${garbledHint}。当前界面：\n${renderOutline(state.outline) || "（无元素）"}`,
          state,
        };
      }
      case "ocr": {
        const wanted = str("app");
        let pid = state.pid;
        let name = state.appName ?? "";
        if (wanted) {
          const apps = await listApps();
          const hit = apps.find((a) => a.name.toLowerCase().includes(wanted.toLowerCase()));
          if (!hit) return { result: `未找到运行中的应用「${wanted}」`, state };
          pid = hit.pid;
          name = hit.name;
        }
        // No session target yet? Fall back to the frontmost app — after
        // open_app failed early the target is usually still frontmost.
        if (pid === null) {
          const fm = await desktopToolExec("frontmost_app", {});
          const m = /^(.+?) \(pid (\d+)\)$/.exec(fm.trim());
          if (m) {
            pid = Number(m[2]);
            name = m[1];
          }
        }
        if (pid === null) return { result: "尚未选择应用，先用 open_app 打开一个", state };
        const words = await ocrWindow(pid);
        state = { ...state, pid, appName: name };
        if (!words.length) return { result: `${name} 窗口 OCR 未识别到文字（也许是纯图像界面）`, state };
        // The whole Tencent-Video OCR decision (page classification, rating
        // pairing, mini-player detection, all 11 hints, state updates) lives
        // in TencentUiState.processOcr — regression-tested in
        // tests/tencent-ui.test.mjs with the real session word-lists.
        // NetEase CloudMusic routes through NeteaseUiState.processOcr (song
        // pairing + bottom-bar playback evidence) instead.
        const ui = uiKind(name);
        const { joined, hints } =
          ui === "netease" ? nui.processOcr(words) : tui.processOcr(words);
        return {
          result: `${name} 画面文字识别（坐标=屏幕点，可直接 click_at/type_keys）：\n${joined}${hints}`,
          state,
        };
      }
      case "find": {
        const kw = str("keyword");
        const hits = kw.includes(",") || /\s/.test(kw.trim())
          ? findNodesAny(state.outline, kw.split(/[,，\s]+/).filter(Boolean))
          : findNodes(state.outline, kw);
        return {
          result: hits.length
            ? hits.slice(0, 10).map((n) => `${n.role}「${n.label}」${n.value ? `值=${n.value}` : ""}${n.actions.length ? ` 动作=${n.actions.join(",")}` : ""}`).join("\n")
            : "无匹配元素",
          state,
        };
      }
      case "click": {
        if (state.pid === null) return { result: "尚未选择应用", state };
        const target = findNodes(state.outline, str("keyword"))[0];
        if (!target) return { result: `没有找到「${str("keyword")}」，先 read_screen`, state };
        if (!target.actions.length) return { result: `元素「${target.label}」不支持动作`, state };
        await performAction(state.pid, target.path, target.actions[0], { role: target.role, label: target.label });
        state = await refreshOutline(state);
        return { result: `已点击「${target.label}」（${target.actions[0]}）。界面大纲已自动更新，无需重复 read_screen。`, state };
      }
      case "type_text": {
        if (state.pid === null) return { result: "尚未选择应用", state };
        const field = str("field");
        const candidates = field ? findNodes(state.outline, field) : state.outline;
        const target = candidates.find(
          (n) => n.role === "AXTextArea" || n.role === "AXTextField" || n.role === "AXSearchField",
        );
        if (!target) return { result: "没有找到文本输入区", state };
        const prev = await readAttribute(state.pid, target.path, "AXValue").catch(() => null);
        await setValue(state.pid, target.path, str("text"), { role: target.role, label: target.label });
        try {
          await focusElement(state.pid, target.path, { role: target.role, label: target.label });
        } catch {
          /* focus is best-effort */
        }
        state = {
          ...state,
          undo: { kind: "set_value", pid: state.pid, path: target.path, prev: prev ?? "", label: target.label },
        };
        return { result: `已把文本写入「${target.label}」`, state };
      }
      case "focus": {
        if (state.pid === null) return { result: "尚未选择应用", state };
        const target = findNodes(state.outline, str("keyword"))[0];
        if (!target) return { result: `没有找到「${str("keyword")}」`, state };
        await focusElement(state.pid, target.path, { role: target.role, label: target.label });
        return { result: `焦点已给到「${target.label}」`, state };
      }
      case "move_window": {
        try {
        if (state.pid === null) return { result: "尚未选择应用", state };
        const win = state.outline.find((n) => n.role === "AXWindow");
        let x = Number(args.x);
        let y = Number(args.y);
        let resize: { w: number; h: number } | null = null;
        let screenIdx = 0;
        const position = str("position");
        if (position) {
          // 语义摆放：主屏边界 + 窗口当前尺寸换算坐标（纯函数，可测）。
          let parsed: ScreenInfo[] = [];
          try {
            parsed = JSON.parse(await desktopToolExec("screen_info", {}));
          } catch {
            /* 屏幕信息解析失败则报错 */
          }
          const sb = await windowBounds(state.pid).catch(() => null);
          const placed = resolveWindowPlacement(
            parsed,
            typeof args.screen === "number" ? args.screen : undefined,
            position,
            sb ? { w: sb.w, h: sb.h } : null,
          );
          if (!placed.ok) return { result: placed.error, state };
          x = placed.placement.x;
          y = placed.placement.y;
          resize = placed.placement.resize;
          screenIdx = placed.placement.screenIdx;
        }
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return {
            result: "需要 x/y 坐标（或 position 语义：left/right/center/maximize）",
            state,
          };
        }
        if (win) {
          const prev = await readAttribute(state.pid, win.path, "AXPosition").catch(() => null);
          await setPosition(state.pid, win.path, Math.round(x), Math.round(y), {
            role: win.role,
            label: win.label,
          });
          if (resize) {
            await resizeWindow(state.pid, win.path, resize.w, resize.h, {
              role: win.role,
              label: win.label,
            });
          }
          state = prev && prev.includes("x:")
            ? { ...state, undo: { kind: "set_position", pid: state.pid, path: win.path, prev, label: "窗口" } }
            : state;
        } else {
          // 自绘 UI / 树里没有窗口节点：退化到 pid 级窗口操作（AXWindows 第一个窗口）。
          await moveWindowByPid(state.pid, Math.round(x), Math.round(y));
          if (resize) await resizeWindowByPid(state.pid, resize.w, resize.h);
        }
        // Self-drawn apps (Tencent Video etc.) often RELOAD the page on
        // resize/maximize — the 电影 channel opened before the maximize can be
        // reset back to the home page. Must warn so the model re-navigates.
        const resetWarn = win
          ? ""
          : "\n注意：该应用是自绘 UI（无窗口节点），最大化/移动可能触发它重载页面（如腾讯视频会重置回首页）——之前刚完成的导航可能失效，先用 ocr 确认当前页面，必要时重新导航。";
        return {
          result:
            (position === "maximize"
              ? `窗口已最大化铺满 ${screenIdx === 0 ? "主屏" : `显示器 ${screenIdx}`}`
              : `窗口已移到 (${Math.round(x)}, ${Math.round(y)})${
                  resize ? ` 并调整到 ${resize.w}x${resize.h}` : ""
                }${screenIdx === 0 ? "" : `（显示器 ${screenIdx}）`}`) +
            "\n布局已变化：先 ocr 复核各元素当前位置再操作（最大化/移动动画期间的点击可能落空，且旧坐标已失效）。" +
            resetWarn,
          state,
        };
        } catch (e) {
          const msg = String(e);
          const maxi = str("position") === "maximize";
          return {
            result:
              `move_window 失败: ${msg}` +
              (maxi
                ? "\n窗口可能未最大化——自绘 UI 应用常不支持 AXPosition/AXSize 设置（如报错 -25200 system failure 时窗口原样未动）。不要假设最大化已生效：继续操作前先 ocr 复核当前元素坐标；若窗口尺寸够用就按现布局推进，或换 resize_window 显式调整。"
                : "\n窗口可能未移动/未缩放。先 ocr 复核当前布局再继续，旧坐标若失效则重新读取。"),
            state,
          };
        }
      }
      case "resize_window": {
        if (state.pid === null) return { result: "尚未选择应用", state };
        const w = Number(args.w);
        const h = Number(args.h);
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
          return { result: "w/h 必须是正数（points）", state };
        }
        const win = state.outline.find((n) => n.role === "AXWindow");
        if (!win) {
          // 自绘 UI / 树里没有窗口节点：pid 级兜底。
          try {
            await resizeWindowByPid(state.pid, w, h);
          } catch (e) {
            return {
              result: `resize_window 失败: ${String(e)}\n窗口可能未调整——自绘 UI 应用常不支持 AXSize 设置（如 -25200 system failure）。不要假设已缩放：先 ocr 复核当前布局再继续。`,
              state,
            };
          }
          return {
            result: `窗口已调整为 ${w}x${h}（pid 级）\n布局已变化：先 ocr 复核各元素当前位置再操作（旧坐标已失效）。`,
            state,
          };
        }
        const prev = await readAttribute(state.pid, win.path, "AXSize").catch(() => null);
        try {
          await resizeWindow(state.pid, win.path, w, h, {
            role: win.role,
            label: win.label,
          });
        } catch (e) {
          return {
            result: `resize_window 失败: ${String(e)}\n窗口可能未调整。先 ocr 复核当前布局再继续，不要假设已缩放。`,
            state,
          };
        }
        state = prev && prev.includes("w:")
          ? { ...state, undo: { kind: "set_size", pid: state.pid, path: win.path, prev, label: "窗口" } }
          : state;
        return {
          result: `窗口已调整为 ${w}x${h}\n布局已变化：先 ocr 复核各元素当前位置再操作（旧坐标已失效）。`,
          state,
        };
      }
      case "element_at": {
        let hit;
        try {
          hit = await elementAt(Number(args.x) || 0, Number(args.y) || 0);
        } catch (e) {
          const msg = String(e);
          if (msg.includes("-25208")) {
            const note = tui.elementAtNote();
            const persistent =
              note !== ""
                ? note
                : "这个应用请改用 ocr 读界面、click_at 操作，element_at/read_screen 对它不可用。";
            return {
              result: `element_at 在该位置失败（错误 -25208 = 应用不实现辅助功能 API，典型自绘 UI）。${persistent}`,
              state,
            };
          }
          throw e;
        }
        let pathLine = "";
        try {
          const traced = await tracePath(Number(args.x) || 0, Number(args.y) || 0);
          pathLine = ` 路径=[${traced.path.join(",")}]`;
        } catch {
          /* path is best-effort */
        }
        return {
          result: `${hit.role} 「${hit.title || hit.description || "无标题"}」 pid=${hit.pid}${pathLine}`,
          state,
        };
      }
      case "scroll": {
        const lines = Number(args.lines);
        if (!Number.isFinite(lines) || lines === 0) {
          return { result: "lines 必须是非零数字（正=向上，负=向下）", state };
        }
        let x = Number(args.x) || 0;
        let y = Number(args.y) || 0;
        // 坐标自动校正：滚动合成事件必须落在目标应用窗口内，否则事件会
        // 落到别的应用/桌面上。拿目标窗口 frame，把越界坐标夹回窗口内。
        const clamped = await clampToWindow(state.pid, x, y);
        x = clamped.x;
        y = clamped.y;
        // 来回滚动检测：同一坐标先向下再向上（或反之）是无效操作——内容
        // 回到原位，白白消耗步数。发现则拦下并提示换思路。
        const sign = lines > 0 ? 1 : -1;
        if (tui.scrollBounced(x, y, sign)) {
          return {
            result: `已在 (${x}, ${y}) 滚动 ${lines > 0 ? "向上" : "向下"} ${Math.abs(lines)} 行，但注意到你刚刚在同一位置向反方向滚过——来回滚动不会带来新内容。先 read_screen/ocr 看当前界面，确定要朝哪个方向翻页、翻到哪里，再一次性滚动到位。`,
            state,
          };
        }
        await scrollAt(x, y, lines, state.pid ?? undefined);
        const netease = uiKind(state.appName) === "netease";
        const qualifiedNote = netease ? nui.scrollAwayNote() : tui.scrollAwayNote();
        return {
          result: `已在 (${x}, ${y}) 滚动 ${lines > 0 ? "向上" : "向下"} ${Math.abs(lines)} 行。${clamped.note}列表坐标已随滚动失效：先 ocr 刷新当前屏（评分/片名/筛选栏的新位置），再用新坐标点击，不要沿用滚动前的坐标。${qualifiedNote}${tui.sortVerifyReminder()}`,
          state,
        };
      }
      case "scroll_to": {
        if (state.pid === null) return { result: "尚未选择应用", state };
        const target = findNodes(state.outline, str("keyword"))[0];
        if (!target) return { result: `没有找到「${str("keyword")}」，先 read_screen`, state };
        try {
          await scrollToVisible(state.pid, target.path);
        } catch {
          return {
            result: `应用不支持 AXScrollToVisible「${target.label}」。备选：用 scroll 在其坐标区域滚动，或直接 click（多数应用点击时会自动滚到目标）。`,
            state,
          };
        }
        return { result: `已把「${target.label}」滚动到可见区域`, state };
      }
      case "named_action": {
        if (state.pid === null) return { result: "尚未选择应用", state };
        const target = findNodes(state.outline, str("keyword"))[0];
        if (!target) return { result: `没有找到「${str("keyword")}」`, state };
        const action = str("action") || target.actions[0];
        if (!action) return { result: `元素「${target.label}」没有任何动作`, state };
        if (!target.actions.includes(action)) {
          return {
            result: `元素「${target.label}」不支持 ${action}。它支持的动作：${target.actions.join(", ")}`,
            state,
          };
        }
        await namedAction(state.pid, target.path, action);
        state = await refreshOutline(state);
        return { result: `已对「${target.label}」执行 ${action}。界面大纲已自动更新。`, state };
      }
      case "key": {
        const combo = str("combo");
        if (!combo) return { result: "缺少 combo 参数（如 enter / esc / Cmd+F）", state };
        await pressKey(combo, state.pid ?? undefined);
        state = await refreshOutline(state);
        return { result: `已按键 ${combo}（发给当前聚焦的元素）。界面如变化，大纲已自动更新。${tui.sortVerifyReminder()}`, state };
      }
      case "type_keys": {
        const text = str("text");
        if (!text) return { result: "缺少 text 参数", state };
        await typeKeys(text, state.pid ?? undefined);
        return {
          result: `已逐键输入 ${text.length} 个字符（发给当前聚焦的元素）。如需发送/提交，再按 key enter；如需看到下拉候选，用 find 搜索。`,
          state,
        };
      }
      case "click_at": {
        const raw = coordArgs(args);
        if (!raw) return { result: "需要数字坐标 x, y", state };
        const { x, y, note } = await clampToWindow(state.pid, raw.x, raw.y);
        const netease = uiKind(state.appName) === "netease";
        const guard = netease
          ? nui.clickGuard(Math.round(x), Math.round(y), "单击")
          : tui.clickGuard(Math.round(x), Math.round(y), "单击");
        if (guard.blocked) return { result: guard.blocked, state };
        // Pass the session pid so the guard can auto-refocus the target app
        // before firing (synthetic clicks land on whatever is frontmost).
        await clickAt(x, y, state.pid ?? undefined);
        if (netease) nui.noteSongClick(Math.round(x), Math.round(y));
        state = await refreshOutline(state);
        return { result: `已在 (${Math.round(x)}, ${Math.round(y)}) 合成单击（目标应用已确认在前台）。${note}${guard.note}${tui.sortVerifyReminder()}界面如变化，大纲已自动更新；自绘 UI 变化请用 ocr 复核。若同一位置点击两次后界面仍无变化，说明点击可能未被应用响应——停止重复点击，用 ocr 验证并换坐标/换方式推进。`, state };
      }
      case "double_click_at": {
        const raw = coordArgs(args);
        if (!raw) return { result: "需要数字坐标 x, y", state };
        const { x, y, note } = await clampToWindow(state.pid, raw.x, raw.y);
        const netease = uiKind(state.appName) === "netease";
        const guard = netease
          ? nui.clickGuard(Math.round(x), Math.round(y), "双击")
          : tui.clickGuard(Math.round(x), Math.round(y), "双击");
        if (guard.blocked) return { result: guard.blocked, state };
        await doubleClickAt(x, y, state.pid ?? undefined);
        if (netease) nui.noteSongClick(Math.round(x), Math.round(y));
        state = await refreshOutline(state);
        return { result: `已在 (${Math.round(x)}, ${Math.round(y)}) 合成双击（目标应用已确认在前台）。${note}${guard.note}${tui.sortVerifyReminder()}`, state };
      }
      case "drag": {
        const nums = ["from_x", "from_y", "to_x", "to_y"].map((k) => Number(args[k]));
        if (nums.some((n) => !Number.isFinite(n))) {
          return { result: "需要数字坐标 from_x, from_y, to_x, to_y", state };
        }
        const steps = Number(args.steps);
        const [fx0, fy0, tx0, ty0] = nums as [number, number, number, number];
        const from = await clampToWindow(state.pid, fx0, fy0);
        const to = await clampToWindow(state.pid, tx0, ty0);
        const note = [from.note, to.note].filter(Boolean).join(" ");
        await drag(from.x, from.y, to.x, to.y, Number.isFinite(steps) ? steps : undefined, state.pid ?? undefined);
        return {
          result: `已从 (${Math.round(from.x)}, ${Math.round(from.y)}) 拖拽到 (${Math.round(to.x)}, ${Math.round(to.y)})。${note}滑块/画布类结果用 read_screen 或 element_at 验证。`,
          state,
        };
      }
      case "menu_bar": {
        let pid = state.pid;
        const wanted = str("app");
        const keyword = str("keyword");
        if (wanted) {
          const apps = await listApps();
          const hit = apps.find((a) => a.name.toLowerCase().includes(wanted.toLowerCase()));
          if (!hit) return { result: `未找到运行中的应用「${wanted}」`, state };
          pid = hit.pid;
        } else if (pid === null) {
          return { result: "尚未选择应用且没有指定 app 参数（menu_bar 默认读前台应用，也可传 app 名）", state };
        }
        let bar = await menuBar(pid ?? undefined, 4);
        let note = "";
        if (keyword) {
          const filtered = filterMenu(bar, keyword);
          if (!filtered) {
            return { result: `菜单栏里没有包含「${keyword}」的项`, state };
          }
          bar = filtered;
          note = `（仅显示包含「${keyword}」的菜单项）`;
        }
        const lines = [
          `菜单栏（pid ${pid}）${note}：`,
          ...renderMenu(bar, "  "),
          "提示：跨级路径（如 [0,3,2,1]）可直接 menu_click；打开过一次的子菜单项 path 也是稳定的。",
        ];
        return { result: lines.join("\n"), state };
      }
      case "menu_click": {
        const raw = args.path;
        const path = Array.isArray(raw)
          ? raw.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0)
          : [];
        if (!path.length) return { result: "需要 menu_bar 返回的 path 数组", state };
        if (state.pid === null) return { result: "尚未选择应用", state };
        // Press each level in turn — parent menus must open before the
        // submenu item exists/is pressable.
        for (let i = 0; i < path.length; i += 1) {
          await performAction(state.pid, path.slice(0, i + 1), "AXPress");
        }
        state = await refreshOutline(state);
        return { result: `已按路径 [${path.join(",")}] 逐级点击菜单项。界面大纲已自动更新。`, state };
      }
      case "right_click_at": {
        const raw = coordArgs(args);
        if (!raw) return { result: "需要数字坐标 x, y", state };
        const { x, y } = raw;
        await rightClickAt(x, y, state.pid ?? undefined);
        state = await refreshOutline(state, 12);
        return {
          result: `已在 (${x}, ${y}) 合成右键（目标应用已确认在前台）。上下文菜单已弹出：用 read_screen 找菜单项并 click，或直接 element_at 定位菜单项坐标。`,
          state,
        };
      }
      case "done":
        return { result: str("summary") || "完成", state };
      // --- 本地桌面工具（tsm-hub 做不到的能力）---
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
        return { result: await desktopToolExec(name, args), state };
      // --- 本地 MCP 服务器（mcp.local.json，tsm-hub 未挂载的）---
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
        // duplicate the text in the transcript). The step bubble above already
        // shows the summary; no extra reply message needed.
        if (call.function.name === "done") {
          return {
            state: commit({ ...working, pending: null, llmHistory }),
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
      return cmdOpen(withUser, cmd.target);
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
