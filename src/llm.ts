/**
 * LLM client wrapper + tool definitions for the agent loop.
 *
 * The loop lives in chat.ts: it sends the conversation + these tool schemas
 * to the model (via the Rust `llm_chat` command — key never touches the
 * webview), executes returned tool_calls against the AX commands, feeds tool
 * results back, until the model answers in prose.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { mcpLocalTools } from "./api.ts";

export interface LlmConfig {
  base_url: string;
  api_key: string;
  model: string;
  /** 单次回复输出 token 上限；0 = 不设限。留空由后端默认（2048）。 */
  max_tokens?: number;
}

export interface LlmMessage {
  role: string;
  content?: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
}

export interface LlmTurn {
  content: string;
  tool_calls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  finish_reason: string;
}

export function llmSetConfig(config: LlmConfig): Promise<void> {
  return invoke("llm_set_config", { config });
}

export function llmChat(
  messages: LlmMessage[],
  tools: unknown[],
): Promise<LlmTurn> {
  return invoke("llm_chat", { messages, tools });
}

/**
 * Streaming chat: the Rust side emits `llm://delta` events ({seq, text})
 * while the response is generated; `onDelta` receives each text chunk.
 * Resolves with the final turn exactly like `llmChat` (tool calls assembled).
 */
export async function llmChatStream(
  messages: LlmMessage[],
  tools: unknown[],
  onDelta: (full: string, delta: string) => void,
): Promise<LlmTurn> {
  let unlisten: UnlistenFn | undefined;
  let full = "";
  try {
    unlisten = await listen<{ seq: number; text: string }>("llm://delta", (ev) => {
      full += ev.payload.text;
      onDelta(full, ev.payload.text);
    });
    return await invoke("llm_chat_stream", { messages, tools });
  } finally {
    unlisten?.();
  }
}

export function llmListModels(baseUrl: string, apiKey: string): Promise<string[]> {
  return invoke("llm_list_models", { baseUrl, apiKey });
}

/** Config status: saved ⚙️ settings > .env > defaults. */
export interface LlmConfigured {
  configured: boolean;
  source: "settings" | "env" | "env-partial" | "default";
  base_url: string;
  model: string;
  /** 当前生效的输出 token 上限（0 = 不设限）。 */
  max_tokens: number;
  has_key: boolean;
}

export function llmConfigured(): Promise<LlmConfigured> {
  return invoke("llm_configured");
}

/** Skill summary from the tsm-hub gateway (/v1/skills). */
export interface HubSkill {
  name: string;
  description: string;
}

export function llmSkills(): Promise<HubSkill[]> {
  return invoke("llm_skills");
}

/** Full SKILL.md text of one gateway skill. */
export function llmSkill(name: string): Promise<string> {
  return invoke("llm_skill", { name });
}

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): unknown => ({ type: "object", properties, required });

/** Desktop tools executed locally in the Rust process (tsm-hub can't do these). */
export const DESKTOP_TOOLS: Array<{ name: string; description: string; parameters: unknown }> = [
  {
    name: "clipboard_set",
    description: "把文本写入 macOS 系统剪贴板。",
    parameters: obj({ text: { type: "string" } }, ["text"]),
  },
  {
    name: "clipboard_get",
    description: "读取系统剪贴板当前文本。",
    parameters: obj({}, []),
  },
  {
    name: "notify",
    description: "发送一条 macOS 系统通知。",
    parameters: obj(
      {
        title: { type: "string", description: "可选" },
        message: { type: "string" },
      },
      ["message"],
    ),
  },
  {
    name: "open_url",
    description: "用默认浏览器打开 http(s) 链接。",
    parameters: obj({ url: { type: "string" } }, ["url"]),
  },
  {
    name: "speak",
    description: "用系统语音朗读文本（say）。",
    parameters: obj({ text: { type: "string" } }, ["text"]),
  },
  {
    name: "screen_info",
    description: "返回所有显示器的原点与尺寸（决定窗口摆放坐标前先用它）。",
    parameters: obj({}, []),
  },
  {
    name: "frontmost_app",
    description: "返回当前最前台应用的名称与 pid。",
    parameters: obj({}, []),
  },
  {
    name: "fs_scan",
    description:
      "扫描目录列出文件与子目录（名称/扩展名/大小/修改时间，JSON 数组，按修改时间倒序）。文件整理前先用它了解全量，max_depth 默认 1（上限 3），limit 默认 500。",
    parameters: obj(
      {
        path: { type: "string", description: "要扫描的目录绝对路径（可用 ~ 开头）" },
        max_depth: { type: "number", description: "递归深度，默认 1，最大 3" },
        limit: { type: "number", description: "返回条数上限，默认 500" },
      },
      ["path"],
    ),
  },
  {
    name: "fs_move",
    description:
      "批量移动/重命名文件（只移动，永不删除、永不覆盖）。dry_run=true（默认）只校验并报告计划；dry_run=false 才真正移动。目标重名自动加序号。文件归档流程：先 fs_scan 全量了解 → 生成移动计划 → 用 fs_move dry_run 预演并汇报给用户 → 用户确认后再 dry_run=false 执行。",
    parameters: obj(
      {
        moves: {
          type: "array",
          description: "移动列表：[{from, to}]，均为绝对路径（可用 ~ 开头）",
          items: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "string" },
            },
            required: ["from", "to"],
          },
        },
        dry_run: { type: "boolean", description: "默认 true=只预演不执行；false=真正移动" },
      },
      ["moves"],
    ),
  },
];

