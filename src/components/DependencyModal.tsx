import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type DependencyInfo } from "../hooks/useDependencies";

interface Props {
  dep: DependencyInfo;
  feature: string;
  onDismiss: () => void;
  onRecheck: () => void;
}

function getPlatform(): "macos" | "windows" | "linux" {
  const p = navigator.platform.toLowerCase();
  if (p.includes("mac")) return "macos";
  if (p.includes("win")) return "windows";
  return "linux";
}

function getPlatformLabel(platform: "macos" | "windows" | "linux"): string {
  if (platform === "macos") return "macOS";
  if (platform === "windows") return "Windows";
  return "Linux";
}

export function DependencyModal({ dep, feature, onDismiss, onRecheck }: Props) {
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const platform = getPlatform();
  const command = dep.install[platform];

  const allConsumers = [...dep.internalConsumers, ...dep.pluginConsumers];
  const matchingConsumer = allConsumers.find((c) => c.name === feature);
  const reason = matchingConsumer?.reason;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("Failed to copy:", e);
    }
  };

  const handleRecheck = async () => {
    setChecking(true);
    await onRecheck();
    setChecking(false);
  };

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
        <h3 className="ds-modal-title">{dep.name} is required</h3>

        <p style={{ margin: "0 0 16px", color: "var(--text-secondary)", fontSize: "var(--fs-sm)" }}>
          <strong>{feature}</strong> requires <strong>{dep.name}</strong>{reason ? ` to ${reason.toLowerCase()}` : ""}.
          Install it to enable this feature.
        </p>

        <div style={{ margin: "0 0 16px" }}>
          <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-tertiary)", marginBottom: 6 }}>
            Install via terminal ({getPlatformLabel(platform)}):
          </div>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "var(--bg-tertiary)",
            borderRadius: "var(--ds-radius)",
            padding: "8px 12px",
          }}>
            <code style={{ flex: 1, fontSize: "var(--fs-sm)", userSelect: "all" }}>{command}</code>
            <button
              className="ds-btn ds-btn--ghost ds-btn--sm"
              onClick={handleCopy}
              style={{ flexShrink: 0 }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onDismiss}>Dismiss</button>
          <button
            className="ds-btn ds-btn--ghost"
            onClick={() => openUrl(dep.install.url).catch(console.error)}
          >
            Download Page
          </button>
          <button
            className="ds-btn ds-btn--primary"
            onClick={handleRecheck}
            disabled={checking}
          >
            {checking ? "Checking..." : "Check Again"}
          </button>
        </div>
      </div>
    </div>
  );
}
