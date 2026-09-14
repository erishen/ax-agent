/**
 * Dynamic example tasks for the chips above the chat input.
 *
 * Sources, in priority order:
 *   1. Installed applications (Rust `ax_installed_apps`) — so suggestions
 *      mention apps the user actually has (备忘录, Calculator, …).
 *   2. The tsm-hub gateway catalog (`llm_catalog`) — skills / tools / mcps
 *      become tasks the agent can exercise through the gateway.
 *   3. A small built-in fallback set that always works offline.
 *
 * `exampleBatch()` returns one shuffled batch; calling it again swaps in
 * a different random subset (换一批).
 */
import { installedApps, hubCatalog, listApps, localAppsConfig } from "./api";
import type {
  HubCapability,
  HubCatalog,
  InstalledApp,
  LocalAppsConfig,
} from "./types";

/**
 * Canonical Chinese names for system apps whose CLI-resolved display name can
 * come back English (bare processes don't always get the user's locale). The
 * key is the lowercased bundle name from Info.plist — language-independent.
 */
const ZH_ALIASES: Record<string, string> = {
  notes: "备忘录",
  reminders: "提醒事项",
  calendar: "日历",
  contacts: "通讯录",
  mail: "邮件",
  maps: "地图",
  safari: "Safari 浏览器",
  textedit: "文本编辑",
  stickies: "便笺",
  "quicktime player": "QuickTime 播放器",
  preview: "预览",
  terminal: "终端",
  finder: "访达",
  "app store": "App Store",
  calculator: "计算器",
  "system settings": "系统设置",
  music: "音乐",
  podcasts: "播客",
  news: "新闻",
  stocks: "股市",
  books: "图书",
  "voice memos": "语音备忘录",
  freeform: "无边记",
  weather: "天气",
  clock: "时钟",
  home: "家庭",
  passwords: "密码",
  "activity monitor": "活动监视器",
  "console": "控制台",
  "disk utility": "磁盘工具",
  "screenshot": "截屏",
  "shortcuts": "快捷指令",
  "mission control": "调度中心",
  "siri": "Siri",
  "photo booth": "Photo Booth",
  "qqlive": "腾讯视频",
  "tenvideo": "腾讯视频",
};

/** Task text for an app: localized alias when the scan returned English. */
function appDisplayName(a: InstalledApp): string {
  const alias = ZH_ALIASES[a.bundle_name.toLowerCase()];
  // Prefer the scan's own localized name; alias only when it looks English
  // (pure ASCII) and we have a known Chinese name.
  if (alias && /^[-\w. ()+]*$/.test(a.name)) return alias;
  return a.name;
}

export interface ExampleTask {
  label: string;
  task: string;
  /** Where the suggestion came from (shown as chip tooltip). */
  source: "app" | "hub-skill" | "hub-tool" | "hub-mcp" | "local" | "builtin";
}

/** Fisher–Yates shuffle (copy). */
function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Apps excluded from the installed-app task pool unconditionally: their
 * template tasks (记一条 / 交互演练 / 双窗对比 …) are unhandleable — no
 * creatable or editable surface, camera/system helpers, or pure read-only
 * info feeds — so clicking those chips makes the agent fail or loop.
 *
 * Mirrors the local `apps.hidden` list (kept in code so the filtering holds
 * on any machine and even when the local config is absent); `apps.hidden`
 * remains the extension point for per-machine additions.
 */
const APP_BLOCKLIST = new Set([
  "siri",
  "stocks",
  "tips",
  "news",
  "podcasts",
  "books",
  "weather",
  "photo booth",
  // Self-drawn UIs (no semantic AX labels): generic templates fail on them.
  // Tencent Video ships as QQLive.app; both bundle-name spellings appear in
  // the scan across locales.
  "qqlive",
  "tenvideo",
]);

// ---------------------------------------------------------------------------
// Built-in fallback (no installed-app / gateway data needed)
// ---------------------------------------------------------------------------

