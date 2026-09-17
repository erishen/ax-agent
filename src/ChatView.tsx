import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  confirmPending,
  handleUtterance,
  newSession,
  requestStop,
  sessionTranscript,
  undoLast,
  type SessionState,
} from "./chat";
import { exampleBatch, type ExampleTask } from "./examples";
import { desktopToolExec } from "./api";
import {
  llmConfigured,
  llmListModels,
  llmSetConfig,
  type LlmConfig,
  type LlmConfigured,
} from "./llm";


/** ⚙️ LLM settings dialog: base URL / key / model + connection test. */
function SettingsModal({
  onClose,
}: {
  onClose: () => void;
}) {
  const [config, setConfig] = useState<LlmConfig | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [statusInfo, setStatusInfo] = useState<LlmConfigured | null>(null);

  // Ref for the effect below (avoids dependency churn).
  const statusInfoRef = useRef<LlmConfigured | null>(null);
  statusInfoRef.current = statusInfo;

  useEffect(() => {
    // Fetch metadata (has_key/base_url/model) without ever receiving the
    // raw api_key — that never crosses the IPC boundary any more.
    llmConfigured()
      .then((info) => {
        setStatusInfo(info);
        setConfig({
          base_url: info.base_url,
          api_key: "",            // never prefilled from saved config
          model: info.model,
          max_tokens: info.max_tokens,
          tool_result_limit: info.tool_result_limit,
        });
      })
      .catch((e) => setStatus(`读取配置失败: ${String(e)}`));
  }, []);

  if (!config) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <p>{status ?? "读取配置中…"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>LLM 设置（OpenAI 兼容）</h2>
        <label>
          API 地址
          <input
            value={config.base_url}
            placeholder="https://api.deepseek.com"
            onChange={(e) => setConfig({ ...config, base_url: e.target.value })}
          />
        </label>
        <label>
          API 密钥
          <input
            type="password"
            value={config.api_key}
            placeholder={statusInfo?.has_key ? "已保存（留空保持不变）" : "sk-…"}
            onChange={(e) => setConfig({ ...config, api_key: e.target.value })}
          />
        </label>
        <label>
          模型
          <input
            value={config.model}
            placeholder="deepseek-chat"
            onChange={(e) => setConfig({ ...config, model: e.target.value })}
          />
        </label>
        <label>
          单次回复上限（tokens，0=不设限）
          <input
            type="number"
            min={0}
            step={256}
            value={config.max_tokens ?? 2048}
            placeholder="2048"
            onChange={(e) =>
              setConfig({ ...config, max_tokens: e.target.value === "" ? 0 : Number(e.target.value) })
            }
          />
        </label>
        <label>
          工具结果截断（字符，0=不截断）
          <input
            type="number"
            min={0}
            step={256}
            value={config.tool_result_limit ?? 2000}
            placeholder="2000"
            onChange={(e) =>
              setConfig({ ...config, tool_result_limit: e.target.value === "" ? 0 : Number(e.target.value) })
            }
          />
        </label>
        {status && <p className="settings-status">{status}</p>}
        <div className="modal-actions">
          <button
            type="button"
            onClick={async () => {
              setStatus("测试中…");
              try {
                const models = await llmListModels(config.base_url, config.api_key);
                setStatus(
                  models.length
                    ? `✅ 连接成功，可用模型（前 5）：${models.slice(0, 5).join(", ")}`
                    : "✅ 连接成功（未返回模型列表）",
                );
              } catch (e) {
                setStatus(`❌ ${e instanceof Error ? e.message : String(e)}`);
              }
            }}
          >
            测试连接
          </button>
          <button
            type="button"
            className="primary"
            onClick={async () => {
              try {
                // Empty key + saved key elsewhere (env/.env) means "keep env".
                if (!config.api_key.trim() && statusInfo?.has_key && statusInfo.source !== "settings") {
                  onClose();
                  return;
                }
                await llmSetConfig(config);
                onClose();
              } catch (e) {
                setStatus(`保存失败: ${e instanceof Error ? e.message : String(e)}`);
              }
            }}
          >
            保存
          </button>
          <button type="button" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * LLM replies sometimes contain raw HTML (<br>, <b>, <p>, <code>, …).
 * react-markdown v10 does NOT parse HTML — the tags stay visible as literal
 * text, which reads as broken formatting. Map the common tags to Markdown
 * and strip everything else (no rehype-raw: we never render raw HTML, so no
 * XSS surface). Applies to prose replies only; tool-step results render
 * inside <pre> and never pass through here.
 */
function normalizeMarkdown(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<strong>/gi, "**")
    .replace(/<\/strong>/gi, "**")
    .replace(/<b>/gi, "**")
    .replace(/<\/b>/gi, "**")
    .replace(/<em>/gi, "*")
    .replace(/<\/em>/gi, "*")
    .replace(/<i>/gi, "*")
    .replace(/<\/i>/gi, "*")
    .replace(/<code>/gi, "`")
    .replace(/<\/code>/gi, "`")
    .replace(/<h([1-6])>/gi, (_m, n: string) => "#".repeat(Number(n)) + " ")
    .replace(/<\/h[1-6]>/gi, "")
    .replace(/<li>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<p>/gi, "\n")
    .replace(/<\/p>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n");
}

/**
 * A tool-step bubble built by withStepResult(): a heading line like
 * `🤖 3/25 \`ocr\` app=腾讯视频` followed by a fenced code block holding the
 * raw tool output. Render it as an execution card (heading + scrollable
 * monospace result) instead of feeding coordinates/JSON through the GFM
 * parser, where stray pipes could look like table syntax.
 */
const STEP_RE = /^(🤖[^\n]*)\n+```\n?([\s\S]*?)```$/;

/** Chat-style session view: the primary way to drive apps. */
export default function ChatView() {
  const [session, setSession] = useState<SessionState>(() => {
    const s = newSession();
    return {
      ...s,
      messages: [
        {
          id: 0,
          role: "assistant",
          text:
            "你好 👋 我是操作助手。直接跟我说要做什么，比如：\n" +
            "· 打开 TextEdit\n" +
            "· 读一下\n" +
            "· 点击 显示字体\n" +
            "· 输入 你好 @编辑区\n\n" +
            "输入「帮助」查看全部指令。",
        },
      ],
    };
  });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [examples, setExamples] = useState<ExampleTask[]>([]);
  const [llmOn, setLlmOn] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const [privacyDismissed, setPrivacyDismissed] = useState(() => {
    try {
      return localStorage.getItem("ax_privacy_seen") === "1";
    } catch {
      return false;
    }
  });
  const scrollRef = useRef<HTMLDivElement>(null);

  // Example tasks: one unified (agent-style) pool; refresh via 🔄 or ⚙️ close.
  const refreshExamples = () => {
    void exampleBatch().then(setExamples).catch(() => setExamples([]));
    void llmConfigured()
      .then((info) => setLlmOn(info.configured))
      .catch(() => setLlmOn(false));
  };
  useEffect(() => {
    refreshExamples();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll to the newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [session.messages, busy]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setBusy(true);
    try {
      // handleUtterance appends the user message itself, then the reply.
      // setSession as onProgress streams each thinking/step/result live.
      const next = await handleUtterance(session, text, setSession);
      setSession(next);
    } finally {
      setBusy(false);
    }
  };

  // Dangerous-operation confirmation: execute the paused tool (or feed the
  // model "user cancelled"), then let the task keep running.
  const confirmAction = async (approve: boolean) => {
    if (!session.pending || busy) return;
    setBusy(true);
    try {
      setSession(await confirmPending(session, approve, setSession));
    } finally {
      setBusy(false);
    }
  };

  // Undo the last reversible mutation (text overwrite / window move).
  const undo = async () => {
    if (!session.undo || busy) return;
    setBusy(true);
    try {
      setSession(await undoLast(session));
    } finally {
      setBusy(false);
    }
  };

  // Copy the whole session as a text transcript (for pasting to another AI).
  const copySession = async () => {
    try {
      const text = sessionTranscript(session);
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Webview clipboard blocked → native clipboard tool.
        await desktopToolExec("clipboard_set", { text });
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const undoIcon = copied ? "✅" : "📋";
  const undoTitle = copied ? "已复制整段会话记录" : "复制会话记录（含所有步骤与结果）";

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scrollRef}>
        {session.messages.map((m, i) => (
          <div key={m.id} className={`chat-row ${m.role}`}>
            <div
              className={`bubble ${m.role}${
                busy && i === session.messages.length - 1 && m.role === "assistant"
                  ? " streaming"
                  : ""
              }`}
            >
              {m.role === "assistant" ? (
                (() => {
                  const step = STEP_RE.exec(m.text);
                  if (step) {
                    // Tool-step execution card: heading line + raw result.
                    return (
                      <div className="step">
                        <div className="step-head">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {normalizeMarkdown(step[1])}
                          </ReactMarkdown>
                        </div>
                        <pre className="step-result">{step[2]}</pre>
                      </div>
                    );
                  }
                  return (
                    <div className="md">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {normalizeMarkdown(m.text)}
                      </ReactMarkdown>
                    </div>
                  );
                })()
              ) : (
                <p>{m.text}</p>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="chat-row assistant">
            <div className="bubble assistant typing">
              正在执行…
              <button
                type="button"
                className="stop-btn"
                onClick={() => requestStop()}
              >
                🛑 停止
              </button>
            </div>
          </div>
        )}
      </div>

      {session.appName && (
        <div className="chat-context">
          当前会话目标：<b>{session.appName}</b>（pid {session.pid}）
        </div>
      )}

      {session.pending && !busy && (
        <div className="prompt-bar">
          <span className="prompt-bar-text">⚠️ 危险操作，请确认：</span>
          <button
            type="button"
            className="primary"
            onClick={() => {
              void confirmAction(true);
            }}
          >
            ✅ 执行
          </button>
          <button
            type="button"
            onClick={() => {
              void confirmAction(false);
            }}
          >
            取消
          </button>
        </div>
      )}

      {llmOn === true && !privacyDismissed && (
        <div className="privacy-notice">
          <span>
            🔒 隐私提示：智能模式会把屏幕上出现的内容（OCR 文字 / AX 树 / 会话）发送到你配置的 LLM
            服务商；完整数据流向与日志位置见 README「隐私与安全」。
          </span>
          <button
            type="button"
            onClick={() => {
              try {
                localStorage.setItem("ax_privacy_seen", "1");
              } catch {
                /* storage unavailable — show again next launch */
              }
              setPrivacyDismissed(true);
            }}
          >
            知道了
          </button>
        </div>
      )}

      {!draft && examples.length > 0 && (
        <div className="chat-examples">
          {llmOn === false && (
            <span className="example-note">未配置 LLM，仅可用快捷指令（点 ⚙️ 配置后解锁完整任务）</span>
          )}
          {examples.map((ex) => (
            <button
              key={ex.task}
              type="button"
              className="example-chip"
              title={`来源：${ex.source} — ${ex.task}`}
              disabled={busy}
              onClick={() => {
                setDraft(ex.task);
              }}
            >
              {ex.label}
            </button>
          ))}
          <button
            type="button"
            className="example-chip refresh"
            title="换一批示例任务"
            disabled={busy}
            onClick={() => {
              void refreshExamples();
            }}
          >
            🔄 换一批
          </button>
        </div>
      )}

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <span className={`agent-badge ${llmOn ? "on" : ""}`} title={llmOn ? "智能模式已启用：直接说目标，我会规划并执行" : "未配置 LLM：仅快捷指令可用（⚙️ 配置）"}>
          {llmOn ? "✨ 智能" : "⛔ 未配置"}
        </span>
        <input
          value={draft}
          placeholder={llmOn === false ? "未配置模型：试试 打开 备忘录 / 读一下 / 帮助" : "随便说：把腾讯视频居中，再在备忘录记一条占位笔记"}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
        />
        <button type="button" className="settings-btn" title="LLM 设置" onClick={() => setShowSettings(true)}>
          ⚙️
        </button>
        <button
          type="button"
          className="settings-btn"
          title={undoTitle}
          disabled={busy}
          onClick={() => {
            void copySession();
          }}
        >
          {undoIcon}
        </button>
        <button
          type="button"
          className="undo-btn"
          title="撤销上一次文本写入 / 窗口移动"
          disabled={busy || !session.undo || !!session.pending}
          onClick={() => {
            void undo();
          }}
        >
          ↩️
        </button>
        <button type="submit" disabled={busy || !draft.trim()}>
          发送
        </button>
      </form>
      {showSettings && (
        <SettingsModal
          onClose={() => {
            setShowSettings(false);
            refreshExamples(); // config may have changed → refresh badge + chips
          }}
        />
      )}
    </div>
  );
}
