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
import type { AxAppInfo, AxNode, OcrScreenWord } from "./types";
import {
  MAX_PAIR_HINTS,
  MIN_CONFIDENCE,
  MINI_STRIP_Y,
  RATING_RE,
  buildPairs,
  detectPage,
  parseMiniTitle,
  sharesBigram,
  type PairCandidate,
} from "./tencent";
import type { MenuEntry } from "./api";
import { bringBack, focusSelf, hideAside } from "./windowctl";
import { invoke } from "@tauri-apps/api/core";

/** One chat message (assistant = command replies, user = typed input). */
export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
}

/** An outline node: what we keep so keywords can address real elements. */
interface OutlineNode {
  path: number[];
  role: string;
  label: string;
  value: string;
  actions: string[];
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
const STEP_RE = /^(🤖[^\n]*)\n+```\n?([\s\S]*?)```$/;
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

/** Flatten a dumped tree into outline nodes, remembering child-index paths. */
function flatten(root: AxNode): OutlineNode[] {
  const out: OutlineNode[] = [];
  const walk = (node: AxNode, path: number[]) => {
    const value = node.attributes.find((a) => a.name === "AXValue")?.value ?? "";
    out.push({
      path,
      role: node.role,
      label: node.label,
      value,
      actions: node.actions,
    });
    node.children.forEach((child, i) => walk(child, [...path, i]));
  };
  walk(root, []);
  return out;
}

/**
 * Compact human-readable outline for the model: interactive roles first,
 * StaticText heavily capped (WeChat-class apps have hundreds of text nodes).
 */
function renderOutline(nodes: OutlineNode[]): string {
  const interactive = nodes.filter((n) => ROLE_INTERACTIVE.has(n.role));
  const texts = nodes.filter((n) => n.role === "AXStaticText" && (n.label || n.value));
  const lines = interactive
    .slice(0, 45)
    .map((n) => outlineLine(n));
  // Only show static text that isn't already represented by a labelled
  // interactive element, and cap it hard.
  const seen = new Set(interactive.map((n) => `${n.label}\u0000${n.value}`));
  lines.push(
    ...texts
      .filter((n) => !seen.has(`${n.label}\u0000${n.value}`))
      .slice(0, 15)
      .map((n) => outlineLine(n)),
  );
  const dropped = interactive.length + texts.length - lines.length;
  if (dropped > 0) lines.push(`（其余 ${dropped} 个元素省略；用 find <关键词> 精确检索，或 read_screen filter= 只看某类）`);
  return lines.join("\n");
}

/** Roles the agent can actually act on or use for orientation. */
const ROLE_INTERACTIVE = new Set([
  "AXWindow",
  "AXButton",
  "AXTextField",
  "AXTextArea",
  "AXCheckBox",
  "AXRadioButton",
  "AXLink",
  "AXMenuButton",
  "AXPopUpButton",
  "AXSearchField",
  "AXSlider",
  "AXTabGroup",
  "AXList",
  "AXTable",
  "AXRow",
  "AXCell",
  "AXImage",
]);

/** One outline line (Markdown-safe: values/actions as inline code). */
function outlineLine(n: OutlineNode): string {
  const depth = n.path.length > 1 ? `（层级 ${n.path.length}）` : "";
  const value = n.value ? ` = \`${truncate(n.value, 40)}\`` : "";
  const actions = n.actions.length ? ` — \`${n.actions.join(",")}\`` : "";
  return `- ${n.role.replace("AX", "")}「${truncate(n.label, 36)}」${depth}${value}${actions}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Case-insensitive keyword match over label/role/value. */
function findNodes(outline: OutlineNode[], keyword: string): OutlineNode[] {
  const k = keyword.trim().toLowerCase();
  if (!k) return [];
  return outline.filter(
    (n) =>
      n.label.toLowerCase().includes(k) ||
      n.role.toLowerCase().includes(k) ||
      n.value.toLowerCase().includes(k),
  );
}

/** OR-match against several keywords (comma/space separated, e.g. read_screen
 *  filter "按钮 输入框" or "导出, 保存"). */
function findNodesAny(outline: OutlineNode[], keywords: string[]): OutlineNode[] {
  const ks = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (!ks.length) return [];
  return outline.filter((n) =>
    ks.some(
      (k) =>
        n.label.toLowerCase().includes(k) ||
        n.role.toLowerCase().includes(k) ||
        n.value.toLowerCase().includes(k),
    ),
  );
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

function asText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// LLM agent mode (🤖): the model plans, we execute tools, it reports back
// ---------------------------------------------------------------------------

import { agentTools, llmChatStream, llmConfigured, type LlmMessage } from "./llm";
import { desktopToolExec, mcpLocalCall } from "./api";

const SYSTEM_PROMPT = [
  "你是 macOS 计算机使用助手（AX Explorer）。你通过工具控制真实的应用界面。",
  "步数是稀缺资源（每段任务只有有限步），严格遵守：",
  "1. 不要反复 read_screen。open_app 成功后已返回完整界面大纲；之后每次 click/type_text 都会自动刷新大纲并在结果里注明。",
  "2. 定位元素优先用 find <关键词>（搜索当前大纲，不产生新界面读取）；只在确实需要看新界面时才 read_screen，且可用 filter 参数只看一类元素。",
  "3. 相互独立的小操作（如依次点击列表里的联系人）可以连续执行，不需要每步都重新读界面。",
  "4. 用关键词定位元素时，优先用按钮/字段的原文标题。",
  "5. 长列表（聊天记录、联系人、文件列表）看不到目标时用 scroll 在该区域滚动；已知元素在列表里但点不到时用 scroll_to；增减数值（音量/数量/日期步进）优先用 named_action 的 AXIncrement/AXDecrement 而不是反复点击。滚动/步进后不要立即整页重读，先 find 目标。",
  "6. 输入分两种：type_text 语义写入（整段替换 AXValue，无逐键反应）；type_keys 逐键合成键盘输入（触发随输入即搜索/自动补全/聊天输入框的反应），输入前先 focus 目标框，需要提交/发送时再 key enter。Esc 关弹窗、Cmd+F 开搜索、方向键在自定义列表导航——这些键盘驱动的界面没有 AX 动作，用 key。",
  "7. 合成鼠标是最后手段：click_at / double_click_at / drag / right_click_at 只用于既没有 AX 动作、element_at 也探测不到元素的自绘控件（画布、地图、拖动滑块），且目标应用必须在最前台。优先级永远是 menu_bar/menu_click > named_action > click（语义） > click_at（坐标）；坐标点击前先 element_at 确认那里确实没有 AX 元素。",
  "8. 菜单驱动的操作（导出、全屏、偏好设置、格式转换、置顶等）优先用 menu_bar + menu_click（语义操作，不占真实鼠标），比在界面上猜按钮更稳；右键菜单场景先 right_click_at 再 read_screen 点菜单项。",
  "9. 动手前先看一眼大纲；有变化且看不准时再读一次。",
  "10. 全部完成后用 done 工具向用户简短汇报（中文）；无法完成时也用 done 说明原因，不要编造界面元素。",
  "11. 系统消息里的「tsm-hub 技能库」列出了网关挂载的 Agent Skills（写文案/代码审查/周报等超出界面操作的能力）。需要时直接按该技能的说明执行；若某技能需要网关侧执行（skill-run），把需求交给网关处理即可，不要凭空调用不存在的工具。",
  "12. 本地工具分两类：clipboard_set/clipboard_get/notify/open_url/speak/screen_info/frontmost_app 是 macOS 桌面能力（决定窗口坐标前先 screen_info）；mcp_local_* 前缀的是本机 MCP 服务器工具，按其描述使用。",
  "13. 涉及发送消息、删除、支付等不可逆操作时必须先停下向用户确认。",
  "14. 不要重复已完成的操作：上一个工具的结果已显示目标达成（目标元素已出现、值已正确设置、窗口已移动、文本已输入）时，绝不要原样再执行一次。重复不推进任务，只会浪费步数。",
  "15. 完成的标准是「用户要求的结果已在界面上客观成立、可验证」。一旦成立就立刻调用 done 汇报并结束，不要画蛇添足（不要为凑步数继续 read_screen、继续点击）。不确定时才验证一次，通过就 done。",
  "16. 遇到自绘 UI（read_screen 一片匿名按钮/图像，像腾讯视频客户端）时改用 ocr 工具：对窗口截图做文字识别并返回屏幕坐标，然后用 click_at/type_keys 操作。自绘 UI 点击没有 AX 回执：每点一次坐标后必须再 ocr 一次确认界面变了（文字/布局变化）才能继续下一步；同一个坐标连点 2 次无变化就要停下换思路（换坐标、先滚动、或用键盘导航），不要盲目换坐标乱点。",
  "17. 视频类应用的「确认在播放」判定：OCR 顶栏/标题出现「播放中」字样、或画面出现暂停按钮/进度条/时间码等播放器控件，即为已播放的客观证据，立即用 done 汇报，不要再点击别处（每多点一次都可能把播放暂停或跳走）。发现已在播放后，后续动作全部取消。",
  "18. 选片必须两步验证：①列表页 OCR 看到「评分 N.N」只说明大概位置——评分徽标与海报可能错位、且低置信(30%)的乱码评分（如 $9:3）不可信，只认置信≥50% 的干净数字；②点开候选影片的详情页后必须再 ocr 一次，确认详情页上该片评分确实满足要求，才点「立即播放」。详情页评分不达标就返回换下一部。报告时以详情页看到的评分为准。点击影片时点片名文字的中心坐标（配对清单里有），不要点评分或海报边缘——会错开到旁边的影片。",
  "19. 帮用户挑选内容（电影/剧/音乐/商品）时，记忆要点：用户资料库里没有现成的「观影偏好」条目。正确姿势是 ①用 profile_search 检索画像锚点（职业经历、年龄、人格特征、工作强度），②基于画像推断口味，③与平台行为信号（「你正在追/继续观看」、历史、热搜常驻题材）交叉验证，④推荐时给出「基于你 XX 画像/习惯推断」的理由。已知画像锚点：（画像只来自 profile_search 的返回，此处不硬编码用户身份）",
].join("\n");

/** Keywords whose click/action targets are usually irreversible. */
const DANGER_WORDS = [
  "删除", "移除", "清空", "清除", "发送", "群发", "提交", "退出登录",
  "注销", "退出群聊", "移除成员", "冻结", "封禁", "卸载", "格式化",
  "永久删除", "清空聊天", "确认支付", "付款",
];

/** Recent scrolls (clamped x/y + direction), for bounce detection. */
const recentScrolls: { x: number; y: number; sign: number }[] = [];

/**
 * Recent executed tools, for the blind-click guard. Observation tools
 * (ocr/wait_for/…) and scrolls reset the "no-observation run": a legitimate
 * click → observe → click cadence never trips it, while click → click → click
 * with zero verification does (self-drawn UIs show nothing unless read).
 */
type RecentMove =
  | { kind: "observe" | "scroll" | "other" }
  | { kind: "click"; x: number; y: number };
const recentMoves: RecentMove[] = [];

/**
 * Consecutive element_at -25208 failures (self-drawn app). After two strikes
 * the app is confirmed to have no accessibility API — keep telling the model
 * to stop calling element_at/read_screen instead of burning steps. Reset on
 * open_app so switching to a real AX app clears the flag.
 */
let elementAtFails = 0;

/**
 * Title↔rating pairs from the most recent OCR on a list/channel page, with
 * the title's center coordinates. Filled by the ocr handler, consumed by
 * click_at: clicking the rating badge or poster edge lands on the
 * neighbouring film (the 8.7-instead-of-9.1 bug), so a click that misses
 * every paired title gets a corrective hint before it fires.
 */
let lastListPairs: PairCandidate[] = [];

/**
 * List-page OCRs in a row without a high-confidence rating digit. The model
 * tends to keep scrolling a 「最热/最新」-sorted list looking for rating
 * badges that the sort simply does not show; after two scrolls the listHint
 * escalates from "scroll more" to "switch to 高分好评 or open a detail".
 */
let scrollsSinceRating = 0;

/** Whether the most recent OCR was a list/channel page (has a back marker,
 * no rating digits). Gates the sort-tab click hint so the home page top
 * area does not get flagged as a filter bar. */
let lastOcrList = false;
/** Whether the most recent ocr saw a detail page (简介/选集/播放列表).
 *  List-page clicks near a rating candidate are intercepted (a Tencent card
 *  click PLAYS the film directly, and clicking near the badge opens the
 *  neighbouring poster — 14:05 session: opened sub-9 坚如磐石); detail-page
 *  clicks (选集/立即播放) must stay free. */
let lastOcrDetail = false;
/** Whether the most recent ocr showed a playing player (播放中/time codes).
 *  Home-page clicks near nothing rated are soft-flagged, but player-page
 *  clicks (pause/controls) must stay free. */
let lastOcrPlayer = false;

/**
 * Set when a click lands in the top filter/sort band of a rating-less
 * list: sort switches can be slow or fail silently, and the model tends
 * to scroll or click again right after tapping 高分好评 without verifying
 * (13:35 session: clicked the sort tab, then scrolled/clicked twice more
 * while the list was still on 最热). The next non-ocr action gets a
 * reminder to verify with an ocr first; the flag is consumed by the
 * reminder and cleared by any ocr.
 */
let pendingSortVerify = false;

/**
 * Titles the user has already watched — observed from the top mini-player
 * (the app auto-resumes a previously closed video, e.g. 「播放中 扒特务」
 * = 抓特务) and from the 你正在追 history page. Recommending a film the
 * user has finished defeats the task ("没有排除我已经完整看过的吧"),
 * so paired candidates that overlap a seen title are suppressed. Kept
 * across open_app: watched films stay watched.
 */
const SEEN_KEY = "axExplorer.seenTitles.v1";
function loadSeenTitles(): string[] {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string" && s.length >= 2) : [];
  } catch {
    return [];
  }
}
/** Persist across sessions: the user's watched films stay watched even
 * after the app restarts (TaUI webview keeps localStorage). */
function rememberSeen(title: string) {
  if (!seenTitles.includes(title)) {
    seenTitles.push(title);
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(seenTitles));
    } catch {
      /* storage full / unavailable — in-memory is still fine */
    }
  }
}
let seenTitles: string[] = loadSeenTitles();
// Quality-note gating: loading/animation frames flash low-confidence words
// on EVERY OCR, so the note would spam itself. Only after TWO consecutive
// low-quality reads, and at most once per 3 OCRs.
let qualityStreak = 0;
let ocrSinceQualityNote = 0;

/**
 * Film the model itself just opened and the mini-player is now playing
 * (matched against the rating candidates in the same OCR). Clicking a
 * Tencent card starts playback directly, so a second click on the same
 * title re-plays it (13:55 session: 捕风追影 played twice). Updated by
 * every ocr; non-empty means "do not click this film again".
 */
let miniPlayingTitle = "";
let lastOcrChannelHome = false;
// Detail-page verified ratings (title → score): the only trustworthy
// rating source. Overrides unreliable list badges when pairing (16:51
// session: badges paired as 9.0/9.8/9.1 while the films are ~8.3).
let detailVerifiedScores = new Map<string, string>();

/** True when a and b share a ≥2-char run (「抓特务」vs OCR 残字「扒特务」
 * share 「特务」). Used to match film titles across OCR noise. */
/** One-shot reminder consumed by the next non-ocr action (scroll/click/
 * key): "you just tapped a sort tab, verify it took effect before acting
 * again". Returns "" when nothing is pending. */
function sortVerifyReminder(): string {
  if (!pendingSortVerify) return "";
  pendingSortVerify = false;
  return "\n（⚠️ 你刚点击了排序/筛选标签但还没用 ocr 验证切换是否生效——先 ocr 看顶部排序字样（最热/高分好评）与列表内容是否已变化再继续，不要盲目点击/滚动）";
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

/** Why a tool call needs user confirmation, or "" if it's safe. */
function dangerousReason(name: string, args: Record<string, unknown>): string {  switch (name) {
    case "key": {
      const combo = String(args.combo ?? "").toLowerCase();
      if (/(enter|return)/.test(combo)) {
        return "回车键可能触发发送/提交/删除等不可逆动作，需要你确认。";
      }
      return "";
    }
    case "click":
    case "named_action":
    case "menu_click": {
      const keyword = String(args.keyword ?? args.action ?? "").toLowerCase();
      if (DANGER_WORDS.some((w) => keyword.toLowerCase().includes(w))) {
        return `操作目标疑似不可逆动作（「${keyword}」），需要你确认。`;
      }
      // Native window chrome (traffic-light) buttons: pressing 关闭/最小化
      // closes/minimizes the WHOLE app window — usually not what an agent
      // wants when hunting for an in-app control. Confirm first.
      if (/(关闭按钮|最小化按钮)/.test(keyword)) {
        return `「${keyword}」是系统窗口按钮，会关闭/最小化整个应用窗口，需要你确认是否真的这么做。`;
      }
      return "";
    }
    default:
      return "";
  }
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
        elementAtFails = 0; // new target app → re-arm element_at probes
        lastListPairs = []; // stale rating pairs from the previous app
        scrollsSinceRating = 0;
        lastOcrList = false;
        lastOcrDetail = false;
        lastOcrPlayer = false;
        pendingSortVerify = false;
        miniPlayingTitle = "";
        lastOcrChannelHome = false;
        detailVerifiedScores = new Map<string, string>();
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
        const NAV_WORDS = [
          "首页", "电影", "电视剧", "综艺", "动漫", "少儿", "你正在追",
          "VIP会员", "片库", "NBA", "短剧", "小游戏", "纪录片", "体育",
        ];
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
              const navWarn =
                !gone && NAV_WORDS.some((w) => ocrText.includes(w))
                  ? `\n注意：「${ocrText}」是导航栏常驻词，出现不代表页面已切换——请用 ocr 确认目标页特征（频道页的筛选栏/返回键、影片名）后再继续。`
                  : "";
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
        const lowConfWords = lastWords.filter((w) => w.confidence < 0.5).length;
        const garbledHint =
          lastWords.length > 3 &&
          (lowConfWords / lastWords.length > 0.5 || lowConfWords >= 10)
            ? `\n⚠️ 当前 OCR 质量差（大量乱码词），页面可能在加载/动画中，或窗口被遮挡/未在前台。` +
              "建议：wait_for 1-2s 后重扫；若持续乱码，尝试 move_window maximize 或确认目标应用在前台。"
            : "";
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
        // An ocr is exactly the verification a sort-tab click needs; any
        // pending "verify the sort" reminder is satisfied here.
        pendingSortVerify = false;
        const joined = words
          .sort((a, b) => a.y - b.y || a.x - b.x)
          .slice(0, 60)
          .map(
            (w) =>
              `「${w.text}」${w.w > 0 ? ` (${Math.round(w.w)}×${Math.round(w.h)})` : ""} @(${Math.round(w.x)}, ${Math.round(w.y)})` +
              (w.confidence < 0.5 ? ` 置信${(w.confidence * 100).toFixed(0)}%` : ""),
          )
          .join("\n");
        // Pair each high-confidence rating with the title text of the same
        // poster (nearest plausible Chinese text), so the model clicks the
        // TITLE's coordinates — clicking near the rating badge lands on the
        // neighbouring poster (the 8.7-film-instead-of-9.1 bug).
        const rating = words.find(
          (w) => RATING_RE.test(w.text) && w.confidence >= MIN_CONFIDENCE,
        );
        // Page classification lives in src/tencent.ts (pure, regression-
        // tested) — see detectPage for the per-session rule provenance.
        const flags = detectPage(joined);
        const { watchedPage, detailPage, channelHome, homeLike, playing, listPage } = flags;
        lastOcrDetail = detailPage;
        lastOcrPlayer = playing;
        lastOcrChannelHome = channelHome;
        lastOcrList = listPage;
        let pairs: string[] = [];
        // A detail page is the one trustworthy rating source: capture the
        // verified (title → score) so list badges can be overridden when
        // the model returns to the list (16:51: badges lied).
        if (detailPage && rating) {
          const dt = words.find((w) => /简介[＞>〉]/.test(w.text));
          if (dt) {
            const name = parseMiniTitle(dt.text.replace(/[^，。\s]*简介[＞>〉].*$/, ""));
            if (name.length >= 2) {
              detailVerifiedScores.set(name, rating.text.replace("分", ""));
            }
          }
        }
        lastListPairs =
          rating && !watchedPage && !homeLike
            ? buildPairs(words, { seenTitles, detailPage, verifiedScores: detailVerifiedScores })
            : [];
        for (const p of lastListPairs) {
          pairs.push(
            `「${p.title}」评分 ${p.score} 分${p.verified ? "（详情页已复核）" : ""} → 点片名坐标 (${p.x}, ${p.y})`,
          );
        }
        pairs = [...new Set(pairs)].slice(0, MAX_PAIR_HINTS);
        // Tell the model why a rated card may be missing from the pairs —
        // it is a watched film, not an OCR miss.
        const seenOnScreen = seenTitles.filter((s) =>
          words.some((w) => w.text.length >= 2 && sharesBigram(w.text, s)),
        );
        const seenHint = seenOnScreen.length
          ? `\n（已从候选配对中排除你看过的片：${[...new Set(seenOnScreen)].join("、")}——它们不会作为推荐候选；列表里它们的评分/海报可以忽略）`
          : "";
        // Playback evidence must be scoped. 「播放中」appears in two very
        // different places:
        //  1) a player page — real task evidence → done;
        //  2) the top banner strip on the home/channel page. Closing the
        //     「继续播放」toast makes Tencent Video auto-resume one of the
        //     previously closed videos, so the banner shows 「播放中 第N集」
        //     even though the model clicked nothing. Treating that as task
        //     evidence would finish on the wrong video.
        const playerEvidence = /简介|评分|播放第|选集|倍速|杜比|语言|\d{1,2}:\d{2}/.test(joined);
        // Try to name the banner: the title word on the same row, within a
        // moderate distance right/left of the 播放中 marker.
        const pw = playing ? words.find((w) => /播放中|正在播放|播放[片日F！]|放中/.test(w.text)) : undefined;
        let playingTitle = "";
        if (pw) {
          const near = words
            .filter(
              (w) =>
                w !== pw &&
                Math.abs(w.y - pw.y) <= 24 &&
                Math.abs(w.x + w.w / 2 - (pw.x + pw.w / 2)) <= 420 &&
                w.text.length >= 2 &&
                !/播放中|正在播放|第\d+[集话]|^\d+$/.test(w.text),
            )
            .sort(
              (a, b) =>
                Math.abs(a.x + a.w / 2 - (pw.x + pw.w / 2)) -
                Math.abs(b.x + b.w / 2 - (pw.x + pw.w / 2)),
            )[0];
          if (near) playingTitle = `「${near.text}」`;
        }
        // Quality hint: many low-confidence / garbled words usually mean the
        // page is mid-transition (loading, animation, overlay) — telling the
        // model to re-scan after a beat instead of trusting the noise.
        // Gated: two CONSECUTIVE low-quality reads, then at most once per 3
        // OCRs — a loading frame alone would otherwise spam every read.
        const lowConf = words.filter((w) => w.confidence < MIN_CONFIDENCE).length;
        const lowConfRatio = words.length > 3 && (lowConf / words.length > 0.5 || lowConf >= 10);
        ocrSinceQualityNote += 1;
        let qualityNote = "";
        if (lowConfRatio) {
          qualityStreak += 1;
          if (qualityStreak >= 2 && ocrSinceQualityNote >= 3) {
            qualityNote = "\n⚠️ 识别质量差（大量低置信/乱码词）：页面可能在加载、有动画或遮罩层。建议 wait_for 1-2s 后再 ocr，或滚动到稳定画面；若连续多次乱码，检查窗口是否被遮挡/未最大化（move_window maximize）或目标应用是否在前台。";
            ocrSinceQualityNote = 0;
          }
        } else {
          qualityStreak = 0;
        }
        // Detail-page play guidance: self-drawn players (Tencent Video etc.)
        // render the play control as an unlabeled image button the OCR can't
        // name — tell the model where to look / how to fall back to keyboard.
        // 「立即播放」is NOT a detail marker: the resume toast on the home
        // page shows it too, which would mis-fire this hint. Gate the
        // coordinate on detail-like content; OCR renders detail ratings as
        // 「9.0分」, not the literal 「评分」.
        const detailLike = /简介|评分|播放第|第\d+集|\d\.\d分/.test(joined);
        const playBtn = detailLike ? words.find((w) => /立即播放/.test(w.text)) : undefined;
        const inDetail = !playing && detailLike;
        const playHint = playBtn
          ? `\n（详情页「立即播放」按钮在 (${Math.round(playBtn.x + playBtn.w / 2)}, ${Math.round(playBtn.y + playBtn.h / 2)})：评分达标就点它开始播放，随后 ocr 确认播放器控件（选集/倍速/进度条/时间码）出现再 done）`
          : inDetail
            ? "\n（详情页播放按钮多为无文字的绿色大按钮，位于片名/简介行的下方或右侧；OCR 识别不到按钮文字时，可先按空格键尝试播放，或对按钮区域再 ocr 一次）"
            : "";
        // Resume-dialog hint: Tencent Video opens a "继续播放之前关闭的 N 个视频"
        // toast over the home page. Clicking home cards underneath (stale
        // resume items) either starts playing something the user had closed or
        // does nothing — close the toast first at the OCR coordinates.
        const resume = /继续播放之前关闭的\s*\d+\s*个视频/.test(joined);
        const dialogHint = resume
          ? "\n（检测到「继续播放」弹窗：先点击 OCR 中「关闭」或「立即播放」的坐标处理掉它，再操作首页其他内容——直接点首页卡片可能误播你之前关闭的视频。注意：点「关闭」后顶部若出现「播放中」小窗，那是应用自动恢复播放之前关闭的视频，不是你的点击所致，与任务无关可忽略或按空格暂停）"
          : "";
        // 「你正在追」history page guard: clicking a card resume-plays it
        // (no detail page, no rating re-check) and its scores are for films
        // the user already watched — not the high-score candidate pool.
        const watchedHint = watchedPage
          ? "\n（检测到「你正在追/历史观看」页（观看至N%/已看完标签）：这些是你追过的剧，评分不代表高分新片池，点击卡片会【直接续播】而不会打开详情页。任务要挑高分电影：回到「电影」频道列表页并切「高分好评」排序（或点开候选片详情页复核），不要在本页点卡片播放）"
          : "";
        // Detail-page rating guard: a detail page carries 简介/选集/播放列表
        // markers that never appear on list/home pages. If its rating is
        // below the 9.0 bar, say so loudly — the agent otherwise keeps
        // fiddling with a film it must not play (13:22 session: opened the
        // wrong 8.1 detail after a stale-coordinate click and never noticed).
        const ratingNum = rating ? parseFloat(rating.text) : NaN;
        const ratingGuard =
          detailPage && rating && !Number.isNaN(ratingNum) && ratingNum < 9
            ? `\n（当前详情页评分 ${rating.text.replace("分", "")} 分 < 9，【不达标】：不要点播放/立即播放。按 esc 返回列表（返回后 ocr 确认回到列表），重新挑选评分 ≥9 的候选片；本页的推荐/选集/播放列表都是这个低分片的周边内容，不要继续操作）`
            : "";
        // A detail page for a film the user already watched (mini-player
        // resume / 你正在追): even at 9+, it is not a valid recommendation.
        const seenOnDetail = detailPage
          ? seenTitles.find((s) => words.some((w) => w.text.length >= 2 && sharesBigram(w.text, s)))
          : undefined;
        const seenDetailHint = seenOnDetail
          ? `\n（⚠️ 当前详情页这部片（${seenOnDetail}）是你之前看过的：不要把它作为任务推荐片。即使评分 ≥9 也不要点播放——按 esc 返回列表，换一部没看过的片）`
          : "";
        // Channel home / list hero cards also show rating + 立即播放, but
        // they are NOT a detail page and the hero card auto-rotates — the
        // button belongs to whichever card is shown at click time (13:28
        // session: clicked 出入平安 9.3's button, the card rotated and a
        // different film opened). Warn neutrally when a rated 立即播放 has
        // no detail-page markers around it.
        const heroCard =
          playBtn !== undefined && !detailPage && /\d\.\d分/.test(joined);
        const heroHint = heroCard
          ? "\n（注意：带评分的「立即播放」旁没有详情页特征（简介/选集/播放列表）——当前是频道首页/列表大卡片而非详情页。首页大卡片会自动轮播，点「立即播放」前先确认当前展示卡片的片名与评分确实对应，评分达标再点，否则可能打开轮播到的别的片）"
          : "";
        // 「播放中」position decides what it means. In the top strip
        // (y<140, Tencent's mini-player / resume banner) it is the app
        // auto-resuming a previously closed video — NOT evidence the task
        // film is playing, even when a rated detail page is on screen.
        // Only a 播放中 marker in the page body counts as playback proof.
        // The strip's state word OCRs as noise (播放片/播放F/播放日/放中),
        // so any 第N话/集 marker at y<140 flags the mini-player too, even
        // without a readable 「播放中」.
        const topEpi = words.find((w) => w.y < MINI_STRIP_Y && /第\d+[话集]/.test(w.text));
        // The strip's play glyph OCRs as II/I1/口 followed by the film title
        // with no readable state word at all (13:28 session: 「II •E让眼泪
        // 变珍王」= a resumed 心动的信号). Any such marker at y<140 is the
        // mini-player, even without 播放中 or 第N话.
        const topPlayer = words.find(
          (w) => w.y < MINI_STRIP_Y && /^(II|I1|口)[^，。]{2,}/.test(w.text),
        );
        const miniPlayer =
          topEpi !== undefined || topPlayer !== undefined || (pw !== undefined && pw.y < MINI_STRIP_Y);
        // The resumed mini-player is a film the user recently watched — keep
        // its title so the pairing / detail guards never offer it again
        // (13:47 session: 「II 口播放中 扒特务」= 抓特务, yet the model kept
        // trying to open it from the list).
        const miniWord = topPlayer ?? pw ?? topEpi;
        // The mini-player is either the app auto-resuming a previously
        // closed video (a film the user already watched) OR the task film
        // the model just opened — clicking a Tencent card directly starts
        // playback (13:55 session: tapping 捕风追影 played it, yet the
        // model thought nothing had started and clicked it again, playing
        // it a second time). Decide by matching the strip's title against
        // the current rating candidates: a match means the task film is
        // already playing (playback evidence, NOT a watched film); no
        // match means an auto-resumed old film (watched, exclude it).
        let miniSeenTitle = "";
        let miniPlaying = "";
        if (miniWord) {
          const raw = parseMiniTitle(miniWord.text);
          if (raw.length >= 2) {
            const isTaskFilm = lastListPairs.some((p) => sharesBigram(p.title, raw));
            if (isTaskFilm) {
              // The strip is playing a candidate the model just clicked:
              // that IS the task playback. Remember it so repeat clicks on
              // the same film are blocked.
              miniPlaying = raw;
              miniPlayingTitle = raw;
              rememberSeen(raw);
            } else {
              miniSeenTitle = raw;
              miniPlayingTitle = "";
              rememberSeen(raw);
            }
          } else {
            miniPlayingTitle = "";
          }
        }
        const miniHint = miniPlaying
          ? `\n（顶部小窗正在播放「${miniPlaying}」——这就是你刚点开的候选片，任务播放【已开始】：按规则确认播放器控件（选集/倍速/进度条/时间码）出现后 done 汇报，【不要再点击它】——重复点击卡片会把它重新播放一遍（13:55 会话把同一部片播放了两遍）。注意：它的评分来自列表徽标配对，【未经详情页复核】——如果用户指出分数不对（如实际只有 8.x），说明配对评分错了（评分徽标错配到相邻卡片），此片不达标：不要 done，按 esc 返回列表重新 ocr 挑片）`
          : `\n（顶部出现「播放中」小窗${playingTitle}：这是应用自动恢复之前视频的迷你播放器，【不是】本次任务播放成功的证据——即使屏幕上有评分/简介的详情页也一样。继续任务：详情页评分达标后点「立即播放」（ocr 有坐标），确认播放器控件（选集/倍速/进度条/时间码）出现才算完成${miniSeenTitle ? `。另外：小窗里这部（${miniSeenTitle}）是你之前看过的片，任务推荐应排除它——不要在列表里再找它/点它` : ""}）`;
        const playingHint = miniPlayer
          ? miniHint
          : playing
            ? playerEvidence
              ? `\n（检测到「播放中」标记：${playingTitle}视频已在播放页播放，按规则立即 done 汇报，不要再点击）`
              : `\n（检测到「播放中」标记${playingTitle}但缺少播放器证据：先确认是否真在播放（时间码/选集/倍速控件），若只是页面残留标记则继续任务）`
            : "";
        // List/channel page without any rating digits: the model tends to
        // re-click filter tabs (already selected) instead of scrolling to
        // read the per-card ratings. Guide it to scroll / open a detail.
        // Recognize the current sort from the channel header, e.g.
        // 「电影 •最热 •院线电影」/「电影•高分好评•全部电影」. The model
        // keeps scrolling a 最热 list hunting for badges the sort does not
        // show, unaware which sort it is on (13:35 session kept scrolling
        // while the header still said 最热 after tapping 高分好评).
        const sortLabel =
          joined.match(/电影\s*[•·]\s*(最热|最新|高分好评)/)?.[1] ??
          joined.match(/(最热|最新|高分好评)\s*[•·]\s*(院线电影|全部电影|电影)/)?.[1] ??
          null;
        // Track consecutive rating-less list OCRs so the hint can escalate
        // from "scroll another screen" to "switch sort / open a detail".
        if (rating) {
          scrollsSinceRating = 0;
        } else if (listPage) {
          scrollsSinceRating += 1;
        }
        const listHint = listPage
          ? sortLabel === "高分好评"
            ? "\n（当前已切到「高分好评」排序：卡片按评分排列，直接读本屏各卡片评分挑 ≥9 的候选；若本屏评分都 <9 再滚动换屏，不要再切回其他排序）"
            : sortLabel === "最热" || sortLabel === "最新"
              ? `\n（当前是「${sortLabel}」排序（如「电影•最热•院线电影」）：该排序下评分参差，部分卡片不显示评分徽标，继续滚动也读不到分。任务要求 ≥9 的高分片：点顶部「高分好评」标签切换（ocr 中有其坐标），或点开候选片详情页用详情页评分筛选；不要在同一列表里反复滚动）`
              : scrollsSinceRating >= 2
                ? `\n（已连续 ${scrollsSinceRating} 次列表页未见评分数字：当前多半是「最热/最新」排序，卡片不显示评分徽标，继续滚动也读不到分。改切「高分好评」排序（ocr 顶部筛选栏该标签坐标），或直接点开候选片详情页用详情页评分筛选；不要继续在同一列表里盲目滚动）`
                : "\n（当前在列表/频道页且本屏未见评分数字：评分通常显示在卡片下方（如 9.8）。滚动逐屏读取评分挑选高分片；评分不在本屏就再滚一屏，或点开卡片详情页复核。列表出现后不要再反复点击筛选标签，直接滚动读评分）"
          : "";
        // Home/navigation page with no list/detail/player markers. The model
        // tends to click whatever card catches its eye (你正在追 / hot-list
        // / recommendations), and Tencent cards PLAY directly on click —
        // that is how the 16:33 session opened 心动的信号9 before ever
        // entering the film channel, and how the 16:43 session (after the
        // window move reset Tencent to home) scrolled the rated home feed
        // hunting for 马腾你别走 9.7. Steer it to the 电影 channel instead.
        const homeHint = homeLike
          ? "\n（当前是首页/导航页——【不是电影频道列表】：即使本屏带评分卡（如 9.7 推荐位），首页卡片点卡会【直接播放】无关内容，评分也不代表频道候选池；窗口移动/最大化会让腾讯视频重置回首页。请点左侧导航「电影」（x≈200, y≈370）重新进入频道列表，在频道页滚动读取各片评分挑 ≥9 候选，再点片名坐标进详情页复核——不要在首页点卡片/滚动找片）"
          : "";
        return {
          result:
            `${name} 画面文字识别（坐标=屏幕点，可直接 click_at/type_keys）：\n${joined}` +
            (pairs.length ? `\n\n【评分-片名配对】（点片名坐标打开详情，不会错位）：\n${pairs.join("\n")}` : "") +
            playingHint +
            playHint +
            dialogHint +
            watchedHint +
            ratingGuard +
            seenDetailHint +
            heroHint +
            listHint +
            homeHint +
            seenHint +
            qualityNote,
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
        try {
          state = { ...state, outline: await treeOf(state.pid, 10) };
        } catch {
          /* keep old outline */
        }
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
          // 语义摆放：主屏边界 + 窗口当前尺寸换算坐标。
          let parsed: Array<{
            index: number;
            origin: [number, number];
            size: [number, number];
          }> = [];
          try {
            parsed = JSON.parse(await desktopToolExec("screen_info", {}));
          } catch {
            /* 屏幕信息解析失败则报错 */
          }
          if (!parsed.length) {
            return { result: `无法读取屏幕信息来换算 position=${position}，请改用 x/y`, state };
          }
          const want = Number(args.screen);
          screenIdx = Number.isInteger(want) ? want : 0;
          const main = parsed[screenIdx] ?? parsed[0];
          const sb = await windowBounds(state.pid).catch(() => null);
          const ww = sb ? sb.w : 0;
          const wh = sb ? sb.h : 0;
          if (position === "left") {
            x = main.origin[0];
            y = main.origin[1];
          } else if (position === "right") {
            x = main.origin[0] + main.size[0] - ww;
            y = main.origin[1];
          } else if (position === "center") {
            x = main.origin[0] + (main.size[0] - ww) / 2;
            y = main.origin[1] + (main.size[1] - wh) / 2;
          } else if (position === "maximize") {
            x = main.origin[0];
            y = main.origin[1];
            resize = { w: main.size[0], h: main.size[1] };
          } else {
            return {
              result: `未知 position: ${position}（支持 left/right/center/maximize）`,
              state,
            };
          }
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
            elementAtFails += 1;
            const persistent =
              elementAtFails >= 2
                ? `（已连续失败 ${elementAtFails} 次：该应用确认不支持 element_at/read_screen，请不要再调用它们，只用 ocr 读屏 + click_at 操作推进）`
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
        const bounced = recentScrolls.some(
          (s) => Math.abs(s.x - x) < 4 && Math.abs(s.y - y) < 4 && s.sign === -sign,
        );
        recentScrolls.push({ x, y, sign });
        if (recentScrolls.length > 4) recentScrolls.shift();
        if (bounced) {
          return {
            result: `已在 (${x}, ${y}) 滚动 ${lines > 0 ? "向上" : "向下"} ${Math.abs(lines)} 行，但注意到你刚刚在同一位置向反方向滚过——来回滚动不会带来新内容。先 read_screen/ocr 看当前界面，确定要朝哪个方向翻页、翻到哪里，再一次性滚动到位。`,
            state,
          };
        }
        await scrollAt(x, y, lines, state.pid ?? undefined);
        // The model scrolls away while a qualifying candidate (rating ≥ 9)
        // from the last OCR was right on screen (13:35 session: 小气鬼 9.1
        // paired at step 20, then two more scrolls). After the scroll its
        // coordinates are gone — remind it what it just left behind.
        const qualified = lastListPairs
          .filter((p) => {
            const n = parseFloat(p.score.replace("分", ""));
            return !Number.isNaN(n) && n >= 9;
          })
          .slice(0, 2);
        // 滚动后屏幕内容已移动：任何来自上次 ocr 的评分-片名配对坐标都已
        // 失效。不清空的话 click_at 会用旧坐标提示「将打开 X」而实际点到
        // 滚动后的别的卡片（13:22 会话：滚动后未 ocr 即点狄仁杰坐标，
        // 结果打开的是 8.1 分的定海神针详情页）。
        lastListPairs = [];
        const qualifiedNote = qualified.length
          ? `\n⚠️ 注意：滚动前本屏上次 ocr 已有达标候选——${qualified.map((p) => `「${p.title}」评分 ${p.score}（片名坐标 ${p.x},${p.y}）`).join("、")}。如果还没点它，滚动后坐标已失效：先滚回上一屏重新 ocr 定位再点，不要继续滚向更远；评分 <9 不达标才值得继续找。`
          : "";
        return {
          result: `已在 (${x}, ${y}) 滚动 ${lines > 0 ? "向上" : "向下"} ${Math.abs(lines)} 行。${clamped.note}列表坐标已随滚动失效：先 ocr 刷新当前屏（评分/片名/筛选栏的新位置），再用新坐标点击，不要沿用滚动前的坐标。${qualifiedNote}${sortVerifyReminder()}`,
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
        try {
          state = { ...state, outline: await treeOf(state.pid, 10) };
        } catch {
          /* keep old outline */
        }
        return { result: `已对「${target.label}」执行 ${action}。界面大纲已自动更新。`, state };
      }
      case "key": {
        const combo = str("combo");
        if (!combo) return { result: "缺少 combo 参数（如 enter / esc / Cmd+F）", state };
        await pressKey(combo, state.pid ?? undefined);
        try {
          if (state.pid !== null) state = { ...state, outline: await treeOf(state.pid, 10) };
        } catch {
          /* keep old outline */
        }
        return { result: `已按键 ${combo}（发给当前聚焦的元素）。界面如变化，大纲已自动更新。${sortVerifyReminder()}`, state };
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
        const rawX = Number(args.x);
        const rawY = Number(args.y);
        if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
          return { result: "需要数字坐标 x, y", state };
        }
        const { x, y, note } = await clampToWindow(state.pid, rawX, rawY);
        // Rating-task guard: when the last OCR carried title↔rating pairs,
        // a click that misses every paired title is likely aimed at a rating
        // badge or poster edge — which opens the neighbouring film (the
        // 8.7-instead-of-9.1 bug). Hint at the closest candidate instead of
        // clicking blindly. Far-away clicks (nav rail, top bar) are left alone.
        let pairNote = "";
        if (lastListPairs.length) {
          const px = Math.round(x);
          const py = Math.round(y);
          const onTitle = lastListPairs.find(
            (p) => Math.abs(px - p.x) <= 60 && Math.abs(py - p.y) <= 40,
          );
          const nearest = lastListPairs
            .map((p) => ({ p, d: Math.hypot(px - p.x, py - p.y) }))
            .sort((a, b) => a.d - b.d)[0];
          // 该片已在顶部小窗播放中（刚点开的任务片）：再点会重新播放一遍，拦截。
          if (onTitle && miniPlayingTitle && sharesBigram(onTitle.title, miniPlayingTitle)) {
            pairNote = `\n（⚠️ 「${onTitle.title}」（评分 ${onTitle.score}）已在顶部小窗播放中——就是刚点开的那部，任务播放已开始。不要再点它/点它的卡片（会重新播放一遍）：按规则 ocr 确认播放器控件（选集/倍速/进度条/时间码）出现后 done 汇报）`;
          } else if (onTitle) {
            pairNote = `\n（将打开「${onTitle.title}」（评分 ${onTitle.score}）：进详情页后先 ocr 复核评分达标再点播放）`;
          } else if (nearest && nearest.d < 180 && !lastOcrDetail && py > 280) {
            // List page, click missed every paired title: a Tencent card
            // click PLAYS the film directly, so the nearby poster (rating
            // badge edge / actor row) would open a wrong or sub-9 film
            // (14:05 session: 坚如磐石 was played this way). Refuse to fire.
            return { result: `⛔ 点击 (${px}, ${py}) 被守卫拦截：它没落在任何评分候选的片名上（最近候选「${nearest.p.title}」评分 ${nearest.p.score} @(${nearest.p.x}, ${nearest.p.y})）。腾讯视频点卡片会直接开始播放，评分徽标/海报边缘/演员行会打开错误的片。先 ocr 刷新列表，确认目标片的片名与评分都在配对清单里，再点它的片名坐标；要切排序/筛选请点顶部标签（y≤280）。`, state };
          } else if (nearest && nearest.d < 180) {
            pairNote = `\n⚠️ 点击位置 (${px}, ${py}) 不在配对清单的任何片名上——评分徽标/海报边缘会错开到旁边影片。最近候选：「${nearest.p.title}」评分 ${nearest.p.score} 分，片名坐标 (${nearest.p.x}, ${nearest.p.y})。建议改点片名坐标。`;
          }
        } else if (lastOcrList && Math.round(y) <= 280 && Math.round(x) >= 330) {
          // No rating pairs on screen (rating-less list): a click in the
          // top filter/sort band is probably a sort tab (the back button
          // sits at x≈320, so the band starts at 330). Sorting switches
          // (最热/高分好评/类型) can be slow or fail silently — verify.
          pendingSortVerify = true;
          pairNote =
            "\n（若点的是排序/筛选标签（最热/高分好评/类型等）：点击后用 ocr 确认顶部排序字样与列表内容已变化，切换/加载可能要 1-2s，必要时 wait_for；点击后 ocr 无变化说明没点中或该项已选中，不要原地重复点击）";
        } else if (lastOcrChannelHome && !lastOcrDetail && !lastOcrPlayer) {
          // Channel home (rated feed, e.g. 电影热播榜第1名 + 9.3 badge):
          // NOT the nav home — ratings here are real and pair-able, but a
          // card click plays directly / jumps to the list, so the model
          // should not play from this screen without a detail check
          // (17:07 session: it was told "home, no candidates" while a 9.3
          // was on screen and flailed on the sort tabs).
          pairNote =
            "\n⚠️ 当前是频道首页（热播榜大卡，评分真实可作候选）：但点大卡会直接播放或进入列表，评分未经详情页复核——不要在此直接点卡播放。更稳路径：点卡/滚动进入列表页（有「最热/高分好评」筛选），在列表页按配对坐标选片，进详情页复核评分与题材后再播放。";
        } else if (!lastOcrDetail && !lastOcrPlayer && Math.round(y) < MINI_STRIP_Y && Math.round(x) >= 400) {
          // Top strip (hot-list / 片库 / search) — unrelated to the rating
          // task; clicking a hot entry opens/plays that title (16:43 session
          // tapped (2426,87) on the 心动的信号9 hot entry). Soft-flag.
          pairNote =
            "\n⚠️ 顶部 y<150 是热搜榜/片库/搜索条：点热搜条目会打开（可能直接播放）该片，与评分任务无关。回列表滚动读评分挑 ≥9 候选，不要点顶部条目。";
        } else if (!lastOcrDetail && !lastOcrPlayer && Math.round(y) > 280 && Math.round(x) >= 300) {
          // No rating pairs and not a rated list / detail / player: this is
          // the home or a navigation page. Tencent cards PLAY on click, so
          // a stray tap here starts unrelated content (16:33 session opened
          // 心动的信号9 before ever entering the film channel). Soft-flag.
          pairNote =
            "\n⚠️ 当前屏幕没有评分候选配对（首页/导航页）：腾讯视频首页的「你正在追」/热搜/推荐卡片点卡会直接播放无关内容（16:33 会话先点开了《心动的信号9》）。先点左侧导航「电影」（x≈200, y≈370）进入评分列表，再按配对坐标点片名；不要在首页点卡片。";
        }
        // Pass the session pid so the guard can auto-refocus the target app
        // before firing (synthetic clicks land on whatever is frontmost).
        await clickAt(x, y, state.pid ?? undefined);
        try {
          if (state.pid !== null) state = { ...state, outline: await treeOf(state.pid, 10) };
        } catch {
          /* keep old outline */
        }
        return { result: `已在 (${Math.round(x)}, ${Math.round(y)}) 合成单击（目标应用已确认在前台）。${note}${pairNote}${sortVerifyReminder()}界面如变化，大纲已自动更新；自绘 UI 变化请用 ocr 复核。若同一位置点击两次后界面仍无变化，说明点击可能未被应用响应——停止重复点击，用 ocr 验证并换坐标/换方式推进。`, state };
      }
      case "double_click_at": {
        const rawX = Number(args.x);
        const rawY = Number(args.y);
        if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
          return { result: "需要数字坐标 x, y", state };
        }
        const { x, y, note } = await clampToWindow(state.pid, rawX, rawY);
        let pairNote = "";
        if (lastListPairs.length) {
          const px = Math.round(x);
          const py = Math.round(y);
          const onTitle = lastListPairs.find(
            (p) => Math.abs(px - p.x) <= 60 && Math.abs(py - p.y) <= 40,
          );
          const nearest = lastListPairs
            .map((p) => ({ p, d: Math.hypot(px - p.x, py - p.y) }))
            .sort((a, b) => a.d - b.d)[0];
          // 该片已在顶部小窗播放中（刚点开的任务片）：再点会重新播放一遍，拦截。
          if (onTitle && miniPlayingTitle && sharesBigram(onTitle.title, miniPlayingTitle)) {
            pairNote = `\n（⚠️ 「${onTitle.title}」（评分 ${onTitle.score}）已在顶部小窗播放中——就是刚点开的那部，任务播放已开始。不要再点它/点它的卡片（会重新播放一遍）：按规则 ocr 确认播放器控件（选集/倍速/进度条/时间码）出现后 done 汇报）`;
          } else if (onTitle) {
            pairNote = `\n（将打开「${onTitle.title}」（评分 ${onTitle.score}）：进详情页后先 ocr 复核评分达标再点播放）`;
          } else if (nearest && nearest.d < 180 && !lastOcrDetail && py > 280) {
            return { result: `⛔ 双击 (${px}, ${py}) 被守卫拦截：它没落在任何评分候选的片名上（最近候选「${nearest.p.title}」评分 ${nearest.p.score} @(${nearest.p.x}, ${nearest.p.y})）。腾讯视频点卡片会直接开始播放，评分徽标/海报边缘/演员行会打开错误的片。先 ocr 刷新列表，确认目标片的片名与评分都在配对清单里，再点它的片名坐标；要切排序/筛选请点顶部标签（y≤280）。`, state };
          } else if (nearest && nearest.d < 180) {
            pairNote = `\n⚠️ 双击位置 (${px}, ${py}) 不在配对清单的任何片名上——评分徽标/海报边缘会错开到旁边影片。最近候选：「${nearest.p.title}」评分 ${nearest.p.score} 分，片名坐标 (${nearest.p.x}, ${nearest.p.y})。建议改点片名坐标。`;
          }
        } else if (lastOcrList && Math.round(y) <= 280 && Math.round(x) >= 330) {
          pairNote =
            "\n（若点的是排序/筛选标签（最热/高分好评/类型等）：点击后用 ocr 确认顶部排序字样与列表内容已变化，切换/加载可能要 1-2s，必要时 wait_for；点击后 ocr 无变化说明没点中或该项已选中，不要原地重复点击）";
          pendingSortVerify = true;
        } else if (lastOcrChannelHome && !lastOcrDetail && !lastOcrPlayer) {
          pairNote =
            "\n⚠️ 当前是频道首页（热播榜大卡，评分真实可作候选）：但点大卡会直接播放或进入列表，评分未经详情页复核——不要在此直接点卡播放。更稳路径：点卡/滚动进入列表页（有「最热/高分好评」筛选），在列表页按配对坐标选片，进详情页复核评分与题材后再播放。";
        } else if (!lastOcrDetail && !lastOcrPlayer && Math.round(y) < MINI_STRIP_Y && Math.round(x) >= 400) {
          pairNote =
            "\n⚠️ 顶部 y<150 是热搜榜/片库/搜索条：点热搜条目会打开（可能直接播放）该片，与评分任务无关。回列表滚动读评分挑 ≥9 候选，不要点顶部条目。";
        } else if (!lastOcrDetail && !lastOcrPlayer && Math.round(y) > 280 && Math.round(x) >= 300) {
          pairNote =
            "\n⚠️ 当前屏幕没有评分候选配对（首页/导航页）：腾讯视频首页的「你正在追」/热搜/推荐卡片点卡会直接播放无关内容（16:33 会话先点开了《心动的信号9》）。先点左侧导航「电影」（x≈200, y≈370）进入评分列表，再按配对坐标点片名；不要在首页点卡片。";
        }
        await doubleClickAt(x, y, state.pid ?? undefined);
        try {
          if (state.pid !== null) state = { ...state, outline: await treeOf(state.pid, 10) };
        } catch {
          /* keep old outline */
        }
        return { result: `已在 (${Math.round(x)}, ${Math.round(y)}) 合成双击（目标应用已确认在前台）。${note}${pairNote}${sortVerifyReminder()}`, state };
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
          // 只保留标题含关键词的分支（祖先链保留，path 对 menu_click 仍有效）。
          const kw = keyword.toLowerCase();
          const filterMenu = (e: MenuEntry): MenuEntry | null => {
            const children = e.children
              .map(filterMenu)
              .filter((c): c is MenuEntry => c !== null);
            const self = (e.title || "").toLowerCase().includes(kw);
            if (!self && !children.length) return null;
            return { ...e, children: self ? e.children : children };
          };
          const filtered = filterMenu(bar);
          if (!filtered) {
            return { result: `菜单栏里没有包含「${keyword}」的项`, state };
          }
          bar = filtered;
          note = `（仅显示包含「${keyword}」的菜单项）`;
        }
        /** Render one menu tree level: items with paths + submenu titles. */
        const renderMenu = (entry: MenuEntry, prefix: string): string[] =>
          entry.children.map((c) => {
            const line = `${prefix}${c.title || c.role} path=[${c.path.join(",")}]${c.children.length ? ` (子菜单 ${c.children.length} 项)` : ""}`;
            return [line, ...renderMenu(c, `${prefix}  `)].filter(Boolean);
          }).flat();
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
        try {
          state = { ...state, outline: await treeOf(state.pid, 10) };
        } catch {
          /* keep old outline */
        }
        return { result: `已按路径 [${path.join(",")}] 逐级点击菜单项。界面大纲已自动更新。`, state };
      }
      case "right_click_at": {
        const x = Number(args.x);
        const y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return { result: "需要数字坐标 x, y", state };
        }
        await rightClickAt(x, y, state.pid ?? undefined);
        try {
          if (state.pid !== null) state = { ...state, outline: await treeOf(state.pid, 12) };
        } catch {
          /* keep old outline */
        }
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
function friendlyLlmError(errText: string): string {
  const t = errText.toLowerCase();
  if (t.includes("额度耗尽") || t.includes("quota exhausted") || t.includes("free quota") || t.includes("free-models-per-day") || t.includes("insufficient quota")) {
    return "⛔ 模型的额度已用完（当日/余额配额），重试无效：\n· 在 ⚙️ 里换一个模型/服务商（或给该账户充值）\n· 日额度通常次日重置\n· 想本地兜底可装 Ollama 并把 ⚙️ 地址填 http://localhost:11434/v1";
  }
  if (t.includes("429") || t.includes("限流") || t.includes("tpm/rpm") || t.includes("rate")) {
    return "⛔ 模型服务限流了（请求太快或超出额度）。已按退避策略自动重试多轮仍失败：\n· 等 1–2 分钟再发一次\n· 或在 ⚙️ 里换一个模型/服务商\n· 检查账户的 TPM/RPM 配额";
  }
  if (t.includes("401") || t.includes("403") || t.includes("unauthorized") || t.includes("invalid api key")) {
    return "🔑 API 密钥无效或无权限，请在 ⚙️ 里检查密钥与模型名。";
  }
  if (t.includes("404")) {
    return "❓ 接口地址或模型名不对（404）。请检查 ⚙️ 里的 API 地址（应含 /v1 或由应用自动补全）与模型名。";
  }
  if (t.includes("timeout") || t.includes("timed out")) {
    return "⏱ 请求超时。模型服务响应太慢，请稍后重试或换个模型。";
  }
  return `❌ LLM 调用失败：${errText}`;
}

/** Hard step budget per agent run (each step = 1 model turn + its tool executions). */
const MAX_AGENT_STEPS = 25;

/** Cooperative stop flag: the ChatView stop button sets this mid-run. */
let stopRequested = false;

/** Guard: only one agent loop may run at a time (double-click / rapid sends). */
let isRunning = false;

/** Ask the running agent loop to stop at the next safe point. */
export function requestStop(): void {
  stopRequested = true;
}

/** One auto-continue nudge injected between segments (also used by resume). */
const CONTINUE_NUDGE = "继续：从上一步停下的地方接着完成目标，做完后用 done 汇报。";

/** Format tool args as `k=v` pairs, compact enough for a step heading. */
function argsText(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
    .join(" ");
}

/** Render one tool step heading, e.g. `🤖 步骤 1: click keyword=发送`. */
function stepHeading(seq: string, name: string, args: Record<string, unknown>): string {
  const argStr = argsText(args);
  return `🤖 ${seq} \`${name}\`${argStr ? " " + argStr : ""}`;
}

/** Step heading + its result in a code block (the "execution log" bubble). */
function withStepResult(heading: string, result: string): string {
  return heading + "\n\n```\n" + truncate(result, 800) + "\n```";
}

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
    if (missing.length) {
      sysPrompt =
        SYSTEM_PROMPT +
        "\n\n【当前环境限制】以下工具在本机未授权，调用必然失败，不要浪费步数尝试：\n" +
        missing.map((m) => `- ${m}`).join("\n");
    }
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
        // Observation tools never trip the loop guard: re-reading the screen
        // after an action is the correct verification loop (results change),
        // so ocr/read_screen/screen_info/frontmost_app/list_apps/wait_for are
        // exempt. The guard exists for ACTION tools — repeating the same
        // mutation (same click/scroll/type) is where the model gets stuck.
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
        if (isClickTool && cx !== null && cy !== null) {
          const run: { x: number; y: number }[] = [];
          for (let i = recentMoves.length - 1; i >= 0; i--) {
            const m = recentMoves[i];
            if (m.kind === "click") run.push({ x: m.x, y: m.y });
            else break;
          }
          run.push({ x: cx, y: cy });
          if (run.length >= 3) {
            const allNear = run.every((p) =>
              run.every((q) => Math.abs(p.x - q.x) <= 60 && Math.abs(p.y - q.y) <= 60),
            );
            if (allNear) {
              const hint =
                `您已在同一区域连续点击 ${run.length} 次（坐标相距 ≤60pt），且期间没有任何观察。\n` +
                "点击后页面毫无变化的原因排查（自绘 UI 不读屏就看不见）：\n" +
                "1. 目标已不在该坐标（窗口移动/最大化/滚动后布局变了）→ 先 ocr 找导航项当前位置；\n" +
                "2. 点击被弹窗/覆盖层挡住 → 先 ocr 找「关闭/取消」；\n" +
                "3. 页面切换有延迟 → 用 wait_for text=页面特征词（勿用导航栏恒在的词）等待。\n" +
                "请先 ocr 复核现状再决定下一步，不要继续盲点同一位置。";
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
            blindWarn =
              `⚠️ 您已连续点击 ${run.length} 次且中间没有任何 ocr/wait_for 验证（本次已执行）。` +
              "自绘 UI 中每步点击后都应观察：点完先 wait_for 页面特征词或 ocr 确认真的切换了；" +
              "页面无变化就换坐标/换方式，不要连续盲点。";
          }
        }
        if (isClickTool && cx !== null && cy !== null) {
          recentMoves.push({ kind: "click", x: cx, y: cy });
        } else if (OBSERVE_TOOLS.has(call.function.name)) {
          recentMoves.push({ kind: "observe" });
        } else if (call.function.name === "scroll") {
          recentMoves.push({ kind: "scroll" });
        } else {
          recentMoves.push({ kind: "other" });
        }
        if (recentMoves.length > 8) recentMoves.shift();
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

  const lower = input.toLowerCase();
  const num = (s: string | undefined) => (s !== undefined && s !== "" && Number.isFinite(Number(s)) ? Number(s) : null);

  // 帮助 always answered locally: cheap and works without a model.
  if (/^(帮助|help|用法|能做什么|指令)\??$/i.test(lower)) return helpReply(withUser);

  // Unified mode: the LLM plans and executes everything natural-language;
  // the fixed parser below is only an offline fallback when no model is
  // configured (⚙️ settings or AX_EXPLORER_LLM_* in .env).
  try {
    const info = await llmConfigured();
    if (info.configured) {
      // 「继续」 resumes the paused run with a fresh step budget.
      if (/^(继续|接着做|接着来|continue|go on|resume)\??$/i.test(lower)) {
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

  // 打开 / open
  const open = input.match(/^(?:打开|启动|open|launch)\s+(.+)$/i);
  if (open) return cmdOpen(withUser, open[1].trim());

  // 应用列表 / apps
  if (/^(应用列表|应用|apps|list apps)$/i.test(lower)) return cmdApps(withUser);

  // 读取 / read [app]
  const read = input.match(/^(?:读一下|读取|刷新读|读|read|inspect)\s*(.*)$/i);
  if (read) return cmdRead(withUser, read[1].trim());

  // 帮助 / help
  if (/^(帮助|help|用法|能做什么|指令)\??$/i.test(lower)) return helpReply(withUser);

  // 刷新 / refresh
  if (/^(刷新|refresh|重新读取)$/i.test(lower)) return cmdRead(withUser, "");

  // 点选 x y / probe x y
  const probe = input.match(/^(?:点选|点|probe|hit)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/i);
  if (probe) {
    const x = num(probe[1]);
    const y = num(probe[2]);
    if (x !== null && y !== null) return cmdProbe(withUser, x, y);
  }

  // 移动窗口 x y
  const move = input.match(/^(?:移动窗口|移动|move(?:\s+window)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/i);
  if (move) {
    const x = num(move[1]);
    const y = num(move[2]);
    if (x !== null && y !== null) return cmdMoveWindow(withUser, x, y);
  }

  // 输入 <text> [@field]
  const type = input.match(/^(?:输入|填写|输入文本|type|write)\s+(.+)$/is);
  if (type) return cmdType(withUser, type[1].trim());

  // 点击 <keyword>
  const click = input.match(/^(?:点击|按下|点一下|click|press)\s+(.+)$/i);
  if (click) return cmdClick(withUser, click[1].trim());

  // 聚焦 <keyword>
  const focus = input.match(/^(?:聚焦|focus)\s+(.+)$/i);
  if (focus) return cmdFocus(withUser, focus[1].trim());

  // 找 <keyword>
  const find = input.match(/^(?:找|搜索|查找|find|search)\s+(.+)$/i);
  if (find) return cmdFind(withUser, find[1].trim());

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
