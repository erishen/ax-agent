// Generic, IO-free decision helpers for the agent frontend. Everything in
// this file is a pure function over plain data — unit-testable without
// mocks, and kept OUT of chat.ts so the 1000+-line dispatcher only holds
// orchestration. Extracted from the move_window / wait_for cases after the
// Tencent state machine move (chat.ts 2451→1888): those two cases held
// window-placement math and OCR-quality judgement that had zero test
// coverage, and the 16:43 session showed a wrong maximize landing layout
// (all old coords stale) and wait_for false-positives on nav words.
import { truncate } from "./tree-utils.ts";
import type { MenuEntry } from "./api";
import type { AxAppInfo } from "./types";

/**
 * Resolve a user/model-supplied app reference against the running-app list.
 * Matches (case-insensitive substring) the display name, the bundle id, or an
 * exact numeric pid. Previously only the display name was matched, so names
 * echoed back by open_app (CFBundleName, e.g. "NeteaseMusic") failed in
 * ocr/read_screen ("未找到运行中的应用"), burning a step and misdirecting the
 * model. Pure + IO-free for unit tests.
 */
export function resolveAppMatch(
  apps: AxAppInfo[],
  wanted: string,
): AxAppInfo | null {
  const q = wanted.trim().toLowerCase();
  if (!q) return null;
  if (/^\d+$/.test(q)) {
    const byPid = apps.find((a) => String(a.pid) === q);
    if (byPid) return byPid;
  }
  return (
    apps.find(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.bundle_id.toLowerCase().includes(q),
    ) ?? null
  );
}

/** One NSScreen entry as returned by the `screen_info` desktop tool. */
export interface ScreenInfo {
  index: number;
  origin: [number, number];
  size: [number, number];
}

/** Resolved move target: absolute x/y plus an optional resize (maximize). */
export interface WindowPlacement {
  x: number;
  y: number;
  resize: { w: number; h: number } | null;
  screenIdx: number;
}

export type PlacementResult =
  | { ok: true; placement: WindowPlacement }
  | { ok: false; error: string };

/**
 * Resolve the `position` semantic (left/right/center/maximize) of the
 * move_window tool into absolute coordinates on the chosen screen.
 * Pure: screens/position/window-size fully determine the result.
 */
export function resolveWindowPlacement(
  screens: ScreenInfo[],
  screen: number | undefined,
  position: string,
  windowSize: { w: number; h: number } | null,
): PlacementResult {
  if (!screens.length) {
    return { ok: false, error: `无法读取屏幕信息来换算 position=${position}，请改用 x/y` };
  }
  const screenIdx = Number.isInteger(screen) ? (screen as number) : 0;
  const main = screens[screenIdx] ?? screens[0];
  const ww = windowSize?.w ?? 0;
  const wh = windowSize?.h ?? 0;
  let x: number;
  let y: number;
  let resize: { w: number; h: number } | null = null;
  switch (position) {
    case "left":
      x = main.origin[0];
      y = main.origin[1];
      break;
    case "right":
      x = main.origin[0] + main.size[0] - ww;
      y = main.origin[1];
      break;
    case "center":
      x = main.origin[0] + (main.size[0] - ww) / 2;
      y = main.origin[1] + (main.size[1] - wh) / 2;
      break;
    case "maximize":
      x = main.origin[0];
      y = main.origin[1];
      resize = { w: main.size[0], h: main.size[1] };
      break;
    default:
      return { ok: false, error: `未知 position: ${position}（支持 left/right/center/maximize）` };
  }
  return { ok: true, placement: { x, y, resize, screenIdx } };
}

/**
 * Nav-bar words that are visible on (almost) every Tencent-Video-style page.
 * wait_for on one of these proves nothing about a page switch — the hint
 * must tell the model to look for a page-specific marker instead.
 */
export const NAV_WORDS = [
  "首页", "电影", "电视剧", "综艺", "动漫", "少儿", "你正在追",
  "VIP会员", "片库", "NBA", "短剧", "小游戏", "纪录片", "体育",
] as const;

/** Constant-word warning for a wait_for hit, or "" when the target is safe. */
export function navWordNote(ocrText: string, gone: boolean): string {
  if (gone) return "";
  if (!NAV_WORDS.some((w) => ocrText.includes(w))) return "";
  return (
    `\n注意：「${ocrText}」是导航栏常驻词，出现不代表页面已切换——` +
    "请用 ocr 确认目标页特征（频道页的筛选栏/返回键、影片名）后再继续。"
  );
}

