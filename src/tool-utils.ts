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
