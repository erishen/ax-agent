// Tests for the agent policy module extracted from chat.ts: the static
// constants (SYSTEM_PROMPT, DANGER_WORDS, roles, step budget) and the pure
// decision helpers (dangerousReason, environmentLimitNote). The confirmation
// branches used to live inline in the runTool dispatcher with zero coverage —
// the whole "confirm before irreversible actions" promise now has tests.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTINUE_NUDGE,
  DANGER_WORDS,
  MAX_AGENT_STEPS,
  ROLE_INTERACTIVE,
  STEP_RE,
  SYSTEM_PROMPT,
  dangerousReason,
  environmentLimitNote,
} from "../src/agent-config.ts";

test("dangerousReason: enter/return key needs confirmation", () => {
  assert.match(dangerousReason("key", { combo: "enter" }), /回车键/);
  assert.match(dangerousReason("key", { combo: "return" }), /回车键/);
  assert.match(dangerousReason("key", { combo: "Enter" }), /回车键/);
  assert.equal(dangerousReason("key", { combo: "esc" }), "");
  assert.equal(dangerousReason("key", { combo: "Cmd+F" }), "");
});

test("dangerousReason: irreversible click keywords need confirmation", () => {
  for (const kw of ["删除", "发送", "付款", "提交", "清空聊天", "退出登录", "永久删除"]) {
    assert.match(dangerousReason("click", { keyword: kw }), /不可逆/, kw);
  }
  // window chrome buttons
  assert.match(dangerousReason("click", { keyword: "关闭按钮" }), /系统窗口按钮/);
  assert.match(dangerousReason("click", { keyword: "最小化按钮" }), /系统窗口按钮/);
});

test("dangerousReason: benign click targets stay silent", () => {
  assert.equal(dangerousReason("click", { keyword: "显示字体" }), "");
  assert.equal(dangerousReason("click", { keyword: "下一步" }), "");
  assert.equal(dangerousReason("click", {}), "");
});

test("dangerousReason: named_action / menu_click share the guard", () => {
  assert.match(dangerousReason("named_action", { action: "确认支付" }), /不可逆/);
  assert.match(dangerousReason("menu_click", { keyword: "格式化" }), /不可逆/);
  assert.equal(dangerousReason("named_action", { action: "AXIncrement" }), "");
});

test("dangerousReason: non-interactive tools never ask", () => {
  for (const name of ["ocr", "scroll", "open_app", "wait_for", "find", "done"]) {
    assert.equal(dangerousReason(name, {}), "", name);
  }
});

test("environmentLimitNote: empty missing → no appendix", () => {
  assert.equal(environmentLimitNote([]), "");
});

test("environmentLimitNote: lists each un-granted permission", () => {
  const note = environmentLimitNote(["截图/OCR（屏幕录制未授权…）", "合成键盘 key/type_keys（…）"]);
  assert.match(note, /当前环境限制/);
  assert.match(note, /- 截图\/OCR/);
  assert.match(note, /- 合成键盘/);
});

test("STEP_RE matches the tool-step card format, skips plain text", () => {
  const card = "🤖 1/25 `ocr`\n```\n结果文本\n```";
  assert.ok(STEP_RE.test(card));
  assert.ok(STEP_RE.test("🤖 步骤标题\n```\n```"));
  assert.equal(STEP_RE.test("普通用户消息"), false);
  assert.equal(STEP_RE.test("🤖 无代码块"), false);
});

test("ROLE_INTERACTIVE covers the roles the model clicks/inputs", () => {
  for (const r of ["AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXMenuButton", "AXSlider"]) {
    assert.ok(ROLE_INTERACTIVE.has(r), r);
  }
});

test("DANGER_WORDS covers the confirmation vocabulary", () => {
  for (const w of ["删除", "发送", "付款", "清空", "提交", "格式化"]) {
    assert.ok(DANGER_WORDS.includes(w), w);
  }
});

test("policy constants are present and sane", () => {
  assert.match(SYSTEM_PROMPT, /AX Explorer/);
  assert.match(SYSTEM_PROMPT, /步数是稀缺资源/);
  assert.match(SYSTEM_PROMPT, /画像锚点/);
  assert.equal(MAX_AGENT_STEPS, 25);
  assert.match(CONTINUE_NUDGE, /继续/);
});
