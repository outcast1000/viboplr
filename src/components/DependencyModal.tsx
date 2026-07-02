import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type DependencyInfo, type InstallProgress } from "../hooks/useDependencies";

interface Props {
  dep: DependencyInfo;
  feature: string;
  installProgress?: InstallProgress;
  onInstall?: (name: string) => Promise<string | null>;
  onDismiss: () => void;
  onRecheck: () => void;
}

export function getPlatform(): "macos" | "windows" | "linux" {
  const p = navigator.platform.toLowerCase();
  if (p.includes("mac")) return "macos";
  if (p.includes("win")) return "windows";
  return "linux";
}

export function getPlatformLabel(platform: "macos" | "windows" | "linux"): string {
  if (platform === "macos") return "macOS";
  if (platform === "windows") return "Windows";
  return "Linux";
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function DependencyModal({ dep, feature, installProgress, onInstall, onDismiss, onRecheck }: Props) {
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const platform = getPlatform();
  const command = dep.install[platform];
  const canSelfInstall = dep.managedAvailable && !!onInstall;

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

  const handleInstall = async () => {
    if (!onInstall) return;
    setInstalling(true);
    setInstallError(null);
    try {
      await onInstall(dep.name);
      onDismiss();
    } catch (e) {
      console.error("Failed to install dependency:", e);
      setInstallError(String(e));
    } finally {
      setInstalling(false);
    }
  };

  const progressPct =
    installProgress && installProgress.total
      ? Math.round((installProgress.downloaded / installProgress.total) * 100)
      : null;

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
        <h3 className="ds-modal-title">{dep.name} is required</h3>

        <p style={{ margin: "0 0 16px", color: "var(--text-secondary)", fontSize: "var(--fs-sm)" }}>
          <strong>{feature}</strong> requires <strong>{dep.name}</strong>{reason ? ` to ${reason.toLowerCase()}` : ""}.
          Install it to enable this feature.
        </p>

        {installing && (
          <div style={{ margin: "0 0 16px" }}>
            <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-tertiary)", marginBottom: 6 }}>
              Downloading {dep.name}...
              {installProgress
                ? ` ${formatBytes(installProgress.downloaded)}${installProgress.total ? ` / ${formatBytes(installProgress.total)}` : ""}`
                : ""}
            </div>
            <div style={{ height: 6, background: "var(--bg-tertiary)", borderRadius: 3, overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: progressPct !== null ? `${progressPct}%` : "100%",
                  background: "var(--accent)",
                  transition: "width 0.2s",
                  opacity: progressPct !== null ? 1 : 0.4,
                }}
              />
            </div>
          </div>
        )}

        {installError && (
          <p style={{ margin: "0 0 16px", color: "var(--error)", fontSize: "var(--fs-xs)" }}>
            Install failed: {installError}
          </p>
        )}

        {!installing && (
          <div style={{ margin: "0 0 16px" }}>
            <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-tertiary)", marginBottom: 6 }}>
              {canSelfInstall ? "Or install manually via terminal" : "Install via terminal"} ({getPlatformLabel(platform)}):
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
        )}

        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onDismiss} disabled={installing}>Dismiss</button>
          {canSelfInstall ? (
            <>
              <button
                className="ds-btn ds-btn--ghost"
                onClick={handleRecheck}
                disabled={checking || installing}
              >
                {checking ? "Checking..." : "Check Again"}
              </button>
              <button
                className="ds-btn ds-btn--primary"
                onClick={handleInstall}
                disabled={installing}
              >
                {installing ? "Installing..." : "Install for me"}
              </button>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
