// Tests for the Finder file-archive feature: the pure classification rules
// (classifyFile / planLine in finder-archive.ts) and the agent policy hooks
// (fs_move confirmation gate + archive discipline in agent-config.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { classifyFile, planLine } from "../src/finder-archive.ts";
import { SYSTEM_PROMPT, dangerousReason } from "../src/agent-config.ts";

test("classifyFile: common extensions map to folders", () => {
  const cases = [
    ["photo.png", "图片", "图片文件"],
    ["截屏2026-09-15.png", "截图", "系统截图"],
    ["Screenshot 2026-09-15 at 10.00.png", "截图", "系统截图"],
    ["report.pdf", "文档", "PDF 文档"],
    ["notes.md", "文档", "Markdown 文档"],
    ["data.xlsx", "表格", "Excel 表格"],
    ["main.rs", "代码", "Rust 源码"],
    ["installer.dmg", "安装包", "macOS 磁盘镜像"],
    ["movie.mp4", "视频", "视频文件"],
    ["song.mp3", "音频", "音频文件"],
  ];
  for (const [name, folder, reason] of cases) {
    const r = classifyFile(name);
    assert.ok(r, `${name} 应有分类`);
    assert.equal(r.folder, folder, name);
    assert.equal(r.reason, reason, name);
  }
});

test("classifyFile: resume / job-search name patterns", () => {
  assert.equal(classifyFile("简历2026.pdf").folder, "求职");
  assert.equal(classifyFile("resume_2026.docx").folder, "求职");
  assert.equal(classifyFile("offer-letter.pdf").folder, "求职");
  // A résumé whose filename has no resume keyword (e.g. "个人简历-final") falls back to 文档 by extension — the LLM sees the
  // scanned names and reclassifies such files semantically in its plan.
  assert.equal(classifyFile("个人简历-final").folder, "文档");
});

test("classifyFile: unknown types and folders return null (LLM decides)", () => {
  assert.equal(classifyFile("randomfile.xyz"), null);
  assert.equal(classifyFile("no-extension-file"), null);
  assert.equal(classifyFile("project-folder", { isDir: true }), null);
});

test("classifyFile: explicit ext wins over the name split", () => {
  // A file named with a weird dot pattern still classifies by its real ext.
  assert.equal(classifyFile("2026.report.pdf", { ext: "pdf" }).folder, "文档");
});

test("dangerousReason: fs_move needs confirmation only when actually moving", () => {
  assert.match(dangerousReason("fs_move", { moves: [], dry_run: false }), /文件移动/);
  // dry-run and missing flag are safe previews
  assert.equal(dangerousReason("fs_move", { moves: [], dry_run: true }), "");
  assert.equal(dangerousReason("fs_move", { moves: [] }), "");
  // other tools unaffected
  assert.equal(dangerousReason("fs_scan", { path: "/tmp" }), "");
});

test("SYSTEM_PROMPT: file-archive discipline (rule 20) is present", () => {
  assert.match(SYSTEM_PROMPT, /文件归档\/整理任务/);
  assert.match(SYSTEM_PROMPT, /fs_move dry_run=true/);
  assert.match(SYSTEM_PROMPT, /永不删除/);
});

test("planLine: dry-run renders a preview arrow, real run renders →", () => {
  const s = { folder: "图片", reason: "图片文件" };
  assert.equal(planLine("a.png", s, "/Users/x/Desktop", true), "a.png →(预演) /Users/x/Desktop/图片/  [图片文件]");
  assert.equal(planLine("a.png", s, "/Users/x/Desktop", false), "a.png → /Users/x/Desktop/图片/  [图片文件]");
});
