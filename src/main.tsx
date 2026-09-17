import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Global error nets: a desktop agent must never fail silently. Any
// uncaught async rejection or render error is logged AND broadcast as an
// "ax:error" CustomEvent so the UI layer can surface it (ChatView listens).
// Without this, a missed invoke() catch only shows up in the devtools
// console of a packaged app nobody is looking at.
const report = (kind: string, err: unknown, extra?: string) => {
  const detail = `${kind}${extra ? `: ${extra}` : ""}`;
  // eslint-disable-next-line no-console
  console.error(`[ax-agent] ${detail}`, err);
  try {
    window.dispatchEvent(new CustomEvent("ax:error", { detail }));
  } catch {
    /* event bus failure is non-fatal */
  }
};
window.addEventListener("unhandledrejection", (e) => {
  report("unhandledrejection", e.reason);
  e.preventDefault();
});
window.addEventListener("error", (e) => {
  report("error", e.error ?? e.message);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
