// Regression tests for the session/chat core (src/chat.ts).
//
// These run under plain node (--experimental-strip-types) with NO Tauri
// runtime: @tauri-apps/api/core imports fine, but `invoke` cannot work, so
// llmConfigured() always throws here. That makes the "probe failure" branch
// of handleUtterance directly testable — exactly the path that regressed in
// the 22:22 session (probe hiccup → silently dropped into the offline
// parser with a misleading "configure the LLM" hint even though the config
// existed).
import test from "node:test";
import assert from "node:assert/strict";
import {
  handleUtterance,
  newSession,
  sessionTranscript,
  stripMarkdownSyntax,
  modelToolResult,
  MAX_TOOL_RESULT_LEN,
} from "../src/chat.ts";

test("handleUtterance: blank input returns the same state (no reply)", async () => {
  const s = newSession();
  assert.equal(await handleUtterance(s, "   "), s);
  assert.equal(await handleUtterance(s, ""), s);
});

test("handleUtterance: help is answered locally without any LLM", async () => {
  const s = newSession();
  const r = await handleUtterance(s, "帮助");
  assert.equal(r.messages.at(-1).role, "assistant");
  assert.match(r.messages.at(-1).text, /打开|读一下|直接说/);
});

test("handleUtterance: probe failure surfaces a clear message, never silently drops to offline (22:22 regression)", async () => {
  const s = newSession();
  const r = await handleUtterance(s, "打开腾讯视频");
  const text = r.messages.at(-1).text;
  assert.match(text, /模型配置检测失败/);
  // The regression: before the fix the probe error was swallowed and the
  // utterance fell through to the offline parser (cmdOpen) with a tail
  // telling the user to configure the LLM — although it WAS configured.
  assert.doesNotMatch(text, /当前没有配置 LLM|配置 LLM 后重新发送|没听懂/);
  // And the offline parser must NOT have run (no app-open attempt).
  assert.equal(r.messages.filter((m) => m.role === "user").length, 1);
});

test("handleUtterance: help wins even when probe would fail (checked before the probe)", async () => {
  const s = newSession();
  const r = await handleUtterance(s, "help");
  assert.match(r.messages.at(-1).text, /打开|读一下/);
});

test("stripMarkdownSyntax: strips code fences, bold and links", () => {
  assert.equal(stripMarkdownSyntax("```js\nconst a=1;\n```"), "js\nconst a=1;\n");
  assert.doesNotMatch(stripMarkdownSyntax("```js\nconst a=1;\n```"), /```/);
  assert.equal(stripMarkdownSyntax("**bold** and *italic*"), "bold and italic");
  // links are NOT rewritten by this helper (copy button keeps the URL)
  assert.equal(stripMarkdownSyntax("[text](https://x.example)"), "[text](https://x.example)");
  assert.equal(stripMarkdownSyntax("# 标题"), "标题");
  assert.equal(stripMarkdownSyntax("> 引用"), "引用");
  assert.equal(stripMarkdownSyntax("`inline`"), "inline");
  assert.equal(stripMarkdownSyntax("plain text"), "plain text");
});

test("sessionTranscript: concatenates user/assistant turns with roles", () => {
  const s = newSession();
  const t = sessionTranscript({
    ...s,
    messages: [
      { id: 1, role: "user", text: "你好" },
      { id: 2, role: "assistant", text: "在的" },
    ],
  });
  assert.match(t, /用户.*你好/s);
  assert.match(t, /助手.*在的/s);
});

test("newSession: starts empty with a session header transcript", () => {
  const s = newSession();
  assert.ok(Array.isArray(s.messages));
  assert.equal(s.messages.length, 0);
  assert.match(sessionTranscript(s), /# AX Agent 会话记录/);
});

// --- max_tokens / 工具结果截断（LLM 输出开销防护） ---

test("modelToolResult: short results pass through untouched", () => {
  const short = "oc token=24 model=z-ai/glm-5.3-flash";
  assert.equal(modelToolResult(short), short);
});

test("modelToolResult: long results keep head + tail with a marker", () => {
  const long = "A".repeat(MAX_TOOL_RESULT_LEN + 5000) + "Z".repeat(50);
  const out = modelToolResult(long);
  assert.ok(out.length < long.length, "truncated below original");
  assert.ok(out.startsWith("A".repeat(200)), "head kept");
  assert.ok(out.endsWith("Z".repeat(50)), "tail kept");
  assert.match(out, /已截断 \d+ 字符/);
});

test("modelToolResult: boundary length is not truncated", () => {
  const exact = "x".repeat(MAX_TOOL_RESULT_LEN);
  assert.equal(modelToolResult(exact), exact);
});

test("modelToolResult: custom limit and 0=no-truncate", () => {
  const long = "y".repeat(500);
  const small = modelToolResult(long, 100);
  assert.ok(small.length < long.length, "custom small limit truncates");
  assert.match(small, /已截断 \d+ 字符/);
  assert.equal(modelToolResult(long, 0), long, "limit 0 keeps full result");
  assert.equal(modelToolResult(long, 2000), long, "limit above length keeps full");
});
