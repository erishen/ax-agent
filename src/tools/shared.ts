/**
 * Shared helpers for the per-tool modules (src/tools/*.ts): the ToolResult
 * shape, session-observation bookkeeping, per-app UI decision state, and the
 * few pure helpers the tool implementations all lean on.
 *
 * Moved out of chat.ts so chat.ts (the agent loop) only dispatches, and the
 * tool implementations stay individually testable — same split pattern as
 * src-tauri/src/commands/*.
 */
import { fetchTree, windowBounds } from "../api.ts";
import { flatten } from "../tree-utils.ts";
import type { OutlineNode, SessionState } from "../types.ts";
import { TencentUiState } from "../tencent-ui.ts";
import { NeteaseUiState } from "../netease-ui.ts";

/** Result of executing one tool call: reply text + next session state. */
export type ToolResult = { result: string; state: SessionState; dangerous?: string };

/** 60 s without an ocr / read_screen → coordinate/synthetic actions are blind. */
const STALE_OBSERVATION_MS = 60_000;

export function markObserved(state: SessionState): SessionState {
  return { ...state, lastObservedAt: Date.now() };
}

/** Refusal text when the last observation is missing or too old, else null. */
export function staleObservation(state: SessionState): string | null {
  if (state.lastObservedAt === null) {
    return "⚠️ 还没有任何界面观察快照（未 ocr / read_screen）。坐标与输入类操作是盲操作，请先 ocr 或 read_screen 再继续。";
  }
  const age = Date.now() - state.lastObservedAt;
  if (age > STALE_OBSERVATION_MS) {
    return `⚠️ 界面快照已超过 ${Math.round(age / 1000)}s 未刷新，坐标与输入类盲操作可能已落在过期画面上。请先重新 ocr 或 read_screen，再继续。`;
  }
  return null;
}

/** Last read_screen output (app+pid → text) so an unchanged re-read is flagged. */
let lastRead: { key: string; text: string } | null = null;

export function recordLastRead(key: string, text: string): void {
  lastRead = { key, text };
}

export function lastReadText(): { key: string; text: string } | null {
  return lastRead;
}

export const tui = new TencentUiState();
export const nui = new NeteaseUiState();

/** Which per-app UI decision state a target app uses. NetEase and Tencent
 * are both self-drawn (AX empty) but have different page models; every
 * other app gets no UI hints (the generic ocr/click loop). */
export function uiKind(appName: string | null): "tencent" | "netease" | null {
  if (!appName) return null;
  if (/网易云音乐|netease|163music/i.test(appName)) return "netease";
  if (/腾讯视频|tencent/i.test(appName)) return "tencent";
  return null;
}

/** Dump + flatten the AX tree for a pid. */
export async function treeOf(pid: number, depth: number): Promise<OutlineNode[]> {
  const tree = await fetchTree(pid, depth);
  return flatten(tree);
}

/**
 * Clamp a screen point into the session target's main window frame, so
 * synthetic scroll/click/drag events never land on another app or the
 * desktop when the model guesses out-of-window coordinates. Returns the
 * corrected point plus a human note ("" when unchanged).
 */
export async function clampToWindow(
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
export async function refreshOutline(state: SessionState, depth = 10): Promise<SessionState> {
  if (state.pid === null) return state;
  try {
    return markObserved({ ...state, outline: await treeOf(state.pid, depth) });
  } catch {
    return state;
  }
}

/** Strict numeric x/y arg parsing (null when missing or non-numeric). */
export function coordArgs(args: Record<string, unknown>): { x: number; y: number } | null {
  const x = Number(args.x);
  const y = Number(args.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

export function argStr(args: Record<string, unknown>, k: string): string {
  return typeof args[k] === "string" ? (args[k] as string) : "";
}
