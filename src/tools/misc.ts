/**
 * Misc tools: open_app / menu_bar / menu_click / done / desktop passthrough.
 */
import {
  desktopToolExec,
  listApps,
  memoryAdd,
  menuBar,
  openApp,
  performAction,
} from "../api";
import type { AxAppInfo, OutlineNode } from "../types";
import { renderOutline } from "../tree-utils";
import { extractAppNameFromLongArg, filterMenu, openAppArgGuard, renderMenu } from "../tool-utils";
import { argStr, markObserved, nui, refreshOutline, tui, treeOf, uiKind, type ToolResult } from "./shared";
import { hideAside } from "../windowctl";
import type { SessionState } from "../types";

export async function toolOpenApp(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
  const target = argStr(args, "app");
  const argGuard = openAppArgGuard(target);
  if (argGuard) {
    // 17:21 session: a weak model pasted the whole task sentence into app.
    // If exactly one known running app name appears in it, recover instead
    // of failing the whole task; otherwise surface the guard message.
    const apps = await listApps();
    const hit = extractAppNameFromLongArg(target, apps.map((a) => a.name));
    if (hit) {
      const inner = await doOpenApp(state, hit);
      return {
        ...inner,
        result: `⚠️ open_app 的 app 参数过长（疑似粘贴了任务描述），已自动提取应用名「${hit}」并打开。下次请只传应用名。\n${inner.result}`,
      };
    }
    return { result: argGuard, state };
  }
  return doOpenApp(state, target);
}

async function doOpenApp(state: SessionState, target: string): Promise<ToolResult> {
  const app: AxAppInfo = await openApp(target);
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
  state = markObserved({ ...state, pid: app.pid, appName: app.name, outline });
  if (uiKind(app.name) === "netease") nui.resetForOpenApp();
  else tui.resetForOpenApp();
  // Remember the app across sessions (best-effort, never blocks the reply).
  void memoryAdd(app.name).catch(() => {});
  // First moment the drive target's pid is known: park our window on a
  // screen the target does NOT occupy (the runAgent start may not have
  // known the pid yet when the app was already running).
  void hideAside(app.pid);
  const outlineText = renderOutline(outline);
  return {
    result:
      `已打开 ${app.name} (pid ${app.pid})。界面元素：\n${outlineText || "（未发现常规元素）"}` +
      (outlineText
        ? ""
        : "\n提示：未读到 AX 元素，该应用可能是自绘 UI（如网易云音乐/腾讯视频）。请继续用 ocr 读取屏幕文字，不要在此停步。"),
    state,
  };
}

export async function toolMenuBar(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
  let pid = state.pid;
  const wanted = argStr(args, "app");
  const keyword = argStr(args, "keyword");
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

export async function toolMenuClick(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
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

export async function toolDone(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
  return { result: argStr(args, "summary") || "完成", state };
}

export async function toolDesktop(state: SessionState, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return { result: await desktopToolExec(name, args), state };
}
