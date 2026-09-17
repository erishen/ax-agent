// B-class hardening: thin-module coverage + transcript redaction.
//
// - redactSensitive / sessionTranscript: credentials and PII must be masked
//   before a session reaches the log or the copy button, while tool-step
//   code blocks stay verbatim for auditability.
// - pickCorner (windowctl): the hideAside parking decision, now a pure fn.
// - examples.ts: localized app-name fallback, name matching, gateway task
//   construction.
// - llm.ts: tool definitions must stay structurally sound (name / description
//   / parameters) — these are what get sent to the model as tool schemas.
import test from "node:test";
import assert from "node:assert/strict";
import { redactSensitive, sessionTranscript } from "../src/chat.ts";
import { pickCorner } from "../src/windowctl.ts";
import {
  appDisplayName,
  matchesName,
  mcpTasks,
  skillTasks,
  toolTasks,
} from "../src/examples.ts";
import { AGENT_TOOLS, DESKTOP_TOOLS, PROFILE_SEARCH_TOOL } from "../src/llm.ts";

// --- redactSensitive: credential / PII masking ------------------------------

test("redactSensitive: masks OpenAI-style tokens", () => {
  assert.equal(redactSensitive("key=sk-tr-acd5ba664b4476f86a78fedf253c854abc79a8c93f912f99"),
    "key=sk-***");
  assert.equal(redactSensitive("Bearer sk-proj-abc123XYZ"), "Bearer sk-***");
});

test("redactSensitive: masks AWS access key ids", () => {
  assert.equal(redactSensitive("AKIAIOSFODNN7EXAMPLE"), "AKIA***");
});

test("redactSensitive: masks key=value / key: value assignments", () => {
  assert.equal(redactSensitive("api_key=O5NA4NQDO6NSH97X"), "api_key=***");
  assert.equal(redactSensitive("token: yZkGI80P4nWlum6sTMevwi2PP2vSVJVRvAPZg1SSYeSLoWuAHneEdj2UFQ=="),
    "token=***");
  assert.equal(redactSensitive("password=\"hunter2-secret\""), "password=***");
  assert.equal(redactSensitive("authorization = abcdefgh12345678"), "authorization=***");
});

test("redactSensitive: masks emails (domain kept) and CN mobiles (head/tail kept)", () => {
  assert.equal(redactSensitive("联系 lei.sun@example.com 或 13812345678"),
    "联系 ***@example.com 或 138****5678");
});

test("redactSensitive: masks CN mobile variants (spaces / dashes / +86 prefix)", () => {
  assert.equal(redactSensitive("138 1234 5678"), "138****5678");
  assert.equal(redactSensitive("138-1234-5678"), "138****5678");
  assert.equal(redactSensitive("+86 138 1234 5678"), "138****5678");
  assert.equal(redactSensitive("电话：+8613812345678"), "电话：138****5678");
  assert.equal(redactSensitive("8613812345678"), "138****5678");
  // 12-digit strings are NOT partial-masked; short numbers stay untouched
  assert.equal(redactSensitive("139123456789"), "139123456789");
  assert.equal(redactSensitive("110"), "110");
  // numeric strings that are not mobiles (dates, ids) are untouched
  assert.equal(redactSensitive("2026-09-17 11-31-41"), "2026-09-17 11-31-41");
  assert.equal(redactSensitive("count=1381234"), "count=1381234");
});

test("redactSensitive: leaves ordinary text untouched", () => {
  const plain = "帮我打开腾讯视频，进入电影频道找评分 9 分以上的片子";
  assert.equal(redactSensitive(plain), plain);
  // short tokens / non-assignment mentions are NOT masked
  assert.equal(redactSensitive("token 是做什么的"), "token 是做什么的");
  assert.equal(redactSensitive("sk-abc"), "sk-abc");
});

