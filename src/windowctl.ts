/**
 * Window controls for the computer-use session: keep our window on top of the
 * app being driven, shrink it into a compact corner panel, and restore.
 */
import {
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
  availableMonitors,
  currentMonitor,
  primaryMonitor,
  type Monitor,
} from "@tauri-apps/api/window";
import { windowBounds } from "./api.ts";

// `win` is resolved lazily inside each function (not at module top level):
// importing this module must not touch `window`, so the module stays
// importable under node for unit tests and has no import side effects.
/** Compact size (bottom-right corner is set separately). */
const COMPACT = { width: 380, height: 500 };
/** Normal session size (matches tauri.conf.json defaults). */
const NORMAL = { width: 1080, height: 720 };

/** Pin / unpin the window above every other app's windows. */
export async function setPinned(on: boolean): Promise<void> {
  const win = getCurrentWindow();

  await win.setAlwaysOnTop(on);
}

/** Shrink to a compact bottom-right panel; keeps focus so chat stays usable. */
export async function setCompact(): Promise<void> {
  const win = getCurrentWindow();

  await win.setSize(new LogicalSize(COMPACT.width, COMPACT.height));
  const monitor = await primaryMonitor();
  if (monitor) {
    // Monitor size is physical pixels; convert to logical points.
    const scale = monitor.scaleFactor || 1;
    const sw = monitor.size.width / scale;
    const sh = monitor.size.height / scale;
    await win.setPosition(
      new LogicalPosition(sw - COMPACT.width - 12, sh - COMPACT.height - 12),
    );
  }
  await win.setFocus();
}

/** Restore the normal session window (keeps current position). */
export async function restore(): Promise<void> {
  const win = getCurrentWindow();

  await win.setSize(new LogicalSize(NORMAL.width, NORMAL.height));
  await win.setFocus();
}

/** Bring our window back to the front without resizing. */
export async function focusSelf(): Promise<void> {
  const win = getCurrentWindow();

  await win.setFocus();
}

// ---------------------------------------------------------------------------
// Drive mode: while the agent operates another app, get out of the way so the
// target keeps focus and the user can watch it act.
// ---------------------------------------------------------------------------

/** Where the window was before hideAside() moved it (restored by bringBack). */
let saved: { x: number; y: number; w: number; h: number } | null = null;

/**
 * Move our window off the target's way for the duration of an agent task.
 * Parking rule: we must NOT share a screen with the app being driven. The
 * target's main window (`targetPid`) decides which monitor is the work area;
 * we park on a *different* monitor (any). Single monitor → shrink into a
 * corner that does not overlap the target window frame.
 * The window position/size is remembered and restored by [bringBack].
 */