const BUILTIN_AGENT: ExampleTask[] = [
  {
    label: "🖥 双应用分屏工作台",
    task:
      "把备忘录窗口放到屏幕左半边 (60, 120)，把 TextEdit 放到右半边 (960, 120)，" +
      "然后分别读取两个界面，各列出最常用的 3 个操作",
    source: "builtin",
  },
  {
    label: "🩺 前台应用全面体检",
    task:
      "找出当前最前台的应用：读取它的完整界面结构，统计按钮和输入框数量，" +
      "列出所有可执行的动作，读出窗口位置和大小，最后给我一份体检报告",
    source: "builtin",
  },
  {
    label: "🗺 屏幕坐标扫描",
    task:
      "从 (200, 200) 开始，横向每隔 400、纵向每隔 300，扫到 (1400, 800)，" +
      "对每个坐标调用 element_at，把结果整理成一张「坐标 → 元素」对照表",
    source: "builtin",
  },
  {
    label: "📋 跨应用搬运并验证",
    task:
      "读取备忘录里最新一条笔记的内容，把它原样写入 TextEdit 的文本区，" +
      "再把 TextEdit 窗口挪到 (800, 300)，最后重新读回两边内容确认一致，不一致就重试",
    source: "builtin",
  },
  {
    label: "🧹 多窗口排队布局",
    task:
      "检查当前所有运行中的应用，把它们可见的窗口按顺序横向排开" +
      "（第一扇窗 (60, 100)，之后每扇右移 520），排完报告最终布局",
    source: "builtin",
  },
  {
    label: "⚔️ 两个应用对比评测",
    task:
      "分别打开 TextEdit 和备忘录，各读一遍界面，对比两者在「快速记一条笔记」" +
      "场景下的优劣（步骤数、可操作元素），给出推荐结论",
    source: "builtin",
  },
];

// ---------------------------------------------------------------------------
// Installed-app × task-template matrix
// ---------------------------------------------------------------------------

/** Templates receive the localized app name; each yields one ExampleTask. */
const APP_TASK_TEMPLATES: Array<(app: string) => ExampleTask> = [
  (app) => ({
    label: `📝 ${app} 记一条`,
    task: `帮我在${app}里新建一条内容：明天上午 10 点开会`,
    source: "app",
  }),
  (app) => ({
    label: `🩺 ${app} 界面审计`,
    task:
      `打开${app}并全面审计：数一数界面上有几类元素（按钮/输入框/复选框…），` +
      `找出所有能执行 AXPress 的元素并按分组列出，最后指出哪个元素最适合作为「新手第一次点击」的目标，说明理由`,
    source: "app",
  }),
  (app) => ({
    label: `🧪 ${app} 交互演练`,
    task:
      `在${app}里完成一次完整的增改查：先找到输入区写入一段文字，` +
      `读取回来确认写入成功，再修改其中一个词，最后把最终内容汇报给我`,
    source: "app",
  }),
  (app) => ({
    label: `📐 ${app} 双窗对比`,
    task:
      `如果${app}已开着一个窗口就再开一个新窗口，把两个窗口分别摆到屏幕左半边和右半边，` +
      `然后逐项报告两扇窗的位置、大小，确认它们不重叠`,
    source: "app",
  }),
  (app) => ({
    label: `🗺 ${app} 全界面扫描`,
    task:
      `打开${app}，用坐标扫描的方式（每 350 点一个采样点，覆盖整个窗口区域）` +
      `摸清它的布局热区，把扫到的元素按角色分类汇总成一张表`,
    source: "app",
  }),
  (app) => ({
    label: `🔁 ${app} 压力小循环`,
    task:
      `对${app}做 3 轮「读界面→执行一个从未执行过的动作→读界面验证变化」的循环，` +
      `每一轮都要确认动作真的生效了；3 轮后总结哪些动作是幂等的、哪些有副作用`,
    source: "app",
  }),
  (app) => ({
    label: `🧭 ${app} 巡检报告`,
    task:
      `检查${app}是否在运行；没开就打开它，等界面加载完把窗口摆到屏幕右侧，` +
      `读取界面生成巡检报告：窗口状态、可操作元素清单、异常项（如空列表、禁用按钮）`,
    source: "app",
  }),
  (app) => ({
    label: `🤝 ${app} 跨应用流水线`,
    task:
      `从${app}界面里读取一段现有文本（没有就先写入一段），` +
      `把它交给 TextEdit 另存一份，然后把两个窗口并排摆好，最后汇报两个应用里的内容是否一致`,
    source: "app",
  }),
];

// ---------------------------------------------------------------------------
// Gateway catalog tasks (skills / tools / mcps)
// ---------------------------------------------------------------------------

function skillTasks(skills: HubCapability[]): ExampleTask[] {
  return skills.slice(0, 12).map((s) => ({
    label: `🧩 技能：${s.name}`,
    task:
      `先加载技能 ${s.name}，读懂它的执行步骤，然后严格按步骤执行；` +
      `如果某个步骤需要在桌面上操作（打开应用、点按钮、输入内容），用界面操作完成它，` +
      `最后汇报每一步的执行结果`,
    source: "hub-skill" as const,
  }));
}

function toolTasks(tools: HubCapability[]): ExampleTask[] {
  return tools.slice(0, 12).map((t) => ({
    label: `🛠 工具：${t.name}`,
    task:
      `用网关工具 ${t.name} 完成一次真实调用，把返回结果写入备忘录新建的笔记里，` +
      `然后把备忘录窗口摆到屏幕左侧方便查看（${t.description.slice(0, 36)}…）`,
    source: "hub-tool" as const,
  }));
}