/** OCR-quality warning for a wait_for timeout, or "" when text is clean. */
export function garbledOcrNote(
  words: { text: string; confidence: number }[],
): string {
  if (words.length <= 3) return "";
  const low = words.filter((w) => w.confidence < 0.5).length;
  if (low / words.length <= 0.5 && low < 10) return "";
  return (
    `\n⚠️ 当前 OCR 质量差（大量乱码词），页面可能在加载/动画中，或窗口被遮挡/未在前台。` +
    "建议：wait_for 1-2s 后重扫；若持续乱码，尝试 move_window maximize 或确认目标应用在前台。"
  );
}

/**
 * Parsed offline command from a user utterance. The fixed parser is only a
 * fallback when no LLM is configured; every pattern here mirrors the old
 * inline regex chain in handleUtterance (order matters — read after open,
 * refresh after read, etc.).
 */
export type ParsedCommand =
  | { kind: "help" }
  | { kind: "continue" }
  | { kind: "open"; target: string; tail?: string }
  | { kind: "apps" }
  | { kind: "read"; app: string }
  | { kind: "refresh" }
  | { kind: "probe"; x: number; y: number }
  | { kind: "move"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "click"; keyword: string }
  | { kind: "focus"; keyword: string }
  | { kind: "find"; keyword: string };

/** Parse a raw user line into the offline command it maps to, or null. */
/**
 * Cut a parsed "打开 X" target down to the app name itself. The quick-command
 * parser is a regex, so "打开访达，read_screen 浏览…" would otherwise take the
 * WHOLE sentence as the app name and fail (17:21/17:40/18:01 sessions). Cut at
 * the first punctuation boundary — app names never contain one. No space
 * splitting: "Google Chrome" must stay whole.
 */
export function cutAppName(s: string): string {
  // App names never contain punctuation OR the common conjunction words used
  // to chain the next instruction ("备忘录并全面审计…" → 备忘录). No space
  // splitting: "Google Chrome" must stay whole.
  return s.split(/[,，。;；、\n「」并和然后再]|\s+and\s+/i)[0].trim();
}