export async function hideAside(targetPid?: number): Promise<void> {
  const win = getCurrentWindow();

  try {
    // Only the FIRST park captures the original frame: hideAside may be called
    // again mid-segment (e.g. open_app learns the target pid) and must not
    // let a parked position become the frame bringBack restores to.
    if (saved === null) {
      const pos = await win.outerPosition();
      const size = await win.outerSize();
      const scale = (await currentMonitor())?.scaleFactor || 1;
      saved = {
        x: pos.x / scale,
        y: pos.y / scale,
        w: size.width / scale,
        h: size.height / scale,
      };
    }

    // Unknown target (segment started before the first open_app): don't
    // shuffle — dropping always-on-top is enough until we learn the pid.
    if (!targetPid || targetPid <= 0) {
      await win.setAlwaysOnTop(false);
      console.log("[drive][hideAside] no target pid yet — parked in place");
      return;
    }

    const monitors = await availableMonitors();
    console.log(
      "[drive][hideAside] monitors:",
      monitors.map((m) => ({
        pos: { x: m.position.x, y: m.position.y },
        size: { x: m.size.width, y: m.size.height },
        scale: m.scaleFactor,
      })),
    );
    const logical = (m: Monitor) => ({
      x: m.position.x / (m.scaleFactor || 1),
      y: m.position.y / (m.scaleFactor || 1),
      w: m.size.width / (m.scaleFactor || 1),
      h: m.size.height / (m.scaleFactor || 1),
      s: m.scaleFactor || 1,
    });

    let targetScreen: Monitor | null = null;
    const within = (r: ReturnType<typeof logical>, cx: number, cy: number) =>
      cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h;
    try {
      const bounds = await windowBounds(targetPid);
      if (bounds) {
        const cx = bounds.x + bounds.w / 2;
        const cy = bounds.y + bounds.h / 2;
        targetScreen =
          monitors.find((m) => within(logical(m), cx, cy)) ?? null;
        console.log(
          `[drive][hideAside] target bounds x=${bounds.x} y=${bounds.y} w=${bounds.w} h=${bounds.h} center=(${cx},${cy}) → screen=${
            targetScreen ? monitors.indexOf(targetScreen) : "NONE"
          }`,
        );
      } else {
        console.log("[drive][hideAside] windowBounds → null (no frame)");
      }
    } catch (e) {
      console.log("[drive][hideAside] windowBounds error:", e);
    }
    if (!targetScreen) {
      // Cannot resolve the target's screen: keep position rather than guess.
      await win.setAlwaysOnTop(false);
      return;
    }

    // Parking screen: any monitor that is NOT the target's screen. Prefer the
    // largest available one so our panel stays useful.
    const work = targetScreen
      ? monitors.filter((m) => m !== targetScreen)
      : monitors.length > 1
        ? monitors.slice(1)
        : [];
    const ordered = [...work].sort(
      (a, b) => b.size.width * b.size.height - a.size.width * a.size.height,
    );
    const park = ordered[0] ?? monitors[0];
    console.log(
      `[drive][hideAside] work screens: ${ordered.map((m) => monitors.indexOf(m)).join(",")}; parking at index ${
        monitors.indexOf(park)
      }${ordered.length > 0 ? " (different screen)" : ""}`,
    );
    if (ordered.length > 0 && park) {
      const r = logical(park);
      await win.setAlwaysOnTop(false);
      await win.setSize(new LogicalSize(Math.min(560, r.w - 24), Math.min(800, r.h - 24)));
      await win.setPosition(new LogicalPosition(r.x + 12, r.y + 12));
      return;
    }

    // Single screen: shrink and pick a corner the target frame does not cover.
    await win.setAlwaysOnTop(false);
    await win.setSize(new LogicalSize(COMPACT.width, COMPACT.height));
    if (park) {
      const r = logical(park);
      const W = COMPACT.width;
      const H = COMPACT.height;
      let t: { x: number; y: number; w: number; h: number } | null = null;
      if (targetPid && targetPid > 0) {
        try {
          t = await windowBounds(targetPid);
        } catch {
          /* ignore */
        }
      }
      const corners = [
        { x: r.x + r.w - W - 12, y: r.y + 12 },
        { x: r.x + 12, y: r.y + 12 },
        { x: r.x + r.w - W - 12, y: r.y + r.h - H - 12 },
        { x: r.x + 12, y: r.y + r.h - H - 12 },
      ];
      const free = pickCorner(corners, t, W, H);
      await win.setPosition(new LogicalPosition(free.x, free.y));
    }
  } catch {
    /* window API unavailable (tests) — drive mode is best-effort */
  }
}

/** Pick the first corner that the target window frame does not cover.
 * `target` is in the same logical coordinate space as `corners`. Exported
 * pure logic so the parking decision is unit-testable. */
export function pickCorner(
  corners: Array<{ x: number; y: number }>,
  target: { x: number; y: number; w: number; h: number } | null,
  W: number,
  H: number,
): { x: number; y: number } {
  return (
    corners.find(
      (c) =>
        !target ||
        c.x + W <= target.x ||
        c.x >= target.x + target.w ||
        c.y + H <= target.y ||
        c.y >= target.y + target.h,
    ) ?? corners[0]
  );
}

/** Restore the window after an agent task: original frame + back to front. */
export async function bringBack(): Promise<void> {
  const win = getCurrentWindow();

  try {
    const s = saved;
    saved = null;
    if (s) {
      await win.setSize(new LogicalSize(s.w, s.h));
      await win.setPosition(new LogicalPosition(s.x, s.y));
    }
    await win.setFocus();
  } catch {
    /* best-effort */
  }
}
