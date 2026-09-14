import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  elementAt,
  fetchTree,
  focusElement,
  listApps,
  performAction,
  permissionDiagnostics,
  permissionStatus,
  requestInputMonitoring,
  requestPermission,
  requestScreenRecording,
  screenshotWindow,
  setValue,
  treeJson,
} from "./api";
import type {
  AxAppInfo,
  AxNode,
  PermissionDiagnostics,
  PermissionOverview,
  ScreenshotInfo,
} from "./types";
import ChatView from "./ChatView";
import { focusSelf, restore, setCompact, setPinned } from "./windowctl";
import "./App.css";

/** Testable actuation panel for the selected node (computer-use primitives). */
function Actuator({
  pid,
  node,
  path,
  onDone,
}: {
  pid: number;
  node: AxNode;
  path: number[];
  onDone: (msg: string) => void;
}) {
  const valueAttr = node.attributes.find((a) => a.name === "AXValue");
  const [draft, setDraft] = useState(valueAttr?.value ?? "");
  const [busy, setBusy] = useState(false);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      onDone(`${label} ✓`);
    } catch (e) {
      onDone(`${label} ✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="actuator">
      <h3>操作（computer use）</h3>
      <div className="action-list">
        {node.actions.map((action) => (
          <button
            key={action}
            type="button"
            className="action-btn"
            disabled={busy}
            onClick={() => void run(`执行 ${action}`, () => performAction(pid, path, action))}
          >
            {action}
          </button>
        ))}
      </div>
      <div className="value-row">
        <input
          type="text"
          value={draft}
          placeholder={valueAttr ? `当前: ${valueAttr.value}` : "写入 AXValue…"}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="button"
          disabled={busy || !draft}
          onClick={() => void run("写入 AXValue", () => setValue(pid, path, draft))}
        >
          写入
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run("聚焦元素", () => focusElement(pid, path))}
        >
          聚焦
        </button>
      </div>
      <p className="actuator-hint">
        「聚焦」= 写 AXFocused=true，让该元素拿到键盘焦点（相当于点一下它）；
        「写入」= 写 AXValue，直接替换文本内容（相当于全选后输入，原子生效）。
        都是语义操作，不合成鼠标键盘事件，元素被遮挡也能生效。
      </p>
    </div>
  );
}

/** Collect the child-index path of `target` within `root` (DFS). */
function findPath(root: AxNode, target: AxNode): number[] | null {
  const walk = (node: AxNode, path: number[]): number[] | null => {
    if (node === target) return path;
    for (let i = 0; i < node.children.length; i++) {
      const hit = walk(node.children[i], [...path, i]);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, []);
}

/** A single expandable AX tree node. */
function TreeNode({
  node,
  selected,
  onSelect,
}: {
  node: AxNode;
  selected: AxNode | null;
  onSelect: (node: AxNode) => void;
}) {
  const [open, setOpen] = useState(node.depth < 2);
  const hasChildren = node.children.length > 0;
  const isSel = selected === node;

  return (
    <li className="tree-node">
      <div className={`tree-row ${isSel ? "selected" : ""}`}>
        {hasChildren ? (
          <button
            type="button"
            className="tree-toggle"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "收起" : "展开"}
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="tree-toggle leaf" />
        )}
        <span className="tree-label" onClick={() => onSelect(node)}>
          {node.label}
          {node.role && <em className="tree-role">{node.role}</em>}
        </span>
      </div>
      {open && hasChildren && (
        <ul className="tree-children">
          {node.children.map((child, i) => (
            <TreeNode
              key={i}
              node={child}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Which main view is active. */
function MainView({ tab }: { tab: "chat" | "inspector" }) {
  if (tab === "chat") return <ChatView />;
  return <Inspector />;
}

export default function App() {
  const [tab, setTab] = useState<"chat" | "inspector">("chat");
  const [pinned, setPinnedState] = useState(false);
  const [compact, setCompactState] = useState(false);

  return (
    <div className="shell">
      <nav className="tabbar">
        <button
          type="button"
          className={tab === "chat" ? "active" : ""}
          onClick={() => setTab("chat")}
        >
          💬 会话
        </button>
        <button
          type="button"
          className={tab === "inspector" ? "active" : ""}
          onClick={() => setTab("inspector")}
        >
          🔎 检查器（高级）
        </button>
        <span className="tabbar-spacer" />
        <button
          type="button"
          className={`win-btn ${pinned ? "on" : ""}`}
          title={pinned ? "取消置顶" : "置顶窗口（盖在被操作应用上方）"}
          onClick={() => {
            const next = !pinned;
            setPinnedState(next);
            void setPinned(next);
          }}
        >
          📌 {pinned ? "已置顶" : "置顶"}
        </button>
        {compact ? (
          <button
            type="button"
            className="win-btn"
            title="恢复常规窗口大小"
            onClick={() => {
              setCompactState(false);
              void restore();
            }}
          >
            ⤢ 恢复
          </button>
        ) : (
          <button
            type="button"
            className="win-btn"
            title="缩小成右下角小窗，方便看着被操作的应用"
            onClick={() => {
              setCompactState(true);
              void setCompact();
            }}
          >
            ⤡ 缩小
          </button>
        )}
        <button
          type="button"
          className="win-btn"
          title="把本窗口带到前台"
          onClick={() => void focusSelf()}
        >
          ⌖ 前台
        </button>
      </nav>
      <div className={`tab-body ${compact ? "compact" : ""}`}>
        <MainView tab={tab} />
      </div>
    </div>
  );}

function Inspector() {
  const [trusted, setTrusted] = useState<boolean | null>(null);
  const [apps, setApps] = useState<AxAppInfo[]>([]);
  const [currentPid, setCurrentPid] = useState<number | null>(null);
  const [tree, setTree] = useState<AxNode | null>(null);
  const [selected, setSelected] = useState<AxNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [depth, setDepth] = useState(8);
  const [notice, setNotice] = useState<string | null>(null);
  const [diag, setDiag] = useState<PermissionDiagnostics | null>(null);
  const [perm, setPerm] = useState<PermissionOverview | null>(null);
  const [hit, setHit] = useState<string | null>(null);
  const [shot, setShot] = useState<ScreenshotInfo | null>(null);
  const [hoverRect, setHoverRect] = useState<RectInfo | null>(null);
  const pollRef = useRef<number | null>(null);

  // Initial permission probe +, while untrusted, poll every 1.5 s so the gate
  // clears automatically the moment the checkbox is ticked in System Settings
  // (no app restart needed).
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const s = await permissionStatus();
        if (!cancelled) {
          setTrusted(s.accessibility);
          setPerm(s);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };
    void probe();
    const timer = window.setInterval(probe, 1500);
    pollRef.current = timer;
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // Load the app list once permission is granted.
  useEffect(() => {
    if (trusted) {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      listApps()
        .then(setApps)
        .catch((e) => setError(String(e)));
    }
  }, [trusted]);

  const currentApp = useMemo(
    () => apps.find((a) => a.pid === currentPid) ?? null,
    [apps, currentPid],
  );

  /** Dump the AX tree for the selected app. */
  const loadTree = useCallback(
    async (pid: number, maxDepth: number) => {
      setLoading(true);
      setError(null);
      setSelected(null);
      try {
        const t = await fetchTree(pid, maxDepth);
        setTree(t);
        setCurrentPid(pid);
      } catch (e) {
        setTree(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  /** Re-dump with the current settings (refresh / depth change). */
  const refresh = useCallback(() => {
    if (currentPid !== null) void loadTree(currentPid, depth);
  }, [currentPid, depth, loadTree]);

  /** Trigger the macOS System Settings prompt, then let the poll pick it up. */
  const requestAccess = useCallback(async () => {
    try {
      await requestPermission();
      const d = await permissionDiagnostics();
      setDiag(d);
      setPerm(d.permissions);
      setTrusted(d.trusted);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  /** Trigger the Input Monitoring prompt (synthetic keyboard events). */
  const requestInput = useCallback(async () => {
    try {
      const s = await requestInputMonitoring();
      setPerm(s);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  /** Trigger the Screen Recording prompt (screenshots / OCR). */
  const requestScreen = useCallback(async () => {
    try {
      const s = await requestScreenRecording();
      setPerm(s);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Fetch diagnostics once while the gate is visible.
  useEffect(() => {
    if (trusted === false && diag === null) {
      permissionDiagnostics()
        .then(setDiag)
        .catch(() => setDiag(null));
    }
  }, [trusted, diag]);

  // Auto-clear transient notices.
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(t);
  }, [notice]);

  /** Hit-test: which element sits under this screen point? (computer use) */
  const probeAt = useCallback(async (x: number, y: number) => {
    try {
      const el = await elementAt(x, y);
      setHit(
        `(${Math.round(x)}, ${Math.round(y)}) → ${el.role}` +
          `${el.title ? ` “${el.title}”` : ""}${el.description ? ` · ${el.description}` : ""}` +
          ` · pid ${el.pid}`,
      );
    } catch (e) {
      setHit(`(${Math.round(x)}, ${Math.round(y)}) → ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  /** Dump the whole accessibility tree of the selected app as a JSON file. */
  const exportTree = async () => {
    if (currentPid === null) return;
    try {
      const json = await treeJson(currentPid);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ax-tree-pid${currentPid}-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice(`✅ 已导出 ${currentPid} 的 AX 树 JSON`);
    } catch (e) {
      setNotice(`❌ 导出失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** Parse "{x: 12, y: 34, w: 200, h: 100}" display strings to numbers. */
  const parseGeom = (
    s: string | undefined,
  ): { x: number; y: number; w: number | null; h: number | null } | null => {
    if (!s) return null;
    const x = /x:\s*(-?\d+(?:\.\d+)?)/.exec(s)?.[1];
    const y = /y:\s*(-?\d+(?:\.\d+)?)/.exec(s)?.[1];
    if (x === undefined || y === undefined) return null;
    const w = /w:\s*(-?\d+(?:\.\d+)?)/.exec(s)?.[1];
    const h = /h:\s*(-?\d+(?:\.\d+)?)/.exec(s)?.[1];
    return {
      x: Number(x),
      y: Number(y),
      w: w !== undefined ? Number(w) : null,
      h: h !== undefined ? Number(h) : null,
    };
  };

  /** Element box drawn over the screenshot (window-local coords). */
  interface RectInfo {
    x: number;
    y: number;
    w: number;
    h: number;
    label: string;
    role: string;
  }

  /** Rects translated by the window origin, for the alignment overlay. */
  const rects = useMemo<RectInfo[]>(() => {
    if (!tree || !shot) return [];
    const out: RectInfo[] = [];
    const interactive = /AXButton|AXCheckBox|AXRadioButton|AXTextField|AXTextArea|AXSearchField|AXPopUpButton|AXSlider|AXComboBox|AXTab|AXWindow/;
    const walk = (node: AxNode) => {
      const pos = parseGeom(node.attributes.find((a) => a.name === "AXPosition")?.value);
      const size = parseGeom(node.attributes.find((a) => a.name === "AXSize")?.value);
      if (
        pos &&
        size &&
        size.w !== null &&
        size.h !== null &&
        (interactive.test(node.role) || node.actions.includes("AXPress"))
      ) {
        out.push({
          x: pos.x - shot.position[0],
          y: pos.y - shot.position[1],
          w: size.w,
          h: size.h,
          label: node.label,
          role: node.role,
        });
      }
      node.children.forEach(walk);
    };
    walk(tree);
    return out;
  }, [tree, shot]);

  /** Capture a window screenshot and show AX boxes over it. */
  const captureShot = async () => {
    if (currentPid === null) return;
    try {
      setShot(await screenshotWindow(currentPid));
      setHoverRect(null);
    } catch (e) {
      setNotice(`❌ 截图失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (trusted === false) {
    return (
      <main className="app permission-gate">
        <h1>需要辅助功能权限</h1>
        <p>
          AX Explorer 通过 macOS Accessibility API（AXUIElement）读取其他应用的
          界面结构。请在
          <br />
          <b>系统设置 → 隐私与安全性 → 辅助功能</b>
          <br />
          中允许本应用（开发模式下为终端 / Node 进程）。
        </p>
        <button type="button" onClick={() => void requestAccess()}>
          打开系统设置并重新检查
        </button>
        {perm && (
          <div className="perm-table">
            <p className="diag-hint">当前各项权限状态（1.5s 自动刷新）：</p>
            {[
              {
                key: "accessibility",
                label: "辅助功能",
                desc: "语义读树 / 点击 / 写值 / 坐标点选",
                on: perm.accessibility,
              },
              {
                key: "input_monitoring",
                label: "输入监控",
                desc: "合成键盘（逐键输入、快捷键）",
                on: perm.input_monitoring,
              },
              {
                key: "post_events",
                label: "事件注入",
                desc: "合成鼠标 / 滚动",
                on: perm.post_events,
              },
              {
                key: "screen_recording",
                label: "屏幕录制",
                desc: "截图观察（智能模式视觉通道）",
                on: perm.screen_recording,
              },
            ].map((row) => (
              <div key={row.key} className={`perm-row ${row.on ? "on" : "off"}`}>
                <span className="perm-dot" />
                <span className="perm-label">{row.label}</span>
                <span className="perm-desc">{row.desc}</span>
                <span className="perm-state">{row.on ? "✅ 已授予" : "❌ 未授予"}</span>
                {!row.on && row.key === "input_monitoring" && (
                  <button
                    type="button"
                    className="perm-request"
                    title="打开系统设置 → 隐私与安全性 → 输入监控"
                    onClick={() => void requestInput()}
                  >
                    去授权
                  </button>
                )}
                {!row.on && row.key === "screen_recording" && (
                  <button
                    type="button"
                    className="perm-request"
                    title="打开系统设置 → 隐私与安全性 → 屏幕录制（截图/OCR 需要）"
                    onClick={() => void requestScreen()}
                  >
                    去授权
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {diag && (
          <div className="diag">
            <p className="diag-hint">
              开发模式下，权限授给启动本应用的 App（ responsible process ），
              而不是 ax-explorer 本身。请在辅助功能列表里勾选：
            </p>
            <p className="diag-responsible">
              {diag.responsible
                ? `${diag.responsible.name} (pid ${diag.responsible.pid})`
                : "（无法确定，请检查整条进程链）"}
            </p>
            <details>
              <summary>完整进程链 ({diag.chain.length})</summary>
              <ul>
                {diag.chain.map((p) => (
                  <li key={p.pid}>
                    {p.name} <span className="diag-pid">pid {p.pid}</span>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
        <p className="diag-waiting">已开启自动检测：勾选后本页会在几秒内自动进入应用…</p>
        {error && <p className="error">{error}</p>}
      </main>
    );
  }

  return (
    <main className="app">
      {perm && !perm.screen_recording && (
        <div className="perm-banner">
          ⚠️ 未授予「屏幕录制」权限：截图 / OCR（自绘 UI 阅读）不可用。
          <button
            type="button"
            onClick={() => void requestScreen()}
            title="打开系统设置 → 隐私与安全性 → 屏幕录制"
          >
            去授权
          </button>
        </div>
      )}
      {perm && perm.screen_recording && !perm.input_monitoring && (
        <div className="perm-banner">
          ⚠️ 未授予「输入监控」权限：合成键盘（逐键输入 / 快捷键）不可用。
          <button
            type="button"
            onClick={() => void requestInput()}
            title="打开系统设置 → 隐私与安全性 → 输入监控"
          >
            去授权
          </button>
        </div>
      )}
      <header className="toolbar">
        <h1>AX Explorer</h1>
        <select
          value={currentPid ?? ""}
          onChange={(e) => {
            const pid = Number(e.target.value);
            if (pid > 0) void loadTree(pid, depth);
          }}
        >
          <option value="" disabled>
            选择应用…
          </option>
          {apps.map((app) => (
            <option key={app.pid} value={app.pid}>
              {app.name} (pid {app.pid})
            </option>
          ))}
        </select>
        <label className="depth-label">
          深度
          <input
            type="number"
            min={1}
            max={16}
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value) || 8)}
          />
        </label>
        <button type="button" onClick={refresh} disabled={currentPid === null || loading}>
          {loading ? "读取中…" : "刷新"}
        </button>
        <button type="button" onClick={() => void exportTree()} disabled={currentPid === null} title="导出当前应用的完整 AX 树为 JSON（含路径与坐标）">
          导出 JSON
        </button>
        <button type="button" onClick={() => void captureShot()} disabled={currentPid === null} title="截取当前应用主窗口，把 AX 元素框画在截图上校验坐标对齐">
          截图对齐
        </button>
        <label className="depth-label">
          点选
          <input
            type="number"
            placeholder="x"
            style={{ width: 64 }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const x = Number((e.target as HTMLInputElement).value);
              const yInput = (e.target as HTMLInputElement)
                .closest(".toolbar")
                ?.querySelector<HTMLInputElement>("input[placeholder='y']");
              if (yInput && Number.isFinite(x)) void probeAt(x, Number(yInput.value) || 0);
            }}
          />
          <input
            type="number"
            placeholder="y"
            style={{ width: 64 }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const y = Number((e.target as HTMLInputElement).value);
              const xInput = (e.target as HTMLInputElement)
                .closest(".toolbar")
                ?.querySelector<HTMLInputElement>("input[placeholder='x']");
              if (xInput && Number.isFinite(y)) void probeAt(Number(xInput.value) || 0, y);
            }}
          />
        </label>
      </header>
      {hit && <div className="hit-banner">🔍 {hit}</div>}

      {error && <div className="error banner">{error}</div>}

      <section className="content">
        <div className="tree-pane">
          {tree ? (
            <ul className="tree-root">
              <TreeNode node={tree} selected={selected} onSelect={setSelected} />
            </ul>
          ) : (
            <p className="placeholder">
              {loading
                ? "正在读取辅助功能树…"
                : "从上方选择一个应用开始探索其 Accessibility 树"}
            </p>
          )}
        </div>

        <aside className="detail-pane">
          {selected && tree && currentPid !== null ? (
            <>
              <h2>
                {selected.label}
                {selected.role && <em className="tree-role">{selected.role}</em>}
              </h2>
              <h3>属性 ({selected.attributes.length})</h3>
              <table className="attr-table">
                <tbody>
                  {selected.attributes.map((attr) => (
                    <tr key={attr.name}>
                      <td className="attr-name">{attr.name}</td>
                      <td className="attr-value">{attr.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Actuator
                pid={currentPid}
                node={selected}
                path={findPath(tree, selected) ?? []}
                onDone={setNotice}
              />
            </>
          ) : (
            <p className="placeholder">点击树中的节点查看属性与操作</p>
          )}
        </aside>
      </section>

      {shot && (
        <section className="shot-pane">
          <div className="shot-head">
            <b>
              窗口截图 pid {shot.pid}（窗口号 {shot.window_id} · {shot.size[0]}×{shot.size[1]}pt）
            </b>
            <span className="shot-hint">AX 框以窗口原点绘制；格子颜色越亮 = 更深的嵌套元素</span>
            <button type="button" onClick={() => setShot(null)}>
              关闭
            </button>
          </div>
          <div className="shot-canvas" style={{ width: shot.size[0], height: shot.size[1] }}>
            <img
              src={shot.image}
              alt="窗口截图"
              style={{ width: shot.size[0], height: shot.size[1] }}
            />
            {rects.map((r, i) => (
              <div
                key={i}
                className="shot-rect"
                style={{
                  left: r.x,
                  top: r.y,
                  width: r.w,
                  height: r.h,
                }}
                title={`${r.role}「${r.label}」 (${Math.round(r.x + shot.position[0])}, ${Math.round(r.y + shot.position[1])})`}
                onMouseEnter={() => setHoverRect(r)}
                onMouseLeave={() => setHoverRect(null)}
              />
            ))}
            {hoverRect && (
              <div
                className="shot-rect selected"
                style={{
                  left: hoverRect.x,
                  top: hoverRect.y,
                  width: hoverRect.w,
                  height: hoverRect.h,
                }}
              />
            )}
          </div>
          {hoverRect && (
            <p className="shot-hover">
              {hoverRect.role}「{hoverRect.label}」 → 全局坐标 ({Math.round(hoverRect.x + shot.position[0])},{" "}
              {Math.round(hoverRect.y + shot.position[1])}) / {Math.round(hoverRect.w)}×
              {Math.round(hoverRect.h)}
            </p>
          )}
        </section>
      )}

      <footer className="statusbar">
        <span>
          {currentApp
            ? `${currentApp.name} · pid ${currentApp.pid} · ${currentApp.bundle_id || "无 bundle id"}`
            : "未选择应用"}
        </span>
        <span>{selected ? `已选中: ${selected.role || "(无 role)"}` : ""}</span>
        {notice && <span className="notice">{notice}</span>}
      </footer>
    </main>
  );
}
