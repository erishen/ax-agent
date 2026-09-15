/** Attribute row attached to a tree node (serialized from Rust `AxAttr`). */
export interface AxAttr {
  name: string;
  value: string;
}

/** One node of the accessibility tree (serialized from Rust `AxNode`). */
export interface AxNode {
  label: string;
  role: string;
  depth: number;
  attributes: AxAttr[];
  actions: string[];
  children: AxNode[];
}

/** Summary of a GUI application (serialized from Rust `AxAppInfo`). */
export interface AxAppInfo {
  pid: number;
  name: string;
  bundle_id: string;
  is_active: boolean;
  is_hidden: boolean;
}

/** Per-category macOS privacy permission state. */
export interface PermissionOverview {
  /** Accessibility (AX): semantic reads/writes + screen hit-tests. */
  accessibility: boolean;
  /** Input Monitoring (CG): synthetic keyboard events. */
  input_monitoring: boolean;
  /** Post Events (CG): synthetic mouse / scroll events. */
  post_events: boolean;
  /** Screen Recording (CG): screenshots for the observe loop. */
  screen_recording: boolean;
}

/** Permission query result (serialized from Rust `PermissionOverview`). */
export interface PermissionStatus extends PermissionOverview {}

/** One process in the ancestor chain of the ax-explorer process. */
export interface ProcessChainEntry {
  pid: number;
  name: string;
}

/** Diagnostics for the "why am I still untrusted" case (dev-mode grants). */
export interface PermissionDiagnostics {
  trusted: boolean;
  /** Per-category permission status (Accessibility / Input Monitoring / …). */
  permissions: PermissionOverview;
  /** App the grant applies to in dev mode (outermost non-launchd ancestor). */
  responsible: ProcessChainEntry | null;
  /** Ancestor chain of this process, self first. */
  chain: ProcessChainEntry[];
}

/** Element found under a screen point (computer-use hit-test). */
export interface HitElement {
  pid: number;
  role: string;
  title: string;
  description: string;
}

/** One app-window screenshot plus its global AX frame (alignment overlay). */
export interface ScreenshotInfo {
  pid: number;
  window_id: number;
  /** Global top-left corner in points (matches AXPosition). */
  position: [number, number];
  /** Window size in points (matches AXSize). */
  size: [number, number];
  /** PNG as a base64 data URL. */
  image: string;
}

/** One OCR'd text span mapped to *screen* coordinates (points, top-left). */
export interface OcrScreenWord {
  text: string;
  confidence: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An installed (not necessarily running) application on disk. */
export interface InstalledApp {
  /** Localized display name (备忘录 on a zh-CN system, Notes on en). */
  name: string;
  /** Language-independent bundle name from Info.plist (e.g. Notes). */
  bundle_name: string;
  /** CFBundleIdentifier (e.g. com.apple.Notes) — locale-proof launch key. */
  bundle_id: string;
  path: string;
}

/** One entry of the tsm-hub gateway capability catalog. */
export interface HubCapability {
  name: string;
  description: string;
}

/** Gateway tools/skills/mcps, fetched to generate example tasks. */
export interface HubCatalog {
  tools: HubCapability[];
  skills: HubCapability[];
  mcps: HubCapability[];
}

/** Local overrides from gitignored apps.local.json (see apps.local.example.json). */
export interface LocalAppsConfig {
  /** Bundles/names that never appear in example tasks. */
  hidden: string[];
  /** Bundles/names forced to the front of example tasks. */
  pinned: string[];
  /** User-defined example tasks (label optional). */
  extra_tasks: Array<{ label: string; task: string }>;
  /** Cap on how many installed apps feed the template matrix. */
  max_apps: number | null;
}

/** An outline node: what we keep so keywords can address real elements. */
export interface OutlineNode {
  path: number[];
  role: string;
  label: string;
  value: string;
  actions: string[];
}
