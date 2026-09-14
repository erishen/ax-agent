/**
 * Thin wrappers over the Rust AX commands.
 *
 * Element addresses: AXUIElement handles cannot be persisted across IPC calls,
 * so actions target an element by the path of child indices (from the app root)
 * captured while the tree was dumped. See `ax_perform_action` in src-tauri.
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  AxAppInfo,
  AxNode,
  HitElement,
  ScreenshotInfo,
  OcrScreenWord,
  HubCatalog,
  InstalledApp,
  LocalAppsConfig,
  PermissionDiagnostics,
  PermissionStatus,
} from "./types";

/** Launch (or focus) an app by name; returns the resolved app + pid. */
export function openApp(target: string): Promise<AxAppInfo> {
  return invoke("ax_open_app", { target });
}

export function permissionStatus(): Promise<PermissionStatus> {
  return invoke("ax_permission_status");
}

export function requestPermission(): Promise<PermissionStatus> {
  return invoke("ax_request_permission");
}

/** Prompt System Settings → Privacy & Security → Input Monitoring. */
export function requestInputMonitoring(): Promise<PermissionStatus> {
  return invoke("ax_request_input_monitoring");
}

/** Prompt the Screen Recording permission dialog (screenshots / OCR). */
export function requestScreenRecording(): Promise<PermissionStatus> {
  return invoke("ax_request_screen_recording");
}

/** Process chain + responsible app: shows WHICH app must be ticked in dev. */
export function permissionDiagnostics(): Promise<PermissionDiagnostics> {
  return invoke("ax_permission_diagnostics");
}

export function listApps(): Promise<AxAppInfo[]> {
  return invoke("ax_list_apps");
}

export function fetchTree(pid: number, depth = 8): Promise<AxNode> {
  return invoke("ax_tree", { pid, depth });
}

export function performAction(
  pid: number,
  path: number[],
  action: string,
): Promise<void> {
  return invoke("ax_perform_action", { pid, path, action });
}

// --- Computer-use actuation (ax_act.rs) ---

/** Write text into the element's AXValue (semantic "typing"). */
export function setValue(
  pid: number,
  path: number[],
  text: string,
): Promise<void> {
  return invoke("ax_set_value", { pid, path, text });
}

/** Grab keyboard focus (AXFocused = true). */
export function focusElement(pid: number, path: number[]): Promise<void> {
  return invoke("ax_focus_element", { pid, path });
}

/** Move an element (window) via AXPosition. */
export function setPosition(
  pid: number,
  path: number[],
  x: number,
  y: number,
): Promise<void> {
  return invoke("ax_set_position", { pid, path, x, y });
}

/** Which element is under this global screen point (any app)? */
export function elementAt(x: number, y: number): Promise<HitElement> {
  return invoke("ax_element_at", { x, y });
}

/** Reverse hit-test: element under the point + its child-index path. */
export function tracePath(x: number, y: number): Promise<{ pid: number; path: number[] }> {
  return invoke("ax_trace_path", { x, y });
}

/** Full accessibility tree of `pid` as pretty JSON. */
export function treeJson(pid: number): Promise<string> {
  return invoke("ax_tree_json", { pid });
}

/** Window screenshot for the AX↔pixel alignment overlay. */
export function screenshotWindow(pid: number): Promise<ScreenshotInfo> {
  return invoke("ax_screenshot_window", { pid });
}

/** OCR the app's main window; every text span with screen coordinates. */
export function ocrWindow(pid: number): Promise<OcrScreenWord[]> {
  return invoke("ax_ocr_window", { pid });
}

/** Main on-screen window frame of `pid` in screen points (top-left origin). */
export function windowBounds(pid: number): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return invoke("ax_window_bounds", { pid });
}

/** Read one display attribute of the element at `path` as a string. */
export function readAttribute(
  pid: number,
  path: number[],
  attr: string,
): Promise<string | null> {
  return invoke("ax_read_attribute", { pid, path, attr });
}

