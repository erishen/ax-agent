/**
 * Input tools: AX-level clicks/typing/focus plus synthetic coordinates
 * (click_at / double_click_at / drag / right_click_at / scroll) with the
 * per-app click guards and stale-snapshot protection.
 */
import {
  clickAt,
  doubleClickAt,
  drag,
  focusElement,
  performAction,
  pressKey,
  readAttribute,
  rightClickAt,
  scrollAt,
  scrollToVisible,
  setValue,
  typeKeys,
} from "../api.ts";
import { findNodes } from "../tree-utils.ts";
import {
  argStr,
  clampToWindow,
  coordArgs,
  refreshOutline,
  staleObservation,
  nui,
  tui,
  uiKind,
  type ToolResult,
} from "./shared.ts";
import type { SessionState } from "../types.ts";

export async function toolClick(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
  if (state.pid === null) return { result: "尚未选择应用", state };
  const target = findNodes(state.outline, argStr(args, "keyword"))[0];
  if (!target) return { result: `没有找到「${argStr(args, "keyword")}」，先 read_screen`, state };
  if (!target.actions.length) return { result: `元素「${target.label}」不支持动作`, state };
  await performAction(state.pid, target.path, target.actions[0], { role: target.role, label: target.label });
  state = await refreshOutline(state);
  return { result: `已点击「${target.label}」（${target.actions[0]}）。界面大纲已自动更新，无需重复 read_screen。`, state };
}

export async function toolTypeText(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
  if (state.pid === null) return { result: "尚未选择应用", state };
  const field = argStr(args, "field");
  const candidates = field ? findNodes(state.outline, field) : state.outline;
  const target = candidates.find(
    (n) => n.role === "AXTextArea" || n.role === "AXTextField" || n.role === "AXSearchField",
  );
  if (!target) return { result: "没有找到文本输入区", state };
  const prev = await readAttribute(state.pid, target.path, "AXValue").catch(() => null);
  await setValue(state.pid, target.path, argStr(args, "text"), { role: target.role, label: target.label });
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

export async function toolFocus(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
  if (state.pid === null) return { result: "尚未选择应用", state };
  const target = findNodes(state.outline, argStr(args, "keyword"))[0];
  if (!target) return { result: `没有找到「${argStr(args, "keyword")}」`, state };
  await focusElement(state.pid, target.path, { role: target.role, label: target.label });
  return { result: `焦点已给到「${target.label}」`, state };
}

export async function toolKey(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
  const combo = argStr(args, "combo");
  if (!combo) return { result: "缺少 combo 参数（如 enter / esc / Cmd+F）", state };
  await pressKey(combo, state.pid ?? undefined);
  state = await refreshOutline(state);
  return { result: `已按键 ${combo}（发给当前聚焦的元素）。界面如变化，大纲已自动更新。${tui.sortVerifyReminder()}`, state };
}

export async function toolTypeKeys(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
  const stale = staleObservation(state);
  if (stale) return { result: stale, state };
  const text = argStr(args, "text");
  if (!text) return { result: "缺少 text 参数", state };
  await typeKeys(text, state.pid ?? undefined);
  return {
    result: `已逐键输入 ${text.length} 个字符（发给当前聚焦的元素）。如需发送/提交，再按 key enter；如需看到下拉候选，用 find 搜索。`,
    state,
  };
}

export async function toolClickAt(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
  const stale = staleObservation(state);
  if (stale) return { result: stale, state };
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

export async function toolDoubleClickAt(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
  const stale = staleObservation(state);
  if (stale) return { result: stale, state };
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

export async function toolDrag(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
  const stale = staleObservation(state);
  if (stale) return { result: stale, state };
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

export async function toolRightClickAt(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
  const stale = staleObservation(state);
  if (stale) return { result: stale, state };
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

export async function toolScroll(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
  const stale = staleObservation(state);
  if (stale) return { result: stale, state };
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

export async function toolScrollTo(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
  if (state.pid === null) return { result: "尚未选择应用", state };
  const target = findNodes(state.outline, argStr(args, "keyword"))[0];
  if (!target) return { result: `没有找到「${argStr(args, "keyword")}」，先 read_screen`, state };
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
