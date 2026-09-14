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
    lines.push(m.text);
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
        const shown = filter ? findNodes(outline, filter) : outline;
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
              return {
                result: `等待完成（${waited}s）：屏幕文字「${ocrText}」已${gone ? "消失" : `出现${where}`}`,
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
        return {
          result: `${tail}。当前界面：\n${renderOutline(state.outline) || "（无元素）"}`,
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
        const NAV = /^(电影|电视剧|综艺|动漫|少儿|首页|片库|NBA|VIP会员|返回|播放中|正在播放|立即播放|最热|最新|高分好评|免费|付费|资费|类型|全选|筛选|你正在追|腾讯视频)$/;
        const RATING = /^(\d\.\d)(分)?$/;
        const rating = words.find(
          (w) => RATING.test(w.text) && w.confidence >= 0.5,
        );
        let pairs: string[] = [];
        if (rating) {
          const cx = (w: OcrScreenWord) => w.x + w.w / 2;
          for (const r of words) {
            if (!RATING.test(r.text) || r.confidence < 0.5) continue;
            const title = words
              .filter(
                (t) =>
                  t !== r &&
                  !RATING.test(t.text) &&
                  t.confidence >= 0.5 &&
                  t.text.length >= 2 &&
                  /^[\u4e00-\u9fa5《》·\s0-9A-Za-z]+$/.test(t.text) &&
                  !NAV.test(t.text),
              )
              .map((t) => ({ t, d: Math.abs(cx(t) - cx(r)) * 0.6 + Math.abs(t.y - r.y) }))
              .sort((a, b) => a.d - b.d)[0];
            if (title && title.d < 150) {
              pairs.push(
                `「${title.t.text.trim()}」评分 ${r.text.replace("分", "")} 分 → 点片名坐标 (${Math.round(title.t.x + title.t.w / 2)}, ${Math.round(title.t.y + title.t.h / 2)})`,
              );
            }
          }
          pairs = [...new Set(pairs)].slice(0, 6);
        }
        // Detect strong playback evidence so the model stops poking around.
        const playing = /播放中|正在播放/.test(joined);
        return {
          result:
            `${name} 画面文字识别（坐标=屏幕点，可直接 click_at/type_keys）：\n${joined}` +
            (pairs.length ? `\n\n【评分-片名配对】（点片名坐标打开详情，不会错位）：\n${pairs.join("\n")}` : "") +
            (playing
              ? "\n（检测到「播放中」标记：视频已在播放，按规则立即 done 汇报，不要再点击）"
              : ""),
          state,
        };
      }
      case "find": {
        const hits = findNodes(state.outline, str("keyword"));
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
        if (state.pid === null) return { result: "尚未选择应用", state };
        const win = state.outline.find((n) => n.role === "AXWindow");
        if (!win) return { result: "没有窗口节点", state };
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
        return {
          result:
            position === "maximize"
              ? `窗口已最大化铺满 ${screenIdx === 0 ? "主屏" : `显示器 ${screenIdx}`}`
              : `窗口已移到 (${Math.round(x)}, ${Math.round(y)})${
                  resize ? ` 并调整到 ${resize.w}x${resize.h}` : ""
                }${screenIdx === 0 ? "" : `（显示器 ${screenIdx}）`}`,
          state,
        };
      }
      case "resize_window": {
        if (state.pid === null) return { result: "尚未选择应用", state };
        const w = Number(args.w);
        const h = Number(args.h);
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
          return { result: "w/h 必须是正数（points）", state };
        }
        const win = state.outline.find((n) => n.role === "AXWindow");
        if (!win) return { result: "没有窗口节点", state };
        const prev = await readAttribute(state.pid, win.path, "AXSize").catch(() => null);
        await resizeWindow(state.pid, win.path, w, h, {
          role: win.role,
          label: win.label,
        });
        state = prev && prev.includes("w:")
          ? { ...state, undo: { kind: "set_size", pid: state.pid, path: win.path, prev, label: "窗口" } }
          : state;
        return { result: `窗口已调整为 ${w}x${h}`, state };
      }
      case "element_at": {
        const hit = await elementAt(Number(args.x) || 0, Number(args.y) || 0);
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
        await scrollAt(x, y, lines, state.pid ?? undefined);
        return {
          result: `已在 (${x}, ${y}) 滚动 ${lines > 0 ? "向上" : "向下"} ${Math.abs(lines)} 行。${clamped.note}如需查看新内容请 read_screen 或 find。`,
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
        return { result: `已按键 ${combo}（发给当前聚焦的元素）。界面如变化，大纲已自动更新。`, state };
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
        // Pass the session pid so the guard can auto-refocus the target app
        // before firing (synthetic clicks land on whatever is frontmost).
        await clickAt(x, y, state.pid ?? undefined);
        try {
          if (state.pid !== null) state = { ...state, outline: await treeOf(state.pid, 10) };
        } catch {
          /* keep old outline */
        }
        return { result: `已在 (${Math.round(x)}, ${Math.round(y)}) 合成单击（目标应用已确认在前台）。${note}界面如变化，大纲已自动更新；自绘 UI 变化请用 ocr 复核。`, state };
      }
      case "double_click_at": {
        const rawX = Number(args.x);
        const rawY = Number(args.y);
        if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
          return { result: "需要数字坐标 x, y", state };
        }
        const { x, y, note } = await clampToWindow(state.pid, rawX, rawY);
        await doubleClickAt(x, y, state.pid ?? undefined);
        try {
          if (state.pid !== null) state = { ...state, outline: await treeOf(state.pid, 10) };
        } catch {
          /* keep old outline */
        }
        return { result: `已在 (${Math.round(x)}, ${Math.round(y)}) 合成双击（目标应用已确认在前台）。${note}`, state };
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
        if (wanted) {
          const apps = await listApps();
          const hit = apps.find((a) => a.name.toLowerCase().includes(wanted.toLowerCase()));
          if (!hit) return { result: `未找到运行中的应用「${wanted}」`, state };
          pid = hit.pid;
        } else if (pid === null) {
          return { result: "尚未选择应用且没有指定 app 参数（menu_bar 默认读前台应用，也可传 app 名）", state };
        }
        const bar = await menuBar(pid ?? undefined, 4);
        /** Render one menu tree level: items with paths + submenu titles. */
        const renderMenu = (entry: MenuEntry, prefix: string): string[] =>
          entry.children.map((c) => {
            const line = `${prefix}${c.title || c.role} path=[${c.path.join(",")}]${c.children.length ? ` (子菜单 ${c.children.length} 项)` : ""}`;
            return [line, ...renderMenu(c, `${prefix}  `)].filter(Boolean);
          }).flat();
        const lines = [
          `菜单栏（pid ${pid}）：`,
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

  // Signature of the last executed tool call; repeating it back-to-back means
  // the model is stuck in a loop (see the guard inside the tool loop).
  let lastToolSig: string | null = null;

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
        const sig = `${call.function.name} ${argsSig}`;
        if (sig === lastToolSig) {
          // Loop guard: the model is repeating the exact same operation it just
          // ran. Don't re-execute — prompt it to check the current state instead.
          const hint =
            "您在前一步已执行过完全相同的操作（工具与参数一致）。不要重复执行。\n" +
            "请先用 find（或 read_screen 加 filter）确认界面现状：\n" +
            "- 若用户目标已经客观达成 → 直接用 done 汇报并结束；\n" +
            "- 若未达成 → 换一种操作推进，不要原样重试。";
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
        lastToolSig = sig;
        const seq = `${seqBase + steps + 1}/${budget}`;
        const heading = stepHeading(seq, call.function.name, args);
        const stepId = nextId++;
        working = commit({
          ...working,
          messages: [...working.messages, { id: stepId, role: "assistant", text: heading }],
        });
        const { result, state: next, dangerous } = await runTool(working, call.function.name, args);
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
