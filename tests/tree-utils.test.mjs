// Tests for the outline rendering + node search pure functions extracted
// from chat.ts. These used to be inline helpers with zero coverage — the
// model's whole view of a tree (cap counts, dedupe, Markdown-safe lines,
// keyword matching) is now pinned here.
import test from "node:test";
import assert from "node:assert/strict";
import {
  findNodes,
  findNodesAny,
  flatten,
  outlineLine,
  renderOutline,
  truncate,
} from "../src/tree-utils.ts";

/** Minimal AxNode-shaped fixture. */
function node(over = {}) {
  return {
    role: "AXButton",
    label: "",
    attributes: [],
    actions: [],
    children: [],
    ...over,
  };
}

test("flatten: keeps child-index paths and reads AXValue", () => {
  const root = node({
    role: "AXWindow",
    label: "窗口",
    children: [
      node({ label: "按钮A", attributes: [{ name: "AXValue", value: "值A" }] }),
      node({
        role: "AXGroup",
        label: "组",
        children: [node({ label: "按钮B", actions: ["AXPress"] })],
      }),
    ],
  });
  const out = flatten(root);
  assert.equal(out.length, 4);
  assert.deepEqual(out[0].path, []);
  assert.deepEqual(out[1].path, [0]);
  assert.equal(out[1].label, "按钮A");
  assert.equal(out[1].value, "值A");
  assert.deepEqual(out[2].path, [1]);
  assert.deepEqual(out[3].path, [1, 0]);
  assert.deepEqual(out[3].actions, ["AXPress"]);
});

test("renderOutline: interactive roles first, then deduped static text", () => {
  const nodes = [
    { path: [0], role: "AXStaticText", label: "标签", value: "", actions: [] },
    { path: [1], role: "AXStaticText", label: "标签", value: "", actions: [] },
    { path: [2], role: "AXButton", label: "确定", value: "", actions: ["AXPress"] },
    { path: [3], role: "AXStaticText", label: "标签", value: "唯一文本", actions: [] },
  ];
  const out = renderOutline(nodes);
  assert.ok(out.indexOf("Button") < out.indexOf("StaticText"), "button first");
  assert.ok(out.includes("确定"));
  // dedupe only drops static text already shown by an interactive element;
  // duplicate static-text rows themselves are kept (original behavior)
  assert.equal((out.match(/「标签」/g) ?? []).length, 3); // two dup rows + the one with value
  assert.ok(out.includes("唯一文本"));
});

test("renderOutline: caps 45 interactive / 15 texts and reports the drop", () => {
  const interactive = Array.from({ length: 50 }, (_, i) => ({
    path: [i],
    role: "AXButton",
    label: `按钮${i}`,
    value: "",
    actions: [],
  }));
  const texts = Array.from({ length: 20 }, (_, i) => ({
    path: [100 + i],
    role: "AXStaticText",
    label: `文本${i}`,
    value: "",
    actions: [],
  }));
  const out = renderOutline([...interactive, ...texts]);
  const lines = out.split("\n");
  const rendered = lines.filter((l) => l.startsWith("- "));
  assert.equal(rendered.length, 60, "45 + 15 caps");
  assert.ok(out.includes("其余 10 个元素省略"));
});

test("renderOutline: empty input renders empty", () => {
  assert.equal(renderOutline([]), "");
});

test("outlineLine: Markdown-safe with depth, value and actions", () => {
  const line = outlineLine({
    path: [0, 1],
    role: "AXTextField",
    label: "搜索框",
    value: "关键词",
    actions: ["AXSetValue"],
  });
  assert.equal(line, '- TextField「搜索框」（层级 2） = `关键词` — `AXSetValue`');
  assert.equal(outlineLine({ path: [0], role: "AXWindow", label: "窗口", value: "", actions: [] }), '- Window「窗口」');
});

test("truncate: keeps head and appends ellipsis", () => {
  assert.equal(truncate("abc", 3), "abc");
  assert.equal(truncate("abcd", 3), "abc…");
  assert.equal(truncate("", 5), "");
});

test("findNodes: case-insensitive match over label/role/value", () => {
  const nodes = [
    { path: [0], role: "AXButton", label: "导出", value: "", actions: [] },
    { path: [1], role: "AXTextField", label: "搜索", value: "Exported", actions: [] },
    { path: [2], role: "AXStaticText", label: "说明", value: "普通", actions: [] },
  ];
  assert.deepEqual(findNodes(nodes, "导出").map((n) => n.label), ["导出"]);
  assert.deepEqual(findNodes(nodes, "exported").map((n) => n.label), ["搜索"]);
  // "text" also hits AXStaticText role — both match by design
  assert.deepEqual(findNodes(nodes, "text").map((n) => n.label), ["搜索", "说明"]);
  assert.deepEqual(findNodes(nodes, "button").map((n) => n.label), ["导出"]);
  assert.deepEqual(findNodes(nodes, "不存在"), []);
  assert.deepEqual(findNodes(nodes, "  "), []);
});

test("findNodesAny: OR-match over comma/space keywords", () => {
  const nodes = [
    { path: [0], role: "AXButton", label: "导出", value: "", actions: [] },
    { path: [1], role: "AXButton", label: "保存", value: "", actions: [] },
    { path: [2], role: "AXStaticText", label: "提示", value: "完成", actions: [] },
  ];
  assert.deepEqual(findNodesAny(nodes, ["导出", "保存"]).map((n) => n.label).sort(), ["保存", "导出"]);
  assert.deepEqual(findNodesAny(nodes, [" 导出 ", " 完成 "]).map((n) => n.label).sort(), ["导出", "提示"]);
  assert.deepEqual(findNodesAny(nodes, []), []);
  assert.deepEqual(findNodesAny(nodes, ["  "]), []);
});
