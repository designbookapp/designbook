/**
 * One-time UI notice for deprecated designbook.config fields (config-slim
 * spec): client repos still passing `sets`/`flows`/`sourceModules` keep
 * working this release, but the workbench says so ONCE per session — loud
 * enough to act on, quiet enough to dismiss. The console carries the full
 * migration detail (designbook.ts's warnDeprecatedConfigFields).
 */

import { useState } from "react";
import { configDir, getDeprecatedConfigFields } from "./designbook";

const DISMISS_KEY = `designbook:deprecation-notice:${configDir || "."}`;

function wasDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function DeprecationNotice() {
  const fields = getDeprecatedConfigFields();
  const [dismissed, setDismissed] = useState(wasDismissed);
  if (fields.length === 0 || dismissed) return null;

  function dismiss() {
    setDismissed(true);
    try {
      window.sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Session storage unavailable — in-memory dismiss is enough.
    }
  }

  return (
    <div
      role="status"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 72,
        transform: "translateX(-50%)",
        zIndex: 2147483002,
        maxWidth: 560,
        padding: "10px 14px",
        borderRadius: 10,
        background: "#3a2b0d",
        color: "#ffd88a",
        font: "12px/1.5 system-ui, sans-serif",
        boxShadow: "0 4px 16px rgba(0,0,0,.35)",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
      }}
    >
      <span>
        Deprecated designbook.config field{fields.length > 1 ? "s" : ""}:{" "}
        <code>{fields.join(", ")}</code> — still honored this release, ignored
        in the next. Components are now indexed automatically from your source;
        see the console for migration details.
      </span>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        style={{
          border: "none",
          background: "transparent",
          color: "inherit",
          cursor: "pointer",
          font: "inherit",
          padding: 0,
          lineHeight: 1,
        }}
      >
        ✕
      </button>
    </div>
  );
}

export { DeprecationNotice };
