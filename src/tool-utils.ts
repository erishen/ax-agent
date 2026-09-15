// Generic, IO-free decision helpers for the agent frontend. Everything in
// this file is a pure function over plain data — unit-testable without
// mocks, and kept OUT of chat.ts so the 1000+-line dispatcher only holds
// orchestration. Extracted from the move_window / wait_for cases after the
// Tencent state machine move (chat.ts 2451→1888): those two cases held
// window-placement math and OCR-quality judgement that had zero test
// coverage, and the 16:43 session showed a wrong maximize landing layout
// (all old coords stale) and wait_for false-positives on nav words.

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
  | { kind: "open"; target: string }
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
export function parseCommand(input: string): ParsedCommand | null {
  const lower = input.trim().toLowerCase();
  const num = (s: string | undefined) =>
    s !== undefined && s !== "" && Number.isFinite(Number(s)) ? Number(s) : null;
  if (/^(帮助|help|用法|能做什么|指令)[?？]?$/i.test(lower)) return { kind: "help" };
  if (/^(继续|接着做|接着来|continue|go on|resume)[?？]?$/i.test(lower)) return { kind: "continue" };
  const open = input.match(/^(?:打开|启动|open|launch)\s*(.+)$/i);
  if (open) return { kind: "open", target: open[1].trim() };
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
