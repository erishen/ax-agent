import { useState } from "react";
import ChatView from "./ChatView";
import Inspector from "./Inspector";
import { focusSelf, restore, setCompact, setPinned } from "./windowctl";
import "./App.css";

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
  );
}