/** Cached local MCP tools (mcp.local.json servers), loaded lazily. */
let mcpCache: Array<{ name: string; description: string; parameters: unknown }> | null = null;

export async function localMcpTools(): Promise<
  Array<{ name: string; description: string; parameters: unknown }>
> {
  if (mcpCache !== null) return mcpCache;
  try {
    const tools = await mcpLocalTools();
    mcpCache = tools.map((t) => ({
      name: `mcp_local_${t.name}`,
      description: `[本地MCP] ${t.description}`,
      parameters: t.parameters,
    }));
  } catch {
    mcpCache = [];
  }
  return mcpCache;
}

/** Drop the MCP tool cache (call after editing mcp.local.json). */
export function invalidateMcpCache(): void {
  mcpCache = null;
}

/**
 * Tools the model may call; executed in chat.ts. Static AX + desktop tools,
 * plus dynamic mcp_local_* entries discovered from mcp.local.json.
 * profile_search is registered only when the local profile RAG is actually
 * configured (PROFILE_RAG_KEY set) — otherwise the model wastes a call on
 * a guaranteed "未配置" error (three 9/16 sessions each did).
 */
export async function agentTools(): Promise<
  Array<{ name: string; description: string; parameters: unknown }>
> {
  const mcp = await localMcpTools();
  const profile = (await invoke<boolean>("ax_profile_rag_configured"))
    ? [PROFILE_SEARCH_TOOL]
    : [];
  return [...AGENT_TOOLS, ...DESKTOP_TOOLS, ...profile, ...mcp];
}

/** Registered only when the local profile RAG is configured (see
 *  agentTools); executed in chat.ts against desktop_tool_exec. */
export const PROFILE_SEARCH_TOOL: {
  name: string;
  description: string;
  parameters: unknown;
} = {
  name: "profile_search",
  description: "检索我的个人资料库（本地 RAG：职业经历、年龄、人格画像、工作习惯等文档片段）。我的资料没有现成的「观影偏好」，做个性化推荐/决策前先查我的画像特征，再据此推断我可能喜欢的类型。",
  parameters: obj(
    { query: { type: "string", description: "想了解的方面，如「职业经历 年龄 性格特点」「工作强度 生活节奏」" } },
    ["query"],
  ),
};