/** Synthetic scroll-wheel event at a global screen point (lines<0 = down). */
export function scrollAt(x: number, y: number, lines: number, pid?: number): Promise<void> {
  return invoke("ax_scroll", { x, y, lines, pid: pid ?? null });
}

/** Ask the app to scroll the element at `path` into view (AXScrollToVisible). */
export function scrollToVisible(pid: number, path: number[]): Promise<void> {
  return invoke("ax_scroll_to_visible", { pid, path });
}

/** Perform an arbitrary named AX action (AXIncrement, AXPick, AXShowMenu…). */
export function namedAction(
  pid: number,
  path: number[],
  action: string,
): Promise<void> {
  return invoke("ax_named_action", { pid, path, action });
}

/** Press a key/shortcut (synthetic keyboard): "enter", "Cmd+F", "Alt+Left". */
export function pressKey(combo: string, pid?: number): Promise<void> {
  return invoke("ax_key", { combo, pid: pid ?? null });
}

/** Type text as per-key synthetic keyboard events (Chinese/emoji OK). */
export function typeKeys(text: string, pid?: number): Promise<void> {
  return invoke("ax_type_keys", { text, pid: pid ?? null });
}

/** Left single-click at a global screen point (synthetic mouse). */
export function clickAt(x: number, y: number, pid?: number): Promise<void> {
  return invoke("ax_click", { x, y, pid: pid ?? null });
}

/** Left double-click at a global screen point. */
export function doubleClickAt(x: number, y: number, pid?: number): Promise<void> {
  return invoke("ax_double_click", { x, y, pid: pid ?? null });
}

/** Drag from one global screen point to another (interpolated path). */
export function drag(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  steps?: number,
  pid?: number,
): Promise<void> {
  return invoke("ax_drag", { fromX, fromY, toX, toY, steps, pid: pid ?? null });
}

/** Right-click at a global screen point (context menu; frontmost app only). */
export function rightClickAt(x: number, y: number, pid?: number): Promise<void> {
  return invoke("ax_right_click", { x, y, pid: pid ?? null });
}

/** One menu-bar entry, addressed by its child-index path. */
export interface MenuEntry {
  title: string;
  role: string;
  path: number[];
  actions: string[];
  children: MenuEntry[];
}

/** Read the menu bar of `pid` (default: frontmost app), path-addressed. */
export function menuBar(pid?: number, depth?: number): Promise<MenuEntry> {
  return invoke("ax_menu_bar", { pid, depth });
}

// --- Example-task sources ---

/** Installed .app bundles from the standard macOS app directories. */
export function installedApps(): Promise<InstalledApp[]> {
  return invoke("ax_installed_apps");
}

/** Local overrides from gitignored apps.local.json (pin/hide/custom tasks). */
export function localAppsConfig(): Promise<LocalAppsConfig> {
  return invoke("ax_local_apps_config");
}

/** Gateway tools/skills/mcps catalog (best-effort; empty sections on failure). */
export function hubCatalog(): Promise<HubCatalog> {
  return invoke("llm_catalog");
}

// --- Local desktop tools + local MCP (capabilities tsm-hub doesn't have) ---

/** One local desktop tool (name matches the agent tool schema). */
export interface DesktopTool {
  name: string;
  description: string;
}

export function desktopToolCatalog(): Promise<DesktopTool[]> {
  return invoke("desktop_tool_catalog");
}

/** Execute a local desktop tool; errors come back as "error: …" text. */
export function desktopToolExec(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  return invoke("desktop_tool_exec", { name, args });
}

/** One MCP tool exposed by a local server (mcp.local.json), namespaced server.tool. */
export interface McpLocalTool {
  name: string;
  description: string;
  parameters: unknown;
}

export function mcpLocalTools(): Promise<McpLocalTool[]> {
  return invoke("mcp_local_tools");
}

export function mcpLocalCall(
  qualified: string,
  args: Record<string, unknown>,
): Promise<string> {
  return invoke("mcp_local_call", { qualified, args });
}
