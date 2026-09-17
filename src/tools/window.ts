/**
 * Window tools: move_window / resize_window / element_at / named_action —
 * AX-window-level operations with the pid-level fallback for self-drawn UIs
 * and the semantic-placement resolver from tool-utils.
 */
import {
  desktopToolExec,
  elementAt,
  moveWindowByPid,
  namedAction,
  readAttribute,
  resizeWindow,
  resizeWindowByPid,
  setPosition,
  tracePath,
  windowBounds,
} from "../api.ts";
import { findNodes } from "../tree-utils.ts";
import { resolveWindowPlacement, type ScreenInfo } from "../tool-utils.ts";
import { argStr, refreshOutline, tui, type ToolResult } from "./shared.ts";
import type { SessionState } from "../types.ts";

export async function toolMoveWindow(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    if (state.pid === null) return { result: "尚未选择应用", state };
    const win = state.outline.find((n) => n.role === "AXWindow");
    let x = Number(args.x);
    let y = Number(args.y);
    let resize: { w: number; h: number } | null = null;
    let screenIdx = 0;
    const position = argStr(args, "position");
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
    const maxi = argStr(args, "position") === "maximize";
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

export async function toolResizeWindow(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
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

export async function toolElementAt(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
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

export async function toolNamedAction(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
  if (state.pid === null) return { result: "尚未选择应用", state };
  const target = findNodes(state.outline, argStr(args, "keyword"))[0];
  if (!target) return { result: `没有找到「${argStr(args, "keyword")}」`, state };
  const action = argStr(args, "action") || target.actions[0];
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
