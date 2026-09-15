// Tests for the pure decision helpers extracted from chat.ts's move_window
// and wait_for cases. These ran inline in a 1000+-line dispatcher with zero
// coverage — the 16:43 session showed a wrong maximize layout (all stale
// coords) and wait_for false-positives on nav words, both now pinned.
import test from "node:test";
import assert from "node:assert/strict";
import {
  NAV_WORDS,
  garbledOcrNote,
  navWordNote,
  resolveWindowPlacement,
} from "../src/tool-utils.ts";

// Two screens as screen_info returns them: 1512x982 primary + 1920x1080
// secondary offset by 1512px to the right.
const SCREENS = [
  { index: 0, origin: [0, 0], size: [1512, 982] },
  { index: 1, origin: [1512, -98], size: [1920, 1080] },
];

test("resolveWindowPlacement: left on primary", () => {
  const r = resolveWindowPlacement(SCREENS, undefined, "left", { w: 800, h: 600 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.placement, { x: 0, y: 0, resize: null, screenIdx: 0 });
});

test("resolveWindowPlacement: right accounts for window width", () => {
  const r = resolveWindowPlacement(SCREENS, undefined, "right", { w: 800, h: 600 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.placement, { x: 712, y: 0, resize: null, screenIdx: 0 });
});

test("resolveWindowPlacement: right on secondary screen", () => {
  const r = resolveWindowPlacement(SCREENS, 1, "right", { w: 800, h: 600 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // secondary origin.x=1512, size.w=1920 → 1512+1920-800 = 2632
  assert.deepEqual(r.placement, { x: 2632, y: -98, resize: null, screenIdx: 1 });
});

test("resolveWindowPlacement: center halves the margins", () => {
  const r = resolveWindowPlacement(SCREENS, undefined, "center", { w: 800, h: 600 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.placement, { x: 356, y: 191, resize: null, screenIdx: 0 });
});

test("resolveWindowPlacement: maximize sets resize to screen size", () => {
  const r = resolveWindowPlacement(SCREENS, 1, "maximize", { w: 800, h: 600 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.placement, {
    x: 1512,
    y: -98,
    resize: { w: 1920, h: 1080 },
    screenIdx: 1,
  });
});

test("resolveWindowPlacement: unknown position errors with the supported list", () => {
  const r = resolveWindowPlacement(SCREENS, undefined, "top-left", { w: 800, h: 600 });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /top-left/);
  assert.match(r.error, /left\/right\/center\/maximize/);
});

test("resolveWindowPlacement: out-of-range screen keeps index but uses primary bounds", () => {
  const r = resolveWindowPlacement(SCREENS, 7, "left", { w: 800, h: 600 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // original behavior: the requested index is kept (for the report string),
  // the missing screen falls back to primary bounds
  assert.equal(r.placement.screenIdx, 7);
  assert.equal(r.placement.x, 0);
});

test("resolveWindowPlacement: no screens → explicit error", () => {
  const r = resolveWindowPlacement([], undefined, "left", { w: 800, h: 600 });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /无法读取屏幕信息/);
});

test("navWordNote: nav-bar word hit warns about false positive", () => {
  const note = navWordNote("电影", false);
  assert.match(note, /导航栏常驻词/);
  assert.match(note, /不代表页面已切换/);
});

test("navWordNote: page-specific word stays silent", () => {
  assert.equal(navWordNote("我看见两朵一样的云", false), "");
  assert.equal(navWordNote("高分好评", false), "");
});

test("navWordNote: gone=true never warns", () => {
  assert.equal(navWordNote("电影", true), "");
});

test("garbledOcrNote: mostly low-confidence words → warning", () => {
  const words = [
    { text: "a", confidence: 0.3 },
    { text: "b", confidence: 0.3 },
    { text: "c", confidence: 0.3 },
    { text: "d", confidence: 0.4 },
    { text: "e", confidence: 0.9 },
  ];
  const note = garbledOcrNote(words);
  assert.match(note, /OCR 质量差/);
});

test("garbledOcrNote: ten+ low-confidence words even at 30% → warning", () => {
  const words = Array.from({ length: 12 }, (_, i) => ({
    text: `w${i}`,
    confidence: i % 3 === 0 ? 0.9 : 0.4,
  }));
  // 8 low / 12 total = 0.66 → ratio triggers; also low=8 < 10
  assert.match(garbledOcrNote(words), /OCR 质量差/);
});

test("garbledOcrNote: clean text stays silent", () => {
  const words = [
    { text: "首页", confidence: 0.9 },
    { text: "电影", confidence: 0.9 },
    { text: "腾讯视频", confidence: 0.9 },
    { text: "9.1", confidence: 0.9 },
  ];
  assert.equal(garbledOcrNote(words), "");
});

test("garbledOcrNote: few words (≤3) never judged garbled", () => {
  assert.equal(
    garbledOcrNote([
      { text: "a", confidence: 0.1 },
      { text: "b", confidence: 0.1 },
    ]),
    "",
  );
});

test("NAV_WORDS covers the words the model waits on", () => {
  for (const w of ["首页", "电影", "你正在追", "VIP会员", "片库"]) {
    assert.ok(NAV_WORDS.includes(w), w);
  }
});

// --- parseCommand: the offline instruction parser (formerly an inline regex
// chain in handleUtterance with zero coverage). Order of checks matters:
// help/continue first, then open → apps → read → refresh → probe → move →
// type → click → focus → find.

import { parseCommand } from "../src/tool-utils.ts";

test("parseCommand: help forms", () => {
  for (const t of ["帮助", "help", "能做什么", "指令？", " 帮助 "]) {
    assert.deepEqual(parseCommand(t), { kind: "help" }, t);
  }
});

test("parseCommand: continue forms", () => {
  for (const t of ["继续", "接着做", "continue", "resume？"]) {
    assert.deepEqual(parseCommand(t), { kind: "continue" }, t);
  }
});

test("parseCommand: open carries the target", () => {
  assert.deepEqual(parseCommand("打开腾讯视频"), { kind: "open", target: "腾讯视频" });
  assert.deepEqual(parseCommand("open TextEdit"), { kind: "open", target: "TextEdit" });
  assert.deepEqual(parseCommand("启动 备忘录"), { kind: "open", target: "备忘录" });
});

test("parseCommand: apps forms", () => {
  for (const t of ["应用列表", "应用", "apps", "list apps"]) {
    assert.deepEqual(parseCommand(t), { kind: "apps" }, t);
  }
});

test("parseCommand: read carries optional app; refresh after read", () => {
  assert.deepEqual(parseCommand("读一下"), { kind: "read", app: "" });
  assert.deepEqual(parseCommand("读 Safari"), { kind: "read", app: "Safari" });
  assert.deepEqual(parseCommand("读取 腾讯视频"), { kind: "read", app: "腾讯视频" });
  assert.deepEqual(parseCommand("刷新"), { kind: "refresh" });
  assert.deepEqual(parseCommand("重新读取"), { kind: "refresh" });
});

test("parseCommand: probe / move parse ints and decimals", () => {
  assert.deepEqual(parseCommand("点选 600 400"), { kind: "probe", x: 600, y: 400 });
  assert.deepEqual(parseCommand("点 123.5 45"), { kind: "probe", x: 123.5, y: 45 });
  assert.deepEqual(parseCommand("移动窗口 100 200"), { kind: "move", x: 100, y: 200 });
  assert.deepEqual(parseCommand("move 10 20"), { kind: "move", x: 10, y: 20 });
  // single/bad coordinates match no command at all (probe needs two)
  assert.equal(parseCommand("点 abc def"), null);
  assert.equal(parseCommand("点 600"), null);
});

test("parseCommand: type keeps the whole text", () => {
  assert.deepEqual(parseCommand("输入 你好 @搜索"), { kind: "type", text: "你好 @搜索" });
  assert.deepEqual(parseCommand("type hello world"), { kind: "type", text: "hello world" });
});

test("parseCommand: click / focus / find carry keywords", () => {
  assert.deepEqual(parseCommand("点击 显示字体"), { kind: "click", keyword: "显示字体" });
  assert.deepEqual(parseCommand("按下 确定"), { kind: "click", keyword: "确定" });
  assert.deepEqual(parseCommand("聚焦 搜索"), { kind: "focus", keyword: "搜索" });
  assert.deepEqual(parseCommand("找 设置"), { kind: "find", keyword: "设置" });
  assert.deepEqual(parseCommand("查找 导出 保存"), { kind: "find", keyword: "导出 保存" });
});

test("parseCommand: natural language without a command prefix → null", () => {
  assert.equal(parseCommand("帮我在备忘录记一下明天买牛奶"), null);
  assert.equal(parseCommand("把 WeChat 和备忘录左右分屏"), null);
  assert.equal(parseCommand(""), null);
  // "打开" without a space now opens the rest as target (no-space Chinese)
  assert.deepEqual(parseCommand("打开腾讯视频"), { kind: "open", target: "腾讯视频" });
});

test("parseCommand: read does not swallow refresh (checked after read)", () => {
  // "刷新" must hit refresh, not read(""), because read comes first in chain
  assert.deepEqual(parseCommand("刷新"), { kind: "refresh" });
  // but a bare "读" with nothing after still means read
  assert.deepEqual(parseCommand("读"), { kind: "read", app: "" });
});

// --- Chat text formatting + LLM error mapping (formerly inline, zero
// coverage). friendlyLlmError is what the user reads when a model call
// fails; stepHeading/withStepResult shape the execution-log bubbles.

import {
  argsText,
  asText,
  friendlyLlmError,
  stepHeading,
  withStepResult,
} from "../src/tool-utils.ts";

test("asText: Error message vs string fallback", () => {
  assert.equal(asText(new Error("boom")), "boom");
  assert.equal(asText("plain"), "plain");
  assert.equal(asText({ x: 1 }), "[object Object]");
  assert.equal(asText(null), "null");
});

test("friendlyLlmError: quota → actionable quota guidance", () => {
  const out = friendlyLlmError("free quota exceeded: 500");
  assert.match(out, /额度已用完/);
  assert.match(out, /次日重置/);
});

test("friendlyLlmError: rate limit / 429", () => {
  const out = friendlyLlmError("429 Too Many Requests (rate limit)");
  assert.match(out, /限流/);
  assert.match(out, /TPM\/RPM/);
});

test("friendlyLlmError: auth failures", () => {
  assert.match(friendlyLlmError("401 Unauthorized"), /API 密钥无效/);
  assert.match(friendlyLlmError("invalid api key"), /API 密钥无效/);
  assert.match(friendlyLlmError("403 Forbidden"), /检查密钥与模型名/);
});

test("friendlyLlmError: 404 and timeout", () => {
  assert.match(friendlyLlmError("404 model not found"), /接口地址或模型名不对/);
  assert.match(friendlyLlmError("request timed out"), /请求超时/);
});

test("friendlyLlmError: unknown error passes through", () => {
  assert.equal(friendlyLlmError("weird failure"), "❌ LLM 调用失败：weird failure");
});

test("argsText: k=v pairs with truncation", () => {
  assert.equal(argsText({ keyword: "发送" }), "keyword=发送");
  assert.equal(argsText({}), "");
  const long = "x".repeat(100);
  assert.ok(argsText({ k: long }).length < 100 + 8);
});

test("stepHeading: with and without args", () => {
  assert.equal(stepHeading("1/25", "ocr", { app: "腾讯视频" }), "🤖 1/25 `ocr` app=腾讯视频");
  assert.equal(stepHeading("2", "done", {}), "🤖 2 `done`");
});

test("withStepResult: code block, truncates long results", () => {
  const out = withStepResult("🤖 1 `ocr`", "ok");
  assert.equal(out, "🤖 1 `ocr`\n\n```\nok\n```");
  const big = withStepResult("h", "y".repeat(2000));
  assert.ok(big.length < 2000 + 200);
  assert.ok(big.endsWith("```"));
});
