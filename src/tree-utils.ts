// Tree flattening + outline rendering + keyword search — the pure half of
// what chat.ts used to do inline: the model's view of a dumped AX tree.
// Extracted so the rendering/search rules (cap counts, dedupe, Markdown-safe
// lines, case-insensitive matching) are unit-testable without a tree dump.

import { ROLE_INTERACTIVE } from "./agent-config.ts";
import type { OutlineNode } from "./types.ts";
import type { AxNode } from "./types.ts";

/** Flatten a dumped tree into outline nodes, remembering child-index paths. */
export function flatten(root: AxNode): OutlineNode[] {
  const out: OutlineNode[] = [];
  const walk = (node: AxNode, path: number[]) => {
    const value = node.attributes.find((a) => a.name === "AXValue")?.value ?? "";
    out.push({
      path,
      role: node.role,
      label: node.label,
      value,
      actions: node.actions,
    });
    node.children.forEach((child, i) => walk(child, [...path, i]));
  };
  walk(root, []);
  return out;
}

/**
 * Compact human-readable outline for the model: interactive roles first,
 * StaticText heavily capped (WeChat-class apps have hundreds of text nodes).
 */
export function renderOutline(nodes: OutlineNode[]): string {
  const interactive = nodes.filter((n) => ROLE_INTERACTIVE.has(n.role));
  const texts = nodes.filter((n) => n.role === "AXStaticText" && (n.label || n.value));
  const lines = interactive
    .slice(0, 45)
    .map((n) => outlineLine(n));
  // Only show static text that isn't already represented by a labelled
  // interactive element, and cap it hard.
  const seen = new Set(interactive.map((n) => `${n.label}\u0000${n.value}`));
  lines.push(
    ...texts
      .filter((n) => !seen.has(`${n.label}\u0000${n.value}`))
      .slice(0, 15)
      .map((n) => outlineLine(n)),
  );
  const dropped = interactive.length + texts.length - lines.length;
  if (dropped > 0) lines.push(`（其余 ${dropped} 个元素省略；用 find <关键词> 精确检索，或 read_screen filter= 只看某类）`);
  return lines.join("\n");
}

/** One outline line (Markdown-safe: values/actions as inline code). */
export function outlineLine(n: OutlineNode): string {
  const depth = n.path.length > 1 ? `（层级 ${n.path.length}）` : "";
  const value = n.value ? ` = \`${truncate(n.value, 40)}\`` : "";
  const actions = n.actions.length ? ` — \`${n.actions.join(",")}\`` : "";
  return `- ${n.role.replace("AX", "")}「${truncate(n.label, 36)}」${depth}${value}${actions}`;
}

/** Cut long strings for outline lines, always keeping the head. */
export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Case-insensitive keyword match over label/role/value. */
export function findNodes(outline: OutlineNode[], keyword: string): OutlineNode[] {
  const k = keyword.trim().toLowerCase();
  if (!k) return [];
  return outline.filter(
    (n) =>
      n.label.toLowerCase().includes(k) ||
      n.role.toLowerCase().includes(k) ||
      n.value.toLowerCase().includes(k),
  );
}

/** OR-match against several keywords (comma/space separated, e.g. read_screen
 *  filter "按钮 输入框" or "导出, 保存"). */
export function findNodesAny(outline: OutlineNode[], keywords: string[]): OutlineNode[] {
  const ks = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (!ks.length) return [];
  return outline.filter((n) =>
    ks.some(
      (k) =>
        n.label.toLowerCase().includes(k) ||
        n.role.toLowerCase().includes(k) ||
        n.value.toLowerCase().includes(k),
    ),
  );
}
