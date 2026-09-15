// File-archiving classification rules for the Finder-archive agent flow.
// Pure functions only — no IO, no session state — so the rules are
// unit-testable without mocks (same convention as agent-config.ts).

/** Suggested destination folder for one file, with the reason shown to the user. */
export interface ArchiveSuggestion {
  folder: string;
  reason: string;
}

/** Extension (lowercase, no dot) → destination folder + human reason. */
const EXT_RULES: Record<string, [string, string]> = {
  // Images
  png: ["图片", "图片文件"],
  jpg: ["图片", "图片文件"],
  jpeg: ["图片", "图片文件"],
  gif: ["图片", "图片文件"],
  heic: ["图片", "图片文件"],
  webp: ["图片", "图片文件"],
  svg: ["图片", "图片文件"],
  // Screenshots
  // (detected by name below — this bucket is filled by the name matcher)
  // Documents
  pdf: ["文档", "PDF 文档"],
  docx: ["文档", "Word 文档"],
  doc: ["文档", "Word 文档"],
  md: ["文档", "Markdown 文档"],
  txt: ["文档", "文本文件"],
  pptx: ["文档", "PPT 演示文稿"],
  ppt: ["文档", "PPT 演示文稿"],
  // Spreadsheets
  xlsx: ["表格", "Excel 表格"],
  xls: ["表格", "Excel 表格"],
  csv: ["表格", "CSV 表格"],
  numbers: ["表格", "Numbers 表格"],
  // Code
  ts: ["代码", "TypeScript 源码"],
  tsx: ["代码", "TypeScript 源码"],
  js: ["代码", "JavaScript 源码"],
  jsx: ["代码", "JavaScript 源码"],
  rs: ["代码", "Rust 源码"],
  py: ["代码", "Python 源码"],
  go: ["代码", "Go 源码"],
  java: ["代码", "Java 源码"],
  c: ["代码", "C 源码"],
  cpp: ["代码", "C++ 源码"],
  json: ["代码", "JSON 配置"],
  toml: ["代码", "TOML 配置"],
  yaml: ["代码", "YAML 配置"],
  yml: ["代码", "YAML 配置"],
  sh: ["代码", "Shell 脚本"],
  // Archives / installers
  dmg: ["安装包", "macOS 磁盘镜像"],
  pkg: ["安装包", "macOS 安装包"],
  zip: ["安装包", "压缩包"],
  tar: ["安装包", "压缩包"],
  gz: ["安装包", "压缩包"],
  "7z": ["安装包", "压缩包"],
  rar: ["安装包", "压缩包"],
  // Video / audio
  mp4: ["视频", "视频文件"],
  mov: ["视频", "视频文件"],
  mkv: ["视频", "视频文件"],
  avi: ["视频", "视频文件"],
  mp3: ["音频", "音频文件"],
  m4a: ["音频", "音频文件"],
  wav: ["音频", "音频文件"],
  flac: ["音频", "音频文件"],
  // Fonts
  ttf: ["字体", "字体文件"],
  otf: ["字体", "字体文件"],
};

/** Name patterns (regex, case-insensitive) → destination folder + reason. */
const NAME_RULES: Array<[RegExp, string, string]> = [
  [/^screenshot/i, "截图", "系统截图"],
  [/^截屏/i, "截图", "系统截图"],
  [/^screen shot/i, "截图", "系统截图"],
  [/简历|resume|cv[-_ ]?202/i, "求职", "简历相关"],
  [/^面试|offer|入职/i, "求职", "求职相关"],
  [/^\d{4}-\d{2}-\d{2}/, "按日期归档", "以日期命名"],
];

const EXT_FALLBACK: Record<string, string> = {
  pdf: "文档",
  png: "图片",
  jpg: "图片",
};

/**
 * Suggest a destination folder for one file.
 * Returns null when no rule matches — the LLM should decide (semantic cases
 * like project files) and leave truly unknown files untouched.
 */
export function classifyFile(
  name: string,
  opts: { ext?: string; isDir?: boolean } = {},
): ArchiveSuggestion | null {
  if (opts.isDir) return null; // folders are never auto-classified
  const base = name.toLowerCase();
  for (const [re, folder, reason] of NAME_RULES) {
    if (re.test(base)) return { folder, reason };
  }
  const ext = (opts.ext ?? name.split(".").pop() ?? "").toLowerCase();
  const hit = EXT_RULES[ext];
  if (hit) return { folder: hit[0], reason: hit[1] };
  const fallback = EXT_FALLBACK[ext];
  if (fallback) return { folder: fallback, reason: `${ext.toUpperCase()} 文件` };
  return null;
}

/** Build a one-line human-readable plan item for the confirmation step. */
export function planLine(
  rel: string,
  suggestion: ArchiveSuggestion,
  targetDir: string,
  dryRun: boolean,
): string {
  const arrow = dryRun ? "→(预演)" : "→";
  return `${rel} ${arrow} ${targetDir}/${suggestion.folder}/  [${suggestion.reason}]`;
}