test("sessionTranscript: redacts user text but keeps tool-step blocks verbatim", () => {
  const t = sessionTranscript({
    appName: "",
    pid: 0,
    outline: [],
    lastObservedAt: 0,
    messages: [
      { id: 1, role: "user", text: "我的邮箱 a.b@x.cn，key 是 sk-secret1234567890" },
      { id: 2, role: "assistant", text: "🤖 1/3 `ocr`\n```\n「腾讯视频」@(100,100)\n```" },
    ],
  });
  assert.doesNotMatch(t, /a\.b@x\.cn/);
  assert.match(t, /\*\*\*@x\.cn/);
  assert.doesNotMatch(t, /sk-secret1234567890/);
  assert.match(t, /sk-\*\*\*/);
  // the tool-step fence block is preserved verbatim
  assert.match(t, /```\n「腾讯视频」@\(100,100\)\n```/);
});

// --- pickCorner: parking decision ------------------------------------------

test("pickCorner: no target → first corner wins", () => {
  const corners = [
    { x: 10, y: 10 },
    { x: 20, y: 20 },
  ];
  assert.deepEqual(pickCorner(corners, null, 380, 500), corners[0]);
});

test("pickCorner: target covers one corner → the other wins", () => {
  const corners = [
    { x: 0, y: 0 },
    { x: 620, y: 300 },
  ];
  // target overlaps A (panel 0..500 vs target 0..200) but not B (300 >= 200)
  const target = { x: 0, y: 0, w: 1000, h: 200 };
  assert.deepEqual(pickCorner(corners, target, 380, 500), { x: 620, y: 300 });
});

test("pickCorner: full cover → falls back to the first corner", () => {
  const corners = [
    { x: 0, y: 0 },
    { x: 620, y: 300 },
  ];
  const target = { x: 0, y: 0, w: 2000, h: 2000 };
  assert.deepEqual(pickCorner(corners, target, 380, 500), corners[0]);
});

// --- examples.ts: localized names, matching, task construction --------------

test("appDisplayName: falls back to Chinese alias when scan name is ASCII", () => {
  assert.equal(appDisplayName({ name: "Notes", bundle_name: "notes" }), "备忘录");
  assert.equal(appDisplayName({ name: "腾讯视频", bundle_name: "qqlive" }), "腾讯视频");
});

test("appDisplayName: keeps the scan's localized name", () => {
  assert.equal(appDisplayName({ name: "备忘录", bundle_name: "notes" }), "备忘录");
  assert.equal(appDisplayName({ name: "WeChat", bundle_name: "com.tencent.xinWeChat" }), "WeChat");
});

test("matchesName: case-insensitive on bundle and localized name", () => {
  const a = { name: "腾讯视频", bundle_name: "qqlive" };
  assert.equal(matchesName(["QQLive"], a), true);
  assert.equal(matchesName([" 腾讯视频 "], a), true);
  assert.equal(matchesName(["Siri"], a), false);
});

test("skill/tool/mcp tasks: slice to 12 and carry source + name", () => {
  const caps = Array.from({ length: 20 }, (_, i) => ({
    name: `cap${i}`,
    description: `desc ${i} `.repeat(8),
  }));
  const s = skillTasks(caps);
  assert.equal(s.length, 12);
  assert.equal(s[0].source, "hub-skill");
  assert.match(s[0].label, /cap0/);
  const t = toolTasks(caps);
  assert.equal(t.length, 12);
  assert.match(t[0].task, /cap0/);
  assert.match(t[0].task, /备忘录/);
  const m = mcpTasks(caps);
  assert.equal(m.length, 12);
  assert.equal(m[0].source, "hub-mcp");
});

// --- llm.ts: tool-definition structural integrity --------------------------

test("llm tool definitions: name/description non-empty, parameters is an object", () => {
  const all = [...DESKTOP_TOOLS, ...AGENT_TOOLS, PROFILE_SEARCH_TOOL];
  assert.ok(all.length > 10, "tool catalog should be substantial");
  for (const tool of all) {
    assert.ok(tool.name.length > 0, "tool name");
    assert.ok(tool.description.length > 10, `description for ${tool.name}`);
    assert.equal(typeof tool.parameters, "object");
    assert.ok(tool.parameters !== null);
  }
  assert.equal(AGENT_TOOLS.find((t) => t.name === "open_app") !== undefined, true);
  assert.equal(PROFILE_SEARCH_TOOL.name, "profile_search");
});
