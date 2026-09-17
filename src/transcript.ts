/**
 * Plain-text session transcript helpers: Markdown downgrade + credential/PII
 * redaction. Kept in their own module so the chat state machine (chat.ts)
 * stays focused and the pure functions are independently unit-tested.
 */
import { STEP_RE } from "./agent-config.ts";

/**
 * Plain-text transcript messages carry the raw Markdown the LLM wrote
 * (**bold**, # headings, `code`, *em*). Inside the app react-markdown
 * renders it, but the copied/pasted transcript and the session log show
 * the literal syntax — that is what "Markdown 展示还不好" referred to.
 * Downgrade the visible markers (keep list dashes and numbering, they
 * read fine in plain text). Tool-step cards (STEP_RE) are skipped.
 */
export function stripMarkdownSyntax(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/``/g, "")
    .replace(/^>\s?/gm, "")
    .replace(/[ \t]+\n/g, "\n");
}

/** Mask credentials / PII that may appear in a transcript before it is
 * written to the session log or copied: OpenAI-style sk- tokens, AWS access
 * key ids, key=value assignments (api_key/token/secret/password/…), email
 * addresses (domain kept) and mainland-China mobile numbers (head/tail kept).
 * Tool-step code blocks are NOT redacted — the log keeps them verbatim for
 * auditability; only user text and assistant prose pass through here.
 * Conservative by design: no semantic PII detection, only well-formed
 * patterns with word boundaries, so ordinary text is never mangled. */
export function redactSensitive(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "sk-***")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA***")
    .replace(
      /\b(api[_-]?key|token|secret|password|passwd|authorization)\b\s*[=:]\s*("?)([A-Za-z0-9_\-./+=]{8,})\2/gi,
      "$1=***",
    )
    .replace(/\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, "***@$2")
    // Mainland-China mobile numbers: bare 11 digits, spaced/dashed variants
    // (138 1234 5678 / 138-1234-5678), and +86 / 86-prefixed forms. Head and
    // tail are kept so the number stays recognizable as a phone. The prefixed
    // rule runs first so the prefix is consumed along with the digits.
    .replace(/(?<![\d.])\+?86[\s-]?(1[3-9]\d)[\s-]?(\d{4})[\s-]?(\d{4})\b/g, "$1****$3")
    .replace(/\b(1[3-9]\d)[\s-]?(\d{4})[\s-]?(\d{4})\b/g, "$1****$3");
}

/** Structural subset of SessionState that sessionTranscript needs — keeps this
 * module free of a chat.ts import cycle (chat.ts imports these helpers). */
export interface TranscriptSource {
  appName?: string | null;
  pid?: number | null;
  messages: Array<{ role: string; text: string }>;
}

/** Render the whole session as plain text — for the 📋 copy button and the log. */
export function sessionTranscript(s: TranscriptSource): string {
  const lines: string[] = [];
  lines.push("# AX Agent 会话记录");
  lines.push(`- 时间：${new Date().toLocaleString("zh-CN")}`);
  if (s.appName) lines.push(`- 目标应用：${s.appName}（pid ${s.pid}）`);
  lines.push("");
  lines.push("---");
  lines.push("");
  for (const m of s.messages) {
    lines.push(`### ${m.role === "user" ? "🧑 用户" : "🤖 助手"}`);
    // Tool-step cards keep their fenced code block verbatim for
    // auditability; prose messages lose the Markdown markers. All non-step
    // text is redacted (credentials / PII) before it reaches the log or the
    // copy button.
    const text =
      m.role === "assistant" && !STEP_RE.test(m.text)
        ? redactSensitive(stripMarkdownSyntax(m.text))
        : m.role === "user"
          ? redactSensitive(m.text)
          : m.text;
    lines.push(text);
    lines.push("");
  }
  return lines.join("\n");
}
