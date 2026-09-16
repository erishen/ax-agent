/**
 * Observation tools: list_apps, read_screen, wait_for, ocr, find.
 * Pure dispatch implementations — all UI decisions for Tencent Video /
 * NetEase Music live in their UI state machines (tencent-ui / netease-ui).
 */
import {
  desktopToolExec,
  listApps,
  observeWait,
  ocrWindow,
} from "../api";
import type { OcrScreenWord } from "../types";
import { findNodes, findNodesAny, renderOutline } from "../tree-utils";
import { NAV_WORDS, garbledOcrNote, navWordNote, resolveAppMatch } from "../tool-utils";
import {
  argStr,
  markObserved,
  lastReadText,
  recordLastRead,
  nui,
  tui,
  treeOf,
  uiKind,
  type ToolResult,
} from "./shared";
import type { SessionState } from "../types";

export async function toolListApps(state: SessionState, _args: Record<string, unknown>): Promise<ToolResult> {
  const apps = await listApps();
  state = { ...state };
  return {
    result: apps.slice(0, 25).map((a) => `${a.name} (pid ${a.pid})`).join("\n"),
    state,
  };
}

export async function toolReadScreen(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
  const wanted = argStr(args, "app");
  const filter = argStr(args, "filter");
  let pid = state.pid;
  let name = state.appName ?? "";
  if (wanted) {
    const apps = await listApps();
    const hit = resolveAppMatch(apps, wanted);
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
  const last = lastReadText();
  if (last && last.key === key && last.text === summary) {
    result =
      summary +
      "\n（注意：与上一次 read_screen 结果完全相同，界面在这一步没有变化。不要重复读取同一个界面：先用 find 检索当前大纲，或换一个操作推进；交互发生后界面自然会更新。）";
  }
  recordLastRead(key, summary);
  return { result, state: markObserved(state) };
}

export async function toolWaitFor(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
  const keyword = argStr(args, "element");
  const ocrText = argStr(args, "text");
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
        const navWarn = navWordNote(ocrText, gone);
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
  const garbledHint = garbledOcrNote(lastWords);
  return {
    result: `${tail}${navHint}${garbledHint}。当前界面：\n${renderOutline(state.outline) || "（无元素）"}`,
    state,
  };
}

export async function toolOcr(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
  const wanted = argStr(args, "app");
  let pid = state.pid;
  let name = state.appName ?? "";
  if (wanted) {
    const apps = await listApps();
    const hit = resolveAppMatch(apps, wanted);
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
  state = markObserved({ ...state, pid, appName: name });
  if (!words.length) return { result: `${name} 窗口 OCR 未识别到文字（也许是纯图像界面）`, state };
  // The whole Tencent-Video OCR decision (page classification, rating
  // pairing, mini-player detection, all 11 hints, state updates) lives
  // in TencentUiState.processOcr — regression-tested in
  // tests/tencent-ui.test.mjs with the real session word-lists.
  // NetEase CloudMusic routes through NeteaseUiState.processOcr (song
  // pairing + bottom-bar playback evidence) instead.
  const ui = uiKind(name);
  const { joined, hints } =
    ui === "netease" ? nui.processOcr(words) : tui.processOcr(words);
  return {
    result: `${name} 画面文字识别（坐标=屏幕点，可直接 click_at/type_keys）：\n${joined}${hints}`,
    state,
  };
}

export async function toolFind(state: SessionState, args: Record<string, unknown>): Promise<ToolResult> {
  const kw = argStr(args, "keyword");
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
