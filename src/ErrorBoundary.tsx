import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Render error boundary: a crash inside the React tree (bad markdown,
 * illegal state, browser API unavailable in Tauri) must never leave the
 * user staring at a blank window. On error we show a recoverable card with
 * a reset button (remounts the tree) and a copy button for the message.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Also surface on the existing ax:error bus (devtools console) so the
    // event is not lost even though the fallback UI already renders.
    try {
      window.dispatchEvent(
        new CustomEvent("ax:error", {
          detail: `render: ${error.message} @ ${info.componentStack ?? ""}`,
        }),
      );
    } catch {
      /* event bus failure is non-fatal */
    }
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  private copyError = (): void => {
    const { error } = this.state;
    if (!error) return;
    const text = `${error.message ?? String(error)}\n\n${error.stack ?? ""}`;
    try {
      void navigator.clipboard?.writeText(text);
    } catch {
      /* clipboard unavailable — the message is still visible in <pre> */
    }
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="boundary-fallback" role="alert">
        <h2>界面渲染出错</h2>
        <p>
          界面在渲染时发生了错误。先点「重置界面」恢复；若持续出现，复制错误信息反馈。
        </p>
        <pre>{this.state.error.message ?? String(this.state.error)}</pre>
        <div className="boundary-actions">
          <button type="button" onClick={this.reset}>
            重置界面
          </button>
          <button type="button" onClick={this.copyError}>
            复制错误
          </button>
        </div>
      </div>
    );
  }
}