function mcpTasks(mcps: HubCapability[]): ExampleTask[] {
  return mcps.slice(0, 12).map((m) => ({
    label: `🔌 MCP：${m.name}`,
    task:
      `通过 MCP ${m.name} 发起一次真实调用，把调用结果与你在屏幕上读到的信息做交叉验证，` +
      `给出一致性结论`,
    source: "hub-mcp" as const,
  }));
}

// ---------------------------------------------------------------------------
// Cache + batch assembly
// ---------------------------------------------------------------------------

interface ExampleSources {
  installed: InstalledApp[];
  catalog: HubCatalog | null;
  running: string[];
  local: LocalAppsConfig;
  fetchedAt: number;
}

const EMPTY_LOCAL: LocalAppsConfig = {
  hidden: [],
  pinned: [],
  extra_tasks: [],
  max_apps: null,
};

/** Case-insensitive membership test against a bundle/localized name. */
function matchesName(list: string[], a: InstalledApp): boolean {
  const n = (s: string) => s.trim().toLowerCase();
  return list.some((h) => {
    const v = n(h);
    return v === a.bundle_name.toLowerCase() || v === a.name.toLowerCase();
  });
}

let cache: ExampleSources | null = null;
const CACHE_MS = 5 * 60 * 1000;

/** Fetch sources (5-minute cache); failures degrade to built-ins. */
async function sources(): Promise<ExampleSources> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache;
  const [installed, running, catalog, local] = await Promise.all([
    installedApps().catch(() => [] as InstalledApp[]),
    listApps()
      .then((apps) => apps.filter((a) => !a.is_hidden).map((a) => a.name))
      .catch(() => [] as string[]),
    hubCatalog().catch(() => null),
    localAppsConfig().catch(() => EMPTY_LOCAL),
  ]);
  // Apply local pin/hide + the code-level blocklist. Blocklisted apps never
  // generate template tasks — even when pinned (their templates are
  // unhandleable; hand-written tasks via extra_tasks are unaffected).
  const blocklisted = (a: InstalledApp) =>
    APP_BLOCKLIST.has(a.bundle_name.toLowerCase());
  const pinned = installed.filter(
    (a) => !blocklisted(a) && matchesName(local.pinned, a),
  );
  const rest = installed.filter(
    (a) =>
      !blocklisted(a) &&
      !matchesName(local.hidden, a) &&
      !matchesName(local.pinned, a),
  );
  const ordered = [...pinned, ...rest];
  cache = {
    installed: ordered,
    running,
    catalog,
    local,
    fetchedAt: Date.now(),
  };
  return cache;
}

/** Drop the cache so the next batch re-reads apps + gateway. */
export function invalidateExamples(): void {
  cache = null;
}

const BATCH = 6;

/** Rotates which builtin task occupies the rotating slot (换一批必换任务). */
let builtinCursor = 0;

/** One shuffled batch of example tasks (unified mode; single pool). */
export async function exampleBatch(): Promise<ExampleTask[]> {
  const { installed, running, catalog, local } = await sources();
  // Localized display names (备忘录 not Notes) for task phrasing.
  const displayNames = installed.map(appDisplayName);

  // User-defined tasks from apps.local.json join every batch.
  const extraTasks: ExampleTask[] = local.extra_tasks.map((t) => ({
    label: t.label || t.task.slice(0, 12),
    task: t.task,
    source: "local",
  }));

  // App-derived tasks from the template matrix (capped by max_apps).
  const maxApps = local.max_apps ?? 40;
  const appTasks = displayNames
    .slice(0, maxApps)
    .flatMap((n) => APP_TASK_TEMPLATES.map((t) => t(n)));
  const hubTasks: ExampleTask[] = catalog
    ? [
        ...skillTasks(catalog.skills),
        ...toolTasks(catalog.tools),
        ...mcpTasks(catalog.mcps),
      ]
    : [];
  // Pinned/local tasks and running apps get priority in the batch.
  const prioritized = appTasks.filter((t) =>
    running.some((name) => t.task.includes(name) || displayNames.includes(name)),
  );
  const rest = appTasks.filter((t) => !prioritized.includes(t));
  const tailPool = [
    ...extraTasks,
    ...shuffle(prioritized),
    ...shuffle(rest),
    ...shuffle(hubTasks),
  ];

  // Guaranteed slot for a curated builtin task, rotating every batch so all
  // builtins surface via 换一批 (a slice from the head of tailPool alone is
  // dominated by app-derived chips and would never reach them).
  const rotating = BUILTIN_AGENT[builtinCursor % BUILTIN_AGENT.length];
  builtinCursor += 1;

  // One fixed builtin slot + app/gateway/local tasks for the rest.
  const need = BATCH - 1;
  const tail: ExampleTask[] =
    tailPool.length >= need
      ? tailPool.slice(0, need)
      : tailPool;
  return [rotating, ...tail];
}