/** Tools the model may call; executed in chat.ts against the AX commands. */
export const AGENT_TOOLS: Array<{ name: string; description: string; parameters: unknown }> = [
  {
    name: "list_apps",
    description: "列出当前运行的 GUI 应用（pid 与名称）。当用户没说打开哪个应用时先用这个。",
    parameters: obj({}, []),
  },
  {
    name: "open_app",
    description: "启动或聚焦一个应用。app 参数只填应用名称本身（如 TextEdit / 备忘录 / 网易云音乐），禁止传入任务描述、句子或任何其他文字——传长文本会匹配失败。成功后自动返回该应用的界面大纲。",
    parameters: obj(
      { app: { type: "string", description: "应用名称（仅名称本身，如 TextEdit / 网易云音乐；不要粘贴任务描述）" } },
      ["app"],
    ),
  },
  {
    name: "read_screen",
    description: "读取当前目标应用的界面大纲：窗口/按钮/文本框等元素及其标题、值、可执行动作。open_app 的结果里已包含大纲，通常无需立即重读。可用 filter 只看相关元素以省步数。",
    parameters: obj(
      {
        app: { type: "string", description: "可选：改为读取这个应用" },
        filter: { type: "string", description: "可选：只返回标题/值/角色匹配的元素；支持多关键词（空格或逗号分隔，任一命中即可），如「按钮 输入框」" },
      },
      [],
    ),
  },
  {
    name: "wait_for",
    description: "等待界面状态变化，用于同步：刚打开应用等它加载完、点击后等弹窗/新元素出现、等列表刷新、等弹窗关闭或播放结束。内部用 macOS 界面变化通知等待（非盲 sleep）。等待目标二选一：element（AX 树元素关键词，普通应用）或 text（屏幕 OCR 文字，自绘 UI 应用如视频/游戏——用截图识别等某段文字出现或消失，如「播放中」「加载完成」）。验证页面切换时，目标词必须选目标页特有的文字（如影片名、详情按钮），不要用导航栏里恒在的词（如「电影」「首页」——它们存在不代表页面切换了）。都不给则仅报告界面是否变化（不推荐，浪费步数）。gone=true 时改为等待目标消失（如「弹窗关闭」「播放结束」），默认 false=等待出现。注意：gone 验证必须选「切换后必然消失的旧页特征词」，不要用顶部轮播横幅/广告位的词（如「心动的信号」「我们战斗吧」）——它们会自动轮换消失，会造成「页面已切换」的假象。每次最多等 timeout 秒（默认 8，上限 10），超时未满足会返回当前界面摘要供你决定下一步。",
    parameters: obj(
      {
        element: { type: "string", description: "可选：等待出现/消失的 AX 元素关键词（标题/值/角色），普通应用用这个" },
        text: { type: "string", description: "可选：等待出现/消失的屏幕文字（自绘 UI 用 OCR 识别，如「播放中」），与 element 二选一" },
        gone: { type: "boolean", description: "可选：true=等待目标消失（如弹窗关闭、播放结束），默认 false=等待出现" },
        timeout: { type: "number", description: "可选：最多等待秒数，默认 8，上限 10" },
      },
      [],
    ),
  },
  {
    name: "find",
    description: "在当前界面大纲中按关键词搜索元素，返回匹配列表。支持多关键词（空格或逗号分隔，任一命中即可），如「保存 导出」。",
    parameters: obj({ keyword: { type: "string", description: "元素标题或描述里的关键词，多个词用空格/逗号分隔" } }, ["keyword"]),
  },
  {
    name: "click",
    description: "点击元素：按关键词找到元素并执行它的第一个动作（通常是 AXPress）。",
    parameters: obj({ keyword: { type: "string", description: "元素标题或描述里的关键词" } }, ["keyword"]),
  },
  {
    name: "type_text",
    description: "把文本写入一个文本框/文本区（整段替换其内容），可指定字段关键词，默认第一个输入区。",
    parameters: obj(
      {
        text: { type: "string" },
        field: { type: "string", description: "可选：目标字段的关键词" },
      },
      ["text"],
    ),
  },
  {
    name: "focus",
    description: "把键盘焦点给到某元素（关键词定位）。",
    parameters: obj({ keyword: { type: "string" } }, ["keyword"]),
  },
  {
    name: "move_window",
    description: "移动当前应用的窗口：给 x/y（全局屏幕坐标 points）精确移动，或给 position 语义摆放（left 左缘 / right 右缘 / center 居中 / maximize 铺满——自动换算坐标，maximize 会同时调整窗口尺寸）。多显示器时用 screen 指定显示器 index（0=主屏，其余按 screen_info 顺序）。摆分屏布局时建议配合 resize_window 先定尺寸。",
    parameters: obj(
      {
        x: { type: "number", description: "目标 x（points）；给了 position 可省略" },
        y: { type: "number", description: "目标 y（points）；给了 position 可省略" },
        position: { type: "string", description: "可选：left/right/center/maximize 语义摆放" },
        screen: { type: "number", description: "可选：显示器 index（0=主屏），仅 position 模式生效" },
      },
      [],
    ),
  },
  {
    name: "resize_window",
    description: "把当前应用的窗口调整为指定宽高（points）。配合 move_window 摆分屏/布局（如左半屏：resize 到约 960x1080 再 move 到 0,0；尺寸可用 screen_info 的显示器大小推算）。部分应用不支持 AXSize，失败会报错。",
    parameters: obj(
      {
        w: { type: "number", description: "目标宽度（points）" },
        h: { type: "number", description: "目标高度（points）" },
      },
      ["w", "h"],
    ),
  },
  {
    name: "element_at",
    description: "查询屏幕坐标 (x, y) 处是什么元素（任意应用），返回 role/标题/所属 pid。",
    parameters: obj({ x: { type: "number" }, y: { type: "number" } }, ["x", "y"]),
  },
  {
    name: "scroll",
    description: "在屏幕坐标 (x, y) 处合成滚轮事件滚动（多数应用没有 AX 滚动动作时用这个，如微信聊天记录/长列表）。lines 为滚动行数，正数向上、负数向下；常用值 ±5，大数值滚得更快。",
    parameters: obj(
      {
        x: { type: "number", description: "全局屏幕坐标 x" },
        y: { type: "number", description: "全局屏幕坐标 y（通常用列表/聊天区的中心坐标）" },
        lines: { type: "number", description: "滚动行数：正=向上，负=向下；±5 起步" },
      },
      ["x", "y", "lines"],
    ),
  },
  {
    name: "scroll_to",
    description: "把某个元素滚动到可见（语义 AXScrollToVisible，无合成事件）。适合长列表里 find 到了目标但点击无效的场景。",
    parameters: obj({ keyword: { type: "string", description: "元素标题或描述里的关键词" } }, ["keyword"]),
  },
  {
    name: "named_action",
    description: "对元素执行指定的 AX 动作（AXIncrement/AXDecrement/AXPick/AXShowMenu/AXConfirm/AXCancel 等），比 click 更精确。动作用元素动作列表里的原文。",
    parameters: obj(
      {
        keyword: { type: "string", description: "元素标题或描述里的关键词" },
        action: { type: "string", description: "AX 动作名，如 AXIncrement" },
      },
      ["keyword", "action"],
    ),
  },
  {
    name: "key",
    description: "按一个键或快捷键（合成键盘事件，发给当前聚焦的元素）：回车发送、Esc 关闭弹窗、方向键在列表里导航、Tab 切换焦点。视频/播放器应用：空格=播放/暂停（自绘播放器找不到播放按钮时先试这个）。系统级快捷键可直接用：Cmd+W 关闭窗口、Cmd+Q 退出、Cmd+N 新建、Cmd+Z 撤销、Cmd+C/V/X 复制粘贴剪切、Cmd+A 全选、Cmd+F 搜索、Cmd+Home/End 到文档首/尾、PageUp/PageDown 翻页。写法如 enter / esc / Cmd+F / Cmd+Shift+T / Alt+Left。",
    parameters: obj(
      { combo: { type: "string", description: "键或组合键，如 enter、esc、Cmd+F、Alt+Left、Cmd+W" } },
      ["combo"],
    ),
  },
  {
    name: "type_keys",
    description: "逐键合成键盘输入（支持中文/emoji）。用于语义 AXValue 写入不生效的场景：随输入即搜索的框、自动补全下拉、聊天输入框（配合 key enter 发送）。输入前必须先 focus 或 click 目标输入框。注意与 type_text 的区别：type_text 是整段替换 AXValue，不触发逐键反应。",
    parameters: obj(
      { text: { type: "string", description: "要逐键输入的文本" } },
      ["text"],
    ),
  },
  {
    name: "click_at",
    description: "在屏幕坐标 (x, y) 处合成鼠标左键单击。最后的手段：仅当目标控件既没有 AX 动作、也点不到（element_at 返回不了可用元素）时用 —— 画布、地图、自绘表格、内嵌网页。先 element_at 确认那里确实没有 AX 元素再动手。",
    parameters: obj(
      {
        x: { type: "number", description: "全局屏幕坐标 x" },
        y: { type: "number", description: "全局屏幕坐标 y" },
      },
      ["x", "y"],
    ),
  },
  {
    name: "double_click_at",
    description: "在屏幕坐标 (x, y) 处合成鼠标左键双击（选中词/打开文件/进入全屏等）。同样仅用于 AX 覆盖不到的自绘控件。",
    parameters: obj(
      {
        x: { type: "number", description: "全局屏幕坐标 x" },
        y: { type: "number", description: "全局屏幕坐标 y" },
      },
      ["x", "y"],
    ),
  },
  {
    name: "drag",
    description: "从 (from_x, from_y) 按住左键拖拽到 (to_x, to_y)，路径分步插值（默认 12 步）。用于拖动滑块/进度条、画布绘制、地图平移、拖拽排序等自绘控件。拖完后如需验证结果，read_screen 或 element_at。",
    parameters: obj(
      {
        from_x: { type: "number", description: "起点 x" },
        from_y: { type: "number", description: "起点 y" },
        to_x: { type: "number", description: "终点 x" },
        to_y: { type: "number", description: "终点 y" },
        steps: { type: "number", description: "可选：插值步数，默认 12" },
      },
      ["from_x", "from_y", "to_x", "to_y"],
    ),
  },
  {
    name: "menu_bar",
    description: "读取目标应用（默认当前前台应用）的菜单栏树：每个菜单和菜单项带 path（用于 menu_click）和可用动作。菜单驱动的操作（导出、全屏、偏好设置、格式转换）优先走菜单而不是猜按钮。大应用的菜单很长时用 keyword 只过滤相关项（祖先链保留，path 仍可直接用），省上下文。",
    parameters: obj(
      {
        app: { type: "string", description: "可选：应用名（默认前台应用）" },
        keyword: { type: "string", description: "可选：只返回标题包含此关键词的菜单项" },
      },
      [],
    ),
  },
  {
    name: "menu_click",
    description: "点击 menu_bar 返回的菜单项（按 path 逐级 AXPress，语义操作，不需要鼠标在菜单栏上）。path 来自最近的 menu_bar 结果；跨级路径（如 文件>导出>PDF）直接传完整 path。",
    parameters: obj(
      { path: { type: "array", items: { type: "number" }, description: "menu_bar 返回的菜单项 path" } },
      ["path"],
    ),
  },
  {
    name: "right_click_at",
    description: "在屏幕坐标 (x, y) 处合成鼠标右键单击（弹出上下文菜单）。目标应用必须在前台。弹出后用 menu_bar（上下文菜单也会出现在 AX 树里）或 element_at 找菜单项再点击。",
    parameters: obj(
      {
        x: { type: "number", description: "全局屏幕坐标 x" },
        y: { type: "number", description: "全局屏幕坐标 y" },
      },
      ["x", "y"],
    ),
  },
   {
    name: "ocr",
    description: "对指定应用的主窗口截图做文字识别（OCR），返回画面中每段文字的文本 + 屏幕坐标（x/y=屏幕点，左上角原点，可直接喂 click_at）。专供自绘 UI（AX 树里没有可读标签的 app，如腾讯视频/QQLive）替代 read_screen。窗口按钮是关闭/最小化时须先让用户确认。",
    parameters: obj(
      { app: { type: "string", description: "可选：按应用名查找 pid，留空用当前目标" } },
      [],
    ),
  },
  {
    name: "done",
    description:
      "任务完成（或无法继续）时调用：向用户汇报结果。summary 给用户看的最终中文报告（结论完整、可直接阅读，但不必逐字重复你同时输出的正文）。若你已在正文里写了完整报告，summary 写简明总结即可——界面优先展示正文。",
    parameters: obj({ summary: { type: "string", description: "给用户看的中文总结（结论完整；正文里已写完整报告时可精简）" } }, ["summary"]),
  },
];
// 注：不再提供 list_skills / use_skill 客户端工具 —— tsm-hub 网关对每条
// chat 请求会把技能清单（inject_skills）注入 system prompt，模型已"看得见"
// 全部技能；再提供同名客户端工具属于重复能力，还多花两步。
// （技能内容执行仍可用：网关自身带 skill-run 工具，在需要时由网关 agent 执行。）