export function parseCommand(input: string): ParsedCommand | null {
  const lower = input.trim().toLowerCase();
  const num = (s: string | undefined) =>
    s !== undefined && s !== "" && Number.isFinite(Number(s)) ? Number(s) : null;
  if (/^(帮助|help|用法|能做什么|指令)[?？]?$/i.test(lower)) return { kind: "help" };
  if (/^(继续|接着做|接着来|continue|go on|resume)[?？]?$/i.test(lower)) return { kind: "continue" };
  const open = input.match(/^(?:打开|启动|open|launch)\s*(.+)$/i);
  if (open) {
    const raw = open[1].trim();
    const target = cutAppName(raw);
    // Whatever got cut away is the rest of the task — the offline open
    // command can only launch, so surface it (19:52 session: '打开日历，用
    // ocr 或 read_screen 查看今天的日期区域…' opened but never reported).
    const tail = raw.slice(target.length).replace(/^[,，。;；、\s并和然后再]+/, "");
    return { kind: "open", target, tail };
  }
  if (/^(应用列表|应用|apps|list apps)$/i.test(lower)) return { kind: "apps" };
  const read = input.match(/^(?:读一下|读取|刷新读|读|read|inspect)\s*(.*)$/i);
  if (read) return { kind: "read", app: read[1].trim() };
  if (/^(刷新|refresh|重新读取)$/i.test(lower)) return { kind: "refresh" };
  const probe = input.match(/^(?:点选|点|probe|hit)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/i);
  if (probe) {
    const x = num(probe[1]);
    const y = num(probe[2]);
    if (x !== null && y !== null) return { kind: "probe", x, y };
  }
  const move = input.match(/^(?:移动窗口|移动|move(?:\s+window)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/i);
  if (move) {
    const x = num(move[1]);
    const y = num(move[2]);
    if (x !== null && y !== null) return { kind: "move", x, y };
  }
  const type = input.match(/^(?:输入|填写|输入文本|type|write)\s*(.+)$/is);
  if (type) return { kind: "type", text: type[1].trim() };
  const click = input.match(/^(?:点击|按下|点一下|click|press)\s*(.+)$/i);
  if (click) return { kind: "click", keyword: click[1].trim() };
  const focus = input.match(/^(?:聚焦|focus)\s*(.+)$/i);
  if (focus) return { kind: "focus", keyword: focus[1].trim() };
  const find = input.match(/^(?:找|搜索|查找|find|search)\s*(.+)$/i);
  if (find) return { kind: "find", keyword: find[1].trim() };
  return null;
}

// --- Chat text formatting + LLM error mapping (formerly inline in chat.ts,
// zero coverage). friendlyLlmError is what the user actually reads when a
// model call fails; the step helpers shape the execution-log bubbles.

/** Normalize an unknown thrown value into a message string. */
export function asText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Map common LLM failures to actionable Chinese guidance. */
export function friendlyLlmError(errText: string): string {
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
  if (t.includes("网络错误") && t.includes("已退避重试")) {
    return "⏱ 模型服务网络错误（超时/连接异常），已自动重试多轮仍失败：\n· 等 1–2 分钟再发一次\n· 或在 ⚙️ 里换一个模型/服务商\n· 持续出现时检查本地中转 / 代理状态";
  }
  if (t.includes("timeout") || t.includes("timed out")) {
    return "⏱ 请求超时。模型服务响应太慢，已自动重试仍失败，请稍后重试或换个模型。";
  }
  return `❌ LLM 调用失败：${errText}`;
}

/** Format tool args as `k=v` pairs, compact enough for a step heading. */
export function argsText(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
    .join(" ");
}

/** Render one tool step heading, e.g. `🤖 步骤 1: click keyword=发送`. */
export function stepHeading(seq: string, name: string, args: Record<string, unknown>): string {
  const argStr = argsText(args);
  return `🤖 ${seq} \`${name}\`${argStr ? " " + argStr : ""}`;
}

/** Step heading + its result in a code block (the "execution log" bubble). */
export function withStepResult(heading: string, result: string): string {
  return heading + "\n\n```\n" + truncate(result, 800) + "\n```";
}

// --- Menu-bar helpers (menu_bar / menu_click, formerly inline in chat.ts) ---

/** Keep only branches whose titles contain the keyword (ancestor chain kept,
 *  paths stay valid for menu_click). Returns null when nothing matches. */
export function filterMenu(root: MenuEntry, keyword: string): MenuEntry | null {
  const kw = keyword.toLowerCase();
  const walk = (e: MenuEntry): MenuEntry | null => {
    const children = e.children
      .map(walk)
      .filter((c): c is MenuEntry => c !== null);
    const self = (e.title || "").toLowerCase().includes(kw);
    if (!self && !children.length) return null;
    return { ...e, children: self ? e.children : children };
  };
  return walk(root);
}

/** Render one menu tree level: items with paths + submenu titles. */
export function renderMenu(entry: MenuEntry, prefix: string): string[] {
  return entry.children
    .map((c) => {
      const line = `${prefix}${c.title || c.role} path=[${c.path.join(",")}]${c.children.length ? ` (子菜单 ${c.children.length} 项)` : ""}`;
      return [line, ...renderMenu(c, `${prefix}  `)].filter(Boolean);
    })
    .flat();
}

// --- open_app argument guard (task-sentence paste defense) ---

/** App names are short (网易云音乐=5, TextEdit=8). A longer open_app argument
 *  is almost always the whole task sentence pasted in — return an actionable
 *  refusal so the agent retries with just the name, instead of a confusing
 *  "app not found". Null when the argument looks fine. */
export function openAppArgGuard(target: string): string | null {
  if (target.length <= 24) return null;
  return (
    `⚠️ open_app 的 app 参数异常：收到 ${target.length} 字符（「${target.slice(0, 24)}…」），疑似把完整任务描述传了进来。` +
    `app 参数只填应用名称本身（如「网易云音乐」「TextEdit」）。请用应用名重试，不要粘贴任务说明。`
  );
}

/**
 * Best-effort recovery when a weak model pastes the whole task sentence into
 * open_app's app arg: find the earliest known running app name that appears
 * in the text. Longest names match first ("网易云音乐" wins over "音乐"), and
 * the earliest occurrence wins overall ("打开访达，再开 TextEdit" → 访达).
 * Returns null when nothing known is mentioned — caller should then fail
 * with the guard message instead of guessing.
 */
export function extractAppNameFromLongArg(target: string, knownNames: string[]): string | null {
  const candidates = [...knownNames]
    .filter((n) => n && n.length >= 2)
    .sort((a, b) => b.length - a.length);
  let best: { name: string; index: number } | null = null;
  for (const n of candidates) {
    const idx = target.indexOf(n);
    if (idx < 0) continue;
    if (best === null || idx < best.index) best = { name: n, index: idx };
  }
  return best?.name ?? null;
}
